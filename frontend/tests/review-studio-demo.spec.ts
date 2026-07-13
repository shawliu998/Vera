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

test("seeded local matter retains fail-closed review gates", async ({ page }, testInfo) => {
  const project = smokeState().projects[testInfo.project.name]?.review;
  if (!project) throw new Error(`Missing UI smoke state for ${testInfo.project.name}`);

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`/aletheia/matters/${project.matterId}`);
  await expect(page.getByRole("heading", { name: project.matterTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trust gates" })).toBeVisible();
  await expect(page.getByText("Final export blocked").first()).toBeVisible();
  await expect(
    page.getByText("Open review comments remain on the memo or memo sections."),
  ).toBeVisible();
  await expect(
    page.getByText("Resolve or reject review comments before final export."),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByText("Final export blocked").first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
