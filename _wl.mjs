import * as W from './tools/lib/watchlog.mjs'
W.reset()
console.log('初始:', JSON.stringify(W.stats()))

const now = Date.now()
W.record({ show: '可塑性记忆', ep: 1, bvid: 'BV1aa', title: '可塑性记忆 第1集',
  plot: '司进入机器人回收公司，与艾拉成为搭档，第一次回收老夫妇的"儿子"。',
  feel: '看完心里堵得慌。', via: '台词356句', durMin: 53, ok: true, at: now - 3*3600_000 })
W.record({ show: '可塑性记忆', ep: 2, bvid: 'BV1bb', title: '可塑性记忆 第2集',
  plot: '回收妮娜，老婆婆不肯放手，妮娜劝奶奶笑着送别。',
  feel: '妮娜那句趁现在大家笑着告别，我看得心里堵。', via: '台词400句', durMin: 24, ok: true, at: now - 2*3600_000 })
W.record({ show: '可塑性记忆', ep: 3, bvid: 'BV1cc', title: '可塑性记忆 第3集',
  plot: '这条看不到剧情', feel: '', via: '只有简介', durMin: 24, ok: false, at: now - 1*3600_000 })

console.log('统计:', JSON.stringify(W.stats()))
console.log('最近在看的:', W.recentShows({ now }).map(s => `${s.name}(第${s.lastEp}集/${s.episodes}集)`).join(', '))
console.log('\n===== 注入区块 =====')
console.log(W.promptBlock({ now }))
console.log('\n===== 边界：72 小时外 =====')
console.log('空:', JSON.stringify(W.promptBlock({ now: now + 100*3600_000 })))
W.reset()
