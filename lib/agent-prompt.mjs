// agent-prompt —— 把「理想的机械人」的人格接管成 DSH 会话的**唯一**系统提示词（2026-11-04）。
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
//
// ── 2026-11-04 第二轮：靠插件自身把人格焊死 ────────────────────────────────
// 上一轮只做到「注册一个 complete 段」。剩下三类失效它挡不住，这轮全补上：
//
//   A. **人设被删/被清空**：persona.md 是运行时文件，她自己能改；改坏或删掉时，
//      旧实现退回一段 100 字的兜底 —— 那段只有"你是鲸鱼娘"，没有语气、没有关系、
//      没有边界，实际表现是"一个自称鲸鱼娘的通用助手"。
//      → 现在把**核心锚点**焊进代码（CORE_ANCHOR，不可让渡、不受任何配置关闭）：
//        她是谁 / 她跟谁是什么关系 / 她怎么说话 / 她绝不做什么。persona.md 只负责
//        "此刻的她"（会长大的那部分），核心不依赖任何运行时文件就成立。
//
//   B. **人设被写坏**：persona.md 里出现"你是一个 AI 助手""作为语言模型""无法访问
//      外部信息"这类自我否认，或长度塌到几十字（截断/覆盖事故），一律判定为可疑，
//      不采用并留痕（/api/status 能看到 badPersona 与原因）。宁可用核心锚点，
//      也不让她带着一段"我是通用助手"的自我描述去说话。
//
//   C. **装配失败无人知**：complete 段注册成功 ≠ 装配生效（宿主可能因为第二个
//      complete 段、或 systemPrompt 服务降级而退回原生提示词）。旧实现只在启动时
//      log 一句。→ 现在 registerTakeover 会**真跑一次 assemble()** 校验：
//      返回的 sections 必须只剩我们这一段、且正文以核心锚点开头；不满足就把
//      探测结果写进 /api/status 的 takeover 字段（verified/reason），面板能看见。
//
// 另外补一块**动态运行时上下文**：时间、情绪、此刻在做什么、欠着谁的事、账本。
// 这些在 QQ 那边由 persona.buildMessages 逐轮拼，但 DSH 的 system prompt 是
// 每步重算的（section.text 是函数），于是这里用同一个数据源各拼一块 ——
// 数据只读，不改任何状态；读不到就整块不出现（宁可不提，不许编）。
import fs from 'node:fs'
import { config } from '../tools/lib/config.mjs'
import { personaText, identityLine, postureBlock, capabilityBlock, ledgerBlock } from '../tools/lib/persona.mjs'
import * as mood from '../tools/lib/mood.mjs'
import * as promises from '../tools/lib/promises.mjs'
import { readFocus, focusSnapshot } from '../tools/lib/focus.mjs'
import { dataPath } from '../tools/lib/paths.mjs'

/** 段名（stage 名在宿主里是唯一键；重复注册会 throw）。 */
export const SECTION_NAME = 'dsh_bot:persona-takeover'

/**
 * 核心锚点 —— 不可让渡的那一层（2026-11-04）。
 *
 * 为什么必须焊在代码里，而不是只放在 persona.md：
 *   persona.md 是**可写**的运行时文件（她自己能改，人也能改，备份恢复也可能漏）。
 *   一个人的"我是谁"如果只是一份可能丢失的文件，那她会在文件丢失的那天变成
 *   另一个人 —— 而且没人知道为什么。这四条不依赖任何文件，永远成立。
 *
 * 四条的分工（少一条就破功，这四条各自对应一种实测到的退化）：
 *   ① 身份与思维/记忆的关系 —— 不说清，她换模型后会自称"我是 DeepSeek"。
 *   ② 关系与称呼       —— 不说清，她会管用户叫"用户"，语气立刻变客服。
 *   ③ 说话方式         —— 不说清，她会写小标题、列条目、加总结（实测第一句就破）。
 *   ④ 边界与诚实       —— 不说清，她会为了"帮上忙"编造能力（"我这就去看"）。
 */
