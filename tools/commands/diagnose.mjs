// diagnose —— 环境/配置/权限的"一次说清"（10-31）。
//
// 为什么要有它：这套系统的失效方式几乎全是**静默**的 —— 配置项没写进实际文件、
// 面板开关不控制行为、探活探错地址、账本漏掉一条通道。每一条都不报错。
// 这个命令把这些"看不见的错"一次性摊开，她和人都能一眼看到。
//
//   node bot.mjs diagnose           # 人读
//   node bot.mjs diagnose --json    # 机器读（面板/自动化用）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { configPath, dataPath, credentialsPath, WORK_DIR, dshPath } from '../lib/paths.mjs'
import { config, DEFAULTS } from '../lib/config.mjs'
import { swallow } from '../lib/swallow.mjs'
import { immuneSnapshot } from '../lib/immune.mjs'
import { woundSnapshot } from '../lib/wound.mjs'

const ok = (n, d = '') => ({ name: n, ok: true, detail: d })
const bad = (n, d = '') => ({ name: n, ok: false, detail: d })
const warn = (n, d = '') => ({ name: n, ok: null, detail: d })

/**
 * 她其实绑在哪个地址上。
 *
 * 2026-11-02 实测的错值：im-gateway.sh 里 `export QQ_BIND_HOST=0.0.0.0`，于是线上 qq-server
 * 真绑 0.0.0.0；但 diagnose 是**另起一个进程**跑的，读不到那个 env，于是走 `|| '127.0.0.1'`
 * 兜底 → 体检报"绑 127.0.0.1"，与实际不符。体检的价值全在可信，所以这里改成：
 *   ① 有 env 就用 env（同进程场景）
 *   ② 否则问内核：8081 在 /proc/net/tcp 里的 local_address 是 00000000（任意）还是 0100007F（回环）
 *   ③ 都读不到返回 ''，让调用方按"未知"说，别猜
 */
function actualBind() {
  const hexPort = '1F91'   // 8081
  try {
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const rows = fs.readFileSync(f, 'utf8').split('\n').slice(1)
      for (const r of rows) {
        const c = r.trim().split(/\s+/)
        if (c.length < 2) continue
        const [addr, port] = String(c[1]).split(':')
        if (port !== hexPort) continue
        const a = addr.toUpperCase()
        if (a === '00000000' || a === '00000000000000000000000000000000') return '0.0.0.0'
        if (a === '0100007F' || a === '0000000000000000FFFF00000100007F') return '127.0.0.1'
        return '（已监听，地址 ' + addr + '）'
      }
    }
  } catch { /* 非 Linux 或没权限 —— 交给调用方兜底，不猜 */ }
  return ''
}

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
  // __legacy 是 config-upgrade 搬进去的历史残留（有意保留的），
  // 以及 douyin / killQqOnExit / stopWithDsh 这类已知老键 —— 都不算"配置多出"。
  const KNOWN_LEGACY = new Set(['__legacy', 'douyin', 'killQqOnExit', 'stopWithDsh', 'danger'])
  const extra = Object.keys(user).filter((k) => !(k in DEFAULTS) && !KNOWN_LEGACY.has(k))
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
  const presets = (() => { try { return JSON.parse(fs.readFileSync(dshPath('bot-perm.json'), 'utf8')) } catch { return null } })()
  if (!presets) out.push('没有 bot-perm.json —— 插件会在第一次唤醒时自动钉权限；如果面板显示"被沙箱拦住"，点「修复记忆写入」')
  return out
}

/** 沉默是不是真的被记住了（10-31 第九轮）：只看"有内容却没接"的积压量。 */
function skippedStats() {
  try {
    const f = dataPath('skipped-messages.json')
    if (!fs.existsSync(f)) return warn('没接的话', '还没有记录（没人发过"不必回"的话，或还没跑过新的 reply-gate）')
    const list = JSON.parse(fs.readFileSync(f, 'utf8'))
    const now = Date.now()
    const fresh = list.filter((x) => now - Number(x.at || 0) < 12 * 3600_000)
    const pending = fresh.filter((x) => !x.used)
    const oldest = pending.length ? Math.round((now - Math.min(...pending.map((x) => Number(x.at)))) / 3600_000) : 0
    if (pending.length > 20) return bad('没接的话', pending.length + ' 条积压（最久 ' + oldest + ' 小时前）—— 说明他一直在说、她一直没接')
    return ok('没接的话', fresh.length + ' 条 remembered / ' + pending.length + ' 条还没提' + (pending.length ? '（最久 ' + oldest + 'h）' : ''))
  } catch (e) { return warn('没接的话', '读不了 skipped-messages.json：' + String(e?.message ?? e)) }
}

