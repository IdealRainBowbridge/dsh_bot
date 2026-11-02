// brain/anchor —— 锚：从她自己说过的话里挑 4 句，原样冻结进 system
//
// ══════════════════════════════════════════════════════════════════════
// 它要解决的问题：越聊越像在演设定
// ══════════════════════════════════════════════════════════════════════
// 现象：聊得越久，她的语气越"用力"，越像在念人设。
// 原因不是 persona 写得不好，恰恰相反 —— 是因为**每一轮都在读 persona**。
//
// persona 是"她应该是谁"（应然）。而每一轮读一遍应然，模型就会越来越
// 朝着那个应然演，最后变成"正在扮演大肥鱼"而不是"大肥鱼在说话"。
//
// 解法（用户 2026-11-02 定的）：从**她自己真说过的话**里挑 4 句原样放回 system，
// **冻结不变**。这不是"教她怎么说"，这是"让她想起自己说话是什么样"。
//
// 区别很微妙但很关键：
//   人设   = 规定（"你说话要俏皮"）→ 会越读越假
//   锚     = 证据（"你上周二说过：'你懂什么，这叫怀旧'"）→ 会越读越真
//
// ══════════════════════════════════════════════════════════════════════
// 为什么必须"冻结"
// ══════════════════════════════════════════════════════════════════════
// 如果每轮都重新挑 4 句，会出现两件坏事：
//   ① system 区每轮都在变 → 前后不一致 → 她说话的口吻跟着飘
//   ② 模型会盯着"最新那 4 句"调整 → 等于用最近的话污染人格（recency bias）
//
// 所以锚**只在"她变了"的时候换**，不是每轮换。换的判据是：
//   · 过期（超过 anchor.maxAgeDays 天）
//   · 她在近期说的话里出现了**明显不同于锚**的口吻（说明她真的变了，该重新采样）
// 平时就是那 4 句，一动不动。
//
// ══════════════════════════════════════════════════════════════════════
// 怎么挑（不是随机）
// ══════════════════════════════════════════════════════════════════════
// 挑的原则：**能听出"这是她"的句子**。四个判据：
//   ① 有她自己的用词/口癖（"笨蛋老爸"、"你懂什么"这类）
//   ② 不是在回答别人的问题（回答问题的话长得像客服）
//   ③ 长度 8~60 字（太短没信息量，太长像作文）
//   ④ 情绪有起伏的（平淡陈述最不像她）
// 再从满足条件的里按"最近 + 分散"取 4 句 —— 分散是为了不全是同一天说的。

import { readJson, mutateJson, readJsonl } from './json.mjs'
import { anchorPath, innerStreamPath } from './paths.mjs'
import { swallow } from '../lib/swallow.mjs'

const DAY = 86400_000

/** 冻结参数。 */
export const RULES = {
  count: 4,              // 4 句（用户定的数）
  maxAgeDays: 21,        // 超过 3 周就重新采样
  minChars: 8,
  maxChars: 62,
  // 她自己的口癖信号：出现这些词，更像"她"
  voiceMarks: /(笨蛋|老爹|老爸|你懂什么|哼|哎呀|得了吧|谁啊|凭什么|才不|明明|怎么又|真烦|笑死|离谱|算了|随你)/,
  // 客服腔信号：出现这些，判为"像在服务"而不是"像在说话"
  serviceMarks: /(请问|您可以|需要我|帮您|为您|感谢您的|很抱歉|建议您|希望对您|还有什么可以)/,
}

const empty = () => ({
  at: 0,
  items: [],        // [{ text, at, segId, why }]
  frozenAt: 0,      // 冻结时刻：这段时间内的锚一律不动
  samples: 0,       // 采样次数（体检用：换过几次）
})

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.items = Array.isArray(st.items) ? st.items.filter((x) => x && x.text).slice(0, RULES.count) : []
  return st
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * 给一句候选打分（越高越像"她"）。
 *
 * 这套打分的每一项都对应一个"这类句子不像她"的具体理由，
 * 不是随手加的权重。改权重前先想清楚改的是哪一条理由。
 */
export function score(text, at = Date.now(), now = Date.now()) {
  const t = String(text || '').trim()
  if (t.length < RULES.minChars || t.length > RULES.maxChars) return -1
  if (RULES.serviceMarks.test(t)) return -1          // 客服腔直接淘汰
  let s = 1
  if (RULES.voiceMarks.test(t)) s += 2.2              // 有明显的她自己的词
  if (/[？?]/.test(t)) s -= 0.6                       // 反问可以，但纯问句像客服
  if (/^(嗯|哦|好|行|对|是的|在呢)[。.!！]?$/.test(t)) s -= 2   // 敷衍句没信息量
  if (/[！!]|…|～/.test(t)) s += 0.5                  // 有语气
  if (t.length >= 14) s += 0.4                        // 够长才有"说话的样子"
  // 新鲜度：越近越优先，但只是加成，不是决定因素
  const ageD = Math.max(0, (now - Number(at || now)) / DAY)
  s += 1.4 * Math.exp(-ageD / 10)
  return Number(s.toFixed(2))
}

