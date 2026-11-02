// roster —— 外部角色名册（2026-11-03）：把「这是谁」从一次性文本变成长期认知。
//
// 为什么要有它：私聊里只认 owner / 陌生人二分（persona.mjs ownerLine），
// 群里虽然有昵称但过夜就忘 —— 她对天天来聊天的人始终「脸盲」。
// 名册补的就是这个：每个打过照面的人都有一张小卡片（名字 / 她起的称呼 / 印象 / 聊过多少句），
// ownerLine 装配时读一眼，她就能叫上名字、记得关系。
//
// 设计红线：
//   · 每条入站消息都会过 observe() —— 必须幂等、廉价、绝不抛（旁路，失败不影响回复）
//   · 主人绝不入册（owner 是身份不是联系人）；号码永远不当称呼（ownerLine 踩过的坑）
//   · 上限 500 人，满员淘汰最久没见的 —— 这是聊天名册，不是通讯录备份
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'
import { config } from './config.mjs'

/** 名册容量（config.roster.maxPeople 可调，硬上限 2000 防呆）。 */
const maxPeople = () => Math.min(2000, Math.max(50, Number(config().roster?.maxPeople ?? 500) || 500))

/** 主人判定（不 export：只有名册自己用，避免双端口径分叉）。 */
function isOwner(platform, userId) {
  const o = config().owner ?? {}
  if (String(platform) === 'qq') return !!o.qq && String(userId) === String(o.qq)
  if (String(platform) === 'wechat') return !!o.wechat && String(userId) === String(o.wechat)
  return false
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(dataPath('roster.json'), 'utf8'))
    if (j && typeof j === 'object' && j.people && typeof j.people === 'object') return j
  } catch (e) { swallow(e, 'roster:load') }
  return { schema: 1, people: {} }
}

function save(j) {
  const p = dataPath('roster.json')
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const t = `${p}.${process.pid}.tmp`
    fs.writeFileSync(t, JSON.stringify(j, null, 1) + '\n')
    fs.renameSync(t, p)
  } catch (e) { swallow(e, 'roster:save') }
}

/** 登记照面：每条入站消息都过这里。返回这张卡片（主人返回 null）。 */
export function observe({ platform = 'qq', userId = '', name = '', isGroup = false } = {}) {
  const id = String(userId || '').trim()
  if (!id || isOwner(platform, id)) return null
  const j = load()
  const key = `${String(platform)}:${id}`
  const now = Date.now()
  let p = j.people[key]
  if (!p) {
    if (Object.keys(j.people).length >= maxPeople()) {
      // 满员淘汰：最久没见的先走（名册管「还在来往的人」，不管「三年前的路人」）
      let oldestKey = ''
      let oldestAt = Infinity
      for (const [k, v] of Object.entries(j.people)) {
        const at = Number(v?.lastAt || 0)
        if (at < oldestAt) { oldestAt = at; oldestKey = k }
      }
      if (oldestKey) delete j.people[oldestKey]
    }
    p = { platform: String(platform), userId: id, name: '', alias: '', notes: '', firstAt: now, lastAt: now, meets: 0 }
    j.people[key] = p
  }
  p.lastAt = now
  p.meets = Number(p.meets || 0) + 1
  const n = String(name || '').trim()
  if (n) {
    p.name = n.slice(0, 40)
    if (!p.firstSeenName) p.firstSeenName = p.name   // 第一眼的名字留着 —— 改名的人也有来处
  }
  save(j)
  return p
}

/** 她给这个人起 / 改称呼（没见过面也允许先建卡）。 */
export function rename(platform, userId, alias) {
  const id = String(userId || '').trim()
  const a = String(alias || '').trim().slice(0, 24)
  if (!id || !a) return { ok: false, why: '缺参数（platform / userId / 称呼）' }
  const j = load()
  const key = `${String(platform)}:${id}`
  const fresh = !j.people[key]
  const now = Date.now()
  const p = j.people[key] || { platform: String(platform), userId: id, name: '', alias: '', notes: '', firstAt: now, lastAt: now, meets: 0 }
  p.alias = a
  p.lastAt = now
  j.people[key] = p
  save(j)
  return { ok: true, person: p, fresh }
}

/** 补一句对这人的印象（必须有卡片 —— 凭空评价没见过的人不是她的作风）。 */
export function note(platform, userId, text) {
  const id = String(userId || '').trim()
  const t = String(text || '').trim().slice(0, 120)
  if (!id || !t) return { ok: false, why: '缺参数（platform / userId / 印象）' }
  const j = load()
  const key = `${String(platform)}:${id}`
  const p = j.people[key]
  if (!p) return { ok: false, why: '名册里还没这个人（先见过一面，或先 rename 建卡）' }
  p.notes = p.notes ? `${p.notes}；${t}` : t
  if (p.notes.length > 200) p.notes = p.notes.slice(-200)
  save(j)
  return { ok: true, person: p }
}

/** ownerLine 的「这是谁」注入行。空串 = 没有可说的（主人 / 从没打过照面）。 */
export function audienceHint(platform, userId) {
  const id = String(userId || '').trim()
  if (!id || isOwner(platform, id)) return ''
  const p = load().people[`${String(platform)}:${id}`]
  if (!p) return ''
  const bits = []
  const call = String(p.alias || p.name || '').trim()
  if (call) bits.push(`他叫「${call}」`)
  if (Number(p.meets || 0) > 0) bits.push(`你们聊过 ${p.meets} 句`)
  if (p.notes) bits.push(`你的印象：${p.notes}`)
  if (!bits.length) return `【这是谁】${String(platform)} 用户 ${id}，名字还不知道，你记得他。`
  return `【这是谁】${bits.join('，')}。${String(platform)} 号 ${id} 只是认人的编号，别拿数字当称呼。`
}

/** 名册一览（面板用）：最近见过的在前。 */
export function list({ limit = 50 } = {}) {
  const all = Object.values(load().people)
  return all.sort((a, b) => Number(b.lastAt || 0) - Number(a.lastAt || 0)).slice(0, Math.max(1, Number(limit) || 50))
}

export function stats() {
  const all = Object.values(load().people)
  return { people: all.length, named: all.filter((p) => String(p.alias || p.name || '').trim()).length }
}
