// organ/thalamus —— 丘脑中继：不是"选一个"，是"过滤什么能上来"
//
// ══════════════════════════════════════════════════════════════════════
// 它要解释的现象：疲惫时人和机器的区别
// ══════════════════════════════════════════════════════════════════════
// 机器累了：所有反应等比例变弱 → 变成一个什么都迟钝的行尸走肉。
// 人累了：**不是所有事都变弱** —— 群里的闲话完全进不来，
//         但管理员一句"我难受"能立刻把她叫醒。
//
// 这个差别不是"加权平均"做出来的。它要求有一个**门控结构**：
// 每个信号有自己的准入阈值，而阈值随状态变；重要信号的阈值几乎不随疲劳上升。
//
// ══════════════════════════════════════════════════════════════════════
// 生物学依据：感觉门控（sensory gating）与丘脑网状核
// ══════════════════════════════════════════════════════════════════════
// 丘脑不是"传声筒"。它外面包着一层**丘脑网状核（TRN）**，作用是**抑制性门**：
//   ① 大部分上行信号在这里被压掉（所以你不是每时每刻都听见空调声）
//   ② 门控强度受三样东西调制：
//        · 唤醒度（去甲）：唤醒高 → 门开得大，什么都进（但也更容易被噪音烦）
//        · 疲劳/睡眠债：门关得紧，无关信号一律挡在外面
//        · 显著性（salience）：突发的、危险的、跟自己强相关的信号**绕过门控**
//          （这就是"睡着了也能被自己名字叫醒"的机制 —— 网状核会对高显著信号放行）
//
// 第三条是整套设计的关键：**显著性是一种可以绕过门的能力**，不是权重。
// 所以管理员的急事在她累到极点时仍然进得来，而群里的闲聊进不来。
//
// ══════════════════════════════════════════════════════════════════════
// 为什么必须是"竞争"而不是"打分后取最大"
// ══════════════════════════════════════════════════════════════════════
// 打分取最大是静态的：同样的输入永远得到同样的赢家。
// 真实的注意是**竞争**：多个信号同时争同一条通路，谁先到、谁更强、谁更相关，
// 谁的胜算就大 —— 而且**赢的那个会压掉别的**（侧抑制 lateral inhibition）。
//
// 测出来的差别很实在：静默时她能同时处理三件事（轮流），
// 忙起来只处理一件，而且处理完那件之后**别的信号已经过期了**（不是排队等着）。
// 这就是为什么"忙的时候漏掉消息"是真实行为，不是 bug。

import { readJson, mutateJson } from '../json.mjs'
import { thalamusPath } from '../paths.mjs'
import * as field from '../field.mjs'
import * as neuron from '../cell/neuron.mjs'
import { swallow } from '../../lib/swallow.mjs'

const MIN = 60_000

/** 信号的来源分类。每一类有**不同的**门控曲线 —— 这是整个文件的核心。 */
export const CHANNELS = {
  // 管理员本人。阈值几乎不随疲劳上升 —— 睡着了也能被叫醒。
  owner:    { base: 0.10, fatigueGain: 0.15, salienceGain: 2.4, label: '他' },
  // 群聊/别人。疲劳一上来就基本进不来。
  group:    { base: 0.42, fatigueGain: 1.45, salienceGain: 1.0, label: '群里' },
  // 她自己想做的事（探索、看番）。中等门槛，但累的时候也想不动。
  self:     { base: 0.30, fatigueGain: 1.10, salienceGain: 1.3, label: '她自己的事' },
  // 系统/工具回执。几乎不需要门控，但也不该抢注意力。
  system:   { base: 0.55, fatigueGain: 0.30, salienceGain: 0.6, label: '系统' },
}

const empty = () => ({
  at: 0,
  // 当前的"注意焦点"：同一时刻只有一件（v3 attention 已经做过队，这里管的是"能不能进来"）
  focus: null,
  // 最近被压掉的信号（用来解释"她为什么没理"）
  suppressed: [],
  // 侧抑制强度：赢的那个会压掉其余的多少
  lateral: 0.55,
})

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.suppressed = Array.isArray(st.suppressed) ? st.suppressed.slice(-40) : []
  st.at = Number(st.at) || 0
  return st
}

