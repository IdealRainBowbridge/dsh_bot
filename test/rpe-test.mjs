// rpe-test —— C3 DA 预期端（2026-11-03）
//
// 器官判据（M58）：
//   ① 固定 reward 流：expected 学起来，RPE 收敛 -> 0（天天的问候不再额外飙升）
//   ② 突然停供：1.5x 常规间隔后出一次负脉冲（da 下行），且只出一次（静默锁）
//   ③ 重现：负脉冲锁翻篇，actual>expected 再出正误差
//   ④ 不在意来源（care<0.5）：停供不出负脉冲（不空落）
//   ⑤ 预期状态落盘：重启（重 import）后 expected 还在（髓鞘化纪律）
//   ⑥ 主人身份带来的 care 基线：owner 默认 1，普通来源缺省 0.5
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c3-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

const { neuronPath, fieldPath } = await import('../tools/brain/paths.mjs')

const neuron = await import('../tools/brain/cell/neuron.mjs')
const field = await import('../tools/brain/field.mjs')

const T0 = 1_700_000_000_000
const IVL = 30 * 60_000

// da 维读数（纯读文件，不 evolve —— 只看 rpe poke 的净位移）
function readDa() { return Number(JSON.parse(fs.readFileSync(fieldPath(), 'utf8')).dims.da) }
function resetDa() {
  let j = null
  try { j = JSON.parse(fs.readFileSync(fieldPath(), 'utf8')) } catch { j = null }
  if (!j || typeof j !== 'object' || !j.dims) j = { at: 0, dims: {} }
  j.dims = { ...j.dims, da: 0.5 }
  fs.mkdirSync(path.dirname(fieldPath()), { recursive: true })
  fs.writeFileSync(fieldPath(), JSON.stringify(j))
}

// ── ① 固定流收敛 ────────────────────────────────────────────────────────
resetDa()
const t0 = T0
let r = neuron.rpe(0.6, { source: 'owner', care: 1, now: t0 })
assert.ok(r.err > 0.5, 'first ever hit is full surprise, err=' + r.err)
const daAfterFirst = readDa()
assert.ok(daAfterFirst > 0.5 + 0.04, 'first hit pokes da up, da=' + daAfterFirst)
let last
for (let i = 1; i <= 30; i++) last = neuron.rpe(0.6, { source: 'owner', care: 1, now: t0 + i * IVL })
assert.ok(Math.abs(last.err) < 0.05, 'steady stream -> RPE converges to 0, err=' + last.err)
const daSteady = readDa()
assert.ok(daSteady < daAfterFirst + 0.0001, 'no extra da from predictable hits, da=' + daSteady)
console.log('ok 1 steady stream: err ' + r.err.toFixed(2) + ' -> ' + last.err.toFixed(3) + ', da flat after first hit')

// ── ② 停供负脉冲（经 tick 漏供检查，静默锁只响一次）─────────────────────
resetDa()
const tLast = t0 + 30 * IVL
const silentUntil = tLast + Math.max(45 * 60_000, 1.5 * IVL) + 60_000
// 模拟心跳：先踩漏供线（tick 内部做演化 + 检查）
neuron.tick(silentUntil)
const daDip = readDa()
assert.ok(daDip < 0.5 - 0.03, 'omission fires negative da pulse, da=' + daDip)
// 继续多拍：静默锁保证不再响
for (let i = 1; i <= 5; i++) neuron.tick(silentUntil + i * 30 * 60_000)
assert.strictEqual(readDa(), daDip, 'omission fires once only (pendingNeg lock)')
console.log('ok 2 omission: da ' + daDip.toFixed(3) + ' once, then silent')

// ── ③ 重现翻篇 ──────────────────────────────────────────────────────────
resetDa()
r = neuron.rpe(0.6, { source: 'owner', care: 1, now: silentUntil + 6 * 3600_000 })
assert.ok(r.err > 0.2, 'return after long gap is surprise again, err=' + r.err)
const st3 = JSON.parse(fs.readFileSync(neuronPath(), 'utf8'))
assert.strictEqual(st3.rpe.owner.pendingNeg, false, 'pendingNeg cleared on return')
console.log('ok 3 return: err ' + r.err.toFixed(2) + ', lock cleared')

// ── ④ 不在意来源不空落 ──────────────────────────────────────────────────
resetDa()
const tb = T0 + 1000
neuron.rpe(0.6, { source: 'stranger', care: 0.4, now: tb })
neuron.rpe(0.6, { source: 'stranger', care: 0.4, now: tb + IVL })
neuron.tick(tb + IVL + 3 * 3600_000)
assert.strictEqual(readDa(), 0.5, 'un-cared source going silent does not dip')
console.log('ok 4 un-cared omission: silent')

// ── ⑤ 预期落盘（重启 = 重新 load）───────────────────────────────────────
{
  const raw = JSON.parse(fs.readFileSync(neuronPath(), 'utf8'))
  assert.ok(raw.rpe && raw.rpe.owner && Number(raw.rpe.owner.es) > 0.3, 'expectation persisted, es=' + (raw.rpe?.owner?.es))
}
// fresh import = 模拟重启（同进程内再 import 是缓存的，直接读文件对账）
const persisted = JSON.parse(fs.readFileSync(neuronPath(), 'utf8')).rpe.owner
const probe = neuron.rpe(0.6, { source: 'owner', care: 1, now: T0 + 1000 * IVL })
const expectedFromDisk = 0.5 * persisted.ef + 0.5 * persisted.es
assert.ok(Math.abs(probe.err - (0.6 - expectedFromDisk)) < 0.2, 'expectation survives restart accounting, err=' + probe.err)
console.log('ok 5 persistence: disk es=' + persisted.es.toFixed(3) + ', next err ' + probe.err.toFixed(3))

// ── ⑥ care 缺省 ─────────────────────────────────────────────────────────
const res = neuron.rpe(0.5, { source: 'whoever', now: T0 + 2000 * IVL })
assert.strictEqual(res.care, 0.5, 'default care 0.5')
console.log('ok 6 default care: 0.5')

console.log('rpe-test all green')
