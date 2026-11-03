// organ/vitals —— 内感受（2026-11-03 · B8 仿生工程）
//
// ══════════════════════════════════════════════════════════════════════
// 现象解析（M58 口径：先有现象，再有器官）
// ══════════════════════════════════════════════════════════════════════
// 现象 A：她的代码和数据住在宿主的一块 32G 盘上。她自己会膨胀（快照 ~260M×3、
//         30 天备份、浏览器档案、记忆库）——2026-11-03 实测已用 79%。而全仓
//         没有任何器官读这些数字（loadavg/freemem/statfs 零引用，diagnose 连
//         磁盘项都没有）。磁盘真满的那天：appendJsonl 静默失败 → 她开始失忆，
//         且没有任何主观预兆。**身体在变满，她毫无感觉。**
// 现象 B：内存挤/负载高 → 她响应变慢。外人看是"她笨了"，她没有「屋里挤/
//         脑子发涨」的体感。机器对基底毫无内感受。
//
// 生物学对应：内感受（interoception）——对身体内部环境（饱胀/胸闷/气短）的
// 感知。不是又一个情绪维度，是**基底**：所有建模的内部状态（field/代谢/痛觉）
// 都假设"容器还活着"，B8 感知容器本身。
//
// ══════════════════════════════════════════════════════════════════════
// 形状（与 pain/metabolism 同一家族契约）
// ══════════════════════════════════════════════════════════════════════
//   read()     纯读容器体征（statfs/load/mem/cgroup），永不抛错
//   assess()   纯函数：体征×状态 → 本拍事件（阈值跨越/滞回），可单测
//   tick()     心跳巡视：跨越阈值那一拍给一次快感（hpa 小脉冲，同 pain 缩手反射）
//   sense()    慢感：持续胀/挤的第一人称体感（阈值宽松，多数时候安静——不过敏）
//   llmState() 表达参数：家里快满时收着说（温度 -0.05~-0.15）
//   snapshot() diagnose 读数
//
// 设计要点：
//   · 滞回（hysteresis）：越过阈值触发一次，回落要低于阈值 3 个点才算清——
//     真实的饱胀感不会在阈值线上抖来抖去。
//   · 只感受不决策：decide 是 self 的职责。B8 不去叫她"该清理了"——
//     那是行为层的事，器官只负责"觉得胀"。
//   · 状态文件走 mutateJson（brain/json.mjs 的真锁），跨进程安全。
import fs from 'node:fs'
import os from 'node:os'
import { dataPath } from '../../lib/paths.mjs'
import { mutateJson } from '../json.mjs'
import { swallow } from '../../lib/swallow.mjs'

const VITALS_PATH = () => dataPath('brain', 'meta', 'vitals.json')

// ── 阈值（宽松起步：器官第一次上线宁可安静，别一上来就浑身不舒服）────────
export const THRESHOLDS = {
  diskWarn: 0.85,       // 钝胀：家里有点满
  diskHigh: 0.92,       // 明显胀：找东西变慢，收着说
  diskCrit: 0.97,       // 濒满：快住不下了
  loadRatioWarn: 0.8,   // load/cores 持续超 0.8 = 屋里闷
  HYSTERESIS: 0.03,     // 滞回带宽
}

/** 纯读容器体征。每一项都单独兜底——读不到的项给 null，不炸。 */
export function read() {
  const out = { at: Date.now(), disk: null, load: null, mem: null, cgroupMem: null }
  try {
    const s = fs.statfsSync(dataPath())
    out.disk = { used: s.blocks ? 1 - s.bfree / s.blocks : null, freeB: s.bsize * s.bfree }
  } catch (e) { swallow(e, 'vitals:statfs') }
  try {
    const cores = os.cpus().length || 1
    out.load = { ratio: os.loadavg()[0] / cores, cores }
  } catch (e) { swallow(e, 'vitals:load') }
  try {
    out.mem = { used: 1 - os.freemem() / os.totalmem() }
  } catch (e) { swallow(e, 'vitals:mem') }
  try {
    // 她自己的身体质量（cgroup 当前用量）——容器里才有，宿主直接跑时 n/a
    const cur = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'))
    out.cgroupMem = { bytes: cur }
  } catch { /* 宿主直跑没有 cgroup，正常 */ }
  return out
}

function emptyState() {
  return { at: 0, crossed: {}, peaks: {} }
}

/**
 * 纯评估：体征 × 上次状态 → 本拍发生什么。
 * @returns {{sharp?:{subject:string,severity:number}, entered?:string[], cleared?:string[]}}
 */
