import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import { WORKSPACE_MIGRATIONS } from "../lib/workspace/migrations";
import { SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION } from "../lib/workspace/migrations/v13SourceRetentionLifecycle";
import { WorkspaceSourceFoundationRepository } from "../lib/workspace/repositories/sourceFoundation";
import { WorkspaceSourceRetentionLifecycleRepository } from "../lib/workspace/repositories/sourceRetentionLifecycle";
import {
  LEGAL_SOURCE_RETENTION_ACTIVATION_V13,
  evaluateSourceRetentionPolicyV13,
} from "../lib/workspace/sourceRetentionPolicyV13";
import {
  WorkspaceSourceRetentionService,
  WorkspaceSourceRetentionServiceError,
  type WorkspaceSourceRetentionServiceErrorCode,
} from "../lib/workspace/services/sourceRetention";
import { WorkspaceProjectSourcesService } from "../lib/workspace/services/projectSources";

const originalEnvironment = { ...process.env };
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-source-retention-audit-"),
);
const V12_MIGRATIONS = WORKSPACE_MIGRATIONS.slice(0, 12);
const V13_MIGRATIONS = [
  ...V12_MIGRATIONS,
  SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION,
] as const;

const ACTIVE_NOW = Date.parse("2099-01-01T00:00:00.000Z");
const ACTIVE_EXPIRY = "2099-01-02T08:00:00+08:00";
const AFTER_EXPIRY = Date.parse("2099-01-03T00:00:00.000Z");
const HISTORICAL_RETRIEVED_AT = "1999-01-01T00:00:00.000Z";
const HISTORICAL_EXPIRY = "2000-01-01T00:00:00.000Z";
const CREATED_AT = "2026-07-15T00:00:00.000Z";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function insertProject(database: WorkspaceDatabase) {
  const projectId = randomUUID();
  database
    .prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Retention audit', ?, ?)",
    )
    .run(projectId, CREATED_AT, CREATED_AT);
  return projectId;
}

function insertDocumentVersion(
  database: WorkspaceDatabase,
  projectId: string,
  label: string,
  kind: "source" | "draft" = "source",
) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const content = `${label} immutable content`;
  const contentHash = sha256(content);
  database
    .prepare(
      `INSERT INTO documents (
         id, project_id, title, filename, mime_type, size_bytes, parse_status,
         current_version_id, created_at, updated_at, document_kind
       ) VALUES (?, ?, ?, ?, 'text/markdown', ?, 'ready', NULL, ?, ?, ?)`,
    )
    .run(
      documentId,
      projectId,
      label,
      `${label}.md`,
      Buffer.byteLength(content),
      CREATED_AT,
      CREATED_AT,
      kind,
    );
  database
    .prepare(
      `INSERT INTO document_versions (
         id, document_id, version_number, source, filename, mime_type,
         size_bytes, content_sha256, storage_key, created_at
       ) VALUES (?, ?, 1, 'upload', ?, 'text/markdown', ?, ?, ?, ?)`,
    )
    .run(
      versionId,
      documentId,
      `${label}.md`,
      Buffer.byteLength(content),
      contentHash,
      `documents/${documentId}/versions/${versionId}/original`,
      CREATED_AT,
    );
  database
    .prepare("UPDATE documents SET current_version_id = ? WHERE id = ?")
    .run(versionId, documentId);
  if (kind === "draft") {
    database
      .prepare(
        `INSERT INTO document_studio_versions (
           project_id, document_id, version_id, format, summary, operation_id,
           created_at
         ) VALUES (?, ?, ?, 'markdown', NULL, NULL, ?)`,
      )
      .run(projectId, documentId, versionId, CREATED_AT);
  }
  return { documentId, versionId, contentHash };
}

function createProjectDocumentSource(
  database: WorkspaceDatabase,
  projectId: string,
) {
  const sourceRepository = new WorkspaceSourceFoundationRepository(database);
  const document = insertDocumentVersion(
    database,
    projectId,
    "user-project-document",
  );
  const snapshotId = randomUUID();
  const anchorId = randomUUID();
  sourceRepository.createSnapshot({
    id: snapshotId,
    projectId,
    sourceKind: "project_document",
    sourceRecordId: document.documentId,
    sourceVersionId: document.versionId,
    titleSnapshot: "User Project document",
    contentSha256: document.contentHash,
    locator: { documentVersionId: document.versionId },
    retrievedAt: CREATED_AT,
    license: {
      basis: "user_provided",
      retention: "full_text_permitted",
      export: "permitted",
      modelUse: "permitted",
    },
    retentionPolicy: "full_text_permitted",
    retentionExpiresAt: null,
    retrievalMetadata: { integration: "project_document_version" },
    createdAt: CREATED_AT,
  });
  sourceRepository.createCitationAnchor({
    id: anchorId,
    projectId,
    snapshotId,
    ordinal: 0,
    exactQuote: "User-owned Project text remains available.",
    locator: { section: "1" },
    createdAt: CREATED_AT,
  });
  return { snapshotId, anchorId };
}

