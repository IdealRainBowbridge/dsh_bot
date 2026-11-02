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
import { strengths, touchStrength } from './episode.mjs'

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

  // ══════════════════════════════════════════════════════════════════════
  // ② 排列顺序：从"文件列表"改成"人的想起顺序"
  // ══════════════════════════════════════════════════════════════════════
  // 用户的要求：「她不是 AI 这件事我不否认，所以是**完全能回忆起来**，
  //              只是回忆的**更像人**。」
  //
  // 所以这里不碰"能不能想起来"（永远想得起来），只改"想起来的形状"。
  //
  // 改前只有两条排序规则：有理由的优先，其次按时间新→旧。
  // 那是**文件列表顺序**，不是回忆的顺序。三个不像人的地方：
  //
  //   ① **没有链式**：想起 A，A 才带出 B。
  //      人才是"想起那天下雨 → 因为那天你说累了 → 你那天还说没吃饭"。
  //      文件列表里 B 和 A 没有关系，只是恰好都在前 5 条。
  //   ② **事实领先于情绪**：先想起"他说过累"，再想起当时的感受。
  //      人是反的 —— 先胸口一紧，然后才想起"哦，是他那句话说重了"。
  //   ③ **用过的不会更顺**：道理上常用的事该一想起就来，
  //      但 `touchStrength` 全仓零调用，`strength.json` 从来没生成过，
  //      所以 `w: { hits: 0.06 }` 那一项永远是 0。
  //
  // 现在按这三条重排。**排序不改变"有几条"，只改变"先想起哪条、为什么连着想起"。**
  const withWhy = picked.map((p) => ({ ...p, why: whyNow(p.ep, ctx) }))

  // ③-a 强度：用过的更容易冒出来（修第七次"建好没接"）
  let STR = {}
  try { STR = strengths() } catch { }

  // ③-b 情绪领先：此刻情绪越强，越把"情绪接近的"往前放
  const curV = Number(ctx.valence || 0)
  const emoLead = Math.min(1, Math.abs(curV) / 0.5)     // 0~1，情绪平淡时不起作用

  const score = (it) => {
    const ep = it.ep
    let v = 0
    // 有理由的优先（他现在提到 > 还悬着 > 情绪对上 > 没理由）
    v += it.why ? 2.0 : 0
    if (it.why === '他刚说到这个') v += 1.5
    if (it.why === '这事还悬着') v += 0.8
    // 用过的更顺
    const hit = STR[ep.id]
    v += Math.min(1.2, Number(hit?.strength || 0) / 2.5) * 0.9
    // 情绪领先：此刻低落时，先想起低落的那些
    if (emoLead > 0) {
      const ev = Number(ep.feel?.valence || 0)
      v += emoLead * (1 - Math.abs(ev - curV) / 2) * 1.4
    }
    // 新鲜度只做很小的一点（不然全排成最近几分钟）
    const h = (ctx.now - Number(ep.at || ctx.now)) / HOUR
    v += Math.exp(-h / 36) * 0.35
    return v
  }

  withWhy.sort((a, b) => score(b) - score(a))

  // ③-c 链式：相邻两条如果"叫得上关系"，把关系写进理由里
  //
  // 这一条不是为了好看 —— 它是"想起一件事带出另一件"的代码形状。
  // 判据用**共享实体/同一时段/同一情绪**，都是人联想时真会用的线索。
  // ⚠️ 2026-11-02：第一版有一条坑 —— **同一条理由会连着用三次**。
  //    实测输出：
  //      「……就在那前后的事」
  //      「……就在那前后的事」
  //      「……就在那前后的事」
  //    因为"2 小时内"这个判据在低数据量下几乎总成立（37 条全在同一天凌晨）。
  //    读起来像模板刷屏，而不像回忆。
  //
  //    修：① 同一条理由最多连用一次，用过就换下一档判据
  //        ② 判据按"信息量"排序：共享具体名词（最具体）> 情绪同向 > 同时段（最粗）
  //        ③ 实在没有新理由，就**不给理由**（空着比重复像人）
  const usedLinks = new Set()
  for (let i = 1; i < withWhy.length; i++) {
    const a = withWhy[i - 1].ep
    const b = withWhy[i].ep
    if (withWhy[i].why === '他刚说到这个') continue      // 已经有更强的理由了，别覆盖
    const link = chainReason(a, b, usedLinks)
    if (link) {
      withWhy[i].why = link
      usedLinks.add(link)
    } else {
      withWhy[i].why = ''      // 不给理由，比给一句重复的像人
    }
  }

  // ④ 记一笔"被用过"（这样它下次更容易冒出来）
  try {
    touchStrength(withWhy.slice(0, 6).map((x) => x.ep.id), { delta: 0.12, now: ctx.now })
  } catch { }

  // ══════════════════════════════════════════════════════════════════════
  // ⑤ 自由浮现：**不由话题决定，由此刻的状态决定**
  // ══════════════════════════════════════════════════════════════════════
  // 用户那句话："她完全能回忆起来，只是回忆得**更像人**"。
  //
  // 人回忆最不像检索的一点是：**话题决定不了想起什么。**
  // 你问图片，我可能突然想起三年前一个下雨天 —— 跟图片毫无关系，
  // 但它就是冒出来了。生理依据是海马的索引按**情绪和情境**建，不按关键词。
  //
  // 所以这里在"按话题召回"之外，再走一条独立的：
  //   在全部记忆里挑一条**跟这句话无关、但跟此刻状态有关的**。
  // 三个来源（各占一部分概率）：
  //   · 情绪闪回：此刻心里堵 → 捞最堵的那几条之一
  //   · 时间联想：这个点（同小时）常发生的事
  //   · 纯偶然：随机一条真事（这一条最没道理，也最像人）
  //
  // **但要标明它从哪来** —— 检索到的说"你问的这个"，闪回的说"突然想起来"，
  // 纯偶然的**什么都不说**（人也不会说"我也不知道为什么想起这个"）。
  const freeLine = (() => {
    try {
      // 已经在列表里的就别重复了
      const shown = new Set(withWhy.slice(0, limit).map((x) => x.ep.id))
      const all = Array.isArray(bundle.__all) ? bundle.__all : null   // 有全量就用，没有就跳过
      if (!all || !all.length) return null

      const r = Math.random()
      let pick = null
      let why = ''

      if (r < 0.40 && Math.abs(curV) > 0.25) {
        // 情绪闪回
        const same = all.filter((x) => !shown.has(x.id) && Math.sign(Number(x.feel?.valence || 0)) === Math.sign(curV))
        if (same.length) {
          same.sort((a, b) => Math.abs(Number(b.feel?.valence || 0)) - Math.abs(Number(a.feel?.valence || 0)))
          pick = same[0]
          why = '突然想起来的，跟这句没关系'
        }
      } else if (r < 0.70) {
        // 时间联想：同一个钟点发生过的事
        const hod = new Date(ctx.now).getHours()
        const same = all.filter((x) => !shown.has(x.id) && new Date(Number(x.at || 0)).getHours() === hod)
        if (same.length) {
          pick = same[Math.floor(Math.random() * same.length)]
          why = '这个点总会想起'
        }
      }

      if (!pick) {
        // 纯偶然：什么都不说
        const pool = all.filter((x) => !shown.has(x.id) && (x.gist || x.quote))
        if (pool.length) pick = pool[Math.floor(Math.random() * pool.length)]
        why = ''
      }
      if (!pick) return null
      return { ep: pick, why: why || '也不知道为什么想起来的' }
    } catch { return null }
  })()

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

  // 自由浮现那条放**最后** —— 人的话头也是"对了，还有件事"这样吊在末尾的。
  if (freeLine) {
    const body = String(freeLine.ep.gist || freeLine.ep.quote || '').replace(/\s+/g, ' ').trim()
    if (body && body.length > 3) {
      lines.push(relTime(freeLine.ep.at, now) + ' ' + body.slice(0, 70)
        + '（' + freeLine.why + '）  ‹' + freeLine.ep.id + '›')
      ids.push(freeLine.ep.id)
    }
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

/**
 * 两条记忆之间"人会不会连着想起" —— 能连上就给一句理由，连不上返回 ''。
 *
 * 这是"想起一件事带出另一件"的代码形状。
 * 判据用的是**人真会用的联想线索**，不是语义相似度：
 *   · 同一件事的人（都在说他）
 *   · 同一时间段（都是那天凌晨）
 *   · 情绪同向（都是难过的）
 *   · 共享具体名词（都提到"加班""饭"）
 *
 * 为什么不用 embedding 相似度：那会把"两句话说的是同一类事"误判成"连着想起"。
 * 人联想靠的是**当时的情境**，不是话题分类。
 */
function chainReason(a, b, used = new Set()) {
  if (!a || !b) return ''
  const ta = String(a.gist || '')
  const tb = String(b.gist || '')

  // 按**信息量从高到低**试，且同一条理由不用第二次。
  // 顺序很重要：先试最具体的（共享名词），最后才试最粗的（同时段）。
  const cands = []

  // ① 共享具体名词 → 最具体，最像"由这件事想到那件事"
  try {
    const na = new Set(nouns(ta))
    const nb = nouns(tb)
    const shared = nb.filter((w) => na.has(w))
    if (shared.length) cands.push('后来也提到过「' + shared[0] + '」')
  } catch { }

  // ② 情绪同向且都强
  const va = Number(a.feel?.valence || 0)
  const vb = Number(b.feel?.valence || 0)
  if (Math.abs(va) > 0.3 && Math.abs(vb) > 0.3 && Math.sign(va) === Math.sign(vb)) {
    cands.push(va > 0 ? '那阵子心情都不错' : '那阵子都差不多这样')
  }

  // ③ 同一时段（2 小时内）→ 最粗，放最后
  const dtH = Math.abs(Number(a.at) - Number(b.at)) / HOUR
  if (dtH <= 2 && dtH > 0) cands.push('就在那前后的事')

  for (const c of cands) if (!used.has(c)) return c
  return ''
}

/**
 * 抽"能当联想线索"的词 —— 跳过说话人标签、语气词、时间虚词。
 *
 * ⚠️ 2026-11-02：第一版没排除**说话人标签**，于是输出了
 *    「后来也提到过「主人」」—— 主人不是名词，是"谁在说话"。
 *    这类错的共同点：它是一条**格式信息**，不是内容。
 *    类似的还有"他说""我说""【他发来""QQ 标记"。
 *
 *    判断口径：这个词**能不能作为一件事的宾语**。
 *    "提到过主人" 语法通但没信息（每句都有主人）；
 *    "提到过加班" 才是线索。
 */
function nouns(t) {
  const STOP = new Set([
    // 时间/指代虚词
    '今天', '刚才', '现在', '这个', '那个', '什么', '怎么', '就是', '还是',
    '可以', '不要', '没有', '已经', '应该', '所以', '但是', '而且', '然后',
    // 说话人标签（这些是格式，不是内容）
    '主人', '他说', '我说', '说的', '他发', '发来', '发了', '标记', '表情',
    '语气', '图片', '一张', '的他', '的她',
  ])
  const out = []
  const zh = String(t || '')
    // 先把格式性的括号说明整段去掉（【他发来一张图片（我直接看到了原图）】这类）
    .replace(/【[^】]*】/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[^\u4e00-\u9fa5]/g, '')
  // ⚠️ 2026-11-02：bigram 在中文专有名词上会**切碎**。
  //    实测输出「后来也提到过**「人今」**」—— 那是"主人今天"被切成"人今"。
  //    bigram 对检索是够用的（两字就能命中），但对**展示**完全不能用：
  //    她读到"提到过人今"会觉得这系统坏了。
  //
  //    改用**不切词的整段候选**：按标点和虚词切成短语，取 2~6 字的短段。
  //    这不需要分词器 —— 中文里"被虚词隔开的一段"通常就是一个词或短语。
  const CHUNKS = zh
    .replace(/[的了着过是在和与及或而但就都也很太最更再又还只不没别很]/g, '|')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 6)

  for (const c of CHUNKS) {
    if (STOP.has(c)) continue
    out.push(c)
  }
  // 长一点的也留原样（4~6 字更像一个完整说法）
  return out
}
