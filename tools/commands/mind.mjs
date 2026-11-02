// mind —— 统一自主规划：她自己决定「接下来做什么」。
//
//   node bot.mjs mind            看当前计划和上下文（只读）
//   node bot.mjs mind now        立刻重新规划一次（改变主意是她的权利）
//   node bot.mjs mind history    看她做过的计划流水
//
// 和 focus 的分工：focus 是「她现在在干什么」的事实记录；
// mind 是「她怎么决定的那件事」的决策层。planner 决定后会写进 focus。
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import { dataPath } from '../lib/paths.mjs'
import { labelOf } from '../lib/focus.mjs'

const HIST = () => dataPath('mind-history.jsonl')

function appendHistory(obj) {
  try { fs.appendFileSync(HIST(), JSON.stringify(obj) + '\n') } catch {}
}

export async function run(argv = []) {
  const sub = String(argv[0] || 'show')
  const cfg = config()
  const M = await import('../lib/mind.mjs')

  if (sub === 'show' || sub === '') {
    const pcfg = cfg.mind || {}
    console.log(`\n🧠 统一自主规划：${pcfg.enabled ? '已启用' : '未启用（config.mind.enabled = false）'}`)
    console.log(`   节流：计划剩 > ${pcfg.replanBelowMin ?? 5} 分钟就不重规划\n`)
    const s = M.planSnapshot()
    if (!s.plan) {
      console.log('   （还没有计划 —— 她还没做过一次规划）')
    } else {
      const ago = Math.round((Date.now() - Number(s.plan.at || 0)) / 60_000)
      console.log(`   现在：${s.label}${s.expired ? '（已到点）' : `（还剩 ${s.remainMin} 分钟）`}`)
      console.log(`   理由：${s.why || '（没说）'}`)
      console.log(`   ${ago} 分钟前定的，当时时长 ${s.plan.min} 分钟`)
      if (s.plan.context) console.log(`   决策时：${s.plan.context.hour}点 · 情绪 ${s.plan.context.mood} · 主人静默 ${s.plan.context.quietMin ?? '?'} 分钟 · 欠着 ${s.plan.context.promises} 件事`)
    }
    return
  }

  if (sub === 'now') {
    console.log('🧠 重新规划中（她在重新想「接下来做什么」）…')
    const r = await M.plan({ force: true })
    if (!r) { console.log('✗ 没规划出来（LLM 没给结果，或 mind.enabled 关着）'); return }
    console.log(`\n→ 决定了：${labelOf(r.activity)} · ${r.min} 分钟`)
    console.log(`  理由：${r.why || '（没说）'}`)
    return
  }

  if (sub === 'history') {
    let rows = []
    try {
      rows = fs.readFileSync(HIST(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {}
    if (!rows.length) { console.log('还没有计划流水'); return }
    console.log('\n最近 15 次规划：')
    for (const r of rows.slice(-15)) {
      const t = new Date(Number(r.at || 0)).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)
      console.log(`  ${t}  ${labelOf(r.activity)} ${r.min}分钟 —— ${String(r.why || '').slice(0, 40)}`)
    }
    return
  }

  console.log('用法：mind（看当前）| mind now（立刻重规划）| mind history（流水）')
}

// planner 每轮定完计划后记一笔流水（被 qq-server / 宿主调用）
export function recordPlan(r) {
  if (!r || !r.activity) return
  appendHistory({ at: Date.now(), activity: r.activity, min: r.min, why: r.why })
}
