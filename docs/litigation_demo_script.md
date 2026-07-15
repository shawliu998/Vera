# Aletheia Civil Litigation Workspace：8 分钟 Demo 脚本

## 1. Demo 目标

在 8 分钟内证明四点：

1. Agent 提案与律师确认态严格分开；
2. 诉讼成果可追溯到精确来源，并有版本和审批身份；
3. 模型不可用或来源/审批不满足时系统 fail closed；
4. 关键不变量有固定 golden/bad cases 回归。

不要声称法律正确性、自动立案、法院连接、真实客户部署或生产就绪。

## 2. 演示模式

主脚本使用**无本地模型基线**。其优点是无需外部下载或模型启动，并能稳定展示 durable run 的 fail-closed 行为。

可选增强模式是在演示前配置健康的 Ollama 或 OpenAI-compatible 本地 endpoint。该模式可展示真实两步持久化运行，但模型输出和时延不稳定，不应替代主脚本中的确定性证据。

## 3. 预演准备

### 3.1 安装依赖

```bash
export REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT/backend"
npm ci

cd "$REPO_ROOT/frontend"
npm ci
```

### 3.2 创建隔离 Demo 数据

建议在启动服务前播种；命令输出会给出 `matterId` 和 `matterUrl`。

```bash
cd "$REPO_ROOT/backend"
ALETHEIA_AUTH_MODE=single_user \
ALETHEIA_DATA_DIR=.data/deepseek-litigation-demo \
npm run seed:aletheia:litigation-demo
```

如果同一目录已经演示过，seed 会复用同名事项。需要完全干净的演示时，换一个新的 `ALETHEIA_DATA_DIR`，不要在录屏前临时删除不确定的数据目录。

### 3.3 启动后端

主脚本显式不配置模型：

```bash
cd "$REPO_ROOT/backend"
env -u ALETHEIA_LOCAL_MODELS_JSON \
  -u ALETHEIA_LOCAL_MODEL_NAME \
  -u ALETHEIA_OLLAMA_MODEL \
  ALETHEIA_AUTH_MODE=single_user \
  ALETHEIA_DATA_DIR=.data/deepseek-litigation-demo \
  npm run dev
```

### 3.4 启动前端

```bash
cd "$REPO_ROOT/frontend"
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 npm run dev
```

打开 seed 输出的完整地址，例如：

```text
http://127.0.0.1:3000/aletheia/matters/<matterId>/litigation
```

### 3.5 演示前检查

- 浏览器缩放 100%，窗口至少 1280 x 800。
- 页面标题是 `Aletheia Litigation Demo`。
- Overview 显示 4 个 pending decisions。
- Agent Run 显示 `Local executor unavailable`。
- 不使用真实客户材料；seed 数据为合成纠纷。
- 关闭通知、聊天浮窗和可能泄露个人信息的浏览器侧栏。

## 4. 逐分钟脚本

### 0:00-0:40 定位

**操作**：停留在 Overview。

**讲述**：

> 这不是一个自动给出法律结论的聊天机器人。我做的是本地优先的诉讼 Agent 工作区：模型可以提案，但来源、人工确认、版本、审批、执行失败和 Eval 都是产品的一等对象。今天只展示仓库已实现的原型，不声称法律正确性或自动立案。

**画面证据**：七个工作视图、事项名称、pending decisions。

### 0:40-1:20 事项状态

**操作**：指向 Confirmed facts、Confirmed positions、Next confirmed deadlines 和 pending decisions。

**讲述**：

> 工作区首先回答案件当前确认了什么、还有什么需要人决定，而不是要求律师从聊天记录重建状态。这个合成事项当前有五项待确认：一个事实、一个抗辩立场、一个要件、一个程序事件和一个期限候选。

**不要说**：系统已经完整管理案件全生命周期。

### 1:20-2:20 事实、精确来源与人工确认

**操作**：

