// brain/memchannel —— 记忆的**额外通道**：召回 → 加工 → 注入（2026-11-02）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要多一条通道（用户的要求）
// ══════════════════════════════════════════════════════════════════════
// 「记忆体系也开一个额外通道，将主通道"回忆"时进行搜索，然后将几个对应的记忆
//   注入给主通道。」
//
// 现状：assemble 直接调 recall.bundle()，拿到一串 gist 就塞进 system：
//
//   【你想起来的事】从新到旧
//   - 7 小时前 主人：【她发来一张图片（我直接看到了原图）】  ‹ep-...›
//   - 3 小时前 主人：今天好累啊 【他发了个表情包当语气】
//   - 6 小时前 主人：今天好累啊
//
// 三个问题：
//   ① **它只是一串文件列表。** 她自己读到的是一排"主人：xxx"，
//      没有任何"这条为什么浮上来"的线索 —— 于是她不会真的"想起来"，
//      只会照着列表复述（"你之前说过累"），这是检索结果，不是回忆。
//   ② **同一件事重复出现。** "今天好累啊"在 3 小时前和 6 小时前各一条，
//      真人不会把同一件事记两遍 —— 那两条本来就该是同一件事的两个瞬间。
//   ③ **没有"想不起来的余地"。** 三级诚实要求"记不清就说记不清"，
//      可如果每轮都稳定给她 6 条全等价的证据，她永远不需要说"记不清"。
//
// 这条额外通道做三件事：
//   ① **合并**：同一天、同一个人的同类情绪/同类话题，合成一条
//      （"他这两天反复说累"比"他 3 小时前说累、6 小时前说累"更像记忆）
//   ② **加理由**：每条附一句"你为什么现在想起它"（今天提过 / 他刚说到这个 /
//      这事还悬着 / 情绪对上了）。这是"回忆"和"检索"的差别。
//   ③ **留空白**：证据不够时不硬凑 6 条。2 条就说 2 条，
//      该"记不清"的地方留给她自己说。
//
// ══════════════════════════════════════════════════════════════════════
// 为什么放在额外通道而不是直接改 recall
// ══════════════════════════════════════════════════════════════════════
// recall.mjs 是**检索**：它该只负责"按线索找条目"，越纯粹越好（可评测、可换权重）。
// "这条为什么相关""该怎么讲给她听"是**编排层的判断**，不是检索的职责。
// 混在一起，以后调召回质量就分不清是检索错了还是加工错了。
import { swallow } from '../lib/swallow.mjs'

const HOUR = 3_600_000

/**
 * 合并规则：把候选里"说的其实是同一件事"的条目并起来。
 *
 * 判据用**两端**而不是中间的 bigram 重合：
 *   同一件事的两次叙述，常常是同一批词换了顺序、加了语气。
 *   而 M57 那条教训（2-gram 不适合判中文短句"是不是同一件事"）说的是
 *   **判话题切换**的场景 —— 那里信息量太小。
 *   这里不一样：我们只合并**同一个人、同一天、情绪方向相同**的条目，
 *   本来就已经先缩了很大的范围，用字面重合是安全的。
 */
function sameThing(a, b) {
  if (!a || !b) return false
  const who = (x) => x.who?.others?.[0]?.kind || x.who?.kind || ''
  if (who(a) !== who(b)) return false
  // 同一天（错 6 小时内也算同一天的量级）
  if (Math.abs(Number(a.at) - Number(b.at)) > 12 * HOUR) return false
  // 情绪方向要一致（一条低一条高，那是两件事）
  const v = (x) => Number(x.feel?.valence || 0)
  if (Math.sign(v(a)) !== Math.sign(v(b)) && Math.abs(v(a) - v(b)) > 0.3) return false
  // 只比开头 40 字：'说的是哪件事'由开头决定。
  // （'今天好累啊 【他发了个表情包当语气】' 和 '今天好累啊' 开头一致，
  //   后面那串表情包标记不该把相似度稀释掉。）
  const na = norm(String(a.gist || '')).slice(0, 40)
  const nb = norm(String(b.gist || '')).slice(0, 40)
  if (na.length < 6 || nb.length < 6) return false
  // 双向取较高的那个：短的那条被长的"包含"就算同一件事，
  // 反之不然（否则"今天好累啊"会被 20 字的后缀版判为不像）。
  const A = bigrams(na), B = bigrams(nb)
  return Math.max(overlapRatio(A, B), overlapRatio(B, A)) >= 0.5
}

