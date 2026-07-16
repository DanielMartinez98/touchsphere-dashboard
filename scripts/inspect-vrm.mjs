// One-off diagnostic: dump a VRM's expression presets + morph-target names.
// Usage: node scripts/inspect-vrm.mjs client/public/miku-nt.vrm
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'client/public/miku-nt.vrm'
const buf = readFileSync(path)

// GLB header: magic(4) version(4) length(4), then chunks: length(4) type(4) data
const magic = buf.readUInt32LE(0)
if (magic !== 0x46546c67) { console.error('Not a GLB/VRM'); process.exit(1) }
let offset = 12
let json = null
while (offset < buf.length) {
  const chunkLen = buf.readUInt32LE(offset)
  const chunkType = buf.readUInt32LE(offset + 4)
  const data = buf.subarray(offset + 8, offset + 8 + chunkLen)
  if (chunkType === 0x4e4f534a) { json = JSON.parse(data.toString('utf8')) } // 'JSON'
  offset += 8 + chunkLen
}
if (!json) { console.error('No JSON chunk'); process.exit(1) }

const ext = json.extensions ?? {}
const vrm0 = ext.VRM
const vrm1 = ext.VRMC_vrm
console.log('=== VRM version:', vrm1 ? '1.0 (VRMC_vrm)' : vrm0 ? `0.x (${vrm0.exporterVersion ?? '?'})` : 'unknown')

// Morph-target names, per mesh
console.log('\n=== Morph targets (per mesh) ===')
const allMorphs = new Set()
for (const mesh of json.meshes ?? []) {
  const names = mesh.extras?.targetNames
    ?? mesh.primitives?.[0]?.extras?.targetNames
    ?? []
  if (names.length) {
    console.log(`\n[${mesh.name}] (${names.length})`)
    console.log('  ' + names.join(', '))
    names.forEach(n => allMorphs.add(n))
  }
}
console.log(`\n=== All unique morph-target names (${allMorphs.size}) ===`)
console.log([...allMorphs].join(', '))

// VRM 0.x expression presets (blendShapeGroups)
if (vrm0?.blendShapeMaster?.blendShapeGroups) {
  console.log('\n=== VRM 0.x expression presets (blendShapeGroups) ===')
  const meshes = json.meshes ?? []
  for (const g of vrm0.blendShapeMaster.blendShapeGroups) {
    const binds = (g.binds ?? []).map(b => {
      const mesh = meshes[b.mesh]
      const names = mesh?.extras?.targetNames ?? mesh?.primitives?.[0]?.extras?.targetNames ?? []
      const morphName = names[b.index] ?? `#${b.index}`
      return `${morphName}=${(b.weight ?? 0) / 100}`
    })
    const label = `${g.presetName && g.presetName !== 'unknown' ? g.presetName : g.name}`
    console.log(`  ${label.padEnd(14)} → ${binds.join(', ') || '(no binds)'}`)
  }
}

// glTF animation clips (idle / AFK poses ship here, if at all)
console.log('\n=== glTF animations ===')
const anims = json.animations ?? []
if (!anims.length) {
  console.log('  (none embedded)')
} else {
  const nodeName = (i) => json.nodes?.[i]?.name ?? `node${i}`
  for (const a of anims) {
    const channels = a.channels ?? []
    const targets = new Set(channels.map(c => c.target?.node).filter(n => n != null))
    const paths = new Set(channels.map(c => c.target?.path))
    console.log(`  "${a.name ?? '(unnamed)'}" — ${channels.length} channels, ${targets.size} nodes, paths: ${[...paths].join('/')}`)
    console.log('    nodes: ' + [...targets].slice(0, 12).map(nodeName).join(', ') + (targets.size > 12 ? ' …' : ''))
  }
}

// VRM 1.0 expressions
if (vrm1?.expressions) {
  console.log('\n=== VRM 1.0 expressions ===')
  const named = { ...(vrm1.expressions.preset ?? {}), ...(vrm1.expressions.custom ?? {}) }
  for (const [name, e] of Object.entries(named)) {
    const binds = (e.morphTargetBinds ?? []).map(b => `node${b.node}#${b.index}=${b.weight}`)
    console.log(`  ${name.padEnd(14)} → ${binds.join(', ') || '(no binds)'}`)
  }
}
