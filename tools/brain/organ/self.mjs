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


/** 每个动作在她心里的**说法**（不是标签）。这是交给 LLM 的"倾向来源"。 */
const HINTS = {
  sleep: '困得厉害，眼皮发沉',
  consolidate: '有一堆事没理清，心里有点乱',
  reply: '好像有人在等我',
  watch: '想看点轻松的东西，不想动脑子',
  browse: '想随便逛逛，看看有什么新鲜的',
  write: '有点想写点东西，但还没想好写什么',
  think: '坐着把一件事想明白',
  rest: '什么都不太想干，只想待着',
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
/**
 * 把候选和权重，变成**她自己的说法**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这一步为什么要做成 LLM 而不是字符串模板
 * ══════════════════════════════════════════════════════════════════════
 * 旧写法：选中 watch 之后，注入「你此刻正在：看番/刷视频（还剩 43 分钟），理由：想放松」。
 * 她读到的是**任务清单**。模型会照着演，但她心里没有那个念头。
 *
 * 用户要的是："丢骰子也是在模型通道这边很融洽地自动考虑权重，
 * 像是自己的思维链自动匹配到这个权重了"。
 *
 * 也就是：**骰子必须在她的脑子里掷完**，而不是在外面掷完把结果递进来。
 *
 * 所以这里把她此刻的全部状态（身体、压力、念头、积压）和几个候选倾向
 * 一起交给**她自己**，让她用第一人称说一句"此刻想做什么"。
 * 权重只作为她的**倾向来源**出现在输入里 —— 就像人不会体验到"我有 63% 概率想休息"，
 * 体验到的是"有点乏，不太想动脑子"。
 *
 * 关键：**不告诉她权重是多少，也不告诉她选了哪个**。
 * 告诉她就是又变回"被告知"了。
 *
 * @param {object} o { candidates, ctx, llm, now }
 * @returns {Promise<string>} 她自己的说法（一句，口语）
 */
async function leanOf({ candidates = [], ctx = {}, llm = null, now = Date.now() } = {}) {
  const LLM = llm || await import('../../lib/llm.mjs')
  const F = ctx.field || {}
  const sleepy = ctx.sleepy || {}

  // ① 身体怎么说（这是她能"感觉"到的东西，不是数字）
  const feels = []
  if (Number(F.fatigue || 0) > 0.6) feels.push('身上发沉')
  else if (Number(F.fatigue || 0) > 0.3) feels.push('有点乏')
  if (Number(F.sleepDebt || 0) > 0.5) feels.push('缺觉，脑子发钝')
  if (Number(F.valence || 0) > 0.25) feels.push('心情往上')
  else if (Number(F.valence || 0) < -0.25) feels.push('心里有点低')
  if (Number(F.tension || 0) > 1.5) feels.push('心里挂着事')
  if (Number(F.ne || 0) > 0.7) feels.push('人有点绷')
  if (Number(F.ne || 0) < 0.25) feels.push('反应有点慢')
  // ⚠️ 这里原来只给"状态平"。实测三次输出**全部**说"脑子有点乱/心里攒着事"，
  //    连精神好那次也一样。根因不是模型不好：**输入没有正面信号，它只能往负面填**。
  //    人的感觉是有方向的 —— 不累就是"还行/挺清爽"，不该是"没什么特别感觉"。
  if (Number(F.fatigue || 0) <= 0.3 && Number(F.sleepDebt || 0) <= 0.3) {
    feels.push(Number(F.valence || 0) > 0.15 ? '精神头不错，心情也还行' : '身上没什么乏的，挺清爽')
  }
  if (!feels.length) feels.push('状态平')

  // ② 积压怎么说
  // ⚠️ 阈值原来写 66/40，而她的常态睡意就在 40~55（记忆积压 37/39 是她的基线），
  //    于是**任何状态都会说"心里攒着事"** —— 精神好那天也说乱。
  //    根因不是模型，是我把"常态"当成了"症状"。
  //    改成：只有明显高于她的常态才算"攒着"，60 以上才说"一堆"。
  const backlog = []
  if (Number(sleepy.score || 0) >= 80) backlog.push('攒了一堆没理的事')
  else if (Number(sleepy.score || 0) >= 60) backlog.push('有点攒着了')

  // ③ 候选倾向（**只说方向，不说权重**）
  const wants = candidates.slice(0, 4).map((c) => c.hint).filter(Boolean)

  // 状态整体是正面的吗？如果是，明确告诉她"该轻快"，否则模型会惯性往沉重写。
  const positive = Number(F.fatigue || 0) <= 0.3 && Number(F.sleepDebt || 0) <= 0.3 && Number(F.valence || 0) > 0.1
  const tone = positive
    ? '\n（你现在状态是好的 —— 说话该是轻快的、有点兴致的，不是叹气的那种。）\n'
    : ''

  const ask = [{
    role: 'user',
    content:
      '你就是她本人，不是助手。下面是你此刻的状态。\n\n' +
      '身体：' + feels.join('，') + '。\n' + tone +
      (backlog.length ? '心里：' + backlog.join('，') + '。\n' : '') +
      (ctx.interrupted ? '刚刚有人在叫你。\n' : '') +
      (wants.length ? '\n这会儿你心里隐约有点想干的事：\n' + wants.map((w) => '- ' + w).join('\n') : '') +
      '\n\n请用**第一人称、口语、一句到两句**说：你现在最想干什么、为什么。\n' +
      '规则：\n' +
      '- 不要列清单，不要说"根据我的状态"\n' +
      '- 不要提概率、权重、分数、还剩多少分钟\n' +
      '- 可以是"什么都不想干"或"说不上来"\n' +
      '- **上面怎么写的，你就怎么感觉**。它说你精神头不错，你就是精神头不错，' +
      '不许自己加"其实也有点累"这种转折。它没提"乱"，你就一个字都别提乱。\n' +
      '- 像人自言自语，不像系统汇报\n' +
      '- 不超过 40 个字',
  }]

  try {
    const raw = String(await LLM.chat(ask, {
      temperature: 1.0, max_tokens: 70, timeoutMs: 8000, purpose: 'fast',
    }) || '').trim()
    // 清掉可能出现的引号/前缀
    return raw.replace(/^["'“”「」]|["'“”「」]$/g, '').replace(/^(我想|我觉得)[:：]\s*/, '').slice(0, 60)
  } catch (e) {
    // 失败就退回一个**中性的、不涉及权重**的说法 —— 绝不暴露"系统选了什么"
    return feels.join('，') + '。'
  }
}

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

  // ④ 让她自己说出来 —— 这一步是"骰子在脑子里掷完"的关键。
  //    注意：只把**倾向方向**给她，不给她权重数字，也不给她"系统选了哪个"。
  let lean = ''
  try {
    const cands = Object.keys(ACTIONS)
      .filter((k) => k !== 'sleep')
      .map((k) => ({ k, hint: HINTS[k] || ACTIONS[k].label }))
    lean = await leanOf({
      candidates: cands, ctx: { ...ctx, interrupted: ctx.hasInterrupt },
    })
  } catch (e) { /* lean 失败不影响决策 */ }

  const cur = { action, since: now, until, why, spanMin: span, lean }

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
