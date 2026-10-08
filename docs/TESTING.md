# Tests from a fresh clone

Install the locked npm packages, then run the serial test suite:

```sh
npm ci --ignore-scripts
npm test
```

The build, compiled unit tests, standalone integrations, runtime fixtures, and
Node differential oracle run in separate processes. A failing command makes
`npm test` fail after the remaining commands have run. Existing TODO assertions
and optional external-corpus skips are reported by the individual tests.

Native tests require Clang with C++20 and sanitizer support. Framework headers
come from the declared npm development dependencies and their shipping source
manifest; no sibling core, Apple, or corpus checkout is required. The Node
project integration packs this compiler and installs that tarball into its test
application, so its native driver uses the compiler under test through normal
npm resolution. This integration needs access to the npm registry or cache.

`GEA_APPS_ROOT` and `GEA_NODE_COMPAT_ROOT` optionally enable additional tests of
external applications. They are not needed for the self-contained Node project
integration. The upstream Test262 dataset is a separate conformance sweep.

The emitted-set comparison remains a separate check (`npm run gate`). Pebble's
SDK-dependent size check is documented in [PEBBLE-SIZE.md](PEBBLE-SIZE.md).

## Speed against Node

`node scripts/bench-vs-node.mjs` compiles the programs of `test/bench/` with this compiler, builds them with clang `-O2`
and times each beside Node running the same TypeScript file. The programs cover numeric loops, typed-array integers and
`Float32Array` stencils, small-object allocation, collections and closures. Each prints its own elapsed time and a
checksum, so the output says both that the two runs agree and how long each took. It is a measurement, not a test: it
needs clang on the path, and a figure is a tendency on one machine (`BENCH_OPT`, `BENCH_SAMPLES`).
