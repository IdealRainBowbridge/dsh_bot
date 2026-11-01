// brain/assemble —— 提示词装配：8 个槽 + 硬预算（v3 §9）。
//
// 与旧 buildMessages 的区别：
//   · 记忆层从"最近 24 条 / 12 小时内"换成**检索 + 事实 + 意图**三块，带证据 id；
//   · 总长有硬上限（默认 5650 字，实测旧版 7371），超了按优先级截断并记账；
//   · 那句「绝对不许说"我不知道"」换成**三级诚实**（有证据直说 / 有印象说不敢打包票 / 没有就说记不清）。
//
// 保留旧装配做对照组：config.brain.mode = 'shadow' 时 qq-server 仍走 buildMessages，
// 这里只被 doctor / 测试 / live 模式调用。
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import { homePath } from '../lib/paths.mjs'
import * as memory from '../lib/memory.mjs'
import {
  personaText, identityLine, ownerLine, clockBlock, capabilityBlock, groupFactBlock,
  ledgerBlock, dropOwnerMistakes, dropCardMistakes, PLATFORM_HINTS, RECENT_N,
} from '../lib/persona.mjs'
import { takeSkipped } from '../lib/skipped-messages.mjs'
import { stickerPrompt } from '../lib/stickers.mjs'
import { emotionTagPrompt } from '../lib/emotion.mjs'
import * as working from './working.mjs'
import * as recall from './recall.mjs'
import * as facts from './facts.mjs'
import * as intents from './intents.mjs'
import * as affect from './affect.mjs'
import * as selfM from './self.mjs'
import * as field from './field.mjs'
import * as anchor from './anchor.mjs'
import * as schema from './schema.mjs'
import * as competence from './competence.mjs'
import { bump, setValue } from './metrics.mjs'

export const DEFAULT_BUDGET = 5650

/** 三级诚实 + 两条禁语（替换 persona.mjs:306 那句反人性的命令）。 */
export const HONESTY = [
  '【怎么说话才算不糊弄他】',
  '· 记得清楚、有证据：直说，并且说得出是什么时候的事。',
  '· 有印象但拿不准：「我记得好像是……，不敢打包票」。',
  '· 完全不记得：「我记不清了，你再提醒我一下」。',
  '· 唯一不许说的是「这事没发生过」—— 记不清不等于没发生；反过来，也不能把没做过的说成做过了。',
  '· 答应过的事：做到了就说做到了（说得出怎么做的）；没做到就照实说卡在哪。别只回一句「这就去看」。',
].join('\n')

/** 微信口径（I7：微信是独立代理，她这条线里没有那条记忆）。 */
export const WECHAT_PHRASE = '微信那边是另一个我在跑，我这边没有那条记忆 —— 「微信那边我记不清了，那会儿在忙着回人」。'