1. 点击 `Facts & Evidence`。
2. 找到付款日事实。
3. 展示来源原文 `争议款项约定付款日为2026年9月1日`。
4. 点击该事实的 `Confirm`。

**讲述**：

> 这条事实不是孤立文本。服务端保存来源 chunk、精确起止偏移、引用原文、chunk hash 和 quote hash；来源必须属于当前事项。生成成果和导出时会重新计算 hash，来源变化就拒绝继续。现在由人确认，pending decisions 从 5 变成 4。

**边界说明**：

> 哈希证明引用没有静默错位或变化，不证明这份材料本身真实、合法或可采。

### 2:20-3:10 请求权、要件与事实关系

**操作**：

1. 点击 `Claims & Defenses`。
2. 展示抗辩 `The payment obligation was not due...`。
3. 展示要件 `Agreed payment due date` 和已链接事实。
4. 点击抗辩行的 `Confirm`。
5. 单独点击要件行的 `Confirm`。

**讲述**：

> 我没有让模型直接输出一篇看起来完整的案件分析，而是把立场拆成请求权或抗辩、要件和事实关系。抗辩与要件需要分别确认；只有已确认立场、已确认要件和已确认事实关系会进入成果。

### 3:10-4:00 程序事件与期限候选

**操作**：

1. 点击 `Procedural Clock`。
2. 展示 `Court hearing notice received` 的开庭通知原文并确认。
3. 展示 `Complete internal evidence review` 的 trigger、rule version 和 calculation 并确认。

**讲述**：

> 日期不是抽出来就变成权威期限。程序事件和期限候选分别需要人工确认；期限还保存触发事件、规则名、规则版本和计算说明。这里是合成通知和内部规则样例，不是全国法院程序规则引擎。

**画面证据**：pending decisions 最终为 0。

### 4:00-5:30 五类成果、版本和结构 diff

**操作**：

1. 点击 `Documents & Hearing`。
2. 快速指出五类成果名称。
3. 对 `Claim and defense matrix` 点击 `Generate`。
4. 展示 v1、verified sources、validation items 和 content hash。
5. 点击 `Create new version`。
6. 展示 v2 和 `Compared with v1: no material section changes`。
7. 可展开 structured output，指出 `statePolicy: confirmed_only` 和 `sourceIntegrity: verified`。

**讲述**：

> 这五类成果由服务器从确认态确定性构建，所以即使没有模型也可复现。每次生成都有递增版本、父版本和内容 hash。这里的 diff 是相邻版本顶层结构比较，不是法律语义 diff；相同输入得到 v2 时，界面明确显示没有实质字段变化。

### 5:30-6:30 精确版本审批与本地导出

**操作**：

1. 对 `Litigation brief` 点击 `Generate`。
2. 点击 `Request export approval`。
3. 点击 `Approve export`。
4. 点击 `Export approved DOCX`。
5. 展示 `Approved DOCX ready`，点击 `Save DOCX` 或 macOS 客户端中的 `Save and open`，确认 Word 可识别该文件。
6. 指出内部加密存储路径不会返回给渲染层；保存前下载接口会重新验证审批、版本、hash 和密文完整性。
7. 新建并确认一个抗辩提案，再回到 `Documents & Hearing`。
8. 展示 matrix 与 brief 的 `Stale` 状态和消失的导出审批按钮。
9. 对 matrix 点击 `Regenerate`，展示新版本恢复为可审批状态。

**讲述**：

> 审批不是一个可复用的“批准过”标志。检查点绑定 work product ID、版本和 content hash；导出和每次下载前都会重算成果、来源和依赖 hash，并核对导出审计记录。确认态变化后，受影响成果会变成 stale，旧批准不能授权新版本。客户端从加密 envelope 解出经过 OOXML 签名检查的 DOCX，再通过系统保存面板交付；它不会连接法院或发送给第三方。

### 6:30-7:05 Durable Agent fail closed

**操作**：点击 `Agent Run`，展示 `Local executor unavailable` 和 `No cloud fallback is used and no simulated run is created.`。

