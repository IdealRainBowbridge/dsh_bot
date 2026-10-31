/**
 * dsh-feiyu —— 宿主侧插件壳（设置壳 + 生物钟）。
 * 结构照 dsh-bili-whale 的 lib/index.js（MIT）：职责只有三件，
 *   1. 状态 API：GET /dsh-feiyu/api/status —— 生物钟/额度/情绪/干跑一览
 *   2. 凭据写入：POST /dsh-feiyu/api/cookie —— 清洗 + 写盘 + nav 实时验证（永不回显）
 *   3. 启动生物钟（lib/scheduler.js）—— 60 秒 tick，到点叫醒会话
 * 配置本体（feiyu.config.json）第一版手编（README 有完整说明），不做 GUI 设置页。
 *
 * 所有路由都过 DSH 信任栅栏（connection.requestRejection）+ 本机回环检查：
 * fail-closed —— 栅栏不可用就拒绝，而不是放行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

import { startScheduler } from './scheduler.js'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.js'
import { config as readToolConfig } from '../tools/lib/config.mjs'
import * as lifecycle from '../tools/lib/lifecycle.mjs'
import { readConfigFile, writeConfigFile } from '../tools/lib/config-file.mjs'
import { configPath, credentialsPath, dataPath, WORK_DIR, nightStatePath, homePath } from '../tools/lib/paths.mjs'
// 「一次只做一件事」（10-26）：她挑的那件事记在 feiyu-focus.json，宿主按它只放行一个循环
import { readFocus, writeFocus, isLoopActivity, labelOf, syncSwitches } from '../tools/lib/focus.mjs'
import * as MIND from '../tools/lib/mind.mjs'
import { swallow } from '../tools/lib/swallow.mjs'
import { runContractCheck, describeContractReport, dshVersion } from './dsh-contract.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.join(HERE, '..')
const FEIYU_MJS = path.join(PLUGIN_ROOT, 'tools', 'feiyu.mjs')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 生物钟状态：设置/体检用它回答「时钟是不是活的」。 */
let SCHED_STATUS = { ok: false, reason: '未初始化', at: null }

// Electron 主程序跑不了脚本 —— 必须找到真 node（找不到时显式报错，不静默 ✗）
const NODE_EXE = (() => {
  try {
    return resolveNodeRuntime(DSH_HOME)
  } catch (e) {
    globalThis.__feiyuNodeError = String(e?.message ?? e)
    return null
  }
})()

