// webpush —— webui 主动说话（2026-11-03）：让她在网页会话里自己开口。
//
// 哲学与 QQ 主动搭话同源（qq-server tryProactive）：由头驱动，安静兜底，闸门合并计数。
// 通道区别：QQ 发 NapCat；这里只产出「任务提示」，由调用方（scheduler / 面板）塞进
// ctx.sessionController.prompt —— 落点就是 webui「工作区 → 未分组」的 dsh_bot 会话，
// 她在网页里说的话和被生物钟唤醒说的话同一条流。消息本体由她在会话里自己写
// （不在这边预生成 —— 会话里有她完整的 persona 和工具，预生成就成了替她说话）。
//
// 三道闸（bot.config.json webui.proactive）：
//   · enabled    总开关（默认 false，配置里开了才动）
//   · dailyMax   每天最多几条（默认 3，0 = 不限；force 手动触发也受这条管）
//   · minGapMin  两条之间最少隔多久（默认 180 分钟；force 不受限）
//   · quietHours 由头等不来的话，安静多久兜底一条（默认 8 小时，0 = 只由头驱动；force 不受限）
//
// 由头（tryMotive，按优先级，各只说一次 —— used 台账防重发）：
//   1. promise-outcome  刚真的看完/没看成的那部剧（与 QQ 通道共用一份，谁先说算谁的）
//   2. watchlog         刚看完的番（3 小时内、真看懂了、有她自己的感受）
//   3. diary            刚写完的日记（45 分钟内，私人那本的头几句）
// 由头有效期 6 小时，过期作废 —— 过了点的分享就不是分享了。
import fs from 'node:fs'
import { dataPath, diaryPath } from './paths.mjs'
import { swallow } from './swallow.mjs'
import { updateJson } from './atomic.mjs'
import { config } from './config.mjs'
import { promiseOutcomePath } from './promise-executor.mjs'
import * as watchlog from './watchlog.mjs'

const WAKE_FILE = () => dataPath('webui-wake.json')
const MOTIVE_TTL = 6 * 3600_000

function readWake() {
  try { const j = JSON.parse(fs.readFileSync(WAKE_FILE(), 'utf8')); if (j && typeof j === 'object') return j } catch (e) { swallow(e, 'webpush:readWake') }
  return {}
}
function writeWake(o) {
  try { fs.writeFileSync(WAKE_FILE(), JSON.stringify(o, null, 1) + '\n') } catch (e) { swallow(e, 'webpush:writeWake') }
}
function hourSlot(h) { return h < 5 ? '深夜' : h < 8 ? '清早' : h < 11 ? '上午' : h < 14 ? '午饭点' : h < 18 ? '下午' : h < 20 ? '傍晚' : h < 23 ? '晚上' : '深夜' }
function updateWake(fn) {
  const W = WAKE_FILE()
  const r = updateJson(W, (cur) => fn((cur && typeof cur === 'object') ? cur : {}), { fallback: {}, waitMs: 1500 })
  if (!r.ok) swallow(new Error(r.error || 'updateWake failed'), 'webpush:updateWake')
  return r
}

/** 由头 harvesting。返回 {kind, id, text} 或 null。id 用于 used 台账去重。 */
function tryMotive(now) {
  // 1. 承诺执行器：刚真的看完/没看成
  try {
    const o = JSON.parse(fs.readFileSync(promiseOutcomePath(), 'utf8'))
    if (o && !o.used && now - Number(o.at || 0) < MOTIVE_TTL) {
      const text = o.ok
        ? `你刚真的看完了《${o.title}》${Number(o.watched) > 1 ? `第 ${o.epFirst}~${o.epLast} 集（一口气 ${o.watched} 集）` : `第 ${o.ep} 集`}：${String(o.plot || '').slice(0, 100)}（你自己的感受：${String(o.feel || '').slice(0, 50)}）`
        : `你刚想看《${o.show}》但没看成：${String(o.via || '没有可用材料').slice(0, 60)} —— 说的时候照实说没看成，别装看完了`
      return { kind: '分享', id: `promise:${o.at}`, text }
    }
  } catch (e) { swallow(e, 'webpush:motive-promise') }
  // 2. watchlog：刚看完、真看懂、有感受
  try {
    const rows = watchlog.recentRows({ hours: 3, limit: 5 })
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (!r?.ok || !r.feel || !r.show) continue
      return { kind: '分享', id: `watch:${r.at}:${r.show}`, text: `你刚看完《${r.title || r.show}》${r.ep ? `第 ${r.ep} 集` : ''}：${String(r.plot || '').slice(0, 80)}。你自己的感受：${String(r.feel).slice(0, 60)}` }
    }
  } catch (e) { swallow(e, 'webpush:motive-watch') }
  // 3. 日记：刚写完（私人那本的头几句最有真心）
  try {
    const lines = fs.readFileSync(diaryPath('private'), 'utf8').trim().split('\n').filter(Boolean)
    const heads = lines.map((l, i) => ({ l, i })).filter((x) => x.l.startsWith('## '))
    const last = heads[heads.length - 1]
    if (last) {
      const m = String(last.l).match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
      const ts = m ? new Date(m[1].replace(' ', 'T')).getTime() : 0
      if (ts && now - ts < 45 * 60_000) {
        const body = lines.slice(last.i + 1, last.i + 4).join(' ').slice(0, 80)
        if (body) return { kind: '心情', id: `diary:${ts}`, text: `你刚写完一小段日记：「${body}」（照这个心情说，别念原文）` }
      }
    }
  } catch (e) { swallow(e, 'webpush:motive-diary') }
  return null
}

