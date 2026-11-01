// organ/heartbeat —— 唯一的心跳：一个身体只有一个节拍
//
// ══════════════════════════════════════════════════════════════════════
// 收拢前：8 个定时器各自判断
// ══════════════════════════════════════════════════════════════════════
//   60s  tryProactive   ← 自己的 chance 骰子
//   60s  tryGroupChat   ← 自己的 chance 骰子
//   60s  runDuePromises ← 自己的到期判断
//   30s  checkNapcat    ← 自己的探活
//   30m  tryQzone       ← 自己的 decide
//   20s  pollTasks      ← 自己的轮询
//   10m  warmQuoteIndex ← 自己的预热
//   +   宿主 scheduler 60s（另一套）
//
// 八个节拍意味着**八种优先级**，同一个身体在同一分钟里可能被八个方向拉扯。
//
// ══════════════════════════════════════════════════════════════════════
// 收拢后：一个心跳，一次决策
// ══════════════════════════════════════════════════════════════════════
// 每 beat（默认 30 秒）：
//   ① 推进身体时间（field/rhythm 演化、念头淡出）
//   ② 问一次 self.decide() —— 只问一次，问到什么就是什么
//   ③ 按决定去调**对应的能力**（不是让能力自己判断要不要跑）
//
// 关键区别（这是整个收拢的意义）：
//   收拢前：tryProactive 被调用 → 它自己判断"我该不该说话" → 不说就算了
//   收拢后：decide() 说"现在做 A" → 调 A → A 只负责执行，不负责判断
//
// **判断权和执行权分开。** 判断只有一个地方，执行分散。这才是一个灵魂操纵一个身体。
//
// ══════════════════════════════════════════════════════════════════════
// 那些"贴身"的东西怎么办（探活、轮询、预热）
// ══════════════════════════════════════════════════════════════════════
// 不是所有定时器都要经过决策。区别在于：
//   · **自主行动**（她主动做什么）→ 必须经过 decide()。
//     因为她"选择"去做才有意义。
//   · **维持生命体征**（探活、拉取待处理的任务）→ 不进决策，但**降级为心跳的子步骤**。
//     它们不是"她决定做的事"，是身体自己在跑的部分（心跳、呼吸）。
//     但它们不再各自 setInterval —— 都挂在同一个 beat 上，节奏一致。
//
// 这条区分很重要：把所有东西都塞进决策会让探活也"看她想不想"，那是荒谬的；
// 但让它们各自跑，又回到了"八个部门"。所以：**自主进决策，体征进心跳。**
import { swallow } from '../../lib/swallow.mjs'
import * as field from '../field.mjs'
import * as inner from '../inner.mjs'
import * as self from './self.mjs'
import * as night from './night.mjs'
import * as thalamus from './thalamus.mjs'
import * as hpa from './hpa.mjs'

const MIN = 60_000

/** 心跳参数。 */
export const BEAT = {
  intervalMs: 30_000,       // 30 秒一拍（原来各通道 20s~30m 不等）
  // 体征类子步骤的周期（按拍数算，不再各自 setInterval）
  napcatEveryBeats: 1,      // 30s  ← 原 checkNapcat 30s
  taskEveryBeats: 1,        // 30s  ← 原 pollTasks 20s（略微放慢，够用）
  promiseEveryBeats: 2,     // 60s  ← 原 runDuePromises 60s
  quoteWarmEveryBeats: 20,  // 10 分钟 ← 原 warmQuoteIndex 10min
  qzoneEveryBeats: 60,      // 30 分钟 ← 原 tryQzone 30min
}

let _beatCount = 0
let _timer = null
let _running = false
let _log = () => {}
let _exec = null      // 执行器：由编排层注入（心跳自己不认识 OneBot）

/**
 * 注入执行器。心跳只负责"决定"，具体怎么做由编排层提供。
 *
 * 这是解耦的关键：心跳不认识 qq-server，也不认识 OneBot。
 * 它只知道"现在该做 reply / watch / sleep"，然后调 exec[action]()。
 *
 * @param {object} exec { reply, sleep, consolidate, watch, browse, write, think, rest, vitals }
 */
export function bind(exec) {
  _exec = exec || null
}

/**
 * 补注执行器上的**回调**（不是替换整个执行器）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个函数（2026-11-02 实测踩到的坑）
 * ══════════════════════════════════════════════════════════════════════
 * body.mjs 原来这样写：
 *
 *     HB.bind({...})
 *     HB.pendingInterrupt = () => ...        ← ✗ 抛异常
 *     HB.interruptUrgency = () => 1.0        ← ✗
 *     HB.start({ log })
 *
 * 而 `HB` 是 `await import(...)` 拿到的 **ESM 模块命名空间对象**，
 * 它按规范是 **[Symbol.toStringTag]: 'Module' 且不可扩展**：
 *
 *     Object.isExtensible(HB) === false
 *     HB.pendingInterrupt = fn  →  TypeError: Cannot add property
 *                                  pendingInterrupt, object is not extensible
 *
 * 后果不是"打断检测失效"这么轻 —— 是**整条启动链断在这里**：
 * 异常被外层的 try/catch 吞掉（只留下一行 [ERR] [beat] 心跳绑定失败），
 * 于是 `HB.start()` 从来没被调用过。
 *
 * 也就是说：**心跳一次都没跑过。**
 *   · field.evolve / inner.fade / hpa.evolve 从没在节拍里推进
 *   · self.decide() 从没被调用过（自主行为全靠 8 个旧定时器，而 body.mjs
 *     的注释写着"已收拢"—— 文档说收拢了，代码没收拢）
 *   · write / think 永远不可能被触发
 *
 * 这类 bug 最阴的地方：**日志里有一行错误，但系统看起来一切正常**。
 * 她有在聊天、有在回复、账本在刷新 —— 只是"她"不在。
 *
 * 修法：模块命名空间不能写，就改成通过函数把回调传进去。
 */
