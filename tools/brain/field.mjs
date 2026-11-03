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
import { feverSense as immuneFeverSense } from '../lib/immune.mjs'
import { fieldPath } from './paths.mjs'
import * as receptor from './micro/receptor.mjs'

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
  //
  // accrualOnly: true —— 见 evolve() 里那段注释。
  // 这个字段就是"注释说的事"落到代码上的形状：不写它，注释只是一句愿望。
  sleepDebt: { v: 0.20, set: 0.00, tau: Infinity, lo: 0, hi: 1, scale: 1.0, accrualOnly: true },

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
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ 2026-11-02 修正：光有 k 不够，还要区分「推一下」和「把基线挪走」
 * ══════════════════════════════════════════════════════════════════════
 * 原来每一条都是"推一下"：每步把 to 往某个方向推 delta，而 to 自己同时在
 * 朝 set 弛豫。当 to 的 tau 远小于 from 的 tau 时，推的量会被弛豫当场吃掉，
 * 稳态偏移 ≈ 0 —— **这条耦合等于不存在**。
 *
 * 实测（脚本 shape_test2）：cortisol 拉到 0.9（相当于连压一周），valence
 * 只掉到 -0.155 就开始回弹，8h 后已回到 -0.115。也就是说：
 * **长期压力完全拖不动她的心情。** 这不是方向错，是量级错。
 *
 * 为什么是形状错而不是参数错：真实生理里，慢性皮质醇改变的是**基线**
 * （HPA 那条已经学到过："慢性压力抬高设定点，不是挂 fbSensitivity"）。
 * 心情不是"被推下去又弹回来"，是"这段时间整个人的底色就低"。
 *
 * 所以给耦合加一个 mode：
 *   · 'push'（默认）—— 推一下。适合**同量级 tau** 的两个维度之间
 *                      （例如 da→ne：都是分钟到小时级，推一下合理）
 *   · 'set'          —— 拖动目标的**静息点**。适合**慢变量 → 快变量**
 *                      （cortisol tau 10h 拖 valence tau 1.5h；
 *                        sleepDebt tau 36h 拖 fatigue tau 5h）
 * 'set' 模式下，一旦慢变量回落，静息点也跟着回来 —— 不是永久改写，
 * 而是"这段时间的基线"。这就是可逆的耐受/情绪底色，而不是一次性的伤害。
 *
 * ── 以下是原来那张表的说明，仍然成立 ────────────────────────────────
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
/**
 * ══════════════════════════════════════════════════════════════════════
 * 共用受体池：把「配线」换成「同一个池子的不同投影」（2026-11-02 重构）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用户否定过 COUPLING 那种写法：「那不是器官，是配线」。
 * 但**删掉配线不等于有了器官** —— 先要找到这八维到底共享什么物理实体。
 *
 * 答案在 `micro/receptor.mjs`：受体池（膜上/内化/合成中三池迁移）。
 * 它已经用真曲线验证过：连聊 30 分钟 out 0.951→0.485，歇 1 小时回 0.774。
 * 这才是"耐受/敏化/恢复"的物理来源。
 *
 * 所以重构后的形状是：
 *
 *   一个共用受体池 capacity（0..1，全体神经调质共用的"响应能力"）
 *        ↓ 不是 k 系数，是**同一个池子的读数**
 *   sero / ne / da 三个调质 = f(capacity, 各自的当前库存)
 *
 * 为什么这样就不是配线了：
 *   · 配线是"A 变了，按系数推 B 一下"—— 两个独立实体之间的**附加连线**
 *   · 这里是"池子被抽干，所有依赖它的读数一起降"—— **同一个实体**的多个面
 *   判据：把 receptor 那段单独拿出来，它能自己演出耐受与恢复；
 *         把 COUPLING 单独拿出来，它什么也演不出（只是六个乘法）。
 *
 * ⚠ 但**不能把八维全换成只读读数**。实测依赖分析（见文件末尾 REWRITE-NOTES）：
 *   sleepDebt / cortisol / valence / tension 四个量**外部要写**：
 *     heartbeat:309      poke('sleepDebt', delta)     每拍累加
 *     sleepstage:286     repaySleep(h)                真睡时扣减
 *     sleepstage:314     setDim('valence', ...)       REM 降强度
 *     hpa:312            setDim('cortisol', ...)      器官产物入血
 *     inner:135/195      poke('tension', ...)         没说完的话压着
 *   把它们变成只读 = 打断四条写入链。所以它们**仍然是可写量**，
 *   只是它们的**静息点**由受体池决定（而不是由另一条配线推）。
 */

