import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type LitigationFixture = {
  matterId: string;
  matterUrl: string;
  matterTitle: string;
};

type SmokeState = {
  backendPort: number;
  projects: Record<string, { litigation?: LitigationFixture }>;
};

function smokeState(projectName: string) {
  const state = JSON.parse(
    readFileSync(path.join(process.cwd(), ".next-ui-smoke-state.json"), "utf8"),
  ) as SmokeState;
  const litigation = state.projects[projectName]?.litigation;
  if (!litigation) throw new Error(`Missing litigation fixture for ${projectName}`);
  return {
    ...state,
    litigation,
    backendUrl: `http://127.0.0.1:${state.backendPort}`,
  };
}

async function stubConnectedEmpty(page: Page, backendUrl: string) {
  await page.route(`${backendUrl}/aletheia/matters`, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route(`${backendUrl}/aletheia/tasks?status=open`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

test("Vera opens Assistant while the opted-in legacy workspace stays compatible", async ({
  page,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);

  await page.goto("/");
  await expect(page).toHaveURL(/\/assistant$/);

  // The Playwright backend explicitly opts into VERA_ENABLE_LEGACY_ROUTES.
  // Its exact legacy landing remains a compatibility redirect to Matters;
  // it must not replace Vera's canonical Assistant landing.
  await page.goto("/aletheia");
  await expect(page).toHaveURL(/\/matters$/);

  await page.goto("/aletheia/matters");
  await expect(page).toHaveURL(/\/aletheia\/matters$/);

  const navigationRoot = testInfo.project.name.startsWith("mobile-")
    ? page.locator("header")
    : page.locator("aside");
  const primaryNavigation = navigationRoot
    .getByRole("navigation", { name: "Primary navigation" });
  await expect(primaryNavigation.getByRole("link", { name: "Matters" })).toBeVisible();
  await expect(primaryNavigation.getByRole("link", { name: "Work Queue" })).toBeVisible();
  await expect(primaryNavigation.getByRole("link", { name: "Templates" })).toHaveCount(0);
  await expect(primaryNavigation.getByRole("link", { name: "Agent Studio" })).toHaveCount(0);
  await expect(primaryNavigation.getByRole("link", { name: "Evidence" })).toHaveCount(0);
  await expect(primaryNavigation.getByRole("link", { name: "Reviews" })).toHaveCount(0);
  await expect(primaryNavigation.getByRole("link", { name: "Audit" })).toHaveCount(0);
  await expect(navigationRoot.getByRole("link", { name: "Settings" })).toBeVisible();

  await page.goto(`/aletheia/matters/${state.litigation.matterId}`);
  await expect(page).toHaveURL(
    new RegExp(
      `/aletheia/matters/${state.litigation.matterId}/litigation\\?view=overview$`,
    ),
  );
  const matterViews = page.getByRole("navigation", { name: "案件主视图" });
  await expect(matterViews.getByRole("button", { name: "概览" })).toBeVisible();
  await expect(matterViews.getByRole("button", { name: "事实与证据" })).toBeVisible();
  await expect(matterViews.getByRole("button", { name: "请求权与抗辩" })).toBeVisible();
  await expect(matterViews.getByRole("button", { name: "程序与期限" })).toBeVisible();
  await expect(matterViews.getByRole("button", { name: "文书与庭审" })).toBeVisible();
  await expect(matterViews.getByRole("button", { name: "Agent Run" })).toHaveCount(0);
  await expect(matterViews.getByRole("button", { name: "Eval Lab" })).toHaveCount(0);
  await expect(
    page.locator("main header").getByRole("link", { name: "案件", exact: true }),
  ).toHaveAttribute("href", "/aletheia/matters");

  await page.goto(
    `/aletheia/matters/${state.litigation.matterId}/litigation?view=agent`,
  );
  await expect(page).toHaveURL(/\?view=agent$/);
  await expect(page.getByRole("heading", { name: "Litigation agent run" })).toBeVisible();
});

test("matter API failure fails closed and retry does not expose an empty or demo state", async ({
  page,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  let attempts = 0;
  await page.route(`${state.backendUrl}/aletheia/matters`, (route) => {
    attempts += 1;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "service unavailable" }),
    });
  });
  await page.route(`${state.backendUrl}/aletheia/tasks?status=open`, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  await page.goto("/aletheia/matters");
  const unavailable = page.getByTestId("matters-service-unavailable");
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toContainText("has not substituted demo records");
  await expect(page.getByRole("button", { name: "新建案件" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No matters yet" })).toHaveCount(0);
  await expect(page.getByText(/Demo data|Fallback mode/)).toHaveCount(0);
  await unavailable.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => attempts).toBeGreaterThan(1);

  if (process.env.VERA_CAPTURE_P0 === "true") {
    const screenshotDir = path.resolve(
      process.cwd(),
      "..",
      "docs",
      "screenshots",
      "product-convergence-p0-2026-07-12",
    );
    mkdirSync(screenshotDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: path.join(screenshotDir, "01-matters-unavailable-1440x1000.png"),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 393, height: 1200 });
    await page.screenshot({
      path: path.join(screenshotDir, "02-matters-unavailable-393x1200.png"),
      animations: "disabled",
    });
  }
});

test("connected empty matters has one civil-litigation creation entrance", async ({
  page,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  await stubConnectedEmpty(page, state.backendUrl);

  await page.goto("/aletheia/matters");
  await expect(page.getByRole("heading", { name: "No matters yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建案件" })).toHaveCount(1);
  await page.getByRole("button", { name: "新建案件" }).click();
  await expect(page.getByRole("heading", { name: "新建案件" })).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "新建案件" }).getByText("民商事诉讼", { exact: true }),
  ).toHaveCount(2);
  await expect(page.getByRole("combobox", { name: "Template" })).toHaveCount(0);
  await expect(page.getByText(/Legal Matter Review|Compliance Impact Review|Deal Due Diligence/)).toHaveCount(0);
});

