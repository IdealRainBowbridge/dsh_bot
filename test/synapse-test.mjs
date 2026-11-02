//
// synapse / neuron 的标定回归测试（2026-11-02）
//
// 这套测的是**生理曲线的形状**，不是"函数能跑"。
// 为什么必须测形状：这一层最容易出现"有值、不报错、判定正常，但曲线完全是假的"。
// 本项目已经踩过同类（M57 记录），其中一次就是：
//   钙增益 0.55 × 钙量 0.25 = +14%，而池子消耗 0.5 × 0.42 = -21%
//   → **易化分支从来没被触发过**，而代码看起来完全正常。
//
// 所以这里的每条断言都是"对着真实生理数值定的"，不是对着当前实现定的。
// 参数依据标注：RRP 补充 1~10 秒、paired-pulse 1.5~2.5× 是**我的记忆/推断**，
// 未逐一查证文献。但相对形状（易化→抑制→恢复）是突触生物学的共识。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-test-'))
process.env.BOT_DATA_DIR = TMP

const syn = await import('../tools/brain/micro/synapse.mjs')
const neuron = await import('../tools/brain/cell/neuron.mjs')

/** 按真实用法跑一次双脉冲（间隔 gap 秒，两发），返回第二发/第一发。 */
function pairedPulse(gapSec) {
  let s = syn.empty()
  const r1 = syn.fire(s, 1)
  s = syn.rest(r1.s, gapSec * 1000)
  const r2 = syn.fire(s, 1)
  return r2.released / r1.released
}

// ── 1. 双脉冲易化（短间隔必须 >1，这是"越说越上头"）────────────────────
{
  const r = pairedPulse(0.2)
  assert.ok(r >= 1.5 && r <= 2.5, `0.2s 应易化 1.5~2.5×，实际 ${r.toFixed(2)}`)
}
{
  const r = pairedPulse(0.5)
  assert.ok(r > 1.2, `0.5s 仍应易化，实际 ${r.toFixed(2)}`)
}

// ── 2. 短时程抑制（几秒间隔要略降，这是"说多了变淡"）──────────────────
{
  const r = pairedPulse(5)
  assert.ok(r >= 0.85 && r <= 0.95, `5s 应轻度抑制 0.85~0.95，实际 ${r.toFixed(2)}`)
}

// ── 3. 恢复（间隔够长必须回到 1.0，否则是"永久变钝"）──────────────────
{
  const r = pairedPulse(60)
  assert.ok(r > 0.97, `60s 应回到基线，实际 ${r.toFixed(2)}`)
}
{
  const r = pairedPulse(300)
  assert.ok(Math.abs(r - 1) < 0.02, `300s 应完全恢复，实际 ${r.toFixed(2)}`)
}

// ── 4. 形状：必须是「先降后升」的 V 形，不是单调
//
// ⚠️ 这条最初写成了"单调下降"，测试红了才发现是**我写错断言**，不是代码错。
//   真实突触就是 V 形：两个过程在不同时间尺度上占优 ——
//     · 短间隔（<2s）：残余钙占优 → 易化（比值 >1）
//     · 中隔间（3~15s）：池耗竭占优 → 抑制（比值 <1，谷底）
//     · 长间隔（>30s）：两者都恢复 → 回到 1
//   所以正确的不变量是「存在一个谷底，且两端都高于谷底」。
{
  const seq = [0.2, 1, 5, 10, 30, 300].map(pairedPulse)
  const minIdx = seq.indexOf(Math.min(...seq))
  assert.ok(minIdx > 0 && minIdx < seq.length - 1,
    `谷底应在中间而不是端点，实际序列 ${seq.map((x) => x.toFixed(2)).join(' → ')}`)
  // 短端（易化）必须高于谷底
  assert.ok(seq[0] > seq[minIdx] + 0.3,
    `0.2s 应明显高于谷底，实际 ${seq[0].toFixed(2)} vs ${seq[minIdx].toFixed(2)}`)
  // 长端（恢复）必须高于谷底
  assert.ok(seq[seq.length - 1] > seq[minIdx] + 0.05,
    `300s 应高于谷底，实际 ${seq[seq.length - 1].toFixed(2)} vs ${seq[minIdx].toFixed(2)}`)
  // 谷底本身必须在"轻度抑制"范围，不能塌到底
  assert.ok(seq[minIdx] >= 0.85,
    `谷底不该塌到 0.85 以下（那是"说几句就哑"），实际 ${seq[minIdx].toFixed(2)}`)
}

