# Vera 法律数据源设置 Sol 视觉主审

日期：2026-07-12

## 结论

**Sol 结论：PASS**

法律数据源位于既有 `Tools & Keys` 设置分组内，未增加主导航、卡片或营销文案。北大法宝与威科先行沿用普通设置行、输入框和保存/移除按钮；官方来源不提供密钥入口。

状态严格以后端投影为准。应用层加密、端点、白名单或 credential reference 任一未被明确确认时，输入及操作均禁用并显示“不可用”；GET 失败显示“法律数据源配置不可用”。设置页不调用 provider test，不展示已保存密钥，提交后清空输入。

阻断级 FAIL：无。

## 截图证据

| 证据 | 结果 | 主审记录 |
|---|---|---|
| `docs/screenshots/ui-audit-2026-07-12-legal-source-settings/desktop-1200x900.png` | PASS | 法律数据源保持在既有设置内容层级内；标签、状态、输入和操作对齐，无新增卡片、pill、渐变或玻璃效果。 |
| `docs/screenshots/ui-audit-2026-07-12-legal-source-settings/mobile-393x1200.png` | PASS | 393px 下两个来源自然纵向重排，输入和按钮完整可见；页面无横向溢出，顶栏、标题、导航和控件无互相遮挡。 |

## 验证结果

- `npm run lint`：PASS
- `npx tsc --noEmit`：PASS
- `npm run build`：PASS
- `npx playwright test tests/aletheia-settings.spec.ts --config=playwright.config.ts --project=desktop-chromium --grep "legal source secrets"`：PASS，1/1

focused Playwright 覆盖 GET 投影、secret PUT 请求体、提交后清空输入、DELETE、GET 错误态、未配置端点 fail closed、过滤官方来源以及不调用 `/test`。桌面与 393px 截图同时断言页面和法律数据源区域无横向溢出。

## 边界

本轮未修改后端、desktop、docker、CI 或 `docs/status.md`。受控部署仍负责提供端点、白名单、应用层加密能力和 credential reference；前端不会推断或补齐缺失能力。
