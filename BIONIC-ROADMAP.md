# 仿生路线图（P0 已落地，P1/P2 待建 · 2026-11-03）

> 这是提案不是指令。每项开工前先读 M58 口径：先解析现象 → 器官形状 → 曲线验收。
> 没现象解析的耦合线一律不做；宁缺勿假；每个器官过三关（清空重长 + 曲线 + 测试）。

## ✅ P0（今日已落地，commit 8261d39 / 1514efa）
- **A1 侧支循环** `tools/lib/collateral.mjs`：异源供血管。主链全灭（血债>0）→
  侧支级自动追加；缺血期间心跳试跳保持灌注，连续 5 次健康判恢复退回 standby。
  等一个异源 key 激活（见 `tools/lib/collateral-README.md`）。
- **A3 髓鞘化门禁**：演化函数收尾必须 persist（假活家族第 5 例的教训固化），
  纯函数型在 EVOLVE_PERSIST_EXEMPT 登记。

## P1（✅ 2026-11-03 全部落地）
### B1 免疫系统 —— ✅ 已落地（immune.mjs + immune-test，commit 65d44f5）
现象：垃圾消息/刷屏/注入攻击/上游 403 风控。现在只有皮肤（sanitize 十口硬脱敏）
没有免疫。
形状：
- 先天免疫：消息流上的模式识别（高频重复、异常格式）→ 非特异即时响应（限流/忽略）
- 适应性免疫：陌生攻击特征 → 抗体库持久化（dataPath('immune.json')）→
  同类二次感染响应延迟显著下降
- 发热：感染期代谢率变化 → 行为收敛（少说话/wander 降频），挂进已有 hpa/rhythm，不新造轴
验收：同源攻击两波，第二波清除延迟下降 + 对话叙述自然出现「这套路我见过」（第一人称，严禁 KPI）
### A2 伤口愈合 —— ✅ 已落地（wound.mjs + wound-test）
损伤生命周期账本：熔断跳闸=开放性损伤（自动登记）→ 开放超6h=化脓（心跳巡视+diagnose挂红）
→ 门禁全绿=全身检查通过（自动愈合+瘢痕沉淀）→ 同类损伤再犯=旧伤复发被认出（瘢痕更强）。
免疫（immune）管外来物，伤口（wound）管自己身上的外伤。

## P2（B2/B4 已落地 2026-11-03 傍晚；B3/B5 待做）
- **B2 呼吸** ✅（breath.mjs + breath-test）：T = T0/(1+K·arousal)，余弦相位过渡，
  气泡间隔由呼吸节律出（吸气短呼气长，±18% 呼吸性不均）。实测曲线
  253→1486→336ms 正弦全谱。静息不改变行为只改变节奏（单气泡走不到它）。
- **B3 能量/消化** ✅（organ/metabolism.mjs + metabolism-test，24h 曲线实测：
  白天消化>进食积压不涨，夜间 0.97→1.00 回满、积压清零）。生态位=认知资源
  （fatigue 管身体/sleepDebt 管睡眠债/energy 管"脑子还有多少电"）：消息=思考消耗、
  binge=进食+积压、REM=消化回充、N3=修复、饿感与积压感进 sense。
- **B4 痛觉分层** ✅（organ/pain.mjs + pain-test）：Aδ 快痛=新伤口登记那一刻
  （stress 通路+hpa 脉冲，复发敏化更痛，未愈同源不重复喊疼）；C 纤维慢痛=还在流血的
  伤口的钝痛进 sense（愈合即停）。快痛按伤口 id 判新事件——修复过一次的坑再摔会再疼。
- **B5 发育敏感期**：早期经历对 baseline 的永久塑形。等 selfcon 三天影子期结束再动
  （2026-11-03 晚为影子期第一夜）

## 已知风险位（评审遗留）
1. ~~4 级 fallback 全同源 = 单点~~ → 用户口径：聚合站就是统一入口，**侧支保持休眠（器官在血管空），此风险由用户口径接受**
2. ~~persona↔recall 双向 import 无门禁规则拦~~ → A3b 已拦（f78d551），且 2026-11-03 补了 Tarjan 全量环检测（checkRealCycles，三元环也能抓）+ field 感官接线红线（checkFieldSenses）
3. ~~qq-server 1664 行贴着纪律线，加功能先拆~~ → 2026-11-03 评审批后 1732 行（B7 表达代谢接线 +4、锁 failClosed 注释 +5、去重指纹修复重构 +10），仍在 1750 护栏内；下次加功能先拆

## 评审修复批（2026-11-03 下午，外部评审 10 问题全修）
- **锁健壮化**（tools/lib/lock.mjs 重写）：三态语义 tryAcquire/acquire(failClosed)，O_EXCL 消 TOCTOU，死锁抢占，锁故障不再=静默下线（qq-server failClosed，幂等任务 failOpen）
- **脑文件锁**（brain/json.mjs mutateJson 内建同目录锁 5s 超时降级）：field 的 poke/setDim/driftSet/repaySleep 全部改唯一命名空间读改写 —— "丢更新"类风险（v5 丢 28.8% 的后代）正式闭环
- **field↔organ 解环**：感官统一走 brain/organs/senses.mjs 接线板（organ 侧动态 import），field↔pain↔hpa↔field 三元环消失；顺手修掉 sense() 里 B3/B4 补丁叠出来的 try 嵌套事故
- **selfmod 核心件红线**：PROTECTED 名单（门禁/selfmod/锁/鉴权/伤口账本 10 个文件）她改不了 —— 门禁不再自指
- **门禁去静默**：checkCommandRegistry 结构不匹配从 note 升级为红；Tarjan 环检测、field 感官红线、核心件写入 tripwire 三条新规则
- **表达代谢 B7**（llm-physio.mjs）：直连 token 日预算超了会"省着点说"（llm.dailyBudgetTokens 配置，默认静默）
  → **2026-11-03 晚已配 600k/天**：按实账定（两日实测 33.6万/49.5万，大日子傍晚开始收缩，
  平常日器官安静不过敏）。实测：40万假预算 → 温度 -0.12 + 短句体感；55万/90万 → 安静。
  她的"话费"第一次进了身体：超支不是被掐断，是自己收着说。
- **produce 缺幕不再无声**：成片幕数不足时通知老爸
- **run-tests /tmp 清扫收敛**：'bot-'/'dsh-' 超宽前缀撤掉
- **brain-isolation-test 隔离先行**：env 沙箱先于一切项目模块 import（写穿 ~/.data 同族病灶根治）

## B6 生理→说话接线（2026-11-03 晚，commit 59364ff）
器官第一次长进表达链路（以前身体感只进 system 自述层，不进表达参数）：
- 器官 \`llmState()\` 家族：immune / metabolism / pain 各出一个纯读缓存接口（永不抛错，
  没意见给 null）——发烧降温、低血糖变短变直、带伤收着说
- qq-server 动态温度 v2：内容定基调（原逻辑），身体定幅度（三接口钳位 0.35~1.05）；
  体感第一人称措辞注入 system（不向对方解释身体）
- metabolism.spend 接进消息真实入口（**假活第 6 例**：以前只有测试在调，生产零调用——
  门禁引用语料把 test/ 也算数，已加「仅测试调用」提示收口）
- sleep 通道四：bond.remTick（关系 REM 慢相对账，同伴假活）挂进自我结算同一个 REM 窗
- deep purpose 路由：严肃问题（dynTemp≤0.6）走 1200tok 深答档（定义了半年没用过）
- 呼吸**不**接 llmState：它的现象已经落在出站节奏（气泡间隔），再造接口 = 重复 arousal（画线）
