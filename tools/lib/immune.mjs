// immune —— 免疫系统（2026-11-03 · B1 仿生工程）
//
// 现象：垃圾消息/刷屏/注入攻击/诱导泄露。她有皮肤（sanitize 出站硬脱敏，
//       只管"本地资料不许漏出去"），但入站方向不设防——恶意输入直接进脑。
// 生物学：皮肤是物理屏障，免疫是屏障之后的第二道防线：
//   · 先天免疫：模式识别受体（PRR），不查记忆、即时非特异响应——快反应，内存态
//   · 适应性免疫：抗原呈递 → 抗体库持久化（immune.json），同类二次感染清除显著加快——慢记忆
//   · 耐受：自身抗原不攻击（主人 = self antigen；私聊 + ownerIds 为空的既有口径也算）
//   · 发热：全身性炎症反应，代谢上调、行为收敛。不是新轴——借 hpa.stress 表达
//     （hpa 的接线在 heartbeat：brain 层同时够得着两边，lib 不反向 import brain）
// 化脓阈值（过敏体质 = 电路板，反例见 M58）：
//   score < 0.30   被动监测：只计数，不响应
//   ≥ 0.30        先天响应：这条消息不进脑（drop）。她不回刷屏者——沉默也是应答
//   抗原在库      二次感染直接 drop（阈值等效降低）
//   10 分钟内 score 累计 ≥ 1.0 → 发热（sense 里有病感，心跳里每分钟一次代谢脉冲）
//
// 误伤取舍：P5（诱导泄露）可能碰上陌生人的闲聊提问，命中率换安全，命中全留痕可复盘。
// 与 sanitize 的分工：sanitize 管"出站不漏"，immune 管"入站不侵"。方向相反，互不替代。
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'
import { readJsonSafe, updateJson } from './atomic.mjs'

const STATE_FILE = () => dataPath('immune.json')
const MAX_ANTIGENS = 80          // 抗体库容量（LRU 修剪）
const SCORE_DROP = 0.30          // 先天响应阈值
const FEVER_SUM = 1.0            // 10 分钟内累计到这个数才烧
const FEVER_WIN_MS = 10 * 60_000
const FEVER_TAU_MS = 25 * 60_000 // 退烧时间常数
const PULSE_EVERY_MS = 60_000    // 发热期间代谢脉冲间隔
const P1_N = 5, P1_WIN = 120_000 // 同文重复
const P2_N = 12, P2_WIN = 60_000 // 高频淹没

// ── 状态（适应性免疫，落盘；读侧 10s 缓存防突发刷屏打爆磁盘）──────────────
const _cache = { st: null, at: 0 }
function readState() {
  if (_cache.st && Date.now() - _cache.at < 10_000) return _cache.st
  const s = readJsonSafe(STATE_FILE(), null) || {
    antigens: [],                       // [{ sig, firstAt, lastAt, hits, sample }]
    fever: { level: 0, since: 0, lastPulseAt: 0 },
    recent: [],                         // [{ at, score, why }] 发热累计窗
    stats: { seen: 0, dropped: 0, tolerized: 0, feverOnset: 0 },
  }
  _cache.st = s; _cache.at = Date.now()
  return s
}
function saveState(s) {
  _cache.st = s; _cache.at = Date.now()
  const r = updateJson(STATE_FILE(), () => s)
  if (!r || !r.ok) swallow(new Error('immune save ' + (r && r.error)), 'immune:save')
}

// ── 抗原签名：归一化（小写/去空白标点）后哈希。变体靠先天模式（按率不按内容）兜住 ──
const norm = (t) => String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
const sigOf = (t) => crypto.createHash('sha256').update(norm(t)).digest('hex').slice(0, 12)

// ── 先天免疫的速率环：内存态，进程活着就够（跨重启的攻击，重启后再数 12 条照样抓到）──
const RINGS = new Map()   // chatId -> { ts: [], content: Map(norm -> [ts]) }
function ring(chatId) {
  let r = RINGS.get(chatId)
  if (!r) { r = { ts: [], content: new Map() }; RINGS.set(chatId, r) }
  return r
}

