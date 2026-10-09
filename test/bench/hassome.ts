// A set kept as an array and queried through a closure: `contains(x)` is `hasSome(e => e === x)`. The shape of the
// collections the Are We Fast Yet benchmarks are written in.
class Item {
  id: number
  constructor(id: number) {
    this.id = id
  }
}
class Bag {
  items: Item[] = []
  count = 0
  hasSome(fn: (e: Item) => boolean): boolean {
    for (let i = 0; i < this.count; i++) if (fn(this.items[i]!)) return true
    return false
  }
  contains(obj: Item): boolean {
    return this.hasSome((e: Item): boolean => e === obj)
  }
  add(obj: Item): void {
    if (!this.contains(obj)) {
      this.items.push(obj)
      this.count += 1
    }
  }
}
const pool: Item[] = []
for (let i = 0; i < 64; i++) pool.push(new Item(i))
const t0 = Date.now()
let hits = 0
for (let round = 0; round < 200000; round++) {
  const bag = new Bag()
  for (let i = 0; i < 24; i++) bag.add(pool[(i * 7 + round) % 64]!)
  for (let i = 0; i < 24; i++) if (bag.contains(pool[(i * 5) % 64]!)) hits++
}
console.log('hassome ' + (Date.now() - t0) + ' ' + hits)
