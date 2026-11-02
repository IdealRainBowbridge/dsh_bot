// bond-rehearse —— 再巩固桥（2026-11-03）：watchlog 记录看番 → 想起与谁的旧事 → bond 微刷新。
//
// 为什么隔一层：watchlog 直接 import bond 也可以，但这里要做的是「按线索词召回旧事」，
// 需要另外几个依赖（memory/roster），而 watchlog 的 record() 是热路径 —— 隔一层文件，
// 让失败和 import 成本都困在旁路里。
import { swallow } from './swallow.mjs'
import * as memory from './memory.mjs'
import * as roster from './roster.mjs'
import * as bond from './bond.mjs'

/** 看番行到达时调。返回刷新了几段旧记忆。 */
export function record({ title = '', show = '', now = Date.now() } = {}) {
  try {
    const q = String(title || show || '').trim()
    if (!q) return 0
    const hits = memory.recall(q, 2, 7)
    if (!hits.length) return 0
    const names = roster.list({ limit: 120 })
      .map((p) => String(p.alias || p.name || '').trim())
      .filter(Boolean)
    if (!names.length) return 0
    let n = 0
    for (const h of hits) {
      const who = names.find((nm) => h.includes(nm))
      if (!who) continue
      const card = names.length && roster.list({ limit: 120 }).find((p) => (p.alias || p.name) === who)
      if (!card) continue
      if (bond.rehearse(card.platform, card.userId, { now })) n++
    }
    return n
  } catch (e) { swallow(e, 'bond-rehearse:record'); return 0 }
}
