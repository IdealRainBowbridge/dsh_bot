// brain/segment —— 段：记忆的单位是「一件事」，不是「一句话」
//
// ══════════════════════════════════════════════════════════════════════
// 为什么必须有"段"这一层
// ══════════════════════════════════════════════════════════════════════
// 现在 episode 是**一条消息一条记录**。所以她记得的是
//   "他说在吗"、"他说我今天好累"、"我说怎么了"、"他说加班到十点"
// —— 四条互不相干的碎片。要拼成"那天他加班到很晚，回来跟我抱怨"，
// 得靠模型每次现场拼，而且拼得不一样。
//
// 人不是这样记的。人记的是**一件事**：
//   「11-01 深夜 · 他加班回来很累，我说让他早点睡」—— 8 个回合，一个整体。
// 细节（具体哪句话）还在，但要**去翻**才想得起来。
//
// 这就是"段"：一段连续的对话，被当成一个记忆单元。它的特征是
//   · 有自己的**摘要**（只当索引：标题、日期、回合数）—— **不是内容**
//   · 原文**一个字不删**（在 stream.jsonl 里，随时能翻回去）
//   · 细节按需展开：平时只给标题，要了才给原话
//
// ══════════════════════════════════════════════════════════════════════
// 什么时候切（四个条件，任一满足）
// ══════════════════════════════════════════════════════════════════════
// 这四条不是凑的，每条对应一个真实的"这件事结束了"的信号：
//
//   ① 隔 2 小时     —— 时间断层。中间那么久没说话，后来的肯定不是同一件事。
//   ② 说晚安        —— 明确的结束语。"晚安/睡了/我先去忙"之后的话属于新的一天。
//   ③ 换话题        —— 话题漂移。用实体/关键词的重叠率判断，不是靠 LCS。
//   ④ 段太长        —— 上限保护。一段最多 N 回合，否则"今天聊了一整天"会变成一个巨段，
//                      摘要就没意义了（这也符合人：聊三小时你会记得分几段）。
//
// 为什么不用固定窗口（比如"每 20 条一段"）：
// 固定窗口会把"一句话问到一半"切断，也会把"三件事"糊成一段。
// 上面四个条件都是**语义信号**，不是计数器。
//
// ══════════════════════════════════════════════════════════════════════
// 摘要只是索引，这是硬约束
// ══════════════════════════════════════════════════════════════════════
// 86% 的表情死在最后 20%，根因就是摘要吃掉了证据。
// 所以这里摘要**只允许**包含：
//   谁、什么时候、几个回合、一句话标题（≤30 字，作为检索线索）
// 绝不允许把摘要当成"这段的内容"去喂提示词。
// 提示词里只出现 `#12 10-24 · 8 回合 · 加班到很晚` 这种**索引行**。
// 要看细节 → 回 stream.jsonl 按 id 取原话。

import { readJson, mutateJson, readJsonl, appendJsonl, shortHash } from './json.mjs'
import { segmentDir, innerStreamPath } from './paths.mjs'
import { relTime, dayKey } from './clock.mjs'
import path from 'node:path'

const HOUR = 3_600_000
const MIN = 60_000

/** 切段参数。每一条都写清为什么是这个数。 */
export const CUT = {
  gapMs: 2 * HOUR,          // ① 隔 2 小时：大部分人 2 小时不联系就是"下次再说"
  maxTurns: 24,             // ④ 一段最多 24 回合（约 12 轮对话）
  // ③ 话题阈值 ────────────────────────────────────────────────────
  // ⚠️ 第一版设 0.34，结果 `你早点睡吧`（6 字）被从 `加班累死了` 那一段切成新段 ——
  //    它们明明是同一件事。根因：短句的 2-gram 集合太小（6 字只有 5 个），
  //    任何一个字不同，重叠率就掉到 0.2 以下。**短句天然更容易被判"换话题"**。
  //    修法：按长度动态降阈值 —— 句子越短，要求越宽松。
  topicDrop: 0.22,          // 基线（对长句）
  topicDropShort: 0.05,     // 对 10 字以内的短句几乎不判换话题
  minTurnsBeforeTopic: 3,   // 前三回合不判换话题（开头本来就还没定性）
  // ② 结束语：这些说完，这段就结束了
  // ⚠️ 第一版漏了口语变体：`你早点睡吧` / `我眯一会儿` / `该睡了` 都不匹配。
  //    规则写在正则里，就必须把**真实说法**覆盖全 —— 这是"规则和现实脱节"的典型。
  endings: /(晚安|睡了|睡吧|去睡|先睡|我睡了|该睡|要睡|眯一会|先这样|不聊了|拜拜|再见|我先去忙|回头聊|待会聊|下回聊|洗澡去|我先去洗|出门了|我走了)/,
}

