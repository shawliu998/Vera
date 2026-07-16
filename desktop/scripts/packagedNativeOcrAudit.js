#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  _electron: electron,
} = require("../../frontend/node_modules/playwright");

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const STARTUP_TIMEOUT_MS = 180_000;
const POLL_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 30_000;
const LEGAL_PROVIDER_ENV_KEYS = [
  "VERA_PKULAW_API_ENDPOINT",
  "VERA_PKULAW_API_ALLOWED_HOSTS",
  "VERA_PKULAW_API_CREDENTIAL_REF",
  "VERA_YUANDIAN_API_ENDPOINT",
  "VERA_YUANDIAN_API_ALLOWED_HOSTS",
  "VERA_YUANDIAN_API_CREDENTIAL_REF",
  "VERA_WOLTERS_API_ENDPOINT",
  "VERA_WOLTERS_API_ALLOWED_HOSTS",
  "VERA_WOLTERS_API_CREDENTIAL_REF",
  "VERA_OFFICIAL_LEGAL_API_ENDPOINT",
  "VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS",
];

function record(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value;
}

function array(value, label) {
  assert.ok(Array.isArray(value), label);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertAttributeStable(
  locator,
  name,
  expected,
  message,
  durationMs = 500,
) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    assert.equal(await locator.getAttribute(name), expected, message);
    await delay(50);
  }
}

function forceTerminate(app) {
  try {
    const child = app.process();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  } catch {
    // Best effort after a bounded graceful-close failure.
  }
}

async function closeVera(running) {
  const dialogs = [];
  const dialogTasks = [];
  const onDialog = (dialog) => {
    dialogs.push(dialog.type());
    dialogTasks.push(dialog.accept().catch(() => undefined));
  };
  if (running.page) running.page.on("dialog", onDialog);

  let timeoutHandle;
  const closeResult = running.app.close().then(
    () => ({ status: "closed" }),
    (error) => ({ status: "error", error }),
  );
  const timeoutResult = new Promise((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ status: "timeout" }),
      CLOSE_TIMEOUT_MS,
    );
  });
  const result = await Promise.race([closeResult, timeoutResult]);
  clearTimeout(timeoutHandle);

  if (result.status === "timeout") {
    forceTerminate(running.app);
    await Promise.race([closeResult, delay(5_000)]);
  }
  await Promise.race([Promise.all(dialogTasks), delay(5_000)]);
  try {
    running.page?.off("dialog", onDialog);
  } catch {
    // The page normally closes before the listener can be detached.
  }

  if (result.status === "timeout") {
    throw new Error("Packaged Vera graceful close exceeded its hard timeout.");
  }
  if (result.status === "error") {
    forceTerminate(running.app);
    throw result.error;
  }
  return dialogs;
}

function auditFetch(input, init = {}) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function checkedPort(value, label) {
  const port = Number(value);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535, label);
  return port;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function assertPortsFree(frontendPort, backendPort) {
  assert.notEqual(frontendPort, backendPort, "Desktop ports must be distinct.");
  assert.equal(await portOpen(frontendPort), false, "Frontend port is in use.");
  assert.equal(await portOpen(backendPort), false, "Backend port is in use.");
}

async function waitForPortsClosed(frontendPort, backendPort) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await portOpen(frontendPort)) && !(await portOpen(backendPort)))
      return;
    await delay(200);
  }
  throw new Error("Packaged Vera did not release its local service ports.");
}

function authHeaders(token, json = true) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function responseJson(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  assert.ok(text, `${label} returned an empty response.`);
  return JSON.parse(text);
}

async function launchVera(options) {
  const app = await electron.launch({
    executablePath: options.executablePath,
    env: options.env,
    timeout: STARTUP_TIMEOUT_MS,
  });
  let page = null;
  try {
    page = await app.firstWindow();
    await page.waitForURL(options.frontendUrl, { timeout: STARTUP_TIMEOUT_MS });
    const token = await page.evaluate(() =>
      window.aletheiaDesktop.getAuthToken(),
    );
    assert.ok(typeof token === "string" && token.length > 20);
    return { app, page, token };
  } catch (error) {
    await closeVera({ app, page }).catch(() => forceTerminate(app));
    throw error;
  }
}

