#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  _electron: electron,
} = require("../../frontend/node_modules/playwright");

async function main() {
  if (process.platform !== "darwin")
    throw new Error("This audit requires macOS.");
  const desktopDir = path.resolve(__dirname, "..");
  const appPath =
    process.env.ALETHEIA_PACKAGED_APP_PATH ??
    path.join(desktopDir, "dist", `mac-${process.arch}`, "Vera.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "Vera");
  const frontendPort = Number(
    process.env.ALETHEIA_DESKTOP_FRONTEND_PORT ?? 43760,
  );
  const frontendUrl = `http://127.0.0.1:${frontendPort}/assistant`;
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "aletheia-notification-audit-"),
  );
  const userDataDir = path.join(root, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  let app = null;
  try {
    app = await electron.launch({
      executablePath,
      env: {
        ...process.env,
        VERA_DESKTOP_PROFILE_DIR: userDataDir,
        VERA_ENABLE_LEGACY_ROUTES: "false",
        VERA_ENABLE_LEGACY_RUNTIME: "false",
        ALETHEIA_DEMO_SEED_ENABLED: "false",
        ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: "false",
        ALETHEIA_APPLICATION_ENCRYPTION: "required",
        ALETHEIA_MASTER_KEY_SOURCE: "env",
        ALETHEIA_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
        ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
        ALETHEIA_DATABASE_KEY_SOURCE: "env",
        ALETHEIA_DATABASE_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
      },
      timeout: 180_000,
    });
    const page = await app.firstWindow();
    await page.waitForURL(frontendUrl, {
      timeout: 180_000,
    });
    const support = await page.evaluate(() =>
      window.aletheiaDesktop.getNotificationSupport(),
    );
    assert.equal(support.supported, true);
    const shown = await page.evaluate(() =>
      window.aletheiaDesktop.showNotification({
        title: "Vera deadline audit",
        body: "Local notification bridge verification.",
        tag: "deadline-audit-tag",
        href: "/aletheia/tasks",
      }),
    );
    assert.deepEqual(shown, { supported: true, shown: true });
    assert.deepEqual(
      await page.evaluate(() =>
        window.aletheiaDesktop.dismissNotification("deadline-audit-tag"),
      ),
      { dismissed: true },
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.aletheiaDesktop.dismissNotification("deadline-audit-tag"),
      ),
      { dismissed: false },
    );
    await assert.rejects(() =>
      page.evaluate(() =>
        window.aletheiaDesktop.showNotification({
          title: "Invalid destination",
          body: "Must remain inside Vera.",
          tag: "invalid-destination",
          href: "https://example.com",
        }),
      ),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-packaged-notification-v1",
          checks: [
            "trusted renderer notification IPC",
            "native notification display result",
            "tag-based withdrawal and idempotent close",
            "external destination rejection",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (app) await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
