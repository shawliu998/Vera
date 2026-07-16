import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type SmokeState = {
  projects: Record<string, Record<"review", { matterId: string; matterTitle: string }>>;
};

function smokeState(): SmokeState {
  return JSON.parse(
    readFileSync(
      path.join(process.cwd(), ".next-ui-smoke-state.json"),
      "utf8",
    ),
  ) as SmokeState;
}

test("seeded civil-litigation review remains source-bound and approval-gated", async ({
  page,
}, testInfo) => {
  const project = smokeState().projects[testInfo.project.name]?.review;
  if (!project) throw new Error(`Missing UI smoke state for ${testInfo.project.name}`);

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/aletheia/reviews");
  await expect(page.getByTestId("aletheia-review-registry")).toBeVisible();
  await page.getByTestId("review-filter-query").fill(project.matterTitle);
  await page.getByTestId("review-filter-tag").selectOption("missing_material");

  const seededReview = page
    .getByTestId("review-registry-results")
    .getByRole("link")
    .filter({ hasText: project.matterTitle });
  await expect(seededReview).toHaveCount(1);
  await expect(seededReview).toContainText("work product · recorded");
  await expect(seededReview).toContainText("missing material");
  await expect(
    seededReview.getByText(
      "起诉日期及加速到期条款仍待核实，诉讼意见不得将未届期抗辩表述为确定结论。",
    ),
  ).toBeVisible();

  await seededReview.click();
  await expect(page).toHaveURL(
    new RegExp(
      `/aletheia/matters/${project.matterId}/litigation\\?view=positions$`,
    ),
  );
  await expect(page.getByRole("heading", { name: project.matterTitle })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Claim and defense matrix" }),
  ).toBeVisible();
  const reviewedPosition = page
    .locator('[data-testid^="claim-"]')
    .filter({ hasText: "起诉时付款义务尚未届期" });
  await expect(reviewedPosition).toHaveCount(1);
  await expect(reviewedPosition).toContainText("起诉时付款义务尚未届期");

  await page.getByRole("button", { name: "文书与庭审" }).click();
  const litigationBrief = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Litigation brief", exact: true }),
  });
  await expect(litigationBrief).toContainText("Export approval");
  await expect(litigationBrief).toContainText("not requested");
  await expect(
    litigationBrief.getByRole("button", { name: "Request export approval" }),
  ).toBeVisible();
  await expect(
    litigationBrief.getByRole("button", { name: "Export approved DOCX" }),
  ).toHaveCount(0);

  await page.reload();
  await expect(page).toHaveURL(/\?view=artifacts$/);
  await expect(litigationBrief).toContainText("Export approval");
  await expect(litigationBrief).toContainText("not requested");
  await expect(
    litigationBrief.getByRole("button", { name: "Request export approval" }),
  ).toBeVisible();
  await expect(
    litigationBrief.getByRole("button", { name: "Export approved DOCX" }),
  ).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});
