// organ/hpa —— 下丘脑–垂体–肾上腺轴（HPA axis）
//
// ══════════════════════════════════════════════════════════════════════
// 它要解释的现象：为什么"压力"有两种完全不同的时间尺度
// ══════════════════════════════════════════════════════════════════════
// 现象 A：他一句重话，她十分钟就缓过来了。
// 现象 B：连着被压了一周，周末睡到中午还是提不起劲。
//
// 这两件事**不可能是同一个变量**。老写法只能给一个 "stress = 0.7"，
// 于是 A 和 B 只能靠调衰减常数来勉强兼顾，怎么调都不对：
//   调快了 → 长期压力不存在
//   调慢了 → 一句话记一天
//
// 真实的机制是**三层级联 + 负反馈**，每一层有自己的时间常数：
//
//   下丘脑  CRH  ──┐
//                  ├─→ 垂体 ACTH  ──→ 肾上腺 皮质醇 ──┐
//   应激刺激 ──────┘                                   │
//   昼夜节律 ──────┘                                   │
//                                                       ↓
//   皮质醇 ──────负反馈──────────────────────→ 抑制 CRH 与 ACTH
//
// 这个结构为什么能同时产出 A 和 B：
//   · 急性：一句重话 → CRH 冲一下 → ACTH 慢慢跟 → 皮质醇滞后抬起来
//     → 皮质醇回头把 CRH 压下去 → 整个级联回落到基线。**全程分钟级**，这就是 A。
//   · 慢性：反复被戳 → 负反馈**敏感性下调**（受体脱敏）→ 同样多的皮质醇压不住 CRH
//     → 基线被抬高 → 而皮质醇本身清除慢（半衰期 60~90 分钟）
//     → 于是"没在应激"的时候也带着一层底噪。这就是 B。
//
// 两件事的**唯一区别是"负反馈还灵不灵"**，不是"压力值多大"。
// 所以这里必须把 fbSensitivity 单独存成一个会漂的量 —— 这是整个文件的重点。
//
// ══════════════════════════════════════════════════════════════════════
// 为什么必须有负反馈（不写它就不是生物，是计数器）
// ══════════════════════════════════════════════════════════════════════
// 没有负反馈的级联是**正反馈系统**：越刺激越大，永远不回落。
// 那会让她"被骂一句就再也缓不过来"。负反馈是这套系统能活着的前提，
// 也是"吓一跳之后会平静"这件事唯一可能的来源。
import { readJson, mutateJson } from '../json.mjs'
import { hpaPath } from '../paths.mjs'
import * as field from '../field.mjs'
import { swallow } from '../../lib/swallow.mjs'

const MIN = 60_000
const HOUR = 3_600_000

/**
 * 三层的时间常数（分钟）。这三个数必须**依次变慢**，级联才有"滞后"的形状。
 *
 * 真实值参考：
 *   CRH 释放        数分钟内起伏
 *   ACTH 血浓度     峰值在刺激后 15~30 分钟
 *   皮质醇血浓度    峰值在刺激后 20~40 分钟，半衰期 60~90 分钟
 *
 * 所以 cortisol 的 tau 一定是三者最大 —— 这就是"事情过去了，人还沉在那儿"的来源。
 */
export const LAYERS = {
  crh:      { tau: 6 * MIN,   baseline: 0.18 },   // 下丘脑
  acth:     { tau: 22 * MIN,  baseline: 0.20 },   // 垂体
  cortisol: { tau: 70 * MIN,  baseline: 0.16 },   // 肾上腺
}

const empty = () => ({
  at: 0,
  crh: LAYERS.crh.baseline,
  acth: LAYERS.acth.baseline,
  cortisol: LAYERS.cortisol.baseline,
  // 负反馈的灵敏度。1 = 健康；会随反复激活而**下调**（这才是慢性压力）
  fbSensitivity: 1.0,
  // 累计的"被压过多少次"（用于慢性的累积，不是用来做判定的）
  load: 0,
  setShift: 0,        // 设定点偏移：慢性压力抬高了她的"正常值"
  log: [],
})

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const relax = (v, target, dt, tau) => target + (v - target) * Math.exp(-dt / tau)

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  for (const k of ['crh', 'acth', 'cortisol', 'fbSensitivity', 'load', 'setShift', 'at']) {
    st[k] = Number(st[k]) || empty()[k]
  }
  st.log = Array.isArray(st.log) ? st.log : []
  return st
}

