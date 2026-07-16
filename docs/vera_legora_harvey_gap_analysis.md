# Vera / Legora / Harvey 能力差距分析

日期：2026-07-16

审计基线：`shawliu998/Vera` `main` at
`5611699e46552a20bf42ce84396a8e65aa139d16`；当前功能分支 Workspace schema v21。

本文只使用竞品公开能力类别帮助确定 Vera 的独立实现优先级，不推断其非公开架构、效果或安全边界，也不复制其商标、界面、提示词、代码或数据。

## 1. 产品真源

```text
Current product:
Vera local general legal workspace

Current primary navigation:
Assistant / Matters / Workflows / Review / Settings

Current core:
Mike-derived local workspace + Vera encrypted desktop runtime

Legacy:
default-disabled compatibility and reusable implementation source only

Next milestone:
Agent Tool Expansion
+ One Authorized Legal Research Provider
+ Agent-to-Draft End-to-End Vertical
```

已经合并到 `main` 的 Matter convergence 不再描述为“功能分支待合并”。当前本地 packaged acceptance 是 unsigned、unnotarized、local-only，不是签名发布。

## 2. 结论先行

Vera 已经具备真实的本地法律工作底座：加密 Workspace、Matter/Project、文档与 OCR、持久 Assistant、Workflow、Tabular Review、模型网关、Source Snapshot/Citation Anchor、Document Studio、DOCX、Backup/Restore 与 packaged restart tests 都有接线实现。

当前最重要的差距不是再建基础设施、增加 Gate 或复活 Legacy 诉讼产品，而是把这些现有能力组合成一条律师可用的闭环：

```text
Matter -> 本地材料 -> Agent 工具 -> 授权法律检索
       -> 可验证引用 -> 新 Studio Draft -> 人工修改/接受建议
       -> DOCX -> 重启后继续工作
```

阻塞该闭环的核心缺口是：

1. 生产法律检索仍缺持久的 Matter-owned research session/candidate 身份。
2. Assistant 当前 message source 与 evidence union 仍以项目文档为中心，不能绑定已读取的法律权威 snapshot/anchor。
3. active Workspace Provider Settings 已接 v18 Hub，但生产激活 gate 关闭，没有可据实宣称的 live Provider。
4. 默认 WorkspaceRuntime 在激活门关闭时不会装配生产 LegalResearch 模块。
5. 尚无一条确定性 packaged E2E 同时覆盖本地文档、法律权威引用、Draft、suggestion、DOCX 与重启。

## 3. 当前已验证能力与真实边界

| 能力族           | 已合并并接线                                                                                                                                                                | 当前边界                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 桌面运行时       | Electron 监管 loopback Next.js/Express；private bearer；sandbox/context isolation；受限导航和子进程环境。                                                                   | 单用户 macOS 本地客户端，不是多租户服务。                                                  |
| 数据安全         | 一个 SQLCipher Workspace、AES-GCM Blob、Keychain 模型凭证、v1-v21 migration、backup/restore 与 fail-closed。                                                                | 新能力必须复用这些 owner，不得建第二套存储或凭证系统。                                     |
| Matter           | Project 技术所有权、Matter Profile、workspace classification、capabilities、Matter policy 与连续 shell。                                                                    | `Project` 仍是 document/chat/workflow/tabular/Studio 的唯一技术容器。                      |
| 文档与 OCR       | PDF/DOCX/TXT/MD/XLSX 上传解析；扫描 PDF OCR、状态、重试、来源与 exact-page reopening。                                                                                      | OCR 来源不等于法律权威来源。                                                               |
| Assistant        | durable job/outbox、streaming、10-round/16-call bounded loop、stop/retry/regenerate/recovery，以及组合的 Document/Draft/Workflow tools。                                    | 法律权威仍不能进入 document-only 引用投影。                                                |
| 模型             | OpenAI、DeepSeek、Anthropic、Gemini、OpenAI-compatible；Keychain secret、readiness 与 inference policy。                                                                    | 真模型可用性仍取决于用户合法凭证与模型工具调用能力。                                       |
| Workflow/Tabular | 同一 durable Job Runtime 上的真实 definition/run、进度、取消、重试、恢复与导出；Assistant 已注册 bounded Workflow tools。                                                   | Tabular 不是统一 Review Center。                                                           |
| 来源与引用       | Project document / legal authority Source Snapshot、source content、Citation Anchor、retention/tombstone/export/model-use。                                                 | 当前 Assistant message source 以 document 外键为中心，不能直接承载完整法律权威引用投影。   |
| Document Studio  | Markdown/TipTap projection、CAS、版本、恢复、source-aware exact suggestion、accept/reject/stale、DOCX import/export；Assistant 可创建新 Draft，Matter Drafts 使用真实 API。 | 法律权威 citation rebuild 仍待接入 Assistant。                                             |
| 模板与结构化起草 | v21 提供 8 类原创模板、Project 本地副本、严格 DraftPlan 预览和 template-to-Studio Draft。                                                                                   | 前端暂不提供局部模板编辑器；Agent 的分段策略仍依赖有界 prompt/plan，不冒充自动法律正确性。 |
| 法律 Provider    | Legacy 中保留 PKULaw/YuanDian adapter、状态与失败处理合同；v13 activation gate fail-closed。                                                                                | 无官方材料、合法凭证和 rights matrix 的 live acceptance；生产不可声称 ready。              |
| 发布恢复         | 本地 package/security/SQLCipher/backup/restore/restart/port release 检查。                                                                                                  | 当前证据仅为 unsigned、unnotarized、local-only。                                           |

