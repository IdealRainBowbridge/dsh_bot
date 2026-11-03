// lock 三态语义测试（2026-11-03 · 锁系统健壮化后的行为锚）
//
// 测四件事：
//   ① 正常获取/让位/释放（held 三态）
//   ② O_EXCL：8 个并发子进程抢同一把锁，恰好 1 个拿到（TOCTOU 修复）
//   ③ 残留锁抢占：持锁 pid 已死 → 新进程原子接管
//   ④ 锁系统故障：默认 failOpen 让位（null），failClosed 继续跑（函数）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-lock-tri-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

// 动态 import：必须在 env 沙箱设好之后（lib/paths.mjs 在 import 时缓存 HOME）
const { tryAcquire, acquire } = await import(pathToFileURL(path.join(APP, 'tools/lib/lock.mjs')).href)
const lockPath = (name) => path.join(tmp, 'locks', name + '.lock')

try {
  // ① 三态
  const r1 = tryAcquire('tri')
  ok('首次获取成功', r1.acquired === true && typeof r1.release === 'function')
  const r2 = tryAcquire('tri')
  ok('二次获取 = held（让位语义）', r2.acquired === false && r2.held === true && r2.holder === process.pid)
  const r3 = acquire('tri')
  ok('acquire() 对 held 返回 null（旧调用方兼容）', r3 === null)
  r1.release()
  const r4 = tryAcquire('tri')
  ok('释放后可重取', r4.acquired === true)
  r4.release()

  // ③ 残留锁抢占（pid 写个几乎不存在的进程号）
  fs.mkdirSync(path.join(tmp, 'locks'), { recursive: true })
  fs.writeFileSync(lockPath('stale'), JSON.stringify({ pid: 999999, at: Date.now(), name: 'stale' }))
  const r5 = tryAcquire('stale')
  ok('死进程的锁被抢占', r5.acquired === true)
  const rec = JSON.parse(fs.readFileSync(lockPath('stale'), 'utf8'))
  ok('抢占后锁文件记录的是新持有者', rec.pid === process.pid)
  r5.release()

  // ④ 锁系统故障：把 locks 目录位置变成一个文件，mkdirSync 必炸
  fs.writeFileSync(path.join(tmp, 'locks2'), 'not a dir')
  // 临时挪 DIR：lock.mjs 的 DIR() 来自 dataPath('locks')，这里直接造一个坏目录场景
  // —— 用子进程验证（避免污染本进程的 paths 缓存）
  const CHILD = `
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
// 把 dataPath 的根换成 locks 位置是一个文件的世界
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-lock-broken-'))
fs.writeFileSync(path.join(tmp2, 'locks'), 'file where dir should be')
process.env.BOT_DATA_DIR = tmp2; process.env.USERPROFILE = tmp2; process.env.HOME = tmp2
import(${JSON.stringify(pathToFileURL(path.join(APP, 'tools/lib/lock.mjs')).href)}).then(({ acquire }) => {
  const a = acquire('x')                 // 默认 failOpen
  const b = acquire('y', { failClosed: true })
  console.log(JSON.stringify({ aNull: a === null, bFn: typeof b === 'function' }))
}).catch((e) => console.log(JSON.stringify({ aNull: false, bFn: false, err: String(e) })))
`
  const os = await import('node:os')
  const child = await new Promise((res) => {
    const c = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', () => {})
    c.on('exit', () => res(out))
  })
  let broken = { aNull: false, bFn: false }
  try { broken = JSON.parse(child.trim().split('\n').pop()) } catch { /* 子进程输出异常 */ }
  ok('锁系统故障：默认 failOpen 让位（null）', broken.aNull === true)
  ok('锁系统故障：failClosed 继续跑（拿到空释放函数）', broken.bFn === true)

  // ② O_EXCL 并发：8 个子进程同时抢同一把锁，恰好一个赢。
  // 赢家要**握住锁一小会儿**再退：旧版赢家 print 完立刻退出，输家探活发现
  // "持锁者已死"按设计抢占 —— 那测不出互斥，只测得出谁跑得快。
  const RACE_CHILD = `
process.env.BOT_DATA_DIR = ${JSON.stringify(tmp)}
process.env.USERPROFILE = ${JSON.stringify(tmp)}
process.env.HOME = ${JSON.stringify(tmp)}
process.env.DSH_HOME = ${JSON.stringify(path.join(tmp, '.dsh'))}
const { tryAcquire } = await import(${JSON.stringify(pathToFileURL(path.join(APP, 'tools/lib/lock.mjs')).href)})
const r = tryAcquire('race')
if (r.acquired) { await new Promise((res) => setTimeout(res, 500)); console.log('WON') }
else console.log('LOST')
`
  const rs = await Promise.all(Array.from({ length: 8 }, () => new Promise((res) => {
    const c = spawn(process.execPath, ['-e', RACE_CHILD], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.on('exit', () => res(out.trim()))
  })))
  const wins = rs.filter((x) => x === 'WON').length
  ok('8 进程并发抢锁恰好 1 个赢（O_EXCL 无 TOCTOU）', wins === 1, '赢的个数=' + wins)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 兜底清扫 */ }
}

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ lock 三态语义全绿')
process.exitCode = bad ? 1 : 0
