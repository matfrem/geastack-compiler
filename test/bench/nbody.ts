interface Planet { x: number; y: number; z: number; vx: number; vy: number; vz: number; mass: number }
const PI = Math.PI
const SOLAR_MASS = 4 * PI * PI
const DAYS = 365.24
function makeBodies(): Planet[] {
  return [
    { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mass: SOLAR_MASS },
    { x: 4.84143144246472090, y: -1.16032004402742839, z: -0.103622044471123109, vx: 0.00166007664274403694 * DAYS, vy: 0.00769901118419740425 * DAYS, vz: -0.0000690460016972063023 * DAYS, mass: 0.000954791938424326609 * SOLAR_MASS },
    { x: 8.34336671824457987, y: 4.12479856412430479, z: -0.403523417114321381, vx: -0.00276742510726862411 * DAYS, vy: 0.00499852801234917238 * DAYS, vz: 0.0000230417297573763929 * DAYS, mass: 0.000285885980666130812 * SOLAR_MASS },
    { x: 12.8943695621391310, y: -15.1111514016986312, z: -0.223307578892655734, vx: 0.00296460137564761618 * DAYS, vy: 0.00237847173959480950 * DAYS, vz: -0.0000296589568540237556 * DAYS, mass: 0.0000436624404335156298 * SOLAR_MASS },
    { x: 15.3796971148509165, y: -25.9193146099879641, z: 0.179258772950371181, vx: 0.00268067772490389322 * DAYS, vy: 0.00162824170038242295 * DAYS, vz: -0.0000951592254519715870 * DAYS, mass: 0.0000515138902046611451 * SOLAR_MASS }
  ]
}
function offsetMomentum(bodies: Planet[]): void {
  let px = 0, py = 0, pz = 0
  for (const b of bodies) { px += b.vx * b.mass; py += b.vy * b.mass; pz += b.vz * b.mass }
  bodies[0]!.vx = -px / SOLAR_MASS; bodies[0]!.vy = -py / SOLAR_MASS; bodies[0]!.vz = -pz / SOLAR_MASS
}
function advance(bodies: Planet[], dt: number): void {
  const n = bodies.length
  for (let i = 0; i < n; i++) {
    const a = bodies[i]!
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j]!
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
      const d2 = dx * dx + dy * dy + dz * dz
      const mag = dt / (d2 * Math.sqrt(d2))
      a.vx -= dx * b.mass * mag; a.vy -= dy * b.mass * mag; a.vz -= dz * b.mass * mag
      b.vx += dx * a.mass * mag; b.vy += dy * a.mass * mag; b.vz += dz * a.mass * mag
    }
  }
  for (let i = 0; i < n; i++) { const b = bodies[i]!; b.x += dt * b.vx; b.y += dt * b.vy; b.z += dt * b.vz }
}
function energy(bodies: Planet[]): number {
  let e = 0
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]!
    e += 0.5 * a.mass * (a.vx * a.vx + a.vy * a.vy + a.vz * a.vz)
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j]!
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
      e -= (a.mass * b.mass) / Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
  }
  return e
}
const bodies = makeBodies()
offsetMomentum(bodies)
const t0 = Date.now()
for (let i = 0; i < 2000000; i++) advance(bodies, 0.01)
console.log('nbody ' + (Date.now() - t0) + ' ' + energy(bodies).toFixed(9))
