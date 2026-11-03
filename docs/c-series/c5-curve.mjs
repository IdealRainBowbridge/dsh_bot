// C5 curve evidence: startle signals across bangs (habituation curve).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c5-curve-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
const reflex = await import('/home/feiyu/plugins/dsh_bot/tools/brain/reflex.mjs')
const T0 = 1_700_000_000_000
const msg = '哇'.repeat(400) + '！！！？？！'
const offsets = [0, 15000, 45000, 90000, 135000, 300000]
const hits = []
let last = 0
for (const off of offsets) {
  const r = reflex.startle({ text: msg }, T0 + off)
  hits.push({ tSec: off / 1000, gapSec: (off - last) / 1000, signal: r.signal, fired: r.fired, why: r.why })
  if (r.fired) last = off
}
const out = { scenario: 'identical max-strength bangs at 0/15/45/90/135/300s', hits }
fs.writeFileSync(new URL('./c5-startle.json', import.meta.url), JSON.stringify(out, null, 2))
console.log('C5 curve:', hits.map((h) => `${h.tSec}s:${h.fired ? h.signal : 'blocked(' + h.why + ')'}`).join('  '))
