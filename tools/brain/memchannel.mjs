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
  const raw = Array.isArray(bundle.ep) ? bundle.ep : []
  const items = raw.map((x) => (x && x.ep ? x.ep : x)).filter((x) => x && (x.gist || x.quote))
  if (!items.length) return { lines: [], ids: [], merged: 0, dropped: 0, steps: 0 }

  const ctx = { now, userText, valence }
  const t0 = Date.now()
  // 强度：用过的记忆周围边更通（第七次建好没接的那个）
  let STR = {}
  try { STR = strengths() } catch { }

  // ══════════════════════════════════════════════════════════════════════
  // 激活扩散：回忆是一个**过程**，不是一次打分
  // ══════════════════════════════════════════════════════════════════════
  // 用户要的三件事（情绪领先 / 链式联想 / 用过的更顺）+"让她想一会儿"，
  // 且明确要求「**不要做成分离的，要做成融合式的**」。
  //
  // 分离式（上一版）是三个独立的加分项，加起来排序：
  //     v += why ? 2.0 : 0            ← 理由
  //     v += strength * 0.9           ← 用过
  //     v += emoLead * 接近度 * 1.4   ← 情绪
  // 三个加数互不知道对方存在。改一个不影响另一个，所以它们永远**不同时发生** ——
  // 那是三个评分器，不是一个回忆。
  //
  // 融合式用认知科学里现成的模型：**激活扩散（spreading activation）**。
  //   ① 有若干「起点」被瞬间点亮（此刻的状态、他的话、身体）
  //   ② 激活**沿关联边**往外扩散，越近越亮
  //   ③ 亮到阈值以上的会**变成新的起点继续往外传**（这就是链式联想）
  //   ④ 有衰减：不扩散就暗下去
  //   ⑤ **在扩散够远之前，结果是不稳定的** —— 这就是"想一会儿"
  //
  // 三件事在这个模型里**不是三个加数，而是同一股激活的三种性质**：
  //   · 情绪领先 = **起点的亮度**。此刻越难受，情绪起点的初始能量越大，
  //                于是它带出来的东西先冒头 —— 不需要单独的权重项。
  //   · 链式     = **扩散本身**。A 亮了才可能点亮 B。没有"理由"这个词，
  //                只有"从谁传过来的"。
  //   · 用过的更顺 = **边的传导率**。用过的记忆，它周围的边更通，
  //                激活从这里流过时衰减得少 —— 也不需要单独的加分。
  //
  // "想一会儿"的落地：**限制扩散步数**，而不是睡眠几秒。
  //   每一跳是真实的计算（几毫秒），跳数越多找得越远。
  //   难的问题（冷门话题、没直接命中）会自然需要更多跳 —— 她自己会"多想两下"。
  //   这里额外给一个**步数记账**，让上层知道她这次想了几跳。

  // ── ① 建边 ───────────────────────────────────────────────────────
  //
  // 边的四种来源，权重不同。这是"关联"的全部定义 ——
  // 没有边就没有扩散，所以这张表决定了她的联想长什么样。
  //
  // 为什么只建**这些**边：每一条都对应人真会用的联想线索。
  //   同时段   —— "那天前后"
  //   共词     —— "后来也提到过 X"
  //   情绪同向 —— "那阵子都差不多"
  //   同对方   —— "都是跟他说的事"
  const EDGE = { time: 1.0, word: 0.9, emo: 0.7, who: 0.35 }
  const edges = new Map()          // id -> [{to, w, kind}]
  const addEdge = (a, b, w, kind) => {
    if (!a || !b || a === b) return
    if (!edges.has(a)) edges.set(a, [])
    edges.get(a).push({ to: b, w, kind })
  }

  const byId = new Map(items.map((x) => [x.id, x]))
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j]
      // 同时段（2 小时内）：越近越强
      const dtH = Math.abs(Number(a.at) - Number(b.at)) / HOUR
      if (dtH <= 2) {
        const w = EDGE.time * (1 - dtH / 2.5)
        addEdge(a.id, b.id, w, 'time'); addEdge(b.id, a.id, w, 'time')
      }
      // 共词
      try {
        const na = new Set(nouns(a.gist || ''))
        const shared = nouns(b.gist || '').filter((x) => na.has(x))
        if (shared.length) {
          const w = EDGE.word * Math.min(1, shared.length / 2)
          addEdge(a.id, b.id, w, 'word'); addEdge(b.id, a.id, w, 'word')
          // 把共同词记下来，渲染时说得出"提到过 X"
          ;(byId.get(a.id).__link ||= {})
        }
      } catch { }
      // 情绪同向且都强
      const va = Number(a.feel?.valence || 0), vb = Number(b.feel?.valence || 0)
      if (Math.abs(va) > 0.3 && Math.abs(vb) > 0.3 && Math.sign(va) === Math.sign(vb)) {
        addEdge(a.id, b.id, EDGE.emo, 'emo'); addEdge(b.id, a.id, EDGE.emo, 'emo')
      }
      // 同对方
      const ka = a.who?.others?.[0]?.kind || '', kb = b.who?.others?.[0]?.kind || ''
      if (ka && ka === kb) { addEdge(a.id, b.id, EDGE.who, 'who'); addEdge(b.id, a.id, EDGE.who, 'who') }
    }
  }

  // ── ② 起点：此刻的状态点亮若干记忆 ─────────────────────────────────
  //
  // 这里有五类起点，它们的**初始能量**不同。
  // 情绪起点的能量由此刻的情绪强度决定 —— 这就是"情绪领先"，
  // 它不是一个权重项，是**火从哪里烧起来**。
  const act = new Map()            // id -> 激活量
  const from = new Map()           // id -> 从谁传过来的（链式的痕迹）
  const whyOf = new Map()          // id -> 一句人话

  const light = (ep, energy, fromId = '', why = '') => {
    if (!ep) return
    const prev = act.get(ep.id) || 0
    if (energy > prev) {
      act.set(ep.id, energy)
      if (fromId) from.set(ep.id, fromId)
      if (why) whyOf.set(ep.id, why)
    }
  }

  const emoLead = Math.min(1, Math.abs(valence) / 0.5)

  // 起点一：他说的话**真的**直接命中的
  //
  // ⚠️ 第一版这里写错了：`raw.map(x => x && x.ep ? x : {ep:x, lex:0})`，
  //    但 raw 的元素本来就是 `{ep, score, lex}`，走的是 `x`（有 lex），
  //    而 `lex` 在 recall.search 里是归一化后的 0~1 占比 —— **每条候选都有值**，
  //    包括"时间近邻"和"同 chat 近 40 条"这两条兜底路捞进来的（它们的 lex 是 0，
  //    但经过 `s/lexMax` 之后……不，它们是 addCandidate(ep, 0)，lex 确实是 0）。
  //
  //    真正的问题是：我把 `lex` 当布尔用了（`if (!lex) continue`），
  //    于是 lex=0 的被跳过 —— 这是对的；但输出里几乎每条都标「他刚说到这个」，
  //    说明**大部分候选的 lex 都 > 0**。
  //    因为搜索按 bigram 打分，"主人""今天""好累"这些常用字让几乎每条都挣到一点分。
  //
  //    修：只让**显著命中**的点火。判据用相对强度 ——
  //    lex >= 主查询最高分的 35% 才算"他真在说这个"。
  //    这样"在吗"这种两字查询不会把一大片都点亮。
  const lexMax = Math.max(0.0001, ...raw.map((x) => Number(x && x.lex) || 0))
  for (const it of raw) {
    const ep = it && it.ep ? it.ep : it
    const lex = Number(it && it.lex) || 0
    if (!ep) continue
    // 显著命中才当起点；弱命中的只是被"扫到了"，让它靠扩散带出来
    if (lex / lexMax < 0.35) continue
    const energy = 0.55 + 0.45 * (lex / lexMax)      // 0.55~1.0
    light(ep, energy, '', '他刚说到这个')
  }

  // 起点二：此刻情绪点亮的 —— 能量由情绪强度决定（**情绪领先**）
  if (emoLead > 0.1) {
    const same = items.filter((x) => Math.sign(Number(x.feel?.valence || 0)) === Math.sign(valence))
      .sort((a, b) => Math.abs(Number(b.feel?.valence || 0)) - Math.abs(Number(a.feel?.valence || 0)))
    for (const ep of same.slice(0, 3)) {
      light(ep, 0.35 + 0.5 * emoLead, '', '这事跟你现在的心情对得上')
    }
  }

  // 起点三：还没说完的、悬着的
  try {
    const pend = items.filter((x) => x.act === 'promise' || x.act === 'plan')
    for (const ep of pend.slice(0, 2)) light(ep, 0.6, '', '这事还悬着')
  } catch { }

  // 起点四：**自由浮现**——跟话题无关，只跟此刻有关
  //
  // 这是"话题决定不了想起什么"的落地点。
  // 它不是一条独立的输出，是**一个额外的起火点**：
  // 起火烧起来之后，它自己也会往外扩散，带出它周围的事。
  // 所以"突然想起一件无关的事，然后又由它想起另一件"是自然发生的。
  try {
    const r = Math.random()
    const pool = items.filter((x) => !act.has(x.id))
    if (pool.length) {
      let pick = null, why = ''
      if (r < 0.40 && emoLead > 0.3) {
        const s2 = pool.filter((x) => Math.sign(Number(x.feel?.valence || 0)) === Math.sign(valence))
        if (s2.length) { pick = s2[Math.floor(Math.random() * s2.length)]; why = '突然想起来的，跟这句没关系' }
      } else if (r < 0.70) {
        const hod = new Date(now).getHours()
        const s3 = pool.filter((x) => new Date(Number(x.at || 0)).getHours() === hod)
        if (s3.length) { pick = s3[Math.floor(Math.random() * s3.length)]; why = '这个点总会想起' }
      }
      if (!pick) { pick = pool[Math.floor(Math.random() * pool.length)]; why = '也不知道为什么想起来的' }
      if (pick) light(pick, 0.45, '', why)
    }
  } catch { }

  // ── ③ 扩散：**这一步就是"想一会儿"** ─────────────────────────────
  //
  // 每一步：从所有亮点出发，沿边往外传一次，同时整体衰减。
  // 停的条件：没有新的有效激活（想不起来了），或者到步数上限。
  //
  // **步数不是固定等时间**：冷门话题命中少、起点暗，会自然多跑几跳；
  // 热门话题第一步就亮了，两三跳就停。这就是"有的想起来快、有的想半天"。
  const DECAY = 0.55               // 每跳衰减
  const THRESHOLD = 0.12           // 低于这个就"暗了"，不再往外传
  const MAX_HOPS = 6
  let hops = 0
  let spike = ''                   // 记下最强的新火点（链式的下一环）

  for (let h = 1; h <= MAX_HOPS; h++) {
    hops = h
    const nextAct = new Map(act)
    let grew = false

    for (const [id, energy] of act) {
      if (energy < THRESHOLD) continue
      const out = edges.get(id)
      if (!out) continue
      for (const e of out) {
        // **用过的更顺**：这条边在这条记忆上走过，就更通
        const str = STR[e.to]
        const ease = 1 + Math.min(0.8, Number(str?.strength || 0) * 0.18) + Math.min(0.4, Number(str?.hits || 0) * 0.05)
        const give = energy * e.w * DECAY * ease
        if (give < THRESHOLD) continue
        const cur = nextAct.get(e.to) || 0
        if (give > cur) {
          nextAct.set(e.to, give)
          if (!from.has(e.to)) from.set(e.to, id)
          grew = true
        }
      }
    }

    // 整体衰减（没有新血的会暗下去）
    for (const [id, v] of nextAct) nextAct.set(id, v * 0.92)
    act.clear()
    for (const [k, v] of nextAct) act.set(k, v)
    if (!grew) break
  }

  // ── ④ 按"亮起来的那一刻"排序 ──────────────────────────────────────
  //
  // 最像人的地方在这里：**先说亮的先想起来**，不是先算分高的。
  // 起点亮的早，链式带出来的晚 —— 于是输出的顺序天然就是
  // "先想起那件事 → 由它想到 → 又想到"。
  const lit = [...act.entries()]
    .filter(([, v]) => v >= THRESHOLD * 0.6)
    .sort((a, b) => b[1] - a[1])

  // 同一件事合并（合并发生在**扩散之后**，因为扩散要先靠它们串起来）
  const groups = []
  for (const [id] of lit) {
    const ep = byId.get(id)
    if (!ep) continue
    const g = groups.find((gr) => gr.some((x) => sameThing(x, ep)))
    if (g) g.push(ep); else groups.push([ep])
  }

  const used = []
  for (const gr of groups) {
    if (used.length >= limit) break
    const sorted = gr.slice().sort((a, b) => Number(a.at) - Number(b.at))
    used.push({ ep: sorted[0], times: gr.length, spanH: (Number(sorted[sorted.length - 1].at) - Number(sorted[0].at)) / HOUR })
  }

  // ── ⑤ 记一笔"被划过"（下次这些边更通） ─────────────────────────────
  try {
    touchStrength(used.map((x) => x.ep.id), { delta: 0.10, now })
  } catch { }

  // ── ⑥ 渲染 ────────────────────────────────────────────────────────
  const lines = []
  const ids = []
  let lastSrc = ''
  for (const { ep, times, spanH } of used) {
    const body = String(ep.gist || ep.quote || '').replace(/\s+/g, ' ').trim()
    if (!body) continue
    const head = relTime(ep.at, now)
    const repeat = times > 1
      ? '（这事说过 ' + times + ' 次' + (spanH >= 1 ? '，前后隔了约 ' + Math.round(spanH) + ' 小时' : '') + '）'
      : ''

    // 链式的痕迹：如果它是从另一条传过来的，说出来
    let why = String(whyOf.get(ep.id) || '')
    const src = from.get(ep.id)
    if (!why && src && byId.get(src)) {
      const kind = (edges.get(src) || []).find((e) => e.to === ep.id)?.kind
      const srcText = String(byId.get(src).gist || '').slice(0, 12)
      why = kind === 'word' ? '从「' + srcText + '…」想到的'
        : kind === 'emo' ? '那阵子都差不多这样'
          : kind === 'time' ? '就在那前后的事'
            : '顺着他想到的'
    }
    const tail = why ? '  —— ' + why : ''
    lines.push(head + ' ' + body.slice(0, 70) + repeat + tail + '  ‹' + ep.id + '›')
    ids.push(ep.id)
    lastSrc = ep.id
  }

  return {
    lines, ids,
    merged: items.length - groups.length,
    dropped: items.length - used.length,
    steps: hops,                 // 她想了几跳（"想了一会儿"的实测量）
    ms: Date.now() - t0,
  }
}

