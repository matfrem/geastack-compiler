// DeltaBlue from "Are We Fast Yet" (derived from the SOM version), typed port.
const INITIAL_SIZE: number = 10
const INITIAL_CAPACITY: number = 16

type Compare<T> = (a: T, b: T) => boolean

function vectorWith<U>(elem: U): Vector<U> {
  const v = new Vector<U>(1)
  v.append(elem)
  return v
}

class Vector<T> {
  storage: Array<T | null> | null
  firstIdx: number
  lastIdx: number

  constructor(size?: number) {
    this.storage = size === undefined || size === 0 ? null : new Array<T | null>(size)
    this.firstIdx = 0
    this.lastIdx = 0
  }


  at(idx: number): T | null {
    if (this.storage === null || idx >= this.storage.length) {
      return null
    }
    return this.storage[idx] as T | null
  }

  append(elem: T): void {
    if (this.storage === null) {
      this.storage = new Array<T | null>(INITIAL_SIZE)
    } else if (this.lastIdx >= this.storage.length) {
      const newLength = this.storage.length * 2
      this.storage = this.storage.slice()
      this.storage.length = newLength
    }
    this.storage[this.lastIdx] = elem
    this.lastIdx += 1
  }

  isEmpty(): boolean {
    return this.lastIdx === this.firstIdx
  }

  forEach(fn: (e: T) => void): void {
    for (let i = this.firstIdx; i < this.lastIdx; i += 1) {
      fn((this.storage as Array<T | null>)[i] as T)
    }
  }

  removeFirst(): T | null {
    if (this.isEmpty()) {
      return null
    }
    this.firstIdx += 1
    return (this.storage as Array<T | null>)[this.firstIdx - 1] as T | null
  }

  remove(obj: T): boolean {
    if (this.storage === null || this.isEmpty()) {
      return false
    }
    const newArray = new Array<T | null>(this.capacity())
    let newLast = 0
    let found = false
    this.forEach((it: T): void => {
      if (it === obj) {
        found = true
      } else {
        newArray[newLast] = it
        newLast += 1
      }
    })
    this.storage = newArray
    this.lastIdx = newLast
    this.firstIdx = 0
    return found
  }

  size(): number {
    return this.lastIdx - this.firstIdx
  }

  capacity(): number {
    return this.storage === null ? 0 : this.storage.length
  }

  swap(storage: Array<T | null>, i: number, j: number): void {
    throw new Error('Not Implemented')
  }

  // The original recurses via sort(i, l, c) with mismatched arguments and indexes with a
  // fractional (i + j) / 2; both only matter for n > 2, which is typed sanely here.
  sortRange(i: number, j: number, compare: Compare<T>): void {
    const n = j + 1 - i
    if (n <= 1) {
      return
    }
    const st = this.storage as Array<T | null>
    let di = st[i] as T
    let dj = st[j] as T
    if (compare(di, dj)) {
      this.swap(st, i, j)
      const tt = di
      di = dj
      dj = tt
    }
    if (n > 2) {
      const ij = Math.floor((i + j) / 2)
      let dij = st[ij] as T
      if (!compare(di, dij)) {
        if (!compare(dij, dj)) {
          this.swap(st, j, ij)
          dij = dj
        }
      } else {
        this.swap(st, i, ij)
        dij = di
      }
      if (n > 3) {
        let k = i
        let l = j - 1
        while (true) {
          while (k <= l && compare(dij, st[l] as T)) {
            l -= 1
          }
          k += 1
          while (k <= l && compare(st[k] as T, dij)) {
            k += 1
          }
          if (k > l) {
            break
          }
          this.swap(st, k, l)
        }
        this.sortRange(i, l, compare)
        this.sortRange(k, j, compare)
      }
    }
  }

  sort(compare: Compare<T>): void {
    if (this.size() > 0) {
      this.sortRange(this.firstIdx, this.lastIdx - 1, compare)
    }
  }
}

