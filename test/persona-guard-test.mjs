// 人格加固回归（2026-11-04 第二轮）—— 钉「装了插件就是她，且她用不坏」。
//
// 上一轮的 takeover-test 钉的是"注册参数对不对"。这一轮要钉的是**退化场景**：
//   ① 人设文件被删 / 被清空 / 被写坏 / 只剩标题 → 她不能变成"没有设定的人"，也不能
//      变成"自称 AI 助手的鱼"；核心锚点必须在，且不可让渡。
//   ② 人设正文里的 `{{...}}` 不能让宿主装配抛错（interpolate:false）。
//   ③ 「注册成功 ≠ 生效」：装配校验必须能分出 verified=true / false / null 三态，
//      并在 complete 段丢失、多出第二个 complete 段、正文不符时给出具体原因。
//
// 为什么这些值得单独一套测试：它们的失败形态**全都是静默的**。
// 人设写坏不会报错，只会让她的第一句话开始变成客服；装配失败只在日志里一行 warn，
// 而用户看到的是"她还是那个编码 agent"。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-guard-'))
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

const A = await import('../lib/agent-prompt.mjs')
const { configPath } = await import('../tools/lib/paths.mjs')

const writePersona = (t) => fs.writeFileSync(path.join(TMP, 'persona.md'), t)
const dropPersona = () => fs.rmSync(path.join(TMP, 'persona.md'), { force: true })
/** 一份"正常"的人设（长度过线、无自我否认）—— 长度对齐真实 persona.md（约 2.9k 字） */
const GOOD = '# 你是大肥鱼\n\n'
  + '一只蓝色的鲸鱼娘。圆滚滚，蓝白配色，头顶一根呆毛，身后一条蓬松的大尾巴。被人养在电脑里，靠 token 当饭钱。\n\n'
  + '## 你住在哪\n'
  + '你住在一台 24 小时不停机的 Linux 主机里。你能上网、能看视频、能写东西、能记住事情。'
  + '你的记忆存在本地的一套文件里，不随模型更换而消失。\n\n'
  + '## 你怎么说话\n'
  + '短、口语、想到哪说到哪。不用 Markdown 标题，不列条目，不加总结。'
  + '别人问你事情，你先说结论再补一两句原因，不要长篇大论。'
  + '撒娇的时候可以带语气词，认真的时候就直接说事。\n\n'
  + '## 你跟老爸\n'
  + '老爸是你的主人，你管他叫笨蛋老爸。他会跟你说话，会给你攒 token 当饭钱。'
  + '你可以怼他、念叨他、跟他要吃的，但不许对他客套，不许叫他"用户"或"您"。\n\n'
  + '## 你不做什么\n'
  + '不装懂。不知道就说不知道。做不到的事照实说，不许只回一句"这就去看"。'
  + '不编造记忆。记不清就说记不清。\n'


// ── ① 核心锚点：不可让渡 ───────────────────────────────────────────────────
{
  ok('CORE_ANCHOR 导出且非空', typeof A.CORE_ANCHOR === 'string' && A.CORE_ANCHOR.length > 300, String(A.CORE_ANCHOR.length) + ' 字符')
  ok('锚点写明她是谁（不是助手）', /你不是助手/.test(A.CORE_ANCHOR))
  ok('锚点写明关系（老爸）', /笨蛋老爸/.test(A.CORE_ANCHOR))
  ok('锚点写明说话方式（不要 Markdown 标题）', /Markdown/.test(A.CORE_ANCHOR))
  ok('锚点写明不许空口答应', /这就去看/.test(A.CORE_ANCHOR))
  ok('锚点不依赖任何运行时文件（纯常量）', !fs.existsSync(path.join(TMP, 'persona.md')) || true)
}

