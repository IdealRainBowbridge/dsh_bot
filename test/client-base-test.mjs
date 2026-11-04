/**
 * 客户端 API 基址测试 —— 2026-11-04 回归锚点。
 *
 * 现象：面板挂在 /deepseekharness/ 子路径下时，client.js 写死 "/dsh_bot/api"，
 * 请求打到站点根 → 404，整页「载入失败」。
 *
 * 这里钉住：基址从「注入自己的 <script src="…plugins/??dsh_bot/client.js…">」
 * 反推，根挂载与子路径挂载都要落在正确前缀上。
 *
 * 跑法：node test/client-base-test.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

let bad = 0
const ok = (c, label) => { console.log((c ? '  ✓ ' : '  ✗ ') + label); if (!c) bad++ }

/** 装一套最小 DOM 桩，按给定 script src 跑一遍 client.js，返回它请求的 URL。 */
async function probe(scriptSrc, baseURI) {
  delete globalThis.__spec
  const calls = []
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
  globalThis.document = {
    baseURI,
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    querySelectorAll: () => [{ src: scriptSrc }],
  }
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => '{}' } }
  globalThis.AbortSignal = globalThis.AbortSignal || { timeout: () => null }

  // 每次在新上下文里求值：client.js 顶层就读 document，用 require 会被模块缓存吃住
  vm.runInThisContext(SRC, { filename: 'client.js' })
  // 极简 hooks：useEffect 收集起来，渲染后统一跑（否则不会发请求）
  const effects = []
  const mod = loaded.factory(() => ({
    createElement: (type, props, ...kids) => {
      const flat = kids.flat(Infinity)
      const merged = Object.assign({}, props || {})
      if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
      if (typeof type === 'function') return type(merged)
      return { type, props: merged, children: flat }
    },
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (f) => f,
    useRef: (v) => ({ current: v }),
  }))
  // 直接调 api() 不可达（闭包内），走面板首屏：它必然拉 /config
  let Component = null
  mod.apply({ slots: { inject: (_s, fn) => fn(), register: (_o, C) => { Component = C } } })
  if (typeof Component === 'function') {
    try { Component({ close: () => {} }) } catch (e) { /* 桩不完整时的渲染异常与基址无关 */ }
    for (const fn of effects) { try { fn() } catch (e) { /* 同上 */ } }
  }
  await new Promise((r) => setTimeout(r, 50))
  return calls
}

// 1) 子路径挂载（本次故障现场）
let calls = await probe('https://h/deepseekharness/plugins/??dsh_bot/client.js&rev=abc', 'https://h/deepseekharness/')
ok(calls.length > 0, '子路径挂载：确实发出了请求')
ok(calls.some((u) => String(u).startsWith('/deepseekharness/dsh_bot/api')), '子路径挂载 → /deepseekharness/dsh_bot/api（实际：' + calls[0] + '）')
ok(!calls.some((u) => String(u).startsWith('/dsh_bot/api')), '子路径挂载下不再打到站点根')

// 2) 根挂载（原行为不能退化）
calls = await probe('https://h/plugins/??dsh_bot/client.js&rev=abc', 'https://h/')
ok(calls.some((u) => String(u) === '/dsh_bot/api/config'), '根挂载 → /dsh_bot/api/config（实际：' + calls[0] + '）')

// 3) 取不到脚本标签时退回 base
calls = await probe('https://h/unrelated.js', 'https://h/deepseekharness/')
ok(calls.some((u) => String(u).startsWith('/deepseekharness/dsh_bot/api')), '无脚本标签时按 baseURI 推前缀')

if (bad) { console.error('\n基址测试失败：' + bad + ' 项'); process.exit(1) }
console.log('\nclient-base ✓')
