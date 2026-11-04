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
  'client-base-test.mjs',     // 挂载前缀：子路径 / 根挂载都不能打错 API 基址（2026-11-04）
  'access-fence-test.mjs',    // 访问栅栏：回环 / 反代 / 陌生来源三分（2026-11-04）
  'stickers-test.mjs',
  'collateral-test.mjs',     // A1 侧支循环：门控/血债/试跳恢复/describe（2026-11-03）
  'immune-test.mjs',         // B1 免疫系统：耐受/先天模式/抗体记忆/发热/退烧（2026-11-03）
  'wound-test.mjs',          // A2 伤口愈合：登记/化脓/愈合/瘢痕/旧伤复发（2026-11-03）
  'breath-test.mjs',         // B2 呼吸：周期随唤醒收缩/吸气短呼气长/静息不变行为（2026-11-03）
  'pain-test.mjs',           // B4 痛觉：快痛缩手反射/复发敏化/基线不喊疼/慢痛愈合即停（2026-11-03）
  'safety-test.mjs',         // C1 社交安抚缓冲：safety 纯读/中性缺省/峰降/tau不动/慢性不受扰（2026-11-03）
  'rpe-test.mjs',            // C3 DA 预期端：稳态收敛/停供负脉冲/重现惊喜/落盘（2026-11-03）
  'mood-recall-test.mjs',    // C2 心情一致性回忆：负情绪负向反超/镜像/中性无偏置/k还原（2026-11-03）
  'zeitgeber-test.mjs',      // C4 社交节律牵引：3天02:00拖~40min每天/晨间反向/死区/停拖回归/不碰sleepstage（2026-11-03）
  'startle-test.mjs',        // C5 startle reflex: suprathreshold NE pulse / 1s refractory / 30s second bang ~half / pure memory (2026-11-03)
  'metabolism-test.mjs',     // B3
  'vitals-test.mjs',         // B8 内感受 vitals：容器本身的饱胀与闷（2026-11-03 补注册——提交时漏了 run-tests，单跑过但全套不跑） 能量消化：思考消耗/进食积压/REM消化/N3修复/24h血糖曲线（2026-11-03）
  'memory-test.mjs',
  'episode-dedup-test.mjs',   // 跨写者双写去重（2026-11-02）
  'watchlog-test.mjs',
  'synapse-test.mjs',
  'neuron-wire-test.mjs',
  'presence-test.mjs',        // 存在感器官：身体->QQ状态档 映射/否决串行/不应期/落盘（2026-11-03）
  'novelty-test.mjs',         // 新颖检测：陌生度/脱敏/见过池沉淀/习惯化（2026-11-02）
  'reply-attach-test.mjs',
  'stress-source-test.mjs',   // stress 三源 / 快慢两个尺度 / 同步性    // social→reply 下限 / attach→owner 门槛上限    // 五条通路接线：落盘/消耗/恢复/接入决策        // 突触标定：双脉冲易化/STD/恢复/通路隔离        // 看番账本：注入 / ok:false 标注 / 72h 边界（2026-11-02）
  'watch-slot-test.mjs',      // 槽位必须进实际聊天那条装配（shadow 模式也生效）
  'tail-read-test.mjs',        // readTail：只读尾部 / 不返回半截行 / 边界
  'brain-affect-test.mjs',    // 情绪混合/奖励/tension/decay（2026-11-02 补测）
  'brain-rhythm-test.mjs',
  'brain-car-test.mjs',       // P2-1 CAR: wake hands one stress to HPA; 30-45min single peak grows out of the cascade (2026-11-03)
  'brain-allo-test.mjs',      // P2-2 allostasis: chronic setShift drags valence rest-point, recovers after days (2026-11-03)
  'anchor-usage-test.mjs',    // P2-3 usage-dependent consolidation: replayed lines outrank fresh one-offs (2026-11-03)    // 昼夜曲线形状/光照推相位/睡眠记账
  'brain-delivery-test.mjs',  // 交付证据：记录/检索/last/stats
  'brain-attention-test.mjs', // 紧迫度/队列/生成租约
  'brain-segment-test.mjs',   // 段：话题指纹/切段信号/短句宽容
  'brain-store-test.mjs',     // store：锁/原子读改写/多进程无丢失
  'shard-test.mjs',            // 记忆分片：part2 能读回 / 不串台
  'memory-recall-test.mjs',
  'bond-test.mjs',             // 关系器官：oxy/cort/习惯化/不应期/疤/衰减/第一人称呈现/慢相结算（2026-11-03）
  'roster-test.mjs',           // 人物名册：主人不入册/幂等建卡/称呼印象/满员淘汰（2026-11-03）
  'webpush-test.mjs',          // webui 主动说话：开关/次数闸/由头去重/TTL（2026-11-03）
  'qq-human-test.mjs',
  'group-persona-test.mjs',
  'freedom-quota-test.mjs',
  'tts-sanitize-test.mjs',
  'focus-one-thing-test.mjs',
  'tts-reftext-test.mjs',
  'voice-emotion-test.mjs',
  'web-shell-test.mjs',  'browser-engine-test.mjs',   // 内置浏览器引擎：双设备/SSRF/CDP/实机渲染（2026-11-02）
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
  'selfcon-engine-test.mjs',  // 自我账本: seed/候选结算/影子/化学/重长 (2026-11-03)
  'selfcon-day-test.mjs',     // 自我账本白天侧: 采集不结算/接线/梦渗漏 (2026-11-03)
  'sanitize-test.mjs',        // 出站硬脱敏：QQ号/IP/密钥/路径该拦拦、日常数字不误伤 (2026-11-03)
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
  'field-mutate-race-test.mjs',  // 2026-11-03：field 并发 poke 零丢失（mutateJson 上锁后的行为锚）
  'lock-tri-state-test.mjs',     // 2026-11-03：锁三态语义（O_EXCL/死锁抢占/故障降级）
  'llm-physio-test.mjs',         // 2026-11-03：B7 表达代谢（brief/直连双源、超支分支、永不抛）
]

