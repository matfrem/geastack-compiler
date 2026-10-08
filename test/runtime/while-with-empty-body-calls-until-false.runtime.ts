//! expect: i=5 k=6 m=5 j=4 p=3
// A loop with nothing in its body is still a loop: its test runs until it is false. The loop used to compile to
// the test alone, run once.
class P {
  i: number = 0
  step(): boolean {
    if (this.i >= 5) return false
    this.i += 1
    return true
  }
  run(): number {
    while (this.step()) {
      /* no op */
    }
    return this.i
  }
}
let k = 0
while (k++ < 5) {}
let m = 0
for (; m < 5; m++);
let j = 0
for (let n = 0; n < 4; n = ++j) {}
const queue = [1, 2, 3]
let p = 0
while (queue.pop() !== undefined) p++
console.log('i=' + new P().run() + ' k=' + k + ' m=' + m + ' j=' + j + ' p=' + p)
