// 2026-11-04 静默失效批次回归（架构检查 P0/P1/P2 的四个真事故）。
//
// 钉的是"这一类不会再回来"，不是复述实现：
//   ① heartbeat 的 `ex` 必须在使用前绑定 —— 否则 presence 器官整天 TDZ，
//      而它被 try/catch 吞掉，界面上只表现为"存在感从不变化"。
//   ② notify 的跨窗口去重必须真的读写那张表（缺 dataPath import 时整段静默跳过）。
//   ③ outbox 的入队/取出必须并发安全（旧写法无锁读-改-写会丢条目）。
//   ④ swallow 必须把"预期缺失"（ENOENT 首建）与"真事故"分到两本账，
//      否则真事故被 900+ 条 ENOENT 淹没。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-fail-test-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

// ── ① heartbeat：`ex` 的绑定位置必须早于任何使用 ─────────────────────────
{
  const src = fs.readFileSync(new URL('../tools/brain/organ/heartbeat.mjs', import.meta.url), 'utf8')
  const declIdx = src.indexOf('const ex = _exec || {}')
  const firstUseIdx = src.indexOf('ex.vitals?.presence')
  ok('heartbeat: ex 在使用前声明', declIdx > 0 && firstUseIdx > 0 && declIdx < firstUseIdx,
    declIdx < firstUseIdx ? `声明@${declIdx} < 使用@${firstUseIdx}` : `声明@${declIdx} 使用@${firstUseIdx}（顺序反了 = TDZ）`)
  // 只允许一处声明（重复声明会再制造一个"看不出来哪个生效"的坑）
  const count = src.split('const ex = _exec || {}').length - 1
  ok('heartbeat: ex 只声明一次', count === 1, '声明 ' + count + ' 处')

  // 真跑一拍：presence 回调必须真的被调到（这是它存在的唯一证据）
  const HB = await import('../tools/brain/organ/heartbeat.mjs')
  let presenceCalls = 0
  HB.bind({ vitals: { presence: async () => { presenceCalls++ } } })
  const BEAT = 10   // presenceEveryBeats
  for (let i = 0; i < BEAT; i++) await HB.beat(Date.now() + i)
  ok('heartbeat: presence 每 10 拍真的被调用', presenceCalls >= 1, '调用 ' + presenceCalls + ' 次')
}

// ── ② notify：去重表必须真的写盘 ─────────────────────────────────────────
{
  const N = await import('../tools/lib/notify.mjs')
  // 干跑会让 sendOwnerQQ 直接返回，去重分支就在那之前 —— 需要真跑发送路径。
  // 这里用本地假 NapCat：127.0.0.1 上的一个一次性 HTTP 服务。
  const http = await import('node:http')
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok","retcode":0,"data":{"message_id":1}}') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  // config() 不缓存：写一份 bot.config.json 就是"改配置"
  const { configPath } = await import('../tools/lib/paths.mjs')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ guard: { dryRun: false }, owner: { qq: '10001' }, qq: { napcat_http: 'http://127.0.0.1:' + port } }, null, 1))
  const ddFile = path.join(TMP, 'send-dedup.json')
  try { fs.rmSync(ddFile, { force: true }) } catch { /* 首建：不需要 */ }
  let threw = null
  try { await N.sendOwnerQQ('回归测试：去重表必须落盘') } catch (e) { threw = e }
  srv.close()
  ok('notify: 发送不抛', threw === null, threw ? String(threw.message) : '')
  const wrote = fs.existsSync(ddFile) && fs.readFileSync(ddFile, 'utf8').includes('qq:10001')
  ok('notify: 去重表真的写进去了', wrote, ddFile)
}

// ── ③ outbox：并发入队不丢条目 ───────────────────────────────────────────
{
  const CI = await import('../tools/lib/channel-io.mjs')
  try { fs.rmSync(path.join(TMP, 'outbox.json'), { force: true }) } catch { /* 首建 */ }
  for (let i = 0; i < 20; i++) CI.pushOutbox({ platform: 'wechat', chatId: 'wx' + i, text: 'm' + i })
  const got = CI.drainOutbox('wechat')
  ok('outbox: 20 次入队全部取回', got.count === 20, '取回 ' + got.count + ' 条')
  // drain 之后必须真的空了（旧实现在并发下会留残）
  const again = CI.drainOutbox('wechat')
  ok('outbox: drain 后为空', again.count === 0, '还有 ' + again.count + ' 条')
  // 平台隔离：别的平台的条目不许被顺手取走
  CI.pushOutbox({ platform: 'wechat', chatId: 'a', text: 'w' })
  CI.pushOutbox({ platform: 'qq', chatId: 'b', text: 'q' })
  const wx = CI.drainOutbox('wechat')
  const left = CI.readOutbox()
  ok('outbox: 平台隔离', wx.count === 1 && left.length === 1 && left[0].platform === 'qq',
    `wechat=${wx.count} left=${left.map((x) => x.platform).join(',')}`)
}

// ── ④ swallow：预期缺失与真事故分账 ───────────────────────────────────────
{
  const S = await import('../tools/lib/swallow.mjs')
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/nope'"), { code: 'ENOENT' })
  S.swallow(enoent, 'test:soft', { force: true })
  S.swallow(new ReferenceError('Cannot access \'ex\' before initialization'), 'test:real', { force: true })
  S.flushSwallowed()
  const real = fs.readFileSync(path.join(TMP, 'logs', 'swallowed.log'), 'utf8')
  const soft = fs.readFileSync(path.join(TMP, 'logs', 'swallowed-soft.log'), 'utf8')
  ok('swallow: 真事故进真账', real.includes('test:real') && !real.includes('test:soft'), real.trim().slice(0, 80))
  ok('swallow: ENOENT 进软账', soft.includes('test:soft') && !soft.includes('test:real'), soft.trim().slice(0, 80))
  ok('swallow: readSwallowed 默认只读真账', S.readSwallowed(50).join('\n').includes('test:real')
    && !S.readSwallowed(50).join('\n').includes('test:soft'))
}

console.log(bad ? `\n✗ 静默失效回归：${bad} 项失败` : '\n✓ 静默失效回归：全绿')
process.exit(bad ? 1 : 0)
