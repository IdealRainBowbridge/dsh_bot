// lifecycle —— 定时器与进程的生命周期登记册（v5 新增）。
//
// 为什么需要它（重构前的真问题）：
//   lib/index.js 里有 4 个 setInterval（mindTick / focusTick / watchServices / sovitsTimer），
//   但 dispose 只 clear 了 2 个 —— 插件热重载/禁用再启用时，旧定时器还在跑，
//   于是同一个 tick 跑两份、两份同时写记忆/发消息。而且没有任何地方能回答
//   "现在到底有几个定时器在跑"，diagnose 也看不见。
//
// 设计：所有长驻定时器都必须通过本模块创建，它负责
//   ① 统一登记（name → handle），重复注册同名会先清掉旧的（幂等）
//   ② disposeAll() 一次清干净（插件卸载/热重载）
//   ③ snapshot() 给 diagnose/面板看：谁在跑、多久跑一次、上次什么时候跑的
import { swallow } from './swallow.mjs'

const timers = new Map()   // name -> { handle, everyMs, startedAt, lastAt, runs, errors, fn }

/**
 * 注册一个周期任务（幂等：同名会替换旧的）。
 * @param {string} name 唯一名字（'mindTick'）
 * @param {Function} fn 要跑的函数（可以是 async，内部自己 catch）
 * @param {number} everyMs 间隔毫秒
 * @param {{runNow?:boolean, runAfterMs?:number}} opts
 */
export function every(name, fn, everyMs, opts = {}) {
  clear(name)
  const rec = { everyMs: Number(everyMs) || 60_000, startedAt: Date.now(), lastAt: 0, runs: 0, errors: 0, fn }
  const tick = async () => {
    rec.lastAt = Date.now()
    rec.runs++
    try { await fn() } catch (e) { rec.errors++; swallow(e, 'lifecycle:' + name) }
  }
  rec.handle = setInterval(tick, rec.everyMs)
  // 不要阻止进程退出（Node 的默认行为就是保持存活；显式 unref 会让纯 CLI 场景能退出）
  if (opts.unref !== false) { try { rec.handle.unref?.() } catch { /* ignore */ } }
  timers.set(name, rec)
  if (opts.runNow === true) setTimeout(() => { void tick() }, Number(opts.runAfterMs) || 0)
  return rec
}

/** 清掉一个（幂等）。 */
export function clear(name) {
  const rec = timers.get(name)
  if (!rec) return false
  try { clearInterval(rec.handle) } catch { /* ignore */ }
  timers.delete(name)
  return true
}

/** 清掉全部（插件 dispose 调）。 */
export function disposeAll() {
  const names = [...timers.keys()]
  for (const n of names) clear(n)
  return names
}

/** 现在有哪些在跑（diagnose / 面板）。 */
export function snapshot() {
  return [...timers.entries()].map(([name, r]) => ({
    name, everyMs: r.everyMs, runs: r.runs, errors: r.errors,
    startedAt: r.startedAt, lastAt: r.lastAt,
    ageSec: Math.round((Date.now() - r.startedAt) / 1000),
    idleSec: r.lastAt ? Math.round((Date.now() - r.lastAt) / 1000) : null,
  }))
}

/** 健康检查：有没有定时器很久没跑了（说明被卡死或没在 tick）。 */
export function stale(limitRatio = 3) {
  return snapshot().filter((t) => {
    const expect = t.everyMs * limitRatio
    return t.lastAt && Date.now() - t.lastAt > expect
  })
}
