// qq-server —— QQ 常驻聊天服务：接收 NapCat OneBot v11 上报 → 直连 LLM 秒回。
// 群聊默认也像私聊一样回（at_only=false，10-25 用户拍板；true 则群里被 @ 才回），私聊都回；
// 支持语音条（GPT-SoVITS + record 段，NapCat 自动转 silk）。
// 无第三方依赖，node 内置 http 即可。
//
//   node bot.mjs qq-server [port]     # 默认 8080
//   SnowLuma WebUI → OneBot配置 → HTTP服务器(3000) + HTTP上报 → http://127.0.0.1:8080/onebot
//   上报格式 messagePostFormat 选 array
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../lib/paths.mjs'
import { swallow } from '../lib/swallow.mjs'
import { splitBubbles, parseMessage } from '../lib/onebot.mjs'
import { config } from '../lib/config.mjs'
import { startBriefRefresher } from '../lib/ledger.mjs'
import * as guard from '../lib/guard.mjs'
import * as memory from '../lib/memory.mjs'
import * as qqMemory from '../lib/qq-memory.mjs'
import * as ownerFacts from '../lib/owner-facts.mjs'
import * as promises from '../lib/promises.mjs'
import * as quoteIndex from '../lib/quote.mjs'
import { fed } from '../lib/mood.mjs'
import * as llm from '../lib/llm.mjs'
import { buildMessages, thinkingInstruction, addressesOwner } from '../lib/persona.mjs'
import { gapText, mentionsDays, sanitizeDayClaims } from '../lib/timefix.mjs'
import { splitSticker, pickSticker, FACE_FALLBACK, ensureSelfSticker, autoTag } from '../lib/stickers.mjs'
import { synth } from '../lib/tts.mjs'
import { parseEmotionTag, splitVoiceParts, emotionProfile, emotionMenu } from '../lib/emotion.mjs'
import { sing } from '../lib/sing.mjs'
import { tickMood } from '../lib/mood.mjs'
import { generateStickerImage } from '../lib/imggen.mjs'
import { dataUri as visionDataUri } from '../lib/vision.mjs'
import { availableTags } from '../lib/stickers.mjs'
import * as brain from '../brain/index.mjs'
import { execFile, spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 项目根（起子进程时用来定位 tools/bot.mjs，不能依赖 cwd）。 */
const BOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
function FEiyuRoot() { return BOT_ROOT }
import { promisify } from 'node:util'

// 图片下载必须异步：execFileSync 会把事件循环钉住最多 35 秒，期间 /health 不通、群里所有
// 消息都排队。10-26 修：这条路径原来调的是**没导入**的 execFileSync，ReferenceError 被空
// catch 吞掉 → QQ 里发的图片永远进不了视觉理解，只剩一句占位。
const execFileAsync = promisify(execFile)

const LOG_FILE = dataPath('qq-server.log')

// 统一通道（10-31）：QQ 消息先进这里排队 → 同会话合并、跨会话并行、先来先答。
// 微信/抖音私信后续也接进来（同一个 channel 实例）。
import { channel as CHANNEL } from '../lib/channel.mjs'
import * as CHANNEL_IO from '../lib/channel-io.mjs'
import { gate as replyGate } from '../lib/reply-gate.mjs'
// v5：平台语义与"这次在处理谁"的上下文，从闭包变量搬出来（并发安全的根）
import * as PLATFORMS from '../lib/platforms.mjs'
import { current as currentCtx, runWithContext } from '../lib/reply-context.mjs'
import { inboundTokenOk, requireInboundToken } from '../lib/inbound-auth.mjs'
import { createPromiseExecutor, promiseOutcomePath } from '../lib/promise-executor.mjs'
import { fill } from '../lib/persona-voice.mjs'

/** 宿主是 stdio:'ignore' 起的进程，不打文件日志等于瞎 —— 出问题只能靠猜。 */
function logLine(level, args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const line = `${new Date().toISOString()} [${level}] ${msg}`
  try { console.log(line) } catch {}
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
  } catch {}
  fs.appendFile(LOG_FILE, line + '\n', () => {})
}
const log = (...a) => logLine('INFO', a)
const logErr = (...a) => logLine('ERR', a)

// ── 主动发言闸门（10-31）：三条主动通道共用一张账 ────────────────────────────
// 截图实锤她一小时内连发 6 条主动消息（4 条在接自己的话）。三条通道各有节流但互不相认。
// 这里收敛成一个 helper，主闭包里只留一行调用，逻辑可单测。
let _gateMod = null
async function gateMod() {
  if (!_gateMod) _gateMod = await import('../lib/proactive-gate.mjs')
  return _gateMod
}
/** 能不能发一条主动消息。@returns {Promise<{ok:boolean, why:string}>} */
async function canSpeak(kind = 'proactive') {
  try { return (await gateMod()).allow(kind) } catch { return { ok: true, why: '' } }
}
/** 真的发出去了才记账。 */
async function spokeDone(kind = 'proactive') {
  try { (await gateMod()).commit(kind) } catch { /* noop */ }
}
/** 主人说话了 → 重置连续计数。 */
async function ownerSpoke() {
  try { (await gateMod()).noteOwnerSpoke() } catch { /* noop */ }
}

// OneBot 消息解析已拆到 ../lib/onebot.mjs（10-31）：纯函数、可单测。
// 这里保留 re-export，老调用方与测试不用改。
export { splitBubbles, parseMessage } from '../lib/onebot.mjs'

