// tools/lib/body.mjs —— 身体：把心跳的决定接到具体能力上
//
// ══════════════════════════════════════════════════════════════════════
// 为什么单独一个文件
// ══════════════════════════════════════════════════════════════════════
// 这段逻辑本来写在 qq-server 的 run() 末尾，一放进去文件就 1834 行（门禁 1750）。
// 门禁拦得对，而且拦出了正确的边界：
//
//   qq-server 是**一个 IM 通道的实现**（OneBot socket、收发、图片、表情）。
//   "她此刻做什么、做多久、为什么"不属于任何通道 —— 那是**身体**的事。
//
// 把它留在 qq-server 里，等于让"一个通道"拥有"整个人的行为调度权"。
// 这正好是用户要解决的问题的反面：一个灵魂操纵身体，而不是一个通道操纵身体。
//
// 拆出来之后：qq-server 只管收消息和发消息，身体的行为由这里接线。
// 以后加微信/抖音通道，共用同一个 body，不会各自再长一套调度。
import { swallow } from './swallow.mjs'

/**
 * 把 heartbeat 的决定接到具体能力上。
 *
 * @param {object} deps 由调用方注入（它才知道 socket、spawn、log 这些）
 * @param {Function} deps.spawn 启动子进程
 * @param {Function} deps.log
 * @param {Function} deps.logErr
 * @param {Function} deps.checkNapcat
 * @param {Function} deps.pollTasks
 * @param {Function} deps.runDuePromises
 * @param {Function} deps.warmQuoteIndex
 * @param {Function} deps.tryQzone
 * @param {Function} deps.tryProactive
 * @param {Function} deps.tryGroupChat
 * @param {Function} deps.brainTick
 * @param {Function} deps.isBusy    ()=>bool  整理子进程是否在跑
 * @param {Function} deps.setBusy   (bool)=>void
 * @param {Function} deps.feiyuPath ()=>string feiyu.mjs 的绝对路径
 * @param {Function} [deps.queued]  ()=>number 待处理消息数
 */
export async function bindBody(deps) {
  const HB = await import('../brain/organ/heartbeat.mjs')
  const NIGHT = await import('../brain/organ/night.mjs')

  // 把"决定"写进 focus（focus 仍是"她此刻在做什么"的唯一真相）
  const syncFocus = async (activity, d) => {
    try {
      const F = await import('./focus.mjs')
      F.writeFocus({
        activity,
        until: Date.now() + Math.max(5, Number(d?.spanMin || 30)) * 60_000,
        why: d?.why || '',
      })
    } catch (e) { swallow(e, 'body:syncFocus') }
  }

  HB.bind({
    // ── 体征：身体自己在跑的部分（不进决策）────────────────────
    vitals: {
      napcat: () => { try { deps.checkNapcat() } catch (e) { swallow(e, 'body:napcat') } },
      tasks: () => { try { void deps.pollTasks() } catch (e) { swallow(e, 'body:tasks') } },
      promises: () => { try { void deps.runDuePromises('tick') } catch (e) { swallow(e, 'body:promises') } },
      quotes: () => { try { void deps.warmQuoteIndex(40) } catch (e) { swallow(e, 'body:quotes') } },
      qzone: () => { try { void deps.tryQzone() } catch (e) { swallow(e, 'body:qzone') } },
      brain: () => { try { deps.brainTick() } catch (e) { swallow(e, 'body:brain') } },
    },

    // ── 自主行动：只有被 decide() 选中才执行 ─────────────────────
    sleep: async (d) => {
      if (deps.isBusy()) return
      deps.setBusy(true)
      try {
        deps.log('[body] 😴 ' + d.why + ' → 入睡')
        // 生理：开始分期（深睡/REM/还债）
        NIGHT.beginSleep({ reason: d.why, backlog: 0 })
        // 维护：整理/三审/归档，交给子进程（不钉住事件循环）
        const p = deps.spawn(process.execPath,
          [deps.feiyuPath(), 'sleep', '--force'],
          { detached: true, stdio: 'ignore', windowsHide: true })
        p.on('exit', () => deps.setBusy(false))
        p.on('error', () => deps.setBusy(false))
        p.unref()
      } catch (e) { deps.setBusy(false); swallow(e, 'body:sleep') }
    },

    reply: async () => {
      try { await deps.tryProactive() } catch (e) { swallow(e, 'body:reply:proactive') }
      try { await deps.tryGroupChat() } catch (e) { swallow(e, 'body:reply:group') }
    },

    consolidate: async () => {
      if (deps.isBusy()) return
      deps.setBusy(true)
      try {
        const p = deps.spawn(process.execPath,
          [deps.feiyuPath(), 'brain', 'consolidate'],
          { detached: true, stdio: 'ignore', windowsHide: true })
        p.on('exit', () => deps.setBusy(false))
        p.on('error', () => deps.setBusy(false))
        p.unref()
      } catch (e) { deps.setBusy(false); swallow(e, 'body:consolidate') }
    },

    watch: async (d) => { await syncFocus('bilibili', d) },
    browse: async (d) => { await syncFocus('web', d) },
    rest: async (d) => { await syncFocus('rest', d) },
    // 这两件还没做实（写东西/想事情）。留空而不是假装做了 ——
    // 写一个假的执行器比不写更糟：它会让她"决定写东西"然后什么都没发生，
    // 而她下次还会决定写东西，日志里看起来一切正常。
    write: async () => { },
    think: async () => { },
  })

  // 心跳读"有没有打断"：私聊有未处理消息 / 群里有 @
  HB.pendingInterrupt = () => { try { return Number(deps.queued?.() || 0) > 0 } catch { return false } }
  HB.interruptUrgency = () => 1.0

  HB.start({ log: deps.log })
  return HB.status()
}
