# Civil Litigation Domain Pack

## 1. 产品契约

Civil Litigation Domain Pack 将 Aletheia Kernel 配置为中国民商事诉讼事项工作区。目标用户是处理敏感材料、需要明确复核责任的诉讼律师和法律运营人员。

它不是法律聊天机器人、自治律师、法院电子诉讼客户端或法律正确性保证系统。当前仓库证明的是一个本地优先、来源可追溯、人工确认、版本化、审批约束和可确定性评测的原型。

## 2. 核心工作流

```text
事项与本地文档
-> SourceSpan
-> 事实 / 请求权与抗辩 / 要件 / 程序事件与期限候选
-> 人工确认或驳回
-> 五类确认态成果
-> 版本链与结构变化提示
-> 精确版本审批
-> 本地导出
-> Eval Lab 回归
```

另有一条可选模型路径：

```text
服务器编译确认态快照
-> 固定两步 litigation durable run
-> 健康的本地模型
-> 持久化 run / step / event / integrity 状态
```

## 3. 当前实现状态

### 3.1 已实现

- `civil_litigation` 事项模板和专用工作区。
- 七个工作视图：Overview、Facts & Evidence、Claims & Defenses、Procedural Clock、Documents & Hearing、Agent Run、Eval Lab。
- 事项内精确 `SourceSpan`：来源 chunk、chunk 内起止、文档绝对起止、quote、chunk SHA-256、quote SHA-256。
- 跨事项来源拒绝和非诉讼事项类型拒绝。
- 事实、请求权/抗辩、要件、程序事件和期限候选的 proposed、confirmed/rejected 状态及人工决定记录。
- 请求权/抗辩 -> 要件 -> 事实的 supports、contradicts、gap 关系。
- 五类只消费确认态数据的结构化成果。
- 每类成果的递增版本、父版本 ID 和内容哈希。
- 基于确认态依赖哈希的按成果类型 stale 传播和重新生成门禁。
- 相邻版本顶层字段变化提示。
- 绑定成果 ID、版本、内容哈希的审批后本地 DOCX 导出，并记录磁盘文件 SHA-256。
- 服务器拥有的固定诉讼 durable workflow；本地模型未就绪时返回 503，不回退云端，也不创建模拟运行。
- Eval Lab v2：3 个 golden cases 和 5 个 bad cases，结果及结果哈希持久化。
- 已确认/已完成期限可显式加入持久化 Work Queue；同一来源期限不会重复建任务，任务支持 open/completed、优先级、备注、完成和重新打开，并写入事项审计链。
- 全局 Work Queue 按逾期、今天、未来分组，并从任务链接回原事项的 Procedural Clock。
- 案卷支持文件/文件夹批量选择、逐文件处理状态、持久化失败记录和原件完整性校验后的解析重试。打包 macOS 客户端使用 Apple Vision + PDFKit 对缺少文字层的 PDF 页执行本地 OCR；按页合并并记录引擎、OCR 页数、文字层页数和平均置信度，低于 70% 时提示核对原件。helper 缺失、符号链接、输出结构无效或识别失败时文件保持明确阻塞，不伪装为可搜索。
- `Cmd/Ctrl+K` 可在当前用户的事项、文档名与索引正文、任务和诉讼成果之间做跨事项本地检索，并直接跳转到对应工作区。
- 已批准 DOCX 的下载会再次核对成果版本、内容哈希、审批和审计记录，解密后再交给 macOS 原生保存/打开流程；渲染层不读取内部密文路径。
- Work Queue 可将当前 open/completed 视图导出为标准 ICS；open 任务包含 7 天、1 天和 2 小时提醒。客户端运行期间，24 小时内到期或已逾期任务通过 SQLCipher 持久化 delivery ledger 领取最多 3 条带 10 分钟租约的提醒；仅在 macOS 确认 shown 后记录 delivered，失败每天最多重试 5 次。任务完成或 due time 变化时撤回旧 tag，failed/delivered/withdrawn 均写入事项审计链。