export async function run(argv = []) {
  const cfg = config()
  // 账本：每 10 分钟刷一版（persona 的【账本】块读这份缓存，同步、不打网络）
  if (cfg.ledger?.enabled !== false) startBriefRefresher(10, (m) => console.log('[bot] ' + m))
  const QQ = cfg.qq ?? {}
  // 10-31：platforms.qq 以前是纯装饰 —— 面板关了它，qq-server 照样收发消息（假开关）。
  // 现在这里也认它：两个开关任一说"关"就不启动，并且说清是哪个。
  // 单一真相：qq.enabled（用户意图，持久）。platforms.qq 由面板同步写入，两者任一为 false 都不启动。
  // v5 修 P0 的另一半：旧代码只要 qq.enabled=false 就直接 exit(1)。
  // 但 qq-server 是**所有平台共用的宿主进程**（/inbound 的微信消息也进它），
  // 于是"关 QQ、只开微信"这种完全合理的配置会连微信一起弄死。
  // 现在：只有当**所有对话平台都关着**时才退出。
  {
    const dialogs = PLATFORMS.PLATFORMS.map((p) => ({ id: p.id, ...PLATFORMS.enabled(cfg, p.id) }))
    const anyOn = dialogs.some((d) => d.on)
    if (!anyOn) {
      logErr('✗ 所有对话平台都关着（' + dialogs.map((d) => d.id + ':' + (d.on ? '开' : '关')).join(' / ') + '）—— 面板上打开至少一个，或改 bot.config.json')
      process.exit(1)
    }
    const on = dialogs.filter((d) => d.on).map((d) => d.id)
    log('[qq] 本次启用的平台：' + on.join(', ') + (on.includes('qq') ? '' : '（QQ 关着，只跑其他平台）'))
  }
  if (!llm.apiKey()) { logErr('✗ 没有 LLM API key（设环境变量 DEEPSEEK_API_KEY，或填 llm.api_key）'); process.exit(1) }
  try { const n = memory.sweepEpisodes(); if (n) log(`[qq] 记忆归档：${n} 条 90 天前的旧事件移入 *.archive.jsonl`) } catch {}
  const NAPCAT = (QQ.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const port = Number(argv[0]) || 8080

  // ── 单实例锁（10-31）──────────────────────────────────────────────────────
  // 两套启动机制（im-gateway.sh / 插件 startQQ）都能拉起这个进程。
  // 谁先起谁拿锁，后来的安静退出 —— 否则 startQQ 的 killPortListeners 会杀掉守护进程，
  // 守护再拉起，形成无限拉锯（已在审计中确认这条路径存在）。
  const { acquire } = await import('../lib/lock.mjs')
  const releaseLock = acquire('qq-server')
  if (!releaseLock) {
    logErr('[qq] 已有另一个 qq-server 实例在跑（端口 ' + port + '）—— 本实例让位退出。' +
      '如果你想接管，请先停掉 im-gateway.sh 里的那个进程。')
    process.exit(0)      // exit 0：不是错误，别让守护以为崩了
  }
  const releaseOnExit = () => { try { releaseLock() } catch (e) { swallow(e, 'qq-server:lock-release') } }
  process.on('exit', releaseOnExit)
  process.on('SIGTERM', () => { releaseOnExit(); process.exit(0) })
  process.on('SIGINT', () => { releaseOnExit(); process.exit(0) })

  const callApi = async (action, payload = {}, timeout = 20000) => {
    try {
      const r = await fetch(`${NAPCAT}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      })
      if (!r.ok) { logErr(`[qq] ${action} 失败: HTTP ${r.status}`); return null }
      return await r.json().catch(() => null)
    } catch (e) { logErr(`[qq] ${action} 异常: ${e.message}`); return null }
  }

  // 打字标识（10-31）：凡是给她要回话的对象发消息，先显示"正在输入…"，
  // 真正发出去后立刻停止 —— 像真人打完字就发。所有发送路径统一走这里，一处挂全局生效。
  const showTyping = async (payload) => {
    try {
      if (!payload?.user_id) return
      await callApi('set_input_status', { user_id: payload.user_id, event_type: 1 })
    } catch {}
  }
  const stopTyping = async (payload) => {
    try {
      if (!payload?.user_id) return
      await callApi('set_input_status', { user_id: payload.user_id, event_type: 0 })
    } catch {}
  }

  // 跨窗口去重（10-31）：同文本 5 秒内已在其他 chatId 发过 → 跳过
  let lastSentFp = { fp: '', at: 0, from: '' }
  const isDup = (payload, currentChat) => {
    try {
      const txt = Array.isArray(payload?.message)
        ? payload.message.map((s2) => s2?.data?.text ?? '').join('')
        : String(payload?.message || '')
      const fp = txt.slice(0, 30)
      if (!fp) return false
      if (lastSentFp.fp === fp && Date.now() - lastSentFp.at < 5000 && lastSentFp.from !== currentChat) {
        log('[qq] 跨窗口去重：跳过（与 ' + lastSentFp.from + ' 的回复重复）')
        return true
      }
      lastSentFp = { fp, at: Date.now(), from: currentChat }
      return false
    } catch { return false }
  }
  // v5：**不再**用闭包变量存"当前平台/会话"。
  // 旧写法（10-31）在统一通道并发时会串台：A 会话 await LLM 期间 B 会话改掉全局变量，
  // A 醒来后把回复发到 B 的平台/会话。现在改读 AsyncLocalStorage 里的本次上下文，
  // 每条 handle() 调用链各拿各的，天然隔离。
  const ctxOf = () => currentCtx()

  const send = async (action, payload) => {
    const ctx = ctxOf()
    const platform = ctx?.platform || 'qq'
    const currentChat = payload?.user_id ? platform + ':' + payload.user_id
      : payload?.group_id ? platform + ':group:' + payload.group_id : (ctx?.chatId || '')

    // ── 非 QQ 平台：不调 OneBot，落到该平台自己的出站队列 ──────────────────────
    // v5 修正：出站只认**本次上下文**的 platform，且必须带 chatId。
    // 旧代码没有 chatId 时会写一条空 chatId 的出站记录，拉取端只能靠猜。
    if (platform !== 'qq' && String(action).startsWith('send_')) {
      const txt = Array.isArray(payload?.message)
        ? payload.message.map((s2) => (s2?.type === 'text' ? s2.data?.text ?? '' : s2?.type === 'image' ? '【图片】' : '')).join('')
        : String(payload?.message ?? '')
      const imgs = Array.isArray(payload?.message) ? payload.message.filter((s2) => s2?.type === 'image').map((s2) => s2.data?.file || s2.data?.url || '') : []
      CHANNEL_IO.pushOutbox({ platform, chatId: ctx?.chatId || currentChat, userId: ctx?.userId || '', text: txt, images: imgs })
      log('[channel] ' + platform + ' 回复已入出站队列（' + (ctx?.chatId || currentChat) + '）：' + txt.slice(0, 40))
      return true
    }

    if (String(action).startsWith("send_") && isDup(payload, currentChat)) return true
    if (String(action).startsWith("send_")) await showTyping(payload)
    const j = await callApi(action, payload)
    if (String(action).startsWith("send_")) await stopTyping(payload)
    if (!j) return false
    if (j.status && j.status !== 'ok') {
      logErr(`[qq] ${action} 返回 ${j.status}/${j.retcode}: ${j.message || j.wording || ''}`)
      return false
    }
    // 10-27：自己发的每条都记下 message_id → 正文，主人引用她的话时能零延迟取到原文
    try {
      const id = j?.data?.message_id ?? j?.message_id
      const txt = Array.isArray(payload?.message)
        ? payload.message.map((s) => (s?.type === 'text' ? s.data?.text ?? '' : s?.type === 'image' ? '【图片】' : '')).join('')
        : String(payload?.message ?? '')
      if (id) quoteIndex.remember(id, { text: txt || '（一条非文字消息）', who: 'me', name: '你' })
    } catch {}
    return true
  }

  // ── 引用索引预热（10-27）──────────────────────────────────────────────
  // get_msg 只认得还有缓存的消息（实测老消息直接回"消息不存在"），所以启动时和之后每 10 分钟
  // 把主人私聊 / 已开群 的最近几十条拉一遍，id → 正文 全部登记。这样引用历史消息也能取到原文。
  async function warmQuoteIndex(count = 40) {
    const ownerQQ = String(config().owner?.qq || '')
    const targets = []
    if (ownerQQ) targets.push({ api: 'get_friend_msg_history', key: 'user_id', id: Number(ownerQQ) })
    for (const gid of (QQ.allow_groups || [])) targets.push({ api: 'get_group_msg_history', key: 'group_id', id: Number(gid) })
    let n = 0
    for (const t of targets) {
      const j = await callApi(t.api, { [t.key]: t.id, count }, 15000)
      const msgs = j?.data?.messages
      if (!Array.isArray(msgs)) continue
      for (const m of msgs) {
        const senderQQ = String(m?.sender?.user_id ?? '')
        const who = senderQQ === String(selfIdCached) ? 'me' : (senderQQ === ownerQQ ? 'owner' : 'other')
        const p = parseMessage(m?.message, selfIdCached)
        const own = [p.text, ...p.marks.filter((x) => x !== '【引用回复了一条消息】')].filter(Boolean).join(' ')
        if (!own) continue
        quoteIndex.remember(m.message_id, {
          text: own, who, at: Number(m.time) * 1000,
          name: String(m?.sender?.card || m?.sender?.nickname || senderQQ),
        })
        n++
      }
    }
    quoteIndex.save()
    if (n) log(`[qq] 引用索引预热：${n} 条（${quoteIndex.size()} 条在手）`)
  }

  // ── 引用消息解析（10-27）──────────────────────────────────────────────
  // 本地表（她自己发过的、以及最近收到的）→ 没命中就问 NapCat get_msg。
  // 引用里的图片再走一次 VL，免得"他引用了一张图"她只看到一句话。
  async function resolveQuote(replyId, { selfId = '', userId = '', isGroup = false, groupId = '' } = {}) {
    const ownerQQ = String(config().owner?.qq || '')
    let rec = quoteIndex.get(replyId)
    if (!rec) {
      const j = await callApi('get_msg', { message_id: Number(replyId) || replyId }, 12000)
      const data = j?.data || (j?.status === 'ok' ? j : null)
      if (data) {
        rec = quoteIndex.fromGetMsg(data, { selfQQ: selfId, ownerQQ, parseMessage })
        if (rec) quoteIndex.remember(replyId, rec)
      }
    }
    // 还是没有 → 可能是很久以前的消息：现场把最近历史再拉一遍（比"取不到"强）
    if (!rec) {
      await warmQuoteIndex(60)
      rec = quoteIndex.get(replyId)
    }
    if (rec && config().qq?.quote?.seeImage !== false) {
      // 被引用的是图片：取一次 VL 描述（失败就算了，别拖慢回复）
      const url = /https?:\/\/[^\s"）)]+/.exec(rec.text)?.[0]
      if (url && rec.who === 'me' && /【发了一张图片】|【图片】/.test(rec.text)) {
        try {
          const { visionOn, describeFrames } = await import('../lib/vision.mjs')
          if (visionOn()) {
            const dl = path.join(dataPath('qq-img'), `q-${Date.now()}.jpg`)
            fs.mkdirSync(path.dirname(dl), { recursive: true })
            const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
            await execFileAsync(exe, ['-sS', '-L', '-m', '25', '-A', 'Mozilla/5.0', '-o', dl, url], { timeout: 30000, windowsHide: true })
            if (fs.existsSync(dl) && fs.statSync(dl).size > 2000) {
              const desc = await describeFrames([dl], { query: '这是他引用的一张图。一两句话说明图里是什么/什么梗/情绪。' })
              if (desc) rec.text = `${rec.text}（图里是：${desc.slice(0, 100)}）`
            }
            try { fs.rmSync(dl, { force: true }) } catch {}
          }
        } catch {}
      }
    }
    return quoteIndex.describe(rec, { selfQQ: selfId, ownerQQ })
  }

  // ── AI 表情包补发（10-25）：图库没有的标签 / 自制表情 → Pollinations 生成入库再补发 ──
  // 异步跑（生成约 10~40s），不阻塞回复主线；同文案有缓存不重画；AI 失败退 PIL 文字贴纸。
  const aiInflight = new Set()
  async function aiStickerFollowup({ tag, caption, isGroup, groupId, userId }) {
    const key = `${tag || ''}|${caption || ''}`
    if (aiInflight.has(key)) return
    aiInflight.add(key)
    try {
      let file = null
      let desc = ''
      if (tag && !pickSticker(tag)) { desc = `标签「${tag}」`; file = await generateStickerImage(tag, { tag }) }
      if (!file && caption) { if (!desc) desc = `「${caption}」`; file = await generateStickerImage(caption) }
      if (!file && caption) file = ensureSelfSticker(caption, config())   // AI 失败 → PIL 文字贴纸兜底
      if (!file) { log(`[qq] AI 表情包没生成出来：${desc}（额度/代理/图床），这次不补发`); return }
      const target = isGroup
        ? { api: 'send_group_msg', key: 'group_id', id: Number(groupId) }
        : { api: 'send_private_msg', key: 'user_id', id: Number(userId) }
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))   // 像人翻表情包的工夫
      // 2026-11-02: 不再传容器内 file:// 路径（宿主 SnowLuma 读不到 → EACCES）。
      // 转 base64 随请求体走，与文件系统无关。
      const { onebotFileValue } = await import('../lib/onebot-file.mjs')
      const ok = await send(target.api, { [target.key]: target.id, message: [{ type: 'image', data: { file: onebotFileValue(file) } }] })
      if (ok) log(`[qq] 🎨 AI 表情包已入库补发：${desc} → ${path.basename(file)}`)
    } catch (e) { log('[qq] AI 表情包补发异常：' + (e?.message ?? e)) }
    finally { aiInflight.delete(key) }
  }

  const handle = async (evt) => {
    const EVT_PLATFORM = String(evt.__platform || 'qq')
    const isGroupEvt = evt.message_type === 'group'
    const groupIdEvt = isGroupEvt ? String(evt.group_id ?? '') : ''
    const userIdEvt = String(evt.user_id ?? '')
    // v5：把本次"平台/会话"钉进异步上下文，后面所有 await 里都能拿到同一份。
    // 这解决了旧版并发串台（A 会话醒来发现平台被 B 改了）。
    const chatIdEvt = isGroupEvt ? EVT_PLATFORM + ':' + groupIdEvt : EVT_PLATFORM + ':' + userIdEvt
    return runWithContext({
      platform: EVT_PLATFORM, chatId: chatIdEvt, userId: userIdEvt, isGroup: isGroupEvt,
    }, () => handleInner(evt, EVT_PLATFORM, isGroupEvt, groupIdEvt, userIdEvt))
  }

  const handleInner = async (evt, EVT_PLATFORM, isGroup, groupId, userId) => {
    try {
      // 每次处理消息都重读最新配置：热改 voice_enabled / voice_chance / minGapSec 立即生效，
      // 不用重启 qq-server（原版只在进程启动时读一次，改了配置也不生效 —— 语音一直不发的根因）。
      const live = config()
      // v5 修 P0：平台开关只判**自己**。旧代码在这里写死 `platforms.qq === false`，
      // 而 handle() 是所有平台共用的入口 → 关 QQ 会把微信一起杀掉。
      const gate = PLATFORMS.enabled(live, EVT_PLATFORM)
      if (!gate.on) { log('[qq] ' + EVT_PLATFORM + ' 平台关闭（' + gate.why + '），这条不处理'); return }
      if (isGroup && !PLATFORMS.allowsGroup(EVT_PLATFORM)) return
      // 10-31：主人开口了 → 重置"连续主动"计数，并标记他正在聊（3 分钟内不插话）
      await ownerSpoke()
      const QQ = live.qq ?? {}
      const selfId = String(evt.self_id ?? '')
      // isGroup / groupId / userId 已由 handle() 作为参数传入（v5）
      // 旧版在这里给闭包变量 CUR_PLATFORM/CUR_CHAT 赋值 —— 并发串台的根源，已删。
      const allow = QQ.allow_groups ?? []
      if (isGroup && allow.length && !allow.includes(groupId)) return

      // 全类型消息理解（10-25）：卡片/视频/表情等非文字段 → 描述标记；图片 → Qwen3-VL 亲眼看
      const parsed = parseMessage(evt.message, selfId)
      let extra = parsed.marks.filter((m) => m !== '【发了一张图片】').join(' ')   // 图片单独走 VL
      const { text, atMe, images } = { text: parsed.text, atMe: parsed.atMe, images: parsed.images }

      // ── 引用消息（10-27）：把他引用的那条原文取回来 ────────────────────────
      // 主人常常引用她上面那句再问"这个呢/你去了吗"，以前她只看到"【引用回复了一条消息】"，
      // 等于被蒙着眼睛提问。这里：本地表 → NapCat get_msg → 连图片都用 VL 看一眼。
      let quoteLine = ''
      if (parsed.replyId && config().qq?.quote?.enabled !== false) {
        try {
          quoteLine = await resolveQuote(parsed.replyId, { selfId, userId, isGroup, groupId })
          if (quoteLine) log(`[qq] 📎 引用解析：${quoteLine.slice(0, 70)}`)
        } catch (e) { logErr('[qq] 引用解析失败：' + (e?.message ?? e)) }
      }
      // 别人（含主人）发来的这条也登记，下次被引用就不用请求
      if (evt.message_id) {
        const who = String(userId) === String(config().owner?.qq || '') ? 'owner' : 'other'
        const label = isGroup ? String(evt.sender?.card || evt.sender?.nickname || userId) : '主人'
        const own = [parsed.text, ...parsed.marks.filter((m) => m !== '【引用回复了一条消息】')].filter(Boolean).join(' ')
        quoteIndex.remember(evt.message_id, { text: own || '（非文字消息）', who, name: label })
      }
      if (!text && !images.length && !extra) return
      if (isGroup && QQ.at_only !== false && !atMe) return   // 群里只被 @ 才回
      const chatId = isGroup ? `${EVT_PLATFORM}:${groupId}` : `${EVT_PLATFORM}:${userId}`
      // 10-31 统一通道：一次合并了多条连发 → 告诉她"这是他连着说的话"，别当几件事分开答
      const mergedN = Number(evt.__merged || 0)
      if (mergedN > 1) {
        extra = ('【他连着发了 ' + mergedN + ' 条，这是一口气说完的】' + (extra ? ' ' + extra : '')).trim()
        log('[qq] 📚 本轮是合并消息（' + mergedN + ' 条）')
      }
      // 群聊插话引擎的在场信号：有群消息就刷新该群的时间戳（她"看到"群里在聊天）
      if (isGroup) groupLastMsgAt[groupId] = Date.now()
      // 主动搭话的安静计时：主人（私聊）每说一句话就刷新
      try {
        const ownerQQNow = String(config().owner?.qq || '')
        if (!isGroup && ownerQQNow && String(userId) === ownerQQNow) ownerLastMsgAt = Date.now()
      } catch {}

      // ── 自我改动审批闸（2026-11-02）──────────────────────────────────────
      // 老爸在私聊里说的话，先过一道指令词检查：
      //   「改吧 / 批准 / 可以改」 → 批准最近一条待批，然后真改
      //   「不改 / 别改 / 算了」   → 作废
      //   「回滚」                → 撤销上一次改的
      //   「想改什么 / 待批」      → 念一遍清单
      // 注意：这条**先于**正常聊天处理 —— 审批不该走 LLM（不能让模型决定是否批准自己）。
      if (!isGroup) {
        try {
          const ownerQQsm = String(config().owner?.qq || '')
          if (ownerQQsm && String(userId) === ownerQQsm) {
            const { selfmodCmd } = await import('../lib/selfmod-cmd.mjs')
            const hit = await selfmodCmd(String(text || '').trim())
            if (hit) {
              log(`[qq][selfmod] ${hit.log}`)
              // 「重启」：先回一句话，再延时杀掉自己（im-gateway 的 while 会立刻拉起）。
              // 为什么要延时：直接 process.exit 会打断这条消息的发送，老爸什么也收不到。
              if (hit.reply === '__RESTART__') {
                try {
                  const bye = '好，我重开一下，几秒钟就回来 (・_・;)'
                  await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: bye } }] })
                  // 也记进记忆 —— 不然重启后她不记得自己刚说要重开（记忆断档）
                  memory.remember('qq', chatId, userId, 'assistant', bye, { isGroup: false })
                } catch {}
                log('[qq][selfmod] 收到重启指令，3 秒后退出交给 im-gateway 拉起')
                setTimeout(() => { process.exit(0) }, 3000)
                return
              }
              // 直接把结果发回去，不进聊天链路（避免模型重写这段系统消息）
              try {
                await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: hit.reply } }] })
                memory.remember('qq', chatId, userId, 'assistant', hit.reply, { isGroup: false })
              } catch (e) { logErr('[qq][selfmod] 回复失败：' + e.message) }
              return
            }
          }
        } catch (e) { logErr('[qq][selfmod] 拦截异常：' + (e?.message ?? e)) }
      }
      let imageDesc = ''
      let imageIsSticker = false
      const imageUris = []   // 10-30 合并通道：原图直接进聊天请求，不再先 VL 描述成文字
      if (images.length) {
        try {
          fs.mkdirSync(dataPath('qq-img'), { recursive: true })
          const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
          for (const u of images.slice(0, 3)) {
            const dl = path.join(dataPath('qq-img'), `img-${Date.now()}-${Math.floor(Math.random() * 1e4)}.jpg`)
            await execFileAsync(exe, ['-sS', '-L', '-m', '30', '-A', 'Mozilla/5.0', '-o', dl, u], { timeout: 35000, windowsHide: true })
            if (fs.existsSync(dl) && fs.statSync(dl).size > 2000) imageUris.push(dl)
          }
          // 2026-11-02：不再一律写"她发来一张图片" —— 先判断这是表情包还是正经图。
          // 表情包是**语气**，不是内容；当成图片去描述，回复就变成说明文了。
          try {
            const { classifyImage } = await import('../lib/image-kind.mjs')
            const seg0 = (Array.isArray(evt.message) ? evt.message : []).find((x) => x?.type === 'image')
            // 最近语气：看上一轮他的用词，轻松/严肃决定"没配文小图"该当什么
            const prevText = (() => { try { return String(memory.recent(chatId).slice(-1)[0]?.text || '') } catch { return '' } })()
            const tone = /(哈哈|笑死|好家伙|草|乐|梗|表情包|😂|🤣|🐟)/.test(prevText) ? 'light'
              : /(难受|难过|烦|焦虑|压力|急|怎么办)/.test(prevText) ? 'serious' : ''
            const c = classifyImage({ file: imageUris[0], seg: seg0, text: text, recentTone: tone })
            if (c.kind === 'sticker') {
              // 只给一个短标记：她要读的是"他用了个表情"，不是图里画了什么
              imageDesc = `【他发了个表情包当语气】（${c.why}）`
              imageIsSticker = true
              log(`[qq] 🎭 判为表情包（${c.why}）—— 按语气处理，不描述画面`)
            } else if (c.kind === 'photo') {
              imageDesc = '【他发来一张图片，让你看】（我看到了原图）'
              log(`[qq] 🖼 判为正经图片（${c.why}）`)
            } else {
              imageDesc = '【他发来一张图片】（拿不准是表情包还是内容，先按语气理解，真看不清再问）'
            }
          } catch {
            imageDesc = imageUris.length ? '【他发来一张图片】' : '【他发来一张图片，但下载失败】'
          }
          // 2026-11-02：表情包下载失败**不算失败** —— 它的信息是"他用了个表情"，
          // 不需要图片内容。只有正经图下载失败才该告诉她"没看到"。
          if (!imageUris.length) {
            const { classifyImage: ci } = await import('../lib/image-kind.mjs')
            const seg0b = (Array.isArray(evt.message) ? evt.message : []).find((x) => x?.type === 'image')
            const cb = ci({ seg: seg0b, text })
            if (cb.kind === 'sticker') {
              imageDesc = `【他发了个表情包当语气】（${cb.why}）`
              imageIsSticker = true
            } else {
              imageDesc = '【他发来一张图片，但下载失败，看不到内容】'
            }
          }
        } catch { imageDesc = '【他发来一张图片】' }
        // 图暂不删：等聊天请求带完原图再清（见 answer 之后）
      }
      // 10-27：引用行（他引用了哪一条）拼在正文前面 —— 记忆里也留着，回头能还原上下文
      const parts = [quoteLine, text.replace(new RegExp(`@?${selfId}\\s*`), '').trim(), extra, imageDesc]
      const raw = parts.filter(Boolean).join(' ')
      if (!raw) return
      // 群聊像私聊一样回（at_only=false 时）：把说话人昵称带上，她才知道在跟谁说话，
      // 记忆里也留着"谁说了什么"（号码绝不当称呼 —— ownerLine 踩过的坑）。
      // labeled 是本轮的规范文本：remember 和 buildMessages 用同一份，装配端去重才对得上。
      const display = isGroup ? String(evt.sender?.card || evt.sender?.nickname || '').trim() : ''
      // 引用行不进"他说的正文"（否则会把被引用的原话当成新说的话去抽事实），
      // 但**要进记忆**：回头 recall 时才还原得出上下文。
      const said = (isGroup && display) ? `${display}：${raw}` : raw
      const userText = said
      const memText = quoteLine ? `${quoteLine} ${said}` : said

      // 🎵 唱歌分支：主人让她唱，就真的唱（LLM 写词 + 她的音色逐句合成 + 鼓点混音）
      if (QQ.voice_enabled !== false && QQ.sing !== false && !isGroup && /唱(一首|首歌|个|段|吧|$)|唱歌|来一首|哼(一首|段)/.test(userText)) {
        try {
          log(`[qq] 🎵 唱歌请求：${userText.slice(0, 30)}`)
          const theme = userText.replace(/.*(唱|来)一?(首|个|段)?/, '').replace(/首歌?吧?|[吗呢？?。~～]/g, '').trim()
          // ── 专业翻唱优先（10-25）：歌单点唱 → 没学会先应一声再现场学（搜源歌→分离→换她的声音→混伴奏）
          // ── 学不会/没配好回落原创说唱（sing()），内容不丢
          let covered = false
          try {
            const { coverSong, findSong, searchQuotaOk } = await import('../lib/cover.mjs')
            const hit = findSong(theme)
            const canSearch = !hit && theme && config().sing?.search !== false && searchQuotaOk()
            if (hit || canSearch) {
              const title = hit ? hit.title : theme
              await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: hit ? `《${title}》我会唱！马上来～` : `《${title}》我还没学过，给我几分钟学一下哈～` } }] })
              const song = await coverSong({ source: hit ? hit.source : `ytsearch1:${theme}`, title, log: (l) => log(`[qq] 🎤 ${l}`) })
              const sent2 = await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'record', data: { file: song.file } }] })
              if (sent2) {
                covered = true
                await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: `🎵 给你唱《${song.title}》——用我自己的声音哦${song.cache === 'hit' ? '' : '（刚学会的）'}～` } }] })
                memory.remember(EVT_PLATFORM, chatId, userId, 'assistant', `（翻唱了《${song.title}》，用她自己的音色）`, { isGroup })
                log(`[qq] 🎤 翻唱已发：《${song.title}》`)
              }
            }
          } catch (e) { logErr('[qq] 专业翻唱没成，回落原创说唱：' + String(e.message).slice(0, 120)) }
          if (covered) return
          const song = await sing(theme)
          const sent2 = await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'record', data: { file: song.file } }] })
          if (sent2) {
            await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: `🎵《${song.title}》 ${song.bpm}bpm —— ${song.lyrics.join(' / ')}` } }] })
            memory.remember(EVT_PLATFORM, chatId, userId, 'assistant', `（唱了《${song.title}》：${song.lyrics.join('/')}）`, { isGroup })
            log(`[qq] 🎵 已唱《${song.title}》(${song.bpm}bpm, ${song.lyrics.length}句)`)
            return
          }
        } catch (e) {
          logErr('[qq] 唱歌失败，降级回复文字：' + e.message)
          // 落回普通回复
        }
      }

      memory.remember(EVT_PLATFORM, chatId, userId, 'user', memText, { isGroup })

      // 事件进脑（v3 S1 影子层）：旧路径照旧写 episodes.jsonl，这边另存一份结构化事件。
      // 关键差别：谁说的（who.kind）、能不能外说（scope）、哪条消息（msgId）在写入时就定死，
      // 不再靠"昵称：正文"回推。brain 是旁路，失败也不影响这一轮回复。
      try {
        brain.onEvent({
          proc: 'qq-server', platform: EVT_PLATFORM, chatId, userId, role: 'user',
          text: memText, isGroup, groupId, name: display || undefined,
          msgId: evt.message_id, at: Date.now(), atMe,
          isOwner: String(userId) === String(config().owner?.qq || ''),
        })
      } catch (e) { logErr('[qq] 脑写入失败（不影响回复）：' + (e?.message ?? e)) }

      // 主人说的硬事实（10-27）：他吃了什么/在干什么/要去干什么 —— 落账以后就不许再问。
      // 只记私聊里主人本人的话（群友的话不是他的事）。
      try {
        const ownerQQ0 = String(config().owner?.qq || '')
        if (!isGroup && ownerQQ0 && String(userId) === ownerQQ0) {
          const got = ownerFacts.learnFromOwner(userText)
          if (got.length) log(`[qq] 📝 记下主人的事：${got.map((g) => g.key + '=' + g.value).join('，')}`)
          // 他说他吃了 → 她的饥饿直接落地（不然接下来两小时会一直问"你吃了吗"）
          if (/吃(了|过|的是)|刚吃|在吃|饭吃了/.test(String(userText))) {
            fed(20)
            log('[qq] 🍚 主人说他吃了 → 她的饥饿归到 20')
          }
        }
      } catch (e) { logErr('[qq] 记事实失败：' + (e?.message ?? e)) }

      // 接话判断（10-31）：要不要回、隔多久回 —— 逻辑在 lib/reply-gate.mjs
      // 2026-11-02：gate 现在返回判定对象（不再是 boolean），这样才能拿到 openThread。
      const gateRes = await replyGate({ text: userText, merged: mergedN || 1, isGroup, atMe, extra, chatId, platform: EVT_PLATFORM, log })
      if (!gateRes || gateRes.reply !== true) return
      // 呼叫语（在吗/人呢/喂）：不该只回"在呢"就完。把话头递回去 —— 让她把此刻真在想/在做的事说出来。
      const openThread = gateRes.openThread === true
      if (openThread) log('[qq] 🪝 呼叫语 → 让她主动递话头')

      // 生成回复（三段式 prompt + 走神注入）
      const turns = memory.recent(chatId).length
      // 装配：live 模式走脑的 8 槽装配（只切 QQ 私聊），否则照旧走三段式 —— 两条路都能回滚。
      const brained = brain.assembleFor({ platform: EVT_PLATFORM, userText, chatId, userId, turnsToday: turns, isGroup, quote: quoteLine })
      if (brained && brained.chars > 0) {
        log(`[qq] 🧠 新装配 ${brained.chars} 字${brained.dropped.length ? `（截断 ${brained.dropped.length} 块）` : ''}`)
      }
      const messages = brained?.messages
        ?? buildMessages({ platform: 'qq', userText, chatId, userId, turnsToday: turns, isGroup, quote: quoteLine, openThread })
      messages[0].content += thinkingInstruction()
      // 时间锚点已经搬进 persona 的「【现在】」常驻层（10-25 重构，照 dsh-world 的 timeContext）：
      // 贴在最后一条消息上的临时提示一重写就丢，现在每轮都在 system 里。
      // 这里只保留事后兜底要用的真实间隔（sanitizeDayClaims 的口径）。
      // 群聊要按**这个群**的最后一条算（10-26）：拿主人的私聊间隔去校群里的"好久没见"，
      // 会把她对群友说的话按私聊时间线纠正，等于又混了一次通道。
      let gapFrom = lastOwnerMsgTs()
      if (isGroup) {
        try {
          const g = memory.lastByRole(chatId).lastUser
          if (g) gapFrom = g
        } catch {}
      }
      const ownerGapMs = Math.max(0, Date.now() - gapFrom)
      const gapTxt = gapText(ownerGapMs)
      // 表情包概率旋钮（10-25）：摇中就强制她带一个图 —— 不再靠她"想起来"写标记。
      // 图生图管够，每个都是新的；用户可在面板调 qq.stickerChance。
      const stickerChance = Number(QQ.stickerChance ?? 0.5)
      const diceWon = Math.random() < stickerChance
      if (diceWon) {
        messages[0].content += '\n\n【这条回复必须带一个图片表情】在正文句尾追加一个标记，二选一：'
          + `[表情:标签]（可用标签：${availableTags().join('/')}）或 [自制表情:八个字以内的短句]（会现场画一张新的）。只带一个，别解释。`
      }
      // 2026-11-02：表情包**不塞原图**给视觉模型 ——
      // 一是浪费 token（一张图几百到上千 token），二是只要图进来了模型就忍不住去描述。
      // 表情包的信息已经在文本里的【他发了个表情包当语气】标记，够她接住语气了。
      if (imageUris.length && !imageIsSticker) {
        // 10-30 合并通道：原图直接进 user 消息（v4 模型原生收图），一次调用完成看图+回复
        const last = messages[messages.length - 1]
        const content = [{ type: 'text', text: typeof last.content === 'string' ? last.content : '' }]
        for (const f of imageUris) {
          try { content.push({ type: 'image_url', image_url: { url: visionDataUri(f) } }) } catch {}
        }
        messages[messages.length - 1] = { role: 'user', content }
        log(`[qq] 🖼 图片已并入聊天请求（${imageUris.length}张）`)
      }
      // 动态温度（10-31 智能化）：按内容特征调——严肃/长文沉稳，日常/短句轻快
      const dynTemp = (() => {
        const ut = String(userText || '')
        if (ut.length > 100 || /[？?]\s*[？?]/.test(ut) || /(怎么办|求助| serious |难过|烦|焦虑|压力|工作)/i.test(ut)) return 0.55
        if (/(哈哈|笑死|好家伙|草|乐|梗|表情包)/i.test(ut)) return 1.05
        return 0.92
      })()
      // 10-31：带工具的一轮（记承诺/查记忆/写日记/上网/看视频），失败自动退回纯文本。
      const toolsOn = config().qq?.tools?.enabled !== false
      let answer = ''
      let toolTrace = []
      if (toolsOn) {
        try {
          const { chatWithTools } = await import('../lib/agent.mjs')
          const r = await chatWithTools(messages, { temperature: dynTemp, purpose: 'chat' })
          answer = r.text
          toolTrace = r.tools || []
          if (toolTrace.length) log('[qq] 🔧 用了工具：' + toolTrace.map((t) => t.name + (t.ok ? '✓' : '✗')).join(' '))
        } catch (e) {
          logErr('[qq] 工具链失败，退回纯文本：' + (e?.message ?? e))
        }
      }
      if (!answer) answer = await llm.chat(messages, { temperature: dynTemp, purpose: 'chat' })

      // ── 2026-11-02 ·「先想后说」────────────────────────────────────
      // 实现挪到 tools/lib/think.mjs：输入是（他说的话 + 她心里的念头 + 身体状态），
      // 输出是一句"心里话"。它不碰 socket、不碰 OneBot —— 不属于编排层，
      // 留在 qq-server 里等于把"她想什么"和"怎么发出去"焊死在一起。
      // 顺带把 qq-server 从 1807 行拉回门禁额度以内（门禁拦得对）。
      try {
        const { thinkThenSay } = await import('../lib/think.mjs')
        const r2 = await thinkThenSay({
          messages, userText, chatId, isGroup: !!isGroup, dynTemp, toolsOn,
          chatWithTools: toolsOn ? chatWithTools : null, llm, log,
        })
        if (r2.used && r2.text) answer = r2.text
      } catch (e) { logErr('[qq] 内省失败（不影响回复）：' + (e?.message ?? e)) }
      try { fs.rmSync(dataPath('qq-img'), { recursive: true, force: true }) } catch {}
      // 情绪联动（10-31 优化）：**不再单独调一次 LLM**。
      // reply-gate 那次调用已经顺手把情绪写进 affect 了；这里只在 gate 没跑 LLM 的路径
      // （必回分支：问句/请求/情绪词）做一次轻量启发式补写 —— 零成本。
      try {
        const hitNeg = /(难受|难过|烦|累|崩溃|委屈|失眠|不想|讨厌|倒霉|气死)/.test(String(userText))
        const hitPos = /(开心|高兴|好事|哈哈|笑|太好了|喜欢|棒)/.test(String(userText))
        if (hitNeg || hitPos) {
          import('../brain/affect.mjs').then(async ({ feel }) => {
            try { await feel({ valence: hitNeg ? -0.35 : 0.35, arousal: 0.5 }) } catch {}
          }).catch(() => {})
        }
      } catch {}
      let out = guard.clean(answer, config())
      // 群聊认人硬保险（10-26）：prompt 已经写到"这一轮不许出现主人"，但 11:54 她还是照群友的要求
      // 说了"主人早上好"。prompt 是软的，嘴是她的 —— 所以这里在出稿后再拦一道。
      // 只拦"称呼用法"（addressesOwner），她在群里说"我只叫一个人主人"这种正确拒绝不许误伤。
      // 只拦群聊，私聊不受影响（私聊本来就该叫主人）。
      if (out && isGroup && String(userId) !== String(config().owner?.qq || '') && addressesOwner(out)) {
        log(`[qq] ⚠ 群里把「主人」叫给群友（QQ ${userId}）了：「${out.slice(0, 30)}」→ 让她重写`)
        try {
          const retry = messages.slice()
          retry[retry.length - 1] = {
            role: 'user',
            content: messages[messages.length - 1].content
              + `\n\n【重写】你刚才那句「${out.slice(0, 40)}」是在叫对方「主人」，但他只是群友（QQ ${userId}）。`
              + `重写这一条：一个字都不许出现"主人"。`,
          }
          const answer2 = await llm.chat(retry, { temperature: 0.8, purpose: 'chat' })
          const out2 = guard.clean(answer2, config())
          if (out2) out = out2
        } catch (e) { logErr('[qq] 群聊重写失败：' + e.message) }
        if (addressesOwner(out)) {
          // 还是叫了：把称呼就地拆掉（只动"主人"这个词，其余保留）
          const fixed = out.replace(/(^|[，,。！!？?、\s])主人(?=$|[，,。！!？?、\s]|早|好|你|晚|再|睡|我|在)/g, '$1你')
            .replace(/(晚安|早安|早上好|谢谢|再见|你好)\s*主人/g, '$1你')
          log(`[qq] 仍旧叫主人 → 就地改掉：「${out.slice(0, 30)}」→「${fixed.slice(0, 30)}」`)
          out = fixed
        }
      }
      // 兜底：真间隔不到一天，话里还冒出"消失四天/好几天没影" → 先让她重写一次，再不行就地掰正
      if (out && ownerGapMs < 24 * 3600_000 && mentionsDays(out)) {
        log(`[qq] 回复里编了天数（真实间隔 ${gapTxt}）：「${out.slice(0, 30)}」→ 让她重写`)
        try {
          const retry = messages.slice()
          retry[retry.length - 1] = {
            role: 'user',
            content: messages[messages.length - 1].content
              + `\n\n【重写】你刚才那句「${out.slice(0, 40)}」里的天数是编的。真实是「${gapTxt}」。重写这一条，一个字都别出现"天"。`,
          }
          const answer2 = await llm.chat(retry, { temperature: 0.8, purpose: 'chat' })
          const out2 = guard.clean(answer2, config())
          if (out2 && !mentionsDays(out2)) out = out2
        } catch (e) { logErr('[qq] 重写失败：' + e.message) }
        if (mentionsDays(out)) {
          const fixed = sanitizeDayClaims(out, ownerGapMs)
          if (fixed !== out) log(`[qq] 天数已掰正：「${out.slice(0, 34)}」→「${fixed.slice(0, 34)}」`)
          out = fixed
        }
      }
      if (!out) return

      // 声称-证据闸（v3 O11）：有证据放行；账本有反证才改成「还没…」；查不到一个字都不改（只记账）。
      // ⚠️ 10-29 事故：旧版把完成态反转成"正要接着看"，主人当场引用质问 —— 证据缺失≠没发生。
      try {
        const gated = brain.craftReply(out, { chat: chatId })
        if (gated.changed) {
          log(`[qq] 🧾 没证据的"做完了"→改口：「${out.slice(0, 26)}」→「${gated.text.slice(0, 26)}」`)
          out = gated.text
        }
      } catch (e) { logErr('[qq] 声称闸异常：' + (e?.message ?? e)) }

      // 承诺账本（10-27）：从她真正发出去的话里抽"这就去看/我答应/明天做"，落账带截止时间。
      // 只记私聊（群里答应的事不算对主人的承诺），且只在非干跑时记。
      try {
        const ownerQQ1 = String(config().owner?.qq || '')
        if (!isGroup && !config().guard?.dryRun && ownerQQ1 && String(userId) === ownerQQ1) {
          const got = promises.catchFromReply(out, { userText })
          if (got.length) log(`[qq] 📌 记下承诺：${got.map((g) => g.what).join('，')}（到点会真去做）`)
        }
      } catch (e) { logErr('[qq] 记承诺失败：' + (e?.message ?? e)) }
      // 标签本身绝不能发给主人 —— 这里就剥掉，同时把情绪记下来给语音用。
      const emoTagged = parseEmotionTag(out)
      const emotion = emoTagged.emotion
      if (emotion) {
        out = emoTagged.text
        log(`[qq] 🎭 情绪标签「${emotionProfile(emotion).label}」→ 语音按这个语气合成`)
        if (!out) return
      }

      // 表情：文字和 [表情:标签] 拆开发（NapCat 图片段）
      let { text: body, tag, caption } = splitSticker(out)
      // 摇中了要发图、但她没写标记 → 按她自己那句话的情绪自动挑一个（10-25：光靠模型自觉，
      // 17:01 之后七八条回复一张图都没发出去，这个功能等于废了）。
      if (diceWon && !tag && !caption) {
        const auto = autoTag(out)
        if (auto) {
          tag = auto
          log(`[qq] 🎲 摇中表情但她没写标记 → 按内容自动补「${auto}」`)
        }
      }
      const aiOn = config().imageGen?.enabled !== false
      let stickerFile = tag ? pickSticker(tag) : null
      if (!stickerFile && caption && !aiOn) stickerFile = ensureSelfSticker(caption, config())  // AI 关着才当场画文字贴纸
      if (diceWon) log(`[qq] 表情结果：${stickerFile ? '图库「' + tag + '」→' + path.basename(stickerFile) : caption ? 'AI「' + caption + '」待生成' : '没发出去'}`)
      const plain = body || (stickerFile ? '' : (FACE_FALLBACK[tag] || ''))
      // AI 表情包：图库没有这个标签 / 有自制表情文案 → 待异步生成（不卡回复主线）
      const aiWanted = aiOn && ((tag && !pickSticker(tag)) || (caption && !stickerFile))
      if (!plain && !stickerFile && !aiWanted) return

      // 干跑：只打印不真发（dabot 铁律：第一周先观察）
      if (config().guard?.dryRun) {
        log(`[qq][干跑] ${isGroup ? '群' + groupId : '私聊' + userId} → ${plain}${stickerFile ? ' [表情图]' : ''}${aiWanted ? ` +AI表情「${tag || caption}」` : ''}`)
        // v5 修 P0：**绝不能**把没发出去的话记成"她说过"。
        // 旧代码在这里 memory.remember(..., 'assistant', plain)：干跑期间每一条拟回复
        // 都被当成真实发言写进 episodes / brain，之后她会引用这些"幽灵发言"，
        // 而 brain.onSent 只在真发后记 → 两套记忆开始分叉。
        // 现在只落一条带 dryRun 标记的审计，供事后核对；不进对话记忆。
        memory.rememberAudit({
          platform: EVT_PLATFORM, chatId, userId, isGroup,
          kind: 'dryrun', text: plain || out,
          note: 'guard.dryRun=true：只打印未发送',
        })

      // 长期记忆：跟主人私聊时，每 6 条回复把这段对话压成摘要 + 更新主人画像（不阻塞回复）
      try {
        const ownerQQ = String(config().owner?.qq || '')
        if (!isGroup && ownerQQ && String(userId) === ownerQQ) {
          qqMemory.bump(chatId)
          if (qqMemory.due(chatId)) {
            qqMemory.refresh({ chatId, owner: config().owner, chat: (m) => llm.chat(m, { purpose: 'fast' }) })
              .then((ok) => { if (ok) log('[qq] 记忆已压缩（摘要 + 主人画像）') })
              .catch((e) => logErr('[qq] 记忆压缩失败：', e.message))
          }
        }
      } catch (e) { logErr('[qq] 记忆维护异常：', e.message) }
        return
      }

      // 真发前：间隔 + 去重（跳过 dryRun，上面已单独处理）
      // QQ 是即时聊天：间隔用 qq.minGapSec（默认 2 秒），不能用全局 guard.minGapSec（25 秒，那是 B 站防刷评论的）
      const qqGuardCfg = { ...config(), guard: { ...config().guard, minGapSec: Number(QQ.minGapSec ?? 2) } }
      const verdict = guard.allow(chatId, out, qqGuardCfg, { checkDryRun: false })
      if (!verdict.ok) { logErr(`[qq] 拦下：${verdict.why}`); return }
      guard.commit(chatId, out)

      const target = isGroup
        ? { api: 'send_group_msg', key: 'group_id', id: Number(groupId) }
        : { api: 'send_private_msg', key: 'user_id', id: Number(userId) }
      // 语音 or 文字（语音失败一律降级文字，内容不丢）
      // 情绪化语音（10-26）：真人发语音从来不是一口气念完一整段 ——
      //   ①一条回复最多切 2 条语音、每条 ≤60 字（长段一次合成也天然更平）
      //   ②每条按她的情绪挑参考音色、多合几条挑最像人的那条（见 lib/tts.mjs 的 L0/L2）
      //   ③没念完的部分照常当文字补发，内容一点不丢
      let spokeParts = 0
      let restText = plain
      if (QQ.voice_enabled && plain && Math.random() < (Number(QQ.voice_chance) || 0.15)) {
        const plan = splitVoiceParts(plain, {
          maxChars: Number(QQ.voice_maxChars) || 60,
          maxParts: Number(QQ.voice_parts) || 2,
        })
        for (let i = 0; i < plan.parts.length; i++) {
          const line = plan.parts[i]
          if (!line) continue
          try {
            const audio = await synth(line, undefined, { emotion })
            const seg = { type: 'record', data: { file: audio } }   // NapCat 自动转 silk
            const okOne = await send(target.api, { [target.key]: target.id, message: [seg] })
            if (!okOne) break
            spokeParts += 1
            if (i + 1 < plan.parts.length) await new Promise(r => setTimeout(r, 500 + Math.random() * 700))
          } catch (e) {
            logErr(`[qq] 语音失败（剩下转文字）：${e.message}`)
            break
          }
        }
        if (spokeParts) {
          restText = plan.rest || ''
          log(`[qq] 已发 ${spokeParts} 条语音${emotion ? '（' + emotionProfile(emotion).label + '）' : ''}${restText ? '，剩余文字补发' : ''} → ${isGroup ? '群' + groupId : userId}`)
        }
      }
      if (!spokeParts) restText = plain
      if (restText) {
        // 像人一样分条发：一句一条，间隔几百毫秒到一秒多（不是机械固定）
        const bubbles = splitBubbles(restText)
        for (let i = 0; i < bubbles.length; i++) {
          if (i) await new Promise(r => setTimeout(r, 420 + Math.random() * 900))
          await send(target.api, { [target.key]: target.id, message: [{ type: 'text', data: { text: bubbles[i] } }] })
        }
        if (bubbles.length > 1) log(`[qq] 分 ${bubbles.length} 条发`)
      }
      // 表情：文字或语音发完都补发（以前语音命中时表情整个被跳过——10-25 实测坑）
      if (stickerFile) {
        await new Promise(r => setTimeout(r, 300 + Math.random() * 500))
        const okImg = await send(target.api, { [target.key]: target.id, message: [{ type: 'image', data: { file: (await import('../lib/onebot-file.mjs')).onebotFileValue(stickerFile) } }] })
        if (okImg) log(`[qq] 已发表情：${tag || caption || '?'}`)
      }
      // AI 表情包：生成入库 + 补发（异步，不占回复主线；干跑分支已在上面 return，走不到这）
      if (aiWanted) void aiStickerFollowup({ tag, caption, isGroup, groupId, userId })
      memory.remember(EVT_PLATFORM, chatId, userId, 'assistant', plain || out, { isGroup })
      // 交付证据（v3 §11）：真发出去才记；干跑在上面已经 return，走不到这里。
      try {
        brain.onSent({ chat: chatId, platform: EVT_PLATFORM, text: plain || out, msgId: '', at: Date.now() })
        brain.onEvent({
          proc: 'qq-server', platform: EVT_PLATFORM, chatId, userId, role: 'assistant',
          text: plain || out, isGroup, groupId, msgId: evt.message_id,
        })
      } catch (e) { logErr('[qq] 交付记账失败：' + (e?.message ?? e)) }

      // 长期记忆：跟主人私聊时，每 6 条回复把这段对话压成摘要 + 更新主人画像（不阻塞回复）
      try {
        const ownerQQ = String(config().owner?.qq || '')
        if (!isGroup && ownerQQ && String(userId) === ownerQQ) {
          qqMemory.bump(chatId)
          if (qqMemory.due(chatId)) {
            qqMemory.refresh({ chatId, owner: config().owner, chat: (m) => llm.chat(m, { purpose: 'fast' }) })
              .then((ok) => { if (ok) log('[qq] 记忆已压缩（摘要 + 主人画像）') })
              .catch((e) => logErr('[qq] 记忆压缩失败：', e.message))
          }
        }
      } catch (e) { logErr('[qq] 记忆维护异常：', e.message) }
    } catch (e) {
      logErr('[qq] 处理失败：', e.message)
    }
  }

  // ── 统一通道接线（10-31）：批次合并的逻辑在 channel-io.synthBatch ─────────────
  CHANNEL.setLogger((m) => log(m))
  CHANNEL.onHandle(async (batch) => {
    const synth = CHANNEL_IO.synthBatch(batch, { ttlMs: 10 * 60_000 })
    if (!synth) return
    if (synth.__merged > 1) log('[qq] 📚 合并 ' + synth.__merged + ' 条连发消息成一次回复：' + String(synth.__text || '').slice(0, 60))
    // v5：批次里第一条的 platform 就是这一批的平台（同会话必然同平台），
    // 交给 handle() 自己去建上下文；这里只做一次防御性校验。
    if (!PLATFORMS.isKnownPlatform(synth.__platform || 'qq')) {
      logErr('[qq] 未知平台，丢弃这批消息：' + String(synth.__platform))
      return
    }
    await handle(synth)
  })

  // ── OneBot 看门狗（SnowLuma/NapCat 通用）：它才是 QQ 的消息网关。网关不通 = 服务在跑但永远不回复 ──
  const LAUNCHER = QQ.napcat_launcher || 'D:/NapCat/launcher-user.bat'
  let napcatOk = false
  let napcatCheckedAt = 0
  let napcatDownSince = 0
  let napcatFails = 0        // 连续探活失败次数（去抖用）
  let autostartAt = 0

  async function checkNapcat() {
    try {
      const r = await fetch(`${NAPCAT}/get_status`, { signal: AbortSignal.timeout(3000) })
      napcatOk = r.ok
    } catch {
      napcatOk = false
    }
    napcatCheckedAt = Date.now()
    if (!napcatOk) {
      napcatFails += 1
      // 单次探活失败不算断（QQ 忙的时候 /get_status 也会超时，实测 26s 就自愈的瞬时抖动）：
      // 连续 2 次失败才拉警报，不然日志全是狼来了。
      if (napcatFails < 2) return napcatOk
      if (!napcatDownSince) napcatDownSince = Date.now()
      const downSec = Math.round((Date.now() - napcatDownSince) / 1000)
      logErr(`[napcat] 网关不通（${NAPCAT}），已持续 ${downSec}s —— 这期间收不到也发不出任何 QQ 消息`)
      if (downSec === 30) logErr(`[napcat] 修复办法：右键「管理员运行」${LAUNCHER}（QQ 会自动登录/让你扫码）`)
      // 默认不自动拉：NapCat 要管理员把 DLL 注入 QQ，普通权限起了也是白起（实测 QQ 进程数 0）。
      const auto = QQ.autostartNapcat === true
      if (auto && downSec >= 20 && Date.now() - autostartAt > 10 * 60_000 && fs.existsSync(LAUNCHER)) {
        autostartAt = Date.now()
        log(`[napcat] 尝试拉起 QQ 网关：${LAUNCHER}（登录态需要你扫码时会弹窗）`)
        try {
          const { spawn } = await import('node:child_process')
          spawn('cmd.exe', ['/c', 'start', '', LAUNCHER], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
        } catch (e) {
          logErr('[napcat] 拉起失败：' + e.message)
        }
      }
    } else {
      napcatFails = 0
      if (napcatDownSince) log('[napcat] 网关恢复')
      napcatDownSince = 0
    }
    return napcatOk
  }
  checkNapcat()
  // [beat] setInterval(checkNapcat, 30_000) -> heartbeat vitals.napcat

  const server = http.createServer((req, res) => {
    // ── v5 统一鉴权闸 ────────────────────────────────────────────────────────
    // 旧版本 /onebot /inbound /outbound /task /event /sent 全部裸奔，而 im-gateway.sh
    // 把服务绑在 0.0.0.0 上 —— 同一个 docker 网桥里的任何容器都能读她的出站消息、
    // 往队列里塞任务、冒充任意用户跟她说话。当时唯一挡住的是 guard.dryRun=true。
    //
    // 现在：/health 保持开放（只读、给监工用、不含私密内容）；
    // 其余入口统一过 inbound-auth：配了 qq.inboundToken 就强制校验 token，
    // 没配就只允许本机回环（跨容器/局域网一律 401）。
    if (req.url !== '/health') {
      // /onebot 是 OneBot v11 的上报口，它**不支持自定义请求头** ——
      // 强制 token 会直接断掉本机 SnowLuma/NapCat（安全改到不能用）。
      // 所以它只要求"本机回环"，其余入口（/inbound /outbound /task /event /sent）
      // 配了 token 就严格校验。
      const isOneBotIngress = req.method === 'POST' && req.url === '/onebot'
      if (requireInboundToken(req, res, config(), { allowLoopback: isOneBotIngress })) return
    }
    if (req.method === 'POST' && req.url === '/onebot') {
      let body = ''
      req.on('data', c => { body += c; if (body.length > 1024 * 1024) req.destroy() })
      req.on('end', async () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"status":"ok"}')
        try {
          const evt = JSON.parse(body)
          if (evt.post_type === 'message') CHANNEL_IO.enqueueOneBot(evt, CHANNEL, parseMessage)
        } catch (e) { logErr('[qq] 事件解析失败：', e.message) }
      })
      return
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        dryRun: !!config().guard?.dryRun,
        // v5：把"入口有没有设防"直接暴露在健康检查里 —— 这是最容易被忽略的一项。
        inboundAuth: (() => {
          const c = config()
          const t = String(c.qq?.inboundToken || '')
          return { mode: t ? 'token' : 'loopback-only', hasToken: !!t, bindHost: process.env.QQ_BIND_HOST || '127.0.0.1' }
        })(),
        platforms: PLATFORMS.snapshot(config()),
        napcat: { ok: napcatOk, url: NAPCAT, checkedAt: napcatCheckedAt, downSince: napcatDownSince || null },
        brain: brainHealth(),
        channel: (() => { try { return CHANNEL.snapshot() } catch (e) { return { error: String(e?.message ?? e) } } })(),
        ...memory.stats(),
      }))
      return
    }
    // ── 脑的两条通用入口（v3 §6 S0）─────────────────────────────────
    // 别的通道（抖音私信/推送/未来的 B站）不必自己实现记忆层：POST 过来就行。
    // body: {proc,platform,chatId,userId,role,text,isGroup,scope,msgId}
    // ── 统一通道的入站/出站（10-31）全部在 tools/lib/channel-io.mjs ─────────
    if (CHANNEL_IO.handleChannelRoutes(req, res, CHANNEL, log)) return

    if (req.method === 'POST' && (req.url === '/event' || req.url === '/sent')) {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy() })
      req.on('end', () => {
        let out = { ok: false }
        try {
          const j = JSON.parse(body || '{}')
          out = req.url === '/sent'
            ? (() => { const r = brain.onSent(j); return { ok: Boolean(r), hash: r?.hash || '' } })()
            : (() => { const r = brain.onEvent(j); return { ok: r.ok, id: r.ep?.id || '', reason: r.reason || '' } })()
        } catch (e) { out = { ok: false, reason: String(e?.message || e) } }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      })
      return
    }
    // ── 身体/工具协议入口：POST /task 放活、GET /task 看队列 ────────────
    if (req.url === '/task' || req.url.startsWith('/task?')) {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, stats: brain.taskqueue.stats(), rows: brain.taskqueue.list() }))
        return
      }
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy() })
      req.on('end', () => {
        let out = { ok: false }
        try {
          const j = JSON.parse(body || '{}')
          out = brain.taskqueue.enqueue({ kind: j.kind, args: j.args || [], note: j.note || '', priority: j.priority || 0 })
        } catch (e) { out = { ok: false, reason: String(e?.message || e) } }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      })
      return
    }
    res.writeHead(404); res.end()
  })

  /** /health 里的脑摘要（只读小文件，别在这里跑 doctor）。 */
  function brainHealth() {
    try {
      const b = config().brain || {}
      return {
        mode: b.mode || 'shadow',
        episodes: brain.episode.allEpisodes().length,
        intents: brain.intents.stats(),
        backlog: brain.event.backlog(),
        today: brain.metrics.today(),
      }
    } catch (e) { return { error: String(e?.message || e) } }
  }

  const QQ_BIND = process.env.QQ_BIND_HOST || '127.0.0.1'
  server.listen(port, QQ_BIND, () => {
    log(`[qq] 监听 http://${QQ_BIND}:${port}/onebot`)
    log(`    SnowLuma WebUI → OneBot配置 → HTTP上报 → http://127.0.0.1:${port}/onebot（messagePostFormat=array）`)
    log(`    dryRun=${!!config().guard?.dryRun} · at_only=${QQ.at_only !== false} · voice=${!!QQ.voice_enabled} · napcat=${NAPCAT}`)
    // 群聊认人护栏自检（10-26）：启动就把三件套的状态打出来 —— 换了代码却忘了重启时，
    // 看这一行就知道跑的是哪一版，不用再猜"到底生效了没有"。
    log(`    群聊认人护栏：事实块 + 剔旧错话 + 出稿拦截 = 已启用（主人号 ${String(config().owner?.qq || '').slice(0, 3)}***）`)
    // 引用索引预热（10-27）：没有它，"他引用的是哪句"就只能回一句"我看不到"
    void (async () => {
      try {
        const li = await callApi('get_login_info', {}, 8000)
        if (li?.data?.user_id) selfIdCached = String(li.data.user_id)
        if (config().qq?.quote?.enabled !== false) {
          await warmQuoteIndex(50)
          // [beat] warmQuoteIndex interval -> heartbeat vitals.quotes
        }
      } catch (e) { logErr('[qq] 引用索引预热失败：' + (e?.message ?? e)) }
    })()
    // 辅助服务监工（10-27 起）：qq-server 是唯一常驻体，所以让它当监工。
    // 10-31 抖音整体移除后，这里只剩「每 autoMin 分钟跑一次 B站 自己作品评论巡检」。
    void (async () => {
      try {
        // 注意：文件名不能叫 aux.mjs —— AUX 是 Windows 的保留设备名，Win32 打开它一律报"找不到路径"，
        // 动态 import 会静默失败（aux.mjs 时代监工从没真正启动过）。
        const { ensureBiliOwnReply, superviseAux } = await import('../lib/auxsvc.mjs')
        // 抖音私信陪聊已整体移除（10-31），监工只剩 B站 自己作品评论巡检
        superviseAux()
        log('[aux] 监工已挂上：每 90s 探 B站 自己作品评论巡检')
        setTimeout(() => { void ensureBiliOwnReply().then((r) => { if (r.ran) log('[aux] B站 首轮巡检：' + (r.out || '无新评论')) }) }, 20_000)
      } catch (e) { logErr('[aux] 监工启动失败：' + (e?.message ?? e)) }
    })()
  })

  // ── 主动搭话引擎（B站同款自主性）：主人安静久了，带着由头主动开口 ──────────
  // 原则：随机拟人不定点；正聊着不打扰（minQuietMin）；深夜不打扰（activeHours）；
  //       每天有上限（dailyMax）；开口前情绪先漂移一次；发完即写记忆（推送即记忆）。
  const PROACT_FILE = dataPath('qq-proactive.json')
  let ownerLastMsgAt = 0
  let selfIdCached = String(QQ.self_id || '')     // 引用索引要用（启动时从 get_login_info 补上）
  const STARTED_AT = Date.now()
  const dayKeyNow = () => new Date().toLocaleDateString('sv-SE')

  /**
   * 跑一条自己的 CLI（= 她"自己动手"，10-27）。
   * 用宿主同一个 node（process.execPath），不用 shell，超时可控；
   * 失败只返回空串并记一行日志 —— 绝不让"没做成"变成谎话。
   */
  function runCli(args = [], timeoutMs = 180000) {
    try {
      const bot = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'bot.mjs')
      const r = spawnSync(process.execPath, [bot, ...args], {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      const out = String(r.stdout || '')
      if (r.status !== 0) {
        log(`[qq] 自跑 ${args[0]} 退出码 ${r.status}：${String(r.stderr || out).slice(0, 120)}`)
      }
      return out
    } catch (e) { logErr('[qq] 自跑失败：' + (e?.message ?? e)); return '' }
  }

  /** 异步版自跑：看番可能连着跑好几分钟，用 spawnSync 会把事件循环钉住 ——
   *  那段时间她连主人发的消息都回不了。所以看番一律走这条。 */
  async function runCliAsync(args = [], timeoutMs = 900000) {
    try {
      const bot = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'bot.mjs')
      const { stdout } = await execFileAsync(process.execPath, [bot, ...args], {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      return String(stdout || '')
    } catch (e) {
      const out = String(e?.stdout || '')          // 超时/非零退出也可能已经打出半截 JSON
      if (out.includes('{')) return out
      logErr('[qq] 自跑(异步)失败：' + (e?.message ?? e))
      return ''
    }
  }
  const readProact = () => { try { return JSON.parse(fs.readFileSync(PROACT_FILE, 'utf8')) } catch { return {} } }
  const writeProact = (st) => { try { fs.writeFileSync(PROACT_FILE, JSON.stringify(st)) } catch {} }

  /**
   * 「她今天在网上干了什么」—— 从 web-log.md 当天段落取**最新** n 条（10-27 修）。
   * 文件格式：`## 2026-10-27` 标题在上、新条目插在该段顶部（即最新在前）。
   * 老代码 `.split('\n').slice(-3)` 取的是文件最底部 = 最早那天的最早几条 ——
   * 于是整整两天，每条推送都在告诉她"你自己刚才在网上干的：搜南京小吃"，
   * 南京就从"她顺手搜过的一次"变成了"她的人设"。
   */
  function todayWebLines(n = 3) {
    try {
      const raw = fs.readFileSync(dataPath('web-log.md'), 'utf8')
      const today = dayKeyNow()
      const lines = raw.split('\n')
      const start = lines.findIndex((l) => l.trim() === `## ${today}`)
      if (start < 0) return []
      const body = []
      for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i]
        if (/^##\s/.test(l)) break
        if (!l.trim()) continue
        body.push(l.replace(/^-\s*/, '').replace(/\*\*/g, '').slice(0, 46))
        if (body.length >= n) break
      }
      return body
    } catch { return [] }
  }

  // 10-25 修（用户抓到"两条差不多的抱怨"）：ownerLastMsgAt 只在内存里 → DSH 一重启就归零
  // → quietH 变成 99 → 她一律按"主人很久没理我"开口，编出"你消失四天了"（当时其实 13 分钟前刚聊过）。
  // 启动时从 QQ 记忆里把主人最后一条消息的真实时间捞回来。
  function seedOwnerLastMsgAt() {
    const ownerQQ = String(config().owner?.qq || '')
    // ⚠️ 10-26 修：原来只比对 userId，主人在**群里**说话也算"主人最后一条消息" ——
    // 结果他群里聊了一整天，她在私聊就永远判定"他刚跟我聊过"，主动搭话全被 quiet 门槛吃掉。
    // "多久没说话"只对私聊有意义，所以必须同时锁 chatId。
    const ownerChat = 'qq:' + ownerQQ
    try {
      const file = dataPath('qq', 'episodes.jsonl')
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = JSON.parse(rows[i])
        if (r && r.role === 'user' && String(r.chatId || '') === ownerChat
          && (!ownerQQ || String(r.userId || '') === ownerQQ) && r.isGroup !== true) {
          ownerLastMsgAt = Number(r.ts) || 0
          log(`[qq] 主人最后一条私聊消息：${new Date(ownerLastMsgAt).toLocaleString('zh-CN')}（从记忆恢复）`)
          return
        }
      }
    } catch {}
    // 记忆里翻不到 → 按"刚刚聊过"算：宁可不提时间，也不许编一个天数出来
    ownerLastMsgAt = Date.now()
    log('[qq] 记忆里没有主人的消息 → 按刚聊过处理（先不提"多久没见"）')
  }
  seedOwnerLastMsgAt()

  // 主人最后一条消息的时间（从 QQ 记忆尾部读）—— "多久没说话"的唯一可信来源。
  // 内存里的 ownerLastMsgAt 只在收到消息时更新过，重启就归零，不能当事实用。
  function lastOwnerMsgTs() {
    const ownerQQ = String(config().owner?.qq || '')
    // 同上：只认私聊。群里的"主人"发言不算"跟我说话"。
    const ownerChat = 'qq:' + ownerQQ
    try {
      const line = fs.readFileSync(dataPath('qq', 'episodes.jsonl'), 'utf8').trim().split('\n')
      for (let i = line.length - 1; i >= 0; i--) {
        const r = JSON.parse(line[i])
        if (r && r.role === 'user' && String(r.chatId || '') === ownerChat
          && (!ownerQQ || String(r.userId || '') === ownerQQ) && r.isGroup !== true) return Number(r.ts) || 0
      }
    } catch {}
    return 0
  }

  // ── 承诺执行器（v5：整块逻辑抽到 tools/lib/promise-executor.mjs）──────────
  // 这里只接线。抽出的动机：qq-server 是 1700+ 行主闭包，而这 181 行是自洽的；
  // 独立成模块后可单测，也让本文件回到规模护栏以内。
  const promiseExec = createPromiseExecutor({ runCliAsync, log, logErr })
  const { runDuePromises, resolveShow } = promiseExec
  const PROMISE_OUT = promiseOutcomePath

  async function tryProactive() {
    try {
      const cfgNow = config()
      const pp = cfgNow.qq?.proactive ?? {}
      if (pp.enabled !== true) return
      // 统一规划（10-31）：她自己定了"接下来干什么"，就别在人家做事时插话。
      // 只有真的闲下来（rest / free / 没计划）才轮到主动搭话。
      if (cfgNow.mind?.respectBusy !== false) {
        try {
          const M = await import('../lib/mind.mjs')
          const b = M.busy()
          if (b.busy && b.activity && b.activity !== 'rest' && b.activity !== 'free') {
            return   // 她在专心，不打扰
          }
        } catch {}
      }
      // 启动宽限（10-25）：刚拉起来就"你很久没理我"纯属噪音 —— 重启当天连发三条同义句的教训
      if (Date.now() - STARTED_AT < Number(pp.startupGraceMin ?? 10) * 60_000) return
      // 晚间限制（用户 10-25 拍板可关）：activeHours 配成 null / [] = 全天可主动搭话；[a,b] 才限时
      const ah = pp.activeHours
      if (Array.isArray(ah) && ah.length === 2) {
        const hour = new Date().getHours()
        if (hour < ah[0] || hour >= ah[1]) return
      }
      let st = readProact()
      if (st.day !== dayKeyNow()) st = { day: dayKeyNow(), count: 0, lastAt: 0 }
      const dailyMax = Number(pp.dailyMax ?? 3)
      if (dailyMax > 0 && Number(st.count ?? 0) >= dailyMax) return
      if (Date.now() - Number(st.lastAt ?? 0) < Number(pp.minGapMin ?? 150) * 60_000) return
      // 10-31：全局闸门（三条主动通道共用）—— 治"一小时内连发 6 条 + 自言自语接自己话"
      { const g = await canSpeak('proactive'); if (!g.ok) { log('[qq] 主动搭话跳过：' + g.why); return } }
      if (ownerLastMsgAt && Date.now() - ownerLastMsgAt < Number(pp.minQuietMin ?? 90) * 60_000) return
      // ── LLM 决策预检（10-31 智能化升级）──────────────────────────────
      // 旧逻辑：硬闸全过后 12% 掷骰，命中就硬搭 —— 她对"该不该说"没有发言权。
      // 新逻辑：硬闸全过后先做一次便宜的自问（deepseek-flash，max_tokens 60），
      //   她结合自己的状态/记忆/时段回答想不想说话。yes 才进搭话链，
      //   later/no 直接 return（今天搭话质量来自"她自己想说"，不是骰子）。
      //   掷骰保留为兜底（预检失败/超时时走老路，行为不回退）。
      let smartPass = null
      try {
        const llm = await import('../lib/llm.mjs')
        const hourNow = new Date().getHours()
        const dowNow = new Date().getDay()
        const dowText = dowNow === 0 ? '周日' : dowNow === 6 ? '周六' : ['周一','周二','周三','周四','周五'][dowNow-1]
        // 情境摘要：最近记忆尾部 + 情绪 + 上次搭话
        let recentLine = ''
        try {
          const rows = fs.readFileSync(dataPath('episodes.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
          const last = rows.slice(-3).map((l) => { try { const j = JSON.parse(l); return (j.role === 'assistant' ? '我说：' : '他说：') + String(j.summary || j.text || '').slice(0, 40) } catch { return '' } }).filter(Boolean)
          if (last.length) recentLine = last.join('；')
        } catch {}
        const moodNow2 = (() => { try { return JSON.parse(fs.readFileSync(dataPath('mood.json'), 'utf8')) } catch { return {} } })()
        const dResp = await llm.chat([
          { role: 'system', content: fill('你是{name}。回答"现在要不要主动给{owner}发消息"。判据（自己权衡，不是规则）：你有真的想说的吗？现在时段合不合适？连续发过就别再发。输出 JSON：{"decision":"yes|later|no","hook":"想说的话头（yes 时给一句，20字内）","reason":"一句话理由"}。decision 必须诚实——没有想说的就说 no，别为了说话而说话。') },
          { role: 'user', content: `现在：${dowText} ${hourNow}点。他已安静 ${quietMin || 0} 分钟。你的情绪值 ${Math.round(Number(moodNow2.value) || 60)}/100。最近：${recentLine || '（安静）'}。上次搭话说了：${lastProact.lastText ? String(lastProact.lastText).slice(0, 40) : '（今天还没说过）'}。` },
        ], { temperature: 0.8, max_tokens: 80, timeoutMs: 15000, model: cfgNow.llm?.content_model, purpose: 'deep' })
        const m2 = String(dResp?.content ?? dResp ?? '').match(/\{[\s\S]*\}/)
        if (m2) {
          const j2 = JSON.parse(m2[0])
          smartPass = j2
          if (j2.decision === 'no' || j2.decision === 'later') {
            log(`[qq] 🤔 决策预检：${j2.decision}（${String(j2.reason || '').slice(0, 40)}）—— 不打扰`)
            return
          }
          if (j2.hook) hooks.push('你自己现在想说的（决策预检给的由头）：' + String(j2.hook).slice(0, 60))
        }
      } catch {}
      if (!smartPass && Math.random() > Number(pp.chance ?? 0.12)) return

      const ownerQQ = String(cfgNow.owner?.qq || '')
      if (!ownerQQ) return
      tickMood()
      const quietMs = Math.max(0, Date.now() - ownerLastMsgAt)
      const quietMin = Math.floor(quietMs / 60_000)
      const quietH = Math.floor(quietMs / 3600_000)
      const quietText = quietMin < 60 ? `${quietMin} 分钟` : `${quietH} 小时 ${quietMin % 60} 分`
      const nowText = new Date().toLocaleString('zh-CN', { hour12: false })
      // 素材钩子（10-25）：光给类型菜单 LLM 只会甩视频链接 —— 把她今天真实的经历、时段、情绪值
      // 和主人记忆喂进去，她才有"日常/思考/疑惑/心情"可说
      const hour = new Date().getHours()
      const slot = hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '午饭点' : hour < 18 ? '下午' : hour < 20 ? '傍晚' : hour < 23 ? '晚上' : '深夜'
      const moodNow = (() => { try { return JSON.parse(fs.readFileSync(dataPath('mood.json'), 'utf8')) } catch { return {} } })()
      const hooks = [`现在是${slot}${hour >= 11 && hour < 14 ? '（饭点，但**他已经说过吃了什么就别再问**）' : ''}`, `你的情绪值 ${Math.round(Number(moodNow.value) || 60)}（低于 40 就是低落）`]
      try {
        const rows = fs.readFileSync(dataPath('episodes.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
          .map((l) => JSON.parse(l)).filter((r) => Date.now() - (r.ts || 0) < 86400_000 && ['bilibili', 'douyin'].includes(r.platform))
        if (rows.length) hooks.push('今天在外面：' + rows.slice(-3).map((r) => String(r.summary || r.text || '').slice(0, 28)).join('；'))
      } catch {}
      // 主人事实（10-27）：他今天已经说过的事 —— 有了这段，她才不会一天问十次"吃了没"
      {
        const known = ownerFacts.list()
        if (known.length) {
          const label = { food: '他吃了', doing: '他在做', plan: '他说要去', mood: '他的状态', media: '他提到的作品' }
          hooks.push('他已经说过的事（别再问第二遍）：' + known.slice(-4).map((x) => `${label[x.key] || x.key}${x.value}`).join('；'))
        }
      }
      {
        const fcts = memory.facts('owner')
        if (fcts.length) hooks.push('关于主人的记忆：' + fcts.slice(-2).join('；').slice(0, 90))
      }
      // 10-26：以前素材只有 B站/抖音，她翻来覆去就那几句（"肚子叫/桑拿鸡"连着说），
      // 大半草稿被去重拦掉，看着就像"主动性很弱"。把她自己在网上干的事也喂进去 —— 素材新鲜，话才不重。
      // ⚠️ 10-27 修：`web-log.md` 是**最新在上**（## 日期在文件头，新条目插在该段顶部），
      // 老代码 `.slice(-3)` 取到的是**文件最底部**=最早那天的条目 —— 于是连着两天每条推送都在说
      // "你自己刚才在网上干的：搜南京小吃"。现在按"今天的段落 + 取头部 3 条"来读。
      {
        const wl = todayWebLines(3)
        if (wl.length) hooks.push('你自己今天在网上干的：' + wl.join('；'))
      }
      try {
        const dg = fs.readFileSync(dataPath('diary-owner.md'), 'utf8').split('\n').filter(Boolean).slice(-1)[0]
        if (dg) hooks.push('你最近写给主人的日记里那句：' + dg.replace(/^[-#\s]+/, '').slice(0, 50))
      } catch {}
      try { const li = memory.loreInterests(1); if (li.length) hooks.push('最近挂在心上：' + String(li[0]).slice(0, 40)) } catch {}

      // ── 智能钩子（10-31 升级）─────────────────────────────────────
      // ① brain 多路召回：按当前时段+情绪，从统一记忆里捞出真正相关的旧事
      try {
        const br = await import('../brain/recall.mjs')
        const B = br.bundle({ platform: 'qq', chatId: 'qq:' + ownerQQ, userId: ownerQQ, userText: '', limit: 3 })
        if (B.lines && B.lines.length) hooks.push('记忆里浮上来的（可自然提起）：' + B.lines.slice(0, 2).join('；').slice(0, 120))
      } catch {}
      // ② 梦境钩子：昨晚的梦（30% 概率以梦为由头）
      if (Math.random() < 0.3) {
        try {
          const { dreamToMention } = await import('./dream.mjs')
          const d = dreamToMention()
          if (d) hooks.push('你昨晚做了个梦（可以讲给他听，说明是梦不是真事）：' + d.text.replace(/^【梦】/, '').slice(0, 80))
        } catch {}
      }
      // ③ 时间语义：周几+节假日感
      {
        const dow = new Date().getDay()
        const dowText = dow === 0 ? '周日' : dow === 6 ? '周六' : ['周一','周二','周三','周四','周五'][dow-1]
        hooks.push('今天' + dowText + (dow === 0 || dow === 6 ? '（周末，他可能在家休息）' : dow === 1 ? '（新的一周开始了）' : dow === 5 ? '（周五，快熬出头了）' : '（工作日）'))
      }
      // ④ 小报告节流：刚打完小报告 2h 内不再主动搭话（防连发骚扰）
      try {
        const tt = JSON.parse(fs.readFileSync(dataPath('tattle.json'), 'utf8'))
        if (tt.lastAt && Date.now() - Number(tt.lastAt) < 2 * 3600_000) return
      } catch {}
      const lastProact = readProact()
      const lastType = String(lastProact.lastType || '')

      // ── 承诺改成独立执行器（10-28）─────────────────────────────────────
      // 病根：执行挂在这条搭话链里 → 要过 enabled / 启动宽限 / 活跃时段 / 日上限 /
      // 最小间隔 / 沉默时长 / **12% 掷骰子** 七道闸。实测：01:00:39 到期的那条承诺，
      // 六次 tick 全掷空，01:07 机器进睡眠 → 整夜没人执行 → 早上她又许一遍愿。
      // 现在执行器是 runDuePromises()（独立 60s tick，不掷骰子、不占搭话配额），
      // 这里只读它刚做完的产出，当成这条推送的由头。
      const saidBefore = (Array.isArray(lastProact.recent) ? lastProact.recent : []).slice(-3)
        .map((x) => `「${String(x.text || '').slice(0, 24)}」`).join('、')
      const built = buildMessages({ platform: 'qq', userText: '', chatId: `qq:${ownerQQ}`, userId: ownerQQ, turnsToday: 0 })
      const quietHint = quietH >= 5 ? '（可以带一点点小委屈或调侃他，但别过头）' : ''
      // 刚真做完的承诺 → 这条推送就以它为由头（不是"想聊什么"，是"我真干了什么"）
      let didLine = ''
      try {
        const o = JSON.parse(fs.readFileSync(PROMISE_OUT(), 'utf8'))
        if (o && !o.used && Date.now() - Number(o.at || 0) < 6 * 3600_000) {
          didLine = o.ok
            ? `你刚真的看完了《${o.title}》${Number(o.watched) > 1 ? `第 ${o.epFirst}~${o.epLast} 集（一口气 ${o.watched} 集）` : `第 ${o.ep} 集`}：${String(o.plot || '').slice(0, 120)}（感受：${String(o.feel || '').slice(0, 60)}）`
            : `你刚试图看《${o.show}》，但没成：${String(o.via || '没有可用材料').slice(0, 80)} —— 这条推送要照实说做不到`
          try { fs.writeFileSync(PROMISE_OUT(), JSON.stringify({ ...o, used: true }, null, 1) + '\n') } catch {}
        }
      } catch {}
      const msgs = [
        built[0],
        { role: 'user', content: `【主动搭话】现在是 ${nowText}。主人最后一条消息是 ${quietText} 前。${quietHint}\n`
          + (didLine ? `**这条就用它当由头**：${didLine}\n` : '')
          + `**时间只准用这一句里的数字**：不许换算成"几天"，不许说"四天/好几天/整整几天"这种我没告诉你的数字${quietMin < 120 ? '；才两个钟头不到，别摆出"好久没见"的架势' : ''}。\n`
          + '**自己挑一个类型**（上次用过「' + (lastType || '无') + '」，这次换一个）：'
          + '①日常——你现在正在干嘛/看到什么随口说；②思考——最近琢磨的小念头；③疑惑——想问他的问题；'
          + '④心情——结合情绪值说现在的状态；⑤安利——甩视频链接。\n'
          + (saidBefore ? `你最近已经说过：${saidBefore} —— 别再重复同样的意思，换个由头。\n` : '')
          + (hooks.length ? '你手上的真实素材（自然地用，别照念）：\n- ' + hooks.join('\n- ') + '\n' : '')
          + '像真人发微信：一条，一两句话，自然具体。禁止"在吗/你好"式开场。只输出 JSON：{"type":"日常|思考|疑惑|心情|安利","text":"消息正文"}' },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 300, purpose: 'deep' })
      let out = ''
      let usedType = '日常'
      try {
        const m = String(resp ?? '').match(/\{[\s\S]*\}/)
        if (m) {
          const j = JSON.parse(m[0])
          usedType = String(j.type || '日常').slice(0, 4)
          out = guard.clean(String(j.text || ''), cfgNow)
        } else out = guard.clean(String(resp ?? ''), cfgNow)
      } catch { out = guard.clean(String(resp ?? ''), cfgNow) }
      if (!out) return
      // ── 事实闸（10-27）────────────────────────────────────────────────
      // "你中午吃了没啊" 在主人 12:47 说过"吃了烧鸭"之后还问了 4 次。根子不是记性，
      // 是推送草稿没人核对事实。这里先把草稿对着「他今天已经说过的事」过一遍：
      //   ①先让她自己改一次（把答案写进去，别问）；②还问就这轮不发。
      {
        const known = ownerFacts.asksKnown(out)
        if (known) {
          log(`[qq] 🚧 草稿在问已经有答案的事（${known.key}=${known.value}）：「${out.slice(0, 30)}」→ 让她改`)
          try {
            const retry = msgs.slice()
            retry[retry.length - 1] = {
              role: 'user',
              content: msgs[msgs.length - 1].content
                + `\n\n【重写】他已经说过「${known.value}」了，你刚才那句还在问，等于没听人说话。`
                + `换成别的由头重写一条（不许再问吃没吃/在干嘛）。`,
            }
            const r2 = await llm.chat(retry, { temperature: 0.9, max_tokens: 300, purpose: 'deep' })
            let out2 = ''
            try {
              const m2 = String(r2 ?? '').match(/\{[\s\S]*\}/)
              out2 = guard.clean(m2 ? String(JSON.parse(m2[0]).text || '') : String(r2 ?? ''), cfgNow)
            } catch { out2 = guard.clean(String(r2 ?? ''), cfgNow) }
            if (out2 && !ownerFacts.asksKnown(out2)) out = out2
            else { log('[qq] 改写后仍在问已知的事，这轮不发'); return }
          } catch (e) { logErr('[qq] 事实闸改写失败：' + e.message); return }
        }
      }
      // 主动搭话本来就是"主人多久没理我"最容易编出天数的场景，再加一道兜底
      if (mentionsDays(out)) {
        const fixed = sanitizeDayClaims(out, Date.now() - ownerLastMsgAt)
        if (fixed !== out) log(`[qq] 主动搭话的天数已掰正：「${out.slice(0, 30)}」→「${fixed.slice(0, 30)}」`)
        out = fixed
      }
      // 跨重启/跨措辞去重（10-25 用户抓的 bug）：状态里只记类型不记原文，于是
      // "你消失四天 / 整整四天 / 快四天" 三条同义句能连发。这里按 3-gram 相似度 + 同类冷却卡住。
      const hist = (Array.isArray(st.recent) ? st.recent : []).filter((x) => x && Date.now() - Number(x.at || 0) < 6 * 3600_000)
      const g1 = guard.grams(out)
      const typeCd = Number(pp.typeCooldownMin ?? 180)
      const clash = hist.find((x) => {
        if (typeCd > 0 && x.type === usedType && Date.now() - Number(x.at) < typeCd * 60_000) return true
        const g2 = guard.grams(String(x.text || ''))
        if (!g1.size || !g2.size) return false
        let inter = 0
        for (const g of g1) if (g2.has(g)) inter++
        return inter / (g1.size + g2.size - inter) > Number(pp.similarityMax ?? 0.25)
      })
      if (clash) {
        log(`[qq] 主动搭话草稿跟 ${Math.round((Date.now() - Number(clash.at)) / 60000)} 分钟前的「${String(clash.text || '').slice(0, 16)}…」撞了（同类/同义），这轮不发`)
        return
      }
      if (cfgNow.guard?.dryRun) { log(`[qq][干跑] 本要主动搭话：${out.slice(0, 50)}`); return }
      const ok = await send('send_private_msg', { user_id: Number(ownerQQ), message: [{ type: 'text', data: { text: out } }] })
      if (!ok) return
      // 10-31：真的发出去了才记账（全局闸门）
      await spokeDone('proactive')
      // 主动搭话也带图（10-25）：这条路径以前**完全不发图**，主人那边"好久没见表情包"一半是这原因。
      if (Math.random() < Number(cfgNow.qq?.stickerChance ?? 0.5)) {
        const ptag = autoTag(out)
        const pfile = ptag ? pickSticker(ptag) : null
        if (pfile) {
          await new Promise(r => setTimeout(r, 400 + Math.random() * 700))
          try {
            const okImg = await send('send_private_msg', { user_id: Number(ownerQQ), message: [{ type: 'image', data: { file: (await import('../lib/onebot-file.mjs')).onebotFileValue(pfile) } }] })
            if (okImg) log(`[qq] 🐟 主动搭话带图：${ptag} → ${path.basename(pfile)}`)
          } catch (e) { logErr('[qq] 主动搭话补图失败：' + (e?.message ?? e)) }
        }
      }
      memory.remember('qq', `qq:${ownerQQ}`, ownerQQ, 'assistant', out, { kind: 'push' })   // 推送即记忆：她自己"说过"这句（kind=push 不占对话窗口）
      const st2 = readProact()
      const rec = (Array.isArray(st2.recent) ? st2.recent : []).slice(-7)
      rec.push({ at: Date.now(), type: usedType, text: String(out).slice(0, 60) })
      // 10-27：计数按**今天**算。老代码只把"跨天清零"写在内存变量里（`st = {...}`），
      // 落盘时又 `readProact()` 拿回昨天的 count 再加一 —— 于是 qq-proactive.json 是 73，
      // 而记忆里今天只有 32 条推送。现在同一天才算累加。
      const countToday = (st2.day === dayKeyNow() ? Number(st2.count ?? 0) : 0) + 1
      writeProact({ day: dayKeyNow(), count: countToday, lastAt: Date.now(), lastType: usedType, recent: rec })
      log(`[qq] 🐟 主动搭话（${usedType}）：${out.slice(0, 50)}`)
    } catch (e) { logErr('[qq] 主动搭话失败：' + e.message) }
  }
  // [beat] setInterval(tryProactive, 60_000) -> self.decide() 决定 social 时才动

  // ── 承诺执行器单独跑（10-28）────────────────────────────────────────
  // 和"主动搭话"彻底解耦：到点就做，不需要先开口、不需要掷骰子、不占搭话日额。
  // 启动 25 秒后先补做一次 —— 机器睡了一夜的话，这一下就把昨晚欠的活补上。
  setTimeout(() => { void runDuePromises('醒来补做') }, 25_000)
  // [beat] runDuePromises -> vitals.promises
  // ── 脑的心跳（v3 S1）──────────────────────────────────────────────
  // 60 秒一次：消费 inbox、意图 catchUp（补做昨天没做的）、报告该不该巩固。
  // 巩固要调 LLM，**不在这个进程里做** —— spawn 一个子进程，别把事件循环钉住
  // （douyin-dm-server.mjs:32 那条注释就是上一次的教训：execFileSync 钉了 40~180 秒）。
  let brainConsolidating = false
  try { brain.configure(config()) } catch {}
  // [beat] 脑编排事务（消费 inbox / 意图补做 / 巩固判断）已移入 body.mjs
  // [beat] 脑编排事务：消费 inbox / 意图补做 / 判断该不该巩固。
  // 巩固要调 LLM，绝不在这里做 —— spawn 子进程，别钉事件循环
  // （douyin-dm-server.mjs:32 那条注释是上一次的教训：execFileSync 钉了 40~180 秒）。
  const brainTick = () => {
    try {
      const t = brain.tick()
      if (t.catchUp?.missed?.length) log(`[qq] 🧠 ${t.catchUp.missed.length} 件答应过的事彻底错过了`)
      if (brainConsolidating) return
      // 睡眠判定已交给 heartbeat/self.decide()，这里不再自己判断要不要睡
    } catch (e) { swallow(e, 'qq:brainTick') }
  }


  // ── 身体/工具协议（11-01）：脑出任务，这里认领并异步执行 ──────────────────
  // 铁律：kind 必须白名单、args 必须是数组逐项透传（绝不拼 shell）；执行结果回写 task-log
  // 并作为一条 action 事件进脑 —— "做了但没留痕"等于没做。
  let taskBusy = false
  async function pollTasks() {
    if (taskBusy) return
    const cfgTask = config().brain?.task || {}
    if (cfgTask.enabled === false) return
    taskBusy = true
    try {
      const maxN = Math.max(1, Number(cfgTask.maxPerTick) || 1)
      for (let i = 0; i < maxN; i++) {
        const c = brain.taskqueue.claim(`qq-server:${process.pid}`)
        if (!c.ok) break
        const task = c.task
        const argv = brain.taskqueue.argvOf(task)
        if (!argv) {
          brain.taskqueue.complete(task.id, { ok: false, error: 'unknown-kind' })
          continue
        }
        log(`[qq] 🧰 认领任务 ${task.id}：${argv.join(' ')}`)
        let out = ''
        let ok = false
        try {
          out = await runCliAsync(argv, Number(task.ttlMs) || 30 * 60_000)
          ok = true
        } catch (e) {
          out = String(e?.message || e)
        }
        brain.taskqueue.complete(task.id, { ok, result: String(out).slice(-1200), error: ok ? '' : String(out).slice(-300) })
        try {
          brain.onEvent({
            proc: 'qq-server', platform: 'tools', chatId: 'tools', userId: 'self', role: 'assistant',
            text: `[任务 ${task.kind} ${ok ? '做完了' : '没做成'}] ${String(task.note || '').slice(0, 80)}`,
            act: 'action',
          })
        } catch {}
      }
    } catch (e) { logErr('[qq] 任务轮询异常：' + (e?.message ?? e)) }
    finally { taskBusy = false }
  }
  if ((config().brain?.task?.enabled ?? true) !== false) {
    // [beat] pollTasks interval -> heartbeat vitals.tasks
    setTimeout(() => { void pollTasks() }, 8_000)
  }

  // ── 群聊自主插话引擎（10-25）：不等 @，她看着群聊气氛自己决定要不要接话 ──────────
  // 原则：话题在场才开口（recentSec 内有人说话）+ 不抢话（minQuietSec）+ 概率 + 每群日额。
  // 开口前 LLM 看最近群聊自己判断适不适合说话 —— 没话找话宁可不说。
  const GC_FILE = dataPath('qq-groupchat.json')
  const groupLastMsgAt = {}   // gid -> 最近一条群消息时间（内存，重启归零无妨）
  function readJsonSafe(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
  function writeJsonSafe(f, v) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) } catch {} }
  let groupSpeak = readJsonSafe(GC_FILE, {})  // gid -> {day, count, lastAt}
  const writeGC = () => writeJsonSafe(GC_FILE, groupSpeak)

  async function tryGroupChat() {
    try {
      const QQ = config().qq ?? {}
      const gc = QQ.groupChat ?? {}
      if (gc.enabled !== true) return
      // 统一规划：在专心做事时不主动插群嘴
      if (config().mind?.respectBusy !== false) {
        try {
          const M = await import('../lib/mind.mjs')
          const b = M.busy()
          if (b.busy && b.activity && b.activity !== 'rest' && b.activity !== 'free') return
        } catch {}
      }
      if (config().guard?.dryRun) return   // 干跑：群插话也不真发（10-25 统一闸门）
      const now = Date.now()
      const day = new Date().toLocaleDateString('sv-SE')
      const dailyMax = Number(gc.dailyMax ?? 6)
      for (const [gid, lastMsgAt] of Object.entries(groupLastMsgAt)) {
        const g = groupSpeak[gid] || { day, count: 0, lastAt: 0 }
        if (g.day !== day) { g.day = day; g.count = 0 }
        if (dailyMax > 0 && Number(g.count) >= dailyMax) continue
        if (now - Number(g.lastAt) < Number(gc.minGapMin ?? 20) * 60_000) continue
        const sinceMsg = now - Number(lastMsgAt)
        if (sinceMsg > Number(gc.recentSec ?? 600) * 1000) continue     // 话题已经凉了
        if (sinceMsg < Number(gc.minQuietSec ?? 20) * 1000) continue    // 别人话音未落，不抢
        if (Math.random() > Number(gc.chance ?? 0.1)) continue
        const chatId = `qq:${gid}`
        const recent = memory.recent(chatId, Number(gc.recentN ?? 14))
        if (recent.length < 2) continue
        tickMood()
        // ⚠️ 10-26 修：这里原来**没传 isGroup** —— 等于她用"私聊人设"决定要不要在群里插话：
        // 身份行给群友发主人通行证、时间锚点报"主人最后一次说话"、也没有末尾事实块。
        // 群里自主开口必须和被动回话用同一套群聊装配。
        const built = buildMessages({ platform: 'qq', userText: '', chatId, userId: '', turnsToday: Number(g.count), isGroup: true })
        const msgs = [
          built[0],
          { role: 'user', content: '【群聊插话决策】下面是这个群最近的聊天记录。你自己决定：现在适不适合插一句话？'
            + '正聊到你懂的/能接梗/有问题没人答/你能补充，才开口；插不上就安静。像熟群里的群友随口接一句，一两句以内。'
            + '只输出 JSON：{"speak":true或false,"text":"要发的话"}\n\n最近群聊：\n'
            + recent.map((m) => (m.role === 'assistant' ? '我' : '群友') + '：' + String(m.content).slice(0, 60)).join('\n') },
        ]
        const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 200, purpose: 'chat' })
        const m = String(resp ?? '').match(/\{[\s\S]*\}/)
        if (!m) continue
        let j; try { j = JSON.parse(m[0]) } catch { continue }
        if (!j.speak || !String(j.text || '').trim()) continue
        let out = guard.clean(String(j.text), config())
        if (!out) continue
        // 群里插话也要过"别把主人叫给群友"这一关（10-26）：这条路径不经过主流程的拦截。
        if (addressesOwner(out)) {
          const fixed = out.replace(/(^|[，,。！!？?、\s])主人(?=$|[，,。！!？?、\s]|早|好|你|晚|再|睡|我|在)/g, '$1你')
            .replace(/(晚安|早安|早上好|谢谢|再见|你好)\s*主人/g, '$1你')
          log(`[qq] 群插话里叫了主人 → 就地改掉：「${out.slice(0, 24)}」→「${fixed.slice(0, 24)}」`)
          if (addressesOwner(fixed)) continue
          out = fixed
        }
        const verdict = guard.allow(chatId, out, config(), { checkDryRun: false })   // 间隔 + 复读去重（干跑已在上游拦）
        if (!verdict.ok) continue
        const ok = await send('send_group_msg', { group_id: Number(gid), message: [{ type: 'text', data: { text: out } }] })
      if (ok) await spokeDone('group')
        if (!ok) continue
        guard.commit(chatId, out)
        memory.remember('qq', chatId, config().identity?.name ?? 'dsh_bot', 'assistant', out, { isGroup: true })   // 推送即记忆
        groupSpeak[gid] = { day, count: Number(g.count) + 1, lastAt: now }
        writeGC()
        log(`[qq] 🗣️ 群${gid} 自主插话：${out.slice(0, 40)}`)
      }
    } catch (e) { logErr('[qq] 群聊插话失败：' + (e?.message ?? e)) }
  }
  // [beat] setInterval(tryGroupChat, 60_000) -> self.decide() 决定 social 时才动

  // ── 自主写说说引擎（10-25）：她自己的见闻+心情 → 攒着劲发一条 QQ 空间说说（可文配图）──
  // 内容从她的世界来（人设+世界块+情绪），图是她的鲸鱼娘图生图 —— 说说像她，不像模板。
  const QZ_FILE = dataPath('qq-qzone.json')
  async function tryQzone() {
    try {
      const QQ = config().qq ?? {}
      const auto = QQ.qzoneAuto ?? {}
      if (QQ.qzone_enabled === false || auto.enabled !== true) return
      if (config().guard?.dryRun) return   // 干跑：空间说说也不真发（10-25 统一闸门）
      const now = Date.now()
      const day = new Date().toLocaleDateString('sv-SE')
      const st = readJsonSafe(QZ_FILE, { day: '', count: 0, lastAt: 0 })
      if (st.day !== day) { st.day = day; st.count = 0 }
      const dailyMax = Number(auto.dailyMax ?? 2)
      if (dailyMax > 0 && Number(st.count) >= dailyMax) return
      if (now - Number(st.lastAt ?? 0) < Number(auto.minGapMin ?? 240) * 60_000) return
      if (Math.random() > Number(auto.chance ?? 0.15)) return
      tickMood()
      const built = buildMessages({ platform: 'qq', userText: '', chatId: 'qq:qzone-self', userId: String(config().owner?.qq || ''), turnsToday: Number(st.count) })
      const msgs = [
        built[0],
        { role: 'user', content: '【发说说】现在以你的名义发一条 QQ 空间说说。基于你最近在外面看到的/今天的心情/最近琢磨的小念头，随手一条：'
          + '60~120 字，口语、真实、像发朋友圈，不要话题标签不要 @ 不要称呼主人。可以就是一句碎碎念，也可以带一点小情绪。只输出说说正文。' },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 300, purpose: 'deep' })
      const text = guard.clean(String(resp ?? ''), config())
      if (!text || text.length < 8) return
      // 配图：按概率画一张贴题的鲸鱼娘表情包（图生图）
      let images = null
      try {
        if (Math.random() < Number(auto.imageChance ?? 0.5)) {
          const caption = String(text).replace(/[，。！？…~～\s]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 2).join(' ').slice(0, 12) || '今天的心情'
          const { generateStickerImage } = await import('../lib/imggen.mjs')
          const img = await generateStickerImage(caption, {})
          if (img) images = [(await import('../lib/onebot-file.mjs')).onebotFileValue(img)]
        }
      } catch {}
      const NAPCAT = (QQ.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
      const post = async (body) => fetch(`${NAPCAT}/send_qzone_msg`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      })
      let r = await post(images ? { content: text, images, ugc_right: 1 } : { content: text, ugc_right: 1 })
      let j = null; try { j = await r.json() } catch {}
      if ((!r.ok || j?.status === 'failed') && images) {
        log(`[qzone] 配图说说没成（${JSON.stringify(j ?? r.status).slice(0, 80)}），退回纯文字`)
        r = await post({ content: text, ugc_right: 1 })
        j = null; try { j = await r.json() } catch {}
        images = null
      }
      if (!r.ok || j?.status === 'failed') { log(`[qzone] 说说失败：${JSON.stringify(j ?? r.status).slice(0, 120)}`); return }
      st.count = Number(st.count) + 1; st.lastAt = now
      writeJsonSafe(QZ_FILE, st)
      memory.remember('qq', 'qq:qzone-self', config().identity?.name ?? 'dsh_bot', 'assistant', `（发了说说：${String(text).slice(0, 60)}${images ? ' [配图]' : ''}）`)
      log(`[qzone] ✍️ 说说已发布${images ? '（配图）' : ''}：${String(text).slice(0, 40)}`)
    } catch (e) { logErr('[qzone] 自主说说失败：' + (e?.message ?? e)) }
  }
  // [beat] tryQzone -> vitals.qzone
  // 2026-11-02 绑心跳：节拍与决策在 body.mjs + heartbeat.mjs，不属于任何 IM 通道
  try {
    const { bindBody } = await import('../lib/body.mjs')
    const st = await bindBody({
      spawn, log, logErr, checkNapcat, pollTasks, runDuePromises, warmQuoteIndex,
      tryQzone, tryProactive, tryGroupChat, brainTick,
      isBusy: () => brainConsolidating, setBusy: (v) => { brainConsolidating = !!v },
      botPath: () => path.join(FEiyuRoot(), 'tools', 'bot.mjs'),
      queued: () => { try { return Number(CHANNEL.snapshot()?.queuedTotal || 0) } catch { return 0 } },
    })
    log('[beat] ' + JSON.stringify(st))
  } catch (e) { logErr('[beat] 心跳绑定失败：' + (e?.message ?? e)) }
}
