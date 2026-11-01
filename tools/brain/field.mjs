// brain/field —— 状态场：不是变量，是场。
//
// ══════════════════════════════════════════════════════════════════════
// 为什么不能写成"变量 + 定时器"
// ══════════════════════════════════════════════════════════════════════
// 旧写法（mood.mjs 2026-10-27 那次真实事故）：
//   tickMood() 每次推送前跑一遍；饭点 +7、非饭点 -0.5、饿过头每 tick 心情 -4。
// 结果：**推送频率变成了生理频率**。推送一分钟摇一次 → 两小时把饥饿打满 100，
//       而"退"是按次数退（每小时 -0.5），于是整天卡在 80/100，每轮提示词都写着
//       「饿（82/100），满脑子都是吃的」；心情被每 tick 砍 4 分 clamp 到底。
//
// 根因不是参数调错。是**形状错了**：把"时间"实现成了"调用次数"。
// 生物不接受调用次数，生物只接受时间。
//
// 所以本文件只有一条铁律：
//   **一切演化按真实经过的时间 dt 算，不按调用次数。**
// 机器睡了一夜，回来 tick 一次就等于过了一夜；
// 高频轮询一百次，也只等于一百次加起来的真实时间。
// 这一条直接消灭了"频率决定行为"这一整类 bug —— 不是修掉，是让它不可能发生。
//
// ══════════════════════════════════════════════════════════════════════
// 场和变量的区别（这是本文件的全部意义）
// ══════════════════════════════════════════════════════════════════════
// 变量：读一个数。63 就是 63。
// 场：  每一维有 ①惯量（时间常数）②静息点（set，而且 set 自己会漂）
//       ③与其他维的**不对称耦合** ④软边界
//       读出来的是"此刻往哪走"和"离开这里有多难"，不是"现在多少"。
//
// 两个直接后果，都是生物的形状：
//   ① **负反馈会振荡。** 因为回归有延迟，被拉下去的值会过头再拉回来。
//      所以情绪不是"稳定在 60"，是在 55~70 之间晃。晃才是活的。
//   ② **拉一个带动一片。** 睡眠债高会拉低血清素（没睡够就没耐心），
//      皮质醇高会拉低效价。没有这一层，各维度就只是几个独立的仪表盘。
import { readJson, mutateJson } from './json.mjs'
import { fieldPath } from './paths.mjs'

/* ── 维度的定义：每一维都写清"为什么是这个形状" ───────────────────── */

/**
 * tau 是**恢复时间常数**（回到 1-e⁻¹ ≈ 63% 所需的时间），不是"多久归零"。
 * 用指数回归而不是线性，是因为生物不是匀速恢复的：离开得越远，掉得越快，
 * 越接近静息点越慢 —— 这叫"弛豫"，也是为什么熬完夜的那股累很久才散。
 */
