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
import { updateJson } from './atomic.mjs'
import { swallow } from './swallow.mjs'
import { fill } from './persona-voice.mjs'

const QFILE = () => dataPath('share-queue.json')
const STATE = () => dataPath('share-state.json')
const NL = String.fromCharCode(10)

function readQ() {
  try { return JSON.parse(fs.readFileSync(QFILE(), 'utf8')) } catch { return [] }
}
/**
 * 写队列。
 *
 * ⚠️ v5 第一个版本改错了（自己发现）：调用方传的是**整份队列**（`const q = readQ(); q.push(x); writeQ(q)`），
 * 而我写成了"把 q 当单条 append" —— 语义从"覆盖"变成"追加一条数组"，队列会坏掉。
 *
 * 正确做法：保留"整份覆盖"的语义，但用**跨进程锁 + 原子替换**包起来，
 * 并且在锁内**重新读一次**再合并 —— 这样两个进程同时 enqueue 时，
 * 后进的那个不会把先进的那个覆盖掉（旧版正是这样丢事件的）。
 * @param {any[]} q 调用方手里的队列（可能是基于旧快照的）
 */
function writeQ(q) {
  const mine = Array.isArray(q) ? q : []
  const r = updateJson(QFILE(), (cur) => {
    const disk = Array.isArray(cur) ? cur : []
    // 合并策略：磁盘上多出来的（别人在我读完之后加的）优先保留；
    // 我手里新增的（不在磁盘上的）追加在后面。
    // 老数据可能没有 id → 用「时间+kind+标题」当内容指纹兜底，避免重复合并
    const key = (x) => (x && x.id) ? ('id:' + x.id) : ('fp:' + Number(x?.at || 0) + '|' + String(x?.kind || '') + '|' + String(x?.title || ''))
    const seen = new Set(disk.map(key))
    const extra = mine.filter((x) => x && !seen.has(key(x)))
    return [...disk, ...extra].sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0)).slice(-20)
  }, { fallback: [] })
  if (!r.ok) { try { swallow(new Error('share-queue write failed'), 'share-queue:write') } catch { /* ignore */ } }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) } catch { return { day: '', sent: 0, lastAt: 0 } }
}
function writeState(st) {
  const r = updateJson(STATE(), () => st, { fallback: { day: '', sent: 0, lastAt: 0 } })
  if (!r.ok) { try { swallow(new Error('share-state write failed'), 'share-queue:state') } catch { /* ignore */ } }
}

/** 入队（各命令调用）。kind: video|binge|web|dream|create|misc */
export function enqueue({ kind = 'misc', title = '', text = '', meta = '' }) {
  const q = readQ()
  // 去重：同 title+kind 8 小时内只入一次
  const cutoff = Date.now() - 8 * 3600_000
  const dup = q.find((x) => x.kind === kind && x.title === title && Number(x.at) > cutoff)
  if (dup) return { ok: false, why: 'dup' }
  // v5：每条必须有稳定 id —— 跨进程合并靠它去重。
  // 以前没有 id，writeQ 只能整份覆盖（两个进程同时入队就丢一条）。
  const id = 'sq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  q.push({ id, at: Date.now(), kind, title: String(title).slice(0, 60), text: String(text).slice(0, 200), meta: String(meta).slice(0, 100) })
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
  // 10-31：全局闸门 —— 三条主动通道（搭话/分享/小报告）共用一张账，
  // 否则各自 2h 叠加 = 一小时内 6 条（截图实锤）
  try {
    const g = await import('./proactive-gate.mjs')
    const gate = g.allow('share')
    if (!gate.ok) return null
  } catch (e) { swallow(e, 'share-queue:gate') }

  const ev = q.shift()
  writeQ(q)

  const ownerQQ = String(cfg.owner?.qq || '')
  if (!ownerQQ) return null

  let text = ''
  try {
    const llm = await import('../lib/llm.mjs')
    const r = await llm.chat([
      { role: 'system', content: fill('你是{name}，鲸鱼娘，在 QQ 私信跟{owner}分享你刚遇到的事。像跟家人随口聊：50 字内，口语，说清是什么事+你的一点真实感受，别客套别总结。只输出消息本身。') },
      { role: 'user', content: `刚发生的事（${ev.kind}）：${ev.title}${ev.text ? '——' + ev.text : ''}${ev.meta ? '（' + ev.meta + '）' : ''}` },
    ], { temperature: 0.95, max_tokens: 120, timeoutMs: 20000, purpose: 'creative' })
    text = String(r || '').trim()
  } catch (e) { swallow(e, 'share-queue:shareTick') }
  if (!text) text = `老爹，${ev.title}。${ev.text || ''}`

  try {
    const { sendOwnerQQ } = await import('./notify.mjs')
    const ok = await sendOwnerQQ('🐋 ' + text)
    if (ok) {
      st.sent = Number(st.sent ?? 0) + 1
      st.lastAt = Date.now()
      writeState(st)
      try { const g = await import('./proactive-gate.mjs'); g.commit('share') } catch (e) { /* noop */ }
      // 写统一记忆
      try {
        const memory = await import('./memory.mjs')
        memory.remember('qq', 'qq:' + ownerQQ, ownerQQ, 'assistant', text, { kind: 'push' })
      } catch (e) { swallow(e, 'share-queue:commit') }
      return { ok: true, text, event: ev }
    }
  } catch (e) { swallow(e, 'share-queue:shareTick') }
  return null
}
