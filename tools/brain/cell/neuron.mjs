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

/**
 * 她有哪几条通路，以及每条用多少"递质预算"。
 *
 * weight 决定这条通路的池子有多大（越大越耐用）。
 * attach 的池子故意做得最小 —— 稀缺才会珍惜，也才会"见到就反应大"。
 */
export const PATHWAYS = {
  social:  { label: '社交回应', ligand: 0.8, refillTau: 45_000,  kInternalize: 0.055, pool: 1.0 },
  reward:  { label: '奖赏',     ligand: 1.0, refillTau: 90_000,  kInternalize: 0.040, pool: 1.0 },
  stress:  { label: '应激',     ligand: 0.9, refillTau: 120_000, kInternalize: 0.030, pool: 1.0 },
  explore: { label: '探索',     ligand: 0.7, refillTau: 60_000,  kInternalize: 0.045, pool: 1.0 },
  attach:  { label: '依恋',     ligand: 1.2, refillTau: 30_000,  kInternalize: 0.075, pool: 0.7 },
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
  //    dt 用 1000ms 是"这一次刺激本身的持续时长"，不是"距上次多久"（后者由 rest 负责）。
  const drive = fired.released * cfg.ligand
  const sig = rec.evolve(p.rec, drive, 1000, { kInternalize: cfg.kInternalize })

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