export const DIMS = {
  // ── 化学层：神经调质 ────────────────────────────────────────────
  // 它们不是"信号"，是**全局增益**：改了整片网络的信噪比与响应速度。
  // 这就是为什么一杯咖啡（去甲）会同时让你话多、打字快、还容易烦。

  // 多巴胺编码的是**预测误差**（实际 - 预期），不是快乐。
  // 形状上必须满足：一直有糖吃，da 会回到基线（耐受）。
  // 所以它的静息点会被"最近的经历"慢慢拉走，而单次 reward 只是短时抬高。
  da:        { v: 0.50, set: 0.50, tau: 25 * 60_000,    lo: 0, hi: 1,  scale: 1.0 },
  // 去甲肾上腺素：唤醒 / 信噪比。高 = 反应快、聚焦，但视野窄（容易钻牛角尖）。
  ne:        { v: 0.35, set: 0.35, tau: 12 * 60_000,    lo: 0, hi: 1,  scale: 1.0 },
  // 血清素：耐心 / 冲动抑制。低 = 一句话就想顶回去、等不了、回得又短又冲。
  sero:      { v: 0.60, set: 0.60, tau: 3 * 3600_000,   lo: 0, hi: 1,  scale: 1.0 },
  // 皮质醇：慢性压力负荷。只在**长时间高唤醒**下才累积，且清除极慢。
  // 这就是"连着忙一周，周末也歇不过来"的形状。
  cortisol:  { v: 0.15, set: 0.15, tau: 10 * 3600_000,  lo: 0, hi: 1,  scale: 1.0 },

  // ── 生理层：不是能量条，是代谢产物 ──────────────────────────────
  // 疲劳只有在"该功能不被使用"时才清除 —— 所以它的恢复依赖空闲，
  // 不是依赖时间流逝。一直用地，就一直不清。
  fatigue:   { v: 0.10, set: 0.10, tau: 5 * 3600_000,   lo: 0, hi: 1,  scale: 1.0 },
  // 睡眠债：**只增不减**，除非真的睡。这是"越熬越钝"的全部机制。
  // set 是 0：它不是"会回到某个正常值"，它是欠账，只能还。
  sleepDebt: { v: 0.20, set: 0.00, tau: 36 * 3600_000,  lo: 0, hi: 1,  scale: 1.0 },

  // ── 主观层 ─────────────────────────────────────────────────────
  // 效价：好事把它推上去，但它受皮质醇拖、受睡眠债拖。
  valence:   { v: 0.00, set: 0.00, tau: 90 * 60_000,    lo: -1, hi: 1, scale: 1.0 },
  // 未了之事：答应过没做的、想说没说出口的。它自己渗得很慢，
  // 但它会**持续往皮质醇里滴**——这就是"心里压着事"的物理来源。
  tension:   { v: 0.00, set: 0.00, tau: 6 * 3600_000,   lo: 0, hi: 6,  scale: 1.0 },
}

/**
 * 耦合：这张表就是"她是一个整体"的代码形状。
 *
 * 三个刻意的不对称，每一个都有生理依据：
 *   ① 睡眠债 → 血清素（减）  没睡够就没耐心。反过来不成立：你今天脾气差，
 *                              不会让你欠睡眠。**方向必须单向**，双向就是错的形状。
 *   ② 疲劳 → 唤醒（减）      累到一定程度就兴奋不起来了。但兴奋不会让你更累
 *                              （真正让你累的是做事，另有一条路）。
 *   ③ 皮质醇 → 效价（减）    长期压力把人往下拖。而"今天心情差"不会变成慢性压力
 *                              —— 那是要靠时间累积的。
 *
 * k 是"每单位偏差、每秒"的传导系数；实际每次按 dt 缩放。
 */
export const COUPLING = [
  { from: 'sleepDebt', to: 'sero',     k: -0.30, why: '没睡够就没耐心' },
  { from: 'fatigue',   to: 'ne',       k: -0.26, why: '累到一定程度兴奋不起来' },
  { from: 'cortisol',  to: 'valence',  k: -0.34, why: '长期压力把人往下拖' },
  { from: 'tension',   to: 'cortisol', k:  0.09, why: '压着的事会慢慢变成背景压力' },
  { from: 'da',        to: 'ne',       k:  0.16, why: '兴奋提神' },
  { from: 'sleepDebt', to: 'fatigue',  k:  0.20, why: '欠的觉会直接变成身上的沉' },
]

/* ── 读写 ─────────────────────────────────────────────────────────── */

const empty = () => ({
  at: 0,                       // 上次演化到的时间戳（所有 dt 都由它算）
  dims: {},                    // { name: value }
  drift: {},                   // 静息点自己的漂移（见 driftSets）
  log: [],                     // 最近 60 次扰动（用来回答"她为什么这样"）
})

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.dims = { ...(st.dims || {}) }
  for (const k of Object.keys(DIMS)) {
    const v = Number(st.dims[k])
    st.dims[k] = Number.isFinite(v) ? v : DIMS[k].v
  }
  st.drift = { ...(st.drift || {}) }
  st.log = Array.isArray(st.log) ? st.log : []
  st.at = Number(st.at) || 0
  return st
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * 指数弛豫：把 v 从当前位置朝 target 拉，经过 dt 之后落到的位置。
 *
 *   v' = target + (v - target) · e^(-dt/tau)
 *
 * 这就是"弛豫"的形状：一开始掉得快，接近目标时慢下来。
 * 用线性插值（v + (target-v)*p）在 dt 不均时会严重失真 —— 而 dt 永远不均，
 * 因为机器会睡、进程会卡、tick 会漏。
 */
