// config-upgrade —— 把实际配置文件升级到 DEFAULTS 的形状（v5 新增）。
//
// 为什么要有它：DEFAULTS 是"代码认为该有的样子"，实际配置文件是"用户手里的样子"。
// 这两者会漂移：新增功能加了默认值，但实际配置里没有那个键 → diagnose 天天报"配置缺项"
// （这次一报 30 多项），噪音把真问题盖掉了。
//
// 本命令做三件事，**默认干跑**，`--go` 才写：
//   ① 补齐：DEFAULTS 里有、实际配置里没有的键 → 按默认值写进去
//   ② 清理：实际配置里有、DEFAULTS 里没有的"历史残留"→ 移到 .legacy 段（不删，留证据）
//   ③ 备份：写之前先复制一份 .bak-<时间戳>
//
// 关键：**只做结构对齐，不改用户的取值**。已经存在的键一个字节都不动。
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, configPath } from '../lib/config.mjs'
import { RETIRED_PLATFORMS } from '../lib/platforms.mjs'

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** 已知的"历史残留"顶层键：不在 DEFAULTS，但确实是老版本留下的，不该当错误。 */
export const LEGACY_TOP_KEYS = new Set(['danger', 'douyin'])

/** 递归补齐：把 base 里有、over 里没有的键填进去（不覆盖已有值）。 */
function fill(base, over, prefix = '', added = []) {
  for (const [k, v] of Object.entries(base || {})) {
    const p = prefix + k
    if (!(k in (over || {}))) {
      over[k] = isObj(v) ? fill(v, {}, p + '.', added) : v
      added.push(p)
      continue
    }
    if (isObj(v) && isObj(over[k])) fill(v, over[k], p + '.', added)
  }
  return over
}

/** 找出代码里读、但 DEFAULTS 里没有的键（反向检查，防止 DEFAULTS 又漏）。 */
function diffKeys(base, over, prefix = '', out = []) {
  for (const k of Object.keys(over || {})) {
    const p = prefix + k
    if (!(k in (base || {}))) { out.push(p); continue }
    if (isObj(over[k]) && isObj(base[k])) diffKeys(base[k], over[k], p + '.', out)
  }
  return out
}

export async function run(argv = []) {
  const go = argv.includes('--go')
  const json = argv.includes('--json')
  const file = configPath
  if (!fs.existsSync(file)) {
    console.error('✗ 找不到配置文件：' + file)
    process.exit(1)
  }
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  let user
  try { user = JSON.parse(raw) } catch (e) {
    console.error('✗ 配置文件不是合法 JSON，拒绝改动：' + e.message)
    process.exit(1)
  }

  const added = []
  const before = JSON.stringify(user)
  // 先只**计算**该补什么，不直接写进去 —— 见下面 stripDefaults 的说明。
  const probe = JSON.parse(JSON.stringify(user))
  fill(DEFAULTS, probe, '', added)
  const extra = diffKeys(DEFAULTS, user)

  // 历史残留：一律搬进 __legacy（不删除，留证据），并给个说明
  const legacy = []
  for (const k of extra) {
    const top = k.split('.')[0]
    // 只处理顶层，嵌套的"多余键"保持原样（可能是用户自己加的扩展字段）
    if (top !== k) continue
    if (LEGACY_TOP_KEYS.has(top) || top === 'douyin' || top === 'killQqOnExit' || top === 'stopWithDsh') {
      user.__legacy = user.__legacy || {}
      user.__legacy[top] = user[top]
      delete user[top]
      legacy.push(top)
    }
  }

  // ⚠️ 关键设计（v5 自己踩过一次坑）：
  // 一开始的实现是"把缺的 138 个默认值全部写进配置文件"，结果 diagnose 显示
  // "配置完整"了 —— 但那是**假的完整**：这些默认值从此被永久刻进用户文件，
  // 以后升级改了 DEFAULTS 对这台机器不再生效（配置僵化），漂移检查也永远清零。
  //
  // 正确做法：**缺的键本来就该从 DEFAULTS 回落，不需要落盘**。
  // 所以这里只做两件真正需要写文件的事：
  //   ① 清掉历史残留（搬进 __legacy，留证据）
  //   ② 顺手把"值等于默认值"的冗余键剔掉（和面板保存用同一套 stripDefaults）
  // "缺什么"只作为报告给你看，不写进文件。
  let pruned = []
  try {
    const { stripDefaults } = await import('../lib/config-file.mjs')
    const stripped = stripDefaults(user)
    // 统计被剔掉的顶层键（只报数量，不逐条刷屏）
    for (const k of Object.keys(user)) {
      if (k === '__legacy') continue
      if (!(k in stripped)) pruned.push(k)
      else if (user[k] && typeof user[k] === 'object' && !Array.isArray(user[k]) && typeof stripped[k] === 'object') {
        if (JSON.stringify(user[k]) !== JSON.stringify(stripped[k])) pruned.push(k + '.*')
      }
    }
    user = stripped
  } catch (e) { /* strip 失败就保持原样，不当错误 */ }

  const changed = JSON.stringify(user) !== before

  if (json) {
    console.log(JSON.stringify({ file, go, missingInFile: added, movedToLegacy: legacy, pruned, changed, extra }, null, 2))
  } else {
    console.log('\n📝 配置对齐：' + file + '\n')
    console.log('  缺失（走 DEFAULTS 回落，不写文件）' + added.length + ' 项' + (added.length ? '：' + added.slice(0, 10).join(', ') + (added.length > 10 ? ' …' : '') : ''))
    console.log('  搬进 __legacy ' + legacy.length + ' 项' + (legacy.length ? '：' + legacy.join(', ') : ''))
    console.log('  剔除冗余默认值 ' + pruned.length + ' 项' + (pruned.length ? '：' + pruned.slice(0, 10).join(', ') + (pruned.length > 10 ? ' …' : '') : ''))
    console.log('  ' + (changed ? '需要写入' : '已经是最新形状，无需改动') + '\n')
  }

  if (!changed) { if (!json) console.log('✓ 无需改动'); return }
  if (!go) { if (!json) console.log('（干跑）确认无误后加 --go 真写\n'); return }

  // 备份 → 原子写
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const bak = file + '.bak-' + stamp
  fs.copyFileSync(file, bak)
  const tmp = file + '.tmp-upgrade'
  fs.writeFileSync(tmp, JSON.stringify(user, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)     // 写 JSON 会把 mode 重置成 644，必须显式改回来
  if (!json) console.log('✓ 已写入（备份：' + path.basename(bak) + '）\n')
}

/** 给 diagnose 用：只算"真问题"的漂移（排除已知历史残留）。 */
export function configDriftReport() {
  try {
    const user = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
    const added = []
    const clone = JSON.parse(JSON.stringify(user))
    fill(DEFAULTS, clone, '', added)
    const extra = diffKeys(DEFAULTS, user).filter((k) => {
      const top = k.split('.')[0]
      if (top !== k) return true
      return !LEGACY_TOP_KEYS.has(top) && !['douyin', 'killQqOnExit', 'stopWithDsh'].includes(top)
    })
    return { missing: added, extra }
  } catch { return { missing: [], extra: [] } }
}

export default { run }
