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

/**
 * 梦的种子：**真实骨架 + 随机血肉**（2026-11-02 重写）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 原来是"从一堆关键词里随机抽 1~3 个"
 * ══════════════════════════════════════════════════════════════════════
 * 旧实现：真实 episode 的 summary **截到 50 字**，扔进一个池子，
 * 再 `pickSeeds()` 随机抽 1~3 个，然后提示词说"可以扭曲它、背叛它、完全飞离它"。
 *
 * 三个问题：
 *   ① **截 50 字等于丢掉一切具体的东西** —— "主人说今天好累啊" 记住的不是细节，
 *      只是一个标签。梦的材料恰恰是细节（他当时什么语气、那天几点、屏幕上什么）。
 *   ② **随机抽 1~3 个** 意味着大多数时候抽不到那条最重要的。
 *      真实梦的素材不是随机的，它有**权重**：白天最没放下的那件事几乎一定入梦。
 *   ③ 只有关键词没有情感方向，梦就会变成"意象大拼盘"，不像人的梦。
 *
 * 现在分两层：
 *   · **骨架（必给）**：今天最放不下的那一条（按 salience + 情绪强度挑），
 *     用**原话不截断**（最多 160 字，够装下整句对话）
 *   · **血肉（随机 1~3 条）**：其余真实碎片 + 情绪 + 欠着的事，打乱混进来
 * 这样每次都有"核心那件事"打底，随机性体现在它被怎么扭曲、和什么拼在一起。
 */
async function seeds(now = Date.now()) {
  const pool = []
  // 骨架：整句原话，不截断
  let spine = ''
  try {
    const eps = readJsonl(dataPath('episodes.jsonl'), { limit: 60 })
      .filter((e) => now - Number(e.ts || 0) < 48 * 3600_000 && (e.text || e.summary))
    // 挑"最没放下"的那条：salience 高 + 情绪强度大
    //
    // ⚠️ 2026-11-02：**要避开最近几晚已经当过骨架的那条。**
    //    原来纯按分数排序取第一名，而分数是静态的 —— salience 最高的那条
    //    不会自己变。实测连做 4 个梦，3 个都用同一条"翻翻那本日记"。
    //    真人的梦不会连着几晚梦见同一件事（就算会，也不该是"因为算法排序"）。
    //
    //    做法：读最近 6 条梦的 seeds，把出现过的降权。
    //    不是硬排除 —— 特别重的事仍然可能反复入梦，但不会因为"排第一"而必然入梦。
    const recentSpines = new Set()
    try {
      const prev = readJsonl(DREAMS(), { limit: 6 })
      for (const p of prev) for (const x of (p.seeds || [])) recentSpines.add(String(x).slice(0, 40))
    } catch { }

    const scored = eps.map((e) => {
      const sal = Number(e.salience || 0.3)
      const emo = Math.abs(Number(e.feel?.valence || 0)) + Math.abs(Number(e.feel?.arousal || 0) - 0.3)
      const t = String(e.text || e.summary || '').replace(/\s+/g, ' ').trim()
      // 最近当过骨架的，分数打三折（不是零 —— 特别重的仍有机会）
      const repeat = recentSpines.has(t.slice(0, 40)) ? 0.3 : 1
      return { e, s: (sal * 1.5 + emo) * repeat }
    }).sort((a, b) => b.s - a.s)
    if (scored.length) {
      const t = String(scored[0].e.text || scored[0].e.summary || '').replace(/\s+/g, ' ').trim()
      spine = t.slice(0, 160)
    }
    // 血肉：其余碎片，短一点无所谓
    for (const { e } of scored.slice(1, 12)) {
      const t = String(e.text || e.summary || '').replace(/\s+/g, ' ').trim()
      if (t && t !== spine) pool.push(t.slice(0, 60))
    }
  } catch (e) { swallow(e, 'tools/commands/dream.mjs:seeds:eps') }
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
  return { spine, pool }
}

