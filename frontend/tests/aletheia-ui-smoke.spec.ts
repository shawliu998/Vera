import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type MatterFixture = {
  matterId: string;
  matterUrl: string;
  matterTitle: string;
};

type SmokeState = {
  projects: Record<
    string,
    {
      workspace?: MatterFixture;
      litigation?: MatterFixture;
    }
  >;
};

function smokeState(): SmokeState {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), ".next-ui-smoke-state.json"), "utf8"),
  ) as SmokeState;
}

test("Vera routes seeded matters into the canonical civil-litigation workspace", async ({
  page,
}, testInfo) => {
  const state = smokeState();
  const projectState = state.projects[testInfo.project.name];
  const workspaceMatter = projectState?.workspace;
  const litigationMatter = projectState?.litigation;
  if (!workspaceMatter || !litigationMatter) {
    throw new Error(`Missing UI smoke state for ${testInfo.project.name}`);
  }

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`/aletheia/matters/${workspaceMatter.matterId}`);
  await expect(page).toHaveURL(
    new RegExp(
      `/aletheia/matters/${workspaceMatter.matterId}/litigation\\?view=overview$`,
    ),
  );
  await expect(
    page.getByRole("heading", { name: workspaceMatter.matterTitle }),
  ).toBeVisible();

  await page.goto(`/aletheia/matters/${litigationMatter.matterId}`);
  await expect(page).toHaveTitle(/Vera/);
  await expect(page).toHaveURL(
    new RegExp(
      `/aletheia/matters/${litigationMatter.matterId}/litigation\\?view=overview$`,
    ),
  );
  await expect(
    page.getByRole("heading", { name: litigationMatter.matterTitle }),
  ).toBeVisible();
  const matterViews = page.getByRole("navigation", { name: "案件主视图" });
  await expect(matterViews.getByRole("button", { name: "概览" })).toBeVisible();
  await expect(
    matterViews.getByRole("button", { name: "事实与证据" }),
  ).toBeVisible();
  await expect(
    matterViews.getByRole("button", { name: "请求权与抗辩" }),
  ).toBeVisible();
  await expect(
    matterViews.getByRole("button", { name: "程序与期限" }),
  ).toBeVisible();
  await expect(
    matterViews.getByRole("button", { name: "文书与庭审" }),
  ).toBeVisible();
  await expect(matterViews.getByRole("button", { name: "Agent Run" })).toHaveCount(0);
  await expect(matterViews.getByRole("button", { name: "Eval Lab" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Mock mode");
  expect(consoleErrors).toEqual([]);
});

test("civil-litigation registries filter, export, and persist snapshots", async ({
  page,
}, testInfo) => {
  const state = smokeState();
  const workspaceMatter = state.projects[testInfo.project.name]?.workspace;
  if (!workspaceMatter) {
    throw new Error(`Missing workspace UI smoke state for ${testInfo.project.name}`);
  }

  await page.goto("/aletheia/evidence");
  await expect(page.getByTestId("aletheia-evidence-registry")).toBeVisible();
  await page
    .getByTestId("evidence-filter-query")
    .fill(workspaceMatter.matterTitle);
  await page.getByTestId("evidence-filter-support").selectOption("supports");
  await expect(page.getByTestId("evidence-registry-results")).toContainText(
    workspaceMatter.matterTitle,
  );
  const evidenceDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-filtered-evidence").click();
  expect((await evidenceDownloadPromise).suggestedFilename()).toBe(
    "aletheia-filtered-evidence-registry.json",
  );
  await page.getByTestId("save-evidence-snapshot").click();
  await expect(page.getByText(/matter-scoped evidence snapshot/)).toBeVisible();

  await page.goto("/aletheia/reviews");
  await expect(page.getByTestId("aletheia-review-registry")).toBeVisible();
  await page
    .getByTestId("review-filter-query")
    .fill(workspaceMatter.matterTitle);
  await page.getByTestId("review-filter-tag").selectOption("missing_material");
  await expect(page.getByTestId("review-registry-results")).toContainText(
    workspaceMatter.matterTitle,
  );
  const reviewDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-filtered-reviews").click();
  expect((await reviewDownloadPromise).suggestedFilename()).toBe(
    "aletheia-filtered-review-registry.json",
  );
  await page.getByTestId("save-review-snapshot").click();
  await expect(page.getByText(/matter-scoped review snapshot/)).toBeVisible();

  await page.goto("/aletheia/audit");
  await expect(page.getByTestId("aletheia-audit-workbench")).toBeVisible();
  await expect(page.getByTestId("audit-matter-packets")).toContainText(
    workspaceMatter.matterTitle,
  );
  await page.getByTestId("audit-filter-query").fill(workspaceMatter.matterTitle);
  await page
    .getByTestId("audit-filter-action")
    .selectOption("audit_pack_exported");
  await expect(page.getByTestId("audit-timeline-results")).toContainText(
    "audit pack exported",
  );
  const auditDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-filtered-audit").click();
  expect((await auditDownloadPromise).suggestedFilename()).toBe(
    "aletheia-filtered-audit-workbench.json",
  );
  await page.getByTestId("save-audit-snapshot").click();
  await expect(page.getByText(/matter-scoped audit snapshot/)).toBeVisible();
});
