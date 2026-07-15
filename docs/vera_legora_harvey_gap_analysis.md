# Vera / Legora / Harvey 能力差距分析

日期：2026-07-16

审计对象：`shawliu998/Vera` 当前合并基线与功能分支提交状态

目标：为 Vera 从 Mike-derived 单用户桌面客户端收敛为面向中国法律团队的 Matter-centric AI Workspace 提供事实基线；本文不是竞品复刻说明，也不把未提交代码当作已完成能力。

## 1. 审计边界与证据口径

本文刻意区分三个状态：

| 状态                   | 提交                                       | Workspace 最高 migration | 本文如何使用                                                                                                       |
| ---------------------- | ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `origin/main` 合并基线 | `12af6fc53317e96314a980250d3bd12d5bfd3bcb` | v14                      | 表示当前主分支事实；Legacy 仍在正常后端启动中加载和挂载。                                                          |
| 当前功能分支 `HEAD`    | `408333d7`                                 | v15                      | 表示已经提交、可以审计的 Phase 1 与 Phase 2A 结果；Legacy 默认隔离，Matter 仅有持久化基础。                        |
| 当前工作树未提交内容   | 不属于任何提交                             | 不适用                   | **不计入当前能力、完成状态或验收结论**。其中包括正在试验的 Matter repository/service/API、runtime 接线和前端文件。 |

因此，下文的“Vera 当前能力”默认指 `HEAD 408333d7` 已提交事实；涉及主分支差异时会明确写出 `origin/main`。功能分支尚未合并，不能把 v15 或 Legacy 默认隔离描述为主分支/正式发布已经具备。

证据优先级为：可执行代码与迁移 > 测试与实现记录 > README/产品文字。竞品信息只引用 Legora、Harvey 的官方公开页面，代表其公开描述的能力族，不证明其内部实现、质量、安全边界、可用地区或与 Vera 的等价性。本文不使用非公开代码、提示词、数据或受版权保护的界面细节。

主要仓库证据：

- [当前状态审计](convergence/current-state-audit.md)
- [Phase 1 Legacy 隔离记录](convergence/phase-1-legacy-isolation.md)
- [Phase 2A Matter Foundation migration 记录](convergence/phase-2a-matter-foundation-migration.md)
- [目标架构](convergence/target-architecture.md)
- [数据迁移计划](convergence/data-migration-plan.md)
- [Mike port manifest](mike_port_manifest.md)
- [P0 Mike 桌面迁移](p0_mike_desktop_migration.md)
- [P1 OCR 与 Document Studio](p1_ocr_legal_document_studio.md)
- [桌面运行说明](desktop_app.md)

## 2. 结论先行

Vera 已经有一个真实、可复用的本地法律工作底座，而不是静态 Demo：加密 Workspace、Project/Document、持久 Assistant、Workflow、Tabular Review、OCR、不可变 Source Snapshot/Citation Anchor、Document Studio、DOCX、模型配置、Backup/Restore 与 fail-closed 检查都有已提交实现和相应门禁。

与目标产品的主要差距不是“再加一个聊天功能”，而是尚未把现有工具收敛到统一 Matter 语义和统一人工复核链路：

1. Project 仍是通用技术容器；`HEAD` 没有已提交的 Matter Profile API、Matter Overview 或面向用户的 Matter 导航。
2. v15 只增加 Matter Profile/Policy 表，且 profile 分类与最新目标合同存在语义漂移；策略表尚不是运行时 Inference Broker 的执行证据。
3. Studio suggestion、OCR warning、Workflow output、Tabular result 各有自己的结果形态，还没有 Proposal Contract 和统一 Review Center。
4. Source Snapshot 目前只支持 `project_document` 与 `legal_authority`，尚未覆盖邮件、会话、手工笔记和集成来源。
5. 中国法律数据源已有适配/配置/留存/激活边界，但没有可以据实宣称完成的、真实授权 Provider 纵向闭环。
6. 当前是单用户本地桌面产品；团队 ACL、Firm Knowledge、Firm Policy、SSO 和多用户审计只能先定义 Port，不能在 Electron 后端中伪造 SaaS。

