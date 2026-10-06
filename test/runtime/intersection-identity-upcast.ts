//! expect: same true egg 1
//! expect: other false
//! expect: via-list true
//! expect: plain egg

// An object typed `BeamTarget & { pos: number }` and the same object seen as the
// bare `BeamTarget` are ONE object: comparing them by identity holds, and a
// different object of the same shape does not compare equal. The interface the
// intersection adds a field to is laid out with that field, so no copy stands
// between the two views.
interface BeamTarget {
  kind: string
}

const egg: BeamTarget & { pos: number } = { kind: 'egg', pos: 1 }
const other: BeamTarget & { pos: number } = { kind: 'egg', pos: 1 }
const plain: BeamTarget = { kind: 'plain egg' }

const view: BeamTarget = egg
console.log('same', view === egg, view.kind, egg.pos)
console.log('other', view === other)

const targets: BeamTarget[] = [other, egg, plain]
console.log('via-list', targets[1] === egg)
console.log(targets[2]?.kind)
