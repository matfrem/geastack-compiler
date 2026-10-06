//! expect: nest 1 none BSB
//! expect: pond 2 A .B.
//! expect: pond 2 B BB
//! expect: flat true false

// A table typed `Record<'nest' | 'pond', Def>` is laid out as that declared type,
// not as the literal's own inferred record, even when `Def` is wider than the
// literal (an optional field one array level down is enough). The properties then
// need no conversion from `Def` into an anonymous record.
interface Blueprint {
  variant?: string
  rows: string[]
}
interface Def {
  id: string
  flat?: boolean
  blueprints: Blueprint[]
}

const DEFS: Record<'nest' | 'pond', Def> = {
  nest: { id: 'nest', blueprints: [{ rows: ['BSB'] }] },
  pond: { id: 'pond', flat: true, blueprints: [{ variant: 'A', rows: ['.B.'] }, { variant: 'B', rows: ['BB'] }] }
}

for (const key of ['nest', 'pond'] as const) {
  const def = DEFS[key]
  for (const blueprint of def.blueprints) {
    console.log(def.id, def.blueprints.length, blueprint.variant ? blueprint.variant : 'none', blueprint.rows[0])
  }
}
console.log('flat', DEFS.pond.flat === true, DEFS.nest.flat === true)
