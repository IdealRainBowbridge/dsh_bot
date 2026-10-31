#!/usr/bin/env node
// diagnose-smoke —— 冒烟测试：真起一个 qq-server，验证入口鉴权 / 平台隔离 / 干跑隔离
//
// 为什么要有它（v5）：现有 40 套测试全是纯函数/契约测试，没有一条"真起服务看行为"。
// 而这一轮修的四个 P0 里有三个只在**真进程**里才暴露：
//   · 入口鉴权（HTTP 层）
//   · 平台隔离（启动判定）
//   · 干跑隔离（handle 全链路）
// 这个脚本就是那条缺失的端到端回归。它不调真 LLM（用本地假网关），不写真实数据目录。
//
//   node scripts/diagnose-smoke.mjs
// 退出码 0 = 全过；非 0 = 有断言失败。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

/** 起一个假 LLM 网关（固定回复），端口动态分配，不依赖网络。 */
function fakeLLM() {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '我在呢，刚忙完。' } }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }))
      })
    })
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
  })
}

/** 找一个空闲端口（用后即关，够用）。 */
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

const get = (port, p, headers = {}) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, headers, timeout: 4000 }, (r) => {
    let b = ''
    r.on('data', (d) => { b += d })
    r.on('end', () => resolve({ code: r.statusCode, body: b }))
  })
  req.on('error', () => resolve({ code: 0, body: '' }))
  req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: '' }) })
})
const post = (port, p, obj) => new Promise((resolve) => {
  const data = JSON.stringify(obj)
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 6000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
    let b = ''
    r.on('data', (d) => { b += d })
    r.on('end', () => resolve({ code: r.statusCode, body: b }))
  })
  req.on('error', () => resolve({ code: 0, body: '' }))
  req.write(data); req.end()
})

