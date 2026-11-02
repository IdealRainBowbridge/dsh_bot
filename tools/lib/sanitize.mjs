// sanitize —— 出站硬脱敏过滤器（2026-11-03）
//
// 设计口径（笨蛋老爸 2026-11-03 定）：自改审批不搞了，她完全自主；
// 安全边界收拢成一件事：**本地资料不许漏出去**。不商量、不询问，命中即替换。
// 每次命中留痕（内存 + ~/.data/sanitize-log.txt），她可以复盘"我刚才想说的话里有什么"。
//
// 覆盖的出站口：
//   qq-server send()                 所有出站（私聊/群聊/其他平台出站队列，唯一咽喉）
//   qq-server tryQzone()             QQ 空间说说
//   browser.mjs type                 浏览器输入框（textarea/input/contenteditable）
//   web.mjs searchSmart/searchWeb    搜索关键词出站
//
// 明确不拦的：入站方向（她读什么不受限）；域名（她要能上网）。
//
// 原则：替换是**硬过滤**不是提示词——不经过任何模型判断，纯模式匹配。
// 误伤（把正常长数字/词换掉）接受，漏出不可接受。

import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const MAX_MEM = 300
const mem = []

function record(where, kind) {
  const line = `${new Date().toISOString()} [${where}] ${kind}`
  mem.push(line)
  if (mem.length > MAX_MEM) mem.shift()
  try {
    const f = dataPath('sanitize-log.txt')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, line + '\n')
  } catch { /* 日志失败不拦功能 */ }
  return line
}

/* 模式表。顺序即执行顺序：高熵密钥最先（防被别的规则切碎），
   路径/内网其次，然后邮箱/手机号/上下文锚定的号码，最后裸长编号兜底。 */
const PATTERNS = [
  // API 密钥/令牌特征串（sk-、ghp_、gho_、AKIA、Bearer 后长混合串）
  { kind: '密钥', re: /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,})/g, to: '【一个密钥】' },
  { kind: '校验值', re: /\b[a-f0-9]{32,64}\b/g, to: '【一串校验值】' },
  // 主机路径（她身上的真实路径都是"本地资料在哪"的定位信息）
  { kind: '本机路径', re: /\/(?:srv|mnt|home|opt)\/(?:feiyu|data|baka|dsh)[^\s，。；'"）)]*/g, to: '【本机路径】' },
  { kind: '本机路径', re: /\/root\/\.ssh[^\s，。；'"）)]*/g, to: '【本机路径】' },
  { kind: '本机路径', re: /[A-Za-z]:\\Users\\[^\s，。；'"）)]+/g, to: '【本机路径】' },
  // 内网/虚网地址（RFC1918 + Tailscale CGNAT 100.64/10）
  { kind: '内网地址', re: /(?<![\d.])(?:(?:10|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![\d.])/g, to: '【内网地址】' },
  // 邮箱
  { kind: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '【一个邮箱】' },
  // 手机号
  { kind: '手机号', re: /(?<![\d.])1[3-9]\d{9}(?![\d.])/g, to: '【一个手机号】' },
  // QQ 号（带上下文锚：前缀或"号"字，避免误伤普通数字）
  { kind: 'QQ号', re: /QQ\s*[:：#]?\s*\d{4,12}/gi, to: '【一个QQ号】' },
  { kind: '号码', re: /(?:帐号|账号|号码|扣扣|企鹅)\s*(?:是|为|[:：])?\s*\d{4,12}/g, to: '【一个号码】' },
  // 裸长编号兜底（8-12 位纯数字：订单号/QQ号裸提/日期串）。30000ms、13KB 这类带单位的短数字不中。
  { kind: '编号', re: /(?<![\d.])\d{8,12}(?![\d.])(?![分秒毫])/g, to: '【一串编号】' },
]

/** 对一段要出站的文本做硬脱敏。返回替换后的文本；有命中会记日志。 */
export function sanitizeText(where, text) {
  let s = String(text ?? '')
  if (!s) return s
  for (const p of PATTERNS) {
    s = s.replace(p.re, () => {
      try { record(where, p.kind) } catch { }
      return p.to
    })
  }
  return s
}

/**
 * 对 OneBot 出站 payload 做脱敏（qq-server send 用）。
 * message 是数组（[{type:'text',...},{type:'image',...}]）或字符串；只动文本。
 * 返回新 payload（不改原对象）。
 */
export function sanitizeOutbound(where, payload) {
  if (!payload || typeof payload !== 'object') return payload
  const msg = payload.message
  if (Array.isArray(msg)) {
    let touched = false
    const next = msg.map((seg) => {
      if (seg && seg.type === 'text' && typeof seg.data?.text === 'string') {
        const t = sanitizeText(where, seg.data.text)
        if (t !== seg.data.text) { touched = true; return { ...seg, data: { ...seg.data, text: t } } }
      }
      return seg
    })
    return touched ? { ...payload, message: next } : payload
  }
  if (typeof msg === 'string') {
    const t = sanitizeText(where, msg)
    return t !== msg ? { ...payload, message: t } : payload
  }
  return payload
}

/** 最近命中（内存环形，调试/她自查用）。 */
export function sanitizeHits(n = 20) { return mem.slice(-n) }
