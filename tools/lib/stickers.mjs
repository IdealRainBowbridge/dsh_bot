// 表情包 / 颜文字 —— QQ、微信、B站、抖音共用的一套约定。
//
// 三层能力，按平台降级：
//   1. 颜文字 / emoji   —— 哪儿都能用（评论也行）
//   2. B站自带表情码     —— 评论区的"表情包"：写 [大笑] [doge] [吃瓜]，B站会渲染成图
//   3. 图片表情          —— 只有 QQ/微信 能发：
//        · [表情:开心]      → ~/.data/stickers/开心/ 里随机一张（AI 画好的那套）
//        · [自制表情:困死了] → 当场用 PIL 画一张文字贴纸（不联网、不花额度）
//
// 图片目录：~/.data/stickers/<标签>/<任意名>.png|gif|webp
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homePath, dataPath } from './paths.mjs'
import { config } from './config.mjs'
import { findPythonWith } from './python-runtime.mjs'
import { renderSticker, available as stickerRendererAvailable } from './sticker-render.mjs'
import { swallow } from './swallow.mjs'

export const STICKER_DIR = dataPath('stickers')

/** 内置兜底标签（文件夹空着也不影响 prompt 里出现这几个）。 */
export const DEFAULT_TAGS = ['开心', '无语', '委屈', '生气', '困', '比心']

/**
 * 私藏目录（2026-11-02）：图存在本地，但**不进 availableTags** ——
 * 她平时不会被告知有这些标签，随机取图也绕开。
 *
 * 为什么需要：availableTags() 的实现是"扫目录名，有目录就报"，所以
 * 建一个「亲密」目录会立刻变成可发标签。用户的意思是这些图留着以后用
 * （俏皮/撒娇场合），不是要它进日常情绪菜单。
 *
 * 想让她在特定场合用：往 config.qq.sticker.allowPrivate 里写标签名，
 * 或者直接调 pickSticker('亲密') —— 后者不受这里限制。
 */
export const PRIVATE_DIRS = new Set(['亲密', '私藏', '不合适', '_private'])

/** B站评论区能渲染成图的表情码：内置这 16 个（已用真实账号核对，全部存在）。 */
export const BILI_FACES = [
  '大笑', '笑哭', 'doge', '吃瓜', '妙啊', '星星眼', '辣眼睛', '酸了',
  '疑惑', '惊喜', '委屈', '大哭', '点赞', '打call', '滑稽', '微笑',
]

// 完整名单（447 个）从 B站表情面板拉，缓存 24h；拉不到就用上面那 16 个
const FACE_CACHE = dataPath('bili-faces.json')

/** 读缓存；过期或没有就返回 null。 */
export function readFaceCache() {
  try {
    const j = JSON.parse(fs.readFileSync(FACE_CACHE, 'utf8'))
    if (Array.isArray(j.names) && j.names.length && Date.now() - Number(j.at) < 86400e3) return j.names
  } catch {}
  return null
}

