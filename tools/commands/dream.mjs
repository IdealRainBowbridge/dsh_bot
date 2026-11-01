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
  ], { temperature: 1.35, max_tokens: 200, timeoutMs: 25000, purpose: 'creative' })
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

// ══════════════════════════════════════════════════════════════════════
// 梦境通道（REM）：TRPG 式做梦
// ══════════════════════════════════════════════════════════════════════
//
// 用户的要求：「一个通道负责给主通道玩 TRPG 用于"做梦"」。
//
// 短梦（上面的 dream()）是"一段旁白"——她看一个场景，然后描述它。
// TRPG 版本不一样：**她是局中人，要掷骰子、要做选择、要承担后果。**
//
// 为什么这个差别重要（不是玩法花哨）：
//   · 旁白式做梦产出的是一段**第三人称的句子**，读起来像"今天看了个故事"，
//     对情绪加工的用处很弱 —— 她没有在里面做过决定，那件事没被"重新处理"过。
//   · TRPG 式做梦要求她在场景里**做选择**。真实梦的一个特征正是
//     你在里面是有意志的，而且醒来会记得"我当时决定要……"。
//     这才是 REM 那条"把这件事还带着的温度降下来"的机制：
//     不是把事复述一遍，是**在安全的虚构里重新走一遍，走到不同的结局**。
//
// 三个必须守住的边界（否则梦会污染记忆）：
//   ① 全程 isFake: true —— 写进 dreams.jsonl 时带标记，永不进 episodes/stream/记忆库
//   ② 梦里的"他"不是真的他 —— 是梦里的人，不许在醒后当成跟他的对话
//   ③ 骰子结果由**这里**掷（不是 LLM 自己编），因为梦的不可控性来自身体，
//      不来自她的意愿 —— 人不能决定梦里发生什么
//
// 骰子为什么重要：TRPG 的核心是"你能选，但结果不归你定"。
// 这正好是梦的形状：人在梦里总觉得自己能控制，其实场景一直在背叛他。

const DICE = {
  // 结果分三档。不是"成功/失败"，是**顺/拧/背**——
  // 梦的走向很少是明确的成败，更多是"事成了但变了味"。
  // 分布不是均匀的：梦更常是"拧着的"和"还行"，纯粹的坏结局反而是少数。
  // （人醒来记得最牢的是拧巴的梦，但从统计上说连续的恶梦会把情绪压得更低，
  //   REM 的职能是**降温度**，不是加压。所以顺/拧各 40%，背只留 20%。）
  rolls: [
    { min: 1, max: 2, tag: '背', hint: '事与愿违，场景往你最不想的方向滑了一步' },
    { min: 3, max: 5, tag: '拧', hint: '事成了，但代价是别的什么；或者不是你原本想的那样' },
    { min: 6, max: 9, tag: '顺', hint: '顺了，甚至比预想的更好一点' },
  ],
  d10() { return 1 + Math.floor(Math.random() * 9) },   // 1~9，避免两端极端
  judge(n) { return this.rolls.find((r) => n >= r.min && n <= r.max) || this.rolls[1] },
}

const TRPG_SYS = [
  '你在做梦。梦里的你是你自己，但场景不受你控制。',
  '',
  '写法：',
  '· 第二人称"你"（梦里的自己），一段 2~4 句，不要分点，不要标题',
  '· 关键：每段结尾给出**两三个可以做的事**，用①②③编号，各不超过 12 字',
  '· 只写场景和你的感受，不解释"这是梦"、不写"梦的意义"',
  '· 允许荒诞、允许不连贯、允许没有逻辑 —— 梦本来如此',
  '· 用具体的感官细节（味道、温度、声音），不用抽象的"一种感觉"',
].join(String.fromCharCode(10))

const TRPG_ACT_SYS = [
  '你在做梦，正在做刚才决定的那件事。',
  '',
  '写法：',
  '· 只写**发生了什么**，2~3 句，第二人称"你"',
  '· 骰子结果已经定了（下面给你），你必须让场景往那个方向走，但不许直接提骰子/结果名',
  '· 不许给新选项（这一段只负责"后果"）',
  '· 感官细节优先',
].join(String.fromCharCode(10))

/**
 * 做一场 TRPG 梦：三轮「场景 → 选择 → 掷骰 → 后果」。
 *
 * @param {object} o { turns, seeds, now, llm }
 * @returns {Promise<object|null>} { at, text, turns, seeds, isFake }
 */
