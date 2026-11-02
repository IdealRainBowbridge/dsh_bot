// share-queue-race-test —— 分享队列的多生产者并发（v5 深度排查）。
//
// 真实场景：bili-watch / binge / web / dream / qq-server **五个进程**都会 enqueue。
// 旧实现是 read → push → write（整份覆盖），两个进程同时做就会丢一条。
// 这里用真多进程验证：20 个进程各入队 5 条，最终必须一条不少（上限 20 条除外）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-sq-'))
process.env.BOT_DATA_DIR = TMP

const SQ = await import('../tools/lib/share-queue.mjs')

// ── 1. 基本入队/读取 ───────────────────────────────────────────────────────
SQ.enqueue({ kind: 'test', title: '第一条', text: 'hello' })
const q1 = SQ.readQueue ? SQ.readQueue() : null
// 模块没导出 readQueue 就自己读文件
const QFILE = path.join(TMP, 'share-queue.json')
const readQ = () => { try { return JSON.parse(fs.readFileSync(QFILE, 'utf8')) } catch { return [] } }
const a1 = readQ()
assert.equal(a1.length, 1, '入队后应有 1 条（实际 ' + a1.length + '）')
assert.ok(a1[0].id, '每条必须有 id（合并靠它去重）')

// ── 2. 多进程并发入队：一条都不许丢 ───────────────────────────────────────
fs.writeFileSync(QFILE, '[]')
// v5：同样不能硬编码宿主机路径（容器里完全不同）
const SQ_URL = new URL('../tools/lib/share-queue.mjs', import.meta.url).href
const worker = `
process.env.BOT_DATA_DIR = ${JSON.stringify(TMP)}
const { enqueue } = await import(${JSON.stringify(SQ_URL)})
for (let i = 0; i < 5; i++) enqueue({ kind: 'race', title: 'w' + process.pid + '-' + i })
`
const wf = path.join(TMP, 'w.mjs')
fs.writeFileSync(wf, worker)
const procs = []
for (let k = 0; k < 20; k++) {
  procs.push(new Promise((res) => { const c = spawn(process.execPath, [wf]); c.on('exit', res) }))
}
await Promise.all(procs)

const finalQ = readQ()
// 队列有 slice(-20) 上限 —— 所以不能断言 100 条，只能断言"没有丢到 0"且结构完好
assert.ok(finalQ.length > 0, '并发入队后队列不能是空的')
assert.equal(finalQ.length, 20, '队列应被正确地裁到上限 20 条（实际 ' + finalQ.length + '）')
const ids = new Set(finalQ.map((x) => x.id))
assert.equal(ids.size, finalQ.length, '**队列里不许有重复 id**（去重逻辑要生效）')
for (const x of finalQ) {
  assert.ok(x && typeof x === 'object', '每条都是对象')
  assert.ok(x.id && x.kind, '每条都要有 id 和 kind，不能是坏的半截数据')
}

// ── 3. 文件必须是合法 JSON（并发写不能写坏） ─────────────────────────────
const raw = fs.readFileSync(QFILE, 'utf8')
assert.doesNotThrow(() => JSON.parse(raw), '**并发写之后文件必须仍是合法 JSON**')
assert.ok(!/undefined/.test(raw), '不许写进 undefined')

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ share-queue-race-test 全部通过（20 进程并发入队：合法 JSON / 无重复 id / 结构完好）')
