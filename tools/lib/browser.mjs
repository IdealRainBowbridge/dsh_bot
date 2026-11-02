// browser —— 大肥鱼内置浏览器引擎（2026-11-02）：她自己的一双看网页的眼睛。
//
// 病根：web fetch 是 curl 扒静态 HTML，JS 渲染的页面（知乎/B站/公众号/SPA）全是空壳，
// 而且只有一种"Windows 电脑"身份 —— 手机版页面永远读不到。
//
// 这套引擎 = 容器里的 chromium（Debian 官方包）+ 纯 Node 手写 CDP 驱动（0 npm 依赖）：
//   · 常驻会话：浏览器进程跨轮次活着；每次使用刷心跳，闲置 10 分钟被看门狗收走
//   · 登录态：存在 ~/.data/browser-profile，下次用还在（要她登就先 type+enter）
//   · 两种身份：pc（Win10 桌面 Chrome）/ mobile（Pixel 7 安卓手机，触摸+3x DPR）/ auto（按域名猜）
//   · 真交互：点击/输入/回车/滚动/后退/截图/续读，不是只能"看"
//   · SSRF 防护：DNS 解析后逐 IP 检查，私网/回环一律拒；例外走配置 browser.allowPrivate
//   · 双保险：CDP 渲染失败时上层（web.mjs）自动落回 curl 扒静态，绝不比以前更差
//
// 需要：chromium（apt 装）+ Node ≥ 22.4（自带全局 WebSocket，太老会提示）。
import fs from 'node:fs'
import path from 'node:path'
import dns from 'node:dns/promises'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'
import { acquire } from './lock.mjs'
import { swallow } from './swallow.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── 设备身份（电脑 / 手机两种识别）───────────────────────────────────────────
// UA 对齐 2026 年主流版本；mobile 同时开触摸仿真 + 3x DPR，站点拿到的就是一台真手机。
export const DEVICES = {
  pc: {
    label: '电脑',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'Win32', mobile: false,
    width: 1440, height: 900, dsf: 1, touch: false,
  },
  mobile: {
    label: '手机',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', mobile: true,
    width: 390, height: 844, dsf: 3, touch: true,
  },
}

/** auto：看域名猜 —— m./wap./i./h5. 开头、公众号/手机站常见域 → 手机，其余 → 电脑 */
const MOBILE_HOST_HINTS = [/^m\./, /^wap\./, /^i\./, /^h5\./, /mp\.weixin\.qq\.com$/, /weibo\.cn$/, /zhihu\.com$/]
export function pickDevice(url, want) {
  if (want === 'pc' || want === 'mobile') return want
  try {
    const host = new URL(url).hostname
    if (MOBILE_HOST_HINTS.some((re) => re.test(host))) return 'mobile'
  } catch (e) { swallow(e, 'browser:pickDevice') }
  return 'pc'
}

// ── SSRF 防护：只准去公网 ───────────────────────────────────────────────────
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase()
    return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a >= 224
}

/** 拒绝私网目标。DNS 解析加 5s 硬超时（容器 DNS 对某些境外域会挂 25s）；
 *  配了代理时解析不动就放行 —— chromium 走 --proxy-server 时域名由代理解析，
 *  本地 DNS 失败不代表到不了；没配代理才真拒绝。 */
export async function guardUrl(raw) {
  let u
  try { u = new URL(String(raw)) } catch { throw new Error('链接读不懂：' + String(raw).slice(0, 80)) }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http(s) 链接：' + u.href.slice(0, 80))
  const cfg = config().browser ?? {}
  const hasProxy = !!cfg.proxy
  const allow = (cfg.allowPrivate ?? []).some((h) => u.hostname === h || u.hostname.endsWith('.' + h))
  if (allow) return u.href
  const isIp = net.isIPv4(u.hostname) || net.isIPv6(u.hostname)
  const ips = !isIp
    ? await Promise.race([
        dns.lookup(u.hostname, { all: true }).then((rs) => rs.map((r) => r.address)).catch(() => []),
        new Promise((r) => setTimeout(() => r([]), 5000)),
      ])
    : [u.hostname]
  if (!ips.length) {
    if (hasProxy) return u.href   // 代理会自己解析（实测：容器 DNS 对部分境外域挂死）
    throw new Error('域名解析不了（没网或写错了）：' + u.hostname)
  }
  const bad = ips.find((ip) => isPrivateIp(ip))
  if (bad) throw new Error(`这是内网地址（${bad}），不进浏览器 —— 想看内网就把它写进配置 browser.allowPrivate`)
  return u.href
}

// ── 会话守护：chromium 常驻 + 心跳 + 看门狗 ─────────────────────────────────
const PORT_FILE = () => dataPath('browser-daemon.json')
const PROFILE_DIR = () => dataPath('browser-profile')
const SHOT_DIR = () => dataPath('browser-shots')
const CHROME_BIN = () => (config().browser?.chromiumBin || 'chromium')
const IDLE_EXIT_MS = 10 * 60_000

let CHROME_ARGS_BASE = null // 首次启动时按配置固化（含 proxy），进程活着期间不再变
function chromeArgs() {
  if (!CHROME_ARGS_BASE) {
    const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--lang=zh-CN',
      '--remote-debugging-port=0', `--user-data-dir=${PROFILE_DIR()}`]
    const proxy = config().browser?.proxy
    if (proxy) args.push(`--proxy-server=${proxy}`)
    CHROME_ARGS_BASE = args
  }
  return CHROME_ARGS_BASE
}

function readDaemon() {
  try { return JSON.parse(fs.readFileSync(PORT_FILE(), 'utf8')) } catch { return null }
}
function writeDaemon(st) {
  try { fs.mkdirSync(path.dirname(PORT_FILE()), { recursive: true }); fs.writeFileSync(PORT_FILE(), JSON.stringify(st, null, 1)) } catch (e) { swallow(e, 'browser:writeDaemon') }
}
/** 每次真实使用都刷心跳 —— 看门狗只看这个字段决定要不要收走浏览器 */
function touchDaemon(pid) {
  const st = readDaemon()
  if (st && st.pid === pid) writeDaemon({ ...st, at: Date.now() })
}
/** 记住"当前页"：CLI 是一次性进程，tab 归属必须落在档案文件里跨进程传，
 *  不然下一个命令起来是空记忆，会另开一个空白页去点东西（真踩过）。 */
