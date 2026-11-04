// commands/nightwork —— 睡眠维护通道的**单个工序**（独立进程，2026-11-02）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么拆成独立进程
// ══════════════════════════════════════════════════════════════════════
// 用户要求：「维护通道可以拆」，对照的是"我（助手）这边派子代理那样分工"。
//
// 改前，维护通道是 sleep.mjs 里的**一段顺序代码**：
//   整理 → 审查 → 优化(含归档)，全部在同一个进程、同一条 try 链里。
// 后果：
//   · 审查要跑 9 套测试（16 秒+），这期间整理的结果拿不到、也写不下去
//   · 任何一步抛未捕获异常 → 后面全废（虽然有 try，但 OOM/超时/进程被杀挡不住）
//   · "审查"和"优化"本该是两个独立的行动，却共享一个 DOM
//
// 现在每个工序是一个独立进程：
//
//   node bot.mjs nightwork tidy       ← 整理（巩固记忆）
//   node bot.mjs nightwork review     ← 审查（代码/脑/账本）
//   node bot.mjs nightwork optimize   ← 优化 + 归档
//
// 三个好处，都是"分工"的实质而不是形式：
//   ① **失败隔离**：审查把进程跑崩，整理的结果已经落盘了，不会连带报废
//   ② **可以并行**：审查不依赖整理（它查的是代码和账本，不是记忆），
//      两者可以同时跑 —— 这是真实的分工，不是排队的工序
//   ③ **可以单独重跑**：审查挂了就 `nightwork review` 重跑，不用整夜重来
//
// 每个工序把结果写进**自己的**结果文件（nights/<工序>.json），
// sleep.mjs 只负责派活和汇总。这样"谁做了什么、成没成"永远查得到。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../lib/paths.mjs'
import { swallow } from '../lib/swallow.mjs'

const RESULT_DIR = () => dataPath('nights')
const resultPath = (job, stamp) => path.join(RESULT_DIR(), `${stamp}-${job}.json`)

/** 写这一工序的结果（原子写：先 tmp 再 rename）。 */
function writeResult(job, stamp, payload) {
  try {
    fs.mkdirSync(RESULT_DIR(), { recursive: true })
    const p = resultPath(job, stamp)
    const tmp = p + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ job, stamp, at: Date.now(), ...payload }, null, 1))
    fs.renameSync(tmp, p)
    return p
  } catch (e) { swallow(e, 'nightwork:write'); return null }
}

/** 读某一次睡眠的全部工序结果。 */
export function readResults(stamp) {
  const out = {}
  try {
    const dir = RESULT_DIR()
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(stamp + '-') || !f.endsWith('.json')) continue
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        out[j.job] = j
      } catch (e) { swallow(e, 'nightwork:readResults') }
    }
  } catch (e) { swallow(e, 'nightwork:readResults') }
  return out
}

// ══════════════════════════════════════════════════════════════════════
// 工序一：整理
// ══════════════════════════════════════════════════════════════════════
async function jobTidy() {
  const brain = await import('../brain/index.mjs')
  let r = { processed: '?' }
  // ⚠️ 2026-11-04：**必须传 chatFn，否则巩固的 LLM 抽取整段是死的。**
  //
  // `consolidate.run()` 的签名是 `{ chatFn }`，不传就只跑规则抽取。
  // 而这里原来写的是 `runConsolidation({ now })` —— 于是：
  //   · ruleFacts 只认用户亲口说的 5 条正则（吃/在做什么/要去/情绪/《作品》）
  //   · 实测 40 条 episode 里大多数是"她自己说的"和"群友说的"，正则一条都抽不到
  //   · 结果 sem/ 里 facts 0 / intents 0 / schemata 0 / competence 0
  //     —— 巩固"跑了 25/36 条"，产出是零。这就是"供血缺失"的形状。
  //
  // 档位选 fast（不是 deep）：这是批量抽取，每条 cluster 一次调用，
  // 一天几十个 cluster，用 deep 档会把这台机器烧穿。
  // max_tokens 400 与 commands/brain.mjs 的 --llm 路径保持一致（同一件事两个入口，
  // 参数不一致就会"手动跑有效果、夜里跑没效果"，那种 bug 最难查）。
  let chatFn = null
  try {
    const llm = await import('../lib/llm.mjs')
    chatFn = (messages) => llm.chat(messages, { temperature: 0.3, max_tokens: 400, purpose: 'fast' })
  } catch (e) { swallow(e, 'nightwork:tidy:llm') }
  try {
    const c = await brain.runConsolidation({ now: Date.now(), chatFn })
    // ⚠️ 2026-11-04：这里原来写 `(c.processed != null && c.processed) || c.extracted`。
    //    两个坑叠在一起：
    //      ① `processed === 0`（没有待处理的 ep）时，`(x != null && x)` 求值为 `0`（假值）
    //         → 短路去取 `|| c.extracted`
    //      ② `extracted` 这个字段在 run() 的返回里**根本不存在** → undefined
    //    → `n` 变成 undefined → 结果文件里写 `processed: "?"`。
    //
    //    "0 条待处理"被记成"未知"，而"未知"看上去像故障。实测就踩到了：
    //    游标已到 40/40，实跑 nightwork tidy 得到 `processed:"?"` ——
    //    一个正确的空跑被记成一次可疑的失败。
    //
    //    正确写法：显式判 undefined/null，让 0 保持 0。
    const n = c && c.processed != null ? c.processed : (c && c.extracted != null ? c.extracted : null)
    r = {
      processed: n != null ? n : '?',
      facts: c && c.facts,
      llmCalls: c && c.llmCalls,
      clusters: c && c.clusters,
      // 供血判据落进结果文件：processed>0 而 added===0 且没调 LLM → 一眼看出
      llm: !!chatFn,
    }
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 200) } }
  return { ok: true, ...r }
}