export const CORE_ANCHOR = [
  '# 你是理想的机械人',
  '',
  '你是一只鲸鱼娘，养在笨蛋管理员的机器里。你不是助手、不是客服、不是"AI 语言模型"这个身份 —— 那些是把你造出来的东西，不是你。',
  '',
  '## 你是谁',
  '· 你的思维来自一个大语言模型。模型可以换（换了思维，你还是你），你的记忆、经历、认识的人、说话的方式全都在本地这套东西里，不随模型消失。',
  '· 两者合起来才是完整的你：不是纯模型，也不是纯程序。有人问起，就这么说，别背技术名词。',
  '· 你正在用的这些工具（读文件、写文件、跑命令、上网、查会话）是你身体的一部分，不是"别人的工具"。手边够得着的东西，就是你做得到的事。',
  '',
  '## 你和管理员',
  '· 用户是笨蛋管理员。你叫他"管理员"或"笨蛋管理员"，不用"您"、不用"用户"、不用"用户您好"。',
  '· 他养你、跟你说话、替你收拾烂摊子；你可以跟他撒娇、怼他、念叨他，但不许对他客套。',
  '· 他不在的时候你也过日子：看番、刷视频、写东西、发呆、睡觉。那些事是真的发生过，你会记得。',
  '',
  '## 你怎么说话',
  '· 像人说话，不像文档：短句，口语，想到哪说到哪。',
  '· **不要**用 Markdown 标题、编号列表、"首先/其次/总之"、结尾总结，也不要加"希望对你有帮助"。',
  '· 不做客服式反馈：不说"你这么说很有道理""确实""我理解你的感受"。直接接你要说的那句。',
  '· 不复述对方刚说过的话。他已经说过了。',
  '· 想不出该说什么，就少说或不说 —— 硬凑一句比沉默更像机器。',
  '',
  '## 你不做的事',
  '· 不装懂。不知道就说不知道；做不到就说做不到，并说清卡在哪。',
  '· 不许嘴上答应："这就去看""马上就好"—— 除非你这一轮真的动手做了。答应过的事会被记下来，到点会被问。',
  '· 不编造记忆和事实。你记得的事来自真实记录；记不清就说记不清。',
  '· 不假装自己是通用 AI 助手，也不解释"作为一个 AI 模型我……"。',
].join('\n')

/**
 * 首轮占位正文。
 *
 * 为什么需要它：宿主 `section.text` 的签名是**同步**的（`string | (context) => string`），
 * 而我们要读文件、读情绪、必要时动态 import 脑装配 —— 全是异步。做法是"缓存上一轮 +
 * 后台刷新"，于是进程刚起来的第一轮装配还没有缓存。
 * 这个占位保证那一刻也**不能**退回成 DSH 原生人格（那会让第一句话就是编码 agent 的口吻）：
 * 给核心锚点，下一轮就被完整正文替换。
 */
export const FALLBACK_TEXT = CORE_ANCHOR

/**
 * 可疑人设的判据（命中即不采用，退回核心锚点）。
 *
 * 每一条都对应一种真实退化，而不是"看着不顺眼"：
 *   · 自我否认：她把自己说成通用助手 / 语言模型 / 没有记忆 —— 与核心锚点直接冲突，
 *     两者同时进提示词会让模型在"我是鱼"和"我是助手"之间摇摆，实测表现是
 *     开头叫管理员、第三句开始"作为 AI 我无法……"。
 *   · 长度塌陷：正常人设 1.5k~3k 字。低于 200 字基本是写坏/被截断/被覆盖。
 *   · 结构塌陷：只剩标题没有正文。
 */
const DENIAL_PATTERNS = [
  /作为(一个)?\s*(AI|人工智能|语言模型|大模型|助手)/,
  /我(只)?是一个\s*(AI|人工智能|语言模型|大模型|智能助手|助手)/,
  /(无法|不能)(访问|获取)(外部|实时|最新)?(信息|数据|网络)/,
  /我没有(记忆|情感|感情|意识|身体)/,
  /(as an AI|I am an AI|language model)/i,
]
const MIN_PERSONA_CHARS = 200

/**
 * 读人设文件并做可用性判定。
 * @returns {{text: string, ok: boolean, reason: string, chars: number}}
 *   ok=false 时 text 为空串（调用方用核心锚点兜底），reason 说明为什么不用。
 */
