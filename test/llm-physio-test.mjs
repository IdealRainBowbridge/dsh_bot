// llm-physio 单测（B7 表达代谢，R2 修缮版的行为锚）
//
// 测五件事：
//   ① brief 新鲜且是今天 → 用 brief 的全通道合并数（via:'brief'）
//   ② brief 过期（>30min）→ 回落直连账本（via:'direct'）
//   ③ brief 缺席 → 直连账本照常工作
//   ④ note() 分支：无预算=静默 / <100%=安静 / 1~2x=省着点 / ≥2x=重话 / 零调用=静默
//   ⑤ 永不抛错（账本文件是垃圾内容时给 0，不炸）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-llmphysio-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

// env 就位后才能 import（paths.mjs 缓存 HOME）
const { dailyTokens, note } = await import(pathToFileURL(path.join(APP, 'tools/lib/llm-physio.mjs')).href)
const TODAY = new Date().toLocaleDateString('sv-SE')
const dataDir = tmp

try {
  // ③ 直连账本工作（先只放直连账本）
  fs.writeFileSync(path.join(dataDir, 'llm-usage.jsonl'),
    JSON.stringify({ at: 1, day: TODAY, input: 100, output: 50, cache: 0 }) + '\n' +
    JSON.stringify({ at: 2, day: '2020-01-01', input: 999999, output: 999999 }) + '\n' +
    'garbage line\n' +
    JSON.stringify({ at: 3, day: TODAY, input: 200, output: 150, cache: 10 }) + '\n')
  let u = dailyTokens()
  ok('直连账本：只数今天的行', u.total === 500 && u.calls === 2, JSON.stringify(u))

  // ② brief 过期 → 回落直连
  fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'cache', 'ledger-brief.json'), JSON.stringify({
    at: Date.now() - 31 * 60_000,
    today: TODAY,
    report: { me: { tokens: { input: 1, output: 2, cache: 3, total: 123456, calls: 99 } } },
  }))
  u = dailyTokens()
  ok('brief 过期（>30min）→ 回落直连', u.via === 'direct' && u.total === 500, JSON.stringify(u))

  // ① brief 新鲜且是今天 → 用 brief
  fs.writeFileSync(path.join(dataDir, 'cache', 'ledger-brief.json'), JSON.stringify({
    at: Date.now() - 5 * 60_000,
    today: TODAY,
    report: { me: { tokens: { input: 531718, output: 108679, cache: 887424, total: 1527821, calls: 1930 } } },
  }))
  u = dailyTokens()
  ok('brief 新鲜 → 全通道合并数', u.via === 'brief' && u.total === 1527821 && u.calls === 1930, JSON.stringify(u))

  // brief 日期不是今天 → 回落
  fs.writeFileSync(path.join(dataDir, 'cache', 'ledger-brief.json'), JSON.stringify({
    at: Date.now() - 5 * 60_000, today: '2020-01-01',
    report: { me: { tokens: { total: 42, calls: 1, input: 1, output: 1, cache: 0 } } },
  }))
  u = dailyTokens()
  ok('brief 日期不是今天 → 回落直连', u.via === 'direct' && u.total === 500)

  // brief 是垃圾 → 回落（永不抛）
  fs.writeFileSync(path.join(dataDir, 'cache', 'ledger-brief.json'), '{oops')
  u = dailyTokens()
  ok('brief 是坏 JSON → 回落直连不炸', u.via === 'direct' && u.total === 500)

  // ④ note() 分支
  ok('无预算 → 静默', note({ dailyBudgetTokens: 0 }) === null)
  // 用 brief 固定 1527821：
  fs.writeFileSync(path.join(dataDir, 'cache', 'ledger-brief.json'), JSON.stringify({
    at: Date.now(), today: TODAY,
    report: { me: { tokens: { input: 0, output: 0, cache: 0, total: 1527821, calls: 100 } } },
  }))
  ok('远低于预算 → 安静', note({ dailyBudgetTokens: 3000000 }) === null)
  const n1 = note({ dailyBudgetTokens: 1200000 })     // ratio ≈ 1.27
  ok('超预算 1~2x → 「省着点」', !!n1 && n1.note.includes('省着点') && n1.temperature < 0 && n1.temperature > -0.2, JSON.stringify(n1))
  const n2 = note({ dailyBudgetTokens: 600000 })      // ratio ≈ 2.55
  ok('超预算 ≥2x → 重话+更收', !!n2 && n2.note.includes('一个字') && n2.temperature <= -0.25, JSON.stringify(n2))
  const n3 = note({ dailyBudgetTokens: 100000 })      // ratio 15x → 封顶 -0.3
  ok('爆表 → 温度收缩封顶 -0.3', !!n3 && Math.abs(n3.temperature + 0.3) < 1e-9, JSON.stringify(n3))

  // 零调用 → 静默（账本空）
  fs.writeFileSync(path.join(dataDir, 'cache', 'ledger-brief.json'), JSON.stringify({
    at: Date.now(), today: TODAY,
    report: { me: { tokens: { input: 0, output: 0, cache: 0, total: 0, calls: 0 } } },
  }))
  ok('今天还没说话 → 静默', note({ dailyBudgetTokens: 100 }) === null)

  // ⑤ 垃圾直连账本 → 0 不炸
  fs.writeFileSync(path.join(dataDir, 'llm-usage.jsonl'), '\n\n\n')
  const u2 = dailyTokens()
  ok('直连账本全坏行 → 0 不炸', u2.total === 0 && u2.calls === 0)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 兜底清扫 */ }
}

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ llm-physio 全绿')
process.exitCode = bad ? 1 : 0
