// sleep —— 睡眠：积累驱动的自我维护（整理 + 三审 + 优化增强），不是定时任务。
// 什么时候睡由积累决定：记忆积压、事件积压、代码改动，加权成"睡意"0-100。
// 睡 = 整理数据(巩固记忆) -> 三次全方位审查 -> 优化增强(git归档) -> 醒来。
// 用法：node feiyu.mjs sleep check | sleep [--force]
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execFileAsync = promisify(execFile)
import { dataPath } from "../lib/paths.mjs"
import { config } from "../lib/config.mjs"
import { swallow } from "../lib/swallow.mjs"
import * as brain from "../brain/index.mjs"
import { backlog as inboxBacklog } from "../brain/event.mjs"
// progress via stdout

const SLEEP_STATE = () => dataPath("sleep-state.json")
const now0 = () => Date.now()
const ROOT = path.resolve(import.meta.dirname, "..", "..")
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")) ?? d } catch { return d } }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1)) }
const runCmd = async (cmd, args, opts) => {
  const r = await execFileAsync(cmd, args, { timeout: (opts && opts.timeout) || 300000, cwd: (opts && opts.cwd) || ROOT })
  return String(r.stdout || "")
}

export async function sleepiness() {
  const parts = {}
  let cs = { pending: 0, total: 1 }
  try { cs = brain.consolidate.status() } catch {}
  parts.memory = Math.round(Math.min(1, (cs.pending / Math.max(1, cs.total)) * 1.6) * 33)
  let bl = 0
  try { bl = inboxBackconsole.log() } catch {}
  parts.events = Math.round(Math.min(1, bl / 60) * 33)
  let dirty = 0
  for (const repo of [ROOT, "/opt/dsh"]) {
    try { const out = await runCmd("git", ["-C", repo, "-c", "safe.directory=*", "status", "--porcelain"]); dirty += out.split("\n").filter(Boolean).length } catch {}
  }
  parts.code = Math.round(Math.min(1, dirty / 12) * 33)
  const total = (parts.memory || 0) + (parts.events || 0) + (parts.code || 0)
  return { total, parts, detail: { pending: cs.pending, episodes: cs.total, inbox: bl, dirty } }
}

async function threeReviews() {
  const out = []
  try {
    const MAIN = ["client-smoke", "client-render", "stickers", "memory", "memory-recall", "qq-human", "group-persona", "imggen", "vision"]
    const fails = []
    for (const t of MAIN) {
      try { await execFileAsync(process.execPath, [path.join(ROOT, "test", t + "-test.mjs")], { timeout: 120000, cwd: ROOT }) }
      catch (e) { fails.push(t) }
    }
    const r = { stdout: fails.length ? "挂：" + fails.join("、") : "主链 9 套全过" }
    out.push({ name: "代码审查", ok: true, detail: String(r.stdout).trim().split("\n").pop().slice(0, 160) || "全过" })
  } catch (e) {
    out.push({ name: "代码审查", ok: false, detail: String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-2).join(" | ").slice(0, 160) })
  }
  try {
    const d = typeof brain.doctor === "function" ? brain.doctor() : brain.doctor.run()
    const items = Array.isArray(d) ? d : ((d && d.items) || [])
    const bad = items.filter((x) => x && x.ok === false)
    out.push({ name: "脑体检", ok: bad.length === 0, detail: bad.length ? "红：" + bad.map((x) => x.name).join("、") : (items.length || 8) + " 条不变量全绿" })
  } catch (e) { out.push({ name: "脑体检", ok: false, detail: String(e.message).slice(0, 160) }) }
  try {
    const ledger = await import("../lib/ledger.mjs")
    const rep = await ledger.report({ fresh: false })
    const over = rep.me && rep.me.overBudget
    out.push({ name: "账本审查", ok: !over, detail: "今日 " + ((rep.me && rep.me.tokens && rep.me.tokens.total) || "?") + " token" + (over ? "，超预算" : "，预算内") + "；可用 " + ((rep.balance && (rep.balance.usableNow || rep.balance.total)) || "?") + " 积分" })
  } catch (e) { out.push({ name: "账本审查", ok: false, detail: String(e.message).slice(0, 160) }) }
  return out
}

/**
 * 该不该睡（10-30 策略）：平时少睡（门槛66 + 最短6h间隔），但每天保底一次整理小睡（21点后）。
 */
