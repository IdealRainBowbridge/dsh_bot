// organ/self —— 唯一的行动中枢：一个灵魂操纵一个身体
//
// ══════════════════════════════════════════════════════════════════════
// 它要解决的问题：现在有一堆通道各自操纵她
// ══════════════════════════════════════════════════════════════════════
// 收拢前，她身上有 8 个独立定时器，每个都在**自己判断该不该动**：
//
//   60s  tryProactive   自己掷骰子（chance 0.12）决定要不要主动说话
//   60s  tryGroupChat   自己掷骰子（chance 0.10）决定要不要插嘴
//   60s  runDuePromises 自己看承诺到点没有
//   30s  checkNapcat    自己探活
//   30m  tryQzone       自己决定要不要发说说
//   20s  pollTasks      自己取任务
//   10m  warmQuoteIndex 自己预热
//   +    宿主 scheduler 60s tick（另一套判断）
//
// 这不是"一个人"，这是十个部门各自行动。表现上就是：
//   · 她在看番的时候被拉去搭话（两个通道并行，互不知道）
//   · 语气前后不一致（同一个身体，两个脑子在同一分钟里各说一句）
//   · 优先级混乱（该睡觉了还在发说说）
//
// ══════════════════════════════════════════════════════════════════════
// 正确的形状：一个决策点，一个时相
// ══════════════════════════════════════════════════════════════════════
// 活人的每一个瞬间只**在做一件事**。不是八件事并行，是：
//
//   此刻我在干什么 → 够不够打断 → 打断之后干什么 → 干完回到哪
//
// 所以这里只有一个函数：`decide()`。它把身体的所有状态摊在一起，
// 回答一个问题：**接下来这一段时间，做什么。**
//
// 那些"通道"降级成 **ACTIONS（能力）**：不再是发起者，只是候选。
// 它们不再有自己的定时器，也不会自己决定要不要跑 ——
// 只有中枢选中它，它才动。
//
// ══════════════════════════════════════════════════════════════════════
// 决策怎么做的（不是打分取最大）
// ══════════════════════════════════════════════════════════════════════
// 打分取最大是静态的、冰冷的：同样输入永远同样结果，而且会"平均地做每件事"。
//
// 人的决策是**串行的否决式**：
//   ① 先看**硬状态**（身体能不能做事）—— 累了就是累了，不是"权重低一点"
//   ② 再看**打扰**（有没有人在等我、有没有急事）—— 急事能压过一切
//   ③ 最后才在**想做**里挑一件 —— 而且挑完就专心做，不再看别的
//
// 所以 decide() 是三层：
//   身体健康 → 现在就睡（不再考虑其他）
//   有打断   → 先处理打断（但他进不来就先不管，见 thalamus）
//   否则     → 从"这一刻想做的事"里挑一件，定下来做多久
//
// 关键：**挑完写进 focus，下一轮不重新挑**。这就是"专心"的代码形态 ——
// 不是靠意志力，是靠**决策窗口**（ttl 内不重算）。
import { readJson, mutateJson } from '../json.mjs'
import { selfStatePath as selfPath } from '../paths.mjs'
import * as field from '../field.mjs'
import * as night from './night.mjs'
import * as thalamus from './thalamus.mjs'
import * as inner from '../inner.mjs'
import * as hpa from './hpa.mjs'

const MIN = 60_000
const HOUR = 3_600_000

/**
 * 她能做的事 —— 这些原来都是"通道"，现在是**能力**。
 *
 * 每一项声明：需要多少精力、大概占多久、以及"她现在有多想做"。
 * 注意 `want` 不是一个常数：它随身体状态变（这就是"想不想"的来源）。
 */
