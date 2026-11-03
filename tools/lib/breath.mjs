// breath —— 呼吸（2026-11-03 · B2 仿生工程）
//
// 现象：人类发消息有节奏——紧张时短句连发，平静时长句慢发。
//       她现在是事件驱动即答即发，气泡间隔是「420+随机900ms」的固定配方。
// 生物学：呼吸性窦性不均——吸气相交感占优、呼气相副交感回摆；
//         呼吸频率本身随代谢/唤醒上升（应激时浅快，静息时深长）。
// 形状：周期 T = T0 / (1 + K·arousal)（唤醒越高呼吸越浅快），
//       间隔在呼气相最长、吸气相最短，用余弦平滑过渡（不是开关）。
//       纯函数：相位由 (now, ne) 唯一决定，无状态文件——呼吸不需要账本，
//       它是节律不是事件。工程先例：receptor 的纯函数豁免同族。
// 主观红线（M58）：静息时不改变行为只改变节奏——gap() 只在「已有多个气泡」时
//       被问，单气泡回复与决策层完全看不到它。
// 器官判据：单独拿出来能演出「同一句话，高唤醒分得密、低唤醒拖得长」。
const T0_MS = 5200     // 静息呼吸周期（成人静息 12~16/min → 4-5s，取 5.2s）
const K = 1.4          // 唤醒对频率的增益：ne=1 → T≈2.2s（浅快）
const GAP_IN = 260     // 吸气相最短间隔（紧张连发）
const GAP_OUT = 1500   // 呼气相最长间隔（平静慢发）
const JITTER = 0.18    // ±18% 呼吸性不均（每次都一样就成了机械）

/** 当前呼吸相位。 */
export function phase(now = Date.now(), ne = 0.3) {
  const a = Math.max(0, Math.min(1, Number(ne) || 0))
  const T = T0_MS / (1 + K * a)
  return { T, phi: (((now % T) + T) % T) / T, arousal: a }
}

/** 下一个气泡前该歇多久（qq-server 气泡循环调）。now/ne 决定一切，随机只管不均匀。 */
export function gap(now = Date.now(), ne = 0.3) {
  const { T, phi, arousal } = phase(now, ne)
  const w = 0.5 * (1 - Math.cos(2 * Math.PI * phi))   // 0@φ=0 → 1@φ=0.5 → 0@φ=1（吸气短→呼气长→回）
  const base = GAP_IN + (GAP_OUT - GAP_IN) * w
  const scale = 1 / (1 + 0.5 * arousal)               // 唤醒把整条曲线压快
  const g = base * scale * (1 + JITTER * (2 * Math.random() - 1))
  return Math.max(120, Math.round(g))
}
