import type { DeclarationId, FunctionId, IrValueId } from '../../identity/ids.js'
import { stringConstantsOf } from '../../ir/dead-values.js'
import { controlFlowGraphOf, dominatorTreeOf } from '../../ir/dominance.js'
import type { GetOperation, IrBlockId, IrBody, IrNonTerminatorOperation } from '../../ir/model.js'
import { operandsOfIrOperation, resultOfIrOperation } from '../../ir/queries.js'
import { effectOf } from '../../ir/shake.js'
import { representationKey, type Representation } from '../../representation/model.js'
import type { PlainMemberRead } from './heap-read-only.js'

/**
 * Local cells that hold a REFERENCE to an array element instead of a copy of it.
 *
 * `const item = items[i]!` over a union or a string copies the element into the cell: a variant copy, and a heap
 * allocation for a long string, per turn of a loop that only reads `item`. The element is already in storage the
 * array holds, and the cell is written once, so the cell may point at it -- the same argument that lets a read-only
 * callee be handed a field by reference (`heap-read-only.ts`), with the cell's live range standing in for the call.
 *
 * What makes the pointer safe is that nothing between the write and the last read can change or free the array:
 *
 * - the element is read through a receiver the body keeps alive for the whole stretch (a parameter, `this`, a cell
 *   read, or a plain field of one), never a temporary that dies with its expression;
 * - the cell is written exactly once, by that read, and is local, unboxed and uncaptured;
 * - the live range -- every block from which a read of the cell is still ahead, stopping at the write -- holds only
 *   effect-free operations, plain member reads, writes to scalar cells, and direct calls to bodies that only read
 *   the heap. A store, a dynamic call or a write that could drop the array's last owner keeps the copy.
 */
export interface BorrowedBindingContext {
  readonly body: IrBody
  /** Values whose text the emitter withholds into their use (`deferrable`): the element read must be one, so the write names the element itself. */
  readonly deferrable: ReadonlySet<IrValueId>
  /** Whether the cell is a plain local of this body: placed here, unboxed, uncaptured, not a formal, forwarded or narrowed. */
  readonly eligibleCell: (declaration: DeclarationId) => boolean
  /** The carrier the cell holds: the write stores the element unconverted only when it is the element's own. */
  readonly heldCarrier: (declaration: DeclarationId) => Representation | null
  readonly plainRead: PlainMemberRead
  readonly readOnlyCallee: (owner: FunctionId) => boolean
}

/** The carriers a copy of costs real work: a variant, or a string. A scalar copies for free. */
const copyCostsWork = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'string':
    case 'tagged-union':
      return true
    default:
      return false
  }
}

