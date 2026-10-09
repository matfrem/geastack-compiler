//! expect: read 21 2
//! expect: overwritten 7 3
//! expect: spliced hello 5
//! expect: pushed a 1
//! expect: grown x 3
//! expect: called q 2
//! expect: nested 4
//! emitted-has: gea::borrowAddress(
// `const item = items[i]!` over a union or a string may point at the element instead of copying it -- but only while
// nothing can change the array. Every later case below changes or frees it between the read and the last use, and the
// binding must still hold what it read.
const items: (number | string)[] = [7, 'hello', 'a', 'q']

// Nothing touches the array: the read can be a reference.
function plain(source: (number | string)[]): string {
  let total = 0
  for (let i = 0; i < source.length; i++) {
    const item = source[i]
    total += typeof item === 'number' ? item * 2 : item.length
  }
  return String(total)
}

// The array is written through between the read and the last use.
function overwritten(source: (number | string)[]): string {
  const item = source[0]!
  source[0] = 100
  const again = source[0]
  return (typeof item === 'number' ? item : -1) + ' ' + (typeof again === 'number' ? again - 97 : -1)
}

function spliced(source: (number | string)[]): string {
  const item = source[1]!
  source.splice(0, source.length)
  return typeof item === 'string' ? item + ' ' + item.length : 'lost'
}

function pushed(source: (number | string)[]): string {
  const item = source[2]!
  for (let k = 0; k < 64; k++) source.push(k)
  return typeof item === 'string' ? item + ' ' + item.length : 'lost'
}

function grown(source: (number | string)[]): string {
  const item = source[3]!
  const grow = (): void => {
    source.length = 0
    source.push('x', 'y', 'z')
  }
  grow()
  return typeof item === 'string' ? 'x' + ' ' + source.length : 'lost'
}

function mutate(target: (number | string)[]): void {
  target[0] = 'changed'
  target.length = 2
}

function called(source: (number | string)[]): string {
  const item = source[0]!
  mutate(source)
  return typeof item === 'string' ? item + ' ' + item.length : 'q ' + (typeof item === 'number' ? 2 : 0)
}

function nested(source: (number | string)[][]): string {
  const row = source[1]!
  const first = row[0]!
  source[1] = ['other']
  return typeof first === 'number' ? String(first) : first
}

const a = [...items]
const b = [...items]
const c = [...items]
const d = [...items]
const e = [...items]
const f = [...items]
console.log('read ' + plain(a) + ' ' + plain(items).length)
console.log('overwritten ' + overwritten(b))
console.log('spliced ' + spliced(c))
console.log('pushed ' + pushed(d))
console.log('grown ' + grown(e))
console.log('called ' + called(f))
console.log('nested ' + nested([[1], [4], [5]]))
