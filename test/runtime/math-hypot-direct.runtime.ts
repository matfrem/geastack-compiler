//! expect: 5|1.414213562373095e+200|Infinity|NaN|0|0|5|1.414213562373095e-200
//! emitted-has: hypotDirect
// A direct `Math.hypot(a, b, ...)` call takes its operands as a borrowed stack sequence, the way `Math.max` does,
// instead of building an array and a callable value around it; the answers are the specification's, including the
// scaling that keeps 1e200 finite and the rule that an infinity wins over a NaN.
const big = 1e200
const tiny = 1e-200
const results = [
  Math.hypot(3, 4),
  Math.hypot(big, big),
  Math.hypot(NaN, Infinity),
  Math.hypot(NaN, 1),
  Math.hypot(),
  Math.hypot(0, -0),
  Math.hypot(-3, 0, 4),
  Math.hypot(tiny, tiny)
]
console.log(results.join('|'))
