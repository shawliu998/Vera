import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type LitigationFixture = {
  matterId: string;
  matterUrl: string;
  matterTitle: string;
};

function fixture(projectName: string) {
  const state = JSON.parse(
    readFileSync(path.join(process.cwd(), ".next-ui-smoke-state.json"), "utf8"),
  ) as {
    backendPort: number;
    projects: Record<string, { litigation?: LitigationFixture }>;
  };
  const litigation = state.projects[projectName]?.litigation;
  if (!litigation)
    throw new Error(`Missing litigation fixture for ${projectName}`);
  return { ...litigation, backendUrl: `http://127.0.0.1:${state.backendPort}` };
}

test("confirmed deadline persists through the work queue lifecycle", async ({
  page,
  request,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const workspaceResponse = await request.get(
    `${state.backendUrl}/aletheia/matters/${state.matterId}/litigation`,
  );
  expect(workspaceResponse.ok()).toBe(true);
  const workspace = (await workspaceResponse.json()) as {
    procedural_events: Array<{ id: string; status: string }>;
    deadlines: Array<{ id: string; title: string; status: string }>;
  };
  const event = workspace.procedural_events[0];
  const deadline = workspace.deadlines.find(
    (item) => item.title === "Complete internal evidence review",
  );
  if (!event || !deadline)
    throw new Error("Litigation task fixture is incomplete");

  if (event.status === "proposed") {
    const response = await request.post(
      `${state.backendUrl}/aletheia/matters/${state.matterId}/litigation/procedural-events/${event.id}/decision`,
      { data: { decision: "confirmed", comment: "UI task queue test" } },
    );
    expect(response.ok()).toBe(true);
  }
  if (deadline.status === "proposed") {
    const response = await request.post(
      `${state.backendUrl}/aletheia/matters/${state.matterId}/litigation/deadlines/${deadline.id}/decision`,
      { data: { decision: "confirmed", comment: "UI task queue test" } },
    );
    expect(response.ok()).toBe(true);
  }

  const createResponse = await request.post(
    `${state.backendUrl}/aletheia/matters/${state.matterId}/litigation/deadlines/${deadline.id}/task`,
    {
      data: { priority: "high", note: "Prepare for responsible lawyer review" },
    },
  );
  expect([200, 201]).toContain(createResponse.status());
  const task = (await createResponse.json()) as { id: string };

  await page.goto("/aletheia/tasks");
  const taskRow = page
    .locator("article")
    .filter({ hasText: "Complete internal evidence review" })
    .filter({ hasText: state.matterTitle });
  await expect(taskRow).toContainText(state.matterTitle);
  await expect(taskRow).toContainText(/high priority/i);

  await taskRow.getByRole("button", { name: "Complete task" }).click();
  await expect(taskRow).toHaveCount(0);
  await page.getByRole("tab", { name: "Completed" }).click();
  const completedTaskRow = page
    .locator("article")
    .filter({ hasText: "Complete internal evidence review" })
    .filter({ hasText: state.matterTitle });
  await expect(completedTaskRow).toBeVisible();
  await completedTaskRow.getByRole("button", { name: "Reopen task" }).click();
  await expect(completedTaskRow).toHaveCount(0);
  await page.getByRole("tab", { name: "Open" }).click();
  const reopenedTaskRow = page
    .locator("article")
    .filter({ hasText: "Complete internal evidence review" })
    .filter({ hasText: state.matterTitle });
  await expect(reopenedTaskRow).toBeVisible();

  const duplicateResponse = await request.post(
    `${state.backendUrl}/aletheia/matters/${state.matterId}/litigation/deadlines/${deadline.id}/task`,
    { data: { priority: "low", title: "Must not overwrite" } },
  );
  expect(duplicateResponse.status()).toBe(200);
  expect((await duplicateResponse.json()).id).toBe(task.id);

  await reopenedTaskRow.getByRole("link").click();
  await expect(page).toHaveURL(
    new RegExp(
      `/aletheia/matters/${state.matterId}/litigation\\?view=procedure&focus=task%3A${task.id}$`,
    ),
  );
  await expect(page.getByText("状态：待办")).toBeVisible();
});