class DictEntry<K, V> {
  hash: number
  key: K
  value: V
  next: DictEntry<K, V> | null

  constructor(hash: number, key: K, value: V, next: DictEntry<K, V> | null) {
    this.hash = hash
    this.key = key
    this.value = value
    this.next = next
  }

  match(hash: number, key: K): boolean {
    return this.hash === hash && key === this.key
  }
}

function hashFn(key: Sym | null): number {
  if (!key) {
    return 0
  }
  const hash = key.customHash()
  return hash ^ (hash >>> 16)
}

class Dictionary<K extends Sym, V> {
  buckets: Array<DictEntry<K, V> | null>
  size_: number

  constructor(size?: number) {
    this.buckets = new Array<DictEntry<K, V> | null>(size === undefined ? INITIAL_CAPACITY : size)
    this.size_ = 0
  }

  getBucketIdx(hash: number): number {
    return (this.buckets.length - 1) & hash
  }

  getBucket(hash: number): DictEntry<K, V> | null {
    return this.buckets[this.getBucketIdx(hash)] as DictEntry<K, V> | null
  }

  at(key: K): V | null {
    const hash_ = hashFn(key)
    let e = this.getBucket(hash_)
    while (e) {
      if (e.match(hash_, key)) {
        return e.value
      }
      e = e.next
    }
    return null
  }

  atPut(key: K, value: V): void {
    const hash_ = hashFn(key)
    const i = this.getBucketIdx(hash_)
    const current = this.buckets[i] as DictEntry<K, V> | null
    if (!current) {
      this.buckets[i] = this.newEntry(key, value, hash_)
      this.size_ += 1
    } else {
      this.insertBucketEntry(key, value, hash_, current)
    }
    if (this.size_ > this.buckets.length) {
      this.resize()
    }
  }

  newEntry(key: K, value: V, hash: number): DictEntry<K, V> {
    return new DictEntry<K, V>(hash, key, value, null)
  }

  insertBucketEntry(key: K, value: V, hash: number, head: DictEntry<K, V>): void {
    let current: DictEntry<K, V> = head
    while (true) {
      if (current.match(hash, key)) {
        current.value = value
        return
      }
      if (!current.next) {
        this.size_ += 1
        current.next = this.newEntry(key, value, hash)
        return
      }
      current = current.next
    }
  }

  resize(): void {
    const oldStorage = this.buckets
    this.buckets = new Array<DictEntry<K, V> | null>(oldStorage.length * 2)
    this.transferEntries(oldStorage)
  }

  transferEntries(oldStorage: Array<DictEntry<K, V> | null>): void {
    for (let i = 0; i < oldStorage.length; i += 1) {
      const current = oldStorage[i] as DictEntry<K, V> | null
      if (current) {
        oldStorage[i] = null
        if (!current.next) {
          this.buckets[current.hash & (this.buckets.length - 1)] = current
        } else {
          this.splitBucket(oldStorage, i, current)
        }
      }
    }
  }

  splitBucket(oldStorage: Array<DictEntry<K, V> | null>, i: number, head: DictEntry<K, V>): void {
    let loHead: DictEntry<K, V> | null = null
    let loTail: DictEntry<K, V> | null = null
    let hiHead: DictEntry<K, V> | null = null
    let hiTail: DictEntry<K, V> | null = null
    let current: DictEntry<K, V> | null = head
    while (current) {
      if ((current.hash & oldStorage.length) === 0) {
        if (!loTail) {
          loHead = current
        } else {
          loTail.next = current
        }
        loTail = current
      } else {
        if (!hiTail) {
          hiHead = current
        } else {
          hiTail.next = current
        }
        hiTail = current
      }
      current = current.next
    }
    if (loTail) {
      loTail.next = null
      this.buckets[i] = loHead
    }
    if (hiTail) {
      hiTail.next = null
      this.buckets[i + oldStorage.length] = hiHead
    }
  }

