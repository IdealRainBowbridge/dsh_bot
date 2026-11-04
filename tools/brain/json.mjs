// brain/json —— 文件读写底座（无依赖）。
//
// 铁律（v3 设计 §3/§13）：
//   · 所有"整份 JSON"的写入都是 temp + rename：中途崩了要么旧要么新，绝不半份。
//   · 所有 JSONL 都是 append-only：只追加，不改行（记忆不硬删）。
//   · 坏行不抛异常：一行坏了跳过，别让一条脏数据把整轮回复带崩。
//
// ── 2026-11-03 并发修复：mutateJson 有了真锁 ────────────────────────────
// 旧注释说"锁只在 facts/intents 这类多入口的地方显式加"——但 facts/intents 全文
// 没有 withLock（评审②实锤：注释里的锁不存在）。而 field 的 poke/setDim、hpa、
// neuron save、qq-server/heartbeat/sleep/cron 全都在多进程并发地 mutateJson。
// v5 发现的"并发写状态文件丢 28.8%"修的是"写半份文件"（原子 rename），
// 没修"丢更新"（两个进程基于同一份快照各写各的，后写覆盖前写）。
// 现在锁内建在本文件：O_EXCL 同目录锁文件 + 死锁抢占 + 5s 超时无锁降级。
//   · 拿不到锁等（20~50ms 抖动重试）；持锁者死了就抢占（kill(pid,0) 探活）；
//   · 等 5s 还拿不到 → 无锁降级继续跑（行为=旧版，绝不卡死业务——
//     脑是旁路，宁可偶发丢一次更新，不许聊天链路挂起）；
//   · 锁文件系统坏了 → 同样无锁降级 + swallow 留痕。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { swallow } from '../lib/swallow.mjs'

/** 确保目录存在（幂等）。 */
export function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { swallow(e, 'json:ensureDir') }
  return dir
}

/** 读 JSON；带 BOM 也认；坏了返回 fallback。 */
export function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch { return fallback }
}

/** 原子写 JSON（temp + rename）。 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 1))
  fs.renameSync(temp, file)
  return value
}

/** 追加一行 JSONL。永远不抛：记忆写入失败不许影响聊天主链。 */
export function appendJsonl(file, obj) {
  try {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, JSON.stringify(obj) + '\n')
    return true
  } catch { return false }
}

/** 读 JSONL。limit 只取尾部 N 行（大文件不整份进内存）。 */
export function readJsonl(file, { limit = 0 } = {}) {
  let raw = ''
  try {
    if (!fs.existsSync(file)) return []
    const st = fs.statSync(file)
    if (limit > 0 && st.size > 4 * 1024 * 1024) {
      // 大文件：只读尾部（按行数估 512B/行，多读一点再截断）
      const want = Math.min(st.size, limit * 600)
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(want)
        fs.readSync(fd, buf, 0, want, Math.max(0, st.size - want))
        raw = buf.toString('utf8')
        raw = raw.slice(raw.indexOf('\n') + 1)   // 丢掉被截断的首行
      } finally { fs.closeSync(fd) }
    } else {
      raw = fs.readFileSync(file, 'utf8')
    }
  } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
  }
  return limit > 0 ? out.slice(-limit) : out
}

// ── 同目录文件锁（mutateJson 专用，自包含不引 lock.mjs）──────────────────
// 为什么不放 tools/lib/lock.mjs：那边锁名挂在 dataPath('locks')，而这里要锁的文件
// 可能是测试沙箱里的任意路径。同目录锁与文件同生共死，测试隔离天然生效。
const LOCK_WAIT_MS = 5000

