// videoframe —— 收到视频消息时真的"看"：下载 → 抽帧 → 并入视觉通道（2026-11-05）。
//
// 病根（用户抓的现行）：她收到视频号/视频消息，onebot.mjs 只打一个
// 【发了一段视频】占位标记——占位符骗她以为自己看过（与"字幕 0% 串片还硬当
// 读过"是同一类病，她自己日记里写过"该早点承认读不到"）。
//
// 修复：video 段的 data.url 下载到临时文件 → ffmpeg 均匀抽 3 帧 → 走与图片
// 相同的 image_url 合并通道（原生收图，一次调用完成看视频+回复）。
// 全链失败安全：任一步失败 → 退回【发了一段视频】占位标记 + 明确"没看成"，
// 绝不假装看过。
//
// 用法（qq-server 接线）：
//   const vf = await sampleVideo(seg.data)     // seg.data.url / file_id
//   vf.frames = ['/tmp/v/frame-0.jpg', ...]   → 并入 imageUris 通道
//   vf.note = '【他发来一段视频，你抽帧看到了 3 个画面】'（成功）
//          或 '【他发来一段视频，但没能打开——不知道里面是什么】'（失败）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { swallow } from './swallow.mjs'

const execFileAsync = promisify(execFile)

const FRAMES = 3          // 抽帧数（视觉模型 maxFrames 默认 3，别超）
const TIMEOUT_MS = 30_000 // 下载+抽帧总预算：聊天回复不能等太久

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bot-vid-'))
}

/** 下载视频（data.url 直链；file_id 走 OneBot get_video 由调用方传入 resolved URL）。 */
async function download(url, dir) {
  const dst = path.join(dir, 'input.mp4')
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 10_000) throw new Error('video too small (' + buf.length + 'B)')
  fs.writeFileSync(dst, buf)
  return dst
}

/** ffmpeg 均匀抽帧：先探测时长，再按时刻 -ss 抽，帧小省 token。 */
async function sampleFrames(video, dir) {
  let dur = 0
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', video], { timeout: 8000 })
    dur = Number(JSON.parse(stdout).format?.duration || 0)
  } catch { /* 探测失败就按 10s 处理 */ }
  const eff = dur > 0.5 ? dur : 10
  const frames = []
  for (let i = 0; i < FRAMES; i++) {
    const at = Math.max(0.1, (eff * (i + 0.5)) / FRAMES)
    const out = path.join(dir, `frame-${i}.jpg`)
    try {
      await execFileAsync('ffmpeg', ['-y', '-ss', String(at), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '7', out], { timeout: 8000 })
      if (fs.existsSync(out) && fs.statSync(out).size > 2000) frames.push(out)
    } catch (e) { swallow(e, 'videoframe:frame-' + i) }
  }
  if (!frames.length) throw new Error('no frames extracted')
  return frames
}

/**
 * 视频段 → { frames: string[], note: string } | null。
 * @param seg video 段的 data（url 直链优先；file_id 需要调用方先 get_video 换 URL）
 */
export async function sampleVideo(seg, { getVideoUrl } = {}) {
  try {
    let url = String(seg?.url || '').trim()
    if (!url && seg?.file_id && typeof getVideoUrl === 'function') {
      const r = await getVideoUrl(String(seg.file_id))
      url = String(r || '').trim()
    }
    if (!url || !/^https?:\/\//.test(url)) return null
    const dir = tmpDir()
    try {
      const video = await download(url, dir)
      let dur = 0
      try {
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', video], { timeout: 8000 })
        dur = Number(JSON.parse(stdout).format?.duration || 0)
      } catch { /* 探测失败不影响抽帧 */ }
      const frames = await sampleFrames(video, dir)
      return {
        frames,
        note: `【他发来一段视频${dur > 0 ? `（约 ${Math.round(dur)} 秒）` : ''}——你抽帧看了 ${frames.length} 个画面，基于画面聊】`,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } },
      }
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
      // 诚实兜底：说清楚没看成，不装
      return {
        frames: [],
        note: '【他发来一段视频，但没能打开看——不知道里面是什么。别装看过，直接问他视频里是什么】',
        cleanup: () => {},
      }
    }
  } catch (e) {
    swallow(e, 'videoframe:sample')
    return null
  }
}
function dur_note(d) { return d > 0 ? `（约 ${Math.round(d)} 秒）` : '' }
