// 侧支循环测试（2026-11-03 · A1）
//
// 器官判据（M58）：单独拿出来能演出现象才算器官。
//   ① 没配侧支 → 器官在、血管空，任何调用都不追加（不造默认端点）
//   ② 配了侧支但没血债 → 平时一个字节不多走（侧支不是日常供血路线）
//   ③ 主链全灭 → 血债 +1，之后的调用把侧支级追加进 levels（缺血时通血）
//   ④ 侧支通血成功 → 血债清零（活下来了）
//   ⑤ noFallback → 不烧侧支（尊重调用方语义）
//   ⑥ 试跳恢复：血债期间每 ≥30s 试跳一次，连续 5 次健康 → 血债清零，
//      且恢复后 collateralize 不再追加（侧支退回 standby）
//   ⑦ describeCollateral 报告挂载与血债状态（给 diagnose/面板看）
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 环境必须先于动态 import（configPath 是 import 时捕获的常量）──────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-collateral-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
const CFG = path.join(TMP, 'bot.config.json')
fs.writeFileSync(CFG, JSON.stringify({
  llm: {
    base_url: 'https://api.deepseek.com/v1',
    api_key: 'sk-test',
    model: 'deepseek-chat',
    collateral: { base_url: 'https://alt-provider.example.com/v1', model: 'alt-chat', api_key: 'sk-alt' },
  },
}))
process.env.BOT_CONFIG = CFG

const { level, recordBloodDebt, recordSideUse, collateralize, sweep, describeCollateral } =
  await import('../tools/lib/collateral.mjs')

// ── ① 配置齐备 → level 出侧支级 ──
{
  const l = level()
  assert.ok(l, '配置了异源侧支应返回 level')
  assert.equal(l.__key, 'fb-collateral')
  assert.equal(l.model, 'alt-chat')
}

// ── ② 没血债 → 平时不多走 ──
{
  const levels = [{ __key: 'main' }, { __key: 'fb1' }]
  const out = collateralize(levels, {})
  assert.equal(out.length, 2, '无血债时不得追加侧支')
}

// ── ③ 主链全灭 → 追加 ──
{
  assert.equal(recordBloodDebt(), 1)
  const levels = [{ __key: 'main' }, { __key: 'fb1' }]
  const out = collateralize(levels, {})
  assert.equal(out.length, 3, '血债>0 时应追加侧支级')
  assert.equal(out[2].__key, 'fb-collateral')
  // noFallback 尊重
  const lv2 = [{ __key: 'main' }]
  assert.equal(collateralize(lv2, { noFallback: true }).length, 1, 'noFallback 不烧侧支')
  // 重复追加保护
  const lv3 = [{ __key: 'main' }, { __key: 'fb-collateral' }]
  assert.equal(collateralize(lv3, {}).length, 2, '已在 levels 时不重复追加')
}

// ── ④ 通血成功 → 清零 ──
{
  recordSideUse('fb-collateral')
  const levels = [{ __key: 'main' }]
  assert.equal(collateralize(levels, {}).length, 1, '血债清零后回到 standby')
}

// ── ⑥ 试跳恢复曲线 ──
{
  recordBloodDebt() // 血债 1
  let t0 = Date.now() - 60_000   // 假装全灭发生在 60s 前
  // mock 掉 fetch：前 2 次失败，后 5 次健康
  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { calls++; if (calls <= 2) throw new Error('ECONNREFUSED'); return { ok: true } }
  try {
    // 先跑一次污染性的旧探测清零 lastProbeAt
    const r1 = await sweep(t0)
    assert.ok(r1 && r1.healthy === false, '第一次试跳应失败（mock 前 2 次）')
    const r2 = await sweep(t0 + 31_000)
    assert.ok(r2 && r2.healthy === false, '第二次试跳失败')
    let r = null
    for (let i = 0; i < 5; i++) {
      r = await sweep(t0 + 62_000 + i * 31_000)
      assert.ok(r && r.healthy === true, '第 ' + (i + 3) + ' 次试跳应健康')
    }
    assert.equal(r.bloodDebt, 0, '连续 5 次健康 → 血债清零（主链恢复）')
    assert.equal(collateralize([{ __key: 'main' }], {}).length, 1, '恢复后侧支退回 standby')
    // 恢复后 sweep 纯本地短路：fetch 计数不再增长
    const before = calls
    await sweep(t0 + 300_000)
    assert.equal(calls, before, '无血债时试跳不发请求')
  } finally {
    globalThis.fetch = realFetch
  }
}

// ── ⑦ describeCollateral 报告 ──
{
  assert.ok(describeCollateral().includes('侧支已挂@alt-provider.example.com'), 'describe 应报告挂载')
  assert.ok(!describeCollateral().includes('血债'), '恢复后不应报血债')
  const debt = recordBloodDebt()
  assert.ok(describeCollateral().includes('主链血债 ' + debt), '血债应可见（本次=第 ' + debt + ' 次全灭）')
  recordSideUse('fb-collateral')
}

console.log('collateral-test: 7 组断言全过（配置/门控/追加/通血/noFallback/恢复曲线/describe）')
