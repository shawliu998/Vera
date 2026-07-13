# Vera 法律研究手工来源 Sol 视觉主审

日期：2026-07-13

## 结论

**Sol 结论：PASS**

“导入本地法律资料”位于既有法律研究第 3 阶段，以可折叠的普通表单融入候选来源与本地快照区域。未新增导航、模态框或装饰卡片；延续现有灰阶边框、紧凑字号和原生表单控件。

界限表达准确：表单明确说明“本地保存，不会联网”“律师手工导入，尚未自动核验”“导入后仍需逐字确认摘录”。手工快照显示为“律师手工导入 · 尚未自动核验”，不显示可点击来源地址，也未被表述为官方、授权或已核验资料。

## 流程检查

1. **可用性门禁：PASS。** 仅当前研究请求具备不可变案卷上下文且已保存当前争点树时可提交；缺上下文时引导重新建立研究事项并选择已确认案卷输入，缺争点树时沿用“请先保存当前争点树”的恢复语言。
2. **失败状态：PASS。** 以失效日期早于生效日期向真实本地后端提交，得到 HTTP 400；表单保留输入并显示就地错误，不创建快照，不保留虚假成功提示。
3. **成功状态：PASS。** 修正日期后向真实本地后端提交，得到 HTTP 201。请求体严格只有 `documentId`、`title`、`content`、`documentKind`、`version`、`effectiveDate`、`effectiveTo`、`publicationDate`；响应为 `vera-legal-source-snapshot-v1`、`provider=manual_import`、`verificationStatus=captured_unverified`，并绑定当前 request、case context 和 issue tree。
4. **摘录交接：PASS。** 成功后重新读取 matter/work products/snapshots，折叠导入表单，将视图和键盘焦点移到新快照的“精确原文摘录”。后续仍沿用精确摘录、输入清单、memo、人工复核和批准链。来源更新后由服务端标记的 stale memo 在前端显示“已过期”，不可继续复核或采纳。

## 截图证据

| 证据 | 结果 | 主审记录 |
|---|---|---|
| `docs/screenshots/ui-audit-2026-07-13-research-manual-source/01-manual-source-error-desktop-1440.png` | PASS | 1440 × 1000；表单与既有阶段标题、检索区域和下一阶段保持清晰层级，错误紧邻提交动作，无重叠或横向溢出。 |
| `docs/screenshots/ui-audit-2026-07-13-research-manual-source/02-manual-source-success-desktop-1440.png` | PASS | 成功提示、手工未核验标识和摘录入口同屏可见；焦点环明确，远程“来源地址”未出现在手工快照。 |
| `docs/screenshots/ui-audit-2026-07-13-research-manual-source/01-manual-source-error-narrow-393.png` | PASS | 393 CSS px 窄窗；日期字段自然单列，按钮与错误完整可见，页面无横向滚动。 |
| `docs/screenshots/ui-audit-2026-07-13-research-manual-source/02-manual-source-success-narrow-393.png` | PASS | 快照元数据、正文折叠项、两个摘录字段和确认按钮纵向重排，无裁切、遮挡或文字溢出。 |

首轮桌面成功态截图因 Chromium 未完成重绘出现黑块，已拒绝该证据；加入稳定等待后重新采集并逐张检查，表中路径均为接受版本。

## 键盘与可访问性

- Playwright 使用键盘 `Enter` 展开表单并提交失败/成功两种状态。
- 输入均有可访问标签；法规和司法解释的生效日期使用原生 `required`；提交中按钮禁用并显示进行中标签。
- 失败使用 `role=alert`，提交中和成功使用 `role=status`；开始后续工作流动作时清除已完成的导入提示，避免多个成功状态同时播报。
- 成功后焦点进入新快照的精确摘录文本框。截图和自动化不能证明完整读屏器兼容性，未宣称达到完整无障碍合规。

## 验证结果

- `cd frontend && npm run lint`：PASS
- `cd frontend && npx tsc --noEmit`：PASS
- `cd frontend && npm run build`：PASS
- `cd frontend && npx playwright test tests/vera-legal-research.spec.ts --config=playwright.config.ts --grep "imports manual sources through the real local backend"`：PASS，desktop 1440 与 mobile 393 共 2/2
- `cd frontend && npx playwright test tests/vera-legal-research.spec.ts --config=playwright.config.ts --project=desktop-chromium --grep "imports manual sources through the real local backend"`：PASS，重采集桌面证据 1/1

focused Playwright 未模拟手工导入接口；成功和失败均由当前本地后端返回。测试同时断言严格请求体、后端绑定字段、失败不落快照、成功刷新、无手工来源链接、摘录焦点和横向溢出。

## 限制

- 本轮未修改后端、`docs/status.md`、导航或其他工作台。
- 浏览器测试未做独立网络抓包；“不会联网”的证据来自调用专用本地导入接口、请求体不含 URL/query plan/verification/hash，以及后端返回的 `manual_import` 快照投影。
- 未在浏览器测试中重建完整 memo 后再更新同一 `documentId`；前端已按服务端 `stale_at`/`stale_reason` 投影禁用旧 memo 的继续复核和采纳。
- 窄窗证据为 Pixel 5 项目的 393 CSS px 视口；PNG 按设备像素比输出。
