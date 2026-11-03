// atomic —— 跨进程安全的"读-改-写"（v5 深度排查新增）。
//
// 为什么必须要有它：
//   这套系统有 **10+ 个独立进程**会写同一批状态文件：
//     qq-server / bili-watch / binge / replies / dream / wander / web / act / feed …
//   而几乎所有状态文件（quota.json / bili-actions.json / share-queue.json /
//   sent-at.json / mood.json / proact …）都写成这样：
//
//       const q = JSON.parse(fs.readFileSync(F))   // 读
//       q.n = (q.n || 0) + 1                       // 改
//       fs.writeFileSync(F, JSON.stringify(q))     // 写
//
//   三个进程同时做这件事时，"读"到的是彼此覆盖前的旧值 —— 后写的那份会把
//   先写的增加量整个覆盖掉。**实测：20 进程 × 50 次并发，28.8% 的自增丢失。**
//
//   后果不是"少记一笔"这么轻：额度账本（quota / bili-actions）漏记 → 她会
//   超额发评论/点赞/投币，直接触发平台风控；情绪值漏记 → 行为漂移。
//
// 修法：**文件锁 + 原子替换**。
//   · 锁用 O_EXCL 建 .lock 文件（跨进程有效，NFS 也够用）
//   · 拿到锁才允许"读 → 改 → 写"
//   · 写走 tmp + rename（rename 在同一文件系统上是原子的，不会留下半个文件）
//   · 锁带超时与陈旧检测（持锁进程崩了不会把所有人卡死）
//
// 用法：
//   import { updateJson, readJsonSafe } from './atomic.mjs'
//   updateJson(file, (cur) => { cur.n = (cur.n||0) + 1; return cur }, { fallback: { n: 0 } })
import fs from 'node:fs'
import path from 'node:path'
import { swallow } from './swallow.mjs'

const sleepSync = (ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) { /* 同步忙等：这里的临界区只有几毫秒，不值得上 Atomics */ }
}

/**
 * 拿一把文件锁（同步）。返回释放函数；拿不到返回 null。
 * @param {string} lockPath
 * @param {{staleMs?:number, waitMs?:number}} opts
 */
export function acquireLock(lockPath, { staleMs = 30_000, waitMs = 5_000 } = {}) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }) } catch { /* ignore */ }
  const deadline = Date.now() + waitMs
  const me = `${process.pid} ${new Date().toISOString()}`

  /**
   * 尝试一次抢占。
   *
   * v5 深度排查的第三版实现（前两版都会丢数据）：
   *   第 1 版：openSync(path,'wx') 建锁 → 丢 28.8%（完全没有互斥意识）
   *   第 2 版：openSync('wx') + 立刻 writeSync(pid) → 仍丢 ~5%（overlayfs 上
   *           "建文件"与"写入内容"之间有明显窗口，别的进程读到空文件 →
   *           误判死锁 → 把活锁拆了 → 两把锁同时生效）
   *   第 3 版（本版）：**先把锁内容写进一个唯一临时文件，再用 link() 原子创建锁**。
   *           link() 在 POSIX 上是原子的：目标已存在就 EEXIST，不存在就成功，
   *           而且成功时**内容已经完整**。彻底消除"空锁窗口"。
   *           （rename 会覆盖已有文件，不能用；link 不会。）
   */
  for (;;) {
    const tmp = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      fs.writeFileSync(tmp, me, { flag: 'wx' })
      try {
        fs.linkSync(tmp, lockPath)          // 原子：已存在则 EEXIST
        let released = false
        return () => {
          if (released) return
          released = true
          try { fs.rmSync(lockPath, { force: true }) } catch { /* ignore */ }
        }
      } catch (e) {
        if (e.code !== 'EEXIST') { swallow(e, 'atomic:link'); return null }
        // 被占用 → 走下面的等锁逻辑
      } finally {
        try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') { swallow(e, 'atomic:tmp'); return null }
    }

    // ── 已存在：判断是"活锁"还是"死锁残留" ───────────────────────────────
    // 因为第 3 版用 link 创建，读到的内容**一定完整**（不存在空锁窗口）。
    try {
      const st = fs.statSync(lockPath)
      const age = Date.now() - st.mtimeMs
      let pid = 0
      try { pid = Number(String(fs.readFileSync(lockPath, 'utf8')).trim().split(/\s+/)[0]) || 0 } catch { /* ignore */ }
      let alive = false
      if (pid > 0) { try { process.kill(pid, 0); alive = true } catch { alive = false } }
      // 只有"确定已死"或"超时很久"才拆；读不到 pid 时只按 staleMs 判（不再 2 秒就拆）
      const definitelyDead = pid > 0 && !alive
      if (definitelyDead || age > staleMs) {
        // 2026-11-03 TOCTOU narrowing: re-read the lock right before rm.
        // A waiter that raced us may hold it now; deleting its live lock
        // would put two writers in the critical section (lost update).
        try {
          const pid2 = Number(String(fs.readFileSync(lockPath, 'utf8')).trim().split(/\s+/)[0]) || 0
          if (pid2 && pid2 !== pid) continue   // new holder took over; do not steal
        } catch { continue }                    // lock vanished; retry link
        try { fs.rmSync(lockPath, { force: true }) } catch { /* ignore */ }
        continue
      }
    } catch { /* 锁刚被释放，直接重试 */ }

    if (Date.now() > deadline) return null
    sleepSync(3 + Math.random() * 7)
  }
}

