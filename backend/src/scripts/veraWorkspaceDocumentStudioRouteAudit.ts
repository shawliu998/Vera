import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express, { type Express } from "express";
import PizZip from "pizzip";

import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceSourceFoundationRepository } from "../lib/workspace/repositories/sourceFoundation";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import { ChatsService } from "../lib/workspace/services/chats";
import type { WorkspaceDocumentStudioService } from "../lib/workspace/services/documentStudio";
import {
  DOCUMENT_STUDIO_DOCX_MIME_TYPE,
  DOCUMENT_STUDIO_MAX_DOCX_BYTES,
  exportDocumentStudioMarkdownToDocx,
  importDocumentStudioDocxToMarkdown,
} from "../lib/workspace/documentStudioDocx";
import {
  createWorkspaceDocumentStudioV1Router,
  type WorkspaceDocumentStudioV1Port,
} from "../routes/workspaceDocumentStudioV1";
import { createVeraApplication } from "../veraApplication";

const TOKEN = "vera-document-studio-route-audit-token-0000000000000000";
const NOW = "2026-07-15T10:00:00.000Z";
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-document-studio-route-audit-"),
);
const dataDir = path.join(root, "data");
const blobRoot = path.join(root, "blobs");
const encryptionKey = randomBytes(32);
const originalEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), label);
  return value;
}

function encryptedAuditCodec(key: Buffer): WorkspaceBlobCodec {
  return {
    encrypted: true,
    encode({ filePath, plaintext, purpose }) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`${purpose}\0${filePath}`, "utf8"));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return Buffer.concat([
        Buffer.from("VDS1", "ascii"),
        nonce,
        cipher.getAuthTag(),
        ciphertext,
      ]);
    },
    decode({ filePath, envelope, purpose }) {
      assert.equal(envelope.subarray(0, 4).toString("ascii"), "VDS1");
      const nonce = envelope.subarray(4, 16);
      const tag = envelope.subarray(16, 32);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.from(`${purpose}\0${filePath}`, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(envelope.subarray(32)),
        decipher.final(),
      ]);
    },
  };
}

function inertPump() {
  let started = false;
  return {
    async start() {
      started = true;
      return {
        alreadyStarted: false,
        recoveredJobs: [],
        capabilities: {
          leaseHeartbeatSupported: true as const,
          leaseTokenFencingSupported: true as const,
          notes: [],
        },
      };
    },
    async stop() {
      started = false;
      return {
        alreadyStopped: false,
        drained: true,
        timedOut: false,
        restartBlocked: false,
      };
    },
    snapshot() {
      return {
        started,
        stopping: false,
        restartBlocked: false,
        activeWorkers: 0,
        idleBackoffMs: 1,
      };
    },
  };
}

function createRuntime() {
  return new WorkspaceRuntime({
    dataDir,
    blobs: new LocalWorkspaceBlobStore({
      root: blobRoot,
      codec: encryptedAuditCodec(encryptionKey),
    }),
    pump: inertPump(),
  });
}

function environment() {
  return {
    ...process.env,
    NODE_ENV: "test",
    ALETHEIA_AUTH_MODE: "private_token",
    ALETHEIA_PRIVATE_AUTH_TOKEN: TOKEN,
    FRONTEND_URL: "http://localhost:3000",
    RATE_LIMIT_GENERAL_MAX: "1000",
  };
}

function authHeaders(json = true): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function withServer<T>(
  app: Express,
  operation: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function responseJson(response: Response) {
  const text = await response.text();
  return {
    text,
    value: text ? (JSON.parse(text) as unknown) : null,
  };
}

async function assertSafeError(
  response: Response,
  status: number,
  code: string,
) {
  assert.equal(response.status, status);
  const payload = await responseJson(response);
  assert.equal(record(payload.value, "error response").code, code);
  assert.equal(payload.text.includes(root), false);
  assert.equal(payload.text.includes("DocumentStudioDocxError"), false);
  assert.equal(payload.text.includes("storage_path"), false);
  return payload;
}

function veraApp(runtime: WorkspaceRuntime) {
  return createVeraApplication({
    runtime,
    env: environment(),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    auditWriteBlocked: () => false,
  });
}

async function createProject(baseUrl: string, name: string) {
  const response = await fetch(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 201);
  return String(
    record((await responseJson(response)).value, "project response").id,
  );
}

async function uploadMarkdown(
  baseUrl: string,
  urlPath: string,
  filename: string,
  content: string,
) {
  const body = new FormData();
  body.append("file", new Blob([content], { type: "text/markdown" }), filename);
  return fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: authHeaders(false),
    body,
  });
}

async function uploadDocx(
  baseUrl: string,
  urlPath: string,
  bytes: Uint8Array,
  options: {
    filename?: string;
    mimeType?: string;
    fields?: ReadonlyArray<readonly [string, string]>;
    authenticated?: boolean;
  } = {},
) {
  const body = new FormData();
  for (const [name, value] of options.fields ?? []) body.append(name, value);
  body.append(
    "file",
    new Blob([new Uint8Array(bytes)], {
      type: options.mimeType ?? DOCUMENT_STUDIO_DOCX_MIME_TYPE,
    }),
    options.filename ?? "studio-import.docx",
  );
  return fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: options.authenticated === false ? {} : authHeaders(false),
    body,
  });
}

function editDocxPart(
  bytes: Buffer,
  name: string,
  edit: (value: string) => string,
): Buffer {
  const archive = new PizZip(bytes);
  const value = archive.file(name)?.asText();
  assert.notEqual(value, undefined, `${name} must exist in DOCX fixture`);
  archive.file(name, edit(value!));
  return archive.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;
}