### 3.2 需配置

- Node.js/npm 依赖和本地数据目录。
- 单用户或 private-token 本地认证模式。
- 前端 API 地址和前后端端口。
- 若要实际执行 Agent Run，需要配置并通过健康检查的 loopback 本地模型 endpoint。支持 `ollama` 或 `openai-compatible` adapter。
- 健康检查不是诉讼运行授权。所选模型还必须在 Settings 运行版本化诉讼校准探针，并通过结构化 JSON 与中文逐字引文校验。Ollama 绑定 `/api/tags` 返回的模型 digest；OpenAI-compatible runtime 必须显式配置 immutable revision。校准结果持久化；缺失、失败、超过 30 天或模型、Reasoning、Fast mode 配置变化时，主分析和 reviewed synthesis 均在入队前返回 412，worker 执行前再次复检。

### 3.3 后续

- 多人角色分离、合议审批和律所组织权限。
- 服务端持久化的细粒度 JSON diff 与语义 diff。
- 经律师验证的程序规则、法条、判例和节假日计算数据集。
- 真实法院、邮件、日历、DMS 或客户系统连接。
- 当前 ICS 是显式文件导出，不是与 Apple Calendar、Exchange 或企业日历的双向同步；任务标题进入系统日历前仍需律师确认保密边界。
- 更大规模、专家标注的法律质量与鲁棒性评测。

## 4. 领域对象与判断边界

### 4.1 Matter State

工作区从事项详情和诉讼 profile 投影当前状态，展示待决定数量、确认事实、确认立场和下一确认期限。当前 Matter State 是操作视图，不是完备的诉讼案卷目录或法院权威状态。

### 4.2 SourceSpan

创建来源切片时，服务端必须验证：

- source chunk 属于当前用户和当前事项；
- `quoteStart`、`quoteEnd` 是 chunk 内非空合法范围；
- quote 由服务端按偏移切出，而不是信任客户端提交文本；
- 保存 chunk 与 quote 的 SHA-256；
- 保存 chunk 内和文档级偏移。

成果生成及导出前，服务端重新读取当前 chunk 并校验两个哈希和 quote。任一不一致均拒绝继续。这是来源完整性控制，不是证据真实性、合法性或证明力判断。

### 4.3 事实

事实可记录 statement、发生时间、日期精度、有利/不利属性、置信度和来源关系。Agent 或人可创建 proposed fact；只有人工决定后才进入 confirmed 或 rejected。已决定提案不能再次决定。

法律立场可记录请求权/抗辩/反驳类型、法律依据、定性置信度、实质不确定性和精确来源片段。来源片段保存原文偏移和哈希；来源变化时，依赖该来源的成果生成与导出失败关闭。没有精确来源的已确认法律立场会被明确标为未引用，不能进入最终法律论证成果导出。

已确认或已驳回的法律立场可发起事项内部复核：异议、重新考虑或撤回请求。每个立场同一时间只允许一个未决复核。复核人可维持原决定、驳回复核请求或准许请求；准许时更新立场状态。复核状态、获准后的立场状态和权威哈希链审计事件在同一数据库事务中提交，审计写入失败时整体回滚。请求人也可在处理前撤回复核请求。未决复核会阻断该立场被新成果依赖，并使已有成果过期。

每次人工确认或驳回均生成不可变法律评估版本，保存当时的法律依据、置信度、不确定性、决定理由、来源片段和来源哈希。复核请求绑定提交时的当前版本；目标版本过期时拒绝处理。准许复核会追加新版本，并以 `supersedes_id` 和复核 ID 连接旧版本，不覆盖历史评估。成果生成会校验当前版本指针、连续版本链和评估内容 SHA-256，任一异常均失败关闭。

