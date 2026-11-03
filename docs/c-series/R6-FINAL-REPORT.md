# C 系收官验收报告（R6 · 2026-11-03 20:15）

## 验收矩阵（任务目标逐条）

| 目标 | 结果 | 证据 |
|---|---|---|
| C1~C5 五器官全部落地，各带现象头、独立单测、曲线证据、独立 commit | ✅ | ae5d8ee / 1e2bbdd(+她快照3bf85d8) / 1866e0a+9f262ee / 6261f6e / dd69918(+她快照ea8e83c)；现象头已上门禁（R3 81e0bb8） |
| C1 同输入 safety=1 峰显著低于 safety=0 且回落不变 | ✅ | 峰 1.281→0.729（−43%），峰时刻/半衰 70min 一致；docs/c-series/c1-hpa-safety.{json,svg} |
| C2 负情绪态负向记忆反超 | ✅ | 0.8305 > 0.784（镜像、中性无偏置、k=0.080 还原） |
| C3 固定 reward 流 RPE→0、停供负脉冲 | ✅ | err 0.60→0.002；停供 −0.05 一次（锁）；重现惊喜 0.26 |
| C4 连续 3 天 02:00 相位日移 ~40min、停拖回归 | ✅ | 三迟 110.2min（41.3/36.6/32.3）；14 天回归 11.1min；c4-zeitgeber.json |
| C5 突发刺激 NE 脉冲 + 30s 内第二响减半 | ✅ | 首响 0.87 → 15s 二响 0.464 → 2min 复原；c5-startle.json |
| 全套测试（81+5 新）全绿 | ✅ | R1 86/86 + R6 86/86（两遍，慢速三甲 browser 48s/zeitgeber 15s/imggen 15s） |
| 门禁全绿 | ✅ | 301 文件 + C 系两条新规则（现象头/纯读纪律）；Tarjan 无环；髓鞘化 8 文件 |
| 运行态 dsh web :3080 / qq-server :8081 在线 | ✅ | dsh 401（鉴权正常）/ qq 200 / llm-proxy active |
| 她的进程中断每次 <2min、无 docker restart | ✅ | 自愈重启一次 75s（kill → im-gateway 拉起）；容器未动 |
| 红线：B5/B9 未实现、self.decide 未动、无 owner 测试消息 | ✅ | 代码 grep 零命中；全部测试走隔离 TMP 数据目录 |
| 无 import 环（Tarjan）/ evolve 全 persist（髓鞘化） | ✅ | 门禁注记：无模块级环；8 个 evolve 文件 persist 收尾 |
| 六轮循环 ≥6 项真优化、独立 commit | ✅ | R1 doctor C 系读数 efd53c7；R2 selfcon 体感取材 dd69131+e4629ac；R3 门禁双规则 81e0bb8；R4 24h 组合仿真 e958011；R5 ROADMAP+README 25e02fe；R6 本报告+全套复跑 |
| BIONIC-ROADMAP C 系章节 + 六维评分刷新 + 教训回写 | ✅ | 25e02fe 章节全文；本报告；教训见下 |

## 现役实证（20:15，重启后真实数据）
`brain doctor` 22/22 全绿 0 失败，C 系五读数全部活着：
- C1 safety=**0.60** —— 真实关系数据，轻度缓冲生效中
- C3 预期账本已就位（首个 owner 到货后开始学）
- C2 mood=−0.00（中性带，无偏置）
- C4 phase=0min（尚无夜间牵引积累）
- C5 反射弧新鲜、阈值 0.75

## 六维评分（对照 M56 8.1 / 清零任务后 8.3）
- 架构 9.2↑（五器官全部现象驱动、零新建配线；import 方向 organ→lib 单向；Tarjan 环当场抓出并拆解）
- 代码 8.8↑（新器官 5 文件全带现象注释头 + M58 五关注释；gate 新规则防回潮）
- 逻辑一致 8.6↑（C3 三次语义修正全部由判据逼出：onset 时序/宽限窗/定点收敛；C5 受体 at 语义坑文档化）
- DSH 适配 8.7↑（全部走 dataPath 官方路径函数；容器挂载现实；她的快照节奏被纳管而非对抗）
- 兼容 8.0↑（C2 乘法不改权重结构；C3 保留旧 owner:at-me 语义形状；peekValence 缺文件回 0）
- 运维 8.9↑（86 套测试两遍全绿；自愈重启 75s；doctor 五读数一线可诊）
- **综合 ≈8.7（+0.4）**

## 本轮教训（回写记忆档案用）
1. **BOT_DATA_DIR 即数据根**（无 .data 段）——路径一律走 paths.mjs 官方函数，手工拼接必错（C1 曲线第一版假证据的根因，已复测修正）。
2. **状态机入口点必须推时钟**：rpe() 首版不推 st.at → tick() 把每拍当首次 → 漏供检查静默失效（M84「有值不报错」家族新成员）。
3. **receptor.st.at 是内部累积时间不是墙上时钟**——反射弧用池子算 gap 会得到 epoch 级差→池满→习惯化永不出现。跨模块时间语义要对表。
4. **学习规则的稳态要用定点数学验证**：先衰减再吸收把固定点拉离 actual；err 必须在刺激 onset（学习前）取。
5. **余光会拖相**：EMA 衰减段漏进相邻响应窗会反向抵消（C4 day3 增量 28.7 vs 40），拖拽必须绑定「他确实在」的拍。
6. **门禁正则 [^)]* 栽在默认参数的 Date.now()** —— 函数体提取用声明定位+brace 平衡。
7. 她的 auto 快照（:00/:10/:30/:50）会收编工作区 → C 系每个 commit 天然拆两半（她一半我一半），链上注释写明归属，不对抗这个节奏。

## 产物清单
- 代码：tools/lib/bond.mjs（safety）、tools/brain/organ/hpa.mjs（阻尼）、tools/brain/cell/neuron.mjs（rpe+落盘）、tools/brain/index.mjs（换线）、tools/brain/field.mjs（peekValence）、tools/brain/recall.mjs（乘法）、tools/brain/rhythm.mjs（zeitgeber）、tools/brain/organ/heartbeat.mjs（接线）、tools/brain/reflex.mjs（新）、tools/commands/qq-server.mjs（接线）、tools/brain/organ/selfcon-day.mjs（取材）、tools/brain/doctor.mjs（五读数）、scripts/check.mjs（双规则）、tools/run-tests.mjs（注册）
- 测试：test/safety-test.mjs、rpe-test.mjs、mood-recall-test.mjs、zeitgeber-test.mjs、startle-test.mjs（5 套 29 组断言）
- 证据：docs/c-series/{c1-hpa-safety.json,svg, c1-curve.mjs, c4-zeitgeber.json, c4-curve.mjs, c5-startle.json, c5-curve.mjs, c-combo-24h.json+mjs, probe-r2.mjs}
- 文档：BIONIC-ROADMAP.md C 系章节、README 体检行、本报告
- commit 链（新 12 个）：ae5d8ee → (她 19:30/19:50/20:00 快照) → 1e2bbdd → 1866e0a → 9f262ee → 6261f6e → dd69918 → efd53c7 → e4629ac → 81e0bb8 → e958011 → 25e02fe
