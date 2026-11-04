// safety-test —— C1 社交安抚缓冲（2026-11-03）
//
// 器官判据（M58）：
//   ① 纯读纪律：safety() 不写任何账本/状态文件（读前后数据目录逐字节一致）
//   ② 无数据 → 0.5 中性（不缓冲也不放任）；72h 窗外 → 0.5
//   ③ 用户正向互动 → 高安全；负向 → 低安全（episode valence 化学慢变量，非数值好感度）
//   ④ hpa 增益衰减：同 stress 输入，safety 高 → cortisol 峰显著低，峰时刻不变（变钝≠变慢）
//   ⑤ 慢性通路不受扰动：fbSensitivity/load 照常累积
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c1-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.dsh', 'bot.config.json'), JSON.stringify({ owner: { qq: '10000' } }))

const { epFile, hpaPath } = await import('../tools/brain/paths.mjs')
const bond = await import('../tools/lib/bond.mjs')
const hpa = await import('../tools/brain/organ/hpa.mjs')

const NOW = Date.now()
function writeEps(list) {
  fs.mkdirSync(path.dirname(epFile(new Date(NOW))), { recursive: true })
  const rows = list.map(({ hAgo, valence }) => JSON.stringify({
    at: NOW - hAgo * 3600_000, act: 'say', gist: 'x',
    who: { kind: 'user', others: [{ kind: 'owner' }] },
    feel: { valence, arousal: 0.3 },
  }))
  fs.writeFileSync(epFile(new Date(NOW)), rows.join('\n') + '\n')
}
function dirSnapshot() {
  const out = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p + ':' + fs.statSync(p).size + ':' + fs.statSync(p).mtimeMs) } }
  walk(TMP)
  return out.sort().join('\n')
}

// ── ① 纯读 ──────────────────────────────────────────────────────────────
writeEps([{ hAgo: 2, valence: 0.8 }])
bond.safety('qq', NOW)   // warm-up（模块首次可能建目录）
const before = dirSnapshot()
for (let i = 0; i < 3; i++) bond.safety('qq', NOW)
assert.strictEqual(dirSnapshot(), before, 'safety() must not write anything')
console.log('ok ① pure-read: data dir untouched')

// ── ② 无数据 / 窗外 → 0.5 ───────────────────────────────────────────────
writeEps([])
assert.strictEqual(bond.safety('qq', NOW), 0.5, 'no data -> neutral')
assert.strictEqual(bond.safety('wechat', NOW), 0.5, 'no owner on platform -> neutral')
writeEps([{ hAgo: 100, valence: 0.9 }])
assert.strictEqual(bond.safety('qq', NOW), 0.5, 'outside 72h window -> neutral')
console.log('ok ② neutral defaults')

// ── ③ valence 映射 ──────────────────────────────────────────────────────
writeEps([{ hAgo: 1, valence: 0.8 }, { hAgo: 3, valence: 0.6 }])
const hi = bond.safety('qq', NOW)
assert.ok(hi > 0.65, 'warm owner history -> safe, got ' + hi)
writeEps([{ hAgo: 1, valence: -0.75 }, { hAgo: 3, valence: -0.6 }])
const lo = bond.safety('qq', NOW)
assert.ok(lo < 0.35, 'rough owner history -> unsafe, got ' + lo)
assert.ok(hi - lo > 0.3, 'safety separates clearly')
console.log(`ok ③ mapping hi=${hi.toFixed(2)} lo=${lo.toFixed(2)}`)

// ── ④ hpa 增益衰减：峰降 + 峰时刻不变 + 级联 tau 不动 ──────────────────
function cascade(safetyScenario, strength = 2) {
  try { fs.rmSync(hpaPath(), { force: true }) } catch { }
  writeEps(safetyScenario === 'safe' ? [{ hAgo: 1, valence: 0.8 }, { hAgo: 3, valence: 0.6 }] : [{ hAgo: 1, valence: -0.75 }, { hAgo: 3, valence: -0.6 }])
  hpa.stress(strength, { now: NOW, why: 'c1-test' })
  const series = []
  for (let m = 5; m <= 120; m += 5) {
    const r = hpa.read(NOW + m * 60_000)
    series.push([m, r.cortisol])
  }
  return series
}
const peakOf = (s) => s.reduce((a, b) => (b[1] > a[1] ? b : a))
const A = cascade('rough'), B = cascade('safe')
const pa = peakOf(A), pb = peakOf(B)
assert.ok(pb[1] < pa[1] * 0.85, `safety=1 peak must drop >15%: ${pb[1]} vs ${pa[1]}`)
// 变钝≠变慢的本质：三层时间常数一个没动（6/22/70 分钟）
const layers = hpa.snapshot(NOW + 3 * 3600_000).layers
assert.strictEqual(layers.crhTau, 6); assert.strictEqual(layers.acthTau, 22); assert.strictEqual(layers.cortisolTau, 70)
console.log(`ok ④ peak ${pa[1]} -> ${pb[1]} (-${((1 - pb[1] / pa[1]) * 100).toFixed(0)}%) @${pa[0]}~${pb[0]}min; taus 6/22/70 untouched`)

// ── ⑤ 慢性累积不受缓冲影响 ──────────────────────────────────────────────
writeEps([{ hAgo: 1, valence: 0.8 }, { hAgo: 3, valence: 0.6 }])
const snap1 = hpa.stress(1, { now: NOW + 6 * 3600_000, why: 'c1-chronic' })
assert.ok(snap1.load > 0, 'load still accrues under buffering')
assert.ok(snap1.fbSensitivity < 1, 'fb sensitivity still desensitizes')
console.log('ok ⑤ chronic path intact: load=' + snap1.load + ' fb=' + snap1.fbSensitivity)

console.log('safety-test all green')
