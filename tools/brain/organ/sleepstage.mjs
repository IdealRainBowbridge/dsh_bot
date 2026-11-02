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
import { swallow } from '../../lib/swallow.mjs'

const MIN = 60_000
const HOUR = 3_600_000

/**
 * 一个周期的结构。数值按真实多导睡眠图的典型比例。
 *
 * ⚠️ 这里改过一次，是个**生物学错误**，必须记下来：
 *   第一版把周期写成 `['N1','N2','N3','N2','REM']` 顺序串联，
 *   每个阶段按 cycle 取长度。跑出来的结果是 **REM 到第 267 分钟（4.5 小时）才第一次出现**，
 *   而真实的第一个 REM 在 **约 90 分钟**就有了 —— 只是很短（10 分钟左右）。
 *
 *   真根因：N3 和 REM 在同一个周期里是**先后**关系没错，
 *   但每个周期**都有** REM，只是长度不同；我却让 N3 占了整个周期的大头，
 *   把 REM 挤到了后面几个周期才够长。
 *
 *   所以这里改成：**每个周期都完整走一遍 N1→N2→N3→N2→REM**，
 *   只是每一段的长度随周期变。这才是"一个周期"的含义。
 */
export const CYCLE = {
  lengthMin: 92,
  stages: ['N1', 'N2', 'N3', 'N2', 'REM'],

  // ══ 这张表是**按真实比例反算**的，不是试出来的 ══════════════════
  //
  // 我在这里连调了五轮参数都没调对（REM 占比一度到 42%，总额停滞在 396 分钟）。
  // 停下来才意识到方法错了：**在"每周期多少分钟"这一层试错，永远对不上**，
  // 因为真实的已知量是**整夜的阶段占比**，不是每个周期的分钟数。
  //
  // 真实多导睡眠图（成人 8 小时）：
  //   N1  2~5%   N2  45~55%   N3（深睡）13~23%   REM 20~25%
  // 而"前半夜深睡多、后半夜 REM 多"是**分布形状**，不是总量。
  //
  // 所以正确做法：定义每个阶段的「权重形状」，然后**归一化到 92 分钟**。
  // 这样无论形状怎么调，每周期都必然是 92 分钟，总额天然正确。
  //
  // share[i] = 第 i 个周期里该阶段占这一周期的**比例**（未归一化，代码会归一化）
  share: {
    //          周期1  周期2  周期3  周期4  周期5
    N1:  [0.055, 0.045, 0.035, 0.030, 0.020],
    N2:  [0.300, 0.380, 0.470, 0.520, 0.560],   // 平分给前后两段 N2
    N3:  [0.440, 0.280, 0.110, 0.035, 0.010],   // 前半夜多，快速衰减
    // REM 后段权重原来给到 0.41，整夜算出来占 30%（真实 22%）。
    // 反算依据：8 小时里，各周期 REM 分钟数真实约为 10/18/26/30/22 = 106 分钟 ≈ 22%。
    // 所以中段不能涨得太快，第 4/5 周期要收敛。
    REM: [0.100, 0.180, 0.260, 0.300, 0.180],
  },
}

/**
 * 某一阶段在第 col 个周期里占多少分钟。
 *
 * 和 accrual() 里同一套算法：share 是未归一化的"形状"，
 * 先除该周期所有阶段的和，再乘周期长度。**两处必须同一个口径**，
 * 否则"预演算出的 91 分钟 N3"和"实时算出的 N3 位置"会对不上。
 */