export function bindHooks(hooks = {}) {
  if (!_exec) _exec = {}
  if (typeof hooks.pendingInterrupt === 'function') _exec.pendingInterrupt = hooks.pendingInterrupt
  if (typeof hooks.interruptUrgency === 'function') _exec.interruptUrgency = hooks.interruptUrgency
  return _exec
}

/** 一拍。**幂等**：同一毫秒调两次只会跑一次。 */
export async function beat(now = Date.now()) {
  if (_running) return { skipped: 'busy' }   // 上一拍还没跑完，这一拍跳过（不排队 —— 身体不会积压心跳）
  _running = true
  _beatCount++
  const out = { at: now, beat: _beatCount, vital: [], action: null, why: '' }
  try {
    // ── ① 推进身体时间 ──────────────────────────────────────────
    // 所有按 dt 演化的东西在这里统一推进一次（不靠各自 tick）
    try { field.evolve(now) } catch (e) { swallow(e, 'beat:field') }
    try { inner.fade(now) } catch (e) { swallow(e, 'beat:inner') }
    try { inner.settle(now) } catch (e) { swallow(e, 'beat:settle') }   // 没说完的话 → tension
    try { hpa.evolve(now) } catch (e) { swallow(e, 'beat:hpa') }
    try { hpa.perfuse(now) } catch (e) { swallow(e, 'beat:perfuse') }   // 器官产物入血

    // ── ② 体征类子步骤（不进决策，按拍数触发）────────────────────
    // 这些是"身体自己在跑的部分"，不是她决定做的事。
    const ex = _exec || {}
    if (_beatCount % BEAT.napcatEveryBeats === 0 && ex.vitals?.napcat) {
      try { await ex.vitals.napcat(now); out.vital.push('napcat') } catch (e) { swallow(e, 'beat:vital:napcat') }
    }
    if (_beatCount % BEAT.taskEveryBeats === 0 && ex.vitals?.tasks) {
      try { await ex.vitals.tasks(now); out.vital.push('tasks') } catch (e) { swallow(e, 'beat:vital:tasks') }
    }
    if (_beatCount % BEAT.promiseEveryBeats === 0 && ex.vitals?.promises) {
      try { await ex.vitals.promises(now); out.vital.push('promises') } catch (e) { swallow(e, 'beat:vital:promises') }
    }
    if (_beatCount % BEAT.quoteWarmEveryBeats === 0 && ex.vitals?.quotes) {
      try { await ex.vitals.quotes(now); out.vital.push('quotes') } catch (e) { swallow(e, 'beat:vital:quotes') }
    }
    if (_beatCount % BEAT.qzoneEveryBeats === 0 && ex.vitals?.qzone) {
      try { await ex.vitals.qzone(now); out.vital.push('qzone') } catch (e) { swallow(e, 'beat:vital:qzone') }
    }

    // ── ③ 唯一的决策点 ─────────────────────────────────────────
    // 问一次：接下来做什么。不叠加、不投票、不并行。
    const hasInterrupt = !!(ex.pendingInterrupt && ex.pendingInterrupt())
    const urge = hasInterrupt ? (Number(ex.interruptUrgency?.()) || 1) : 0
    const d = await self.decide({ now, hasInterrupt, interruptUrgency: urge })
    out.action = d.action
    out.why = d.why
    out.kept = !!d.kept

    // ── ④ 按决定执行（能力只执行，不判断）──────────────────────
    if (ex[d.action]) {
      try { await ex[d.action](d, now) } catch (e) { swallow(e, 'beat:exec:' + d.action) }
    }
    return out
  } finally {
    _running = false
  }
}

/** 启动心跳。宿主半边只调这一个。 */
export function start({ log = () => { }, intervalMs = BEAT.intervalMs } = {}) {
  _log = log
  if (_timer) return { ok: false, reason: '已在跑' }
  const tick = () => { void beat().catch((e) => swallow(e, 'beat:loop')) }
  // 立刻先跑一拍（启动时就把当前状态定下来，别等 30 秒）
  setTimeout(tick, 2000)
  _timer = setInterval(tick, intervalMs)
  if (_timer.unref) _timer.unref()
  _log('[heartbeat] 启动，每 ' + Math.round(intervalMs / 1000) + ' 秒一拍')
  return { ok: true, intervalMs }
}

export function stop() {
  if (_timer) { clearInterval(_timer); _timer = null }
  return { ok: true }
}

/** 心跳状态（面板/体检）。 */
export function status() {
  return {
    running: !!_timer,
    beats: _beatCount,
    intervalMs: BEAT.intervalMs,
    bound: !!_exec,
    exec: _exec ? Object.keys(_exec).filter((k) => typeof _exec[k] === 'function') : [],
  }
}