function execNode(args, options, cb) {
  if (!NODE_EXE) {
    const msg = globalThis.__feiyuNodeError || '未找到可用的 node 运行时'
    cb?.(new Error(msg), '', msg)
    return null
  }
  return execFile(NODE_EXE, args, { ...options, env: { ...nodeEnv(DSH_HOME), ...options?.env } }, cb)
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 64 * 1024) {
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

/** 写操作只认本机回环（防"服务绑到 0.0.0.0"时局域网里有人改你的 cookie）。 */
function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

export default {
  name: 'dsh-feiyu',
  // ⚠️ 一个数组写全（bili-whale 踩过"写两个 inject 键后者覆盖前者"的坑 → 时钟静默 60 秒空转）
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {

    // ── DSH 契约自检（10-31）────────────────────────────────────────────────
    // 插件用的是 DSH 内部服务，升级可能静默打断某个功能。启动时先照契约点一遍名：
    // 缺的非致命依赖只降级（其余照常工作），致命缺失才让这个插件失效 —— 并在
    // /api/status 与 diagnose 里持续报出来，不让它"悄悄不工作"。
    let CONTRACT = { ok: true, missing: [], degraded: [] }
    try {
      CONTRACT = runContractCheck(ctx)
      if (CONTRACT.missing.length) {
        const v = dshVersion()
        console.warn('[feiyu] DSH 契约不完整' + (v ? '（运行时 ' + v.name + '@' + v.version + '）' : '') + '：' + describeContractReport(CONTRACT))
      }
    } catch (e) { swallow(e, 'index:contract-check') }

    // 信任栅栏：fail-closed —— connection 缺失/抛错一律拒绝（写操作尤其）
    function rejected(req, res) {
      if (isLoopbackReq(req) === false) {
        json(res, 403, { ok: false, error: '只接受本机回环访问' })
        return true
      }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!rejected.warned) {
            rejected.warned = true
            console.warn('[feiyu] 信任栅栏不可用：connection 服务缺失 → 按 fail-closed 处理')
          }
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' })
          return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' })
        return true
      }
    }

    const disposers = []
    function route(pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch (e) { swallow(e, 'lib/index.js:122') }
          }
        },
      }))
    }

    // ── 状态（只读）：生物钟 / 额度 / 情绪 / 干跑 ─────────────────────────────
    route('/dsh-feiyu/api/status', async (req, res) => {
      const cfg = readToolConfig()
      const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return f } }
      const quota = readJson(dataPath('quota.json'), { log: [] })
      const today = new Date().toLocaleDateString('sv-SE')
      const todays = (quota.log ?? []).filter(x => new Date(x.at).toLocaleDateString('sv-SE') === today)
      const mood = readJson(dataPath('mood.json'), { value: 62, hunger: 0 })
      // 通道健康：QQ 真正的网关是 NapCat（8080 只是中转壳），微信看心跳文件 —— 这两个才是"服务在跑却没回复"的关键
      let qqChannel = null
      // 直接探 NapCat 端口，别再绕 qq-server 的健康接口：中间壳可能起了、也可能被代理拦，
      // 判断「能不能收发」唯一可靠的是 NapCat 本身有没有在监听。
      try {
        const napcatCfg = String((readToolConfig().qq?.napcat_http) || 'http://127.0.0.1:3000')
        const napcatUrl = napcatCfg.replace(/\/+$/, '')
        // 10-31 修：以前 host 写死 127.0.0.1，而配置里是 172.17.0.1（docker 网桥）。
        // 容器内 127.0.0.1:3000 什么都没有 → 面板永远显示「QQ 掉线」，实际在线。
        // 探活必须探配置里那个 host。
        let port = 3000
        let host = '127.0.0.1'
        try { const u = new URL(napcatUrl); port = Number(u.port) || 3000; host = u.hostname || '127.0.0.1' } catch (e) { swallow(e, 'lib/index.js:148') }
        const open = await new Promise((resolve) => {
          const sock = net.connect({ host, port })
          const finish = (v) => { try { sock.destroy() } catch (e) { swallow(e, 'lib/index.js:151') }; resolve(v) }
          sock.setTimeout(1200)
          sock.once('connect', () => finish(true))
          sock.once('error', () => finish(false))
          sock.once('timeout', () => finish(false))
        })
        qqChannel = { napcat: { ok: open, online: open, url: napcatUrl, host, port, checkedAt: Date.now() } }
      } catch { qqChannel = { napcat: { ok: false, online: false, checkedAt: Date.now() } } }
      let wxBeat = null
      try { wxBeat = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.feiyu-ai', 'wechat-heartbeat.json'), 'utf8')) } catch (e) { swallow(e, 'lib/index.js:160') }
      // RVC 唱歌音色（说话音色是 GPT-SoVITS 那套，唱歌走 RVC 换声——两套东西，面板分别显示）
      let rvcVoice = ''
      try { rvcVoice = String(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.feiyu-ai', 'rvc-voice.json'), 'utf8')).current || '') } catch (e) { swallow(e, 'lib/index.js:163') }
      // NapCat 起了但在等扫码登录时，3000 是关的 —— 这不是故障，要看二维码
      let napcatQr = null
      try {
        // 10-31：以前写死 D:/NapCat（Windows 宿主的路径）。改成配置优先 + 多平台候选，
        // 容器/Linux 上也能看到二维码，Windows 宿主行为不变。
        const qrPath = String(readToolConfig().qq?.napcat_qr_path || '') || [
          'D:/NapCat/cache/qrcode.png',
          path.join(os.homedir(), '.napcat', 'cache', 'qrcode.png'),
          '/opt/napcat/cache/qrcode.png',
        ].find((p) => { try { return fs.existsSync(p) } catch { return false } }) || 'D:/NapCat/cache/qrcode.png'
        const st = fs.statSync(qrPath)
        const age = Date.now() - st.mtimeMs
        if (age < 15 * 60_000) napcatQr = { path: qrPath, ageSec: Math.round(age / 1000) }
      } catch (e) { swallow(e, 'lib/index.js:177') }
      json(res, 200, {
        ok: true,
        today,
        scheduler: SCHED_STATUS,
        plan: readJson(nightStatePath, null),
        sharesToday: todays.filter(x => x.share).length,
        sharesMax: cfg.quota?.shareDaily ?? 3,
        commentsToday: todays.length,
        mood: { value: Math.round(Number(mood.value) || 0), hunger: Math.round(Number(mood.hunger) || 0) },
        dryRun: !!cfg.guard?.dryRun,
        selftestPassed: fs.existsSync(dataPath('selftest-passed.json')),
        ownerSet: !!(cfg.owner?.mid && cfg.owner?.name),
        qqChannel,
        wxBeat,
        napcatQr,
        // 10-31：她的记忆在 ~/.feiyu-ai，不在 session workspace 里。
        // preset 不是 danger-full-access 就会静默写不进记忆 —— 面板要能看见这条。
        permission: (() => { try { return sched?.permissionState?.() ?? null } catch { return null } })(),
        // DSH 集成契约：缺了什么依赖、会少哪块功能（升级 DSH 后第一眼看这里）
        contract: { ok: CONTRACT.ok, degraded: CONTRACT.degraded, missing: CONTRACT.missing,
          dsh: (() => { try { return dshVersion() } catch { return null } })(),
          summary: (() => { try { return describeContractReport(CONTRACT) } catch { return '未检查' } })() },
        rvcVoice,
        configPath,
      })
    })

    // ── 凭据写入（只写不回显；清洗 + nav 实时验证 —— bili-whale 的实战清洗逻辑）─────
    route('/dsh-feiyu/api/cookie', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      // 自动清洗三种最常见的粘错：带前缀 / 整条 cookie / 带引号分号
      const pick = (raw, key) => {
        let v = String(raw ?? '').trim()
        const m = v.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'))
        if (m) return m[1].trim()
        v = v.replace(new RegExp('^' + key + '\\s*=', 'i'), '')
        v = v.replace(/^["'\s]+|["';\s]+$/g, '')
        return v
      }
      const sessdata = pick(b.sessdata, 'SESSDATA')
      const bili_jct = pick(b.bili_jct, 'bili_jct')
      const buvid3 = pick(b.buvid3, 'buvid3')
      const problems = []
      if (!sessdata) problems.push('SESSDATA 空着（HttpOnly，document.cookie 读不到 —— 必须 F12 → Application → Cookies 手动复制）')
      else if (sessdata.length < 20) problems.push(`SESSDATA 太短（${sessdata.length}）——大概只复制到一半`)
      if (!bili_jct) problems.push('bili_jct 空着')
      else if (!/^[0-9a-fA-F]{32}$/.test(bili_jct)) problems.push(`bili_jct 格式可疑（${bili_jct.length} 位，应为 32 位十六进制）`)
      if (problems.length) {
        json(res, 400, { ok: false, error: '凭据有问题，没写入：\n  · ' + problems.join('\n  · ') })
        return
      }
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
      fs.writeFileSync(credentialsPath, JSON.stringify({ sessdata, bili_jct, buvid3 }, null, 2) + '\n')
      try { fs.chmodSync(credentialsPath, 0o600) } catch (e) { swallow(e, 'lib/index.js:228') }
      // 写完立刻问一次 nav，确认登录态
      let who = null, navMsg = ''
      try {
        const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', {
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${sessdata}; bili_jct=${bili_jct}; buvid3=${buvid3}` },
        })
        const navJson = await navRes.json().catch(() => ({}))
        if (navJson?.data?.isLogin && navJson.data.mid) who = { mid: String(navJson.data.mid), name: String(navJson.data.uname ?? '') }
        else navMsg = navJson?.message ?? ''
      } catch (e) { navMsg = String(e?.message ?? e).slice(0, 120) }
      json(res, 200, {
        ok: true,
        self: who,
        detail: who ? `已写入 ✓ 当前登录：${who.name}（mid ${who.mid}）`
          : '已写入，但 B站 不认这个 cookie ✗ —— 最常见：SESSDATA 复制截断 / 来自别的浏览器' + (navMsg ? `（nav：${navMsg}）` : ''),
      })
    })

    // ── 体检：spawn 真 node 跑 selftest --json ─────────────────────────────────
    route('/dsh-feiyu/api/selftest', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      execNode([FEIYU_MJS, 'selftest', '--json'], { timeout: 90_000, windowsHide: true }, (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(String(stdout || '{}'))
          json(res, 200, { ...parsed, scheduler: SCHED_STATUS, nodeError: err ? String(err.message).slice(0, 200) : null, stderr: String(stderr ?? '').slice(0, 300) })
        } catch {
          json(res, 200, { ok: false, error: String(stderr || err?.message || 'selftest 跑失败').slice(0, 300), items: [], scheduler: SCHED_STATUS })
        }
      })
    })

    // ── 设置页 UI + 配置读写 / 记忆 / 角色设定 / 音色 ──────────────────────
    const SETTINGS_HTML = path.join(HERE, 'settings.html')
    // 10-31：以前写死 D:/GPT-SoVITS/models。改成配置优先（voice.modelsDir）+ 平台候选。
    const VOICE_MODELS_DIR = String(readToolConfig().voice?.modelsDir || '')
      || (process.platform === 'win32' ? 'D:/GPT-SoVITS/models' : path.join(os.homedir(), 'GPT-SoVITS', 'models'))

    // v5：配置的读—改—写抽到 tools/lib/config-file.mjs（可单测，面板/CLI/诊断共用一份）。
    // 关键修复：读必须经过 DEFAULTS 深合并 —— 旧写法直接 JSON.parse 用户文件，
    // 缺键时返回残缺对象，20 多处 `cfg.qq?.startWithDsh === true` 全部落到
    // "undefined ≠ true" 的分支（默认值等于没生效）；面板再把残缺对象写回去，越用越薄。
    // 这里只留一层别名，避免 20 多处调用点全改。
    const readCfgFile = readConfigFile
    const writeCfgFile = (cfg) => { const r = writeConfigFile(cfg); return r.ok }

    /** 音色列表：扫 D:/GPT-SoVITS/models/<name>/ 里同时有 .wav（参考音频）和 .txt（参考文本）的目录。 */
    function listVoices() {
      const out = []
      try {
        for (const name of fs.readdirSync(VOICE_MODELS_DIR)) {
          const dir = path.join(VOICE_MODELS_DIR, name)
          let files = []
          try { files = fs.readdirSync(dir) } catch { continue }
          const wav = files.find((f) => f.toLowerCase().endsWith('.wav'))
          if (!wav) continue
          const txt = files.find((f) => f.toLowerCase().endsWith('.txt'))
          let promptText = ''
          if (txt) { try { promptText = fs.readFileSync(path.join(dir, txt), 'utf8').trim() } catch (e) { swallow(e, 'lib/index.js:287') } }
          out.push({
            name,
            ref_audio_path: path.join(dir, wav).replace(/\\/g, '/'),
            prompt_text: promptText,
            has_prompt: !!promptText,
          })
        }
      } catch (e) { swallow(e, 'lib/index.js:295') }
      return out
    }

    // 设置页
    route('/dsh-feiyu/', async (req, res) => {
      try {
        const html = fs.readFileSync(SETTINGS_HTML, 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(html)
      } catch (e) { json(res, 500, { ok: false, error: 'settings.html 读取失败：' + e.message }) }
    })

    // 配置：GET 读（api_key 脱敏）/ POST 写（白名单字段合并）
    route('/dsh-feiyu/api/config', async (req, res) => {
      if (req.method === 'GET') {
        const cfg = readCfgFile()
        const safe = JSON.parse(JSON.stringify(cfg))
        // 三处密钥都得脱敏：以前只删 llm.api_key，imageGen / vision 的 key 明文随 GET /config 进了浏览器
        for (const sec of ['llm', 'imageGen', 'vision']) {
          if (safe[sec]) { safe[sec].hasKey = !!safe[sec].api_key; delete safe[sec].api_key }
        }
        json(res, 200, { ok: true, config: safe, voices: listVoices(), configPath })
        return
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const cfg = readCfgFile()
        // 深合并：面板每个控件只发自己那几个字段，浅合并会把同节其它嵌套配置整组冲掉
        // （实测：proactive 的 activeHours、freeRoam 的 maxVideos 都被冲过）。数组整体替换，对象递归合并。
        const deepMerge = (base, over) => {
          const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) }
          for (const [k, v] of Object.entries(over || {})) {
            out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(out[k], v) : v
          }
          return out
        }
        for (const k of ['platforms', 'owner', 'identity', 'night', 'quota', 'voice', 'qq', 'wechat', 'bilibili', 'llm', 'preferences', 'share', 'imageGen', 'vision', 'rvc', 'sing', 'web', 'personality', 'freedom', 'guard']) {
          if (body[k] !== undefined && typeof body[k] === 'object' && body[k] !== null) {
            cfg[k] = deepMerge(cfg[k] ?? {}, body[k])
          }
        }
        // 「完全自由」不是"三条流水线全开"（10-26 主人纠正）：
        // 她要的是**高权限 + 自主** —— 什么时候、干什么，由她自己挑；
        // 活人也不会一边刷抖音一边刷B站一边上网，那不像活人，像三个机器人。
        // 所以总开关只负责"按时摇她起来"，具体做什么由 `feiyu focus <活动> --min N` 定，
        // 下面的 focusTick 只放行那**一件**事。这里不再连带点亮三个子循环。
        writeCfgFile(cfg)
        // 关掉完全自由就把所有循环收干净（这个语义没变）
        if (body.freedom && body.freedom.enabled === false) {
          try { stopWebRoam(); stopFreeRoam('all') } catch (e) { swallow(e, 'lib/index.js:345') }
        }
        json(res, 200, { ok: true })
        return
      }
      json(res, 405, { ok: false })
    })

    // 观看日报：聚合 B站/抖音 当天看过的内容 → Markdown（不调模型）
    route('/dsh-feiyu/api/report', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      execNode([FEIYU_MJS, 'report', '--days', String(b.days || 1)], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { json(res, 200, { ok: false, errors: [err.message, String(stderr || '').slice(0, 200)] }); return }
        const outPath = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
        let markdown = ''
        try { markdown = fs.readFileSync(outPath, 'utf8') } catch (e) { swallow(e, 'lib/index.js:362') }
        json(res, 200, { ok: true, path: outPath, markdown })
      })
    })

    // 抖音自主观看：长任务，后台跑，立刻返回
    route('/dsh-feiyu/api/watch', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const args = [FEIYU_MJS, 'watch', '--duration', String(b.duration || 10), '--max', String(b.max || 3)]
      // 只在显式传 dry=true 时加 --dry
      if (b.dry === true) args.push('--dry')
      const child = spawn(NODE_EXE, args, { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.unref()
      json(res, 200, { ok: true, note: '自主观看已开始（后台运行），结束后用「观看日报」看结果。' })
    })

    // 复盘学习日记：LLM 提炼当天看过的 → 追加私人日记（前台，快速返回）
    route('/dsh-feiyu/api/review', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      execNode([FEIYU_MJS, 'review', '--days', String(b.days || 1)], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { json(res, 200, { ok: false, errors: [err.message, String(stderr || '').slice(0, 200)] }); return }
        json(res, 200, { ok: true, text: String(stdout || '').trim() })
      })
    })

    // B站静默自助刷一轮（后台）
    route('/dsh-feiyu/api/bili-watch', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const args = [FEIYU_MJS, 'bili-watch', '--max', String(b.max || 2)]
      // 只在显式 dry=true 时才干跑；否则交给 bili-watch 内部按 guard.dryRun 判断
      // （以前这里无条件加 --dry，面板按钮永远干跑，和提示文案"按 guard.dryRun 决定"矛盾）
      if (b.dry === true) args.push('--dry')
      spawn(NODE_EXE, args, { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' }).unref()
      json(res, 200, { ok: true, note: 'B站静默刷已开始（后台），刷完会按 guard.dryRun 决定是否真发评论。' })
    })

    // 记忆摘要（最近对话 + 世界设定 + 主人事实）
    route('/dsh-feiyu/api/memory', async (req, res) => {
      const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return f } }
      // QQ 有自己的记忆文件（~/.feiyu-ai/qq/episodes.jsonl），面板要一起读，否则 QQ 对话看不见
      let episodes = []
      for (const file of [dataPath('episodes.jsonl'), dataPath('qq', 'episodes.jsonl')]) {
        try {
          const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
          episodes = episodes.concat(rows)
        } catch (e) { swallow(e, 'lib/index.js:414') }
      }
      episodes.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
      const lore = readJson(dataPath('lore.json'), [])
      const facts = readJson(dataPath('facts.json'), [])
      const count = (v) => (Array.isArray(v) ? v.length : Object.keys(v || {}).length)
      json(res, 200, {
        ok: true,
        stats: { episodes: episodes.length, lore: count(lore), facts: count(facts), byPlatform: episodes.reduce((m, e) => { const p = String(e.platform || 'misc'); m[p] = (m[p] || 0) + 1; return m }, {}) },
        recent: episodes.slice(-30).map((e) => ({ role: e.role, text: e.text || e.content || '', chatId: e.chatId || '', platform: e.platform || '' })),
      })
    })

    // 脑（v3）只读状态：面板用，不跑 LLM、不写任何文件
    route('/dsh-feiyu/api/brain', async (req, res) => {
      const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return f } }
      const countJsonl = (p) => {
        try {
          const raw = fs.readFileSync(p, 'utf8')
          let n = 0
          for (const l of raw.split('\n')) if (l.trim()) n++
          return n
        } catch { return 0 }
      }
      const epDir = dataPath('brain', 'ep')
      let episodes = 0
      try {
        for (const f of fs.readdirSync(epDir)) if (/\.jsonl$/i.test(f)) episodes += countJsonl(path.join(epDir, f))
      } catch (e) { swallow(e, 'lib/index.js:442') }
      const facts = readJson(dataPath('brain', 'sem', 'facts.json'), {})
      const factRows = Object.values(facts || {}).flat().filter((x) => x && x.id)
      const intents = readJson(dataPath('brain', 'intent', 'intents.json'), [])
      const intentRows = Array.isArray(intents) ? intents : Object.values(intents || {})
      const cursor = readJson(dataPath('brain', 'meta', 'consolidate-cursor.json'), null)
      const metrics = readJson(dataPath('brain', 'meta', 'metrics.json'), { days: {} })
      const schemata = readJson(dataPath('brain', 'sem', 'schemata.json'), { items: [] })
      const competence = readJson(dataPath('brain', 'sem', 'competence.json'), { items: [] })
      const taskRows = (readJson(dataPath('brain', 'task', 'tasks.json'), { rows: [] }).rows) || []
      const dayKey = new Date().toLocaleDateString('sv-SE').replace(/-/g, '')
      const cfg = readCfgFile()
      json(res, 200, {
        ok: true,
        mode: cfg?.brain?.mode || 'shadow',
        episodes,
        facts: {
          total: factRows.length,
          active: factRows.filter((f) => f.status === 'active').length,
          noProv: factRows.filter((f) => !(f.prov || []).length).length,
        },
        intents: {
          total: intentRows.length,
          byState: intentRows.reduce((m, x) => { const s = String(x.state || '?'); m[s] = (m[s] || 0) + 1; return m }, {}),
        },
        consolidation: { lastRunAt: cursor?.lastRunAt || 0, processed: cursor?.processed || 0 },
        derived: {
          schemata: (schemata?.items || []).length,       // O6：够 30 天×5 次才有的规律
          competence: (competence?.items || []).length,   // O13：成功 3 次才算会
        },
        tasks: {
          queued: taskRows.filter((r) => r.state === 'queued').length,
          leased: taskRows.filter((r) => r.state === 'leased').length,
        },
        today: metrics?.days?.[dayKey] || {},
      })
    })

    // 角色设定（persona.md 读写）
    const personaFile = homePath('.feiyu-ai', 'persona.md')
    // ── 手动重钉会话权限（面板「修复权限」按钮）────────────────────────────────
    // 她的记忆在 ~/.feiyu-ai，不在 session workspace 里。DSH 默认 workspace-write
    // 会让她写得进日记（workspace 内）却写不进记忆（workspace 外）—— 静默失效。
    route('/dsh-feiyu/api/perm/fix', async (req, res) => {
      if (req.method === 'GET') {
        let cur = null
        try { cur = sched?.permissionState?.() ?? null } catch (e) { swallow(e, 'lib/index.js:488') }
        return json(res, 200, { ok: true, permission: cur })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 GET / POST' })
      try {
        const r = await sched?.reassertPermission?.()
        let cur = null
        try { cur = sched?.permissionState?.() ?? null } catch (e) { swallow(e, 'lib/index.js:495') }
        json(res, 200, { ok: r === true, permission: cur })
      } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
    })

    route('/dsh-feiyu/api/persona', async (req, res) => {
      if (req.method === 'GET') {
        let text = '', exists = false, readError = ''
        try {
          text = fs.readFileSync(personaFile, 'utf8')
          exists = true
        } catch (e) {
          // 10-31 审计：以前这里吞掉一切错误只回空串，前端拿到空串一保存就把人格清空。
          // 现在把「文件不存在」和「读失败」分开报，前端才知道该不该显示为空白。
          if (e && e.code !== 'ENOENT') readError = String(e.message || e)
        }
        json(res, 200, { ok: true, text, exists, readError, path: personaFile })
        return
      }
      if (req.method === 'POST') {
        let body
        try { body = JSON.parse(await readBody(req)) }
        catch { json(res, 400, { ok: false, error: 'body 不是合法 JSON' }); return }
        const next = String(body.text ?? '')
        // 空写保护：人格文件不允许被一个空的 text 覆盖掉（这比误删还难发现）
        if (!next.trim() && !body.allowEmpty) {
          json(res, 400, { ok: false, error: '拒绝写入空白人格；真要清空请传 allowEmpty:true' })
          return
        }
        // 写前自动快照到 persona.history/<日期>.md（同日只留第一份 = 今天改之前的原样）
        let backup = ''
        try {
          if (fs.existsSync(personaFile)) {
            const d = new Date()
            const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            const dir = path.join(path.dirname(personaFile), 'persona.history')
            fs.mkdirSync(dir, { recursive: true })
            const dst = path.join(dir, `${day}.md`)
            if (!fs.existsSync(dst)) { fs.copyFileSync(personaFile, dst); backup = dst }
          }
        } catch (e) { swallow(e, 'lib/index.js:535') }
        try {
          fs.mkdirSync(path.dirname(personaFile), { recursive: true })
          // 先写临时文件再 rename：断电/崩溃不会留下半个文件
          const tmp = personaFile + '.tmp-' + process.pid
          fs.writeFileSync(tmp, next, { mode: 0o600 })
          fs.renameSync(tmp, personaFile)
        } catch (e) {
          json(res, 500, { ok: false, error: String(e.message || e) })
          return
        }
        json(res, 200, { ok: true, bytes: Buffer.byteLength(next), backup })
        return
      }
      json(res, 405, { ok: false })
    })

    // 音色试听：spawn node 跑 synth + NapCat 发语音到主人 QQ
    route('/dsh-feiyu/api/voice-test', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const cfg = readCfgFile()
      // 允许指定"试听哪个音色"：以前完全不读 body，两个 UI 传来的参数都被丢掉，永远试存盘那个
      const b = JSON.parse(await readBody(req) || '{}')
      const ov = {}
      if (b.ref_audio_path) ov.ref_audio_path = String(b.ref_audio_path)
      if (b.prompt_text) ov.prompt_text = String(b.prompt_text)
      if (b.prompt_lang) ov.prompt_lang = String(b.prompt_lang)
      if (!ov.ref_audio_path && b.name) {
        try {
          const hit = listVoices().find((x) => x.name === String(b.name))
          if (hit) { ov.ref_audio_path = hit.ref_audio_path; if (hit.prompt_text) ov.prompt_text = hit.prompt_text }
        } catch (e) { swallow(e, 'lib/index.js:566') }
      }
      const qq = cfg.qq || {}
      const ownerQQ = cfg.owner?.qq
      if (!ownerQQ) { json(res, 400, { ok: false, error: '先在「主人」里填 QQ 号（试听要发给你）' }); return }
      const napcat = (qq.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
      const ttsFile = path.join(PLUGIN_ROOT, 'tools', 'lib', 'tts.mjs').replace(/\\/g, '/')
      const code = [
        `import { synth } from 'file:///${ttsFile}'`,
        `const f = await synth('主人，这是我现在的声音，好听吗？', undefined, ${JSON.stringify(ov)})`,
        `const r = await fetch('${napcat}/send_private_msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: ${JSON.stringify(String(ownerQQ))}, message: [{ type: 'record', data: { file: f } }] }) })`,
        `const j = await r.json()`,
        `if (!j || j.status !== 'ok') throw new Error(JSON.stringify(j).slice(0, 200))`,
        `console.log('ok')`,
      ].join('\n')
      execNode(['--input-type=module', '-e', code], { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { json(res, 500, { ok: false, error: String(stderr || err.message).slice(0, 300) }); return }
        json(res, 200, { ok: true })
      })
    })

    // 全部音色逐个试听（voice tryall）+ 让她唱一首（sing）—— 后台跑，结果发主人 QQ
    for (const [pathName, args] of [['voice-tryall', ['voice', 'tryall']], ['sing', ['sing']]]) {
      route(`/dsh-feiyu/api/${pathName}`, async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
        if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
        const b = JSON.parse(await readBody(req) || '{}')
        spawn(NODE_EXE, [FEIYU_MJS, ...args, ...(b.theme ? [String(b.theme)] : [])], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' }).unref()
        json(res, 200, { ok: true, note: pathName === 'sing' ? '写词合成中，唱完发你 QQ 🎵' : '逐个试听中，注意 QQ 语音消息 🎧' })
      })
    }

    // ── 常驻服务（QQ / 微信）：随 DSH 起停，也能在设置面板里单独重启 ──────────
    // 平台开关存盘后不必重启整个 DSH：点一下「重启服务」就是 kill + 重新 spawn。
    let qqProc = null
    let wechatProc = null

    const procAlive = (p) => !!p && p.exitCode === null && p.signalCode === null
    // NODE_EXE 是 launcher，会再 spawn 一个真 node；只 kill launcher 会让子进程变孤儿继续占端口。
    const killTree = (proc) => {
      if (!proc) return
      const pid = proc.pid
      try { proc.kill() } catch (e) { swallow(e, 'lib/index.js:608') }
      try { spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 5000 }) } catch (e) { swallow(e, 'lib/index.js:609') }
    }
    const procInfo = (p) => ({ running: procAlive(p), pid: (p && p.pid) || null })

    // 端口上残留的旧实例（上次 DSH 没杀干净 / 手动起的 / 崩溃后留的僵尸）必须先清掉：
    // 否则新实例绑不上端口 → 静默退出 → 面板显示"开了"但其实没跑（10-25 抖音私信就是这个现象）。
    // 只杀 node.exe，绝不误伤同端口的第三方服务。
    function killPortListeners(port, tag = '') {
      try {
        const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
        const re = new RegExp(`:${port}\\s+.*LISTENING`, 'i')
        const pids = new Set()
        for (const line of String(r.stdout || '').split('\n')) {
          if (!re.test(line)) continue
          const m = line.trim().match(/(\d+)\s*$/)
          if (m) pids.add(m[1])
        }
        for (const pid of pids) {
          const tl = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
          if (!/node\.exe/i.test(String(tl.stdout || ''))) continue
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
          try { console.log(`[feiyu] 清掉占用 ${port} 的旧${tag}实例 pid=${pid}`) } catch (e) { swallow(e, 'lib/index.js:630') }
        }
      } catch (e) { swallow(e, 'lib/index.js:632') }
    }
// 看门狗用：端口上有没有活着的 /health（有就什么都不做，别去抢别人的进程）
    function portHealthy(port) {
      return new Promise((resolve) => {
        try {
          const req = http.get({ host: '127.0.0.1', port: Number(port), path: '/health', timeout: 2500 }, (r) => {
            let b = ''
            r.on('data', (d) => { b += d })
            r.on('end', () => resolve(r.statusCode === 200))
          })
          req.on('timeout', () => { req.destroy(); resolve(false) })
          req.on('error', () => resolve(false))
        } catch { resolve(false) }
      })
    }

    function startQQ() {
      const cfg = readCfgFile()
      if (cfg.platforms?.qq === false || cfg.qq?.enabled === false) return { ok: false, error: 'QQ 平台开关是关的（platforms.qq / qq.enabled 任一为 false 均不启动）' }
      if (procAlive(qqProc)) return { ok: true, already: true, pid: qqProc.pid }
      if (!NODE_EXE) return { ok: false, error: globalThis.__feiyuNodeError || '未找到 node 运行时' }
      const port = String(cfg.qq?.port || 8080)
      // 10-31：先看单实例锁 —— 如果 im-gateway.sh 已经拉起了 qq-server，
      // 这里就**接管**而不是杀掉重开（以前 killPortListeners 会杀掉守护进程，
      // 守护立刻重启，再被杀……无限拉锯）。
      try {
        const lockFile = dataPath('locks', 'qq-server.lock')
        if (fs.existsSync(lockFile)) {
          const pid = Number(fs.readFileSync(lockFile, 'utf8'))
          if (pid) {
            let alive = false
            try { process.kill(pid, 0); alive = true } catch {}
            if (alive) {
              console.log('[feiyu] qq-server 已由外部守护运行（pid ' + pid + '）—— 直接接管，不再另起')
              return { ok: true, adopted: true, pid }
            }
          }
        }
      } catch (e) { swallow(e, 'index:qq-lock-check') }
      killPortListeners(port, ' QQ ')
      const child = spawn(NODE_EXE, [FEIYU_MJS, 'qq-server', port], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.on('exit', (code) => { qqProc = null; try { console.log(`[feiyu] qq-server 退出 code=${code}`) } catch (e) { swallow(e, 'lib/index.js:657') } })
      qqProc = child
      // QQ 开了才拉全家：网关(NapCat) +2.5s、语音(SoVITS) +6s —— 错开启动高峰，别瞬间挤爆电脑
      setTimeout(() => { ensureGateway() }, 2500)
      setTimeout(() => { try { ensureSovits() } catch (e) { swallow(e, 'lib/index.js:661') } }, 6000)
      return { ok: true, pid: child.pid }
    }
    function stopQQ() {
      if (qqProc) { killTree(qqProc); qqProc = null }
      // 开关关 = QQ 全家收摊：网关（NapCat/QQ 客户端 ~500MB）+ 语音（SoVITS ~450MB）一起停，
      // 不然"关了开关"内存一点没省
      try { stopGateway() } catch (e) { swallow(e, 'lib/index.js:668') }
      try { killTree(sovitsProc) } catch (e) { swallow(e, 'lib/index.js:669') }
      return { ok: true }
    }
    function startWechat() {
      const cfg = readCfgFile()
      if (cfg.platforms?.wechat === false || cfg.wechat?.enabled === false) return { ok: false, error: '微信平台开关是关的（platforms.wechat / wechat.enabled 任一为 false 均不启动）' }
      if (procAlive(wechatProc)) return { ok: true, already: true, pid: wechatProc.pid }
      const wx = cfg.wechat ?? {}
      if (!wx.python || !wx.script) return { ok: false, error: '配置里缺 wechat.python / wechat.script' }
      const child = spawn(wx.python, [wx.script], { windowsHide: true, stdio: 'ignore' })
      child.on('exit', (code) => { wechatProc = null; try { console.log(`[feiyu] 微信机器人退出 code=${code}`) } catch (e) { swallow(e, 'lib/index.js:679') } })
      wechatProc = child
      return { ok: true, pid: child.pid }
    }
    function stopWechat() {
      if (wechatProc) { killTree(wechatProc); wechatProc = null }
      return { ok: true }
    }
    // 自由刷（抖音/B站 各一个进程，可同时跑：抖音用无头 Chrome、B站纯 API，互不抢资源）
    let freeRoamBiliProc = null
    function startFreeRoam(platform) {
      // 10-31：抖音那条路已整体移除，这里只剩 B站（纯 API，不需要浏览器）。
      if (platform && platform !== 'bilibili') return { ok: false, error: '只支持 bilibili（抖音已移除）' }
      const cfg = readCfgFile()
      const fr = cfg.bilibili?.freeRoam
      if (fr?.enabled === false) return { ok: false, error: 'bilibili 自由刷开关（freeRoam.enabled）是关的' }
      if (procAlive(freeRoamBiliProc)) return { ok: true, already: true, pid: freeRoamBiliProc.pid }
      if (!NODE_EXE) return { ok: false, error: globalThis.__feiyuNodeError || '未找到 node 运行时' }
      const child = spawn(NODE_EXE, [FEIYU_MJS, 'bili-watch', '--free'], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => { freeRoamBiliProc = null; try { console.log('[feiyu] bilibili 自由刷退出') } catch (e) { swallow(e, 'lib/index.js:698') } })
      freeRoamBiliProc = child
      return { ok: true, pid: child.pid }
    }
    function stopFreeRoam(platform) {
      void platform   // 只还剩 B站一条，参数留着兼容面板调用
      killTree(freeRoamBiliProc); freeRoamBiliProc = null
      return { ok: true }
    }
    // 自由上网（web --free 常驻）：她在全网瞎溜达/玩/学习/自我升级 —— 跟自由刷同款开关哲学
    let webRoamProc = null
    function startWebRoam() {
      const cfg = readCfgFile()
      if (cfg.web?.roam?.enabled === false) return { ok: false, error: '自由上网开关（web.roam.enabled）是关的' }
      if (procAlive(webRoamProc)) return { ok: true, already: true, pid: webRoamProc.pid }
      if (!NODE_EXE) return { ok: false, error: globalThis.__feiyuNodeError || '未找到 node 运行时' }
      const child = spawn(NODE_EXE, [FEIYU_MJS, 'web', 'roam'], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => { webRoamProc = null; try { console.log('[feiyu] 自由上网退出') } catch (e) { swallow(e, 'lib/index.js:715') } })
      webRoamProc = child
      return { ok: true, pid: child.pid }
    }
    function stopWebRoam() {
      killTree(webRoamProc); webRoamProc = null
      return { ok: true }
    }
    // 「一次只做一件事」（10-26 主人纠正：三个循环全开 = 没了自主性，也不像活人）
    //
    // 模型：完全自由只管"按时摇她起来"；起来之后她**自己挑一件**，写在 ~/.dsh/feiyu-focus.json
    // （`feiyu focus web --min 25`）。这个 tick 只放行她挑的那一件，其余一律停掉；
    // 到点自动收工 → 什么都不跑 → 下次醒了再挑。歇着（rest）也照样收干净。
    // 没有 focus 记录时不干预 —— 面板手动开的那一套还是手动说了算。
    const focusTick = () => {
      try {
        const cfg = readCfgFile()
        // 10-31：统一规划（mind）也能驱动 focus，不再要求先手动开 freedom
        if (cfg.freedom?.enabled !== true && cfg.mind?.enabled !== true) return
        const f = readFocus()
        // 没有 focus：如果 mind 在驱动，就用她刚决定的那个计划落地；否则不干预
        if (!f) {
          try {
            const pn = MIND.planSnapshot()
            if (pn && pn.plan && !pn.expired) writeFocus(pn.activity, pn.remainMin, pn.why)
          } catch (e) { swallow(e, 'lib/index.js:740') }
          return
        }
        const now = Date.now()
        const until = Number(f.until || 0)
        const activity = String(f.activity || '')

        // 到点收工：停干净 + 记成"自由时间"，下次醒了她再挑
        if (until && until <= now) {
          let stopped = false
          if (procAlive(webRoamProc)) { stopWebRoam(); stopped = true }
          if (procAlive(freeRoamBiliProc)) { stopFreeRoam('all'); stopped = true }
          try {
            const cfg2 = readCfgFile()
            if (syncSwitches(cfg2, '')) writeCfgFile(cfg2)
          } catch (e) { swallow(e, 'lib/index.js:755') }
          writeFocus('', 0, '到点收工')
          try { console.log('[feiyu] 完全自由：' + (isLoopActivity(activity) ? labelOf(activity) + ' 到点' : '空闲时段结束') + '，已收工' + (stopped ? '（循环已停）' : '')) } catch (e) { swallow(e, 'lib/index.js:757') }
          return
        }

        const want = isLoopActivity(activity) ? activity : null
        // 1) 不是她挑的那件 → 停
        if (want !== 'web' && procAlive(webRoamProc)) { stopWebRoam(); try { console.log('[feiyu] 让位：先停下自由上网（一次只做一件事）') } catch (e) { swallow(e, 'lib/index.js:763') } }
        if (want !== 'bilibili' && procAlive(freeRoamBiliProc)) { stopFreeRoam('bilibili'); try { console.log('[feiyu] 让位：先停下自由刷B站（一次只做一件事）') } catch (e) { swallow(e, 'lib/index.js:764') } }
        // 2) 开关跟"当下这件事"对齐（面板看到的就是真的）
        try {
          const cfg2 = readCfgFile()
          if (syncSwitches(cfg2, want || '')) writeCfgFile(cfg2)
        } catch (e) { swallow(e, 'lib/index.js:769') }
        // 3) 她挑的那件没在跑 → 拉起（崩了也自愈）
        if (want === 'web' && !procAlive(webRoamProc) && startWebRoam().ok) { try { console.log('[feiyu] 开始自由上网（她自己挑的）') } catch (e) { swallow(e, 'lib/index.js:771') } }
        if (want === 'bilibili' && !procAlive(freeRoamBiliProc) && startFreeRoam('bilibili').ok) { try { console.log('[feiyu] 开始刷B站（她自己挑的）') } catch (e) { swallow(e, 'lib/index.js:772') } }
      } catch (e) { swallow(e, 'lib/index.js:773') }
    }
    focusTick()
    // ── 统一自主规划循环（10-31）──────────────────────────────────────
    // 每 60 秒看一次：计划还剩多久？没有计划 / 到点 / 闲太久 → 让她自己重规划。
    // 决定权在 LLM（她的上下文），这里只负责按时叫醒她。
    let mindBusy = false
    let mindLastAt = 0
    const mindTick = () => {
      if (mindBusy) return
      const cfgM = readCfgFile()
      if (cfgM.mind?.enabled !== true) return
      if (Date.now() - mindLastAt < Number(cfgM.mind?.minGapMin ?? 25) * 60_000) return
      let snap
      try { snap = MIND.planSnapshot() } catch { return }
      const havePlan = Boolean(snap.plan) && !snap.expired
      const fNow = readFocus()
      const doing = fNow && fNow.activity ? fNow.activity : ''
      const idleLong = !doing && (!snap.plan || Date.now() - Number(snap.plan.until || 0) > Number(cfgM.mind?.idleMinutes ?? 20) * 60_000)
      if (havePlan && !idleLong) return
      mindBusy = true
      mindLastAt = Date.now()
      MIND.plan({ force: !havePlan })
        .then((r) => {
          if (!r) return
          try { console.log('[feiyu] 🧠 她决定了接下来做什么：' + labelOf(r.activity) + ' · ' + r.min + ' 分钟' + (r.why ? '（' + r.why + '）' : '')) } catch (e) { swallow(e, 'lib/index.js:798') }
          try {
            const h = dataPath('mind-history.jsonl')
            fs.mkdirSync(path.dirname(h), { recursive: true })
            fs.appendFileSync(h, JSON.stringify({ at: Date.now(), activity: r.activity, min: r.min, why: r.why }) + '\n')
          } catch (e) { swallow(e, 'lib/index.js:803') }
          try { focusTick() } catch (e) { swallow(e, 'lib/index.js:804') }
        })
        .catch(() => {})
        .finally(() => { mindBusy = false })
    }
    // v5：定时器统一交给 lifecycle 登记（幂等 + 可观测 + 卸载时一定清干净）。
    // 旧版这里是裸 setInterval，dispose 只清了 webRoamHeal / sovitsTimer —— mindTick 与
    // watchServices 从来没被清过，插件热重载一次就有两份 tick 在跑、两份同时写记忆。
    lifecycle.every('mindTick', mindTick, 60_000)
    lifecycle.every('webRoamHeal', focusTick, 60_000)
    setTimeout(() => { void mindTick().catch(() => {}) }, 30_000)
// 服务看门狗（10-27）：真实翻车是"抖音私信 09:46 起过一次，之后进程没了，主人发私信一整天没人回"。
    // 只在配置 startWithDsh:true 时管；端口上已经有活的服务就跳过（不抢别人起的实例）。
    let svcWatch = { qq: 0, dm: 0 }
    async function watchServices() {
      const cfg = readCfgFile()
      const now = Date.now()
      if (cfg.platforms?.qq !== false && cfg.qq?.enabled !== false && cfg.qq?.startWithDsh === true && !procAlive(qqProc) && now - svcWatch.qq > 3 * 60_000) {
        if (!(await portHealthy(String(cfg.qq?.port || 8080)))) {
          svcWatch.qq = now
          const r = startQQ()
          try { console.log('[feiyu] 看门狗：QQ 服务没在跑 → ' + (r.ok ? '已拉起 pid=' + r.pid : '拉起失败 ' + r.error)) } catch (e) { swallow(e, 'lib/index.js:822') }
        }
      }
    }
    lifecycle.every('watchServices', watchServices, 60_000, { runNow: true, runAfterMs: 12_000 })

    const svcSnapshot = () => ({
      qq: procInfo(qqProc), wechat: procInfo(wechatProc),
      freeRoamBili: procInfo(freeRoamBiliProc),
      webRoam: procInfo(webRoamProc),
      freeRoam: procInfo(freeRoamBiliProc),
    })

    route('/dsh-feiyu/api/services', async (req, res) => {
      if (req.method === 'GET') { json(res, 200, { ok: true, services: svcSnapshot() }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = JSON.parse((await readBody(req)) || '{}')
      const target = String(body.target || 'all')
      const action = String(body.action || 'restart')
      const errors = []
      const run = (fn, label) => { const r = fn(); if (!r.ok && r.error) errors.push(`${label}：${r.error}`); return r }
      if (target === 'qq' || target === 'all') {
        if (action === 'stop' || action === 'restart') run(stopQQ, 'QQ')
        if (action === 'start' || action === 'restart') {
          await new Promise((r) => setTimeout(r, 400))
          run(startQQ, 'QQ')
        }
      }
      if (target === 'napcat') {
        // QQ 真正的网关是 NapCat（D:/NapCat），它必须管理员权限注入 QQ。
        // install：弹一次 UAC，注册成"登录即启动 + 最高权限"的计划任务，以后不再需要授权。
        // start  ：直接跑那个计划任务（不需要再弹 UAC）。
        const bat = String(body.launcher || 'D:/NapCat/launcher-user.bat')
        const act = String(body.action || 'install')
        const taskName = String(body.task || 'DSH-Feiyu-NapCat')

        if (act === 'start') {
          const r = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8', windowsHide: true })
          const bad = r.status !== 0
          json(res, 200, {
            ok: !bad,
            services: svcSnapshot(),
            errors: bad ? ['启动计划任务失败：' + String(r.stderr || r.stdout || '').trim()] : [],
            note: bad ? '' : '已启动 QQ 网关（计划任务 ' + taskName + '）',
          })
          return
        }

        // 用自提权 bat：它先注册计划任务（登录自启 + 最高权限），失败就直接把 NapCat 拉起来。
        const helper = String(body.helper || 'D:/NapCat/start-qq-gateway.bat')
        if (!fs.existsSync(bat)) {
          json(res, 200, { ok: false, services: svcSnapshot(), errors: ['没找到 QQ 网关启动器：' + bat] })
          return
        }
        if (!fs.existsSync(helper)) {
          json(res, 200, { ok: false, services: svcSnapshot(), errors: ['缺少自提权脚本：' + helper] })
          return
        }
        // 让 NapCat 用快速登录：账号是「机器人自己的 QQ 号」（NapCat 登录态），不是 owner.qq。
        // 从 NapCat 配置文件 napcat_<QQ>.json 自动探测，其次用显式 qq.account。
        try {
          let acc = ''
          const configDir = path.join(path.dirname(bat), 'config')
          const m = fs.readdirSync(configDir).find(f => /^napcat_(\d+)\.json$/.test(f))
          if (m) acc = m.match(/^napcat_(\d+)\.json$/)[1]
          if (!acc) acc = String((readToolConfig().qq?.account) || '').trim()
          if (acc) fs.writeFileSync(path.join(path.dirname(bat), 'qq-account.txt'), acc + '\n')
        } catch (e) { swallow(e, 'lib/index.js:890') }
        try {
          spawn('powershell.exe', ['-NoProfile', '-Command',
            `Start-Process -FilePath '${helper}' -WorkingDirectory '${path.dirname(helper)}' -ArgumentList 'elevated' -Verb RunAs`],
          { windowsHide: true, stdio: 'ignore', detached: true }).unref()
          json(res, 200, {
            ok: true,
            services: svcSnapshot(),
            errors: [],
            note: '已请求管理员权限：UAC 弹窗点「是」后会自动注册开机自启并启动 QQ，之后再也不用授权。',
          })
        } catch (e) {
          json(res, 200, { ok: false, services: svcSnapshot(), errors: ['拉起 QQ 网关失败：' + e.message] })
        }
        return
      }
      if (target === 'wechat' || target === 'all') {
        if (action === 'stop' || action === 'restart') run(stopWechat, '微信')
        if (action === 'start' || action === 'restart') run(startWechat, '微信')
      }
      // 手动开/关也要服从"一次只做一件事"，否则面板刚点开就被 focusTick 让位掉：
      //   手动 start  = "就让她现在做这个" → 顺手把 focus 改成它（别的活动随之让位）
      //   手动 stop   = "这件别做了"     → focus 记成收工，免得 60 秒后又被她/自愈拉起
      if (target === 'free-roam') {
        const plat = 'bilibili'
        if (action === 'stop' || action === 'restart') run(() => stopFreeRoam(String(body.platform || '')), '自由刷')
        if (action === 'start' || action === 'restart') run(() => startFreeRoam('bilibili'), '自由刷')
        try {
          if (action === 'start') writeFocus(plat, 0, '面板手动开始')
          else writeFocus('off', 0, '面板手动停掉')
        } catch (e) { swallow(e, 'lib/index.js:920') }
      }
      if (target === 'web-roam') {
        if (action === 'stop' || action === 'restart') run(stopWebRoam, '自由上网')
        if (action === 'start' || action === 'restart') run(startWebRoam, '自由上网')
        try {
          if (action === 'start') writeFocus('web', 0, '面板手动开始')
          else writeFocus('off', 0, '面板手动停掉')
        } catch (e) { swallow(e, 'lib/index.js:928') }
      }
      json(res, 200, { ok: errors.length === 0, services: svcSnapshot(), errors })
    })

    // ── 生物钟 ────────────────────────────────────────────────────────────────
    let sched = null
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true })
      sched = startScheduler(ctx, {
        dshHome: DSH_HOME,
        feiyuMjs: FEIYU_MJS,
        cwd: WORK_DIR,
        sessionId: 'feiyu',
        log: (m) => { try { console.log(m) } catch (e) { swallow(e, 'lib/index.js:942') } },
      })
      SCHED_STATUS = { ok: true, reason: '已启动（每 60 秒 tick）', at: new Date().toISOString() }
    } catch (e) {
      SCHED_STATUS = { ok: false, reason: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
      try { console.warn('[feiyu] 生物钟启动失败：' + e.message) } catch (e) { swallow(e, 'lib/index.js:947') }
    }

    // ── QQ 网关（NapCat）：跟随 QQ 服务按需拉起 ─────────────────────────────
    // QQ 是 Electron 客户端，常驻要 400~700MB。10-24 起不再随 DSH 启动全家桶 ——
    // QQ 开关打开时才拉（startQQ 里调），QQ 开关关着就别动它。
    const GATEWAY_TASK = 'DSH-Feiyu-NapCat'
    const portOpen = (port, timeout = 800) => new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (done) return; done = true; try { sock.destroy() } catch (e) { swallow(e, 'lib/index.js:956') } resolve(v) }
      const sock = net.connect({ host: '127.0.0.1', port })
      sock.setTimeout(timeout)
      sock.once('connect', () => finish(true))
      sock.once('error', () => finish(false))
      sock.once('timeout', () => finish(false))
    })

    const ensureGateway = async () => {
      try {
        if (await portOpen(3000)) return                    // 已经有人拉起来了，别开第二个
        const r = spawnSync('schtasks.exe', ['/Run', '/TN', GATEWAY_TASK], { windowsHide: true, timeout: 5000 })
        if (r && r.status === 0) console.log('[feiyu] QQ 网关已拉起（计划任务 ' + GATEWAY_TASK + '，QQ 登录约需 3-4 分钟）')
      } catch { /* 没装过任务就算了，面板上会提示 */ }
    }

    /** 语音服务（GPT-SoVITS）随 DSH 起停：有声音开关、服务挂了，等于没声音。 */
    let sovitsProc = null
    const SOVITS_LOCK = path.join(os.homedir(), '.feiyu-ai', 'sovits.lock')
    const startSovits = () => {
      const cfg2 = readToolConfig()
      if (cfg2.qq?.voice_enabled === false || cfg2.voice?.autoStartSovits === false) return
      if (sovitsProc && procAlive(sovitsProc)) return
      const cmd = cfg2.voice?.sovitsCmd || 'D:/GPT-SoVITS/.venv/Scripts/python.exe'
      const script = cfg2.voice?.sovitsScript || 'D:/GPT-SoVITS/api_v2.py'
      if (!fs.existsSync(cmd) || !fs.existsSync(script)) return
      const child = spawn(cmd, [script, '-a', '127.0.0.1', '-p', '9880'],
        { cwd: path.dirname(script), windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => { sovitsProc = null })
      sovitsProc = child
      try { console.log('[feiyu] 已拉起 GPT-SoVITS 语音服务（9880）') } catch (e) { swallow(e, 'lib/index.js:986') }
    }
    const ensureSovits = async () => {
      try {
        if (await portOpen(9880, 800)) { try { fs.unlinkSync(SOVITS_LOCK) } catch (e) { swallow(e, 'lib/index.js:990') }; return }
        // 模型加载约 90s：窗口内别重复 spawn 第二个实例
        try { const st = fs.statSync(SOVITS_LOCK); if (Date.now() - st.mtimeMs < 150_000) return } catch (e) { swallow(e, 'lib/index.js:992') }
        try { fs.mkdirSync(path.dirname(SOVITS_LOCK), { recursive: true }); fs.writeFileSync(SOVITS_LOCK, String(Date.now())) } catch (e) { swallow(e, 'lib/index.js:993') }
        startSovits()
      } catch (e) { swallow(e, 'lib/index.js:995') }
    }
    // 语音服务只在 QQ 活着（或显式 startWithDsh）时才自动拉/探活 ——
    // QQ 都没开，450MB 的 SoVITS 就别白占了
    const sovitsWanted = () => procAlive(qqProc) || readCfgFile().qq?.startWithDsh === true
    setTimeout(() => { if (sovitsWanted()) ensureSovits() }, 6000)
    lifecycle.every('sovitsWatch', () => { if (sovitsWanted()) ensureSovits() }, 60_000)

    /** DSH 退出时收掉网关：先结束计划任务，再兜底关 QQ（它就是 NapCat 的宿主）。 */    const stopGateway = () => {
      try {
        const qqCfg = readToolConfig().qq ?? {}
        if (qqCfg.stopWithDsh === false) return
        try { spawnSync('schtasks.exe', ['/End', '/TN', GATEWAY_TASK], { windowsHide: true, timeout: 8000 }) } catch (e) { swallow(e, 'lib/index.js:1007') }
        try {
          if (qqCfg.killQqOnExit !== false) {
            spawnSync('taskkill.exe', ['/F', '/T', '/IM', 'QQ.exe'], { windowsHide: true, timeout: 8000 })
            spawnSync('taskkill.exe', ['/F', '/IM', 'NapCatWinBootMain.exe'], { windowsHide: true, timeout: 8000 })
          }
        } catch (e) { swallow(e, 'lib/index.js:1013') }
      } catch (e) { swallow(e, 'lib/index.js:1014') }
    }

    // ── 常驻服务按需启动（10-24 用户拍板）─────────────────────────────────
    // DSH 开机不再全家桶（QQ 客户端+SoVITS+微信+dm 的 Chrome 一起起，电脑瞬间卡死）：
    // QQ / 微信 / 抖音私信陪聊 全部由面板开关点开才启动。
    // 想恢复"随 DSH 自动启动"：配置里给对应服务加 "startWithDsh": true。
    if (readCfgFile().qq?.startWithDsh === true) {
      try { startQQ() } catch (e) { try { console.warn('[feiyu] qq-server 自启失败：' + e.message) } catch (e) { swallow(e, 'lib/index.js:1022') } }
    }
    if (readCfgFile().wechat?.startWithDsh === true) {
      try { startWechat() } catch (e) { try { console.warn('[feiyu] 微信机器人自启失败：' + e.message) } catch (e) { swallow(e, 'lib/index.js:1025') } }
    }
    // 完全自由 startWithDsh（10-26）：主人要的是"她一直自己在过日子"，重启后不用再去面板点一遍。
    // 但注意：**不启动任何循环** —— 只把总开关保持开着，让她下次醒来自己挑那一件事
    //（启动就把三条流水线全拉开，正好是主人否掉的"没自主性"）。当前那件事如果还没到点，
    // 下面的 focusTick 会把它拉起来。
    if (readCfgFile().freedom?.startWithDsh === true) {
      try {
        const cfg = readCfgFile()
        let dirty = false
        if (cfg.freedom?.enabled !== true) { cfg.freedom = { ...(cfg.freedom || {}), enabled: true }; dirty = true }
        // 退出时子开关都被复位了，这里按 focus 记录对齐（没有记录就全关）
        const f = readFocus()
        const keep = f && Number(f.until || 0) > Date.now() && isLoopActivity(f.activity) ? String(f.activity) : ''
        if (syncSwitches(cfg, keep)) dirty = true
        if (dirty) writeCfgFile(cfg)
        try {
          console.log('[feiyu] 完全自由随 DSH 自启：总开关已开，' + (keep ? '接着' + labelOf(keep) : '等她自己挑下一件事'))
        } catch (e) { swallow(e, 'lib/index.js:1043') }
      } catch (e) { try { console.warn('[feiyu] 完全自由自启失败：' + e.message) } catch (e) { swallow(e, 'lib/index.js:1044') } }
    }
    // 注意：自由刷默认不随 DSH 自动启动 —— 它是"手动点开、DSH 在才刷"的东西，
    // 退出时下面 dispose 会把 freeRoam.enabled 复位成 false，下次打开面板看到的就是真实状态。

    /** DSH 退出时把"按需开关"复位：进程都停了，开关留着"开"就是假状态。
     *  自由刷 + QQ + 微信 + 抖音私信陪聊（除非配置了 startWithDsh:true 要自启，那开关本来就是开的）。 */
    const resetOnExitToggles = () => {
      try {
        const cfg = readCfgFile()
        let changed = false
        const turnOff = (get, set) => { if (get() === true) { set(false); changed = true } }
        // 三个常驻循环的开关一律复位成 false（进程都停了，开关留着"开"就是假状态）。
        // 完全自由配了 startWithDsh:true → 只有总开关保持开着；具体哪件事由 feiyu-focus.json 记录，
        // 下次开机由 focusTick 按它拉起（一次仍然只有一件）。
        for (const key of ['bilibili']) {
          turnOff(() => cfg[key]?.freeRoam?.enabled, (v) => { cfg[key].freeRoam.enabled = v })
        }
        turnOff(() => cfg.web?.roam?.enabled, (v) => { cfg.web.roam.enabled = v })
        if (cfg.freedom?.startWithDsh !== true) {
          turnOff(() => cfg.freedom?.enabled, (v) => { cfg.freedom.enabled = v })
        }
        // 10-31 语义修正：platforms.qq / platforms.wechat 是**用户意图**（持久），
        // 不是运行态。以前这里在 DSH 退出时把它们复位成 false —— 结果用户明明开着 QQ，
        // 重启后配置变假、面板显示"关"，而 im-gateway.sh 照常把她拉起来回消息。
        // 真正需要复位的是"本次运行临时打开的循环"（freeRoam / web.roam / freedom），
        // 那几条在上面已经处理了。
        if (changed) writeCfgFile(cfg)
      } catch (e) { swallow(e, 'lib/index.js:1069') }
    }

    ctx.effect(() => () => {
      try { resetOnExitToggles() } catch (e) { swallow(e, 'lib/index.js:1073') }
      try { lifecycle.clear('sovitsWatch') } catch (e) { swallow(e, 'lib/index.js:1074') }
      try { sched?.stop() } catch (e) { swallow(e, 'lib/index.js:1075') }
      try { stopGateway() } catch (e) { swallow(e, 'lib/index.js:1076') }
      try { killTree(sovitsProc) } catch (e) { swallow(e, 'lib/index.js:1077') }
      try { killTree(qqProc) } catch (e) { swallow(e, 'lib/index.js:1078') }
      try { killTree(wechatProc) } catch (e) { swallow(e, 'lib/index.js:1079') }
      try { killTree(freeRoamBiliProc) } catch (e) { swallow(e, 'lib/index.js:1080') }
      try { killTree(webRoamProc) } catch (e) { swallow(e, 'lib/index.js:1081') }
      // v5：一次性清掉所有通过 lifecycle 注册的定时器（mindTick/focusTick/watchServices/sovits）
      try { lifecycle.disposeAll() } catch (e) { swallow(e, 'lib/index.js:1082') }
      for (const d of disposers) { try { d() } catch (e) { swallow(e, 'lib/index.js:1083') } }
    })

    try {
      console.log(`[feiyu] 已挂载：/dsh-feiyu/api/* · 配置 ${configPath} · 工作目录 ${WORK_DIR}`)
    } catch (e) { swallow(e, 'lib/index.js:1088') }
  },
}