## 4. 竞品能力类别与 Vera 独立实现重点

| 公开能力类别        | Vera 已有基础                                                                    | 当前差距                                      | 本轮做法                                                            |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Matter/文档工作空间 | Matter shell、Project-owned documents、OCR、encrypted Blob、真实 Matter Drafts   | 法律研究来源尚未形成完整纵向任务              | 保持单一 ownership，补法律权威引用投影                              |
| 有来源的 Assistant  | 持久 Assistant、document citations、source snapshots                             | 缺法律来源搜索/读取和法律 citation projection | 只引用实际读取且可验证的 snapshot/anchor                            |
| 法律研究            | Legacy provider contracts 与 provider-neutral source foundation                  | 无一个授权 live Provider 纵向闭环             | 先做 active Provider Hub 与 unavailable 状态，再接一个授权 Provider |
| Drafting/Editor     | Document Studio、versions、suggestions、DOCX、Agent 新建 Draft 与 durable 结果卡 | 法律权威还不能成为 Agent Draft 引用           | 复用 Studio 与模板，不建第二个编辑器                                |
| 可复用工作流        | Workflow definition/run、durable jobs 与 Assistant bounded run/status tools      | 更复杂自动化不是当前法律引用闭环的前置        | 复用现有 runtime，不建第二套调度器                                  |
| 批量审阅            | Tabular Review 已真实运行                                                        | 不是本轮 Agent-to-Draft 的必要前置            | 保持兼容，不扩建第二套 Review engine                                |
| Knowledge/团队协作  | 本地 source/workflow/template 基础                                               | Firm Knowledge、ACL、SSO 不存在               | 本轮明确非目标，不在 Electron 中伪造 SaaS                           |

对标结论：Vera 的最短价值路径是组合现有可靠 owner，而不是增加页面数量、第二套 Agent Runtime 或抽象治理层。

## 5. 当前 Tool 与 Agent 差距

生产组合可注册工具：

```text
list_documents
read_document
fetch_documents
find_in_document
read_studio_document       # 仅兼容 Studio target 时
suggest_studio_edit        # 仅兼容 Studio target 时
create_draft
read_draft
suggest_draft_edit
list_workflows
read_workflow
run_workflow
get_workflow_run
```

`search_legal_sources` / `read_legal_source` 已有固定 Provider 模块，但仅在策略和激活条件允许时注册；当前生产激活门关闭。测试模块可以读取并捕获法律权威，但 Assistant 的 document-only source schema 会明确 `JOB_FAILED`，不写入伪引用。

第一步只建立组合 registry，保持现有工具行为、schema、adapter identity、AbortSignal、Project/Matter recheck 与结果限制不变。随后按 `DocumentTools / LegalResearchTools / DraftTools / WorkflowTools` 独立模块增加能力，全局拒绝重复工具名和跨 job/attempt 路由。

## 6. 法律 Provider 差距

法宝与元典当前均未在 active Workspace 产品中通过真实授权验收。仓库/本机没有足以证明以下事项的完整证据：

