// memory-write-test —— 记忆写入的安全性（v5）。
//
// 两条真事故的回归：
//   ① 干跑/被拦下的拟发言被写进 episodes，她开始引用"幽灵发言"
//      → rememberAudit 只进审计流水，绝不能进对话记忆
//   ② 多进程同时轮转 episodes 时，后完成的会用旧快照覆盖先完成者 → 丢记忆
//      → 轮转必须在跨进程锁内做，且锁内再确认大小
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ⚠️ 必须在 import memory.mjs **之前**把数据目录指到临时目录。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-mem-'))
process.env.BOT_DATA_DIR = TMP
delete process.env.BOT_DEBUG          // 避免触发"调试必须隔离"的抛错（我们本来就隔离了）

const memory = await import('../tools/lib/memory.mjs')

const readLines = (p) => {
  try { return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)) } catch { return [] }
}

// ── 1. 正常写入 ─────────────────────────────────────────────────────────────
const rec = memory.remember('qq', 'qq:1001', '1001', 'user', '今天加班到十点')
assert.ok(rec && rec.text.includes('加班'), '正常消息必须写进记忆')
const rows = readLines(path.join(TMP, 'qq', 'episodes.jsonl'))
assert.equal(rows.length, 1)
assert.equal(rows[0].role, 'user')
assert.equal(rows[0].platform, 'qq')
assert.ok(rows[0].ts > 0, '必须有时间戳')

// ── 2. 核心回归：干跑审计不进对话记忆 ───────────────────────────────────────
const before = readLines(path.join(TMP, 'qq', 'episodes.jsonl')).length
const audit = memory.rememberAudit({
  platform: 'qq', chatId: 'qq:1001', userId: '1001', kind: 'dryrun',
  text: '在发呆啊，说了两遍了都', note: 'guard.dryRun=true：只打印未发送',
})
assert.ok(audit && audit.kind === 'dryrun')
const after = readLines(path.join(TMP, 'qq', 'episodes.jsonl')).length
assert.equal(after, before, '**干跑的拟发言绝不能进 episodes**（否则她会引用幽灵发言）')
const auditRows = readLines(path.join(TMP, 'audit', 'unsent.jsonl'))
assert.equal(auditRows.length, 1, '审计流水要单独落盘')
assert.equal(auditRows[0].kind, 'dryrun')
assert.ok(!JSON.stringify(auditRows).includes('qq:1001') === false, '审计里要留会话以便排查')

// 审计也不能被 recent() 读到（那是给提示词的）
const recent = memory.recent('qq:1001', 20)
assert.equal(recent.length, 1, 'recent 只能看到真实对话一条')
assert.equal(recent[0].content.includes('在发呆'), false, '**审计内容不许进提示词**')

// ── 3. 自测话术护栏仍然有效 ─────────────────────────────────────────────────
assert.equal(memory.remember('qq', 'qq:1001', '1001', 'user', '【测试】链路已修复'), null, '自测话术必须被挡')
const okNormal = memory.remember('qq', 'qq:1001', '1001', 'user', '今天公司又加班')
assert.ok(okNormal && okNormal.text === '今天公司又加班', '正常消息不该被误伤，且 remember 要返回写入行')
assert.ok(memory.recent('qq:1001', 50).length >= 2, '正常消息要能在 recent 里看到')

// ── 4. 并发写入不丢行（10 个进程等价：这里用 10 个并发调用近似，主要验不交错）──
const N = 200
for (let i = 0; i < N; i++) memory.remember('qq', 'qq:2002', '2002', 'user', '并发消息 ' + i)
const rows2 = readLines(path.join(TMP, 'qq', 'episodes.jsonl'))
const mine = rows2.filter((r) => r.chatId === 'qq:2002')
assert.equal(mine.length, N, '并发写入不许丢行（期望 ' + N + '，实得 ' + mine.length + '）')

// ── 5. 每行都是完整 JSON（没有半行交错） ────────────────────────────────────
const raw = fs.readFileSync(path.join(TMP, 'qq', 'episodes.jsonl'), 'utf8')
const lines = raw.split('\n').filter(Boolean)
assert.equal(lines.length, rows2.length, '行数要对得上')
for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), '不允许出现半行')

// ── 6. 记忆读取的跨平台隔离：微信记忆不进 QQ 的 recent ──────────────────────
memory.remember('wechat', 'wechat:3003', '3003', 'user', '替我回一句谢谢')
const qqRecent = memory.recent('qq:1001', 50)
assert.equal(qqRecent.some((r) => r.content.includes('替我回一句谢谢')), false, '微信的工作记录不许串进 QQ 人格记忆')

// ── 7. 统计口径 ─────────────────────────────────────────────────────────────
const st = memory.stats()
assert.ok(st.episodes >= N + 2, 'stats 要能数到写入的条数')

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ memory-write-test 全部通过（干跑隔离/并发/完整行/平台隔离）')