export const ACTIONS = {
  // ── 生存 / 恢复类（优先级最高，但不是"想做"，是"必须"）──
  sleep: {
    label: '睡觉',
    minMin: 90, maxMin: 540,
    need: 0,                   // 不需要精力（本来就是没精力才睡）
    kind: 'restore',
  },
  // ── 维持类：不做会积压，但可以推后 ──
  consolidate: { label: '整理记忆', minMin: 8, maxMin: 25, need: 0.35, kind: 'maintain' },
  // ── 社交类：有人等着 ──
  reply: { label: '回话', minMin: 1, maxMin: 6, need: 0.2, kind: 'social' },
  // ── 自己的事：她想去做的 ──
  watch: { label: '看番/刷视频', minMin: 20, maxMin: 120, need: 0.5, kind: 'leisure' },
  browse: { label: '上网逛', minMin: 10, maxMin: 60, need: 0.45, kind: 'leisure' },
  write: { label: '写点东西', minMin: 15, maxMin: 60, need: 0.6, kind: 'create' },
  think: { label: '想事情', minMin: 5, maxMin: 30, need: 0.3, kind: 'inner' },
  // ── 最轻的：什么都不做 ──
  rest: { label: '歇着', minMin: 10, maxMin: 90, need: 0, kind: 'idle' },
}

const empty = () => ({
  at: 0,
  current: null,     // { action, since, until, why }
  history: [],       // 最近 30 次决定（用来回答"她今天都在干什么"）
  decisions: 0,
})

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.history = Array.isArray(st.history) ? st.history.slice(-30) : []
  return st
}

/**
 * 此刻她有多想做某件事（0..1）。**这是"意愿"的来源，不是概率。**
 *
 * 每一项都不是常数，而是从身体/心里读出来的：
 *   · 看番：清醒度 × (1-疲劳) × 有没有探索欲
 *   · 写东西：脑力（写东西真的要脑力）
 *   · 歇着：疲劳越高越想歇
 *   · 整理：积压越多越想整理（这是"心里挂着事"）
 */
export function desire(action, ctx) {
  const f = ctx.field
  const awake = 1 - 0.6 * f.sleepDebt - 0.5 * f.fatigue
  const brain = ctx.depth
  switch (action) {
    case 'sleep': return ctx.sleepy.score / 100
    case 'consolidate': return Math.min(1, ctx.sleepy.score / 66) * 0.9   // 积压越多越想理
    case 'reply': return ctx.hasInterrupt ? 1 : 0                            // 有人等着才做
    case 'watch': return Math.max(0, awake) * 0.85 + 0.15 * f.da
    case 'browse': return Math.max(0, awake) * 0.7 + 0.2 * ctx.explore
    case 'write': return Math.max(0, brain) * 0.8 + 0.2 * ctx.tension
    case 'think': return Math.max(0, brain) * 0.5 + 0.35 * ctx.tension
    // rest 原来写 fatigue*1.2 + debt*0.8 —— 稍累就顶到 1.00，把别的选项全压死，
    // 于是"什么都没干"成了默认。改成和其他项同一个量级：
    // 累到 0.85 时约 0.66，仍高于看番（0.15）但不会到天花板；
    // 只有真的快撑不住（两样都接近 1）才逼近 1。
    case 'rest': return Math.min(1, f.fatigue * 0.55 + f.sleepDebt * 0.55)
    default: return 0
  }
}

/**
 * 唯一的决策点。
 *
 * @param {object} o { now, hasInterrupt, interruptUrgency, backlog }
 * @returns {{action:string, until:number, why:string, kept:boolean}}
 */
