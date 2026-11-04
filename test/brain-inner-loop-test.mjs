// brain/inner · 念头→压力回路测试（2026-11-04）
//
// 要防的事故（实测于生产容器）：
//   · field.tension = 5.999994（上限 6.0）
//   · field.log 里 `inner:pending +2.5` 每 30 秒一条，从 07:15 刷到 15:42
//   · inner 池 60 条、51 条 reflect、前 8 条 weight 全顶 6.00，主题同一
//
// 两个根因，各测一组：
//   ① `settle()` 是累加器被当成冲量用（每拍推同样大小的 +2.5，tau 6h 追不上）
//   ② `think()` 的重复检测线性 +0.8，5 次顶格；而调用方是 30 秒一拍的心跳
//
// 断言的重点不是"tension 变小"，是**它必须有稳态**：
// 同一批念头压着不动时，压力必须停止增长（增量=0），否则任何修复都只是调小常数。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-inner-loop-'))
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

const IN = await import('../tools/brain/inner.mjs')
const F = await import('../tools/brain/field.mjs')

const MIN = 60_000
const now = Date.now()

/* ── ① settle 的增量语义：同一批念头不再每拍注压 ──────────────────── */
IN.think('先把这六件事写下来', { kind: 'reflect', about: 'self', now })
IN.think('写完再去睡一会儿', { kind: 'reflect', about: 'self', now })

const t0 = Number(F.snapshot().dims.tension || 0)
const s1 = IN.settle(now)
ok('第一次 settle 施加压力', Number(F.snapshot().dims.tension || 0) >= t0, `t0=${t0} → ${F.snapshot().dims.tension}`)
ok('settle 报出增量', s1.delta > 0, JSON.stringify(s1))

// 关键：再连续 settle 20 次（模拟 10 分钟的心跳），压力**不能**继续涨
const t1 = Number(F.snapshot().dims.tension || 0)
for (let i = 1; i <= 20; i++) IN.settle(now + i * 30_000)
const t2 = Number(F.snapshot().dims.tension || 0)
ok('同一批念头连续 settle 20 拍不再注压', Math.abs(t2 - t1) < 0.05, `${t1} → ${t2}`)
ok('压力没有顶到上限 6.0', t2 < 5.9, `tension=${t2}`)

/* ── ② 真的新增念头时，压力还是推得动 ────────────────────────────── */
const t3 = Number(F.snapshot().dims.tension || 0)
IN.think('还有一件事一直没跟他说', { kind: 'worry', about: 'owner', now: now + 700_000 })
const s2 = IN.settle(now + 800_000)
const t4 = Number(F.snapshot().dims.tension || 0)
ok('新念头会推动压力', s2.delta > 0 && t4 > t3, `delta=${s2.delta} ${t3} → ${t4}`)
ok('单次注压有上限（不会一次推爆）', t4 - t3 <= 1.5, `Δ=${(t4 - t3).toFixed(2)}`)

/* ── ③ think 的重复累加必须饱和 ─────────────────────────────────── */
const t = '这件事我得想清楚到底怎么办才好'
const first = IN.think(t, { kind: 'reflect', now })
const w1 = IN.loudest(10, now).find((x) => x.text === first.items[first.items.length - 1].text)?.weight
ok('第一次记一个念头 weight ≈ 1', Math.abs(Number(w1) - 1) < 0.01, `weight=${w1}`)

// 模拟心跳：同一件事被反复"想到" 30 次
for (let i = 1; i <= 30; i++) IN.think(t, { kind: 'reflect', now: now + i * 30_000 })
const dup = IN.loudest(20, now + 40 * 30_000).find((x) => x.text.startsWith('这件事我得想清楚'))
ok('30 次重复后仍不超过 6.0 上限', Number(dup.weight) <= 6.0001, `weight=${dup.weight}`)
// 关键断言：饱和之后增量必须趋近于 0（线性累加会在第 7 次就锁死在 6.0，
// 然后永远是最响的那条 —— 这正是"她只会念同一段咒"的机制）
const wAfter30 = Number(dup.weight)
IN.think(t, { kind: 'reflect', now: now + 41 * 30_000 })
const wAfter31 = Number(IN.loudest(20, now + 45 * 30_000).find((x) => x.text.startsWith('这件事我得想清楚')).weight)
ok('饱和后单次增量 < 0.02（不会立刻顶格）', wAfter31 - wAfter30 < 0.02, `${wAfter30} → ${wAfter31}`)
ok('重复次数单独记账（hits）', Number(dup.hits) >= 30, `hits=${dup.hits}`)

/* ── ④ innerBlock 取用即变淡（回路下半截）────────────────────────── */
const beforeUse = Number(IN.loudest(1, now + 50 * 30_000)[0].weight)
IN.innerBlock(1, now + 50 * 30_000)
const afterUse = Number(IN.loudest(1, now + 50 * 30_000)[0].weight)
ok('innerBlock 之后 weight 下降', afterUse < beforeUse, `${beforeUse} → ${afterUse}`)
ok('取用衰减不是清零（还在池子里）', afterUse > 0.19, `weight=${afterUse}`)

/* ── ⑤ 用来之后，同一批念头不会永远霸占最响的位置 ─────────────────── */
// 连读 12 次（模拟 12 轮对话），weight 应该从 6.0 一路降到不再垄断
for (let i = 0; i < 12; i++) IN.innerBlock(3, now + (60 + i) * 60_000)
const topAfter = IN.loudest(3, now + 80 * 60_000)
const stillMax = topAfter.filter((x) => Number(x.weight) >= 5.99).length
ok('反复取用后没有念头还挂在 6.0', stillMax === 0, `仍顶格 ${stillMax} 条`)

/* ── ⑥ settledLoad 必须落盘（否则下次 settle 又从 0 算起）─────────── */
const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'brain', 'meta', 'inner.json'), 'utf8'))
ok('inner.json 存了 settledLoad', Number.isFinite(Number(raw.settledLoad)), `settledLoad=${raw.settledLoad}`)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)
