# Performance: where the native code stands against Node

This page records what the speed benchmarks measure, the figures at the last full run, what was done to get them, and
what is known to be slow. A figure is a tendency on one machine, not a verdict: the programs are small, Node's JIT
warm-up is inside its time, and a native program does no warm-up at all.

Figures below: 2026-10-09, Windows 11, clang 19 `-O2 -DNDEBUG`, best of 5 samples (3 for the Are We Fast Yet ports).
"native vs Node" is Node time divided by native time, so above 1 means the native build is faster.

## Running them

```sh
node scripts/bench-vs-node.mjs                 # every program of test/bench/
node scripts/bench-vs-node.mjs stencil unions  # some of them
BENCH_DIR=test/bench/awfy BENCH_SAMPLES=3 node scripts/bench-vs-node.mjs   # the Are We Fast Yet ports
```

Each program times its own work with `Date.now()` and prints `<name> <ms> <checksum>`; the script compiles it with
`dist/`, builds it with clang, runs Node on the same `.ts` file (`--experimental-strip-types`, so only erasable syntax)
and reports whether the two checksums agree. On Windows put clang on the path from a Visual Studio developer prompt.
`BENCH_OPT`, `BENCH_SAMPLES`, `BENCH_PROJECT` and `BENCH_DIR` tune the run.

## Our own programs (`test/bench/`)

| program     | what it exercises                                              | native vs Node |
| ----------- | -------------------------------------------------------------- | -------------- |
| collections | `Map`/`Set` with number and string keys                        | 2.15x          |
| stencil     | `Float32Array` 5-point stencil, nested loops, `k = y*size + x` | 2.20x          |
| closures    | closure creation and calls                                     | 1.69x          |
| sieve       | `Uint8Array` sieve of Eratosthenes                             | 1.41x          |
| mandelbrot  | scalar `double` loop                                           | 1.02x          |
| nbody       | `double` fields of small objects                               | 1.01x          |
| hassome     | a set kept as an array, queried through `hasSome(e => ...)`    | 0.86x          |
| trees       | binary trees: allocation and recursive calls                   | 0.80x          |
| strings     | `split`, `substring`, `startsWith` over a long text            | 0.76x          |
| unions      | `(number \| string)[]` visited through `typeof`                | 0.60x          |

`mandelbrot` and `nbody` are at the ceiling of plain C++: a hand-written C++ loop takes the same time (the work is a
chain of dependent floating-point operations). Going faster would mean computing several pixels at once; a hand-written
four-pixel version ran in about half the time, which the compiler does not attempt.

## Are We Fast Yet ports (`test/bench/awfy/`)

Typed TypeScript ports of four benchmarks of [smarr/are-we-fast-yet](https://github.com/smarr/are-we-fast-yet)
(Marr et al.): Richards, DeltaBlue, Havlak and Json. The upstream benchmarks are untyped CommonJS JavaScript under
mixed licences; those files are not in this repository. The ports are self-contained TypeScript files written for this
compiler (strict, erasable syntax only, the collection helpers of upstream `som.js` inlined and typed). `json.ts`
embeds the benchmark's input document. Iteration counts are chosen so Node takes about a second, except Json, kept
short because the native build is so slow on it.

| program   | Node (ms) | native (ms) | native vs Node |
| --------- | --------- | ----------- | -------------- |
| richards  | 980       | 2839        | 0.35x          |
| deltablue | 660       | 3707        | 0.18x          |
| havlak    | 1008      | 15255       | 0.07x          |
| json      | 48        | 10797       | 0.004x         |

All four produce the same checksum as Node.

## What was done

- **Dense windows through a settled index** (`ir/dense-loops.ts`): `const k = y * size + x` read in an inner loop, with
  `k - 1`, `k + size`, is proved once in the loop preheader and the accesses become raw pointer reads. `stencil`
  400 ms -> 130 ms.
- **Borrowed references to read-only callees** (`targets/cpp/heap-read-only.ts`): a field is passed by reference to a
  function that only reads the heap, instead of being copied (a refcount pair). `trees` 713 -> 376 ms.
- **Callbacks take handles by `const Ref<T>&`** (`cppCallableParameterType`): a callback that only reads its argument
  no longer pays a copy per call. `hassome` 298 -> 133 ms.
- **Locals bound once to an array element point at it** (`targets/cpp/borrowed-bindings.ts`): `const item = items[i]`
  over a union or string copied a variant per loop turn. The cell is a pointer when nothing between the read and the
  last use can change or free the array. `unions` 864 -> 281 ms.
- Map/Set hash index, `array[i]!` read once by reference, records whose key order nothing reads drop the inline slot.

## Known weak points

- **Strings are UTF-8, JavaScript indexes UTF-16.** `s.length` and `s.substring(i, i + 1)` have to prove the text before
  the index is ASCII, which costs time proportional to the position. A parser reading a long text one character at a
  time is therefore quadratic: this is Json (more than 200x slower than Node). Strings of 16 bytes or fewer have a fast
  path. A fix means carrying the UTF-16 length and an ASCII flag with the string (or storing UTF-16, as V8 does with
  its one-byte and two-byte strings); it was judged not worth the complexity for the games this targets, which index
  short strings and look values up by string key.
- **Richards, DeltaBlue, Havlak** are object-oriented code with virtual calls, many small allocations and closures per
  element (`forEach`, `hasSome`). Where the time goes is not measured: there is no profiler on the machine these
  figures come from. Hypotheses read off the generated C++: a refcounted handle copy at nearly every call, a type-erased
  callable invoked per element where V8 inlines the lambda, a cycle through `parent = this` that reference counting
  cannot free, and an owning `Ref` rebuilt around `this` at every virtual call.
- **Unions** still copy the string out of a union when it is selected (`gea_native_selection_1` returns by value); the
  gain measured for that alone was small because the strings in the benchmark are short.
- **`strings`**: `split` and `substring` allocate a `std::string` each, where V8 slices.
- Compiler gaps found while porting: a generic static method of a generic class called with two different type
  arguments is refused (`function-value-dispatch` conversion); `x as T` on a `null` value throws eagerly, where
  JavaScript erases the cast.