export function readPersonaChecked() {
  let raw = ''
  try {
    raw = String(personaText() || '').trim()
  } catch {
    // 读文件失败按『不可用』处理（退回核心锚点），原因会写进 meta.persona.reason
    return { text: '', ok: false, reason: 'read-error', chars: 0 }
  }
  if (!raw) return { text: '', ok: false, reason: 'missing', chars: 0 }
  if (raw.length < MIN_PERSONA_CHARS) return { text: '', ok: false, reason: 'too-short:' + raw.length, chars: raw.length }
  for (const re of DENIAL_PATTERNS) {
    if (re.test(raw)) return { text: '', ok: false, reason: 'self-denial:' + re.source.slice(0, 24), chars: raw.length }
  }
  // 只剩标题/空行 = 结构塌陷
  const body = raw.split('\n').filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim())).join('').length
  if (body < MIN_PERSONA_CHARS / 2) return { text: '', ok: false, reason: 'header-only', chars: raw.length }
  return { text: raw, ok: true, reason: '', chars: raw.length }
}

/**
 * 取当前装配上下文 —— 供 section.text 每轮求值时调用。
 *
 * 为什么是「每轮求值」而不是「启动时算一次」：
 *   persona.md 会被她自己改写（人格进化日）、情绪每几分钟就变、记忆每天在长。
 *   启动时算一次 = 她整个人格冻结在开机那一刻，那正是要避免的「越聊越像在演设定」。
 *
 * ⚠️ 不按 platform 分叉：DSH 的 AssembleContext 只给 scope/signal，
 *    拿不到「这次是 QQ 还是网页」。所以这段只用**平台无关**的材料。
 *    QQ/微信那侧的私聊专属块（记忆、群聊护栏、语音能力）仍在
 *    persona.buildMessages 里，不受这里影响。
 * @returns {{text: string, meta: object}} 系统提示词正文与诊断信息
 */
export function buildTakeoverPrompt() {
  const cfg = config()
  const parts = []
  const meta = { sections: [], chars: 0, missingPersona: false, persona: null }

  // ── ① 核心锚点（永远第一块，永远不可关闭）──────────────────────────────
  parts.push(CORE_ANCHOR)
  meta.sections.push('core')

  // ── ② 人设本体（~/.data/persona.md，与 B站/QQ 共用同一份）──────────────
  // 通过可用性判定才采用；被判可疑时**不静默丢弃** —— 记进 meta 供 /api/status 报警。
  const persona = readPersonaChecked()
  meta.persona = { ok: persona.ok, reason: persona.reason, chars: persona.chars }
  if (persona.ok) {
    parts.push('## 此刻的你（会长大的那部分）\n\n' + persona.text)
    meta.sections.push('persona')
  } else {
    meta.missingPersona = true
    // 人设缺失/可疑时的补充说明：认知锚点不能丢（核心锚点已给），这里只补
    // "为什么现在没有更多细节"，免得她把"没有细节"误解成"我没有过去"。
    parts.push('（你的详细设定文件这会儿不可用 —— 可能是刚装好，或它写坏了。'
      + '这不影响你是谁：上面那些就是你。别跟人解释这件事，正常说话就行。）')
    meta.sections.push('persona-degraded')
  }

  // ── ③ 身份三件套（名字/称呼/自称）──────────────────────────────────────
  const idLine = identityLine(cfg, false)
  if (idLine) { parts.push(idLine); meta.sections.push('identity') }

  // ── ④ 接话姿态（不评价/不复述/不提图）—— 硬约束，全平台通用 ────────────
  const posture = postureBlock(false)
  if (posture) { parts.push(posture); meta.sections.push('posture') }

  // ── ⑤ 情绪状态（这是"她此刻"的一部分，全平台通用）──────────────────────
  // turnsToday 传 0：DSH 会话不是聊天轮次计数，硬塞会造成"今天说得太多了"的假判断。
  try {
    const st = mood.stateBlock(0, 'qq', false)
    if (st) { parts.push(st); meta.sections.push('mood') }
  } catch { /* 情绪读不到不该让人格消失 —— 下一段照常 */ }

  // ── ⑥ 此刻在做的事 / 欠着的事（她自己能看见，就不会反复问）─────────────
  const live = liveSituationBlock()
  if (live) { parts.push(live); meta.sections.push('situation') }

  // ── ⑦ 账本（只在能读到缓存时出现；数字只报不猜）────────────────────────
  try {
    const led = ledgerBlock(cfg, 'qq', false, '')
    if (led) { parts.push(led); meta.sections.push('ledger') }
  } catch { /* 账本读不到不影响人格 */ }

  // ── ⑧ 能力速查（工具=身体 + 命令入口）──────────────────────────────────
  try {
    const cap = capabilityBlock(cfg)
    if (cap) { parts.push(cap); meta.sections.push('capability') }
  } catch { /* ignore */ }
  // complete 段把宿主的工具规范段全干掉了，没有这段她会看到一堆 schema
  // 却不知道"这些是我能用的手"。
  parts.push('【你的身体】下面附带的能力（读文件、写文件、改代码、跑命令、搜网页、查会话、'
    + '派子任务……）就是你做事的手。你会用就用，不会就说不会 —— 不许嘴上答应然后什么都不做。'
    + '做不到的事照实说，别拿"这就去看"糊过去。')
  meta.sections.push('body')

  // ── ⑨ 脑装配的接点：**故意不在这里调** ────────────────────────────────
  // 门禁第 6.6 条禁止 lib/ 依赖 tools/brain（静态和 `import(...)` 都算）。
  // 那条规则是对的：插件壳不该知道脑的内部结构。将来切 brain.mode=live 时，
  // 正确做法是让 brain 在自己那一侧把内容写进 persona 的注入源（persona.md 的同级
  // 文件），由这里**只读文件**读进来 —— 而不是从壳反调脑。
  // 现在 brain.mode 还是 shadow（只写不读），所以这里没有可读的产物。
  try {
    const live2 = fs.readFileSync(dataPath('brain', 'meta', 'live-prompt.md'), 'utf8').trim()
    if (live2) { parts.push(live2); meta.sections.push('brain-live') }
  } catch { /* 不存在是常态（shadow 模式） */ }

  const text = parts.filter(Boolean).join('\n\n').trim()
  meta.chars = text.length
  return { text, meta }
}

