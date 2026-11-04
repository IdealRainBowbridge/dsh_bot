// onebot-file —— 把本地图片变成 OneBot 能发的 file 值（2026-11-02）
//
// 病根：以前直接传 `file:///home/bot/.bot-ai/stickers/xxx.jpg`。
// 那是**容器内**路径，而真正的发送方 SnowLuma 跑在**宿主机**上 ——
// 宿主上根本没有 /home/bot/...，于是：
//   send_private_msg 返回 failed/100: EACCES: permission denied, stat '...'
// 每次表情包都发不出去，日志里只留一句"表情结果：没发出去"，看着像额度问题。
//
// 解法（最省事、不依赖任何路径映射）：**转 base64 data URI**。
// OneBot v11 的 image 段接受 `base64://<...>`，图片随请求体走，不碰对方文件系统。
// 代价是请求体变大（一张 25KB 图 → 34KB base64），对本地回环完全无感。
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 4 * 1024 * 1024   // 超过 4MB 不转 base64（请求体太大），退回 file:// 试试

/**
 * 把本地文件路径转成 OneBot 媒体段可接受的 file 值。
 *
 * 2026-11-04：语音条（record）也走这里。以前 record 直接传容器内绝对路径，
 * 和表情包当初一模一样 —— 宿主上的 SnowLuma 根本 stat 不到那个路径，
 * 日志里只有一句"语音失败（剩下转文字）"。image 和 record 共用同一套解法。
 *
 * @param {string} file 本地绝对路径
 * @returns {string} `base64://...` 或 `file:///...`（兜底）
 */
export function onebotFileValue(file) {
  const abs = path.resolve(String(file || ''))
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size === 0) throw new Error('not a file')
    if (st.size > MAX_BYTES) {
      // 太大：只能靠宿主路径（如果配置了映射的话）
      return 'file:///' + abs.replace(/\\/g, '/')
    }
    const b64 = fs.readFileSync(abs).toString('base64')
    return 'base64://' + b64
  } catch {
    return 'file:///' + abs.replace(/\\/g, '/')
  }
}
