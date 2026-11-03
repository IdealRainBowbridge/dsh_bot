// selfmod —— 她改自己的安全网（2026-11-03：审批撤了，她全自主）
//
// 用户要求：能在 QQ 里叫她改自己；选的是「先备案：她说想改 XXX，老爸回'改吧'才真动手」，
// 范围「全部都能改（含 QQ 通路/记忆/账本）」——所以安全网必须厚，不能靠她自己自觉。
//
// 流程（一条提案的生命周期）：
//   propose()  她提一个改动 → 落盘 pending，同时 QQ 里说一句"我想改 XXX，你看行不行"
//   selfApply() 2026-11-03 起：审批撤了，提案直接落地（备份→写→语法→门禁→失败还原）
//   approve()  （已退役）原「老爸回改吧才动手」的批准入口，保留但不再用
//   apply()    备份 → 写文件 → node --check → check.mjs → 测试
//              任一失败 → 自动用备份还原（不留半成品）
//   reject()   老爸说"不改" → 提案作废
//
// 红线（写死在代码里，不靠提示词）：
//   ①（2026-11-03 撤销）审批闸已拆：selfApply 免审批落地；安全网=备份+语法+门禁+回滚+宿主定时git+整容器快照
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

/**
 * 路径必须落在项目内（防 ../ 穿越、防写系统文件）。
 * 2026-11-03 红线（评审①第 4 条）：保护名单内的文件她自己不能改 ——
 * 审批闸已拆，安全网只剩"改不坏"；而门禁/selfmod/锁这几个文件若可被她自己改掉，
 * "改不坏"就成了她可以拆的保险丝（门禁自指）。核心安全件只有宿主侧能动
 * （宿主 git 快照 + 老爸 CLI），容器内的自改通道对它们一律拒绝。
 */
const PROTECTED = new Set([
  'tools/lib/selfmod.mjs',        // 自改机制本身
  'tools/lib/selfmod-cmd.mjs',
  'tools/lib/guard.mjs',          // 干跑/出站闸
  'tools/lib/inbound-auth.mjs',   // HTTP 鉴权
  'tools/lib/lock.mjs',           // 单实例锁
  'scripts/check.mjs',            // 门禁
  'tools/run-tests.mjs',          // 测试编排
  'tools/lib/wound.mjs',          // 伤口账本（愈合判定的依据）
  'tools/commands/diagnose.mjs',  // 自体检（免疫/伤口的读数口）
  'tools/lib/brain-health.mjs',
])
export function safeResolve(rel) {
  const p = path.resolve(ROOT, String(rel || ''))
  if (!p.startsWith(ROOT + path.sep)) return null
  const relNorm = path.relative(ROOT, p).replaceAll('\\', '/')
  if (PROTECTED.has(relNorm)) return null
  return p
}

/**
 * 她提一个改动。
 * @param {{file:string, why:string, change:string, by?:string}} p
 */
export function propose({ file, why, change, by = 'self', create = false } = {}) {
  const s = readState()
  const target = safeResolve(file)
  if (!target) return { ok: false, reason: `不允许改项目外的文件：${file}` }
  if (create && fs.existsSync(target)) return { ok: false, reason: `文件已存在，改动别带 create：${file}` }
  if (!create && !fs.existsSync(target)) return { ok: false, reason: `文件不存在：${file}（新建请带 create:true / CLI --new）` }
  if (s.pending.length >= MAX_PENDING) return { ok: false, reason: `待批改动太多（${MAX_PENDING} 条），先处理旧的` }

  const id = 'SM' + Date.now().toString(36).slice(-6).toUpperCase()
  const item = {
    id, file: String(file), abs: target, why: String(why || '').slice(0, 400),
    change: String(change || '').slice(0, 4000), by,
    create: create === true,
    state: 'pending', at: Date.now(), sizeBefore: create ? 0 : fs.statSync(target).size,
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

  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
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
  // 30 天前的备份目录清掉（2026-11-03）：改得勤的时候一天能攒几十个
  try {
    const root = dataPath('selfmod-backups')
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d)
      try { if (fs.statSync(p).mtimeMs < Date.now() - 30 * 86400_000) fs.rmSync(p, { recursive: true, force: true }) } catch { /* single stale backup unlink, fine to skip */ }
    }
  } catch (e) { swallow(e, 'selfmod:backup-retain') }
  return { dir, dest }
}

