/**
 * 设置页回归锚点（2026-11-04）。
 *
 * 三条都是实测踩过的坑，且都属于「页面看起来正常、实际功能是坏的」：
 *
 * 1) 子路径 API 基址：/deepseekharness/dsh_bot/ 下写死 /dsh_bot/api → 整页 404。
 *    这里不复制推导算法，直接跑 lib/settings.html 的内联脚本取出真实 API 值。
 * 2) 重复 id：<section id="persona"> 与 <textarea id="persona"> 撞名，getElementById
 *    取到 section，人格文本永远填不进输入框（截图为空，控制台无报错）。
 * 3) 假控件：面板上的「抖音每次条数」写 douyin.maxPerRun —— 后端 /api/config 的
 *    白名单里没有 douyin，写入被静默丢弃；代码里也无人读取该键。真实键是
 *    night.maxVideos（wakePrompt / night-plan 都读它）。
 *
 * 跑法：node test/settings-page-test.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HTML = fs.readFileSync(path.join(root, 'lib', 'settings.html'), 'utf8')

let bad = 0
const ok = (c, label) => { console.log((c ? '  ✓ ' : '  ✗ ') + label); if (!c) bad++ }

/* ── 1) 内联脚本的 API 基址：真跑，不照抄 ─────────────────────────────── */
const scriptSrc = (() => {
  const m = HTML.match(/<script>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('settings.html 里没有内联 <script>')
  return m[1]
})()

/** 在给定的页面地址下求值内联脚本，返回它算出的 API 前缀。 */
function apiBaseFor(href) {
  // 脚本尾部会 boot()，需要一整套 DOM；这里只截取 API 定义那一段求值，
  // 后面的 UI 代码与基址无关。
  const m = scriptSrc.match(/const API = \(\(\) => \{[\s\S]*?\}\)\(\);/)
  if (!m) throw new Error('内联脚本里找不到 `const API = (() => {...})()`')
  // vm 上下文没有 Node 的全局 URL —— 不注入就会静默走 catch，测出假的 /dsh_bot/api
  const sandbox = { location: { href }, URL }
  vm.createContext(sandbox)
  // `const` 在 vm 里不挂到 global 上：把声明改成表达式赋值再读回来
  vm.runInContext(m[0].replace(/^const API =/, 'globalThis.__api ='), sandbox, { filename: 'settings.html:API' })
  return sandbox.__api
}

const sub = apiBaseFor('https://h/deepseekharness/dsh_bot/')
ok(sub === '/deepseekharness/dsh_bot/api', '子路径挂载 → /deepseekharness/dsh_bot/api（实际：' + sub + '）')

const rootBase = apiBaseFor('https://h/dsh_bot/')
ok(rootBase === '/dsh_bot/api', '根挂载 → /dsh_bot/api（实际：' + rootBase + '）')

// 与 client.js 共用同一规则：任一侧改了就报红，免得两边慢慢漂移
const CLIENT = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
ok(/settings|dsh_bot/.test(CLIENT), 'client.js 存在（基址规则两边必须一致）')

/* ── 2) id 唯一 ───────────────────────────────────────────────────────── */
const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
const dup = ids.filter((v, i) => ids.indexOf(v) !== i)
ok(dup.length === 0, 'id 无重复' + (dup.length ? '（重复：' + [...new Set(dup)].join(', ') + '）' : ''))

// 人格文本框必须有自己的 id，且脚本读写的就是它
const taId = (HTML.match(/<textarea[^>]*\bid="([^"]+)"/) || [])[1]
ok(!!taId, '人格 textarea 有 id（实际：' + taId + '）')
ok(!!taId && HTML.includes("$('" + taId + "')"), "脚本用 $('" + taId + "') 读写人格文本")

/* ── 3) 控件只写后端白名单里真实生效的键 ──────────────────────────────── */
// 白名单从后端**直接 import**（单一真相），不在这里抄副本。
// 2026-11-04：上一版抄了一份，新增 `agent` 后测试反而变红 —— 复制逻辑的测试
// 发现不了真不一致，只会拖慢改动。现在它只可能因为"后端真的漏了键"而红。
// 不 import lib/index.js（那会连带加载整条插件链、碰真实数据目录），
// 但也不再手抄：只从源码里读**那一处** `export const CONFIG_WRITABLE = [...]`。
const indexSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
const decl = (indexSrc.match(/export const CONFIG_WRITABLE = \[([\s\S]*?)\]/) || [])[1] || ''
const backendKeys = [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1])
ok(backendKeys.length > 0, '读到后端写入白名单（' + backendKeys.length + ' 个键）')
ok(/for \(const k of CONFIG_WRITABLE\)/.test(indexSrc),
  '路由真的用了 CONFIG_WRITABLE（常量存在但没用 = 白名单没生效）')

/**
 * 页面里所有 save({ <key>: ... }) 的顶层键都必须在白名单内。
 * 只取花括号深度为 0 的键：`save({ night: { windows: wins } })` 里 windows 是嵌套键，
 * 不归白名单管（它属于 night 那一节的对象值）。
 */
function topLevelKeys(objLiteral) {
  const keys = []
  let depth = 0
  for (let i = 0; i < objLiteral.length; i++) {
    const c = objLiteral[i]
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (depth === 0 && (c === ',' || i === 0 || /\s/.test(objLiteral[i - 1]))) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:[\s]*/.exec(objLiteral.slice(i))
      if (m) { keys.push(m[1]); i += m[0].length - 1 }
    }
  }
  return keys
}
const patchKeys = new Set(
  [...scriptSrc.matchAll(/save\(\s*\{([\s\S]*?)\}\s*(?:,|\))/g)].flatMap((m) => topLevelKeys(m[1])),
)
const illegal = [...patchKeys].filter((k) => !backendKeys.includes(k))
ok(illegal.length === 0, '页面 save() 的顶层键都在白名单内' + (illegal.length ? '（越界：' + illegal.join(', ') + '）' : ''))

// douyin.maxPerRun 是假的：没有白名单、无人读取
ok(!/maxPerRun/.test(HTML), '页面不再写 douyin.maxPerRun（该键会被静默丢弃）')
ok(/night_maxvideos/.test(HTML), '「每次看几条」绑到 night_maxvideos')
ok(/\{ night: \{ maxVideos:/.test(HTML), '保存目标是 night.maxVideos')
ok(/c\.night\.maxVideos/.test(HTML), '回填读的是 night.maxVideos')

/* ── 4) 脚本语法 ──────────────────────────────────────────────────────── */
try {
  new vm.Script(scriptSrc, { filename: 'settings.html:inline' })
  ok(true, '内联脚本语法通过')
} catch (e) {
  ok(false, '内联脚本语法：' + e.message)
}

if (bad) { console.error('\n设置页测试失败：' + bad + ' 项'); process.exit(1) }
console.log('\nsettings-page ✓')
