// bili-submit —— B站自动投稿：视频文件 → 预上传 → 分片上传 → 合并 → 提交。
// 归属（10-31）：她投稿自己的作品，凭据共用（笨蛋老爹 cookie + csrf）。
// 用法：node feiyu.mjs bili-submit <video.mp4> --title 标题 --tid 21 --tags a,b --desc 简介 [--cover c.jpg] [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { loadCred } from '../lib/cred.mjs'
import { makeHeaders } from '../lib/bili-api.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const CHUNK_SIZE = 4 * 1024 * 1024

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : '' }

async function preupload(cred, fileName, size) {
  const u = new URL('https://member.bilibili.com/preupload')
  u.searchParams.set('name', fileName)
  u.searchParams.set('size', String(size))
  u.searchParams.set('rtype', '1')
  u.searchParams.set('profile', 'ugcfx/bup')
  u.searchParams.set('upcdn', 'bda2')
  u.searchParams.set('probe_version', '20221109')
  const r = await fetch(u, { headers: { ...makeHeaders(cred), 'user-agent': UA, referer: 'https://member.bilibili.com/' }, signal: AbortSignal.timeout(15000) })
  return await r.json()
}

async function putChunk(up, chunk, partNum) {
  const start = partNum * CHUNK_SIZE
  const u = new URL('https://' + up.endpoint + '/' + up.biz_id)
  u.searchParams.set('partNumber', String(partNum + 1))
  u.searchParams.set('uploadId', up.upload_id)
  u.searchParams.set('os', up.os)
  u.searchParams.set('chunk', String(partNum))
  u.searchParams.set('chunks', String(Math.max(1, partNum + 1)))
  u.searchParams.set('size', String(chunk.length))
  u.searchParams.set('start', String(start))
  u.searchParams.set('end', String(start + chunk.length))
  const r = await fetch(u, {
    method: 'PUT',
    headers: { 'x-upos-auth': up.auth, 'content-type': 'application/octet-stream', 'user-agent': UA },
    body: chunk,
    signal: AbortSignal.timeout(60000),
  })
  return { ok: r.ok, status: r.status, text: (await r.text().catch(() => '')).slice(0, 120) }
}

async function combine(up, parts) {
  const u = new URL('https://' + up.endpoint + '/' + up.biz_id)
  u.searchParams.set('output', 'json')
  u.searchParams.set('name', up.upname || 'video.mp4')
  u.searchParams.set('profile', 'ugcfx/bup')
  u.searchParams.set('os', up.os)
  u.searchParams.set('uploadId', up.upload_id)
  u.searchParams.set('biz_id', String(up.biz_id))
  const body = JSON.stringify(parts.map((p) => ({ partNumber: p, eTag: 'etag' })))
  const r = await fetch(u, {
    method: 'POST',
    headers: { 'x-upos-auth': up.auth, 'content-type': 'application/json; charset=UTF-8', 'user-agent': UA },
    body,
    signal: AbortSignal.timeout(30000),
  })
  return await r.json().catch(() => ({}))
}

async function submitArchive(cred, opts) {
  const body = {
    cover: opts.cover || '',
    title: String(opts.title || '未命名').slice(0, 80),
    tid: Number(opts.tid) || 21,
    tag: String(opts.tags || '自制'),
    desc: String(opts.desc || '').slice(0, 2000),
    copyright: 1,
    source: '',
    dynamic: '',
    no_reprint: 1,
    open_elec: 1,
    dtime: 0,
    act_reserve_create: 0,
    csrf: cred.bili_jct,
    csrf_token: cred.bili_jct,
    videos: [{ filename: opts.biliFilename, title: '正片', desc: '' }],
  }
  const r = await fetch('https://member.bilibili.com/x/vu/web/add/v3', {
    method: 'POST',
    headers: { ...makeHeaders(cred), 'content-type': 'application/json', referer: 'https://member.bilibili.com/platform/upload/video/frame', 'user-agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  return await r.json().catch(() => ({}))
}

export async function submitVideo(videoPath, opts = {}) {
  const cred = loadCred()
  const st = fs.statSync(videoPath)
  const fileName = path.basename(videoPath)
  const up0 = await preupload(cred, fileName, st.size)
  if (!up0?.upload_id) return { ok: false, why: 'preupload 失败：' + JSON.stringify(up0).slice(0, 150) }
  const up = { ...up0, upname: fileName }
  const chunks = Math.ceil(st.size / CHUNK_SIZE)
  const parts = []
  const fd = fs.openSync(videoPath, 'r')
  try {
    for (let i = 0; i < chunks; i++) {
      const buf = Buffer.alloc(Math.min(CHUNK_SIZE, st.size - i * CHUNK_SIZE))
      fs.readSync(fd, buf, 0, buf.length, i * CHUNK_SIZE)
      const r = await putChunk(up, buf, i)
      if (!r.ok) return { ok: false, why: '分片 ' + (i + 1) + '/' + chunks + ' 失败 HTTP ' + r.status + ': ' + r.text }
      parts.push(i + 1)
      if (opts.onProgress) opts.onProgress(i + 1, chunks)
    }
  } finally { fs.closeSync(fd) }
  const c = await combine(up, parts)
  if (c?.ok !== 1 && c?.code !== 0) return { ok: false, why: '合并失败：' + JSON.stringify(c).slice(0, 150) }
  if (opts.dry) return { ok: true, dry: true, why: '上传+合并完成，dry 不提交' }
  const j = await submitArchive(cred, { ...opts, biliFilename: up.bili_filename || up.filename })
  if (j?.code === 0) return { ok: true, aid: j?.data?.aid, bvid: j?.data?.bvid }
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
  console.log('投稿「' + opts.title + '」：' + (fs.statSync(video).size / 1048576).toFixed(1) + 'MB，分片上传中…')
  const r = await submitVideo(video, opts)
  if (!r.ok) { console.error('✗ ' + r.why); process.exit(1) }
  console.log(r.dry ? '✓ 上传+合并成功（dry，未提交）' : '✓ 投稿成功：' + (r.bvid || r.aid))
}
