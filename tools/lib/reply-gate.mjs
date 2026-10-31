// 接话判断（10-31）—— 决定"这条要不要回、隔多久回"。
//
// 为什么需要：现在私聊**每条必回**，而且立刻回。真人不是这样：
//   · 他发了个"嗯" / 一张图 / 一句"我去洗澡了" —— 不必回
//   · 他连发三条正在说一件事 —— 等他说完再回（通道的合并已经做了前半截）
//   · 他半夜发一句"睡不着" —— 该回，但要慢一点，像被吵醒
//   · 他发个表情包 —— 回个表情就够，不用写一段话
//
// 设计原则（重要）：
//   ① **优先回**：宁可多回，也不要让她变成已读不回的冷机器。默认阈值偏向"回"。
//   ② 不预设门槛：不是"判断该不该回"，而是"这条像不像需要接话"。
//   ③ 有停顿：回之前有思考时间，长短跟内容重量相关（不是固定 2 秒假动作）。
//   ④ 可关：config.qq.replyGate.enabled=false 退回每条必回。
import { config } from './config.mjs'
import { swallow } from './swallow.mjs'

/** 一眼就知道不必回的（省一次 LLM 调用）。 */
const NO_REPLY_PATTERNS = [
  /^(嗯+|哦+|噢+|啊+|哈+|呵+|额+|呃+)[。.!！~～…]*$/,
  /^(好的?|收到|行|OK|ok|嗯嗯|知道了|明白)[。.!！~～…]*$/,
  /^(晚安|早安|早上好|午安|睡了|去洗澡|洗澡去|吃饭去|出门了|我走了|忙去了)[。.!！~～…]*$/,
  /^[👍👌🙏😂😊😄😁🤣😴🌙❤️💤]+$/u,
]

/** 一看就该认真回的（跳过 LLM 判断，直接回）。 */
const MUST_REPLY_PATTERNS = [
  /[？?]/,                                    // 问句
  /(帮我|替我|能不能|可以帮|麻烦)/,             // 请求
  /(怎么办|为什么|是不是|要不要|该不该)/,       // 征询
  /(难受|难过|想哭|抑郁|崩溃|撑不住|烦死|委屈|失眠|睡不着)/, // 情绪求助
  /(在吗|在不在)/,   // 呼叫语：必须快回（见 delay 分支）
]

const isNoReply = (t) => NO_REPLY_PATTERNS.some((re) => re.test(t))
const isMustReply = (t) => MUST_REPLY_PATTERNS.some((re) => re.test(t))

/**
 * 判断这条要不要回、隔多久回。
 * @param {object} p
 * @param {string} p.text      本轮文本（已合并）
 * @param {number} p.merged    合并了几条
 * @param {boolean} p.isGroup
 * @param {boolean} p.atMe     群里是否被@
 * @param {string} [p.extra]   额外标记（图片/引用等）
 * @param {string} [p.chatId]
 * @returns {Promise<{reply:boolean, delayMs:number, why:string}>}
 */