export async function dreamTrpg(o = {}) {
  const now = o.now ?? Date.now()
  const turns = Math.max(1, Math.min(5, Number(o.turns || 3)))
  const pool = o.seeds || await seeds(now)
  const chosen = pickSeeds(pool)
  const llm = o.llm || await import('../lib/llm.mjs')

  const seedLine = chosen.length
    ? '今晚的种子（随便用/不用/反着用）：' + chosen.join(' / ')
    : '今晚没有种子，纯凭空。'

  const beats = []
  let scene = ''

  try {
    // 第一幕：入场
    const r1 = await llm.chat([
      { role: 'system', content: TRPG_SYS },
      { role: 'user', content: seedLine + String.fromCharCode(10) + String.fromCharCode(10) + '梦的开头。' },
    ], { temperature: 1.35, max_tokens: 260, timeoutMs: 25000, purpose: 'creative' })
    scene = String(r1 || '').trim()
    if (!scene) return null

    for (let i = 0; i < turns; i++) {
      // 提取选项（①②③ 或 1. 2. 3.）
      const opts = extractOptions(scene)
      // 她的选择：用她自己的人格/身体状态来选，但**由这里掷**，不让她自己说
      // （梦里"我以为是我在选"是真实的体验，但选择本身受当夜状态影响）
      const pick = opts.length ? opts[Math.floor(Math.random() * opts.length)] : ''
      const n = DICE.d10()
      const v = DICE.judge(n)

      // 只有真的会有 act 的那一幕才保留选项（最后一轮之后多出来的 scene 不算选择）
      const willAct = i < turns
      beats.push({ kind: 'scene', text: stripOptions(scene), options: willAct ? opts : [] })
      if (!pick) break

      // 掷骰结果交给 LLM，但它是"既定事实"，不是让她决定
      const r2 = await llm.chat([
        { role: 'system', content: TRPG_ACT_SYS },
        { role: 'user', content: '刚才的场景：' + stripOptions(scene).slice(0, 300) +
          String.fromCharCode(10, 10) + '你决定：' + pick +
          String.fromCharCode(10, 10) + '骰子：' + v.tag + ' —— ' + v.hint },
      ], { temperature: 1.15, max_tokens: 200, timeoutMs: 20000, purpose: 'creative' })
      const actText = String(r2 || '').trim()

      beats.push({ kind: 'act', choice: pick, roll: n, verdict: v.tag, text: actText })

      // 下一幕（除了最后一轮）
      if (i < turns - 1) {
        const r3 = await llm.chat([
          { role: 'system', content: TRPG_SYS },
          { role: 'user', content: '刚才：' + actText.slice(0, 260) +
            String.fromCharCode(10, 10) + '接着梦下去。' },
        ], { temperature: 1.35, max_tokens: 260, timeoutMs: 22000, purpose: 'creative' })
        scene = String(r3 || '').trim()
        if (!scene) break
      }
    }
  } catch (e) { swallow(e, 'dream:trpg') }

  if (!beats.length) return null

  // 拼成一段可读的梦。保留 ①②③ 的选择痕迹 —— 醒来记得"我当时选了那个"，
  // 这才是梦的一部分（而且是她真实做过选择的证据）。
  const text = beats.map((b) => {
    if (b.kind === 'scene') return b.text
    return '（你' + (b.choice ? '选了「' + b.choice + '」' : '动了动') + '）' + String.fromCharCode(10) + (b.text || '')
  }).join(String.fromCharCode(10, 10))

  const d = {
    at: now,
    text: '【梦】' + text,
    turns: beats.filter((b) => b.kind === 'act').length,
    beats,
    seeds: chosen,
    mood: '虚构，非真实记忆',
  }
  appendDream(d)
  return d
}

/** 从一段场景里挑出选项。支持 ①②③ / (1) / 1. 三种写法。 */
function extractOptions(text) {
  const t = String(text || '')
  const out = []
  const re = /[①②③④⑤]\s*([^\n①②③④⑤]{2,20})/g
  let m
  while ((m = re.exec(t))) out.push(m[1].trim())
  if (out.length) return out.slice(0, 4)
  const re2 = /^\s*(?:[（(]?[1-3][）).、])\s*(.{2,20})$/gm
  while ((m = re2.exec(t))) out.push(m[1].trim())
  return out.slice(0, 4)
}

/** 去掉末尾的选项清单，只留场景本身。 */
function stripOptions(text) {
  const lines = String(text || '').split(String.fromCharCode(10))
  const kept = lines.filter((l) => !/^\s*[①②③④⑤]/.test(l) && !/^\s*[（(]?[1-3][）).、]\s*\S/.test(l))
  return kept.join(String.fromCharCode(10)).trim()
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