/**
 * 算这一轮要不要说话、说什么。纯计划，不发送、不改台账。
 * @returns {{ok:false, why:string} | {ok:true, kind:string, motiveId:string, instruction:string}}
 */
export function planProactive({ cfg, force = false, now = Date.now() } = {}) {
  const pc = cfg?.webui?.proactive ?? {}
  if (pc.enabled !== true) return { ok: false, why: 'webui.proactive 未开启' }
  const day = new Date(now).toLocaleDateString('sv-SE')   // 本地日期（UTC 的 toISOString 会让凌晨配额错位 8 小时）
  let st = readWake()
  if (st.day !== day) {
    // 跨天：只重置今日次数/台账/队列；lastAt/lastLine 保留 —— 否则零点一过安静期就被人为清零。
    const rolled = { day, fired: 0, lastAt: Number(st.lastAt || 0), lastType: '', lastLine: String(st.lastLine || ''), used: [], queue: [] }
    if (!rolled.lastAt) { rolled.lastAt = now; writeWake(rolled) }   // 首次见文件：种下起跑点（启动宽限，照 qq 主动搭话 startupGrace 的教训）
    st = rolled
  }
  const dailyMax = Number(pc.dailyMax ?? 3)
  if (dailyMax > 0 && Number(st.fired || 0) >= dailyMax) return { ok: false, why: '今天次数用完' }
  const used = Array.isArray(st.used) ? st.used.slice(-50) : []
  const wasUsed = (id) => used.includes(id)

  // 由头队列：先看攒着的（过期/已用的剔掉）
  let queue = (Array.isArray(st.queue) ? st.queue : []).filter((q) => q && now - Number(q.at || 0) < MOTIVE_TTL && !wasUsed(q.id))
  let motive = queue.length ? queue[0] : null

  if (!motive) {
    // 主动性结果塑形（2026-11-03）：接住多的时段兜底门槛更低（更愿意开口），吃闭门羹多的时段门槛更高
    const aff = slotAffinity(now)
    const quietH = Number(pc.quietHours ?? 8) / aff
    const quietDue = quietH > 0 && now - Number(st.lastAt || 0) >= quietH * 3600_000
    if (!force && !quietDue) return { ok: false, why: '由头没有、安静期未到' }
    // 该兜底了（或手动触发）：先找个由头；找不到才走「就是想说话」
    motive = tryMotive(now)
    if (motive && wasUsed(motive.id)) motive = null
    if (motive && !queue.some((q) => q.id === motive.id)) queue.push({ ...motive, at: now })
    else if (!motive && !force) return { ok: false, why: '由头没有、安静期刚到但没有可说的' }
  }
  const fallback = !motive
  if (fallback) motive = { kind: '日常', id: `quiet:${day}:${Number(st.fired || 0)}`, text: '' }
  const slot = hourSlot(new Date(now).getHours())
  const moodNow = (() => { try { return JSON.parse(fs.readFileSync(dataPath('mood.json'), 'utf8')) ?? {} } catch { return {} } })()
  const motiveLine = fallback
    ? '没有特别的由头 —— 就是你这会儿心里正好有话想说，或者想他了。照实说此刻的样子。'
    : `**这次的由头**：${motive.text}`
  const instruction = [
    `【主动说话】这不是回答谁 —— 是你自己要开口。现在${slot}，对面就是他本人，他想起来就会看。`,
    motiveLine,
    `你手上的真实材料（自然地用，别照念）：情绪值 ${Math.round(Number(moodNow.value) || 60)}/100${Number(moodNow.hunger) >= 80 ? '（有点饿了）' : ''}`
      + (st.lastLine ? `；你上一次主动说的是「${String(st.lastLine).slice(0, 50)}」—— 别重复同样的意思` : ''),
    '像你在聊天框里随手发的一条消息：一两句话，自然具体。别提"由头/系统/提示"这些词，别解释你为什么发，别问"在吗"。说完就停，别接着做别的任务。',
  ].join('\n')
  // 队列修剪结果落盘（只是清理，不改 fired/lastAt —— 那要等真发出去）
  writeWake({ ...st, queue })   // 选中的由头留在队列，markFired 才摘除 —— prompt 失败不丢
  return { ok: true, kind: motive.kind, motiveId: motive.id, instruction }
}

