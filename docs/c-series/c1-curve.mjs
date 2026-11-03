// C1 curve evidence: cortisol cascade under same stress input, safety low vs high.
// Runs inside the container with isolated BOT_DATA_DIR. Writes JSON to argv[2] or default.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c1-curve-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.dsh', 'bot.config.json'), JSON.stringify({ owner: { qq: '10000' } }))

const { epFile } = await import('../../tools/brain/paths.mjs')
const bond = await import('../../tools/lib/bond.mjs')
const hpa = await import('../../tools/brain/organ/hpa.mjs')

const NOW = Date.now()
function writeEps(list) {
  fs.mkdirSync(path.dirname(epFile(new Date(NOW))), { recursive: true })
  fs.writeFileSync(epFile(new Date(NOW)), list.map(({ hAgo, valence }) => JSON.stringify({
    at: NOW - hAgo * 3600_000, act: 'say', gist: 'x',
    who: { kind: 'user', others: [{ kind: 'owner' }] },
    feel: { valence, arousal: 0.3 },
  })).join('\n') + '\n')
}

function runCascade(safetyScenario) {
  try { fs.rmSync(path.join(TMP, '.data', 'brain', 'meta', 'hpa.json'), { force: true }) } catch { }
  writeEps(safetyScenario === 'safe'
    ? [{ hAgo: 1, valence: 0.8 }, { hAgo: 3, valence: 0.6 }, { hAgo: 10, valence: 0.5 }]
    : [{ hAgo: 1, valence: -0.75 }, { hAgo: 3, valence: -0.6 }, { hAgo: 10, valence: -0.4 }])
  const safety = bond.safety('qq', NOW)
  hpa.stress(2, { now: NOW, why: 'c1-curve' })
  const series = []
  for (let m = 0; m <= 240; m += 5) {
    const r = hpa.read(NOW + m * 60_000)
    series.push({ min: m, crh: r.crh, acth: r.acth, cortisol: r.cortisol })
  }
  return { safety: Number(safety.toFixed(3)), series }
}

const rough = runCascade('rough')
const safe = runCascade('safe')
const peakOf = (s) => s.series.reduce((a, b) => (b.cortisol > a.cortisol ? b : a))
const p0 = peakOf(rough), p1 = peakOf(safe)
// fall-back speed: time to decay from peak to half-of-excess, measured on each curve
const halfTauOf = (s, pk) => {
  const excess = pk.cortisol - 0.16
  const target = pk.cortisol - excess / 2
  for (const pt of s.series) if (pt.min > pk.min && pt.cortisol <= target) return pt.min - pk.min
  return null
}
const out = {
  scenario: { strength: 2, roughSafety: rough.safety, safeSafety: safe.safety },
  peak: { rough: { min: p0.min, cortisol: p0.cortisol }, safe: { min: p1.min, cortisol: p1.cortisol } },
  peakDropPct: Number((100 * (1 - p1.cortisol / p0.cortisol)).toFixed(1)),
  halfDecayMin: { rough: halfTauOf(rough, p0), safe: halfTauOf(safe, p1) },
  tausMin: hpa.snapshot().layers,
  series: { rough: rough.series, safe: safe.series },
}
const dest = process.argv[2] || new URL('./c1-hpa-safety.json', import.meta.url).pathname
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, JSON.stringify(out, null, 2))
console.log('C1 curve:', JSON.stringify({ peakRough: p0.cortisol, peakSafe: p1.cortisol, dropPct: out.peakDropPct, halfDecay: out.halfDecayMin, taus: out.tausMin }))