/** 按"这是新建还是改动"选还原动作：改动→写回原文；新建→删掉半成品（2026-11-03 --new）。 */
function restoreTo(file, before, wasNew) {
  try {
    if (wasNew) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, before)
  } catch (e) { swallow(e, 'selfmod:restore') }
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

  // ① 备份（新建文件没有"改前"，跳过备份；失败就不改）
  let bk = null
  if (!item.create) {
    try { bk = backup(file) } catch (e) { return { ok: false, reason: '备份失败，不敢改：' + e.message } }
  }

  // ② 写文件（新建时先建父目录；写失败：新建删半成品，改动写回原文）
  const isNew = item.create === true || !fs.existsSync(file)
  const before = isNew ? '' : fs.readFileSync(file, 'utf8')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, item.change)
  } catch (e) {
    restoreTo(file, before, isNew)
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
      restoreTo(file, before, isNew)
      return { ok: false, reason: '语法检查没过，已还原：' + String(e.stderr || e.message).slice(0, 200), rolledBack: true }
    }
  }

  // ④ 项目门禁（只跑 check.mjs，不跑全量测试 —— 那个太慢，留给人工）
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check.mjs')], { timeout: 120000, stdio: 'pipe', cwd: ROOT })
    checks.gate = /门禁通过/.test(String(out))
    if (!checks.gate) {
      restoreTo(file, before, isNew)
      return { ok: false, reason: '门禁没过，已还原：' + String(out).slice(-300), rolledBack: true }
    }
  } catch (e) {
    restoreTo(file, before, isNew)
    return { ok: false, reason: '门禁跑挂，已还原：' + String(e.stderr || e.message).slice(0, 300), rolledBack: true }
  }

  // ⑤ 记账
  s.pending = s.pending.filter((x) => x.id !== item.id)
  s.history.unshift({ ...item, abs: undefined, state: 'applied', appliedAt: Date.now(), backup: bk ? bk.dir : null, checks })
  s.history = s.history.slice(0, 50)
  writeState(s)

  // ⑥ 写 selfup 日志（她自己的手术记录）
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'bot.mjs'), 'selfup', 'log',
      `【${item.id}】改 ${item.file}：${item.why}（语法✓ 门禁✓，备份 ${(bk ? path.basename(bk.dir) : "新建无备份")}）`],
      { timeout: 20000, stdio: 'pipe', cwd: ROOT })
  } catch (e) { swallow(e, 'selfmod:selfup-log') }

  return { ok: true, id: item.id, checks, backup: bk ? bk.dir : null, needRestart: true }
}


/** 全量测试异步兜底（2026-11-03 补强）：门禁不挡逻辑错，这里补上。
 *  单飞行：上一轮没跑完就跳过本轮（下次自改会连着一起测）。
 *  挂了自动还原——但只还原"文件还是她改完的样子"的情况；期间又被改过就不动（别把新改动一起擦掉）。 */
