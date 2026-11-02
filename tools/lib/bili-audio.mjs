// bili-audio —— 给她「听懂声音」的能力（B站）：取音轨 → ASR → 带时间码的稿子。
//
// 为什么必须有这一路（2026-11-02，用户原话「看看能不能搞个音频识别之类的，然后对齐观看帧」）：
//   看视频现有的三路证据都不牢：
//     · 字幕轨：番剧投稿经常串片（实测《可塑性记忆》01 的 40 段全是 ED 歌词），
//       或者根本是别的片（实测某番字幕轨是"iPhone16 钢化膜测评"）；
//     · 弹幕：只反映观众当下情绪，不反映剧情；
//     · 画面抽帧：能认出"有几个人、在做什么"，但认不出**说了什么**。
//   **音频流才是真正可压缩的信息流**：3391 秒的视频音轨只有 26~42MB，
//   可以整条取回、整段转写 —— 而且转写出来的东西自带时间码，
//   能直接和画面帧对上号（"第 40% 处画面里那个人正在说什么"）。
//
// 三条硬原则（同 bili-frames）：
//   1. 任何一步失败都返回 null，**绝不编造台词**。宁可让她说"这次没听见"。
//   2. 拿不到就明确说拿不到 —— 别用"大概说了什么"糊过去。
//   3. 转写结果不囤：用完就删（她要的是内容，不是语料库）。
//
// 依赖（容器内实测 2026-11-02）：
//   · ffmpeg 5.1.9 已有
//   · Python 3.11.2 + /home/feiyu/.data/asr-venv（faster-whisper，CPU int8）
//   · 模型落在 /home/feiyu/.data/asr-models（容器重建不丢）
//   · HF_ENDPOINT=hf-mirror.com + **HF_HUB_DISABLE_XET=1**
//     （xet 后端走 cas-server.xethub.hf.co，hf-mirror 不代理 → 401，踩过）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { apiGet, makeHeaders } from './bili-api.mjs'
import { loadCred } from './cred.mjs'
import { dataPath } from './paths.mjs'

const execFileP = promisify(execFile)

let lastHearWhy = ''

/** 上一次 hearVideo 为什么没成（空串 = 成功）。调用方据此在日志里说实话，而不是「看了但没内容」。 */
export function whyNoHear() { return lastHearWhy }

// ── 环境探测（都是一次性的，失败只影响"能不能用"，不影响别处） ────────────

/** ASR 的 python 解释器：优先独立 venv，其次环境变量，最后系统 python。 */
export function asrPython() {
  const cands = [
    process.env.BOT_ASR_PYTHON,
    '/home/feiyu/.data/asr-venv/bin/python',
    '/usr/bin/python3',
  ].filter(Boolean)
  for (const p of cands) {
    try {
      execFileSync(p, ['-c', 'import faster_whisper'], { stdio: 'ignore', timeout: 20000 })
      return p
    } catch { /* 下一个 */ }
  }
  return null
}

/** 模型目录外的可调项，都能用环境变量覆盖（换机器/换模型不用改代码）。 */
const CFG = () => ({
  model: process.env.BOT_ASR_MODEL || 'small',
  // small 的 RTF 实测 0.54（4 核 CPU）。超过这个时长就不整条转，免得她卡在那里等。
  maxMinutes: Number(process.env.BOT_ASR_MAX_MIN || 30),
  // 音质档位：0=最高(192k) 1=中(132k) 2=低(64k)。默认中档 —— 体积/识别率折中。
  quality: Number(process.env.BOT_ASR_QUALITY ?? 1),
})

/** ffmpeg / 解释器都在才认为这条链可用（调用方据此决定要不要尝试）。 */
export function asrReady() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }) } catch { return false }
  return Boolean(asrPython())
}

// ── 取音轨 ────────────────────────────────────────────────────────────────

