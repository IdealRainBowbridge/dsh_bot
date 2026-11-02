// brain-allo-test (P2-2, 2026-11-03): allostasis WITHOUT new structure.
// Chronic stress raises hpa.setShift -> perfuse lifts field.cortisol ->
// the EXISTING field coupling (cortisol->valence, mode:set) drags the valence
// rest-point down; when the load clears, the rest-point climbs back on its own.
// sleepDebt->fatigue (mode:set) is the second built-in handshake - verified too.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-allo-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_BRAIN_MIRROR = '0'

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const hpa = await import('../tools/brain/organ/hpa.mjs')
const field = await import('../tools/brain/field.mjs')

const H = 3600_000
const DAY = 24 * H
const T = Date.now()
const driftOf = () => Number(field.snapshot().drift.valence || 0)

// ---- ① chronic phase: five days of repeated stress -> setShift climbs ----
for (let d = 1; d <= 5; d++) {
  const t = T - (6 - d) * DAY
  hpa.stress(1.2, { why: 'chronic-day' + d, now: t })
  hpa.perfuse(t + 30 * 60_000)
}
const shift = hpa.read(T).setShift
ok('反复应激抬高设定点 setShift>0.15', shift > 0.15, String(shift))

// ---- ② the handshake: valence rest-point dragged down (slowly) ----
for (let h = 1; h <= 48; h++) field.evolve(T + h * H)   // 48h of living with it
const dLow = driftOf()
ok('异稳态：valence 静息点被压低（drift<0）', dLow < -0.05, String(dLow.toFixed(3)))
const cort = field.snapshot().dims.cortisol
ok('皮质醇入血抬高了 field.cortisol', cort > 0.2, String(cort))

// ---- ③ recovery: load clears, days pass, rest-point climbs back ----
for (let d = 1; d <= 4; d++) hpa.evolve(T + 3 * DAY + d * DAY)   // no more stress
for (let h = 1; h <= 96; h++) {
  const t = T + 3 * DAY + h * H
  hpa.perfuse(t)
  field.evolve(t)
}
const dBack = driftOf()
ok('负荷消失后静息点回落（drift 上行）', dBack > dLow + 0.02, `${dLow.toFixed(3)} -> ${dBack.toFixed(3)}`)

// ---- ④ second built-in handshake: sleepDebt drags fatigue (mode:set) ----
field.setDim('sleepDebt', 0.85, { why: 'test:debt', now: T + 8 * DAY })
for (let h = 1; h <= 12; h++) field.evolve(T + 8 * DAY + h * H)
const fat = field.snapshot().dims.fatigue
ok('sleepDebt->fatigue 握手：欠觉变沉', fat > 0.35, String(fat.toFixed(3)))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
