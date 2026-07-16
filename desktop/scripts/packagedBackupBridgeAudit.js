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

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertOwnerOnlyRegularFile(filePath, label) {
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must be an owner-only regular file.`);
  }
  return info;
}

function assertRealDirectory(directory, label) {
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  if (fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} must use its canonical path.`);
  }
}

function readPendingRestoreRecord(recordPath, expectedTarget) {
  assertOwnerOnlyRegularFile(recordPath, "Pending restore record");
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    throw new Error("Pending restore record must contain valid JSON.");
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join("\n") !==
      ["createdAt", "rollback", "schema", "target"].join("\n") ||
    record.schema !== "aletheia-pending-restore-v1" ||
    typeof record.target !== "string" ||
    record.target !== expectedTarget ||
    typeof record.rollback !== "string" ||
    path.dirname(record.rollback) !== path.dirname(expectedTarget) ||
    !/^\.aletheia-restore-rollback-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      path.basename(record.rollback),
    ) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    new Date(record.createdAt).toISOString() !== record.createdAt
  ) {
    throw new Error("Pending restore record has an invalid schema or path.");
  }
  return record;
}

function captureLogCheckpoint(logPath) {
  const info = assertOwnerOnlyRegularFile(logPath, "Desktop audit log");
  return { device: info.dev, inode: info.ino, bytes: info.size };
}

function restoreUtilityCompleted(logPath, checkpoint) {
  const info = assertOwnerOnlyRegularFile(logPath, "Desktop audit log");
  if (
    info.dev !== checkpoint.device ||
    info.ino !== checkpoint.inode ||
    info.size < checkpoint.bytes
  ) {
    throw new Error("Desktop audit log changed identity during restore.");
  }
  const appended = fs
    .readFileSync(logPath)
    .subarray(checkpoint.bytes)
    .toString("utf8");
  const completeBytes = appended.lastIndexOf("\n");
  if (completeBytes < 0) return false;
  return appended
    .slice(0, completeBytes)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .some(
      (record) =>
        record?.component === "encrypted_restore" &&
        record?.event === "utility_complete" &&
        Number.isSafeInteger(record?.detail?.output_bytes) &&
        record.detail.output_bytes > 0,
    );
}

async function waitForCompletedRestoreSwap(args, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!lstatOrNull(args.pendingRestorePath)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    const record = readPendingRestoreRecord(
      args.pendingRestorePath,
      args.expectedTarget,
    );
    const targetInfo = lstatOrNull(record.target);
    const rollbackInfo = lstatOrNull(record.rollback);
    const utilityComplete = restoreUtilityCompleted(
      args.logPath,
      args.logCheckpoint,
    );
    if (!targetInfo || !rollbackInfo) {
      if (utilityComplete) {
        throw new Error(
          "Restore utility exited before the workspace swap completed.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    assertRealDirectory(record.target, "Restored workspace");
    assertRealDirectory(record.rollback, "Rollback workspace");
    const rollbackMarker = path.join(
      record.rollback,
      path.basename(args.postBackupMarker),
    );
    assertOwnerOnlyRegularFile(rollbackMarker, "Rollback marker");
    if (fs.readFileSync(rollbackMarker, "utf8") !== args.markerContents) {
      throw new Error("Rollback workspace marker content changed.");
    }
    if (lstatOrNull(args.postBackupMarker)) {
      throw new Error(
        "Restored workspace still contains the post-backup marker.",
      );
    }
    const restoredDatabase = path.join(record.target, "aletheia.db");
    const databaseInfo = fs.lstatSync(restoredDatabase);
    if (databaseInfo.isSymbolicLink() || !databaseInfo.isFile()) {
      throw new Error("Restored workspace database is unsafe or missing.");
    }
    if (utilityComplete) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for a completed post-swap restore.");
}

async function settlesWithin(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function processHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    };
    child.once("exit", finish);
    child.once("close", finish);
    if (processHasExited(child)) finish();
  });
}

async function closeApplication(application, timeoutMs = 10_000) {
  const applicationProcess = application.process();
  const exitPromise = waitForProcessExit(applicationProcess);
  void application.close().catch(() => undefined);
  if (await settlesWithin(exitPromise, timeoutMs)) return;
  if (!processHasExited(applicationProcess)) {
    applicationProcess.kill("SIGKILL");
  }
  if (!(await settlesWithin(exitPromise, timeoutMs))) {
    throw new Error("The isolated Vera audit process did not terminate.");
  }
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
        // This compatibility audit deliberately creates Legacy matters. Keep
        // the durable model/voice runtime disabled while opting into routes.
        VERA_ENABLE_LEGACY_ROUTES: "true",
        VERA_ENABLE_LEGACY_RUNTIME: "false",
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
    const postBackupMarkerContents = "must disappear after restore\n";
    fs.writeFileSync(postBackupMarker, postBackupMarkerContents, {
      mode: 0o600,
    });
    const rolledBackMatter = await createMatter("恢复后必须消失的备份后案件");
    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    const pendingRestorePath = path.join(userDataDir, "pending-restore.json");
    const desktopLogPath = path.join(
      userDataDir,
      "logs",
      "vera",
      "vera.log",
    );
    const restoreLogCheckpoint = captureLogCheckpoint(desktopLogPath);
    const localDataPath = path.join(userDataDir, "aletheia-data");
    const expectedRestoreTarget = path.join(
      fs.realpathSync(path.dirname(localDataPath)),
      path.basename(localDataPath),
    );
    const interruptedProcess = electronApp.process();
    const interruptedExitPromise = waitForProcessExit(interruptedProcess);
    const closePromise = electronApp.waitForEvent("close", {
      timeout: 180_000,
    });
    const interruptedRestore = page
      .evaluate(() => window.aletheiaDesktop.restoreEncryptedBackup())
      .catch(() => null);
    await waitForCompletedRestoreSwap({
      pendingRestorePath,
      expectedTarget: expectedRestoreTarget,
      postBackupMarker,
      markerContents: postBackupMarkerContents,
      logPath: desktopLogPath,
      logCheckpoint: restoreLogCheckpoint,
    });
    if (!processHasExited(interruptedProcess)) {
      interruptedProcess.kill("SIGKILL");
    }
    if (!(await settlesWithin(interruptedExitPromise, 10_000))) {
      throw new Error("Interrupted Vera process did not terminate.");
    }
    await closePromise;
    await interruptedRestore;
    electronApp = null;
    assert.equal(fs.existsSync(pendingRestorePath), true);

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
    assert.equal(
      rechecked.ok,
      true,
      `Recovered backup preflight failed: ${JSON.stringify(rechecked)}`,
    );
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
    try {
      if (electronApp) await closeApplication(electronApp);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