function relax(v, target, dtMs, tauMs) {
  if (dtMs <= 0 || !(tauMs > 0)) return v
  return target + (v - target) * Math.exp(-dtMs / tauMs)
}

/**
 * 演化到 now。**幂等**：同样的 now 调用两次，第二次是空操作。
 * 这是硬要求 —— 多个进程都在调 tick，不能谁多调一次就多演化一次。
 */
export function evolve(now = Date.now()) {
  const st = hydrate(readJson(fieldPath(), null))
  const last = st.at || now
  let dt = now - last
  if (dt <= 0) return st            // 时间没往前走 → 什么都不做（幂等）
  // 上限：机器睡了三天，回来不该一次性补三天的情绪演化（那会算出没意义的值）。
  // 24h 之后按 24h 算 —— 这是"隔了太久，细节已经不可追"的形状。
  if (dt > 24 * 3600_000) dt = 24 * 3600_000

  // ① 每一维朝自己的静息点弛豫（静息点受 drift 影响：耐受/敏感化）
  for (const [k, d] of Object.entries(DIMS)) {
    const set = Number(st.drift[k] ?? d.set)
    st.dims[k] = clamp(relax(st.dims[k], set, dt, d.tau), d.lo, d.hi)
  }

  // ② 耦合按 dt 比例传导（比例用"相对该维时间常数"的那个量，才有正确量纲）
  for (const c of COUPLING) {
    const from = st.dims[c.from], to = st.dims[c.to]
    const dTo = DIMS[c.to]
    const dev = from - Number(st.drift[c.from] ?? DIMS[c.from].set)   // 偏离自己静息点多少
    const step = dev * c.k * (dt / (dTo.tau + dt))                    // 该维自己的惯性
    st.dims[c.to] = clamp(to + step, dTo.lo, dTo.hi)
  }

  st.at = now
  return st
}

/** 把演化结果落盘。多进程共用，必须走 atomic（updateJson 内部加锁）。 */
export function persist(st) {
  try {
    mutateJson(fieldPath(), empty(), () => ({
      at: st.at,
      dims: st.dims,
      drift: st.drift,
      log: (st.log || []).slice(-60),
    }))
  } catch (e) { /* 场写不进去绝不影响业务 */ }
  return st
}

/* ── 扰动：世界对她做了什么 ───────────────────────────────────────── */

/**
 * 戳一下某一维。
 *
 * @param {string} dim 维度名
 * @param {number} delta 位移（正负）
 * @param {object} [o] { why, now }
 *
 * 注意：这不是"设置值"，是**施加扰动**。扰动会立刻生效，但之后按自己的 tau 弛豫回去。
 * 所以"她说了一句让自己难堪的话"会让她难过一阵再慢慢平复 —— 而不是记住一个 -0.5。
 */
export function poke(dim, delta, o = {}) {
  const d = DIMS[dim]
  if (!d) return null
  const st = evolve(o.now ?? Date.now())
  st.dims[dim] = clamp(Number(st.dims[dim] || 0) + Number(delta || 0), d.lo, d.hi)
  st.log = [...(st.log || []), { at: o.now ?? Date.now(), dim, delta: Number(delta || 0), why: String(o.why || '').slice(0, 60) }].slice(-60)
  return persist(st)
}

/**
 * 把某一维**对齐**到某个值（不是扰动，是赋值）。
 *
 * 为什么需要它，以及它和 poke 的区别（这个区别很关键）：
 *   poke    = 世界对她加了一个冲量。之后它会按自己的 tau 弛豫回去。
 *             适合"他夸了她一句"这种一次性事件。
 *   setDim  = 某个**器官算出的产物**要写进全身。
 *             适合"肾上腺分泌了多少皮质醇" —— 那个量是 HPA 轴自己算出来的，
 *             不该再被 field 的弛豫二次加工，否则等于算了两遍。
 *
 * 用错的后果很实在：如果用 poke 去灌皮质醇，HPA 的慢清除和 field 的弛豫会
 * 叠加成"衰减两次"，压力会以两倍速度消失 —— 那就不像人了。
 *
 * @param {string} dim
 * @param {number} value 目标值（会被 clamp 到该维的上下界）
 * @param {object} [o] { why, now }
 */
