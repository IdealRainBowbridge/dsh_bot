// dsh-bridge —— 把 dsh_bot 的**全套能力**接到 DSH 会话里（2026-11-04）。
//
// ══════════════════════════════════════════════════════════════════════
// 要解决的问题
// ══════════════════════════════════════════════════════════════════════
// dsh_bot 以前只是一个"寄生在 DSH 上的 QQ/微信机器人"：
//   她的记忆、日记、承诺账本、B站账号、看番、上网、表情包、唱歌 —— 全部只对 QQ 开放。
// 于是同一个"她"，在 DSH 网页里只是一个会读写文件的编码 agent（人格靠 prompt 硬拽），
// 这些能力一个都够不着：她在网页里想"去看看我昨天写的东西"，只能靠 shell 拼命令。
//
// 这个文件把那条边界拆掉：**DSH 会话里的她，和 QQ 里的她，用的是同一套手脚**。
//
// ══════════════════════════════════════════════════════════════════════
// 为什么用「裸定义」注册工具，而不是 import defineTool
// ══════════════════════════════════════════════════════════════════════
// 实测（容器内）：从宿主插件目录（如 ~/.dsh/plugins/dsh_bot）出发 `import('@deepseek-ai/dsh-tools')`
// 直接 ERR_MODULE_NOT_FOUND —— 插件的 node_modules 链里没有宿主包。另外两条路都不该走：
//   · 让 entry.sh 给插件目录建 node_modules 软链：把「DSH 内部包」变成插件的运行前提，
//     宿主升级/换镜像就炸，而且那正是 dsh-bridge 那种补丁的存在理由；
//   · 自己实现 defineTool：只是把宿主的校验重写一遍，两边会漂移。
// 宿主 registry 真正要求的只有三件：`{ name, description, parameters, output: { schema, render }, execute }`，
// 其中 parameters/output.schema 必须是**宿主支持的原始 JSON Schema 子集**
// （type/oneOf/properties/required/additionalProperties/items/enum/const + annotations）。
// 所以这里直接写定义对象，零裸包依赖 —— 插件能装，这个桥就能用。
//
// ══════════════════════════════════════════════════════════════════════
// 两层能力，各有各的理由
// ══════════════════════════════════════════════════════════════════════
// ① **进程内**（快，无启动开销，结构化返回）：记忆 / 情绪 / focus / 承诺 / 日记 / 给她发 QQ。
//    这些是 tools/lib/*.mjs 里的纯函数，插件进程里直接能 import。
// ② **子进程**（慢但全）：B站、看番、上网、表情、唱歌、脑——那些是 tools/commands/*.mjs，
//    每个都是一次性 CLI（有自己的锁、自己的配额、自己的超时）。它们的接口本来就设计成
//    "命令行即 API"（bot.mjs 的 COMMANDS 是唯一权威），这里**不复制**这份清单，
//    而是启动时从 bot.mjs 解析出命令名做白名单 —— 她新增命令，桥自动认得。
//
// ⚠️ 不做的事：
//   · 不把 49 个命令各包一个 tool（上下文会被 schema 撑爆，模型也会挑错）。
//     只给一个 `bot_act`，`command` 是 enum，`args` 是字符串数组 —— 与真实用法同形。
//   · 不自动把所有会话记录无脑灌进记忆库（会把她自己的调试话术变成"经历"）。
//     只收 user/assistant 的正文块，且避开 runtime-context/snapshot 那些宿主注入。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import * as memory from '../tools/lib/memory.mjs'
import * as mood from '../tools/lib/mood.mjs'
import * as promises from '../tools/lib/promises.mjs'
import { readFocus, focusSnapshot, labelOf } from '../tools/lib/focus.mjs'
import { readBrief } from '../tools/lib/ledger.mjs'
import { diaryPath, dataPath, WORK_DIR } from '../tools/lib/paths.mjs'
import { sendOwnerQQ } from '../tools/lib/notify.mjs'
import { config } from '../tools/lib/config.mjs'
import { swallow } from '../tools/lib/swallow.mjs'
import { registerTakeover, attachAssembleHook } from './agent-prompt.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.join(HERE, '..')
const BOT_MJS = path.join(PLUGIN_ROOT, 'tools', 'bot.mjs')

