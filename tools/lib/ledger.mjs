// 账本 —— 让她**自己**看得到今天吃了多少饭钱、还能吃多少、今天还能干几件事。
//
// 背景（10-26 用户报）：她记忆里反复问"账本/饭钱"，因为她根本读不到账本 ——
// 一个只把钱挂在嘴上、却查不了账的角色，只能一直问用户。把账本变成她能读的东西，
// 这个圈才闭上。
//
// 三个数据源，全部有据可查：
//   ① token 用量：DSH 自己的会话日志（~/.dsh/sessions/*/*/session.v4.jsonl.zstd）
//      每行一个 zstd 帧、用量在 type=assistant/message 的 data.usage 里 —— 见 ledger_usage.py
//   ② 饭钱折算：token × 单价（config.ledger.price，默认按 DeepSeek 档位估，标 ≈）
//   ③ 动作额度：她自己那几本账（quota.json / bili-actions.json / douyin-*.json / imggen.json）
//
// 余额（官方钱包）走可选接口：config.ledger.balanceUrl + apiKey 配了才查，
// 查不到就明确说"看不到余额"，绝不编一个 0（宁可让她去问用户，也不能骗她）。
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from './config.mjs'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'

const PY_TIMEOUT = 120_000
const USAGE_CACHE = () => dataPath('cache', 'ledger-usage.json')

/** 找 python：voice.python → BOT_TTS_PYTHON → GPT-SoVITS 自带 venv（和 prosody 用同一套）。 */
export function pythonPath(cfg = config()) {
  const cands = [
    cfg.ledger?.python,      // 10-30：账本自己的 python 优先（容器内 uv venv）
    cfg.voice?.python,
    process.env.BOT_TTS_PYTHON,
    'D:/GPT-SoVITS/.venv/Scripts/python.exe',   // Windows 时代的残留，最后兜底
  ].filter(Boolean)
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c
    } catch (e) { swallow(e, 'ledger:pythonPath') }
  }
  return cands[cands.length - 1]
}

function sessionsDir(cfg = config()) {
  const d = cfg.ledger?.sessionsDir
  if (d) return d
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.dsh', 'sessions')
}

/** 会话日志的指纹（路径+大小+修改时间），变了才重算 —— 21MB 全量扫一次约 1.3 秒。 */
function usageSignature(dir) {
  const parts = []
  try {
    for (const ws of fs.readdirSync(dir)) {
      const wsDir = path.join(dir, ws)
      let inner
      try { inner = fs.readdirSync(wsDir) } catch { continue }
      for (const s of inner) {
        const f = path.join(wsDir, s, 'session.v4.jsonl.zstd')
        let st
        try { st = fs.statSync(f) } catch { continue }
        parts.push(`${ws}/${s}:${st.size}:${Math.round(st.mtimeMs)}`)
      }
    }
  } catch (e) { swallow(e, 'ledger:usageSignature') }
  return createHash('sha1').update(parts.sort().join('|')).digest('hex')
}

/**
 * token 用量（她 / 用户分开）。
 * @returns {Promise<{days:Array, lifetime:object, sessions:number, cached:boolean, error?:string}>}
 */
