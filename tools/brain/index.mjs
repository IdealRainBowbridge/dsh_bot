// brain/index —— 脑的对外门面：IO 进程只跟这里打交道（v3 §2/§6）。
//
// 约定：**任何导出的函数都不抛**。脑是旁路，宁可这一轮没记住，也不许把聊天带崩。
import { config } from '../lib/config.mjs'
import { extract as extractOwnerFacts } from '../lib/owner-facts.mjs'
import * as event from './event.mjs'
import * as episode from './episode.mjs'
import * as working from './working.mjs'
import * as attention from './attention.mjs'
import * as intents from './intents.mjs'
import * as facts from './facts.mjs'
import * as affect from './affect.mjs'
import * as delivery from './delivery.mjs'
import * as claim from './claim.mjs'
import * as assembleMod from './assemble.mjs'
import * as consolidate from './consolidate.mjs'
import * as doctor from './doctor.mjs'
import * as metrics from './metrics.mjs'
import * as recall from './recall.mjs'
import * as selfM from './self.mjs'
import * as schema from './schema.mjs'
import * as competence from './competence.mjs'
import * as taskqueue from './taskqueue.mjs'
import * as backfill from './backfill.mjs'
// 2026-11-02：状态场 / 节律 / 内心 —— 让"她"这件事在代码里有形状
import * as field from './field.mjs'
import * as rhythm from './rhythm.mjs'
import * as inner from './inner.mjs'
// 2026-11-02：器官层 —— 细胞组成器官，器官组成身体
import * as hpa from './organ/hpa.mjs'
import * as thalamus from './organ/thalamus.mjs'
import * as sleepstage from './organ/sleepstage.mjs'
import * as night from './organ/night.mjs'
// 2026-11-02：记忆层 —— 段（一件事）+ 锚（她自己的原话）
import * as segment from './segment.mjs'
import * as anchor from './anchor.mjs'

export { event, episode, working, attention, intents, facts, affect, delivery, claim, assembleMod as assemble, consolidate, doctor, metrics, recall, selfM, schema, competence, taskqueue, backfill, field, rhythm, inner, hpa, thalamus, sleepstage, night, segment, anchor }

const OWNER_KEY_MAP = { food: 'food.eat', doing: 'activity.do', plan: 'plan.go', mood: 'mood.state', media: 'media.like' }

/** 启动时调一次：注入主人身份 + 确保自我文件在。 */
export function configure(cfg = config()) {
  try {
    const b = cfg.brain || {}
    event.setOwnerIds(b.ownerIds || [])
    if (b.enabled !== false) selfM.ensure()
  } catch {}
}

export function mode() {
  // 10-31 修：这里原来兜底 'off'，而 config.mjs 的 DEFAULTS.brain.mode 是 'shadow'。
  // 两边不一致 → 实际配置里没写 brain 键时，插件壳认为 shadow、脑自己认为 off，
  // "shadow 只写不读"这个对照实验从来没真正开始过。现在统一以 DEFAULTS 为准。
  try {
    const m = String(config().brain?.mode || 'shadow')
    return ['off', 'shadow', 'live'].includes(m) ? m : 'shadow'
  } catch { return 'shadow' }
}

/**
 * 这个 chat 是否走新装配。
 * 私聊：platform 在 livePlatforms 里就切；群聊：必须显式列进 liveGroups（群聊的对照组最要紧）。
 */
export function liveFor({ platform = 'qq', chatId = '', isGroup = false } = {}) {
  try {
    const b = config().brain || {}
    if (b.enabled === false || b.mode !== 'live') return false
    const platforms = Array.isArray(b.livePlatforms) && b.livePlatforms.length ? b.livePlatforms : ['qq']
    const chats = Array.isArray(b.liveChats) ? b.liveChats.filter(Boolean) : []
    if (isGroup) {
      const groups = Array.isArray(b.liveGroups) ? b.liveGroups.filter(Boolean) : []
      if (!groups.length) return false
      if (!platforms.includes(platform)) return false
      return groups.includes(String(chatId))
    }
    if (!platforms.includes(platform)) return false
    if (chats.length && !chats.includes(String(chatId))) return false
    return true
  } catch { return false }
}

