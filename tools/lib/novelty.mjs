// tools/lib/novelty.mjs —— 新颖检测（2026-11-02 晚）
//
// 为什么要有这个器官
// ═══════════════════
// 以前"探索"的因果方向是反的：wander 每 4 小时掷一次骰子，dailyMax 像保险丝。
// 心跳每 30 秒跳，但没有任何东西在"感受"新东西 —— planner 醒来时只能在
// 五项固定菜单里抽签，抽完就做，做完不留先验。探索没有源头，只有排期。
//
// 这个文件补的是缺的那层：**对不确定性的感受器**。
//   情节流（episodes）里不断进来新事件 → 每条和"我见过的词"（兴趣池 2-gram +
//   见过池 gram→时间戳）比一下 → 命中越少 = 越陌生 = 越新奇。
//   新奇攒成 arousal（0~1），三处消费：
//     ① 心跳拍上：arousal 越过门槛 → 刺激 explore 通路（她是真的坐不住）
//     ② wander 门：间隔随 arousal 收缩，dailyMax 只做护栏
//     ③ mind.plan：把"挠着你的新鲜事"摊进上下文，让她自己顺着去
// 经历会改变先验：经历过/探索过的东西沉淀进见过池 → 下次同主题变熟 → 饱和衰减。
// "腻了"不是配额，是脱敏 —— 和受体三池的恢复是同构的。
//
// 边界：这里**只产生信号**，不产生行为 —— 行为仍由 mind/wander/宿主半边决定。
// 依赖全是 lib 自己的（memory/paths/atomic/swallow），不碰 brain。

import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { tokens, interestGrams, episodeFile } from './memory.mjs'
import { writeJsonAtomic } from './atomic.mjs'
import { swallow } from './swallow.mjs'

const STATE_PATH = () => dataPath('novelty.json')

// ── 口径（全部集中在这一处，调参不改逻辑）─────────────────────
const WINDOW_MS = 6 * 3600_000     // 只看最近 6 小时的情节：好奇是当下的
const MAX_SCAN = 400               // 每个情节文件最多回看多少行（防大文件拖拍）
const MAX_SEEN = 2000              // gram 池上限（防无界，到顶按时间淘汰最旧的）
const SEEN_TTL_MS = 14 * 86400_000 // 见过 14 天就算"又新了"（记忆会淡，好奇会回来）
const AROUSAL_TRIGGER = 0.6        // 心跳刺激 explore 通路的门槛（body.mjs 读）

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

// ── 纯函数（测试直接打这里）─────────────────────────────────

/** 一段文本的陌生度 0~1：2-gram 命中兴趣池/见过池越少越陌生。
 *  没有可判断的词（空白/纯符号）不算新奇 —— 不确定 ≠ 乱码。 */
export function unfamiliarity(text, knownGrams, seenMap = {}, now = Date.now()) {
  const gs = tokens(text).filter((g) => g.length >= 2)
  if (!gs.length) return 0
  let known = 0
  for (const g of gs) {
    if (knownGrams?.has?.(g)) known += 1
    else if (seenMap[g] && now - Number(seenMap[g]) < SEEN_TTL_MS) known += 1
  }
  return Math.max(0, Math.min(1, 1 - known / gs.length))
}

/** 同主题饱和：刚探索过同一主题，这次的好奇打折（"脱敏"）。
 *  刚做完≈0.2，2 小时后≈0.53，隔夜≈1；和上次主题不像就不衰减。 */
export function saturate(text, lastTopic, lastAt, now = Date.now()) {
  if (!lastTopic || !lastAt) return 1
  const a = new Set(tokens(String(text)))
  const b = new Set(tokens(String(lastTopic)))
  if (!b.size) return 1
  let hit = 0
  for (const g of b) if (a.has(g)) hit += 1
  const sim = hit / b.size
  if (sim < 0.34) return 1
  const hours = Math.max(0, (now - Number(lastAt)) / 3600_000)
  return Math.max(0.2, 1 - 0.8 * Math.exp(-hours / 2))
}

// ── 感受器 ───────────────────────────────────────────────────

/** 窗口内的情节行（主/QQ/微信三处，只读不写）。路径走 memory.episodeFile，
 *  不手搓路径 —— promises.json 那次的静默失效就是手搓结构惹的。 */
