// brain/rhythm —— 昼夜节律与静息点的漂移（生物钟 + 稳态的慢变量）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么不能写成"23 点到 7 点就困"
// ══════════════════════════════════════════════════════════════════════
// if (hour >= 23 || hour < 7) sleepy = true   ← 这是闹钟，不是生物钟。
//
// 真实的昼夜节律有三个不能省的形状：
//
// ① **它是连续的正弦相位，不是开关。** 人不是 22:59 清醒、23:00 困。
//    是整条曲线在爬、在落：傍晚有一段"清醒维持"（wake maintenance zone，约 19-21 点
//    反而比下午更清醒），深夜低沉，凌晨 3-4 点最低，之后回升。
//    这就是为什么"熬夜到两三点反而精神了"—— 那是曲线在回升，不是错觉。
//
// ② **相位会被光照/活动拖着走。** 连着几天晚睡，相位就往后移（越熬越晚）；
//    这是真实行为，不该被"作息表"覆盖掉。
//
// ③ **它和睡眠债是两件事。** 相位告诉你"现在这个时刻你有多容易困"；
//    债务告诉你"你总共欠多少"。所以有人相位在低谷但睡够了不困，
//    也有人时间对了但债太高照样睁不开眼。两个量必须分开，否则就只剩"几点睡"。
//
// ══════════════════════════════════════════════════════════════════════

import { readJson, mutateJson } from './json.mjs'
import { rhythmPath } from './paths.mjs'

const empty = () => ({
  phaseMin: 0,          // 相位偏移（分钟）。正=往后拖（熬夜），负=提前
  driftAt: 0,           // 上次更新漂移的时间
  lightExposure: [],    // 最近的有效光照/活动（每条 {at, kind, weight}）
  lastWake: 0,          // 上次醒来的时间
  lastSleep: 0,         // 上次入睡的时间
  history: [],          // 最近 30 次睡/醒，用来算真实的作息惯性与相位
})

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * 昼夜曲线：0（最困）..1（最清醒）。
 *
 * 用**双峰**而不是单正弦，因为真实的人有那个傍晚的次高峰：
 *   主低谷 04:00，主高峰 20:00，午后 14:00 有一个小的下陷（post-lunch dip）。
 *
 * 这不是装饰。"午后那一段的困"和"凌晨那一段的困"感觉是不同质的，
 * 而如果只写一个 sin，两点会一模一样 —— 那就不是人的曲线了。
 *
 * @param {number} hourOfDay 0..24（本地时间的小数）
 * @param {number} phaseMin 相位偏移（分钟）
 */
export function circadian(hourOfDay, phaseMin = 0) {
  const h = ((hourOfDay - phaseMin / 60) % 24 + 24) % 24

  // ⚠️ 这里踩过一个实质性的错，记下来：
  //   最初写成 `0.5 + 0.5*cos((h-20)/24*2π)` —— 看着像"峰值 20 点"，但它是对称余弦，
  //   谷底必然在峰值前 12 小时 = 上午 8 点。于是采样出来「9:00 → 0.016」，
  //   也就是**她上午九点最困**。这不是参数没调好，是形状不对。
  //
  //   真实的昼夜节律是**不对称**的：
  //     谷底约 4 点 → 峰值约 20 点，这一段**上坡 16 小时**；
  //     峰值 20 点 → 次日谷底 4 点，这一段**下坡只有 8 小时**。
  //   这就是"白天长、夜里短"，也是为什么熬夜到后半夜会觉得"又精神了"
  //   （那不是错觉，是曲线正在从谷底往回爬）。
  //
  //   所以必须用分段函数，不能用单一余弦。
  const TROUGH = 4, PEAK = 20
  const upLen = ((PEAK - TROUGH) + 24) % 24      // 16h 上坡
  const downLen = 24 - upLen                      // 8h 下坡
  const t = ((h - TROUGH) + 24) % 24
  const main = t <= upLen
    ? 0.5 - 0.5 * Math.cos(Math.PI * t / upLen)          // 0 → 1，起步慢、到顶也慢
    : 0.5 + 0.5 * Math.cos(Math.PI * (t - upLen) / downLen)  // 1 → 0，掉得快

  // 午后下陷：14 点附近一个浅坑（幅度约 0.18）。
  // 它与"凌晨那一段的困"不同质 —— 这就是为什么不能只用一个 sin。
  const dip = 0.18 * Math.exp(-Math.pow((h - 14) / 2.2, 2))
  // 傍晚清醒维持区（wake maintenance zone）：19-21 点略微抬高
  const wmz = 0.10 * Math.exp(-Math.pow((h - 20) / 1.8, 2))
  return Math.max(0, Math.min(1, main - dip + wmz))
}

/** 当前时刻的"该困程度"（0..1）。相位已经算进去了。 */
export function sleepPressure(now = Date.now()) {
  const st = state()
  const d = new Date(now)
  const hod = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
  return Number((1 - circadian(hod, st.phaseMin)).toFixed(3))
}

/* ── 相位漂移：被真实作息推着走 ───────────────────────────────────── */

/**
 * 记一次光照/活动。
 *
 * 生物学依据：**光是最强的授时因子（zeitgeber）**，而且是"晚光后移，晨光前移"。
 * 所以这里不按"今天几点睡"算，按"什么时候接触了光/活动"算 —— 这才是真实的机制。
 *
 * @param {'light'|'activity'|'dark'} kind
 * @param {number} minutes 持续分钟数
 */