- 官方 endpoint、鉴权、搜索、分页与来源获取合同；
- 客户端使用场景的合法 credential 与 licensed test account；
- 展示、缓存/留存、导出、发送到模型和 onward distribution 权利；
- DPA、SLA、数据区域、支持与事故处理要求；
- 固定 acceptance queries、预期来源和错误用例。

因此：

- 不猜 endpoint、参数或 response shape；
- 不使用 browser Cookie、抓包、网页爬虫、私有接口或通用网页搜索代替；
- `configured_unverified` 不等于 `ready`；
- deterministic fake Provider 只用于测试，不出现在生产 Settings；
- contract tests、Legacy adapters 和连接探测都不等于 live acceptance。

完整清单见 [`legal_provider_activation_requirements.md`](legal_provider_activation_requirements.md)。

## 7. 数据/API/UI 差距

### 数据

Tool Registry 不需要 migration。v18-v21 已分别落地 Provider Hub、Assistant action ledger、Draft metadata 和本地模板/DraftPlan。后续只有在现有 owner 无法表达时，才允许以 additive migration 增加 Matter/Project-owned `legal_research_sessions`、`legal_search_queries`、`legal_search_candidates` 或必要引用绑定。v1-v21 不可改写。

### API

新 active API 必须位于认证后的 `/api/v1`，不能复用 `/aletheia/*` 作为产品接口。它只能暴露有界 provider status、research resources 与 Draft projections，不能返回 credential、任意 URL、文件路径、原始 vendor payload 或无界正文。

### UI

需要补齐：

- Assistant 当前 Matter/模型/Provider 状态与用户语言工具活动；
- legal-authority source list 与共享 viewer；
- packaged 全链路中法律权威引用的持久化与重启验证；
- provider/model/cancellation/timeout/license/retention/model-use 的准确错误状态；
- strict frontend stream contract 对全部注册工具的支持。

不得用假 Draft、fallback 数据或测试 Provider 掩盖后端不可用。

## 8. 所有权与避免重复实现

| 能力      | 唯一活动 owner                                                | Legacy/重复来源的处理                                              |
| --------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| 工作容器  | Workspace `projects` + Matter Profile/Policy                  | Legacy matter 表只保留兼容/迁移，不接受新产品写入                  |
| 文档/来源 | Workspace documents/versions/Blob/snapshots/anchors           | 只抽取算法，不调用 Legacy repository/table                         |
| Job/Agent | Workspace jobs、pump、Assistant/Workflow/Tabular runtime      | 不启动第二个 Legacy durable/model/voice runtime                    |
| 模型      | Workspace model profiles、Keychain、gateway、inference policy | 不新增 feature-specific secret 或 gateway                          |
| Draft     | Document Studio documents/versions/suggestions                | 不新增 draft table/editor 或让 Agent 直接覆盖                      |
| 法律研究  | active Workspace Provider Hub + source foundation             | Legacy adapters 可参考，active `/api/v1` 不依赖 Legacy composition |
| Office    | 当前 Legacy PoC 仅作参考                                      | Office Add-in 不属于本轮，也不能宣称 production-ready              |

Legacy 的准确状态是 default-disabled compatibility and reusable implementation source only。除显式兼容测试外，正式客户端不应挂载 Legacy routes/runtime；`/aletheia/*` 不是当前导航或新增功能主存储。

## 9. 优先级与验收

固定顺序：

```text
Agent Tool Expansion
-> One Authorized Legal Provider
-> Agent Legal Research Loop
-> Agent-to-Draft
-> Studio Editing
-> DOCX Delivery
```

每阶段用代码、migration、focused tests 和 retained regression gates 验证。完整闭环还需要一条 test-only deterministic packaged E2E，以及一条独立的 licensed live-provider acceptance。没有凭证时，前者可以通过，但后者必须保持外部阻塞状态。

## 10. 明确非目标

本轮不实现多 Agent、Agent 互相对话、自主诉讼、Case Map、新证据图谱、新 Artifact Ontology、Firm Hub、多用户/ACL/SSO、DMS/云同步、Outlook/邮件、实时会议录音、完整 Word 产品化、多个商业法律数据库或无人工审阅的全文覆盖。

判断标准只有一个：这项工作是否直接帮助律师从一个法律任务出发，完成资料分析、授权法律研究和可编辑文书交付。若不能，本轮不做。
