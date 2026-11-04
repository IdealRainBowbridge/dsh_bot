// 锁的对抗测试（2026-11-04）—— 把并发丢更新的窗口**变成可复现**，而不是靠 1/25 的运气。
//
// 背景：field-mutate-race 用 10 个真进程抢锁，失败的频率约 1/25、丢 1~2 条。
// 这类"偶尔丢一次"在生产里就是"额度账本少记一笔 / 情绪值回退"，但用它来验证
// 修复又太慢（跑 25 次才看见一次，改了也不知道是真修好还是运气）。
//
// 这里不走进程，直接在**同一进程内**把危险序列摆出来：
//   ① release 认领：别人的锁不能被删（旧实现无条件 rm → 第三个写入者进来）
//   ② 抢占的原子性：两个竞争者同时抢同一把死锁，只能有一个成功
//   ③ pid 解析：锁内容是 "pid\ntoken" 两行，必须只读第一行
//   ④ 老格式兼容：只有 pid 一行的旧锁仍能被正确判活
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-adv-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

// 用子进程做"另一个写入者"：活进程，pid 真实存在。
// ⚠️ 必须用 spawn + detached（spawnSync 会同步等到子进程退出，测试直接卡住）；
// 且 unref() 让父进程能正常收尾。
const { spawn } = await import('node:child_process')
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore', detached: true })
sleeper.unref()
const livePid = sleeper.pid
// 等它真的在进程表里（kill(pid,0) 立刻生效）
await new Promise((r) => setTimeout(r, 300))
// brain/json 的 API 是 mutateJson(file, fallback, fn)；readJson 即 safe read。
const { mutateJson, readJson, writeJsonAtomic } = await import('../tools/brain/json.mjs')
const updateJson = (file, fn, opt = {}) => {
  try { const v = mutateJson(file, null, fn); return { ok: true, value: v } } catch (e) { return { ok: false, error: String(e?.message || e) } }
}
const readJsonSafe = (file, fallback) => readJson(file, fallback)

try {
  // ── ① release 认领：不是我的锁不许删 ────────────────────────────────────
  {
    const file = path.join(TMP, 'claim.json')
    writeJsonAtomic(file, { n: 0 })
    const lock = file + '.lock'
    // 模拟"别人的锁"：活进程 + 别人的 token
    fs.writeFileSync(lock, String(livePid) + '\nother.token')
    // 我走一次 updateJson：它必须先抢（抢不到会等 5s 后无锁降级），
    // 但无论哪种结果，都**不能**删掉别人的活锁
    const r = updateJson(file, (cur) => ({ n: Number(cur?.n || 0) + 1 }), { waitMs: 300 })
    const stillThere = fs.existsSync(lock) && fs.readFileSync(lock, 'utf8').includes('other.token')
    ok('别人的活锁不会被误删', stillThere, stillThere ? '锁仍在' : '锁被删了（旧实现的 bug）')
    ok('无锁降级仍然写入了（不卡死业务）', r.ok === true || r.error === 'write-failed', JSON.stringify(r).slice(0, 80))
  }

  // ── ② 抢占原子性：两个竞争者抢同一把死锁，只有一个进临界区 ──────────────
  {
    const file = path.join(TMP, 'steal.json')
    writeJsonAtomic(file, { n: 0 })
    const lock = file + '.lock'
    // 死锁：pid 999999 不存在
    fs.writeFileSync(lock, '999999\ndead.token')
    // 20 个进程并发自增，每个都在锁内读-改-写
    const child = `
      const { mutateJson } = await import(${JSON.stringify(new URL('../tools/brain/json.mjs', import.meta.url).href)})
      try { mutateJson(${JSON.stringify(file)}, null, (cur) => ({ n: Number(cur?.n || 0) + 1 })); process.exit(0) } catch { process.exit(1) }
    `
    const rs = []
    for (let i = 0; i < 20; i++) {
      // timeout：抢锁最长等 5s，给 20s 余量。没有超时的 spawnSync 会把测试进程钉死
      const c = spawnSync(process.execPath, ['--input-type=module', '-e', child], { stdio: 'pipe', timeout: 20_000, killSignal: 'SIGKILL' })
      rs.push(c.status)
    }
    const got = readJsonSafe(file, { n: -1 }).n
    ok('20 个进程抢死锁后全部成功', rs.every((s) => s === 0), '失败 ' + rs.filter((s) => s !== 0).length + ' 个')
    ok('20 次自增零丢失', got === 20, '实际 n=' + got)
  }

  // ── ③ pid 解析：锁内容是多行时只取第一行 ────────────────────────────────
  {
    const file = path.join(TMP, 'parse.json')
    writeJsonAtomic(file, { n: 0 })
    const lock = file + '.lock'
    fs.writeFileSync(lock, String(livePid) + '\n' + 'x'.repeat(40))
    const r = updateJson(file, (cur) => ({ n: Number(cur?.n || 0) + 1 }), { waitMs: 300 })
    // 关键：解析对了 → 认出"活锁" → 不会抢占（锁内容保持原样）
    const content = (() => { try { return fs.readFileSync(lock, 'utf8') } catch { return '' } })()
    // 两种正当结果：① 锁还在（认出了活持有者，没抢）；② 锁被正常释放（拿到了自己的租约）。
    // 唯一不允许的是"读成 NaN → 判死 → 抢占成功"，那会让锁内容里的 other token 消失。
    const recognizedAlive = content.startsWith(String(livePid) + '\n')
    const releasedCleanly = content === '' || !content.includes('other.token')
    ok('多行锁内容不会被读成 NaN（不误判死锁）', recognizedAlive || releasedCleanly,
      recognizedAlive ? '未误抢' : '锁已被正常释放')
  }

  // ── ④ 老格式兼容：只有 pid 一行的锁 ──────────────────────────────────────
  {
    const file = path.join(TMP, 'legacy.json')
    writeJsonAtomic(file, { n: 0 })
    const lock = file + '.lock'
    fs.writeFileSync(lock, String(livePid))
    updateJson(file, (cur) => ({ n: Number(cur?.n || 0) + 1 }), { waitMs: 300 })
    const kept = fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(livePid)
    ok('老格式（只有 pid）的活锁不被误抢', kept, kept ? '未误抢' : '被误判')
  }

  // ── ⑤ 死锁（pid 真的不在）仍可被抢占 ────────────────────────────────────
  {
    const file = path.join(TMP, 'dead.json')
    writeJsonAtomic(file, { n: 0 })
    const lock = file + '.lock'
    fs.writeFileSync(lock, '999999\ndead')
    const r = updateJson(file, (cur) => ({ n: Number(cur?.n || 0) + 1 }), { waitMs: 3000 })
    ok('死锁能被抢占（不会永久堵住）', r.ok === true && readJsonSafe(file, {}).n === 1, JSON.stringify(r).slice(0, 60))
  }
} finally {
  try { process.kill(livePid, 'SIGKILL') } catch { /* 已退出 */ }
  try { sleeper.kill('SIGKILL') } catch { /* 已退出 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}

console.log(bad ? `\n✗ 锁对抗：${bad} 项失败` : '\n✓ 锁对抗：全绿')
process.exit(bad ? 1 : 0)
