#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DIAGNOSTIC_SCHEMA,
  buildRedactedDiagnosticBundle,
} = require("../diagnosticBundle");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vera-diagnostics-audit-"));
const dataDir = path.join(root, "data-secret-name");
const logsDir = path.join(root, "logs-secret-name");
const forbidden = "sk-audit-secret-document-content";

try {
  fs.mkdirSync(path.join(dataDir, "documents"), { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "documents", "client-name.txt"), forbidden);
  fs.writeFileSync(path.join(logsDir, "provider.log"), `Authorization: Bearer ${forbidden}`);

  const bundle = buildRedactedDiagnosticBundle({
    now: new Date("2026-07-15T00:00:00.000Z"),
    appVersion: "1.0.1",
    packaged: true,
    platform: "darwin",
    arch: "arm64",
    osRelease: "audit",
    versions: { electron: "39", chrome: "140", node: "22" },
    runningServices: ["backend", "frontend", "credential worker"],
    servicesReady: true,
    encryptedVolumeAttested: true,
    genericLoopbackHttpEnabled: false,
    dataDir,
    logsDir,
  });
  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.schema, DIAGNOSTIC_SCHEMA);
  assert.equal(bundle.local_services.ready, true);
  assert.equal(bundle.storage_summary.files, 1);
  assert.equal(bundle.logs_summary.files, 1);
  assert.equal(bundle.privacy.document_contents_included, false);
  assert.equal(bundle.privacy.log_contents_included, false);
  for (const value of [
    forbidden,
    "client-name.txt",
    "provider.log",
    dataDir,
    logsDir,
    root,
    "Authorization",
    "Bearer",
  ]) {
    assert.equal(serialized.includes(value), false, value);
  }
  assert.deepEqual(Object.keys(bundle).sort(), [
    "created_at",
    "local_services",
    "logs_summary",
    "privacy",
    "product",
    "runtime",
    "schema",
    "security",
    "storage_summary",
  ]);
  const desktopRoot = path.resolve(__dirname, "..");
  const mainSource = fs.readFileSync(path.join(desktopRoot, "main.js"), "utf8");
  const preloadSource = fs.readFileSync(
    path.join(desktopRoot, "preload.js"),
    "utf8",
  );
  assert.match(preloadSource, /exportDiagnosticBundle/);
  assert.match(preloadSource, /aletheia:export-diagnostics/);
  assert.match(
    mainSource,
    /ipcMain\.handle\("aletheia:export-diagnostics"[\s\S]*?assertTrustedSender\(event\)/,
  );
  assert.match(mainSource, /buildRedactedDiagnosticBundle/);
  const exportStart = mainSource.indexOf(
    "async function exportRedactedDiagnosticBundle()",
  );
  const exportEnd = mainSource.indexOf(
    "function parseBackupUtilityResult",
    exportStart,
  );
  assert.ok(exportStart >= 0 && exportEnd > exportStart);
  assert.doesNotMatch(
    mainSource.slice(exportStart, exportEnd),
    /readFileSync|createReadStream/,
    "diagnostic export must not copy log or document contents",
  );
  console.log("diagnosticBundleAudit: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
