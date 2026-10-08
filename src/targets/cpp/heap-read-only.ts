import type { DeclarationId, FunctionId, IrValueId } from '../../identity/ids.js'
import { stringConstantsOf } from '../../ir/dead-values.js'
import type { GetOperation, IrBody } from '../../ir/model.js'
import { effectOf } from '../../ir/shake.js'

/** Whether a member read renders as a plain load (`emit-properties.ts`'s `isPlainMemberRead`): no accessor, no host, no call into the program. */
export type PlainMemberRead = (operation: GetOperation, key: string | null) => boolean

/**
 * Which bodies, and everything they can call, only READ the heap.
 *
 * A reference formal (`const T&`) may be bound to a field or an element, instead of to a copy of it, exactly when
 * nothing can write that field while the callee runs: the callee holds a reference into live storage, and a write to
 * the slot -- or to the owner that keeps its referent alive -- would leave it reading something else, or something
 * freed. `stableBorrowActualsOf` therefore admits only caller-owned slots (parameters, constants, private cells,
 * `this`), and a property read, the one actual a callee could write through, never.
 *
 * A callee that provably writes nothing removes that hazard. Such a body is a pure value computation over the heap:
 * every operation is effect-free in `effectOf`'s sense, or a plain member read, or a write to a cell only this body
 * can reach, or a direct call to another body of the same kind. The set is a greatest fixed point, so a recursive
 * walk of a tree (`check(tree.left) + check(tree.right)`) is read-only when its own body is. Anything the proof does
 * not name -- a store, a host call, a dynamic or virtual call, a construction, a coroutine -- keeps the body out.
 */
export interface HeapReadOnlyOracle {
  /** Whether `owner` is read-only under the program's plain-read judgement. */
  readonly isReadOnly: (owner: FunctionId, plainRead: PlainMemberRead) => boolean
  /**
   * The values of `body` that are a plain member read, or a conversion of one: references into live storage that a
   * read-only callee may be handed instead of a copy.
   */
  readonly readActuals: (body: IrBody, plainRead: PlainMemberRead) => ReadonlySet<IrValueId>
}

export const noHeapReadOnly: HeapReadOnlyOracle = {
  isReadOnly: () => false,
  readActuals: () => new Set()
}

export const createHeapReadOnlyOracle = (
  bodies: readonly IrBody[],
  isCoroutine: (body: IrBody) => boolean,
  isEligibleOwner: (body: IrBody) => boolean,
  localCell: (body: IrBody, declaration: DeclarationId) => boolean
): HeapReadOnlyOracle => {
  const byOwner = new Map<FunctionId, IrBody[]>()
  for (const body of bodies) {
    if (!isEligibleOwner(body)) continue
    const owner = body.sourceOwner as FunctionId
    const group = byOwner.get(owner)
    if (group) group.push(body)
    else byOwner.set(owner, [body])
  }
  let solved: ReadonlySet<FunctionId> | null = null

  /** Whether one body is read-only except for the direct calls it makes, which are collected into `callees`. */
  const bodyReadsOnly = (body: IrBody, plainRead: PlainMemberRead, callees: Set<FunctionId>): boolean => {
    if (isCoroutine(body)) return false
    const strings = stringConstantsOf(body)
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'get') {
          if (!plainRead(operation, strings.get(operation.key.value) ?? null)) return false
        } else if (operation.kind === 'call') {
          if (operation.target?.kind !== 'direct') return false
          callees.add(operation.target.functionId)
        } else if (operation.kind === 'binding-write') {
          if (!localCell(body, operation.declaration)) return false
        } else if (effectOf(operation) !== 'pure') return false
      }
    }
    return true
  }

  const solve = (plainRead: PlainMemberRead): ReadonlySet<FunctionId> => {
    if (solved !== null) return solved
    const candidates = new Set<FunctionId>()
    const dependencies = new Map<FunctionId, ReadonlySet<FunctionId>>()
    for (const [owner, group] of byOwner) {
      const callees = new Set<FunctionId>()
      if (group.every((body) => bodyReadsOnly(body, plainRead, callees))) {
        candidates.add(owner)
        dependencies.set(owner, callees)
      }
    }
    for (let changed = true; changed;) {
      changed = false
      for (const owner of [...candidates]) {
        for (const callee of dependencies.get(owner) ?? []) {
          if (!candidates.has(callee)) {
            candidates.delete(owner)
            changed = true
            break
          }
        }
      }
    }
    solved = candidates
    return candidates
  }

  const readActualsOf = (body: IrBody, plainRead: PlainMemberRead): ReadonlySet<IrValueId> => {
    const strings = stringConstantsOf(body)
    const reads = new Set<IrValueId>()
    for (let changed = true; changed;) {
      changed = false
      for (const block of body.blocks.values()) {
        for (const operation of block.operations) {
          if (
            operation.kind === 'get' &&
            !reads.has(operation.result.id) &&
            plainRead(operation, strings.get(operation.key.value) ?? null)
          ) {
            reads.add(operation.result.id)
            changed = true
          } else if (operation.kind === 'convert' && !reads.has(operation.result.id) && reads.has(operation.source.value)) {
            reads.add(operation.result.id)
            changed = true
          }
        }
      }
    }
    return reads
  }

  return {
    isReadOnly: (owner, plainRead) => solve(plainRead).has(owner),
    readActuals: readActualsOf
  }
}
