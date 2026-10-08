function sieve(n: number): number {
  const flags = new Uint8Array(n + 1)
  let count = 0
  for (let i = 2; i <= n; i++) {
    if (flags[i] === 0) {
      count++
      for (let j = i * 2; j <= n; j += i) flags[j] = 1
    }
  }
  return count
}
const t0 = Date.now()
let total = 0
for (let r = 0; r < 25; r++) total += sieve(10000000)
console.log('sieve ' + (Date.now() - t0) + ' ' + total)
