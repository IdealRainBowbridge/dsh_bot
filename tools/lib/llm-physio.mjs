// llm-physio —— 表达代谢：token 预算的「体感」（2026-11-03 · B7，R2 修缮版）
//
// 现象（M58 口径，先有现象再有器官）：她说话的成本只体现在账本和运维告警里，
// 她自己完全感觉不到——花超了顶多被关掉，中间没有任何主观过渡。机器式断崖。
//
// 生物学依据：说话是耗能行为。能量低时生物的输出不是"被掐断"，而是渐进收缩：
//   话变短、变得省字、不主动展开——先收着说，实在不行才不说话。
// 对应到她：token 消耗就是"说话的糖"。今天烧得越多，越该省着说。
//
// ── R2 修缮（冒烟第 2 轮抓到的盲区）────────────────────────────────────
// v1 只读 llm-usage.jsonl（直连通道账本）——但她的饭钱大头在 DSH 会话侧
// （实测 2026-11-03：总 152.8 万，直连只占 49.5 万 ≈ 1/3）。器官只看见三分之
// 一的进食量，超支感知永远迟钝。现在改读 ledger-brief.json（ledger 每 10 分钟
// 刷新的合并快照，report.me.tokens = DSH 会话 + 直连全通道），直连账本降级为
// 后备（brief 缺席/过期 >30 分钟时——比如 qq-server 刚装还没刷过账）。
//
// 形状（和 immune/metabolism/pain 的 llmState() 家族同一契约）：
//   note(cfg) → { temperature: -0.15|…, note: '…' } | null
//     · 永不抛错；没意见给 null（不过敏体质：不能天天喊累）
//     · 只在真超预算时出声——账本数字不该变成新的 KPI 心跳
//   dailyTokens() → { input, output, cache, total, calls, via }（via: 'brief'|'direct'）
//
// 接线：qq-server 动态温度 v2 的器官循环里多挂一路（内容定基调，身体定幅度）。
// 预算阈值在配置 llm.dailyBudgetTokens（默认 0 = 不限，即本器官静默）。
import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'
import { swallow } from './swallow.mjs'

const USAGE_FILE = () => dataPath('llm-usage.jsonl')
const BRIEF_FILE = () => dataPath('cache', 'ledger-brief.json')
const BRIEF_TTL = 30 * 60_000          // brief 是 10 分钟一刷；30 分钟内算新鲜
const ZERO = () => ({ input: 0, output: 0, cache: 0, total: 0, calls: 0 })

/** 后备：直连通道今天的用量（读账本尾部——账本按天追加，256KB 绰绰有余）。 */
function dailyTokensDirect(day = new Date().toLocaleDateString('sv-SE')) {
  let raw = ''
  try {
    const f = USAGE_FILE()
    if (!fs.existsSync(f)) return { ...ZERO(), via: 'direct' }
    const st = fs.statSync(f)
    const want = Math.min(st.size, 256 * 1024)
    const truncated = st.size > want          // R2 修复：只有真截断了，首行才可能是残行
    const fd = fs.openSync(f, 'r')
    try {
      const buf = Buffer.alloc(want)
      fs.readSync(fd, buf, 0, want, st.size - want)
      raw = buf.toString('utf8')
      // v1 的潜伏 bug：无条件 slice 丢首行 —— 文件不足 256KB（没截断）时首行是
      // 完整记录，白丢一条（新装/新的一天必然少记）。只在截断时丢。
      if (truncated) raw = raw.slice(raw.indexOf('\n') + 1)
    } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
  } catch (e) { swallow(e, 'llm-physio:dailyTokensDirect'); return { ...ZERO(), via: 'direct' } }
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
  const out = { ...ZERO(), via: 'direct' }
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s)
      if (r.day !== day) continue
      out.input += num(r.input); out.output += num(r.output); out.cache += num(r.cache)
      out.calls++
    } catch { /* 坏行跳过（账本铁律） */ }
  }
  out.total = out.input + out.output
  return out
}

/**
 * 今天的全通道用量。
 * 优先 ledger-brief.json（ledger 每 10 分钟刷的合并快照，report.me.tokens 含
 * DSH 会话 + 直连）；brief 缺席/过期/日期不符 → 回落直连账本。
 */
export function dailyTokens(day = new Date().toLocaleDateString('sv-SE')) {
  try {
    const f = BRIEF_FILE()
    if (fs.existsSync(f)) {
      const b = JSON.parse(fs.readFileSync(f, 'utf8'))
      const fresh = b && Number(b.at) > 0 && (Date.now() - Number(b.at)) < BRIEF_TTL
      const today = b && b.report?.me?.tokens && b.today === day
      if (fresh && today) {
        const t = b.report.me.tokens
        const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
        return {
          input: num(t.input), output: num(t.output), cache: num(t.cache),
          total: num(t.total) || num(t.input) + num(t.output),
          calls: num(t.calls), via: 'brief',
        }
      }
    }
  } catch (e) { swallow(e, 'llm-physio:brief') }
  return dailyTokensDirect(day)
}

/**
 * 预算体感。cfg 传 config().llm（不传自己读）。
 * @returns {{temperature:number, note:string}|null}
 */
export function note(cfg = null) {
  try {
    const c = cfg || (config().llm ?? {})
    const budget = Number(c.dailyBudgetTokens || 0)
    if (!(budget > 0)) return null                      // 没设预算 = 器官静默，不装累
    const u = dailyTokens()
    if (!u.calls) return null
    const ratio = u.total / budget
    // 100% 以前不给任何体感：偶尔聊得多不是事，天天喊累=过敏体质（M58 反例）
    if (ratio < 1) return null
    // 超了：温和收缩，不做断崖。30% 封顶，别把预算器官变成新的暴政。
    const over = Math.min(0.3, (ratio - 1) * 0.5)
    return {
      temperature: -Math.max(0.05, over),
      note: ratio >= 2
        ? '今天话说得太多了，能一个字说清的就不用两个'
        : '今天聊了不少，说话省着点',
    }
  } catch (e) { swallow(e, 'llm-physio:note'); return null }
}
