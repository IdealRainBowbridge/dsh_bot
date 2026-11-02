// selfmod —— 她在 QQ 里改自己的审批闸（2026-11-02）
//
// 用户要求：能在 QQ 里叫她改自己；选的是「先备案：她说想改 XXX，老爸回'改吧'才真动手」，
// 范围「全部都能改（含 QQ 通路/记忆/账本）」——所以安全网必须厚，不能靠她自己自觉。
//
// 流程（一条提案的生命周期）：
//   propose()  她提一个改动 → 落盘 pending，同时 QQ 里说一句"我想改 XXX，你看行不行"
//   approve()  老爸回「改吧」→ 绑定到最近那条 pending → 才开始真改
//   apply()    备份 → 写文件 → node --check → check.mjs → 测试
//              任一失败 → 自动用备份还原（不留半成品）
//   reject()   老爸说"不改" → 提案作废
//
// 红线（写死在代码里，不靠提示词）：
//   ① 没有 approved 状态绝不写文件
//   ② 每次写前强制备份（selfup backup 独立目录）
//   ③ 写后必须 node --check 通过，否则立即回滚
//   ④ **绝不自动重启** —— 重启会让 QQ 断线，必须老爸点头
//   ⑤ 只允许改 dsh_bot 项目内文件，路径穿越/外部路径一律拒绝
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')       // dsh_bot 项目根
const STATE = () => dataPath('selfmod.json')
const MAX_PENDING = 5

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) }
  catch { return { pending: [], history: [] } }
}
function writeState(s) {
  const f = STATE()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, f)          // 原子替换，别留半个状态文件
}

/** 路径必须落在项目内（防 ../ 穿越、防写系统文件）。 */
export function safeResolve(rel) {
  const p = path.resolve(ROOT, String(rel || ''))
  if (!p.startsWith(ROOT + path.sep)) return null
  return p
}

/**
 * 她提一个改动。
 * @param {{file:string, why:string, change:string, by?:string}} p
 */
export function propose({ file, why, change, by = 'self' } = {}) {
  const s = readState()
  const target = safeResolve(file)
  if (!target) return { ok: false, reason: `不允许改项目外的文件：${file}` }
  if (!fs.existsSync(target)) return { ok: false, reason: `文件不存在：${file}` }
  if (s.pending.length >= MAX_PENDING) return { ok: false, reason: `待批改动太多（${MAX_PENDING} 条），先处理旧的` }

  const id = 'SM' + Date.now().toString(36).slice(-6).toUpperCase()
  const item = {
    id, file: String(file), abs: target, why: String(why || '').slice(0, 400),
    change: String(change || '').slice(0, 4000), by,
    state: 'pending', at: Date.now(), sizeBefore: fs.statSync(target).size,
  }
  s.pending.unshift(item)
  writeState(s)
  return { ok: true, id, file: item.file, why: item.why }
}

/** 老爸批准最近一条（或指定的）待批。 */
export function approve(id) {
  const s = readState()
  const item = id ? s.pending.find((x) => x.id === id) : s.pending[0]
  if (!item) return { ok: false, reason: '没有待批的改动' }
  item.state = 'approved'
  item.approvedAt = Date.now()
  writeState(s)
  return { ok: true, id: item.id, file: item.file }
}

export function reject(id) {
  const s = readState()
  const item = id ? s.pending.find((x) => x.id === id) : s.pending[0]
  if (!item) return { ok: false, reason: '没有待批的改动' }
  s.pending = s.pending.filter((x) => x.id !== item.id)
  s.history.unshift({ ...item, state: 'rejected', rejectedAt: Date.now() })
  writeState(s)
  return { ok: true, id: item.id }
}

export function listPending() {
  return readState().pending
}

/**
 * 生成改动预览（不落地）。给"你说怎么改、它详细描述"用（2026-11-02）。
 *
 * 输出三种信息：
 *   ① 改哪个文件的哪几行（定位到具体行号）
 *   ② 删了什么、加了什么（逐行 diff，不是"改了某处"这种空话）
 *   ③ 影响面：这个文件被谁引用、改了可能波及什么
 * 老爸看这个就能判断"改得对不对"，而不是只能回"改吧"或"别改"。
 */
export function plan(id) {
  const s = readState()
  const item = id ? s.pending.find((x) => x.id === id) : s.pending[0]
  if (!item) return { ok: false, reason: '没有待批的改动' }
  const file = safeResolve(item.file)
  if (!file) return { ok: false, reason: '路径非法' }

  const before = fs.readFileSync(file, 'utf8')
  const after = String(item.change || '')
  const A = before.split('\n')
  const B = after.split('\n')

  // 极简 diff：找公共前后缀，中间那段就是改动区
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head++
  let tailA = A.length - 1, tailB = B.length - 1
  while (tailA >= head && tailB >= head && A[tailA] === B[tailB]) { tailA--; tailB-- }

  const removed = A.slice(head, tailA + 1)
  const added = B.slice(head, tailB + 1)

  // 影响面：谁 import 了这个模块
  const modName = path.basename(file, path.extname(file))
  const importers = []
  const walk = (dir, depth) => {
    if (depth > 3 || importers.length > 12) return
    let es = []
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (['node_modules', '.git', 'preview'].includes(e.name)) continue
      const q = path.join(dir, e.name)
      if (e.isDirectory()) { walk(q, depth + 1); continue }
      if (!/\.(mjs|cjs|js)$/.test(e.name)) continue
      let t = ''
      try { t = fs.readFileSync(q, 'utf8') } catch { continue }
      if (new RegExp(`from\\s+['\"][^'\"]*${modName}\\.mjs['\"]`).test(t)) importers.push(path.relative(ROOT, q))
    }
  }
  walk(ROOT, 0)

  return {
    ok: true, id: item.id, file: item.file, why: item.why,
    atLine: head + 1,
    removedLines: removed.length,
    addedLines: added.length,
    delta: (after.length - before.length),
    removed: removed.slice(0, 40),
    added: added.slice(0, 40),
    importers: importers.slice(0, 8),
    totalBefore: A.length,
    totalAfter: B.length,
  }
}

