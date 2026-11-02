import * as A from './tools/brain/assemble.mjs'
import { config } from './tools/lib/config.mjs'
// 模拟一次私聊装配
const r = await A.assemble({
  platform: 'qq',
  chatId: 'qq:3682285116',
  userId: '3682285116',
  userText: '你最近在看什么？',
  now: Date.now(),
})
const sys = r.messages[0]?.content || ''
console.log('system 总长:', sys.length)
const i = sys.indexOf('【我在B站看了什么】')
console.log('槽位出现位置:', i)
if (i >= 0) {
  console.log('--- 槽位内容 ---')
  console.log(sys.slice(i, i + 500))
} else {
  console.log('!!! 槽位没进 system')
}
console.log('\n--- 所有槽位标题 ---')
console.log([...sys.matchAll(/【[^】]{2,20}】/g)].map(m=>m[0]).join(' '))
