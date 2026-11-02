// cell/neuron —— 一个神经元：突触前（release）+ 突触后（receptor）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么把突触前后拆成两个文件，再在这一层合起来
// ══════════════════════════════════════════════════════════════════════
// 因为它们坏的方向不一样，而且**可以独立坏**：
//   · 只坏突触前（池子空）→ 放不出递质 → 表现为"不想说"
//   · 只坏突触后（受体少）→ 递质照放但没反应 → 表现为"说了也没用"
//   · 两个都坏 → 长期透支
// 真人的"累"和"麻"是两件事：累是放不出，麻是接不住。
// 如果一开始就把它们合成一个"能量值"，这个区别就永远丢了 —— 而它恰恰是诊断的关键。
//
// ══════════════════════════════════════════════════════════════════════
// 一条神经"通路"= 一个功能
// ══════════════════════════════════════════════════════════════════════
// 她身上需要几条独立的通路，每条有自己的突触和受体，因为它们不应该互相顶替：
//
//   social    社交回应：被叫到、被搭话时"接住"的能力
//   reward    奖赏：做成事、被夸时的正向推动
//   stress    应激：压力负荷
//   explore   探索欲：她自己想去看/去学/去折腾
//   attach    依恋：对特定的人（老爸）的专项反应，不跟社交共用
//
// attach 必须单列，理由很实在：**对老爸的反应不该被"跟别人聊多了"磨掉**。
// 如果共用 social 通路，她在群里回复几十条之后，对老爸的那句也会变钝 —— 那是错的。
// 现实里也是分开的：人可以社交疲劳，但看到特定的人还是会心里一动。
//
// ══════════════════════════════════════════════════════════════════════
// 关键：**通路不存"值"，只处理刺激**
// ══════════════════════════════════════════════════════════════════════
// 神经元不保存"我现在有多累"。它只是"收到输入 → 按当前可塑性输出"。
// 所以细胞层是无状态的函数：给 (通路状态, 刺激, dt) → (新状态, 输出信号)。
// "她累不累"这种问题是**器官层**从这些输出里读出来的，不是细胞自己知道自己累。

import * as syn from '../micro/synapse.mjs'
import * as rec from '../micro/receptor.mjs'
import { readJson, mutateJson } from '../json.mjs'
import { neuronPath } from '../paths.mjs'
import * as fieldMod from '../field.mjs'

/**
 * 她有哪几条通路，以及每条用多少"递质预算"。
 *
 * weight 决定这条通路的池子有多大（越大越耐用）。
 * attach 的池子故意做得最小 —— 稀缺才会珍惜，也才会"见到就反应大"。
 */
export const PATHWAYS = {
  // refillTau 是**可释放囊泡池**的补充时间常数，不是受体的回收时间。
  //
  // ⚠️ 2026-11-02 重标定：原来 30~120 秒，那是"受体回收/蛋白合成"的量级，
  //   用在突触囊泡池上会把短时程抑制做成"说十句话就哑掉"。
  //   真实 RRP 是 1~10 秒。这里保留各通路之间的**相对快慢**（依恋最快、
  //   应激最慢 —— 应激反应一旦起来，恢复本来就慢），但整体压到秒级。
  //   （相对关系是我的**推断**：依恋/社交需要快速响应，应激需要持续。
  //    绝对数值按 paired-pulse 的经典范围标定。）
  social:  { label: '社交回应', ligand: 0.8, refillTau: 6_000,  kInternalize: 0.055, pool: 1.0 },
  reward:  { label: '奖赏',     ligand: 1.0, refillTau: 10_000, kInternalize: 0.040, pool: 1.0 },
  stress:  { label: '应激',     ligand: 0.9, refillTau: 14_000, kInternalize: 0.030, pool: 1.0 },
  explore: { label: '探索',     ligand: 0.7, refillTau: 8_000,  kInternalize: 0.045, pool: 1.0 },
  attach:  { label: '依恋',     ligand: 1.2, refillTau: 4_000,  kInternalize: 0.075, pool: 0.7 },
}

/** 空状态：所有通路池满、受体新鲜。 */
export function empty() {
  const paths = {}
  for (const k of Object.keys(PATHWAYS)) {
    paths[k] = { syn: syn.empty(), rec: rec.empty(), at: 0 }
  }
  return { paths, at: 0 }
}

