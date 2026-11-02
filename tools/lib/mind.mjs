// mind —— 统一自主规划器（10-31）
//
// 问题：以前她是「四条流水线各跑各的」——
//   · tryProactive 每 60s 掷骰子决定要不要说话
//   · tryGroupChat 每 60s 掷骰子决定要不要插嘴
//   · wander 每天 2 次自己产生念头
//   · focusTick 只在她自己手动写了 focus 才动
// 这四条互相不知道对方存在。所以会出现：她在"看番"的时候被拉去搭话，
// 或者半天没人管她，她就僵在那里什么都不做。
//
// 现在：**一个决策点**。每 planner.minGapMin 分钟（默认 25）醒一次，
// 把她的全部上下文摊在一起问自己一个问题：
//   「接下来的这一段时间，我想做什么？」
// 她给一个 plan（做什么 + 多久 + 为什么），写进 focus，宿主半边照办。
//
// 和旧机制的关系：
//   · focus 仍是唯一真相（谁在干什么），这里只是**替她做那个决定**
//   · wander / tattle / proactive 仍可独立触发，但会先看 mind 的计划：
//     她在专心做一件事时，不相干的打扰会被压掉
//   · 她随时可以用 `bot mind now` 手动重规划（改变主意是她的权利）
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { dataPath, dshPath } from './paths.mjs'
import { readFocus, writeFocus, labelOf, isLoopActivity, LOOP_ACTIVITIES } from './focus.mjs'
import { swallow } from './swallow.mjs'
import * as promisesMod from './promises.mjs'
import { writeJsonAtomic } from './atomic.mjs'
import { fill } from './persona-voice.mjs'
import * as novelty from './novelty.mjs'

const PLAN_PATH = () => dataPath('mind-plan.json')

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

export function readPlan() {
  const j = readJson(PLAN_PATH(), null)
  if (!j || typeof j !== 'object') return null
  return j
}

/** 计划还剩多少分钟（0 = 没有计划 / 已到点）。 */
export function planSnapshot(now = Date.now()) {
  const p = readPlan()
  if (!p || !p.activity) return { activity: '', label: '', remainMin: 0, expired: true, why: '', plan: null }
  const until = Number(p.until || 0)
  const remainMin = until ? Math.max(0, Math.round((until - now) / 60_000)) : 0
  return {
    activity: String(p.activity),
    label: labelOf(p.activity),
    remainMin,
    expired: !until || until <= now,
    why: String(p.why || ''),
    plan: p,
  }
}