function setCurrentTab(tab) {
  const st = readDaemon()
  if (st) writeDaemon({ ...st, current: { targetId: tab.targetId, device: tab.device, url: tab.url || '', at: Date.now() } })
}

/** 探活：daemon 档案新鲜且 CDP 端口答话，返回 {port, ws, pid} */
export async function probeDaemon() {
  const st = readDaemon()
  if (!st?.port || !st.pid) return null
  if (Date.now() - (st.at ?? 0) > 30 * 60_000) return null   // 心跳太老 = 看门狗也死了的僵尸，别认
  try {
    const r = await fetch(`http://127.0.0.1:${st.port}/json/version`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    const j = await r.json()
    return { port: st.port, ws: j.webSocketDebuggerUrl, pid: st.pid }
  } catch {
    return null   // 端口不应答 = 进程已死，档案下次 launch 覆盖
  }
}

/** 独立看门狗：每分钟查一次心跳，闲置超时把 chromium 收走，然后自己退出。
 *  （不能靠启动者的 setTimeout —— 启动命令一退出定时器就跟着死了。） */
function spawnIdleReaper(pid) {
  const js = `const fs=require('fs');const f=${JSON.stringify(PORT_FILE())};const pid=${pid};
const t=setInterval(()=>{let st=null;try{st=JSON.parse(fs.readFileSync(f,'utf8'))}catch{clearInterval(t);process.exit(0)}
if(st.pid!==pid){clearInterval(t);process.exit(0)}
if(Date.now()-(st.at||0)>${IDLE_EXIT_MS}){try{process.kill(pid,'SIGTERM')}catch{}clearInterval(t);process.exit(0)}},60000)`
  try {
    const c = spawn(process.execPath, ['-e', js], { detached: true, stdio: 'ignore' })
    c.unref()
  } catch (e) { swallow(e, 'browser:reaper') }
}

/** 拉起 chromium 并等 CDP 就绪（DevToolsActivePort 文件里有真端口）。失败返回 null。 */
async function launchDaemon() {
  const release = acquire('browser-daemon')
  if (!release) return probeDaemon()   // 别的实例正在拉起，直接探它
  try {
    fs.mkdirSync(PROFILE_DIR(), { recursive: true })
    const child = spawn(CHROME_BIN(), chromeArgs(), { stdio: 'ignore' })
    child.unref()   // chromium 要常驻，但**别把 CLI 的事件循环拖住**（不然命令跑完还得干等 45s 定时器）
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return null   // 起了就崩：多半缺依赖
      await new Promise((r) => setTimeout(r, 300))
      try {
        const port = Number(fs.readFileSync(path.join(PROFILE_DIR(), 'DevToolsActivePort'), 'utf8').split('\n')[0])
        if (port > 0) {
          const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
          if (r.ok) {
            const j = await r.json()
            writeDaemon({ port, pid: child.pid, at: Date.now() })
            spawnIdleReaper(child.pid)
            return { port, ws: j.webSocketDebuggerUrl, pid: child.pid }
          }
        }
      } catch (e) { swallow(e, 'browser:launchWait') }
    }
    try { child.kill('SIGKILL') } catch (e) { swallow(e, 'browser:launchKill') }
    return null
  } finally {
    release()
  }
}

// ── CDP 通道（浏览器级 ws + 每 tab 一个扁平 sessionId）──────────────────────
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()   // id → {resolve, reject}
    this.events = []           // 没人等的事件先存着（封顶防泄漏）
    this.waiters = []          // 等事件的人
    this.inflight = new Map()  // sessionId → 在途网络请求数
    this.open = true
    // undici 的 WebSocket 是异步连接：new 完不能立刻 send，必须等 open
    this.ready = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP 连不上')), { once: true })
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result) }
      } else if (msg.method) {
        // 网络在途请求计数（settle 判"网络安静"用）—— 只计数不进事件缓存，免得刷爆
        if (msg.method === 'Network.requestWillBeSent') this.inflight.set(msg.sessionId, (this.inflight.get(msg.sessionId) || 0) + 1)
        else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed')
          this.inflight.set(msg.sessionId, Math.max(0, (this.inflight.get(msg.sessionId) || 0) - 1))
        if (!msg.method.startsWith('Network.')) {
          const w = this.waiters.findIndex((x) => x.match(msg))
          if (w >= 0) { const [hit] = this.waiters.splice(w, 1); hit.resolve(msg) }
          else {
            this.events.push(msg)
            if (this.events.length > 320) this.events.splice(0, this.events.length - 200)   // 常驻进程防泄漏
          }
        }
      }
    })
    ws.addEventListener('close', () => {
      this.open = false
      for (const p of this.pending.values()) p.reject(new Error('CDP连接断了'))
      this.pending.clear()
    })
    ws.addEventListener('error', () => {})
  }
  send(method, params = {}, sessionId) {
    if (!this.open) return Promise.reject(new Error('CDP连接已关闭'))
    const id = this.nextId++
    return this.ready.then(() => new Promise((resolve, reject) => {
      // 45s 超时看门狗：响应回来就清掉；再 unref 双保险 —— 不然 CLI 跑完了
      // 进程还被最后一个请求的定时器吊着 45s 不退出（真事）
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')) } }, 45_000)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    }))
  }
  /** 等一个还没来的事件（已经到的翻缓存） */
  waitEvent(match, timeoutMs) {
    const i = this.events.findIndex((m) => match(m))
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0])
    if (!(timeoutMs > 0)) return Promise.reject(new Error('等事件超时'))
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x.resolve !== go); reject(new Error('等事件超时')) }, timeoutMs)
      const go = (m) => { clearTimeout(t); resolve(m) }
      this.waiters.push({ match, resolve: go })
    })
  }
}

let cdp = null          // 浏览器级连接
let cdpPid = null       // 它所属的 chromium pid（换人了就连新的）