const empty = () => ({ at: 0, open: null, seq: 0, segments: [] })

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.segments = Array.isArray(st.segments) ? st.segments.slice(-400) : []
  st.seq = Number(st.seq) || 0
  return st
}

const segPath = () => path.join(segmentDir(), 'index.json')

/**
 * 从一段文本里抽"话题指纹"：实体 + 实词。
 *
 * 为什么不用分词：没有词典、且中文短句分词不稳定。
 * 用 2-gram 集合做重叠率就够判断"是不是同一件事"了 ——
 * 因为真正换话题时，词汇替换率会非常高（"加班"→"游戏" 几乎没有共享 2-gram）。
 */
export function fingerprint(text) {
  const t = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  if (t.length < 2) return new Set()
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}


/**
 * 抽"像实词的 2-gram"。
 *
 * 没有分词器，所以这里做的是一件更朴素的事：**把虚词组合排除掉**。
 * 「的吧」「我今」「天加」这类"半个词"要么包含虚字，要么没意义；
 * 「加班」「出十」「哈」这类才可能承载话题。
 * 不追求精确 —— 只用来回答"这句话有没有出现新的、具体的东西"，
 * 模糊一点反而更稳（不会因为分词错而误判）。
 */
const STOP_CHARS = new Set('的了是吗呢吧啊哦嗯我你他她它们这那有在就都也很不没要会能去来到说做个把被给和与或但而所以因如还算更最更'.split(''))
export function nouns(text) {
  const t = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    // 两个字都是虚字 → 丢掉
    if (STOP_CHARS.has(g[0]) && STOP_CHARS.has(g[1])) continue
    // 首或尾是虚字 → 边缘，丢掉（「加班」留，「的我」丢）
    if (STOP_CHARS.has(g[0]) || STOP_CHARS.has(g[1])) continue
    out.add(g)
  }
  return Array.from(out)
}

/** 两个指纹的重叠率（Jaccard 变体：用较小集合做分母，避免长句碾压短句）。 */
export function overlap(a, b) {
  if (!a || !b || !a.size || !b.size) return 0
  let hit = 0
  const small = a.size <= b.size ? a : b
  const big = a.size <= b.size ? b : a
  for (const x of small) if (big.has(x)) hit++
  return hit / small.size
}

