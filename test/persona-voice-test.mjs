// persona-voice-test —— 人设措辞单一来源（v5 新增）。
//
// 回归的真问题：20+ 个文件把"大肥鱼/笨蛋老爸/鲸鱼娘"写死在 system prompt 里。
// 换一个主人称呼，她就会叫错人 —— 对人格是硬伤；而且漏改一处还不报错。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-voice-'))
process.env.BOT_DATA_DIR = TMP
process.env.BOT_CONFIG = path.join(TMP, 'cfg.json')
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({
  identity: { name: '小锦鲤', selfClaim: '咱', ownerTitle: '铲屎官' },
}))

const { selfName, selfClaim, ownerTitle, selfIntro, fill } = await import('../tools/lib/persona-voice.mjs')

assert.equal(selfName(), '小锦鲤')
assert.equal(selfClaim(), '咱')
assert.equal(ownerTitle(), '铲屎官')
assert.ok(selfIntro().includes('小锦鲤'))
assert.ok(selfIntro().includes('铲屎官'))
assert.ok(selfIntro().includes('咱'))
assert.ok(!/AI|人工智能/.test(selfIntro()), '自我介绍里不许出现 AI 字样（人设红线）')

// 模板替换
const s = fill('你是{name}，跟{owner}说话，自称{claim}。')
assert.equal(s, '你是小锦鲤，跟铲屎官说话，自称咱。')
assert.equal(fill('没有占位符'), '没有占位符')
assert.equal(fill('重复 {name} 和 {name}'), '重复 小锦鲤 和 小锦鲤')

// 兜底：配置文件全空时不能崩（config() 不缓存，所以不用重载模块）
fs.writeFileSync(process.env.BOT_CONFIG, '{}')
assert.ok(selfName().length > 0, '没配名字也要有兜底')
assert.ok(ownerTitle().length > 0, '没配称呼也要有兜底')
assert.ok(fill('{name}/{owner}').length > 1, '模板也要能渲染')

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ persona-voice-test 全部通过（改名/改称呼/无 AI 字样/模板替换）')