export async function decide(o = {}) {
  const now = o.now ?? Date.now()
  const st = hydrate(readJson(selfPath(), null))

  // ① 先看有没有"正在做的事"，没到点就不重新挑 —— 这是"专心"
  if (st.current && Number(st.current.until || 0) > now) {
    // 但**急事可以打断**：他叫得够急，或者该睡了
    const urge = Number(o.interruptUrgency || 0)
    if (urge < 1.4 && st.current.action !== 'sleep') {
      return { ...st.current, kept: true }
    }
  }

  // ② 摊开身体
  let f = { sleepDebt: 0, fatigue: 0, da: 0.5, valence: 0, tension: 0 }
  let depth = 0.5
  try {
    const snap = field.snapshot()
    f = snap.dims
    depth = snap.derived.cognitiveDepth
  } catch { }
  const sleepy = await night.assess(now)
  const ctx = {
    field: f,
    depth,
    sleepy,
    tension: Math.min(1, Number(f.tension || 0) / 2.5),
    explore: Math.min(1, Number(f.da || 0.5)),
    hasInterrupt: !!o.hasInterrupt,
  }

  // ③ 三层否决式决策
  let action = 'rest'
  let why = ''

  // 层一：该睡就睡（代谢账攒够了）
  if (sleepy.shouldSleep) {
    action = 'sleep'
    why = '攒够了：' + sleepy.why + '（' + sleepy.score + '/100）'
  } else if (ctx.hasInterrupt) {
    // 层二：有人等着
    action = 'reply'
    why = '有人在等'
  } else {
    // 层三：在"想做"里挑一件 —— 只在这时候才看意愿
    const cands = Object.keys(ACTIONS)
      .filter((k) => k !== 'sleep' && k !== 'reply')
      .filter((k) => ACTIONS[k].need <= depth + 0.15)   // 精力不够就不在候选里（不是降权）
      .map((k) => ({ k, d: desire(k, ctx) }))
      .filter((x) => x.d > 0.08)
      .sort((a, b) => b.d - a.d)
    if (cands.length) {
      action = cands[0].k
      why = '想做：' + ACTIONS[action].label + '（意愿 ' + cands[0].d.toFixed(2) + '）'
    } else {
      action = 'rest'
      why = '什么都不太想做'
    }
  }

  // ④ 定下来做多久（不是固定时长，是按这件事的区间 + 当前状态缩）
  const spec = ACTIONS[action] || ACTIONS.rest
  const span = Math.round(spec.minMin + (spec.maxMin - spec.minMin) * Math.max(0, Math.min(1, depth)))
  const until = now + span * MIN

  const cur = { action, since: now, until, why, spanMin: span }

  // ⑤ 埋一个想法：她换了事做，本身就是"心里转着的事"之一
  try {
    if (action !== 'rest') inner.think('现在想' + spec.label, { kind: 'meta', about: 'self', now })
  } catch { }

  st.current = cur
  st.at = now
  st.decisions = Number(st.decisions || 0) + 1
  st.history = [...st.history, { at: now, action, why, spanMin: span }].slice(-30)
  save(st)
  return { ...cur, kept: false }
}

/** 她现在在做什么（给别处读）。 */
export function current(now = Date.now()) {
  const st = hydrate(readJson(selfPath(), null))
  const c = st.current
  if (!c) return null
  const remainMin = Math.max(0, Math.round((Number(c.until || 0) - now) / MIN))
  return { ...c, remainMin, expired: remainMin <= 0 }
}

/** 打断她：清掉当前，让下一轮重新决策。 */
export function interrupt(now = Date.now()) {
  const st = hydrate(readJson(selfPath(), null))
  st.current = null
  st.at = now
  save(st)
  return st
}

/** 一句能读的自我描述（进提示词）。 */
export function line(now = Date.now()) {
  const c = current(now)
  if (!c) return ''
  const spec = ACTIONS[c.action] || ACTIONS.rest
  if (c.action === 'rest') return '你现在没在做什么特别的事，就是歇着。'
  return '你此刻正在：' + spec.label + (c.remainMin > 0 ? '（还有大约 ' + c.remainMin + ' 分钟）' : '') + '。'
}

/** 全貌。 */
export function snapshot(now = Date.now()) {
  const st = hydrate(readJson(selfPath(), null))
  const c = current(now)
  return {
    current: c,
    line: line(now),
    decisions: st.decisions,
    today: st.history.filter((x) => now - Number(x.at || 0) < 24 * HOUR).slice(-10),
  }
}

function save(st) {
  try {
    mutateJson(selfPath(), empty(), () => ({
      at: st.at, current: st.current, history: (st.history || []).slice(-30), decisions: st.decisions,
    }))
  } catch { }
  return st
}