function listFiles(directory: string): string[] {
  const values: string[] = [];
  for (const name of readdirSync(directory)) {
    const value = path.join(directory, name);
    if (statSync(value).isDirectory()) values.push(...listFiles(value));
    else values.push(value);
  }
  return values;
}

function documentVersionState(runtime: WorkspaceRuntime, documentId: string) {
  const current = runtime.database
    .prepare("SELECT current_version_id FROM documents WHERE id = ?")
    .get(documentId) as { current_version_id?: unknown } | undefined;
  return {
    currentVersionId: String(current?.current_version_id ?? ""),
    versionCount: Number(
      runtime.database
        .prepare(
          "SELECT count(*) AS count FROM document_versions WHERE document_id = ?",
        )
        .get(documentId)?.count,
    ),
  };
}

async function auditExactResponseBoundary() {
  const injectedPath = "/private/vera/storage/source.md";
  const injectedSecret = "credential_secret_should_never_serialize";
  const valid = {
    document_id: randomUUID(),
    project_id: randomUUID(),
    title: "Boundary draft",
    filename: "Boundary draft.md",
    format: "markdown",
    current_version_id: randomUUID(),
    version: {
      id: randomUUID(),
      version_number: 1,
      source: "user_upload",
      filename: "Boundary draft.md",
      mime_type: "text/markdown",
      size_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: NOW,
      citation_anchor_ids: [],
    },
    content:
      "User text may say /Users/alice or password=literal or Bearer sample.",
    citation_anchors: [],
    capabilities: { docx_import: true, docx_export: true },
  };
  const port: WorkspaceDocumentStudioV1Port = {
    async createStudioDocument() {
      return {
        ...valid,
        storage_path: injectedPath,
        credential_secret: injectedSecret,
      };
    },
    async getStudioDocument() {
      return valid;
    },
    async saveStudioDocument() {
      return valid;
    },
    async listStudioDocumentVersions() {
      return {
        current_version_id: valid.current_version_id,
        versions: [valid.version],
      };
    },
    async restoreStudioDocumentVersion() {
      return valid;
    },
    async importStudioDocumentDocx() {
      return {
        document: {
          ...valid,
          storage_path: injectedPath,
          credential_secret: injectedSecret,
        },
        warningCodes: [],
      };
    },
    async exportStudioDocumentDocx() {
      return {
        filename: "boundary.docx",
        contentType: DOCUMENT_STUDIO_DOCX_MIME_TYPE,
        bytes: new Uint8Array([1]),
        warningCodes: [],
        storage_path: injectedPath,
        credential_secret: injectedSecret,
      } as never;
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    createWorkspaceDocumentStudioV1Router(port, {
      principal: () => WORKSPACE_LOCAL_PRINCIPAL_ID,
    }),
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/projects/${valid.project_id}/studio/documents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Boundary draft" }),
      },
    );
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body.includes(injectedPath), false);
    assert.equal(body.includes(injectedSecret), false);
    assert.equal(body.includes("storage_path"), false);

    const importResponse = await uploadDocx(
      baseUrl,
      `/projects/${valid.project_id}/studio/documents/${valid.document_id}/import-docx`,
      new Uint8Array([1]),
      {
        fields: [["expected_version_id", valid.current_version_id]],
        authenticated: false,
      },
    );
    assert.equal(importResponse.status, 500);
    const importBody = await importResponse.text();
    assert.equal(importBody.includes(injectedPath), false);
    assert.equal(importBody.includes(injectedSecret), false);

    const exportResponse = await fetch(
      `${baseUrl}/projects/${valid.project_id}/studio/documents/${valid.document_id}/export-docx`,
    );
    assert.equal(exportResponse.status, 500);
    const exportBody = await exportResponse.text();
    assert.equal(exportBody.includes(injectedPath), false);
    assert.equal(exportBody.includes(injectedSecret), false);
  });
}

