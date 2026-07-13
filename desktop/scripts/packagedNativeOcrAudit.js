#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("../../frontend/node_modules/playwright");

async function main() {
  if (process.platform !== "darwin") throw new Error("This audit requires macOS.");
  const desktopDir = path.resolve(__dirname, "..");
  const appPath =
    process.env.ALETHEIA_PACKAGED_APP_PATH ??
    path.join(desktopDir, "dist", `mac-${process.arch}`, "Vera.app");
  const frontendPort = Number(
    process.env.ALETHEIA_DESKTOP_FRONTEND_PORT ?? 43760,
  );
  const backendPort = Number(
    process.env.ALETHEIA_DESKTOP_BACKEND_PORT ?? 43761,
  );
  const frontendUrl = `http://127.0.0.1:${frontendPort}/aletheia/matters`;
  const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
  const executablePath = path.join(appPath, "Contents", "MacOS", "Vera");
  const packagedHelper = path.join(
    appPath,
    "Contents",
    "Resources",
    "aletheia",
    "native",
    "aletheia-ocr",
  );
  fs.accessSync(packagedHelper, fs.constants.X_OK);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aletheia-packaged-ocr-"));
  const fixture = path.join(root, "scanned-contract.pdf");
  const userDataDir = path.join(root, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  execFileSync(
    "/usr/bin/xcrun",
    ["swift", path.join(desktopDir, "native", "ocr-audit-fixture.swift"), fixture],
    { stdio: "inherit" },
  );
  let app = null;
  try {
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
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
    const token = await page.evaluate(() => window.aletheiaDesktop.getAuthToken());
    const headers = { Authorization: `Bearer ${token}` };
    const create = await fetch(`${backendBaseUrl}/aletheia/matters`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Native OCR Audit Matter",
        objective: "Verify packaged local OCR ingestion.",
        template: "civil_litigation",
        status: "draft",
        riskLevel: "medium",
        clientOrProject: null,
        sourceProjectId: null,
        sharedWith: [],
        metadata: { audit: "packaged_native_ocr" },
      }),
    });
    if (create.status !== 201) throw new Error(await create.text());
    const matter = await create.json();
    const form = new FormData();
    form.append(
      "file",
      new Blob([fs.readFileSync(fixture)], { type: "application/pdf" }),
      "scanned-contract.pdf",
    );
    const upload = await fetch(
      `${backendBaseUrl}/aletheia/matters/${matter.id}/documents`,
      { method: "POST", headers, body: form },
    );
    if (upload.status !== 201) throw new Error(await upload.text());
    const document = await upload.json();
    assert.equal(
      document.parsed_status,
      "parsed",
      JSON.stringify({
        status: document.parsed_status,
        summary: document.summary,
        metadata: document.metadata,
      }),
    );
    assert.equal(document.metadata.parserMetadata.parser, "pdf+apple-vision");
    assert.equal(document.metadata.parserMetadata.ocrEngine, "apple-vision");
    assert.equal(document.metadata.parserMetadata.ocrPageCount, 1);
    const search = await fetch(
      `${backendBaseUrl}/aletheia/matters/${matter.id}/documents/search?q=PAYMENT%20DUE`,
      { headers },
    );
    assert.equal(search.status, 200);
    const results = await search.json();
    const hit = results.find((item) => item.document_id === document.id);
    assert.ok(hit);
    assert.equal(hit.ocr_provenance.engine, "apple-vision");
    assert.equal(hit.ocr_provenance.page, 1);
    assert.ok(hit.ocr_provenance.confidence >= 0.5);
    const detail = await fetch(
      `${backendBaseUrl}/aletheia/matters/${matter.id}`,
      { headers },
    );
    const state = await detail.json();
    const event = state.auditEvents.find(
      (item) => item.action === "document_uploaded" && item.details.documentId === document.id,
    );
    assert.equal(event.details.ocrEngine, "apple-vision");
    assert.equal(event.details.ocrPageCount, 1);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        suite: "aletheia-packaged-native-ocr-v1",
        checks: [
          "packaged helper executable present",
          "renderer-authenticated local matter creation",
          "image-only PDF parsed through packaged Apple Vision helper",
          "OCR provenance persisted and audited",
          "recognized text available through matter-scoped FTS",
          "search result carries page-level OCR provenance",
        ],
      }, null, 2)}\n`,
    );
  } finally {
    if (app) await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
