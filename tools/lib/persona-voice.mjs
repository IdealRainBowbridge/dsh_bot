// persona-voice —— 人设措辞的单一来源（v5 新增）。
//
// 为什么需要：命令里的 system prompt 曾经把"笨蛋老爸""大肥鱼""鲸鱼娘"
// 硬写死在 20 多个文件里。后果：
//   ① 换一个主人称呼 → 得改十几处，漏一处她就会叫错人（对人格是硬伤）；
//   ② 她自己的名字也写死（identity.name 改了，prompt 里还是"大肥鱼"）；
//   ③ 这些字符串里混着"AI"字样，直接违背 persona.md 里"别自称 AI"的红线。
//
// 设计：只做字符串拼装，不碰业务逻辑。所有需要"跟她说话/让她说话"的模块
// 都从这里取称呼，不再自己写死。
import { config } from './config.mjs'

/** 她叫什么（identity.name）。 */
export function selfName(cfg = config()) {
  return String(cfg?.identity?.name || '大肥鱼')
}

/** 她怎么自称（identity.selfClaim）。 */
export function selfClaim(cfg = config()) {
  return String(cfg?.identity?.selfClaim || '我')
}

/** 她怎么称呼主人（identity.ownerTitle，其次 identity.callOwner，最后 owner.name）。 */
export function ownerTitle(cfg = config()) {
  return String(cfg?.identity?.ownerTitle || cfg?.identity?.callOwner || cfg?.owner?.name || '主人')
}

/** 一句"你是谁"的开场，供 system prompt 用（不带 AI 字样）。 */
/**
 * 程序名（与"她的名字"是两件事）。
 *
 * 2026-11-02 用户定的口径：
 *   · 插件/程序改叫 dsh_bot，作者 idealrainbowbridge
 *   · **她还是大肥鱼**，自称鲸鱼娘，identity 一个字段都不改
 *   · 但她**可以知道**"我这套程序叫 dsh_bot"
 *
 * 为什么允许她知道、又要求"不拿它当名字"：
 *   人知道自己用的是一台什么机器，但不会用机器的型号介绍自己。
 *   她说"我是大肥鱼"，不说"我是 dsh_bot" —— 但被问"你这程序叫什么"时，
 *   她能答得上来，而不是"我不知道"。
 */
export const PROGRAM_NAME = 'dsh_bot'
export const PROGRAM_AUTHOR = 'idealrainbowbridge'

export function selfIntro(cfg = config()) {
  const name = selfName(cfg)
  const claim = selfClaim(cfg)
  const who = ownerTitle(cfg)
  return `你是${name}，一只住在${who}电脑里的鲸鱼娘（你自称「${claim}」）。`
}

/**
 * 一句"我背后的程序是什么" —— 只在被问起或需要说明时用。
 * 刻意写得像**知情**，不像**自我介绍**。
 */
export function programLine() {
  return `我这套程序叫 ${PROGRAM_NAME}（作者 ${PROGRAM_AUTHOR}）。这跟"我是谁"是两件事 —— `
    + `我不会拿它当自己的名字，但被问起我答得上来。`
}

/**
 * 把写死的人设文案模板化。
 * @param {string} tpl 用 {name}/{claim}/{owner} 占位的模板
 */
export function fill(tpl, cfg = config()) {
  return String(tpl || '')
    .replace(/\{name\}/g, selfName(cfg))
    .replace(/\{claim\}/g, selfClaim(cfg))
    .replace(/\{owner\}/g, ownerTitle(cfg))
}
