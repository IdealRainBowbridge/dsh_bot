// selfcon -- 自我账本 CLI (批二)
//   node bot.mjs selfcon show          看她认下的自己 (账本 + 重建稿, 体检用)
//   node bot.mjs selfcon introspect    白天照一次镜子 (只采集, 不结算)
import * as selfcon from '../brain/organ/selfcon.mjs'
import { dayIntrospect } from '../brain/organ/selfcon-day.mjs'

/** chatFn: 用她自己的通道 (llm.chat) 提炼主张候选。失败由 selfcon-day 的 swallow 兜住,
 *  退化为纯盘点 (只采集计数, 不出候选) -- 宁可少产出, 不编造。 */
async function chatFn(messages) {
  const { chat } = await import('../lib/llm.mjs')
  return chat(messages, { maxTokens: 300, temperature: 0.8 })
}

export async function run(argv = []) {
  const sub = String(argv[0] || 'show')
  if (sub === 'introspect') {
    const r = await dayIntrospect({ now: Date.now(), chatFn })
    console.log('[selfcon] ' + r.summary + (r.proposals ? ' (+' + r.proposals + ' 候选)' : ''))
    return
  }
  console.log(selfcon.statusLine())
  console.log('')
  console.log(selfcon.block({ now: Date.now() }) || '(账本为空)')
  console.log('')
  console.log('load = ' + selfcon.load().toFixed(2))
}