function createLegalSource(
  database: WorkspaceDatabase,
  input: {
    projectId: string;
    label: string;
    retrievedAt: string;
    retention:
      | "no_retention"
      | "metadata_only"
      | "full_text_ttl"
      | "full_text_permitted";
    expiresAt: string | null;
    exportPolicy?: "exact_quotes_only" | "reviewed_work_product" | "permitted";
  },
) {
  const sourceRepository = new WorkspaceSourceFoundationRepository(database);
  const snapshotId = randomUUID();
  const anchorId = randomUUID();
  sourceRepository.createSnapshot({
    id: snapshotId,
    projectId: input.projectId,
    sourceKind: "legal_authority",
    sourceRecordId: `authority-${input.label}`,
    sourceVersionId: `version-${input.label}`,
    titleSnapshot: `${input.label} authority`,
    contentSha256: sha256(`${input.label} authority body`),
    locator: { authorityIdentifier: `AUTH-${input.label}` },
    retrievedAt: input.retrievedAt,
    license: {
      basis: "deployment_contract",
      retention: input.retention,
      export: input.exportPolicy ?? "exact_quotes_only",
      modelUse: "local_only",
    },
    retentionPolicy: input.retention,
    retentionExpiresAt: input.expiresAt,
    retrievalMetadata: { providerId: "offline-audit-fixture" },
    createdAt: CREATED_AT,
  });
  sourceRepository.createCitationAnchor({
    id: anchorId,
    projectId: input.projectId,
    snapshotId,
    ordinal: 0,
    exactQuote: `${input.label} licensed exact quote`,
    locator: { section: "12", paragraph: "3" },
    createdAt: CREATED_AT,
  });
  return { snapshotId, anchorId };
}

