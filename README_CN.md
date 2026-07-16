# Vera 本地通用法律工作空间

Vera 是一个单用户、本地优先、以 Matter 为中心的 macOS 法律工作空间。它在同一个加密桌面运行时中组合文档、OCR、Assistant、Workflow、Document Studio、引用、DOCX 与备份恢复能力。

## 当前产品真源

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

当前 `main` 基线是 `5611699e46552a20bf42ce84396a8e65aa139d16`，Workspace migration 最高版本是 v17。`Project` 仍是文档、对话、Workflow run、Tabular Review 与 Studio Draft 的技术所有者；`Matter` 是其上的法律工作语义与 Profile/Policy 投影，不引入第二套数据系统。

## 已接线能力

- Electron 管理一个 loopback Next.js renderer 和一个 loopback Express backend；renderer 保持 sandbox 与 context isolation。
- 一个 SQLCipher Workspace 数据库、加密 Blob、Keychain 模型凭证、加法 migration、备份与恢复。
- 支持 OpenAI、DeepSeek、Anthropic、Gemini 和受约束的 OpenAI-compatible 模型配置。
- 持久 Assistant job、流式响应、Stop/Retry/Regenerate、跨重启恢复和有界工具循环。
- Matter/Project 文档上传、解析与 OCR；支持 PDF、扫描 PDF、DOCX、TXT、MD、XLSX。
- Source Snapshot/Citation Anchor、Document Studio、版本、AI suggestion、接受/拒绝、DOCX 导入导出。
- Matter Profile、显式 workspace classification 与统一 inference policy。

当前 Assistant 正式工具仅覆盖本地文档读取/检索以及兼容 Studio 文档的读取和修改建议。法律检索、创建 Draft 与 Workflow 工具仍属于本轮待实现能力，详见 [`docs/local_legal_work_agent_vertical.md`](docs/local_legal_work_agent_vertical.md)。

## 法律数据源状态

仓库保留法宝与元典的 Legacy 适配器和失败处理合同，但生产激活门保持关闭。本机没有足以证明 live acceptance 的官方接口材料、完整授权权利矩阵、合法测试账号或凭证。因此 Vera **不声称任何真实法律 Provider 已接通**，也不会猜测 endpoint、使用浏览器 Cookie、抓包、网页爬虫或私有接口。

测试中的 deterministic fake Provider 只能证明合同和失败处理，不能替代真实 Provider 验收。激活所需材料见 [`docs/legal_provider_activation_requirements.md`](docs/legal_provider_activation_requirements.md)。

## 本地构建

```bash
npm install
npm run bootstrap
npm run build
```

macOS 本地包：

```bash
VERA_RELEASE_SIGNING=false ./scripts/package-desktop-mac.sh
```

当前 packaged acceptance 只证明本机 unsigned、unnotarized、local-only 构建和跨重启链路；它不是 Developer ID 签名、notarized 或可公开分发的发布证明。

## 开发与发布状态

- 简短事实状态：[`docs/status.md`](docs/status.md)
- 本轮纵向计划：[`docs/local_legal_work_agent_vertical.md`](docs/local_legal_work_agent_vertical.md)
- 路线图：[`docs/roadmap_legal_workspace.md`](docs/roadmap_legal_workspace.md)
- 桌面与发布门：[`docs/desktop_app.md`](docs/desktop_app.md)
- 许可证与来源：[`docs/license_attribution.md`](docs/license_attribution.md)

Legacy `/aletheia/*` 仅在显式兼容开关下使用。它不是当前默认导航、默认运行时或新功能的主存储。
