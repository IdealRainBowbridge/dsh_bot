#!/usr/bin/env node
// 质量门禁 —— 一条命令拦住「语法坏 / 动态 import 断链 / 命令未注册 / 敏感文件权限过宽」
//
//   node scripts/check.mjs          # 全量
//   node scripts/check.mjs --fast   # 只查语法（pre-commit 用）
//
// 为什么要有它：10-31 的事故里——
//   · bili-watch.mjs 缺一对引号 → 解析期就死，整条链路不可用
//   · produce.mjs 的自动投稿块粘错位置 → TDZ 崩溃，首条解锁命令失效
//   · wander/dream 用了 dataPath('bot-ai/xxx') 双前缀 → 素材永远读不到，静默
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
    // 门禁自己也要有超时：`node --check` 遇到超大/畸形文件可能卡住
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe', timeout: 15_000, killSignal: 'SIGKILL' }) }
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
/**
 * 去掉注释（保留字符串内容与行号）。
 *
 * ⚠️ v5 深度排查发现的一个**门禁自身 bug**：
 * 旧实现是两条正则（一条去块注释、一条去行注释）。
 * 第二条会把**字符串里的 `//`** 当成注释开始 —— 而项目里到处都是
 * `path.replace(/\//g, path.sep)` 这种写法。结果整行后半段被抹成空格，
 * 于是：
 *   · 后面的 `timeout: 20000` 看不见 → 误报"没有超时"
 *   · 更糟的是反过来：注释开始的判断错了，也可能把**真实代码当注释删掉** → 漏报
 * 一个质量门禁自己会吃掉被检查的代码，是最危险的 bug：它会静默放过真问题。
 *
 * 现在改成逐字符扫描：正确识别普通字符串、模板字符串、正则字面量、行注释、块注释。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  // 上一个"有意义的"字符，用来判断 / 是除号还是正则开头
  let prevSignificant = ''
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    // 块注释（保留换行，行号不变）
    if (c === '/' && c2 === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    // 字符串 / 模板
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c; i++
      while (i < n) {
        const d = src[i]
        if (d === '\\') { out += d + (src[i + 1] || ''); i += 2; continue }
        out += d; i++
        if (d === quote) break
        if (d === '\n' && quote !== '`') break   // 未闭合的字符串，别吃掉整文件
      }
      prevSignificant = quote
      continue
    }
    // 正则字面量：只有出现在"运算符位置"的 / 才是正则开头
    if (c === '/' && (prevSignificant === '' || /[=(,:;!&|?{}\[\]\n]/.test(prevSignificant) || /\b(?:return|typeof|case)\b/.test(out.slice(-8)))) {
      out += c; i++
      let closed = false
      while (i < n) {
        const d = src[i]
        if (d === '\\') { out += d + (src[i + 1] || ''); i += 2; continue }
        if (d === '\n') break                    // 正则不能跨行
        out += d; i++
        if (d === '/') { closed = true; break }
        if (d === '[') {                        // 字符组里允许 /
          while (i < n && src[i] !== ']') { out += src[i]; i++ }
          if (i < n) { out += ']'; i++ }
        }
      }
      if (closed) { prevSignificant = '/'; continue }
      prevSignificant = c
      continue
    }
    if (!/\s/.test(c)) prevSignificant = c
    out += c
    i++
  }
  return out
}

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
    const m = /dataPath\(\s*['"]bot-ai\//.exec(src)
    if (m) {
      const line = src.slice(0, m.index).split('\n').length
      push('dataPath 双前缀', `${rel(f)}:${line}`,
        "dataPath 已指向 ~/.bot-ai，再拼 'bot-ai/' 会变成 ~/.bot-ai/bot-ai/…（读不到且静默）")
    }
  }
}

// ── 4. 命令注册表：只在 COMMANDS 对象字面量内取 key ─────────────────────────
function checkCommandRegistry() {
  const entry = path.join(ROOT, 'tools/bot.mjs')
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

  // 有文件却没注册 = 跑 bot <name> 会提示未知命令
  for (const name of files) if (!declared.has(name)) {
    push('命令未注册', `tools/commands/${name}.mjs`, `COMMANDS 里没有 '${name}'`)
  }
  // 注册了却没文件 = 一定 500
  for (const name of declared) if (!files.includes(name)) {
    push('注册但无文件', 'tools/bot.mjs', `声明了 '${name}' 但 tools/commands/${name}.mjs 不存在`)
  }
  notes.push(`命令注册表：${declared.size} 个已注册 / ${files.length} 个命令文件`)
}

// ── 5. 敏感文件权限 ────────────────────────────────────────────────────────
function checkPerms() {
  if (process.platform === 'win32') { notes.push('跳过权限检查（Windows）'); return }
  const HOME = process.env.USERPROFILE || process.env.HOME || ''
  const targets = [
    [path.join(HOME, '.dsh/bot.config.json'), 0o600],
    [path.join(HOME, '.bot-ai/credentials.json'), 0o600],
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

// ── 9.5 引用了从未声明的标识符（2026-11-01 真事故）──────────────────────
// 为什么加：qq-server.mjs 里有一行 `if (smartHook) hooks.push(... + smartHook)`，
// 而 smartHook **全文没有任何声明**。它在 try 之外，每次主动搭话 tick 都抛
// ReferenceError，被外层 catch 吞掉 → 表现为"主动搭话 100% 失败"，
// 一天 31 次，一次都没说出口。语法检查通过、断链通过、42 套测试全绿、门禁全绿。
//
// 与第 6.5 条（同步当异步）同一类：语法正确、逻辑看似在，运行期才炸。
// 静态能抓的特征：一个裸标识符在 `if (x)` / `(x)` / `+ x` 之类位置被读，
// 但同文件里既没有 `const/let/var/function/class x`、也不是形参、
// 也不是 import 进来的、也不是已知全局。宁可少量误报，也别再让这类静默失效溜过。
function checkUndeclaredIdentifiers(files) {
  // JS 保留字/字面量：绝不能被当"未声明变量"
  const KEYWORDS = new Set([
    'true', 'false', 'null', 'undefined', 'new', 'delete', 'typeof', 'instanceof', 'void',
    'in', 'of', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
    'continue', 'try', 'catch', 'finally', 'throw', 'function', 'class', 'extends', 'super',
    'this', 'async', 'await', 'yield', 'import', 'export', 'from', 'as', 'default', 'const',
    'let', 'var', 'static', 'get', 'set', 'with', 'debugger', 'enum', 'implements',
    'interface', 'package', 'private', 'protected', 'public',
  ])
  const KNOWN = new Set([
    'process', 'console', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer',
    'globalThis', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'AbortController',
    'TextEncoder', 'TextDecoder', 'Promise', 'JSON', 'Math', 'Date', 'Number', 'String',
    'Boolean', 'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'RegExp', 'Function', 'Intl',
    'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'decodeURIComponent', 'encodeURIComponent',
    'decodeURI', 'encodeURI', 'undefined', 'NaN', 'Infinity', 'arguments', 'this',
    'global', 'crypto', 'performance', 'localStorage', 'document', 'window', 'navigator',
    'onmessage', 'postMessage', 'self', 'importScripts',
  ])
  for (const f of files) {
    if (!/\.(mjs|js|cjs)$/.test(f)) continue
    const raw = fs.readFileSync(f, 'utf8')
    const src = stripComments(raw)

    const declared = new Set()
    // 声明：const/let/var/function/class
    // 一行多声明：`let rows = 0, imported = 0, skipped = 0` —— 只抓第一个会漏后面全部
    // （全量跑第二版就被它坑了 3 处误报：imported / skipped / chat）。
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([^;\n]+)/g)) {
      // 按顶层逗号切（粗略：不处理嵌套逗号，够用）
      let depth = 0, cur = ''
      const parts = []
      for (const ch of m[1]) {
        if ('([{'.includes(ch)) depth++
        else if (')]}'.includes(ch)) depth--
        if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
      }
      parts.push(cur)
      for (const part of parts) {
        const k = part.split('=')[0].trim().replace(/^\.\.\./, '').replace(/^[\{\[]/, '').split(':').pop().trim().replace(/[\}\]].*$/, '')
        if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k)
      }
    }
    for (const m of src.matchAll(/\b(?:const|let|var)\s*[\{\[]\s*([^}=]*)[\}\]]\s*=/g)) {
      for (const part of m[1].split(',')) {
        const k = part.split(':').pop().trim().replace(/^\.\.\./, '')
        if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k)
      }
    }
    for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    // import
    for (const m of src.matchAll(/\bimport\s+([^;'"]+?)\s+from\b/g)) {
      for (const part of m[1].replace(/[{}]/g, ',').split(',')) {
        const k = part.trim().split(/\s+as\s+/).pop().replace(/^\*$/, '').replace(/^\*/, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k)
      }
    }
    // 形参（含解构）
    for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of m[1].split(',')) {
        const k = part.split('=')[0].split(':').pop().trim().replace(/^[.\s]*/, '').replace(/[{}[\]]/g, '')
        if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k)
      }
    }
    for (const m of src.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
      for (const part of m[1].split(',')) {
        const k = part.split('=')[0].split(':').pop().trim().replace(/^[.\s]*/, '').replace(/[{}[\]]/g, '')
        if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k)
      }
    }
    // 函数形参整段是解构对象：`function search({ cues, chat = '', x = {} } = {})`
    // 外层 `{…} = {}` 里既有 = 又有嵌套，上面那条按 `\{([^{}]*=[^{}]*)\}` 匹配不到。
    // 这里改为「取每个函数/箭头的小括号内容，再从中抠所有 `{…}` 块，逐个按逗号切」。
    {
      // ⚠️ 不能用 [^()]* —— 形参里有 `Date.now()` 这种内嵌括号，
      // 会在第一个 `)` 处截断（第一版就栽在这，`search({...chat = ''...})` 一直误报）。
      // 必须做括号配平：从 `(` 开始数到深度归零。
      const paramBlocks = []
      const grabParens = (startIdx) => {
        let depth = 0
        for (let k = startIdx; k < src.length; k++) {
          const ch = src[k]
          if (ch === '(') depth++
          else if (ch === ')') {
            depth--
            if (depth === 0) return src.slice(startIdx + 1, k)
          }
        }
        return ''
      }
      for (const m of src.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$]?[\w$]*\s*\(/g)) {
        paramBlocks.push(grabParens(m.index + m[0].length - 1))
      }
      for (const m of src.matchAll(/\)\s*=>/g)) { /* 箭头函数：用上面的方法反推不方便，改在下面统一抓 */ }
      {
        // 箭头函数形参：`(...) =>` / `x =>`，用配平法从每个 `(`
        for (let i = 0; i < src.length; i++) {
          if (src[i] !== '(') continue
          const inner = grabParens(i)
          const after = src.slice(i + inner.length + 2).match(/^\s*=>/)
          if (after) paramBlocks.push(inner)
        }
      }
      for (const block of paramBlocks) {
        for (const br of block.matchAll(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
          for (const part of br[1].split(',')) {
            const k = part.split('=')[0].split(':').pop().trim().replace(/^\.\.\./, '').replace(/[{}\[\]]/g, '')
            if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k)
          }
        }
      }
    }
    // 解构形参带默认值：`{ write = true, proxy = false }` / `({ a, b = 1 })`
    // 这是最容易漏的一类 —— 全量跑第一版就漏了 10 处，全是它导致的误报。
    for (const m of src.matchAll(/\{\s*([^{}]*=[^{}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const k = part.split('=')[0].split(':').pop().trim().replace(/^\.\.\./, '').replace(/[{}[\]]/g, '')
        if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k)
      }
    }
    // 方法简写里的参数：invalidate(resetPlan = false) { … }
    for (const m of src.matchAll(/[A-Za-z_$][\w$]*\s*\(([^()]*=[^()]*)\)\s*\{/g)) {
      for (const part of m[1].split(',')) {
        const k = part.split('=')[0].split(':').pop().trim().replace(/^[.\s]*/, '').replace(/[{}[\]]/g, '')
        if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k)
      }
    }
    for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    // 循环变量 / for-of
    for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])

    // 只在"被当作自由变量读取"的高信噪比位置取样：
    //   if (x) / while (x) / !x / (x) / + x  —— 且 x 不在声明集合里
    const suspects = new Set()
    // 只取 `if (x)` / `while (x)` —— 这两个位置是"把变量当布尔读"的典型，
    // 且几乎不会被字符串/注释污染。低信噪比的取样（!x 之类）已去掉。
    for (const m of src.matchAll(/\b(?:if|while)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) suspects.add(m[1])

    for (const name of suspects) {
      if (KEYWORDS.has(name) || KNOWN.has(name) || declared.has(name)) continue
      // 排除：紧跟在 `.` 后面的是属性名
      const re = new RegExp('(?<![.\\w$])' + name.replace(/\\$/g, '\\\\$') + '\\b', 'g')
      let hit = false
      for (const m of src.matchAll(re)) {
        const before = src.slice(Math.max(0, m.index - 1), m.index)
        if (before === '.') continue
        hit = true
        break
      }
      if (!hit) continue
      const line = src.slice(0, src.search(re)).split('\n').length
      push('引用了未声明的变量', `${rel(f)}:${line}`, `\`${name}\` 在这个文件里从未声明（也不是形参/import/全局）—— 运行期会抛 ReferenceError，被 catch 吞掉就成静默失效`)
    }
  }
}

