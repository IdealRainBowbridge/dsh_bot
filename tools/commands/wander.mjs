// wander —— 主动探索：结合记忆的自主念头 → 自己决定做什么 → 自己执行。
//
// 与固定流程（wake/review/evolution）的本质区别：
//   固定流程 = 到点了告诉她"做这7步"
//   wander   = 她从自己的记忆里发现"我想做XX"，自己拆步骤，自己执行，自己汇报
//
// 触发：qq-server 的 tick 里，跟 tryProactive 并行。频率独立控制。
// 全程她自己的选择，不是脚本指定。
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import { fill } from '../lib/persona-voice.mjs'
import { dataPath } from '../lib/paths.mjs'
import { readJsonl } from '../brain/json.mjs'
import { swallow } from '../lib/swallow.mjs'
import * as novelty from '../lib/novelty.mjs'

/**
 * 本插件的命令行入口（tools/bot.mjs）的绝对路径。
 *
 * ⚠️ 2026-11-02：这里原来写死 '/home/bot/plugins/dsh_bot/tools/bot.mjs'。
 *    插件改名 dsh_bot 之后那个路径不存在了，而外面的 catch 会把它当成
 *    "这一步失败了" 记进去 —— 看起来像"探索做了但没成"，
 *    实际是**路径根本没指对**。这类错很难从日志上看出来。
 *
 *    改成从本文件的相对位置推，跟插件装在哪无关。
 */
function BOT_CLI() {
  return new URL('../bot.mjs', import.meta.url).pathname
}


const STATE = () => dataPath('wander-state.json')

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) } catch { return { day: '', count: 0, lastAt: 0 } }
}
function writeState(st) {
  fs.writeFileSync(STATE(), JSON.stringify(st, null, 1))
}

/** 收集"念头的原材料"——从记忆里找她可能想做但没做的事。 */
function gatherMaterial() {
  const out = []
  try {
    const lore = JSON.parse(fs.readFileSync(dataPath('lore.json'), 'utf8'))
    for (const l of (lore || []).slice(-8)) {
      if (/想|试试|该|值得|好奇/.test(l.text)) out.push(l.text.slice(0, 60))
    }
  } catch (e) { swallow(e, 'tools/commands/wander.mjs:31') }
  try {
    const st = JSON.parse(fs.readFileSync(dataPath('sleep-state.json'), 'utf8'))
    const opt = (st.lastSleep?.phases || []).find(p => p.name === '优化')
    if (opt?.result?.problems > 0) out.push('睡眠审查发现：' + opt.result.note.slice(0, 60))
  } catch (e) { swallow(e, 'tools/commands/wander.mjs:36') }
  try {
    const pr = JSON.parse(fs.readFileSync(dataPath('promises.json'), 'utf8'))
    const due = (pr || []).filter(p => p.state === 'pending' && Date.now() > Number(p.dueAt || 0))
    for (const p of due.slice(0, 2)) out.push('答应过的：' + p.text)
  } catch (e) { swallow(e, 'tools/commands/wander.mjs:41') }
  try {
    const eps = readJsonl(dataPath('episodes.jsonl'), { limit: 30 })
      .filter(e => Date.now() - Number(e.ts || 0) < 24 * 3600_000 && /值得|有趣|好奇|想/.test(e.summary || ''))
    for (const e of eps.slice(0, 3)) out.push(e.summary.slice(0, 60))
  } catch (e) { swallow(e, 'tools/commands/wander.mjs:46') }

  // 新鲜事进原料（二轮）：arousal 高说明有东西在挠她，念头就该从这里长 ——
  // 好奇决定"探索什么"，不只是"多久探索一次"。只取真新鲜的（u>0），静默时不出声。
  try {
    const a = novelty.assess(Date.now())
    for (const it of (a.items || [])) {
      if (it.u > 0) out.push('新鲜（' + it.u + '）：' + it.text.slice(0, 50))
    }
  } catch (e) { swallow(e, 'tools/commands/wander.mjs:material-novelty') }
  return out
}

export async function wander() {
  const cfg = config()
  const material = gatherMaterial()
  const llm = await import('../lib/llm.mjs')

  const sys = [
    fill('你是{name}，一只鲸鱼娘，住在{owner}的电脑里。你有很多能力（看B站视频/上网/写日记/做表情包/发动态/写代码）。现在没人给你指令——你自己想想：接下来想做什么？'),
    '规则：',
    '- 念头必须从你的记忆/经历/好奇心里自然产生，不是为了做事而做事',
    '- 可以是很小的念头也可以是大一点的',
    '- 必须是你有能力做到的：看视频、上网搜、读网页、写日记、发评论/动态/签名、写代码文件',
    '- 做不了的就别选',
    '- 只输出 JSON：{"want": "你想做什么", "steps": ["第一步命令", ...], "reason": "为什么想做"}',
    '- steps 里的每一步必须是一条可以直接执行的命令',
    '- 如果真的什么都想做，输出 {"want": "", "steps": [], "reason": "没什么想做的"}',
  ].join('\n')

  const user = material.length
    ? '你的记忆里这些东西在勾着你：\n' + material.map((m) => '- ' + m).join('\n') + '\n\n想想：你现在最想做的是什么？'
    : '最近记忆里没什么特别的。你自己想想：有没有什么一直想试但还没试的事？没有就说没有。'

  const r = await llm.chat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { temperature: 1.0, max_tokens: 300, timeoutMs: 30000, purpose: 'deep' })

  const m = String(r || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    if (!j.want || !Array.isArray(j.steps) || !j.steps.length) return null
    return j
  } catch { return null }
}