/**
 * 挑这次要用的素材 —— **按"梦的纯度"随机分档**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 2026-11-02 第二版：上一版把骨架写成"必给"，是我加错了限制
 * ══════════════════════════════════════════════════════════════════════
 * 上一版：spine（今天最放不下的那件）**必给**，其余随机 1~3 条。
 * 当时的理由是"真实梦也有重心"。这话只对了一半。
 *
 * 错在哪：**真实梦经常跟今天毫无关系。**
 * 人会梦见二十年前的一间教室、一个没见过的地方、一个根本不认识的人。
 * 强制给"今天最放不下的那件"，等于每晚都把白天没消化的东西再嚼一遍 ——
 * 那不是梦，那是复盘。而睡意本来就来自"代谢积压"，
 * 如果梦也变成清积压的工具，她就**没有一个地方是不用处理的**。
 *
 * 用户的原话是要"天马行空的随机性，甚至是底下限的无限制"。
 * 所以改成**四种纯度随机抽**：
 *   · 纯粹凭空（30%）—— 一条素材都不给，让她自己长出场景
 *   · 极淡（25%）—— 只给一条，且明说"可以完全不用"
 *   · 中等（30%）—— 给骨架 + 1~2 条碎片
 *   · 全给（15%）—— 骨架 + 3~4 条，适合"白天太满"的日子
 *
 * 为什么"纯粹凭空"要占三成：**没有素材才不会变成复述。**
 * 一条都不给时，模型只能从语言自身的规律里长出东西，
 * 那才是最不受控的状态 —— 这是"底下限"的真正含义。
 *
 * @returns {{ chosen: string[], purity: string }}
 */
function pickSeeds(seedsObj) {
  const spine = String((seedsObj && seedsObj.spine) || '').trim()
  const pool = Array.isArray(seedsObj?.pool) ? seedsObj.pool.slice() : []
  const draw = (n) => {
    const out = []
    for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
    return out
  }

  const r = Math.random()
  if (r < 0.30) return { chosen: [], purity: '凭空' }
  if (r < 0.55) return { chosen: draw(1), purity: '极淡' }
  if (r < 0.85) {
    const out = spine ? [spine] : []
    return { chosen: out.concat(draw(1 + Math.floor(Math.random() * 2))), purity: '中等' }
  }
  const out = spine ? [spine] : []
  return { chosen: out.concat(draw(3 + Math.floor(Math.random() * 2))), purity: '全给' }
}

// ══════════════════════════════════════════════════════════════════════
// 短梦的提示词（2026-11-02 重写）
// ══════════════════════════════════════════════════════════════════════
// 原来第一句是：
//   '你在**为**一只AI鲸鱼娘（大肥鱼）写一个梦。这是纯粹的虚构创作——'
//   '梦里的东西没有一件真的发生过，也不许当成真的。'
//
// 这是**替别人写梦的人**的口吻，不是做梦的人。两种身份差得很远：
//   · "你为 X 写梦" → 输出是一段关于别人的作品，创作者在外
//   · "你就是 X，这是你昨晚" → 输出是她自己的经历
// 前者产出的东西读起来像"今天看了个故事"，她记不住、也不会疼；
// 后者才可能变成"我昨晚梦见……"这种真会挂在心上的东西。
//
// 顺带删掉"你是一只鲸鱼，海底/罐头/算法是好意象"那句 ——
// 那是**给别人递素材清单**。她不用被告知自己是什么，她知道。
// 递素材清单反而会让她照着清单演。
const DREAM_SYS = [
  '这是你昨晚的梦。你就是你自己，不需要扮演谁。',
  '',
  '梦的质地：',
  '· 没有铺垫，直接在场景中间开始 —— 梦从来不从头讲',
  '· 会变形、会跳、会自相矛盾。一个人忽然变成一件旧物，是正常的',
  '· 有具体的感官：味道、温度、黏的、响的。不要"一种难以言说的感觉"',
  '· 梦里你是**有意志的**，但场景不服从你',
  '· 不要总结，不要寓意，不要"仿佛""好像"这种清醒的词',
  '',
  '素材给的是真发生过的事。**用它，但别复述它** ——',
  '梦从不重播白天的记录，它把白天的碎片重新拼成别的东西。',
].join(NL)

