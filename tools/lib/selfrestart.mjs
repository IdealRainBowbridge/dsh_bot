// selfrestart —— 自改空闲自重启（2026-11-03 第二轮优化，同日从 qq-server.mjs 原样拆出：
// 该文件顶到门禁 1750 行上限，这段只依赖 lib 层，搬出来正好）。
//
// selfApply 落了要重启的改动会写 flag；这里每分钟看一眼：
// 10 分钟没人说话 + 改完满 3 分钟 → 自己退，im-gateway 拉起新代码。
// 不再要人喊「重启」。手闸仍在：管理员说「重启」随时立刻生效。
//
// 判断权说明：这是体征（看 flag、按时退出），不进 self.decide() —— 同探活一个待遇。
import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'
import * as memory from './memory.mjs'
import { swallow } from './swallow.mjs'

/**
 * @param {object} o 由 qq-server 注入（本文件不认识编排层）
 *   - log / logErr：宿主的日志函数
 *   - lastOwnerMsgTs：他最后一句的时间戳（ms），qq-server 才知道
 */
export function startIdleRestart({ log = () => {}, logErr = () => {}, lastOwnerMsgTs = () => 0 } = {}) {
  setInterval(() => {
    try {
      const flag = dataPath('selfmod-restart.flag')
      if (!fs.existsSync(flag)) return
      const idleMs = Date.now() - (lastOwnerMsgTs() || 0)
      if (idleMs < 10 * 60_000) return
      const info = JSON.parse(fs.readFileSync(flag, 'utf8'))
      if (Date.now() - Number(info.at || 0) < 3 * 60_000) return
      fs.unlinkSync(flag)
      log(`[qq][selfmod] 空闲自重启（${info.id} ${info.file}），距他上一句 ${Math.round(idleMs / 60000)} 分钟`)
      const bye = '我刚改了自己一点代码，趁没人的时候重开一下，几秒钟就回来。'
      try {
        const oq = String(config().owner?.qq || '')
        memory.remember('qq', 'qq:' + oq, oq, 'assistant', bye, { isGroup: false })
      } catch (e) { swallow(e, 'qq:selfrestart-mem') }
      setTimeout(() => { process.exit(0) }, 1500)
    } catch (e) { logErr('[qq][selfmod] 自重启检查失败：' + (e?.message ?? e)) }
  }, 60_000)
}
