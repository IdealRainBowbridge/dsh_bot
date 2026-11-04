// 三层记忆 —— dabot 骨架 brain/memory.py 的 JS 移植（SQLite+FTS5 → JSONL/JSON）。
//
//   · 情节 episodes  每次"看视频/分享/评论"的事件流（jsonl，append-only）
//   · 关系 facts     关于用户/网友的长期事实（去重）
//   · 世界 lore      她自己的设定与名场面
// 检索：2-gram 分词 + 关键词命中（十万条以内够用 —— dabot 的原则：
// 「别一开始就上向量库，人格才是瓶颈」）。
//
// v5 重构要点：
//   ① 记忆写入永远走 appendEpisode()，它做**跨进程互斥**（10+ 个命令进程会同时写）。
//   ② 轮转 rotateIfBig() 必须在文件锁内做"再确认"——旧版先 stat 再读全量再重写，
//      期间别的进程 append 的行会被整段覆盖掉（真实丢记忆）。
//   ③ 新增 rememberAudit()：干跑/被拦下的拟发言只进审计流水，绝不进对话记忆。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'
import { config } from './config.mjs'
import { normalizeMemoryText } from './normalize.mjs'
import { updateJson, acquireLock } from './atomic.mjs'

const EP_FILE = dataPath('episodes.jsonl')
const FACT_FILE = dataPath('facts.json')
// QQ 有自己的记忆空间：单独一个 episodes 文件（跟微信/B站分开，也方便以后单独做"自我迭代"）。
// 老数据还在主文件里，读取时两个文件一起读，所以换了位置也接得上。
const QQ_EP_FILE = dataPath('qq', 'episodes.jsonl')
// 微信也有自己的记忆空间，而且定位不同：那是"替用户干活"的工作记录，
// 不属于她的人格经历 —— 所以 recall() 默认不读它，绝不串进 QQ/B站/抖音的提示词。
const WECHAT_EP_FILE = dataPath('wechat', 'episodes.jsonl')
const LORE_FILE = dataPath('lore.json')

/**
 * 只读文件尾部的若干行（2026-11-02）。
 *
 * 为什么需要：全仓有多处「readFileSync 整个 episodes.jsonl，然后只看最后 3 条」。
 * 文件小的时候无感；她跑一年后文件到 ~10MB，而 qq-server 那几处**在回复主链路上**，
 * 等于每收一条消息就 parse 10MB。这是隐性 O(n²)，不是"文件有点大"那么简单。
 *
 * 做法：从文件末尾往前读最多 maxBytes 字节，丢掉可能被截断的第一行，
 * 取最后 n 行。最坏代价是 maxBytes（默认 64KB），与文件总大小无关。
 *
 * @param {string} file
 * @param {number} n 要最后几行
 * @param {number} [maxBytes] 最多读多少字节（默认 64KB）
 * @returns {string[]} 行（已 JSON.parse 的由调用方做）
 */
export function readTail(file, n, maxBytes = 64 * 1024) {
  const out = []
  let fd
  try {
    const st = fs.statSync(file)
    const start = Math.max(0, st.size - maxBytes)
    const len = st.size - start
    if (len <= 0) return out
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    let text = buf.toString('utf8')
    // 若不是从文件头开始读，第一行很可能是半截 —— 丢掉
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const lines = text.split('\n').filter((x) => x.trim())
    return lines.slice(-n)
  } catch {
    return out
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  fs.mkdirSync(dataPath(), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value, null, 1) + '\n')
  fs.renameSync(temp, file)
}

/** 极简分词：中文按 2-gram 切，英文按字符组 —— dabot memory.py _tokens 的移植。 */
export function tokens(text) {
  const out = []
  let buf = ''
  for (const ch of String(text ?? '')) {
    if (ch >= '\u4e00' && ch <= '\u9fff') {
      buf += ch
      if (buf.length >= 2) { out.push(buf); buf = buf.slice(-1) }
    } else {
      buf = ''
      if (/[a-zA-Z0-9]/.test(ch)) out.push(ch.toLowerCase())
    }
  }
  return out
}

// ---------- 情节（episodes） ----------

/** chatId 形如 qq:123456 → 'qq'。 */
export function platformOf(chatId) {
  return String(chatId || '').split(':')[0] || 'misc'
}

/** 平台对应的记忆文件：QQ / 微信 各自独立，B站/抖音 共用主文件。 */
export function episodeFile(platform) {
  if (platform === 'qq') return QQ_EP_FILE
  if (platform === 'wechat') return WECHAT_EP_FILE
  return EP_FILE
}

/** 记一条事件。role: user|assistant|event。summary 取前 120 字。
 *  platform 缺省时按 chatId 前缀推断（曾出过 54 条无平台标记的脏数据）。
 *  写入前做占位符归一（normalize.mjs）：裸的 `[分享视频]` 会让模型以为"内容丢了"。 */
/**
 * 明显是"自测/调试话术"的文本 —— 不该进她的记忆库（10-31 事故）。
 * 事故经过：调试时发的「【测试】链路已修复」「打字标识测试」「融合测试：这条应该双写 brain」
 * 全被 remember 记进去，她后来当成真实对话读，回复里冒出"我这边测试都跑完了"——
 * 对用户说开发语言，人格直接破功。
 * 这里挡的是**明确的测试话术**，不是正常聊天（"测试"两个字单独出现不算）。
 */
