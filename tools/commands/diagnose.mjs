// diagnose —— 环境/配置/权限的"一次说清"（10-31）。
//
// 为什么要有它：这套系统的失效方式几乎全是**静默**的 —— 配置项没写进实际文件、
// 面板开关不控制行为、探活探错地址、账本漏掉一条通道。每一条都不报错。
// 这个命令把这些"看不见的错"一次性摊开，她和人都能一眼看到。
//
//   node feiyu.mjs diagnose           # 人读
//   node feiyu.mjs diagnose --json    # 机器读（面板/自动化用）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { configPath, dataPath, credentialsPath, WORK_DIR, dshPath } from '../lib/paths.mjs'
import { config, DEFAULTS } from '../lib/config.mjs'

const ok = (n, d = '') => ({ name: n, ok: true, detail: d })
const bad = (n, d = '') => ({ name: n, ok: false, detail: d })
const warn = (n, d = '') => ({ name: n, ok: null, detail: d })

/** 把 DEFAULTS 与用户配置的键做差集（只比顶层 + 一层嵌套）。 */
function configDrift() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return { missing: [], extra: [] } }
  const cmp = (base, over, prefix = '') => {
    const missing = []
    for (const k of Object.keys(base || {})) {
      const p = prefix + k
      if (!(k in (over || {}))) { missing.push(p); continue }
      const b = base[k], o = over[k]
      if (b && o && typeof b === 'object' && !Array.isArray(b) && typeof o === 'object' && !Array.isArray(o)) {
        missing.push(...cmp(b, o, p + '.'))
      }
    }
    return missing
  }
  const missing = cmp(DEFAULTS, user)
  const extra = Object.keys(user).filter((k) => !(k in DEFAULTS))
  return { missing, extra }
}

/** 检查几个"配了但没生效"的高危组合。 */
function behaviorMismatches(cfg) {
  const out = []
  // 面板开关 vs 真实行为
  if (cfg.platforms?.qq === false && cfg.qq?.enabled === true) {
    out.push('platforms.qq=false 但 qq.enabled=true —— 以前 qq-server 不读 platforms，会照常收发（已在 10-31 修）')
  }
  // 账本盲区
  const hasFallback = !!(cfg.llm?.fallback && (cfg.llm.fallback.model || cfg.llm.fallback.base_url))
  if (cfg.llm?.base_url && !hasFallback) {
    out.push('llm.fallback 没配 —— 主通道一挂，QQ/微信/抖音/主动搭话全部哑火（llm.mjs 的 fallback 逻辑形同虚设）')
  }
  // 沙箱
  const presets = (() => { try { return JSON.parse(fs.readFileSync(dshPath('feiyu-perm.json'), 'utf8')) } catch { return null } })()
  if (!presets) out.push('没有 feiyu-perm.json —— 插件会在第一次唤醒时自动钉权限；如果面板显示"被沙箱拦住"，点「修复记忆写入」')
  return out
}

export async function run(argv = []) {
  const json = argv.includes('--json')
  const cfg = config()
  const items = []

  // 1) 配置漂移
  const drift = configDrift()
  if (drift.missing.length) items.push(warn('配置缺项', drift.missing.slice(0, 30).join(', ') + (drift.missing.length > 30 ? ' …' : '') + ' —— 这些走 DEFAULTS；新增功能记得同步写进实际配置'))
  else items.push(ok('配置完整', '实际配置覆盖了全部 DEFAULTS 键'))
  if (drift.extra.length) items.push(warn('配置多出', drift.extra.join(', ') + ' —— 不在 DEFAULTS 里，可能是历史残留或手写错误'))

  // 2) 行为不一致
  for (const m of behaviorMismatches(cfg)) items.push(bad('行为不一致', m))

  // 3) 敏感文件权限
  for (const [p, want] of [[configPath, 0o600], [credentialsPath, 0o600]]) {
    try {
      if (!fs.existsSync(p)) continue
      const mode = fs.statSync(p).mode & 0o777
      items.push(mode & 0o077 ? bad('权限过宽', p + ' mode=' + mode.toString(8) + '（应 ' + want.toString(8) + '）') : ok('权限正确', p))
    } catch (e) { items.push(warn('权限检查失败', p + '：' + e.message)) }
  }

  // 4) 三条 LLM 通道 & 记账
  const directLog = dataPath('llm-usage.jsonl')
  items.push(fs.existsSync(directLog)
    ? ok('直连记账', directLog + '（' + fs.statSync(directLog).size + ' 字节）')
    : warn('直连记账', '还没有记录 —— 下次 QQ/微信/抖音 聊天后会有（10-31 新增）'))

  // 5) 空 catch 留痕日志
  const sw = dataPath('logs', 'swallowed.log')
  items.push(fs.existsSync(sw)
    ? ok('吞错留痕', sw + '（' + fs.statSync(sw).size + ' 字节）')
    : ok('吞错留痕', '还没有被吞掉的错误'))

  // 6) 容器/沙箱
  const inDocker = fs.existsSync('/.dockerenv')
  items.push(ok('运行环境', (inDocker ? '容器内' : '宿主机') + ' · ' + process.platform + ' · node ' + process.version))

  if (json) { console.log(JSON.stringify({ items }, null, 2)); return }
  console.log('\n🔎 体检（静默失效专项）\n')
  for (const it of items) {
    const mark = it.ok === true ? '✓' : it.ok === false ? '✗' : '·'
    console.log('  ' + mark + ' ' + String(it.name).padEnd(12) + ' ' + (it.detail || ''))
  }
  const bads = items.filter((x) => x.ok === false)
  console.log('\n' + (bads.length ? '✗ ' + bads.length + ' 项要处理' : '✓ 没有发现静默失效') + '\n')
}
