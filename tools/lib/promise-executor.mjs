// promise-executor —— 到期承诺的独立执行器（v5 从 qq-server 抽出，逻辑一字不改）。
//
// 为什么要独立成模块：
//   ① qq-server 是 1700+ 行的主闭包，这一段是**自洽的**（只依赖 runCliAsync / 日志），
//      抽出来能单测，也能让 qq-server 回到护栏以内；
//   ② 它的行为很容易被无意改坏（"说了去看却没去"是用户抓过两次的病根），
//      独立模块 + 独立测试之后，改它必须先过测试；
//   ③ 以后换执行器（promises 账本 / brain intents）时，只动这一个文件。
//
// 设计约束（保持原样，别在重构里"顺手优化"）：
//   · 独立 tick（60s），不掷骰子、不占主动搭话配额
//   · 一次最多处理 3 条，按 dueAt 从老到新
//   · 认不出作品名就照实说做不到，绝不乱搜一条充数
//   · binge 自己会结账；只有脑的意图账本需要这里结算（有证据才算 done）
import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'
import * as promises from './promises.mjs'
import * as brain from '../brain/index.mjs'

/** 承诺执行结果文件（tryProactive 也要读它来当"我真干了什么"的由头）。 */
export const promiseOutcomePath = () => dataPath('promise-outcome.json')

/**
 * 造一个执行器。
 * @param {{runCliAsync:Function, log:Function, logErr:Function}} deps
 */
