// 伤口愈合测试（2026-11-03 · A2）
//
// 器官判据（M58）：单独拿出来能演出现象——
//   「同样的错反复出现，而没有人记得它出现过」→ 现在能记住了。
//   ① 登记：损伤开账（幂等，同源不重开）
//   ② 化脓：开放超 6h 无人管 → infected（疼要被感觉到）
//   ③ 愈合：全身检查通过（门禁全绿路径）→ 全部愈合 + 瘢痕沉淀
//   ④ 瘢痕记忆：同类损伤再次出现 → 旧伤复发被认出（瘢痕组织比原组织强）
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-wound-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

const { register, tick, closeIfHealed, woundSnapshot } = await import('../tools/lib/wound.mjs')

// ── ① 登记 + 幂等 ──
{
  const a = register('熔断', 'fb1', 'LLM HTTP 429: rate limited')
  assert.ok(a.id && a.state === 'open' && !a.recurrent, '首次登记：open')
  const b = register('熔断', 'FB1 ', '又跳了一次')   // 同源（大小写/空格归一）
  assert.equal(b.id, a.id, '同源损伤不重开（幂等）')
  assert.equal(b.state, 'existing', '命中现有伤口')
  const c = register('熔断', 'fb2', '另一个通道')
  assert.notEqual(c.id, a.id, '不同通道是另一处伤')
  const snap = woundSnapshot()
  assert.equal(snap.open, 2, '两处开放伤口在账')
}

// ── ② 化脓 ──
{
  const now = Date.now()
  const r1 = tick(now)
  assert.ok(r1 && r1.open === 2 && r1.infected.length === 0, '6h 内巡视：开放但不化脓')
  // 把第一处伤的 openedAt 回拨 7 小时（模拟时间流逝）
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'wounds.json'), 'utf8'))
  raw.wounds.find((w) => w.subject === 'fb1').openedAt = now - 7 * 3600_000
  fs.writeFileSync(path.join(TMP, 'wounds.json'), JSON.stringify(raw))
  // 缓存 10s 窗口内会读到旧态——直接推时间跳过缓存
  const r2 = tick(now + 20_000)
  assert.ok(r2.infected.length === 1 && r2.infected[0].includes('fb1'), '超时伤口 → 化脓: ' + r2.infected[0])
  assert.ok(woundSnapshot().infected.some((x) => x.includes('fb1')), 'snapshot 报化脓（diagnose 会挂红）')
}

// ── ③ 愈合 + 瘢痕 ──
{
  const r = closeIfHealed('feat(xxx): 修复 fb1 限流处理')
  assert.equal(r.closed, 2, '全身检查通过 → 两处伤口全部愈合')
  assert.equal(r.scarred, 2, '瘢痕沉淀 2 条')
  const snap = woundSnapshot()
  assert.equal(snap.open, 0, '无开放损伤')
  assert.equal(snap.scars, 2, '瘢痕在库')
}

// ── ④ 旧伤复发 ──
{
  const again = register('熔断', 'fb1', '同一个坑再摔一次')
  assert.ok(again.recurrent === true, '旧伤复发被认出（瘢痕组织比原组织强）')
  const fresh = register('门禁', 'qq-server.mjs 超行', 'FILE_LIMIT')
  assert.ok(!fresh.recurrent, '新位置新伤：不是复发')
  assert.equal(woundSnapshot().recurrent >= 1, true, '复发计数在账')
}

console.log('wound-test: 4 组断言全过（登记幂等/化脓/愈合瘢痕/旧伤复发）')
