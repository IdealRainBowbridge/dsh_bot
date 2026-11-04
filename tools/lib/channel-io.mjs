// 统一通道的收发接口（10-31）—— 与具体平台解耦的入站/出站。
//
// 为什么独立：qq-server 是"OneBot 的宿主"，而**队列/合并/分流**是平台无关的。
// 把这两件事混在一个文件里，微信/抖音接入时只能复制粘贴 → 立刻分叉。
//
// 语义（和 OneBot 保持同形，handle 不用改）：
//   入站  POST /inbound   { platform, chatId, userId, text, at, isGroup, groupId, msgId }
//   出站  GET  /outbound?platform=wechat  → { items:[{ text, images, at }] }
//
// 出站为什么用"拉"而不是"推"：微信是 python、抖音可能又是别的语言，
// 让它们主动来取比自己实现一套 webhook 简单得多，也不会因为对方挂了丢消息。
//
// ⚠️ 2026-11-04 现状核对（架构检查 P2）：这条出站链路**当前没有消费者**。
//   · `pushOutbox` 的唯一调用点是 qq-server 收到非 QQ 平台的 `send_*`（当前无此来源）；
//   · `drainOutbox`（`GET /outbound`）没有任何进程在拉，`~/.data/outbox.json` 实测不存在；
//   · 微信 bot（`wechat/wechat_bot.py`，跑在 Windows 本机的 D:\wechat-bot\）自己直连
//     LLM、自己发消息，既不走 `/inbound` 也不拉 `/outbound` —— 与本文档第一段设想的
//     "三平台共用同一套人格/记忆" 不一致。
// 现在这里只保留**可用且被测试覆盖的机制**，不再假装微信已经接上；真要接，
// 动作是：微信侧把入站转发到 `POST /inbound`、并起一个循环 `GET /outbound?platform=wechat`。
// 在此之前 outbox.json 最多只有 200 条上限（MAX_OUT），不会无限涨。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'
import { updateJson } from './atomic.mjs'
import { isKnownPlatform, RETIRED_PLATFORMS } from './platforms.mjs'

const OUTBOX = () => dataPath('outbox.json')
const MAX_OUT = 200

export function readOutbox() {
  try { return JSON.parse(fs.readFileSync(OUTBOX(), 'utf8')) || [] } catch { return [] }
}
/**
 * 整表写入（保留给测试与显式覆盖）。生产路径一律走 updateJson：
 * outbox.json 是**多写者**文件（qq-server 主进程 + 未来任何通道进程），
 * 旧的 writeFileSync 是无锁读-改-写，并发下会丢条目。
 */
export function writeOutbox(list) {
  try {
    const f = OUTBOX()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(list.slice(-MAX_OUT), null, 1))
  } catch (e) { swallow(e, 'channel-io:write') }
}
/** 一条出站消息（非 QQ 平台用）。 */
export function pushOutbox({ platform, chatId, userId = '', text = '', images = [], meta = {} }) {
  const p = String(platform || '').trim()
  if (!p || !chatId) {
    // v5：入队必须有平台和会话，否则拉取端只能靠猜（旧版允许空 chatId 落库）
    return { ok: false, reason: 'platform-and-chatId-required' }
  }
  const row = {
    id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    at: Date.now(), platform: p, chatId: String(chatId), userId: String(userId || ''),
    text: String(text || '').slice(0, 4000),
    images: (images || []).slice(0, 4),
    ...meta,
  }
  // 原子读-改-写（2026-11-04）：两个进程同时入队时旧写法会丢一条。
  const r = updateJson(OUTBOX(), (cur) => {
    const q = Array.isArray(cur) ? cur : []
    q.push(row)
    return q.slice(-MAX_OUT)
  }, { fallback: [], waitMs: 1500 })
  if (!r.ok) return { ok: false, reason: r.error || 'write-failed' }
  return { ok: true, id: row.id, queued: r.value.length }
}
/** 取（并按需清空）某平台的出站。 */
export function drainOutbox(platform = '', { drain = true } = {}) {
  const p = String(platform || '').trim()
  // v5 修 P0：旧代码 `!platform || x.platform === platform` —— 不传 platform 时会
  // **把全部平台的出站消息一起取走并清空**。实测：qq + wechat 两条被一次 drain 掉。
  // 任何一个"拉取端"（哪怕只是探活）都能偷走别家的消息。
  // 现在：platform 必填，未知平台直接拒绝，不做"通配"。
  if (!p) return { count: 0, items: [], error: 'platform-required' }
  if (!drain) {
    const mineOnly = readOutbox().filter((x) => x.platform === p)
    return { count: mineOnly.length, items: mineOnly }
  }
  // 取出+清空必须在同一把锁里：分开做会让"取出后、清空前"新入队的消息被一起抹掉。
  const mine = []
  const r = updateJson(OUTBOX(), (cur) => {
    const all = Array.isArray(cur) ? cur : []
    for (const x of all) if (x.platform === p) mine.push(x)
    if (!mine.length) return undefined          // 没有我的：不动文件
    return all.filter((x) => x.platform !== p)
  }, { fallback: [], waitMs: 1500 })
  if (!r.ok) return { count: 0, items: [], error: r.error || 'write-failed' }
  return { count: mine.length, items: mine }
}

