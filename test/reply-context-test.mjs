// reply-context-test —— 并发上下文隔离的单测（v5 最重要的一条回归）。
//
// 这条测试对应一个真实 P0：旧版用闭包变量 CUR_PLATFORM / CUR_CHAT，
// 两个会话并发时，A 会话 await 之后读到的平台可能已经被 B 会话改掉，
// 于是回复发错平台 / 发错人。AsyncLocalStorage 修好后，这里必须永远对。
import assert from 'node:assert'
import { runWithContext, current, currentPlatform, currentChat, withContext } from '../tools/lib/reply-context.mjs'

// ── 1. 没有上下文 ───────────────────────────────────────────────────────────
assert.equal(current(), null)
assert.equal(currentPlatform(), 'qq', '默认平台保持 qq（与旧行为一致）')
assert.equal(currentPlatform('wechat'), 'wechat')
assert.equal(currentChat('fallback'), 'fallback')

// ── 2. 基本读写 ─────────────────────────────────────────────────────────────
await runWithContext({ platform: 'wechat', chatId: 'wechat:u1', userId: 'u1' }, async () => {
  assert.equal(currentPlatform(), 'wechat')
  assert.equal(currentChat(), 'wechat:u1')
  assert.equal(current().userId, 'u1')
  assert.equal(current().isGroup, false)

  // 3. 嵌套上下文必须能覆盖、退出后恢复
  await runWithContext({ platform: 'qq', chatId: 'qq:g9', isGroup: true }, async () => {
    assert.equal(currentPlatform(), 'qq')
    assert.equal(current().isGroup, true)
  })
  assert.equal(currentPlatform(), 'wechat', '嵌套退出后必须恢复外层')
})
assert.equal(current(), null, '退出后必须干净（不泄漏到下一次请求）')

// ── 4. 核心回归：并发交错不得串台 ───────────────────────────────────────────
// 模拟 4 个会话同时跑，每个都在中途 await 让出事件循环，最后各自断言自己的平台。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jobs = [
  { platform: 'qq', chatId: 'qq:1001', delay: 30 },
  { platform: 'wechat', chatId: 'wechat:2002', delay: 10 },
  { platform: 'qq', chatId: 'qq:3003', delay: 20 },
  { platform: 'wechat', chatId: 'wechat:4004', delay: 5 },
]
const results = await Promise.all(jobs.map((j) => runWithContext(j, async () => {
  await sleep(j.delay)                       // 中途让出，给别的会话"改状态"的机会
  const mid = { platform: currentPlatform(), chatId: currentChat() }
  await sleep(j.delay)
  return { mid, end: { platform: currentPlatform(), chatId: currentChat() } }
})))

results.forEach((r, i) => {
  assert.equal(r.mid.platform, jobs[i].platform, '中途读到的平台必须是自己（' + jobs[i].chatId + '）')
  assert.equal(r.mid.chatId, jobs[i].chatId)
  assert.equal(r.end.platform, jobs[i].platform, '末尾读到的平台必须还是自己（' + jobs[i].chatId + '）')
  assert.equal(r.end.chatId, jobs[i].chatId)
})

// ── 5. 上下文是只读的（防止有人顺手改） ─────────────────────────────────────
await runWithContext({ platform: 'qq', chatId: 'qq:1' }, () => {
  assert.throws(() => { 'use strict'; current().platform = 'wechat' }, /read only|Cannot assign/i)
})

// ── 6. withContext 别名可用 ────────────────────────────────────────────────
withContext({ platform: 'wechat', chatId: 'wechat:9' }, () => {
  assert.equal(currentPlatform(), 'wechat')
})

console.log('✓ reply-context-test 全部通过（含 4 会话并发隔离回归）')
