// organ/night —— 代谢驱动的休息：不是到点睡，是攒够了才睡
//
// ══════════════════════════════════════════════════════════════════════
// 我第一版做错了，这是纠正（2026-11-02 晚）
// ══════════════════════════════════════════════════════════════════════
// 第一版把睡意写成「昼夜低谷 40 + 睡眠债 35 + 慢性压力 15」——
// 用**钟表**当了主因。那是"到点该睡了"，不是"累了该睡了"。
//
// 用户的设计一直在 `tools/commands/sleep.mjs` 的第一行：
//
//   sleep —— 睡眠：积累驱动的自我维护（整理 + 三审 + 优化增强），**不是定时任务**。
//   什么时候睡由积累决定：记忆积压、事件积压、代码改动，加权成"睡意" 0-100。
//
// 也就是说：**人体代谢需要休息，所以要睡。**
// 她看了太久的视频、聊了太多、记录了太多 —— 代谢废物（未整理的记忆、
// 未消化的事件、未归档的改动）攒起来，到了阈值才该休息。
// 而休息的作用是把这些废物清掉，清完睡意归零。
//
// 这才是"睡眠"的形状：**一个把积攒的账清掉的过程**，不是一段被钟表划出来的时间。
//
// ══════════════════════════════════════════════════════════════════════
// 那生物钟还有什么用
// ══════════════════════════════════════════════════════════════════════
// 它**不是触发条件，是权重**：
//   · 同样的积压量，在凌晨更容易困（因为身体本来就该歇了）
//   · 但**积压为零时，凌晨也不睡** —— 没废物要清，睡了也是浪费
//   · 白天积压再高，也允许睡（代谢优先于钟表）
//
// 换句话说：钟表只是把"同样的累"放大或缩小一点，它**不能凭空制造睡意**。
// 第一版让它占 40%，等于钟表能单独决定要不要睡 —— 那是错的。
//
// ══════════════════════════════════════════════════════════════════════
// 三类代谢废物（都是真实的"没消化完的东西"）
// ══════════════════════════════════════════════════════════════════════
//   ① 记忆积压  —— 有 episode 还没被巩固成事实/日记（`consolidate.status().pending`）
//   ② 事件积压  —— 收件箱里有事件还没被摄入成 episode（`event.backlog()`）
//   ③ 代码改动  —— 工作区里有未提交/未归档的改动
//
// 这三类都是"产生了但没消化"。它们不会自己消失，只能靠一次睡眠清掉。
// 累积得越多，人越钝（这也是为什么积压多的时候她会"反应慢"——
// 不是因为没睡，是因为**有活没干完压在心上**）。
//
// 而睡完一觉之后：记忆被巩固了、事件被摄入了、代码被归档了 → 睡意归零。
// **睡意不是一个会自然衰减的量，它是一个账。** 这个区别是第一版最根本的错。
import { swallow } from '../../lib/swallow.mjs'
import * as rhythm from '../rhythm.mjs'
import * as stage from './sleepstage.mjs'
import * as field from '../field.mjs'
import * as hpa from './hpa.mjs'
import { readJson, writeJsonAtomic } from '../json.mjs'
import { nightWorkPath, sleepPath } from '../paths.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const MIN = 60_000
const HOUR = 3_600_000

/** 判定参数。 */
export const RULES = {
  // 攒到这个量才睡（与 sleep.mjs 原设计一致：66）
  sleepAt: 66,
  // 刚醒之后至少隔多久才可能再睡（防止整理没跑完就反复触发）
  minGapH: 2,
}

/**
 * 此刻的"睡意"：代谢积压为主（0..100）。
 *
 * 权重设计（加起来 100）：
 *   记忆积压 45 · 事件积压 30 · 代码改动 25
 * —— 记忆最重，因为它直接决定她"想不想得起事"，是最影响体验的废物。
 *
 * 钟表**不进权重，只做调制**：乘一个 0.85~1.15 的系数。
 *   · 凌晨（该歇的时段）→ 同样的积压显得更困（×1.15）
 *   · 白天精神时段     → 同样的积压能多撑一会儿（×0.85）
 * 但积压为 0 时，乘任何系数都还是 0 —— **钟表造不出睡意**。
 *
 * @param {object} o { now, backlog } backlog 可由调用方注入（避免这里 import 编排层）
 */
