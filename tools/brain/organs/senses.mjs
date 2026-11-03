// brain/organs/senses —— 器官感官接线板（2026-11-03 架构修复：解 field↔organ 环）
//
// 为什么有这个文件（评审②抓到的两个环）：
//   旧写法 field.sense() 直接 import organ/pain 的 acheSense、organ/metabolism 的
//   sense、lib/immune 的 feverSense。而 pain→hpa→field、metabolism→field —— 于是：
//     field → pain → hpa → field     （三元环，A3b 文件对检查抓不到）
//     field → metabolism → field     （文件对环）
//   循环 import 在 ESM 里多数时候"能跑"，但初始化顺序变成赌运气：谁的顶层代码
//   先执行、谁拿到半初始化的绑定，全看入口从哪进来。
//
// 解法（仓库既有口径：函数体内动态 import 断边，见 check.mjs ALLOWED_REVERSE 注释）：
//   · field → senses（静态）：field 只认识这块接线板，永远不知道每个器官的存在。
//   · senses → pain / metabolism（**动态**，模块加载即预取）：静态图里 field 不再
//     连向 organ —— 环断了。预取是异步微任务，field 自身模块求值完成之后才跑，
//     不存在 TDZ；预取完成前的极早调用拿不到痛感/饿感（感官本来就是 best-effort，
//     "失败就当没这回事"是契约的一部分）。
//   · 器官层永不 import field（单向：field→senses⇢organ）。
//   · 以后新器官给"身体感"出话，在 PRELOAD 数组里多挂一个模块、在 senses() 里
//     多读一项 —— field 永远不动。
//
// 契约：senses() 同步、永不抛错；每项是 string 或 null；空数组 = 身体没话说。
// 顺序有讲究：病感（全身性）→ 慢痛（局部）→ 饿感（最贴近当下，放最后）。
import { feverSense as immuneFeverSense } from '../../lib/immune.mjs'
import { swallow } from '../../lib/swallow.mjs'

const _organs = {}
// 预取（模块加载即发车）：pain → hpa → field 的链路在微任务里才求值，
// 此时 field 已经完成初始化 —— 不与 field 的加载构成环，也没有半初始化风险。
Promise.all([import('../organ/pain.mjs'), import('../organ/metabolism.mjs')])
  .then(([pn, mb]) => { _organs.pain = pn; _organs.metabolism = mb })
  .catch((e) => swallow(e, 'senses:preload'))

export function senses() {
  const bits = []
  // 免疫病感：发热是全身性事件。放在"正面信号"兜底之前——发烧时她不该被描述成"身上是轻的"。
  try { const fever = immuneFeverSense(); if (fever) bits.push(fever) } catch (e) { swallow(e, 'senses:fever') }
  // 慢痛（B4）：还在流血的伤口 → 钝痛；愈合即停，不背着旧伤喊疼。
  try { const ache = _organs.pain && _organs.pain.acheSense && _organs.pain.acheSense(); if (ache) bits.push(ache) } catch (e) { swallow(e, 'senses:ache') }
  // 饿感（B3）：认知能量低 = 「脑子转不动/想吃点轻松的」；积压 = 「脑子里堆着没消化的」。
  try { const hunger = _organs.metabolism && _organs.metabolism.sense && _organs.metabolism.sense(); if (hunger) bits.push(hunger) } catch (e) { swallow(e, 'senses:hunger') }
  return bits
}
