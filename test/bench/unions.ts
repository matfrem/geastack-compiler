// An array of `number | string` visited through `typeof`: the cost of a union that is not a class hierarchy.
function fill(count: number): (number | string)[] {
  const items: (number | string)[] = []
  for (let i = 0; i < count; i++) items.push(i % 3 === 0 ? 'v' + (i % 100) : (i * 7) % 1000)
  return items
}
function visit(items: (number | string)[]): number {
  let sum = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (typeof item === 'number') sum += item * 2
    else sum += item.length
  }
  return sum
}
const items = fill(1000000)
const t0 = Date.now()
let total = 0
for (let round = 0; round < 200; round++) total += visit(items)
console.log('unions ' + (Date.now() - t0) + ' ' + total)
