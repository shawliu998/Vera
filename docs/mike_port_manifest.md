# Vera P0 Mike 受控移植清单

日期：2026-07-15

状态：**P0 Phases 0-7 complete；fresh packaged verification passed**

产品边界：先把开源 Mike 做成 **Vera 品牌的本地桌面客户端**；`Project` 是承载文档、对话、工作流和表格审阅的通用容器。Legacy Vera 代码继续保留、编译和回归，但退出主导航。

P0 的四个核心工作区是 Assistant、Projects、Workflows 和 Tabular Review；Settings 是第五个一级入口，也是本地客户端控制面。

> P0 源码和 fresh packaged acceptance 均已完成。验收产物仍是 unsigned、unnotarized、local-only；Phase 7 完成不等于 Developer ID 签名、公证或公开发布完成。

## 1. 固定来源、许可与移植规则

唯一允许的 Mike 来源是：

```text
repository: https://github.com/Open-Legal-Products/mike
remote:     upstream-mike
commit:     e32daad5a4c64a5561e04c53ee12411e3c5e7238
license:    AGPL-3.0-only
```

Mike UI 的使用已经获得授权。仓库仍按 AGPL-3.0-only 基线保留来源、许可和 provenance；授权不应被解释为可以删除上游许可义务。

执行规则：

1. 不从浮动的 `upstream-mike/main` 复制代码；每个移植批次都从固定 SHA 读取。
2. 当前仓库与该基线按受控移植处理，不执行合并，也不新增嵌套的 `mike/` 应用。
3. Mike 决定 P0 的页面结构、DOM/样式、交互流程和产品语义；Vera 决定 Electron 生命周期、本地鉴权、SQLCipher、加密 Blob、Keychain、备份和打包边界。UI 采用源码移植，不做“Mike 风格”仿制。
4. `direct` 用于不依赖 Supabase、组织、分享或云存储的 Mike 组件/纯函数，以及 Vera 已有的安全/桌面算法。
5. `adapt` 只允许最小差分：`local-runtime`、`cloud-removal`、`vera-brand`、`i18n`、`security-fix` 或 `accessibility-fix`。
6. `rewrite` 只用于 Mike 的云端实现无法进入单机客户端的部分；它必须保持 Mike 的外部产品行为，并复用唯一的 Vera service/repository/runtime，不得复制平行业务算法。
7. `exclude` 不进入 P0 可达代码；不能以“先复制、以后再关掉”的方式带入云依赖。
8. 新主产品 UI 统一显示 `Vera`。`Mike` 只出现在许可证、归属、源码 provenance 和本记录中；`Aletheia` 内部名仅可在 Legacy 或兼容边界暂留。
9. 旧 `/aletheia/*` 页面不删除，但不进入新的 Mike-derived 主导航。

### 1.1 质量门禁后的复用决策

“不重复造轮子”不等于盲目沿用旧结构。候选实现依次选择：

1. 固定 Mike SHA 中已有的 UI、产品流程、wire schema 或经过验证的纯业务算法；
2. Vera/Aletheia 已有且通过质量门禁的 Electron、安全、Keychain、SQLCipher、加密文件、解析、导出、备份或任务能力；
3. 项目中已经安装并验证的成熟库，或其他已获授权、质量更高的产品实现；
4. 旧实现核心可靠但结构混乱时，只抽取稳定算法到清晰接口；
5. 旧实现存在数据损失、安全、恢复或维护缺陷时，以单一替代实现收敛；
6. 只有上述来源都不能满足目标边界时，才增加最薄 adapter 或真正缺失的实现。

### 1.2 有意保留的本地客户端差异

这些差异不是遗漏，也不应为了字面一致再造一套平行实现：

- 删除 Supabase Auth/Postgres/RLS、R2/S3、组织、人员、分享、OAuth/MCP 和服务器级 provider secret；本地替代分别是固定 principal、SQLCipher、加密 Blob、Keychain 和 per-launch bearer。
- 全局表格审阅使用单数路由 `/tabular-review`；Project 内仍使用 Mike 的 `/projects/[id]/tabular-reviews/**` 信息结构。
- 工作流详情统一为 `/workflows/[workflowId]`，由定义类型选择编辑器；不复制 Mike 的两套 typed detail route。
- Mike account 页面重组为 Vera `/settings`，只保留 Models、General、Appearance、Local Data/Backup 和 Diagnostics 等本地客户端能力。
- P0 Tabular Review 的 generation、cell retry、citations 和 export 已接通；review chat capability 明确为 `false`，UI 不伪造不可用能力。

