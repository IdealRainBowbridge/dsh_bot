import * as W from './tools/lib/watchlog.mjs'
W.reset()
const cases = [
  '一口气看完【可塑性记忆】，记忆是可塑性的，回忆是永恒的',
  '【全748集】目前B站最全最细的Agent开发零基础全套教程，2026最新版',
  '可塑性记忆',
  '【绝无鬼畜】X.H.传说中羊狼战争就是他们吗？【东方喜洋洋】',
]
const now = Date.now()
for (const c of cases) W.record({ show: c, ep: 1, title: c, plot: '测试剧情' + c.slice(0,10), ok: true, at: now })
for (const s of W.recentShows({ now, limit: 10 })) console.log('  →', s.name)
W.reset()
