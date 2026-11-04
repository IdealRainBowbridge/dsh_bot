// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
// 设计来自 dsh-bili-whale 的 tools/lib/config.mjs（MIT），
// 默认值融合 dabot 骨架的 config.yaml（guard / preferences / 作息哲学）。
//
// 查找顺序：$BOT_CONFIG → ~/.dsh/bot.config.json → 内置默认值
import fs from 'node:fs'
import { configPath } from './paths.mjs'

export { configPath } from './paths.mjs'

/** 中性默认值：换个账号也能跑；所有"个人化"的东西请写进配置文件。 */
export const DEFAULTS = {
  webui: { proactive: { enabled: false, dailyMax: 3, minGapMin: 180, quietHours: 8 } },
  roster: { maxPeople: 500 },
  // 身份三件套（拼成一行注入提示）+ 专属人设文件（~/.data/persona.md，优先级更高）
  identity: {
    name: '理想的机械人',      // 她叫什么
    ownerTitle: '用户',  // 她怎么称呼你
    selfClaim: '我',     // 她怎么自称
  },
  // DSH 会话接管（2026-11-04）：装了这个插件，DSH 里开任何会话都是她 ——
  // 宿主自己的 system prompt（harness 身份 / "You are a coding agent" / 工具规范段）
  // 全部被一个 complete 段替换掉。工具 schemas 不受影响（它是 assemble 的独立字段）。
  // 需要拿同一个 DSH 干原生编码活时，把 enabled 改成 false 立刻回退，不用动代码。
  agent: {
    takeover: {
      enabled: true,
      // 显示在 /api/status 与面板上的"谁在当值"，纯诊断用
      label: '理想的机械人',
    },
  },
  // 你本人（分享型评论要 @ 的人）：mid 用于校验，name 用于正文 @
  owner: { mid: '', name: '' },
  // 作息（来自 bili-whale night-plan；跨零点自动处理；wakes = 每窗口醒几次，硬上限 12）
  night: {
    windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
    skipChance: 0.3,   // 30% 概率今天不想看（她也有权利不看）
    minGapMin: 10,
    maxVideos: 5,
  },
  // 口味（feed 选题的权重来源；来自 dabot 骨架的 preferences）
  preferences: {
    like: ['AI 与 Agent 工具', '鬼畜与怀旧', '猫咪', '美食（尤其是白饭相关）'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],       // 额外搜索词
  },
  // 分享标尺（来自 bili-whale：评分不够 = 今天没有值得发的，是合法结果 ✓）
  share: { enabled: true, via: 'comment', minScore: 13 },   // via: comment | dm
  // 额度（0 = 不限，随便玩；克制是活下来的前提，但这是你的鱼）
  quota: { shareDaily: 3, sameVideoDays: 7 },
  // 账本（10-26 新增）：让她自己看得到"饭钱"和额度 —— 以前她只能反复问用户。
  // 用量来自 DSH 会话日志（真实数字），折算价可在 price 里按实际账单改。
  // dailyBudget > 0 时她会按"今天超没超预算"说话；0 = 不设预算，只报花了多少。
  ledger: {
    enabled: true,
    // 2026-11-02 改：默认 0 = **预算就是余额本身**。
    // 以前写死 3 元/天，跟 a2a 真实余额完全脱节（余额 ¥1500 却只让她花 ¥3）。
    // 想人为限流时才配一个正数，它会和余额取 min。
    dailyBudget: 0,                     // 元/天，0 = 预算=余额
    mineWorkspace: 'bot-work',        // 哪个工作区的会话算"她自己吃的"（她的是 ~/.dsh/bot-work）
    price: { inputPerM: 2, cachePerM: 0.2, outputPerM: 3 },   // 元/百万 token（按 DeepSeek 档位估，可改）
    balanceUrl: '',                     // 填 https://api.deepseek.com/user/balance 且 apiKey 有效才查余额
    apiKey: '',
    balanceTimeoutMs: 8000,
    promptInQQ: true,                   // 聊天时把账本一行塞进提示语（她用不着问用户）
  },
  // 平台开关（**用户意图**，持久）。语义见 tools/lib/platforms.mjs：
  //   platforms.<id> === false → 该平台彻底关；与 <svc>.enabled 取"与"。
  // v5 起放进 DEFAULTS —— 以前它只存在于实际配置文件里，diagnose 每次报"配置多出"。
  platforms: { qq: true, wechat: false, bilibili: true },
  // 风控闸门（来自 dabot 骨架 ops/guard.py 的设计）
  guard: {
    dryRun: true,       // ⚠️ 默认干跑：只打印不真发。观察一周后再改 false
    minGapSec: 25,      // 同一"会话"两条消息最小间隔
    dupThreshold: 0.6,  // 3-gram Jaccard 超过即判复读
    banned: ['作为AI', '语言模型', '无法协助', '作为一个'],
  },
  // 日记（写日记不可关；push 留给将来的通知渠道）
  diary: { push: false },
  // 梦境（睡觉时做的梦，纯虚构、与真实记忆隔离）。v5 补进 DEFAULTS：
  // 代码里 persona.mjs / sleep.mjs 都在读 cfg.dream.*，但默认值里没有 → 老报"配置多出"。
  dream: { enabled: true, mentionChance: 0.3 },  dream: { enabled: true, mentionChance: 0.3 },
  // 内置浏览器（2026-11-02）：chromium + 纯 Node CDP 驱动，电脑/手机双身份，JS 页面也能读正文。
  browser: {
    chromiumBin: 'chromium',            // Debian 官方包；Windows 侧改成本机 chrome.exe 全路径
    proxy: 'http://172.17.0.1:7890',    // 容器里走宿主 Clash；不需要就置空
    allowPrivate: [],                   // SSRF 防护例外名单：允许访问的内网主机名
  },
  // 打小报告（看完好视频 → QQ 汇报给用户）。bili-watch / share-queue / tattle 都会读。
  tattle: { enabled: true, dailyMax: 3, minScore: 15 },
  // 自主探索（wander）：自己产生念头并执行。v5 补进 DEFAULTS。
  wander: { enabled: true, dailyMax: 2, minGapMin: 240 },

  // AI 表情包自动生成（10-25 新增）：Pollinations flux 免费无 key，直连被墙走本机 Clash。
  // QQ 回复里图库没有的标签 / 自制表情 → 异步生成入库补发；B站图片评论同源。
  // provider='siliconflow' 时用 Qwen-Image-Edit 指令式图生图（参考图锁形象，≈¥0.25/张，
  // 需填 api_key；失败自动落回 pollinations 免费兜底）。
  imageGen: {
    enabled: true,
    provider: 'pollinations',          // pollinations=免费兜底 | siliconflow=Qwen-Image-Edit（形象一致性最好）
    api_key: '',                       // 硅基流动 key（provider=siliconflow 时用）
    model: 'flux',                     // pollinations 模型；siliconflow 固定 Qwen/Qwen-Image-Edit
    dailyMax: 30,                      // 每天最多生成几张（0 = 不限），防免费档被刷限流
    proxy: 'http://127.0.0.1:7897',    // 空串 = 直连（机器能出墙时可清掉）
    refImage: '',                      // 图生图参考图（本地路径或 http 链接）——形象锚定，形象才"像"
  },

  // 视觉理解（10-25 框架就位，等视觉模型 key 点亮）：watch 自主观看截 N 帧 → 多模态描述 → 注入决策。
  // DeepSeek 的 key 不支持视觉；provider 四样全配齐才启用（provider/base_url/model/api_key），没配=静默跳过。
  vision: {
    provider: 'none',        // none=关 | openai=OpenAI 兼容 chat/completions（智谱/硅基流动/OpenAI 都走这个）
    base_url: '',            // 如 https://open.bigmodel.cn/api/paas/v4 或 https://api.siliconflow.cn/v1
    model: '',               // 如 glm-4v-plus / Qwen/Qwen2.5-VL-72B-Instruct / gpt-4o-mini
    api_key: '',             // 也可用环境变量 VISION_API_KEY
    maxFrames: 3,            // 每条视频最多喂几帧
  },

  // 专业唱歌（10-25）：RVC 翻唱——真歌干声换她的音色再混伴奏（AI 孙燕姿同款管线）。
  // 依赖 D:/rvc（RVC 仓库+venv，见 rvc.mjs）；她的歌单在 ~/.data/songs/。
  rvc: {
    root: 'D:/rvc/RVC',
    python: 'D:/rvc/venv/Scripts/python.exe',
    ffmpeg: 'D:/GPT-SoVITS/runtime/ffmpeg.exe',
  },
  sing: {
    search: true,            // QQ 点唱没学会的歌时，自动搜源歌学（yt-dlp 走代理）
    searchDaily: 3,          // 每天最多搜几首新的（0 = 不限），防跑飞
    proxy: 'http://127.0.0.1:7897',
  },

  // 统一自主规划（10-31）：**一个决策点**决定她接下来做什么。
  // 以前是四条流水线各跑各的（主动搭话/群插话/wander/focus）互相不知道对方存在；
  // 这里是单一意识层：每 minGapMin 分钟醒一次，把记忆+情绪+承诺+最近经历摊在一起，
  // 问她自己「接下来想做什么」，答案写进 focus（宿主照办）。
  // enabled=false 时行为完全回到从前（各跑各的），不改变任何老逻辑。
  mind: {
    enabled: true,
    minGapMin: 25,          // 两次规划的最小间隔（分钟）
    replanBelowMin: 5,      // 计划剩余时间低于这个就允许重规划
    respectBusy: true,      // 她在专心做事时，压掉不相干的打扰（搭话/插话）
    idleMinutes: 20,        // 如果她"没在做任何事"超过这么久，主动触发一次规划
  },
  // 完全自由（10-25 总开关）：开了之后她自己决定干什么——上网/刷B站/刷抖音/做视频/写代码/玩/歇着。
  // 唤醒走 DSH 会话（未分组那个），额度系统自动把关（作品量/评论量/分享量都还是那套额度）。
  freedom: {
    enabled: false,
    wakeEveryMin: 75,     // 每 N 分钟给一次"自由意志"唤醒机会
    chance: 0.55,         // 唤醒命中概率（她自己节奏）
    engageEveryMin: 120,  // 抖音评论区巡检间隔（完全自由模式下）
  },
  // 上网与进化（10-25）：给足自由度 —— 她在网上瞎溜达/玩/学习，甚至自我升级（备份+日志强制）。
  web: {
    roam: { enabled: false, restMin: 2 },       // 自由上网常驻（web roam --free）：每轮她自己决定干什么，轮间休息 N 分钟
    selfUpgrade: { enabled: false },            // 允许她改自己的代码（铁律：改前 selfup backup，改完测试+日志）
    proxy: 'http://127.0.0.1:7897',
  },
  personality: {
    evolve: { enabled: false, days: 2 },        // 人格进化：每 N 天一次复盘 + 更新 persona 自我迭代区
    nightly: { enabled: true, at: '23:00' },    // 每日回顾：日记 + 更新"我是谁"（改前自动存快照）+ 记账
  },

  // LLM 直连（QQ/抖音的实时响应用；B站那套塞 DSH 会话零费，这里直连按 token 计费）
  llm: {
    base_url: 'https://api.deepseek.com/v1',   // 也可换硅基流动 / Ollama / OneAPI
    api_key: '',                                // 优先读环境变量 DEEPSEEK_API_KEY；也可直接写这里
    model: 'deepseek-chat',
    temperature: 0.92,
    max_tokens: 600,
    // 写脚本/文案用另一套参数（dabot 的设计：聊天口癖别污染内容）
    content_model: 'deepseek-chat',
    content_temperature: 0.7,
  },

  // QQ（OneBot v11 网关：SnowLuma / NapCat 通用）
  qq: {
    enabled: false,
    // 随 DSH 自启（false = 只在面板上手动点开）。代码里有 4 处读它，
    // 缺省必须是显式 false —— undefined 会让"没配"和"配了 false"分不出来。
    startWithDsh: false,
    // v5 入口鉴权：空 = 只接受本机回环（跨容器/局域网一律 401）；
    // 填了值就强制校验（Authorization: Bearer / X-Bot-Token / ?token=）。
    // 想给微信桥或外部脚本调用，就在这里发一个 token，别把服务裸奔在 0.0.0.0 上。
    inboundToken: '',
    napcat_http: 'http://127.0.0.1:3000',   // OneBot HTTP 服务器地址（SnowLuma/NapCat 的 WebUI 里配置）
    allow_groups: [],                        // 空 = 全部群
    at_only: true,                           // 群里只被 @ 才回；设 false = 群里所有消息都回（像私聊一样）
    voice_enabled: false,                    // 语音条开关
    voice_chance: 0.15,                      // 回复用语音的概率
    voice_maxChars: 60,                      // 每条语音最多念多少字（真人发语音不会一口气念一大段）
    voice_parts: 2,                          // 一条回复最多切几条语音，没念完的走文字
    stickerChance: 0.5,                      // 回复带图片表情的概率（摇中强制带一个，10-25）
    sing: true,                              // 唱歌开关（"唱一首"触发：LLM 写词+她的音色逐句+鼓点混音）
    qzone_enabled: false,                    // 发空间说说开关
    // 主动搭话（B站同款自主性）：用户安静久了她会带着由头主动开口。
    // 随机拟人不定点；正聊着不打扰；每天有上限 —— 宁可少说不刷屏。
    proactive: {
      enabled: false,
      dailyMax: 3,          // 每天最多主动找用户几次（0 = 不限）
      minQuietMin: 90,      // 用户安静至少这么久才开口（最近在聊就别插话）
      minGapMin: 150,       // 两次主动之间的最小间隔
      startupGraceMin: 10,  // 进程起来头 N 分钟不发（10-25：重启就"你消失四天"的根在这）
      typeCooldownMin: 180, // 同一类型（心情/日常/疑惑…）N 分钟内不重复
      similarityMax: 0.25,  // 跟 6 小时内任一条 3-gram 相似度超这个就不发（换措辞重复也算重）
      activeHours: [10, 23],// 活跃时段（10:00~23:00 之外不打扰）；null = 不限时（10-25 用户拍板可关）
      chance: 0.12,         // 每 60s tick 命中概率（不定点闹钟，随机开口）
      // ── v5：全局主动发言闸门（三条主动通道共用一张账）────────────────────
      // 治"一小时内连发 6 条、其中 4 条在接自己的话"。以前这四个键只写在
      // proactive-gate.mjs 的注释里，DEFAULTS 没有 → diagnose 天天报配置缺项。
      globalGapMin: 45,     // 任意两条主动消息的最小间隔（分钟）
      globalDailyMax: 8,    // 全局每天最多主动发几条（0 = 不限）
      maxStreak: 2,         // 用户没说话时最多连发几条（专治自言自语）
      ownerActiveMin: 3,    // 用户刚说过话的 N 分钟内不许插嘴
    },
    // 统一通道（10-31；v5 补进 DEFAULTS）。语义见 tools/lib/channel.mjs。
    channel: {
      debounceMs: 900,       // 同会话合并窗口：他连发几条当成一句说完
      maxConcurrency: 4,     // 全局并行会话数
      ttlMs: 600000,         // 排队超过 10 分钟就丢（不答隔夜话）
      maxQueuePerChat: 20,   // 单会话最多积压
      maxMerge: 6,           // 一次最多合并几条
    },
    // 接话判断（10-31；v5 补进 DEFAULTS）。见 tools/lib/reply-gate.mjs。
    replyGate: {
      enabled: true,         // false = 退回"每条必回"
      minDelayMs: 1200,      // 停顿下界
      maxDelayMs: 4200,      // 停顿上界
      callDelayMin: 900,     // 呼叫语（在吗）快回
      callDelayMax: 1600,
      imageDelayMin: 1200,   // 发图给个短反应
      imageDelayMax: 2600,
      contextLines: 6,       // 判"要不要接"时带几行上下文
    },
    // 群聊自主插话（10-25）：不等 @，她自己看着群聊决定要不要接话。
    // 趁话题正热（recentSec 内有人说话）+ 稍微等一下（minQuietSec 不抢话）+ 概率 + 双额度。
    groupChat: {
      enabled: true,
      recentSec: 600,       // 群里最近这么久有人说话才算"话题在场"
      minQuietSec: 20,      // 最后一条消息至少隔这么久（不抢话）
      minGapMin: 20,        // 同一个群两次插话最小间隔
      dailyMax: 6,          // 每个群每天最多插话几次（0 = 不限）
      chance: 0.1,          // 每 60s tick 命中概率
      recentN: 14,          // 决策时喂最近几条群聊
    },
    // 自主写说说（10-25）：她自己的见闻+心情 → 攒着劲发 QQ 空间说说（可文配图，图生图鲸鱼娘）。
    qzoneAuto: {
      enabled: true,
      dailyMax: 2,          // 每天最多发几条（0 = 不限）
      minGapMin: 240,       // 两条说说最小间隔（分钟）
      chance: 0.15,         // 每 30 分钟 tick 命中概率
      imageChance: 0.5,     // 配图概率
    },
  },

  // 微信（wechat-bot 桥；10-25 起本机停用，但默认值必须补齐 ——
  // 以前 DEFAULTS 缺这一整段，新装机/配置被清空时 cfg.wechat.* 全 undefined：
  // 自制贴纸（stickers.mjs 取 cfg.wechat.python）恒返 null、面板合并窗口/上下文条数落回硬编码。
  wechat: {
    enabled: false,
    startWithDsh: false,
    python: 'D:/wechat-bot/.venv/Scripts/python.exe',
    script: 'D:/wechat-bot/wechat_bot.py',
    owner_nickname: '',                       // 用户在微信里的昵称（认人用）
    at_only: true,
    voice_enabled: false,
    voice_chance: 0.15,                       // 与 qq.voice_chance / config 默认对齐（面板别自造默认值）
    rhythm: 'fast',                           // fast | slow
    merge_window_sec: 3,                      // 连续消息合并窗口
    merge_max_wait_sec: 12,                   // 合并最长等待
    context_n: 12,                            // 上下文条数
    smart_skip: true,                         // 智能跳过（群里没被叫就不插话）
    max_replies_per_min: 8,                   // 每分钟最多回几条（防刷屏）
  },

  // 语音（GPT-SoVITS 本地音色克隆；xiaoxiao 音色）
  voice: {
    sovits_url: 'http://127.0.0.1:9880/tts',  // GPT-SoVITS api_v2.py 的 tts 端点
    ref_audio_path: '',                       // 参考音频绝对路径（可选）
    prompt_text: '今天也要好好吃饭',           // 参考文本
    prompt_lang: 'zh',
    text_lang: 'zh',
    media_type: 'wav',
    streaming_mode: false,
    // 语音服务（GPT-SoVITS）随 DSH 自动拉起，避免"有开关没声音"
    autoStartSovits: true,
    sovitsCmd: 'D:/GPT-SoVITS/.venv/Scripts/python.exe',
    sovitsScript: 'D:/GPT-SoVITS/api_v2.py',
    // ---- 情绪三层（10-26：用户说"语音只有略微的语气变化，没有人类情感"）----
    // L0 参数 + 择优
    text_split_method: 'cut0',   // 不按标点切碎，保留跨句韵律（实测起伏 3.96 → 4.43）
    candidates: 3,               // 一条语音合成几条候选、按韵律分挑最好的（1 = 关掉择优）
    pick: 'best',                // best | first（first 等于关掉择优，快但会抽奖）
    maxSynthPerMessage: 9,       // 单条消息最多调几次合成（长文本分块 × 候选数，别让它无限涨）
    chunkChars: 80,              // 超过这么多字先分块再合成
    chunkGapSec: 0.18,           // 分块之间的停顿（真人说话本来就有停顿）
    python: '',                  // 韵律打分用的解释器，留空用 sovitsCmd（那边一定有 librosa）
  },


  // ── B站社交日报（第 17 轮，用户："除了@我的其它我都不知道发生了什么"）────────
  // 每天到点把她"没 @ 用户"的发言/动作摘要推一条 QQ；没动静就不推（不制造噪音）。
  socialDigest: { enabled: true, at: '23:30', min: 3 },

  // ── 视频生产（第 17 轮）：真剪辑的片子，不再是"一张图+旁白" ──────────────────
  // frames：每一幕生成几帧（2 = 幕内两帧交叉淡入，画面会"动"；1 = 省一半生图钱）
  // bgm：auto = 本地合成一条垫底配乐（不碰版权）｜none = 不要｜<wav 路径> = 用自己的
  // biliProduce：B站视频额度（0 = 不限）；bili.tid 是投稿分区（21 = 生活·日常）
  video: {
    platform: 'bili',
    frames: 2,
    bgm: 'auto',
    ffmpeg: '',
    ffprobe: '',
    font: '',
    biliProduce: { enabled: true, dailyMax: 2 },
    bili: { tid: 21, tname: '生活·日常' },
    // ── 真动作镜头（10-27）：万相 2.7 图生视频，首帧 = 她那张图，人物真的会动 ──
    // 走 llm 那条中转站的 DashScope 原生路径（同一个 key），失败/关掉自动落回静图+运镜。
    //   maxSeconds：单段上限（万相只收 2~15 的整数，超了就自动切段 + 用上段末帧续首帧）
    //   pricePerSecond / budgetPerRun：只用来估算和刹车，真实单价去后台核完填进来
    //   resolution：720P | 1080P（是"像素档位"，输出宽高比跟着首帧走）
    animate: {
      enabled: true,
      baseUrl: '',                          // 空 = 从 llm.base_url 剥 host；也可写 https://dashscope.aliyuncs.com
      apiKey: '',                           // 空 = 用 llm.api_key
      model: 'wan2.7-i2v-2026-04-25',
      resolution: '1080P',
      maxSeconds: 15,
      negative: '',                         // 空 = 内置那串（防换人/防字幕/防崩脸）
      pricePerSecond: 0.35,                 // 元/秒（估算用）
      budgetPerRun: 20,                     // 一条片子最多花多少（元），0 = 不限
      pollSec: 8,
      maxWaitSec: 420,
      keepRaw: true,                        // 留着模型原片（含它的音轨）方便对比，成片里绝不使用
      retries: 1,
    },
  },

  // B站（生物钟在 night 段；这里放自由刷的限度 + 活人感写通道）
  bilibili: {
    // 自由刷：评论区 @ 用户那套。unlimited=true 不限条数/时长，刷到每日分享额度用完或手动停。
    freeRoam: { enabled: false, unlimited: true, maxVideos: 0, maxMinutes: 0, restMin: 5 },
    // 观看历史上报（debrief 后记入历史）
    reportHistory: true,
    // ── 活人感写通道（默认全关：养好号再开；每项独立开关 + 日额度 bili-actions.json，0 = 不限）──
    danmaku: { enabled: false, dailyMax: 5 },                       // 看视频发弹幕（bili-watch 顺手 / act 命令）
    dynamic: { enabled: false, dailyMax: 2, times: ['09:30', '21:30'] }, // 潜水日志动态（早晚定时 + 复盘后同步）
    react: { like: false, coin: false, likeDaily: 10, coinDaily: 1 },// 点赞（debrief 顺手）/投币（评分≥17）
    imageComment: { enabled: false, dailyMax: 2 },                  // 图片评论（贴纸/生图 → B站图床）
    replies: { enabled: false, dailyMax: 10 },                      // 回应别人对我评论的回复（replies 命令）
    fishCircle: { enabled: false },                                 // 鱼圈社交：选题加入「理想的机械人」相关视频
    follow: { enabled: false },                                     // 关注好 UP（act follow）
  },

  // ── 脑（v3，10-29）：记忆/注意力/意图/元认知那套 ─────────────────────────
  // mode 三档：off=完全不写（纯旧行为）｜shadow=只写不读（默认，先对照一周）｜live=新装配接管
  // livePlatforms/liveChats/liveGroups 决定谁能走新装配：私聊按平台切，群聊必须逐群列进 liveGroups。
  brain: {
    enabled: true,
    mode: 'shadow',                 // shadow | live | off
    livePlatforms: ['qq', 'douyin-dm'], // live 时切哪些通道的私聊
    liveChats: [],                  // 空 = livePlatforms 里的私聊全切；填了就只切这几个 chatId
    liveGroups: [],                 // 群聊要逐群切（群里的对照最要紧）：填 chatId 才走新装配
    executor: 'promises',           // promises=旧账本执行 | intents=脑的意图账本执行（S4）
    ownerIds: [],                   // 用户 QQ/uid（空 = 私聊一律当用户；群友永远不是用户）
    consolidateAt: '04:30',         // 每天巩固时刻（睡过头靠 shouldConsolidate + 子进程补）
    budget: { promptChars: 5650, consolidateCalls: 6, consolidateTokens: 40000 },
    recall: { weights: {} },        // 空 = 用 brain/recall.mjs 的校准值（10-29 量过：Recall@6 0.875）
    claim: { enabled: true },       // 声称-证据闸（只在 live 模式下真的改口）
    selfcon: {                      // 自我账本（2026-11-03, 设计稿 v1）: 名字/形象/腔调由记忆生长
      enabled: true,
      shadow: true,                 // 影子期: REM 巩固只写日志不动账本, 观察 3 天后改 false 切真
    },
    wechatIsolated: true,           // 微信独立代理：不写、不读、不进叙事（I7）
    task: { enabled: true, pollSec: 20, maxPerTick: 1 }, // 身体/工具协议：认领队列里的活
  },
}

