// Port of the Are-We-Fast-Yet Richards benchmark (typed, self-contained).
const IDLER: number = 0
const WORKER: number = 1
const HANDLER_A: number = 2
const HANDLER_B: number = 3
const DEVICE_A: number = 4
const DEVICE_B: number = 5
const NUM_TYPES: number = 6

const DEVICE_PACKET_KIND: number = 0
const WORK_PACKET_KIND: number = 1

const DATA_SIZE: number = 4

type TaskFn = (work: Packet | null, word: RBObject) => TaskControlBlock | null

class RBObject {
  append(packet: Packet, queueHead: Packet | null): Packet {
    packet.link = null
    if (null === queueHead) {
      return packet
    }

    let mouse: Packet = queueHead
    let link: Packet | null

    while (null !== (link = mouse.link)) {
      mouse = link
    }
    mouse.link = packet
    return queueHead
  }
}

class TaskState extends RBObject {
  packetPending_: boolean
  taskWaiting_: boolean
  taskHolding_: boolean

  constructor() {
    super()
    this.packetPending_ = false
    this.taskWaiting_ = false
    this.taskHolding_ = false
  }

  isPacketPending(): boolean {
    return this.packetPending_
  }

  isTaskHolding(): boolean {
    return this.taskHolding_
  }

  isTaskWaiting(): boolean {
    return this.taskWaiting_
  }

  setTaskHolding(b: boolean): void {
    this.taskHolding_ = b
  }

  setTaskWaiting(b: boolean): void {
    this.taskWaiting_ = b
  }

  setPacketPending(b: boolean): void {
    this.packetPending_ = b
  }

  packetPending(): void {
    this.packetPending_ = true
    this.taskWaiting_ = false
    this.taskHolding_ = false
  }

  running(): void {
    this.packetPending_ = false
    this.taskWaiting_ = false
    this.taskHolding_ = false
  }

  waiting(): void {
    this.packetPending_ = false
    this.taskHolding_ = false
    this.taskWaiting_ = true
  }

  waitingWithPacket(): void {
    this.taskHolding_ = false
    this.taskWaiting_ = true
    this.packetPending_ = true
  }

  isTaskHoldingOrWaiting(): boolean {
    return this.taskHolding_ || (!this.packetPending_ && this.taskWaiting_)
  }

  isWaitingWithPacket(): boolean {
    return this.packetPending_ && this.taskWaiting_ && !this.taskHolding_
  }

  static createRunning(): TaskState {
    const t = new TaskState()
    t.running()
    return t
  }

  static createWaiting(): TaskState {
    const t = new TaskState()
    t.waiting()
    return t
  }

  static createWaitingWithPacket(): TaskState {
    const t = new TaskState()
    t.waitingWithPacket()
    return t
  }
}

class DeviceTaskDataRecord extends RBObject {
  pending: Packet | null

  constructor() {
    super()
    this.pending = null
  }
}

class HandlerTaskDataRecord extends RBObject {
  workIn: Packet | null
  deviceIn: Packet | null

  constructor() {
    super()
    this.workIn = null
    this.deviceIn = null
  }

  deviceInAdd(packet: Packet): void {
    this.deviceIn = this.append(packet, this.deviceIn)
  }

  workInAdd(packet: Packet): void {
    this.workIn = this.append(packet, this.workIn)
  }
}

class IdleTaskDataRecord extends RBObject {
  control: number
  count: number

  constructor() {
    super()
    this.control = 1
    this.count = 10000
  }
}

class Packet extends RBObject {
  link: Packet | null
  identity: number
  kind: number
  datum: number
  data: number[]

  constructor(link: Packet | null, identity: number, kind: number) {
    super()
    this.link = link
    this.identity = identity
    this.kind = kind
    this.datum = 0
    this.data = new Array<number>(DATA_SIZE).fill(0)
  }
}

class TaskControlBlock extends TaskState {
  link: TaskControlBlock | null
  identity: number
  priority: number
  input: Packet | null
  handle: RBObject
  fn: TaskFn

  constructor(
    link: TaskControlBlock | null,
    identity: number,
    priority: number,
    initialWorkQueue: Packet | null,
    initialState: TaskState,
    privateData: RBObject,
    fn: TaskFn
  ) {
    super()
    this.link = link
    this.identity = identity
    this.priority = priority
    this.input = initialWorkQueue
    this.setPacketPending(initialState.isPacketPending())
    this.setTaskWaiting(initialState.isTaskWaiting())
    this.setTaskHolding(initialState.isTaskHolding())
    this.handle = privateData
    this.fn = fn
  }