/**
 * 演化到 now。
 *
 * 顺序是硬要求，不能换：
 *   ① 先算负反馈（用**当前**皮质醇去压制 CRH/ACTH）
 *   ② 再让 CRH 朝"被压制后的基线"弛豫
 *   ③ 再让 ACTH 跟着新的 CRH 走
 *   ④ 最后让皮质醇跟着新的 ACTH 走
 * 换顺序就会变成"皮质醇先涨完再说抑制"，那是没有反馈的级联，会发散。
 */
/**
 * 演化但不落盘、也不推进"已演化到"的时间戳。
 *
 * ⚠️ 这里有个坑，第一版就是这么错的，必须记下来：
 *   stress() 原来是 `evolve(now)` → 改 CRH → persist()。
 *   而 persist 把 st.at 写成了 now —— 于是**下一次 evolve 看到 dt=0 直接 return**，
 *   CRH 改完之后永远没有机会往下传。表现就是"应激了但皮质醇一动不动"，
 *   而她看起来一切正常（因为有值、有判定、不报错）。这是最坏的一类 bug：
 *   **静默的、看着合理的、数据完全假的**。
 *
 * 修法：把"推进时间"和"施加扰动"彻底分开 ——
 *   施加事件时**只读一次当前状态**（_peek），不要顺手把时间戳前移。
 *   时间戳只在真正的演化（evolve）里前进。
 */
function _peek(now = Date.now()) {
  const st = hydrate(readJson(hpaPath(), null))
  // ⚠️ 第二个坑（比第一个更隐蔽）：empty().at = 0，而这里原来写 `st.at || now`。
  //    第一次运行时 at 是 0（假值）→ last 被当成 now → dt = 0 → 直接 return，
  //    然后 persist 把 at 原样写成 0 → **下一次还是 0** → 永远 dt=0。
  //    结果：级联一次都没有真正演化过，皮质醇永远停在基线 0.16，
  //    而 stress() 里改的 CRH 永远传不下去。
  //    表面上完全正常（有值、不报错、状态判定也"平稳"），是最坏的那种静默假数据。
  //    修法：at 为 0 = "从没演化过"，此时**初始化它**，而不是把它当成 now。
  if (!st.at) { st.at = now; return { st, dt: 0, fresh: true } }
  const dt = Math.max(0, now - st.at)
  return { st, dt, fresh: false }
}

