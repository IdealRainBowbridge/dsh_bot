// brain/inner —— 内心语言：在"说"之前，先"想"一遍
//
// ══════════════════════════════════════════════════════════════════════
// 这是整套系统里最缺的一层
// ══════════════════════════════════════════════════════════════════════
// 她现在的链路是：消息进来 → 判接不接 → 生成 → 发。
// 整条链上**没有任何一个位置容得下"她自己的想法"**。
// 所以她每句话都是"针对这句话的最优回答"，不是"她想说的话"。
// 这就是为什么她读起来像客服：不是语气不好，是**中间不存在一个人**。
//
// 人说话的真实顺序是：
//   看见 → 心里浮起一个反应（可能带着情绪）→ 那个反应可能被压下去
//   → 想清楚要不要说、说到哪 → 才组织成句子说出口
//
// 所以这里必须有**两种语言**，而且它们不是同一种东西：
//
//   内心（inner）：碎片、没有礼貌、可以骂人、可以自相矛盾、不需要成句。
//                  它是给**她自己**看的，永远不外发。
//   出口（utter）：从 inner 里挑出来的、过了筛子的、能给他看的那部分。
//
// 关键约束（写在代码里，不靠提示词）：**inner 绝不进他的消息流。**
// 它只进两处：① 下一次生成时的"你现在心里的想法"槽 ② 没说完的话债。
//
// ══════════════════════════════════════════════════════════════════════
// 为什么"想法"要留一段时间，而不是用完就扔
// ══════════════════════════════════════════════════════════════════════
// 人不是每句话都说得出口。昨天想说没说的那句，今天会以另一种形式冒出来
// （"我昨天就想问你这个"）。如果想法用完就扔，她就永远只有"此刻"，没有"想了两天"。
//
// 所以 inner 里的想法带三个时间量：
//   at      什么时候冒出来的
//   told    说没说过（false = 还压着）
//   weight  越想越重（每次被重新想起 +1），说得出口的门槛也越高
//
// weight 会自己渗（每 6 小时 -0.15），但渗得比涨得慢 —— 所以"没说完的话"会积。
// 积到一定程度，它会变成 field 里的 tension（心里压着事），参与决策。
// 这条链是闭合的：**想 → 压着 → 变成压力 → 影响说话 → 说出来 → 压力减**。
// ══════════════════════════════════════════════════════════════════════

import { readJson, mutateJson, readJsonl, appendJsonl, shortHash } from './json.mjs'
import { innerPath, innerStreamPath } from './paths.mjs'
import * as field from './field.mjs'
import { swallow } from '../lib/swallow.mjs'

const HOUR = 3_600_000
const MAX_KEEP = 60            // 常驻的活跃想法上限
const SEED_HOURS = 6           // 想法每 6 小时自然变淡一次

const empty = () => ({ items: [], updatedAt: 0 })

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.items = Array.isArray(st.items) ? st.items.filter((x) => x && x.id && x.text) : []
  return st
}

/* ── 淡出：想法会自己变淡，但比"想"慢 ─────────────────────────────── */

/**
 * 让想法随时间变淡。
 *
 * 形状很重要：**不是线性衰减，指数**。刚冒出来的念头最鲜活，越久越模糊。
 * 但衰减常数故意设得很长（6 小时），因为"没说完的话"恰恰是最不容易散的 ——
 * 散得太快，她就没有"惦记"这个能力了。
 */
export function fade(now = Date.now()) {
  const st = hydrate(readJson(innerPath(), null))
  const since = Number(st.updatedAt || now)
  const dt = Math.max(0, now - since)
  if (dt < 10 * 60_000) return st       // 十分钟内不动（省 IO，也避免高频抖动）
  const rounds = dt / (SEED_HOURS * HOUR)
  for (const it of st.items) {
    if (it.told) it.weight = Math.max(0, Number(it.weight || 1) * Math.exp(-rounds * 0.75))
    else it.weight = Math.max(0.2, Number(it.weight || 1) * Math.exp(-rounds * 0.28))  // 没说的渗得慢
  }
  st.items = st.items.filter((it) => !(it.told && it.weight < 0.15))
  st.updatedAt = now
  return st
}