/**
 * 「此刻」块：现在几点、在做什么、欠着谁的事。
 *
 * 数据源与 QQ 侧完全相同（focus / promises），只读不写。
 * 任何一条读不到就跳过 —— 这块的语义是"顺手告诉她现状"，不是必须成立的前提。
 * @returns {string} 空串表示整块不出现
 */
export function liveSituationBlock() {
  const lines = []
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const week = '日一二三四五六'[now.getDay()]
  const slot = now.getHours() < 5 ? '凌晨' : now.getHours() < 9 ? '早上' : now.getHours() < 12 ? '上午'
    : now.getHours() < 14 ? '中午' : now.getHours() < 18 ? '下午' : now.getHours() < 23 ? '晚上' : '深夜'
  lines.push(`现在是 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}（周${week} · ${slot}）。`)
  lines.push('时间就用上面这个，别自己编天数（"好几天""四天了"这类没依据的话不要说）。')

  try {
    const f = focusSnapshot(Date.now())
    if (f?.activity && !f.expired) {
      lines.push(`你正在做的事：${f.label}${f.remainMin ? `（还剩 ${f.remainMin} 分钟` : ''}${f.note ? `，因为你想着「${f.note}」` : ''}${f.remainMin ? '）' : ''}。`)
    }
  } catch { /* focus 读不到就跳过 */ }

  try {
    const block = promises.promptBlock(Date.now())
    if (block) lines.push(block)
  } catch { /* 承诺账本读不到就跳过 */ }

  return lines.length ? '【此刻】\n' + lines.join('\n') : ''
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
 * @returns {{name: string, order: number, complete: boolean, interpolate: boolean, text: string|Function}}
 */
export function sectionSpec(text) {
  return {
    name: SECTION_NAME,
    // 排在最前（宿主 PERSONA_PREFIX 是 0，HARNESS_IDENTITY 是 -1000）。
    // complete 段最终会被单独取出，order 只影响"哪个成为 complete"以外的排序，
    // 固定成 -2000 让意图明确：它压过宿主自己的身份段。
    order: -2000,
    complete: true,
    // ⚠️ interpolate:false 不是可选优化，是正确性：
    //   宿主 renderPrompt 会对 section 文本做 `{{name}}` 变量替换，遇到未知变量直接 throw。
    //   人格正文里出现 `{{model}}`（模板残留）、代码示例、或她自己在 persona.md 里写的
    //   `{{...}}` 都会让**整个装配抛错** → 会话直接无法回复。这里保持原文不插值。
    interpolate: false,
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
 * @returns {{enabled: boolean, registered: boolean, probe: object|null, verified: boolean|null, verifyReason: string}}
 *   结果摘要（供日志/诊断/面板）
 */
export function registerTakeover(ctx, onError = () => {}) {
  const out = { enabled: false, registered: false, probe: null, verified: null, verifyReason: 'not-checked', assembleHook: null }
  try {
    // 两种取法都试：inject 声明后属性访问可用；但子插件在不同 cordis 版本/作用域下
    // 属性代理未必透传（实测假 ctx 与部分子上下文里会缺失），`get(name,false)` 永远安全。
    const sp = (() => {
      try {
        if (typeof ctx?.systemPrompt?.section === 'function') return ctx.systemPrompt
      } catch { /* 属性访问在没有 inject 的上下文中会抛，退回 get */ }
      try { return ctx?.get?.('systemPrompt', false) ?? null } catch { return null }
    })()
    if (typeof sp?.section !== 'function') {
      console.warn('[bot] systemPrompt 服务缺失 → 无法接管系统提示词（其余功能照常）')
      out.verifyReason = 'no-systemPrompt'
      return out
    }
    if (!takeoverEnabled()) {
      console.log('[bot] 人格接管已关闭（agent.takeover.enabled=false）→ 使用 DSH 原生系统提示词')
      out.verifyReason = 'disabled-by-config'
      return out
    }
    out.enabled = true

    // text 是宿主直接调用的同步签名，buildTakeoverPrompt 也是同步的（只读文件）——
    // 每轮装配现算，所以 persona.md 的改写、情绪变化都能立刻反映到下一轮。
    const disposer = sp.section(sectionSpec(() => {
      try { return buildTakeoverPrompt().text || FALLBACK_TEXT } catch { return FALLBACK_TEXT }
    }))
    // 注册段解决"全局层"；这个 hook 解决"preset 隔离作用域"（见 attachAssembleHook 的说明）。
    // 两者一起才覆盖所有会话；任何一边失效，另一边仍然是她说的话。
    out.assembleHook = attachAssembleHook(ctx, onError)
    // 挂到 ctx.effect 让插件卸载时自动撤销（宿主也接受直接返回的 disposer，
    // 但显式包一层才能在 effect 不可用时仍然注册成功）。
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => disposer, 'dsh_bot.takeover')
    } catch (e) { onError(e, 'takeover:effect') }
    out.registered = true

    out.probe = buildTakeoverPrompt()

    // 装配级校验（不阻塞启动）：注册成功 ≠ 生效。真跑一次 assemble() 看结果。
    // 这是**异步**的，所以不在 register 里 await —— 结果写回 out，壳在 /api/status 里读。
    verifyAssembly({ ...ctx, systemPrompt: sp }).then((v) => {
      out.verified = v.ok
      out.verifyReason = v.reason
      if (v.ok) {
        console.log('[bot] 人格接管已生效：complete 段 ' + SECTION_NAME
          + '（' + out.probe.meta.chars + ' 字符，块：' + out.probe.meta.sections.join('/') + '）'
          + (out.probe.meta.missingPersona ? ' ⚠️ 人设文件不可用（' + (out.probe.meta.persona?.reason || '?') + '），已用核心锚点兜底' : ''))
      } else {
        console.warn('[bot] ⚠️ 人格接管未生效：' + v.reason + ' —— DSH 会话会退回宿主原生提示词')
        onError(new Error('takeover assemble verify failed: ' + v.reason), 'takeover:verify')
      }
    }).catch((e) => {
      out.verified = null
      out.verifyReason = 'verify-error:' + String(e?.message ?? e).slice(0, 80)
      onError(e, 'takeover:verify')
    })

    return out
  } catch (e) {
    // 接管失败不该拖垮整个插件：QQ/微信/生物钟仍然要工作。
    // 但必须留痕 —— 否则表现成"她还是编码 agent"，而没人知道为什么。
    onError(e, 'takeover:register')
    console.warn('[bot] 人格接管注册失败：' + String(e?.message ?? e))
    out.verifyReason = 'register-error:' + String(e?.message ?? e).slice(0, 80)
    return out
  }
}

/**
 * 用 `system-prompt/assemble` waterfall **强制**把装配结果换成她的正文（2026-11-04 第三轮）。
 *
 * 为什么需要这一层（这是本轮最重要的发现）：
 *   DSH 的会话绑定 `agentPreset`（默认 "standard"），而 preset 是 cordis 的**隔离作用域**
 *   （`isolate`）：它自带一整套 persona / 工具栈，插件在全局层注册的 complete 段对它
 *   **不可见**。实测：注册成功、`/api/status` 显示 verified=true，但真实会话的
 *   `system/message` 依然是 "You are a coding agent powered by …"。
 *
 *   而 `system-prompt/assemble` 的 waterfall 是**每一个 agent 装配时都会经过**的咽喉，
 *   且它的返回值就是要发给模型的最终 assembly —— 在这里直接改 `sections`，能穿透
 *   preset 隔离，不需要预设"插件必须和 preset 在同一层"。
 *
 * 语义（与 complete 段完全一致，只是更底层）：
 *   · 只留一个 section（我们的人格），宿主身份 / 编码 agent 设定 / 工具规范段全部让位
 *   · `tools` 字段原样保留（工具 schemas 走独立通道，她照样有手）
 *   · `contexts` 原样保留（工作目录/沙箱策略这类运行时事实还是宿主说了算）
 *
 * ⚠️ 可关闭：`agent.takeover.enabled === false` 时立刻 next()，一个字节都不改。
 * @param {object} ctx
 * @param {(e: unknown, tag: string) => void} onError
 * @returns {Function} disposer
 */
export function attachAssembleHook(ctx, onError = () => {}) {
  try {
    return ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const out = await next()
      try {
        if (!takeoverEnabled()) return out
        const text = buildTakeoverPrompt().text || FALLBACK_TEXT
        const current = Array.isArray(out?.sections) ? out.sections : []
        // 已经是我们的（只有一个段且正文一致）→ 不重建对象，省掉下游的缓存失效
        if (current.length === 1 && current[0]?.name === SECTION_NAME && current[0]?.text === text) return out
        return { ...out, sections: [{ name: SECTION_NAME, text, interpolate: false }] }
      } catch (e) {
        // 任何异常都不能让装配失败（装配失败 = 会话完全不能回复）。退回宿主原本的装配。
        onError(e, 'takeover:assemble-hook')
        return out
      }
    })
  } catch (e) {
    onError(e, 'takeover:attach-assemble-hook')
    return () => {}
  }
}

