// mood-recall-test —— C2 心情一致性回忆（2026-11-03）
//
// 器官判据（M58）：
//   ① 心情差（valence<0）：同库对等的两条记忆（lex/recency/salience 同分），
//     负效价者得分反超正效价者
//   ② 心情好：正效价者反超（镜像）
//   ③ 心情中性（valence=0）：无偏置（两条同分）
//   ④ 乘法形态：偏置量与 base 分数成比例（不同 base 下 delta/base 恒定 = k*mood*valence）
//   ⑤ peekValence 纯读：不落盘不演化；无文件回 0
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-c2-'))
process.env.BOT_DATA_DIR = TMP
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')

const { epFile, fieldPath } = await import('../tools/brain/paths.mjs')
const field = await import('../tools/brain/field.mjs')
const recall = await import('../tools/brain/recall.mjs')

const NOW = Date.now()
fs.mkdirSync(path.dirname(epFile(new Date(NOW))), { recursive: true })

function seedMood(v) {
  fs.mkdirSync(path.dirname(fieldPath()), { recursive: true })
  fs.writeFileSync(fieldPath(), JSON.stringify({ at: NOW, dims: { valence: v, da: 0.5, ne: 0.35, sero: 0.6, cortisol: 0.15, fatigue: 0.1, sleepDebt: 0.2 } }))
}
function seedPair(base) {
  // 两条仅效价不同的孪生记忆：同刻、同 chat、同 gist 词面；entities 必须不同
  // （折叠 key = scope|entities[0]|30min 桶，同 key 会被「只折闲聊」合并掉一条）
  fs.writeFileSync(epFile(new Date(NOW)), [
    { id: 'c2-pos', at: NOW - 3600_000, act: 'say', scope: 'private', gist: 'xylophone 泳池 走廊', entities: ['twin-a'], who: { kind: 'user', others: [{ kind: 'owner' }] }, feel: { valence: +0.6, arousal: 0.3 }, salience: base },
    { id: 'c2-neg', at: NOW - 3600_000, act: 'say', scope: 'private', gist: 'xylophone 泳池 走廊', entities: ['twin-b'], who: { kind: 'user', others: [{ kind: 'owner' }] }, feel: { valence: -0.6, arousal: 0.3 }, salience: base },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
}
function best(query) {
  const cues = recall.cuesFrom({ text: query, recentTexts: [], entities: [], extra: '' })
  const found = recall.search({ cues, audience: 'private', now: NOW, limit: 8, chat: '' })
  return found.items
}

// ── ⑤ peekValence 纯读 ──────────────────────────────────────────────────
seedMood(-0.4)
const before = fs.statSync(fieldPath())
const v = field.peekValence(NOW)
assert.ok(Math.abs(v + 0.4) < 1e-6, 'peekValence reads stored valence, got ' + v)
const after = fs.statSync(fieldPath())
assert.strictEqual(after.mtimeMs, before.mtimeMs, 'peekValence must not touch the file')
fs.rmSync(fieldPath())
assert.strictEqual(field.peekValence(NOW), 0, 'no file -> 0 (neutral)')
console.log('ok 5 peekValence pure-read: file untouched, missing -> 0')

// ── ① 心情差：负向反超 ──────────────────────────────────────────────────
seedMood(-0.6)
seedPair(0.5)
const negMood = best('xylophone')
const negPos = negMood.find((x) => x.ep.feel.valence > 0)
const negNeg = negMood.find((x) => x.ep.feel.valence < 0)
assert.ok(negNeg && negPos, 'both twins recalled')
assert.ok(negNeg.score > negPos.score, `negative mood lifts negative memory: neg ${negNeg.score} > pos ${negPos.score}`)
const gapNeg = negNeg.score - negPos.score
console.log('ok 1 negative mood: neg', negNeg.score, '> pos', negPos.score)

// ── ② 心情好：正向反超 ──────────────────────────────────────────────────
seedMood(0.6)
const posMood = best('xylophone')
const posPos = posMood.find((x) => x.ep.feel.valence > 0)
const posNeg = posMood.find((x) => x.ep.feel.valence < 0)
assert.ok(posPos.score > posNeg.score, `positive mood lifts positive memory: pos ${posPos.score} > neg ${posNeg.score}`)
console.log('ok 2 positive mood: pos', posPos.score, '> neg', posNeg.score)

// ── ③ 中性无偏置 ────────────────────────────────────────────────────────
seedMood(0)
const neutral = best('xylophone')
const nPos = neutral.find((x) => x.ep.feel.valence > 0), nNeg = neutral.find((x) => x.ep.feel.valence < 0)
assert.ok(Math.abs(nPos.score - nNeg.score) < 1e-6, 'neutral mood leaves twins tied')
console.log('ok 3 neutral mood: tied at', nPos.score)

// ── ④ 乘法形态：k 还原（用中性基线法，避免 toFixed 截断误差）───────────
seedMood(0)
seedPair(0.5)
const baseNeutral = best('xylophone')
const bPos = baseNeutral.find((x) => x.ep.feel.valence > 0)
const base0 = bPos.score                     // mood=0 时 score = 纯加权分
seedMood(-0.6)
seedPair(0.5)
const lowMood = best('xylophone')
const lPos = lowMood.find((x) => x.ep.feel.valence > 0), lNeg = lowMood.find((x) => x.ep.feel.valence < 0)
// lPos = base0 * (1 + k*mood*(+0.6)); lNeg = base0 * (1 + k*mood*(-0.6))
const kFromPos = (lPos.score / base0 - 1) / (-0.6 * 0.6)
const kFromNeg = (lNeg.score / base0 - 1) / (-0.6 * -0.6)
assert.ok(Math.abs(kFromPos - 0.08) < 0.01 && Math.abs(kFromNeg - 0.08) < 0.01,
  `k recovered from both twins: pos ${kFromPos.toFixed(3)} neg ${kFromNeg.toFixed(3)}`)
console.log('ok 4 multiplicative k: pos ' + kFromPos.toFixed(3) + ' neg ' + kFromNeg.toFixed(3) + ' (target 0.08)')

console.log('mood-recall-test all green')
