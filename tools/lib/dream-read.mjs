// 梦的读取端（lib 层）—— 只读、不写、不调模型。
//
// 10-31 分层修正：persona.mjs（lib）以前从 ../commands/dream.mjs（命令层）import
// dreamToMention()，属于 lib → commands 的反向依赖。任何只装配 persona 的场景
// （测试、CLI、脑装配）都会把整条 dream 命令链连带拉进来。
// 这里只保留"读到什么"的部分；"怎么写梦"仍在 commands/dream.mjs。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { readJsonl } from '../brain/json.mjs'

const DREAMS = () => dataPath('dreams.jsonl')
const NL = String.fromCharCode(10)

/** 最近 n 条梦（新的在后）。文件不存在/损坏时返回 []。 */
export function recentDreams(n = 10) {
  try { return readJsonl(DREAMS(), { limit: n }) } catch { return [] }
}

/**
 * 取一条"还没在聊天里提过"的梦，并原子地把它标记为 consumed。
 * 没有可提的梦时返回 null（调用方就别硬聊梦）。
 */
export function dreamToMention() {
  const all = recentDreams(5)
  const d = all.find((x) => !x.consumed)
  if (!d) return null
  try {
    const lines = fs.readFileSync(DREAMS(), 'utf8').trim().split(NL)
    const idx = lines.findIndex((l) => l.includes('"at":' + d.at))
    if (idx >= 0) {
      const o = JSON.parse(lines[idx])
      o.consumed = true
      lines[idx] = JSON.stringify(o)
      const tmp = DREAMS() + '.' + process.pid + '.tmp'
      fs.writeFileSync(tmp, lines.join(NL) + NL)
      fs.renameSync(tmp, DREAMS())      // 原子替换：以前直接写，半截文件会毁掉全部梦
    }
  } catch {}
  return d
}

/** 梦的文件路径（给写端用）。 */
export const dreamsPath = () => DREAMS()
