// one-off C3 probe: inspect rpe state + omission threshold inside container
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c3p-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
const neuron = await import('/home/dsh/plugins/dsh_bot/tools/brain/cell/neuron.mjs')
const { neuronPath, fieldPath } = await import('/home/dsh/plugins/dsh_bot/tools/brain/paths.mjs')
const T0 = 1_700_000_000_000, IVL = 30 * 60_000
for (let i = 0; i <= 30; i++) neuron.rpe(0.6, { source: 'owner', care: 1, now: T0 + i * IVL })
const raw = JSON.parse(fs.readFileSync(neuronPath(), 'utf8'))
console.log('rpe.owner =', JSON.stringify(raw.rpe?.owner))
const tLast = T0 + 30 * IVL
const silent = tLast + 46 * 60_000
const r = raw.rpe.owner
const ivl = Math.max(10 * 60_000, Number(r.ivl || 0))
console.log('silentFor', (silent - r.lastAt) / 60000, 'min; threshold', Math.max(45, 1.5 * ivl / 60000), 'min')
const before = JSON.parse(fs.readFileSync(fieldPath(), 'utf8')).dims.da
neuron.tick(silent)
const after = JSON.parse(fs.readFileSync(fieldPath(), 'utf8')).dims.da
console.log('da before', before, 'after tick', after)
console.log('rpe.owner after tick =', JSON.stringify(JSON.parse(fs.readFileSync(neuronPath(), 'utf8')).rpe?.owner))
