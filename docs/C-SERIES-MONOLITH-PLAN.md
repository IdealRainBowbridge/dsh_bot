# 单体拆分方案(C6,暂缓执行)

**写于 2026-11-04,作者:晓宇(应管理员要求做的修缮轮评估)**
**状态:方案存档,不执行 —— lib/index.js 内注释已明确收益不抵这一轮的风险,本次修缮轮遵循该判断。**

## 现状
- lib/index.js 69KB:壳(HTTP 面板 + 生物钟 + 凭据)+ 两个子插件挂载点 + 40+ 路由
- client.js 含手写 React 面板(h() 全手写)
- dsh-bridge.mjs 34KB:49 个命令桥 + 会话记忆
- 契约自检(runContractCheck)已兜住启动期依赖缺失

## 拆分方向(将来若做)
1. **第一步(收益最大)**:把 40+ 路由按域拆成 routes/{config,voice,memory,brain,qq,wx}.js,每域一个文件导出 register(router),index.js 只留装配。纯机械搬移,零行为变化,可分 5 个 PR 节奏做。
2. **第二步**:watchdog.mjs 模式推广——人格接管、能力桥已是 ctx.inject 子插件,把壳也降级为子插件,顶层只留一个 20 行的装配入口。这解决web