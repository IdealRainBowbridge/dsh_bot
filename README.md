# 理想的机械人 · Ideal Machina

> DSH 插件 · 作者 **idealrainbowbridge**

一只养在你本机上的、**用仿生的方式长出人类情感**的陪伴角色：
不是模仿人类的言行，而是**模拟一个身体**——给她器官、代谢、情绪、作息，
让"情感"从身体的状态里自己长出来，而不是靠提示词演出来。

- **B站**：生物钟到点自己醒，选题、深读视频、写评论、写两本日记
- **QQ**：经 **SnowLuma** 网关（OneBot v11，NapCat 协议兼容）秒回（私聊/群聊@、语音条、表情包、空间说说），会主动找你
- **微信**：替你回消息（独立进程，按联系人隔离记忆）
- 三平台共用同一套人格、情绪与记忆
- **所有外发默认关闭**，每一项都有独立开关与额度

---

## 一、设计哲学：模拟人体，而不是模仿人类

传统 chatbot 的"情感"是提示词里的表演：`你是一个温柔的少女`。
本项目走另一条路：**给她一个身体，情感是身体的读数**。

### 七器官 · 四回路

`tools/brain/`（约 7000 行，零依赖）实现了一个"脑"：

| 器官 | 模拟什么 |
|---|---|
| `metabolism` | 认知能量与消化积压——话太多会"累"，积压的事会"胀" |
| `immune` / `wound` / `pain` | 免疫发热、伤口、痛觉——被攻击会真的"疼"，并影响说话温度 |
| `bond` | 关系慢账本——信任是长期复利，不是单轮评分 |
| `affect` | 情绪状态机——会自己漂移，也会被事件拉动 |
| `rhythm` | 生物钟——她有自己的作息，深夜和清晨说话方式不同 |
| `self` / `anchor` | 我是谁——自我认知可审计，人格改写前自动快照 |
| `claim` | 承诺账本——答应过的事必须兑现，否则记为欠账 |

四条回路把它们连起来：**感知 → 评估 → 表达 → 复盘**。
说话链路上，每个器官经 `llmState()` 把身体状态读进上下文——
她"今天不想说话"不是脚本，是能量真的低。

### 为什么记忆不走向量库

参考 Chan et al. 2024 *Don't Do RAG*、Sen et al. 2026 *Is Grep All You Need?*
的结论：对陪伴型 agent，**原文可检索 + 时间常驻**比 embedding 召回更可靠。
所有真实记录一行不丢地归档（`episodes.jsonl` 按平台分片），
召回时带证据、按时序，"说过什么"绝对不许否认。

### 契约层：把"静默失效"变成"看得见的告警"

插件深度依赖 DSH 内部服务（非公开 SDK）。一次宿主升级就可能改名某个 API，
表现是**静默的**——插件照样加载，只是某功能再也不工作。
`lib/dsh-contract.mjs` 把每个依赖点显式登记：缺了会怎样、能不能降级、
启动时逐项检查并在 `/api/status` 报出来。这是本项目最重要的工程决策之一。

---

## 二、安装

前置：DSH ≥ 0.2.1-rc.2，Node ≥ 20。

```bash
# 1. 放到 DSH 插件目录
cp -r dsh_bot ~/.dsh/plugins/

# 2. 安装依赖（零运行时依赖，dev 依赖仅测试用）
cd ~/.dsh/plugins/dsh_bot && npm ci

# 3. 自检
node tools/bot.mjs selftest
node tools/bot.mjs diagnose
```

QQ 通道需另装 SnowLuma 网关（NapCat 协议兼容，兼容原 NapCat 部署，
配置文件 `snowluma_<QQ>.json` 与 `napcat_<QQ>.json` 均可识别）。
微信通道为独立 Python 进程，见 `wechat/`。

## 三、配置

面板（DSH 设置 → 理想的机械人）可改全部配置，也可直接编辑 `~/.dsh/bot.config.json`：

| 键 | 说明 | 默认 |
|---|---|---|
| `platforms.*` | 三平台总开关 | 全关（**默认不外发**） |
| `identity.persona` | 人格文件路径 | `~/.data/persona.md`（附空模板） |
| `identity.owner` | 你的称呼 | 无（可留空） |
| `qq.napcat_http` | SnowLuma HTTP 地址 | `http://127.0.0.1:3000` |
| `voice.modelsDir` | GPT-SoVITS 模型目录 | win: `D:/GPT-SoVITS/models` · 其余: `~/GPT-SoVITS/models` |
| `night.*` | 生物钟（起床/睡觉/夜间额度） | 有 |

## 四、跨平台路径

| 项目 | Windows | Linux / 容器 | macOS |
|---|---|---|---|
| 数据目录 | `%USERPROFILE%/.data` | `~/.data` | `~/.data` |
| SnowLuma 默认 | `D:/SnowLuma` | `/opt/snowluma` | `/opt/snowluma` |
| SoVITS | `D:/GPT-SoVITS` | `~/GPT-SoVITS` | `~/GPT-SoVITS` |
| 字幕字体 | 系统字体目录 | Noto CJK | PingFang / Songti |
| Python | venv `Scripts\` | venv `bin/` | 含 Homebrew |

一切默认值都是**配置优先、平台兜底**；旧 `.bot-ai` 数据目录自动兼容。

## 五、安全模型

- 外发行为（评论/说说/私聊搭话）逐项开关 + 日额度 + 相似度去重 + 风控闸门
- B站写通道 DRY_RUN 默认开：先"干跑"看她会发什么，确认后再放行
- HTTP 面板 fail-closed：信任栅栏服务缺失时拒绝所有请求，而不是放行
- 会话权限：记忆写入需要 `permissionPresets` 支持，缺失时降级为面板手动授权
- 凭据与配置分离（`credentials.json`，0600，永不回显）

## 六、FAQ

**她会不会乱花钱/乱发消息？**
不会。默认全关，每项外发都要你显式打开；开了也有额度与去重兜底。

**和聊天框架（NoneBot 等）有什么区别？**
框架给你"回复消息的能力"；本项目给你"一个有身体的人"——
作息、情绪、代谢、记忆、自我认知都是内生状态，不依赖你编排。

**能换人格吗？**
能。`persona.md` 就是全部人格；每晚回顾时她自己迭代，改写前自动快照可回退。

**宿主升级后插件会不会静默坏掉？**
这正是契约层防的：坏了会在面板上**点名是哪个依赖、影响什么、怎么降级**。

## 七、开发文档

设计细节、事故记录与交接文档在 `docs/` 与根目录 `*-HANDOFF.md` / `BRAIN-*.md`——
它们保留了每一次踩坑的完整上下文，新贡献者建议先读 `BRAIN-DESIGN.md`。

## 许可

见 `LICENSE`。
