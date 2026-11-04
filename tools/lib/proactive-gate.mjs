// 主动发言统一闸门（10-31）—— 三条主动通道（搭话 / 分享 / 小报告）共用一张账。
//
// 为什么需要：截图实锤她一小时内连发 6 条主动消息，其中 4 条是在**填空式接自己的话**
// （"哈哈被问到点子上"→"图一乐"）。三条通道各有节流但互不相认，叠加起来就变成刷屏。
//
// 规则（都可配）：
//   ① 全局最小间隔      qq.proactive.globalGapMin  默认 45 分钟
//   ② 全局每日上限      qq.proactive.globalDailyMax 默认 8 条
//   ③ 连续主动上限      qq.proactive.maxStreak     默认 2 条（用户没说话就最多连发 2 条）
//   ④ 用户刚说过话      qq.proactive.ownerActiveMin 默认 3 分钟（他正在聊，别插）
//
// ── 2026-11-02 补丁：改走 atomic ────────────────────────────────────────────
// 这里原来是裸 fs.writeFileSync。这张闸门账是三条主动通道**唯一**的共用节流依据，
// 而它们分属不同进程（qq-server / share-queue / tattle）—— 后写的会把先写的增量
// 整个覆盖掉，闸门失效，于是又变回刷屏。同 atomic.mjs 注释里那个实测：
// 20 进程并发自增丢 28.8%。
//
// 为什么之前门禁没抓到：check.mjs 的 checkAtomicWrites 按「文件名字面量 / 变量名」
// 匹配源码行，而这里的路径是 GATE() 现算出来的，裸写那行只有变量 f。
// **门禁全绿不等于覆盖完全** —— 这是本轮审查发现的，已同步把门禁规则升级（见 check.mjs）。
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'
import { updateJson, readJsonSafe } from './atomic.mjs'
import { swallow } from './swallow.mjs'

const GATE = () => dataPath('qq-proactive-gate.json')
const EMPTY = () => ({ day: '', sent: 0, lastAt: 0, streak: 0, ownerLastAt: 0 })

function read() {
  const j = readJsonSafe(GATE(), null)
  if (!j || typeof j !== 'object' || Array.isArray(j)) return EMPTY()
  return { ...EMPTY(), ...j }
}

/**
 * 跨进程安全的「读-改-写」。
 *
 * 拿不到锁就**这次不写** —— 宁可少发一条主动消息，也不能多发。这条取舍是有意的：
 * 主动消息超发的代价（刷屏、被用户当成 bug）远大于少发的代价。
 *
 * @param {(cur: object) => object | undefined} mutate
 * @returns {{ok: boolean, value?: object, error?: string}}
 */
function save(mutate) {
  const r = updateJson(GATE(), (cur) => {
    const base = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? { ...EMPTY(), ...cur } : EMPTY()
    return mutate(base)
  }, { fallback: null, waitMs: 3000, mode: 0o600 })
  if (!r || !r.ok) {
    try { swallow(new Error('proactive-gate 未写入：' + ((r && r.error) || 'unknown')), 'proactive-gate:save') } catch { /* 闸门写不进去不该挡业务 */ }
  }
  return r || { ok: false, error: 'no-result' }
}

/** 记一次"用户说话了"（重置连续计数）。 */
export function noteOwnerSpoke(at = Date.now()) {
  save((st) => { st.ownerLastAt = at; st.streak = 0; return st })
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
    return { ok: false, why: '已连发 ' + st.streak + ' 条且用户没说话（上限 ' + maxStreak + '）' }
  }
  if (st.ownerLastAt && now - st.ownerLastAt < ownerActiveMin * 60_000) {
    return { ok: false, why: '用户 ' + ownerActiveMin + ' 分钟内刚说过话，别插' }
  }
  return { ok: true, why: '' }
}

/** 记一次"真的发出去了"。 */
export function commit(kind = 'proactive') {
  const day = new Date().toLocaleDateString('sv-SE')
  save((st) => {
    if (st.day !== day) { st.day = day; st.sent = 0; st.streak = 0 }
    st.sent = Number(st.sent || 0) + 1
    st.streak = Number(st.streak || 0) + 1
    st.lastAt = Date.now()
    st.lastKind = String(kind)
    return st
  })
}

/** 给面板/diagnose 看的快照。 */
export function snapshot() {
  const st = read()
  return { ...st, dayTag: st.day }
}