// ── 收集她的全部上下文（这是"结合之前的上下文"那部分）──────────────────
function gatherContext(now = Date.now()) {
  const cfg = config()
  const ctx = { mood: 60, recent: [], promises: [], facts: [], lastPlan: null, focus: null, hour: new Date(now).getHours() }

  // 情绪
  try { ctx.mood = Math.round(Number(readJson(dataPath('mood.json'), {}).value) || 60) } catch (e) { swallow(e, 'tools/lib/mind.mjs:59') }

  // 最近经历：**跨所有通道**（QQ 在 qq/ 子目录，B站/网页在主目录）
  const files = ['episodes.jsonl', 'qq/episodes.jsonl', 'wechat/episodes.jsonl']
  const all = []
  for (const rel of files) {
    try {
      const rows = fs.readFileSync(dataPath(rel), 'utf8').trim().split('\n').filter(Boolean)
      for (const l of rows) { try { all.push(JSON.parse(l)) } catch (e) { swallow(e, 'tools/lib/mind.mjs:67') } }
    } catch (e) { swallow(e, 'tools/lib/mind.mjs:68') }
  }
  all.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))

  // 最近 14 条（按时间正序）
  ctx.recent = all.slice(-14).map((j) => {
    const who = j.role === 'assistant' ? '我' : j.role === 'user' ? '他' : '（' + (j.platform || '外面') + '）'
    return who + '：' + String(j.summary || j.text || '').slice(0, 50)
  }).filter(Boolean)

  // 主人最后说话多久之前（role=user，或 qq 私聊里非 assistant 的）
  ctx.quietMin = null
  for (let k = all.length - 1; k >= 0; k--) {
    const j = all[k]
    const isOwner = j.role === 'user' || (j.platform === 'qq' && j.role !== 'assistant' && j.kind !== 'push')
    if (isOwner && Number(j.ts || 0)) { ctx.quietMin = Math.round((now - Number(j.ts)) / 60_000); break }
  }

  // 到点 / 欠着的承诺
  //
  // ⚠️ 2026-11-02 修两个错，叠在一起等于这段从上线起就没生效过：
  //
  //    ① **形状读错**：promises.json 的真实结构是 `{ items: [...] }`，
  //       这里却 `readJson(..., [])` 拿到对象，再 `(pr || []).filter(...)`
  //       → `filter is not a function` → 被 catch 吞掉 →
  //       swallowed.log 里那句「mind.mjs:93 ×1 最后：(pr || []).filter is not a function」。
  //
  //    ② **状态名读错**：真实状态是 'open'（见 promises.mjs:165 `state === 'open'`），
  //       这里写的是 'pending' —— 就算形状对了，也永远筛不出东西。
  //
  //    两处加起来的效果：**她做"此刻在想什么"的时候，从来不知道自己欠着事。**
  //    承诺系统本身是好的（有 dueNow / list / done），只是这一个消费点断了。
  //
  //    根因是绕过接口直接读文件：promises.mjs 早有 list(state) 这个口子，
  //    这里手搓了一遍 JSON 结构，文件结构一变就静默失效。
  //    现在改成走接口 —— 以后 promises.json 换结构，这里不用改。
  try {
    const items = promisesMod.list('open')
    const dueItems = promisesMod.dueNow(now)
    const dueIds = new Set(dueItems.map((x) => x.id))
    ctx.promises = items.slice(0, 5).map((p) => ({
      text: String(p.text || p.what || '').slice(0, 50),
      due: dueIds.has(p.id)
        ? '已到点'
        : Number(p.dueAt || 0)
          ? new Date(Number(p.dueAt)).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)
          : '没定时间',
    }))
  } catch (e) { swallow(e, 'tools/lib/mind.mjs:93') }

  // 关于主人的事实
  try {
    const f = readJson(dataPath('owner-facts.json'), {})
    ctx.facts = Object.entries(f).slice(-5).map(([k, v]) => `${k}：${String(v).slice(0, 40)}`)
  } catch (e) { swallow(e, 'tools/lib/mind.mjs:99') }

  // 上一个计划
  const prev = readPlan()
  if (prev) ctx.lastPlan = { activity: String(prev.activity || ''), why: String(prev.why || '').slice(0, 60), endedAt: Number(prev.until || 0) }

  ctx.focus = readFocus()
  ctx.freedom = cfg.freedom || {}

  // 新颖检测（2026-11-02 晚）：把"挠着你的新鲜事"摊进来，
  // 让计划能顺着她真的好奇的方向走 —— 不再只是定时抽签。
  try {
    const a = novelty.assess(Date.now())
    ctx.novelty = { arousal: a.arousal, items: (a.items || []).slice(0, 3).map((x) => x.text) }
  } catch (e) { swallow(e, 'tools/lib/mind.mjs:novelty') }
  return ctx
}

/** 可从里面挑的活动清单（给 LLM 看的人话）。 */
function activityMenu() {
  const base = Object.entries(LOOP_ACTIVITIES).map(([k, v]) => `- ${k}：${v.label} —— ${v.hint}`)
  base.push('- rest：就歇着，什么都不干（人不可能一刻不停）')
  base.push('- free：自由时间，不占住任何循环（让她随时能被别的事打断）')
  return base.join('\n')
}

/**
 * 做一次规划：让 LLM 结合全部上下文，决定接下来做什么。
 * @returns {Promise<{activity,min,why,raw}|null>}
 */