/**
 * 让所有通路随真实时间恢复。**不产生刺激。**
 *
 * 这一步是"她安静下来的那段时间"。非常重要：
 * 没有它，所有通路只会单向变钝，最后什么都感觉不到。
 * 而且它必须按 dt 算 —— 机器睡一夜，回来就该是"歇了一夜"的状态。
 */
export function rest(st, dtMs) {
  const cur = st || empty()
  const paths = {}
  for (const [k, cfg] of Object.entries(PATHWAYS)) {
    const p = cur.paths?.[k] || { syn: syn.empty(), rec: rec.empty(), at: 0 }
    // 恢复时配体已经清掉了（递质被重摄取），所以这里按 0 递质演化
    const s2 = syn.rest(p.syn, dtMs, { refillTau: cfg.refillTau })
    const r2 = rec.evolveLong(p.rec, 0, dtMs, { kInternalize: cfg.kInternalize }).r
    paths[k] = { syn: s2, rec: r2, at: Number(p.at || 0) + Math.max(0, dtMs) }
  }
  return { paths, at: Number(cur.at || 0) + Math.max(0, dtMs) }
}

/**
 * 一条通路被刺激一次。**离散事件。**
 *
 * 调用前必须先用 rest() 推进到"现在"，否则时间没走、恢复不会发生。
 *
 * @param {object} st
 * @param {string} pathway PATHWAYS 的键
 * @param {number} strength 刺激强度（0..2）。他叫你一句 = 0.6；他表白 = 2。
 * @returns {{st:object, signal:number, released:number, facilitated:boolean, depressed:boolean, why:string}}
 */
export function stimulate(st, pathway, strength = 1) {
  const cur = st || empty()
  const cfg = PATHWAYS[pathway]
  if (!cfg) return { st: cur, signal: 0, released: 0, why: 'unknown-pathway' }
  const p = cur.paths[pathway] || { syn: syn.empty(), rec: rec.empty(), at: 0 }

  // ① 突触前：放出多少递质（受池子与残余钙调制）
  const fired = syn.fire(p.syn, strength, { refillTau: cfg.refillTau })

  // ② 突触后：**用本次释放量**算信号（不是累积 ligand），
  //    并且必须给一个**非零 dt**，否则内化永远是 0、受体永远不会钝 ——
  //    这正是第一版跑出来 capacity 恒等于 1.00 的原因。
  //
  //    ⚠️ 2026-11-02 修：dt 原来是写死的 1000ms（1 秒），**量纲低了 5~10 倍**。
  //    "一次社交刺激"不是"听到一个音节"，是**一次完整的交互窗口**：
  //    读消息 + 想 + 打字，约 5~10 秒。
  //
  //    实测（改前）：social 刺激 40 次后 capacity = **0.987** —— 几乎没内化。
  //    也就是说"耐受"在代码里等于不存在；只有跑满几百次才会动。
  //    这不是参数没调好，是**单位错了**：把"一次交互"当成了"一秒钟"。
  //
  //    改成 8 秒（交互窗口中位值）后：40 轮 → 0.803（"有点钝"），
  //    10 轮 → 0.962（"还新鲜"）—— 这才是"聊久了会钝、歇一会就好"。
  //
  //    用 cfg.stimMs 可以按通路覆盖（依恋窗口更长、探索更短）。
  const stimMs = Number(cfg.stimMs ?? 8000)
  const drive = fired.released * cfg.ligand
  const sig = rec.evolve(p.rec, drive, stimMs, { kInternalize: cfg.kInternalize })

  const paths = { ...cur.paths, [pathway]: { syn: fired.s, rec: sig.r, at: p.at } }

  // ③ 解释这一跳为什么强/弱 —— 这是"她为什么这样"的可读来源
  let why = '正常'
  if (fired.depressed && fired.facilitated) why = '又急又空（池子耗了，但钙还堆着）'
  else if (fired.facilitated) why = '越说越上头（残余钙）'
  else if (fired.depressed) why = '有点钝了（可释放池见底）'
  const tone = Number(sig.r.out || 1)
  if (tone < 0.5 && !fired.depressed) why = '接不住了（受体已内化）'

  return {
    st: { paths, at: cur.at },
    signal: Number(sig.signal.toFixed(3)),
    released: fired.released,
    facilitated: fired.facilitated,
    depressed: fired.depressed,
    gapSec: fired.gapSec,
    why,
  }
}