function norm(t) {
  return t.replace(/^主人[:：]/, '').replace(/[\s，。！？…~～、,.!?]/g, '')
}
function bigrams(t) {
  const g = new Set()
  for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2))
  return g
}
function overlapRatio(A, B) {
  if (!A.size) return 0
  let hit = 0
  for (const x of A) if (B.has(x)) hit++
  return hit / A.size
}

/**
 * 这条为什么现在浮上来 —— 一句人能懂的理由。
 * 这是"回忆"与"检索结果"的唯一区别。
 */
function whyNow(ep, ctx) {
  const t = String(ep.gist || '')
  const ageH = (ctx.now - Number(ep.at || ctx.now)) / HOUR

  // ① 他这句话里提到了相关的词
  try {
    const cq = norm(String(ctx.userText || ''))
    const gq = norm(t)
    if (cq.length >= 2 && overlapRatio(bigrams(cq), bigrams(gq)) >= 0.34) return '他刚说到这个'
  } catch { }

  // ② 情绪对得上（她此刻低落，想起来的也多是低落的）
  const cur = Number(ctx.valence || 0)
  const ev = Number(ep.feel?.valence || 0)
  if (Math.abs(cur) > 0.2 && Math.sign(cur) === Math.sign(ev) && Math.abs(ev) > 0.2) {
    return '这事跟你现在的心情对得上'
  }

  // ③ 还悬着（未了的事、答应过的）
  if (ep.act === 'promise' || ep.act === 'plan') return '这事还悬着'

  // ④ **不要用"时间近"当理由。** 时间已经写在行首了，再说一遍等于没说。
  //    （第一版这里返回'今天早些时候的事'，结果 5 条记忆的理由全是这句，
  //      看起来像给了理由，实际是噪声。）
  return ''      // 说不出理由就不给 —— 硬编一句反而假
}

/**
 * 额外通道：拿召回结果，加工成"她真的想起来的东西"。
 *
 * @param {object} o { bundle, userText, now, valence, limit }
 * @returns {{lines:string[], ids:string[], merged:number, dropped:number}}
 */
