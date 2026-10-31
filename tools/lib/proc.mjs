// proc —— 子进程与端口管理（v5 从 lib/index.js 抽出）。
//
// 为什么抽出：
//   ① lib/index.js 是 1100+ 行的插件壳主闭包，这几段（进程存活判定/杀进程树/
//      清端口占用/探活 /health）是**自成一体**的，抽出来能单测，也让主文件回到护栏内；
//   ② 这些逻辑里有几个真实踩过的坑（Windows 的 launcher 会再 spawn 一个真 node、
//      netstat 输出格式、超时缺失），集中在一处比散在闭包里更容易维护。
import http from 'node:http'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { swallow } from './swallow.mjs'

/** 进程还活着吗（Node 的 exitCode/signalCode 都为 null 才算活）。 */
export const procAlive = (p) => !!p && p.exitCode === null && p.signalCode === null

/**
 * 杀掉一个进程树。
 * Windows 上 NODE_EXE 是 launcher，会再 spawn 一个真 node ——
 * 只 kill launcher 会让子进程变孤儿继续占端口，所以必须 /T。
 */
export function killTree(proc, tag = 'proc') {
  if (!proc) return
  const pid = proc.pid
  try { proc.kill() } catch (e) { swallow(e, tag + ':kill') }
  try { spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 10_000 }) } catch (e) { swallow(e, tag + ':taskkill') }
}

/** 面板/health 用的进程快照。 */
export const procInfo = (p) => ({ running: procAlive(p), pid: (p && p.pid) || null })

/**
 * 清掉占用某端口的旧 node 实例。
 *
 * 为什么需要：上次 DSH 没杀干净 / 手动起过 / 崩溃后留的僵尸进程会占着端口，
 * 新实例绑不上就**静默退出** —— 面板显示"开了"但其实没跑（10-25 抖音私信就是这样）。
 * 只杀 node.exe，绝不误伤同端口的第三方服务。
 */
export function killPortListeners(port, tag = '', { log = () => {} } = {}) {
  try {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    const re = new RegExp(`:${port}\\s+.*LISTENING`, 'i')
    const pids = new Set()
    for (const line of String(r.stdout || '').split('\n')) {
      if (!re.test(line)) continue
      const m = line.trim().match(/(\d+)\s*$/)
      if (m) pids.add(m[1])
    }
    for (const pid of pids) {
      const tl = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      if (!/node\.exe/i.test(String(tl.stdout || ''))) continue
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
      try { log(`[feiyu] 清掉占用 ${port} 的旧${tag}实例 pid=${pid}`) } catch { /* ignore */ }
    }
  } catch (e) { swallow(e, 'proc:killPort') }
}

/**
 * 端口上有没有活着的 /health（有就什么都不做，别去抢别人的进程）。
 * @returns {Promise<boolean>}
 */
export function portHealthy(port, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    try {
      const req = http.get({ host: '127.0.0.1', port: Number(port), path: '/health', timeout: timeoutMs }, (r) => {
        let b = ''
        r.on('data', (d) => { b += d })
        r.on('end', () => resolve(r.statusCode === 200))
      })
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.on('error', () => resolve(false))
    } catch { resolve(false) }
  })
}

/** 端口有没有在监听（不发 HTTP，只看 TCP 能不能连上）。 */
export function portOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    // ⚠️ ESM 里没有 require —— 必须顶部 import net（v5 抽出来时差点漏掉）
    const s = net.connect({ host: '127.0.0.1', port: Number(port) })
    const done = (v) => { try { s.destroy() } catch { /* ignore */ } resolve(v) }
    s.setTimeout(timeout, () => done(false))
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  })
}
