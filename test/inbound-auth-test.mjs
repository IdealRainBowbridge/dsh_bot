// inbound-auth-test —— 入口鉴权的单测（v5）。
//
// 背景：重构前 /onebot /inbound /outbound /task 完全没鉴权，且服务绑 0.0.0.0。
// 实测同网桥的另一个容器能直接读任务队列、drain 出站消息、冒充用户说话。
// 这里锁死三条语义：
//   ① 没配 token → 只接受本机回环（跨容器/局域网一律拒）
//   ② 配了 token → 必须带对 token（来源 IP 不再豁免）
//   ③ token 比较是定长的（不泄漏前缀）
import assert from 'node:assert'
import { inboundToken, isLoopback, inboundTokenOk, requireInboundToken } from '../tools/lib/inbound-auth.mjs'

const req = ({ ip = '10.1.2.3', host = 'example:8081', auth = '', token = '', url = '/' } = {}) => ({
  socket: { remoteAddress: ip },
  headers: { host, ...(auth ? { authorization: auth } : {}), ...(token ? { 'x-feiyu-token': token } : {}) },
  url,
})
const cfg = (t) => ({ qq: { inboundToken: t } })

// ── 1. 定长比较：token 长度不同也必须 false（不能崩） ───────────────────────
assert.equal(inboundToken(cfg('abc')), 'abc')
assert.equal(inboundToken({}), '')
process.env.FEIYU_INBOUND_TOKEN = 'from-env'
assert.equal(inboundToken(cfg('abc')), 'from-env', '环境变量优先')
delete process.env.FEIYU_INBOUND_TOKEN

// ── 2. 回环判定 ─────────────────────────────────────────────────────────────
assert.equal(isLoopback(req({ ip: '127.0.0.1' })), true)
assert.equal(isLoopback(req({ ip: '::1' })), true)
assert.equal(isLoopback(req({ ip: '::ffff:127.0.0.1' })), true)
assert.equal(isLoopback(req({ ip: '172.17.0.2' })), false, '同网桥别的容器不算回环')
assert.equal(isLoopback(req({ ip: '192.168.1.10' })), false)

// ── 3. 没配 token：只放回环 ─────────────────────────────────────────────────
assert.equal(inboundTokenOk(req({ ip: '127.0.0.1' }), cfg('')).ok, true)
assert.equal(inboundTokenOk(req({ ip: '172.17.0.2' }), cfg('')).ok, false, '跨容器必须拒绝')
assert.equal(inboundTokenOk(req({ ip: '172.17.0.2' }), cfg('')).reason, 'non-loopback-and-no-token')

// ── 4. 配了 token：强制校验（回环也不能例外） ───────────────────────────────
assert.equal(inboundTokenOk(req({ ip: '127.0.0.1' }), cfg('s3cret')).ok, false, '配了 token 就必须带')
assert.equal(inboundTokenOk(req({ ip: '127.0.0.1', auth: 'Bearer s3cret' }), cfg('s3cret')).ok, true)
assert.equal(inboundTokenOk(req({ ip: '127.0.0.1', auth: 'Bearer wrong' }), cfg('s3cret')).ok, false)
assert.equal(inboundTokenOk(req({ ip: '127.0.0.1', token: 's3cret' }), cfg('s3cret')).ok, true, 'X-Feiyu-Token 也行')
assert.equal(inboundTokenOk(req({ ip: '127.0.0.1', url: '/inbound?token=s3cret' }), cfg('s3cret')).ok, true, '查询参数也行')
assert.equal(inboundTokenOk(req({ ip: '172.17.0.2', auth: 'Bearer s3cret' }), cfg('s3cret')).ok, true, '配了 token 就可以跨机（显式开放）')
assert.equal(inboundTokenOk(req({ ip: '172.17.0.2', auth: 'Bearer s3cret2' }), cfg('s3cret')).ok, false)
assert.equal(inboundTokenOk(req({ ip: '127.0.0.1', auth: 'Bearer s3cret-extra-long' }), cfg('s3cret')).ok, false, '长度不同不许崩')

// ── 5. requireInboundToken 写回 401 ────────────────────────────────────────
{
  const sent = []
  const res = { writeHead: (code, h) => sent.push({ code, h }), end: (b) => sent.push({ body: b }) }
  const rejected = requireInboundToken(req({ ip: '172.17.0.2' }), res, cfg(''))
  assert.equal(rejected, true)
  assert.equal(sent[0].code, 401)
  assert.ok(String(sent[1].body).includes('unauthorized'))
  assert.ok(!String(sent[1].body).includes('token'), '错误体不许泄漏鉴权细节')
}
{
  const sent = []
  const res = { writeHead: (c, h) => sent.push({ code: c }), end: () => sent.push({ body: 'x' }) }
  const rejected = requireInboundToken(req({ ip: '127.0.0.1' }), res, cfg(''))
  assert.equal(rejected, false, '合法请求不能被拦')
  assert.equal(sent.length, 0)
}

// ── 6. OneBot 上报口的特殊语义（allowLoopback） ────────────────────────────
// OneBot v11 的 HTTP 上报不支持自定义头，所以 /onebot 必须允许"回环免 token"，
// 否则本机 QQ 网关会被安全策略直接断掉（安全改到不能用的典型）。
{
  const onebot = req({ ip: '127.0.0.1' })          // 不带 token
  assert.equal(inboundTokenOk(onebot, cfg('s3cret')).ok, false, '默认：配了 token 就必须带')
  assert.equal(inboundTokenOk(onebot, cfg('s3cret'), { allowLoopback: true }).ok, true, '/onebot 回环可以免 token')
  assert.equal(inboundTokenOk(onebot, cfg('s3cret'), { allowLoopback: true }).reason, 'loopback(onebot)')
  assert.equal(inboundTokenOk(req({ ip: '172.17.0.2' }), cfg('s3cret'), { allowLoopback: true }).ok, false, '跨机必须带 token')
  assert.equal(inboundTokenOk(req({ ip: '127.0.0.1', auth: 'Bearer s3cret' }), cfg('s3cret'), { allowLoopback: true }).reason, 'token')
}

console.log('✓ inbound-auth-test 全部通过（回环/token/定长比较/401/OneBot 上报口）')
