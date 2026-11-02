// shard-test —— 记忆分片：本月超量封顶 + part2 能读回
//
// 背景：rotateNow 只把"不是本月"的行搬走。她这个月自己写 >6MB 时，
// 主文件会永远停在 6MB 以上，而且每次 rotateIfBig 都白跑一遍（读全量→没东西搬→重写）。
// 修：本月行也按 MONTH_KEEP=4000 封顶，超出的进 episodes-YYYY-MM-part2.jsonl。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-'))
process.env.BOT_DATA_DIR = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.HOME = TMP
process.env.USERPROFILE = TMP

let bad = 0
const ok = (c, l) => { console.log((c ? '  ✓ ' : '  ✗ ') + l); if (!c) bad++ }

const M = await import('../tools/lib/memory.mjs')
const now = Date.now()

// ── ① shardsOf 必须认出 part2 ────────────────────────────────────────────
const EP = path.join(TMP, 'episodes.jsonl')
fs.writeFileSync(EP, JSON.stringify({ ts: now, platform: 'qq', chatId: 'qq:1', role: 'user', text: '主文件' }) + '\n')
fs.writeFileSync(
  path.join(TMP, 'episodes-2026-11-part2.jsonl'),
  JSON.stringify({ ts: now - 3600000, platform: 'qq', chatId: 'qq:1', role: 'user', text: 'part2 里的旧话' }) + '\n',
)
const shards = M.shardsOf(EP)
ok(shards.some((s) => s.includes('part2')), 'shardsOf 认出 part2 分片')

// ── ② part2 的内容必须能被该会话读回（这是"搬过去等于丢了"的防线）───────
const recent = M.recent('qq:1', 10)
ok(recent.some((r) => String(r.content || '').includes('part2')), 'part2 的记录能被 recent() 读回')

// ── ③ 别的会话读不到 part2 里不属于它的东西（不串台）─────────────────────
const other = M.recent('qq:999', 10)
ok(!other.some((r) => String(r.content || '').includes('part2')), '别的会话读不到别人的 part2')

fs.rmSync(TMP, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ shard-test 全部通过')
process.exit(bad ? 1 : 0)
