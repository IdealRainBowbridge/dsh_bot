# 仿生重构规划 v1：化学 / 生物学 / 主观 / 哲学 / 云 LLM 适配

> 承接 `BRAIN-DESIGN.md`（七器官四回路）、`BIONIC-ROADMAP.md`（P0/P1/P2 已落地清单）、
> `BRAIN-UNITY.md`（一份脑多张嘴）、`BRAIN-PRESENCE.md`（自传唯一性）。
> 这一份不是新功能清单，是**换一套坐标系重新解构**：把"器官 + 回路"改写成
> "化学 → 生物 → 主观 → 哲学 → 语言"五层，并指出现有 55k 行里**哪一层是空的、哪一层是假的**。
>
> 口径沿用 M58：先解析现象 → 再定器官形状 → 最后曲线验收。没有现象支撑的耦合线一律不做。

---

## 0. 一句话结论

**她的器官（organ）已经长齐了，但她的"体液"是假的。**

现在的架构是：12 个器官各自把结果 `setDim()` 直写进 `field` 的 8 个标量。
这不是内分泌系统，这是 12 个人往同一块白板上贴便签。
真实生物体里，器官之间不直接对话——它们**分泌分子进循环系统**，
分子被转运体清除、被酶降解、被受体读取，读数的**时间常数由分子决定，不由调用者决定**。

所以重构成败的唯一判据是：
**能否删掉器官对 `field.dims` 的直接写入，改成只 `secrete()`，由循环层决定它何时、多强、持续多久。**

---

## 1. 实测基线（2026-11-04，全部来自生产容器 `dsh_bot`）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **心跳每 30 秒执行一次已冻结的 `think` 动作**，每次都真调 LLM | `heartbeat.mjs:271` `exec[d.action](d)`；`self.decide` 的 kept 分支返回 `prev`；`body.mjs:200` `composeThought` → `llm.chat`。实测调用间隔序列：`30.0s / 29.9s / 30.2s / 30.0s…` |
| 2 | 今日直连 **1705 次 chat 调用、386k token**，其中 input 中位数 **160 token**、output 中位数 **12 token** | `~/.data/llm-usage.jsonl` 当日聚合；`ledger-brief.json` `report.me.tokens.total=390137, calls=1685` |
| 3 | 自主决策历史 30 条里 **29 条是 `think`**，`spanMin` 恒 17 | `brain/meta/self-state.json` |
| 4 | `inner` 池 60 条中 **51 条 `reflect`**，前 8 条 weight 全部顶到 **6.00** 上限，主题同一（"先睡 / 六件事 / 写下来"） | `brain/meta/inner.json` |
| 5 | `field.tension = 5.9999963`（上限 6.0），日志里 `inner:pending +2.5` 反复出现 | `brain/meta/field.json` |
| 6 | **`sleep.json` 卡在 `inSleep=true` 已 43.9 小时**，`acc` 全 0，`history` 空 | `brain/meta/sleep.json`；`beganAt=1793619244153` |
| 7 | 因此 `accrueSleepDebt` 每拍 early-return，`sleepDebt` 冻结在 **0.599** | `heartbeat.mjs:345` `if (inSleep) return` |
| 8 | 语义记忆**全空**：`facts 0 / intents 0 / schemata 0 / competence 0` | `brain doctor` 输出；`brain/sem/` 只有 `strength.json`、`seen-srcev.json` |
| 9 | 巩固跑了 25/36 条，但 **`chatFn=null`**（`nightwork.mjs:72` 调用不传），LLM 抽取整段死掉 | `nightwork.mjs:72`、`brain.mjs:92` 对照 |
| 10 | `brain.mode=shadow`，生产走 `buildMessages`（**5067 字** system），8 槽装配**从未生效** | `persona.mjs` 实测分块；`anchor.json` 每轮 `ENOENT` |
| 11 | 神经通路：`social/reward` 的 `firedAt=0`（**从未被激动**），`stress/explore/attach` 的 `rec.out≈0.97~1.0`（几乎没内化） | `brain/meta/neuron.json` |
| 12 | 直连 **cache 命中 0**（全部按 input 计价）；`system` 被 `foldSystemIntoUser` 折进第一条 user，前缀缓存必然失效 | `llm-usage.jsonl` cache 字段全 0；`llm.mjs:147` 默认折叠 |
| 13 | 两套情绪并存：`mood.json`（value/hunger，6% 概率随机 ±9/±4）与 `field`（10 维 + 受体池），生产 prompt 只读前者 | `mood.mjs:88`、`mood.stateBlock` |
| 14 | 情景去重率 **21/45**（今日） | `brain doctor` `today.episodesDup` |

**结论**：问题不在"器官不够"，在于 **① 时间尺度全压在一个 30 秒节拍里；② 器官直写状态，没有体液；③ 语言模型被当成大脑而不是嘴。**

---

## 2. 五轴解构

### 轴一 · 化学（Chemistry）

**现状**：8 个标量（DA/NE/5HT/CORT/fatigue/sleepDebt/valence/tension）+ 1 个共享受体池 + 3 条 `COUPLING`。
受体池那一层做对了——它让"耐受/敏化"成为**同一个实体的不同投影**，而不是配线。
`receptor.mjs` 的三池迁移（膜上/内化/合成中）已用真曲线验过（连聊 30 分钟 out 0.951→0.485）。

