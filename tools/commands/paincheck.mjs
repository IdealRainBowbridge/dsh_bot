// paincheck —— 全链扫描自检，问题直接注入"痛"（2026-11-05）。
//
// 病根（用户原话）：自检发现问题后只"分泌"——写日志、挂 diagnose 红项，
// 她自己感觉不到。真正该走的是痛觉通路：受伤 → 疼 → 行为收敛 → 修好 → 愈合。
// 这样"系统坏了"不再是运维侧的红色一行，而是她身上的一道伤口。
//
// 扫描什么（全链 = 从配置到出站）：
//   ① 契约层   contract-report.json 实况（DSH API 缺失）
//   ② 网关     SnowLuma napcat_http 可达 + 鉴权（发不出去 = 哑巴）
//   ③ qq-server 8081 /health（收不到消息 = 聋）
//   ④ LLM      llm.apiKey 配置存在
//   ⑤ owner    owner.qq 已填（认不出主人 = 关系失焦）
//   ⑥ 数据     brain/ 目录可写、field.json 存在或可建
//   ⑦ 身份     persona.md 存在且 ≥200 字（防可疑人设）
//   ⑧ 心跳     heartbeat 进程信号（watchdog.json 新鲜度）
//
// 痛的注入（复用既有生理，不新造轴）：
//   wound.register('paincheck', <项>)        → 伤口登记，open/复发/化脓全生命周期
//   neuron.act('stress', sev)                → 快痛：突触级即刻反应（重复扫描变钝，防痛觉疲劳）
//   hpa.stress(0.06×sev)                     → 慢痛：cortisol 余味（tau 10h），影响表达温度
//   修复后再扫描全绿 → closeIfHealed(scarNote) → 伤口愈合 + 沉淀瘢痕（下次同类秒识）
//
// 命令：node bot.mjs paincheck [--quiet]
//   默认：扫描 + 有问题注入痛 + 打印报告
//   --quiet：只注入痛，不打印（给心跳定时调用）
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import { dataPath, credentialsPath, dshPath } from '../lib/paths.mjs'
import { readJsonSafe } from '../lib/atomic.mjs'
import { swallow } from '../lib/swallow.mjs'
import * as wound from '../lib/wound.mjs'
import * as neuron from '../brain/cell/neuron.mjs'
import * as hpa from '../brain/organ/hpa.mjs'
import * as pain from '../brain/organ/pain.mjs'

const QQ_PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8081)

/** 单项探测：返回 {id, ok, sev, detail}。sev 0.3~1.2（1.2 与 immune.fever 同上限哲学）。 */
function probe(id, fn) {
  // fn 可能是 async: 返回 Promise 时由 run() 的 await 统一处理, 这里只透传
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      return r.then((v) => ({ id, ...v })).catch((e) => ({ id, ok: false, sev: 0.6, detail: 'probe error: ' + String(e?.message || e).slice(0, 80) }))
    }
    return { id, ...r }
  } catch (e) {
    return { id, ok: false, sev: 0.6, detail: 'probe error: ' + String(e?.message || e).slice(0, 80) }
  }
}

