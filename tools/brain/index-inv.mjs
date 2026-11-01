// brain/index-inv —— 倒排索引（内存版，随进程重建）。
//
// 为什么不用 sqlite/FTS5：本机 166 条/天，一年 6 万行；启动扫 1~2 秒就建完了，
// 而 node:sqlite 的 trigram 分词对"烧鸭"这种两字词命中不了（10-29 实测），
// 换存储不换索引，等于白折腾。这里用 bigram 倒排 + df 权重，两字词天然支持。
import { episodeById, allEpisodes } from './episode.mjs'
import { fileInfo, listFiles } from './json.mjs'
import { epDir } from './paths.mjs'
import path from 'node:path'

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '就', '都', '也', '不', '有', '这', '那', '一个', '什么', '怎么', '时候'])

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/\[CQ:[^\]]*\]/g, ' ')
  .replace(/\[\[[^\]]*\]\]/g, ' ')
  .replace(/[\s，。！？、,.!?：:；;“”"'（）()《》「」【】\-—_/\\|]/g, '')

/**
 * 中文按 bigram，英文/数字按整词切。
 *
 * ⚠️ 2026-11-02 补：**单字查询会变成空 token，检索直接失效**
 *
 *   实测：
 *     tokens('累')     → []        ← 一个 bigram 都切不出来
 *     tokens('出差')   → ['出差']
 *
 *   于是用户问"你还记得我说累吗"这种话时，"累"这个**唯一有信息量的字**被丢了，
 *   只剩"你还""记得""我说"——全是停用词级别的东西，检索自然乱。
 *
 *   中文单字在很多场景就是完整语义：累、饿、猫、钱、病。
 *   不能因为"bigram 需要两个字"就把它们丢掉。
 *
 *   修法：整段只有 1 个汉字时，把它本身当一个 token（加前缀区分于 bigram，
 *   避免和"累死"里的"累"混淆——那个是 bigram 的一部分，语义不同）。
 *   同时：>=3 字的串也补上单字（只在原串很短、<=4 字时补），
 *   让"好累啊"除了 bigram 之外也能命中"累"。
 */
export function tokens(text) {
  const t = norm(text)
  const out = []
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) if (!STOP.has(w)) out.push(w)
  const zh = t.replace(/[a-z0-9]+/g, '')

  if (zh.length === 1) {
    // 单字：它自己就是完整语义
    if (!STOP.has(zh)) out.push('·' + zh)     // · 前缀 = "单字 token"，与 bigram 区分
    return out
  }

  for (let i = 0; i < zh.length - 1; i++) {
    const g = zh.slice(i, i + 2)
    if (STOP.has(g)) continue
    out.push(g)
  }

  // 短查询（<=4 字）额外补单字，好让"累"能命中"好累啊""累死了"里的那个字
  if (zh.length <= 4) {
    for (const ch of zh) {
      if (STOP.has(ch)) continue
      out.push('·' + ch)
    }
  }
  return out
}

const cache = { stamp: '', index: null, sizes: null }

function stamp() {
  return listFiles(epDir(), /^\d{4}-\d{2}\.jsonl$/).map((f) => {
    const i = fileInfo(path.join(epDir(), f))
    return `${f}:${i.size}:${i.mtime}`
  }).join('|')
}

/** {token: Set(epId)} + 每条 ep 的 token 集合（懒建）。 */
export function build() {
  const st = stamp()
  if (cache.index && cache.stamp === st) return cache.index
  const index = new Map()
  const per = new Map()
  const rows = allEpisodes()
  for (const r of rows) {
    // ⚠️ 2026-11-02：**查询侧和文档侧必须用同一套 token 空间**。
    //
    //    上一版只给查询侧补了单字（·累），文档侧仍只有 bigram，
    //    于是 `search('累')` 拿到 ['·累']，而索引里根本没有 '·累' 这个 key
    //    → 永远 0 命中。加 token 只加一边，等于加了另一边看不见的词。
    //
    //    这里给文档侧也补单字 token（用同一个 · 前缀）。
    //    代价：索引变大（39 条 × 平均 40 字 → 多约 1500 个 key，可忽略）。
    const text = `${r.gist || ''} ${r.quote || ''} ${(r.entities || []).join(' ')}`
    const set = new Set(tokens(text))
    for (const ch of norm(text)) {
      if (STOP.has(ch)) continue
      set.add('·' + ch)
    }
    per.set(r.id, set)
    for (const tk of set) {
      let bucket = index.get(tk)
      if (!bucket) { bucket = new Set(); index.set(tk, bucket) }
      bucket.add(r.id)
    }
  }
  cache.stamp = st
  cache.index = { index, per, total: rows.length }
  return cache.index
}

/**
 * 按线索取候选（并集），返回 Map(id → 命中分 0..1)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 加长度归一化（2026-11-02）—— 原来长句子无脑占优
 * ══════════════════════════════════════════════════════════════════════
 * 原公式：  score = Σ idf(token) / (sqrt(查询token数) × 2)
 *
 * **分母里只有"查询"的长度，没有"文档"的长度。** 于是：
 *   · 60 字的文档有 ~59 个 bigram，随便命中几个就累加出高分
 *   · 15 字的文档只有 ~14 个 bigram，命中了也拿不到分
 *
 * 实测（39 条真实情景）：几乎每次查询的第一名都是同一句 60 多字的
 * "刚还说心情好呢，怎么没一会儿又累了……是不是一放松下来，那股累劲儿就全冒出来了。"
 * 得分 1.07~2.96，而第二名只有 0.5~0.8。
 * 用户问"图片发不出去"、"明天要出差"、"你今天干什么了"，第一名全是它 ——
 * 那句确实包含"累""心情"这类常见字，但它不该压过真正切题的那条。
 *
 * 这就是经典的长度偏置，BM25 的做法是除以 (1 - b + b × |d| / avgdl)。
 * 这里用同一形状，b 取 0.75（BM25 的常用默认值）。
 * 效果：长文档要命中**更多**不同的词才拿得到同样的分，短文档不因短而吃亏。
 *
 * 另外：分母去掉 sqrt(toks.length)。
 * 它不是"归一化"，只是把分数压进 0..1 的缩放 —— 而且顺序会被它改变：
 * 查询越长，所有候选一起被压小，但**长文档压得更少**（因为它的命中更稠密），
 * 相当于又帮了长文档一次。现在只用 b 处理长度，查询长度不参与打分。
 */
export function search(cues, { limit = 200 } = {}) {
  const { index, per, total } = build()
  const toks = [...new Set(tokens(cues))]
  const hits = new Map()

  // 平均文档长度（按 token 数），只算一次
  let sumLen = 0
  for (const set of per.values()) sumLen += set.size
  const avgdl = Math.max(1, sumLen / Math.max(1, per.size))
  const b = 0.75

  for (const tk of toks) {
    const bucket = index.get(tk)
    if (!bucket) continue
    const idf = Math.log(1 + total / Math.max(1, bucket.size))
    for (const id of bucket) hits.set(id, (hits.get(id) || 0) + idf)
  }

  const list = [...hits.entries()]
    .map(([id, s]) => {
      const dl = per.get(id)?.size || 1
      const norm = 1 - b + b * (dl / avgdl)          // BM25 长度归一化
      return [id, s / norm]
    })
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, limit)

  // 归一到 0..1（调用方按"相对最高分"用；绝对大小没有意义）
  const max = Math.max(0.0001, ...list.map((x) => x[1]))
  return new Map(list.map(([id, s]) => [id, Number((s / max).toFixed(4))]))
}

export function stats() {
  const { index, total } = build()
  return { episodes: total, tokens: index.size }
}

export { episodeById }