export async function run(argv = []) {
  const json = argv.includes('--json')
  const cfg = config()
  const items = [
    skippedStats(),
  ]

  // 1) 配置漂移
  const drift = configDrift()
  // v5：**缺项不是问题**。配置文件只该写"用户显式改过的值"，其余全部走 DEFAULTS 回落。
  // 旧版把"缺 138 项"当告警天天报，噪音大到把真问题淹了 —— 反而促使人去
  // config-upgrade 把默认值全刻进配置文件，从此升级不再生效（更糟）。
  // 现在只有"配置多出"（不认识的历史残留）才提示。
  if (drift.missing.length) {
    items.push(ok('配置分层', '实际配置 ' + (Object.keys(drift.missing).length ? '部分' : '') + '使用默认值（' + drift.missing.length + ' 项走 DEFAULTS）—— 这是正确的：默认值集中在一处，升级才能全局生效'))
  } else {
    items.push(ok('配置完整', '实际配置覆盖了全部 DEFAULTS 键（也可以只写改过的值）'))
  }
  if (drift.extra.length) items.push(warn('配置多出', drift.extra.join(', ') + ' —— 不在 DEFAULTS 里，可能是历史残留或手写错误（跑 config-upgrade 可搬进 __legacy）'))

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
  try { llmMod = await import('../lib/llm.mjs') } catch (e) { swallow(e, 'diagnose:run') }
  if (llmMod) {
    try { items.push(ok('LLM 通道', llmMod.describe())) } catch (e) { swallow(e, 'diagnose:run') }
    // B1/A2（2026-11-03）：免疫与伤口的状态进体检。
    try {
      const im = immuneSnapshot()
      items.push(ok('免疫系统', '已见 ' + im.seen + ' · 丢弃 ' + im.dropped + ' · 抗原 ' + im.antigens + ' · 发热 ' + im.feverLevel.toFixed(2)))
    } catch (e) { swallow(e, 'diagnose:immune') }
    try {
      const w = woundSnapshot()
      if (w && (w.open || w.infected.length)) {
        items.push(warn('开放伤口', w.infected.length ? ('化脓 ' + w.infected.length + ' 处：' + w.infected.join('、')) : (w.open + ' 处开放（瘢痕 ' + w.scars + ' · 旧伤复发 ' + w.recurrent + '）')))
      } else if (w) {
        items.push(ok('伤口', '无开放损伤（瘢痕 ' + w.scars + ' 条 · 旧伤复发 ' + w.recurrent + ' 次）'))
      }
    } catch (e) { swallow(e, 'diagnose:wound') }
    // B8 内感受（2026-11-03）：容器体征进体检——她的"住处"也是身体的一部分。
    try {
      const vt = (await import('../brain/organ/vitals.mjs')).snapshot()
      if (vt) {
        const cr = vt.crossed || []
        const desc = '盘 ' + vt.diskUsedPct + '%（峰 ' + vt.peakDiskPct + '%）· 负载 ' + vt.loadRatio + (vt.selfMemMB ? ' · 自身 ' + vt.selfMemMB + 'MB' : '')
        if (cr.includes('diskCrit')) items.push(warn('内感受', desc + ' —— 濒满'))
        else if (cr.includes('diskHigh') || cr.includes('diskWarn')) items.push(warn('内感受', desc + ' —— 有点胀'))
        else items.push(ok('内感受', desc))
      }
    } catch (e) { swallow(e, 'diagnose:vitals') }
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
    } catch (e) { swallow(e, 'diagnose:run') }
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
    } catch (e) { swallow(e, 'diagnose:run') }
  }
  const directLog = dataPath('llm-usage.jsonl')
  items.push(fs.existsSync(directLog)
    ? ok('直连记账', directLog + '（' + fs.statSync(directLog).size + ' 字节）')
    : warn('直连记账', '还没有记录 —— 下次 QQ/微信/抖音 聊天后会有（10-31 新增）'))

  // 4.5) 内置浏览器：chromium 在不在（在就能 browser read / browse_page；不在自动落回 curl）
  try {
    const bin = cfg.browser?.chromiumBin || 'chromium'
    let ver = ''
    try { ver = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim() } catch { ver = '' }
    if (ver) {
      const daemon = (() => { try { return JSON.parse(fs.readFileSync(dataPath('browser-daemon.json'), 'utf8')) } catch { return null } })()
      const alive = daemon?.pid && (() => { try { process.kill(daemon.pid, 0); return true } catch { return false } })()
      items.push(ok('内置浏览器', ver + (alive ? '（引擎在跑 pid=' + daemon.pid + '）' : '（引擎随用随起）')))
    } else {
      items.push(warn('内置浏览器', bin + ' 不在 PATH —— browser 命令会自动落回 curl 读静态页；apt install chromium 后恢复'))
    }
  } catch (e) { items.push(warn('内置浏览器', '体检失败：' + e.message)) }

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
    // v5：toISOString 是 UTC —— 东八区每月 1 号 00:00~08:00 会算成"上个月"，
    // 于是 diagnose 去读上个月的脑事件文件（或读不到），记忆卫生检查静默失效。
    // 用本地日期拼。
    const _d = new Date()
    const _ym = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}`
    const epFile = dataPath('brain', 'ep', _ym + '.jsonl')
    if (fs.existsSync(epFile)) {
      const rows = fs.readFileSync(epFile, 'utf8').trim().split('\n').filter(Boolean)
      const seen = new Map()
      let dups = 0, ownerBad = 0
      for (const l of rows) {
        let j; try { j = JSON.parse(l) } catch { continue }
        // 2026-11-02：key 里带上 msgId。两条不同的表情包消息 gist 会退化成
        // 同一句"（QQ 标记为表情包）"，只按 platform+gist 判重会误报成重复。
        const key = (j.where?.platform || '') + '|' + String(j.meta?.msgId || '') + '|' + String(j.gist || '').slice(0, 48)
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
        ? bad('认人错误', ownerBad + ' 条外部事件被标成「用户」（平台名不匹配的老 bug 残留）')
        : ok('认人正确', '外部事件没有被误标成用户'))
    }
  } catch (e) { items.push(warn('记忆卫生', '检查失败：' + e.message)) }

  // 5.5) DSH 集成契约（升级 DSH 后第一眼看这里）
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    const decl = pkg?.dshFeiyu || {}
    let runtime = null
    try { runtime = JSON.parse(fs.readFileSync('/opt/dsh/package.json', 'utf8')) } catch (e) { swallow(e, 'diagnose:dsh-version') }
    if (runtime) {
      const same = runtime.version === String(decl.testedAgainst || '').split('@').pop()
      items.push(same
        ? ok('DSH 契约', '运行时 ' + runtime.name + '@' + runtime.version + ' · 契约版本 ' + (decl.contractVersion || '?') + '（与实测版本一致）')
        : bad('DSH 契约', '运行时 ' + runtime.name + '@' + runtime.version + '，插件只在 ' + (decl.testedAgainst || '?') + ' 上实测过 —— 版本不匹配，先全量测试再上线'))
    } else items.push(warn('DSH 契约', '读不到 /opt/dsh/package.json（非 DSH 环境？）'))
  } catch (e) { items.push(warn('DSH 契约', '检查失败：' + e.message)) }

  // ── v5 新增体检：把"看起来正常、其实已经死了"的链路摊开 ──────────────────

  // 5.6) 入口鉴权：这是最容易被忽略的一项（服务一旦绑 0.0.0.0 就等于门户大开）
  try {
    const token = String(config().qq?.inboundToken || process.env.BOT_INBOUND_TOKEN || '')
    const bind = String(process.env.QQ_BIND_HOST || actualBind() || '127.0.0.1')
    if (token) {
      items.push(ok('入口鉴权', '已设 token（' + token.slice(0, 3) + '***，长度 ' + token.length + '）· 绑 ' + bind))
    } else if (bind === '127.0.0.1' || bind === 'localhost') {
      items.push(ok('入口鉴权', '未设 token，但只绑回环 ' + bind + '（跨容器/局域网不可达）'))
    } else {
      items.push(bad('入口鉴权', '服务绑在 ' + bind + ' 且**没有** qq.inboundToken —— 同网段任何人都能读她的出站消息、往队列塞任务、冒充用户说话。去配置里设一个 token，或把绑定改回 127.0.0.1'))
    }
  } catch (e) { items.push(warn('入口鉴权', '检查失败：' + e.message)) }

  // 5.7) 三条"死链路"：python / 自制贴纸 / 代码归档
  try {
    const py = await import('../lib/python-runtime.mjs')
    const p = py.findPythonWith(['numpy'])
    if (!p.ok) items.push(bad('python 运行时', p.why + ' —— 语音韵律打分 / 自制表情的 python 分支都不可用'))
    else if (p.missing?.length) items.push(warn('python 运行时', p.bin + ' 可用，但缺库：' + p.missing.join(', ') + '（韵律打分将全 0 → 择优=选第一条）'))
    else items.push(ok('python 运行时', p.bin))
  } catch (e) { items.push(warn('python 运行时', '检查失败：' + e.message)) }

  try {
    const st = await import('../lib/stickers.mjs')
    const a = st.selfStickerAvailable()
    items.push(a.ok
      ? ok('自制贴纸', '可用（via ' + a.via + '：' + String(a.detail || '').slice(0, 60) + '）')
      : bad('自制贴纸', '不可用：' + a.detail + ' —— AI 生成失败后的兜底表情一直是空的'))
  } catch (e) { items.push(warn('自制贴纸', '检查失败：' + e.message)) }

  try {
    const { execFileSync } = await import('node:child_process')
    let hasGit = false
    try { execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 }); hasGit = true } catch (e) { swallow(e, 'diagnose:best-effort') }
    const tarMod = await import('../lib/tar.mjs')
    items.push(ok('代码归档', hasGit ? 'git 可用（睡眠第三阶段走 git 提交）' : '容器内无 git → 睡眠归档自动走内置 tar.gz（' + (typeof tarMod.tarGzDir === 'function' ? '已就绪' : '模块缺失') + '）'))
  } catch (e) { items.push(warn('代码归档', '检查失败：' + e.message)) }

  // 5.8) 干跑审计：有多少"她本来要说但没说出去"的话积压着
  try {
    const mem = await import('../lib/memory.mjs')
    const rows = mem.unsentAudit(200)
    const today = rows.filter((x) => Date.now() - Number(x.ts || 0) < 24 * 3600_000)
    if (today.length) {
      items.push(warn('干跑审计', today.length + ' 条拟回复未发送（guard.dryRun）—— 已单独存 audit/unsent.jsonl，不进记忆'))
    } else {
      items.push(ok('干跑审计', '没有未发送的拟回复'))
    }
  } catch (e) { items.push(warn('干跑审计', '检查失败：' + e.message)) }

  // 5.9) 平台开关一致性（v5：只判自己，不互相牵连）
  try {
    const P = await import('../lib/platforms.mjs')
    const cfgP = config()
    const snap = P.snapshot(cfgP)
    const offs = snap.filter((x) => !x.on && x.dialog)
    const conflicting = []
    if (cfgP.platforms?.qq === false && cfgP.qq?.enabled === true) conflicting.push('platforms.qq=false 但 qq.enabled=true')
    if (cfgP.platforms?.wechat === false && cfgP.wechat?.enabled === true) conflicting.push('platforms.wechat=false 但 wechat.enabled=true')
    if (conflicting.length) items.push(warn('平台开关', conflicting.join('；') + ' —— 平台会被判为关闭（取"与"），面板上请统一'))
    else items.push(ok('平台开关', snap.filter((x) => x.dialog).map((x) => x.label + '=' + (x.on ? '开' : '关')).join(' · ') + (offs.length ? '（关闭原因见 /health）' : '')))
  } catch (e) { items.push(warn('平台开关', '检查失败：' + e.message)) }

  // 6) 容器/沙箱
  const inDocker = fs.existsSync('/.dockerenv')
  items.push(ok('运行环境', (inDocker ? '容器内' : '宿主机') + ' · ' + process.platform + ' · node ' + process.version))

  // ── P0-4 数据形状体检（2026-11-03）：stream/episodes 三抓手 ────────────────
  // 三抓手：未来时间戳 / 整齐毫秒（合成时钟特征）/ 精确 N 倍间隔（生成序列特征）。
  // 写侧只打标（_tflags），这里按形状全库扫 —— 老数据没标也能抓。只报告，不清洗。
  try {
    const files = [dataPath('brain', 'log', 'stream.jsonl'), dataPath('episodes.jsonl'), dataPath('qq', 'episodes.jsonl'), dataPath('wechat', 'episodes.jsonl')]
    let scanned = 0, nFuture = 0, nAlms = 0, nEven = 0
    const nowMs = Date.now()
    for (const f of files) {
      let raw = ''
      try {
        const st = fs.statSync(f)
        if (st.size > 8 * 1024 * 1024) {
          // big file: read only the tail (same trick as readJsonl)
          const fd = fs.openSync(f, 'r')
          try {
            const buf = Buffer.alloc(2 * 1024 * 1024)
            fs.readSync(fd, buf, 0, buf.length, st.size - buf.length)
            raw = buf.toString('utf8')
            raw = raw.slice(raw.indexOf('\n') + 1)
          } finally { fs.closeSync(fd) }
        } else raw = fs.readFileSync(f, 'utf8')
      } catch { continue }
      scanned++
      let prev = 0
      for (const line of raw.split('\n')) {
        const t = line.trim(); if (!t) continue
        let r; try { r = JSON.parse(t) } catch { continue }
        const at = Number(r.at || r.ts || 0); if (!at) continue
        if (at > nowMs + 5 * 60_000) nFuture++
        if (at % 1000 === 0) nAlms++
        if (prev && at > prev && (at - prev) % 60_000 === 0) nEven++
        prev = at
      }
    }
    if (!scanned) items.push(warn('数据形状', '没有可扫的 stream/episodes 文件'))
    else if (nFuture === 0 && nAlms < 3 && nEven < 3) items.push(ok('数据形状', scanned + ' 个文件无合成时间痕迹（未来/整齐毫秒/整分间隔）'))
    else items.push(bad('数据形状', '可疑时间戳：未来 ' + nFuture + ' · 整齐毫秒 ' + nAlms + ' · 整分间隔 ' + nEven + '（扫 ' + scanned + ' 个文件）—— 时间形状被破坏'))
  } catch (e) { items.push(warn('数据形状', '检查失败：' + e.message)) }

  // ── P1-1 改名六层体检（2026-11-03）：容器内能验的层在这里验 ───────────────
  // 宿主脚本/单元那两层容器里够不着 —— dsh-bot-rename-audit.sh（宿主定时跑）
  // 把结果写进 rename-audit.json，这里读它的结论。
  try {
    const here = process.cwd()
    if (here.includes('dsh_bot')) items.push(ok('改名·挂载', '代码跑在 ' + here + '（dsh_bot 挂载点）'))
    else items.push(bad('改名·挂载', '工作目录 ' + here + ' 不是 dsh_bot 挂载点 —— 六层改名里第 2 层断了'))
    if (fs.existsSync('/home/dsh/plugins/dsh-feiyu')) items.push(warn('改名·挂载', '旧挂载 dsh-feiyu 仍存在 —— 双路径并存容易读错边'))
    if (fs.existsSync(dataPath('persona.md'))) items.push(ok('改名·数据根', 'persona.md 在数据根上（~/.data 对齐）'))
    else items.push(bad('改名·数据根', dataPath('persona.md') + ' 不存在 —— 数据根分叉（人格根本没加载的 P0 家族）'))
    try {
      const audit = JSON.parse(fs.readFileSync(dataPath('rename-audit.json'), 'utf8'))
      if (audit.ok) items.push(ok('改名·宿主', audit.summary || '宿主脚本/单元无旧容器名引用（' + (audit.at || '?') + '）'))
      else items.push(bad('改名·宿主', audit.summary || '宿主侧仍有旧容器名引用 —— 见 rename-audit.json'))
    } catch { items.push(warn('改名·宿主', 'rename-audit.json 不存在 —— 宿主侧体检还没跑过（/usr/local/bin/dsh-bot-rename-audit.sh）')) }
  } catch (e) { items.push(warn('改名体检', '检查失败：' + e.message)) }

  // ── P1-3 通道多样性（2026-11-03）：第二家 key 就位才算真 fallback ─────────
  try {
    const c = config().llm || {}
    const fb = [].concat(c.fallback ?? c.fallbacks ?? []).filter((x) => x && typeof x === 'object')
    const origins = new Set(fb.map((x) => String(x.base_url || x.baseUrl || c.base_url || '') + '|' + String(x.api_key || '').slice(0, 8)))
    if (!fb.length) items.push(warn('通道多样性', 'llm.fallback 未配置 —— 主通道挂即全停'))
    else if (origins.size <= 1) items.push(warn('通道多样性', 'fallback ' + fb.length + ' 级全部同源 —— 网关单点；第二家 key 在 llm.fallback 加 {base_url, api_key, model} 即生效，管道已就位'))
    else items.push(ok('通道多样性', 'fallback ' + fb.length + ' 级跨 ' + origins.size + ' 个来源'))
  } catch (e) { items.push(warn('通道多样性', '检查失败：' + e.message)) }

  // 5.10) 外部监听面（2026-11-03）：容器里谁在对「所有人」说话
  //   为什么加：M83 的教训是「监听面变化 = 静默的攻击面/断链变化」。这里把
  //   /proc/net/tcp 的 LISTEN 全摊开：0.0.0.0 是对外、容器 IP 是半公开、
  //   回环是内部。8081 绑 0.0.0.0 不是事故，是 M43 的必修项（docker-proxy
  //   从网卡地址进，绑回环=QQ 通路必挂）。
  try {
    const sockets = []
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!fs.existsSync(f)) continue
      for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 4 || cols[3] !== '0A') continue   // 0A = LISTEN
        const [hexIp, hexPort] = cols[1].split(':')
        let addr = 'tcp6'
        if (hexIp && hexIp.length === 8) {
          addr = hexIp.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.')
        }
        sockets.push({ addr, port: parseInt(hexPort, 16) })
      }
    }
    if (sockets.length) {
      const KNOWN_WILDCARD = { 8081: 'qq-server（必须 0.0.0.0：docker-proxy 从网卡地址进）' }
      const wild = sockets.filter((x) => x.addr === '0.0.0.0')
      const unknown = wild.filter((x) => !KNOWN_WILDCARD[x.port])
      const rest = sockets.filter((x) => x.addr !== '0.0.0.0').map((x) => x.addr + ':' + x.port)
      const wildDesc = wild.map((x) => x.port + (KNOWN_WILDCARD[x.port] ? ' ' + KNOWN_WILDCARD[x.port] : '')).join(' · ')
      if (unknown.length) {
        items.push(warn('外部监听面', '未知的 0.0.0.0 监听：' + unknown.map((x) => x.port).join(', ') + ' —— 新增对外监听要过一眼，当前已知：' + wildDesc))
      } else {
        items.push(ok('外部监听面', (wild.length ? '0.0.0.0 ×' + wild.length + '（' + wildDesc + '）' : '无 0.0.0.0 监听') + '；其余 ' + sockets.length + ' 个监听绑容器 IP/回环（' + rest.slice(0, 6).join(' · ') + '）'))
      }
    }
  } catch (e) { items.push(warn('外部监听面', '检查失败：' + e.message)) }

  if (json) { console.log(JSON.stringify({ items }, null, 2)); return }
  console.log('\n🔎 体检（静默失效专项）\n')
  for (const it of items) {
    const mark = it.ok === true ? '✓' : it.ok === false ? '✗' : '·'
    console.log('  ' + mark + ' ' + String(it.name).padEnd(12) + ' ' + (it.detail || ''))
  }
  const bads = items.filter((x) => x.ok === false)
  console.log('\n' + (bads.length ? '✗ ' + bads.length + ' 项要处理' : '✓ 没有发现静默失效') + '\n')
}

// ── CLI 直跑入口 ──────────────────────────────────────────────────────────
// 之前没有这段：node tools/commands/diagnose.mjs 静默什么都不输出（exit 0），
// 体检只能靠 DSH 面板跑 —— 排障时等于没有体检。DSH 命令加载器 import 本文件时
// argv[1] 不是本文件，不会触发；手工 CLI 才会真正跑到 run()。
if (process.argv[1] && import.meta.url === 'file://' + fs.realpathSync(process.argv[1])) {
  await run(process.argv.slice(2))
}
