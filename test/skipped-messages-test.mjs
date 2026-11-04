// 看了但没接（10-31 第九轮）—— 沉默也要变成记忆。
//
// 锁九件事：
//   ① 记：决定不回时能记下来（太短的"嗯"不记）
//   ② 不重复：同会话同文本 10 分钟内只记一次
//   ③ 取一次就失效：注入过的不再重复注入（否则每轮都"翻旧账"）
//   ④ 只给本会话：别的 chatId 拿不到、也不消耗
//   ⑤ 一次最多 2 条
//   ⑥ 真接进 prompt：buildMessages 在真回话时带上这块
//   ⑦ 主动搭话（userText 空）不消耗它 —— 否则话还没回就先"用掉"了
//   ⑧ 群聊不注入
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 隔离必须在任何 import 之前（paths.mjs 在 import 时定死 HOME）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-skip-'))
process.env.USERPROFILE = TMP
process.env.HOME = TMP
delete process.env.DSH_HOME
process.env.BOT_DATA_DIR = path.join(TMP, '.bot-ai')
fs.mkdirSync(process.env.BOT_DATA_DIR, { recursive: true })
const cfgPath = path.join(TMP, 'bot.config.json')
fs.writeFileSync(cfgPath, JSON.stringify({ identity: { name: '理想的机械人', ownerTitle: '用户', selfClaim: '我' }, llm: { api_key: 'x' } }))
process.env.BOT_CONFIG = cfgPath

const SK = await import('../tools/lib/skipped-messages.mjs')
const persona = await import('../tools/lib/persona.mjs')

let pass = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name) } catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); process.exitCode = 1 }
}

console.log('看了但没接 测试')

ok('记住一句有内容的话', () => {
  SK.reset()
  assert.equal(SK.noteSkipped({ chatId: 'qq:1', text: '我今天好累啊，不想动' }), true)
  assert.equal(SK.stats().pending, 1)
})

ok('太短的（嗯/好的）不记', () => {
  SK.reset()
  assert.equal(SK.noteSkipped({ chatId: 'qq:1', text: '嗯' }), false)
  assert.equal(SK.noteSkipped({ chatId: 'qq:1', text: '好的' }), false)
  assert.equal(SK.stats().total, 0)
})

ok('同会话同文本 10 分钟内只记一次', () => {
  SK.reset()
  SK.noteSkipped({ chatId: 'qq:1', text: '我今天好累啊，不想动' })
  assert.equal(SK.noteSkipped({ chatId: 'qq:1', text: '我今天好累啊，不想动' }), false)
  assert.equal(SK.stats().total, 1)
})

ok('取一次就失效，不会每轮翻旧账', () => {
  SK.reset()
  SK.noteSkipped({ chatId: 'qq:1', text: '我今天好累啊，不想动' })
  const a = SK.takeSkipped('qq:1')
  assert.ok(a.includes('我今天好累啊'), '第一次应该拿得到：' + a)
  assert.ok(a.includes('上次你看到但没接'), '要带上下文说明')
  assert.equal(SK.takeSkipped('qq:1'), '', '第二次应该为空')
  assert.equal(SK.stats().pending, 0)
})

ok('只给本会话，别的 chatId 拿不到也不消耗', () => {
  SK.reset()
  SK.noteSkipped({ chatId: 'qq:1', text: '我今天好累啊，不想动' })
  assert.equal(SK.takeSkipped('qq:2'), '')
  assert.equal(SK.stats().pending, 1, '被别人问一次不该消耗掉')
})

ok('一次最多带 2 条（不铺开讲）', () => {
  SK.reset()
  for (const t of ['第一句话挺长的呢', '第二句话也挺长的', '第三句话也不短啊']) SK.noteSkipped({ chatId: 'qq:1', text: t })
  const s = SK.takeSkipped('qq:1')
  assert.equal(s.split('\n').filter((l) => l.startsWith('- ')).length, 2, '应该只提最近 2 条：' + s)
})

ok('buildMessages 在真回话时带上"没接的"', () => {
  SK.reset()
  SK.noteSkipped({ chatId: 'qq:9', text: '我昨天跟你说我腰疼来着' })
  const msgs = persona.buildMessages({ platform: 'qq', userText: '在吗', chatId: 'qq:9', userId: '9' })
  assert.ok(msgs[0].content.includes('我昨天跟你说我腰疼来着'), 'system 里应该带上没接的话')
})

ok('主动搭话（userText 为空）不消耗"没接的"', () => {
  SK.reset()
  SK.noteSkipped({ chatId: 'qq:9', text: '我昨天跟你说我腰疼来着' })
  const msgs = persona.buildMessages({ platform: 'qq', userText: '', chatId: 'qq:9', userId: '9' })
  assert.ok(!msgs[0].content.includes('我昨天跟你说我腰疼来着'), '主动搭话不该先把话用了')
  assert.equal(SK.stats().pending, 1, '应该还留着，等真回话时再提')
})

ok('群聊不注入（群里翻旧账很怪）', () => {
  SK.reset()
  SK.noteSkipped({ chatId: 'qq:group1', text: '群里有人说了一句挺长的话' })
  const msgs = persona.buildMessages({ platform: 'qq', userText: '在吗', chatId: 'qq:group1', userId: '1', isGroup: true })
  assert.ok(!msgs[0].content.includes('群里有人说了一句挺长的话'))
  assert.equal(SK.stats().pending, 1)
})

console.log(pass + ' 项通过')
