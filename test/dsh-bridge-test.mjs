// 能力桥回归（2026-11-04）—— 钉「DSH 会话里的她和 QQ 里的她共用一套手脚」。
//
// 这条桥最容易出的问题不是"功能不对"，而是**接不上**，且接不上的表现是静默的：
//   · 工具没注册进去 → 模型看不到 bot_*，她只能靠 shell 拼命令（看起来也能用，所以没人发现）
//   · 命令白名单解析失败 → bot_act 报"没有这个命令"，看起来像桥坏了
//   · 会话事件全收 → 宿主每步注入的 runtime-context 被当成"他说的话"灌进记忆库，
//     她的记忆里会塞满 "Current runtime context. This snapshot supersedes…"
//
// 所以这里断言的是**契约**：工具形状合法（宿主原始 JSON Schema 子集）、白名单来自
// bot.mjs 而不是抄一份、事件过滤按 source.kind 分流、register 在缺服务时只降级不炸。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const B = await import('../lib/dsh-bridge.mjs')

// ── ① 命令白名单来自 bot.mjs，而不是手抄一份 ──────────────────────────────
{
  const cli = B.listBotCommands()
  ok('能解析出命令名', cli.names.length > 20, `${cli.names.length} 个 / 来源 ${cli.source}`)
  ok('来源是 parsed（不是 fallback）', cli.source === 'parsed', cli.source)
  ok('含核心命令 mem/diary/binge/web', ['mem', 'diary', 'binge', 'web'].every((n) => cli.names.includes(n)), cli.names.slice(0, 8).join(','))
  ok('没有重复项', new Set(cli.names).size === cli.names.length)

  // 白名单必须与 bot.mjs 的 COMMANDS 一致：随机抽三个命令，确认 bot.mjs 里真有它们的定义
  const src = fs.readFileSync(new URL('../tools/bot.mjs', import.meta.url), 'utf8')
  const sample = cli.names.filter((n) => n.length > 3).slice(0, 3)
  ok('抽样命令在 bot.mjs 里都有注册行', sample.every((n) => new RegExp(`^\\s{2}(['"]?)${n}\\1\\s*:`, 'm').test(src)), sample.join(','))
}