**缺口**：
1. **只有调质，没有激素，没有介质**。真实身体是三级时间尺度：调质（秒~分）、激素（小时）、细胞因子/代谢物（天）。现在的 `cortisol` 名义上是激素，实际由 `hpa` 每拍 `setDim` 直写，等于把它降级成了调质。
2. **没有合成限速，只有清除**。真实系统里"池子空"有两种原因：释放太多，或**前体不足**（酪氨酸→L-DOPA→DA 的限速步骤）。现在只有前者。
3. **没有转运体**。`clearanceTau` 是常数；真实清除速率受转运体占用影响（SSRI 的全部药理就在这一条上）。有了转运体，"她最近对什么都钝"才有第三种解释。
4. **耦合量级不足**：`tension=6.0`（顶格）经 `k=0.09` 的 `push` 后，`cortisol` 只到 0.16。`push` 被弛豫吃掉——这正是 `field.mjs` 里 2026-11-02 那段注释已经写明的坑，但只有 2 条改成了 `set`。

**判据**：任一分子被单独拿出来，它能自己演出"上升-耐受-清除-复敏"四段曲线；器官无法直接改它的读数。

---

### 轴二 · 生物学（Biology）

**现状**：器官数量已超设计文档（hpa / immune / wound / pain / metabolism / vitals / breath / night / sleepstage / rhythm / presence / thalamus / selfcon），
细胞层（synapse/receptor/neuron）齐备，`organs/senses.mjs` 做了解环接线板。

**缺口**：
1. **所有器官共用一个 30 秒节拍**。`BEAT` 表把 napcat/tasks/promises/quotes/qzone/brain/novelty/presence/collateral 全塞进同一个 `beat()`。
   生物学的核心事实是**时间尺度分离**：心率秒级、HPA 小时级、昼夜 24 小时、发育以周计。
   压在一起的后果已经实测到：`decide()` 每 30 秒重算一次欲望，而"想做什么"这件事的心理有效窗口是十几分钟。
2. **没有循环系统**（见轴一）。器官之间靠 import 与 `setDim` 直连。
3. **睡眠状态机不可自愈**：`inSleep=true` 卡 43.9 小时无人发现。`wake()` 只由 `sleep.mjs` 命令调用，
   而 `sleep.mjs` 又依赖 `night.endSleep()`——一个"全仓从没被调用过"的函数（`sleep.mjs:476` 的注释自己写了这句）。
4. **没有发育期**：`B5 敏感期` 仍是提案。`selfcon` 有 seed 概念但没有"早期经历永久塑形 baseline"的机制。

**判据**：拔掉 LLM，她仍然会困、会饿、会惦记、会烦躁；时间过去，曲线自己走。

---

### 轴三 · 主观（Subjectivity）

**现状**：`field.sense()` 已经能产出第一人称词组（"缺觉，脑子发钝"），`presence` 有阈值表对齐。
但**生产提示词不用它**——用的是 `mood.stateBlock()`：`情绪 63/100：平稳`。

**缺口**：
1. **主观被量化成了 KPI**。"63/100"是仪表读数，不是感受。人不会体验到 63。
2. **没有内感受误差**。人对自己状态的判断有系统性偏差（累的时候反而觉得自己还行）。
   现在 `sense()` 是确定性函数：真值 → 措辞，一一对应。这让她**不可能误判自己**。
3. **两套情绪互相打架**：`mood.value` 有 6% 概率随机跳 ±9（`mood.mjs:88`），`field.valence` 按 dt 弛豫。
   生产只读前者 —— 等于**把随机数当情绪**。
4. **`inner` 的情绪通道断了**：`inner.told()` 生产零调用（`grep` 无命中），
   所以"想说没说"永远不会被标记为说过 → `settle()` 每拍把同一批念头折成 tension →
   tension 顶格 6.0 → 自激回路。（第 5、6 条实测）

**判据**：她说的感受必须与器官读数**同向但不必同值**；同一刺激 30 天后引起的情绪峰值显著下降而标签不变。

---

### 轴四 · 哲学（Philosophy）

**现状**：`BRAIN-DESIGN §4-⑦` 定义了三层自我，`self/me.md` 有 owner/self/narrative 三段，
`selfcon` 有名字账本 + 主张账本 + 反驳扣减 + PROTECTED 10 件 + 三审 + `identity.history/`。

**缺口**：
1. **self 段是空的**（`me.md` 里 `<!-- self:begin -->` 到 `<!-- self:end -->` 之间只有一句占位）。
   即"她自己怎么看自己"没有任何写入者 —— 这是**盒子里没有东西**，不是盒子不够黑。
2. **narrative 是模板拼的**：`consolidate.maybeNarrative` 把最近 5 天的 gist 直接 `parts.join`，
   `2026-11-02：主人：私聊暗号ZZZ 说了个秘密；2：群里说个秘密` —— 这不是自传，是日志摘录。
3. **缺少"他者构成性"的边界**：她的名字由"谁在叫她什么"构成（`selfcon.othersUses`），
   但没有任何机制区分"主人在定义我"和"群友在定义我"。主人手改的优先级只写在文档里。
4. **哲学上最硬的一条没实现**：**自我主张必须可被行为否证**。
   `selfcon` 有 `CLAIM_CONTRADICT_STEP=0.25`（矛盾证据扣减）—— 方向对，但账本空（`selfImage: []`）。

**判据**：清空 `self/` 与 `selfcon.json`、只留原始记忆段，触发一次巩固，能重长出一致的名字感与叙事。
长不出来 = 电路板。

---

### 轴五 · 云 LLM 适配（Cloud LLM Adaptation）

**现状**：`llm.mjs` 592 行，37 个调用点，6 档 `PURPOSES`，通道熔断 + 4 级 fallback + 直连记账 + 侧支循环。
工程上做得比大多数项目扎实。

