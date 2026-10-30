// brain-bridge —— 老记忆层（memory.mjs）→ 新脑（brain/）的桥。
// 记忆融合（10-31）：所有 memory.remember() 调用自动双写进 brain 事件流，
// 让 brain 的多路召回（7 路加权、audience 分级）看到全量数据。
// 设计：同步 remember 内做异步 fire-and-forget；本模块绝不抛错（老库是主库，桥失败只丢 brain 侧）。
import { emit } from '../brain/event.mjs'

const PLATFORM_ACT = { bilibili: 'observe', douyin: 'observe', web: 'observe' }

/** 把老记忆行翻译成 brain 事件并发入 inbox。 */
export function rememberToBrain(rec) {
  try {
    const role = String(rec.role || 'event')
    const isSelf = role === 'assistant'
    const isOwner = role === 'user' && String(rec.chatId || '').includes(String(3682285116))
    emit({
      proc: 'memory-bridge',
      platform: rec.platform || 'misc',
      chatId: rec.chatId || '',
      userId: rec.userId || '',
      role,
      text: rec.summary || rec.text || '',
      isGroup: rec.isGroup === true,
      kind: rec.kind || '',
      isOwner,
      name: isSelf ? '我' : isOwner ? '笨蛋老爹' : '',
    })
  } catch {}
}