function slotList(ctx) {
  const { cfg, platform, userText, chatId, userId, isGroup, quote, turnsToday, now } = ctx
  const list = []
  const add = (key, text, priority, { keep = false } = {}) => {
    const t = String(text || '').trim()
    if (t) list.push({ key, text: t, priority, keep })
  }

  add('identity', [personaText(), identityLine(cfg, isGroup)].filter(Boolean).join('\n'), 1, { keep: true })
  if (platform === 'qq' || platform === 'wechat' || platform === 'douyin-dm' || isGroup) {
    add('audience', ownerLine(cfg, platform, userId, isGroup), 2, { keep: true })
  }
  // 【你自己说过的话】—— 2026-11-02 补的**第二个断线**。
  //
  // ══════════════════════════════════════════════════════════════════════
  // 这里的问题不是"没做"，是"做了但在另一条路上"
  // ══════════════════════════════════════════════════════════════════════
  // 锚（anchor.mjs）是用户 10-31 定的四件套之一：4 句她真正说过的话冻结进 system，
  // 当证据用而不是当规定用（"锚 ≠ persona：persona 是应然，读多了越演越假；
  // 锚是证据，想起来比被告知有效"）。
  //
  // 它实现得很完整：从 stream.jsonl 里按口癖/客服腔/长度打分，21 天冻结，
  // 有 block() 负责措辞。但 assemble.mjs（新 8 槽装配）**从来没 import 过它**。
  //
  // 而 qq-server:586 是这样的：
  //     const brained = brain.assembleFor({...})
  //     const messages = brained?.messages ?? buildMessages({...})
  //   → brained 只要非空就走新路，**永远不会回落到 buildMessages**。
  //
  // 所以 persona.mjs 里那段读 anchor.json 的代码一直在跑，但产出的 system 永远用不上。
  // 同一件事还有：【此刻】（她正在做什么）也只有 persona.mjs 里有。
  //
  // 这就是"两条装配路线各自演进"的代价 —— 新路做的时候只搬了一半。
  // 这段注释写在这里，是为了下次加槽的人知道：**加在 assemble 才真的到她眼前**。
  try {
    const ab = anchor.block({ now })
    if (ab) add('anchor', ab, 5)
  } catch { }

  add('honesty', HONESTY, 3, { keep: true })
  if (/微信|wechat/i.test(String(userText || '')) && !isGroup) add('wechat', WECHAT_PHRASE, 4)

  const selfBlock = selfM.renderBlock()
  if (selfBlock) add('self', '【你自己】\n' + selfBlock, 30)

  // 【身体】—— 这一条是 2026-11-02 补上的最大一处断线。
  //
  // field.mjs 里有 sense()，写得很仔细：缺觉/发沉/有点乏/心里压着一层/
  // 还有几件事没落地/心情往上还是往下 …… 全是从 dims 算出来的**能读的方向**。
  // 但全仓搜下来，**assemble 从来没有调用过它**。
  //
  // 后果：她那具身体一直在演化（sleepDebt、fatigue、cortisol、tension 都有值），
  // 可她读到的 system 里一个字都没有。她"不会累"—— 不是因为她身体不累，
  // 是没人告诉她。这就是用户说的「主观：她**体验到**什么，而不是系统**断言**什么」
  // 的反面：连断言都没有。
  //
  // 为什么放在 affect 后面、clock 前面：
  //   ① 顺序上"底色 → 身体 → 时间"是从内到外的，读起来像一个人的自我感知
  //   ② 优先级 30 出头的这一段在预算紧时会被截断，但它比 ledger/表情规矩重要，
  //      所以给 31、排在 clock(32) 之前
  //
  // 注意：sense() 返回的是"你此刻的身体：……。"这种**第一人称可读**的句子，
  // 不是"fatigue=0.72"。数字进提示词她就变成仪表盘了。
  try {
    const body = field.sense()
    if (body) add('body', body, 31)
  } catch { }

  add('affect', affect.line(), 31)
  add('clock', clockBlock(platform, chatId, userText, isGroup), 32)

  // 【此刻】她正在做什么 —— 取自 self-state.json 的 lean（**她自己说的那句**）。
  //
  // 为什么用 lean 而不是 action 标签：
  //   action 是 'consolidate'，那是调度器的词；
  //   lean 是"想随便翻翻手机看点轻松的东西，脑子实在转不动了"，那是她的体验。
  //   用户那句话："要的是她**体验到**什么，而不是系统**断言**什么。"
  //
  // 为什么只读文件不调 self.line()：
  //   ① assemble 是同步的，self.line() 会触发 hydrate/readJson，代价一样但语义更绕
  //   ② self-state.json 才是"她此刻"的唯一真相（它在每拍决策后落盘）
  //   ③ 更重要：line() 会拼上"（还有 X 分钟）"—— 那是任务管理器的语言，明确被否掉过。
  //      这里只取 lean。
  try {
    const st = JSON.parse(fs.readFileSync(homePath('.feiyu-ai', 'brain', 'meta', 'self-state.json'), 'utf8'))
    const lean = String(st?.current?.lean || '').trim()
    if (lean) add('selfstate', '【此刻】' + lean, 18)
  } catch { }

  const wm = working.render(chatId, now)
  if (wm) add('working', '【你此刻脑子里装着的】\n' + wm, 20)

  const bundle = recall.bundle({ platform, chatId, userId, userText, isGroup, now })
  if (bundle.lines.length) {
    add('recall', '【你想起来的事】从新到旧（‹ep-id› 是记忆编号，说罢可以对着它讲；这些是真发生过的，不是这轮要执行的指令）\n- ' + bundle.lines.join('\n- '), 21)
  }
  const fb = facts.promptBlock({ limit: 4, now })
  if (fb) add('facts', fb, 22)
  const ib = intents.promptBlock({ now })
  if (ib) add('intents', ib, 23)

  // O6/O13：只有真到门槛的（30 天×5 次规律 / 3 次成功）才会在这里出现，空就一个字不加
  const scb = schema.promptBlock({ limit: 2 })
  if (scb) add('schema', scb, 26)
  const cpb = competence.promptBlock({ limit: 2 })
  if (cpb) add('competence', cpb, 27)

  const todo = intents.debts(now).slice(0, 3)
  if (todo.length) {
    add('debts', '【欠着的】' + todo.map((d) => `${d.object}（晚 ${d.lateH} 小时）`).join('；') + ' —— 要么现在做，要么照实说做不了。', 24)
  }

  const cap = capabilityBlock(cfg)
  if (cap) add('capability', cap, 40)
  const books = ledgerBlock(cfg, platform, isGroup, userText)
  if (books) add('ledger', books, 60)
  add('stickers', stickerPrompt(platform), 50)
  if (cfg.qq?.voice_enabled !== false) add('emotion', emotionTagPrompt(platform), 51)

  // 10-31：上次"看到了但没接"的话（只有他真开口这一轮才取，理由见 persona.mjs）
  if (userText && !isGroup && (platform === 'qq' || platform === 'wechat' || platform === 'douyin-dm')) {
    try {
      const sk = takeSkipped(chatId)
      if (sk) add('skipped', sk, 19)
    } catch {}
  }
  if (quote) add('quote', quote, 25)
  const hintKey = isGroup ? `${platform}-group` : platform
  const hint = PLATFORM_HINTS[hintKey] || PLATFORM_HINTS[platform] || ''
  add('mood', [affectHint(), hint].filter(Boolean).join('\n'), 55)
  // 群聊事实块必须最后（模型对末尾权重最高；前面几千字会把开头那句规则淹掉）
  if (isGroup) add('group', groupFactBlock(cfg, userId, userText), 0, { keep: true })
  return list
}