  getKeys(): Vector<K> {
    const keys = new Vector<K>(this.size_)
    for (let i = 0; i < this.buckets.length; i += 1) {
      let current = this.buckets[i] as DictEntry<K, V> | null
      while (current) {
        keys.append(current.key)
        current = current.next
      }
    }
    return keys
  }
}

class DictIdEntry<K, V> extends DictEntry<K, V> {
  match(hash: number, key: K): boolean {
    return this.hash === hash && this.key === key
  }
}

class IdentityDictionary<K extends Sym, V> extends Dictionary<K, V> {
  constructor(size?: number) {
    super(size === undefined ? INITIAL_CAPACITY : size)
  }

  newEntry(key: K, value: V, hash: number): DictEntry<K, V> {
    return new DictIdEntry<K, V>(hash, key, value, null)
  }
}

// ---------------------------------------------------------------- DeltaBlue

class Plan extends Vector<AbstractConstraint> {
  constructor() {
    super(15)
  }

  execute(): void {
    this.forEach((c: AbstractConstraint): void => c.execute())
  }
}

class Sym {
  hash: number
  constructor(hash: number) {
    this.hash = hash
  }

  customHash(): number {
    return this.hash
  }
}

const ABSOLUTE_STRONGEST = new Sym(0)
const REQUIRED = new Sym(1)
const STRONG_PREFERRED = new Sym(2)
const PREFERRED = new Sym(3)
const STRONG_DEFAULT = new Sym(4)
const DEFAULT = new Sym(5)
const WEAK_DEFAULT = new Sym(6)
const ABSOLUTE_WEAKEST = new Sym(7)

function createStrengthTable(): IdentityDictionary<Sym, number> {
  const strengthTable = new IdentityDictionary<Sym, number>()
  strengthTable.atPut(ABSOLUTE_STRONGEST, -10000)
  strengthTable.atPut(REQUIRED, -800)
  strengthTable.atPut(STRONG_PREFERRED, -600)
  strengthTable.atPut(PREFERRED, -400)
  strengthTable.atPut(STRONG_DEFAULT, -200)
  strengthTable.atPut(DEFAULT, 0)
  strengthTable.atPut(WEAK_DEFAULT, 500)
  strengthTable.atPut(ABSOLUTE_WEAKEST, 10000)
  return strengthTable
}

class Strength {
  arithmeticValue: number

  constructor(symbolicValue: Sym) {
    this.arithmeticValue = Strength.strengthTable.at(symbolicValue) as number
  }

  sameAs(s: Strength): boolean {
    return this.arithmeticValue === s.arithmeticValue
  }

  stronger(s: Strength): boolean {
    return this.arithmeticValue < s.arithmeticValue
  }

  weaker(s: Strength): boolean {
    return this.arithmeticValue > s.arithmeticValue
  }

  strongest(s: Strength): Strength {
    return s.stronger(this) ? s : this
  }

  weakest(s: Strength): Strength {
    return s.weaker(this) ? s : this
  }

  static of(strength: Sym): Strength {
    return Strength.strengthConstant.at(strength) as Strength
  }

  static strengthTable: IdentityDictionary<Sym, number> = createStrengthTable()

  static createStrengthConstants(): IdentityDictionary<Sym, Strength> {
    const strengthConstant = new IdentityDictionary<Sym, Strength>()
    Strength.strengthTable.getKeys().forEach((key: Sym): void => {
      strengthConstant.atPut(key, new Strength(key))
    })
    return strengthConstant
  }

  static strengthConstant: IdentityDictionary<Sym, Strength> = Strength.createStrengthConstants()

  static absoluteWeakest: Strength = Strength.of(ABSOLUTE_WEAKEST)

  static required: Strength = Strength.of(REQUIRED)
}

type Direction = 'forward' | 'backward' | null

abstract class AbstractConstraint {
  strength: Strength

