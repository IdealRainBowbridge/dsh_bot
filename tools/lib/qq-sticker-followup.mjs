// qq-sticker-followup —— AI 表情包补发（2026-11-03 高压修缮：自 qq-server.mjs 外迁）
//
// 图库没有的标签 / 自制表情 → Pollinations 生成入库再补发。异步跑（生成约 10~40s），
// 不阻塞回复主线；同文案有缓存不重画；AI 失败退 PIL 文字贴纸兜底。
// 2026-11-02 起不再传容器内 file:// 路径（宿主 SnowLuma 读不到 → EACCES），转 base64 随请求体走。
export function makeStickerFollowup({ send, config, log, pickSticker, generateStickerImage, ensureSelfSticker }) {
  const aiInflight = new Set()
  async function aiStickerFollowup({ tag, caption, isGroup, groupId, userId, selfId = '' }) {
    const key = `${tag || ''}|${caption || ''}`
    if (aiInflight.has(key)) return
    aiInflight.add(key)
    try {
      let file = null
      let desc = ''
      if (tag && !pickSticker(tag)) { desc = `标签「${tag}」`; file = await generateStickerImage(tag, { tag }) }
      if (!file && caption) { if (!desc) desc = `「${caption}」`; file = await generateStickerImage(caption) }
      if (!file && caption) file = ensureSelfSticker(caption, config())   // AI 失败 → PIL 文字贴纸兜底
      if (!file) { log(`[qq] AI 表情包没生成出来：${desc}（额度/代理/图床），这次不补发`); return }
      const target = isGroup
        ? { api: 'send_group_msg', key: 'group_id', id: Number(groupId) }
        : { api: 'send_private_msg', key: 'user_id', id: Number(userId) }
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))   // 像人翻表情包的工夫
      const { onebotFileValue } = await import('./onebot-file.mjs')
      const ok = await send(target.api, { [target.key]: target.id, message: [{ type: 'image', data: { file: onebotFileValue(file) } }] })
      if (ok) log(`[qq] 🎨 AI 表情包已入库补发：${desc} → ${file.split('/').pop()}${selfId ? '' : ''}`)
    } catch (e) { log('[qq] AI 表情包补发异常：' + (e?.message ?? e)) }
    finally { aiInflight.delete(key) }
  }
  return aiStickerFollowup
}
