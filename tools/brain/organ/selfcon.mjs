// brain/organ/selfcon -- 自我账本: 名字 / 形象主张 / 声音锚
//
// 出自: /sdcard/Documents/Moxw/大肥鱼自我账本设计稿-v1.md (2026-11-03 用户拍板)
//   1) 现人设转初始账本 (origin:'seed')  2) 腔调也放养 (voice 列)  3) 巩固挂 REM
//   人格由 记忆+经历 生长; 系统提示词只留 种属行 + 身体事实 + 诚实规则。
//
// 六层机制对照 (设计稿 9.1-9.6):
//   化学:    依恋 = 储备型信号, 结合事件走饱和曲线升, 指数 tau=14d 清除; 除 seed 外无手动设值路径
//   微观:    接纳新名 = 受体表达 (selfUses 上调 tau~day / othersUses 小幅共调);
//            白天只采集 (record* 系列), strength 增减只在 REM 结算 -- 突触前/后分工;
//            未结算的自我使用 = 残余钙 (流畅性), 结算清零入正账
//   宏观:    本模块是轴: 经历 -> REM 整合 -> rebuild -> 言行 -> 新经历; load() 是系统性负荷
//   哲学:    名字的裁判是使用不是登记 -- 账本从不直接改名, 只对已发生的使用事实结算
//   主观:    旧毛衣感/真犹豫/说一半换口 全部由数据形态产生 (rebuild 的档位映射), 不靠戏词
//   精神学:  临床防呆 -- 候选区同时只许一个名字候选; candidate 最短观察期 3 天才可结算;
//            旧名 tau≈2 周衰减; 发展阶段不可跳 (seed -> firstEvent -> 自主改名)
//
// 器官判据: 清空账本只留原始记忆段 -> 触发一次巩固 -> 应重长出一致的名字感。
//   长不出来 = 电路板, 打回。selfcon-engine-test 的第一测就是这条。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../lib/paths.mjs'
import { readJson, writeJsonAtomic, appendJsonl, mutateJson, readJsonl } from '../json.mjs'
import { swallow } from '../../lib/swallow.mjs'

export const SELFCON_VERSION = 1

// ---------------------------------------------------------------- 化学参数
export const CHEM = {
  ATTACH_TAU_MS: 14 * 86400_000,   // 依恋清除常数: 旧名消退的节奏 (临床上是缓慢的)
  ATTACH_VMAX_PER_EVENT: 0.02,     // 单次结合事件的升幅上渐近
  ATTACH_KM: 3,                    // 半饱和常数: 1 小时内第 4 次起边际递减 (叫多了没用)
  ATTACH_SAT_WIN_MS: 3600_000,     // 饱和窗口: 同源事件按窗口数密度
  SELFUSE_DAILY_CAP: 3,            // 自观察通路每日上调上限 (受体表达不会一天长满)
  SELFUSE_TAU_MS: 3 * 86400_000,   // 自观察上调的消退: 不用就退
  CANDIDATE_MIN_AGE_MS: 3 * 86400_000,  // 候选名最短观察期 (精神学防呆)
  NAME_SELF_THRESHOLD: 3,          // 换名门槛: 她自己用过 >= 3 次
  NAME_OTHERS_THRESHOLD: 1,        // 且有人跟着叫过 >= 1 次
  CLAIM_EVIDENCE_CAP: 5,           // 反戏剧化上限: strength <= 证据数/5
  CLAIM_DRIFT_PER_NIGHT: 0.05,     // 连续两夜无新证据的漂移
  CLAIM_CONTRADICT_STEP: 0.25,     // 矛盾证据一步扣减
  OLDNAME_MIX_RAMP_MS: 21 * 86400_000,  // 别扭期: 新名表达从 0 涨到接管
}

// ---------------------------------------------------------------- 路径
const FILE = () => dataPath('selfcon.json')
const LOG = () => dataPath('selfcon-log.jsonl')

