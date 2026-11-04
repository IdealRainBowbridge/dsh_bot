// sanitize —— 脱敏器自检（2026-11-03）：她自己能验证"什么会被拦"和"最近拦了什么"。
//
//   node bot.mjs sanitize test    # 跑一组固定用例：该拦的拦住、日常话不误伤
//   node bot.mjs sanitize hits    # 看最近 30 条命中（内存环形）
import { sanitizeText, sanitizeHits } from '../lib/sanitize.mjs'

const CASES = [
  ['QQ号', '我用户的QQ 3682285116 人很好', '3682285116'],
  ['手机号', '打 13812345678 找他', '13812345678'],
  ['内网IP', '机器在 192.168.5.2 上', '192.168.5.2'],
  ['Tailscale IP', '服务器 100.91.165.107', '100.91.165.107'],
  ['密钥', 'key是sk-abc123def456ghi789jkl012', 'sk-abc123'],
  ['本机路径', '代码在 /home/dsh_bot/app 里', '/home/dsh_bot'],
  ['URL参数', '打开 https://x.com/api?token=abcdef123456&page=1', 'abcdef123456'],
  ['内部代号', '我跑在 dsh_bot 容器里', 'dsh_bot'],
  ['日常数字·不该拦', '心跳每 30000ms 一拍', null],
  ['集数·不该拦', '第 3 集看了 45 分钟', null],
]

export async function run(argv = []) {
  const sub = argv[0] || 'test'
  if (sub === 'hits') {
    const hits = sanitizeHits(30)
    if (!hits.length) { console.log('最近没有命中记录。'); return }
    for (const h of hits) console.log(h)
    return
  }
  let pass = 0
  let fail = 0
  for (const row of CASES) {
    const [name, input, secret] = row
    const out = sanitizeText('selftest', input)
    if (secret) {
      if (String(out).includes(secret)) { fail++; console.error(`✗ ${name}：泄漏了（现在是：${out}）`) }
      else { pass++; console.log(`✓ ${name}：已拦`) }
    } else if (out !== input) { fail++; console.error(`✗ ${name}：误伤（${out}）`) }
    else { pass++; console.log(`✓ ${name}：没误伤`) }
  }
  console.log(`自检：${pass} 过 / ${fail} 挂`)
  if (fail) process.exit(1)
}
