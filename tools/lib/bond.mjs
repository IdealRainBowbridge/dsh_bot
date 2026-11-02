// bond —— 关系器官 v2（2026-11-03 深改）：她对外人的感觉，不是对外人的分数。
//
// 为什么不叫好感度：好感度是记账（+5 分），bond 是生理（今天见他有点高兴）。
// 记账可以被查、被要求、被交易；生理只能被经历。这套东西的全部设计都为了一个
// 哲学立场：**她自己不知道身上有算盘** —— 器官给她倾向和感受，从不给她 KPI。
//
// ── 底物（化学层）────────────────────────────────────────────────
//   oxy  催产素样：亲近/结合的底物。慢升慢降（时间常数 ≈ 天），有天花板。
//   cort 皮质醇样：警戒/应激的底物。快升，慢降，高值时**抑制 oxy 的表达**。
//   scar 恐惧条件化的痕：只进不出（但见「修复通道」）。
//
// ── 快慢两相（神经学层）────────────────────────────────────────
//   快相 = 杏仁核：启发式反应，**不直接落疤** —— 反应先挂 tempNeg（临时警戒），
//          等慢相复核。误报（反讽/间接引语/语义陷阱）最多留半小时的紧张，不留疤。
//   慢相 = 前额叶：LLM 读整段对话精判 valence，与快相累积的证据**对账**：
//          一致 → 固化（疤在这里落、oxy 在这里长）；矛盾 → 应用修正量。
//          证据不足（快相有反应、LLM 判无事）→ 撤销临时警戒。
//
// ── 情绪耦合（精神学层）────────────────────────────────────────
//   她的情绪与对外人的感觉互相调制（心境一致性加工）：
//   · mood 低落 → 同样的负面落地更重、正面更轻（低谷期看谁都烦）
//   · 被辱骂/被夸 → 轻推她的整体 mood（社交是情绪的来源之一）
//   · 创伤后基线：scar 的人 cort 衰减目标抬高（可以缓和，回不到从前的松）
//
// ── 修复通道（精神学层）────────────────────────────────────────
//   疤不消（记忆不消失），但 cort 可以被真诚道歉降下来 —— 宽恕不是遗忘。
//   「冒犯→道歉→再冒犯→再道歉」循环的宽恕增益递减（forgives 计数）：
//   原谅但记住，第二次道歉不值钱。
//
// ── 其他学习规则 ───────────────────────────────────────────────
//   习惯化：同 kind 连击增益 ×0.8^n，刺激停了会自发恢复（24h）。
//   不应期：负面后 30 分钟内 oxy 不涨（刚被咬过的手不急着伸回去）。
//   曝光效应：高频中性接触微量 oxy 漂移（熟悉≠朋友，但门槛会降）。
//   爱轰炸：短窗口密集恭维且无历史 → 微量警戒（无事献殷勤的不协调检测）。
//   旁观：在群里看他对别人刻薄 → 微量警戒（她评人看他对别人怎样）。
//
// ── 呈现（哲学层）──────────────────────────────────────────────
//   注入对话的永远是第一人称感受语（feel()）。数值只存在于盘上和 bio() 体检口。
import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { updateJson } from './atomic.mjs'
import { swallow } from './swallow.mjs'
import { config } from './config.mjs'
import * as mood from './mood.mjs'

const OXY_MAX = 1.0
const BASELINE = { oxy: 0.10, cort: 0.02 }
const REFRACT_MS = 30 * 60_000
const REMOND_MS = 3 * 3600_000
const TEMP_NEG_TTL = 30 * 60_000      // 杏仁核反应的半衰期：半小时没被确认就散
const EXPOSURE_MIN_GAP = 40 * 60_000  // 曝光效应：两次之间至少隔这么久才计一次
const LOVEBOMB_WINDOW = 10 * 60_000   // 爱轰炸检测窗
const LOVEBOMB_MIN_HIST = 3           // 有历史（>3 次互动）的人才免检

function isOwner(platform, userId) {
  const o = config().owner ?? {}
  if (String(platform) === 'qq') return !!o.qq && String(userId) === String(o.qq)
  if (String(platform) === 'wechat') return !!o.wechat && String(userId) === String(o.wechat)
  return false
}
const keyOf = (platform, userId) => `${String(platform)}:${String(userId || '').trim()}`

