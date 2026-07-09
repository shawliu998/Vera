import { expect, test } from "@playwright/test";

test("demo Review Studio completes approval path and records blockers", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/aletheia/matters/matter-demo-legal-001");
  await expect(page.getByText("Red Flag Dashboard", { exact: true })).toBeVisible();
  await expect(page.getByText("Risk Register", { exact: true })).toBeVisible();
  await expect(page.getByText("Final Export Gate", { exact: true })).toBeVisible();
  await expect(page.getByTestId("review-studio-final-export-gate")).toHaveText(
    "blocked",
  );
  await expect(
    page.getByText("Final export requires explicit expert approval."),
  ).toBeVisible();

  await page.getByTestId("approve-review-studio-final-export").click();
  await expect(page.getByTestId("review-studio-final-export-gate")).toHaveText(
    "blocked",
  );
  await expect(
    page.getByText("Final export requires explicit expert approval."),
  ).not.toBeVisible();
  await expect(
    page.getByText("Unresolved review on", { exact: false }).first(),
  ).toBeVisible();

  await page.goto("/aletheia/matters/matter-demo-legal-001");
  await expect(page.getByTestId("review-studio-final-export-gate")).toHaveText(
    "blocked",
  );

  await page.getByTestId("fact-override-ev-1").fill(
    "Reviewer narrowed this fact to the delivery date only.",
  );
  await page.getByTestId("set-risk-claim-breach-medium").click();
  await page.getByTestId("reject-evidence-ev-1").click();
  await page.getByTestId("flag-selected-issue-omission").click();
  await page
    .getByTestId("supplemental-material-input")
    .fill("Request acceptance testing records.");
  await page.getByTestId("request-supplemental-material").click();

  await expect(page.getByTestId("evidence-review-status-ev-1")).toHaveText(
    "review: rejected",
  );
  await expect(page.getByTestId("review-log-review-fact-ev-1")).toBeVisible();
  await expect(page.getByTestId("review-log-review-risk-claim-breach")).toBeVisible();
  await expect(
    page.getByTestId("review-log-review-omission-claim-breach"),
  ).toBeVisible();
  await expect(page.getByTestId("review-log-review-material-0")).toBeVisible();
  await expect(page.getByTestId("review-studio-final-export-gate")).toHaveText(
    "blocked",
  );

  expect(consoleErrors).toEqual([]);
});
