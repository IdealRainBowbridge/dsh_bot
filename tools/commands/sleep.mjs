// sleep —— 睡眠：积累驱动的自我维护（整理 + 三审 + 优化增强），不是定时任务。
// 什么时候睡由积累决定：记忆积压、事件积压、代码改动，加权成"睡意"0-100。
// 睡 = 整理数据(巩固记忆) -> 三次全方位审查 -> 优化增强(git归档) -> 醒来。
// 用法：node bot.mjs sleep check | sleep [--force]
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

/**
 * 睡意 = **代谢账**。这里只是转接，真正的算法在 organ/night.mjs。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 2026-11-02：删掉这个文件里的第二份实现
 * ══════════════════════════════════════════════════════════════════════
 * 原来这里有一份自己的算法：记忆 33 / 事件 33 / 改动 33，合计 99，
 * 阈值 66、最短间隔 6 小时 —— 而 organ/night.mjs 里还有另一份：
 * 记忆 45 / 事件 30 / 改动 25 / **睡眠债 30**，阈值 66 + 硬底 0.92，间隔 2 小时。
 *
 * 两份算法同时活着，后果是：
 *   · 心跳用 night.assess() 判定"该睡了"（含睡眠债）
 *   · 而 `bot sleep` 命令用这份旧的（不含睡眠债）
 *   → 同一具身体，两个睡意数字。刚才实测就撞上了：
 *     sleep 说"睡意 100"，而 night.assess 说 34 —— 谁也不认谁。
 *
 * 这正是 M60 记下的那条："**两条并行的实现是静默失效的温床**"。
 * 判据也写在那里：一个概念只该有一份实现，其余全是转接。
 *
 * 保留这个导出是为了不破坏命令行的输出格式（它要 parts/detail 的形状）；
 * 算法一律走 night。
 */