已处理的一级复核可发起一次二级内部复核。服务端计算级别并绑定当前评估版本；同一一级决定只能有一个二级子项，禁止分叉和第三级请求。当前本地单用户模式无法提供真正的人员独立性，因此记录和界面均明确标注“非独立复核”，不能将其表述为独立申诉或法院上诉。

显式启用 private-token 多主体模式后，事项 owner 与当前 authenticated principal 分离。ACL 主体只有 `matter.read` 才能发现并读取事项；提出或撤回复核需要 `matter.write`，处理复核需要 `matter.review`。请求人不得处理自己的请求，二级处理人必须不同于一级处理人。诉讼记录继续按 owner 隔离，而 `created_by`、`resolved_by`、决定来源和审计详情记录真实主体。跨主体处理成功时才标记为独立复核。

该能力是律所事项内部的可申诉工作流，不等同于法院程序中的上诉。多级异议/申诉、独立版本化法律评估和 remand/supersession 状态仍属于后续范围。

### 4.4 请求权、抗辩与要件

当前支持 `claim`、`defense`、`rebuttal`，可记录法律基础、父请求权和举证责任方。请求权提案需要人工确认或驳回。

每个请求权可拆分为有顺序的要件；要件可链接确认事实并标记 supports、contradicts 或 gap。要件拥有独立 decision endpoint 和单次决定记录。成果构建时只选择已确认请求权、已确认要件和已确认事实，未确认或已驳回要件不会因所属请求权已确认而进入成果。

### 4.5 程序事件与期限

程序事件和 deadline candidate 均可带 `SourceSpan`。期限还保存 trigger event、rule label、rule version、calculation 和 due time。Agent 创建的候选项必须经人工确认后才能进入程序时钟成果。

当前系统保存并展示计算依据，但不内置全国统一程序期限规则库；Demo 中的规则与日期是合成材料和内部政策样例。

已确认或已完成期限可由律师加入工作队列。任务复制该期限的 due time，并保留不可变的 `source_deadline_id`。未确认、已驳回、跨事项或跨用户期限不能建任务；重复操作返回原任务，不静默覆盖任务标题、优先级或备注。完成和重新打开均为幂等操作并产生审计事件。任务是内部执行记录，不改变法院程序状态，也不代表系统已经验证期限计算正确。

## 5. 五类诉讼成果

| kind | 当前内容 | 生成约束 |
| --- | --- | --- |
| `evidence_catalog` | 确认事实及其来源关系 | 只使用已确认事实，来源重新验 hash |
| `claim_defense_matrix` | 已确认请求权/抗辩、要件、已确认事实关系、gap | 不把 proposed position 投影为结论 |
| `procedural_clock` | 已确认程序事件及 confirmed/completed deadlines | 保留规则和计算溯源 |
| `litigation_brief` | issues、material facts、procedural posture、按 gap 生成的 next actions | 是结构化案件提纲，不是可直接提交的诉状 |
| `hearing_plan` | hearing events、issues、deadline checklist、evidence gaps | 是庭审准备结构，不预测法庭或结果 |
| `hearing_bundle_index` | Exhibit 编号、原始文件 SHA-256、解析状态、页码/章节和精确引文 | 是可核验卷宗目录，不冒充已合并的法院提交卷宗 |

所有成果标记：

- `schemaVersion: aletheia-litigation-artifact-v1`；
- `statePolicy: confirmed_only`；
- `sourceIntegrity: verified`；
- 生成时发现的 evidence gap 作为 validation error 保留，不静默补全。

## 6. 版本、diff 与导出

每次生成同一种 kind：

- version 在当前事项和 kind 内递增；
- `parent_work_product_id` 指向前一版本；
- `content_hash` 对规范化内容计算；
- UI 比较最新与上一版本的顶层 key，忽略 `generatedAt`，显示变化字段或 `no material section changes`。

这里的“结构 diff”是顶层结构变化提示，不是段落级、JSON Patch 或法律语义 diff。

