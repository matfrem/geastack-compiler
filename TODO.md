# TODO

Followed in order when the user says **"pars en autonomie"**. One commit per item, each with its verification
recorded in the message. An item that turns out wrong or risky is stopped, written up here, and skipped; nothing is
"fixed" by weakening a guard.

Everything readable is behind `--short-names`: the default output does not change, so the tests and the gate
baselines are unaffected. Items that change the default output say so.

## How every item is verified

1. `npx tsc -p tsconfig.json --noEmit` clean; `npx prettier --check` on the files touched; `node test/compiler-value-contracts.mjs` (70/70).
2. `node scripts/architecture.mjs`: the only violations allowed are the sibling `geatsc\dist` and
   `geastack-compiler-prod\dist` ("private copy"), which belong to the machine, not the tree.
3. The Bioustopia output compiles with clang 19, `-fsyntax-only`, from the frozen snapshot
   `measurements/bioustopia-snapshot` (a `git archive` of the game's commit `1de9f60`; its working tree is edited by
   another thread, so never compile that one):
   `node dist/cli.js compile <snapshot>/src/native/main.ts --out-dir <dir> --project <snapshot>/unreal/tools/geatsc/tsconfig.json --plugin <snapshot>/ojs/native/geatsc-plugin.mjs --short-names`
4. Behaviour: replay the `test/runtime` programs that `SUITE-STATUS.tsv` records as ok, compiled with `--short-names`,
   built at -O0 and run, each `//! expect:` line checked. Baseline: **300 ok, 22 skipped, 1 failing**
   (`regexp-clone-unsupported-flags.ts` fails identically without the option on this machine). The harness is
   `harness.mjs` (kept in the session scratchpad; recreate it from `scripts/run-emitted.mjs` if lost: emit with the
   CLI, build `geatsc-sources.txt` + a `main` calling `__gea_top_level()`, force-include `measurements/shim.h`).
5. clang 19 lives in `C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\Llvm\x64\bin` and needs
   `vcvars64.bat`; it is not on the PATH. The machine's STL lacks `std::regex_constants::multiline`, hence the shim.
6. A change to the runtime header gets a C++ test next to `test/keyed-collection-index.cpp`, run under
   AddressSanitizer.

## 1. Loops, finished (agreed)

The loops are `for (;;)` with `break`/`continue` today (`emit-loops.ts`). In the Bioustopia output 373 loops, of which
123 start with a bare test and 183 walk an array. The 123 are mostly TypeScript `for (let i = 0; i < n; i++)`: the
step is at the end of the body (`x = x + 1; continue;`) and the initialiser just before the loop.

1. **Counted `for`**: `long long x = 0; for (;;) { if (!(x < n)) break; { ... x = x + 1; continue; } }` becomes
   `for (long long x = 0; x < n; ++x) { ... }`. Conditions: the first statement is the exit test, the last statement
   before the loop's end is `V = V + 1` / `V = V - 1` / `V = V + K` on a name the test reads, no label or goto targets
   that step (a source `continue` makes the emitter share one step block: leave those), and the initialiser moves into the
   `for` only if the name is not mentioned after the loop.
2. **`while (cond)`** for the loops that start with a bare test but have no recognisable step.
3. **Array iteration**: the `LocalArrayCursor` + `arrayNext()` + `done()` loops (183) as a range-for or a cursor loop;
   check that `arrayNext` before `done` keeps its meaning on holes and on a body that grows the array.
4. **Loops with a source `continue`**: the shared step block (`block2: i = i + 1; continue;` reached by several gotos)
   written as a counted `for` whose `continue` runs the step.
5. **Trailing `continue;`** dropped when it is the last statement of the loop body (only for the ones the printer
   wrote, never one inside a C++ loop the block text spells itself).

## 2. The runtime containers and `gea::Ref` (agreed, "plus tard")

Most heavily used containers hold `Ref`s. On every add and remove look for shortcuts: a move instead of a retain/release
pair, moved-from slots left behind, tombstones, batch operations. Review `ArrayObject`, `Dictionary`,
`NumericDictionary`, `SymbolDictionary`, the iterators, `Optional<Ref<T>>`, and how `Ref` copies and releases are spelled
in generated code. Map and Set are done (hash index `ae20a74`, O(1) removal `fefdb3c`).

## 3. Confirmed in advance by the user: do them without asking

In this order, after sections 1 and 2. The gate baselines (old item 6) are *not* in this list: see "Postponed".

1. **Portability of `gea_runtime.h`**: `std::regex_constants::multiline` is missing from VS2022's STL, which stops
   `scripts/check-runtime-header.mjs` and the runtime suite on this machine. A feature test around it. (Small; also lets
   the harness drop its shim.)
2. **Report to the main repo**: nothing to do. The `let`/`var` fixes (`9abd76d`, `b62b855`) are written up as a bug report and the user sends it.
3. **Cold code**: `[[gnu::cold]]` / `noinline` on module-initialisation bodies and error paths. Measure `-O1` on one
   file first; the backend is 67 of 77 s of a Bioustopia build, 35 s of it in the inliner.
4. **Per-field `gea_present_x` / `gea_attributes_x`** (about 26% of the output's bytes): omit them for a field the
   program never deletes, redefines or freezes. The `fieldOperations` reflection demand already says which.
5. **Names**: the ~535 still-anonymous bodies, the ~113 anonymous records, source-location comments above classes.
6. **Game-side compiler gaps** seen in the working tree of `C:\Work\BioustopiaCpp` (`ojs/level/levelFile.ts`,
   `ojs/save/slots.ts`): `JSON.stringify(record, null, 1)` ("replacer support requires a string or genuinely dynamic
   input") and an optional method read as a value (`this.cfg.savedAt?.(data)`) are refused.
7. **Fix `var` declared in a function with a `switch`/try region** if the pinned-scope fix is ever found not to reach the
   region layout (`regionScopedBlocksOf` passes `pinned`, but no test covers it).
8. **Tests for the `--short-names` passes** (`readable-text.ts`, `identifier-names.ts`, `emit-loops.ts`) as unit tests
   next to the code, so they do not depend on the Bioustopia snapshot.

## Postponed (user: "on verra après")

- **Gate baselines** are stale in this environment (every program "moves" on a clean HEAD, 168 of 168 corpus programs):
  find out why (line endings, paths, TypeScript version) and re-take them from a tree where that is true. Do not run
  `npm run gate -- --write` here before that is understood.