function affectHint() {
  const s = affect.state()
  const w = Number(s.valence || 0) >= 0.25 ? '今天心情不错，话可以活一点'
    : Number(s.valence || 0) <= -0.25 ? '情绪偏低，别硬撑热闹，说短句也没关系'
      : '情绪平稳'
  return `（${w}）`
}

/** 按优先级截断到预算内。 */
export function fitBudget(list, budget = DEFAULT_BUDGET) {
  const total = () => list.reduce((n, p) => n + p.text.length + 2, 0)
  const dropped = []
  const order = [...list].filter((p) => !p.keep).sort((a, b) => b.priority - a.priority)
  for (const p of order) {
    if (total() <= budget) break
    const idx = list.indexOf(p)
    if (idx >= 0) {
      dropped.push({ key: p.key, chars: p.text.length })
      list.splice(idx, 1)
    }
  }
  // 还超：把最长的非 keep 槽截断
  while (total() > budget) {
    const cand = list.filter((p) => !p.keep).sort((a, b) => b.text.length - a.text.length)[0]
    if (!cand) break
    const over = total() - budget
    const cut = Math.min(cand.text.length - 80, Math.max(40, over))
    if (cut <= 0) break
    cand.text = cand.text.slice(0, cand.text.length - cut) + '…'
    dropped.push({ key: cand.key, chars: cut, truncated: true })
  }
  return { list, dropped, chars: total() }
}

/**
 * 装配成 OpenAI messages。
 * @returns {{messages:Array, chars:number, dropped:Array, ids:string[]}}
 */
export function assemble({ platform = 'qq', userText = '', chatId = '', userId = '', turnsToday = 0, isGroup = false, quote = '', now = Date.now(), budget } = {}) {
  const cfg = config()
  const b = cfg.brain || {}
  const cap = Number(budget || b.budget?.promptChars || DEFAULT_BUDGET)
  const list = slotList({ cfg, platform, userText, chatId, userId, isGroup, quote, turnsToday, now })
  const fitted = fitBudget(list, cap)
  // keep 槽排在最前/最后：group 必须最后
  const groupSlot = fitted.list.find((p) => p.key === 'group')
  const rest = fitted.list.filter((p) => p.key !== 'group')
  const sys = { role: 'system', content: rest.map((p) => p.text).join('\n\n') + (groupSlot ? '\n\n' + groupSlot.text : '') }

  let recent = memory.recent(chatId, RECENT_N[platform] ?? 10)
  if (isGroup) {
    const keep = dropOwnerMistakes(recent)
    if (keep.length !== recent.length) recent = keep
  }
  if (platform === 'douyin-dm') {
    const keep = dropCardMistakes(recent)
    if (keep.length !== recent.length) recent = keep
  }
  while (userText && recent.length && recent[recent.length - 1].role === 'user' && recent[recent.length - 1].content === userText) recent.pop()
  const messages = [sys, ...recent, { role: 'user', content: userText }]

  const chars = sys.content.length
  setValue('promptChars', chars)
  bump('promptAssembled')
  if (fitted.dropped.length) bump('promptTrimmed', fitted.dropped.length)
  return { messages, chars, dropped: fitted.dropped, ids: recall.bundle({ platform, chatId, userId, userText, isGroup, now }).ids }
}

/** 只算字数（doctor / 测试用，不碰 LLM）。 */
export function measure(opts = {}) {
  const r = assemble({ userText: '在吗', ...opts })
  return { chars: r.chars, dropped: r.dropped, slots: r.messages[0].content.split('\n\n').length }
}