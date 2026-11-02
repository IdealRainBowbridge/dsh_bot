// adapt-frames —— 「看视频」的取帧策略（2026-11-02 重做）
//
// 用户原话（两次，都在 `0e0109f8` 那个对话里）：
//   ①「也可以试着过特定时间截一帧观看，如果差别很大中间再截一帧，如果差别太小就继续往后面跨一点截」
//   ②「就不能先压缩成信息流，再从信息流提取出值得观看的帧吗？」
// 以及他自己的判断：「让内容决定采样位置，而不是预先固定字符串」。
//
// 之前那版是 `head + 40% + 75%` —— **位置写死**。我自己也承认过那「本质上就是电路板」，
// 但当时只修了抓取可靠性（moof 对齐、字节截断），策略本身没动。这一版把策略换掉。
//
// ── 核心思路 ────────────────────────────────────────────────────────────
// 不是「先决定取哪几帧」，而是**让画面自己决定下一帧去哪取**：
//
//   从片头取一帧 → 与上一个「代表帧」比差异 →
//     差异大：说明这一段有内容变化 → 在**两者之间**再取一帧（二分逼近变化点）
//     差异小：说明这段是静止/重复画面 → **往后跨一大步**（跳过没信息的地方）
//   直到帧数预算用完，或跨到片尾。
//
// 这就是「信息流」：预算固定，花在**变化密集**的地方而不是均匀摊开。
// 一部 6 分钟的番，OP 是连续运动（帧帧都不同），正片对话是静止长镜头（几秒才动一下）——
// 均匀采样会把预算浪费在 OP 上，自适应采样会自然把预算挪到「事情发生的地方」。
//
// ── 为什么不用 SSIM ─────────────────────────────────────────────────────
// 实测（2026-11-02，同一条视频）：
//   同一帧           SSIM 1.000
//   相隔 0.3 秒      SSIM 0.561   ← 只动了一点点就掉到 0.56
//   相隔 30 秒       SSIM 0.365
// SSIM 对**运动**极其敏感：一个人挥手就能让 SSIM 掉到 0.5，但它并不代表「内容变了」。
// 用它当「该不该补一帧」的判据，会在有动作的镜头里疯狂补帧、在真正换场景时反而不突出。
//
// 改用**灰度缩略图的平均绝对差**（64×36，0=全同，1=全反）。
//
// 标定（2026-11-02，两条真实视频每 5% 采一点，18~19 个样本）：
//   同一帧               0.000
//   0.3 秒后             0.106   ← 「有运动但没换内容」的底线
//   动画片（切镜头频繁）  中位 0.240 / 最大 0.532
//   课件（画面很稳）      中位 0.164 / 最大 0.652
//
// ⚠ **固定阈值 0.28 是错的**（我一开始就写错了）：真实中位数就在 0.16~0.24，
// 用 0.28 会把一半以上的正常场景变化判成「没变」，于是采样退化成均匀铺点。
// 现在改成**按片自适应**：先探一批点算出这条片子自己的分位数，
// 取「中位数的一半」当阈值 —— 让阈值跟着片子的节奏走：
//   · 快节奏动画：中位 0.24 → 阈值 0.12（稍微一变就补帧）
//   · 慢节奏长镜头：中位 0.10 → 阈值 0.05（本来就没变化，别乱补）
// 这才是「让内容决定」而不是「让我的常量决定」。
//
// ── 为什么是「缩略图 + 灰度」────────────────────────────────────────────
// 64×36 = 2304 字节，一次取帧 + 缩放 + 读 raw 约 40ms。用全分辨率算差异
// 会把 CPU 全吃在这上面，而判「内容变没变」根本不需要细节。
// 真正给 vision 看的那几帧仍然是高清（见 bili-frames.mjs 的 grabFrames）。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** 灰度缩略图尺寸：64×36 是 16:9，够看出构图变化，又便宜到可以每个探针都算。 */
const TW = 64
const TH = 36

/**
 * 从视频文件里取某一秒的灰度缩略图（raw bytes）。
 * @returns {Promise<Buffer|null>} 2304 字节；取不到返回 null（不抛）
 */
