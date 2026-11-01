// config-file-test —— 配置读写（v5 新增）。
//
// 三条要锁死的语义：
//   ① 读必须经过 DEFAULTS 深合并（缺键时不能返回残缺对象）
//   ② 写只落"用户显式设置过的值"（不能把默认值永久刻进配置文件）
//   ③ 写完权限必须是 600（里面有 token / api_key）
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-cfgfile-'))
process.env.FEIYU_DATA_DIR = TMP
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')

// 先落一个"很薄"的用户配置（模拟真实情况：只写了自己关心的几个键）
// 注意：identity.name 的默认值**就是** '大肥鱼'，所以它会被 stripDefaults 剔掉 ——
// 这是对的（读回来仍然是大肥鱼）。要验证"用户的值必须保留"，得用一个非默认值。
fs.writeFileSync(process.env.FEIYU_CONFIG, JSON.stringify({
  identity: { name: '大肥鱼', ownerTitle: '笨蛋老爸' },
  qq: { enabled: true },
}))

const cf = await import('../tools/lib/config-file.mjs')
const { DEFAULTS } = await import('../tools/lib/config.mjs')

// ── 1. 读：必须补全默认值 ───────────────────────────────────────────────────
const cfg = cf.readConfigFile()
assert.equal(cfg.identity.name, '大肥鱼', '用户的值得保留')
assert.equal(cfg.identity.ownerTitle, '笨蛋老爸', '非默认值的用户设置要保留')
assert.equal(cfg.qq.enabled, true)
assert.equal(cfg.guard.dryRun, true, '**缺的键必须从 DEFAULTS 补上**（旧版这里会 undefined）')
assert.equal(cfg.qq.channel.debounceMs, DEFAULTS.qq.channel.debounceMs)
assert.equal(cfg.qq.startWithDsh, false, 'startWithDsh 缺省必须是 false，不能 undefined')

// ── 2. 写：默认值不许落盘 ───────────────────────────────────────────────────
const before = JSON.parse(fs.readFileSync(process.env.FEIYU_CONFIG, 'utf8'))
assert.equal('guard' in before, false, '写之前文件里本来就没有 guard')
const r = cf.writeConfigFile(cfg)
assert.equal(r.ok, true)
const after = JSON.parse(fs.readFileSync(process.env.FEIYU_CONFIG, 'utf8'))
assert.equal('guard' in after, false, '**默认值不许被写进配置文件**（否则以后升级默认值不再生效）')
assert.equal(after.identity.ownerTitle, '笨蛋老爸', '用户改过的值必须保留')
assert.equal('name' in (after.identity || {}), false, '与默认值相同的键会被剔掉（读回来仍然一样）')
assert.equal(after.qq.enabled, true, '用户显式开的值要保留')
// 读回来必须仍然等于用户原本看到的样子
const reread = cf.readConfigFile()
assert.equal(reread.identity.name, '大肥鱼')
assert.equal(reread.identity.ownerTitle, '笨蛋老爸')

// ── 3. 用户改过的值必须落盘 ────────────────────────────────────────────────
cfg.qq.voice_enabled = true          // 与默认值不同
cfg.guard.dryRun = false             // 显式关掉干跑
cf.writeConfigFile(cfg)
const after2 = JSON.parse(fs.readFileSync(process.env.FEIYU_CONFIG, 'utf8'))
assert.equal(after2.qq.voice_enabled, true, '非默认值必须写进去')
assert.equal(after2.guard?.dryRun, false, '显式关掉必须写进去')

// ── 4. 权限必须 600（里面有 token / api key） ──────────────────────────────
const mode = fs.statSync(process.env.FEIYU_CONFIG).mode & 0o777
assert.equal(mode, 0o600, '配置文件权限必须是 600（实际 ' + mode.toString(8) + '）')

// ── 5. 原子写：写坏了不能留下半个文件 ───────────────────────────────────────
// 用"循环引用"制造真实的 JSON.stringify 失败（不是靠 toJSON，那个会被跳过）
const circular = { qq: { enabled: true } }
circular.self = circular
const bad = cf.writeConfigFile(circular)
assert.equal(bad.ok, false, '写入失败要返回 ok:false，不能假装成功')
const still = JSON.parse(fs.readFileSync(process.env.FEIYU_CONFIG, 'utf8'))
assert.equal(still.qq.voice_enabled, true, '**失败的写不能把原文件弄坏**')

// ── 6. 只读内部标记：__hasUserFile 不许落盘 ────────────────────────────────
const withMark = cf.readConfigFile()
withMark.__hasUserFile = true
withMark.__whatever = 1
cf.writeConfigFile(withMark)
const after3 = JSON.parse(fs.readFileSync(process.env.FEIYU_CONFIG, 'utf8'))
assert.equal('__hasUserFile' in after3, false, '__ 开头的内部标记不许落盘')

// ── 7. 核心回归：config() 返回的对象**绝不能**污染 DEFAULTS ───────────────
// 旧 merge 只做浅拷贝：cfg.guard 与 DEFAULTS.guard 是同一个对象，
// 任何调用方改一下 cfg.guard.dryRun 就把全局默认值永久改掉。
// 这类 bug 只在"先跑过别的代码"时才复现，是最难查的一类。
{
  // 先把配置文件清成"很薄"的一份，避免上一段写进去的 dryRun=false 干扰判定
  fs.writeFileSync(process.env.FEIYU_CONFIG, JSON.stringify({ qq: { enabled: true } }))
  const { config, DEFAULTS } = await import('../tools/lib/config.mjs')
  const c = config()
  assert.notEqual(c.guard, DEFAULTS.guard, 'config() 与 DEFAULTS 不许共享嵌套对象')
  assert.notEqual(c.qq, DEFAULTS.qq)
  assert.equal(DEFAULTS.guard.dryRun, true, 'DEFAULTS 本身必须是干净的 true')
  const before = DEFAULTS.guard.dryRun
  c.guard.dryRun = !before                 // 在返回值上改
  assert.equal(DEFAULTS.guard.dryRun, before, '**改 config() 不许污染 DEFAULTS**')
  const c2 = config()
  assert.equal(c2.guard.dryRun, before, '下一次 config() 必须还是干净的默认值（没被上一次调用污染）')
  // 数组也要独立（push 不能改到默认值）
  const lb = DEFAULTS.brain.livePlatforms.length
  c2.brain.livePlatforms.push('__polluted__')
  assert.equal(DEFAULTS.brain.livePlatforms.length, lb, '数组也不许共享')
  const c3 = config()
  assert.equal(c3.brain.livePlatforms.includes('__polluted__'), false, '下一次调用不许看到上一次 push 的元素')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('✓ config-file-test 全部通过（合并/剔除默认值/600/原子写/不污染默认值）')
