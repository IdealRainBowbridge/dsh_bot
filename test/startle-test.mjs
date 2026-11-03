// startle-test —— C5 惊跳反射（2026-11-03）
//
// 器官判据（M58）：
//   ① 超阈值刺激 -> 瞬时 NE 脉冲（field 的 ne 维上行）
//   ② 1s 不应期：紧跟的第二响被挡掉（零逻辑分支的物理门）
//   ③ 30s 内第二响减半（受体习惯化，专用快内化 1.3/min）
//   ④ 阈下不触发；强度 0..1；峰值刺激信号=1
//   ⑤ 纯内存：不产生 reflex 自有状态文件；重启（fresh import）即满血
//   ⑥ 2 分钟后受体基本复原（第三响回到 ~0.8+）
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c5-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

const reflex = await import('../tools/brain/reflex.mjs')
const { fieldPath } = await import('../tools/brain/paths.mjs')

const T0 = 1_700_000_000_000
function readNe() {
  try { return Number(JSON.parse(fs.readFileSync(fieldPath(), 'utf8')).dims.ne) } catch { return null }
}
const bigMsg = '哇'.repeat(400) + '！！！？？！'   // 长 + 感叹密度 -> 满强度

// ── ④ 阈下不触发 + 强度形状 ────────────────────────────────────────────
assert.strictEqual(reflex.startle('嗯', T0).fired, false, 'short text stays subthreshold')
assert.ok(reflex.intensity({ text: '嗯' }) < 0.01, 'tiny message intensity ~0 (length term only)')
const iHalf = reflex.intensity({ text: '字'.repeat(150) })
assert.ok(iHalf > 0.2 && iHalf < 0.3, '150 chars -> ~0.25, got ' + iHalf)
const iFull = reflex.intensity({ text: '字'.repeat(400) + '！！！', atMe: true })
assert.strictEqual(iFull, 1, 'big @me message saturates at 1')
console.log('ok 4 intensity shape: sub 0, mid ' + iHalf.toFixed(2) + ', full 1')

// ── ① 超阈值 -> NE 脉冲 ────────────────────────────────────────────────
const r1 = reflex.startle({ text: bigMsg }, T0)
assert.ok(r1.fired, 'big message fires')
assert.ok(r1.signal > 0.8, 'fresh startle signal strong, got ' + r1.signal)
const neAfter = readNe()
assert.ok(neAfter > 0.35, 'ne poked up: ' + neAfter)
console.log('ok 1 fire: signal ' + r1.signal + ', ne -> ' + neAfter)

// ── ② 1s 不应期 ────────────────────────────────────────────────────────
const r2 = reflex.startle({ text: bigMsg }, T0 + 300)
assert.strictEqual(r2.fired, false, 'second bang within 1s is blocked')
assert.strictEqual(r2.why, 'refractory')
assert.strictEqual(readNe(), neAfter, 'no extra ne during refractory')
console.log('ok 2 refractory: blocked at +300ms')

// ── ③ 30s 内第二响减半 ─────────────────────────────────────────────────
const r3 = reflex.startle({ text: bigMsg }, T0 + 15_000)
assert.ok(r3.fired, 'second bang after 15s fires again')
assert.ok(r3.signal < 0.65 * r1.signal && r3.signal > 0.2, `30s-later signal ~halves: ${r3.signal} vs ${r1.signal}`)
console.log('ok 3 habituation: 15s-later signal ' + r3.signal + ' (first ' + r1.signal + ')')

// ── ⑥ 2 分钟复原 ───────────────────────────────────────────────────────
const r4 = reflex.startle({ text: bigMsg }, T0 + 135_000)
assert.ok(r4.signal > 0.7, `recovered after 2min: ${r4.signal}`)
console.log('ok 6 recovery: 2min-later signal ' + r4.signal)

// ── ⑤ 纯内存 ───────────────────────────────────────────────────────────
const dataRoot = process.env.BOT_DATA_DIR
const listing = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else listing.push(p) } }
try { walk(dataRoot) } catch { }
assert.ok(!listing.some((f) => /reflex/i.test(f)), 'no reflex state file: ' + listing.filter((f) => /reflex/i.test(f)).join(','))
assert.ok(reflex.snapshot().threshold === 0.75, 'snapshot exposes threshold')
console.log('ok 5 pure memory: no reflex files, snapshot ok')

console.log('startle-test all green')
