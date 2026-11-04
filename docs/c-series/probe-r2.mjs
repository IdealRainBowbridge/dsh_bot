// R2 probe: body-materials section in selfcon-day summary.
import fs from 'node:fs'
import path from 'node:path'
const TMP = '/tmp/c7probe'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.dsh', 'bot.config.json'), JSON.stringify({ owner: { qq: '10000' } }))
const { epFile, fieldPath } = await import('/home/dsh/plugins/dsh_bot/tools/brain/paths.mjs')
const NOW = Date.now()
fs.mkdirSync(path.dirname(epFile(new Date())), { recursive: true })
fs.writeFileSync(epFile(new Date()), [
  JSON.stringify({ id: 's1', at: NOW - 3600_000, act: 'say', scope: 'private', gist: '今天好累啊', quote: '今天好累啊', who: { kind: 'user', others: [] }, feel: { valence: 0.7, arousal: 0.5 }, where: { platform: 'qq', chat: 'qq:10000' } }),
  JSON.stringify({ id: 's2', at: NOW - 3500_000, act: 'say', scope: 'private', gist: '不过跟他聊天挺舒服的', quote: '不过跟他聊天挺舒服的', who: { kind: 'user', others: [] }, feel: { valence: 0.8, arousal: 0.4 }, where: { platform: 'qq', chat: 'qq:10000' } }),
].join('\n') + '\n')
fs.mkdirSync(path.dirname(fieldPath()), { recursive: true })
fs.writeFileSync(fieldPath(), JSON.stringify({ at: NOW, dims: { valence: -0.5 } }))
const { dayIntrospect: run } = await import('/home/dsh/plugins/dsh_bot/tools/brain/organ/selfcon-day.mjs')
const r = await run({ now: NOW, chatFn: null })
console.log('summary:', r.summary)
