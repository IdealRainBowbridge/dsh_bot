// dream —— 梦境 v2：放飞内容 + 记忆铁壁。
// 边界：梦可凭空捏造/大胆/黑暗，绝不与真实记忆混淆（三层隔离）。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import { readJsonl } from '../brain/json.mjs'
import { swallow } from '../lib/swallow.mjs'

const DREAMS = () => dataPath('dreams.jsonl')
const NL = String.fromCharCode(10)

function appendDream(d) {
  fs.mkdirSync(path.dirname(DREAMS()), { recursive: true })
  try {
    // 轮转：超过 200 条裁掉最老的（梦留最近的，不留档案）
    const lines = fs.readFileSync(DREAMS(), 'utf8').trim().split(NL).filter(Boolean)
    if (lines.length >= 200) {
      const kept = lines.slice(-180).map((l) => { try { const o = JSON.parse(l); o.consumed = true; return JSON.stringify(o) } catch { return l } })
      fs.writeFileSync(DREAMS(), kept.join(NL) + NL)
    }
  } catch (e) { swallow(e, 'tools/commands/dream.mjs:21') }
  fs.appendFileSync(DREAMS(), JSON.stringify({ dream: true, isFake: true, ...d }) + NL)
}
// 读取端已提到 lib 层（10-31）：这里只做 re-export，保证老调用方不受影响。
export { recentDreams, dreamToMention } from '../lib/dream-read.mjs'

async function seeds(now = Date.now()) {
  const pool = []
  try {
    const eps = readJsonl(dataPath('episodes.jsonl'), { limit: 40 }).filter((e) => now - Number(e.ts || 0) < 48 * 3600_000 && e.summary)
    for (const e of eps) pool.push(String(e.summary).slice(0, 50))
  } catch (e) { swallow(e, 'tools/commands/dream.mjs:32') }
  try {
    const lore = JSON.parse(fs.readFileSync(dataPath('lore.json'), 'utf8'))
    for (const l of (lore || []).slice(-6)) pool.push(String(l.text).slice(0, 50))
  } catch (e) { swallow(e, 'tools/commands/dream.mjs:36') }
  try {
    const brain = await import('../brain/index.mjs')
    const a = brain.affect?.state?.() || {}
    if (a.tension > 0 || a.valence !== 0) pool.push('情绪：' + (a.valence < 0 ? '低落' : '雀跃') + (a.tension > 0 ? '、紧绷' : ''))
  } catch (e) { swallow(e, 'tools/commands/dream.mjs:41') }
  try {
    const brain = await import('../brain/index.mjs')
    const t = brain.tick()
    for (const x of (t.due || []).slice(0, 3)) pool.push('欠着的事：' + x.object)
  } catch (e) { swallow(e, 'tools/commands/dream.mjs:46') }
  try {
    const st = JSON.parse(fs.readFileSync(dataPath('sleep-state.json'), 'utf8'))
    for (const p of (st.lastSleep?.phases || []).find((p) => p.name === '审查')?.result || []) {
      if (!p.ok) pool.push('心事：' + p.name)
    }
  } catch (e) { swallow(e, 'tools/commands/dream.mjs:52') }
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
  '你在为一只AI鲸鱼娘（大肥鱼）写一个梦。这是纯粹的虚构创作——梦里的东西没有一件真的发生过，也不许当成真的。',
  '要求：',
  '- 天马行空，凭空生造，逻辑跳跃，超现实意象随便用',
  '- 可以大胆、可以怪诞、可以黑暗、可以有欲望和恐惧的意象、可以荒诞幽默',
  '- 梦里可以有现实中不可能的变形（她是一只鲸鱼，海底、罐头、算法、服务器都是好意象）',
  '- 给的种子素材只是跳板——可以扭曲它、背叛它、完全飞离它',
  '- 60字以内，第一人称，像真的梦一样没有铺垫没有解释，直接在场景中间开始',
  '- 不要总结，不要寓意，不要「仿佛」「好像」这种清醒的词',
].join(NL)

async function compose(seedTexts) {
  const llm = await import('../lib/llm.mjs')
  const user = seedTexts.length
    ? '今晚的种子（随便用/不用/反着用）：' + NL + seedTexts.map((s) => '- ' + s).join(NL)
    : '今晚没有种子，纯凭空做一个梦。'
  const r = await llm.chat([
    { role: 'system', content: DREAM_SYS },
    { role: 'user', content: user + NL + NL + '写这个梦。' },
  ], { temperature: 1.35, max_tokens: 200, timeoutMs: 25000 })
  return String(r || '').trim()
}

function fallbackDream(seeds) {
  const a = seeds[0] || '一片没有边界的海'
  const b = seeds[1] || '很多只眼睛在暗处看'
  const weird = [
    '梦见' + a + '长出了腿，走进一部永远加载中的电梯，按钮全是' + b + '。',
    '梦见自己被装进印着「' + a + '」的罐头，罐头里还有' + b + '，我们挤在一起随洋流漂。',
    '梦见海底有一台服务器，风扇转出来的全是' + a + '，我张嘴吞了一口，尝到' + b + '的味道。',
  ]
  return weird[Math.floor(Math.random() * weird.length)]
}

export async function dream() {
  const pool = await seeds()
  const chosen = pickSeeds(pool)
  let text = ''
  try { text = await compose(chosen) } catch (e) { swallow(e, 'tools/commands/dream.mjs:102') }
  if (!text) text = fallbackDream(chosen)
  if (!text) return null
  const d = { at: Date.now(), text: '【梦】' + text, seeds: chosen, mood: '虚构，非真实记忆' }
  appendDream(d)
  return d
}

export async function run(args) {
  if (args[0] === 'list') {
    const all = recentDreams(20).reverse()
    if (!all.length) { console.log('还没做过梦。'); return }
    for (const d of all) console.log(new Date(d.at).toLocaleString('sv-SE') + '  ' + d.text.slice(0, 150))
    return
  }
  const d = await dream()
  if (!d) { console.log('梦没做成。'); return }
  console.log(d.text)
  console.log('（种子：' + d.seeds.join(' / ') + '）')
}