  constructor(strengthSym: Sym) {
    this.strength = Strength.of(strengthSym)
  }

  isInput(): boolean {
    return false
  }

  abstract isSatisfied(): boolean
  abstract addToGraph(): void
  abstract removeFromGraph(): void
  abstract chooseMethod(mark: number): Direction
  abstract inputsDo(fn: (v: Variable) => void): void
  abstract inputsHasOne(fn: (v: Variable) => boolean): boolean
  abstract markUnsatisfied(): void
  abstract getOutput(): Variable
  abstract recalculate(): void
  abstract execute(): void

  addConstraint(planner: Planner): void {
    this.addToGraph()
    planner.incrementalAdd(this)
  }

  destroyConstraint(planner: Planner): void {
    if (this.isSatisfied()) {
      planner.incrementalRemove(this)
    }
    this.removeFromGraph()
  }

  inputsKnown(mark: number): boolean {
    return !this.inputsHasOne((v: Variable): boolean => !(v.mark === mark || v.stay || v.determinedBy === null))
  }

  satisfy(mark: number, planner: Planner): AbstractConstraint | null {
    let overridden: AbstractConstraint | null
    this.chooseMethod(mark)

    if (this.isSatisfied()) {
      this.inputsDo((i: Variable): void => {
        i.mark = mark
      })

      const out = this.getOutput()
      overridden = out.determinedBy
      if (overridden !== null) {
        overridden.markUnsatisfied()
      }
      out.determinedBy = this
      if (!planner.addPropagate(this, mark)) {
        throw new Error('Cycle encountered')
      }
      out.mark = mark
    } else {
      overridden = null
      if (this.strength.sameAs(Strength.required)) {
        throw new Error('Could not satisfy a required constraint')
      }
    }
    return overridden
  }
}

abstract class BinaryConstraint extends AbstractConstraint {
  v1: Variable
  v2: Variable
  direction: Direction

  constructor(var1: Variable, var2: Variable, strength: Sym, planner: Planner) {
    super(strength)
    this.v1 = var1
    this.v2 = var2
    this.direction = null
  }

  isSatisfied(): boolean {
    return this.direction !== null
  }

  addToGraph(): void {
    this.v1.addConstraint(this)
    this.v2.addConstraint(this)
    this.direction = null
  }

  removeFromGraph(): void {
    if (this.v1 !== null) {
      this.v1.removeConstraint(this)
    }
    if (this.v2 !== null) {
      this.v2.removeConstraint(this)
    }
    this.direction = null
  }

  chooseMethod(mark: number): Direction {
    if (this.v1.mark === mark) {
      if (this.v2.mark !== mark && this.strength.stronger(this.v2.walkStrength)) {
        this.direction = 'forward'
        return this.direction
      }
      this.direction = null
      return this.direction
    }

    if (this.v2.mark === mark) {
      if (this.v1.mark !== mark && this.strength.stronger(this.v1.walkStrength)) {
        this.direction = 'backward'
        return this.direction
      }
      this.direction = null
      return this.direction
    }

    if (this.v1.walkStrength.weaker(this.v2.walkStrength)) {
      if (this.strength.stronger(this.v1.walkStrength)) {
        this.direction = 'backward'
        return this.direction
      }
      this.direction = null
      return this.direction
    }
    if (this.strength.stronger(this.v2.walkStrength)) {
      this.direction = 'forward'
      return this.direction
    }
    this.direction = null
    return this.direction
  }

  inputsDo(fn: (v: Variable) => void): void {
    if (this.direction === 'forward') {
      fn(this.v1)
    } else {
      fn(this.v2)
    }
  }

  inputsHasOne(fn: (v: Variable) => boolean): boolean {
    if (this.direction === 'forward') {
      return fn(this.v1)
    }
    return fn(this.v2)
  }

  markUnsatisfied(): void {
    this.direction = null
  }

  getOutput(): Variable {
    return this.direction === 'forward' ? this.v2 : this.v1
  }

