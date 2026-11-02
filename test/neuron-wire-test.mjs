//
// neuron 接线回归测试（2026-11-02）
//
// 这一层原来**完全没接上**：cell/neuron 无状态、无落盘、无推进，
// 五条通路只在测试里从 empty() 算过，真实运行中从未存在。
// 所以这套测试要钉的不是"函数能跑"，而是**接线真的通了**：
//
//   ① 状态能落盘、能读回（否则进程一重启就全新鲜）
//   ② 做事会消耗对应通路（reward 被 watch 用掉）
//   ③ 安静会恢复（不能永久变钝）
//   ④ 五条通路互不影响（这是"五个独立器官"的判据）
//   ⑤ **决策层真的读到了**（desire 会随通路状态变）—— 这条最关键，
//      前四条都通过但这条不通过，等于白接
//   ⑥ 值域永远有限且 0..1（NaN 会让候选表全被过滤，她永远 rest）
//
// 全部用**隔离的临时目录**：neuron 现在会写盘，不隔离就会污染她的真实状态。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neuron-test-'))
process.env.BOT_DATA_DIR = TMP

const neuron = await import('../tools/brain/cell/neuron.mjs')
const self = await import('../tools/brain/organ/self.mjs')
const { neuronPath } = await import('../tools/brain/paths.mjs')

const T0 = Date.now()

// ── 1. 持久化：写盘 + 读回 ──────────────────────────────────────────────
{
  neuron.tick(T0)
  assert.ok(fs.existsSync(neuronPath()), 'neuron.json 应该被创建')

  neuron.act('reward', 1, T0 + 1000)
  const raw = JSON.parse(fs.readFileSync(neuronPath(), 'utf8'))
  assert.ok(raw.paths && raw.paths.reward, '落盘结构里应有 reward 通路')
  assert.ok(raw.paths.reward.rec, '通路状态里应有受体池')

  const back = neuron.load()
  assert.ok(back.paths.reward.rec.out < 1, `读回后 reward 应已被消耗，实际 ${back.paths.reward.rec.out}`)
}

// ── 2. 做事消耗对应通路 ────────────────────────────────────────────────
{
  fs.rmSync(neuronPath(), { force: true })
  neuron.tick(T0)
  const before = neuron.readiness(T0)
  assert.equal(before.reward, 1, '初始 reward 应该是满的')

  for (let i = 0; i < 20; i++) neuron.act('reward', 1.5, T0 + 1000 + i * 60_000)
  const after = neuron.readiness(T0 + 20 * 60_000)
  assert.ok(after.reward < 0.95, `用了 20 次 reward 后应下降，实际 ${after.reward}`)
  assert.ok(after.reward > 0.4, `但不该掉到底（那是损伤不是耐受），实际 ${after.reward}`)
}

// ── 3. 安静会恢复 ──────────────────────────────────────────────────────
{
  const beforeRest = neuron.readiness(T0 + 20 * 60_000)
  neuron.tick(T0 + 20 * 60_000 + 3 * 3600_000)
  const afterRest = neuron.readiness(T0 + 20 * 60_000 + 3 * 3600_000)
  assert.ok(afterRest.reward > beforeRest.reward + 0.05,
    `歇 3 小时应明显恢复：${beforeRest.reward} → ${afterRest.reward}`)
  assert.ok(afterRest.reward > 0.9, `歇够了应接近满，实际 ${afterRest.reward}`)
}

// ── 4. 五条通路互不影响 ────────────────────────────────────────────────
{
  fs.rmSync(neuronPath(), { force: true })
  neuron.tick(T0)
  for (let i = 0; i < 20; i++) neuron.act('social', 1.5, T0 + 1000 + i * 60_000)
  const r = neuron.readiness(T0 + 20 * 60_000)
  assert.ok(r.social < 0.95, `social 应被消耗，实际 ${r.social}`)
  for (const k of ['reward', 'stress', 'explore', 'attach']) {
    assert.equal(r[k], 1, `${k} 不该受 social 影响，实际 ${r[k]}`)
  }
}

