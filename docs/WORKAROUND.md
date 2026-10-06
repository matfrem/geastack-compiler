# Workarounds: making TypeScript compile, and which ones were needed

This reviews the refusal catalogue in Bioustopia's `unreal/tools/geatsc/README.md`
("What had to change in the TypeScript", commit `1008650`, written against
sources from `45e5e71`), item by item, against this compiler.

It exists because a workaround is a bet that the compiler gap is permanent. Most
of the ones below are real gaps, but several were solved with a heavier change
than the gap needed, and two did not reproduce at all.

## How this was checked, and what it does not prove

Each construct was rebuilt as a small standalone program and run through
`node dist/cli.js coverage <file> --project tsconfig.json --no-derived`, with the
`DOM` lib, as the game does. Then the lightest alternative was run the same way.

- **Verified**: the refusal reproduces in isolation, and the named alternative
  makes the same program mint a certificate.
- **Not verified**: anything that depends on the real game tree. A construct that
  compiled here but was refused there may differ in a way the small program
  lacks (a deeper nesting, a generic, a second use). Those rows say so.
- The Bioustopia host plugin was not used, so host-function rows (`hostInput` and
  the rest) are untested.
- This is the compiler at its current `main`. A fix here would move emitted C++
  for other programs, so it goes through `npm run gate` before landing.

Positions: a certify-stage refusal such as `G9007` now prints `file:line:column`
in `coverage` and `compile`. The README's advice to bisect to locate one no longer
applies; the position points at the offending literal or assignment.

## The root cause behind items 1, 2, 3 and 5

The compiler gives two carriers to what TypeScript sees as one shape:

- a **record** (`record(type|N, owned, ...)`): an anonymous object literal whose
  type was inferred, and
- a **native record ref** (`native-record-ref(type|M, ...)`): a value whose
  declared type is a named interface or class, which is what an optional field
  or an interface-typed slot selects.

There is no conversion between them, so `G9007 ... no runtime conversion is
installed` appears wherever an _inferred_ literal flows into a slot whose
declared type is the named one. **The literal is built before it knows what it is
for.** Giving the literal its declared type at the point it is written makes the
compiler build the right carrier directly, with no conversion at all.

That is why the lightest fix is almost always a type annotation, not a change to
the data model.

## Item by item

Legend: **needed** = reproduces and cannot be avoided; **heavier than needed** =
reproduces but a lighter fix works; **not reproduced** = compiled in isolation.

### 1. Optional properties in table literals: heavier than needed

Reproduced. A `Record<Id, Def>` whose entries hold `blueprints: [{ rows }]` next to
`blueprints: [{ variant: 'A', rows }]`, with `variant?: string`, is refused with
`G9007` at the entry (`4:3`, the `nest:` property).

The README made `variant`, `villageOnly`, `flat`, `nest` and `merge` **required** and
rewrote every literal in `BUILDINGS`. That changes the model (`undefined` became
`''` and `false`) to dodge a carrier choice. Lighter, all verified:

```ts
// a typed helper: the literal is contextually typed at its construction
const bp = (rows: string[], variant?: string): Blueprint => ({ rows, variant })
const def = (d: Def): Def => d
nest: def({ id: 'nest', blueprints: [bp(['BSB'])] })
```

or give the nested array its declared type on its own line
(`const nestBp: Blueprint[] = [{ rows: ['BSB'] }]`).

Writing `variant: undefined` explicitly does **not** help (still refused), so the
trigger is the missing key in an uncontextualized nested literal, not optionality
itself.

### 2. Arrays of anonymous vs named records: not reproduced

`{ x; y; z }[]` passed to a `Vec3Like[]` parameter, and `solid.map(t => ({ x, z }))`
passed to `GridCell[]`, both compile here. The README's change (use the named type
everywhere) is harmless and arguably good, but it was not shown to be required. If
it was needed in the real tree, the cause is something the isolated program lacks;
ask for the exact `G9007` line it printed, which now carries a position.

### 3. A record with more fields where fewer are expected: not reproduced

`badges: result.badges` (`BadgeResult[]` into `HudBadge[]`) compiles here. The
explicit `.map` is still a fine way to copy exactly what the HUD needs, but it was
not forced by the compiler in this form.

### 4. Intersection-typed literal compared by identity: heavier than needed

Reproduced as an emission refusal (`G6999`: `binary "===" mixes a "record" and a
"native-record-ref" carrier`).

The README replaced the type with a base class and subclasses. Lighter, verified:
a **named interface that extends** the base instead of an intersection.

```ts
interface PosTarget extends BeamTarget {
  pos: number
}
const egg: PosTarget = { kind: 'egg', pos: 1 }
const t: BeamTarget = egg
t === egg // compiles
```

An intersection is anonymous, a named `extends` is not, which is the whole
difference. No class hierarchy is needed.

### 5. `Object.fromEntries` building a dictionary of records: heavier than needed

Reproduced exactly (`G9007 dictionary(string, record(...)) -> optional(dictionary(string,
native-record-ref(...)))`), and it is the error that started this investigation.
The inferred tuple `[string, { opacity }]` makes an anonymous record element.

The README rewrote these as loops. Lighter, verified (and it also works inside a
`{ ...base, ...Object.fromEntries(...) }` spread):

```ts
Object.fromEntries(names.map((n): [string, NodePose] => [n, { visible: true }]))
```

