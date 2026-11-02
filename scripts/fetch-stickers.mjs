// fetch-stickers —— 从 lmy414/ai-girl-stickers 拉「蓝色大肥鱼」表情包（2026-11-02）
//
// 为什么用别人整理好的图库，而不是继续 AI 现画：
//   · AI 文生图出来的"鲸鱼娘"跟她的实际形象**不是一个人**（每张脸都不一样）
//   · 这些是社区真实二创，有台词、有梗、风格统一 —— 她发出来才像"她"
//
// 关键（2026-11-02 实测）：GitHub raw 从容器内**直连超时**（curl 000），
// 必须走宿主 mihomo（172.17.0.1:7890）。node fetch 不认代理环境变量，
// 所以统一用 curl 子进程 + `-x`。
//
// 用法：
//   node scripts/fetch-stickers.mjs                 # 全部 940 张
//   node scripts/fetch-stickers.mjs --limit 20      # 只下 20 张
//   BOT_PROXY= node scripts/fetch-stickers.mjs    # 强制直连（本机有梯子时）
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { homePath, dataPath } from '../tools/lib/paths.mjs'
import { swallow } from '../tools/lib/swallow.mjs'

const REPO = 'lmy414/ai-girl-stickers'
const BRANCH = 'main'
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`
const API = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`

// 宿主 mihomo 监听 7890（注意：不是旧代码里写的 7897，那个端口没人在听）
const PROXY = process.env.BOT_PROXY !== undefined
  ? process.env.BOT_PROXY
  : 'http://172.17.0.1:7890'

const argv = process.argv.slice(2)
const getArg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const LIMIT = Number(getArg('--limit') || 0)
const OUT = getArg('--dir') || dataPath('sticker-src')

function curlTo(url, outPath, timeoutSec = 90) {
  return new Promise((resolve) => {
    const args = ['-sS', '-L', '-m', String(timeoutSec), '-o', outPath]
    if (PROXY) args.push('-x', PROXY)
    args.push('-A', 'bot-sticker-fetch', url)
    execFile('curl', args, { timeout: timeoutSec * 1000 + 5000, maxBuffer: 1024 * 1024 }, (err, _so, se) => {
      if (err) return resolve(String(se || err.message).slice(0, 70) || 'curl 失败')
      try {
        const st = fs.statSync(outPath)
        if (st.size < 500) return resolve('太小 ' + st.size)
        resolve(null)
      } catch { resolve('没生成文件') }
    })
  })
}

async function listFiles() {
  const tmp = '/tmp/sticker-tree.json'
  const err = await curlTo(API, tmp, 90)
  if (err) throw new Error('列目录失败：' + err)
  const j = JSON.parse(fs.readFileSync(tmp, 'utf8'))
  if (!j.tree) throw new Error('拿不到 tree：' + JSON.stringify(j).slice(0, 200))
  return j.tree
    .filter((x) => x.type === 'blob' && /^dist\/submissions\/large\/deepseek\/.+\.(webp|png|jpg|gif)$/i.test(x.path))
    .map((x) => ({ path: x.path, size: x.size || 0 }))
}

async function downloadOne(file) {
  const name = path.basename(file.path)
  const dest = path.join(OUT, name)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 500) return { skipped: true }
  const tmp = dest + '.part'
  for (let attempt = 1; attempt <= 4; attempt++) {
    const err = await curlTo(RAW + encodeURI(file.path), tmp, 90)
    if (!err) {
      try {
        fs.renameSync(tmp, dest)
        return { ok: true, bytes: fs.statSync(dest).size }
      } catch (e) { return { fail: e.message } }
    }
    try { fs.rmSync(tmp, { force: true }) } catch (e) { swallow(e, 'fetch-stickers:downloadOne') }
    if (attempt === 4) return { fail: err }
    await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`[fetch] 代理: ${PROXY || '(直连)'}`)
  console.log('[fetch] 列目录…')
  let files = await listFiles()
  console.log(`[fetch] 共 ${files.length} 张（deepseek large）`)
  if (LIMIT > 0) files = files.slice(0, LIMIT)
  const total = files.length
  let done = 0, skip = 0, fail = 0, bytes = 0, idx = 0
  const CONC = 5
  async function worker() {
    while (idx < files.length) {
      const f = files[idx++]
      const r = await downloadOne(f)
      if (r.skipped) skip++
      else if (r.ok) { done++; bytes += r.bytes }
      else { fail++; if (fail <= 8) console.log('  ✗', path.basename(f.path), r.fail) }
      const n = done + skip + fail
      if (n % 50 === 0) console.log(`  ${n}/${total}  下 ${done} 跳 ${skip} 败 ${fail}  ${(bytes / 1048576).toFixed(1)}MB`)
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  console.log(`[fetch] 完成：下载 ${done} / 跳过 ${skip} / 失败 ${fail}，共 ${(bytes / 1048576).toFixed(1)}MB`)
  console.log(`[fetch] 目录：${OUT}`)
}
main().catch((e) => { console.error('[fetch] 失败：' + e.message); process.exit(1) })
