// brain-allo-test (P2-2, 2026-11-03): allostasis WITHOUT new structure.
// Chronic stress raises hpa.setShift -> perfuse lifts field.cortisol ->
// the EXISTING field coupling (cortisol->valence, mode:set) drags the valence
// rest-point down; when the load clears, the rest-point climbs back on its own.
// Timeline discipline: every event lives in the PAST. field.at is initialised
// by walking evolve() forward from T-8d; dt<=0 calls are silent no-ops.
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

// initialise both organs at the start of the scenario (walk, not jump:
// evolve() caps dt at 24h)
field.evolve(T - 8 * DAY)
field.evolve(T - 7 * DAY)

// ---- ① chronic phase: five days, three stressors a day -> setShift climbs ----
for (let d = 1; d <= 5; d++) {
  for (let k = 0; k < 3; k++) {
    const t = T - (6 - d) * DAY + k * 5 * H
    hpa.stress(1.2, { why: 'chronic-d' + d + 'x' + k, now: t })
    hpa.perfuse(t + 30 * 60_000)
  }
}
const shift = hpa.read(T).setShift
ok('反复应激抬高设定点 setShift>0.12', shift > 0.12, String(shift))

// ---- ② living with it: valence rest-point dragged down (slowly) ----
for (let h = 1; h <= 48; h++) {
  const t = T - DAY + h * H
  hpa.perfuse(Math.min(t, T))
  field.evolve(t)
}
const dLow = driftOf()
ok('异稳态：valence 静息点被压低（drift<0）', dLow < -0.03, dLow.toFixed(4))
const cort = field.snapshot().dims.cortisol
ok('皮质醇入血抬高了 field.cortisol', cort > 0.18, String(cort.toFixed(3)))

// ---- ③ recovery: load clears, days pass, rest-point climbs back ----
for (let d = 1; d <= 4; d++) hpa.evolve(T + d * DAY)
for (let h = 1; h <= 96; h++) {
  const t = T + 96 * H + h * H
  hpa.perfuse(t)
  field.evolve(t)
}
const dBack = driftOf()
ok('负荷消失后静息点回落（drift 上行）', dBack > dLow + 0.015, `${dLow.toFixed(4)} -> ${dBack.toFixed(4)}`)

// ---- ④ second built-in handshake: sleepDebt drags fatigue (mode:set) ----
const tDebt = T + 12 * DAY   // strictly after the recovery walk (field.at ~ T+8d)
field.evolve(tDebt)
field.setDim('sleepDebt', 0.85, { why: 'test:debt', now: tDebt })
for (let h = 1; h <= 12; h++) field.evolve(tDebt + h * H)
const fat = field.snapshot().dims.fatigue
ok('sleepDebt->fatigue 握手：欠觉变沉（高于静息 set）', fat > 0.15, fat.toFixed(3))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