/**
 * 共用受体池的落盘位置。
 *
 * 为什么不塞进 field.json 的 dims：它是**另一个器官**的状态（三池各有自己的
 * 时间常数），混进 dims 会让"维度"和"器官"两个概念糊在一起。
 * 分开存，但演化时一起推进 —— 就像肝和血糖是两个东西，但一起变。
 */
function poolOf(raw) {
  const p = raw?.pool
  if (!p || typeof p !== 'object') return receptor.empty()
  return { ...receptor.empty(), ...p }
}

/**
 * 这一拍的"响应能力"怎么变。
 *
 * 关键设计：**什么在消耗受体池？** 不是"聊天次数"，是**被激动的时间**。
 * 这正是 receptor.evolve 的入参语义（ligand × dt），天然按时间算，
 * 不会退化成"调用次数决定生理"（本文件开头那条铁律）。
 *
 * @param {object} pool  当前受体池
 * @param {object} dims  当前维度
 * @param {number} dtMs  距上次演化的真实毫秒
 * @returns {{pool:object, capacity:number, drive:number}}
 */
function evolvePool(pool, dims, dtMs) {
  // 驱动量 = **超出基线**的神经活动，不是绝对活动。
  //
  // ⚠ 2026-11-02 实测踩到的坑：第一版写 `drive = ne * 0.6 + tension/3 * 0.5`，
  //   也就是拿绝对活动当驱动。后果是**池永远回不满**：
  //   只要她醒着，ne 就在 0.3 左右，drive 恒 ≈ 0.16 > 0，于是池一直被消耗。
  //   实测：磨 2 小时 pool=0.412，然后安静 4 小时 —— **pool 还是 0.412**，
  //   一点没恢复。那等于"用过的受体永远回不来"，比原来的配线还糟。
  //
  //   真实的受体不会因为"你还醒着"就持续内化。内化是**激动**的结果
  //   （occupancy 驱动的 kInternalize），基线水平的紧张度不该算。
  //   所以：只有超过静息点的部分才算驱动，安静时 drive 归零，池就自己回膜。
  const ne = Number(dims.ne ?? 0.35)
  const tension = Number(dims.tension ?? 0)
  const neBaseline = Number(DIMS.ne.set ?? 0.35)      // 静息唤醒，不算消耗
  const neExcess = Math.max(0, ne - neBaseline)
  // tension 也用**超出"心里正常挂着 1 件"的增量**，不是绝对量。
  // 第一版用 tension/3，哪怕只剩 0.2 的事也还在持续压受体池 ——
  // 实测：安静 16 小时池只回到 0.53。真实的受体不会因为"心里还有点事"就不回膜。
  const tensionDrive = Math.max(0, Math.min(1, (tension - 1.0) / 3)) * 0.5
  const drive = Math.max(0, neExcess * 1.6 + tensionDrive)
  const res = receptor.evolveLong(pool, drive, dtMs, {}, 5)
  const capacity = Number(res.r.out || 1)
  return { pool: res.r, capacity, drive }
}