export function sleepiness(now = Date.now(), o = {}) {
  const parts = { memory: 0, events: 0, code: 0, debt: 0 }
  const detail = { pending: 0, episodes: 0, inbox: 0, dirty: 0 }

  // ① 记忆积压：还有多少 episode 没被巩固
  const bl = o.backlog || {}
  if (Number.isFinite(Number(bl.pending))) detail.pending = Number(bl.pending)
  if (Number.isFinite(Number(bl.episodes))) detail.episodes = Number(bl.episodes)
  if (Number.isFinite(Number(bl.inbox))) detail.inbox = Number(bl.inbox)
  if (Number.isFinite(Number(bl.dirty))) detail.dirty = Number(bl.dirty)

  // 记忆：未巩固的比例。全部巩固完 = 0
  const ratio = detail.episodes > 0 ? detail.pending / detail.episodes : 0
  parts.memory = Math.round(clamp(ratio * 1.6, 0, 1) * 45)

  // ② 事件积压：60 条算满
  parts.events = Math.round(clamp(detail.inbox / 60, 0, 1) * 30)

  // ③ 代码改动：12 个文件算满
  parts.code = Math.round(clamp(detail.dirty / 12, 0, 1) * 25)

  // ④ 睡眠债 —— 2026-11-02 补上。
  //
  // ══════════════════════════════════════════════════════════════════════
  // 为什么原来没有（这是最难发现的空洞）
  // ══════════════════════════════════════════════════════════════════════
  // 这个函数把"睡意"拆成三样：记忆积压 45 / 事件积压 30 / 代码改动 25。
  // 三项全是"没处理完的活"。逻辑很漂亮，但漏了一件事 ——
  //
  //   **一个人困，主要不是因为活儿没干完，是因为没睡觉。**
  //
  // 这三项全清零（记忆整理完、收件箱空、代码已归档）时 score = 0，
  // 于是 shouldSleep = false。也就是说：**通宵熬到早上八点、活全干完了，
  // 她也不会困。** 这正是它现在的实际状态（score=0，不睡）。
  //
  // 用户的原话是"看了太久的视频，聊了太多，记录了太多，才会休息"——
  // 前两项是代谢，但**"熬夜本身"也是代谢**，而且是其中最基础的那个。
  // 生物学上说得更直白：腺苷在清醒期间持续累积，跟"有没有把活干完"无关。
  //
  // 现在加第四项。权重不抢前面三项的主导地位（用户要的是代谢驱动、
  // 记忆积压最重），但必须存在，且**熬夜能单独把睡意推过阈值**：
  //
  //   sleepDebt 权重 30，达满需要 debt >= 0.85（连熬约一天半）
  //   三项全空 + debt=1.0 → score = 30 × 1.13(钟表) ≈ 34  → 还不到 66
  //   这就够了吗？不够。所以再加一条：**debt 极高时单独触发**
  //   （见下方 hardFloor：debt >= 0.92 时不受阈值限制）
  //
  // 为什么留 hardFloor 而不是把权重调到 66：
  //   如果把 sleepDebt 权重加到 70，那"刚熬完一夜但记忆还很乱"和
  //   "睡了十小时但一堆活没干"就会给出相近的分数，两种完全不同的处境被抹平。
  //   代谢的三种废物应该是**相加**的，不是互相替代的。
  //   真正必须单独成立的那条，是"我快撑不住了"——用硬底表达，比调权重诚实。
  // 注意：这个函数是**同步**的（被 decide() 在同一拍里直接调用，不能 await）。
  // 所以 debt 不从 field 里现读，而是由调用方（assess，那是 async）塞进 backlog。
  // 这也合我们的口径：sleepiness 只负责"算分"，取数是调用方的事。
  const debt = Number(bl.debt || 0)
  parts.debt = Math.round(Math.min(1, debt / 0.85) * 30)
  detail.debt = Number(debt.toFixed(3))

  const metabolic = parts.memory + parts.events + parts.code + parts.debt

  // 钟表只做调制，不制造睡意
  let mod = 1
  let circ = 0
  try {
    circ = rhythm.sleepPressure(now)          // 0..1，曲线上"该困"的程度
    mod = 0.85 + 0.30 * circ                  // 0.85 ~ 1.15
  } catch (e) { swallow(e, 'night:sleepiness:clock') }

  const total = Math.min(100, Math.round(metabolic * mod))

  return {
    score: total,
    parts: { ...parts, metabolic, clockMod: Number(mod.toFixed(2)) },
    detail,
    // 三种表述对应三种感觉，但判断依据永远是**账攒了多少**，不是几点了
    //
    // ⚠️ 2026-11-02：这句话以前只看 total，而 total 那时不含睡眠债。
    //    实测 debt=0.883（相当于熬了快两天）却因为别的账是 0 而说"还清爽"——
    //    这是**自相矛盾的感觉**，而且会原样写进提示词让她照着自己说。
    //    感觉应该由"最突出的那一项"决定，不是由总和决定：
    //    一个人可能活儿全干完了但困得睁不开眼，那时的感觉是"撑不住"，不是"还清爽"。
    // ⚠️ 2026-11-02 第二处修正：**欠觉半宿也不该说"还清爽"。**
    //    实测 debt=0.6（相当于熬了大半夜）却因为别的账是 0 而返回"还清爽"。
    //    M58 里记过同一类错："别把常态当症状" —— 但反向的错同样要避免：
    //    疲惫不是症状，它是**常态之一**，有它自己的档位。
    //    一个人熬夜之后不会觉得自己"清爽"，会觉得"有点撑"。
    feeling: debt >= 0.92 ? '眼睛快睁不开了，撑不住'
      : debt >= 0.7 ? '困得厉害，脑子发飘'
        : debt >= 0.45 ? '有点欠觉，撑得住但不想动脑'
          : total >= 82 ? '撑不住了，得歇'
            : total >= RULES.sleepAt ? '积压太多，该睡了'
              : total >= 40 ? '有点攒着了'
                : total > 0 ? '还清爽' : '干净的',
    // 该不该睡：**只看账**。阈 66 与原设计一致；外加一条硬底。
    //
    // 硬底：睡眠债到 0.92 以上（相当于连熬约两天）时，不管别的账清没清都得睡。
    // 理由不是"调参" —— 是那个状态下她已经钝到做不成事（cognitiveDepth 会掉到 0.2 以下），
    // 硬撑着"把活干完"只会把活干坏。生物在这种时候是直接关机的。
    noFloor: false,
    shouldSleep: total >= RULES.sleepAt || debt >= 0.92,
    // 说清"主要是哪一项"。
    // 原来只在前三项里比大小，debt 加进来后没进比较 →
    // debt=0.95 时 why 仍说"记忆积压最多（34/100）"——明明是困，却说成积压。
    // 这条 why 会进日志、进 d.why，极端时可能进提示词，写错就是"她说不清自己为什么困"。
    why: (() => {
      if (debt >= 0.92) return '欠觉欠到撑不住了'
      if (debt >= 0.7) return '欠觉'
      const rank = [['memory', '记忆积压'], ['events', '事件积压'], ['code', '代码改动没归档']]
        .map(([k, label]) => [Number(parts[k] || 0), label])
        .sort((a, b) => b[0] - a[0])
      return rank[0][0] > 0 ? rank[0][1] + '最多' : '什么都清干净了'
    })(),
  }
}