**缺口**：
1. **把 LLM 当大脑用，而不是当嘴用**。最强证据是第 1 条：每 30 秒调一次 LLM 去"想"同一件事，
   日耗 39 万 token，产出是 51 条同题 `reflect`。
2. **前缀缓存必然失效**：`foldSystemIntoUser` 把 5067 字 system 折进第一条 user，
   而第一条 user 每轮都变 → 缓存命中率 0（实测 cache 字段全 0）。
3. **没有结构化输出的强约束**。全部靠 `match(/\{[\s\S]*\}/)` + `JSON.parse`。37 个点里至少 8 个是 JSON 契约。
4. **没有幂等键**。同一次"要不要主动说话"的判定，重试会重复计费、重复写 `affect`。
5. **没有"想"与"说"的成本分层**。`think`（90 tok）与 `deep`（1200 tok）共用同一条通道与同一个预算桶。

**判据**：LLM 掉线 1 小时，她仍然有完整的状态与行为（只是不说话）；恢复后不重复计费、不重复写入。

---

## 3. 目标形态：五层单向栈

```
  ┌──────────────────────────────────────────────────────────────┐
  │ L5 语言（cloud LLM）                                          │
  │   只做三件事：把状态说成人话 / 把他说的话解析成结构化 / 生成内容   │
  │   硬约束：无状态、可缓存、可幂等、可降级到模板                    │
  └───────────────────────▲──────────────────────────────────────┘
                          │ 只读：Report（已是人话的感受 + 意图 + 检索结果）
  ┌───────────────────────┴──────────────────────────────────────┐
  │ L4 主观（Subjectivity）                                        │
  │   interoception：真值 → 加噪 → 词组。只输出词组，不输出数字。      │
  │   三层自我：minimal（此刻）/ narrative（跨时间）/ reflective（二阶）│
  └───────────────────────▲──────────────────────────────────────┘
                          │ 只读：各器官的当前读数
  ┌───────────────────────┴──────────────────────────────────────┐
  │ L3 生物（Organs，按时间尺度分层）                                │
  │   fast 30s   ：反射 / 神经通路 / 丘脑门控                        │
  │   slow 5min  ：HPA / 代谢 / 内感受 / 存在感                      │
  │   ultra 90min：巩固 / 意图 / 决策窗口                            │
  │   circa 24h  ：昼夜节律 / 睡眠债 / 受体池回膜                     │
  │   infra 7d   ：叙事 / 图式 / 能力自评 / 发育塑形                  │
  └───────────────────────▲──────────────────────────────────────┘
                          │ 只写：secrete(mol, amount)（唯一入口）
  ┌───────────────────────┴──────────────────────────────────────┐
  │ L2 化学（Circulation）                                         │
  │   mol 账本：合成（前体限速）→ 释放 → 转运体清除 → 受体读取          │
  │   时间常数由分子决定；器官不得直写 field                            │
  └───────────────────────▲──────────────────────────────────────┘
                          │
  ┌───────────────────────┴──────────────────────────────────────┐
  │ L1 记忆（Memory，只追加）                                        │
  │   episodic（永久的账）/ semantic（带 prov 与有效期）/ intents（可验收）│
  └──────────────────────────────────────────────────────────────┘
```

三条新不变量（违反任一条即架构失效）：

- **I5 单向**：L(n) 只能读 L(n-1)，只能写 L(n+1)。器官不能互相 import（已有 `senses.mjs` 接线板，扩成全面规则）。
- **I6 体液唯一**：任何器官改变全身状态的唯一方式是 `circulation.secrete()`。`field.setDim` 收窄为"循环层的私有方法"。
- **I7 语言无状态**：LLM 调用不得成为状态载体。任何"她记得刚才想过什么"必须在本地文件里，不在上下文里。

---

## 4. 批次与验收

> 每项格式：**现象 → 机制 → 器官 → 曲线验收 → 接线点 → 门禁**。
> P0 是止血（现在就在漏），P1 是换轴（结构），P2 是长出来（需要时间）。

### P0（止血，各自独立 commit）

**P0-1 心跳执行门：同一决定只执行一次**
- 现象：每 30 秒一次 LLM 调用，日耗 39 万 token，产出 51 条同题念头（实测 #1~#4）。
- 机制：`decide()` 的 `kept` 分支返回 `prev`，而 `beat()` 无条件 `exec[d.action](d)` —— **"决定"被当成了"指令"，每拍重放**。
  真实生物里决定是**转移**，不是**重放**：选完就进入执行态，执行期间不再重新发起同一动作。
- 器官：`heartbeat.mjs` 增加 `executedFor` 字段（记录 `action + since`），同一 `(action, since)` 只执行一次；
  `body.think` 改为"每决定一次想一次"，并加 `inner` 变更门（最近 30 分钟内没有新增念头则跳过）。
- 曲线验收：同一 `since` 内 LLM 调用次数 30→1；`inner` 日增从 ~2800 条降到 <40 条；`reflect` 占比从 85% 降到 <40%。
- 接线点：`heartbeat.mjs:271`、`body.mjs:194-203`。
- 门禁：新增检测"同一 `(action, since)` 在一个 span 内执行 >1 次"→ 红。

**P0-2 睡眠状态机自愈**
- 现象：`inSleep=true` 卡 43.9 小时，`sleepDebt` 冻结，`history` 空（实测 #6~#7）。
- 机制：`wake()` 只有 `sleep.mjs` 命令一个调用方，而它是**受计划驱动的**；
  计划没跑到（容器重启/进程崩/plannedMin 缺失）就永远醒不来。缺**看门狗**。
