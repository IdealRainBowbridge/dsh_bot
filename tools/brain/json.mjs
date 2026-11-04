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

/**
 * 从锁文件内容里取 pid。内容格式：第一行 pid，第二行 token（2026-11-04 起）。
 * 老格式只有 pid 一行 —— 同样能读，向后兼容。
 * @param {string} raw 锁文件原文
 * @returns {number} pid（读不出返回 0 = 当死锁处理）
 */
function parseLockPid(raw) {
  const first = String(raw || '').split('\n')[0].trim()
  const n = Number(first)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function acquireSameDirLock(file) {
  // 2026-11-05：先建目录再建锁文件 —— 以前靠"无锁降级裸写"路径里的 ensureDir
  // 无意中兜了底，fail-closed 之后目录不存在时锁创建必败（ENOENT）→ 全体写入方
  // 拿 null。锁系统必须自足，不能依赖写入方先建好目录。
  try { ensureDir(path.dirname(file)) } catch { /* ensureDir 失败让 openSync 自己抛 */ }
  const lock = `${file}.lock`
  // token 唯一标识"这一次获取"：release 时用它认领（只删自己那份），
  // 避免"我的租约已被抢占/过期清走后，我还把别人的锁 rm 掉"（2026-11-04 修）。
  const token = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`
  const mine = `${file}.${token}.lock`
  let fd = null
  try { fd = fs.openSync(mine, 'wx') } catch (e) { return { ok: false, why: 'create:' + (e && e.code) } }
  // 锁内容 = pid + token（两行）：pid 给存活探测用，token 给 release 认领用
  try { fs.writeSync(fd, String(process.pid) + '\n' + token) } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { fs.linkSync(mine, lock); try { fs.rmSync(mine, { force: true }) } catch { /* ignore */ } return { ok: true, lock, token } }
    catch (e) {
      if (!e || e.code !== 'EEXIST') { try { fs.rmSync(mine, { force: true }) } catch { /* ignore */ } return { ok: false, why: 'link:' + (e && e.code) } }
      // 已被占：持锁者还活着吗？死了就清掉重抢。
      // ⚠️ 锁内容是 "pid\ntoken" 两行：必须只取第一行再转数字。
      // 直接 Number(整份内容) = NaN → 每次探测都判"死" → 疯狂抢占 → 双写入者。
      // （2026-11-04 加 token 时正是这个坑，靠下面这行 parsePid 统一收口。）
      let alive = false
      try {
        const pid = parseLockPid(fs.readFileSync(lock, 'utf8'))
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
            const pid2 = parseLockPid(fs.readFileSync(graveyard, 'utf8'))
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

/**
 * 释放锁 —— **只删自己那一份**。
 *
 * 2026-11-04 修：旧实现无条件 `rmSync(lock)`。如果本进程的租约已经被别人当作
 * 死锁抢占（或过期被清走），这个 rm 会把**别人正在持有的锁**删掉 → 第三个进程
 * 立刻进来 → 两个写入者同时在临界区 → 丢更新。
 * 实测症状：10 个并发 poke 偶发只加了 2.4（丢了 2 条），20 次里出现 1 次。
 *
 * 认领方式：锁内容含 token，只有对得上才删。读不到/对不上就什么都不做 ——
 * 残留锁会被下一个获取者按"pid 死了"清走，不会永久堵住。
 * @param {string} lock 锁文件路径
 * @param {string} token 本进程这次获取的令牌
 */
function releaseSameDirLock(lock, token) {
  try {
    const raw = fs.readFileSync(lock, 'utf8')
    if (!token || !raw.includes(token)) return   // 不是我的锁：让真正的用户去释放
    fs.rmSync(lock, { force: true })
  } catch { /* 锁已不在（被别人清了）：正常，无副作用 */ }
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
  // 2026-11-05 修缮：等锁失败不再立刻无锁裸写 —— 那是并发丢更新的最后一个洞
  // （实测：10 进程并发 poke，约 20 次全套跑出现 1 次丢 0.3，正是超时降级撞的）。
  // 改为退避重试 3 次（共多等 ~2.4s）；仍失败才降级并留下响亮的告警。
  let whyLast = '?'
  for (let attempt = 0; attempt < 3; attempt++) {
    const g = acquireSameDirLock(file)
    if (g.ok) {
      try { return body() } finally { releaseSameDirLock(g.lock, g.token) }
    }
    whyLast = g.why || '?'
    if (attempt < 2) {
      const until = Date.now() + 400 * (attempt + 1) + Math.floor(Math.random() * 200)
      while (Date.now() < until) { /* spin：临界区毫秒级，短暂退避后通常就拿到了 */ }
    }
  }
  // 2026-11-05 二修：无锁降级**裸写**是并发丢更新的最后一个洞（atomic.mjs 里
  // updateJson 的设计原则就是"拿不到锁不许盲写"，mutateJson 却一直违反它）。
  // 实测：10 进程并发 poke，裸写降级路径隔几十次跑丢一整条 +0.3。
  // 现在与 updateJson 对齐：重试耗尽 → 返回 null（调用方拿到 null 自己决定重试
  // 或放弃），绝不越过锁去写。对情绪/状态类写入，"这次没加上"远好过"覆盖别人"。
  try { swallow(new Error('mutateJson 放弃写入（重试3次仍拿不到锁，不再无锁降级）：' + file + ' —— ' + whyLast), 'json:mutateLock') } catch { /* ignore */ }
  return null
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
