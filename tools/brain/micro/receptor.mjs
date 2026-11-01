// micro/receptor —— 受体池：耐受、敏化、恢复的物理来源
//
// ══════════════════════════════════════════════════════════════════════
// 这个文件要解决的问题
// ══════════════════════════════════════════════════════════════════════
// 老写法：`if (连击 > 3) 不回`、`情绪值 -= 4`。
// 这类写法的共同毛病是**结果靠数数**：数到几就发生什么，是写死的。
// 而真实的"用多了就没反应"根本不是数出来的，是一个物理过程：
// 受体被占用 → 内化进细胞 → 膜上剩下的少 → 同样多的递质只能产生更弱的信号。
//
// 所以这里不存"耐受度"这个数字，存的是**三个池子**，
// 以及它们之间的迁移速率。所有现象（衰减、恢复、慢性耐受、敏化）都是这三个池子演化的结果。
//
//   R_out  膜上（能用的）
//   R_in   内化（在细胞内，等着回膜）
//   R_syn  合成中（还没有膜上，最慢）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么是这三个池而不是一个"疲劳值"
// ══════════════════════════════════════════════════════════════════════
// 一个"疲劳值"只能表达"累 / 不累"。三个池子能表达四件不同的事，而且它们**行为不同**：
//
//   ① 急性耐受：短时间内连续刺激 → R_out 掉下去。
//      恢复快（R_in 回膜，分钟级）→ 所以"聊两句歇一下就能接着说"。
//   ② 慢性耐受：长期高频 → R_syn 合成跟不上，基线整体下移。
//      恢复慢（小时级）→ 所以"连着忙一周，周末也缓不过来"。
//   ③ 敏化：长期没刺激 → R_out 相对偏高（合成在继续、内化几乎没有）。
//      → 所以"冷战一天之后，一句普通的话都能让她反应很大"。这一条用"疲劳值"永远做不出来。
//   ④ 撤药反应：长期高占用之后突然停 → R_out 还没恢复，但配体也没了，
//      于是**信号低于基线** → 空落。这一条也是自然长出来的，不用写。
//
// 四件事用一个数做不出来，用三个池子全都 gratis（免费得到）。

