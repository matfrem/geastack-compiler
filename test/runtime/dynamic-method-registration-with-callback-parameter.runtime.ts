//! expect: 12
//! short-names
// A class method taking a callback, read dynamically through `any`: its registration text nests a captureless lambda in the box call,
// which MSVC (C1001) cannot compile unless the lambda is cast to the entry's function-pointer type.
type Ev = { kind: 'a'; n: number } | { kind: 'b'; s: string }
class EventQueue {
  items: Ev[] = []
  push(e: Ev): void { this.items.push(e) }
  drain(handler: (e: Ev) => void): void {
    for (const e of this.items) handler(e)
    this.items = []
  }
}
const q = new EventQueue()
q.push({ kind: 'a', n: 1 })
q.push({ kind: 'b', s: 'x' })
let total = 0
q.drain((e) => { total += e.kind === 'a' ? e.n : e.s.length })
q.push({ kind: 'a', n: 5 })
const anyQ: any = q
anyQ.drain((e: Ev) => { total += 10 })
console.log(total)
