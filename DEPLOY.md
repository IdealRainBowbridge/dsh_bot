# 部署与依赖清单（dsh_bot v0.4.0）

> 这份文档回答一个问题：**要复现这只理想的机械人，需要装什么、什么版本、放在哪、怎么验证**。
> 版本号取自 2026-10-25 实际跑通的那台机器（Windows 11 / x64 / RTX 显卡）。

> **⚠ 存档说明（2026-11-03）**：本文是 Windows 时代的装机清单，与当前生产环境已不一致——
> 现役部署是 **Arch 宿主 + docker 容器 `dsh_bot`**。逐组件版本仍可作选型参考，
> 当前实况见文末「当前部署实况」。

---

## 一、最小可用集（只聊天，不做语音/生图/视频）

| 组件 | 版本 | 用途 | 位置 / 获取 |
|---|---|---|---|
| **DSH 桌面端** | `0.2.1-rc.2`（`@deepseek-ai/dsh-desktop-runtime`） | 宿主：会话、系统提示、设置面板、模型 | 官方安装包 |
| **Node.js** | `v24.21.0` | 工具链运行时（DSH 自带一份同版本） | DSH 运行时自带：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/` |
| **DeepSeek API** | `deepseek-chat`（`https://api.deepseek.com/v1`） | QQ / 抖音私信 / 微信 的实时对话 | 充值后填 `llm.api_key` |
| **B站凭据** | Cookie（`SESSDATA` + `bili_jct` + `buvid3`） | B站刷视频/评论 | 浏览器 F12 → Application → Cookies |
| **本插件** | `0.4.0` | 就是本仓库 | `dsh plugin --profile desktop add "link:<repo>"` |
| **内置浏览器**（可选） | `chromium 156`（Debian 官方包）+ `fonts-noto-cjk` | `browser read / browse_page`：JS 渲染页读正文、手机/电脑双身份、截图 | 容器里 `apt install --no-install-recommends chromium fonts-noto-cjk`；Windows 侧把 `browser.chromiumBin` 指向本机 chrome.exe |

装完即可用：B站刷视频、QQ 聊天（无表情包/无语音）、记忆、面板。

---

## 二、QQ 通道（SnowLuma）

| 组件 | 版本 | 说明 |
|---|---|---|
| **QQNT 客户端** | `9.9.20-36330`（内置 `qqnt.json` 目标 `9.9.22-40990`） | SnowLuma 注入宿主 |
| **SnowLumaQQ** | **`SnowLuma.Onebot 4.18.41`**（OneBot **v11**） | 通过 `SnowLumaWinBootHook.dll` + `SnowLumaWinBootMain.exe` 注入 |
| 启动方式 | `D:\snowluma\launcher-user.bat`（需管理员） | 本插件注册计划任务 `DSH-Feiyu-SnowLuma`（`RunLevel Highest`），随 DSH 起停 |
| HTTP 上报 | `http://127.0.0.1:8080/onebot`，`messagePostFormat=array` | qq-server 的入口 |
| 验证 | `curl http://127.0.0.1:3000/get_version_info` | 应返回 `"app_version":"4.18.41"` |

> SnowLuma 挂了的表现：`/health` 里 `snowluma.ok=false`、`qq-server.log` 每 30s 报「网关不通」。
> 修复：`schtasks /Run /TN "DSH-Feiyu-SnowLuma"`（不用 UAC 交互）。

---

## 三、抖音通道

| 组件 | 版本 | 说明 |
|---|---|---|
| **Python** | `3.12.0`（独立 venv） | `D:\social-auto-upload\.venv\Scripts\python.exe` |
| **patchright** | `1.58.2` | 反检测版 Playwright，抖音用 `patchright.async_api` |
| **requests** | `2.32.3` | 下载/上传 |
| **loguru** | `0.7.3` | 日志 |
| **opencv-python** / **numpy** | venv 自带（numpy 1.x） | 视频帧处理 |
| **qrcode** / **segno** | venv 自带 | 扫码登录 |
| **social-auto-upload** | 本机包（`social_auto_upload`） | 抖音页面上传/互动骨架 |
| **Chrome** | `156.0.8078.47` | patchright 用它的内核；CDP 模式用 `--remote-debugging-port=9222` |

