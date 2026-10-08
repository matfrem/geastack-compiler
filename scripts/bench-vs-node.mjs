/**
 * Compile each program of `test/bench/` with geatsc, build it with clang, and time it beside Node.
 *
 *   node scripts/bench-vs-node.mjs [name ...]
 *
 * Every program times its own work with `Date.now()` and prints one line, `<name> <milliseconds> <checksum...>`, so
 * process start-up is outside the figure and the checksum says the two runs computed the same thing. Node runs the
 * `.ts` file as it is (`--experimental-strip-types`); the programs use erasable syntax only.
 *
 * `BENCH_DIR` names another directory of programs (default `test/bench`), for programs that are not ours to commit.
 * `BENCH_OPT` (default `-O2`) and `BENCH_SAMPLES` (default 5, the best of which is reported) tune the run, and
 * `BENCH_PROJECT` names the tsconfig the programs are compiled under (`test/bench/tsconfig.unchecked.json` adds
 * `noUncheckedIndexedAccess`, under which every `array[i]!` reads through an `Optional`). The native
 * build uses the compiler named by `CXX` (default `clang++`), so the environment must put clang on the path -- on
 * Windows, from a Visual Studio developer prompt. Output is written to `measurements/bench/<name>`.
 *
 * A figure here is a tendency on one machine, not a verdict: the programs are small, Node's own JIT warm-up is inside
 * its time, and a native program does no warm-up at all.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nativeHostIncludes } from './native-host-includes.mjs'
import { buildNative } from './native-build-cache.mjs'
import { executableSuffix } from '../test/executable-suffix.mjs'

const root = resolve(import.meta.dirname, '..')
const programsDirectory = resolve(process.env.BENCH_DIR ?? join(root, 'test', 'bench'))
const optimisation = process.env.BENCH_OPT ?? '-O2'
const samples = Number(process.env.BENCH_SAMPLES ?? 5)
const project = resolve(process.env.BENCH_PROJECT ?? join(programsDirectory, 'tsconfig.json'))
const requested = process.argv.slice(2)
const programs = readdirSync(programsDirectory)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => file.slice(0, -3))
  .filter((name) => requested.length === 0 || requested.includes(name))

const parse = (stdout) => {
  const lines = stdout.trim().split('\n')
  const line = lines.find((entry) => /^\S+ \d+ /.test(entry)) ?? lines.at(-1) ?? ''
  const [label, milliseconds, ...rest] = line.split(' ')
  return { label, ms: Number(milliseconds), check: rest.join(' ') }
}
const best = (runs) => runs.reduce((fastest, run) => (run.ms < fastest.ms ? run : fastest))

console.log(`optimisation ${optimisation}, ${samples} samples, the best of each`)
console.log('program'.padEnd(13), 'node ms'.padStart(9), 'native ms'.padStart(10), 'native vs node'.padStart(15), '  checksum')
for (const name of programs) {
  const source = join(programsDirectory, `${name}.ts`)
  const out = join(root, 'measurements', 'bench', name)
  mkdirSync(out, { recursive: true })
  let native = { ms: Number.NaN, check: 'build failed' }
  try {
    execFileSync(
      'node',
      [join(root, 'dist', 'cli.js'), 'compile', source, '--out-dir', out, '--project', project, '--closed-script-scope'],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const units = readFileSync(join(out, 'geatsc-sources.txt'), 'utf8').split('\n').filter(Boolean)
    writeFileSync(join(out, 'main_shim.cpp'), 'extern void __gea_top_level();\nint main() { __gea_top_level(); return 0; }\n')
    buildNative({
      out,
      units: [...units, join(out, 'main_shim.cpp')],
      includes: [`-I${out}`, ...nativeHostIncludes],
      pchExcludedUnits: [...units, join(out, 'main_shim.cpp')],
      cache: false,
      pch: false,
      flags: ['-std=c++20', optimisation, '-DNDEBUG']
    })
    const runs = []
    for (let sample = 0; sample < samples; sample += 1) {
      const ran = spawnSync(join(out, `program${executableSuffix}`), { encoding: 'utf8' })
      if (ran.status !== 0) throw new Error(`the native program exited ${ran.status}: ${ran.stderr}`)
      runs.push(parse(ran.stdout))
    }
    native = best(runs)
  } catch (error) {
    native = {
      ms: Number.NaN,
      check: String(error.message ?? error)
        .split('\n')[0]
        .slice(0, 150)
    }
  }
  const nodeRuns = []
  for (let sample = 0; sample < samples; sample += 1) {
    const ran = spawnSync('node', ['--experimental-strip-types', '--no-warnings', source], { encoding: 'utf8' })
    if (ran.status !== 0) {
      nodeRuns.push({ ms: Number.NaN, check: `node failed: ${(ran.stderr ?? '').split('\n')[0]}` })
      break
    }
    nodeRuns.push(parse(ran.stdout))
  }
  const node = best(nodeRuns)
  const same = node.check === native.check ? 'same' : `DIFFERENT node=${node.check} native=${native.check}`
  console.log(
    name.padEnd(13),
    String(node.ms).padStart(9),
    String(native.ms).padStart(10),
    `${(node.ms / native.ms).toFixed(2)}x`.padStart(15),
    '  ',
    same
  )
}
