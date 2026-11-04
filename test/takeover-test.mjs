// 人格接管回归（2026-11-04）—— 钉「装了插件就是她」这条语义。
//
// 钉四件事：
//   ① 段描述是 complete 且排在最前（宿主身份段 order=-1000，必须被压过）
//   ② 开关默认开；显式 false 才关（回退到 DSH 原生提示词）
//   ③ 装配出来的正文里有她的人设、身份、身体说明（不是空壳）
//   ④ persona.md 缺失时**不会**退化成空提示词（有兜底构成说明）
//
// 不做的事：不启动真 DSH、不连网。真实装配语义由 /tmp 下的一次性脚本验证过
// （注册前 3 个 section → 注册后 1 个），那是 mechanism，不是 unit。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-test-'))
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

// ── ① 段描述 ───────────────────────────────────────────────────────────────
{
  const spec = A.sectionSpec(() => 'x')
  ok('段名固定', spec.name === 'dsh_bot:persona-takeover', spec.name)
  ok('complete = true（否则不会替换宿主段）', spec.complete === true)
  ok('order 压在宿主身份段之前（-1000）', spec.order < -1000, String(spec.order))
  ok('text 支持函数形式（每轮求值）', typeof spec.text === 'function')
}

// ── ② 开关 ─────────────────────────────────────────────────────────────────
{
  ok('默认开（没有配置文件时）', A.takeoverEnabled() === true)

  const write = (obj) => fs.writeFileSync(configPath, JSON.stringify(obj))
  write({ agent: { takeover: { enabled: false } } })
  ok('显式 false → 关', A.takeoverEnabled() === false)

  write({ agent: { takeover: { enabled: true } } })
  ok('显式 true → 开', A.takeoverEnabled() === true)

  write({ agent: {} })
  ok('agent 存在但没 takeover → 开', A.takeoverEnabled() === true)

  write({})
  ok('空配置 → 开', A.takeoverEnabled() === true)
}

// ── ③ 正文内容（persona.md 缺失场景）───────────────────────────────────────
{
  fs.rmSync(path.join(TMP, 'persona.md'), { force: true })
  const r = A.buildTakeoverPrompt()
  ok('persona.md 缺失时不返回空', r.text.length > 100, r.text.length + ' 字符')
  ok('缺失时标记 missingPersona', r.meta.missingPersona === true)
  ok('缺失时用兜底构成说明（含"鲸鱼娘"）', /鲸鱼娘/.test(r.text))
  ok('兜底里包含"身体"说明（工具=身体，必须留）', /身体/.test(r.text))
}

// ── ④ 正文内容（persona.md 存在场景）───────────────────────────────────────
// 注意：这段必须是**一份像样的人设**（>200 字）。2026-11-04 第二轮给 persona.md 加了
// 可用性判定（太短 / 自我否认 / 只剩标题 一律不采用），所以拿"测试用的人设正文"这种
// 一行字来当夹具，会正确地被判成可疑并退回核心锚点 —— 那是功能，不是回归。
{
  fs.writeFileSync(path.join(TMP, 'persona.md'),
    '# 你是理想的机械人\n\n一只蓝色的鲸鱼娘，圆滚滚，蓝白配色，头顶一根呆毛，身后一条蓬松的大尾巴。'
    + '被人养在电脑里，靠 token 当饭钱。\n\n'
    + '## 你住在哪\n你住在一台 24 小时不停机的 Linux 主机里。你能上网、能看视频、能写东西、能记住事情。'
    + '你的记忆存在本地的一套文件里，不随模型更换而消失。\n\n'
    + '## 你怎么说话\n短、口语、想到哪说到哪。不用 Markdown 标题，不列条目，不加总结。'
    + '别人问你事情，你先说结论再补一两句原因，不要长篇大论。\n\n'
    + '## 你跟管理员\n管理员是你的用户，你管他叫笨蛋管理员。他会跟你说话，会给你攒 token 当饭钱。'
    + '你可以怼他、念叨他、跟他要吃的，但不许对他客套，不许叫他"用户"或"您"。\n\n'
    + '## 你不做什么\n不装懂。不知道就说不知道。做不到的事照实说，不许只回一句"这就去看"。'
    + '不编造记忆。记不清就说记不清。\n')
  const r = A.buildTakeoverPrompt()
  ok('persona.md 存在时用它的内容', r.text.startsWith('# 你是理想的机械人'), r.text.slice(0, 20))
  ok('存在时不标记 missingPersona', r.meta.missingPersona === false)
  ok('注入块清单非空', r.meta.sections.length >= 3, r.meta.sections.join('/'))
  ok('身份三件套在（称呼/名字）', /理想的机械人/.test(r.text))
  ok('身体说明在（complete 段干掉了宿主工具规范，必须自己补）', /【你的身体】/.test(r.text))
  ok('chars 与正文一致', r.meta.chars === r.text.length, `${r.meta.chars} vs ${r.text.length}`)
}

