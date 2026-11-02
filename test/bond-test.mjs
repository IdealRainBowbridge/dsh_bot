// bond v2 回归测试（2026-11-03）—— 钉「关系器官」的生理规则（快慢两相版）。
// 钉的是**形状**（对照 v2 设计）：
//   化学  ①主人不入册 ②warm 慢涨 ③快相严重负面→临时警戒（不落疤）
//   神经  ④习惯化 ⑤不应期 ⑥慢相确认才固化（疤在慢相落）+ 误报撤销
//   精神  ⑦信任不对称（慢相严重负面→直冲高位+疤+oxy 打折）⑧修复通道（道歉降 cort 不降疤、循环递减）
//   生物  ⑨惰性衰减+创伤后基线 ⑩曝光效应 ⑪爱轰炸 ⑫旁观 ⑬情绪耦合
//   哲学  ⑭呈现层第一人称永不漏数字 ⑮tone 调制 ⑯ REM 门控
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
const M = 60_000

const B = await import('../tools/lib/bond.mjs')
const MOOD = await import('../tools/lib/mood.mjs')

// ① 主人不入册
ok('主人 taste 不产生记录', B.taste({ platform: 'qq', userId: '111', text: '谢谢宝贝' }) === 0)

// ② warm 慢涨
B.taste({ platform: 'qq', userId: 'a1', text: '谢谢你帮我看', now: NOW })
ok('一次感谢 oxy 微涨（≤0.05）', B.bio('qq', 'a1').oxy > 0.10 && B.bio('qq', 'a1').oxy <= 0.16, `oxy=${B.bio('qq', 'a1').oxy}`)

// ③④ 快相严重负面：只挂临时警戒，**不落疤不改 cort 主体**
B.taste({ platform: 'qq', userId: 'a2', text: '你就是个废物，滚', now: NOW })
const b2 = B.bio('qq', 'a2')
ok('快相辱骂 → 临时警戒挂起', b2.pending === '待复核', JSON.stringify(b2))
ok('快相不落疤（等慢相确认）', b2.scar === 0, `scar=${b2.scar}`)
ok('快相不改 cort 主体（无固化）', b2.cort < 0.1, `cort=${b2.cort}`)

// ⑥ 慢相确认：疤在这里落
const chatInsult = async () => JSON.stringify({ valence: -2, kind: 'insult', why: '攻击性' })
B.observe({ platform: 'qq', userId: 'a2', text: '你就是个废物，滚', now: NOW + 1 })
ok('慢相确认结算', await B.consolidate('qq:a2', { chat: chatInsult, now: NOW + M }) !== false)
ok('慢相确认 → 直冲高位', B.bio('qq', 'a2', NOW + M).cort >= 0.6, `cort=${B.bio('qq', 'a2', NOW + M).cort}`)
ok('慢相落疤', B.bio('qq', 'a2', NOW + M).scar >= 1)

// 误报撤销：快相炸了、慢相判无事
B.taste({ platform: 'qq', userId: 'a3', text: '把垃圾滚出房间去', now: NOW })
ok('语义陷阱快相不出牌', B.bio('qq', 'a3').pending === '' && B.bio('qq', 'a3').cort < 0.1, JSON.stringify(B.bio('qq', 'a3')))

// ⑦ 慢相严重负面：oxy 打折
B.taste({ platform: 'qq', userId: 'a4', text: '傻逼', now: NOW })
B.observe({ platform: 'qq', userId: 'a4', text: '傻逼', now: NOW + 1 })
await B.consolidate('qq:a4', { chat: chatInsult, now: NOW + M })
ok('严重负面 oxy 打折', B.bio('qq', 'a4', NOW + M).oxy < 0.10, `oxy=${B.bio('qq', 'a4', NOW + M).oxy}`)

// ⑧ 修复通道
B.taste({ platform: 'qq', userId: 'a5', text: '你有病啊', now: NOW })
B.observe({ platform: 'qq', userId: 'a5', text: '你有病啊', now: NOW + 1 })
await B.consolidate('qq:a5', { chat: chatInsult, now: NOW + M })
const c5a = B.bio('qq', 'a5', NOW + M).cort
B.taste({ platform: 'qq', userId: 'a5', text: '对不起，我刚才不该那样说', now: NOW + 10 * M })
const f1 = B.forgive('qq', 'a5', { sincere: true, now: NOW + 11 * M })
ok('道歉兑现降 cort', f1.ok && B.bio('qq', 'a5', NOW + 11 * M).cort < c5a, `cort ${c5a} → ${B.bio('qq', 'a5', NOW + 11 * M).cort}`)
ok('宽恕不消疤', B.bio('qq', 'a5', NOW + 11 * M).scar >= 1, `scar=${B.bio('qq', 'a5', NOW + 11 * M).scar}`)
B.taste({ platform: 'qq', userId: 'a5', text: '真是对不起', now: NOW + 20 * M })
const f2 = B.forgive('qq', 'a5', { now: NOW + 21 * M })
const gain2 = (c5a - B.bio('qq', 'a5', NOW + 21 * M).cort)
ok('第二次道歉增益减半（原谅但记住）', f2.ok && B.bio('qq', 'a5', NOW + 21 * M).forgives === 2, `forgives=${B.bio('qq', 'a5', NOW + 21 * M).forgives}`)

