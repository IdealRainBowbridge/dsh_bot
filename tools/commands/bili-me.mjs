// bili-me —— 她自己的账号台：whoami + 改签名。
// 账号归属（10-31 笨蛋老爹拍板）：B站糖鲸大肥鱼归她运营，这是本鱼自己的号（糖鲸大肥鱼）。
// 接口实测（10-31）：改签名走 POST /x/member/web/update（usersign 小写，整包 uname/sex/birthday）。
import { config } from '../lib/config.mjs'
import { loadCred } from '../lib/cred.mjs'
import { makeHeaders } from '../lib/bili-api.mjs'

const MY_MID = () => String(config().owner?.biliMid || config().owner?.mid || '40048138')

export async function whoami() {
  const cfg = config()
  const out = { bilibili: {}, qq: {}, owner: {} }
  try {
    const cred = loadCred()
    out.bilibili.hasCred = true
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: makeHeaders(cred),
      signal: AbortSignal.timeout(10000),
    })
    const j = await r.json().catch(() => ({}))
    if (j?.code === 0 && j.data?.mid) {
      out.bilibili = {
        mid: j.data.mid,
        name: j.data.uname,
        level: j.data.level_info?.current_level,
        coins: j.data.money,
        sign: (await getSign()).sign || '',
      }
    } else {
      out.bilibili.error = '凭据失效或被风控（code ' + (j?.code ?? '?') + '）—— 需要笨蛋老爹重贴 cookie'
    }
  } catch (e) {
    out.bilibili.error = String(e.message).slice(0, 100)
  }
  out.qq = { self: String(cfg.qq?.self_id || ''), owner: String(cfg.owner?.qq || '') }
  out.owner = { name: cfg.owner?.name || '', mid: cfg.owner?.mid || '', note: '这是本鱼的号，这是本鱼自己的号（糖鲸大肥鱼）' }
  return out
}

export async function getSign() {
  const cred = loadCred()
  const r = await fetch('https://api.bilibili.com/x/web-interface/card?mid=' + MY_MID(), {
    headers: { ...makeHeaders(cred), 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  })
  const j = await r.json().catch(() => ({}))
  if (j?.code !== 0) return { ok: false, why: 'card 接口失败 code=' + j?.code }
  return { ok: true, sign: j.data?.card?.sign || '', mid: MY_MID(), uname: j.data?.card?.name || '' }
}

export async function setSign(rawText) {
  const text = String(rawText || '').trim().slice(0, 120)
  if (!text) return { ok: false, why: '签名不能为空' }
  const cred = loadCred()
  const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: makeHeaders(cred), signal: AbortSignal.timeout(10000) })
  const nd = await nav.json().catch(() => ({}))
  const cur = nd?.data || {}
  const body = new URLSearchParams({
    uname: cur.uname || '糖鲸大肥鱼',
    usersign: text,
    sex: cur.sex || '保密',
    birthday: cur.birthday || '',
    csrf: cred.bili_jct,
    csrf_token: cred.bili_jct,
  })
  const r = await fetch('https://api.bilibili.com/x/member/web/update', {
    method: 'POST',
    headers: { ...makeHeaders(cred), 'content-type': 'application/x-www-form-urlencoded', referer: 'https://space.bilibili.com/', origin: 'https://space.bilibili.com' },
    body,
    signal: AbortSignal.timeout(10000),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: j?.code === 0, code: j?.code, why: j?.message || '', text }
}

export async function run(args) {
  const sub = args[0]
  if (sub === 'sign') {
    if (args[1] === '--set') {
      const text = args.slice(2).join(' ')
      const r = await setSign(text)
      console.log(r.ok ? '✓ 签名已改：' + r.text : '✗ 改签名失败：' + (r.why || JSON.stringify(r)))
      return
    }
    const s = await getSign()
    console.log(s.ok ? '当前签名：' + s.sign : '✗ ' + s.why)
    return
  }
  const me = await whoami()
  const b = me.bilibili
  console.log('【B站】' + (b.mid ? b.name + '（mid ' + b.mid + '）Lv.' + b.level + ' · 硬币 ' + b.coins + ' · 签名「' + b.sign + '」' : '✗ ' + (b.error || '未知')))
  console.log('【QQ 】我自己 ' + me.qq.self + '；笨蛋老爹 ' + me.qq.owner)
  console.log('【关系】这是本鱼的号，这是本鱼自己的号（糖鲸大肥鱼）；写操作走额度计数。')
}
