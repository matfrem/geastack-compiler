function mandel(size: number, maxIter: number): number {
  let inside = 0
  for (let py = 0; py < size; py++) {
    const ci = (py / size) * 2 - 1
    for (let px = 0; px < size; px++) {
      const cr = (px / size) * 3 - 2
      let zr = 0, zi = 0, i = 0
      while (i < maxIter && zr * zr + zi * zi <= 4) {
        const t = zr * zr - zi * zi + cr
        zi = 2 * zr * zi + ci
        zr = t
        i++
      }
      if (i === maxIter) inside++
    }
  }
  return inside
}
const t0 = Date.now()
const result = mandel(2000, 200)
console.log('mandelbrot ' + (Date.now() - t0) + ' ' + result)