/**
 * 深合并：base 打底，over 覆盖。
 *
 * ⚠️ v5 修的一个隐蔽大 bug：旧实现是 `const out = { ...base }` —— **只浅拷贝顶层**。
 * 于是 over 里没有覆盖到的嵌套对象（guard / qq / llm / brain …）全都是
 * DEFAULTS 里**同一个对象的引用**。任何调用方只要写一句
 *     const cfg = config(); cfg.guard.dryRun = false
 * 就会把模块级的 DEFAULTS.guard.dryRun 永久改成 false ——
 * 之后同一个进程里每一次 config() 拿到的 dryRun 都是 false，
 * 即使配置文件里根本没写这一项、即使把配置文件删掉重读也一样。
 *
 * 现场表现：面板改一项设置后，某些"没动过"的默认值突然不再恢复；
 * 跑一轮测试后再跑业务，行为跟前一轮不一样（测试污染了默认值）。
 * 这类问题最难查 —— 因为每次单独复现都正常，只有"先跑过别的"才出错。
 *
 * 修法：递归时**复制** base 的每个嵌套对象（structuredClone 语义），
 * 保证 DEFAULTS 永远是只读常量，谁也改不到。
 */
const cloneDeep = (v) => {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(cloneDeep)
  // 只处理普通对象（配置里不会有 Date/Map 之类）
  const out = {}
  for (const [k, x] of Object.entries(v)) out[k] = cloneDeep(x)
  return out
}

const merge = (base, over) => {
  const out = cloneDeep(base)
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v))
      ? merge(base?.[k] ?? {}, v)
      : cloneDeep(v)
  }
  return out
}

/** 读取合并后的配置（不缓存：改完保存立刻生效 —— bili-whale 的实战要求）。 */
export function config() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) } catch { /* 没配置就用默认 */ }
  const cfg = merge(DEFAULTS, user)
  cfg.__hasUserFile = Object.keys(user).length > 0
  return cfg
}
