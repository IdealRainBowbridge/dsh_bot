/**
 * "像人"的两条硬指标：分条发 + 不带客服腔。
 * 跑法：node test/qq-human-test.mjs
 */
import assert from 'node:assert/strict'
import { splitBubbles } from '../tools/commands/qq-server.mjs'
import { clean } from '../tools/lib/guard.mjs'

// 1) 短短一句就是一条，不硬拆
assert.deepEqual(splitBubbles('嗯，我在。'), ['嗯，我在。'])
assert.deepEqual(splitBubbles(''), [])

// 2) 中等长度（40 字左右）→ **一条就够**（10-31 调参：以前 42 字硬切，观感像刷屏）
const three = splitBubbles('网络坏了啊。你先看看路由器，拔了插一下。要是还不行就重启光猫。')
assert.ok(three.length >= 1 && three.length <= 2, '40 字左右不该拆成 3 条，实际 ' + JSON.stringify(three))
assert.ok(three.every(s => s.trim()), '不允许空气泡：' + JSON.stringify(three))
assert.ok(three.every(s => s.length <= 90), '单条不该太长：' + JSON.stringify(three))

// 2b) 真正长的一段才拆（>68 字）—— 用够长的语料，别用 56 字冒充长的
const reallyLong = '网络坏了啊。你先看看路由器，拔了插一下试试。要是还不行就重启光猫，等两分钟再看。再不行就打运营商客服问一下线路，顺便问问是不是片区故障，他们那边能查到。'
assert.ok(reallyLong.length > 68, '测试语料本身要超过阈值，实际 ' + reallyLong.length)
const rl = splitBubbles(reallyLong)
assert.ok(rl.length >= 2, '超过 68 字应该拆条，实际 ' + JSON.stringify(rl))
assert.ok(rl.every(s => s.trim()), '长段拆条不允许空气泡')

// 3) 唠叨一大段 → 最多 3 条（宁可最后一条长一点，也不刷屏）
const long = Array(8).fill('这是一句用来测试分条的话。').join('')
const capped = splitBubbles(long)
assert.ok(capped.length <= 4, '最多四条（10-31: 3→4），实际 ' + capped.length)
assert.ok(capped.join('').includes('这是一句用来测试分条的话'), '内容不能丢')

// 4) 没有句号的**超长**句才按逗号兜底切（51 字不该切 —— 10-31 阈值 68）
const shortNoStop = '我今天中午吃了红烧肉，然后看了一会儿视频，后来困得不行就睡了，醒来发现天都黑了，锅里还剩了半碗饭没吃完'
assert.equal(splitBubbles(shortNoStop).length, 1, '51 字不该拆：' + JSON.stringify(splitBubbles(shortNoStop)))

const longNoStop = shortNoStop + '，吃完我又坐了一会儿，想着明天还得早起上班，就早点收拾了，结果躺下之后又睡不着，翻来覆去快两点才迷糊过去'
assert.ok(longNoStop.length > 68, '测试语料要超过阈值，实际 ' + longNoStop.length)
const noStop = splitBubbles(longNoStop)
assert.ok(noStop.length >= 2, '超长无句号要按逗号兜底切：' + JSON.stringify(noStop))

// 5) 英文/无标点不崩
assert.ok(splitBubbles('hello world this is a long sentence without any punctuation at all').length >= 1)

// 6) 客服腔/AI 腔要清掉
assert.equal(clean('好的，希望这能帮到你。'), '好的，')
assert.equal(clean('总的来说，你先看看路由器吧。'), '你先看看路由器吧。')
assert.equal(clean('作为一个AI，我不能确定。'), '我不能确定。')
assert.equal(clean('如果你还有其他问题，随时问我。'), '')
assert.equal(clean('嗯，我在。'), '嗯，我在。', '正常聊天不该被误伤')

console.log('qq-human ✓  分条发送/AI腔清洗 通过')
console.log('  示例：', JSON.stringify(three))