## 2. 当前工作树事实快照

- 固定 Mike commit 已在本地 Git 对象库中，移植文件保留 source-lock/provenance。
- `backend/src/lib/workspace/` 已收敛到 additive SQLCipher migrations v1-v16、repositories/services、加密 Blob、下载 capability、FTS、持久 jobs/events 和统一 runtime；v15 以一对一可选扩展保留 Project 技术边界，v16 在不猜测旧值的前提下增加显式 Matter 分类和 jurisdiction。
- `backend/src/index.ts` 是薄入口；`backend/src/veraApplication.ts` 是唯一 composition root。Legacy `/aletheia` 保留，Workspace API 只在 `/api/v1` 挂载一次。
- 同一个持久 job pump 执行 `document_parse`、`assistant_generate`、`workflow_run` 和 `tabular_cell`；没有第二套前端假执行器或内存任务状态机。
- Assistant、Projects、Tabular Review、Workflows、Settings 的活动页面与真实本地 API 已接通；主导航不再进入 `/aletheia/*`。
- `desktop/main.js` 的 `WORKSPACE_PATH` 已是 `/assistant`，应用名和打包产物名是 Vera。
- 模型密钥只通过隔离的 `desktop/credentialWorker.js` 访问 macOS Keychain；renderer、SQLite、日志和 backup 不保存明文凭据。
- Phase 0-6 的 source gates 已形成聚合命令。2026-07-15 的一次完整 `./scripts/package-desktop-mac.sh` 调用以 exit `0` 完成，fresh packaged workspace E2E、backup 和 restore fail-closed 均通过。
- 最终 packaged smoke 使用真实可执行文件分别注入 application encryption `disabled` 和 database encryption `metadata_plaintext`，两次均在端口监听前以 exit `1` 拒绝降级。restore fail-closed 的工作日志包含 `startup_failed` 且不包含 `renderer_window_creating`，证明 pending restore 验证失败前没有创建 renderer。

状态词含义：

| 状态                | 含义                                                 |
| ------------------- | ---------------------------------------------------- |
| `source-complete`   | 活动源码、真实本地纵向链路和对应 source gates 已完成 |
| `packaged-complete` | 当前源码产生的全新 Vera 包已通过跨重启及打包验收     |
| `excluded`          | 明确不进入 P0                                        |
| `legacy`            | 为兼容与回归保留，不属于 Mike-derived 主产品路径     |

## 3. Shell 与主导航

| Mike 固定基线路径/区域                          | Vera 活动实现                                                                  | 方式                | 状态                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `(pages)/layout.tsx`、`AppSidebar.tsx`          | `(pages)/layout.tsx`、`components/vera-shell/VeraShell.tsx`、`VeraSidebar.tsx` | adapt               | `source-complete`：五项导航为 Assistant、Projects、Tabular Review、Workflows、Settings；Settings 按 runtime capability 启用 |
| `PageChromeContext.tsx`、`SidebarContext.tsx`   | 同名 contexts                                                                  | direct/adapt        | `source-complete`                                                                                                           |
| `ChatHistoryContext.tsx`、`SidebarChatItem.tsx` | 本地 chat history、全局与 Project chat 路由同步                                | adapt               | `source-complete`                                                                                                           |
| `PageHeader.tsx`、共享 primitives               | Mike-derived active shared components                                          | direct/adapt        | `source-complete`                                                                                                           |
| logo/icon/产品文案                              | `VeraSiteLogo.tsx` 与 Vera i18n/metadata                                       | adapt               | `source-complete`                                                                                                           |
| 根路径                                          | `frontend/src/app/page.tsx` 跳转 `/assistant`                                  | rewrite             | `source-complete`                                                                                                           |
| 桌面默认入口                                    | `desktop/main.js`：`WORKSPACE_PATH = "/assistant"`                             | adapt existing Vera | `source-complete; packaged-complete`                                                                                        |
| 旧 `/aletheia/*`                                | 保留编译和回归，主导航隐藏                                                     | retain              | `legacy; packaged regression complete`                                                                                      |