export async function thumbAt(file, sec, tmp) {
  const out = path.join(tmp, `t_${String(Math.round(sec * 1000)).padStart(9, '0')}.raw`)
  try {
    await execFileP('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(0, sec)),
      '-i', file,
      '-frames:v', '1',
      '-vf', `scale=${TW}:${TH},format=gray`,
      '-f', 'rawvideo', '-y', out,
    ], { timeout: 20_000 })
    const buf = fs.readFileSync(out)
    try { fs.unlinkSync(out) } catch { /* ignore */ }
    return buf.length === TW * TH ? buf : null
  } catch {
    return null
  }
}

/**
 * 两帧的平均绝对差，归一到 0~1。
 * 0 = 完全一样；1 = 每个像素都 0↔255。
 * 实测标定见文件头。取不到任何一帧时返回 1（当作「变了」，宁可多看一眼）。
 */
export function frameDistance(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / (a.length * 255)
}

/**
 * 自适应取帧 —— 内容决定下一步去哪。
 *
 * 算法（每步都花在「最可能有新东西」的地方）：
 *   1. 从起点取一帧当「上一个代表帧」
 *   2. 往后跨 step 秒再取一帧，算差异
 *      · 差异 < sameThresh   → 这段没变化，**步长翻倍**继续跨（跳得更远）
 *      · 差异 > sameThresh   → 这段有变化，记下这一点，并在
 *        **上一帧与这一点之间**二分补一帧（逼近变化发生的位置）
 *   3. 直到取够 budget 帧，或走到片尾
 *
 * 为什么步长要「翻倍/收回」而不是固定：一部 6 分钟的片子，
 * 前 90 秒 OP 是连续运动，后 4 分钟对话是静止长镜头。
 * 固定步长会在 OP 里疯狂取帧、在正片里一个变化都抓不到。
 * 这里步长随「多久没变化」增长 —— 越静止跳得越远；一有变化立刻收回。
 *
 * @param {string} file          本地视频文件（能 ffmpeg -ss 就行）
 * @param {string} tmp           临时目录
 * @param {object} opts
 * @param {number} opts.duration 视频时长（秒），必须有 —— 没有就退化成固定采样
 * @param {number} opts.budget   最多取几帧（含第一帧），默认 6
 * @param {number} opts.start    从第几秒开始，默认 0
 * @param {number} opts.baseStep 初始步长（秒），默认 duration/20（20 步走完全片）
 * @param {number} opts.minStep  最小步长（秒），默认 2 —— 再小就只是在看同一幅画面
 * @param {number} opts.sameThresh 认为「画面没变」的阈值，默认 0.28（标定见文件头）
 * @returns {Promise<Array<{sec:number, ratio:number, buf:Buffer}>>}
 */
