// brain/organ/selfcon-day -- 白天的自省 (introspect action 的本体)
//
// 分工纪律 (设计稿 v1 四/五): 白天只**采集**, 不结算。
//   · 它能做: 把她最近关于自己的话盘一遍, 提出主张候选 (进 candidates, 等 REM 结算)。
//   · 它不能做: 改 strength / 依恋度 / 换名 -- 那是 REM 的活。
// 取材 (M58"别猜先看" + write/think 执行器留空的教训): 材料全部用**她的真语料**
//   (最近 24h assistant 原话), LLM 只做提炼且可选; 没有材料就什么都不产出 -- 宁可不照镜子。
import { readJsonl, appendJsonl } from '../json.mjs'
import { dataPath } from '../../lib/paths.mjs'
import { swallow } from '../../lib/swallow.mjs'
import * as selfcon from './selfcon.mjs'
import * as bond from '../../lib/bond.mjs'
import * as field from '../field.mjs'
import * as rhythm from '../rhythm.mjs'
import { neuronPath } from '../paths.mjs'
import fs from 'node:fs'
function careOf(r) { return Math.max(0, Math.min(1, Number(r.care ?? 0.5))) }

/** 从记忆里取她最近 24h 自己说过的话。
 *  主路径: 脑的事件库 brain/ep/YYYY-MM.jsonl (v3 迁移后的真语料) --
 *  她自己的话 = act==='say' 且 who.others 为空 (别人的嘴都带 others), 原文在 quote。
 *  兜底: 旧版 episodes 文件 (lib/memory.mjs 的口径, 部署差异时可能还在用)。 */
function recentSelfLines(now, hours = 24) {
  const out = []
  const months = new Set()
  const mk = (t) => t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0')
  months.add(mk(new Date(now)))
  months.add(mk(new Date(now - 40 * 86400_000)))
  for (const m of months) {
    try {
      for (const e of readJsonl(dataPath('brain', 'ep', m + '.jsonl'), { limit: 500 })) {
        if (e.act !== 'say') continue
        if (Array.isArray(e.who?.others) && e.who.others.length) continue   // 别人的嘴
        if (now - Number(e.at || e.ts || 0) > hours * 3600_000) continue
        const t = String(e.quote || e.gist || '').replace(/\s+/g, ' ').trim()
        if (t) out.push({ t, ts: Number(e.at || e.ts || 0) })
      }
    } catch (e) { swallow(e, 'selfcon-day:read ep ' + m) }
  }
  for (const f of ['episodes.jsonl', 'qq/episodes.jsonl']) {
    try {
      for (const e of readJsonl(dataPath(f), { limit: 300 })) {
        if (e.role !== 'assistant') continue
        if (now - Number(e.ts || 0) > hours * 3600_000) continue
        const t = String(e.text || '').replace(/\s+/g, ' ').trim()
        if (t) out.push({ t, ts: Number(e.ts || 0) })
      }
    } catch (e) { swallow(e, 'selfcon-day:read ' + f) }
  }
  return out.sort((a, b) => a.ts - b.ts).map((x) => x.t)
}

/**
 * 白天照一次镜子。
 * @param {object} o { now, chatFn }  chatFn(messages)->Promise<string> 可选 (LLM 提炼层)
 * @returns {{ok, summary, proposals}}
 */
