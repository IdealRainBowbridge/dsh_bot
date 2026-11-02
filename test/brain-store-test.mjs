// brain/store 测试：withLock 互斥、mutateJson 原子读改写、cursor 读写、tryExclusive、多进程无丢失。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-store-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const store = await import('../tools/brain/store.mjs')

// ① mutateJson：读-改-写原子性；回调抛错时原值不被毁（错误会抛出，锁会释放）
const f = path.join(tmp, 'st.json')
store.mutateJson(f, { n: 0 }, (cur) => ({ n: cur.n + 5 }))
store.mutateJson(f, { n: 0 }, (cur) => ({ n: cur.n + 3 }))
ok('mutateJson 两次累加 = 8', JSON.parse(fs.readFileSync(f, 'utf8')).n === 8)
let threw = false
try { store.mutateJson(f, { n: 0 }, () => { throw new Error('boom') }) } catch { threw = true }
ok('回调抛错会抛出且不毁原值', threw && JSON.parse(fs.readFileSync(f, 'utf8')).n === 8)

// ② 锁的复用：withLock 正常进出；tryExclusive 空闲时拿到句柄、忙时拿不到
let entered = 0
store.withLock('t1', () => { entered++ })
ok('空闲锁直接进', entered === 1)
const h1 = store.tryExclusive('ex1')
ok('tryExclusive 空闲 → 拿到释放函数', typeof h1 === 'function')
const h2 = store.tryExclusive('ex1')
ok('tryExclusive 忙 → null（互斥）', h2 === null)
h1()
const h3 = store.tryExclusive('ex1')
ok('释放后能重新拿到', typeof h3 === 'function')
h3()

// ③ cursor：读写对称
const cf = path.join(tmp, 'cursor.json')
store.writeCursor(cf, { line: 42 })
ok('writeCursor 后 readCursor 读回', store.readCursor(cf, {}).line === 42)
ok('不存在的 cursor 用 fallback', store.readCursor(path.join(tmp, 'none.json'), { d: 1 }).d === 1)

// ④ 多进程互斥：4 个进程各抢同一把锁累加 25，一个都不许丢（含前一步的 8）
const worker = path.join(tmp, 'locker.mjs')
fs.writeFileSync(worker, `
const { withLock, mutateJson } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'tools/brain/store.mjs')).href)})
const f = ${JSON.stringify(f)}
withLock('multi', () => mutateJson(f, { n: 0 }, (c) => ({ n: c.n + 25 })), { timeoutMs: 20_000 })
`)
const NODE = process.env.BOT_NODE || process.execPath
for (let i = 0; i < 4; i++) {
  spawnSync(NODE, [worker], { env: { ...process.env }, encoding: 'utf8', timeout: 60_000 })
}
ok('4 进程 × 25 + 8 = 108（无丢失）', JSON.parse(fs.readFileSync(f, 'utf8')).n === 108,
  '实际 ' + JSON.parse(fs.readFileSync(f, 'utf8')).n)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ brain-store 全部通过')
process.exit(bad ? 1 : 0)