function acquireSameDirLock(file) {
  const lock = `${file}.lock`
  const mine = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.lock`
  let fd = null
  try { fd = fs.openSync(mine, 'wx') } catch (e) { return { ok: false, why: 'create:' + (e && e.code) } }
  try { fs.writeSync(fd, String(process.pid)) } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { fs.linkSync(mine, lock); try { fs.rmSync(mine, { force: true }) } catch { /* ignore */ } return { ok: true, lock } }
    catch (e) {
      if (!e || e.code !== 'EEXIST') { try { fs.rmSync(mine, { force: true }) } catch { /* ignore */ } return { ok: false, why: 'link:' + (e && e.code) } }
      // 已被占：持锁者还活着吗？死了就清掉重抢。
      let alive = false
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'))
        if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true }
      } catch { /* 读不到 = 残锁，当死的 */ }
      if (!alive) {
        // 抢占死锁。2026-11-03 的版本是"复核 pid2 存活 → rm"，但复核与 rm 之间
        // **仍有窗口**：两个等待者可以同时判定"死"，各自 rm 掉对方刚抢到的活锁 →
        // 两个写入者同时进临界区 → 丢更新（实测 tension 2.7 != 3.0，隔几十次全套跑一次）。
        //
        // 2026-11-04 改成**原子抢占**：`renameSync(lock, graveyard)`。
        // rename 是原子的，且只有一个竞争者能成功（另一个会 ENOENT），
        // 所以"把一个具体的历史锁文件搬走"这件事天然互斥 —— 不存在 rm 掉别人新锁的可能。
        // 搬走后先验尸（万一搬走的其实是活锁，就把它放回去），再继续抢。
        const graveyard = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
        let stole = false
        try { fs.renameSync(lock, graveyard); stole = true } catch { /* 别人先搬走了 / 已被释放 */ }
        if (stole) {
          let holderAlive = false
          try {
            const pid2 = Number(fs.readFileSync(graveyard, 'utf8'))
            if (pid2 && pid2 !== process.pid) { process.kill(pid2, 0); holderAlive = true }
          } catch { /* 读不到 = 确实死了 */ }
          if (holderAlive) {
            // 误判：搬走的是一把活锁。放回去（放不回去也无妨 —— 它已经不在位，
            // 持有者释放时会 rm 一个不存在的路径，接下来按"无锁降级"处理）。
            try { fs.linkSync(graveyard, lock) } catch { /* 已被别人抢到，就这样 */ }
          }
          try { fs.rmSync(graveyard, { force: true }) } catch { /* ignore */ }
        }
        continue
      }
      if (Date.now() > deadline) return { ok: false, why: 'timeout', lock }
      // 忙等 20~50ms 再抢（临界区是毫秒级的小 JSON 读写，够用且不引入异步）
      const until = Date.now() + 20 + Math.floor(Math.random() * 30)
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function releaseSameDirLock(lock) {
  try { fs.rmSync(lock, { force: true }) } catch { /* 残锁会被下一个获取者按死进程清走 */ }
}

/**
 * 改一份 JSON：read → fn(当前值) → 原子写，**整段在文件锁内**（2026-11-03 起）。
 * fn 返回 undefined 表示"不写"。
 *
 * 锁语义（脑是旁路，别让锁把业务卡死）：
 *   · 正常：临界区内读改写，跨进程不丢更新。
 *   · 5s 等不到 / 锁系统坏：无锁降级跑（= 旧版行为，偶发丢更新好过聊天链路挂起），
 *     swallow 留痕。
 */
export function mutateJson(file, fallback, fn) {
  const body = () => {
    const cur = readJson(file, fallback)
    const next = fn(cur)
    if (next === undefined) return cur
    return writeJsonAtomic(file, next)
  }
  const g = acquireSameDirLock(file)
  if (g.ok) {
    try { return body() } finally { releaseSameDirLock(g.lock) }
  }
  try { swallow(new Error('mutateJson 无锁降级：' + file + ' —— ' + g.why), 'json:mutateLock') } catch { /* ignore */ }
  return body()
}

/** 文件大小 / 行数（doctor 用）。 */
export function fileInfo(file) {
  try {
    const st = fs.statSync(file)
    return { exists: true, size: st.size, mtime: st.mtimeMs }
  } catch { return { exists: false, size: 0, mtime: 0 } }
}

/** 目录下匹配的文件名（排序稳定）。 */
export function listFiles(dir, re) {
  try {
    return fs.readdirSync(dir).filter((f) => (re ? re.test(f) : true)).sort()
  } catch { return [] }
}

/** 短哈希（锁名 / 去重键用）。 */
export function shortHash(str, len = 10) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, len)
}
