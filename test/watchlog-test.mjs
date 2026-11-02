// watchlog-test —— 「她在 B站看了什么」的账本（2026-11-02）
//
// 设计要点（用户原话）：
//   「能不能在看b站视频也做一个子通道，作为专门看b站的眼睛，看完后直接注入进
//    记忆里并在上下文里注入进她在b站上看了什么」
// 拆成三件事：① 子通道 ② 看完就落 ③ 上下文里稳定注入（不是靠召回碰运气）
//
// 这份账本和 memory.remember 的分工：
//   · 账本 = 结构化状态（我现在在看什么、看到第几集、上一集讲了啥）
//   · 记忆 = 对话流里的一条自然语言（她"想起来"时用）
//   两份回答不同问题，但**写入必须在同一处**（binge 里 record 和 remember 挨着写）。
//
// 这个测试锁四件事：
//   ① record / stats / recentShows 的基本形状
//   ② promptBlock 的内容：剧名、集数、剧情、感受
//   ③ ok:false（没真看懂）要在注入里**明确标出来** —— 否则她会把"只扫到简介"当成看过
//   ④ 72 小时外的旧记录不该注入（上下文预算有限）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlog-'))
process.env.BOT_DATA_DIR = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.HOME = TMP
process.env.USERPROFILE = TMP

let failed = 0
const ok = (cond, label) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label)
  if (!cond) failed++
}

const W = await import('../tools/lib/watchlog.mjs')
W.reset()

// ── ① 基本形状 ──────────────────────────────────────────────────────────
ok(W.stats().rows === 0, '初始为空')
const now = Date.now()
W.record({
  show: '可塑性记忆', ep: 1, bvid: 'BV1aa', title: '可塑性记忆 第1集',
  plot: '司进入机器人回收公司，与艾拉成为搭档，第一次回收老夫妇的"儿子"。',
  feel: '看完心里堵得慌。', via: '台词356句', durMin: 53, ok: true, at: now - 3 * 3600_000,
})
W.record({
  show: '可塑性记忆', ep: 2, bvid: 'BV1bb', title: '可塑性记忆 第2集',
  plot: '回收妮娜，老婆婆不肯放手，妮娜劝奶奶笑着送别。',
  feel: '妮娜那句趁现在大家笑着告别，我看得心里堵。', via: '台词400句', durMin: 24, ok: true, at: now - 2 * 3600_000,
})
W.record({
  show: '可塑性记忆', ep: 3, bvid: 'BV1cc', title: '可塑性记忆 第3集',
  plot: '这条看不到剧情', feel: '', via: '只有简介', durMin: 24, ok: false, at: now - 1 * 3600_000,
})
const st = W.stats()
ok(st.rows === 3, `记了 3 条（实际 ${st.rows}）`)
ok(st.shows === 1, `归并成 1 部剧（实际 ${st.shows}）`)

const shows = W.recentShows({ now })
ok(shows.length === 1 && shows[0].lastEp === 3, '最近在看的 = 可塑性记忆 第3集')

// ── ② promptBlock 内容 ──────────────────────────────────────────────────
const block = W.promptBlock({ now })
ok(block.includes('可塑性记忆'), '注入块里有剧名')
ok(block.includes('第 2 集'), '注入块里提到上一集（第 2 集，因为第 3 集没看懂）')
ok(block.includes('妮娜'), '注入块里有真实剧情')
ok(block.includes('心里堵'), '注入块里有她的感受')

// ── ③ ok:false 必须被标出来 ─────────────────────────────────────────────
ok(/没真看懂|只是扫到|别当成看过/.test(block), '没真看懂的那集被明确标注（不许当成看过）')

// ── ④ 72 小时外不注入 ───────────────────────────────────────────────────
const later = W.promptBlock({ now: now + 100 * 3600_000 })
ok(later === '', '72 小时外不注入（上下文预算）')

// ── ⑤ reset 真的清空 ────────────────────────────────────────────────────
W.reset()
ok(W.stats().rows === 0, 'reset 清空')

fs.rmSync(TMP, { recursive: true, force: true })
if (failed) {
  console.log(`\n✗ watchlog-test 有 ${failed} 项失败`)
  process.exit(1)
}
console.log('\n✓ watchlog-test 全部通过')
