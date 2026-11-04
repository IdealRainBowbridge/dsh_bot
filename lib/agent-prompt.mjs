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
import { config } from '../tools/lib/config.mjs'
import { personaText, identityLine, postureBlock } from '../tools/lib/persona.mjs'
import * as mood from '../tools/lib/mood.mjs'
import * as brain from '../tools/brain/index.mjs'

/** 段名（stage 名在宿主里是唯一键；重复注册会 throw）。 */
export const SECTION_NAME = 'dsh_bot:persona-takeover'

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

  // ── ⑤ 脑的装配（若已切到 live，这里能给出比上面更强的上下文）──────────
  // brain.mode 默认 shadow：只在 live 时才有内容，shadow 下返回 null。
  // 保留这个接点，是为了将来切 live 时 DSH 侧不用再改一次。
  try {
    const assembled = brain.assembleFor?.({ platform: 'dsh', chatId: '', userId: '', userText: '' })
    // assembleFor -> assemble 返回 `{ system: { role:'system', content }, messages }`
    const extra = assembled && typeof assembled.system?.content === 'string' ? assembled.system.content.trim() : ''
    if (extra) { parts.push(extra); meta.sections.push('brain-live') }
  } catch { /* live 装配失败：退回只有人格与状态，不阻断 */ }

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
