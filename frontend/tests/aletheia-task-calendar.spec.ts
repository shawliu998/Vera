import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const calendarBody = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Vera//Work Queue//EN",
  "END:VCALENDAR",
  "",
].join("\r\n");

async function mockWorkQueue(page: import("@playwright/test").Page) {
  await page.route("**/aletheia/tasks?*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: "[]" });
  });
  await page.route("**/aletheia/matters", async (route) => {
    await route.fulfill({ contentType: "application/json", body: "[]" });
  });
}

test("exports the current work queue tab as an ICS download", async ({
  page,
}) => {
  const requestedStatuses: string[] = [];
  await mockWorkQueue(page);
  await page.route("**/aletheia/tasks/calendar.ics?*", async (route) => {
    const requestUrl = new URL(route.request().url());
    requestedStatuses.push(requestUrl.searchParams.get("status") ?? "");
    await route.fulfill({ contentType: "text/calendar", body: calendarBody });
  });

  await page.goto("/aletheia/tasks");
  const exportButton = page.getByRole("button", { name: "Export calendar" });
  await expect(exportButton).toBeVisible();

  const openDownloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const openDownload = await openDownloadPromise;
  expect(openDownload.suggestedFilename()).toBe("Vera Work Queue.ics");
  const openDownloadPath = await openDownload.path();
  expect(openDownloadPath).not.toBeNull();
  expect(readFileSync(openDownloadPath!, "utf8")).toContain("BEGIN:VCALENDAR");
  await expect(page.getByRole("status")).toHaveText("Calendar exported.");

  await page.getByRole("tab", { name: "Completed" }).click();
  await expect(page.getByRole("tab", { name: "Completed" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const completedDownloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const completedDownload = await completedDownloadPromise;
  expect(completedDownload.suggestedFilename()).toBe("Vera Work Queue.ics");
  expect(requestedStatuses).toEqual(["open", "completed"]);
});

test("shows the calendar export error returned by the API", async ({
  page,
}) => {
  await mockWorkQueue(page);
  await page.route("**/aletheia/tasks/calendar.ics?*", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Calendar export unavailable" }),
    });
  });

  await page.goto("/aletheia/tasks");
  await page.getByRole("button", { name: "Export calendar" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Calendar export unavailable",
  );
});

test("uses the desktop calendar bridge and reports cancellation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const taskCalendarCalls: unknown[] = [];
    Object.assign(window, {
      taskCalendarCalls,
      aletheiaDesktop: {
        saveTaskCalendar: async (input: unknown) => {
          taskCalendarCalls.push(input);
          return { saved: false, canceled: true };
        },
      },
    });
  });
  await mockWorkQueue(page);

  await page.goto("/aletheia/tasks");
  await page.getByRole("button", { name: "Export calendar" }).click();
  await expect(page.getByRole("status")).toHaveText("Export cancelled.");
  const calls = await page.evaluate(
    () =>
      (window as typeof window & { taskCalendarCalls: unknown[] })
        .taskCalendarCalls,
  );
  expect(calls).toEqual([
    {
      status: "open",
      suggestedName: "Vera Work Queue.ics",
      openAfterSave: false,
    },
  ]);
});