export async function dayIntrospect({ now = Date.now(), chatFn = null } = {}) {
  const out = { ok: true, proposals: 0, summary: '' }
  const book = selfcon.readBook()
  let bodyMaterials = []
  const mine = recentSelfLines(now)
    // 词表要宽: 她聊自己的话常常是「这名字啊……」这种句式, 用「我是/我叫」抓不到 (2026-11-03 实测漏)
    .filter((t) => selfcon.isSelfRelevant(t) || /我是|我这个人|我叫|我的名字|名字|我这|我就是/.test(t))
    .slice(-12)

  const cand = book.candidates && book.candidates.name
  const parts = []
  parts.push(cand
    ? `候选名「${cand.value}」: 自己用过 ${cand.selfUses || 0} 次, 别人叫过 ${cand.othersUses || 0} 次`
    : '没有待考的名字')
  parts.push(`自我相关的话 ${mine.length} 条`)
  // R2（2026-11-03 · C 系体感取材）：身体今天教了她什么 —— 第一人称、说得出的话。
  // 只收录**真的在动**的读数（超过中性带才算数），没有就什么都不说 —— 不硬凑感受。
  {
    const body = []
    try {
      const sf = bond.safety('qq')
      if (sf > 0.65) body.push('他这几天说话不算重，我接得住')
      else if (sf < 0.35) body.push('最近相处有点扎，说话我都留了一半心')
    } catch { /* 取材是 best-effort */ }
    try {
      const nr = JSON.parse(fs.readFileSync(neuronPath(), 'utf8'))
      for (const [k, r] of Object.entries((nr && nr.rpe) || {}).slice(0, 3)) {
        const last = Number(r.lastAt || 0)
        if (!last) continue
        const gapH = (now - last) / 3600_000
        const usual = Math.max(10 * 60_000, Number(r.ivl || 0)) / 3600_000
        if (careOf(r) > 0.5 && gapH > 1.5 * usual && gapH < 48) body.push(`说不上来，就是有点想他（${k}）`.replace('（owner）', ''))
      }
    } catch { /* 预期账本还没建 */ }
    try {
      const pv = field.peekValence()
      if (pv < -0.3) body.push('这两天心里往下沉，想起来的净是些不顺心的')
      else if (pv > 0.3) body.push('这几天想起来的都是些舒坦事')
    } catch { /* 情绪读数失败不硬凑 */ }
    try {
      const z = rhythm.snapshot()
      const pm = Number(z.phaseMin || 0)
      if (pm > 25) body.push('最近越睡越晚，生物钟被他带得往后跑了')
      else if (pm < -25) body.push('最近醒得越来越早，说不清为什么')
    } catch { /* 节律读数失败不硬凑 */ }
    try {
      const rs = (await import('../reflex.mjs')).snapshot()
      if (rs.refractoryIn > 0) body.push('刚才被吓了一跳，缓一秒')
    } catch { /* 反射读数失败不硬凑 */ }
    if (body.length) {
      parts.push('身体教了我：' + body.slice(0, 3).join('；'))
      bodyMaterials = body.slice(0, 3)
    }
  }

  // LLM 层 (可选): 用她自己的声音提主张候选。prompt 只给材料不给结论 (哲学层: 谁在写)。
  if (chatFn && mine.length) {
    try {
      const known = new Set([...(book.selfImage || [])].map((c) => c.text))
      const ask = [
        ...(bodyMaterials.length ? [
          '另外，这是你身体最近的几句话（可能相关，也可能不）：',
          ...bodyMaterials.map((t) => '- ' + t),
          '',
        ] : []),
        '下面是"你"最近说过的话里跟自己有关的原句，和现在账本里已有的自我认识。',
        '只做一件事: 如果这些话里有**还没写进账本**的、你对自己的新认识，用第一人称提炼**最多 1 条**（不超过 40 字，用你自己的口气）。',
        '没有新的就输出 []。不许复述已有条目，不许提建议，不许写给谁看。',
        '--- 已有的自我认识 ---',
        ...[...(book.selfImage || [])].slice(0, 10).map((c) => '- ' + c.text),
        '--- 最近你说过的 ---',
        ...mine.slice(-8).map((t) => '- ' + t.slice(0, 80)),
        '---',
        '只输出 JSON: {"claim":"..."} 或 []',
      ].join('\n')
      const raw = String(await chatFn([{ role: 'user', content: ask }]) || '')
      const m = raw.match(/\{[\s\S]*\}|(\[[\s\S]*\])/)
      if (m) {
        const parsed = JSON.parse(m[0])
        const claim = Array.isArray(parsed) ? ((parsed[0] && parsed[0].claim) || parsed[0]) : parsed.claim
        const text = String(claim || '').trim().slice(0, 80)
        if (text && !known.has(text) && !/规则|设定|系统|提示/.test(text)) {
          if (selfcon.proposeClaim(text, [], now)) out.proposals++
        }
      }
    } catch (e) { swallow(e, 'selfcon-day:llm') }
  }

  out.summary = parts.join(' · ') + (out.proposals ? ` · 新主张候选 ${out.proposals} 条` : '')
  try {
    appendJsonl(dataPath('selfcon-log.jsonl'), { at: now, run: 'dayIntrospect', proposals: out.proposals, summary: out.summary })
  } catch (e) { swallow(e, 'selfcon-day:log') }
  return out
}