async function connect() {
  if (typeof WebSocket === 'undefined') throw new Error('这个 Node 没有 WebSocket（要 ≥22.4）—— 内置浏览器用不了')
  let d = await probeDaemon()
  if (!d) d = await launchDaemon()
  if (!d) throw new Error('浏览器起不来：容器里缺 chromium（docker exec dsh_bot chromium --version 验一下），或配置 browser.chromiumBin 指对了没')
  if (cdp && cdp.open && cdpPid === d.pid) { touchDaemon(d.pid); return { cdp, port: d.port } }
  try { cdp?.ws.close() } catch (e) { swallow(e, 'browser:oldWsClose') }
  cdp = new Cdp(new WebSocket(d.ws))
  cdpPid = d.pid
  await cdp.send('Browser.getVersion').catch(() => {})   // 握手兼探活
  touchDaemon(d.pid)
  return { cdp, port: d.port }
}

/** 解析动作目标：@3 = 第 3 号可交互元素（read 时编的号）；text=登录 = 按可见文本找；其余当 CSS 选择器 */
function parseTarget(t) {
  const s = String(t ?? '').trim()
  if (/^@\d+$/.test(s)) return { by: 'index', n: Number(s.slice(1)) }
  if (s.startsWith('text=')) return { by: 'text', text: s.slice(5) }
  return { by: 'selector', selector: s }
}

/** 多标签：browserRead 每次独立开 tab（不互相抢页面）；交互落在档案里记的"当前页"。
 *  页面总数超 4 个时收掉最旧的（当前页除外）—— GC 靠档案，不靠进程内存。 */
const MAX_TABS = 4

async function openTab(conn, device) {
  const { targetId } = await conn.cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await conn.cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await conn.cdp.send('Page.enable', {}, sessionId)
  await conn.cdp.send('Runtime.enable', {}, sessionId)
  await conn.cdp.send('Network.enable', {}, sessionId)   // 在途请求计数（settle 判稳）
  const tab = { targetId, sessionId, device, url: '', at: Date.now() }
  setCurrentTab(tab)
  // GC：档案里没记的杂页 + 超额旧页，收掉（别挡道，失败就算了）
  try {
    const st = readDaemon()
    const keep = new Set([targetId])
    const { targetInfos } = await conn.cdp.send('Target.getTargets')
    const pages = targetInfos.filter((t) => t.type === 'page' && !/^devtools:/.test(t.url))
    let extra = pages.length - MAX_TABS
    for (const t of pages) {
      if (t.targetId === targetId) continue
      if (st?.prevTabs?.includes(t.targetId) && extra <= 0) { keep.add(t.targetId); continue }
      if (extra > 0) { extra--; continue }
      keep.add(t.targetId)
    }
    for (const t of pages) if (!keep.has(t.targetId)) await conn.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {})
    writeDaemon({ ...st, prevTabs: pages.filter((t) => keep.has(t.targetId) && t.targetId !== targetId).map((t) => t.targetId) })
  } catch (e) { swallow(e, 'browser:tabGc') }
  return tab
}

/** 交互落在最近读的那页（档案里记的 targetId，跨 CLI 进程有效） */
async function ensureSession(device) {
  const conn = await connect()
  const st = readDaemon()
  if (st?.current?.targetId) {
    try {
      const { targetInfos } = await conn.cdp.send('Target.getTargets')
      const hit = targetInfos.find((t) => t.targetId === st.current.targetId && t.type === 'page')
      if (hit) {
        const { sessionId } = await conn.cdp.send('Target.attachToTarget', { targetId: st.current.targetId, flatten: true })
        await conn.cdp.send('Page.enable', {}, sessionId)
        await conn.cdp.send('Runtime.enable', {}, sessionId)
        curDevice = st.current.device || device
        touchDaemon(st.pid)
        return { targetId: st.current.targetId, sessionId, device: curDevice, url: st.current.url, conn }
      }
    } catch (e) { swallow(e, 'browser:ensureReattach') }
  }
  // 没有当前页（或已关）—— 开一个新的空页（caller 里没有元素可点会自然提示先 read）
  const t = await openTab(conn, device)
  await emulateDevice(conn, t.sessionId, device)
  curDevice = device
  return { ...t, conn }
}

// ── 页面动作 ────────────────────────────────────────────────────────────────
async function emulateDevice(conn, sessionId, device) {
  const d = DEVICES[device]
  await conn.cdp.send('Emulation.setUserAgentOverride', {
    userAgent: d.ua, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6', platform: d.platform,
    userAgentMetadata: {
      brands: [
        { brand: 'Not?A_Brand', version: '99' },
        { brand: 'Chromium', version: '130' },
        { brand: 'Google Chrome', version: '130' },
      ],
      fullVersion: '130.0.0.0', mobile: d.mobile,
      platform: d.mobile ? 'Android' : 'Windows',
      platformVersion: d.mobile ? '14.0.0' : '10.0.0',
      architecture: d.mobile ? '' : 'x86', model: d.mobile ? 'Pixel 7' : '',
    },
  }, sessionId)
  await conn.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: d.width, height: d.height, deviceScaleFactor: d.dsf, mobile: d.mobile,
    screenWidth: d.width, screenHeight: d.height,
  }, sessionId)
  // 触摸仿真：开的时候带 maxTouchPoints；关的时候不能发 0（CDP 校验 1..16）
  await conn.cdp.send('Emulation.setTouchEmulationEnabled',
    d.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }, sessionId)
}

/** 等页面"安静"：load 事件 + readyState=complete + 连续两次 DOM 稳定 + **网络在途请求清零**。
 *  旧版只看 DOM 节点数——SPA 首屏 DOM 早就不变了，但 XHR 还在陆陆续续往里塞东西，
 *  读到的永远是半成品。现在加上网络安静判定，读到的至少是"这轮请求都回来了一拍"的页面。 */
