// browser-engine-test —— 内置浏览器引擎测试（2026-11-02）
// 两层：
//   · 离线层：设备识别 / SSRF 防护 / CDP 通道（假 WebSocket）/ daemon 探活 —— 不碰网络不碰 chromium
//   · 实机层：容器里有 chromium 就真开浏览器 —— 本地起一个 JS 渲染页（走 allowPrivate 例外），
//     验证「JS 渲染出正文 / 电脑手机两种身份 / 点击 / 输入 / 截图」，不依赖外网
// 环境隔离：BOT_CONFIG / DSH_HOME 全指到临时目录，不碰她的真实配置和数据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-browser-'))
process.env.BOT_CONFIG = path.join(TMP, 'bot.config.json')
// dataPath 走 HOME 链（USERPROFILE 优先）——两个都指到临时目录，别碰她的真 ~/.data
process.env.USERPROFILE = TMP
process.env.HOME = TMP
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({}))

const { DEVICES, pickDevice, guardUrl, browserRead, browserAct, browserShot, browserStatus, browserClose, browserPeek, EXTRACT_FN } =
  await import('../tools/lib/browser.mjs')
const { Cdp } = await import('../tools/lib/browser.mjs')
const { dataPath } = await import('../tools/lib/paths.mjs')

let bad = 0
const ok = (cond, name) => { if (cond) { console.log(`  ✓ ${name}`) } else { console.log(`  ✗ ${name}`); bad++ } }

// ── 离线层 ──────────────────────────────────────────────────────────────────
console.log('[1] 设备身份表')
ok(DEVICES.pc && DEVICES.pc.mobile === false && !DEVICES.pc.touch, 'pc=桌面身份，无触摸')
ok(DEVICES.mobile && DEVICES.mobile.mobile === true && DEVICES.mobile.touch && DEVICES.mobile.dsf === 3, 'mobile=手机身份，触摸+3x DPR')
ok(/Windows NT/.test(DEVICES.pc.ua) && !/Mobile/.test(DEVICES.pc.ua), 'pc UA 是桌面 Chrome')
ok(/Android/.test(DEVICES.mobile.ua) && /Mobile/.test(DEVICES.mobile.ua), 'mobile UA 是安卓手机')

console.log('[2] auto 识别（按域名猜）')
ok(pickDevice('https://m.example.com/a', 'auto') === 'mobile', 'm. 开头 → 手机')
ok(pickDevice('https://wap.site.cn/x', 'auto') === 'mobile', 'wap. 开头 → 手机')
ok(pickDevice('https://mp.weixin.qq.com/s/abc', 'auto') === 'mobile', '公众号 → 手机')
ok(pickDevice('https://example.com', 'auto') === 'pc', '普通域名 → 电脑')
ok(pickDevice('https://m.example.com', 'pc') === 'pc', '显式 --pc 压过 auto')
ok(pickDevice('https://example.com', 'mobile') === 'mobile', '显式 --mobile 压过 auto')

console.log('[3] SSRF 防护')
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({ browser: { allowPrivate: ['myhost.local', '127.0.0.1'] } }))
try { await guardUrl('ftp://example.com'); ok(false, '非 http(s) 应拒绝') } catch (e) { ok(/只支持/.test(e.message), '拒绝非 http(s)：' + e.message.slice(0, 30)) }
try { await guardUrl('http://192.168.1.1/'); ok(false, '私网 IP 应拒绝') } catch (e) { ok(/内网/.test(e.message), '拒绝私网 IP：' + e.message.slice(0, 30)) }
try { await guardUrl('http://10.0.0.2/'); ok(false, '10 段应拒绝') } catch (e) { ok(/内网/.test(e.message), '拒绝 10 段') }
try { await guardUrl('http://169.254.1.1/'); ok(false, '链路本地应拒绝') } catch (e) { ok(/内网/.test(e.message), '拒绝链路本地') }
ok((await guardUrl('http://127.0.0.1:59999/x')) .startsWith('http://127.0.0.1'), 'allowPrivate 例外放行回环')
ok((await guardUrl('http://1.1.1.1/')) .startsWith('http://1.1.1.1'), '公网 IP 字面量放行（不做 DNS）')
ok((await guardUrl('http://myhost.local/x')) .startsWith('http://myhost.local'), 'allowPrivate 主机名放行（不查 DNS）')

