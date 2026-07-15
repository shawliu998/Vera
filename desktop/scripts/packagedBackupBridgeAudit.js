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

const desktopDir = path.resolve(__dirname, "..");
const appPath =
  process.env.ALETHEIA_PACKAGED_APP_PATH ??
  path.join(desktopDir, "dist", `mac-${process.arch}`, "Vera.app");
const executablePath = path.join(appPath, "Contents", "MacOS", "Vera");
const frontendPort = Number(
  process.env.ALETHEIA_DESKTOP_FRONTEND_PORT ?? 43760,
);
const backendPort = Number(
  process.env.ALETHEIA_DESKTOP_BACKEND_PORT ?? 43761,
);
const frontendUrl = `http://127.0.0.1:${frontendPort}/assistant`;
const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
const backendHealthUrl = `${backendBaseUrl}/health`;

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(backendHealthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      lastStatus = response.status;
      if (response.ok) return;
    } catch {
      lastStatus = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Backend did not recover after backup (status=${lastStatus}).`,
  );
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("This audit requires macOS.");
  }
  fs.accessSync(executablePath, fs.constants.X_OK);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "aletheia-backup-bridge-"),
  );
  fs.chmodSync(root, 0o700);
  const userDataDir = path.join(root, "user-data");
  const backupPath = path.join(root, "workspace.aletheia-backup");
  const tamperedPath = path.join(root, "tampered.aletheia-backup");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const applicationMasterKey = crypto.randomBytes(32);
  const databaseKey = crypto.randomBytes(32);
  let electronApp = null;
  let applicationLog = "";
  const captureApplicationLog = (application) => {
    const append = (chunk) => {
      applicationLog = `${applicationLog}${chunk.toString()}`.slice(-16_384);
    };
    application.process().stdout?.on("data", append);
    application.process().stderr?.on("data", append);
  };
  const launchApp = (exitAfterRestoreSwap) =>
    electron.launch({
      executablePath,
      env: {
        ...process.env,
        VERA_DESKTOP_PROFILE_DIR: userDataDir,
        ALETHEIA_DEMO_SEED_ENABLED: "false",
        ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: "false",
        ALETHEIA_APPLICATION_ENCRYPTION: "required",
        ALETHEIA_MASTER_KEY_SOURCE: "env",
        ALETHEIA_MASTER_KEY_BASE64: applicationMasterKey.toString("base64"),
        ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
        ALETHEIA_DATABASE_KEY_SOURCE: "env",
        ALETHEIA_DATABASE_KEY_BASE64: databaseKey.toString("base64"),
        ...(exitAfterRestoreSwap
          ? { ALETHEIA_TEST_EXIT_AFTER_RESTORE_SWAP: "true" }
          : {}),
      },
      timeout: 180_000,
    });

  try {
    electronApp = await launchApp(true);
    captureApplicationLog(electronApp);
    let page = await electronApp.firstWindow();
    await page.waitForURL(frontendUrl, { timeout: 180_000 });
    await waitForHealth();
    let token = await page.evaluate(() => window.aletheiaDesktop.getAuthToken());
    let headers = { Authorization: `Bearer ${token}` };
    const createMatter = async (title) => {
      const response = await fetch(`${backendBaseUrl}/aletheia/matters`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          objective: "Verify packaged SQLCipher backup and restore continuity.",
          template: "civil_litigation",
          status: "in_progress",
          riskLevel: "high",
          clientOrProject: "Backup recovery audit",
          sourceProjectId: null,
          sharedWith: [],
          metadata: { audit: "packaged_backup_bridge" },
        }),
      });
      if (response.status !== 201) {
        throw new Error(`Matter creation failed (${response.status}): ${await response.text()}`);
      }
      return response.json();
    };
    const preservedMatter = await createMatter("恢复后必须保留的案件");
    const evidenceText =
      "恢复校验材料：争议款项约定于2026年9月1日到期。 VERA-RESTORE-ZEPHYR";
    const evidenceForm = new FormData();
    evidenceForm.append(
      "file",
      new Blob([evidenceText], { type: "text/plain" }),
      "backup-evidence.txt",
    );
    const uploaded = await fetch(
      `${backendBaseUrl}/aletheia/matters/${preservedMatter.id}/documents`,
      { method: "POST", headers, body: evidenceForm },
    );
    if (uploaded.status !== 201) {
      throw new Error(`Document upload failed (${uploaded.status}): ${await uploaded.text()}`);
    }
    const preservedDocument = await uploaded.json();
    assert.equal(preservedDocument.parsed_status, "parsed");
    await electronApp.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: destination,
      });
    }, backupPath);

    let created;
    try {
      created = await page.evaluate(() =>
        window.aletheiaDesktop.createEncryptedBackup(),
      );
    } catch (error) {
      throw new Error(
        `Packaged backup creation failed: ${error instanceof Error ? error.message : String(error)}${applicationLog ? `\nApplication log:\n${applicationLog}` : ""}`,
      );
    }
    assert.equal(created.saved, true);
    assert.equal(created.canceled, false);
    assert.equal(created.filePath, backupPath);
    assert.match(created.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(created.sha256, sha256(backupPath));
    const backupInfo = fs.statSync(backupPath);
    assert.equal(backupInfo.mode & 0o777, 0o600);
    assert.equal(created.bytes, backupInfo.size);
    await waitForHealth();

    await electronApp.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input],
      });
    }, backupPath);
    const inspected = await page.evaluate(() =>
      window.aletheiaDesktop.inspectEncryptedBackup(),
    );
    assert.equal(inspected.canceled, false);
    assert.equal(inspected.ok, true);
    assert.ok((inspected.files ?? 0) > 0);
    assert.ok((inspected.bytes ?? 0) > 0);
    assert.ok(inspected.checks?.length === 4);
    assert.ok(inspected.checks.every((check) => check.ok));

    const info = await page.evaluate(() => window.aletheiaDesktop.getInfo());
    assert.equal("dataDir" in info, false);
    assert.equal("logsDir" in info, false);
    const postBackupMarker = path.join(
      userDataDir,
      "aletheia-data",
      "post-backup-marker.txt",
    );
    fs.writeFileSync(postBackupMarker, "must disappear after restore\n", {
      mode: 0o600,
    });
    const rolledBackMatter = await createMatter("恢复后必须消失的备份后案件");
    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    const closePromise = electronApp.waitForEvent("close", { timeout: 180_000 });
    const interruptedRestore = page
      .evaluate(() => window.aletheiaDesktop.restoreEncryptedBackup())
      .catch(() => null);
    await closePromise;
    await interruptedRestore;
    electronApp = null;
    assert.equal(fs.existsSync(path.join(userDataDir, "pending-restore.json")), true);

    electronApp = await launchApp(false);
    captureApplicationLog(electronApp);
    page = await electronApp.firstWindow();
    await page.waitForURL(frontendUrl, { timeout: 180_000 });
    await waitForHealth();
    token = await page.evaluate(() => window.aletheiaDesktop.getAuthToken());
    headers = { Authorization: `Bearer ${token}` };
    assert.equal(fs.existsSync(path.join(userDataDir, "pending-restore.json")), false);
    assert.equal(fs.existsSync(postBackupMarker), true);
    const recoveredMatterResponse = await fetch(
      `${backendBaseUrl}/aletheia/matters/${rolledBackMatter.id}`,
      { headers },
    );
    assert.equal(recoveredMatterResponse.status, 200);

    await electronApp.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input],
      });
    }, backupPath);
    const rechecked = await page.evaluate(() =>
      window.aletheiaDesktop.inspectEncryptedBackup(),
    );
    assert.equal(rechecked.ok, true);
    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    const restored = await page.evaluate(() =>
      window.aletheiaDesktop.restoreEncryptedBackup(),
    );
    assert.equal(restored.restored, true);
    assert.equal(restored.canceled, false);
    await waitForHealth();
    assert.equal(fs.existsSync(postBackupMarker), false);
    const restoredMatterResponse = await fetch(
      `${backendBaseUrl}/aletheia/matters/${preservedMatter.id}`,
      { headers },
    );
    assert.equal(restoredMatterResponse.status, 200);
    const restoredMatter = await restoredMatterResponse.json();
    assert.equal(restoredMatter.matter.title, preservedMatter.title);
    assert.ok(
      restoredMatter.documents.some(
        (document) => document.id === preservedDocument.id,
      ),
    );
    const restoredSearchResponse = await fetch(
      `${backendBaseUrl}/aletheia/matters/${preservedMatter.id}/documents/search?q=${encodeURIComponent("VERA RESTORE ZEPHYR")}`,
      { headers },
    );
    assert.equal(restoredSearchResponse.status, 200);
    const restoredSearch = await restoredSearchResponse.json();
    assert.ok(
      restoredSearch.some(
        (result) => result.document_id === preservedDocument.id,
      ),
    );
    const rolledBackMatterResponse = await fetch(
      `${backendBaseUrl}/aletheia/matters/${rolledBackMatter.id}`,
      { headers },
    );
    assert.equal(rolledBackMatterResponse.status, 404);
    const journalPath = path.join(userDataDir, "restore-journal.jsonl");
    const journal = fs
      .readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(journal.length, 1);
    assert.equal(journal[0].backupSha256, sha256(backupPath));
    assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
    const { eventHash, ...journalPayload } = journal[0];
    const journalKey = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        applicationMasterKey,
        Buffer.from("aletheia-desktop-backup-salt-v1", "utf8"),
        Buffer.from("aletheia-desktop-backup-key-v1", "utf8"),
        32,
      ),
    );
    const expectedEventHash = crypto
      .createHmac("sha256", journalKey)
      .update("")
      .update("\n")
      .update(JSON.stringify(journalPayload))
      .digest("hex");
    journalKey.fill(0);
    assert.equal(eventHash, expectedEventHash);

    fs.copyFileSync(backupPath, tamperedPath);
    const tampered = fs.openSync(tamperedPath, "r+");
    try {
      const middle = Math.floor(fs.fstatSync(tampered).size / 2);
      const byte = Buffer.alloc(1);
      fs.readSync(tampered, byte, 0, 1, middle);
      byte[0] ^= 0x80;
      fs.writeSync(tampered, byte, 0, 1, middle);
      fs.fsyncSync(tampered);
    } finally {
      fs.closeSync(tampered);
    }
    await electronApp.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input],
      });
    }, tamperedPath);
    const rejected = await page.evaluate(() =>
      window.aletheiaDesktop.inspectEncryptedBackup(),
    );
    assert.equal(rejected.canceled, false);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.checks?.some((check) => !check.ok));

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-packaged-backup-bridge-v1",
          checks: [
            "renderer-to-preload-to-main backup IPC",
            "service stop, consistent snapshot, and restart",
            "AES-GCM archive with owner-only permissions",
            "authenticated restore preflight",
            "confirmed atomic restore and service recovery",
            "interrupted post-swap restore rolls back before service startup",
            "pre-backup SQLCipher matter and encrypted document survive restore",
            "restored document chunks remain searchable",
            "post-backup matter is removed by point-in-time restore",
            "owner-only HMAC-chained restore journal",
            "tampered backup fail-closed rejection",
            "isolated temporary workspace",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
