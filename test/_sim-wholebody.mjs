// _sim-wholebody.mjs (P2-4, 2026-11-03): whole-body simulation for the archive.
// NOT a unit test. Drives HER REAL ORGANS (field/hpa/night/sleepstage/rhythm)
// through one typical day (24h) or one allostasis arc (9 days), dumps curves to
// JSON for plotting and asserts day-shape invariants.
// Timeline discipline (same as brain-allo-test): every event lives in the PAST,
// organs are walked forward with evolve(), never teleported. dt<=0 is a no-op.
// CAR anchor: night.endSleep() stamps Date.now() internally, so the previous
// night is staged as stage.sleep(T-8h) and the wake happens at real T. The day
// then runs T..T+16h awake, bedtime gate at T+16h, sleep sampled to T+24h.
// Usage: node _sim-wholebody.mjs day   -> /tmp/sim-day.json
//        node _sim-wholebody.mjs allo  -> /tmp/sim-allo.json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODE = process.argv[2] || 'day'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-wholebody-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_BRAIN_MIRROR = '0'

const hpa = await import('../tools/brain/organ/hpa.mjs')
const field = await import('../tools/brain/field.mjs')
const night = await import('../tools/brain/organ/night.mjs')
const stage = await import('../tools/brain/organ/sleepstage.mjs')
const rhythm = await import('../tools/brain/rhythm.mjs')