function fresh() {
  return {
    oxy: BASELINE.oxy, cort: BASELINE.cort, scar: 0,
    lastAt: 0, lastNegAt: 0, kinds: {}, pend: [], lastRemAt: 0,
    // v2 新底物
    tempNeg: null,            // { at, v } 快相的临时警戒（等慢相复核）
    forgiveState: null,       // { at, windowMs, count } 待兑现的道歉
    forgives: 0,              // 历史宽恕次数（循环增益递减用）
    lastVictimAt: 0,          // 旁观：上次目击他对别人刻薄
    exposure: { lastAt: 0, count: 0 },
  }
}

/** 惰性衰减：向基线回归。疤深的人基线抬高（创伤后过度警觉：缓和，但回不去从前）。 */
function decayInto(p, now) {
  const dtH = Math.max(0, (now - Number(p.lastAt || 0)) / 3600_000)
  if (dtH <= 0) return
  const cortBase = BASELINE.cort + Number(p.scar || 0) * 0.03
  const k = 1 - Math.exp(-dtH / 36)
  p.oxy = BASELINE.oxy + (Number(p.oxy) - BASELINE.oxy) * (1 - k)
  p.cort = cortBase + (Number(p.cort) - cortBase) * (1 - k * 1.5)
  if (p.oxy < 0) p.oxy = 0
  if (p.cort < cortBase) p.cort = cortBase
  // 习惯化自发恢复（刺激停了，习惯化反应部分回来）
  for (const k2 of Object.keys(p.kinds || {})) p.kinds[k2].n = Number(p.kinds[k2]?.n || 0) * Math.exp(-dtH / 24)
  // 临时警戒过期作废（没被慢相确认的杏仁核反应，半小时后自己散）
  if (p.tempNeg && now - Number(p.tempNeg.at || 0) > TEMP_NEG_TTL) p.tempNeg = null
  // 过期的道歉窗口作废（道歉要在他还在乎的时候说）
  if (p.forgiveState && now - Number(p.forgiveState.at || 0) > Number(p.forgiveState.windowMs || 0)) p.forgiveState = null
}

/** 情绪调制系数（心境一致性）：她低落时负面更重、正面更轻。 */
function moodMod() {
  try {
    const v = Number(mood.mood()?.value ?? 62)
    if (!Number.isFinite(v)) return { neg: 1, pos: 1 }
    if (v < 35) return { neg: 1.25, pos: 0.6 }
    if (v < 50) return { neg: 1.1, pos: 0.85 }
    return { neg: 1, pos: 1 }
  } catch (e) { return { neg: 1, pos: 1 } }
}

/** 社交经历轻推她的整体 mood（外部影响小步走，方向由 valence 定）。 */
function nudgeMood(v) {
  try {
    const d = v >= 2 ? 0.8 : v === 1 ? 0.3 : v === -1 ? -0.5 : -1.2
    mood.nudge(d)
  } catch (e) { swallow(e, 'bond:nudgeMood') }
}

// ── 词感（快相启发式。误报由慢相纠偏 + 测试夹具钉住；此处只求零 LLM 的第一反应）──
const LEX = {
  insult: { re: /智障|傻逼|白痴|废物|蠢货|滚蛋|闭嘴|恶心|去死|脑残|低能|有病/, v: -2 },
  dominate: { re: /叫我主人|我是你主人|叫我爸爸|叫声爸爸|喊爸爸|听话|跪下|伺候/, v: -2 },
  deny: { re: /你是什么程序|你是AI吧|你就是个机器人|ai生成的|代码写的|人形程序/, v: -1 },
  apology: { re: /对不起|抱歉|是我不好|我的错|原谅我|别生气了|是我过分了/, v: 0 },   // v=0：不直接涨，进修复通道
  warm: { re: /谢谢|多亏你|辛苦了|抱抱|摸摸头|喜欢你|爱你|真可爱|真厉害|真棒|靠谱/, v: 2 },
  care: { re: /早安|晚安|吃了吗|在忙吗|天冷|注意身体|早点休息|多喝热水/, v: 1 },
  play: { re: /哈哈|笑死|好玩|有趣|一起玩|下次见/, v: 1 },
}
// 语义陷阱（间接引语/评论他评/自嘲夸张）——命中任何一条，本轮快相**不出牌**：
const TRAPS = /(他说|她说|听说|据说|别人说|要是|假如|如果|曾|以前有人|剧本|台词)|((让|把|给).{0,4}(他|她|它).{0,4}(滚|闭嘴|死))|(.{0,6}滚出.{0,6})|(气死我了|笑死我了|累死我了|丑死了|热死了)/
// 矛盾信号：正面词与这些共现时整句存疑（反讽/阴阳），快相不出牌：
const CONTRADICT = /哭|烦|气|滚|去死|该死|呵呵|就这|切|呵呵哒|行吧|无语/