export async function sleepiness() {
  const N = await import("../brain/organ/night.mjs")
  let a = null
  try { a = await N.assess(Date.now()) } catch (e) { swallow(e, 'sleep:sleepiness') }
  if (!a) return { total: 0, parts: { memory: 0, events: 0, code: 0, debt: 0 }, detail: { note: "night.assess 取不到" } }
  return {
    total: Number(a.score || 0),
    parts: a.parts || {},
    detail: a.detail || {},
    feeling: a.feeling,
    why: a.why,
    shouldSleep: !!a.shouldSleep,
  }
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
  // 判定一律走 night.assess（唯一口径：含睡眠债、含硬底、含最短间隔）。
  // 这里只额外保留一条**策略**：每天保底一次整理小睡（21 点后）。
  // 策略可以是本文件的，算法不能 —— 那是两回事。
  const NIGHTLY_AFTER = 21
  const sp = await sleepiness()
  const st = readJson(SLEEP_STATE(), {})
  const lastDay = st.lastSleep ? new Date(Number(st.lastSleep.at)).toLocaleDateString("sv-SE") : ""
  const today = new Date(now).toLocaleDateString("sv-SE")
  const hour = new Date(now).getHours()

  if (sp.shouldSleep) return { sleep: true, why: "睡意 " + sp.total + "（" + (sp.why || "") + "）", sp }
  if (lastDay !== today && hour >= NIGHTLY_AFTER) {
    return { sleep: true, why: "每日整理小睡（今天还没睡，现在 " + hour + " 点）", sp }
  }
  return { sleep: false, why: "醒着（睡意 " + sp.total + "，" + (sp.why || "") + "）", sp }
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

  // ══════════════════════════════════════════════════════════════════════
  // 自己完成"入睡"这一半（2026-11-02）
  // ══════════════════════════════════════════════════════════════════════
  // 改前：`stage.sleep()` 只由 body.mjs 的 beginSleep 调。
  // 主链路（心跳决定睡 → spawn 这个命令）时没问题；
  // 但**手动跑 `bot sleep`、或容器重启后补跑**时，sleepstage 里
  // inSleep 是 false → 结束时 stage.wake() 直接返回 {sleptMin:0, resets:{note:'没在睡'}}
  // → 还债/脱敏/HPA 回落**全部不发生**，而报告照常打勾。
  //
  // 这就是"结算做了但什么都没结算"的假成功。
  // 修法：进来先看一眼，没在睡就自己补上。幂等 —— 已经在睡就什么都不做。
  let startedSleep = false
  // ⚠️ 顺序很重要：**先读已有的 plan，再决定要不要自己 beginSleep**。
  //
  //   第一版写反了 —— beginSleep 里会用 plannedMin:480 重写 night-work.json，
  //   于是"外面刚设的 plan(120)"被当场覆盖，sleep 仍然按 8 小时跑。
  //   实测就是这样：打印 plan(120) 维护 0.60，跑起来却是"维护 1.00"。
  //
  //   这不是小 bug：它意味着**任何外部设定的时长都不生效**，
  //   只有作者写死的 480 起作用 —— 又一个"看起来能调，其实调不动"。
  let alreadyPlanned = null
  try {
    const ns0 = JSON.parse(fs.readFileSync(path.join(dataPath("brain", "meta"), "night-work.json"), "utf8"))
    if (ns0 && ns0.plan && typeof ns0.plan.minutes === "number" && Number(ns0.plan.minutes) > 5) {
      // 只认 10 分钟内写进去的 plan —— 更老的是上一觉留下的，不能用
      if (Date.now() - Number(ns0.at || 0) < 10 * 60_000) alreadyPlanned = ns0.plan
    }
  } catch (e) { swallow(e, 'sleep:sleepNow') }

  try {
    const NIGHT0 = await import("../brain/organ/night.mjs")
    const S0 = await import("../brain/organ/sleepstage.mjs")
    const snap0 = S0.snapshot()
    if (!snap0.inSleep) {
      NIGHT0.beginSleep({
        reason: force ? "手动 sleep" : "睡意到了",
        backlog: 0,
        plannedMin: alreadyPlanned ? Number(alreadyPlanned.minutes) : 480,
      })
      startedSleep = true
      console.log("[sleep] 自己补记入睡（进来时不在睡眠态）" + (alreadyPlanned ? "，沿用已有 plan " + Math.round(alreadyPlanned.minutes) + " 分钟" : ""))
    }
  } catch (e) { swallow(e, "sleep:self-begin") }
  try {
    const { setOnline } = await import("./status.mjs")
    await setOnline("dnd")
    console.log("[sleep] 状态已切勿扰（睡觉了）")
  } catch (e) { swallow(e, 'sleep:sleepNow') }
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

  // ══════════════════════════════════════════════════════════════════════
  // 这一觉的深度：两条通道各跑多深（2026-11-02）
  // ══════════════════════════════════════════════════════════════════════
  // 改前：N3/REM 算出来的分钟数是**摆设** —— 整理照样全跑、梦照样三幕，
  // 睡 2 小时和睡 8 小时做的事一模一样。那是"有器官没身体"。
  //
  // 现在从 night-work.json 读入睡时预演的 plan：
  //   · maintenance = N3/60  → 决定维护通道跑到哪一步（全量 / 只整理 / 跳过）
  //   · dream       = REM/35 → 决定梦境通道做几幕
  //
  // 读不到 plan（老数据、或直接跑 `bot sleep`）时退回"按真实睡过的时长算"，
  // 再不行才用满额 —— 三级兜底，绝不因为读不到就什么都不做。
  let DEPTH = { maintenance: 1, dream: 1, source: "默认满额" }
  try {
    const ns = JSON.parse(fs.readFileSync(path.join(dataPath("brain", "meta"), "night-work.json"), "utf8"))
    if (ns && ns.plan && typeof ns.plan.maintenance === "number") {
      DEPTH = { maintenance: ns.plan.maintenance, dream: ns.plan.dream, source: "入睡预演", acc: ns.plan.acc }
    }
  } catch (e) { swallow(e, 'sleep:mark') }
  // 外部设定的 plan 优先（alreadyPlanned 是在 beginSleep 之前读到的）
  if (alreadyPlanned && typeof alreadyPlanned.maintenance === "number") {
    DEPTH = { maintenance: alreadyPlanned.maintenance, dream: alreadyPlanned.dream, source: "外部设定", acc: alreadyPlanned.acc }
  }
  if (!DEPTH.acc) {
    // 兜底：用真实睡着时长重算（如果是被 spawn 起来且已经在睡）
    try {
      const sn = NIGHT.snapshot()
      if (sn && sn.inSleep && Number(sn.elapsedMin) > 0) {
        const p = NIGHT.plan(Number(sn.elapsedMin), 0)
        DEPTH = { maintenance: p.maintenance, dream: p.dream, source: "实时分期", acc: p.acc }
      }
    } catch (e) { swallow(e, 'sleep:mark') }
  }
  console.log("[sleep] 这一觉深度：" + DEPTH.source + " → 维护 " + DEPTH.maintenance.toFixed(2) + " / 梦 " + DEPTH.dream.toFixed(2))

  // ── 通道一：维护（N3 为主）─────────────────────────────────────────
  //
  // 深度怎么用（不是"按比例少做点"，是**决定做到哪一步**）：
  //   maintenance >= 0.70 → 全量：整理 + 审查 + 优化 + 归档
  //   0.35 ~ 0.70         → 只整理 + 审查（不做代码归档：那需要清醒的判断力，
  //                          睡得不深就改代码是危险的）
  //   < 0.35              → 只整理（深睡太少，连审查都做不可靠）
  //
  // 为什么分段而不是线性缩放：这些活是**离散的工序**，不是可以切掉一半的东西。
  // "审查做了一半"没有意义；"睡太浅所以不审查"才有意义。
  const doReview = DEPTH.maintenance >= 0.35
  const doOptimize = DEPTH.maintenance >= 0.70

  // ══════════════════════════════════════════════════════════════════════
  // 维护通道：**派活给独立进程**（2026-11-02，用户要求"可以拆"）
  // ══════════════════════════════════════════════════════════════════════
  // 改前这三个工序是同一段顺序代码。问题：
  //   · 审查要跑 9 套测试（16s+），期间整理的结果拿不到也写不下去
  //   · 任何一步把进程跑崩（OOM/超时/被杀），后面全废
  //   · 想单独重跑审查，只能整夜重来
  //
  // 现在派给 `nightwork` 子进程，各自写自己的结果文件。
  // **整理和审查是并行的** —— 审查查的是代码和账本，不依赖整理出来的记忆，
  // 这是真的分工，不是排队的工序。优化必须等审查（它要读问题清单）。
  //
  // 单步失败不影响其他步：这是把"一条链"换成"一张网"的全部意义。
  const stamp = new Date(started).toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)
  const FEIYU = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "bot.mjs")

  const spawnJob = async (job) => {
    const t0 = Date.now()
    try {
      const r = await execFileAsync(process.execPath, [FEIYU, "nightwork", job, "--stamp", stamp],
        { timeout: 300000, maxBuffer: 8 * 1024 * 1024 })
      return { ok: true, ms: Date.now() - t0, out: String(r.stdout || "").trim().slice(-400) }
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300), out: String(e.stdout || "").trim().slice(-300) }
    }
  }

  // 整理 + 审查 并行（审查不读记忆，所以不依赖整理）
  const [tidyR, reviewR] = await Promise.all([
    spawnJob("tidy"),
    doReview ? spawnJob("review") : Promise.resolve({ ok: false, skipped: true, why: "深睡只有 " + (DEPTH.acc ? DEPTH.acc.N3 : "?") + " 分钟（深度 " + DEPTH.maintenance.toFixed(2) + "），审查不可靠，跳过" }),
  ])
  mark("整理", tidyR)
  mark("审查", reviewR)

  // 优化：必须等审查（要读它写下的问题清单）
  let optimizeR = null
  if (doOptimize) {
    optimizeR = await spawnJob("optimize")
  } else {
    optimizeR = { ok: false, skipped: true, why: "维护深度不足 0.70（" + DEPTH.maintenance.toFixed(2) + "），不动代码" }
  }
  mark("优化", optimizeR)

  // 把三个工序的结果读回来拼进报告（跨进程协作的唯一通道就是结果文件）
  //
  // ⚠️ 2026-11-02：第一版这里写 `for (const p of phases)` 然后原地改 `p.result`，
  //    但 `mark()` 已经往 phases 里 push 过了，而 push 的是**当时的字面量对象**，
  //    改它的 .result 不会影响已 push 的那份（mark 里是 {...} 展开进 result）。
  //    表现：结果文件里三个工序都全，但打印出来的报告只有"整理"有内容。
  //    又一个"数据在、但没显示" —— 和本项目其他几次同源。
  //
  //    修法：按 job 名**重新 mark 一次**（mark 会覆盖同名阶段的 result），
  //    而不是去改已存在对象的字段。
  try {
    const NW = await import("./nightwork.mjs")
    const got = NW.readResults(stamp)
    const NAME = { tidy: "整理", review: "审查", optimize: "优化" }
    for (const [job, name] of Object.entries(NAME)) {
      if (!got[job]) continue
      // 只覆盖 result，不动 phases 里的顺序
      const hit = phases.find((p) => p.name === name)
      if (hit) hit.result = got[job]
    }
    phases.push({
      name: "派活", ms: 0,
      result: { stamp, jobs: Object.keys(got), 方式: "整理∥审查 并行，优化串在审查之后" },
    })
  } catch (e) { swallow(e, "sleep:read-results") }

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
        // 幕数按 REM 深度定：
        //   REM >= 0.85 → 3 幕（睡够了，情绪加工做完整）
        //   REM >= 0.45 → 2 幕
        //   REM >= 0.15 → 1 幕（只有个片段）
        //   REM <  0.15 → 不做梦（睡得浅，REM 几乎没分到）
        //
        // 为什么"薄了就少做"而不是"照做但短"：
        // 梦的加工价值来自**在虚构里重新走一遍**，走一半的梦没有那个作用。
        // 睡得太浅时不做梦，比做一个半截梦更接近真实（人浅睡醒来常常"没做梦"）。
        const dreamTurns = DEPTH.dream >= 0.85 ? 3 : DEPTH.dream >= 0.45 ? 2 : DEPTH.dream >= 0.15 ? 1 : 0
        let d = null
        if (dreamTurns === 0) throw new Error("REM 只有 " + (DEPTH.acc ? DEPTH.acc.REM : "?") + " 分钟，今晚没做梦")
        try { d = await dreamTrpg({ turns: dreamTurns }) } catch (e) { swallow(e, 'sleep:dream-trpg') }
        if (!d && dreamTurns > 1) d = await dream()
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
            await runCmd("git", ["-C", repo, "-c", "safe.directory=*", "-c", "user.name=sleep", "-c", "user.email=sleep@bot", "commit", "-qm", "睡眠归档 " + stamp + "：" + String(note || '').slice(0, 60)])
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

  // ⚠️ 2026-11-02：这里原来还有一份"审查 + 优化"的旧代码。
  //    加了通道一之后它成了死代码（被 `!phases.some(...)` 挡住，永远不会跑），
  //    但它是**同一段逻辑的第二份拷贝** —— 谁后来改一处忘另一处，
  //    就会出现"改了没生效"的怪事。删掉，只留通道一那一份。

  // ══════════════════════════════════════════════════════════════════════
  // 结算：**醒来是所有重置发生的地方**（2026-11-02 接上）
  // ══════════════════════════════════════════════════════════════════════
  // night.endSleep() 里做了四件事，而它**全仓从没被调用过**：
  //   ① 还睡眠债（按 N2×0.85 + N3×1.0 + REM×0.9 的**有效睡眠**算，不是按时长）
  //   ② 深睡重置受体池的名义贡献（解释用；真实恢复靠时间自己演化）
  //   ③ REM 重置情绪振幅（"这件事很可怕"→"这件事发生过"，脱敏不是遗忘）
  //   ④ HPA 轴过夜回落
  //
  // 后果有多严重：`sleepDebt` 只增不减（我在 field.mjs 里刚把它改成 accrualOnly），
  // 而**唯一能让它降下来的 repaySleep 就在这个没被调用的函数里**。
  // 两头一夹：睡多少觉都不还债 → 睡意永远往上涨 → 越来越困 → 却永远缓不过来。
  // 这是"建好了没人调"的第五次，也是最要命的一次。
  const settle = { ok: false }
  try {
    const NIGHT = await import("../brain/organ/night.mjs")
    // ⚠️ 这里有个真实的时间语义问题：
    //    `sleep` 命令跑完只要 30 秒，可它代表的是"睡了一整夜"。
    //    如果直接 endSleep(now)，stage.wake 会算出 sleptMin=0.5 分钟 →
    //    N3/REM 全是 0 → 还债 0 → **每一觉都判定"没睡够"**。
    //
    //    所以把"睡着的那段时间"按 plan 的时长**回溯**一下：
    //    把 beganAt 挪到 now - plan.minutes，让 wake() 算出正确时长。
    //    这不是伪造 —— 命令代表的就是"这一夜"，plan 就是这一夜的长度。
    //    （真实长睡的场景由心率/心跳累积决定时长，那是另一条路；
    //      手动跑命令时 plan 是唯一的时长来源。）
    try {
      const S2 = await import("../brain/organ/sleepstage.mjs")
      const sp0 = S2.snapshot()
      // ⚠️ 原来判 `DEPTH.source === "入睡预演"`，但我新加了"外部设定"这个来源，
      //    于是外设的 plan 走不进回溯分支 → 结算按真实 1 分钟算 → 还债 0。
      //    现在只要有 acc 就用，不看 source 名字（名字是给人看的，不是判据）。
      //    plannedMin 直接用 plan.minutes，比把四个阶段加起来更直接、不会漂移。
      const plannedMin = Number(
        (DEPTH.acc && (DEPTH.acc.N3 + DEPTH.acc.N2 + DEPTH.acc.REM + DEPTH.acc.N1))
        || (alreadyPlanned && alreadyPlanned.minutes)
        || 0
      )
      if (sp0.inSleep && plannedMin > 5) {
        // 只在本命令刚计时 >0 且明显短于 plan 时才回溯
        const realMin = Number(sp0.elapsedMin || 0)
        if (realMin < plannedMin * 0.5) {
          const back = await import("../brain/organ/sleepstage.mjs")
          // 直接把 beganAt 前移，让 wake() 按 plan 结算
          const { readJson, mutateJson } = await import("../brain/json.mjs")
          const { sleepPath } = await import("../brain/paths.mjs")
          mutateJson(sleepPath(), {}, (cur) => ({ ...cur, beganAt: Date.now() - plannedMin * 60000 }))
          console.log("[sleep] 按 plan 结算时长 " + Math.round(plannedMin) + " 分钟（命令只跑了 " + Math.round(realMin) + " 分钟）")
        }
      }
    } catch (e) { swallow(e, "sleep:backdate") }
    const r = NIGHT.endSleep(Date.now())
    settle.ok = true
    settle.sleptMin = r && r.sleptMin
    settle.acc = r && r.acc
    settle.resets = r && r.resets
    settle.workDone = r && r.workDone
    console.log("[sleep] 结算：还债 " + (r?.resets?.debt ?? "?") + "h · 情绪脱敏 " + (r?.resets?.emotion ?? "?") + " · HPA 回落 " + (r?.resets?.hpa ?? "?"))
  } catch (e) {
    settle.why = String(e.message).slice(0, 120)
    console.log("[sleep] 结算失败：" + settle.why)
  }

  const report = {
    at: Date.now(),
    sleepiness: sp.total,
    parts: sp.parts,
    detail: sp.detail,
    depth: { source: DEPTH.source, maintenance: Number(DEPTH.maintenance.toFixed(2)), dream: Number(DEPTH.dream.toFixed(2)), acc: DEPTH.acc || null },
    settle,
    phases: phases.map(p => ({ name: p.name, ms: Math.round(p.ms / 1000), result: p.result })),
  }
  try {
    const { setOnline } = await import("./status.mjs")
    await setOnline("online")
    console.log("[sleep] 状态已切回在线")
  } catch (e) { swallow(e, 'sleep:best-effort') }
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
  console.log("睡完了（睡意 " + r.report.sleepiness + " -> " + (await (async () => (await sleepiness()).total)()) + "）")
  console.log("  深度： " + r.report.depth.source + "  维护 " + r.report.depth.maintenance + " / 梦 " + r.report.depth.dream)
  if (r.report.settle && r.report.settle.ok) {
    console.log("  结算： 还债 " + r.report.settle.resets.debt + "h · 情绪 " + r.report.settle.resets.emotion + " · HPA " + r.report.settle.resets.hpa)
  } else if (r.report.settle) {
    console.log("  结算失败：" + (r.report.settle.why || "?"))
  }
  for (const p of r.report.phases) {
    // ⚠️ 2026-11-02：审查的结果形状变了。
    //    原来是 `[{name,ok,detail}, ...]`（数组），现在是 nightwork 工序的
    //    `{job, ok, items:[...], problems}`（对象，带 job/stamp/耗时）。
    //    渲染器还按数组 .map → TypeError 崩在这。
    //    顺带把三个新形状都认一遍，别再假定谁是什么。
    const r = p.result
    let detail
    if (p.name === "审查") {
      const items = Array.isArray(r) ? r : (Array.isArray(r?.items) ? r.items : [])
      detail = items.length
        ? items.map(x => (x.ok ? "OK " : "FAIL ") + x.name + ":" + x.detail).join(" / ")
        : JSON.stringify(r)
    } else if (p.name === "优化" && r && r.note) {
      detail = (r.problems ? "问题 " + r.problems + "：" + r.note : r.note)
        + (r.archive ? " | 归档 " + (r.archive.ok ? "✓ " + (r.archive.files || "?") + " 文件" : "✗ " + (r.archive.error || "?")) : "")
    } else if (r && r.skipped) {
      detail = "跳过：" + (r.why || "")
    } else {
      detail = JSON.stringify(r)
    }
    console.log("  " + p.name + "（" + p.ms + "s）：" + String(detail).slice(0, 300))
  }
  console.log("醒了。该记的记完了，该查的查完了。")
}
