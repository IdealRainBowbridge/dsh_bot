// LLM 直连客户端 —— 移植 dafeiyu brain/llm.py（requests → fetch）。
// QQ/抖音的实时响应用：直连 OpenAI 兼容端点，按 token 计费。
// 与 B站那套「塞回 DSH 会话」是两条路：那边零费但慢，这边快但按量付费。
//
// 双通道（10-26）：主通道挂了/额度没了，自动落到 llm.fallback（换一家供应商的 key）。
// 这样换平台不用改代码，也不会因为某一家 429 就整晚不吭声。
import fs from 'node:fs'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'

const _cfg = () => config().llm ?? {}

// ── 记账（10-31）─────────────────────────────────────────────────────────────
// 漏洞：QQ / 微信 / 抖音 / 主动搭话 / mind 规划全走这条直连通道，
// 而账本只扫 DSH 会话日志（~/.dsh/sessions/*.zstd）—— 她陪老爹聊天烧的钱，
// 账本一分看不见。实测：唤醒后 DSH 记了 5131 token，同一时段 a2a 余额掉了 241。
// 所以直连通道必须自己记一笔：每次成功调用把 usage 追加到直连用量账本。
const DIRECT_USAGE = () => dataPath('llm-usage.jsonl')

/** 把一次直连调用的 usage 追加进账本。失败绝不打断对话。 */
export function recordDirectUsage(usage, meta = {}) {
  if (!usage || typeof usage !== 'object') return
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
  const rec = {
    at: Date.now(),
    day: new Date().toLocaleDateString('sv-SE'),
    input: num(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens),
    output: num(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens),
    cache: num(usage.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cachedTokens),
    model: meta.model || '',
    via: meta.via || 'direct',
  }
  if (!rec.input && !rec.output) return
  try {
    const f = DIRECT_USAGE()
    fs.mkdirSync(f.slice(0, f.lastIndexOf('/')) || '.', { recursive: true })
    fs.appendFileSync(f, JSON.stringify(rec) + '\n')
  } catch { /* 记账失败不挡业务 */ }
}

/** 读直连账本（给 ledger 合并用）。返回 {days:[{day,input,output,cache,total,calls}], lifetime} */
export function readDirectUsage() {
  const out = { days: [], lifetime: { input: 0, output: 0, cache: 0, total: 0, calls: 0 } }
  let lines = []
  try { lines = fs.readFileSync(DIRECT_USAGE(), 'utf8').trim().split('\n').filter(Boolean) } catch { return out }
  const byDay = new Map()
  let staleCut = Date.now() - 400 * 86400_000   // 400 天外的行直接忽略（防文件无限长拖慢）
  for (const l of lines) {
    let r
    try { r = JSON.parse(l) } catch { continue }
    if (!r || !r.at || Number(r.at) < staleCut) continue
    const day = r.day || new Date(Number(r.at)).toLocaleDateString('sv-SE')
    if (!byDay.has(day)) byDay.set(day, { day, input: 0, output: 0, cache: 0, total: 0, calls: 0 })
    const d = byDay.get(day)
    d.input += Number(r.input) || 0
    d.output += Number(r.output) || 0
    d.cache += Number(r.cache) || 0
    d.calls += 1
    out.lifetime.input += Number(r.input) || 0
    out.lifetime.output += Number(r.output) || 0
    out.lifetime.cache += Number(r.cache) || 0
    out.lifetime.calls += 1
  }
  for (const d of byDay.values()) { d.total = d.input + d.output; out.days.push(d) }
  out.lifetime.total = out.lifetime.input + out.lifetime.output
  out.days.sort((a, b) => (a.day < b.day ? -1 : 1))
  return out
}
const _fb = () => _cfg().fallback ?? {}

/** API key：环境变量优先（DEEPSEEK_API_KEY / LLM_API_KEY），再读配置文件。 */
export const apiKey = () => process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || _cfg().api_key || ''

