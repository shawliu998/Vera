# Aletheia 明证

Aletheia 明证 是一个面向高风险专业服务的 Agent Workspace。

它把复杂文档转化为可验证、可复核、可审计的专业工作产品。

这不是普通法律聊天机器人。Aletheia 明证 展示的是 Agent 如何支持法律案件审阅、合规影响评估、交易尽调等真实工作流，并通过证据绑定、人审和审计留痕建立可信闭环。

## 演示路径

1. 打开 `/aletheia`。
2. 使用 Aletheia 二级导航：Matters、Templates、Evidence、Reviews、Audit。
3. 查看 Legal Matter Review 示例 matter。
4. 依次展示 Agent Plan、Issue Map、Evidence Matrix、Draft Memo、Human Review、Audit Log、Feedback Summary。
5. 在 demo workspace 内导出 Audit Pack JSON 和 Feedback JSON。
6. 打开 Compliance 和 Deal Due Diligence 模板页展示工作流结构；也可以创建本地 matter，上传材料后生成 source-linked Compliance Register 和 Red Flag Memo。

## 当前实现

- Legal Matter Review：完整 local-first MVP，包含真实文档上传、检索、证据映射、Issue Map、Evidence Matrix、Draft Memo、人审和审计导出。
- Compliance Impact Review：本地 source-linked workflow，支持从上传的法规/控制材料生成 Compliance Register。
- Deal Due Diligence Memo：本地 source-linked workflow，支持从上传的 VDR/合同材料生成 Red Flag Memo。
- 本地 SQLite 仓储：包含 matters、documents、work products、evidence、reviews、audit events，以及持久 Agent runs、steps、tool calls 和 human checkpoints。
- 后端 API：`/aletheia/matters` 和 `/aletheia/tool-adapter`，支持事项列表、创建事项、读取事项详情、保存结构化 work product、添加 review、追加 audit event、本地文档上传与检索、证据落库、Evidence Matrix、Draft Memo、审批 checkpoint、Matter Memory、Matter Playbooks，以及最小权限 Tool Adapter 调用。
- 新建事项会自动生成 deterministic Initial Agent Plan work product，让真实事项从可复核的工作流脚手架开始。
- 后端持久化已切到 Aletheia repository 边界；纯本地产品只使用 SQLite/filesystem 实现，支持 matters、work products、source-linked evidence items、reviews、audit events、agent runs、Matter Memory、Matter Playbooks 的本地持久化，并支持本地文档上传、文本解析、chunk、SQLite FTS5 搜索、检索结果证据落库、Evidence Matrix work product 生成、Legal Draft Memo、Compliance Register、Red Flag Memo 生成、Final Memo 人审门控、Agent Run Trace 可视化和 Audit Pack 人审审批门控。
- Aletheia Tool Adapter 已提供最小权限工具面：`list_matters`、`read_matter`、`search_matter_documents`、`read_evidence_item`、`create_work_product`、`add_review_tag`、`append_audit_event`、`export_audit_pack`。默认不开放 terminal、browser、外部 web search、email 或破坏性文件操作。
- 本地模式会把 Audit Pack、Feedback Export、Final Memo 等 export 类 work product 写入 `.data/aletheia/exports/<matterId>/`，并在 audit event 中记录路径。
- Matter Queue 当前是混合数据模式：先显示 deterministic fallback matters，再尝试从 Aletheia API 读取真实数据库 matters；后端或本地 auth 未配置时自动保持 local fallback 可用。
- Demo workspace 支持审批后导出 Audit Pack、Feedback Eval Dataset 和 Final Memo，方便展示可复核交付物与 badcase/eval 闭环。
- 离线演示和截图用的 deterministic fallback fixtures 集中在 `frontend/src/aletheia`；真实 local-first 链路已经支持上传材料、解析、检索、证据映射、人审和审计导出。

## 本地运行

```bash
cd frontend
npm install
npm run dev
```

访问：

```text
http://localhost:3000/aletheia
```

当前 demo 不依赖外部 API key。

当前阶段、阻塞项和发布前验证以 `docs/status.md` 为准。

## 许可证与归因

本项目保留原开源项目许可证和归因说明。详见 `docs/license_attribution.md`。