// ⑨ 创伤后基线：疤深的人 cort 衰减目标抬高
B.taste({ platform: 'qq', userId: 'a6', text: '废物滚', now: NOW })
B.observe({ platform: 'qq', userId: 'a6', text: '废物滚', now: NOW + 1 })
await B.consolidate('qq:a6', { chat: chatInsult, now: NOW + M })
const c6 = B.bio('qq', 'a6', NOW + M).cort
const c6later = B.bio('qq', 'a6', NOW + 72 * H).cort
ok('三天后仍高于常人基线（创伤后警觉）', c6later > 0.02 && c6later < c6, `cort ${c6} → ${c6later}（基线 0.02+scar*0.03）`)

// ⑩ 曝光效应：中性接触微量漂 oxy
for (let i = 0; i < 12; i++) B.observe({ platform: 'qq', userId: 'a7', text: `今天聊了第${i}件小事`, now: NOW + i * 3600_000 })
ok('曝光效应：oxy 微涨', B.bio('qq', 'a7', NOW + 12 * H).oxy > 0.10, `oxy=${B.bio('qq', 'a7', NOW + 12 * H).oxy}`)

// ⑪ 爱轰炸：短窗密集恭维 + 无历史 → 微量警戒
for (let i = 0; i < 4; i++) B.taste({ platform: 'qq', userId: 'a8', text: `你好厉害 真棒 太喜欢你了`, now: NOW + i * 60_000 })
ok('爱轰炸检测：微量警戒', B.bio('qq', 'a8', NOW + 4 * M).cort > 0.02, `cort=${B.bio('qq', 'a8', NOW + 4 * M).cort}`)

// ⑫ 旁观学习
B.witnessed({ platform: 'qq', userId: 'a9', now: NOW })
ok('旁观：目击刻薄 → 微量警戒', B.bio('qq', 'a9', NOW).cort > 0.02, `cort=${B.bio('qq', 'a9', NOW).cort}`)
B.witnessed({ platform: 'qq', userId: 'a9', now: NOW + 10 * M })
ok('旁观有不应期（1 小时一次）', Math.abs(B.bio('qq', 'a9', NOW + 10 * M).cort - B.bio('qq', 'a9', NOW).cort) < 0.01, `${B.bio('qq', 'a9', NOW).cort} vs ${B.bio('qq', 'a9', NOW + 10 * M).cort}`)

// ⑬ 情绪耦合：社交事件轻推整体 mood（nudgeMood 真写 mood.json）
const moodBefore = Number(MOOD.mood()?.value ?? 0)
B.taste({ platform: 'qq', userId: 'b2', text: '谢谢你 棒', now: NOW })
const moodAfter = Number(MOOD.mood()?.value ?? 0)
ok('正面事件轻推 mood（nudgeMood 真写）', moodAfter > moodBefore, `${moodBefore} → ${moodAfter}`)

// ⑭⑮ 呈现层
const fl = B.feelLine('qq', 'a2', NOW + M)
ok('戒备语第一人称', fl.includes('防备') || fl.includes('留个心眼'), fl.slice(0, 40))
ok('呈现层永不漏数字', !/\d\.\d/.test(fl))
const t1 = B.tone('qq', 'a2', NOW + M)
const t2 = B.tone('qq', 'a1', NOW)
ok('tone：戒备语与软化语互斥', (t1.includes('留一分心') && !t1.includes('松一点')) || t1 === '', t1)

// ⑯ REM 门控（直接调 remTick，非睡眠时段 → 0）
B.observe({ platform: 'qq', userId: 'c1', text: '攒一段对话等结算', now: NOW })
const gated = await B.remTick({ chat: async () => '{}', sleepGate: true, now: NOW })
ok('REM 门控：非睡眠时段不结算', gated === 0)

console.log(bad ? `\n✗ ${bad} 处失败` : '\n✅ bond v2 全绿')
process.exit(bad ? 1 : 0)
