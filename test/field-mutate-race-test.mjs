// field 并发读写测试（2026-11-03 · mutateJson 上锁后的行为锚）
//
// 测三件事：
//   ① 多进程并发 poke 同一维 → 零丢失（旧实现会丢：各自基于同一快照演化后整份覆写）
//   ② evolve(now, pre) 锁内演化语义：给 pre 不落盘、不给 pre 落盘
//   ③ evolve 幂等不被破坏：同一 now 两次独立演化，第二次是空操作
//
// 隔离铁律（video-test 头注的血泪）：env 沙箱必须在任何 field/paths 模块 import 之前设好。
// 子进程由父进程注入 env，父进程自己也先设 env 再动态 import。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-field-race-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

// 子进程脚本：往 tension 上加 ARGV_DELTA（tension 没有入向耦合，扰动不会被演化吃掉）
const CHILD = `
const delta = Number(process.argv[2] || '0')
const { poke } = await import(${JSON.stringify(pathToFileURL(path.join(APP, 'tools/brain/field.mjs')).href)})
const r = poke('tension', delta)
if (!r) { console.error('poke returned null'); process.exit(1) }
console.log('ok')
`

function spawnPoker(delta) {
  return new Promise((res) => {
    const c = spawn(process.execPath, ['-e', CHILD, String(delta)], {
      env: { ...process.env, BOT_DATA_DIR: tmp, USERPROFILE: tmp, HOME: tmp, DSH_HOME: path.join(tmp, '.dsh') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    c.stderr.on('data', (d) => { err += d })
    c.on('exit', (code) => res({ code, err }))
  })
}

try {
  const { readJson } = await import(pathToFileURL(path.join(APP, 'tools/brain/json.mjs')).href)
  const { fieldPath } = await import(pathToFileURL(path.join(APP, 'tools/brain/paths.mjs')).href)

  // ① 10 个进程并发 poke +0.3 → 期望 tension == 3.0（旧实现大约只有 0.3~1.x）
  const N = 10
  const rs = await Promise.all(Array.from({ length: N }, () => spawnPoker(0.3)))
  ok('10 个并发 poke 子进程全部正常退出', rs.every((r) => r.code === 0), rs.find((r) => r.code !== 0)?.err?.slice(0, 120))
  const st = readJson(fieldPath(), null)
  ok('并发 poke 零丢失（tension == 3.0）', !!st && Math.abs(Number(st.dims?.tension) - 3.0) < 0.01,
    '实际 tension=' + st?.dims?.tension)
  ok('演化时间戳在走（at > 0）', !!st && Number(st.at) > 0)

  // ② evolve(now, pre)：带 pre 不落盘（落盘交给调用方的临界区写）
  const { evolve } = await import(pathToFileURL(path.join(APP, 'tools/brain/field.mjs')).href)
  const { fieldPath: fp2 } = await import(pathToFileURL(path.join(APP, 'tools/brain/paths.mjs')).href)
  const before = JSON.parse(JSON.stringify(readJson(fp2(), null)))
  const now = Date.now()
  const stPre = evolve(now + 60_000, JSON.parse(JSON.stringify(before)))   // 深拷贝当 pre
  const afterPre = readJson(fp2(), null)
  ok('带 pre 的 evolve 不落盘（磁盘 at 未变）', Number(afterPre.at) === Number(before.at),
    `磁盘 at=${afterPre.at} 内存 at=${stPre.at}`)
  ok('带 pre 的 evolve 仍在内存里演化（at 推进了）', Number(stPre.at) === now + 60_000)

  // ③ 幂等：不带 pre 连续两次独立演化（第二次 dt=0，应空操作且值不变）
  const a1 = evolve(now + 120_000)
  const snap1 = JSON.stringify(a1.dims)
  const a2 = evolve(now + 120_000)
  ok('evolve 幂等（同一 now 第二次为空操作）', JSON.stringify(a2.dims) === snap1)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 测试残留由 run-tests 兜底清扫 */ }
}

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ field 并发读写全绿')
process.exitCode = bad ? 1 : 0
