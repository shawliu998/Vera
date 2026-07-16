import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

type SmokeState = {
  projects: Record<string, Record<"litigation", { matterId: string }>>;
  backendPort: number;
};

function smokeState() {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), ".next-ui-smoke-state.json"), "utf8"),
  ) as SmokeState;
}

function uiCaptureEnabled() {
  return process.env.ALETHEIA_SKIP_UI_CAPTURE !== "true";
}

async function captureScreenshot(page: Page, filePath: string) {
  if (!uiCaptureEnabled()) return;
  await page.screenshot({ path: filePath, fullPage: true });
}

async function captureViewportScreenshot(page: Page, filePath: string) {
  if (!uiCaptureEnabled()) return;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: filePath });
}

test("法律研究 imports manual sources through the real local backend and fails closed without credentials", async ({ page }, testInfo) => {
  const matterId = smokeState().projects[testInfo.project.name].litigation.matterId;
  if (testInfo.project.name.startsWith("desktop")) {
    await page.setViewportSize({ width: 1440, height: 1000 });
  } else {
    expect(page.viewportSize()?.width).toBe(393);
  }
  await page.goto(`/aletheia/matters/${matterId}/litigation?view=research`);
  const workbench = page.getByTestId("legal-research-workbench");
  await expect(workbench).toBeVisible();

  await page.getByText("新建本地研究事项", { exact: true }).click();
  await page.getByLabel("事项名称").fill("买卖合同解除通知研究");
  await page.getByLabel("内部法律问题").fill("解除通知在何种条件下生效，举证责任如何分配？");
  await expect(page.getByLabel("案件事实摘要")).toHaveCount(0);
  const saveRequestButton = page.getByRole("button", { name: "保存到本案" });
  await expect(saveRequestButton).toBeDisabled();
  const factSelection = page.getByTestId("research-fact-selection");
  const proceduralSelection = page.getByTestId("research-procedural-event-selection");
  const factCheckboxes = factSelection.getByRole("checkbox");
  const proceduralCheckboxes = proceduralSelection.getByRole("checkbox");
  const hasFact = await factCheckboxes.count() > 0;
  expect(hasFact || await proceduralCheckboxes.count() > 0).toBeTruthy();
  if (hasFact) await factCheckboxes.first().check();
  else await proceduralCheckboxes.first().check();
  await expect(saveRequestButton).toBeEnabled();
  await expect(workbench).toContainText("共选择 1 项案卷输入");

  const screenshotDir = path.resolve(
    process.cwd(),
    "../docs/screenshots/ui-audit-2026-07-12-research-case-context",
  );
  if (uiCaptureEnabled()) mkdirSync(screenshotDir, { recursive: true });
  const suffix = testInfo.project.name.startsWith("mobile") ? "narrow-393" : "desktop";
  if (suffix === "narrow-393") expect(page.viewportSize()?.width).toBe(393);
  else expect(page.viewportSize()?.width).toBe(1440);
  await page.getByTestId("legal-research-request-form").scrollIntoViewIfNeeded();
  await captureScreenshot(
    page,
    path.join(screenshotDir, `research-request-case-context-${suffix}.png`),
  );
  const createRequest = page.waitForRequest((request) =>
    request.method() === "POST" &&
    new URL(request.url()).pathname.endsWith(`/matters/${matterId}/research/requests`),
  );
  await saveRequestButton.click();
  const createPayload = (await createRequest).postDataJSON() as Record<string, unknown>;
  expect(createPayload).toMatchObject({
    title: "买卖合同解除通知研究",
    jurisdiction: "中华人民共和国",
    question: "解除通知在何种条件下生效，举证责任如何分配？",
  });
  expect(createPayload).not.toHaveProperty("facts");
  expect(createPayload.factIds).toEqual(hasFact ? [expect.any(String)] : undefined);
  expect(createPayload.proceduralEventIds).toEqual(hasFact ? undefined : [expect.any(String)]);
  await expect(workbench).toContainText("买卖合同解除通知研究");
  await expect(workbench).toContainText("案卷输入已绑定");
  await expect(workbench).toContainText("共选择 0 项案卷输入");
  await expect(page.getByRole("status")).toContainText("尚未发生网络请求");

  const issueTree = page.getByTestId("legal-research-issue-tree");
  await expect(issueTree.getByLabel("核心争点")).toHaveValue("解除通知在何种条件下生效，举证责任如何分配？");
  await issueTree.getByRole("button", { name: "添加子争点" }).click();
  await issueTree.getByLabel("子争点").fill("解除通知的到达与生效时间");
  await issueTree.getByLabel("状态").last().selectOption("needs_material");
  const providerSelect = page.getByLabel("授权数据源");
  await expect(providerSelect.locator('option[value="official"]')).toHaveText("官方来源（仅明确授权的来源专属接口）");
  await providerSelect.selectOption("official");
  await page.getByPlaceholder("仅填写公开法律概念，不粘贴案件事实").fill("民法典 买卖合同 解除通知 生效 举证责任 某某公司");
  await page.getByPlaceholder("当事人、项目代号、案号").fill("某某公司");
  const previewButton = page.getByRole("button", { name: "生成脱敏预览" });
  await expect(previewButton).toBeDisabled();
  await expect(page.getByTestId("research-query-issue-required")).toContainText("请先保存当前争点树");

  const convergenceScreenshotDir = path.resolve(process.cwd(), "../docs/screenshots");
  if (uiCaptureEnabled()) mkdirSync(convergenceScreenshotDir, { recursive: true });
  await captureScreenshot(
    page,
    path.join(convergenceScreenshotDir, `product-convergence-research-issue-required-${suffix}.png`),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  const saveIssueResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/research\/requests\/[^/]+\/issues$/.test(new URL(response.url()).pathname),
  );
  await issueTree.getByRole("button", { name: "保存本地争点树" }).click();
  const savedIssueTree = await saveIssueResponse;
  const savedIssueTreeBody = await savedIssueTree.json() as { id: string };
  await expect(page.getByRole("status")).toContainText("检索词仍需律师另行填写");
  await expect(previewButton).toBeEnabled();

  const manualScreenshotDir = path.resolve(
    process.cwd(),
    "../docs/screenshots/ui-audit-2026-07-13-research-manual-source",
  );
  if (uiCaptureEnabled()) mkdirSync(manualScreenshotDir, { recursive: true });
  const manualImport = page.getByTestId("manual-legal-source-import");
  const manualSection = manualImport.locator("xpath=..");
  const manualSummary = manualImport.locator("summary");
  await manualSummary.focus();
  await page.keyboard.press("Enter");
  await expect(manualImport).toHaveAttribute("open", "");
  await expect(manualImport).toContainText("本地保存，不会联网");
  await expect(manualImport).toContainText("律师手工导入，尚未自动核验");
  await expect(manualImport).toContainText("导入后仍需逐字确认摘录");
  await manualImport.getByLabel("本地编号").fill("local-civil-code-563");
  await manualImport.getByLabel("标题", { exact: true }).fill("中华人民共和国民法典第五百六十三条（本地资料）");
  await manualImport.getByLabel("资料类型").selectOption("statute");
  await manualImport.getByLabel("法律资料正文").fill("第五百六十三条 有下列情形之一的，当事人可以解除合同：当事人一方迟延履行债务或者有其他违约行为致使不能实现合同目的。");
  await manualImport.getByLabel("版本（可选）").fill("2021-01-01");
  await manualImport.getByLabel("生效日期", { exact: true }).fill("2021-01-01");
  await manualImport.getByLabel("失效日期（可选）").fill("2020-12-31");
  await manualImport.getByLabel("发布日期（可选）").fill("2020-05-28");
  const importButton = page.getByRole("button", { name: "导入并保存快照" });
  await expect(importButton).toBeEnabled();

  const rejectedImportResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/research\/requests\/[^/]+\/manual-sources$/.test(new URL(response.url()).pathname),
  );
  await importButton.focus();
  await page.keyboard.press("Enter");
  expect((await rejectedImportResponse).status()).toBe(400);
  const manualError = manualSection.getByRole("alert");
  await expect(manualError).toContainText("失效日期不得早于生效日期");
  await expect(manualSection.getByText("本地快照已保存。请继续逐字确认摘录。")).toHaveCount(0);
  await expect(workbench.getByText("中华人民共和国民法典第五百六十三条（本地资料）", { exact: true })).toHaveCount(0);
  await manualError.scrollIntoViewIfNeeded();
  await captureViewportScreenshot(
    page,
    path.join(manualScreenshotDir, `01-manual-source-error-${suffix === "desktop" ? "desktop-1440" : suffix}.png`),
  );

  await manualImport.getByLabel("失效日期（可选）").fill("2026-12-31");
  const successfulImportResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/research\/requests\/[^/]+\/manual-sources$/.test(new URL(response.url()).pathname),
  );
  await importButton.focus();
  await page.keyboard.press("Enter");
  const importedResponse = await successfulImportResponse;
  expect(importedResponse.status()).toBe(201);
  expect(importedResponse.request().postDataJSON()).toEqual({
    documentId: "local-civil-code-563",
    title: "中华人民共和国民法典第五百六十三条（本地资料）",
    content: "第五百六十三条 有下列情形之一的，当事人可以解除合同：当事人一方迟延履行债务或者有其他违约行为致使不能实现合同目的。",
    documentKind: "statute",
    version: "2021-01-01",
    effectiveDate: "2021-01-01",
    effectiveTo: "2026-12-31",
    publicationDate: "2020-05-28",
  });
  const importedBody = await importedResponse.json() as {
    id: string;
    schema_version: string;
    content: Record<string, unknown> & { snapshot: Record<string, unknown> };
  };
  expect(importedBody.schema_version).toBe("vera-legal-source-snapshot-v1");
  expect(importedBody.content).toMatchObject({
    requestId: expect.any(String),
    issueTreeId: savedIssueTreeBody.id,
    caseContextId: expect.any(String),
    provider: "manual_import",
    documentId: "local-civil-code-563",
    verificationStatus: "captured_unverified",
    snapshot: {
      documentKind: "statute",
      sourceType: "manual_import",
      effectiveDate: "2021-01-01",
      caseVerificationStatus: "unverified",
    },
  });
  expect(importedBody.content).not.toHaveProperty("queryPlanId");
  expect(importedBody.content).not.toHaveProperty("searchResultId");
  await expect(manualImport).not.toHaveAttribute("open", "");
  await expect(manualSection.getByRole("status")).toContainText("本地快照已保存。请继续逐字确认摘录。");
  const importedSnapshot = workbench.getByTestId("legal-research-snapshot").filter({ hasText: "中华人民共和国民法典第五百六十三条（本地资料）" });
  await expect(importedSnapshot).toContainText("律师手工导入 · 尚未自动核验");
  await expect(importedSnapshot.getByRole("link", { name: "来源地址" })).toHaveCount(0);
  await expect(importedSnapshot.getByLabel("精确原文摘录")).toBeFocused();
  await importedSnapshot.scrollIntoViewIfNeeded();
  await captureViewportScreenshot(
    page,
    path.join(manualScreenshotDir, `02-manual-source-success-${suffix === "desktop" ? "desktop-1440" : suffix}.png`),
  );
  const manualOverflow = await manualSection.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(manualOverflow).toBeLessThanOrEqual(1);

  const previewRequest = page.waitForRequest((request) => request.url().endsWith("/query-preview"));
  await previewButton.click();
  expect((await previewRequest).postDataJSON()).toMatchObject({ issueTreeId: savedIssueTreeBody.id, provider: "official" });
  await expect(page.getByTestId("research-query-comparison")).toContainText("解除通知在何种条件下生效");
  await expect(workbench).toContainText("[已脱敏]");

  await page.getByRole("button", { name: "申请单次审批" }).click();
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByRole("button", { name: "执行一次检索" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("仍需点击执行才会联网");
  await page.getByRole("button", { name: "执行一次检索" }).click();
  await expect(workbench.getByRole("alert")).toContainText("受控法律数据源当前不可用");

  await page.locator("main").last().evaluate((element) => element.scrollTo(0, 0));
  await captureScreenshot(
    page,
    path.join(convergenceScreenshotDir, `product-convergence-research-unavailable-${suffix}.png`),
  );
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(workbench).toContainText("买卖合同解除通知研究");
  await expect(workbench).toContainText("[已脱敏]");
  await expect(page.getByTestId("legal-research-issue-tree").getByLabel("子争点")).toHaveValue("解除通知的到达与生效时间");
});

