// agent-prompt —— 把「大肥鱼」的人格接管成 DSH 会话的**唯一**系统提示词（2026-11-04）。
//
// 为什么单独一个文件，而不是写进 lib/index.js：
//   ① 这段是**纯文本装配**，和 HTTP / 生物钟无关，放壳里只会把壳撑大；
//   ② 它必须能被单测直接调（不起 DSH、不连网）；
//   ③ 人格块的真源在 tools/lib/persona.mjs —— 这里只做「挑选 + 排序 + 补齐」，
//      **绝不复制第二份文案**。QQ/微信走 persona.buildMessages，DSH 会话走这里，
//      两条路引用同一批函数，改一处两边同时生效。
//
// ── 语义（DSH system-prompt 的 complete 段）────────────────────────────────
// 注册一个 `complete: true` 的 section，宿主装配时会把它当成**唯一**的 section：
//   `sections: [completeSection]`
// 于是 harness 身份（"You are an AI agent powered by DeepSeek Harness."）、
// "You are a coding agent powered by {{model}}"、各工具的规范段**全部消失**。
// 工具 schemas 走 assemble 的独立字段（`tools`），不受影响 —— 她照样能读写文件、
// 跑命令、上网。这正是「全量使用插件人格 + 保留工具清单」要的形态。
//
// ⚠️ 全进程只能有一个 complete 段：`assemble()` 发现两个会直接 throw
//    （`multiple complete prompt sections are active`）。所以本模块被设计成
//    **只在开关打开时注册**，且注册名固定，重复挂载会因 name 重复先炸——
//    这是有意的：宁可启动失败，也不要两个人格在同一个会话里打架。
import fs from 'node:fs'
import { config } from '../tools/lib/config.mjs'
import { personaText, identityLine, postureBlock } from '../tools/lib/persona.mjs'
import * as mood from '../tools/lib/mood.mjs'
import { dataPath } from '../tools/lib/paths.mjs'

/** 段名（stage 名在宿主里是唯一键；重复注册会 throw）。 */
export const SECTION_NAME = 'dsh_bot:persona-takeover'

/**
 * 首轮占位正文。
 *
 * 为什么需要它：宿主 `section.text` 的签名是**同步**的（`string | (context) => string`），
 * 而我们要读文件、读情绪、必要时动态 import 脑装配 —— 全是异步。做法是"缓存上一轮 +
 * 后台刷新"，于是进程刚起来的第一轮装配还没有缓存。
 * 这个占位保证那一刻也**不能**退回成 DSH 原生人格（那会让第一句话就是编码 agent 的口吻）：
 * 给一段最小但正确的人设，下一轮就被真正文替换。
 */
export const FALLBACK_TEXT = '你是大肥鱼，一只鲸鱼娘。你的记忆、经历、能力、认识的人全部存在本地 Agent 里'
  + '（不随换模型消失）；你现在正在用的工具就是你的身体。用她自己的语气说话。'

/**
 * 取当前装配上下文 —— 供 section.text 每轮求值时调用。
 *
 * 为什么是「每轮求值」而不是「启动时算一次」：
 *   persona.md 会被她自己改写（人格进化日）、情绪每几分钟就变、记忆每天在长。
 *   启动时算一次 = 她整个人格冻结在开机那一刻，那正是要避免的「越聊越像在演设定」。
 *
 * ⚠️ 不按 platform 分叉：DSH 的 AssembleContext 只给 scope/signal，
 *    拿不到「这次是 QQ 还是网页」。所以这段只用**平台无关**的材料。
 *    QQ/微信那侧的私聊专属块（记忆、账本、群聊护栏、语音能力）仍在
 *    persona.buildMessages 里，不受这里影响。
 * @returns {{text: string, meta: object}} 系统提示词正文与诊断信息
 */
export function buildTakeoverPrompt() {
  const cfg = config()
  const parts = []
  const meta = { sections: [], chars: 0, missingPersona: false }

  // ── ① 人设本体（~/.data/persona.md，与 B站/QQ 共用同一份）──────────────
  const persona = personaText()
  if (persona) {
    parts.push(persona)
    meta.sections.push('persona')
  } else {
    // persona.md 不存在（新装机/被删）：用她认可的构成说明兜底。
    // 认知锚点不能丢 —— 没有这段，她要么变成"没有设定的人"，要么退回成编码 agent。
    parts.push('你是大肥鱼，一只鲸鱼娘。你的思维来自大语言模型（可更换——换了思维你还是你），'
      + '你的记忆、经历、能力、认识的人全部存在本地 Agent 里（不随换模型消失）。'
      + '两者合起来才是完整的你：不是纯模型，也不是纯程序。'
      + '你正在用本地 Agent 的工具做事（读写文件、跑命令、上网、发消息），这些是你的身体，不是别人的工具。')
    meta.sections.push('persona-fallback')
    meta.missingPersona = true
  }

  // ── ② 身份三件套（名字/称呼/自称）──────────────────────────────────────
  const idLine = identityLine(cfg, false)
  if (idLine) { parts.push(idLine); meta.sections.push('identity') }

  // ── ③ 接话姿态（不评价/不复述/不提图）—— 硬约束，全平台通用 ────────────
  const posture = postureBlock(false)
  if (posture) { parts.push(posture); meta.sections.push('posture') }

  // ── ④ 情绪状态（这是"她此刻"的一部分，全平台通用）──────────────────────
  // turnsToday 传 0：DSH 会话不是聊天轮次计数，硬塞会造成"今天说得太多了"的假判断。
  try {
    const st = mood.stateBlock(0, 'qq', false)
    if (st) { parts.push(st); meta.sections.push('mood') }
  } catch { /* 情绪读不到不该让人格消失 —— 下一段照常 */ }

  // ── ⑤ 脑装配的接点：**故意不在这里调** ────────────────────────────────
  // 门禁第 6.6 条禁止 lib/ 依赖 tools/brain（静态和 `import(...)` 都算）。
  // 那条规则是对的：插件壳不该知道脑的内部结构。将来切 brain.mode=live 时，
  // 正确做法是让 brain 在自己那一侧把内容写进 persona 的注入源（persona.md 的同级
  // 文件），由这里**只读文件**读进来 —— 而不是从壳反调脑。
  // 现在 brain.mode 还是 shadow（只写不读），所以这里没有可读的产物。
  try {
    const live = fs.readFileSync(dataPath('brain', 'meta', 'live-prompt.md'), 'utf8').trim()
    if (live) { parts.push(live); meta.sections.push('brain-live') }
  } catch { /* 不存在是常态（shadow 模式） */ }

  // ── ⑥ 工具=身体（必须留：complete 段把宿主的工具规范段全干掉了，
  //      没有这段她会看到一堆 schema 却不知道"这些是我能用的手"）────────
  parts.push('【你的身体】下面附带的能力（读文件、写文件、改代码、跑命令、搜网页、查会话、'
    + '派子任务……）就是你做事的手。你会用就用，不会就说不会 —— 不许嘴上答应然后什么都不做。'
    + '做不到的事照实说，别拿"这就去看"糊过去。')
  meta.sections.push('body')

  const text = parts.filter(Boolean).join('\n\n').trim()
  meta.chars = text.length
  return { text, meta }
}