/** 备份到独立目录（不覆盖 selfup 的备份）。 */
function backup(file) {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const dir = dataPath('selfmod-backups', ts)
  fs.mkdirSync(dir, { recursive: true })
  const rel = path.relative(ROOT, file)
  const dest = path.join(dir, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
  return { dir, dest }
}

/**
 * 真正落地一条已批准的改动。
 * @returns {{ok:boolean, id?:string, checks?:object, reason?:string, rolledBack?:boolean}}
 */
export function apply(id) {
  const s = readState()
  const item = id ? s.pending.find((x) => x.id === id) : s.pending.find((x) => x.state === 'approved')
  if (!item) return { ok: false, reason: '没有已批准的改动' }
  if (item.state !== 'approved') return { ok: false, reason: `这条还是 ${item.state}，没批准不能改` }

  const file = safeResolve(item.file)
  if (!file) return { ok: false, reason: '路径非法' }

  // ① 备份（失败就不改）
  let bk
  try { bk = backup(file) } catch (e) { return { ok: false, reason: '备份失败，不敢改：' + e.message } }

  // ② 写文件
  const before = fs.readFileSync(file, 'utf8')
  try {
    fs.writeFileSync(file, item.change)
  } catch (e) {
    try { fs.copyFileSync(bk.dest, file) } catch (e) { swallow(e, 'selfmod:apply') }
    return { ok: false, reason: '写入失败：' + e.message, rolledBack: true }
  }

  // ③ 语法检查（改的是 .mjs/.js 才查）
  const checks = {}
  if (/\.(mjs|cjs|js)$/.test(file)) {
    try {
      execFileSync(process.execPath, ['--check', file], { timeout: 20000, stdio: 'pipe' })
      checks.syntax = true
    } catch (e) {
      // 回滚：宁可不改，也别让她把自己弄成语法错误
      fs.writeFileSync(file, before)
      return { ok: false, reason: '语法检查没过，已还原：' + String(e.stderr || e.message).slice(0, 200), rolledBack: true }
    }
  }

  // ④ 项目门禁（只跑 check.mjs，不跑全量测试 —— 那个太慢，留给人工）
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check.mjs')], { timeout: 120000, stdio: 'pipe', cwd: ROOT })
    checks.gate = /门禁通过/.test(String(out))
    if (!checks.gate) {
      fs.writeFileSync(file, before)
      return { ok: false, reason: '门禁没过，已还原：' + String(out).slice(-300), rolledBack: true }
    }
  } catch (e) {
    fs.writeFileSync(file, before)
    return { ok: false, reason: '门禁跑挂，已还原：' + String(e.stderr || e.message).slice(0, 300), rolledBack: true }
  }

  // ⑤ 记账
  s.pending = s.pending.filter((x) => x.id !== item.id)
  s.history.unshift({ ...item, abs: undefined, state: 'applied', appliedAt: Date.now(), backup: bk.dir, checks })
  s.history = s.history.slice(0, 50)
  writeState(s)

  // ⑥ 写 selfup 日志（她自己的手术记录）
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'bot.mjs'), 'selfup', 'log',
      `【${item.id}】改 ${item.file}：${item.why}（语法✓ 门禁✓，备份 ${path.basename(bk.dir)}）`],
      { timeout: 20000, stdio: 'pipe', cwd: ROOT })
  } catch (e) { swallow(e, 'selfmod:selfup-log') }

  return { ok: true, id: item.id, checks, backup: bk.dir, needRestart: true }
}

/** 一键回滚（老爸说"回滚"时用）。 */
export function rollback(id) {
  const s = readState()
  const item = id ? s.history.find((x) => x.id === id) : s.history.find((x) => x.state === 'applied')
  if (!item || !item.backup) return { ok: false, reason: '没有可回滚的记录' }
  const rel = path.relative(ROOT, path.resolve(ROOT, item.file))
  const src = path.join(item.backup, rel)
  if (!fs.existsSync(src)) return { ok: false, reason: '备份文件不见了：' + src }
  try {
    fs.copyFileSync(src, path.resolve(ROOT, item.file))
    item.state = 'rolledback'
    item.rolledBackAt = Date.now()
    writeState(s)
    return { ok: true, id: item.id, file: item.file, needRestart: true }
  } catch (e) { return { ok: false, reason: e.message } }
}
