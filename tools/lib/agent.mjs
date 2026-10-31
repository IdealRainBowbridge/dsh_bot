// 带工具的多轮对话循环（10-31）—— 她"真的能动手"的那一层。
//
// 为什么需要单独一层：llm.chat() 是单次请求；工具调用需要
//   模型 → 要调工具 → 我执行 → 结果回灌 → 模型再说
// 这个循环最多几轮（防死循环），每轮都落记忆。
import { CHAT_TOOLS, runTool } from './tools.mjs'
import * as llm from './llm.mjs'
import { swallow } from './swallow.mjs'

const MAX_ROUNDS = 4          // 最多 4 轮工具调用（再多就是模型在绕圈）
const TOOL_TIMEOUT_MS = 130000

/**
 * 带工具的 chat。
 * @param {Array} messages 初始 messages（含 system，会被 fold 进 user）
 * @param {object} opts { purpose, temperature, maxTokens, onToolResult }
 * @returns {Promise<{text:string, tools:Array<{name,args,ok,result}>}>}
 */
export async function chatWithTools(messages, opts = {}) {
  const used = []
  let msgs = [...messages]
  // 是否启用工具：默认开，可用 opts.tools === false 关掉
  const enableTools = opts.tools !== false
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      purpose: opts.purpose || 'chat',
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      tools: enableTools ? CHAT_TOOLS : undefined,
      toolChoice: enableTools ? 'auto' : undefined,
      timeoutMs: TOOL_TIMEOUT_MS,
    }
    let r
    try {
      r = await llm.chatRaw(msgs, body)
    } catch (e) {
      // 没有 chatRaw 就退回普通 chat（不支持工具，但不至于整轮失败）
      swallow(e, 'agent:chatRaw')
      const text = await llm.chat(msgs, body)
      return { text, tools: used }
    }
    const msg = r?.message || {}
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const content = String(msg.content ?? '').trim()

    // 没有工具调用 → 结束
    if (!calls.length) {
      return { text: content || String(r?.text || ''), tools: used }
    }

    // 有工具调用：把 assistant 消息（含 tool_calls）加进历史，再逐个执行
    msgs = [...msgs, { role: 'assistant', content: content || '', tool_calls: calls }]
    for (const c of calls) {
      const name = String(c?.function?.name || '')
      let args = {}
      try { args = JSON.parse(String(c?.function?.arguments || '{}')) } catch (e) { swallow(e, 'agent:parse-args') }
      const res = await runTool(name, args)
      used.push({ name, args, ok: res.ok, result: String(res.result || '').slice(0, 400) })
      msgs.push({
        role: 'tool',
        tool_call_id: String(c.id || ''),
        content: String(res.result || (res.ok ? '完成' : '失败')).slice(0, 3000),
      })
      try { opts.onToolResult?.(name, args, res) } catch (e) { swallow(e, 'agent:onToolResult') }
    }
    // 继续下一轮，让模型根据工具结果说话
  }
  // 轮数用完：强制要一句收尾（不再给工具）
  try {
    const text = await llm.chat(msgs, { purpose: opts.purpose || 'chat', max_tokens: 400, tools: false })
    return { text, tools: used }
  } catch (e) {
    swallow(e, 'agent:final')
    return { text: used.length ? '（做完了，但没来得及说）' : '（这次没接上）', tools: used }
  }
}