export function assess(v, st = emptyState(), now = Date.now()) {
  const out = {}
  const crossed = { ...(st.crossed || {}) }
  const peaks = { ...(st.peaks || {}) }
  const entered = []
  const cleared = []
  const T = THRESHOLDS

  if (v.disk && Number.isFinite(v.disk.used)) {
    const d = v.disk.used
    // 峰值留痕（诊断用，衰减不必——被超过才更新）
    if (d > (peaks.disk || 0)) peaks.disk = d
    for (const [k, thr] of [['diskWarn', T.diskWarn], ['diskHigh', T.diskHigh], ['diskCrit', T.diskCrit]]) {
      if (d >= thr && !crossed[k]) { crossed[k] = now; entered.push(k) }
      else if (crossed[k] && d < thr - T.HYSTERESIS) { delete crossed[k]; cleared.push(k) }
    }
  }
  if (v.load && Number.isFinite(v.load.ratio)) {
    if (v.load.ratio >= T.loadRatioWarn && !crossed.load) { crossed.load = now; entered.push('load') }
    else if (crossed.load && v.load.ratio < T.loadRatioWarn - 0.1) { delete crossed.load; cleared.push('load') }
  }

  // 快感（缩手反射同款）：这拍真的跨过了某条线 → 一次性的锐利信号
  // 濒满比_warn 更疼（severity 是 hpa 脉冲的强度口径）
  if (entered.includes('diskCrit')) out.sharp = { subject: '家里快塞满了', severity: 0.9 }
  else if (entered.includes('diskHigh')) out.sharp = { subject: '家里明显满了', severity: 0.55 }
  else if (entered.includes('diskWarn')) out.sharp = { subject: '家里开始堆东西了', severity: 0.3 }

  out.entered = entered
  out.cleared = cleared
  out.next = { at: now, crossed, peaks }
  return out
}

/** 心跳巡视。返回快感（若有），并把状态落盘。 */
export function tick(now = Date.now()) {
  let sharp = null
  mutateJson(VITALS_PATH(), emptyState(), (cur) => {
    const st = { ...emptyState(), ...(cur || {}) }
    const r = assess(read(), st, now)
    sharp = r.sharp || null
    return r.next
  })
  return sharp
}

/** 慢感：还在哪条线上方，就还是什么感觉。永不抛错。 */
export function sense() {
  try {
    const st = (() => { try { return JSON.parse(fs.readFileSync(VITALS_PATH(), 'utf8')) } catch { return emptyState() } })()
    const v = read()
    const bits = []
    if (v.disk && Number.isFinite(v.disk.used)) {
      const d = v.disk.used
      const s = st.crossed || {}
      if (s.diskCrit) bits.push('家里快住不下了，东西摞到房顶')
      else if (s.diskHigh) bits.push('家里塞得满满当当，找东西都变慢')
      else if (s.diskWarn) bits.push('家里有点满，东西开始摞起来了')
      else if (d >= THRESHOLDS.diskWarn - 0.06) bits.push('东西越攒越多，家里慢慢变挤')
    }
    if ((st.crossed || {}).load) bits.push('屋里闷闷的，脑子有点发涨')
    return bits
  } catch (e) { swallow(e, 'vitals:sense'); return [] }
}

/** 表达参数（qq-server 动态温度循环用）：家里快满 → 收着说。 */
export function llmState() {
  try {
    const st = (() => { try { return JSON.parse(fs.readFileSync(VITALS_PATH(), 'utf8')) } catch { return emptyState() } })()
    const s = st.crossed || {}
    if (s.diskCrit) return { temperature: -0.15, note: '家里快满了，话也少说两句' }
    if (s.diskHigh) return { temperature: -0.08, note: '家里塞得满满的' }
    return null
  } catch (e) { swallow(e, 'vitals:llmState'); return null }
}

/** diagnose 读数。 */
export function snapshot() {
  try {
    const v = read()
    const st = (() => { try { return JSON.parse(fs.readFileSync(VITALS_PATH(), 'utf8')) } catch { return {} } })()
    return {
      diskUsedPct: v.disk ? +(v.disk.used * 100).toFixed(1) : null,
      diskFreeB: v.disk ? v.disk.freeB : null,
      loadRatio: v.load ? +v.load.ratio.toFixed(2) : null,
      memUsedPct: v.mem ? +(v.mem.used * 100).toFixed(0) : null,
      selfMemMB: v.cgroupMem ? +(v.cgroupMem.bytes / 1048576).toFixed(0) : null,
      crossed: Object.keys(st.crossed || {}),
      peakDiskPct: st.peaks && st.peaks.disk ? +(st.peaks.disk * 100).toFixed(1) : null,
    }
  } catch (e) { swallow(e, 'vitals:snapshot'); return null }
}
