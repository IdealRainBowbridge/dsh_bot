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
  // 10-31：fallback 支持链式（数组）。任一有效级别都算"有备份"。
  const fbRaw = cfg.llm?.fallback ?? cfg.llm?.fallbacks ?? null
  const fbList = Array.isArray(fbRaw) ? fbRaw : (fbRaw ? [fbRaw] : [])
  const usable = fbList.filter((x) => x && typeof x === 'object' && x.model && (x.api_key || x.base_url || cfg.llm?.api_key || cfg.llm?.base_url))
  if (cfg.llm?.base_url && !usable.length) {
    out.push('llm.fallback 没配（或没有有效级别）—— 主通道一挂，QQ/微信/抖音/主动搭话全部哑火')
  } else if (cfg.llm?.base_url && usable.length === 1) {
    out.push('llm.fallback 只有 1 级 —— 单级链首选失败即无退路，建议至少 2 级（同网关可配不同模型）')
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

  // 4) LLM 通道：链有几级、有没有被熔断的、推理模型是否配错
  let llmMod = null
  try { llmMod = await import('../lib/llm.mjs') } catch {}
  if (llmMod) {
    try { items.push(ok('LLM 通道', llmMod.describe())) } catch {}
    try {
      const snap = llmMod.breakerSnapshot()
      const open = snap.filter((x) => x.openUntil)
      if (open.length) {
        for (const b of open) {
          items.push(bad('通道熔断', b.level + ' 连续失败 ' + b.fails + ' 次，冷却到 ' + new Date(b.openUntil).toLocaleTimeString('zh-CN') + '（最后错误：' + b.lastError + '）'))
        }
      } else if (snap.length) {
        items.push(warn('通道异常记录', snap.map((x) => x.level + ' ×' + x.fails).join('、') + ' —— 未到熔断阈值'))
      } else {
        items.push(ok('通道熔断', '无（所有通道健康）'))
      }
    } catch {}
    // 推理模型配成"非推理"会在 max_tokens 小时返回空正文 —— 提前点出来
    try {
      const cfg2 = config()
      const chain = [cfg2.llm, ...(Array.isArray(cfg2.llm?.fallback) ? cfg2.llm.fallback : (cfg2.llm?.fallback ? [cfg2.llm.fallback] : []))].filter(Boolean)
      const risky = chain.filter((x) => {
        if (typeof x.reasoning === 'boolean') return false
        return /^(kimi|hy3|o1|o3|o4|qwq|deepseek-r)/i.test(String(x.model || ''))
      })
      if (risky.length) {
        items.push(warn('推理模型未声明', risky.map((x) => x.model).join('、') + ' —— 看起来是推理型，建议显式写 reasoning:true（否则 max_tokens 小时会返回空正文）'))
      } else items.push(ok('推理模型声明', '链上模型都不需要特殊处理'))
    } catch {}
  }
  const directLog = dataPath('llm-usage.jsonl')
  items.push(fs.existsSync(directLog)
    ? ok('直连记账', directLog + '（' + fs.statSync(directLog).size + ' 字节）')
    : warn('直连记账', '还没有记录 —— 下次 QQ/微信/抖音 聊天后会有（10-31 新增）'))

  // 5) 空 catch 留痕日志
  const sw = dataPath('logs', 'swallowed.log')
  items.push(fs.existsSync(sw)
    ? ok('吞错留痕', sw + '（' + fs.statSync(sw).size + ' 字节）')
    : ok('吞错留痕', '还没有被吞掉的错误'))

  // 5.2) 协议适配：中转网关会不会丢 system 角色（10-31 实测 a2a 会丢）
  try {
    const cfg3 = config()
    const keep = cfg3.llm?.systemRole === 'keep'
    const chain = [cfg3.llm, ...(Array.isArray(cfg3.llm?.fallback) ? cfg3.llm.fallback : [])].filter(Boolean)
    const allKeep = chain.length > 0 && chain.every((x) => x.systemRole === 'keep')
    items.push(allKeep
      ? ok('协议适配', '所有通道都保留 system 角色（供应商支持）')
      : ok('协议适配', (keep ? '主通道' : '') + 'system 已折叠进 user —— a2a 网关会丢弃 system 角色（10-31 实测），不折叠等于人格不生效'))
  } catch (e) { items.push(warn('协议适配', '检查失败：' + e.message)) }

  // 5.3) 记忆库卫生：重复率 + 认人错标
  try {
    const epFile = dataPath('brain', 'ep', new Date().toISOString().slice(0, 7) + '.jsonl')
    if (fs.existsSync(epFile)) {
      const rows = fs.readFileSync(epFile, 'utf8').trim().split('\n').filter(Boolean)
      const seen = new Map()
      let dups = 0, ownerBad = 0
      for (const l of rows) {
        let j; try { j = JSON.parse(l) } catch { continue }
        const key = (j.where?.platform || '') + '|' + String(j.gist || '').slice(0, 48)
        const prev = seen.get(key)
        // 只算"机械重复"：同 key 在 5 分钟内再次写入（重连/重放/双写）。
        // 隔半小时又刷到同一条视频是真实经历，不该算脏数据。
        if (prev !== undefined && Math.abs(Number(j.at) - prev) < 5 * 60_000) dups++
        seen.set(key, Number(j.at))
        if (j.where?.platform !== 'qq' && j.where?.platform !== 'wechat' && j.where?.platform !== 'douyin-dm'
            && j.who?.others?.some((o) => o.kind === 'owner')) ownerBad++
      }
      const rate = rows.length ? dups / rows.length : 0
      items.push(rate > 0.10
        ? bad('记忆卫生', rows.length + ' 条里 ' + dups + ' 条重复（' + (rate * 100).toFixed(0) + '%）—— 会污染召回并白烧 token')
        : ok('记忆卫生', rows.length + ' 条 · 重复 ' + dups + ' 条'))
      items.push(ownerBad
        ? bad('认人错误', ownerBad + ' 条外部事件被标成「主人」（平台名不匹配的老 bug 残留）')
        : ok('认人正确', '外部事件没有被误标成主人'))
    }
  } catch (e) { items.push(warn('记忆卫生', '检查失败：' + e.message)) }

  // 5.5) DSH 集成契约（升级 DSH 后第一眼看这里）
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    const decl = pkg?.dshFeiyu || {}
    let runtime = null
    try { runtime = JSON.parse(fs.readFileSync('/opt/dsh/package.json', 'utf8')) } catch {}
    if (runtime) {
      const same = runtime.version === String(decl.testedAgainst || '').split('@').pop()
      items.push(same
        ? ok('DSH 契约', '运行时 ' + runtime.name + '@' + runtime.version + ' · 契约版本 ' + (decl.contractVersion || '?') + '（与实测版本一致）')
        : warn('DSH 契约', '运行时 ' + runtime.name + '@' + runtime.version + '，插件只在 ' + (decl.testedAgainst || '?') + ' 上实测过 —— 建议跑一遍全量测试'))
    } else items.push(warn('DSH 契约', '读不到 /opt/dsh/package.json（非 DSH 环境？）'))
  } catch (e) { items.push(warn('DSH 契约', '检查失败：' + e.message)) }

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
