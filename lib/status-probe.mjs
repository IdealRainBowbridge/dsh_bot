// status-probe —— /api/status 里的「外设探活」：NapCat 端口 / 微信心跳 / RVC 音色 / 登录二维码
// （2026-11-04 自 lib/index.js 外迁）
//
// 为什么搬：这些是纯 IO 探测（net.connect + 读文件），和"插件壳装配"无关，
// 但它们把 lib/index.js 顶过了门禁的 1150 行上限 —— 而壳的规模本身是有意义的约束：
// 一旦壳开始长，所有人都会往壳里塞东西。
//
// 语义一字未改（含两条踩过的坑）：
//   · NapCat 探活必须探**配置里那个 host**（容器内 127.0.0.1:3000 什么都没有，
//     而配置写的是 172.17.0.1 —— 写死 127 会让面板永远显示「QQ 掉线」）
//   · 二维码路径不能写死 D:/NapCat（Windows 开发机路径，Linux 容器里必然 ENOENT）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { swallow } from '../tools/lib/swallow.mjs'

/**
 * 探 NapCat 是否在监听。
 * @param {string} napcatUrl 形如 http://172.17.0.1:3000
 * @returns {Promise<{napcat: {ok: boolean, online: boolean, url?: string, host?: string, port?: number, checkedAt: number}}>}
 */
export async function probeQqChannel(napcatUrl) {
  try {
    const url = String(napcatUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')
    let port = 3000
    let host = '127.0.0.1'
    try {
      const u = new URL(url)
      port = Number(u.port) || 3000
      host = u.hostname || '127.0.0.1'
    } catch (e) { swallow(e, 'status-probe:napcat-url') }
    const open = await new Promise((resolve) => {
      const sock = net.connect({ host, port })
      const finish = (v) => {
        try { sock.destroy() } catch (e) { swallow(e, 'status-probe:napcat-sock') }
        resolve(v)
      }
      sock.setTimeout(1200)
      sock.once('connect', () => finish(true))
      sock.once('error', () => finish(false))
      sock.once('timeout', () => finish(false))
    })
    return { napcat: { ok: open, online: open, url, host, port, checkedAt: Date.now() } }
  } catch {
    // 探活失败就是『连不上』：这是探测的正常结论之一，不需要第二层留痕
    return { napcat: { ok: false, online: false, checkedAt: Date.now() } }
  }
}

/**
 * 读微信心跳文件与 RVC 当前音色。
 *
 * ⚠️ 两个路径都写死在 `~/.bot-ai`（旧数据目录名），**故意不改**：
 * 写它们的进程（wechat 侧、voice 侧）用的也是这个路径，改单边会让面板与写入端分叉。
 * 等那两侧一起搬进 dataPath() 再统一。
 * @returns {{wxBeat: object|null, rvcVoice: string}}
 */
export function readSidecars() {
  let wxBeat = null
  try {
    wxBeat = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bot-ai', 'wechat-heartbeat.json'), 'utf8'))
  } catch (e) { swallow(e, 'status-probe:wx-beat') }
  let rvcVoice = ''
  try {
    rvcVoice = String(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bot-ai', 'rvc-voice.json'), 'utf8')).current || '')
  } catch (e) { swallow(e, 'status-probe:rvc-voice') }
  return { wxBeat, rvcVoice }
}

/**
 * 找 NapCat 登录二维码（未登录时 3000 是关的，这不是故障）。
 * @param {string} configured 配置里的路径（优先）
 * @returns {{path: string, ageSec: number}|null} 只报 15 分钟内的
 */
export function findNapcatQr(configured) {
  try {
    const qrPath = String(configured || '') || [
      'D:/NapCat/cache/qrcode.png',
      path.join(os.homedir(), '.napcat', 'cache', 'qrcode.png'),
      '/opt/napcat/cache/qrcode.png',
    ].find((p) => { try { return fs.existsSync(p) } catch { return false } })
      || (process.platform === 'win32' ? 'D:/NapCat/cache/qrcode.png' : '/opt/napcat/cache/qrcode.png')
    const st = fs.statSync(qrPath)
    const age = Date.now() - st.mtimeMs
    return age < 15 * 60_000 ? { path: qrPath, ageSec: Math.round(age / 1000) } : null
  } catch (e) {
    swallow(e, 'status-probe:napcat-qr')
    return null
  }
}
