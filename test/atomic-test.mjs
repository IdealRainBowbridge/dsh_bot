// atomic-test —— 跨进程"读-改-写"的安全性（v5 深度排查）。
//
// 这是本轮最重要的回归之一：
//   真实系统有 10+ 个进程写同一批状态文件（额度/动作/队列/情绪），
//   旧写法是无锁 read-modify-write。**实测 20 进程 × 50 次并发丢 28.8%。**
//   额度漏记 → 她超额发评论/点赞 → 平台风控。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { updateJson, readJsonSafe, writeJsonAtomic, acquireLock, bumpJson } from '../tools/lib/atomic.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-atomic-'))
const F = path.join(TMP, 'counter.json')

// ── 1. 基本读改写 ──────────────────────────────────────────────────────────
writeJsonAtomic(F, { n: 0 })
const r1 = updateJson(F, (cur) => { cur.n++; return cur })
assert.equal(r1.ok, true)
assert.equal(readJsonSafe(F).n, 1)

// ── 2. fallback：文件不存在时能建 ──────────────────────────────────────────
const F2 = path.join(TMP, 'new.json')
const r2 = updateJson(F2, (cur) => { const o = cur || {}; o.x = 1; return o })
assert.equal(r2.ok, true)
assert.equal(readJsonSafe(F2).x, 1)

// ── 3. mutate 返回 undefined = 不写 ───────────────────────────────────────
const before = fs.readFileSync(F2, 'utf8')
const r3 = updateJson(F2, () => undefined)
assert.equal(r3.ok, true)
assert.equal(fs.readFileSync(F2, 'utf8'), before, '返回 undefined 时不许改文件')

// ── 4. 损坏的 JSON 不崩，按 fallback 处理 ─────────────────────────────────
const F3 = path.join(TMP, 'broken.json')
fs.writeFileSync(F3, '{ this is not json')
assert.equal(readJsonSafe(F3, { safe: true }).safe, true, '坏文件必须回落 fallback 而不是抛')
const r4 = updateJson(F3, (cur) => ({ ...(cur || {}), fixed: true }), { fallback: {} })
assert.equal(r4.ok, true)
assert.equal(readJsonSafe(F3).fixed, true, '坏文件能被修复性写回')

// ── 5. 锁：同名锁不能同时被两个持有者拿到 ─────────────────────────────────
const L = path.join(TMP, 'x.lock')
const rel1 = acquireLock(L, { waitMs: 50 })
assert.ok(rel1, '第一把锁要能拿到')
const rel2 = acquireLock(L, { waitMs: 50 })
assert.equal(rel2, null, '**同一把锁不能被第二个持有者拿到**')
rel1()
const rel3 = acquireLock(L, { waitMs: 50 })
assert.ok(rel3, '释放之后要能重新拿到')
rel3()

// ── 6. 陈旧锁（持锁进程已死）要能自动清掉 ─────────────────────────────────
fs.writeFileSync(L, '999999 ' + new Date().toISOString())   // 不存在的 pid
const rel4 = acquireLock(L, { waitMs: 500 })
assert.ok(rel4, '**死进程留下的锁必须能自动清掉**（否则所有人都被卡死）')
rel4()

// ── 7. 核心回归：真多进程并发，一个都不许丢 ───────────────────────────────
writeJsonAtomic(F, { n: 0 })
// ⚠️ 不能硬编码 /srv/feiyu-sandbox/app —— 容器里插件在 /home/feiyu/plugins/dsh-feiyu。
// 用 import.meta.dirname 解析，测试在哪都能跑（v5 自测时踩过：容器里 20 个 worker 全部
// import 失败 → 计数 0 → 误判成"并发全丢"）。
const ATOMIC_URL = new URL('../tools/lib/atomic.mjs', import.meta.url).href
const worker = `
import { updateJson } from ${JSON.stringify(ATOMIC_URL)}
const F = ${JSON.stringify(F)}
for (let i = 0; i < 25; i++) {
  updateJson(F, (cur) => { const o = cur || {}; o.n = (o.n || 0) + 1; return o })
}
`
const wf = path.join(TMP, 'worker.mjs')
fs.writeFileSync(wf, worker)
const procs = []
for (let k = 0; k < 20; k++) {
  procs.push(new Promise((res) => { const c = spawn(process.execPath, [wf]); c.on('exit', res) }))
}
await Promise.all(procs)
const got = readJsonSafe(F).n
assert.equal(got, 500, '**20 进程 × 25 次必须精确等于 500，一条都不许丢**（实际 ' + got + '）')

// ── 8. bumpJson 快捷方式 ──────────────────────────────────────────────────
const F4 = path.join(TMP, 'bump.json')
writeJsonAtomic(F4, { hits: 7 })
assert.equal(bumpJson(F4, 'hits', 3).value, 10)

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ atomic-test 全部通过（原子写/锁/陈旧锁/20进程并发零丢失）')
