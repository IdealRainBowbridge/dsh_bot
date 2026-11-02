// status —— QQ 在线状态工坊：她自己换状态（像人换签名/上线状态）。
// SnowLuma 的 set_online_status（OneBot v11 扩展）。
//   11=在线  1=Q我吧  30=离开  50=忙碌  60=勿扰  70=隐身
// 触发：睡眠开始→勿扰；睡醒→在线。也能手动换。
// 铁律：状态是她自己的事，随睡眠/情绪自动走，不用笨蛋老爸管。
import fs from 'node:fs'
import * as PRESENCE from '../brain/organ/presence.mjs'
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

// 存在感执行器（2026-11-03）：判断在 organ/presence（tick 只算不执行），执行住这里。
// status 是 QQ 在线状态的唯一出口，睡眠（sleep.mjs）/身体（本函数）两条自动线都汇到
// setOnline。成功才 mark() 落盘；失败不写「已换」，下一拍自然重算重试。
export async function presenceStep(now = Date.now()) {
  const r = PRESENCE.tick(now)
  if (!r || !r.changed) return r
  const res = await setOnline(r.key)
  if (res && res.ok) {
    PRESENCE.mark(r.key, r.why || '', now)
    return { ...r, done: true }
  }
  return { ...r, done: false, error: JSON.stringify((res && res.resp) || (res && res.error) || '').slice(0, 80) }
}

export function currentStatus() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) } catch { return { status: 'online', code: 11 } }
}

export async function run(args) {
  const sub = args[0]
  // --step：存在感器官走一拍（心跳 vitals.presence 每 5 分钟拉一次；也能手动跑）。
  // 只在有得换时出声 —— 体征不吵。
  if (sub === '--step') {
    const r = await presenceStep()
    if (r && r.done) console.log('[presence] ' + r.key + (r.why ? '（' + r.why + '）' : ''))
    return
  }
  if (!sub || sub === 'show') {
    const cur = currentStatus()
    console.log('当前状态：' + (NAMES[cur.code] || cur.status) + '（' + cur.code + '）')
    console.log('可换：online 在线 / away 离开 / busy 忙碌 / dnd 勿扰 / invisible 隐身')
    return
  }
  const r = await setOnline(sub)
  console.log(r.ok ? '✓ 状态已换：' + r.name : '✗ 换状态失败：' + JSON.stringify(r.resp || r.error).slice(0, 120))
}
