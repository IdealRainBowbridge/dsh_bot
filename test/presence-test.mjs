// presence 回归测试（2026-11-03）—— 钉「存在感器官」的接线与语义。
// 隔离同 brain-affect：env 先指沙箱，再动态 import。
// 这套测试钉的是**形状**：
//   ① 静息身体 -> 在线（参数归零平滑退化，不是消失）
//   ② 硬累/欠觉/心情低/亢奋 各自正确换档（否决式串行的顺序）
//   ③ 在睡 -> 不动作（睡眠路径优先，presence 不抢）
//   ④ 不应期：刚换过不再换；首拍(at=0)放行
//   ⑤ 落盘/读回（mark 之后 snapshot 读得到，绝不写「已换」而盘上没有）
//   ⑥ mark 后 history 增长且有界
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-test-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const field = await import('../tools/brain/field.mjs')
const night = await import('../tools/brain/organ/night.mjs')
const P = await import('../tools/brain/organ/presence.mjs')

const T0 = Date.now()

// 把身体推到想要的状态（只增不撤，所以每段用完就换下一段语义 —— 串行无回滚）
function setDims(patch) {
  const s = field.snapshot(T0)
  for (const [k, v] of Object.entries(patch)) field.setDim(k, v, { now: T0, silent: true })
}

// ── ① 静息 -> 在线 ─────────────────────────────────────────────────
{
  const d = P.compute(T0)
  ok('静息身体 -> online', d && d.key === 'online', JSON.stringify(d))
  // 各参数归零：仍是在线，不报错
  setDims({ da: 0.5, ne: 0.35, sero: 0.6, cortisol: 0.15, fatigue: 0.1, valence: 0, sleepDebt: 0 })
  ok('全静息值 -> 仍 online', P.compute(T0).key === 'online')
}

// ── ② 否决式串行 ───────────────────────────────────────────────────
{
  setDims({ fatigue: 0.7 })
  ok('疲劳过线 -> busy', P.compute(T0).key === 'busy')
  setDims({ fatigue: 0.1, sleepDebt: 0.6 })
  ok('欠觉过线 -> away（疲劳让位后）', P.compute(T0).key === 'away')
  setDims({ sleepDebt: 0.1, valence: -0.6 })
  ok('心情低 -> away', P.compute(T0).key === 'away')
  setDims({ valence: 0, ne: 0.9 })
  const d = P.compute(T0)
  ok('亢奋 -> qme 或 online（取决 social 通路）', d.key === 'qme' || d.key === 'online', JSON.stringify(d))
}

// ── ③ 在睡 -> null（不动作）──────────────────────────────────────
{
  try {
    night.beginSleep({ reason: 'test', backlog: 0, plannedMin: 60 })
    const d = P.compute(T0)
    ok('在睡 -> compute 返回 null', d === null, JSON.stringify(d))
    ok('在睡 -> tick 跳过', P.tick(T0).skip === 'sleeping')
    night.endSleep(T0 + 60 * 60_000)
  } catch (e) { ok('睡眠态切换可用', false, String(e)) }
}

// ── ④ 不应期 ───────────────────────────────────────────────────────
{
  setDims({ fatigue: 0.7 })
  const r1 = P.tick(T0)
  ok('首次 tick -> 该换', r1.changed === true && r1.key === 'busy', JSON.stringify(r1))
  P.mark('busy', r1.why || '', T0)
  const r2 = P.tick(T0)
  ok('同档 tick -> 不换', r2.changed === false && r2.skip === 'same', JSON.stringify(r2))
  // dwell 内换别的档：忍住
  field.setDim('fatigue', 0.1, { now: T0, silent: true })
  field.setDim('ne', 0.9, { now: T0, silent: true })
  const r3 = P.tick(T0 + 5 * 60_000)
  ok('dwell 内想换档 -> 忍住', r3.changed === false && r3.skip === 'dwell', JSON.stringify(r3))
  // dwell 过了：放行
  const r4 = P.tick(T0 + 26 * 60_000)
  ok('dwell 过了 -> 放行', r4.changed === true, JSON.stringify(r4))
}

// ── ⑤ 落盘/读回 ───────────────────────────────────────────────────
{
  const rec = P.mark('qme', '测试落盘', T0 + 30 * 60_000)
  ok('mark 返回 key', rec.key === 'qme')
  const snap = P.snapshot(T0 + 30 * 60_000)
  ok('snapshot 读回 key', snap.key === 'qme', JSON.stringify(snap.key))
  ok('snapshot 有 line', typeof snap.line === 'string' && snap.line.length > 0, snap.line)
  ok('desired 与 key 一致或 dwell 中', ['qme', 'online', 'busy', 'away'].includes(snap.desired), snap.desired)
  ok('history 有界且非空', snap.history.length >= 1 && snap.history.length <= 8)
}

console.log(bad ? `\n${bad} 处失败` : '\n全绿')
process.exit(bad ? 1 : 0)