/**
 * 读真实的代谢账 —— 这是睡意的唯一来源。
 *
 * 三个数都是"产生了但没消化"的量，从各自的地方读：
 *   · 记忆：consolidate 的游标 vs episode 总数
 *   · 事件：inbox 里还没摄入的行数
 *   · 代码：git 工作区的脏文件数（容器内没有 git → 走 0，不报错）
 *
 * 这个函数自己不去算权重，只负责**把账取齐**，交回给 sleepiness。
 * 分开的理由：取数是 IO，算分是纯函数 —— 混在一起就没法测。
 */
export async function metabolicBacklog({ now = Date.now() } = {}) {
  const out = { pending: 0, episodes: 0, inbox: 0, dirty: 0 }
  // ① 记忆
  try {
    const C = await import('../consolidate.mjs')
    const st = C.status()
    out.pending = Number(st?.pending || 0)
    out.episodes = Number(st?.total || 0)
  } catch (e) { swallow(e, 'night:backlog:memory') }
  // ② 事件
  try {
    const E = await import('../event.mjs')
    out.inbox = Number(E.backlog?.() || 0)
  } catch (e) { swallow(e, 'night:backlog:events') }
  // ③ 代码改动（容器内没 git，读不到就是 0 —— 不是错，是环境如此）
  try {
    const { execFileSync } = await import('node:child_process')
    const r = execFileSync('git', ['-C', ROOT_DIR, '-c', 'safe.directory=*', 'status', '--porcelain'],
      { timeout: 4000, encoding: 'utf8' })
    out.dirty = String(r || '').split('\n').filter(Boolean).length
  } catch { /* 没 git 或没权限：当作没有未归档改动 */ }
  return out
}