test("new matter persists intake metadata in the real POST payload", async ({
  page,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  let posted: Record<string, unknown> | null = null;
  await page.route(`${state.backendUrl}/aletheia/matters`, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    posted = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "matter-created-from-form",
        user_id: "local-user",
        title: "华辰公司买卖合同纠纷",
        template: "civil_litigation",
        status: "draft",
        client_or_project: "华辰科技有限公司",
        objective: "完成一审应诉并控制保全风险",
        risk_level: "high",
        source_project_id: null,
        shared_with: [],
        metadata: {},
        created_at: "2026-07-12T00:00:00.000Z",
        updated_at: "2026-07-12T00:00:00.000Z",
      }),
    });
  });
  await page.route(`${state.backendUrl}/aletheia/tasks?status=open`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  await page.goto("/aletheia/matters");
  await page.getByRole("button", { name: "新建案件" }).click();
  const dialog = page.getByRole("dialog", { name: "新建案件" });
  await dialog.getByLabel(/^案件名称/).fill("华辰公司买卖合同纠纷");
  await dialog.getByLabel(/^办案目标/).fill("完成一审应诉并控制保全风险");
  await dialog.getByLabel(/^客户\/委托人/).fill("华辰科技有限公司");
  await dialog.getByLabel(/^我方诉讼地位/).selectOption("被告");
  await dialog.getByLabel(/^对方当事人/).fill("远峰供应链有限公司");
  await dialog.getByLabel(/^受理法院/).fill("上海市浦东新区人民法院");
  await dialog.getByLabel(/^案号/).fill("（2026）沪0115民初12345号");
  await dialog.getByLabel(/^程序阶段/).selectOption("一审");
  await dialog.getByLabel(/^收案日期/).fill("2026-07-12");
  await dialog.getByLabel(/^风险等级/).selectOption("high");
  await dialog.getByRole("button", { name: "创建案件" }).click();

  await expect.poll(() => posted).not.toBeNull();
  expect(posted).toMatchObject({
    title: "华辰公司买卖合同纠纷",
    objective: "完成一审应诉并控制保全风险",
    template: "civil_litigation",
    clientOrProject: "华辰科技有限公司",
    riskLevel: "high",
    metadata: {
      representationRole: "被告",
      opposingParties: "远峰供应链有限公司",
      court: "上海市浦东新区人民法院",
      caseNumber: "（2026）沪0115民初12345号",
      procedureStage: "一审",
      intakeDate: "2026-07-12",
    },
  });
  await expect(page).toHaveURL(
    /\/aletheia\/matters\/matter-created-from-form\/litigation\?view=overview$/,
  );
});

