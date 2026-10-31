// platforms-test —— 平台语义单测（v5）。
// 回归的重点：**关一个平台绝不能影响另一个平台**（旧版 platforms.qq=false 会杀掉微信）。
import assert from 'node:assert'
import * as P from '../tools/lib/platforms.mjs'

const cfg = (platforms, qq, wechat) => ({ platforms, qq, wechat })

// ── 枚举 ────────────────────────────────────────────────────────────────────
assert.deepEqual(P.PLATFORMS.map((p) => p.id), ['qq', 'wechat'], '对话平台只有 qq/wechat')
assert.equal(P.platformOf('qq').outbound, 'onebot')
assert.equal(P.platformOf('wechat').outbound, 'outbox')
assert.equal(P.platformOf('nope'), null, '未知平台返回 null')
assert.equal(P.isKnownPlatform('douyin'), true, '已下线平台仍可读历史')
assert.equal(P.isKnownPlatform('nope'), false)
assert.equal(P.labelOf('qq'), 'QQ')
assert.equal(P.labelOf('nope'), 'nope', '未知平台回落成 id 本身，不抛')

// ── 开关：单一真相 ──────────────────────────────────────────────────────────
assert.equal(P.enabled(cfg({ qq: true }, { enabled: true }), 'qq').on, true)
assert.equal(P.enabled(cfg({ qq: false }, { enabled: true }), 'qq').on, false, '面板关 → 关')
assert.equal(P.enabled(cfg({ qq: true }, { enabled: false }), 'qq').on, false, '服务关 → 关')
assert.equal(P.enabled(cfg({}, {}), 'qq').on, true, '两个键都缺省 → 开（向后兼容）')
assert.equal(P.enabled(cfg({}, {}), 'nope').on, false, '未知平台永远关')

// ── 核心回归：平台之间互不影响 ──────────────────────────────────────────────
const onlyQqOff = cfg({ qq: false, wechat: true }, { enabled: false }, { enabled: true })
assert.equal(P.enabled(onlyQqOff, 'qq').on, false, 'QQ 关')
assert.equal(P.enabled(onlyQqOff, 'wechat').on, true, '**关 QQ 不许把微信一起关掉**')

const onlyWechatOff = cfg({ qq: true, wechat: false }, { enabled: true }, { enabled: false })
assert.equal(P.enabled(onlyWechatOff, 'qq').on, true, '**关微信不许把 QQ 一起关掉**')
assert.equal(P.enabled(onlyWechatOff, 'wechat').on, false)

// ── 能力 ────────────────────────────────────────────────────────────────────
assert.equal(P.allowsGroup('qq'), true)
assert.equal(P.allowsGroup('wechat'), false, '微信没有群聊实现')
assert.equal(P.allowsGroup('bilibili'), false)

// ── 快照（面板/diagnose 用） ────────────────────────────────────────────────
const snap = P.snapshot(cfg({ qq: true, wechat: false }, { enabled: true }, { enabled: false }))
assert.equal(snap.length, 4)
assert.equal(snap.find((x) => x.id === 'qq').on, true)
assert.equal(snap.find((x) => x.id === 'wechat').on, false)
assert.ok(snap.find((x) => x.id === 'wechat').why.includes('false'), '关闭要给出原因')

console.log('✓ platforms-test 全部通过')