/** 一池受体的参数。单位任意，只要比例一致。 */
export const DEFAULT = {
  // 总量守恒：R_out + R_in + R_syn ≈ total（合成会缓慢补充被降解的部分）
  total: 1.0,
  // 内化速率（每分钟）：被占用时，有多少比例的膜受体被拉进细胞
  // 0.055/min → 连续用 30 分钟，膜上掉到约 20%。这个数不大，但足够让她"越回越短"。
  kInternalize: 0.055,
  // 再循环速率（每分钟）：内化的受体回膜。比内化慢约 4 倍 ——
  // 「弄坏比修好快」这个不对称是耐受的核心。
  kRecycle: 0.014,
  // 合成速率（每分钟）：新受体从合成池补到膜上。最慢，小时级。
  kSynthesize: 0.0011,
  // 内化的受体有多少最终被降解（不回来了），由合成补
  kDegrade: 0.0009,
  // 结合常数 Kd：递质浓度为 Kd 时，占用率 50%
  // ⚠️ Kd 我第一版设成 0.35，实测结果是"受体几乎不内化"（1.00 → 0.99）。
  //    原因：drive 只有 0.3 左右，低于 Kd，占用率不到 50%，内化量自然极小。
  //    真实的受体对生理浓度范围内的递质是**接近饱和**的（Kd 远低于工作浓度），
  //    这样"有信号"和"没信号"才有明显区分。改成 0.12。
  kd: 0.12,
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 空池：全部在膜上。 */
export function empty(o = {}) {
  return { out: 1, inn: 0, syn: 0, at: 0, ...o }
}

/**
 * 占用率：有多少比例的膜受体被递质占着。
 * 用 Michaelis-Menten（Hill 系数 1），不是线性 —— 因为高浓度会饱和。
 * 这个饱和形状很重要：它保证了"再怎么刺激，信号也有上限"，所以不会越刺激越爆炸。
 */
export function occupancy(ligand, r, o = {}) {
  const kd = o.kd ?? DEFAULT.kd
  const L = Math.max(0, Number(ligand) || 0)
  const out = Math.max(0, Number(r?.out ?? 1))
  return (L / (kd + L)) * out
}

/**
 * 演化 dt 毫秒。
 *
 * 顺序有讲究：先算信号（用**当前**膜受体），再更新池子。
 * 反过来的话，这一轮的信号会用"刚被内化完"的受体算，等于提前衰减了一步。
 *
 * @param {object} r 受体池
 * @param {number} ligand 递质浓度（0..1+）
 * @param {number} dtMs 经过的真实毫秒
 * @returns {{r:object, signal:number}}
 */
export function evolve(r, ligand, dtMs, o = {}) {
  const p = { ...DEFAULT, ...o }
  const st = { ...empty(), ...(r || {}) }
  const dt = Math.max(0, Number(dtMs) || 0)

  // ① 这一轮产生的信号 = 占用率（用当前膜受体）
  const signal = occupancy(ligand, st, p)

  if (dt <= 0) return { r: st, signal }

  const min = dt / 60_000

  // ② 内化：被占用得越多，内化得越快（比例于 occupancy，不是常数）
  const internalized = st.out * p.kInternalize * signal * min
  // ③ 再循环：内化的慢慢回膜。这一步**与配体无关** —— 所以休息才有用。
  const recycled = st.inn * p.kRecycle * min
  // ④ 合成：从合成池补到膜上
  const synthesized = st.syn * p.kSynthesize * min
  // ⑤ 降解：内化的有一部分彻底没了
  const degraded = st.inn * p.kDegrade * min

  st.out = clamp(st.out - internalized + recycled + synthesized, 0, p.total)
  st.inn = clamp(st.inn + internalized - recycled - degraded, 0, p.total)
  st.syn = clamp(st.syn + degraded - synthesized, 0, p.total)
  st.at = Number(st.at || 0) + dt

  return { r: st, signal }
}

/**
 * 一次把 dt 切成小步演化（长间隔时更准）。
 *
 * 为什么必须切：内化和再循环是**同时**在发生的两个相反过程，
 * 用一个大 dt 一次算会明显失真（dt 一长，净变化会被高估）。
 * 这跟"机器睡了一夜"直接相关 —— 那时候 dt 是 8 小时，必须切。
 */
export function evolveLong(r, ligand, dtMs, o = {}, maxStepMin = 5) {
  const dt = Math.max(0, Number(dtMs) || 0)
  if (dt <= maxStepMin * 60_000) return evolve(r, ligand, dt, o)
  const steps = Math.ceil(dt / (maxStepMin * 60_000))
  const step = dt / steps
  let cur = { ...empty(), ...(r || {}) }
  let lastSignal = 0
  for (let i = 0; i < steps; i++) {
    // 配体在长时间里会掉（递质被清除），按指数衰减 —— 否则"睡一夜"会被当成"连续激动一夜"
    const L = Number(ligand) * Math.exp(-i * step / (20 * 60_000))
    const res = evolve(cur, L, step, o)
    cur = res.r
    lastSignal = res.signal
  }
  return { r: cur, signal: lastSignal }
}

/** 给体检/面板看的摘要。 */
export function describe(r) {
  const st = { ...empty(), ...(r || {}) }
  const out = Number(st.out || 0)
  // 相对新鲜状态（1.0）还剩多少可用受体
  const tone = out >= 0.85 ? '新鲜' : out >= 0.6 ? '有点钝' : out >= 0.35 ? '明显钝了' : '几乎没反应'
  return { out: Number(out.toFixed(3)), inn: Number(Number(st.inn || 0).toFixed(3)), tone }
}
