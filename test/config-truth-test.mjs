// config-truth-test —— 配置必须是"单一真相"（v5）。
//
// 重构前的问题：代码里读 qq.channel / qq.replyGate / qq.proactive.globalGapMin 等，
// 但 DEFAULTS 里一个都没有 → diagnose 每次都报"配置缺项"；反过来 platforms/douyin/
// dream/tattle/wander 又不在 DEFAULTS → 每次报"配置多出"。噪音多了，真问题就没人看了。
//
// 这里锁死：**凡是被代码读取的配置键，必须能在 DEFAULTS 里找到**。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-cfg-'))
process.env.BOT_DATA_DIR = TMP
process.env.BOT_CONFIG = path.join(TMP, 'bot.config.json')

const { DEFAULTS, config } = await import('../tools/lib/config.mjs')

// ── 1. 顶层必须覆盖所有"用户会用到"的域 ────────────────────────────────────
for (const k of ['identity', 'owner', 'platforms', 'qq', 'wechat', 'llm', 'guard', 'brain', 'mind', 'dream', 'tattle', 'wander', 'diary', 'imageGen', 'vision', 'video']) {
  assert.ok(k in DEFAULTS, 'DEFAULTS 缺顶层键：' + k)
}

// ── 2. 关键子键：v5 新增的几块必须显式声明 ─────────────────────────────────
const must = {
  'qq.channel': ['debounceMs', 'maxConcurrency', 'ttlMs', 'maxQueuePerChat', 'maxMerge'],
  'qq.replyGate': ['enabled', 'minDelayMs', 'maxDelayMs', 'callDelayMin', 'callDelayMax', 'imageDelayMin', 'imageDelayMax'],
  'qq.proactive': ['globalGapMin', 'globalDailyMax', 'maxStreak', 'ownerActiveMin'],
  'guard': ['dryRun', 'minGapSec'],
}
for (const [dotted, keys] of Object.entries(must)) {
  const [a, b] = dotted.split('.')
  const obj = b ? DEFAULTS[a]?.[b] : DEFAULTS[a]
  assert.ok(obj && typeof obj === 'object', 'DEFAULTS 缺 ' + dotted)
  for (const k of keys) assert.ok(k in obj, 'DEFAULTS 缺 ' + dotted + '.' + k)
}

// ── 3. 鉴权开关必须在默认值里（默认空 = 只允许回环） ────────────────────────
assert.equal(typeof DEFAULTS.qq.inboundToken, 'string', 'qq.inboundToken 必须在 DEFAULTS 里')
assert.equal(DEFAULTS.qq.inboundToken, '', '默认空 token = 只允许本机回环（安全默认）')

// ── 4. 配置合并：用户没写的键必须能从 DEFAULTS 拿到 ────────────────────────
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({ qq: { enabled: true } }))
const c = config()
assert.equal(c.qq.enabled, true)
assert.equal(c.qq.channel.debounceMs, DEFAULTS.qq.channel.debounceMs, '用户没写 channel，要能回落到默认')
assert.equal(c.guard.dryRun, true, 'dryRun 默认必须是 true（安全默认）')
assert.equal(c.platforms.qq, true, 'platforms 默认开（否则新装用户永远起不来）')

// ── 5. 用户配置里的多余键不能"污染"默认值结构 ──────────────────────────────
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({ qq: { enabled: true, 历史残留键: 1 }, platforms: { qq: false } }))
const c2 = config()
assert.equal(c2.qq.enabled, true)
assert.equal(c2.platforms.qq, false)
assert.equal(c2.qq.channel.debounceMs, DEFAULTS.qq.channel.debounceMs, '多余键不影响其他默认值')

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ config-truth-test 全部通过（DEFAULTS 覆盖/合并/安全默认）')