export async function doWander() {
  const cfg = config()
  const wf = cfg.wander ?? {}
  if (wf.enabled !== true) return null

  const st = readState()
  const day = new Date().toLocaleDateString('sv-SE')
  if (st.day !== day) { st.day = day; st.count = 0 }
  // 间隔随 arousal 收缩（2026-11-02 晚）：好奇是真的在催她 ——
  // minGapMin 仍是基线，arousal 越高醒得越勤（最低 60 分钟）；
  // dailyMax 只做护栏（防爆），不再是探索的引擎。探索频率由回报的边际递减决定。
  const max = Number(wf.dailyMax ?? 2)
  if (Number(st.count ?? 0) >= max) return null
  let gapMin = Number(wf.minGapMin ?? 180)
  try {
    const nv = await import('../lib/novelty.mjs')
    const a = nv.assess(Date.now())
    gapMin = Math.max(60, Math.round(gapMin * (1 - Math.min(0.85, a.arousal))))
  } catch (e) { swallow(e, 'tools/commands/wander.mjs:gate') }
  if (st.lastAt && Date.now() - Number(st.lastAt) < gapMin * 60_000) return null

  const idea = await wander()
  if (!idea) return null

  const results = []
  for (const step of idea.steps.slice(0, 3)) {
    if (step.includes('bot.mjs')) {
      try {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const cmd = step.replace(/^["']node["']?\s*/, '').match(/bot\.mjs\s*(.+)/)
        if (cmd) {
          const args = cmd[1].trim().split(/\s+/)
          const { stdout } = await promisify(execFile)('node',
            [BOT_CLI(), ...args],
            { timeout: 120000 })
          results.push({ step, ok: true, out: String(stdout).slice(0, 100) })
        } else {
          results.push({ step, ok: false, out: 'not bot.mjs' })
        }
      } catch (e) { results.push({ step, ok: false, out: String(e.message).slice(0, 80) }) }
    } else {
      results.push({ step, ok: true, out: '(non-command)' })
    }
  }

  try {
    // 10-31 审计：原来是 './memory.mjs'（commands/ 下没有这个文件）—— 自主探索的记忆从没写进去过
    const memory = await import('../lib/memory.mjs')
    memory.remember('web', 'wander', 'self', 'assistant',
      `自主探索：${idea.want}（${idea.reason}）→ ${results.map(r => r.ok ? '✓' : '✗').join('')}`,
      { kind: 'wander' })
  } catch (e) { swallow(e, 'tools/commands/wander.mjs:128') }

  // 探索残余物（三轮抽出可测）：沉淀见过池 / 量惊喜度 / 高惊喜→兴趣养成。见 settleExploration。
  try { await settleExploration(idea, results) } catch (e) { swallow(e, 'tools/commands/wander.mjs:settle') }

  try {
    const { emit } = await import('../brain/event.mjs')
    emit({ proc: 'wander', platform: 'web', chatId: 'wander', userId: 'self', role: 'assistant',
      text: `[自主探索] ${idea.want} → ${results.map(r => r.ok ? '✓' : '✗').join('')}`,
      act: 'action' })
  } catch (e) { swallow(e, 'tools/commands/wander.mjs:135') }

  st.count = Number(st.count ?? 0) + 1
  st.lastAt = Date.now()
  writeState(st)

  return { want: idea.want, reason: idea.reason, results, steps: idea.steps }
}

/**
 * 探索的结算（三轮，从 doWander 抽出来 —— 可测试）：
 *   ① 主题沉淀进新颖检测的见过池 + lastTopic —— 同主题下次脱敏（先验被经历改变）
 *   ② 惊喜度由器官自己量：收获文本的陌生度 = 这次收获有多大（全熟→自然低，失败→0.2）
 *   ③ 高惊喜且做成 → **兴趣养成**：memory.addLore('兴趣') —— 回报改变记忆。
 *      兴趣池的下游全是现成的：聊天 hook「最近挂在心上」/ 写作素材 / 投稿选题 /
 *      feed 候选打分 —— 惊喜大的方向会自然渗进她之后的说话与创作。
 *   频率上限天然安全：wander dailyMax 护栏 × 同主题合并（topicKey）× 池封顶。
 * @returns {{surprise:number, interest:boolean}} 给调用方/测试断言用
 */
export async function settleExploration(idea, results) {
  const out = { surprise: 0, interest: false }
  const nv = await import('../lib/novelty.mjs')
  try {
    const allOk = Array.isArray(results) && results.length > 0 && results.every((r) => r.ok)
    const got = (results || []).map((r) => String(r.out || '')).join(' ')
    out.surprise = allOk ? Math.max(0.1, nv.surpriseOf(got)) : 0.2
    nv.spark(String(idea?.want || '') + ' ' + String(idea?.reason || ''), { source: 'wander', surprise: out.surprise })
    if (allOk && out.surprise >= 0.5) {
      try {
        const memory = await import('../lib/memory.mjs')
        memory.addLore('兴趣', '最近对 ' + String(idea?.want || '').slice(0, 40) + ' 上了心（探索收获很大）')
        out.interest = true
      } catch (e) { swallow(e, 'wander:settle:lore') }
    }
  } catch (e) { swallow(e, 'wander:settle') }
  return out
}

export async function run(args) {
  if (args[0] === 'check') {
    const material = gatherMaterial()
    console.log('念头原材料：')
    material.forEach(m => console.log('  - ' + m))
    return
  }
  const r = await doWander()
  if (!r) { console.log('没产生念头'); return }
  console.log('念头：' + r.want)
  console.log('理由：' + r.reason)
  for (const s of r.results) {
    console.log((s.ok ? '✓' : '✗') + ' ' + s.step.slice(0, 60))
    if (s.out) console.log('  ' + s.out.slice(0, 80))
  }
}