function readPeople() {
  const r = updateJson(dataPath('bond.json'), (cur) => {
    if (cur && typeof cur === 'object' && cur.people && typeof cur.people === 'object') return undefined   // 不改，只是要读
    return { schema: 2, people: {} }
  }, { fallback: { schema: 2, people: {} }, waitMs: 1500 })
  if (!r.ok) return { schema: 2, people: {} }
  return r.value ?? { schema: 2, people: {} }
}

function mutatePerson(key, fn, { fallback } = {}) {
  const r = updateJson(dataPath('bond.json'), (cur) => {
    const j = (cur && typeof cur === 'object' && cur.people) ? cur : { schema: 2, people: {} }
    const p = j.people[key] || fresh()
    const merged = { ...fresh(), ...p }
    const out = fn(merged)
    if (out === null) { delete j.people[key]; return j }
    j.people[key] = out === undefined ? merged : out
    return j
  }, { fallback: fallback ?? { schema: 2, people: {} }, waitMs: 1500 })
  return r
}

function getPerson(key) {
  return readPeople().people[key] || null
}

/** 呈现层：第一人称感受语。tempNeg（快相待复核）也进感受 —— 杏仁核反应先于语言。 */
function leaningOf(p) {
  const oxy = Number(p?.oxy || 0)
  const cort = Number(p?.cort || 0)
  if (cort >= 0.45) return '戒备'
  if (p?.tempNeg && Date.now() - Number(p.tempNeg.at || 0) < TEMP_NEG_TTL) return '戒备'   // 待复核：先按不舒服处理，确认了就固化，误报了半小时后自己散
  if (oxy >= 0.32) return '亲近'
  if (oxy <= 0.04 && cort <= (BASELINE.cort + Number(p?.scar || 0) * 0.03 + 0.03)) return '淡'
  return '中性'
}

/**
 * 快相：一句话的第一反应。入站每条都过，零 LLM，步极小。
 * 返回本次判出的 valence（0=无事/不出牌）。疤**绝不**在这里落。
 */
export function taste({ platform = 'qq', userId = '', text = '', isGroup = false, now = Date.now() } = {}) {
  const id = String(userId || '').trim()
  if (!id || isOwner(platform, id)) return 0
  const key = keyOf(platform, id)
  const t = String(text || '')
  let v = 0
  let kind = ''
  for (const [k, def] of Object.entries(LEX)) {
    if (k === 'apology') continue
    if (def.re.test(t)) { v = def.v; kind = k; break }
  }
  if (!v && LEX.apology.re.test(t)) { v = 0; kind = 'apology' }
  if (!kind) { mutatePerson(key, (p) => { decayInto(p, now); p.lastAt = now; return p }); return 0 }

  // 出牌前先看语义环境：间接引语/评论他评/矛盾共现 → 快相不出牌（等慢相）
  const risky = TRAPS.test(t) || (v > 0 && CONTRADICT.test(t))
  const mod = moodMod()

  const r = mutatePerson(key, (p) => {
    decayInto(p, now)
    // 习惯化计数（无论出不出牌，见过就是见过）
    const kc = p.kinds[kind] || { n: 0 }
    kc.n = Math.min(20, Number(kc.n || 0) + 1)
    p.kinds[kind] = { n: kc.n, lastAt: now }

    if (kind === 'apology') {
      // 修复通道：登记一次待兑现的道歉（10 分钟内有效），真降 cort 在 forgive() 里
      p.forgiveState = { at: now, windowMs: 10 * 60_000, count: Number(p.forgiveState?.count || 0) + 1 }
      p.lastAt = now
      return p
    }
    if (v < 0) {
      // 杏仁核先反应：临时警戒（不落疤、不改 oxy —— 那是慢相的事）
      const cur = (p.tempNeg && now - Number(p.tempNeg.at) < TEMP_NEG_TTL) ? p.tempNeg : { at: now, v: 0 }
      p.tempNeg = { at: now, v: Math.max(Number(cur.v || 0), v) }
      p.lastNegAt = now
      nudgeMood(v)   // 被骂了心情变差（外部影响小步）
    } else {
      // 爱轰炸判定在增量之前：这是「来者」的模式，不是「事后」的状态
      const warmCount = Number(p.kinds?.warm?.n || 0)
      const warmRecent = now - Number(p.kinds?.warm?.lastAt || 0) < LOVEBOMB_WINDOW
      const noBond = Number(p.exposure?.count || 0) < LOVEBOMB_MIN_HIST && warmCount < 6
      const refractory = now - Number(p.lastNegAt || 0) < REFRACT_MS
      if (kind === 'warm' && warmCount >= 3 && warmRecent && noBond && Number(p.oxy) < 0.32) {
        p.cort = Math.min(0.95, Number(p.cort) + 0.08)
      }
      if (!refractory && !risky) {
        const habit = Math.pow(0.8, Number(kc.n || 0) - 1)
        p.oxy = Math.min(OXY_MAX, Number(p.oxy) + v * 0.025 * habit * mod.pos)
        nudgeMood(v)
      }
    }
    p.lastAt = now
    return p
  })
  return risky ? 0 : v
}