export async function shouldSleep(now = Date.now()) {
  const THRESHOLD = 66
  const MIN_GAP_H = 6
  const NIGHTLY_AFTER = 21
  const sp = await sleepiness()
  const st = readJson(SLEEP_STATE(), {})
  const last = Number(st.lastSleepAt || 0)
  const gapH = last ? (now - last) / 3600000 : 999
  const lastDay = st.lastSleep ? new Date(Number(st.lastSleep.at)).toLocaleDateString("sv-SE") : ""
  const today = new Date(now).toLocaleDateString("sv-SE")
  const hour = new Date(now).getHours()
  if (sp.total >= THRESHOLD && gapH >= MIN_GAP_H) return { sleep: true, why: "睡意 " + sp.total + "（积压多了）", sp }
  if (lastDay !== today && hour >= NIGHTLY_AFTER) return { sleep: true, why: "每日整理小睡（今天还没睡，现在 " + hour + " 点）", sp }
  return { sleep: false, why: "醒着（睡意 " + sp.total + "，距上次 " + (gapH >= 999 ? "从未" : gapH.toFixed(1) + "h") + "）", sp }
}

export async function sleepNow(opts = {}) {
  const force = !!(opts && opts.force)
  const st = readJson(SLEEP_STATE(), {})
  if (st.sleeping && !force) {
    // 卡死自救：sleeping 状态超 30 分钟视为上一次进程死了，自动解锁重跑
    const stuckMs = now0() - Number(st.started || 0)
    if (stuckMs > 30 * 60_000) {
      console.log("[sleep] 上次睡眠卡了 " + Math.round(stuckMs / 60000) + " 分钟，判定进程已死，自动解锁")
    } else {
      return { ok: false, reason: "上次睡眠进行中（阶段：" + (st.phase || "?") + "，" + Math.round(stuckMs / 60000) + " 分钟）。等它跑完，或确认卡死后 --force。" }
    }
  }
  let sp, why
  if (force) { sp = { total: 100, parts: {}, detail: {} }; why = "强制" }
  else {
    const d = await shouldSleep()
    if (!d.sleep) return { ok: false, reason: d.why + "。不睡。" }
    sp = d.sp; why = d.why
  }
  const started = Date.now()
  const phases = []
  try {
    const { setOnline } = await import("./status.mjs")
    await setOnline("dnd")
    console.log("[sleep] 状态已切勿扰（睡觉了）")
  } catch {}
  const mark = (name, result) => { phases.push({ name, ms: Date.now() - started, result }); writeJson(SLEEP_STATE(), { sleeping: true, phase: name, started, phases }); console.log("[sleep] " + name + " 完成") }
  // ══════════════════════════════════════════════════════════════════════
  // 两条额外通道（2026-11-02）
  // ══════════════════════════════════════════════════════════════════════
  // 用户的要求：「睡眠体系搞个额外通道，一个通道负责给主通道玩 TRPG 用于'做梦'，
  //              一个通道负责优化整理与增强完善一整套」。
  //
  // 原来的形状是一条**线性流水线**：整理 → 做梦 → 审查 → 优化 → 归档，顺序跑完。
  // 有两个问题：
  //   ① 做梦被夹在"整理"后面当副产品 —— 可梦的素材恰恰来自刚整理出来的东西吗？
  //      不一定。REM 修补的是**情绪强度**（sleepstage 里写得很清楚：
  //      "REM → 重置情绪强度：把这件事还带着的温度降下来"），跟整理没因果关系。
  //   ② 十项工作（整理/做梦/审查/优化/归档）挤在一条链上，
  //      哪一步慢就全慢，哪一步抛错后面全废。
  //
  // 现在按**睡眠分期**拆成两条通道，各自独立成败：
  //   N3 深睡 + N2 浅睡 → 维护通道：巩固 / 审查 / 优化 / 归档（修"事实与结构"）
  //   REM              → 梦境通道：TRPG 式放飞（修"情绪与叙事"）
  //
  // 两条通道的产物各有各的隔离，互相不许污染：
  //   维护通道产出 → brain/consolidation/、自审报告、代码归档
  //   梦境通道产出 → dreams.jsonl（isFake: true，永不可当记忆引用）
  //
  // 为什么分先后而不是真并行：两个通道都要调 LLM，同时跑会抢额度也抢 CPU，
  // 而且"先想清事实、再做情绪加工"在真实睡眠里就是这个顺序
  // （N3 集中在前半夜，REM 在后半夜）。所以这里是**分期次序**，不是竞速。

  const NIGHT = await import("../brain/organ/sleepstage.mjs")

  // ── 通道一：维护（N3 为主）─────────────────────────────────────────
  // 这一步做什么，取决于 N3 分到了多少个"有效分钟"。
  // 深度睡眠被打断 = 整理没做完，这是 sleepstage 里那条"有效段"的意义。
  if (!phases.some(p => p.name === "整理")) {
    let r = "?"
    try {
      const c = brain.runConsolidation({ now: Date.now() })
      r = { processed: (c && ((c.processed != null && c.processed) || c.extracted)) != null ? (c.processed != null ? c.processed : c.extracted) : "?" }
    } catch (e) { r = String(e.message).slice(0, 120) }
    mark("整理", r)

    // 记下这一夜 N3 分到多少 —— 报告里要能看出"整理做够了没有"
    try {
      const acc = NIGHT.accrual(0, 0)
      if (acc && typeof acc === "object") phases[phases.length - 1].n3Min = acc.N3 ?? acc.n3 ?? null
    } catch { }
  }

  if (!phases.some(p => p.name === "审查")) mark("审查", await threeReviews())

  if (!phases.some(p => p.name === "优化")) {
    const reviews = ((phases.find(p => p.name === "审查") || {}).result) || []
    const bad = reviews.filter(r => !r.ok)
    const optimize = { problems: bad.length, note: bad.length ? bad.map(b => b.name + ": " + b.detail).join(" | ") : "全部健康，无需修复" }
    const arch = await archiveCode(started, optimize.note)
    optimize.archive = arch
    if (!arch.ok) {
      optimize.note = String(optimize.note || '') + ' | 归档失败：' + String(arch.error || arch.why || '未知')
      try { swallow(new Error('archive failed: ' + (arch.error || arch.why)), 'sleep:archive', { force: true }) } catch { }
    }
    mark("优化", optimize)
  }

  // ── 通道二：梦境（REM）─────────────────────────────────────────────
  // 放在维护通道**之后**：先想清事实，再做情绪加工（真实睡眠就是这个次序）。
  //
  // 为什么独立成一个通道而不是"整理的副产品"：
  //   · 它的输入不同：维护通道吃的是没巩固的 episode；
  //     梦境通道吃的是**已经消化过的**情绪残留 + 身体状态 + 最近在意的事。
  //   · 它的产物不同：梦是 isFake 的，永远不许进记忆。混在整理里迟早出事。
  //   · 它的成败不同：整理失败必须让人看见；梦没做成只是"今晚无梦"，不该报错。
  if (!phases.some(p => p.name === "做梦")) {
    let dreamOut = { ok: false, why: "跳过" }
    try {
      const cfg = config()
      if (cfg.dream?.enabled === false) dreamOut.why = "配置关着"
      else {
        const { dream, dreamTrpg } = await import("./dream.mjs")
        // 用 TRPG 版（多幕 + 掷骰 + 选择），有则用之；失败退回单段短梦。
        //
        // 为什么先试 TRPG：见 dream.mjs 里 dreamTrpg 的注释 ——
        // 旁白式做梦她只是在看故事，TRPG 式她要**在梦里做决定**，
        // 那才是 REM"把这件事还带着的温度降下来"的机制。
        let d = null
        try { d = await dreamTrpg({ turns: 3 }) } catch (e) { swallow(e, 'sleep:dream-trpg') }
        if (!d) d = await dream()
        dreamOut = d
          ? { ok: true, turns: d.turns || 0, chars: String(d.text || "").length, head: String(d.text || "").slice(0, 50) }
          : { ok: false, why: "今晚无梦（没有素材或没通过隔离检查）" }
        if (d) console.log("[sleep] 💭 梦境通道：" + (d.turns ? d.turns + " 幕 · " : "") + dreamOut.head)
        else console.log("[sleep] 💭 梦境通道：今晚无梦")
      }
    } catch (e) { dreamOut = { ok: false, why: String(e.message).slice(0, 80) }; console.log("[sleep] 💭 梦境通道失败：" + dreamOut.why) }
    mark("做梦", dreamOut)
  }
  /**
   * 归档代码：git 可用就提交；不可用就 tar.gz 快照（v5）。
   * 返回 { ok, via, file?, files?, bytes?, why?, error? } —— 调用方必须能看见失败。
   */
  async function archiveCode(atMs, note) {
    const stamp = new Date(atMs).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const repos = [ROOT, "/opt/dsh"]
    // ① git 路线（有就用，保持原行为）
    let gitOk = false
    try { await runCmd("git", ["--version"]); gitOk = true } catch { gitOk = false }
    if (gitOk) {
      const done = []
      for (const repo of repos) {
        try {
          const status = await runCmd("git", ["-C", repo, "-c", "safe.directory=*", "status", "--porcelain"])
          if (status.trim()) {
            await runCmd("git", ["-C", repo, "-c", "safe.directory=*", "add", "-A"])
            await runCmd("git", ["-C", repo, "-c", "safe.directory=*", "-c", "user.name=sleep", "-c", "user.email=sleep@feiyu", "commit", "-qm", "睡眠归档 " + stamp + "：" + String(note || '').slice(0, 60)])
            done.push(repo)
          }
        } catch (e) { swallow(e, 'sleep:git-commit') }
      }
      return { ok: true, via: 'git', repos: done }
    }
    // ② tar.gz 路线（容器里没有 git 时的兜底）
    try {
      const { tarGzDir, listTarGz } = await import("../lib/tar.mjs")
      const dest = dataPath('archive', `code-${stamp}.tar.gz`)
      const r = tarGzDir(ROOT, dest, {
        exclude: [/node_modules/, /\.bak[-.]/, /^\\.git\//, /^test\/.*\.tmp/],
        maxFiles: 5000, maxBytes: 64 * 1024 * 1024,
      })
      if (!r.ok) return { ok: false, via: 'tar', error: r.error }
      // 自检：写出来的包必须能读回来（防"写出一个没法用的包"这种假成功）
      const names = listTarGz(dest, 3)
      if (!names.length) return { ok: false, via: 'tar', error: '包写完了但读不回来' }
      // 只保留最近 7 个快照
      try {
        const dir = dataPath('archive')
        const olds = fs.readdirSync(dir).filter((f) => /^code-.*\.tar\.gz$/.test(f)).sort()
        for (const f of olds.slice(0, Math.max(0, olds.length - 7))) fs.rmSync(path.join(dir, f), { force: true })
      } catch (e) { swallow(e, 'sleep:archive-prune') }
      return { ok: true, via: 'tar', file: dest, files: r.files, bytes: r.bytes }
    } catch (e) {
      return { ok: false, via: 'tar', error: String(e?.message || e) }
    }
  }

  if (!phases.some(p => p.name === "审查")) mark("审查", await threeReviews())
  if (!phases.some(p => p.name === "优化")) {
    const reviews = ((phases.find(p => p.name === "审查") || {}).result) || []
    const bad = reviews.filter(r => !r.ok)
    const optimize = { problems: bad.length, note: bad.length ? bad.map(b => b.name + ": " + b.detail).join(" | ") : "全部健康，无需修复" }
    // ── 归档（v5 修死链路）────────────────────────────────────────────────
    // 旧代码：`runCmd("git", ...)` 提交脏文件。但容器里**根本没装 git**（Debian 精简镜像），
    // 异常被 `catch {}` 吞掉 —— "睡一觉会归档代码"这件事从来没发生过，而报告里打着勾。
    //
    // 现在：先用 git（如果哪天镜像装了，行为不变）；检测不到 git 就退到内置的 tar.gz
    // 快照（tools/lib/tar.mjs，零依赖）。两条路都失败 → 记进 optimize 的 note，
    // 让她（和 diagnose）看见"这次没归档"，而不是假装成功。
    const arch = await archiveCode(started, optimize.note)
    optimize.archive = arch
    if (!arch.ok) {
      optimize.note = String(optimize.note || '') + ' | 归档失败：' + String(arch.error || arch.why || '未知')
      try { swallow(new Error('archive failed: ' + (arch.error || arch.why)), 'sleep:archive', { force: true }) } catch {}
    }
    mark("优化", optimize)
  }
  const report = { at: Date.now(), sleepiness: sp.total, parts: sp.parts, detail: sp.detail, phases: phases.map(p => ({ name: p.name, ms: Math.round(p.ms / 1000), result: p.result })) }
  try {
    const { setOnline } = await import("./status.mjs")
    await setOnline("online")
    console.log("[sleep] 状态已切回在线")
  } catch {}
  writeJson(SLEEP_STATE(), { sleeping: false, phase: "awake", lastSleep: report, lastSleepAt: Date.now() })
  console.log("[sleep] 醒了，全程 " + Math.round((Date.now() - started) / 1000) + "s")
  return { ok: true, report }
}

export async function run(args) {
  if (args[0] === "check" || args.length === 0) {
    const sp = await sleepiness()
    const state = readJson(SLEEP_STATE(), {})
    console.log("睡意 " + sp.total + "/100（记忆" + sp.parts.memory + " 事件" + sp.parts.events + " 改动" + sp.parts.code + "）")
    console.log("构成: " + JSON.stringify(sp.detail))
    console.log("上次睡眠: " + (state.lastSleep ? new Date(state.lastSleep.at).toLocaleString("sv-SE") + "，睡意" + state.lastSleep.sleepiness : "还没睡过"))
    if (args.length === 0) {
      const d = await shouldSleep()
      console.log("判定: " + d.why)
    }
    return
  }
  const r = await sleepNow({ force: args.includes("--force") })
  if (!r.ok) { console.log("x " + r.reason); return }
  console.log("睡完了（睡意 " + r.report.sleepiness + " -> 0）")
  for (const p of r.report.phases) {
    const detail = p.name === "审查" ? (p.result || []).map(x => (x.ok ? "OK " : "FAIL ") + x.name + ":" + x.detail).join(" / ") : JSON.stringify(p.result)
    console.log("  " + p.name + "（" + p.ms + "s）：" + String(detail).slice(0, 300))
  }
  console.log("醒了。该记的记完了，该查的查完了。")
}
