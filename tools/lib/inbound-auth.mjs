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
  return String(process.env.FEIYU_INBOUND_TOKEN || cfg?.qq?.inboundToken || '')
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
  const h = req?.headers?.['x-feiyu-token']
  if (h) return String(h).trim()
  try {
    const u = new URL(String(req?.url || ''), 'http://x')
    return String(u.searchParams.get('token') || '')
  } catch { return '' }
}

/**
 * 这个请求能不能进来。
 * @returns {{ok:boolean, reason:string}}
 */
export function inboundTokenOk(req, cfg) {
  const want = inboundToken(cfg)
  if (want) {
    const got = presented(req)
    if (!got) return { ok: false, reason: 'missing-token' }
    if (!same(got, want)) return { ok: false, reason: 'bad-token' }
    return { ok: true, reason: 'token' }
  }
  // 没配 token：退回"仅本机回环"（不静默放开）
  if (isLoopback(req)) return { ok: true, reason: 'loopback' }
  return { ok: false, reason: 'non-loopback-and-no-token' }
}

/**
 * 校验并**已写回**401（调用方只需 return）。
 * @returns {boolean} true = 已拒绝（调用方应直接 return）
 */
export function requireInboundToken(req, res, cfg, sendJson) {
  const r = inboundTokenOk(req, cfg)
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
