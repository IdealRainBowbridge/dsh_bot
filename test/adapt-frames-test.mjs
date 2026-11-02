//
// adapt-frames 的回归测试（2026-11-02）。
//
// 这套测的是**采样策略**，不是 ffmpeg 调用 —— 所以全程用假探针（不碰网络/文件），
// 把算法逻辑钉死。真实的取帧链路由 bili-frames 的端到端测试覆盖。
//
// 为什么要单独测：这套里每一个数字都被我改错过一次
// （阈值 0.28 拍脑袋、骨架固定 3 个点导致 60 分钟片子漏掉前 14 分钟、
//   去重漏了开头导致两个 0 秒……），而且错了都不会报错，只会"看起来正常"。
import assert from 'node:assert'
import * as AF from '../tools/lib/adapt-frames.mjs'

// ── 1. frameDistance 的基本性质 ────────────────────────────────────────────
{
  const a = Buffer.alloc(64 * 36, 0)
  const b = Buffer.alloc(64 * 36, 255)
  assert.equal(AF.frameDistance(a, a), 0, '同一帧必须 0')
  assert.equal(AF.frameDistance(a, b), 1, '全反必须 1')
  assert.equal(AF.frameDistance(null, a), 1, '缺帧当"变了"，宁可多看一眼')
  assert.equal(AF.frameDistance(a, Buffer.alloc(10)), 1, '长度不符当"变了"')
}

// ── 2. 自适应阈值：不同节奏的片子要得到不同的阈值 ────────────────────────
//      这就是「让内容决定」的核心 —— 快片阈值高、慢片阈值低，
//      而不是所有片子共用一个 0.28。
{
  const W = 64, H = 36
  const mk = (v) => Buffer.alloc(W * H, v)

  // 快片：按 sec 剧烈变化（模拟切镜头频繁的动画，差异 ~0.5）
  const fast = async (sec) => mk(Math.round((sec * 37) % 256))
  const fastTh = (await AF.pickByContentStream(fast, { duration: 600, budget: 6 })).calibratedThresh

  // 慢片：按 sec 缓慢变化（模拟长镜头，差异 ~0.02）
  const slow = async (sec) => mk(Math.round(100 + (sec / 600) * 10))
  const slowTh = (await AF.pickByContentStream(slow, { duration: 600, budget: 6 })).calibratedThresh

  assert.ok(fastTh > slowTh, `快片阈值(${fastTh}) 应高于慢片(${slowTh})`)
  // 慢片必须被压到下限，否则"静止也会到处补帧"
  assert.equal(slowTh, 0.04, `慢片阈值应贴下限 0.04，实际 ${slowTh}`)
  assert.ok(fastTh >= 0.15, `快片阈值应明显高于下限，实际 ${fastTh}`)
}

// ── 3. 骨架必须覆盖全片（60 分钟的片子不能只看开头）────────────────────
//
// ⚠ 这一条最初写错了，而且**变异测试证明它抓不到 bug**：
//   旧的假探针每次返回"交替的 200/20"，导致任意相邻差异都是最大值 1.0，
//   阈值被顶到上限、内容层随便补都能过 —— 把骨架公式改回固定 3 个点，测试照样绿。
//   这正是这个项目最贵的失败形态：**测试绿着，但测的不是那个东西**。
//
// 现在的做法：
//   ① 探针是**秒的确定性函数**（同一个 sec 永远同一个值），模拟真实视频
//   ② 片子"很安静"（相邻差异都小于任何阈值）→ 内容层不会补帧
//      → 结果**只剩骨架点**，骨架数量就能被直接验证
//   ③ 断言骨架点必须落在 0 / 20分 / 40分 / 60分 附近
{
  const W = 64, H = 36
  // 完全静止的片子：任何两个不同秒的图都一样 → 差异 0 → 阈值取到下限 0.04，
  // 内容层永远"没变化"不补帧，只剩骨架。
  const probe = async () => Buffer.alloc(W * H, 128)
  const picked = await AF.pickByContentStream(probe, { duration: 3391, budget: 6 })
  const secs = picked.map((p) => p.sec)
  // 静止片的内容层会补帧，所以这里**不数数量**（数量抓不到 bug，试过），
  // 而是钉**骨架点本身的位置**：20 分钟一档，必须出现 0 / ~1130 / ~2260 / 3390。
  // 骨架公式退回"固定 3 个点"时，1130 和 2260 附近就没有点 —— 这条能抓住。
  const near = (target, tol = 60) => secs.some((s) => Math.abs(s - target) <= tol)
  assert.ok(near(0), `缺片头骨架点：${secs.join(',')}`)
  assert.ok(near(3391), `缺片尾骨架点：${secs.join(',')}`)
  assert.ok(near(3391 / 3), `缺 1/3 处骨架点（≈1130s）：${secs.join(',')}`)
  assert.ok(near((3391 * 2) / 3), `缺 2/3 处骨架点（≈2260s）：${secs.join(',')}`)
}

