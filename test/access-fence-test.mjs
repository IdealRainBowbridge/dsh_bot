/**
 * 访问栅栏测试 —— 2026-11-04 回归锚点。
 *
 * 现象：面板挂在 nginx 子路径（/deepseekharness/）后面时，插件每个 API 都 403
 * 「只接受本机回环访问」—— 因为旧栅栏只看 Host 是不是 127.0.0.1，而反代下 Host 是域名。
 *
 * 这里钉住新语义：
 *   · 回环 Host      → 放行（本机直连）
 *   · 声明过的域名 + 对端是容器网关（宿主反代） → 放行
 *   · 声明过的域名 + 对端是别的容器/局域网     → 拒绝
 *   · 没声明过的域名 + 对端是网关              → 拒绝
 *
 * 跑法：node test/access-fence-test.mjs
 */
import assert from 'node:assert/strict'

const { isTrustedReq, trustedAuthorities, peerAddress } = await import('../lib/http-utils.js')

const DOMAIN = 'arch-linux.sturgeon-darter.ts.net'
const GW = '172.17.0.1'
const trusted = new Set([DOMAIN, DOMAIN + ':443'])
const peers = new Set([GW])
const req = (host, peer) => ({ headers: host === null ? {} : { host }, socket: { remoteAddress: peer } })

let bad = 0
const ok = (c, label) => { console.log((c ? '  ✓ ' : '  ✗ ') + label); if (!c) bad++ }

// ── 1. 回环直连（原语义不能退化）────────────────────────────────────────────
ok(isTrustedReq(req('127.0.0.1:3090', '127.0.0.1'), { trusted, peers }) === true, '回环 Host + 回环对端 → 放行')
ok(isTrustedReq(req('localhost', '::1'), { trusted, peers }) === true, 'localhost → 放行')
ok(isTrustedReq(req('[::1]:8080', '::1'), { trusted, peers }) === true, 'IPv6 回环（带端口）→ 放行')

// ── 2. 反代入口（这次修的主场景）────────────────────────────────────────────
ok(isTrustedReq(req(DOMAIN, GW), { trusted, peers }) === true, '声明域名 + 宿主网关对端 → 放行')
ok(isTrustedReq(req(DOMAIN, '::ffff:' + GW), { trusted, peers }) === true, 'IPv4-mapped 对端同样认（Node 双栈）')
ok(isTrustedReq(req(DOMAIN + ':443', GW), { trusted, peers }) === true, '声明时带端口 → 放行')

// ── 3. 该拒绝的（安全边界）──────────────────────────────────────────────────
ok(isTrustedReq(req(DOMAIN, '172.17.0.9'), { trusted, peers }) === false, '域名对但来自别的容器 → 拒绝')
ok(isTrustedReq(req('evil.example.com', GW), { trusted, peers }) === false, '没声明的域名走网关 → 拒绝')
ok(isTrustedReq(req(DOMAIN, '192.168.5.9'), { trusted, peers }) === false, '域名对但来自局域网 IP → 拒绝')
ok(isTrustedReq(req(null, GW), { trusted, peers }) === false, '没有 Host 头 → 拒绝')
ok(isTrustedReq(req(DOMAIN, GW), { trusted: new Set(), peers }) === false, 'DSH 没声明任何 trusted-host → 拒绝')
ok(isTrustedReq(req('127.0.0.1.evil.com', GW), { trusted, peers }) === false, '回环前缀伪装域名 → 拒绝')

// ── 4. 运行时取值：argv 解析与对端归一化 ────────────────────────────────────
const t = trustedAuthorities(['node', 'bin.js', 'web', '--trusted-host', DOMAIN, '--trusted-host=other.example:8443'])
ok(t.has(DOMAIN) && t.has('other.example:8443'), '--trusted-host 两种写法都能解析')
ok(peerAddress({ socket: { remoteAddress: '::ffff:10.0.0.5' } }) === '10.0.0.5', 'IPv4-mapped 对端归一化成点分')

if (bad) { console.error('\n栅栏测试失败：' + bad + ' 项'); process.exit(1) }
console.log('\naccess-fence ✓')