export function createPromiseExecutor(deps) {
  const PROMISE_OUT = promiseOutcomePath
  // ── 到期承诺的独立执行器（10-28）────────────────────────────────────
  // 用户第二次抓的病根："说了去看可塑性记忆，实际一直没行动"。
  // 这次不是"她不想做"，是三层结构性毛病：
  //   ① 执行原先挂在主动搭话链里（12% 掷骰子 + 日上限 + 最小间隔 + 沉默时长 + 启动宽限）→ 到点也大概率不执行；
  //   ② 机器一睡（实测 01:07 睡 → 08:02 醒）就整夜没人；醒来先补做最老那条**认错作品**的承诺，正主还在排队；
  //   ③ 就算执行过，`--ep 1` 写死 → 永远重看第 1 集，seen 停在 [1]（账本里连着三条都是第 1 集）。
  // 修法：独立 tick（60s，不掷骰子、不占搭话配额）+ 一次最多处理 3 条 + 认作品名（笼统词落到"最近在追的那部"）
  // + 交给 binge 的 `--ep next` 续看下一集。
  let promiseRunning = false

  // 11-01（S4）：执行者可以从旧账本换成脑的意图账本（config.brain.executor='intents'）。
  // 换过去以后：认领走 intents 的租约（fencing，防双开），结算必须有证据；旧账本退成只读历史。
  // 两条账本**只走一条**，绝不双写 —— 否则"做完了"会有两份口径。

  /** 执行完一条怎么记账。 */
  function finishJob(job, ok, why) {
    if (!job?.brainId) return ok ? promises.done(job.id, why) : promises.fail(job.id, why)
    if (ok) {
      return brain.intents.settle(job.brainId, {
        ok: true,
        evidence: [`promise-outcome:${job.id}`, String(why || '').slice(0, 120)],
        reason: String(why || '').slice(0, 120),
      })
    }
    return brain.intents.settle(job.brainId, { ok: false, reason: String(why || '没做成') })
  }

  function deferJob(job, mins, why) {
    if (!job?.brainId) return promises.defer(job.id, mins, why)
    return brain.intents.defer(job.brainId, mins, why)
  }

  /** 该执行的活：默认旧账本；换成 intents 后由脑说了算（拿不到租约就跳过）。 */
  function dueJobs() {
    const useIntents = String(config().brain?.executor || 'promises') === 'intents'
    if (!useIntents) return promises.dueNow().map((x) => ({ ...x, brainId: '' }))
    const out = []
    for (const x of brain.intents.executable()) {
      const lease = brain.intents.lease(x.id, `qq-server:${process.pid}`, { leaseMs: 15 * 60_000 })
      if (!lease.ok) continue
      out.push({
        id: x.id, brainId: x.id, what: String(x.object || ''), text: String(x.lastWhy || ''),
        kind: String(x.verify || ''), dueAt: Number(x.dueAt || 0), fencing: lease.fencing,
      })
    }
    return out
  }

  /** 从承诺文本里认出"到底是哪部"。认不出返回 ''（宁可照实说不知道，也不许乱搜一条充数）。 */
  function resolveShow(what, text = '') {
    const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
    const w = clean(what)
    const all = (() => {
      try {
        const dir = dataPath('binge')
        return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
          .map((f) => { try { return JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { return null } })
          .filter(Boolean)
      } catch { return [] }
    })()
    const byShow = (n) => all.find((b) => clean(b.show) === clean(n))
    // ① 她说的名字本身就在追番账本里 —— 最可靠
    if (w && byShow(w)) return clean(byShow(w).show)
    // ② 正文里的《…》且在账本里
    const inBook = /《([^》]{1,24})》/.exec(clean(text)) || /《([^》]{1,24})》/.exec(w)
    if (inBook && byShow(inBook[1])) return clean(byShow(inBook[1]).show)
    // ③ 笼统词（番/剧/动画…）→ 最近真在追的那部（要排除账本里混进的整句，那是解析错的产物）
    if (/^(?:番|番剧|剧|动画|动漫|番组|追番|那个|这部|那部|它)$/.test(w)) {
      const looksTitle = (s) => {
        const t = clean(s)
        return t.length >= 2 && t.length <= 20 && !/[\s，,。！!？?、；;：:（）()「」“”"]/.test(t)
      }
      const recent = all.filter((b) => looksTitle(b.show) && (b.seen?.length || 0) > 0)
        .sort((a, b) => (b.log?.at?.(-1)?.at || 0) - (a.log?.at?.(-1)?.at || 0))[0]
      return recent ? clean(recent.show) : ''
    }
    // ④ 正文里有《…》但不在账本里 → 新番，交给 binge 自己搜
    if (inBook) return clean(inBook[1])
    // ⑤ 只有"像作品名"的干净短词才认（"嗯，我承认，三次了…"这种整句直接不认）
    if (/^[\u4e00-\u9fa5A-Za-z0-9·・]{2,16}$/.test(w) && !/^(?:这个|那个|什么|怎么|真的|就是)$/.test(w)) return w
    return ''
  }

  /** 到点就真去做 —— 不看搭话配额、不掷骰子。一次最多 3 条。 */
  async function runDuePromises(reason = 'tick') {
    if (promiseRunning) return
    promiseRunning = true
    try {
      const due = dueJobs().sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
      if (!due.length) return
      if (reason === '醒来补做') deps.log(`[qq] ⏰ 醒来补做 ${due.length} 条到点承诺（夜里机器睡了）`)
      for (const job of due.slice(0, 3)) {
        const what = String(job.what || '')
        const text = String(job.text || '')
        const wantsWatch = /看|追|番|剧/.test(what + text + String(job.kind || ''))
        const shown = resolveShow(what, text)
        if (!wantsWatch) {
          finishJob(job, false, '这条我没有能执行的动作')
          deps.log(`[qq] ✗ 承诺做不了：${what || text}（没有对应的执行动作）`)
          continue
        }
        if (!shown) {
          // "行，看完就回来讲" / "看完了再开口" 这类没点名的承诺：只要 12 小时内已经真看完过一部，
          // 就算并账做掉了 —— 她欠的是"去看番"，不是"再说一遍这句空话"。
          const recentDone = promises.list('done')
            .filter((x) => Date.now() - Number(x.doneAt || 0) < 12 * 3600_000 && /^看完了/.test(String(x.why || '')))
            .sort((a, b) => Number(b.doneAt) - Number(a.doneAt))[0]
          if (wantsWatch && recentDone) {
            finishJob(job, true, `并到「${recentDone.what}」那条看番承诺了 —— ${recentDone.why}`)
            deps.log(`[qq] ✓ 承诺并账：${what || text} → ${recentDone.what}`)
            continue
          }
          finishJob(job, false, '不知道是哪部作品（她答应时没把名字说清）')
          deps.log(`[qq] ✗ 承诺做不了：${what || text}（认不出作品名）`)
          continue
        }
        deps.log(`[qq] 📌 到期承诺（${reason}）：${shown}（${job.id}）→ 真去看`)
        // 看几集也从她自己的话里读（顺序要紧：她说"看到第 6 集"是**看到那儿**，不是"再看 6 集"）：
        //   "看到第 6 集" → --to 6；"连看三集" → --count 3；"这部看完/一口气刷完" → --count all；
        //   没说过就一集 —— 她没许这个愿，别替她加码。节奏归她，不归配置。
        const said = `${what} ${text}`
        const toEp = Number((said.match(/第\s*(\d{1,3})\s*[集话]/) || [])[1] || 0)
        const numWord = (said.match(/([一二三四五六七八九十两\d]+)\s*集/) || [])[1] || ''
        const CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
        const extra = []
        let count = '1'
        if (toEp) extra.push('--to', String(toEp))
        else if (numWord) count = String(CN[numWord] ?? (Number(numWord) || 1))
        else if (/全(?:集|部)|整部|这部|一口气|刷完|看完它|看完这部|都看完|看到底/.test(said)) count = 'all'
        if (!toEp) extra.push('--count', count)
        const budget = Math.max(240000, (count === 'all' || toEp ? 13 : Number(count) || 1) * 180000)
        let r = ''
        try { r = await deps.runCliAsync(['binge', '--show', shown, '--ep', 'next', ...extra, '--go', '--json', '--promise', job.id], budget) } catch (e) {
          deps.logErr('[promise] binge 起不来：' + (e?.message ?? e))
        }
        let rec = null
        try {
          const raw = String(r || '')
          const j = JSON.parse(raw.slice(raw.indexOf('{')).trim() || '{}')
          rec = {
            at: Date.now(), id: job.id, show: shown, ok: !!j.ok,
            title: String(j.title || ''), ep: Number(j.ep || 0),
            watched: Math.max(1, Number(j.watched || 1)),
            epFirst: Number(j.episodes?.[0]?.ep || j.ep || 0),
            epLast: Number(j.episodes?.filter((x) => x?.ok).at(-1)?.ep || j.ep || 0),
            plot: String(j.plot || '').slice(0, 400), feel: String(j.feel || '').slice(0, 200),
            via: String(j.via || '').slice(0, 120), used: false,
          }
          fs.writeFileSync(PROMISE_OUT(), JSON.stringify(rec, null, 1) + '\n')
          deps.log(rec.ok
            ? `[qq] ✓ 真看完了《${rec.title}》${rec.watched > 1 ? `第 ${rec.epFirst}~${rec.epLast} 集（${rec.watched} 集）` : `第 ${rec.ep} 集`}`
            : `[qq] ✗ 没看成：${rec.via || '没有可用材料'}`)
        } catch (e) { deps.logErr('[promise] 承诺结果没记上：' + (e?.message ?? e)) }
        // 脑的账本：binge 不认识这个 id（旧账本才认），所以结果在这里结掉 —— 有证据才算 done
        if (job.brainId) {
          if (rec?.ok) finishJob(job, true, `真看完了《${rec.title || shown}》第 ${rec.ep || 0} 集`)
          else if (rec?.quota) {
            const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 30, 0, 0)
            deferJob(job, Math.max(30, Math.round((t.getTime() - Date.now()) / 60_000)), `今天额度满了：${rec?.via || ''}`)
            deps.log(`[qq] ⏳ 今天看番额度满了 → 这条顺延到明天 09:30 再做：${what || text}`)
          } else finishJob(job, false, `这次没看上：${rec?.via || 'binge 没给出结果'}`)
          continue
        }
        // binge 自己会把承诺标 done/failed；要是它还 open（进程崩了/没走完/额度满），只顺延，不判她失信
        const still = promises.list('open').find((x) => x.id === job.id)
        if (still) {
          let mins = 360
          if (rec?.quota) {
            // 额度满了就顺延到明天上午 —— 别每 6 小时白撞一次
            const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 30, 0, 0)
            mins = Math.max(30, Math.round((t.getTime() - Date.now()) / 60_000))
            deps.log(`[qq] ⏳ 今天看番额度满了 → 这条顺延到明天 09:30 再做：${what || text}`)
          }
          deferJob(job, mins, `这次没看上：${rec?.via || 'binge 没给出结果'}`)
        }
      }
    } catch (e) { deps.logErr('[promise] 执行承诺失败：' + (e?.message ?? e)) }
    finally { promiseRunning = false }
  }


  return { runDuePromises, resolveShow, dueJobs, finishJob, deferJob }
}
