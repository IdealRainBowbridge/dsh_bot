// roster 回归测试（2026-11-03）—— 钉「人物名册」的接线与语义。
// 隔离同 presence-test：env 先指沙箱，再动态 import。
// 钉的是**形状**：
//   ① 用户绝不入册（owner 是身份不是联系人）
//   ② 陌生人照面建卡 / 幂等累计 / 昵称更新留第一眼
//   ③ audienceHint：没照面 → 空；照面 → 有名字有句数；owner → 永远空
//   ④ rename/note：先建卡允许、印象必须先认识人；hint 里用称呼不用号码
//   ⑤ 满员淘汰：501 人进来，最久没见的走，总数不破上限
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.BOT_CONFIG = path.join(TMP, '.dsh', 'bot.config.json')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({ owner: { qq: '111', name: '笨蛋管理员' } }))

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const R = await import('../tools/lib/roster.mjs')

// ① 用户不入册
ok('用户 observe 返回 null', R.observe({ platform: 'qq', userId: '111', name: '笨蛋管理员' }) === null)
ok('用户在册中不存在（文件都还没建也是对的）', (() => { const f = path.join(TMP, 'roster.json'); return !fs.existsSync(f) || !fs.readFileSync(f, 'utf8').includes('"qq:111"') })())

// ② 陌生人建卡 + 幂等累计
const p1 = R.observe({ platform: 'qq', userId: '222', name: '路人甲' })
ok('首面建卡 meets=1', p1 && p1.meets === 1 && p1.name === '路人甲')
const p2 = R.observe({ platform: 'qq', userId: '222', name: '路人甲' })
ok('再见面 meets=2（同卡不重建）', p2.meets === 2)
const p3 = R.observe({ platform: 'qq', userId: '222', name: '新名字' })
ok('改名更新 + 留第一眼', p3.name === '新名字' && p3.firstSeenName === '路人甲')

// ③ audienceHint
ok('没照面的人 hint 为空', R.audienceHint('qq', '999') === '')
ok('owner hint 永远为空', R.audienceHint('qq', '111') === '')
const hint = R.audienceHint('qq', '222')
ok('照面后 hint 有名字有句数', hint.includes('新名字') && hint.includes('聊过 3 句'), hint.slice(0, 60))
ok('hint 提醒别拿数字当称呼', hint.includes('编号'))

// ④ rename / note
ok('给没见过的人先建卡（rename 允许）', R.rename('qq', '333', '小鱼干').ok === true)
ok('对没见过的人记印象被拒', R.note('qq', '444', '爱发猫图').ok === false)
ok('对认识的人记印象成功', R.note('qq', '333', '爱发猫图的那位').ok === true)
const hint2 = R.audienceHint('qq', '333')
ok('hint 用她起的称呼', hint2.includes('小鱼干') && hint2.includes('爱发猫图'), hint2.slice(0, 60))
ok('印象长度截断（两次超限合计）', (() => { for (let i = 0; i < 10; i++) R.note('qq', '333', '印象补充' + i + '。'.repeat(20)); const h = R.audienceHint('qq', '333'); return h.length < 500 })())

// ⑤ 满员淘汰
for (let i = 0; i < 501; i++) R.observe({ platform: 'qq', userId: `bulk_${i}` })
const st = R.stats()
ok('满员不破上限 500', st.people <= 500, `实际 ${st.people}`)
ok('最早的路人被淘汰', !R.audienceHint('qq', 'bulk_0') || st.people < 500)

console.log(bad ? `\n✗ ${bad} 处失败` : '\n✅ roster 全绿')
process.exit(bad ? 1 : 0)