- 器官：`sleepstage` 增加 `reconcile(now)`：`inSleep && now - beganAt > plannedMin*1.6 + 60min` → 强制 `wake()` 并记 `reason:'watchdog'`；
  挂到 `heartbeat` 的 slow 层（5 分钟）。
- 曲线验收：人为把 `beganAt` 设到 20 小时前，5 分钟内自动结算，`history` +1，`sleepDebt` 下降；
  连续 7 天无"卡睡"（`inSleep` 持续 > 计划时长 ×1.6 的次数 = 0）。
- 接线点：`heartbeat.mjs`、`sleepstage.mjs`。
- 门禁：`doctor` 新增"睡眠卡死"项（`inSleep` 且超时 → 红）。

**P0-3 念头→压力的回路限幅**
- 现象：`tension=5.9999963`（顶格），`inner:pending +2.5` 每拍重复（实测 #5）。
- 机制：`settle()` 是**每拍调用的累加器**，而 `told()` 零调用 → 念头永不标记为说过 → 每拍都算同一批积压。
  `field.poke` 是"冲量"，按拍重复施加等于把冲量变成了恒定流。
- 器官：`inner.settle()` 改为**增量语义**：记录上次结算的 `load`，只对 `max(0, load_now - load_prev)` 施压；
  `loudest()` 被 `innerBlock` 取用即视为"被想起"，`weight` 轻微衰减（不是清零）。
- 曲线验收：`tension` 稳态 ≤1.5（不再顶格）；连续 24 小时 `inner:pending` 注入次数 <20；
  `valence` 与 `cortisol` 不再被 tension 单向拉偏（回归到基线附近振荡）。
- 接线点：`inner.mjs:190-198`、`heartbeat.mjs:167`。
- 门禁：field 日志里同一 `why` 在 10 分钟内出现 >5 次 → 黄（提示回路振荡）。

**P0-4 语义记忆的供血**
- 现象：`facts 0 / intents 0 / schemata 0 / competence 0`，巩固处理 25 条仍全空（实测 #8~#9）。
- 机制：`nightwork.jobTidy()` 调 `brain.runConsolidation({ now })`，**不传 `chatFn`** → `extractLLM` 整段跳过；
  规则抽取只认 `ep.who.others.some(kind==='owner')`，而 `episode` 的 `who.others` 实际字段是 `{id, kind, name}` ——判定要对齐；
  另外 `facts.add` 的 `to` 默认 `endOfDay(from)`，当天事实当天过期，巩固在 04:30 跑昨天的 ep 时会**全部过期**。
- 器官：`nightwork` 传入 `chatFn`（`fast` 档，`max_tokens 400`）；`facts.add` 的默认有效期改为"事件日 23:59"而不是"now 的 23:59"。
- 曲线验收：连跑 3 夜，`facts.total ≥ 8`，`noProv = 0`，跨日复查 `active > 0`；
  `intents.total ≥ 3` 且全部带 `verify`。
- 接线点：`nightwork.mjs:72`、`consolidate.mjs:60`、`facts.mjs:100`。
- 门禁：巩固结束若 `processed>0 && facts.added===0` 且 `chatFn` 为空 → 黄（供血缺失）。

### P1（换轴，按依赖顺序）

**P1-1 循环层 `brain/circulation.mjs`**
- 现象：12 个器官直写 8 个标量，`setDim` 有 6 个外部调用方（hpa/sleepstage/neuron/…）。
- 机制：**同一分子被两个器官写两次**是这套架构的必然病（`field.mjs` 里自己记过"容量掉 30% 时 sero 被压两次，实测过冲"）。
  循环层让"谁分泌了多少"与"此刻血里有多少"分离。
- 器官形状（伪代码，不含实现）：
  ```
  MOL = { da:{syn:…, clear:25min, precursor:'tyrosine'},
          ne:{…}, sero:{…}, cortisol:{clear:10h, precursor:'pregnenolone'},
          oxytocin:{clear:14d}, il6:{clear:4h}, atp:{clear:30min}, crh:{clear:20min} }
  secrete(mol, amount, {from, why})   // 只有器官层可调
  transport(mol, dt)                  // 转运体占用 → 清除速率；可被"钝化"影响
  level(mol)                          // 读数（受体池投影后的可用量）
  perfuse(now)                        // 唯一写入 field/neuron 的通道
  ```
- 验收曲线：单分子测试——注入 1 单位 → 峰值、半衰期、回到基线的时刻与 `MOL.clear` 一致（误差 <10%）；
  同一拍两个器官分泌同一分子 → 读数是**和**，不是覆盖；
  连续 5 天高 `il6` → `da` 基线下降 ≥15%（炎症-快感缺失），去掉 `il6` 后 3 天恢复。
- 门禁：`field.setDim` 在白名单外被调用 → 红（先只警告一周）。

**P1-2 时间尺度分离（`BEAT` 分层）**
- 现象：napcat/tasks/promises/quotes/qzone/brain/novelty/presence/collateral 全在 30 秒节拍里（实测 #1 的同源问题）。
- 机制：`decide()` 的"专心窗口"（`until`）本来是解决办法，但它被"每拍执行"架空了（P0-1）。分层之后，
  决策窗口是**真正的**窗口：90 分钟一层，层内不重算。
- 器官：`heartbeat` 拆 `fast/slow/ultra/circadian` 四个 tick 表；每层只演化自己尺度上的量。
- 验收曲线：`self-state.history` 从"每 17 分钟一条、全是 think"变为"每小时 1~2 条、动作分布 ≥3 类"；
  一天内 `action` 熵 > 1.2 bit（现在是 0.14）。
