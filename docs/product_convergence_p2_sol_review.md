# Vera 产品收束 P2 Sol 视觉主审

日期：2026-07-12

## 结论

**Sol 结论：PASS**

对象级深链已在既有五模块工作台内形成可感知、可恢复的律师工作流。文档、任务和工作产品均能在数据加载后滚动到精确容器，并以克制的左边框和浅灰背景提示定位状态；键盘焦点同步进入目标容器。历史工作产品不会冒充当前版本，界面明确显示“搜索命中 v2，当前版本 v3”。桌面与 393px 窄屏截图未发现横向溢出、控件遮挡或聚焦内容裁切。

阻断级 FAIL：无。

## 截图证据

| 证据 | 结果 | 主审记录 |
|---|---|---|
| `docs/screenshots/product-convergence-p2-2026-07-12/01-historical-artifact-focus-1440x1000.png` | PASS | 历史命中定位到该类最新工作产品；版本说明、当前状态、审批信息和操作层级清楚。聚焦使用细边框与浅灰背景，无渐变、光晕、玻璃或装饰卡。 |
| `docs/screenshots/product-convergence-p2-2026-07-12/01-historical-artifact-focus-393x1200.png` | PASS | 聚焦工作产品在窄屏自然重排；长 hash 省略、说明文字换行、操作纵向排列，未观察到横向滚动、文字裁切或按钮遮挡。 |

## 发现与修复

1. **P1：URL focus 可能进入不安全选择器。** 已改为严格解析，仅接受 `document`、`task`、`artifact` 与最长 128 字符的受限安全 ID。未知类型、超长和恶意值直接忽略；DOM 查找只使用固定属性选择器，再逐项比较安全解析后的 key。
2. **P1：对象定位缺少稳定容器与可访问焦点。** 文档行、任务关联期限行和工作产品容器均提供稳定 `data-object-focus-key` 与 `tabIndex=-1`；数据加载后滚动到目标并设置程序化焦点。
3. **P1：任务行只显示队列状态。** 关联 `DeadlineRow` 现明确显示任务标题及“待办 / 已完成 / 已失效”状态，避免仅以 “In work queue” 代替对象身份。
4. **P1：历史工作产品可能被误认作当前版本。** 历史 ID 只用于确认搜索命中来源，实际定位到同类最新版本，并明确显示命中版本与当前版本。
5. **P1：错视图、已删除或非当前案件对象缺少恢复路径。** 统一显示“未找到该对象，当前显示本模块最新状态”，提供“清除定位，留在当前模块”；不额外请求对象详情，不泄露其他案件是否存在。
6. **P2：窄屏工作产品长 hash 造成内容列固有宽度过大。** 已为内容列补充 `min-w-0`，使 hash 正确省略、普通说明正常换行。修复后重新生成两档截图并通过宽度边界检查。

## 测试

- `npm run lint`：PASS
- `npx tsc --noEmit`：PASS
- `npm run build`：PASS
- `npx playwright test tests/aletheia-command-palette.spec.ts tests/aletheia-product-convergence.spec.ts --config=playwright.config.ts --project=desktop-chromium`：PASS，13/13
- `VERA_CAPTURE_P2=true npx playwright test tests/aletheia-product-convergence.spec.ts --config=playwright.config.ts --project=desktop-chromium --grep "focused work product fits"`：PASS，1/1，并生成 1440×1000 与 393×1200 真实运行截图。

Playwright 覆盖后端 href 导航、document/task/当前 artifact/历史 artifact 聚焦、浏览器后退与前进、同页 query 更新、非法值忽略、错 view 与缺失对象 fail closed、主视图切换清除 focus，以及两档视口的水平边界和目标容器可见性。

## 审查边界

本轮只审查既有诉讼工作台内的对象级深链，不新增页面，不扩展事实、请求权、期限或文书业务能力。跨案件对象按“当前案件未找到”统一处理，审查不据此证明或泄露其他案件对象是否存在。截图确认视觉层级、换行、裁切和遮挡；自动化确认 URL、DOM 焦点、滚动目标与恢复行为，但不据此声称完整 WCAG 合规。命令面板沿用后端返回 href，本轮未做全局汉化。
