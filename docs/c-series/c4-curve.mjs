// C4 curve evidence: 3 days owner @02:00 -> phase drag ~40min/day; then
// 14 days release -> natural decay. Writes JSON + prints summary.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c4-curve-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.dsh', 'bot.config.json'), JSON.stringify({ owner: { qq: '10000' } }))

const { epFile, rhythmPath } = await import('/home/dsh/plugins/dsh_bot/tools/brain/paths.mjs')
const rhythm = await import('/home/dsh/plugins/dsh_bot/tools/brain/rhythm.mjs')

const localMidnight = new Date(); localMidnight.setHours(0, 0, 0, 0)
const DAY0 = localMidnight.getTime()
const at = (day, h, m = 0) => DAY0 + day * 86_400_000 + h * 3600_000 + m * 60_000
fs.mkdirSync(path.dirname(epFile(new Date())), { recursive: true })

function ownerTalks(day, hFrom, hTo) {
  const rows = []
  for (let t = at(day, hFrom); t <= at(day, hTo); t += 10 * 60_000) {
    rows.push(JSON.stringify({ id: 'z' + t, at: t, act: 'say', gist: 'hey', where: { platform: 'qq', chat: 'qq:10000' }, who: { kind: 'user', others: [] }, feel: { valence: 0.3, arousal: 0.4 } }))
  }
  fs.appendFileSync(epFile(new Date()), rows.join('\n') + '\n')
}

const series = []
const record = (t) => series.push({ day: +((t - DAY0) / 86_400_000).toFixed(2), phaseMin: Number(JSON.parse(fs.readFileSync(rhythmPath(), 'utf8')).phaseMin || 0) })

for (let day = 1; day <= 3; day++) {
  ownerTalks(day - 1, 2, 3.9)
  for (let t = at(day - 1, 2); t <= at(day, 2); t += 10 * 60_000) rhythm.zeitgeberTick(t)
  record(at(day, 2))
}
const peak = series[series.length - 1].phaseMin
const end = at(3, 2) + 14 * 86_400_000
for (let t = at(3, 2); t <= end; t += 30 * 60_000) rhythm.zeitgeberTick(t)
record(end)

const out = {
  scenario: 'owner active 02:00-04:00 daily x3 days, then 14 days silence',
  dailyPhaseMin: series.slice(0, 3).map((s) => s.phaseMin),
  perDayDragMin: series.slice(0, 3).map((s, i) => +(i === 0 ? s.phaseMin : s.phaseMin - series[i - 1].phaseMin).toFixed(1)),
  peakPhaseMin: peak,
  after14dReleaseMin: series[series.length - 1].phaseMin,
  series,
}
fs.writeFileSync(new URL('./c4-zeitgeber.json', import.meta.url), JSON.stringify(out, null, 2))
console.log('C4 curve:', JSON.stringify({ daily: out.dailyPhaseMin.map((v) => +v.toFixed(1)), peak, after14d: out.after14dReleaseMin }))