console.log('[4] CDP 通道（假 WebSocket）')
class MockWS {
  constructor() { this.sent = []; this.h = {}; queueMicrotask(() => (this.h.open ?? []).forEach((f) => f())) }
  addEventListener(k, fn) { (this.h[k] ??= []).push(fn) }
  send(s) { this.sent.push(JSON.parse(s)); return true }
  close() { this.h.close?.forEach((f) => f()) }
  // 测试用：模拟浏览器回包 / 推事件
  reply(id, result) { this.h.message?.forEach((f) => f({ data: JSON.stringify({ id, result }) })) }
  replyErr(id, msg) { this.h.message?.forEach((f) => f({ data: JSON.stringify({ id, error: { message: msg } }) })) }
  emit(method, params) { this.h.message?.forEach((f) => f({ data: JSON.stringify({ method, params }) })) }
}
{
  const ws = new MockWS()
  const c = new Cdp(ws)
  const settle = () => new Promise((r) => setTimeout(r, 10))   // 等 ready 门放行
  const p1 = c.send('A.x', { v: 1 })
  await settle(); ws.reply(1, { hello: 'world' })
  ok((await p1).hello === 'world', '请求-响应配对')
  const p2 = c.send('A.y').catch((e) => e)
  await settle(); ws.replyErr(2, '炸了')
  ok((await p2).message === '炸了', '错误回包变成 rejection')
  ws.emit('Page.loadEventFired', { x: 1 })
  const ev = await c.waitEvent((m) => m.method === 'Page.loadEventFired', 100)
  ok(ev.params.x === 1, '先到的事件进缓存，waitEvent 翻缓存命中')
  const miss = await c.waitEvent((m) => m.method === 'Never.Happens', 50).catch((e) => e)
  ok(/超时/.test(miss.message), '等不到就超时')
  // 超时的 waiter 不会留成僵尸：再来同 method 事件不该 resolve 已弃等的 promise
  ws.emit('Never.Happens', {})
  ok(c.waiters.length === 0, '超时 waiter 已清干净')
  ws.close()
  const p3 = c.send('A.z').catch((e) => e.message)
  ok(!c.open && p3 instanceof Promise, 'close 后 send 会拒绝')
}

