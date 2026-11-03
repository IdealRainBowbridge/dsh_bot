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
//   - Python 3.11.2 + ~/.data/asr-venv (faster-whisper, CPU int8)
//   - models under ~/.data/asr-models (survives container rebuild)
//   · HF_ENDPOINT=hf-mirror.com + **HF_HUB_DISABLE_XET=1**
//     （xet 后端走 cas-server.xethub.hf.co，hf-mirror 不代理 → 401，踩过）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
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

/**
 * CUDA 运行库的路径（pip 装的 nvidia-*-cu12 wheel 里的 .so 不在 ld 搜索路径里，
 * 必须显式加 LD_LIBRARY_PATH，否则 ctranslate2 报
 * `Library libcublas.so.12 is not found or cannot be loaded`）。
 *
 * 2026-11-02 实测这台机器（GTX 1050 / Pascal / 2GB）：
 *   · ctranslate2 4.8.4 能枚举到 1 块卡，**但 Pascal 不支持 float16**
 *     （报 "does not support efficient float16 computation"，因为 GP107 是 CC 6.1，
 *      fp16 只有 1/64 速率，ct2 直接拒绝）
 *   · int8 在 GPU 上可用，且比 float32 快 25%
 *   · 结论：GPU 优先 int8，退 float32，再退 CPU int8
 */
// ASR data dir (venv + models). 2026-11-03: no more hardcoded /home/dsh.
// Precedence: BOT_ASR_DATA_DIR > parent of BOT_ASR_VENV > <homedir>/.data.
// In-container equivalent of the old absolute path (feiyu home = /home/dsh).
function asrDataDir() {
  if (process.env.BOT_ASR_DATA_DIR) return process.env.BOT_ASR_DATA_DIR
  const venv = process.env.BOT_ASR_VENV
  if (venv) return path.dirname(venv)
  return path.join(os.homedir(), '.data')
}

/** ASR venv python, derived from the data dir (env BOT_ASR_PYTHON still wins). */
function asrVenvPython() {
  return path.join(asrDataDir(), 'asr-venv', 'bin', 'python')
}

function cudaLibPath() {
  const base = path.join(asrDataDir(), 'asr-venv', 'lib', 'python3.11', 'site-packages', 'nvidia')
  return [
    path.join(base, 'cublas', 'lib'),
    path.join(base, 'cudnn', 'lib'),
    path.join(base, 'cuda_nvrtc', 'lib'),
  ].join(':')
}