  recalculate(): void {
    let ihn: Variable
    let out: Variable

    if (this.direction === 'forward') {
      ihn = this.v1
      out = this.v2
    } else {
      ihn = this.v2
      out = this.v1
    }

    out.walkStrength = this.strength.weakest(ihn.walkStrength)
    out.stay = ihn.stay
    if (out.stay) {
      this.execute()
    }
  }
}

abstract class UnaryConstraint extends AbstractConstraint {
  output: Variable
  satisfied: boolean

  constructor(v: Variable, strength: Sym, planner: Planner) {
    super(strength)
    this.output = v
    this.satisfied = false

    this.addConstraint(planner)
  }

  isSatisfied(): boolean {
    return this.satisfied
  }

  addToGraph(): void {
    this.output.addConstraint(this)
    this.satisfied = false
  }

  removeFromGraph(): void {
    if (this.output !== null) {
      this.output.removeConstraint(this)
    }
    this.satisfied = false
  }

  chooseMethod(mark: number): Direction {
    this.satisfied = this.output.mark !== mark && this.strength.stronger(this.output.walkStrength)
    return null
  }

  inputsDo(fn: (v: Variable) => void): void {}

  inputsHasOne(fn: (v: Variable) => boolean): boolean {
    return false
  }

  markUnsatisfied(): void {
    this.satisfied = false
  }

  getOutput(): Variable {
    return this.output
  }

  recalculate(): void {
    this.output.walkStrength = this.strength
    this.output.stay = !this.isInput()
    if (this.output.stay) {
      this.execute()
    }
  }
}

class EditConstraint extends UnaryConstraint {
  isInput(): boolean {
    return true
  }

  execute(): void {}
}

class EqualityConstraint extends BinaryConstraint {
  constructor(var1: Variable, var2: Variable, strength: Sym, planner: Planner) {
    super(var1, var2, strength, planner)
    this.addConstraint(planner)
  }

  execute(): void {
    if (this.direction === 'forward') {
      this.v2.value = this.v1.value
    } else {
      this.v1.value = this.v2.value
    }
  }
}

class ScaleConstraint extends BinaryConstraint {
  scale: Variable
  offset: Variable

  constructor(src: Variable, scale: Variable, offset: Variable, dest: Variable, strength: Sym, planner: Planner) {
    super(src, dest, strength, planner)
    this.scale = scale
    this.offset = offset

    this.addConstraint(planner)
  }

  addToGraph(): void {
    this.v1.addConstraint(this)
    this.v2.addConstraint(this)
    this.scale.addConstraint(this)
    this.offset.addConstraint(this)
    this.direction = null
  }

  removeFromGraph(): void {
    if (this.v1 !== null) {
      this.v1.removeConstraint(this)
    }
    if (this.v2 !== null) {
      this.v2.removeConstraint(this)
    }
    if (this.scale !== null) {
      this.scale.removeConstraint(this)
    }
    if (this.offset !== null) {
      this.offset.removeConstraint(this)
    }
    this.direction = null
  }

  execute(): void {
    if (this.direction === 'forward') {
      this.v2.value = this.v1.value * this.scale.value + this.offset.value
    } else {
      this.v1.value = (this.v2.value - this.offset.value) / this.scale.value
    }
  }

  inputsDo(fn: (v: Variable) => void): void {
    if (this.direction === 'forward') {
      fn(this.v1)
      fn(this.scale)
      fn(this.offset)
    } else {
      fn(this.v2)
      fn(this.scale)
      fn(this.offset)
    }
  }

  recalculate(): void {
    let ihn: Variable
    let out: Variable

    if (this.direction === 'forward') {
      ihn = this.v1
      out = this.v2
    } else {
      out = this.v1
      ihn = this.v2
    }

    out.walkStrength = this.strength.weakest(ihn.walkStrength)
    out.stay = ihn.stay && this.scale.stay && this.offset.stay
    if (out.stay) {
      this.execute()
    }
  }
}