/**
 * 挑一条音频流。B站 dash.audio 通常是 [30280(192k), 30232(132k), 30216(64k)]。
 * 默认取中档：整条音频本来就不大（1 小时 ≈ 42MB → 27MB），
 * 但 64k 在嘈杂实录上识别率明显掉，所以不省这一档。
 */
function pickAudio(dash, quality) {
  const list = (dash?.audio || []).slice().sort((a, b) => Number(b.id) - Number(a.id))
  if (!list.length) return null
  const i = Math.max(0, Math.min(list.length - 1, Number(quality) || 0))
  return list[i]
}

/** 用 curl 把整条音轨拉下来（带 Referer/UA，B站 CDN 认这个）。 */
async function downloadAudio(url, out, ua) {
  await execFileP('curl', [
    '-sS', '-L', '--max-time', '600',
    '-H', 'Referer: https://www.bilibili.com/',
    '-H', `User-Agent: ${ua || 'Mozilla/5.0'}`,
    '-o', out, url,
  ], { timeout: 660_000 })
  const sz = (() => { try { return fs.statSync(out).size } catch { return 0 } })()
  return sz
}

// ── ASR ───────────────────────────────────────────────────────────────────

// 这段 python 走 stdin 传参，不落盘成 .py 文件（她不需要在仓库里多养一个脚本）。
const PY = String.raw`
import os, sys, json, time
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ['HF_HUB_DISABLE_XET'] = '1'   # 见文件头注释
from faster_whisper import WhisperModel
wav, model_name, model_dir, lang, max_s = sys.argv[1:6]
t0 = time.time()
m = WhisperModel(model_name, device='cpu', compute_type='int8', download_root=model_dir)
# initial_prompt 不是可选项，是**必须项**：
#   实测不给它，faster-whisper small 在 zh 上跑到一分钟左右就开始往繁体/港台腔漂
#   （同一条视频从 00:30 的「我们开始上强度」变成 01:00 的「我們開始 上強度 藍塵與 AutoGEN」），
#   而且会把「客服」听成「克服」、「看完」听成「悬完」——一旦漂过去就再也回不来。
#   给一段简体书面中文当锚，整条稳定在简体普通话。附带的 task='transcribe' 明确不翻译。
segs, info = m.transcribe(
    wav, language=(lang or 'zh'), task='transcribe', beam_size=1, vad_filter=True,
    initial_prompt='以下是普通话的句子，使用简体中文转写。',
    vad_parameters={'min_silence_duration_ms': 500},
    # 关掉上下文接力：否则一句听错会顺着污染后面一整串
    condition_on_previous_text=False,
)
cap = float(max_s)
out = []
for s in segs:
    if cap > 0 and s.end > cap:
        break
    t = s.text.strip()
    if t:
        out.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': t})
print(json.dumps({
    'dur': round(info.duration, 1),
    'lang': info.language,
    'n': len(out),
    'elapsed': round(time.time() - t0, 1),
    'segs': out,
}, ensure_ascii=False))
`

/**
 * 真正跑一次转写。
 * @returns {Promise<{dur:number, segs:Array, elapsed:number}|null>}
 */
async function transcribe(wav, opts = {}) {
  const py = asrPython()
  if (!py) return null
  const c = CFG()
  const modelDir = process.env.BOT_ASR_MODEL_DIR || '/home/feiyu/.data/asr-models'
  try {
    const { stdout } = await execFileP(py, [
      '-c', PY, wav, opts.model || c.model, modelDir,
      opts.lang || 'zh', String(opts.maxSeconds || 0),
    ], { timeout: Number(opts.timeoutMs || 30 * 60_000), maxBuffer: 64 * 1024 * 1024 })
    // python 可能先打一堆进度/警告，JSON 在最后一行
    const lines = String(stdout || '').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim()
      if (!s.startsWith('{')) continue
      try { return JSON.parse(s) } catch { /* 往上继续找 */ }
    }
    return null
  } catch {
    return null
  }
}