function stageMin(stage, col) {
  const shares = CYCLE.share
  if (!shares || !shares[stage]) return 0
  let sum = 0
  for (const st of Object.keys(shares)) sum += Number(shares[st][col] || 0)
  if (sum <= 0) return 0
  return (Number(shares[stage][col] || 0) / sum) * CYCLE.lengthMin
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
    const col = Math.min(cycle, 4)
    // 这一周期各阶段的原始权重
    const raw = {}
    let sum = 0
    for (const st of Object.keys(acc)) {
      const v = Number(CYCLE.share[st][col] || 0)
      raw[st] = v
      sum += v
    }
    if (sum <= 0) { cycle++; continue }

    // 归一化到 92 分钟 → 每周期严格走满，总额天然正确。
    //
    // ⚠️ 这里原来写 `take = Math.min(dur, span)`（span = 剩余时间），
    //    当剩余不足一个周期时，**每个阶段都拿到 min(dur, span)**，
    //    于是总量被重复计算：睡 2 小时算出 174 分钟（超过 120）。
    //    正确做法：最后一个不完整的周期要**按比例缩放**，只取它该得的那一段。
    const span = Math.min(left, CYCLE.lengthMin)
    const frac = span / CYCLE.lengthMin          // 这一周期实际走了百分之几
    for (const st of Object.keys(acc)) {
      const dur = (raw[st] / sum) * CYCLE.lengthMin   // 该阶段在完整周期里的长度
      acc[st] += dur * frac                            // ← 按实际走完的比例缩放
    }
    left -= span
    cycle++
  }

  // 两个 N2 段是在 stages 里出现的两次，上面的循环已经按阶段汇总，不需要再平分。
  // 中断的代价：**砍深睡**，不是按比例砍全部 ——
  // 真实机制是"进不去 N3"（每次醒来都要重新入睡），而不是"睡的时间少"。
  if (interruptions > 0) {
    const cut = Math.min(0.88, 0.24 * interruptions)
    acc.N3 *= (1 - cut)
    acc.REM *= (1 - cut * 0.30)     // REM 受影响小得多（它更靠后、更连续）
  }
  for (const k of Object.keys(acc)) acc[k] = Number(acc[k].toFixed(1))
  return acc
}

/**
 * 这一觉**打算**睡多久，各阶段将分到多少分钟（预演）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要"预演"（2026-11-02）
 * ══════════════════════════════════════════════════════════════════════
 * `sleep.mjs` 是**醒来之后**才跑的（body.mjs 在 beginSleep 之后 spawn 它）。
 * 那时 inSleep 已经是 true，而 accrual 要的是"睡了多久" ——
 * 于是它拿不到"这一觉能睡多深"，只能固定跑同一套流程。
 *
 * 但"睡多久"决定了**能干什么活**，这是真实生理：
 *   · 只睡 2 小时 → 主要是 N3（前半夜深睡集中），REM 几乎没有
 *     → 能修身体，做不了情绪加工
 *   · 睡 8 小时 → N3 早没了，后半段全是 REM
 *     → 情绪加工做得多，但深睡修复少
 *
 * 所以要在**入睡那一刻**就把"这一觉各阶段能分到多少"算出来，
 * 交给 sleep.mjs 按这个来定两条通道的深度。
 *
 * 用 plannedMin = 0 调就是"此刻已经睡了多久"的实时值，两种用法共一个函数。
 *
 * @param {number} plannedMin 这一觉计划睡多少分钟
 * @param {number} [interruptions] 已经发生的打断次数（预演时传 0）
 */