## 4. Projects 与 Documents

| 能力                            | Vera 活动实现                                                                      | 方式          | 状态                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| Projects 总览、新建、编辑、归档 | `(pages)/projects/page.tsx`、`ProjectsOverview.tsx`、`NewProjectModal.tsx`         | adapt         | `source-complete`                                                                 |
| Project 通用容器                | `(pages)/projects/[id]/layout.tsx`、`ProjectWorkspace.tsx`、`ProjectPageParts.tsx` | adapt         | `source-complete`：文档、对话、工作流和表格审阅均以 `project_id` 归属或限定上下文 |
| 文件夹、文档、版本和预览        | `ProjectDocumentsView.tsx`、`DocumentSidePanel.tsx`、shared directory/views        | direct/adapt  | `source-complete`                                                                 |
| 本地 Projects/Documents API     | `/api/v1/projects` 及其 nested documents/folders/version/retry routes              | rewrite       | `source-complete`                                                                 |
| 持久化、解析与加密存储          | Workspace repositories/services、`localWorkspaceBlobStore.ts`、统一 job pump       | reuse/rewrite | `source-complete; packaged-complete`                                              |

## 5. Assistant

| 能力                              | Vera 活动实现                                                                                     | 方式          | 状态                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------ |
| 全局 Assistant                    | `(pages)/assistant/page.tsx`、`assistant/chat/[id]/page.tsx`                                      | adapt         | `source-complete`                    |
| Project-scoped Assistant          | `(pages)/projects/[id]/assistant/**`                                                              | adapt         | `source-complete`                    |
| 对话、引用、停止、重试、重新生成  | `components/assistant/**`、typed SSE/client                                                       | adapt/rewrite | `source-complete`                    |
| Chat 与持久 generation API        | `workspaceChatsV1.ts`：`/chat`、`/assistant/jobs/**`                                              | rewrite       | `source-complete`                    |
| FTS retrieval、文档工具、模型调用 | `assistantRuntime.ts`、`assistantDocumentTools.ts`、`assistantModelAdapter.ts`、`modelGateway.ts` | reuse/rewrite | `source-complete`                    |
| 跨重启消息与事件恢复              | migration v10 durable assistant events + repositories                                             | rewrite       | `source-complete; packaged-complete` |

## 6. Workflows

| 能力                       | Vera 活动实现                                                                                             | 方式         | 状态                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------- |
| 全局/Project workflow 列表 | `(pages)/workflows/page.tsx`、`projects/[id]/workflows/page.tsx`、`VeraWorkflowList.tsx`                  | adapt        | `source-complete`                               |
| definition/editor/run UI   | `(pages)/workflows/[workflowId]/page.tsx`、`VeraWorkflowDefinitionEditor.tsx`、`VeraWorkflowRunPanel.tsx` | adapt        | `source-complete`；统一详情路由是有意的本地适配 |
| CRUD、隐藏和 capabilities  | `/api/v1/workflows/**`                                                                                    | rewrite      | `source-complete`                               |
| runs、cancel 和 retry      | `/api/v1/workflow-runs/**` 与 persisted `workflow_runs`/step runs/jobs                                    | rewrite      | `source-complete; packaged-complete`            |
| Mike system workflow seed  | `mikeSystemWorkflows.e32daad.ts` + checksum/source-lock；启动时固定验证 21 个模板                         | direct/adapt | `source-complete`                               |

## 7. Tabular Review

