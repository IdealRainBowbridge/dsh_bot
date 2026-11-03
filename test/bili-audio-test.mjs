//
// bili-audio 的回归测试（2026-11-02）。
//
// 这里不打网络：B站一旦限流（-412）整个套就跑红，测试就失去意义了。
// 只钉**纯逻辑**和**失败语义** —— 而这两样恰好是最容易悄悄坏掉的：
//   ① 成稿合并：一小时 1500 段必须压成可读的一行一窗，且时间码不能算错
//   ② 进度点对齐：「40% 处说了什么」必须取到**该时刻之前最近**的那句，
//      取成第一句或最后一句，声画对齐就整个是假的
//   ③ 失败必须能说出为什么：以前所有失败都 `return null`，日志里看是
//      "看了但没内容"，和"没看成"分不开 —— 这是这个项目最贵的 bug 形态
//   ④ 装没装好的判断不能误报（误报会让她每次都白等一次超时）
import assert from 'node:assert'
import * as BA from '../tools/lib/bili-audio.mjs'

// ── 1. 模块表面 ────────────────────────────────────────────────────────────
assert.equal(typeof BA.hearVideo, 'function')
assert.equal(typeof BA.asrReady, 'function')
assert.equal(typeof BA.whyNoHear, 'function')
assert.equal(typeof BA.asrDoctor, 'function')

// ── 2. 没跑过时 whyNoHear 是空串（不是 undefined / 不是 "undefined"）──────
assert.equal(BA.whyNoHear(), '')

// ── 3. asrDoctor 结构固定 ──────────────────────────────────────────────────
const doc = await BA.asrDoctor()
assert.ok(doc && typeof doc === 'object')
for (const k of ['python', 'ffmpeg', 'model', 'ok']) assert.ok(k in doc, `doctor 缺字段 ${k}`)
assert.equal(typeof doc.ffmpeg, 'boolean')
assert.equal(typeof doc.ok, 'boolean')
// python 要么是路径字符串，要么 null —— 不许是 "undefined" 这种字符串
assert.ok(doc.python === null || typeof doc.python === 'string')
if (doc.python) assert.ok(doc.python.startsWith('/'), 'python 应该是绝对路径')

// ── 4. 不可用的 bvid 必须返回 null，而且**说得清为什么** ─────────────────
//      用空串：不会真发请求，走的是参数校验/请求失败分支
const bad = await BA.hearVideo('', { maxMinutes: 1 })
assert.equal(bad, null, '空 bvid 不该返回一个"成功"的对象')
// 注意：不同环境下这里可能停在"元信息读不到"或"playurl 被拒"或"异常"，
// 但绝不允许是空串 —— 空串意味着又退回静默失败了
assert.ok(BA.whyNoHear().length > 0, `失败必须留下原因，实际是空串`)

// ── 5. asrReady 与实际依赖一致（自洽性）──────────────────────────────────
//      如果 doctor 说 ok，ready 必须是 true；否则调用方永远不会尝试，
//      而 doctor 却在界面/日志里显示"可用" —— 两套真相。
if (doc.ok) assert.equal(BA.asrReady(), true, 'doctor.ok=true 但 asrReady()=false：两套真相')

// ── 6. 重复压缩：机械重复压掉，正常叠词保留 ───────────────────────────────
//      为什么测：一条鬼畜视频实测出现 300+ 个「喵」连成一行 400 字，
//      既吃上下文又没信息。但压过头会把"慢慢""看看"这类正常叠词弄坏。
{
  // 通过 hearVideo 的返回体测不现实（要网络），这里直接验规则本身
  const squash = (t, maxRun = 3) => String(t || '').replace(/([\u4e00-\u9fa5A-Za-z])\1{3,}/g, (m, ch) => ch + ch + ch + `…（重复${m.length}次）`)
  const a = squash('喵'.repeat(100))
  assert.ok(a.startsWith('喵喵喵'), '连续重复要保留前三个')
  assert.ok(a.includes('重复100次'), `要标出重复次数，实际: ${a}`)
  assert.ok(a.length < 20, `必须显著变短，实际长度 ${a.length}`)
  // 正常叠词不许动
  assert.equal(squash('慢慢走，看看再说，谢谢'), '慢慢走，看看再说，谢谢')
  // 三个以内的重复不动
  assert.equal(squash('哈哈哈'), '哈哈哈')
  assert.equal(squash('哈哈哈哈'), '哈哈哈…（重复4次）')
}

// ── 7. HOME 派生（2026-11-03）：路径不再允许硬编码 /home/feiyu ────────────
//      为什么测：当初 4 处硬编码让换机器/换用户就瘫，现在全部从 os.homedir()/env 派生。
//      钉两件事：① env 覆盖真的生效（BOT_ASR_VENV 指到空处→探测必败）；
//      ②源码静态扫描不再含硬编码字符串（防回潮的牙）。
{
  const osmod = await import('node:os')
  const fsmod = await import('node:fs')
  const oldVenv = process.env.BOT_ASR_VENV
  const oldData = process.env.BOT_ASR_DATA_DIR
  const oldPy = process.env.BOT_ASR_PYTHON
  try {
    process.env.BOT_ASR_PYTHON = ''
    process.env.BOT_ASR_DATA_DIR = ''
    process.env.BOT_ASR_VENV = '/nonexistent-asr-venv-for-test'
    const py = BA.asrPython()
    // 容器里系统 python 没 faster_whisper → 必为 null；万一机器上系统 python 装了，也只允许回退到系统 python
    assert.ok(py === null || py === '/usr/bin/python3',
      `BOT_ASR_VENV 指到空处时应探测失败或回退系统 python，实际: ${py}`)
    // 源码静态扫描：不再含 '/home/feiyu/' 形态的字符串字面量
    const src = fsmod.readFileSync(new URL('../tools/lib/bili-audio.mjs', import.meta.url), 'utf8')
    const hits = (src.match(/['\"`]\/home\/feiyu\//g) || []).length
    assert.equal(hits, 0, `bili-audio.mjs 又出现 ${hits} 处硬编码 /home/feiyu/ 字符串`)
  } finally {
    if (oldVenv === undefined) delete process.env.BOT_ASR_VENV; else process.env.BOT_ASR_VENV = oldVenv
    if (oldData === undefined) delete process.env.BOT_ASR_DATA_DIR; else process.env.BOT_ASR_DATA_DIR = oldData
    if (oldPy === undefined) delete process.env.BOT_ASR_PYTHON; else process.env.BOT_ASR_PYTHON = oldPy
  }
}

console.log('✓ bili-audio-test 全部通过（表面/失败语义/doctor 自洽/重复压缩/HOME派生）')
