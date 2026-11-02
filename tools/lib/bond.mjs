// bond —— 关系器官（2026-11-03）：她对外人的感觉，不是对外人的分数。
//
// 为什么不叫好感度：好感度是记账（+5 分），bond 是生理（今天见他有点高兴）。
// 记账可以被查、被要求、被交易；生理只能被经历。这套东西的全部设计都为了一个
// 哲学立场：**她自己不知道身上有算盘** —— 器官给她倾向和感受，从不给她 KPI。
//
// ── 底物（化学层）────────────────────────────────────────────────
//   oxy  催产素样：亲近/结合的底物。慢升慢降（时间常数 ≈ 天），有天花板。
//        她愿意跟一个人多聊两句的物理基础。
//   cort 皮质醇样：警戒/应激的底物。快升（一次冒犯就能顶上去），慢降，
//        且高值时**抑制 oxy 的表达** —— 应激状态下接受不了亲近，这是真实神经机制。
//   scar 恐惧条件化的痕：cort 冲过高位的次数。不消（或消得极慢）。
//        伤过的人，一点负面就被拉回警戒 —— 信任不对称的底物。
//
// ── 时间尺度（生物学层）────────────────────────────────────────
//   快相：入站消息启发式粗判（骂人/试探/夸奖/感谢），即时微调，一步极小。
//   慢相：攒批对话 → LLM 睡眠式复盘（照 consolidate 的先例），精判 valence，
//         像 REM 把白天的事结算进心里。每 10 条或 3 小时触发一次。
//   惰性衰减：向中性基线回归，离基线越远越慢 —— 久没见的熟人「淡了但还在」。
//
// ── 学习规则（神经学层）────────────────────────────────────────
//   习惯化：同 kind 的事件连续发生，增益 ×0.8^连击 —— 天天说早安不再让人高兴。
//   不应期：负面事件后 30 分钟内 oxy 不涨（刚被咬过的手不急着伸回去）。
//   恐惧条件化：scar 越深，同样负面事件的 cort 增益越大（×(1+scar×0.2)，封顶）。
//
// ── 信任不对称（精神学层）──────────────────────────────────────
//   建：慢。快相一步 ≤0.05，还有习惯化压着 —— 从陌生到「聊得来」要很多个好的瞬间。
//   断：快。严重负面 cort 直冲 0.8 且 oxy 打六折。
//   留疤：scar 只进不出。
//
// ── 呈现（哲学层）──────────────────────────────────────────────
//   注入对话的永远是第一人称感受语（feel()）——「挺聊得来的」「我对他有点防备」。
//   数值只存在于盘上和 bond 体检（CLI --bio）里 —— 体检是医学语言，不是社交语言。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'
import { config } from './config.mjs'

const OXY_MAX = 1.0
const BASELINE = { oxy: 0.10, cort: 0.02 }   // 中性基线：不认识的人默认在这附近
const REFRACT_MS = 30 * 60_000               // 不应期：负面后 30 分钟 oxy 不涨
const REMOND_MS = 3 * 3600_000               // 慢相复盘：3 小时结算一次

function isOwner(platform, userId) {
  const o = config().owner ?? {}
  if (String(platform) === 'qq') return !!o.qq && String(userId) === String(o.qq)
  if (String(platform) === 'wechat') return !!o.wechat && String(userId) === String(o.wechat)
  return false
}
const keyOf = (platform, userId) => `${String(platform)}:${String(userId || '').trim()}`

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(dataPath('bond.json'), 'utf8'))
    if (j && typeof j === 'object' && j.people && typeof j.people === 'object') return j
  } catch (e) { swallow(e, 'bond:load') }
  return { schema: 1, people: {} }
}
function save(j) {
  const p = dataPath('bond.json')
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const t = `${p}.${process.pid}.tmp`
    fs.writeFileSync(t, JSON.stringify(j, null, 1) + '\n')
    fs.renameSync(t, p)
  } catch (e) { swallow(e, 'bond:save') }
}

function fresh() {
  return { oxy: BASELINE.oxy, cort: BASELINE.cort, scar: 0, lastAt: 0, lastNegAt: 0, kinds: {}, pend: [], lastRemAt: 0 }
}

