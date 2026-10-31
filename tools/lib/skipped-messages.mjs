// 看了但没接（10-31）—— 让"沉默"也变成一段经历，而不是丢了。
//
// 为什么需要：上一轮做了「不每条都回」。但"不回"现在是**纯丢弃**：
//   他说"我今天好累"，她没接 → 这条只进了短期记忆，下次聊天她不会主动提。
//   真人不是这样：他昨天说累，我昨儿没搭腔，今天我会问一句"昨天那个累劲儿过了没"。
//
// 设计：
//   · 每次"决定不回"时，把这句话记进一个 skips 队列（带时间、chatId、文本）
//   · 下次真的要回她话时，把最近 1-2 条"当时没接的"作为【上次你看到但没接的】注入
//   · 有 TTL（默认 12 小时）：隔太久就不提了，免得"三天前你说…"很怪
//   · 只记"有内容的"（>=6 字），跳过"嗯/好的"
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'

const FILE = () => dataPath('skipped-messages.json')
const TTL_MS = 12 * 3600_000
const MAX = 40

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    return Array.isArray(j) ? j : []
  } catch { return [] }
}
function write(list) {
  try {
    const f = FILE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(list.slice(-MAX), null, 1))
  } catch (e) { swallow(e, 'skipped:write') }
}

/** 记一条"看到了但没接"的话。 */
export function noteSkipped({ chatId = '', platform = 'qq', text = '', why = '' }) {
  const t = String(text || '').trim()
  if (!chatId || t.length < 6) return false      // 太短的（嗯/好的）不值得记
  const now = Date.now()
  const list = read().filter((x) => now - Number(x.at || 0) < TTL_MS)
  // 同会话同文本 10 分钟内只记一次（防连发重复）
  if (list.some((x) => x.chatId === chatId && x.text === t && now - x.at < 10 * 60_000)) return false
  list.push({ at: now, chatId, platform, text: t.slice(0, 200), why: String(why).slice(0, 60) })
  write(list)
  return true
}

/**
 * 取走这个会话"上次没接的"（取完标记已提，不再重复注入）。
 * @returns {string} 可直接塞进 prompt 的一段话（没有就返回空串）
 */
export function takeSkipped(chatId = '') {
  const now = Date.now()
  const list = read().filter((x) => now - Number(x.at || 0) < TTL_MS)
  const mine = list.filter((x) => x.chatId === chatId && !x.used)
  if (!mine.length) { write(list); return '' }
  // 只取最近 2 条，太久的不提
  const picked = mine.slice(-2)
  for (const p of picked) p.used = true
  write(list)
  const ago = (t) => {
    const min = Math.round((now - Number(t)) / 60000)
    if (min < 60) return min + ' 分钟前'
    const h = Math.round(min / 60)
    return h + ' 小时前'
  }
  const lines = picked.map((x) => '- ' + ago(x.at) + ' 他说：「' + String(x.text).slice(0, 80) + '」（当时你没接话）')
  return '【上次你看到但没接的】这些他当时说过、你没回。要是这会儿聊得上，可以自然提一句（别提得像翻旧账，一句就够）：\n' + lines.join('\n')
}

/** 清空（测试用）。 */
export function reset() { try { fs.rmSync(FILE(), { force: true }) } catch { /* noop */ } }

/** 统计。 */
export function stats() {
  const list = read()
  const now = Date.now()
  return {
    total: list.length,
    fresh: list.filter((x) => now - Number(x.at || 0) < TTL_MS).length,
    pending: list.filter((x) => !x.used && now - Number(x.at || 0) < TTL_MS).length,
  }
}
