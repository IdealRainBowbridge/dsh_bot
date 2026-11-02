// bili-frames —— 给她「真的看一眼画面」的能力（B站）。
//
// 背景（10-31）：debrief 一直只吃文字（元信息/字幕/热评/简介），头注释里写着
// 「抽帧（ffmpeg）留给 v0.2 —— 没有直链时绝不伪装成"已看完"」。这一版把 v0.2 补上。
//
// 链路：view 拿 cid → wbi/playurl 拿 dash 直链
//       → **先下最低清晰度整片，按画面内容算出该看哪几秒**（adapt-frames）
//       → 再到高清流里取那几个位置的片段 → ffmpeg 各解一帧 → 交给 vision 描述。
//
// 2026-11-02 第三次重做：前两次（只下头部 / 固定 40%+75%）都是"位置写死"，
// 现在改成**内容决定采样位置**（用户原话见 adapt-frames.mjs 文件头）。
//
// 三条硬原则：
//   1. 任何一步失败都返回 null，**绝不编造画面**。宁可让她说"这次没看到"。
//   2. 只下载一小段（默认 3MB）：抽前几帧够用了，别为看两秒画面下整部片。
//   3. 帧图用完就删，不囤（她不需要图库，只需要那句描述）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { apiGet, makeHeaders } from './bili-api.mjs'
import { loadCred } from './cred.mjs'
import { dataPath } from './paths.mjs'
import { visionOn, describeFrames } from './vision.mjs'
// adapt-frames 是**动态** import 的（见 seeVideo 里）：它只在真要按内容挑帧时才需要。
// 静态引入会让"只想抽一帧"的轻调用也背上它。

const execFileP = promisify(execFile)

/**
 * 挑一条流：优先 AVC(h264)，**并尽量高清**。
 *
 * 2026-11-02 改：原来取"清晰度最低"（id 最小的 360p），理由是体积小。
 * 实测这直接把 vision 看废了 —— 360p 的番剧画面里人脸只有几十像素，
 * 模型只能回"严重拖影虚化、看不出具体人物或动作"，等于没看。
 * 现在只下几个片段（约 6MB），高清不算奢侈。
 *
 * @param {number} preferQn 指定清晰度（调用方显式要求时才用）
 * @param {number} maxQn    清晰度上限（默认 80 = 1080p；没大会员时服务器本来就不给更高的）
 */
function pickStream(dash, preferQn = 0, maxQn = 80) {
  const list = (dash?.video || []).slice()
  if (!list.length) return null
  if (preferQn) {
    const pool = list.filter((s) => Number(s.id) === preferQn)
    if (pool.length) return pool[0]
  }
  const avc = list.filter((s) => /^avc/i.test(String(s.codecs || '')) && Number(s.id) <= maxQn)
  const use = avc.length ? avc : list.filter((s) => Number(s.id) <= maxQn)
  const final = (use.length ? use : list).sort((a, b) => Number(b.id) - Number(a.id))
  // 最高清优先；同清晰度优先 h264（ffmpeg 解起来最稳）
  const top = Number(final[0]?.id || 0)
  const sameQ = final.filter((s) => Number(s.id) === top && /^avc/i.test(String(s.codecs || '')))
  return (sameQ[0] || final[0])
}

/** 用 ffmpeg 从一段 m4s 里均匀抽 n 帧（JPEG，宽度压到 720，够 vision 认）。 */
async function grabFrames(file, outDir, n) {
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, 'f-%d.jpg')
  // fps=1/3 ≈ 每 3 秒一帧；-frames:v n 封顶。scale 压到 720 宽省 token。
  // scale 用 min(960,iw)：高清源**不缩**，低清源**不放大**（放大只会更糊）。
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-vf', `fps=1/3,scale='min(960,iw)':-2`,
    '-frames:v', String(Math.max(1, Math.min(n, 6))),
    '-q:v', '3', out, '-y',
  ]
  await execFileP('ffmpeg', args, { timeout: 60_000 })
  const dir = path.dirname(out)
  return fs.readdirSync(dir)
    .filter((f) => /^f-\d+\.jpg$/.test(f))
    .sort()
    .map((f) => path.join(dir, f))
    .filter((f) => { try { return fs.statSync(f).size > 1024 } catch { return false } })
}

