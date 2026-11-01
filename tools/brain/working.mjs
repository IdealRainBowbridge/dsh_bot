// brain/working —— 工作记忆：7 个槽 + 抑制列表（v3 O3）。
//
// 旧的 `memory.recent(chatId, 24)` 是"最近 24 条"，实测只有 2.9 小时 ——
// 既没有容量上限，也没有"这件事现在别提"的表达能力，于是她要么忘，要么复读。
//
// 7 槽（每槽有预算，超了先砍 S4/S5）：
//   S1 当前意图  S2 话题锚点  S3 情绪  S4/S5 召回  S6 待办  S7 未完话头
//   + suppressed: 本轮明确不许提的主题（抑制，不是删除）
import { readJson, mutateJson } from './json.mjs'
import { workingPath } from './paths.mjs'
import { relTime } from './clock.mjs'

export const SLOTS = ['intent', 'topic', 'mood', 'recallA', 'recallB', 'todo', 'unfinished']
const BUDGET = { intent: 120, topic: 80, mood: 60, recallA: 220, recallB: 220, todo: 120, unfinished: 120 }

const empty = () => ({ slots: {}, suppressed: [], updatedAt: 0 })

export function load(chatId) {
  const j = readJson(workingPath(chatId), null)
  if (!j || typeof j !== 'object') return empty()
  return { ...empty(), ...j, slots: { ...(j.slots || {}) }, suppressed: Array.isArray(j.suppressed) ? j.suppressed : [] }
}

export function save(chatId, state) {
  return mutateJson(workingPath(chatId), empty(), () => ({ ...state, updatedAt: Date.now() }))
}

/** 写一组槽（undefined 的槽保持原样）。 */
export function refresh(chatId, patch = {}) {
  const cur = load(chatId)
  for (const k of SLOTS) {
    if (patch[k] === undefined) continue
    const v = String(patch[k] ?? '').trim()
    if (!v) delete cur.slots[k]
    else cur.slots[k] = v.slice(0, BUDGET[k])
  }
  return save(chatId, cur)
}

/** 抑制一个主题（"南京菜单别再提了"），到期自动解除。 */
export function suppress(chatId, topic, minutes = 30) {
  const t = String(topic || '').trim()
  if (!t) return load(chatId)
  const cur = load(chatId)
  cur.suppressed = (cur.suppressed || []).filter((x) => x && x.until > Date.now())
  const hit = cur.suppressed.find((x) => x.topic === t)
  if (hit) hit.until = Date.now() + minutes * 60_000
  else cur.suppressed.push({ topic: t, until: Date.now() + minutes * 60_000 })
  return save(chatId, cur)
}

export function isSuppressed(chatId, text, now = Date.now()) {
  const cur = load(chatId)
  return (cur.suppressed || []).some((x) => x && x.until > now && String(text || '').includes(x.topic))
}

export function aliveSuppressed(chatId, now = Date.now()) {
  const cur = load(chatId)
  return (cur.suppressed || []).filter((x) => x && x.until > now)
}

/** 渲染成提示词里的一块（≤1000 字）。 */
/**
 * @param {object} [o] { dropIf: (text)=>boolean }
 *   dropIf 由调用方给（assemble 用它判"这句是不是等下 recall 槽也要说"），
 *   这里不 import recall —— 工作记忆不该知道召回的事，那是编排层的判断。
 */
export function render(chatId, now = Date.now(), o = {}) {
  const cur = load(chatId)
  const lines = []
  const dropIf = typeof o.dropIf === 'function' ? o.dropIf : () => false
  const push = (key, label) => {
    const v = cur.slots[key]
    if (v && !dropIf(v)) lines.push(`${label}：${v}`)
  }
  push('intent', '现在最要紧的')
  push('topic', '正在聊')
  // ⚠️ mood 槽**不渲染**（2026-11-02）。
  //
  // 它是 `brain/index.mjs:174` 在收消息时写进文件的**快照**，之后就不再更新；
  // 而 affect 是实时状态，每轮现读。两者必然漂移 ——
  // 实测同一轮里 system 同时出现：
  //     [22] 你现在的底色：平稳（情绪 -0.32，唤醒 0.38）   ← affect，实时
  //     [25] 心情：平稳（情绪 -0.29，唤醒 0.45）           ← working，旧快照
  // 同一件事说两遍、数值还不一样。她读到会困惑"到底哪个是我"。
  //
  // 情绪只由 affect.sense() 在一个地方给（第一人称、无数字）。
  // 槽本身保留不删 —— 里面可能还有别的写者，删了会丢数据；只是不再往提示词里放。
  // recallA 和【你想起来的事】（assemble 的 recall 槽）内容相同，以前两处都渲染，
  // 于是 system 里同一句"刚还说心情好呢…"出现两次。
  // 保留这里是因为它带 chatId 作用域（这份是**这个会话**的），
  // 但改个说法，让它读起来是"刚接上的话头"而不是"又一次回忆"。
  push('recallA', '刚接上的话头')
  push('recallB', '还有')
  push('todo', '待办')
  push('unfinished', '没说完的话头')
  const sup = (cur.suppressed || []).filter((x) => x && x.until > now)
  let out = lines.join('\n')
  if (sup.length) out += `\n（这轮先别主动提：${sup.map((x) => x.topic).join('、')}）`
  return out.slice(0, 1000)
}