/* ── 冒出一个想法 ─────────────────────────────────────────────────── */

/**
 * 记一个念头。
 *
 * @param {string} text 想法本身（允许碎片、允许不礼貌）
 * @param {object} o { kind, about, now }
 *   kind:
 *     urge   —— 想说的话（没说出来就压着）
 *     worry  —— 放不下的（答应过、怕忘了、担心他）
 *     notice —— 注意到的（他今天语气不对、天气、看到的东西）
 *     meta   —— 对自己的（我今天好像有点躁）
 */
export function think(text, o = {}) {
  const t = String(text || '').trim()
  if (!t) return null
  const now = o.now ?? Date.now()
  const st = fade(now)
  const id = 'th-' + shortHash(t + '|' + now, 8)
  // 同义重复：只加权重，不新增（人不会把同一件事记十遍，但会越想越重）
  const dup = st.items.find((x) => !x.told && similar(x.text, t))
  if (dup) {
    dup.weight = Math.min(6, Number(dup.weight || 1) + 0.8)
    dup.at = now
    st.updatedAt = now
    return persist(st)
  }
  st.items = [...st.items, {
    id, at: now, text: t.slice(0, 240),
    kind: String(o.kind || 'urge'),
    about: String(o.about || '').slice(0, 40),
    weight: 1, told: false, toldAt: 0,
  }].slice(-MAX_KEEP)
  st.updatedAt = now
  return persist(st)
}

/** 粗糙的"同一件事"判断：前 12 字有一半字重叠就算。够用，不追求精确。 */
function similar(a, b) {
  const x = String(a || '').slice(0, 12), y = String(b || '').slice(0, 12)
  if (!x || !y) return false
  let hit = 0
  for (const ch of new Set(x)) if (y.includes(ch)) hit++
  return hit / Math.max(1, new Set(x).size) > 0.5
}

/** 某个想法被说出来了。 */
export function told(id, now = Date.now()) {
  const st = fade(now)
  const it = st.items.find((x) => x.id === id)
  if (!it) return st
  it.told = true
  it.toldAt = now
  st.updatedAt = now
  // 说出来 = 卸掉一点压力（这是负反馈的另一半：poke 的是 +，这里是 -）
  try { field.poke('tension', -0.35, { why: 'inner:told', now }) } catch (e) { swallow(e, 'inner:told') }
  return persist(st)
}

/**
 * 挑出此刻"心里最响的那件"。
 *
 * 排序不是按权重，是按 **权重 × 新鲜度 × 是不是关于他**。
 * 因为人心里最响的那件事，往往不是最重要的事，是**刚刚发生又跟他有关**的事。
 */
export function loudest(n = 2, now = Date.now()) {
  const st = fade(now)
  const scored = st.items
    .filter((x) => !x.told || Number(x.weight || 0) > 1.2)
    .map((x) => {
      const ageH = Math.max(0, (now - Number(x.at || now)) / HOUR)
      const fresh = Math.exp(-ageH / 18)
      const aboutHim = (/他|你|老爸|老爹|爸爸/.test(x.text) || x.about === 'owner') ? 1.5 : 1
      const kindW = ({ urge: 1.35, worry: 1.2, notice: 0.9, meta: 0.8 })[x.kind] ?? 1
      return { it: x, score: Number(x.weight || 1) * fresh * aboutHim * kindW }
    })
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(0, n)).map((x) => ({ ...x.it, score: Number(x.score.toFixed(3)) }))
}

/**
 * 注入提示词的那一段 ——【你现在心里正想着的】
 *
 * 故意写成"碎片 + 不定句"，因为她看到的时候不该像一张任务单。
 * 而且必须附一句"这些不是要说的，是你心里在转的"——
 * 否则模型会把它们全部输出成消息（这是必须防的退化）。
 */
