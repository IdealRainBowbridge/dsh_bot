// selfcon-engine-test -- 自我账本引擎: seed / 候选结算 / 影子模式 / 化学参数 / rebuild
//
// 器官判据 (M58 纲领) 是第 9 测: 账本清空 -> 只喂"使用事实" -> 同样的名字重新长出来。
// 长不出来 = 电路板, 打回。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-selfcon-'))
process.env.BOT_DATA_DIR = TMP
process.env.BOT_DEBUG = '1'

const sc = await import('../tools/brain/organ/selfcon.mjs')
const DAY = 86400_000
const T0 = 1735689600000   // 固定基准, 不用 1970 的时间戳

const freshFile = () => { fs.rmSync(path.join(TMP, 'selfcon.json'), { force: true }) }

// ---------------------------------------------------------------- 1. seed 迁移
{
  const r = sc.seedFrom({
    name: '理想的机械人', nameGivenBy: 'owner', nameFirstEvent: 'ep-2026-10-30',
    claims: [{ text: '爱吃白饭，饭点必到', strength: 0.6 }, { text: '聪明但懒', strength: 0.6 }],
    voice: [{ quote: '呜', strength: 0.6 }],
    personaMd: '# 你是理想的机械人\n（出生记录）',
    at: T0,
  })
  assert.ok(r.ok, 'seed 应成功')
  const b = sc.readBook()
  assert.equal(b.name.value, '理想的机械人')
  assert.equal(b.name.givenBy, 'owner')
  assert.equal(b.name.firstEvent, 'ep-2026-10-30')
  assert.equal(b.selfImage.length, 2)
  assert.equal(b.selfImage[0].origin, 'seed')
  assert.equal(b.voice[0].origin, 'seed')
  assert.ok(b.seedPersonaMd.includes('出生记录'))
  assert.equal(b.name.attachment, 0.9)
}
// 幂等: 二次 seed 拒绝
{
  const r = sc.seedFrom({ name: '别的', claims: [], voice: [], personaMd: '', at: T0 + 1 })
  assert.ok(!r.ok, '二次 seed 必须被拒')
  assert.equal(sc.readBook().name.value, '理想的机械人')
}

// ---------------------------------------------------------------- 2. rebuild: 档位由数据产生
{
  const t = sc.rebuild({ now: T0 })
  assert.ok(t.includes('理想的机械人'), 'rebuild 要有名字')
  assert.ok(t.includes('旧毛衣'), '依恋 0.9 -> 旧毛衣档位')
  assert.ok(t.includes('爱吃白饭'), 'rebuild 要有形象主张')
  assert.ok(sc.block({ now: T0 }).includes('我自己认下的'), 'block 带标头')
}
// ---------------------------------------------------------------- 3. 空账本 = 留白 (可观察的成长状态)
{
  freshFile()
  const t = sc.rebuild({ now: T0 })
  assert.ok(t.includes('还没认下'), '空账本 rebuild 是留白版')
  assert.ok(sc.block({ now: T0 }).length > 0, '留白版也要注入 (名字栏空着本身是状态)')
  assert.ok(!sc.block({ now: T0 }).includes('你是理想的机械人'), '留白版不许替她断言名字')
}
// 重新 seed 供后面用
{
  const r = sc.seedFrom({ name: '理想的机械人', nameGivenBy: 'owner', claims: [{ text: '懒', strength: 0.6 }], voice: [], personaMd: '', at: T0 })
  assert.ok(r.ok)
}