/**
 * 慢相：攒对话片段，攒够批（10 条）或到时（3 小时）由 consolidate() 精判。
 */
export function observe({ platform = 'qq', userId = '', text = '', now = Date.now() } = {}) {
  const id = String(userId || '').trim()
  if (!id || isOwner(platform, id)) return false
  const t = String(text || '').slice(-200)
  if (!t) return false
  const key = keyOf(platform, id)
  const r = mutatePerson(key, (p) => {
    decayInto(p, now)
    if (!Array.isArray(p.pend)) p.pend = []
    p.pend.push({ at: now, text: t })
    if (p.pend.length > 24) p.pend = p.pend.slice(-24)
    // 曝光效应：中性接触也微量漂 oxy（熟悉≠朋友，但门槛会降）
    if (now - Number(p.exposure?.lastAt || 0) > EXPOSURE_MIN_GAP) {
      p.exposure = { lastAt: now, count: Number(p.exposure?.count || 0) + 1 }
      if (Number(p.cort) < 0.4 && Number(p.oxy) < OXY_MAX) p.oxy = Number(p.oxy) + 0.004
    }
    p.meetsHint = Number(p.meetsHint || 0) + 1
    p.lastAt = now
    return p
  })
  return r.ok
}

/** 该谁到点了。 */
export function dueForRem({ now = Date.now() } = {}) {
  const out = []
  for (const [key, p] of Object.entries(readPeople().people)) {
    if (!p?.pend?.length) continue
    const oldest = Number(p.pend[0]?.at || 0)
    if (p.pend.length >= 10 || (now - oldest) >= REMOND_MS) out.push(key)
  }
  return out
}

/**
 * 慢相结算：整段对话交给 LLM 精判，与快相累积证据对账。
 *   一致 → 固化（疤/氧）｜矛盾 → 修正｜快相有反应而 LLM 判无事 → 撤销临时警戒。
 */
