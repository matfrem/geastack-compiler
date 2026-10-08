//! expect: 9.070 NaN 9.070 0.000
//! emitted-has: gea::denseIndexWindow(
// `const k = y * size + x` read in the inner loop: the index lives in a cell the loop writes once, so the window is
// proved from the expression behind it (`y * size` plus the counter, minus or plus a constant or `size`). A grid
// shorter than `size * size` must fail the preheader check and take the ordinary path, which reads `undefined` past
// the end exactly as Node does.
function smooth(source: Float32Array, size: number): number {
  const target = new Float32Array(size * size)
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const k = y * size + x
      target[k] = (source[k]! * 4 + source[k - 1]! + source[k + 1]! + source[k - size]! + source[k + size]!) * 0.125
    }
  }
  let sum = 0
  for (let i = 0; i < target.length; i++) sum += target[i]!
  return sum
}
function filled(length: number): Float32Array {
  const grid = new Float32Array(length)
  for (let i = 0; i < length; i++) grid[i] = ((i * 7919) % 1000) / 1000
  return grid
}
console.log(
  smooth(filled(36), 6).toFixed(3),
  String(smooth(filled(30), 6)),
  smooth(filled(40), 6).toFixed(3),
  smooth(filled(4), 2).toFixed(3)
)
