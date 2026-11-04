// organ/heartbeat · 执行门测试（2026-11-04）
//
// 要防的事故：`decide()` 在"专心窗口"内返回 `{...prev, kept:true}`，
// 而 `beat()` 无条件 `exec[d.action](d)` —— 于是**同一份决定每 30 秒被重放一次**。
//
// 实测形状：think 的 spanMin 是 17 分钟，心跳 30 秒一拍
//   → 同一个 since 内执行 34 次 → 34 次 LLM 调用去想同一件事
//   日耗 39 万 token，产出是 inner 池里 51 条同题 reflect。
//
// 断言重点：**"同一份决定"只能执行一次，但"两次不同的决定"都要执行**。
// 后者同样重要 —— 她可能连续做两次"整理记忆"（做完一次又想做），
// 那是两次决定（不同 since），都要跑。加门加错就会变成"这件事今天只做一次"。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-heartbeat-gate-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_BRAIN_MIRROR = '0'

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const HB = await import('../tools/brain/organ/heartbeat.mjs')
const self = await import('../tools/brain/organ/self.mjs')

// 先停掉所有可能自动跑的东西：我们只要 beat()，不要 interval
HB.stop()

const now = Date.now()
let calls = 0
const seen = []
// 用 Proxy 兜住**所有**动作名：decide() 实际会挑哪个取决于当时的身体状态
// （初测就挑了 watch，而只注册 rest/sleep 的测试会得到"exec 没这个键"的空跑，
//  看起来像"执行门把执行吃掉了"，实际是测试自己没接）。只关心"执行了几次"。
const exec = new Proxy({}, {
  get(_t, key) {
    if (typeof key !== 'string') return undefined
    if (key === 'pendingInterrupt') return undefined
    if (key === 'interruptUrgency') return undefined
    if (key === 'vitals') return undefined
    return async (d) => { calls++; seen.push({ at: Number(d?.since || 0), action: String(d?.action || key) }) }
  },
  has() { return false },
})
HB.bind(exec)

// 造一个"保留下来的决定"：self-state.json 里 current.until 在未来，
// 这样 decide() 会走 kept 分支（这是事故的真实触发条件）。
const selfStatePath = path.join(tmp, 'brain', 'meta', 'self-state.json')
fs.mkdirSync(path.dirname(selfStatePath), { recursive: true })
const since = now - 1000
fs.writeFileSync(selfStatePath, JSON.stringify({
  at: now,
  current: {
    action: 'rest', since,
    until: now + 15 * 60_000,          // 还有 15 分钟
    why: '想做：歇着（意愿 0.5）', spanMin: 17, lean: '',
  },
  history: [{ at: since, action: 'rest', why: '', spanMin: 17 }],
  decisions: 1,
}))

// ── ① 同一份决定：第一拍执行，之后 6 拍都不许再执行 ────────────────
const out1 = await HB.beat(now)
ok('第一拍确实走了 kept 分支', out1.kept === true, JSON.stringify({ action: out1.action, kept: out1.kept }))
ok('第一拍执行了一次', calls === 1, `calls=${calls}`)

for (let i = 1; i <= 6; i++) await HB.beat(now + i * 30_000)
ok('之后 6 拍都不再重复执行同一份决定', calls === 1, `calls=${calls}（期望 1）`)
ok('跳过的拍数有记账', seen.length === 1, `executed=${seen.length}`)

// ── ② 换了决定（不同 since）：必须执行 ─────────────────────────────
const st2 = JSON.parse(fs.readFileSync(selfStatePath, 'utf8'))
st2.current.since = now + 60_000
st2.current.until = now + 30 * 60_000
fs.writeFileSync(selfStatePath, JSON.stringify(st2))
await HB.beat(now + 7 * 30_000)
ok('不同 since 的决定会执行（不误杀）', calls === 2, `calls=${calls}（期望 2）`)

// ── ③ 非 kept 的新决定：每次都要执行 ───────────────────────────────
// 清掉 current 的 until（过期）→ decide() 会重新决策并返回 kept:false
const st3 = JSON.parse(fs.readFileSync(selfStatePath, 'utf8'))
st3.current.until = 0
fs.writeFileSync(selfStatePath, JSON.stringify(st3))
const before3 = calls
await HB.beat(now + 8 * 30_000)
ok('过期决定会重新决策', calls > before3, `calls ${before3} → ${calls}`)

// 再跑几拍：每拍都可能是新的 kept（不同 since），也可能是非 kept。
// 唯一不能发生的是：**同一个 since 被执行两次**。
const counts = new Map()
for (let i = 9; i < 20; i++) await HB.beat(now + i * 30_000)
for (const row of seen) counts.set(row.at, (counts.get(row.at) || 0) + 1)
const dupKeys = [...counts.entries()].filter(([, n]) => n > 1)
ok('任何 since 都没被执行超过一次', dupKeys.length === 0, JSON.stringify(dupKeys))
ok('这段时间里确实执行过（不是空跑的空断言）', seen.length >= 3, `executed=${seen.length}`)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)
