// brain 巩固 · LLM 供血测试（2026-11-04）
//
// 这一套专测一个**曾经整段静默失效**的路径：巩固里的 LLM 抽取。
//
// 事故形状（实测于生产容器）：
//   · `extractLLM()` 同步调用 async 的 `chatFn` → `String(Promise)` = "[object Promise]"
//   · 正则抠不到 JSON 数组 → 恒返回 []，且不抛错、不告警
//   · `run()` 本身是同步的，所以调用方 `runConsolidation({chatFn})` 也看不出异常
//   · 结果：done.jsonl 记了 40 条"已巩固"，sem/facts.json 是空的
//
// 这几条断言的作用不是"跑通 happy path"，是**让这个失败模式不可能再静默发生**：
//   ① chatFn 被真的 await（而不是被 String 掉）
//   ② 抽出来的事实真的进了 facts
//   ③ chatFn 抛错时整次巩固仍然成功（供血断了不能把巩固拖死）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-cons-llm-'))
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

const event = await import('../tools/brain/event.mjs')
const episode = await import('../tools/brain/episode.mjs')
const facts = await import('../tools/brain/facts.mjs')
const consolidate = await import('../tools/brain/consolidate.mjs')

const now = Date.now()
// 故意用**规则抽不到**的句子（不含"我吃了/我在/我要"这些正则锚点），
// 逼着它必须走 LLM 那条路。如果规则能抽到，这套测试就测不到目标 bug。
const lines = [
  '最近老想着那家店的汤底，比上次那家浓很多',
  '周末大概会去城南那个旧书店转转，听说里面有个阁楼',
]
for (const [i, text] of lines.entries()) {
  event.emit({ proc: 'c', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text, isOwner: true, msgId: `l-${i}` })
}
episode.ingest({ limit: 50 })
ok('情景进去了', episode.allEpisodes().length >= 2, `ep=${episode.allEpisodes().length}`)

// 规则阶段应该一条都抽不到（否则这条测试测的是规则，不是 LLM）
const rulesOnly = await consolidate.run({ now, limit: 100, dryRun: true })
ok('规则阶段抽不出（确保走 LLM）', rulesOnly.facts.added === 0, JSON.stringify(rulesOnly.facts))

// ① 正常的 async chatFn：必须被 await，否则拿不到 JSON
let called = 0
const chatFn = async () => {
  called++
  return '[{"p":"food.like","o":"城南那家汤底浓的店"},{"p":"place.visit","o":"城南旧书店阁楼"}]'
}
const r = await consolidate.run({ now: now + 1000, limit: 100, chatFn })

ok('chatFn 被调用了', called > 0, `called=${called} ×`)
ok('llmCalls 记账准确', r.llmCalls === called, `llmCalls=${r.llmCalls} / called=${called}`)
ok('LLM 抽出的事实进了库', r.facts.added + r.facts.merged >= 2, JSON.stringify(r.facts))
const stored = facts.all().map((f) => f.o)
ok('事实内容是 LLM 给的（不是规则的）', stored.some((o) => o.includes('汤底')), JSON.stringify(stored))

// ② 同步返回字符串的 chatFn 也要能工作（老调用方/测试替身）
//    这是 `await` 相对 `.then()` 的唯一实质优势：两种形状都收。
event.emit({ proc: 'c', platform: 'qq', chatId: 'qq:2', userId: '1', role: 'user', text: '南边那家面馆的辣子好像换了配方', isOwner: true, msgId: 'l-9' })
episode.ingest({ limit: 20 })
const r2 = await consolidate.run({
  now: now + 2000, limit: 100,
  chatFn: () => '[{"p":"food.like","o":"南边面馆的辣子"}]',
})
ok('同步 chatFn 也收', r2.facts.added + r2.facts.merged >= 1, JSON.stringify(r2.facts))

// ③ chatFn 抛错：巩固本体必须仍然成功（供血断了不能把记忆整理拖死）
event.emit({ proc: 'c', platform: 'qq', chatId: 'qq:3', userId: '1', role: 'user', text: '这两天天气怪得很', isOwner: true, msgId: 'l-10' })
episode.ingest({ limit: 20 })
const r3 = await consolidate.run({
  now: now + 3000, limit: 100,
  chatFn: async () => { throw new Error('gateway 502') },
})
ok('LLM 挂了也不让巩固失败', r3.ok === true, JSON.stringify({ ok: r3.ok, processed: r3.processed }))
ok('LLM 挂了仍然把 ep 标记成已处理', r3.processed >= 1, `processed=${r3.processed}`)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)