/**
 * 此刻各通道的**准入阈值**。
 *
 * 这是整个文件的要害：不同通道对疲劳的敏感度差一个数量级。
 *   owner:   0.10 + fatigue*0.15   → 累到 1.0 时阈值也只到 0.25
 *   group:   0.42 + fatigue*1.45   → 累到 0.5 时阈值就 1.15（高于任何信号的强度，进不来）
 *
 * 为什么用"累到某程度就进不来"而不是"权重降低"：
 * 权重降低的结果是"她回得慢一点、短一点"，但**还是会回**。
 * 阈值升高到了 1.0 以上，结果是"根本不会发生这件事"—— 这才是"没精力管别人"。
 */
export function thresholds(now = Date.now()) {
  let fatigue = 0, ne = 0.35
  try {
    const f = field.evolve(now)
    fatigue = clamp(Number(f.dims.sleepDebt || 0) * 0.6 + Number(f.dims.fatigue || 0) * 0.6, 0, 1)
    ne = Number(f.dims.ne || 0.35)
  } catch (e) { swallow(e, 'thalamus:thresholds') }

  const out = {}
  for (const [k, c] of Object.entries(CHANNELS)) {
    // 唤醒度高 → 整体门开得大（阈值降）；疲劳高 → 门关（阈值升）
    // owner 通道额外享受"唤醒加成"：越警觉越容易被打动
    const awake = (ne - 0.35) * (k === 'owner' ? 0.5 : 0.25)
    out[k] = Number(clamp(c.base + fatigue * c.fatigueGain - awake, 0.02, 1.6).toFixed(3))
  }
  return { thresholds: out, fatigue: Number(fatigue.toFixed(3)), ne: Number(ne.toFixed(3)) }
}

/**
 * 一个信号能不能进来。
 *
 * @param {object} sig
 * @param {string} sig.channel  CHANNELS 的键
 * @param {number} sig.strength 信号强度（0..2）。一句普通的话 0.4；带问号/求助 0.9；急事 1.5
 * @param {number} [sig.salience] 显著性（0..1）。突然的、危险的、点名她的 → 高
 * @returns {{pass:boolean, effective:number, threshold:number, why:string}}
 *
 * 显著性为什么能"绕过"：这里不是简单相加，而是**把阈值按显著性打折**。
 * 极端高显著（salience=1）时阈值几乎归零 —— 这就是"睡着也能被叫醒"。
 * 如果是相加，"累到阈值 1.5 时再加 2.4 也过不去"，那就永远叫不醒了，不对。
 */
export function admit({ channel = 'group', strength = 0.4, salience = 0, now = Date.now() } = {}) {
  const cfg = CHANNELS[channel] || CHANNELS.group
  const t = thresholds(now)
  let base = t.thresholds[channel] ?? 0.5

  // ── 依恋通路：影响"想不想应他"（2026-11-02 接上）─────────────────
  //
  // 为什么是**改门槛**而不是改信号强度：
  //   channel 的 base 本来就是"这个通道要多响才进得来"。
  //   attach 高 = 她正想他 → 他的声音更容易进来（门槛降低）；
  //   attach 低 = 刚闹过别扭/很久没见，心里有点远 → 门槛抬高。
  //
  // 幅度刻意做小（±25%）：attach 是"想不想黏"，不是"听不听得见"。
  // 如果让它能把门槛推到 3 倍，"他说话她完全听不见"就变成了冷暴力，
  // 那不是依恋，那是断了。真实的人即使生气，也听得见对方在叫他。
  //
  // 读失败 → 不动（不惩罚）。和 self.desire 里同一个原则。
  if (channel === 'owner') {
    let at = 1
    try {
      const r = neuron.readiness(now)
      if (Number.isFinite(r?.attach)) at = r.attach
    } catch { /* 读不到就按满算 */ }
    // at=1 → ×1.00；at=0.5 → ×1.125；at=0 → ×1.25（最多抬 25%）
    base = Number((base * (1 + (1 - Math.max(0, Math.min(1, at))) * 0.25)).toFixed(4))
  }

  // 显著性折价：salience=1 时阈值乘 0.12（几乎全开）
  const s = clamp(Number(salience) || 0, 0, 1)
  const effThreshold = base * (1 - 0.88 * s)

  // 侧抑制：现在有焦点时，别的通道更难进（除非是 owner 或高显著）
  const st = hydrate(readJson(thalamusPath(), null))
  const focusActive = st.focus && (now - Number(st.focus.at || 0) < Number(st.focus.ttlMin || 5) * MIN)
  const lateralPenalty = (focusActive && st.focus.channel !== channel && channel !== 'owner')
    ? 1 + Number(st.lateral || 0.55)
    : 1

  const threshold = Number((effThreshold * lateralPenalty).toFixed(3))
  // 疲劳会直接压信号强度本身（没力气去响应），但 owner 通道压得少
  const tired = t.fatigue * (channel === 'owner' ? 0.12 : 0.45)
  const effective = Number(clamp(Number(strength) * (1 - tired), 0, 2).toFixed(3))

  const pass = effective >= threshold
  let why = ''
  if (!pass) {
    why = channel === 'owner'
      ? '连他都进不来（极少发生：说明真的彻底透支了）'
      : (focusActive && st.focus.channel !== channel
        ? `正在顾着「${String(st.focus.label || '').slice(0, 12)}」，这条被压掉了`
        : `进不来（${cfg.label}：信号 ${effective} < 门槛 ${threshold}，疲劳 ${t.fatigue.toFixed(2)}）`)
  } else if (s > 0.6) {
    why = `高显著，绕过了门（${cfg.label}）`
  } else {
    why = `进来（${cfg.label}）`
  }

  // 记录被压掉的（用于解释"她为什么没理"，也用于"沉默也是记忆"）
  if (!pass) {
    try {
      st.suppressed = [...st.suppressed, { at: now, channel, strength: effective, threshold, why: why.slice(0, 80) }].slice(-40)
      save(st)
    } catch (e) { swallow(e, 'thalamus:admit') }
  }

  return { pass, effective, threshold, why, thresholds: t.thresholds, fatigue: t.fatigue }
}