// ── 成稿 ──────────────────────────────────────────────────────────────────

/** 把秒数拍成 mm:ss（一小时的片子用秒数没意义）。 */
function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 把分段转写压成给模型看的稿子。
 *
 * 直接全塞进去不行：一小时的片子有 1500+ 段，几万字，会把上下文吃光。
 * 这里按**等长时间窗**合并（默认 30 秒一窗），每窗一行带时间码 ——
 * 既保住"什么时候说的"，又把 token 压到 1/8 左右。
 */
function coalesce(segs, dur, windowSec = 30) {
  const win = Math.max(5, Number(windowSec) || 30)
  const buckets = new Map()
  for (const s of segs) {
    const k = Math.floor(Number(s.start) / win)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(s)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, arr]) => {
      const t0 = k * win
      const t1 = Math.min(dur || Infinity, t0 + win)
      const text = arr.map((x) => x.text).join(' ')
      return { t0, t1, at: `${mmss(t0)}-${mmss(t1)}`, text }
    })
}

/**
 * 听一条 B站视频的声音。
 *
 * @param {string} bvid
 * @param {{
 *   lang?: string,            // 转写语言，默认 zh
 *   quality?: number,         // 音质档位 0/1/2，默认 1（132k）
 *   maxMinutes?: number,      // 超过这个时长不整条转（默认 30，见 CFG）
 *   windowSec?: number,       // 成稿合并窗口，默认 30
 *   maxChars?: number,        // 稿子字数上限，默认 6000
 *   at?: number[],            // 想重点看的进度点（0~1），返回每处对应的台词
 * }} opts
 * @returns {Promise<null | {
 *   text: string,             // 成稿（带时间码）
 *   segs: number,
 *   dur: number,
 *   sampled: number,          // 真转写了多少秒（可能比 dur 短）
 *   via: string,              // 音轨档位
 *   bytes: number,            // 音轨体积
 *   atPoints?: Array<{at:string, ratio:number, line:string}>,
 *   elapsed: number,
 * }>}
 */
