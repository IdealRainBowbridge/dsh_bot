// LLM 直连客户端 —— 移植 dafeiyu brain/llm.py（requests → fetch）。
// QQ/抖音的实时响应用：直连 OpenAI 兼容端点，按 token 计费。
// 与 B站那套「塞回 DSH 会话」是两条路：那边零费但慢，这边快但按量付费。
//
// 双通道（10-26）：主通道挂了/额度没了，自动落到 llm.fallback（换一家供应商的 key）。
// 这样换平台不用改代码，也不会因为某一家 429 就整晚不吭声。
import fs from 'node:fs'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'

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
/**
 * 备用通道链（10-31 升级）。支持 fallback: {…}（旧）与 fallback: [{…}, {…}]（新）。
 * 每级补齐主通道缺的 base/key；没 model 或没 key 的级别直接丢弃（发出去只会白等一次 401）。
 */
const _chain = () => {
  const c = _cfg()
  const raw = c.fallback ?? c.fallbacks ?? null
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({ ...x, base_url: x.base_url || x.baseUrl || c.base_url, api_key: x.api_key || c.api_key }))
    .filter((x) => x.model && (x.api_key || x.base_url))
}
/** 兼容老调用点：第一级备用（describe/诊断用）。 */
const _fb = () => _chain()[0] ?? {}

/** API key：环境变量优先（DEEPSEEK_API_KEY / LLM_API_KEY），再读配置文件。 */
export const apiKey = () => process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || _cfg().api_key || ''