class StayConstraint extends UnaryConstraint {
  execute(): void {}
}

class Variable {
  value: number
  constraints: Vector<AbstractConstraint>
  determinedBy: AbstractConstraint | null
  walkStrength: Strength
  stay: boolean
  mark: number

  constructor() {
    this.value = 0
    this.constraints = new Vector<AbstractConstraint>(2)
    this.determinedBy = null
    this.walkStrength = Strength.absoluteWeakest
    this.stay = true
    this.mark = 0
  }

  addConstraint(c: AbstractConstraint): void {
    this.constraints.append(c)
  }

  removeConstraint(c: AbstractConstraint): void {
    this.constraints.remove(c)
    if (this.determinedBy === c) {
      this.determinedBy = null
    }
  }

  static value(aValue: number): Variable {
    const v = new Variable()
    v.value = aValue
    return v
  }
}

class Planner {
  currentMark: number

  constructor() {
    this.currentMark = 1
  }

  newMark(): number {
    this.currentMark += 1
    return this.currentMark
  }

  incrementalAdd(c: AbstractConstraint): void {
    const mark = this.newMark()
    let overridden = c.satisfy(mark, this)

    while (overridden !== null) {
      overridden = overridden.satisfy(mark, this)
    }
  }

  incrementalRemove(c: AbstractConstraint): void {
    const out = c.getOutput()
    c.markUnsatisfied()
    c.removeFromGraph()

    const unsatisfied = this.removePropagateFrom(out)
    unsatisfied.forEach((u: AbstractConstraint): void => this.incrementalAdd(u))
  }

  extractPlanFromConstraints(constraints: Vector<AbstractConstraint>): Plan {
    const sources = new Vector<AbstractConstraint>()

    constraints.forEach((c: AbstractConstraint): void => {
      if (c.isInput() && c.isSatisfied()) {
        sources.append(c)
      }
    })

    return this.makePlan(sources)
  }

  makePlan(sources: Vector<AbstractConstraint>): Plan {
    const mark = this.newMark()
    const plan = new Plan()
    const todo = sources

    while (!todo.isEmpty()) {
      const c = todo.removeFirst() as AbstractConstraint

      if (c.getOutput().mark !== mark && c.inputsKnown(mark)) {
        plan.append(c)
        c.getOutput().mark = mark
        this.addConstraintsConsumingTo(c.getOutput(), todo)
      }
    }
    return plan
  }

  addConstraintsConsumingTo(v: Variable, coll: Vector<AbstractConstraint>): void {
    const determiningC = v.determinedBy

    v.constraints.forEach((c: AbstractConstraint): void => {
      if (c !== determiningC && c.isSatisfied()) {
        coll.append(c)
      }
    })
  }

  addPropagate(c: AbstractConstraint, mark: number): boolean {
    const todo = vectorWith<AbstractConstraint>(c)

    while (!todo.isEmpty()) {
      const d = todo.removeFirst() as AbstractConstraint

      if (d.getOutput().mark === mark) {
        this.incrementalRemove(c)
        return false
      }
      d.recalculate()
      this.addConstraintsConsumingTo(d.getOutput(), todo)
    }
    return true
  }

  change(v: Variable, newValue: number): void {
    const editC = new EditConstraint(v, PREFERRED, this)
    const editV = vectorWith<AbstractConstraint>(editC)
    const plan = this.extractPlanFromConstraints(editV)

    for (let i = 0; i < 10; i += 1) {
      v.value = newValue
      plan.execute()
    }
    editC.destroyConstraint(this)
  }

  constraintsConsuming(v: Variable, fn: (c: AbstractConstraint) => void): void {
    const determiningC = v.determinedBy
    v.constraints.forEach((c: AbstractConstraint): void => {
      if (c !== determiningC && c.isSatisfied()) {
        fn(c)
      }
    })
  }