async function listProjectDocuments(backendBaseUrl, token, projectId) {
  const response = await auditFetch(
    `${backendBaseUrl}/api/v1/projects/${projectId}/documents?limit=100`,
    { headers: authHeaders(token, false) },
  );
  return array(
    await responseJson(response, "Project document list"),
    "documents",
  );
}

async function readProjectDocumentVersions(backendBaseUrl, token, documentId) {
  const response = await auditFetch(
    `${backendBaseUrl}/api/v1/documents/${documentId}/versions`,
    { headers: authHeaders(token, false) },
  );
  return record(
    await responseJson(response, "Project document versions"),
    "Project document versions",
  );
}

async function readProjectDocumentText(
  backendBaseUrl,
  token,
  documentId,
  versionId,
) {
  const response = await auditFetch(
    `${backendBaseUrl}/api/v1/documents/${documentId}/read?version_id=${versionId}`,
    { headers: authHeaders(token, false) },
  );
  return record(
    await responseJson(response, "Project extracted text"),
    "Project extracted text",
  );
}

async function waitForReadyProjectDocument(
  backendBaseUrl,
  token,
  projectId,
  documentId,
) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const documents = await listProjectDocuments(
      backendBaseUrl,
      token,
      projectId,
    );
    const value = documents.find((item) => item.id === documentId);
    if (value?.status === "ready") return record(value, "ready document");
    if (value?.status === "error") {
      throw new Error("Packaged Project OCR parsing failed.");
    }
    await delay(250);
  }
  throw new Error("Packaged Project OCR parsing did not become ready.");
}

function assertOcrSummary(document) {
  const summary = record(document.ocr_summary, "Project OCR summary");
  assert.equal(summary.engine, "apple-vision");
  assert.equal(summary.ocr_page_count, 1);
  assert.ok(Number.isSafeInteger(summary.low_confidence_page_count));
  assert.ok(
    summary.low_confidence_page_count >= 0 &&
      summary.low_confidence_page_count <= summary.ocr_page_count,
  );
  assert.ok(Array.isArray(summary.low_confidence_pages));
  assert.ok(summary.low_confidence_pages.length <= 50);
  assert.ok(
    summary.low_confidence_pages.every(
      (page, index, pages) =>
        Number.isSafeInteger(page) &&
        page >= 1 &&
        page <= summary.ocr_page_count &&
        (index === 0 || page > pages[index - 1]),
    ),
  );
  assert.equal(typeof summary.low_confidence_pages_truncated, "boolean");
  assert.equal(
    summary.low_confidence_pages_truncated,
    summary.low_confidence_page_count > summary.low_confidence_pages.length,
  );
  assert.equal(summary.review_required, summary.low_confidence_page_count > 0);
  return summary;
}

function assertLegalProvidersRemainDisabled(value) {
  const payload = record(value, "legal provider status");
  assert.equal(payload.schemaVersion, "vera-legal-source-provider-status-v2");
  assert.equal(payload.localOnly, true);
  const providers = array(payload.providers, "legal providers");
  assert.deepEqual(providers.map((provider) => provider.provider).sort(), [
    "pkulaw",
    "wolters",
    "yuandian",
  ]);
  for (const provider of providers) {
    assert.equal(provider.deploymentReady, false);
    assert.equal(provider.endpointConfigured, false);
    assert.equal(provider.allowlisted, false);
    assert.equal(provider.credentialReferenceConfigured, false);
    assert.equal(provider.hasSecret, false);
    const connection = record(provider.connectionStatus, "connection status");
    assert.equal(connection.connectionTested, false);
    assert.equal(connection.state, "unavailable");
    assert.equal(connection.reason, "endpoint_missing");
  }
}

async function readLegalProviders(backendBaseUrl, token) {
  const response = await auditFetch(`${backendBaseUrl}/aletheia/providers`, {
    headers: authHeaders(token, false),
  });
  return responseJson(response, "legal provider status");
}

async function exportStudioDocx(
  backendBaseUrl,
  token,
  projectId,
  documentId,
  versionId,
) {
  const response = await auditFetch(
    `${backendBaseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}/export-docx?version_id=${versionId}`,
    { headers: authHeaders(token, false) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), DOCX_MIME_TYPE);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 4 && bytes.length <= 10 * 1024 * 1024);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  return bytes;
}

