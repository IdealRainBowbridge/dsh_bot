// bili-frames —— 给她「真的看一眼画面」的能力（B站）。
//
// 背景（10-31）：debrief 一直只吃文字（元信息/字幕/热评/简介），头注释里写着
// 「抽帧（ffmpeg）留给 v0.2 —— 没有直链时绝不伪装成"已看完"」。这一版把 v0.2 补上。
//
// 链路：view 拿 cid → wbi/playurl 拿 dash 直链 → curl 下载头部若干 MB →
//       ffmpeg 均匀抽 n 帧 → 交给 vision 描述 → 返回一段描述文本。
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

const execFileP = promisify(execFile)

/** 挑一条「容易下载、体积小」的流：优先 AVC(h264)，其次最低清晰度。 */
function pickStream(dash, preferQn = 0) {
  const list = (dash?.video || []).slice()
  if (!list.length) return null
  const avc = list.filter((s) => /^avc/i.test(String(s.codecs || '')))
  const pool = preferQn ? list.filter((s) => Number(s.id) === preferQn) : []
  const use = (pool.length ? pool : (avc.length ? avc : list))
  // 清晰度低 = id 小 = 体积小；h264 兼容性最好，ffmpeg 解起来最稳
  return use.sort((a, b) => Number(a.id) - Number(b.id))[0]
}

/** 用 ffmpeg 从一段 m4s 里均匀抽 n 帧（JPEG，宽度压到 720，够 vision 认）。 */
async function grabFrames(file, outDir, n) {
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, 'f-%d.jpg')
  // fps=1/3 ≈ 每 3 秒一帧；-frames:v n 封顶。scale 压到 720 宽省 token。
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-vf', `fps=1/3,scale=720:-2`,
    '-frames:v', String(Math.max(1, Math.min(n, 6))),
    '-q:v', '4', out, '-y',
  ]
  await execFileP('ffmpeg', args, { timeout: 60_000 })
  const dir = path.dirname(out)
  return fs.readdirSync(dir)
    .filter((f) => /^f-\d+\.jpg$/.test(f))
    .sort()
    .map((f) => path.join(dir, f))
    .filter((f) => { try { return fs.statSync(f).size > 1024 } catch { return false } })
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
    u.searchParams.set('qn', String(opts.qn ?? 32))
    u.searchParams.set('fnval', '16')      // 16 = dash
    u.searchParams.set('fourk', '0')
    const pu = await apiGet(u.href, H)
    if (pu?.code !== 0) return null            // 大会员/地区限制等，交给调用方降级
    const stream = pickStream(pu.data?.dash, Number(opts.qn ?? 0))
    const url = String(stream?.baseUrl || stream?.base_url || '')
    if (!url) return null

    // ③ 只下头部一小段（视频流是分片的，头部就够抽前几帧）
    fs.mkdirSync(tmp, { recursive: true })
    await execFileP('curl', [
      '-sS', '-L', '--max-time', '45',
      '-r', `0-${maxBytes}`,
      '-H', 'Referer: https://www.bilibili.com/',
      '-H', `User-Agent: ${H['user-agent'] || 'Mozilla/5.0'}`,
      '-o', file, url,
    ], { timeout: 60_000 })
    const size = (() => { try { return fs.statSync(file).size } catch { return 0 } })()
    if (size < 32 * 1024) return null          // 太小 = 没真拿到内容

    // ④ 抽帧
    const frames = await grabFrames(file, tmp, n)
    if (!frames.length) return null

    // ⑤ 让 vision 看一眼
    const desc = await describeFrames(frames, {
      query: opts.query
        || `这是同一条视频（《${String(d.title || '').slice(0, 40)}》）里按时间均匀抽的 ${frames.length} 帧画面。`
        + '用 2~3 句中文描述你**看到**的东西：画面里有什么人/物、在做什么、什么场景和风格。'
        + '只描述画面本身，不要推测剧情，不要复述标题。',
    })
    if (!desc) return null

    return { desc: String(desc).slice(0, 800), frames: frames.length, bytes: size, codec: String(stream?.codecs || ''), title: String(d.title || '') }
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
