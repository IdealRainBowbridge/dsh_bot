// brain/delivery 测试：交付证据的记账 —— 记进去能查回来，find 能按文本对上，
// last 是最新的那条，stats 数得清。这是"我说没说过"的唯一硬凭据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-delivery-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const delivery = await import('../tools/brain/delivery.mjs')
const HOUR = 3_600_000
const now = Date.now()

// ① record：写一条，字段齐全（hash/head 是核对的关键）
const r1 = delivery.record({ chat: 'qq:1', msgId: 'm1', text: '我今天看完了第五集，超好看', platform: 'qq', at: now - HOUR })
ok('record 返回带 hash/head 的行', !!r1.hash && r1.head.includes('第五集'))
ok('record 记了 chat 与 msgId', r1.chat === 'qq:1' && r1.msgId === 'm1')

// ② recent：按 chat 与时间窗过滤
delivery.record({ chat: 'qq:2', msgId: 'm2', text: '另一边说的另一句话', platform: 'qq', at: now - 2 * HOUR })
ok('recent(qq:1) 只给本 chat 的', delivery.recent({ chat: 'qq:1' }).every((r) => r.chat === 'qq:1'))
ok('recent 时间窗过滤（24h 都在）', delivery.recent({ minutes: 1440 }).length === 2, String(delivery.recent({ minutes: 1440 }).length))
ok('很老的查不到', delivery.recent({ minutes: 30 }).length === 0)

// ③ find：按文本找证据（匹配规则：head 前 12 字出现在待查文本，或反过来）
const f1 = delivery.find('第五集', { chat: 'qq:1' })
ok('find 用文本片段对上已发内容', f1.ok === true && f1.refs.length === 1)
ok('find 在别的 chat 找不到', delivery.find('第五集', { chat: 'qq:2' }).ok === false)
ok('find 空文本直接 false', delivery.find('').ok === false)

// ④ last：某 chat 最近一条
const l = delivery.last('qq:1', { minutes: 120 })
ok('last 返回 qq:1 最新一条', l && l.msgId === 'm1')
ok('没说过话的 chat last 为 null', delivery.last('qq:9') === null)

// ⑤ stats：24h 计数；last = 追加顺序的最后一条（qq:2 那条）
const st = delivery.stats({ now })
ok('stats.last24h = 2', st.last24h === 2, String(st.last24h))
ok('stats.last 是最后追加一条的时间', st.last === now - 2 * HOUR, String(st.last))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ brain-delivery 全部通过')
process.exit(bad ? 1 : 0)
