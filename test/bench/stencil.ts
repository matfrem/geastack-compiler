function run(size: number, steps: number): number {
  let a = new Float32Array(size * size)
  let b = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) a[i] = (i * 7919) % 1000 / 1000
  for (let s = 0; s < steps; s++) {
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const k = y * size + x
        b[k] = (a[k]! * 4 + a[k - 1]! + a[k + 1]! + a[k - size]! + a[k + size]!) * 0.125
      }
    }
    const t = a
    a = b
    b = t
  }
  let sum = 0
  for (let i = 0; i < size * size; i++) sum += a[i]!
  return sum
}
const t0 = Date.now()
const result = run(512, 500)
console.log('stencil ' + (Date.now() - t0) + ' ' + result.toFixed(3))