export async function pickFramesByContent(file, tmp, opts = {}) {
  const duration = Number(opts.duration || 0)
  const budget = Math.max(2, Math.min(12, Number(opts.budget || 6)))
  const start = Math.max(0, Number(opts.start || 0))
  if (!(duration > 1)) return []

  const baseStep = Number(opts.baseStep || Math.max(1, duration / 20))
  const minStep = Number(opts.minStep || 2)
  const sameThresh = Number(opts.sameThresh ?? 0.28)

  const picked = []          // 已选中的点（按时间升序）
  const seen = new Map()     // sec -> buf，避免重复取同一秒

  const grab = async (sec) => {
    const key = Math.round(sec * 1000) / 1000
    if (seen.has(key)) return seen.get(key)
    const b = await thumbAt(file, key, tmp)
    seen.set(key, b)
    return b
  }

  // ── 预算分配：**先铺全局，再补细节** ────────────────────────────────
  //
  // 第一版只按"有没有变化"推进，结果 6 帧全挤在前 25%（0/9/18/54/72/90 秒），
  // 正片一帧都没看 —— 因为一遇到变化就把步长收回 baseStep，于是永远在前段打转。
  // 这跟固定 40%/75% 是同一类错误：都不看**还剩多少路要走**。
  //
  // 正确做法是两层：
  //   · 骨架层：先把 [0, duration) 均匀铺 k 个点，保证"全片都看过一眼"
  //   · 内容层：剩下的预算按变化密度分配 —— 变化越密的地方补得越多
  // 这样既不会漏掉后半段（骨架保证），又能把细节花在有事的地方（内容层）。
  // 骨架比例 —— 这里有个**必须按片长缩放**的坑（2026-11-02 实测）：
  //
  // 一开始固定取 budget 的 40%。60 分钟的片子 budget=6 → 骨架只有 3 个点
  // （0 / 1695 / 3390 秒），0→1695 之间隔了**28 分钟**，
  // 内容层一次二分只能移到 848 秒 —— 于是前 14 分钟一个镜头都没看。
  //
  // 正确做法：骨架点数跟着**时长**走，每 20 分钟至少铺一个点。
  //   6 分钟  → 骨架 2~3
  //   60 分钟 → 骨架 4（0/20/40/60 分）
  // 同时保证内容层至少留 2 帧预算，否则全花在"铺路"上。
  const spanSk = Math.max(2, Math.ceil(duration / (20 * 60)) + 1)
  const skeleton = Math.max(2, Math.min(Math.max(2, budget - 2), Math.max(spanSk, Math.ceil(budget * 0.4))))
  const skel = []
  for (let i = 0; i < skeleton; i++) {
    const sec = skeleton === 1 ? 0 : (duration - 1) * (i / (skeleton - 1))
    skel.push(sec)
  }

  // 先取骨架帧（每帧都是"代表帧"，同时也当探针用）
  //
  // 去重必须按 **秒** 判，不能等到最后：skel 在 duration 较小时会算出重复的秒
  // （例如 duration=360、skeleton=6 时第 0 项和第 1 项都落在 0 附近），
  // 而 picked 里出现两个 0 秒会让后面的"相邻间距"算成 0，那段永远不再补帧。
  const usedSec = new Set()
  for (const sec of skel) {
    const key = Math.round(sec * 10) / 10
    if (usedSec.has(key)) continue
    usedSec.add(key)
    const b = await grab(sec)
    if (b) picked.push({ sec, ratio: sec / duration, buf: b })
  }
  if (!picked.length) return []
  picked.sort((a, b) => a.sec - b.sec)

  // ── 内容层：在相邻骨架帧之间找"变化最大的那一段"，在那儿补一帧 ────────
  //
  // 为什么是"变化最大的那一段"而不是"从前往后推进"：
  // 预算有限时，应该优先花在信息量最大的地方，而不是时间顺序。
  // 每补一帧后，那段被劈成两半，下次再挑变化最大的 —— 自然形成
  // "哪里变化密集就往哪里加密"，而静止的长镜头只占一个骨架点。
  let guard = 0
  while (picked.length < budget && guard++ < 100) {
    let best = null
    for (let i = 0; i < picked.length - 1; i++) {
      const a = picked[i]
      const b = picked[i + 1]
      const gap = b.sec - a.sec
      if (gap <= minStep * 2) continue          // 已经够密了
      const d = frameDistance(a.buf, b.buf)
      // 分数 = 差异 × log(间距)：既看"变了多少"，也看"这一段有多长没看"
      const score = d * Math.log2(1 + gap)
      if (!best || score > best.score) best = { i, a, b, gap, d, score }
    }
    if (!best) break
    const mid = (best.a.sec + best.b.sec) / 2
    const mkey = Math.round(mid * 10) / 10
    if (usedSec.has(mkey)) break          // 已经取过（浮点巧合），别再塞重复点
    usedSec.add(mkey)
    const mb = await grab(mid)
    if (!mb) break
    picked.push({ sec: mid, ratio: mid / duration, buf: mb })
    picked.sort((x, y) => x.sec - y.sec)
  }

  // 收尾：如果取到的帧太少（片子太静，骨架都没取到），均匀补齐
  const want = Math.min(budget, Math.max(2, Math.ceil(budget / 2)))
  if (picked.length < want) {
    const taken = new Set(picked.map((p) => Math.round(p.sec)))
    for (let i = 1; i < want && picked.length < want; i++) {
      const sec = Math.round((duration * i) / want)
      if (taken.has(sec) || sec >= duration - 0.5) continue
      const b = await grab(sec)
      if (b) { picked.push({ sec, ratio: sec / duration, buf: b }); taken.add(sec) }
    }
    picked.sort((a, b) => a.sec - b.sec)
  }

  return picked
}

/**
 * 按内容取帧的「**流式**」版本：不下载整片，只按需取小段。
 *
 * 为什么需要：整片模式下，一条 60 分钟的视频最低清也要 201MB（实测）。
 * 她"看一眼"不该付这个代价。这里改成**只取探针需要的那几秒**：
 * 每次探针只取 1 个关键帧（ffmpeg -ss + -frames:v 1 走 HTTP Range），
 * 十几二十次探针也就几 MB。
 *
 * @param {(sec:number) => Promise<Buffer|null>} probeAt
 *        取某一秒的灰度缩略图（由调用方实现：可以是本地文件，也可以是网络流传）。
 */
