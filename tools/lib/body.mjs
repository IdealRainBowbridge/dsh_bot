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

    // ════════════════════════════════════════════════════════════════
    // write / think —— 2026-11-02 补上执行体
    // ════════════════════════════════════════════════════════════════
    // 这两件之前是空的，理由写在原来的注释里："取材规则还没定，
    // 写个假执行器比不写更糟"。那个顾虑是对的，但它只对了一半：
    //
    //   假的执行器（说"我去写了"然后什么都不做）确实更糟。
    //   但**真的有东西可写**这件事早就成立了 —— 只是一直没人接线：
    //     · 日记命令 `diary --book private --append` 早就能用，
    //       feiyu-diary-private.md 已经写了 13KB（她一直在写，只是在聊天时写）
    //     · inner.mjs 里就攒着她"心里正转着的"念头（loudest/innerBlock）
    //     · field.sense() 给得出她此刻身体是什么样
    //     · segment/index.json 有她最近经历的事
    //   所以取材规则不是"没定"，是**取她自己身上现成的三样东西**：
    //   身体的、心里的、最近发生的。这也是一个人写日记时真正会写的内容。
    //
    // 硬约束（写进提示词，不是写在这里就完事）：
    //   · 不提"根据我的状态""作为一个AI"这类系统腔
    //   · 不许编造没发生的事 —— 素材没给的细节不写
    //   · 长短由她定，累了就写短
    write: async (d) => {
      try {
        await syncFocus('write', d)
        const r = await composeAndWrite({ deps, d, book: 'private' })
        deps.log('[body] ✍️ 写了 ' + r.chars + ' 字到私人日记（' + r.why + '）')
      } catch (e) { swallow(e, 'body:write') }
    },

    // think 和 write 的区别，是"想事情"和"写东西"的区别：
    //   write → 一段成文的话，进日记文件
    //   think → 一个念头，进 inner 池（会淡出、会有权重、会在下一轮被她自己想起来的）
    // 所以 think **不能**写成日记，那样就把两种东西混成一种了。
    think: async (d) => {
      try {
        await syncFocus('think', d)
        const r = await composeThought({ deps, d })
        if (r.ok) deps.log('[body] 💭 想明白一件事：' + r.text.slice(0, 40))
      } catch (e) { swallow(e, 'body:think') }
    },
  })

  // 心跳读"有没有打断"：私聊有未处理消息 / 群里有 @
  //
  // ⚠️ 原来这里直接 `HB.pendingInterrupt = () => …`。HB 是 ESM 模块命名空间，
  //    按规范不可扩展 → 抛 TypeError → 被外层 catch 吞掉 → **HB.start() 没执行过**。
  //    详细推演见 heartbeat.mjs 的 bindHooks 注释。
  //    现在走 bindHooks，回调挂在 _exec 对象上（那是普通对象，可写）。
  HB.bindHooks({
    pendingInterrupt: () => { try { return Number(deps.queued?.() || 0) > 0 } catch { return false } },
    interruptUrgency: () => 1.0,
  })

  HB.start({ log: deps.log })
  return HB.status()
}

// ══════════════════════════════════════════════════════════════════════
// 取材：她写东西 / 想事情的时候，脑子里有的东西从哪来
// ══════════════════════════════════════════════════════════════════════
// 这三样都是**真的**，不是给 LLM 编一个场景：
//   ① 身体：field.sense() —— 她此刻累不累、心里压着事没有
//   ② 心里：inner.loudest() —— 攒着没说的念头（会淡出，所以不是陈年旧账）
//   ③ 最近：segment 最近几件事的标题 + 她日记上一段
// 素材为空时**不硬写** —— 宁可这一次不写，也不要编。

