// brain/reflex —— 惊跳反射（2026-11-03 · C5）
//
// 现象：突然一大段话砸过来，人还没想，身体先一激灵；紧接着再砸一下就钝了。
// 机制：pre-attentive startle —— 脑干级，先于一切语义处理：不进决策、不进记忆、
//       不落盘（反射弧没有"昨天"）。只有一维标量刺激：长文本/感叹密度/@我。
// 防电路板化：一阈值一不应期，零业务分支。习惯化复用 receptor 池的既有数学
//（同款 Michaelis-Menten 占用/内化）—— 30 秒内第二响信号减半，几分钟恢复。
// 专用快常数：惊跳习惯化是**秒级**（默认受体 0.055/min 是小时级交互的标定），
// 内化 1.3/min：30s 间隔第二响 ~0.43，2 分钟后基本复原（startle-test 钉住）。
import * as rec from './micro/receptor.mjs'
import * as field from './field.mjs'

const THRESHOLD = 0.75          // 一阈值
const REFRACTORY_MS = 1000      // 一不应期
// 反射弧受体专用常数（每分钟）：惊跳习惯化是**秒级**，默认受体标定是小时级交互
//（0.055 内化/0.014 回收）。内化 1.3 + 回收 0.7：30s 第二响 ~一半，2 分钟基本复原。
const K_INT_STARTLE = 1.3
const K_REC_STARTLE = 0.7
const STIM_WINDOW_MS = 30_000   // 一响的「占据时长」：习惯化 = 占用 x 时间的物理量
const MAX_GAP_MS = 10 * 60_000  // 更久的沉默等价于满血（也让 evolveLong 不至于切上百万步）

let pool = rec.empty()          // 纯内存：进程重启即满（反射不记得昨天）
let lastFireAt = 0

/** 刺激强度：一维标量。0..1。 */
export function intensity({ text = '', atMe = false } = {}) {
  const len = Math.min(1, String(text || '').length / 300)
  const bangs = Math.min(1, ((String(text || '').match(/[!！?？]/g) || []).length) / 3)
  const at = atMe ? 1 : 0
  return Math.min(1, 0.5 * len + 0.3 * bangs + 0.2 * at)
}

/**
 * 惊跳门：同步、纯内存。超阈值 -> field.poke('ne') 瞬时脉冲。
 * @returns {{fired:boolean, signal:number, why:string}}
 */
export function startle(stim = {}, now = Date.now()) {
  const s = typeof stim === 'number' ? Math.max(0, Math.min(1, Number(stim) || 0)) : intensity(stim)
  if (now - lastFireAt < REFRACTORY_MS) return { fired: false, signal: 0, why: 'refractory' }
  if (s < THRESHOLD) return { fired: false, signal: 0, why: 'subthreshold' }
  // 只有真 fired 才推进反射弧的受体池（阈下/不应期不算「响过」）
  // 静默期恢复（配体 0），再给一响的占据窗：内化量 = 占用 x 时间，
  // 所以 30s 内第二响的膜受体少、信号弱；几分钟静默后基本复原。
  const arc = { kInternalize: K_INT_STARTLE, kRecycle: K_REC_STARTLE }
  const gap = Math.min(Math.max(0, now - Number(pool.at || 0)), MAX_GAP_MS)
  pool = rec.evolveLong(pool, 0, gap || 1, arc).r
  const drive = Math.min(1, s)
  const sig = rec.evolve(pool, drive, STIM_WINDOW_MS, arc)
  pool = sig.r
  lastFireAt = now
  // 瞬时 NE 脉冲（field.poke 同款冲量，tau 12min 自行弛豫）：幅度按信号缩放
  try { field.poke('ne', 0.06 * sig.signal, { why: 'startle', now }) } catch { /* 场写不进反射照走 */ }
  return { fired: true, signal: Number(sig.signal.toFixed(3)), why: 'startle' }
}

/** 体检口（diagnose 用）：只读。 */
export function snapshot() {
  return { tone: rec.describe(pool).tone, refractoryIn: Math.max(0, REFRACTORY_MS - (Date.now() - lastFireAt)), threshold: THRESHOLD }
}