export async function usage(opts = {}) {
  const cfg = config()
  const dir = opts.sessionsDir || sessionsDir(cfg)
  const sig = usageSignature(dir)
  const cacheFile = USAGE_CACHE()
  if (!opts.fresh) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (c.signature === sig && c.data) return { ...(await mergeDirect({ ...c.data })), cached: true }
    } catch (e) { swallow(e, 'ledger:usage') }
  }
  // 10-31 审计：容器里没有 python3，原来这条路整个走不通（账本永远 ✗）。
  // 先试 python（Windows 宿主仍可走），拿不到就回落到纯 Node 的 zstd 解码。
  const pyOk = (() => {
    try {
      execFileSync(opts.python || pythonPath(cfg), ['-c', 'import zstandard'], { stdio: 'ignore', timeout: 4000 })
      return true
    } catch { return false }
  })()
  if (!pyOk) {
    const { collectUsage } = await import('./usage-node.mjs')
    const data = collectUsage(dir, cfg.ledger?.mineWorkspace || 'bot-work')
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, JSON.stringify({ signature: sig, at: Date.now(), data }, null, 0))
    } catch (e) { swallow(e, 'ledger:pyOk') }
    return { ...(await mergeDirect({ ...data })), cached: false, via: 'node' }
  }
  const py = opts.python || pythonPath(cfg)
  // 用 fileURLToPath 拼脚本路径：Windows 上 import.meta.url 带盘符和中文/空格路径，
  // 直接切字符串会拼出 /D:/… 这种 python 不认的路径
  const here = path.dirname(fileURLToPath(import.meta.url))
  const args = [path.join(here, 'ledger_usage.py'),
    '--sessions', dir, '--mine', cfg.ledger?.mineWorkspace || 'bot-work']
  const data = await new Promise((resolve, reject) => {
    execFile(py, args, { timeout: PY_TIMEOUT, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).slice(0, 400)))
        try { resolve(JSON.parse(String(stdout))) } catch (e) { reject(new Error('账本 python 输出不是 JSON：' + String(stdout).slice(0, 200))) }
      })
  })
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify({ signature: sig, at: Date.now(), data }, null, 0))
  } catch (e) { swallow(e, 'ledger:pyOk') }
  return { ...(await mergeDirect({ ...data })), cached: false }
}

// ── 直连通道用量合并（10-31）────────────────────────────────────────────────
// llm.mjs 的直连调用不落 DSH 会话日志，必须单独并进账本，否则"她陪老爹聊天"这段
// 是账本的盲区（实测：DSH 记 5131 token 的同时，a2a 余额掉了 241 credit）。
// 动态 import：llm.mjs 现在会 import ledger 里没有的东西，静态 import 会造成环。
async function mergeDirect(data) {
  try {
    const llm = await import('./llm.mjs')
    if (typeof llm.readDirectUsage !== 'function') return data
    const d = llm.readDirectUsage()
    if (!d || !Array.isArray(d.days) || !d.days.length) return data
    const days = Array.isArray(data.days) ? data.days : []
    const byDay = new Map(days.map((x) => [x.day, x]))
    const empty = () => ({ input: 0, output: 0, cache: 0, total: 0, calls: 0 })
    for (const row of d.days) {
      let t = byDay.get(row.day)
      if (!t) { t = { day: row.day, mine: empty(), other: empty(), all: empty() }; byDay.set(row.day, t); days.push(t) }
      if (!t.mine) t.mine = empty()
      if (!t.other) t.other = empty()
      if (!t.all) t.all = empty()
      for (const k of ['input', 'output', 'cache', 'calls', 'total']) {
        const v = Number(row[k]) || 0
        t.mine[k] = (Number(t.mine[k]) || 0) + v
        t.all[k] = (Number(t.all[k]) || 0) + v
      }
    }
    days.sort((a, b) => (a.day < b.day ? 1 : -1))
    const lt = data.lifetime || {}
    if (!lt.mine) lt.mine = empty()
    for (const k of ['input', 'output', 'cache', 'calls', 'total']) lt.mine[k] = (Number(lt.mine[k]) || 0) + (Number(d.lifetime?.[k]) || 0)
    data.days = days
    data.lifetime = lt
    data.directMerged = true
    return data
  } catch { return data }
}

