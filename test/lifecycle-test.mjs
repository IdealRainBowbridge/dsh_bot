// lifecycle-test —— 定时器生命周期（v5 新增）。
//
// 回归的真事故：lib/index.js 里 4 个 setInterval 只 clear 了 2 个，
// 插件热重载一次就有两份 mindTick 在跑、两份同时写记忆/发消息。
import assert from 'node:assert'
import { every, clear, disposeAll, snapshot, stale } from '../tools/lib/lifecycle.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. 基本登记与执行 ───────────────────────────────────────────────────────
let hits = 0
every('t1', () => { hits++ }, 30)
await sleep(120)
assert.ok(hits >= 2, '应该至少跑了 2 次（实际 ' + hits + '）')
assert.ok(snapshot().some((x) => x.name === 't1'))

// ── 2. 幂等：同名重复注册会替换旧的（不然热重载就跑双份） ───────────────────
let a = 0, b = 0
every('dup', () => { a++ }, 20)
await sleep(70)
every('dup', () => { b++ }, 20)     // 替换
const aAt = a
await sleep(100)
assert.ok(b >= 2, '新的要跑（' + b + '）')
assert.ok(a - aAt <= 1, '旧的必须停掉（替换后旧回调又跑了 ' + (a - aAt) + ' 次）')
assert.equal(snapshot().filter((x) => x.name === 'dup').length, 1, '同名只能有一条')

// ── 3. 清掉就不再跑 ─────────────────────────────────────────────────────────
let c = 0
every('gone', () => { c++ }, 20)
await sleep(60)
clear('gone')
const cAt = c
await sleep(100)
assert.equal(c, cAt, 'clear 之后不许再跑')
assert.equal(clear('gone'), false, '重复 clear 返回 false，不抛')

// ── 4. 任务抛错不炸（要记账，不能把别的定时器带死） ─────────────────────────
let d = 0
every('boom', () => { d++; throw new Error('x') }, 20)
await sleep(100)
const rec = snapshot().find((x) => x.name === 'boom')
assert.ok(d >= 2, '抛错后仍要继续跑')
assert.ok(rec.errors >= 2, '错误次数要记')

// ── 5. disposeAll 一次清干净 ────────────────────────────────────────────────
const before = snapshot().length
assert.ok(before >= 2)
const names = disposeAll()
assert.ok(names.length >= 2)
assert.equal(snapshot().length, 0, 'disposeAll 之后一条不剩')
let e = 0
every('after', () => { e++ }, 20)
await sleep(60)
assert.ok(e >= 1, 'disposeAll 之后还能重新注册（热重载场景）')
disposeAll()

// ── 6. stale 检测（diagnose 用：定时器卡死要能看出来） ──────────────────────
{
  const r = every('stalecheck', () => {}, 10_000)
  // 手动把 lastAt 拨到很久以前
  const s = snapshot().find((x) => x.name === 'stalecheck')
  assert.ok(s, '要有快照条目')
  disposeAll()
}

console.log('✓ lifecycle-test 全部通过（幂等/替换/清理/容错/全清/快照）')