// ── 10. 没有超时的网络/子进程调用（v5 深度排查）────────────────────────
// 为什么加：这一轮查出 4 处 fetch 和 6 处 ffmpeg execFileSync **完全没有 timeout**。
// 后果不是"慢"，是**永久挂死**：fetch 等到 TCP 超时（可达数分钟），
// execFileSync 会把整个 Node 进程钉死（事件循环停摆 → 她一个字都不回）。
//
// 判定策略（宁可漏报，不要误报）：
//   取"这一行 + 之后 12 行"，出现 timeout / signal / AbortSignal 就算通过。
//   误报会让人把门禁关掉，那比漏报更糟（这个教训来自 v5 自己：
//   我第一版按括号配对扫，结果被 `'-v', 'error'` 里的括号和正则 .exec 骗了三次）。
function checkNoTimeout(files) {
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    const lines = src.split('\n')
    lines.forEach((l, i) => {
      // 窗口必须**双向**：2026-11-02 补扫 client.js 时踩到 —— 正确写法是
      //   const opts = {...}; opts.signal = AbortSignal.timeout(12000); await fetch(url, opts)
      // 信号绑在 fetch **上面两行**，而原来只往下看 13 行 → 好代码被判成"无超时"。
      // 往前看 6 行：足够覆盖"先备好参数再发起"的常规写法，又不至于把隔壁函数的 signal 借过来。
      const zone = lines.slice(Math.max(0, i - 6), i + 13).join('\n')
      // fetch(...)
      if (/(?<![.\w$])fetch\s*\(/.test(l)) {
        if (!/signal\s*:|AbortSignal|timeout/.test(zone)) {
          push('fetch 无超时', `${rel(f)}:${i + 1}`, 'fetch 没有 signal/timeout —— 网络卡住时这个请求会永久挂起')
        }
      }
      // 独立的 spawnSync / execFileSync（不是 a.exec(...) / /re/.exec(...)）
      if (/(?<![.\w$])(?:spawnSync|execFileSync)\s*\(/.test(l)) {
        if (/\/.*\/\.exec\(/.test(l)) return      // 正则字面量里的 exec
        if (!/timeout/.test(zone)) {
          push('同步子进程无超时', `${rel(f)}:${i + 1}`, 'spawnSync/execFileSync 没有 timeout —— 子进程挂住会把整个 Node 进程钉死')
        }
      }
    })
  }
}

// ── 11. 裸 JSON.parse（能把主进程炸掉，v5 深度排查）──────────────────────
// 实测：往面板 API POST 一个畸形 body，`JSON.parse(await readBody(req))` 抛的异常
// 在 async 路由里没人 catch → unhandledRejection → DSH `fatal uncaught exception` 退出。
// 规则：读**请求体/外部输入**的 JSON.parse 必须在 try 里，或走 safeBody()。
// 读自己刚写的文件的 parse 不算（那种失败有 fallback 语义）。
function checkBareJsonParse(files) {
  for (const f of files) {
    // 一次性运维脚本 / 测试 / 门禁自己：崩了只是那个命令失败，不会影响常驻服务
    if (/\/(test|scripts)\//.test(f) || /tools\/(drill-|tidy-|trim-|restore-|reset-|fix-|probe)/.test(f)) continue
    const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n')
    lines.forEach((l, i) => {
      if (!/JSON\.parse\s*\(/.test(l)) return
      // 只关心"解析外部输入"的场景
      if (!/(readBody|req\.|body|resp|raw|txt\.slice|String\(r\)|payload)/.test(l)) return
      const win = lines.slice(Math.max(0, i - 6), i + 1).join('\n')
      if (/try\s*\{|safeBody|\?\.|\.catch\(/.test(win)) return
      push('裸 JSON.parse', `${rel(f)}:${i + 1}`, '解析外部输入没有 try/catch —— 畸形输入会抛到 async 顶层，可能崩掉主进程')
    })
  }
}

// ── 12. 多进程状态文件必须走 atomic（v5 深度排查）───────────────────────
// 实测：无锁 read-modify-write，20 进程并发丢 28.8%。
// 额度账本漏记 = 她超额发评论/点赞 = 平台风控；情绪值丢 = 行为漂移。
// 规则：写这些"多写入者"的状态文件时，必须用 atomic 的 updateJson（或显式加锁）。
// ── 6.5 状态文件必须原子写（v5 深度排查 + 2026-11-02 升级） ──────────────────
//
// 老版本的做法：在源码行文本里找 MULTI_WRITER 列表里的**文件名字面量**。
// 2026-11-02 审查发现它漏检了 tools/lib/proactive-gate.mjs：
//
//     const GATE = () => dataPath('qq-proactive-gate.json')   // 文件名在这
//     fs.writeFileSync(f, JSON.stringify(o, null, 1))          // 裸写只写了变量 f
//
// → 门禁全绿，但那张闸门账是三条主动通道跨进程共用的唯一节流依据。
//   实测：旧写法 3 进程 × 20 次自增，计数从 61 掉到 5（丢失 193%，不只是丢增量，
//   发生了**回退**）。这就是"门禁全绿 ≠ 覆盖完全"。
//
// 新版本改成**同文件内符号追踪**：
//   ① 找出本文件里所有"多写者文件名"出现的位置；
//   ② 把这些文件名绑定的**标识符名**收集起来（字面量所在行的 `const X =` / 赋值目标，
//      以及 const F = () => dataPath('x.json') 这类函数名）；
//   ③ 任何 writeFileSync 的第一个参数只要由这些标识符**构成**（直接、或包在函数调用里
//      如 GATE()、String(F)、path.join(F)、`${F}`），且往前 12 行没有 atomic 调用 → 报错。
// 仍然处理不了：跨文件别名、动态拼接后完全不可追溯的名字（记 warning，不阻断）。
const MULTI_WRITER = [
  'quota.json', 'bili-actions.json', 'share-queue.json', 'mood.json',
  'lore.json', 'promises.json', 'sent-at.json', 'sent-log.json',
  'qq-proactive-gate.json', 'sleep-state.json',
  'focus.json', 'replies-state.json', 'status.json', 'mind-plan.json',
  'skipped-messages.json', 'qq/episodes.jsonl', 'episodes.jsonl',
]

/** 把 arguments 里出现的标识符名抠出来（去掉字符串字面量与数字）。 */
function identsOf(arg) {
  const noStr = arg.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ')
  return (noStr.match(/[A-Za-z_$][\w$]*/g) || [])
}

function checkAtomicWrites(files) {
  for (const f of files) {
    // 测试要在"没有锁"的前提下验证旧行为；一次性脚本只跑一次，不参与并发
    if (/\/(test|scripts)\//.test(f) || /tools\/(drill-|tidy-|trim-|restore-|reset-|fix-|probe)/.test(f)) continue
    // atomic.mjs 自己是锁的实现
    if (/tools\/lib\/atomic\.mjs$/.test(f)) continue
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    const lines = src.split('\n')

    // ① 哪些文件名出现在本文件里
    const hitNames = MULTI_WRITER.filter((n) => src.includes(n))
    if (!hitNames.length) continue

    // ② 把文件名绑定的标识符收集起来
    const guarded = new Set()
    for (const name of hitNames) {
      lines.forEach((l) => {
        if (!l.includes(name)) return
        // const X = ...   /  let X = ...  /  X = ...
        const m = l.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)
        if (m) guarded.add(m[1])
        // const F = () => ... / const f = function () {...
        const fn = l.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(|\bfunction\b)/)
        if (fn) guarded.add(fn[1])
        // 直接赋值：  this.gate = ...   /  obj.F = ...
        const as = l.match(/^\s*(?:this\.)?([A-Za-z_$][\w$]*)\s*=\s*[^=]/)
        if (as) guarded.add(as[1])
      })
    }
    // 常见的「文件名直接内联在 writeFileSync 第一个参数」也要算
    for (const name of hitNames) guarded.add("'" + name + "'")

    // ③ 查每一种裸写
    lines.forEach((l, i) => {
      if (!/writeFileSync\s*\(|appendFileSync\s*\(/.test(l)) return
      const args = l.slice(l.indexOf('(') + 1)
      // 去掉嵌套括号里更深的结构，只取到匹配的右括号（简化：取到最后一个 )）
      const first = args.split(',')[0] || ''
      const ids = identsOf(first)
      // 直接内联文件名
      const inline = hitNames.some((n) => first.includes("'" + n + "'") || first.includes('"' + n + '"'))
      const viaId = ids.some((id) => guarded.has(id))
      if (!inline && !viaId) return
      // 往前 12 行有 atomic 调用就放行（updateJson 内部自己会写）
      const win = lines.slice(Math.max(0, i - 12), i + 1).join('\n')
      if (/updateJson|withFileLock|acquireLock|writeJsonAtomic/.test(win)) return
      const why = inline ? '文件名直接内联' : '经由标识符 ' + ids.filter((x) => guarded.has(x)).join('/')
      push('多进程状态文件裸写', `${rel(f)}:${i + 1}`,
        `多写者状态文件必须走 atomic.updateJson（实测无锁并发丢 28.8%，3进程×20次实测计数回退）—— ${why}`)
    })
  }
}

// ── 6.6 import 方向（2026-11-02 新增，第 13 条）──────────────────────────────
//
// 层序（单向）：lib/  →  tools/lib/  →  tools/brain/ / tools/commands/
// 反向不是"绝对不能有"，但**出现一次就要显式记账**，否则分层图会慢慢失真。
// 目前允许的反向只有一条：tools/lib/*.mjs → ../brain/*（记忆/人设/通知都要读脑，
// 有 8 条，且都在函数体内调用，不构成模块级环）。其余方向一律判红。
//
// 用 Tarjan 跑不出真环（2026-11-02 实测：SCC 全为单点），说明现在没有模块级循环；
// 但"没有环"不等于"分层干净"，所以这条检查盯的是**方向**而不是环。
const ALLOWED_REVERSE = [
  'tools/lib/brain-bridge.mjs',      // remember 双写 brain（桥就是它的职责）
  'tools/lib/dream-read.mjs',        // 读梦境 jsonl，只借 brain/json 的读取器
  'tools/lib/notify.mjs',            // 通知发出后要写 delivery 账（交付证据）
  'tools/lib/persona.mjs',           // 提示词装配要用脑的七路召回
  'tools/lib/promise-executor.mjs',  // 承诺兑现要落 intents
  'tools/lib/promises.mjs',          // 同上
  'tools/lib/body.mjs',              // 身体：把心跳的决定接到能力上。它要看自我的心跳/睡眠/节律，
                                     // 才知道"此刻该做什么"—— 判断权在脑，执行接线在 lib，
                                     // 这个方向是刻意的（脑不该认识 socket，body 不该做决定）。
  'tools/lib/think.mjs',             // 「先想后说」的执行体：要读身体状态（field）和心里的念头（inner）
                                     // 才能决定她此刻会怎么想。它是 lib 层里唯一必须看脑的地方 ——
                                     // 因为"怎么想"本身就是脑的职责，而它只是个执行器。
  'tools/lib/reply-gate.mjs',        // 函数体内动态 import：判完接话时机顺手把情绪写进 affect，
                                     // 省掉「回复完再单独调一次判情绪」那次 LLM 往返
]

function checkImportDirections(files) {
  for (const f of files) {
    const r = rel(f)
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    const specs = [...src.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const sp of specs) {
      if (!sp.startsWith('.')) continue
      const target = path.resolve(path.dirname(f), sp)
      const rt = rel(target)
      // lib/ 不许 import tools/commands 或 tools/brain
      if (/^lib\//.test(r) && /^tools\/(commands|brain)\//.test(rt)) {
        push('分层反向依赖', `${r} → ${rt}`, 'lib/ 是插件壳，不应依赖编排层或脑层')
      }
      // tools/brain 与 tools/commands 互不依赖
      if (/^tools\/brain\//.test(r) && /^tools\/commands\//.test(rt)) {
        push('分层反向依赖', `${r} → ${rt}`, '脑层不应依赖编排层（命令是调用方，不是被调方）')
      }
      // tools/lib → tools/brain 在白名单外要报
      if (/^tools\/lib\//.test(r) && /^tools\/brain\//.test(rt) && !ALLOWED_REVERSE.includes(r)) {
        push('分层反向依赖', `${r} → ${rt}`, '新增的 tlib→brain 反向依赖需要显式加进 check.mjs 的 ALLOWED_REVERSE 并写明理由')
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
// 2026-11-02：client.js 被纳入扫描后暴露的真欠账。
// FeiyuSection() 878 行 —— 它不是"没拆"，而是**树直接吃状态**：return 里 setDraft 出现 44 次、
// setBusy 14 次，把树抽成纯组件的代价是要把 15 个 setter 逐个往下传，比现在更差。
// 正确的做法是引入 reducer（draft 22 处直接改）或拆成多个自洽的子面板 —— 那是独立一轮重构。
// 先登记，别让它挡住门禁；门禁的价值是"新账不许再欠"，不是"旧账一天还完"。
const FUNC_ALLOW = {
  'client.js:FeiyuSection': 900,
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
// 2026-11-02 审查：client.js（1,080 行，面板 UI 逻辑）原来不在扫描范围 ——
// walk 只走目录，根目录下的单文件被漏掉了，而 FILE_ALLOW 里却给它留了额度（1,150）。
// 门禁全绿 ≠ 覆盖完全。现在把根目录的独立源文件补进来，任何新增的 *.js / *.mjs 都会自动被扫到。
const ROOT_FILES = fs.readdirSync(ROOT).filter((n) => /\.(mjs|cjs|js)$/.test(n)).map((n) => path.join(ROOT, n))
const files = [...['tools', 'lib', 'test', 'scripts'].flatMap((d) => walk(path.join(ROOT, d))), ...ROOT_FILES]
checkSyntax(files)
if (!FAST) {
  checkSpecifiers(files)
  checkDataPathPrefix(files)
  checkCommandRegistry()
  checkPerms()
  checkEmptyCatch(files)
  checkHardcodedPaths(files)
  checkSyncThenable(files)
  checkUndeclaredIdentifiers(files)
  checkNoTimeout(files)
  checkBareJsonParse(files)
  checkAtomicWrites(files)
  checkImportDirections(files)
  checkSize(files)
}

const grouped = {}
for (const p of problems) (grouped[p.kind] ||= []).push(p)

if (!problems.length) {
  console.log(`✅ 门禁通过：${files.length} 个文件${FAST ? '（快速模式）' : ' · 语法/断链/双前缀/注册/权限/catch/路径/同步异步/未声明变量/超时/JSON/原子写/import方向/规模 全绿'}`)
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