/** 把一条"通用入站"包成 OneBot 形状的事件（handle 直接能吃）。 */
export function toOneBotEvent(j = {}) {
  const platform = String(j.platform || 'qq')
  const isGroup = j.isGroup === true
  const text = String(j.text ?? '').trim()
  return {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    self_id: j.selfId ?? '',
    user_id: j.userId ?? '',
    group_id: j.groupId ?? '',
    message_id: j.msgId ?? ('in_' + Date.now()),
    time: Math.floor((Number(j.at) || Date.now()) / 1000),
    message: [{ type: 'text', data: { text } }],
    __platform: platform,
    __name: j.name ?? '',
    __text: text,
  }
}

/**
 * 处理一个 HTTP 请求（返回 true 表示这个路由它接了）。
 * @param {object} req
 * @param {object} res
 * @param {{push:Function, log?:Function}} channel 统一通道实例
 * @returns {boolean} 是否已处理
 */
export function handleChannelRoutes(req, res, channel, log = () => {}) {
  const url = String(req.url || '')

  // ── 出站：任何平台来取自己的回复 ───────────────────────────────────────
  if (url.startsWith('/outbound')) {
    let out = { ok: false }
    let code = 200
    try {
      const u = new URL(url, 'http://x')
      const platform = String(u.searchParams.get('platform') || '')
      const drain = u.searchParams.get('drain') !== '0'
      const r = drainOutbox(platform, { drain, })
      out = { ok: !r.error, ...r }
      if (r.error) code = 400
    } catch (e) { out = { ok: false, reason: String(e?.message ?? e) }; code = 400 }
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
    return true
  }

  // ── 入站：任何平台的消息都从此进 ───────────────────────────────────────
  if (req.method === 'POST' && url === '/inbound') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy() })
    req.on('end', () => {
      let out = { ok: false }
      try {
        const j = JSON.parse(body || '{}')
        const evt = toOneBotEvent(j)
        if (!evt.__text) out = { ok: false, reason: 'empty' }
        else {
          const platform = String(j.platform || 'qq')
          // v5：只接受有实现的平台。抖音已整体下线，旧脚本若还在推会被明确拒绝，
          // 而不是继续往记忆里写一批没人处理的 douyin 行。
          if (!isKnownPlatform(platform) || RETIRED_PLATFORMS.includes(platform)) {
            out = { ok: false, reason: 'unknown-or-retired-platform:' + platform }
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(out))
            return
          }
          if (!evt.__text) { out = { ok: false, reason: 'empty' } }
          const chatId = String(j.chatId || (platform + ':' + (j.userId ?? j.groupId ?? 'unknown')))
          const r = channel.push({ chatId, platform, evt, at: Number(j.at) || Date.now() })
          out = { ok: true, queued: r.position, chatId }
        }
      } catch (e) { out = { ok: false, reason: String(e?.message ?? e) } }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
    })
    return true
  }

  return false
}

/**
 * 把一个批次（同会话连续几条）合成一条事件。
 * 为什么合成而不是逐条处理：他连发"在吗""我跟你说""今天被老板骂了"，
 * 真人是**等你说完再答**，不是答三次。
 * @param {{items:Array, chatId:string, platform:string}} batch
 * @param {{ttlMs?:number}} opts
 * @returns {object|null} 可直接交给 handle 的事件（带 __merged / __mergedTexts）
 */
export function synthBatch(batch, { ttlMs = 10 * 60_000 } = {}) {
  const items = (batch && batch.items) || []
  if (!items.length) return null
  const now = Date.now()
  const fresh = items.filter((x) => now - Number(x.at || 0) < ttlMs)
  if (!fresh.length) return null
  // 只有一条：原样返回（不制造无谓的合成开销）
  if (fresh.length === 1) {
    const only = fresh[0].evt
    only.__merged = 1
    only.__mergedTexts = [String(only.__text || '')]
    return only
  }
  // 多条：取最后一条做底（message_id/time 最新），文本按顺序拼
  const last = fresh[fresh.length - 1].evt
  const texts = fresh.map((x) => String(x.evt.__text || '').trim()).filter(Boolean)
  const synth = JSON.parse(JSON.stringify(last))
  synth.message = [{ type: 'text', data: { text: texts.join('\n') } }]
  synth.__merged = fresh.length
  synth.__mergedTexts = texts
  synth.__text = texts.join('\n')
  return synth
}

/**
 * OneBot 事件 → 进统一通道排队。
 * 只排队"能回的"：纯贴纸/空消息直接跳过，别占队列。
 * @param {object} evt OneBot v11 事件
 * @param {{push:Function}} channel 通道实例
 * @param {(message:any, selfId:string)=>object} parseMessage 解析函数（由调用方注入，避免循环依赖）
 * @returns {boolean} 是否入队
 */
export function enqueueOneBot(evt, channel, parseMessage) {
  try {
    if (!evt || evt.post_type !== 'message') return false
    const isGroup = evt.message_type === 'group'
    const cid = 'qq:' + String(isGroup ? (evt.group_id ?? '') : (evt.user_id ?? ''))
    const p = parseMessage(evt.message, evt.self_id)
    if (!p.text && !p.images.length && !p.marks.length) return false
    evt.__text = p.text
    channel.push({
      chatId: cid,
      platform: 'qq',
      evt,
      at: Number(evt.time) ? Number(evt.time) * 1000 : Date.now(),
    })
    return true
  } catch (e) { swallow(e, 'channel-io:enqueue-onebot'); return false }
}
