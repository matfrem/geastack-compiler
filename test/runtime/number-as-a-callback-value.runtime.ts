//! expect: 2 7 | 4.5,NaN,0 | 3,2.5 | 7,16
// `Number` handed over as a function value: ToNumeric of each argument, from the carrier it arrived in.
const parts = '3,4'.split(',').map(Number)
const mixed = ['4.5', 'x', ''].map(Number)
const same = [3, 2.5].map(Number)
const spaced = [' 7 ', '0x10'].map(Number)
console.log(parts.length + ' ' + (parts[0]! + parts[1]!) + ' | ' + mixed.join(',') + ' | ' + same.join(',') + ' | ' + spaced.join(','))
