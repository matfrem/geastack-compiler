// `gea::Map` and `gea::Set` keep their entries in insertion order in a vector, and index them by hash once
// they outgrow a scan. This runs the runtime header's own containers against a naive ordered reference:
// lookups, removal, iteration after deletion, -0 / NaN keys, and reference and optional keys must all agree
// with what the linear scan answered before the index existed.
import { executableSuffix } from './executable-suffix.mjs'
import { sanitizerArguments, sanitizerEnvironment } from './sanitizer.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'measurements/cxx')
mkdirSync(outDir, { recursive: true })
const binary = resolve(outDir, `keyed-collection-index-test${executableSuffix}`)

execFileSync(
  process.env.CXX || 'clang++',
  [
    '-std=c++20',
    '-O1',
    '-fsanitize=address,undefined',
    ...sanitizerArguments,
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    resolve(root, 'test/keyed-collection-index.cpp'),
    '-o',
    binary
  ],
  { stdio: 'inherit' }
)
const output = execFileSync(binary, [], { encoding: 'utf8', env: { ...process.env, ...sanitizerEnvironment } })
assert.match(output, /ALL OK/, output)
console.log('keyed collection index: ok')
