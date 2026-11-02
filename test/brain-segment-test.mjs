// brain/segment 测试：话题指纹与重叠率、切段信号（时间断层/结束语）、
// 短句宽容（短句天然 2-gram 少，不该被误判换话题）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-segment-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const seg = await import('../tools/brain/segment.mjs')
const HOUR = 3_600_000
const now = Date.now()

// ① 指纹与重叠
const a = seg.fingerprint('今天加班到十点真的好累')
const b = seg.fingerprint('加班累死了想休息')
const c = seg.fingerprint('明天我们去吃火锅吧好不好')
ok('同话题两句话重叠率显著高于换话题', seg.overlap(a, b) > seg.overlap(a, c),
  `同题=${seg.overlap(a, b).toFixed(2)} 换题=${seg.overlap(a, c).toFixed(2)}`)
ok('空文本指纹是空集合', seg.fingerprint('').size === 0)
ok('overlap 任一为空 → 0', seg.overlap(a, new Set()) === 0)
ok('nouns 排掉虚词组合', seg.nouns('的了是吗我你他').length === 0)

// ② shouldCut：时间断层
ok('没开的段 → no-open', seg.shouldCut(null, {}, now) === 'no-open')
ok('隔 2 小时 → gap', seg.shouldCut({ lastAt: now - 3 * HOUR }, { text: '在吗' }, now) === 'gap')
ok('刚说完话 → 不断', seg.shouldCut({ lastAt: now - 5 * 60_000 }, { text: '然后呢' }, now) === null)

// ③ 结束语：上一条是结束语 → 新的一条切新段（触发原因是 ending，不是 topic）
ok('上一条是晚安 → 新一条进来切段为 ending',
  seg.shouldCut({ lastAt: now - 60_000, lastText: '晚安，我睡了' }, { text: '明天见' }, now) === 'ending')
// 本条自己是结束语 → 它属于这一段（尾巴），不切
ok('本条是结束语 → 不切（它是这段的尾巴）',
  seg.shouldCut({ lastAt: now - 60_000, lastText: '今天好累' }, { text: '我先去睡了' }, now) === null)

// ④ 短句宽容：短句换话题不该轻率地切（topicDropShort）
ok('短句几乎不判换话题',
  seg.shouldCut({ lastAt: now - 60_000, lastText: '我今天加班到十点累死了', turns: 8 }, { text: '哦这样' }, now) === null)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ brain-segment 全部通过')
process.exit(bad ? 1 : 0)
