// 能量与消化测试（2026-11-03 · B3）
//
// 器官判据（M57：曲线跑出来才算数）：
//   ① 思考消耗：emit 咽喉每条消息烧一点，100 条 ≈ -0.4
//   ② 进食与积压：binge 回充但内容积压——看了不吃亏，吃了不消化会胀
//   ③ REM 消化：积压下降、能量回充（「学到了」）
//   ④ N3 修复：无积压时单纯回血
//   ⑤ 24h 曲线：白天吃 5 集聊 60 句 → 当晚睡眠消化+回满 → 早上满电
//      （对照：只吃不睡 → 积压顶格 + 能量被清醒代谢磨掉——「熬夜积食」的形状）
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

// 造一个睡眠态文件（currentStage 读它）
const SLEEP = path.join(TMP, 'sleep-state.json')
function setSleep(inSleep, beganAt, plannedMin = 480, interruptions = 0) {
  fs.writeFileSync(SLEEP, JSON.stringify({ inSleep, beganAt, plannedMin, interruptions }))
}

// ── ① 思考消耗 ──
{
  m.spend(0.004, 1000)
  m.spend(0.004, 2000)
  const s1 = m.snapshot()
  m.spend(0.004, 3000)
  m.spend(0.004, 4000)
  const s = m.snapshot()
  assert.ok(s.energy < s1.energy && s.stats.messages === 4, '每条消息消耗在账')
  // 100 条的量级
  for (let i = 0; i < 96; i++) m.spend(0.004, 5000 + i)
  assert.ok(Math.abs(m.snapshot().energy - (1 - 0.4)) < 0.01, '100 条 ≈ -0.4：' + m.snapshot().energy.toFixed(3))
}

// ── ② 进食与积压 ──
{
  const before = m.snapshot()
  m.eat(0.12, 10_000)
  const after = m.snapshot()
  assert.ok(after.energy > before.energy, '进食回充')
  assert.equal(after.pendingDigest, 1, '内容积压 +1')
  // 积压上限
  for (let i = 0; i < 30; i++) m.eat(0.12, 11_000 + i)
  assert.ok(m.snapshot().pendingDigest <= 20, '积压封顶 20（吃不下更多了）')
}

// ── ③ REM 消化 ──
{
  // 造睡态：30 分钟前入睡（accrual 曲线早段是 N1/N2，REM 要到周期后段——
  // 直接把 beganAt 拉到第 80 分钟附近，按 CYCLE 表此刻应为 REM）
  setSleep(true, Date.now() - 80 * 60_000)
  const st = sleepstage.currentStage(Date.now())
  assert.equal(st.stage, 'REM', '夹具：此刻应为 REM（实得 ' + st.stage + '）')
  const b = m.snapshot()
  m.tick(Date.now())
  const a = m.snapshot()
  assert.ok(a.pendingDigest < b.pendingDigest, 'REM 消化积压: ' + b.pendingDigest + ' → ' + a.pendingDigest.toFixed(2))
  assert.ok(a.energy > b.energy, '消化产物回充（「学到了」）')
}

// ── ④ N3 修复 ──
{
  setSleep(true, Date.now() - 20 * 60_000)   // 早段 = N3
  const st = sleepstage.currentStage(Date.now())
  assert.equal(st.stage, 'N3', '夹具：此刻应为 N3（实得 ' + st.stage + '）')
  const b = m.snapshot()
  m.tick(Date.now())
  const a = m.snapshot()
  assert.ok(a.energy > b.energy, 'N3 修复回血')
}

// ── ⑤ 24h 曲线（M57：打出来才算数）──
{
  // 从零开始：清状态文件 + 清缓存（新进程做不到，直接重写文件并推时间过缓存窗）
  const t0 = Date.now()
  fs.writeFileSync(path.join(TMP, 'metabolism.json'), JSON.stringify({
    energy: 1.0, pendingDigest: 0, lastTickAt: t0, stats: { messages: 0, binges: 0, digested: 0 },
  }))
  let t = t0
  const curve = []
  // 白天 16h：聊 60 句 + 看 5 集（每 3h 采样）
  for (let h = 0; h < 16; h++) {
    for (let i = 0; i < 4; i++) { t += 15 * 60_000; m.spend(0.004, t) }   // 每小时 4 句
    if (h % 3 === 2) m.eat(0.12, t)                                        // 每 3h 吃一集
    m.tick(t)
    if (h % 2 === 0) curve.push('白' + h + 'h:' + m.snapshot().energy.toFixed(2) + '/' + m.snapshot().pendingDigest.toFixed(1))
  }
  // 夜里 8h 睡眠（每 30min tick 一次）
  setSleep(true, t)
  for (let h = 0; h < 8; h++) { t += 30 * 60_000; m.tick(t); if (h % 2 === 1) curve.push('夜' + (h + 1) + 'h:' + m.snapshot().energy.toFixed(2) + '/' + m.snapshot().pendingDigest.toFixed(1)) }
  const end = m.snapshot()
  console.log('   24h 血糖曲线（能量/积压）: ' + curve.join(' · '))
  assert.ok(end.energy > 0.75, '一夜好眠 → 早上电量回升（' + end.energy.toFixed(2) + '）')
  assert.ok(end.pendingDigest < 3, '积压被 REM 消化掉（' + end.pendingDigest.toFixed(1) + '）')
}

// ── ⑥ 饿感措辞 ──
{
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'metabolism.json'), 'utf8'))
  raw.energy = 0.2; raw.pendingDigest = 5
  fs.writeFileSync(path.join(TMP, 'metabolism.json'), JSON.stringify(raw))
  const s = m.sense()
  assert.ok(s.includes('饿') && s.includes('消化'), '饿感+积压感: ' + s)
  assert.ok(field.sense().includes('饿'), '饿感进入第一人称身体感')
}

console.log('metabolism-test: 6 组断言全过（思考消耗/进食积压/REM消化/N3修复/24h曲线/饿感）')