// ── 4. 取帧点不许挤在一起（去重本身测不到，这里只验间距）────────────────
//
// 同样被变异测试打回过：旧写法用"交替 250/5"的探针，
// 去掉去重逻辑照样能过（因为奇数/偶数次调用天然不同）。
// 现在用一个**随时间连续变化**的探针（模拟真实画面），
// 并检查任意两点间距 >= 1 秒 —— 两个点挨太近说明去重坏了。
{
  const W = 64, H = 36
  const probe = async (sec) => {
    // 用 sec 决定整体亮度：越往后越亮，任何两点都不同
    const v = Math.min(255, Math.floor((sec / 400) * 255))
    return Buffer.alloc(W * H, v)
  }
  const picked = await AF.pickByContentStream(probe, { duration: 400, budget: 8 })
  const secs = picked.map((p) => p.sec).sort((a, b) => a - b)
  // 两点间距必须 >= minStep(2s)：去重坏掉时会出现几乎重合的点
  for (let i = 1; i < secs.length; i++) {
    assert.ok(secs[i] - secs[i - 1] >= 2, `取帧点太近（去重坏了）：${secs.join(',')}`)
  }
  assert.equal(new Set(secs.map((s) => Math.round(s * 10))).size, secs.length, `出现重复取帧点：${secs.join(',')}`)
  // ⚠ 关于去重：**这条测不出来**，别假装能。
  //   变异测试证明：把 `if (usedSec.has(key)) continue` 删掉，整套测试照样全绿 ——
  //   因为骨架点等距、二分点取中点，天然不会重合成同一个 key。
  //   去重真正防的是"浮点巧合"（duration 很小导致骨架算出重复秒），
  //   那需要构造极端参数才能触发。这里直接用一个**极小 duration** 去撞它：
  {
    const tiny = await AF.pickByContentStream(async () => Buffer.alloc(W * H, 90), {
      duration: 5, budget: 6,
    })
    const ts = tiny.map((p) => p.sec)
    assert.equal(new Set(ts.map((x) => Math.round(x * 10))).size, ts.length,
      `极短时长下出现重复取帧点：${ts.join(',')}`)
  }
}

// ── 5. 预算上限必须被尊重 ────────────────────────────────────────────────
{
  const W = 64, H = 36
  let n = 0
  const probe = async () => Buffer.alloc(W * H, (n++ % 2) ? 230 : 25)
  for (const budget of [3, 6, 10]) {
    const picked = await AF.pickByContentStream(probe, { duration: 1000, budget })
    assert.ok(picked.length <= budget, `budget=${budget} 却取到 ${picked.length} 帧`)
  }
}

// ── 6. 取不到任何帧时安静返回空数组（不抛、不卡）────────────────────────
{
  const picked = await AF.pickByContentStream(async () => null, { duration: 300, budget: 5 })
  assert.deepEqual(picked, [], '探针全失败应返回空数组')
}

// ── 7. planOnly 保留位置、丢掉 buf ───────────────────────────────────────
{
  const plan = AF.planOnly([{ sec: 12, ratio: 0.1, buf: Buffer.alloc(4) }, { sec: 30, ratio: 0.25, buf: Buffer.alloc(4) }])
  assert.equal(plan.length, 2)
  assert.ok(!('buf' in plan[0]), 'planOnly 不该带 buf')
  assert.equal(plan[0].sec, 12)
  assert.equal(plan[1].ratio, 0.25)
}

// ── 8. labelOf ───────────────────────────────────────────────────────────
assert.equal(AF.labelOf(0.25, false), '25%')
assert.equal(AF.labelOf(0.25, true), '~25%')

// 如实说明覆盖面：去重逻辑**没有**被这套测试有效覆盖（见上面第 4 条的注释）。
console.log('✓ adapt-frames-test 全部通过（阈值自适应 / 骨架覆盖 / 预算上限 / 失败语义）')