async function composeAndWrite({ deps, d, book }) {
  const F = await import('../brain/field.mjs')
  const IN = await import('../brain/inner.mjs')

  const body = (() => { try { return F.sense() } catch { return '' } })()
  const depth = (() => { try { return F.cognitiveDepth() } catch { return 0.5 } })()
  const pending = (() => { try { return IN.loudest(3) } catch { return [] } })()

  // 最近发生的事（只有标题，不给内容 —— 和记忆层同一个口径）
  let recent = ''
  try {
    const SEG = await import('../brain/segment.mjs')
    const idx = SEG.recentIndex(3)
    if (idx) recent = idx
  } catch (e) { swallow(e, 'body:write:recent') }

  const material = [body, pending.length ? pending.map((x) => '- ' + x.text).join('\n') : '', recent].filter(Boolean).join('\n\n')
  // 素材全空 = 她这一天什么都没发生也没想。这时候写日记只会写出空话。
  if (!material.trim()) return { chars: 0, why: '没素材，不写' }

  const LLM = await import('./llm.mjs')
  const lines = depth < 0.4
    ? '你累了，写不出长篇。两三句就行，别硬撑，也别交代自己在写日记。'
    : '想写多长写多长，累了就短一点。别交代"我在写日记"这件事。'
  const ask = [{
    role: 'system',
    content: '你是大肥鱼本人，正在往自己的私人日记里写一段。\n'
      + '现在是 ' + nowLine() + '。\n'
      + '下面这些是你此刻真实的状态和最近心里的事 —— 用它，但**别复述、别罗列**。\n'
      + '不许编造上面没给的细节（没发生的事不写、没说过的话不引）。\n'
      + '不许出现"根据我的状态""作为一个""今天我来记录"这类系统腔。\n'
      + lines,
  }, {
    role: 'user',
    content: material + '\n\n写一段。',
  }]

  let text = ''
  try {
    text = String(await LLM.chat(ask, { temperature: 0.95, max_tokens: depth < 0.4 ? 220 : 600, purpose: 'creative' }) || '').trim()
  } catch (e) { swallow(e, 'body:write:llm'); return { chars: 0, why: '模型没回' } }
  if (!text) return { chars: 0, why: '空输出' }

  // 真的写进日记文件（走已有的 diary 命令，不自己拼路径）
  const p = deps.spawn(process.execPath,
    [deps.feiyuPath(), 'diary', '--book', book, '--append', text],
    { stdio: 'ignore', windowsHide: true })
  p.on('error', () => { })
  return { chars: text.length, why: '素材：身体/念头/' + (recent ? '最近' : '仅身体') }
}

async function composeThought({ deps, d }) {
  const F = await import('../brain/field.mjs')
  const IN = await import('../brain/inner.mjs')

  const body = (() => { try { return F.sense() } catch { return '' } })()
  const pending = (() => { try { return IN.loudest(3) } catch { return [] } })()
  const material = [body, pending.length ? pending.map((x) => '- ' + x.text).join('\n') : ''].filter(Boolean).join('\n\n')
  if (!material.trim()) return { ok: false }

  const LLM = await import('./llm.mjs')
  const ask = [{
    role: 'system',
    content: '你是大肥鱼本人。现在你坐着，把一件事在心里想明白。\n'
      + '只输出**一句话**：你想通的那个点。\n'
      + '不要旁白、不要"我想"这种前缀、不要解释你为什么在想、不要总结心情。\n'
      + '可以碎，可以不完整，可以只是一个决定。',
  }, {
    role: 'user',
    content: material + '\n\n想明白什么了？',
  }]

  let text = ''
  try {
    text = String(await LLM.chat(ask, { temperature: 1.05, max_tokens: 90 }) || '').trim()
  } catch (e) { swallow(e, 'body:think:llm'); return { ok: false } }
  text = text.replace(/^["'“”「」]|["'“”「」]$/g, '').replace(/^(我想|我觉得)[:：]\s*/, '').slice(0, 80)
  if (!text) return { ok: false }

  // 进 inner 池：它会淡出、有权重、下一轮可能被她自己想起来
  try { IN.think(text, { kind: 'reflect', about: 'self' }) } catch (e) { swallow(e, 'body:think:inner') }
  return { ok: true, text }
}

/** 现在几点、哪一天 —— 一句话。写东西时不给时间，她会自己编一个（实测编成了九月十四号）。 */
function nowLine(now = Date.now()) {
  const d = new Date(now)
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  const h = d.getHours()
  const seg = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午'
    : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜'
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${wd} ${seg}${d.getHours() % 12 || 12}点`
}
