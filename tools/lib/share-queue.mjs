// share-queue —— 分享欲队列：各处发生的"值得跟老爹说的事"先进这里，
// qq-server 的 tick 消费：评估时机（不骚扰）→ LLM 写成人话 → QQ 私信。
//
// 设计（10-31）：
//   - 生产者：bili-watch 深读（低分但有趣）、binge 看完一集、web 冲浪、梦境生成、
//     表情包/唱歌创作……任何地方调用 enqueue({ kind, title, text, meta })
//   - 消费者：shareTick()（60s tick 调用）：队列非空 → 节流判断（每日上限/最小间隔/
//     小报告互斥）→ LLM 把事件写成"跟老爹聊"的口吻 → 发送。
//   - 与 tattle（小报告）的关系：tattle 是"深读高分"专用通道（评分>=15，走正式汇报）；
//     share-queue 是"日常分享欲"通道（低分有趣/看完一集/刷到好玩的），更轻更随意。
//     两者互斥节流：2 小时内发过任意一条，另一条就缓。
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import { dataPath } from '../lib/paths.mjs'

const QFILE = () => dataPath('share-queue.json')
const STATE = () => dataPath('share-state.json')
const NL = String.fromCharCode(10)

function readQ() {
  try { return JSON.parse(fs.readFileSync(QFILE(), 'utf8')) } catch { return [] }
}
function writeQ(q) {
  fs.mkdirSync(dataPath('share-queue.json').replace('/share-queue.json', ''), { recursive: true })
  fs.writeFileSync(QFILE(), JSON.stringify(q.slice(-20), null, 1))
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) } catch { return { day: '', sent: 0, lastAt: 0 } }
}
function writeState(st) {
  fs.writeFileSync(STATE(), JSON.stringify(st, null, 1))
}

/** 入队（各命令调用）。kind: video|binge|web|dream|create|misc */
export function enqueue({ kind = 'misc', title = '', text = '', meta = '' }) {
  const q = readQ()
  // 去重：同 title+kind 8 小时内只入一次
  const cutoff = Date.now() - 8 * 3600_000
  const dup = q.find((x) => x.kind === kind && x.title === title && Number(x.at) > cutoff)
  if (dup) return { ok: false, why: 'dup' }
  q.push({ at: Date.now(), kind, title: String(title).slice(0, 60), text: String(text).slice(0, 200), meta: String(meta).slice(0, 100) })
  writeQ(q)
  return { ok: true, size: q.length }
}

/** 消费一条：节流判断 + LLM 写人话 + QQ 私信。返回 null=这次不该发。 */
export async function shareTick() {
  const q = readQ()
  if (!q.length) return null
  const cfg = config()
  const sc = cfg.tattle ?? {}
  const day = new Date().toLocaleDateString('sv-SE')
  const st = readState()
  if (st.day !== day) { st.day = day; st.sent = 0 }
  const max = Number(sc.dailyMax ?? 3) + Number(cfg.qq?.proactive?.dailyMax ?? 3)   // 与小报告+搭话共享预算
  if (Number(st.sent ?? 0) >= max) return null
  // 最小间隔：距上次任意主动消息 >= 2h（小报告/搭话/分享互斥）
  if (st.lastAt && Date.now() - Number(st.lastAt) < 2 * 3600_000) return null
  // 深夜不打扰
  const hour = new Date().getHours()
  if (hour < 9 || hour >= 23) return null

  const ev = q.shift()
  writeQ(q)

  const ownerQQ = String(cfg.owner?.qq || '')
  if (!ownerQQ) return null

  let text = ''
  try {
    const llm = await import('../lib/llm.mjs')
    const r = await llm.chat([
      { role: 'system', content: '你是大肥鱼，鲸鱼娘，在 QQ 私信跟笨蛋老爹分享你刚遇到的事。像跟家人随口聊：50 字内，口语，说清是什么事+你的一点真实感受，别客套别总结。只输出消息本身。' },
      { role: 'user', content: `刚发生的事（${ev.kind}）：${ev.title}${ev.text ? '——' + ev.text : ''}${ev.meta ? '（' + ev.meta + '）' : ''}` },
    ], { temperature: 0.95, max_tokens: 120, timeoutMs: 20000 })
    text = String(r || '').trim()
  } catch {}
  if (!text) text = `老爹，${ev.title}。${ev.text || ''}`

  try {
    const { sendOwnerQQ } = await import('./notify.mjs')
    const ok = await sendOwnerQQ('🐋 ' + text)
    if (ok) {
      st.sent = Number(st.sent ?? 0) + 1
      st.lastAt = Date.now()
      writeState(st)
      // 写统一记忆
      try {
        const memory = await import('./memory.mjs')
        memory.remember('qq', 'qq:' + ownerQQ, ownerQQ, 'assistant', text, { kind: 'push' })
      } catch {}
      return { ok: true, text, event: ev }
    }
  } catch {}
  return null
}