功能分支 Phase 1 已经修复最危险的产品分叉：默认客户端不再加载 Legacy 路由或后台 runtime。不过 Legacy 源码、表、前端深链和资源仍被保留用于迁移、算法复用和回归；这叫“隔离”，不是“迁移完成”或“删除完成”。

## 3. 当前已验证能力

| 能力族                | `HEAD 408333d7` 已提交事实                                                                                                                                              | 当前边界                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面与本地服务        | macOS Electron 管理 Next.js 前端和 Express 后端生命周期；服务绑定 loopback；每次启动使用随机 bearer；renderer 开启 sandbox/context isolation 并限制导航、权限和新窗口。 | 当前产品是单用户 macOS 桌面版，不是多租户服务。                                                                                                         |
| 数据安全              | 单一 Workspace 数据库、SQLCipher、加密 Blob、macOS Keychain、迁移 checksum、SQLite/SQLCipher integrity、Backup/Restore 和 fail-closed restore 检查。                    | 新模块必须沿用同一数据库、Blob 和迁移 runner；不得建立第二套存储。                                                                                      |
| Projects 与 Documents | Project CRUD/归档，文件夹、上传、版本、解析/OCR、重试、删除、下载等真实 API。`projects` 已有 `cm_number` 与 `practice`。                                                | Project 尚无已提交的法律 Matter API/UI；`cm_number` 和 `practice` 应分别作为 Matter number 与 practice area 的现有规范字段，避免 profile 再造同义字段。 |
| Assistant             | 全局和 Project chat、流式生成、持久事件、恢复、取消、重试和 regenerate；附件与 Project 绑定受检查。                                                                     | 输出仍直接属于 chat/message 语义，未统一投影为待审 Proposal。                                                                                           |
| Workflows             | Workflow CRUD、definition、持久 run、进度、取消、重试和恢复，共用 Workspace job pump。                                                                                  | 尚无 Matter 级 Work composition、统一输出 adapter、来源/策略复核和经批准的团队模板层。                                                                  |
| Tabular Review        | Project/全局 Tabular Review、生成/重生成/取消、导出、持久单元格 job 和 Mike 兼容语义。                                                                                  | “Tabular review 结果”不等于统一 Review Center；两者必须通过 adapter 连接而不是混名。                                                                    |
| 来源与引用            | Project Document/Legal Authority 的 Source Snapshot、内容、Citation Anchor、retention lifecycle 与 tombstone 语义。                                                     | 当前 source kind 是封闭的两类；还没有 Email、Conversation Transcript、Manual Note、Integration Record。                                                 |
| Document Studio       | CAS 保存、版本、DOCX 导入/导出、Assistant/Workflow handoff、AI suggestion 接受/拒绝/恢复。                                                                              | 没有统一 Review adapter，也没有生产级 Office Add-in/Local Bridge。仓库中的 Office/Word 概念或 Legacy PoC 不能被当作 Gate 5 完成。                       |
| 模型与外部来源        | Model profile、写入型 credential、连接测试、激活/停用；法律来源设置、留存和可用性边界已有部分实现。                                                                     | 没有统一 Inference Broker 将 Matter、Source、Model、User policy 合并判定；没有凭证时必须显示 unavailable。                                              |
| 审计与恢复            | Workspace mutation guard、运行记录、迁移/安全/打包审计，以及跨重启恢复路径。                                                                                            | 新 Proposal、policy decision、外部调用和 Word 操作仍需各自可验证审计事件。                                                                              |

当前一级导航仍是：

```text
Assistant | Projects | Tabular Review | Workflows | Settings
```

Project 内部仍是：

