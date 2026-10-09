//! expect: r1 5 true 6 true false
// `new Array<A | null>(n).fill(null)`: the value `fill` writes takes the element's carrier, as an assignment would.
class Node1 {
  v: number
  constructor(v: number) {
    this.v = v
  }
}
const slots: (Node1 | null)[] = new Array<Node1 | null>(6).fill(null)
slots[2] = new Node1(5)
const x = slots[2]
const seeded: (Node1 | null)[] = [new Node1(1), new Node1(2), new Node1(3)]
const filled = seeded.fill(null, 1)
console.log('r1 ' + (x === null ? -1 : x.v) + ' ' + (slots[0] === null) + ' ' + slots.length + ' ' + (filled[2] === null) + ' ' + (filled[0] === null))
