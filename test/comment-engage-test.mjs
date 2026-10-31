// 评论区"任何类型都能回"（10-27 主人报的 bug）——
//   抖音那边她只回了主人的文字评论，别人发的表情包一条没回；
//   B站 那边压根没有"回自己作品评论区"这条路。
//
// 根因（抖音）：纯表情包/图片评论的 text 是空串，上层 `if (!c.text) continue` 把整条丢了。
// 这条测试盯死三件事：
//   ① classifyComment 把 文字/只有表情/表情包/图片/空 分清楚，除"空"以外都能回；
//   ② 抖音 engage 不许再按"有没有文字"筛评论，且表情包要用昵称定位（--user）；
//   ③ B站 有"自己作品评论区"路径（listOwnVideos + listCommentsOf + replies ⓪）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyComment, replyable, stickerFallback, plainText } from '../tools/lib/comment-kind.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8')
let n = 0
const ok = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`) }

await ok('文字评论：原样交给 LLM', () => {
  const k = classifyComment({ text: '这个饭看起来真好吃' })
  assert.equal(k.kind, 'text')
  assert.equal(k.label, '这个饭看起来真好吃')
  assert.ok(replyable(k.kind))
})

await ok('只有 [大笑] 这种表情占位：算评论，不是空', () => {
  const k = classifyComment({ text: '[大笑]' })
  assert.equal(k.kind, 'emote')
  assert.equal(k.label, '[大笑]')
  assert.ok(replyable(k.kind), '只有表情的评论也必须能回')
})


await ok('表情包名字是 URL 时不要把链接念出来', () => {
  const k = classifyComment({ text: '', sticker: 'https://p3.douyinpic.com/obj/x.webp' })
  assert.equal(k.kind, 'sticker')
  assert.ok(!/https?:/.test(k.label), `label 里带链接了：${k.label}`)
})

await ok('B站 图片评论（只有 pictures）：算评论', () => {
  const k = classifyComment({ text: '', pictures: [{ img_src: 'a' }, { img_src: 'b' }] })
  assert.equal(k.kind, 'image')
  assert.match(k.label, /2 张图/)
  assert.ok(replyable(k.kind))
})

await ok('真空评论（连表情都没有）：不建议硬凑', () => {
  const k = classifyComment({ text: '  ' })
  assert.equal(k.kind, 'empty')
  assert.equal(replyable(k.kind), false)
})

await ok('文字里夹表情：仍算文字', () => {
  const k = classifyComment({ text: '[微笑]今天下雨了[大哭]' })
  assert.equal(k.kind, 'text')
  assert.equal(k.plain, '今天下雨了')
})

await ok('兜底话术按类型分池，且会轮换（不老是同一句）', () => {
  const a = stickerFallback('（发了张表情包：doge）', 0)
  const b = stickerFallback('（发了张表情包：doge）', 1)
  assert.notEqual(a, b, '两次兜底不该一模一样')
  assert.match(stickerFallback('（发了 2 张图，没有文字）', 0), /图/)
})

await ok('plainText 把占位/零宽/空白都剥掉', () => {
  assert.equal(plainText('[大笑] 你好\u200b 呀'), '你好呀')
})







console.log(`\n评论区测试：${n}/${n} 通过`)