| 能力                             | Vera 活动实现                                                   | 方式            | 状态                                  |
| -------------------------------- | --------------------------------------------------------------- | --------------- | ------------------------------------- |
| 全局 review 列表/详情            | `(pages)/tabular-review/**`                                     | adapt           | `source-complete`；单数路由为有意适配 |
| Project-scoped reviews           | `(pages)/projects/[id]/tabular-reviews/**`                      | adapt           | `source-complete`                     |
| 列、cell retry/cancel、citations | `components/tabular/**` + typed Workspace client                | direct/adapt    | `source-complete`                     |
| persistence/generation           | `/api/v1/tabular-review/**`、`tabularRuntime.ts`、统一 job pump | rewrite         | `source-complete; packaged-complete`  |
| XLSX/CSV export                  | `tabularExport.ts` + 短期 download capability                   | adapt/rewrite   | `source-complete; packaged-complete`  |
| review chat                      | capability response `chat: false`；UI 不呈现假能力              | exclude from P0 | `excluded`                            |

## 8. Settings、模型与本地桌面控制

| 能力                                          | Vera 活动实现                                                                            | 方式                | 状态                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- | ------------------------------------ |
| Settings 页面                                 | `(pages)/settings/**`，含 General/Appearance、Models、Local Data/Diagnostics             | adapt/rewrite       | `source-complete`                    |
| model profile/selector/status                 | `components/models/**`、`ModelToggle.tsx`、`/api/v1/model-profiles/**`                   | adapt/rewrite       | `source-complete`                    |
| provider gateway                              | OpenAI、DeepSeek、Anthropic、Gemini 和 hardened OpenAI-compatible adapters；用户显式配置 | reuse/rewrite       | `source-complete`                    |
| 凭据存取                                      | `credentialWorker.js` + credential worker client + macOS Keychain                        | adapt existing Vera | `source-complete; packaged-complete` |
| backup/restore/logs/diagnostics               | 受控 preload/native bridge 与 Settings UI                                                | adapt existing Vera | `source-complete; packaged-complete` |
| SaaS account/security/connectors/API-key 页面 | 不进入本地 P0                                                                            | exclude             | `excluded`                           |

## 9. Auth、API composition 与 preload

| 边界               | Vera 活动实现                                                                                                                                   | 状态                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 本地鉴权           | loopback-only backend + 每次启动随机 bearer + fixed local principal                                                                             | `source-complete; packaged-complete` |
| API composition    | `veraApplication.ts` 在 `/api/v1` 只挂载一次，先 auth/mutation/upload policy，再挂 Settings、Assistant、Tabular、Workflows 和 Workspace routers | `source-complete`                    |
| renderer transport | `veraRuntime.ts`、`veraApi.ts`、`veraSse.ts`、`veraWireTypes.ts`；token 由 preload 提供                                                         | `source-complete`                    |
| preload            | 只暴露必要 token、backup/restore、日志、凭据和受控 native 能力；`window.aletheiaDesktop` 名称仅作为 Legacy 兼容边界                             | `source-complete; packaged-complete` |
| downloads          | `/api/v1/downloads/:token` + 短期 capability                                                                                                    | `source-complete; packaged-complete` |
| schema             | additive SQLCipher migrations v1-v16；不导入 Mike Postgres/RLS schema                                                                           | `source-complete`                    |

## 10. 明确排除的云端和多用户依赖

以下 `excluded` 是架构决定，不是延期后默认启用：

| Mike 能力                                  | Vera P0 替代/说明                              | 状态       |
| ------------------------------------------ | ---------------------------------------------- | ---------- |
| Supabase Auth/Postgres/RLS                 | SQLCipher repositories + fixed local principal | `excluded` |
| Cloudflare R2/S3                           | encrypted Workspace BlobStore                  | `excluded` |
| 登录、注册、MFA                            | 单用户桌面启动鉴权，无登录页                   | `excluded` |
| organisations、people、分享和 user lookup  | P0 不共享；Project 是单用户通用容器            | `excluded` |
| 数据库中的 provider secret                 | macOS Keychain-only credential store           | `excluded` |
| MCP/OAuth/connectors                       | P0 不提供                                      | `excluded` |
| CourtListener/case-law chat tools          | P0 只使用用户本地文档                          | `excluded` |
| workflow 发布/open-source submission/share | 本地 workflow CRUD/run，无发布/分享            | `excluded` |
| Cloudflare/browser deployment              | 不进入 P0 desktop runtime                      | `excluded` |

## 11. 阶段依赖与完成定义