```text
Documents | Assistant | Workflows | Tabular Review
```

目标 `Assistant / Matters / Workflows / Review / Settings` 和 Matter 内部 `Overview / Documents / Assistant / Review / Workflows / Drafts` 尚未在 `HEAD` 提交。它们需要真实路由与数据组合，不应只是文案重命名。Work Queue 是 Review 下的聚合工作模式，不是新的一级产品入口。

## 4. 主分支 v14 与功能分支 v15 的明确差异

### `origin/main`：v14

v1-v14 已覆盖初始 Workspace、完整性、runtime、Project ownership、Assistant、Workflow、Tabular、模型 credential/readiness、持久 Assistant events、Project source foundation、Document Studio、source retention 和 Studio suggestions。主分支没有 `matter_profiles` 或 `matter_policies`。

主分支的另一个关键事实是：正常后端启动会无条件组合 Legacy Aletheia，挂载十组 `/aletheia/*` router，并初始化 Legacy durable/model/voice/control 相关对象。隐藏导航并没有消除该运行时分叉。

### 功能分支 `HEAD`：v15

Phase 1 引入两个独立、严格 gate：

```text
VERA_ENABLE_LEGACY_ROUTES=false
VERA_ENABLE_LEGACY_RUNTIME=false
```

只有精确小写 `true` 才启用。默认正式配置不加载 Legacy router factory 或后台 runtime；保留的 `/aletheia/*` 路径返回 404。路由 gate 与 runtime gate 相互独立，兼容测试可以按最小范围显式开启。

Phase 2A 的 v15 是只增不改的持久化 migration，新增：

```text
matter_profiles
matter_policies
matter_policy_execution_locations
```

它保持 `Project 1 -> 0..1 MatterProfile`，没有第二套 document/chat/workflow/tabular 容器。缺少 policy 或 execution-location 为空都按 deny-all 解释；外发、外部法律源和 Word bridge 默认关闭。

但 v15 的已提交 profile 合同是：

```text
matter_type = civil_litigation | commercial_dispute | contract_review |
              legal_research | general
client_name, represented_role, counterparty, court, case_number, stage,
objective, risk_level, opened_at, closed_at
```

最新目标合同则要求通用法律 Workspace 分类：

```text
workspaceType = general_legal | transaction | dispute |
                investigation | compliance | research
clientName, matterNumber, practiceArea, jurisdiction,
representedRole, objective, status
```

二者不能仅靠字段改名等同：`case_number` 不等于所有 Matter 的 `matterNumber`，`stage` 不等于通用 `status`，旧 `matter_type` 也没有 investigation/compliance 的完整表达。并且 Project 已有 `cm_number`/`practice`，不应在 profile 中再产生两个竞争真源。

建议在保持已提交 migration 不可变的前提下，用 v16 增量校准 profile taxonomy/字段与索引；对任何已存在 v15 profile 采用显式、可审计的迁移/用户确认，不做猜测性 backfill。v15 表存在并不表示 profile runtime 或 policy enforcement 已完成。

## 5. 当前缺口清单

