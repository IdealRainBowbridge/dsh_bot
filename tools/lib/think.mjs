// tools/lib/think.mjs —— 「先想后说」的执行体
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要单独一个文件
// ══════════════════════════════════════════════════════════════════════
// 这段逻辑本来直接塞进了 qq-server 的回复链里。门禁立刻拦住了（1807 行 > 1750）。
//
// 门禁拦得对，而且拦出了一个**结构上更正确的分法**：
//   这段东西的输入是（他说的话 + 她心里的念头 + 她的身体状态），输出是（一句心里话）。
//   它不碰 socket、不碰 OneBot、不碰发送 —— **它根本不是编排层的事**。
//   留在 qq-server 里等于把"她想什么"和"怎么发出去"焊死在一起。
//
// 拆出来还多拿到三件东西：
//   ① 可以单独测（不启动 qq-server 就能验"她会不会先想一遍"）
//   ② 别的通道（B站评论、群聊插话）可以直接复用同一套内省
//   ③ qq-server 回到它自己的欠账额度以内
//
// ══════════════════════════════════════════════════════════════════════
// 这一层的形状（为什么不是一次生成）
// ══════════════════════════════════════════════════════════════════════
// 一次生成 =「针对这句话，写一个最合适的回答」= 客服的动作。
// 人的顺序是：看见 → 心里浮起一个反应（可以烦、可以走神、可以不想理）
//            → 那个反应被掂量（要不要说、说到哪）→ 才组织成话出口
//
// 所以做成两次往返：① introspect() 只产"心里话"，
//                  ② speak() 把"心里话"当作**她自己的念头**喂回去再生成真正要说的话。
//
// 关键：第②步里那段内心话是"我记得我刚才是这么想的"，不是"请按照下面要求回答"。
// 这个区别决定了她是"有个人在里面"还是"一个执行器"。
//
// 成本取舍（也有生理依据）：累到极点（cognitiveDepth 低）时不内省 —— 人累急了本来就不先想；
// 群聊不内省 —— 群里的反应本来就浅。这不是省 token，是把资源用在对的地方。
import { swallow } from './swallow.mjs'

/** 内省的开关与阈值。放这里而不是 config：它是"结构参数"，不是用户偏好。 */
export const RULES = {
  minDepth: 0.45,        // 低于这个脑力就不先想了
  maxThoughtChars: 200,  // 心里话再长就是她在写作文
  temp: 1.05,            // 内省用更高温度：想事情本来就发散
  maxTokens: 90,
  timeoutMs: 9000,
}

/**
 * 她现在心里会怎么想这句话。
 * @returns {Promise<{thought:string, used:boolean, depth:number}>}
 */
export async function introspect({ userText = '', chatId = '', isGroup = false, llm = null, log = () => {}, now = Date.now() } = {}) {
  const LLM = llm || await import('./llm.mjs')
  const F = await import('../brain/field.mjs')
  const IN = await import('../brain/inner.mjs')

  const depth = F.cognitiveDepth(now)
  if (isGroup || depth <= RULES.minDepth) return { thought: '', used: false, depth }

  const thoughtBlock = IN.innerBlock(2, now)
  const ask = [{
    role: 'user',
    content:
      '你现在就是她本人（不是助手，不是旁白）。\n' +
      '下面是他刚说的话，还有你心里原本转着的事。\n' +
      '请你只输出**你心里冒出来的第一反应**，不要写给人看的句子。\n' +
      '规则：\n' +
      '- 一到两句，口语，可以碎，可以不耐烦，可以自相矛盾\n' +
      '- 不要有礼貌，不要照顾他的情绪，不要解释\n' +
      '- 不要用引号，不要写"我想："这种前缀\n' +
      '- 如果你其实不太想理他 / 不知道说什么，就照实写出来\n\n' +
      thoughtBlock +
      '\n\n他说：「' + String(userText || '').slice(0, 300) + '」',
  }]

  let raw = ''
  try {
    raw = String(await LLM.chat(ask, {
      temperature: RULES.temp, max_tokens: RULES.maxTokens,
      timeoutMs: RULES.timeoutMs, purpose: 'fast',
    }) || '').trim().slice(0, RULES.maxThoughtChars)
  } catch (e) {
    swallow(e, 'think:introspect')
    return { thought: '', used: false, depth }
  }
  if (!raw) return { thought: '', used: false, depth }

  // ── 落地三件事（顺序不能换）────────────────────────────────────
  // ① 原文进流：不裁、不摘要。这是"她当时心里到底怎么想的"的唯一证据。
  try { IN.stream({ role: 'self', kind: 'think', text: raw, meta: { chat: chatId } }, now) } catch { }
  // ② 进念头池：想说没说的会压着，攒成 tension（闭合回路）
  try { IN.think(raw, { kind: 'urge', about: 'owner', now }) } catch { }
  // ③ 想的时候情绪会动 —— 想到难受的事，人不会毫无反应
  try {
    if (/(烦|累|不想|难受|算了|随便|没意思|懒得)/.test(raw)) F.poke('valence', -0.06, { why: 'inner:neg', now })
    else if (/(好|想|喜欢|开心|有意思)/.test(raw)) F.poke('valence', 0.05, { why: 'inner:pos', now })
  } catch { }

  log('[qq] 💭 心里想的（不外发）：' + raw.slice(0, 50))
  return { thought: raw, used: true, depth }
}

/**
 * 把"心里想的"交还给她，让她决定说什么。
 *
 * 注意措辞：这是**回忆**（"你刚才心里想的是"），不是指令（"请按照…回答"）。
 * 这个区别是整层的关键 —— 指令会让她表演，回忆会让她承认自己有过那个念头。
 */
export async function speak(messages, thought, o = {}) {
  const th = String(thought || '').trim()
  if (!th) return ''
  const msgs = (messages || []).map((m) => ({ ...m }))
  if (!msgs.length) return ''
  const last = msgs[msgs.length - 1]
  const tail = typeof last.content === 'string' ? last.content : ''
  msgs[msgs.length - 1] = {
    role: 'user',
    content: tail +
      '\n\n【你刚才心里想的是】\n' + th +
      '\n\n（上面那句是**你自己**的念头，别复述它、别承认自己在"想过了"。' +
      '现在照它来决定怎么回：想理就理，不想理就敷衍一句，' +
      '心里有别的事也可以直接岔过去。**别把它说得比他这句话还长。**）',
  }
  try {
    if (o.chatWithTools) {
      const r = await o.chatWithTools(msgs, { temperature: o.temperature, purpose: o.purpose || 'chat' })
      return r?.text || ''
    }
    const llm = o.llm || await import('./llm.mjs')
    return String(await llm.chat(msgs, { temperature: o.temperature, purpose: o.purpose || 'chat' }) || '')
  } catch (e) {
    swallow(e, 'think:speak')
    return ''
  }
}

/**
 * 完整的一轮：想 → 说。给编排层一个调用点，别再让 qq-server 铺开写。
 * @returns {Promise<{text:string, thought:string, used:boolean, depth:number}>}
 */
export async function thinkThenSay({ messages, userText, chatId, isGroup, dynTemp, toolsOn, chatWithTools, llm, log }) {
  const it = await introspect({ userText, chatId, isGroup, llm, log })
  if (!it.used) return { text: '', thought: '', used: false, depth: it.depth }
  const text = await speak(messages, it.thought, {
    llm, chatWithTools: toolsOn ? chatWithTools : null, temperature: dynTemp,
  })
  return { text, thought: it.thought, used: true, depth: it.depth }
}