async function settle(conn, sessionId, waitMs) {
  const deadline = Date.now() + Math.max(3000, Number(waitMs) || 8000)
  try { await conn.cdp.waitEvent((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId, Math.max(1000, deadline - Date.now())) } catch (e) { swallow(e, 'browser:loadWait') }
  let lastCount = -1
  let lastNet = -1
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const r = await conn.cdp.send('Runtime.evaluate', {
        expression: '({rs: document.readyState, n: document.getElementsByTagName("*").length, u: location.href})',
        returnByValue: true,
      }, sessionId)
      const v = r.result?.value ?? {}
      const net = conn.cdp.inflight.get(sessionId) || 0
      if (v.rs === 'complete' && v.n === lastCount && v.n > 0 && net === 0 && lastNet === 0) return v.u
      lastCount = v.n
      lastNet = net
    } catch (e) { swallow(e, 'browser:settle') }
  }
  return ''
}

/** 走 DOM 提正文：跳过导航/脚本/表单，按块密度拼接，标题另取 —— 不依赖第三方库 */
export const EXTRACT_FN = `(() => {
  const BAD = /script|style|noscript|template|svg|canvas|iframe|nav|header|footer|aside|form|button|select|dialog/i
  const isBad = (el) => BAD.test(el.tagName || '') || (el.getAttribute && el.getAttribute('aria-hidden') === 'true')
  const blocks = []
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,p,li,blockquote,pre,figcaption,td,dd,dt')) {
    if (isBad(el) || (!el.offsetParent && el.tagName !== 'BODY')) continue
    let t = (el.innerText || el.textContent || '').replace(/[ \\t\\r]+/g, ' ').replace(/\\n+/g, '\\n').trim()
    if (!t) continue
    if (el.tagName !== 'PRE' && t.length > 500) continue
    if (el.tagName === 'LI' && t.length < 4) continue
    if (el.parentElement && ['P','LI','BLOCKQUOTE','TD'].includes(el.parentElement.tagName) && el.tagName !== 'PRE') continue
    blocks.push({ tag: el.tagName.toLowerCase(), y: Math.round(el.getBoundingClientRect().top + window.scrollY), text: t })
  }
  blocks.sort((a, b) => a.y - b.y)
  const seen = new Set(); const lines = []
  for (const b of blocks) {
    const key = b.text.slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    lines.push((/^h[1-4]$/.test(b.tag) ? '\\n## ' : '') + b.text)
  }
  return { title: document.title || '', url: location.href, text: lines.join('\\n') }
})()`

/** 可交互元素编号（browser_use 风格）：读页时顺手把可点/可填的东西编上号，
 *  她点东西不用写选择器 —— click @3 就行。编号存在页面里（chromium 常驻所以跨命令存活），
 *  CLI 进程虽是一次性的，编号不丢。 */
export const ELEMENTS_FN = `(() => {
  const VIS = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const BAD = /script|style|noscript|template|svg|nav\\b|header|footer|aside/i
  const cands = []
  const labelOf = (el) => {
    let label = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ')
    if (!label && el.tagName === 'INPUT') label = el.type === 'password' ? '密码框' : (el.value ? '输入框(已有值)' : '输入框')
    if (!label && el.tagName === 'TEXTAREA') label = '文本域'
    if (!label && el.tagName === 'SELECT') label = '下拉框'
    if (el.type === 'checkbox') label = (label || '勾选') + (el.checked ? '（已勾）' : '')
    return String(label || '').slice(0, 60)
  }
  const push = (el, kind) => {
    if (!el || cands.length > 300) return
    if (BAD.test(el.tagName || '') || el.closest('[aria-hidden=true]')) return
    if (!VIS(el)) return
    const label = labelOf(el)
    if (!label) return
    const r = el.getBoundingClientRect()
    cands.push({ el, kind, label, x: Math.round(r.left), y: Math.round(r.top + window.scrollY) })
  }
  for (const el of document.querySelectorAll('a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],summary'))
    if (!el.querySelector('a[href],button')) push(el, 'click')   // 套娃的只留外层
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select,[contenteditable=true]'))
    push(el, el.tagName === 'SELECT' ? 'select' : 'type')
  // 去重（同标签同位置只留一个）+ 按页面顺序编号
  const seen = new Set(); const uniq = []
  for (const c of cands) { const k = c.kind + '|' + c.label + '|' + c.x + ',' + c.y; if (seen.has(k)) continue; seen.add(k); uniq.push(c) }
  uniq.sort((a, b) => a.y - b.y || a.x - b.x)
  window.__feiyuElEls = uniq
  window.__feiyuEls = uniq.map((c, i) => ({ n: i + 1, kind: c.kind, label: c.label }))
  return window.__feiyuEls
})()`