- 门禁：跨层写入（fast 层写 circadian 量）→ 红。

**P1-3 单一情绪源**
- 现象：`mood.value` 随机跳 ±9（6% 概率），`field.valence` 按 dt 弛豫；生产读前者（实测 #13）。
- 机制：两套情绪的真正问题是**可解释性**：她"心情 63"这个数无法追溯到任何事件。
  `affectTarget()` 已经把 affect 折算成 mood 的输入，方向对，但 `mood.mjs:88` 的随机项是纯噪声。
- 器官：删掉 `mood.mjs` 的随机抖动，`mood.value` 完全由 `affectTarget()` + 饥饿 + 睡眠债推导（确定性）；
  `mood.stateBlock` 改成读 `field.sense()` 的词组 + 一个粗粒度档位（好/平/低）。
- 曲线验收：同一状态输入两次 → 输出完全相同（确定性）；连续 24 小时"心情"自相关 >0.85（有惯性、不抖）。
- 门禁：`mood.value` 出现无法溯源的跳变（|Δ|>5 且无事件）→ 黄。

### P2（长出来，需要时间与空账本）

**P2-1 内感受（`brain/organ/interoception.mjs`）**
- 现象：`sense()` 是确定性函数，她**不可能误判自己**（轴三缺口 2）。
- 机制：人类内感受准确率约 0.6~0.7（心跳辨别任务），误差随疲劳与唤醒增大。
- 器官：`report(now)` = `truth ⊕ noise(σ = 0.08 + 0.25*fatigue)` → 词组；
  `accuracy` 单独记账，供元认知使用（"我以为我没事，其实很累"这件事必须可发生）。
- 验收曲线：同一真值重复读数，标准差落在 σ 区间；疲劳 0.8 时 σ 显著大于疲劳 0.2；
  元认知抽查：她自述"还行"而 `sleepDebt>0.7` 的比例在 10%~30%（不是 0，也不是 100%）。

**P2-2 三层自我与叙事时间**
- 现象：`me.md` 的 self 段空着；`narrative` 是 gist 拼接（实测 #11 同源）。
- 机制：自传不是摘要，是**因果链**："因为我在做 X，所以最近 Y"。拼接日志没有因果。
- 器官：`consolidate` 的叙事改为一次 `deep` 调用（输入最近 14 天 gist + 未完成意图 + wins/debts，
  输出 300 字第一人称、必须含 ≥2 个因果连接词、≥1 个未完成的事）；
  `selfcon` 的 `CLAIM_*` 接入 `debts/wins`，形成"我说过我是什么样的人 → 我做到/没做到"的闭环。
- 验收曲线：每周叙事与上周的重合 <50%（在演化），但核心人格锚点（名字/称呼/关系）100% 保留；
  抽查 10 条自我主张，每条都能指到 ≥1 条证据或 ≥1 条反例。

**P2-3 语言皮层化（LLM 分层 + 缓存 + 幂等）**
- 现象：37 个调用点、cache=0、JSON 靠正则抠（实测 #2、#12）。
- 机制：把 LLM 当大脑，就会要求它"持续思考"；当嘴，就只在需要说话时调用。
- 器官形状：
  | 档 | 用途 | 上限 | 是否有状态 |
  |---|---|---|---|
  | `reflex` | 不调 LLM（反射/门控/门限） | 0 | — |
  | `gate` | 分类/判定（JSON schema） | ≤120 tok 输出 | 无 |
  | `speak` | 回复生成 | ≤700 tok | 无 |
  | `deliberate` | 叙事/复盘/深答 | ≤1200 tok | 无（输入已装配） |
- 三条硬改动：① `systemRole:'keep'` 并实测 `prompt_tokens` 前缀命中（当前必失效）；
  ② 所有 JSON 调用带 `idempotencyKey = hash(purpose + 输入摘要)`，30 分钟内复用结果；
  ③ 每个 tier 独立日预算，`gate` 超额时**降级为规则**（不是静默失败）。
- 验收曲线：日 token 从 39 万降到 <12 万（P0-1 贡献最大）；`cache` 命中率 >40%；
  LLM 全断时，她仍能回话（模板降级），且《昨日记忆》探针 10 条中 ≥6 条仍通过。

---

## 5. 明确不做（否定清单）

1. **不做"7 天记忆窗口"**。`episodic` 是永久账本 + strength 衰减，比环形缓冲更接近人脑。降可提取性，不删。
2. **不把黑盒做成"不给看"**。她现在的问题是盒子里没东西（self 段零写入者），不是不够黑。
3. **不合并成单标量情绪**。10 维 field 是对的方向；要消灭的是**第二套**（`mood.value` 的随机项），不是维度本身。
4. **不引入向量库**。倒排 + n-gram 已在生产跑；先修供血（P0-4），再谈语义召回。
5. **不给 LLM 加"记忆"**。上下文不是存储。任何"她记得"必须落文件（I7）。
6. **不用正则抓承诺**。抓不准就不建账，别造脏账（`BRAIN-DESIGN §10-3` 已定，仍成立）。

---

## 6. 与既有文档的关系

