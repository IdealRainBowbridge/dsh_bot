// 呼吸测试（2026-11-03 · B2）
//
// 器官判据（M58）：单独拿出来能演出现象——
//   「同一句话，高唤醒分得密、低唤醒拖得长」+ 吸气相短、呼气相长（正弦式过渡）。
//   ① 周期随唤醒收缩（呼吸性窦性不均的频率轴）
//   ② 同相位下，唤醒越高间隔越短（振幅轴）
//   ③ 相位扫描：呼气相（φ≈0.5）最长、吸气相（φ≈0/1）最短、中间平滑
//   ④ 静息值可用、钳位有效、gap 永不为负
//   ⑤ 无状态：纯函数，同参数同分布（不依赖前次调用）
import assert from 'node:assert'
import { phase, gap } from '../tools/lib/breath.mjs'

// ── ① 频率轴：周期随 arousal 收缩 ──
{
  const T0 = phase(1000, 0).T
  const T1 = phase(1000, 1).T
  assert.ok(T0 > 5000 && T0 < 5400, '静息周期 ~5.2s（成人静息呼吸），实得 ' + T0)
  assert.ok(T1 > 2000 && T1 < 2400, '最高唤醒周期 ~2.2s（浅快），实得 ' + T1)
  assert.ok(T1 < T0, '唤醒越高呼吸越快')
}

// ── ② 振幅轴：同相位下唤醒越高间隔越短 ──
{
  const t = 1793680000000
  const low = gap(t, 0)
  const high = gap(t, 1)
  assert.ok(low > high, '同参数下唤醒把间隔压短: ' + low + ' vs ' + high)
}

// ── ③ 相位扫描：呼气相最长、吸气相最短、平滑过渡 ──
{
  const T = phase(0, 0).T   // 网格周期必须与采样参数同 arousal（否则只扫到真实周期的一部分，极值位置错位）
  // 12 个相位点 × 每点 40 次采样取平均：把 ±18% 抖动洗掉，纯看曲线形状
  // （M57 教训：抽太稀+有噪声，极值位置会被噪声带偏——先平均再断言）
  const gaps = []
  for (let k = 0; k < 12; k++) {
    const t = Math.floor((k / 12) * T)
    let acc = 0
    for (let s = 0; s < 40; s++) acc += gap(t, 0)
    gaps.push(acc / 40)
  }
  const maxAt = gaps.indexOf(Math.max(...gaps))
  const minAt = gaps.indexOf(Math.min(...gaps))
  assert.ok(maxAt >= 4 && maxAt <= 8, '最长间隔在呼气中段（φ≈0.5），实得位置 ' + maxAt + '/12')
  assert.ok(minAt <= 2 || minAt >= 10, '最短间隔在吸气相（φ≈0 或 1），实得位置 ' + minAt + '/12')
  // 平滑性：相邻点跳变不超过全程（1500-260=1240ms）的 35%。
  // 度量用绝对量：余弦曲线在低谷段"相对当前值"的跳变天然陡（260→570=+66%），那不是不平滑。
  const RANGE = 1500 - 260
  for (let i = 1; i < gaps.length; i++) {
    const jump = Math.abs(gaps[i] - gaps[i - 1]) / RANGE
    assert.ok(jump < 0.35, '相位平滑（无开关式跳变）：' + i + ' 处跳全程 ' + (jump * 100).toFixed(0) + '%')
  }
  // 曲线形状（M57：打出来才算数）
  console.log('   呼吸曲线（φ 0→1 采样）: ' + gaps.join(' → '))
}

// ── ④ 边界与钳位 ──
{
  assert.ok(gap(0, 0) >= 120, '下限钳位')
  assert.ok(gap(0, 5) >= 120 && phase(0, 5).arousal === 1, 'arousal 超界钳到 1')
  assert.ok(gap(0, -2) >= 120, '负 arousal 钳 0')
}

// ── ⑤ 纯函数 ──
{
  const a = gap(1793680000000, 0.5)
  const b = gap(1793680000000, 0.5)
  assert.ok(Math.abs(a - b) / a < 0.4, '同参数同分布（抖动 ±18% 内）')
}

console.log('breath-test: 5 组断言全过（频率轴/振幅轴/相位形状/钳位/纯函数）')
