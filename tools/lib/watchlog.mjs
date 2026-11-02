// watchlog —— 「她在 B 站看了什么」的唯一账本（2026-11-02）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要有它（用户原话）
// ══════════════════════════════════════════════════════════════════════
// 「能不能在看b站视频也做一个子通道，作为专门看b站的眼睛，看完后直接注入进
//   记忆里并在上下文里注入进她在b站上看了什么」
//
// 拆开是三件事：
//   ① **子通道**：一条独立的路，不和聊天记忆混在一起
//   ② **看完直接注入记忆**：不是"等她下次想起来"，是看完就落
//   ③ **上下文里稳定注入**：不是靠召回碰运气，是每次都在
//
// 现状之前是什么样（查过）：
//   · `binge.mjs` 已经 `memory.remember(...)` 写一句"看完了《X》第 N 集：剧情…"
//     但只在 `--go` 时写，而且**只能靠召回碰**——assemble 里没有任何"最近在看什么"的槽。
//   · `bili-watch` 是刷 feed 顺手评论，看完不留情节，只有一条 push 记录。
//   · 于是她"看过"和"记得看过"是两件不相干的事。
//
// ── 为什么单独存一份账本，而不是只靠 memory.remember ─────────────────
// memory 的 episode 是**对话流**（谁说了什么），按时间线性排。
// "我最近在看什么剧、看到第几集、上一集讲了啥"是一个**结构化的进行状态**，
// 塞进对话流里会被别的消息冲散。所以：
//   · 账本（本文件）= 结构化状态，给上下文注入用
//   · memory.remember  = 一条自然语言记录，给"她想起来"用
// 两份不是"第二份真相"——它们回答不同的问题：
//   账本答"我现在在看什么"，记忆答"我什么时候看过什么"。
//   但**写入必须同一处**（`record()` 同时写两边），否则又会分裂。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import { writeJsonAtomic, readJsonSafe } from './atomic.mjs'

const FILE = () => dataPath('brain', 'watch-log.json')

/** 最多留多少条（一集一条，够回溯一阵；不设上限会无限长）。 */
const MAX_ROWS = 200

/** 默认保留多少小时内的算"最近在看"。 */
const RECENT_H = 72

function empty() {
  return { v: 1, shows: {}, rows: [] }
}

function load() {
  const j = readJsonSafe(FILE(), null)
  if (!j || typeof j !== 'object') return empty()
  if (!Array.isArray(j.rows)) j.rows = []
  if (!j.shows || typeof j.shows !== 'object') j.shows = {}
  return j
}

function save(j) {
  // 裁剪：只留最近 MAX_ROWS 条（rows 已按时间升序）
  if (j.rows.length > MAX_ROWS) j.rows = j.rows.slice(-MAX_ROWS)
  writeJsonAtomic(FILE(), j)
}

/**
 * 剧名归一（避免"可塑性记忆"和"可塑性记忆 "算两部）。
 *
 * 2026-11-02 端到端踩到：`binge --bvid` 时 show 传的是**完整视频标题**
 * （「一口气看完【可塑性记忆】，记忆是可塑性的，回忆是永恒的」），
 * 于是注入区块里她"在看"的东西读起来像一个文件路径，不像一部剧。
 *
 * 做法：从标题里**抽出书名号/引号里的那个名字**（那才是剧名），
 * 抽不到就取去掉常见前缀/后缀后的主干。宁可选错也不能让整条标题糊上去。
 */
