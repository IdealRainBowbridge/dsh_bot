// bili-del —— 删除她自己的投稿（B站稿件）。归属：糖鲸大肥鱼的号，她管自己的稿。
// 用法：node feiyu.mjs bili-del <BV号或aid> [--go]（默认干跑，--go 真删）
import { loadCred } from '../lib/cred.mjs'
import { makeHeaders } from '../lib/bili-api.mjs'
import * as W from '../lib/bili-write.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

async function delArchive(cred, aid) {
  const r = await fetch('https://member.bilibili.com/x/vu/web/del?csrf=' + cred.bili_jct, {
    method: 'POST',
    headers: { ...makeHeaders(cred), 'content-type': 'application/x-www-form-urlencoded', referer: 'https://member.bilibili.com/platform/upload/video/frame', origin: 'https://member.bilibili.com', 'user-agent': UA },
    body: new URLSearchParams({ aid: String(aid), csrf: cred.bili_jct }),
    signal: AbortSignal.timeout(20000),
  })
  return await r.json().catch(() => ({}))
}

export async function run(argv) {
  // 10-31 实测：删除操作被 B站 Gaia 人机验证锁死（网页走到验证弹窗，headless 过不去）。
  // 所以这个命令的作用 = 查稿 + 生成给笨蛋老爹的删除请求文案（他手动删）。
  console.log("ℹ 删除稿件需要 B站人工验证（脚本无法绕过）。流程：本命令查出信息 → 你把下面的文案发到 QQ 给笨蛋老爹 → 他手动删。
")
  const target = argv.find((a) => !a.startsWith('--'))
  if (!target) { console.error('用法：bili-del <BV号|aid> [--go]'); process.exit(2) }
  let aid = Number(target)
  if (!aid && /^BV/i.test(target)) {
    const info = await W.videoInfo(target).catch(() => null)
    if (!info?.aid) { console.error('✗ 查不到 ' + target); process.exit(1) }
    aid = info.aid
    console.log('『' + info.title + '』 aid=' + aid)
  }
  if (!argv.includes('--go')) { console.log('【干跑】将删除 aid=' + aid + '（加 --go 真删）'); return }
  const cred = loadCred()
  const j = await delArchive(cred, aid)
  if (j?.code === 0) console.log('✓ 已删除 aid=' + aid)
  else console.error('✗ 删除失败 code=' + j?.code + ': ' + (j?.message || ''))
}