/** 真发出去了才记：fired/lastAt/used。由 scheduler 或面板路由在 prompt 成功后调用。 */
/** 发出后记一笔「这条在等回应」；主人下一条 QQ 私聊到达时由 outcome() 结账。 */
export function pendingOutcome({ kind = '', now = Date.now() } = {}) {
  try {
    updateWake((st) => ({ ...st, pending: { at: now, kind: String(kind || '') } }))
  } catch (e) { swallow(e, 'webpush:pendingOutcome') }
}

/**
 * 结果学习：主人来话了 → 刚才那条主动消息有没有被接住。
 * 30 分钟内回复 = 接住；更久 = 没接住。样本 ≥5 才开始漂时段（防迷信）。
 * 漂移：接住多的时段 slot 微涨（slots 归一化到均值 1.0）。
 */
export function outcome({ replied = false, now = Date.now() } = {}) {
  try {
    let applied = false
    updateWake((st) => {
      const p = st.pending
      if (!p || now - Number(p.at || 0) > 30 * 60_000) return { ...st, pending: null }
      const slot = hourSlot(new Date(Number(p.at)).getHours())
      const slots = { ...(st.slots || {}) }
      slots[slot] = Number(slots[slot] || 0) + (replied ? 1 : -0.3)
      const outcomes = Number(st.outcomes || 0) + 1
      st.pending = null
      applied = true
      return { ...st, slots, outcomes }
    })
    return applied
  } catch (e) { swallow(e, 'webpush:outcome'); return false }
}

/** 主动性结果塑形用：当前时段偏好（归一化）。 */
export function slotAffinity(now = Date.now()) {
  try {
    const st = readWake()
    if (Number(st.outcomes || 0) < 5) return 1   // 样本不足：不偏不倚
    const slot = hourSlot(new Date(now).getHours())
    const slots = st.slots || {}
    const vals = Object.values(slots)
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1)
    const v = Number(slots[slot] || 0)
    return mean === 0 ? 1 : Math.max(0.3, Math.min(2.0, (v - mean) / Math.abs(mean || 1) + 1))
  } catch (e) { return 1 }
}

export function markFired({ kind = '', motiveId = '', line = '', now = Date.now() } = {}) {
  const day = new Date(now).toLocaleDateString('sv-SE')   // 同上：本地日期
  const st = readWake()
  const cur = st.day === day ? st : { day, fired: 0, lastAt: 0, lastType: '', lastLine: '', used: [], queue: [] }
  const used = Array.isArray(cur.used) ? cur.used.slice(-49) : []
  if (motiveId) used.push(motiveId)
  writeWake({
    day, fired: Number(cur.fired || 0) + 1, lastAt: now,
    lastType: String(kind || cur.lastType || ''), lastLine: String(line || cur.lastLine || '').slice(0, 120),
    used, queue: (cur.queue || []).filter((q) => q?.id !== motiveId),
  })
}

/** 面板/自检用：当前状态一览。 */
export function wakeState() {
  const st = readWake()
  return { day: st.day || '', fired: Number(st.fired || 0), lastAt: Number(st.lastAt || 0) || null, lastType: st.lastType || '', lastLine: st.lastLine || '', queued: (st.queue || []).length, outcomes: Number(st.outcomes || 0), slots: st.slots || {}, pending: !!st.pending }
}
