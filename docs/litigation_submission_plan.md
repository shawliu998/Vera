# DeepSeek AGI 管培生申请：民事诉讼工作区提交计划

## 1. 提交目标

本提交用一个可运行的中国民商事诉讼工作区，说明高风险专业场景中的 Agent 产品不应只追求“生成答案”，还应把来源、人工判断、版本、审批、执行状态和评测证据做成产品的一部分。

一句话定位：

> Aletheia 是面向敏感专业工作的本地优先 Agent Harness；Civil Litigation Domain Pack 将其落到事实、证据、请求权、程序时钟、诉讼成果、审批和评测的一体化工作区。

申请材料只主张仓库中可运行、可检查的原型能力，不主张法律正确性、自动立案、法院系统接入、生产级 SaaS 或普遍适用的中国程序规则库。

## 2. 证据口径

所有公开表述使用以下三种状态：

- **已实现**：仓库中有实现，并可由命令、界面、持久化记录或审计脚本复现。
- **需配置**：代码路径已实现，但需要本地模型、端口、认证或数据目录等运行环境。
- **后续**：目标合理但当前没有充分实现证据，不进入已完成功能清单。

若演示结果与文字冲突，以当前仓库、验收命令和实际运行结果为准。

## 3. 当前提交范围

| 能力 | 状态 | 可展示证据 | 边界 |
| --- | --- | --- | --- |
| Civil litigation workspace | 已实现 | Overview、Facts & Evidence、Claims & Defenses、Procedural Clock、Documents & Hearing、Agent Run、Eval Lab | 当前是代表性单事项原型，不是律所 ERP |
| `SourceSpan` | 已实现 | chunk 内精确起止偏移、文档绝对偏移、原文、chunk SHA-256、quote SHA-256 | 证明来源切片完整性，不证明来源内容真实或法律上可采 |
| 事实与请求权/抗辩确认 | 已实现 | proposed -> confirmed/rejected，记录决定人、时间和意见，已决定提案不可重复决定 | Agent 不得自我批准 |
| 要件与事实关系 | 已实现 | claim -> element -> fact，关系为 supports/contradicts/gap；要件独立 proposed -> confirmed/rejected | Agent 创建的要件必须由人单独决定后才能进入成果 |
| 程序事件与期限确认 | 已实现 | 事件和 deadline candidate 的来源、规则名、规则版本、计算说明及确认 | 期限规则是演示/人工提供，不是全国法院规则引擎 |
| 五类诉讼成果 | 已实现 | evidence catalog、claim and defense matrix、procedural clock、litigation brief、hearing plan | 由服务器从已确认状态确定性投影，不等同于模型完成的诉状正文 |
| 来源完整性 fail closed | 已实现 | 生成和导出前重算 source chunk/quote hash；不一致时拒绝 | 仅覆盖被成果引用的本地来源链 |
| 成果版本链 | 已实现 | 递增 version、`parent_work_product_id`、`content_hash` | 当前结构 diff 比较相邻版本的顶层字段，不是语义 diff |
| 成果依赖与 stale 传播 | 已实现 | 每类成果保存确认态依赖哈希；事实、立场、要件、关系、事件或期限变化后只标记受影响成果 stale | stale 成果必须重新生成，不能请求或执行导出 |
| 审批绑定本地导出 | 已实现 | 审批 payload 绑定 `workProductId + version + contentHash`；生成 DOCX 并记录磁盘文件 SHA-256 | 当前是通用专业工作底稿，不是法院格式诉状；不执行法院提交或外发 |
| Server-owned durable litigation run | 已实现，运行需配置 | 服务端固定两步执行图、确认态快照、重试/超时/取消、持久化事件链 | 需要健康的本地 Ollama 或 OpenAI-compatible endpoint；无云端回退 |
| 无本地模型 fail closed | 已实现 | 状态页显示 unavailable；API 返回 503；不创建模拟运行 | 基线 Demo 建议展示此路径，保证可重复 |
| Eval Lab | 已实现 | 固定 suite v2、3 个 golden + 5 个 bad case、持久化结果和 result hash | 是小型确定性回归集，不代表法律质量基准或模型综合评测 |

## 4. 产品与架构叙事

```text
Local matter documents
        |
        v
Deterministic chunks -> SourceSpan(offsets + hashes)
        |
        v
Proposed facts / positions / procedural events / deadlines
        |
        v
Human confirmation or rejection
        |
        +-----------------------------+
        |                             |
        v                             v
Confirmed-state artifact builder   Server-owned durable run
        |                           (healthy local model required)
        v                             |
Version + parent + content hash       v
        |                         Durable run/step/event records
        v
Approval bound to exact version/hash
        |
        v
Local DOCX export (owner-only; optional envelope encryption) + audit record

Persisted matter state -> deterministic Eval Lab -> 3 golden + 5 bad cases
```

架构上刻意区分两条路径：

1. **确定性成果路径**：五类成果由服务器读取已确认事项状态后构建，不依赖模型，便于重放和验收。
2. **模型分析路径**：诉讼 Agent Run 由服务端固定工作流定义，只允许本地模型 handler；本地模型未配置或健康检查失败时拒绝接收运行。

## 5. 关键技术判断

### 5.1 先做判断边界，再做生成能力

事实、请求权/抗辩、要件、程序事件和期限先进入 proposed 状态，人工逐项确认后才能进入成果投影。这样牺牲了“全自动”的演示感，但避免模型草稿悄然成为权威案情。

### 5.2 引用需要可验证的坐标和哈希

