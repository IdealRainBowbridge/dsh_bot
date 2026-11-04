// http-utils —— DSH WebUI 插件层的 HTTP 小工具（2026-11-03 高压修缮：自 lib/index.js 外迁）
//
// index.js 顶破门禁上限（1150）时最先外迁的一段：纯 Node 内建、零业务依赖的四个函数。
// json() 被引用 67 处，签名与行为一字未改，只是搬了家。
// 2026-11-04：栅栏加反代识别，多一个 fs 依赖（读 /proc/net/route 认宿主网关）—— 仍是零业务依赖。
import fs from 'node:fs'

export function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 安全读 body —— **绝不让畸形 JSON 把 DSH 主进程炸掉**（v5 深度排查发现）。
 *
 * 旧写法到处都是 `const _pb = await safeBody(req)
      if (!_pb.ok) { json(res, 400, { ok: false, error: _pb.error }); return }
      const b = _pb.body`。
 * 只要有人往面板 API POST 一个畸形 body（面板自身 bug、浏览器扩展、
 * 或者任何能到达 127.0.0.1 的本地进程），`JSON.parse` 就 throw；
 * 而这个 throw 发生在 async 路由里、没有任何 catch ——
 * Node 会当成 unhandledRejection，DSH 直接 `fatal uncaught exception` 退出。
 *
 * 实测：`curl -X POST localhost:3090/dsh_bot/api/cookie -d '{bad'` 就能杀掉主进程。
 *
 * @returns {Promise<{ok:boolean, body:object, error?:string}>}
 */
export async function safeBody(req, opts = {}) {
  let raw
  try { raw = await readBody(req, opts.limit) } catch (e) {
    return { ok: false, body: {}, error: '读取请求体失败：' + String(e?.message || e) }
  }
  const text = String(raw || '').trim()
  if (!text) return { ok: true, body: {} }
  try {
    const b = JSON.parse(text)
    // 顶层必须是对象（数组/字符串/null 当成非法，避免后面 b.xxx 拿到奇怪东西）
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      return { ok: false, body: {}, error: '请求体必须是 JSON 对象' }
    }
    return { ok: true, body: b }
  } catch (e) {
    return { ok: false, body: {}, error: '请求体不是合法 JSON' }
  }
}

// ── 访问栅栏（2026-11-04 重写：原来的「只认回环 Host」在反代下必然全灭）──────
//
// 旧实现只看 Host 头是不是 127.0.0.1/localhost —— 面板挂在 nginx 子路径
// (/deepseekharness/) 或 tailscale serve (:3081) 后面时，Host 是域名，于是每个
// 面板请求都 403「只接受本机回环访问」，整页载入失败。实测 10-29 加栅栏起从没通过。
//
// 新规则（三层，缺一不放）：
//   ① Host 是回环 → 放行（本机直连，保持原意）
//   ② Host 是宿主亲自声明的 trusted authority（复用 DSH 自己的 --trusted-host 参数，
//      不另立一份清单）**且** 直连对端是容器默认网关（= 流量来自宿主上的反代，
//      而不是局域网/别的容器）→ 放行
//   ③ 其余一律 403
// 真正的鉴权仍由 index.js 里的 connection.requestRejection（DSH 会话 cookie）负责，
// 这层只负责「请求来自谁」。

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 去掉端口，保留 IPv6 的方括号形式。 */
function hostOnly(hostHeader) {
  const h = String(hostHeader || '').toLowerCase().trim()
  if (!h) return ''
  if (h.startsWith('[')) {
    const i = h.indexOf(']')
    return i < 0 ? h : h.slice(0, i + 1)
  }
  return h.split(':')[0]
}

/** DSH 启动参数 --trusted-host a --trusted-host=b → Set{a,b}（宿主声明的合法 authority）。 */
export function trustedAuthorities(argv = process.argv) {
  const out = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--trusted-host') {
      if (argv[i + 1]) out.add(String(argv[i + 1]).toLowerCase())
    } else if (a.startsWith('--trusted-host=')) {
      out.add(a.slice('--trusted-host='.length).toLowerCase())
    }
  }
  return out
}

/** 容器默认网关（= 宿主侧 docker-proxy / 反代的对端地址）。解析 /proc/net/route，无外部依赖。 */
function defaultGateway() {
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f[1] !== '00000000' || f[2] === '00000000') continue     // 只认 default 路由
      const hex = f[2]
      return [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
        .map((x) => parseInt(x, 16)).join('.')                     // 小端 → 点分十进制
    }
  } catch { /* 非 Linux / 无 /proc 时退回下面的默认值 */ }
  return ''
}

const TRUSTED = trustedAuthorities()
const PROXY_PEERS = new Set(
  String(process.env.DSH_PROXY_PEERS || defaultGateway() || '172.17.0.1')
    .split(',').map((s) => s.trim()).filter(Boolean)
)

export function peerAddress(req) {
  const raw = String(req.socket?.remoteAddress || req.connection?.remoteAddress || '')
  return raw.replace(/^::ffff:/, '')
}

/**
 * 请求是否来自可信方向。
 * @param {object} req
 * @param {{trusted?:Set<string>, peers?:Set<string>}} [opts] 供测试注入，缺省用运行时值
 */
export function isTrustedReq(req, opts = {}) {
  const trusted = opts.trusted || TRUSTED
  const peers = opts.peers || PROXY_PEERS
  const host = hostOnly(req?.headers?.host)
  if (LOOPBACK_HOSTS.has(host)) return true
  if (!host || !trusted.size) return false
  // 带端口写进 --trusted-host 的形态也要认（arch-linux…ts.net:443）
  const full = String(req?.headers?.host || '').toLowerCase().trim()
  if (!trusted.has(host) && !trusted.has(full)) return false
  return peers.has(peerAddress(req))
}
