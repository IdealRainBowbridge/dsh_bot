// selfmod-cmd —— 老爸在 QQ 里下的自我改动指令（2026-11-02）
//
// 指令词是**固定短语**，不交给模型判断 —— 批准自己改自己这种事，不能让"可能被上下文影响的模型"
// 来裁定。这里只做字符串匹配，匹配到了就执行，匹配不到返回 null（走正常聊天）。
//
//   「改吧 / 批准 / 可以 / 动手」→ 批准并落地最近一条待批
//   「不改 / 别改 / 算了 / 驳回」→ 作废最近一条
//   「回滚」                     → 撤销上一次已落地的改动
//   「待批 / 想改什么 / 改动清单」→ 念一遍清单
import * as SM from './selfmod.mjs'

/** 只认这些——多一个字都不行，避免"改吧改吧"这种闲聊误触。 */
const APPROVE = /^(改吧|批准|可以改|动手吧|准了|同意)[。!！~～]?$/
const REJECT = /^(不改|别改|不行|算了|驳回|取消)[。!！~～]?$/
const ROLLBACK = /^(回滚|撤销|改回去|还原)[。!！~～]?$/
const LIST = /^(待批|想改什么|改动清单|有什么要改)[。?？]?$/
// 「详细/怎么改/具体」—— 老爸要看改动的详细方案（2026-11-02）
const DETAIL = /^(详细|详细说|怎么改|具体怎么改|具体点|展开说|详细描述)[。?？]?$/
// 「重启」—— 改完生效需要重启（2026-11-02）。重启会让 QQ 断几秒，所以必须老爸点头。
const RESTART = /^(重启|重开|重载|restart)[。!！~～]?$/

/**
 * @param {string} text 老爸说的话（已 trim）
 * @returns {Promise<{reply:string, log:string}|null>} null = 不是指令，走正常聊天
 */
export async function selfmodCmd(text) {
  const t = String(text || '').trim()
  if (!t) return null

  if (APPROVE.test(t)) {
    const a = SM.approve()
    if (!a.ok) return { reply: `（没有待批的改动）`, log: 'approve: none pending' }
    const r = SM.apply(a.id)
    if (!r.ok) {
      return {
        reply: r.rolledBack
          ? `改 ${a.file} 失败了，已经自动还原，没留下半成品。\n原因：${String(r.reason).slice(0, 200)}`
          : `改 ${a.file} 没成：${String(r.reason).slice(0, 200)}`,
        log: `apply fail ${a.id}`,
      }
    }
    return {
      reply:
        `改好了：${a.file}\n` +
        `语法 ✓  门禁 ✓  备份 ${r.backup ? r.backup.split('/').pop() : '有'}\n` +
        `**要重启才生效** —— 你说一声「重启」我就重启（我不自己动，怕你正说话）。\n` +
        `${Math.random() < 0.5 ? '要不要现在重开？(・_・;)' : '反正急不来，你说了算'}`,
      log: `apply ok ${a.id}`,
    }
  }

  if (REJECT.test(t)) {
    const r = SM.reject()
    return { reply: r.ok ? `行，不改了。${r.id} 作废。` : '（没有待批的改动）', log: 'reject' }
  }

  if (ROLLBACK.test(t)) {
    const r = SM.rollback()
    if (!r.ok) return { reply: `没得回滚：${r.reason}`, log: 'rollback fail' }
    return { reply: `已经还原 ${r.file}。要重启才生效。`, log: `rollback ${r.id}` }
  }

  if (RESTART.test(t)) {
    // 重启 = 杀掉 qq-server，im-gateway 的 while 会立刻拉起来。
    // 只重启聊天这一层（不动 DSH 容器），断线时间最短。
    // 真正的重启由 qq-server 主循环执行（这里只返回标记）。
    return { reply: '__RESTART__', log: 'restart requested' }
}

  if (DETAIL.test(t)) {
    const list = SM.listPending()
    if (!list.length) return { reply: '现在没有待批的改动。想改什么直接说，我先提案。', log: 'detail: none' }
    // 默认讲第一条；有多条时提示
    const p = SM.plan(list[0].id)
    if (!p.ok) return { reply: `说不清：${p.reason}`, log: 'detail fail' }
    const L = []
    L.push(`【${p.id}】${p.file}`)
    L.push(`为什么：${p.why}`)
    L.push('')
    L.push(`改动位置：第 ${p.atLine} 行起`)
    L.push(`规模：删 ${p.removedLines} 行，加 ${p.addedLines} 行（共 ${p.totalBefore} → ${p.totalAfter} 行）`)
    if (p.removed.length) {
      L.push('')
      L.push('要去掉的：')
      for (const l of p.removed.slice(0, 8)) L.push('  − ' + String(l).slice(0, 90))
      if (p.removed.length > 8) L.push(`  …还有 ${p.removed.length - 8} 行`)
    }
    if (p.added.length) {
      L.push('')
      L.push('要换成的：')
      for (const l of p.added.slice(0, 8)) L.push('  + ' + String(l).slice(0, 90))
      if (p.added.length > 8) L.push(`  …还有 ${p.added.length - 8} 行`)
    }
    if (p.importers.length) {
      L.push('')
      L.push('会波及其他文件：' + p.importers.join('、'))
    } else {
      L.push('')
      L.push('没有别的文件引用它，影响面只在这个文件。')
    }
    if (list.length > 1) L.push(`\n（还有 ${list.length - 1} 条待批）`)
    L.push('')
    L.push('满意就回「改吧」，不满意回「不改」或直接说要怎么调整。')
    return { reply: L.join('\n'), log: `detail ${p.id}` }
  }

  if (LIST.test(t)) {
    const list = SM.listPending()
    if (!list.length) return { reply: '现在没有待批的改动。', log: 'list empty' }
    const body = list.slice(0, 5).map((x, i) => `${i + 1}. 【${x.id}】${x.file}\n   ${String(x.why).slice(0, 80)}`).join('\n')
    return { reply: `待批 ${list.length} 条：\n${body}\n\n回「改吧」批第一条，回「不改」驳回。`, log: `list ${list.length}` }
  }

  return null
}