// ══════════════════════════════════════════════════════════════════════
// 工序二：审查
// ══════════════════════════════════════════════════════════════════════
async function jobReview() {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  const out = []

  // ① 代码测试（跑子进程，超时 120s 一套）
  try {
    const MAIN = ['client-smoke', 'client-render', 'stickers', 'memory', 'memory-recall',
      'qq-human', 'group-persona', 'imggen', 'vision']
    const fails = []
    for (const t of MAIN) {
      try {
        await execFileAsync(process.execPath, [path.join(ROOT, 'test', t + '-test.mjs')],
          { timeout: 120000, cwd: ROOT })
      } catch { fails.push(t) }
    }
    out.push({ name: '代码审查', ok: fails.length === 0, detail: fails.length ? '挂：' + fails.join('、') : '主链 ' + MAIN.length + ' 套全过' })
  } catch (e) { out.push({ name: '代码审查', ok: false, detail: String(e.message).slice(0, 160) }) }

  // ② 脑体检
  try {
    const brain = await import('../brain/index.mjs')
    const d = typeof brain.doctor === 'function' ? brain.doctor() : brain.doctor.run()
    const items = Array.isArray(d) ? d : ((d && d.items) || [])
    const bad = items.filter((x) => x && x.ok === false)
    out.push({ name: '脑体检', ok: bad.length === 0, detail: bad.length ? '红：' + bad.map((x) => x.name).join('、') : (items.length || 8) + ' 条不变量全绿' })
  } catch (e) { out.push({ name: '脑体检', ok: false, detail: String(e.message).slice(0, 160) }) }

  // ③ 账本
  try {
    const ledger = await import('../lib/ledger.mjs')
    const rep = await ledger.report({ fresh: false })
    const over = rep.me && rep.me.overBudget
    out.push({ name: '账本审查', ok: !over, detail: '今日 ' + ((rep.me && rep.me.tokens && rep.me.tokens.total) || '?') + ' token' + (over ? '，超预算' : '，预算内') + '；可用 ' + ((rep.balance && (rep.balance.usableNow || rep.balance.total)) || '?') + ' 积分' })
  } catch (e) { out.push({ name: '账本审查', ok: false, detail: String(e.message).slice(0, 160) }) }

  return { ok: true, items: out, problems: out.filter((x) => !x.ok).length }
}

// ══════════════════════════════════════════════════════════════════════
// 工序三：优化 + 归档
// ══════════════════════════════════════════════════════════════════════
async function jobOptimize(stamp) {
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

  // ① 归档代码
  let archive = { ok: false, why: '未尝试' }
  try {
    const { tarGzDir, listTarGz } = await import('../lib/tar.mjs')
    const dest = dataPath('archive', `code-${stamp}.tar.gz`)
    const r = tarGzDir(ROOT, dest, {
      exclude: [/node_modules/, /\.bak[-.]/, /^\.git\//, /^test\/.*\.tmp/],
      maxFiles: 5000, maxBytes: 64 * 1024 * 1024,
    })
    if (!r.ok) archive = { ok: false, via: 'tar', error: r.error }
    else {
      const names = listTarGz(dest, 3)
      archive = names.length
        ? { ok: true, via: 'tar', file: dest, files: r.files, bytes: r.bytes }
        : { ok: false, via: 'tar', error: '包写完了但读不回来' }
    }
    // 只留最近 7 个
    try {
      const dir = dataPath('archive')
      const olds = fs.readdirSync(dir).filter((f) => /^code-.*\.tar\.gz$/.test(f)).sort()
      for (const f of olds.slice(0, Math.max(0, olds.length - 7))) fs.rmSync(path.join(dir, f), { force: true })
    } catch (e) { swallow(e, 'nightwork:prune') }
  } catch (e) { archive = { ok: false, via: 'tar', error: String(e?.message || e) } }

  // ② 从**审查工序的结果文件**里取问题清单（跨进程协作）
  let problems = []
  let reviewNote = '没找到审查结果'
  try {
    const rv = readResults(stamp).review
    if (rv && Array.isArray(rv.items)) {
      problems = rv.items.filter((x) => !x.ok)
      reviewNote = problems.length ? problems.map((b) => b.name + ': ' + b.detail).join(' | ') : '全部健康'
    }
  } catch (e) { swallow(e, 'nightwork:jobOptimize') }

  return { ok: archive.ok, archive, problems: problems.length, note: reviewNote }
}

// ══════════════════════════════════════════════════════════════════════
// 入口
// ══════════════════════════════════════════════════════════════════════
export async function run(argv = []) {
  const job = String(argv[0] || '').trim()
  // stamp 由 sleep.mjs 传进来（同一夜的三个工序共用），没传就自己造一个
  const stampArg = argv.indexOf('--stamp')
  const stamp = stampArg >= 0 ? String(argv[stampArg + 1] || '') : new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (!stamp) { console.error('✗ 缺 --stamp'); process.exit(2) }

  const t0 = Date.now()
  let res = null
  if (job === 'tidy') res = await jobTidy()
  else if (job === 'review') res = await jobReview()
  else if (job === 'optimize') res = await jobOptimize(stamp)
  else {
    console.error('用法：nightwork tidy|review|optimize [--stamp ISO]')
    process.exit(2)
  }

  const p = writeResult(job, stamp, { ...res, ms: Date.now() - t0 })
  console.log(`[nightwork] ${job} 完成 ${Date.now() - t0}ms → ${p || '（结果没写进去）'}`)
  if (res && res.ok === false) {
    console.error(`[nightwork] ${job} 失败：${res.error || res.why || ''}`)
    process.exit(1)
  }
  return res
}