| 优先级 | 缺口                         | 可验收的闭环定义                                                                                                                                                                                                    |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | Matter 语义未闭环            | 在保留 Project API/ownership 的前提下，提交一致的 Matter Profile contract、repository/service/API、原子创建、Matter list/detail/Overview 和真实计数；普通 Project 仍兼容。                                          |
| P0     | 统一 Proposal/Review 缺失    | 定义一个服务端 Proposal Contract；Studio suggestion、OCR warning、Workflow output、Tabular result 通过 adapter 进入同一 Review Center；接受/拒绝前重新验证 source、revision、retention、stale 与 Matter ownership。 |
| P0     | Inference Policy 仅有 schema | 一个 fail-closed Inference Broker 必须同时判定 Matter policy、Source policy、Model privacy metadata、执行位置和 user/identity policy，并记录允许或拒绝原因。                                                        |
| P0     | 来源模型未统一               | 扩展而不是复制 Source Snapshot/Citation Anchor；支持 Project Document、Legal Authority、Conversation Transcript、Email、Manual Note、Integration Record，并阻止跨 Matter 引用。                                     |
| P1     | Knowledge 缺失               | 在不复制原始 Blob 的前提下实现 Personal/Matter Knowledge collection、权限和已批准 workflow/template reference；Firm Knowledge 仅定义 Port。                                                                         |
| P1     | 中国法律研究未形成真实闭环   | 至少一个真实授权 Provider：真实连接测试、用户选择来源、snapshot/anchor、研究结果到 Draft、retention/export/model-use gate；无账号环境准确 unavailable。                                                             |
| P1     | Draft/Word 链路不完整        | 先把 Draft 收敛到 Document Studio，再实现 Office Add-in package、认证 Local Bridge、Matter 选择、来源搜索、插入引用、rewrite proposal、source check 和跨重启测试。                                                  |
| P1     | Work Queue 缺失              | 聚合真实 Job、Proposal、Review、Workflow run 和失败/等待状态；不创建第二个 scheduler。                                                                                                                              |
| P2     | 团队部署只有方向             | 定义 `IdentityPort`、`MatterAclPort`、`FirmKnowledgePort`、`FirmPolicyPort`、`FirmAuditPort` 及本地单用户 adapter；Firm Hub 另行实现和验收。                                                                        |
| P2     | Conversation Source 缺失     | 核心链路稳定后，按可选 source module 实现音频导入、本地转写、speaker correction、snapshot、proposal extraction 和 Review Center；不把产品变成会议软件。                                                             |

## 6. 重复实现与所有权冲突

| 能力           | 活动 Workspace 所有者                                                            | Legacy Aletheia 重叠实现                                | 处理结论                                                                                     |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 工作容器       | `projects`、Project API 与 Mike UI                                               | Legacy matter/litigation 容器与页面                     | Project 是唯一活动 ownership；Legacy 数据后续迁移，禁止新写入旧 Matter 表。                  |
| 文档/来源/证据 | Workspace documents、versions、encrypted Blob、source snapshots、anchors、Studio | Legacy documents、evidence、legal research/source index | 复用 Workspace；仅抽取有价值算法，不能让新模块调用 Legacy route/table。                      |
| 后台任务/Agent | 单一 Workspace `jobs`、job pump、Assistant/Workflow/Tabular runtime              | Legacy durable agent/model/voice runtime                | 复用 Workspace job runtime；bounded agent 以后作为 job type/事件扩展，不启动第二个 runtime。 |
| 模型入口       | Workspace model profiles、Keychain、gateway                                      | Legacy local model scheduler/control/provider 状态      | 统一到 Inference Broker；Legacy local-model launcher 不是产品方向。                          |
| 起草与审阅     | Document Studio suggestions/versions                                             | Legacy work product、draft、review/approval 页面和 API  | Studio 是 Draft 基础；统一 Review Center 使用 adapter，Legacy UI 后续删除。                  |
| 法律研究       | Workspace source foundation 与现有授权来源边界                                   | Legacy research/issues/opinions/litigation research     | 迁移可复用 provider/解析算法到明确模块；不保留两套公开产品路由。                             |
| Office/Voice   | 目标 Office bridge 与可选 Conversation source                                    | Legacy Office/voice PoC 与 sidecar 资源                 | 只能作为调研或算法来源；不能把保留代码宣称为生产集成。                                       |
| 前端信息架构   | Mike shell、Projects、Assistant、Workflows、Tabular、Settings                    | `/aletheia/*` shell、Matters、Work Queue、诉讼页面      | 功能分支默认隐藏且后端 404；所需概念在 Mike shell 中独立实现，不复活平行产品。               |