The same annotation applies to `src/content/scenery.ts:122`, `blocks.ts:38`,
`rainbow.ts:35` and `:73`, `scenery.ts:136`, `villageView.ts:59` and
`ojs/render/model.ts:245`.

### 6. `Array.from({ length: n }, (_, i) => ...)`: needed, but it is boxing, not refusal

The program still compiles and mints a certificate. `_` is `unknown` from the lib
signature, so one value is boxed as `gea::Value` (`G8005`). Annotating the
callback (`(_: unknown, i: number): number`) does **not** remove it. A counted
`for` loop is the right fix, for speed rather than because it would not compile.

### 7. Destructuring swap `[a[i], a[j]] = [a[j], a[i]]`: needed

Reproduced (`G2000 computed array assignment target keys are not yet modelled`).
The temporary-variable swap compiles. A real gap; no lighter form exists.

### 8. `.map(Number)`: needed

Reproduced (`G6999 host-invocation:Number:value`). `.map((s) => +s)` and
`parseFloat` compile.

### 9. Optional methods `start?()` called as `start?.()`: heavier than needed

Reproduced as `G6999 conversion:function-value-dispatch ... optional(...)`.

The README made `start` and `end` required and added an empty body to every
activity that had none. A shared base class with no-op defaults does the same with
one definition (verified):

```ts
abstract class Base implements Activity {
  abstract label: string
  start(_ai: JardinouAI): void {}
  abstract update(ai: JardinouAI, dt: number): boolean
  end(_ai: JardinouAI): void {}
}
```

Activities extend `Base` and override only what they use; callers drop the `?.`.

### 10. Dynamic index on an `as const` tuple: needed, small

Reproduced (`G6999 native-boundary:dynamic-property-sidecar:owned`).
`const STAGES: readonly number[] = [...]` compiles and is the minimal fix.

The second half, `this.pos[axis] += delta` with `axis: 'x' | 'y' | 'z'`, **did not
reproduce** on a plain class with three numeric fields, so the `getAxis`/`setAxis`
helpers are unverified. They may be needed for the real `Player` shape; check the
exact refusal before keeping them.

### 11. `for (const [a, b, c] of [[...], [...]] as const)`: heavier than needed

Reproduced (`G9009 get-iterator:record(no-iterator-method)`): an `as const` array
of tuples is rejected as having no iterator (the refusal names `record(no-iterator-method)`); a plainly typed
array iterates fine, both of these were verified:

```ts
const rows: number[][] = [[1, 2, 3], [4, 5, 6]]
const rows: [number, number, number][] = [[1, 2, 3], [4, 5, 6]]
for (const [a, b, c] of rows) { ... }
```

The README says the `as const` and `new Array(n).fill(null)` were changed together,
so which one the compiler actually objected to was never isolated. The counted
loop is not forced by this construct.

### 12. `indexOf(null)` on `(T | null)[]`: needed

Reproduced (`G6999 runtime-helper:element:indexOf ... carries "null"`). A search
loop with `=== null` compiles. A real gap.

### 13. `console.warn`: needed, and a compiler-side one-liner

Reproduced (`G9003`). The compiler's host table registers only `Console.log`
(`src/targets/cpp/host/host-members.ts:578`). `warn`, `error`, `info` and `debug`
are missing and would be natural additions to that shim table; until then
`console.log` is the workaround.

### 14. `performance.now()`: needed

Reproduced (`G4005` / `G9003` / `G9008`, no `Performance` binding). `Date.now()` works.

### 15. `console` needs the `DOM` lib: not a workaround

The tsconfig comment is accurate in spirit: geatsc takes the host surface from the
type declarations, so the lib must declare `console`. Nothing to change in the code.

### 16 and 17. MSVC `multiline` regex flag, `-fms-runtime-lib=dll`: not TypeScript

Build-environment fixes in `build-native.bat`, unrelated to this compiler's
refusals. Not reviewed here. The first patches generated runtime text with a
script; if that is still needed, it is better reported as a runtime-header issue.

## Summary

| #    | Needed?             | Lightest fix that compiled                          |
| ---- | ------------------- | --------------------------------------------------- |
| 1    | heavier than needed | typed helper (`bp`, `def`) or a typed nested array  |
| 2, 3 | not reproduced      | none verified necessary                             |
| 4    | heavier than needed | named `interface ... extends`, not an intersection  |
| 5    | heavier than needed | `.map((n): [string, T] => ...)`                     |
| 6    | boxing, not refusal | counted `for` loop                                  |
| 7    | needed              | temporary-variable swap                             |
| 8    | needed              | `(s) => +s`                                         |
| 9    | heavier than needed | base class with no-op `start`/`end`                 |
| 10   | needed (small)      | `readonly number[]`; axis helpers unverified        |
| 11   | heavier than needed | typed `number[][]` or tuple array                   |
| 12   | needed              | search loop                                         |
| 13   | needed (compiler)   | `console.log`; add `Console.warn` to the shim table |
| 14   | needed              | `Date.now()`                                        |

## What is a compiler defect, not a project defect

Items 1, 4, 5 and 9 are the same defect seen four ways: a value whose type is
inferred cannot flow into a slot with a declared named type, although the
literal is assignable. The proper fix is in the compiler (contextual typing of the
literal at the conversion site, or a record-to-native-record conversion). The
annotations above are the supported way to work until then, and they cost a type
name, not a redesign.