function bindStudioAnchor(
  database: WorkspaceDatabase,
  projectId: string,
  anchorId: string,
  label: string,
) {
  const studio = insertDocumentVersion(database, projectId, label, "draft");
  database
    .prepare(
      `INSERT INTO document_version_citation_anchors (
         project_id, document_id, version_id, anchor_id, ordinal, created_at
       ) VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(projectId, studio.documentId, studio.versionId, anchorId, CREATED_AT);
  return studio;
}

function expectServiceError(
  operation: () => unknown,
  code: WorkspaceSourceRetentionServiceErrorCode,
) {
  assert.throws(
    operation,
    (error) =>
      error instanceof WorkspaceSourceRetentionServiceError &&
      error.code === code,
  );
}

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("Retention audit forbids provider/network calls.");
  }) as typeof fetch;

  const databasePath = path.join(root, "v12-upgrade.db");
  const database = new WorkspaceDatabase(databasePath, {
    migrations: V12_MIGRATIONS,
  });
  const projectId = insertProject(database);
  const projectSource = createProjectDocumentSource(database, projectId);
  const activeLegal = createLegalSource(database, {
    projectId,
    label: "active",
    retrievedAt: "2098-12-31T00:00:00.000Z",
    retention: "full_text_ttl",
    expiresAt: ACTIVE_EXPIRY,
  });
  const expiredLegal = createLegalSource(database, {
    projectId,
    label: "expired",
    retrievedAt: HISTORICAL_RETRIEVED_AT,
    retention: "full_text_ttl",
    expiresAt: HISTORICAL_EXPIRY,
  });
  const disallowedLegal = createLegalSource(database, {
    projectId,
    label: "no-retention",
    retrievedAt: CREATED_AT,
    retention: "no_retention",
    expiresAt: null,
  });
  assert.ok(activeLegal.anchorId);
  assert.ok(expiredLegal.anchorId);
  assert.ok(disallowedLegal.anchorId);
  const activeStudio = bindStudioAnchor(
    database,
    projectId,
    activeLegal.anchorId,
    "active-legal-studio",
  );
  const expiredStudio = bindStudioAnchor(
    database,
    projectId,
    expiredLegal.anchorId,
    "expired-legal-studio",
  );

  const migration = database.runMigrations(V13_MIGRATIONS);
  assert.equal(migration.currentVersion, 13);
  assert.deepEqual(
    migration.applied.map((item) => item.version),
    [13],
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM project_source_snapshot_lifecycle",
      )
      .get()?.count,
    4,
  );

  const repository = new WorkspaceSourceRetentionLifecycleRepository(database);
  let now = ACTIVE_NOW;
  const service = new WorkspaceSourceRetentionService(repository, () => now);
  const projectSources = new WorkspaceProjectSourcesService(
    database,
    new WorkspaceSourceFoundationRepository(database),
    { retention: service },
  );

  assert.equal(service.providerActivation().open, false);
  assert.deepEqual(
    service.providerActivation(),
    LEGAL_SOURCE_RETENTION_ACTIVATION_V13,
  );
  assert.ok(
    service
      .providerActivation()
      .blockers.includes("legal_exact_quote_physical_cleanup_unimplemented"),
  );
  assert.equal(
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE name = 'legal_source_blob_records'",
      )
      .get(),
    undefined,
  );

  const activeRecord = repository.getSourceUseRecord(
    projectId,
    activeLegal.snapshotId,
  );
  assert.equal(activeRecord?.lifecycle?.accessState, "available");
  assert.equal(
    activeRecord?.lifecycle?.expiresAtEpochMs,
    Date.parse(ACTIVE_EXPIRY),
  );
  assert.equal(
    repository.getSourceUseRecord(projectId, expiredLegal.snapshotId)?.lifecycle
      ?.accessState,
    "tombstoned",
  );
  assert.equal(
    repository.getSourceUseRecord(projectId, disallowedLegal.snapshotId)
      ?.lifecycle?.tombstoneReason,
    "retention_disallowed",
  );

  assert.match(
    service.readAnchorQuote(projectId, activeLegal.anchorId).exactQuote,
    /active licensed exact quote/,
  );
  const activePublicDetail = projectSources.getSnapshot(
    projectId,
    activeLegal.snapshotId,
  );
  assert.deepEqual(activePublicDetail.snapshot.locator, {
    authorityIdentifier: "AUTH-active",
  });
  assert.deepEqual(activePublicDetail.snapshot.retrievalMetadata, {
    providerId: "offline-audit-fixture",
  });
  assert.match(
    service.readAnchorQuote(projectId, projectSource.anchorId).exactQuote,
    /User-owned Project text/,
  );
  expectServiceError(
    () => service.readAnchorQuote(projectId, expiredLegal.anchorId),
    "source_retention_tombstoned",
  );
  const expiredMetadata = service.readAnchorMetadata(
    projectId,
    expiredLegal.anchorId,
  );
  assert.equal(expiredMetadata.quoteAvailable, false);
  assert.equal("exactQuote" in expiredMetadata, false);
  assert.equal(expiredMetadata.accessState, "tombstoned");
  const expiredPublicDetail = projectSources.getSnapshot(
    projectId,
    expiredLegal.snapshotId,
  );
  assert.equal(expiredPublicDetail.snapshot.id, expiredLegal.snapshotId);
  assert.equal(
    expiredPublicDetail.snapshot.contentSha256,
    sha256("expired authority body"),
  );
  assert.equal(expiredPublicDetail.snapshot.retentionPolicy, "full_text_ttl");
  assert.equal(
    expiredPublicDetail.snapshot.license.basis,
    "deployment_contract",
  );
  assert.deepEqual(expiredPublicDetail.snapshot.locator, {});
  assert.deepEqual(expiredPublicDetail.snapshot.retrievalMetadata, {});
  assert.equal(expiredPublicDetail.anchors[0]?.exactQuote, null);
  assert.deepEqual(expiredPublicDetail.anchors[0]?.locator, {});
  assert.equal(expiredPublicDetail.anchors[0]?.quoteAvailable, false);
  assert.equal(
    expiredPublicDetail.anchors[0]?.retentionDenialCode,
    "source_retention_tombstoned",
  );

  expectServiceError(
    () =>
      service.assertStudioVersionAction({
        projectId,
        documentId: activeStudio.documentId,
        versionId: activeStudio.versionId,
        action: "model_use",
        modelExecution: "remote",
      }),
    "source_retention_local_model_required",
  );
  assert.equal(
    service.assertStudioVersionAction({
      projectId,
      documentId: activeStudio.documentId,
      versionId: activeStudio.versionId,
      action: "model_use",
      modelExecution: "local",
    }).length,
    1,
  );
  expectServiceError(
    () =>
      service.assertStudioVersionAction({
        projectId,
        documentId: activeStudio.documentId,
        versionId: activeStudio.versionId,
        action: "export_work_product",
      }),
    "source_retention_policy_prohibited",
  );
  assert.equal(
    service.assertStudioVersionAction({
      projectId,
      documentId: activeStudio.documentId,
      versionId: activeStudio.versionId,
      action: "export_exact_quote",
    }).length,
    1,
  );
  expectServiceError(
    () =>
      service.assertStudioVersionAction({
        projectId,
        documentId: expiredStudio.documentId,
        versionId: expiredStudio.versionId,
        action: "export_exact_quote",
      }),
    "source_retention_tombstoned",
  );

  assert.ok(activeRecord?.lifecycle);
  if (!activeRecord?.lifecycle) throw new Error("active lifecycle missing");
  const reviewedSubject = {
    ...activeRecord.subject,
    license: {
      ...activeRecord.subject.license,
      export: "reviewed_work_product" as const,
    },
  };
  assert.equal(
    evaluateSourceRetentionPolicyV13(reviewedSubject, "export_work_product", {
      nowEpochMs: ACTIVE_NOW,
      lifecycle: activeRecord.lifecycle,
      reviewedWorkProduct: false,
    }).denialCode,
    "source_retention_review_required",
  );
  assert.equal(
    evaluateSourceRetentionPolicyV13(reviewedSubject, "export_work_product", {
      nowEpochMs: ACTIVE_NOW,
      lifecycle: activeRecord.lifecycle,
      reviewedWorkProduct: true,
    }).allowed,
    true,
  );

  now = AFTER_EXPIRY;
  const sweep = service.startupSweep();
  assert.equal(sweep.tombstoned, 1);
  assert.equal(sweep.readiness.dueButAvailableCount, 0);
  assert.ok(sweep.readiness.blockedLegacyAnchorCount >= 3);
  assert.ok(sweep.readiness.legacyLegalAnchorCount >= 3);
  expectServiceError(
    () => service.readAnchorQuote(projectId, activeLegal.anchorId),
    "source_retention_tombstoned",
  );
  assert.equal(
    database
      .prepare("SELECT exact_quote FROM source_citation_anchors WHERE id = ?")
      .get(activeLegal.anchorId)?.exact_quote,
    "active licensed exact quote",
  );
  assert.equal(
    database
      .prepare(
        `SELECT count(*) AS count
           FROM document_version_citation_anchors
          WHERE anchor_id IN (?, ?)`,
      )
      .get(activeLegal.anchorId, expiredLegal.anchorId)?.count,
    2,
  );

  const sourceRepository = new WorkspaceSourceFoundationRepository(database);
  assert.throws(() =>
    sourceRepository.createCitationAnchor({
      id: randomUUID(),
      projectId,
      snapshotId: activeLegal.snapshotId,
      ordinal: 1,
      exactQuote: "must not be persisted after expiry",
      locator: { section: "99" },
      createdAt: new Date(AFTER_EXPIRY).toISOString(),
    }),
  );

  const postExpiryStudio = insertDocumentVersion(
    database,
    projectId,
    "post-expiry-studio",
    "draft",
  );
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO document_version_citation_anchors (
           project_id, document_id, version_id, anchor_id, ordinal, created_at
         ) VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(
        projectId,
        postExpiryStudio.documentId,
        postExpiryStudio.versionId,
        activeLegal.anchorId,
        new Date(AFTER_EXPIRY).toISOString(),
      ),
  );

  now = ACTIVE_NOW;
  assert.equal(service.readiness().highWaterEpochMs, AFTER_EXPIRY);
  expectServiceError(
    () => service.readAnchorQuote(projectId, activeLegal.anchorId),
    "source_retention_tombstoned",
  );
  assert.throws(() =>
    database
      .prepare(
        `UPDATE project_source_snapshot_lifecycle
            SET access_state = 'available', tombstone_reason = NULL,
                tombstoned_at_epoch_ms = NULL, cleanup_state = 'not_required'
          WHERE snapshot_id = ?`,
      )
      .run(activeLegal.snapshotId),
  );

  database
    .prepare(
      "DELETE FROM project_source_snapshot_lifecycle WHERE snapshot_id = ?",
    )
    .run(activeLegal.snapshotId);
  expectServiceError(
    () => service.readAnchorQuote(projectId, activeLegal.anchorId),
    "source_retention_lifecycle_missing",
  );
  assert.equal(
    service.readAnchorMetadata(projectId, activeLegal.anchorId).quoteAvailable,
    false,
  );

  assert.equal(networkCalls, 0);
  database.close();

  const fresh = new WorkspaceDatabase(path.join(root, "fresh-v13.db"), {
    migrations: V13_MIGRATIONS,
  });
  assert.equal(
    fresh
      .prepare(
        "SELECT max(version) AS version FROM workspace_schema_migrations",
      )
      .get()?.version,
    13,
  );
  assert.ok(
    fresh
      .prepare(
        `SELECT 1 AS present FROM sqlite_schema
          WHERE type = 'trigger'
            AND name = 'source_retention_v13_studio_binding_guard'`,
      )
      .get(),
  );
  fresh.close();
  globalThis.fetch = originalFetch;

  process.stdout.write(
    `${JSON.stringify({
      suite: "vera-workspace-source-retention-v13-audit",
      status: "passed",
      providerCalls: networkCalls,
      activationGate: LEGAL_SOURCE_RETENTION_ACTIVATION_V13.code,
      physicalQuoteCleanup: "blocked_legacy_anchor",
    })}\n`,
  );
} finally {
  process.env = originalEnvironment;
  rmSync(root, { recursive: true, force: true });
}