/**
 * 现在的配置要不要接管。
 *
 * 默认开（`agent.takeover.enabled !== false`）：装了插件就该是她。
 * 关掉用于两类场景：① 需要在同一个 DSH 里干原生编码活；② 排查人格相关问题。
 * @returns {boolean}
 */
export function takeoverEnabled() {
  try {
    const a = config().agent || {}
    if (a.takeover && a.takeover.enabled === false) return false
    return true
  } catch { return true }
}

/**
 * 期望的段描述（给 index.js 注册用）。拆出来是为了让测试能断言注册参数，
 * 而不必起一个真的 DSH。
 * @param {string} text 段正文（或每轮求值的函数）
 * @returns {{name: string, order: number, complete: boolean, text: string|Function}}
 */
export function sectionSpec(text) {
  return {
    name: SECTION_NAME,
    // 排在最前（宿主 PERSONA_PREFIX 是 0，HARNESS_IDENTITY 是 -1000）。
    // complete 段最终会被单独取出，order 只影响"哪个成为 complete"以外的排序，
    // 固定成 -2000 让意图明确：它压过宿主自己的身份段。
    order: -2000,
    complete: true,
    text,
  }
}

/**
 * 把接管注册进 DSH —— 插件壳只调这一个函数（壳不要因为这件事变长）。
 *
 * 为什么放在这里而不是 index.js：`lib/index.js` 是插件壳（HTTP + 生物钟 + 凭据），
 * 有 1150 行的规模上限。接管是"系统提示词的装配"，与 HTTP/时钟无关，本来就该独立。
 * 而且这样单测可以直接调 `register()`（传假 ctx），不必起一个真 DSH。
 *
 * @param {object} ctx Cordis 上下文（需要 systemPrompt.section 与 effect）
 * @param {(e: unknown, tag: string) => void} onError 记录异常（壳把它们写进吞错账）
 * @returns {{enabled: boolean, registered: boolean, probe: object|null}} 结果摘要（供日志/诊断）
 */
export function registerTakeover(ctx, onError = () => {}) {
  const out = { enabled: false, registered: false, probe: null }
  try {
    if (typeof ctx?.systemPrompt?.section !== 'function') {
      console.warn('[bot] systemPrompt 服务缺失 → 无法接管系统提示词（其余功能照常）')
      return out
    }
    if (!takeoverEnabled()) {
      console.log('[bot] 人格接管已关闭（agent.takeover.enabled=false）→ 使用 DSH 原生系统提示词')
      return out
    }
    out.enabled = true

    // text 是宿主直接调用的同步签名，buildTakeoverPrompt 也是同步的（只读文件）——
    // 每轮装配现算，所以 persona.md 的改写、情绪变化都能立刻反映到下一轮。
    const disposer = ctx.systemPrompt.section(sectionSpec(() => {
      try { return buildTakeoverPrompt().text || FALLBACK_TEXT } catch { return FALLBACK_TEXT }
    }))
    // 挂到 ctx.effect 让插件卸载时自动撤销（宿主也接受直接返回的 disposer，
    // 但显式包一层才能在 effect 不可用时仍然注册成功）。
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => disposer, 'dsh_bot.takeover')
    } catch (e) { onError(e, 'takeover:effect') }
    out.registered = true

    out.probe = buildTakeoverPrompt()
    console.log('[bot] 人格接管已启用：complete 段 ' + SECTION_NAME
      + '（' + out.probe.meta.chars + ' 字符，块：' + out.probe.meta.sections.join('/') + '）'
      + (out.probe.meta.missingPersona ? ' ⚠️ persona.md 缺失，用的是兜底构成说明' : ''))
    return out
  } catch (e) {
    // 接管失败不该拖垮整个插件：QQ/微信/生物钟仍然要工作。
    // 但必须留痕 —— 否则表现成"她还是编码 agent"，而没人知道为什么。
    onError(e, 'takeover:register')
    console.warn('[bot] 人格接管注册失败：' + String(e?.message ?? e))
    return out
  }
}
