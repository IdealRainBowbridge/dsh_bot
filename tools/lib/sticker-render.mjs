// sticker-render —— 用 ffmpeg 现画一张文字贴纸（v5 新增，替代 python+PIL）。
//
// 为什么换掉 python+PIL：
//   · 容器里没有 python3，pyenv 里也没装 PIL → "AI 画不出来就退 PIL 文字贴纸"
//     这条兜底**从未生效**（每次都是静默 null）。
//   · 而 ffmpeg + 一套中文字体是这套系统本来就有的硬依赖（视频/语音链路都要用）。
//     用已有依赖做这件事，比为一个降级路径再装一套 python 环境划算得多。
//
// 设计：柔和底色（按文案哈希取色）+ 居中大字 + 圆角观感靠内边距+描边实现。
// 失败返回 null，绝不抛 —— 这是兜底路径。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homePath } from './paths.mjs'
import { swallow } from './swallow.mjs'

/** 柔和底色（浅色系，配深色字）。和 python 版保持同一套配色。 */
const PALETTE = [
  'FFF4D6', 'FFE7E9', 'E2F3FF', 'E8F0FF',
  'EBF7E9', 'F6ECFF', 'FFF0E2', 'E2F6F4',
]
const INK = '262A34'

/** 候选字体：容器自带的第一优先。 */
const FONTS = [
  () => homePath('.feiyu-ai', 'fonts', 'NotoSansCJK.ttc'),
  () => '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  () => '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  () => 'C:/Windows/Fonts/msyhbd.ttc',
]

export function findFont() {
  for (const f of FONTS) {
    try { const p = f(); if (p && fs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return ''
}

/** ffmpeg 在不在。 */
export function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { timeout: 5000, stdio: 'ignore' }); return true } catch { return false }
}

/** ffmpeg 有没有 drawtext（Debian 的 ffmpeg 默认带 libfreetype，但不能假设）。 */
let _drawtext = null
export function hasDrawtext() {
  if (_drawtext !== null) return _drawtext
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 8000, stdio: 'pipe' })
    _drawtext = /\bdrawtext\b/.test(String(out))
  } catch { _drawtext = false }
  return _drawtext
}

/** 整套能力是否可用（diagnose 用同一判定）。 */
export function available() {
  if (!hasFfmpeg()) return { ok: false, why: 'ffmpeg 不可用' }
  if (!hasDrawtext()) return { ok: false, why: 'ffmpeg 没有 drawtext 滤镜（缺 libfreetype）' }
  const font = findFont()
  if (!font) return { ok: false, why: '找不到中文字体（试过 ~/.feiyu-ai/fonts 与系统路径）' }
  return { ok: true, font, why: '' }
}

/** ffmpeg 的 drawtext 参数需要转义一堆字符，这里统一处理。 */
function escText(s) {
  // 冒号、反斜杠、单引号、百分号都要转义；换行不支持（贴纸本来就一行）
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .slice(0, 16)
}

/**
 * 画一张贴纸。
 * @param {string} caption 文案（最多 16 字）
 * @param {string} out 输出 png 绝对路径
 * @returns {string|null} 成功返回路径，失败 null
 */
export function renderSticker(caption, out) {
  const cap = String(caption || '').trim().slice(0, 16)
  if (!cap) return null
  const avail = available()
  if (!avail.ok) {
    if (!renderSticker._warned) {
      renderSticker._warned = true
      try { swallow(new Error(avail.why), 'sticker-render:unavailable') } catch { /* ignore */ }
    }
    return null
  }

  const seed = crypto.createHash('md5').update(cap).digest()
  const bg = PALETTE[seed[0] % PALETTE.length]
  const size = 480
  // 字号按字数自适应：1-2 字最大，越长的字越小
  const fs2 = cap.length <= 2 ? 132 : cap.length <= 4 ? 108 : cap.length <= 8 ? 78 : 58
  const vf = [
    `drawbox=x=18:y=18:w=iw-36:h=ih-36:color=0x${INK}@0.10:t=4`,
    `drawtext=fontfile='${avail.font}':text='${escText(cap)}':fontcolor=0x${INK}:fontsize=${fs2}:x=(w-text_w)/2:y=(h-text_h)/2`,
  ].join(',')

  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const tmp = out + '.tmp.png'
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x${bg}:s=${size}x${size}:d=1`,
      '-vf', vf, '-frames:v', '1', tmp,
    ], { timeout: 25000, stdio: 'ignore' })
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 500) return null
    fs.renameSync(tmp, out)
    return out
  } catch (e) {
    try { swallow(e, 'sticker-render:ffmpeg') } catch { /* ignore */ }
    return null
  }
}
