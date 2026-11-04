// selfmod —— 她改自己的入口（2026-11-03：全自主，审批已撤）
//
//   node bot.mjs selfmod list                     # 看有没有待批
//   node bot.mjs selfmod propose <文件> <为什么> --from <新文件路径>
//   node bot.mjs selfmod status                   # 最近改了什么
//
// 她的用法（2026-11-03 起）：先把新内容写成临时文件 → propose 提案 → 自己确认没问题
// 就 selfApply 落地（免审批：备份→写→语法→门禁，失败自动还原）。判断权在她自己身上，
// 安全网是机制不是别人的批准。动手前先用 selfsrc 把现场看清楚。
import fs from 'node:fs'
import * as SM from '../lib/selfmod.mjs'

export async function run(argv = []) {
  const sub = argv[0] || 'list'

  if (sub === 'list') {
    const list = SM.listPending()
    if (!list.length) { console.log('没有待批的改动。'); return }
    for (const x of list) {
      console.log(`【${x.id}】${x.file}`)
      console.log(`  为什么：${x.why}`)
      console.log(`  状态：${x.state}   ${new Date(x.at).toLocaleString('zh-CN')}`)
    }
    return
  }

  if (sub === 'propose') {
    const file = argv[1]
    const why = argv[2]
    const i = argv.indexOf('--from')
    const from = i >= 0 ? argv[i + 1] : ''
    const isNewFile = argv.includes('--new')
    if (!file || !why) {
      console.error('用法：selfmod propose <项目内相对路径> <为什么> --from <含新内容的文件> [--new 新建文件]')
      process.exit(1)
    }
    let change = ''
    if (from) {
      try { change = fs.readFileSync(from, 'utf8') }
      catch (e) { console.error('读不到新内容文件：' + e.message); process.exit(1) }
    } else {
      console.error('必须用 --from 指定新内容文件（不让你在命令行里内联整段代码）')
      process.exit(1)
    }
    const r = SM.propose({ file, why, change, create: isNewFile })
    if (!r.ok) { console.error('提案失败：' + r.reason); process.exit(1) }
    console.log(`✓ 已提案【${r.id}】${r.file}`)
    console.log('  确认没问题就 selfmod selfApply 落地（备份→写→语法→门禁，失败自动还原）。')
    return
  }

  if (sub === 'status') {
    try {
      const { dataPath } = await import('../lib/paths.mjs')
      const s = JSON.parse(fs.readFileSync(dataPath('selfmod.json'), 'utf8'))
      if (!s.history?.length) { console.log('还没有对自己的改动记录。'); return }
      for (const h of s.history.slice(0, 8)) {
        console.log(`【${h.id}】${h.state}  ${h.file}  ${new Date(h.at).toLocaleString('zh-CN')}`)
      }
    } catch { console.log('还没有对自己的改动记录。') }
    return
  }

  if (sub === 'selfApply' || sub === 'selfapply') {
    const r = SM.selfApply(argv[1])
    if (!r.ok) { console.error('没落地：' + r.reason); process.exit(1) }
    console.log('✓ 已自主落地【' + r.id + '】（语法✓ 门禁✓，备份 ' + (r.backup ? r.backup.split('/').pop() : '有') + '）')
    console.log('  没人说话时我会自己重启生效；急的话跟管理员说「重启」。明细在 selfmod status / selfup 日志里。')
    return
  }

  if (sub === 'rollback') {
    const r = SM.rollback(argv[1])
    if (!r.ok) { console.error('没回滚：' + r.reason); process.exit(1) }
    console.log('✓ 已回滚【' + r.id + '】' + r.file + (r.removed ? '（新建文件已删除）' : '（已写回备份）') + '。重启后生效。')
    return
  }

  if (sub === 'snapshot') {
    const r = await SM.snapshot()
    if (!r.ok) { console.error('快照失败：' + r.reason); process.exit(1) }
    console.log('✓ 快照已拍：' + r.name + '.tar.gz（' + r.mb + ' MB，代码+记忆数据）')
    return
  }

  console.log('用法：selfmod propose <文件> <为什么> --from <新内容文件> | selfmod selfApply [id] | selfmod rollback [id] | selfmod snapshot | selfmod status')
}