这些是“仓库中存在的重复实现”，不是功能分支默认同时运行的两个产品。Phase 1 后，Legacy 默认不活动；但只要迁移账本、备份兼容、回归和算法抽取尚未完成，就不能删除 Legacy 数据或源码。

## 7. Legacy 的实际状态

### 主分支

- `/aletheia/*` 十组 router 在正常 composition 中无条件挂载。
- route 构造会打开 Legacy repository/数据库句柄并创建 local control、model 和 voice 对象；bootstrap 还配置 Legacy durable runtime。
- 因而主分支是“UI 隐藏但 runtime 仍活动”，不是单一路径产品。

### 功能分支

- `VERA_ENABLE_LEGACY_ROUTES` 和 `VERA_ENABLE_LEGACY_RUNTIME` 默认均为 false，且仅精确 `true` opt-in。
- 默认 composition 不导入 Legacy-only route、durable、model、voice 或 demo 模块；健康状态明确报告 Legacy disabled。
- routes=true 仍可能构造 route-owned Legacy 对象，所以它不是无害 UI 开关；runtime=true 则显式启用后台兼容生命周期。
- Legacy frontend deep links、数据库表、sidecar、fixtures 和 package resources 仍保留；尚无完整迁移 ledger，也没有删除阶段验收。
- Matter 与 Conversation 在 Phase 1 health 中保持 `not_configured`；v15 persistence 落地后也不能把它们升级为运行时 ready，除非对应模块和策略执行已经提交并通过 gate。

任何正式发布检查都应同时验证：两个 flag 为 false、Legacy health 为 disabled、保留路径返回 404、正常 Workspace 能独立完成核心流程。

## 8. 竞品能力族映射

下表只做能力族对标。Legora 与 Harvey 的描述来自官方公开页面，并按页面截至本审计日的内容概括；不据此推断其非公开架构，也不要求 Vera 像素级或命名级复制。

