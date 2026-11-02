// inbound-auth —— qq-server HTTP 入口的鉴权（v5 新增）。
//
// 为什么必须加（重构前的真 P0）：/onebot、/inbound、/outbound、/task 四个入口
// 完全没有鉴权，而 im-gateway.sh 里写的是 `export QQ_BIND_HOST=0.0.0.0`。
// 实测：同一个 docker 网桥上的另一个容器可以直接
//   GET  http://172.17.0.3:8081/task      → 拿到完整任务队列
//   GET  http://172.17.0.3:8081/outbound  → 拿到她的出站消息（还能 drain 清空）
//   POST http://172.17.0.3:8081/inbound   → 冒充任意用户跟她说话
// 当时唯一挡住外部滥用的是 guard.dryRun=true —— 那是"恰好没开"，不是防护。
//
// 设计原则（为什么这么设计）：
//   ① **默认不破坏现有链路**：没配 token 时按"仅回环"放行（127.0.0.1 / ::1），
//      本机 SnowLuma 走 172.17.0.1→127.0.0.1 映射仍通；跨容器/局域网一律拒绝。
//   ② 配了 token（qq.inboundToken）就**强制校验**，与来源 IP 无关 —— 想开放就显式开。
//   ③ 用 constant-time 比较，别用 === 泄漏前缀。
//   ④ 失败只回 401，不回细节（不告诉对方"是 token 错了还是没配"）。
import crypto from 'node:crypto'

/** 取配置里的 token（支持环境变量覆盖，方便容器编排）。 */
export function inboundToken(cfg) {
  return String(process.env.BOT_INBOUND_TOKEN || cfg?.qq?.inboundToken || '')
}

/**
 * 请求是不是从 **本机 docker 网桥网关** 转进来的。
 *
 * 为什么需要（2026-11-01 真 P0）：容器里的 qq-server 必须绑 0.0.0.0 才能被
 * docker-proxy 转发进来（绑 127.0.0.1 时 docker-proxy 往 172.17.0.3:8081 连，
 * 必然 fetch failed）。但一绑 0.0.0.0，SnowLuma 经宿主 127.0.0.1:8081 映射进来的
 * 请求，源地址就变成 172.17.0.1（docker 网关），**不是回环** —— 于是 /onebot
 * 的 loopback 豁免失效，SnowLuma 每条上报都 401。
 *
 * 而 OneBot v11 的 HTTP 上报**不支持自定义头**，也没法带 Bearer token，
 * SnowLuma 的 httpClients.secret 走的是 HMAC 签名，这套鉴权不认。
 *
 * 所以：把"默认网桥网关地址"也视为本机来源。
 * 安全边界没有放宽 —— 172.17.0.1 只有宿主自己能路由到，局域网/公网进不来；
 * 且只在本文件被 allowLoopback=true 的入口（即 /onebot）上生效。
 */
const DOCKER_GW_RE = /^172\.(1[6-9]|2\d|3[01])\.0\.1$/

export function isDockerGateway(req) {
  const a = String(req?.socket?.remoteAddress || '')
  if (!a) return false
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  return DOCKER_GW_RE.test(v4)
}

/** 请求来源是不是本机回环。 */
export function isLoopback(req) {
  const a = String(req?.socket?.remoteAddress || '')
  const h = String(req?.headers?.host || '')
  if (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') return true
  // Host 头也可能是回环（本机反代/端口映射），但**只**作为辅助证据，不作为唯一依据。
  if (!a && /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i.test(h)) return true
  return false
}

/** 定长比较，避免 timing 泄漏。 */
function same(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  try { return crypto.timingSafeEqual(ba, bb) } catch { return false }
}

/** 从请求里取调用方 token：Authorization: Bearer / X-Feiyu-Token / ?token= */
function presented(req) {
  const auth = String(req?.headers?.authorization || '')
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  const h = req?.headers?.['x-bot-token']
  if (h) return String(h).trim()
  try {
    const u = new URL(String(req?.url || ''), 'http://x')
    return String(u.searchParams.get('token') || '')
  } catch { return '' }
}

/**
 * 这个请求能不能进来。
 *
 * @param {object} req
 * @param {object} cfg
 * @param {{allowLoopback?:boolean}} opts
 *   allowLoopback=true：**本机回环永远放行**（即便配了 token）。
 *   为什么需要：`/onebot` 是 SnowLuma/NapCat 的上报口，OneBot v11 的 HTTP 上报
 *   **不支持自定义请求头**（它只会 POST 一个 JSON body）。如果在 /onebot 上强制校验
 *   token，等于把本机 QQ 网关直接断开 —— 这是"安全改到不能用"的典型。
 *   而它只绑在 127.0.0.1 上（宿主映射也是 127.0.0.1），本来就是本机可达。
 *   对 /inbound、/outbound、/task 这种"能读数据/能驱动她"的入口，则严格执行 token。
 * @returns {{ok:boolean, reason:string}}
 */
export function inboundTokenOk(req, cfg, opts = {}) {
  const want = inboundToken(cfg)
  if (want) {
    const got = presented(req)
    if (got) {
      if (!same(got, want)) return { ok: false, reason: 'bad-token' }
      return { ok: true, reason: 'token' }
    }
    // 没带 token：只有"回环 + 明确允许回环"的入口才放行（OneBot 上报口）
    if (opts.allowLoopback === true && (isLoopback(req) || isDockerGateway(req))) {
      return { ok: true, reason: isLoopback(req) ? 'loopback(onebot)' : 'docker-gw(onebot)' }
    }
    return { ok: false, reason: 'missing-token' }
  }
  // 没配 token：只允许本机回环
  if (isLoopback(req)) return { ok: true, reason: 'loopback' }
  return { ok: false, reason: 'non-loopback-and-no-token' }
}

/**
 * 校验并**已写回**401（调用方只需 return）。
 * @returns {boolean} true = 已拒绝（调用方应直接 return）
 */
export function requireInboundToken(req, res, cfg, opts = {}) {
  const r = inboundTokenOk(req, cfg, opts)
  if (r.ok) return false
  // 对外的错误体不带任何配置细节（不告诉对方"是没配 token 还是 token 错了"，
  // 否则等于帮攻击者确认"这台机器还没设防"）。细节走服务端日志。
  const body = JSON.stringify({ ok: false, error: 'unauthorized' })
  try { console.warn('[inbound-auth] 拒绝 ' + String(req?.url || '') + '：' + r.reason + ' from ' + String(req?.socket?.remoteAddress || '?')) } catch { /* ignore */ }
  try {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
    res.end(body)
  } catch { /* 连接已断就算了 */ }
  return true
}