async function runOptionalLegacyMatterOcr(backendBaseUrl, token, fixture) {
  const enabled = process.env.VERA_PACKAGED_OCR_LEGACY_MATTER ?? "false";
  assert.ok(
    enabled === "true" || enabled === "false",
    "VERA_PACKAGED_OCR_LEGACY_MATTER must be true or false.",
  );
  if (enabled !== "true") return false;

  const create = await auditFetch(`${backendBaseUrl}/aletheia/matters`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      title: "Native OCR Audit Matter",
      objective: "Verify optional legacy Matter OCR ingestion.",
      template: "civil_litigation",
      status: "draft",
      riskLevel: "medium",
      clientOrProject: null,
      sourceProjectId: null,
      sharedWith: [],
      metadata: { audit: "packaged_native_ocr_legacy" },
    }),
  });
  assert.equal(create.status, 201);
  const matter = record(await create.json(), "legacy Matter");
  const form = new FormData();
  form.append(
    "file",
    new Blob([fs.readFileSync(fixture)], { type: "application/pdf" }),
    "scanned-contract.pdf",
  );
  const upload = await auditFetch(
    `${backendBaseUrl}/aletheia/matters/${matter.id}/documents`,
    { method: "POST", headers: authHeaders(token, false), body: form },
  );
  assert.equal(upload.status, 201);
  const document = record(await upload.json(), "legacy Matter document");
  assert.equal(document.parsed_status, "parsed");
  assert.equal(document.metadata.parserMetadata.parser, "pdf+apple-vision");
  const search = await auditFetch(
    `${backendBaseUrl}/aletheia/matters/${matter.id}/documents/search?q=PAYMENT%20DUE`,
    { headers: authHeaders(token, false) },
  );
  assert.equal(search.status, 200);
  const hit = array(await search.json(), "legacy Matter search").find(
    (item) => item.document_id === document.id,
  );
  assert.equal(hit.ocr_provenance.engine, "apple-vision");
  assert.equal(hit.ocr_provenance.page, 1);
  return true;
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("This audit requires macOS.");
  const desktopDir = path.resolve(__dirname, "..");
  const appPath =
    process.env.ALETHEIA_PACKAGED_APP_PATH ??
    path.join(desktopDir, "dist", `mac-${process.arch}`, "Vera.app");
  const frontendPort = checkedPort(
    process.env.ALETHEIA_DESKTOP_FRONTEND_PORT ?? 43760,
    "frontend port",
  );
  const backendPort = checkedPort(
    process.env.ALETHEIA_DESKTOP_BACKEND_PORT ?? 43761,
    "backend port",
  );
  const frontendUrl = `http://127.0.0.1:${frontendPort}/assistant`;
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
  await assertPortsFree(frontendPort, backendPort);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vera-packaged-p1-"));
  const fixture = path.join(root, "scanned-contract.pdf");
  const userDataDir = path.join(root, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  try {
    execFileSync(
      "/usr/bin/xcrun",
      [
        "swift",
        path.join(desktopDir, "native", "ocr-audit-fixture.swift"),
        fixture,
      ],
      { stdio: "inherit" },
    );
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const masterKey = crypto.randomBytes(32).toString("base64");
  const databaseKey = crypto.randomBytes(32).toString("base64");
  const launchEnvironment = {
    ...process.env,
    VERA_DESKTOP_PROFILE_DIR: userDataDir,
    // Provider-readiness compatibility remains on the retained Legacy route;
    // no durable Legacy worker is required by this Project/Studio audit.
    VERA_ENABLE_LEGACY_ROUTES: "true",
    VERA_ENABLE_LEGACY_RUNTIME: "false",
    ALETHEIA_DEMO_SEED_ENABLED: "false",
    ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: "false",
    ALETHEIA_APPLICATION_ENCRYPTION: "required",
    ALETHEIA_MASTER_KEY_SOURCE: "env",
    ALETHEIA_MASTER_KEY_BASE64: masterKey,
    ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
    ALETHEIA_DATABASE_KEY_SOURCE: "env",
    ALETHEIA_DATABASE_KEY_BASE64: databaseKey,
    ALETHEIA_DESKTOP_FRONTEND_PORT: String(frontendPort),
    ALETHEIA_DESKTOP_BACKEND_PORT: String(backendPort),
  };
  for (const key of LEGAL_PROVIDER_ENV_KEYS) delete launchEnvironment[key];

  let running = null;
  let projectId;
  let sourceDocumentId;
  let sourceVersionId;
  let snapshotId;
  let citationAnchorId;
  let citationChunkId;
  let studioDocumentId;
  let studioInitialVersionId;
  let studioSavedVersionId;
  let studioImportedVersionId;
  let legacyMatterIncluded = false;
  const studioRoundTripSentinel = "VERAPACKAGEDP1STUDIOSENTINEL";
  const citationQuote = "2026-09-01";
  const studioContent = `# Packaged P1 Studio\n\n${studioRoundTripSentinel} preserves Project OCR work product. 😀`;

  try {
    running = await launchVera({
      executablePath,
      env: launchEnvironment,
      frontendUrl,
    });
    let token = running.token;
    assertLegalProvidersRemainDisabled(
      await readLegalProviders(backendBaseUrl, token),
    );

    const projectResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Packaged P1 Project" }),
      },
    );
    assert.equal(projectResponse.status, 201);
    const project = record(await projectResponse.json(), "Project");
    projectId = project.id;

    const uploadForm = new FormData();
    uploadForm.append(
      "file",
      new Blob([fs.readFileSync(fixture)], { type: "application/pdf" }),
      "scanned-contract.pdf",
    );
    const uploadResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/documents`,
      {
        method: "POST",
        headers: authHeaders(token, false),
        body: uploadForm,
      },
    );
    assert.equal(uploadResponse.status, 201);
    const uploaded = record(await uploadResponse.json(), "Project upload");
    sourceDocumentId = record(uploaded.document, "uploaded document").id;
    sourceVersionId = record(uploaded.version, "uploaded version").id;

    const readyDocument = await waitForReadyProjectDocument(
      backendBaseUrl,
      token,
      projectId,
      sourceDocumentId,
    );
    assert.equal(readyDocument.active_version_number, 1);
    assertOcrSummary(readyDocument);
    const readyVersions = await readProjectDocumentVersions(
      backendBaseUrl,
      token,
      sourceDocumentId,
    );
    assert.equal(readyVersions.current_version_id, sourceVersionId);
    assert.deepEqual(
      array(readyVersions.versions, "Project document versions").map(
        (version) => version.id,
      ),
      [sourceVersionId],
    );
    const readyText = await readProjectDocumentText(
      backendBaseUrl,
      token,
      sourceDocumentId,
      sourceVersionId,
    );
    assert.equal(readyText.document_id, sourceDocumentId);
    assert.equal(readyText.version_id, sourceVersionId);
    assert.match(readyText.content, /PAYMENT\s+DUE/i);
    assert.match(readyText.content, /2026-09-01/);

    const captureResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/sources/document-snapshots`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          document_id: sourceDocumentId,
          version_id: sourceVersionId,
        }),
      },
    );
    assert.equal(captureResponse.status, 201);
    const capture = record(await captureResponse.json(), "source capture");
    assert.equal(capture.reused, false);
    const snapshot = record(capture.snapshot, "Project source snapshot");
    snapshotId = snapshot.id;
    assert.equal(snapshot.kind, "project_document");
    assert.equal(snapshot.source_record_id, sourceDocumentId);
    assert.equal(snapshot.source_version_id, sourceVersionId);
    assert.equal(snapshot.license.basis, "user_provided");
    assert.equal(snapshot.license.retention, "full_text_permitted");

    const sourceContentResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/sources/${snapshotId}/content?limit=20`,
      { headers: authHeaders(token, false) },
    );
    const sourceContent = record(
      await responseJson(sourceContentResponse, "Project source content"),
      "Project source content",
    );
    assert.equal(sourceContent.snapshot_id, snapshotId);
    assert.equal(sourceContent.document.document_id, sourceDocumentId);
    assert.equal(sourceContent.document.version_id, sourceVersionId);
    const citationChunk = array(
      sourceContent.chunks,
      "Project source chunks",
    ).find(
      (chunk) =>
        typeof chunk.text === "string" && chunk.text.includes(citationQuote),
    );
    assert.ok(
      citationChunk,
      "Packaged Project source chunk must contain citation quote.",
    );
    citationChunkId = citationChunk.id;

    const anchorResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/sources/${snapshotId}/anchors`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          chunk_id: citationChunkId,
          exact_quote: citationQuote,
        }),
      },
    );
    assert.equal(anchorResponse.status, 201);
    const citationAnchor = record(
      record(await anchorResponse.json(), "citation anchor response").anchor,
      "citation anchor",
    );
    citationAnchorId = citationAnchor.id;
    assert.equal(citationAnchor.snapshot_id, snapshotId);
    assert.equal(citationAnchor.exact_quote, citationQuote);
    assert.equal(citationAnchor.locator.chunkId, citationChunkId);
    assert.equal(citationAnchor.locator.ocr.page, 1);

    const createStudioResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/studio/documents`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ title: "Packaged P1 Draft" }),
      },
    );
    assert.equal(createStudioResponse.status, 201);
    const studioCreated = record(
      await createStudioResponse.json(),
      "Studio draft",
    );
    studioDocumentId = studioCreated.document_id;
    studioInitialVersionId = studioCreated.current_version_id;
    assert.equal(studioCreated.content, "");

    const saveStudioResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/studio/documents/${studioDocumentId}`,
      {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({
          expected_version_id: studioInitialVersionId,
          content: studioContent,
          source: "user_upload",
          citation_anchor_ids: [citationAnchorId],
          summary: "Packaged P1 CAS save",
        }),
      },
    );
    assert.equal(saveStudioResponse.status, 201);
    const studioSaved = record(await saveStudioResponse.json(), "Studio save");
    studioSavedVersionId = studioSaved.current_version_id;
    assert.notEqual(studioSavedVersionId, studioInitialVersionId);
    assert.equal(studioSaved.content, studioContent);
    assert.deepEqual(studioSaved.version.citation_anchor_ids, [
      citationAnchorId,
    ]);
    assert.equal(studioSaved.citation_anchors[0].id, citationAnchorId);

    const exportedDocx = await exportStudioDocx(
      backendBaseUrl,
      token,
      projectId,
      studioDocumentId,
      studioSavedVersionId,
    );
    const importForm = new FormData();
    importForm.append("expected_version_id", studioSavedVersionId);
    importForm.append(
      "file",
      new Blob([exportedDocx], { type: DOCX_MIME_TYPE }),
      "packaged-p1-roundtrip.docx",
    );
    const importResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/studio/documents/${studioDocumentId}/import-docx`,
      {
        method: "POST",
        headers: authHeaders(token, false),
        body: importForm,
      },
    );
    assert.equal(importResponse.status, 201);
    const imported = record(await importResponse.json(), "Studio DOCX import");
    const importedDocument = record(
      imported.document,
      "imported Studio document",
    );
    studioImportedVersionId = importedDocument.current_version_id;
    assert.notEqual(studioImportedVersionId, studioSavedVersionId);
    assert.ok(importedDocument.content.includes(studioRoundTripSentinel));
    assert.deepEqual(importedDocument.version.citation_anchor_ids, [
      citationAnchorId,
    ]);
    assert.equal(importedDocument.citation_anchors[0].id, citationAnchorId);

    legacyMatterIncluded = await runOptionalLegacyMatterOcr(
      backendBaseUrl,
      token,
      fixture,
    );

    const firstLaunch = running;
    const firstCloseDialogs = await closeVera(firstLaunch);
    running = null;
    await waitForPortsClosed(frontendPort, backendPort);
    assert.deepEqual(
      firstCloseDialogs,
      [],
      "The first packaged launch must close without a browser dialog.",
    );
    await assertPortsFree(frontendPort, backendPort);

    running = await launchVera({
      executablePath,
      env: launchEnvironment,
      frontendUrl,
    });
    token = running.token;
    assertLegalProvidersRemainDisabled(
      await readLegalProviders(backendBaseUrl, token),
    );

    const projectAfterRestart = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}`,
      { headers: authHeaders(token, false) },
    );
    assert.equal(projectAfterRestart.status, 200);
    assert.equal((await projectAfterRestart.json()).id, projectId);

    const persistedSourceDocument = (
      await listProjectDocuments(backendBaseUrl, token, projectId)
    ).find((document) => document.id === sourceDocumentId);
    assert.equal(persistedSourceDocument.status, "ready");
    assertOcrSummary(persistedSourceDocument);
    const persistedSourceVersions = await readProjectDocumentVersions(
      backendBaseUrl,
      token,
      sourceDocumentId,
    );
    assert.equal(persistedSourceVersions.current_version_id, sourceVersionId);
    assert.deepEqual(
      array(
        persistedSourceVersions.versions,
        "persisted Project document versions",
      ).map((version) => version.id),
      [sourceVersionId],
    );
    const persistedText = await readProjectDocumentText(
      backendBaseUrl,
      token,
      sourceDocumentId,
      sourceVersionId,
    );
    assert.equal(persistedText.document_id, sourceDocumentId);
    assert.equal(persistedText.version_id, sourceVersionId);
    assert.match(persistedText.content, /PAYMENT\s+DUE/i);
    assert.match(persistedText.content, /2026-09-01/);

    const sourceListResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/sources?kind=project_document&limit=100`,
      { headers: authHeaders(token, false) },
    );
    const sourceList = record(
      await responseJson(sourceListResponse, "Project source list"),
      "source list",
    );
    const persistedSnapshot = array(sourceList.sources, "sources").find(
      (item) => item.id === snapshotId,
    );
    assert.equal(persistedSnapshot.source_record_id, sourceDocumentId);
    assert.equal(persistedSnapshot.source_version_id, sourceVersionId);

    const sourceDetailResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/sources/${snapshotId}`,
      { headers: authHeaders(token, false) },
    );
    const sourceDetail = record(
      await responseJson(sourceDetailResponse, "Project source detail"),
      "source detail",
    );
    assert.equal(sourceDetail.snapshot.id, snapshotId);
    assert.equal(sourceDetail.anchors.length, 1);
    assert.equal(sourceDetail.anchors[0].id, citationAnchorId);
    assert.equal(sourceDetail.anchors[0].exact_quote, citationQuote);
    assert.equal(sourceDetail.anchors[0].locator.chunkId, citationChunkId);

    const recoveredSourceContentResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/sources/${snapshotId}/content?chunk_id=${citationChunkId}`,
      { headers: authHeaders(token, false) },
    );
    const recoveredSourceContent = record(
      await responseJson(
        recoveredSourceContentResponse,
        "recovered Project source content",
      ),
      "recovered Project source content",
    );
    assert.equal(recoveredSourceContent.snapshot_id, snapshotId);
    assert.equal(recoveredSourceContent.chunks.length, 1);
    assert.equal(recoveredSourceContent.chunks[0].id, citationChunkId);
    assert.ok(recoveredSourceContent.chunks[0].text.includes(citationQuote));

    const studioCurrentResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/studio/documents/${studioDocumentId}`,
      { headers: authHeaders(token, false) },
    );
    const studioCurrent = record(
      await responseJson(studioCurrentResponse, "current Studio document"),
      "current Studio document",
    );
    assert.equal(studioCurrent.current_version_id, studioImportedVersionId);
    assert.ok(studioCurrent.content.includes(studioRoundTripSentinel));
    assert.deepEqual(studioCurrent.version.citation_anchor_ids, [
      citationAnchorId,
    ]);
    assert.equal(studioCurrent.citation_anchors.length, 1);
    assert.equal(studioCurrent.citation_anchors[0].id, citationAnchorId);

    const studioVersionsResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/studio/documents/${studioDocumentId}/versions`,
      { headers: authHeaders(token, false) },
    );
    const studioVersions = record(
      await responseJson(studioVersionsResponse, "Studio version list"),
      "Studio versions",
    );
    assert.equal(studioVersions.current_version_id, studioImportedVersionId);
    const versionIds = array(studioVersions.versions, "Studio versions").map(
      (version) => version.id,
    );
    assert.equal(versionIds.length, 3);
    assert.deepEqual(
      new Set(versionIds),
      new Set([
        studioInitialVersionId,
        studioSavedVersionId,
        studioImportedVersionId,
      ]),
    );

    const historicalResponse = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/studio/documents/${studioDocumentId}?version_id=${studioSavedVersionId}`,
      { headers: authHeaders(token, false) },
    );
    const historical = record(
      await responseJson(historicalResponse, "historical Studio document"),
      "historical Studio document",
    );
    assert.equal(historical.version.id, studioSavedVersionId);
    assert.equal(historical.content, studioContent);
    assert.deepEqual(historical.version.citation_anchor_ids, [
      citationAnchorId,
    ]);
    assert.equal(historical.citation_anchors[0].id, citationAnchorId);

    await running.page.goto(
      `http://127.0.0.1:${frontendPort}/projects/${projectId}/documents/${studioDocumentId}/studio`,
    );
    const studioSaveStatus = running.page.getByTestId("studio-save-status");
    await studioSaveStatus.waitFor({
      state: "visible",
      timeout: STARTUP_TIMEOUT_MS,
    });
    const citationButton = running.page.getByTestId(
      `studio-citation-open-${citationAnchorId}`,
    );
    await citationButton.waitFor({
      state: "visible",
      timeout: STARTUP_TIMEOUT_MS,
    });
    await assertAttributeStable(
      studioSaveStatus,
      "data-state",
      "saved",
      "Loading authoritative Studio content must not create an unsaved edit.",
    );
    const displayResponsePromise = running.page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === backendBaseUrl &&
          url.pathname === `/api/v1/documents/${sourceDocumentId}/display`
        );
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    await citationButton.click();
    const displayResponse = await displayResponsePromise;
    const displayUrl = new URL(displayResponse.url());
    assert.equal(displayResponse.status(), 200);
    assert.equal(displayUrl.searchParams.get("version_id"), sourceVersionId);
    assert.equal(
      String(displayResponse.headers()["content-type"])
        .split(";", 1)[0]
        .trim()
        .toLowerCase(),
      "application/pdf",
    );
    const sourceViewer = running.page.getByTestId(
      "project-citation-source-viewer",
    );
    await sourceViewer.waitFor({
      state: "visible",
      timeout: REQUEST_TIMEOUT_MS,
    });
    assert.equal(
      await running.page
        .getByTestId("project-citation-highlight")
        .textContent(),
      citationQuote,
    );
    const originalPdfFrame = running.page.locator(
      '[data-testid="project-citation-original-pdf"] iframe',
    );
    await originalPdfFrame.waitFor({
      state: "visible",
      timeout: REQUEST_TIMEOUT_MS,
    });
    assert.match(
      String(await originalPdfFrame.getAttribute("src")),
      /#page=1$/,
    );
    await assertAttributeStable(
      studioSaveStatus,
      "data-state",
      "saved",
      "Opening a citation must not dirty the Studio document.",
    );

    await exportStudioDocx(
      backendBaseUrl,
      token,
      projectId,
      studioDocumentId,
      studioSavedVersionId,
    );
    const afterHistoricalExport = await auditFetch(
      `${backendBaseUrl}/api/v1/projects/${projectId}/studio/documents/${studioDocumentId}/versions`,
      { headers: authHeaders(token, false) },
    );
    const afterExportVersions = record(
      await responseJson(afterHistoricalExport, "post-export Studio versions"),
      "post-export Studio versions",
    );
    assert.equal(
      afterExportVersions.current_version_id,
      studioImportedVersionId,
    );
    assert.equal(afterExportVersions.versions.length, 3);

    const secondLaunch = running;
    const secondCloseDialogs = await closeVera(secondLaunch);
    running = null;
    await waitForPortsClosed(frontendPort, backendPort);
    assert.deepEqual(
      secondCloseDialogs,
      [],
      "The Studio packaged launch must close without a browser dialog.",
    );
    await assertPortsFree(frontendPort, backendPort);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-packaged-project-ocr-studio-v1",
          legacyMatterIncluded,
          checks: [
            "packaged Apple Vision helper executable present",
            "renderer-authenticated generic Project creation",
            "image-only PDF parsed to ready through the packaged helper",
            "current Project document version exposes bounded OCR review summary",
            "immutable Project document source captured through the public API",
            "bounded source content creates a real exact-quote citation anchor",
            "Studio draft CAS save and DOCX export-import round trip",
            "same encrypted profile and keys restart successfully",
            "Project OCR source, exact anchor, and Studio citation binding persist after restart",
            "Studio citation reopens the authenticated original PDF at the recorded page",
            "historical Studio DOCX export remains available without mutation",
            "legal providers remain secret-free and untested",
            "packaged local service ports release between launches",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (running) {
      const failedLaunch = running;
      running = null;
      await closeVera(failedLaunch).catch(() =>
        forceTerminate(failedLaunch.app),
      );
    }
    await waitForPortsClosed(frontendPort, backendPort).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
