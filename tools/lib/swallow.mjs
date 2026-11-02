// 吞错留痕 —— 给 "best-effort" 的 catch 一个最低成本的痕迹。
//
// 为什么要有它（10-31 审计）：全库 746 个 catch 里 379 个是空的（51%）。空 catch
// 本身不都是错的（探活、缓存、可选依赖本来就该容错），但"出错了什么都不留"让整类
// 事故变成静默失效：代码看着对、从来没执行过、文档还打着勾。
//
// 用法：catch { /* 底层兜底：这里不能依赖上层 swallow（会循环依赖），错误在此终止是设计 */ } → catch (e) { swallow(e, 'qq-server:mood-tick') }
// 设计：① 绝不抛（这本身就是兜底路径）；② 合并去重 + 每小时一条摘要，
//       避免每 60s 的 tick 把日志刷爆；③ 写 ~/.data/logs/swallowed.log，超 2MB 截半。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const LOG = () => dataPath('logs', 'swallowed.log')
const MAX_BYTES = 2 * 1024 * 1024
const FLUSH_MS = 60 * 60_000          // 同一 tag 每小时最多写一条摘要

const seen = new Map()                // tag -> { at, count }
let pending = new Map()               // tag -> { count, last }

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
  if (!lines.length) return
  try {
    const f = LOG()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    try { if (fs.statSync(f).size > MAX_BYTES) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').slice(-MAX_BYTES / 2)) } catch { /* 底层兜底：这里不能依赖上层 swallow（会循环依赖），错误在此终止是设计 */ }
    fs.appendFileSync(f, lines.join('\n') + '\n')
  } catch { /* 日志写不进去也绝不能反过来炸业务 */ }
}

/**
 * 记录一次被吞掉的异常。
 * @param {unknown} err 捕获到的错误
 * @param {string} tag 位置标签，建议 '文件名:用途'
 * @param {object} [opts] { force=true 立刻落盘（真正的异常，不是高频 tick） }
 */
export function swallow(err, tag = 'unknown', opts = {}) {
  try {
    const msg = err?.message ?? String(err ?? '')
    if (!msg) return
    const cur = pending.get(tag) ?? { count: 0, last: '' }
    cur.count += 1
    cur.last = msg
    pending.set(tag, cur)
    // 高频路径攒够 50 次也强制刷一次，别等一小时
    flush(opts.force === true || cur.count >= 50)
  } catch { /* noop */ }
}

/** 手动冲刷（进程退出前调用，保证不丢最后一批）。 */
export function flushSwallowed() { try { flush(true) } catch { /* 底层兜底：这里不能依赖上层 swallow（会循环依赖），错误在此终止是设计 */ } }

/** 读回日志尾部（面板/体检用）。 */
export function readSwallowed(n = 40) {
  try { return fs.readFileSync(LOG(), 'utf8').trim().split('\n').slice(-n) } catch { return [] }
}
