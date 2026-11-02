// webpush 回归测试（2026-11-03）—— 钉「webui 主动说话」的闸门与由头。
// 隔离同 roster-test。钉的是**形状**：
//   ① 开关没开 → 一律不动
//   ② force 能出兜底「就是想说话」，且不预生成正文（正文她会话里自己写）
//   ③ dailyMax 次数闸：发满即停
//   ④ 由头优先级与去重：promise > watch > diary；说过一次不再重发
//   ⑤ TTL：过了 6 小时的由头不作数
// 用例顺序即真实时序：promise → diary → watch（watch 行造出来后 3 小时内一直新鲜，会盖住日记）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webpush-test-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.BOT_CONFIG = path.join(TMP, '.dsh', 'bot.config.json')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({
  owner: { qq: '111', name: '笨蛋老爸' },
  webui: { proactive: { enabled: true, dailyMax: 2, minGapMin: 0, quietHours: 8 } },
}))

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const WP = await import('../tools/lib/webpush.mjs')
const CFG = JSON.parse(fs.readFileSync(process.env.BOT_CONFIG, 'utf8'))
const NOW = Date.now()
const wakeFile = path.join(TMP, 'webui-wake.json')

/** 重置当日配额（day/used 不动 —— 台账跨用例累计，这正是去重要依赖的）。 */
const resetQuota = () => {
  const st = fs.existsSync(wakeFile) ? JSON.parse(fs.readFileSync(wakeFile, 'utf8')) : {}
  fs.writeFileSync(wakeFile, JSON.stringify({ ...st, fired: 0, lastAt: 0, queue: [] }))
}

// ① 开关
const CFG_OFF = { ...CFG, webui: { proactive: { enabled: false } } }
ok('开关没开不动', WP.planProactive({ cfg: CFG_OFF, force: true }).ok === false)

// ② force 兜底：只出指令，不产出正文
const a = WP.planProactive({ cfg: CFG, force: true })
ok('force 出兜底', a.ok === true && a.kind === '日常')
ok('指令带【主动说话】标头', a.ok && a.instruction.includes('【主动说话】'))
ok('指令是给她看的任务，不是替她说的话', a.ok && !JSON.stringify(a).includes('"text"'))

// ③ dailyMax=2：发满即停
WP.markFired({ kind: '日常', motiveId: a.motiveId, line: '第一条' })
const b = WP.planProactive({ cfg: CFG, force: true })
ok('第二次仍可（2 上限内）', b.ok === true)
WP.markFired({ kind: '日常', motiveId: b.motiveId, line: '第二条' })
ok('发满 2 条后停', WP.planProactive({ cfg: CFG, force: true }).ok === false)

// ④-1 promise 由头（最高优先）
resetQuota()
fs.writeFileSync(path.join(TMP, 'promise-outcome.json'), JSON.stringify({ at: NOW, used: false, ok: true, title: '葬送的芙莉莲', ep: 5, plot: '芙莉莲见到了旧友的影子', feel: '有点想哭' }))
const m1 = WP.planProactive({ cfg: CFG, force: true })
ok('promise 由头优先', m1.ok && m1.kind === '分享' && String(m1.motiveId).startsWith('promise:'))
WP.markFired({ kind: m1.kind, motiveId: m1.motiveId, line: '分享' })
resetQuota()
const m2 = WP.planProactive({ cfg: CFG, force: true })
ok('说过的 promise 不重发', m2.ok && String(m2.motiveId).startsWith('quiet:'))
fs.rmSync(path.join(TMP, 'promise-outcome.json'), { force: true })   // 后面的用例别被 promise 盖住

// ④-2 diary 由头（此刻 watchlog 还不存在，日记才轮得到）
resetQuota()
const _d = new Date(NOW); const _pad = (x) => String(x).padStart(2, '0')
const stamp = `${_d.getFullYear()}-${_pad(_d.getMonth() + 1)}-${_pad(_d.getDate())} ${_pad(_d.getHours())}:${_pad(_d.getMinutes())}:${_pad(_d.getSeconds())}`   // 本地时间，照她真日记的标题口径
fs.mkdirSync(path.join(TMP, '.dsh', 'bot-work'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.dsh', 'bot-work', 'bot-diary-private.md'), `# 她自己的日记\n\n## ${stamp}\n\n今天有点安静，写两句。\n`)
const m4 = WP.planProactive({ cfg: CFG, force: true })
ok('刚写完日记 → 心情由头', m4.ok && m4.kind === '心情', m4.motiveId)
WP.markFired({ kind: m4.kind, motiveId: m4.motiveId, line: '心情' })

// ④-3 watchlog 由头（黑盒：record 真造一条 —— 新鲜且没说过，压过一切兜底）
resetQuota()
const watchlog = await import('../tools/lib/watchlog.mjs')
watchlog.record({ show: '芙莉莲', title: '葬送的芙莉莲', ep: 6, plot: '一集魔法试炼', feel: '这集节奏好', ok: true, at: NOW })
const m3 = WP.planProactive({ cfg: CFG, force: true })
ok('watchlog 由头接上', m3.ok && String(m3.motiveId).startsWith('watch:'), m3.motiveId)
WP.markFired({ kind: m3.kind, motiveId: m3.motiveId, line: '分享' })
resetQuota()
const m3b = WP.planProactive({ cfg: CFG, force: true })
ok('说过的 watch 不重发', m3b.ok && String(m3b.motiveId).startsWith('quiet:'))

// ⑤ TTL：promise 过了 6 小时不作数（watch 行此刻仍新鲜但已用过 → 只能兜底）
fs.writeFileSync(path.join(TMP, 'promise-outcome.json'), JSON.stringify({ at: NOW - 7 * 3600_000, used: false, ok: true, title: '旧事', ep: 1, plot: 'x', feel: 'y' }))
const m5 = WP.planProactive({ cfg: CFG, force: true })
ok('过期由头不作数', m5.ok && !String(m5.motiveId).startsWith('promise:'))

// wakeState 形状
const ws = WP.wakeState()
ok('wakeState 形状完整', ['day', 'fired', 'lastAt', 'lastType', 'lastLine', 'queued'].every((k) => k in ws))

console.log(bad ? `\n✗ ${bad} 处失败` : '\n✅ webpush 全绿')
process.exit(bad ? 1 : 0)