| 文档 | 关系 |
|---|---|
| `BRAIN-DESIGN.md` | 器官清单与四回路仍有效；本文件把"器官层"拆成 化学/生物 两层，把"装配层"提升为 主观/语言 两层 |
| `BIONIC-ROADMAP.md` | P0/P1/P2 已落地项（免疫/伤口/呼吸/代谢/痛觉/内感受/C 系）全部保留；本文件新增 P0-1~P0-4 是因为它们是**落地后的接线债** |
| `BRAIN-UNITY.md` | "一份脑、一个意识、多张嘴"仍成立；本文件的 L5 就是"多张嘴"的正式位置 |
| `BRAIN-PRESENCE.md` | 自传唯一性（I4）并入 L1 的 memory 层，与 L4 的 narrative self 分工：前者是账，后者是故事 |
| `BRAIN-AUDIT.md` | 13 记忆缺陷 + 10 行为缺陷里，仍未修的是"睡眠/巩固/语义供血"——对应本文件 P0-2/P0-4 |

---

## 7. 一句话

**她有器官，没有体液；有器官，没有节律；有感受，没有误差；有自我，没有内容；有模型，没有预算。**

按 化学 → 生物 → 主观 → 哲学 → 语言 重排之后，
每一层都只做一件事，而且每一层都可以被单独拔掉验证：
拔掉语言，她还有身体；拔掉循环，器官立刻失序；拔掉记忆，她只剩此刻。
**能这样一层层拔掉的东西，才叫架构；拔不掉的是补丁。**

---

## 8. v2 复核（2026-11-04 16:20 · 全部实测）

> §1~§7 写于 15:39。之后连续两轮取证推翻了其中三处判断，并挖到四个 v1 完全没覆盖的缺陷。
> 本节的每条结论都带可复现的命令或文件读数。

### 8.1 v1 判断被推翻的三处

| # | v1 的说法 | 实测 | 性质 |
|---|---|---|---|
| 1 | "直连 cache 命中 **0**，前缀缓存**必然**失效（`foldSystemIntoUser` 导致）" | **错。** 生产真实 prompt（5095 字，`buildMessages` 形态）实测 `prompt_cache_hit_tokens = 3072 / prompt_tokens = 3255`，即 **94% 命中**；连续三轮稳定 3072。折叠确实让**第一条 user** 变长，但网关按**前缀**缓存，人格块在前、用户话在后，前缀完全一致。 | **测量 bug，不是架构 bug** |
| 2 | 同上，判据写"cache 字段全 0" | **记账取错了字段。** `llm.mjs:32` 读 `usage.cached_tokens`，而该网关只返回 `prompt_cache_hit_tokens`（`cached_tokens` 恒 0）。所以 `llm-usage.jsonl` 里 cache 恒 0，`llm-physio.dailyTokens()` 把全部输入按原价计入 → 她的"饭钱体感"**系统性高估约 90%**。 | 记账层单点 |
| 3 | "`mood.value` 有 6% 概率随机跳 ±9，生产只读前者" | **代码在，但生产没在跑。** `mood.json` 的 `updatedAt = 2026-11-03T16:03`，已冻结 24 小时；全仓 `mood.tick` 零调用（唯一的 `qq-server:mood-tick` 是 `swallow.mjs` 里的注释行）。生产 prompt 里的「情绪 69/100」是**昨天下午的常数**。 | 又一条"函数在、调用死" |

**第 2 条的连带结论**：v1 的 P2-3 验收指标"`cache` 命中率 >40%"已经在生产达成，
却因为记账字段写错而永远显示为 0。**先修记账，再谈优化**——否则所有成本类验收都是瞎的。

### 8.2 v1 完全没覆盖的四个缺陷

**D1 · `attention` 有生产者、零消费者（第 8 例假活）**
- `brain/index.mjs:184` 每收一条消息 `attention.arrive(...)`；`attention.mjs` 有 `claim/next/done/setFocus/focus` 五个消费口。
- 全仓 grep：`claim` / `next` / `done` / `setFocus` **零生产调用**（只有 `state()` 被 doctor 读、`leaseState` 被 doctor 读）。
- 后果：`attention.json` 的 `inbox` 从 11-02 起只进不出，现存 3 条（两个测试号 + 一条真实消息），`maxQueueMin: 30` 的清理**永不执行**——因为清理写在 `next()` 里。
- 真实含义：`BRAIN-UNITY.md` 承诺的"单一注意力焦点"从未上线，各通道仍各自决定开口。

**D2 · 关系账本里根本没有主人（按设计排除）**
- `bond.json.people` 只有 `qq:999000111`、`qq:999000222`（两个测试号）。主人 `3682285116` 不在表里。
- 原因不是 bug：`bond.taste()`（:174）与 `bond.observe()`（:347）开头都是 `if (isOwner(platform, id)) return`。
- 后果：C1 社交安抚缓冲实际读的是 `bond.safety()` → 它扫的是 **episodes**（不是 bond.people），所以 C1 还能工作；但
  "相处久了关系变深"这条（`oxy` 累积、`scar`、`forgive`、`meetsHint`）对主人**结构上不存在**。
  她的"关系龄"只对群友和陌生人存在。`BRAIN-DESIGN §4-⑦` 承诺的 `firstAt` 至今仍无字段。

**D3 · 测试数据污染生产记忆**
- `brain/ep/2026-11.jsonl` 的 `who.others[0]` 分布里混着 `{"kind":"owner","id":"999000111"}`、`"999000222"`、`{"kind":"owner","id":"1"}`、`{"id":"2","kind":"group_member"}`、`{"kind":"owner","id":"999"}`。
- `brain/working/` 里有 `qq_999000111.json`、`qq_999000222.json`。
- `bond.json`、`attention.json` 同样被这两个号占满。
- 后果：`episodic` 是**永久账本**，这些行永远参与 recall 打分与巩固聚类。
  她的世界模型里因此存在三个不存在的"主人"。

