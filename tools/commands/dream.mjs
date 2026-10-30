// dream —— 梦境 v2：放飞内容 + 记忆铁壁。
//
// 边界（10-30 主人定）：梦可以凭空捏造、可以大胆、可以黑暗——唯一的铁律是
// **梦的内容绝不与真实记忆混淆**。三层隔离保证：
//   ① 存储隔离：dreams.jsonl 独立文件，永不写进 lore/facts/episodes/persona
//   ② 标记隔离：每条梦带 dream:true + isFake:true 标记；生成 prompt 明确
//      "这些是编的"；注入时前缀【梦】让她（和任何读日志的人）一眼可辨
//   ③ 消费隔离：dreams 只有两个出口——晨间注入一句（带【梦】前缀，一次性消费）
//      和 `feiyu.mjs dream list` 人工翻看。dreams 永不进 recall 检索域，
//      brain consolidate 的输入源里没有这个文件
// 生成侧放飞：素材只当"灵感种子"，LLM 温度 1.35，prompt 鼓励怪诞/黑暗/超现实/
// 凭空生造，不要求与素材一致——素材是跳板不是枷锁。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

import { dataPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import { readJsonl } from '../brain/json.mjs'

const DREAMS = () => dataPath('dreams.jsonl')

function appendDream(d) {
  fs.mkdirSync(path.dirname(DREAMS()), { recursive: true })
  try {
    // 轮转：超过 200 条裁掉最老的（梦留最近的，不留档案）
    const lines = fs.readFileSync(DREAMS(), 'utf8').trim().split('
').filter(Boolean)
    if (lines.length >= 200) {
      const kept = lines.slice(-180).map((l) => { try { const o = JSON.parse(l); o.consumed = true; return JSON.stringify(o) } catch { return l } })
      fs.writeFileSync(DREAMS(), kept.join('
') + '
')
    }
  } catch {}
  fs.appendFileSync(DREAMS(), JSON.stringify({ dream: true, isFake: true, ...d }) + '\n')
}
export function recentDreams(n = 10) {
  try { return readJsonl(DREAMS(), { limit: n }) } catch { return [] }
}
/** 晨间注入用：最新一条没被提过的梦（提过打 consumed 标记）。 */
export function dreamToMention() {
  const all = recentDreams(5)
  const d = all.find((x) => !x.consumed)
  if (!d) return null
  try {
    const lines = fs.readFileSync(DREAMS(), 'utf8').trim().split('\n')
    const idx = lines.findIndex((l) => l.includes('"at":' + d.at))
    if (idx >= 0) { const o = JSON.parse(lines[idx]); o.consumed = true; lines[idx] = JSON.stringify(o); fs.writeFileSync(DREAMS(), lines.join('\n') + '\n') }
  } catch {}
  return d
}
/** 熑码种子：独立串板刊走走的细生相面、爱隔的粮通重的相面、溃分特统的相面、专越了的相面�*/
async function seeds(now = Date.now()) {
  const pool = []
  try {
    for (const e of eps) pool.push(String(e.summary).slice(0, 50))
  } catch {}
  try {
    const lore = JSON.parse(fs.readFileSync(dataPath('feiyu-ai/lore.json'), 'utf8'))
    for (const l of (lore || []).slice(-6)) pool.push(String(l.text).slice(0, 50))
  } catch {}
  try {
    const brain = await import('../brain/index.mjs')
    const a = brain.affect?.state?.() || {}
    if (a.tension > 0 || a.valence !== 0) pool.push('爉牆：' + (a.valence < 0 ? '低耽' : '雀跃') + (a.tension > 0 ? '、紧绷' : ''))
  } catch {}
  try {
    const brain = await import('../brain/index.mjs')
    const t = brain.tick()
    for (const x of (t.due || []).slice(0, 3)) pool.push('欠睐的今：' + x.object)
  } catch {}
  try {
    const st = JSON.parse(fs.readFileSync(dataPath('sleep-state.json'), 'utf8'))
    for (const p of (st.lastSleep?.phases || []).find((p) => p.name === '审查')?.result || []) {
      if (!p.ok) pool.push('心下：' + p.name)
    }
  } catch {}
  return pool
}

function pickSeeds(pool) {
  const out = []
  const n = Math.min(pool.length, 1 + Math.floor(Math.random() * 3))
  const copy = pool.slice()
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0])
  return out
}

const DREAM_SYS = [
  '你在不要�I鱼娘（大肥鱼）写一个梦。这是纯粹的虚构创作——梦里的东西没有一件真的发生过，也不许当成真的。',
  '要求：',
  '- 天马行空，凭空生造，逻辑跳跃，超现实意象随便用',
  '- 可以大胆、可以怪诞、可以黑暗、可以有欲望和恐惧的意象、可以荒诞幽默',
  '- 梦里可以有现实中不可能的人/事/物变形（她是一只鲸鱼，海底、罐头、算法、服务器都是好意象）',
  '- 给的种子素材只是跳板——可以扭曲它、背叛它、完全飞离它',
  '- 60字以内，第一人称，像真的梦一样没有铺垫没有解释，直接在场景中间开始',
  '- 不要总结，不要寓意，不要「仿佛」「好像」这种清醒的词',
].join('\n')

async function compose(seedTexts) {
  const llm = await import('../lib/llm.mjs')
  const user = seedTexts.length
    ? '今晚的种子（随便用/不用/反着用）＜\n' + seedTexts.map((s) => '- ' + s).join('\n')
    : '今晚没有种子，纯凭空做一个梦。'
  const r = await llm.chat([
    { role: 'system', content: DREAM_SYS },
    { role: 'user', content: user + '\n\n写这个梦。' },
  ], { temperature: 1.35, max_tokens: 200, timeoutMs: 25000 })
  return String(r || '').trim()
}

/** 规则降级版（LLM 挂了也有梦）：种子直拼 + 怪诞前缀。 */
function fallbackDream(seeds) {
  const a = seeds[0] || '一片没有边界的海'
  const b = seeds[1] || '很多只眼睛在暗处看'
  const weird = [
    `梦见${a}长出了腿，走进一部永远加载中的电梯，按钮全是${b}。`,
    `梦见自己被装进印着「${a}」的罐头，罐头里还有${b}，我们挤在一起随洋流漂。`,
    `梦见海底有一台服务器，风扇转出来的全是${a}，我张嘴吞了一口，尝到${b}的味道。`,
  ]
  return weird[Math.floor(Math.random() * weird.length)]
}

/**
 * 生成一条梦。在 sleep.mjs 整理阶段之后调用。
 * @returns {{text, seeds}|null}
 */
export async function dream() {
  const pool = await seeds()
  const chosen = pickSeeds(pool)
  let text = ''
  try { text = await compose(chosen) } catch {}
  if (!text) text = fallbackDream(chosen)
  if (!text) return null
  const d = { at: Date.now(), text: '【梦】' + text, seeds: chosen, mood: '虚构，非真实记忆' }
  appendDream(d)
  return d
}

export async function run(args) {
  if (args[0] === 'list') {
    const all = recentDreams(20).reverse()
    if (!all.length) { console.log('还没健背过試。'); return }
    for (const d of all) console.log(new Date(d.at).toLocaleString('sv-SE') + '  ' + d.text.slice(0, 150))
    return
  }
  const d = await dream()
  if (!d) { console.log('梦没健背。'); return }
  console.log(d.text)
  console.log('（种孔：' + d.seeds.join(' / ') + '）')
}