const H = 3600_000
const MIN = 60_000
const DAY = 24 * H
const T = Date.now()
let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ' -- ' + detail : ''}`)
}
const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0 }
const sleepScore = (s) => num(s?.score ?? s)
const H2 = (t) => new Date(t).getHours() + new Date(t).getMinutes() / 60

let out = {}

if (MODE === 'day') {
  // ── morning: previous night (T-8h .. T) already happened; waking now fires CAR ──
  stage.sleep(T - 8 * H)
  const wakeInfo = night.endSleep(T)

  const bl = { pending: 140, episodes: 200, inbox: 40, dirty: 6 }   // a lived-in backlog
  const pts = []
  let asleepNow = false
  let sleepStart = 0
  let interrupted = false
  let s1 = false, s2 = false
  const evts = []
  const stageMinutes = { N3a: 0, N3b: 0, REMa: 0, REMb: 0 }
  const BED = 16 * H          // bedtime gate: T+16h (mirrors 21:00 when wake is 05:00-ish)

  for (let t = T; t <= T + DAY; t += 5 * MIN) {
    const hr = H2(t)
    if (!asleepNow && t >= T + BED) {
      asleepNow = true
      sleepStart = t
      stage.sleep(t)
      evts.push({ m: Math.round((t - T) / MIN), label: 'sleep' })
    }
    field.evolve(t)
    const cs = asleepNow ? stage.currentStage(t) : { stage: null }
    const hp = hpa.read(t)
    const f = field.snapshot()
    if (asleepNow) {
      // one interruption mid-night (the cat) -- interruptions cost deep sleep.
      // SIM_NOINT=1 for the textbook-night archive run (no interruption).
      if (process.env.SIM_NOINT !== '1' && !interrupted && sleepStart && t >= sleepStart + 4 * H) {
        interrupted = true
        stage.interrupt(t)
        evts.push({ m: Math.round((t - T) / MIN), label: 'wake-interrupt' })
      }
      const half = t < sleepStart + 4 * H ? 'a' : 'b'
      if (cs.stage === 'N3') stageMinutes['N3' + half] += 5
      if (cs.stage === 'REM') stageMinutes['REM' + half] += 5
    } else {
      if (!s1 && t >= T + 5 * H) { s1 = true; hpa.stress(1.3, { why: 'day:criticism', now: t }); evts.push({ m: Math.round((t - T) / MIN), label: 'stress:criticism' }) }
      if (!s2 && t >= T + 13.5 * H) { s2 = true; hpa.stress(1.0, { why: 'day:crowd', now: t }); evts.push({ m: Math.round((t - T) / MIN), label: 'stress:crowd' }) }
      hpa.perfuse(t)
      // awake-time sleep-debt accrual: same constants as heartbeat.accrueSleepDebt
      // (private fn: 0.02/h day, x2.5 for 23:00-06:00), applied through the
      // public field.poke API -- the harness plays "environment", the organ
      // (night.sleepiness / night.endSleep) still does all the accounting.
      const nightish = (hr >= 0 && hr < 6) || hr >= 23
      field.poke('sleepDebt', 0.02 * (nightish ? 2.5 : 1) * (5 / 60), { why: nightish ? 'awake:night' : 'awake:day', now: t })
    }
    pts.push({
      m: Math.round((t - T) / MIN), hr: Number(hr.toFixed(2)), circ: rhythm.circadian(hr),
      hCort: num(hp.cortisol), crh: num(hp.crh), acth: num(hp.acth),
      fCort: num(f.dims.cortisol), val: num(f.dims.valence), ten: num(f.dims.tension),
      sero: num(f.dims.sero), fat: num(f.dims.fatigue), debt: num(f.dims.sleepDebt),
      sleepy: null, sleepyDebt: 0, stage: cs.stage || '', shift: num(hp.setShift),
    })
    if (!asleepNow) {
      // feed the REAL account the way night.assess does: backlog carries .debt
      const sl = night.sleepiness(t, { backlog: { ...bl, debt: num(f.dims.sleepDebt) } })
      pts[pts.length - 1].sleepy = sleepScore(sl)
      pts[pts.length - 1].sleepyDebt = num(sl?.parts?.debt)
    }
  }

  // ── shape assertions (the curve must LOOK like a day) ──────────────────
  const base = pts[0].hCort
  const carWin = pts.filter((p) => p.m <= 150)
  let peak = carWin[0]
  for (const p of carWin) if (p.hCort > peak.hCort) peak = p
  ok('CAR: wake cortisol peak in 20..90min', peak.m >= 20 && peak.m <= 90, `peak@${peak.m}min hCort=${peak.hCort.toFixed(3)} base=${base.toFixed(3)}`)
  ok('CAR: peak clearly above baseline', peak.hCort - base >= 0.02, `+${(peak.hCort - base).toFixed(3)}`)
  const afterPeak = carWin.filter((p) => p.m > peak.m && p.m <= 180)
  ok('CAR: single peak (no second rise)', afterPeak.every((p) => p.hCort <= peak.hCort + 0.005))
  const morningPts = pts.filter((p) => p.m >= 0 && p.m <= 30)
  const BED_MIN = 16 * 60
  const bedPts = pts.filter((p) => p.m >= BED_MIN - 30 && p.m < BED_MIN)
  // the sleepiness TOTAL mixes backlog + clock weight, so assert on the ACCOUNT:
  // sleepDebt dimension and the debt PART of sleepiness must climb through the day.
  const debtMorning = morningPts.reduce((a, p) => a + p.debt, 0) / morningPts.length
  const debtBed = bedPts.reduce((a, p) => a + p.debt, 0) / bedPts.length
  const sdebtMorning = Math.max(...morningPts.map((p) => p.sleepyDebt))
  const sdebtBed = Math.max(...bedPts.map((p) => p.sleepyDebt))
  ok('debt account: sleepDebt climbs through the 16h day, sleep cleared it at wake', debtBed > debtMorning + 0.12 && sdebtBed > sdebtMorning + 3, `dims ${debtMorning.toFixed(2)}->${debtBed.toFixed(2)}, sleepy.debt ${sdebtMorning.toFixed(0)}->${sdebtBed.toFixed(0)}`)
  ok('N3 front-loaded (first half > second half)', stageMinutes.N3a > stageMinutes.N3b, `N3 ${stageMinutes.N3a} vs ${stageMinutes.N3b} min`)
  ok('REM back-loaded (second half >= first half)', stageMinutes.REMb >= stageMinutes.REMa, `REM ${stageMinutes.REMa} vs ${stageMinutes.REMb} min`)
  const cortBefore = pts.filter((p) => p.m >= 4.5 * 60 && p.m < 5 * 60).reduce((a, p) => a + p.fCort, 0) / 6
  const cortAfter = Math.max(...pts.filter((p) => p.m >= 5 * 60 && p.m <= 5 * 60 + 45).map((p) => p.fCort))
  ok('stressor perfuses cortisol within 45min', cortAfter >= cortBefore + 0.02, `${cortBefore.toFixed(3)} -> ${cortAfter.toFixed(3)}`)
  const valBefore = pts.filter((p) => p.m >= 4.5 * 60 && p.m < 5 * 60).reduce((a, p) => a + p.val, 0) / 6
  const valMin = Math.min(...pts.filter((p) => p.m >= 5 * 60 && p.m <= 5 * 60 + 180).map((p) => p.val))
  ok('cortisol drags valence down (field coupling, 3h window)', valMin <= valBefore - 0.015, `${valBefore.toFixed(3)} -> ${valMin.toFixed(3)}`)
  const shiftEnd = pts[pts.length - 1].shift
  ok('one hard day != chronic: setShift stays under sensitisation threshold', shiftEnd < 0.12, `setShift=${shiftEnd.toFixed(3)}`)
  const circ4 = pts.filter((p) => p.hr >= 3.6 && p.hr <= 4.4).map((p) => p.circ)
  const circ20 = pts.filter((p) => p.hr >= 19.6 && p.hr <= 20.4).map((p) => p.circ)
  ok('circadian shape: 04:00 trough < 20:00 peak', circ4.length > 0 && circ20.length > 0 && Math.max(...circ4) < Math.min(...circ20), `4h<=${Math.max(...circ4).toFixed(2)} 20h>=${Math.min(...circ20).toFixed(2)}`)
  ok('sleep work done (REM-based account cleared)', wakeInfo == null || wakeInfo.workDone >= 0.2, wakeInfo ? `workDone=${wakeInfo.workDone} feeling=${wakeInfo.feeling}` : 'no endSleep result')

  out = { mode: 'day', T, pts, evts, stageMinutes, wakeInfo: { workDone: wakeInfo?.workDone, feeling: wakeInfo?.feeling }, asserts: bad }
} else {
  // ── allostasis arc: 5 chronic days -> recovery (mirrors brain-allo-test, denser sampling)
  field.evolve(T - 8 * DAY)
  field.evolve(T - 7 * DAY)
  const pts = []
  for (let d = 0; d <= 5; d++) {
    const dayT = T - (7 - d) * DAY
    for (let k = 0; k < 3; k++) {
      const t = dayT + k * 5 * H
      if (d >= 1 && d <= 5) { hpa.stress(1.2, { why: 'chronic-d' + d + 'x' + k, now: t }); hpa.perfuse(t + 30 * MIN) }
    }
    // daily sample at 19:00 of that scene day
    const sampT = dayT + 12 * H
    hpa.evolve(sampT)
    for (let h = 1; h <= 24; h++) { hpa.perfuse(Math.min(sampT - 12 * H + h * H, sampT)); field.evolve(Math.min(sampT - 12 * H + h * H, sampT)) }
    const hp = hpa.read(sampT)
    const f = field.snapshot()
    pts.push({ day: d - 7, shift: num(hp.setShift), fb: num(hp.fbSensitivity), cort: num(hp.cortisol), fCort: num(f.dims.cortisol), driftVal: num(f.drift?.valence), val: num(f.dims.valence) })
  }
  // recovery: load clears, 4 days pass
  for (let d = 1; d <= 4; d++) {
    const sampT = T + d * DAY
    hpa.evolve(sampT)
    for (let h = 1; h <= 24; h++) { const t = sampT - 12 * H + h * H; hpa.perfuse(t); field.evolve(t) }
    const hp = hpa.read(sampT)
    const f = field.snapshot()
    pts.push({ day: d, shift: num(hp.setShift), fb: num(hp.fbSensitivity), cort: num(hp.cortisol), fCort: num(f.dims.cortisol), driftVal: num(f.drift?.valence), val: num(f.dims.valence) })
  }
  const shiftPeak = Math.max(...pts.map((p) => p.shift))
  const dLow = Math.min(...pts.filter((p) => p.day >= -1 && p.day <= 1).map((p) => p.driftVal))
  const dBack = pts[pts.length - 1].driftVal
  ok('chronic phase: setShift climbs >0.12', shiftPeak > 0.12, String(shiftPeak.toFixed(3)))
  ok('allostatic load: valence rest-point dragged down', dLow < -0.03, dLow.toFixed(4))
  ok('recovery: rest-point climbs back', dBack > dLow + 0.015, `${dLow.toFixed(4)} -> ${dBack.toFixed(4)}`)
  out = { mode: 'allo', T, pts, asserts: bad }
}

fs.writeFileSync(process.env.SIM_OUT || '/tmp/sim-' + MODE + '.json', JSON.stringify(out))
fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `DONE with ${bad} shape failure(s)` : 'ALL SHAPE CHECKS PASS')
process.exit(bad ? 1 : 0)