```text
P1 local runtime + /api/v1
  -> P2 shell + Projects/Documents
      -> P3 Settings/model gateway
          -> P4 Assistant
              -> P5 Workflows
                  -> P6 Tabular Review
                      -> P7 fresh packaged desktop verification (complete)
```

Phase 0-6 已达到 `source-complete`。它要求：

- active route 使用真实本地 service/repository，不使用 production fixture；
- refresh/restart 所需状态进入持久层，错误、空态、取消和重试可观察；
- 云端/多用户依赖未进入新产品 import graph；
- 新 UI 和源码级产品标识显示 Vera；
- backend、frontend 和 desktop 对应 source gates 通过；
- Legacy 路由继续编译/回归，但新导航不调用它。

Phase 7 已在全新包满足以下条件后标记为 `packaged-complete`：

- 由当前源码重新构建、打包 Vera，而不是复用已有 `dist/`；
- packaged workspace E2E 跨应用重启验证 Project、至少两个文档、Assistant、Workflow 和 2×2 Tabular Review；
- packaged backup 与 restore fail-closed 通过；
- package hygiene、runtime security、SQLCipher、Keychain、日志和 diagnostic gates 通过；
- 明确记录该产物仍是 unsigned/unnotarized local-only，除非另行完成签名与公证。

## 12. 验证命令

### 12.1 固定来源

```bash
MIKE_SHA=e32daad5a4c64a5561e04c53ee12411e3c5e7238
test "$(git cat-file -t "$MIKE_SHA")" = commit
test "$(git show -s --format=%H "$MIKE_SHA")" = "$MIKE_SHA"
git show -s --format='source=%H date=%cs subject=%s' "$MIKE_SHA"
test ! -d mike
git diff --check
```

### 12.2 Source-complete 聚合门禁

```bash
npm run test:workspace:p0-client --prefix backend
npm run build --prefix backend

npm run test:p0-client --prefix frontend
npm run build --prefix frontend

npm run test:p0-source --prefix desktop
npm run test:sqlcipher-runtime --prefix desktop
npm run test:legacy-migration --prefix desktop
```

### 12.3 Phase 7：fresh packaged verification complete

```bash
./scripts/package-desktop-mac.sh

# 打包脚本中的关键验收；也可在 fresh artifact 上单独复跑：
npm run check:package-hygiene --prefix desktop
npm run test:packaged-app --prefix desktop
npm run test:packaged-workspace-e2e --prefix desktop
npm run test:packaged-backup --prefix desktop
npm run test:packaged-restore-fail-closed --prefix desktop
```

2026-07-15 的完整打包命令以 exit `0` 结束。`desktop/scripts/packagedWorkspaceE2E.js` 在 fresh Vera package 上完成了创建 Project、上传并解析至少两个文档、Assistant generation、Workflow、2 文档 × 2 列 Tabular Review，以及关闭并重新打开应用后的对象、引用和结果读取；packaged backup 与 restore fail-closed 也通过。

最终安全重跑还验证了：真实 packaged app 拒绝 application encryption
`disabled` 与 database encryption `metadata_plaintext`，均以 exit `1` 在本地
服务启动前失败；restore fail-closed 的隔离工作日志记录了
`startup_failed`，没有记录 `renderer_window_creating`，且前后端保持离线。

实际验收产物：

```text
relative app:      desktop/dist/mac-arm64/Vera.app
relative DMG:      desktop/dist/Vera-1.0.1-arm64.dmg (198122845 bytes)
relative ZIP:      desktop/dist/Vera-1.0.1-arm64.zip (200992113 bytes)
relative manifest: desktop/dist/Vera-1.0.1-SHA256SUMS.txt
```

实际并已复核的 manifest 内容：

```text
fd246214916b3485e25bb16c8e00bcf6e8be471ed95679190e7685a5c1c49ef8  Vera-1.0.1-arm64.dmg
7be4a9504151ddd8518141901e3d2753a1cda2fbe13ac27fa7842a9f3d347f1b  Vera-1.0.1-arm64.zip
```

该产物的发布边界仍为 `signed=false notarized=false distribution=local-only`。