export function setDim(dim, value, o = {}) {
  const d = DIMS[dim]
  if (!d) return null
  const now = o.now ?? Date.now()
  const st = evolve(now)
  const v = clamp(Number(value), d.lo, d.hi)
  const prev = Number(st.dims[dim])
  st.dims[dim] = v
  // 只有在明显变化时才留痕，避免每 tick 一条把日志刷满
  if (Math.abs(v - prev) > 0.02) {
    st.log = [...(st.log || []), { at: now, dim, delta: Number((v - prev).toFixed(3)), why: String(o.why || 'set').slice(0, 60) }].slice(-60)
  }
  return persist(st)
}

/**
 * 移动静息点 —— 这是"耐受"与"敏感化"的代码形状。
 *
 * 生物依据：同一刺激反复给，受体会下调（耐受）；很久没有，会上调（敏化）。
 * 这一点用"改数值"做不出来，只能改**静息点**：因为数值会弛豫回静息点，
 * 只有静息点变了，变化才会留下来。
 *
 * @param {string} dim
 * @param {number} delta 静息点位移
 * @param {number} [cap] 允许偏离初始 set 的最大幅度（防漂到不可逆）
 */
export function driftSet(dim, delta, cap = 0.25) {
  const d = DIMS[dim]
  if (!d) return null
  const st = evolve()
  const cur = Number(st.drift[dim] ?? d.set)
  const next = clamp(cur + Number(delta || 0), d.set - cap * (d.hi - d.lo), d.set + cap * (d.hi - d.lo))
  st.drift[dim] = Number(next.toFixed(4))
  return persist(st)
}

/** 还债：只有真睡才调。还按「睡多久」算，不是「睡了一次」。 */
export function repaySleep(hours = 0, now = Date.now()) {
  const h = Math.max(0, Number(hours) || 0)
  if (!h) return null
  const st = evolve(now)
  // 一晚上按 8 小时能清掉约 0.85 的债（不是清空：睡眠本来就不是万能的）
  st.dims.sleepDebt = clamp(st.dims.sleepDebt * Math.exp(-h / 9.4), DIMS.sleepDebt.lo, DIMS.sleepDebt.hi)
  // 疲劳的清除比睡眠债快得多，但它同样按小时算
  st.dims.fatigue = clamp(st.dims.fatigue * Math.exp(-h / 5.5), DIMS.fatigue.lo, DIMS.fatigue.hi)
  st.at = now
  st.log = [...(st.log || []), { at: now, dim: 'sleep', delta: -h, why: '睡了 ' + h.toFixed(1) + ' 小时' }].slice(-60)
  return persist(st)
}

/* ── 派生：这才是"决策读场"的地方 ─────────────────────────────────── */

/**
 * 此刻"说话"这件事对她有多顺手。0..1 的连续量。
 *
 * 为什么不要布尔：生物没有布尔。她不是"想说话/不想说话"两种状态，
 * 是"话到嘴边"的程度。0.2 的时候她会回得很短，0.8 的时候她会自己找话说。
 *
 * 形状依据：
 *   · 睡眠债和疲劳是**减法**（做过头的身体不想说话）
 *   · 去甲是**增益**（醒着才说得出话），但过高反而会窄（钻牛角尖、只说一句）
 *   · 血清素高 = 愿意多聊几句（耐心）
 *   · tension 高 = 有话想说（但和疲劳冲：累到极点时，有话也不想说）
 */