/** 顺序解析一段 fMP4 的顶级 box（只认连续合法 box，遇到坏数据就停）。 */
function topBoxes(buf) {
  const out = []
  let p = 0
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p)
    const type = buf.subarray(p + 4, p + 8).toString('latin1')
    if (!/^[a-z0-9 ]{4}$/.test(type) || size < 8) break
    out.push({ off: p, size, type })
    p += size
  }
  return out
}

/**
 * init 段里"真正要保留的头部" = ftyp/free/moov/sidx，**不含第一个 moof/mdat**。
 * 为什么必须剥掉：B站的 init 块（约 382KB）本身就带 3 个完整片段。
 * 第一次抽帧从这片里抓到的是**片头曲**，vision 就报"高速模糊的蓝紫色调夜景"。
 * 旧的 grabFrames 把「下载头 3MB」直接交给 ffmpeg —— 那 3MB 约等于前 9 秒，
 * 三帧全落在 OP 上，而提示词却写着"按时间均匀抽的帧"。**这就是之前"看懂了又像没看"的根因。**
 */
function headOfInit(buf) {
  const bs = topBoxes(buf)
  const sidx = bs.find((x) => x.type === 'sidx')
  if (sidx) return { head: buf.subarray(0, sidx.off + sidx.size), boxes: bs, end: sidx.off + sidx.size }
  const moof = bs.find((x) => x.type === 'moof')
  if (moof) return { head: buf.subarray(0, moof.off), boxes: bs, end: moof.off }
  return { head: buf, boxes: bs, end: buf.length }
}

/**
 * 从一段字节里按 box 边界捞第一个完整片段（moof+mdat）。
 * 字节切点会落在 mdat 中间，直接喂 ffmpeg 必报 Invalid NAL unit size。
 *
 * 2026-11-02 补：必须校验**两个 box 都完整落在缓冲区里**。
 * `buf.subarray()` 遇到越界会**静默截断**，于是"半个 mdat"照样返回，
 * 调用方以为拿到了完整片段 —— 又是"有值不报错"的那一类假数据。
 * 实测 1080p 首个 mdat 达 1.49MB，而 init 只取 1MB，正好踩中。
 */
function firstFragment(buf, skip = 0) {
  const view = buf.subarray(skip)
  const bs = topBoxes(view)
  for (let i = 0; i < bs.length; i++) {
    if (bs[i].type !== 'moof') continue
    const md = bs[i + 1]
    if (!md || md.type !== 'mdat') continue
    // 两个 box 都必须完整
    if (bs[i].off + bs[i].size > view.length) continue
    if (md.off + md.size > view.length) continue
    return view.subarray(bs[i].off, md.off + md.size)
  }
  return null
}

/**
 * 在一段**从任意字节偏移切下来的**字节里，找出所有完整的 moof+mdat 对。
 *
 * 2026-11-02 修：原来的写法先算 `target = length*ratio` 再从 target-512KB 往后找，
 * 且要求 moof 的 size 落在 400KB 以内 —— 两处都错：
 *   ① 3MB 窗口里 `moof` 是**唯一**命中（实测），可 target-512KB 起搜等于把窗口砍成 1/6；
 *   ② 1080p 的 moof 可以 >400KB（init 里首个 mdat 就 1.49MB），size 上限把它挡掉了。
 * 结果：40%/75% 两个窗口**一个片段都没取到**，只剩片头那一帧，vision 就拿 1 帧当 3 帧汇报。
 *
 * 现在改为：不假设起点对齐，逐个 moof 试配对，配对成功就跳到该对末尾继续，
 * 避免在 mdat 里被随机字节骗；size 上限放到 8MB 覆盖高码率。
 */
function findPairs(buf) {
  const out = []
  let k = buf.indexOf('moof')
  while (k >= 4) {
    const off = k - 4
    const sz = buf.readUInt32BE(off)
    let next = k + 4
    if (sz >= 16 && sz <= 8 * 1024 * 1024 && off + sz + 8 <= buf.length) {
      const mdOff = off + sz
      if (buf.subarray(mdOff + 4, mdOff + 8).toString('latin1') === 'mdat') {
        const mdSz = buf.readUInt32BE(mdOff)
        if (mdSz >= 8 && mdOff + mdSz <= buf.length) {
          out.push({ off, end: mdOff + mdSz, buf: buf.subarray(off, mdOff + mdSz) })
          next = mdOff + mdSz
        }
      }
    }
    k = buf.indexOf('moof', next)
  }
  return out
}

