//
// watchlog 的回归测试（2026-11-02）
//
// 这条「专门看 B 站的眼睛」有三个必须钉死的性质，每一个都对应过一次真实问题：
//
//   ① **只聊真看明白的部分**：没看懂的一集不能冒充"上一集内容"，
//      也不能说成"看到第 N 集"。实测踩过：第 3 集没看懂（plot="这条看不到剧情"），
//      它把第 2 集的真内容整个盖掉了。
//   ② **剧名要归一**：`binge --bvid` 传进来的是完整视频标题，
//      不处理的话注入区块里会写「《一口气看完【可塑性记忆》，记忆是可塑性的…》」，
//      读起来像文件路径而不是一部剧。
//   ③ **过期要消失**：三天前看的剧不该一直占着 system 的预算。
//      但她"记得看过"（memory 里那条）不该跟着丢 —— 这两件事分开管。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ⚠️ 隔离必须在 **import watchlog 之前**：它 import paths.mjs，dataDir 是导入时求值的常量。
//    2026-11-02 踩过：这一行漏了，测试直接读写 /home/feiyu/.data/brain/watch-log.json，
//    跑一次就把她的真实观看账本 reset() 清空了。
//    paths.mjs 头注释里写着 10-27 的同类教训（把真记忆库写成两条假数据），我又犯了一次。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-watchlog-'))
process.env.BOT_DATA_DIR = TMP

const W = await import('../tools/lib/watchlog.mjs')

const now = Date.now()
const H = 3600_000

// ── 1. 空账本：区块必须是空串（不是一段空壳文字）────────────────────────
W.reset()
assert.equal(W.promptBlock({ now }), '', '没看过东西时不该产出区块')
assert.deepEqual(W.stats(), { shows: 0, rows: 0, lastAt: 0 })

// ── 2. 基本记录 + 区块内容 ───────────────────────────────────────────────
W.record({
  show: '可塑性记忆', ep: 1, bvid: 'BV1aa', title: '可塑性记忆 第1集',
  plot: '司进入机器人回收公司，与艾拉成为搭档。',
  feel: '看完心里堵得慌。', via: '台词356句', durMin: 53, ok: true, at: now - 3 * H,
})
let b = W.promptBlock({ now })
assert.ok(b.includes('【我在B站看了什么】'), '区块要有标题')
assert.ok(b.includes('可塑性记忆'), '要出现剧名')
assert.ok(b.includes('第 1 集讲的'), '要带上剧情')
assert.ok(b.includes('看完心里堵得慌'), '要带上她的感受')
// 人称必须是第一人称（这是她的经历，不是系统汇报）
assert.ok(b.includes('我自己看过'), '要用第一人称')

// ── 3. 没看懂的一集不能盖掉看懂了的那一集（真实踩过的 bug）─────────────
W.record({
  show: '可塑性记忆', ep: 2, bvid: 'BV1bb', title: '第2集',
  plot: '回收妮娜，老婆婆不肯放手。', feel: '妮娜那句我一直记着。', ok: true, at: now - 2 * H,
})
W.record({
  show: '可塑性记忆', ep: 3, bvid: 'BV1cc', title: '第3集',
  plot: '这条看不到剧情', feel: '', via: '只有简介', ok: false, at: now - 1 * H,
})
b = W.promptBlock({ now })
assert.ok(b.includes('第 2 集讲的'), `有没看懂的更新记录时，仍要取最后一条**看懂**的：\n${b}`)
assert.ok(!b.includes('这条看不到剧情'), `不许把"看不到剧情"当成上一集内容：\n${b}`)
assert.ok(b.includes('没真看懂'), '要标出哪次没真看懂')
// 「看到第几集」必须是看懂的那一集，不能说"看到第 3 集"
assert.ok(b.includes('看到第 2 集'), `"看到第几集"要说看懂了的那一集：\n${b}`)
assert.ok(!b.includes('看到第 3 集'), `没看懂的第 3 集不能说成"看到"：\n${b}`)

// ── 4. 剧名归一：完整视频标题要抽出真正的剧名 ────────────────────────────
W.reset()
W.record({
  show: '一口气看完【可塑性记忆】，记忆是可塑性的，回忆是永恒的',
  ep: 1, title: '同上', plot: '测试', ok: true, at: now,
})
assert.equal(W.recentShows({ now })[0].name, '可塑性记忆', '要从【】里抽出剧名')

W.reset()
W.record({
  show: '【全748集】目前B站最全最细的Agent开发零基础全套教程，2026最新版',
  ep: 1, title: '同上', plot: '测试', ok: true, at: now,
})
const n2 = W.recentShows({ now })[0].name
assert.ok(!/^全748集$/.test(n2), `不许把"全748集"这种计数当剧名，实际得到了「${n2}」`)

// ── 5. 过期消失（但她"记得"不等于"此刻在看"）──────────────────────────
W.reset()
W.record({ show: '老剧', ep: 1, plot: '很久以前看的', ok: true, at: now - 100 * H })
assert.equal(W.promptBlock({ now }), '', '超过 72 小时不该再进上下文')
// 但账本还在（她还能"想起来"）
assert.equal(W.stats().rows, 1, '记录本身要留着，只是不注入')

// ── 6. 多部剧：按最后观看时间倒序，最多 2 部 ─────────────────────────────
W.reset()
W.record({ show: '剧A', ep: 1, plot: 'A1', ok: true, at: now - 5 * H })
W.record({ show: '剧B', ep: 1, plot: 'B1', ok: true, at: now - 2 * H })
W.record({ show: '剧C', ep: 1, plot: 'C1', ok: true, at: now - 1 * H })
b = W.promptBlock({ now })
assert.ok(b.includes('剧C') && b.includes('剧B'), '要按最近观看取前两部')
assert.ok(!b.includes('剧A'), '第三部（最旧）不该进来')

// ── 7. 同一集重复记录不重复计数 ─────────────────────────────────────────
W.reset()
W.record({ show: '剧X', ep: 1, plot: 'x', ok: true, at: now - 2 * H })
W.record({ show: '剧X', ep: 1, plot: 'x', ok: true, at: now - 1 * H })
assert.equal(W.recentShows({ now })[0].episodes, 1, '同一集看两次仍算 1 集')

// ── 8. 无剧名时安静拒绝（不写脏数据）──────────────────────────────────
W.reset()
const r = W.record({ plot: '没有剧名', ok: true })
assert.equal(r.ok, false, '没有剧名要拒绝')
assert.equal(W.stats().rows, 0, '拒绝时不能留下半条记录')

W.reset()
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
console.log('✓ watchlog-test 全部通过（空账本/内容/没看懂不冒充/剧名归一/过期/排序/去重/拒绝）')