/** 跑一个场景：独立数据目录 + 独立配置 + 独立端口。 */
async function scenario({ name, cfg, fn }) {
  console.log('\n▶ ' + name)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-smoke-'))
  const cfgFile = path.join(dataDir, 'feiyu.config.json')
  const llm = await fakeLLM()
  const port = await freePort()
  // 把配置里的 LLM 地址指到刚起的假网关
  const cfg2 = JSON.parse(JSON.stringify(cfg))
  cfg2.llm = { ...(cfg2.llm || {}), base_url: 'http://127.0.0.1:' + llm.port + '/v1' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg2))
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'feiyu.mjs'), 'qq-server', String(port)], {
    cwd: ROOT, env: { ...process.env, FEIYU_CONFIG: cfgFile, FEIYU_DATA_DIR: dataDir }, stdio: 'pipe',
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })
  try {
    // 等端口起来（最多 12s）
    for (let i = 0; i < 60; i++) {
      const r = await get(port, '/health')
      if (r.code === 200) break
      await sleep(200)
    }
    await fn({ dataDir, port, get: (p, h) => get(port, p, h), post: (p, o) => post(port, p, o), log: () => log })
  } finally {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    try { llm.server.close() } catch { /* ignore */ }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

const baseCfg = (over = {}) => ({
  identity: { name: '测试鱼', ownerTitle: '铲屎官', selfClaim: '我' },
  owner: { qq: '10001', name: '铲屎官' },
  platforms: { qq: true, wechat: true },
  qq: { enabled: true, napcat_http: 'http://127.0.0.1:59999', replyGate: { enabled: false }, inboundToken: 'tok-smoke' },
  wechat: { enabled: true },
  guard: { dryRun: true },
  llm: { api_key: 'sk-test', base_url: 'http://127.0.0.1:59998/v1', model: 'x' },
  ...over,
})

// ── 场景 1：入口鉴权 ────────────────────────────────────────────────────────
await scenario({
  name: '入口鉴权（配了 token）', cfg: baseCfg(),
  fn: async ({ get, log }) => {
    const h = await get('/health')
    ok('health 始终开放（监工要能探）', h.code === 200)
    ok('health 报告鉴权模式', String(h.body).includes('"mode":"token"'))

    for (const p of ['/task', '/outbound?platform=qq']) {
      const r = await get(p)
      ok('无 token 访问 ' + p + ' → 401', r.code === 401, '实际 ' + r.code)
    }
    const r2 = await get('/task', { 'X-Feiyu-Token': 'tok-smoke' })
    ok('带正确 token → 200', r2.code === 200, '实际 ' + r2.code)
    const r3 = await get('/task', { 'X-Feiyu-Token': 'wrong' })
    ok('token 错 → 401', r3.code === 401, '实际 ' + r3.code)

    // 出站必须显式给 platform
    const r4 = await get('/outbound', { 'X-Feiyu-Token': 'tok-smoke' })
    ok('/outbound 不带 platform → 400（不许取走所有平台的）', r4.code === 400, '实际 ' + r4.code)
  },
})

// ── 场景 2：QQ 关着时微信照常工作（旧版会整进程退出） ──────────────────────
await scenario({
  name: '平台隔离（QQ 关 / 微信开）',
  cfg: baseCfg({ platforms: { qq: false, wechat: true }, qq: { enabled: false, napcat_http: 'http://127.0.0.1:59999', replyGate: { enabled: false } } }),
  fn: async ({ dataDir, get, post, log }) => {
    const h = await get('/health')
    ok('进程仍活着（没有因为 qq.enabled=false 自杀）', h.code === 200)
    const snap = JSON.parse(h.body).platforms || []
    ok('health 显示 qq=关 wechat=开', snap.find((x) => x.id === 'qq')?.on === false && snap.find((x) => x.id === 'wechat')?.on === true)

    const r = await post('/inbound', { platform: 'wechat', chatId: 'wechat:wxid_abc', userId: 'wxid_abc', text: '帮我看看这个' })
    ok('微信消息能进队列', r.code === 200 && String(r.body).includes('"ok":true'), r.body)
    await sleep(4000)
    const ep = path.join(dataDir, 'wechat', 'episodes.jsonl')
    const rows = fs.existsSync(ep) ? fs.readFileSync(ep, 'utf8').trim().split('\n').filter(Boolean) : []
    ok('微信消息写进了 wechat 记忆', rows.some((l) => l.includes('帮我看看这个')))
    ok('QQ 记忆没有被污染（目录不存在或为空）', !fs.existsSync(path.join(dataDir, 'qq', 'episodes.jsonl')) || fs.readFileSync(path.join(dataDir, 'qq', 'episodes.jsonl'), 'utf8').trim() === '')
  },
})

// ── 场景 3：dryRun 不把拟回复写进记忆 ──────────────────────────────────────
await scenario({
  name: '干跑隔离（dryRun=true）',
  cfg: baseCfg(),
  fn: async ({ dataDir, post }) => {
    await post('/onebot', {
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 99999, message_id: 4001,
      message: [{ type: 'text', data: { text: '在吗' } }],
    })
    await sleep(5000)
    const ep = path.join(dataDir, 'qq', 'episodes.jsonl')
    const rows = fs.existsSync(ep) ? fs.readFileSync(ep, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    const assistant = rows.filter((r) => r.role === 'assistant')
    ok('记忆里只有用户消息', rows.some((r) => r.role === 'user' && r.text.includes('在吗')))
    ok('**干跑的拟回复没有进记忆**', assistant.length === 0, '实际 ' + assistant.length + ' 条 assistant')

    const au = path.join(dataDir, 'audit', 'unsent.jsonl')
    const arows = fs.existsSync(au) ? fs.readFileSync(au, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    ok('拟回复落在 audit/unsent.jsonl', arows.length > 0 && arows[0].kind === 'dryrun', JSON.stringify(arows.slice(0, 1)))
  },
})

console.log('\n' + (fail ? '✗ ' + fail + ' 条没过（通过 ' + pass + '）' : '✓ 冒烟全部通过（' + pass + ' 条）') + '\n')
process.exit(fail ? 1 : 0)
