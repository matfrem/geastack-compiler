//! expect: [0,1,2,3]
//! short-names
// Under `--short-names` the loops are `for (;;)`. A `break` after `splice` in a `for` that also holds a `continue` and a closure over loop constants (`ia`, `ib`).
function ears(idx: number[]): number[] {
  const out: number[] = []
  while (idx.length > 3) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length]!
      const ib = idx[i]!
      if (idx.some((k) => k !== ia && k !== ib && k < 0)) continue
      out.push(ib)
      idx.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) break
  }
  return out
}
console.log('[' + ears([0, 1, 2, 3, 4, 5, 6]).join(',') + ']')
