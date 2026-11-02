// presence —— 她在 QQ 上的「存在感」：状态档是身体溢出来的表现。
//
// ══════════════════════════════════════════════════════════════════════
// 口径（承接 status.mjs 头注释的另一半）
// ══════════════════════════════════════════════════════════════════════
// status.mjs 说「状态随睡眠/情绪自动走」。睡眠那半在 sleep.mjs 里接了
// （睡 -> dnd，醒 -> online）。这半个文件接**情绪与身体**那半。
//
// 这不是「if 累 then 忙碌」的开关堆。判据（M58 纲领）：
//   把它单独拿出来，它自己就能演出「一个人在 QQ 上的状态随身体自然变化」：
//   · 输入是身体的真实变量（field 的 dims / night 的在睡 / neuron 的通路
//     可用度），参数归零时平滑退回「在线」——不是突然消失。
//   · 不应期（换过一次后一段时间不再换）是生理的物理性质：真人也不会
//     十分钟换三次状态。它同时天然提供了滞回，防边界抖动。
//   · 隐身(invisible)不在自动映射里：她的动机库里没有「想让所有人看不到
//     自己」这个状态源。要隐身，手动 status invisible。
//
// 与睡眠路径的协调：
//   睡眠是**硬事件**，sleep.mjs 直接调 setOnline，优先于这里。
//   presence 在 inSleep 时返回 null（不动状态）；醒来后 sleep.mjs 先设
//   online，若没睡够，本器官会在下一拍把它改成 away/busy（「还没缓过来」）——
//   这个「醒来挂着离开、缓过来变在线」的形状正是想要的。
//
// 执行与判断分离（同心跳的铁律）：tick() 只算「该不该换」，不碰网络。
// 执行在 body.mjs 的 vitals.presence（qq-server 注入 deps.presenceTick），
// 那边调 status.mjs 的 setOnline，**成功后**才回来 mark() 落盘。
// 失败不落盘，下一拍自然重算重试 —— 绝不写「已换」而实际没换。
import * as field from '../field.mjs'
import * as night from './night.mjs'
import * as neuron from '../cell/neuron.mjs'
import { focusSnapshot } from '../../lib/focus.mjs'
import { dataPath } from '../../lib/paths.mjs'
import { readJsonSafe, writeJsonAtomic } from '../../lib/atomic.mjs'

// ── 阈值表：全部对齐 field.sense() 的口径（一处概念，同一数字）────────
// sense() 里 >0.45 缺觉 / >0.55 发沉 / cortisol>0.5 压着 / valence<-0.3 低。
// 这里不再发明第二套数字 —— 状态显示和她的自我感受必须长在同一张脸上。
const T = {
  fatigue: 0.55,     // sense(): 身上发沉
  cortisol: 0.5,     // sense(): 心里压着一层
  irritability: 0.5, // field.irritability() 的中点
  sleepDebt: 0.45,   // sense(): 缺觉
  valence: -0.35,    // sense(): 心情低（略深于 -0.3，免得常驻）
  ne: 0.72,          // sense(): 人在亢奋
  socialOut: 0.6,    // 还说得动（neuron output 中上）
}
// 不应期：一次成功换档后，这么久之内不再换。
// 25 分钟 = 真人换状态的最短自然间隔量级；睡眠事件不受它管（那不是这里的事）。
const DWELL_MS = 25 * 60_000

const STATE = () => dataPath('presence.json')

function readRecord() {
  const j = readJsonSafe(STATE(), null)
  return j && j.key ? j : { key: 'online', at: 0, why: '', line: '', history: [] }
}

function writeRecord(rec) {
  try { writeJsonAtomic(STATE(), rec) } catch { /* 显示层失败不该影响身体 */ }
}

