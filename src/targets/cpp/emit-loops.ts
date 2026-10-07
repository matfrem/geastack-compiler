import type { IrBlockId } from '../../ir/model.js'
import type { ScopePlan } from './emit-scopes.js'

/**
 * Loops as the language spells them, for a body written as nested scopes.
 *
 * `emit-scopes.ts` writes every block as a scope of its dominator and every edge as a `goto`, so a loop is a
 * labelled scope that jumps back to its own label. This finds the natural loops of the graph the body renders
 * and writes each as `for (;;) { ... }`: a jump back to the header becomes `continue`, the jump to the loop's
 * first exit becomes `break`, and the code after the loop leaves the scope the header opened.
 *
 * That last part is the one that changes what a local may be named in: an exit block is dominated by the header,
 * so it was written inside the header's scope and could name the header's own locals. After the loop it cannot,
 * so the exits are re-parented to the header's parent before declarations are placed, and a local named on both
 * sides of the loop is declared before it, once, rather than once per turn.
 */

export interface LoopShape {
  readonly header: IrBlockId
  /** The blocks of the natural loop: the header and every block that can reach a jump back to it without passing it. */
  readonly members: ReadonlySet<IrBlockId>
  /** The first block written after the loop, which `break` falls into, or `null` for a loop with no exit. */
  readonly exit: IrBlockId | null
}

export interface StructuredPlan {
  readonly plan: ScopePlan
  readonly loops: ReadonlyMap<IrBlockId, LoopShape>
}

const dominates = (plan: ScopePlan, dominator: IrBlockId, block: IrBlockId): boolean => {
  for (let at: IrBlockId | undefined = block; at !== undefined; at = plan.parent.get(at)) if (at === dominator) return true
  return false
}

/**
 * The loops of a plan that can be written as `for`, and the plan with each loop's exits moved out of its scope.
 * A loop is left as a labelled scope when its exits are not written after its body in the plan's own order
 * (the layout elides a jump to the block written next, and moving a block would change which one that is).
 */
export const structuredLoopsOf = (
  plan: ScopePlan,
  successors: ReadonlyMap<IrBlockId, readonly IrBlockId[]>,
  /** Whether the caller can spell this loop: its header and exit have labels to jump to. */
  usable: (header: IrBlockId, exit: IrBlockId | null) => boolean = () => true
): StructuredPlan => {
  const predecessors = new Map<IrBlockId, IrBlockId[]>(plan.order.map((id) => [id, []]))
  for (const id of plan.order) for (const next of successors.get(id) ?? []) predecessors.get(next)?.push(id)
  const backSources = new Map<IrBlockId, IrBlockId[]>()
  for (const id of plan.order)
    for (const next of successors.get(id) ?? []) {
      if (!dominates(plan, next, id)) continue
      const list = backSources.get(next)
      if (list) list.push(id)
      else backSources.set(next, [id])
    }
  const parent = new Map(plan.parent)
  const children = new Map<IrBlockId, IrBlockId[]>([...plan.children].map(([id, list]) => [id, [...list]]))
  const loops = new Map<IrBlockId, LoopShape>()
  // Inner loops first: an exit moved out of an inner header lands in a scope the outer loop's own pass then sees.
  const headers = [...backSources.keys()]
    .filter((id) => id !== plan.entry)
    .sort((a, b) => (plan.depth.get(b) ?? 0) - (plan.depth.get(a) ?? 0))
  for (const header of headers) {
    const members = new Set<IrBlockId>([header])
    const pending = [...(backSources.get(header) ?? [])]
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined || members.has(next)) continue
      members.add(next)
      for (const before of predecessors.get(next) ?? []) if (!members.has(before)) pending.push(before)
    }
    if (![...members].every((member) => dominates(plan, header, member))) continue
    const own = children.get(header) ?? []
    const inside = own.filter((child) => members.has(child))
    const outside = own.filter((child) => !members.has(child))
    // The in-loop children stay first, in their order, and the exits follow: no fallthrough between the two changes.
    if (own.slice(0, inside.length).some((child) => !members.has(child))) continue
    const above = parent.get(header)
    if (above === undefined || !usable(header, outside[0] ?? null)) continue
    children.set(header, inside)
    const siblings = children.get(above) ?? []
    const at = siblings.indexOf(header)
    siblings.splice(at + 1, 0, ...outside)
    children.set(above, siblings)
    for (const exit of outside) parent.set(exit, above)
    loops.set(header, { header, members, exit: outside[0] ?? null })
  }
  if (loops.size === 0) return { plan, loops }
  // Rebuild the preorder and the depths the way `scopePlanOf` does.
  const order: IrBlockId[] = []
  const depth = new Map<IrBlockId, number>()
  const pending: { readonly id: IrBlockId; readonly depth: number }[] = [{ id: plan.entry, depth: 0 }]
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined) break
    order.push(next.id)
    depth.set(next.id, next.depth)
    const own = children.get(next.id) ?? []
    for (let index = own.length - 1; index >= 0; index -= 1) {
      const child = own[index]
      if (child !== undefined) pending.push({ id: child, depth: next.depth + 1 })
    }
  }
  if (order.length !== plan.order.length) return { plan, loops: new Map() }
  return { plan: { entry: plan.entry, order, parent, children, depth }, loops }
}