/** 这一段是不是该结束了。返回结束的原因（或 null）。 */
export function shouldCut(seg, msg, now = Date.now()) {
  if (!seg) return 'no-open'
  const lastAt = Number(seg.lastAt || seg.at || 0)
  // ① 时间断层
  if (lastAt && now - lastAt > CUT.gapMs) return 'gap'

  // ② 结束语 ────────────────────────────────────────────────────────
  //
  // ⚠️ 这里改过一次，是个顺序错误，记下来：
  //    原来只判 `seg.lastText`（上一条）。于是「我今天加班到十点，累死了 → 饭都没吃
  //    → 你早点睡吧」里，"你早点睡吧"只是因为**话题词不同**被判成换话题切走了，
  //    而它其实是**结束语**——切它的理由错了，会导致 closeWhy 全部记成 topic。
  //
  //    正确语义：结束语是"这句话说完，这件事就结束了"，所以要判**两条**：
  //      · 上一条是结束语 → 说明上一句已经在收尾了，新的这句属于下一段
  //      · **本条**是结束语 → 它自己属于这一段（它是这段的尾巴），不切
  //    也就是：结束语只在"下一句进来时"触发切段，且触发原因是 ending。
  //    当前这条如果是结束语，它应该被并进来，然后在这段末尾收口。
  if (CUT.endings.test(String(seg.lastText || ''))) return 'ending'

  // ④ 太长
  if (Number(seg.turns || 0) >= CUT.maxTurns) return 'too-long'
  // ③ 换话题（前几回合不判）────────────────────────────────────────
  //
  // ⚠️ 这里改了两次，第二次才是对的。记下来：
  //   第一版：纯 2-gram Jaccard，阈值 0.34
  //     → 「你早点睡吧」被从「加班累死了」那段切走（明明是同一件事）
  //   第二版：按句长动态降阈值到 0.05
  //     → 还是切，「哈哈哈哈」也被切走。降阈值只是让它更不敏感，**根因没解决**。
  //
  //   真根因：**2-gram 重叠率不适合判断中文短句的"是不是同一件事"**。
  //     「加班到十点」和「你早点睡吧」没有共享 2-gram，但它们明显是同一件事（关心他累）。
  //     短句信息太少，任何字面方法都会失效。
  //
  //   所以换判据：**只有出现"强话题信号"才切**，而不是"重叠率低就切"。
  //   强话题信号 = 这句里有一个实词，**完全没在**当前段出现过，而且这词是"具体名词"
  //   （不在常用虚词表里）。这比"相似度低"保守得多 —— 宁可少切，不要切碎。
  //   理由：切碎比不切更糟。不切只是"这段有点长"，切碎会让每段都变成一句话，
  //   那就退回到"记忆单位是句子"，正是我们要离开的地方。
  // 本条自己是结束语 → 它一定属于当前这段（是尾巴），绝不判换话题。
  // 这一条是上面那个顺序错误的补丁：正因为"你早点睡吧"自己带着结束语，
  // 它才该留在"加班"那段里，然后**下一句**因为 ending 切段。
  if (CUT.endings.test(String(msg.text || ''))) return null

  if (Number(seg.turns || 0) >= CUT.minTurnsBeforeTopic) {
    const words = nouns(msg.text)
    if (words.length) {
      const known = seg.fp instanceof Set ? seg.fp : new Set(seg.fp || [])
      const fresh = words.filter((w) => !known.has(w))
      // 至少 2 个全新的实词才算换话题（一个可能是随口提到）
      if (fresh.length >= 2 && fresh.length >= words.length * 0.6) return 'topic'
    }
  }
  return null
}

/**
 * 把一条消息并入当前段，或者开新段。
 *
 * @param {object} msg { text, role, at, chat, platform, who }
 * @returns {{st:object, seg:object, cut:boolean, why:string}}
 */
export function ingest(msg = {}) {
  const now = Number(msg.at) || Date.now()
  const st = hydrate(readJson(segPath(), null))
  const fp = fingerprint(msg.text)

  const why = shouldCut(st.open, msg, now)

  if (why) {
    // 把上一段封口
    if (st.open) {
      const closed = { ...st.open, closedAt: now, closeWhy: why }
      st.segments = [...st.segments, closed].slice(-400)
      appendJsonl(path.join(segmentDir(), 'closed.jsonl'), {
        id: closed.id, at: closed.at, lastAt: closed.lastAt, turns: closed.turns,
        title: closed.title, chat: closed.chat, closeWhy: why,
      })
    }
    // 开新段
    st.seq = Number(st.seq) + 1
    const id = 'sg-' + String(st.seq).padStart(4, '0')
    st.open = {
      id, seq: st.seq,
      at: now, lastAt: now,
      chat: String(msg.chat || ''),
      platform: String(msg.platform || ''),
      turns: 1,
      title: '',                 // 摘要：只当索引，稍后补
      firstText: String(msg.text || '').slice(0, 60),
      lastText: String(msg.text || '').slice(0, 60),
      fp,                        // runtime Set，落盘时会转数组
      streamFrom: now,           // 这段在 stream.jsonl 里的起点
      streamTo: now,
    }
    st.at = now
    return { st: persist(st), seg: st.open, cut: true, why }
  }

  // 并入
  const o = st.open
  o.turns = Number(o.turns || 0) + 1
  o.lastAt = now
  o.lastText = String(msg.text || '').slice(0, 60)
  o.streamTo = now
  // 话题指纹**累积**而不是替换：一段里可以提到多件事，但整体重心不该被最后一句带跑
  const merged = new Set(o.fp || [])
  for (const x of fp) merged.add(x)
  o.fp = merged
  // 标题：用第一段有实义的话（索引够用，不需要模型总结）
  if (!o.title && String(msg.text || '').length >= 6) {
    o.title = String(msg.text || '').replace(/\s+/g, ' ').slice(0, 30)
  }
  st.at = now
  return { st: persist(st), seg: o, cut: false, why: '' }
}