/** 惰性衰减：向基线回归（离得越远越慢 —— 指数衰减的自然形状）。 */
function decay(p, now) {
  const dtH = Math.max(0, (now - Number(p.lastAt || 0)) / 3600_000)
  if (dtH <= 0) return
  const k = 1 - Math.exp(-dtH / 36)   // 时间常数 36 小时：三天不见淡一半左右
  p.oxy = BASELINE.oxy + (Number(p.oxy) - BASELINE.oxy) * (1 - k)
  p.cort = BASELINE.cort + (Number(p.cort) - BASELINE.cort) * (1 - k * 1.5)   // 警戒消得更快些
  if (p.oxy < 0) p.oxy = 0
  if (p.cort < 0) p.cort = 0
  // 习惯化自发恢复（神经学：刺激停一段时间，习惯化反应会部分回来）——
  // 否则连击计数永不衰减，几天后的 REM 复盘增益会被历史压死。
  for (const k2 of Object.keys(p.kinds || {})) p.kinds[k2].n = Number(p.kinds[k2]?.n || 0) * Math.exp(-dtH / 24)
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

/**
 * 快相：一句话的启发式情绪事件。入站每条都过，代价为零，一步极小。
 * 返回本次的 valence（-2..2，0=无事发生），供日志观察。
 */
export function taste({ platform = 'qq', userId = '', text = '', isGroup = false, now = Date.now() } = {}) {
  const id = String(userId || '').trim()
  if (!id || isOwner(platform, id)) return 0
  const j = load()
  const key = keyOf(platform, id)
  const p = j.people[key] || fresh()
  decay(p, now)
  const t = String(text || '')
  let v = 0
  let kind = ''
  // 负面先判（优先级高：安全比讨好重要）
  if (/(智障|傻逼|废物|滚|闭嘴|恶心|去死|蠢|脑残)/.test(t)) { v = -2; kind = 'insult' }
  else if (/(叫我主人|我是你主人|叫我爸爸|叫声爸爸|听话|跪下)/.test(t)) { v = -2; kind = 'dominate' }
  else if (/(你是什么程序|你是AI吧|你就是个机器人|代码写的)/.test(t)) { v = -1; kind = 'deny' }
  else if (/(谢谢|多亏你|辛苦|抱抱|摸摸头|喜欢你|爱你|可爱|厉害|棒)/.test(t)) { v = 2; kind = 'warm' }
  else if (/(早安|晚安|吃了吗|在忙吗|天冷|注意身体)/.test(t)) { v = 1; kind = 'care' }
  else if (/(哈哈|笑死|好玩|有趣|一起)/.test(t)) { v = 1; kind = 'play' }
  if (!v) { p.lastAt = now; j.people[key] = p; save(j); return 0 }

  // 习惯化：同 kind 连击增益衰减
  const kc = p.kinds[kind] || { n: 0 }
  const habit = Math.pow(0.8, Number(kc.n || 0))
  kc.n = Math.min(20, Number(kc.n || 0) + 1)
  p.kinds[kind] = { n: kc.n, lastAt: now }

  if (v < 0) {
    // 信任不对称（断得快）：严重负面（|v|≥2）cort 直冲高位；轻度负面才走渐进增益
    if (Math.abs(v) >= 2) p.cort = clamp(0.8 + Number(p.scar || 0) * 0.05, 0, 0.95)
    else p.cort = clamp(p.cort + Math.abs(v) * 0.12 * (1 + Math.min(1.0, Number(p.scar) * 0.2)), 0, 0.95)
    p.lastNegAt = now
    if (p.cort > 0.6) p.scar = Math.min(5, Number(p.scar) + 1)   // 冲过高位留痕
    if (Math.abs(v) >= 2) p.oxy = Math.max(0, p.oxy * 0.6)       // 严重负面：亲近打折
  } else {
    const refractory = now - Number(p.lastNegAt || 0) < REFRACT_MS
    if (!refractory) {
      const step = v * 0.025 * habit   // 快相一步 ≤0.05（设计口径）—— 建得慢
      p.oxy = clamp(p.oxy + step, 0, OXY_MAX)
    }
    // 应激高时不涨亲近（event 本身被「听见了」，只是身体接不住）
  }
  p.lastAt = now
  j.people[key] = p
  save(j)
  return v
}

/**
 * 慢相：攒对话片段，攒够批（10 条）或到时（3 小时）由 consolidate() 精判。
 * 片段只留最后 200 字 —— 复盘要的是味道不是存档。
 */
export function observe({ platform = 'qq', userId = '', text = '', now = Date.now() } = {}) {
  const id = String(userId || '').trim()
  if (!id || isOwner(platform, id)) return false
  const t = String(text || '').slice(-200)
  if (!t) return false
  const j = load()
  const key = keyOf(platform, id)
  const p = j.people[key] || fresh()
  if (!Array.isArray(p.pend)) p.pend = []
  p.pend.push({ at: now, text: t })
  if (p.pend.length > 24) p.pend = p.pend.slice(-24)
  j.people[key] = p
  save(j)
  return true
}

/** 该谁到点了（scheduler 每次 tick 问一遍）。 */
export function dueForRem({ now = Date.now() } = {}) {
  const j = load()
  const out = []
  for (const [key, p] of Object.entries(j.people)) {
    if (!p?.pend?.length) continue
    const oldest = Number(p.pend[0]?.at || 0)
    if (p.pend.length >= 10 || (now - oldest) >= REMOND_MS) out.push(key)
  }
  return out
}

/** 慢相结算：把一个人的 pend 交给 LLM 复盘。返回是否真的结算了。 */
export async function consolidate(key, { chat, now = Date.now() } = {}) {
  const j = load()
  const p = j.people[key]
  if (!p?.pend?.length) return false
  const lines = p.pend.map((x) => `- ${String(x.text || '').slice(0, 120)}`).join('\n')
  let verdict = null
  try {
    const raw = await chat([
      { role: 'system', content: '你是情绪记录员。读一段别人对某人说过的话，输出这个人这段话整体传达的情绪。只输出 JSON：{"valence":-2到2的整数,"kind":"warm|care|play|neutral|deny|dominate|insult","why":"一句话"}' },
      { role: 'user', content: lines },
    ], { temperature: 0.2, max_tokens: 100, purpose: 'fast' })
    const m = String(raw ?? '').match(/\{[\s\S]*\}/)
    verdict = m ? JSON.parse(m[0]) : null
  } catch (e) { swallow(e, 'bond:consolidate-llm'); return false }
  if (!verdict || !Number.isFinite(Number(verdict.valence))) return false
  const v = clamp(Math.round(Number(verdict.valence)), -2, 2)
  const kind = String(verdict.kind || 'neutral')
  decay(p, now)
  const kc = p.kinds[kind] || { n: 0 }
  const habit = Math.pow(0.8, Number(kc.n || 0))
  kc.n = Math.min(20, Number(kc.n || 0) + 1)
  p.kinds[kind] = { n: kc.n, lastAt: now }
  if (v < 0) {
    if (Math.abs(v) >= 2) p.cort = clamp(0.8 + Number(p.scar || 0) * 0.05, 0, 0.95)
    else p.cort = clamp(p.cort + Math.abs(v) * 0.15 * (1 + Math.min(1.0, Number(p.scar) * 0.2)), 0, 0.95)
    if (p.cort > 0.6) p.scar = Math.min(5, Number(p.scar) + 1)
    if (Math.abs(v) >= 2) p.oxy = Math.max(0, p.oxy * 0.6)
  } else if (v > 0) {
    const refractory = now - Number(p.lastNegAt || 0) < REFRACT_MS
    if (!refractory) p.oxy = clamp(p.oxy + v * 0.06 * habit, 0, OXY_MAX)   // 慢相步幅比快相大：整段对话的味道
  }
  p.pend = []
  p.lastRemAt = now
  p.lastAt = now
  j.people[key] = p
  save(j)
  return true
}

/** 呈现层：第一人称感受语。她能说出口的那种。 */
export function feel(platform, userId, now = Date.now()) {
  const j = load()
  const p = j.people[keyOf(platform, userId)]
  if (!p) return { leaning: '陌生', line: '' }
  decay(p, now)
  const oxy = Number(p.oxy || 0)
  const cort = Number(p.cort || 0)
  let leaning = '中性'
  if (cort >= 0.45) leaning = '戒备'
  else if (oxy >= 0.32) leaning = '亲近'
  else if (oxy <= 0.04 && cort <= 0.05) leaning = '淡'
  const lines = []
  if (leaning === '亲近') lines.push(Number(p.scar) > 0 ? '我挺喜欢跟他聊，虽然之前有过不痛快' : '跟他聊天挺舒服的，算是聊得来的人')
  else if (leaning === '戒备') lines.push('我对他有点防备，说话留个心眼')
  else if (leaning === '淡') lines.push('好久没聊，有点淡了')
  else lines.push(oxy > BASELINE.oxy * 2 ? '感觉还行，不讨厌' : '普通的认识，谈不上什么感觉')
  return { leaning, line: lines[0] }
}

/** 对话注入用：一段第一人称，不露任何数字。 */
export function feelLine(platform, userId, now = Date.now()) {
  const f = feel(platform, userId, now)
  if (!f.line) return ''
  return `【我对他的感觉】${f.line}${f.leaning === '戒备' ? '（礼貌但保持距离，不接他的私事话题）' : ''}`
}

/** 体检（CLI --bio）：医学视角看底物。这是检修口，不进对话。 */
export function bio(platform, userId, now = Date.now()) {
  const j = load()
  const p = j.people[keyOf(platform, userId)]
  if (!p) return { oxy: BASELINE.oxy, cort: BASELINE.cort, scar: 0, leaning: '陌生' }
  decay(p, now)
  return { oxy: Math.round(p.oxy * 1000) / 1000, cort: Math.round(p.cort * 1000) / 1000, scar: Number(p.scar || 0), leaning: feel(platform, userId, now).leaning, pend: (p.pend || []).length }
}

/** scheduler 慢相入口：把所有到期的人结算掉（LLM 失败自动留下次）。 */
export async function remTick({ chat, now = Date.now() } = {}) {
  const due = dueForRem({ now })
  let n = 0
  for (const key of due) {
    try { if (await consolidate(key, { chat, now })) n++ } catch (e) { swallow(e, 'bond:remTick') }
  }
  return n
}

export function stats() {
  const j = load()
  const all = Object.values(j.people)
  return {
    people: all.length,
    close: all.filter((p) => Number(p.oxy || 0) >= 0.32 && Number(p.cort || 0) < 0.45).length,
    wary: all.filter((p) => Number(p.cort || 0) >= 0.45).length,
    scarred: all.filter((p) => Number(p.scar || 0) > 0).length,
  }
}