export async function decideReply({ text = '', merged = 1, isGroup = false, atMe = false, extra = '', chatId = '' }) {
  const cfg = config()
  const g = cfg.qq?.replyGate ?? {}
  if (g.enabled === false) return { reply: true, delayMs: 0, why: 'gate-off' }

  const t = String(text || '').trim()
  // 注意：实际文案是「【她发来一张图片…】」，带「她」字。
  // 10-31 踩过：只写 /【发来一张图片/ 匹配不到 → 图片全走 LLM 判 → 被判"不必接"。
  const hasImage = /【[^】]*发来一张图片/.test(String(extra || ''))

  // 群里没被 @：默认不回（这是原有语义，别动）
  if (isGroup && !atMe && cfg.qq?.at_only !== false) return { reply: false, delayMs: 0, why: '群聊未@' }

  // ① 明显不必回的短句
  if (!hasImage && isNoReply(t)) return { reply: false, delayMs: 0, why: '寒暄/收尾语' }

  // ② 明显该回的（问句/请求/情绪）→ 秒回不合适，但也不用纠结
  const must = isMustReply(t)
  // ③ 图片：不主动评价，但**给个反应**（真人看到图会"哦"一声）。
  // 注意这一条必须放在 LLM 判断之前 —— 实测模型会判"图片不必接"，那是错的。
  if (hasImage) {
    return { reply: true, delayMs: rand(g.imageDelayMin ?? 1200, g.imageDelayMax ?? 2600), why: '发图了，给个短反应（不评价）' }
  }

  const baseMin = Number(g.minDelayMs ?? 1200)
  const baseMax = Number(g.maxDelayMs ?? 4200)

  // ④ 需要 LLM 判的那些（既不明显该回、也不明显不必回）
  if (!must) {
    try {
      const llm = await import('./llm.mjs')
      const recent = g.contextLines ?? 6
      const ask = [
        { role: 'user', content: `判断下面这句话是否需要"接话"。只输出 JSON：{"reply":true|false,"delay":毫秒}\n\n判断标准（宁可信其需）：\n- 他在分享/吐槽/自言自语/发牢骚 → **要接**（true）\n- 他在陈述事实但明显是想让你知道 → **要接**\n- 只是"嗯/好的/晚安"这种收尾 → 不接（false）\n- 他在评论你刚说的话（比如"哈哈""确实"）→ 通常不用回，除非带问号\n- 发了一张图但没说话 → 接，但只用一句话或一个表情\n\n他这句：「${t.slice(0, 300)}」\n${merged > 1 ? `（他连着发了 ${merged} 条）` : ''}` },
      ]
      const raw = await llm.chat(ask, { temperature: 0.2, max_tokens: 80, timeoutMs: 8000, purpose: 'fast' })
      const m = String(raw || '').match(/\{[\s\S]*\}/)
      if (m) {
        const j = JSON.parse(m[0])
        const reply = j.reply !== false
        const delay = Number(j.delay)
        return {
          reply,
          delayMs: Number.isFinite(delay) ? clamp(delay, 600, 15000) : rand(baseMin, baseMax),
          why: reply ? 'LLM:该接' : 'LLM:不必接',
        }
      }
    } catch (e) { swallow(e, 'reply-gate:llm') }
    // LLM 判不了 → 默认回（宁可多回，也别已读不回）
  }

  // ⑤ 停顿：跟"这句话有多重"相关，不是固定假动作。
  //    实测调参：呼叫语（在吗）必须**快**（1~1.6s，像立刻摸手机），
  //    短问题 ~1.5-2.5s，长吐槽/情绪 ~2.5-4.5s（像组织了一下话）。
  const isCall = /^(在吗|在不在|喂|人呢)/.test(t)
  if (isCall) return { reply: true, delayMs: Math.round(rand(g.callDelayMin ?? 900, g.callDelayMax ?? 1600)), why: '呼叫语(快回)' }

  const weight = Math.min(1, t.length / 90) + (must ? 0.3 : 0) + (merged > 1 ? 0.25 : 0)
  const delay = rand(baseMin, baseMax) * (0.6 + weight * 0.8)
  return { reply: true, delayMs: Math.round(clamp(delay, 900, 8000)), why: must ? '该接(问句/请求/情绪)' : '该接' }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)))
const rand = (lo, hi) => Math.round(Number(lo) + Math.random() * Math.max(0, Number(hi) - Number(lo)))

/** 简单统计（面板/diagnose 用）。 */
export const stats = { considered: 0, skipped: 0, replied: 0 }
export function noteDecision(d) {
  stats.considered++
  if (d.reply) stats.replied++; else stats.skipped++
}

/**
 * 给调用方用的一站式入口：判断 + 停顿 + 日志。
 * 把这段留在 qq-server 里会撑爆它的行数，也测不了 —— 放这里。
 * @returns {Promise<boolean>} true=该回（且已停顿完），false=这条不接
 */
export async function gate({ text, merged = 1, isGroup = false, atMe = false, extra = '', chatId = '', log = () => {} }) {
  const d = await decideReply({ text, merged, isGroup, atMe, extra, chatId })
  noteDecision(d)
  if (!d.reply) {
    log('[qq] 🤐 这条不接（' + d.why + '）：' + String(text || '').slice(0, 30))
    return false
  }
  if (d.delayMs > 0) {
    // 人是先看到、停顿、再打字。停顿期间界面上会有"正在输入"，比干等自然。
    log('[qq] ⏳ 停顿 ' + d.delayMs + 'ms 再回（' + d.why + '）')
    await new Promise((r) => setTimeout(r, d.delayMs))
  }
  return true
}
