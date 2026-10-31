// DSH 集成契约 —— 插件对 DSH 内部 API 的显式依赖清单（10-31）。
//
// 为什么需要它：dsh-feiyu 大量使用 DSH 的内部服务（不是公开 SDK）。一次 DSH 升级
// 就可能把某个 API 改名/删掉，而**表现是静默的**：插件照样加载成功，只有某个功能
// 再也不工作（典型：scheduler 的唤醒链断了，她再也不自己醒来，日志里什么都没有）。
//
// 三层防护：
//   ① package.json 的 peerDependencies 写下契约（给人看、给包管理器看）
//   ② 这个文件：每个 API 一条，带"缺了会怎样"和"能不能降级"
//   ③ apply() 启动时 runContractCheck()：缺的记下来，能降级的降级，并在 /api/status
//      与 diagnose 里报出来 —— 让"静默失效"变成"看得见的告警"。
import fs from 'node:fs'

/** 每个依赖点：service=服务名，method=方法名（可空），critical=缺了是否致命，impact=缺了会怎样 */
export const DSH_CONTRACT = [
  // ── 致命：缺了插件壳起不来 ────────────────────────────────────────────────
  { id: 'webServer', service: 'webServer', method: 'register', critical: true, since: '0.2.1-rc.2',
    impact: '整个设置面板与 /api/* 全部不可用（插件等于没装）' },
  { id: 'effect', service: null, method: 'effect', critical: true, since: '0.2.1-rc.2', onCtx: true,
    impact: '无法注册清理逻辑，插件卸载时子进程会泄漏' },

  // ── 重要但可降级：缺了少一块功能，其余照常 ──────────────────────────────
  { id: 'connection', service: 'connection', method: 'requestRejection', critical: false, since: '0.2.1-rc.2',
    impact: 'HTTP 路由的信任栅栏不可用 → 插件按 fail-closed 拒绝所有请求（安全但不可用）' },
  { id: 'sessionController', service: 'sessionController', method: 'create', critical: false, since: '0.2.1-rc.2',
    impact: '生物钟唤醒链断掉：她不会自己醒来刷B站/看番，也不会自主规划（QQ 聊天仍可用）' },
  { id: 'sessionController.prompt', service: 'sessionController', method: 'prompt', critical: false, since: '0.2.1-rc.2',
    impact: '所有"塞进会话"的能力失效：唤醒、每日回顾、人格进化日、完全自由' },
  { id: 'sessionController.resolveAgent', service: 'sessionController', method: 'resolveAgent', critical: false, since: '0.2.1-rc.2',
    impact: '拿不到 session 对象 → 无法钉权限 → 记忆写入会被沙箱拦住（但面板可手动修复）' },
  { id: 'permissionPresets', service: 'permissionPresets', method: 'set', critical: false, since: '0.2.1-rc.2',
    impact: '不能自动把会话设成 danger-full-access → 她的记忆写入需要人工在面板点一次' },
  { id: 'permissionPresets.current', service: 'permissionPresets', method: 'current', critical: false, since: '0.2.1-rc.2',
    impact: '无法读到当前 preset（只能盲设，重复设置无害）' },
]

/** 取服务（兼容 ctx.get 与属性访问两种写法；不带 strict 兜底）。 */
function getService(ctx, name) {
  try { const s = ctx.get(name, false); if (s) return s } catch {}
  try { return ctx[name] ?? null } catch { return null }
}

/**
 * 跑一遍契约检查。
 * @returns {{ ok: boolean, missing: Array<{id:string,impact:string,critical:boolean}>, degraded: string[] }}
 */
export function runContractCheck(ctx) {
  const missing = []
  for (const dep of DSH_CONTRACT) {
    let ok = false
    if (dep.onCtx) {
      ok = typeof ctx?.[dep.method] === 'function'
    } else {
      const svc = getService(ctx, dep.service)
      ok = !!svc && (!dep.method || typeof svc[dep.method] === 'function')
    }
    if (!ok) missing.push(dep)
  }
  const critical = missing.filter((m) => m.critical)
  return {
    ok: critical.length === 0,
    missing: missing.map((m) => ({ id: m.id, impact: m.impact, critical: m.critical })),
    degraded: missing.filter((m) => !m.critical).map((m) => m.id),
  }
}

/**
 * 把契约检查结果写成一行摘要（给 console 与 /api/status 用）。
 * 只报"缺了什么 + 会怎样"，不刷屏。
 */
export function describeContractReport(report) {
  if (!report) return '未检查'
  if (!report.missing.length) return '完整（' + DSH_CONTRACT.length + ' 项依赖全部就位）'
  return report.missing.map((m) => (m.critical ? '✗ 致命 ' : '⚠ 降级 ') + m.id + '：' + m.impact).join('；')
}

/** 运行时的 DSH 版本（尽力而为；读不到就返回 null，不猜）。 */
export function dshVersion() {
  try {
    const j = JSON.parse(fs.readFileSync('/opt/dsh/package.json', 'utf8'))
    return { name: j.name, version: j.version }
  } catch { return null }
}