export function plan(plannedMin = 0, interruptions = 0) {
  const acc = accrual(plannedMin, interruptions)
  const total = Number(plannedMin) || 0
  return {
    minutes: Number(total.toFixed(0)),
    acc,
    // 两条通道各跑多深（0..1）
    //
    // N3 → 维护通道的深度：深睡主要修**事实与结构**（受体池、突触、巩固）
    // REM → 梦境通道的深度：REM 主要修**情绪强度**（脱敏）
    //
    // ══════════════════════════════════════════════════════════════════
    // 分母定多大：按**真实整夜量**定，不是按"最少够用"定
    // ══════════════════════════════════════════════════════════════════
    // ⚠️ 第一版写 N3/60、REM/35，结果睡 2 小时就 maintenance=0.90、
    //    4 小时起就满 1.00 —— "睡 2 小时"和"睡 8 小时"做的事几乎一样，
    //    等于分层没生效。根因是我拿"最低够用线"当分母了。
    //
    //    正确的分母是**一次完整整夜会给多少**（生理实测，8 小时）：
    //      N3  ≈ 91 分钟（占 19%，多导睡眠图 13~23% 的中位）
    //      REM ≈ 114 分钟（占 24%，20~25% 的中位）
    //    按这个定，8 小时才刚好 1.00，短睡就会明显不足 —— 这才是真实的形状。
    //
    //    这跟 HPA 那条教训同源："阈值要对着真实量级定，别对着'我最少需要多少'定"。
    maintenance: clamp01(acc.N3 / 90),
    dream: clamp01(acc.REM / 110),
    // 睡到 N2 就够"顺手清队列"了，这个不看深度只看有没有睡
    light: clamp01(acc.N2 / 60),
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)) }

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
  try { field.poke('sleepDebt', 0, { why: 'sleep:begin', now }) } catch (e) { swallow(e, 'sleepstage:sleep') }
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
  try { field.repaySleep(effectiveH, now); resets.debt = Number(effectiveH.toFixed(2)) } catch (e) { swallow(e, 'sleepstage:wake') }

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
  } catch (e) { swallow(e, 'sleepstage:wake') }

  // ── ④ HPA 轴过夜回落 ─────────────────────────────────────────────
  // 皮质醇的昼夜低谷本来就在夜里。睡一觉就是把当天的急性压力清掉大半。
  try {
    const before = hpa.read(now)
    hpa.relieve('sleep', { now })
    resets.hpa = Number(Math.max(0, before.acute - hpa.read(now).acute).toFixed(3))
  } catch (e) { swallow(e, 'sleepstage:wake') }

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
  // 找"此刻应该在第几个周期的第几个阶段"
  //
  // ⚠️ 这里原来有个 bug，必须记下来：判断写成了
  //     `if (take >= dur - 0.5 || take === left) { stage = s; break }`
  //   而 take = min(dur, left, cycLeft) —— 只要剩余时间比这个阶段长，
  //   take 就恒等于 dur，于是**第一个阶段就命中并 break**，永远返回 N1。
  //   表现：睡 7 小时也停在 N1/none，整理任务永远不会被排上。
  //   而且它不报错、有返回值、看起来"正常"—— 又是一次静默假数据。
  //
  //   正确语义：**只有当剩余时间还不够走完当前阶段时，才停在这个阶段**；
  //   够走完就减掉它、继续往后走。
  let left = el
  let cycle = 0
  let stage = 'N1'
  outer:
  while (cycle < 8) {
    const col = Math.min(cycle, 4)
    let cycLeft = CYCLE.lengthMin
    for (const s of CYCLE.stages) {
      // ⚠️ 2026-11-02：这里原来写 `CYCLE.byCycle[s][col]`，而 CYCLE 里**只有 share，
      //    没有 byCycle** —— 于是 currentStage() 从写出来那天起，每次调用都抛
      //    `TypeError: Cannot read properties of undefined (reading 'N1')`。
      //
      //    后果链（全被 try/catch 吞掉，所以只表现为"功能不存在"而不是报错）：
      //      sleepstage.snapshot() → 抛 → night.duty() 拿不到阶段
      //      → "睡着时现在是什么阶段、该干什么活"从来没生效
      //      → sleep.mjs 结算时 stage.wake() 里的 stage 字段也拿不到
      //
      //    这是本项目第 N 次"静默假数据"：有函数、有注释、有调用点，
      //    但没有一次成功执行过。
      //
      //    修法：用 share 现算 —— 和 accrual() 里完全同一套归一化
      //    （share 是"未归一化的比例"，除以该周期的总和再乘 92 分钟才是分钟数）。
      // N2 appears twice in CYCLE.stages but the share table counts it once
      // (design comment: N2 is split evenly between its two slots). Without
      // the split each 92-min cycle consumed ~122.8 min of elapsed time and
      // the second N2 slot swallowed cycLeft, so REM was unreachable in
      // real-time staging. Silent: accrual()/plan() aggregate by key and were
      // fine -- only the live dispatch path (heartbeat REM jobs) never fired.
      let dur = stageMin(s, col)
      if (s === 'N2') dur = dur / 2
      dur = Math.min(dur, cycLeft)
      if (dur <= 0) continue
      if (left < dur) { stage = s; break outer }   // 停在这里
      left -= dur
      cycLeft -= dur
    }
    // 这个周期走完了（cycLeft 应该已经 0）
    if (cycLeft > 0.5) { stage = 'N2'; break }     // 兜底：周期表加起来不足 92 分钟时
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
  } catch (e) { swallow(e, 'sleepstage:save') }
  return st
}
