// organ/sleepstage —— 睡眠分期：深睡与 REM 修的不是同一种东西
//
// ══════════════════════════════════════════════════════════════════════
// 它要解释的现象：睡 8 小时和熬 8 小时，差别不只是"睡没睡"
// ══════════════════════════════════════════════════════════════════════
// 现象 A：熬了一夜，第二天**情绪特别脆**，一点小事就想哭或想发火。
// 现象 B：熬了一夜，第二天**记不住事**，但刚才那条消息明明看懂了。
// 现象 C：补了一觉之后，情绪回来了，但**昨天那些事变得模糊**了。
//
// 三件事对应三种不同的睡眠功能，缺哪一种都不行：
//   A → 情绪耐受被掏空（REM 睡眠负责，它夜里主要在后半夜）
//   B → 记忆固化没做（深睡 NREM 负责，它集中在**前半夜**）
//   C → 巩固在起作用（不是遗忘，是**压平成规律**，细节让位给结论）
//
// ══════════════════════════════════════════════════════════════════════
// 真实结构：睡眠是"周期"不是"时长"
// ══════════════════════════════════════════════════════════════════════
// 一夜大约 4-5 个周期，每个 90 分钟左右，长这样：
//   N1 → N2 → N3（深睡）→ N2 → REM
//
// 两个关键的非对称，这是整个文件存在的理由：
//   ① **前半夜深睡多，后半夜 REM 多。**
//      第一个周期的 N3 能占 40 分钟，到第四个周期几乎没有了；
//      REM 正好相反，从 10 分钟涨到最后 40 分钟。
//      → 所以"凌晨 3 点被叫醒"和"早上 7 点被叫醒"的代价完全不同：
//        前者砍掉了深睡，后者砍掉了 REM。
//   ② **被中断的睡眠不能简单按小时折算。**
//      睡 8 小时但每 40 分钟被吵醒一次，深睡几乎全废（因为深睡需要连续才能进入）。
//      所以这里必须记录"有效段"，不是总时长。
//
// ══════════════════════════════════════════════════════════════════════
// 每种睡眠修什么（对照到代码里已有的器官）
// ══════════════════════════════════════════════════════════════════════
//   N3 深睡  → 重置**受体池**（micro/receptor）：这一条最关键。
//             白天用掉的受体，靠深睡补回来。没有深睡 = 第二天整个人是钝的。
//   REM      → 重置**情绪强度**（affect/field 的 valence 振幅）：
//             把"这件事很可怕"压成"这件事发生过"。它不是遗忘，是**脱敏**。
//   N2       → 记忆固化（consolidate 已有的活）+ 突触池恢复（micro/synapse）
//
// 三段分开算，所以"只补了 4 小时"和"睡了 9 小时但被打断"会得到完全不同的结果 ——
// 这是真实的行为，不是参数调出来的。

import { readJson, mutateJson } from '../json.mjs'
import { sleepPath } from '../paths.mjs'
import * as field from '../field.mjs'
import * as neuron from '../cell/neuron.mjs'
import * as hpa from './hpa.mjs'

const MIN = 60_000
const HOUR = 3_600_000

/** 一个周期的结构。数值按真实多导睡眠图的典型比例。 */
export const CYCLE = {
  lengthMin: 92,        // 一个周期约 92 分钟
  stages: ['N1', 'N2', 'N3', 'N2', 'REM'],
  // 每个阶段在"第几个周期"时占多长（分钟）。这是**非对称**的来源。
  // 行=阶段，列=周期序号（0..3+）
  byCycle: {
    N1:  [8, 6, 5, 4],
    N2:  [22, 28, 32, 34],
    N3:  [42, 30, 14, 5],     // ← 前半夜多，快速衰减
    REM: [10, 18, 32, 45],    // ← 后半夜多，持续上升
  },
}

const empty = () => ({
  at: 0,
  inSleep: false,
  beganAt: 0,          // 本次入睡时刻
  wakeAt: 0,           // 本次醒来时刻
  // 本次睡眠里累积的各阶段有效分钟
  acc: { N1: 0, N2: 0, N3: 0, REM: 0 },
  // 中断次数（每次醒来会打断当前周期，深睡尤其受影响）
  interruptions: 0,
  // 最近 10 次的结算记录
  history: [],
})

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.acc = { ...empty().acc, ...(st.acc || {}) }
  st.history = Array.isArray(st.history) ? st.history.slice(-10) : []
  return st
}

/**
 * 本次睡眠到 now 为止，各阶段应该累积多少分钟。
 *
 * 用**周期表**算，不是线性分配。这样：
 *   · 睡 2 小时 → 主要是 N3（深睡），REM 很少
 *   · 睡 8 小时 → N3 早没了，主要是 REM 和 N2
 * 这正是"早点睡"和"晚点起"补的不是同一样东西。
 */