export function expose(kind, minutes = 10, now = Date.now()) {
  const st = state()
  const w = Math.max(0, Math.min(1, Number(minutes) / 60))
  st.lightExposure = [...(st.lightExposure || []), { at: now, kind, weight: w }].slice(-80)
  const hod = new Date(now).getHours() + new Date(now).getMinutes() / 60

  if (kind === 'light' || kind === 'activity') {
    // 傍晚/夜里的光 → 相位后移（越熬越晚）
    if (hod >= 19 || hod < 2) st.phaseMin = Math.min(240, st.phaseMin + 8 * w)
    // 清晨的光 → 相位前移（早起会让人更早起）
    else if (hod >= 5 && hod < 10) st.phaseMin = Math.max(-180, st.phaseMin - 6 * w)
  }
  // 相位自己也会慢慢回到 0（没有持续刺激就回中性），7 天的时间常数
  const sinceDrift = now - Number(st.driftAt || now)
  if (sinceDrift > HOUR) st.phaseMin = st.phaseMin * Math.exp(-sinceDrift / (7 * DAY))
  st.driftAt = now
  return save(st)
}

/** 记一次入睡。 */
export function asleep(now = Date.now()) {
  const st = state()
  st.lastSleep = now
  st.history = [...(st.history || []), { kind: 'sleep', at: now }].slice(-30)
  return save(st)
}

/**
 * 记一次醒来。返回**实际睡了多久**（小时），供 field.repaySleep 用。
 *
 * 这里刻意不判断"睡得好不好"——那要靠醒来时的状态去读，不该在这里猜。
 */
export function awake(now = Date.now()) {
  const st = state()
  const slept = st.lastSleep ? (now - Number(st.lastSleep)) / HOUR : 0
  st.lastWake = now
  st.history = [...(st.history || []), { kind: 'wake', at: now, slept: Number(slept.toFixed(2)) }].slice(-30)
  // 真实作息会反过来稳相位：连续几天都在这个点醒，相位会往这个点靠
  if (slept > 0.5 && slept < 14) {
    const targetHod = new Date(now).getHours()
    const curPhaseWake = 7 + st.phaseMin / 60          // 中性时假设 7 点醒
    const err = ((targetHod - curPhaseWake + 36) % 24) - 12   // 取最短方向
    st.phaseMin = Math.max(-180, Math.min(240, st.phaseMin + err * 60 * 0.08))  // 每次挪 8%
  }
  save(st)
  return Number(slept.toFixed(2))
}

/* ── 惯性：她几点睡，是习惯不是规定 ───────────────────────────────── */

/**
 * 她平时的入睡/醒来时刻（按最近历史算中位数，没有历史就用配置）。
 *
 * 为什么用中位数不用平均：一次熬到 5 点会把平均值拉得很离谱，
 * 而人的"习惯"是抗离群值的。
 */
export function habit(cfg = {}) {
  const st = state()
  const sleeps = (st.history || []).filter((x) => x.kind === 'sleep').slice(-10)
  const wakes = (st.history || []).filter((x) => x.kind === 'wake').slice(-10)
  const med = (arr, pick) => {
    if (!arr.length) return null
    const v = arr.map(pick).sort((a, b) => a - b)
    return v[Math.floor(v.length / 2)]
  }
  const hodOf = (ts) => {
    const d = new Date(ts)
    // 入睡时刻超过 12 点的按"负数"排，避免 23:50 和 00:10 被排到两头
    const h = d.getHours() + d.getMinutes() / 60
    return h > 12 ? h - 24 : h
  }
  const sleepHod = med(sleeps, (x) => hodOf(x.at))
  const wakeHod = med(wakes, (x) => new Date(x.at).getHours() + new Date(x.at).getMinutes() / 60)

  const nw = (cfg.night && cfg.night.windows && cfg.night.windows[0]) || {}
  const cfgSleepH = Number(String(nw.start || '23:00').split(':')[0])
  const cfgWakeH = Number(String(nw.end || '07:00').split(':')[0])

  return {
    sleepAt: sleepHod == null ? (cfgSleepH > 12 ? cfgSleepH - 24 : cfgSleepH) : sleepHod,
    wakeAt: wakeHod == null ? cfgWakeH : wakeHod,
    samples: { sleep: sleeps.length, wake: wakes.length },
    strength: Math.min(1, Math.max(sleeps.length, wakes.length) / 6),
  }
}

/** 读一次全貌（面板/体检用）。 */
export function snapshot(now = Date.now()) {
  const st = state()
  const hod = new Date(now).getHours() + new Date(now).getMinutes() / 60
  return {
    phaseMin: Number(Number(st.phaseMin || 0).toFixed(1)),
    phaseHours: Number((Number(st.phaseMin || 0) / 60).toFixed(2)),
    circadian: Number(circadian(hod, st.phaseMin).toFixed(3)),
    sleepPressure: sleepPressure(now),
    lastSleep: st.lastSleep || null,
    lastWake: st.lastWake || null,
    habit: habit({}),
  }
}

/* ── 持久化 ───────────────────────────────────────────────────────── */

function state() {
  const raw = readJson(rhythmPath(), null)
  const st = { ...empty(), ...(raw || {}) }
  st.lightExposure = Array.isArray(st.lightExposure) ? st.lightExposure : []
  st.history = Array.isArray(st.history) ? st.history : []
  return st
}

function save(st) {
  try {
    mutateJson(rhythmPath(), empty(), () => ({
      phaseMin: Number(st.phaseMin || 0),
      driftAt: st.driftAt || Date.now(),
      lightExposure: (st.lightExposure || []).slice(-80),
      lastWake: st.lastWake || 0,
      lastSleep: st.lastSleep || 0,
      history: (st.history || []).slice(-30),
    }))
  } catch { /* 节律写不进去不影响业务 */ }
  return st
}