function rowsOf(now) {
  const out = []
  for (const plat of ['', 'qq', 'wechat']) {
    let lines = []
    try {
      lines = fs.readFileSync(episodeFile(plat), 'utf8').trim().split('\n').filter(Boolean).slice(-MAX_SCAN)
    } catch (e) { swallow(e, 'novelty:rows:' + (plat || 'main')) } // 文件不存在 = 还没经历，正常
    for (const l of lines) {
      let j
      try { j = JSON.parse(l) } catch (e) { swallow(e, 'novelty:row'); continue }
      const ts = Number(j.ts || 0)
      if (!ts || now - ts > WINDOW_MS) continue
      const text = String(j.summary || j.text || '').slice(0, 160)
      if (text) out.push({ ts, text })
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** 扫一遍最近 6 小时的情节流，算当前 arousal（0~1）。
 *  只读文件 + 读状态，不写盘；每 5 分钟被心跳调一次，必须便宜。 */
export function assess(now = Date.now()) {
  const st = readJson(STATE_PATH(), {})
  const seen = st.seen && typeof st.seen === 'object' ? st.seen : {}
  let grams
  try { grams = interestGrams(48) } catch (e) { swallow(e, 'novelty:grams'); grams = new Set() }

  const rows = rowsOf(now)
  const scored = []
  for (const r of rows) {
    const u = unfamiliarity(r.text, grams, seen, now) * saturate(r.text, st.lastTopic, st.lastAt, now)
    if (u > 0) scored.push({ ...r, u })
  }
  scored.sort((a, b) => b.u - a.u)
  const top = scored.slice(0, 3)
  const arousal = top.length ? top.reduce((s, x) => s + x.u, 0) / top.length : 0

  // items 是给消费方看的"挠着你的新鲜事"；窗口里没有陌生事时，
  // 把最近的经历兜底摆出来（planner 依旧有得看，只是没有"新奇"标签）
  const items = (scored.length ? scored : rows.slice(-3).map((r) => ({ ...r, u: 0 })))
    .slice(0, 5)
    .map((r) => ({ text: r.text, u: Number(r.u.toFixed(3)), ts: r.ts }))

  return { arousal: Number(arousal.toFixed(3)), items, rows: rows.length, trigger: AROUSAL_TRIGGER }
}

/** 见过一条（探索完/计划完就记），同主题下次就熟了。
 *  source/surprise 会记成 lastTopic —— 饱和衰减只在"刚探索过同一主题"时生效。 */
export function spark(text, { source = '', surprise = 0 } = {}, now = Date.now()) {
  const st = readJson(STATE_PATH(), {})
  if (!st.seen || typeof st.seen !== 'object') st.seen = {}
  for (const g of tokens(text)) {
    if (g.length < 2) continue
    st.seen[g] = now
  }
  pruneSeen(st)
  if (source || surprise > 0) {
    st.lastTopic = String(text).slice(0, 80)
    st.lastAt = now
    st.lastSource = String(source).slice(0, 20)
    st.lastSurprise = Math.max(0, Math.min(1, Number(surprise) || 0))
  }
  st.updatedAt = now
  try { writeJsonAtomic(STATE_PATH(), st) } catch (e) { swallow(e, 'novelty:spark') }
  return { grams: Object.keys(st.seen).length }
}

/** 心跳拍的入口：感受一遍 + 把窗口里的经历沉淀进见过池（经历变熟悉）。
 *  返回 assess 结果 —— body.mjs 拿 arousal 刺激 explore，mind 拿 items 进上下文。 */
export function tick(now = Date.now()) {
  const out = assess(now)
  try {
    const st = readJson(STATE_PATH(), {})
    if (!st.seen || typeof st.seen !== 'object') st.seen = {}
    let dirty = false
    for (const r of rowsOf(now)) {
      for (const g of tokens(r.text)) {
        if (g.length < 2) continue
        if (!st.seen[g] || now - Number(st.seen[g]) > SEEN_TTL_MS) { st.seen[g] = now; dirty = true }
      }
    }
    if (dirty) {
      pruneSeen(st)
      st.updatedAt = now
      try { writeJsonAtomic(STATE_PATH(), st) } catch (e) { swallow(e, 'novelty:tick') }
    }
  } catch (e) { swallow(e, 'novelty:tick:outer') }
  return out
}

/** gram 池到顶：按时间淘汰最旧的（记忆也会淡）。 */
function pruneSeen(st) {
  const keys = Object.keys(st.seen)
  if (keys.length <= MAX_SEEN) return
  keys.sort((a, b) => Number(st.seen[a]) - Number(st.seen[b]))
  for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete st.seen[k]
}