  addInputAndCheckPriority(packet: Packet, oldTask: TaskControlBlock): TaskControlBlock {
    if (null === this.input) {
      this.input = packet
      this.setPacketPending(true)
      if (this.priority > oldTask.priority) {
        return this
      }
    } else {
      this.input = this.append(packet, this.input)
    }
    return oldTask
  }

  runTask(): TaskControlBlock | null {
    let message: Packet | null
    if (this.isWaitingWithPacket()) {
      message = this.input as Packet
      this.input = message.link
      if (null === this.input) {
        this.running()
      } else {
        this.packetPending()
      }
    } else {
      message = null
    }
    return this.fn(message, this.handle)
  }
}

class WorkerTaskDataRecord extends RBObject {
  destination: number
  count: number

  constructor() {
    super()
    this.destination = HANDLER_A
    this.count = 0
  }
}

class Scheduler extends RBObject {
  layout: number
  queuePacketCount: number
  holdCount: number
  taskTable: (TaskControlBlock | null)[]
  taskList: TaskControlBlock | null
  currentTask: TaskControlBlock | null
  currentTaskIdentity: number

  constructor() {
    super()

    this.layout = 0

    this.queuePacketCount = 0
    this.holdCount = 0
    this.taskTable = new Array<TaskControlBlock | null>(NUM_TYPES).fill(null)
    this.taskList = null

    this.currentTask = null
    this.currentTaskIdentity = 0
  }

  createDevice(identity: number, priority: number, workPacket: Packet | null, state: TaskState): void {
    const data = new DeviceTaskDataRecord()

    this.createTask(identity, priority, workPacket, state, data, (workArg: Packet | null, wordArg: RBObject): TaskControlBlock | null => {
      const dataRecord = wordArg as DeviceTaskDataRecord
      let functionWork: Packet | null = workArg
      if (null === functionWork) {
        if (null === (functionWork = dataRecord.pending)) {
          return this.markWaiting()
        }
        dataRecord.pending = null
        return this.queuePacket(functionWork)
      }
      dataRecord.pending = functionWork
      return this.holdSelf()
    })
  }

  createHandler(identity: number, priority: number, workPacket: Packet | null, state: TaskState): void {
    const data = new HandlerTaskDataRecord()
    this.createTask(identity, priority, workPacket, state, data, (work: Packet | null, word: RBObject): TaskControlBlock | null => {
      const dataRecord = word as HandlerTaskDataRecord
      if (null !== work) {
        if (WORK_PACKET_KIND === work.kind) {
          dataRecord.workInAdd(work)
        } else {
          dataRecord.deviceInAdd(work)
        }
      }

      let workPacket_: Packet | null
      if (null === (workPacket_ = dataRecord.workIn)) {
        return this.markWaiting()
      }
      const count = workPacket_.datum
      if (count >= DATA_SIZE) {
        dataRecord.workIn = workPacket_.link
        return this.queuePacket(workPacket_)
      }
      let devicePacket: Packet | null
      if (null === (devicePacket = dataRecord.deviceIn)) {
        return this.markWaiting()
      }
      dataRecord.deviceIn = devicePacket.link
      devicePacket.datum = workPacket_.data[count]!
      workPacket_.datum = count + 1
      return this.queuePacket(devicePacket)
    })
  }

  createIdler(identity: number, priority: number, work: Packet | null, state: TaskState): void {
    const data = new IdleTaskDataRecord()
    this.createTask(identity, priority, work, state, data, (workArg: Packet | null, wordArg: RBObject): TaskControlBlock | null => {
      const dataRecord = wordArg as IdleTaskDataRecord
      dataRecord.count -= 1
      if (0 === dataRecord.count) {
        return this.holdSelf()
      }
      if (0 === (dataRecord.control & 1)) {
        dataRecord.control /= 2
        return this.release(DEVICE_A)
      }
      dataRecord.control = (dataRecord.control / 2) ^ 53256
      return this.release(DEVICE_B)
    })
  }

  createPacket(link: Packet | null, identity: number, kind: number): Packet {
    return new Packet(link, identity, kind)
  }

