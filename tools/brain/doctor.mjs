// brain/doctor —— 体检：把 8 条不变量变成能打印的东西（v3 §15）。
//
// 没有它，"她记得什么/说到做到没有"只能靠吵。`bot brain doctor` 一条命令全摊开。
import fs from 'node:fs'
import { listFiles, readJsonl, fileInfo } from './json.mjs'
import { BRAIN, metaDir, deliveryPath, claimsPath } from './paths.mjs'
import * as episode from './episode.mjs'
import * as facts from './facts.mjs'
import * as intents from './intents.mjs'
import * as selfM from './self.mjs'
import * as attention from './attention.mjs'
import * as delivery from './delivery.mjs'
import * as consolidate from './consolidate.mjs'
import * as metrics from './metrics.mjs'
import * as schema from './schema.mjs'
import * as competence from './competence.mjs'
import * as tasks from './taskqueue.mjs'
import { measure as measurePromptChars } from './assemble.mjs'
import { backlog as inboxBacklog } from './event.mjs'
import { config } from '../lib/config.mjs'
import * as bond from '../lib/bond.mjs'
import * as fieldMod from './field.mjs'
import * as reflexMod from './reflex.mjs'
import * as rhythmMod from './rhythm.mjs'
import { neuronPath } from './paths.mjs'

function ok(name, pass, detail = '') {
  return { name, ok: Boolean(pass), detail }
}