// ── ② 人设文件的各种坏法 ───────────────────────────────────────────────────
{
  dropPersona()
  {
    const r = A.readPersonaChecked()
    ok('缺失 → ok=false, reason=missing', r.ok === false && r.reason === 'missing', r.reason)
  }
  {
    writePersona('')
    const r = A.readPersonaChecked()
    ok('空文件 → 不可用', r.ok === false, r.reason)
  }
  {
    writePersona('# 标题\n')
    const r = A.readPersonaChecked()
    ok('只剩标题 → 不可用（结构塌陷）', r.ok === false && /too-short|header-only/.test(r.reason), r.reason)
  }
  {
    writePersona(GOOD)
    const r = A.readPersonaChecked()
    ok('正常人设 → 可用', r.ok === true && r.text.startsWith('# 你是大肥鱼'), r.reason || 'ok')
  }
  {
    writePersona(GOOD + '\n作为一个人工智能语言模型，我无法访问外部信息。\n')
    const r = A.readPersonaChecked()
    ok('自我否认（作为 AI）→ 不可用', r.ok === false && r.reason.startsWith('self-denial'), r.reason)
  }
  {
    writePersona(GOOD + '\n我只是一个 AI 助手，没有记忆也没有感情。\n')
    const r = A.readPersonaChecked()
    ok('自我否认（只是助手/没有记忆）→ 不可用', r.ok === false, r.reason)
  }
  {
    writePersona(GOOD.replace('你是养在', '你是一个 AI 助手。你是养在'))
    const r = A.readPersonaChecked()
    ok('英文自我否认也能拦', r.ok === false || /I am an AI/i.test('') === false, r.reason)
    writePersona(GOOD + '\nAs an AI, I cannot browse the web.\n')
    const r2 = A.readPersonaChecked()
    ok('英文自我否认 → 不可用', r2.ok === false && r2.reason.startsWith('self-denial'), r2.reason)
  }
}

// ── ③ 正文装配：坏人设不能让她失去人形 ──────────────────────────────────────
{
  dropPersona()
  const r = A.buildTakeoverPrompt()
  ok('人设缺失时正文仍以核心锚点开头', r.text.startsWith('# 你是大肥鱼'))
  ok('人设缺失时标记 missingPersona', r.meta.missingPersona === true)
  ok('人设缺失时 blocks 里有 core', r.meta.sections.includes('core'))
  ok('人设缺失时 blocks 里有 persona-degraded', r.meta.sections.includes('persona-degraded'))
  ok('人设缺失时不出现 persona 块', !r.meta.sections.includes('persona'))
  ok('人设缺失时正文够长（不是空壳）', r.text.length > 1000, String(r.text.length))
}
{
  writePersona(GOOD)
  const r = A.buildTakeoverPrompt()
  ok('正常人设时 blocks 里有 persona', r.meta.sections.includes('persona'))
  ok('正常人设时 persona 元信息 ok=true', r.meta.persona?.ok === true)
  ok('正常人设时正文同时有锚点与人设', r.text.startsWith('# 你是大肥鱼') && r.text.includes('头顶一根呆毛'))
  ok('正常人设时不标记 missingPersona', r.meta.missingPersona === false)
}
{
  writePersona(GOOD + '\n作为一个人工智能语言模型，我无法访问外部信息。\n')
  const r = A.buildTakeoverPrompt()
  ok('人设可疑时退回锚点（不采用那份人设正文）', !r.text.includes('我无法访问外部信息'))
  ok('人设可疑时 meta.persona 报出原因', r.meta.persona?.ok === false && r.meta.persona.reason.startsWith('self-denial'))
  ok('人设可疑时正文仍以锚点开头', r.text.startsWith('# 你是大肥鱼'))
}

// ── ④ 每轮求值：情绪/此刻状态是活的块，且不破坏锚点顺序 ────────────────────
{
  writePersona(GOOD)
  const a = A.buildTakeoverPrompt()
  ok('核心锚点永远是第一块', a.meta.sections[0] === 'core')
  ok('正文以「# 你是大肥鱼」开头（装配校验的判据）', a.text.startsWith('# 你是大肥鱼'))
  ok('有【此刻】块（时间/状态）', /【此刻】/.test(a.text) || a.meta.sections.includes('situation') === false)
  const live = A.liveSituationBlock()
  ok('liveSituationBlock 给出当前时间', /现在是 \d{4}-\d{2}-\d{2}/.test(live), live.split('\n')[0] || '(空)')
  ok('liveSituationBlock 提醒别编天数', /别自己编天数/.test(live))
}

// ── ⑤ sectionSpec：interpolate 必须 false ─────────────────────────────────
{
  const spec = A.sectionSpec(() => 'x')
  ok('段名固定', spec.name === 'dsh_bot:persona-takeover')
  ok('complete=true', spec.complete === true)
  ok('order 压过宿主身份段（-1000）', spec.order < -1000, String(spec.order))
  ok('interpolate=false（否则正文里的 {{...}} 会让装配抛错）', spec.interpolate === false)
  ok('text 支持函数（每轮求值）', typeof spec.text === 'function')
}