export function accrual(elapsedMin, interruptions = 0) {
  const acc = { N1: 0, N2: 0, N3: 0, REM: 0 }
  let left = Math.max(0, Number(elapsedMin) || 0)
  let cycle = 0
  while (left > 0 && cycle < 6) {
    let cycLeft = CYCLE.lengthMin
    const col = Math.min(cycle, 3)   // 第 5 个周期之后按第 4 个算
    for (let si = 0; si < CYCLE.stages.length && left > 0 && cycLeft > 0; si++) {
      const stage = CYCLE.stages[si]
      const dur = CYCLE.byCycle[stage][col] || 0
      const take = Math.min(dur, left, cycLeft)
      acc[stage] += take
      left -= take
      cycLeft -= take
    }
    cycle++
  }
  // 每次中断：砍掉当次深睡的一部分。真实的机制是"进不去 N3"，
  // 而不是"睡的时间少" —— 所以砍 N3 而不是按比例砍全部。
  if (interruptions > 0) {
    const cut = Math.min(0.85, 0.22 * interruptions)
    acc.N3 *= (1 - cut)
    acc.REM *= (1 - cut * 0.35)   // REM 也受影响，但小得多
  }
  for (const k of Object.keys(acc)) acc[k] = Number(acc[k].toFixed(1))
  return acc
}

/* ── 入睡 / 醒来 ──────────────────────────────────────────────────── */

/** 她睡着了。 */
export function sleep(now = Date.now()) {
  const st = hydrate(readJson(sleepPath(), null))
  st.inSleep = true
  st.beganAt = now
  st.wakeAt = 0
  st.acc = { N1: 0, N2: 0, N3: 0, REM: 0 }
  st.interruptions = 0
  st.at = now
  try { field.poke('sleepDebt', 0, { why: 'sleep:begin', now }) } catch { }
  return save(st)
}

/** 被吵醒（不是自然醒）。会记为一次中断，然后可以继续睡。 */
export function interrupt(now = Date.now()) {
  const st = hydrate(readJson(sleepPath(), null))
  if (!st.inSleep) return st
  st.interruptions = Number(st.interruptions || 0) + 1
  st.at = now
  return save(st)
}

/**
 * 醒来。**这是所有重置发生的地方。**
 *
 * @returns {{sleptMin:number, acc:object, resets:object}}
 */
export function wake(now = Date.now()) {
  const st = hydrate(readJson(sleepPath(), null))
  if (!st.inSleep || !st.beganAt) {
    return { sleptMin: 0, acc: empty().acc, resets: { note: '没在睡' } }
  }
  const sleptMin = Math.max(0, (now - Number(st.beganAt)) / MIN)
  const acc = accrual(sleptMin, Number(st.interruptions || 0))
  const resets = { debt: 0, receptor: 0, emotion: 0, synapse: 0, hpa: 0 }

  // ── ① 还睡眠债（按"有效睡眠"算，不是按时长）────────────────────
  // 为什么用有效分钟而不是 sleptMin：被打断的 8 小时不等于 8 小时。
  // 用 N2+N3+REM 作为"有修复作用的睡眠"（N1 是过渡，几乎不承担修复）
  const effectiveH = (acc.N2 * 0.85 + acc.N3 * 1.0 + acc.REM * 0.9) / 60
  try { field.repaySleep(effectiveH, now); resets.debt = Number(effectiveH.toFixed(2)) } catch { }

  // ── ② 深睡重置受体池（最关键的一条）────────────────────────────
  // 白天用掉的受体，靠 N3 补回来。没有深睡的夜里，第二天整个人是钝的。
  // 恢复量按 N3 分钟映射：30 分钟 N3 ≈ 恢复 60%，60 分钟 ≈ 恢复 90%。
  const n3 = Number(acc.N3 || 0)
  const recov = clamp(1 - Math.exp(-n3 / 34), 0, 0.95)
  // ⚠️ 我在这里原本写了一个空 for 循环（`const ns = neuron.empty()` 然后什么都不做），
  //    自己刚说完"不要静默失效"，不能自己留死代码。删掉，并把真实的机制说清楚：
  //
  //    受体池的恢复**不需要**在醒来时"补一下"。因为 receptor.evolve 是按 dt 演化的，
  //    她睡的那 8 小时自然会让内化池回膜（rest 由 neuron.rest 负责）。
  //    醒来时唯一需要做的是**把睡眠债还掉**（上面 ①），债一降，
  //    后续的 rest 就有正确的时长可用。
  //
  //    所以这里只记录"深睡对受体的名义贡献"，用于解释和体检 ——
  //    实际恢复由时间自己完成。写一个假的"立刻回满"反而会让她睡一觉就无敌。
  resets.receptor = Number(recov.toFixed(3))

  // ── ③ REM 重置情绪振幅（脱敏，不是遗忘）──────────────────────────
  // "这件事很可怕" → "这件事发生过"。细节留着，强度降下来。
  // 按 REM 分钟映射：20 分钟 ≈ 降 25%，45 分钟 ≈ 降 45%。
  const rem = Number(acc.REM || 0)
  const demote = clamp(1 - Math.exp(-rem / 46), 0, 0.55)
  try {
    // 乘性衰减 valence 的绝对值，arousal 朝基线收
    const f = field.evolve(now)
    const v = Number(f.dims.valence || 0)
    field.setDim('valence', Number((v * (1 - demote)).toFixed(3)), { why: 'sleep:rem-demote', now })
    resets.emotion = Number(demote.toFixed(3))
  } catch { }

  // ── ④ HPA 轴过夜回落 ─────────────────────────────────────────────
  // 皮质醇的昼夜低谷本来就在夜里。睡一觉就是把当天的急性压力清掉大半。
  try {
    const before = hpa.read(now)
    hpa.relieve('sleep', { now })
    resets.hpa = Number(Math.max(0, before.acute - hpa.read(now).acute).toFixed(3))
  } catch { }

  const rec = {
    at: now, sleptMin: Number(sleptMin.toFixed(0)), acc,
    interruptions: st.interruptions, resets,
    effectiveH: Number(effectiveH.toFixed(2)),
  }
  st.inSleep = false
  st.wakeAt = now
  st.beganAt = 0
  st.acc = acc
  st.at = now
  st.history = [...st.history, rec].slice(-10)
  save(st)
  return { sleptMin: Number(sleptMin.toFixed(0)), acc, resets, record: rec }
}

