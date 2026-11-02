import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'))
process.env.BOT_DATA_DIR = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.HOME = TMP
process.env.USERPROFILE = TMP

const M = await import('/home/feiyu/plugins/dsh_bot/tools/lib/memory.mjs')
let bad = 0
const ok = (c, l) => { console.log((c ? '  ✓ ' : '  ✗ ') + l); if (!c) bad++ }

const f = path.join(TMP, 'x.jsonl')
const write = (rows) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

// 1) 小文件：全部返回
write([{ i: 1 }, { i: 2 }, { i: 3 }])
let t = M.readTail(f, 10)
ok(t.length === 3, '小文件全量返回 3 行')

// 2) 只取最后 N 行
write(Array.from({ length: 1000 }, (_, k) => ({ i: k })))
t = M.readTail(f, 5)
ok(t.length === 5, '1000 行只取 5 行（实际 ' + t.length + '）')
ok(t[4] === '{"i":999}', '最后一行正确')
ok(t[0] === '{"i":995}', '第一行是第 995 条')

// 3) 大文件 + 小 maxBytes：必须从换行处切开，不能返回半截 JSON
write(Array.from({ length: 20000 }, (_, k) => ({ i: k, pad: 'x'.repeat(50) })))
t = M.readTail(f, 5, 4096)
ok(t.length === 5, '大文件 + 4KB 窗口仍返回 5 行')
let parsed = 0
for (const line of t) { try { JSON.parse(line); parsed++ } catch { /* */ } }
ok(parsed === 5, '5 行全部是完整 JSON（没有半截行）')

// 4) 文件不存在
ok(M.readTail(path.join(TMP, 'nope.jsonl'), 5).length === 0, '文件不存在返回空数组')

// 5) 空文件
fs.writeFileSync(f, '')
ok(M.readTail(f, 5).length === 0, '空文件返回空数组')

// 6) 单行超长（超过 maxBytes）
fs.writeFileSync(f, JSON.stringify({ big: 'y'.repeat(9000) }) + '\n')
t = M.readTail(f, 5, 1024)
ok(t.length === 0, '单行超过窗口时返回空（不返回半截）')

fs.rmSync(TMP, { recursive: true, force: true })
console.log(bad ? '\n✗ ' + bad + ' 项失败' : '\n✓ readTail 全部通过')
process.exit(bad ? 1 : 0)
