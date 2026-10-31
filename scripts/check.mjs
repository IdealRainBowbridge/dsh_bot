#!/usr/bin/env node
// 质量门禁 —— 一条命令拦住「语法坏 / 动态 import 断链 / 命令未注册 / 敏感文件权限过宽」
//
//   node scripts/check.mjs          # 全量
//   node scripts/check.mjs --fast   # 只查语法（pre-commit 用）
//
// 为什么要有它：10-31 的事故里——
//   · bili-watch.mjs 缺一对引号 → 解析期就死，整条链路不可用
//   · produce.mjs 的自动投稿块粘错位置 → TDZ 崩溃，首条解锁命令失效
//   · wander/dream 用了 dataPath('feiyu-ai/xxx') 双前缀 → 素材永远读不到，静默
//   · qq-server 引 '../lib/wander.mjs'（实际在 commands/）→ 每 60s 静默失败
// 下面 5 条检查，每一条都能独立拦下上面至少一个事故。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FAST = process.argv.includes('--fast')
const problems = []
const notes = []
const rel = (p) => path.relative(ROOT, p)

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || /\.bak[-.]/.test(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const push = (kind, file, detail) => problems.push({ kind, file, detail })

// ── 1. 语法 ────────────────────────────────────────────────────────────────
function checkSyntax(files) {
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) }
    catch (e) {
      const msg = String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 4).join('\n      ')
      push('语法错误', rel(f), msg)
    }
  }
}

// ── 2. 模块路径断链（静态解析，不执行代码）──────────────────────────────────
const EXTS = ['', '.mjs', '.js', '.cjs', '.json', '/index.mjs', '/index.js']
function resolves(from, spec) {
  const base = path.resolve(path.dirname(from), spec)
  return EXTS.some((x) => { try { return fs.statSync(base + x).isFile() } catch { return false } })
}
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (x, p) => p + ' '.repeat(x.length - p.length))