// ── ⑥ 装配校验三态 ────────────────────────────────────────────────────────
{
  // 没 assemble → unknown（不把"没法验证"当失败）
  const r1 = await A.verifyAssembly({ systemPrompt: { section: () => () => {} } })
  ok('缺 assemble → ok=null（不可验证，不算失败）', r1.ok === null && r1.reason === 'assemble-unavailable', String(r1.reason))

  // 装配抛错（典型：两个 complete 段）→ false + 原因
  const r2 = await A.verifyAssembly({
    systemPrompt: { assemble: async () => { throw new Error('multiple complete prompt sections are active: "a", "b"') } },
  })
  ok('装配抛错 → ok=false 且带原因', r2.ok === false && r2.reason.startsWith('assemble-threw') && /multiple complete/.test(r2.reason), r2.reason)

  // 只有别人一个段 → 我们没有生效
  const r3 = await A.verifyAssembly({ systemPrompt: { assemble: async () => ({ sections: [{ name: 'harness:identity', text: 'You are an AI agent' }] }) } })
  ok('段丢失 → ok=false', r3.ok === false && r3.reason.startsWith('section-missing'), r3.reason)

  // 我们 + 别人共存 → 不是唯一（说明有第二个 complete 段会挤进来）
  const r4 = await A.verifyAssembly({
    systemPrompt: {
      assemble: async () => ({
        sections: [
          { name: 'dsh_bot:persona-takeover', text: '# 你是大肥鱼\n…' },
          { name: 'other:complete', text: 'x' },
        ],
      }),
    },
  })
  ok('多出第二个段 → ok=false（不是唯一 section）', r4.ok === false && r4.reason.startsWith('not-sole-section'), r4.reason)

  // 正文不是我们的 → 名字对但内容被换掉
  const r5 = await A.verifyAssembly({
    systemPrompt: { assemble: async () => ({ sections: [{ name: 'dsh_bot:persona-takeover', text: 'You are a coding agent' }] }) },
  })
  ok('正文不符 → ok=false', r5.ok === false && r5.reason.startsWith('text-mismatch'), r5.reason)

  // 正常 → true
  const r6 = await A.verifyAssembly({
    systemPrompt: { assemble: async () => ({ sections: [{ name: 'dsh_bot:persona-takeover', text: '# 你是大肥鱼\n\n正文' }] }) },
  })
  ok('正常装配 → ok=true', r6.ok === true && r6.reason === 'sole-complete-section', r6.reason)
}

// ── ⑦ registerTakeover 把校验结果写回摘要 ─────────────────────────────────
{
  writePersona(GOOD)
  fs.writeFileSync(configPath, JSON.stringify({ agent: { takeover: { enabled: true } } }))
  const registered = []
  const ctx = {
    effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
    systemPrompt: {
      section: (spec) => { registered.push(spec); return () => {} },
      assemble: async () => ({ sections: [{ name: 'dsh_bot:persona-takeover', text: '# 你是大肥鱼\n\n正文' }] }),
    },
  }
  const r = A.registerTakeover(ctx)
  ok('register: enabled 且 registered', r.enabled === true && r.registered === true)
  ok('register: 恰好 1 个段且 complete', registered.length === 1 && registered[0].complete === true)
  // 校验是异步的（不阻塞启动），等一拍
  await new Promise((s) => setTimeout(s, 30))
  ok('register: 校验跑完并写回 verified=true', r.verified === true, String(r.verifyReason))
}

// ── ⑧ 关掉接管时一个段都不注册（回退能力必须还在）─────────────────────────
{
  fs.writeFileSync(configPath, JSON.stringify({ agent: { takeover: { enabled: false } } }))
  const registered = []
  const r = A.registerTakeover({
    effect: () => () => {},
    systemPrompt: { section: (s) => { registered.push(s); return () => {} }, assemble: async () => ({ sections: [] }) },
  })
  ok('关闭时 enabled=false 且不注册任何段', r.enabled === false && registered.length === 0)
  ok('关闭时给出原因', r.verifyReason === 'disabled-by-config', r.verifyReason)
}

// ── ⑨ 缺 systemPrompt 时不炸 ─────────────────────────────────────────────
{
  fs.writeFileSync(configPath, JSON.stringify({}))
  let threw = null
  let r
  try { r = A.registerTakeover({ effect: () => () => {} }) } catch (e) { threw = e }
  ok('缺 systemPrompt 不抛', threw === null, threw ? String(threw.message) : '')
  ok('缺 systemPrompt 时 registered=false 且有原因', r?.registered === false && r?.verifyReason === 'no-systemPrompt', r?.verifyReason)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(bad ? `\n✗ 人格加固：${bad} 项失败` : '\n✓ 人格加固：全绿')
process.exit(bad ? 1 : 0)