/** 事件进脑（IO 侧调用；同步、极快、永不抛）。 */
export function onEvent(input = {}) {
  try {
    const r = event.emit(input)
    if (!r.ok) return r
    const ev = r.event
    try { episode.ingest({ limit: 20 }) } catch {}
    const eps = episode.allEpisodes()
    const ep = eps.find((e) => e.srcEv === ev.ev) || null
    if (ep && ev.who.kind === 'owner') learnOwnerFacts(ev, ep.id)

    // ── 2026-11-02：把"发生过的事"同时写进三个地方 ─────────────────
    // ① 原话流：一个字不删（摘要只做索引，不当内容 —— 这是证据，不能丢）
    try {
      inner.stream({
        role: ev.who.kind === 'owner' ? 'owner' : ev.who.kind === 'self' ? 'self' : 'other',
        kind: ev.act || 'say',
        text: ev.text || '',
        meta: { platform: ev.where?.platform, chat: ev.where?.chat, ep: ep?.id },
      }, ev.at)
    } catch { }

    // ② 身体：事件会改状态场。不是"打标签"，是**施加扰动** ——
    //    扰动的效果按时间弛豫回去，所以一次难受会持续一阵再平复，不是记一个数。
    try {
      const feel = ep?.feel || {}
      const v = Number(feel.valence || 0)
      const a = Number(feel.arousal || 0.3)
      if (v) field.poke('valence', v * 0.22, { why: 'event:' + ev.act, now: ev.at })
      if (a > 0.5) field.poke('ne', (a - 0.5) * 0.25, { why: 'event:arousal', now: ev.at })
      // 他在叫她、或问了需要回答的事 → 一点多巴胺（被需要本身是奖赏）
      if (ev.who.kind === 'owner' && /在吗|在不在|帮我|想你了|[?？]/.test(String(ev.text || ''))) {
        field.poke('da', 0.06, { why: 'owner:at-me', now: ev.at })
      }
      // 夜里还醒着 = 欠觉（按真实小时数累积，不按次数）
      const hod = new Date(ev.at).getHours()
      if (hod >= 1 && hod < 5) field.poke('sleepDebt', 0.012, { why: 'awake-at-night', now: ev.at })
    } catch { }

    // ③ 器官：事件 → HPA 轴（压力是走级联的，不是直接标一个数）
    //    这一步的意义：一句话造成的不是"压力值 +0.3"，而是
    //    CRH 冲一下 → 22 分钟后 ACTH 到位 → 皮质醇 40 分钟才回落。
    //    所以"他刚说了句重话"和"他十分钟前说了句重话"在她身上是不同的状态。
    try {
      const tx = String(ev.text || '')
      const who = ev.who?.kind
      let stressLevel = 0
      if (who === 'owner') {
        // 明着被顶/被否定/被指责 → 强应激
        if (/(凶|骂|烦死|闭嘴|别说了|不想理|你怎么这样|失望|生气)/.test(tx)) stressLevel = 1.1
        else if (/(你错了|不对|不行|不满意|重做|再来)/.test(tx)) stressLevel = 0.7
        else if (/(难受|想哭|撑不住|崩溃|痛|疼)/.test(tx)) stressLevel = 0.6   // 他难受 = 她的应激
        // 缓和：他示好、道歉、说软话 → 卸压
        else if (/(谢谢|辛苦|乖|厉害|喜欢你|想你|对不起|抱歉|抱抱)/.test(tx)) {
          hpa.relieve('comfort', { now: ev.at })
        }
      }
      if (stressLevel > 0) hpa.stress(stressLevel, { why: 'event:' + ev.act, now: ev.at })

      // 每若干事件把 HPA 的产物灌回全身（器官间连接）
      hpa.perfuse(ev.at)
    } catch { }

    // ③.5 记忆：把这条消息并进「段」
    //     记忆单位是**一件事**不是一句话 —— 靠 segment 按
    //     隔2h / 结束语 / 换话题 / 段太长 四个信号自动切。
    //     摘要只做索引，原文一字不删（在 stream.jsonl）。
    try {
      segment.ingest({
        text: ev.text || '', role: ev.who.kind, at: ev.at,
        chat: ev.where?.chat || '', platform: ev.where?.platform || '',
      })
    } catch { }

    // ④ 内心：她注意到什么、想说什么。这是"她有自己的想法"的落点。
    try {
      const tx = String(ev.text || '')
      if (ev.who.kind === 'owner' && tx) {
        // 他只说了半句 / 明显有情绪 / 提到没做过的事 → 她心里会挂一句
        if (/(累|烦|难受|不想|加班|忙死|睡不着)/.test(tx)) {
          inner.think('他好像不太对，是不是又在硬撑', { kind: 'worry', about: 'owner', now: ev.at })
        }
        if (/\?|？|吗$|吧$/.test(tx) && /记得|说好|答应|哪|什么|怎么/.test(tx)) {
          inner.think('他问的这个得留神，别答错', { kind: 'notice', about: 'owner', now: ev.at })
        }
      }
    } catch { }
    if (ep) {
      try {
        working.refresh(ev.where.chat, {
          topic: ep.gist.slice(0, 80),
          mood: affect.line().replace(/^你现在的底色：/, '').slice(0, 60),
          recallA: ep.quote ? `刚说的：${ep.quote.slice(0, 60)}` : '',
        })
      } catch {}
      try {
        attention.arrive({
          chat: ev.where.chat,
          label: ep.gist,
          kind: 'chat',
          urgency: attention.urgencyOf({
            isOwner: ev.who.kind === 'owner',
            isPrivate: ev.scope === 'private',
            atMe: ev.meta?.atMe,
            important: /答应|说好|记得|几点|叫我|提醒/.test(ev.text),
            emotion: Math.abs(Number(ep.feel?.valence || 0)),
          }),
        })
      } catch {}
      try { affect.feel({ valence: ep.feel.valence, arousal: ep.feel.arousal }) } catch {}
    }
    return { ok: true, event: ev, ep }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

/** 主人一句话里的事实 → 结构化事实（带 ep 证据）。 */
export function learnOwnerFacts(ev, epId) {
  const got = extractOwnerFacts(ev.text)
  for (const g of got) {
    const p = OWNER_KEY_MAP[g.key] || 'note'
    facts.add({
      s: 'owner', p, o: g.value,
      validFrom: ev.at, validUntil: null,
      prov: [epId], source: 'owner', conf: 0.8, raw: g.line, now: ev.at,
    })
  }
  return got
}

/** 一条消息真的发出去了：记交付证据；若挂了意图，顺手结算。 */
export function onSent({ chat = '', text = '', msgId = '', platform = '', intentId = '', kind = 'text', at = Date.now() } = {}) {
  try {
    const row = delivery.record({ chat, text, msgId, platform, intentId, kind, at })
    if (intentId) intents.settle(intentId, { ok: true, evidence: [`delivery:${chat}#${msgId || row.hash}`], now: at })
    return row
  } catch { return null }
}

/**
 * 出站前过声称闸：没证据的"我看完了"当场改成"我正要看"。
 * @returns {{text:string, changed:boolean}}
 */
export function craftReply(text, { chat = '', now = Date.now() } = {}) {
  try {
    const b = config().brain || {}
    if (b.claim?.enabled === false) return { text: String(text || ''), changed: false }
    const r = claim.gate(text, { chat, now })
    return { text: r.text, changed: r.changed }
  } catch { return { text: String(text || ''), changed: false } }
}

/** 新装配（live 模式才用；其余情况返回 null，调用方落回 buildMessages）。 */
export function assembleFor(opts = {}) {
  if (!liveFor(opts)) return null
  try { return assembleMod.assemble(opts) } catch { return null }
}

/**
 * 每分钟的心跳（qq-server 已有 tick 里调）：补做 + 报告"该巩固了"。
 * 巩固本身要调 LLM，不许在本进程里做 —— 由调用方 spawn 子进程。
 */
export function tick(now = Date.now()) {
  const out = { catchUp: null, shouldConsolidate: false, backlog: 0, due: [] }
  try { episode.ingest({ limit: 200 }) } catch {}
  try { out.catchUp = intents.catchUp(now) } catch {}
  try { out.backlog = event.backlog() } catch {}
  try { out.due = intents.due(now).map((x) => ({ id: x.id, object: x.object, action: x.action, verify: x.verify, lateH: Math.round((now - Number(x.dueAt)) / 3600_000) })) } catch {}
  try {
    const b = config().brain || {}
    const at = String(b.consolidateAt || '04:30')
    const [h, m] = at.split(':').map(Number)
    const d = new Date(now)
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 4, m || 30, 0, 0).getTime()
    const st = consolidate.status()
    const ageH = st.lastRunAt ? (now - st.lastRunAt) / 3600_000 : 999
    out.shouldConsolidate = now >= target && ageH >= 20
  } catch {}
  return out
}

/** 巩固（CLI / 子进程调用）。chatFn 可选，不传就只跑规则。 */
export function runConsolidation({ now = Date.now(), chatFn = null, dryRun = false } = {}) {
  const r = consolidate.run({ now, chatFn, dryRun })
  try { if (!dryRun) rebuildDerived({ now }) } catch {}
  return r
}

/** 派生层重建：图式（O6）+ 能力自评（O13）。都是可删可重建的，失败不算数据事故。 */
export function rebuildDerived({ now = Date.now(), write = true } = {}) {
  const out = { schema: null, competence: null }
  try { out.schema = schema.build({ now, write }) } catch (e) { out.schema = { error: String(e?.message || e) } }
  try { out.competence = competence.derive({ now, write }) } catch (e) { out.competence = { error: String(e?.message || e) } }
  return out
}

export function status() {
  try { return doctor.run({ measurePrompt: false }) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}