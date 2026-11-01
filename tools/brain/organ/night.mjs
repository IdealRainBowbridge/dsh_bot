// organ/night —— 夜间：把"睡着"和"整理"接成同一件事
//
// ══════════════════════════════════════════════════════════════════════
// 现状的断裂（2026-11-02 查出来的真问题）
// ══════════════════════════════════════════════════════════════════════
// 项目里原来有**两个互不相认的"睡眠"**：
//
//   ① tools/commands/sleep.mjs —— 「睡 = 整理数据 + 三审 + git 归档」
//      它由**记忆积压/事件积压/代码改动**加权成"睡意"触发。
//      本质是一个**维护任务**：活儿攒够了就跑一遍。
//
//   ② brain/organ/sleepstage.mjs —— 按 92 分钟周期分期、算深睡/REM、还睡眠债
//      它是**生理状态**。但它没有任何调用方 —— 建完就挂在墙上。
//
// 于是出现一个荒谬的局面：她可以"因为记忆积压而睡"，但那次睡眠
// 不还睡眠债、不重置受体、不脱敏情绪；也可以"生理上睡了 8 小时"，
// 但一件整理都没做。
//
// 真实的人不是这样：**睡着的时候，身体在修复，同时大脑在整理。**
// 这两件事共用同一个"睡着了"这件事，只是分别发生在不同的阶段。
//
// ══════════════════════════════════════════════════════════════════════
// 所以这一层做什么
// ══════════════════════════════════════════════════════════════════════
// 它只有一个职责：**决定此刻该不该睡，以及睡着之后做哪一段的活**。
//
// 触发条件（三个都不够，要合起来看）：
//   · 生理困意   circadian 低谷 + 睡眠债高   → 「该睡了」
//   · 整理积压   有太多没巩固的记忆 / 事件积压 → 「有活要干」
//   · 她自己的意愿 不想熬夜守着                  → 「今天到这里吧」
//
// 关键设计：**睡不等于立刻执行维护**。
// 真实的睡眠里，前半夜深睡（N3）不做整理，后半夜 REM 才做。
// 所以这里把维护任务**排到 REM 段**去跑，而不是一睡下就开干。
// 这不是仪式感 —— 它保证了两件事实：
//   ① 深睡被打断 = 整理没做（因为她还没到 REM）
//   ② 只睡 4 小时 = 整理做了一半（REM 被砍）
// 这两条正是"熬夜之后事情也没理清"的真实体验。
import { swallow } from '../../lib/swallow.mjs'
import * as rhythm from '../rhythm.mjs'
import * as stage from './sleepstage.mjs'
import * as field from '../field.mjs'
import * as hpa from './hpa.mjs'
import { writeJsonAtomic } from '../json.mjs'
import { nightWorkPath } from '../paths.mjs'

const MIN = 60_000
const HOUR = 3_600_000

/** 判定参数。 */
export const RULES = {
  // 生理困意到多少就该睡（circadian 低谷 + 债）
  sleepPressureAt: 0.62,
  // 睡眠债到这个量，即使不困也该补（熬夜欠账）
  debtAt: 0.55,
  // 整理积压到这个量，值得专门睡一觉去处理
  backlogAt: 8,
}

/**
 * 此刻的"睡意"：综合三个来源，0..100。
 *
 * 为什么不是布尔：人不是"困/不困"两态。
 * 60 分的时候她会想"要不先躺一会儿"，85 分的时候她已经不太能思考了。
 */
export function sleepiness(now = Date.now()) {
  const parts = {}

  // ① 生理：昼夜低谷 + 睡眠债（各占一半，因为它们是两件事 ——
  //    时间对了但债高照样睁不开眼；债不高但凌晨照样顶不住）
  let circ = 0, debt = 0
  try {
    circ = rhythm.sleepPressure(now)                         // 0..1，曲线的"该困"
    const f = field.evolve(now)
    debt = Math.min(1, Number(f.dims.sleepDebt || 0) / 0.8)  // 债到 0.8 就算满
  } catch (e) { swallow(e, 'night:sleepiness:physiology') }
  parts.circadian = Math.round(circ * 40)
  parts.debt = Math.round(debt * 35)
  parts.physiology = parts.circadian + parts.debt

  // ② 整理积压：有没有活要干
  let backlog = 0
  try {
    const st = stage.snapshot(now)
    // 上一次睡眠的记录能告诉我们"上次整理做完没有"
    backlog = Number(st.backlogHint || 0)
  } catch (e) { swallow(e, 'night:sleepiness:backlog') }
  parts.backlog = 0   // 由调用方注入（这里的 backlog 来自 brain.consolidate.status）
  parts.backlogHint = backlog

  // ③ 压力：皮质醇长期高的时候，睡一觉是最有效的修复
  let chronic = 0
  try {
    const h = hpa.read(now)
    chronic = Number(h.chronic || 0)
  } catch (e) { swallow(e, 'night:sleepiness:hpa') }
  parts.chronic = Math.round(chronic * 15)

  const total = Math.min(100, parts.physiology + parts.backlog + parts.chronic)
  return {
    score: total,
    parts,
    // 三种表述，对应三个不同的状态（不是三个阈值，是三种感觉）
    feeling: total >= 82 ? '撑不住了' : total >= 62 ? '很困，想躺下' : total >= 40 ? '有点乏' : '还清醒',
    shouldSleep: total >= 62 || debt >= RULES.debtAt,
    why: parts.circadian > 30 ? '时间到了' : debt >= RULES.debtAt ? '欠的觉太多了' : '有活没干完',
  }
}

