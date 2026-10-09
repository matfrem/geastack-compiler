//! expect: 2 20 | 1:10,2:20 | 3
//! expect: for-of 50 2 2
// A Map spread into an array of `number[]` pairs: each entry is a fresh two-element Array, as the language builds it.
const crops = new Map<number, number>()
crops.set(1, 10)
crops.set(2, 20)
const pairs: number[][] = [...crops]
pairs[0]![1] = 99
const view = [...crops].map(([color, count]) => color + ':' + count)
const sizes = [...crops].map((pair) => pair.length)
console.log(pairs.length + ' ' + pairs[1]![1] + ' | ' + view.join(',') + ' | ' + (sizes[0]! + 1))
let weighted = 0
for (const [color, count] of crops) weighted += color * count
const copied: number[][] = []
for (const [color, count] of crops) copied.push([color, count])
console.log('for-of ' + weighted + ' ' + copied.length + ' ' + copied[1]![0])