function checkSpecifiers(files) {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8')
    const src = stripComments(raw)
    let m
    while ((m = re.exec(src)) !== null) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      if (resolves(f, spec)) continue
      const line = src.slice(0, m.index).split('\n').length
      push('模块断链', `${rel(f)}:${line}`, `import '${spec}' 解析不到文件`)
    }
    // import( 后面跟着裸相对路径（10-31 bili-watch 事故原型）
    // import(pathVar) / import(`tpl`) / import(cond ? a : b) 都是合法写法，不报
    const m2 = /\bimport\(\s*(\.{1,2}\/[^'"\s\)]+)/.exec(src)
    if (m2) {
      const line = src.slice(0, m2.index).split('\n').length
      push('import 缺引号', `${rel(f)}:${line}`, `import(${m2[1]}) 缺引号`)
    }
  }
}

// ── 3. dataPath 双前缀（10-31 wander/dream 事故原型）────────────────────────
function checkDataPathPrefix(files) {
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    const m = /dataPath\(\s*['"]feiyu-ai\//.exec(src)
    if (m) {
      const line = src.slice(0, m.index).split('\n').length
      push('dataPath 双前缀', `${rel(f)}:${line}`,
        "dataPath 已指向 ~/.feiyu-ai，再拼 'feiyu-ai/' 会变成 ~/.feiyu-ai/feiyu-ai/…（读不到且静默）")
    }
  }
}

// ── 4. 命令注册表：只在 COMMANDS 对象字面量内取 key ─────────────────────────
function checkCommandRegistry() {
  const entry = path.join(ROOT, 'tools/feiyu.mjs')
  const cmdDir = path.join(ROOT, 'tools/commands')
  if (!fs.existsSync(entry) || !fs.existsSync(cmdDir)) { notes.push('跳过命令注册检查'); return }
  const src = fs.readFileSync(entry, 'utf8')
  const start = src.indexOf('const COMMANDS')
  if (start < 0) { notes.push('跳过命令注册检查（找不到 COMMANDS）'); return }
  // 从 { 开始做括号配平，取出对象字面量
  let i = src.indexOf('{', start), depth = 0, end = -1
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
  }
  if (end < 0) { notes.push('跳过命令注册检查（COMMANDS 括号不配平）'); return }
  const body = src.slice(i, end)
  const declared = new Set([...body.matchAll(/^\s{2}(['"]?)([a-z][a-z0-9-]{1,30})\1\s*:/gm)].map((m) => m[2]))
  const files = fs.readdirSync(cmdDir).filter((n) => n.endsWith('.mjs')).map((n) => n.replace(/\.mjs$/, ''))

  // 有文件却没注册 = 跑 feiyu <name> 会提示未知命令
  for (const name of files) if (!declared.has(name)) {
    push('命令未注册', `tools/commands/${name}.mjs`, `COMMANDS 里没有 '${name}'`)
  }
  // 注册了却没文件 = 一定 500
  for (const name of declared) if (!files.includes(name)) {
    push('注册但无文件', 'tools/feiyu.mjs', `声明了 '${name}' 但 tools/commands/${name}.mjs 不存在`)
  }
  notes.push(`命令注册表：${declared.size} 个已注册 / ${files.length} 个命令文件`)
}

// ── 5. 敏感文件权限 ────────────────────────────────────────────────────────
function checkPerms() {
  if (process.platform === 'win32') { notes.push('跳过权限检查（Windows）'); return }
  const HOME = process.env.USERPROFILE || process.env.HOME || ''
  const targets = [
    [path.join(HOME, '.dsh/feiyu.config.json'), 0o600],
    [path.join(HOME, '.feiyu-ai/credentials.json'), 0o600],
  ]
  for (const [t, want] of targets) {
    if (!fs.existsSync(t)) continue
    const mode = fs.statSync(t).mode & 0o777
    if (mode & 0o077) push('权限过宽', t, `mode=${mode.toString(8)}，应 ${want.toString(8)}（含 token/凭据）`)
  }
}

// ── 6. 空 catch 密度（10-31）───────────────────────────────────────────────
// 不追求清零：best-effort（探活、缓存、可选依赖）本来就该 catch。
// 但一个文件里过半的 catch 都是空的 = 那块代码出错你永远不会知道。
// 阈值 65%：只拦"整块逻辑被吞掉"的文件，正常文件不会被误报。
function checkEmptyCatch(files) {
  const MAX_RATIO = 0.65
  const MIN_CATCH = 8
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const total = (src.match(/\bcatch\b/g) || []).length
    if (total < MIN_CATCH) continue
    const empty = (src.match(/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?\}/g) || []).length
    const ratio = empty / total
    if (ratio > MAX_RATIO) {
      push('空 catch 过多', rel(f), empty + '/' + total + ' = ' + (ratio * 100).toFixed(0) + '%（阈值 ' + (MAX_RATIO * 100) + '%）—— 这块出错不会留下任何痕迹')
    }
  }
}

// ── 6.5 同步函数被当异步用（v5）─────────────────────────────────────────
// 为什么加这条：v5 重构时我把 `setTimeout(() => mindTick(), 30_000)`
// 改成了 `void mindTick().catch(...)`，而 mindTick 是**同步**函数（返回 undefined）。
// 结果 30 秒后线上炸 "TypeError: Cannot read properties of undefined (reading 'catch')"，
// 直接把 DSH 主进程带崩（fatal uncaught exception → 容器重启）。
// 语法检查、断链、测试全都没拦住 —— 因为代码"语法正确、逻辑也在"，
// 只是把一个返回值当 Promise 用了。这类错误必须静态扫出来。
function checkSyncThenable(files) {
  for (const f of files) {
    // 必须剥掉注释再扫 —— 注释里写 "以前是 `x().catch()`" 这种说明也会被误报
    // （v5 自测时就被自己的注释绊了一次）。stripComments 已在第 2 条检查里定义。
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    const syncNames = new Set()
    for (const m of src.matchAll(/^[ \t]*(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:function[ \t]*)?\([^)]*\)[ \t]*=>/gm)) {
      if (!/\basync\b/.test(m[0])) syncNames.add(m[1])
    }
    for (const m of src.matchAll(/^[ \t]*function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/gm)) {
      if (!/\basync\b/.test(m[0])) syncNames.add(m[1])
    }
    for (const name of syncNames) {
      const esc = name.replace(/\$/g, '\\$')
      // 前面不能是 `.` —— 否则会把 `res.json(...)` 这种**方法调用**误判成
      // 本地同名函数（v5 第一条就误报了 json()）。也排除 `?.`。
      const re = new RegExp('(?<![.\\w$])' + esc + '\\([^)]*\\)[ \\t]*\\.\\s*(catch|then|finally)\\b', 'g')
      let m
      while ((m = re.exec(src)) !== null) {
        const line = src.slice(0, m.index).split('\n').length
        push('同步函数当异步用', `${rel(f)}:${line}`, `${name}() 是同步函数（未声明 async），对它调 .${m[1]}() 会抛 TypeError`)
      }
    }
  }
}

// ── 7. Windows 硬编码路径（10-31）───────────────────────────────────────────
// 生产代码里出现 D:/ 或 C:\ 就是 ENOENT，而且是静默的（被 catch 吞掉）。
// 允许清单：外部程序路径候选（用户可配）与纯提示文案。
function checkHardcodedPaths(files) {
  // 什么算"真问题"：Windows 路径被**无条件**使用（Linux 上必然 ENOENT）。
  // 什么不算：① 探测式兜底 existsSync('C:/…') ? 'C:/…' : 'curl'（跨平台正确写法）
  //          ② config().x || 'D:/…'（用户可覆盖的默认值）
  //          ③ 纯提示文案 / 外部程序安装路径候选
  const ALLOW = new Set([
    'tools/lib/config.mjs',        // DEFAULTS（用户可覆盖）
    'tools/commands/voice.mjs',    // RVC/SoVITS 安装路径提示
    'tools/commands/selftest.mjs', // 体检文案
    'tools/lib/rvc.mjs',
    'tools/lib/refclean.mjs',
    'tools/lib/cover.mjs',         // 外部程序（ffmpeg/rvc）路径候选
    'tools/lib/sing.mjs',
    'tools/lib/bili-write.mjs',
    'tools/commands/qq-server.mjs',// napcat_launcher 兜底 + curl.exe 探测
    'tools/lib/ledger.mjs',
  ])
  const re = /['"\x60]([A-Za-z]:[\\/][^'"\x60\n]{3,})['"\x60]/g
  for (const f of files) {
    const r = rel(f)
    if (ALLOW.has(r)) continue
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|#)/.test(line)) return          // 注释
      // 探测式兜底 / 可覆盖默认值：同一行里有 existsSync 或 || 就不算硬编码
      // 候选列表（同一行有逗号/方括号 = 数组元素）、测试夹具、探测式兜底，都不算硬编码
      if (/existsSync|\|\||\[|,/.test(line)) return
      if (/^test[\\/]/.test(r)) return
      let m
      re.lastIndex = 0
      while ((m = re.exec(line)) !== null) {
        push('Windows 硬编码路径', r + ':' + (i + 1), "'" + m[1] + "' —— Linux 上必然 ENOENT")
      }
    })
  }
}

// ── 8. 规模护栏（10-31）───────────────────────────────────────────────────
// 上帝文件不是"风格问题"：qq-server.mjs 1710 行时，改一行要在 400 行上下文里找落点，
// 这是 lib/index.js 曾被打散成单字符那类事故的温床。
// 阈值定在"现状 + 余量"，只拦**继续变大**，不要求一次重构完。
//   · 单文件 > 1800 行          —— 必须拆了再加功能
//   · 单个函数 > 500 行         —— 必须拆函数
// 例外清单写在这里，是"已知欠账"，不是"允许无限长"。
const FILE_LIMIT = 1800
const FUNC_LIMIT = 500
const FILE_ALLOW = {
  // 已知欠账：闭包耦合太深，拆分风险 > 收益（见 AUDIT-FIX-20261031.md 第八节）
  'tools/commands/qq-server.mjs': 1750,
  'lib/index.js': 1150,
  'client.js': 1150,
}
// 函数级例外：这些是"主闭包"（把所有子功能装进同一个作用域），
// 拆它们的正确做法是抽出可独立测试的纯逻辑（已完成：onebot.mjs），
// 剩下的闭包内部函数彼此共享 send/callApi/config，强拆只会制造更多参数传递。
const FUNC_ALLOW = {
  // qq-server 的 run() 是主闭包 —— 它的长度 ≈ 文件长度，文件护栏已经覆盖。
  // 10-31 从 1600 调到 1700：为了治"一小时内连发 6 条主动消息"，在闭包里加了
  // 主动发言闸门（ownerSpoke / canSpeak / spokeDone 三个 helper 在模块级，
  // 闭包里只剩调用）。文件护栏（1750）仍然管着总长度，这里只是同步放宽。
  'tools/commands/qq-server.mjs:run': 1700,
  // lib/index.js 的 apply() 是插件壳主闭包，同理
  'lib/index.js:apply': 1100,
}
function checkSize(files) {
  for (const f of files) {
    const r = rel(f)
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n').length
    const limit = FILE_ALLOW[r] ?? FILE_LIMIT
    if (lines > limit) push('文件过大', r, lines + ' 行（上限 ' + limit + '）—— 再加功能前先拆')
    // 函数级：按"函数声明所在行的缩进"找配对的 }，而不是找第一个 {。
    // 为什么：以前用 src.indexOf('{', start) —— 如果函数签名换行、或前面有解构默认值，
    // 会从一个错误的位置开始数括号，把后面几个函数全算进同一个，误报 608 行（实际 95 行）。
    const re = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm
    let m
    while ((m = re.exec(src)) !== null) {
      const indent = m[1].length
      const startLine = src.slice(0, m.index).split('\n').length
      const lines = src.split('\n')
      // 从函数首行开始，逐行找"缩进 <= 声明缩进 且以 } 开头"的那一行 = 函数结束
      let endLine = startLine
      for (let i = startLine; i < lines.length; i++) {
        const L = lines[i]
        if (i > startLine && /^\s*\}/.test(L) && (L.match(/^\s*/)[0].length <= indent)) { endLine = i + 1; break }
      }
      const n = endLine - startLine + 1
      const fkey = r + ':' + m[2]
      const flimit = FUNC_ALLOW[fkey] ?? FUNC_LIMIT
      if (n > flimit) push('函数过大', r + ':' + startLine, m[2] + '() ' + n + ' 行（上限 ' + flimit + '）')
    }
  }
}

// ── 跑 ────────────────────────────────────────────────────────────────────
const files = ['tools', 'lib', 'test', 'scripts'].flatMap((d) => walk(path.join(ROOT, d)))
checkSyntax(files)
if (!FAST) {
  checkSpecifiers(files)
  checkDataPathPrefix(files)
  checkCommandRegistry()
  checkPerms()
  checkEmptyCatch(files)
  checkHardcodedPaths(files)
  checkSyncThenable(files)
  checkSize(files)
}

const grouped = {}
for (const p of problems) (grouped[p.kind] ||= []).push(p)

if (!problems.length) {
  console.log(`✅ 门禁通过：${files.length} 个文件${FAST ? '（快速模式）' : ' · 语法/断链/双前缀/注册/权限/catch/路径/同步异步/规模 全绿'}`)
  for (const n of notes) console.log(`   · ${n}`)
  process.exit(0)
}

console.log(`❌ 门禁失败：${problems.length} 个问题（扫了 ${files.length} 个文件）\n`)
for (const [kind, list] of Object.entries(grouped)) {
  console.log(`【${kind}】${list.length} 处`)
  for (const p of list.slice(0, 20)) {
    console.log(`  ${p.file}`)
    for (const l of String(p.detail).split('\n')) console.log(`      ${l}`)
  }
  if (list.length > 20) console.log(`  … 还有 ${list.length - 20} 处`)
  console.log('')
}
for (const n of notes) console.log(`   · ${n}`)
process.exit(1)
