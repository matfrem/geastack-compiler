// `gea::cursorRange` is the range-for form of a cursor loop: `for (T item : cursorRange(cursor))` for the loop
// `for (;;) { T item = cursor.arrayNext(); bool done = cursor.done(); if (done) break; ... }`. This runs it against that loop
// on a cursor that records its calls: same elements, same two calls in the same order, same state after a break.
import { executableSuffix } from './executable-suffix.mjs'
import { sanitizerArguments, sanitizerEnvironment } from './sanitizer.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'measurements/cxx')
mkdirSync(outDir, { recursive: true })
const binary = resolve(outDir, `cursor-range-test${executableSuffix}`)

execFileSync(
  process.env.CXX || 'clang++',
  [
    '-std=c++20',
    '-O1',
    '-fsanitize=address,undefined',
    ...sanitizerArguments,
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    resolve(root, 'test/cursor-range.cpp'),
    '-o',
    binary
  ],
  { stdio: 'inherit' }
)
const output = execFileSync(binary, [], { encoding: 'utf8', env: { ...process.env, ...sanitizerEnvironment } })
assert.match(output, /ALL OK/, output)
console.log('cursor range: ok')