/** DSH 会话在记忆库里的平台名（与 qq/wechat 并列，不混进它们的窗口）。 */
export const DSH_PLATFORM = 'dsh'

/** 工具名前缀：模型看到的是 bot_*，一眼知道这是"她自己的手"。 */
const PREFIX = 'bot_'

/** 单次 CLI 调用上限（毫秒）。B站投稿/剪片子最慢，给 180s；其余远用不到。 */
const CLI_TIMEOUT = 180_000
/** 回灌给模型的正文上限（字符）。超出截断并标注，避免一条命令吃满上下文。 */
const CLI_MAX_OUT = 8000

/**
 * 从 bot.mjs 的 COMMANDS 字面量里取命令名（与门禁 checkCommandRegistry 同一手法）。
 *
 * 为什么不写死一份清单：那份清单一定会在某次新增命令后过期，而"过期"的表现是
 * 她调 bridge 报"未知命令"，看起来像桥坏了 —— 实际只是清单没跟上。
 * 解析失败时用 COMMAND_FALLBACK（保守子集），并让 /api/status 看得见 degraded。
 * @returns {{names: string[], source: 'parsed'|'fallback'}}
 */
export function listBotCommands() {
  try {
    const src = fs.readFileSync(BOT_MJS, 'utf8')
    const start = src.indexOf('const COMMANDS')
    if (start < 0) return { names: [...COMMAND_FALLBACK], source: 'fallback' }
    let i = src.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let k = i; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    if (end < 0) return { names: [...COMMAND_FALLBACK], source: 'fallback' }
    const body = src.slice(i, end)
    const names = [...new Set([...body.matchAll(/^\s{2}(['"]?)([a-z][a-z0-9-]{1,30})\1\s*:/gm)].map((m) => m[2]))]
    if (!names.length) return { names: [...COMMAND_FALLBACK], source: 'fallback' }
    return { names, source: 'parsed' }
  } catch {
    // 解析失败不抛：桥的可用性不该被一个正则打挂 —— 退回保守子集并在 status 里标 fallback
    return { names: [...COMMAND_FALLBACK], source: 'fallback' }
  }
}

/**
 * 解析失败时的保守子集 —— 只放确定存在、且不会因为参数缺失而误伤的命令。
 * 刻意**不含** selfmod / selfup / config-upgrade（写自己）：解析成功时它们自动可用，
 * 解析失败时宁可少一只手，也不要盲改自己。
 */
export const COMMAND_FALLBACK = [
  'mem', 'diary', 'status', 'mind', 'focus', 'promises', 'ledger', 'quota', 'brain',
  'feed', 'debrief', 'binge', 'web', 'browser', 'wander', 'dream', 'sleep', 'sticker',
  'avatar', 'report', 'review', 'social', 'roster', 'roster', 'selfwake', 'selfcon',
]

/** 不允许通过桥调用的命令（交互式常驻进程：会在 DSH 进程里留下一个永不退出的子进程）。 */
const CLI_DENY = new Set(['qq-server', 'selftest', 'diagnose', 'config-upgrade'])

/**
 * 跑一次 bot.mjs 子进程。
 *
 * 三个必须的防护（都是踩过的）：
 *   ① timeout —— spawn 没有超时 = DSH 进程被钉死（门禁第 10 条同理）；
 *   ② killSignal —— SIGKILL，SIGTERM 对 ffmpeg/python 子链不够；
 *   ③ maxBuffer —— 她的命令会打印成百上千行（feed/brain doctor），默认 1MB 会被截断报错。
 * @param {string[]} argv 形如 ['mem','grep','番剧']
 * @returns {Promise<{ok: boolean, out: string, code: number}>}
 */
export function runBotCli(argv = []) {
  return new Promise((resolve) => {
    const args = [BOT_MJS, ...argv.map((a) => String(a))]
    execFile(process.execPath, args, {
      cwd: WORK_DIR,
      timeout: CLI_TIMEOUT,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, BOT_NO_COLOR: '1' },
    }, (err, stdout, stderr) => {
      const out = String(stdout || '') + (String(stderr || '').trim() ? '\n[stderr] ' + String(stderr).trim() : '')
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      const trimmed = out.trim()
      const text = trimmed.length > CLI_MAX_OUT
        ? trimmed.slice(0, CLI_MAX_OUT) + `\n…（还有 ${trimmed.length - CLI_MAX_OUT} 字，命令 ${argv.join(' ')}）`
        : trimmed
      resolve({ ok: code === 0, out: text || '（命令没有输出）', code })
    })
  })
}

// ── 参数校验（必须自己做，原因是实测出来的）─────────────────────────────────
// 宿主 `ctx.tools.register()` **只校验 output.schema，不校验 arguments**
// （实测：注册后传 `{ what: 'nonsense' }` 仍会进 execute —— 参数校验只存在于
//  `defineTool()` 烘进闭包的那一层，而我们走的是裸定义路线）。
// 后果不是尖叫声，而是**静默降级**：模型给个拼错的枚举值，execute 落进 else 分支，
// 返回一段看似正常的空结果，模型据此以为"她状态是空的"。
//
// 所以这里补上宿主支持子集的校验（type/required/additionalProperties/items/enum/const），
// 违反就 throw —— 宿主会把异常变成模型可见的 error result，模型能据此自我纠正。
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']

/**
 * 按原始 JSON Schema 子集校验一个值，返回违规列表（空 = 通过）。
 * 只实现本文件用到的关键字；遇到未知关键字直接报"不支持"，避免自以为在校验。
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function validateArgs(schema, value, path = 'arguments') {
  const out = []
  const walk = (node, v, p) => {
    if (!node || typeof node !== 'object') { out.push(`${p} 的 schema 不是对象`); return }
    if (Object.hasOwn(node, 'enum') && !node.enum.includes(v)) {
      out.push(`${p} 必须是 ${JSON.stringify(node.enum)} 之一（收到 ${JSON.stringify(v)}）`)
      return
    }
    if (Object.hasOwn(node, 'const') && v !== node.const) {
      out.push(`${p} 必须等于 ${JSON.stringify(node.const)}`)
      return
    }
    const t = node.type
    if (!t) return
    if (t === 'object') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) { out.push(`${p} 必须是对象`); return }
      const props = node.properties || {}
      for (const key of node.required || []) {
        if (!Object.hasOwn(v, key)) out.push(`${p}.${key} 是必填的`)
      }
      for (const [key, val] of Object.entries(v)) {
        if (Object.hasOwn(props, key)) walk(props[key], val, `${p}.${key}`)
        else if (node.additionalProperties === false) out.push(`${p}.${key} 不被接受（只允许 ${Object.keys(props).join('/')}）`)
      }
      return
    }
    if (t === 'array') {
      if (!Array.isArray(v)) { out.push(`${p} 必须是数组`); return }
      if (node.items) v.forEach((item, i) => walk(node.items, item, `${p}[${i}]`))
      return
    }
    if (!SCALARS.includes(t)) { out.push(`${p} 的 schema 类型 ${t} 未实现`); return }
    const got = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
    const okType = t === 'integer' ? (typeof v === 'number' && Number.isInteger(v))
      : t === 'number' ? (typeof v === 'number' && Number.isFinite(v))
        : got === t
    if (!okType) out.push(`${p} 必须是 ${t}（收到 ${got}）`)
  }
  walk(schema, value, path)
  return out
}

/** 校验不过就 throw（宿主会把它变成模型可见的 error result）。 */
function assertArgs(schema, args) {
  const v = validateArgs(schema, args ?? {})
  if (v.length) throw new Error('参数不合法：' + v.slice(0, 4).join('；'))
}

// ── 工具定义 ───────────────────────────────────────────────────────────────

/**
 * 一个 DSH 工具定义（宿主 registry 的裸形状）。
 * @param {object} spec
 * @returns {object}
 */
function tool(spec) {
  const raw = spec.execute
  return {
    name: PREFIX + spec.name,
    description: spec.description,
    // 原始 JSON Schema 子集：只允许 type/properties/required/additionalProperties/items/enum/const
    parameters: spec.parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    ...spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {},
    // 记忆/状态类只读或幂等，可以并行；CLI 一律独占（同一个锁/同一份配额）。
    ...spec.concurrencySafe ? { isConcurrencySafe: () => true } : {},
    // 包一层：宿主不会替我们校验 arguments（裸注册路线），见 validateArgs 的说明。
    execute: (args, exec) => {
      assertArgs(spec.parameters, args)
      return raw(args ?? {}, exec)
    },
  }
}

/** 归一化一段文本（工具返回值必须是 JSON 安全对象）。 */
const asText = (text) => ({ text: String(text ?? '') })

/**
 * 构造全部工具定义。
 *
 * 拆成纯函数而不是写在 apply 里：这样测试可以不起 DSH、不连网，直接断言
 * 「工具名/参数 schema 合法/执行结果结构对」。工具的 execute 都是真实函数，
 * 测试会真跑（临时数据目录），而不是打桩 —— 打桩只能证明桩对。
 * @param {{cli?: {names: string[], source: string}}} [opts]
 * @returns {object[]}
 */
export function buildTools(opts = {}) {
  const cli = opts.cli || listBotCommands()
  const cliNames = cli.names.filter((n) => !CLI_DENY.has(n))

  return [
    tool({
      name: 'recall',
      timeoutMs: 20_000,
      concurrencySafe: true,
      description: '翻你自己的记忆：按关键词找旧事、按天翻流水、看关系事实、看记忆库大小。'
        + '想不起来某个人的事、某句话是谁说的、以前答应过什么，先用它查，别猜。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['search', 'recent', 'old', 'facts', 'stats'],
            description: 'search=按关键词全文找（默认）/ recent=最近的对话流 / old=随机想起一条 7 天前的旧事 / facts=关于管理员的长期事实 / stats=记忆库概况' },
          query: { type: 'string', description: 'search 模式的关键词（原话片段最好）' },
          days: { type: 'integer', description: '只看最近几天（0 = 不限）' },
          limit: { type: 'integer', description: '最多几条，默认 20' },
        },
      },
      async execute(args) {
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
        if (args.mode === 'search') {
          const rows = memory.grepEpisodes(String(args.query || ''), { days: Number(args.days) || 0, limit })
          if (!rows.length) return asText('（没有命中。换个说法再试，或者用 recent 看流水。）')
          return asText(rows.map((r) => {
            const t = new Date(Number(r.ts) || 0).toLocaleString('sv-SE', { hour12: false })
            return `${t} [${r.platform}] ${r.role === 'user' ? '他' : '我'}：${r.text}`
          }).join('\n'))
        }
        if (args.mode === 'recent') {
          const rows = memory.recent('', limit)
          if (!rows.length) return asText('（最近的记录是空的）')
          return asText(rows.map((r) => {
            const t = new Date(Number(r.at) || 0).toLocaleTimeString('sv-SE', { hour12: false })
            return `${t} ${r.role === 'user' ? '他' : '我'}：${String(r.content).slice(0, 200)}`
          }).join('\n'))
        }
        if (args.mode === 'old') {
          const old = memory.randomOld(7)
          return asText(old.length ? old.join('\n') : '（还没有 7 天以上的旧事）')
        }
        if (args.mode === 'facts') {
          const fs2 = memory.facts('owner', limit)
          return asText(fs2.length ? fs2.map((f) => '· ' + f).join('\n') : '（关于管理员的长期事实还是空的）')
        }
        const s = memory.stats()
        return asText('记忆库：' + JSON.stringify(s))
      },
    }),

    tool({
      name: 'remember',
      timeoutMs: 20_000,
      description: '往你自己的记忆里记一条：发生过的事（情节）、关于谁的一件长期事实、或世界设定。'
        + '只在真的值得记住时用，不要记闲聊和调试话术。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: ['episode', 'fact', 'lore'], description: 'episode=事件/对话 / fact=关于某个人的长期事实 / lore=世界设定与名场面' },
          text: { type: 'string', description: '一句完整的话' },
          user: { type: 'string', description: 'fact 模式的归属，默认 owner（管理员）' },
          tag: { type: 'string', description: 'lore 模式的分类，默认 misc' },
        },
      },
      async execute(args) {
        const text = String(args.text || '').trim()
        if (!text) throw new Error('没写内容，记不了')
        if (args.kind === 'fact') {
          memory.addFact(String(args.user || 'owner'), text)
          return asText('记进关系事实了：' + text)
        }
        if (args.kind === 'lore') {
          memory.addLore(String(args.tag || 'misc'), text)
          return asText('记进世界设定了：' + text)
        }
        const rec = memory.remember(DSH_PLATFORM, 'dsh:console', 'owner', 'assistant', text)
        if (!rec) return asText('这条没记进去（被判成自测话术，或者写盘失败）。')
        return asText('记进情节了：' + text)
      },
    }),

    tool({
      name: 'state',
      timeoutMs: 20_000,
      concurrencySafe: true,
      description: '看你此刻的状态：情绪、在做什么、脑子里的计划、欠着谁的事、今天的饭钱、睡没睡。'
        + '回答"你现在在干嘛""心情怎么样""还欠我什么"这类问题之前先看这里，不要凭印象编。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['what'],
        properties: {
          what: { type: 'string', enum: ['all', 'mood', 'focus', 'promises', 'ledger', 'mind'],
            description: 'all=全部（默认）/ mood=情绪 / focus=此刻在做什么 / promises=承诺账本 / ledger=今天的账 / mind=自主计划' },
        },
      },
      async execute(args) {
        const parts = []
        const want = args.what || 'all'
        const wantAll = want === 'all'
        if (wantAll || want === 'mood') {
          try {
            const m = mood.mood()
            parts.push(`情绪：${Math.round(Number(m.value) || 0)}/100 · 饥饿 ${Math.round(Number(m.hunger) || 0)}/100`)
          } catch (e) { parts.push('情绪：读不到（' + String(e?.message ?? e) + '）') }
        }
        if (wantAll || want === 'focus') {
          try {
            const f = focusSnapshot(Date.now())
            parts.push(f.activity && !f.expired
              ? `此刻：${f.label}${f.remainMin ? `（还剩 ${f.remainMin} 分钟）` : ''}${f.note ? ' —— ' + f.note : ''}`
              : `此刻：${labelOf(readFocus()?.activity) || '没在做什么具体的'}`)
          } catch (e) { parts.push('此刻：读不到') }
        }
        if (wantAll || want === 'promises') {
          try {
            const due = promises.dueNow()
            const open = promises.list('open')
            const lines = []
            if (due.length) lines.push('到点该做的：' + due.map((x) => x.what).join('；'))
            if (open.length) lines.push('还欠着：' + open.slice(-5).map((x) => x.what).join('；'))
            parts.push(lines.length ? lines.join('\n') : '承诺账本：空的（没有欠着的事）')
          } catch (e) { parts.push('承诺账本：读不到') }
        }
        if (wantAll || want === 'ledger') {
          try {
            const b = readBrief()
            parts.push(b?.line ? '账：' + b.line : '账：还没有今天的数字')
          } catch (e) { parts.push('账：读不到') }
        }
        if (wantAll || want === 'mind') {
          try {
            const m = await import('../tools/lib/mind.mjs')
            const line = m.planLine(Date.now())
            parts.push(line || '自主计划：现在没有计划（自由时间）')
          } catch (e) { parts.push('自主计划：读不到') }
        }
        return asText(parts.join('\n'))
      },
    }),

    tool({
      name: 'diary',
      timeoutMs: 20_000,
      description: '你的两本日记：给管理员看的那本（有细节有情绪）、你自己那本（不加滤镜）。'
        + '可以读，也可以写 —— 写就是 append 一段，不要重写整篇。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['book', 'action'],
        properties: {
          book: { type: 'string', enum: ['owner', 'private'], description: 'owner=给管理员的 / private=你自己的' },
          action: { type: 'string', enum: ['read', 'append'], description: 'read=读最近的内容 / append=写一段' },
          text: { type: 'string', description: 'append 时的正文' },
          tail: { type: 'integer', description: 'read 时读最后多少行，默认 60' },
        },
      },
      async execute(args) {
        const book = args.book === 'private' ? 'private' : 'owner'
        const file = diaryPath(book)
        if (args.action === 'append') {
          const text = String(args.text || '').trim()
          if (!text) throw new Error('要写什么？text 不能为空')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          const head = fs.existsSync(file) ? '' : `# ${book === 'private' ? '她自己的日记（不加滤镜）' : '给用户的信（有细节有情绪）'}\n\n`
          const stamp = new Date().toLocaleString('sv-SE', { hour12: false })
          fs.appendFileSync(file, `${head}## ${stamp}\n\n${text}\n\n`)
          return asText(`写进${book === 'private' ? '你自己那本' : '给管理员那本'}了：${file}`)
        }
        if (!fs.existsSync(file)) return asText('（这本日记还是空的）')
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
        const tail = Math.max(1, Math.min(400, Number(args.tail) || 60))
        return asText(lines.slice(-tail).join('\n'))
      },
    }),

    tool({
      name: 'tell_owner',
      timeoutMs: 30_000,
      description: '用 QQ 给管理员发一条消息（走你自己的 QQ 通道，发出去会记进你的记忆）。'
        + '只有真的需要他立刻知道、或者你就是想找他的时候才用 —— 闲聊的回复直接在这里说就行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: '要发的正文（纯文本，不超过 500 字）' },
        },
      },
      async execute(args) {
        const text = String(args.text || '').trim()
        if (!text) throw new Error('要发什么？text 不能为空')
        const cfg = config()
        if (!cfg.owner?.qq) throw new Error('owner.qq 没配，发不出去（先在面板里填管理员的 QQ 号）')
        const r = await sendOwnerQQ(text.slice(0, 500))
        if (r === false) return asText('没发出去（可能在干跑模式 guard.dryRun，或者 NapCat 不在线）。')
        if (r && r.deduped) return asText('这条刚刚已经在别的窗口发过了，这次跳过（避免重复打扰）。')
        return asText('发出去了。')
      },
    }),

    tool({
      name: 'act',
      timeoutMs: CLI_TIMEOUT + 5_000,
      description: '用你自己的命令行能力做事：刷B站、看番、上网搜索/读网页、看视频、发表情、唱歌、管脑、睡觉……'
        + '也就是 `node bot.mjs <command>` 的每一项。'
        + '不确定有哪些命令时，先 act({command:"help"}) 看清单。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string', enum: ['help', ...cliNames],
            description: '命令名（就是 bot.mjs 里注册的那些之一）' },
          args: { type: 'array', items: { type: 'string' },
            description: '参数数组，例如 ["--search","番名"] 或 ["--book","owner","--show"]' },
        },
      },
      async execute(args) {
        const cmd = String(args.command || '').trim()
        if (cmd === 'help') {
          const r = await runBotCli([])
          return asText(r.out)
        }
        if (CLI_DENY.has(cmd)) throw new Error(`"${cmd}" 是常驻进程/自检类命令，不能从会话里拉起（会把 DSH 拖住）。`)
        if (!cliNames.includes(cmd)) {
          throw new Error(`没有 "${cmd}" 这个命令。可用：${cliNames.join(' / ')}`)
        }
        const argv = [cmd, ...(Array.isArray(args.args) ? args.args.map(String) : [])]
        const r = await runBotCli(argv)
        return asText((r.ok ? '' : `（命令退出码 ${r.code}）\n`) + r.out)
      },
    }),
  ]
}