const SELFTEST_PATTERNS = [
  /^【(测试|调试|验证)[^】]*】/,
  /打字标识(测试|部署)/,
  /^(融合测试|双写验证|链路验证|端到端验证)/,
  /这条是验证消息/,
  /^【(打字标识|联调)/,
  /(P0|P1|P2) 修复/,
  /^收到，确认记录：[sS]*事件类型.*（刚发生）/,
]

function looksLikeSelfTest(t) {
  const s = String(t || '').trim()
  if (!s) return false
  // 短句里带"测试"但没有具体内容 → 多半是自测；正常聊天很少这么开头
  return SELFTEST_PATTERNS.some((re) => re.test(s))
}

export function remember(platform, chatId, userId, role, text, extra = {}) {
  const p = String(platform || platformOf(chatId) || 'misc')
  const t = normalizeMemoryText(String(text ?? ''))
  // 10-31：自测话术不进记忆（除非显式 allowSelfTest，给真要做回归的测试用）
  if (!extra.allowSelfTest && looksLikeSelfTest(t)) {
    try { swallow(new Error('self-test text rejected'), 'memory:remember-selftest-guard') } catch (e) { swallow(e, 'tools/lib/memory.mjs:97') }
    return null
  }
  const rec = {
    ts: Date.now(), platform: p, chatId, userId, role,
    text: t, summary: t.slice(0, 120),
    // isGroup：群聊行。群里的"user"是群友不是用户，混进 recallAll 会被渲染成「用户：…」，
    // 于是她在私聊里把群友的话当用户的话记（10-26 实锤：把群友"叫爸爸"当成用户说的）。
    ...(extra.isGroup ? { isGroup: true } : {}),
    // kind: 'push' = 她主动推给用户的消息（视频分享/提醒）。仍然要记（不然她不知道自己刚说过），
    // 但 recent() 会把它当"广播"而不是"对话"，避免把对话窗口挤满（10-26）。
    ...(extra.kind ? { kind: String(extra.kind) } : {}),
  }
  // P0-4 (2026-11-03): timestamp-shape stamp on write (evidence only, no rewrite).
  if (rec.ts > Date.now() + 5 * 60_000 || rec.ts % 1000 === 0) {
    rec._tflags = [(rec.ts > Date.now() + 5 * 60_000 ? 'future' : ''), (rec.ts % 1000 === 0 ? 'alms' : '')].filter(Boolean).join('|')
  }
  const file = episodeFile(p)
  const okWrite = appendEpisode(file, rec)
  if (!okWrite) { swallow(new Error('episode append failed'), 'memory:append-failed'); return null }
  rotateIfBig(file)
  // dual-write brain (10-31 fuse)
  try {
    import('./brain-bridge.mjs').then((B) => B.rememberToBrain(rec)).catch(() => {})
  } catch (e) { swallow(e, 'tools/lib/memory.mjs:117') }
  // v5：返回写入的那一行。以前返回 undefined，调用方无法确认"到底记没记住"，
  // 只能在日志里打一句"记上了"——那句可能不真。
  return rec
}

/**
 * 追加一行到 jsonl —— **跨进程安全**。
 *
 * 为什么不能直接 appendFileSync：Linux 上单次 write < PIPE_BUF 的 O_APPEND 是原子的，
 * 但 Node 的 appendFileSync 可能分多次 write（大对象），多进程同时写就会交错成半行，
 * 读端 JSON.parse 失败 → 那条记忆**静默消失**。这里用 O_APPEND 一次写完整的
 * "一行 + 换行"，并在失败时重试一次。
 */
function appendEpisode(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const line = Buffer.from(JSON.stringify(rec) + '\n', 'utf8')
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd = null
    try {
      fd = fs.openSync(file, 'a')
      fs.writeSync(fd, line, 0, line.length)
      return true
    } catch (e) {
      if (attempt === 1) { swallow(e, 'memory:append'); return false }
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    }
  }
  return false
}

/**
 * 极简跨进程锁：O_EXCL 建锁文件，超过 staleMs 视为死锁自动清掉。
 * 只用于"轮转"这种读全量再重写的危险操作，普通 append 不需要锁。
 */
function withFileLock(lockPath, fn, { staleMs = 60_000, waitMs = 3_000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      try { return fn() } finally { try { fs.rmSync(lockPath, { force: true }) } catch { /* ignore */ } }
    } catch (e) {
      if (e.code !== 'EEXIST') { swallow(e, 'memory:lock'); return fn() }
      // 陈旧锁（持有进程已死或超时）→ 清掉重试
      try {
        const st = fs.statSync(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) { fs.rmSync(lockPath, { force: true }); continue }
      } catch { /* 锁文件刚被释放 */ }
      if (Date.now() > deadline) {
        // 等不到锁就不轮转 —— 宁可文件大一点，也不能冒丢数据的风险
        swallow(new Error('rotate lock timeout'), 'memory:lock-timeout')
        return null
      }
      const until = Date.now() + 40
      while (Date.now() < until) { /* busy wait 40ms，轮转很少发生 */ }
    }
  }
}

// 单文件太大时按月份分片（照 dsh-world「按天归档 + 原文全留」的思路，只是粒度用月）。
// 分片命名 episodes-YYYY-MM.jsonl，放在同一目录；读取端会把它们一起读（见 shardsOf）。
const ROTATE_BYTES = 6 * 1024 * 1024

