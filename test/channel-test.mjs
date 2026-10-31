// channel-test —— 统一队列的并发语义（v5 新增，之前**完全没有测试**）。
//
// 三条契约（用户在第六轮明确要的）：
//   ① 同会话严格串行：先来的先答，绝不并行答两次
//   ② 不同会话并行：A 慢不挡 B
//   ③ 同会话连发合并：窗口内的多条合成一批，只回一次
// 外加：TTL 丢弃、积压上限、异常不炸队列。
import assert from 'node:assert'
import { UnifiedChannel } from '../tools/lib/channel.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mk = (chatId, text) => ({ chatId, platform: 'qq', evt: { __text: text, message_id: 'm' + Math.random() }, at: Date.now() })

// ── 1. 同会话串行 ───────────────────────────────────────────────────────────
{
  const ch = new UnifiedChannel({ debounceMs: 10, maxConcurrency: 4 })
  const order = []
  let running = 0
  let maxRunning = 0
  ch.onHandle(async (batch) => {
    running++; maxRunning = Math.max(maxRunning, running)
    const t = batch.text
    order.push('start:' + t)
    await sleep(30)
    order.push('end:' + t)
    running--
  })
  // 注意：间隔必须 > debounceMs 才不会被合并 —— 这一段测的是"串行"，不是"合并"
  ch.push(mk('a', '1'))
  await sleep(120)
  ch.push(mk('a', '2'))
  await sleep(120)
  ch.push(mk('a', '3'))
  await sleep(260)
  assert.equal(maxRunning, 1, '同会话必须串行（峰值并发 = 1）')
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'], '先来先答，顺序不许乱')
}

// ── 2. 不同会话并行 ─────────────────────────────────────────────────────────
{
  const ch = new UnifiedChannel({ debounceMs: 10, maxConcurrency: 4 })
  let running = 0
  let peak = 0
  const started = []
  ch.onHandle(async (batch) => {
    running++; peak = Math.max(peak, running)
    started.push(batch.chatId)
    await sleep(40)
    running--
  })
  const t0 = Date.now()
  ch.push(mk('a', 'a1')); ch.push(mk('b', 'b1')); ch.push(mk('c', 'c1'))
  await sleep(200)
  assert.equal(peak >= 2, true, '不同会话必须能并行（峰值并发 >= 2）')
  assert.equal(started.length, 3)
  assert.ok(Date.now() - t0 < 300, '并行不应该串成 3×40ms 的长队')
}

// ── 3. 同会话连发合并成一批 ─────────────────────────────────────────────────
{
  const ch = new UnifiedChannel({ debounceMs: 60, maxConcurrency: 4 })
  const batches = []
  ch.onHandle(async (b) => { batches.push({ n: b.items.length, text: b.text, merged: b.merged }) })
  ch.push(mk('a', '在吗')); ch.push(mk('a', '我跟你说个事')); ch.push(mk('a', '今天被老板骂了'))
  await sleep(200)
  assert.equal(batches.length, 1, '窗口内的连发只回一次')
  assert.equal(batches[0].n, 3)
  assert.equal(batches[0].merged, true)
  assert.equal(batches[0].text, '在吗\n我跟你说个事\n今天被老板骂了', '合并文本按到达顺序')
}

// ── 4. 全局并发上限 ─────────────────────────────────────────────────────────
{
  const ch = new UnifiedChannel({ debounceMs: 5, maxConcurrency: 2 })
  let running = 0
  let peak = 0
  ch.onHandle(async () => { running++; peak = Math.max(peak, running); await sleep(40); running-- })
  for (const id of ['a', 'b', 'c', 'd', 'e']) ch.push(mk(id, 'x'))
  await sleep(400)
  assert.ok(peak <= 2, '不得超过 maxConcurrency（实测峰值 ' + peak + '）')
}

// ── 5. TTL 过期消息丢弃 ─────────────────────────────────────────────────────
{
  const ch = new UnifiedChannel({ debounceMs: 5, ttlMs: 30 })
  let handled = 0
  ch.onHandle(async () => { handled++ })
  ch.push({ chatId: 'a', platform: 'qq', evt: { __text: 'old' }, at: Date.now() - 10_000 })
  await sleep(80)
  assert.equal(handled, 0, '过期消息不该再回')
  assert.equal(ch.stats.dropped >= 1, true, '丢过的要记账')
}

// ── 6. 单会话积压上限：丢最老的，保住最新的话 ───────────────────────────────
{
  const ch = new UnifiedChannel({ debounceMs: 1000, maxQueuePerChat: 3 })
  for (let i = 1; i <= 6; i++) ch.push(mk('a', String(i)))
  const q = ch.queues.get('a')
  assert.equal(q.length, 3, '积压要被限制在上限内')
  assert.equal(q[q.length - 1].evt.__text, '6', '最新的话必须还在')
  assert.equal(ch.stats.dropped, 3)
}

// ── 7. handler 抛错不能炸队列，后面的继续 ───────────────────────────────────
{
  const ch = new UnifiedChannel({ debounceMs: 5, maxConcurrency: 1 })
  const seen = []
  let first = true
  ch.onHandle(async (b) => {
    seen.push(b.text)
    if (first) { first = false; throw new Error('boom') }
  })
  ch.push(mk('a', '1')); await sleep(50)
  ch.push(mk('a', '2')); await sleep(50)
  assert.deepEqual(seen, ['1', '2'], '第一条炸了，第二条仍要处理')
  assert.equal(ch.stats.errors, 1)
}

// ── 8. snapshot 形状（面板/health 依赖） ────────────────────────────────────
{
  const ch = new UnifiedChannel({ debounceMs: 5 })
  ch.push(mk('a', 'x'))
  const s = ch.snapshot()
  for (const k of ['enqueued', 'merged', 'handled', 'dropped', 'errors', 'peakQueue', 'peakRunning', 'runningChats', 'queuedTotal', 'perChat']) {
    assert.ok(k in s, 'snapshot 缺字段 ' + k)
  }
}

console.log('✓ channel-test 全部通过（串行/并行/合并/限流/TTL/积压/容错）')
