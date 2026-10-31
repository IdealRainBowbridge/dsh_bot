// OneBot v11 消息解析 —— 从 qq-server.mjs 拆出（10-31）。
//
// 为什么拆：qq-server.mjs 一度 1710 行，其中 handle() 一个函数就 415 行。
// 真正拖累可维护性的不是"文件多大"，而是"改一句话要读 400 行上下文"。
// 这一块是**纯函数**（输入一个 evt，输出结构化结果，不碰网络/文件/闭包），
// 拆出来零风险，而且能被单独测。
//
// 覆盖：array 格式 / CQ 码字符串 / 卡片(json,miniapp) / 图片 / 表情 / 视频 / 语音 / 引用 / 合并转发

/** 把一段话拆成 1~3 条短消息 —— 真人不会一次甩一大段。 */
/**
 * 把一段话拆成几条短消息 —— 真人不会一次甩一大段，但也不该一句一条地刷屏。
 *
 * 10-31 调参（截图实测定下来的）：
 *   旧：max=3, perMax=42 → 一句"记上了，明早九点提醒你交房租。别到时候又赖床"被切成 2 条，
 *       "就这一件。"这种 5 字碎片也单独成条，观感像机器人在刷屏。
 *   新：perMax=68（QQ 里 60-70 字是正常一句话）、max=4、只在句末标点切、碎片并回上一条。
 */
export function splitBubbles(text, max = 4, perMax = 68) {
  const src = String(text || '').trim()
  if (!src) return []
  // 短回复就一条 —— 不要为了"像人"硬拆
  if (src.length <= perMax) return [src]

  const parts = src.split(/(?<=[。！？!?…~～\n])/).map((s) => s.trim()).filter(Boolean)
  const merged = []
  for (const p of parts) {
    const last = merged[merged.length - 1]
    // 碎片并回上一条：<=12 字，或上一条还太短
    if (last !== undefined && (p.length <= 12 || last.length < 14)) merged[merged.length - 1] = last + p
    else merged.push(p)
  }

  // 超长的单句再按逗号补切（只在真的超过 perMax 时）
  const fit = []
  for (const p of merged) {
    if (p.length <= perMax) { fit.push(p); continue }
    const chunks = p.split(/(?<=[，,；;])/).map((x) => x.trim()).filter(Boolean)
    let buf = ''
    for (const c of chunks) {
      if (buf && buf.length + c.length > perMax) { fit.push(buf); buf = c }
      else buf += c
    }
    if (buf) fit.push(buf)
  }

  if (fit.length <= max) return fit
  // 超过上限：尾部全并进最后一条（宁可长一点，也别刷屏）
  const head = fit.slice(0, max - 1)
  return [...head, fit.slice(max - 1).join('')]
}

/**
 * 解析 OneBot v11 消息（array 段 或 CQ 码字符串）。
 * @returns {{text:string, atMe:boolean, images:string[], marks:string[], replyId:string}}
 */
export function parseMessage(message, selfId) {
  let text = ''
  let atMe = false
  const images = []   // 图片 URL（等视觉模型来"看"）
  const marks = []    // 非文字内容的描述标记
  let replyId = ''    // 引用了哪一条
  if (Array.isArray(message)) {
    for (const seg of message) {
      const t = seg?.type
      if (t === 'text') text += seg.data?.text ?? ''
      else if (t === 'at' && String(seg.data?.qq) === String(selfId)) atMe = true
      else if (t === 'image') {
        const u = String(seg.data?.url || seg.data?.file || '')
        if (/^https?:\/\//.test(u)) images.push(u)
        marks.push('【发了一张图片】')
      } else if (t === 'face') marks.push('【QQ表情】')
      else if (t === 'video') marks.push('【发了一段视频】')
      else if (t === 'record') marks.push('【发了一条语音】')
      else if (t === 'reply') {
        replyId = String(seg.data?.id ?? seg.data?.message_id ?? '').trim()
        marks.push('【引用回复了一条消息】')
      } else if (t === 'forward' || t === 'node') marks.push('【合并转发消息】')
      else if (t === 'json' || t === 'miniapp') {
        // 卡片（B站/小程序/结构化消息）：挖 title/desc/url
        let card = { title: '', desc: '', url: '' }
        try {
          const j = JSON.parse(seg.data?.data || seg.data?.json || '{}')
          const dig = (o, depth = 0) => {
            if (!o || typeof o !== 'object' || depth > 3) return null
            if ((o.title || o.desc) && (o.url || o.jumpUrl || o.qqdocurl)) return o
            for (const v of Object.values(o)) { const hit = dig(v, depth + 1); if (hit) return hit }
            return null
          }
          const hit = dig(j)
          card = {
            title: String(hit?.title || j.prompt || '').slice(0, 60),
            desc: String(hit?.desc || '').slice(0, 60),
            url: String(hit?.url || hit?.jumpUrl || hit?.qqdocurl || '').slice(0, 120),
          }
        } catch { card.title = String(seg.data?.data || '').slice(0, 40) }
        marks.push('【分享卡片：' + (card.title || '未知内容') + (card.desc ? ' · ' + card.desc : '') + '】')
      } else if (t) marks.push('【' + t + '】')
    }
  } else if (typeof message === 'string') {
    text = message.replace(/\[CQ:[^\]]*\]/g, '')
    atMe = message.includes('[CQ:at,qq=' + selfId + ']')
    const m = /\[CQ:reply,id=(-?\d+)/.exec(message)
    if (m) replyId = m[1]
  }
  return { text: text.trim(), atMe, images, marks, replyId }
}
