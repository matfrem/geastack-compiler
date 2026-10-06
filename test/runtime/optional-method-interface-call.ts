//! expect: start 1
//! expect: end 1
//! expect: queued 0
//! expect: calls 2

// An interface that declares `start?()` and `end?()`, implemented by classes that
// define only some of them, is called through `current?.start?.(x)`. The read of
// an optional method publishes the callable without a receiver, so the body's own
// receiver is bound into it, and the classes that lack the method read it as absent.
interface Activity {
  readonly label: string
  start?(ai: number): void
  update(ai: number): boolean
  end?(ai: number): void
}

let calls = 0

class Heal implements Activity {
  label = 'heal'
  update(ai: number): boolean {
    calls += 1
    return ai > 1
  }
}

class Go implements Activity {
  label = 'go'
  start(ai: number): void {
    console.log('start', ai)
  }
  update(ai: number): boolean {
    calls += 1
    return ai > 2
  }
  end(ai: number): void {
    console.log('end', ai)
  }
}

class Runner {
  current: Activity | null = null
  queue: Activity[] = [new Heal(), new Go()]
  tick(): void {
    if (!this.current) {
      this.current = this.queue.shift() ?? null
      this.current?.start?.(1)
    }
    if (this.current && this.current.update(3)) {
      this.current.end?.(1)
      this.current = null
    }
  }
}

const runner = new Runner()
runner.tick()
runner.tick()
runner.tick()
console.log('queued', runner.queue.length)
console.log('calls', calls)
