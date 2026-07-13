import { expect, test } from "@playwright/test";

test("due task monitoring uses the desktop notification bridge once per day", async ({
  page,
}) => {
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await page.addInitScript(() => {
    Object.assign(window, {
      nativeNotificationCalls: [],
      notificationDismissCalls: [],
      aletheiaDesktop: {
        showNotification: async (input: unknown) => {
          (
            window as typeof window & { nativeNotificationCalls: unknown[] }
          ).nativeNotificationCalls.push(input);
          return { supported: true, shown: true };
        },
        dismissNotification: async (tag: string) => {
          (
            window as typeof window & { notificationDismissCalls: string[] }
          ).notificationDismissCalls.push(tag);
          return { dismissed: true };
        },
      },
    });
  });
  let delivered = false;
  const acknowledgements: Array<Record<string, unknown>> = [];
  await page.route("**/aletheia/task-notifications/claim", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        claimedAt: new Date().toISOString(),
        withdrawals: delivered
          ? []
          : [
              {
                deliveryId: "old-delivery",
                taskId: "old-task",
                tag: "old-deadline-tag",
              },
            ],
        claims: delivered
          ? []
          : [
              {
                deliveryId: "delivery-1",
                leaseToken: "lease-token-1",
                tag: "deadline-task-1-due-soon-today",
                category: "due_soon",
                taskId: "deadline-task-1",
                matterId: "matter-1",
                matterTitle: "Orion dispute",
                title: "File statement of defence",
                dueAt,
                attemptCount: 1,
              },
            ],
      }),
    });
  });
  await page.route(
    "**/aletheia/task-notifications/delivery-1/ack",
    async (route) => {
      const payload = (await route.request().postDataJSON()) as Record<
        string,
        unknown
      >;
      acknowledgements.push(payload);
      delivered = payload.outcome === "delivered";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: payload.outcome }),
      });
    },
  );

  await page.goto("/aletheia/tasks");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as typeof window & { nativeNotificationCalls: unknown[] })
            .nativeNotificationCalls.length,
      ),
    )
    .toBe(1);
  const firstCall = await page.evaluate(
    () =>
      (window as typeof window & { nativeNotificationCalls: unknown[] })
        .nativeNotificationCalls[0] as Record<string, unknown>,
  );
  expect(firstCall.title).toBe("Due soon: File statement of defence");
  expect(firstCall.body).toContain("Orion dispute");
  expect(firstCall.href).toBe("/aletheia/tasks");
  expect(firstCall.nativeHandled).toBe(true);
  await expect.poll(() => acknowledgements.length).toBe(1);
  expect(acknowledgements[0]).toEqual({
    leaseToken: "lease-token-1",
    outcome: "delivered",
    failureCode: null,
  });
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { notificationDismissCalls: string[] })
          .notificationDismissCalls,
    ),
  ).toEqual(["old-deadline-tag"]);

  await page.reload();
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { nativeNotificationCalls: unknown[] })
          .nativeNotificationCalls.length,
    ),
  ).toBe(0);
});

test("native display rejection is acknowledged as retryable failure", async ({
  page,
}) => {
  const acknowledgements: Array<Record<string, unknown>> = [];
  await page.addInitScript(() => {
    Object.assign(window, {
      aletheiaDesktop: {
        showNotification: async () => ({ supported: true, shown: false }),
        dismissNotification: async () => ({ dismissed: false }),
      },
    });
  });
  await page.route("**/aletheia/task-notifications/claim", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        claimedAt: new Date().toISOString(),
        withdrawals: [],
        claims: [
          {
            deliveryId: "failed-delivery",
            leaseToken: "failed-lease",
            tag: "failed-tag",
            category: "overdue",
            taskId: "failed-task",
            matterId: "matter-1",
            matterTitle: "Orion dispute",
            title: "File statement of defence",
            dueAt: new Date(Date.now() - 60_000).toISOString(),
            attemptCount: 1,
          },
        ],
      }),
    }),
  );
  await page.route(
    "**/aletheia/task-notifications/failed-delivery/ack",
    async (route) => {
      acknowledgements.push(
        (await route.request().postDataJSON()) as Record<string, unknown>,
      );
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "failed" }),
      });
    },
  );
  await page.goto("/aletheia/tasks");
  await expect.poll(() => acknowledgements.length).toBe(1);
  expect(acknowledgements[0]).toEqual({
    leaseToken: "failed-lease",
    outcome: "failed",
    failureCode: "display_rejected",
  });
  await expect(
    page.getByTestId("aletheia-notification-toast"),
  ).not.toBeVisible();
});