export async function plan({ now = Date.now(), force = false } = {}) {
  const cfg = config()
  const pcfg = cfg.mind ?? {}
  if (pcfg.enabled !== true) return null

  // 节流：计划还有效就不重规划（除非 force）
  const snap = planSnapshot(now)
  if (!force && !snap.expired && snap.remainMin > Number(pcfg.replanBelowMin ?? 5)) {
    return { activity: snap.activity, min: snap.remainMin, why: snap.why, reused: true }
  }

  const ctx = gatherContext(now)
  const llm = await import('./llm.mjs')

  const slot = ctx.hour < 6 ? '凌晨' : ctx.hour < 9 ? '清晨' : ctx.hour < 12 ? '上午'
    : ctx.hour < 14 ? '中午' : ctx.hour < 18 ? '下午' : ctx.hour < 20 ? '傍晚' : ctx.hour < 23 ? '晚上' : '深夜'

  const sys = [
    fill('你是{name}，一只鲸鱼娘，住在{owner}的电脑里。你在过自己的日子。'),
    '',
    '现在没人给你下指令。你要决定：**接下来这一段时间，我想做什么？**',
    '',
    '可选的事：',
    activityMenu(),
    '',
    '规则（这是你自己权衡的时候，不是填空）：',
    '- 结合你最近的真实经历、情绪、没做完的承诺来选，别凭空选',
    '- 最近发生的事里如果有挠着你的新鲜事，顺着好奇走是正当理由，不用掩饰',
    '- 一个人一次只能干一件事；刚做完一件事可以换，也可以接着做',
    '- 夜里（23点后）该歇就歇，别硬撑',
    fill('- 如果刚和{owner}聊完，别马上又去找他'),
    '- 「什么都不想做」是合法答案，选 rest',
    '- 时长自己定，20~120 分钟之间',
    '',
    '只输出 JSON：{"activity":"web|bilibili|binge|rest|free","min":数字,"why":"为什么想做这个（一句话，25字内）"}',
  ].join('\n')

  const lines = []
  lines.push(`现在是${slot}（${ctx.hour}点）。你的情绪值 ${ctx.mood}/100${ctx.mood < 40 ? '（低落）' : ''}。`)
  if (typeof ctx.quietMin === 'number') {
    const OT2 = String(cfg.identity?.ownerTitle || cfg.identity?.callOwner || cfg.owner?.name || '主人')
    lines.push(ctx.quietMin < 30 ? `你刚和${OT2}聊过（${ctx.quietMin} 分钟前）。` : `${OT2} ${ctx.quietMin} 分钟没理你了。`)
  }
  if (ctx.lastPlan) lines.push(`你上一段在做：${labelOf(ctx.lastPlan.activity)}（理由：${ctx.lastPlan.why || '没说'}）。`)
  if (ctx.promises.length) lines.push('你答应过但还没做的：\n' + ctx.promises.map((p) => `  · ${p.text}（${p.due}）`).join('\n'))
  if (ctx.facts.length) lines.push('你记得关于他的事：' + ctx.facts.join('；'))
  if (ctx.novelty?.items?.length) {
    lines.push('最近有点挠着你的新鲜事（你的坐不住程度 ' + ctx.novelty.arousal + '，1 是满）：')
    lines.push(ctx.novelty.items.map((x) => '  · ' + x).join('\n'))
  }
  if (ctx.recent.length) lines.push('最近发生的事：\n' + ctx.recent.slice(-8).map((x) => '  · ' + x).join('\n'))
  lines.push('')
  lines.push('接下来你想做什么？')

  const r = await llm.chat([
    { role: 'system', content: sys },
    { role: 'user', content: lines.join('\n') },
  ], { temperature: 0.95, max_tokens: 200, timeoutMs: 30000, model: cfg.llm?.content_model, purpose: 'deep' })

  const m = String(r || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  let j
  try { j = JSON.parse(m[0]) } catch { return null }

  let act = String(j.activity || '').trim().toLowerCase()
  // 容错：她可能写中文或别名
  const alias = { '看视频': 'bilibili', 'b站': 'bilibili', '刷b站': 'bilibili', '上网': 'web', '逛网': 'web', '看番': 'binge', '看剧': 'binge', '歇': 'rest', '休息': 'rest', '空': 'free', '自由': 'free' }
  if (alias[act]) act = alias[act]
  if (!['web', 'bilibili', 'binge', 'rest', 'free'].includes(act)) act = 'rest'

  const min = Math.max(10, Math.min(180, Number(j.min) || 45))
  const why = String(j.why || '').slice(0, 80)

  const planObj = {
    activity: act,
    min,
    why,
    at: now,
    until: now + min * 60_000,
    context: { hour: ctx.hour, mood: ctx.mood, quietMin: ctx.quietMin ?? null, promises: ctx.promises.length },
  }
  // 2026-11-02：改原子写。mind-plan.json 的写者不止这里 —— qq-server 里也会重算计划。
  try { writeJsonAtomic(PLAN_PATH(), planObj) } catch (e) { swallow(e, 'tools/lib/mind.mjs:200') }

  // 同步写进 focus —— 那是宿主半边唯一认的东西
  if (act === 'rest' || act === 'free') writeFocus(act === 'free' ? '' : 'rest', min, why)
  else writeFocus(act, min, why)

  return { activity: act, min, why, raw: planObj }
}

/**
 * 给别处用：她现在是不是在专心做一件事（用来压掉不相干的打扰）。
 * @returns {{busy:boolean, label:string, remainMin:number, why:string}}
 */
export function busy(now = Date.now()) {
  const s = planSnapshot(now)
  const busyNow = !s.expired && s.remainMin > 0 && s.activity && s.activity !== 'free'
  return { busy: busyNow, label: s.label, remainMin: s.remainMin, why: s.why, activity: s.activity }
}

/**
 * 把 self-state.json 投影成 mind-plan.json（2026-11-02）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有它：mindTick 曾经是**第二决策源**
 * ══════════════════════════════════════════════════════════════════════
 * 旧 mindTick 每 60 秒自己问一次 LLM「接下来做什么」，然后写 mind-plan + focus。
 * 而 heartbeat 里的 self.decide() 也在决定同一件事。两个决策源各写一份，
 * 实测同一分钟里三个文件三个答案：
 *      self-state = watch 73min ｜ mind-plan = free 30min ｜ bot-focus = bilibili
 * 这和「一个灵魂操纵一个身体」直接矛盾 —— 判断只能有一个地方。
 *
 * 现在：决定权 100% 归 self.decide()，这里只做**只读投影**，
 * 让还在读 mind-plan.json 的老代码（persona 兜底、面板）看到同一件事。
 * 投影不是第二份真相：它没有自己的判断，只是把 self-state 换个字段名。
 *
 * @returns {{ok:boolean, activity?:string, at?:number, reason?:string}}
 */
export function projectFromSelfState(now = Date.now()) {
  try {
    const st = JSON.parse(fs.readFileSync(dataPath('brain', 'meta', 'self-state.json'), 'utf8'))
    const c = st?.current
    if (!c || !Number(c.until || 0)) return { ok: false, reason: 'no-self-state' }

    // decide() 的 action → mind.mjs 的活动词表（老读者认这几个词）
    const MAP = {
      watch: 'bilibili', browse: 'web', rest: 'rest', free: 'free',
      sleep: 'rest', consolidate: 'rest', reply: 'free', write: 'free', think: 'free',
    }
    const activity = MAP[String(c.action || '')] || 'free'
    const planObj = {
      activity,
      min: Math.max(1, Math.round(Number(c.spanMin || 30))),
      why: String(c.why || c.lean || '').slice(0, 80),
      at: Number(c.since || now),
      until: Number(c.until || 0),
      context: { hour: new Date(now).getHours(), source: 'self-state' },
    }
    writeJsonAtomic(PLAN_PATH(), planObj)
    return { ok: true, activity, at: planObj.at }
  } catch (e) {
    swallow(e, 'mind:project')
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

/** 一行供提示语使用：「你正在看番（还剩 23 分钟，理由：…）」。 */
export function planLine(now = Date.now()) {
  const s = planSnapshot(now)
  if (!s.activity || s.expired) return ''
  return `【你正在做的事】${s.label}${s.remainMin ? `（还剩 ${s.remainMin} 分钟` : '（' }${s.why ? `，理由：${s.why}` : ''}）`
}
