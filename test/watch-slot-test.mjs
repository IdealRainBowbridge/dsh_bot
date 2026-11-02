// watch-slot-test —— 「她在B站看了什么」必须进**实际聊天**用的那套装配
//
// 背景（M60 记过、这次又踩到）：
//   brain/assemble 和 lib/persona.buildMessages 是**两条装配路线**。
//   brain.mode 默认 'shadow' → 实际聊天走 buildMessages，`assembleFor()` 返回 null。
//   watchlog 当初只接进了 assemble，于是"看她自己看了什么"这个功能
//   在线上**一次都没生效过**，而且两边都绿：
//     · assemble 单测过（走了 assemble 那条路）
//     · 门禁过（import 存在、没有断链）
//   只有真去 buildMessages 里找，才发现槽位不在。
//
// 这个测试锁：
//   ① QQ 私聊的 system 里必须有【我在B站看了什么】
//   ② 群聊里必须没有（念自己追的剧 = 泄露私事）
//   ③ 槽位内容必须来自真实账本（剧名/集数/剧情/感受）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchslot-'))
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
const P = await import('../tools/lib/persona.mjs')

const now = Date.now()
W.record({
  show: '可塑性记忆', ep: 2, bvid: 'BV1bb', title: '可塑性记忆 第2集',
  plot: '回收妮娜，老婆婆不肯放手，妮娜劝奶奶笑着送别。',
  feel: '妮娜那句趁现在大家笑着告别，我看得心里堵。',
  via: '台词400句', durMin: 24, ok: true, at: now - 3600_000,
})

// ── ① 私聊必须有 ────────────────────────────────────────────────────────
const priv = P.buildMessages({ platform: 'qq', userText: '你最近在看什么？', chatId: 'qq:3682285116', userId: '3682285116', turnsToday: 3 })
const sys = priv[0].content
ok(sys.includes('【我在B站看了什么】'), 'QQ 私聊 system 里有【我在B站看了什么】')
ok(sys.includes('可塑性记忆'), '槽位里有剧名')
ok(sys.includes('妮娜'), '槽位里有真实剧情（不是空壳）')

// ── ② 群聊必须没有 ──────────────────────────────────────────────────────
const grp = P.buildMessages({ platform: 'qq', userText: '大家好', chatId: 'qq:group1', userId: '1', isGroup: true })
ok(!grp[0].content.includes('【我在B站看了什么】'), '群聊里没有这个槽位（不泄露私事）')

// ── ③ 空账本时不该硬塞空块 ──────────────────────────────────────────────
W.reset()
const empty = P.buildMessages({ platform: 'qq', userText: '在吗', chatId: 'qq:3682285116', userId: '3682285116', turnsToday: 1 })
ok(!empty[0].content.includes('【我在B站看了什么】'), '账本为空时不注入空块')

fs.rmSync(TMP, { recursive: true, force: true })
if (failed) {
  console.log(`\n✗ watch-slot-test 有 ${failed} 项失败`)
  process.exit(1)
}
console.log('\n✓ watch-slot-test 全部通过')
