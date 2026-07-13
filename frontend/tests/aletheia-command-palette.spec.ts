import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const results = [
  {
    kind: "task",
    id: "task-1",
    matterId: "matter-1",
    matterTitle: "Northstar Acquisition",
    title: "Confirm disclosure schedule",
    snippet: "Review the final disclosure schedule before signing.",
    status: "open",
    updatedAt: "2026-07-11T08:30:00.000Z",
    href: "/aletheia/matters/matter-1/litigation?view=procedure&focus=task%3Atask-1",
  },
  {
    kind: "fact",
    id: "fact-1",
    matterId: "matter-1",
    matterTitle: "华辰公司买卖合同纠纷",
    title: "2026 年 6 月 3 日完成交货",
    snippet: "送货单与签收记录相互印证。",
    status: "confirmed",
    updatedAt: "2026-07-11T08:40:00.000Z",
    href: "/aletheia/matters/matter-1/litigation?view=facts&focus=fact%3Afact-1",
  },
  {
    kind: "position",
    id: "position-1",
    matterId: "matter-1",
    matterTitle: "华辰公司买卖合同纠纷",
    title: "对方已构成逾期付款",
    snippet: "依据买卖合同第 8 条主张逾期付款责任。",
    status: "proposed",
    updatedAt: "2026-07-11T08:35:00.000Z",
    href: "/aletheia/matters/matter-1/litigation?view=positions&focus=position%3Aposition-1",
  },
  {
    kind: "deadline",
    id: "deadline-1",
    matterId: "matter-1",
    matterTitle: "华辰公司买卖合同纠纷",
    title: "提交证据目录期限",
    snippet: "按法院通知于 2026 年 7 月 20 日前提交。",
    status: "confirmed",
    updatedAt: "2026-07-11T08:32:00.000Z",
    href: "/aletheia/matters/matter-1/litigation?view=procedure&focus=deadline%3Adeadline-1",
  },
  {
    kind: "document",
    id: "document-1",
    matterId: "matter-1",
    matterTitle: "Northstar Acquisition",
    title: "Merger Agreement.pdf",
    snippet: "Section 4.2 contains the closing conditions.",
    status: "parsed",
    updatedAt: "2026-07-10T12:00:00.000Z",
    href: "/aletheia/matters/matter-1/litigation?view=facts&focus=document%3Adocument-1",
  },
  {
    kind: "matter",
    id: "matter-1",
    matterId: "matter-1",
    matterTitle: "Northstar Acquisition",
    title: "Northstar Acquisition",
    snippet: "Cross-border acquisition review",
    status: "in_progress",
    updatedAt: "2026-07-11T09:00:00.000Z",
    href: "/aletheia/matters/matter-1/litigation?view=overview",
  },
  {
    kind: "work_product",
    id: "work-product-1",
    matterId: "matter-1",
    matterTitle: "Northstar Acquisition",
    title: "Closing risk memo",
    snippet: "Draft memo summarizing unresolved closing risks.",
    status: "needs_review",
    updatedAt: "2026-07-09T14:00:00.000Z",
    href: "/aletheia/matters/matter-1/litigation?view=artifacts&focus=artifact%3Awork-product-1",
  },
] as const;

test("global search palette covers shortcuts, request states, and keyboard navigation", async ({
  page,
}) => {
  const requestedQueries: string[] = [];
  await page.route("**/aletheia/search?*", async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get("q") ?? "";
    requestedQueries.push(query);
    expect(url.searchParams.get("limit")).toBe("40");

    if (query === "failure") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "The search index is restarting." }),
      });
      return;
    }
    if (query === "missing") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ query, results: [], total: 0 }),
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ query, results, total: results.length }),
    });
  });

  await page.goto("/aletheia/matters");
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog", {
    name: "全局搜索与命令",
  });
  const input = dialog.getByRole("combobox");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("快捷命令")).toBeVisible();
  await expect(
    dialog.getByRole("option", { name: /新建案件/ }),
  ).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(4);
  await expect(dialog.getByText("Search Evidence")).toHaveCount(0);
  await expect(dialog.getByText("Command Center")).toHaveCount(0);

  await input.fill("a");
  await page.waitForTimeout(300);
  expect(requestedQueries).toEqual([]);
  await expect(dialog.getByText("快捷命令")).toBeVisible();

  await input.fill("merger");
  await expect(dialog.getByRole("status")).toContainText("正在搜索");
  await page.waitForTimeout(100);
  expect(requestedQueries).toEqual([]);
  await expect(dialog.getByText("案件", { exact: true })).toBeVisible();
  await expect(dialog.getByText("案卷", { exact: true })).toBeVisible();
  await expect(dialog.getByText("事实", { exact: true })).toBeVisible();
  await expect(dialog.getByText("请求权与抗辩", { exact: true })).toBeVisible();
  await expect(dialog.getByText("期限", { exact: true })).toBeVisible();
  await expect(
    dialog.getByTestId("search-group-label-task"),
  ).toContainText("待办");
  await expect(
    dialog.getByText("工作产品", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("已确认", { exact: true })).toHaveCount(2);
  await expect(dialog.getByText("待确认", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Merger Agreement.pdf")).toBeVisible();

  if (process.env.VERA_CAPTURE_P3 === "true") {
    const screenshotDir = path.resolve(
      process.cwd(),
      "..",
      "docs",
      "screenshots",
      "product-convergence-p3-2026-07-12",
    );
    mkdirSync(screenshotDir, { recursive: true });
    for (const viewport of [
      { width: 1440, height: 1000, suffix: "1440x1000" },
      { width: 393, height: 1200, suffix: "393x1200" },
    ]) {
      await page.setViewportSize(viewport);
      await expect(dialog).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBeTruthy();
      await page.screenshot({
        path: path.join(
          screenshotDir,
          `01-global-search-${viewport.suffix}.png`,
        ),
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  await input.fill("failure");
  await expect(dialog.getByRole("alert")).toContainText("搜索暂时不可用");
  await expect(dialog.getByRole("alert")).toContainText("当前未显示任何搜索结果");
  await expect(dialog.getByRole("alert")).not.toContainText("search index");

  await input.fill("missing");
  await expect(dialog.getByText("未找到结果")).toBeVisible();

  await input.fill("merger");
  await expect(dialog.getByText("Merger Agreement.pdf")).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(
    /\/aletheia\/matters\/matter-1\/litigation\?view=facts&focus=document%3Adocument-1$/,
  );

  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(dialog).toBeHidden();
});
