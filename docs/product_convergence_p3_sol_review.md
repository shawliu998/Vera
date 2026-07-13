# Vera 产品收束 P3 Sol 视觉主审

日期：2026-07-12

## 结论

**Sol 结论：PASS**

命令面板已收束为民商事诉讼信息架构，只保留新建案件、打开案件、打开工作队列和设置四个真实入口；旧的 `Search Evidence` 与 `Command Center` 已移除。面板标签、提示、加载、空态、错误态、重试、结果分组、已知状态和更新时间均使用中文。`fact`、`position`、`deadline` 已进入稳定结果顺序，并使用后端 canonical href。

对象定位现支持 `document`、`fact`、`position`、`deadline`、`task`、`artifact`。解析只接受白名单类型、最长 128 字符的安全 ID；解析后只在当前案件已加载集合中按 ID 和 `matter_id` 解析。外案、缺失和错视图统一显示“未找到该对象，当前显示本模块最新状态”，不回显 key 或外案标题。

阻断级 FAIL：无。

## 截图证据

| 证据 | 结果 | 主审记录 |
|---|---|---|
| `docs/screenshots/product-convergence-p3-2026-07-12/01-global-search-1440x1000.png` | PASS | 案件、案卷、事实、请求权与抗辩、期限等分组层级清楚；已知状态为中文；无旧命令、渐变、光晕、玻璃效果或横向溢出。 |
| `docs/screenshots/product-convergence-p3-2026-07-12/01-global-search-393x1200.png` | PASS | 393px 下搜索框、关闭按钮、结果标题、状态和案件上下文均未遮挡；长结果列表在面板内纵向滚动。 |
| `docs/screenshots/product-convergence-p3-2026-07-12/02-position-focus-1440x1000.png` | PASS | canonical `position:<id>` 精确定位请求权抗辩行；仅用深色左边框与浅灰背景提示，不改变原工作台层级。 |
| `docs/screenshots/product-convergence-p3-2026-07-12/02-position-focus-393x1200.png` | PASS | 聚焦请求权抗辩在窄屏自然重排，无横向滚动、文字裁切或控件遮挡。 |

## 测试结果

- `npm run lint`：PASS
- `npx tsc --noEmit`：PASS
- `npx tsx --test tests/aletheia-command-palette.test.ts`：PASS，2/2
- `npm run build`：PASS
- `VERA_CAPTURE_P3=true npx playwright test tests/aletheia-command-palette.spec.ts tests/aletheia-product-convergence.spec.ts --config=playwright.config.ts --project=desktop-chromium`：PASS，14/14

Playwright 覆盖四个真实快捷命令、七类搜索结果、中文请求状态和已知状态、canonical href 导航，以及六类对象深链。`fact`、`position`、`deadline` 覆盖直接 URL、同页 history、浏览器前进后退、恶意值、超长值、错视图、缺失 ID、外案 deadline、清除定位和主视图切换。桌面与 393px 截图测试同时检查页面无横向溢出和聚焦容器在视口宽度内。

## 剩余限制

1. 搜索结果标题、摘要和案件名称来自后端业务数据，前端不翻译其内容；未声明的新状态统一显示“状态未知”。
2. 窄屏七分组结果必须在命令面板内纵向滚动；单张截图只能显示当前可视部分，自动化测试验证全部分组存在。
3. 案件列表和工作台中仍有既有英文业务文案；本轮只收束命令面板及对象定位，不扩展到全产品汉化。
4. 本轮未修改后端；前端依赖 workspace deadline 记录持续提供后端已存在的 `matter_id` 字段，并对不属于当前案件的记录 fail closed。
5. 自动化验证键盘焦点、滚动目标、历史导航和宽度边界，不据此声称完整 WCAG 合规。