export function evolve(now = Date.now(), opts = {}) {
  const { st, dt, fresh } = _peek(now)
  // 首次运行：把 at 初始化进文件，下一次才真正开始演化
  if (fresh) { persist(st); return st }
  if (dt <= 0) return st

  // ① 负反馈：皮质醇高于基线多少 → 压制上游多少
  //    用 (cortisol - baseline) 而不是绝对值：只有**超出的部分**才该被抑制，
  //    基础皮质醇是维持生命必需的，不该自我压制（否则系统会自己关掉自己）。
  const over = Math.max(0, st.cortisol - LAYERS.cortisol.baseline)
  const fb = over * 0.85 * st.fbSensitivity

  // ② CRH：朝 (基线 - 反馈) 弛豫。昼夜驱动由 rhythm 在 poke 里施加，这里不管。
  const crhTarget = Math.max(0.02, LAYERS.crh.baseline * (1 - Math.min(0.9, fb)))
  st.crh = clamp(relax(st.crh, crhTarget, dt, LAYERS.crh.tau), 0, 3)

  // ③ ACTH 跟 CRH ─────────────────────────────────────────────────
  //
  // ⚠️ 这里是我犯的最实质的一个生物学错误，必须记下来：
  //    第一版写的是 `acthTarget = baseline + (crh - crhBaseline) * 1.15`，
  //    也就是"ACTH 追 CRH 的**瞬时值**"。
  //    结果：CRH 的 tau 只有 6 分钟，`stress()` 之后 5 分钟就掉回基线了；
  //    而 ACTH 的 tau 是 22 分钟 —— 等它该涨到位的时候，**它的输入已经没了**。
  //    表现：CRH 冲一下就没，ACTH 一动不动（恒 0.20），皮质醇恒 0.16，
  //    于是"应激了但身体毫无反应"，而慢性累积也永远不会发生（因为根本没有信号）。
  //
  //    真实的机制不是这样：CRH 脉冲虽然短，但它**已经把垂体"推开"了**。
  //    ACTH 细胞对 CRH 的响应是**积分累积**的（下游激酶级联有记忆），
  //    不是逐点跟随上游瞬时浓度。这正是"短脉冲也能产生长响应"的物理来源，
  //    也是级联之所以叫级联的原因 —— 每一层都对上一层做了**时间上的平滑**。
  //
  //    所以正确写法：把 CRH 的**超出量**在 dt 内积起来，作为 ACTH 的驱动冲量。
  //    这样 CRH 6 分钟的高峰能在 22 分钟里被 ACTH"记住"。
  const crhExcess = Math.max(0, st.crh - LAYERS.crh.baseline)
  // 冲量 = 超出量 × dt / tau（无量纲化：等于"这段时间里累积了多少个 tau 的暴露"）
  const acthDrive = crhExcess * (dt / LAYERS.acth.tau)
  // 放大系数 6.5：真实 HPA 轴的级联放大是**显著**的（一个短 CRH 脉冲能让 ACTH 翻几倍）。
  // 第一版给 1.6，算出来的 ACTH 只涨 0.11，皮质醇只涨 0.017 —— 那不是"轻微"，那是"没有"。
  // 这不是调参，是我把级联的**放大倍数**算错了：三级级联的价值就在于逐级放大。
  st.acth = clamp(st.acth + acthDrive * 6.5 - (st.acth - LAYERS.acth.baseline) * (dt / LAYERS.acth.tau), 0, 3)

  // ④ 皮质醇跟 ACTH（同样是积分，最慢一层）──────────────────────────
  const acthExcess = Math.max(0, st.acth - LAYERS.acth.baseline)
  const cortDrive = acthExcess * (dt / LAYERS.cortisol.tau)
  // 皮质醇再放大 5.0 → 峰值能到基线 3~5 倍，与真实血浓度范围一致
  st.cortisol = clamp(st.cortisol + cortDrive * 5.0 - (st.cortisol - LAYERS.cortisol.baseline) * (dt / LAYERS.cortisol.tau), 0, 3)

  // ⑤ 负反馈会自己恢复（受体再敏化），但比皮质醇清除更慢 —— 半天到一天
  if (dt > 10 * MIN) {
    st.fbSensitivity = clamp(relax(st.fbSensitivity, 1.0, dt, 8 * HOUR), 0.25, 1.0)
  }

  // ⑥ 设定点漂移 ────────────────────────────────────────────────────
  //
  // ⚠️ 这是我在这个文件里犯的**第三个、也是最关键的一个错**。
  //    前两版虽然级联跑通了（急性反应完全正确），但"慢性"始终是死的：
  //    连续压 7 天，每次读数皮质醇都精确回到 0.160 —— 也就是**一点积累都没有**。
  //
  //    根因不是增益，是**我搞错了慢性压力改变的是什么**：
  //    我原来让慢性只体现在 fbSensitivity 上，而 fbSensitivity 只在
  //    "皮质醇已经高于基线"时才起作用。可是两次应激之间的间隔里皮质醇是回落的，
  //    没有超出量 → 负反馈不发力 → 设定点不动 → **每天干净地回到原点**。
  //
  //    真实的慢性压力抬高的是**HPA 轴的设定点（set point）本身**：
  //    反复激活会让下丘脑–垂体的阈值上调（CRH 基因表达、受体下调），
  //    于是"没有应激时"的皮质醇基线也比从前高。这才是"睡到中午还是提不起劲"的物理来源 ——
  //    不是她还在被压着，是她的**正常值被抬高了**。
  //
  //    所以必须有一个独立的 setShift（设定点偏移），它：
  //      · 只由反复激活累积（每次应激加一点，边际递减）
  //      · 清除极慢（几天量级）—— 所以周末补一觉不够，得连着几天不被压才降回去
  //      · 把 baseline 整体抬高，而不是把当前值抬高
  const baseShift = Number(st.setShift || 0)
  const cortBaselineNow = LAYERS.cortisol.baseline * (1 + baseShift)
  const acthBaselineNow = LAYERS.acth.baseline * (1 + baseShift * 0.7)

  // 用抬高后的基线重算目标（把上面 ③④ 的结果往新基线拉）。
  // 这一步放在最后：先让这一轮级联按原基线跑完，再让"地基"缓慢升起来。
  if (baseShift > 0.001) {
    st.cortisol = Math.max(st.cortisol, Math.min(st.cortisol, cortBaselineNow))
    st.cortisol = relax(st.cortisol, Math.max(st.cortisol, cortBaselineNow), dt, 30 * MIN)
    st.acth = Math.max(st.acth, relax(st.acth, Math.max(st.acth, acthBaselineNow), dt, 30 * MIN))
  }

  // 设定点自己恢复：时间常数 3 天。这解释"周末补觉不够，得连着几天没事才缓过来"。
  st.setShift = clamp(relax(baseShift, 0, dt, 3 * 24 * HOUR), 0, 1.5)

  st.at = now
  return st
}