/** 读当前页（正文 + 标题 + 可选链接 + 可交互元素编号）。maxChars 截断防刷屏，offset 续读。 */
async function readPage(conn, sessionId, opts = {}) {
  const { maxChars = 8000, offset = 0, links = false, elements = true } = opts
  const r = await conn.cdp.send('Runtime.evaluate', { expression: EXTRACT_FN, returnByValue: true }, sessionId)
  const v = r.result?.value ?? { title: '', url: '', text: '' }
  let text = String(v.text || '')
  // 兜底：结构化提取太短（百度移动版这种整页 div 的站点）就拿 body.innerText 顶上
  let fallback = false
  if (text.replace(/\s/g, '').length < 60) {
    try {
      const fr = await conn.cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({t: (document.body && document.body.innerText) || ''})`,
        returnByValue: true,
      }, sessionId)
      const bt = String(JSON.parse(fr.result?.value || '{}').t || '')
        .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
      if (bt.replace(/\s/g, '').length > text.replace(/\s/g, '').length) { text = bt; fallback = true }
    } catch (e) { swallow(e, 'browser:fallback') }
  }
  let more = false
  if (offset > 0) text = text.slice(offset)
  if (text.length > maxChars) { text = text.slice(0, maxChars); more = true }
  const out = { title: v.title || '', url: v.url || '', text, more, ...(fallback ? { fallback: true } : {}) }
  if (more) out.nextOffset = offset + maxChars
  if (elements) {
    try {
      const er = await conn.cdp.send('Runtime.evaluate', { expression: ELEMENTS_FN, returnByValue: true }, sessionId)
      out.elements = (er.result?.value ?? []).slice(0, 80)
    } catch (e) { swallow(e, 'browser:elements') }
  }
  if (links) {
    const lr = await conn.cdp.send('Runtime.evaluate', {
      expression: `(() => { const out=[]; for (const a of document.querySelectorAll('a[href]')) { const h=a.href; if(!/^https?:/.test(h)) continue; const t=(a.innerText||'').trim(); if(t && out.length<60) out.push({href:h, text:t.slice(0,50)}) } return out })()`,
      returnByValue: true,
    }, sessionId)
    out.links = (lr.result?.value ?? []).slice(0, 60)
  }
  return out
}

// ── 对外入口 ────────────────────────────────────────────────────────────────
let curDevice = null   // 最近读的那页的身份

/** 登录墙特征：命中说明"要登录"，重试一次（SPA 慢热），还不行就明说怎么登 */
const LOGIN_MARKERS = ['登录后你可以', '扫码登录', '请先登录', '登录/注册', '请登录后', '登录查看']

/** 读一个网页：独立开 tab → 导航 → 等渲染 → 提正文+元素编号。CDP 全挂时抛错（上层落回 curl）。
 *  full=true 先把页面滑到底再回来（懒加载的"上滑加载更多"全喂出来）。 */
export async function browserRead(url, { device = 'auto', waitMs = 8000, maxChars = 8000, offset = 0, links = false, full = false } = {}) {
  const href = await guardUrl(url)
  const wanted = device === 'auto' ? null : device   // 显式指定就不自动换身份
  let dev = pickDevice(href, device)
  const conn = await connect()
  const tab = await openTab(conn, dev)
  await emulateDevice(conn, tab.sessionId, dev)
  curDevice = dev
  try {
    await conn.cdp.send('Page.navigate', { url: href }, tab.sessionId)
  } catch (e) { throw new Error('打开失败：' + String(e.message).slice(0, 100)) }
  await settle(conn, tab.sessionId, waitMs)
  if (full) {
    await conn.cdp.send('Runtime.evaluate', { expression: `(() => { window.__fyAuto = 0; return true })()`, returnByValue: true }, tab.sessionId).catch(() => {})
    for (let i = 0; i < 6; i++) {
      await conn.cdp.send('Runtime.evaluate', { expression: `window.scrollBy(0, document.body.scrollHeight * 0.8); true`, returnByValue: true }, tab.sessionId).catch(() => {})
      await new Promise((r) => setTimeout(r, 900))
    }
    await conn.cdp.send('Runtime.evaluate', { expression: `window.scrollTo(0, 0); true`, returnByValue: true }, tab.sessionId).catch(() => {})
    await settle(conn, tab.sessionId, 4000).catch(() => {})
  }
  let page = await readPage(conn, tab.sessionId, { maxChars, offset, links })
  // iframe 嵌入正文（公众号/门户常见）：同源 iframe 的文本拼到后面
  try {
    const ir = await conn.cdp.send('Runtime.evaluate', { expression: IFRAME_FN, returnByValue: true }, tab.sessionId)
    const ft = String(ir.result?.value || '')
    if (ft && !page.text.includes(ft.slice(0, 80))) page.text = (page.text ? page.text + '\n\n' : '') + ft
  } catch (e) { swallow(e, 'browser:iframe') }
  // 登录墙/慢热 SPA：白等一拍再读一次，多数"第一下空"的页就出来了
  const joined = page.text || ''
  if ((joined.replace(/\s/g, '').length < 200 || LOGIN_MARKERS.some((m) => joined.includes(m))) && !full) {
    await settle(conn, tab.sessionId, Math.min(waitMs + 4000, 15000))
    const again = await readPage(conn, tab.sessionId, { maxChars, offset, links })
    if (again.text.replace(/\s/g, '').length > page.text.replace(/\s/g, '').length) page = again
  }
  tab.url = page.url || href
  setCurrentTab(tab)
  touchDaemon(readDaemon()?.pid)
  // 双身份互救：auto 模式下第一遍几乎没内容、也没登录墙 → 换另一种身份重开一次（有些站只认电脑版/手机版）
  if (!wanted && page.text.replace(/\s/g, '').length < 80 && !LOGIN_MARKERS.some((m) => (page.text || '').includes(m))) {
    const alt = dev === 'pc' ? 'mobile' : 'pc'
    try {
      const tab2 = await openTab(conn, alt)
      await emulateDevice(conn, tab2.sessionId, alt)
      await conn.cdp.send('Page.navigate', { url: href }, tab2.sessionId)
      await settle(conn, tab2.sessionId, Math.min(waitMs, 8000))
      const p2 = await readPage(conn, tab2.sessionId, { maxChars, offset, links })
      if (p2.text.replace(/\s/g, '').length > page.text.replace(/\s/g, '').length * 3 && p2.text.replace(/\s/g, '').length >= 80) {
        curDevice = alt
        dev = alt
        page = p2
        tab2.url = page.url || href
        setCurrentTab(tab2)
      } else {
        try { await conn.cdp.send('Target.closeTarget', { targetId: tab2.targetId }) } catch (e) { swallow(e, 'browser:altClose') }
      }
    } catch (e) { swallow(e, 'browser:altRetry') }
  }
  if (!page.text || page.text.replace(/\s/g, '').length < 30) {
    const login = LOGIN_MARKERS.some((m) => (page.text || '').includes(m))
    throw new Error(login
      ? `这页要登录（${page.title || href}）—— browser type @编号 "账号" 输进去，再 browser click text=登录`
      : `页面几乎没内容（${page.title || href}）—— 可以 browser shot 截图看看，或换 --pc/--mobile 重开`)
  }
  return { ...page, device: dev }
}

/** 读当前开着的页（不重新导航）：正文续读 / 看链接 / 刷新元素编号用 */
export async function browserPeek({ maxChars = 8000, offset = 0, links = false, full = false } = {}) {
  const s = await ensureSession(curDevice || 'pc')
  if (full) {
    for (let i = 0; i < 5; i++) {
      await s.conn.cdp.send('Runtime.evaluate', { expression: `window.scrollBy(0, document.body.scrollHeight * 0.8); true`, returnByValue: true }, s.sessionId).catch(() => {})
      await new Promise((r) => setTimeout(r, 800))
    }
    await s.conn.cdp.send('Runtime.evaluate', { expression: `window.scrollTo(0, 0); true`, returnByValue: true }, s.sessionId).catch(() => {})
    await settle(s.conn, s.sessionId, 3000).catch(() => {})
  }
  return readPage(s.conn, s.sessionId, { maxChars, offset, links })
}

/** 交互：click @3|text=登录|.选择器 | type @5 "文字" | enter | key | scroll ±px | back
 *  定位顺序：@编号（read 时发的元素表）→ text=可见文本 → CSS 选择器。
 *  动作完成后自动回一份新的元素表 —— 她不用再 read 一遍就能接着点下一步。 */
export async function browserAct(action, ...args) {
  const s = await ensureSession(curDevice || 'pc')
  const { sessionId, conn } = s
  const ev = (expression) => conn.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
  const note = (target, detail) => { try { logAction(action, target, detail) } catch (e) { swallow(e, 'browser:note') } }
  /** 动作后的元素表回显（编号顺延） */
  async function refreshEls() {
    try {
      const er = await ev(`(${ELEMENTS_FN})()`)
      return (er.result?.value ?? []).slice(0, 30)
    } catch (e) { swallow(e, 'browser:refreshEls'); return [] }
  }
  const fmtEls = (els) => els.length ? '\n' + els.map((e) => `[@${e.n}] ${e.kind === 'type' ? '输入' : ''}${e.label}`).join('\n') : ''

  switch (action) {
    case 'click': {
      const target = String(args[0] || '')
      if (!target) throw new Error('要告诉鱼点哪个：browser click @3 / click text=登录 / click ".选择器"')
      const t = parseTarget(target)
      // 快照要在点击**前**拍（点击开新标签是同步立刻发生的，晚了就 diff 不到）
      const beforeSet = new Set((await conn.cdp.send('Target.getTargets')).targetInfos.map((x) => x.targetId))
      let cr
      if (t.by === 'index') {
        cr = await ev(`(() => { const c=(window.__feiyuElEls||[])[${t.n - 1}]; const el=c && c.el; if(!el) return {ok:false, why:'没这个编号（页面刷新过？target=_blank 链接改用 text= 或选择器定位）', total:(window.__feiyuElEls||[]).length}; if(!el.isConnected) return {ok:false, why:'这个元素已被页面刷掉了（SPA 换了内容）—— 重新 browser read 一次拿新编号'}; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {ok:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), label:(window.__feiyuEls||[])[${t.n - 1}]?.label||''} })()`)
      } else if (t.by === 'text') {
        cr = await ev(`(() => { const want=${JSON.stringify(t.text.toLowerCase())}; const els=[...document.querySelectorAll('a[href],button,[role=button],[role=link],[role=tab],input[type=submit],summary,[onclick],label,span[role],div[role=button]')]; const el=els.find((x)=>{const l=(x.innerText||x.value||x.getAttribute('aria-label')||'').trim().toLowerCase(); return l&&(l===want||l.includes(want))}); if(!el) return {ok:false, why:'页面上没有写着「'+${JSON.stringify(t.text)}+'」的可点元素'}; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {ok:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), label:(el.innerText||el.value||'').trim().slice(0,40)} })()`)
      } else {
        cr = await ev(`(() => { const els=[...document.querySelectorAll(${JSON.stringify(t.selector)})]; const el=els[0]; if(!el) return {ok:false, why:'没找到元素（'+${JSON.stringify(t.selector)}+'）'}; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {ok:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), label:(el.innerText||el.value||el.getAttribute('aria-label')||'').trim().slice(0,40)} })()`)
      }
      const v = cr.result?.value ?? {}
      if (!v.ok) { note(target, '失败：' + (v.justify || v.why || '').slice(0, 60)); throw new Error(v.why || '点击失败') }
      // 真实坐标点击（Input.dispatchMouseEvent = 浏览器当作真人输入，target=_blank 的
      // 新标签页默认行为会生效；el.click() 只派发页面内事件，新页开不出来 —— 冒烟实测抓到的坑）
      const common = { x: v.x, y: v.y, clickCount: 1, pointerType: 'mouse' }
      await conn.cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseMoved' }, sessionId)
      await conn.cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mousePressed', button: 'left' }, sessionId)
      await conn.cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseReleased', button: 'left' }, sessionId)
      // target=_blank 的链接会开新标签页（Bing/百度 SERP 都这样）——像真人一样跟过去，
      // 不然她点了"成功"下一步读到的还是旧页（冒烟实测抓到的坑）
      await settle(conn, sessionId, 4000).catch(() => {})
      try {
        const { targetInfos } = await conn.cdp.send('Target.getTargets')
        const fresh = targetInfos.find((x) => x.type === 'page' && !/^devtools:/.test(x.url) && !beforeSet.has(x.targetId))
        if (fresh) {
          const { sessionId: ns } = await conn.cdp.send('Target.attachToTarget', { targetId: fresh.targetId, flatten: true })
          await conn.cdp.send('Page.enable', {}, ns)
          await conn.cdp.send('Runtime.enable', {}, ns)
          await conn.cdp.send('Network.enable', {}, ns)
          await emulateDevice(conn, ns, curDevice || 'pc')
          const st = readDaemon()
          if (st) { st.current = { targetId: fresh.targetId, device: curDevice || 'pc', url: fresh.url, at: Date.now() }; writeDaemon(st) }
          note(target, '新标签页打开 ' + fresh.url.slice(0, 50))
          const els2 = await refreshEls()
          return `点了「${v.label || target}」→ 在新标签页打开了\n${fmtEls(els2)}`
        }
      } catch (e) { swallow(e, 'browser:followTab') }
      const els = await refreshEls()
      note(target, '点了「' + (v.label || '') + '」')
      return `点了「${v.label || target}」${fmtEls(els)}`
    }
    case 'type': {
      const target = String(args[0] || '')
      const text = String(args.slice(1).join(' ') ?? '')
      if (!target || !text) throw new Error('用法：browser type @5 "要输入的字" 或 type ".选择器" "字"')
      const t = parseTarget(target)
      if (t.by === 'text') throw new Error('输入框没有可见文本，用 @编号 或 .选择器 定位（read 一下就有编号）')
      let tr
      if (t.by === 'index') {
        tr = await ev(`(() => { const c=(window.__feiyuElEls||[])[${t.n - 1}]; const el=c && c.el; if(!el) return {ok:false, why:'没这个编号（页面刷新过？重新 browser read 一次）'}; el.scrollIntoView({block:'center'}); el.focus(); if('value' in el) el.value=''; else el.textContent=''; return {ok:true} })()`)
      } else {
        tr = await ev(`(() => { const el=document.querySelector(${JSON.stringify(t.selector)}); if(!el) return {ok:false, why:'没找到输入框（'+${JSON.stringify(t.selector)}+'）'}; el.scrollIntoView({block:'center'}); el.focus(); if('value' in el) el.value=''; else el.textContent=''; return {ok:true} })()`)
      }
      const v = tr.result?.value ?? {}
      if (!v.ok) { note(target, '失败：' + (v.why || '').slice(0, 60)); throw new Error(v.why || '定位输入框失败') }
      await conn.cdp.send('Input.insertText', { text }, sessionId)
      await ev(`document.activeElement.dispatchEvent(new Event('input', {bubbles:true})); document.activeElement.dispatchEvent(new Event('change', {bubbles:true})); true`)
      note(target, '输入 ' + text.length + ' 字')
      return `已输入 ${text.length} 个字（还没提交，要发送就 browser enter，或 click 提交按钮）`
    }
    case 'enter': {
      await ev(`(() => { const el=document.activeElement; if(el && el.form && el.form.requestSubmit) { el.form.requestSubmit(); return true } if(el) el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true })()`)
      await settle(conn, sessionId, 5000).catch(() => {})
      const els = await refreshEls()
      return `回车已发，页面已更新${fmtEls(els)}`
    }
    case 'key': {
      const key = String(args[0] || 'Enter')
      const r = await ev(`(() => { const el=document.activeElement; if(!el) return false; el.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true})); el.dispatchEvent(new KeyboardEvent('keyup', {key:${JSON.stringify(key)}, bubbles:true})); return true })()`)
      if (!r.result?.value) throw new Error('没有聚焦的元素可按键 —— 先 browser type 聚焦')
      return `已按 ${key}`
    }
    case 'scroll': {
      const px = Number(args[0]) || 600
      await ev(`window.scrollBy(0, ${px}); true`)
      return `${px >= 0 ? '下' : '上'}滚 ${Math.abs(px)}px`
    }
    case 'back': {
      const h = await conn.cdp.send('Page.getNavigationHistory', {}, sessionId)
      const i = h.currentIndex
      if (i <= 0) {
        // 新标签页打开的页没有历史 —— 对她来说"回退"就是切回上一个标签页（真人就是这么干的）
        const { targetInfos } = await conn.cdp.send('Target.getTargets')
        const others = targetInfos.filter((x) => x.type === 'page' && !/^devtools:/.test(x.url) && x.targetId !== s.targetId)
        if (others.length) {
          const prev = others[others.length - 1]
          const { sessionId: ps } = await conn.cdp.send('Target.attachToTarget', { targetId: prev.targetId, flatten: true })
          await conn.cdp.send('Page.enable', {}, ps)
          await conn.cdp.send('Runtime.enable', {}, ps)
          await conn.cdp.send('Network.enable', {}, ps)
          const st = readDaemon()
          if (st) { st.current = { targetId: prev.targetId, device: curDevice || 'pc', url: prev.url, at: Date.now() }; writeDaemon(st) }
          try { await conn.cdp.send('Target.closeTarget', { targetId: s.targetId }) } catch (e) { swallow(e, 'browser:backClose') }
          return `这页是新的没历史 —— 已切回「${prev.title.slice(0, 30) || prev.url.slice(0, 40)}」（原页关了）`
        }
        throw new Error('已经是最早一页了')
      }
      await conn.cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[i - 1].id }, sessionId)
      await settle(conn, sessionId, 5000).catch(() => {})
      const els = await refreshEls()
      return `已后退一步${fmtEls(els)}`
    }
    default:
      throw new Error(`不认识的动作：${action}（click/type/enter/key/scroll/back）`)
  }
}

/** 在当前页里找词：命中几次 + 第一处上下文 —— 她"这页值不值得细读"的快筛 */
export async function browserFind(term) {
  const s = await ensureSession(curDevice || 'pc')
  const r = await s.conn.cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const t = (document.body && document.body.innerText) || ''
      const q = ${JSON.stringify(String(term || ''))}
      if (!q) return { count: 0, term: '' }
      const lower = t.toLowerCase(); const qq = q.toLowerCase()
      let i = 0, count = 0, first = -1
      while ((i = lower.indexOf(qq, i)) !== -1) { if (first < 0) first = i; count++; i += qq.length }
      if (!count) return { count: 0, term: q }
      const context = t.slice(Math.max(0, first - 40), first + qq.length + 80).replace(/\\s+/g, ' ').trim()
      return { count, term: q, context }
    })()`,
    returnByValue: true,
  }, s.sessionId)
  return r.result?.value ?? { count: 0, term: String(term || '') }
}

