// 情绪状态机 —— dabot 骨架 brain/persona.py 的 JS 移植（tick_mood + state_block）。
//
// 「活」的来源：情绪会自己漂移；饭点会饿；饿过头心情掉；偶尔无理由波动。
// 状态持久化在 ~/.data/mood.json —— CLI（每次新进程）与宿主生物钟共用同一份 ✓
//
// ⚠️ 10-27 大修（主人报"中午到下午连问十次吃没吃饭、整下午[[困倦]]"）：
//   旧版 `饭点 +7 / 非饭点 -0.5` + `饿过头每 tick 心情 -4`，而 tick 是**每次推送前都跑**
//   （推送一分钟摇一次）。于是 11:00-13:00 十几次 tick 把饥饿打满 100，下午每小时只退 0.5，
//   整天卡在 >60 → 每一轮提示词都写着「饿（82/100），满脑子都是吃的」，
//   同时心情被每 tick 砍 4 分 clamp 到底 0 → 「不太想说话」。
//   现在：① 饭点也封顶（hungerCap）② 非饭点按次衰减（默认 -6）③ 吃到饭直接归零
//   ④ 心情不再随饥饿每 tick 掉，改成**跨天软回归**（回到 moodBase）。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { updateJson } from './atomic.mjs'
import { swallow } from './swallow.mjs'
import { config } from './config.mjs'

const MOOD_FILE = dataPath('mood.json')

/** 饭点：到点了坐不住（与 dabot 一致：午饭 11-12 点、晚饭 17-18 点）。 */
const HUNGRY_HOURS = new Set([11, 12, 17, 18])

/** 默认参数（config.mood 可覆盖）。 */
const DEFAULTS = {
  hungerCap: 70,        // 饭点最多饿到这个数（不再打满 100）
  mealGain: 7,          // 饭点每次 tick +7
  decayPerTick: 6,      // 非饭点每次 tick -6（旧版 0.5，等于永不下降）
  moodBase: 62,         // 心情软回归的目标
  hungryMoodPenalty: 1, // 饿的时候每 tick 掉 1（旧版 4）
}

function opts() {
  // 参数从 bot.config.json 的 `mood` 段热读（config() 每次重新读文件，改完不用重启）
  try {
    return { ...DEFAULTS, ...(config()?.mood || {}) }
  } catch { return { ...DEFAULTS } }
}

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(MOOD_FILE, 'utf8'))
    return {
      value: Number.isFinite(Number(j.value)) ? Number(j.value) : 62,
      hunger: Number.isFinite(Number(j.hunger)) ? Number(j.hunger) : 0,
      updatedAt: j.updatedAt ?? null,
      day: j.day ?? '',
    }
  } catch { return { value: 62, hunger: 0, updatedAt: null, day: '' } }
}

function writeState(st) {
  // v5：情绪值有 5 个写入者。旧的整份覆盖会丢更新 ——
  // 她刚被一句话影响，下一个 tick 又被别的进程手里的旧快照覆盖回去。
  const r = updateJson(MOOD_FILE, (cur) => {
    const base = (cur && typeof cur === 'object') ? cur : { value: 62, hunger: 0 }
    return { ...base, ...st }
  }, { fallback: { value: 62, hunger: 0 } })
  if (!r.ok) { try { swallow(new Error('mood write failed'), 'mood:write') } catch { /* ignore */ } }
}

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE')

/**
 * 情绪 tick。每次唤醒/对话前调用一次。
 * ① 饭点 hunger +mealGain（封顶 hungerCap）② 非饭点 -decayPerTick
 * ③ 饿过头（>60）心情 -hungryMoodPenalty ④ 6% 概率无理由波动 {-9,-4,+5,+8} ⑤ clamp 0-100
 * ⑥ 跨天：心情朝 moodBase 软回归（新的一天不背着昨天的低谷）
 */