/** ASR 的 python 解释器：优先独立 venv，其次环境变量，最后系统 python。 */
export function asrPython() {
  const cands = [
    process.env.BOT_ASR_PYTHON,
    asrVenvPython(),
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
  // GPU 实测 RTF 0.071（small/int8），CPU 实测 0.224 —— 差 3 倍。
  // 30 分钟意味着最坏 2 分钟（GPU）/ 7 分钟（CPU），后者她等不起。
  maxMinutes: Number(process.env.BOT_ASR_MAX_MIN || 30),
  // 音质档位：0=最高(192k) 1=中(132k) 2=低(64k)。默认中档 —— 体积/识别率折中。
  quality: Number(process.env.BOT_ASR_QUALITY ?? 1),
  // auto = 有 GPU 用 GPU，没有/失败就 CPU。也可以强制 cuda / cpu。
  device: (process.env.BOT_ASR_DEVICE || 'auto').toLowerCase(),
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
wav, model_name, model_dir, lang, max_s, dev, ctype = sys.argv[1:8]
t0 = time.time()

# 设备/精度自动降级。为什么需要：Pascal(GTX 1050, CC 6.1) 上 ct2 会**主动拒绝**
# float16，而 int8/float32 都行；换一台机器又可能反过来。写死任何一个都会在
# 某个环境上直接失败，然后被上层当成"没听见"—— 又是静默失败。
cands = []
if dev == 'cuda':
    if ctype: cands.append(('cuda', ctype))
    cands += [('cuda', 'int8'), ('cuda', 'float32')]
elif dev == 'cpu':
    cands += [('cpu', 'int8'), ('cpu', 'float32')]
else:  # auto
    cands += [('cuda', 'int8'), ('cuda', 'float32'), ('cpu', 'int8'), ('cpu', 'float32')]

m = None
used = None
errs = []
for d, ct in cands:
    try:
        m = WhisperModel(model_name, device=d, compute_type=ct, download_root=model_dir)
        used = {'device': d, 'compute_type': ct}
        break
    except Exception as e:
        errs.append(f'{d}/{ct}: {str(e)[:120]}')
if m is None:
    print(json.dumps({'error': 'no usable device', 'tries': errs}, ensure_ascii=False))
    sys.exit(2)
def run(vad):
    segs, info = m.transcribe(
        wav, language=(lang or 'zh'), task='transcribe', beam_size=1, vad_filter=vad,
        initial_prompt='以下是普通话的句子，使用简体中文转写。',
        vad_parameters={'min_silence_duration_ms': 500} if vad else None,
        # 关掉上下文接力：否则一句听错会顺着污染后面一整串
        condition_on_previous_text=False,
    )
    return segs, info

# ── 繁转简（必须在转写之后强制做）─────────────────────────────────────
#
# 2026-11-02 实测：只要音频够长，faster-whisper small 的中文就**必然**往繁体漂，
# initial_prompt 只能压住开头：
#   2 分钟视频：漂移段 7 → 2（prompt 有效）
#   53 分钟番剧：**整条 65.5% 的字是繁体**，24 个时间窗里 15 个繁体为主，
#                而且简繁来回跳（00:00 简体 → 00:30 全繁体 → 02:30 又简体）
# 再试"分块 + 把上一段末尾当 prompt 传下去"：只降到 55.6%，杯水车薪。
# 结论：这不是 prompt 能解决的问题，是模型层面的不稳定性。
#       → 转写后**无条件**做一次繁转简（opencc t2s），不依赖模型心情。
# 用 **tw2s** 而不是 t2s：
#   t2s 按大陆标准做「繁体→简体」，把「著」当正字保留（看著→看著、著急→著急）；
#   但模型漂出来的其实是**港台用字**，得用 tw2s（台灣正體→简体）：
#   看著→看着、著急→着急、乾脆→干脆。实测过，只有 tw2s 全部正确。
#
# 但 tw2s 有个反直觉的副作用：它按**台湾标准**输出，把「麼」转成「幺」
#   （什么 → 什幺、怎么 → 怎幺），在大陆读起来是错字。
# 而 t2s 又保留「著」（看著 不转成 看着）。两边都不完整。
# 所以：**先 tw2s 再定向补一刀 幺→么**。实测组合后：
#   那幺→那么  什么→什么  怎幺→怎么  看著→看着  著急→着急  乾脆→干脆
import re as _re
try:
    import opencc
    _cc = opencc.OpenCC('tw2s')
except Exception:
    _cc = None
_YAO = _re.compile('幺')

def to_simplified(t):
    if not _cc or not t:
        return t
    return _YAO.sub('么', _cc.convert(t))

# VAD 的致命失效（2026-11-02 实测）：
#   纯音乐/音效密集的片子（鬼畜、MAD、纯 BGM 的番）里，VAD 会把整条判成"几乎没语音"，
#   于是只转开头十几秒就收工 —— 实测一条 359 秒的视频只出 8 段、止于 26.8 秒（7%），
#   而返回的 sampled 却是 359.2（全片）。**听起来像听完了，其实只听了开头。**
#   判据：转写覆盖 < 60% 时长 且 时长 > 60 秒 → 关掉 VAD 重跑一遍，取覆盖更全的那次。
segs, info = run(True)
segs = list(segs)
dur_all = float(info.duration or 0)
covered = (segs[-1].end - segs[0].start) if segs else 0
vadFellBack = False
if dur_all > 60 and covered < dur_all * 0.6:
    segs2, info2 = run(False)
    segs2 = list(segs2)
    covered2 = (segs2[-1].end - segs2[0].start) if segs2 else 0
    if covered2 > covered:
        segs, info, covered = segs2, info2, covered2
        vadFellBack = True
        dur_all = float(info.duration or dur_all)

cap = float(max_s)
out = []
for s in segs:
    if cap > 0 and s.end > cap:
        break
    t = to_simplified(s.text.strip())
    if t:
        out.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': t})
print(json.dumps({
    'dur': round(info.duration, 1),
    'lang': info.language,
    'n': len(out),
    'elapsed': round(time.time() - t0, 1),
    'device': used,
    'vadFellBack': vadFellBack,
    # 真正听到哪儿了 —— 不是"音频有多长"。
    # 上层必须用这个而不是 dur 来算"听了几成"，否则 VAD 短转会被当成听完。
    'heardTo': round(out[-1]['end'], 1) if out else 0,
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
  const modelDir = process.env.BOT_ASR_MODEL_DIR || path.join(asrDataDir(), 'asr-models')
  const dev = String(opts.device || c.device || 'auto').toLowerCase()
  // LD_LIBRARY_PATH 必须带上 pip 装的 CUDA 库，否则 ct2 找不到 libcublas.so.12
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [cudaLibPath(), process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':'),
  }
  try {
    const { stdout } = await execFileP(py, [
      '-c', PY, wav, opts.model || c.model, modelDir,
      opts.lang || 'zh', String(opts.maxSeconds || 0), dev, String(opts.computeType || ''),
    ], { timeout: Number(opts.timeoutMs || 30 * 60_000), maxBuffer: 64 * 1024 * 1024, env })
    // python 可能先打一堆进度/警告，JSON 在最后一行
    const lines = String(stdout || '').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim()
      if (!s.startsWith('{')) continue
      try {
        const j = JSON.parse(s)
        if (j.error) { lastHearWhy = `没有可用设备：${JSON.stringify(j.tries).slice(0, 200)}`; return null }
        return j
      } catch { /* 往上继续找 */ }
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
/**
 * 把「喵喵喵喵喵喵…」这种重复压掉。
 *
 * 为什么必须压：ASR 遇到拟声词/叠词/长音会逐字输出，实测一条鬼畜视频出现
 * 三百多个「喵」连成一串，单行 400+ 字。它既占上下文，又什么信息都没有。
 * 只压真正的机械重复（同一字连 4 次以上），不碰正常叠词（"慢慢""看看""谢谢"）。
 */
function squashRepeats(text, maxRun = 3) {
  return String(text || '').replace(/([\u4e00-\u9fa5A-Za-z])\1{3,}/g, (m, ch) => {
    const n = m.length
    return ch + ch + ch + `…（重复${n}次）`
  })
}

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
      const text = squashRepeats(arr.map((x) => x.text).join(' '))
      return { t0, t1, at: `${mmss(t0)}-${mmss(t1)}`, text }
    })
}

/**
 * 听一条 B站视频的声音。
 *
 * @param {string} bvid
 * @param {object} [opts.playurl]  调用方已经拿到的 playurl 响应（省一次请求）。
 *   为什么重要：B 站对 `player/wbi/playurl` 限流很紧（-412，约 2 分钟）。
 *   debrief 在几秒内本来就要请求它，如果 hearVideo 再请求一次，
 *   连续三次就必被拦 —— 表现是"音频链路坏了"，其实是被自己打死。
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

    // ② playurl：拿 dash 音轨。**优先复用调用方已经拿到的**（少一次请求 = 少一次限流）
    let pu = opts.playurl
    if (!pu || pu.code !== 0) {
      const u = new URL('https://api.bilibili.com/x/player/wbi/playurl')
      u.searchParams.set('bvid', bvid)
      u.searchParams.set('cid', String(d.cid))
      u.searchParams.set('qn', '16')          // 只要音频，视频清晰度无所谓
      u.searchParams.set('fnval', '16')
      pu = await apiGet(u.href, H)
    }
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
    //
    // 三条必须守的规矩（都是踩出来的）：
    //   ① 用 **heardTo**（真转写到哪）而不是 dur 去判断"覆盖没覆盖到"。
    //      否则 VAD 短转（只转 7%）时，40%/75% 全部越界，
    //      而循环会退回**最后一句**，三个位置全报同一句 —— 看着像"对齐了"，其实全是开头那句。
    //   ② 越界的点必须明说"没听到那里"，不许拿最近的一句冒充。
    //   ③ 同一句被多个点命中时照实标（说明覆盖率不足），不要假装是三处不同的台词。
    const heardTo = Number(r.heardTo || 0)
    const fullDur = Number(r.dur || dur || 0)
    let atPoints
    if (Array.isArray(opts.at) && opts.at.length && fullDur > 0) {
      atPoints = opts.at.map((ratio) => {
        const t = fullDur * Number(ratio)
        if (heardTo > 0 && t > heardTo + 1) {
          return {
            ratio: Number(ratio),
            at: mmss(t),
            line: '',
            heard: false,
            why: `只转写到 ${mmss(heardTo)}，这个位置没听到`,
          }
        }
        // 取该时刻之前最近的一句（人话是"说到这一句的时候画面是那个"）
        let hit = null
        for (const s of r.segs) {
          if (Number(s.start) <= t + 0.5) hit = s
          else break
        }
        return {
          ratio: Number(ratio),
          at: mmss(t),
          line: hit ? `[${mmss(hit.start)}] ${squashRepeats(hit.text, 2)}` : '',
          heard: Boolean(hit),
        }
      })
    }

    return {
      text,
      segs: r.segs.length,
      dur: Number(r.dur || dur || 0),
      // sampled = **真的转写到哪一秒**，不是音频总长。
      // 这条口径要是错了，上层会把她"只听开头"当成"听完一整集"。
      sampled: Number(r.heardTo || capSeconds || 0),
      via: `audio id=${stream?.id ?? '?'} ${stream?.codecs || ''}`.trim(),
      device: r.device || null,      // {device:'cuda', compute_type:'int8'} —— 让她/日志知道跑在哪
      vadFellBack: Boolean(r.vadFellBack),  // VAD 失效后重跑过（纯音乐/鬼畜片常见）
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
  const out = { python: py, ffmpeg: false, model: null, ok: false, device: null, gpus: 0 }
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); out.ffmpeg = true } catch { /* */ }
  const c = CFG()
  out.model = c.model
  out.device = c.device
  // 只报事实：能不能看到卡、有没有 cublas。不报"应该能用"。
  if (py) {
    try {
      const r = execFileSync(py, ['-c',
        'import ctranslate2;print(ctranslate2.get_cuda_device_count())'], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000,
        env: { ...process.env, LD_LIBRARY_PATH: cudaLibPath() },
      })
      out.gpus = Number(String(r).trim()) || 0
    } catch { out.gpus = 0 }
  }
  out.ok = Boolean(py && out.ffmpeg)
  return out
}
