// watchdog —— 桥/接管状态持久巡检（2026-11-04）
//
// 解决的问题：能力桥或人格接管注册失败时，quota/备份 timer 全部照常报绿，
// 她却已经"静默残废"——网页里够不着 bot_* 工具、或会话里她不是她。
// /api/status 虽然暴露了 bridge.registered / takeover.verified，但没人主动去看。
//
// 设计：
//   · 插件进程内 setInterval（5 分钟），读 globalThis.__dshBotBridge / __dshBotTakeover
//     —— 与 /api/status 同源，零额外依赖、零网络请求。
//   · 状态快照写 dataPath('watchdog.json')，供面板/外部脚本检查。
//   · 异常 → sendOwnerQQ 报警（复用出站链路的脱敏/去重），带 60 分钟告警节流，
//     同一故障不刷屏；恢复 → 发一条恢复通知。
//   · bot.mjs 进程存活：壳启动时会 spawn 它（procMod），由 im-gateway.sh 兜底重启，
//     这里只读 procMod 的存活标记，不重复拉起。
//   · 前三次巡检（启动后 ~15 分钟内）只记录不告警：cordis 装配是异步的，
//     桥可能还在 pending，过早告警全是误报。
//   · watchdog 自身绝不抛：所有分支吞掉，巡检挂了也不能拖垮她。
import fs from 'node:fs'
import { dataPath } from '../tools/lib/paths.mjs'
import { updateJson } from '../tools/lib/atomic.mjs'
import { sendOwnerQQ } from '../tools/lib/notify.mjs'
import { swallow } from '../tools/lib/swallow.mjs'

const INTERVAL_MS = 5 * 60 * 1000
const GRACE_POLLS = 3          // 启动后前 3 轮只记录
const ALERT_COOLDOWN_MS = 60 * 60 * 1000

/** @type {{timer: any, lastFault: string, lastAlertAt: number, polls: number}|null} */
let state = null

/**
 * 评估一轮健康状态。返回 null = 健康（或宽限期内）。
 * @returns {string|null} 故障一句话描述
 */
function evaluate() {
  const bridge = globalThis.__dshBotBridge
  const takeover = globalThis.__dshBotTakeover
  if (!bridge || bridge.registered !== true) {
    return '能力桥未注册（bot_* 工具在会话里用不了）' + (bridge?.reason ? `：${bridge.reason}` : '')
  }
  // takeover.enabled=false 是配置选择，不算故障；只有"配置了但没生效"才报
  if (takeover && takeover.enabled === true && takeover.registered !== true) {
    return '人格接管未注册（会话里她可能不是她）'
  }
  return null
}

function writeSnapshot(fault) {
  try {
    const bridge = globalThis.__dshBotBridge ?? {}
    const takeover = globalThis.__dshBotTakeover ?? {}
    updateJson(dataPath('watchdog.json'), {
      at: new Date().toISOString(),
      ok: !fault,
      fault: fault || null,
      polls: state?.polls ?? 0,
      bridge: { registered: !!bridge.registered, reason: bridge.reason ?? null, tools: bridge.tools ?? [] },
      takeover: { enabled: !!takeover.enabled, registered: !!takeover.registered, verified: takeover.verified ?? null },
    })
  } catch (e) { swallow(e, 'watchdog:snapshot') }
}

// ── B5：配置层 ValidationError 巡检（2026-11-04 脏状态事故的可见化）────────
// 事故回顾：agent-preset 收到一份缺 config.id 的覆盖，cordis 打了 ValidationError
// 到 console 就完事——quota/备份照常报绿，没人盯日志。这里拦 console，
// 匹配配置校验错误就升级为 QQ 告警（同样 60min 节流），让脏配置不再静默。
// 只拦不吞：原样透传给真正的 console，日志流不变。
const CONFIG_ERR_RE = /ValidationError|invalid config|without inject/
let consoleHooked = false
function hookConsole() {
  if (consoleHooked) return
  consoleHooked = true
  for (const level of ['warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      try {
        const msg = args.map(a => (typeof a === 'string' ? a : String(a?.message ?? ''))).join(' ')
        if (CONFIG_ERR_RE.test(msg)) reportConfigError(msg.slice(0, 300))
      } catch { /* 拦截器自身绝不抛 */ }
      orig(...args)
    }
  }
}

function reportConfigError(msg) {
  try {
    if (!state) return
    const cooled = !state.lastFault || (Date.now() - state.lastAlertAt > ALERT_COOLDOWN_MS)
    if (!cooled) return
    state.lastFault = '配置校验错误：' + msg
    state.lastAlertAt = Date.now()
    sendOwnerQQ('[watchdog] 配置层报错了：' + msg + ' —— 相关能力可能没挂上,老爸看一眼启动日志').catch(() => {})
  } catch { /* ignore */ }
}

function tick() {
  try { console.log('[bot] watchdog：tick 触发，polls=1 起算') } catch {}
  try {
    if (!state) return
    state.polls++
    const fault = state.polls <= GRACE_POLLS ? null : evaluate()
    writeSnapshot(fault)
    if (!fault) {
      // 从故障中恢复 → 通知一次
      if (state.lastFault && Date.now() - state.lastAlertAt > 2 * 60 * 1000) {
        sendOwnerQQ(`[watchdog] 已恢复：${state.lastFault} —— 巡检 ${state.polls} 轮后一切正常`).catch(() => {})
      }
      state.lastFault = ''
      return
    }
    // 故障持续 / 首次发现 → 节流告警
    const cooled = !state.lastFault || (Date.now() - state.lastAlertAt > ALERT_COOLDOWN_MS)
    if (cooled) {
      state.lastFault = fault
      state.lastAlertAt = Date.now()
      console.warn('[bot] watchdog：' + fault + '（已 QQ 通知老爸）')
      sendOwnerQQ(`[watchdog] ${fault}。生物钟/额度都还在跑，但她这个能力是坏的 —— 老爸看一眼 docker restart dsh_bot`).catch(() => {})
    }
  } catch (e) { swallow(e, 'watchdog:tick') }
}

/** 启动巡检（壳 apply 时调用一次；重复调用幂等）。 */
export function startWatchdog() {
  if (state?.timer) return
  hookConsole()
  state = { timer: null, lastFault: '', lastAlertAt: 0, polls: 0 }
  try {
    state.timer = setInterval(tick, INTERVAL_MS)
    state.timer.unref?.()          // 不阻止进程退出
  } catch (e) { swallow(e, 'watchdog:start') }
  console.log('[bot] watchdog：巡检已启动（5 分钟一轮，启动日志见后续快照）')
  // 启动后先跑一轮快照（宽限期内只记录）
  setTimeout(tick, 15_000).unref?.()
}

/** 停止巡检（卸载时）。 */
export function stopWatchdog() {
  try { if (state?.timer) clearInterval(state.timer) } catch { /* ignore */ }
  state = null
}