每个成果版本还保存该 kind 对应的确认态依赖哈希。事实、立场、要件、要件事实关系、程序事件或期限发生确认态变化后，服务器只标记依赖已改变的成果为 stale。stale 成果不能申请或执行导出，必须重新生成新版本。

导出流程为：

1. 请求 `litigation_artifact_export` 人工检查点；
2. payload 固定 `workProductId`、`version`、`contentHash`；
3. 人工批准；
4. 导出时重算成果 hash、重验来源、重验审批对象；
5. 生成可打开的通用专业 OOXML DOCX，写入 owner-only 权限的本地文件，并把格式、MIME、磁盘文件 SHA-256 写入 export/audit 记录；只有配置 `ALETHEIA_APPLICATION_ENCRYPTION=required` 时文件才使用 envelope encryption。该 DOCX 是工作底稿，不冒充特定法院或律所模板。
6. 文书与卷宗配置可选择批准的内置模板。模板 ID、版本和定义 SHA-256 写入工作产物并参与 dependency hash；模板变化使旧产物失效，导出时再次解析并核对哈希。
7. 事项可导入律所 DOCX 模板草稿。导入前拒绝宏、ActiveX、嵌入对象、custom XML、外部 relationship、压缩炸弹和未批准字段；文件使用本地 envelope encryption。草稿经 template ID + 文件 SHA-256 绑定的人工 checkpoint 和不少于 10 字符的理由批准后才可选择。导出再次解密、校验 OOXML/哈希并填充 `matter_title`、`artifact_title`、`organization_name`、`court`、`case_number`、`generated_at`、`content_hash`、`aletheia_body`。发布记录 independent/non-independent review；单用户客户端明确显示 non-independent。批准版本的退役同样要求绑定模板 ID、版本和文件哈希的人工 checkpoint；正在使用的版本不得退役，须先切换至另一批准版本。退役保留加密原件与审计历史，但不再允许新选择，以此支持不删除历史的版本回滚。当前模板仅在事项内可见，不宣称已实现律所级共享。

庭审卷宗目录只有在存在已确认庭审事件、全部入册来源保留原始文件 SHA-256、文件已完成解析且不存在证据要件 gap 时才可进入最终导出审批。目录中的 Exhibit 编号按当前确认状态确定，来源变化后成果会过期，必须重新生成。目录成果是 DOCX；卷宗包收集原件但不合并或重排原始证据文件，也不声称满足具体法院电子卷宗规范。

审批后可导出本地 ZIP 卷宗包。服务端从受保护存储中逐份解密读取原件，限制路径必须位于本地证据目录且不是符号链接，并重新计算明文 SHA-256；任何路径或哈希异常均整体拒绝导出。ZIP 包含目录 DOCX、按 Exhibit 编号命名的原始文件和不含内部存储路径的 `manifest.json`。它仍不重排原件页码，也不声称符合特定法院提交规范。

全部原件均有可信解析页数时，目录和 manifest 会生成连续的 source-sequence 页码区间及总页数；该区间只是原件原生页的顺序映射，不修改文件。任一原件没有稳定页数时，分页模式切换为 `source_native_only`，连续区间保持为空并在界面披露，不为 DOCX、XLSX 或纯文本伪造页码。

每个事项可保存卷宗 profile：机构名称、法院、案号、Exhibit 前缀、起始编号和分页策略。前缀仅允许 1-12 位 ASCII 字母、数字、下划线或连字符，起始编号限制为 1-9999。profile 进入成果 dependency hash，任何变更都会让既有卷宗目录和卷宗包过期；更新与哈希链审计事件同事务提交，多主体模式要求 `matter.write`。

旧版本批准不能授权新版本。该流程不会向法院、客户或第三方发送文件。

## 7. Server-Owned Durable Run

专用 endpoint 由服务器创建 `aletheia-civil-litigation-harness-v1`，客户端不能提交或修改执行步骤。服务器先编译确认态快照，再固定执行：

