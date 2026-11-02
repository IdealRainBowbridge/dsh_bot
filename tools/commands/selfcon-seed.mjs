// selfcon-seed -- 初始账本迁移 (设计稿 v1 二, 拍板 1 + 2)
//
// 一次性: 把现在的 identity 三件套 + persona.md + 腔调规则 转成 selfcon.json 的 seed 条目。
// 原则: **不发明任何新内容** -- 账本的起点就是她现在的样子, 之后由她的经历改写。
// 幂等: selfcon.seedFrom 里挡了二次迁移 (seededAt 已设即拒绝)。
//
// 用法: node tools/commands/selfcon-seed.mjs
import { dataPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import { personaText } from '../lib/persona.mjs'
import { selfName, selfClaim, ownerTitle } from '../lib/persona-voice.mjs'
import * as selfcon from '../brain/organ/selfcon.mjs'
import { swallow } from '../lib/swallow.mjs'

/** 从记忆里找最早被叫名字的一次 (取匹配里最旧的一条做证据锚点)。
 *  grepEpisodes 返回按时间序的 {ts, text, role}; 检索不到就返回 null -- 宁缺, 不编造。 */
async function findNameOrigin(name) {
  try {
    const mem = await import('../lib/memory.mjs')
    const rows = mem.grepEpisodes(name, { limit: 30, role: 'user' })
    if (!rows.length) return null
    const oldest = rows[0]
    return 'ep-' + new Date(Number(oldest.ts)).toISOString().slice(0, 10)
  } catch (e) { swallow(e, 'selfcon-seed:findNameOrigin'); return null }
}

async function main() {
  const cfg = config()
  const personaMd = personaText()
  const name = selfName(cfg)
  const claim = selfClaim(cfg)
  const owner = ownerTitle(cfg)

  // 形象主张: 从 persona.md 的"性格"小节取要点 (原句截取, 不改写不发明)
  const claims = []
  const personalityMatch = personaMd.match(/##\s*性格[^\n]*\n([\s\S]*?)(?:\n##\s|$)/)
  if (personalityMatch) {
    for (const raw of personalityMatch[1].split('\n')) {
      const t = raw.replace(/^[-*\s]+/, '').trim()
      if (t && t.length >= 4 && t.length <= 60) claims.push({ text: t, evidence: [], strength: 0.6 })
    }
  }
  // 声音锚: persona.md "说话/其它"里的引号样例句 (截原句)
  const voice = []
  const speechMatch = personaMd.match(/其它：\n([\s\S]*?)(?:\n##\s|$)/)
  if (speechMatch) {
    for (const raw of speechMatch[1].split('\n')) {
      const q = (raw.match(/[「]([^「」]+)[」]/) || [])[1]
      if (q && q.length >= 2) voice.push({ quote: q, evidence: [], strength: 0.6 })
    }
  }

  const firstEvent = await findNameOrigin(name)
  const r = selfcon.seedFrom({ name, nameGivenBy: 'owner', nameFirstEvent: firstEvent, claims, voice, personaMd })
  if (!r.ok) {
    console.log('[selfcon-seed] 跳过: ' + r.reason)
    return
  }
  console.log('[selfcon-seed] 完成:')
  console.log('  名字: ' + name + ' (自称=' + claim + ', 称呼主人=' + owner + ')' + (firstEvent ? ' firstEvent=' + firstEvent : ' firstEvent 未找到, 留空'))
  console.log('  形象主张: ' + claims.length + ' 条 (origin=seed)')
  console.log('  声音锚: ' + voice.length + ' 条 (origin=seed)')
  console.log('  persona.md 原文存为出生记录 (' + personaMd.length + ' 字) -> ' + dataPath('selfcon.json'))
  console.log('  identity 三件套字段保留; persona.mjs 注入侧退役 -- 见 assemble.mjs selfcon 槽')
}

main().catch((e) => { console.error('[selfcon-seed] 失败: ' + (e && e.message || e)); process.exit(1) })