function showKey(name) {
  const raw = String(name || '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  // ① 书名号里的一般就是剧名：「一口气看完【可塑性记忆】，记忆是可塑性的…」
  //
  // 但书名号里不一定是剧名：「【全748集】目前B站最全最细的Agent开发…教程」
  // 抽出来是"全748集"——那是**计数**不是名字。所以书名号内容要做两道检查：
  //   ① 是不是纯计数（全748集 / 12话 / 2026）
  //   ② 是不是营销词（最新版/合集/教程…）
  // 两道都过不了才用它；否则去找**下一个**书名号，或者退回主干。
  const brackets = [...raw.matchAll(/[【《「『]([^】》」』]{2,40})[】》」』]/g)].map((m) => m[1].trim())
  const isCount = (t) => /^[全]?[0-9０-９]+\s*[集话期篇]?$/.test(t) || /^[0-9０-９]{4}$/.test(t)
  const isPromo = (t) => /最新版|完整版|高清|合集|教程|搬运|重传|补档/.test(t)
  for (const inner of brackets) {
    if (isCount(inner) || isPromo(inner)) continue
    return inner.slice(0, 40)
  }
  // ② 去掉常见的"一口气看完/全集/解说"之类前缀，留主干
  const stripped = raw
    .replace(/^(?:一口气看完|一口气看完|合集|全集|全\d+集|【[^】]*】)+/g, '')
    .replace(/[|｜].*$/, '')
    .trim()
  return (stripped || raw).slice(0, 40)
}

/**
 * 记一条「看了」。
 *
 * @param {object} o
 * @param {string} o.show     剧名/合集名
 * @param {number} [o.ep]     第几集（合集类可以不给）
 * @param {string} [o.bvid]
 * @param {string} o.title    视频标题
 * @param {string} [o.plot]   这一集讲了什么（来自 binge 的 take.plot）
 * @param {string} [o.feel]   她自己的感受（take.feel）
 * @param {string} [o.via]    靠什么看懂的（台词N句+弹幕…）
 * @param {number} [o.durMin] 时长（分钟）
 * @param {boolean} [o.ok]    是否真看懂了（不是"只看到简介"）
 * @returns {{ok:boolean, row?:object, why?:string}}
 */
export function record(o = {}) {
  const show = showKey(o.show || o.title)
  if (!show) return { ok: false, why: 'no-show' }
  const j = load()
  const at = Number(o.at || Date.now())
  const row = {
    at,
    atIso: new Date(at).toISOString(),
    show,
    ep: Number.isFinite(Number(o.ep)) ? Number(o.ep) : null,
    bvid: String(o.bvid || ''),
    title: String(o.title || '').slice(0, 160),
    plot: String(o.plot || '').slice(0, 600),
    feel: String(o.feel || '').slice(0, 300),
    via: String(o.via || '').slice(0, 120),
    durMin: Number(o.durMin || 0) || null,
    ok: o.ok !== false,
  }
  j.rows.push(row)
  j.rows.sort((a, b) => Number(a.at) - Number(b.at))

  // 剧目状态：最后看的时间、看到第几集、累计几集
  const s = j.shows[show] || { firstAt: at, seen: [], lastAt: 0, lastEp: null, episodes: 0 }
  s.lastAt = at
  if (row.ep != null) {
    if (!s.seen.includes(row.ep)) s.seen.push(row.ep)
    s.lastEp = row.ep
    s.episodes = s.seen.length
  } else {
    s.episodes = Number(s.episodes || 0) + 1
  }
  s.lastBvid = row.bvid
  s.lastPlot = row.plot
  j.shows[show] = s
  save(j)
  return { ok: true, row }
}

/**
 * 最近在看的几部（按最后观看时间倒序）。
 *
 * @param {boolean} [onlyReal=true] 只要"真看过"的（默认）。
 *
 * ⚠ 2026-11-02 实测踩到的设计错误：
 *   `bili-watch` 在**材料不足**时也记一条 ok:false（via:"只有标题"）。
 *   结果她刷 feed 几分钟就攒了 3 条"没看懂"，把唯一一条真看懂的挤出了
 *   maxShows=2 的名额 —— 注入区块里全是「别当成看过了」，
 *   于是问她"在干嘛呢"只能答"躺着刷视频"，明明刚看完一条有内容的。
 *
 *   **"没看懂"不是"在看"**。它该被记为一次尝试（防止她冒充看过），
 *   但不该占用"我在看什么"的展示名额。
 */
export function recentShows({ hours = RECENT_H, limit = 3, now = Date.now(), onlyReal = true } = {}) {
  const j = load()
  const cutoff = now - Number(hours) * 3600_000
  const all = Object.entries(j.shows).map(([name, s]) => ({ name, ...s }))
    .filter((s) => Number(s.lastAt || 0) >= cutoff)
  if (!onlyReal) {
    return all.sort((a, b) => Number(b.lastAt) - Number(a.lastAt)).slice(0, Math.max(1, Number(limit) || 3))
  }
  // 真看过 = 至少有一条 ok 且 plot 非空
  const rows = j.rows
  const hasReal = (name) => rows.some((r) => r.show === name && r.ok !== false && String(r.plot || '').trim())
  const real = all.filter((s) => hasReal(s.name))
  if (real.length) return real.sort((a, b) => Number(b.lastAt) - Number(a.lastAt)).slice(0, Math.max(1, Number(limit) || 3))
  // 一部真看过的都没有 → 返回空，让 promptBlock 走"只扫过"的单独说法。
  // 不能退回全部：那样她会看到一堆「别当成看过了」，等于什么都聊不出来，
  // 而这恰恰是 2026-11-02 实测暴露的问题（她只能答"躺着刷视频"）。
  return []
}

/** 最近 N 条观看记录（升序取尾部）。 */
export function recentRows({ limit = 8, hours = RECENT_H, now = Date.now() } = {}) {
  const j = load()
  const cutoff = now - Number(hours) * 3600_000
  return j.rows.filter((r) => Number(r.at) >= cutoff).slice(-Math.max(1, Number(limit) || 8))
}

/**
 * 生成给 system prompt 用的【我在B站看了什么】区块。
 *
 * 写法上的三条要求（照 M61 的「人称三分法」）：
 *   ① 用**第一人称** —— 这是她自己的经历，不是系统在汇报数据
 *   ② **不写"第几集 第几分钟"这种编号感**，写"昨晚看的""上一集"
 *   ③ 明确标出**哪次没真看懂** —— 否则她把"只看到简介"当成看过
 *
 * @returns {string} 空串表示最近没看什么（调用方据此决定加不加这个槽）
 */
export function promptBlock({ hours = RECENT_H, now = Date.now(), maxShows = 2 } = {}) {
  const shows = recentShows({ hours, limit: maxShows, now })
  const rows = recentRows({ hours, limit: 12, now })
  if (!shows.length) {
    // 一部真看懂的都没有，但确实点开过东西 → 说一句实话，而不是长篇"没看懂"
    const tried = rows.filter((r) => r.ok === false)
    if (!tried.length) return ''
    const names = [...new Set(tried.map((r) => r.show))].slice(0, 2)
    return '【我在B站看了什么】\n'
      + `· 刚才划到过 ${names.map((n) => `《${n}》`).join('、')}，`
      + '但都只扫到标题和简介，没真看进去。\n'
      + '（所以这些算不上"看过"——他要问起来，就照实说只是划到了，没看明白。）'
  }

  const ago = (t) => {
    const d = Math.max(0, now - Number(t || 0))
    if (d < 3600_000) return `${Math.max(1, Math.round(d / 60_000))} 分钟前`
    if (d < 86400_000) return `${Math.round(d / 3600_000)} 小时前`
    return `${Math.round(d / 86400_000)} 天前`
  }

  const lines = []
  for (const s of shows) {
    const own0 = rows.filter((r) => r.show === s.name)
    const lastRow = own0[own0.length - 1] || null
    const lastWasFlaky = lastRow && lastRow.ok === false

    const bits = []
    bits.push(`《${s.name}》`)
    // 「看到第几集」要说**看懂了**的那一集。
    // 如果最后一次其实没看懂，就不能说"看到第 3 集"——那是把没看过的说成看过了。
    const goodEps = own0.filter((r) => r.ok !== false && r.ep != null).map((r) => Number(r.ep))
    const goodEp = goodEps.length ? Math.max(...goodEps) : null
    if (goodEp != null) bits.push(`看到第 ${goodEp} 集`)
    else if (s.lastEp != null) bits.push(`打开过第 ${s.lastEp} 集`)
    if (s.episodes) bits.push(`一共看了 ${s.episodes} 集`)
    bits.push(`最后一次是 ${ago(s.lastAt)}`)
    lines.push(`· ${bits.join('，')}`)
    void lastWasFlaky

    // ── 取"最后一条**真看懂**的剧情"，不是"最后一条记录的剧情"─────────
    //
    // 2026-11-02 实测踩到的坑：第 3 集没看懂（ok:false，plot 是"这条看不到剧情"），
    // 而 s.lastPlot 存的正是它 → 注入区块里写「上一集讲的：这条看不到剧情」，
    // 把真正看懂的第 2 集内容整个盖掉了。她于是以为自己只看了个空壳。
    //
    // 正确做法：从新到旧找第一条 ok && plot 非空的。
    // 同时把"最后一次没看懂"单独说，而不是让它冒充"上一集内容"。
    const own = rows.filter((r) => r.show === s.name)
    const lastGood = [...own].reverse().find((r) => r.ok !== false && String(r.plot || '').trim())
    if (lastGood) {
      const label = lastGood.ep != null ? `第 ${lastGood.ep} 集讲的` : '最近看的那条讲的'
      lines.push(`  ${label}：${String(lastGood.plot).trim()}`)
    }

    // 同一部剧的"感受"（优先取真看懂的那条，没有再用任意一条）
    const lastWithFeel = [...own].reverse().find((r) => r.feel && r.ok !== false)
      || [...own].reverse().find((r) => r.feel)
    if (lastWithFeel) lines.push(`  我当时的感觉：${lastWithFeel.feel}`)

    // 没真看懂的要标出来（防止她把"只看到简介"说成看过）
    const flaky = own.filter((r) => r.ok === false)
    if (flaky.length) {
      const f = flaky[flaky.length - 1]
      const when = f.ep != null ? `第 ${f.ep} 集` : '最近一次'
      lines.push(`  （${when}其实没真看懂，只是扫到了标题和简介——别当成看过了）`)
    }
  }

  return '【我在B站看了什么】\n' + lines.join('\n')
    // ⚠ 2026-11-02 实测：原来这里只写"他问起时可以直接聊"，
    //   结果问她"在干嘛呢"，她连答三次"躺着刷视频"，**一次都没提刚看的番**。
    //   注入成功（system 里确实有这条）但模型不会主动用 ——
    //   因为它把这段当"资料"而不是"我刚刚的经历"。
    //
    //   改法：① 明确说这是「刚刚发生的事」，② 明确说**被问到在干嘛/最近干啥
    //   时应该顺口提一句**（给出触发条件，而不是等它自己想起来），
    //   ③ 仍然保留"只聊看明白的部分"这条底线。
    + '\n（这是我刚刚自己看过的，不是别人告诉我的，也不是任务。'
    + '他问"在干嘛/最近看什么/有什么好玩的"的时候，顺口提一句我在看的这个就行——'
    + '像人聊天那样自然带出来，不用报菜名。'
    + '只聊我真看明白的部分；没看明白的照实说。）'
}

/** 清空（测试/重置用）。 */
export function reset() {
  save(empty())
}

/** 只读统计（doctor / 面板用）。 */
export function stats() {
  const j = load()
  return {
    shows: Object.keys(j.shows).length,
    rows: j.rows.length,
    lastAt: j.rows.length ? Number(j.rows[j.rows.length - 1].at) : 0,
  }
}
