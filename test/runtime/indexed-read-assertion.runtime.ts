//! expect: 3 7 TypeError TypeError TypeError 7 TypeError
//! emitted-has: ->elementAtIndexPresentForProperty(
//! emitted-has: ->elementAtPresentForProperty(
//! emitted-has: ->elementAtIndexPresent(
//! expect: 10 8 TypeError
// `array[i]!` over a read that may be `undefined` (`noUncheckedIndexedAccess`): the element is tested once and read by
// reference instead of through the `Optional` the read would build and `presentOrThrow` unwrap. The TypeError for an
// absent value has to survive: a hole, an index past the end and a stored `undefined` all raise at the property read
// that follows, as they do in Node.
interface Point {
  v: number
}
const xs: Point[] = [{ v: 3 }, { v: 7 }]
const holes: Point[] = []
holes[2] = { v: 1 }
const maybe: (Point | undefined)[] = [{ v: 1 }, undefined]
function attempt(read: () => number): string {
  try {
    return String(read())
  } catch (error) {
    return error instanceof TypeError ? 'TypeError' : 'other'
  }
}
function atKey(array: Point[], key: number): number {
  return array[key]!.v
}
let total = 0
for (let i = 0; i < xs.length; i++) total += xs[i]!.v
function pickIndexed(array: Point[], index: number): Point {
  const found = array[index]!
  return found
}
function pickCounted(array: Point[]): number {
  let sum = 0
  for (let i = 0; i < array.length; i++) {
    const found = array[i]!
    sum += found.v - 1
  }
  return sum
}
console.log(
  attempt(() => xs[0]!.v),
  attempt(() => xs[1]!.v),
  attempt(() => xs[5]!.v),
  attempt(() => holes[0]!.v),
  attempt(() => maybe[1]!.v),
  attempt(() => atKey(xs, 1)),
  attempt(() => atKey(xs, 9))
)
console.log(
  total,
  pickCounted(xs),
  attempt(() => pickIndexed(xs, 7).v)
)