/** 读 JSON（失败返回 fallback，不抛）。 */
export function readJsonSafe(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch { return fallback }
}

/** 原子写：tmp（同目录）→ rename。失败不破坏原文件。 */
export function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp')
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n', { mode })
    try { fs.chmodSync(tmp, mode) } catch { /* 某些 FS 不支持 */ }
    fs.renameSync(tmp, file)     // 同一文件系统内原子
    return true
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    swallow(e, 'atomic:write')
    return false
  }
}

/**
 * 跨进程安全的"读-改-写"。
 *
 * @param {string} file
 * @param {(cur:any) => any} mutate 拿到当前值，返回新值（return undefined 表示不写）
 * @param {{fallback?:any, lock?:string, staleMs?:number, waitMs?:number, mode?:number}} opts
 * @returns {{ok:boolean, value?:any, error?:string, locked?:boolean}}
 */
export function updateJson(file, mutate, opts = {}) {
  const lockPath = opts.lock || (file + '.lock')
  const release = acquireLock(lockPath, { staleMs: opts.staleMs ?? 30_000, waitMs: opts.waitMs ?? 5_000 })
  if (!release) {
    // 拿不到锁：**不要**盲写（那正是丢数据的根源）。
    // 返回失败让调用方决定（多数场景：这次不加了，下次再说 —— 比超发安全）。
    return { ok: false, locked: false, error: 'lock-timeout' }
  }
  try {
    const cur = readJsonSafe(file, opts.fallback ?? null)
    const next = mutate(cur)
    if (next === undefined) return { ok: true, value: cur, skipped: true }
    const ok = writeJsonAtomic(file, next, { mode: opts.mode ?? 0o600 })
    return ok ? { ok: true, value: next } : { ok: false, error: 'write-failed' }
  } catch (e) {
    swallow(e, 'atomic:update')
    return { ok: false, error: String(e?.message || e) }
  } finally {
    release()
  }
}

/**
 * 纯自增/自减的快捷方式（额度账本最常见）。
 * @returns {{ok:boolean, value?:number}}
 */
export function bumpJson(file, key, delta = 1, opts = {}) {
  const r = updateJson(file, (cur) => {
    const o = (cur && typeof cur === 'object') ? cur : {}
    o[key] = Number(o[key] || 0) + delta
    return o
  }, opts)
  return { ok: r.ok, value: r.value?.[key], error: r.error }
}