// ── 5. 稳态：正常对话节奏（5 秒一句）连说 20 句，不能塌到底 ────────────
//      这是重标定 refillTau 的直接原因：45 秒时塌到 0.156（"说十句就哑"），
//      8 秒时保留 ~82%。
{
  let s = syn.empty()
  let last = 0
  for (let i = 0; i < 20; i++) {
    if (i > 0) s = syn.rest(s, 5000)
    const r = syn.fire(s, 1)
    s = r.s
    last = r.released
  }
  const base = syn.DEFAULT.releaseBase
  assert.ok(last / base > 0.6,
    `5s 间隔连说 20 句后应保留 60% 以上，实际 ${(last / base * 100).toFixed(0)}%`)
}

// ── 6. 受体：真实节奏下，长对话才变钝，且能恢复 ─────────────────────────
{
  const rounds = (n, gapSec = 30) => {
    let s = neuron.empty()
    for (let i = 0; i < n; i++) {
      s = neuron.stimulate(s, 'social', 1).st
      s = neuron.rest(s, gapSec * 1000)
    }
    return neuron.read(s, 'social')
  }
  const r1 = rounds(1)
  assert.ok(r1.capacity >= 0.98, `聊 1 轮应几乎不变钝，实际 ${r1.capacity}`)

  const r40 = rounds(40)
  assert.ok(r40.capacity >= 0.78 && r40.capacity <= 0.90,
    `聊 40 轮应变"有点钝"（0.78~0.90），实际 ${r40.capacity}`)
  // 关键：不能掉到底 —— 掉到底说明把"一次交互"当成了"一小时刺激"
  assert.ok(r40.capacity > 0.7,
    `40 轮不该掉到 0.7 以下（那是损伤不是耐受），实际 ${r40.capacity}`)

  // 歇 2 小时要基本恢复
  let s = neuron.empty()
  for (let i = 0; i < 40; i++) { s = neuron.stimulate(s, 'social', 1).st; s = neuron.rest(s, 30_000) }
  s = neuron.rest(s, 2 * 3600_000)
  assert.ok(neuron.read(s, 'social').capacity > 0.93,
    `歇 2 小时应恢复到 0.93 以上，实际 ${neuron.read(s, 'social').capacity}`)
}

// ── 7. 五条通路必须完全隔离（用一条不影响其他）─────────────────────────
//      这是"五个独立器官"而不是"一个变量五个名字"的判据。
{
  let s = neuron.empty()
  for (let i = 0; i < 40; i++) { s = neuron.stimulate(s, 'social', 1).st; s = neuron.rest(s, 30_000) }
  const socialCap = neuron.read(s, 'social').capacity
  assert.ok(socialCap < 0.95, `social 应该被消耗了，实际 ${socialCap}`)
  for (const k of ['reward', 'stress', 'explore', 'attach']) {
    const cap = neuron.read(s, k).capacity
    assert.equal(cap, 1, `${k} 应完全不受 social 影响，实际 ${cap}（说明通路没隔离）`)
  }
}

// ── 8. 参数关系自洽（防止只改一个把形状带歪）─────────────────────────
{
  const p = syn.DEFAULT
  assert.ok(p.refillTau >= 1000 && p.refillTau <= 30_000,
    `refillTau 应在 1~30 秒（RRP 量级），实际 ${p.refillTau}ms`)
  assert.ok(p.consume >= 0.1 && p.consume <= 0.35,
    `consume 应在 0.10~0.35（真实 10~25%），实际 ${p.consume}`)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ synapse-test 全部通过（双脉冲易化/STD/恢复/单调性/稳态/受体耐受/通路隔离/参数自洽）')
