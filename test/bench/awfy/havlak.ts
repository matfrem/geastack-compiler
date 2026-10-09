// Port of the "Are We Fast Yet" Havlak benchmark (typed). Helper collections inlined from som.js
// (Set/IdentitySet renamed SomSet/SomIdentitySet to avoid shadowing the global Set).

const INITIAL_SIZE: number = 10
const INITIAL_CAPACITY: number = 16

class Vector<T> {
  storage: (T | null)[] | null
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

  atPut(idx: number, val: T | null): void {
    if (this.storage === null) {
      this.storage = new Array<T | null>(Math.max(idx + 1, INITIAL_SIZE))
    } else if (idx >= this.storage.length) {
      let newLength: number = this.storage.length
      while (newLength <= idx) {
        newLength *= 2
      }
      this.storage = this.storage.slice()
      this.storage.length = newLength
    }
    this.storage[idx] = val
    if (this.lastIdx < idx + 1) {
      this.lastIdx = idx + 1
    }
  }

  append(elem: T): void {
    if (this.storage === null) {
      this.storage = new Array<T | null>(INITIAL_SIZE)
    } else if (this.lastIdx >= this.storage.length) {
      const newLength: number = this.storage.length * 2
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
    const st: (T | null)[] | null = this.storage
    if (st === null) {
      return
    }
    for (let i: number = this.firstIdx; i < this.lastIdx; i += 1) {
      fn(st[i] as T)
    }
  }

  hasSome(fn: (e: T) => boolean): boolean {
    const st: (T | null)[] | null = this.storage
    if (st === null) {
      return false
    }
    for (let i: number = this.firstIdx; i < this.lastIdx; i += 1) {
      if (fn(st[i] as T)) {
        return true
      }
    }
    return false
  }

  removeFirst(): T | null {
    if (this.isEmpty()) {
      return null
    }
    this.firstIdx += 1
    return (this.storage as (T | null)[])[this.firstIdx - 1] as T | null
  }

  removeAll(): void {
    this.firstIdx = 0
    this.lastIdx = 0
    if (this.storage !== null) {
      this.storage = new Array<T | null>(this.storage.length)
    }
  }

  size(): number {
    return this.lastIdx - this.firstIdx
  }
}

class SomSet<T> {
  items: Vector<T>

  constructor(size?: number) {
    this.items = new Vector<T>(size === undefined ? INITIAL_SIZE : size)
  }

  size(): number {
    return this.items.size()
  }

  forEach(fn: (e: T) => void): void {
    this.items.forEach(fn)
  }

  hasSome(fn: (e: T) => boolean): boolean {
    return this.items.hasSome(fn)
  }

  add(obj: T): void {
    if (!this.contains(obj)) {
      this.items.append(obj)
    }
  }

  contains(obj: T): boolean {
    return this.hasSome((e: T): boolean => e === obj)
  }
}

class SomIdentitySet<T> extends SomSet<T> {
  constructor(size?: number) {
    super(size === undefined ? INITIAL_SIZE : size)
  }

  contains(obj: T): boolean {
    return this.hasSome((e: T): boolean => e === obj)
  }
}

interface Hashable {
  customHash(): number
}

class DictEntry<K extends Hashable, V> {
  hash: number
  key: K | null
  value: V | null
  next: DictEntry<K, V> | null

  constructor(hash: number, key: K | null, value: V | null, next: DictEntry<K, V> | null) {
    this.hash = hash
    this.key = key
    this.value = value
    this.next = next
  }

  match(hash: number, key: K | null): boolean {
    return this.hash === hash && key === this.key
  }
}

function hashFn(key: Hashable | null): number {
  if (!key) {
    return 0
  }
  const hash: number = key.customHash()
  return hash ^ (hash >>> 16)
}

class Dictionary<K extends Hashable, V> {
  buckets: (DictEntry<K, V> | null)[]
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

  at(key: K | null): V | null {
    const hash_: number = hashFn(key)
    let e: DictEntry<K, V> | null = this.getBucket(hash_)

    while (e) {
      if (e.match(hash_, key)) {
        return e.value
      }
      e = e.next
    }
    return null
  }