export function innerBlock(n = 2, now = Date.now()) {
  const top = loudest(n, now)
  if (!top.length) return ''
  const lines = top.map((x) => {
    const ageH = (now - Number(x.at || now)) / HOUR
    const when = ageH < 1 ? '刚刚' : ageH < 6 ? '今天早些时候' : ageH < 30 ? '昨天前后' : '好几天了'
    const stuck = (!x.told && ageH > 20) ? '（一直没说出来）' : ''
    return '- ' + x.text + stuck + '（' + when + '）'
  })
  return '【你心里正转着的】\n' + lines.join('\n') + '\n\n' +
    '上面这些是你自己的想法，**不是要发出去的内容**。别照着复述，也别一条条清空 —— ' +
    '你现在能想到什么就说什么，想不到就只说眼前这句。'
}

/* ── 没说完的话 → 变成压力 ───────────────────────────────────────── */

/**
 * 把积压的"想说没说"折成 field 的 tension。
 *
 * 这一条是**闭合回路**的关键：没有它，想法只是个列表；
 * 有了它，"她惦记着这件事"才会真的改变她的状态、进而改变她说话的样子。
 */
export function settle(now = Date.now()) {
  const st = fade(now)
  const pending = st.items.filter((x) => !x.told)
  const load = pending.reduce((n, x) => n + Math.max(0, Number(x.weight || 0) - 0.8), 0)
  if (load > 0.4) {
    // 只推 tension，不直接改 valence —— 压力是"心里有事"，不是"心情差"。差别很重要。
    try { field.poke('tension', Math.min(2.5, load * 0.12), { why: 'inner:pending', now }) } catch (e) { swallow(e, 'inner:settle') }
  }
  return { pending: pending.length, load: Number(load.toFixed(2)) }
}

/* ── 原话流：她的一切，一个字不删 ─────────────────────────────────── */

/**
 * 所有想过/说过的话，原文落盘。
 *
 * **这是"摘要不许吃证据"那条约束的落地。**
 * 上层照旧可以做摘要、可以做索引、可以打标签 —— 但原文永远在 stream 里，
 * 任何一次"她当时到底怎么说的"都能追回去。摘要只是检索线索，不是内容。
 *
 * @param {{role:'self'|'owner'|'other'|'world', kind:string, text:string, meta?:object}} rec
 */
export function stream(rec, now = Date.now()) {
  const row = {
    at: now,
    iso: new Date(now).toISOString(),
    role: rec.role || 'self',
    kind: rec.kind || 'say',
    text: String(rec.text || ''),          // ← 原文，不裁、不摘要、不改写
    ...(rec.meta ? { meta: rec.meta } : {}),
  }
  try { appendJsonl(innerStreamPath(), row) } catch { /* 流写不进去不能挡业务 */ }
  return row
}

/** 读原话流（调试/回溯/巩固用）。 */
export function readStream({ from = 0, limit = 200 } = {}) {
  try {
    const rows = readJsonl(innerStreamPath())
    const cut = rows.filter((r) => Number(r.at || 0) >= Number(from || 0))
    return limit ? cut.slice(-limit) : cut
  } catch { return [] }
}

/* ── 持久化 ───────────────────────────────────────────────────────── */

function persist(st) {
  try {
    mutateJson(innerPath(), empty(), () => ({ items: st.items, updatedAt: st.updatedAt }))
  } catch (e) { swallow(e, 'inner:persist') }
  return st
}

/** 全貌。 */
export function snapshot(now = Date.now()) {
  const st = fade(now)
  const pending = st.items.filter((x) => !x.told)
  return {
    total: st.items.length,
    pending: pending.length,
    loudest: loudest(3, now).map((x) => ({ text: x.text.slice(0, 40), kind: x.kind, weight: Number(x.weight.toFixed(2)), told: x.told })),
  }
}
