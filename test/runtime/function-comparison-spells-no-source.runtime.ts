//! expect: same true
//! expect: different false
//! expect: kind function
//! emitted-lacks: _thunk_source
// Comparing functions, testing their `typeof` or negating one takes the function as a value and spells nothing of it,
// so a program that does only that must not carry the source text of every function it makes: the census of readers
// (`translation-unit.ts`'s `preserveFunctionFacts`) counted any `compute` over a callable, and a single `===` turned the
// text on for the whole program.
function first(): number {
  return 1
}
function second(): number {
  return 2
}
const functions = [first, second]
console.log('same', functions[0] === first)
console.log('different', functions[0] === second)
console.log('kind', typeof functions[1] === 'function' && !(functions[0] === undefined) ? 'function' : 'other')