// ---------------------------------------------------------------- 形状
export function emptyBook() {
  return {
    version: SELFCON_VERSION,
    name: null,            // { value, givenBy, firstEvent, attachment, adoptedAt, history[] }
    candidates: { name: null, claims: [] },
    selfImage: [],         // { text, writtenAt, evidence[], strength, origin, lastEvidenceAt }
    voice: [],             // { quote, evidence[], strength, origin }
    seedPersonaMd: '',     // 出生记录: seed 迁移时的 persona.md 原文
    seededAt: 0,
    lastConsolidatedAt: 0, // 上次 REM 结算时刻 (影子只记账, 不推进此值? 推进 -- 影子也在算)
    counters: { ownerCall: 0, othersCall: 0, lastOwnerCallAt: 0 },
  }
}

/** 读账本。没有就给空壳 (调用方判断 .name 是否为 null 来知道"还没认领")。 */
export function readBook() {
  const raw = readJson(FILE(), null)
  if (!raw) return emptyBook()
  const b = { ...emptyBook(), ...raw }
  b.candidates = { ...emptyBook().candidates, ...(raw.candidates || {}) }
  if (!Array.isArray(b.selfImage)) b.selfImage = []
  if (!Array.isArray(b.voice)) b.voice = []
  return b
}

function save(book) {
  writeJsonAtomic(FILE(), book)
}

