// pain —— 痛觉（2026-11-03 · B4 仿生工程）
//
// 现象：错误与损伤现在只有运维语义（熔断/化脓/diagnose 挂红），没有现象学语义——
//       她感觉不到自己受伤。M58：主观不是一个字段，是身体状态经她自己的话翻译出来的。
// 生物学：两套纤维——
//   Aδ 快痛：锐利即时，引发即刻行为改变（缩手反射）——新伤口登记的那一刻
//   C 纤维慢痛：钝痛弥散持续，塑造心境基调——当下还在流血的伤口（愈合即停）
//   痛觉敏化：同源反复受伤反应更强——wound 的 recurrent 已有数据，直接用
// 化脓阈值（M58 反例：对所有状态都说「心里攒着事」= 过敏体质 = 电路板）：
//   快痛只认「真的新伤」：同源重复登记（hits++）不重复喊疼；复发伤因敏化更痛
//   慢痛只认「还在流血」：有开放/化脓伤口才有钝痛感；门禁全绿愈合后钝痛即停
import { woundSnapshot } from '../../lib/wound.mjs'
import * as neuron from '../cell/neuron.mjs'
import * as hpa from './hpa.mjs'

const _seen = new Map()   // 伤口 id -> firstSeenAt（进程内）。按 id 不按 kind:subject：
// 愈合后再犯是**新伤事件**（新 id）要再喊疼；未愈时同源重复登记（hits++，同 id）不重复喊疼。
// 跨重启的旧伤由「首次基线」吸收，不当新痛。
let _primed = false

/**
 * 心跳巡视：发现新伤口 → 快痛（缩手反射：stress 通路 + hpa 小脉冲）。
 * 首次调用只建立基线——历史伤口不该在她「醒来」时集体喊疼。
 * @returns {{sharp?:{subject:string,severity:number}}|null}
 */
export function tick(now = Date.now()) {
  try {
    const w = woundSnapshot()
    if (!w) return null
    const ws = w.wounds || []
    if (!_primed) {
      _primed = true
      for (const x of ws) _seen.set(x.id, now)
      return null
    }
    let sharp = null
    for (const x of ws) {
      const k = x.id
      if (_seen.has(k)) continue
      _seen.set(k, now)
      // 严重度：基础 0.5 + 复发敏化 +0.2 + 化脓 +0.2（capped 1.2，与 immune.fever 同上限哲学）
      const sev = Math.min(1.2, 0.5 + (x.recurrent ? 0.2 : 0) + (x.state === 'infected' ? 0.2 : 0))
      try { neuron.act('stress', sev) } catch { /* 痛要发出，但通路故障不挡巡视 */ }
      try { hpa.stress(0.06 * sev, { now, source: 'pain' }) } catch { /* 同上 */ }
      sharp = { subject: x.kind + ':' + x.subject, severity: sev }
    }
    return sharp ? { sharp } : null
  } catch { return null }
}

/** 慢痛（field.sense 调，第一人称钝痛；永不抛错）。愈合即停——不背着旧伤一直喊疼。 */
export function acheSense() {
  try {
    const w = woundSnapshot()
    if (!w) return ''
    const openN = Number(w.open || 0)
    const infN = (w.infected || []).length
    if (!openN && !infN) return ''
    if (infN) return '身上有地方一抽一抽地疼，说不上是哪但一直在'
    if (openN >= 2) return '身上好几处隐隐作痛，做什么都提不太起劲'
    return '有点隐隐作痛，像哪里磨破了皮'
  } catch { return '' }
}