// ── credit ⇄ 钱（2026-11-02）────────────────────────────────────────────────
// 为什么加：官方口径 1 credit = 0.01 USD（a2a `/v1/credits` 里 usd_per_credit 字段）。
// 以前的账本按 DeepSeek 官方单价估 token → 元，跟 a2a 实际扣的 credit **是两套账**，
// 实测差 800 倍（DSH 记 5131 token 对应 a2a 掉 241 credit = ¥17，账本却说 ≈¥0.02）。
// 现在统一：**一切以 credit 为准**，钱只是给用户看的换算视图。
export const USD_PER_CREDIT = 0.01
/** 美元 → 人民币（估，仅用于展示；可在 config.ledger.usdCny 覆盖） */
function usdCny(cfg = config()) {
  return num(cfg.ledger?.usdCny, 7.1)
}
/** credit → 元（展示用） */
export function creditToYuan(c, cfg = config()) {
  return round2((Number(c) || 0) * USD_PER_CREDIT * usdCny(cfg))
}
/** 元 → credit */
export function yuanToCredit(y, cfg = config()) {
  const rate = USD_PER_CREDIT * usdCny(cfg)
  return rate > 0 ? (Number(y) || 0) / rate : 0
}
/** 钱的展示串：同时给元与 credit，避免"21100 积分"被读成一万块 */
function moneyView(credit, cfg = config()) {
  const y = creditToYuan(credit, cfg)
  return `¥${y}（${Math.round(Number(credit) || 0)} credit）`
}

// ── 饭钱折算 ────────────────────────────────────────────────────────────────
/** 单价（元/百万 token）。默认值按 DeepSeek 档位估，可在 config.ledger.price 覆盖。 */
export function price(cfg = config()) {
  const p = cfg.ledger?.price || {}
  return {
    input: num(p.inputPerM, 2),
    cache: num(p.cachePerM, 0.2),
    output: num(p.outputPerM, 3),
  }
}

