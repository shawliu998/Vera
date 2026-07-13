# DeepSeek AGI 管培生申请材料：Aletheia Civil Litigation Workspace

## 项目摘要

Aletheia 是一个面向敏感专业工作的本地优先 Agent Harness。这个提交不是再做一个“问法律问题、生成答案”的聊天机器人，而是尝试回答更接近 AGI 产品落地的问题：当模型进入高风险组织，怎样让它的来源、判断边界、人工责任、版本、执行失败和评测都可见、可复现、可约束？

Civil Litigation Workspace 是这个思路的可运行领域样例。它把本地案卷材料转成精确来源切片，组织事实、请求权/抗辩、要件和程序时钟，要求人工确认后生成五类结构化诉讼成果，并用精确版本审批、持久化运行和确定性 Eval 验证关键防线。

## 为什么选民事诉讼

民事诉讼适合检验 Agent 产品判断，因为“写得像”远远不够：

- 一个日期可能决定程序风险，但模型抽取的日期不能直接成为权威期限；
- 一项主张必须能回到证据原文，也必须暴露相反事实和证明缺口；
- 律师批准的是某个确定版本，而不是对未来所有变化做空白授权；
- 模型不可用、来源变化或审批缺失时，系统应停止，而不是补一个看似完整的答案。

因此项目的主循环不是 Chat -> Answer，而是：

```text
Source -> Proposal -> Human Decision -> Versioned Artifact
       -> Bound Approval -> Local Export -> Audit / Eval
```

## 当前原型做到了什么

### 已实现

- Civil litigation 专用事项工作区，覆盖事实证据、请求权抗辩、程序时钟、文书/庭审成果、Agent Run 和 Eval Lab。
- `SourceSpan` 保存精确偏移、引用原文、chunk hash 和 quote hash；跨事项引用和来源篡改会失败关闭。
- 事实、请求权/抗辩、要件、程序事件和期限候选必须分别经人工确认或驳回。
- 请求权拆解为要件，并连接 supports/contradicts/gap 事实关系；未确认要件不进入成果。
- 服务器从 confirmed-only 状态生成五类成果：证据目录、请求权抗辩矩阵、程序时钟、诉讼提纲、庭审计划。
- 每次生成保留版本、父版本和内容哈希；界面显示相邻版本顶层结构变化。
- 每类成果保存确认态依赖哈希；相关状态改变后自动标记 stale，并阻止旧成果继续申请或执行导出。
- 本地 DOCX 导出要求人工审批，并把审批绑定到成果 ID、版本和内容哈希，同时审计磁盘文件 SHA-256。
- 诉讼 durable run 由服务器固定执行图；未配置健康本地模型时返回 503，无云端回退，无模拟运行。
- Eval Lab 使用 3 个 golden cases 与 5 个 bad cases，持久化 expected/actual、grader 版本、证据引用和结果哈希。

### 需配置

- Node.js/npm、本地数据目录、前后端端口和本地认证模式。
- 实际运行 Agent 分析时，需要 loopback 的 Ollama 或 OpenAI-compatible 本地模型 endpoint，并通过健康检查。

### 尚未实现或证据不足

- 法律语义 diff、多审批人角色策略和合议审批。
- 经律师验证的全国程序规则库和大规模真实案件 Eval。
- 法院电子诉讼平台、邮件、日历或客户系统集成。
- 生产级多租户、组织权限、灾备和合规认证。

## 架构

```text
Browser workspace
  |  create proposal / human decision / request export / start run
  v
Express API (authorization + server-owned policies)
  |
  +-> Litigation Store
  |     SQLite matter state
  |     SourceSpan offsets + SHA-256
  |     facts / claims / elements / events / deadlines
  |
  +-> Artifact Builder
  |     confirmed-only projection
  |     source integrity recheck
  |     version + parent + content hash
  |
  +-> Approval / Export
  |     bind work product + version + hash
  |     owner-only DOCX + file hash + audit record
  |     (encryption requires separate configuration)
  |
  +-> Durable Runtime
  |     fixed server workflow
  |     local model health gate
  |     persisted run / step / event chain
  |
  +-> Eval Lab
        deterministic 3 golden + 5 bad cases
```

## 我做出的五个技术判断

1. **确认态是数据边界，不只是 UI 标签。** 服务器成果构建器过滤 proposed/rejected 状态，避免草稿判断进入正式成果。
2. **来源引用要能发现错位和变化。** 精确偏移负责定位，两级 hash 负责检测 chunk 或 quote 变化；生成和导出都重新验证。
3. **审批必须具备对象身份。** `workProductId + version + contentHash` 共同定义被批准对象，新版本天然需要新批准。
4. **高风险执行图由服务器拥有。** 客户端不能给专用诉讼 endpoint 注入 handler、步骤或任意模型配置；本地模型由服务端策略选择。
5. **先用确定性 Eval 锁住不变量。** 目前不让模型给自己打分，先验证来源覆盖、要件覆盖、期限溯源和五类门禁坏例。

这些判断的共同取向是：在高风险场景中，能力上限重要，但系统在不确定、失败和变化时的行为同样重要。

## 与 AGI 管培生岗位的相关性

这个项目展示的不是“我已经解决了法律 Agent”，而是我会把模型能力放进真实工作流中进行产品化拆解：

- 从专业场景中识别不可交给模型默许的决策；
- 把抽象的可信、可控、可审计转成数据结构、状态机和验收用例；
- 在确定性软件与概率模型之间划分边界；
- 用 golden/bad cases 把失败变成可回归的产品资产；
- 对尚未实现的规则覆盖、组织权限和真实数据验证保持明确口径。

如申请材料使用“法律硕士背景”和“两年 Agent 创业经历”等个人信息，提交前应由申请人本人核对时间、职责和可证明材料；本仓库只能证明项目实现，不能替代个人履历证据。

## 8 分钟演示

演示不依赖外部服务，默认展示本地模型未配置时的 fail-closed 行为，因此更稳定，也更能说明产品判断。完整操作、台词和应急方案见：

- `docs/litigation_demo_script.md`

主要证据顺序：

1. 事项总览和待确认状态；
2. 精确来源切片与事实确认；
3. 请求权、要件和事实关系；
4. 程序事件与期限确认；
5. 五类成果、版本、父版本、hash 和结构 diff；
6. 绑定精确版本的审批与本地导出；
7. 无模型时不创建运行；
8. Eval Lab 3 golden + 5 bad cases 全部通过。

## 可复现验收

```bash
cd backend
npm run test:aletheia:litigation-domain
npm run test:aletheia:litigation-export-integrity
npm run test:aletheia:durable-agent

cd ../frontend
env -u ALETHEIA_LOCAL_MODELS_JSON \
  -u ALETHEIA_LOCAL_MODEL_NAME \
  -u ALETHEIA_OLLAMA_MODEL \
  npx playwright test tests/aletheia-litigation-workspace.spec.ts \
  --project=desktop-chromium --project=mobile-chromium
```

验收证明的是软件不变量和演示路径，不是法律意见正确率。完整提交门槛见 `docs/litigation_submission_plan.md`。

2026-07-10 本地核验结果：两个后端审计均为 `ok: true`，桌面与移动端诉讼 Playwright 用例为 `2 passed`；该次浏览器核验未配置本地模型。

## 结论

Aletheia 当前是本地优先 MVP / private-pilot candidate，不是生产法律系统。它想证明一个具体命题：高级 Agent 进入专业组织后，最有价值的产品工作不仅是提高生成质量，还要把证据、人工责任、执行边界和持续评测设计成系统的一等对象。