export async function hearVideo(bvid, opts = {}) {
  // 失败原因写在这里，成功了就清空 —— **不允许静默返回 null**。
  // 项目里最贵的 bug 都是"有值、不报错、判定正常"（见 M70 静默假数据）。
  lastHearWhy = ''
  const c = CFG()
  if (!asrReady()) { lastHearWhy = 'ASR 没装好（ffmpeg 或 faster-whisper 缺）'; return null }

  const tmp = dataPath('asr', 'bili-' + crypto.createHash('sha1').update(String(bvid)).digest('hex').slice(0, 10))
  const m4a = path.join(tmp, 'a.m4a')
  const wav = path.join(tmp, 'a.wav')
  try {
    const cred = loadCred()
    const H = makeHeaders(cred)

    // ① view：拿 cid
    const v = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, H)
    const d = v?.data
    if (!d?.cid) { lastHearWhy = `元信息读不到（code=${v?.code} ${v?.message || ''}）`; return null }

    // ② playurl：拿 dash 音轨
    const u = new URL('https://api.bilibili.com/x/player/wbi/playurl')
    u.searchParams.set('bvid', bvid)
    u.searchParams.set('cid', String(d.cid))
    u.searchParams.set('qn', '16')          // 只要音频，视频清晰度无所谓
    u.searchParams.set('fnval', '16')
    const pu = await apiGet(u.href, H)
    if (pu?.code !== 0) { lastHearWhy = `playurl 被拒（code=${pu?.code} ${pu?.message || ''}）`; return null }
    const stream = pickAudio(pu.data?.dash, opts.quality ?? c.quality)
    const url = String(stream?.baseUrl || stream?.base_url || '')
    if (!url) { lastHearWhy = '这条没有可用音轨（可能被版权限制）'; return null }

    // ③ 时长闸门：太长的片子整条转要等十几分钟，她不该卡在那儿。
    //    改用"取开头 maxMinutes 分钟"并在结果里**说清楚只转了前 N 分钟**。
    const dur = Number(pu.data?.dash?.duration || 0)
    const maxSeg = Math.max(1, Number(opts.maxMinutes ?? c.maxMinutes))
    const capSeconds = dur > maxSeg * 60 ? maxSeg * 60 : 0

    // ④ 下载
    fs.mkdirSync(tmp, { recursive: true })
    const bytes = await downloadAudio(url, m4a, H['user-agent'])
    if (!bytes || bytes < 16 * 1024) { lastHearWhy = `音轨没下下来（只拿到 ${bytes || 0} 字节）`; return null }

    // ⑤ 转 16k 单声道 wav（whisper 要的就是这个）
    await execFileP('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', m4a,
      ...(capSeconds ? ['-t', String(capSeconds)] : []),
      '-ac', '1', '-ar', '16000', wav, '-y',
    ], { timeout: 180_000 })
    const wavSz = (() => { try { return fs.statSync(wav).size } catch { return 0 } })()
    if (wavSz < 32 * 1024) { lastHearWhy = 'ffmpeg 转 wav 失败'; return null }

    // ⑥ 转写
    const r = await transcribe(wav, {
      lang: opts.lang,
      maxSeconds: 0,                 // 已经在 ffmpeg 里截过时长了
      timeoutMs: Math.max(120_000, (dur ? Math.min(dur, capSeconds || dur) : 600) * 4000),
    })
    if (!r || !Array.isArray(r.segs) || !r.segs.length) { lastHearWhy = '转写没有输出（模型或音频有问题）'; return null }

    // ⑦ 成稿
    const lines = coalesce(r.segs, r.dur || dur, opts.windowSec ?? 30)
    const maxChars = Number(opts.maxChars ?? 6000)
    let text = lines.map((l) => `[${l.at}] ${l.text}`).join('\n')
    let truncated = false
    if (text.length > maxChars) {
      // 砍掉的部分必须**说出来**，否则她把"前 4000 字"当成整集剧情
      text = text.slice(0, maxChars).trimEnd() + `\n（稿子到 ${Math.round(maxChars / 1000)} 千字为止，后面的没放进来）`
      truncated = true
    }

    // ⑧ 按进度点对齐（opts.at = [0.40, 0.75] 之类，和抽帧的位置一一对得上）
    let atPoints
    if (Array.isArray(opts.at) && opts.at.length && dur > 0) {
      atPoints = opts.at.map((ratio) => {
        const t = dur * Number(ratio)
        // 取该时刻之前最近的一句（人话是"说到这一句的时候画面是那个"）
        let hit = null
        for (const s of r.segs) {
          if (Number(s.start) <= t + 0.5) hit = s
          else break
        }
        return {
          ratio: Number(ratio),
          at: mmss(t),
          line: hit ? `[${mmss(hit.start)}] ${hit.text}` : '',
        }
      })
    }

    return {
      text,
      segs: r.segs.length,
      dur: Number(r.dur || dur || 0),
      sampled: capSeconds || Number(r.dur || dur || 0),
      via: `audio id=${stream?.id ?? '?'} ${stream?.codecs || ''}`.trim(),
      bytes,
      atPoints,
      truncated,
      elapsed: r.elapsed,
    }
  } catch (e) {
    lastHearWhy = '异常：' + String(e?.message || e).slice(0, 160)
    return null
  } finally {
    // 音轨/转写不囤
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** 自检：解释器 + ffmpeg + 模型能不能一起跑起来（selftest 用）。 */
export async function asrDoctor() {
  const py = asrPython()
  const out = { python: py, ffmpeg: false, model: null, ok: false }
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); out.ffmpeg = true } catch { /* */ }
  const c = CFG()
  out.model = c.model
  out.ok = Boolean(py && out.ffmpeg)
  return out
}