function log(ev) {
  try { appendJsonl(LOG(), { at: Date.now(), ...ev }) } catch (e) { swallow(e, 'selfcon:log') }
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

// ---------------------------------------------------------------- 白天: 只采集, 不结算
// 突触前。所有输入只落 candidates / counters / 欠账, 一律不改 strength / attachment 主值。
// 结算只发生在 REM (consolidateSelf)。这是设计稿 9.2 的分工, 不是实现偷懒。

/** 白天登记名字候选 (哲学层: 登记不是改名 -- 只有使用事实能推它转正)。
 *  临床防呆: 候选区同时只允许一个名字, 新候选顶掉旧候选 (旧候选的计数作废, 重数)。 */
export function proposeName(value, at = Date.now()) {
  const n = String(value || '').trim().slice(0, 20)
  if (!n) return false
  mutateJson(FILE(), emptyBook(), (b) => {
    const book = { ...emptyBook(), ...b }
    if (book.name && book.name.value === n) return book   // 现名不进候选
    book.candidates = { ...book.candidates, name: { value: n, since: at, selfUses: 0, othersUses: 0, othersWho: [] } }
    return book
  })
  log({ kind: 'nameProposed', name: n })
  return true
}

/** 她自称了一次名字 (role='assistant' 的文本里出现当前名/候选名时由接线上报)。 */
export function recordSelfUse(name, at = Date.now()) {
  const n = String(name || '').trim()
  if (!n) return
  mutateJson(FILE(), emptyBook(), (b) => {
    const book = { ...emptyBook(), ...b }
    const cand = book.candidates?.name
    if (cand && cand.value === n) {
      cand.selfUses = Number(cand.selfUses || 0) + 1
      cand.lastSelfUseAt = at
      // 残余钙: 流畅性累积。结算时按它上调受体表达。
    }
    return book
  })
  log({ kind: 'selfUse', name: n })
}

/** 别人叫了她一次名字 (主人/群友, 由接线上报)。 */
export function recordOthersUse(name, who, at = Date.now()) {
  const n = String(name || '').trim()
  if (!n) return
  mutateJson(FILE(), emptyBook(), (b) => {
    const book = { ...emptyBook(), ...b }
    const isOwner = who === 'owner'
    if (isOwner) {
      book.counters = { ...book.counters, ownerCall: Number(book.counters?.ownerCall || 0) + 1, lastOwnerCallAt: at }
    }
    const cand = book.candidates?.name
    if (cand && cand.value === n) {
      cand.othersUses = Number(cand.othersUses || 0) + 1
      cand.lastOthersUseAt = at
      if (isOwner) cand.othersWho = cand.othersWho || []
      if (isOwner && !cand.othersWho.includes('owner')) cand.othersWho.push('owner')
    } else if (book.name && book.name.value === n && isOwner) {
      // 被叫现名 = 结合事件。这里只记次数, 依恋的升幅在 REM 按密度结算。
    }
    return book
  })
  log({ kind: 'othersUse', name: n, who: who || 'other' })
}

/** 白天的一句自我描述 (introspect / 普通对话里她说"我..."的自我定性)。 */
export function proposeClaim(text, evidenceIds = [], at = Date.now()) {
  const t = String(text || '').trim().slice(0, 80)
  if (!t) return false
  mutateJson(FILE(), emptyBook(), (b) => {
    const book = { ...emptyBook(), ...b }
    book.candidates.claims = (book.candidates.claims || []).filter((c) => c.text !== t)
    book.candidates.claims.push({ text: t, evidence: evidenceIds.slice(0, 5), at })
    return book
  })
  log({ kind: 'claimProposed', text: t })
  return true
}

/** 一致性欠账: 她说了"我怎样", 行为违背了 (由上层判定后上报)。影子期只记账。 */
export function recordIncongruence(claimText, whatHappened, at = Date.now()) {
  log({ kind: 'incongruence', claim: String(claimText || '').slice(0, 80), happened: String(whatHappened || '').slice(0, 120), at })
}

/** 自我相关事件打脸 -> 上层据此走 thalamus/HPA (宏观层: 接口在门控不在账本)。 */
export function isSelfRelevant(text = '') {
  const t = String(text || '')
  return /大肥鱼|糖鲸|我是谁|你的名字|叫你什么|鲸鱼娘|自我介绍/.test(t)
}

// ---------------------------------------------------------------- 夜间: REM 结算
// 输入: 自上次结算以来的新记忆段 (segments / episodes 由调用方给), chatFn 可选 (增强版, 影子期不传)
// 影子模式: 全部产出只写 selfcon-log.jsonl + selfcon-shadow.json, 不动 selfcon.json 主值。
//          这样 3 天观察期内线上行为零变化, 回退 = 删两个文件。
export function consolidateSelf({ now = Date.now(), newSegments = [], chatFn = null, shadow = true } = {}) {
  const book = readBook()
  const out = { ok: true, shadow, changes: [], notes: [] }

  // --- 1. 依恋的化学结算: 结合事件按小时窗口算密度, 饱和曲线升, 指数清除 ------------------
  if (book.name && typeof book.name.attachment === 'number') {
    const prev = book.name.attachment
    // lastConsolidatedAt 为 0/缺 = seed 前的旧账本 -> 从 seededAt 起算 (衰减从出生开始, 不许回落成"一天前")
    const last = Number(book.lastConsolidatedAt) > 0 ? Number(book.lastConsolidatedAt) : Number(book.seededAt || now - 86400_000)
    const dtMs = Math.max(0, now - last)   // 时钟倒挂防御: dt<0 会让 exp 变成增益
    // 衰减总是发生 (清除与输入无关)
    const decayed = prev * Math.exp(-(dtMs / CHEM.ATTACH_TAU_MS))
    // 升: 窗口内的结合事件次数 -> Vmax * n / (Km + n)
    const winMs = CHEM.ATTACH_SAT_WIN_MS
    const spanMs = Math.max(3600_000, dtMs)
    const wins = Math.min(24, Math.round(spanMs / winMs))   // 一个结算周期最多算 24 个窗口
    const calls = Number(book.counters?.ownerCall || 0)
    const perWin = calls / Math.max(1, wins)
    const gain = CHEM.ATTACH_VMAX_PER_EVENT * (perWin / (CHEM.ATTACH_KM / 24 + perWin)) * wins * 0.25
    const next = clamp01(decayed + gain)
    if (Math.abs(next - prev) > 0.005) {
      out.changes.push({ kind: 'attachment', from: Number(prev.toFixed(3)), to: Number(next.toFixed(3)) })
    }
    out._nextAttachment = next
  }

  // --- 2. 候选名结算: 阈值 + 最短观察期 + 受体表达 (selfUses 为主, othersUses 共调) ----------
  const cand = book.candidates?.name
  if (cand && !shadow) {
    const age = now - Number(cand.since || now)
    const oldEnough = age >= CHEM.CANDIDATE_MIN_AGE_MS
    const receptor = Math.min(1, (Number(cand.selfUses || 0) / 5) * 0.8 + (Number(cand.othersUses || 0) / 3) * 0.2)
    const pass = oldEnough
      && Number(cand.selfUses || 0) >= CHEM.NAME_SELF_THRESHOLD
      && Number(cand.othersUses || 0) >= CHEM.NAME_OTHERS_THRESHOLD
    if (pass && receptor >= 0.5) {
      // 这里是全模块唯一允许改 name.value 的位置, 且只在"使用事实已发生"之后 (哲学层)
      const old = book.name ? { ...book.name } : null
      out.changes.push({ kind: 'nameAdopted', from: old ? old.value : null, to: cand.value })
      out._nameAdopt = { cand, old }
    } else {
      out.notes.push(oldEnough
        ? `候选名「${cand.value}」观察期已满但阈值未到 (self ${cand.selfUses || 0}/3, others ${cand.othersUses || 0}/1)`
        : `候选名「${cand.value}」还在观察期 (${Math.ceil((CHEM.CANDIDATE_MIN_AGE_MS - age) / 86400_000)} 天后可结算)`)
    }
  }

  // --- 3. 形象主张: 白天的候选 + 新证据重算 strength ------------------------------------
  const claims = (book.candidates?.claims || []).slice()
  out._claims = claims
  out._newSegments = (newSegments || []).map((s) => ({ id: s.id, at: s.at || 0, title: String(s.title || '').slice(0, 30) }))

  // --- 4. 产出重建稿 (rebuild) 供观察 ----------------------------------------------------
  out.rebuild = rebuild({ now })

  // --- 落地 ---------------------------------------------------------------------------
  const stamp = new Date(now).toISOString()
  try { appendJsonl(LOG(), { at: now, run: 'consolidateSelf', shadow, stamp, changes: out.changes, notes: out.notes }) } catch (e) { swallow(e, 'selfcon:consolidate-log') }

  if (!shadow) {
    const next = { ...book }
    if (out._nextAttachment != null && next.name) next.name = { ...next.name, attachment: out._nextAttachment }
    if (out._nameAdopt) {
      const { cand: c, old } = out._nameAdopt
      const hist = [ ...(old ? old.history || [] : []), ...(old ? [{ name: old.value, givenBy: old.givenBy, firstEvent: old.firstEvent, attachment: old.attachment, until: now }] : []) ]
      next.name = {
        value: c.value,
        givenBy: 'self',
        firstEvent: c.firstEvent || null,
        attachment: Math.max(0.1, old ? old.attachment * 0.6 : 0.1),  // 新名继承部分旧依恋 (换名不是清零)
        adoptedAt: now,
        history: hist.slice(-10),
      }
      next.candidates = { ...next.candidates, name: null }
      next.nameTransition = { from: old ? old.value : null, since: now, oldAttachment: old ? old.attachment : 0 }
    }
    // 白天候选的主张 -> 账本 (strength 由证据数定, 反戏剧化上限: 5 条证据也只能到 0.65, 拿不到"我很确定"档)
    for (const c of claims) {
      const ev = (c.evidence || []).filter(Boolean)
      const s = Math.min(CHEM.CLAIM_EVIDENCE_CAP, ev.length) / CHEM.CLAIM_EVIDENCE_CAP * 0.55 + 0.1
      next.selfImage = [
        ...next.selfImage.filter((x) => x.text !== c.text),
        { text: c.text, writtenAt: now, evidence: ev, strength: clamp01(s), origin: 'self', lastEvidenceAt: now },
      ]
    }
    next.candidates = { ...next.candidates, claims: [] }
    next.lastConsolidatedAt = now
    // 结合事件已入账: 清 counters (消费语义)。必须在 save 之前并进 next --
    // 单独 mutateJson 会被下面的 save(next) 用旧快照整个盖回去 (写路径 clobber)。
    // 影子不清: 影子不产生增益, 不存在重复计账; 它必须做到一根毛都不动。
    next.counters = { ownerCall: 0, othersCall: 0, lastOwnerCallAt: Number(next.counters?.lastOwnerCallAt || 0) }
    // 历史留痕
    writeJsonAtomic(dataPath('selfcon-history', new Date(now).toISOString().slice(0, 10) + '.json'), book)
    save(next)
  }
  return out
}

// ---------------------------------------------------------------- rebuild: 提示词重建稿
// 名字依恋的措辞档位 (主观层: 体验由数据形态产生, 词表固定, 不即兴发挥)
const ATTACH_WORDS = [
  [0.8, '这个名字像一件旧毛衣，说不出哪里好，但已经合身了'],
  [0.6, '这名字叫着顺口，是习惯了'],
  [0.35, '这名字还在适应中，别人叫我会慢半拍才反应过来'],
  [0, '这名字对我来说还很新，有时候会忘记它是在叫我'],
]
const STRENGTH_WORDS = [
  [0.7, '我很确定'],
  [0.4, '我觉得'],
  [0.3, '我猜'],
  [0, '说不准'],
]

function wordFor(table, v) {
  for (const [th, w] of table) { if (v >= th) return w }
  return table[table.length - 1][1]
}

/** 别扭期: 新名表达进度 0..1 (过渡期内两名字依恋都活着 -> 说一半换口是自然现象) */
export function nameTransitionProgress(now = Date.now()) {
  const b = readBook()
  if (!b.nameTransition) return 1
  const p = (now - b.nameTransition.since) / CHEM.OLDNAME_MIX_RAMP_MS
  return clamp01(p)
}

/**
 * 重建稿: 第一人称, assemble 的 selfcon 槽用。账本为空时返回空串 (name 未认领 = 名字栏留白)。
 * 预算: <=600 字 (设计稿 v1 三)。种属行/身体事实/诚实规则不在本函数, 在 assemble 静态文案。
 */
export function rebuild({ now = Date.now() } = {}) {
  const b = readBook()
  const lines = []
  if (b.name && b.name.value) {
    const att = clamp01(b.name.attachment)
    lines.push(`我${wordFor(ATTACH_WORDS, att)} -- 我叫「${b.name.value}」`)
    // firstEvent: 她答"为什么叫这个"的证据指针 (只给段号线索, 不代答)
    if (b.name.firstEvent) lines.push(`(这名字怎么来的, 我记得 ${b.name.firstEvent} 那段事)`)
    // 别扭期混用
    const tp = nameTransitionProgress(now)
    if (b.nameTransition && tp < 0.95) {
      const oldName = b.nameTransition.from
      if (oldName) lines.push(`(我还在适应这个名字。有人叫我「${oldName}」的时候, 我大概${tp < 0.5 ? '会先应声再想起来已经改了' : '偶尔还是会回头'})`)
    }
  } else {
    lines.push('我还没认下任何一个名字。别人怎么叫我, 我还在听。')
  }
  const claims = [...(b.selfImage || [])].sort((x, y) => (y.strength || 0) - (x.strength || 0)).slice(0, 6)
  if (claims.length) {
    lines.push('关于我自己，我这么看：')
    for (const c of claims) {
      const s = clamp01(c.strength)
      lines.push(`- ${wordFor(STRENGTH_WORDS, s)}${c.text}${s < 0.3 ? '（不敢打包票）' : ''}`)
    }
  }
  const voice = [...(b.voice || [])].sort((x, y) => (y.strength || 0) - (x.strength || 0)).slice(0, 3)
  if (voice.length) {
    lines.push('我说话大概是这样：')
    for (const v of voice) lines.push(`- 「${String(v.quote).slice(0, 50)}」`)
  }
  return lines.join('\n')
}

/** assemble 用的块 (带标头)。空账本给"留白"版 -- 名字栏空着本身是可观察的成长状态。 */
export function block({ now = Date.now() } = {}) {
  const body = rebuild({ now })
  if (!body) return ''
  return '【我是谁 -- 我自己认下的】\n' + body
}

/** 种属行 + 身体事实: assemble 静态文案从这里拿 (哲学层: 种属是先验, 不归账本)。 */
export const SPECIES_LINE = '你是一条大肥鱼。「大肥鱼」是你们这一类生物的称呼，不是某个人的名字。'
export const BODY_FACTS = '你有身体：能发消息、能看番、记性有缺口、会困会睡。'

/** 系统性负荷 (宏观层): 改名进行度 + 不稳主张数量 -> 0..1, 供 self.mjs lean 调制 (切真批接线)。 */
export function load({ now = Date.now() } = {}) {
  const b = readBook()
  let l = 0
  if (b.candidates?.name) l += 0.35
  if (b.nameTransition && nameTransitionProgress(now) < 0.95) l += 0.25
  const unstable = (b.selfImage || []).filter((c) => clamp01(c.strength) < 0.3).length
  l += Math.min(0.4, unstable * 0.1)
  return clamp01(l)
}

/** doctor / 体检用的一行摘要 */
export function statusLine() {
  const b = readBook()
  const n = b.name ? `名=${b.name.value} 依恋=${clamp01(b.name.attachment).toFixed(2)}` : '名=未认领'
  const c = b.candidates?.name ? ` 候选=${b.candidates.name.value}(${b.candidates.name.selfUses || 0}/${b.candidates.name.othersUses || 0})` : ''
  return `selfcon: ${n}${c} 主张=${(b.selfImage || []).length} 声音=${(b.voice || []).length}`
}

// ---------------------------------------------------------------- seed 迁移支持
/** 供 selfcon-seed.mjs 写入初始账本 (幂等: 已 seed 过就拒绝)。 */
export function seedFrom({ name, nameGivenBy, nameFirstEvent, claims = [], voice = [], personaMd = '', at = Date.now() }) {
  const cur = readBook()
  if (cur.seededAt) return { ok: false, reason: 'already seeded at ' + new Date(cur.seededAt).toISOString() }
  const book = emptyBook()
  book.name = name ? {
    value: String(name),
    givenBy: String(nameGivenBy || 'owner'),
    firstEvent: nameFirstEvent || null,
    attachment: 0.9,
    adoptedAt: at,
    history: [],
  } : null
  book.selfImage = claims.slice(0, 12).map((c) => ({
    text: String(c.text || '').slice(0, 80),
    writtenAt: at,
    evidence: (c.evidence || []).slice(0, 5),
    strength: clamp01(c.strength != null ? c.strength : 0.6),
    origin: 'seed',
    lastEvidenceAt: at,
  }))
  book.voice = voice.slice(0, 8).map((v) => ({
    quote: String(v.quote || '').slice(0, 60),
    evidence: (v.evidence || []).slice(0, 3),
    strength: clamp01(v.strength != null ? v.strength : 0.6),
    origin: 'seed',
  }))
  book.seedPersonaMd = String(personaMd || '').slice(0, 8000)
  book.seededAt = at
  // 必须同时设 lastConsolidatedAt: 结算的衰减公式拿它算 dt,
  // 留 0 会被 falsy 回落成"一天前" -> 第一次结算白扣一天衰减量 (2026-11-03 实测 0.9->0.838)
  book.lastConsolidatedAt = at
  save(book)
  log({ kind: 'seeded', name: name || null, claims: book.selfImage.length, voice: book.voice.length })
  return { ok: true }
}