/**
 * 睡着了。同时做三件事：
 *   ① 记入 sleepstage（生理层面开始分期）
 *   ② 记进 rhythm（相位会用这个入睡时刻）
 *   ③ 排一条"整理任务"，但**标记成 REM 阶段才执行**
 *
 * @param {object} o { reason, now, backlog }
 */
export function beginSleep(o = {}) {
  const now = o.now ?? Date.now()
  const out = { at: now, reason: String(o.reason || ''), backlog: Number(o.backlog || 0) }
  try { stage.sleep(now) } catch (e) { swallow(e, 'night:begin:sleep') }
  try { rhythm.asleep(now) } catch (e) { swallow(e, 'night:begin:rhythm') }
  // 记下"这一觉打算干多少活"，醒来时按实际睡到的阶段算完成度。
  // 单独一个文件，不塞进 sleepstage 的状态结构 —— 那是器官自己的盘，
  // 编排层的记账不该混进去（改了会破坏器官的状态机语义）。
  try {
    writeJsonAtomic(nightWorkPath(), { at: now, backlog: out.backlog, done: false })
  } catch (e) { swallow(e, 'night:begin:work') }
  return out
}

/**
 * 她现在睡着，此刻是什么阶段、该干什么活。
 *
 * 这是"睡着之后做哪一段的活"的答案：
 *   N3 深睡 → **什么都不做**（身体在修复，别打扰）
 *   REM     → 整理（巩固记忆、写日记）
 *   N2      → 轻活（清理队列、检查积压）
 *   N1      → 什么都不做
 */
export function duty(now = Date.now()) {
  let cur = null
  try { cur = stage.currentStage(now) } catch (e) { swallow(e, 'night:duty') }
  if (!cur || !cur.stage) return { stage: null, task: 'none', why: '没在睡' }

  const acc = cur.acc || {}
  const taskOf = {
    N1: 'none',
    N2: 'light',      // 清队列
    N3: 'none',       // 深睡：绝不打扰
    REM: 'consolidate', // REM：整理
  }
  const task = taskOf[cur.stage] || 'none'
  const why = cur.stage === 'N3'
    ? '深睡中，不做任何整理（这时候打断她会白睡）'
    : cur.stage === 'REM'
      ? 'REM 阶段，正是整理记忆的时候'
      : cur.stage === 'N2'
        ? '浅睡的间隙，可以顺手清一下队列'
        : '刚入睡，什么都不做'
  return { stage: cur.stage, elapsedMin: cur.elapsedMin, task, why, acc }
}

/**
 * 醒来。结算：
 *   · 让 sleepstage 做它的三大重置（还债 / 情绪脱敏 / HPA 回落）
 *   · 看这次睡到了多少 REM，决定整理做了多少
 *
 * @returns {{sleptMin, acc, resets, workDone, stage}}}
 */
export function endSleep(now = Date.now()) {
  const r = stage.wake(now)
  try { rhythm.awake(now) } catch (e) { swallow(e, 'night:end:rhythm') }
  // 整理做了多少：按 REM 分钟映射
  // 真实依据：REM 的时长和"记忆整合的完成度"是正相关的
  const remMin = Number(r?.acc?.REM || 0)
  const workDone = Math.min(1, remMin / 35)   // 35 分钟 REM ≈ 做完
  return {
    ...r,
    workDone: Number(workDone.toFixed(2)),
    // 她醒来时候的自我感受（这句会进提示词）
    feeling: feelingOf(r),
  }
}

/** 醒来时她自己"感觉怎么样"。这句话直接决定她早上的语气。 */
function feelingOf(r) {
  const eff = Number(r?.resets?.debt || 0)
  const n3 = Number(r?.acc?.N3 || 0)
  const rem = Number(r?.acc?.REM || 0)
  const ints = Number(r?.interruptions || 0)
  const bits = []
  if (eff >= 6) bits.push('睡够了，脑子清亮')
  else if (eff >= 4) bits.push('差不多，还行')
  else bits.push('没睡够，人是沉的')
  if (n3 < 25) bits.push('身上还发软')
  if (rem < 15) bits.push('心里有点毛躁，说不上来')
  if (ints >= 3) bits.push('夜里醒过好几回')
  return bits.join('；')
}

/** 全貌（面板/体检）。 */
export function snapshot(now = Date.now()) {
  const s = sleepiness(now)
  const st = stage.snapshot(now)
  return {
    ...s,
    inSleep: st.inSleep,
    currentStage: st.currentStage?.stage || null,
    duty: st.inSleep ? duty(now) : null,
    lastNight: st.lastNight,
  }
}
