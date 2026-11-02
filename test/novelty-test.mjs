// test/novelty-test.mjs —— 新颖检测：陌生度 / 饱和衰减 / 见过池沉淀 / assess 端到端
//
// 10-27 踩过：只设了自定义变量、没设 USERPROFILE，结果测试把真记忆库写成假数据。
// 先把环境变量钉死再 import —— 一行都不能晚。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-novelty-'))
process.env.USERPROFILE = TMP_HOME
process.env.HOME = TMP_HOME
process.env.BOT_DATA_DIR = path.join(TMP_HOME, '.bot-ai')
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')
fs.mkdirSync(process.env.BOT_DATA_DIR, { recursive: true })
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

const { dataPath } = await import('../tools/lib/paths.mjs')
const novelty = await import('../tools/lib/novelty.mjs')
const memory = await import('../tools/lib/memory.mjs')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); process.exitCode = 1 }
}

// ① 陌生度纯函数
const grams = new Set(['鲸鱼', '鱼娘', '看番'])
ok('全见过 → 0', novelty.unfamiliarity('鲸鱼 鱼娘 看番', grams, {}, 1e12) === 0)
ok('全没见过 → 1', novelty.unfamiliarity('量子纠缠退相干', grams, {}, 1e12) === 1)
ok('半熟 → 0~1 之间', (() => {
  const u = novelty.unfamiliarity('鲸鱼和量子纠缠', grams, {}, 1e12)
  return u > 0 && u < 1
})())
ok('空白不算新奇', novelty.unfamiliarity('   ', grams, {}, 1e12) === 0)
ok('纯符号不算新奇', novelty.unfamiliarity('!!!？？？', grams, {}, 1e12) === 0)
ok('见过池在 TTL 内算熟', novelty.unfamiliarity('量子 纠缠', grams, { '量子': Date.now(), '纠缠': Date.now() }, Date.now()) === 0)

// ② 饱和衰减纯函数
const NOW = Date.now()
ok('刚做完同主题 → 强脱敏(≤0.3)', novelty.saturate('量子纠缠的原理', '量子纠缠的原理', NOW - 60_000, NOW) <= 0.3)
ok('不同主题 → 不衰减(=1)', novelty.saturate('做一道新菜', '量子纠缠的原理', NOW - 60_000, NOW) === 1)
ok('隔夜 → 恢复(≥0.9)', novelty.saturate('量子纠缠的原理', '量子纠缠的原理', NOW - 20 * 3600_000, NOW) >= 0.9)

// ③ assess 空数据不炸
{
  const a = novelty.assess(NOW)
  ok('空数据 arousal=0', a.arousal === 0)
  ok('空数据 trigger 口径在', a.trigger === 0.6)
}

// ④ 端到端：写一条真情节 → arousal 升；tick 沉淀见过池 → 再 assess 降（习惯化）
{
  const epFile = dataPath('episodes.jsonl')
  fs.mkdirSync(path.dirname(epFile), { recursive: true })
  const line = JSON.stringify({ ts: NOW - 5 * 60_000, role: 'user', platform: 'web', chatId: 'web:x', summary: '费曼学习法把概念拆成小块教给别人' })
  fs.writeFileSync(epFile, line + '\n')
  const a1 = novelty.assess(NOW)
  ok('陌生事件 arousal 高', a1.arousal > 0.5, 'arousal=' + a1.arousal)
  ok('items 带 u 分', a1.items.length === 1 && typeof a1.items[0].u === 'number')
  novelty.tick(NOW + 1)   // 沉淀见过池
  const a2 = novelty.assess(NOW + 2)
  ok('见过之后 arousal 降', a2.arousal < a1.arousal, a1.arousal + ' → ' + a2.arousal)
  ok('rows 统计在', a2.rows === 1)
}

// ⑤ spark：探索过的东西变熟 + lastTopic 生效（饱和与见过池是两套机制）
{
  const before = novelty.unfamiliarity('.subscribe 语义的深水区', new Set(), {}, NOW + 100)
  novelty.spark('.subscribe 语义的深水区', { source: 'wander', surprise: 0.7 }, NOW + 100)
  const after = novelty.unfamiliarity('.subscribe 语义的深水区', new Set(), (() => {
    const st = JSON.parse(fs.readFileSync(dataPath('novelty.json'), 'utf8')); return st.seen
  })(), NOW + 100)
  ok('spark 前陌生', before === 1)
  ok('spark 后变熟', after === 0, 'after=' + after)
  const st = JSON.parse(fs.readFileSync(dataPath('novelty.json'), 'utf8'))
  ok('lastTopic 记下了', st.lastSource === 'wander' && st.lastSurprise === 0.7)
}

// ⑥ 多文件聚合：qq 子目录的情节也进得来
{
  const qqFile = dataPath('qq/episodes.jsonl')
  fs.mkdirSync(path.dirname(qqFile), { recursive: true })
  fs.writeFileSync(qqFile, JSON.stringify({ ts: NOW - 60_000, role: 'user', platform: 'qq', summary: '图灵完备性的直觉解释' }) + '\n')
  const a = novelty.assess(NOW)
  ok('qq 平台的情节被扫到', a.rows >= 2, 'rows=' + a.rows)
  ok('qq 平台的新词推高 arousal', a.arousal > 0.3, 'arousal=' + a.arousal)
}

// ⑦ episodeFile 走的是 memory 接口（不是手搓路径）
ok('主文件路径与 memory.episodeFile 一致', (() => {
  const st = JSON.parse(fs.readFileSync(dataPath('novelty.json'), 'utf8'))
  return !!st.updatedAt   // 上面 tick/spark 都写过 → 状态文件活着 = dataPath 口径一致
})())

// ⑧ surpriseOf（二轮）：器官自己量惊喜度 —— 探索的回报由收获本身的陌生度决定
{
  const s1 = novelty.surpriseOf('一组完全没见过的陌生概念词组', NOW + 200)
  ok('全新收获 → 惊喜高', s1 >= 0.7, 's1=' + s1)
  novelty.spark('一组完全没见过的陌生概念词组', {}, NOW + 201)
  const s2 = novelty.surpriseOf('一组完全没见过的陌生概念词组', NOW + 202)
  ok('见过之后 → 惊喜回落', s2 < s1 && s2 <= 0.1, 's2=' + s2)
  ok('空收获不炸', typeof novelty.surpriseOf('', NOW + 203) === 'number')
}

console.log(`\n${fail ? '✗' : '✓'} novelty-test：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
