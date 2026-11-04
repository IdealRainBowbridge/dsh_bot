// organ/sleepstage · 看门狗测试（2026-11-04）
//
// 要防的事故：`inSleep=true` 卡死 44 小时。
//   · `wake()` 唯一的生产调用方是 spawn 出去的 sleep 子进程
//   · 那个进程没起来/被杀 → endSleep 永不执行 → 状态位永久 true
//   · 于是 accrueSleepDebt 每拍 early-return，睡眠债冻在 0.599，
//     而对外表现成"她一直想睡觉"（sense 说"你正在睡"、presence 恒 null）
//
// 这套测试盯三件事：
//   ① 不超时绝不动手（误杀正常长睡比不修更糟）
//   ② 结算链还活着时绝不动手（防误杀正在跑的维护）
//   ③ 真卡死了必须醒，且**按上限截断**而不是按真实时长结算
//      （44 小时按真实时长结算 = 一次性还掉一个半月的债，那是把故障伪装成大修复）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-sleepwatch-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_BRAIN_MIRROR = '0'

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const S = await import('../tools/brain/organ/sleepstage.mjs')
const paths = await import('../tools/brain/paths.mjs')
const F = await import('../tools/brain/field.mjs')

const MIN = 60_000

// 重置状态：直接写 sleep.json，模拟各种"入睡时刻"
const setSleep = (beganAt, extra = {}) => {
  fs.mkdirSync(path.dirname(paths.sleepPath()), { recursive: true })
  fs.writeFileSync(paths.sleepPath(), JSON.stringify({
    at: beganAt, inSleep: true, beganAt, wakeAt: 0,
    acc: { N1: 0, N2: 0, N3: 0, REM: 0 }, interruptions: 0, history: [],
    ...extra,
  }))
}

/* ── ① 上限函数本身 ──────────────────────────────────────────────── */
ok('有计划时按计划算上限', S.sleepLimitMin(480) === 480 * 1.6 + 30, `${S.sleepLimitMin(480)} 分钟`)
ok('短计划有 90 分钟下限', S.sleepLimitMin(20) === 90, `${S.sleepLimitMin(20)} 分钟`)
ok('没计划时走 16 小时硬上限', S.sleepLimitMin(0) === S.MAX_SLEEP_MIN && S.MAX_SLEEP_MIN === 960, `${S.sleepLimitMin(0)} 分钟`)

/* ── ①b 结算时长（与发现阈值是两个数，这是关键区分）───────────────── */
// 发现阈值：什么时候认定她卡死了（16h / 计划×1.6）
// 结算时长：认定卡死之后，这一觉按多久算（计划时长 / 8h 默认）
// 混成一个数的后果：44 小时的卡死会被结算成"睡够了"，债一次还清 —— 把故障伪装成修复。
ok('没计划时结算按 8 小时', S.settleMin(0, 2640) === 480, `${S.settleMin(0, 2640)} 分钟`)
ok('有计划时结算按计划', S.settleMin(120, 2640) === 120, `${S.settleMin(120, 2640)} 分钟`)
ok('正常一觉不被截断（恒等）', S.settleMin(0, 300) === 300, `${S.settleMin(0, 300)} 分钟`)
ok('计划超过上限也砍到 16h', S.settleMin(1440, 2000) === S.MAX_SLEEP_MIN, `${S.settleMin(1440, 2000)} 分钟`)

/* ── ② 不超时不动手 ──────────────────────────────────────────────── */
const now = Date.now()
setSleep(now - 60 * MIN)                       // 睡了 1 小时
let r = S.reconcile(now, { plannedMin: 480 })  // 计划 8 小时
ok('没超时不叫醒', r.woke === false, JSON.stringify(r))
ok('没超时状态保持 inSleep', S.snapshot(now).inSleep === true)

/* ── ③ 结算链还活着时不动手（防误杀）─────────────────────────────── */
setSleep(now - 20 * 60 * MIN)                  // 睡了 20 小时（已超 16h 上限）
r = S.reconcile(now, { plannedMin: 0, inProgress: true })
ok('命令还在跑时不叫醒', r.woke === false, JSON.stringify(r))
ok('命令还在跑时状态保持 inSleep', S.snapshot(now).inSleep === true)

/* ── ④ 真卡死：必须醒，且按计划/默认夜长结算，不按 44 小时 ────────── */
setSleep(now - 44 * 60 * MIN)                  // 严格复刻事故：卡 44 小时
const before = Number(F.snapshot().dims.sleepDebt || 0)
r = S.reconcile(now, { plannedMin: 0, inProgress: false })
ok('卡死了会被叫醒', r.woke === true, JSON.stringify(r))
ok('醒来后 inSleep 为 false', S.snapshot(now).inSleep === false)
ok('结算时长按默认夜长（8h），不是 16h 上限', r.sleptMin === 480, `sleptMin=${r.sleptMin}`)
ok('真实时长单独记下来', r.rawMin >= 44 * 60 - 1, `rawMin=${r.rawMin}`)
ok('截断标记落在 history', r.capped === true)

const hist = S.snapshot(now).history
const last = hist[hist.length - 1]
ok('history 记了 watchdog 原因', last?.reason === 'watchdog', JSON.stringify(last?.reason || null))
ok('history 记了被截断的真实时长', Number(last?.cappedFrom) >= 44 * 60 - 1, `${last?.cappedFrom}`)

// 结算量必须是"一夜"的量级，不能是"一个半月"
const debtAfter = Number(F.snapshot().dims.sleepDebt || 0)
ok('没有把债还成负数/还穿', debtAfter >= 0, `before=${before} after=${debtAfter}`)
ok('还债量是一夜量级（不是 44 小时）', debtAfter === 0 || debtAfter < before, `before=${before} after=${debtAfter}`)
ok('还债等价小时 ≤ 一夜上限 8h', r.resets.debt <= 8, `${r.resets.debt}h`)

/* ── ④b 有计划时按计划结算 ──────────────────────────────────────── */
setSleep(now - 44 * 60 * MIN)
r = S.reconcile(now, { plannedMin: 120, inProgress: false })
ok('有计划时按计划时长结算', r.sleptMin === 120, `sleptMin=${r.sleptMin}（计划 120）`)

/* ── ⑤ 没在睡时是纯 no-op ────────────────────────────────────────── */
r = S.reconcile(now, { plannedMin: 480 })
ok('醒着时 reconcile 什么都不做', r.woke === false && r.reason === '没在睡', JSON.stringify(r))

/* ── ⑥ wake 的 reason 参数（自然醒路径不受影响）──────────────────── */
setSleep(now - 8 * 60 * MIN)
const w = S.wake(now, { reason: 'natural' })
ok('自然醒按真实时长结算', Math.abs(w.sleptMin - 8 * 60) <= 1, `sleptMin=${w.sleptMin}`)
ok('自然醒不标记截断', w.capped === false)
ok('自然醒 reason 正确', w.record.reason === 'natural', w.record.reason)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)
