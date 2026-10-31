// platforms —— 平台枚举与能力的**单一真相**（v5 重构）。
//
// 为什么要有它：重构前 platforms 的语义散落在三处——
//   ① 面板 client.js 有个 PLATFORMS 数组
//   ② qq-server 用 `live.platforms?.qq === false` 硬写
//   ③ diagnose 又硬写一遍
// 于是出现「关 QQ 把微信一起杀掉」「新增平台忘了加判断」这类问题。
//
// 这里的约定：
//   · PLATFORMS 是唯一的枚举顺序（面板、diagnose、日志都按它来）
//   · 每个平台声明：能不能私聊 / 能不能群聊 / 外发要不要过 guard / 走哪条出站
//   · enabled(cfg, id) 是**唯一**的开关判定入口（平台开关 + 服务开关的合成）
//
// 平台开关语义（v5 统一）：
//   platforms.<id>   用户意图（持久）。false = 彻底关。
//   <svc>.enabled    服务级开关。false = 服务不启动 / 不认活。
//   两者任一为 false → 该平台关闭。**只影响自己，不影响别的平台。**

/** @typedef {{id:string,label:string,private:boolean,group:boolean,outbound:"onebot"|"outbox",agent:boolean}} Platform */

/** 有实现、可对话的平台（顺序＝面板显示顺序）。 */
export const PLATFORMS = [
  { id: 'qq', label: 'QQ', private: true, group: true, outbound: 'onebot', agent: true },
  { id: 'wechat', label: '微信', private: true, group: false, outbound: 'outbox', agent: true },
]

/** 非对话平台（只有行为，没有消息入口）。保留在这里是为了日志/记忆的 platform 字段有白名单。 */
export const PASSIVE_PLATFORMS = [
  { id: 'bilibili', label: 'B站' },
  { id: 'web', label: '上网' },
]

/** 已下线但历史数据里还存在（只读兼容，不要再往这里写新东西）。 */
export const RETIRED_PLATFORMS = ['douyin', 'douyin-dm']

const BY_ID = new Map([...PLATFORMS, ...PASSIVE_PLATFORMS].map((p) => [p.id, p]))

/** 取平台定义；未知平台返回 null（调用方自行决定怎么兜底）。 */
export function platformOf(id) {
  return BY_ID.get(String(id || '')) || null
}

/** 是不是一个认识的平台（含已下线，用于读旧数据）。 */
export function isKnownPlatform(id) {
  const s = String(id || '')
  return BY_ID.has(s) || RETIRED_PLATFORMS.includes(s)
}

/** 平台显示名。 */
export function labelOf(id) {
  return platformOf(id)?.label || String(id || '?')
}

/** 服务级开关的配置路径（qq → cfg.qq.enabled；wechat → cfg.wechat.enabled）。 */
function svcOf(cfg, id) {
  if (id === 'qq') return cfg?.qq
  if (id === 'wechat') return cfg?.wechat
  return null
}

/**
 * 该平台现在**是否对外服务**。唯一判定入口。
 * 规则：platforms.<id> !== false && <svc>.enabled !== false（缺省视为开）
 * @returns {{on:boolean, why:string}}
 */
export function enabled(cfg, id) {
  const def = platformOf(id)
  if (!def) return { on: false, why: '未知平台' }
  const intent = cfg?.platforms?.[id]
  if (intent === false) return { on: false, why: 'platforms.' + id + '=false（面板开关关着）' }
  const svc = svcOf(cfg, id)
  if (svc && svc.enabled === false) return { on: false, why: id + '.enabled=false（服务开关关着）' }
  return { on: true, why: '' }
}

/** 该平台是不是只允许私聊（群聊消息直接丢）。 */
export function allowsGroup(id) {
  return platformOf(id)?.group === true
}

/** 该平台的出站方式。 */
export function outboundOf(id) {
  return platformOf(id)?.outbound || 'outbox'
}

/** 面板/诊断用的状态快照。 */
export function snapshot(cfg) {
  return [...PLATFORMS, ...PASSIVE_PLATFORMS].map((p) => {
    const e = enabled(cfg, p.id)
    return { id: p.id, label: p.label, on: e.on, why: e.why, dialog: !!p.private }
  })
}