/** 当前主通道的简述（日志/面板用）。 */
export function describe() {
  const c = _cfg()
  const f = _fb()
  return `${c.model || 'deepseek-chat'} @ ${(c.base_url || 'https://api.deepseek.com/v1').replace(/^https?:\/\//, '')}`
    + (f.model ? `（备：${f.model} @ ${String(f.base_url || '').replace(/^https?:\/\//, '')}）` : '')
}

function endpointOf(c) {
  return (c.base_url || 'https://api.deepseek.com/v1').replace(/\/+$/, '') + '/chat/completions'
}
function endpoint() {
  return endpointOf(_cfg())
}

function headersOf(c) {
  return {
    'Authorization': `Bearer ${c.api_key || apiKey()}`,
    'Content-Type': 'application/json',
  }
}
function headers() {
  return headersOf({ ..._cfg(), api_key: apiKey() })
}

function payloadOf(c, messages, opts = {}) {
  return {
    model: opts.model || c.model || 'deepseek-chat',
    messages,
    temperature: opts.temperature ?? (c.temperature ?? 0.92),
    max_tokens: opts.max_tokens || c.max_tokens || 600,
    presence_penalty: 0.3,     // 防复读
    frequency_penalty: 0.2,
    stream: opts.stream === true,
    // 供应商私有参数（10-26）：如千问系的 { enable_thinking: false }。
    // 实测开了思考链，同一段人格 prompt 要 14s；关掉 1.4s —— 陪聊场景必须关。
    ...(c.params || {}),
    ...(opts.params || {}),
  }
}
function payload(messages, opts = {}) {
  return payloadOf(_cfg(), messages, opts)
}

/** 一次性拿全文。主通道失败自动换 fallback（除非 opts.noFallback）。 */
export async function chat(messages, opts = {}) {
  const main = _cfg()
  const fb = _fb()
  const tryOne = async (c) => {
    const r = await fetch(endpointOf(c), {
      method: 'POST',
      headers: headersOf({ ...c, api_key: c.api_key || apiKey() }),
      body: JSON.stringify(payloadOf(c, messages, opts)),
      signal: AbortSignal.timeout(opts.timeoutMs || 90000),
    })
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    const out = (j.choices?.[0]?.message?.content ?? '').trim()
    if (!out) throw new Error('LLM 返回空内容')
    // 直连通道自己记账（账本只扫 DSH 会话，扫不到这条路）
    try { recordDirectUsage(j.usage, { model: c.model, via: 'chat' }) } catch {}
    return out
  }
  try {
    return await tryOne(main)
  } catch (e) {
    if (opts.noFallback || !fb.model || !(fb.api_key || fb.base_url)) throw e
    try {
      // 备通道有自己的私有参数体系，别把主通道的 params 带过去（DeepSeek 官方不认 enable_thinking）
      const out = await tryOne({ ...main, ...fb, params: fb.params ?? {} })
      try { (await import('node:fs')).appendFileSync((await import('./paths.mjs')).dataPath('llm-fallback.log'), `${new Date().toISOString()} 主通道失败(${String(e.message).slice(0, 80)}) → 已用备通道\n`) } catch {}
      return out
    } catch (e2) {
      throw new Error(`主通道失败（${String(e.message).slice(0, 90)}）；备通道也失败（${String(e2.message).slice(0, 90)}）`)
    }
  }
}

/** 流式：边收边吐增量文本（思考链外显 / 分句发送）。 */
export async function* chatStream(messages, opts = {}) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload(messages, { ...opts, stream: true })),
    signal: AbortSignal.timeout(120000),
  })
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}`)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') return
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch { /* 忽略坏帧 */ }
    }
  }
}

/** 要求模型只回 JSON（用于写脚本/文案）。 */
export async function jsonChat(messages, schemaHint, opts = {}) {
  const sys = { role: 'system', content: '你只输出合法 JSON，不要 markdown 代码块，不要任何解释。\n字段结构：' + schemaHint }
  let raw = await chat([sys, ...messages], opts)
  raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim()
  return JSON.parse(raw)
}
