// reply-context —— 一次消息处理的「平台 + 会话」上下文（v5 重构）。
//
// 为什么必须要有它（重构前是个真 P0）：
//   qq-server 用两个**闭包级变量** CUR_PLATFORM / CUR_CHAT 表示"现在正在处理谁的消息"。
//   统一通道允许 4 个会话并行，于是：
//     A 会话（微信）await LLM 的 3 秒里，B 会话（QQ）把 CUR_PLATFORM 改回 'qq'，
//     A 醒来后调 send() → 回复被当成 QQ 消息走 OneBot 私聊接口发出去，或者
//     落进 B 会话的 outbox。表现是"她回错人/回错平台"，且只在并发时出现，极难复现。
//
// 修法：用 AsyncLocalStorage 把上下文挂在**异步调用链**上，而不是挂在进程上。
//   同一条 handle() 调用链里的所有 await/回调都能拿到自己的那份，天然并发安全。
//   没有上下文时（定时任务、主动搭话）返回 null，调用方自己决定兜底。
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage()

/**
 * 在指定上下文里跑一段异步逻辑。
 * @template T
 * @param {{platform:string, chatId:string, userId?:string, isGroup?:boolean, source?:string}} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithContext(ctx, fn) {
  const value = Object.freeze({
    platform: String(ctx?.platform || 'qq'),
    chatId: String(ctx?.chatId || ''),
    userId: String(ctx?.userId || ''),
    isGroup: ctx?.isGroup === true,
    source: String(ctx?.source || 'inbound'),
  })
  return als.run(value, fn)
}

/** 当前上下文；没有就返回 null（绝不抛）。 */
export function current() {
  try { return als.getStore() || null } catch { return null }
}

/** 当前平台（缺省 qq —— 与旧行为一致）。 */
export function currentPlatform(fallback = 'qq') {
  return current()?.platform || fallback
}

/** 当前会话 id。 */
export function currentChat(fallback = '') {
  return current()?.chatId || fallback
}

/**
 * 临时覆盖上下文（用于"她在主动说话"这类没有入站事件的场景）。
 * 主动搭话有自己的目标会话，必须显式声明，不能靠全局变量猜。
 */
export function withContext(ctx, fn) {
  return runWithContext(ctx, fn)
}