  atPut(key: K | null, value: V | null): void {
    const hash_: number = hashFn(key)
    const i: number = this.getBucketIdx(hash_)
    const current: DictEntry<K, V> | null = this.buckets[i] as DictEntry<K, V> | null

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

  newEntry(key: K | null, value: V | null, hash: number): DictEntry<K, V> {
    return new DictEntry<K, V>(hash, key, value, null)
  }

  insertBucketEntry(key: K | null, value: V | null, hash: number, head: DictEntry<K, V>): void {
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
    const oldStorage: (DictEntry<K, V> | null)[] = this.buckets
    this.buckets = new Array<DictEntry<K, V> | null>(oldStorage.length * 2)
    this.transferEntries(oldStorage)
  }

  transferEntries(oldStorage: (DictEntry<K, V> | null)[]): void {
    for (let i: number = 0; i < oldStorage.length; i += 1) {
      const current: DictEntry<K, V> | null = oldStorage[i] as DictEntry<K, V> | null
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

  splitBucket(oldStorage: (DictEntry<K, V> | null)[], i: number, head: DictEntry<K, V>): void {
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

  removeAll(): void {
    this.buckets = new Array<DictEntry<K, V> | null>(this.buckets.length)
    this.size_ = 0
  }
}

class DictIdEntry<K extends Hashable, V> extends DictEntry<K, V> {
  match(hash: number, key: K | null): boolean {
    return this.hash === hash && this.key === key
  }
}

class IdentityDictionary<K extends Hashable, V> extends Dictionary<K, V> {
  constructor(size?: number) {
    super(size === undefined ? INITIAL_CAPACITY : size)
  }

  newEntry(key: K | null, value: V | null, hash: number): DictEntry<K, V> {
    return new DictIdEntry<K, V>(hash, key, value, null)
  }
}

// ---------------------------------------------------------------- Havlak

class BasicBlock {
  name: number
  inEdges: Vector<BasicBlock>
  outEdges: Vector<BasicBlock>

  constructor(name: number) {
    this.name = name
    this.inEdges = new Vector<BasicBlock>(2)
    this.outEdges = new Vector<BasicBlock>(2)
  }

  getInEdges(): Vector<BasicBlock> {
    return this.inEdges
  }

  getOutEdges(): Vector<BasicBlock> {
    return this.outEdges
  }

  getNumPred(): number {
    return this.inEdges.size()
  }

  addOutEdge(to: BasicBlock): void {
    this.outEdges.append(to)
  }

  addInEdge(from: BasicBlock): void {
    this.inEdges.append(from)
  }

  customHash(): number {
    return this.name
  }
}

class BasicBlockEdge {
  from: BasicBlock
  to: BasicBlock

  constructor(cfg: ControlFlowGraph, fromName: number, toName: number) {
    this.from = cfg.createNode(fromName)
    this.to = cfg.createNode(toName)

    this.from.addOutEdge(this.to)
    this.to.addInEdge(this.from)

    cfg.addEdge(this)
  }
}

class ControlFlowGraph {
  startNode: BasicBlock | null
  basicBlockMap: Vector<BasicBlock>
  edgeList: Vector<BasicBlockEdge>

  constructor() {
    this.startNode = null
    this.basicBlockMap = new Vector<BasicBlock>()
    this.edgeList = new Vector<BasicBlockEdge>()
  }

  createNode(name: number): BasicBlock {
    let node: BasicBlock
    const existing: BasicBlock | null = this.basicBlockMap.at(name)
    if (existing) {
      node = existing
    } else {
      node = new BasicBlock(name)
      this.basicBlockMap.atPut(name, node)
    }

    if (this.getNumNodes() === 1) {
      this.startNode = node
    }
    return node
  }

  addEdge(edge: BasicBlockEdge): void {
    this.edgeList.append(edge)
  }

  getNumNodes(): number {
    return this.basicBlockMap.size()
  }

  getStartBasicBlock(): BasicBlock | null {
    return this.startNode
  }

  getBasicBlocks(): Vector<BasicBlock> {
    return this.basicBlockMap
  }
}

class SimpleLoop {
  isReducible: boolean
  parent: SimpleLoop | null
  isRoot_: boolean
  nestingLevel: number
  depthLevel: number
  counter: number
  basicBlocks: SomIdentitySet<BasicBlock>
  children: SomIdentitySet<SimpleLoop>
  header: BasicBlock | null

  constructor(bb: BasicBlock | null, isReducible: boolean) {
    this.isReducible = isReducible
    this.parent = null
    this.isRoot_ = false
    this.nestingLevel = 0
    this.depthLevel = 0
    this.counter = 0
    this.basicBlocks = new SomIdentitySet<BasicBlock>()
    this.children = new SomIdentitySet<SimpleLoop>()

    if (bb) {
      this.basicBlocks.add(bb)
    }
    this.header = bb
  }

  addNode(bb: BasicBlock): void {
    this.basicBlocks.add(bb)
  }

  addChildLoop(loop: SimpleLoop): void {
    this.children.add(loop)
  }

  getChildren(): SomIdentitySet<SimpleLoop> {
    return this.children
  }

  getParent(): SimpleLoop | null {
    return this.parent
  }

  getNestingLevel(): number {
    return this.nestingLevel
  }

  isRoot(): boolean {
    return this.isRoot_
  }

  setParent(parent: SimpleLoop): void {
    this.parent = parent
    parent.addChildLoop(this)
  }

  setIsRoot(): void {
    this.isRoot_ = true
  }

  setCounter(value: number): void {
    this.counter = value
  }

  setNestingLevel(level: number): void {
    this.nestingLevel = level
    if (level === 0) {
      this.setIsRoot()
    }
  }

  setDepthLevel(level: number): void {
    this.depthLevel = level
  }
}

class LoopStructureGraph {
  loopCounter: number
  loops: Vector<SimpleLoop>
  root: SimpleLoop

  constructor() {
    this.loopCounter = 0
    this.loops = new Vector<SimpleLoop>()
    this.root = new SimpleLoop(null, true)
    this.root.setNestingLevel(0)
    this.root.setCounter(this.loopCounter)
    this.loopCounter += 1
    this.loops.append(this.root)
  }

  createNewLoop(bb: BasicBlock, isReducible: boolean): SimpleLoop {
    const loop: SimpleLoop = new SimpleLoop(bb, isReducible)
    loop.setCounter(this.loopCounter)
    this.loopCounter += 1
    this.loops.append(loop)
    return loop
  }

  calculateNestingLevel(): void {
    this.loops.forEach((liter: SimpleLoop): void => {
      if (!liter.isRoot()) {
        if (!liter.getParent()) {
          liter.setParent(this.root)
        }
      }
    })

    this.calculateNestingLevelRec(this.root, 0)
  }

  calculateNestingLevelRec(loop: SimpleLoop, depth: number): void {
    loop.setDepthLevel(depth)
    loop.getChildren().forEach((liter: SimpleLoop): void => {
      this.calculateNestingLevelRec(liter, depth + 1)

      loop.setNestingLevel(Math.max(loop.getNestingLevel(), 1 + liter.getNestingLevel()))
    })
  }

  getNumLoops(): number {
    return this.loops.size()
  }
}

class UnionFindNode {
  parent: UnionFindNode = this
  bb: BasicBlock | null = null
  dfsNumber: number = 0
  loop: SimpleLoop | null = null

  initNode(bb: BasicBlock, dfsNumber: number): void {
    this.parent = this
    this.bb = bb
    this.dfsNumber = dfsNumber
    this.loop = null
  }

  findSet(): UnionFindNode {
    const nodeList: Vector<UnionFindNode> = new Vector<UnionFindNode>()
    let node: UnionFindNode = this

    while (node !== node.parent) {
      if (node.parent !== node.parent.parent) {
        nodeList.append(node)
      }
      node = node.parent
    }

    nodeList.forEach((iter: UnionFindNode): void => iter.union(this.parent))
    return node
  }

  union(basicBlock: UnionFindNode): void {
    this.parent = basicBlock
  }

  getBb(): BasicBlock | null {
    return this.bb
  }

  getLoop(): SimpleLoop | null {
    return this.loop
  }

  getDfsNumber(): number {
    return this.dfsNumber
  }

  setLoop(loop: SimpleLoop): void {
    this.loop = loop
  }
}

const UNVISITED: number = 2147483647
const MAXNONBACKPREDS: number = 32 * 1024

type BlockType = 'BB_TOP' | 'BB_NONHEADER' | 'BB_REDUCIBLE' | 'BB_SELF' | 'BB_IRREDUCIBLE' | 'BB_DEAD'

class HavlakLoopFinder {
  nonBackPreds: Vector<SomSet<number>>
  backPreds: Vector<Vector<number>>
  number: IdentityDictionary<BasicBlock, number>
  maxSize: number

  header: number[]
  type: BlockType[]
  last: number[]
  nodes: UnionFindNode[]

  cfg: ControlFlowGraph
  lsg: LoopStructureGraph

  constructor(cfg: ControlFlowGraph, lsg: LoopStructureGraph) {
    this.nonBackPreds = new Vector<SomSet<number>>()
    this.backPreds = new Vector<Vector<number>>()
    this.number = new IdentityDictionary<BasicBlock, number>()
    this.maxSize = 0

    // original starts these as null; empty arrays here keep the field types non-nullable
    this.header = []
    this.type = []
    this.last = []
    this.nodes = []

    this.cfg = cfg
    this.lsg = lsg
  }

  isAncestor(w: number, v: number): boolean {
    return w <= v && v <= (this.last[w] as number)
  }

  doDFS(currentNode: BasicBlock, current: number): number {
    ;(this.nodes[current] as UnionFindNode).initNode(currentNode, current)
    this.number.atPut(currentNode, current)

    let lastId: number = current
    const outerBlocks: Vector<BasicBlock> = currentNode.getOutEdges()

    for (let i: number = 0; i < outerBlocks.size(); i += 1) {
      const target: BasicBlock = outerBlocks.at(i) as BasicBlock
      if (this.number.at(target) === UNVISITED) {
        lastId = this.doDFS(target, lastId + 1)
      }
    }

    this.last[current] = lastId
    return lastId
  }

  initAllNodes(): void {
    this.cfg.getBasicBlocks().forEach((bb: BasicBlock): void => {
      this.number.atPut(bb, UNVISITED)
    })

    this.doDFS(this.cfg.getStartBasicBlock() as BasicBlock, 0)
  }

  identifyEdges(size: number): void {
    for (let w: number = 0; w < size; w += 1) {
      this.header[w] = 0
      this.type[w] = 'BB_NONHEADER'

      const nodeW: BasicBlock | null = (this.nodes[w] as UnionFindNode).getBb()
      if (!nodeW) {
        this.type[w] = 'BB_DEAD'
      } else {
        this.processEdges(nodeW, w)
      }
    }
  }

  processEdges(nodeW: BasicBlock, w: number): void {
    if (nodeW.getNumPred() > 0) {
      nodeW.getInEdges().forEach((nodeV: BasicBlock): void => {
        const v: number = this.number.at(nodeV) as number
        if (v !== UNVISITED) {
          if (this.isAncestor(w, v)) {
            ;(this.backPreds.at(w) as Vector<number>).append(v)
          } else {
            ;(this.nonBackPreds.at(w) as SomSet<number>).add(v)
          }
        }
      })
    }
  }

  findLoops(): void {
    if (!this.cfg.getStartBasicBlock()) {
      return
    }

    const size: number = this.cfg.getNumNodes()

    this.nonBackPreds.removeAll()
    this.backPreds.removeAll()
    this.number.removeAll()
    if (size > this.maxSize) {
      this.header = new Array<number>(size)
      this.type = new Array<BlockType>(size)
      this.last = new Array<number>(size)
      this.nodes = new Array<UnionFindNode>(size)
      this.maxSize = size
    }

    for (let i: number = 0; i < size; i += 1) {
      this.nonBackPreds.append(new SomSet<number>())
      this.backPreds.append(new Vector<number>())
      this.nodes[i] = new UnionFindNode()
    }

    this.initAllNodes()
    this.identifyEdges(size)

    this.header[0] = 0

    for (let w: number = size - 1; w >= 0; w -= 1) {
      const nodePool: Vector<UnionFindNode> = new Vector<UnionFindNode>()

      const nodeW: BasicBlock | null = (this.nodes[w] as UnionFindNode).getBb()
      if (nodeW) {
        this.stepD(w, nodePool)

        const workList: Vector<UnionFindNode> = new Vector<UnionFindNode>()
        nodePool.forEach((niter: UnionFindNode): void => workList.append(niter))

        if (nodePool.size() !== 0) {
          this.type[w] = 'BB_REDUCIBLE'
        }

        while (!workList.isEmpty()) {
          const x: UnionFindNode = workList.removeFirst() as UnionFindNode

          const nonBackSize: number = (this.nonBackPreds.at(x.getDfsNumber()) as SomSet<number>).size()
          if (nonBackSize > MAXNONBACKPREDS) {
            return
          }
          this.stepEProcessNonBackPreds(w, nodePool, workList, x)
        }

        if (nodePool.size() > 0 || this.type[w] === 'BB_SELF') {
          const loop: SimpleLoop = this.lsg.createNewLoop(nodeW, this.type[w] !== 'BB_IRREDUCIBLE')
          this.setLoopAttributes(w, nodePool, loop)
        }
      }
    }
  }

  stepEProcessNonBackPreds(w: number, nodePool: Vector<UnionFindNode>, workList: Vector<UnionFindNode>, x: UnionFindNode): void {
    ;(this.nonBackPreds.at(x.getDfsNumber()) as SomSet<number>).forEach((iter: number): void => {
      const y: UnionFindNode = this.nodes[iter] as UnionFindNode
      const ydash: UnionFindNode = y.findSet()

      if (!this.isAncestor(w, ydash.getDfsNumber())) {
        this.type[w] = 'BB_IRREDUCIBLE'
        ;(this.nonBackPreds.at(w) as SomSet<number>).add(ydash.getDfsNumber())
      } else if (ydash.getDfsNumber() !== w) {
        if (!nodePool.hasSome((e: UnionFindNode): boolean => e === ydash)) {
          workList.append(ydash)
          nodePool.append(ydash)
        }
      }
    })
  }

  setLoopAttributes(w: number, nodePool: Vector<UnionFindNode>, loop: SimpleLoop): void {
    ;(this.nodes[w] as UnionFindNode).setLoop(loop)

    nodePool.forEach((node: UnionFindNode): void => {
      this.header[node.getDfsNumber()] = w
      node.union(this.nodes[w] as UnionFindNode)

      const nodeLoop: SimpleLoop | null = node.getLoop()
      if (nodeLoop) {
        nodeLoop.setParent(loop)
      } else {
        loop.addNode(node.getBb() as BasicBlock)
      }
    })
  }

  stepD(w: number, nodePool: Vector<UnionFindNode>): void {
    ;(this.backPreds.at(w) as Vector<number>).forEach((v: number): void => {
      if (v !== w) {
        nodePool.append((this.nodes[v] as UnionFindNode).findSet())
      } else {
        this.type[w] = 'BB_SELF'
      }
    })
  }
}

class LoopTesterApp {
  cfg: ControlFlowGraph
  lsg: LoopStructureGraph

  constructor() {
    this.cfg = new ControlFlowGraph()
    this.lsg = new LoopStructureGraph()
    this.cfg.createNode(0)
  }

  buildDiamond(start: number): number {
    const bb0: number = start
    new BasicBlockEdge(this.cfg, bb0, bb0 + 1)
    new BasicBlockEdge(this.cfg, bb0, bb0 + 2)
    new BasicBlockEdge(this.cfg, bb0 + 1, bb0 + 3)
    new BasicBlockEdge(this.cfg, bb0 + 2, bb0 + 3)

    return bb0 + 3
  }

  buildConnect(start: number, end: number): void {
    new BasicBlockEdge(this.cfg, start, end)
  }

  buildStraight(start: number, n: number): number {
    for (let i: number = 0; i < n; i += 1) {
      this.buildConnect(start + i, start + i + 1)
    }
    return start + n
  }

  buildBaseLoop(from: number): number {
    const header: number = this.buildStraight(from, 1)
    const diamond1: number = this.buildDiamond(header)
    const d11: number = this.buildStraight(diamond1, 1)
    const diamond2: number = this.buildDiamond(d11)

    let footer: number = this.buildStraight(diamond2, 1)
    this.buildConnect(diamond2, d11)
    this.buildConnect(diamond1, header)

    this.buildConnect(footer, from)
    footer = this.buildStraight(footer, 1)
    return footer
  }

  main(numDummyLoops: number, findLoopIterations: number, parLoops: number, pparLoops: number, ppparLoops: number): number[] {
    this.constructSimpleCFG()
    this.addDummyLoops(numDummyLoops)
    this.constructCFG(parLoops, pparLoops, ppparLoops)

    this.findLoops(this.lsg)
    for (let i: number = 0; i < findLoopIterations; i += 1) {
      this.findLoops(new LoopStructureGraph())
    }

    this.lsg.calculateNestingLevel()
    return [this.lsg.getNumLoops(), this.cfg.getNumNodes()]
  }

  constructCFG(parLoops: number, pparLoops: number, ppparLoops: number): void {
    let n: number = 2

    for (let parlooptrees: number = 0; parlooptrees < parLoops; parlooptrees += 1) {
      this.cfg.createNode(n + 1)
      this.buildConnect(2, n + 1)
      n += 1

      for (let i: number = 0; i < pparLoops; i += 1) {
        const top: number = n
        n = this.buildStraight(n, 1)
        for (let j: number = 0; j < ppparLoops; j += 1) {
          n = this.buildBaseLoop(n)
        }
        const bottom: number = this.buildStraight(n, 1)
        this.buildConnect(n, top)
        n = bottom
      }
      this.buildConnect(n, 1)
    }
  }

  addDummyLoops(numDummyLoops: number): void {
    for (let dummyloop: number = 0; dummyloop < numDummyLoops; dummyloop += 1) {
      this.findLoops(this.lsg)
    }
  }

  findLoops(loopStructure: LoopStructureGraph): void {
    const finder: HavlakLoopFinder = new HavlakLoopFinder(this.cfg, loopStructure)
    finder.findLoops()
  }

  constructSimpleCFG(): void {
    this.cfg.createNode(0)
    this.buildBaseLoop(0)
    this.cfg.createNode(1)
    new BasicBlockEdge(this.cfg, 0, 2)
  }
}

function verifyResult(result: number[], innerIterations: number): boolean {
  const loops: number = result[0] as number
  const nodes: number = result[1] as number
  if (innerIterations === 15000) {
    return loops === 46602 && nodes === 5213
  }
  if (innerIterations === 1500) {
    return loops === 6102 && nodes === 5213
  }
  if (innerIterations === 150) {
    return loops === 2052 && nodes === 5213
  }
  if (innerIterations === 15) {
    return loops === 1647 && nodes === 5213
  }
  if (innerIterations === 1) {
    return loops === 1605 && nodes === 5213
  }
  return false
}

function benchmark(innerIterations: number): boolean {
  return verifyResult(new LoopTesterApp().main(innerIterations, 50, 10, 10, 5), innerIterations)
}

const INNER: number = 15
const REPS: number = 8

const start: number = Date.now()
let allOk: boolean = true
for (let r: number = 0; r < REPS; r += 1) {
  if (!benchmark(INNER)) {
    allOk = false
  }
}
const elapsed: number = Date.now() - start
console.log('havlak ' + elapsed + ' ' + allOk + ':' + INNER + 'x' + REPS)