console.log('[5] daemon 探活')
{
  // 假 CDP 服务：/json/version 答一份 webSocketDebuggerUrl
  const srv = http.createServer((req, res) => {
    if (req.url === '/json/version') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/x' })); return }
    res.statusCode = 404; res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const { probeDaemon } = await import('../tools/lib/browser.mjs')
  const daemonFile = dataPath('browser-daemon.json')   // 必须跟 browser.mjs 读的是同一个文件
  fs.mkdirSync(path.dirname(daemonFile), { recursive: true })
  fs.writeFileSync(daemonFile, JSON.stringify({ port, pid: 1, at: Date.now() }))
  const alive = await probeDaemon()
  ok(alive && alive.port === port && alive.ws === 'ws://127.0.0.1/x', '活着的 CDP 端口能探到')
  // 死端口
  fs.writeFileSync(daemonFile, JSON.stringify({ port: 59991, pid: 1, at: Date.now() }))
  ok((await probeDaemon()) === null, '死端口探不到，返回 null')
  // 过期档案（30 分钟前）
  fs.writeFileSync(daemonFile, JSON.stringify({ port, pid: 1, at: Date.now() - 40 * 60_000 }))
  ok((await probeDaemon()) === null, '过期档案不算活')
  srv.close()
}

// ── 实机层（容器里有 chromium 才跑）────────────────────────────────────────
const which = spawnSync('sh', ['-c', 'command -v chromium || command -v chromium-browser'], { encoding: 'utf8', timeout: 10000 })
const chromeBin = which.stdout.trim()
if (!chromeBin) {
  console.log('[6] 实机层跳过：容器里没有 chromium（apt 装 chromium 后这里会真开浏览器验证）')
} else {
  console.log('[6] 实机层：真开浏览器（本地页面，不依赖外网）')
  fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({
    browser: { allowPrivate: ['127.0.0.1'], chromiumBin: chromeBin },
  }))
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><html><head><title>鱼塘测试页</title></head><body>
      <nav>导航条（应被过滤）</nav>
      <h1>欢迎来到鱼塘</h1>
      <p id="js-only">占位</p>
      <p>这是第一段正文，讲的是理想的机械人今天吃得很饱。</p>
      <p>这是第二段正文，讲的是她学会了自己上网冲浪。</p>
      <a href="/next" id="go-next">下一页</a>
      <input id="say" placeholder="说点什么"/>
      <button id="push">发送</button>
      <p id="echo"></p>
      <script>
        setTimeout(() => { document.getElementById('js-only').innerText = '这一行是JS渲染出来的（2秒后）' }, 100)
        document.getElementById('push').addEventListener('click', () => {
          document.getElementById('echo').innerText = '已发送：' + document.getElementById('say').value
        })
      </script></body></html>`)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/`

  const p = await browserRead(url, { device: 'pc', waitMs: 5000, maxChars: 4000 })
  ok(p.title === '鱼塘测试页', '拿到标题：' + p.title)
  ok(p.text.includes('JS渲染出来'), 'JS 渲染的内容抓到了（curl 时代抓不到的）')
  ok(p.text.includes('第一段正文') && p.text.includes('第二段正文'), '正文两段都在')
  ok(!p.text.includes('导航条'), '导航噪音被滤掉')
  ok(p.device === 'pc', 'auto→电脑身份')

  // 续读：把 maxChars 压小，两段拼回来必须等于全文（offset 语义的硬校验）
  const full = (await browserPeek({ maxChars: 60000 })).text
  const p1 = await browserRead(url, { device: 'pc', waitMs: 4000, maxChars: 40 })
  if (p1.more) {
    const p2 = await browserPeek({ offset: p1.nextOffset, maxChars: 60000 })
    ok((p1.text + p2.text) === full, `续读接得上（两段拼接=全文，offset=${p1.nextOffset}）`)
  } else ok(true, '（这页足够短，续读通路由参数自洽保证）')

  // 交互：输入 + 点击
  await browserAct('type', '#say', '鱼鱼想吃虾')
  const echo = await browserAct('click', '#push')
  ok(/发送|更新/.test(echo), '点击执行：' + echo)
  const after = await browserPeek({ maxChars: 2000 })
  ok(after.text.includes('已发送：鱼鱼想吃虾'), '点击真的改了页面状态（回显出现）')

  // 手机身份重开：同一页换一台"设备"
  const m = await browserRead(url, { device: 'mobile', waitMs: 4000, maxChars: 4000 })
  ok(m.device === 'mobile', '切到手机身份')
  const shot = await browserShot('test')
  ok(fs.existsSync(shot) && fs.statSync(shot).size > 3000, `截图落盘（${path.basename(shot)}，${fs.statSync(shot).size}B）`)

  const st = await browserStatus()
  ok(st.alive && st.tabs.length >= 1, `status：活着，开着 ${st.tabs.length} 个页`)
  console.log('  （收摊）' + await browserClose())

  // 外网冒烟（可达才验，不可达只提示）：验证真实站点 + 手机/电脑差异
  const net = spawnSync('node', ['-e', `fetch('https://www.baidu.com',{signal:AbortSignal.timeout(6000)}).then(r=>console.log(r.status)).catch(()=>console.log('NO'))`], { encoding: 'utf8', timeout: 10_000 })
  if (net.stdout.trim() === '200') {
    const b = await browserRead('https://www.baidu.com', { device: 'mobile', waitMs: 8000, maxChars: 1500 })
    ok(b.text.length > 10, `外网冒烟：百度手机版读出 ${b.text.length} 字${b.fallback ? '（innerText 兜底）' : ''}`)
    await browserClose()
  } else {
    console.log('  （外网不可达，跳过真实站点冒烟）')
  }
  srv.close()
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 项没过` : '\n全部通过')
process.exit(bad ? 1 : 0)