  createTask(identity: number, priority: number, work: Packet | null, state: TaskState, data: RBObject, fn: TaskFn): void {
    const t = new TaskControlBlock(this.taskList, identity, priority, work, state, data, fn)
    this.taskList = t
    this.taskTable[identity] = t
  }

  createWorker(identity: number, priority: number, workPacket: Packet | null, state: TaskState): void {
    const dataRecord = new WorkerTaskDataRecord()

    this.createTask(identity, priority, workPacket, state, dataRecord, (work: Packet | null, word: RBObject): TaskControlBlock | null => {
      const data = word as WorkerTaskDataRecord
      if (null === work) {
        return this.markWaiting()
      }

      data.destination = HANDLER_A === data.destination ? HANDLER_B : HANDLER_A
      work.identity = data.destination
      work.datum = 0
      for (let i = 0; i < DATA_SIZE; i += 1) {
        data.count += 1
        if (data.count > 26) {
          data.count = 1
        }
        work.data[i] = 65 + data.count - 1
      }
      return this.queuePacket(work)
    })
  }

  start(): boolean {
    let workQ: Packet | null

    this.createIdler(IDLER, 0, null, TaskState.createRunning())
    workQ = this.createPacket(null, WORKER, WORK_PACKET_KIND)
    workQ = this.createPacket(workQ, WORKER, WORK_PACKET_KIND)

    this.createWorker(WORKER, 1000, workQ, TaskState.createWaitingWithPacket())
    workQ = this.createPacket(null, DEVICE_A, DEVICE_PACKET_KIND)
    workQ = this.createPacket(workQ, DEVICE_A, DEVICE_PACKET_KIND)
    workQ = this.createPacket(workQ, DEVICE_A, DEVICE_PACKET_KIND)

    this.createHandler(HANDLER_A, 2000, workQ, TaskState.createWaitingWithPacket())
    workQ = this.createPacket(null, DEVICE_B, DEVICE_PACKET_KIND)
    workQ = this.createPacket(workQ, DEVICE_B, DEVICE_PACKET_KIND)
    workQ = this.createPacket(workQ, DEVICE_B, DEVICE_PACKET_KIND)

    this.createHandler(HANDLER_B, 3000, workQ, TaskState.createWaitingWithPacket())
    this.createDevice(DEVICE_A, 4000, null, TaskState.createWaiting())
    this.createDevice(DEVICE_B, 5000, null, TaskState.createWaiting())

    this.schedule()

    return this.queuePacketCount === 23246 && this.holdCount === 9297
  }

  findTask(identity: number): TaskControlBlock {
    const t = this.taskTable[identity]
    if (null === t || undefined === t) {
      throw new Error('findTask failed')
    }
    return t
  }

  holdSelf(): TaskControlBlock | null {
    this.holdCount += 1
    const cur = this.currentTask as TaskControlBlock
    cur.setTaskHolding(true)
    return cur.link
  }

  queuePacket(packet: Packet): TaskControlBlock | null {
    const t = this.findTask(packet.identity)

    this.queuePacketCount += 1

    packet.link = null
    packet.identity = this.currentTaskIdentity
    return t.addInputAndCheckPriority(packet, this.currentTask as TaskControlBlock)
  }

  release(identity: number): TaskControlBlock | null {
    const t = this.findTask(identity)
    t.setTaskHolding(false)
    const cur = this.currentTask as TaskControlBlock
    if (t.priority > cur.priority) {
      return t
    }
    return cur
  }

  markWaiting(): TaskControlBlock | null {
    const cur = this.currentTask as TaskControlBlock
    cur.setTaskWaiting(true)
    return cur
  }

  schedule(): void {
    this.currentTask = this.taskList
    while (null !== this.currentTask) {
      if (this.currentTask.isTaskHoldingOrWaiting()) {
        this.currentTask = this.currentTask.link
      } else {
        this.currentTaskIdentity = this.currentTask.identity
        this.currentTask = this.currentTask.runTask()
      }
    }
  }
}

class Richards {
  benchmark(): boolean {
    return new Scheduler().start()
  }

  verifyResult(result: boolean): boolean {
    return result
  }
}

const ITERATIONS: number = 1500
const richards = new Richards()
let okCount = 0
const t0 = Date.now()
for (let i = 0; i < ITERATIONS; i++) {
  if (richards.verifyResult(richards.benchmark())) {
    okCount += 1
  }
}
const elapsed = Date.now() - t0
console.log('richards ' + elapsed + ' ' + (okCount === ITERATIONS) + ':' + okCount)
