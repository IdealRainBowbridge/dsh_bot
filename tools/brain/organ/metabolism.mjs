// metabolism —— 能量与消化（2026-11-03 · B3 仿生工程）
//
// 现象：零件都在但没连成闭环——binge 是进食、novelty 是食欲、REM 结算是消化，
//       但没有一条「血糖曲线」：没有地方回答「她的脑子现在还有多少电？
//       今天吃进去的东西消化了没有？」
// 生态位（别和现有维度撞）：
//   field.fatigue   管身体（短时恢复，聊久了乏）
//   field.sleepDebt 管睡眠债（长时，只增不减）
//   energy（本器官）管**认知资源**：想动脑的事消耗它，轻松的内容回充它，
//                   睡一觉回满；吃进去的信息不消化会积压。
// 生物学：进食-消化-供能。信息就是食物：
//   · 处理一条消息 = 消耗一小口（大脑占全身 20% 能耗，思考是烧糖的）
//   · binge 看完一集 = 进食（内容摄入，精神回充）**但要消化**——pendingDigest 积压
//   · REM = 消化时段：积压下降、消化产物回充能量（「学到了」）
//   · N3 = 修复时段：基础回充
//   · 清醒 = 净基础消耗（极慢，防止无限耗尽靠的是夜里回满）
// 措辞（M58 主观红线）：饿是第一人称的「脑子转不动」，积压是「脑子里堆着没消化的东西」。
import fs from 'node:fs'
import { dataPath } from '../../lib/paths.mjs'
import { swallow } from '../../lib/swallow.mjs'
import { updateJson, readJsonSafe } from '../../lib/atomic.mjs'
import * as sleepstage from './sleepstage.mjs'

const STATE_FILE = () => dataPath('metabolism.json')
const SPEND_PER_MSG = 0.004   // 每条消息的认知消耗（100 条/天 ≈ 0.4，夜里回满）
const EAT_PER_BINGE = 0.12    // 看完一集的进食回充
const DIGEST_PER_REM_MIN = 0.12          // REM 每分钟消化积压条数
const ENERGY_PER_DIGESTED = 0.01         // 每消化一条的回充（「学到了」）
const REST_PER_N3_MIN = 0.0025           // N3 每分钟基础修复（7h 睡眠中 N3≈90min → +0.22）
const AWAKE_BURN_PER_MIN = 0.00035       // 清醒基础代谢（16h ≈ 0.34，与消息消耗同量级）
const MAX_PENDING = 20

const _cache = { st: null, at: 0 }
function readState(now = Date.now()) {
  if (_cache.st && now - _cache.at < 10_000) return _cache.st
  const s = readJsonSafe(STATE_FILE(), null) || {
    energy: 1.0, pendingDigest: 0, lastTickAt: 0,
    stats: { messages: 0, binges: 0, digested: 0 },
  }
  _cache.st = s; _cache.at = now
  return s
}
function saveState(s, now = Date.now()) {
  _cache.st = s; _cache.at = now
  try { updateJson(STATE_FILE(), () => s) } catch (e) { swallow(e, 'metabolism:save') }
}

/** 认知消耗（消息处理时调——大脑思考是烧糖的）。 */
export function spend(x = SPEND_PER_MSG, now = Date.now()) {
  try {
    const s = readState(now)
    s.energy = Math.max(0, s.energy - Number(x))
    s.stats.messages++
    saveState(s, now)
  } catch (e) { swallow(e, 'metabolism:spend') }
}

/** 进食（binge 成功调）：精神回充 + 内容积压（要消化）。 */
export function eat(x = EAT_PER_BINGE, now = Date.now()) {
  try {
    const s = readState(now)
    s.energy = Math.min(1, s.energy + Number(x))
    s.pendingDigest = Math.min(MAX_PENDING, (Number(s.pendingDigest) || 0) + 1)
    s.stats.binges++
    saveState(s, now)
  } catch (e) { swallow(e, 'metabolism:eat') }
}

/**
 * 心跳 tick：按睡眠分期驱动消化/修复/基础代谢。
 * @returns {{stage:string, energy:number, pending:number}|null}
 */
export function tick(now = Date.now()) {
  try {
    const s = readState(now)
    const last = Number(s.lastTickAt || 0)
    s.lastTickAt = now
    if (!last || now <= last) { saveState(s, now); return null }
    const dtMin = Math.min(60, (now - last) / 60_000)   // 防大步长跳变（重启/停机）
    if (dtMin < 0.1) return null
    const st = sleepstage.currentStage(now)
    let stage = 'awake'
    if (st.stage === 'REM') {
      stage = 'REM'
      // 消化：积压下降 + 回充
      const digested = Math.min(s.pendingDigest, DIGEST_PER_REM_MIN * dtMin)
      if (digested > 0) {
        s.pendingDigest = Math.max(0, s.pendingDigest - digested)
        s.energy = Math.min(1, s.energy + digested * ENERGY_PER_DIGESTED)
        s.stats.digested += digested
      }
    } else if (st.stage === 'N3') {
      stage = 'N3'
      s.energy = Math.min(1, s.energy + REST_PER_N3_MIN * dtMin)
    } else if (st.stage) {
      stage = st.stage
      s.energy = Math.max(0, s.energy - AWAKE_BURN_PER_MIN * 0.3 * dtMin)   // 浅睡代谢更低
    } else {
      s.energy = Math.max(0, s.energy - AWAKE_BURN_PER_MIN * dtMin)
    }
    saveState(s, now)
    return { stage, energy: Number(s.energy.toFixed(3)), pending: Number(s.pendingDigest.toFixed(2)) }
  } catch (e) { swallow(e, 'metabolism:tick'); return null }
}

/** 身体感（field.sense 调，第一人称；永不抛错）。 */
export function sense() {
  try {
    const s = readState()
    const bits = []
    const e = Number(s.energy)
    if (e < 0.15) bits.push('脑子转不动了，饿得发慌')
    else if (e < 0.3) bits.push('有点饿了，想问题都费劲')
    else if (e < 0.5) bits.push('脑子有点空，想吃点什么轻松的')
    const p = Number(s.pendingDigest)
    if (p >= 8) bits.push('脑子里堆了一堆没消化的东西，胀')
    else if (p >= 3) bits.push('白天看的东西还没消化完，有点撑')
    return bits.join('；')
  } catch { return '' }
}

/** 面板/diagnose 全貌。 */
export function snapshot() {
  try {
    const s = readState()
    return {
      energy: Number(Number(s.energy).toFixed(3)),
      pendingDigest: Number(Number(s.pendingDigest).toFixed(2)),
      ...s.stats,
    }
  } catch { return null }
}
