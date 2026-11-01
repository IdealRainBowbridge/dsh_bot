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
/**
 * 对话节奏账（每个会话一份）：记录"最近谁说了几句"。
 * 不落盘，进程内即可（重启归零不影响体验）。
 */
const RHYTHM = new Map()  // chatId -> { turns: [{who, at}], lastReplyAt }
function rhythmOf(chatId) {
  let r = RHYTHM.get(chatId)
  if (!r) { r = { turns: [], lastReplyAt: 0 }; RHYTHM.set(chatId, r) }
  return r
}
function pushTurn(chatId, who, at = Date.now()) {
  const r = rhythmOf(chatId)
  r.turns.push({ who, at })
  if (r.turns.length > 24) r.turns = r.turns.slice(-24)
  return r
}

async function _decideInner({ text = '', merged = 1, isGroup = false, atMe = false, extra = '', chatId = '' }) {
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

  // ── ①.2 身体先说话（2026-11-02）────────────────────────────────────
  // 这一段是本轮最重要的一处：**决定她说什么的不该只是"这句话该不该回"，
  // 而首先是"她现在有没有余量"**。
  //
  // 生理依据（三条，都不是比喻）：
  //   · 缺觉会压掉表达意愿（voiceReadiness 掉），但**不会压掉"必须回"**
  //     —— 家里人来问你事，困成什么样也会答。所以阈值只对"可回可不回"生效。
  //   · 皮质醇 + 低血清素 → 冲（irritability 高）。冲的时候她会回得更短、更硬，
  //     而不是不回。这是"没耐心"的形状，不是"冷处理"。
  //   · 血清素决定**能等多久**（patience）。等不住的回复是又短又急，
  //     而不是"故意晚回"—— 晚回是冷淡，急回才是没耐心。这两者不能搞反。
  let body = null
  try {
    const F = await import('../brain/field.mjs')
    body = {
      readiness: F.voiceReadiness(),
      depth: F.cognitiveDepth(),
      patience: F.patience(),
      irritability: F.irritability(),
      sense: F.sense(),
    }
  } catch { /* 场读不到就按"状态平稳"走，绝不让身体层挡住聊天 */ }

  // 缺觉到很低的意愿 + 这条本来就是可回可不回 → 今天先不回（但不装没看见）
  if (body && body.readiness < 0.22 && !isMustReply(t)) {
    return { reply: false, delayMs: 0, why: '没余量（意愿 ' + body.readiness.toFixed(2) + '）', body }
  }

  // ①.5 对话节奏（零成本启发式，不调 LLM）
  //
  // ⚠️ 这里踩过一个设计错误，记下来：
  // 最初写的是"她连说 >=2 句就压一次"，但在一问一答的流程里
  // **每次 decideReply 前面必有一条 them**，myStreak 永远是 0 —— 那段代码是死的。
  // 真正会发生的场景是"连珠炮"：他一句，她回；他马上又一句短的，她马上又回 → 太黏。
  //
  // 现在只做一件事：**短时间内被连续追问时，放慢**（不是不回）。
  // 不回会变成已读不回，比慢更糟。
  const r = pushTurn(chatId, 'them')
  const nowMs = Date.now()
  const lastMe = [...r.turns].reverse().find((x) => x.who === 'me')
  r.rapid = !!(lastMe && nowMs - lastMe.at < 20_000)   // 20 秒内她刚回过 = 连珠炮
  if (r.rapid) {
    // 连续追问：多停一会儿，像在打字/没顾上
    r.extraDelay = rand(1500, 3000)
  } else {
    r.extraDelay = 0
  }

  // ② 明显该回的（问句/请求/情绪）→ 秒回不合适，但也不用纠结
  const must = isMustReply(t)
  // ③ 图片：不主动评价，但**给个反应**（真人看到图会"哦"一声）。
  // 注意这一条必须放在 LLM 判断之前 —— 实测模型会判"图片不必接"，那是错的。
  if (hasImage) {
    const imgDelay = rand(g.imageDelayMin ?? 1200, g.imageDelayMax ?? 2600) + Number(r.extraDelay || 0)
    return { reply: true, delayMs: Math.round(imgDelay), why: '发图了，给个短反应（不评价）' + (r.extraDelay ? '(连珠炮，放慢)' : '') }
  }

  const baseMin = Number(g.minDelayMs ?? 1200)
  const baseMax = Number(g.maxDelayMs ?? 4200)

  // ④ 需要 LLM 判的那些（既不明显该回、也不明显不必回）
  if (!must) {
    try {
      const llm = await import('./llm.mjs')
      const recent = g.contextLines ?? 6
      // 一次调用同时拿两件事：①这条要不要接 ②这句话的情绪影响
      // （原来情绪判断是回复完再单独调一次 → 每轮 3 次往返变 2 次）
      const ask = [
        { role: 'user', content: '你是聊天助理。对下面这句「对方的话」输出一个 JSON（不要别的）：\n{"reply":true|false,"delayTier":1|2|3,"v":-1到1,"a":0到1}\n\nreply = 是否需要回应：分享/吐槽/自言自语/发牢骚=true；陈述事实但明显想让你知道=true；"嗯/好的/晚安/哈哈/确实/睡了"这类收尾或附和=false；带问号的一律 true。\ndelayTier = 停顿档位：1=随口一说/寒暄，2=正常聊天，3=认真的、有情绪的事。\nv = 这句话的情绪正负（-1 很负，0 中性，1 很正）；a = 强度（0-1）。\n\n对方说：「' + t.slice(0, 300) + '」' + (merged > 1 ? '（连着发了 ' + merged + ' 条）' : '') },
      ]
      const raw = await llm.chat(ask, { temperature: 0.2, max_tokens: 90, timeoutMs: 8000, purpose: 'fast' })
      const m = String(raw || '').match(/\{[\s\S]*\}/)
      if (m) {
        const j = JSON.parse(m[0])
        const reply = j.reply !== false
        // LLM 只给档位，毫秒由这里算 —— 实测让模型直接给毫秒它会给得偏小
        const tier = Number(j.delayTier) || 2
        const delay = tier === 1 ? rand(900, 1600) : tier === 3 ? rand(2600, 5200) : rand(1400, 2800)
        // 顺手把情绪写进 affect —— 省掉"回复完再单独调一次判情绪"那次往返
        const v = Number(j.v), a = Number(j.a)
        if (Number.isFinite(v)) {
          try {
            const aff = await import('../brain/affect.mjs')
            if (aff && typeof aff.feel === 'function') {
              // 压缩到 ±0.7：实测模型动辄给 ±0.9，情绪曲线会抖成锯齿
              const vv = Math.max(-0.7, Math.min(0.7, v * 0.8))
              await aff.feel({ valence: vv, arousal: Number.isFinite(a) ? Math.max(0.1, Math.min(0.9, a)) : 0.3 })
            }
          } catch (e) { swallow(e, 'reply-gate:affect') }
        }
        return {
          reply,
          delayMs: Math.round(clamp((Number.isFinite(delay) ? delay : rand(baseMin, baseMax)) + Number(r.extraDelay || 0), 600, 15000)),
          why: (reply ? 'LLM:该接' : 'LLM:不必接') + (r.extraDelay ? '(连珠炮，放慢)' : ''),
          affect: Number.isFinite(v) ? { v: Math.max(-0.7, Math.min(0.7, v * 0.8)), a } : null,
        }
      }
    } catch (e) { swallow(e, 'reply-gate:llm') }
    // LLM 判不了 → 默认回（宁可多回，也别已读不回）
  }

  // ⑤ 停顿：跟"这句话有多重"相关，不是固定假动作。
  //    实测调参：呼叫语（在吗）必须**快**（1~1.6s，像立刻摸手机），
  //    短问题 ~1.5-2.5s，长吐槽/情绪 ~2.5-4.5s（像组织了一下话）。
  const isCall = /^(在吗|在不在|喂|人呢)/.test(t)
  if (isCall) {
    // 2026-11-02：呼叫语不再只是"报个到就完"。
    // 旧行为：在吗 → "在呢" → 结束。人不会这样 —— 真人被叫住，会顺手把话头递回来
    // （"在呢，正好跟你说个事…"）。这里加 openThread，让 persona 层去决定递什么，
    // 递什么由她当下的计划/日记/情绪决定，不是这里硬塞。
    return {
      reply: true,
      delayMs: Math.round(rand(g.callDelayMin ?? 900, g.callDelayMax ?? 1600) + Number(r.extraDelay || 0)),
      why: '呼叫语(快回+递话头)' + (r.extraDelay ? '(连珠炮，放慢)' : ''),
      openThread: true,
    }
  }

  const weight = Math.min(1, t.length / 90) + (must ? 0.3 : 0) + (merged > 1 ? 0.25 : 0)
  // 耐性低 → 间隔短（不是"故意晚回"，是等不住）。耐性高 → 会多想一会儿。
  // 这个乘法必须放在这里而不是去改 baseMin/baseMax：那是配置，这是状态。
  const pace = body ? (1.25 - 0.55 * body.patience) : 1
  const base = rand(baseMin, baseMax) * (0.6 + weight * 0.8) * pace
  const delay = base + Number(r.extraDelay || 0)      // 连珠炮时再慢一点
  const why = (must ? '该接(问句/请求/情绪)' : '该接') + (r.extraDelay ? '(连珠炮，放慢)' : '')
  return { reply: true, delayMs: Math.round(clamp(delay, 900, 9000)), why, body }
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
 * 对外入口：判一次，并把"她回了/没回"记进节奏账。
 * 为什么用包装而不是在内部每个 return 点记账：内部有 6 个 return，
 * 漏一个就少记一次，节奏就不准了（实测踩过：myStreak 永远是 0）。
 */
export async function decideReply(args = {}) {
  const d = await _decideInner(args)
  const cid = String(args.chatId || '')
  try {
    if (cid && d && d.reply) pushTurn(cid, 'me')
  } catch (e) { swallow(e, 'reply-gate:rhythm-commit') }
  // 10-31：不回 ≠ 没看见。记下这条，下次聊天才能自然接上（她真的"看了没接"）
  try {
    if (cid && d && d.reply === false && args.text) {
      const SK = await import('./skipped-messages.mjs')
      SK.noteSkipped({ chatId: cid, platform: args.platform || 'qq', text: args.text, why: d.why })
    }
  } catch (e) { swallow(e, 'reply-gate:skip-note') }
  return d
}

/**
 * 给调用方用的一站式入口：判断 + 停顿 + 日志。
 * 把这段留在 qq-server 里会撑爆它的行数，也测不了 —— 放这里。
 * @returns {Promise<boolean>} true=该回（且已停顿完），false=这条不接
 */
export async function gate({ text, merged = 1, isGroup = false, atMe = false, extra = '', chatId = '', platform = 'qq', log = () => {} }) {
  // platform 必须透下去：noteSkipped 按 platform 记，微信/抖音的"没接的话"混进 qq 会串台
  const d = await decideReply({ text, merged, isGroup, atMe, extra, chatId, platform })
  noteDecision(d)
  if (!d.reply) {
    log('[qq] 🤐 这条不接（' + d.why + '）：' + String(text || '').slice(0, 30))
    // 仍然返回对象：调用方用 `!g.decision.reply` 判断，兼容旧的 truthiness 用法
    return { reply: false, why: d.why, openThread: false, delayMs: 0, body: d.body || null }
  }
  if (d.delayMs > 0) {
    // 人是先看到、停顿、再打字。停顿期间界面上会有"正在输入"，比干等自然。
    log('[qq] ⏳ 停顿 ' + d.delayMs + 'ms 再回（' + d.why + '）')
    await new Promise((r) => setTimeout(r, d.delayMs))
  }
  // 2026-11-02：把 openThread 透出来 —— 呼叫语（在吗）时要让她递个话头，不是只报平安。
  return { reply: true, why: d.why, openThread: d.openThread === true, delayMs: d.delayMs, body: d.body || null }
}