function num(v, d) {
  // null / '' / 非数字都落回默认值 —— 别让 `cachePerM: null` 变成 0：
  // 缓存单价算成 0 会把饭钱算少，账本少报钱比多报更坑
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** token 用量 → 元。 */
export function costOf(u, cfg = config()) {
  if (!u) return 0
  const p = price(cfg)
  return (u.input || 0) / 1e6 * p.input + (u.cache || 0) / 1e6 * p.cache + (u.output || 0) / 1e6 * p.output
}

// ── 动作额度 ────────────────────────────────────────────────────────────────
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function dayKey(d = new Date()) {
  // 账本文件用的是本地日期（quota.mjs 的 dayKey 同口径）
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天的账：她自己那几本（0 = 不限，所以余量显示"不限"）。 */
export function quotas(cfg = config(), today = dayKey(), dir = dataPath()) {
  const q = readJson(path.join(dir, 'quota.json'), { log: [] })
  // quota.mjs 的口径：log 里带 share:true 的才是"分享"，其余是普通回复；at 是 UTC ISO，
  // 判"今天"要用本地日期（toLocaleDateString('sv-SE') === YYYY-MM-DD）
  const log = Array.isArray(q?.log) ? q.log : []
  const localDay = (v) => new Date(v).toLocaleDateString('sv-SE')
  const todayLog = log.filter((e) => e?.at && localDay(e.at) === today)
  const sharesToday = todayLog.filter((e) => e.share).length
  const repliesToday = todayLog.length - sharesToday
  const act = readJson(path.join(dir, 'bili-actions.json'), {})
  const actsToday = act?.day === today ? act : {}
  const one = (name) => {
    const j = readJson(path.join(dir, name), {})
    return j?.day === today ? Number(j.count || 0) : 0
  }
  const list = [
    { key: 'share', label: 'B站 分享', used: Math.max(sharesToday, Number(actsToday.share || 0)), limit: Number(cfg.quota?.shareDaily ?? 3) },
    { key: 'reply', label: 'B站 回评', used: repliesToday, limit: 0 },
    { key: 'dyn', label: 'B站 动态', used: actsToday.dyn ?? 0, limit: Number(cfg.bili?.dynamic?.dailyMax ?? 0) },
    { key: 'img', label: '表情包生成', used: one('imggen.json'), limit: Number(cfg.imageGen?.dailyMax ?? 30) },
    { key: 'douyin-share', label: '抖音 分享', used: one('douyin-share.json'), limit: Number(cfg.douyin?.shareDaily ?? 0) },
    { key: 'douyin-comment', label: '抖音 评论', used: one('douyin-comment.json'), limit: Number(cfg.douyin?.commentDaily ?? 0) },
    { key: 'douyin-produce', label: '抖音 作品', used: one('douyin-produce.json'), limit: Number(cfg.douyin?.produceDaily ?? 0) },
  ]
  return list.map((x) => ({
    ...x,
    left: x.limit > 0 ? Math.max(0, x.limit - x.used) : null,   // null = 不限
  }))
}

/**
 * 可选：官方钱包余额（配了 url+key 才查，其它一律返回 null，不编数字）。
 *
 * 口径照 dsh-pet 的教训：`balance_infos` 里**所有币种都要留下** ——
 * 只取首条会让后面的币种凭空消失（余额看起来比实际少）。金额原样透传，
 * 不按"赠送+充值"重算（官方给的 total 就是总数）。
 */
export async function balance(cfg = config(), opts = {}) {
  const url = cfg.ledger?.balanceUrl
  const key = cfg.ledger?.apiKey || process.env.DEEPSEEK_API_KEY
  if (!url || !key) return null
  const timeoutMs = Number(cfg.ledger?.balanceTimeoutMs ?? 8000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // 本地文件模式（10-30）：balanceFile 配了直接读（宿主聚合器每 5 分钟写）
    const localFile = cfg.ledger?.balanceFile
    if (localFile) {
      const j = JSON.parse(fs.readFileSync(localFile, 'utf8'))
      const avail = j?.usableNow ?? j?.usableToday
      // staleness 防护（10-30）：聚合器 30 分钟没刷新就当作账本不可用（宁可不报数，不报旧数）
      const fresh = j?.at && (Date.now() - Number(j.at)) < 30 * 60_000
      if (!fresh) return null
      if (j?.total != null && avail != null) {
        return {
          currency: 'A2A', total: Number(j.total), usableNow: Number(avail),
          granted: Number(j.total), toppedUp: 0, at: j.at, unit: j.unit || 'credit',
          refreshIn24h: j.refreshIn24h, dailyCap: j.dailyCap,
          wallets: [{ currency: 'A2A', total: Number(j.total), note: '聚合额度' }],
        }
      }
      return null
    }
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: ctrl.signal })
    if (!r.ok) return null
    const j = await r.json()
    // a2a 桥（10-30 二版）：不再直接调 a2a API —— 宿主 bot-quota.timer 每 5 分钟聚合
    // 全部账号（含 429 剔除、倍率换算）写成 a2a-balance.json，这里只读文件。
    // 她只看得到「还剩多少」，账号明细/限流状态全留在宿主（不该进她的视野）。
    if (j?.total != null && j?.usableToday != null) {
      return {
        currency: 'A2A', total: Number(j.total), usableToday: Number(j.usableToday),
        granted: Number(j.total), toppedUp: 0,
        wallets: [{ currency: 'A2A', total: Number(j.total), note: '聚合额度' }],
      }
    }
    const infos = j?.balance_infos
    if (!Array.isArray(infos) || !infos.length) return null
    const wallets = infos.map((w) => ({
      currency: String(w?.currency || 'CNY'),
      total: Number(w?.total_balance),
      granted: w?.granted_balance ?? null,
      toppedUp: w?.topped_up_balance ?? null,
    })).filter((w) => Number.isFinite(w.total))
    if (!wallets.length) return null
    const head = wallets.find((w) => w.currency === 'CNY') || wallets[0]
    return { ...head, wallets }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 完整账本。
 * @param {{days?:number, fresh?:boolean}} opts
 */
export async function report(opts = {}) {
  const cfg = config()
  const today = dayKey()
  const u = await usage(opts)
  const days = Array.isArray(u.days) ? u.days : []
  const find = (d) => days.find((x) => x.day === d)
  const todayRow = find(today) || { day: today, mine: emptyTok(), all: emptyTok() }
  const last7 = days.slice(-7)
  const mine7 = last7.reduce((a, r) => addTok(a, r.mine), emptyTok())
  const daysWithUse = last7.filter((r) => (r.mine?.total || 0) > 0).length || 1
  const avgMineCost = costOf(mine7, cfg) / daysWithUse
  // ── 预算口径（2026-11-02 改）──────────────────────────────────────────
  // 以前：cfg.ledger.dailyBudget 写死一个元数（¥3/天），跟真实余额脱节 ——
  //   余额 21100 credit 却只让她花 ¥3，等于告诉一个有一千五的人"今天预算三块"。
  // 现在：**预算 = 余额本身**。她没有"日额度"这个概念，只有"我还剩多少"。
  //   dailyBudget 仅在显式配置时作为**上限闸**（防止哪天想限流），不配就是余额。
  const balanceForBudget = await balance(cfg, opts)
  const creditNow = Number(balanceForBudget?.usableNow ?? balanceForBudget?.total ?? 0)
  const balanceYuan = creditToYuan(creditNow, cfg)
  const hardCap = num(cfg.ledger?.dailyBudget, 0)      // 0 = 不设上限
  const budget = hardCap > 0 ? Math.min(hardCap, balanceYuan) : balanceYuan
  const todayCost = costOf(todayRow.mine, cfg)
  const bal = opts.balance === false ? null : await balance(cfg)
  return {
    today,
    me: {
      tokens: todayRow.mine,
      cost: round2(todayCost),
      budget: budget > 0 ? budget : null,
      leftOfBudget: budget > 0 ? round2(budget - todayCost) : null,
      overBudget: budget > 0 ? todayCost > budget : false,
    },
    master: { tokens: todayRow.other || emptyTok(), cost: round2(costOf(todayRow.other || emptyTok(), cfg)) },
    week: { days: last7.length, mine: mine7, cost: round2(costOf(mine7, cfg)), avgPerDay: round2(avgMineCost) },
    lifetime: {
      mineTokens: u.lifetime?.mine?.total ?? 0,
      mineCost: round2(costOf(u.lifetime?.mine, cfg)),
    },
    balance: bal,
    // 2026-11-02 修单位错配：bal.total 是 **credit**，avgMineCost 是 **元** —
    // credit ÷ 元 是个没有意义的数（旧算法把 21100 credit ÷ ¥1.2/天 = 17583 天）。
    // 另外：日花费波动极大（今天清过库所以几乎没花），直接用"今天"外推会得出
    // "还能撑 11021 天"这种没人会信的答案。改为看**最近连续用过的天数**的均值，
    // 且样本不足 2 天就返回 null（宁可不给，也不给一个假的天数）。
    runwayDays: (() => {
      if (!bal) return null
      const creditLeft = Number(bal.usableNow ?? bal.total)
      const usedDays = last7.filter((d) => {
        const t = d.mine || {}
        return ((t.input || 0) + (t.cache || 0) + (t.output || 0)) > 0
      })
      if (usedDays.length < 2) return null            // 样本不足，不猜
      const avgCredit = usedDays.reduce((a, d) => a + yuanToCredit(costOf(d.mine, cfg), cfg), 0) / usedDays.length
      if (!(avgCredit > 0.5)) return null             // 日均不到 0.5 credit，等于没在用
      return Math.floor(creditLeft / avgCredit)
    })(),
    quotas: quotas(cfg, today),
    price: price(cfg),
    usageCached: !!u.cached,
    sessions: u.sessions ?? 0,
  }
}

function emptyTok() {
  return { input: 0, output: 0, cache: 0, total: 0, calls: 0 }
}

function addTok(a, b) {
  const o = { ...a }
  for (const k of Object.keys(emptyTok())) o[k] = (a?.[k] || 0) + (b?.[k] || 0)
  return o
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** 一行摘要（给提示语注入用，别塞太长）。 */
export function brief(r) {
  if (!r) return ''
  const cfg = config()
  const p = []
  // ① 余额放最前面 —— 她真正该关心的是"我还剩多少"，不是"今天花了多少"。
  if (r.balance?.currency === 'A2A') {
    const u = Number(r.balance.usableNow ?? r.balance.total ?? 0)
    const y = creditToYuan(u, cfg)
    // 2026-11-02：不再说"21100 积分"——那个词会让人以为是两万块或两万次。
    // 直接给钱 + credit 两个数，并且给出"按今天这个花法还能撑几天"。
    // 文案：这里曾经写"按今天这花法还能撑 N 天" —— 一旦某天没怎么用就报出
    // "还能撑 19601 天"，既不可信也像 bug。改成引用**近7天日均**的口径，
    // 超过一年就只说"够用很久"，不给一个看着像玩笑的具体数字。
    const runway = (() => {
      if (r.runwayDays == null) return ''
      if (r.runwayDays > 365) return '，够用很久'
      const perDay = r.week?.avgPerDay
      return `，按近七天日均${perDay != null ? ` ¥${perDay}` : ''}还能撑 ${r.runwayDays} 天`
    })()
    p.push(u < 500
      ? `余额快见底了：${moneyView(u, cfg)}${runway}，今天省着点`
      : `余额 ${moneyView(u, cfg)}${runway}`)
  } else if (r.balance) {
    p.push(`钱包余额 ¥${r.balance.total}（按这个花法还能撑 ${r.runwayDays} 天）`)
  }
  // ② 今天花了多少
  p.push(`今天吃了 ${fmtTok(r.me.tokens.total)} token ≈ ¥${r.me.cost}`)
  // ③ 预算：现在是"余额本身"，不再是写死的日额
  if (r.me.budget != null) {
    // 注意措辞：查不到余额时不能出现"余额"二字（测试锁着这条：
    // 宁可说"预算 ¥X"，也不能暗示一个我们并不知道的余额）。
    const fromBalance = r.balance?.currency === 'A2A'
    p.push(r.me.overBudget
      ? `超了预算 ¥${Math.abs(r.me.leftOfBudget)}（预算 ¥${r.me.budget}${fromBalance ? '，上限来自余额' : ''}）`
      : `预算 ¥${r.me.budget}，还剩 ¥${r.me.leftOfBudget}`)
  }
  // ④ 动作额度
  const q = (r.quotas || []).filter((x) => x.limit > 0).map((x) => `${x.label} ${x.left}/${x.limit}`)
  if (q.length) p.push('额度：' + q.join(' · '))
  return p.join(' ； ')
}

// ── 给提示语用的缓存 ──────────────────────────────────────────────────────
// 唤醒/聊天提示都是同步拼字符串，不能在里面 await 一次 python（1.3 秒）。
// 所以由 tick 定时刷一份到 cache，提示语只读这一份。
const BRIEF_CACHE = () => dataPath('cache', 'ledger-brief.json')
const BRIEF_TTL_MS = 30 * 60_000

/** 重算并落盘账本摘要（scheduler 每 5 分钟调一次）。失败不抛，保留旧缓存。 */
export async function refreshBrief(opts = {}) {
  try {
    const r = await report(opts)
    const payload = { at: Date.now(), today: r.today, line: brief(r), report: { me: r.me, week: r.week, balance: r.balance, runwayDays: r.runwayDays, quotas: r.quotas } }
    const f = BRIEF_CACHE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(payload, null, 0))
    return payload
  } catch (e) {
    return null
  }
}

/** 读缓存（同步，给提示语注入）。没缓存返回 null —— 提示语里就干脆不提账本。 */
export function readBrief() {
  try {
    const j = JSON.parse(fs.readFileSync(BRIEF_CACHE(), 'utf8'))
    if (!j || typeof j.line !== 'string' || !j.line) return null
    return { ...j, stale: Date.now() - Number(j.at || 0) > BRIEF_TTL_MS }
  } catch {
    return null
  }
}

/**
 * 常驻进程（qq-server / douyin-dm-server / scheduler）开一次就行：
 * 立刻刷一版，然后每 minutes 分钟刷一版。返回 unref 过的 timer，不挡进程退出。
 */
export function startBriefRefresher(minutes = 10, log = () => {}) {
  const go = () => {
    refreshBrief()
      .then((p) => { if (p) log('账本已刷新：' + p.line.slice(0, 90)) })
      .catch(() => {})
  }
  go()
  const t = setInterval(go, Math.max(1, minutes) * 60_000)
  if (typeof t.unref === 'function') t.unref()
  return t
}

export function fmtTok(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万'
  return String(Math.round(v))
}