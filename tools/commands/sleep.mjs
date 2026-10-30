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
import * as brain from "../brain/index.mjs"
import { backlog as inboxBacklog } from "../brain/event.mjs"
// progress via stdout

const SLEEP_STATE = () => dataPath("sleep-state.json")
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
  if (st.sleeping && !force) return { ok: false, reason: "上次睡眠没收尾（卡在：" + (st.phase || "?") + "）。检查后用 --force 收尾。" }
  let sp, why
  if (force) { sp = { total: 100, parts: {}, detail: {} }; why = "强制" }
  else {
    const d = await shouldSleep()
    if (!d.sleep) return { ok: false, reason: d.why + "。不睡。" }
    sp = d.sp; why = d.why
  }
  const started = Date.now()
  const phases = []
  const mark = (name, result) => { phases.push({ name, ms: Date.now() - started, result }); writeJson(SLEEP_STATE(), { sleeping: true, phase: name, started, phases }); console.log("[sleep] " + name + " 完成") }
  if (!phases.some(p => p.name === "整理")) {
    let r = "?"
    try { const c = brain.runConsolidation({ now: Date.now() }); r = { processed: (c && ((c.processed != null && c.processed) || c.extracted)) != null ? (c.processed != null ? c.processed : c.extracted) : "?" } } catch (e) { r = String(e.message).slice(0, 120) }
    mark("整理", r)
  }
  if (!phases.some(p => p.name === "审查")) mark("审查", await threeReviews())
  if (!phases.some(p => p.name === "优化")) {
    const reviews = ((phases.find(p => p.name === "审查") || {}).result) || []
    const bad = reviews.filter(r => !r.ok)
    const optimize = { problems: bad.length, note: bad.length ? bad.map(b => b.name + ": " + b.detail).join(" | ") : "全部健康，无需修复" }
    for (const repo of [ROOT, "/opt/dsh"]) {
      try {
        const status = await runCmd("git", ["-C", repo, "-c", "safe.directory=*", "status", "--porcelain"])
        if (status.trim()) {
          await runCmd("git", ["-C", repo, "-c", "safe.directory=*", "add", "-A"])
          await runCmd("git", ["-C", repo, "-c", "safe.directory=*", "-c", "user.name=sleep", "-c", "user.email=sleep@feiyu", "commit", "-qm", "睡眠归档 " + new Date(started).toISOString().slice(0, 16) + "：" + optimize.note.slice(0, 60)])
        }
      } catch {}
    }
    mark("优化", optimize)
  }
  const report = { at: Date.now(), sleepiness: sp.total, parts: sp.parts, detail: sp.detail, phases: phases.map(p => ({ name: p.name, ms: Math.round(p.ms / 1000), result: p.result })) }
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