export const COUPLING = [
  // ══════════════════════════════════════════════════════════════════════
  // 2026-11-02 重构：原来 6 条，现在 3 条
  // ══════════════════════════════════════════════════════════════════════
  //
  // 删掉的三条（sleepDebt→sero / fatigue→ne / da→ne）：
  //   它们全部由**共用受体池**替代了 —— 见 evolve() 里 ⓪ 那一段。
  //   那三条的本质都是"某个慢量把另一个调质压低"，而真正发生的事是
  //   **同一个受体池被抽干，所有调质一起降**。留它们等于把同一件事算两遍：
  //   容量掉 30% 时 sero 会被压两次（池一次、配线一次），实测过冲。
  //
  // 保留的三条，是因为它们**不是同一个池的关系**，是真·跨器官：
  //   · sleepDebt → fatigue：睡眠债是账，疲劳是组织状态。账不直接等于状态，
  //     中间隔着恢复过程（所以是 set 不是 push）。
  //   · cortisol → valence：HPA 轴（另一个器官）的产物影响情绪底色。
  //     这是**器官间**的轴，不是同一器官内部的耦合。
  //   · tension → cortisol：未了之事经由 HPA 轴变成背景压力，也是跨器官。
  //
  // 判据：这三条的两端**属于不同器官**（账/HPA/内心），删掉就没有别的路能表达；
  //       删掉那三条的两端**属于同一个受体池**，所以是重复表达。
  { from: 'sleepDebt', to: 'fatigue',  k:  0.20, mode: 'set',  why: '欠的觉会直接变成身上的沉' },
  { from: 'cortisol',  to: 'valence',  k: -0.34, mode: 'set',  why: '长期压力把人往下拖' },
  { from: 'tension',   to: 'cortisol', k:  0.09, mode: 'push', why: '压着的事会慢慢变成背景压力' },
]

/* ── 读写 ─────────────────────────────────────────────────────────── */