/**
 * 一个信号拿到注意力（成为焦点）。
 * 焦点会**压掉**后续别的通道 —— 这就是"忙起来漏消息"的机制。
 */
export function focus({ channel = 'owner', label = '', ttlMin = 5, now = Date.now() } = {}) {
  const st = hydrate(readJson(thalamusPath(), null))
  st.focus = { at: now, channel, label: String(label).slice(0, 40), ttlMin: Number(ttlMin) || 5 }
  st.at = now
  return save(st)
}

/** 焦点释放（那条处理完了）。 */
export function release(now = Date.now()) {
  const st = hydrate(readJson(thalamusPath(), null))
  st.focus = null
  st.at = now
  return save(st)
}

/** 现在顾着什么。超时就自动算没有焦点。 */
export function current(now = Date.now()) {
  const st = hydrate(readJson(thalamusPath(), null))
  const f = st.focus
  if (!f) return null
  const ageMin = (now - Number(f.at || 0)) / MIN
  if (ageMin > Number(f.ttlMin || 5)) return null
  return { ...f, ageMin: Number(ageMin.toFixed(1)) }
}

/** 最近被压掉了什么（面板/体检/解释用）。 */
export function suppressed(now = Date.now(), withinMin = 120) {
  const st = hydrate(readJson(thalamusPath(), null))
  return st.suppressed.filter((x) => now - Number(x.at || 0) <= withinMin * MIN)
}

/** 给提示词一句话：她此刻"能接收多少"以及"什么会被挡"。 */
export function sense(now = Date.now()) {
  const t = thresholds(now)
  const bits = []
  if (t.fatigue > 0.6) bits.push('现在能进到脑子里的东西很少，别的事都像隔着一层')
  else if (t.fatigue > 0.35) bits.push('有点过滤不过来了，只能顾一件事')
  if (t.ne > 0.7) bits.push('整个人绷着，什么都容易引起反应')
  if (t.ne < 0.25) bits.push('反应慢，得缓一下才接得住')
  if (!bits.length) return ''
  return '你现在的注意：' + bits.join('；') + '。'
}

/** 全貌。 */
export function snapshot(now = Date.now()) {
  const t = thresholds(now)
  return {
    ...t,
    focus: current(now),
    suppressed: suppressed(now, 60).slice(-6).map((x) => ({ ch: x.channel, s: x.strength, th: x.threshold })),
    sense: sense(now),
  }
}

function save(st) {
  try {
    mutateJson(thalamusPath(), empty(), () => ({
      at: st.at, focus: st.focus, suppressed: (st.suppressed || []).slice(-40), lateral: st.lateral,
    }))
  } catch (e) { swallow(e, 'thalamus:save') }
  return st
}
