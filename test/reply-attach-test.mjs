//
// social → reply / attach → 丘脑门槛（2026-11-02）
//
// 这两条通路是 M78 之后剩下的最后两条。它们的性质不同，测试重点也不同：
//
//   social → reply   ：**不能把回话变没**。有人等着就必须回，
//                      只是回得短、回得慢。所以测的是"下限"，不是"能压多低"。
//   attach → owner门 ：**不能变成冷暴力**。心里再远，他也得听得见。
//                      所以测的是"幅度上限"，不是"能抬多高"。
//
// 这两条如果写反了（social 把 reply 压到 0 / attach 把门槛抬到 3 倍），
// 代码不会崩、日志不会报错，但她的行为会变成"该回的不回"和"听不见他"。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-attach-test-'))
process.env.BOT_DATA_DIR = TMP

const self = await import('../tools/brain/organ/self.mjs')
const thal = await import('../tools/brain/organ/thalamus.mjs')
const neuron = await import('../tools/brain/cell/neuron.mjs')
const { neuronPath } = await import('../tools/brain/paths.mjs')

const NOW = Date.now()
const base = {
  field: { sleepDebt: 0.2, fatigue: 0.1, da: 0.5, tension: 0 },
  depth: 0.7, sleepy: { score: 10 }, tension: 0.1, hasInterrupt: true,
}
const full = { reward: 1, explore: 1, social: 1, stress: 0.3, attach: 1 }

// ── 1. 没人等着时，reply 必须是 0 ───────────────────────────────────────
assert.equal(self.desire('reply', { ...base, hasInterrupt: false, neuro: full }), 0,
  '没人等着时不该想回话')

// ── 2. social 钝了，reply 要降 —— 但不能消失 ───────────────────────────
{
  const hi = self.desire('reply', { ...base, neuro: { ...full, social: 1 } })
  const lo = self.desire('reply', { ...base, neuro: { ...full, social: 0 } })
  assert.ok(lo < hi, `social 钝了 reply 应该降：${hi.toFixed(2)} → ${lo.toFixed(2)}`)
  assert.ok(lo >= 0.3,
    `social 归零时 reply 不该低于 0.3（有人等着就必须回），实际 ${lo.toFixed(3)}`)
}

// ── 3. social 必须单调 ─────────────────────────────────────────────────
{
  const seq = [0, 0.25, 0.5, 0.75, 1].map((s) =>
    self.desire('reply', { ...base, neuro: { ...full, social: s } }))
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] >= seq[i - 1] - 1e-9,
      `social 越高 reply 应该越高：${seq.map((x) => x.toFixed(2)).join(' → ')}`)
  }
}

// ── 4. attach 钝了，owner 门槛要抬高 ───────────────────────────────────
{
  fs.rmSync(neuronPath(), { force: true })
  neuron.tick(NOW)
  const clean = thal.admit({ channel: 'owner', strength: 0.4, salience: 0, now: NOW + 1000 })

  for (let i = 0; i < 200; i++) neuron.act('attach', 2, NOW + 2000 + i * 100)
  const tired = thal.admit({ channel: 'owner', strength: 0.4, salience: 0, now: NOW + 30_000 })

  assert.ok(tired.threshold > clean.threshold,
    `attach 钝了 owner 门槛应该更高：${clean.threshold} → ${tired.threshold}`)
}

// ── 5. 但抬幅必须有上限 —— 不能变成冷暴力 ─────────────────────────────
{
  fs.rmSync(neuronPath(), { force: true })
  neuron.tick(NOW)
  const clean = thal.admit({ channel: 'owner', strength: 0.4, salience: 0, now: NOW + 1000 })

  for (let i = 0; i < 200; i++) neuron.act('attach', 2, NOW + 2000 + i * 100)

  const tired = thal.admit({ channel: 'owner', strength: 0.4, salience: 0, now: NOW + 30_000 })
  const ratio = tired.threshold / clean.threshold

  assert.ok(ratio <= 1.30,
    `attach 归零时 owner 门槛最多抬 30%，实际抬了 ${((ratio - 1) * 100).toFixed(1)}%`)
  assert.ok(ratio >= 1.05,
    `但也要有可感知的影响（至少 5%），实际 ${((ratio - 1) * 100).toFixed(1)}%`)

  assert.ok(tired.pass,
    `attach 归零时他说一句普通的话也必须进得来（否则是冷暴力）：` +
    `effective=${tired.effective} threshold=${tired.threshold}`)
}

// ── 6. attach 只影响 owner 通道 ────────────────────────────────────────
{
  fs.rmSync(neuronPath(), { force: true })
  neuron.tick(NOW)
  const groupClean = thal.admit({ channel: 'group', strength: 0.4, salience: 0, now: NOW + 1000 })
  for (let i = 0; i < 200; i++) neuron.act('attach', 2, NOW + 2000 + i * 100)
  const groupTired = thal.admit({ channel: 'group', strength: 0.4, salience: 0, now: NOW + 30_000 })

  assert.equal(groupTired.threshold, groupClean.threshold,
    `attach 不该影响 group 通道的门槛：${groupClean.threshold} → ${groupTired.threshold}`)
}

// ── 7. 值域 ────────────────────────────────────────────────────────────
{
  for (const soc of [0, 0.5, 1, undefined]) {
    const v = self.desire('reply', { ...base, neuro: { ...full, social: soc } })
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1,
      `social=${soc} 时 reply 应在 0..1，实际 ${v}`)
  }
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ reply-attach-test 全部通过（social→reply 有下限 / attach→owner 门槛有上限 / 通道隔离 / 值域）')
