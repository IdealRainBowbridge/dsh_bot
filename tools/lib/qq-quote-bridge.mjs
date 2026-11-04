// qq-quote-bridge —— QQ 引用索引的预热与解析（2026-11-03 高压修缮：自 qq-server.mjs 外迁）
//
// 为什么单独成文件：qq-server.mjs 1,771 行顶破门禁上限（1750），先把这段自包含的
// 「NapCat get_msg 不可靠 → 本地索引兜底 → 图走 VL」逻辑搬出来（~100 行）。
// 依赖全部显式注入（callApi / config / log / selfId / parseMessage），本文件只 import
// 基础设施（quote / paths / swallow / vision），不产生新的依赖反向边 —— 门禁白名单不加东西。
//
// get_msg 只认得还有缓存的消息（实测老消息直接回"消息不存在"）：启动时和之后每 10 分钟
// 把用户私聊 / 已开群的最近几十条拉一遍，id → 正文全部登记，这样引用历史消息也能取到原文。
// 引用里的图片再走一次 VL，免得"他引用了一张图"她只看到一句话。
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import * as quoteIndex from './quote.mjs'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'

const execFileAsync = promisify(execFile)

export function makeQuoteBridge({ callApi, config, log, selfId, parseMessage }) {
  async function warmQuoteIndex(count = 40) {
    const ownerQQ = String(config().owner?.qq || '')
    const QQ = config().qq || {}
    const targets = []
    if (ownerQQ) targets.push({ api: 'get_friend_msg_history', key: 'user_id', id: Number(ownerQQ) })
    for (const gid of (QQ.allow_groups || [])) targets.push({ api: 'get_group_msg_history', key: 'group_id', id: Number(gid) })
    let n = 0
    for (const t of targets) {
      const j = await callApi(t.api, { [t.key]: t.id, count }, 15000)
      const msgs = j?.data?.messages
      if (!Array.isArray(msgs)) continue
      for (const m of msgs) {
        const senderQQ = String(m?.sender?.user_id ?? '')
        const who = senderQQ === String(selfId()) ? 'me' : (senderQQ === ownerQQ ? 'owner' : 'other')
        const p = parseMessage(m?.message, selfId())
        const own = [p.text, ...p.marks.filter((x) => x !== '【引用回复了一条消息】')].filter(Boolean).join(' ')
        if (!own) continue
        quoteIndex.remember(m.message_id, {
          text: own, who, at: Number(m.time) * 1000,
          name: String(m?.sender?.card || m?.sender?.nickname || senderQQ),
        })
        n++
      }
    }
    quoteIndex.save()
    if (n) log(`[qq] 引用索引预热：${n} 条（${quoteIndex.size()} 条在手）`)
    return n
  }

  async function resolveQuote(replyId, { userId = '', isGroup = false, groupId = '' } = {}) {
    const ownerQQ = String(config().owner?.qq || '')
    let rec = quoteIndex.get(replyId)
    if (!rec) {
      const j = await callApi('get_msg', { message_id: Number(replyId) || replyId }, 12000)
      const data = j?.data || (j?.status === 'ok' ? j : null)
      if (data) {
        rec = quoteIndex.fromGetMsg(data, { selfQQ: selfId(), ownerQQ, parseMessage })
        if (rec) quoteIndex.remember(replyId, rec)
      }
    }
    // 还是没有 → 可能是很久以前的消息：现场把最近历史再拉一遍（比"取不到"强）
    if (!rec) {
      await warmQuoteIndex(60)
      rec = quoteIndex.get(replyId)
    }
    if (rec && config().qq?.quote?.seeImage !== false) {
      // 被引用的是图片：取一次 VL 描述（失败就算了，别拖慢回复）
      const url = /https?:\/\/[^\s"）)]+/.exec(rec.text)?.[0]
      if (url && rec.who === 'me' && /【发了一张图片】|【图片】/.test(rec.text)) {
        try {
          const { visionOn, describeFrames } = await import('./vision.mjs')
          if (visionOn()) {
            const dl = path.join(dataPath('qq-img'), `q-${Date.now()}.jpg`)
            fs.mkdirSync(path.dirname(dl), { recursive: true })
            const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
            await execFileAsync(exe, ['-sS', '-L', '-m', '25', '-A', 'Mozilla/5.0', '-o', dl, url], { timeout: 30000, windowsHide: true })
            if (fs.existsSync(dl) && fs.statSync(dl).size > 2000) {
              const desc = await describeFrames([dl], { query: '这是他引用的一张图。一两句话说明图里是什么/什么梗/情绪。' })
              if (desc) rec.text = `${rec.text}（图里是：${desc.slice(0, 100)}）`
            }
            try { fs.rmSync(dl, { force: true }) } catch (e) { swallow(e, 'qq-quote-bridge:resolveQuote') }
          }
        } catch (e) { swallow(e, 'qq-quote-bridge:resolveQuote') }
      }
    }
    return quoteIndex.describe(rec, { selfQQ: selfId(), ownerQQ })
  }

  return { warmQuoteIndex, resolveQuote }
}