脚本：`douyin_interact.py`（子命令 `feed / comments / comment / reply / comment-reply / self-info / my-videos / dm-send / dm-read / dm-list / login / cdp-start`）

> 登录态：`~/.data/douyin-cookies.json`；当前登录号 **顾思苡**（`sec_uid` 由 `feiyu douyin self` 读出并缓存到 `~/.data/douyin-self.json`）。

---

## 四、微信通道

| 组件 | 版本 | 说明 |
|---|---|---|
| **Python** | `3.12.0`（独立 venv） | `D:\wechat-bot\.venv\Scripts\python.exe` |
| **微信 PC 客户端** | 4.x（UI 自动化） | — |
| **uiautomation** | `2.0.29` | 读窗口控件、点按输入 |
| **comtypes** | `1.4.17` + **pywin32** `312` | COM / 窗口句柄 |
| **psutil** | `7.2.2` | 进程探活 |
| **Pillow** | `13.0.0` | 图片消息 |

脚本：`D:\wechat-bot\wechat_bot.py`（本仓库 `wechat/` 下有副本，运行的是 `D:\wechat-bot\` 那份）

---

## 五、语音（说话 / 语音条）

### 现状：whale-tts（Arch 主机，2026-11-04 上线）

| 组件 | 位置 / 版本 | 说明 |
|---|---|---|
| **whale-tts** | `/opt/whale-tts/server.py`，`whale-tts.service`（enabled，`Restart=always`） | 监听 `0.0.0.0:9880`，**GPT-SoVITS `api_v2` 的 `/tts` 接口兼容**，调用方零改动 |
| 引擎 | `edge-tts` 7.3.1 + `zh-CN-XiaoyiNeural` | 独立 venv（`/opt/whale-tts/.venv`，Python 3.12），不碰系统 Python |
| 音高标定 | `pitch_base = 0Hz` → F0 中位 **≈291 Hz** | 与「DeepSeek鲸鱼娘在运营」Day1 旁白实测 291Hz 对齐；情绪层只做 ±10Hz 内偏移 |
| 参数映射 | `temperature`（唤醒度 1.25–1.50）→ pitch；`speed_factor` → rate；`fragment_interval` → 句间静音 | 与 `tools/lib/emotion.mjs` 的 9 种情绪一一对应 |
| 输出 | 24 kHz 单声道 PCM16 WAV，峰值归一 0.89，句间停顿可配 | `dsh_bot` 的 `concatWav`/`prosody` 只接受 16bit PCM，正好对上 |
| 访问栅栏 | 只接受 `127.0.0.0/8`、`::1`、`172.16.0.0/12`（docker 网桥） | LAN `192.168.5.2:9880` 与 tailnet `100.91.165.107:9880` 实测 403 |
| 缓存 | `/opt/whale-tts/cache`（LRU，默认 300 条） | 同文本同参数直接命中；实测 6 秒音频 ≈240 KB |
| 安装/更新 | `bash /opt/whale-tts/install.sh`（幂等） | 建 venv → 装包 → 写 unit → 重启 → health + 合成自检 |
| 日志 | `journalctl -u whale-tts` | 每条约一行：参数、句数、时长、文本前 24 字 |

### 换声：whale-rvc（2026-11-04 追加）

`edge-tts` 只有 4 个中文女声，音色天花板在那里。加一层 RVC 把输出换成「理想的机械人」音色。

| 组件 | 位置 / 版本 | 说明 |
|---|---|---|
| **whale-rvc** | `/opt/whale-rvc/rvc_server.py`，`whale-rvc.service`（enabled） | 监听 `0.0.0.0:9881`，**常驻**（模型只加载一次，省掉每次 5 秒冷启动） |
| 引擎 | Applio（`/opt/whale-rvc/Applio`，git clone 上游） | 底模 `rmvpe.pt`(181MB) + `contentvec`(378MB)，来自 `huggingface.co/IAHispano/Applio`，**必须走 7890 代理**（HF 直连 000） |
| 声库 | `FeiyuVoice-RVC-v1.pth`(52MB) + `.index`(30MB) | 星落落授权的那条 SSR 理想的机械人，sha256 与包内 `manifest.json` 一致 |
| 推理 | torch 2.15.0+**cpu** | GTX 1050 是 Pascal sm_61 且只有 2GB，装 CUDA 轮子不划算；CPU 4 线程实测 **8 秒音频 ≈ 13 秒**（1.6× 实时） |
| 参数 | `index_rate=0.3`、`protect=0.33`、`f0=rmvpe`、`pitch=0` | 取自模型包 manifest；**音高 100% 跟随输入**（实测 381Hz 进 381Hz 出），只改音色 |
| 访问栅栏 | 与 whale-tts 同一套（回环 + docker 网桥） | LAN `192.168.5.2:9881` 与 tailnet 实测 403 |
| 安装/更新 | `bash /opt/whale-rvc/install.sh`（幂等） | 拉 Applio → 补底模 → 装依赖 → 写 unit → 预热 |
| 日志 | `journalctl -u whale-rvc` | 每条：输入/输出大小、pitch、耗时 |

**为什么常驻**：Applio 的 `infer.py` 每次调用都要 import torch + 加载 contentvec/rmvpe +
权重，冷启动 5 秒。做成 HTTP 服务后 `VoiceConverter` 只在首个请求加载（实测 4.6–5.0 秒），
之后每次只付推理时间。

**接线方式**：`whale-tts` 合成完把 WAV 直接 POST 到 `whale-rvc/convert`，拿回换声后的
WAV 再返回给 `dsh_bot`。失败一律回落原声（换声是加分项，不能因为 RVC 挂了整条语音丢掉）。

延迟实测（8 秒的话）：edge 合成 2 秒 + RVC 13 秒 ≈ **15 秒**；4 秒的话 ≈ 10.5 秒。
缓存命中 0 秒（缓存键里含 `rvc:开/关` 与模型标识，关掉换声不会命中已换声的旧条目）。

关掉换声：`systemctl stop whale-rvc`（whale-tts 会自动回落），或
`WHALE_RVC=0` 写进 `/etc/systemd/system/whale-tts.service.d/` 的 Environment。

配置（`~/.dsh/bot.config.json`，容器内 `/home/dsh/.dsh/`）：

```json
"voice": { "sovits_url": "http://172.17.0.1:9880/tts", "autoStartSovits": false,
           "candidates": 1, "pick": "first", "chunkChars": 80 },