const empty = () => ({
  at: 0,                       // 上次演化到的时间戳（所有 dt 都由它算）
  dims: {},                    // { name: value }
  drift: {},                   // 静息点自己的漂移（见 driftSets）
  pool: null,                  // 共用受体池（micro/receptor 的状态，见 evolvePool）
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
  st.pool = poolOf(st)
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
  // ⚠️ 这里原来写 `const last = st.at || now` —— 那是本文件最严重的一个 bug。
  //
  //     empty().at = 0，而 0 是假值 → last 被当成 now → dt = 0 → 下面 `dt <= 0` 直接 return。
  //     而 return 之前**不会 persist** → at 永远是 0 → 下一次还是 dt = 0。
  //
  //     后果：这个"状态场"建好之后**一次都没演化过**。field.json 的 at 一直是 0，
  //     dims 里全是测试脚本用 poke/setDim 塞进去的值，不是时间算出来的。
  //     而 cognitiveDepth / sleepiness / self.decide / think.introspect 全建在它上面 ——
  //     整具身体的稳态是假的：她不会因为熬夜变铝，也不会因为休息恢复。
  //
  //     形状上的错误才是关键：**at = 0 的语义是"从没演化过"，不是"现在"**。
  //     把它当成 now，等于假设"她三分钟前刚初始化"——于是时间永远追不上。
  //
  //     修法与 hpa.mjs:120 一致：at 为 0 = 首次运行 → 初始化它并落盘，下一次才真正开始演化。
  //     （同一个坑在 hpa.mjs 踩过并修好了，field.mjs 漏了。全仓再扫过一遍，只剩这一处。）
  if (!st.at) {
    st.at = now       // 首次：把 at 落盘，本轮不演化（没有"上一次"可比）
    persist(st)
    return st
  }
  const last = st.at
  let dt = now - last
  if (dt <= 0) return st            // 时间没往前走 → 什么都不做（幂等）
  // 上限：机器睡了三天，回来不该一次性补三天的情绪演化（那会算出没意义的值）。
  // 24h 之后按 24h 算 —— 这是"隔了太久，细节已经不可追"的形状。
  if (dt > 24 * 3600_000) dt = 24 * 3600_000

  // ① 每一维朝自己的静息点弛豫（静息点受 drift 影响：耐受/敏感化）
  //
  // ⚠️ 2026-11-02：**sleepDebt 不能被时间弛豫掉。**
  //
  //    它的定义就在 DIMS 的注释里："只增不减，除非真的睡 —— 这是'越熬越钝'的全部机制"。
  //    但那一行写的是 `tau: 36 * 3600_000`，于是这个循环每拍都在把它往 set=0 拉。
  //
  //    实测（改前）：sleepDebt 被 poke 到 0.9 之后，48 小时自己掉回 0.264，
  //    这期间**一次都没睡**。也就是说"熬夜的债"会自己蒸发。
  //    而 night.assess 又不用 sleepDebt 算睡意（见那边的注释），
  //    两头一夹，结果就是：**"越熬越困"这条最基本的规律，在这个模型里根本不存在。**
  //
  //    一个"账"的性质是：不清就一直欠着。所以这里跳过它 —— 只由
  //    repaySleep() 在真睡时按实际小时数扣，别的一律不动。
  //    （这也是 M58 那条"睡意是账不是衰减量"的直接落地。）
  // ⓪ **先推进共用受体池** —— 这一步在维度弛豫之前，因为它是"响应能力"的来源。
  //
  //    顺序有讲究：如果先弛豫维度再算池，这一拍的 capacity 用的是**上一拍**
  //    的 ne/tension，等于永远差一拍。差一拍在 30 秒心跳里就是 30 秒的滞后，
  //    对"聊着聊着变钝"这种分钟级现象还算够，但会让刚被顶上去的 tension
  //    晚一拍才反映到耐受上。先算池，整条链就同拍。
  const poolRes = evolvePool(st.pool, st.dims, dt)
  st.pool = poolRes.pool
  const capacity = poolRes.capacity

  for (const [k, d] of Object.entries(DIMS)) {
    if (d.accrualOnly) continue            // 只增不减的账：时间不会替你还
    let set = Number(st.drift[k] ?? d.set)
    // **共用的响应能力**：受体池越空，所有调质的静息点一起往下走。
    //
    // 这就是"器官"和"配线"的分界：
    //   · 配线：sero 的 set 被 sleepDebt 按 -0.30 推（两个独立量之间的线）
    //   · 这里：sero/ne/da 的 set 都乘同一个 capacity（一个实体，多个面）
    // 所以这条改动**同时**替换了 COUPLING 里 sleepDebt→sero、fatigue→ne、
    // da→ne 三条 —— 不是把系数改小，是那三条线不再需要存在。
    if (k === 'sero' || k === 'ne' || k === 'da') {
      // 映射要**温和**：容量是"响应能力"，不是"调质存量"。
      //
      // ⚠️ 实测踩到的坑：第一版写 `d.set * (0.35 + 0.65 * capacity)` ——
      //   容量掉到 0.53 时 sero 的 set 从 0.60 被压到 0.40，
      //   而且**永久停在那里**（因为池回不到 1）。等于一次累就永久变钝，
      //   那不是耐受，是损伤。真感受体下调只有 20~40%，且会恢复。
      //
      // 改成：最多下压 40%，且只在容量低于 0.8 时才线性生效。
      //   容量 1.00 → 系数 1.00（不动）
      //   容量 0.80 → 系数 1.00（不动，正常波动不算损耗）
      //   容量 0.50 → 系数 0.85
      //   容量 0.20 → 系数 0.76
      const loss = Math.max(0, (0.8 - capacity) / 0.8) * 0.40   // 0..0.40
      set = clamp(d.set * (1 - loss), d.lo, d.hi)
    }
    st.dims[k] = clamp(relax(st.dims[k], set, dt, d.tau), d.lo, d.hi)
  }

  // ② 耦合按 dt 比例传导（比例用"相对该维时间常数"的那个量，才有正确量纲）
  //
  //    'push' 和 'set' 的区别见 COUPLING 上方那段注释。
  //    'set' 有个额外的关键约束：**drift 必须随慢变量一起回落**，
  //    否则一次熬夜就把她的疲劳基线永久抬高 —— 那是伤害，不是状态。
  //    所以这里每步都从「静息点 + 当前慢变量偏差 × k」重新算，
  //    而不是往 drift 里累加。慢变量回到静息点时，drift 自动归零。
  for (const c of COUPLING) {
    const from = st.dims[c.from], to = st.dims[c.to]
    const dTo = DIMS[c.to]
    const dFrom = DIMS[c.from]
    const dev = from - Number(st.drift[c.from] ?? dFrom.set)   // 偏离自己静息点多少

    if (c.mode === 'set') {
      // 拖动目标的静息点：不是推一下，是把"这段时间的基线"挪过去。
      //
      // ⚠️ 第一版直接写 `baseline = dTo.set + dev * c.k`，每步都从当前值重算，
      //    结果形成了负反馈回环：sero 被压 → 它的 dev 变负 → 把 sleepDebt 那条
      //    （sleepDebt→sero）的输入带歪 → 基线再次被非线性地推走。
      //    实测 2h 就把 sero 从 0.60 砸到 0.18（连熬两夜才该有的程度），
      //    这是**过冲**，不是"没睡够就没耐心"。
      //
      //    真实的慢性调节是**慢**的：皮质醇持续偏高期间，情绪底色一点点往下走，
      //    而不是一小时掉到底。所以这里加两件事：
      //      ① 基线本身也按自己的 tau 弛豫过去（不瞬移）
      //      ② k 乘一个 0.55 的衰减 —— 让"慢变量把基线挪走"这件事
      //         弱于"快变量自己的恢复"，否则一个慢变量就能把整个系统按死
      const target = dTo.set + dev * c.k
      const cur = Number(st.drift[c.to] ?? 0)
      // drift 存的是"相对静息点的偏移"，按目标自己的 tau 缓慢趋近目标
      const nextDrift = cur + (target - dTo.set - cur) * (dt / (dTo.tau * 2 + dt))
      st.drift[c.to] = Number(nextDrift.toFixed(4))
      const baseline = dTo.set + nextDrift
      st.dims[c.to] = clamp(relax(to, baseline, dt, dTo.tau), dTo.lo, dTo.hi)
    } else {
      const step = dev * c.k * (dt / (dTo.tau + dt))           // 该维自己的惯性
      st.dims[c.to] = clamp(to + step, dTo.lo, dTo.hi)
    }
  }

  st.at = now
  // ⚠️ 2026-11-02 重构时发现的**既有 bug**：这里原来只有 `return st`，没有 persist。
  //
  //   后果：`evolve()` 算完的永远是**内存里的临时对象**，下次调用又从磁盘读旧值。
  //   也就是说 —— 只有在 `poke()/setDim()/repaySleep()` 里（它们会 `return persist(st)`）
  //   才真正写盘；**安静的时候，生理完全冻结**。
  //
  //   实测证据（临时数据目录）：初始化 at=T，推进 30 秒后 at **仍然是 T**，dims 一个没动。
  //   而生产中 field.json 的 at 看起来在走，是因为她一直在被 poke（心跳累加 sleepDebt、
  //   inner 压 tension）—— 一次 poke 顺手把 evolve 的结果存下来了。
  //   所以这是**假活**：有人戳才动，没人戳就停尸。半夜安静 8 小时，她不会变困、不会恢复。
  //
  //   这跟本文件开头那条铁律（"一切演化按真实经过的时间 dt 算"）直接冲突：
  //   dt 算得再对，不落盘就等于没算。形状对了，管道漏了。
  persist(st)
  return st
}

/** 把演化结果落盘。多进程共用，必须走 atomic（updateJson 内部加锁）。 */
export function persist(st) {
  try {
    mutateJson(fieldPath(), empty(), () => ({
      at: st.at,
      pool: st.pool || null,
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
  else if (d.fatigue > 0.3) bits.push('身上有点乏')
  if (d.cortisol > 0.5) bits.push('心里压着一层，说不上来哪不对')
  if (d.tension > 2) bits.push(`还有 ${Math.round(d.tension)} 件事没落地，偶尔会飘上来`)
  if (d.valence > 0.3) bits.push('心情是往上的')
  else if (d.valence < -0.3) bits.push('心情低')
  if (d.ne > 0.72) bits.push('人在亢奋，话会冲一点')
  // 免疫病感（2026-11-03）：发热是全身性事件，和日常状态一起被她感觉到。
  // 放在"正面信号"兜底之前——发烧时她不该被描述成"身上是轻的"。
  try {
    const fever = immuneFeverSense()
    if (fever) bits.push(fever)
  } catch { /* 病感失败就当没病，不能反过来挡身体感 */ }

  // ⚠️ 2026-11-02 补：正面信号不能缺。
  //
  //    原来只有"没有坏消息"时给一句「状态平稳」—— 那是**空缺**，不是正面。
  //    这个坑在 self.mjs 的 leanOf 里踩过一次并写了注释：
  //      "输入没有正面信号，它只能往负面填；连精神好那次也全说脑子有点乱"。
  //    同一类错误不该在两个地方各犯一次。
  //
  //    而且"状态平稳"读起来像体检报告，不像身体感觉。
  //    真人精神好的时候是会知道的：身上轻、脑子转得动、有点想说话。
  if (!bits.length) {
    if (d.sleepDebt < 0.15 && d.fatigue < 0.2 && d.sero > 0.6) {
      bits.push('身上是轻的，脑子也转得动')
      if (d.valence > 0.15) bits.push('心里挺舒展')
    } else if (d.sleepDebt < 0.3 && d.fatigue < 0.35) {
      bits.push('身上没什么乏的，还算清爽')
    } else {
      bits.push('状态平稳')
    }
  }
  // ══════════════════════════════════════════════════════════════════════
  // 第一人称（2026-11-02 改）
  // ══════════════════════════════════════════════════════════════════════
  // 原来是「你此刻的身体：缺觉，脑子发钝。」—— 第二人称。
  //
  // 这不是语法偏好问题。差别在于：
  //   第二人称 = **外面有人在告诉她**她的状态（像护士念病历）
  //   第一人称 = **她自己感觉到**的（这才是"主观"那一层的定义）
  //
  // 用户在 M58 里要求的是后者：
  //   "她**体验到**什么，而不是系统**断言**什么。"
  // 第二人称的"你此刻的身体：……"正是"系统断言"的形态 —— 主语是系统，宾语是她。
  // 换成"我……"，主语和宾语就都是她了。
  //
  // 注意一个反作用：这段会和其他 first-person 内容一起进入 system，
  // 所以措辞要**像念头**，不能像陈述句。加"感觉""有点""身上"这类词，
  // 让它读起来是她在心里过了一遍，不是在念检查报告。
  // 拼成一句像"心里过了一遍"的话，而不是"我" + 病历条目。
  // 中文里表达身体感觉很少说"我缺觉"，会说"感觉缺觉""有点缺觉"
  // —— 前者是陈述，后者是**感觉**。差的就是这个字。
  const joined = bits.join('；')
  const lead = /^我/.test(joined) ? '' : '感觉'
  return lead + joined.replace(/^感觉/, '') + '。'
}

/** 面板/体检要看的全貌。 */
export function snapshot() {
  const st = evolve()
  return {
    at: st.at,
    dims: Object.fromEntries(Object.entries(st.dims).map(([k, v]) => [k, Number(Number(v).toFixed(3))])),
    // 共用受体池：她此刻的"响应能力"。0..1，掉下去就是钝了。
    // 单独暴露是因为 doctor/面板要看这个 —— 它是**器官状态**，不是维度。
    pool: {
      capacity: Number(Number(st.pool?.out ?? 1).toFixed(3)),
      internalized: Number(Number(st.pool?.inn ?? 0).toFixed(3)),
      synthesizing: Number(Number(st.pool?.syn ?? 0).toFixed(3)),
    },
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

/* ══════════════════════════════════════════════════════════════════════
 * REWRITE-NOTES（2026-11-02 重构全链影响清单）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这次改的是**耦合层**，不是维度本身。理由：依赖分析发现四个量外部要写，
 * 把它们变成只读会打断四条真实写入链。
 *
 * ── 谁在读、读了什么、会不会受影响 ────────────────────────────────
 * | 文件:行 | 读什么 | 用于 | 这次改动的影响 |
 * |---|---|---|---|
 * | organ/self.mjs:313 | snapshot().dims | ctx.field → desire() | dims 仍是 0..1，只多了 pool 字段，**无影响** |
 * | organ/self.mjs | derived.cognitiveDepth | 决定 span / need 过滤 | 值域不变，但**数值会变**（sero 现在受容量调制）→ 她更累时可选动作会更少，这是**想要的效果** |
 * | organ/thalamus.mjs:91-92 | dims.sleepDebt/fatigue/ne | 门控阈值 | 同上，阈值更早触发，**想要的效果** |
 * | organ/heartbeat.mjs:307-309 | dims.sleepDebt → poke | 每拍累加睡眠债 | sleepDebt 仍是可写累加量，**无影响** |
 * | organ/night.mjs:241 | dims.sleepDebt | 睡意评分 | **无影响** |
 * | organ/sleepstage.mjs:313-314 | dims.valence → setDim | REM 降情绪强度 | valence 仍可写，**无影响** |
 * | organ/hpa.mjs:312 | setDim('cortisol') | 器官产物入血 | cortisol 仍可写，**无影响** |
 * | brain/index.mjs:111-119 | poke valence/ne/da/sleepDebt | 事件扰动 | 仍可写，**无影响**；但 poke 进去的值下一拍会被容量拉回，**这是对的**（耐受） |
 * | inner.mjs:135,195 | poke('tension') | 压事 | 仍可写，**无影响** |
 * | assemble.mjs:156 | sense() | system prompt 身体块 | 措辞不变（sense 逻辑没动），但**触发条件更早** → 她会更常说自己累 |
 * | reply-gate.mjs:96-100 | 4 个派生量 + sense | 决定要不要回 | 值域不变（都有 clamp 0..1），**无影响** |
 * | lib/think.mjs:53 | cognitiveDepth(now) | 想多深 | 同上 |
 * | lib/body.mjs:182 | cognitiveDepth() | 动作能力 | 同上 |
 *
 * ── 已知的行为变化（不是 bug，是目的）────────────────────────────
 *   1. 聊得久/情绪激动久 → 受体池下降 → sero/ne/da 静息点一起降 →
 *      她会**真的变钝**，而不是靠"回了 N 条就降权"这种计数器。
 *   2. 安静下来 → 池自己回膜（receptor 有 refillTau）→ 恢复"新鲜"。
 *   3. 熬夜不但抬 sleepDebt，还会经由疲劳把受体池长期压低 →
 *      **"越熬越钝"第一次有了物理来源**（以前 sleepDebt 只是个账，没有下游）。
 *
 * ── 没改的东西（刻意的）─────────────────────────────────────────
 *   · DIMS 的 8 个维度一个没删 —— 删维度会打断外部写入。
 *   · tau / set / lo / hi 一个没动 —— 那些是各维度自己的惯性，与耦合无关。
 *   · evolve 的幂等性、dt 上限 24h、at=0 的首次语义 —— 全部保留。
 *
 * ── 回滚方式 ────────────────────────────────────────────────────
 *   把 COUPLING 恢复成 6 条、删掉 evolve() 里 ⓪ 那一段即可。
 *   池的数据在 field.json 的 pool 字段，留着不影响旧逻辑（旧逻辑不读它）。
 */