// ── 5. **决策层真的读到了**（最关键的一条）─────────────────────────────
{
  const base = {
    field: { sleepDebt: 0.2, fatigue: 0.1, da: 0.5, tension: 0 },
    depth: 0.7,
    sleepy: { score: 10 },
    hasInterrupt: false,
    tension: 0.1,
  }
  const full = { reward: 1, explore: 1, social: 1, stress: 0.3, attach: 1 }

  const hi = self.desire('watch', { ...base, neuro: full })
  const lo = self.desire('watch', { ...base, neuro: { ...full, reward: 0.4 } })
  assert.ok(lo < hi * 0.85,
    `reward 掉到 0.4 时 watch 意愿应明显下降：${hi.toFixed(3)} → ${lo.toFixed(3)}`)

  const bHi = self.desire('browse', { ...base, neuro: full })
  const bLo = self.desire('browse', { ...base, neuro: { ...full, explore: 0.4 } })
  assert.ok(bLo < bHi * 0.9,
    `explore 掉到 0.4 时 browse 意愿应下降：${bHi.toFixed(3)} → ${bLo.toFixed(3)}`)
}

// ── 6. 值域：永远有限、永远 0..1 ───────────────────────────────────────
{
  const cases = [
    { name: '无 neuro（外部调用）', ctx: { field: { sleepDebt: 0.2, fatigue: 0.1, da: 0.5, tension: 0 }, depth: 0.7, sleepy: { score: 10 } } },
    { name: 'neuro 缺字段', ctx: { field: { sleepDebt: 0.2, fatigue: 0.1, da: 0.5, tension: 0 }, depth: 0.7, sleepy: { score: 10 }, neuro: { reward: 0.5 } } },
    { name: 'neuro 全 0', ctx: { field: { sleepDebt: 0.9, fatigue: 0.9, da: 0.1, tension: 5 }, depth: 0.2, sleepy: { score: 90 }, neuro: { reward: 0, explore: 0, social: 0, stress: 1, attach: 0 } } },
  ]
  for (const c of cases) {
    for (const a of ['sleep', 'consolidate', 'reply', 'watch', 'browse', 'write', 'think', 'rest']) {
      const v = self.desire(a, c.ctx)
      assert.ok(Number.isFinite(v), `${c.name} 的 ${a} 不该是 NaN/Infinity，实际 ${v}`)
      assert.ok(v >= 0 && v <= 1, `${c.name} 的 ${a} 应在 0..1，实际 ${v}`)
    }
  }
}

// ── 7. 应激越高，休闲越低（且静息时不白送加成）─────────────────────────
{
  const base = {
    field: { sleepDebt: 0.2, fatigue: 0.1, da: 0.5, tension: 0 },
    depth: 0.7, sleepy: { score: 10 }, tension: 0.1,
  }
  const at = (st) => self.desire('watch', { ...base, neuro: { reward: 1, explore: 1, social: 1, stress: st, attach: 1 } })
  const a = at(0.55), b = at(0.8), c = at(1.0)
  assert.ok(a > b && b > c, `应激越高意愿应单调下降：${a.toFixed(2)} / ${b.toFixed(2)} / ${c.toFixed(2)}`)
  const below = at(0.2)
  assert.ok(a <= below + 0.01, `静息时不该比更低应激时还高：0.55→${a.toFixed(2)} vs 0.2→${below.toFixed(2)}`)
}

// ── 8. 全疲惫时 rest 该占上风 ──────────────────────────────────────────
{
  const base = {
    field: { sleepDebt: 0.2, fatigue: 0.1, da: 0.5, tension: 0 },
    depth: 0.7, sleepy: { score: 10 }, tension: 0.1,
  }
  const tired = { reward: 0.3, explore: 0.3, social: 0.3, stress: 0.5, attach: 0.3 }
  const rest = self.desire('rest', { ...base, neuro: tired })
  const watch = self.desire('watch', { ...base, neuro: tired })
  assert.ok(rest > watch, `五条通路都钝了时 rest 应高于 watch：rest=${rest.toFixed(2)} watch=${watch.toFixed(2)}`)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ neuron-wire-test 全部通过（落盘/消耗/恢复/隔离/接入决策/值域/应激/疲惫偏好）')
