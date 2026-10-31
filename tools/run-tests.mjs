// run-tests —— 不依赖 npm 的测试跑轮（这台机器上 PATH 里没有 node/npm，
// `npm test` 跑不了，而她自己改完代码必须验证）。
//
//   node tools/run-tests.mjs            # 顺序跑全部 42 套，全绿退出 0
//   node tools/run-tests.mjs memory     # 只跑文件名含 "memory" 的
//
// 与 package.json 的 `test` 脚本等价：同样的文件、同样的顺序、失败即停。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS = [
  'client-smoke.mjs',
  'client-render.mjs',
  'stickers-test.mjs',
  'memory-test.mjs',
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

const filter = process.argv[2] || ''
const picked = filter ? TESTS.filter((t) => t.includes(filter)) : TESTS
if (!picked.length) {
  console.error(`没找到匹配「${filter}」的测试；可选：${TESTS.join(' / ')}`)
  process.exit(1)
}

// 测试要用同一份"真 node"（Electron 主进程里 process.execPath 不是 node）
const NODE = process.env.FEIYU_NODE || process.execPath
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
  const r = spawnSync(NODE, [file], {
    stdio: 'inherit', windowsHide: true, cwd: path.join(HERE, '..'),
    timeout: 300_000, killSignal: 'SIGKILL',
  })
  if (r.status === 0) console.log(`✓ ${t}`)
  else {
    console.log(`✗ ${t}（exit ${r.status ?? r.signal}）`)
    bad++
  }
}
console.log(bad ? `\n✗ ${bad}/${picked.length} 套没过` : `\n✓ 全部 ${picked.length} 套通过`)
process.exit(bad ? 1 : 0)