/** The smallest loop that contains a block, or null. */
export const innermostLoopOf = (loops: ReadonlyMap<IrBlockId, LoopShape>, block: IrBlockId): LoopShape | null => {
  let found: LoopShape | null = null
  for (const loop of loops.values()) {
    if (!loop.members.has(block)) continue
    if (found === null || loop.members.size < found.members.size) found = loop
  }
  return found
}

const startsLoopOrSwitch = (line: string): boolean =>
  line.includes('for (') ||
  line.includes('while (') ||
  line.includes('switch (') ||
  line.trimStart().startsWith('do ') ||
  line.trimStart().startsWith('do{') ||
  line.includes('[&]') ||
  line.includes('[=]') ||
  line.includes('[this]') ||
  line.includes('[&,')

/**
 * A block's text with `goto <header>;` written `continue;` and `goto <exit>;` written `break;`, for the jumps that
 * sit directly in the loop's body. A jump inside a C++ loop, switch or lambda that the text itself spells would
 * bind to that construct instead, so it stays a `goto`.
 */
export const structuredJumpsIn = (text: string, header: string, exit: string | null): string => {
  if (!text.includes('goto ')) return text
  let depth = 0
  // One entry per open brace: whether `break` or `continue` there would bind to something other than the loop.
  const breakable: boolean[] = []
  return text
    .split('\n')
    .map((line) => {
      let opens = 0
      let closes = 0
      let leading = 0
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index]
        if (character === '"' || character === "'") {
          index += 1
          while (index < line.length && line[index] !== character) index += line[index] === '\\' ? 2 : 1
        } else if (character === '/' && line[index + 1] === '/') break
        else if (character === '{') opens += 1
        else if (character === '}') {
          closes += 1
          if (opens === 0 && line.slice(0, index).trim() === '') leading += 1
        }
      }
      for (let pop = 0; pop < leading; pop += 1) breakable.pop()
      const inside = breakable.some(Boolean) || startsLoopOrSwitch(line)
      const rewritten = inside ? line : rewriteJumps(line, header, exit)
      const flag = startsLoopOrSwitch(line)
      for (let push = 0; push < opens; push += 1) breakable.push(flag)
      for (let pop = leading; pop < closes; pop += 1) breakable.pop()
      depth += opens - closes
      return rewritten
    })
    .join('\n')
}

const rewriteJumps = (line: string, header: string, exit: string | null): string => {
  let result = ''
  let copied = 0
  for (let at = line.indexOf('goto '); at >= 0; at = line.indexOf('goto ', at + 5)) {
    const before = at === 0 ? ' ' : (line[at - 1] as string)
    if ('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.includes(before)) continue
    let end = at + 5
    while (end < line.length && 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.includes(line[end] as string)) end += 1
    const target = line.slice(at + 5, end)
    if (line[end] !== ';') continue
    const replacement = target === header ? 'continue' : exit !== null && target === exit ? 'break' : null
    if (replacement === null) continue
    result += line.slice(copied, at) + replacement
    copied = end
  }
  return copied === 0 ? line : result + line.slice(copied)
}
