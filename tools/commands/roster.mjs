// roster —— 人物名册命令（2026-11-03）：她自己查/记「这是谁」。
//
//   node bot.mjs roster                     # 最近见过的人
//   node bot.mjs roster --who 123456 --call 小鱼干    # 起称呼
//   node bot.mjs roster --who 123456 --note "爱发猫图的那位"   # 记印象
//   node bot.mjs roster --stats
import * as roster from '../lib/roster.mjs'

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? '') : '' }

export function run(argv = []) {
  if (argv.includes('--stats')) { console.log(JSON.stringify(roster.stats())); return }
  const who = arg(argv, '--who')
  const call = arg(argv, '--call')
  const note = arg(argv, '--note')
  if (who && call) {
    const r = roster.rename('qq', who, call)
    if (!r.ok) { console.error('✗ ' + r.why); process.exit(2) }
    console.log(`✓ ${r.fresh ? '已建卡' : '已更新'}：${who} → 叫他「${call}」`)
    return
  }
  if (who && note) {
    const r = roster.note('qq', who, note)
    if (!r.ok) { console.error('✗ ' + r.why); process.exit(2) }
    console.log(`✓ 已记下对 ${who} 的印象：${r.person.notes.slice(-40)}`)
    return
  }
  const rows = roster.list({ limit: 30 })
  if (!rows.length) { console.log('名册还是空的 —— 还没有人跟你打过照面。'); return }
  console.log(`人物名册（${roster.stats().people} 人，最近见的在前）：`)
  for (const p of rows) {
    const call = p.alias || p.name || '（还没名字）'
    const ago = p.lastAt ? Math.max(1, Math.round((Date.now() - Number(p.lastAt)) / 60000)) + ' 分钟前' : ''
    console.log(`  · ${call}（${p.platform} ${p.userId}）· 聊过 ${p.meets} 句 · ${ago}${p.notes ? ' · ' + p.notes.slice(-30) : ''}`)
  }
}
