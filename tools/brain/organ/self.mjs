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
import * as neuron from '../cell/neuron.mjs'
import { swallow } from '../../lib/swallow.mjs'

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
  // ── 五条通路的"此刻还能不能做"（2026-11-02 接上）───────────────
  //
  // 以前这里只看 field 的几个标量：watch 用 `f.da`、browse 用 `ctx.explore`
  // （而 ctx.explore 其实就是 `f.da`）—— 两个不同的动作读的是**同一个数**。
  // 而 cell/neuron 里明明有五条独立通路（social/reward/stress/explore/attach），
  // 各有自己的突触池和受体池，却**一条都没参与决策**。
  //
  // 现在：每条通路给出 readiness（0..1，见 neuron.readiness）。
  //   · reward  → 看番/刷视频       「还有没有兴致」
  //   · explore → 上网逛            「还想不想看新东西」
  //   · social  → 回话 / 想说话     「还说不说得动」
  //   · stress  → 压低所有休闲意愿   「心里绷着就玩不进去」
  //   · attach  → 主人来时的加成     「想不想黏他」
  //
  // 缺省 1：读不到神经状态时**不惩罚**任何动作（宁可当她还有劲，
  // 也不要因为一个 IO 失败把她锁在"什么都不想做"）。
  // tension 兜底：desire() 是导出的，外部调用时 ctx 可能没有这个字段。
  // NaN 一旦进了返回值，`cands.sort((a,b)=>b.d-a.d)` 会把整张候选表排成随机顺序，
  // 而 `filter(x => x.d > 0.08)` 对 NaN 恒 false → **所有动作都被过滤掉** →
  // 永远落到 rest。这是"有值不报错"的典型：不崩，但她会一直什么都不想做。
  const tension = Number.isFinite(ctx.tension) ? Number(ctx.tension) : 0
  const nv = ctx.neuro || {}
  const rw = Number.isFinite(nv.reward) ? nv.reward : 1
  const ex = Number.isFinite(nv.explore) ? nv.explore : 1
  const so = Number.isFinite(nv.social) ? nv.social : 1
  const st = Number.isFinite(nv.stress) ? nv.stress : 1
  const at = Number.isFinite(nv.attach) ? nv.attach : 1
  // 应激高 = 玩不进去。
  //
  // ⚠ 第一版写成 `1.15 - max(0, st-0.5)*0.6` 再 clamp 到 1.15 ——
  //   stress=0.5（正常）时 calm=**1.15**，等于"正常状态下把休闲意愿放大 15%"，
  //   而 stress=0.5 本来就是静息水平，不该有任何加成。
  //   实测：stress 从 0.5 降到 0.8 时 watch 从 0.80 掉到 0.68，
  //   看起来"有效"，其实是先白送 15% 再扣回来。
  //   正确形状：**静息时系数正好 1.00**，只在高于静息时才往下压。
  //   静息阈值取 0.55（PATHWAYS.stress 的池满时输出 ≈ 1，但常态驱动下大约在 0.5~0.6）。
  const STRESS_REST = 0.55
  const calm = Math.max(0.35, Math.min(1, 1 - Math.max(0, st - STRESS_REST) * 1.1))

  switch (action) {
    case 'sleep': return ctx.sleepy.score / 100
    case 'consolidate': return Math.min(1, ctx.sleepy.score / 66) * 0.9   // 积压越多越想理
    // reply：有人等着时才做（这是门槛），但**说不说得动**由 social 通路决定。
    //
    // 2026-11-02 接上。原来这里写死 `hasInterrupt ? 1 : 0` ——
    // 五条通路里的 social 明明就是"社交回应"，却对"回话"这件事零影响。
    //
    // 两层含义要分开：
    //   ① **有没有人要你回** → hasInterrupt（外部事实）
    //   ② **你还说不说得动** → social（内部状态）
    // 真实的人是：有人在等（①）但他已经聊了一整天，回起来会明显敷衍/简短（②）。
    // 注意 ② 不该让"回话"这个动作消失 —— 有人等着就必须回，
    // 只是回得短、回得慢。所以下限给 0.35（不是 0）。
    case 'reply': return ctx.hasInterrupt ? (0.35 + 0.65 * so) : 0
    // 看番：兴致（reward）× 清醒 × 心里不绷
    case 'watch': return (Math.max(0, awake) * 0.6 + 0.4 * f.da) * (0.45 + 0.55 * rw) * calm
    // 上网逛：探索（explore）单独一条通路，不再借用 da
    case 'browse': return Math.max(0, awake) * 0.55 * (0.45 + 0.55 * ex) * calm + 0.15 * f.da
    case 'write': return Math.max(0, brain) * 0.8 + 0.2 * tension
    case 'think': return Math.max(0, brain) * 0.5 + 0.35 * tension
    // rest 原来写 fatigue*1.2 + debt*0.8 —— 稍累就顶到 1.00，把别的选项全压死，
    // 于是"什么都没干"成了默认。改成和其他项同一个量级：
    // 累到 0.85 时约 0.66，仍高于看番（0.15）但不会到天花板；
    // 只有真的快撑不住（两样都接近 1）才逼近 1。
    // rest：累到做不动时该占上风。
    //
    // ⚠ 原来只看 field.fatigue/sleepDebt，**完全不看神经状态**。
    //   实测：五条通路全掉到 0.3（做什么都没劲）时，
    //   watch=0.494 / rest=0.165 —— 她还是会选看番，然后什么都做不出来。
    //   这是"身体已经没电，但决策层不知道"。
    //
    // 现在：神经整体越疲惫，rest 越高。
    //   用五条的**平均值**代表"整体还有多少劲"（不是最小值：
    //   一条通路钝了不该让她整体躺平，那件事不做换一件就行）。
    case 'rest': {
      const avgNeuro = (rw + ex + so + st + at) / 5
      const flat = Math.max(0, Math.min(1, 1 - avgNeuro))    // 0 = 全新鲜，1 = 全废
      return Math.min(1, f.fatigue * 0.55 + f.sleepDebt * 0.55 + flat * 0.45)
    }
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
async function leanOf({ candidates = [], ctx = {}, picked = '', llm = null, now = Date.now() } = {}) {
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
  //
  // ⚠️ 2026-11-02 修正：原来只给前 4 条候选的 hint，**不含决定选中的那个**。
  //    实测原始状态（06:26 self-state.json）：
  //      action = 'consolidate'，why = '想做：整理记忆（意愿 0.70）'
  //      lean   = '想随便翻翻手机看点轻松的东西，脑子实在转不动了。'
  //    → decide 说"整理记忆"，她自己说"想看轻松的东西"。
  //    然后 body.consolidate 照 action 执行，而【此刻】注入 system 的是 lean。
  //    **结果是她心里想的和身体在做的完全对不上，而且她自己也读得到这个矛盾。**
  //
  //    根因不是模型不听话 —— 是 **leanOf 根本不知道 decide 选了什么**。
  //    它只拿到 candidates 列表，那个列表里连 consolidate 都不在
  //    （decide 调 leanOf 前把 sleep 排除了，但候选是全部 ACTIONS，hint 只取了前 4 条）。
  //
  //    这违反了用户定的那条："丢骰子也是在模型通道这边很融洽地自动考虑权重"。
  //    骰子要在她脑子里掷 —— 那就得把"权重最高的那个方向"交给她，让她自己说出来，
  //    **而不是在外面掷完、只让她猜。**
  //
  //    修法：picked 作为**倾向最强的那一条**放进输入，明确标注"你手上这阵子最偏向这件"。
  //    仍然不提概率/分数/时长；仍然允许她说"不想干这个"（那是她的权利，
  //    也说出了真实心理：明明该干活但就是不想动）。
  const wants = candidates.slice(0, 4).map((c) => c.hint).filter(Boolean)
  const pickedHint = picked ? (HINTS[picked] || (ACTIONS[picked] && ACTIONS[picked].label) || '') : ''
  if (pickedHint && !wants.includes(pickedHint)) wants.unshift(pickedHint)

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
      (pickedHint ? '\n你手上这阵子最偏向的是：' + pickedHint + '\n（这不是命令，是你自己此刻的倾向。你要是不想干它，也照实说。）\n' : '') +
      (wants.length > 1 ? '\n另外心里也隐约有点想干的事：\n' + wants.filter((w) => w !== pickedHint).map((w) => '- ' + w).join('\n') : '') +
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
  //
  // ⚠️ 2026-11-02：**"专心"不能压过"撑不住了"。**
  //
  //    原来的条件只看两件事：他叫得急不急（urge）、当前是不是在睡。
  //    实测（debt=0.95，night 已经给出 shouldSleep:true）：
  //      decide() 仍然返回 current 里的 rest（"想做：歇着，意愿 0.54"），
  //      因为 rest 的 until 还没到期 → kept=true → **该睡也睡不了**。
  //
  //    现实里对一个困到睁不开眼的人说"你刚决定歇着，先专心歇完 40 分钟"，
  //    是荒谬的。专注（focus）是**低优先级状态的续期**，而困到极点是硬状态。
  //    三层否决式的第一层本来就是"硬状态压过一切"——这条没被贯彻到这里。
  //
  //    修法：算出困倦度，超过"撑不住"线时，不再续期当前计划，
  //    让它往下走到层一（该睡就睡）。
  //    注意不能只判 action!=='sleep'（那是"已经在睡"），
  //    真正要的是"**该不该现在改主意去睡**"。
  const prev = st.current
  if (prev && Number(prev.until || 0) > now) {
    const urge = Number(o.interruptUrgency || 0)
    let hardSleepy = false
    try {
      const sp = await night.assess(now)
      // 0.92 与 night.mjs 的硬底一致：那个点上是"生物关机"，不是"有点困"
      hardSleepy = !!sp.shouldSleep && Number(sp?.detail?.debt || 0) >= 0.92
    } catch { /* 取不到就当作不困 */ }

    if (!hardSleepy && urge < 1.4 && prev.action !== 'sleep') {
      return { ...prev, kept: true }
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
  // 五条通路的此刻可用度（2026-11-02 接上）。
  //
  // 读失败 → 全 1（不惩罚）。理由写在 desire() 里：宁可当她有劲，
  // 也不要因为一次 IO 失败把她锁死在"什么都不想做"。
  let neuro = null
  try {
    neuro = neuron.readiness(now)
  } catch (e) { swallow(e, 'self:neuro') }

  const ctx = {
    field: f,
    depth,
    sleepy,
    // tension 归一。注意 `|| 0` 对 NaN 不生效（NaN 是假值所以会走 0，这里是对的），
    // 但 `desire()` 也可能被**外部**直接调用（测试、面板），那时 ctx 里没有 tension
    // → `0.2 * undefined = NaN` → 整个意愿变成 NaN → 排序全乱。
    // 所以 desire() 内部还要兜一道（见那边注释）。
    tension: Math.min(1, Number(f.tension || 0) / 2.5),
    explore: Math.min(1, Number(f.da || 0.5)),
    hasInterrupt: !!o.hasInterrupt,
    neuro,                       // { social, reward, stress, explore, attach } 各 0..1
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
    // why 要能看出"还说不说得动"。她自己读得到这句话，所以措辞是她的口气。
    const soNow = Number.isFinite(ctx.neuro?.social) ? ctx.neuro.social : 1
    why = soNow < 0.5
      ? '有人在等（脑子有点木，回得会短）'
      : '有人在等'
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
    // 只把**真正在这一层参与竞争**的动作交给她 —— 也就是过了 need 过滤的那些。
    //
    // ⚠️ 2026-11-02 修正：原来这里给她的是**全部** ACTIONS（除了 sleep），
    //    包括她此刻根本没资格做的 write（need 0.6 > depth+0.15）。
    //    后果实测：action=rest，她却说"就想随便走走看看有啥新鲜的，
    //    **顺便把等我的那人应付一下**" —— 后半句来自 reply 的 hint
    //    「好像有人在等我」，而 reply 这一轮根本不是候选。
    //
    //    一个"此刻不能做某件事"的人在自言自语时不会提到那件事。
    //    把不可及的选项塞进她的心流，等于让她对着菜单念菜名。
    //    这也是"主观"那一层的要求：她体验到的必须是她**真能想到**的范围。
    const live = Object.keys(ACTIONS)
      .filter((k) => k !== 'sleep' && k !== 'reply')     // 睡和回话不参与"想做"这一层
      .filter((k) => ACTIONS[k].need <= depth + 0.15)
    lean = await leanOf({
      candidates: live.map((k) => ({ k, hint: HINTS[k] || ACTIONS[k].label })),
      ctx: { ...ctx, interrupted: ctx.hasInterrupt },
      picked: action,        // ← 把 decide 选中的那个一起交给她（见 leanOf 注释）
      now,
    })
  } catch (e) { /* lean 失败不影响决策 */ }

  const cur = { action, since: now, until, why, spanMin: span, lean }

  // ⑤ 埋一个想法：她换了事做，本身就是"心里转着的事"之一
  //
  // ⚠️ 2026-11-02 修正 —— 这里原来每次决策都无条件埋一条 `'现在想' + label`，
  //    结果是**欲望通胀**：
  //
  //      inner.think 的去重是「前 12 字有一半字重叠就算同一件事」，
  //      而 "现在想回话" 和 "现在想看番/刷视频" 前 12 字重合度超过一半
  //      → 被判定成同一件事 → weight 每次 +0.8，上限 6。
  //      每 30 秒一次心跳 → **三分半就把欲望顶到满格**。
  //
  //    实测（2026-11-02 06:1x）：inner 池里两条都是 weight=5.87，
  //    而真正"想通的一件事"刚进来只有 weight=1。于是她的 innerBlock 里
  //    永远只显示这两条"想要"，挤掉所有真念头 —— 她变成了只剩欲望没有想法的人。
  //
  //    更根本的问题在语义上：**"决定去做 X"不等于"心里惦记着 X"**。
  //    人不会因为刚决定去看番，就在心里反复念"我想看番"念到魔怔。
  //    决定是决定（self-state.json 里的 current），念头是念头（inner 池）。
  //    一个动作只该在**第一次**被选中的时候留下一个念头痕迹，之后是常态就不该再响。
  //
  //    修法：只在行为**变了**的时候记，且用 kind:'act'（不是 meta），
  //    这样换台才有涟漪，原地重复没有。并且同一 action 不重复累加。
  try {
    const lastAct = (st.history || []).slice(-2, -1)[0]?.action
    const changed = lastAct !== action
    if (action !== 'rest' && changed) {
      inner.think('刚决定去' + spec.label, { kind: 'act', about: 'self', now })
    }
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
