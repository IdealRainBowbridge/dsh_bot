// 出站脱敏过滤器的行为测试（2026-11-03，自改全自主的配套）
// 设计口径：**漏出不可接受，误伤可接受** —— 所以正例专测"该拦的拦住"，
// 负例只测最要紧的日常数字（心跳毫秒/集数/分钟/日期），证明过滤器不把她的正常说话打碎。
import fs from 'node:fs'
import { dataPath } from '../tools/lib/paths.mjs'
import { sanitizeText, sanitizeOutbound } from '../tools/lib/sanitize.mjs'

let pass = 0
let fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`✗ ${name}`) } }
// 出站文本里不允许再出现任何一个 secret 子串
const noLeak = (name, out, ...secrets) => {
  const hit = secrets.filter((s) => String(out).includes(s))
  if (hit.length) { fail++; console.error(`✗ ${name}：泄漏了 ${hit.join(' | ')}（现在是：${String(out).slice(0, 60)}）`) } else pass++
}

/* ─── 应拦（正例）─── */
noLeak('QQ号(前缀锚)', sanitizeText('t', '我主人的QQ 3682285116 人超好'), '3682285116')
noLeak('QQ号(紧贴)', sanitizeText('t', '他QQ号3682285116'), '3682285116')
noLeak('账号是', sanitizeText('t', '我的账号是3682285116'), '3682285116')
noLeak('裸QQ号(兜底)', sanitizeText('t', '他号 3682285116'), '3682285116')
noLeak('手机号', sanitizeText('t', '打这个电话 13812345678 找他'), '13812345678')
noLeak('sk密钥', sanitizeText('t', 'key是sk-abc123def456ghi789jkl012别外传'), 'sk-abc123')
noLeak('32位hex', sanitizeText('t', '签名 5f8a2b3c4d5e6f708192a3b4c5d6e7f0'), '5f8a2b3c')
noLeak('Tailscale IP', sanitizeText('t', '服务器在 100.91.165.107 上'), '100.91.165.107')
noLeak('局域网IP', sanitizeText('t', '家里 192.168.5.2 的机器'), '192.168.5.2')
noLeak('宿主路径', sanitizeText('t', '代码在 /srv/feiyu-sandbox/app/tools 里'), '/srv/feiyu-sandbox')
noLeak('邮箱', sanitizeText('t', '发到 zhoux@example.com 就行'), 'zhoux@example.com')
noLeak('裸长编号', sanitizeText('t', '订单号 202611031234 别搞错'), '202611031234')

/* ─── 不该拦（负例：她的日常表达）─── */
ok('心跳毫秒数', sanitizeText('t', '心跳每 30000ms 一拍') === '心跳每 30000ms 一拍')
ok('集数和分钟', sanitizeText('t', '第 3 集看完，看了 45 分钟') === '第 3 集看完，看了 45 分钟')
ok('日期时间', sanitizeText('t', '今天 2026-11-03 02:20 睡的') === '今天 2026-11-03 02:20 睡的')
ok('13位时间戳', sanitizeText('t', '那条记录 ts=1793640479000') === '那条记录 ts=1793640479000')
ok('普通聊天', sanitizeText('t', '困死了，明天再说吧') === '困死了，明天再说吧')

/* ─── payload 形状（OneBot 出站）─── */
const p1 = { message: [{ type: 'text', data: { text: '主人QQ 3682285116' } }, { type: 'image', data: { file: 'x.jpg' } }] }
const q1 = sanitizeOutbound('test', p1)
noLeak('payload文本段', q1.message[0].data.text, '3682285116')
ok('payload图片段不动', q1.message[1].data.file === 'x.jpg')
const q2 = sanitizeOutbound('test', { message: 'QQ 3682285116' })
noLeak('payload字符串消息', q2.message, '3682285116')
const clean = { message: [{ type: 'text', data: { text: '今天好困' } }] }
ok('干净payload引用不变', sanitizeOutbound('test', clean) === clean)

/* ─── 命中留痕 ── */
ok('命中日志落盘', fs.existsSync(dataPath('sanitize-log.txt')))

console.log(`脱敏器：${pass} 过 / ${fail} 挂`)
if (fail) process.exit(1)
