// selfsrc —— 她读自己的代码（2026-11-02）
//
// 为什么需要：要「详细描述怎么改」，得先看得到代码。
// 之前她只有一个 42 条的命令列表，没有任何读文件的能力 ——
// 你让她改某处，她只能凭想象编，改出来的东西必然对不上。
//
//   node feiyu.mjs selfsrc tree                    # 项目结构
//   node feiyu.mjs selfsrc grep <关键词> [--dir tools]  # 搜代码
//   node feiyu.mjs selfsrc read <相对路径> [--from 1 --lines 120]   # 读一段
//
// 只读，不写。写仍然走 selfmod 的审批链。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

function safe(rel) {
  const p = path.resolve(ROOT, String(rel || ''))
  if (!p.startsWith(ROOT + path.sep)) return null
  return p
}
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

export async function run(argv = []) {
  const sub = argv[0] || 'tree'

  if (sub === 'tree') {
    const walk = (dir, depth, prefix) => {
      if (depth > 2) return
      let es = []
      try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      es.filter((e) => !['node_modules', '.git', 'preview'].includes(e.name))
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
        .forEach((e) => {
          const rel = path.relative(ROOT, path.join(dir, e.name))
          if (e.isDirectory()) {
            console.log(prefix + e.name + '/')
            walk(path.join(dir, e.name), depth + 1, prefix + '  ')
          } else if (/\.(mjs|cjs|js|json|md)$/.test(e.name)) {
            const sz = fs.statSync(path.join(dir, e.name)).size
            console.log(`${prefix}${e.name}  (${sz}B)`)
          }
        })
    }
    console.log(ROOT + '/')
    walk(ROOT, 0, '  ')
    return
  }

  if (sub === 'grep') {
    const kw = argv[1]
    if (!kw) { console.error('用法：selfsrc grep <关键词> [--dir tools]'); process.exit(1) }
    const base = safe(arg('--dir', '.')) || ROOT
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    let hits = 0
    const walk = (dir) => {
      if (hits > 60) return
      let es = []
      try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of es) {
        if (['node_modules', '.git', 'preview'].includes(e.name)) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.(mjs|cjs|js|md)$/.test(e.name)) continue
        let lines = []
        try { lines = fs.readFileSync(p, 'utf8').split('\n') } catch { continue }
        lines.forEach((l, i) => {
          if (hits > 60) return
          if (re.test(l)) { console.log(`${path.relative(ROOT, p)}:${i + 1}: ${l.trim().slice(0, 160)}`); hits++ }
        })
      }
    }
    walk(base)
    if (!hits) console.log('（没有匹配）')
    return
  }

  if (sub === 'read') {
    const rel = argv[1]
    if (!rel) { console.error('用法：selfsrc read <相对路径> [--from 1] [--lines 120]'); process.exit(1) }
    const p = safe(rel)
    if (!p) { console.error('路径必须在项目内'); process.exit(1) }
    let txt = ''
    try { txt = fs.readFileSync(p, 'utf8') } catch (e) { console.error('读不到：' + e.message); process.exit(1) }
    const all = txt.split('\n')
    const from = Math.max(1, Number(arg('--from', 1)) || 1)
    const n = Math.max(1, Math.min(400, Number(arg('--lines', 120)) || 120))
    console.log(`${rel}（共 ${all.length} 行，显示 ${from}-${Math.min(all.length, from + n - 1)}）`)
    console.log('─'.repeat(50))
    for (let i = from - 1; i < Math.min(all.length, from + n - 1); i++) {
      console.log(String(i + 1).padStart(5) + '│ ' + all[i])
    }
    return
  }

  console.log('用法：selfsrc tree | selfsrc grep <关键词> [--dir tools] | selfsrc read <相对路径> [--from N --lines N]')
}
