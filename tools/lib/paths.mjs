// 统一路径解析 —— dabot 私享版。
// 设计来自 dsh-bili-whale 的 tools/lib/paths.mjs（MIT），路径前缀改为 bot。
//
// 两个 home 的语义（与 bili-whale 一致，避免分叉）：
//   · DSH_HOME  —— DSH 的根（配置、会话、night 状态）
//   · HOME      —— 用户主目录（凭据、账本、记忆、情绪等"随人走"的东西放 ~/.data）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE）。 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：与宿主半边 (lib/index.js) 完全一致的解析顺序。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** DSH home 下的路径。 */
export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)

/** 用户主目录下的路径。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 插件配置文件（BOT_CONFIG 可覆盖）。不含凭据。 */
export const configPath = process.env.BOT_CONFIG || dshPath('bot.config.json')

/** 数据目录：凭据 / 账本 / 记忆 / 情绪（换机器时整个拷走）。
 *  ⚠️ 测试一定要隔离：`BOT_DATA_DIR` 或把 USERPROFILE 指到临时目录都行。
 *  10-27 的教训：有测试只设了自定义变量、没设 USERPROFILE，结果把真记忆库写成两条假数据。 */
// 10-31：调试模式必须显式隔离，否则一行 env 就能把测试数据写进她的真实记忆。
// BOT_DEBUG=1 且没给 BOT_DATA_DIR → 抛错（宁可启动就吵，也别污染）。
const __DEBUG = process.env.BOT_DEBUG === '1' || process.env.BOT_DEBUG === 'true'
if (__DEBUG && !process.env.BOT_DATA_DIR) {
  throw new Error('BOT_DEBUG 已开启，但没设 BOT_DATA_DIR —— 拒绝用真实记忆库跑调试（会污染她的记忆）。请设一个临时目录。')
}
/**
 * 数据目录 —— 2026-11-02 改名 .bot-ai → .data
 *
 * ⚠️ 兼容规则（**不是临时补丁，是长期策略**）：
 *   新目录 .data 优先；老的 .bot-ai 如果还在就继续用。
 *   理由：这次改名动了 1.1G 的真实记忆，如果哪天回滚或者有人从旧备份恢复，
 *   程序**不应该因为找不到目录就当成第一次运行**（那会重新生出一套空记忆，
 *   看起来一切正常，实际她的过去全丢了）。宁可连老目录，也不能认错"我是新的"。
 *
 * 环境变量 BOT_DATA_DIR 仍然最优先（测试隔离要用它）。
 * 名字保留 FEIYU_ 前缀不改 —— 那是**测试已经写死的约定**，
 * 改它要动所有 test/*.mjs，收益为零。
 */
const _dataCandidates = () => {
  const out = []
  if (process.env.BOT_DATA_DIR) out.push(path.resolve(process.env.BOT_DATA_DIR))
  out.push(homePath('.data'))
  out.push(homePath('.bot-ai'))     // 旧目录兜底
  return out
}

export const dataDir = (() => {
  const cands = _dataCandidates()
  if (process.env.BOT_DATA_DIR) return cands[0]
  for (const d of cands) {
    try { if (fs.existsSync(d)) return d } catch { /* 底层兜底：这里不能依赖上层 swallow（会循环依赖），错误在此终止是设计 */ }
  }
  return cands[0]                      // 都不存在 → 用新的
})()
export const dataPath = (...parts) => path.join(dataDir, ...parts)

/** 凭据（与配置分离；0600；永不回显）。 */
export const credentialsPath = dataPath('credentials.json')

/** 她的会话工作目录（专用小目录，别用用户主目录 ✗ —— bili-whale Issue #6 的教训）。 */
export const WORK_DIR = dshPath('bot-work')

/** 生物钟状态文件。 */
export const nightStatePath = dshPath('bot-night.json')

/** 两本日记（工作目录下，人随时能打开看）。 */
export const diaryPath = (book) => path.join(WORK_DIR, book === 'private' ? 'bot-diary-private.md' : 'bot-diary.md')
