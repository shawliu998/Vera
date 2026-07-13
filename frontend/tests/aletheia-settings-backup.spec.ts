import { expect, test, type Page } from "@playwright/test";

type BackupTestWindow = typeof window & {
  backupCalls: unknown[][];
  inspectCalls: unknown[][];
  resolveBackup?: () => void;
};

const desktopInfo = {
  appVersion: "test",
  backendUrl: "http://127.0.0.1:3411",
  frontendUrl: "http://127.0.0.1:3410",
  dataDir: "/tmp/aletheia-test",
  logsDir: "/tmp/aletheia-test/logs",
  localClient: true,
  encryptedVolumeAttested: true,
  applicationEncryption: "required",
  databaseEncryption: "sqlcipher_required",
};

async function openWorkspaceSettings(page: Page) {
  await page.goto("/aletheia/settings");
  await page.getByRole("button", { name: "Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
}

test("creates an encrypted backup with running and completed status", async ({
  page,
}) => {
  await page.addInitScript((info) => {
    const backupCalls: unknown[][] = [];
    let resolveBackup:
      | ((result: {
          saved: boolean;
          canceled: boolean;
          filePath: string;
          bytes: number;
          sha256: string;
          createdAt: string;
        }) => void)
      | undefined;

    Object.assign(window, {
      backupCalls,
      inspectCalls: [],
      resolveBackup: () =>
        resolveBackup?.({
          saved: true,
          canceled: false,
          filePath:
            "/Users/counsel/Backups/Aletheia-2026-07-11.aletheia-backup",
          bytes: 2 * 1024 * 1024,
          sha256: "sha-secret-not-for-display",
          createdAt: "2026-07-11T08:30:00.000Z",
        }),
      aletheiaDesktop: {
        getInfo: async () => info,
        createEncryptedBackup: (...args: unknown[]) => {
          backupCalls.push(args);
          return new Promise((resolve) => {
            resolveBackup = resolve;
          });
        },
      },
    });
  }, desktopInfo);

  await openWorkspaceSettings(page);
  const row = page.locator(".aletheia-setting-row", {
    hasText: "Encrypted backup",
  });
  const createButton = row.getByRole("button", { name: "Create backup" });

  await createButton.click();
  await expect(row.getByRole("button", { name: "Creating..." })).toBeDisabled();
  await expect(row.getByRole("status")).toContainText(
    "Creating encrypted backup",
  );

  await page.evaluate(() => (window as BackupTestWindow).resolveBackup?.());
  await expect(row.getByRole("status")).toContainText("Backup complete");
  await expect(row).toContainText("Aletheia-2026-07-11.aletheia-backup");
  await expect(row).toContainText("2 MB");
  await expect(row).toContainText("2026");
  await expect(row).not.toContainText("sha-secret-not-for-display");
  await expect(createButton).toBeEnabled();

  expect(
    await page.evaluate(() => (window as BackupTestWindow).backupCalls),
  ).toEqual([[]]);
});

test("reports backup cancellation and a retry error", async ({ page }) => {
  await page.addInitScript((info) => {
    const backupCalls: unknown[][] = [];
    let attempt = 0;
    Object.assign(window, {
      backupCalls,
      inspectCalls: [],
      aletheiaDesktop: {
        getInfo: async () => info,
        createEncryptedBackup: async (...args: unknown[]) => {
          backupCalls.push(args);
          attempt += 1;
          if (attempt === 1) return { saved: false, canceled: true };
          throw new Error("Keychain is locked");
        },
      },
    });
  }, desktopInfo);

  await openWorkspaceSettings(page);
  const row = page.locator(".aletheia-setting-row", {
    hasText: "Encrypted backup",
  });
  const createButton = row.getByRole("button", { name: "Create backup" });

  await createButton.click();
  await expect(row.getByRole("status")).toContainText("Backup canceled");
  await createButton.click();
  await expect(row.getByRole("status")).toContainText(
    "Backup failed: Keychain is locked",
  );

  expect(
    await page.evaluate(() => (window as BackupTestWindow).backupCalls),
  ).toEqual([[], []]);
});

test("restore preflight only inspects and summarizes failed checks", async ({
  page,
}) => {
  await page.addInitScript((info) => {
    const inspectCalls: unknown[][] = [];
    Object.assign(window, {
      backupCalls: [],
      inspectCalls,
      aletheiaDesktop: {
        getInfo: async () => info,
        inspectEncryptedBackup: async (...args: unknown[]) => {
          inspectCalls.push(args);
          return {
            canceled: false,
            ok: false,
            filePath: "/Users/counsel/Backups/damaged.aletheia-backup",
            checks: [
              { id: "archive", ok: true, detail: "Archive can be read" },
              {
                id: "manifest",
                ok: false,
                detail: "Manifest digest mismatch",
              },
              {
                id: "authentication",
                ok: false,
                detail: "Authentication tag is invalid",
              },
            ],
          };
        },
      },
    });
  }, desktopInfo);

  await openWorkspaceSettings(page);
  const row = page.locator(".aletheia-setting-row", {
    hasText: "Restore preflight",
  });
  await expect(row).toContainText(
    "Checks the selected backup only. It does not overwrite current data.",
  );

  await row.getByRole("button", { name: "Check backup" }).click();
  await expect(row.getByRole("status")).toContainText("Preflight failed");
  await expect(row.getByRole("status")).toContainText(
    "2 failed checks: manifest: Manifest digest mismatch; authentication: Authentication tag is invalid",
  );
  await expect(row.getByRole("status")).not.toContainText(
    "Archive can be read",
  );

  expect(
    await page.evaluate(() => (window as BackupTestWindow).inspectCalls),
  ).toEqual([[]]);
});

test("restore preflight reports a passing backup without restoring it", async ({
  page,
}) => {
  await page.addInitScript((info) => {
    const inspectCalls: unknown[][] = [];
    const restoreCalls: unknown[][] = [];
    Object.assign(window, {
      backupCalls: [],
      inspectCalls,
      restoreCalls,
      aletheiaDesktop: {
        getInfo: async () => info,
        inspectEncryptedBackup: async (...args: unknown[]) => {
          inspectCalls.push(args);
          return {
            canceled: false,
            ok: true,
            filePath: "C:\\Backups\\verified.aletheia-backup",
            createdAt: "2026-07-11T09:00:00.000Z",
            files: 14,
            bytes: 1536,
            checks: [{ id: "manifest", ok: true, detail: "Manifest verified" }],
          };
        },
        restoreEncryptedBackup: async (...args: unknown[]) => {
          restoreCalls.push(args);
          return {
            restored: true,
            canceled: false,
            createdAt: "2026-07-11T09:00:00.000Z",
            files: 14,
            bytes: 1536,
          };
        },
      },
    });
  }, desktopInfo);

  await openWorkspaceSettings(page);
  const row = page.locator(".aletheia-setting-row", {
    hasText: "Restore preflight",
  });
  const restoreRow = page.locator(".aletheia-setting-row", {
    hasText: "Restore workspace",
  });
  await expect(
    restoreRow.getByRole("button", { name: "Restore backup" }),
  ).toBeDisabled();
  await row.getByRole("button", { name: "Check backup" }).click();
  await expect(row.getByRole("status")).toContainText("Preflight passed");
  await expect(row).toContainText("verified.aletheia-backup");
  await expect(row).toContainText("1.5 KB");
  await expect(row).toContainText("14 files");
  await expect(
    restoreRow.getByRole("button", { name: "Restore backup" }),
  ).toBeEnabled();
  await restoreRow.getByRole("button", { name: "Restore backup" }).click();
  await expect(restoreRow.getByRole("status")).toContainText(
    "Restore complete",
  );
  await expect(restoreRow).toContainText("14 files");
  await expect(
    restoreRow.getByRole("button", { name: "Open restored workspace" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { restoreCalls: unknown[][] }).restoreCalls,
    ),
  ).toEqual([[]]);
});

test("marks backup controls as macOS desktop only without the bridge", async ({
  page,
}) => {
  await openWorkspaceSettings(page);
  const backupRow = page.locator(".aletheia-setting-row", {
    hasText: "Encrypted backup",
  });
  const preflightRow = page.locator(".aletheia-setting-row", {
    hasText: "Restore preflight",
  });
  const restoreRow = page.locator(".aletheia-setting-row", {
    hasText: "Restore workspace",
  });

  await expect(backupRow.getByText("macOS desktop only")).toBeVisible();
  await expect(preflightRow.getByText("macOS desktop only")).toBeVisible();
  await expect(
    backupRow.getByRole("button", { name: "Create backup" }),
  ).toBeDisabled();
  await expect(
    preflightRow.getByRole("button", { name: "Check backup" }),
  ).toBeDisabled();
  await expect(
    restoreRow.getByRole("button", { name: "Restore backup" }),
  ).toBeDisabled();
  await expect(page.getByText(/tied to this Mac's Keychain/)).toBeVisible();
  await expect(
    page.getByText(/application and database recovery keys/),
  ).toBeVisible();
  await expect(page.getByText(/available only for the backup/)).toBeVisible();
});