/** 截图存档，返回文件路径（她可以拿去发/看） */
export async function browserShot(tag = '') {
  const s = await ensureSession(curDevice || 'pc')
  const r = await s.conn.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, s.sessionId)
  if (!r.data) throw new Error('截不出来（页面可能还没画完，等两秒再试）')
  const dir = SHOT_DIR()
  fs.mkdirSync(dir, { recursive: true })
  // 内存守护：截图目录只留最近 100 张（每次 ~7KB，100 张封顶 ≈ 0.7MB）
  try {
    const shots = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
    for (const f of shots.slice(0, Math.max(0, shots.length - 100))) fs.rmSync(path.join(dir, f), { force: true })
  } catch (e) { swallow(e, 'browser:shotGc') }
  const name = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + (tag ? '-' + String(tag).replace(/[^\w-]/g, '').slice(0, 20) : '') + '.jpg'
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  return file
}

/** 会话状态：谁活着、开着哪页、什么身份 */
export async function browserStatus() {
  const d = await probeDaemon()
  if (!d) return { alive: false, note: '浏览器没在跑（要用时会自动拉起，闲置 10 分钟自动收摊）' }
  const st = readDaemon()
  const out = { alive: true, pid: d.pid, device: st?.current?.device || '（还没定）', tabs: [] }
  try {
    const conn = await connect()
    const { targetInfos } = await conn.cdp.send('Target.getTargets')
    out.tabs = targetInfos.filter((t) => t.type === 'page' && !/^devtools:/.test(t.url)).map((t) => ({ url: t.url.slice(0, 100), title: t.title.slice(0, 50) }))
  } catch (e) { out.tabs = [{ url: '（探不了：' + String(e.message).slice(0, 40) + '）' }] }
  return out
}

