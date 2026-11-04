// llm 直连记账单测（P0-5，2026-11-04）
//
// 要防的事故：`llm-usage.jsonl` 里 cache 恒为 0，而真值命中率 94%。
//
// 两个独立的错叠在一起：
//   ① 取值错：从 `cached_tokens` 开始取，而 a2a 网关只有
//      `prompt_cache_hit_tokens` 是真值（`cached_tokens` 恒 0）。
//   ② 口径错（修 ① 才暴露）：LLM 的 `prompt_tokens` = 命中 + 未命中，
//      而账本口径是 `total = input + output + cache`（ledger.mjs 与
//      ledger_usage.py:8 都这么写）。若把 prompt_tokens 原样塞进 input、
//      再把命中量塞进 cache，命中那部分会被**算两遍**。
//
// 断言的重点不是"cache 有值"，是**三者互不重叠**：
//   input + cache 必须等于上游的 prompt 总量（不多不少）。
// 这一条锁住，任何一侧改口径都会立刻红。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-llmusage-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const { recordDirectUsage, readDirectUsage } = await import(pathToFileURL(path.join(APP, 'tools/lib/llm.mjs')).href)
const LEDGER = path.join(tmp, 'llm-usage.jsonl')
const rows = () => fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

// ① a2a 网关真实形态：命中 + 未命中都在，且给 miss 字段
recordDirectUsage({
  prompt_tokens: 3255, prompt_cache_hit_tokens: 3072, prompt_cache_miss_tokens: 183,
  completion_tokens: 20, cached_tokens: 0,
})
const a = rows()[0]
ok('命中量记进 cache，不是 0', a.cache === 3072, `cache=${a.cache}`)
ok('input 只记未命中部分', a.input === 183, `input=${a.input}`)
ok('input + cache 等于上游 prompt 总量（不重不漏）', a.input + a.cache === 3255, `${a.input}+${a.cache}=${a.input + a.cache}`)

// ② 网关不给 miss 字段 → 用 prompt − hit 拆
recordDirectUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 800, completion_tokens: 5 })
const b = rows()[1]
ok('缺 miss 字段时仍能正确拆分', b.input === 200 && b.cache === 800, `input=${b.input} cache=${b.cache}`)

// ③ 老通道形态（完全没有 cache 字段）→ 全算 input，不能凭空造 cache
recordDirectUsage({ prompt_tokens: 500, completion_tokens: 30 })
const c = rows()[2]
ok('无 cache 字段的通道：全算 input', c.input === 500 && c.cache === 0, JSON.stringify(c))

// ④ 只有 cached_tokens 的通道（另一家网关）→ 也要认，且同样拆分
recordDirectUsage({ prompt_tokens: 1000, cached_tokens: 800, completion_tokens: 10 })
const d = rows()[3]
ok('cached_tokens 通道也拆分', d.input === 200 && d.cache === 800, JSON.stringify(d))

// ⑤ 上游自相矛盾（hit > prompt）→ cache 不得盖过总输入
recordDirectUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 9999, completion_tokens: 1 })
const e = rows()[4]
ok('hit 超过 prompt 时被钳住', e.cache <= 100, `cache=${e.cache}`)

// ⑥ 聚合口径：每行都满足 total = input + output + cache（账本铁律）
const agg = readDirectUsage()
const sum = agg.days.reduce((n, x) => n + x.input + x.output + x.cache, 0)
const rawTotal = rows().reduce((n, r) => n + r.input + r.output + r.cache, 0)
ok('聚合的 total 与逐行相加一致', agg.days.every((x) => x.total === x.input + x.output + x.cache), JSON.stringify(agg.days[0]))
ok('聚合不漏行', sum === rawTotal, `${sum} vs ${rawTotal}`)

// ⑦ 空 usage / 垃圾输入不写行、不抛
const before = rows().length
recordDirectUsage(null)
recordDirectUsage({})
recordDirectUsage({ prompt_tokens: 0, completion_tokens: 0 })
ok('空 usage 不写账、不抛', rows().length === before, `${before} → ${rows().length}`)

// ⑧ 零输出但有输入也要记（只调 max_tokens=1 的探针就是这种）
recordDirectUsage({ prompt_tokens: 30, completion_tokens: 0 })
ok('有输入零输出也入账', rows().length === before + 1)

console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ llm 直连记账全绿')
process.exit(bad ? 1 : 0)