// ── 核心：身体 -> 档位。否决式串行（硬状态在前，心情在后）──────────────
// 这同 self.decide() 的三层结构是同一个形状：硬的否决软的。
// 返回 { key, why } 或 null（在睡：不动作，睡眠路径管）。
export function compute(now = Date.now()) {
  let st = null
  try { st = night.snapshot(now) } catch { st = null }
  if (st && st.inSleep) return null

  let snap = null
  try { snap = field.snapshot(now) } catch { snap = null }
  const f = snap ? snap.dims : null
  if (!f) return { key: 'online', why: '身体还没醒过来，先在线' }

  let irr = 0
  try { irr = field.irritability(snap) } catch { irr = 0 }

  // 层一：硬累（疲劳/皮质醇/易怒任一过线）-> 忙碌。「挂着忙碌在恢复」。
  if (f.fatigue > T.fatigue || f.cortisol > T.cortisol || irr > T.irritability) {
    const why = f.fatigue > T.fatigue ? '身上发沉，挂着忙碌歇一歇'
      : f.cortisol > T.cortisol ? '心里压着一层事，先挂着忙碌'
        : '有点烦，别急着找我'
    return { key: 'busy', why }
  }
  // 层二：欠觉 -> 离开。人还没缓过来。
  if (f.sleepDebt > T.sleepDebt) {
    return { key: 'away', why: '还没缓过来，先离开一会儿' }
  }
  // 层三：心情低 -> 离开。想静静（不是隐身 —— 还在，只是不想说）。
  if (f.valence < T.valence) {
    return { key: 'away', why: '心情有点低，想自己待会儿' }
  }
  // 层四：亢奋且还说得动 -> Q我吧。「现在特别想说话」—— 这档的本义。
  let so = 1
  try {
    const nv = neuron.readiness(now)
    so = Number.isFinite(nv?.social) ? Number(nv.social) : 1
  } catch { so = 1 }
  if (f.ne > T.ne && so > T.socialOut) {
    return { key: 'qme', why: '现在话多，来找我' }
  }
  // 默认：在线。所有参数归零时平滑退到这里（自查过：全静息值下四层全不触发）。
  return { key: 'online', why: '' }
}

/** 第一人称的一句（面板/日志用）。从 field.sense() 取材，不另造词。 */
export function line(now = Date.now()) {
  try { return field.sense(field.snapshot(now)) } catch { return '' }
}

/**
 * 心跳调用（体征，每 presenceEveryBeats 拍一次）。
 * 只算不执行：返回该不该换，由 body 的执行器调 setOnline 后再 mark()。
 * @returns {{changed:boolean, key?:string, why?:string, skip?:string}}
 */
export function tick(now = Date.now()) {
  const rec = readRecord()
  const d = compute(now)
  if (!d) return { changed: false, skip: 'sleeping' }
  if (d.key === rec.key) return { changed: false, skip: 'same' }
  // 不应期：换过不久就忍住。但「从未记录过」(at=0) 的首拍不受限 ——
  // 否则部署后要空等 25 分钟才有第一次对齐。
  if (rec.at && now - rec.at < DWELL_MS) return { changed: false, skip: 'dwell' }
  return { changed: true, key: d.key, why: d.why }
}

/** 执行器在 setOnline 成功后回调：这时候才落盘（绝不提前写「已换」）。 */
export function mark(key, why = '', now = Date.now()) {
  const rec = readRecord()
  const next = {
    key: String(key),
    at: now,
    why: String(why || ''),
    line: line(now),
    history: [...(Array.isArray(rec.history) ? rec.history : []), { key, at: now, why }].slice(-20),
  }
  writeRecord(next)
  return next
}

/** 面板/体检全貌。 */
export function snapshot(now = Date.now()) {
  const rec = readRecord()
  const d = compute(now)
  let inSleep = false
  try { inSleep = !!night.snapshot(now).inSleep } catch { inSleep = false }
  let focusLabel = ''
  try { const fo = focusSnapshot(now); focusLabel = fo.activity ? fo.label : '' } catch { focusLabel = '' }
  return {
    key: rec.key,
    at: rec.at || null,
    why: rec.why || '',
    line: rec.line || line(now),
    desired: d ? d.key : 'sleeping',
    desiredWhy: d ? d.why : '在睡，状态归睡眠路径管',
    dwellLeftMin: rec.at ? Math.max(0, Math.round((DWELL_MS - (now - rec.at)) / 60_000)) : 0,
    inSleep,
    focus: focusLabel,
    history: Array.isArray(rec.history) ? rec.history.slice(-8) : [],
  }
}