test("new matter validates required fields and preserves the form after POST failure", async ({
  page,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  await page.route(`${state.backendUrl}/aletheia/matters`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "案件服务暂时不可用" }),
    });
  });
  await page.route(`${state.backendUrl}/aletheia/tasks?status=open`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  await page.goto("/aletheia/matters");
  await page.getByRole("button", { name: "新建案件" }).click();
  const dialog = page.getByRole("dialog", { name: "新建案件" });
  await dialog.getByRole("button", { name: "创建案件" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "案件名称、办案目标、客户/委托人、我方诉讼地位、程序阶段、收案日期",
  );

  await dialog.getByLabel(/^案件名称/).fill("保留输入测试案件");
  await dialog.getByLabel(/^办案目标/).fill("验证创建失败后输入仍在");
  await dialog.getByLabel(/^客户\/委托人/).fill("测试委托人");
  await dialog.getByLabel(/^我方诉讼地位/).selectOption("原告");
  await dialog.getByLabel(/^程序阶段/).selectOption("立案前");
  await dialog.getByLabel(/^收案日期/).fill("2026-07-12");
  await dialog.getByRole("button", { name: "创建案件" }).click();

  await expect(dialog.getByRole("alert")).toContainText("创建失败：案件服务暂时不可用");
  await expect(dialog.getByLabel(/^案件名称/)).toHaveValue("保留输入测试案件");
  await expect(dialog.getByLabel(/^办案目标/)).toHaveValue("验证创建失败后输入仍在");
  await expect(dialog.getByLabel(/^客户\/委托人/)).toHaveValue("测试委托人");
  await expect(dialog.getByLabel(/^我方诉讼地位/)).toHaveValue("原告");
  await expect(dialog.getByLabel(/^程序阶段/)).toHaveValue("立案前");
  await expect(dialog.getByLabel(/^收案日期/)).toHaveValue("2026-07-12");
});

async function persistedMatterState(
  request: APIRequestContext,
  backendUrl: string,
  matterId: string,
) {
  const [detailResponse, workspaceResponse] = await Promise.all([
    request.get(`${backendUrl}/aletheia/matters/${matterId}`),
    request.get(`${backendUrl}/aletheia/matters/${matterId}/litigation`),
  ]);
  expect(detailResponse.ok()).toBeTruthy();
  expect(workspaceResponse.ok()).toBeTruthy();
  return {
    detail: await detailResponse.json(),
    workspace: await workspaceResponse.json(),
  };
}