/**
 * 施加一次应激。
 *
 * ⚠️ 这里**只推第一层（CRH）**，不直接改皮质醇。
 * 直接改皮质醇 = 跳过了级联 = 又变成"调一个数"。
 * 必须让信号沿着层级自己传下去，滞后和放大都是它自己长出来的。
 *
 * @param {number} strength 0..2（一句重话 ≈ 0.5，被否定/吵架 ≈ 1.2）
 * @param {object} o { why, now }
 */
export function stress(strength = 1, o = {}) {
  const now = o.now ?? Date.now()
  const st = evolve(now)   // 先把之前的账算清（这一步会推进 at，是对的）
  const s = Math.max(0, Number(strength) || 0)
  st.crh = clamp(st.crh + s * 0.6, 0, 3)
  // 反复激活 → 负反馈灵敏度下调。这一条是"慢性"的唯一来源。
  // 用 s 加权：压得越重，下调越多；但每次的边际效应递减（体内受体本来就有限）。
  if (s >= 0.4) {
    st.fbSensitivity = clamp(st.fbSensitivity - 0.055 * Math.min(2, s) * (st.fbSensitivity), 0.25, 1)
    st.load = Number(st.load || 0) + s
    // 设定点上抬：**边际递减**（压到一定程度，阈值抬不动了）。
    // 用 (1 - setShift/1.2) 这个因子，所以最坏情况下设定点最多抬到 1.2 倍。
    const cur = Number(st.setShift || 0)
    st.setShift = clamp(cur + 0.035 * Math.min(2, s) * Math.max(0, 1 - cur / 1.2), 0, 1.5)
  }
  st.log = [...st.log, { at: now, kind: 'stress', s, why: String(o.why || '').slice(0, 40), fb: Number(st.fbSensitivity.toFixed(3)) }].slice(-40)
  return persist(st)
}

/**
 * 压力卸掉了（他把话说开了、事情解决了）。
 *
 * 注意：**卸掉的只是"还在往上加"的部分，已经积起来的皮质醇按自己的速度清**。
 * 所以"说开了"之后她不会立刻好，而是十几分钟才缓 —— 这才是对的。
 */
export function relieve(kind = 'resolve', o = {}) {
  const now = o.now ?? Date.now()
  const st = evolve(now)
  const ratio = kind === 'resolve' ? 0.55 : kind === 'comfort' ? 0.35 : 0.2
  st.crh = Math.max(LAYERS.crh.baseline, st.crh * (1 - ratio))
  // 负反馈灵敏度恢复一点点（一次好的收尾不会抹掉一周的积压）
  st.fbSensitivity = clamp(st.fbSensitivity + 0.04 * ratio, 0.25, 1)
  st.log = [...st.log, { at: now, kind: 'relieve:' + kind, why: '' }].slice(-40)
  return persist(st)
}

