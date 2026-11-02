// avatar —— 她自己的 QQ 头像（2026-11-02）
//
// 为什么做：她原来对自己的形象只有 persona.md 里的文字描述（"蓝色的鲸鱼娘，圆滚滚"），
// 但那是**设定**，不是她实际挂出去的那张脸。用户问"能不能识别自己的头像"，
// 本质是问：她知不知道自己现在长什么样、挂的是哪张图。
//
// 做法：QQ 头像有公开 CDN 规则，不需要任何 API/登录：
//   https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=640
// 容器内可直连（实测 200 / 40KB）。下载后缓存到 ~/.bot-ai/avatar/，
// 文件存在就不重复下（除非超过 7 天）。图片本体可以随消息一起给视觉模型看。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'

const CACHE_DAYS = 7

function avatarDir() {
  const d = dataPath('avatar')
  try { fs.mkdirSync(d, { recursive: true }) } catch (e) { swallow(e, 'avatar:mkdir') }
  return d
}

/** 头像文件路径（不下载）。 */
export function avatarPath(qq) {
  return path.join(avatarDir(), `qq-${String(qq).replace(/\D/g, '')}.jpg`)
}

/**
 * 确保头像已缓存，返回本地路径；失败返回 null（不抛）。
 * @param {string|number} qq
 * @param {{force?:boolean}} opts
 */
export async function ensureAvatar(qq, opts = {}) {
  const id = String(qq || '').replace(/\D/g, '')
  if (!id) return null
  const file = avatarPath(id)
  try {
    const st = fs.existsSync(file) ? fs.statSync(file) : null
    const fresh = st && st.size > 1000 && (Date.now() - st.mtimeMs) < CACHE_DAYS * 86400_000
    if (fresh && !opts.force) return file
    const url = `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!r.ok) return st ? file : null
    const b = Buffer.from(await r.arrayBuffer())
    if (b.length < 1000) return st ? file : null
    fs.writeFileSync(file, b)
    return file
  } catch (e) { swallow(e, 'avatar:fetch'); return fs.existsSync(file) ? file : null }
}

/**
 * 她自己的头像路径 + 一行描述，给提示词用。
 * 只在她自己问起"我头像"或用户问时才有意义 —— 平时不注入，省 token。
 */
export async function selfAvatar(cfg) {
  const selfQQ = String(cfg?.qq?.selfQQ || cfg?.qq?.self_qq || '').replace(/\D/g, '')
  // 没配 selfQQ 时，从 napcat_http 那侧拿不到，直接放弃（不猜）
  if (!selfQQ) return null
  const file = await ensureAvatar(selfQQ)
  if (!file) return null
  return { qq: selfQQ, file }
}

/** 头像缓存状态（diagnose 用）。 */
export function avatarStatus(qq) {
  const f = avatarPath(qq)
  try {
    const st = fs.statSync(f)
    return { file: f, bytes: st.size, at: new Date(st.mtimeMs).toISOString() }
  } catch { return { file: f, exists: false } }
}