async function stubObjectFocusFixture(
  page: Page,
  request: APIRequestContext,
  state: ReturnType<typeof smokeState>,
) {
  const persisted = await persistedMatterState(
    request,
    state.backendUrl,
    state.litigation.matterId,
  );
  const timestamp = "2026-07-12T08:00:00.000Z";
  const documentId = "document-focus-current";
  const factId = "fact-focus-current";
  const positionId = "position-focus-current";
  const taskId = "task-focus-current";
  const deadlineId = "deadline-focus-current";
  const foreignDeadlineId = "deadline-focus-foreign";
  const historicalArtifactId = "artifact-focus-history";
  const currentArtifactId = "artifact-focus-current";
  const baseDocument = persisted.detail.documents[0] ?? {};
  const baseProduct = persisted.detail.workProducts[0] ?? {};

  persisted.detail.documents = [
    {
      ...baseDocument,
      id: documentId,
      matter_id: state.litigation.matterId,
      user_id: "local-user",
      document_id: null,
      name: "证据目录定位测试.pdf",
      document_type: "evidence",
      parsed_status: "parsed",
      summary: "用于验证对象级深链。",
      metadata: { mimeType: "application/pdf" },
      created_at: timestamp,
      updated_at: timestamp,
    },
    ...persisted.detail.documents.filter(
      (document: { id: string }) => document.id !== documentId,
    ),
  ];
  persisted.detail.workProducts = [
    ...persisted.detail.workProducts.filter(
      (product: { kind: string }) => product.kind !== "litigation_brief",
    ),
    {
      ...baseProduct,
      id: historicalArtifactId,
      matter_id: state.litigation.matterId,
      user_id: "local-user",
      kind: "litigation_brief",
      title: "诉讼要点工作稿",
      status: "draft",
      schema_version: "aletheia-litigation-brief-v1",
      content: { sources: [] },
      validation_errors: [],
      generated_by: "system",
      model: null,
      version: 2,
      parent_work_product_id: null,
      content_hash: "2".repeat(64),
      dependency_hash: "d".repeat(64),
      stale_at: null,
      stale_reason: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    {
      ...baseProduct,
      id: currentArtifactId,
      matter_id: state.litigation.matterId,
      user_id: "local-user",
      kind: "litigation_brief",
      title: "诉讼要点工作稿",
      status: "draft",
      schema_version: "aletheia-litigation-brief-v1",
      content: { sources: [] },
      validation_errors: [],
      generated_by: "system",
      model: null,
      version: 3,
      parent_work_product_id: historicalArtifactId,
      content_hash: "3".repeat(64),
      dependency_hash: "e".repeat(64),
      stale_at: null,
      stale_reason: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
  ];
  persisted.workspace.facts = [
    {
      id: factId,
      matter_id: state.litigation.matterId,
      statement: "被告于 2026 年 6 月 3 日签收全部货物。",
      occurred_at: "2026-06-03T09:00:00.000Z",
      date_precision: "day",
      helpfulness: "helpful",
      confidence: "high",
      status: "confirmed",
      created_by: "human",
      decision_comment: "已核对签收记录",
      current_assessment_id: null,
      metadata: {},
      created_at: timestamp,
      updated_at: timestamp,
    },
    ...persisted.workspace.facts.filter(
      (fact: { id: string }) => fact.id !== factId,
    ),
  ];
  persisted.workspace.claims = [
    {
      id: positionId,
      matter_id: state.litigation.matterId,
      kind: "defense",
      parent_claim_id: null,
      title: "被告已按约履行全部交货义务",
      legal_basis: "《中华人民共和国民法典》第五百零九条",
      burden_party_id: null,
      confidence: "high",
      uncertainty: null,
      status: "confirmed",
      created_by: "human",
      decision_comment: "已完成律师复核",
      metadata: {},
      created_at: timestamp,
      updated_at: timestamp,
    },
    ...persisted.workspace.claims.filter(
      (position: { id: string }) => position.id !== positionId,
    ),
  ];
  persisted.workspace.deadlines = [
    ...persisted.workspace.deadlines.filter(
      (deadline: { id: string }) => deadline.id !== deadlineId,
    ),
    {
      id: deadlineId,
      matter_id: state.litigation.matterId,
      triggering_event_id: null,
      title: "提交证据目录期限",
      due_at: "2026-07-20T09:00:00.000Z",
      rule_label: "法院通知",
      rule_version: "v1",
      calculation: "按法院通知记录",
      status: "confirmed",
      created_by: "human",
      decision_comment: null,
      calculation_hash: "c".repeat(64),
      court_calendar_version_id: null,
      court_calendar_hash: null,
      stale_at: null,
      stale_reason: null,
      metadata: {},
    },
    {
      id: foreignDeadlineId,
      matter_id: "foreign-matter",
      triggering_event_id: null,
      title: "其他案件保密期限",
      due_at: "2026-07-21T09:00:00.000Z",
      rule_label: "其他案件规则",
      rule_version: "v1",
      calculation: "不得在当前案件披露",
      status: "confirmed",
      created_by: "human",
      decision_comment: null,
      calculation_hash: "f".repeat(64),
      court_calendar_version_id: null,
      court_calendar_hash: null,
      stale_at: null,
      stale_reason: null,
      metadata: {},
    },
  ];
  const task = {
    id: taskId,
    matter_id: state.litigation.matterId,
    user_id: "local-user",
    source_deadline_id: deadlineId,
    title: "复核并提交证据目录",
    due_at: "2026-07-20T09:00:00.000Z",
    status: "open",
    priority: "high",
    note: null,
    completed_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await page.route(
    `${state.backendUrl}/aletheia/matters/${state.litigation.matterId}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(persisted.detail),
      }),
  );
  await page.route(
    `${state.backendUrl}/aletheia/matters/${state.litigation.matterId}/litigation`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(persisted.workspace),
      }),
  );
  await page.route(`${state.backendUrl}/aletheia/tasks?status=all`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([task]),
    }),
  );
  await page.route(
    "**/litigation/artifacts/artifact-focus-*/export-approval",
    (route) => {
      const workProductId = route.request().url().includes(currentArtifactId)
        ? currentArtifactId
        : historicalArtifactId;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          approvalCheckpointId: null,
          workProductId,
          version: workProductId === currentArtifactId ? 3 : 2,
          contentHash:
            workProductId === currentArtifactId
              ? "3".repeat(64)
              : "2".repeat(64),
          checkpointStatus: "not_requested",
          governanceRequest: null,
          actor: {
            id: "local-user",
            canVote: false,
            canExport: false,
            voteBlockReason: "approval_not_requested",
          },
          independentApproval: {
            required: false,
            status: "not_requested",
            approvedBy: [],
          },
          export: null,
        }),
      });
    },
  );

  return {
    documentId,
    factId,
    positionId,
    deadlineId,
    foreignDeadlineId,
    taskId,
    historicalArtifactId,
    currentArtifactId,
  };
}

test("overview renders persisted intake data and its deterministic next action changes view", async ({
  page,
  request,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  const persisted = await persistedMatterState(
    request,
    state.backendUrl,
    state.litigation.matterId,
  );
  persisted.detail.matter.metadata = {
    ...persisted.detail.matter.metadata,
    representationRole: "被告",
    opposingParties: "远峰供应链有限公司",
    court: "上海市第一中级人民法院",
    caseNumber: null,
    procedureStage: "二审",
    intakeDate: "2026-07-12",
  };
  persisted.detail.documents = [];
  await page.route(
    `${state.backendUrl}/aletheia/matters/${state.litigation.matterId}`,
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(persisted.detail) }),
  );
  await page.route(
    `${state.backendUrl}/aletheia/matters/${state.litigation.matterId}/litigation`,
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(persisted.workspace) }),
  );

  await page.goto(`${state.litigation.matterUrl}?view=overview`);
  const navigation = page.getByRole("navigation", { name: "案件主视图" });
  await expect(navigation.getByRole("button", { name: "概览" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "接案信息" })).toBeVisible();
  await expect(page.getByText("远峰供应链有限公司", { exact: true })).toBeVisible();
  await expect(page.getByText("上海市第一中级人民法院", { exact: true })).toBeVisible();
  await expect(page.getByText("未记录", { exact: true })).toBeVisible();
  const nextAction = page.getByTestId("overview-next-action");
  await expect(page.getByRole("heading", { name: "导入案卷" })).toBeVisible();
  await expect(nextAction).toHaveAttribute("data-next-view", "facts");
  await nextAction.click();
  await expect(page).toHaveURL(/\?view=facts$/);
  await expect(navigation.getByRole("button", { name: "事实与证据" })).toHaveAttribute("aria-pressed", "true");
});

async function expectObjectFocused(page: Page, key: string) {
  const target = page.locator(`[data-object-focus-key="${key}"]`);
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("tabindex", "-1");
  await expect
    .poll(() =>
      target.evaluate((element) => document.activeElement === element),
    )
    .toBeTruthy();
  return target;
}

test("object deep links focus all canonical object kinds and preserve history", async ({
  page,
  request,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  const fixture = await stubObjectFocusFixture(page, request, state);
  const matterUrl = state.litigation.matterUrl;

  await page.goto(
    `${matterUrl}?view=facts&focus=document%3A${fixture.documentId}`,
  );
  await expectObjectFocused(page, `document:${fixture.documentId}`);
  await expect(page.getByText("证据目录定位测试.pdf", { exact: true })).toBeVisible();

  await page.goto(
    `${matterUrl}?view=facts&focus=fact%3A${fixture.factId}`,
  );
  await expectObjectFocused(page, `fact:${fixture.factId}`);
  await expect(
    page.getByText("被告于 2026 年 6 月 3 日签收全部货物。", { exact: true }),
  ).toBeVisible();

  await page.evaluate((positionId) => {
    window.history.pushState(
      null,
      "",
      `?view=positions&focus=position%3A${positionId}`,
    );
  }, fixture.positionId);
  await expectObjectFocused(page, `position:${fixture.positionId}`);
  await expect(
    page
      .locator(`[data-object-focus-key="position:${fixture.positionId}"]`)
      .getByText("被告已按约履行全部交货义务", { exact: true }),
  ).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/view=facts&focus=fact%3Afact-focus-current$/);
  await expectObjectFocused(page, `fact:${fixture.factId}`);
  await page.goForward();
  await expect(page).toHaveURL(
    /view=positions&focus=position%3Aposition-focus-current$/,
  );
  await expectObjectFocused(page, `position:${fixture.positionId}`);

  await page.evaluate((deadlineId) => {
    window.history.pushState(
      null,
      "",
      `?view=procedure&focus=deadline%3A${deadlineId}`,
    );
  }, fixture.deadlineId);
  await expectObjectFocused(page, `deadline:${fixture.deadlineId}`);
  await expect(page.getByText("提交证据目录期限", { exact: true })).toBeVisible();

  await page.evaluate((taskId) => {
    window.history.pushState(
      null,
      "",
      `?view=procedure&focus=task%3A${taskId}`,
    );
  }, fixture.taskId);
  await expectObjectFocused(page, `task:${fixture.taskId}`);
  const task = page.getByTestId(`deadline-task-${fixture.taskId}`);
  await expect(task).toContainText("复核并提交证据目录");
  await expect(task).toContainText("状态：待办");

  await page.goBack();
  await expect(page).toHaveURL(
    /view=procedure&focus=deadline%3Adeadline-focus-current$/,
  );
  await expectObjectFocused(page, `deadline:${fixture.deadlineId}`);
  await page.goForward();
  await expect(page).toHaveURL(/view=procedure&focus=task%3Atask-focus-current$/);
  await expectObjectFocused(page, `task:${fixture.taskId}`);

  await page.goto(
    `${matterUrl}?view=artifacts&focus=artifact%3A${fixture.currentArtifactId}`,
  );
  await expectObjectFocused(page, `artifact:${fixture.currentArtifactId}`);
  await expect(page.getByText("已定位当前版本 v3", { exact: true })).toBeVisible();

  await page.goto(
    `${matterUrl}?view=artifacts&focus=artifact%3A${fixture.historicalArtifactId}`,
  );
  await expectObjectFocused(page, `artifact:${fixture.currentArtifactId}`);
  await expect(
    page.getByText("搜索命中 v2，当前版本 v3", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(
      `[data-object-focus-key="artifact:${fixture.historicalArtifactId}"]`,
    ),
  ).toHaveCount(0);
});

test("object deep links fail closed and changing the primary view clears focus", async ({
  page,
  request,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  const fixture = await stubObjectFocusFixture(page, request, state);
  const matterUrl = state.litigation.matterUrl;

  for (const focus of [
    "unknown:object",
    `document:${"a".repeat(129)}`,
    "document:<img-onerror=alert(1)>",
    "fact:../../foreign",
    "position:%00foreign",
    "deadline:[foreign]",
  ]) {
    await page.goto(
      `${matterUrl}?view=facts&focus=${encodeURIComponent(focus)}`,
    );
    await expect(page.getByRole("navigation", { name: "案件主视图" })).toBeVisible();
    await expect(page.getByTestId("object-focus-recovery")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(focus);
  }

  await page.goto(
    `${matterUrl}?view=procedure&focus=document%3A${fixture.documentId}`,
  );
  const recovery = page.getByTestId("object-focus-recovery");
  await expect(recovery).toContainText(
    "未找到该对象，当前显示本模块最新状态",
  );

  for (const target of [
    { view: "positions", focus: `fact:${fixture.factId}` },
    { view: "facts", focus: `position:${fixture.positionId}` },
    { view: "facts", focus: `deadline:${fixture.deadlineId}` },
  ]) {
    await page.goto(
      `${matterUrl}?view=${target.view}&focus=${encodeURIComponent(target.focus)}`,
    );
    await expect(recovery).toContainText(
      "未找到该对象，当前显示本模块最新状态",
    );
    await expect(recovery).not.toContainText(target.focus);
  }

  for (const target of [
    { view: "facts", focus: "fact:fact-foreign-or-missing" },
    { view: "positions", focus: "position:position-foreign-or-missing" },
    { view: "procedure", focus: `deadline:${fixture.foreignDeadlineId}` },
  ]) {
    await page.goto(
      `${matterUrl}?view=${target.view}&focus=${encodeURIComponent(target.focus)}`,
    );
    await expect(recovery).toContainText(
      "未找到该对象，当前显示本模块最新状态",
    );
    await expect(page.locator("body")).not.toContainText(target.focus);
  }
  await expect(page.getByText("其他案件保密期限", { exact: true })).toHaveCount(0);
  await expect(
    page.locator(
      `[data-object-focus-key="deadline:${fixture.foreignDeadlineId}"]`,
    ),
  ).toHaveCount(0);

  await page.goto(
    `${matterUrl}?view=facts&focus=document%3Adocument-deleted-or-foreign`,
  );
  await expect(recovery).toContainText(
    "未找到该对象，当前显示本模块最新状态",
  );
  await recovery.getByRole("button", { name: "清除定位，留在当前模块" }).click();
  await expect(page).toHaveURL(/\?view=facts$/);

  await page.goto(
    `${matterUrl}?view=facts&focus=document%3A${fixture.documentId}`,
  );
  await expectObjectFocused(page, `document:${fixture.documentId}`);
  await page
    .getByRole("navigation", { name: "案件主视图" })
    .getByRole("button", { name: "请求权与抗辩" })
    .click();
  await expect(page).toHaveURL(/\?view=positions$/);
  await expect(page).not.toHaveURL(/focus=/);
  await expect(page.getByTestId("object-focus-recovery")).toHaveCount(0);
});

test("focused work product fits 1440px and 393px viewports", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "one project covers both explicit viewports",
  );
  const state = smokeState(testInfo.project.name);
  const fixture = await stubObjectFocusFixture(page, request, state);
  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "product-convergence-p2-2026-07-12",
  );
  const capture = process.env.VERA_CAPTURE_P2 === "true";
  if (capture) mkdirSync(screenshotDir, { recursive: true });

  for (const viewport of [
    { width: 1440, height: 1000, suffix: "1440x1000" },
    { width: 393, height: 1200, suffix: "393x1200" },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(
      `${state.litigation.matterUrl}?view=artifacts&focus=artifact%3A${fixture.historicalArtifactId}`,
    );
    const target = await expectObjectFocused(
      page,
      `artifact:${fixture.currentArtifactId}`,
    );
    await expect(
      page.getByText("搜索命中 v2，当前版本 v3", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + Math.min(box!.height, viewport.height)).toBeLessThanOrEqual(
      viewport.height,
    );
    if (capture) {
      await page.screenshot({
        path: path.join(
          screenshotDir,
          `01-historical-artifact-focus-${viewport.suffix}.png`,
        ),
        animations: "disabled",
      });
    }
  }
});

test("focused civil-litigation position fits 1440px and 393px viewports", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "one project covers both explicit viewports",
  );
  const state = smokeState(testInfo.project.name);
  const fixture = await stubObjectFocusFixture(page, request, state);
  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "product-convergence-p3-2026-07-12",
  );
  const capture = process.env.VERA_CAPTURE_P3 === "true";
  if (capture) mkdirSync(screenshotDir, { recursive: true });

  for (const viewport of [
    { width: 1440, height: 1000, suffix: "1440x1000" },
    { width: 393, height: 1200, suffix: "393x1200" },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(
      `${state.litigation.matterUrl}?view=positions&focus=position%3A${fixture.positionId}`,
    );
    const target = await expectObjectFocused(
      page,
      `position:${fixture.positionId}`,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    if (capture) {
      await page.screenshot({
        path: path.join(
          screenshotDir,
          `02-position-focus-${viewport.suffix}.png`,
        ),
        animations: "disabled",
      });
    }
  }
});

test("workbench and new matter dialog fit desktop and 393px viewports", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one project covers both explicit viewports");
  const state = smokeState(testInfo.project.name);
  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "product-convergence-p1-2026-07-12",
  );
  const capture = process.env.VERA_CAPTURE_P1 === "true";
  if (capture) mkdirSync(screenshotDir, { recursive: true });

  for (const viewport of [
    { width: 1440, height: 1000, suffix: "1440x1000" },
    { width: 393, height: 1200, suffix: "393x1200" },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(
      `/aletheia/matters/${state.litigation.matterId}/litigation?view=overview`,
    );
    await expect(page.getByRole("navigation", { name: "案件主视图" })).toBeVisible();
    await expect(page.getByTestId("overview-next-action")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    const nextActionBox = await page.getByTestId("overview-next-action").boundingBox();
    expect(nextActionBox).not.toBeNull();
    expect(nextActionBox!.x).toBeGreaterThanOrEqual(0);
    expect(nextActionBox!.x + nextActionBox!.width).toBeLessThanOrEqual(viewport.width);
    if (capture) {
      await page.screenshot({
        path: path.join(screenshotDir, `01-overview-${viewport.suffix}.png`),
        animations: "disabled",
      });
    }

    await page.goto("/aletheia/matters");
    await page.getByRole("button", { name: "新建案件" }).click();
    const dialog = page.getByRole("dialog", { name: "新建案件" });
    await expect(dialog).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height);
    if (capture) {
      await page.screenshot({
        path: path.join(screenshotDir, `02-new-matter-${viewport.suffix}.png`),
        animations: "disabled",
      });
    }
  }
});

test("compatibility registries fail closed without demo rows or export actions", async ({
  page,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  await page.route(`${state.backendUrl}/aletheia/matters`, (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
  );

  const routes = [
    { path: "/aletheia/evidence", testId: "evidence-service-unavailable", zero: "0 records" },
    { path: "/aletheia/reviews", testId: "reviews-service-unavailable", zero: "0 items" },
    { path: "/aletheia/audit", testId: "audit-service-unavailable", zero: "0 records" },
  ];
  for (const route of routes) {
    await page.goto(route.path);
    const unavailable = page.getByTestId(route.testId);
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText(route.zero);
    await expect(unavailable.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export Filtered JSON" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save Snapshot" })).toHaveCount(0);
    await expect(page.getByText(/demo fallback|Demo fallback|demo events/)).toHaveCount(0);
  }
});

test("connected matter rows and compatibility routes remain canonical", async ({
  page,
}, testInfo) => {
  const state = smokeState(testInfo.project.name);
  const matter = {
    id: "matter-canonical-test",
    user_id: "local-user",
    title: "Canonical Civil Litigation Matter",
    template: "civil_litigation",
    status: "in_progress",
    client_or_project: "Counsel workspace",
    objective: "Prepare the matter for hearing.",
    risk_level: "high",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    document_count: 2,
    evidence_count: 3,
    review_count: 1,
    audit_event_count: 4,
    latest_audit_at: "2026-07-12T00:00:00.000Z",
  };
  await page.route(`${state.backendUrl}/aletheia/matters`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([matter]),
    }),
  );
  await page.route(`${state.backendUrl}/aletheia/tasks?status=open`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  await page.goto("/aletheia/matters");
  await expect(page.getByRole("link", { name: /Canonical Civil Litigation Matter/ })).toHaveAttribute(
    "href",
    "/aletheia/matters/matter-canonical-test/litigation?view=overview",
  );

  await page.unroute(`${state.backendUrl}/aletheia/matters`);
  for (const route of ["/aletheia/evidence", "/aletheia/reviews", "/aletheia/audit"]) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expect(page.getByRole("heading").first()).toBeVisible();
  }

  if (process.env.VERA_CAPTURE_P0 === "true") {
    const screenshotDir = path.resolve(
      process.cwd(),
      "..",
      "docs",
      "screenshots",
      "product-convergence-p0-2026-07-12",
    );
    mkdirSync(screenshotDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/aletheia/matters/${state.litigation.matterId}`);
    await expect(page.getByRole("navigation", { name: "案件主视图" })).toBeVisible();
    await page.screenshot({
      path: path.join(screenshotDir, "03-canonical-workbench-1440x1000.png"),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 393, height: 1200 });
    await page.screenshot({
      path: path.join(screenshotDir, "04-canonical-workbench-393x1200.png"),
      animations: "disabled",
    });
  }
});
