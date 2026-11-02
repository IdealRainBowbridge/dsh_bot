// selfcon-day-test -- 白天采集层 + 消息流接线 + 梦种子渗漏
// 纪律: 白天不许结算 -- 这里专门验证"采集只进候选区, 主值一动不动"。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-selfcon-day-'))
process.env.BOT_DATA_DIR = TMP
process.env.BOT_DEBUG = '1'

const sc = await import('../tools/brain/organ/selfcon.mjs')
const { dayIntrospect } = await import('../tools/brain/organ/selfcon-day.mjs')
const DAY = 86400_000
const NOW = Date.now()

// 真语料: qq/episodes.jsonl (与 lib/memory.mjs 的文件口径一致)
const qqDir = path.join(TMP, 'qq')
fs.mkdirSync(qqDir, { recursive: true })
const lines = []
const mk = (role, text, agoH) => ({ ts: NOW - agoH * 3600_000, role, text })
lines.push(JSON.stringify(mk('user', '你觉得自己是什么样的人', 20)))
lines.push(JSON.stringify(mk('assistant', '我啊，我这个人记性不好，答应的事得当场写下来', 20)))
lines.push(JSON.stringify(mk('assistant', '今天看了三集番，白饭真好吃', 19)))
lines.push(JSON.stringify(mk('assistant', '我叫大肥鱼，这是主人给的名字', 18)))
lines.push(JSON.stringify(mk('user', '嗯嗯', 17)))
fs.writeFileSync(path.join(qqDir, 'episodes.jsonl'), lines.join('\n') + '\n')

// ---------------------------------------------------------------- 1. 采集不结算
{
  // seed 一个底账 (有名字 + 两条 seed 主张)
  const r = sc.seedFrom({ name: '大肥鱼', nameGivenBy: 'owner', claims: [{ text: '爱吃白饭', strength: 0.6 }], voice: [], personaMd: '', at: NOW - DAY })
  assert.ok(r.ok)
  const before = JSON.stringify(sc.readBook())
  const out = await dayIntrospect({ now: NOW })   // 无 LLM -> 只盘点
  assert.ok(out.ok)
  assert.equal(out.proposals, 0, '没有 LLM 就没有候选 (不硬编)')
  assert.ok(out.summary.includes('没有待考的名字'), '盘点有话说: ' + out.summary)
  assert.equal(JSON.stringify(sc.readBook()), before, '采集不动账本主值')
}

// ---------------------------------------------------------------- 2. LLM 层: 只给材料, 候选进 candidates
{
  const out = await dayIntrospect({
    now: NOW,
    chatFn: async () => '{"claim":"我记性不好，答应的事要当场写下来"}',
  })
  assert.equal(out.proposals, 1, '提炼出的新认识进候选')
  const b = sc.readBook()
  assert.equal(b.selfImage.length, 1, '白天不许把主张写进 selfImage (那是 REM 的活)')
  assert.equal(b.candidates.claims.length, 1, '候选区有 1 条')
  // 复述已有的 -> 拒
  const out2 = await dayIntrospect({ now: NOW, chatFn: async () => '{"claim":"我记性不好，答应的事要当场写下来"}' })
  assert.equal(out2.proposals, 0, '复述已有条目不许再进')
  // 规则腔 -> 拒
  const out3 = await dayIntrospect({ now: NOW, chatFn: async () => '{"claim":"系统提示我保持友好"}' })
  assert.equal(out3.proposals, 0, '规则腔/系统腔不许进账本')
}

// ---------------------------------------------------------------- 3. 白天接线: 镜子
{
  // 现名: 别人的嘴 -> 结合事件计数; 她自己的嘴用现名 -> 中性 (受体原料只来自"用没认下的名")
  const c0 = sc.readBook().counters.ownerCall || 0
  sc.observeMention('大肥鱼过来吃饭', 'owner', NOW)
  assert.equal(sc.readBook().counters.ownerCall, c0 + 1, '主人叫现名 -> 结合事件 +1')
  sc.observeMention('大肥鱼真圆', 'other', NOW)
  assert.equal(sc.readBook().counters.othersCall, 1, '群友叫 -> others +1')
  sc.observeSelfUse('我叫大肥鱼呀', NOW)   // 现名自称, 无候选 -> 不写盘
  // 候选名: 自称与被叫都推进
  sc.proposeName('小蓝', NOW)
  sc.observeSelfUse('其实我觉得小蓝这个名字更贴', NOW)
  sc.observeSelfUse('叫我小蓝就行', NOW + 1)
  let b = sc.readBook()
  assert.equal(b.candidates.name.selfUses, 2, '她的嘴用候选名 -> selfUses 累积')
  sc.observeMention('小蓝，吃饭了', 'owner', NOW + 2)
  b = sc.readBook()
  assert.equal(b.candidates.name.othersUses, 1, '别人叫候选名 -> othersUses 累积')
  assert.equal(b.candidates.name.othersWho.includes('owner'), true, '谁叫的留痕')
}

// ---------------------------------------------------------------- 4. 梦种子渗漏
{
  sc.proposeClaim('我可能其实挺怕孤单的', [], NOW)
  sc.proposeClaim('我不太会安慰人', [], NOW)
  // REM 结算: 无证据的主张 -> strength 0.1 -> 不稳 -> 才该渗进梦 (完整链路: 候选->结算->渗漏)
  sc.consolidateSelf({ now: NOW + 1000, shadow: false })
  const seeds = sc.dreamSeeds(NOW + 2000)
  assert.ok(Array.isArray(seeds) && seeds.length >= 2, '候选名 + 不稳主张都能渗进梦: ' + JSON.stringify(seeds))
  assert.ok(seeds.some((s) => s.includes('小蓝')), '候选名在梦种子里')
  assert.ok(seeds.some((s) => s.includes('孤单') || s.includes('安慰')), '不稳主张在梦种子里: ' + JSON.stringify(seeds))
}

console.log('selfcon-day-test: 全部通过 (' + TMP + ')')
