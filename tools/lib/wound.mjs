// wound —— 伤口愈合 / 再生系统（2026-11-03 · A2 仿生工程）
//
// 现象：她的自愈能力是散的——熔断器在隔离故障通道，swallow 在留痕错误，
//       selfmod 在修代码，门禁在把关回归。但没有一个地方回答：
//       「现在身上有开放性损伤吗？哪个？开了多久了？以前受过同样的伤吗？」
// 生物学：伤口愈合三阶段——
//   ① 炎症：损伤发生，局部隔离（熔断跳闸 = 炎症反应在隔离感染源）
//   ② 增生：修复行动（selfmod 提案 = 成纤维细胞在填胶原）
//   ③ 重塑：全身检查通过才算愈合（门禁全绿 = 整个人体检过关），且沉淀瘢痕
//      —— 瘢痕组织比原组织更强：同类损伤再次出现时立刻认出来（旧伤复发）
// 化脓：开放性伤口超 6 小时没人管 → infected。它该被感觉到疼（B4 痛觉的雏形：
//       心跳巡视会 log，diagnose 挂红）——不疼的伤口永远不会被优先修。
// 口径（M58）：这个器官不修复任何东西——修复是 selfmod 的活、隔离是熔断器的活。
//       它只负责"损伤的生命周期账本 + 瘢痕记忆"。单独拿出来，它演出的现象是：
//       「同样的错反复出现，而没有人记得它出现过」→ 现在能记住了。
//
// 与 B1 免疫的分工：immune 管外来物（病原），wound 管自己身上的损伤（外伤）。
//
// 不接 swallow 高频：swallow 是全库基础件，wound 若 import 它（或反向）都会成环
// （M55 批评过 persona↔recall 那根反向线）。损伤源保持两类硬信号：熔断 + 门禁。
import { dataPath } from './paths.mjs'
import { readJsonSafe, updateJson } from './atomic.mjs'

const STATE_FILE = () => dataPath('wounds.json')
const INFECT_AFTER_MS = 6 * 3600_000   // 开放超 6h = 化脓
const MAX_SCARS = 100                  // 瘢痕库容量（LRU 修剪）
const MAX_WOUNDS = 30

const _cache = { st: null, at: 0 }
function readState(now = Date.now()) {
  if (_cache.st && now - _cache.at < 10_000) return _cache.st
  const s = readJsonSafe(STATE_FILE(), null) || { wounds: [], scars: [], stats: { registered: 0, healed: 0, infected: 0, recurrent: 0 } }
  _cache.st = s; _cache.at = Date.now()
  return s
}
function saveState(s) {
  _cache.st = s; _cache.at = Date.now()
  try { updateJson(STATE_FILE(), () => s) } catch { /* 账本写失败不反过来制造损伤——下一次 register 会重试 */ }
}

/** 伤口 key：kind + 规范化主语（同源损伤不重开）。 */
const keyOf = (kind, subject) => kind + ':' + String(subject || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60)

/**
 * 损伤登记（幂等）。同 key 已有开放伤口 → 更新计数不重开；
 * 同 key 有瘢痕（旧伤）→ recurrent: true（旧伤复发，声量该更大）。
 * @returns {{id:string, state:'open'|'existing', recurrent:boolean}}
 */
export function register(kind, subject, detail = '') {
  const out = { id: '', state: 'open', recurrent: false }
  try {
    const s = readState()
    const now = Date.now()
    const key = keyOf(kind, subject)
    const scars = (s.scars || []).filter((x) => x.key === key)
    if (scars.length) out.recurrent = true
    let w = s.wounds.find((x) => x.key === key && x.state !== 'healed')
    if (w) {
      w.hits = (Number(w.hits) || 0) + 1
      w.lastAt = now
      if (detail && !w.detail.includes(String(detail).slice(0, 40))) w.detail = (w.detail + ' | ' + String(detail).slice(0, 80)).slice(0, 200)
      out.id = w.id; out.state = 'existing'
    } else {
      w = {
        id: 'W' + now.toString(36) + Math.floor(Math.random() * 1296).toString(36),
        key, kind, subject: String(subject || '').slice(0, 60),
        detail: String(detail || '').slice(0, 200),
        openedAt: now, lastAt: now, hits: 1, state: 'open',
        recurrent: out.recurrent,
      }
      s.wounds.push(w)
      if (s.wounds.length > MAX_WOUNDS) {
        // 优先关掉已愈合的旧记录，其次最老的
        s.wounds = s.wounds.filter((x) => x.state !== 'healed').concat(s.wounds.filter((x) => x.state === 'healed')).slice(0, MAX_WOUNDS)
      }
      out.id = w.id
      s.stats.registered++
      if (out.recurrent) s.stats.recurrent++
    }
    saveState(s)
  } catch { /* 损伤账本故障不反过来挡损伤处理 */ }
  return out
}

/**
 * 心跳巡视：开放伤口 age 检查。超时 → infected（化脓）。
 * @returns {{infected:string[], open:number}|null} null = 没有活跃伤口（纯本地判定）
 */
export function tick(now = Date.now()) {
  try {
    const s = readState(now)
    if (!s.wounds.length) return null
    let changed = false
    const infected = []
    for (const w of s.wounds) {
      if (w.state === 'open' && now - w.openedAt > INFECT_AFTER_MS) {
        w.state = 'infected'; w.infectedAt = now; changed = true
        s.stats.infected++
        infected.push(w.id + '(' + w.kind + ':' + w.subject + ')')
      }
    }
    if (changed) saveState(s)
    const open = s.wounds.filter((x) => x.state === 'open' || x.state === 'infected').length
    return (infected.length || open) ? { infected, open } : null
  } catch { return null }
}

/**
 * 全身检查通过（check.mjs 全绿路径调用）：所有未愈合伤口 → healed，
 * 且沉淀瘢痕（教训）。瘢痕组织比原组织强：下次同类损伤 register 会识别复发。
 * @param {string} scarNote 瘢痕上的教训文本（一般传最近一次提交说明或空）
 */
export function closeIfHealed(scarNote = '') {
  const out = { closed: 0, scarred: 0 }
  try {
    const s = readState()
    const now = Date.now()
    for (const w of s.wounds) {
      if (w.state === 'open' || w.state === 'infected') {
        w.state = 'healed'
        w.healedAt = now
        w.durationMs = now - w.openedAt
        out.closed++
        s.stats.healed++
        s.scars.push({
          key: w.key, kind: w.kind, subject: w.subject,
          detail: w.detail, hits: w.hits, recurrent: !!w.recurrent,
          durationMs: w.durationMs, scarNote: String(scarNote || '').slice(0, 120), at: now,
        })
        out.scarred++
      }
    }
    if (s.scars.length > MAX_SCARS) s.scars = s.scars.slice(-MAX_SCARS)
    if (out.closed) saveState(s)
  } catch { /* 账本故障不挡门禁本身 */ }
  return out
}

/** diagnose / 面板全貌。 */
export function woundSnapshot() {
  try {
    const s = readState()
    const act = s.wounds.filter((x) => x.state !== 'healed')
    return {
      open: act.filter((x) => x.state === 'open').length,
      infected: act.filter((x) => x.state === 'infected').map((x) => x.kind + ':' + x.subject),
      scars: s.scars.length,
      recurrent: s.stats.recurrent,
      wounds: act.slice(-5).map((x) => ({ id: x.id, kind: x.kind, subject: x.subject, state: x.state, hits: x.hits, recurrent: !!x.recurrent, ageMs: Date.now() - x.openedAt })),
    }
  } catch { return null }
}
