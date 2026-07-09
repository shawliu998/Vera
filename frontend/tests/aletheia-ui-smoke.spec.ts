import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type SmokeState = {
  projects: Record<
    string,
    {
      matterId: string;
      matterUrl: string;
    }
  >;
};

function smokeState(): SmokeState {
  return JSON.parse(
    readFileSync(
      path.join(process.cwd(), "test-results", "aletheia-ui-smoke-state.json"),
      "utf8",
    ),
  ) as SmokeState;
}

test("Aletheia local workspace renders and gates high-risk exports", async ({
  page,
}, testInfo) => {
  const state = smokeState();
  const projectState = state.projects[testInfo.project.name];
  if (!projectState) {
    throw new Error(`Missing UI smoke state for ${testInfo.project.name}`);
  }
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`/aletheia/matters/${projectState.matterId}`);
  await expect(page).toHaveTitle(/Aletheia/);
  await expect(page.getByTestId("aletheia-matter-workspace")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Aletheia UI Smoke Matter/ }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Mock mode");

  await expect(page.getByText("Document Registry")).toBeVisible();
  await expect(
    page.getByText("aletheia-ui-smoke-source.txt").first(),
  ).toBeVisible();
  await expect(page.getByTestId("aletheia-run-trace")).toContainText(
    "Run Trace",
  );
  await expect(page.getByTestId("aletheia-run-trace")).toContainText(
    "Workflow Graph",
  );
  await expect(page.getByText("Issue Map").first()).toBeVisible();
  await expect(page.getByText("Termination notice requirement")).toBeVisible();
  await expect(page.getByText("Representative Quote").first()).toBeVisible();
  await expect(
    page.getByText("Termination notice period confirmed"),
  ).toBeVisible();
  await expect(page.getByText("Legal Matter Review Playbook")).toBeVisible();
  await expect(page).toHaveScreenshot("aletheia-workspace-initial.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.01,
  });

  await page.getByTestId("document-search-input").fill("termination notice");
  await page.getByTestId("document-search-submit").click();
  await expect(page.getByTestId("document-search-results")).toContainText(
    "termination clause",
  );
  await expect(page.getByTestId("document-search-results")).toContainText(
    "Suggested Issue",
  );
  await expect(page.getByTestId("document-search-results")).toContainText(
    "Rank #1",
  );
  await expect(page.getByTestId("document-search-results")).toContainText(
    "SQLite FTS5 BM25 keyword match",
  );

  await page.getByTestId("accept-issue-claim-termination-notice").click();
  await expect(page.getByText("Issue review tag saved.")).toBeVisible();
  await expect(
    page.getByTestId("issue-review-tags-claim-termination-notice"),
  ).toContainText("accepted");

  await page.getByTestId("request-feedback-dataset-approval").click();
  await expect(
    page.getByText("Feedback dataset export approval requested."),
  ).toBeVisible();
  await page.getByTestId("approve-feedback_dataset_export").click();
  await expect(page.getByTestId("save-feedback-dataset")).toBeVisible();
  await page.getByTestId("save-feedback-dataset").click();
  await expect(
    page.getByText("Feedback dataset saved to work products."),
  ).toBeVisible();

  await page.getByTestId("request-final-memo-approval").click();
  await expect(
    page.getByText("Final memo export approval requested."),
  ).toBeVisible();
  await page.getByTestId("approve-final_memo_export").click();
  await expect(page.getByTestId("save-final-memo")).toBeVisible();
  await page.getByTestId("save-final-memo").click();
  await expect(
    page.getByText("Final memo saved to work products."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Aletheia UI Smoke Matter/ }),
  ).toBeVisible();

  await page
    .getByTestId("aletheia-matter-workspace")
    .getByRole("link", { name: "Command Center" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/aletheia/matters/${projectState.matterId}/agentops$`),
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toBeVisible();
  await expect(page.getByText("Adapter-backed matter")).toBeVisible();
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "Aletheia UI Smoke Matter",
  );
  await expect(page.getByTestId("agentops-gate-checklist")).toBeVisible();
  await expect(page.getByTestId("adapter-backed-eval-signals")).toContainText(
    "Eval Signals",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "Matter References",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "resolved",
  );
  await page.getByRole("link", { name: "Matter workspace" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/aletheia/matters/${projectState.matterId}$`),
  );

  await page.goto("/aletheia/evidence");
  await expect(page.getByTestId("aletheia-evidence-registry")).toBeVisible();
  await expect(page.getByText("Local Repository")).toBeVisible();
  await expect(
    page.getByText("Aletheia UI Smoke Matter").first(),
  ).toBeVisible();
  await expect(page.getByTestId("evidence-registry-results")).toContainText(
    "claim-termination-notice",
  );
  await expect(
    page.getByTestId("evidence-registry-row").first(),
  ).toHaveAttribute("id", /^evidence-[a-zA-Z0-9_-]+$/);
  await expect(page.getByTestId("evidence-registry-results")).toContainText(
    "Evidence ",
  );
  await expect(page.getByTestId("evidence-registry-results")).toContainText(
    "Normalized fact:",
  );
  await expect(page.getByTestId("evidence-registry-results")).toContainText(
    "Source chunk",
  );
  await expect(page.getByTestId("evidence-registry-results")).toContainText(
    "chars",
  );
  await page.getByTestId("evidence-filter-query").fill("termination");
  await page.getByTestId("evidence-filter-support").selectOption("supports");
  await expect(page.getByTestId("evidence-registry-results")).toContainText(
    "claim-termination-notice",
  );
  const evidenceDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-filtered-evidence").click();
  const evidenceDownload = await evidenceDownloadPromise;
  expect(evidenceDownload.suggestedFilename()).toBe(
    "aletheia-filtered-evidence-registry.json",
  );
  await page.getByTestId("save-evidence-snapshot").click();
  await expect(page.getByText(/matter-scoped evidence snapshot/)).toBeVisible();

  await page.goto("/aletheia/reviews");
  await expect(page.getByTestId("aletheia-review-registry")).toBeVisible();
  await expect(page.getByText("Local Repository")).toBeVisible();
  await expect(
    page.getByText("Aletheia UI Smoke Matter").first(),
  ).toBeVisible();
  await expect(page.getByTestId("review-registry-results")).toContainText(
    "accepted",
  );
  await page.getByTestId("review-filter-query").fill("termination");
  await page.getByTestId("review-filter-tag").selectOption("accepted");
  await expect(page.getByTestId("review-registry-results")).toContainText(
    "accepted",
  );
  const reviewDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-filtered-reviews").click();
  const reviewDownload = await reviewDownloadPromise;
  expect(reviewDownload.suggestedFilename()).toBe(
    "aletheia-filtered-review-registry.json",
  );
  await page.getByTestId("save-review-snapshot").click();
  await expect(page.getByText(/matter-scoped review snapshot/)).toBeVisible();

  await page.goto("/aletheia/audit");
  await expect(page.getByTestId("aletheia-audit-workbench")).toBeVisible();
  await expect(page.getByText("Local Repository")).toBeVisible();
  await expect(page.getByText("Matter Audit Timeline")).toBeVisible();
  await expect(page.getByText("Review Readiness")).toBeVisible();
  await expect(page.getByTestId("audit-matter-packets")).toContainText(
    "Aletheia UI Smoke Matter",
  );
  await expect(page.getByTestId("audit-work-products")).toContainText(
    "Aletheia UI Smoke Audit Pack",
  );
  await page.getByTestId("audit-filter-query").fill("Aletheia UI Smoke");
  await page
    .getByTestId("audit-filter-action")
    .selectOption("audit_pack_exported");
  await expect(page.getByTestId("audit-timeline-results")).toContainText(
    "audit pack exported",
  );
  await expect(page.getByTestId("audit-matter-packets")).toContainText(
    "Aletheia UI Smoke Matter",
  );
  const auditDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-filtered-audit").click();
  const auditDownload = await auditDownloadPromise;
  expect(auditDownload.suggestedFilename()).toBe(
    "aletheia-filtered-audit-workbench.json",
  );
  await page.getByTestId("save-audit-snapshot").click();
  await expect(page.getByText(/matter-scoped audit snapshot/)).toBeVisible();

  await page.goto("/aletheia/templates/compliance_impact_review");
  await expect(
    page.getByRole("heading", {
      name: "Compliance Impact Review",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("local workflow preview")).toBeVisible();
  await expect(page.getByText("Template Work Products")).toBeVisible();
  await expect(page.getByText("Local Workflow Status")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("mock workflow");

  await page.goto("/aletheia/templates");
  await expect(page.getByText("Workflow Templates")).toBeVisible();
  await expect(page.getByText("local MVP")).toBeVisible();
  await expect(page.getByText("local pilot").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("mock");

  await page.goto("/aletheia/templates/deal_due_diligence");
  await expect(
    page.getByRole("heading", { name: "Deal Due Diligence Memo", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("local workflow preview")).toBeVisible();
  await expect(page.getByText("Red Flag Memo").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("mock workflow");

  expect(consoleErrors).toEqual([]);
});
