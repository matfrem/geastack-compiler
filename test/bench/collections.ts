function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s
  }
}
const next = lcg(12345)
const t0 = Date.now()
const counts = new Map<string, number>()
for (let i = 0; i < 6000000; i++) {
  const key = 'k' + (next() % 50000)
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
let maxCount = 0
for (const [, v] of counts) if (v > maxCount) maxCount = v
const values: number[] = []
for (let i = 0; i < 1200000; i++) values.push(next() % 1000000)
values.sort((a, b) => a - b)
const seen = new Set<number>()
for (const v of values) seen.add(v)
let text = ''
for (let i = 0; i < 20000; i++) text += String.fromCharCode(97 + (i % 26))
console.log('collections ' + (Date.now() - t0) + ' ' + counts.size + ' ' + maxCount + ' ' + values[1000]! + ' ' + seen.size + ' ' + text.length)