| 能力族                 | Vera 已提交基础                                                              | Legora 官方公开概念                                                                                                 | Harvey 官方公开概念                                                                                                                                      | Vera 的独立实现重点                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Matter/文档工作空间    | Project、Documents、encrypted Blob、Project-scoped tools                     | [Portal](https://legora.com/product/portal) 公开描述共享 workspace、文件搜索、可控发布、角色权限与 audit trails。   | [Shared Spaces](https://www.harvey.ai/platform/shared-spaces) 公开描述 Matter Workspace、Vault/workflow/work product、guest、细粒度权限和 audit trails。 | 当前先完成单用户 Matter Profile/Overview/Document Vault 语义；客户 Portal、Shared Spaces 和多人权限不属于首版。          |
| Assistant 与可追溯问答 | Project Assistant、attachments、source snapshots、citation anchors、持久生成 | Portal 公开描述在共享文件范围内生成 grounded/cited answer 并链接精确来源。                                          | [Getting Started](https://help.harvey.ai/articles/getting-started-with-harvey) 公开描述 Assistant 可选择文件/knowledge source，并把答案链接到所用来源。  | 统一 source kinds、retention/model-use gate 和跨 Matter 隔离；保留 Vera 自有交互与合同。                                 |
| 大批量结构化审阅       | 持久 Tabular Review、列/单元格任务、导出                                     | [Tabular Review](https://legora.com/product/tabular-review) 公开描述大文档集表格化抽取、单元格来源/推理和复用模板。 | [Vault](https://help.harvey.ai/articles/vault) 公开描述 large document set、Review Tables、来源查看、workflow 和导出。                                   | 保留现有 Tabular runtime；把结果通过 Proposal adapter 送入 Review Center，而不是复制新的 review engine。                 |
| 可复用工作流           | Workflow definitions/runs、持久 job、取消/重试/恢复                          | Portal 公开描述可在受控 workspace 中发布/使用 workflow；目标能力族包括可复用法律流程。                              | [Workflow Agents](https://help.harvey.ai/articles/assistant-workflows) 公开描述结构化、预定义、多步骤任务和可见进度。                                    | 复用现有 runtime，增加 source/policy binding、approved template reference 和 review output；不建立第二套 Agent Runtime。 |
| Drafting/文档内工作    | Document Studio、版本、suggestion、DOCX import/export                        | Portal 公开描述 built-in Editor 中协作起草合同与 memo。                                                             | Getting Started 与 Vault 公开描述 Assistant drafting、Vault 到 draft；公开帮助还描述 Word 工作入口。                                                     | Studio 作为唯一 Draft 真源；先完成 Review adapter，再实现安全的 Office Add-in/Local Bridge。                             |
| Knowledge/Playbook     | source foundation、workflow templates、Project material                      | Tabular Review 公开描述团队共享可复用模板；Portal 描述受控共享 work product/workflow。                              | Getting Started/Library 与 Shared Spaces 公开描述 Library、playbook、institutional knowledge。                                                           | 先做 Personal/Matter Knowledge 的逻辑引用层，不复制 Blob；Firm Knowledge 只做 Port。                                     |
| 协作、治理与管理       | 单用户 bearer、审计、加密、备份、model settings                              | Portal 公开描述 role-based access、audit trails 和分享控制。                                                        | Shared Spaces 公开描述 resource-level permissions、ethical-wall integration、full audit trails。                                                         | 当前诚实保持单用户；为未来 Private/China Cloud 定义 identity/ACL/policy/audit port，不伪造企业控制面。                   |
| 法律研究               | Legal Authority snapshot/anchor、来源设置与部分 provider boundary            | Portal 页面公开将 legal research 作为平台能力族，但未提供 Vera 所需中国授权源证明。                                 | Getting Started 公开描述可选外部 knowledge sources，并对答案标注来源。                                                                                   | 只在一个真实授权中国 Provider 通过连接、选择、引用、留存、导出和不可用 gate 后宣称闭环。                                 |

对标结论：Vera 的短板主要在“统一产品语义、人工复核、策略执行和团队边界”，不是基础 OCR、文档解析或 job runtime。最优路径是把现有可靠能力组合成 Matter 纵向任务，而不是追逐竞品页面数量。

## 9. 关键风险

| 风险                                | 影响                                                                                                   | 控制措施                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| v15 与最新 Matter contract 漂移     | 出现第二套分类/同义字段，后续 API 和 UI 固化错误语义。                                                 | 已提交 migration 不原地改写；v16 增量校准；复用 `projects.cm_number`/`practice`；对旧 profile 显式迁移。             |
| 把 policy 表误当作 enforcement      | UI 显示“安全”但模型/来源调用未真正被拒绝。                                                             | 只有经过 Inference Broker 的 fail-closed decision 和审计事件才可报告 ready。                                         |
| `WorkspaceRuntime` 继续膨胀         | 模块所有权模糊，测试与启动副作用扩大。                                                                 | 使用窄 module factory/ports；composition root 只接线，不把 repository 暴露给别的模块。                               |
| 封闭 enum 阻碍扩展                  | `jobs.type/resource_type` 与 source kind 的 CHECK 当前只接受既有种类，未来新 source/job 无法安全写入。 | 每次通过 additive migration 扩展合同和恢复测试；禁止绕过约束或另建 job/source 表。                                   |
| Legacy 被误激活                     | 正式包重新出现双 runtime、额外数据库句柄或模型/voice side effect。                                     | 保持 exact-true flags、默认 false、lazy import、404/health/packaged smoke gate。                                     |
| 来源/引用跨 Matter 或已过期仍被使用 | 泄密、错误引用或不合规导出。                                                                           | 所有检索、Proposal 接受、Draft/Word 和外发调用前验证 ownership、revision、tombstone、retention 和 model-use policy。 |
| 外部法律数据授权不清                | 产生虚假可用性、侵权或不可交付承诺。                                                                   | 只接真实授权 Provider；凭证/许可缺失即准确 unavailable 和 blocker，不用 fixture 代替纵向验收。                       |
| 多部署模式过早耦合                  | Electron 后端演化成伪 SaaS，破坏单用户可靠性。                                                         | Individual 保持本地 adapter；Private/China Cloud 通过明确 Port 和独立服务阶段实现。                                  |
| 开源来源与品牌边界                  | 违反 AGPL-3.0-only、Mike 归属义务或竞品知识产权边界。                                                  | 持续维护 provenance/license 文档；只做公开能力族对标和独立 UI/代码/提示设计。                                        |
| 安全/恢复回归                       | migration、Blob、Keychain、backup 或 restore 失败导致数据不可恢复。                                    | 每个 gate 保持 v1->latest、v14->latest、SQLCipher、backup/restore、tamper/fail-closed 和 packaged smoke。            |
| 用 placeholder 通过验收             | 形成“看起来完成”的 Matter/Review/Provider 页面但无真实服务端状态。                                     | 禁止内存假数据、静默 fallback 和 fixture 冒充真实连接；UI 必须呈现 loading/empty/error/unavailable。                 |

## 10. 明确非目标

### 首个 Vera Individual v2 不做

- 完整 Shared Spaces 或客户 Portal；
- 多租户 SaaS；
- 移动端；
- 完整 Outlook 集成；
- 全所 analytics/admin 后台；
- 自动法院提交；
- 全自主电脑操作 Agent；
- 所有中国法律数据库；
- 所有业务领域的预制 workflow；
- 完整多人同步、SSO/RBAC 服务；Gate 6 只实现 Port 和本地 adapter；
- Conversation/语音主流程；它是 Gate 7 的可选 Source 模块。

### 产品定位长期也不应变成

- “AI 律师”或面向公众的法律咨询机器人；
- 纯诉讼 Agent 或以完整民事诉讼状态机统治所有 Matter；
- 通用会议纪要软件；
- 本地大模型启动器；
- 律所 OA、完整 DMS 或通用自动化平台。

“本地”是部署与信任能力，不是唯一价值。Legora/Harvey 的客户协作、管理和企业治理公开概念可用于长期能力边界设计，但不能成为首版伪造多人功能的理由。

## 11. 分阶段差距收敛建议

1. **Gate 1：产品收敛。** 保持 Legacy 默认隔离；先校准 Matter contract 与 v15/v16 迁移策略，再提交 Matter Profile/API/UI/Overview；现有 Project、P0/P1 与普通 Project 兼容不变。
2. **Gate 2：Review Center。** 先定 Proposal Contract 与服务端 revalidation，再接 Studio/OCR/Workflow/Tabular adapters；不要先做一组独立 review 数据孤岛。
3. **Gate 3：Inference Policy 与 Knowledge。** 把 v15 policy foundation 接到唯一 Inference Broker；实现 Personal/Matter Knowledge 的引用层和模型隐私元数据。
4. **Gate 4：中国法律研究闭环。** 只接一个真实授权 Provider，完整验证 source/citation/retention/export/model-use 与 unavailable 状态。
5. **Gate 5：Word。** 在 Draft/Review 语义稳定后实现 Office Add-in 与认证 bridge，并验证跨重启和跨 Matter 安全。
6. **Gate 6：团队架构准备。** 只提交 Identity/ACL/Firm Knowledge/Policy/Audit ports、本地 adapter 和 Firm Hub ADR。
7. **Gate 7：可选 Conversation。** 核心任务稳定后再把音频作为统一 Source 接入 Proposal/Review，不复活 Legacy voice 产品路径。

每个 Gate 的完成结论必须来自已提交代码、真实纵向测试和准确 unavailable/blocker 状态。未提交实验、静态页面、mock、fixture 或源代码字符串检查都不能单独证明产品能力完成。