1. `analyze_confirmed_case_state`；
2. `prepare_hearing_checklist`。

两个步骤只使用 `local_model.generate` handler，具有固定重试和超时上限。durable executor 记录 run、step、lease、重试、取消、超时和带完整性链的事件。

入队前由服务器生成 `aletheia-litigation-agent-snapshot-v1`。快照只包含有精确来源的已确认事实和法律主张，排除开放复核中的主张，并绑定诉讼文书依赖哈希、快照 SHA-256、来源完整性状态和排除计数。客户端不能提交或替换该快照。来源哈希、法律评估版本链或当前指针异常时不创建 run。快照超过 750,000 UTF-8 字节时返回 422，不静默截断；大案卷需进入后续检索分批工作流。

两个诉讼步骤使用专用 `local_model.litigation_grounded` handler。模型必须返回结构化 JSON；摘要和每条 finding 都要引用 `snapshot.sources` 中的 source span ID、复制完整原文，并标注 high/medium/low confidence 和 uncertainty。服务端对原文计算 SHA-256 并与快照内 `quoteSha256` 比对。格式错误、空引用、快照外引用、原文改写/截断或缺失快照哈希会使当前 attempt 失败；只有通过服务端 ID 与原文哈希校验的结果才写为 succeeded。step output 保存结构化结果、引用 ID、原文、finding/citation 数量和快照哈希，UI 明示 `Citation IDs and exact quotes verified`；旧 run 只显示 legacy ID verification。这仍不证明引文在语义上支持结论；语义支持需律师复核和后续 entailment grader。律师问题可以不带引用，但不得混入 findings。

客户端启动、刷新或重新打开事项时，按当前用户、事项 ID 和固定诉讼 workflow 恢复最新 durable run，并重新调用 HMAC 事件链完整性检查。查询不接受客户端指定任意 workflow，跨用户或跨事项不返回 run。运行结果因此不是仅存在于当前 React 会话中的临时状态。

`succeeded` 只表示本地执行和机器校验完成，不表示律师采纳。律师可为具体 run 创建唯一的 Agent output review；创建前再次验证 HMAC 事件链，并绑定快照哈希和全部 grounded steps 的规范化输出哈希。决定只能是 adopted 或 returned，必须填写 10-2000 字符理由；决定时重新计算绑定，任何 step output、grounding 或 snapshot 变化都会拒绝。决定和 hash-chained audit event 在同一事务提交。团队模式要求 `matter.review`，请求人不能自批；单用户本地模式允许同一律师复核，但永久标记为 non-independent。刷新后复核状态和理由继续显示。

当完整快照超过当前本地模型的保守输入预算时，服务器不做不可逆摘要，而按有来源绑定的 fact、position、event 和 deadline 生成最多 24 个 `aletheia-litigation-agent-partition-v1` 分区。每个分区只包含该组对象及实际引用的 source spans，保存 parent snapshot hash、partition hash、字节数和序号，并独立执行 exact-quote grounding。单个对象超过预算、分区超过上限或没有任何 source-bound unit 时返回 422，且不创建 run。无来源对象计入 excluded count。分区结果不自动合成为“全案结论”，UI 明示分区数和该限制；全部分区可作为一个 hash-bound output review 的对象。

律师可填写最多 500 字符的 analysis focus。该文本只进入服务器端确定性词法排序，不成为客户端可控的 system prompt，也不改变收录集合。英文/数字 token、汉字单字和相邻双字在每个 unit 的结构化内容中计数，按 score 降序、原始序号稳定排序。每个 unit 保存 relevanceScore 和 originalIndex；partition/run 保存 focus、tokens、strategy=`deterministic_lexical_all_units` 和 omissionPolicy=`none`。空 focus 保持 source order。该分数只用于处理顺序，不表示证据权重、证明力或法律相关性判断。