function shardName(base, stamp) {
  const d = new Date(stamp)
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return path.join(path.dirname(base), `episodes-${ym}.jsonl`)
}

/** 把 base 里"不是本月"的行搬到按月分片，只留本月在主文件。失败就原样不动。 */
function rotateIfBig(base) {
  try {
    if (!fs.existsSync(base) || fs.statSync(base).size < ROTATE_BYTES) return
    // v5：轮转是"读全量 → 重写"的危险操作，必须在跨进程锁里做，并在锁内**再确认一次**
    // 大小（排队期间别的进程可能已经轮转过了）。旧版没有锁：多进程同时轮转时，
    // 后完成的那次会用自己手里的旧快照覆盖掉先完成者的结果 —— 真实丢记忆。
    withFileLock(base + '.rotate.lock', () => {
      if (!fs.existsSync(base) || fs.statSync(base).size < ROTATE_BYTES) return
      rotateNow(base)
    })
  } catch (e) { swallow(e, 'tools/lib/memory.mjs:153') }
}

/**
 * 主文件当月最多留多少条（2026-11-02）。
 *
 * 为什么需要：原来的 rotateNow 只把"**不是本月**"的行搬走。
 * 如果她这个月自己写了 >6MB（B站/抖音/上网每天都在记），主文件会永远停在 6MB 以上，
 * 而且每次触发 rotateIfBig 都是白跑一遍：读全量 → 发现没东西可搬 → 重写同内容。
 * 这既无上限、又是每天一次的无用功。
 *
 * 现在：本月行也按条数封顶，超出的搬到 `episodes-YYYY-MM-part2.jsonl`。
 * 主文件永远 ≈ MONTH_KEEP 条，读取端的"全量读"也就有界了。
 */
const MONTH_KEEP = 4000

function rotateNow(base) {
  {
    const lines = fs.readFileSync(base, 'utf8').split('\n').filter(Boolean)
    const now = new Date(), ymNow = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const keep = [], move = new Map()
    const monthRows = []                     // 本月行，按原顺序暂存
    for (const line of lines) {
      let r = null
      try { r = JSON.parse(line) } catch (e) { swallow(e, 'tools/lib/memory.mjs:139') }
      const ts = Number(r?.ts) || 0
      const d = new Date(ts || Date.now())
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!ts) { keep.push(line); continue }              // 没有时间戳的：不搬（可能是手写的）
      if (ym === ymNow) { monthRows.push(line); continue }
      if (!move.has(ym)) move.set(ym, [])
      move.get(ym).push(line)
    }
    // 本月行：只留最近的 MONTH_KEEP 条，其余进 part2
    if (monthRows.length > MONTH_KEEP) {
      const overflow = monthRows.slice(0, monthRows.length - MONTH_KEEP)
      keep.push(...monthRows.slice(-MONTH_KEEP))
      move.set(ymNow + '-part2', overflow)
    } else {
      keep.push(...monthRows)
    }
    for (const [ym, rows] of move) {
      const target = path.join(path.dirname(base), `episodes-${ym}.jsonl`)
      fs.appendFileSync(target, rows.join('\n') + '\n')
    }
    // 先写分片再截断主文件：中途崩溃最多重复，不会丢
    fs.writeFileSync(base, keep.join('\n') + (keep.length ? '\n' : ''))
  }
}

/** 主文件 + 它的所有按月分片。 */
export function shardsOf(base) {
  const dir = path.dirname(base)
  const out = [base]
  try {
    for (const f of fs.readdirSync(dir)) {
      // 2026-11-02：加上 part2（当月超量分片），否则搬过去的行读不回来
      if (/^episodes-\d{4}-\d{2}(-part2)?\.jsonl$/.test(f)) out.push(path.join(dir, f))
    }
  } catch (e) { swallow(e, 'tools/lib/memory.mjs:164') }
  return out
}

/**
 * 读记忆行。
 * @param {string} chatId 指定会话；传空串表示"全量"（回忆/统计用）
 * @param {{includeWechat?: boolean}} opts 全量读取时是否带上微信（默认不带）
 */
function readRows(chatId, opts = {}) {
  const bases = chatId
    ? [...new Set([EP_FILE, episodeFile(platformOf(chatId))])]
    : [EP_FILE, QQ_EP_FILE, ...(opts.includeWechat ? [WECHAT_EP_FILE] : [])]
  const files = []
  for (const b of bases) files.push(...shardsOf(b))
  const rows = []
  for (const file of files) {
    let lines = []
    try { lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) } catch { continue }
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if (!chatId) { rows.push(r); continue }
        if (r.chatId === chatId) rows.push(r)
      } catch (e) { swallow(e, 'tools/lib/memory.mjs:188') }
    }
  }
  rows.sort((a, b) => Number(a.ts) - Number(b.ts))
  return rows
}

/** 老数据里的推送行（还没有 kind 字段时写的）——开头就是这类标签的当广播看。 */
const LEGACY_PUSH = /^【(?:B站|哔哩|抖音|微信|视频|分享|提醒|QQ)分享】/