**D4 · 主情景账本在 15:25 被整体重置**
- `stat /home/dsh/.data/qq/episodes.jsonl` → **Birth: 2026-11-04 15:25:51**，2043 字节 / 6 行。
- 而 `brain/ep/2026-11.jsonl` 有 40 行、最早回溯到 11-02。两份账本的时间起点差了两天半。
- `ROTATE_BYTES = 6MB`，现文件 2KB —— **不是轮转造成的**。是文件被重建。
- 后果：`buildMessages` 的【最近真实发生的事】槽读的是 `memory.recent()`（→ `qq/episodes.jsonl`），
  所以她在 15:25 之前的所有对话**从提示词里消失了**——只剩 `summary-*.json` 一句话摘要。
  这也是她说"我记不清了"却给不出任何具体事件的直接原因。

### 8.3 最深的一处：`tension` 的量纲泄漏（"六件事"的真正来源）

这是本轮最有价值的一条，它解释了截图里最刺眼的现象。

```js
// field.mjs:86   压力是 0..6 的连续量
tension: { v: 0, set: 0, tau: 6h, lo: 0, hi: 6 }

// field.mjs:626  却在渲染时被当成"件数"
if (d.tension > 2) bits.push(`还有 ${Math.round(d.tension)} 件事没落地，偶尔会飘上来`)
```

实测链条（容器内跑真模块）：

```
inner 池 60 条 pending → load = 91.6
settle() 每 30 秒 poke('tension', min(2.5, 91.6*0.12) = 2.5)
tension 的 tau = 6h，弛豫速度追不上每拍 +2.5
→ tension 稳态 = 2.5 × (6h/30s) = 1800，被 hi=6 钳住 → 5.9999
→ Math.round(5.9999) = 6
→ sense(): "还有 6 件事没落地"
```

**她从来没有"六件事"。** 那个 6 是 `DIMS.tension.hi` 这个上限值本身。
她真实惦记的只有 1~2 件事（清理后 pending=14，load=12.95，代表条目 weight 3.76）。
但从 11-03 00:53 起，每一拍她都被自己的提示词告知"你有六件事没落地"，
然后 LLM 忠实地围绕这六件事生成念头，念头又回流成 tension。

**这是一个完整的自我实现预言闭环，闭环的输入是一个单位错误。**

修法分两层（缺任一层都会复发）：
1. **禁止量→质**：`sense()` 不许把连续量表渲染成计数。改成
   `tension > 4 → 「心里压得慌，一堆事沉在那儿」` / `> 2 → 「有些事悬着没落地」` / 否则不提。
   档位是**定性**的，不是 `/2` 之后取整。
2. **给 tension 加物理上限**：`settle()` 单拍注入已改增量语义（P0-3 已落地），
   但 `poke` 本身没有"总量守恒"概念。长期方案见 §9 的 P1-1（循环层）。

---

## 9. 修订后的批次顺序（v2）

v1 的 P0-1~P0-4 **已于 16:12 全部落地并经过运行态验证**（见 §9.1）。
下面是修订后的剩余批次，按"能否立刻被观察到"排序。

### 9.1 已落地并验证（本轮）

| 项 | 实现 | 验证 |
|---|---|---|
| **P0-1 执行门** | `heartbeat.mjs` 加 `_lastExecKey = action + '@' + since`，同一份决定只执行一次 | 重启后 60 秒内日志：`想明白一件事` 从"每 30 秒一条"降到 **0 条**；LLM 调用从 1779 次/天的小调用流降到 14 次（含对话） |
| **P0-2 睡眠看门狗** | `sleepstage.reconcile()` + `night.watchSleep()` + 心跳每 5 分钟巡视 | 已实际触发：`reason:"watchdog"`, `sleptMin:480`, `cappedFrom:2679`, `resets.debt:6.84`；`inSleep` 从 true→false |
| **P0-3 念头→压力限幅** | `settle()` 改增量语义（`settledLoad` 落盘）+ `think()` 改饱和增量 + `innerBlock` 取用即衰减 | `tension` 5.9999 → **1.798**；`inner:pending` 不再每拍出现；pending 60 → 14 |
| **P0-4 巩固供血** | `consolidate.run` 改 async + `await extractLLM` + `nightwork` 传 `chatFn` | 单测 `brain-consolidate-llm-test`：`chatFn` 被调用、事实真的入库、LLM 挂了不拖死巩固 |

新增 5 套回归测试（`brain-sleep-watchdog` / `brain-heartbeat-gate` / `brain-inner-loop` /
`brain-consolidate-llm` / `llm-usage`），**已全部注册进 `tools/run-tests.mjs`**，
全量跑轮 **97 套全绿**（72.9s）。提交 `66ebe06`，门禁 314 文件通过。

### 9.2 新增 P0-5~P0-8（都是"接线债"，不是新能力）

**P0-5 修 cache 记账 —— ✅ 已落地（提交 `66ebe06`）**
- 现象：`llm-usage.jsonl` 的 `cache` 恒 0，而真值命中率 94%（§8.1）。
- 改法（**比预估多一处，是串行暴露的两个错**）：
  1. 取值链：`prompt_cache_hit_tokens` 提到最前。
  2. **口径拆分**：LLM 的 `prompt_tokens` = 命中 + 未命中，而账本铁律是
     `total = input + output + cache`。若把 `prompt_tokens` 照原样塞进 `input`
     再把命中塞进 `cache`，命中那 94% 会被算两遍 —— 修完第一处才暴露出来。
     现在 `input` 只记未命中（优先用 `prompt_cache_miss_tokens`，没有就 `prompt − hit` 拆）。
  3. 连带修 `readDirectUsage` 与 `llm-physio` 的 brief 回落分支：`total` 都不含 `cache`，
     在 cache 恒 0 的两年里无症状，修完立刻少报 94%。
