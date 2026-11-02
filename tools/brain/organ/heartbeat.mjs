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
import * as neuron from '../cell/neuron.mjs'
import * as sleepstage from './sleepstage.mjs'

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
  brainEveryBeats: 1,       // 30s  ← 脑编排：消费 inbox → episode / 意图补做 / 巩固判断
    // 2026-11-02 修：body.mjs 早就注册了 vitals.brain，但 heartbeat 从来没调过它。
    //
    // 故障是真的，两条路径要分开看：
    //   ① **聊天路径没断** —— onEvent() 里会调 episode.ingest({limit:20})，
    //      所以每条 QQ/B站消息进来都会立刻落一条 episode。
    //   ② **后台批量路径从来没跑过** —— brain.tick() 只挂在 vitals.brain 上，
    //      而 beat() 的体征列表里没有 brain。B站/上网/notify 走 memory-bridge
    //      写进 inbox 的事件因此**只进不出**。
    // 实测（17:20 审查）：inbox 128 行、四个游标合计只消费 28 → 积压 99；
    // ep/2026-11.jsonl 停在 22 行、mtime 10:14:55。
    // 17:54 手动跑过一次 brain tick，积压归零、ep 涨到 122 行 —— 那是**修复动作的结果**，
    // 不能拿它反推"故障不存在"。（这条注释曾被倒因为果地改过一次，已改回事实。）
    //
    // 补上这一拍之后：每 30 秒消费一次 inbox，后台事件不再堆积。
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
    try { accrueSleepDebt(now) } catch (e) { swallow(e, 'beat:debt') }
    try { inner.fade(now) } catch (e) { swallow(e, 'beat:inner') }
    try { inner.settle(now) } catch (e) { swallow(e, 'beat:settle') }   // 没说完的话 → tension
    try { hpa.evolve(now) } catch (e) { swallow(e, 'beat:hpa') }
    // 五条神经通路的恢复（2026-11-02 接上）。
    // 这一步以前**完全不存在** —— cell/neuron 是无状态的，没有落盘也没有推进，
    // 所以"社交聊多了会钝"在真实运行中从未发生过（只在测试里从 empty() 算过）。
    // 现在每拍按真实 dt 补突触池、回膜受体，她安静下来会自己恢复。
    try { neuron.tick(now) } catch (e) { swallow(e, 'beat:neuron') }
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
    // 脑编排事务：消费 inbox → 建 episode / 意图补做 / 判断该不该巩固。
    // 2026-11-02 修：这一段以前只写在 body.mjs 的注释里说"已收拢"，
    // 但心跳从来没调过它 —— 文档说收拢了，代码没收拢。
    if (_beatCount % BEAT.brainEveryBeats === 0 && ex.vitals?.brain) {
      try { await ex.vitals.brain(now); out.vital.push('brain') } catch (e) { swallow(e, 'beat:vital:brain') }
    }

    // ── ③ 唯一的决策点 ─────────────────────────────────────────
    // 问一次：接下来做什么。不叠加、不投票、不并行。
    const hasInterrupt = !!(ex.pendingInterrupt && ex.pendingInterrupt())
    const urge = hasInterrupt ? (Number(ex.interruptUrgency?.()) || 1) : 0

    // 丘脑门控（2026-11-02 接线）：打断不是"有就一定能进来"，要先过通道阈值。
    // 以前 thalamus.mjs 229 行 8 个导出全仓零调用 —— 一个装饰品。
    // 现在它真的参与决策：owner 通道 base 0.10 + 疲劳增益 0.15（累到极点门槛也只到 0.25），
    // 所以"他的消息几乎永远进得来"是**算出来的**，不是写死的；高显著（salience→1）阈值再打 0.12 折，
    // 这就是设计里说的"睡着也能被叫醒"。
    let interruptPass = hasInterrupt
    try {
      if (hasInterrupt) {
        const sig = thalamus.admit({
          channel: 'owner',
          strength: Math.max(0.6, Number(urge) || 1),
          salience: Number(urge) >= 1.4 ? 0.9 : 0.2,
          now,
        })
        interruptPass = sig.pass
        out.thalamus = { pass: sig.pass, effective: sig.effective, threshold: sig.threshold, why: sig.why }
        if (!sig.pass) _log('[thalamus] 打断被门压掉：' + sig.why)
      }
    } catch (e) { swallow(e, 'beat:thalamus:admit') }

    const d = await self.decide({ now, hasInterrupt: interruptPass, interruptUrgency: interruptPass ? urge : 0 })
    out.action = d.action
    out.why = d.why
    out.kept = !!d.kept

    // ── ④ 按决定执行（能力只执行，不判断）──────────────────────
    // 丘脑焦点：决定下来的这件事成为"当前焦点"，其他通道在这段时间里更难挤进来
    // （side inhibition 是 thalamus.admit 里已经写好的机制，以前没人给它设过 focus）。
    try {
      thalamus.focus({ channel: 'self', label: String(d.action || ''), ttlMin: Math.max(1, Math.round(Number(d.spanMin || 5))), now })
    } catch (e) { swallow(e, 'beat:thalamus:focus') }
    if (ex[d.action]) {
      try { await ex[d.action](d, now) } catch (e) { swallow(e, 'beat:exec:' + d.action) }
    }
    // 执行完释放焦点（"这件事做完了"，别一直压着别的通道）
    try { thalamus.release(now) } catch (e) { swallow(e, 'beat:thalamus:release') }
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

