# v5 重构记录（2026-10-31）

> 这一轮不是"打补丁"，是把整套系统的**地基层**换掉：并发语义、配置真相、入口安全、
> 记忆写入、平台开关、定时器生命周期。每一条都对应一个实测复现过的问题，
> 或者一个"代码看着对、其实从来没执行过"的死链路。

## 一、修掉的 P0（每条都实测复现过）

### P0-1 统一通道并发串台

**现象**：4 个会话并行时，A 会话（微信）在 `await` LLM 的 3 秒里，B 会话（QQ）把
`CUR_PLATFORM` 改回 `'qq'`。A 醒来后调 `send()` → 回复被当成 QQ 消息走 OneBot 发出去，
或者落进 B 会话的 outbox。**只在并发时出现，单条压测永远正常**。

**根因**：`qq-server` 用两个**闭包级变量**表示"当前正在处理谁的消息"。

**修法**：`tools/lib/reply-context.mjs` —— 用 `AsyncLocalStorage` 把上下文挂在**异步调用链**上。
同一条 `handle()` 里的所有 `await`/回调各拿各的，天然隔离。

**回归测试**：`test/reply-context-test.mjs` 用 4 个会话故意交错 await，断言每个会话
中途和末尾读到的平台/会话都是自己的。

### P0-2 干跑把"没发出去的话"写进真实记忆

**现象**：`guard.dryRun=true` 时，`qq-server` 先 `memory.remember(..., 'assistant', ...)`
再 return。于是每一条"她本来要说但没发出去"的话都进了 `episodes.jsonl` 和 brain。
而 `brain.onSent` 只在真发后记 → **两套记忆分叉**，她之后会引用"幽灵发言"。

实测证据（重构前）：15:58:11 日志 `[qq][干跑] → 在发呆啊…`，同一秒
`~/.bot-ai/qq/episodes.jsonl` 出现同文 assistant 行。

**修法**：新增 `memory.rememberAudit()`，只写 `audit/unsent.jsonl`（不进任何提示词、
不进 brain）。`diagnose` 增加"干跑审计"一项。

### P0-3 HTTP 入口无鉴权 + 实际绑 0.0.0.0

**现象**：`im-gateway.sh` 里写的是 `export QQ_BIND_HOST=0.0.0.0`，而
`/onebot` `/inbound` `/outbound` `/task` `/event` `/sent` **全部没有鉴权**。
跨容器实测（`rustdesk-api` → `172.17.0.3:8081`）：

- `GET /task` 拿到完整任务队列
- `GET /outbound` 拿到她的出站消息（还能 `drain` 清空）
- `POST /inbound` 可以冒充任意用户跟她说话

当时唯一挡住滥用的是 `guard.dryRun=true` —— 那是"恰好没开"，不是防护。

**修法**：`tools/lib/inbound-auth.mjs`
- 配了 `qq.inboundToken` → 强制校验（`Authorization: Bearer` / `X-Feiyu-Token` / `?token=`）
- 没配 → **只允许本机回环**（跨容器/局域网一律 401）
- `/health` 保持开放（监工要探，且不含私密内容）
- **`/onebot` 例外**：OneBot v11 的 HTTP 上报不支持自定义请求头，强制 token 会直接
  断掉本机 SnowLuma。所以它只要求"回环"——它本来就绑在 127.0.0.1。
- `/outbound` 的 `platform` 改为**必填**：旧版不传会 drain 全部平台（实测 qq+wechat
  两条被一次取走）。

### P0-4 `platforms.qq=false` 会误杀微信（两处）

**现象 A**：`handle()` 在解析 `EVT_PLATFORM` **之前**就判 `platforms.qq === false` 并 return，
而 `handle()` 是所有平台共用入口 → 关 QQ 把微信一起杀掉。

**现象 B**：进程启动时 `if (!QQ.enabled) process.exit(1)` → "关 QQ、只开微信"
这种完全合理的配置，整个进程直接不启动。

**修法**：新增 `tools/lib/platforms.mjs` —— 平台枚举与开关判定的**单一真相**。
- `enabled(cfg, id)` 只判自己（`platforms.<id>` 与 `<svc>.enabled` 取"与"）
- `allowsGroup()` / `outboundOf()` / `snapshot()` 统一供面板、diagnose、health 使用
- 启动时只有**所有对话平台都关着**才退出，并打印本次启用了谁

**回归测试**：`test/platforms-test.mjs` 明确断言"关 QQ 不许关微信、关微信不许关 QQ"。

## 二、结构性修复（不是 bug，是设计债）

### 1. `config()` 深合并 bug —— 隐藏最深的一个

```js
// 旧实现（错）
const merge = (base, over) => {
  const out = { ...base }            // ← 只浅拷贝顶层
  ...
}
```

`over` 里没覆盖到的嵌套对象（`guard` / `qq` / `llm` / `brain` …）全都是
`DEFAULTS` 里**同一个对象的引用**。任何调用方写一句：

```js
const cfg = config()
cfg.guard.dryRun = false
```

