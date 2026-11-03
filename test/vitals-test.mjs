// vitals-test —— B8 内感受的行为锚
//
// 测六件事：
//   ① assess 纯函数：阈值跨越 → entered + 快感；回落带滞回 → 不抖
//   ② 滞回：85% 上方抖动 ±2 个点不反复触发
//   ③ 峰值留痕
//   ④ sense/llmState 状态机：crossed 决定体感与表达
//   ⑤ tick 集成：真实容器体征可读、状态可落盘（真 statfs 路径）
//   ⑥ 永不抛错
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-vitals-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const V = await import(pathToFileURL(path.join(APP, 'tools/brain/organ/vitals.mjs')).href)
const NOW = 1793699000000
const mkV = (disk) => ({ at: NOW, disk: { used: disk, freeB: 1e9 }, load: { ratio: 0.3, cores: 4 }, mem: { used: 0.5 }, cgroupMem: null })

try {
  // ① 阈值跨越
  let r = V.assess(mkV(0.80), V.assess ? { crossed: {}, peaks: {} } : {}, NOW)
  r = V.assess(mkV(0.80), { crossed: {}, peaks: {} }, NOW)
  ok('80% 无事件', r.entered.length === 0 && !r.sharp)
  r = V.assess(mkV(0.86), { crossed: {}, peaks: {} }, NOW)
  ok('86% → 跨过 diskWarn', r.entered.includes('diskWarn') && r.sharp && r.sharp.subject.includes('堆'))
  r = V.assess(mkV(0.93), { crossed: { diskWarn: NOW }, peaks: {} }, NOW)
  ok('93% → 跨过 diskHigh（更疼）', r.entered.includes('diskHigh') && r.sharp.severity === 0.55)
  r = V.assess(mkV(0.975), { crossed: { diskWarn: NOW, diskHigh: NOW }, peaks: {} }, NOW)
  ok('97.5% → 跨过 diskCrit（最疼）', r.entered.includes('diskCrit') && r.sharp.severity === 0.9)

  // ② 滞回：86% 触发后，在 85% 线附近抖动不反复
  let st = { crossed: { diskWarn: NOW }, peaks: { disk: 0.87 } }
  r = V.assess(mkV(0.84), st, NOW + 1)          // 低于阈值但在滞回带内
  ok('84%（滞回带内）不消除', r.cleared.length === 0 && r.entered.length === 0)
  r = V.assess(mkV(0.855), { ...st, crossed: {} }, NOW + 1)   // 已清除后再上探
  ok('82% 清除后 85.5% 再触发（一次性，不循环疼）', r.entered.includes('diskWarn') && !!r.sharp)
  // 清除需要严格低于 阈值-3pt = 82%（带内不清：恰好 0.82 还算"在胀"）
  r = V.assess(mkV(0.82), { crossed: { diskWarn: NOW }, peaks: {} }, NOW + 2)
  ok('恰好 82% 仍在滞回带内（边界不清）', r.cleared.length === 0)
  r = V.assess(mkV(0.81), { crossed: { diskWarn: NOW }, peaks: {} }, NOW + 2)
  ok('81% 才清除（滞回带宽 3pt）', r.cleared.includes('diskWarn'))

  // ③ 峰值留痕
  r = V.assess(mkV(0.90), { crossed: {}, peaks: { disk: 0.86 } }, NOW)
  ok('峰值更新到 90%', r.next.peaks.disk === 0.90)

  // ④ sense/llmState 状态机（写状态文件驱动）
  const stFile = path.join(tmp, 'brain', 'meta', 'vitals.json')
  fs.mkdirSync(path.dirname(stFile), { recursive: true })
  fs.writeFileSync(stFile, JSON.stringify({ at: NOW, crossed: { diskHigh: NOW }, peaks: { disk: 0.93 } }))
  const s1 = V.sense()
  ok('diskHigh → 胀感', s1.length === 1 && s1[0].includes('满满当当'), JSON.stringify(s1))
  const l1 = V.llmState()
  ok('diskHigh → llmState 收着说', !!l1 && l1.temperature === -0.08, JSON.stringify(l1))
  fs.writeFileSync(stFile, JSON.stringify({ at: NOW, crossed: { diskCrit: NOW }, peaks: { disk: 0.98 } }))
  ok('diskCrit → 重胀感', V.sense()[0].includes('房顶'))
  fs.writeFileSync(stFile, JSON.stringify({ at: NOW, crossed: {}, peaks: {} }))
  ok('无 crossed → sense 安静（低预算提前感知那条除外）', V.sense().length === 0)
  ok('无 crossed → llmState null', V.llmState() === null)

  // ⑤ tick 集成（真实读 statfs——测试沙箱在容器 overlay 上，使用率低，应无快感）
  const sharp = V.tick()
  ok('tick() 低水位无快感', sharp === null, JSON.stringify(sharp))
  const saved = JSON.parse(fs.readFileSync(stFile, 'utf8'))
  ok('tick() 落盘了峰值（沙箱盘的真实读数）', saved.peaks && saved.peaks.disk > 0 && saved.peaks.disk < 1, JSON.stringify(saved.peaks))

  // ⑥ snapshot 与 read（不锚生产数字：0<pct<100 即真读到了）
  const snap = V.snapshot()
  ok('snapshot 可读', !!snap && snap.diskUsedPct > 0 && snap.diskUsedPct < 100 && typeof snap.loadRatio === 'number', JSON.stringify(snap))

  // ⑦ 永不抛错：把状态文件写成垃圾
  fs.writeFileSync(stFile, '{oops')
  ok('状态文件坏 → sense 不炸', Array.isArray(V.sense()))
  ok('状态文件坏 → llmState 不炸', V.llmState() === null || typeof V.llmState() === 'object')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 兜底 */ }
}

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ vitals 全绿')
process.exitCode = bad ? 1 : 0
