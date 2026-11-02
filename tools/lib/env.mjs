// lib/env —— 环境变量兼容层（2026-11-02 改名 FEIYU_ → BOT_）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要有这一层，而不是直接 sed 替换
// ══════════════════════════════════════════════════════════════════════
// 改名要动 16 个变量、26 处 DATA_DIR、25 处 CONFIG…… 全在测试里。
// 直接 sed 有两个风险：
//   ① 漏改一处 → 那个测试读到**真实数据目录** → 污染她的 1.1G 记忆
//      （历史上真发生过：10-27 有测试把假数据写进了真记忆库）
//   ② 外部脚本 / 我自己的运维命令还写着 FEIYU_* → 静默失效
//
// 所以统一走这一层：**新名优先，旧名兜底**。
// 好处是这次改名可以分批做 —— 改到一半的系统仍然是能跑的，
// 而不是"要么全改完要么全挂"。
//
// 旧名不会再被写入（set 时用新名），只是**能读**。
// 这样新旧混用时期行为可预期：谁设了新名，新名说了算。

const ALIAS = {
  // 数据与配置
  DATA_DIR: 'DATA_DIR',
  HOME: 'HOME',                 // 注意：这是 BOT_HOME，不是系统 HOME
  CONFIG: 'CONFIG',
  ROOT: 'ROOT',
  CLI: 'CLI',
  MJS: 'MJS',                   // 指向 tools/bot.mjs（旧 bot.mjs）
  NODE: 'NODE',
  PYTHON: 'PYTHON',
  // 开关
  DEBUG: 'DEBUG',
  NO_CACHE: 'NO_CACHE',
  TEST_SKIP_LEDGER: 'TEST_SKIP_LEDGER',
  BRAIN_MIRROR: 'BRAIN_MIRROR',
  // 服务
  PROXY: 'PROXY',
  INBOUND_TOKEN: 'INBOUND_TOKEN',
  BROWSER_URL: 'BROWSER_URL',
  TTS_PYTHON: 'TTS_PYTHON',
  ASR_PROXY_OK: 'ASR_PROXY_OK',
}

/**
 * 读一个环境变量。
 * @param {string} name 短名（不含前缀），例如 'DATA_DIR'
 * @param {string} [def] 默认值
 */
export function env(name, def = '') {
  const k = String(name || '').toUpperCase()
  const v1 = process.env['BOT_' + k]
  if (v1 !== undefined && v1 !== '') return v1
  const v2 = process.env['FEIYU_' + k]
  if (v2 !== undefined && v2 !== '') return v2
  return def
}

/** 是否设置了（新名或旧名都算）。 */
export function hasEnv(name) {
  const k = String(name || '').toUpperCase()
  const v1 = process.env['BOT_' + k]
  if (v1 !== undefined && v1 !== '') return true
  const v2 = process.env['FEIYU_' + k]
  return v2 !== undefined && v2 !== ''
}

/** 写环境变量（只写新名，再把旧名同步上，兼容还没改完的读端）。 */
export function setEnv(name, value) {
  const k = String(name || '').toUpperCase()
  process.env['BOT_' + k] = String(value)
  process.env['FEIYU_' + k] = String(value)      // 兼容尚未改名的读端
  return value
}

export const KEYS = Object.keys(ALIAS)
