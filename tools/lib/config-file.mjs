// config-file —— 配置的"读—改—写"唯一入口（v5 从 lib/index.js 抽出）。
//
// 为什么抽出：这几段逻辑（读、剔默认值、原子写、600 权限）是**安全相关**的，
// 却埋在 1100 行的插件壳主闭包里，既没法单测，也只能被面板用。
// 抽出来之后：面板、诊断、CLI 全走同一份实现，改一处全生效。
import fs from 'node:fs'
import path from 'node:path'
import { config as readToolConfig, DEFAULTS } from './config.mjs'
import { configPath } from './paths.mjs'
import { swallow } from './swallow.mjs'

/**
 * 读配置：**必须**经过 DEFAULTS 深合并，不能只返回用户文件。
 *
 * 旧写法（v5 前）lib/index.js 直接 `JSON.parse(fs.readFileSync(configPath))`，
 * 用户配置缺键时返回残缺对象：20 多处 `cfg.qq?.startWithDsh === true` 全部落到
 * "undefined ≠ true" 的分支 —— 行为看着对，其实是默认值没生效。
 */
export function readConfigFile() {
  try { return readToolConfig() } catch { return {} }
}

/**
 * 只保留"用户显式设置过的值"，剔掉与 DEFAULTS 完全相同的键。
 *
 * 为什么：把整份合并后的配置写回去，等于把默认值永久刻进用户文件 ——
 * 以后升级改了默认值，这台机器永远不会跟着变（配置僵化），
 * diagnose 的"配置缺项"也从此永远清零、再也发现不了漂移。
 */
export function stripDefaults(cfg, base = DEFAULTS) {
  const out = {}
  for (const [k, v] of Object.entries(cfg || {})) {
    if (k.startsWith('__')) continue          // 内部标记（__hasUserFile / __legacy 除外）
    if (k === '__legacy') { out[k] = v; continue }
    const b = base?.[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      const sub = stripDefaults(v, b)
      if (Object.keys(sub).length) out[k] = sub
      continue
    }
    const same = (Array.isArray(v) || v === null || typeof v !== 'object')
      ? JSON.stringify(v) === JSON.stringify(b)
      : false
    if (!same) out[k] = v
  }
  return out
}

/**
 * 原子写配置：临时文件 → chmod 600 → rename。
 *
 * 为什么 chmod：`fs.writeFileSync` 建的新文件默认 644，而配置里有 QQ token / API key。
 * 以前每次面板保存都把 600 冲成 644（门禁抓过、diagnose 也报过）。
 * @returns {{ok:boolean, file:string, bytes?:number, error?:string}}
 */
export function writeConfigFile(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    let payload = cfg
    try { payload = stripDefaults(cfg) } catch (e) { swallow(e, 'config-file:strip') }
    const temp = configPath + '.' + process.pid + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    try { fs.chmodSync(temp, 0o600) } catch { /* 某些 FS 不支持，忽略 */ }
    fs.renameSync(temp, configPath)
    try { fs.chmodSync(configPath, 0o600) } catch { /* ignore */ }
    return { ok: true, file: configPath, bytes: Buffer.byteLength(JSON.stringify(payload)) }
  } catch (e) {
    swallow(e, 'config-file:write')
    return { ok: false, file: configPath, error: String(e?.message || e) }
  }
}

/** 配置文件的权限是否安全（diagnose 用）。 */
export function configPerm() {
  try { return fs.statSync(configPath).mode & 0o777 } catch { return null }
}
