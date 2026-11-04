// brain-bridge —— 老记忆层（memory.mjs）→ 新脑（brain/）的桥。
// 记忆融合（10-31）：所有 memory.remember() 调用自动双写进 brain 事件流，
// 让 brain 的多路召回（7 路加权、audience 分级）看到全量数据。
// 设计：同步 remember 内做异步 fire-and-forget；本模块绝不抛错（老库是主库，桥失败只丢 brain 侧）。
import { emit } from '../brain/event.mjs'
import { config } from './config.mjs'

const PLATFORM_ACT = { bilibili: 'observe', douyin: 'observe', web: 'observe' }

/**
 * 用户是谁 —— 从配置读，绝不硬编码。
 *
 * v5 修：旧代码写死 `includes('3682285116')`。后果有三：
 *   ① 换一个 QQ 号部署，所有"用户"判定全错，用户被当成陌生人（记忆里没有他的位置）；
 *   ② 这个文件是双写桥，每一行记忆都过它 —— 错一次污染全部；
 *   ③ 仓库里留着一个真实 QQ 号，属于不该存在的个人信息。
 * 现在：优先 owner.qq，其次 brain.ownerIds；都没有就"私聊即用户"（与旧兜底一致）。
 */
function isOwnerRecord(rec) {
  try {
    const cfg = config()
    const ids = new Set()
    if (cfg.owner?.qq) ids.add(String(cfg.owner.qq))
    for (const x of (cfg.brain?.ownerIds || [])) if (x) ids.add(String(x))
    if (!ids.size) return String(rec.chatId || '').startsWith('qq:') && rec.isGroup !== true
    if (ids.has(String(rec.userId || ''))) return true
    // chatId 形如 qq:3682285116（私聊）—— 也认一次
    const m = /^[a-z-]+:(\d+)$/.exec(String(rec.chatId || ''))
    return !!(m && ids.has(m[1]) && rec.isGroup !== true)
  } catch { return false }
}

/** 把老记忆行翻译成 brain 事件并发入 inbox。 */
export function rememberToBrain(rec) {
  try {
    const role = String(rec.role || 'event')
    const isSelf = role === 'assistant'
    const isOwner = role === 'user' && isOwnerRecord(rec)
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
      name: isSelf ? '我' : isOwner ? String(config().owner?.name || '用户') : '',
    })
  } catch { /* 旁路，绝不抛 */ }
}
