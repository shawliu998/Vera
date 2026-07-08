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
6. 打开 Compliance 和 Deal Due Diligence 模板页，展示可迁移的工作流结构。

## 当前实现

- Legal Matter Review：完整 mock MVP。
- Compliance Impact Review：结构化 mock workflow。
- Deal Due Diligence Memo：结构化 mock workflow。
- 数据库迁移：`backend/migrations/20260708_01_aletheia_workspace.sql`，包含 matters、documents、work products、evidence、reviews、audit events。
- Agent Runtime 迁移：`backend/migrations/20260708_02_aletheia_agent_runtime.sql`，包含 agent runs、steps、tool calls、human checkpoints。
- 后端 API：`/aletheia/matters`，支持事项列表、创建事项、读取事项详情、保存结构化 work product、添加 review、追加 audit event。
- 新建事项会自动生成 deterministic Initial Agent Plan work product，让真实事项从可复核的工作流脚手架开始。
- 后端持久化已切到 Aletheia repository 边界；当前默认 adapter 仍是 Supabase/Postgres，但已经有 local adapter skeleton，后续可接 SQLite + filesystem。
- Matter Queue 当前是混合数据模式：先显示 deterministic demo matters，再尝试从 Aletheia API 读取真实数据库 matters；后端或 Supabase 未配置时自动保持 demo fallback 可用。
- Demo workspace 支持本地导出 Audit Pack 和 Feedback Eval Dataset，方便展示可复核交付物与 badcase/eval 闭环。
- 所有 mock 数据集中在 `frontend/src/aletheia`。

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

## 许可证与归因

本项目保留原开源项目许可证和归因说明。详见 `docs/license_attribution.md`。
