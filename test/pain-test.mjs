// 痛觉测试（2026-11-03 · B4）
//
// 器官判据（M58）：
//   ① 快痛：新伤口登记 → stress 通路 + hpa 脉冲（缩手反射）
//   ② 敏化：复发伤 severity 更高
//   ③ 基线：进程启动时的历史伤不集体喊疼（首调只建基线）
//   ④ 慢痛：开放伤口 → 钝痛感；化脓 → 更重的措辞；愈合 → 钝痛即停
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-pain-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

const wound = await import('../tools/lib/wound.mjs')
const pain = await import('../tools/brain/organ/pain.mjs')
const field = await import('../tools/brain/field.mjs')

// ── ① 基线：进程内已有的伤（wound-test 共用数据目录隔离，这里是空的）──
{
  const r = pain.tick()
  assert.equal(r, null, '空账本：无快痛')
  const r2 = pain.tick()
  assert.equal(r2, null, '基线已建：仍无快痛')
}

// ── ② 快痛 + 复发敏化 ──
{
  // 第一次登记 fbX（进程内新伤）→ 快痛
  wound.register('熔断', 'fbX', 'HTTP 429')
  const r1 = pain.tick()
  assert.ok(r1 && r1.sharp && r1.sharp.subject.includes('fbX'), '新伤 → 快痛触发')
  const sev1 = r1.sharp.severity
  // 愈合（留瘢痕）后再犯 → 敏化
  wound.closeIfHealed('修复 fbX')
  wound.register('熔断', 'fbX', '同一个坑再摔')
  const r2 = pain.tick()
  assert.ok(r2 && r2.sharp && r2.sharp.severity > sev1, '复发伤因敏化更痛: ' + sev1 + ' → ' + (r2 && r2.sharp && r2.sharp.severity))
}

// ── ③ 慢痛：开放 → 钝痛；愈合 → 停 ──
{
  wound.register('门禁', 'test-file 超行', 'FILE_LIMIT')
  const a = pain.acheSense()
  assert.ok(a.includes('痛'), '开放伤口 → 钝痛感: ' + a)
  assert.ok(field.sense().includes('痛'), '钝痛进入第一人称身体感')
  wound.closeIfHealed('门禁全绿')
  const b = pain.acheSense()
  assert.equal(b, '', '愈合 → 钝痛即停（不背着旧伤喊疼）')
  assert.ok(!field.sense().includes('隐隐作痛'), '身体感恢复')
}

// ── ④ 化脓措辞更重 ──
{
  wound.register('熔断', 'fbY', '超时')
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'wounds.json'), 'utf8'))
  raw.wounds.find((w) => w.subject === 'fbY').openedAt = Date.now() - 7 * 3600_000
  fs.writeFileSync(path.join(TMP, 'wounds.json'), JSON.stringify(raw))
  wound.tick(Date.now() + 20_000)   // 触发化脓（推进 now 跳过 10s 缓存）
  const s = pain.acheSense()
  assert.ok(s.includes('一抽一抽'), '化脓 → 重措辞: ' + s)
}

console.log('pain-test: 4 组断言全过（基线/快痛敏化/慢痛愈合即停/化脓重措辞）')