  removePropagateFrom(out: Variable): Vector<AbstractConstraint> {
    const unsatisfied = new Vector<AbstractConstraint>()

    out.determinedBy = null
    out.walkStrength = Strength.absoluteWeakest
    out.stay = true

    const todo = vectorWith<Variable>(out)

    while (!todo.isEmpty()) {
      const v = todo.removeFirst() as Variable

      v.constraints.forEach((c: AbstractConstraint): void => {
        if (!c.isSatisfied()) {
          unsatisfied.append(c)
        }
      })

      this.constraintsConsuming(v, (c: AbstractConstraint): void => {
        c.recalculate()
        todo.append(c.getOutput())
      })
    }

    unsatisfied.sort((c1: AbstractConstraint, c2: AbstractConstraint): boolean => c1.strength.stronger(c2.strength))
    return unsatisfied
  }

  static chainTest(n: number): number {
    const planner = new Planner()
    const vars = new Array<Variable>(n + 1)

    for (let i = 0; i < n + 1; i += 1) {
      vars[i] = new Variable()
    }

    for (let i = 0; i < n; i += 1) {
      const v1 = vars[i] as Variable
      const v2 = vars[i + 1] as Variable
      new EqualityConstraint(v1, v2, REQUIRED, planner)
    }

    new StayConstraint(vars[n] as Variable, STRONG_DEFAULT, planner)

    const editC = new EditConstraint(vars[0] as Variable, PREFERRED, planner)
    const editV = vectorWith<AbstractConstraint>(editC)
    const plan = planner.extractPlanFromConstraints(editV)

    for (let i = 0; i < 100; i += 1) {
      const first = vars[0] as Variable
      first.value = i
      plan.execute()
      if ((vars[n] as Variable).value !== i) {
        throw new Error('Chain test failed!')
      }
    }
    editC.destroyConstraint(planner)
    return planner.currentMark
  }

  static projectionTest(n: number): number {
    const planner = new Planner()
    const dests = new Vector<Variable>()
    const scale = Variable.value(10)
    const offset = Variable.value(1000)

    let src: Variable | null = null
    let dst: Variable | null = null

    for (let i = 1; i <= n; i += 1) {
      src = Variable.value(i)
      dst = Variable.value(i)
      dests.append(dst)
      new StayConstraint(src, DEFAULT, planner)
      new ScaleConstraint(src, scale, offset, dst, REQUIRED, planner)
    }

    planner.change(src as Variable, 17)
    if ((dst as Variable).value !== 1170) {
      throw new Error('Projection test 1 failed!')
    }

    planner.change(dst as Variable, 1050)
    if ((src as Variable).value !== 5) {
      throw new Error('Projection test 2 failed!')
    }

    planner.change(scale, 5)
    for (let i = 0; i < n - 1; i += 1) {
      if ((dests.at(i) as Variable).value !== (i + 1) * 5 + 1000) {
        throw new Error('Projection test 3 failed!')
      }
    }

    planner.change(offset, 2000)
    for (let i = 0; i < n - 1; i += 1) {
      if ((dests.at(i) as Variable).value !== (i + 1) * 5 + 2000) {
        throw new Error('Projection test 4 failed!')
      }
    }
    return planner.currentMark
  }
}

class DeltaBlue {
  marks: number

  constructor() {
    this.marks = 0
  }

  innerBenchmarkLoop(innerIterations: number): boolean {
    this.marks += Planner.chainTest(innerIterations)
    this.marks += Planner.projectionTest(innerIterations)
    return true
  }
}

const REPS: number = 600
const INNER: number = 1000

const bench = new DeltaBlue()
const t0 = Date.now()
let ok = true
for (let r = 0; r < REPS; r += 1) {
  if (!bench.innerBenchmarkLoop(INNER)) {
    ok = false
  }
}
const elapsed = Date.now() - t0
console.log('deltablue ' + elapsed + ' ' + ok + ':' + bench.marks)
