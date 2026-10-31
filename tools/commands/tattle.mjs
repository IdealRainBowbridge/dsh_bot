// tattle —— 打小报告：看完好视频 → LLM 写一段"汇报" → QQ 私信发给笨蛋老爹。
// 形态（网上流行的鱼号）：不是甩链接，是「老爹我跟你说，我今天看到…」的人话汇报。
// 触发：bili-watch 深读评分 >= 阈值（默认 15）时调用；手动也能跑。
// 节流：一天最多 3 条（config.tattle.dailyMax），避免变成骚扰。
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import { dataPath } from '../lib/paths.mjs'
import { sendOwnerQQ } from '../lib/notify.mjs'

const NL = String.fromCharCode(10)
const STATE = () => dataPath('tattle.json')

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) } catch { return { day: '', sent: 0 } }
}
function writeState(st) {
  fs.mkdirSync(dataPath('tattle.json').replace('/tattle.json', ''), { recursive: true })
  fs.writeFileSync(STATE(), JSON.stringify(st, null, 1))
}
function quotaOk() {
  const day = new Date().toLocaleDateString('sv-SE')
  const st = readState()
  if (st.day !== day) { st.day = day; st.sent = 0 }
  const max = Number(config().tattle?.dailyMax ?? 3)
  if (st.sent >= max) return { ok: false, why: `今天已打 ${st.sent} 次小报告（上限 ${max}）` }
  return { ok: true, st }
}
function markSent(st) {
  st.sent += 1
  st.lastAt = Date.now()
  writeState(st)
}

/** 写汇报：LLM 用她的口吻把「看了什么+我的看法」讲给笨蛋老爹听。 */
async function compose({ title, bvid, score, highlight, reason }) {
  const llm = await import('../lib/llm.mjs')
  const r = await llm.chat([
    { role: 'system', content: '你是大肥鱼，一只住在电脑里的鲸鱼娘，正在 QQ 私信跟笨蛋老爹（你的主人）「打小报告」——汇报你今天看到的好视频。要求：像跟家人聊天，60 字内，先说看到了什么，再说你为什么觉得值得说（你的真实看法），最后可以带一句想跟他讨论的点。不要客套开头，直接进内容。只输出消息本身。' },
    { role: 'user', content: `视频：《${title}》（BV ${bvid}）\n我的评分：${score}/20\n评分理由：${reason || '（无）'}\n值得说的点：${highlight || '（无，自己从理由里提炼）'}` },
  ], { temperature: 0.9, max_tokens: 150, timeoutMs: 25000, purpose: 'creative' })
  return String(r || '').trim()
}

/** 主入口：打一条小报告。 */
export async function tattle({ title, bvid, score, reason, highlight }) {
  const q = quotaOk()
  if (!q.ok) return { ok: false, why: q.why }
  let text = ''
  try { text = await compose({ title, bvid, score, reason, highlight }) } catch {}
  if (!text) {
    text = `老爹，今天看到《${String(title).slice(0, 30)}》，打了 ${score} 分。${reason ? String(reason).slice(0, 60) : '值得一看'}。有空可以看看。`
  }
  const full = `🐋 ${text}${NL}https://www.bilibili.com/video/${bvid}`
  const ok = await sendOwnerQQ(full)
  if (ok) markSent(q.st)
  return { ok, text: full }
}

export async function run(args) {
  const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : '' }
  const title = get('--title') || '未命名'
  const bvid = get('--bvid')
  const score = get('--score') || '?'
  const reason = get('--reason')
  const highlight = get('--highlight')
  if (!bvid) { console.error('用法：tattle --title 标题 --bvid BV号 [--score 分] [--reason 理由] [--highlight 亮点]'); process.exit(2) }
  const r = await tattle({ title, bvid, score, reason, highlight })
  if (!r.ok) { console.error('✗ ' + r.why); process.exit(1) }
  console.log('✓ 小报告已发：')
  console.log(r.text)
}
