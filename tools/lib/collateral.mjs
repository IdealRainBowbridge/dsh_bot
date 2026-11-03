// 侧支循环（2026-11-03 · A1 仿生工程）
//
// 现象：4 级 fallback 全部同源（a2a 一家网关）。网关打一个喷嚏，
//       她整段对话没回复 —— M55 评分「兼容 7.0」的根，diagnose 已挂牌
//       [single-provider risk: all levels same origin]。
// 生物学：心脏不会只有一根冠脉。侧支循环平时不动用，主干堵了才顶上；
//         长期不用会萎缩，所以健康的心脏会周期性"试跳"保持通路活性。
//
// 形状：
//   · 异源通道 = bot.config.json 的 llm.collateral（没配 = 器官在、血管是空的，
//     **不造默认端点** —— 宁缺勿假）。它在 _chain() 之外，任何主链配置失误
//     都波及不到它，这就是"侧支"和"备用"的区别。
//   · 血债 bloodDebt：主链每全灭一次 +1，侧支成功通血一次清零。
//     血债 >0 后 30s 窗口内的调用会"试跳"侧支（模拟侧支灌注），
//     连续 5 次试跳健康 = 主链已恢复，血债清零。
//   · 全灭时 chat() 把侧支级追加进 levels —— 熔断/重试/记账/日志全部复用现有机制。
//   · noFallback 的调用不烧侧支（尊重"只用主通道"的语义）。
//
// 验收：test/collateral-test.mjs —— 全灭通血 / 血债清零 / 异源校验 / 试跳恢复。
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'
import { updateJson, readJsonSafe } from './atomic.mjs'

const STATE_FILE = () => dataPath('llm-collateral.json')
const PROBE_WINDOW_MS = 30_000   // 全灭后这个窗口内允许试跳
const PROBE_MAX = 5              // 连续健康试跳次数 → 判定主链恢复

const hostOf = (u) => String(u || '').replace(/^https?:\/\//, '')

// 模块内 30s 缓存：心跳每拍都来问，不能每拍都读盘
const _cache = { state: null, readAt: 0 }

function readState() {
  if (_cache.state && Date.now() - _cache.readAt < PROBE_WINDOW_MS) return _cache.state
  const s = readJsonSafe(STATE_FILE(), null) || { bloodDebt: 0, lastTotalFailure: 0, probes: 0, lastProbeAt: 0 }
  _cache.state = s
  _cache.readAt = Date.now()
  return s
}

function saveState(s) {
  _cache.state = s
  _cache.readAt = Date.now()
  try { updateJson(STATE_FILE(), () => s) } catch (e) { swallow(e, 'collateral:save') }
}

/** 异源侧支通道。返回 null = 没配（别造）。 */
export function level() {
  const c = config().llm ?? {}
  const x = c.collateral ?? {}
  const base = String(x.base_url || '').trim()
  if (!base || !x.model) return null
  // 异源校验：和主通道同源就不配为侧支（那是备用，不是侧支）
  if (hostOf(base) === hostOf(c.base_url || 'https://api.deepseek.com/v1')) return null
  return { base_url: base, api_key: x.api_key || '', model: x.model, max_tokens: x.max_tokens, __key: 'fb-collateral' }
}

/** 主链全灭记账（chat() 抛"全部通道失败"前调）。 */
export function recordBloodDebt() {
  const s = readState()
  s.bloodDebt = (Number(s.bloodDebt) || 0) + 1
  s.lastTotalFailure = Date.now()
  saveState(s)
  return s.bloodDebt
}

/** 侧支成功通血：血债清零（活下来了）。 */
export function recordSideUse(key) {
  const s = readState()
  if (s.bloodDebt > 0) s.bloodDebt = 0
  s.probes = 0
  s.lastSideUseAt = Date.now()
  saveState(s)
  return s
}

/**
 * 把侧支级追加进 levels（chat/chatStream/chatRaw 共用）。
 * 门控：配置了侧支 + 不是 noFallback + 血债 >0（主链全灭过）。
 * 平时一个字节都不多走 —— 侧支血管不是日常供血路线。
 */
export function collateralize(levels, opts = {}) {
  try {
    if (opts.noFallback) return levels
    const lvl = level()
    if (!lvl) return levels
    const s = readState()
    if (!(Number(s.bloodDebt) > 0)) return levels
    if (levels.some((x) => x && x.__key === 'fb-collateral')) return levels
    levels.push(lvl)
  } catch (e) { swallow(e, 'collateral:collateralize') }
  return levels
}

/**
 * 试跳（心跳调用，now=当前时间）。纯本地判定，不满足条件连请求都不发：
 *   · 没配侧支 / 没有血债 → 直接返回
 *   · 全灭后 30s 窗口内且距上次试跳 ≥ 窗口 → 发一次探测
 *   · 探测健康 probes+1，攒满 PROBE_MAX → 血债清零（主链已恢复）
 *   · 探测失败不动血债（不惩罚，下一窗再试）
 */
export async function sweep(now = Date.now()) {
  const s = readState()
  if (!(Number(s.bloodDebt) > 0)) return null
  const lvl = level()
  if (!lvl) return null
  if (now - Number(s.lastTotalFailure || 0) > PROBE_WINDOW_MS) return null
  if (now - Number(s.lastProbeAt || 0) < PROBE_WINDOW_MS) return null
  let healthy = false
  try {
    const r = await fetch(lvl.base_url.replace(/\/+$/, '') + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + (lvl.api_key || process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '') },
      signal: AbortSignal.timeout(8000),
    })
    healthy = r.ok
  } catch (e) { swallow(e, 'collateral:sweep') }
  s.lastProbeAt = now
  if (healthy) {
    s.probes = (Number(s.probes) || 0) + 1
    if (s.probes >= PROBE_MAX) { s.probes = 0; s.bloodDebt = 0 }
  }
  saveState(s)
  return { healthy, probes: s.probes, bloodDebt: s.bloodDebt }
}

/** describe() 尾巴：侧支挂载状态 + 血债（给 /api/status 与 diagnose 看）。 */
export function describeCollateral() {
  try {
    const s = readState()
    const lvl = level()
    const bits = []
    if (lvl) bits.push('侧支已挂@' + hostOf(lvl.base_url))
    if (Number(s.bloodDebt) > 0) bits.push('主链血债 ' + s.bloodDebt)
    return bits.length ? ' · [' + bits.join(' · ') + ']' : ''
  } catch { return '' }
}
