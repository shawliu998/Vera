import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express, { type Express } from "express";

import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WorkspaceSourceFoundationRepository } from "../lib/workspace/repositories/sourceFoundation";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import { WorkspaceProjectSourcesService } from "../lib/workspace/services/projectSources";
import {
  createWorkspaceProjectSourcesV1Router,
  type WorkspaceProjectSourcesV1Port,
} from "../routes/workspaceProjectSourcesV1";
import { createVeraApplication } from "../veraApplication";

const TOKEN = "vera-project-sources-route-audit-token-0000000000000000";
const NOW = "2026-07-15T12:00:00.000Z";
const EXPIRED_LEGAL_BODY = "expired legal body";
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-project-sources-route-audit-"),
);
const originalEnvironment = { ...process.env };
const blobKey = randomBytes(32);

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), label);
  return value;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encryptedAuditCodec(key: Buffer): WorkspaceBlobCodec {
  return {
    encrypted: true,
    encode({ filePath, plaintext, purpose }) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`${purpose}\0${filePath}`, "utf8"));
      return Buffer.concat([
        Buffer.from("VPS1", "ascii"),
        nonce,
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    decode({ filePath, envelope, purpose }) {
      assert.equal(envelope.subarray(0, 4).toString("ascii"), "VPS1");
      const nonce = envelope.subarray(4, 16);
      const tag = envelope.subarray(envelope.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.from(`${purpose}\0${filePath}`, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(envelope.subarray(16, envelope.length - 16)),
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

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
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

async function json(response: Response) {
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

function seedDocument(
  runtime: WorkspaceRuntime,
  input: {
    projectId: string;
    title: string;
    text: string;
    withChunk: boolean;
  },
) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  const contentHash = digest(input.text);
  runtime.database
    .prepare(
      `INSERT INTO documents (
         id, project_id, title, filename, mime_type, size_bytes, parse_status
       ) VALUES (?, ?, ?, ?, 'text/plain', ?, 'ready')`,
    )
    .run(
      documentId,
      input.projectId,
      input.title,
      `${input.title}.txt`,
      Buffer.byteLength(input.text, "utf8"),
    );
  runtime.database
    .prepare(
      `INSERT INTO document_versions (
         id, document_id, version_number, source, filename, mime_type,
         size_bytes, content_sha256, storage_key
       ) VALUES (?, ?, 1, 'upload', ?, 'text/plain', ?, ?, ?)`,
    )
    .run(
      versionId,
      documentId,
      `${input.title}.txt`,
      Buffer.byteLength(input.text, "utf8"),
      contentHash,
      `documents/${documentId}/${versionId}/original`,
    );
  runtime.database
    .prepare("UPDATE documents SET current_version_id = ? WHERE id = ?")
    .run(versionId, documentId);
  if (input.withChunk) {
    const metadata = {
      schemaVersion: "vera-document-chunk-ocr-v1",
      engine: "apple-vision",
      coordinateSpace: "normalized-top-left",
      page: 1,
      chunkPageTextStart: 0,
      pageConfidence: 0.92,
      lowConfidence: false,
      blocks: [
        {
          textStart: 0,
          textEnd: 13,
          confidence: 0.91,
          boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
        },
        {
          textStart: 28,
          textEnd: input.text.length,
          confidence: 0.93,
          boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.05 },
        },
      ],
    };
    runtime.database
      .prepare(
        `INSERT INTO document_chunks (
           id, document_id, version_id, ordinal, text, start_offset,
           end_offset, page_start, page_end, content_sha256, metadata_json
         ) VALUES (?, ?, ?, 0, ?, 0, ?, 1, 1, ?, ?)`,
      )
      .run(
        chunkId,
        documentId,
        versionId,
        input.text,
        input.text.length,
        digest(input.text),
        JSON.stringify(metadata),
      );
  }
  return { documentId, versionId, chunkId, contentHash };
}

async function auditResponseBoundary() {
  const projectId = randomUUID();
  const snapshotId = randomUUID();
  const snapshot = {
    id: snapshotId,
    project_id: projectId,
    kind: "project_document",
    source_record_id: randomUUID(),
    source_version_id: randomUUID(),
    title: "Safe source",
    content_sha256: "a".repeat(64),
    locator: {},
    retrieved_at: NOW,
    license: {
      basis: "user_provided",
      retention: "full_text_permitted",
      export: "permitted",
      model_use: "permitted",
    },
    retention_policy: "full_text_permitted",
    retention_expires_at: null,
    retrieval_metadata: {},
    created_at: NOW,
  };
  const fake: WorkspaceProjectSourcesV1Port = {
    async captureProjectDocumentSource() {
      return {
        snapshot,
        reused: false,
        storage_path: "/private/vera/source.txt",
        credential_secret: "never-serialize-this",
      };
    },
    async listProjectSources() {
      return { sources: [], next_cursor: null };
    },
    async getProjectSource() {
      return { snapshot, anchors: [] };
    },
    async readProjectSourceContent() {
      return {
        snapshot_id: snapshotId,
        document: {
          document_id: snapshot.source_record_id,
          version_id: snapshot.source_version_id,
          title: snapshot.title,
          filename: "safe-source.txt",
          mime_type: "text/plain",
          content_sha256: snapshot.content_sha256,
          page_count: null,
        },
        chunks: [],
        next_cursor: null,
        storage_path: "/private/vera/source.txt",
        raw_parser_metadata: { credential_secret: "never-serialize-this" },
      };
    },
    async createProjectSourceAnchor() {
      throw new Error("unused");
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    createWorkspaceProjectSourcesV1Router(fake, {
      principal: () => WORKSPACE_LOCAL_PRINCIPAL_ID,
    }),
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/sources/document-snapshots`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document_id: randomUUID() }),
      },
    );
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body.includes("/private/vera"), false);
    assert.equal(body.includes("never-serialize-this"), false);
    assert.equal(body.includes("storage_path"), false);

    const contentResponse = await fetch(
      `${baseUrl}/projects/${projectId}/sources/${snapshotId}/content`,
    );
    assert.equal(contentResponse.status, 500);
    const contentBody = await contentResponse.text();
    assert.equal(contentBody.includes("/private/vera"), false);
    assert.equal(contentBody.includes("never-serialize-this"), false);
    assert.equal(contentBody.includes("storage_path"), false);
    assert.equal(contentBody.includes("raw_parser_metadata"), false);
  });
}

async function main() {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  await auditResponseBoundary();
  const runtime = new WorkspaceRuntime({
    dataDir: path.join(root, "runtime"),
    blobs: new LocalWorkspaceBlobStore({
      root: path.join(root, "blobs"),
      codec: encryptedAuditCodec(blobKey),
    }),
    pump: inertPump(),
  });
  await runtime.start();
  const projectA = randomUUID();
  const projectB = randomUUID();
  runtime.database
    .prepare("INSERT INTO projects (id, name) VALUES (?, 'Sources A')")
    .run(projectA);
  runtime.database
    .prepare("INSERT INTO projects (id, name) VALUES (?, 'Sources B')")
    .run(projectB);
  const legalSnapshotId = randomUUID();
  const sourceFoundation = new WorkspaceSourceFoundationRepository(
    runtime.database,
  );
  sourceFoundation.createSnapshot({
    id: legalSnapshotId,
    projectId: projectA,
    sourceKind: "legal_authority",
    sourceRecordId: "audit-expired-authority",
    sourceVersionId: "audit-version-1",
    titleSnapshot: "Expired authority audit record",
    contentSha256: digest(EXPIRED_LEGAL_BODY),
    locator: {
      providerRecordId: "audit-expired-authority",
      excerpt: EXPIRED_LEGAL_BODY,
    },
    retrievedAt: "2000-01-01T00:00:00.000Z",
    license: {
      basis: "deployment_contract",
      retention: "full_text_ttl",
      export: "exact_quotes_only",
      modelUse: "permitted",
    },
    retentionPolicy: "full_text_ttl",
    retentionExpiresAt: "2000-01-02T00:00:00.000Z",
    retrievalMetadata: {
      provider: "audit-provider",
      excerpt: EXPIRED_LEGAL_BODY,
    },
    createdAt: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(
    runtime.database
      .prepare(
        `SELECT access_state
           FROM project_source_snapshot_lifecycle
          WHERE project_id = ? AND snapshot_id = ?`,
      )
      .get(projectA, legalSnapshotId)?.access_state,
    "tombstoned",
  );
  const noRetentionService = new WorkspaceProjectSourcesService(
    runtime.database,
    sourceFoundation,
  );
  const noRetentionDetail = noRetentionService.getSnapshot(
    projectA,
    legalSnapshotId,
  );
  assert.deepEqual(noRetentionDetail.snapshot.locator, {});
  assert.deepEqual(noRetentionDetail.snapshot.retrievalMetadata, {});
  const noRetentionList = noRetentionService.listSnapshots({
    projectId: projectA,
    sourceKind: "legal_authority",
  });
  assert.deepEqual(noRetentionList.sources[0]?.locator, {});
  assert.deepEqual(noRetentionList.sources[0]?.retrievalMetadata, {});
  const text =
    "Clause alpha. Clause alpha. 😀 Unique /Users/alice password=literal. aaa";
  const primary = seedDocument(runtime, {
    projectId: projectA,
    title: "Primary evidence",
    text,
    withChunk: true,
  });
  runtime.database
    .prepare("UPDATE document_versions SET page_count = 1 WHERE id = ?")
    .run(primary.versionId);
  const secondary = seedDocument(runtime, {
    projectId: projectA,
    title: "Secondary evidence",
    text: "A second immutable source.",
    withChunk: false,
  });
  const markerText = "[Page 1]\nVisible clause.";
  const marker = seedDocument(runtime, {
    projectId: projectA,
    title: "OCR page marker",
    text: markerText,
    withChunk: false,
  });
  const legacyPaddedText = "Legacy unique quote.";
  const legacyPadded = seedDocument(runtime, {
    projectId: projectA,
    title: "Legacy padded offsets",
    text: legacyPaddedText,
    withChunk: true,
  });
  const budgeted = seedDocument(runtime, {
    projectId: projectA,
    title: "UTF-8 source page budget",
    text: "Budgeted immutable source.",
    withChunk: false,
  });
  const budgetChunkText = "界😀".repeat(7_000);
  const budgetChunkIds = Array.from({ length: 6 }, () => randomUUID());
  const insertBudgetChunk = runtime.database.prepare(
    `INSERT INTO document_chunks (
       id, document_id, version_id, ordinal, text, start_offset,
       end_offset, page_start, page_end, content_sha256, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, '{}')`,
  );
  budgetChunkIds.forEach((chunkId, ordinal) => {
    const start = ordinal * budgetChunkText.length;
    insertBudgetChunk.run(
      chunkId,
      budgeted.documentId,
      budgeted.versionId,
      ordinal,
      budgetChunkText,
      start,
      start + budgetChunkText.length,
      digest(budgetChunkText),
    );
  });
  runtime.database
    .prepare(
      "UPDATE document_chunks SET end_offset = ?, metadata_json = '{}' WHERE id = ?",
    )
    .run(legacyPaddedText.length + 2, legacyPadded.chunkId);
  runtime.database
    .prepare(
      `INSERT INTO document_chunks (
         id, document_id, version_id, ordinal, text, start_offset,
         end_offset, page_start, page_end, content_sha256, metadata_json
       ) VALUES (?, ?, ?, 0, ?, 0, ?, 1, 1, ?, ?)`,
    )
    .run(
      marker.chunkId,
      marker.documentId,
      marker.versionId,
      markerText,
      markerText.length,
      digest(markerText),
      JSON.stringify({
        schemaVersion: "vera-document-chunk-ocr-v1",
        engine: "apple-vision",
        coordinateSpace: "normalized-top-left",
        page: 1,
        chunkPageTextStart: -9,
        pageConfidence: 0.92,
        lowConfidence: false,
        blocks: [
          {
            textStart: 0,
            textEnd: 15,
            confidence: 0.92,
            boundingBox: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
          },
        ],
      }),
    );
  seedDocument(runtime, {
    projectId: projectB,
    title: "Other Project evidence",
    text: "Cross Project data.",
    withChunk: true,
  });

  const app = createVeraApplication({
    runtime,
    env: environment(),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    auditWriteBlocked: () => false,
  });

  await withServer(app, async (baseUrl) => {
    const legalDetailResponse = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${legalSnapshotId}`,
      { headers: authHeaders() },
    );
    assert.equal(legalDetailResponse.status, 200);
    assert.match(
      legalDetailResponse.headers.get("cache-control") ?? "",
      /no-store/,
    );
    const legalDetailText = await legalDetailResponse.text();
    assert.equal(legalDetailText.includes(EXPIRED_LEGAL_BODY), false);
    const legalDetail = record(
      JSON.parse(legalDetailText) as unknown,
      "expired legal detail",
    );
    const legalDetailSnapshot = record(
      legalDetail.snapshot,
      "expired legal detail snapshot",
    );
    assert.deepEqual(legalDetailSnapshot.locator, {});
    assert.deepEqual(legalDetailSnapshot.retrieval_metadata, {});
    assert.equal(legalDetailSnapshot.id, legalSnapshotId);
    assert.equal(
      legalDetailSnapshot.content_sha256,
      digest(EXPIRED_LEGAL_BODY),
    );

    const legalListResponse = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources?kind=legal_authority`,
      { headers: authHeaders() },
    );
    assert.equal(legalListResponse.status, 200);
    const legalListText = await legalListResponse.text();
    assert.equal(legalListText.includes(EXPIRED_LEGAL_BODY), false);
    const legalListBody = record(
      JSON.parse(legalListText) as unknown,
      "expired legal list",
    );
    const legalListSnapshot = record(
      array(legalListBody.sources, "expired legal sources")[0],
      "expired legal list snapshot",
    );
    assert.deepEqual(legalListSnapshot.locator, {});
    assert.deepEqual(legalListSnapshot.retrieval_metadata, {});

    const captureUrl = `${baseUrl}/api/v1/projects/${projectA}/sources/document-snapshots`;
    const unauthenticated = await fetch(captureUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document_id: primary.documentId }),
    });
    assert.equal(unauthenticated.status, 401);

    const forgedPolicy = await fetch(captureUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        document_id: primary.documentId,
        license: { model_use: "local_only" },
      }),
    });
    assert.equal(forgedPolicy.status, 422);

    const firstCapture = await fetch(captureUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ document_id: primary.documentId }),
    });
    assert.equal(firstCapture.status, 201);
    assert.match(firstCapture.headers.get("cache-control") ?? "", /no-store/);
    const firstBody = record(await json(firstCapture), "first capture");
    assert.equal(firstBody.reused, false);
    const snapshot = record(firstBody.snapshot, "snapshot");
    const snapshotId = String(snapshot.id);
    assert.equal(snapshot.title, "Primary evidence");
    assert.equal(snapshot.content_sha256, primary.contentHash);
    assert.deepEqual(snapshot.license, {
      basis: "user_provided",
      retention: "full_text_permitted",
      export: "permitted",
      model_use: "permitted",
    });

    const repeatedCapture = await fetch(captureUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ document_id: primary.documentId }),
    });
    assert.equal(repeatedCapture.status, 200);
    const repeatedBody = record(await json(repeatedCapture), "repeat capture");
    assert.equal(repeatedBody.reused, true);
    assert.equal(
      record(repeatedBody.snapshot, "reused snapshot").id,
      snapshotId,
    );

    const secondCapture = await fetch(captureUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ document_id: secondary.documentId }),
    });
    assert.equal(secondCapture.status, 201);

    const firstPage = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources?kind=project_document&limit=1`,
      { headers: authHeaders() },
    );
    assert.equal(firstPage.status, 200);
    const firstPageBody = record(await json(firstPage), "first page");
    assert.equal(array(firstPageBody.sources, "first page sources").length, 1);
    assert.equal(typeof firstPageBody.next_cursor, "string");
    const secondPage = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources?kind=project_document&limit=1&cursor=${encodeURIComponent(String(firstPageBody.next_cursor))}`,
      { headers: authHeaders() },
    );
    assert.equal(secondPage.status, 200);
    const secondPageBody = record(await json(secondPage), "second page");
    assert.equal(
      array(secondPageBody.sources, "second page sources").length,
      1,
    );
    assert.equal(secondPageBody.next_cursor, null);

    const invalidKind = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources?kind=provider_forgery`,
      { headers: authHeaders() },
    );
    assert.equal(invalidKind.status, 422);
    const invalidCursor = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources?cursor=not-a-real-cursor`,
      { headers: authHeaders() },
    );
    assert.equal(invalidCursor.status, 422);

    const wrongProjectDetail = await fetch(
      `${baseUrl}/api/v1/projects/${projectB}/sources/${snapshotId}`,
      { headers: authHeaders() },
    );
    assert.equal(wrongProjectDetail.status, 404);

    const anchorUrl = `${baseUrl}/api/v1/projects/${projectA}/sources/${snapshotId}/anchors`;
    const ambiguous = await fetch(anchorUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        chunk_id: primary.chunkId,
        exact_quote: "Clause alpha.",
      }),
    });
    assert.equal(ambiguous.status, 409);

    const overlappingAmbiguous = await fetch(anchorUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        chunk_id: primary.chunkId,
        exact_quote: "aa",
      }),
    });
    assert.equal(overlappingAmbiguous.status, 409);

    const badOffsets = await fetch(anchorUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        chunk_id: primary.chunkId,
        exact_quote: "Clause alpha.",
        start_offset: 1,
        end_offset: 14,
      }),
    });
    assert.equal(badOffsets.status, 422);

    const explicit = await fetch(anchorUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        chunk_id: primary.chunkId,
        exact_quote: "Clause alpha.",
        start_offset: 0,
        end_offset: 13,
      }),
    });
    assert.equal(explicit.status, 201);

    const uniqueQuote = "😀 Unique /Users/alice password=literal.";
    const unique = await fetch(anchorUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        chunk_id: primary.chunkId,
        exact_quote: uniqueQuote,
      }),
    });
    assert.equal(unique.status, 201);
    const uniqueBody = record(await json(unique), "unique anchor response");
    const uniqueAnchor = record(uniqueBody.anchor, "unique anchor");
    assert.equal(uniqueAnchor.exact_quote, uniqueQuote);
    const locator = record(uniqueAnchor.locator, "anchor locator");
    assert.equal(locator.chunkId, primary.chunkId);
    assert.equal(locator.documentStartOffset, text.indexOf(uniqueQuote));
    assert.equal(
      locator.documentEndOffset,
      text.indexOf(uniqueQuote) + uniqueQuote.length,
    );
    assert.equal(
      locator.documentOffsetBasis,
      "normalized_matter_document_text_v1",
    );
    assert.equal(locator.documentOffsetUnit, "utf16_code_unit");
    const ocr = record(locator.ocr, "OCR locator");
    assert.equal(ocr.offsetScope, "page_text");
    assert.equal(ocr.offsetUnit, "utf16_code_unit");
    assert.equal(ocr.quotePageStart, text.indexOf(uniqueQuote));
    assert.equal(
      ocr.quotePageEnd,
      text.indexOf(uniqueQuote) + uniqueQuote.length,
    );
    assert.equal(array(ocr.blocks, "quote OCR blocks").length, 1);

    const sourceContent = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${snapshotId}/content?limit=20`,
      { headers: authHeaders() },
    );
    assert.equal(sourceContent.status, 200);
    const sourceContentBody = record(
      await json(sourceContent),
      "source content",
    );
    assert.equal(sourceContentBody.snapshot_id, snapshotId);
    const sourceDocument = record(
      sourceContentBody.document,
      "source content document",
    );
    assert.equal(sourceDocument.document_id, primary.documentId);
    assert.equal(sourceDocument.version_id, primary.versionId);
    assert.equal(sourceDocument.content_sha256, primary.contentHash);
    assert.equal(sourceDocument.filename, "Primary evidence.txt");
    assert.equal(sourceDocument.mime_type, "text/plain");
    const sourceChunks = array(
      sourceContentBody.chunks,
      "source content chunks",
    );
    assert.equal(sourceChunks.length, 1);
    const sourceChunk = record(sourceChunks[0], "source content chunk");
    assert.equal(sourceChunk.id, primary.chunkId);
    assert.equal(sourceChunk.text, text);
    assert.equal(sourceChunk.content_sha256, digest(text));
    assert.equal(sourceContentBody.next_cursor, null);
    assert.equal(
      JSON.stringify(sourceContentBody).includes("storage_key"),
      false,
    );
    assert.equal(
      JSON.stringify(sourceContentBody).includes("metadata_json"),
      false,
    );

    const directSourceContent = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${snapshotId}/content?chunk_id=${primary.chunkId}`,
      { headers: authHeaders() },
    );
    assert.equal(directSourceContent.status, 200);
    assert.equal(
      record(
        array(
          record(await json(directSourceContent), "direct source content")
            .chunks,
          "direct source chunks",
        )[0],
        "direct source chunk",
      ).id,
      primary.chunkId,
    );

    runtime.database
      .prepare(
        "UPDATE document_chunks SET page_start = 2, page_end = 2 WHERE id = ?",
      )
      .run(primary.chunkId);
    const outOfRangePageContent = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${snapshotId}/content?chunk_id=${primary.chunkId}`,
      { headers: authHeaders() },
    );
    assert.equal(outOfRangePageContent.status, 409);
    runtime.database
      .prepare(
        "UPDATE document_chunks SET page_start = 1, page_end = 1 WHERE id = ?",
      )
      .run(primary.chunkId);

    const unboundedDirectSourceContent = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${snapshotId}/content?chunk_id=${primary.chunkId}&limit=20`,
      { headers: authHeaders() },
    );
    assert.equal(unboundedDirectSourceContent.status, 422);
    const invalidContentCursor = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${snapshotId}/content?cursor=forged`,
      { headers: authHeaders() },
    );
    assert.equal(invalidContentCursor.status, 422);
    const crossProjectSourceContent = await fetch(
      `${baseUrl}/api/v1/projects/${projectB}/sources/${snapshotId}/content`,
      { headers: authHeaders() },
    );
    assert.equal(crossProjectSourceContent.status, 404);

    const budgetCapture = await fetch(captureUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ document_id: budgeted.documentId }),
    });
    assert.equal(budgetCapture.status, 201);
    const budgetSnapshotId = String(
      record(
        record(await json(budgetCapture), "budget source capture").snapshot,
        "budget source snapshot",
      ).id,
    );
    const budgetFirstPage = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${budgetSnapshotId}/content?limit=20`,
      { headers: authHeaders() },
    );
    assert.equal(budgetFirstPage.status, 200);
    const budgetFirstBody = record(
      await json(budgetFirstPage),
      "budget source first page",
    );
    const budgetFirstChunks = array(
      budgetFirstBody.chunks,
      "budget source first chunks",
    ).map((chunk) => record(chunk, "budget source first chunk"));
    assert.equal(budgetFirstChunks.length, 5);
    assert.equal(typeof budgetFirstBody.next_cursor, "string");
    assert.ok(
      budgetFirstChunks.every(
        (chunk) =>
          chunk.text === budgetChunkText &&
          Buffer.byteLength(String(chunk.text), "utf8") === 49_000,
      ),
    );
    const budgetSecondPage = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${budgetSnapshotId}/content?limit=20&cursor=${encodeURIComponent(String(budgetFirstBody.next_cursor))}`,
      { headers: authHeaders() },
    );
    assert.equal(budgetSecondPage.status, 200);
    const budgetSecondBody = record(
      await json(budgetSecondPage),
      "budget source second page",
    );
    const budgetSecondChunks = array(
      budgetSecondBody.chunks,
      "budget source second chunks",
    ).map((chunk) => record(chunk, "budget source second chunk"));
    assert.equal(budgetSecondChunks.length, 1);
    assert.equal(budgetSecondBody.next_cursor, null);
    assert.deepEqual(
      [...budgetFirstChunks, ...budgetSecondChunks].map((chunk) => chunk.id),
      budgetChunkIds,
    );
    assert.equal(
      [...String(budgetSecondChunks[0].text)].at(-1),
      "😀",
      "UTF-8 response budgeting must not split a surrogate pair",
    );

    const detail = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${snapshotId}`,
      { headers: authHeaders() },
    );
    assert.equal(detail.status, 200);
    const detailBody = record(await json(detail), "source detail");
    assert.equal(array(detailBody.anchors, "source anchors").length, 2);

    const markerCapture = await fetch(captureUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ document_id: marker.documentId }),
    });
    assert.equal(markerCapture.status, 201);
    const markerSnapshotId = String(
      record(
        record(await json(markerCapture), "marker capture").snapshot,
        "marker snapshot",
      ).id,
    );
    const markerAnchor = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${markerSnapshotId}/anchors`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          chunk_id: marker.chunkId,
          exact_quote: "[Page 1]",
        }),
      },
    );
    assert.equal(markerAnchor.status, 201);
    const markerLocator = record(
      record(await json(markerAnchor), "marker anchor").anchor,
      "marker anchor payload",
    ).locator;
    assert.equal("ocr" in record(markerLocator, "marker locator"), false);

    const legacyCapture = await fetch(captureUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ document_id: legacyPadded.documentId }),
    });
    assert.equal(legacyCapture.status, 201);
    const legacySnapshotId = String(
      record(
        record(await json(legacyCapture), "legacy capture").snapshot,
        "legacy snapshot",
      ).id,
    );
    const legacyAnchor = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${legacySnapshotId}/anchors`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          chunk_id: legacyPadded.chunkId,
          exact_quote: legacyPaddedText,
        }),
      },
    );
    assert.equal(legacyAnchor.status, 201);
    const legacyLocator = record(
      record(await json(legacyAnchor), "legacy anchor").anchor,
      "legacy anchor payload",
    ).locator;
    assert.equal(
      "documentStartOffset" in record(legacyLocator, "legacy locator"),
      false,
    );
    assert.equal(
      "documentEndOffset" in record(legacyLocator, "legacy locator"),
      false,
    );

    const wrongProjectAnchor = await fetch(
      `${baseUrl}/api/v1/projects/${projectB}/sources/${snapshotId}/anchors`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          chunk_id: primary.chunkId,
          exact_quote: uniqueQuote,
        }),
      },
    );
    assert.equal(wrongProjectAnchor.status, 404);

    runtime.database
      .prepare("UPDATE document_chunks SET content_sha256 = ? WHERE id = ?")
      .run("f".repeat(64), primary.chunkId);
    const tamperedChunk = await fetch(anchorUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        chunk_id: primary.chunkId,
        exact_quote: uniqueQuote,
      }),
    });
    assert.equal(tamperedChunk.status, 409);
    const tamperedSourceContent = await fetch(
      `${baseUrl}/api/v1/projects/${projectA}/sources/${snapshotId}/content?chunk_id=${primary.chunkId}`,
      { headers: authHeaders() },
    );
    assert.equal(tamperedSourceContent.status, 409);
  });

  assert.equal(
    runtime.database
      .prepare(
        `SELECT count(*) AS count
           FROM project_source_snapshots
          WHERE project_id = ? AND source_record_id = ?`,
      )
      .get(projectA, primary.documentId)?.count,
    1,
  );
  assert.equal(
    runtime.database.prepare("PRAGMA foreign_key_check").all().length,
    0,
  );
  await runtime.stop();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-project-sources-v1-http",
        checks: [
          "authenticated strict Project source routes",
          "server-derived immutable document snapshot policy and hash",
          "transactional document snapshot idempotency",
          "bounded keyset pagination and kind filtering",
          "tombstoned legal locator and retrieval metadata redaction",
          "cross-Project reads and writes return 404",
          "unique quote resolution and explicit UTF-16 offsets",
          "document/version/chunk hash integrity checks",
          "chunk page bounds cannot exceed the authoritative document page count",
          "strict quote-level OCR locator projection",
          "bounded hash-checked source content and direct chunk reads",
          "UTF-8 byte budgeting paginates without splitting UTF-16 text",
          "source content omits storage and raw parser metadata",
          "synthetic page markers never claim page-text OCR offsets",
          "legacy padded chunks omit unverifiable document offsets",
          "strict response serializer omits paths and secrets",
          "no public legal-provider metadata write route",
        ],
      },
      null,
      2,
    )}\n`,
  );
}

void main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.env = originalEnvironment;
    rmSync(root, { recursive: true, force: true });
  });