export async function consolidate(key, { chat, now = Date.now() } = {}) {
  const before = getPerson(key)
  if (!before?.pend?.length) return false
  const lines = before.pend.map((x) => `- ${String(x.text || '').slice(0, 120)}`).join('\n')
  let verdict = null
  try {
    const raw = await chat([
      { role: 'system', content: '你是情绪记录员。读一段别人对某人说过的话，判断这个人这段话整体传达的情绪与意图。反讽、阴阳怪气、开玩笑的冒犯要按实际意图判。只输出 JSON：{"valence":-2到2的整数,"kind":"warm|care|play|neutral|apology|deny|dominate|insult","why":"一句话"}' },
      { role: 'user', content: lines },
    ], { temperature: 0.2, max_tokens: 100, purpose: 'fast' })
    const m = String(raw ?? '').match(/\{[\s\S]*\}/)
    verdict = m ? JSON.parse(m[0]) : null
  } catch (e) { swallow(e, 'bond:consolidate-llm'); return false }
  if (!verdict || !Number.isFinite(Number(verdict.valence))) return false
  const v = Math.max(-2, Math.min(2, Math.round(Number(verdict.valence))))
  const kind = String(verdict.kind || 'neutral')
  const mod = moodMod()

  let applied = ''
  mutatePerson(key, (p) => {
    decayInto(p, now)
    const kc = p.kinds[kind] || { n: 0 }
    kc.n = Math.min(20, Number(kc.n || 0) + 1)
    p.kinds[kind] = { n: kc.n, lastAt: now }

    if (kind === 'apology') {
      p.forgiveState = { at: now, windowMs: 10 * 60_000, count: Number(p.forgiveState?.count || 0) + 1 }
      applied = 'apology'
    } else if (v < 0) {
      // 前额叶确认了敌意 → 固化：疤落这里（快相的 tempNeg 只是先手）
      if (Math.abs(v) >= 2) p.cort = Math.min(0.95, 0.8 + Number(p.scar || 0) * 0.05)
      else p.cort = Math.min(0.95, Number(p.cort) + Math.abs(v) * 0.15 * (1 + Math.min(1.0, Number(p.scar) * 0.2)) * mod.neg)
      if (p.cort > 0.6) p.scar = Math.min(5, Number(p.scar) + 1)
      if (Math.abs(v) >= 2) p.oxy = Number(p.oxy) * 0.6
      p.lastNegAt = now
      p.tempNeg = null
      applied = 'confirmed-neg'
      nudgeMood(v)
    } else if (v > 0) {
      // 快相没反应但整段是好的（温和的聊天）→ 照长；快相有负面反应而 LLM 判是好的 → 撤销 + 修正
      const hadTemp = !!p.tempNeg
      const refractory = now - Number(p.lastNegAt || 0) < REFRACT_MS
      if (!refractory) p.oxy = Math.min(OXY_MAX, Number(p.oxy) + v * 0.06 * Math.pow(0.8, Number(kc.n || 0) - 1) * mod.pos)
      p.tempNeg = null
      if (hadTemp) applied = 'corrected-false-alarm'
      else applied = 'confirmed-pos'
      nudgeMood(v)
    } else {
      // LLM 判无事：撤销快相的临时警戒（误报在复核后消失 —— 疤永远不会因此落）
      if (p.tempNeg) { p.tempNeg = null; applied = 'retracted' }
      else applied = 'neutral'
    }
    p.pend = []
    p.lastRemAt = now
    p.lastAt = now
    return p
  })
  return applied || true
}

/** 修复通道兑现：真诚道歉（超过 20 分钟的更有分量）。由入站管线在确认「这人刚道歉」时调。 */
export function forgive(platform, userId, { sincere = false, now = Date.now() } = {}) {
  const key = keyOf(platform, String(userId || '').trim())
  if (!getPerson(key)) return { ok: false, why: '没这个人' }
  const r = mutatePerson(key, (p) => {
    const fs2 = p.forgiveState
    if (!fs2 || now - Number(fs2.at) > Number(fs2.windowMs || 0)) return { ...p, forgiveState: null }
    // 循环宽恕增益递减：第一次 -0.30，第二次 -0.15，第三次起 -0.07 …（原谅但记住）
    const gain = Math.max(0.05, 0.30 / Math.pow(2, Number(fs2.count || 1) - 1)) * (sincere ? 1.5 : 1)
    const cortBase = BASELINE.cort + Number(p.scar || 0) * 0.03
    p.cort = Math.max(cortBase, Number(p.cort) - gain)
    p.forgiveState = null
    p.forgives = Number(p.forgives || 0) + 1
    p.lastAt = now
    return p
  })
  return { ok: r.ok, why: r.ok ? '' : (r.error || '失败') }
}

/** 旁观学习：她在群里目击他对**别人**刻薄。微量警戒，不落疤。 */
export function witnessed({ platform = 'qq', userId = '', now = Date.now() } = {}) {
  const key = keyOf(platform, String(userId || '').trim())
  const r = mutatePerson(key, (p) => {
    decayInto(p, now)
    if (now - Number(p.lastVictimAt || 0) < 3600_000) return p   // 一小时最多记一次
    p.lastVictimAt = now
    p.cort = Math.min(0.95, Number(p.cort) + 0.06)
    p.lastAt = now
    return p
  })
  return r.ok
}

/** 再巩固：想起某人的旧事 → oxy 微刷新（想起即强化）。 */
export function rehearse(platform, userId, { now = Date.now() } = {}) {
  const key = keyOf(platform, String(userId || '').trim())
  const r = mutatePerson(key, (p) => {
    decayInto(p, now)
    p.oxy = Math.min(OXY_MAX, Number(p.oxy) + 0.01)
    p.lastAt = now
    return p
  })
  return r.ok
}