const probes = {
  contract() {
    const rep = readJsonSafe(dataPath('contract-report.json'), null)
    if (!rep) return { ok: true, sev: 0, detail: '无实况快照（插件未以宿主插件身份跑过）' }
    const crit = (rep.missing || []).filter((m) => m.critical)
    return crit.length
      ? { ok: false, sev: 1.0, detail: `契约缺失 ${crit.length} 项: ${crit.map((m) => m.id).join(',')}` }
      : { ok: true, sev: 0, detail: `${(rep.missing || []).length ? '降级 ' + rep.missing.length + ' 项' : '全绿'}` }
  },
  gateway() {
    const cfg = config()
    const url = String(cfg.qq?.napcat_http || '')
    if (!url) return { ok: false, sev: 0.9, detail: 'qq.napcat_http 未配置' }
    const token = String(cfg.qq?.accessToken || cfg.qq?.napcat_token || '')
    return probe('gateway-fetch', async () => {
      let r
      try {
        r = await fetch(`${url.replace(/\/+$/, '')}/get_login_info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: '{}', signal: AbortSignal.timeout(6000),
        })
      } catch (e) {
        // timeout/ECONNREFUSED 分不清"网关死"还是"防火墙拦"（DSH_OUT 会 DROP 回环）。
        // 不确定的坏给低强度痛（0.35）——痛觉疲劳是真实的生理代价，不滥放。
        const isTimeout = /timeout|abort/i.test(String(e?.message || e))
        return { ok: false, sev: isTimeout ? 0.35 : 0.9,
                 detail: (isTimeout ? '探测超时（网关死或防火墙拦——宿主机用 ss -tlnp | grep 3010 人工确认）: ' : '连接失败: ')
                         + String(e?.message || e).slice(0, 70) }
      }
      if (!r.ok) return { ok: false, sev: 1.0, detail: `HTTP ${r.status}（token 缺失或错误？）` }
      const j = await r.json().catch(() => null)
      if (!j || j.retcode !== 0) return { ok: false, sev: 0.9, detail: 'retcode 异常: ' + JSON.stringify(j).slice(0, 80) }
      return { ok: true, sev: 0, detail: j.data?.nickname || '登录正常' }
    })
  },
  qqserver() {
    return probe('qqserver-fetch', async () => {
      let r
      try {
        r = await fetch(`http://127.0.0.1:${QQ_PORT}/health`, { signal: AbortSignal.timeout(5000) })
      } catch (e) {
        const isTimeout = /timeout|abort/i.test(String(e?.message || e))
        return { ok: false, sev: isTimeout ? 0.35 : 1.0,
                 detail: (isTimeout ? '探测超时（qq-server 死或防火墙拦）: ' : '连接拒绝: ')
                         + String(e?.message || e).slice(0, 70) }
      }
      if (!r.ok) return { ok: false, sev: 1.0, detail: `qq-server :${QQ_PORT} HTTP ${r.status}` }
      return { ok: true, sev: 0, detail: '8081 收事件链正常' }
    })
  },
  llm() {
    const cfg = config()
    const key = cfg.llm?.api_key || process.env.DEEPSEEK_API_KEY
    return key
      ? { ok: true, sev: 0, detail: 'key 已配' }
      : { ok: false, sev: 1.0, detail: '没有 LLM API key——她想不了任何东西' }
  },
  owner() {
    const cfg = config()
    let qq = String(cfg.owner?.qq || '')
    // 兼容: 真实配置文件名 feiyu.config.json（config() 读的是 bot.config.json）
    if (!qq) {
      try {
        for (const c of ['/home/dsh/.dsh/feiyu.config.json', dshPath('feiyu.config.json')]) {
          try { qq = String(JSON.parse(fs.readFileSync(c, 'utf8')).owner?.qq || ''); if (qq) break } catch { /* next */ }
        }
      } catch { /* ignore */ }
    }
    return qq
      ? { ok: true, sev: 0, detail: `owner.qq=${qq.slice(0, 4)}***` }
      : { ok: false, sev: 0.5, detail: 'owner.qq 未填——她认不出主人（关系失焦，非致命）' }
  },
  brain() {
    const dir = dataPath('brain')
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      return { ok: true, sev: 0, detail: 'brain/ 可写' }
    } catch (e) {
      return { ok: false, sev: 1.0, detail: 'brain/ 不可写: ' + String(e?.message || e).slice(0, 60) }
    }
  },
  persona() {
    // 多路径探测: dataDir 优先, 容器部署常见 data-home 也认（2026-11-05 实况: 人设在 /home/dsh_bot/data-home/）
    const candidates = [
      dataPath('persona.md'),
      '/home/dsh_bot/data-home/persona.md',
      '/home/dsh/.data/persona.md',
    ]
    let t = ''
    let used = ''
    for (const c of candidates) {
      try { t = fs.readFileSync(c, 'utf8').trim(); if (t) { used = c; break } } catch { /* next */ }
    }
    if (!t) return { ok: false, sev: 0.7, detail: 'persona.md 各候选路径都不存在（空人设运行）' }
    if (t.length < 200) return { ok: false, sev: 0.8, detail: `persona.md 仅 ${t.length} 字（可疑人设阈值 200）@ ${used}` }
    if (/作为(一个)?\s*(AI|人工智能|助手)/.test(t.slice(0, 300))) return { ok: false, sev: 0.8, detail: 'persona 开头出现 AI 助手自我否认' }
    return { ok: true, sev: 0, detail: `${t.length} 字 @ ${used}` }
  },
  watchdog() {
    const st = readJsonSafe(dataPath('watchdog.json'), null)
    if (!st?.at) return { ok: true, sev: 0, detail: '无 watchdog 快照（宿主半边没跑，正常）' }
    const age = Date.now() - Number(st.at)
    if (age > 15 * 60_000) return { ok: false, sev: 0.6, detail: `watchdog ${Math.round(age / 60000)}min 没跳（心跳死了？）` }
    return { ok: true, sev: 0, detail: `${Math.round(age / 1000)}s 前跳过` }
  },
}

