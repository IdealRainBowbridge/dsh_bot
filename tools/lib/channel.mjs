import fs from 'node:fs'

// ══════════════════════════════════════════════════════════════════════
// 统一通道（Unified Channel）—— 所有平台的消息都先进这一个口
// ══════════════════════════════════════════════════════════════════════
// 现状：每个平台各自处理，QQ 的 handle() 收到就 await，没有队列：
//   · 连发 5 条 → 5 个 handle 并发跑，互相不知道对方在说什么（她会答串）
//   · 一个慢请求（LLM 3s）挡住后面所有消息
//   · 没有"先来先答"的保证，回复可能乱序
//
// 目标（用户要求）：
//   ① 统一入口：QQ / 微信 / 抖音私信 全走同一个队列
//   ② 排队对话：同一会话的消息按时间顺序处理（先来的先答）
//   ③ 多会话分流：不同会话并行（A 在聊的时候，B 不会被卡）
//   ④ 同一会话内"合并连续消息"：他连发 3 条 30 字，应该当成一段话理解，
//      而不是答 3 次（真人也是等你说完再答）
//
// 设计：
//   · 每个 conversation（chatId）一条 FIFO 队列
//   · 不同的 conversation 并行（各自 worker）
//   · 同一 conversation 串行（保证顺序）
//   · 入队后有个 debounce（默认 900ms）：同一会话在窗口内继续来消息就合并
//   · 全局并发上限（默认 4）防打爆
//   · 每条消息有 ttl（默认 10 分钟）：排队太久就丢弃并说明，不答隔夜话
import { swallow } from './swallow.mjs'

/** @typedef {{ id:string, chatId:string, platform:string, evt:any, at:number, tries:number }} Item */

const DEFAULT_OPTS = {
  debounceMs: 900,        // 同会话合并窗口
  maxConcurrency: 4,      // 全局并行会话数
  ttlMs: 10 * 60_000,     // 消息排队超过这个时间就丢
  maxQueuePerChat: 20,    // 单会话最多积压多少条
  maxMerge: 6,            // 一次最多合并几条
}

class UnifiedChannel {
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts }
    /** @type {Map<string, Item[]>} chatId -> 队列 */
    this.queues = new Map()
    /** @type {Map<string, {timer:any, running:boolean}>} */
    this.state = new Map()
    this.running = 0
    this.stats = { enqueued: 0, merged: 0, handled: 0, dropped: 0, errors: 0, peakQueue: 0, peakRunning: 0 }
    this.handler = null
    this.log = () => {}
  }

  /** 注册真正的处理函数：(batch, ctx) => Promise<void> */
  onHandle(fn) { this.handler = fn }

  setLogger(fn) { this.log = typeof fn === 'function' ? fn : () => {} }

  /** 入队一条消息。@returns {{ok:boolean, position:number, merged:boolean}} */
  push({ chatId, platform = 'qq', evt, at = Date.now() }) {
    const key = String(chatId || 'unknown')
    if (!this.queues.has(key)) this.queues.set(key, [])
    const q = this.queues.get(key)

    if (q.length >= this.opts.maxQueuePerChat) {
      // 积压太多：丢最老的（保住最新的话，也别把人晾着）
      const dropped = q.shift()
      this.stats.dropped++
      this.log('[channel] ' + key + ' 积压超过 ' + this.opts.maxQueuePerChat + ' 条，丢弃最早一条：' + String(dropped?.evt?.message_id || ''))
    }

    q.push({ id: 'c' + at.toString(36) + Math.random().toString(36).slice(2, 6), chatId: key, platform, evt, at, tries: 0 })
    this.stats.enqueued++
    this.stats.peakQueue = Math.max(this.stats.peakQueue, q.length)

    const st = this.state.get(key) || { timer: null, running: false }
    this.state.set(key, st)

    // 已经在跑：让它跑完再看队列（串行保证顺序）
    if (st.running) return { ok: true, position: q.length, merged: false }

    // 没在跑：起一个 debounce 窗口，把"他连发几条"合成一批
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => {
      st.timer = null
      this._drain(key)
    }, this.opts.debounceMs)

    return { ok: true, position: q.length, merged: false }
  }

  /** 消费某个会话的队列。 */
  async _drain(key) {
    const st = this.state.get(key)
    if (!st || st.running) return
    const q = this.queues.get(key) || []
    if (!q.length) return

    // 全局并发闸门
    if (this.running >= this.opts.maxConcurrency) {
      // 等一个空位再继续（不丢队列，只是延后）
      if (st.timer) return
      st.timer = setTimeout(() => { st.timer = null; this._drain(key) }, 300)
      return
    }

    // 取一批：同一会话的连续消息合并（最多 maxMerge 条）
    const now = Date.now()
    const fresh = []
    while (q.length && fresh.length < this.opts.maxMerge) {
      const it = q.shift()
      if (now - Number(it.at || 0) > this.opts.ttlMs) {
        this.stats.dropped++
        this.log('[channel] ' + key + ' 丢弃过期消息（排了 ' + Math.round((now - it.at) / 1000) + 's）')
        continue
      }
      fresh.push(it)
    }
    if (!fresh.length) return

    if (fresh.length > 1) this.stats.merged += fresh.length - 1

    st.running = true
    this.running++
    this.stats.peakRunning = Math.max(this.stats.peakRunning, this.running)

    const batch = {
      chatId: key,
      platform: fresh[0].platform,
      items: fresh,
      /** 合并后的文本（按到达顺序） */
      text: fresh.map((x) => String(x.evt?.__text ?? '')).filter(Boolean).join('\n'),
      merged: fresh.length > 1,
    }

    try {
      if (this.handler) await this.handler(batch)
      this.stats.handled += fresh.length
    } catch (e) {
      this.stats.errors++
      this.log('[channel] ' + key + ' 处理失败：' + String(e?.message ?? e))
      swallow(e, 'channel:handle')
    } finally {
      st.running = false
      this.running--
      // 队列还有 → 立刻继续（不等 debounce，保证"先来先答"）
      const rest = this.queues.get(key) || []
      if (rest.length) {
        setImmediate(() => this._drain(key))
      }
    }
  }

  /** 当前状态（面板/diagnose 用）。 */
  snapshot() {
    const perChat = []
    for (const [chatId, q] of this.queues) {
      const st = this.state.get(chatId) || {}
      if (q.length || st.running) perChat.push({ chatId, waiting: q.length, running: !!st.running })
    }
    perChat.sort((a, b) => (b.waiting + (b.running ? 1 : 0)) - (a.waiting + (a.running ? 1 : 0)))
    return {
      ...this.stats,
      runningChats: this.running,
      queuedTotal: [...this.queues.values()].reduce((a, q) => a + q.length, 0),
      perChat: perChat.slice(0, 12),
    }
  }

  /** 清空（测试用）。 */
  reset() {
    for (const st of this.state.values()) if (st.timer) clearTimeout(st.timer)
    this.queues.clear()
    this.state.clear()
    this.running = 0
    this.stats = { enqueued: 0, merged: 0, handled: 0, dropped: 0, errors: 0, peakQueue: 0, peakRunning: 0 }
  }
}

/** 单例（QQ/微信/抖音共用一个通道）。 */
export const channel = new UnifiedChannel()
export { UnifiedChannel }
