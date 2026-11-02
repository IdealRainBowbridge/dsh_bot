// run-tests —— 不依赖 npm 的测试跑轮（这台机器上 PATH 里没有 node/npm，
// `npm test` 跑不了，而她自己改完代码必须验证）。
//
//   node tools/run-tests.mjs            # 顺序跑全部 42 套，全绿退出 0
//   node tools/run-tests.mjs memory     # 只跑文件名含 "memory" 的
//
// 与 package.json 的 `test` 脚本等价：同样的文件、同样的顺序、失败即停。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS = [
  'client-smoke.mjs',
  'client-render.mjs',
  'stickers-test.mjs',
  'memory-test.mjs',
  'episode-dedup-test.mjs',   // 跨写者双写去重（2026-11-02）
  'watchlog-test.mjs',
  'synapse-test.mjs',
  'neuron-wire-test.mjs',    // 五条通路接线：落盘/消耗/恢复/接入决策        // 突触标定：双脉冲易化/STD/恢复/通路隔离        // 看番账本：注入 / ok:false 标注 / 72h 边界（2026-11-02）
  'watch-slot-test.mjs',      // 槽位必须进实际聊天那条装配（shadow 模式也生效）
  'tail-read-test.mjs',        // readTail：只读尾部 / 不返回半截行 / 边界
  'shard-test.mjs',            // 记忆分片：part2 能读回 / 不串台
  'memory-recall-test.mjs',
  'qq-human-test.mjs',
  'group-persona-test.mjs',
  'freedom-quota-test.mjs',
  'tts-sanitize-test.mjs',
  'focus-one-thing-test.mjs',
  'tts-reftext-test.mjs',
  'voice-emotion-test.mjs',
  'web-shell-test.mjs',
  'recall-push-test.mjs',
  'imggen-test.mjs',
  'vision-test.mjs',
  'bili-audio-test.mjs',
  'adapt-frames-test.mjs',  // 抽帧策略：阈值自适应 / 骨架覆盖 / 预算上限   // 音频/ASR：成稿合并 + 失败语义（不打网络）
  'ledger-test.mjs',
  'comment-engage-test.mjs',
  'reply-style-test.mjs',
  'skipped-messages-test.mjs',
  'memory-hygiene-test.mjs',
  'video-test.mjs',
  'produce-plan-test.mjs',
  'wanvid-test.mjs',
  // 脑（v3）：事件/巩固/装配/意图/隔离 —— 这五套挂了就别切 live
  'brain-event-test.mjs',
  'brain-consolidate-test.mjs',
  'brain-prompt-test.mjs',
  'brain-intents-test.mjs',
  'brain-isolation-test.mjs',
  'brain-meta-test.mjs',
  'brain-claim-test.mjs',
  // ── v5 重构新增：新地基模块必须有测试，否则等于没写 ──────────────────────
  'platforms-test.mjs',        // 平台枚举 + 开关单一真相（回归：关一个不许杀另一个）
  'reply-context-test.mjs',    // 异步上下文隔离（回归：4 会话并发不串台）
  'channel-test.mjs',          // 统一队列：串行/并行/合并/限流/TTL/积压/容错
  'inbound-auth-test.mjs',     // 入口鉴权：回环/token/定长比较/401
  'memory-write-test.mjs',     // 记忆写入：干跑隔离/并发不丢行/平台隔离
  'config-truth-test.mjs',     // 配置单一真相：DEFAULTS 必须覆盖代码读的键
  'config-file-test.mjs',      // 配置读写：合并/剔除默认值/600/原子写
  'lifecycle-test.mjs',        // 定时器生命周期：幂等/替换/清理/容错
  'persona-voice-test.mjs',    // 人设措辞单一来源：改名/改称呼/无 AI 字样
  // ── v5 深度排查新增 ──────────────────────────────────────────────────────
  'atomic-test.mjs',           // 跨进程读改写：20 进程并发零丢失（旧版丢 28.8%）
  'share-queue-race-test.mjs', // 分享队列多生产者：并发入队不丢事件、不写坏 JSON
]

// ── 测试临时产物统一收尾（2026-11-02）─────────────────────────────────────
// 30 个测试用 fs.mkdtempSync(os.tmpdir()) 建隔离目录，其中一半从不清理。
// 实测跑 4 轮全量就留下 15 个 bot-brain-cons-* —— 无界泄漏，只是单个很小。
// 这里在每个测试前后各拍一次 /tmp，把**这期间新出现**的、且命中测试前缀的删掉。
// 只删命中前缀的：不碰别人的东西，也不碰她运行时的临时文件。
const TEST_TMP_PREFIXES = [
  'bot-brain-cons-', 'bot-brain-', 'bot-group-', 'bot-', 'dsh-',
  'epdedup-', 'watchlog-', 'watchslot-', 'dupfp-', 'dupfp2-',
  'botcfg-', 'botmem-', 'bot-quota-', 'bot-focus-', 'bot-life-',
]
function snapshotTmp() {
  const dir = os.tmpdir()
  try { return new Set(fs.readdirSync(dir)) } catch { return new Set() }
}
function cleanupNewTmp(before) {
  const dir = os.tmpdir()
  let after = []
  try { after = fs.readdirSync(dir) } catch { return 0 }
  let n = 0
  for (const name of after) {
    if (before.has(name)) continue
    if (!TEST_TMP_PREFIXES.some((p) => name.startsWith(p))) continue
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); n++ } catch { /* 删不掉就算了 */ }
  }
  return n
}

const filter = process.argv[2] || ''
const picked = filter ? TESTS.filter((t) => t.includes(filter)) : TESTS
if (!picked.length) {
  console.error(`没找到匹配「${filter}」的测试；可选：${TESTS.join(' / ')}`)
  process.exit(1)
}

// 测试要用同一份"真 node"（Electron 主进程里 process.execPath 不是 node）
const NODE = process.env.BOT_NODE || process.execPath
let bad = 0
for (const t of picked) {
  const file = path.join(HERE, '..', 'test', t)
  if (!fs.existsSync(file)) {
    console.log(`✗ ${t} —— 文件不存在`)
    bad++
    continue
  }
  // v5：单个测试套原来没有超时 —— 任何一个测试挂住（比如等网络/等文件锁），
  // 整个 run-tests 就永远不结束，看着像"卡住了"。给 5 分钟上限。
  const tmpBefore = snapshotTmp()
  const r = spawnSync(NODE, [file], {
    stdio: 'inherit', windowsHide: true, cwd: path.join(HERE, '..'),
    timeout: 300_000, killSignal: 'SIGKILL',
  })
  const cleaned = cleanupNewTmp(tmpBefore)
  if (cleaned) console.log(`  （清掉 ${cleaned} 个测试临时产物）`)
  if (r.status === 0) console.log(`✓ ${t}`)
  else {
    console.log(`✗ ${t}（exit ${r.status ?? r.signal}）`)
    bad++
  }
}
console.log(bad ? `\n✗ ${bad}/${picked.length} 套没过` : `\n✓ 全部 ${picked.length} 套通过`)
process.exit(bad ? 1 : 0)