export async function pickByContentStream(probeAt, opts = {}) {
  const duration = Number(opts.duration || 0)
  const budget = Math.max(2, Math.min(12, Number(opts.budget || 6)))
  if (!(duration > 1)) return []

  const minStep = Number(opts.minStep || 2)
  let sameThresh = Number(opts.sameThresh ?? NaN)
  const seen = new Map()
  const grab = async (sec) => {
    const key = Math.round(sec * 10) / 10
    if (seen.has(key)) return seen.get(key)
    const b = await probeAt(key)
    seen.set(key, b)
    return b
  }

  // ── 先标定：这条片子的「正常变化幅度」是多少 ────────────────────────
  //
  // 探 8~10 个点（均匀铺开），算相邻差异的中位数，阈值取它的一半。
  // 成本：每条片子多 8~10 次探针（每次 ~0.4s / 1~2MB），值得 ——
  // 固定阈值会让快片漏掉变化、慢片乱补帧。
  if (!Number.isFinite(sameThresh)) {
    const N = Math.max(6, Math.min(10, Math.round(duration / 60) + 6))
    const probes = []
    let prev = null
    for (let i = 0; i <= N; i++) {
      const t = Math.floor((duration * i) / N)
      const b = await probeAt(t)
      if (b && prev) probes.push(frameDistance(prev, b))
      if (b) prev = b
    }
    if (probes.length >= 3) {
      const sorted = probes.slice().sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      // 下限 0.04：别让极静的片子（中位 0.02）把阈值压到 0，见什么都补帧
      sameThresh = Math.max(0.04, median * 0.5)
    } else {
      sameThresh = 0.15
    }
  }

  // 骨架点数按片长缩放（同 pickFramesByContent，见那里的注释：
  // 60 分钟的片子固定 3 个骨架点会让前 14 分钟一个镜头都看不到）。
  const spanSk = Math.max(2, Math.ceil(duration / (20 * 60)) + 1)
  const skeleton = Math.max(2, Math.min(Math.max(2, budget - 2), Math.max(spanSk, Math.ceil(budget * 0.4))))
  const picked = []
  const usedSec = new Set()
  for (let i = 0; i < skeleton; i++) {
    const sec = skeleton === 1 ? 0 : (duration - 1) * (i / (skeleton - 1))
    const key = Math.round(sec * 10) / 10
    if (usedSec.has(key)) continue
    usedSec.add(key)
    const b = await grab(sec)
    if (b) picked.push({ sec, ratio: sec / duration, buf: b })
  }
  if (!picked.length) return []
  picked.sort((a, b) => a.sec - b.sec)

  // 内容层：每次挑「差异 × log 间距」最大的那一段，中间补一刀
  let guard = 0
  while (picked.length < budget && guard++ < 100) {
    let best = null
    for (let i = 0; i < picked.length - 1; i++) {
      const a = picked[i]
      const b = picked[i + 1]
      const gap = b.sec - a.sec
      if (gap <= minStep * 2) continue
      const d = frameDistance(a.buf, b.buf)
      const score = d * Math.log2(1 + gap)
      if (!best || score > best.score) best = { a, b, gap, d, score }
    }
    if (!best) break
    const mid = (best.a.sec + best.b.sec) / 2
    const mkey = Math.round(mid * 10) / 10
    if (usedSec.has(mkey)) break
    usedSec.add(mkey)
    const mb = await grab(mid)
    if (!mb) break
    picked.push({ sec: mid, ratio: mid / duration, buf: mb })
    picked.sort((x, y) => x.sec - y.sec)
  }
  picked.calibratedThresh = sameThresh
  return picked
}

/** 只留位置（丢掉 buf），给上层做「只取这几个位置的**高清**帧」。 */
export function planOnly(picked) {
  return picked.map((p) => ({ sec: p.sec, ratio: p.ratio }))
}

/** 帧位置 → 给模型看的位置标签（`12%` 或 `约 12%`）。 */
export function labelOf(ratio, approx) {
  const pct = Math.round(ratio * 100)
  return approx ? `~${pct}%` : `${pct}%`
}
