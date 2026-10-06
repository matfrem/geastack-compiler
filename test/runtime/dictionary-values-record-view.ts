//! expect: b0 0.5
//! expect: b1 0.75
//! expect: set 2
//! expect: absent true
//! expect: visible true

// A dictionary of the literals' own anonymous records, stored where a dictionary
// of the declared interface is expected, keeps every value and the entry order.
// `Object.fromEntries` infers `T` from the callback's literal, so the container
// reaches its slot with a different value carrier than the slot declares.
//
// The conversion REBUILDS the dictionary (a snapshot of each value), exactly as
// the existing scalar-valued dictionary recast does: it is exact for a fresh
// container such as `Object.fromEntries`' result, and not for one a program
// keeps writing through under two names.
interface MaterialPose {
  color?: number
  emissive?: number
  opacity?: number
}
interface NodePose {
  visible?: boolean
}
interface Pose {
  nodes?: Record<string, NodePose>
  materials?: Record<string, MaterialPose>
}

const opacities = [0.5, 0.75]

const beamPose = (): Pose => ({
  nodes: { beams: { visible: true } },
  materials: Object.fromEntries(opacities.map((opacity, i) => [`b${i}`, { opacity }]))
})

const pose = beamPose()
const materials = pose.materials
if (materials !== undefined) {
  for (const key of Object.keys(materials)) console.log(key, materials[key]?.opacity)
  console.log('set', Object.keys(materials).length)
  console.log('absent', materials['b0']?.color === undefined)
}
console.log('visible', pose.nodes?.['beams']?.visible === true)