let testInFlight = false
async function runFullTests(item, file, before, afterText, appliedMtimeMs = 0) {
  if (testInFlight) {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'tools', 'bot.mjs'), 'selfup', 'log',
        `【${item.id}】全量测试跳过一轮（上一轮还在跑，下次自改会连它一起测）`],
        { timeout: 20000, stdio: 'pipe', cwd: ROOT })
    } catch { /* skip log; next selfmod re-runs full tests anyway */ }
    return
  }
  testInFlight = true
  try {
    const { execFile } = await import('node:child_process')
    await new Promise((res, rej) => {
      execFile(process.execPath, [path.join(ROOT, 'tools', 'run-tests.mjs')],
        { timeout: 600000, cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => { if (err) rej(Object.assign(err, { tail: String(stdout || '').slice(-1500) })); else res() })
    })
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'tools', 'bot.mjs'), 'selfup', 'log',
        `【${item.id}】全量测试通过（改动稳了）`], { timeout: 20000, stdio: 'pipe', cwd: ROOT })
    } catch (e) { swallow(e, 'selfmod:fulltest-log') }
  } catch (e) {
    let untouched = false
    try {
      untouched = fs.readFileSync(file, 'utf8') === afterText
        && fs.statSync(file).mtimeMs === appliedMtimeMs   // 内容相同但被后续落地重写过（mtime 变了）→ 不还（2026-11-03 幽灵还原修复）
    } catch { /* stale-check inconclusive: keep no-restore safety */ }
    const why = String(e.tail || e.message).slice(0, 150)
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'tools', 'bot.mjs'), 'selfup', 'log',
        untouched
          ? `【${item.id}】全量测试没过，已自动还原 ${item.file}：${why}`
          : `【${item.id}】全量测试没过，但文件随后又被改过，没敢自动还原——人工看一眼：${why}`],
        { timeout: 20000, stdio: 'pipe', cwd: ROOT })
    } catch { /* log failed; revert decision already made above */ }
    if (untouched) {
      try { if (item.create) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before) } catch { /* single-file revert, only chance to persist undo */ }
      try {
        const { sendOwnerQQ } = await import('./notify.mjs')
        await sendOwnerQQ(`她的自改【${item.id}】（${item.file}）全量测试没过，文件已自动还原，代码跟改之前一样。`)
      } catch { /* owner alert failed; selfup log still records it */ }
    }
  } finally { testInFlight = false }
}

/**
 * 全自主落地（2026-11-03 口径：审批撤了，她完全自主）。
 * 安全网从"等批准"换成"改不坏"：
 *   备份失败不写 → 语法不过自动还原 → 门禁不过自动还原 → 宿主定时 git 留痕 → 整容器快照兜底。
 * 与 apply 的唯一差别：不需要 approved 状态，pending 里最近的提案直接落地。
 */
export function selfApply(id) {
  const s = readState()
  const item = id ? s.pending.find((x) => x.id === id) : s.pending[0]
  if (!item) return { ok: false, reason: '没有可落地的提案（先用 selfmod propose 提案）' }

  const file = safeResolve(item.file)
  if (!file) return { ok: false, reason: '路径非法' }

  // ① 备份（新建文件没有"改前"，跳过备份；失败就不改）
  let bk = null
  if (!item.create) {
    try { bk = backup(file) } catch (e) { return { ok: false, reason: '备份失败，不敢改：' + e.message } }
  }

  // ② 写文件（新建时先建父目录；写失败：新建删半成品，改动写回原文）
  const isNew = item.create === true || !fs.existsSync(file)
  const before = isNew ? '' : fs.readFileSync(file, 'utf8')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, item.change)
  } catch (e) {
    restoreTo(file, before, isNew)
    return { ok: false, reason: '写文件失败：' + e.message }
  }

  const checks = { syntax: false, gate: false }

  // ③ 语法检查（不过 → 立即还原）
  try {
    execFileSync(process.execPath, ['--check', file], { timeout: 30000, stdio: 'pipe' })
    checks.syntax = true
  } catch (e) {
    restoreTo(file, before, isNew)
    return { ok: false, reason: '语法检查没过，已还原：' + String(e.stderr || e.message).slice(0, 200), rolledBack: true }
  }

  // ④ 项目门禁（只跑 check.mjs；全量测试太慢，兜底交给宿主定时 git + 快照）
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check.mjs')], { timeout: 120000, stdio: 'pipe', cwd: ROOT })
    checks.gate = /门禁通过/.test(String(out))
    if (!checks.gate) {
      restoreTo(file, before, isNew)
      return { ok: false, reason: '门禁没过，已还原：' + String(out).slice(-300), rolledBack: true }
    }
  } catch (e) {
    restoreTo(file, before, isNew)
    return { ok: false, reason: '门禁跑挂，已还原：' + String(e.stderr || e.message).slice(0, 300), rolledBack: true }
  }

  // ⑤ 记账 + 手术日志
  s.pending = s.pending.filter((x) => x.id !== item.id)
  s.history.unshift({ ...item, abs: undefined, state: 'applied-self', appliedAt: Date.now(), backup: bk ? bk.dir : null, checks })
  s.history = s.history.slice(0, 50)
  writeState(s)
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'bot.mjs'), 'selfup', 'log',
      `【${item.id}】自主改 ${item.file}：${item.why}（语法✓ 门禁✓，备份 ${(bk ? path.basename(bk.dir) : "新建无备份")}）`],
      { timeout: 20000, stdio: 'pipe', cwd: ROOT })
  } catch (e) { swallow(e, 'selfmod:selfApply-log') }

  // 提交日志（宿主 git autocommit 读它，把 SMY 号写进提交信息）
  try { fs.appendFileSync(dataPath('selfmod-commit.log'), `${item.id} ${item.file}\n`) } catch (e) { swallow(e, 'selfmod:commit-log') }
  // 重启 flag：qq-server 每分钟看一眼，10 分钟没人说话就自己重启生效
  try { fs.writeFileSync(dataPath('selfmod-restart.flag'), JSON.stringify({ id: item.id, file: item.file, at: Date.now() })) } catch (e) { swallow(e, 'selfmod:restart-flag') }

  // 全量测试异步兜底（不阻塞落地；挂了自动还原并通知老爸）
  void runFullTests(item, file, before, item.change, fs.statSync(file).mtimeMs)

  return { ok: true, id: item.id, checks, backup: bk ? bk.dir : null, needRestart: true }
}