就把模块级的 `DEFAULTS.guard.dryRun` **永久改成 false** —— 之后同一个进程里
每一次 `config()` 拿到的都是 false，即使配置文件里根本没写这一项。

**现场表现**：面板改一项设置后，某些"没动过"的默认值突然不再恢复；
跑完一轮测试再跑业务，行为跟上一轮不一样（测试污染了默认值）。
每次单独复现都正常，只有"先跑过别的"才出错。

**修法**：`merge` 递归 `cloneDeep`，保证 `DEFAULTS` 是只读常量。
**回归测试**：`test/config-file-test.mjs` 第 7 段。

### 2. 配置读写抽成 `tools/lib/config-file.mjs`

| 旧行为 | 新行为 |
|---|---|
| `lib/index.js` 直接 `JSON.parse(fs.readFileSync())` → 缺键时返回残缺对象，20 多处 `?.` 判 false | `readConfigFile()` 必须过 `DEFAULTS` 深合并 |
| 面板保存把整份合并结果写回 → 默认值被永久刻进配置文件，以后改默认值不再生效 | `stripDefaults()` 只落"用户显式设置过的值" |
| 写配置 644（含 token / api_key） | 原子写（tmp → chmod 600 → rename） |

### 3. DEFAULTS 是"派生的真相"

补齐了代码里在读、但默认值里没有的键：
`platforms`、`qq.channel`、`qq.replyGate`、`qq.proactive.globalGapMin/globalDailyMax/maxStreak/ownerActiveMin`、
`qq.inboundToken`、`qq.startWithDsh`、`dream`、`tattle`、`wander`。

新增 `config-upgrade` 命令（默认干跑）把实际配置对齐到 DEFAULTS，历史残留搬进 `__legacy`。

### 4. 记忆写入安全

- `appendEpisode()`：`O_APPEND` + **单次 write**（`appendFileSync` 可能分多次写，
  多进程并发会交错成半行 → 读端 `JSON.parse` 失败 → 那条记忆**静默消失**）
- `rotateIfBig()`：加**跨进程文件锁**，并在锁内再确认大小。旧版没有锁，
  多进程同时轮转时后完成者会用旧快照覆盖前者的结果 —— 真实丢记忆。
- `remember()` 现在返回写入的行（以前返回 `undefined`，调用方无法确认"到底记没记住"）

### 5. 定时器生命周期 `tools/lib/lifecycle.mjs`

旧版 `lib/index.js` 有 4 个 `setInterval`，`dispose` 只清了 2 个 →
插件热重载一次就有**两份 `mindTick` 在跑、两份同时写记忆/发消息**。

现在所有长驻定时器走 `lifecycle.every(name, fn, ms)`：幂等（同名替换）、统一登记、
`disposeAll()` 一次清干净、`snapshot()` 给 diagnose 看"谁在跑、跑了多少次、错了多少次"。

## 三、死链路（原来静默降级，现在真能用）

| 链路 | 旧状态 | 根因 | 修法 |
|---|---|---|---|
| **自制表情** | 恒返 `null`，"AI 画不出来就退文字贴纸"从未生效 | `stickers.mjs` 用 `cfg.wechat.python`（Windows 路径），容器里不存在 | 新增 `sticker-render.mjs`：ffmpeg + drawtext + 自带中文字体（零新增依赖），python+PIL 降为第二备选 |
| **韵律打分** | 全部 0 分 → `bestOf` 永远选第一条 | 默认 `D:/GPT-SoVITS/.venv/Scripts/python.exe` | 新增 `python-runtime.mjs` 统一探测（配置 → 环境变量 → pyenv → PATH），缺库时明确 `{ok:false, why}` 让 diagnose 判红 |
| **睡眠归档** | 从未执行过（`catch {}` 吞掉） | 容器里没有 `git` | 新增 `tar.mjs`（零依赖 tar.gz 写入器，带读回自检），git 可用时仍走 git |

## 四、上帝文件拆分

| 文件 | 前 | 后 | 抽出的模块 |
|---|---|---|---|
| `tools/commands/qq-server.mjs` | 1795 | 1632 | `promise-executor.mjs`（212 行承诺执行器） |
| `lib/index.js` | 1179 | 1133 | `config-file.mjs`（配置读写） |

新增模块（10 个）：`reply-context` `platforms` `inbound-auth` `lifecycle` `config-file`
`python-runtime` `sticker-render` `tar` `persona-voice` `promise-executor`。

## 五、人设措辞单一来源

`tools/lib/persona-voice.mjs`：`selfName()` / `selfClaim()` / `ownerTitle()` / `selfIntro()` / `fill()`。
替掉了 20+ 处写死的「大肥鱼」「笨蛋老爹」「鲸鱼娘AI」，顺带清掉 prompt 里的 AI 字样
（persona.md 的红线是"别自称 AI"）。

## 六、质量护栏升级

| 项 | 前 | 后 |
|---|---|---|
| 测试 | 31 套 | **40 套**（+9 套，全部对应本轮修的问题） |
| 门禁 | 170 文件 / 8 条 | **191 文件 / 8 条** |
| E2E | 0 | **`scripts/diagnose-smoke.mjs`：15 条断言，真起服务** |
| pre-commit | 无 | `scripts/pre-commit`（2 秒快检，已 `core.hooksPath=scripts`） |
| `npm run verify` | 无 | 门禁 + 40 套测试 + E2E 一条命令 |

