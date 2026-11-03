// zeitgeber-test —— C4 社交节律牵引（2026-11-03）
//
// 器官判据（M58）：
//   ① 主人连续 3 天 02:00~04:00 活跃 -> 相位日均后移 ~40min（三迟合计 90~130min）
//   ② 晨间（05~10）活跃反向牵引（相位提前）
//   ③ 白天（10~19）活跃 = 死区，相位不动
//   ④ 停拖自然回归：14 天后相位衰减到峰值的 ~25% 以下（既有 7 天中性漂移）
//   ⑤ 状态落盘：ztgW/ztgAt 进 rhythm.json；不动 sleepstage（不 import 不调用）
//   ⑥ 无主人配置/无互动 -> 光强为 0，相位不动
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c4-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.dsh', 'bot.config.json'), JSON.stringify({ owner: { qq: '10000' } }))

const { epFile, rhythmPath } = await import('../tools/brain/paths.mjs')
const rhythm = await import('../tools/brain/rhythm.mjs')

const localMidnight = new Date(); localMidnight.setHours(0, 0, 0, 0)
const DAY0 = localMidnight.getTime()
const at = (day, h, m = 0) => DAY0 + day * 86_400_000 + h * 3600_000 + m * 60_000

function ownerTalks(day, hFrom, hTo, stepMin = 10) {
  fs.mkdirSync(path.dirname(epFile(new Date())), { recursive: true })
  const rows = []
  for (let t = at(day, hFrom); t <= at(day, hTo); t += stepMin * 60_000) {
    rows.push(JSON.stringify({ id: 'z' + t, at: t, act: 'say', gist: 'hey', where: { platform: 'qq', chat: 'qq:10000' }, who: { kind: 'user', others: [] }, feel: { valence: 0.3, arousal: 0.4 } }))
  }
  fs.appendFileSync(epFile(new Date()), rows.join('\n') + '\n')
}
const readPhase = () => Number(JSON.parse(fs.readFileSync(rhythmPath(), 'utf8')).phaseMin || 0)
function tickEvery(minFrom, minTo, stepMs = 10 * 60_000) {
  for (let t = minFrom; t <= minTo; t += stepMs) rhythm.zeitgeberTick(t)
}

// ── ⑥ 无互动：光强 0，相位不动 ──────────────────────────────────────────
tickEvery(at(0, 0), at(0, 6))
assert.strictEqual(readPhase(), 0, 'no owner activity -> no drag, phase=' + readPhase())
const st0 = JSON.parse(fs.readFileSync(rhythmPath(), 'utf8'))
assert.strictEqual(st0.ztgW, 0, 'light intensity stays 0')
console.log('ok 6 silence: phase 0, w=0')

// ── ① 三天 02:00~04:00 活跃 -> ~40min/天 ────────────────────────────────
const daily = []
for (let day = 1; day <= 3; day++) {
  ownerTalks(day - 1, 2, 3.9)        // 说话行铺到 03:54，活动窗(+30min)覆盖拖拽到 ~04:24
  tickEvery(at(day - 1, 2), at(day, 2))    // 从活动开始连续 tick 到第二天凌晨（活动窗内行随 now 逐个生效）
  daily.push(readPhase())
}
const perDay = daily.map((v, i) => i === 0 ? v : v - daily[i - 1])
assert.ok(daily[2] >= 90 && daily[2] <= 140, `3 days @02:00 drags phase 90~140min, got ${daily[2]}`)
assert.ok(perDay[2] >= 28 && perDay[2] <= 50, `per-day drag ~40min, got ${perDay[2].toFixed(1)}`)
console.log('ok 1 drag: daily', daily.map((v) => +v.toFixed(1)).join(' / '), 'min')

// ── ② 晨间反向牵引 ──────────────────────────────────────────────────────
{
  const before = readPhase()
  ownerTalks(4, 6, 7)                // 06:00~07:00 活跃（晨窗）
  tickEvery(at(4, 7, 10), at(4, 9))
  const after = readPhase()
  assert.ok(after < before, `morning activity advances phase: ${before} -> ${after}`)
  console.log('ok 2 morning advance: ' + before.toFixed(1) + ' -> ' + after.toFixed(1))
}

// ── ③ 白天死区 ──────────────────────────────────────────────────────────
{
  const before = readPhase()
  ownerTalks(5, 12, 13)              // 12:00~13:00 活跃（死区）
  tickEvery(at(5, 12), at(5, 18))
  const after = readPhase()
  assert.ok(after <= before, `daytime activity never pushes phase later: ${before} -> ${after}`)
  console.log('ok 3 daytime dead zone: no drag, delta ' + (after - before).toFixed(2))
}

// ── ④ 停拖自然回归（7 天 τ）────────────────────────────────────────────
{
  const peak = readPhase()
  const releaseEnd = at(5, 18) + 14 * 86_400_000
  tickEvery(at(5, 18, 20), releaseEnd, 30 * 60_000)
  const after = readPhase()
  assert.ok(after < peak * 0.35, `released phase decays: peak ${peak.toFixed(1)} -> ${after.toFixed(1)} after 14d`)
  console.log(`ok 4 release: ${peak.toFixed(1)} -> ${after.toFixed(1)} min after 14d`)
}

// ── ⑤ 落盘 ──────────────────────────────────────────────────────────────
{
  const raw = JSON.parse(fs.readFileSync(rhythmPath(), 'utf8'))
  assert.ok(typeof raw.ztgW === 'number' && raw.ztgAt > 0, 'ztg state persisted: ' + JSON.stringify({ ztgW: raw.ztgW, ztgAt: raw.ztgAt }))
  const rhythmSrc = fs.readFileSync(new URL('../tools/brain/rhythm.mjs', import.meta.url), 'utf8')
  assert.ok(rhythmSrc.indexOf('sleepstage') < 0, 'rhythm must not touch sleepstage')
  console.log('ok 5 persisted: ztgW=' + raw.ztgW.toFixed(3))
}

console.log('zeitgeber-test all green')