/** 取窗口里**第一个**完整片段；窗口尾部截断的那对不算。 */
function fragmentNear(buf) {
  const pairs = findPairs(buf)
  return pairs.length ? pairs[0].buf : null
}

/**
 * 探视频流的真实总字节数 —— 总长决定"40%/75%"到底落在哪。
 *
 * 2026-11-02 踩坑：直接信 `HEAD` 的 content-length。实测第一条视频那条 CDN
 * 对 HEAD 回 **404 + 18 字节的 text/plain**，`content-length: 18` 被当成总长，
 * 于是 40%/75% 两个窗口都塌到 `end+1`（同一个位置），取到的还是**同一个片段**，
 * 而返回体照样写着 `sampleAt: "head+40%+75%"` —— 位置标签是编的。
 *
 * 所以：先验 content-type 与量级，再不行用 `Range: bytes=0-0` 读 Content-Range，
 * 都不行返回 0，由调用方决定降级成估算值并**把标签标成 ~**。
 */
async function probeTotal(url, ua) {
  const h = { 'User-Agent': ua, Referer: 'https://www.bilibili.com/' }
  try {
    const hr = await fetch(url, { method: 'HEAD', headers: h, signal: AbortSignal.timeout(15_000) })
    const cl = Number(hr.headers.get('content-length') || 0)
    const ct = String(hr.headers.get('content-type') || '')
    if (hr.ok && cl > 1024 * 1024 && (/^video\//i.test(ct) || /octet-stream/i.test(ct))) {
      return { total: cl, source: 'head' }
    }
  } catch { /* 落到下一步 */ }
  try {
    const hr = await fetch(url, {
      method: 'GET',
      headers: { ...h, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15_000),
    })
    const m = /\/(\d+)\s*$/.exec(String(hr.headers.get('content-range') || ''))
    if (m && Number(m[1]) > 1024 * 1024) return { total: Number(m[1]), source: 'range' }
  } catch { /* give up */ }
  return { total: 0, source: 'none' }
}

/**
 * 多点取样：片头 + 中段 + 靠后各抽一帧。
 *
 * 为什么必须这么做：一部 96 分钟的番，开头 9 秒是 OP、结尾是 ED，剧情在中间。
 * 旧实现只下头部 3MB → 她"看"了 3 帧全是片头曲，却被告知那是均匀抽帧。
 *
 * 2026-11-02 二修：试了两轮才发现"取不到就跳过"是不够的 ——
 * **B站单条 fMP4 流里 moof/mdat 是成对密集出现、中间夹着大段 mdat 载荷**。
 * 实测 2250MB 的流在 40% 处开了两个 3MB 窗口：
 *   窗口 ① 在 moof 前面 2.3MB 处才开始 → 只有半个片段，尾部被截断；
 *   窗口 ② 里一个 moof 都没有。
 * 所以必须**整窗平移重试**（不是从窗口尾巴接着找），直到落进结构完整的那一段。
 */
async function sampleFragments(url, total, opts = {}) {
  const H = opts.headers || {}
  const ua = H['user-agent'] || 'Mozilla/5.0'
  const ref = 'https://www.bilibili.com/'
  // total = 0 表示没探到真实总长：位置标签一律加 `~`（约），绝不冒充精确百分比。
  const approx = !(total > 0)
  const getRange = async (start, end, out) => {
    await execFileP('curl', [
      '-sS', '-L', '--max-time', '45', '-r', `${start}-${end}`,
      '-H', `Referer: ${ref}`, '-H', `User-Agent: ${ua}`, '-o', out, url,
    ], { timeout: 60_000 })
    try { return fs.readFileSync(out) } catch { return null }
  }

  const tmp = opts.tmp
  // ① init 块：B站的 init 是「头 + 首片段」捆绑。
  //    头只有约 9KB（ftyp+moov+sidx），但首个 mdat 实测可达 1.49MB（1080p），
  //    取 1MB 会切在 mdat 中间 → 半个片段。取 2MB 保证首个片段完整。
  const init = await getRange(0, 2 * 1024 * 1024 - 1, path.join(tmp, 'init.m4s'))
  if (!init || init.length < 4096) return { head: null, frags: [] }
  const { head, boxes, end } = headOfInit(init)
  if (!head || head.length < 100) return { head: null, frags: [] }

  const frags = []
  let bytesDown = init.length
  // ② init 里自带的首片段（就是片头，保留 —— 有时开场就是正片）
  const first = firstFragment(init, end)
  if (first) frags.push({ at: 'head', buf: first })

  // ③ 取样点：**由调用方按内容决定**（adapt-frames 算出来的秒数），
  //    不再写死 40%/75%。传 ratios 是没算内容时的退化路径。
  //
  //    opts.points = [{ sec, ratio }]，来自 pickFramesByContent 的骨架+内容层。
  //    没有 points 才退回均匀比例 —— 并**明确标记为退化**（label 带 ~）。
  let points = Array.isArray(opts.points) ? opts.points.slice() : []
  if (!points.length) {
    const ratios = (opts.ratios && opts.ratios.length) ? opts.ratios : [0.25, 0.5, 0.75]
    points = ratios.map((r) => ({ sec: 0, ratio: r, fallback: true }))
  }
  const SPAN = Number(opts.spanBytes ?? 3 * 1024 * 1024)
  const MAX_TRY = 3
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]
    const r = Number(pt.ratio || 0)
    // 有总长 → 按字节比例落点；没总长 → 从 init 末尾往后盲扫（每处错开窗口，保证不重叠）
    let start = (total > 0)
      ? Math.max(end + 1, Math.floor(total * r) - Math.floor(SPAN / 2))
      : end + 1 + i * SPAN
    let f = null
    for (let t = 0; t < MAX_TRY && !f; t++) {
      const buf = await getRange(start, start + SPAN, path.join(tmp, `mid${i}_${t}.m4s`))
      if (!buf || buf.length < 4096) break
      bytesDown += buf.length
      f = fragmentNear(buf)
      // 整窗往后平移一个窗口再试（不是从窗口尾巴接着找）
      start += SPAN
    }
    const label = (pt.fallback || approx) ? `~${Math.round(r * 100)}%` : `${Math.round(r * 100)}%`
    if (f) frags.push({ at: label, buf: f })
  }
  return { head, frags, boxes, bytesDown }
}