### E2E 覆盖的三个场景

1. **入口鉴权**：health 开放 / task 401 / 正确 token 200 / 错 token 401 / outbound 缺 platform 400
2. **平台隔离**：QQ 关 + 微信开 → 进程活着、微信消息进队列写记忆、QQ 记忆零污染
3. **干跑隔离**：dryRun 下记忆只有 user 行、拟回复只进 `audit/unsent.jsonl`

## 七、仍然没做的（诚实清单）

1. `qq-server.run()` 仍是约 1500 行主闭包（已从 1795 降到 1632，但没拆完）。
   下一步应先抽 `send/callApi` 成可注入对象。
2. `client.js` 1080 行，仍是手写 `__ModuleLoader__` 单文件 UI。
3. `brain.mode=shadow` —— 新装配只写不读，还在对照期。
4. 语音链路：`GPT-SoVITS` 未启动；韵律打分即使有 python 也需要装 numpy/librosa。
5. 微信通道：`platforms.wechat=false`，python 桥没接（但服务侧已能处理 wechat 消息）。
6. LLM 仍单网关（三级 fallback 都在 `172.17.0.1:3066`），网关挂则全灭。
7. 空 catch 仍有 334 处（35.8%），集中在 `qq-server` 的外围 best-effort 路径。
8. 抖音残留：代码里还有 57 处 `douyin` 引用（读旧数据用），README 仍宣传四平台。

---

*2026-10-31 · 门禁 191/8 · 测试 40/40 · E2E 15/15*
---

# 附：深度排查（同日 19:20，第二轮）

第一轮修的是"已知问题"。这一轮专门找"只有特定条件才暴露"的缺陷 —— 全部实测复现。

## A. 并发写状态文件丢 28.8%（本轮最重要）

10+ 个进程写同一批状态文件，全部「读→改→写」无锁。
**实测：20 进程 × 50 次自增 → 丢 288/1000。**
后果：额度账本漏记 → 超额发评论/点赞 → **平台风控**；情绪值丢 → 行为漂移；lore 丢 → 设定消失。

新增 `tools/lib/atomic.mjs`。**锁写了三版**：

| 版本 | 做法 | 结果 |
|---|---|---|
| v1 | `openSync('wx')` | 丢 28.8% |
| v2 | `openSync('wx')` + `writeSync(pid)` | 仍丢 ~5% |
| **v3** | 先写唯一临时文件 → **`link()` 原子创建** | **零丢失** |

v2 为什么失败：overlayfs 上"建文件"和"写内容"之间有窗口，别人读到 0 字节 →
误判死锁 → 拆活锁 → 两把锁同时生效。**实测 200/200 次都有 0 字节窗口。**
v3 用 `link()`（POSIX 原子：存在即 EEXIST，成功则内容已完整）。

## B. 畸形请求打崩主进程

面板 10 处 `JSON.parse(await readBody(req))` 无 try →
`curl -d '{bad'` → unhandledRejection → `fatal uncaught exception` 退出。
新增 `safeBody()`，10 处全替换。

## C. 无超时调用永久挂死

4 处 fetch + 6 处 ffmpeg `execFileSync` 无 timeout。
`execFileSync` 无超时 = **整个 Node 进程被钉死**。
refclean 补 30s~300s + SIGKILL；fetch 补 AbortSignal。

## D. 门禁自身的 bug（最危险）

1. `stripComments` 用正则去 `//`，把 `replace(/\//g,...)` 字符串里的 `//` 当注释 →
   **整行后半段被抹成空格** → 既误报又可能漏报。已改成逐字符扫描。
2. 判定窗口按行数硬切 → 跨行 spawn 被截断 → 满屏误报。改成"该行 + 后 12 行"。

## E. 门禁 9 → 12 条

fetch 无超时 / 同步子进程无超时 / 裸 JSON.parse / 多进程状态文件裸写。
每条都用「故意注入 bug」验证：写回会报错，还原即通过。

## F. 其他

- diagnose `toISOString().slice(0,7)` 东八区月初会读上个月
- `jsonChat` 裸 parse → 兜底返回 null
- `promises.add()` 传对象变 "[object Object]" → 兼容层
- sticker-render 字体补 Arch 路径（`/usr/share/fonts/noto-cjk/`）+ fc-match
- `selfStickerAvailable()` 与渲染路径同源
- `lib/index.js` 1194 行 → 抽 `proc.mjs`（1145 行）

## 教训

**"代码看着对"和"真的对"之间，隔着一个"在真实环境跑一遍"。**
4 个缺陷静态审查全都看不出来：28.8% 丢数据要真并发压测；0 字节锁窗口要实测 stat；
崩进程要真发坏请求；门禁吃代码要读它自己的实现。
而且容器（overlayfs）与宿主机（ext4）行为不同，只在一边跑会漏。