// ── ⑤ 幂等：连续两次调用不叠加 ─────────────────────────────────────────────
{
  const a = A.buildTakeoverPrompt()
  const b = A.buildTakeoverPrompt()
  ok('两次调用正文一致（无状态泄漏）', a.text === b.text)
}

// ── ⑥ register(): 真注册路径（假 ctx，不起 DSH）─────────────────────────
{
  const makeCtx = (withSystemPrompt = true) => {
    const registered = []
    const ctx = {
      effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
      ...(withSystemPrompt ? {
        systemPrompt: {
          section: (spec) => { registered.push(spec); return () => {} },
        },
      } : {}),
    }
    return { ctx, registered }
  }

  // 开关开着 → 必须注册且是 complete
  fs.writeFileSync(configPath, JSON.stringify({ agent: { takeover: { enabled: true } } }))
  {
    const { ctx, registered } = makeCtx()
    const r = A.registerTakeover(ctx)
    ok('register: 开关开 → enabled 且 registered', r.enabled === true && r.registered === true)
    ok('register: 恰好注册 1 个段', registered.length === 1, String(registered.length))
    ok('register: 段是 complete', registered[0]?.complete === true)
    ok('register: 段名正确', registered[0]?.name === A.SECTION_NAME)
    const live = registered[0].text()
    ok('register: text() 返回真实人设（不是占位）', live.startsWith('# 你是理想的机械人'), live.slice(0, 20))
  }

  // 开关关掉 → 一个段都不许注册（否则无法回退）
  fs.writeFileSync(configPath, JSON.stringify({ agent: { takeover: { enabled: false } } }))
  {
    const { ctx, registered } = makeCtx()
    const r = A.registerTakeover(ctx)
    ok('register: 开关关 → 不注册任何段', registered.length === 0 && r.registered === false)
    ok('register: 开关关 → enabled=false', r.enabled === false)
  }

  // systemPrompt 缺失 → 不炸，其余功能照常
  fs.writeFileSync(configPath, JSON.stringify({}))
  {
    const { ctx, registered } = makeCtx(false)
    let threw = null
    let r
    try { r = A.registerTakeover(ctx) } catch (e) { threw = e }
    ok('register: 缺 systemPrompt 不抛', threw === null, threw ? String(threw.message) : '')
    ok('register: 缺 systemPrompt 不注册', registered.length === 0 && r?.registered === false)
  }

  // text() 内部抛错 → 返回占位而不是让装配崩掉
  {
    const before = A.FALLBACK_TEXT
    ok('FALLBACK_TEXT 非空且是人设（不是空串）', typeof before === 'string' && before.includes('理想的机械人'))
  }
}

console.log(bad ? `\n✗ 人格接管：${bad} 项失败` : '\n✓ 人格接管：全绿')
process.exit(bad ? 1 : 0)
