// brain/attention 测试：紧迫度排序、同 chat 合并、生成租约（不打断半句）、
// 队列消费与丢弃线、busyLine。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-attention-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const at = await import('../tools/brain/attention.mjs')
const now = Date.now()

// ① urgencyOf：主人私聊 @ 的连续重要消息 > 群里随口一句
const uOwner = at.urgencyOf({ isOwner: true, isPrivate: true, atMe: true, streak: 4, important: true })
const uStray = at.urgencyOf({ streak: 1 })
ok('主人私聊紧迫度显著高于群里随口', uOwner > uStray + 0.3, `${uOwner} vs ${uStray}`)
ok('紧迫度夹在 [0,1]', uOwner <= 1 && uStray >= 0)
ok('等待越久紧迫度越高', at.urgencyOf({ waitedMin: 30 }) > at.urgencyOf({ waitedMin: 0 }))

// ② arrive：同 chat 合并只留最高紧迫度，跨 chat 排序
at.arrive({ chat: 'qq:a', urgency: 0.4, now })
at.arrive({ chat: 'qq:a', urgency: 0.9, now: now + 1 })   // 同 chat 升级
at.arrive({ chat: 'qq:b', urgency: 0.5, now: now + 2 })
let st = at.state()
ok('同 chat 合并（qq:a 只剩一条且取 0.9）',
  st.inbox.filter((x) => x.chat === 'qq:a').length === 1
  && st.inbox.find((x) => x.chat === 'qq:a').urgency === 0.9)
ok('队列按紧迫度降序', st.inbox[0].chat === 'qq:a')

// ③ next / done：消费与移除
const head = at.next(now)
ok('next 给优先级最高的 qq:a', head && head.chat === 'qq:a')
at.done('qq:a')
ok('done 后队列里没有 qq:a 了', at.state().inbox.every((x) => x.chat !== 'qq:a'))

// ④ 租约：一个时刻只有一个"正在生成"
const c1 = at.claim('qq:a', 'proc1', { ttlMs: 60_000, now })
ok('空闲时租约可拿', c1.ok === true && typeof c1.fencing === 'number')
const c2 = at.claim('qq:b', 'proc2', { ttlMs: 60_000, now: now + 1 })
ok('别的 chat 来抢 → busy（不打断正在生成的）', c2.ok === false && c2.reason === 'busy' && c2.busyWith === 'qq:a')
const c3 = at.claim('qq:a', 'proc2', { ttlMs: 60_000, now: now + 2 })
ok('同 chat 第二个生成者 → same-chat-busy', c3.ok === false && c3.reason === 'same-chat-busy')
at.release('qq:a', 'proc1')
const c4 = at.claim('qq:b', 'proc2', { ttlMs: 60_000, now: now + 3 })
ok('释放后别人能拿到', c4.ok === true)
at.release('qq:b', 'proc2')

// ⑤ 租约过期后可以接管（ttl 到期不算 alive）
const c5 = at.claim('qq:c', 'proc3', { ttlMs: 10, now: now + 4 })
const c6 = at.claim('qq:d', 'proc4', { ttlMs: 60_000, now: now + 4_000 })
ok('租约过期后别人可接管', c5.ok === true && c6.ok === true, JSON.stringify([c5.reason, c6.reason]))
at.release('qq:d', 'proc4')

// ⑥ busyLine：没人租约时是空串
ok('无租约时 busyLine 为空', at.busyLine(now + 5_000) === '')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ brain-attention 全部通过')
process.exit(bad ? 1 : 0)