只保存文档名或一段引用文本不足以抵抗错位和来源变化。`SourceSpan` 同时保存 chunk 内偏移、文档偏移、原文以及两级 SHA-256；成果生成与导出重新计算哈希，变化时失败关闭。

### 5.3 审批必须绑定对象，而不是绑定按钮动作

“某人曾点击批准”不能授权后续任意版本。导出检查点绑定成果 ID、版本和内容哈希；生成新版本或内容变化后，旧批准不能复用。

### 5.4 客户端不能定义高风险 Agent 执行图

诉讼运行的 workflow、确认态输入、两个步骤、handler、重试和超时由服务器拥有。客户端只能请求启动或取消，不能替换 prompt handler 或扩大工具集合。

### 5.5 确定性评测先于模型裁判

当前 Eval Lab 不让模型评价自己。它用固定 grader 检查确认事实来源覆盖、要件事实覆盖、期限规则溯源，并用来源篡改、缺失引用、绕过审批、未确认要件投影和 stale 成果导出五个 bad case 验证防线。

## 6. 提交物

- `docs/deepseek_agi_submission.md`：申请正文与能力边界。
- `docs/litigation_demo_script.md`：8 分钟逐步 Demo、预演和故障切换。
- `docs/domain_packs/civil_litigation.md`：领域包产品契约与当前实现状态。
- 本文件：提交范围、证据口径、技术判断和验收门槛。
- 可运行代码证据：领域审计、durable audit、Playwright 诉讼工作区验收。

## 7. 8 分钟演示结构

完整台词和操作见 `docs/litigation_demo_script.md`。时间分配如下：

| 时间 | 内容 | 要证明的判断 |
| --- | --- | --- |
| 0:00-0:40 | 定位与非目标 | 不是法律聊天机器人，也不自动提交 |
| 0:40-1:20 | 打开事项总览 | 工作流状态优先于聊天历史 |
| 1:20-2:20 | 事实与 `SourceSpan` | 结论可回到精确原文并由人确认 |
| 2:20-3:10 | 请求权、要件、事实关系 | 法律分析被拆成可检查结构 |
| 3:10-4:00 | 程序事件与期限 | 期限是带来源和规则版本的候选项 |
| 4:00-5:30 | 五类成果、版本和 diff | 只消费确认态；版本链和 hash 可见 |
| 5:30-6:30 | 审批绑定导出 | 批准精确版本，随后本地导出 |
| 6:30-7:05 | Agent Run fail closed | 没有健康本地模型就不伪造运行 |
| 7:05-7:40 | Eval Lab 8/8 | golden 与 bad case 均有确定性证据 |
| 7:40-8:00 | 限制与下一步 | 诚实界定原型价值和待补能力 |

## 8. 验收命令

以下命令从仓库根目录执行；首次运行前需要在 `backend` 和 `frontend` 分别完成 `npm ci`。

```bash
cd backend
npm run test:aletheia:litigation-domain
npm run test:aletheia:litigation-export-integrity
npm run test:aletheia:durable-agent
```

桌面浏览器端到端验收会自动创建隔离数据目录、启动后端、构建前端并播种诉讼事项。清除本地模型变量是为了稳定验证 fail-closed 基线：

```bash
cd frontend
env -u ALETHEIA_LOCAL_MODELS_JSON \
  -u ALETHEIA_LOCAL_MODEL_NAME \
  -u ALETHEIA_OLLAMA_MODEL \
  npx playwright test tests/aletheia-litigation-workspace.spec.ts \
  --project=desktop-chromium --project=mobile-chromium
```

预期结果：

- 领域审计输出 `"ok": true`，覆盖 SourceSpan、隔离、确认态投影和来源篡改失败关闭。
- durable audit 输出 `"ok": true`，覆盖原子领取、崩溃恢复、重试、超时、取消和 HMAC 事件链。
- 诉讼导出完整性审计实际导出一个成果，并证明篡改审批关联后失败关闭。
- Playwright 输出 `2 passed`，覆盖桌面/移动端人工确认、v1/v2、stale 传播、审批导出、无模型 fail closed 和 Eval Lab `8/8`。

这些命令证明原型行为，不证明具体法律意见正确。

本地核验记录（2026-07-10）：领域审计 `ok: true`，durable audit `ok: true`，桌面与移动端 Playwright `2 passed`。核验时未配置本地模型，因此浏览器用例验证的是 fail-closed 基线，不是模型生成质量。

## 9. 后续工作

以下项目不得写成当前能力：

- 角色分离、合议审批和多审批人策略；
- 对任意历史版本的服务端结构 diff 和语义 diff；
- 真实中国法规则库、节假日/送达/延期规则引擎及律师验证数据集；
- 法院电子诉讼平台、邮箱、日历或客户系统连接；
- 更大规模的法律专家标注 Eval、模型间对比和持续回归门槛；
- 多用户权限、组织级密钥运维、灾备与生产部署验证；
- 合格电子签名、第三方时间戳或证书链，以及能够证明独立复核的多主体签署。当前仅提供哈希绑定、不可变的应用内律师签署收据。
- 法院/律所模板驱动的诉状、证据目录和庭审提纲排版，以及 Word 内可追踪修订。
- macOS Developer ID 签名、notarization 与正式发行验证；当前 unpacked app 只用于本机验证。

## 10. 提交门槛

只有在四份文档表述一致、三项验收命令通过、8 分钟演示完成一次干跑，并且所有截图/录屏都来自合成数据时，才将其作为 DeepSeek AGI 管培生申请材料提交。
