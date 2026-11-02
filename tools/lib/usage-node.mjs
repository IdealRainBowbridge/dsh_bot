// 纯 Node 版的 token 用量统计 —— 不依赖 python / zstandard。
// 背景（10-31 审计）：原来只有 lib/ledger_usage.py 一条路，而容器里根本没装 python3，
// 于是「账本」功能整个不可用（selftest 一直是 ✗）。Node 22+ 内置 zstd，可以直接解。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { swallow } from './swallow.mjs'

const MAGIC = [0x28, 0xB5, 0x2F, 0xFD]

/** 会话日志是多帧拼接的（每行一个 zstd 帧），不能整块当一帧解。 */
function decodeFrames(buf) {
  const out = []
  let off = 0
  while (off < buf.length) {
    if (!MAGIC.every((b, i) => buf[off + i] === b)) {
      try { out.push(zlib.zstdDecompressSync(buf.subarray(off))) } catch (e) { swallow(e, 'usage-node:decodeFrames') }
      break
    }
    let ok = false
    for (let end = buf.length; end > off; end--) {
      try {
        out.push(zlib.zstdDecompressSync(buf.subarray(off, end)))
        off = end
        ok = true
        break
      } catch (e) { swallow(e, 'usage-node:decodeFrames') }
    }
    if (!ok) break
  }
  return out
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
const pick = (u, ...keys) => {
  for (const k of keys) if (u[k] != null) return num(u[k])
  return 0
}

export function collectUsage(sessionsDir, mineWorkspace = 'bot-work') {
  const days = new Map()
  const lifetime = { input: 0, output: 0, cached: 0, total: 0 }
  let sessions = 0

  const bump = (day, who, u) => {
    if (!days.has(day)) days.set(day, { day, mine: { input: 0, output: 0, cached: 0 }, owner: { input: 0, output: 0, cached: 0 } })
    const t = days.get(day)[who]
    t.input += pick(u, 'input_tokens', 'inputTokens', 'prompt_tokens')
    t.output += pick(u, 'output_tokens', 'outputTokens', 'completion_tokens')
    t.cached += pick(u, 'cached_tokens', 'cachedTokens', 'cache_read_input_tokens')
  }

  let wsList = []
  try { wsList = fs.readdirSync(sessionsDir) } catch { return { days: [], lifetime, sessions: 0 } }

  for (const ws of wsList) {
    const wsDir = path.join(sessionsDir, ws)
    let inner = []
    try { inner = fs.readdirSync(wsDir) } catch { continue }
    const isMine = ws.includes(mineWorkspace)
    for (const s of inner) {
      const f = path.join(wsDir, s, 'session.v4.jsonl.zstd')
      let buf
      try { buf = fs.readFileSync(f) } catch { continue }
      sessions++
      for (const chunk of decodeFrames(buf)) {
        for (const line of chunk.toString('utf8').split('\n')) {
          const t = line.trim()
          if (!t) continue
          let row
          try { row = JSON.parse(t) } catch { continue }
          if (row.type !== 'assistant' && row.type !== 'message') continue
          const u = row.usage || (row.data && row.data.usage)
          if (!u) continue
          const ts = Number(row.createdAt || row.ts || row.timestamp || 0)
          const day = new Date(ts || Date.now()).toLocaleDateString('sv-SE')
          const who = isMine && (row.role === 'assistant' || !row.role) ? 'mine' : 'owner'
          bump(day, who, u)
          lifetime.input += pick(u, 'input_tokens', 'prompt_tokens')
          lifetime.output += pick(u, 'output_tokens', 'completion_tokens')
          lifetime.cached += pick(u, 'cached_tokens', 'cache_read_input_tokens')
        }
      }
    }
  }

  lifetime.total = lifetime.input + lifetime.output
  const list = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
  return { days: list, lifetime, sessions }
}
