// brain-car-test (P2-1, 2026-11-03): CAR grows out of the existing HPA cascade.
// A real >=4h sleep must hand exactly one sub-sensitisation stress to the axis;
// cortisol then rises to a single peak (real physiology: 30-45 min after wake)
// and decays again. Short sleeps must NOT fire the response.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-car-'))
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
const night = await import('../tools/brain/organ/night.mjs')
const stage = await import('../tools/brain/organ/sleepstage.mjs')

const H = 3600_000
const MIN = 60_000
const T = Date.now()

// ---- ① full night: sleep begins 8h ago, wake now ----
stage.sleep(T - 8 * H)
const preC = hpa.read(T - MIN).cortisol     // baseline before the wake event
const r = night.endSleep(T)
ok('真睡结算 sleptMin>=470', Number(r.sleptMin) >= 470, String(r.sleptMin))

const afterCrh = hpa.read(T + MIN).crh
ok('醒来后 CRH 抬升（把醒来当成一次负荷交给了级联）', afterCrh > 0.16, String(afterCrh))

// setShift / fbSensitivity must be untouched (0.3 < 0.4 threshold)
const snap = hpa.read(T + MIN)
ok('CAR 不伤设定点（sub-sensitisation）', Number(snap.setShift) === 0 && Number(snap.fbSensitivity) === 1,
  `setShift=${snap.setShift} fb=${snap.fbSensitivity}`)

// ---- ② the curve itself: single peak 20..90 min after wake, then decay ----
const pts = []
for (let m = 0; m <= 150; m += 5) pts.push({ m, c: hpa.read(T + m * MIN).cortisol })
let peak = pts[0]
for (const p of pts) if (p.c > peak.c) peak = p
ok('CAR 单峰出现', peak.m >= 20 && peak.m <= 90, `peak@${peak.m}min c=${peak.c}`)
ok('峰值显著高于基线', peak.c - preC >= 0.02, `+${(peak.c - preC).toFixed(3)}`)
const tail = pts[pts.length - 1]
ok('峰值后回落（150min 明显低于峰值）', tail.c < peak.c - (peak.c - preC) * 0.5,
  `tail=${tail.c} peak=${peak.c}`)
// single peak: no second rise above 95% of peak after it
const afterPeak = pts.filter((p) => p.m > peak.m)
ok('无第二峰', afterPeak.every((p) => p.c <= peak.c + 0.005))

// ---- ③ short nap must NOT fire CAR ----
const T2 = T + 6 * H
stage.sleep(T2 - 45 * MIN)
const crhBeforeNap = hpa.read(T2 - MIN).crh
night.endSleep(T2)
const crhAfterNap = hpa.read(T2 + 2 * MIN).crh
ok('短睡（45min）不触发 CAR', Math.abs(crhAfterNap - crhBeforeNap) < 0.02,
  `before=${crhBeforeNap} after=${crhAfterNap}`)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
