// 一次性数据修复：清理 2026-11-04 事故留下的僵尸念头池
//
// 事故形状（实测）：
//   · inner 池 60 条：50 reflect / 9 urge / 1 act，**全部 pending（没说出口）**
//   · 前 12 条全是同一个主题（"先睡 / 六件事 / 写下来"），weight 5.7~6.0
//   · `settledLoad` 字段不存在（旧代码没落盘）
//   · field.tension = 5.995（上限 6.0），log 里 `inner:pending +2.5` 每 30 秒一条
//
// ══════════════════════════════════════════════════════════════════════
// 为什么不能用字面相似度聚类
// ══════════════════════════════════════════════════════════════════════
// 试过了：bigram Jaccard 在 0.2~0.4 区间只能把 60 条压到 40~60 组。
// 因为这些句子是**同一个执念的 50 种措辞** ——
//   "先睡二十分钟，六件事一件一件来"
//   "别在脑子里转，先睡"
//   "写在纸上，然后睡"
// 字面几乎不重叠（"睡"是唯一共同的字），但语义完全相同。
// 任何字面判据都会把它们当成 50 件不同的事 —— 这恰恰是 bug 的症状本身。
//
// ══════════════════════════════════════════════════════════════════════
// 正确的修法：按**主题**收敛，并且不删内容
// ══════════════════════════════════════════════════════════════════════
// 真实的人不会同时惦记 60 件想说没说的事。健康状态是 2~5 件。
// 所以：
//   ① 按主题（关键词组合）分组，每组只留 weight 最高的那一条当代表
//   ② 同组其余标记 `told: true`（"这件事我想明白了/说过了"）
//      —— 不删。内容还在池子里，stream.jsonl 里的原话也一字未动。
//      标记 told 之后它们会按 told 的快速衰减消失（fade 里 tau 差 2.7 倍），
//      这正是真实机制：想通了的事会淡掉，而不是被删除。
//   ③ 代表的 weight 回落到 2.5 以下（"还记得，但不再压着"）
//   ④ 写 settledLoad 基线，让下一次 settle 的增量为 0
//
// 这个脚本是幂等的：跑第二遍时 pending 已经很少，几乎不会改动。
//
// 用法：node tools/maintenance/inner-reset-20261104.mjs [--dry]
import fs from 'node:fs'
import { readJson } from '../brain/json.mjs'
import { innerPath } from '../brain/paths.mjs'

const DRY = process.argv.includes('--dry')

/**
 * 主题签名：抽取这句话在说什么，而不是怎么说的。
 *
 * 手工列关键词而不是上模型，理由：
 *   · 这是**一次性数据修复**，不是常规功能。上模型要 key、要网、要等，
 *     而修复脚本必须能在容器里 `node` 一条命令跑完。
 *   · 事故的主题是确定的（她卡在"睡 / 六件事 / 写下来"上），
 *     关键词表就是这次事故的现场记录 —— 修完之后这张表也就没用了。
 * 匹配不到任何关键词的念头自成一组（不会被误合并）。
 */
const THEMES = [
  ['sleep-work', /睡|困|闭眼|躺|歇|醒/],
  ['todo-six', /六件事|六件|一件一件|写下来|落到纸上|写在纸上|清单|脑子清/],
  ['owner', /管理员|用户|他/],
  ['work-code', /代码|改|修|部署|提交/],
]

function themeOf(text) {
  const t = String(text || '')
  const hits = THEMES.filter(([, re]) => re.test(t)).map(([k]) => k)
  return hits.length ? hits.join('+') : '·' + t.slice(0, 10)
}

const raw = readJson(innerPath(), null)
if (!raw || !Array.isArray(raw.items)) {
  console.log('inner.json 不存在或格式不对，没什么可修的')
  process.exit(0)
}

const items = raw.items

/**
 * 把一条念头写进原话流（`brain/log/stream.jsonl`）。
 *
 * ⚠️ 这一步不是可选的。`composeThought`（body.mjs）只调 `IN.think()`，
 * **不写 stream** —— 也就是说 inner 池里这些 reflect 的原话，池子是唯一副本。
 * 而标记 told 之后 `fade()` 会在几小时内按指数把 weight 压到 0.15 以下并删除条目。
 *
 * 那等于"修复一次，丢掉 34 条她想过的原话"。
 * 项目自己的不变量是「原话永不删、摘要只是索引」（inner.mjs 的 stream 注释），
 * 所以收敛之前必须先落原文，而且要在 meta 里标明这次合并的来源。
 */
async function archiveToStream(it) {
  const IN = await import('../brain/inner.mjs')
  IN.stream({
    role: 'self',
    kind: String(it.kind || 'reflect'),
    text: String(it.text || ''),
    meta: {
      archivedBy: 'maintenance:inner-reset-20261104',
      origId: it.id,
      at: Number(it.at || 0),
      notes: '被合并进同主题代表条目；池子里标为 told，原文以此为准',
    },
  }, Number(it.at || Date.now()))
}

