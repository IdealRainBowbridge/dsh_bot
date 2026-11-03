// 能量与消化测试（2026-11-03 · B3）
//
// 器官判据（M57：曲线跑出来才算数）：
//   ① 思考消耗：每条消息烧一点，100 条 ≈ -0.4
//   ② 进食与积压：binge 回充但内容积压，上限 20
//   ③ REM 消化：积压下降、能量回充（时点按 CYCLE 表精确定点：周期 2 的 REM 窗）
//   ④ N3 修复：周期 1 的 N3 窗（19~59min）
//   ⑤ 24h 曲线：白天吃 5 集聊 60 句 → 当晚睡眠消化+回充 → 早上满电
//   ⑥ 饿感措辞（经 API 驱动 + 未来时间戳，绕开读缓存的时间回拨问题）
// 缓存纪律：readState 的 10s 缓存以调用方 now 判定——跨夹具改盘后必须把 now 推过缓存窗。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meta-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

const m = await import('../tools/brain/organ/metabolism.mjs')
const sleepstage = await import('../tools/brain/organ/sleepstage.mjs')
const field = await import('../tools/brain/field.mjs')
const { sleepPath } = await import('../tools/brain/paths.mjs')

function setSleep(inSleep, beganAt, plannedMin = 480, interruptions = 0) {
  fs.mkdirSync(path.dirname(sleepPath()), { recursive: true })
  fs.writeFileSync(sleepPath(), JSON.stringify({ inSleep, beganAt, plannedMin, interruptions }))
}

// ── ① 思考消耗 ──
{
  const s1 = m.snapshot()
  for (let i = 0; i < 4; i++) m.spend(0.004, 1000 + i)
  const s = m.snapshot()
  assert.ok(s.energy < s1.energy && s.messages === 4, '每条消息消耗在账（snapshot 拍平输出）')
  for (let i = 0; i < 96; i++) m.spend(0.004, 2000 + i)
  assert.ok(Math.abs(m.snapshot().energy - (s1.energy - 0.4)) < 0.01, '100 条 ≈ -0.4: ' + m.snapshot().energy.toFixed(3))
}

// ── ② 进食与积压 ──
{
  const before = m.snapshot()
  m.eat(0.12, 10_000)
  const after = m.snapshot()
  assert.ok(after.energy > before.energy, '进食回充')
  assert.equal(after.pendingDigest, 1, '内容积压 +1')
  for (let i = 0; i < 30; i++) m.eat(0.12, 11_000 + i)
  assert.ok(m.snapshot().pendingDigest <= 20, '积压封顶 20')
}

// ── ③ REM 消化（beganAt=-170min → 周期 2 的 REM 窗 [157,184]min）──
{
  setSleep(true, Date.now() - 170 * 60_000)
  const st = sleepstage.currentStage(Date.now())
  assert.equal(st.stage, 'REM', '夹具：此刻应为 REM（实得 ' + st.stage + '）')
  m.spend(0.5, Date.now() + 61_000)    // 能量降到 cap 以下——满电时回充看不见（cap 吞增量）
  m.tick(Date.now() + 62_000)          // 预热：lastTickAt 从 0 变为有值（首调只记账不演化）
  const b = m.snapshot()
  m.tick(Date.now() + 122_000)         // dt=60s：消化 0.12 条 → 回充 0.0012，恰好过 snapshot 的 3 位小数分辨率
  const a = m.snapshot()
  assert.ok(a.pendingDigest < b.pendingDigest, 'REM 消化积压: ' + b.pendingDigest + ' → ' + a.pendingDigest.toFixed(2))
  assert.ok(a.energy > b.energy, '消化产物回充（「学到了」）: ' + b.energy + ' → ' + a.energy)
}

// ── ④ N3 修复（beganAt=-35min → 周期 1 的 N3 窗 [19,59]min）──
{
  setSleep(true, Date.now() - 35 * 60_000)
  const st = sleepstage.currentStage(Date.now())
  assert.equal(st.stage, 'N3', '夹具：此刻应为 N3（实得 ' + st.stage + '）')
  const b = m.snapshot()
  m.tick(Date.now() + 167_000)         // dt=45s：修复 0.001875，过 3 位小数分辨率
  const a = m.snapshot()
  assert.ok(a.energy > b.energy, 'N3 修复回血: ' + b.energy + ' → ' + a.energy)
}

// ── ⑤ 24h 曲线 ──
{
  const t0 = Date.now() + 300_000      // 起点放未来 5 分钟：readState 的 10s 缓存窗必失效，才会重读盘上的清零态
  fs.writeFileSync(path.join(TMP, 'metabolism.json'), JSON.stringify({
    energy: 1.0, pendingDigest: 0, lastTickAt: t0, stats: { messages: 0, binges: 0, digested: 0 },
  }))
  let t = t0
  const curve = []
  for (let h = 0; h < 16; h++) {       // 白天 16h：每小时 4 句 + 每 3h 一集
    for (let i = 0; i < 4; i++) { t += 15 * 60_000; m.spend(0.004, t) }
    if (h % 3 === 2) m.eat(0.12, t)
    m.tick(t)
    if (h % 2 === 0) curve.push('白' + h + 'h:' + m.snapshot().energy.toFixed(2) + '/' + m.snapshot().pendingDigest.toFixed(1))
  }
  setSleep(true, t)                    // 夜里 8h，每 30min 一拍
  for (let h = 0; h < 8; h++) {
    t += 30 * 60_000
    m.tick(t)
    if (h % 2 === 1) curve.push('夜' + (h + 1) + 'h:' + m.snapshot().energy.toFixed(2) + '/' + m.snapshot().pendingDigest.toFixed(1))
  }
  const end = m.snapshot()
  console.log('   24h 曲线（能量/积压）: ' + curve.join(' · '))
  assert.ok(end.energy > 0.75, '一夜好眠 → 早上电量回升（' + end.energy.toFixed(2) + '）')
  assert.ok(end.pendingDigest < 3, '积压被 REM 消化掉（' + end.pendingDigest.toFixed(1) + '）')
}

// ── ⑥ 饿感（API 驱动，时间戳推到 ⑤ 之后 1h —— 缓存窗必失效）──
{
  const later = Date.now() + 25 * 3600_000
  for (let i = 0; i < 5; i++) m.eat(0.12, later + i)     // 积压 5
  m.spend(0.8, later + 10)                                // 能量打到 0.2
  const s = m.sense()
  assert.ok(s.includes('饿') && s.includes('消化'), '饿感+积压感: ' + s)
  assert.ok(field.sense().includes('饿'), '饿感进入第一人称身体感')
}

// ── ⑦ llmState 契约（说话链路的身体接口 · 2026-11-03 晚）：永不抛错，没意见给 null ──
{
  const a = m.llmState()
  assert.ok(a === null || typeof a === 'object', 'llmState 返回 null 或对象')
  const t7 = Date.now() + 27 * 3600_000
  m.spend(0.5, t7)                       // 接在 ⑥ 之后继续消耗（能量打到 0 附近）
  const s7 = m.llmState()
  assert.ok(s7 && typeof s7.temperature === 'number' && s7.temperature < 0 && typeof s7.note === 'string' && s7.note.length > 0,
    '低电量 → 降温 + 体感备注: ' + JSON.stringify(s7))
}

console.log('metabolism-test: 7 组断言全过（思考消耗/进食积压/REM消化/N3修复/24h曲线/饿感/llmState契约）')