export const borrowedBindingsOf = (context: BorrowedBindingContext): ReadonlySet<DeclarationId> => {
  const { body } = context
  const borrowed = new Set<DeclarationId>()
  // A try region renders as one assembled chunk and adds exception edges the live-range walk below does not follow.
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return borrowed
  const producers = new Map<
    IrValueId,
    { readonly operation: IrNonTerminatorOperation; readonly block: IrBlockId; readonly index: number }
  >()
  const writes = new Map<DeclarationId, { readonly block: IrBlockId; readonly index: number; readonly value: IrValueId }[]>()
  const reads = new Map<DeclarationId, { readonly block: IrBlockId; readonly index: number }[]>()
  const uses = new Map<IrValueId, number>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    block.operations.forEach((operation, index) => {
      const result = resultOfIrOperation(operation)
      if (result) producers.set(result.id, { operation, block: blockId, index })
      if (operation.kind === 'binding-write') {
        const list = writes.get(operation.declaration) ?? []
        list.push({ block: blockId, index, value: operation.value.value })
        writes.set(operation.declaration, list)
      }
      if (operation.kind === 'binding-read') {
        const list = reads.get(operation.declaration) ?? []
        list.push({ block: blockId, index })
        reads.set(operation.declaration, list)
      }
      if (operation.kind === 'phi') for (const edge of operation.incoming) uses.set(edge.value.value, (uses.get(edge.value.value) ?? 0) + 2)
      else for (const operand of operandsOfIrOperation(operation)) uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
    })
  }
  if (writes.size === 0) return borrowed
  const graph = controlFlowGraphOf(body)
  const dominance = dominatorTreeOf(body)
  const strings = stringConstantsOf(body)

  /** Whether one operation, standing between the write and a read of the cell, leaves the array alone. */
  const leavesArrayAlone = (operation: IrNonTerminatorOperation): boolean => {
    if (operation.kind === 'get') return context.plainRead(operation, strings.get(operation.key.value) ?? null)
    if (operation.kind === 'call') return operation.target?.kind === 'direct' && context.readOnlyCallee(operation.target.functionId)
    // A write to a cell can drop the last owner of an array or string the borrowed pointer reaches into; only a
    // scalar cell holds nothing that can be dropped.
    if (operation.kind === 'binding-write') return operation.value.representation.kind === 'scalar'
    return effectOf(operation) === 'pure'
  }

  for (const [declaration, written] of writes) {
    const only = written.length === 1 ? written[0] : undefined
    if (!only || !context.eligibleCell(declaration)) continue
    const produced = producers.get(only.value)
    const element = produced?.operation
    if (!produced || element?.kind !== 'get' || produced.block !== only.block || produced.index >= only.index) continue
    if (!isArrayElementRead(element, strings.get(element.key.value) ?? null)) continue
    if (!context.deferrable.has(only.value) || (uses.get(only.value) ?? 0) !== 1) continue
    if (!copyCostsWork(element.result.representation)) continue
    // The read must hand back the stored element itself (`const Element&`). An absence-capable read -- the array's
    // element carrier wrapped in an `Optional` -- builds a new value, and there is nothing in storage to point at.
    const receiver = element.receiver.representation
    if (receiver.kind !== 'array-object' || representationKey(receiver.element) !== representationKey(element.result.representation))
      continue
    const held = context.heldCarrier(declaration)
    if (held === null || representationKey(held) !== representationKey(element.result.representation)) continue
    if (!receiverOutlivesTheRead(element, producers, context.plainRead, strings)) continue
    const block = body.blocks.get(only.block)
    if (!block) continue
    // Only effect-free operations sit between the element read and the write that stores it.
    let clear = true
    for (let between = produced.index + 1; between < only.index; between += 1) {
      const crossed = block.operations[between]
      if (!crossed || crossed.kind === 'call' || crossed.kind === 'get' || effectOf(crossed) !== 'pure') clear = false
    }
    if (!clear) continue
    const sites = reads.get(declaration) ?? []
    if (sites.length === 0) continue
    if (sites.some((site) => (site.block === only.block ? site.index <= only.index : !dominance.dominates(only.block, site.block))))
      continue
    // The live range: every block that still has a read ahead of it, stopping at the write's own block.
    const live = new Set<IrBlockId>()
    const pending = sites.map((site) => site.block).filter((id) => id !== only.block)
    while (pending.length > 0) {
      const id = pending.pop()
      if (id === undefined || live.has(id)) continue
      live.add(id)
      for (const before of graph.predecessors.get(id) ?? []) if (before !== only.block) pending.push(before)
    }
    let safe = true
    const lastReadInWriteBlock = sites
      .filter((site) => site.block === only.block)
      .reduce((latest, site) => Math.max(latest, site.index), -1)
    // From the write on: up to the last read here, or to the end of the block when the cell is still live past it.
    const liveOut = (graph.successors.get(only.block) ?? []).some((next) => live.has(next))
    const stop = liveOut ? block.operations.length : lastReadInWriteBlock
    for (let at = only.index + 1; at < stop && safe; at += 1) {
      const crossed = block.operations[at]
      if (crossed && !leavesArrayAlone(crossed)) safe = false
    }
    for (const id of live) {
      if (!safe) break
      for (const crossed of body.blocks.get(id)?.operations ?? []) {
        if (!leavesArrayAlone(crossed)) {
          safe = false
          break
        }
      }
    }
    if (safe) borrowed.add(declaration)
  }
  return borrowed
}

/** An index read of an array, and not `length` or a named property. */
const isArrayElementRead = (operation: GetOperation, key: string | null): boolean =>
  operation.receiver.representation.kind === 'array-object' &&
  key === null &&
  operation.key.representation.kind === 'scalar' &&
  operation.key.representation.domain === 'number'

/** Whether the array a read indexes stays alive for as long as the body runs on: not a temporary of the read's own expression. */
const receiverOutlivesTheRead = (
  operation: GetOperation,
  producers: ReadonlyMap<IrValueId, { readonly operation: IrNonTerminatorOperation }>,
  plainRead: PlainMemberRead,
  strings: ReadonlyMap<IrValueId, string>
): boolean => {
  const producer = producers.get(operation.receiver.value)?.operation
  if (!producer) return false
  if (producer.kind === 'binding-read' || producer.kind === 'parameter' || producer.kind === 'receiver') return true
  return producer.kind === 'get' && plainRead(producer, strings.get(producer.key.value) ?? null)
}
