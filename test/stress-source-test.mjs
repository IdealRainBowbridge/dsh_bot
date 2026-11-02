//
// stress 通路的三个刺激源 + 两个时间尺度（2026-11-02）
//
// 这套要钉三件事：
//
//   ① **方向不能反**：stress 是"她自己搞砸了/答应的事没做到"，
//      不是"用户说他难受"。后者是共情（affect.valence），不是她被施压。
//
//   ② **两个时间尺度必须分开**：
//      · 突触池（14 秒回满）→ "连续被批评时反应变钝"
//      · 情绪余味（cortisol，10 小时）→ "被骂一句，一上午都闷"
//      如果只有前者，一次挫折 15 分钟就忘干净 —— 那不叫压力。
//
//   ③ **不能永久变钝**：压力再重也该有退路，否则她会在挫败后
//      长期什么都做不动（那是抑郁，不是应激）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-test-'))
process.env.BOT_DATA_DIR = TMP

const neuron = await import('../tools/brain/cell/neuron.mjs')
const field = await import('../tools/brain/field.mjs')
const self = await import('../tools/brain/organ/self.mjs')
const promises = await import('../tools/lib/promises.mjs')

const NOW = Date.now()
neuron.tick(NOW)
field.snapshot()

// ── 1. 承诺失败 → stress 被消耗 ────────────────────────────────────────
{
  const p = promises.add('测试：看第 2 集', { what: '看第 2 集', dueMin: 5 })
  assert.ok(p?.id, '承诺应该能创建')
  const before = neuron.readiness(NOW).stress
  promises.fail(p.id, '材料不足')
  const after = neuron.readiness(NOW).stress
  assert.ok(after < before, `承诺失败后 stress 应下降：${before} → ${after}`)
  assert.ok(after > 0.6, `一次失败不该打到 0.6 以下（那是崩溃不是挫折），实际 ${after}`)
}

// ── 2. 多次失败会累积 ─────────────────────────────────────────────────
{
  for (let i = 0; i < 4; i++) {
    const q = promises.add('测试' + i, { what: '测试' + i, dueMin: 5 })
    if (q?.id) promises.fail(q.id, 'x')
  }
  const s = neuron.readiness(NOW).stress
  assert.ok(s < 0.5, `连续失败应明显压低 stress，实际 ${s}`)
}

// ── 3. 突触（快）恢复 ─────────────────────────────────────────────────
{
  neuron.tick(NOW + 15 * 60_000)
  const s = neuron.readiness(NOW + 15 * 60_000).stress
  assert.ok(s > 0.95, `突触池 15 分钟应基本恢复，实际 ${s}`)
}

// ── 4. 情绪（慢）余味：cortisol 必须仍高于基线 ────────────────────────
{
  const c = field.snapshot().dims.cortisol
  assert.ok(c > 0.17,
    `多次失败后 cortisol 应高于基线 0.15，实际 ${c}（说明压力没有余味）`)
}

// ── 5. 同步性：act() 返回后立刻能读到 cortisol 变化 ───────────────────
{
  fs.rmSync(path.join(TMP, 'brain', 'meta', 'field.json'), { force: true })
  field.snapshot()
  const before = field.snapshot().dims.cortisol
  neuron.act('stress', 1, NOW + 20 * 60_000)
  const after = field.snapshot().dims.cortisol
  assert.ok(after > before,
    `act('stress') 返回后立刻读就该变（不能是异步）：${before} → ${after}`)
}

// ── 6. 应激高 → 休闲被压制，但不能压到 0 ──────────────────────────────
{
  const base = {
    field: { sleepDebt: 0.2, fatigue: 0.1, da: 0.5, tension: 0 },
    depth: 0.7, sleepy: { score: 10 }, tension: 0.1,
  }
  const calm = { reward: 1, explore: 1, social: 1, stress: 0.3, attach: 1 }
  const stressed = { reward: 1, explore: 1, social: 1, stress: 1.0, attach: 1 }

  const wCalm = self.desire('watch', { ...base, neuro: calm })
  const wStress = self.desire('watch', { ...base, neuro: stressed })
  assert.ok(wStress < wCalm * 0.8,
    `应激高时看番意愿应明显下降：${wCalm.toFixed(2)} → ${wStress.toFixed(2)}`)
  assert.ok(wStress > 0.05, `不该压到 0（那是"什么都不想做"）：${wStress.toFixed(3)}`)
}

// ── 7. 恢复后回到基线（不能永久变钝）──────────────────────────────────
{
  const T2 = NOW + 24 * 3600_000
  neuron.tick(T2)
  const s = neuron.readiness(T2).stress
  assert.ok(s > 0.98, `24 小时后 stress 应完全恢复，实际 ${s}`)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ stress-source-test 全部通过（承诺失败→stress / 快慢两个尺度 / 同步性 / 压制休闲 / 可恢复）')
