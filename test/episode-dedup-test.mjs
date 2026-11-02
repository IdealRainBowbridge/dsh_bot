// episode-dedup-test —— 跨写者双写不能被记两条 episode（2026-11-02）
//
// 背景：qq-server 既调 memory.remember()（brain-bridge 发一条**无 msgId** 的事件），
// 又调 brain.onEvent()（发一条**有 msgId** 的）。两条内容一模一样、同一毫秒。
// 实测 127 条 episode 里 4 条是这么来的，diagnose 的"记忆卫生"把它报成重复。
//
// 这个测试锁两件事：
//   ① 30 秒内的同平台同文本 → 只留一条（吃掉双写）
//   ② 隔 40 秒的同文本 → 两条都保留（真实经历，不是脏数据）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'epdedup-'))
process.env.BOT_DATA_DIR = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.HOME = TMP
process.env.USERPROFILE = TMP

let failed = 0
const ok = (cond, label) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label)
  if (!cond) failed++
}

const ev = await import('../tools/brain/event.mjs')
const ep = await import('../tools/brain/episode.mjs')

// ── 用例 1：双写（无 msgId + 有 msgId，同一秒）→ 只留一条 ──────────────────
const text1 = '双写测试：同一句话被两个写者各写一次。'
ev.emit({ proc: 'memory-bridge', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: text1, isOwner: true })
const r1 = ep.ingest({ limit: 50 })
ok(r1.ingested === 1, '写者A（bridge，无 msgId）落 1 条')

ev.emit({ proc: 'qq-server', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: text1, isOwner: true, msgId: 'MSG-A' })
const r2 = ep.ingest({ limit: 50 })
ok(r2.ingested === 0 && r2.skipped === 1, '写者B（qq-server，有 msgId）被吃掉，不重复落盘')

// ── 用例 2：隔 40 秒又说一遍 → 两条都保留 ────────────────────────────────
const text2 = '隔离测试：隔了一会儿又说了一遍一样的话。'
ev.emit({ proc: 'qq-server', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: text2, isOwner: true, msgId: 'MSG-B1' })
ep.ingest({ limit: 50 })

// 把刚落的那条往前挪 40 秒（模拟时间流逝）
const dir = path.join(TMP, 'brain', 'ep')
const f = fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))[0]
const p = path.join(dir, f)
const lines = fs.readFileSync(p, 'utf8').trim().split('\n')
const rows = lines.map((l) => JSON.parse(l))
const target = rows.find((x) => String(x.quote || '').includes(text2))
ok(Boolean(target), '找到刚写的第二条')
if (target) {
  target.at = target.at - 40_000
  fs.writeFileSync(p, rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
}

ev.emit({ proc: 'qq-server', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: text2, isOwner: true, msgId: 'MSG-B2' })
const r3 = ep.ingest({ limit: 50 })
ok(r3.ingested === 1, '隔 40 秒的同文本**保留**（真实经历，不该被当脏数据）')

// ── 总量校验 ────────────────────────────────────────────────────────────
const all = ep.allEpisodes()
ok(all.length === 3, `episode 总数 = 3（期望 3，实际 ${all.length}）`)

fs.rmSync(TMP, { recursive: true, force: true })
if (failed) {
  console.log(`\n✗ episode-dedup-test 有 ${failed} 项失败`)
  process.exit(1)
}
console.log('\n✓ episode-dedup-test 全部通过')