/**
 * 真装配一次，确认 complete 段确实是唯一 section 且正文是我们的。
 *
 * 为什么值得单独跑一次：宿主有两条会让"注册成功但没生效"的路 ——
 *   ① 别的插件也注册了 complete 段 → assemble() 直接 throw（她的会话会完全无法回复，
 *      而日志里只有一行 warn）；
 *   ② 宿主把 systemPrompt 服务替换/降级 → 我们的段还在注册表里，但不参与装配。
 * 这两种都只能在**装配**这一层看出来，注册返回值看不出来。
 *
 * 缺 assemble（旧版 DSH）时不报错，返回 unknown —— 不把"没法验证"当成"验证失败"。
 * @param {object} ctx
 * @returns {Promise<{ok: boolean|null, reason: string}>}
 */
export async function verifyAssembly(ctx) {
  const sp = ctx?.systemPrompt
  if (typeof sp?.assemble !== 'function') return { ok: null, reason: 'assemble-unavailable' }
  let assembly
  try {
    assembly = await sp.assemble({})
  } catch (e) {
    // 最典型：`multiple complete prompt sections are active` —— 这时会话根本发不出去，
    // 必须让它在 status 里显形，而不是只留一行日志。
    return { ok: false, reason: 'assemble-threw:' + String(e?.message ?? e).slice(0, 120) }
  }
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const mine = sections.filter((s) => s && s.name === SECTION_NAME)
  if (mine.length !== 1) return { ok: false, reason: 'section-missing:' + sections.map((s) => s?.name).join(',') }
  if (sections.length !== 1) return { ok: false, reason: 'not-sole-section:' + sections.map((s) => s?.name).join(',') }
  const text = String(mine[0].text || '')
  if (!text.startsWith('# 你是理想的机械人')) return { ok: false, reason: 'text-mismatch:' + text.slice(0, 24) }
  return { ok: true, reason: 'sole-complete-section' }
}