// ── 测试临时产物统一收尾（2026-11-02）─────────────────────────────────────
// 30 个测试用 fs.mkdtempSync(os.tmpdir()) 建隔离目录，其中一半从不清理。
// 实测跑 4 轮全量就留下 15 个 bot-brain-cons-* —— 无界泄漏，只是单个很小。
// 这里在每个测试前后各拍一次 /tmp，把**这期间新出现**的、且命中测试前缀的删掉。
// 只删命中前缀的：不碰别人的东西，也不碰她运行时的临时文件。
const TEST_TMP_PREFIXES = [
  // 2026-11-03 收敛（评审③第 5 条）：'bot-' / 'dsh-' 两个超宽前缀撤掉 ——
  // 它们按前缀删全机 /tmp 里"恰好同名"的任何目录。逐个列出实际测试用到的前缀；
  // 以后新增测试用自己的 mkdtemp 前缀就登记在这里。
  'bot-brain-cons-', 'bot-brain-', 'bot-brain-iso-', 'bot-field-race-', 'bot-lock-tri-',
  'bot-lock-broken-', 'bot-group-', 'epdedup-', 'watchlog-', 'watchslot-', 'dupfp-', 'dupfp2-',
  'botcfg-', 'botmem-', 'bot-quota-', 'bot-focus-', 'bot-life-',
  // 2026-11-03 清扫时实测泄漏的家族：测试目录清理钩子此前漏了这些前缀
  'presence-', 'webpush-test-', 'roster-test-', 'org.chromium.Chromium.', 'ev-', 'dd-', 'fc-', 'frec-',
]
function snapshotTmp() {
  const dir = os.tmpdir()
  try { return new Set(fs.readdirSync(dir)) } catch { return new Set() }
}
function cleanupNewTmp(before, ageMs = 120_000) {
  const dir = os.tmpdir()
  let after = []
  try { after = fs.readdirSync(dir) } catch { return 0 }
  let n = 0
  for (const name of after) {
    if (before.has(name)) continue
    if (!TEST_TMP_PREFIXES.some((p) => name.startsWith(p))) continue
    if (name.startsWith('bot-node-')) continue   // 生产 runtime.mjs 的 spawn 目录，绝不清理（2026-11-03 护栏）
    // 2026-11-03 高压修缮：加年龄闸。以前"新增即垃圾"——并发跑 run-tests（她的 selfApply
    // 兜底 × 老爸这边）时，A 会把 B 正在用的目录当垃圾删掉（实测 video/atomic 批跑报
    // No such file / readJsonSafe=null）。只清已存在 ≥2 分钟的：测试残留够老，活跃目录都年轻。
    try {
      const st = fs.statSync(path.join(dir, name))
      if (Date.now() - st.mtimeMs < ageMs) continue
    } catch { continue }
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
// P0-6 (2026-11-03): pin test TMPDIR onto the app volume instead of /tmp.
// Container /tmp sits on the overlay whose upperdir is on sda - the HDD with
// an ATA-error history. Under batch load, ffmpeg writes and atomic renames in
// test sandboxes randomly hit 'Input/output error', which looked like 1-7
// random test failures per full run (video/wanvid/browser-engine/intents...).
// Every suite builds its sandbox via os.tmpdir(); pointing TMPDIR at a fresh
// per-run dir here moves all of them onto reliable disk without touching the
// individual test files.
const RUN_TMP = path.join(HERE, '..', 'test', '.tmp', 'run-' + process.pid + '-' + Date.now())
try { fs.mkdirSync(RUN_TMP, { recursive: true }) } catch (e) { /* fall back to system tmp */ }
let bad = 0
const times = []   // 2026-11-03: per-suite timing, so slow suites are visible without stopwatches
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
  const t0 = Date.now()
  const r = spawnSync(NODE, [file], {
    stdio: 'inherit', windowsHide: true, cwd: path.join(HERE, '..'),
    timeout: 300_000, killSignal: 'SIGKILL',
    env: { ...process.env, TMPDIR: RUN_TMP },
  })
  const took = Date.now() - t0
  times.push({ t, took })
  const cleaned = cleanupNewTmp(tmpBefore)
  if (cleaned) console.log(`  （清掉 ${cleaned} 个测试临时产物）`)
  if (r.status === 0) console.log(`✓ ${t}（${(took / 1000).toFixed(1)}s）`)
  else {
    console.log(`✗ ${t}（exit ${r.status ?? r.signal}，${(took / 1000).toFixed(1)}s）`)
    bad++
  }
}
const slowest = times.slice().sort((a, b) => b.took - a.took).slice(0, 3).filter((x) => x.took > 5000)
if (slowest.length) {
  console.log('\n慢速前三：' + slowest.map((x) => `${x.t} ${(x.took / 1000).toFixed(1)}s`).join(' · ') + '（要提速先看这里）')
}
try { fs.rmSync(RUN_TMP, { recursive: true, force: true }) } catch (e) { /* best effort */ }
console.log(bad ? `\n✗ ${bad}/${picked.length} 套没过` : `\n✓ 全部 ${picked.length} 套通过`)
process.exit(bad ? 1 : 0)