// python-runtime —— 找"能用的 python"（v5 新增，替掉散落各处的 Windows 硬编码路径）。
//
// 重构前的三个死法（都是静默的）：
//   ① stickers.mjs 用 cfg.wechat.python（D:/wechat-bot/...）：容器里不存在 → 恒返 null，
//      "AI 画不出来就退 PIL 文字贴纸"这条兜底从未生效过。
//   ② prosody.mjs 默认 D:/GPT-SoVITS/.venv/Scripts/python.exe：不存在 → 打分器全 0，
//      择优永远选第一条，而且只在 console.warn 里说一次。
//   ③ config.voice.python 指向 /usr/bin/python3：容器里没有这个文件。
//
// 修法：**探测 + 缓存 + 说清楚为什么不可用**。不要猜，也不要在每个调用点各写一套候选。
// 只要有一个候选真的能跑（`-c "import sys"` 成功），就用它；一个都没有就明确返回
// { ok:false, why } —— 让 diagnose 能判红，而不是静默降级。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config } from './config.mjs'

/** 候选顺序：显式配置 > 环境变量 > 容器内常见位置 > 系统 PATH。 */
function candidates() {
  const cfg = config()
  const out = []
  const push = (p) => { if (p && typeof p === 'string') out.push(p) }
  push(cfg.voice?.python)
  push(process.env.BOT_PYTHON)
  push(process.env.BOT_TTS_PYTHON)
  // 容器里 DSH 自带的 pyenv（存在但没有第三方库，作为"能跑"的最低保障）
  push(path.join(process.env.HOME || '', '.dsh', 'pyenv', 'bin', 'python3'))
  push(path.join(process.env.HOME || '', '.dsh', 'pyenv', 'bin', 'python'))
  // 系统
  push('/usr/bin/python3')
  push('/usr/local/bin/python3')
  push('python3')
  push('python')
  return [...new Set(out)]
}

/** 这个解释器能不能跑（缓存结果，避免每次调用都 fork）。 */
const cache = new Map()
function usable(bin) {
  if (!bin) return false
  if (cache.has(bin)) return cache.get(bin)
  let ok = false
  try {
    // 绝对路径先看文件存在，省一次 fork
    if (bin.includes('/') || bin.includes('\\')) ok = fs.existsSync(bin)
    else ok = true
    if (ok) execFileSync(bin, ['-c', 'import sys'], { timeout: 5000, stdio: 'ignore' })
  } catch { ok = false }
  cache.set(bin, ok)
  return ok
}

/** 能不能 import 某个模块（用来判断 PIL / numpy / librosa 有没有）。 */
const modCache = new Map()
export function hasModule(bin, mod) {
  const key = bin + '::' + mod
  if (modCache.has(key)) return modCache.get(key)
  let ok = false
  try {
    execFileSync(bin, ['-c', 'import ' + mod], { timeout: 8000, stdio: 'ignore' })
    ok = true
  } catch { ok = false }
  modCache.set(key, ok)
  return ok
}

/**
 * 找可用的 python。
 * @returns {{ok:boolean, bin:string, why:string, candidates:string[]}}
 */
export function findPython() {
  const list = candidates()
  for (const bin of list) {
    if (usable(bin)) return { ok: true, bin, why: '', candidates: list }
  }
  return { ok: false, bin: '', why: '找不到可用的 python 解释器（试过：' + list.join(', ') + '）', candidates: list }
}

/** 需要第三方库的场景：返回 python + 缺哪个库。 */
export function findPythonWith(mods = []) {
  const p = findPython()
  if (!p.ok) return { ...p, missing: mods.slice() }
  const missing = mods.filter((m) => !hasModule(p.bin, m))
  return { ...p, missing }
}

/** 清缓存（测试用）。 */
export function resetPythonCache() {
  cache.clear()
  modCache.clear()
}
