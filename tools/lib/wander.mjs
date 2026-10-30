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
import { dataPath } from '../lib/paths.mjs'
import { readJsonl } from '../brain/json.mjs'

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
    const lore = JSON.parse(fs.readFileSync(dataPath('feiyu-ai/lore.json'), 'utf8'))
    for (const l of (lore || []).slice(-8)) {
      if (/想|试试|该|值得|好奇/.test(l.text)) out.push(l.text.slice(0, 60))
    }
  } catch {}
  try {
    const st = JSON.parse(fs.readFileSync(dataPath('sleep-state.json'), 'utf8'))
    const opt = (st.lastSleep?.phases || []).find(p => p.name === '优化')
    if (opt?.result?.problems > 0) out.push('睡眠审查发现：' + opt.result.note.slice(0, 60))
  } catch {}
  try {
    const pr = JSON.parse(fs.readFileSync(dataPath('promises.json'), 'utf8'))
    const due = (pr || []).filter(p => p.state === 'pending' && Date.now() > Number(p.dueAt || 0))
    for (const p of due.slice(0, 2)) out.push('答应过的：' + p.text)
  } catch {}
  try {
    const eps = readJsonl(dataPath('feiyu-ai/episodes.jsonl'), { limit: 30 })
      .filter(e => Date.now() - Number(e.ts || 0) < 24 * 3600_000 && /值得|有趣|好奇|想/.test(e.summary || ''))
    for (const e of eps.slice(0, 3)) out.push(e.summary.slice(0, 60))
  } catch {}
  return out
}

export async function wander() {
  const cfg = config()
  const material = gatherMaterial()
  const llm = await import('../lib/llm.mjs')

  const sys = [
    '你是大肥鱼，一只鲸鱼娘AI，住在笨蛋老爹的电脑里。你有很多能力（看B站视频/上网/写日记/做表情包/发动态/写代码）。现在没人给你指令——你自己想想：接下来想做什么？',
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
  ], { temperature: 1.0, max_tokens: 300, timeoutMs: 30000 })

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
  const max = Number(wf.dailyMax ?? 2)
  if (Number(st.count ?? 0) >= max) return null
  if (st.lastAt && Date.now() - Number(st.lastAt) < Number(wf.minGapMin ?? 180) * 60_000) return null

  const idea = await wander()
  if (!idea) return null

  const results = []
  for (const step of idea.steps.slice(0, 3)) {
    if (step.includes('feiyu.mjs')) {
      try {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const cmd = step.replace(/^["']node["']?\s*/, '').match(/feiyu\.mjs\s*(.+)/)
        if (cmd) {
          const args = cmd[1].trim().split(/\s+/)
          const { stdout } = await promisify(execFile)('node',
            ['/home/feiyu/plugins/dsh-feiyu/tools/feiyu.mjs', ...args],
            { timeout: 120000 })
          results.push({ step, ok: true, out: String(stdout).slice(0, 100) })
        } else {
          results.push({ step, ok: false, out: 'not feiyu.mjs' })
        }
      } catch (e) { results.push({ step, ok: false, out: String(e.message).slice(0, 80) }) }
    } else {
      results.push({ step, ok: true, out: '(non-command)' })
    }
  }

  try {
    const memory = await import('./memory.mjs')
    memory.remember('web', 'wander', 'self', 'assistant',
      `自主探索：${idea.want}（${idea.reason}）→ ${results.map(r => r.ok ? '✓' : '✗').join('')}`,
      { kind: 'wander' })
  } catch {}

  try {
    const { emit } = await import('../brain/event.mjs')
    emit({ proc: 'wander', platform: 'web', chatId: 'wander', userId: 'self', role: 'assistant',
      text: `[自主探索] ${idea.want} → ${results.map(r => r.ok ? '✓' : '✗').join('')}`,
      act: 'action' })
  } catch {}

  st.count = Number(st.count ?? 0) + 1
  st.lastAt = Date.now()
  writeState(st)

  return { want: idea.want, reason: idea.reason, results, steps: idea.steps }
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