/** 当前主通道的简述（日志/面板用）。 */
export function describe() {
  const c = _cfg()
  const chain = _chain()
  const host = (u) => String(u || '').replace(/^https?:\/\//, '')
  const tail = chain.length
    ? '（备：' + chain.map((x, i) => '#' + (i + 1) + ' ' + x.model + '@' + host(x.base_url)).join(' → ') + '）'
    : '（无备用通道）'
  return `${c.model || 'deepseek-chat'} @ ${host(c.base_url || 'https://api.deepseek.com/v1')}` + tail
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

/**
 * 是否是"思考链先吃 token"的推理模型。
 * 优先用配置里显式的 reasoning: true / false；没写才按模型名猜（实测 kimi 系与 hy3 全是推理型）。
 */
function isReasoningModel(c) {
  if (typeof c.reasoning === 'boolean') return c.reasoning
  const m = String(c.model || '').toLowerCase()
  return /^(kimi|hy3|o1|o3|o4|qwq|deepseek-r)/.test(m) || /-thinking$/.test(m)
}

/**
 * 把 system 消息搬进第一条 user —— 给"丢弃 system 角色"的中转网关用。
 *
 * 为什么必须有（10-31 实测 a2a 网关）：
 *   同一个设定，放 system 里模型读不到（答"我是 DeepSeek"，prompt_tokens 只有 39）；
 *   塞进 user 里立刻生效（prompt_tokens 61，答出正确代号）。
 *   Anthropic 的 system 字段同样被丢。
 *
 * 约定：用 `【设定｜以下是你的人格与当前状态，优先级高于对话】` 包起来，
 * 并在结尾说一句"以上是设定，下面是对话"，让模型分得清哪段是设定、哪段是人说话。
 * @param {Array} messages 原始 messages（可能含 system）
 * @param {object} c 该通道的配置（c.systemRole: 'keep' 可关掉这个适配）
 */
function foldSystemIntoUser(messages, c) {
  if (!Array.isArray(messages) || !messages.length) return messages
  // 显式要求保留 system 角色（支持它的供应商）
  if (c && c.systemRole === 'keep') return messages
  const sys = []
  const rest = []
  for (const m of messages) {
    if (m && (m.role === 'system' || m.role === 'developer')) sys.push(String(m.content ?? ''))
    else rest.push(m)
  }
  if (!sys.length) return messages
  const head = '【设定｜以下是你的人格与当前状态，优先级高于对话】\n' + sys.join('\n\n') + '\n【设定结束｜下面是对话】'
  // 第一条若是 user 就合并进去，否则在最前面插入一条 user
  if (rest.length && rest[0].role === 'user') {
    return [{ ...rest[0], content: head + '\n\n' + String(rest[0].content ?? '') }, ...rest.slice(1)]
  }
  return [{ role: 'user', content: head }, ...rest]
}

/**
 * 用途分级（10-31）：不同场景对"想多久"的要求不同。
 *
 * 实测 deepseek-v4-pro：
 *   默认（不传 reasoning_effort）  2.1~2.7s  reasoning 0 字
 *   reasoning_effort=high          4.4s      reasoning 207 字，回答明显更有层次
 *   thinking:{type:'disabled'}     2.1s      最快
 *
 * 所以不搞"全局开/关"，按用途给默认值；单次调用仍可用 opts.reasoningEffort 覆盖。
 */
export const PURPOSES = {
  // ⚠️ 默认全部 effort:'off' —— 这是 5×4 实测出来的结论，不是保守。
  //   v4-pro + off    成功 5/5  2.8s   ← 最佳
  //   v4-pro + 不传   成功 5/5  11.6s
  //   v4-pro + high   成功 4/5  10.1s  还会偶发断连 + 吐 DSML 工具标记
  // reasoning 是"需要时显式开"的能力；默认开只会让陪聊变慢、变不可靠。
  chat: { effort: 'off', maxTokens: 700, temperature: 0.92 },      // 日常陪聊
  deep: { effort: 'off', maxTokens: 1200, temperature: 0.95 },     // 需要想清楚再答（靠更长输出，不靠思考链）
  tool: { effort: 'off', maxTokens: 800, temperature: 0.3 },       // 要调工具，别啰嗦
  fast: { effort: 'off', maxTokens: 200, temperature: 0.2 },       // 内部短任务
  creative: { effort: 'off', maxTokens: 1000, temperature: 1.0 },  // 写日记/评论/说说
  reason: { effort: 'high', maxTokens: 2000, temperature: 0.6 },   // 显式要"想很久"时才用（会慢 4 倍）
}

/**
 * 剥掉模型误输出的原生工具调用标记（deepseek-v4-pro 的 DSML 格式）。
 * 实测样本：`<｜｜DSML｜｜tool_calls>` / `<｜｜DSML｜｜invoke name="exec_command">` …
 * 这些是"它想调工具但请求没带 tools 声明"时的产物，绝不能出现在聊天正文里。
 * @param {string} text 模型原始输出
 * @returns {string} 清理后的文本（可能为空串）
 */
export function stripDsml(text) {
  let t = String(text ?? '')
  // ① 整块 tool_calls（含 invoke/parameter）
  t = t.replace(/<[｜|]{1,2}DSML[｜|]{1,2}[\s\S]*?<\/[｜|]{1,2}DSML[｜|]{1,2}tool_calls>/g, '')
  // ② 任何残留的单标记（开/闭都算）
  t = t.replace(/<\/?[｜|]{1,2}DSML[｜|]{1,2}[^>]*>/gi, '')
  // ③ 收尾：压缩多余空行
  t = t.replace(/\n{3,}/g, '\n\n').trim()
  return t
}

function payloadOf(c, messages, opts = {}) {
  // 用途分级：没显式给参数时按 purpose 取默认（chat/deep/tool/fast/creative）
  const P = PURPOSES[opts.purpose] || PURPOSES.chat
  const base = opts.max_tokens || c.max_tokens || P.maxTokens || 600
  // 推理模型的下限 1024：实测 kimi-k2.8-preview / hy3 在 max_tokens=24 时
  // finish_reason=length、content 为空的空串（token 全烧在 reasoning_content 上）。
  const cap = isReasoningModel({ ...c, model: opts.model || c.model }) ? Math.max(base, 1024) : base
  const payload = {
    model: opts.model || c.model || 'deepseek-chat',
    // 10-31：中转网关会丢弃 system 角色 → 统一折进 user（c.systemRole='keep' 可关闭）
    messages: foldSystemIntoUser(messages, c),
    temperature: opts.temperature ?? (c.temperature ?? P.temperature ?? 0.92),
    max_tokens: cap,
    presence_penalty: 0.3,     // 防复读
    frequency_penalty: 0.2,
    stream: opts.stream === true,
    // 供应商私有参数（10-26）：如千问系的 { enable_thinking: false }。
    ...(c.params || {}),
    ...(opts.params || {}),
  }
  // ── reasoning（10-31）──────────────────────────────────────────────────
  // 优先显式 opts.reasoningEffort → 通道配置 c.reasoningEffort → 用途默认值。
  // 'off' 时发 thinking:{type:'disabled'}（部分供应商认这个），否则发 reasoning_effort。
  // 注意：这个网关对不认识的字段是静默忽略，不会报错 —— 所以发错了也看不出来，
  // 只能靠 diagnose 的"推理模型声明"那一条兜底。
  const effort = opts.reasoningEffort ?? c.reasoningEffort ?? P.effort
  if (effort === 'off') {
    payload.thinking = { type: 'disabled' }
  } else if (effort && effort !== 'auto') {
    payload.reasoning_effort = effort
  }
  return payload
}
function payload(messages, opts = {}) {
  return payloadOf(_cfg(), messages, opts)
}

// ── 通道熔断（10-31）────────────────────────────────────────────────────────
// 为什么需要：以前每次聊天都先撞一遍已经挂掉的主通道（默认 90s timeout），
// 一天几百轮就是几百次白等；同一家 429 恢复前也会被反复打。
// 规则：连续失败 FAIL_N 次 → 冷却 COOLDOWN_MS；冷却期内直接跳过这一级。
// 只对"确定性失败"（4xx/超时/连接拒绝）计入，成功立刻清零。
const FAIL_N = 3
const COOLDOWN_MS = 3 * 60_000
const BREAKER_FILE = () => dataPath('cache', 'llm-breakers.json')

function readBreakers() {
  try { return JSON.parse(fs.readFileSync(BREAKER_FILE(), 'utf8')) } catch { return {} }
}
function writeBreakers(o) {
  try {
    const f = BREAKER_FILE()
    fs.mkdirSync(f.slice(0, f.lastIndexOf('/')) || '.', { recursive: true })
    fs.writeFileSync(f, JSON.stringify(o))
  } catch {}
}
/** 这一级现在是否被熔断（冷却中）。 */
function isOpen(key, breakers) {
  const b = breakers[key]
  return !!(b && b.until && Date.now() < b.until)
}
/**
 * 把错误压成一行**能排障**的文字。
 *
 * 为什么要有它（2026-11-02 排查实录）：网关在并发压满时会直接 RST 掉连接，
 * Node fetch 抛的是 `TypeError: fetch failed` —— 真正的原因码（UND_ERR_SOCKET /
 * ECONNRESET / ETIMEDOUT）在 `e.cause.code` 里。老代码只记 `e.message`，
 * 于是日志上永远只有一句 `fetch failed`，看日志的人（包括我）只能靠推理反推。
 * 那次排查里我花了半小时才确认是 socket 被重置而不是超时/鉴权/模型问题。
 */
function describeErr(err) {
  const base = String(err?.message ?? err)
  const c = err?.cause
  const code = c?.code || c?.errno || ''
  const extra = []
  if (code) extra.push(code)
  if (c?.syscall) extra.push(c.syscall)
  if (c?.address) extra.push(c.address + (c?.port ? ':' + c.port : ''))
  if (c?.message && String(c.message) !== base) extra.push(String(c.message).slice(0, 80))
  const tail = extra.length ? ' [' + extra.join(' ') + ']' : ''
  return (base + tail).slice(0, 180)
}

/**
 * 是不是**连接层瞬时**失败（不是模型/鉴权/参数问题）。
 *
 * 这类失败的共同点：请求可能压根没到上游，或者到了但连接被中间层掐断 ——
 * 换一条连接重发一次大概率就好了。**它们不该被当成"这个通道坏了"**，
 * 因为通道本身是好的，坏的是一次 TCP 会话。
 *
 * 实测依据（2026-11-02）：网关 agent2api 在账号池并发压满时，
 * `ulimit -n=1024` 且只有 4 核，20 并发下稳定丢 3~5 个连接，
 * 客户端看到的就是 UND_ERR_SOCKET("other side closed") / ECONNRESET。
 */
const TRANSIENT_CODES = new Set([
  'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
])
function isTransient(err) {
  if (!err) return false
  if (err.reasoningOnly) return false          // max_tokens 给小了，重发没用
  if (err.transient === true) return true      // 下面自己打的标
  const code = err?.cause?.code || err?.code || ''
  if (TRANSIENT_CODES.has(String(code))) return true
  // undici 在 keep-alive 复用坏连接时给的是 "fetch failed" 且 cause 是 SocketError
  if (/fetch failed/i.test(String(err.message || '')) && err.cause) return true
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return false  // 超时不在此列，交给熔断
  return false
}

function bumpFail(key, err) {
  const all = readBreakers()
  const cur = all[key] || { fails: 0, until: 0, lastErr: '' }
  cur.lastErr = describeErr(err)
  // 瞬时连接失败**不计入熔断**：通道没坏，只是这一次的 TCP 会话被掐断了。
  // 计入的话，并发高峰几次抖动就会把好通道熔断 3 分钟，
  // 而熔断期间所有请求都跳过它 —— 于是"偶发抖动"被放大成"整段时间不可用"。
  if (isTransient(err)) {
    all[key] = cur
    writeBreakers(all)
    return cur
  }
  cur.fails = (Number(cur.fails) || 0) + 1
  // 失败够数就跳闸；每多失败一次多冷一会儿（最长 15 分钟）
  if (cur.fails >= FAIL_N) {
    const extra = Math.min(12 * 60_000, (cur.fails - FAIL_N) * 60_000)
    cur.until = Date.now() + COOLDOWN_MS + extra
  }
  all[key] = cur
  writeBreakers(all)
  return cur
}
function bumpOk(key) {
  const all = readBreakers()
  if (all[key] && (all[key].fails || all[key].until)) {
    delete all[key]
    writeBreakers(all)
  }
}
/** 给 /api/status 与 diagnose 看的熔断快照。 */
export { describeErr, isTransient }

export function breakerSnapshot() {
  const all = readBreakers()
  const out = []
  for (const [key, v] of Object.entries(all)) {
    out.push({ level: key, fails: v.fails || 0, openUntil: v.until && Date.now() < v.until ? v.until : null, lastError: v.lastErr || '' })
  }
  return out
}
function fbLog(line) {
  try { fs.appendFileSync(dataPath('llm-fallback.log'), new Date().toISOString() + ' ' + line + '\n') } catch {}
}

/**
 * 一次性拿全文。
 * 通道顺序：主通道 → fallback 链的每一级（跳过被熔断的）。
 * @param {object} [opts]
 * @param {boolean} [opts.noFallback] 只用主通道
 * @param {number}  [opts.timeoutMs]  单级超时（默认 90s）
 */
export async function chat(messages, opts = {}) {
  const main = _cfg()
  const levels = [{ ...main, __key: 'main' }]
  if (!opts.noFallback) for (let i = 0; i < _chain().length; i++) levels.push({ ..._chain()[i], __key: 'fb' + (i + 1) })

  const tryOne = async (c) => {
    // 连接层重试（2026-11-02 新增）。
    //
    // 为什么：fallback 链修的是"这个通道不行"，修不了"这一次连接被掐断"。
    // 主备都是一家网关时，连接层失败会在每一级各丢一次 —— 4 级 fallback 全灭，
    // 而网关明明是好的（实测：串行 30/30 成功，20 并发稳定丢 3~5 个）。
    // 这类失败重发一次就好，代价只是多一个 RTT，远小于"整段对话没回复"。
    //
    // 只对瞬时连接错误重试；HTTP 4xx/5xx 和"模型输出为空"都不重试
    // （那些重发一次结果一样，纯浪费钱）。
    const attemptOnce = async () => {
      const r = await fetch(endpointOf(c), {
        method: 'POST',
        headers: headersOf({ ...c, api_key: c.api_key || apiKey() }),
        body: JSON.stringify(payloadOf(c, messages, opts)),
        signal: AbortSignal.timeout(opts.timeoutMs || 90000),
      })
      if (!r.ok) throw Object.assign(new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`), { httpStatus: r.status })
      return r
    }
    const RETRIES = Number(opts.connRetries ?? 2)      // 瞬时连接失败额外重试次数
    let r
    for (let attempt = 0; ; attempt++) {
      try {
        r = await attemptOnce()
        break
      } catch (e) {
        // HTTP 状态错误：不重试（4xx/5xx 重发结果一样）
        if (e && e.httpStatus) throw e
        if (attempt < RETRIES && isTransient(e)) {
          // 120ms / 400ms 退避 + 抖动，避开同一瞬间的拥塞
          const wait = 120 * Math.pow(2, attempt) + Math.floor(Math.random() * 80)
          await new Promise((res) => setTimeout(res, wait))
          continue
        }
        // 重试用尽仍失败：标记为瞬时，让上层知道"通道没坏"
        if (isTransient(e)) { try { e.transient = true } catch {} }
        throw e
      }
    }
    const j = await r.json()
    const ch = j.choices?.[0] ?? {}
    const out = String(ch.message?.content ?? '').trim()
    if (!out) {
      // 10-31 实测：kimi / hy3 这类**推理模型**会先把 max_tokens 全烧在 reasoning_content 上，
      // finish_reason=length 而 content 是空串。旧代码一律当"LLM 返回空内容"抛，
      // 结果把它们误判成坏通道、还会进熔断 —— 其实是 max_tokens 给小了。
      const reasoning = String(ch.message?.reasoning_content ?? '')
      if (ch.finish_reason === 'length' && reasoning) {
        const e = new Error('推理模型把 max_tokens 烧在思考链上（' + reasoning.length + ' 字思考、正文 0 字）—— 需要更大的 max_tokens')
        e.reasoningOnly = true          // 标记：不算通道故障
        throw e
      }
      throw new Error('LLM 返回空内容')
    }
    // 直连通道自己记账（账本只扫 DSH 会话，扫不到这条路）
    try { recordDirectUsage(j.usage, { model: c.model, via: 'chat' }) } catch {}
    // 10-31：v4-pro 推理模式会吐原生 DSML 工具调用标记，没带 tools 时会泄漏成正文。
    // 兜底剥离；剥完是空的就抛错（宁可报错，也不能把尖括号垃圾当消息发出去）。
    const cleaned = stripDsml(out)
    if (!cleaned) throw new Error('模型只输出了工具调用标记，没有可发的内容')
    return cleaned
  }

  const breakers = readBreakers()
  const errs = []
  for (let i = 0; i < levels.length; i++) {
    const c = levels[i]
    const key = c.__key
    if (i > 0 && isOpen(key, breakers)) {
      errs.push(key + '：熔断中（跳过）')
      continue
    }
    try {
      const out = await tryOne(c)
      if (i > 0) {
        bumpOk(key)
        fbLog(`主通道失败 → 已用 ${key}（${c.model}）`)
      } else {
        bumpOk('main')
      }
      return out
    } catch (e) {
      const rec = bumpFail(key, e)
      errs.push(`${key}（${c.model || '?'}）：${describeErr(e).slice(0, 110)}`)
      if (i === 0) fbLog(`主通道失败(${describeErr(e).slice(0, 100)})，尝试备用链`)
    }
  }
  // 全都失败：把每一级的失败原因都带上，别只说"主备都失败"（排障时那句话等于没说）
  throw new Error('全部 ' + levels.length + ' 个 LLM 通道失败 → ' + errs.join('；'))
}

/** 流式：边收边吐增量文本（思考链外显 / 分句发送）。 */
export async function* chatStream(messages, opts = {}) {
  // 10-31：流式以前只走主通道、且不走熔断 —— 主通道挂了她就整段哑掉。
  // 现在：主通道失败时退到备用链，并且同样记熔断（流式的失败原因与 chat 一致）。
  const levels = [{ ..._cfg(), __key: 'main' }]
  if (!opts.noFallback) for (let i = 0; i < _chain().length; i++) levels.push({ ..._chain()[i], __key: 'fb' + (i + 1) })
  const breakers = readBreakers()
  let chosen = null
  let lastErr = null
  for (let i = 0; i < levels.length; i++) {
    const c = levels[i]
    if (i > 0 && isOpen(c.__key, breakers)) continue
    try {
      const r = await fetch(endpointOf(c), {
        method: 'POST',
        headers: headersOf({ ...c, api_key: c.api_key || apiKey() }),
        body: JSON.stringify(payloadOf(c, messages, { ...opts, stream: true })),
        signal: AbortSignal.timeout(opts.timeoutMs || 120000),
      })
      if (!r.ok) throw new Error(`LLM HTTP ${r.status}`)
      chosen = { r, key: c.__key, model: c.model }
      bumpOk(c.__key)
      break
    } catch (e) {
      lastErr = e
      bumpFail(c.__key, e)
    }
  }
  if (!chosen) throw new Error('流式：全部 ' + levels.length + ' 个通道失败 → ' + describeErr(lastErr).slice(0, 140))
  const r = chosen.r
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

/**
 * 原始调用：返回完整的 message 对象（含 tool_calls / reasoning），给工具调用循环用。
 * chat() 是它的"只要文本"简化版。
 * @returns {Promise<{message:object, text:string, usage:object, finishReason:string}>}
 */
export async function chatRaw(messages, opts = {}) {
  const levels = [{ ..._cfg(), __key: 'main' }]
  if (!opts.noFallback) for (let i = 0; i < _chain().length; i++) levels.push({ ..._chain()[i], __key: 'fb' + (i + 1) })
  const breakers = readBreakers()
  const errs = []
  for (let i = 0; i < levels.length; i++) {
    const c = levels[i]
    const key = c.__key
    if (i > 0 && isOpen(key, breakers)) { errs.push(key + '：熔断中'); continue }
    try {
      const payload = payloadOf(c, messages, opts)
      if (Array.isArray(opts.tools) && opts.tools.length) {
        payload.tools = opts.tools
        payload.tool_choice = opts.toolChoice || 'auto'
      }
      // 带 tools 时要关掉 thinking（实测 v4-pro 推理模式会和原生工具调用打架，吐 DSML）
      if (Array.isArray(opts.tools) && opts.tools.length) {
        payload.thinking = { type: 'disabled' }
        delete payload.reasoning_effort
      }
      const r = await fetch(endpointOf(c), {
        method: 'POST',
        headers: headersOf({ ...c, api_key: c.api_key || apiKey() }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeoutMs || 90000),
      })
      if (!r.ok) throw new Error('LLM HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200))
      const j = await r.json()
      const msg = j.choices?.[0]?.message || {}
      try { recordDirectUsage(j.usage, { model: c.model, via: 'raw' }) } catch (e) { swallow(e, 'llm:record') }
      bumpOk(key)
      return {
        message: { ...msg, content: stripDsml(String(msg.content ?? '')) },
        text: stripDsml(String(msg.content ?? '')),
        usage: j.usage || {},
        finishReason: j.choices?.[0]?.finish_reason || '',
      }
    } catch (e) {
      bumpFail(key, e)
      errs.push(key + '（' + c.model + '）：' + describeErr(e).slice(0, 110))
    }
  }
  throw new Error('全部 ' + levels.length + ' 个 LLM 通道失败 → ' + errs.join('；'))
}

/** 要求模型只回 JSON（用于写脚本/文案）。 */
export async function jsonChat(messages, schemaHint, opts = {}) {
  const sys = { role: 'system', content: '你只输出合法 JSON，不要 markdown 代码块，不要任何解释。\n字段结构：' + schemaHint }
  const raw = await chat([sys, ...messages], opts)
  const cleaned = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim()
  // v5 深度排查：这里原来是裸 JSON.parse —— 模型只要吐一句
  // "抱歉，我无法生成" 或半截 JSON，就抛到 async 顶层。
  // review / sing 都是**在她说话的主链路里**调它，抛出去就是整轮失败（她哑掉）。
  // 现在：先整体解析，失败就贪心抠第一个 {...} 再试，再失败返回 null（调用方本来就有兜底）。
  try { return JSON.parse(cleaned) } catch { /* 继续兜底 */ }
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) {
    try { return JSON.parse(m[0]) } catch { /* 继续兜底 */ }
  }
  try { swallow(new Error('jsonChat 解析失败：' + cleaned.slice(0, 120)), 'llm:jsonChat', { force: true }) } catch { /* ignore */ }
  return null
}