export function tickMood(random = Math.random) {
  const o = opts()
  const st = readState()
  const now = new Date()
  const hour = now.getHours()
  const today = dayKey(now)
  // 跨天软回归：只做一次（靠 day 字段判定），不随 tick 反复拉
  if (st.day && st.day !== today) {
    st.value = Math.round((st.value + o.moodBase) / 2)
    st.hunger = Math.max(0, st.hunger - 20)
  }
  st.day = today
  if (HUNGRY_HOURS.has(hour)) st.hunger = Math.min(o.hungerCap, st.hunger + o.mealGain)
  else st.hunger = Math.max(0, st.hunger - o.decayPerTick)
  if (st.hunger > 60) st.value -= o.hungryMoodPenalty
  // 不饿的时候心情自己往回爬（旧版只有"往下掉"的路径 → 一旦被打到底就整天 0，永远[[困倦]]）
  else if (st.hunger <= 30 && st.value < o.moodBase) st.value += 2
  if (random() < 0.06) st.value += [-9, -4, 5, 8][Math.floor(random() * 4)]
  st.value = Math.max(0, Math.min(100, st.value))
  st.updatedAt = new Date().toISOString()
  // 10-31：把事件驱动的 affect 折算进长期心情（每次最多动 6 分，保留惯性）
  try { reconcileAffect() } catch (e) { swallow(e, 'tools/lib/mood.mjs:tick-reconcile') }
  writeState(st)
  return st
}

/**
 * 吃到饭 / 主人说了他吃了 → 饥饿直接掉下来（10-27）。
 * 这是"连问十次吃没吃饭"的止血点：他答过一次，她就该真的不饿了。
 */
export function fed(level = 20) {
  const st = readState()
  const o = opts()
  st.hunger = Math.max(0, Math.min(Number(level) || 0, 20))
  // 吃到东西本来就该心情好一点（不许一路 0 到底）
  st.value = Math.min(100, st.value + 8)
  st.updatedAt = new Date().toISOString()
  st.day = st.day || dayKey()
  writeState(st)
  void o
  return st
}

export function mood() { return readState() }

/** 时段 phase —— 同一句话在 7 点和 2 点必须不一样（dabot 的核心设计）。 */
function phaseText(now = new Date()) {
  const h = now.getHours()
  // 只描述状态，不夹带"要短""话多"这类长度指令 —— 长度应由对话场景决定（10-31）
  if (h >= 6 && h < 10) return '早上，刚醒，人还有点糊'
  if (h >= 10 && h < 11) return '上午'
  if (h >= 11 && h < 13) return '快到饭点了'
  if (h >= 13 && h < 17) return '下午'
  if (h >= 17 && h < 20) return '晚饭时间'
  if (h >= 20 && h < 24) return '晚上'
  return '半夜了'
}

/**
 * 注入提示的【当下状态】块 —— dabot persona.py state_block 的移植。
 * @returns {string}
 */
const PLATFORM_STATE = {
  qq: 'QQ 私聊（只有你和主人两个人；这里才该叫主人、才聊私事）',
  wechat: '微信私聊（一句一句聊，别写成一大段）',
  bilibili: 'B站评论区/动态（允许碎碎念，但别刷屏）',
  douyin: '抖音评论区（一句话接住梗就够）',
}

/**
 * 把事件驱动的 affect（valence/arousal/tension）折算成 mood.value 的目标值。
 * 为什么：两套情绪以前各存各的、各说各话（mood 说"正常"，affect 说"心情不错"），
 * 模型同时看到两句矛盾指令，行为不稳定。现在只让 affect 做**输入**，mood 做**输出**。
 * @returns {{target:number, tension:number}|null}
 */
function affectTarget() {
  try {
    const f = dataPath('brain', 'affect', 'mood.json')
    const a = JSON.parse(fs.readFileSync(f, 'utf8'))
    const v = Number(a?.valence)
    if (!Number.isFinite(v)) return null
    return {
      target: Math.max(0, Math.min(100, 50 + v * 50)),
      tension: Number(a?.tension) || 0,
    }
  } catch { return null }
}

/** 社交事件轻推：外部影响小步走（±0.1~0.5），带锁合并写，不覆盖别的写入者。 */
export function nudge(delta) {
  const d = Math.max(-1.5, Math.min(1.5, Number(delta) || 0))
  if (!d) return
  const st = readState()
  st.value = Math.max(0, Math.min(100, Number(st.value ?? 62) + d))
  st.updatedAt = new Date().toISOString()
  st.day = st.day || dayKey()
  writeState(st)
}