test("法律研究 renders persisted conclusions and exports only an accepted current memo", async ({ page, request }, testInfo) => {
  const state = smokeState();
  const matterId = state.projects[testInfo.project.name].litigation.matterId;
  if (testInfo.project.name.startsWith("desktop")) {
    await page.setViewportSize({ width: 1440, height: 1000 });
  } else {
    expect(page.viewportSize()?.width).toBe(393);
  }
  const api = `http://127.0.0.1:${state.backendPort}/aletheia/matters/${matterId}`;
  const baseResponse = await request.get(api);
  expect(baseResponse.ok()).toBeTruthy();
  const detail = await baseResponse.json() as { workProducts: unknown[]; reviews: unknown[] };
  const sourceText = "一般保证的债权人未在保证期间对债务人提起诉讼或者申请仲裁的，保证人不再承担保证责任。";
  const contentHash = `sha256:${createHash("sha256").update(sourceText).digest("hex")}`;
  const quoteHash = `sha256:${createHash("sha256").update(sourceText).digest("hex")}`;
  const ids = { request: "visual-request", issues: "visual-issues", plan: "visual-plan", result: "visual-result", snapshot: "visual-snapshot", excerpt: "visual-excerpt", manifest: "visual-manifest", memo: "visual-memo", pendingMemo: "visual-memo-pending", staleMemo: "visual-memo-stale", blocked: "visual-blocked" };
  const record = (id: string, kind: string, title: string, status: string, content: Record<string, unknown>, createdAt: string) => ({
    id, matter_id: matterId, user_id: "local-user", kind, title, status,
    schema_version: textSchema(content), content, validation_errors: [], generated_by: "human", model: null,
    version: 1, parent_work_product_id: null, content_hash: contentHash, dependency_hash: null,
    stale_at: null, stale_reason: null, created_at: createdAt, updated_at: createdAt,
  });
  const queryHash = `sha256:${"a".repeat(64)}`;
  const visualProducts = [
    record(ids.request, "legal_research_request", "保证责任期间法律研究", "draft", { schemaVersion: "vera-legal-research-request-v1", request: { title: "保证责任期间法律研究", facts: "债权人与保证人就保证期间届满及通知效力存在争议。", jurisdiction: "中华人民共和国", asOfDate: "2026-07-12", question: "一般保证中，债权人在保证期间内应采取何种法律行动？" }, networkStatus: "not_dispatched" }, "2026-07-12T09:00:00.000Z"),
    record(ids.issues, "legal_research_issue_tree", "Legal issue tree", "accepted", { schemaVersion: "vera-legal-research-issue-tree-v1", requestId: ids.request, tree: { rootId: "root", nodes: [{ id: "root", parentId: null, title: "保证责任是否因保证期间届满而免除", description: "围绕保证方式、期间起算和法定行动分解。", status: "open", order: 0 }, { id: "action", parentId: "root", title: "期间内是否提起诉讼或申请仲裁", description: null, status: "needs_material", order: 1 }, { id: "method", parentId: "root", title: "保证方式约定是否明确", description: null, status: "resolved", order: 2 }], nodeCount: 3, maxDepth: 2, statusCounts: { open: 1, needs_material: 1, resolved: 1 }, treeHash: `sha256:${"c".repeat(64)}` } }, "2026-07-12T09:00:30.000Z"),
    record(ids.plan, "legal_research_query_plan", "检索计划：保证责任期间法律研究", "draft", { schemaVersion: "vera-legal-research-query-plan-v1", requestId: ids.request, provider: "pkulaw", preview: { query: "民法典 一般保证 保证期间 提起诉讼 仲裁", queryHash, redactions: 0 }, dispatchStatus: "awaiting_lawyer_approval" }, "2026-07-12T09:01:00.000Z"),
    record(ids.result, "legal_research_search_result", "检索候选", "generated", { schemaVersion: "vera-legal-research-search-result-v1", requestId: ids.request, queryPlanId: ids.plan, provider: "pkulaw", queryHash, candidates: [{ documentId: "civil-code-687", title: "中华人民共和国民法典第六百八十七条", summary: "一般保证的先诉抗辩权与保证期间规则。", snapshot: { url: "https://example.test/law/687", contentHash } }] }, "2026-07-12T09:02:00.000Z"),
    record(ids.snapshot, "external_source_workpaper", "中华人民共和国民法典第六百八十七条", "generated", { schemaVersion: "vera-legal-source-snapshot-v1", requestId: ids.request, queryPlanId: ids.plan, searchResultId: ids.result, sourceIdentity: "pkulaw:civil-code-687", provider: "pkulaw", documentId: "civil-code-687", snapshot: { url: "https://example.test/law/687", fetchedAt: "2026-07-12T08:00:00.000Z", contentHash, sourceType: "pkulaw", version: "2021", effectiveDate: "2021-01-01", documentKind: "statute" }, content: sourceText }, "2026-07-12T09:03:00.000Z"),
    record(ids.excerpt, "legal_research_excerpt", "律师确认摘录：民法典第六百八十七条", "accepted", { schemaVersion: "vera-legal-research-excerpt-v1", requestId: ids.request, queryPlanId: ids.plan, snapshotId: ids.snapshot, sourceIdentity: "pkulaw:civil-code-687", sourceContentHash: contentHash, quote: sourceText, quoteHash, confirmedComment: "已与本地法规快照逐字核对。" }, "2026-07-12T09:04:00.000Z"),
    record(ids.manifest, "legal_research_input_manifest", "研究输入清单", "accepted", { schemaVersion: "vera-legal-research-input-manifest-v1", requestId: ids.request, excerpts: [{ excerptId: ids.excerpt, snapshotId: ids.snapshot }], bindingHash: `sha256:${"b".repeat(64)}` }, "2026-07-12T09:05:00.000Z"),
    record(ids.memo, "legal_qa_answer", "法律研究备忘录：保证责任期间法律研究", "accepted", { schemaVersion: "vera-legal-research-memo-v1", requestId: ids.request, inputManifestId: ids.manifest, findings: [{ conclusion: "一般保证的债权人应在保证期间内依法提起诉讼或申请仲裁。", confidence: "high", position: "supporting" }], gate: { status: "ready_for_review", reasons: [] }, finalization: "human_review_required" }, "2026-07-12T09:06:00.000Z"),
    record(ids.pendingMemo, "legal_qa_answer", "待采纳研究备忘录", "needs_review", { schemaVersion: "vera-legal-research-memo-v1", requestId: ids.request, inputManifestId: ids.manifest, findings: [{ conclusion: "该结论尚未完成复核与采纳。", confidence: "medium", position: "neutral" }], gate: { status: "ready_for_review", reasons: [] }, finalization: "human_review_required" }, "2026-07-12T09:06:30.000Z"),
    {
      ...record(ids.staleMemo, "legal_qa_answer", "已过期研究备忘录", "accepted", { schemaVersion: "vera-legal-research-memo-v1", requestId: ids.request, inputManifestId: ids.manifest, findings: [{ conclusion: "该结论绑定的来源已更新。", confidence: "low", position: "neutral" }], gate: { status: "ready_for_review", reasons: [] }, finalization: "human_review_required" }, "2026-07-12T09:06:45.000Z"),
      stale_at: "2026-07-12T09:07:00.000Z",
      stale_reason: "来源快照已更新。",
    },
    record(ids.blocked, "legal_research_memo", "研究备忘录（依据不足）：保证责任期间法律研究", "draft", { schemaVersion: "vera-legal-research-memo-v1", requestId: ids.request, inputManifestId: ids.manifest, findings: [], gate: { status: "insufficient_basis", reasons: ["尚无足以支持该子问题的律师确认原文。"] }, finalization: "blocked" }, "2026-07-12T09:07:00.000Z"),
  ];
  let projected = {
    ...detail,
    workProducts: [...detail.workProducts, ...visualProducts] as Array<Record<string, unknown>>,
    reviews: [...detail.reviews] as Array<Record<string, unknown>>,
  };
  const opinionId = "visual-opinion";
  const opinionReviewId = "visual-opinion-review";
  await page.route(`**/aletheia/matters/${matterId}/research/requests/${ids.request}/issues`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(visualProducts[1]) });
  });
  await page.route(`**/aletheia/matters/${matterId}`, async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projected) });
    else await route.continue();
  });
  let releaseFailClosed!: () => void;
  const failClosedGate = new Promise<void>((resolve) => {
    releaseFailClosed = resolve;
  });
  let memoExportAttempts = 0;
  await page.route(`**/aletheia/matters/${matterId}/legal-research-memos/${ids.memo}/docx`, async (route) => {
    expect(route.request().method()).toBe("POST");
    memoExportAttempts += 1;
    if (memoExportAttempts === 1) {
      await failClosedGate;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "approval_required",
          detail: "The accepted legal research memo has no exact approval audit record.",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        exportId: "visual-memo-export",
        memoId: ids.memo,
        version: 1,
        contentHash,
      }),
    });
  });
  await page.route(`**/aletheia/matters/${matterId}/legal-research-memo-exports/visual-memo-export/download`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: Buffer.from("PK\u0003\u0004visual-research-memo-docx"),
    });
  });
  await page.route(`**/aletheia/matters/${matterId}/legal-opinions`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      answerId: ids.memo,
      cover: { title: "保证责任法律意见书", addressee: "项目负责人", limitation: "仅供本案内部决策使用。", lawyerReference: "VERA-2026-0712" },
    });
    const opinion = record(opinionId, "legal_opinion", "保证责任法律意见书", "needs_review", { schemaVersion: "vera-legal-opinion-v1", answerBinding: { answerId: ids.memo }, cover: { title: "保证责任法律意见书" }, finalization: "lawyer_review_required" }, "2026-07-12T09:08:00.000Z");
    const review = { id: opinionReviewId, matter_id: matterId, work_product_id: opinionId, evidence_item_id: null, target_type: "work_product", target_id: opinionId, tag: "needs_human_judgment", comment: "请复核法律意见书。", reviewer_user_id: "local-user", reviewer_name: null, resolution_status: "open", created_at: "2026-07-12T09:08:00.000Z" };
    projected = { ...projected, workProducts: [...projected.workProducts, opinion], reviews: [...projected.reviews, review] };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ...opinion, review }) });
  });
  await page.route(`**/aletheia/matters/${matterId}/reviews/${opinionReviewId}/resolution`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ status: "accepted" });
    projected = { ...projected, reviews: projected.reviews.map((review) => review.id === opinionReviewId ? { ...review, resolution_status: "accepted", resolved_by: "local-user", resolved_at: "2026-07-12T09:09:00.000Z" } : review) };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ review: projected.reviews.find((review) => review.id === opinionReviewId), auditEvent: null, evalCase: null }) });
  });
  await page.route(`**/aletheia/matters/${matterId}/legal-opinions/${opinionId}/approve`, async (route) => {
    projected = { ...projected, workProducts: projected.workProducts.map((product) => product.id === opinionId ? { ...product, status: "accepted" } : product) };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projected.workProducts.find((product) => product.id === opinionId)) });
  });
  await page.route(`**/aletheia/matters/${matterId}/legal-opinions/${opinionId}/docx`, async (route) => {
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ exportId: "visual-export", opinionId, version: 1, contentHash }) });
  });
  await page.route(`**/aletheia/matters/${matterId}/legal-opinion-exports/visual-export/download`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: Buffer.from("PK\u0003\u0004visual-docx") });
  });

  await page.goto(`/aletheia/matters/${matterId}/litigation?view=research`);
  await page.getByText("保证责任期间法律研究", { exact: true }).click();
  await expect(page.getByTestId("legal-research-issue-tree").getByLabel("子争点").first()).toHaveValue("期间内是否提起诉讼或申请仲裁");
  await expect(page.getByTestId("legal-research-snapshot")).toContainText("第六百八十七条");
  await expect(page.getByTestId("legal-research-workbench")).toContainText(sourceText);
  await expect(page.getByTestId("legal-research-workbench")).toContainText("依据不足");
  await expect(page.getByTestId("legal-research-workbench")).toContainText("已采纳");

  const workbench = page.getByTestId("legal-research-workbench");
  const acceptedMemoRow = workbench.locator("article").filter({ hasText: "法律研究备忘录：保证责任期间法律研究" });
  const pendingMemoRow = workbench.locator("article").filter({ hasText: "待采纳研究备忘录" });
  const staleMemoRow = workbench.locator("article").filter({ hasText: "已过期研究备忘录" });
  const blockedMemoRow = workbench.locator("article").filter({ hasText: "研究备忘录（依据不足）" });
  const memoExportButton = acceptedMemoRow.getByRole("button", { name: "导出备忘录 DOCX" });
  await expect(memoExportButton).toBeVisible();
  await expect(workbench.getByRole("button", { name: "导出备忘录 DOCX" })).toHaveCount(1);
  await expect(pendingMemoRow.getByRole("button", { name: "导出备忘录 DOCX" })).toHaveCount(0);
  await expect(staleMemoRow.getByRole("button", { name: "导出备忘录 DOCX" })).toHaveCount(0);
  await expect(blockedMemoRow.getByRole("button", { name: "导出备忘录 DOCX" })).toHaveCount(0);
  await expect(pendingMemoRow).toContainText("待复核");
  await expect(staleMemoRow).toContainText("已过期");
  await expect(blockedMemoRow).toContainText("依据不足");

  const memoScreenshotDir = path.resolve(
    process.cwd(),
    "../docs/screenshots/ui-audit-2026-07-13-research-memo-docx",
  );
  if (uiCaptureEnabled()) mkdirSync(memoScreenshotDir, { recursive: true });
  const memoSuffix = testInfo.project.name.startsWith("mobile")
    ? "narrow-393"
    : "desktop-1440";
  await memoExportButton.click();
  await expect(acceptedMemoRow.getByRole("button", { name: "正在导出" })).toBeDisabled();
  await acceptedMemoRow.scrollIntoViewIfNeeded();
  await captureViewportScreenshot(
    page,
    path.join(memoScreenshotDir, `01-export-loading-${memoSuffix}.png`),
  );
  releaseFailClosed();
  await expect(acceptedMemoRow.getByRole("alert")).toHaveText(
    "The accepted legal research memo has no exact approval audit record.",
  );
  await expect(memoExportButton).toBeEnabled();
  await expect(workbench).toContainText("待采纳研究备忘录");
  await expect(workbench).toContainText("已过期研究备忘录");
  await expect(workbench).toContainText("研究备忘录（依据不足）");
  await captureViewportScreenshot(
    page,
    path.join(memoScreenshotDir, `02-export-fail-closed-${memoSuffix}.png`),
  );

  const memoDownloadPromise = page.waitForEvent("download");
  await memoExportButton.click();
  const memoDownload = await memoDownloadPromise;
  expect(memoDownload.suggestedFilename()).toMatch(/法律研究备忘录：保证责任期间法律研究-v1\.docx$/);
  await expect(acceptedMemoRow.getByRole("status")).toHaveText("备忘录 v1 已导出并下载。");
  expect(memoExportAttempts).toBe(2);
  await captureViewportScreenshot(
    page,
    path.join(memoScreenshotDir, `03-export-success-${memoSuffix}.png`),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect(await acceptedMemoRow.locator("xpath=ancestor::section[1]").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

  const opinionStep = page.getByTestId("legal-opinion-step");
  await opinionStep.getByLabel("已采纳研究结论").selectOption(ids.memo);
  await opinionStep.getByLabel("意见书标题（可选）").fill("保证责任法律意见书");
  await opinionStep.getByLabel("致送对象（可选）").fill("项目负责人");
  await opinionStep.getByLabel("律师文号（可选）").fill("VERA-2026-0712");
  await opinionStep.getByLabel("使用限制（可选）").fill("仅供本案内部决策使用。");
  await opinionStep.getByRole("button", { name: "建立法律意见书" }).click();
  await expect(opinionStep).toContainText("待复核");
  await opinionStep.getByRole("button", { name: "完成独立复核" }).click();
  await expect(opinionStep).toContainText("已复核");
  await opinionStep.getByRole("button", { name: "批准意见书" }).click();
  await expect(opinionStep).toContainText("已批准");
  const downloadPromise = page.waitForEvent("download");
  await opinionStep.getByRole("button", { name: "导出 DOCX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/保证责任法律意见书-v1\.docx$/);

  const screenshotDir = path.resolve(process.cwd(), "../docs/screenshots");
  if (uiCaptureEnabled()) mkdirSync(screenshotDir, { recursive: true });
  const suffix = testInfo.project.name.startsWith("mobile") ? "narrow-393" : "desktop";
  await page.locator("main").last().evaluate((element) => element.scrollTo(0, 0));
  await captureScreenshot(page, path.join(screenshotDir, `product-convergence-research-${suffix}.png`));
  await opinionStep.scrollIntoViewIfNeeded();
  await captureScreenshot(page, path.join(screenshotDir, `product-convergence-legal-opinion-${suffix}.png`));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

function textSchema(content: Record<string, unknown>) {
  return typeof content.schemaVersion === "string" ? content.schemaVersion : "test";
}