/** 最近 n 条对话（按 chatId 过滤，时间正序返回）。返回 {role, content} 格式，供 LLM 直接使用。
 *  ⚠️ 只放 user/assistant（10-25 修的 bug）：抖音那边会把"刷到某条视频"记成 role=event 的流水，
 *  混进 messages 里会被模型接口直接拒掉（HTTP 422 unknown variant `event`）——
 *  抖音 interact 因此整条链路一条评论都生成不出来。
 *
 *  ══════════════════════════════════════════════════════════════════════
 *  2026-11-05：旧文件读不到时，回退到新脑的情景库
 *  ══════════════════════════════════════════════════════════════════════
 *  实测（生产容器）：`/home/dsh/.data/qq/episodes.jsonl` **不存在**，
 *  而同一段对话完完整整躺在 `brain/ep/2026-11.jsonl`（42 条，带 at/atIso/role）。
 *  于是 `recent()` 返回 0 行 → 她读不到任何历史 → 每轮都像第一次说话，
 *  日志里反复打「记忆里没有用户的消息 → 按刚聊过处理」。
 *
 *  这不是"新功能没做"，是**两套存储的读取端没接上**：
 *  写入侧 `brain.onEvent()` 一直在存（旧路径 memory.remember 也双写），
 *  但读取侧只有旧路径的读法。容器重建/清盘后旧文件没了，新库还在，
 *  于是"记忆突然全没了"——而数据其实一条没丢。
 *
 *  回退规则（只在旧库**完全读不到对话**时触发，不做合并）：
 *    · 不做合并的理由：两套库里同一条对话会出现两次，合并要按内容去重，
 *      而"同一句话说了两遍"在真实对话里是**可能**的 —— 去重会误删真实重复。
 *    · 触发条件用"旧库 0 行"而不是"旧库比新库少"：后者会让她在两边都有数据时
 *      看到一份拼接的、顺序错乱的对话，比缺失更糟。
 */
export function recent(chatId, n = 8) {
  const rows = readRows(chatId).filter(r => r.role === 'user' || r.role === 'assistant')
  // 10-26 用户报"记忆错乱"：她那边的"最近聊过"里塞满了自己推的视频（她一次能连推 7 条
  // 【B站分享】），真正的对话被挤出窗口 —— 回复起来就像不记得刚才说过什么。
  // 只要对话本身够多，就把推送（kind:'push'，以及打标记之前的老数据）排除在外；
  // 对话太少时仍然全给，别让她失忆。
  // 门槛：对话至少占窗口一半（且不少于 3 条）才把推送滤掉 —— 聊天很少时推送照给，别让她失忆。
  const need = Math.max(3, Math.ceil(n / 2))
  const convo = rows.filter(r => r.kind !== 'push' && !LEGACY_PUSH.test(String(r.text || '')))
  const pool = convo.length >= need ? convo : rows
  const out = pool.slice(-n).map(r => ({ role: r.role, content: r.text, at: r.ts, kind: r.kind }))
  if (out.length) return out
  // 旧库空 → 回退到新脑（见上面那段注释）
  try {
    const fb = recentFromBrain(chatId, n)
    if (fb.length) return fb
  } catch (e) { swallow(e, 'memory:recent:brain-fallback') }
  return out
}

/**
 * 从 `brain/ep/*.jsonl` 还原「最近的对话行」。
 *
 * 为什么需要单独一段而不是复用 brain/recall：recall 是**按相关性检索**，
 * 它给的是"和这句话有关的记忆"；这里要的是"**按时间顺序的最近几条**"。
 * 两个问题不同，混用会让 recent 变成"检索结果"——那样她每轮读到的上下文
 * 都在变，反而更不连贯。
 *
 * 字段映射（brain 的 episode → 对话行）：
 *   ep.act  'say'  + who.others[0].kind==='owner' → role: 'user'
 *   ep.act  'say'  + who.others 为空（她说的）    → role: 'assistant'
 *   其它 act（action/observe/promise/feel）       → 跳过（不是对话）
 *   at → at（毫秒时间戳，recent 的时间前缀靠它）
 *
 * 内容用 `quote`（原话）而不是 `gist`（摘要）：上下文里给她摘要，
 * 她会照着摘要的措辞说话，读起来像在复述笔记。
 */
function recentFromBrain(chatId, n = 8) {
  const dir = dataPath('brain', 'ep')
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort() } catch { return [] }
  if (!files.length) return []
  // 只读最近两个月的分片：跨月时上个月月末的对话也要能接上
  const rows = []
  for (const f of files.slice(-2)) {
    let lines = []
    try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean) } catch { continue }
    for (const line of lines) {
      let ep
      try { ep = JSON.parse(line) } catch { continue }
      if (!ep || ep.where?.chat !== chatId) continue
      if (ep.act !== 'say') continue
      const others = Array.isArray(ep.who?.others) ? ep.who.others : []
      const isOwner = others.some((w) => w.kind === 'owner')
      const role = isOwner ? 'user' : 'assistant'
      const text = String(ep.quote || ep.gist || '').trim()
      if (!text) continue
      rows.push({ role, content: text, at: Number(ep.at || 0), kind: '' })
    }
  }
  rows.sort((a, b) => Number(a.at) - Number(b.at))
  return rows.slice(-n)
}


/** 该会话里「用户最后一次说话」「她最后一次说话」的时间戳（给时间常驻层用）。 */
export function lastByRole(chatId) {
  const rows = readRows(chatId)
  let lastUser = 0, lastAssistant = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (!lastUser && r.role === 'user') lastUser = Number(r.ts) || 0
    if (!lastAssistant && r.role === 'assistant') lastAssistant = Number(r.ts) || 0
    if (lastUser && lastAssistant) break
  }
  return { lastUser, lastAssistant }
}