/** 关掉浏览器（收摊用；登录态在 profile 里，下次还在） */
export async function browserClose() {
  const d = await probeDaemon()
  if (!d) return '本来就没开'
  try {
    const conn = await connect()
    await conn.cdp.send('Browser.close')
  } catch (e) { try { process.kill(d.pid, 'SIGTERM') } catch (e2) { swallow(e2, 'browser:closeKill') } }
  try { fs.rmSync(PORT_FILE(), { force: true }) } catch (e) { swallow(e, 'browser:closeRm') }
  cdp = null; cdpPid = null; curDevice = null
  return '浏览器已关（登录态留着）'
}

/** 只收客户端连接，chromium 留着继续活 —— CLI 一次性命令跑完必须调这个，
 *  否则 WebSocket 挂着事件循环，进程永远不退出（真事：读得挺好，就是卡住不退）。 */
export async function browserDetach() {
  try { cdp?.ws.close() } catch (e) { swallow(e, 'browser:detach') }
  cdp = null; cdpPid = null; curDevice = null
}

/** 显式关一个 tab（browser close @编号 / close --all）；不带参数关当前页 */
export async function closeTab(targetId) {
  const conn = await connect()
  const tid = targetId || readDaemon()?.current?.targetId
  if (!tid) return '没有可关的页'
  try { await conn.cdp.send('Target.closeTarget', { targetId: tid }) } catch (e) { swallow(e, 'browser:closeTab') }
  const st = readDaemon()
  if (st?.current?.targetId === tid) { delete st.current; writeDaemon(st) }
  return '已关一页'
}