/**
 * 重新采样锚。**只在需要时调用**（过期 / 她变了），不要每轮调。
 *
 * @param {object} o { force, now }
 * @returns {{st:object, changed:boolean, why:string}}
 */
export function sample({ force = false, now = Date.now() } = {}) {
  const st = hydrate(readJson(anchorPath(), null))
  const ageD = st.frozenAt ? (now - st.frozenAt) / DAY : 999

  if (!force && st.items.length && ageD < RULES.maxAgeDays) {
    return { st, changed: false, why: '冻结中（' + ageD.toFixed(1) + ' 天）' }
  }

  // 候选池：她自己说过的话（role=self），从原话流里取近 30 天
  let rows = []
  try {
    rows = readJsonl(innerStreamPath())
      .filter((r) => r.role === 'self' && String(r.text || '').length >= RULES.minChars)
      .filter((r) => now - Number(r.at || 0) < 30 * DAY)
  } catch (e) { swallow(e, 'anchor:sample') }

  if (!rows.length) {
    // 没有语料：保持原状（不要清空 —— 宁可留着旧的，也不要把锚变成空的）
    return { st, changed: false, why: '没有可用语料' }
  }

  const scored = rows
    // ⚠️ 2026-11-02：她自己说的话常常是多行的（换行写在同一个气泡里）。
    //    直接塞进锚块会变成"一条占四行"，整个【你自己说过的话】读起来像碎纸，
    //    而且模型会对着换行位置学断句。压成单行 + 截断更接近"一个人想起来的一句话"。
    .map((r) => {
      const one = String(r.text || '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
      return { text: one, at: Number(r.at || now), s: score(one, r.at, now) }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)

  // P2-3 (2026-11-03): usage-dependent consolidation. A line she keeps
  // re-deriving (near-duplicates of herself in the stream) is one her memory
  // replays - hippocampal replay marks it for freezing. Count near-duplicates
  // IN the candidate pool (similar()) and give repeats a capped bonus, then
  // re-sort. Repeated lines therefore outrank fresher one-off lines.
  for (const c of scored) {
    let rep = 0
    for (const d of scored) if (d !== c && similar(c.text, d.text)) rep++
    c.s = Number((c.s + Math.min(2, rep * 0.5)).toFixed(2))
  }
  scored.sort((a, b) => b.s - a.s)

  if (!scored.length) return { st, changed: false, why: '没有够格的句子' }

  // 去重（文本相近的只留一条） + 分散（同一天的不要超过 2 句）
  const picked = []
  const byDay = new Map()
  for (const c of scored) {
    if (picked.length >= RULES.count) break
    if (picked.some((p) => similar(p.text, c.text))) continue
    const day = new Date(c.at).toDateString()
    const n = byDay.get(day) || 0
    if (n >= 2) continue
    byDay.set(day, n + 1)
    picked.push({ text: c.text.slice(0, RULES.maxChars), at: c.at, why: 'score ' + c.s })
  }

  if (picked.length < 2) return { st, changed: false, why: '够格的太少（' + picked.length + '）' }

  st.items = picked
  st.frozenAt = now
  st.at = now
  st.samples = Number(st.samples || 0) + 1
  return { st: persist(st), changed: true, why: '重新采样 ' + picked.length + ' 句' }
}

/** 粗糙的相似判断（同一天说的重复话不要两个）。 */
function similar(a, b) {
  const x = String(a).slice(0, 16), y = String(b).slice(0, 16)
  if (!x || !y) return false
  let hit = 0
  for (const ch of new Set(x)) if (y.includes(ch)) hit++
  return hit / Math.max(1, new Set(x).size) > 0.6
}

/**
 * 注入 system 的那一段。
 *
 * 措辞的讲究（这一层很容易做错）：
 *   不能说"你要这样说话" —— 那是规定，会让它演。
 *   要说"你以前说过这些" —— 这是记录，会让它想起来。
 * 而且要明确"这是你自己说的话"，不是"参考样例"。
 */
export function block({ now = Date.now() } = {}) {
  const st = hydrate(readJson(anchorPath(), null))
  if (!st.items.length) return ''
  const lines = st.items
    .map((x) => '· ' + String(x.text || '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((x) => x.length > 2)
    .join('\n')
  return `【你自己说过的话】\n${lines}\n\n` +
    `上面这些是你真的说过的话，原样留着。不是让你模仿，是提醒你本来是什么语气。\n` +
    `不用刻意照它们的说法讲，也别刻意避开。`
}

/** 全貌。 */
export function snapshot(now = Date.now()) {
  const st = hydrate(readJson(anchorPath(), null))
  return {
    count: st.items.length,
    ageDays: st.frozenAt ? Number(((now - st.frozenAt) / DAY).toFixed(1)) : null,
    samples: st.samples,
    items: st.items.map((x) => ({ text: x.text, at: new Date(x.at).toISOString().slice(0, 10) })),
  }
}

function persist(st) {
  try {
    mutateJson(anchorPath(), empty(), () => ({
      at: st.at, items: st.items, frozenAt: st.frozenAt, samples: st.samples,
    }))
  } catch (e) { swallow(e, 'anchor:persist') }
  return st
}
