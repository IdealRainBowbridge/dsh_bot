// http-utils —— DSH WebUI 插件层的 HTTP 小工具（2026-11-03 高压修缮：自 lib/index.js 外迁）
//
// index.js 顶破门禁上限（1150）时最先外迁的一段：纯 Node 内建、零业务依赖的四个函数。
// json() 被引用 67 处，签名与行为一字未改，只是搬了家。
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

/** 写操作只认本机回环（防"服务绑到 0.0.0.0"时局域网里有人改你的 cookie）。 */
export function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}