/** iframe 嵌入正文（公众号/门户把文章放 iframe 里）：抓同源 iframe 的文本拼到主文档后面 */
export const IFRAME_FN = `(() => {
  const out = []
  try {
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument
        if (!d || !d.body) continue
        const t = (d.body.innerText || '').replace(/[ \\t]+/g, ' ').replace(/\\n{2,}/g, '\\n').trim()
        if (t.replace(/\\s/g, '').length > 80) out.push(t)
      } catch (e) { /* 跨域 iframe 摸不到，正常 */ }
    }
  } catch (e) {}
  return out.join('\\n\\n')
})()`

/** 开着的标签清单（落档案，跨进程可见）：[序号] 身份 · 标题 · URL。带 * 的是"当前页" */
export async function browserTabs() {
  const d = await probeDaemon()
  if (!d) return '浏览器没在跑'
  const conn = await connect()
  const st = readDaemon()
  const { targetInfos } = await conn.cdp.send('Target.getTargets')
  const pages = targetInfos.filter((t) => t.type === 'page' && !/^devtools:/.test(t.url))
  const lines = pages.map((t, i) => {
    const mark = st?.current?.targetId === t.targetId ? '*' : ' '
    return `${mark}[${i + 1}] ${t.title.slice(0, 30)} · ${t.url.slice(0, 70)}`
  })
  touchDaemon(d.pid)
  return lines.join('\n') || '（没有开着的页）'
}

/** 全关（不关浏览器本体；登录态留着） */
export async function browserCloseAll() {
  const d = await probeDaemon()
  if (!d) return '本来就没开'
  const conn = await connect()
  const { targetInfos } = await conn.cdp.send('Target.getTargets')
  let n = 0
  for (const t of targetInfos.filter((x) => x.type === 'page' && !/^devtools:/.test(x.url))) {
    try { await conn.cdp.send('Target.closeTarget', { targetId: t.targetId }); n++ } catch (e) { swallow(e, 'browser:closeAll') }
  }
  const st = readDaemon()
  if (st) { delete st.current; writeDaemon(st) }
  touchDaemon(d.pid)
  return `已关 ${n} 页（浏览器还在）`
}

/** 按清单序号关页（browser close @2） */
export async function browserCloseTabAt(n) {
  const d = await probeDaemon()
  if (!d) return '浏览器没在跑'
  const conn = await connect()
  const { targetInfos } = await conn.cdp.send('Target.getTargets')
  const pages = targetInfos.filter((t) => t.type === 'page' && !/^devtools:/.test(t.url))
  const t = pages[Number(n) - 1]
  if (!t) return `没有 [${n}] 这一页（一共 ${pages.length} 页，先 browser tabs 看清单）`
  try { await conn.cdp.send('Target.closeTarget', { targetId: t.targetId }) } catch (e) { swallow(e, 'browser:closeAt') }
  const st = readDaemon()
  if (st?.current?.targetId === t.targetId) { delete st.current; writeDaemon(st) }
  touchDaemon(d.pid)
  return `已关 [${n}] ${t.title.slice(0, 30)}`
}

/** 动作日志（谁在什么时候点了/输了什么）：落 ~/.data/browser-actions.log */
export async function browserActionsLog() {
  const f = dataPath('browser-actions.log')
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-40).join('\n') || '（还没做过交互动作）'
  } catch { return '（还没做过交互动作）' }
}
/** 动作日志写入（browserAct 内部调用；best-effort 不挡道） */
export function logAction(action, target, detail = '') {
  try {
    const f = dataPath('browser-actions.log')
    const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, `${t} ${action} ${String(target).slice(0, 60)}${detail ? ' ｜ ' + String(detail).slice(0, 80) : ''}\n`)
  } catch (e) { swallow(e, 'browser:logAction') }
}
