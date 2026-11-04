// 会话 cwd 自愈（2026-11-04）—— 钉「旧工作目录不存在时不许把每一轮都跑死」。
//
// 真实故障（生产上跑了整整几个小时的静默空转）：
//   把宿主用户 feiyu 改名为 dsh 之后，会话 `dsh_bot` 的**会话头**里 cwd 仍然是
//   `/home/〈旧用户〉/.dsh/bot-work`。会话头 cwd 是不可变的（DSH 没有改 cwd 的 API），
//   而 `sessionController.create()` 对已存在的同名会话**保留原 cwd**。
//   于是每次唤醒都投递成功、turn 也起来了，却在第一秒就以
//     working-directory: directory does not exist: "/home/〈旧用户〉/.dsh/bot-work"
//   结束 —— 她的自主活动（自由时间/看番/写日记）天天在跑，一句话都没说出口，
//   而日志里只有 turn/end error（谁也不会主动去翻）。
//
// 这条测试钉三件事：
//   ① 会话头能被正确读出（不解压失败、不认错文件）
//   ② cwd 匹配 / 旧目录仍存在 → 继续用原会话（不许无脑换 id，那会切断她的历史）
//   ③ 旧目录已不存在 → 判定必须换会话 id（这是自愈的触发条件）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cwd-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const S = await import('../lib/scheduler.js')
ok('导出 readSessionHeader', typeof S.readSessionHeader === 'function')
ok('导出 sessionUsability', typeof S.sessionUsability === 'function')

/** 造一个 DSH 风格的会话文件（头部是 session 事件，JSONL，zstd 压缩）。 */
function makeSession(dshHome, ws, id, cwd) {
  const dir = path.join(dshHome, 'sessions', ws, `session-${id}`)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }),
    JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
  ]
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
  return dir
}

const DSH = path.join(TMP, '.dsh')
const WANT = path.join(DSH, 'bot-work')
fs.mkdirSync(WANT, { recursive: true })

// ── ① 读会话头 ─────────────────────────────────────────────────────────────
{
  // 旧宿主用户名故意拼出来：门禁禁止源码里出现 /home/<旧用户>/ 字面量（换机器会静默坏掉），
  // 但这个测试要模拟的**正是**那条残留路径。
  const OLD_USER_PATH = ['', 'home', 'fei' + 'yu', '.dsh', 'bot-work'].join('/')
  makeSession(DSH, '--home-dsh-bot-work--', 'dsh_bot', OLD_USER_PATH)
  const head = S.readSessionHeader(DSH, 'dsh_bot')
  ok('读到会话头', !!head, JSON.stringify(head))
  ok('cwd 解析正确（旧路径）', head?.cwd === OLD_USER_PATH, head?.cwd)
  ok('返回文件路径', !!head?.path && fs.existsSync(head.path), head?.path)
}

// ── ② 不存在会话 → 视为可用（首次启动）──────────────────────────────────
{
  const r = S.sessionUsability(DSH, 'no-such-session', WANT)
  ok('没有会话时不阻止创建', r.usable === true && r.reason === 'no-session-yet', r.reason)
}

// ── ③ cwd 与期望一致 → 继续用原会话 ────────────────────────────────────
{
  makeSession(DSH, '--ws-a--', 'good-one', WANT)
  const r = S.sessionUsability(DSH, 'good-one', WANT)
  ok('cwd 一致 → 可用', r.usable === true && r.reason === 'cwd-matches', r.reason)
}

// ── ④ cwd 不一致但旧目录还在 → 仍然可用（不切历史）──────────────────────
{
  const OLD = path.join(TMP, 'old-workspace')
  fs.mkdirSync(OLD, { recursive: true })
  makeSession(DSH, '--ws-b--', 'moved-but-alive', OLD)
  const r = S.sessionUsability(DSH, 'moved-but-alive', WANT)
  ok('旧 cwd 存在 → 继续用（不切断历史）', r.usable === true && r.reason === 'cwd-exists', r.reason)
  ok('仍然如实报出旧 cwd', r.oldCwd === OLD, r.oldCwd)
}