// ══════════════════════════════════════════════════════════════════════
// 睡眠债按**真实清醒时间**累积（2026-11-02）
// ══════════════════════════════════════════════════════════════════════
// 改前，睡眠债只有一个增长入口：brain/index.mjs:119
//     if (hod >= 1 && hod < 5) field.poke('sleepDebt', 0.012, ...)
// 而它在**事件处理链**里 —— 也就是说：
//
//     **只有收到消息时才累积。她安静待着、没人找她的时候，一点觉都不欠。**
//
// 这跟生理完全相反：腺苷在清醒期间**持续**累积，跟有没有人跟你说话无关。
// 而且这让整套休眠在最常见的场景下彻底失效：
//     凌晨没人找她 → 不欠觉 → 睡意 0 → 不睡 → 不做睡眠整理 → 第二天照旧。
// 实测就是这么回事：score 恒为 0，sleep.json / rhythm.json 从没落过盘。
//
// 第二重错误叠在上面：field.evolve 每拍按 tau=36h 把 sleepDebt 往 0 拉，
// 于是"欠的觉"还会自己蒸发（已在 field.mjs 用 accrualOnly 修掉）。
// 两个错一夹 → **"越熬越困"这条最基本的规律，在这个模型里根本不存在。**
//
// 现在按清醒时长累积：
//   基础 0.02/小时，深夜（23~6 点）×2.5（生物钟该睡的时段欠得更快）
//   昼夜都算（白天清醒同样欠觉，只是慢一点）
//
// dt 用两次 beat 的真实间隔，不固定 30 秒 ——
// 进程暂停、容器重启都不该凭空生成或丢弃睡眠债。
const _DEBT_CLOCK = { at: 0 }

function accrueSleepDebt(now) {
  let inSleep = false
  try { inSleep = !!sleepstage.snapshot().inSleep } catch { /* 拿不到就当醒着 */ }

  // 睡着时不累积（睡着了本来就在还账）
  if (inSleep) { _DEBT_CLOCK.at = now; return }
  if (!_DEBT_CLOCK.at) { _DEBT_CLOCK.at = now; return }

  let dtH = (now - _DEBT_CLOCK.at) / 3600_000
  _DEBT_CLOCK.at = now
  if (dtH <= 0) return

  // 上限 2 小时：进程停了一整天，回来不该一次性补 24 小时的债。
  // 机器关机不等于她熬夜 —— 那段时间她没在"活"。
  if (dtH > 2) dtH = 2

  const h = new Date(now).getHours()
  const nightish = (h >= 0 && h < 6) || h >= 23
  const delta = 0.02 * (nightish ? 2.5 : 1) * dtH
  // 阈值别设太高：一拍 30 秒只有 0.0004（深夜）~0.00017（白天），
  // 设 0.0002 会让白天几乎永远不写账 —— 那还是"没人说话就不欠觉"。
  // 现在只要超过 0.0001 就记（一拍 30 秒最少 0.00017，刚好过线）。
  if (delta < 0.0001) return

  const cur = Number(field.snapshot().dims.sleepDebt || 0)
  if (cur >= 0.999) return                         // 满了就别再写
  field.poke('sleepDebt', delta, { why: nightish ? 'awake:night' : 'awake:day', now })
}
