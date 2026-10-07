//! expect: one {|"name":"x\"{",|"size":2,|"tags":[|"a",|"b"|],|"nested":{|"a":1|},|"none":[]|}
//! expect: two [|--[|----2,|----3|--],|--[|----4|--]|]
//! expect: compact {"name":"x\"{","size":2,"tags":["a","b"],"nested":{"a":1},"none":[]}
// `JSON.stringify(record, null, space)` has no callable replacer, so the typed writer's compact text is the answer; the
// `space` argument used to be dropped (and a record first argument refused outright). The compact text is now laid out
// by `gea::json::reindent`, which must leave braces inside strings alone and keep empty containers compact.
interface Level { name: string; size: number; tags: string[]; nested: { a: number }; none: string[] }
const level: Level = { name: 'x"{', size: 2, tags: ['a', 'b'], nested: { a: 1 }, none: [] }
const flat = (text: string): string => text.split('\n').join('|').split('  ').join('')
console.log('one ' + flat(JSON.stringify(level, null, 1)).split(' ').join(''))
console.log('two ' + flat(JSON.stringify([[2, 3], [4]], null, '--')))
console.log('compact ' + JSON.stringify(level, null))