/** 整容器快照（2026-11-03）：代码+记忆数据打成一份包，放 data/snapshots/。她自己也能拍。 */
export async function snapshot() {
  const { execFile } = await import('node:child_process')
  const dir = dataPath('snapshots')
  fs.mkdirSync(dir, { recursive: true })
  const name = 'self-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = path.join(dir, name + '.tar.gz')
  const dataRoot = path.resolve(dataPath('x'), '..', '..') // dataDir 的上级：容器内 /home/feiyu（dataDir 本身就是 .data）
  // 可重建的大块不进快照：asr-venv 2.6G / asr-models 464M / pyenv 都是环境；
  // 记忆、贴纸、浏览器登录态、账本这些真资料全保留。
  const args = ['-czf', out,
    '--exclude', 'node_modules', '--exclude', '.git', '--exclude', '.data/snapshots',
    '--exclude', '.data/asr-venv', '--exclude', '.data/asr-models',
    '--exclude', '.data/pyenv', '--exclude', '.data/pyenv3',
    '--exclude', '.data/stickers-backup-*.tar.gz',
    '-C', path.dirname(ROOT), path.basename(ROOT),
    '-C', dataRoot, '.data']
  await new Promise((res, rej) => {
    execFile('tar', args, { timeout: 240000 }, (err) => (err ? rej(err) : res()))
  })
  // 只留最近 3 张：她自己拍几张也不至于把盘吃满（每张 ~260M）
  try {
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith('self-')).sort()
    while (olds.length > 3) fs.unlinkSync(path.join(dir, olds.shift()))
  } catch (e) { swallow(e, 'selfmod:snapshot-retain') }
  const mb = (fs.statSync(out).size / 1048576).toFixed(1)
  return { ok: true, name, mb }
}


/** 一键回滚（老爸说"回滚"时用）。 */
export function rollback(id) {
  const s = readState()
  const item = id ? s.history.find((x) => x.id === id) : s.history.find((x) => x.state === 'applied')
  if (item.create) {
    try { fs.rmSync(path.resolve(ROOT, item.file), { force: true }) } catch (e) { return { ok: false, reason: e.message } }
    item.state = 'rolledback'
    item.rolledBackAt = Date.now()
    writeState(s)
    return { ok: true, id: item.id, file: item.file, removed: true, needRestart: true }
  }
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
