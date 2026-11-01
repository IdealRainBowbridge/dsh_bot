// status —— QQ 在线状态工坊：她自己换状态（像人换签名/上线状态）。
// SnowLuma 的 set_online_status（OneBot v11 扩展）。
//   11=在线  1=Q我吧  30=离开  50=忙碌  60=勿扰  70=隐身
// 触发：睡眠开始→勿扰；睡醒→在线。也能手动换。
// 铁律：状态是她自己的事，随睡眠/情绪自动走，不用笨蛋老爸管。
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import { dataPath } from '../lib/paths.mjs'
import { writeJsonAtomic } from '../lib/atomic.mjs'

const CODES = { online: 11, qme: 1, away: 30, busy: 50, dnd: 60, invisible: 70 }
const NAMES = { 11: '在线', 1: 'Q我吧', 30: '离开', 50: '忙碌', 60: '勿扰', 70: '隐身' }
const STATE = () => dataPath('status.json')
const NL = String.fromCharCode(10)

async function callOnebot(action, params) {
  const cfg = config()
  const base = String(cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const r = await fetch(base + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(8000),
  })
  return await r.json().catch(() => ({}))
}

export async function setOnline(key) {
  const code = typeof key === 'number' ? key : (CODES[String(key).toLowerCase()] ?? Number(key))
  if (!Number.isFinite(code)) return { ok: false, error: 'unknown status: ' + key }
  const j = await callOnebot('set_online_status', { status: code, ext_status: 0, battery_status: 100 })
  const ok = j?.retcode === 0 || j?.status === 'ok'
  if (ok) {
    // 2026-11-02：改原子写。setOnline 会从 sleep（systemd 定时进程）和 status CLI 两边调，
    // 裸写有互相覆盖的风险；这份状态还被 /health 与面板读。
    try { writeJsonAtomic(STATE(), { status: String(key), code, at: Date.now() }) } catch { /* 换状态失败不该挡睡眠 */ }
  }
  return { ok, code, name: NAMES[code] || String(code), resp: j }
}

export function currentStatus() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) } catch { return { status: 'online', code: 11 } }
}

export async function run(args) {
  const sub = args[0]
  if (!sub || sub === 'show') {
    const cur = currentStatus()
    console.log('当前状态：' + (NAMES[cur.code] || cur.status) + '（' + cur.code + '）')
    console.log('可换：online 在线 / away 离开 / busy 忙碌 / dnd 勿扰 / invisible 隐身')
    return
  }
  const r = await setOnline(sub)
  console.log(r.ok ? '✓ 状态已换：' + r.name : '✗ 换状态失败：' + JSON.stringify(r.resp || r.error).slice(0, 120))
}