export function voiceReadiness(s = null) {
  const st = s || evolve()
  const d = st.dims
  // ⚠️ 校准记录（2026-11-02 实测）：
  //    第一版 awake = 1 - 0.75*sleepDebt - 0.55*fatigue。
  //    sleepDebt 和 fatigue 都到 1.0 时（凌晨连熬），awake 变成**负数**，
  //    于是 voiceReadiness 和 cognitiveDepth 双双 clamp 到 0 ——
  //    她会彻底不说话。结构是对的（那个点确实该很不想说话），
  //    但**不该是零**：真人在凌晨被叫醒也会回一句"嗯…几点了"。
  //    零会让系统看起来像坏了，而且掩盖了"只是很困"这个信息。
  //    改成乘法衰减而不是减法：永远不会变负，而且"很困"仍然有 15~25% 的余量。
  const awake = clamp((1 - 0.62 * d.sleepDebt) * (1 - 0.52 * d.fatigue), 0, 1)
  const gain = 0.35 + 0.9 * d.ne
  const narrow = d.ne > 0.78 ? 0.75 : 1          // 太亢奋反而只说一句
  const patient = 0.55 + 0.45 * d.sero
  const urge = 0.35 * Math.min(1, d.tension / 2.5)
  // 下限 0.08：不是"还能说很多"，是"还能吭一声"。这个下限是刻意的 ——
  // 一个人再累也不会变成静音设备，她只会变得极其简短。
  return clamp(awake * gain * narrow * patient + urge * awake, 0.08, 1)
}

/**
 * 此刻能想多深。决定要不要"心里先想一遍"，以及想多长。
 * 累到底的时候人只能敷衍 —— 这不是懒，是代谢上真的没有余量。
 */
export function cognitiveDepth(s = null) {
  const st = s || evolve()
  const d = st.dims
  // 同样改成乘法（见上面 voiceReadiness 的校准记录），并给一个很低但不为零的下限：
  // 0.05 意味着"还能想一步"，但想不了复杂的。这是"困得说不清话"而不是"死机"。
  return clamp((1 - 0.58 * d.sleepDebt) * (1 - 0.48 * d.fatigue) * (0.6 + 0.4 * d.sero), 0.05, 1)
}

/** 能等多久才回。血清素低 + 唤醒高 = 急。 */
export function patience(s = null) {
  const st = s || evolve()
  const d = st.dims
  return clamp(0.25 + 0.75 * d.sero - 0.35 * Math.max(0, d.ne - 0.5), 0, 1)
}

/** 现在有多"冲"。皮质醇 + 低血清素 + 高唤醒。用来决定要不要顶回去。 */
export function irritability(s = null) {
  const st = s || evolve()
  const d = st.dims
  return clamp(0.5 * d.cortisol + 0.4 * (1 - d.sero) + 0.3 * Math.max(0, d.ne - 0.55), 0, 1)
}

/** 给提示词用的一行。不是"情绪 63"，是**能读出方向**的一段。 */
export function sense(s = null) {
  const st = s || evolve()
  const d = st.dims
  const bits = []
  if (d.sleepDebt > 0.45) bits.push('缺觉，脑子发钝')
  else if (d.sleepDebt > 0.25) bits.push('有点欠觉')
  if (d.fatigue > 0.55) bits.push('身上发沉，不想多动')
  else if (d.fatigue > 0.3) bits.push('有点乏')
  if (d.cortisol > 0.5) bits.push('心里压着一层，说不上来哪不对')
  if (d.tension > 2) bits.push(`还有 ${Math.round(d.tension)} 件事没落地，偶尔会飘上来`)
  if (d.valence > 0.3) bits.push('心情是往上的')
  else if (d.valence < -0.3) bits.push('心情低')
  if (d.ne > 0.72) bits.push('人在亢奋，话会冲一点')
  if (!bits.length) bits.push('状态平稳')
  return '你此刻的身体：' + bits.join('；') + '。'
}

/** 面板/体检要看的全貌。 */
export function snapshot() {
  const st = evolve()
  return {
    at: st.at,
    dims: Object.fromEntries(Object.entries(st.dims).map(([k, v]) => [k, Number(Number(v).toFixed(3))])),
    drift: st.drift,
    derived: {
      voiceReadiness: Number(voiceReadiness(st).toFixed(3)),
      cognitiveDepth: Number(cognitiveDepth(st).toFixed(3)),
      patience: Number(patience(st).toFixed(3)),
      irritability: Number(irritability(st).toFixed(3)),
    },
    sense: sense(st),
    log: (st.log || []).slice(-8),
  }
}