/** mood.value 向 affect 的目标缓慢靠拢（每次最多 6 分，保留惯性）。 */
export function reconcileAffect() {
  const t = affectTarget()
  if (!t) return null
  const m = readState()
  const cur = Number(m.value) || 62
  const diff = t.target - cur
  if (Math.abs(diff) < 0.5) return { from: cur, to: cur, moved: 0 }
  const step = Math.max(-6, Math.min(6, diff))
  const next = Math.round((cur + step) * 10) / 10
  try {
    // v5：这是"读 → 算 → 写"，必须原子（两个进程同时漂移会互相覆盖）
    updateJson(MOOD_FILE, (cur) => {
      const base = (cur && typeof cur === 'object') ? cur : { value: 62, hunger: 0 }
      return { ...base, value: next, updatedAt: new Date().toISOString() }
    }, { fallback: { value: 62, hunger: 0 } })
  } catch { /* 写不进去不影响本轮说话 */ }
  return { from: cur, to: next, moved: Math.round(step * 10) / 10 }
}

export function stateBlock(turnsToday = 0, platform = 'bilibili', isGroup = false) {
  const now = new Date()
  const m = readState()
  // 10-31：先让 affect 影响 mood（有惯性），再用合并后的单一分数说话 ——
  // 不再让两套情绪在同一个 prompt 里各说各话。
  const aff = affectTarget()
  // 低情绪 = 提不起劲，不是"必须说短句"（那会让难受的时候更冷）
  const style = m.value < 30 ? '有点提不起劲'
    : m.value > 75 ? '心情挺好'
    : '平稳'
  // 饥饿措辞分档（10-27）：旧版 >60 就写"满脑子都是吃的"，一整天挂在提示词里 → 她开口就是饿。
  // 现在 75 以上才算"很饿"，60-75 只是"有点饿"，而且明确"别追着问主人吃了没"。
  const hunger = m.hunger > 75 ? `很饿（${Math.round(m.hunger)}/100）。`
    : m.hunger > 60 ? `有点饿（${Math.round(m.hunger)}/100），可以提一句吃的，但别追着问主人吃了没。`
    : ''
  // 群聊必须**明说**在群里（10-26）：原来写"QQ（私聊或群聊，按上下文判断）"，
  // 等于让她自己猜，猜错就把群友当主人。轮数同理 —— 群里的 34 条不是"跟他聊了 34 轮"。
  const platformText = isGroup ? 'QQ 群（群里好几个人在，说话的是群友，不是只有主人）'
    : (PLATFORM_STATE[platform] || platform)
  const turnLine = isGroup ? `这个群今天说了 ${turnsToday} 条。`
    : `今天已经聊了 ${turnsToday} 轮。${turnsToday > 40 ? '有点累了，敷衍一点。' : ''}`
  const lines = [
    `现在是 ${now.toLocaleString('sv-SE', { hour12: false })}（${phaseText(now)}）。`,
    `情绪 ${Math.round(m.value)}/100：${style}` + (aff && aff.tension > 0.3 ? '（心里还惦记着没做完的事）' : ''),
    hunger,
    turnLine,
    `当前平台：${platformText}。`,
  ].filter(Boolean)
  return '【当下状态】\n' + lines.join('\n')
}

/**
 * 走神注入 —— 8% 概率嘀咕一句，多了就成噪音（dabot：别超过 10%）。
 * ⚠️ 10-27：原来三条**全是吃的**，等于每天几十次给她"想想吃的"的心理暗示，
 * 跟"连问吃没吃饭"是一条绳上的。现在只有三分之一跟吃有关，其余是别的生活小事。
 */
export function distract(random = Math.random) {
  if (random() >= 0.08) return ''
  const lines = [
    '（这次先在心里嘀咕一句跟吃有关的，再干活，不要解释为什么。）',
    '（干活中途允许走神一次，想一件跟吃无关的小事，别解释。）',
    '（先想想今天 token 饭钱花了几块，再干活，别解释。）',
    '（走神一下：想起刚才看的那个视频，再回来干活，别解释。）',
  ]
  return '\n' + lines[Math.floor(random() * lines.length)]
}