/**
 * 读一条通路现在的样子（不产生刺激）。
 *
 * 区分三件事，这是诊断的基础：
 *   driven   突触前还有多少存货（>=0.7 能正常说；<0.3 说不出来）
 *   capacity 突触后还有多少受体（>=0.85 敏感；<0.5 麻）
 *   ligand   现在还有多少递质没清掉（>0.5 说明"余味还在"）
 */
export function read(st, pathway) {
  const cfg = PATHWAYS[pathway]
  const p = (st || empty()).paths?.[pathway]
  if (!cfg || !p) return { driven: 1, capacity: 1, ligand: 0, tone: '新鲜' }
  const driven = Number(Number(p.syn.pool || 0).toFixed(3))
  const capacity = Number(Number(p.rec.out || 0).toFixed(3))
  const ligand = Number(Number(p.syn.ligand || 0).toFixed(3))
  const tone = capacity >= 0.85 ? '新鲜' : capacity >= 0.6 ? '有点钝' : capacity >= 0.35 ? '明显钝了' : '接不住'
  return { driven, capacity, ligand, tone }
}

/**
 * 现在的"输出能力"：突触前存货 × 突触后可接住程度。
 *
 * 这一个数是**唯一**应该被上层拿去做决策的量 —— 它同时包含了
 * "放不放得出"（driven）和"收不收得到"（capacity）。
 * 分开看会误判：池子满但受体麻了，实际是说不动的。
 */
export function output(st, pathway) {
  const r = read(st, pathway)
  return Number((r.driven * r.capacity).toFixed(3))
}

/** 全部通路的概览（面板/体检用）。 */
export function survey(st) {
  const out = {}
  for (const k of Object.keys(PATHWAYS)) out[k] = read(st, k)
  return out
}

/* ══════════════════════════════════════════════════════════════════════
 * 持久化 + 身体接口（2026-11-02 补）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 为什么必须补：这个文件原来**完全无状态** —— 没有 persist、没有 dataPath，
 * 所有池子只活在内存里。这意味着：
 *   · 进程一重启，五条通路全部回到"新鲜"
 *   · 心跳每拍 `neuron....` 也没有任何东西可以推进
 *   · 于是"社交聊多了会钝"这件事在真实运行中**从未发生过**
 * （只有测试里跑过，因为测试是从 empty() 一路算下来的）
 *
 * 这和 field.mjs 那次 `evolve()` 不 persist 是同一类问题：
 * **算得对，但存不住 = 等于没算**。
 */

/** 读盘（坏文件/首次运行 → 空状态，不抛）。 */
export function load() {
  const raw = readJson(neuronPath(), null)
  if (!raw || typeof raw !== 'object' || !raw.paths) return empty()
  const st = empty()
  for (const k of Object.keys(PATHWAYS)) {
    const p = raw.paths[k]
    if (!p) continue
    st.paths[k] = {
      syn: { ...syn.empty(), ...(p.syn || {}) },
      rec: { ...rec.empty(), ...(p.rec || {}) },
      at: Number(p.at || 0),
    }
  }
  st.at = Number(raw.at || 0)
  return st
}

/** 落盘（原子写；失败不影响业务）。 */
export function save(st) {
  try {
    mutateJson(neuronPath(), empty(), () => ({
      at: Number(st?.at || 0),
      paths: Object.fromEntries(
        Object.entries(st?.paths || {}).map(([k, p]) => [k, {
          syn: p.syn || null,
          rec: p.rec || null,
          at: Number(p?.at || 0),
        }])
      ),
    }))
  } catch { /* 存不进去不影响她 */ }
  return st
}

/**
 * 身体推进一拍：**所有通路按真实时间恢复**。
 *
 * 这是"她安静下来的那段时间"。必须由心跳每拍调用 —— 不调用就等于
 * 她的突触池永远不补，聊一次就永久钝 1%。
 *
 * 幂等：dt<=0 时什么都不做（rest 内部已处理）。
 *
 * @returns {{advanced:number, at:number}} advanced = 实际推进的毫秒数
 */
export function tick(now = Date.now()) {
  const st = load()
  const last = Number(st.at || 0)
  if (!last) {                       // 首次：只记时间，不演化（没有"上一次"可比）
    st.at = now
    save(st)
    return { advanced: 0, at: now }
  }
  let dt = now - last
  if (dt <= 0) return { advanced: 0, at: last }
  // 上限 24h：机器睡三天回来不该一次性补三天（和 field 同一条规矩）
  const capped = Math.min(dt, 24 * 3600_000)
  const next = rest(st, capped)
  next.at = now
  save(next)
  return { advanced: capped, at: now }
}