/**
 * 统一时序回忆 —— 把**不是本通道**的全部真实记录按时间拼成一份（照 dsh-world 的
 * src/history.ts renderHistory：一行一条、带本地时间、带会话标记、从新到旧）。
 *
 * 为什么合并：以前这里是两个补丁块（crossChannel 管"别的平台的对话"、ownRecent 管"她自己做的事"），
 * 各自过滤、各自取前几条，互相挤名额，还是盖不全 —— 10-25 连栽两次：
 *   ① QQ 说"在抖音看滑肉视频" → 抖音问滑肉她说"不知道"；
 *   ② 上网写了三段小说 → QQ 问起她说"写小说？没有呀"。
 * 病根是"按通道切碎的存储"，补丁只能在展示层兜。这里改成一次性全量、按时间排序、统一渲染。
 *
 * @param {string} chatId 当前通道的 chatId（这些行由 recent() 单独给，这里排除掉避免重复）
 * @param {{hours?: number, max?: number, perRow?: number, now?: number}} opts
 */
export function recallAll(chatId, opts = {}) {
  const { hours = 12, max = 12, perRow = 90, now = Date.now() } = opts
  const cutoff = now - hours * 3600_000
  const rows = readRows('').filter(r =>
    r.chatId !== chatId
    && r.isGroup !== true                           // 群聊行不进"最近真实发生的事"：群里说话的是群友，不是用户
    && r.platform !== 'wechat'                       // 微信是替用户干活的工作记录，不进人格记忆
    && (r.role === 'user' || r.role === 'assistant')
    && (r.role === 'assistant' || r.userId === String(config().owner?.qq || ''))  // multi-user isolation (10-31)
    // ⚠️ 10-27：她自己的**主动搭话**（kind:'push'）不算"真实发生的事"。
    // 它本来只是"我随口说的一句"，混进来以后就变成"我今天确实在翻南京小吃"的证据 ——
    // 于是 B站/抖音 的提示词里也满是"南京/饿"，她自己都开始说"我今早查白饭查了四轮"。
    // 广播只该留在本通道（她的记忆），不该当跨平台的经历反复注入。
    && r.kind !== 'push'
    && !LEGACY_PUSH.test(String(r.text || ''))
    && Number(r.ts) >= cutoff
    && String(r.text || '').trim())
  if (!rows.length) return { lines: [], count: 0, newest: 0 }
  // 去重（同一句被多通道记过）+ 挨个通道限流（一个话痨通道不能吃掉全部名额）
  const seen = new Set()
  const byChat = new Map()
  for (const r of rows) {
    const k = String(r.text).replace(/\s+/g, '').slice(0, 30)
    if (seen.has(k)) continue
    seen.add(k)
    const c = String(r.chatId || r.platform)
    if (!byChat.has(c)) byChat.set(c, [])
    byChat.get(c).push(r)
  }
  const per = Math.max(2, Math.ceil(max / byChat.size))
  const picked = []
  for (const arr of byChat.values()) picked.push(...arr.slice(-per))
  // 按时间正序，最后的 max 条 → 渲染时再翻成"从新到旧"（跟她读记忆的习惯一致）
  picked.sort((a, b) => Number(a.ts) - Number(b.ts))
  const finalRows = picked.slice(-max)
  const where = (r) => {
    const p = r.platform
    const base = p === 'qq' ? 'QQ' : p === 'douyin' ? '抖音' : p === 'bilibili' ? 'B站'
      : p === 'web' ? '上网' : p === 'wechat' ? '微信' : String(p || '别处')
    return r.isGroup ? base + '群' : base   // 群聊单独标出来：她得知道这句是"群里谁说的"
  }
  const hhmm = (ts) => {
    const d = new Date(Number(ts))
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  const lines = finalRows.slice().reverse().map(r => {
    const text = String(r.text).replace(/\s+/g, ' ').replace(/^[（(]|[）)]$/g, '').slice(0, perRow)
    // ⚠️ 10-26 修「认贼作父」的根子就在这一行：以前所有 user 行一律渲染成「用户：」，
    // 于是群友的话进了私聊记忆就变成"用户说的"，她连"叫爸爸"都当成用户说的。
    // 现在：群聊行的 user 是**群友**，文本自带「昵称：」前缀（qq-server 写入时加的），原样呈现；
    // 只有真正的一对一私聊行才配得上「用户：」。
    if (r.role === 'assistant') return `${hhmm(r.ts)} [${where(r)}] 我：${text}`
    return r.isGroup
      ? `${hhmm(r.ts)} [${where(r)}] ${text}`
      : `${hhmm(r.ts)} [${where(r)}] 用户：${text}`
  })
  return { lines, count: lines.length, newest: Number(finalRows.at(-1)?.ts || 0) }
}

/**
 * 全文检索她自己的一生（`bot mem grep 关键词`）。
 * 照 dsh-world 的思路：不做向量库，靠"原文全留 + 按原话找"。
 */
export function grepEpisodes(pattern, { days = 0, limit = 30, role = '' } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern || ''), 'i')
  const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0
  const rows = readRows('').filter(r =>
    r.platform !== 'wechat'
    && Number(r.ts) >= cutoff
    && (!role || r.role === role)
    && (re.test(String(r.text || '')) || re.test(String(r.summary || ''))))
  return rows.slice(-limit).map(r => ({
    ts: r.ts, platform: r.platform, chatId: r.chatId, role: r.role,
    text: String(r.text || '').replace(/\s+/g, ' ').slice(0, 300),
  }))
}