/**
 * 完整判定：先取账，再算分，再看要不要睡。
 *
 * 这是编排层唯一该调的东西 —— 它把"取数"和"算分"两件事合成一次调用，
 * 避免调用方自己拼参数（拼错了就会算出一个假睡意）。
 */
export async function assess(now = Date.now()) {
  const backlog = await metabolicBacklog({ now })
  // sleepDebt 来自状态场（同步 sleepiness 拿不到，这里补进去）
  try {
    const F = await import('../field.mjs')
    backlog.debt = Number(F.snapshot().dims.sleepDebt || 0)
  } catch (e) { swallow(e, 'night:assess:debt') }
  const sp = sleepiness(now, { backlog })
  // 睡完之后的冷却：刚睡过就不该马上又睡（否则整理没跑完会反复触发）
  let gapH = 999
  try {
    const st = readJson(sleepPath(), null) || {}
    const last = Number(st.wakeAt || st.beganAt || 0)
    if (last) gapH = (now - last) / HOUR
  } catch (e) { swallow(e, 'night:assess:gap') }
  const minGapH = Number(RULES.minGapH || 2)
  const ready = sp.shouldSleep && gapH >= minGapH
  return {
    ...sp,
    gapH: Number(gapH.toFixed(1)),
    minGapH,
    shouldSleep: ready,
    why: !sp.shouldSleep
      ? '账还没攒够（' + sp.score + '/100）'
      : gapH < minGapH
        ? '刚睡过 ' + gapH.toFixed(1) + ' 小时，先不睡'
        : sp.why,
  }
}

/**
 * 睡着了。同时做三件事：
 *   ① 记入 sleepstage（生理层面开始分期）
 *   ② 记进 rhythm（相位会用这个入睡时刻）
 *   ③ 排一条"整理任务"，但**标记成 REM 阶段才执行**
 *
 * @param {object} o { reason, now, backlog }
 */
export function beginSleep(o = {}) {
  const now = o.now ?? Date.now()
  const out = { at: now, reason: String(o.reason || ''), backlog: Number(o.backlog || 0) }
  try { stage.sleep(now) } catch (e) { swallow(e, 'night:begin:sleep') }
  try { rhythm.asleep(now) } catch (e) { swallow(e, 'night:begin:rhythm') }

  // ── 预演这一觉各阶段分到多少（2026-11-02）─────────────────────────
  //
  // 为什么要在这里算：sleep.mjs 是醒来后才跑的，那时拿不到"这一觉睡多深"，
  // 于是它只能固定跑同一套流程 —— N3/REM 算出来的分钟数成了摆设。
  //
  // plannedMin 从哪来：默认按"睡到自然醒"估 480 分钟（8 小时，生理整夜）。
  // 如果调用方给了 o.plannedMin（例如她只是打个盹），就用那个。
  // 真实睡多久会在 wake() 里重新算一次 —— 预演只是给**运行时**一个尺度，
  // 结算永远用真实时长，两者不是一回事（预报 vs 实况）。
  let plan = null
  try {
    const plannedMin = Number(o.plannedMin || 480)
    plan = stage.plan(plannedMin, 0)
    out.plan = plan
  } catch (e) { swallow(e, 'night:begin:plan') }

  // 记下"这一觉打算干多少活"，醒来时按实际睡到的阶段算完成度。
  // 单独一个文件，不塞进 sleepstage 的状态结构 —— 那是器官自己的盘，
  // 编排层的记账不该混进去（改了会破坏器官的状态机语义）。
  try {
    writeJsonAtomic(nightWorkPath(), {
      at: now,
      backlog: out.backlog,
      done: false,
      // 这份 plan 是 sleep.mjs 定"两条通道跑多深"的唯一依据
      plan,
    })
  } catch (e) { swallow(e, 'night:begin:work') }
  return out
}