/* ══════════════════════════════════════════════════════════════════════
   以下两个是 process() 用到的工具函数，必须留在文件里
   ══════════════════════════════════════════════════════════════════════
   2026-11-02：我把 process 整段替换时把它们一起截掉了，
   报错 `ReferenceError: relTime is not defined`。
   教训：**整段替换要数清楚"到哪结束"** —— 我找的是 `export function process(`
   的起点，然后 REPLACE 到文件末尾，但末尾还挂着两个辅助函数。
   */

/** 相对时间：给"大概什么时候"，不给精确分钟（人回忆不精确到分钟）。 */
function relTime(at, now) {
  const h = (now - Number(at || now)) / HOUR
  if (h < 0.5) return '刚一会儿'
  if (h < 2) return '这一两小时'
  if (h < 5) return '几小时前'
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
 * 抽"能当联想线索"的词 —— 跳过说话人标签、语气词、时间虚词。
 *
 * 两个踩过的坑都记在这里：
 *   ① 不能包含**说话人标签**（"主人""他说""发来"）—— 那是格式，每句都有，
 *      拿它当线索等于没线索。实测输出过「后来也提到过「主人」」。
 *   ② 不能用 **bigram** 切 —— 中文专有名词会被切碎（"主人今天"→"人今"）。
 *      bigram 对检索够用，对**展示**完全不能用。
 *      改成按虚词切短语：中文里"被虚词隔开的一段"通常就是一个词。
 */
function nouns(t) {
  const STOP = new Set([
    '今天', '刚才', '现在', '这个', '那个', '什么', '怎么', '就是', '还是',
    '可以', '不要', '没有', '已经', '应该', '所以', '但是', '而且', '然后',
    '主人', '他说', '我说', '说的', '发来', '发了', '标记', '表情', '语气', '图片',
  ])
  const zh = String(t || '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[^\u4e00-\u9fa5]/g, '')
  return zh
    .replace(/[的了着过是在和与及或而但就都也很太最更再又还只不没别很]/g, '|')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 6)
    .filter((x) => !STOP.has(x))
}
