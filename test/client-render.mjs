/**
 * client.js 渲染测试 —— 用一个极小的 hooks 运行时 + 假 fetch，
 * 把「大肥鱼」设置页真正渲染一遍（含数据回来后的一次重渲染），
 * 目的是在没起 DSH 的情况下抓出 TypeError / 白屏这类问题。
 *
 * 跑法：node test/client-render.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 假数据：和真实 /api/* 返回同形状 ──────────────────────────────────────
const CONFIG = {
  platforms: { bilibili: true, qq: true, wechat: false, douyin: true },
  owner: { qq: '3082864371', name: '友利奈绪', mid: '3493288510228945', wechat: '' },
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 2 }] },
  quota: { shareDaily: 3 },
  douyin: { maxPerRun: 2 },
  qq: { voice_chance: 0.5 },
  voice: { ref_audio_path: 'D:/GPT-SoVITS/models/sunshine_girl/sunshine_girl.wav' },
}
const VOICES = [
  { name: 'sunshine_girl', ref_audio_path: 'D:/GPT-SoVITS/models/sunshine_girl/sunshine_girl.wav', prompt_text: '参考文本', has_prompt: true },
  { name: 'mute', ref_audio_path: 'D:/GPT-SoVITS/models/mute/mute.wav', prompt_text: '', has_prompt: false },
]
const RESPONSES = {
  '/dsh_bot/api/config': { ok: true, config: CONFIG, voices: VOICES, configPath: 'C:/Users/x/.dsh/bot.config.json' },
  '/dsh_bot/api/persona': { ok: true, text: '我是大肥鱼。' },
  '/dsh_bot/api/memory': {
    ok: true,
    stats: { episodes: 12, lore: 3, facts: 4 },
    recent: [
      { role: 'user', text: '在吗', chatId: 'qq:3082864371', platform: 'qq' },
      { role: 'assistant', text: '在的，主人。', chatId: 'qq:3082864371', platform: 'qq' },
    ],
  },
  '/dsh_bot/api/status': {
    ok: true, today: '2026-10-24', scheduler: { ok: true, reason: '已启动' },
    sharesToday: 1, sharesMax: 3, commentsToday: 4, mood: { value: 62, hunger: 12 },
    dryRun: false, selftestPassed: true, ownerSet: true, configPath: 'C:/Users/x/.dsh/bot.config.json',
    // 2026-11-04：接管实况（面板要能显示"到底成没成"，而不只是"开关开没开"）
    takeover: { enabled: true, registered: true, chars: 1826, blocks: ['core', 'persona', 'identity'], missingPersona: false,
      persona: { ok: true, reason: '', chars: 2894 }, verified: true, verifyReason: 'sole-complete-section' },
    bridge: { registered: true, reason: 'ok', tools: ['bot_recall', 'bot_remember', 'bot_state', 'bot_diary', 'bot_tell_owner', 'bot_act'],
      cli: { names: 49, source: 'parsed' }, memory: { attached: true, state: null } },
  },
  '/dsh_bot/api/services': { ok: true, services: { qq: { running: true, pid: 1234 }, wechat: { running: false, pid: null } } },
}

// ── 极小 React ────────────────────────────────────────────────────────────
function createElement(type, props, ...children) {
  const flat = []
  for (const c of children.flat(Infinity)) flat.push(c)
  const merged = Object.assign({}, props || {})
  if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
  // 函数组件就地展开（Card / Row / Switch 都不带 hooks，展开是安全的）
  if (typeof type === 'function') return type(merged)
  return { type, props: merged, children: flat }
}

const state = []
const effects = []
let hookIndex = 0
let dirty = false

const reactStub = {
  createElement,
  useState(init) {
    const i = hookIndex++
    if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
    return [state[i], (v) => {
      const next = typeof v === 'function' ? v(state[i]) : v
      if (next !== state[i]) { state[i] = next; dirty = true }
    }]
  },
  useEffect(fn, deps) {
    const i = hookIndex++
    const prev = effects[i]
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
    if (!changed) return
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    const cleanup = fn()
    effects[i] = { deps, cleanup }
  },
  useCallback(fn, deps) {
    const i = hookIndex++
    const prev = state[i]
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
    if (changed) state[i] = { deps, fn }
    return state[i].fn
  },
  useRef(v) { const i = hookIndex++; if (!(i in state)) state[i] = { current: v }; return state[i] },
}

// ── 环境桩 ────────────────────────────────────────────────────────────────
globalThis.window = { __ModuleLoader__: { load(spec) { globalThis.__spec = spec } } }
const styleTags = []
globalThis.document = {
  head: { appendChild: (el) => styleTags.push(el) },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
}
let fetchCalls = []
globalThis.fetch = async (url) => {
  fetchCalls.push(url)
  const data = RESPONSES[url]
  if (!data) return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, error: 'no fixture: ' + url }) }
  return { ok: true, status: 200, text: async () => JSON.stringify(data) }
}
globalThis.setTimeout = ((orig) => (fn, ms) => (ms > 500 ? 0 : orig(fn, ms)))(globalThis.setTimeout)

// ── 装载 client.js，取出注册的组件 ────────────────────────────────────────
require(path.join(root, 'client.js'))
const spec = globalThis.__spec
assert.ok(spec, 'client.js 没有调用 __ModuleLoader__.load')

let Component = null
const mod = spec.factory((n) => {
  if (n === 'react') return reactStub
  throw new Error('未预期的 require：' + n)
})
mod.apply({
  slots: {
    inject: (_slot, fn) => fn(),
    register: (_opts, C) => { Component = C; return () => {} },
  },
})
assert.equal(typeof Component, 'function', '没拿到注册的组件')

// ── 渲染直到稳定（数据回来后会有一次重渲染）────────────────────────────────
const flush = () => new Promise((r) => setTimeout(r, 0))
let tree = null
for (let pass = 0; pass < 12; pass++) {
  hookIndex = 0
  dirty = false
  tree = Component({ close: () => {} })
  await flush()
  await flush()
  if (!dirty) break
}

const dump = JSON.stringify(tree)
const textOf = (node) => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const kids = (node.children || []).map(textOf).join(' ')
  const inner = node.props && node.props.children != null ? ' ' + String(node.props.children) : ''
  return kids + inner
}
const allText = (node) => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const own = node.props ? Object.entries(node.props)
    .filter(([k, v]) => typeof v === 'string' && k !== 'className' && k !== 'style')
    .map(([, v]) => v).join(' ') : ''
  return own + ' ' + (node.children || []).map(allText).join(' ')
}

assert.ok(!dump.includes('载入失败'), '不该走到错误态：' + allText(tree).slice(0, 200))
const text = allText(tree)
for (const must of ['大肥鱼', '运行状态', '平台开关', '主人', '音色', '微信', '作息与限额', '角色设定', '记忆库']) {
  assert.ok(text.includes(must), '缺少区块：' + must)
}
for (const must of ['3082864371', 'sunshine_girl', '20:00', '在的，主人。', '运行中']) {
  assert.ok(text.includes(must), '缺少数据：' + must)
}
// 三个平台开关（B站/QQ/微信，在 .fy-grid 里），另外微信卡片还有一个「自己判断该不该接」的开关
const collect = (node, predicate, acc = []) => {
  if (!node || typeof node !== 'object') return acc
  if (node.props && predicate(node)) acc.push(node)
  for (const k of node.children || []) collect(k, predicate, acc)
  return acc
}
const platforms = collect(tree, (n) => n.props.className === 'fy-grid')
assert.equal(platforms.length, 1, '平台开关网格应该只有一个')
const switches = collect(platforms[0], (n) => String(n.props.className || '').includes('fy-switch'))
assert.equal(switches.length, 3, '平台开关数量应为 3（B站/QQ/微信），实际 ' + switches.length)
assert.equal(switches.filter((n) => n.props.className.includes("on")).length, 2, "默认应有 2 个平台开启（B站/QQ）")
const allSwitches = collect(tree, (n) => String(n.props.className || '').includes('fy-switch'))
// 不再钉"全页一共几个开关"：那是个纯计数，每次加控件都要改，改的人只会照数字改，
// 永远发现不了真问题（2026-11-04 新增接管开关时它就红了一次，而页面完全正常）。
// 改为钉**可访问性和可点性**：每个开关渲染成 role=switch + aria-checked，且带 onClick。
const broken = allSwitches.filter((n) =>
  n.props.role !== 'switch' || n.props['aria-checked'] === undefined || typeof n.props.onClick !== 'function')
assert.equal(broken.length, 0, '每个开关都要 role=switch / aria-checked / onClick，实际坏 ' + broken.length + ' 个')
assert.ok(allSwitches.length >= 20, '开关数量不应骤减（现有 ' + allSwitches.length + ' 个）')

// 接管实况三块（2026-11-04）：面板必须能显示"真的生效了"而不是只有开关状态。
// 只钉标签与关键值，不钉样式 —— 钉样式等于把每次视觉调整变成红灯。
for (const must of ['人格接管', '能力桥', '人设文件', '生效中', '6 个工具', '正常 · 2894 字符']) {
  assert.ok(text.includes(must), '接管实况缺少：' + must + '（现有文本里没有）')
}

assert.ok(fetchCalls.includes('/dsh_bot/api/config'), '没有请求 /config')
assert.ok(styleTags.length >= 1, '样式没注入')

console.log('client-render ✓  渲染通过：9 个区块 · 3 个平台开关 · 请求', fetchCalls.length, '次')
