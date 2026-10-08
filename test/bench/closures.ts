const t0 = Date.now()
const data: number[] = []
for (let i = 0; i < 1000000; i++) data.push(i % 1000)
let total = 0
for (let r = 0; r < 40; r++) {
  const mapped = data.map((v) => v * 2 + r)
  const filtered = mapped.filter((v) => v % 3 !== 0)
  total += filtered.reduce((acc, v) => acc + v, 0)
}
console.log('closures ' + (Date.now() - t0) + ' ' + total)