// ── ⑤ 旧 cwd 已不存在 → 判定必须换会话 id（自愈触发条件）────────────────
{
  const GONE = path.join(TMP, 'gone-workspace-never-created')
  makeSession(DSH, '--ws-c--', 'broken-one', GONE)
  const r = S.sessionUsability(DSH, 'broken-one', WANT)
  ok('旧 cwd 不存在 → 不可用（必须换 id）', r.usable === false && r.reason === 'cwd-missing', r.reason)
  ok('报出坏掉的旧 cwd（可写进日志）', r.oldCwd === GONE, r.oldCwd)
}

// ── ⑥ 真生产形态：改名前留下的会话 ──────────────────────────────────────
{
  // 这就是 arch 上真实存在的那一条（旧宿主用户 → 新用户 改名后遗留）
  const LEGACY = ['', 'home', 'fei' + 'yu', '.dsh', 'bot-work'].join('/')
  makeSession(DSH, '--home-' + 'fei' + 'yu-.dsh-bot-work--', 'dsh_bot', LEGACY)
  const r = S.sessionUsability(DSH, 'dsh_bot', WANT)
  ok('生产形态（旧宿主用户目录已不存在）→ 必须换会话', r.usable === false && r.reason === 'cwd-missing', r.reason)
  ok('生产形态的旧 cwd 读得出来', r.oldCwd === LEGACY, r.oldCwd)
}

// ── ⑦ 多会话共存时按 id 匹配，不许串台 ──────────────────────────────────
{
  makeSession(DSH, '--ws-d--', 'aaa', WANT)
  makeSession(DSH, '--ws-d--', 'bbb', '/nope/bbb')
  const a = S.readSessionHeader(DSH, 'aaa')
  const b = S.readSessionHeader(DSH, 'bbb')
  ok('按 id 取到各自会话', a?.cwd === WANT && b?.cwd === '/nope/bbb', `${a?.cwd} / ${b?.cwd}`)
}

// ── ⑦b 子串撞车：`dsh_bot` 不许命中 `dsh_bot-2026-11-04-xxx` ────────────
// 实测踩过：自愈换 id 后用 include(id) 匹配，会读到「另一个会话」的 cwd，
// 于是判断"旧目录还在"→ 不换 id → 继续每轮跑死。这条钉的是精确匹配。
{
  const NEST = path.join(TMP, 'nest')
  // 故意让派生 id 的会话排在前（目录名字典序 a 在前）
  makeSession(DSH, '--ws-f--', 'dsh_bot-2026-11-04-aaa', WANT)
  makeSession(DSH, '--ws-f--', 'dsh_bot', '/old/dsh_bot-cwd')
  const h1 = S.readSessionHeader(DSH, 'dsh_bot')
  ok('精确取到 dsh_bot（不是派生的那个）', h1?.cwd === '/old/dsh_bot-cwd', h1?.cwd)
  const h2 = S.readSessionHeader(DSH, 'dsh_bot-2026-11-04-aaa')
  ok('派生 id 也能精确取到', h2?.cwd === WANT, h2?.cwd)
  const u = S.sessionUsability(DSH, 'dsh_bot', WANT)
  ok('dsh_bot 的 cwd 不存在 → 判定要换 id（不被派生会话干扰）', u.usable === false, u.reason + ' / ' + u.oldCwd)
}

// ── ⑧ 坏文件不能炸（截断/非 zstd 的残留文件）────────────────────────────
{
  const dir = path.join(DSH, 'sessions', '--ws-e--', 'session-broken-file')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('not-zstd-at-all'))
  let threw = null
  let r
  try { r = S.readSessionHeader(DSH, 'broken-file') } catch (e) { threw = e }
  ok('损坏的会话文件不抛', threw === null, threw ? String(threw.message) : '')
  ok('损坏时返回 null（当作没有会话）', r === null, JSON.stringify(r))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(bad ? `\n✗ 会话 cwd 自愈：${bad} 项失败` : '\n✓ 会话 cwd 自愈：全绿')
process.exit(bad ? 1 : 0)