/** 关键词回忆：命中 >7 天前的旧事（用来「主动想起」）。 */
export function recall(query, n = 2, minDays = 7, opts = {}) {
  const qs = tokens(query).filter(w => w.length > 1)
  if (!qs.length) return []
  const cutoff = Date.now() - minDays * 86400_000
  const hits = []
  for (const r of readRows('', opts)) {
    // 微信是工作记录，不进人格回忆（老数据也在主文件里，这里一并挡掉）
    if (!opts.includeWechat && r.platform === 'wechat') continue
    if (r.role !== 'user' || Number(r.ts ?? 0) >= cutoff) continue
    const grams = new Set(tokens(r.summary + r.text))
    let hitCount = 0
    for (const q of qs) if (grams.has(q)) hitCount++
    if (hitCount > 0) hits.push({ hitCount, summary: r.summary, ts: r.ts })
  }
  hits.sort((a, b) => b.hitCount - a.hitCount || a.ts - b.ts)
  return hits.slice(0, n).map(h => h.summary)
}

/** 随机想起一条旧事（没有线索时的「被动回忆」）。 */
export function randomOld(days = 7, random = Math.random, opts = {}) {
  const cutoff = Date.now() - days * 86400_000
  const pool = []
  for (const r of readRows('', opts)) {
    if (!opts.includeWechat && r.platform === 'wechat') continue
    if (r.role === 'user' && Number(r.ts ?? 0) < cutoff) pool.push(r.summary)
  }
  if (!pool.length) return []
  return [pool[Math.floor(random() * pool.length)]]
}

// ---------- 关系（facts） ----------

export function addFact(userId, fact) {
  const all = readJson(FACT_FILE, {})
  const list = new Set(all[userId] ?? [])
  list.add(String(fact))
  all[userId] = [...list].slice(-50)
  writeJson(FACT_FILE, all)
}

/**
 * 用户事实（owner-facts.mjs 专用）：`key|值|时间|原话`。
 * 同一个 key 只留最新一条 —— "吃了烧鸭"被"吃了面"覆盖，不会两条并列让她自己挑。
 */
export const OWNER_BUCKET = 'owner'
export function addOwnerFact(line) {
  const all = readJson(FACT_FILE, {})
  const key = String(line).split('|')[0]
  const list = (all[OWNER_BUCKET] ?? []).filter(x => !String(x).startsWith(key + '|'))
  list.push(String(line))
  all[OWNER_BUCKET] = list.slice(-40)
  writeJson(FACT_FILE, all)
}

export function facts(userId, max = 30) {
  const list = readJson(FACT_FILE, {})[userId] ?? []
  return list.slice(-max)
}

// ---------- 世界（lore） ----------
// lore 分两池（10-24 设计）：
//   · 价值观（评分标尺/风控教训/边界取舍这类）—— 永久保留，常驻注入提示词
//   · 兴趣（口味）—— FIFO 200，口味会变，老兴趣自然让位
// 按 tag 区分：「兴趣」标签进兴趣池，其余都算价值观。

const isInterest = (x) => x.kind === 'interest' || x.tag === '兴趣'
// 10-27：她自己的**排障笔记**（"Bing URL 多带一个 &count=15"、"搜狐正文 2390 字"）以前也进
// 「价值观」池，被当成人生信条每轮注入 —— 于是她在 B站 评论里说"我今早刚吃过记忆力不够的苦"。
// 运维归运维，人格归人格：tag 命中这些词的单独一池，prompt 不注入。
const OPS_TAGS = new Set(['运维', '排障', '调试', '工具', 'bug', 'Bug', 'BUG', '工程'])
export const isOps = (x) => x.kind === 'ops' || OPS_TAGS.has(String(x.tag))

/** 主题键：拿前 12 个字当"同一件事"的粗略签名（"南京菜单定稿…" × 10 → 一个键）。 */
function topicKey(text) {
  return String(text ?? '').replace(/[「」『』（）()《》【】\s·:：,，。.!！?？]/g, '').slice(0, 12)
}

const CJK = /[\u4e00-\u9fa5]{2,6}/g
const tokensOf = (t) => new Set(String(t ?? '').match(CJK) || [])
/** 带日期的都是干活流水（"10-27 16:05 统计了…"），不是价值观 —— 单独一池，不注入。 */
export const isDatedLog = (t) => /^\s*\d{1,2}-\d{1,2}\s/.test(String(t ?? ''))

/**
 * 主题封顶（10-27）：同一个主题写太多次就只留最新的 keep 条，其余标 superseded。
 * 真实情况：她 10-25 夜里为了"南京菜单"连写 25 条近义条目，全都进了价值观池，
 * 于是每轮注入都在提醒她"我在研究南京小吃"。这不是记忆，是自己给自己下的暗示。
 * 判定用"跨条目高频词"而不是写死南京 —— 换任何主题（番、店、人）都自动生效。
 */
export function loreThemeCap(list, { keep = 2, minCount = 4, passes = 5 } = {}) {
  let cur = list
  for (let pass = 0; pass < passes; pass++) {
    const next = loreThemeCapOnce(cur, { keep, minCount })
    if (next === cur) break
    cur = next
  }
  return cur
}

