// image-kind —— 判断用户发来的图是「表情包」还是「要我看的图」（2026-11-02）
//
// 为什么需要：以前所有图片都是一个待遇 —— 原图丢给视觉模型 → 模型老老实实描述一遍
// （"这是一张卡通鱼在笑"）。但表情包不是内容，是**语气**：
//   "今天好累 [鱼躺平表情]" —— 她要接的是"累"，不是"这是一张鱼躺着"。
// 分不清的代价：语气丢了，回复变成图片说明文。
//
// 判断三层（从最可靠到最兜底）：
//   ① QQ 元数据：subType=1 或 summary 含「表情」→ 确定是表情包（最准，但常缺）
//   ② 尺寸/体积：≤320px 且 ≤800KB → 大概率表情包（表情包都是小图方图）
//   ③ 上下文：这条消息除图之外没有别的字，且最近对话是轻松语气 → 倾向表情包
// 任何一层给不出结论就退回 'unknown'，由提示词按"可能是语气"处理（宁可当语气，别写说明文）。
import fs from 'node:fs'

/** 读 PNG 宽高（IHDR 在 offset 16..24）。 */
function pngSize(b) {
  if (b.length < 24) return null
  if (b[0] !== 0x89 || b[1] !== 0x50) return null
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

/** 读 JPEG 宽高（扫 SOFn 段）。 */
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null
  let i = 2
  while (i < b.length - 9) {
    if (b[i] !== 0xFF) { i++; continue }
    const marker = b[i + 1]
    // SOF0-SOF3 / SOF5-SOF7 / SOF9-SOF11 / SOF13-SOF15 都带尺寸
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
    }
    const len = b.readUInt16BE(i + 2)
    if (!len || len < 2) break
    i += 2 + len
  }
  return null
}

/** GIF 宽高（offset 6..10 小端）。 */
function gifSize(b) {
  if (b.length < 10) return null
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null
  return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
}

/** WEBP（RIFF....WEBP + VP8/VP8L/VP8X）。 */
function webpSize(b) {
  if (b.length < 30) return null
  if (b.toString('ascii', 0, 4) !== 'RIFF') return null
  if (b.toString('ascii', 8, 12) !== 'WEBP') return null
  const fmt = b.toString('ascii', 12, 16)
  if (fmt === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
  if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3FFF, h: b.readUInt16LE(28) & 0x3FFF }
  if (fmt === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { w: (bits & 0x3FFF) + 1, h: ((bits >> 14) & 0x3FFF) + 1 }
  }
  return null
}

/** 读本地图片的宽高与体积；读不出来返回 null（不抛）。 */
export function probeImage(file) {
  try {
    const st = fs.statSync(file)
    // 只读头部 64KB 够判断所有格式
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(65536, st.size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const dim = pngSize(buf) || jpegSize(buf) || gifSize(buf) || webpSize(buf)
    return { bytes: st.size, w: dim?.w ?? null, h: dim?.h ?? null }
  } catch { return null }
}

/**
 * 判断这张图是什么性质。
 *
 * @param {object} p
 * @param {string} [p.file]        本地图片路径（取尺寸用）
 * @param {object} [p.seg]         原始 OneBot image 段（读 subType/summary）
 * @param {string} [p.text]        这条消息里的文字部分（除图之外）
 * @param {string} [p.recentTone]  最近对话语气 'light' | 'serious' | ''
 * @returns {{kind:'sticker'|'photo'|'unknown', why:string, w?:number, h?:number, bytes?:number}}
 */
export function classifyImage({ file, seg, text = '', recentTone = '' } = {}) {
  // ① QQ 元数据最可靠
  const sub = String(seg?.data?.subType ?? seg?.data?.sub_type ?? '')
  const sum = String(seg?.data?.summary ?? '')
  if (sub === '1' || /表情|mface|sticker/i.test(sum) || /\[动画表情\]/.test(sum)) {
    return { kind: 'sticker', why: 'QQ 标记为表情包' }
  }

  // ② 尺寸/体积
  const info = file ? probeImage(file) : null
  if (info && info.w && info.h) {
    const maxSide = Math.max(info.w, info.h)
    const minSide = Math.min(info.w, info.h)
    const squareish = minSide / maxSide > 0.6      // 表情包基本是方的
    // 小方图 + 体积不大 = 表情包；这条是经验规则，置信度低于 ①
    if (maxSide <= 320 && squareish && info.bytes <= 800 * 1024) {
      return { kind: 'sticker', why: `小方图 ${info.w}×${info.h}`, ...info }
    }
    // 大图 / 长图 / 明显不是方的 = 正经图片
    if (maxSide >= 500 || !squareish) {
      return { kind: 'photo', why: `图片 ${info.w}×${info.h}`, ...info }
    }
  }

  // ③ 上下文兜底：没文字 + 轻松语气 → 倾向表情包
  if (!String(text || '').trim() && recentTone === 'light') {
    return { kind: 'sticker', why: '无配文 + 轻松语气' }
  }

  // 给不出确定结论 —— 交给提示词按"可能只是语气"处理，别写成说明文
  return { kind: 'unknown', why: info ? `${info.w}×${info.h} 拿不准` : '无尺寸信息', ...(info || {}) }
}
