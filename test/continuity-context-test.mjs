// 连贯性改造的验收探针（隔离沙箱）
//
// 验四件事，都是"用户能不能感觉到"级别的：
//   ① 历史行带相对时间前缀（`[2 小时前]`），且老数据（无 ts）不编时间
//   ② 跨会话有断点：`【上次断在哪】` 出现，含"最后是谁说的"
//   ③ 未了话头：inner 池里有 pending 时出现一行
//   ④ 没把预算撑爆：system 字数仍在上限内
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-continuity-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_BRAIN_MIRROR = '0'

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }

const R = '../tools'
const memory = await import(R + '/lib/memory.mjs')
const persona = await import(R + '/lib/persona.mjs')
const inner = await import(R + '/brain/inner.mjs')
const paths = await import(R + '/lib/paths.mjs')

const chatId = 'qq:900001'
const uid = '900001'
const now = Date.now()

// ── 准备：造三段历史，时间分别 3 小时前 / 40 分钟前 / 2 分钟前 ─────────
const mk = (role, text, at) => {
  const rec = { ts: at, platform: 'qq', chatId, userId: uid, role, text, summary: text.slice(0, 120) }
  const dir = path.dirname(paths.dataPath('qq', 'episodes.jsonl'))
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(paths.dataPath('qq', 'episodes.jsonl'), JSON.stringify(rec) + '\n')
}
mk('user', '今天好累啊，加班到现在', now - 3 * 3600_000)
mk('assistant', '那先去洗个澡，别硬撑', now - 3 * 3600_000 + 60_000)
mk('user', '洗完了，还是睡不着', now - 40 * 60_000)
mk('assistant', '那就躺着别刷手机了', now - 40 * 60_000 + 30_000)
mk('user', '你呢，你在干嘛', now - 2 * 60_000)

// 一条没有 ts 的老数据 —— 不许被编时间
const legacyDir = path.dirname(paths.dataPath('qq', 'episodes.jsonl'))
fs.appendFileSync(paths.dataPath('qq', 'episodes.jsonl'),
  JSON.stringify({ platform: 'qq', chatId, userId: uid, role: 'user', text: '老数据没有时间戳' }) + '\n')

// inner 池里放一条未说的话
inner.think('我一直想问他昨晚到底几点睡的', { kind: 'worry', about: 'owner' })

const msgs = persona.buildMessages({ platform: 'qq', userText: '在吗', chatId, userId: uid, turnsToday: 3, isGroup: false, quote: '' })

const flat = msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
const userLines = msgs.filter((m) => m.role === 'user').map((m) => String(m.content))

// ── ① 时间前缀 ───────────────────────────────────────────────────────
ok('历史行带"3 小时前"', /\[3 小时前\]/.test(flat), (flat.match(/\[[^\]]*前\]/g) || []).slice(0, 3).join(','))
ok('历史行带"分钟前"', /\[\d+ 分钟前\]/.test(flat))
ok('老数据（无 ts）没被编时间', !/\[[^\]]*\][^\n]*老数据没有时间戳/.test(flat))

// ── ② 断点 ──────────────────────────────────────────────────────────
ok('出现【上次断在哪】', flat.includes('【上次断在哪】'))
// 断点必须指到**真的最后一句话**，而不是那条没有 ts 的脏数据。
// 这一条是实测抓出来的：第一版直接取 recent 的 last，于是断点变成
// 「上次最后是他说的：「老数据没有时间戳…」」—— 比没有断点更糟。
ok('断点指的是真实最后一句（不是无时间戳的脏行）',
  /上次最后是(你|他)说的：「你呢，你在干嘛…」/.test(flat),
  (flat.match(/上次最后是[^\n]*/) || ['（无）'])[0].slice(0, 70))
ok('断点带时间', /上次最后是[^\n]*（\d+ 分钟前）/.test(flat))

// ── ③ 未了话头 ───────────────────────────────────────────────────────
ok('出现未了话头', flat.includes('你一直有件事没说出来'))

// ── ④ 预算 ──────────────────────────────────────────────────────────
const sysLen = String(msgs[0].content).length
ok('system 仍在预算内（5650）', sysLen <= 5650, `${sysLen} 字`)

// ── ⑤ 断点不重复注入到他说的那句话里（结构没坏）──────────────────────
const lastUser = userLines[userLines.length - 1] || ''
ok('最后一条 user 含本轮输入', lastUser.includes('在吗'))
ok('cue 块挂在最后一条 user 上（不是单独的 system）', lastUser.includes('【上次断在哪】'))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
