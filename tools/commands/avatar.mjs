// avatar —— 看自己（或老爸）的 QQ 头像（2026-11-02）
//
//   node bot.mjs avatar           # 看自己的头像 → 用视觉模型描述出来
//   node bot.mjs avatar --owner   # 看主人的头像
//   node bot.mjs avatar --refresh # 强制重新下载（换了头像时用）
//   node bot.mjs avatar --path    # 只给文件路径，不调模型
//
// 她的用法：老爸问"你头像呢/你长什么样"→ 自己真看一眼再答，
// 不要拿 persona.md 里那段文字描述当答案（那是设定，不一定等于挂出去的脸）。
import * as A from '../lib/avatar.mjs'
import { config } from '../lib/config.mjs'

const has = (n) => process.argv.includes(n)

export async function run(argv) {
  const cfg = config()
  const wantOwner = has('--owner')
  const qq = wantOwner
    ? String(cfg.owner?.qq || '').replace(/\D/g, '')
    : String(cfg.qq?.selfQQ || '').replace(/\D/g, '')

  if (!qq) {
    console.error(wantOwner
      ? '不知道主人的QQ号（config.owner.qq 没配）'
      : '不知道我自己的QQ号（config.qq.selfQQ 没配）—— 跟老爸说一声')
    process.exit(1)
  }

  const file = await A.ensureAvatar(qq, { force: has('--refresh') })
  if (!file) {
    console.error(`头像下载失败（QQ ${qq}）—— 可能是网络不通，或者这个号没设头像`)
    process.exit(1)
  }

  if (has('--path')) { console.log(file); return }

  // 默认：真看一眼再描述（走 vision 模型）
  try {
    const { dataUri, visionOn } = await import('../lib/vision.mjs')
    if (!visionOn()) {
      console.log(`头像文件：${file}`)
      console.log('（视觉模型没开，只能给你路径，看不了内容）')
      return
    }
    const llm = await import('../lib/llm.mjs')
    const r = await llm.chat([
      { role: 'user', content: [
        { type: 'text', text: '这是什么？用两三句话说清楚画面内容：主体、配色、画风、有没有文字。' },
        { type: 'image_url', image_url: { url: dataUri(file) } },
      ] },
    ], { max_tokens: 200, timeoutMs: 45000, purpose: 'vision' })
    console.log(String(r?.content ?? r).trim())
    console.log(`\n（文件：${file}）`)
  } catch (e) {
    console.log(`头像文件在 ${file}，但看图失败了：${String(e.message).slice(0, 120)}`)
  }
}