async function main() {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  await auditExactResponseBoundary();

  let runtime = createRuntime();
  await runtime.start();
  let projectId = "";
  let otherProjectId = "";
  let documentId = "";
  let initialVersionId = "";
  let citedVersionId = "";
  let renamedVersionId = "";
  let restoredVersionId = "";
  const opaqueText =
    "# 保真草稿\r\n/Users/alice/case must remain user text.\r\npassword=literal and Bearer sample-token.\r\n<span>renderer sanitizes this</span>\r\nCafe\u0301";
  const exactQuote =
    "Quoted user text: /Users/witness; password=literal; Bearer sample-token.";

  try {
    await withServer(veraApp(runtime), async (baseUrl) => {
      const unauthenticated = await fetch(
        `${baseUrl}/api/v1/projects/${randomUUID()}/studio/documents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Denied" }),
        },
      );
      assert.equal(unauthenticated.status, 401);

      projectId = await createProject(baseUrl, "Studio Project");
      otherProjectId = await createProject(baseUrl, "Other Project");

      const createResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ title: "Motion Draft" }),
        },
      );
      assert.equal(createResponse.status, 201);
      const created = record(
        (await responseJson(createResponse)).value,
        "created Studio document",
      );
      documentId = String(created.document_id);
      initialVersionId = String(record(created.version, "initial version").id);
      assert.equal(created.current_version_id, initialVersionId);
      assert.equal(created.content, "");
      assert.deepEqual(created.capabilities, {
        docx_import: true,
        docx_export: true,
      });

      const suggestionDraftResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ title: "Suggestion acceptance wire audit" }),
        },
      );
      assert.equal(suggestionDraftResponse.status, 201);
      const suggestionDraft = record(
        (await responseJson(suggestionDraftResponse)).value,
        "suggestion Studio document",
      );
      const suggestionDocumentId = String(suggestionDraft.document_id);
      const suggestionBaseVersionId = String(
        record(suggestionDraft.version, "suggestion base version").id,
      );
      const suggestionProfileId = randomUUID();
      const profiles = new ModelProfilesRepository(runtime.database);
      const connectionTests = new ModelConnectionTestsRepository(
        runtime.database,
      );
      profiles.create({
        id: suggestionProfileId,
        name: "Suggestion route audit model",
        provider: "openai",
        model: "audit-model",
        baseUrl: null,
        credentialOrigin: null,
        credentialState: "missing",
        contextWindowTokens: 16_000,
        maxOutputTokens: 2_000,
        enabled: false,
        isDefault: false,
        capabilities: {
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
          vision: false,
        },
        now: NOW,
      });
      const storedProfile = profiles.requireStored(suggestionProfileId);
      assert.equal(
        connectionTests.storeIfCurrent({
          profileId: suggestionProfileId,
          expectedConnectionRevision: storedProfile.connectionRevision,
          status: "passed",
          errorCode: null,
          retryable: false,
          latencyMs: 1,
          testedAt: NOW,
        }).stored,
        true,
      );
      profiles.update(suggestionProfileId, { enabled: true, now: NOW });
      new ModelProfilePrivacyRepository(runtime.database).declare(
        suggestionProfileId,
        {
          executionLocation: "local",
          retention: "zero",
          trainingUse: "prohibited",
          sensitiveDataAllowed: true,
        },
        NOW,
      );
      const chatsRepository = new ChatsRepository(runtime.database);
      const chats = new ChatsService(
        chatsRepository,
        new ProjectsRepository(runtime.database),
        profiles,
        () => new Date(NOW),
        {
          jobs: runtime.jobs,
          generationControl: runtime.jobs,
          inferencePolicy: new WorkspaceInferencePolicy(runtime.database),
        },
      );
      const suggestionChat = chats.create({
        projectId,
        title: "Suggestion wire audit",
        modelProfileId: suggestionProfileId,
      });
      const suggestionGeneration = chats.requestGeneration({
        chatId: suggestionChat.id,
        prompt: "Insert the reviewed text.",
        modelProfileId: suggestionProfileId,
        allowedDocumentIds: [suggestionDocumentId],
        attachmentDocumentIds: [suggestionDocumentId],
        retrievalLimit: 10,
      });
      const suggestionSnapshot = chatsRepository.generationSnapshot(
        suggestionGeneration.jobId,
      );
      const suggestionLeaseOwner = "studio-route-suggestion-audit";
      const suggestionClaimed = runtime.jobs.repository.claimNextQueuedForTypes(
        NOW,
        ["assistant_generate"],
        suggestionLeaseOwner,
        new Date(Date.parse(NOW) + 60_000).toISOString(),
      );
      assert.equal(suggestionClaimed?.id, suggestionGeneration.jobId);
      assert(suggestionClaimed);
      const suggestionClaim = {
        jobId: suggestionGeneration.jobId,
        leaseOwner: suggestionLeaseOwner,
        attempt: suggestionClaimed.attempt,
        at: NOW,
      };
      chatsRepository.beginGenerationAttempt({
        snapshot: suggestionSnapshot,
        claim: suggestionClaim,
        claims: runtime.jobs.repository,
        now: NOW,
      });
      const studioService = (
        runtime as unknown as {
          documentStudioService: WorkspaceDocumentStudioService;
        }
      ).documentStudioService;
      const pendingSuggestion =
        await studioService.createSuggestionFromAssistantTool({
          projectId,
          documentId: suggestionDocumentId,
          baseVersionId: suggestionBaseVersionId,
          messageId: suggestionSnapshot.outputMessageId,
          jobId: suggestionGeneration.jobId,
          attempt: suggestionClaimed.attempt,
          toolCallId: "accept-through-runtime-wire",
          startOffset: 0,
          endOffset: 0,
          exactDeletedText: "",
          insertedText: "Accepted through the authenticated route.\n",
          summary: "Exercise the user_accept runtime wire contract",
        });
      chatsRepository.commitGenerationComplete({
        snapshot: suggestionSnapshot,
        claim: suggestionClaim,
        claims: runtime.jobs.repository,
        content: "Suggestion ready for explicit acceptance.",
        sources: [],
        now: NOW,
      });
      const acceptSuggestionResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${suggestionDocumentId}/suggestions/${pendingSuggestion.id}/accept`,
        {
          method: "POST",
          headers: authHeaders(),
          body: "{}",
        },
      );
      assert.equal(acceptSuggestionResponse.status, 201);
      const acceptedSuggestionPayload = record(
        (await responseJson(acceptSuggestionResponse)).value,
        "accepted suggestion response",
      );
      const acceptedSuggestionDocument = record(
        acceptedSuggestionPayload.document,
        "accepted document",
      );
      assert.equal(
        record(acceptedSuggestionDocument.version, "accepted user version")
          .source,
        "user_accept",
      );
      assert.equal(
        record(acceptedSuggestionPayload.suggestion, "accepted suggestion")
          .status,
        "accepted",
      );
      assert.equal(
        acceptedSuggestionDocument.content,
        "Accepted through the authenticated route.\n",
      );

      const sourceUpload = await uploadMarkdown(
        baseUrl,
        `/api/v1/projects/${projectId}/documents`,
        "ordinary-source.md",
        "ordinary source markdown",
      );
      assert.equal(sourceUpload.status, 201);
      const sourceMutation = record(
        (await responseJson(sourceUpload)).value,
        "ordinary source upload",
      );
      const sourceDocument = record(
        sourceMutation.document,
        "ordinary source document",
      );
      assert.deepEqual(sourceDocument.studio_capability, {
        editable: false,
        format: null,
        docx_import: false,
        docx_export: false,
      });

      const projectDocumentsResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/documents`,
        { headers: authHeaders(false) },
      );
      assert.equal(projectDocumentsResponse.status, 200);
      const projectDocuments = array(
        (await responseJson(projectDocumentsResponse)).value,
        "Project documents",
      ).map((value) => record(value, "Project document"));
      const draftProjection = projectDocuments.find(
        (value) => value.id === documentId,
      );
      assert.ok(draftProjection);
      assert.deepEqual(draftProjection.studio_capability, {
        editable: true,
        format: "markdown",
        docx_import: true,
        docx_export: true,
      });

      const sources = new WorkspaceSourceFoundationRepository(runtime.database);
      const snapshot = sources.createSnapshot({
        id: randomUUID(),
        projectId,
        sourceKind: "legal_authority",
        sourceRecordId: "audit-authority-1",
        sourceVersionId: "effective-2026-01-01",
        titleSnapshot: "Audit authority",
        contentSha256: "a".repeat(64),
        locator: { authorityIdentifier: "AUDIT-1", section: "12" },
        retrievedAt: NOW,
        license: {
          basis: "user_provided",
          retention: "full_text_permitted",
          export: "exact_quotes_only",
          modelUse: "local_only",
        },
        retentionPolicy: "full_text_permitted",
        retentionExpiresAt: null,
        retrievalMetadata: { audit: "document-studio-route" },
        createdAt: NOW,
      });
      const anchor = sources.createCitationAnchor({
        id: randomUUID(),
        projectId,
        snapshotId: snapshot.id,
        ordinal: 0,
        exactQuote,
        locator: { section: "12", paragraph: 3 },
        createdAt: NOW,
      });
      const otherSnapshot = sources.createSnapshot({
        id: randomUUID(),
        projectId: otherProjectId,
        sourceKind: "legal_authority",
        sourceRecordId: "audit-authority-other",
        sourceVersionId: null,
        titleSnapshot: "Other authority",
        contentSha256: "b".repeat(64),
        locator: { authorityIdentifier: "AUDIT-OTHER" },
        retrievedAt: NOW,
        license: {
          basis: "user_provided",
          retention: "full_text_permitted",
          export: "exact_quotes_only",
          modelUse: "local_only",
        },
        retentionPolicy: "full_text_permitted",
        retentionExpiresAt: null,
        retrievalMetadata: { audit: "document-studio-route" },
        createdAt: NOW,
      });
      const otherAnchor = sources.createCitationAnchor({
        id: randomUUID(),
        projectId: otherProjectId,
        snapshotId: otherSnapshot.id,
        ordinal: 0,
        exactQuote: "Other Project quote.",
        locator: { section: "1" },
        createdAt: NOW,
      });

      const saveResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({
            expected_version_id: initialVersionId,
            content: opaqueText,
            source: "assistant_edit",
            citation_anchor_ids: [anchor.id],
            summary: "First cited edit",
          }),
        },
      );
      assert.equal(saveResponse.status, 201);
      const savedPayload = await responseJson(saveResponse);
      const saved = record(savedPayload.value, "saved Studio document");
      citedVersionId = String(record(saved.version, "cited version").id);
      assert.equal(saved.content, opaqueText);
      assert.equal(saved.current_version_id, citedVersionId);
      assert.equal(savedPayload.text.includes("/Users/alice/case"), true);
      const savedAnchors = array(
        saved.citation_anchors,
        "saved citation anchors",
      );
      assert.equal(savedAnchors.length, 1);
      assert.equal(
        record(savedAnchors[0], "saved citation").exact_quote,
        exactQuote,
      );

      const historicalResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}?version_id=${initialVersionId}`,
        { headers: authHeaders(false) },
      );
      assert.equal(historicalResponse.status, 200);
      const historical = record(
        (await responseJson(historicalResponse)).value,
        "historical Studio document",
      );
      assert.equal(
        record(historical.version, "historical version").id,
        initialVersionId,
      );
      assert.equal(historical.current_version_id, citedVersionId);
      assert.equal(historical.content, "");

      const listResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}/versions`,
        { headers: authHeaders(false) },
      );
      assert.equal(listResponse.status, 200);
      const listed = record(
        (await responseJson(listResponse)).value,
        "version list",
      );
      assert.equal(listed.current_version_id, citedVersionId);
      assert.equal(array(listed.versions, "versions").length, 2);

      const staleResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({
            expected_version_id: initialVersionId,
            content: "stale write",
            source: "user_upload",
          }),
        },
      );
      assert.equal(staleResponse.status, 409);
      const staleBody = await responseJson(staleResponse);
      assert.equal(record(staleBody.value, "stale error").code, "CONFLICT");
      assert.equal(staleBody.text.includes(root), false);
      assert.equal(staleBody.text.includes("WorkspaceDocumentStudio"), false);

      const invalidContent = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({
            expected_version_id: citedVersionId,
            content: "invalid\u0000content",
            source: "user_upload",
          }),
        },
      );
      assert.equal(invalidContent.status, 422);

      const wrongAnchor = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({
            expected_version_id: citedVersionId,
            content: "cross Project citation must fail",
            source: "assistant_edit",
            citation_anchor_ids: [otherAnchor.id],
          }),
        },
      );
      assert.equal(wrongAnchor.status, 404);

      const wrongProject = await fetch(
        `${baseUrl}/api/v1/projects/${otherProjectId}/studio/documents/${documentId}`,
        { headers: authHeaders(false) },
      );
      assert.equal(wrongProject.status, 404);

      const genericVersion = await uploadMarkdown(
        baseUrl,
        `/api/v1/projects/${projectId}/documents/${documentId}/versions`,
        "generic-replacement.md",
        "must not split the Studio lineage",
      );
      assert.equal(genericVersion.status, 409);

      const renameResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/documents/${documentId}`,
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ filename: "Renamed Motion Draft" }),
        },
      );
      assert.equal(renameResponse.status, 200);
      const renamedProjection = record(
        (await responseJson(renameResponse)).value,
        "renamed document projection",
      );
      assert.equal(renamedProjection.filename, "Renamed Motion Draft.md");
      assert.equal(
        record(renamedProjection.studio_capability, "renamed Studio capability")
          .editable,
        true,
      );

      const renamedSaveResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({
            expected_version_id: citedVersionId,
            content: "Renamed draft remains editable.",
            source: "user_upload",
            citation_anchor_ids: [],
          }),
        },
      );
      assert.equal(renamedSaveResponse.status, 201);
      const renamedSave = record(
        (await responseJson(renamedSaveResponse)).value,
        "renamed Studio save",
      );
      renamedVersionId = String(
        record(renamedSave.version, "renamed version").id,
      );
      assert.equal(renamedSave.filename, "Renamed Motion Draft.md");

      const restoreResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}/versions/${citedVersionId}/restore`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            expected_current_version_id: renamedVersionId,
          }),
        },
      );
      assert.equal(restoreResponse.status, 201);
      const restored = record(
        (await responseJson(restoreResponse)).value,
        "restored Studio document",
      );
      restoredVersionId = String(
        record(restored.version, "restored version").id,
      );
      assert.notEqual(restoredVersionId, citedVersionId);
      assert.equal(restored.current_version_id, restoredVersionId);
      assert.equal(restored.content, opaqueText);
      assert.deepEqual(
        record(restored.version, "restored version").citation_anchor_ids,
        [anchor.id],
      );
      assert.equal(
        array(restored.citation_anchors, "restored citations").length,
        1,
      );

      const finalListResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}/versions`,
        { headers: authHeaders(false) },
      );
      const finalList = record(
        (await responseJson(finalListResponse)).value,
        "final version list",
      );
      assert.equal(finalList.current_version_id, restoredVersionId);
      assert.equal(array(finalList.versions, "final versions").length, 4);

      await assertSafeError(
        await fetch(
          `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}/export-docx?version_id=${restoredVersionId}`,
          { headers: authHeaders(false) },
        ),
        409,
        "PRECONDITION_FAILED",
      );

      const createDocxResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ title: "DOCX Route Audit" }),
        },
      );
      assert.equal(createDocxResponse.status, 201);
      const docxCreated = record(
        (await responseJson(createDocxResponse)).value,
        "DOCX Studio document",
      );
      const docxDocumentId = String(docxCreated.document_id);
      const docxInitialVersionId = String(
        record(docxCreated.version, "DOCX initial version").id,
      );
      const baselineMarkdown = [
        "# Saved baseline",
        "",
        "> Historical block quote.",
        "",
        "<span>inert historical HTML</span>",
      ].join("\n");
      const baselineSaveResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${docxDocumentId}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({
            expected_version_id: docxInitialVersionId,
            content: baselineMarkdown,
            source: "assistant_edit",
            citation_anchor_ids: [],
          }),
        },
      );
      assert.equal(baselineSaveResponse.status, 201);
      const baselineSaved = record(
        (await responseJson(baselineSaveResponse)).value,
        "DOCX baseline save",
      );
      const baselineVersionId = String(
        record(baselineSaved.version, "DOCX baseline version").id,
      );
      assert.deepEqual(
        record(baselineSaved.version, "DOCX baseline version")
          .citation_anchor_ids,
        [],
      );

      const sourceDocx = await exportDocumentStudioMarkdownToDocx({
        title: "Imported DOCX",
        markdown: [
          "# Imported authority analysis",
          "",
          "Payment must be made within thirty days.",
          "",
          "| Issue | Result |",
          "| --- | --- |",
          "| Notice | Required |",
        ].join("\n"),
      });
      const externalDocx = editDocxPart(
        sourceDocx.bytes,
        "word/_rels/document.xml.rels",
        (xml) =>
          xml.replace(
            "</Relationships>",
            '<Relationship Id="external-audit" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://secret.invalid/private" TargetMode="External"/></Relationships>',
          ),
      );
      const trackedDocx = editDocxPart(
        sourceDocx.bytes,
        "word/document.xml",
        (xml) =>
          xml.replace(
            "</w:body>",
            "<w:ins><w:r><w:t>tracked secret</w:t></w:r></w:ins></w:body>",
          ),
      );
      const activeDocx = editDocxPart(
        sourceDocx.bytes,
        "word/document.xml",
        (xml) =>
          xml.replace(
            "</w:body>",
            '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p></w:body>',
          ),
      );
      const importPath = `/api/v1/projects/${projectId}/studio/documents/${docxDocumentId}/import-docx`;
      const initialDocxState = documentVersionState(runtime, docxDocumentId);
      assert.deepEqual(initialDocxState, {
        currentVersionId: baselineVersionId,
        versionCount: 2,
      });

      const removedMalformedUploadPaths = new Set<string>();
      const trackedCleanupApp = express();
      trackedCleanupApp.use(
        createWorkspaceDocumentStudioV1Router(runtime, {
          principal: () => WORKSPACE_LOCAL_PRINCIPAL_ID,
          uploadPathRemover: async (candidate) => {
            removedMalformedUploadPaths.add(candidate);
            rmSync(candidate, { force: true });
          },
        }),
      );
      await withServer(trackedCleanupApp, async (trackedBaseUrl) => {
        const trackedPath = `/projects/${projectId}/studio/documents/${docxDocumentId}/import-docx`;
        for (const fields of [
          [] as ReadonlyArray<readonly [string, string]>,
          [["expected_version_id", "not-a-uuid"]] as const,
          [
            ["expected_version_id", baselineVersionId],
            ["unexpected", "field"],
          ] as const,
        ]) {
          await assertSafeError(
            await uploadDocx(trackedBaseUrl, trackedPath, sourceDocx.bytes, {
              fields,
              authenticated: false,
            }),
            422,
            "VALIDATION_ERROR",
          );
        }
      });
      assert.ok(removedMalformedUploadPaths.size >= 2);
      assert.equal(
        [...removedMalformedUploadPaths].some((candidate) =>
          existsSync(candidate),
        ),
        false,
      );
      assert.deepEqual(
        documentVersionState(runtime, docxDocumentId),
        initialDocxState,
      );

      await assertSafeError(
        await uploadDocx(baseUrl, importPath, sourceDocx.bytes, {
          fields: [["expected_version_id", baselineVersionId]],
          authenticated: false,
        }),
        401,
        "UNAUTHORIZED",
      );
      await assertSafeError(
        await uploadDocx(
          baseUrl,
          `/api/v1/projects/not-a-uuid/studio/documents/${docxDocumentId}/import-docx`,
          sourceDocx.bytes,
          { fields: [["expected_version_id", baselineVersionId]] },
        ),
        422,
        "VALIDATION_ERROR",
      );
      await assertSafeError(
        await uploadDocx(baseUrl, importPath, sourceDocx.bytes),
        422,
        "VALIDATION_ERROR",
      );
      await assertSafeError(
        await uploadDocx(baseUrl, importPath, sourceDocx.bytes, {
          fields: [["expected_version_id", "not-a-uuid"]],
        }),
        422,
        "VALIDATION_ERROR",
      );
      await assertSafeError(
        await uploadDocx(baseUrl, importPath, sourceDocx.bytes, {
          fields: [
            ["expected_version_id", baselineVersionId],
            ["unexpected", "field"],
          ],
        }),
        422,
        "VALIDATION_ERROR",
      );
      await assertSafeError(
        await uploadDocx(baseUrl, importPath, sourceDocx.bytes, {
          fields: [["expected_version_id", "x".repeat(300)]],
        }),
        422,
        "VALIDATION_ERROR",
      );
      await assertSafeError(
        await uploadDocx(baseUrl, importPath, sourceDocx.bytes, {
          filename: "not-docx.txt",
          fields: [["expected_version_id", baselineVersionId]],
        }),
        422,
        "VALIDATION_ERROR",
      );
      await assertSafeError(
        await uploadDocx(baseUrl, importPath, sourceDocx.bytes, {
          mimeType: "text/plain",
          fields: [["expected_version_id", baselineVersionId]],
        }),
        422,
        "VALIDATION_ERROR",
      );
      await assertSafeError(
        await uploadDocx(baseUrl, importPath, new Uint8Array(), {
          fields: [["expected_version_id", baselineVersionId]],
        }),
        422,
        "VALIDATION_ERROR",
      );
      await assertSafeError(
        await uploadDocx(
          baseUrl,
          importPath,
          new Uint8Array(DOCUMENT_STUDIO_MAX_DOCX_BYTES + 1),
          { fields: [["expected_version_id", baselineVersionId]] },
        ),
        413,
        "VALIDATION_ERROR",
      );
      for (const unsafeDocx of [externalDocx, trackedDocx, activeDocx]) {
        const unsafeResponse = await uploadDocx(
          baseUrl,
          importPath,
          unsafeDocx,
          { fields: [["expected_version_id", baselineVersionId]] },
        );
        const unsafePayload = await assertSafeError(
          unsafeResponse,
          422,
          "VALIDATION_ERROR",
        );
        assert.equal(unsafePayload.text.includes("secret.invalid"), false);
        assert.equal(unsafePayload.text.includes("tracked secret"), false);
        assert.equal(
          unsafePayload.text.includes("DOCX_EXTERNAL_RELATIONSHIP"),
          false,
        );
        assert.equal(
          unsafePayload.text.includes("DOCX_TRACKED_CHANGES"),
          false,
        );
        assert.equal(unsafePayload.text.includes("DOCX_ACTIVE_CONTENT"), false);
      }
      await assertSafeError(
        await uploadDocx(
          baseUrl,
          `/api/v1/projects/${otherProjectId}/studio/documents/${docxDocumentId}/import-docx`,
          sourceDocx.bytes,
          { fields: [["expected_version_id", baselineVersionId]] },
        ),
        404,
        "NOT_FOUND",
      );
      const rateLimitedApp = createVeraApplication({
        runtime,
        env: {
          ...environment(),
          RATE_LIMIT_UPLOAD_MAX: "1",
        },
        auditAnchorStatus: () => ({ enabled: false, healthy: true }),
        auditWriteBlocked: () => false,
      });
      await withServer(rateLimitedApp, async (rateBaseUrl) => {
        await assertSafeError(
          await uploadDocx(rateBaseUrl, importPath, sourceDocx.bytes, {
            filename: "rejected.txt",
            fields: [["expected_version_id", baselineVersionId]],
          }),
          422,
          "VALIDATION_ERROR",
        );
        await assertSafeError(
          await uploadDocx(rateBaseUrl, importPath, sourceDocx.bytes, {
            filename: "rejected-again.txt",
            fields: [["expected_version_id", baselineVersionId]],
          }),
          429,
          "RATE_LIMITED",
        );
      });
      assert.deepEqual(
        documentVersionState(runtime, docxDocumentId),
        initialDocxState,
      );

      const importResponse = await uploadDocx(
        baseUrl,
        importPath,
        sourceDocx.bytes,
        { fields: [["expected_version_id", baselineVersionId]] },
      );
      assert.equal(importResponse.status, 201);
      const importedPayload = record(
        (await responseJson(importResponse)).value,
        "DOCX import response",
      );
      assert.deepEqual(Object.keys(importedPayload).sort(), [
        "document",
        "warnings",
      ]);
      const importedDocument = record(
        importedPayload.document,
        "imported Studio document",
      );
      const importedVersion = record(
        importedDocument.version,
        "imported Studio version",
      );
      const importedVersionId = String(importedVersion.id);
      assert.equal(importedVersion.version_number, 3);
      assert.equal(importedVersion.source, "user_upload");
      assert.deepEqual(importedVersion.citation_anchor_ids, []);
      assert.equal(
        String(importedDocument.content).includes("Payment must be made"),
        true,
      );
      assert.equal(
        array(importedPayload.warnings, "DOCX import warnings").includes(
          "DOCX_FORMATTING_SIMPLIFIED",
        ),
        true,
      );

      const oldBaselineResponse = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${docxDocumentId}?version_id=${baselineVersionId}`,
        { headers: authHeaders(false) },
      );
      assert.equal(oldBaselineResponse.status, 200);
      const oldBaseline = record(
        (await responseJson(oldBaselineResponse)).value,
        "old DOCX baseline",
      );
      assert.equal(oldBaseline.content, baselineMarkdown);
      assert.equal(oldBaseline.current_version_id, importedVersionId);

      await assertSafeError(
        await uploadDocx(baseUrl, importPath, sourceDocx.bytes, {
          fields: [["expected_version_id", baselineVersionId]],
        }),
        409,
        "CONFLICT",
      );
      assert.deepEqual(documentVersionState(runtime, docxDocumentId), {
        currentVersionId: importedVersionId,
        versionCount: 3,
      });

      const exportStateBefore = documentVersionState(runtime, docxDocumentId);
      const historicalExport = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${docxDocumentId}/export-docx?version_id=${baselineVersionId}`,
        { headers: authHeaders(false) },
      );
      assert.equal(historicalExport.status, 200);
      assert.equal(
        historicalExport.headers.get("content-type"),
        DOCUMENT_STUDIO_DOCX_MIME_TYPE,
      );
      assert.match(
        historicalExport.headers.get("content-disposition") ?? "",
        /^attachment;.*\.docx/i,
      );
      assert.equal(
        historicalExport.headers.get("x-content-type-options"),
        "nosniff",
      );
      assert.match(
        historicalExport.headers.get("cache-control") ?? "",
        /no-store/,
      );
      assert.equal(
        historicalExport.headers.get("access-control-expose-headers"),
        "Content-Disposition, Content-Length, X-Vera-Warning-Codes",
      );
      const historicalWarningHeader =
        historicalExport.headers.get("x-vera-warning-codes") ?? "";
      assert.equal(
        historicalWarningHeader.split(",").includes("MARKDOWN_HTML_AS_TEXT"),
        true,
      );
      assert.equal(
        historicalWarningHeader
          .split(",")
          .includes("MARKDOWN_BLOCKQUOTE_SIMPLIFIED"),
        true,
      );
      assert.equal(
        new Set(historicalWarningHeader.split(",")).size,
        historicalWarningHeader.split(",").length,
      );
      const historicalExportBytes = Buffer.from(
        await historicalExport.arrayBuffer(),
      );
      assert.equal(
        Number(historicalExport.headers.get("content-length")),
        historicalExportBytes.length,
      );
      const historicalRoundTrip = await importDocumentStudioDocxToMarkdown({
        bytes: historicalExportBytes,
      });
      assert.equal(
        historicalRoundTrip.markdown.includes("Saved baseline"),
        true,
      );

      const currentExport = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${docxDocumentId}/export-docx?version_id=${importedVersionId}`,
        { headers: authHeaders(false) },
      );
      assert.equal(currentExport.status, 200);
      const currentExportBytes = Buffer.from(await currentExport.arrayBuffer());
      const currentRoundTrip = await importDocumentStudioDocxToMarkdown({
        bytes: currentExportBytes,
      });
      assert.equal(
        currentRoundTrip.markdown.includes("Payment must be made"),
        true,
      );
      assert.equal(
        currentRoundTrip.markdown.includes("Historical block quote"),
        false,
      );
      assert.deepEqual(
        documentVersionState(runtime, docxDocumentId),
        exportStateBefore,
      );

      let cleanupCalls = 0;
      const cleanupCandidates = new Set<string>();
      const cleanupFailureApp = express();
      cleanupFailureApp.use(
        createWorkspaceDocumentStudioV1Router(runtime, {
          principal: () => WORKSPACE_LOCAL_PRINCIPAL_ID,
          uploadPathRemover: async (candidate) => {
            cleanupCalls += 1;
            cleanupCandidates.add(candidate);
            if (cleanupCalls === 1) {
              throw new Error("injected temp cleanup failure /private/secret");
            }
            rmSync(candidate, { force: true });
          },
        }),
      );
      await withServer(cleanupFailureApp, async (cleanupBaseUrl) => {
        const cleanupFailure = await uploadDocx(
          cleanupBaseUrl,
          `/projects/${projectId}/studio/documents/${docxDocumentId}/import-docx`,
          sourceDocx.bytes,
          {
            fields: [["expected_version_id", importedVersionId]],
            authenticated: false,
          },
        );
        const cleanupPayload = await assertSafeError(
          cleanupFailure,
          500,
          "INTERNAL_ERROR",
        );
        assert.equal(cleanupPayload.text.includes("/private/secret"), false);
      });
      assert.ok(cleanupCalls >= 2);
      assert.equal(
        [...cleanupCandidates].some((candidate) => existsSync(candidate)),
        false,
      );
      assert.deepEqual(
        documentVersionState(runtime, docxDocumentId),
        exportStateBefore,
      );
    });

    const versionCount = Number(
      runtime.database
        .prepare(
          "SELECT count(*) AS count FROM document_versions WHERE document_id = ?",
        )
        .get(documentId)?.count,
    );
    assert.equal(versionCount, 4);
    const storedOriginalCount = Number(
      runtime.database
        .prepare(
          "SELECT count(*) AS count FROM workspace_blob_records WHERE document_id = ? AND kind = 'original' AND state = 'stored'",
        )
        .get(documentId)?.count,
    );
    assert.equal(storedOriginalCount, 4);
    assert.equal(
      runtime.database.prepare("PRAGMA foreign_key_check").all().length,
      0,
    );

    const encryptedFiles = listFiles(blobRoot).filter(
      (value) => !value.endsWith(".delete.json"),
    );
    assert.ok(encryptedFiles.length >= 5);
    for (const file of encryptedFiles) {
      const envelope = readFileSync(file);
      assert.equal(envelope.subarray(0, 4).toString("ascii"), "VDS1");
      assert.equal(
        envelope.includes(Buffer.from("/Users/alice/case", "utf8")),
        false,
      );
      assert.equal(
        envelope.includes(
          Buffer.from("Renamed draft remains editable.", "utf8"),
        ),
        false,
      );
    }

    await runtime.stop();
    runtime = createRuntime();
    await runtime.start();
    await withServer(veraApp(runtime), async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/studio/documents/${documentId}`,
        { headers: authHeaders(false) },
      );
      assert.equal(response.status, 200);
      const restarted = record(
        (await responseJson(response)).value,
        "restarted Studio document",
      );
      assert.equal(restarted.current_version_id, restoredVersionId);
      assert.equal(
        record(restarted.version, "restarted version").id,
        restoredVersionId,
      );
      assert.equal(restarted.content, opaqueText);
      assert.equal(
        array(restarted.citation_anchors, "restarted citations").length,
        1,
      );

      const documents = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/documents`,
        { headers: authHeaders(false) },
      );
      const draft = array(
        (await responseJson(documents)).value,
        "restarted Project documents",
      )
        .map((value) => record(value, "restarted Project document"))
        .find((value) => value.id === documentId);
      assert.ok(draft);
      assert.equal(
        record(draft.studio_capability, "restarted Studio capability").editable,
        true,
      );
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-workspace-document-studio-service-http",
          checks: [
            "authenticated Project-scoped blank Markdown draft creation",
            "only v12 draft/template lineage advertises Studio editability",
            "encrypted original blobs and authoritative blob records",
            "lossless CRLF/NFD/raw-HTML and opaque user-text round trip",
            "Project-scoped citation anchors and restore inheritance",
            "atomic CAS stale conflict and wrong-Project fake 404",
            "historical selected version preserves authoritative current pointer",
            "generic version upload cannot split Studio lineage",
            "generic rename preserves Studio editability and save path",
            "strict response serializer rejects storage/credential fields",
            "authenticated suggestion acceptance serializes the user_accept version through the real runtime",
            "strict DOCX multipart auth, upload rate, UUID, field, extension, MIME and 10 MB limits",
            "malicious external, tracked-change and active-content DOCX rejection without error leaks",
            "DOCX import creates one CAS version while preserving citations and old immutable content",
            "current and historical DOCX export preserve selection without database mutation",
            "DOCX download headers expose bounded deduplicated conversion warnings",
            "temporary upload cleanup precedes persistence and cleanup failure commits no version",
            "runtime restart preserves content, versions, citations and capability",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    try {
      await runtime.stop();
    } catch {
      // The primary audit failure wins.
    }
  }
}

void main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    if (originalEncryption === undefined) {
      delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    } else {
      process.env.ALETHEIA_DATABASE_ENCRYPTION = originalEncryption;
    }
    rmSync(root, { recursive: true, force: true });
  });