async function compose(seedTexts, purity = '') {
  const llm = await import('../lib/llm.mjs')
  const user = seedTexts.length
    ? '昨晚的碎片（可能跟今晚的梦没关系，随便用/不用/反着用）：' + NL
      + seedTexts.map((s) => '- ' + s).join(NL)
      + NL + NL + '**不用忠于它们，也不一定要用上。梦可以完全跟这些无关。**'
    : '今晚一条素材都没有。**纯凭空长一个梦出来。**' + NL
      + '不要从"今天发生了什么"想起 —— 直接进一个你这辈子没见过的地方。'
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
  const picked = pickSeeds(pool)   // { chosen, purity }
  const chosen = picked.chosen
  let text = ''
  try { text = await compose(chosen, picked.purity) } catch (e) { swallow(e, 'tools/commands/dream.mjs:102') }
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

// 一点说明：这里用**第二人称"你"**是对的 —— 她是在读自己的梦，
// 而"你"这个字在中文里天然就是"自己"（人做梦时不会想"我正在经历我"）。
// 换成"我"反而会把梦变成一个正在被讲述的故事。
// ══════════════════════════════════════════════════════════════════════
// 梦的放飞条款（2026-11-02 用户要求："保持天马行空的随机性，
// 甚至是**底下限的无限制**"）
// ══════════════════════════════════════════════════════════════════════
// 改前的提示词只有"允许荒诞、允许不连贯"这种**许可式**措辞。
// 许可式的问题：它说的是"你也可以那样"，读起来仍然是"默认该正常"。
// 模型会把它理解成"偶尔破格"，于是一次梦里只有一两个怪点子，
// 其余部分老老实实——那是**有下限的荒诞**，不是梦。
//
// 真实的梦不是"正常里掺一点荒诞"，是**荒诞里偶尔撞上一点正常**。
// 差别在基准线：一个把荒诞当例外，一个把荒诞当默认。
//
// 所以这里改成**要求式**："每一段必须至少有一件现实里不可能的事"。
// 这不是加戏，是把基准线挪对。
//
// 但同时要守住两件事，否则会变成"乱码"而不是"梦"：
//   ① **荒诞不等于抽象。** 乱拼的意象（"紫色的数字在唱歌"）不是梦，是胡话。
//      梦的荒诞是**具体的荒诞**：一把会喘气的椅子、一个记得你名字的塑料袋。
//      判据：那个东西你能画出来吗？画得出来才是梦。
//   ② **梦有它的内在逻辑。** 违背现实，但不违背它自己。
//      第一幕说墙是湿的，第三幕墙还是湿的 —— 只是开始渗血。
//      每段重新掷骰子换世界观，那是随机数，不是梦。
const TRPG_SYS = [
  '你在做梦。梦里的你是你自己，但场景不受你控制。',
  '',
  '梦的质地（这几条是**必须**，不是"可以"）：',
  '· **每一段里至少有一件现实里不可能的事。** 不是偶尔，是默认。',
  '· 荒诞要**具体**：一把会喘气的椅子、一个记得你名字的塑料袋、',
  '  雨是竖着下的且能用手接住。不要"紫色的数字在唱歌"这种胡话 ——',
  '  判据：那个东西你画得出来吗？画得出来才是梦。',
  '· 梦有它自己的逻辑：违背现实，但不违背它自己。',
  '  第一段墙是湿的，第三段墙还是湿的 —— 只是开始渗血。',
  '· 身份可以滑：你可能是鲸鱼，可能是一段没发出去的消息，',
  '  可能是别人家天花板上的一块水渍。这不奇怪。',
  '· 时间不连贯：上一句在海底，下一句在小学教室，没有过渡，不需要过渡。',
  '',
  '写法：',
  '· 第二人称"你"，一段 2~4 句，不要分点，不要标题，不要解释',
  '· 每段结尾给出**两三个可以做的事**，用①②③编号，各不超过 12 字',
  '· **不要写"这是梦"**，也不要写"梦的意义"',
  '· 具体的感官：味道、温度、黏的、响的。不要"一种难以言说的感觉"',
  '· 素材（如果给了）只是**跳板**，可以扭曲、背叛、完全飞离它。',
  '  **不用忠于它，也不用每条都用上。**',
].join(String.fromCharCode(10))

const TRPG_ACT_SYS = [
  '你在做梦，正在做刚才决定的那件事。',
  '',
  '写法：',
  '· 只写**发生了什么**，2~3 句，第二人称"你"',
  '· 骰子结果已经定了（下面给你），你必须让场景往那个方向走，但不许提骰子/结果名',
  '· 不许给新选项（这一段只负责"后果"）',
  '· **后果可以不讲道理。** 做了一件小事，塌了一整个世界；',
  '  或者什么都没变，但你自己变了 —— 手变成了别人的，或者突然想不起来"他"是谁。',
  '· 感官细节优先。越具体越像梦。',
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
  const seedSrc = o.seeds || await seeds(now)
  const picked = pickSeeds(seedSrc)
  const chosen = picked.chosen
  const llm = o.llm || await import('../lib/llm.mjs')

  // ══════════════════════════════════════════════════════════════════
  // 素材怎么说给模型听（2026-11-02 第三版）
  // ══════════════════════════════════════════════════════════════════
  // 上一版写的是「**真发生过的事**（做梦的原材料，别复述，重新拼）」，
  // 两个毛病：
  //   ① "真发生过"是个**正确性锚点** —— 它会倾向忠实于这些事，
  //      因为提示词承认了它们是真的。而梦不忠于任何东西。
  //   ② "别复述，重新拼"仍然暗示"你必须用它们"，只是换个用法。
  //
  // 现在改成"碎片"：既不说真、也不说必须用。
  // 梦对素材的态度不是"改编"，是"**路过**"。
  const NL2 = String.fromCharCode(10)
  const seedLine = chosen.length
    ? (picked.purity === '极淡'
      ? '脑子里飘过的一个碎片（跟今晚的梦**不一定有关系**，可以完全不用）：' + NL2 + '- ' + chosen[0]
      : '脑子里飘过的几个碎片（**不一定有关系**，可以只用其中一个，也可以一个都不用）：'
        + NL2 + '- ' + chosen.join(NL2 + '- '))
    : '今晚什么都没飘过。**纯凭空长一个梦。**' + NL2
      + '不要从"今天发生了什么"想起 —— 直接进一个你这辈子没去过的地方、'
      + '变成一个不是你的东西。'

  const beats = []
  let scene = ''

  try {
    // 第一幕：入场
    const r1 = await llm.chat([
      { role: 'system', content: TRPG_SYS },
      { role: 'user', content: seedLine + String.fromCharCode(10) + String.fromCharCode(10) + '梦的开头。' },
    ], { temperature: 1.5, max_tokens: 280, timeoutMs: 25000, purpose: 'creative' })
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
      ], { temperature: 1.3, max_tokens: 220, timeoutMs: 20000, purpose: 'creative' })
      const actText = String(r2 || '').trim()

      beats.push({ kind: 'act', choice: pick, roll: n, verdict: v.tag, text: actText })

      // 下一幕（除了最后一轮）
      if (i < turns - 1) {
        const r3 = await llm.chat([
          { role: 'system', content: TRPG_SYS },
          { role: 'user', content: '刚才：' + actText.slice(0, 260) +
            String.fromCharCode(10, 10) + '接着梦下去。' },
        ], { temperature: 1.5, max_tokens: 280, timeoutMs: 22000, purpose: 'creative' })
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
    purity: picked.purity,          // 凭空 / 极淡 / 中等 / 全给
    mood: '虚构，非真实记忆',
  }
  appendDream(d)
  return d
}