/**
 * 被一件事刺激到。这是"她真的做了某个动作"时调用的入口。
 *
 * @param {string} pathway social|reward|stress|explore|attach
 * @param {number} [strength=1]
 * @returns {{ok:boolean, output?:number, why?:string}}
 */
export function act(pathway, strength = 1, now = Date.now()) {
  // ── 跨器官：stress 要**两条**时间常数（2026-11-02 补）────────────────
  //
  // 这个文件里的池子都是**突触级**（秒~分钟）。但"被挫折了"这件事
  // 有两个完全不同的时间尺度：
  //   ① 突触池耗竭（14 秒回满）→ "连续被批评时反应变钝"
  //   ② 情绪余味（小时级）      → "被骂一句，一上午都闷"
  //
  // 实测：只做 ① 的话，5 次承诺失败后 stress=0，但**歇 15 分钟就回到 0.99** ——
  // 那不叫"有压力"，那叫"根本没有压力"。
  //
  // 所以 stress 还要往 HPA 轴滴一点：cortisol 的 tau 是 10 小时，那才是余味。
  // 用 setDim 而不是 poke：poke 会被下一拍的弛豫吃掉大半，
  // setDim 是直接设定，能撑住。
  // 幅度 0.06 × strength：一次普通挫折把 cortisol 抬 0.05 左右
  // （基线 0.15 → 0.20，临床上是"轻微升高"的量级，不是"崩溃"）。
  if (pathway === 'stress') {
    try {
      // ⚠ 必须是**同步**的。第一版写成 `import('../field.mjs').then(...)`，
      //   实测：`act()` 返回后立刻读 cortisol 还是旧值，**300ms 后才涨**。
      //   实际运行里没问题（下一拍心跳就读到了），但这是**隐式时序依赖** ——
      //   任何"调用 act 之后马上检查状态"的代码（测试、面板、未来的调用方）
      //   都会读到错的数。而且一旦某处依赖这个顺序，就是又一个"有值不报错"。
      //
      //   改成静态 import：field.mjs 不 import neuron（它只需要 receptor），
      //   所以这里不会成环。
      const cur = Number(fieldMod.snapshot().dims.cortisol || 0.15)
      fieldMod.setDim('cortisol', Math.min(1, cur + 0.06 * Number(strength || 1)), { why: 'neuron:stress', now })
    } catch { /* 推不进去不影响 stress 本身 */ }
  }

  const st = load()
  // 先把它推进到此刻，否则池子还是上一次存的样子
  const advanced = (() => {
    const d = now - Number(st.at || 0)
    if (!(d > 0)) return st
    return rest(st, Math.min(d, 24 * 3600_000))
  })()
  const r = stimulate(advanced, pathway, strength)
  r.st.at = now
  save(r.st)
  return { ok: true, output: Number(output(r.st, pathway)), released: r.released, why: r.why }
}

/**
 * 给决策层（self.decide）看的**身体读数**。
 *
 * 这是这次接线的核心：以前 `desire()` 只看 field 的几个标量，
 * 五条通路的独立状态**完全没参与**。
 *
 * 返回的是"这条通路现在还能不能支撑这件事"：
 *   1.00 = 完全有劲，0.5 = 明显钝了，0.2 = 几乎做不动
 *
 * 为什么用 `output()`（driven × capacity）而不是单个 capacity：
 * 池子空（刚说完一大段）和受体钝（聊了一整天）是两种不同的"做不动"，
 * 但对她此刻"还想不想做/做不做得出"是同一件事。
 */
export function readiness(now = Date.now()) {
  const st = load()
  const d = now - Number(st.at || 0)
  const s = d > 0 ? rest(st, Math.min(d, 24 * 3600_000)) : st
  const out = {}
  for (const k of Object.keys(PATHWAYS)) out[k] = Number(output(s, k).toFixed(3))
  return out
}

/** 给面板/体检：五条通路的完整状态。 */
export function stateNow(now = Date.now()) {
  const st = load()
  const d = now - Number(st.at || 0)
  const s = d > 0 ? rest(st, Math.min(d, 24 * 3600_000)) : st
  return survey(s)
}