"qq":    { "voice_enabled": true, "voice_chance": 0.35 }
```

- `autoStartSovits=false`：宿主没有 GPT-SoVITS 可拉，留着只会每次探活空转。
- `candidates=1 / pick=first`：edge-tts 是确定性的，同一句话合两遍逐样本一致，择优纯属浪费。
- 调用链：`qq-server` 摇中语音 → `lib/tts.mjs` POST `172.17.0.1:9880/tts` → 得 wav → **base64** → SnowLuma 转 silk → QQ。

### 发送段（2026-11-04 修）

`{ "type": "record", "data": { "file": "base64://..." } }`

以前直接传容器内绝对路径。发消息的是**宿主上的 SnowLuma**，它 `stat` 不到 `/home/dsh/.data/voice/*.wav`，
于是每条语音都以 `EACCES` 收场 —— 日志里只有一句「语音失败（剩下转文字）」，看着像没配语音。
表情包 2026-11-02 踩过同一个坑并用 base64 解决，语音这条路径当时漏了。现在 `qq-server` 的三处
`record` 发送（聊天语音、两种唱歌）与 `voice`/`sing` 命令统一走 `tools/lib/onebot-file.mjs` 的 `onebotFileValue()`。

### 旧方案：GPT-SoVITS（Windows 本机，arch 主机上不可用）

| 组件 | 版本 | 说明 |
|---|---|---|
| **GPT-SoVITS** | commit `b4570b8`（2026-10-19，API v2 语义流式切分） | `D:\GPT-SoVITS`，只在 Windows 本机 |
| 关键依赖 | `numpy<2.0`、`librosa==0.10.2`、`pytorch-lightning>=2.4`、`gradio<5`、`ffmpeg-python` | 见 `requirements-tts.txt` |
| API 服务 | `api_v2.py` → `http://127.0.0.1:9880/tts` | 插件启动时自动拉起 + 每 60s 探活（`autoStartSovits`） |
| 零样本参考音 | `D:\GPT-SoVITS\models\yinlang\yinlang.wav`（+ `prompt_text`/`prompt_lang`） | Windows 部署时配的就是它 |
| 训练权重（可选） | `models\sunshine_girl\{sunshine_girl.ckpt, .pth}` | 训练过的音色，换成 `sovits_path`/`gpt_path` |

保留原因：`tools/lib/rvc.mjs`（唱歌换声 / 训练她自己的音色）仍然依赖 Windows 上的 RVC，`voice train` 也走它。
**要回到 SoVITS**：把 `sovits_url` 指回 `127.0.0.1:9880`、`autoStartSovits=true`，`whale-tts` 停掉即可 —— 两者接口同形，互为替换。

---

## 六、唱歌（原创 / 翻唱）

**诚实说明**：GPT-SoVITS 是**说话**引擎，不是歌声合成（本机没装 SVC 引擎）。所以：

| 模式 | 实现 | 命令 |
|---|---|---|
| **原创** | 用 GPT-SoVITS 按"说唱/旋律"的节奏念白式合成 + WAV 拼接调音（`lib/sing.mjs` 自带 RIFF/PCM16 读写） | `feiyu sing "主题"` |
| **翻唱** | 真歌 → **yt-dlp** 取音轨 → **ffmpeg** 转 44.1k 双声道 → **RVC** 换她的音色 → ffmpeg 混回伴奏 | `feiyu sing cover "歌名"` |

| 组件 | 版本 | 位置 |
|---|---|---|
| **RVC（Retrieval-based-Voice-Conversion-WebUI）** | 本机部署（含 realtime VST 变体目录） | `D:\rvc\RVC` |
| Python | `3.12.0`（venv：`D:\rvc\venv`） | — |
| **torch / torchaudio** | `2.7.1+cu128` | CUDA 12.8 |
| **faiss-cpu** | `1.15.1` | 检索索引 |
| **librosa** | `0.10.2.post1` | 特征 |
| **numpy** | `1.26.4` | — |
| **soundfile** | `0.14.0` | 读写 |
| **praat-parselmouth** | `0.4.7` | F0 |
| **yt-dlp** | `2026.10.21` | 取源歌 |
| **ffmpeg** | `7.1-essentials_build-ghyan`（GPT-SoVITS 自带） | `D:\GPT-SoVITS\runtime\ffmpeg.exe` |
| **ffprobe** | RVC 自带 | `D:\rvc\bin\ffprobe.exe` |
| 她的音色模型 | `D:\rvc\RVC\assets\weights\feiyu-rose.pth`（+ `_e50/_e100/_e125/_e150` 各轮次） | v2 40k |
| 底模 | `assets\pretrained_v2\{f0G40k,f0D40k,f0G48k,f0D48k}.pth` | RVC 预训练 |

产物落在她的工作目录，可直接发 QQ（`sendQQ` 用 SnowLuma `record` 段）。

---

## 七、生图 / 表情包

| 用途 | 模型 / 服务 | 版本或标识 | 归属 |
|---|---|---|---|
| **形象锁定编辑**（表情包、视频分镜） | `Qwen/Qwen-Image-Edit-2509` | 硅基流动 API | `imageGen.model` |
| **兜底文生图**（不进图库） | `flux`（Pollinations） | `image.pollinations.ai` | 免费、无需 key |
| **视觉理解**（看图说话、判断形象是否一致） | `Qwen/Qwen3-VL-8B-Instruct` | 硅基流动 API | `vision.model` |
| 参考图上传（Pollinations 需要公网 URL） | `tmpfiles.org` API | — | 60 分钟过期自动重传 |
| 本地文字贴纸 | Pillow 画的 PNG | `tools/lib/sticker_render.py` | 不联网 |

**根本形象链**：`~/.data/sticker-ref.jpg` + `sticker-refs/ref-{哭,举手,得意,微笑}.jpg`（按文案情绪自动挑）→ 硅基 `images/generations`（`image: <dataURI>`）→ 存 `~/.data/stickers/<标签>/sf-*.jpg`

规则（写进代码了）：

- `sf-*` = 硅基 + 参考图 → **只发这种**
- `px-*` = Pollinations 兜底 → **永不入库、永不发送**
- `pickSticker()` 过滤 `px-`；`autoTag()` 认不出情绪只在「开心/无语/比心」里选

成本参考：`≈¥0.25/张`（1024px，带中文气泡）。

---

## 八、做视频（produce 投稿包）

| 环节 | 实现 | 依赖 |
|---|---|---|
| 1. 策划 | DeepSeek `deepseek-chat` 出脚本/分镜 | `llm` |
| 2. 配图 | 硅基 `Qwen-Image-Edit-2509`（锁她的形象）× N 张 | `imageGen` |
| 3. 旁白 | GPT-SoVITS `/tts` 念旁白（她的音色） | `voice` |
| 4. 成片 | **ffmpeg** 图片序列 + 音频 → mp4 | `D:\GPT-SoVITS\runtime\ffmpeg.exe` |
| 5. 落地 | `~/.data/douyin-posts/<日期-标题>/`（`img-*.jpg` + `narration.wav` + `video.mp4` + 文案） | — |
| 6. 发布 | **她不能自己发** —— 成片等你在面板点发布 | 设计如此 |

```bash
node tools/bot.mjs produce ["主题"]     # 每天有额度（douyin.produce.dailyMax）
```

---

## 九、上网（她自己的手脚）

| 组件 | 版本/端点 | 说明 |
|---|---|---|
| 搜索引擎 | Bing（`cn.bing.com`）+ DuckDuckGo（`html.duckduckgo.com`） | 双源兜底，抓不到就换 |
| 网页抓取 | `fetch` + 本地代理 | Clash `http://127.0.0.1:7897` |
| 常驻进程 | `bot.mjs web roam`（`web.roam.enabled`） | 完全自由开着时死了自动拉起（60s） |
| 记忆 | 搜索/读页/写小说/自我升级 全部 `remember(platform=web)` | 面板可见、可作为她的"行为记忆" |

---

## 十、端口一览

| 端口 | 谁 | 必需 |
|---|---|---|
| `8080` | `qq-server`（OneBot 上报入口） | QQ 通道 |
| `8095` | `douyin-dm-server`（抖音私信陪聊） | 抖音私信 |
| `3000` | SnowLuma HTTP | QQ 通道 |
| `9880` | GPT-SoVITS `api_v2.py` | 语音 / 唱歌 / 视频旁白 |
| `9222` | Chrome CDP（可选，抖音真发评论用） | 可选 |
| `7897` | Clash / 系统代理 | 生图兜底、上网 |
| `65466` | DSH Web GUI（每次重启会变） | — |

---

## 十一、安装顺序（照这个走不会卡）

```powershell
# 0) 前置：DSH 桌面端 + Node 24（DSH 自带）+ Python 3.12 ×3 个 venv

# 1) 插件
dsh plugin --profile desktop add "link:D:\dsh_bot"
#    重启 DSH → 设置里出现「🐟 理想的机械人」

# 2) 最小配置 ~/.dsh/feiyu.config.json
#    identity / owner.qq / llm.api_key  → 面板里填也行

# 3) B站凭据
#    浏览器 F12 拷贝 SESSDATA/bili_jct/buvid3 → POST /dsh_bot/api/cookie
node tools/bot.mjs nav            # 验证登录态
node tools/bot.mjs selftest       # 全量体检

# 4) QQ
#    装 QQNT 9.9.20+ → SnowLuma 注入（管理员）→ 面板点「启动 QQ 服务」
#    curl http://127.0.0.1:3000/get_version_info   # 看 4.18.41

# 5) 抖音
D:\social-auto-upload\.venv\Scripts\python.exe douyin_interact.py login
node tools/bot.mjs douyin self     # 记下自己的 sec_uid
node tools/bot.mjs douyin my-videos

# 6) 语音（可选）
#    GPT-SoVITS 装好 → python api_v2.py（9880）→ 面板「音色」试听
node tools/bot.mjs voice list

# 7) 唱歌（可选）
#    RVC 装好 → assets/weights 放她的 .pth → 确认 ffmpeg/ffprobe 路径
node tools/bot.mjs sing cover "天黑黑" --dry

# 8) 生图 / 表情包（可选）
#    硅基 key → imageGen.api_key；参考图 → ~/.data/sticker-ref.jpg
node tools/bot.mjs sticker gen "本鱼饿了" --tag 开心

# 9) 最后开自主行为
#    面板：完全自由 ON、每日回顾 ON、主动搭话 ON、干跑 OFF
```

验证清单（一条条打勾即可）：

```powershell
node tools/bot.mjs selftest                 # 全绿
curl http://127.0.0.1:8080/health             # snowluma.ok=true
curl http://127.0.0.1:8095/health             # failStreak=0
node tools/bot.mjs mem stats                # episodes/facts/lore 都有数
node tools/bot.mjs mem recallall --chat qq:<你的号>   # 跨通道记忆块能装配出来
npm test                                      # 8 套测试全过
```

---

## 十二、模型/服务一览（改配置时对照）

| 配置键 | 当前值 | 作用 | 换掉会怎样 |
|---|---|---|---|
| `llm.model` | `deepseek-v4.1-flash-1017` | 所有实时对话 | 关掉 `params.enable_thinking` 会慢 3~14 倍 |
| `llm.base_url` | `https://maas.qianwenaiapi.com/compatible-mode/v1` | OpenAI 兼容端点 | 可换任何兼容服务（含本地 vLLM）；主挂自动落 `llm.fallback` |
| `vision.model` | `qwen3-vl-plus` | 看图（表情包形象校验、图片消息理解） | 换更强的 VL 更准；主挂自动落 `vision.fallback` |
| `imageGen.model` | `Qwen/Qwen-Image-Edit-2509`（另有三段兜底：`imageGen.qwen.model` → Pollinations） | 锁形象生图 | 换成纯文生图会丢形象一致性 |
| `imageGen.refImage` | `~/.data/sticker-ref.jpg` | 根本形象 | 换图 = 换她的长相 |
| `voice.sovits_url` | `http://127.0.0.1:9880/tts` | 说话 | — |
| `voice.ref_audio_path` | `D:/GPT-SoVITS/models/yinlang/yinlang.wav` | 零样本参考音 | 换音色 |
| `voice.prompt_text` | 参考音的原话 | GPT-SoVITS 需要 | 必须与参考音一致 |
| `rvc.ffmpeg` | `D:/GPT-SoVITS/runtime/ffmpeg.exe` | 翻唱/视频合成 | 换成系统 ffmpeg 也行 |
| `rvc.python` | `D:/rvc/venv/Scripts/python.exe` | RVC 推理 | — |
| `web.proxy` | `http://127.0.0.1:7897` | 生图兜底/上网 | 国内直连会被墙（实测 HTTP 000） |

---

## 十三、常见失败与真因

| 现象 | 真因 | 处置 |
|---|---|---|
| 表情包出来不是鲸鱼娘 | 硅基失败走了 Pollinations 兜底 | 看 `~/.data/imggen.log`；`sf-` 才是根本形象 |
| 语音没声音 | GPT-SoVITS 9880 没起 | 插件会自动拉；或手动 `python api_v2.py` |
| 翻唱跑一半失败 | yt-dlp 取不到源 / ffmpeg 路径不对 | `feiyu sing cover "歌名" --url <直链>` 绕开搜索 |
| 生图 502 / 超时 | 硅基额度或网络 | 会回落 Pollinations（只作临时图，不入库） |
| 抖音评论"发成功"却没内容 | 新号在**别人**视频下回复被审核吞 | 先在自己作品下互动；或等号养起来 |
| 抖音私信不回 | `failStreak` 上升 / 抓不到新消息 | `curl 8095/health`，看 `douyin-dm.log` 里「用户：」 |
| 完全自由不动 | ① 摇号没中 ② 模型额度 429 | `feiyu-freedom.json` / 会话最后几帧 |
| QQ 服务在跑却不回 | SnowLuma 掉了（`snowluma.ok=false`） | `schtasks /Run /TN "DSH-Feiyu-SnowLuma"` |

---

## 十四、磁盘占用参考（本机实测）

| 目录 | 大小 | 说明 |
|---|---|---|
| `D:\GPT-SoVITS` | 数 GB | 含 runtime + 底模 |
| `D:\rvc` | 数 GB | torch cu128 + 底模 + 她的 .pth |
| `D:\social-auto-upload` | 数百 MB | patchright + venv |
| `~/.data` | 数十 MB | 记忆 / 表情 / 日记 / 凭据 |
| `~/.dsh/sessions` | 随聊天增长 | 她的会话（完全自由痕迹） |

---

## 十五、当前部署实况（2026-11-03 实测，Arch + docker）

> 本节由残留清零任务实测写就，取代上文 Windows 口径成为当前真相；上文保留作历史参考。

| 项 | 实况 |
|---|---|
| 宿主 | Arch Linux（内核 7.2.11-arch1-1），用户 baka（wheel）/ feiyu（容器内用户，uid 951） |
| 容器 | `dsh_bot`（镜像 `feiyu-sandbox:1.0`，`Priv=false Caps=[]`） |
| 仓库挂载 | `/home/dsh_bot/app → /home/feiyu/plugins/dsh_bot`（归 feiyu 所有，她的 selfmod 直接提交到 git） |
| 数据挂载 | `/home/dsh_bot/data-home → /home/feiyu/.data`（宿主路径 `/home/dsh_bot/data-home`） |
| 其它挂载 | `/home/dsh_bot/dsh → /opt/dsh`（会被镜像重置，持久件放 `~/.dsh/`）、`/mnt/data/feiyu-stickers → /mnt/stickers`、`entry.sh` / `im-gateway.sh` 单文件注入 |
| LLM 链路 | 容器内 `http://172.17.0.1:3066` → 宿主 `llm-proxy.service`（`/usr/local/bin/llm-proxy.py`，多监听 172.17.0.1 + tailscale0 的 100.91.165.107）→ `127.0.0.1:3065`（agent2api）。**单点**：动它之前先备份、改完立即验容器链路 |
| QQ 通路 | 容器内 SnowLuma + qq-server `0.0.0.0:8081`（docker 只映射宿主 127.0.0.1:8081；绑 0.0.0.0 是修「docker-proxy 从网卡地址进」的必须项） |
| DSH web | `:3080` |
| 进程守护 | `im-gateway.sh`（node 挂了 ~52s 拉起）；她的自重启走 `selfmod-restart.flag`，**禁止 docker restart 整容器** |
| git | 仓库分支 `refactor/v5`，身份 `bot <bot@local>`；她整点 :00/:10 前后跑 auto 快照（会卷走工作区未提交改动——动手前先 git log/status 核对） |
| 门禁 | `node scripts/check.mjs`（305 文件，含 2026-11-03「裸 catch{} 必须带注释」、2026-11-04「条件里的 `名?.名` 与 TDZ 声明前读取」两条规则） |
| 面板入口 | nginx `127.0.0.1:8415`（`/deepseekharness/` → `3090`，注入 DSH 会话 cookie）；另有 tailscale serve `:3081` 直连 3090。**子路径挂载**：`client.js`/`settings.html` 的 API 基址从自身脚本 URL 反推（写死 `/dsh_bot/api` 会 404） |
| 插件访问栅栏 | 回环放行；其余要求「Host ∈ entry.sh 的 `--trusted-host` 且对端是容器网关 `172.17.0.1`（= 宿主反代）」，否则 403。鉴权仍由 DSH `connection.requestRejection` 负责 |
| 测试 | `node tools/run-tests.mjs`（90 套，全套约 58 秒，容器内直接跑；2026-11-04 新增 `client-base-test` / `access-fence-test` / `settings-page-test` / `silent-failure-test`）；2026-11-04 语音改 whale-tts（见第五节）|
| 语音服务 | 宿主 `whale-tts.service`（`/opt/whale-tts`，`:9880`）+ `whale-rvc.service`（`/opt/whale-rvc`，`:9881`），两者都只放行回环+docker 网桥；容器侧 `voice.sovits_url=http://172.17.0.1:9880/tts`，换声由 whale-tts 内部串起 |

## 静默失效修复批次（2026-11-04）

架构检查出的四类真事故，全部已修并各有回归锚点（`test/silent-failure-test.mjs`，已注册进 `run-tests`）：

| 项 | 症状（修前） | 修法 |
|---|---|---|
| `tools/brain/organ/heartbeat.mjs` 的 `ex` TDZ | `const ex` 在第 202 行声明，第 167 行就用了；每 20 拍抛一次 `Cannot access 'ex' before initialization`，被 catch 吞掉 → **存在感器官从上线起一次都没跑过** | 把 `ex` 提到 `beat()` 顶部 |
| `tools/lib/notify.mjs` 缺 `dataPath` import | 跨窗口去重整段抛 ReferenceError 又被内层 catch 吞掉 → **同一条消息私聊+群聊会重复发两遍** | 补 import；去重表改用 `atomic.updateJson`（多进程读-改-写） |
| `tools/lib/swallow.mjs` 不分预期缺失 | 1196 行日志里 900+ 行是 ENOENT（首建锁/可选文件），真事故被埋掉 | 拆两本账：`swallowed.log`（真事故，1h 摘要）/ `swallowed-soft.log`（ENOENT/ENOTDIR，6h 摘要）；`readSwallowed()` 默认只读真账 |
| `tools/lib/channel-io.mjs` outbox 无锁 | `outbox.json` 是多写者文件却无锁读-改-写；drain 的"取出"与"清空"分两步做会抹掉期间新入队的消息 | 入队/取出都走 `atomic.updateJson`；`outbox.json`、`send-dedup.json` 登进门禁的 `MULTI_WRITER` |

**门禁补强（`scripts/check.mjs`）**：旧 9.5 只认 `if (x)` 的**裸标识符**，看不见 `if (N%X===0 && ex.vitals?.presence)`。
现在① `if/while` 条件里的 `名?.名` 也进嫌疑集；② 新增 TDZ 检查（同一块内、声明行之前被读）。
口径是"宁可漏报"：`for (const [k,v] of …)` 解构、闭包体（`=> …`）、字符串内容都不算 ——
实测在 305 个真实文件上零误报、只命中 heartbeat 那一条真事故。新增 `maskLiterals()` 把字符串/正则内容
抹成空格，否则 `'--from'` 里的 `from` 会把块结构判定带偏。

**出站链路现状（诚实记录）**：`/inbound` + `/outbound` 的机制在，但**当前没有消费者** —— 微信 bot 跑在
Windows 本机自己直连 LLM、自己发消息，既不入站也不拉出站；`outbox.json` 实测不存在。要么把微信接上
（入站转发 + 起一个拉取循环），要么承认微信不共用统一通道。现在是两者之间，已在 `channel-io.mjs` 头注写明。

**`brain.mode` 判据**：`metrics.json` 三天累计 `episodesIn=29 / episodesDup=136`（82.4%）。但落盘的 29 条里
**msgId 零重复** —— 高比例恰恰说明去重闸在正常工作（QQ 消息被 bridge 与 onEvent 各报一次，后者被拦下）。
切 `live` 的判据不是这个比例，而是**装配质量**：`assemble.assemble` 会整体替换现在 `persona.buildMessages`
那条路，属她的核心行为，要单独一轮验证再切。

