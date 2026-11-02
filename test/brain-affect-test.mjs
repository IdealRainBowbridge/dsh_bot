// brain/affect 测试：情绪混合/夹取、奖励只认兑现、tension 压力账、衰减、提示词行。
// 隔离与 brain-event-test 同款：env 先指沙箱，再动态 import。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-affect-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const affect = await import('../tools/brain/affect.mjs')

// ① 初始状态是空的平稳
let s = affect.state()
ok('初始状态：valence=0 / arousal=0.3 / tension=0', s.valence === 0 && s.arousal === 0.3 && s.tension === 0)

// ② feel：指数混合而不是覆盖（0.6 旧 + 0.4 新），且夹在 [-1,1]
s = affect.feel({ valence: 1, arousal: 1 })
ok('feel 后 valence = 0.4（0.6*0 + 0.4*1）', s.valence === 0.4, String(s.valence))
ok('feel 后 arousal = 0.58（0.6*0.3 + 0.4*1）', s.arousal === 0.58, String(s.arousal))
// 连续负向：向 -1 滑但不会一步到底
s = affect.feel({ valence: -1, arousal: 0 })
ok('连续 feel 向目标收敛', s.valence < 0 && s.valence > -1, String(s.valence))

// ③ tension：记压力账，reward 兑现后消账
affect.tension(2)
s = affect.state()
ok('tension(2) 后 = 2', s.tension === 2, String(s.tension))
const vBefore = s.valence
s = affect.reward({ weight: 1 })
ok('reward 后 tension 减 1', s.tension === 1, String(s.tension))
ok('reward 后 valence 上抬', s.valence > vBefore, `${vBefore} -> ${s.valence}`)
ok('reward 留了 log（可审计）', (s.log || []).some((x) => x.kind === 'reward'))

// ④ decay：向中性回归，不会反向过头（0.9 的每轮系数，-0.16 一轮 → -0.14）
affect.feel({ valence: -0.4, arousal: 0.3 })
const vHigh = affect.state().valence
const d = affect.decay(1)
ok('decay 让 valence 向 0 回归', Math.abs(d.valence) < Math.abs(vHigh), `${vHigh} -> ${d.valence}`)

// ⑤ line / sense：给人读的话，不带数字仪表盘
affect.tension(3)
const line = affect.line()
ok('line 提到压着的事', line.includes('3 件') || line.includes('压着'), line)
const sense = affect.sense()
ok('sense 是第一人称且不带小数', sense.startsWith('我') && !/[+-]?\d+\.\d+/.test(sense), sense)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ brain-affect 全部通过')
process.exit(bad ? 1 : 0)
