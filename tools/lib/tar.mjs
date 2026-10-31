// tar —— 极简 tar.gz 写入器（v5 新增，零外部依赖）。
//
// 为什么需要它：`sleep` 的第三阶段是"优化增强（git 归档）"，它调 `git` 命令。
// 但容器里**根本没装 git**（Debian 精简镜像），`runCmd('git', ...)` 抛错后被
// `catch {}` 吞掉 —— 于是"睡一觉会归档代码"这件事从来没发生过，而报告里打着勾。
//
// 与其为了一个归档动作往镜像里塞 git（还要 root、还要维护），不如用 Node 自带的
// zlib 直接写 tar.gz：tar 格式就是 512 字节头部 + 数据 + 补零，40 行能写完。
// 好处：零依赖、任何环境都能跑、产物是标准 tar.gz（能 tar -tzf 验证）。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const BLOCK = 512

/** 写一个 tar 头（ustar 格式）。 */
function header({ name, size, mode = 0o644, mtime = Date.now(), type = '0' }) {
  const buf = Buffer.alloc(BLOCK, 0)
  const put = (str, off, len) => buf.write(String(str).slice(0, len - 1), off, len, 'utf8')
  put(name, 0, 100)
  put(mode.toString(8).padStart(7, '0'), 100, 8)
  put('0000000', 108, 8)                     // uid
  put('0000000', 116, 8)                     // gid
  put(size.toString(8).padStart(11, '0'), 124, 12)
  put(Math.floor(mtime / 1000).toString(8).padStart(11, '0'), 136, 12)
  buf.write('        ', 148, 8, 'ascii')     // 校验和先填空格
  put(type, 156, 1)
  put('ustar', 257, 6)
  put('00', 263, 2)
  // 校验和 = 全部字节按无符号求和
  let sum = 0
  for (const b of buf) sum += b
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return buf
}

/** 补零到 512 的整数倍。 */
function pad(size) {
  const r = size % BLOCK
  return r === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - r, 0)
}

/**
 * 递归收集文件（跳过 exclude 命中的路径）。
 * @returns {{abs:string, rel:string, size:number, mtime:number}[]}
 */
export function collect(root, { exclude = [], maxFiles = 20000, maxBytes = 512 * 1024 * 1024 } = {}) {
  const out = []
  let bytes = 0
  const walk = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const abs = path.join(dir, e.name)
      const rel = path.relative(root, abs)
      if (exclude.some((re) => re.test(rel) || re.test(e.name))) continue
      if (e.isDirectory()) { if (e.name !== '.git' || !exclude.some((r) => r.test('.git'))) walk(abs); continue }
      if (!e.isFile()) continue
      let st
      try { st = fs.statSync(abs) } catch { continue }
      if (bytes + st.size > maxBytes) return
      bytes += st.size
      out.push({ abs, rel, size: st.size, mtime: st.mtimeMs })
      if (out.length >= maxFiles) return
    }
  }
  walk(root)
  return out
}

/**
 * 把目录打成 tar.gz。
 * @returns {{ok:boolean, file?:string, files?:number, bytes?:number, error?:string}}
 */
export function tarGzDir(root, dest, opts = {}) {
  try {
    const files = collect(root, opts)
    if (!files.length) return { ok: false, error: '没有可归档的文件' }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const chunks = []
    for (const f of files) {
      let data
      try { data = fs.readFileSync(f.abs) } catch { continue }
      chunks.push(header({ name: f.rel.replace(/\\/g, '/'), size: data.length, mtime: f.mtime }))
      chunks.push(data)
      chunks.push(pad(data.length))
    }
    chunks.push(Buffer.alloc(BLOCK * 2, 0))     // 结束标记：两个全零块
    const tar = Buffer.concat(chunks)
    const gz = zlib.gzipSync(tar, { level: 6 })
    const tmp = dest + '.tmp'
    fs.writeFileSync(tmp, gz)
    fs.renameSync(tmp, dest)                   // 原子落盘：写到一半不会留下半个包
    return { ok: true, file: dest, files: files.length, bytes: gz.length }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 读一个 tar.gz 的条目名（自检用：证明写出来的包真能读）。 */
export function listTarGz(file, limit = 50) {
  try {
    const gz = fs.readFileSync(file)
    const tar = zlib.gunzipSync(gz)
    const names = []
    let off = 0
    while (off + BLOCK <= tar.length && names.length < limit) {
      const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '')
      if (!name) break
      const sizeOctal = tar.subarray(off + 124, off + 136).toString('ascii').replace(/\0.*$/, '').trim()
      const size = parseInt(sizeOctal, 8) || 0
      names.push(name)
      off += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    }
    return names
  } catch { return [] }
}