/**
 * 看一条 B站视频的画面。
 * @param {string} bvid
 * @param {{frames?: number, maxBytes?: number, qn?: number, query?: string}} opts
 * @returns {Promise<{desc:string, frames:number, bytes:number, codec:string}|null>}
 */
export async function seeVideo(bvid, opts = {}) {
  if (!visionOn()) return null
  const n = Number(opts.frames ?? 3)
  const maxBytes = Number(opts.maxBytes ?? 3 * 1024 * 1024)

  const tmp = dataPath('frames', 'bili-' + crypto.createHash('sha1').update(String(bvid)).digest('hex').slice(0, 10))
  const file = path.join(tmp, 'head.m4s')
  try {
    const cred = loadCred()
    const H = makeHeaders(cred)

    // ① view：拿 cid
    const v = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, H)
    const d = v?.data
    if (!d?.cid) return null

    // ② playurl（WBI 签名由 bili-api 自动补）
    const u = new URL('https://api.bilibili.com/x/player/wbi/playurl')
    u.searchParams.set('bvid', bvid)
    u.searchParams.set('cid', String(d.cid))
    u.searchParams.set('qn', String(opts.qn ?? 80))
    u.searchParams.set('fnval', '16')      // 16 = dash
    u.searchParams.set('fourk', '1')
    const pu = await apiGet(u.href, H)
    if (pu?.code !== 0) return null            // 大会员/地区限制等，交给调用方降级
    const stream = pickStream(pu.data?.dash, Number(opts.preferQn ?? 0), Number(opts.qn ?? 80))
    const url = String(stream?.baseUrl || stream?.base_url || '')
    if (!url) return null

    // ③ 多点取样（2026-11-02 重做）
    //
    // 旧实现：只下 `-r 0-3MB`，直接喂 ffmpeg 抽 n 帧。
    // 两个硬伤：
    //   ① **字节切点落在 mdat 中间** → ffmpeg 报 Invalid NAL unit size。B站 init 块
    //      本身有 382KB（ftyp/free/moov/sidx + 3 个完整片段），头 3MB ≈ 前 9 秒。
    //   ② 抽到的帧**全是片头曲**，但提示词对模型说"按时间均匀抽的帧" —— 骗了模型，
    //      她就会写出"高速模糊的蓝紫色调夜景"这种像看了又没看的观后感。
    //
    // 现在：拆 init 头（ftyp/moov/sidx）→ 头 + 40% + 75% 三处各取一个按 moof 对齐的
    // 完整片段 → 首次拼 head+frag，其余拼 base+frag（base = head + 首片段）——
    // 实测两条路径都能解码（base 里带首个 moof，ffmpeg 才认为是片段流）。
    fs.mkdirSync(tmp, { recursive: true })
    // 视频总字节数 —— 决定多点取样落在哪。三级：
    //   ① HEAD content-length（要验 content-type 与量级，见 probeTotal 的坑）
    //   ② Range 0-0 的 Content-Range
    //   ③ 带宽 × 时长估算（标 `~`，只用于选位置，不冒充精确）
    const probe = await probeTotal(url, H['user-agent'] || 'Mozilla/5.0')
    let totalBytes = probe.total
    let totalSource = probe.source
    if (!totalBytes) {
      const bw = Number(stream?.bandwidth || 0)
      const dur = Number(pu.data?.dash?.duration || 0)
      if (bw > 0 && dur > 0) { totalBytes = Math.round((bw * dur) / 8); totalSource = 'estimate' }
    }

    // ③.5 **先算内容，再决定取哪几帧**（2026-11-02）
    //
    // 为什么不能省这一步：没有它就只能按固定位置抽（40%/75%），
    // 而"位置写死、不看内容"正是这套一直被诟病的电路板做法。
    //
    // 做法：拿**最低清晰度**的整条视频流（几十 MB，能整条取），
    // 用 adapt-frames 按内容算出该看哪几秒（骨架铺全局 + 变化密集处加密），
    // 再把这些秒数换算成字节比例，到**高清**流里去取那几个位置的片段。
    //
    // 代价：多下一次低清整片。实测 6 分钟视频最低清 360p 约 8MB / 4 秒，
    // 换来的是"取哪几帧由画面内容决定"。
    let contentPlan = []
    let contentThresh = 0
    try {
      const AF = await import('./adapt-frames.mjs')
      const durSec = Number(pu.data?.dash?.duration || 0)
      if (durSec > 1 && opts.contentPick !== false) {
        // 最低清晰度那条（id 最小），只为跑差异计算，不用来看
        const lowList = (pu.data?.dash?.video || []).slice()
          .filter((x) => /^avc/i.test(String(x.codecs || '')))
          .sort((a, b) => Number(a.id) - Number(b.id))
        const low = lowList[0] || null
        const lowUrl = String(low?.baseUrl || low?.base_url || '')
        if (lowUrl) {
          // 网络流探针：ffmpeg 直接读 URL（B站 CDN 支持 Range，只取需要的那几秒）。
          // 为什么不用整片：60 分钟的视频最低清整片 201MB（实测），"看一眼"不该付这个代价。
          const probeAt = async (sec) => {
            const out = path.join(tmp, `p_${String(Math.round(sec * 10)).padStart(7, '0')}.raw`)
            try {
              await execFileP('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                // B站 CDN 会校验 Referer/UA：不带就是 403（实测直接 -i URL 必失败）。
                // 两种写法都可（-headers 与 -user_agent/-referer），这里用后者更直观。
                '-user_agent', H['user-agent'] || 'Mozilla/5.0',
                '-referer', 'https://www.bilibili.com/',
                // -ss 放在 -i 前 = 快速定位（seek 到关键帧，不解码前面全部）
                '-ss', String(Math.max(0, sec)),
                '-i', lowUrl,
                '-frames:v', '1',
                '-vf', 'scale=64:36,format=gray',
                '-f', 'rawvideo', '-y', out,
              ], { timeout: 30_000 })
              const buf = fs.readFileSync(out)
              try { fs.unlinkSync(out) } catch { /* ignore */ }
              return buf.length === 64 * 36 ? buf : null
            } catch { return null }
          }
          const budget = Math.max(2, Math.min(10, Number(opts.frames || 3)))
          const got = await AF.pickByContentStream(probeAt, { duration: durSec, budget })
          contentPlan = AF.planOnly(got)
          contentThresh = Number(got.calibratedThresh || 0)
        }
      }
    } catch { contentPlan = [] }

    let frames = []
    let size = 0          // 本次**真的下载**了多少字节（不是流的总长）
    let sampleAt = 'head'
    if (totalBytes > 0) {
      const { head, frags, bytesDown } = await sampleFragments(url, totalBytes, {
        headers: H, tmp, spanBytes: maxBytes,
        points: contentPlan.length ? contentPlan : undefined,
        ratios: opts.ratios,
      })
      if (!head || !frags.length) return null
      size = bytesDown || 0
      // ⚠️ 每个片段单独拼 head，**绝不能拼成 base 再抽**
      //   2026-11-02 踩过：写成 Buffer.concat([head, frag0]) 当 base，
      //   后面每个片段都拼到 base 末尾，再用 `-frames:v 1` 抽帧 —— ffmpeg 永远
      //   只输出**第一个**片段那帧，三帧其实是同一帧。vision 于是报
      //   "三张画面几乎完全相同的静态帧"。每段独立解码才有三个不同位置。
      const picked = []
      const pickedAt = []
      let i = 0
      for (const f of frags) {
        const file2 = path.join(tmp, `s${i}.m4s`)
        fs.writeFileSync(file2, Buffer.concat([head, f.buf]))
        const got = await grabFrames(file2, path.join(tmp, `fr${i}`), 1)
        // 某个片段解不出帧时**标签也要跟着掉**，否则报告的位置和画面不是同一处
        if (got.length) { picked.push(got[0]); pickedAt.push(f.at) }
        i++
      }
      frames = picked
      sampleAt = pickedAt.join('+') || 'head'
      try { fs.writeFileSync(file, Buffer.concat([head, frags[0].buf])) } catch { /* ignore */ }
    } else {
      // 兜底：拿不到总长（CDN 不给 content-length）→ 退回旧的头部单段
      await execFileP('curl', [
        '-sS', '-L', '--max-time', '45',
        '-r', `0-${maxBytes}`,
        '-H', 'Referer: https://www.bilibili.com/',
        '-H', `User-Agent: ${H['user-agent'] || 'Mozilla/5.0'}`,
        '-o', file, url,
      ], { timeout: 60_000 })
      size = (() => { try { return fs.statSync(file).size } catch { return 0 } })()
      if (size < 32 * 1024) return null
      frames = await grabFrames(file, tmp, n)
      sampleAt = 'head-only'
    }
    if (!frames.length) return null

    // ⑤ 让 vision 看一眼
    const desc = await describeFrames(frames, {
      query: opts.query
        || `这是同一条视频（《${String(d.title || '').slice(0, 40)}》）不同位置的 ${frames.length} 帧。`
        + `取样位置：${sampleAt}（% 指视频进度）。`
        + (contentPlan.length
          ? `这几帧是**按画面变化挑出来的**：先铺全片骨架，再在变化大的地方补帧，所以静止的长镜头只给一张、有事情的地方会多给。`
          : `（这次没能按内容挑帧，位置是均匀取的——可信度低一些）`)
        + '用 2~3 句中文描述你**看到**的东西：画面里有什么人/物、在做什么、什么场景和风格。'
        + '只描述画面本身，不要推测剧情，不要复述标题。',
    })
    if (!desc) return null

    return {
      desc: String(desc).slice(0, 800),
      frames: frames.length,
      bytes: size,
      codec: String(stream?.codecs || ''),
      title: String(d.title || ''),
      sampleAt,                              // 实际取到的位置（~ 表示位置是估的）
      contentPicked: contentPlan.length > 0, // true = 位置由画面内容决定
      contentPlan: contentPlan.map((p) => Math.round(p.sec)),  // 算出来的秒数，便于复核
      contentThresh,                         // 这条片子自适应出来的"算变了"阈值（便于复核）
      spanBytes: totalSource === 'estimate' ? null : (totalBytes || null),
      spanBytesSource: totalSource,          // head / range / estimate / none
    }
  } catch {
    return null
  } finally {
    // 帧图不囤：描述完就删（她要的是那句话，不是图库）
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

/** ffmpeg 在不在（缺了就走不了这条链，调用方据此决定要不要尝试）。 */
export function framesReady() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); return true } catch { return false }
}
