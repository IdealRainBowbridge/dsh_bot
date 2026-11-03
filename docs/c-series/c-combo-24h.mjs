// C-series 24h combined simulation (R4): one day with the owner active
// 22:00-24:00 - runs the real modules end to end:
//   C4 zeitgeber drags phase during the evening chat;
//   C3 RPE learns the nightly rhythm (err shrinks across the evening);
//   C1 safety rides the day's episode valence into hpa stress damping;
//   C5 reflex habituates across three big bursts.
// Output: docs/c-series/c-combo-24h.json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c24-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.dsh', 'bot.config.json'), JSON.stringify({ owner: { qq: '10000' } }))

const { epFile, rhythmPath, neuronPath, hpaPath, fieldPath } = await import('/home/feiyu/plugins/dsh_bot/tools/brain/paths.mjs')
const rhythm = await import('/home/feiyu/plugins/dsh_bot/tools/brain/rhythm.mjs')
const neuron = await import('/home/feiyu/plugins/dsh_bot/tools/brain/cell/neuron.mjs')
const bond = await import('/home/feiyu/plugins/dsh_bot/tools/lib/bond.mjs')
const hpa = await import('/home/feiyu/plugins/dsh_bot/tools/brain/organ/hpa.mjs')
const reflex = await import('/home/feiyu/plugins/dsh_bot/tools/brain/reflex.mjs')

const localMidnight = new Date(); localMidnight.setHours(0, 0, 0, 0)
const D0 = localMidnight.getTime()
const at = (h, m = 0) => D0 + h * 3600_000 + m * 60_000
fs.mkdirSync(path.dirname(epFile(new Date())), { recursive: true })

// yesterday + today: owner chats warmly 22:00~24:00 both days (C4 window),
// eps carry valence +0.6 (C1 safety source)
function ownerTalks(hFrom, hTo, valence) {
  const rows = []
  for (let t = at(hFrom); t <= at(hTo); t += 10 * 60_000) {
    rows.push(JSON.stringify({ id: 's' + t, at: t, act: 'say', scope: 'private', gist: '聊得来', quote: '跟你聊天挺舒服', who: { kind: 'user', others: [] }, feel: { valence, arousal: 0.35 }, where: { platform: 'qq', chat: 'qq:10000' } }))
  }
  fs.appendFileSync(epFile(new Date()), rows.join('\n') + '\n')
}
ownerTalks(-2, 0, 0.6)   // yesterday 22:00~24:00 (negative hours = previous day)
ownerTalks(22, 24, 0.6)  // today 22:00~24:00

const series = []
const snap = (t) => ({
  h: +((t - D0) / 3600_000).toFixed(2),
  phase: Number(JSON.parse(fs.readFileSync(rhythmPath(), 'utf8')).phaseMin || 0),
  ne: (() => { try { return Number(JSON.parse(fs.readFileSync(fieldPath(), 'utf8')).dims?.ne) } catch { return 0.35 } })(),
  cortisol: (() => { try { return hpa.read(t).cortisol } catch { return 0.16 } })(),
})
const push = (t) => series.push(snap(t))

// 00:00 -> 24:00 in 30-min beats (heartbeat approximation: zeitgeber + neuron tick)
for (let t = at(0); t <= at(24); t += 30 * 60_000) {
  rhythm.zeitgeberTick(t)
  neuron.tick(t)
  if (t >= at(22) && t <= at(23.9)) {
    // nightly rhythm: owner greeting every ~30min -> RPE learns it
    neuron.rpe(0.6, { source: 'owner', care: 1, now: t })
    // one big burst an hour -> startle habituates
    if (Math.round((t - at(22)) / 3600_000) !== ((t - at(22)) / 3600_000)) reflex.startle({ text: '哇'.repeat(400) + '！' }, t)
    // a small stressor at 23:00 damped by the warm day (C1)
    if (Math.abs(t - at(23)) < 60_000) hpa.stress(1.5, { now: t, why: 'c24-hard-day' })
  }
  if (t % 3600_000 === 0) push(t)
}
push(at(24))

const rpeState = JSON.parse(fs.readFileSync(neuronPath(), 'utf8')).rpe?.owner || {}
const out = {
  scenario: 'owner 22:00-24:00 daily, warm valence 0.6; stressor 1.5 @23:00; bursts hourly',
  phaseStart: series[0].phase, phaseEnd: series[series.length - 1].phase,
  safetyEod: Number(bond.safety('qq', at(24)).toFixed(3)),
  rpeOwner: { ef: Number((rpeState.ef || 0).toFixed(3)), es: Number((rpeState.es || 0).toFixed(3)), ivlMin: Math.round((rpeState.ivl || 0) / 60_000) },
  cortisolAt2345: series.find((s) => s.h === 23.5)?.cortisol,
  series,
}
fs.writeFileSync(new URL('./c-combo-24h.json', import.meta.url), JSON.stringify(out, null, 2))
console.log('24h combo:', JSON.stringify({ phase: out.phaseStart + '->' + out.phaseEnd, safety: out.safetyEod, rpeIvlMin: out.rpeOwner.ivlMin, cort2345: out.cortisolAt2345 }))
