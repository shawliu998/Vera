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

test("Vera routes matters into the canonical civil-litigation workspace", async ({
  page,
}, testInfo) => {
  const state = smokeState();
  const projectState = state.projects[testInfo.project.name];
  const legacyMatter = projectState?.workspace;
  const litigationMatter = projectState?.litigation;
  if (!legacyMatter || !litigationMatter) {
    throw new Error(`Missing UI smoke state for ${testInfo.project.name}`);
  }

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`/aletheia/matters/${legacyMatter.matterId}`);
  await expect(page).toHaveURL(
    new RegExp(
      `/aletheia/matters/${legacyMatter.matterId}/litigation\\?view=overview$`,
    ),
  );
  await expect(page.getByRole("heading", { name: "案件暂不可用" })).toBeVisible();
  await expect(page.getByText(/require a civil_litigation matter/)).toBeVisible();
  await expect(page.getByTestId("aletheia-matter-workspace")).toHaveCount(0);
  expect(consoleErrors).toEqual(
    expect.arrayContaining([expect.stringContaining("400 (Bad Request)")]),
  );

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
  expect(
    consoleErrors.filter((message) => !message.includes("400 (Bad Request)")),
  ).toEqual([]);
});