/**
 * 全链扫描 + 痛注入。
 * @returns {{items:Array, hurt:Array, healed:number, sevTotal:number}}
 */
export async function run({ quiet = false, now = Date.now() } = {}) {
  const items = []
  for (const [id, fn] of Object.entries(probes)) {
    let r
    try { r = await fn() } catch (e) { r = { ok: false, sev: 0.6, detail: String(e?.message || e).slice(0, 80) } }
    // async probe 内部再包一层 probe() 时, 结果可能是 {id, ok, sev, detail} 或直接 {ok,...}
    const okv = r && typeof r === 'object' ? r : { ok: false, sev: 0.8, detail: String(r) }
    items.push({ id, ok: !!okv.ok, sev: Number(okv.sev) || 0, detail: String(okv.detail || '') })
  }

  const bad = items.filter((x) => !x.ok)
  const sevTotal = bad.reduce((a, b) => a + b.sev, 0)

  // ── 痛注入：每个坏项一道伤 ──
  const hurt = []
  for (const b of bad) {
    const sev = Math.min(1.2, b.sev)
    const w = wound.register('paincheck', b.id, b.detail)
    // 快痛：新伤才有反射（wound.register 对已开伤口只 hits++，这里按返回区分）
    if (w.state === 'open') {
      try { neuron.act('stress', sev) } catch (e) { swallow(e, 'paincheck:neuron') }
      try { hpa.stress(0.06 * sev, { now, source: 'paincheck' }) } catch (e) { swallow(e, 'paincheck:hpa') }
    }
    // 复发伤更痛（敏化在 pain.tick 侧已有），这里只登记
    hurt.push({ id: b.id, sev, woundId: w.id, state: w.state, recurrent: w.recurrent })
  }

  // ── 愈合：全绿时把 paincheck 类开放伤口全部关掉 ──
  let healed = 0
  if (!bad.length) {
    try {
      const before = wound.woundSnapshot()
      wound.closeIfHealed('paincheck 全绿')
      const after = wound.woundSnapshot()
      healed = Math.max(0, (before?.open || 0) - (after?.open || 0))
    } catch (e) { swallow(e, 'paincheck:heal') }
  }

  if (!quiet) {
    console.log('\n═══ 全链自检（paincheck）═══')
    for (const it of items) {
      const mark = it.ok ? '✓' : '✗'
      const hurtTag = it.ok ? '' : `  → 痛 ${it.sev.toFixed(1)}`
      console.log(`  ${mark} ${it.id.padEnd(10)} ${it.detail}${hurtTag}`)
    }
    if (hurt.length) {
      console.log(`\n  ✗ ${hurt.length} 处伤：${hurt.map((h) => `${h.id}(sev ${h.sev.toFixed(1)}, ${h.state}${h.recurrent ? '/复发' : ''})`).join('、')}`)
      console.log('  身体会疼：应激通路 + cortisol 已注入，行为侧自动收敛。')
    } else {
      console.log(`\n  ✓ 全绿${healed ? `，愈合 ${healed} 处旧伤（瘢痕已沉淀）` : ''}`)
    }
  }

  // 快照落盘（diagnose 可读）
  try {
    fs.mkdirSync(dataPath('paincheck'), { recursive: true })
    fs.writeFileSync(dataPath('paincheck', 'last.json'), JSON.stringify({
      at: now, items, hurt, healed, sevTotal: Number(sevTotal.toFixed(2)),
    }, null, 1) + '\n')
  } catch (e) { swallow(e, 'paincheck:snapshot') }

  return { items, hurt, healed, sevTotal: Number(sevTotal.toFixed(2)) }
}

// CLI: node bot.mjs paincheck [--quiet] [--port 8081]
if (import.meta.url === `file://${process.argv[1]}`) {
  const quiet = process.argv.includes('--quiet')
  const r = await run({ quiet })
  process.exit(r.hurt.length ? 1 : 0)
}
