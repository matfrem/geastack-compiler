//! expect: nearest generic 2
//! expect: nearest plain 2
//! expect: per-iteration 7u7u
//! expect: do-while e0-e2-e4
//! expect: carried 9 undefined
//! expect: nested 5_4/5
//! expect: var u332
// `let best: T | undefined;` has no initializer, so nothing wrote the cell where the statement is. A cell is
// placed at the deepest scope that holds every operation naming it, and for a cell written only inside a loop
// and read after it that scope was the loop's own, which a back edge leaves and re-enters: a new, empty cell
// on every turn, and the last write lost. The declaration now stores `undefined` where it stands.
interface Item {
  id: number
  x: number
}

function nearest<T extends Item>(items: T[], x: number): T | undefined {
  let best: T | undefined
  let bestDistance = Infinity
  for (const item of items) {
    const distance = Math.abs(item.x - x)
    if (distance < bestDistance) {
      bestDistance = distance
      best = item
    }
  }
  return best
}

function nearestPlain(items: Item[], x: number): Item | undefined {
  let best: Item | undefined
  let bestDistance = Infinity
  for (const item of items) {
    const distance = Math.abs(item.x - x)
    if (distance < bestDistance) {
      bestDistance = distance
      best = item
    }
  }
  return best
}

// A `let` inside the loop is still a new, undefined binding on every turn.
function perIteration(flags: boolean[]): string {
  let out = ''
  for (const flag of flags) {
    let seen: number | undefined
    if (flag) seen = 7
    out += seen === undefined ? 'u' : String(seen)
  }
  return out
}

// do/while: the body is the loop header.
function doWhile(limit: number): string {
  let out = ''
  let i = 0
  do {
    let held: string | undefined
    if (i % 2 === 0) held = 'e' + i
    out += held === undefined ? '-' : held
    i += 1
  } while (i < limit)
  return out
}

function carried(values: number[]): number | undefined {
  let best: number | undefined
  for (const value of values) {
    if (best === undefined || value > best) best = value
  }
  return best
}

// Written in the inner loop, read in the outer one.
function nested(rows: number[][]): string {
  let out = ''
  let longest: number | undefined
  for (const row of rows) {
    let rowBest: number | undefined
    for (const value of row) {
      if (rowBest === undefined || value > rowBest) rowBest = value
    }
    if (rowBest !== undefined && (longest === undefined || rowBest > longest)) longest = rowBest
    out += rowBest === undefined ? '_' : String(rowBest)
  }
  return out + '/' + String(longest)
}

// `var` is hoisted to the function, and `var kept;` does not reset it: one cell for the whole call.
function viaVar(values: number[]): string {
  let out = ''
  for (const value of values) {
    var kept: number | undefined
    if (value > 1) kept = value
    out += kept === undefined ? 'u' : String(kept)
  }
  return out
}

const items: Item[] = [
  { id: 1, x: 10 },
  { id: 2, x: 3 },
  { id: 3, x: 7 }
]
console.log('nearest generic', nearest(items, 4)?.id)
console.log('nearest plain', nearestPlain(items, 4)?.id)
console.log('per-iteration', perIteration([true, false, true, false]))
console.log('do-while', doWhile(5))
console.log('carried', carried([3, 9, 4]), carried([]))
console.log('nested', nested([[1, 5], [], [4, 2]]))
console.log('var', viaVar([1, 3, 1, 2]))