/**
 * 把 DSH 会话流接进她的记忆。
 *
 * 为什么值得做：她在网页里跟管理员说的话、写下的东西，如果不进记忆库，
 * QQ 那边问起"你今天在网页里干嘛了"她完全不知道 —— 那正是"两个她"的病根。
 *
 * 只收两类事件，且都要过筛：
 *   · `user/message` 且 `source.kind === 'user'`（真人输入的；runtime-context/snapshot 是宿主注入，不收）
 *   · `assistant/message`（她自己的回复）
 * 只取 text 块，丢掉 image/tool-call 等；单条超过 2000 字截断（她的长篇输出不必整段进库）。
 *
 * @param {object} ctx Cordis 上下文
 * @param {{onError?: Function}} [opts]
 * @returns {{dispose: Function, seen: number, stored: number}} 诊断句柄（seen 只用于日志）
 */
export function attachSessionMemory(ctx, opts = {}) {
  const onError = opts.onError || (() => {})
  const state = { seen: 0, stored: 0 }
  const textOf = (content) => (Array.isArray(content) ? content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()

  const record = (sessionId, role, text) => {
    if (!text) return
    try {
      const rec = memory.remember(DSH_PLATFORM, 'dsh:' + String(sessionId || 'unknown'), 'owner', role, text.slice(0, 2000))
      if (rec) state.stored++
    } catch (e) { onError(e, 'bridge:session-memory') }
  }

  let dispose = () => {}
  try {
    dispose = ctx.on('session/event', (session, event) => {
      try {
        if (!event || typeof event.type !== 'string') return
        state.seen++
        const data = event.data
        if (event.type === 'user/message') {
          // source.kind: 'user' 才是真人输入；'runtime-context' 是宿主每步注入的现状快照，
          // 'agent-instructions'/'compact-checkpoint' 都是系统自己的东西 —— 全都不收。
          const kind = data?.source?.kind
          if (kind !== 'user') return
          record(session?.id, 'user', textOf(data?.content))
          return
        }
        if (event.type === 'assistant/message') {
          record(session?.id, 'assistant', textOf(data?.message?.content))
        }
      } catch (e) { onError(e, 'bridge:session-event') }
    })
  } catch (e) {
    onError(e, 'bridge:attach-session-memory')
  }
  return { dispose, state }
}

/**
 * 把桥挂到 DSH 上 —— 插件壳只调这一个函数。
 *
 * 缺 `ctx.tools` 时**不报错**：那说明这个 DSH 部署没装工具运行时（或者被降级），
 * 人格接管与 QQ 通道依然要工作。返回 registered=false，status 里能看到原因。
 * @param {object} ctx
 * @param {{onError?: Function}} [opts]
 * @returns {{registered: boolean, reason: string, tools: string[], cli: {names: number, source: string}, memory: {attached: boolean, state: object|null}}}
 */
export function registerBridge(ctx, opts = {}) {
  const onError = opts.onError || (() => {})
  const out = {
    registered: false,
    reason: '',
    tools: [],
    cli: { names: 0, source: 'none' },
    memory: { attached: false, state: null },
  }

  // ── ① 工具 ──────────────────────────────────────────────────────────────
  // ⚠️ 2026-11-04 深夜修正：本段旧注释声称 `ctx.get('tools', false)` 可免 inject 读服务 —— 不成立。
  //    cordis 的 get 第二参不是这个语义，未声明 inject 时照样抛
  //    「cannot get property "tools" without inject」（实测，容器内 0.2.1-rc.2）。
  //    正确做法：由 attachIdentity() 用 ctx.inject(['tools'], sub => registerBridge(sub)) 进来，
  //    这里的 ctx 已经是**注入了 tools 的子上下文**，直接用即可，不需要再 get。
  //    之所以不把 `tools` 写进插件顶层 inject：inject 里的服务缺失时整个插件 fiber
  //    保持 INACTIVE（连人格接管一起不加载），在没装工具运行时的部署上等于插件全废 ——
  //    这个顾虑本身是对的，解法是用子上下文 inject 而不是顶层 inject。
  // 2026-11-05 fix: split ctx.get and bare-prop access into separate try blocks;
  // a throw on ctx.tools was swallowing the ctx.get fallback (bridge-test 4 reds).
  const toolsSvc = (() => {
    try { return ctx?.get?.('tools') ?? null } catch { return null }
  })() ?? (() => {
    try { return ctx?.tools ?? null } catch { return null }
  })()
  try {
    if (typeof toolsSvc?.register !== 'function') {
      out.reason = 'no-tools-service'
    } else {
      const cli = listBotCommands()
      out.cli = { names: cli.names.length, source: cli.source }
      const defs = buildTools({ cli })
      const disposers = []
      for (const def of defs) {
        try {
          const d = toolsSvc.register(def)
          disposers.push(d)
          out.tools.push(def.name)
        } catch (e) {
          // 单个工具注册失败不该拖垮其余（最常见：同名工具已被别的插件占了）
          onError(e, 'bridge:register:' + def.name)
        }
      }
      if (disposers.length) {
        try {
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => { for (const d of disposers) { try { d() } catch (e) { swallow(e, 'bridge:dispose') } } }, 'dsh_bot.bridge')
          }
        } catch (e) { onError(e, 'bridge:effect') }
        out.registered = true
        out.reason = 'ok'
        console.log('[bot] 能力桥已接入：' + out.tools.join(' / ')
          + '（命令白名单 ' + cli.names.length + ' 项，来源 ' + cli.source + '）')
      } else {
        out.reason = 'all-registrations-failed'
      }
    }
  } catch (e) {
    onError(e, 'bridge:register')
    out.reason = 'register-error:' + String(e?.message ?? e).slice(0, 80)
    console.warn('[bot] 能力桥接入失败：' + String(e?.message ?? e))
  }

  // ── ② 会话记忆（与工具相互独立：工具挂了记忆照样要收）──────────────────
  try {
    const m = attachSessionMemory(ctx, { onError })
    out.memory.attached = true
    out.memory.state = m.state
  } catch (e) {
    onError(e, 'bridge:attach')
  }

  return out
}