/**
 * 索引行 —— **这是提示词里唯一允许出现的东西**。
 *
 * 格式：`#12 10-24 · 8 回合 · 加班到很晚`
 *
 * 为什么不给内容：给了内容就是摘要吃证据。只给编号和标题，
 * 她要细节自己用 seg(id) 去翻原话 —— 这才是"细节要了才给"。
 */
export function indexLine(seg, now = Date.now()) {
  if (!seg) return ''
  const when = seg.at ? relTime(seg.at, now) : ''
  // 日期直接用 Date 格式化，不依赖 dayKey 的返回格式
  // （第一版用 dayKey(at).slice(5)，实测切出来是 '102' —— dayKey 不是 ISO 串）
  const d = seg.at ? new Date(seg.at) : null
  const day = d ? (String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')) : ''
  const title = String(seg.title || seg.firstText || '').replace(/\s+/g, ' ').slice(0, 18)
  return `#${String(seg.seq || 0).padStart(2, '0')} ${day} · ${seg.turns || 0} 回合${title ? ' · ' + title : ''}`
}

/** 取最近 n 段的索引行（**只给 3 行**是刻意的：给多了她会试图总结一切）。 */
export function recentIndex(n = 3, now = Date.now()) {
  const st = hydrate(readJson(segPath(), null))
  const all = [...st.segments]
  if (st.open) all.push(st.open)
  return all
    .filter((s) => Number(s.turns || 0) >= 2)   // 单回合的碎片不值得占一行
    .slice(-n)
    .reverse()
    .map((s) => indexLine(s, now))
}

/**
 * 展开一段的原话。**这一步才回 stream.jsonl 取真相。**
 *
 * @returns {Array<{role,text,at}>}
 */
export function expand(id, { maxTurns = 40 } = {}) {
  const st = hydrate(readJson(segPath(), null))
  const all = [...st.segments]
  if (st.open) all.push(st.open)
  const seg = all.find((s) => s.id === id || String(s.seq) === String(id))
  if (!seg) return []
  // 按段的起止时间在 stream 里取 —— 这就是"原文一个字不删"的用处：
  // 摘要丢了的东西，这里一条不少。
  const rows = readJsonl(innerStreamPath())
  const from = Number(seg.at || 0)
  const to = Number(seg.streamTo || seg.lastAt || Date.now())
  return rows
    .filter((r) => Number(r.at || 0) >= from && Number(r.at || 0) <= to + 1000)
    // 同 chat 的才算（不同会话在同一时间窗口里会串）
    .filter((r) => !seg.chat || !r.meta?.chat || r.meta.chat === seg.chat)
    .slice(-maxTurns)
}

/** 全貌。 */
export function snapshot(now = Date.now()) {
  const st = hydrate(readJson(segPath(), null))
  return {
    total: st.segments.length + (st.open ? 1 : 0),
    open: st.open ? { id: st.open.id, turns: st.open.turns, ageMin: Number(((now - st.open.at) / MIN).toFixed(0)) } : null,
    recent: recentIndex(3, now),
    lastClose: st.segments.length ? st.segments[st.segments.length - 1].closeWhy : null,
  }
}

function persist(st) {
  try {
    mutateJson(segPath(), empty(), () => ({
      at: st.at,
      seq: st.seq,
      open: st.open ? { ...st.open, fp: Array.from(st.open.fp || []) } : null,
      segments: st.segments.map((s) => ({ ...s, fp: Array.isArray(s.fp) ? s.fp : Array.from(s.fp || []) })),
    }))
  } catch { }
  return st
}

/** 读盘时把 fp 数组转回 Set（不然 overlap 会失败）。 */
export function loadSegments() {
  const st = hydrate(readJson(segPath(), null))
  const fix = (s) => ({ ...s, fp: Array.isArray(s.fp) ? new Set(s.fp) : (s.fp instanceof Set ? s.fp : new Set()) })
  return {
    ...st,
    segments: st.segments.map(fix),
    open: st.open ? fix(st.open) : null,
  }
}
