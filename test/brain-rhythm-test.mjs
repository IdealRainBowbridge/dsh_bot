// brain/rhythm 测试：昼夜曲线的形状（谷 4 点/峰 20 点/不对称/午后下陷）、
// 光照推相位（晚光后移/晨光前移）、睡醒记账、habit/snapshot 字段。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-brain-rhythm-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const rhythm = await import('../tools/brain/rhythm.mjs')

// ① 昼夜曲线的形状：谷 4 点、峰 20 点，中间单调爬升（10 点在两者之间）
ok('凌晨 4 点是谷底（≈0）', rhythm.circadian(4) < 0.1, String(rhythm.circadian(4)))
ok('晚上 20 点是峰值（≈1）', rhythm.circadian(20) > 0.9, String(rhythm.circadian(20)))
ok('谷与峰之间单调爬升（10 点在中间）',
  rhythm.circadian(4) < rhythm.circadian(10) && rhythm.circadian(10) < rhythm.circadian(20),
  `10点=${rhythm.circadian(10)}`)
// 午后下陷：14 点明显低于 16 点（下陷中心在 14）
ok('午后 14 点有下陷（低于 16 点）', rhythm.circadian(14) < rhythm.circadian(16),
  `14点=${rhythm.circadian(14)} 16点=${rhythm.circadian(16)}`)
ok('输出夹在 [0,1]', [0, 4, 8, 12, 14, 20, 23].every((h) => rhythm.circadian(h) >= 0 && rhythm.circadian(h) <= 1))

// ② 光照推相位：傍晚的光后移，清晨的光前移
const nightOf = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() }
let st = rhythm.expose('light', 60, nightOf(22))
ok('夜里 22 点的光 → 相位后移（>0）', st.phaseMin > 0, String(st.phaseMin))
const phaseAfterNight = st.phaseMin
st = rhythm.expose('light', 60, nightOf(7))
ok('清晨 7 点的光 → 相位前移', st.phaseMin < phaseAfterNight, `${phaseAfterNight} -> ${st.phaseMin}`)

// ③ 睡/醒记账：awake 返回实际睡眠小时数
const HOUR = 3_600_000
const t0 = Date.now()
rhythm.asleep(t0 - 7 * HOUR)
const slept = rhythm.awake(t0)
ok('睡 7 小时醒来 → awake 返回 7', Math.abs(slept - 7) < 0.02, String(slept))

// ④ habit 字段形状（history 只能靠 asleep/awake 打点，这里只验形状与样本计数）
const hb = rhythm.habit({})
ok('habit 返回 sleepAt/wakeAt/samples/strength',
  typeof hb.sleepAt === 'number' && typeof hb.wakeAt === 'number'
  && typeof hb.samples?.sleep === 'number' && typeof hb.strength === 'number')
ok('habit 记到了刚才的睡/醒样本', hb.samples.sleep >= 1 && hb.samples.wake >= 1,
  JSON.stringify(hb.samples))

// ⑤ snapshot 全貌字段齐
const snap = rhythm.snapshot(Date.now())
ok('snapshot 含 phaseMin/phaseHours/circadian/sleepPressure',
  ['phaseMin', 'phaseHours', 'circadian', 'sleepPressure'].every((k) => typeof snap[k] === 'number'))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ brain-rhythm 全部通过')
process.exit(bad ? 1 : 0)
