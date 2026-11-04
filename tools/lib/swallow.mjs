// 吞错留痕 —— 给 "best-effort" 的 catch 一个最低成本的痕迹。
//
// 为什么要有它（10-31 审计）：全库 746 个 catch 里 379 个是空的（51%）。空 catch
// 本身不都是错的（探活、缓存、可选依赖本来就该容错），但"出错了什么都不留"让整类
// 事故变成静默失效：代码看着对、从来没执行过、文档还打着勾。
//
// 用法：catch { /* 底层兜底：这里不能依赖上层 swallow（会循环依赖），错误在此终止是设计 */ } → catch (e) { swallow(e, 'qq-server:mood-tick') }
// 设计：① 绝不抛（这本身就是兜底路径）；② 合并去重 + 每小时一条摘要，
//       避免每 60s 的 tick 把日志刷爆；③ 写 ~/.data/logs/swallowed.log，超 2MB 截半。
//
// 2026-11-04 分流（P1）：实测 1196 行里 900+ 行是 ENOENT —— "首建锁还没建"、
// "可选文件不存在"这类**预期缺失**，每 30 秒一条，把真正的事故（TDZ、缺 import、
// 断链）完全埋掉。现在按错误类别分流到两本账：
//   · swallowed.log      —— 真事故（含 ReferenceError/TypeError/断链等），1 小时摘要
//   · swallowed-soft.log —— 预期缺失（ENOENT/EACCES 首建/ENOTDIR），6 小时摘要
// 分流只改**落盘位置与频率**，不丢信息；readSwallowed() 仍只返回真事故，
// diagnose 的门槛因此重新变得有意义。用 opts.soft = true/false 可显式覆盖判定。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const LOG = () => dataPath('logs', 'swallowed.log')
const LOG_SOFT = () => dataPath('logs', 'swallowed-soft.log')
const MAX_BYTES = 2 * 1024 * 1024
const FLUSH_MS = 60 * 60_000          // 同一 tag 每小时最多写一条摘要
const FLUSH_SOFT_MS = 6 * 60 * 60_000 // 预期缺失更稀：6 小时一条

/** 预期缺失的错误码：文件/目录还没建、首次写锁、临时目录被清掉。 */
const SOFT_CODES = new Set(['ENOENT', 'ENOTDIR'])

const seen = new Map()                // tag -> { at, count }
let pending = new Map()               // tag -> { count, last, soft }
const seenSoft = new Map()
let pendingSoft = new Map()

function isSoftErr(err, opts) {
  if (opts.soft !== undefined) return opts.soft === true
  const code = err?.code || err?.cause?.code
  if (SOFT_CODES.has(String(code || ''))) return true
  // 没有 code 的（如 `spawnSync git ENOENT` 被包成普通 Error）按消息兜底
  return /\bENOENT\b|\bENOTDIR\b/.test(String(err?.message ?? ''))
}

function appendLines(file, lines) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try { if (fs.statSync(file).size > MAX_BYTES) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-MAX_BYTES / 2)) } catch { /* 底层兜底：这里不能依赖上层 swallow（会循环依赖），错误在此终止是设计 */ }
    fs.appendFileSync(file, lines.join('\n') + '\n')
  } catch { /* 日志写不进去也绝不能反过来炸业务 */ }
}

function flush(force = false) {
  const now = Date.now()
  const lines = []
  for (const [tag, v] of pending) {
    const prev = seen.get(tag)
    if (!force && prev && now - prev.at < FLUSH_MS) continue
    seen.set(tag, { at: now, count: (prev?.count ?? 0) + v.count })
    lines.push(`${new Date(now).toISOString()} ${tag} ×${v.count} 最后：${String(v.last).slice(0, 180)}`)
  }
  pending = new Map()
  if (lines.length) appendLines(LOG(), lines)

  const softLines = []
  for (const [tag, v] of pendingSoft) {
    const prev = seenSoft.get(tag)
    if (!force && prev && now - prev.at < FLUSH_SOFT_MS) continue
    seenSoft.set(tag, { at: now, count: (prev?.count ?? 0) + v.count })
    softLines.push(`${new Date(now).toISOString()} ${tag} ×${v.count} 最后：${String(v.last).slice(0, 180)}`)
  }
  pendingSoft = new Map()
  if (softLines.length) appendLines(LOG_SOFT(), softLines)
}

/**
 * 记录一次被吞掉的异常。
 * @param {unknown} err 捕获到的错误
 * @param {string} tag 位置标签，建议 '文件名:用途'
 * @param {object} [opts] { force=true 立刻落盘（真正的异常，不是高频 tick）；soft=true/false 强制分流 }
 */
export function swallow(err, tag = 'unknown', opts = {}) {
  try {
    const msg = err?.message ?? String(err ?? '')
    if (!msg) return
    const soft = isSoftErr(err, opts)
    const bucket = soft ? pendingSoft : pending
    const cur = bucket.get(tag) ?? { count: 0, last: '' }
    cur.count += 1
    cur.last = msg
    bucket.set(tag, cur)
    // 高频路径攒够 50 次也强制刷一次，别等一小时
    flush(opts.force === true || cur.count >= 50)
  } catch { /* noop */ }
}

/** 手动冲刷（进程退出前调用，保证不丢最后一批）。 */
export function flushSwallowed() { try { flush(true) } catch { /* 底层兜底：这里不能依赖上层 swallow（会循环依赖），错误在此终止是设计 */ } }

/** 读回日志尾部（面板/体检用）。默认只给**真事故**；soft=true 读预期缺失那本账。 */
export function readSwallowed(n = 40, { soft = false } = {}) {
  try {
    const f = soft ? LOG_SOFT() : LOG()
    return fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n)
  } catch { return [] }
}

/** 两本账各自的字节数（体检用：真事故那本应当是小的）。 */
export function swallowedStats() {
  const stat = (f) => { try { const s = fs.statSync(f); return { bytes: s.size, exists: true } } catch { return { bytes: 0, exists: false } } }
  return { real: stat(LOG()), soft: stat(LOG_SOFT()) }
}