// ---------------------------------------------------------------- 4. 候选名: 登记容易, 转正难
{
  sc.proposeName('小蓝', T0)
  // 太年轻 -> 不结算
  let out = sc.consolidateSelf({ now: T0 + DAY, shadow: false })
  assert.equal(sc.readBook().name.value, '理想的机械人', '观察期没满不许换名')
  assert.ok(out.notes.some((n) => n.includes('观察期')), '要有观察期提示: ' + out.notes.join(';'))
  // 观察期满了但使用事实不够 -> 不结算
  out = sc.consolidateSelf({ now: T0 + 4 * DAY, shadow: false })
  assert.equal(sc.readBook().name.value, '理想的机械人', '阈值不够不许换名')
  // 使用事实补齐: 自称 3 次 + 有人跟着叫 1 次 (哲学层: 账本不改名, 只结算已发生的使用)
  sc.recordSelfUse('小蓝', T0 + 4 * DAY)
  sc.recordSelfUse('小蓝', T0 + 4 * DAY + 1)
  sc.recordSelfUse('小蓝', T0 + 4 * DAY + 2)
  sc.recordOthersUse('小蓝', 'owner', T0 + 4 * DAY + 3)
  out = sc.consolidateSelf({ now: T0 + 4 * DAY + 60000, shadow: false })
  const b = sc.readBook()
  assert.equal(b.name.value, '小蓝', '阈值+观察期都过 -> 结算换名')
  assert.equal(b.name.givenBy, 'self')
  assert.equal(b.nameTransition.from, '理想的机械人', '换名留旧名 -> 别扭期')
  assert.ok(b.name.attachment >= 0.1, '新名继承部分依恋')
  assert.ok(b.name.history.some((h) => h.name === '理想的机械人'), '旧名进 history 留痕')
  assert.equal(b.candidates.name, null, '结算后候选区清空')
  // 重复候选: 现名不进候选区
  sc.proposeName('小蓝', T0 + 5 * DAY)
  assert.equal(sc.readBook().candidates.name, null, '现名不许再进候选')
}
// ---------------------------------------------------------------- 5. 别扭期
{
  const p = sc.nameTransitionProgress(T0 + 5 * DAY)
  assert.ok(p >= 0 && p < 0.95, '刚换名 -> 别扭期进行中')
  const t = sc.rebuild({ now: T0 + 5 * DAY })
  assert.ok(t.includes('理想的机械人'), '别扭期 rebuild 提旧名')
  assert.ok(t.includes('适应') || t.includes('回头'), '别扭期有适应措辞')
}
// ---------------------------------------------------------------- 6. 影子模式: 主值一根毛都不动
{
  const before = JSON.stringify(sc.readBook())
  const out = sc.consolidateSelf({ now: T0 + 6 * DAY, shadow: true })
  assert.ok(out.ok)
  assert.equal(JSON.stringify(sc.readBook()), before, '影子巩固不许动账本')
  assert.ok(fs.existsSync(path.join(TMP, 'selfcon-log.jsonl')), '影子要有日志可看')
  assert.ok(out.rebuild.length > 0, '影子也产出 rebuild 供观察')
}

// ---------------------------------------------------------------- 7. 化学层: 储备型信号
{
  const a0 = sc.readBook().name.attachment
  // 30 次结合事件 -> 依恋上升 (清除在跑, 但事件把它抬回来)
  for (let i = 0; i < 30; i++) sc.recordOthersUse('小蓝', 'owner', T0 + 6 * DAY + i)
  sc.consolidateSelf({ now: T0 + 7 * DAY, shadow: false })
  const a1 = sc.readBook().name.attachment
  assert.ok(a1 > a0, '结合事件抬升依恋: ' + a0 + ' -> ' + a1)
  assert.ok(a1 <= 1, 'clamp 01')
  // 什么都不发生 -> 只剩清除, 依恋回落
  sc.consolidateSelf({ now: T0 + 7 * DAY + 30 * DAY, shadow: false })
  const a2 = sc.readBook().name.attachment
  assert.ok(a2 < a1, '无事件 -> 指数清除让它回落: ' + a1 + ' -> ' + a2)
}

// ---------------------------------------------------------------- 8. 反戏剧化上限
{
  sc.proposeClaim('我是六翼天使', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], T0 + 8 * DAY)
  sc.consolidateSelf({ now: T0 + 9 * DAY, shadow: false })
  const c = sc.readBook().selfImage.find((x) => x.text === '我是六翼天使')
  assert.ok(c, '候选主张入账')
  assert.ok(Math.abs(c.strength - 0.65) < 1e-9, '7 条证据也封顶 0.65: ' + c.strength)
  const t = sc.rebuild({ now: T0 + 9 * DAY })
  assert.ok(!t.includes('我很确定我是六翼天使'), '浮夸主张不许拿"我很确定"档')
}

// ---------------------------------------------------------------- 9. load / statusLine / 种属行
{
  assert.ok(sc.load({ now: T0 + 9 * DAY }) >= 0 && sc.load({ now: T0 + 9 * DAY }) <= 1)
  assert.ok(sc.statusLine().includes('小蓝'))
  assert.ok(sc.SPECIES_LINE.includes('一类生物'))
  assert.ok(!sc.SPECIES_LINE.includes('你是理想的机械人，一只'), '种属行不许再是断言句')
  assert.ok(sc.CHEM.CANDIDATE_MIN_AGE_MS >= 3 * DAY, '临床防呆: 观察期 >= 3 天')
}

// ---------------------------------------------------------------- 10. 器官判据: 重长
{
  freshFile()
  // 账本没了, 只有"经历"(使用事实流) -- 同样的事实要长出同样的名字
  sc.proposeName('小蓝', T0)
  sc.recordSelfUse('小蓝', T0); sc.recordSelfUse('小蓝', T0 + 1); sc.recordSelfUse('小蓝', T0 + 2)
  sc.recordOthersUse('小蓝', 'owner', T0 + 3)
  sc.consolidateSelf({ now: T0 + 4 * DAY, shadow: false })
  assert.equal(sc.readBook().name.value, '小蓝', '重长: 同样的事实长出同样的名字')
}

console.log('selfcon-engine-test: 全部通过 (' + TMP + ')')
