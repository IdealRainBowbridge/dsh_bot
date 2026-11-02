// bili-submit —— B站自动投稿（实测通过的链路，10-31）。
// probe → preupload(r=upos, profile=ugcupos/bup, probe_version/upcdn/zone) → 分片PUT → 合并 → 提交 add/v3
// 用法：node bot.mjs bili-submit <video.mp4> --title 标题 --tid 21 --tags a,b --desc 简介 [--cover c.jpg] [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { loadCred } from '../lib/cred.mjs'
import { makeHeaders } from '../lib/bili-api.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
/* chunk_size 由 preupload 返回值决定 */

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : '' }

async function probe() {
  const r = await fetch('https://member.bilibili.com/preupload?r=probe', {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  const j = await r.json()
  const lines = (j.lines || []).filter((l) => l.os === 'upos')
  const line = lines.find((l) => (l.query || '').includes('upcdn=bda2')) || lines[0]
  if (!line) throw new Error('probe 没返回可用线路')
  return line
}

async function preupload(cred, line, fileName, size) {
  const u = new URL('https://member.bilibili.com/preupload')
  for (const [k, v] of new URLSearchParams(line.query)) u.searchParams.set(k, v)
  u.searchParams.set('r', line.os)
  u.searchParams.set('profile', 'ugcupos/bup')
  u.searchParams.set('ssl', '0')
  u.searchParams.set('version', '2.11.0')
  u.searchParams.set('build', '2110000')
  u.searchParams.set('name', fileName)
  u.searchParams.set('size', String(size))
  const r = await fetch(u, {
    headers: { ...makeHeaders(cred), 'user-agent': UA, referer: 'https://member.bilibili.com/platform/upload/video/frame' },
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json()
  if (String(j.OK) !== '1') throw new Error('preupload 失败：' + JSON.stringify(j).slice(0, 150))
  return j
}

async function initUpload(up) {
  const u = new URL("https:" + up.endpoint + "/" + String(up.upos_uri).replace("upos://", ""))
  u.searchParams.set("uploads", "")
  u.searchParams.set("output", "json")
  const r = await fetch(u, {
    method: "POST",
    headers: { "X-Upos-Auth": up.auth, "user-agent": UA },
    signal: AbortSignal.timeout(60000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j?.upload_id) throw new Error("initUpload 失败：" + JSON.stringify(j).slice(0, 120))
  return j.upload_id
}

async function putChunk(up, chunk, partNum, chunksTotal, totalSize) {
  const start = partNum * up.chunk_size
  const u = new URL("https:" + up.endpoint + "/" + String(up.upos_uri).replace("upos://", ""))
  u.searchParams.set("uploadId", up.upload_id)
  u.searchParams.set("chunks", String(chunksTotal))
  u.searchParams.set("total", String(totalSize))
  u.searchParams.set("chunk", String(partNum))
  u.searchParams.set("size", String(chunk.length))
  u.searchParams.set("partNumber", String(partNum + 1))
  u.searchParams.set("start", String(start))
  u.searchParams.set("end", String(start + chunk.length))
  const r = await fetch(u, {
    method: 'PUT',
    headers: { 'X-Upos-Auth': up.auth, 'user-agent': UA },
    body: chunk,
    signal: AbortSignal.timeout(120000),
  })
  return { ok: r.ok, status: r.status, text: (await r.text().catch(() => '')).slice(0, 120) }
}

async function combine(up, parts) {
  const u = new URL('https:' + up.endpoint + '/' + String(up.upos_uri || '').replace('upos://', ''))
  u.searchParams.set('output', 'json')
  u.searchParams.set('profile', 'ugcupos/bup')
  u.searchParams.set('uploadId', up.upload_id)
  u.searchParams.set('biz_id', String(up.biz_id))
  const r = await fetch(u, {
    method: 'POST',
    headers: { 'X-Upos-Auth': up.auth, 'content-type': 'application/json; charset=UTF-8', 'user-agent': UA },
    body: JSON.stringify({ parts: parts.map((p) => ({ partNumber: p, eTag: "etag" })) }),
    signal: AbortSignal.timeout(30000),
  })
  return await r.json().catch(() => ({}))
}

async function submitArchive(cred, opts) {
  const body = {
    copyright: 1,
    source: '',
    tid: Number(opts.tid) || 21,
    cover: opts.cover || '',
    title: String(opts.title || '未命名').slice(0, 80),
    desc_format_id: 0,
    desc: String(opts.desc || '').slice(0, 2000),
    dynamic: '',
    subtitle: { open: 0, lan: '' },
    tag: String(opts.tags || '自制'),
    videos: [{ filename: opts.biliFilename, title: '正片', desc: '' }],
  }
  const r = await fetch('https://member.bilibili.com/x/vu/web/add?csrf=' + cred.bili_jct, {
    method: 'POST',
    headers: { ...makeHeaders(cred), 'content-type': 'application/json', referer: 'https://member.bilibili.com/platform/upload/video/frame', origin: 'https://member.bilibili.com', 'user-agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  return await r.json().catch(() => ({}))
}

export async function submitVideo(videoPath, opts = {}) {
  const cred = loadCred()
  const st = fs.statSync(videoPath)
  const fileName = path.basename(videoPath)
  const line = await probe()
  const up = await preupload(cred, line, fileName, st.size)
  up.upload_id = await initUpload(up)   // upos 协议：PUT 前先 ?uploads 初始化拿真 upload_id
  const CHUNK = Number(up.chunk_size) || 4 * 1024 * 1024
  const chunks = Math.ceil(st.size / CHUNK)
  const parts = []
  const fd = fs.openSync(videoPath, 'r')
  try {
    for (let i = 0; i < chunks; i++) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - i * CHUNK))
      fs.readSync(fd, buf, 0, buf.length, i * CHUNK)
      const r = await putChunk(up, buf, i, chunks, st.size)
      if (!r.ok) return { ok: false, why: '分片 ' + (i + 1) + '/' + chunks + ' 失败 HTTP ' + r.status + ': ' + r.text }
      parts.push(i + 1)
      if (opts.onProgress) opts.onProgress(i + 1, chunks)
    }
  } finally { fs.closeSync(fd) }
  const c = await combine(up, parts, fileName)
  if (String(c?.OK) !== '1' && c?.code !== 0) return { ok: false, why: '合并失败：' + JSON.stringify(c).slice(0, 150) }
  if (opts.dry) return { ok: true, dry: true, why: '上传+合并完成（dry 未提交）' }
  console.log('[debug] bili_filename=' + up.bili_filename + ' upos=' + up.upos_uri)
  const biliName = String(up.upos_uri || '').split('/').pop().replace(/\.[^.]*$/, '')
  console.log('[debug] biliName=' + biliName)
  const j = await submitArchive(cred, { ...opts, biliFilename: biliName })
  if (j?.code === 0) {
    // 跨会话记忆（10-31）：投稿成功必须进统一记忆——她要记得自己发过什么。
    try {
      const { default: memory } = await import('../lib/memory.mjs')
      memory.remember('bilibili', 'bilibili:self', '40048138', 'assistant',
        `投稿成功：《${opts.title}》 BV${j.data.bvid}（自动投稿）`, { kind: 'post' })
    } catch {}
    return { ok: true, aid: j?.data?.aid, bvid: j?.data?.bvid }
  }
  return { ok: false, why: '提交失败 code=' + j?.code + ': ' + (j?.message || '') }
}

export async function run(argv) {
  const video = argv.find((a) => a.endsWith('.mp4'))
  if (!video || !fs.existsSync(video)) { console.error('用法：bili-submit <video.mp4> --title 标题 --tid 21 --tags a,b --desc 简介 [--cover c.jpg] [--dry]'); process.exit(2) }
  const opts = {
    title: arg(argv, '--title') || '未命名',
    tid: Number(arg(argv, '--tid')) || 21,
    tags: arg(argv, '--tags') || '自制',
    desc: arg(argv, '--desc') || '',
    cover: arg(argv, '--cover') || '',
    dry: argv.includes('--dry'),
  }
  console.log('投稿「' + opts.title + '」：' + (fs.statSync(video).size / 1048576).toFixed(2) + 'MB，probe→preupload→分片上传…')
  const r = await submitVideo(video, opts)
  if (!r.ok) { console.error('✗ ' + r.why); process.exit(1) }
  console.log(r.dry ? '✓ ' + r.why : '✓ 投稿成功：' + (r.bvid || r.aid))
}
