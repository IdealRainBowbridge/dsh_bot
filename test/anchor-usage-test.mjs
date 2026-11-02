// anchor-usage-test (P2-3, 2026-11-03): usage-dependent consolidation.
// A line she kept re-deriving (near-duplicates in her own stream) must outrank
// fresher one-off lines when anchors freeze. The control: the repeated line is
// the OLDEST in the pool - without the replay bonus it would lose to freshness.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-anchor-usage-'))
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

const inner = await import('../tools/brain/inner.mjs')
const anchor = await import('../tools/brain/anchor.mjs')

const DAY = 86400_000
const H = 3600_000
const now = Date.now()

// replayed line: same wording three times, oldest of all candidates
const REPLAY = '笨蛋老爸又偷喝我的可乐，冰箱里连罐都不给我留，气死我了'
inner.stream({ role: 'self', kind: 'say', text: REPLAY }, now - 5 * DAY)
inner.stream({ role: 'self', kind: 'say', text: REPLAY }, now - 3 * DAY)
inner.stream({ role: 'self', kind: 'say', text: REPLAY }, now - 1 * DAY)

// fresh one-off competitors: each said within the last hours (freshness wins
// under the old scoring), distinct enough to pass the similar() filter
const fillers = [
  '哼，才不告诉你我今天在番里看到什么了',
  '你们这群人真是笑死我了，一天到晚就会起哄',
  '凭什么我的零食柜就归公家了啦，过分',
  '明明就是你们先动手的，怎么还倒打一耙啊',
]
fillers.forEach((t, i) => inner.stream({ role: 'self', kind: 'say', text: t }, now - i * H - H))

const r = anchor.sample({ force: true, now })
ok('采样成功', r.changed === true, r.why || '')

const items = anchor.snapshot({ now }).items
const texts = items.map((x) => x.text)
ok('重复被说的句子冻结进锚', texts.some((t) => t.includes('可乐')), JSON.stringify(texts))
ok('重复句子排第一（压过更新的单次句子）', String(texts[0]).includes('可乐'), texts[0])

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