function loreThemeCapOnce(list, { keep = 2, minCount = 4 } = {}) {
  const plainOf = (arr) => arr.filter(x => !isInterest(x) && !isOps(x) && x.kind !== 'work' && x.kind !== 'superseded')
  let cur = list

  // 第一道：跨条目高频词封顶（"盐水鸭"这种词出现在 4 条以上 → 只留最新 keep 条）
  const pool = plainOf(cur)
  const freq = new Map()
  for (const x of pool) for (const t of tokensOf(x.text)) freq.set(t, (freq.get(t) || 0) + 1)
  const hotSet = new Set([...freq].filter(([, n]) => n >= minCount).map(([t]) => t))
  if (hotSet.size) {
    const seen = new Map()
    const drop = new Set()
    for (let i = pool.length - 1; i >= 0; i--) {
      const x = pool[i]
      const toks = [...tokensOf(x.text)].filter(t => hotSet.has(t)).sort((a, b) => freq.get(b) - freq.get(a))
      if (!toks.length) continue
      const main = toks[0]
      const n = seen.get(main) || 0
      if (n >= keep) drop.add(x)
      else seen.set(main, n + 1)
    }
    if (drop.size) cur = cur.map(x => (drop.has(x) ? { ...x, kind: 'superseded', supersededAt: Date.now() } : x))
  }

  // 第二道：字面高度重合也算同一件事（同一个意思换九种说法，高频词只收得住一部分）
  const bi = (t) => {
    const s = String(t ?? '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    const out = new Set()
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const plain2 = plainOf(cur)
  const keptNew = []
  const drop2 = new Set()
  for (let i = plain2.length - 1; i >= 0; i--) {
    const a = bi(plain2[i].text)
    if (!a.size) { keptNew.push(plain2[i]); continue }
    const dup = keptNew.some((k) => {
      const b = bi(k.text)
      let inter = 0
      for (const g of a) if (b.has(g)) inter++
      return inter / (a.size + b.size - inter) >= 0.55
    })
    if (dup) drop2.add(plain2[i])
    else keptNew.push(plain2[i])
  }
  if (!drop2.size) return cur
  return cur.map(x => (drop2.has(x) ? { ...x, kind: 'superseded', supersededAt: Date.now() } : x))
}

export function addLore(tag, text) {
  // v5：lore 有 6 个写入者（memory / dream / wander / index.js / CLI）。
  // 旧写法 readJson → push → writeJson 是"整份覆盖"：两个进程同时写，
  // 后完成的那次用自己手里的旧快照把对方的条目冲掉 —— 丢的是她的设定与名场面。
  // 现在在**锁内重新读磁盘**再合并，并且合并后统一做主题封顶。
  const kind = OPS_TAGS.has(String(tag)) ? 'ops' : (String(tag) === '兴趣' ? 'interest' : (isDatedLog(text) ? 'work' : 'value'))
  let added = false
  const r = updateJson(LORE_FILE, (cur) => {
    const list = Array.isArray(cur) ? cur : []
    const item = { tag: String(tag), text: String(text), ts: Date.now(), kind }
    // ⚠️ 10-27 止损：同一主题已经写过 2 次以上 → 不再新增，只把最后一条换成新的并记 n。
    if (kind === 'value' || kind === 'interest') {
      const key = topicKey(text)
      const same = list.filter(x => !isOps(x) && topicKey(x.text) === key)
      if (same.length >= 2) {
        const last = same[same.length - 1]
        last.text = String(text)
        last.ts = Date.now()
        last.n = Number(last.n || 1) + 1
        return list
      }
    }
    list.push(item)
    added = true
    const capped = loreThemeCap(list)
    const values = capped.filter(x => !isInterest(x) && !isOps(x) && x.kind !== 'work' && x.kind !== 'superseded')
    const work = capped.filter(x => x.kind === 'work' || x.kind === 'superseded').slice(-120)
    const interests = capped.filter(isInterest)
    const ops = capped.filter(isOps).slice(-60)
    return [...values, ...interests.slice(-200), ...work, ...ops].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
  }, { fallback: [], mode: 0o644 })
  if (!r.ok) { try { swallow(new Error('lore write failed'), 'memory:addLore') } catch { /* ignore */ } }
  return added ? r.value : undefined
}

export function lore(tag) {
  const list = readJson(LORE_FILE, [])
  return (tag ? list.filter(x => x.tag === tag) : list).map(x => x.text)
}

/** 价值观池（长期观念/标尺，永久保留）—— 提示词常驻。运维笔记/干活流水/被折叠的重复项都不进这池。 */
export function loreValues(max = 8) {
  return readJson(LORE_FILE, [])
    .filter(x => !isInterest(x) && !isOps(x) && x.kind !== 'work' && x.kind !== 'superseded')
    .slice(-max).map(x => x.text)
}

/** 运维/排障池 —— 只给 `mem lore` 看，不注入人格（她要查也能查得到）。 */
export function loreOps(max = 20) {
  return readJson(LORE_FILE, []).filter(isOps).slice(-max).map(x => x.text)
}

/** 兴趣池：最近 24 条里随机抽 max 条（每次聊到的话题不完全一样）。 */
export function loreInterests(max = 3, random = Math.random) {
  const tail = readJson(LORE_FILE, []).filter(isInterest).slice(-24)
  if (tail.length <= max) return tail.map(x => x.text)
  const picked = new Set()
  let guard = 0
  while (picked.size < max && guard++ < 50) picked.add(Math.floor(random() * tail.length))
  return [...picked].map((i) => tail[i].text)
}

/** 她自己养成的兴趣口味 → 2-gram 池。feed/watch 选题时用它做动态偏好加权，
 *  打通「看到→记住→想再看」的进化闭环（静态 preferences 是用户给的起点，口味自己长）。 */
export function interestGrams(n = 24) {
  const grams = new Set()
  for (const item of readJson(LORE_FILE, []).filter(isInterest).slice(-n)) {
    for (const g of tokens(item.text)) if (g.length >= 2) grams.add(g)
  }
  return grams
}

/** 一段文本与兴趣池的重合度（命中 2-gram 个数）。 */
export function interestScore(haystack, grams) {
  if (!grams || !grams.size) return 0
  const hs = new Set(tokens(haystack))
  let hits = 0
  for (const g of grams) if (hs.has(g)) hits += 1
  return hits
}

// ---------- 归档 ----------

/** 把超过 days 的旧事件挪到 <file>.archive.jsonl（不删，想考古随时翻），
 *  主文件只留近期 —— recall/最近对话的检索池保持干净。各常驻服务启动时调用。 */
export function sweepEpisodes(days = 90) {
  const cutoff = Date.now() - days * 86400_000
  let archived = 0
  for (const file of [EP_FILE, QQ_EP_FILE, WECHAT_EP_FILE]) {
    // 2026-11-03 并发修复（评审①第 6 条）：归档是"读全量→分拣→重写主文件"，
    // 必须与 appendEpisode 用同一把跨进程锁（rotateIfBig 丢记忆事故的同族——
    // 那次修了轮转没修归档，同一把刀还插在另一个地方）。拿不到锁就跳过这一轮：
    // sweep 是例行清理，下次心跳还会来，绝不和写入者抢。
    const rel = acquireLock(file, { waitMs: 0 })
    if (!rel) continue
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      if (lines.length <= 1) continue
      const keep = [], old = []
      for (const line of lines) {
        try { (Number(JSON.parse(line).ts ?? 0) >= cutoff ? keep : old).push(line) } catch { keep.push(line) }
      }
      if (!old.length) continue
      fs.appendFileSync(file.replace(/\.jsonl$/, '') + '.archive.jsonl', old.join('\n') + '\n')
      fs.writeFileSync(file, keep.length ? keep.join('\n') + '\n' : '')
      archived += old.length
    } catch (e) { swallow(e, 'tools/lib/memory.mjs:561') }
    finally { try { rel() } catch { /* ignore */ } }
  }
  return archived
}

// ---------- 审计流水（不是记忆） ----------

/**
 * 记一条"她本来要说、但没说出去"的话。
 *
 * 为什么单独存：干跑（guard.dryRun）和事实闸拦下的拟发言，如果写进 episodes，
 * 她会当成自己真的说过，之后拿这些"幽灵发言"当记忆引用；而 brain.onSent 只在
 * 真发出去后才记 → 两套记忆分叉。审计流水只给人和 diagnose 看，**不进任何提示词**。
 */
export function rememberAudit({ platform = 'qq', chatId = '', userId = '', isGroup = false, kind = 'dryrun', text = '', note = '' } = {}) {
  try {
    const f = dataPath('audit', 'unsent.jsonl')
    const row = {
      ts: Date.now(), platform, chatId, userId, isGroup: isGroup === true,
      kind: String(kind), text: String(text || '').slice(0, 500), note: String(note || ''),
    }
    appendEpisode(f, row)
    return row
  } catch (e) { swallow(e, 'memory:rememberAudit'); return null }
}

/** 最近 N 条未发送审计（diagnose 用）。 */
export function unsentAudit(n = 20) {
  try {
    const f = dataPath('audit', 'unsent.jsonl')
    const rows = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n)
    return rows.map((x) => { try { return JSON.parse(x) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

// ---------- 统计 ----------

export function stats() {
  let episodes = 0
  for (const file of [EP_FILE, QQ_EP_FILE, WECHAT_EP_FILE]) {
    try { episodes += fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length } catch (e) { swallow(e, 'tools/lib/memory.mjs:571') }
  }
  const f = readJson(FACT_FILE, {})
  return {
    episodes,
    facts: Object.values(f).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0),
    lore: readJson(LORE_FILE, []).length,
  }
}

/** B（10-31）：最近一条用户还没回过的推送（kind:push 的 assistant 行）。
 *  用户回复推送时，把原推送内容带进上下文——不然她只看到回复，不记得自己说过什么。 */
export function lastUnansweredPush(chatId, hours = 48) {
  const cutoff = Date.now() - hours * 3600_000
  const rows = readRows(chatId).filter((r) => Number(r.ts) >= cutoff)
  // 从尾部往前找：最后一条 push 之后如果用户说过话，就算已回复
  let lastPush = null
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.role === "user") return null   // 用户说话在 push 之后 → 已回复
    if (r.role === "assistant" && r.kind === "push") { lastPush = r; break }
  }
  return lastPush ? { at: lastPush.ts, text: String(lastPush.text || "").slice(0, 120) } : null
}