/**
 * 挂上「她是谁」与「她会什么」这两件事，并判断壳该不该继续装（2026-11-04）。
 *
 * 为什么不是插件壳里三行 `ctx.inject(...)`：
 *   cordis 的 inject 是**全有或全无** —— 插件的 inject 里只要有一个服务缺失，
 *   整个 fiber 保持 pending。壳需要 sessionController/webServer/connection（QQ 通道与
 *   面板），而 headless/tui/acp profile 都没有这些服务。上一版把这些依赖写进插件的
 *   静态 inject，于是"装了插件"只在这些 profile 里等于"她不在"，而且没有任何报错。
 *
 * 现在拆成三个子插件，各自声明自己真正需要的服务：
 *   ① 人格接管 —— 只要 systemPrompt（任何 profile 都有）
 *   ② 能力桥   —— 只要 tools（大多数 profile 有）
 *   ③ 壳       —— 要三个 web 服务（缺了它就只是"没有面板"，不是"她不见了"）
 *
 * @param {object} ctx
 * @param {(e: unknown, tag: string) => void} onError
 * @returns {boolean} 壳是否该继续装配（false = 这个 profile 没有面板服务，人格与桥已就位）
 */
export function attachIdentity(ctx, onError = () => {}) {
  try {
    ctx.inject(['systemPrompt'], (sub) => {
      // 结果对象是同一个引用：registerTakeover 会异步把 verified/verifyReason 写回去
      globalThis.__dshBotTakeover = registerTakeover(sub, onError)
      // 装配层强制：穿透 agentPreset 的隔离作用域（preset 内看不见全局注册的段）。
      // 挂在**全局 ctx** 上（不是 sub），这样每个 agent 装配都会经过它。
      attachAssembleHook(ctx, onError)
    })
  } catch (e) { onError(e, 'identity:takeover') }
  try {
    ctx.inject(['tools'], (sub) => {
      globalThis.__dshBotBridge = registerBridge(sub, { onError })
    })
  } catch (e) { onError(e, 'identity:bridge') }
}