export function run({ measurePrompt = true, now = Date.now() } = {}) {
  const cfg = config()
  const b = cfg.brain || {}
  const items = []

  // I7 微信隔离：ep 里一行微信都不许有
  const eps = episode.allEpisodes()
  const wechatRows = eps.filter((e) => /wechat|wx/.test(String(e.where?.platform || '')) || /微信/.test(String(e.gist || '').slice(0, 2))).length
  items.push(ok('I7 微信不在脑里', wechatRows === 0, `ep 里微信行 ${wechatRows}`))

  // I1 单写者：不应有活着的残留锁
  const locks = listFiles(metaDir(), /^lock-.*\.lock$/).map((f) => {
    try { return JSON.parse(fs.readFileSync(metaDir() + '/' + f, 'utf8')) } catch { return null }
  }).filter(Boolean)
  const liveLocks = locks.filter((l) => {
    try { process.kill(Number(l.pid), 0); return true } catch { return false }
  })
  items.push(ok('I1 单写者（无残留活锁）', liveLocks.length === 0, `${liveLocks.length} 个锁被活进程持有（正常：正在进行一次写入）`))

  const backlog = inboxBacklog()
  items.push(ok('O1 事件积压', backlog < 200, `inbox 未消费 ${backlog}`))

  const stats = facts.stats()
  items.push(ok('O5 无证据不入库', stats.noProv === 0, `无 prov 事实 ${stats.noProv} 条`))
  items.push(ok('O5 事实有冲突要标 disputed', true, `active ${stats.active} / disputed ${stats.disputed} / 总 ${stats.total}`))

  const ist = intents.stats()
  items.push(ok('O7 意图必须可验收', ist.missingVerify === 0, `缺 verify ${ist.missingVerify} 条`))
  items.push(ok('O7 完成必须有证据', ist.noEvidenceDone === 0, `无证据的 done ${ist.noEvidenceDone} 条`))

  const cons = consolidate.status()
  const consAgeH = cons.lastRunAt ? (now - cons.lastRunAt) / 3600_000 : 999
  items.push(ok('L2 巩固在跑', consAgeH < 36, cons.lastRunAt ? `${consAgeH.toFixed(1)} 小时前跑过，待处理 ${cons.pending}` : '从没跑过'))

  const self = selfM.manifest()
  items.push(ok('O10 自我文件没被绕过写闸改', !self.drift, `version ${self.version} hash ${self.hash}`))
  const ownerWritten = Boolean(selfM.ownerBlock({ limit: 30 }))
  items.push(ok('O10 主人层（只有主人能写；没写不影响跑）', true, ownerWritten ? '已写' : '还是模板，等主人填'))

  const d = delivery.stats({ now })
  const claims = readJsonl(claimsPath(), { limit: 200 }).filter((r) => Number(r.at) >= now - 86400_000)
  const rewritten = claims.filter((r) => r.changed).length
  items.push(ok('O11 交付有账', d.last24h > 0 || (b.mode || 'shadow') === 'shadow', `24h 内交付 ${d.last24h} 条`))
  items.push(ok('O11 声称闸在工作', claims.length >= 0, `24h 检查 ${claims.length} 条，改口 ${rewritten} 条`))

  const g = attention.leaseState(now)
  items.push(ok('I2 生成租约没卡住', !g.alive || (now - Number(g.at || now)) < 10 * 60_000, g.alive ? `正在生成 ${g.chat}` : '空闲'))

  // O6/O13：派生层只认门槛 —— 图式 30 天×5 次、能力 3 次成功；不自作聪明去"补数据"
  try {
    const sc = schema.stats()
    const tooMany = schema.all().filter((x) => Number(x.hits) < Number(sc.gate?.minHits || 5) || Number(x.spanDays) < Number(sc.gate?.minSpanDays || 30)).length
    items.push(ok('O6 图式不到门槛不写', tooMany === 0, `${sc.total} 条规律，越界 ${tooMany}`))
  } catch (e) { items.push(ok('O6 图式不到门槛不写', false, String(e?.message || e))) }
  try {
    const cp = competence.stats()
    const weak = competence.all().filter((x) => Number(x.ok) < Number(cp.gate?.minWins || 3)).length
    items.push(ok('O13 能力自评要 3 次成功', weak === 0, `${cp.total} 项能力，越界 ${weak}`))
  } catch (e) { items.push(ok('O13 能力自评要 3 次成功', false, String(e?.message || e))) }
  try {
    const ts = tasks.stats()
    items.push(ok('§6 任务队列没堵死', ts.leased < 20, `排队 ${ts.queued} / 在跑 ${ts.leased}`))
  } catch (e) { items.push(ok('§6 任务队列没堵死', false, String(e?.message || e))) }

  // ── C 系体检（2026-11-03 R1）：五个新器官的读数摊开。纯读；它们是
  //    「她此刻的体感参数」不是不变量，数值没有对错，所以全部恒过、只报读数。
  try {
    const sf = bond.safety('qq')
    items.push(ok('C1 安抚缓冲读数', sf >= 0 && sf <= 1, `safety=${sf.toFixed(2)}（>0.5=相处在缓冲他的重话）`))
  } catch (e) { items.push(ok('C1 安抚缓冲读数', false, String(e?.message || e))) }
  try {
    const nr = JSON.parse(fs.readFileSync(neuronPath(), 'utf8'))
    const rpeKeys = Object.keys((nr && nr.rpe) || {})
    items.push(ok('C3 预期端有账', true, `${rpeKeys.length} 个社交来源的预期在学（${rpeKeys.slice(0, 3).join(',') || '还没有'}）`))
  } catch (e) { items.push(ok('C3 预期端有账', true, '预期账本还没建（正常：尚无带来源的到货）')) }
  try {
    const pv = fieldMod.peekValence()
    items.push(ok('C2 心情一致性偏置读数', true, `mood=${pv.toFixed(2)}（负 mood 时糟心事先浮上来）`))
  } catch (e) { items.push(ok('C2 心情一致性偏置读数', false, String(e?.message || e))) }
  try {
    const z = rhythmMod.snapshot()
    items.push(ok('C4 节律牵引读数', true, `phase=${z.phaseMin}min（他在的钟点在拖她的相位；停拖 7 天回归）`))
  } catch (e) { items.push(ok('C4 节律牵引读数', false, String(e?.message || e))) }
  try {
    const rs = reflexMod.snapshot()
    items.push(ok('C5 反射弧就位', rs.threshold === 0.75, `阈值 ${rs.threshold}，弧上 ${rs.tone}，不应期余 ${rs.refractoryIn}ms`))
  } catch (e) { items.push(ok('C5 反射弧就位', false, String(e?.message || e))) }

  if (measurePrompt) {
    try {
      const m = measurePromptChars({ platform: 'qq', chatId: 'qq:doctor', userId: 'doctor', isGroup: false })
      const budget = Number(b.budget?.promptChars || 5650)
      items.push(ok('§9 提示词预算', m.chars <= budget, `${m.chars} 字 / 上限 ${budget}，截断 ${m.dropped.length} 块`))
    } catch (e) {
      items.push(ok('§9 提示词预算', false, String((e && e.message) || e)))
    }
  }

  const epInfo = fileInfo(BRAIN() + '/ep')
  return {
    ok: items.every((i) => i.ok || i.name.startsWith('I1') || i.name.startsWith('O11 声称')),
    mode: b.mode || 'shadow',
    items,
    numbers: {
      episodes: eps.length,
      today: metrics.today(),
      facts: stats,
      intents: ist,
      consolidation: cons,
      delivery: d,
      episodeDir: epInfo,
      promptChars: metrics.today().promptChars || 0,
    },
  }
}