/**
 * 她现在睡着，此刻是什么阶段、该干什么活。
 *
 * 这是"睡着之后做哪一段的活"的答案：
 *   N3 深睡 → **什么都不做**（身体在修复，别打扰）
 *   REM     → 整理（巩固记忆、写日记）
 *   N2      → 轻活（清理队列、检查积压）
 *   N1      → 什么都不做
 */
export function duty(now = Date.now()) {
  let cur = null
  try { cur = stage.currentStage(now) } catch (e) { swallow(e, 'night:duty') }
  if (!cur || !cur.stage) return { stage: null, task: 'none', why: '没在睡' }

  const acc = cur.acc || {}
  const taskOf = {
    N1: 'none',
    N2: 'light',      // 清队列
    N3: 'none',       // 深睡：绝不打扰
    REM: 'consolidate', // REM：整理
  }
  const task = taskOf[cur.stage] || 'none'
  const why = cur.stage === 'N3'
    ? '深睡中，不做任何整理（这时候打断她会白睡）'
    : cur.stage === 'REM'
      ? 'REM 阶段，正是整理记忆的时候'
      : cur.stage === 'N2'
        ? '浅睡的间隙，可以顺手清一下队列'
        : '刚入睡，什么都不做'
  return { stage: cur.stage, elapsedMin: cur.elapsedMin, task, why, acc }
}

/**
 * 醒来。结算：
 *   · 让 sleepstage 做它的三大重置（还债 / 情绪脱敏 / HPA 回落）
 *   · 看这次睡到了多少 REM，决定整理做了多少
 *
 * @returns {{sleptMin, acc, resets, workDone, stage}}}
 */
export function endSleep(now = Date.now()) {
  const r = stage.wake(now)
  try { rhythm.awake(now) } catch (e) { swallow(e, 'night:end:rhythm') }
  // 整理做了多少：按 REM 分钟映射
  // 真实依据：REM 的时长和"记忆整合的完成度"是正相关的
  const remMin = Number(r?.acc?.REM || 0)
  const workDone = Math.min(1, remMin / 35)   // 35 分钟 REM ≈ 做完
  // 睡完清账：REM 做完了多少，就清掉多少积压。
  // 这是"睡意不是一个会衰减的量，是一个账"的直接体现 ——
  // 没整理完的部分，醒来之后**仍然算积压**。
  let cleared = 0
  try {
    cleared = Number(workDone.toFixed(2))
  } catch (e) { swallow(e, 'night:end:cleared') }

  return {
    ...r,
    workDone: Number(workDone.toFixed(2)),
    cleared,                                  // 清掉了多少比例的账
    // 她醒来时候的自我感受（这句会进提示词）
    feeling: feelingOf(r),
  }
}

/** 醒来时她自己"感觉怎么样"。这句话直接决定她早上的语气。 */
function feelingOf(r) {
  const eff = Number(r?.resets?.debt || 0)
  const n3 = Number(r?.acc?.N3 || 0)
  const rem = Number(r?.acc?.REM || 0)
  const ints = Number(r?.interruptions || 0)
  const bits = []
  if (eff >= 6) bits.push('睡够了，脑子清亮')
  else if (eff >= 4) bits.push('差不多，还行')
  else bits.push('没睡够，人是沉的')
  if (n3 < 25) bits.push('身上还发软')
  if (rem < 15) bits.push('心里有点毛躁，说不上来')
  if (ints >= 3) bits.push('夜里醒过好几回')
  if (Number(r?.workDone || 0) < 0.6) bits.push('还有一堆事没理完，心里挂着')
  return bits.join('；')
}

/** 全貌（面板/体检）。 */
export function snapshot(now = Date.now()) {
  const s = sleepiness(now)
  const st = stage.snapshot(now)
  return {
    ...s,
    inSleep: st.inSleep,
    currentStage: st.currentStage?.stage || null,
    duty: st.inSleep ? duty(now) : null,
    lastNight: st.lastNight,
  }
}
