// 主动发言统一闸门（10-31）—— 三条主动通道（搭话 / 分享 / 小报告）共用一张账。
//
// 为什么需要：截图实锤她一小时内连发 6 条主动消息，其中 4 条是在**填空式接自己的话**
// （"哈哈被问到点子上"→"图一乐"）。三条通道各有节流但互不相认，叠加起来就变成刷屏。
//
// 规则（都可配）：
//   ① 全局最小间隔      qq.proactive.globalGapMin  默认 45 分钟
//   ② 全局每日上限      qq.proactive.globalDailyMax 默认 8 条
//   ③ 连续主动上限      qq.proactive.maxStreak     默认 2 条（主人没说话就最多连发 2 条）
//   ④ 主人刚说过话      qq.proactive.ownerActiveMin 默认 3 分钟（他正在聊，别插）
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'

const GATE = () => dataPath('qq-proactive-gate.json')

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(GATE(), 'utf8'))
    return { day: '', sent: 0, lastAt: 0, streak: 0, ownerLastAt: 0, ...j }
  } catch { return { day: '', sent: 0, lastAt: 0, streak: 0, ownerLastAt: 0 } }
}
function write(o) {
  try {
    const f = GATE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(o, null, 1))
  } catch { /* 闸门写不进去不该挡业务 */ }
}

/** 记一次"主人说话了"（重置连续计数）。 */
export function noteOwnerSpoke(at = Date.now()) {
  const st = read()
  st.ownerLastAt = at
  st.streak = 0
  write(st)
}

/**
 * 能不能发一条主动消息。
 * @param {string} kind 通道名（proactive / share / tattle），只用于日志
 * @returns {{ok:boolean, why:string}}
 */
export function allow(kind = 'proactive') {
  const cfg = config()
  const p = cfg.qq?.proactive ?? {}
  const day = new Date().toLocaleDateString('sv-SE')
  const st = read()
  if (st.day !== day) { st.day = day; st.sent = 0; st.streak = 0 }
  const gapMin = Number(p.globalGapMin ?? 45)
  const dailyMax = Number(p.globalDailyMax ?? 8)
  const maxStreak = Number(p.maxStreak ?? 2)
  const ownerActiveMin = Number(p.ownerActiveMin ?? 3)
  const now = Date.now()

  if (st.sent >= dailyMax) return { ok: false, why: '今日主动消息已到上限 ' + dailyMax + ' 条' }
  if (st.lastAt && now - st.lastAt < gapMin * 60_000) {
    return { ok: false, why: '距上次主动消息不足 ' + gapMin + ' 分钟' }
  }
  if (st.streak >= maxStreak) {
    return { ok: false, why: '已连发 ' + st.streak + ' 条且主人没说话（上限 ' + maxStreak + '）' }
  }
  if (st.ownerLastAt && now - st.ownerLastAt < ownerActiveMin * 60_000) {
    return { ok: false, why: '主人 ' + ownerActiveMin + ' 分钟内刚说过话，别插' }
  }
  return { ok: true, why: '' }
}

/** 记一次"真的发出去了"。 */
export function commit(kind = 'proactive') {
  const st = read()
  const day = new Date().toLocaleDateString('sv-SE')
  if (st.day !== day) { st.day = day; st.sent = 0; st.streak = 0 }
  st.sent = Number(st.sent || 0) + 1
  st.streak = Number(st.streak || 0) + 1
  st.lastAt = Date.now()
  st.lastKind = String(kind)
  write(st)
}

/** 给面板/diagnose 看的快照。 */
export function snapshot() {
  const st = read()
  return { ...st, dayTag: st.day }
}