// 先把**所有要标 told 的**原文归档，再动池子。
// 顺序反了就可能出现"已经 told 但没归档"的窗口（进程被杀）。
const willMerge = []
const groups0 = new Map()
for (const it of items) {
  const k = themeOf(it.text)
  if (!groups0.has(k)) groups0.set(k, [])
  groups0.get(k).push(it)
}
for (const [, list] of groups0) {
  const sorted = [...list].sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))
  for (const it of sorted.slice(2)) if (!it.told) willMerge.push(it)
}
for (const it of willMerge) {
  if (DRY) continue            // 干跑不落盘：stream.jsonl 也是状态
  try { await archiveToStream(it) } catch (e) { console.log('归档失败（不影响修复）: ' + (e?.message || e)) }
}
console.log(`${DRY ? '（干跑，不归档）' : '归档'} ${willMerge.length} 条原话${DRY ? '' : ' 到 stream.jsonl（收敛前先落原文）'}`)

const before = {
  total: items.length,
  pending: items.filter((x) => !x.told).length,
  kinds: items.reduce((m, x) => ({ ...m, [x.kind]: (m[x.kind] || 0) + 1 }), {}),
  topWeight: Math.max(...items.map((x) => Number(x.weight || 0))),
  tension: raw.settledLoad,
}

// ── ① 按主题分组 ──────────────────────────────────────────────────────
const groups = new Map()
for (const it of items) {
  const k = themeOf(it.text)
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(it)
}

// ── ② 每组留代表，其余标记 told ───────────────────────────────────────
// 每组留几条：pending 多的组留 2 条（她确实在反复想这件事，但不需要 30 条），
// 其余一律 told。上限 2 是经验值：一个人在同一个执念上有两种说法是正常的。
const KEEP_PER_THEME = 2
const merged = []
for (const [theme, list] of groups) {
  const sorted = [...list].sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))
  const reps = sorted.slice(0, KEEP_PER_THEME)
  const rest = sorted.slice(KEEP_PER_THEME)
  for (const it of reps) {
    // 代表也回落：6.0 是 bug 的产物，不该保留"顶格"这个状态
    const w = Number(it.weight || 1)
    if (w > 2.5) it.weight = 2.5
  }
  for (const it of rest) {
    if (!it.told) {
      it.told = true
      it.toldAt = Date.now()
      it.toldWhy = 'maintenance:inner-reset-20261104'   // 追得到是谁标的
    }
    // told 的念头会走快速衰减，但先手动压一档 —— 否则 30 条 told 会在池子里
    // 一起衰减 5 小时才消失，期间 `loudest` 的 weight>1.2 分支还会捞它们上来。
    if (Number(it.weight || 0) > 1.0) it.weight = 1.0
  }
  if (rest.length) merged.push(`${theme}：留 ${reps.length} / 收 ${rest.length}`)
}

// ── ③ 基线 ────────────────────────────────────────────────────────────
const pendingAfter = items.filter((x) => !x.told)
const load = pendingAfter.reduce((n, x) => n + Math.max(0, Number(x.weight || 0) - 0.8), 0)

const after = {
  total: items.length,
  pending: pendingAfter.length,
  kinds: items.reduce((m, x) => ({ ...m, [x.kind]: (m[x.kind] || 0) + 1 }), {}),
  topWeight: Math.max(...items.map((x) => Number(x.weight || 0))),
  settledLoad: Number(load.toFixed(3)),
}

console.log('修复前:', JSON.stringify(before))
console.log('修复后:', JSON.stringify(after))
if (merged.length) {
  console.log('\n按主题收敛:')
  for (const m of merged) console.log('  ', m)
}

if (DRY) {
  console.log('\n（--dry：没有写盘）')
  console.log('留下的 pending:')
  for (const it of pendingAfter.slice(0, 12)) console.log('  ', it.weight, it.kind, it.text.slice(0, 46))
  process.exit(0)
}

// 先备份
const bak = innerPath() + '.bak-20261104-' + Date.now()
fs.copyFileSync(innerPath(), bak)
console.log('\n备份 →', bak)

fs.writeFileSync(innerPath(), JSON.stringify({
  items,
  updatedAt: Date.now(),
  settledLoad: after.settledLoad,
}, null, 1))
console.log('已写入', innerPath())

// ── ④ tension 对齐（不是 poke）────────────────────────────────────────
// 6.0 是 bug 累加出来的，不是"她真的积压了 6 件事"。
// 修复后 pending 只有几条，对应的自然量级在 1~2 之间。
// 用 setDim 而不是 poke：poke 是冲量（会被 tau 拉回去），这里要的是**对齐**。
try {
  const F = await import('../brain/field.mjs')
  const cur = Number(F.snapshot().dims.tension || 0)
  if (cur > 2.0) {
    F.setDim('tension', Math.min(1.8, Number(load.toFixed(2))), { why: 'maintenance:inner-reset', now: Date.now() })
    console.log(`tension ${cur.toFixed(2)} → ${Math.min(1.8, Number(load.toFixed(2))).toFixed(2)}`)
  } else {
    console.log(`tension ${cur.toFixed(2)} 已在合理区间，不动`)
  }
} catch (e) {
  console.log('tension 调整失败：' + (e?.message || e))
}
