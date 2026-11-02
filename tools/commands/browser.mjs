// browser —— 内置浏览器的手动挡：她可以直接敲，主人也能在终端里验。
//   node bot.mjs browser read <url> [--pc|--mobile] [--chars 8000] [--links]
//   node bot.mjs browser text [--offset N] [--chars 4000]   # 续读当前页
//   node bot.mjs browser links                              # 当前页的可点链接
//   node bot.mjs browser click "选择器" [序号] | type "选择器" "文字" | enter
//   node bot.mjs browser scroll ±px | back | shot [--tag 名] | status | close
import { browserRead, browserAct, browserShot, browserStatus, browserClose, browserPeek, browserDetach, browserTabs, browserCloseAll, browserCloseTabAt, browserActionsLog } from '../lib/browser.mjs'

function deviceOf(argv) {
  const d = argv[argv.indexOf('--device') + 1]
  if (d === 'pc' || d === 'mobile') return d
  if (argv.includes('--mobile')) return 'mobile'
  if (argv.includes('--pc')) return 'pc'
  return 'auto'
}
function argOf(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }

async function runSub(sub, argv) {
  if (sub === 'read' || sub === 'open') {
    const url = argv[1]
    if (!url) { console.log('用法：browser read <url> [--pc|--mobile] [--chars 8000] [--links] [--full] [--wait 8000]'); return }
    const p = await browserRead(url, {
      device: deviceOf(argv),
      maxChars: Number(argOf(argv, '--chars', 8000)) || 8000,
      links: argv.includes('--links'),
      full: argv.includes('--full'),
      waitMs: Number(argOf(argv, '--wait', 8000)) || 8000,
    })
    const head = `${p.title}\n${p.url}\n[身份：${p.device === 'pc' ? '电脑' : '手机'}${p.more ? ' · 正文未完，browser text --offset ' + p.nextOffset + ' 续读' : ''}]`
    console.log(head + '\n\n' + p.text)
    if (p.links?.length) console.log('\n—— 可点的链接 ——\n' + p.links.map((l) => `${l.text} → ${l.href}`).join('\n'))
    if (p.elements?.length) {
      console.log('\n—— 可点/可填的（browser click @编号 即可）——')
      for (const e of p.elements.slice(0, 40)) console.log(`[@${e.n}] ${e.kind === 'type' ? '输入 ' : ''}${e.label}`)
    }
    return
  }
  if (sub === 'text') {
    const p = await browserPeek({ maxChars: Number(argOf(argv, '--chars', 4000)) || 4000, offset: Number(argOf(argv, '--offset', 0)) || 0 })
    console.log(`${p.title}（续读）${p.more ? ' · 还有更多，--offset ' + p.nextOffset : ''}\n\n${p.text || '（当前页没内容 —— 先 browser read 打开一个）'}`)
    return
  }
  if (sub === 'links') {
    const p = await browserPeek({ links: true })
    console.log(p.links?.length ? p.links.map((l) => `${l.text} → ${l.href}`).join('\n') : '（这页没有可点的链接，或还没打开页面）')
    return
  }
  if (['click', 'type', 'enter', 'key', 'scroll', 'back'].includes(sub)) {
    const args = sub === 'type' ? [argv[1], argv.slice(2).join(' ')] : argv.slice(1)
    console.log(await browserAct(sub, ...args))
    return
  }
  if (sub === 'shot') {
    const f = await browserShot(argOf(argv, '--tag', ''))
    console.log('截图存好了：' + f)
    return
  }
  if (sub === 'status') {
    const s = await browserStatus()
    if (!s.alive) { console.log(s.note); return }
    console.log(`浏览器活着（pid ${s.pid}，身份 ${s.device}）`)
    for (const t of s.tabs) console.log(`  · [${t.title}] ${t.url}`)
    return
  }
  if (sub === 'tabs') {
    const p = await browserPeek({ maxChars: 1 })
    console.log(await browserTabs())
    return
  }
  if (sub === 'close') {
    const t = argv[1]
    if (t === '--all') { console.log(await browserCloseAll()); return }
    if (t && /^@\d+$/.test(t)) { console.log(await browserCloseTabAt(Number(t.slice(1)))); return }
    console.log(await browserClose()); return
  }
  if (sub === 'actions') { console.log(await browserActionsLog()); return }

  console.log('内置浏览器（电脑/手机双身份，可点可填可截图）')
  console.log('  browser read <url> [--pc|--mobile] [--chars N] [--links] [--full]   读正文+可交互元素编号（@1 @2…）')
  console.log('  browser text [--offset N] | links | shot [--tag 名]                 续读 / 看链接 / 截图')
  console.log('  browser click @3 | click text=登录 | type @5 "字" | enter           交互（点完自动回新的元素表）')
  console.log('  browser tabs | close @2 | close --all | close                       标签管理 / 关当前页')
  console.log('  browser scroll ±px | back | status | actions | close                滚动/后退/状态/动作日志')
}

export async function run(argv = []) {
  const sub = argv[0] || 'help'
  try {
    await runSub(sub, argv)
  } catch (e) {
    console.log('✗ ' + String(e.message || e))
    process.exitCode = 1
  } finally {
    await browserDetach()   // 一次性命令跑完就走，chromium 常驻不用跟着退
  }
}

if (process.argv[1] && process.argv[1].endsWith('browser.mjs')) {
  await run(process.argv.slice(2))
}
