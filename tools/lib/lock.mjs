// lock —— 自由进程单实例锁（10-25 建立，2026-11-03 健壮化重构）
//
// 为什么要有它：完全自由/面板两条路径都能启动同一进程，
// 双实例 = 重复评论/风控灾难。pid 文件锁 + 存活检测，进程退出自动释放。
//
// ── 2026-11-03 评审修复（P0 两处失败方向反了的根） ─────────────────────
// ① 旧版整段 try{...}catch{return null}：锁系统故障（磁盘满/权限）时返回 null，
//    而调用方（qq-server）把 null 理解成"已有实例在跑"→ 新实例 exit(0)。
//    结果：磁盘抖一下 = 聊天服务静默下线，守护还以为一切正常。
//    新版分清三态：acquired（拿到）/ held（别人持有，正常让位）/ broken（锁系统坏了）。
//    调用方对 held 让位（旧行为）；对 broken 由 acquire() 的 opts 决定：
//    默认 failOpen（让位，幂等任务旧行为不变），qq-server 显式传 failClosed:true
//    （宁可双开被端口绑定挡住，不可静默下线）。
// ② 旧版 existsSync→kill(0)→writeFileSync 是 TOCTOU：两个进程同时启动都查不到对方，
//    都拿锁。新版用 O_EXCL 原子建锁文件：拿不到（EEXIST）才去看持锁者死没死，
//    死了走"抢占"路径（同样 O_EXCL 原子改名接管），活着的进程不可能和自己抢到同一把锁。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const DIR = () => dataPath('locks')

/** 锁文件里的记录（存 json，便于诊断：谁、何时、为什么）。 */
function lockFile(name) { return path.join(DIR(), name + '.lock') }

/**
 * 尝试获取锁（原子 O_EXCL）。
 * @returns {{acquired:true, release:Function}|{acquired:false, held:true, holder?:number}|{acquired:false, held:false, broken:string}}
 *          held=true   = 已有存活实例持有（调用方应让位）
 *          held=false  = 锁系统本身故障（调用方按自己语义决定让不让）
 */
export function tryAcquire(name) {
  const f = lockFile(name)
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const rec = JSON.stringify({ pid: process.pid, at: Date.now(), name })
    let fd
    try {
      fd = fs.openSync(f, 'wx', 0o644)        // O_EXCL：存在即抛 EEXIST，绝无 TOCTOU
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e
      // 锁文件已存在：看持锁者还活着吗
      let old = null
      try { old = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { /* 坏文件当死锁 */ }
      const pid = Number(old && old.pid)
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return { acquired: false, held: true, holder: pid } }
        catch { /* 旧进程已死，锁是残留 → 抢占 */ }
      }
      // 抢占：建自己的唯一锁文件，再用 link 原子占用正式名。
      // （不能直接 rename 覆盖：两个抢占者 race 时 rename 会静默双胜；link 目标存在即 EEXIST。）
      const mine = f + '.' + process.pid + '.takeover'
      fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, at: Date.now(), name, takeoverOf: pid || null }))
      try { fs.unlinkSync(f) } catch { /* 可能已被别的抢占者清走 */ }
      try {
        fs.linkSync(mine, f)                 // 原子占用：已有人先到 → EEXIST
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          try { fs.rmSync(mine, { force: true }) } catch { /* ignore */ }
          return { acquired: false, held: true }
        }
        throw e
      }
      try { fs.rmSync(mine, { force: true }) } catch { /* ignore */ }
      return { acquired: true, release: makeRelease(f, name) }
    }
    try { fs.writeFileSync(fd, rec) } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
    return { acquired: true, release: makeRelease(f, name) }
  } catch (e) {
    return { acquired: false, held: false, broken: String((e && e.message) || e) }
  }
}

function makeRelease(f, name) {
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      // 只删"确实还是自己的"那把锁——避免误删抢占者的
      const cur = (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } })()
      if (cur && Number(cur.pid) === process.pid) fs.rmSync(f, { force: true })
    } catch { /* 释放失败无伤大雅：残留锁会被下一个获取者按死进程抢占 */ }
  }
  try { process.on('exit', release) } catch { /* ignore */ }
  return release
}

/**
 * 兼容旧签名。拿到返回释放函数；被别人持有返回 null。
 * 锁系统故障时：默认 failOpen（让位 = 旧版行为，幂等任务如 bili-watch/web/browser 适用）；
 * 传 { failClosed:true } 则返回空释放函数让调用方继续跑 —— 给 qq-server 用：
 * 双开会撞端口绑定（等于还有一道防线），而静默下线没有任何防线。
 * @param {string} name 锁名
 * @param {{failClosed?:boolean}} [opts]
 */
export function acquire(name, opts = {}) {
  const failClosed = opts.failClosed === true
  const r = tryAcquire(name)
  if (r.acquired) return r.release
  if (r.held) return null
  if (failClosed) {
    try { console.error('[lock] 锁系统故障，failClosed 继续跑：' + r.broken) } catch { /* ignore */ }
    const noop = () => {}
    try { process.on('exit', noop) } catch { /* ignore */ }
    return noop
  }
  try { console.error('[lock] 锁系统故障，让位：' + r.broken) } catch { /* ignore */ }
  return null
}
