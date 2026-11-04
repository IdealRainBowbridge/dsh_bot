// memory.recent 双轨回退测试（2026-11-05）
//
// 要防的事故：`qq/episodes.jsonl` 不存在，而同一段对话完整躺在
// `brain/ep/2026-11.jsonl` —— `recent()` 返回 0 行，她每轮都像第一次说话。
//
// 这是"两套存储的读取端没接上"：写入侧一直在双写（memory.remember + brain.onEvent），
// 容器重建/清盘后旧文件没了、新库还在，于是"记忆突然全没了"——数据其实一条没丢。
//
// 三条断言，每条都对应一个可能做错的方向：
//   ① 旧库空 → 必须能从新脑读到（否则等于没修）
//   ② 旧库有 → **不许**混入新脑（两套库同一条对话会出现两次；去重会误删真实的重复发言）
//   ③ 顺序按时间正序、角色映射对（owner→user，她说→assistant），且带 at
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-recent-fb-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_BRAIN_MIRROR = '0'

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }

const memory = await import('../tools/lib/memory.mjs')
const paths = await import('../tools/brain/paths.mjs')
const libPaths = await import('../tools/lib/paths.mjs')

const chatId = 'qq:700001'
const now = Date.now()

// ── 造新脑情景库（旧库故意不建）─────────────────────────────────────
const epDir = paths.epDir()
fs.mkdirSync(epDir, { recursive: true })
const ym = new Date().toISOString().slice(0, 7)
const epFile = path.join(epDir, ym + '.jsonl')
const mkEp = (at, act, othersKind, quote, gist) => ({
  id: 'ep-test-' + at, at, atIso: new Date(at).toISOString(),
  who: { self: 'dsh_bot', others: othersKind ? [{ kind: othersKind, id: '700001', name: '用户' }] : [] },
  where: { platform: 'qq', chat: chatId, group: null }, scope: 'private',
  act, gist: gist || quote, quote, feel: { valence: 0, arousal: 0.3 }, salience: 0.4,
  entities: [], evidence: [], meta: {},
})
const eps = [
  mkEp(now - 3 * 3600_000, 'say', 'owner', '今天好累啊'),
  mkEp(now - 3 * 3600_000 + 60_000, 'say', null, '那先去洗个澡'),
  mkEp(now - 40 * 60_000, 'say', 'owner', '洗完了，还是睡不着'),
  mkEp(now - 40 * 60_000 + 30_000, 'say', null, '那就躺着别刷手机'),
  // 非对话的 act 必须被跳过
  mkEp(now - 20 * 60_000, 'action', null, '（看了会儿番）'),
  mkEp(now - 10 * 60_000, 'observe', null, '（刷到一条视频）'),
]
fs.writeFileSync(epFile, eps.map((e) => JSON.stringify(e)).join('\n') + '\n')

// ── ① 旧库空 → 回退到新脑 ───────────────────────────────────────────
const rows = memory.recent(chatId, 10)
ok('旧库不存在时从新脑读到对话', rows.length === 4, `rows=${rows.length}`)
ok('非 say 的 act 被跳过', !rows.some((r) => String(r.content).includes('看了会儿番')))
ok('owner 说 → role=user', rows[0].role === 'user', `first=${rows[0].role}`)
ok('她说 → role=assistant', rows[1].role === 'assistant', `second=${rows[1].role}`)
ok('带时间戳（时间前缀依赖它）', rows.every((r) => Number(r.at) > 0), `at0=${rows[0].at}`)
ok('按时间正序', rows[0].content === '今天好累啊' && rows[rows.length - 1].content === '那就躺着别刷手机',
  rows.map((r) => r.content.slice(0, 6)).join(','))

// ── ② 旧库有 → 不许混入新脑 ─────────────────────────────────────────
const oldFile = libPaths.dataPath('qq', 'episodes.jsonl')
fs.mkdirSync(path.dirname(oldFile), { recursive: true })
fs.writeFileSync(oldFile, JSON.stringify({
  ts: now - 60_000, platform: 'qq', chatId, userId: '700001', role: 'user',
  text: '旧库里的唯一一条', summary: '旧库里的唯一一条',
}) + '\n')
const rows2 = memory.recent(chatId, 10)
ok('旧库有数据时只读旧库', rows2.length === 1, `rows=${rows2.length}`)
ok('没有混入新脑的行', rows2[0].content === '旧库里的唯一一条', rows2[0].content.slice(0, 20))

// ── ③ 两个库都空 → 返回空数组，不抛 ─────────────────────────────────
fs.writeFileSync(oldFile, '')
const rows3 = memory.recent('qq:999999', 10)
ok('两库都无此会话时返回空（不抛）', Array.isArray(rows3) && rows3.length === 0)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