export function process({ bundle = {}, userText = '', now = Date.now(), valence = 0, limit = 5 } = {}) {
  // ⚠️ recall.bundle().ep 的元素是 `{ ep, score, lex }` —— **包了一层**，
  //    不是裸 episode（recall.mjs:141 返回的是 found.items，而 search() 里
  //    push 的形状是 { ep, score, lex }）。
  //    第一版当成裸 ep 用，于是 ep.gist 全是 undefined → body 空 → lines 空 →
  //    被 assemble 的 try/catch 兜住回退到原始召回，**看起来"没生效"而不是报错**。
  //    这类"形状读错"在本项目已经出现过三次（promises/sleepDebt/这里），
  //    统一教训：拿别人的返回值先打印一条看结构，别照着自己想的用。
  const raw = Array.isArray(bundle.ep) ? bundle.ep : []
  const items = raw.map((x) => (x && x.ep ? x.ep : x)).filter((x) => x && (x.gist || x.quote))
  if (!items.length) return { lines: [], ids: [], merged: 0, dropped: 0 }

  const ctx = { now, userText, valence }

  // ① 合并同一件事
  // ⚠️ 2026-11-02：合并前先把条目**按相似度连起来**，而不是贪心一遍。
  //
  //    贪心版（`groups.find(gr => gr.some(x => sameThing(x, ep)))`）的失败方式：
  //      条目 A "今天好累啊"
  //      条目 B "今天好累啊【他发来一张图片】"
  //      条目 C "今天好累啊【他发了个表情包当语气】（QQ标记为表情包）"
  //      A 和 B 相似度 0.29（B 的后缀太长，稀释了开头）→ B 自成一组
  //      A 和 C 相似度 1.00 → C 进 A 组
  //      结果：A+C 一组，B 单独一组 —— **同一件事被切成两组**。
  //
  //    根因不是阈值，是"只跟组里第一条比"这个形状。
  //    先把任意两条够像的连起来（并查集），再取连通块，
  //    这样 B 只要和组里任何一条像，就会并进去。
  //
  //    另一处：比较时**双向取比例**（A 的 bigram 有多少在 B 里，和反过来）。
  //    "今天好累啊"(5 字) vs "今天好累啊【他发…】"(20 字)：单向算 A→B 是 1.0，
  //    单算 B→A 只有 0.25。取 max 才不会被长的那条拖低。
  const n = items.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[b] = a }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sameThing(items[i], items[j])) union(i, j)
    }
  }
  const byRoot = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r).push(items[i])
  }
  const groups = [...byRoot.values()]
  const merged = n - groups.length

  // 每条组取"最能代表它"的那条：最早的（记忆锚点常是最早那次）+ 出现次数
  const picked = groups.map((gr) => {
    const sorted = gr.slice().sort((a, b) => Number(a.at) - Number(b.at))
    const first = sorted[0]
    return { ep: first, times: gr.length, spanH: (Number(sorted[sorted.length - 1].at) - Number(first.at)) / HOUR }
  })

  // ② 按"有没有理由"重排：说不出为什么想起的，排后面
  const withWhy = picked.map((p) => ({ ...p, why: whyNow(p.ep, ctx) }))
  withWhy.sort((a, b) => {
    const aw = a.why ? 1 : 0, bw = b.why ? 1 : 0
    if (aw !== bw) return bw - aw
    return Number(b.ep.at) - Number(a.ep.at)
  })

  // ③ 渲染。合并过的要说出"不止一次"，那是记忆里很真实的一种形状。
  const used = withWhy.slice(0, limit)
  const lines = []
  const ids = []
  for (const { ep, times, spanH, why } of used) {
    const body = String(ep.gist || ep.quote || '').replace(/\s+/g, ' ').trim()
    if (!body) continue
    const head = relTime(ep.at, now)
    const repeat = times > 1
      ? '（这事他说过 ' + times + ' 次' + (spanH >= 1 ? '，前后隔了约 ' + Math.round(spanH) + ' 小时' : '') + '）'
      : ''
    const tail = why ? '  —— ' + why : ''
    lines.push(head + ' ' + body.slice(0, 70) + repeat + tail + '  ‹' + ep.id + '›')
    ids.push(ep.id)
  }

  return { lines, ids, merged, dropped: items.length - used.length }
}

/**
 * 相对时间：给"大概什么时候"，不给精确分钟（人回忆不精确到分钟）。
 *
 * ⚠️ 第一版分档太粗：1~8 小时全归到"今天早些时候"，
 *    结果 5 条记忆的时间标签一模一样，等于没给时间信息 ——
 *    人回忆时是能分出"上午"和"晚饭那会儿"的。
 */
function relTime(at, now) {
  const h = (now - Number(at || now)) / HOUR
  if (h < 0.5) return '刚一会儿'
  if (h < 2) return '这一两小时'
  if (h < 5) return '几小时前'
  // 5 小时以上：按**当时是几点的**说，比按"隔了多久"更像人话
  const d = new Date(Number(at || now))
  const clock = d.getHours()
  const today = new Date(now).toDateString() === d.toDateString()
  const part = clock < 6 ? '凌晨' : clock < 11 ? '早上' : clock < 14 ? '中午'
    : clock < 18 ? '下午' : clock < 23 ? '晚上' : '深夜'
  if (today) return '今天' + part
  const days = Math.floor((now - Number(at || now)) / (24 * HOUR))
  if (days <= 1) return '昨天' + part
  if (days < 7) return days + ' 天前的' + part
  return '有一阵子了'
}
