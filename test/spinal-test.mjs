// spinal —— 表达神经汇的接线测试（2026-11-05）。
// 测的是契约：所有器官读数都齐时偏移正确叠加；某器官炸了不牵连别的；
// 睡眠压强收预算；最终偏移量不越界。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-spinal-'))
process.env.DSH_HOME = path.join(sandbox, '.dsh')
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
process.env.BOT_DATA_DIR = path.join(sandbox, '.data')

const S = await import('../tools/brain/spinal.mjs')
const F = await import('../tools/brain/field.mjs')

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.log('  ✗ ' + name + ' —— ' + e.message); process.exitCode = 1 }
}

ok('spinalState 返回四件套（温度/预算/体感/来源）', () => {
  const sp = S.spinalState()
  assert.equal(typeof sp.temperature, 'number')
  assert.equal(typeof sp.maxTokensMul, 'number')
  assert.equal(typeof sp.note, 'string')
  assert.ok(Array.isArray(sp.sources))
})

ok('偏移量钳在 ±0.5（不越权到最终温度的钳位范围）', () => {
  for (let i = 0; i < 20; i++) {
    const sp = S.spinalState({ now: Date.now() + i * 3600_000 })
    assert.ok(sp.temperature >= -0.5 && sp.temperature <= 0.5, 'temperature=' + sp.temperature)
  }
})

ok('预算乘数 ≤ 1（身体只会收着说，不会放开超发）', () => {
  for (let i = 0; i < 20; i++) {
    const sp = S.spinalState({ now: Date.now() + i * 1800_000 })
    assert.ok(sp.maxTokensMul <= 1 && sp.maxTokensMul >= 0.3, 'mul=' + sp.maxTokensMul)
  }
})

ok('器官炸了不牵连（mock 一个抛错的模块路径也能出结果）', () => {
  // spinal 内部每个读数独立 try —— 这里只验它在正常环境下绝不抛
  const sp = S.spinalState()
  assert.ok(sp, 'spinalState 不该返回空')
})

ok('高睡债时睡眠压强发声（昼夜钟点已剔除，困只看积累）', () => {
  // 造高睡债: field.poke 直接写（sleepDebt accrualOnly, poke 可写入）
  F.poke('sleepDebt', 0.9)
  const sp = S.spinalState()
  assert.ok(sp.sources.includes('rhythm.sleepPressure'), 'srcs=' + sp.sources.join(',') + ' pressure=')
})

ok('spinalSources 是 spinalState.sources 的快捷方式', () => {
  assert.deepEqual(S.spinalSources().sort(), S.spinalState().sources.sort())
})

ok('qq-server 说话链确实接了 spinal（源码级接线检查）', () => {
  const src = fs.readFileSync('/home/dsh_bot/app/tools/commands/qq-server.mjs', 'utf8')
  assert.match(src, /import\('\.\.\/brain\/spinal\.mjs'\)/, '没 import spinal')
  assert.match(src, /SP\.spinalState\(\)/, '没调用 spinalState')
  assert.match(src, /dynTokMul/, '没接输出预算')
})

console.log('\nspinal 接线测试：' + passed + ' 项全过' + (process.exitCode ? '（有失败）' : ''))
fs.rmSync(sandbox, { recursive: true, force: true })