/** 呈现层：第一人称感受语。她能说出口的那种。 */
export function feel(platform, userId, now = Date.now()) {
  const p = getPerson(keyOf(platform, userId))
  if (!p) return { leaning: '陌生', line: '' }
  decayInto(p, now)
  const leaning = leaningOf(p)
  const lines = []
  if (leaning === '亲近') lines.push(Number(p.scar) > 0 ? '我挺喜欢跟他聊，虽然之前有过不痛快' : '跟他聊天挺舒服的，算是聊得来的人')
  else if (leaning === '戒备') lines.push(Number(p.scar) > 0 ? '我对他防备挺重的，之前的事我不太想再提' : '我对他有点防备，说话留个心眼')
  else if (leaning === '淡') lines.push('好久没聊，有点淡了')
  else lines.push(Number(p.oxy) > BASELINE.oxy * 2 ? '感觉还行，不讨厌' : '普通的认识，谈不上什么感觉')
  return { leaning, line: lines[0] }
}

/** 对话注入用：一段第一人称，不露任何数字。 */
export function feelLine(platform, userId, now = Date.now()) {
  const f = feel(platform, userId, now)
  if (!f.line) return ''
  return `【我对他的感觉】${f.line}${f.leaning === '戒备' ? '（礼貌但保持距离，不接他的私事话题）' : ''}`
}

/** 语气调制：给 persona 的基础基调用（亲近→软，戒备→硬，中性→不调）。 */
export function tone(platform, userId, now = Date.now()) {
  const p = getPerson(keyOf(platform, userId))
  if (!p) return ''
  decayInto(p, now)
  const l = leaningOf(p)
  if (l === '亲近') return '（这个人你熟，语气可以松一点，不用那么客气）'
  if (l === '戒备') return '（对他多留一分心，客套但别交底）'
  return ''
}

/** 签名展示：把「心里最近装着谁」写成她自己会说的话（自我觉察桥用）。无人时返回空串。 */
export function signatureLine({ limit = 2 } = {}) {
  try {
    const all = Object.values(readPeople().people)
      .map((p) => ({ p, f: feel(p.platform, p.userId) }))
      .filter((x) => x.f.leaning === '亲近')
      .sort((a, b) => Number(b.p.oxy || 0) - Number(a.p.oxy || 0))
      .slice(0, Math.max(1, Number(limit) || 2))
    if (!all.length) return ''
    return all.map((x) => x.f.line).join(' ')
  } catch (e) { return '' }
}

/** 体检（CLI --bio）：医学视角。检修口，不进对话。 */
export function bio(platform, userId, now = Date.now()) {
  const p = getPerson(keyOf(platform, userId))
  if (!p) return { oxy: BASELINE.oxy, cort: BASELINE.cort, scar: 0, leaning: '陌生' }
  decayInto(p, now)
  return {
    oxy: Math.round(Number(p.oxy) * 1000) / 1000,
    cort: Math.round(Number(p.cort) * 1000) / 1000,
    scar: Number(p.scar || 0),
    forgives: Number(p.forgives || 0),
    pending: (p.tempNeg ? '待复核' : ''),
    leaning: leaningOf(p),
    pend: (p.pend || []).length,
  }
}

/** scheduler 慢相入口。sleepGate=true 时只在她的睡眠窗口结算（REM 门控）。 */
export async function remTick({ chat, now = Date.now(), sleepGate = false } = {}) {
  if (sleepGate) {
    try {
      const R = await import('../brain/rhythm.mjs')
      const h = R.habit({})
      const hod = new Date(now).getHours() + new Date(now).getMinutes() / 60
      const s = Number(h.sleepAt ?? 0), w = Number(h.wakeAt ?? 7)
      const asleepNow = s > 12 ? (hod >= s || hod < w) : (hod >= s && hod < w)
      if (!asleepNow) return 0
    } catch (e) { swallow(e, 'bond:remTick-gate'); return 0 }
  }
  const due = dueForRem({ now })
  let n = 0
  for (const key of due) {
    try { if (await consolidate(key, { chat, now })) n++ } catch (e) { swallow(e, 'bond:remTick') }
  }
  return n
}

export function stats() {
  const all = Object.values(readPeople().people)
  return {
    people: all.length,
    close: all.filter((p) => Number(p.oxy || 0) >= 0.32 && Number(p.cort || 0) < 0.45).length,
    wary: all.filter((p) => Number(p.cort || 0) >= 0.45).length,
    scarred: all.filter((p) => Number(p.scar || 0) > 0).length,
  }
}