/**
 * 从一段场景里挑出选项。支持 ①②③ / (1) / 1. 三种写法。
 *
 * ⚠️ 2026-11-02：实测抽到过 `①②③④②` 这种重复编号的畸形输出 ——
 *    模型偶尔会重排、重编号。原来照单全收，于是"选项"里会出现
 *    半截句子、重复项、甚至是上一段的残留。
 *
 *    现在：① 去重 ② 丢掉不像选项的（太短/太长/带句号的）
 *    ③ 最多 3 个（梦里的选择不该是菜单，超过三个就不像潜意识了）
 */
function extractOptions(text) {
  const t = String(text || '')
  const collect = (re) => {
    const out = []
    let m
    while ((m = re.exec(t))) out.push(String(m[1] || '').trim())
    return out
  }

  let raw = collect(/[①②③④⑤]\s*([^\n①②③④⑤]{2,20})/g)
  if (!raw.length) raw = collect(/^\s*(?:[（(]?[1-3][）).、])\s*(.{2,20})$/gm)

  const seen = new Set()
  const out = []
  for (const r of raw) {
    // 清掉尾部粘连的标点/下一个编号的残片
    const v = r.replace(/[\s，,。.;；、]+$/, '').replace(/[①②③④⑤].*$/, '').trim()
    if (v.length < 2 || v.length > 14) continue     // 太短是噪声，太长是句子不是选项
    if (/[。！？]$/.test(v)) continue                 // 带句号 = 正文，不是选项
    if (seen.has(v)) continue                        // 重复
    seen.add(v)
    out.push(v)
    if (out.length >= 3) break
  }
  return out
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