/** 拿 B站表情码白名单（优先缓存 → 在线拉 → 内置兜底）。 */
export async function loadBiliFaces() {
  const cached = readFaceCache()
  if (cached) return cached
  try {
    const { loadCred, missingForWrite } = await import('./cred.mjs')
    const c = loadCred()
    if (missingForWrite(c).length) return BILI_FACES
    const cookie = `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3 || ''}`
    // v5：没有超时 → B 站慢的时候取表情列表会一直挂着（调用方也是 sync 路径）
    const r = await fetch('https://api.bilibili.com/x/emote/user/panel/web?business=reply', {
      headers: { cookie, 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(10000),
    })
    const j = await r.json()
    const names = []
    for (const pkg of (j?.data?.packages ?? [])) {
      for (const e of (pkg.emote ?? [])) {
        const t = String(e.text || '').replace(/^\[|\]$/g, '').trim()
        if (t && !names.includes(t)) names.push(t)
      }
    }
    if (!names.length) return BILI_FACES
    try { fs.writeFileSync(FACE_CACHE, JSON.stringify({ at: Date.now(), names })) } catch {}
    return names
  } catch {
    return BILI_FACES
  }
}

const IMG = /\.(png|jpe?g|gif|webp)$/i
const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.join(HERE, 'sticker_render.py')

/** 扫描本机表情包：返回 { 标签: [绝对路径...] }。 */
export function listStickers() {
  const out = {}
  let dirs = []
  try {
    dirs = fs.readdirSync(STICKER_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch { return out }
  for (const tag of dirs) {
    const dir = path.join(STICKER_DIR, tag)
    let files = []
    try { files = fs.readdirSync(dir).filter(f => IMG.test(f)).map(f => path.join(dir, f)) } catch { continue }
    if (files.length) out[tag] = files
  }
  return out
}

/** 可用标签（本机有图的优先；一张图都没有时退回内置标签，只走颜文字）。 */
export function availableTags() {
  // 自制 是渲染缓存目录，不算一个可选标签
  // 2026-11-02：排除私藏目录 —— 有图不等于该主动告诉她能用
  const allowPriv = new Set(config().qq?.sticker?.allowPrivate || [])
  const have = Object.keys(listStickers()).filter(t => t !== '自制' && (!PRIVATE_DIRS.has(t) || allowPriv.has(t)))
  return have.length ? have : DEFAULT_TAGS
}

/** 取某个标签的一张图；没有就返回 null。
 *  只认「根本形象」的图（10-25 主人要求）：sf-/ai- 前缀（硅基参考图锁形象）或无前缀的老图（人工挑的）；
 *  px-*（Pollinations 免费兜底，形象不保证）**永远不发**。 */
export function pickSticker(tag, random = Math.random) {
  const all = listStickers()[tag]
  if (!all || !all.length) return null
  const persona = all.filter(p => {
    const f = path.basename(p)
    if (/^px-/i.test(f)) return false          // 免费兜底的普通形象
    return true
  })
  const files = persona.length ? persona : []
  if (!files.length) return null
  return files[Math.floor(random() * files.length) % files.length]
}

// [表情:开心] / 【表情：无语】
const MARK = /[[【]\s*表情\s*[:：]\s*([^\]】\s]{1,10})\s*[\]】]/g
// [自制表情:困死了] —— 里面允许空格和标点
const MAKE = /[[【]\s*自制表情\s*[:：]\s*([^\]】]{1,20})\s*[\]】]/g

/**
 * 从回复里摘出表情标记。
 * @returns {{text: string, tag: string|null, caption: string|null}}
 */
export function splitSticker(reply) {
  let tag = null
  let caption = null
  let text = String(reply || '')
  text = text.replace(MAKE, (_m, cap) => { if (!caption) caption = cap.trim(); return '' })
  text = text.replace(MARK, (_m, t) => { if (!tag && !caption) tag = t.trim(); return '' })
  return { text: text.replace(/[ \t]+\n/g, '\n').trim(), tag, caption }
}

/** 剥掉所有图片表情标记（评论用）。 */
export function toPlain(reply) {
  return splitSticker(reply).text
}

/** 去掉不在白名单里的 [xx] —— 只处理"像表情码"的短词，别误伤正常文字。 */
function stripUnknownFaces(text, allow) {
  const set = new Set(allow)
  return text.replace(/\[([^\[\]\s]{1,8})\]/g, (m, inner) => (set.has(inner) ? m : ''))
}

/** 按平台清洗：B站留白名单表情码；抖音只留 unicode emoji；QQ/微信原样。 */
export function sanitizeFor(platform, text, faces) {
  const base = toPlain(text)
  if (platform === 'bilibili') return stripUnknownFaces(base, faces || readFaceCache() || BILI_FACES).replace(/\s{2,}/g, ' ').trim()
  if (platform === 'douyin') return stripUnknownFaces(base, []).replace(/\s{2,}/g, ' ').trim()
  return base
}

/** 当场画一张文字贴纸，返回图片路径（失败返回 null）。 */
export function ensureSelfSticker(caption, cfg) {
  const cap = String(caption || '').trim().slice(0, 16)
  if (!cap) return null
  const dir = path.join(STICKER_DIR, '自制')
  const hash = crypto.createHash('md5').update(cap).digest('hex').slice(0, 12)
  const out = path.join(dir, hash + '.png')
  if (fs.existsSync(out)) return out

  // v5 修死链路：原来这里写死 cfg.wechat.python（D:/wechat-bot/.venv/...），
  // 容器里那个文件不存在 → 恒返 null，"AI 画不出来就退 PIL 文字贴纸"从未生效。
  //
  // 现在的降级链（每一级都实测过）：
  //   ① ffmpeg + 中文字体（容器自带，零新增依赖）—— 主路径
  //   ② python + PIL（如果哪天真的装了）
  //   ③ 都没有 → 明确记一条 swallow，让 diagnose 的"吞错留痕"能看见
  const viaFfmpeg = renderSticker(cap, out)
  if (viaFfmpeg) return viaFfmpeg

  const py = pythonFor(['PIL'])
  if (!py.ok) {
    // 只在第一次说清楚，之后保持安静（这是个降级路径，不该刷日志）
    if (!ensureSelfSticker._warned) {
      ensureSelfSticker._warned = true
      try { swallow(new Error(py.why), 'stickers:no-python') } catch { /* ignore */ }
    }
    return null
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    execFileSync(py.bin, [RENDERER, cap, out], { timeout: 25000, stdio: 'ignore', windowsHide: true })
    return fs.existsSync(out) ? out : null
  } catch (e) {
    try { swallow(e, 'stickers:render-failed') } catch { /* ignore */ }
    return null
  }
}

/**
 * 找"能画图"的 python（要 PIL），带缓存。
 * 抽成函数是为了让 diagnose 也能调用同一套判定 —— 面板说"自制表情不可用"时，
 * 原因必须和这里一致，不能两套说法。
 */
export function pythonFor(mods = ['PIL']) {
  try {
    return findPythonWith(mods)
  } catch (e) {
    return { ok: false, bin: '', why: String(e?.message || e), missing: mods }
  }
}

/** 自制贴纸现在能不能用（diagnose 与面板问同一句，避免两套说法）。 */
export function selfStickerAvailable() {
  const ff = stickerRendererAvailable()
  if (ff.ok) return { ok: true, via: 'ffmpeg', detail: ff.font }
  const py = pythonFor(['PIL'])
  // ⚠️ v5 自测发现的不一致：这里曾经只看"python 能跑 + 有 PIL"就报 ok，
  // 但渲染分支还需要 **sticker_render.py 里那些 Windows 字体**（msyh.ttc 等）。
  // 在没有那些字体的机器上 → available() 说"可用"，ensureSelfSticker 却返回 null。
  // 诊断与实际行为必须同源：所以这里连"渲染脚本能不能真跑通"一起验。
  if (py.ok) {
    const fontOk = (() => {
      try {
        // sticker_render.py 的 FONTS 只认 Windows 路径；这里做同样的检查
        const winFonts = ['C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc']
        return winFonts.some((p) => fs.existsSync(p))
      } catch { return false }
    })()
    if (fontOk) return { ok: true, via: 'python', detail: py.bin }
    return { ok: false, via: '', detail: 'ffmpeg 路线不可用（' + (ff.why || '') + '）；python 有 PIL 但 sticker_render.py 需要 Windows 字体，本机没有' }
  }
  return { ok: false, via: '', detail: ff.why + '；' + (py.why || '') }
}

/** 注入 prompt 的「发表情规矩」。 */
export function stickerPrompt(platform = 'qq') {
  const canImage = platform === 'qq' || platform === 'wechat'
  const tags = availableTags()
  const lines = ['【表情的规矩】聊得轻松时，**大约一半的回复要带一个颜文字或 emoji**（(๑•̀ㅂ•́)و✧ / 😴 / (・_・;) / 哈哈 / 嘿嘿）。别一句都不带，也别每句都带。']

  if (canImage) {
    lines.push(`情绪到点的时候，直接在回复句尾写 [表情:标签]（标签：${tags.join('/')}）发一张图，一次最多一个。`)
    lines.push('想要更贴的图就写 [自制表情:不超过八个字的短句]（比如 [自制表情:本鱼饿了]）——会现场画一张只属于这句话的专属表情包，勇敢用，图库还会越用越丰富。')
  } else if (platform === 'bilibili') {
    const live = readFaceCache() || BILI_FACES
    const faces = BILI_FACES.filter(f => live.includes(f)).slice(0, 10)   // 按精选顺序，别按面板顺序
    lines.push('这里是B站评论区，发不了图片，但可以用B站自带表情码，只能用这些：' +
      faces.map(f => `[${f}]`).join(' ') + '（一条最多一个，写在句尾自然的位置）。')
  } else {
    lines.push('这里是抖音评论区，只有 emoji 和颜文字，不要写 [xx] 这种方括号表情码，也不要用 [表情:…]。')
  }
  return lines.join('\n')
}

/** 没图时按标签给个颜文字兜底（发送失败降级用）。 */
export const FACE_FALLBACK = {
  开心: '(๑˃̵ᴗ˂̵)و', 无语: '(・_・;)', 委屈: '(｡•́︿•̀｡)',
  生气: '(╯°□°）╯', 困: '(－_－) zzZ', 比心: '(♡˙︶˙♡)',
}

// 情绪线索 → 标签。顺序有讲究：先认具体情绪，"开心"放最后当兜底。
// 注意别用颜文字当线索 —— 她几乎每条都挂 (・_・;)，那会让所有回复都判成"无语"。
const TAG_HINTS = [
  ['委屈', /委屈|可怜|难过|伤心|眼泪|欺负我|呜呜|嘤/],
  ['生气', /生气|讨厌|过分|气死|烦人/],
  ['困', /困死|好困|我困|困了|想睡|睡觉|熬夜|哈欠/],
  ['无语', /无语|服了|离谱|尴尬|我晕|算了|没眼看/],
  ['比心', /比心|爱你|最喜欢|谢谢|抱抱|亲亲|喜欢主人/],
  ['开心', /好吃|好香|馋|哈哈|嘿嘿|开心|太好了|值了|香死|下饭|真香/],
]

/**
 * 按她自己那句话的情绪挑一个标签 —— 摇中了要发图、但她没写标记时的兜底。
 * 10-25 实验记录：stickerChance=0.5、17:01 之后七八条回复一张图都没发出去，
 * 因为"必须带标记"只靠模型自觉；这里改成代码兜底，摇中就一定有机会落到图上。
 */
export function autoTag(text, random = Math.random) {
  // 去掉颜文字/括号/方括号里的装饰，只看正文的情绪词
  const t = String(text || '').replace(/\([^()]{0,14}\)|（[^（）]{0,14}）|\[[^\]]{0,20}\]|【[^】]{0,20}】/g, ' ')
  const tags = availableTags()
  if (!tags.length) return null
  for (const [tag, re] of TAG_HINTS) if (tags.includes(tag) && re.test(t)) return tag
  // 认不出情绪时**别乱发"生气/委屈"**（10-25：她一句"越看越饿，你饭到底吃了没"配了张生气图，很怪）
  const pref = ['开心', '无语', '比心'].filter(t2 => tags.includes(t2))
  const pool = pref.length ? pref : tags
  return pool[Math.floor(random() * pool.length) % pool.length]
}