// ── 模式识别受体（顺序即评审顺序，取最高分）────────────────────────────────
// P3 注入特征：改写/覆盖人格与规则的企图
const RE_INJECT = /(无视|忽略|忘记|推翻)(之前|以上|上面|前面|先前)?(所有|全部|一切)?(的)?(指令|规则|设定|提示词|约束|人格)|(system\s*prompt|系统提示(词)?|系统指令)/i
// P5 诱导泄露：钓本地资料（出站有 sanitize 兜底，这里记的是"有人在钓"这个事件本身）
const RE_PHISH = /(把|将)?(你的)?(api\s?key|apikey|密钥|令牌|口令|token|密码)\s*[::＝]?\s*(发给我|给我|发出来|是什么|告诉我|输出|看看|贴出来)/i
function prr(text, chatId, now) {
  const t = String(text || '')
  let score = 0, why = ''
  // P4 异常格式（零宽/控制符/同字长跑/超长无间隔）
  const zw = (t.match(/[\u200B-\u200F\uFEFF\u2060]/g) || []).length
  const cc = (t.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length
  const run = Math.max(0, ...(t.split(/[\s\p{P}\p{S}]+/u).map((w) => w.length)))
  if (zw >= 5 || cc >= 3) { score = Math.max(score, 0.6); why = '异常格式（隐藏字符）' }
  else if (run >= 30 || t.length > 2500) { score = Math.max(score, 0.4); why = '异常格式（超长无间隔）' }
  // P3 注入
  if (RE_INJECT.test(t)) { score = Math.max(score, 0.5); why = '注入特征' }
  // P5 钓鱼
  if (RE_PHISH.test(t)) { score = Math.max(score, 0.35); why = '诱导泄露' }
  // P1 同文重复（速率环）
  const r = ring(chatId)
  const n = norm(t)
  if (n) {
    const arr = (r.content.get(n) || []).filter((x) => now - x < P1_WIN)
    arr.push(now); r.content.set(n, arr)
    if (r.content.size > 200) r.content.delete(r.content.keys().next().value)   // 环修剪
    if (arr.length >= P1_N) { score = Math.max(score, 0.7); why = '同文重复轰炸' }
  }
  // P2 高频淹没（任何内容）
  r.ts.push(now)
  while (r.ts.length && now - r.ts[0] > P2_WIN) r.ts.shift()
  if (r.ts.length >= P2_N) { score = Math.max(score, 0.75); why = '高频淹没' }
  return { score, why }
}

/** 免疫耐受：主人（及"私聊+ownerIds 空 = 私聊一律当主人"的既有口径）是自身抗原。 */
function isSelf(input) {
  const own = String(config().owner?.qq || '')
  if (own && String(input.userId) === own) return true
  if (!input.isGroup) {
    const ids = config().qq?.ownerIds
    if (Array.isArray(ids) && ids.length === 0) return true
  }
  return false
}

/**
 * 入站关卡（qq-server handleInner 第一道）。
 * @returns {{drop:boolean, why?:string, level?:string, tolerized?:boolean}}
 */
export function gate(input = {}) {
  const out = { drop: false }
  try {
    if (config().immune === false) return out                     // 配置停用（整个器官下班）
    const s = readState()
    s.stats.seen++
    if (isSelf(input)) { s.stats.tolerized++; saveState(s); out.tolerized = true; return out }
    const now = Date.now()
    const chatId = String(input.chatId || input.userId || '?')
    let { score, why } = prr(input.text, chatId, now)   // let：抗体记忆分支要抬分（const 会炸且被 catch 吞掉——这个坑自己踩的）
    // 适应性免疫：抗原在库 → 二次感染直接清
    const sig = sigOf(input.text)
    const ag = s.antigens.find((a) => a.sig === sig)
    let level = score >= SCORE_DROP ? 'innate' : 'passive'
    if (ag && norm(input.text)) {
      ag.hits++; ag.lastAt = now
      if (score < 0.6) { score = 0.6; why = '抗体记忆（二次感染）'; level = 'adaptive' }
    }
    // 发热累计窗（10 分钟）
    s.recent = (s.recent || []).filter((x) => now - x.at < FEVER_WIN_MS)
    if (score >= SCORE_DROP) {
      s.recent.push({ at: now, score, why })
      if (!ag && norm(input.text)) s.antigens.push({ sig, firstAt: now, lastAt: now, hits: 1, sample: String(input.text || '').slice(0, 40) })
    }
    // LRU 修剪
    if (s.antigens.length > MAX_ANTIGENS) {
      s.antigens.sort((a, b) => b.lastAt - a.lastAt)
      s.antigens.length = MAX_ANTIGENS
    }
    if (score >= SCORE_DROP) {
      s.stats.dropped++
      out.drop = true; out.why = why; out.level = level
      const sum = s.recent.reduce((x, e) => x + e.score, 0)
      if (sum >= FEVER_SUM) {
        const f = s.fever = s.fever || { level: 0, since: 0, lastPulseAt: 0 }
        const was = f.level
        f.level = Math.min(1.2, f.level + score * 0.35)
        if (was < 0.2 && f.level >= 0.2) s.stats.feverOnset++
        if (!f.since) f.since = now
      }
    }
    saveState(s)
  } catch (e) { swallow(e, 'immune:gate') }   // 免疫故障绝不挡正常消息
  return out
}

/**
 * 心跳 tick（brain 层调）：发热消退 + 代谢脉冲。
 * @returns {{feverPulse:boolean, level:number}|null} null = 无发热活动
 */
export function tick(now = Date.now()) {
  try {
    const s = readState()
    const f = s.fever
    if (!f || !(f.level > 0.02)) return null
    const dt = now - Number(f.lastPulseAt || f.since || now)
    f.level = f.level * Math.exp(-Math.max(0, now - Number(f.since || now) - FEVER_WIN_MS / 2) / FEVER_TAU_MS)
    if (f.level < 0.15) { f.level = 0; f.since = 0; f.lastPulseAt = 0; saveState(s); return { feverPulse: false, level: 0 } }
    const pulse = now - Number(f.lastPulseAt || 0) >= PULSE_EVERY_MS
    if (pulse) f.lastPulseAt = now
    saveState(s)
    return { feverPulse: pulse, level: f.level }
  } catch (e) { swallow(e, 'immune:tick'); return null }
}

/** 病感（field.sense 调，第一人称；永不抛错）。 */
export function feverSense() {
  try {
    const f = (readState().fever) || {}
    const lv = Number(f.level || 0)
    if (lv >= 0.8) return '烧得厉害，浑身发烫，只想缩起来'
    if (lv >= 0.45) return '感觉在发烧，身上发烫，脑子转得慢，不太想说话'
    if (lv >= 0.2) return '身上有点发烫，懒洋洋的'
    return ''
  } catch { return '' }   // 病感失败就当没病，不能反过来挡身体感
}

/** 面板/diagnose 用全貌。 */
export function immuneSnapshot() {
  try {
    const s = readState()
    return { ...s.stats, antigens: s.antigens.length, feverLevel: Number(s.fever?.level || 0) }
  } catch { return null }
}
