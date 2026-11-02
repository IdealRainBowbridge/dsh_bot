// selfcon -- 自我账本 CLI (批二)
//   node bot.mjs selfcon show          看她认下的自己 (账本 + 重建稿, 体检用)
//   node bot.mjs selfcon introspect    白天照一次镜子 (只采集, 不结算)
import * as selfcon from '../brain/organ/selfcon.mjs'
import { dayIntrospect } from '../brain/organ/selfcon-day.mjs'

export async function run(argv = []) {
  const sub = String(argv[0] || 'show')
  if (sub === 'introspect') {
    const r = await dayIntrospect({ now: Date.now() })
    console.log('[selfcon] ' + r.summary + (r.proposals ? ' (+' + r.proposals + ' 候选)' : ''))
    return
  }
  console.log(selfcon.statusLine())
  console.log('')
  console.log(selfcon.block({ now: Date.now() }) || '(账本为空)')
  console.log('')
  console.log('load = ' + selfcon.load().toFixed(2))
}