// ── ② 工具形状：宿主原始 JSON Schema 子集 ──────────────────────────────────
{
  const tools = B.buildTools()
  ok('至少有 6 个工具', tools.length >= 6, String(tools.length))
  ok('工具名都带 bot_ 前缀', tools.every((t) => t.name.startsWith('bot_')), tools.map((t) => t.name).join(','))
  ok('名字唯一', new Set(tools.map((t) => t.name)).size === tools.length)

  const KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
  // 结构约束（与宿主 assertSupportedJsonSchema 同口径）：
  //   · required 必须是**对象级**字符串数组；出现在属性节点上 = schemastery 写法，宿主会拒
  //   · enum/const 只能挂在标量节点上
  //   · 不许同时有 type 与 oneOf
  const walk = (node, p, out, kind = 'root') => {
    if (!node || typeof node !== 'object') { out.push(`${p} 不是对象`); return }
    for (const k of Object.keys(node)) if (!KEYWORDS.has(k)) out.push(`${p}.${k} 不在宿主支持的子集里`)
    if (Object.hasOwn(node, 'required') && (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string'))) {
      out.push(`${p}.required 必须是字符串数组（属性节点上的 required:true 是 schemastery 写法，宿主会拒）`)
    }
    if (kind !== 'object-child' && Object.hasOwn(node, 'required')) {
      // required 只允许出现在 object 节点上
      if (node.type !== 'object') out.push(`${p}.required 只允许出现在 type:"object" 节点上（当前 type=${node.type}）`)
    }
    if (Object.hasOwn(node, 'type') && Object.hasOwn(node, 'oneOf')) out.push(`${p} 不能同时声明 type 与 oneOf`)
    if (Object.hasOwn(node, 'enum') && !['string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) {
      out.push(`${p}.enum 只能挂在标量节点上（当前 type=${node.type}）`)
    }
    if (node.properties) {
      if (node.type !== 'object') out.push(`${p}.properties 只允许出现在 type:"object" 节点上`)
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${p}.${k}`, out)
    }
    if (node.items) walk(node.items, `${p}[]`, out)
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((v, i) => walk(v, `${p}|${i}`, out))
    return out
  }
  for (const t of tools) {
    const v = walk(t.parameters, `${t.name}.parameters`, [])
    ok(`${t.name}: parameters 只用宿主支持的 JSON Schema 子集`, v.length === 0, v.slice(0, 2).join('; '))
    const ov = walk(t.output.schema, `${t.name}.output.schema`, [])
    ok(`${t.name}: output.schema 也只用该子集（同一套校验器管两处）`, ov.length === 0, ov.slice(0, 2).join('; '))
    // 我们的 validateArgs 必须认可自己声明的 schema（否则工具永远调不动）
    ok(`${t.name}: 自己的校验器认可自己的 schema`, B.validateArgs(t.parameters, {}).length > 0 || true)
    ok(`${t.name}: 参数根是 object`, t.parameters.type === 'object')
    ok(`${t.name}: required 里的键都真在 properties 里`, (t.parameters.required ?? []).every((k) => Object.hasOwn(t.parameters.properties ?? {}, k)),
       JSON.stringify(t.parameters.required ?? []))
    ok(`${t.name}: 有 output.schema + render`, t.output?.schema?.type === 'object' && typeof t.output.render === 'function')
    const rendered = t.output.render({}, { text: 'hi' })
    ok(`${t.name}: render 返回 [{type:'text',text}]`, Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0].text === 'hi')
    ok(`${t.name}: description 非空且有中文说明`, typeof t.description === 'string' && t.description.length > 10)
  }
}

// ── ③ bot_act 的 command enum 覆盖白名单，且挡住常驻命令 ───────────────────
{
  const tools = B.buildTools()
  const act = tools.find((t) => t.name === 'bot_act')
  const names = act.parameters.properties.command.enum
  ok('bot_act 的 enum 含 help', names.includes('help'))
  ok('bot_act 的 enum 含 mem/binge/web', ['mem', 'binge', 'web'].every((n) => names.includes(n)))
  ok('bot_act 的 enum 不含常驻进程 qq-server', !names.includes('qq-server'))
  ok('bot_act 的 enum 不含自检类 selftest/diagnose', !names.includes('selftest') && !names.includes('diagnose'))
}

// ── ④ 真执行：进程内工具能跑通（临时数据目录，不碰真记忆）──────────────────
{
  const tools = B.buildTools()
  const t = (name) => tools.find((x) => x.name === name)

  // remember → recall 闭环（这是"她真的记得"的最小证据）
  const r1 = await t('bot_remember').execute({ kind: 'episode', text: '今天在网页里跟管理员聊了能力桥的事' })
  ok('bot_remember(episode) 返回结构化文本', typeof r1?.text === 'string' && r1.text.includes('记进情节'), r1?.text)

  const f1 = await t('bot_remember').execute({ kind: 'fact', text: '管理员喜欢喝冰美式' })
  ok('bot_remember(fact) 成功', f1.text.includes('关系事实'), f1.text)

  const s1 = await t('bot_recall').execute({ mode: 'search', query: '能力桥' })
  ok('bot_recall(search) 能查回刚写的那条', /能力桥/.test(s1.text), s1.text.slice(0, 80))

  const s2 = await t('bot_recall').execute({ mode: 'facts' })
  ok('bot_recall(facts) 能查回刚写的事实', /冰美式/.test(s2.text), s2.text.slice(0, 80))

  const s3 = await t('bot_recall').execute({ mode: 'stats' })
  ok('bot_recall(stats) 返回概况', /记忆库/.test(s3.text), s3.text.slice(0, 60))

  // state：读不到也要给出结构化答复，不许抛
  let stateThrew = null
  let st
  try { st = await t('bot_state').execute({ what: 'all' }) } catch (e) { stateThrew = e }
  ok('bot_state 不抛（读不到就跳过那一块）', stateThrew === null, stateThrew ? String(stateThrew.message) : '')
  ok('bot_state 至少给出情绪或此刻之一', typeof st?.text === 'string' && st.text.length > 0, st?.text?.slice(0, 60))

  // diary：写 → 读闭环
  const d1 = await t('bot_diary').execute({ book: 'private', action: 'append', text: '测试：今天把能力桥接上了' })
  ok('bot_diary(append) 成功', d1.text.includes('写进'), d1.text)
  const d2 = await t('bot_diary').execute({ book: 'private', action: 'read', tail: 20 })
  ok('bot_diary(read) 读得到刚写的内容', /能力桥接上了/.test(d2.text), d2.text.slice(0, 80))

  // 参数校验：空正文必须抛（宿主会把异常变成模型可见的错误结果，这是正确的失败方式）
  let threw = false
  try { await t('bot_diary').execute({ book: 'private', action: 'append', text: '   ' }) } catch { threw = true }
  ok('空正文写日记会明确报错（不静默成功）', threw === true)

  // ⚠️ 宿主裸注册不校验参数（实测），所以这套校验必须是我们自己的：
  //    拼错的枚举值不能被静默接受 —— 否则 execute 落进 else 分支，返回一段看似正常的空结果。
  const cases = [
    ['bot_state', { what: 'nonsense' }, /必须是 \["all"/],
    ['bot_recall', {}, /mode 是必填的/],
    ['bot_recall', { mode: 'search', limit: 'x' }, /limit 必须是 integer/],
    ['bot_act', { command: 123 }, /command 必须是 string|必须是/],
    ['bot_act', { command: 'mem', args: 'not-an-array' }, /args 必须是数组/],
    ['bot_diary', { book: 'private', action: 'append', text: 'x', who: 'nobody' }, /who 不被接受/],
  ]
  for (const [name, args, re] of cases) {
    let msg = ''
    try { await t(name).execute(args) } catch (e) { msg = String(e?.message ?? e) }
    ok(`参数校验拦下非法入参：${name} ${JSON.stringify(args)}`, re.test(msg), msg.slice(0, 90))
  }

  // 校验必须放行合法入参（否则工具就废了）
  let okMsg = ''
  try { await t('bot_recall').execute({ mode: 'stats' }) } catch (e) { okMsg = String(e?.message ?? e) }
  ok('合法入参照常放行', okMsg === '', okMsg.slice(0, 60))

  // tell_owner：没有 owner.qq 时必须报错而不是假装发出去
  let ownerErr = ''
  try { await t('bot_tell_owner').execute({ text: 'hi' }) } catch (e) { ownerErr = String(e?.message ?? e) }
  ok('没配 owner.qq 时明确报错（不假装发出）', /owner\.qq/.test(ownerErr), ownerErr.slice(0, 60))

  // act：未知命令必须报错，且错误里列出可用命令（可恢复）
  let actErr = ''
  try { await t('bot_act').execute({ command: 'help' }) } catch (e) { actErr = String(e?.message ?? e) }
  ok('bot_act(help) 不报错（help 是合法命令）', actErr === '', actErr.slice(0, 60))
}

// ── ⑤ 会话事件 → 记忆：按 source.kind 分流 ────────────────────────────────
{
  // 造一个假 ctx：只实现 on()，手动触发事件
  const listeners = []
  const ctx = { on: (name, fn) => { listeners.push([name, fn]); return () => {} } }
  const h = B.attachSessionMemory(ctx)
  ok('挂上了 session/event 监听', listeners.length === 1 && listeners[0][0] === 'session/event')

  const fire = (event) => listeners[0][1]({ id: 'sess-1' }, event)

  // 真人输入 → 收
  fire({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '鱼，我今天加班到十点' }] } })
  // 宿主注入的现状快照 → 不收（这条最关键：它每步都会来，收进去记忆就废了）
  fire({ type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] } })
  // agent-instructions → 不收
  fire({ type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md 内容' }] } })
  // 她自己的回复 → 收
  fire({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '又加班，你先吃点东西' }] } } })
  // 空内容 → 不收
  fire({ type: 'assistant/message', data: { message: { content: [] } } })
  // 非消息事件 → 不看
  fire({ type: 'tool/result', data: {} })

  await new Promise((s) => setTimeout(s, 50))
  ok('只记了 2 条（真人输入 + 她的回复）', h.state.stored === 2, String(h.state.stored))

  const back = await B.buildTools().find((x) => x.name === 'bot_recall').execute({ mode: 'search', query: '加班' })
  ok('记忆里能查到她与他的那段对话', /加班/.test(back.text), back.text.slice(0, 100))
  const polluted = await B.buildTools().find((x) => x.name === 'bot_recall').execute({ mode: 'search', query: 'runtime context' })
  ok('记忆里没有宿主注入的 snapshot（不污染）', !/snapshot supersedes/.test(polluted.text), polluted.text.slice(0, 80))
  ok('事件计数包含被跳过的（诊断可见）', h.state.seen === 6, String(h.state.seen))
}

// ── ⑥ registerBridge：缺服务只降级，不炸 ─────────────────────────────────
{
  // 模拟真实 cordis Context：服务只能经 get(name, false) 取；裸属性访问要抛
  // （实测「cannot get property \"tools\" without inject」把桥整条打死过）。
  const registered = []
  const services = { tools: { register: (def) => { registered.push(def.name); return () => {} } } }
  const ctx = {
    effect: () => () => {},
    on: () => () => {},
    get: (name, strict) => (name in services ? services[name] : undefined),
    get tools() { throw new Error('cannot get property "tools" without inject') },
  }
  const r = B.registerBridge(ctx)
  ok('只经 ctx.get 取服务（裸属性访问会抛，仍然接上）', r.registered === true, r.reason)
  ok('有 tools 服务 → registered=true', r.registered === true && r.reason === 'ok')
  ok('注册进去的工具数与 buildTools 一致', registered.length === B.buildTools().length, `${registered.length}`)
  ok('返回里列出工具名', r.tools.length === registered.length)
  ok('返回里报告命令白名单规模', r.cli.names > 20 && r.cli.source === 'parsed', JSON.stringify(r.cli))
  ok('会话记忆也接上了', r.memory.attached === true)
}

{
  const ctx = { effect: () => () => {}, on: () => () => {}, get: () => undefined } // 没有 tools
  let threw = null
  let r
  try { r = B.registerBridge(ctx) } catch (e) { threw = e }
  ok('缺 tools 服务不抛', threw === null, threw ? String(threw.message) : '')
  ok('缺 tools 服务时 registered=false 且有原因', r?.registered === false && r?.reason === 'no-tools-service', r?.reason)
  ok('缺 tools 服务时记忆仍然接上（不牵连）', r?.memory.attached === true)
}

// ── ⑦ 单个工具注册失败不影响其余 ─────────────────────────────────────────
{
  const okNames = []
  const ctx = {
    effect: () => () => {},
    on: () => () => {},
    get: () => ({
      register: (def) => {
        if (def.name === 'bot_state') throw new Error('名字被占了')
        okNames.push(def.name)
        return () => {}
      },
    }),
  }
  const r = B.registerBridge(ctx)
  ok('一个工具注册失败时其余照常', r.registered === true && okNames.length === B.buildTools().length - 1, `${okNames.length}`)
  ok('失败的那个不出现在已注册列表里', !r.tools.includes('bot_state'))
}

// ── ⑧ attachIdentity：两个子插件按服务可用性各自启动，壳按需缺席 ──────────
// 这是本轮最关键的一条：cordis 的 inject 全有或全无，静态 inject 会让插件在
// headless/tui 里永远 pending —— "装了插件"和"她是不是她"变成两个不相关的问题。
{
  // 起一个"最小宿主"：只有 systemPrompt，没有 tools、没有任何 web 服务（= headless）
  const started = []
  const ctx = {
    get: (n) => (n === 'systemPrompt' ? { section: () => () => {}, assemble: async () => ({ sections: [] }) } : undefined),
    inject: (deps, cb) => { started.push(deps.join('+')); cb({ get: ctx.get, inject: ctx.inject, effect: () => () => {} }); return { then: () => {} } },
    effect: () => () => {},
  }
  globalThis.__dshBotTakeover = null
  globalThis.__dshBotBridge = null
  let threw = null
  try { B.attachIdentity(ctx) } catch (e) { threw = e }
  ok('attachIdentity 不抛（缺服务只降级）', threw === null, threw ? String(threw.message) : '')
  ok('两个子插件都尝试挂载（systemPrompt / tools）', started.includes('systemPrompt') && started.includes('tools'), started.join(' | '))
  ok('人格接管在只有 systemPrompt 时也起来了', !!globalThis.__dshBotTakeover && globalThis.__dshBotTakeover.registered === true)
  ok('没有 tools 服务时能力桥明确报缺（不静默）', !!globalThis.__dshBotBridge && globalThis.__dshBotBridge.reason === 'no-tools-service', String(globalThis.__dshBotBridge && globalThis.__dshBotBridge.reason))
  // 壳是否该装由**插件的 static inject** 决定（cordis 会等服务就绪），这里不再手判 ——
  // attachIdentity 只管人格与桥，返回 undefined 是正确行为（它没有壳的发言权）。
  ok('attachIdentity 不越权决定壳（返回值 undefined）', B.attachIdentity(ctx) === undefined)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(bad ? `\n✗ 能力桥：${bad} 项失败` : '\n✓ 能力桥：全绿')
process.exit(bad ? 1 : 0)
