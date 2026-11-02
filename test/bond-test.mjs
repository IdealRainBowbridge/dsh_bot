// bond 回归测试（2026-11-03）—— 钉「关系器官」的生理规则。
// 隔离同 roster-test。钉的是**形状**（对照设计注释的五层）：
//   化学  ①主人不入册 ②warm 慢慢涨 oxy ③insult 快顶 cort、严重时 oxy 打折
//   生物  ④惰性衰减向基线回归（回拨 lastAt 模拟时间流逝）
//   神经  ⑤习惯化：同 kind 连击增益递减 ⑥不应期：负面后 30 分钟 oxy 不涨
//   精神  ⑦信任不对称：疤越深负面增益越大；疤不消
//   哲学  ⑧feel/feelLine 第一人称、永不漏数字；bio 才是医学口
//   慢相  ⑨observe 攒批 → consolidate 精判结算 → pend 清空
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bond-test-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.BOT_CONFIG = path.join(TMP, '.dsh', 'bot.config.json')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({ owner: { qq: '111', name: '笨蛋老爸' } }))

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}
const NOW = Date.now()
const H = 3600_000

const B = await import('../tools/lib/bond.mjs')

// ① 主人不入册
ok('主人 taste 不产生记录', B.taste({ platform: 'qq', userId: '111', text: '谢谢宝贝' }) === 0)
ok('主人 bio 无档案', B.bio('qq', '111').leaning === '陌生')

// ② warm 慢涨
B.taste({ platform: 'qq', userId: 'a1', text: '谢谢你帮我看', now: NOW })
const b1 = B.bio('qq', 'a1')
ok('一次感谢 oxy 微涨（≤0.05）', b1.oxy > 0.10 && b1.oxy <= 0.16, `oxy=${b1.oxy}`)
ok('一次感谢 cort 不动', b1.cort <= 0.03)

// ③ insult 快顶 cort
B.taste({ platform: 'qq', userId: 'a2', text: '你就是个废物，滚', now: NOW })
const b2 = B.bio('qq', 'a2')
ok('辱骂 cort 快涨', b2.cort >= 0.20, `cort=${b2.cort}`)
ok('辱骂 oxy 归零打折', b2.oxy < 0.10, `oxy=${b2.oxy}`)

// ⑦ 信任不对称：一次严重负面就直冲高位留疤；第二次疤加深（恐惧条件化）
const b2first = B.bio('qq', 'a2')
ok('一次辱骂即直冲高位', b2first.cort >= 0.6 && b2first.scar >= 1, `cort=${b2first.cort} scar=${b2first.scar}`)
B.taste({ platform: 'qq', userId: 'a2', text: '傻逼', now: NOW + 3600_000 })
const b2b = B.bio('qq', 'a2', NOW + 3600_000)
ok('再犯疤加深', b2b.scar === 2 && b2b.cort >= b2first.cort, `scar=${b2b.scar} cort=${b2b.cort}`)
ok('疤只进不出（过了两小时还在）', B.bio('qq', 'a2', NOW + 2 * H).scar >= 1)

// ⑤ 习惯化：连说三次一样的谢谢，第三次涨得比第一次少
B.taste({ platform: 'qq', userId: 'a3', text: '谢谢', now: NOW })
const s1 = B.bio('qq', 'a3').oxy
B.taste({ platform: 'qq', userId: 'a3', text: '谢谢', now: NOW + 60_000 })
B.taste({ platform: 'qq', userId: 'a3', text: '谢谢', now: NOW + 120_000 })
const s3 = B.bio('qq', 'a3').oxy
ok('习惯化：边际递减', (s3 - s1) < 0.04 * 2, `首步增量≈${(s1 - 0.10).toFixed(3)} 三步总增量=${(s3 - 0.10).toFixed(3)}`)

// ⑥ 不应期：负面后 30 分钟内的亲近接不住
B.taste({ platform: 'qq', userId: 'a4', text: '闭嘴', now: NOW })
const r0 = B.bio('qq', 'a4').oxy
B.taste({ platform: 'qq', userId: 'a4', text: '抱抱你 最喜欢你了', now: NOW + 10 * 60_000 })
const r1 = B.bio('qq', 'a4').oxy
ok('不应期内 oxy 不涨', Math.abs(r1 - r0) < 1e-9, `前=${r0} 后=${r1}`)
B.taste({ platform: 'qq', userId: 'a4', text: '抱抱你', now: NOW + 45 * 60_000 })
ok('不应期过了又接得住', B.bio('qq', 'a4', NOW + 45 * 60_000).oxy > r0)

// ④ 惰性衰减：把 lastAt 拨回三天前，oxy 向基线回落
B.taste({ platform: 'qq', userId: 'a5', text: '谢谢你 辛苦了 厉害', now: NOW - 72 * H })
const d0 = B.bio('qq', 'a5', NOW - 72 * H).oxy
const d3 = B.bio('qq', 'a5', NOW).oxy
ok('三天不见淡了但还在', d3 < d0 && d3 > 0.10, `当时=${d0.toFixed(3)} 现在=${d3.toFixed(3)}`)

// ⑧ 呈现层哲学：第一人称、无数字
const fl = B.feelLine('qq', 'a2')
ok('戒备语是第一人称', fl.includes('防备') || fl.includes('留个心眼'), fl.slice(0, 40))
ok('呈现层永不漏数字', !/\d\.\d/.test(fl), fl.slice(0, 60))
const flClose = (() => { for (let i = 0; i < 30; i++) B.taste({ platform: 'qq', userId: 'a6', text: `谢谢你 今天帮我大忙了 真厉害`, now: NOW + i * 90_000 }); return B.feelLine('qq', 'a6', NOW + 30 * 90_000) })()
ok('亲近到位有「聊得来」级感受语', flClose.includes('聊得来') || flClose.includes('舒服') || flClose.includes('挺喜欢'), flClose.slice(0, 50))

// ⑨ 慢相：攒批 → LLM 精判 → 结算
B.observe({ platform: 'qq', userId: 'a7', text: '今天聊得真开心 你讲的梗好好笑', now: NOW })
B.observe({ platform: 'qq', userId: 'a7', text: '下次再一起玩', now: NOW + 60_000 })
const fakeChat = async () => JSON.stringify({ valence: 2, kind: 'warm', why: '整体愉快' })
const done = await B.consolidate('qq:a7', { chat: fakeChat, now: NOW + 120_000 })
ok('慢相结算成功', done === true)
const c1 = B.bio('qq', 'a7')
ok('慢相步幅大于快相（整段的味道）', c1.oxy >= 0.10 + 0.06 * 0.9, `oxy=${c1.oxy}`)
ok('结算后 pend 清空', B.bio('qq', 'a7').pend === 0)
ok('dueForRem：不满批不到点不出队', B.dueForRem({ now: NOW }).length === 0)

// remTick 端到端（fake chat）
B.observe({ platform: 'qq', userId: 'a8', text: '你们真烦', now: NOW - 4 * H })
const n = await B.remTick({ chat: async () => JSON.stringify({ valence: -2, kind: 'insult', why: '攻击性' }), now: NOW })
ok('remTick 结算到期者', n >= 1)
ok('慢相负面同样顶 cort', B.bio('qq', 'a8').cort >= 0.2, `cort=${B.bio('qq', 'a8').cort}`)

// stats 形状
const st = B.stats()
ok('stats 形状', ['people', 'close', 'wary', 'scarred'].every((k) => k in st) && st.people >= 7)

console.log(bad ? `\n✗ ${bad} 处失败` : '\n✅ bond 全绿')
process.exit(bad ? 1 : 0)