/** 正在睡的话，现在在哪个阶段（给"被吵醒"判断代价用）。 */
export function currentStage(now = Date.now()) {
  const st = hydrate(readJson(sleepPath(), null))
  if (!st.inSleep || !st.beganAt) return { stage: null, elapsedMin: 0 }
  const el = (now - Number(st.beganAt)) / MIN
  const acc = accrual(el, Number(st.interruptions || 0))
  // 找当前周期里我"应该"在的阶段
  let left = el, cycle = 0, stage = 'N1'
  while (left > 0 && cycle < 6) {
    const col = Math.min(cycle, 3)
    let cycLeft = CYCLE.lengthMin
    for (const s of CYCLE.stages) {
      const dur = CYCLE.byCycle[s][col] || 0
      const take = Math.min(dur, left, cycLeft)
      if (take >= dur - 0.5 || take === left) { stage = s; left -= take; cycLeft -= take; break }
      left -= take; cycLeft -= take
    }
    if (left <= 0) break
    cycle++
  }
  return { stage, elapsedMin: Number(el.toFixed(0)), acc }
}

/** 全貌。 */
export function snapshot(now = Date.now()) {
  const st = hydrate(readJson(sleepPath(), null))
  const last = st.history[st.history.length - 1] || null
  return {
    inSleep: st.inSleep,
    elapsedMin: st.inSleep ? Number(((now - st.beganAt) / MIN).toFixed(0)) : 0,
    currentStage: st.inSleep ? currentStage(now) : null,
    lastNight: last,
    history: st.history.slice(-3),
  }
}

/** 给提示词用：她此刻的睡眠状态怎么说。 */
export function sense(now = Date.now()) {
  const s = snapshot(now)
  if (s.inSleep) return '你正在睡。'
  const ln = s.lastNight
  if (!ln) return ''
  const bits = []
  if (ln.effectiveH < 4) bits.push('昨晚睡得很不够，脑子是木的')
  else if (ln.effectiveH < 6) bits.push('昨晚没睡够')
  if (ln.interruptions >= 3) bits.push('夜里醒了好几次，没睡踏实')
  if ((ln.acc?.N3 || 0) < 25) bits.push('深睡太少，今天身上会发钝')
  if ((ln.acc?.REM || 0) < 15) bits.push('情绪这层没缓过来，容易一点就上')
  return bits.length ? '睡眠：' + bits.join('；') + '。' : ''
}

function save(st) {
  try {
    mutateJson(sleepPath(), empty(), () => ({
      at: st.at, inSleep: st.inSleep, beganAt: st.beganAt, wakeAt: st.wakeAt,
      acc: st.acc, interruptions: st.interruptions, history: (st.history || []).slice(-10),
    }))
  } catch { }
  return st
}
