// selfmod-cmd —— 管理员在 QQ 里下的自改指令（2026-11-03 更新：审批撤了）
//
// 2026-11-03 口径（笨蛋管理员定的）：**她完全自主，审批不搞了**。
// 这里的「批准/驳回/详细/清单」全部退役；只剩两个**管理员手闸**：
//   「回滚」 → 撤销她上一次落地的改动
//   「重启」 → 重启生效（QQ 会断几秒，所以仍由管理员发）
// 自改怎么发生：她自己 `selfmod propose` → `selfmod selfApply`（免审批落地，
// 备份→写→语法→门禁，失败自动还原），不需要经过这个通道。
import * as SM from './selfmod.mjs'

/** 只认这些——多一个字都不行，避免闲聊误触。 */
const ROLLBACK = /^(回滚|撤销|改回去|还原)[。!！~～]?$/s
// 「重启」—— 重启会让 QQ 断几秒，所以仍由管理员点头（2026-11-03 保留）。
const RESTART = /^(重启|重开|重载|restart)[。!！~～]?$/s

/**
 * @param {string} text 管理员说的话（已 trim）
 * @returns {Promise<{reply:string, log:string}|null>} null = 不是指令，走正常聊天
 */
export async function selfmodCmd(text) {
  const t = String(text || '').trim()
  if (!t) return null

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

  return null
}
