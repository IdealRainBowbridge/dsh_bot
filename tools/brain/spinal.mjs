// brain/spinal —— 表达神经汇（2026-11-05）。
// 以前 QQ 说话链自己手抓 5 个器官的 llmState()（免疫/代谢/痛觉/表达代谢/体感），
// field（情绪场）与 rhythm（昼夜节律）各有现成的表达读数却没接线 —— 情绪和作息
// 不影响表达，仿生断了两根神经。spinal 把全部"身体→表达"的读数汇成一次调用：
//
//   const sp = spinalState()
//   sp.temperature  相对偏移（叠加到内容基调上）
//   sp.maxTokensMul 输出预算乘数（0.4~1.0，代谢/睡眠压强决定，1=不收）
//   sp.note         体感一句话（注进 system，最贴近当下的器官说了算）
//   sp.sources      哪些器官在发声（diagnose 自检用）
//
// 器官缺席/异常永远不炸：每个读数独立 try，坏了就当没意见（llmState 家族契约）。
import { swallow } from '../lib/swallow.mjs'
import { asleep, sleepPressure } from './rhythm.mjs'
import { voiceReadiness, cognitiveDepth, patience, irritability } from './field.mjs'

// 偏移量的钳位（±0.5）：最终温度的 clamp（0.35~1.05）由调用方做 —— spinal 只管身体偏了多少
function clampBias(t) { return Math.max(-0.5, Math.min(0.5, t)) }

/** 单个读数源的安全求值：返回数值或 null（读数函数抛错/非数值都算没意见） */
function num(fn) {
  try { const v = Number(fn()); return Number.isFinite(v) ? v : null }
  catch (e) { swallow(e, 'spinal:read'); return null }
}

export function spinalState(opts = {}) {
  const now = opts.now ?? Date.now()
  const out = { temperature: 0, maxTokensMul: 1, note: '', sources: [] }

  // ── 情绪场（field）：四个表达读数 ──
  const vr = num(() => voiceReadiness())
  if (vr != null) {
    // voiceReadiness 0~1（下限 0.08）：低=不想出声 → 收温度；高=有表达欲 → 放开一点
    if (vr < 0.3) { out.temperature -= 0.15; out.note = out.note || '没什么说话的欲望，句子会短' }
    else if (vr > 0.7) out.temperature += 0.08
    out.sources.push('field.voice')
  }
  const pat = num(() => patience())
  if (pat != null && pat < 0.3) {
    out.temperature -= 0.1
    out.note = out.note || '耐心不多，别绕弯子'
    out.sources.push('field.patience')
  }
  const ir = num(() => irritability())
  if (ir != null && ir > 0.6) {
    out.temperature -= 0.12
    out.note = '有点烦躁，说话会硬一点'
    out.sources.push('field.irrit')
  }
  const cd = num(() => cognitiveDepth())
  if (cd != null && cd < 0.3) {
    out.maxTokensMul *= 0.7
    out.sources.push('field.depth')
  }

  // ── 昼夜节律（rhythm）：睡眠压强与入睡状态 ──
  const pres = num(() => sleepPressure(now))
  if (pres != null && pres > 0.7) {
    out.maxTokensMul *= 0.6
    out.note = out.note || '困得很，话会短、可能词不达意'
    out.sources.push('rhythm.sleepPressure')
  }
  let asleepNow = false
  try { asleepNow = asleep(now) === true } catch { asleepNow = false }
  if (asleepNow) {
    out.temperature -= 0.15
    out.note = '半梦半醒被叫起来的含糊劲儿'
    out.sources.push('rhythm.asleep')
    out.maxTokensMul *= 0.5
  } else {
    const hour = new Date(now).getHours()
    if (hour >= 1 && hour < 6) {
      out.note = out.note || '深夜还醒着，有点飘'
      out.sources.push('rhythm.lateNight')
    }
  }

  out.temperature = clampBias(out.temperature + (opts.temperatureBias || 0))
  return out
}

/** 供 diagnose 用：列出当前哪些器官在发声（接线自检）。 */
export function spinalSources() {
  try { return spinalState().sources } catch { return [] }
}