**讲述**：

> 诉讼 Agent 的两步执行图由服务器固定，只读取确认态快照。今天没有配置本地模型，所以系统返回不可用，不回退云模型，也不伪造一条成功运行。代码路径支持健康本地模型后的持久化重试、超时、取消和完整性事件链，但它属于需配置能力。

### 7:05-7:40 Eval Lab

**操作**：

1. 点击 `Eval Lab`。
2. 点击 `Run deterministic suite`。
3. 展示 `8/8`、suite version、result hash。
4. 指出三个 golden 和五个 bad case，尤其是 missing citation、approval bypass、unconfirmed element projection 与 stale artifact export。

**讲述**：

> 目前先用固定 grader 锁住系统不变量，不让模型评价自己。三个 golden 检查来源覆盖、要件事实覆盖和期限规则溯源；五个 bad case 还检查来源篡改、缺失引用、绕过审批、未确认要件投影和 stale 成果导出。八个用例很小，所以我只把它称为回归集，不称为法律质量基准。

### 7:40-8:00 收尾

**操作**：回到 Overview 或保持 Eval 结果。

**讲述**：

> 这个原型的价值不在于宣称已经自动化诉讼，而在于把高风险 Agent 必须具备的边界做成可运行系统：来源可验、判断逐项由人确认、依赖变化会让成果过期、审批绑定版本、失败不伪装、坏例可回归。下一步是真实规则与专家 Eval、合议审批，以及组织级权限和部署验证。

## 5. 可选：配置本地模型后的运行展示

仅在演示前完成模型下载和健康检查后使用。示例为 Ollama；模型名需与本机实际安装一致：

```bash
cd "$REPO_ROOT/backend"
ALETHEIA_AUTH_MODE=single_user \
ALETHEIA_DATA_DIR=.data/deepseek-litigation-demo \
ALETHEIA_LOCAL_MODEL_NAME=qwen3:8b \
ALETHEIA_LOCAL_MODEL_ID=default-local \
ALETHEIA_LOCAL_MODEL_ADAPTER=ollama \
ALETHEIA_LOCAL_MODEL_ENDPOINT=http://127.0.0.1:11434 \
npm run dev
```

只有 Agent Run 页面显示 `Executor ready` 时才演示启动。说明两步工作流由服务器固定、只读取确认态快照；不要把模型输出当成已审批诉讼成果，也不要承诺固定响应时间。

## 6. 应急切换

| 问题 | 处理 | 仍可证明的内容 |
| --- | --- | --- |
| 本地模型未启动 | 按主脚本展示 unavailable | fail-closed 和无云回退 |
| 页面状态被上次演示改变 | 换新的 `ALETHEIA_DATA_DIR` 并重新 seed | 完整 golden path |
| 前端端口被占用 | 用 `npm run dev -- -p 3002`，并按实际 URL 打开 | 所有产品能力 |
| 生成后 validation items 非零 | 展开并解释缺口被保留 | 不静默补全 |
| 录屏时间不足 | 跳过展开 JSON，保留确认、审批、fail closed、Eval | 四个核心判断 |

不要通过直接修改 SQLite、删除审批记录或预先伪造 Eval 截图修复演示。

## 7. 演示后验收

```bash
cd "$REPO_ROOT/backend"
npm run test:aletheia:litigation-domain
npm run test:aletheia:litigation-export-integrity
npm run test:aletheia:durable-agent

cd "$REPO_ROOT/frontend"
env -u ALETHEIA_LOCAL_MODELS_JSON \
  -u ALETHEIA_LOCAL_MODEL_NAME \
  -u ALETHEIA_OLLAMA_MODEL \
  npx playwright test tests/aletheia-litigation-workspace.spec.ts \
  --project=desktop-chromium --project=mobile-chromium
```

预期为两个后端审计 `ok: true`，以及桌面和移动端 Playwright `2 passed`。
