// nightwork · 结果记账测试（2026-11-05）
//
// 要防的事故：`nightwork tidy` 把"0 条待处理"记成 `processed: "?"`（未知）。
//
// 根因是两个坑叠在一起：
//   ① `(c.processed != null && c.processed) || c.extracted`
//      —— `processed === 0` 时前半段求值为 `0`（假值）→ 短路去取 `|| c.extracted`
//   ② `extracted` 这个字段在 run() 的返回里根本不存在 → undefined
//   → `n = undefined` → 结果文件写 `processed: "?"`
//
// 为什么这值得一套测试：`"?"` 看上去像"查不到"，而实际上那是一次**正确的空跑**。
// 把正确记成可疑，会让人（和未来接手的人）去排查一个不存在的问题 ——
// 本项目已经因为"正确被记成错误"浪费过好几轮。
//
// 断言：
//   ① 无待处理 → processed 必须是数字 0（不是 "?"）
//   ② 有待处理 → processed 是实际条数
//   ③ 无论哪条路，结果文件都要带 `llm` 与 `clusters`（供血判据要能看见）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-nightwork-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_BRAIN_MIRROR = '0'

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }

const episode = await import('../tools/brain/episode.mjs')
const event = await import('../tools/brain/event.mjs')
const consolidate = await import('../tools/brain/consolidate.mjs')
const nightwork = await import('../tools/commands/nightwork.mjs')

const stamp = 't-' + Date.now()
const readResult = (s) => JSON.parse(fs.readFileSync(path.join(tmp, 'nights', `${s}-tidy.json`), 'utf8'))

// ── ① 空跑：processed 必须是 0，不是 "?" ─────────────────────────────
await nightwork.run(['tidy', '--stamp', stamp])
const r1 = readResult(stamp)
ok('空跑 processed 是数字 0', r1.processed === 0, JSON.stringify({ processed: r1.processed, typeof: typeof r1.processed }))
ok('空跑不是 "?"（正确不该记成未知）', r1.processed !== '?')
ok('空跑带 llm 判据', typeof r1.llm === 'boolean', `llm=${r1.llm}`)
ok('空跑带 clusters', typeof r1.clusters === 'number', `clusters=${r1.clusters}`)
ok('空跑 llmCalls 为 0', r1.llmCalls === 0, `llmCalls=${r1.llmCalls}`)

// ── ② 有活：processed 是实际条数 ──────────────────────────────────────
// 用规则抽得到的句子，避免依赖外网 LLM（这套测试必须离线可跑）
const lines = [
  '我中午吃了烧鸭饭',
  '我在公司开会一直开到五点',
  '我明天要去看牙',
]
for (const [i, text] of lines.entries()) {
  event.emit({ proc: 'c', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text, isOwner: true, msgId: `n-${i}` })
}
episode.ingest({ limit: 50 })
const pending = consolidate.status().pending
ok('造出了待处理', pending >= 3, `pending=${pending}`)

const stamp2 = stamp + '-b'
await nightwork.run(['tidy', '--stamp', stamp2])
const r2 = readResult(stamp2)
ok('有活时 processed 等于处理条数', r2.processed === pending, `processed=${r2.processed} pending=${pending}`)
ok('有活时 processed 是数字', typeof r2.processed === 'number', typeof r2.processed)

// ── ③ 规则阶段就该抽出事实（不依赖 LLM）──────────────────────────────
const facts = await import('../tools/brain/facts.mjs')
ok('规则阶段抽出了事实', facts.stats().total >= 2, `facts=${facts.stats().total}`)
ok('有活时 llmCalls 可为 0（规则已覆盖）', r2.llmCalls >= 0, `llmCalls=${r2.llmCalls}`)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
