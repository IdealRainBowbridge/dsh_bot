// brain-health —— /health 里的脑摘要（2026-11-03 从 qq-server.mjs 原样拆出：
// 该文件顶到门禁 1750 行上限）。只读小摘要，别在这里跑 doctor。
//
// brain 由调用方传进来（qq-server 持有 brain/index 的命名空间导入）——
// 本文件不 import 脑层，不制造 lib→brain 反向依赖。
import { config } from './config.mjs'

export function brainHealth(brain) {
  try {
    const b = config().brain || {}
    return {
      mode: b.mode || 'shadow',
      episodes: brain.episode.allEpisodes().length,
      intents: brain.intents.stats(),
      backlog: brain.event.backlog(),
      today: brain.metrics.today(),
    }
  } catch (e) { return { error: String(e?.message || e) } }
}
