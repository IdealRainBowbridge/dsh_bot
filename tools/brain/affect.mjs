// brain/affect —— 情绪与显著性（杏仁核）+ 调制层（多巴胺/去甲/血清素）。
//
// 与旧 mood.mjs 的分工：mood.mjs 管"饿不饿/几点/语气"，这里管**记忆的着色**。
// 三条硬规矩：
//   1. 情绪影响写入权重与召回偏置，不影响"存不存"。
//   2. 睡眠淡化：昨天吵的架今天提起来是"当时有点急"，不是原样再气一遍。
//   3. 只有**兑现**给奖励（多巴胺），"嘴上答应"不给 —— 这是治空口承诺的根。
import { readJson, mutateJson } from './json.mjs'
import { affectPath } from './paths.mjs'

const empty = () => ({ valence: 0, arousal: 0.3, tension: 0, updatedAt: 0, log: [] })

export function state() {
  return { ...empty(), ...(readJson(affectPath(), empty()) || {}) }
}

function label(v, a, tension) {
  if (tension >= 2 && v <= -0.1) return '心里压着事'
  if (v >= 0.35 && a >= 0.55) return '雀跃'
  if (v >= 0.15) return '高兴'
  if (v <= -0.35) return '低落'
  if (a >= 0.65) return '有点上头'
  return '平稳'
}

/** 感受一次（写进记忆的同一份值）。 */
export function feel({ valence = 0, arousal = 0.3 } = {}) {
  const cur = state()
  const next = {
    ...cur,
    valence: Math.max(-1, Math.min(1, Number(((cur.valence || 0) * 0.6 + Number(valence) * 0.4).toFixed(2)))),
    arousal: Math.max(0, Math.min(1, Number(((cur.arousal || 0.3) * 0.6 + Number(arousal) * 0.4).toFixed(2)))),
    updatedAt: Date.now(),
  }
  try { mutateJson(affectPath(), empty(), () => next) } catch {}
  return next
}

/**
 * 兑现奖励（多巴胺）：只有"真的做成了"才调。
 * 失败不加负权重（D2：不做痛感记忆），只把 tension 记进 debts（由 intents 说话）。
 */
export function reward({ weight = 1 } = {}) {
  const cur = state()
  const next = {
    ...cur,
    valence: Math.min(1, Number(((cur.valence || 0) + 0.12 * weight).toFixed(2))),
    arousal: Math.min(1, Number(((cur.arousal || 0.3) + 0.05 * weight).toFixed(2))),
    tension: Math.max(0, Number((cur.tension || 0) - 1)),
    updatedAt: Date.now(),
  }
  next.log = [...(cur.log || []), { at: Date.now(), kind: 'reward', weight }].slice(-50)
  try { mutateJson(affectPath(), empty(), () => next) } catch {}
  return next
}

/** 记一笔"答应了/拖了"（不是痛感，是压力；被 intents 用来解释迟到）。 */
export function tension(n = 1) {
  const cur = state()
  const next = { ...cur, tension: Math.max(0, Number(cur.tension || 0) + Number(n)), updatedAt: Date.now() }
  try { mutateJson(affectPath(), empty(), () => next) } catch {}
  return next
}

/** 睡眠淡化：巩固时调一次（arousal ×0.85，|valence| ×0.9）。 */
export function decay(rounds = 1) {
  const cur = state()
  let v = Number(cur.valence || 0), a = Number(cur.arousal || 0.3)
  for (let i = 0; i < rounds; i++) { v *= 0.9; a = 0.3 + (a - 0.3) * 0.85 }
  const next = { ...cur, valence: Number(v.toFixed(2)), arousal: Number(a.toFixed(2)), updatedAt: Date.now() }
  try { mutateJson(affectPath(), empty(), () => next) } catch {}
  return next
}

/** 提示词一行（≤200 字，进"时钟与情绪"槽）。 */
export function line() {
  const s = state()
  const v = Number(s.valence || 0)
  const moodWord = label(v, Number(s.arousal || 0), Number(s.tension || 0))
  const extra = s.tension >= 2 ? `；心里还压着 ${s.tension} 件事没落地` : ''
  return `你现在的底色：${moodWord}${extra}`
}

/**
 * 第一人称的说法（给「主观」那一层用）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么不要数字（这是被明确否过一次的做法）
 * ══════════════════════════════════════════════════════════════════════
 * 原来 line() 给出的是：
 *     你现在的底色：平稳（情绪 -0.32，唤醒 0.38）
 *
 * 两个问题：
 *   ① **"情绪 -0.32" 不是一个体验。** 人不会知道自己此刻的值是负三毛二。
 *      这是仪表盘的语言。用户的口径是"她**体验到**什么，而不是系统**断言**什么"。
 *   ② 更实际的：模型拿到一个带符号的数字，会忍不住在话里提它
 *      （"我现在心情有点低"变成"我今天状态负的"这类怪话），
 *      或者被数字锚定 —— 看到 -0.32 就觉得"我该是难过的"，
 *      于是明明只是平静也被写成低落。
 *
 * 第一人称的说法只保留**方向**：
 *     "有点提不起劲" / "心里挺松快的" / "说不上好也说不上坏"
 * 人能分辨的是这个，不是小数点。
 */
export function sense() {
  const s = state()
  const v = Number(s.valence || 0)
  const a = Number(s.arousal || 0)
  const bits = []

  // 效价：只给方向，不给量
  if (v >= 0.35) bits.push('心里挺松快')
  else if (v >= 0.12) bits.push('心情是往上的')
  else if (v <= -0.35) bits.push('心里堵得慌')
  else if (v <= -0.12) bits.push('有点提不起劲')

  // 唤醒：高唤醒和低唤醒的体验完全不同，分开说
  if (a >= 0.62) bits.push('人是醒着的，话来得快')
  else if (a <= 0.22) bits.push('整个人都懒得动')

  // 未了之事
  const t = Number(s.tension || 0)
  if (t >= 3) bits.push('好几件事悬着没落地')
  else if (t >= 1.5) bits.push('隐约有件事没落地')

  if (!bits.length) bits.push('说不上好也说不上坏')
  return '我' + bits.join('，') + '。'
}