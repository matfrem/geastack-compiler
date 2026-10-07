# Runtime containers and `gea::Ref`: what was looked at, and what it came to

A read of `gea_runtime.h`'s containers for algorithmic problems and for needless `Ref` traffic on the add and remove
paths, done against the Bioustopia game (`measurements/bioustopia-snapshot`) as the workload. Numbers are clang 19 `-O2`
on the development machine, best of seven runs.

## Found and fixed

- **`Map` and `Set` searched linearly**, for `get`, `has`, `set`, `add` and `remove`. Insertion order is what the
  specification requires of them, not a linear scan, so they keep the vector but add a hash index from 16 entries
  (`ae20a74`), and removal marks a slot dead instead of shifting the vector (`fefdb3c`). The index maps hash to insertion
  serial, which a deletion does not move, so it survives compaction and the iterator cursors' binary search is
  unchanged. The game's `Map<string, ...>` and `Set<string>` tables (about 100 of them in the generated code) were the users.

## Looked at and left alone

- **`ArrayObject`** is already tuned with measurements in its own comments: elements contiguous without a presence bit,
  holes and `undefined` kept in side vectors that exist only for an array that needs them, `push` with an rvalue
  overload, small trivially-copyable elements passed in registers. `shift`/`splice`/`unshift` are O(n) (a vector
  erase); the game calls `shift` in two places, on queues of a few entries.
- **`Dictionary`** (`{[key: string]: V}`) is open addressing over a never-moving entry store. `delete o[k]` shifts the
  later entries and rebuilds the index, O(n) with a hash per key; the header says so and that it is the only caller. The game
  never deletes from a dictionary (its 20 `.delete(` calls are on `Map` and `Set`). A backward-shift deletion would cut the
  constant by an order of magnitude; not done, nothing here would use it.
- **`SymbolDictionary`** keeps a `std::map` of positions: O(log n), fine.
- **Refcounts** are intrusive, 32-bit and non-atomic (`RefCounts`): a copy of a `Ref` is an increment and its end a
  decrement plus a test, not a lock-prefixed instruction.

## Measured, and why nothing was changed

3,000,000 pushes of a freshly built `Ref<Cell>` into a reserved array (`path.push(c)` where `c` dies at the end of the
scope):

| form | time |
|---|---|
| `push(c)`, the printer's current spelling (retain, release at scope end) | 19.1 ms |
| `push(std::move(c))` | 18.3 ms |

Four percent, because the allocation of the cell dominates. Teaching the printer to move at every last use of an
owned local would change the emitted text for a large part of every program for that. Not done.

Reading an element of an array of `Ref`s into a local (`CellRef c = a[i]`) against reading it by reference
(`const CellRef& c = a[i]`): 3.8 ms against 1.7 ms for 3,000,000 reads, 1.3 ns against 0.55 ns each. A reference is only
safe while nothing mutates the array, which is the question the stable-borrow analysis already answers for parameters.
Extending it to element reads is the one change here with a visible win in a tight loop over many objects; it is also an
analysis change in the emitter, so it is written down rather than started.

## If it is picked up

1. Element reads bound by reference where the array is provably not written while the reference lives
   (`ir/stable-cell-reads.ts` and the stable-borrow entries are the starting point).
2. Backward-shift deletion in `Dictionary::erase`, with a reference-comparison C++ test like
   `test/keyed-collection-index.cpp`.
3. An amortised front-removal for `Array.prototype.shift` (an offset into `cells`), if a program with a long queue shows up.