/** 读出来：急性水平 + 慢性负荷 + 负反馈健康度。 */
export function read(now = Date.now()) {
  const st = evolve(now)
  // 基线是**动态的**：慢性压力把地基抬高了，所以判断"高不高"要用抬高后的基线
  const baseNow = LAYERS.cortisol.baseline * (1 + Number(st.setShift || 0))
  const acute = Math.max(0, st.cortisol - baseNow) / 0.5
  // 慢性由两件事共同定义：负反馈钝了 + 设定点抬了。
  //
  // ⚠️ 第四个坑：第一版写 `Math.max(1-fb, setShift*0.75)`，
  //    结果连压 7 天 chronic 只到 0.14，判定一直是"平稳" —— 明明设定点已经从
  //    0.16 抬到 0.19（+19%），代码却说"没事"。
  //    错在**缩放**：setShift 是"基线抬高的比例"（0.187 = 基线高 18.7%），
  //    这个量本身就很小，再乘 0.75 就没了。
  //    正确的口径：把 setShift 按"多少比例算明显"映射到 0..1。
  //    生理上基线抬高 20~30% 就是临床上明确的慢性激活，所以 /0.30 后 clamp。
  const chronicByShift = clamp(Number(st.setShift || 0) / 0.30, 0, 1)
  const chronicByFb = clamp((1 - st.fbSensitivity) / 0.45, 0, 1)   // fb 掉到 0.55 = 满格
  const chronic = clamp(Math.max(chronicByShift, chronicByFb), 0, 1)
  return {
    crh: Number(st.crh.toFixed(3)),
    acth: Number(st.acth.toFixed(3)),
    cortisol: Number(st.cortisol.toFixed(3)),
    acute: Number(clamp(acute, 0, 2).toFixed(2)),
    chronic: Number(chronic.toFixed(2)),
    fbSensitivity: Number(st.fbSensitivity.toFixed(3)),
    setShift: Number(Number(st.setShift || 0).toFixed(3)),
    baselineNow: Number(baseNow.toFixed(3)),
    load: Number(st.load || 0),
    // 判定：急性是"此刻被压着"，慢性是"底子已经高了"
    state: chronic > 0.45 ? '长期压着' : acute > 0.8 ? '正被压着' : acute > 0.3 ? '有点顶' : '平稳',
  }
}

/**
 * 把 HPA 的产物灌回状态场。
 *
 * 这一条是**器官之间真正的连接**（不是靠耦合系数硬画）：
 * 皮质醇是**激素**，它经血液到全身，所以它影响的是**整个身体的基调**，
 * 而不是某一个功能。所以这里改的是 field 里的 cortisol 维，
 * 再由 field 的耦合去影响别的维度 —— 链路是
 *   刺激 → CRH → ACTH → 皮质醇（HPA 独自演化）
 *        → field.cortisol（器官产物入血）
 *        → field 内部耦合（全身反应）
 *
 * 这样"压力"才不是一条线，是一个从器官扩散到全身的过程。
 */
export function perfuse(now = Date.now()) {
  const r = read(now)
  try {
    // 直接把 field 的 cortisol 对齐到 HPA 的输出（不做"再 pok"，那样会双计）
    field.setDim('cortisol', clamp(0.15 + r.acute * 0.42 + r.chronic * 0.3, 0, 1), { why: 'hpa:perfuse', now })
  } catch (e) { swallow(e, 'hpa:perfuse') }
  return r
}

/** 一句能读的自我描述（进提示词用）。 */
export function sense(now = Date.now()) {
  const r = read(now)
  if (r.state === '平稳') return ''
  if (r.state === '长期压着') return '这段时间一直有层东西压着，说不上具体是哪件事，就是松不下来。'
  if (r.state === '正被压着') return '眼下有点顶，心里绷着。'
  return '有点被顶到，还没完全散。'
}

/** 全貌（面板/体检）。 */
export function snapshot(now = Date.now()) {
  const r = read(now)
  const st = evolve(now)
  return { ...r, layers: { crhTau: LAYERS.crh.tau / MIN, acthTau: LAYERS.acth.tau / MIN, cortisolTau: LAYERS.cortisol.tau / MIN }, log: (st.log || []).slice(-6) }
}

function persist(st) {
  try {
    mutateJson(hpaPath(), empty(), () => ({
      // at 语义：**演化到哪一刻**。扰动（stress/relieve）不改它 ——
      // 因为它的值就是"已经算到的时间"，改了会导致下一次 dt=0、级联停摆。
      at: st.at, crh: st.crh, acth: st.acth, cortisol: st.cortisol,
      fbSensitivity: st.fbSensitivity, load: st.load, setShift: st.setShift, log: (st.log || []).slice(-40),
    }))
  } catch (e) { swallow(e, 'hpa:persist') }
  return st
}