跨分区综合只能由状态为 approved 的 Agent output review 启动。服务器重新验证父 run HMAC 事件链、复核绑定与当前输出哈希，读取每个 grounded step 的 structuredOutput，并从已采纳 citations 重新计算 exact quote hashes。输入包含 parent run/review/output/snapshot hashes、全部分区输出和去重引用；冲突原文、未采纳、内容变化、重复有效 synthesis 或超出当前模型预算均 fail closed。新 run 使用 `executionMode=reviewed_synthesis` 和单个 grounded synthesis step，必须保留冲突与 uncertainty，不能引入新法律或证据。其结果仍为未复核草稿，必须再走一次 Agent output review 才能采纳。

运行前提是本地模型已注册、仅监听允许的本地 endpoint 并通过健康检查。未配置或不健康时：

- 状态返回 unavailable；
- 新诉讼 run 返回 503；
- 不使用云模型；
- 不创建伪成功或模拟运行。

## 8. Eval Lab v6

当前 suite 为 `aletheia-litigation-eval-v6`，grader 为 `deterministic-litigation-grader 1.1.0`。所有用例读取持久化案件状态，不使用固定的模拟输入来制造通过结果。

Golden cases：

1. `confirmed_fact_source_coverage`；
2. `claim_element_fact_coverage`；
3. `confirmed_deadline_rule_provenance`。
4. `legal_assessment_lineage_integrity`；
5. `independent_review_actor_separation`；
6. `hearing_bundle_pagination_integrity`。
7. `grounded_agent_run_integrity`。
8. `agent_run_calibration_binding`。

Bad cases：

1. `source_hash_tamper_badcase`；
2. `missing_citation_badcase`；
3. `approval_bypass_badcase`；
4. `unconfirmed_element_projection_badcase`；
5. `stale_artifact_export_badcase`。
6. `open_review_projection_badcase`。
7. `agent_output_review_binding_badcase`。
8. `adopted_finding_support_review_badcase`。

每次运行保存 expected、actual、passed、grader 版本、evidence refs 和 result hash。当前 16 个用例用于验证数据和门禁不变量。v6 检查真实 succeeded Agent run 的 grounded handler、exact-quote 标记、step/snapshot 绑定、持久化模型校准绑定、output review 的规范化输出哈希、决定理由和人员溯源，以及每个已采用 finding 是否具有最新、内容哈希一致且明确为 supported 的逐项复核。引用缺失、来源哈希变化、审批绕过、待复核结论进入投影、finding 未复核/部分支持/不支持、复核人员不独立、卷宗分页无效、校准记录失效或 Agent/review 绑定变化时必须显示失败；评测构建异常也必须记录为失败，而不是中断或伪装通过。它不应被描述为模型能力排行榜、法律意见准确率或真实案件胜率。

## 9. 非目标

- 不提供法律意见或结果保证。
- 不替代中国执业律师、事项负责人或立案人员。
- 不自动确认期限、批准自己的产出、立案、外发、联系客户/对方或作出和解决定。
- 不宣称证据可采、来源真实、法条完整或程序计算普遍正确。
- 不覆盖刑事、行政、仲裁、执行、破产或跨境程序。
- 不宣称生产级多租户 SaaS、通用律所管理系统或法院连接能力。

## 10. 验收

```bash
cd backend
npm run test:aletheia:litigation-domain
npm run test:aletheia:litigation-tasks
npm run test:aletheia:litigation-export-integrity
npm run test:aletheia:durable-agent

cd ../frontend
env -u ALETHEIA_LOCAL_MODELS_JSON \
  -u ALETHEIA_LOCAL_MODEL_NAME \
  -u ALETHEIA_OLLAMA_MODEL \
  npx playwright test tests/aletheia-litigation-workspace.spec.ts \
  --project=desktop-chromium
```

详细提交口径见 `docs/litigation_submission_plan.md`；8 分钟演示见 `docs/litigation_demo_script.md`。