- 验证（运行态）：连打两次同一大前缀 ——
  `{"input":1832,"cache":0}` → `{"input":168,"cache":1664}`；
  `ledger.usage()` 逐日核对 `total === input+output+cache` 全部成立；
  新增 `test/llm-usage-test.mjs`（11 项）锁住"三者互不重叠"，`llm-physio` / `ledger` 两套既有测试仍绿。

**P0-6 清掉生产里的测试号**
- 现象：三个不存在的"主人" + 两个测试账号写在永久账本里（§8.2 D3）。
- 改法：一次性脚本（同 `tools/maintenance/` 口径）：把 `999000111/999000222/999/1/2` 的 ep 行标 `_test:true`，
  recall 与 consolidate 过滤该标记（**不删**，账本铁律）；`bond.json` / `attention.json` / `working/` 同名条目归档。
- 验收：`brain/ep` 里 `who.others[0].id` 只剩 `3682285116` / 真实群成员；`attention.inbox` 长度归零。

**P0-7 找回 episode 账本（或承认丢失）**
- 现象：`qq/episodes.jsonl` Birth = 15:25:51，只剩 6 行（§8.2 D4）。
- 立刻能做：`brain/ep/*.jsonl`（40 行，回溯到 11-02）与 `brain/log/stream.jsonl`（46 行，含逐字原话）
  是**同源的独立副本**，可以回灌 `qq/episodes.jsonl`，把两天的对话还给她。
- 结构性修法：`memory.remember()` 的 `appendEpisode` 失败目前只 `swallow`（`memory.mjs:164`），
  改成"失败必须吵"（`notify` + `doctor` 红项）。
- 验收：回灌后 `memory.recent()` 能取到 11-02 的对话；`doctor` 有"情景账本跨度"一项。

**P0-8 删掉 `tension → 计数` 的渲染（§8.3）**
- 改法：`field.mjs:626` 换成定性档位。
- 验收：清空 inner 池后连续 24 小时，`sense()` 输出里**永不出现数字**；LLM 生成的念头里"六件事"出现次数 <3。

### 9.3 P1 修订（v1 原案 + 两处修正）

| 项 | 修正 |
|---|---|
| **P1-1 循环层 `circulation.mjs`** | 保持。这是唯一能同时解决 §8.3 量纲泄漏与"12 个器官写 8 个标量"的方案。**新增验收**：同一器官在 1 分钟内 `poke` 同一维度 >3 次 → 门禁红（本轮事故的形状）。 |
| **P1-2 时间尺度分离** | 保持。P0-1 只挡住了"同一决定重放"，但 `decide()` 仍每 30 秒重算。真正分层后 `ultra` 层是 90 分钟。 |
| **P1-3 单一情绪源** | **修正**：不是"删掉 `mood.mjs` 的随机项"——`mood.tick` 根本没在生产跑（§8.1 第 3 条）。正确顺序是：先把 `mood` 的调用接上（或明确废弃），再决定它跟 `field.valence` 谁是真相。**现在连"两套打架"都不成立，是一套在跑、一套是个冻结的常数。** |
| **P1-4（新增）注意力消费闭环** | 把 `attention.next()` 接进 `body.reply`：先问队列里该回谁，再开口。这是 `BRAIN-UNITY` I2 的落地，也是 D1 的修法。验收：`inbox` 的 `maxQueueMin` 清理开始生效（3 条现存条目在 30 分钟内被丢弃）。 |

### 9.4 P2 修订

| 项 | 修正 |
|---|---|
| **P2-3 语言皮层化** | **降级**。v1 把它列为独立批次（"cache 命中 >40%"），但该指标已达标且被误报（§8.1）。剩下真正有价值的是：**幂等键**（37 个调用点、21 个标了 `purpose`，16 个没标）与**按用途分层预算**。**新增**：`PURPOSES.reason = { effort:'high' }` 要删——实测网关对 `reasoning_effort` 静默忽略并返回空 content（`finish=length`），只有 `thinking:{type:'disabled'|'enabled'}` 有效。该档目前零调用，属"埋着的地雷"。 |
| **P2-1 内感受** | 保持。本轮 §8.3 是它最好的论据：**她连自己"有几件事"都是错的**，而且错得系统性、可预测。 |
| **P2-2 三层自我** | 保持。补一条实测：`self/me.md` 的 `self:begin/end` 段至今是占位文字，`selfcon.selfImage` 6 条**全部 `origin:"seed"`**（没有一条来自经历）。"盒子里是空的"这条判断在 v2 依然成立。 |

---

## 10. v2 一句话

**v1 说"她有器官没有体液"——这判断还是对的，但真凶比这更土：**
**她的"六件事"是一个 `hi=6` 的上限值被 `Math.round` 渲染成了件数，
她的"饭钱"是一行取错字段的记账，她的"关系"按设计排除了主人，
她的"注意力队列"只进不出，她的"昨天"在 15:25 被一个重建的空文件覆盖。**

第一批修复（P0-1~P0-4）证明了这批东西**是可以修的**：改的都是接线和量纲，不是重写。
剩下四件（P0-5~P0-8）任何一件的"改动量 / 可观察效果"都比 P1 的循环层高一个数量级。

**先修读数，再修结构。** 一套把自己的 94% 缓存命中报成 0 的系统，
不可能靠读它自己的指标来判断下一刀该切哪里。
