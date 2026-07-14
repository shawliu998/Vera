import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";
import JSZip from "jszip";

import { migratePlaintextDatabaseToSqlcipher } from "../lib/aletheia/sqlcipherMigration";
import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  CreateTabularReviewRequestSchema,
  UpdateTabularReviewRequestSchema,
} from "../lib/workspace/contracts";
import { unicodeCodePointLengthV1 } from "../lib/workspace/workspacePersistencePrimitivesV1";
import {
  WORKSPACE_MIGRATIONS,
  WorkspaceMigrationError,
  workspaceMigrationChecksum,
  type WorkspaceMigration,
} from "../lib/workspace/migrations";
import { ASSISTANT_RUNTIME_MIGRATION } from "../lib/workspace/migrations/v5AssistantRuntime";
import { WORKFLOW_RUNTIME_V6_MIGRATION } from "../lib/workspace/migrations/v6WorkflowRuntime";
import {
  TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  V7_APPLY_POLICY,
  createV7ApplyStageGuard,
} from "../lib/workspace/migrations/v7TabularMikeSemantics";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import {
  MAX_TABULAR_EXPORT_SOURCE_BYTES,
  TabularRepository,
} from "../lib/workspace/repositories/tabular";
import { createTabularCellJobHandler } from "../lib/workspace/services/tabularRuntime";
import { createWorkspaceJobEnqueuer } from "../lib/workspace/services/jobEnqueuer";
import { TabularExporter } from "../lib/workspace/tabularExport";
import { TabularService } from "../lib/workspace/services/tabular";
import {
  MikeColumnConfigSchema,
  TabularReviewTitleSchemaV7,
  parseTags,
} from "../lib/workspace/services/tabularCompatibility";
import { TABULAR_CONTRACT_V7_MANIFEST } from "../lib/workspace/tabularContractV7";
import { validateTabularPersistenceV7 } from "../lib/workspace/tabularPersistenceV7";
import {
  createWorkspaceTabularV1Router,
  type WorkspaceTabularV1RuntimePort,
} from "../routes/workspaceTabularV1";

const root = mkdtempSync(path.join(os.tmpdir(), "vera-tabular-mike-"));
const sqlcipherBackupRoot = mkdtempSync(
  path.join(os.tmpdir(), "vera-tabular-mike-sqlcipher-backup-"),
);
const auditDatabaseKey = randomBytes(32);
const now = "2026-07-14T12:00:00.000Z";
const later = "2026-07-14T12:01:00.000Z";
function preV7Migrations() {
  const byVersion = new Map(
    WORKSPACE_MIGRATIONS.filter((migration) => migration.version < 7).map(
      (migration) => [migration.version, migration],
    ),
  );
  for (const migration of [
    ASSISTANT_RUNTIME_MIGRATION,
    WORKFLOW_RUNTIME_V6_MIGRATION,
  ]) {
    if (!byVersion.has(migration.version)) {
      byVersion.set(migration.version, migration);
    }
  }
  return [...byVersion.values()].sort(
    (left, right) => left.version - right.version,
  );
}
const PRE_V7_MIGRATIONS = preV7Migrations();
const TABULAR_AUDIT_MIGRATIONS = [
  ...PRE_V7_MIGRATIONS,
  TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
] as const;

const ids = {
  project: "11111111-1111-4111-8111-111111111111",
  model: "22222222-2222-4222-8222-222222222222",
  docA: "33333333-3333-4333-8333-333333333333",
  docB: "44444444-4444-4444-8444-444444444444",
  docOther: "55555555-5555-4555-8555-555555555555",
  versionA1: "66666666-6666-4666-8666-666666666666",
  versionA2: "77777777-7777-4777-8777-777777777777",
  versionB1: "88888888-8888-4888-8888-888888888888",
  versionOther: "99999999-9999-4999-8999-999999999999",
  chunkA1: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  chunkA2: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  chunkB1: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  chunkOther: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  legacyReview: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  legacyColumnText: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  legacyColumnBool: "10101010-1010-4010-8010-101010101010",
  legacyColumnEnum: "20202020-2020-4020-8020-202020202020",
  legacyColumnBadEnum: "30303030-3030-4030-8030-303030303030",
  legacyCellStrict: "40404040-4040-4040-8040-404040404040",
  legacyCellLongOk: "50505050-5050-4050-8050-505050505050",
  legacyCellLongBad: "60606060-6060-4060-8060-606060606060",
  legacyCellSecret: "70707070-7070-4070-8070-707070707070",
  activeJob: "80808080-8080-4080-8080-808080808080",
  activeQueuedJob: "81818181-8181-4181-8181-818181818181",
  activeFailedJob: "82828282-8282-4282-8282-828282828282",
  activeCompleteJob: "83838383-8383-4383-8383-838383838383",
  activeCancelledJob: "84848484-8484-4484-8484-848484848484",
  activeFalseErrorJob: "85858585-8585-4585-8585-858585858585",
  activeZeroErrorJob: "86868686-8686-4686-8686-868686868686",
  activeStringErrorJob: "87878787-8787-4787-8787-878787878787",
  activeSecretDetailsJob: "89898989-8989-4989-8989-898989898989",
  activeCell: "90909090-9090-4090-8090-909090909090",
  repairReview: "abababab-abab-4bab-8bab-abababababab",
  repairColumnEnum: "babababa-baba-4aba-8aba-babababababa",
  repairColumnFailed: "cacacaca-caca-4aca-8aca-cacacacacaca",
  repairColumnCompleteNull: "dadadada-dada-4ada-8ada-dadadadadada",
  repairColumnCitation: "eaeaeaea-eaea-4aea-8aea-eaeaeaeaeaea",
  repairColumnCitationBounds: "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1",
  repairColumnMalformedError: "31313131-3131-4131-8131-313131313131",
  repairColumnBlockedError: "34343434-3434-4434-8434-343434343434",
  repairColumnInfiniteError: "35353535-3535-4535-8535-353535353535",
  repairColumnEmojiError: "36363636-3636-4636-8636-363636363636",
  repairColumnCancelledError: "3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a",
  repairColumnEmptyError: "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b",
  repairColumnEmojiContent: "41414141-4141-4141-8141-414141414141",
  repairColumnEmojiTag: "42424242-4242-4242-8242-424242424242",
  repairColumnEmojiCitation: "43434343-4343-4343-8343-434343434343",
  repairColumnEmojiValue: "45454545-4545-4545-8545-454545454545",
  repairColumnPositiveInfinityValue: "4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c",
  repairColumnNegativeInfinityValue: "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d",
  repairColumnDuplicateContent: "51515151-5151-4151-8151-515151515151",
  repairColumnDuplicateCitation: "52525252-5252-4252-8252-525252525252",
  repairCellInvalidEnum: "fafafafa-fafa-4afa-8afa-fafafafafafa",
  repairCellFailedNull: "12121212-1212-4212-8212-121212121212",
  repairCellCompleteNull: "13131313-1313-4313-8313-131313131313",
  repairCellBadCitation: "14141414-1414-4414-8414-141414141414",
  repairCellBadCitationBounds: "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d",
  repairCellMalformedError: "32323232-3232-4232-8232-323232323232",
  repairCellBlockedError: "37373737-3737-4737-8737-373737373737",
  repairCellInfiniteError: "38383838-3838-4838-8838-383838383838",
  repairCellEmojiError: "39393939-3939-4939-8939-393939393939",
  repairCellCancelledError: "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c",
  repairCellEmptyError: "3d3d3d3d-3d3d-4d3d-8d3d-3d3d3d3d3d3d",
  repairCellEmojiContent: "46464646-4646-4646-8646-464646464646",
  repairCellEmojiTag: "47474747-4747-4747-8747-474747474747",
  repairCellEmojiCitation: "48484848-4848-4848-8848-484848484848",
  repairCellEmojiValue: "49494949-4949-4949-8949-494949494949",
  repairCellPositiveInfinityValue: "4e4e4e4e-4e4e-4e4e-8e4e-4e4e4e4e4e4e",
  repairCellNegativeInfinityValue: "4f4f4f4f-4f4f-4f4f-8f4f-4f4f4f4f4f4f",
  repairCellDuplicateContent: "53535353-5353-4353-8353-535353535353",
  repairCellDuplicateCitation: "54545454-5454-4454-8454-545454545454",
  repairChat: "15151515-1515-4515-8515-151515151515",
  repairChatPendingMessage: "16161616-1616-4616-8616-161616161616",
  repairChatStreamingMessage: "17171717-1717-4717-8717-171717171717",
  repairChatObjectAnnotationsMessage: "4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a",
  repairChatLargeAnnotationsMessage: "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b",
  runningSettledReview: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
  runningSettledColumn: "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b",
  runningSettledCell: "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c",
  incompleteReview: "18181818-1818-4818-8818-181818181818",
  incompleteColumn: "19191919-1919-4919-8919-191919191919",
  zeroColumnsReview: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e",
  mirrorReview: "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f",
  softDeletedDoc: "2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a",
  softDeletedVersion: "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b",
  softDeletedChunk: "2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c",
  softDeletedReview: "2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d",
  softDeletedColumn: "2e2e2e2e-2e2e-4e2e-8e2e-2e2e2e2e2e2e",
  softDeletedCell: "2f2f2f2f-2f2f-4f2f-8f2f-2f2f2f2f2f2f",
  workflow: "a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0",
  review: "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0",
  chat: "c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0",
  message: "d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0",
} as const;

const formats = [
  "text",
  "bulleted_list",
  "number",
  "percentage",
  "monetary_amount",
  "currency",
  "yes_no",
  "date",
  "tag",
] as const;

let generated = 0;
function nextId() {
  generated += 1;
  return `00000000-0000-4000-8000-${generated.toString(16).padStart(12, "0")}`;
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function openDatabase(name: string) {
  return new WorkspaceDatabase(path.join(root, name), {
    migrations: TABULAR_AUDIT_MIGRATIONS,
  });
}

function withSqlcipherEnvironment<T>(
  operation: () => T,
  key: Buffer = auditDatabaseKey,
) {
  const previousEnvironment = { ...process.env };
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
    process.env.ALETHEIA_DATABASE_KEY_SOURCE = "env";
    process.env.ALETHEIA_DATABASE_KEY_BASE64 = key.toString("base64");
    return operation();
  } finally {
    process.env = previousEnvironment;
  }
}

function withSqlcipherRequiredNoKey<T>(operation: () => T) {
  const previousEnvironment = { ...process.env };
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
    process.env.ALETHEIA_DATABASE_KEY_SOURCE = "env";
    delete process.env.ALETHEIA_DATABASE_KEY_BASE64;
    return operation();
  } finally {
    process.env = previousEnvironment;
  }
}

function databaseArtifactPaths(databasePath: string) {
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ];
}

function readDatabaseArtifacts(databasePath: string) {
  return new Map(
    databaseArtifactPaths(databasePath).map((artifactPath) => [
      artifactPath,
      existsSync(artifactPath) ? readFileSync(artifactPath) : null,
    ]),
  );
}

function assertDatabaseArtifactsEqual(
  actualDatabasePath: string,
  expected: ReadonlyMap<string, Buffer | null>,
) {
  const actual = readDatabaseArtifacts(actualDatabasePath);
  for (const [artifactPath, expectedBytes] of expected) {
    const actualBytes = actual.get(artifactPath) ?? null;
    assert.equal(
      actualBytes === null,
      expectedBytes === null,
      `database artifact existence changed unexpectedly: ${artifactPath}`,
    );
    if (actualBytes === null || expectedBytes === null) {
      continue;
    }
    assert.equal(
      actualBytes.equals(expectedBytes),
      true,
      `database artifact changed unexpectedly: ${artifactPath}`,
    );
  }
}

function assertDatabaseArtifactsDoNotContain(
  databasePath: string,
  markers: readonly string[],
) {
  for (const artifactPath of databaseArtifactPaths(databasePath)) {
    if (!existsSync(artifactPath)) continue;
    const bytes = readFileSync(artifactPath);
    for (const marker of markers) {
      assert.equal(
        bytes.includes(Buffer.from(marker)),
        false,
        `database artifact ${artifactPath} leaked marker ${marker}`,
      );
    }
  }
}

function migrateAuditDatabaseToSqlcipher(
  databasePath: string,
  fixtureName: string,
  expectedPlaintextMarkers: readonly string[] = [],
) {
  const backupDir = path.join(sqlcipherBackupRoot, fixtureName);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const migrated = withSqlcipherEnvironment(() =>
    migratePlaintextDatabaseToSqlcipher({
      dataDir: path.dirname(databasePath),
      databasePath,
      backupDir,
      apply: true,
    }),
  );
  assert.equal(migrated.status, "migrated");
  assert.ok(migrated.backup_path);
  const backupPath = String(migrated.backup_path);
  const backupBytes = readFileSync(backupPath);
  for (const marker of expectedPlaintextMarkers) {
    assert.equal(backupBytes.includes(Buffer.from(marker)), true);
  }
  unlinkSync(backupPath);
}

function openSqlcipherWorkspaceDatabase(
  databasePath: string,
  migrations: readonly WorkspaceMigration[] = TABULAR_AUDIT_MIGRATIONS,
) {
  return withSqlcipherEnvironment(
    () => new WorkspaceDatabase(databasePath, { migrations }),
  );
}

function seedProjectModel(db: WorkspaceDatabase) {
  db.prepare(
    `INSERT INTO model_profiles
      (id, name, provider, model, context_window_tokens, max_output_tokens,
       enabled, is_default, capabilities_json, created_at, updated_at)
     VALUES (?, 'Audit model', 'openai', 'audit-model', 2048, 512, 1, 1, ?, ?, ?)`,
  ).run(
    ids.model,
    json({
      streaming: false,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
    }),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO projects
      (id, name, default_model_profile_id, status, created_at, updated_at)
     VALUES (?, 'Audit project', ?, 'active', ?, ?)`,
  ).run(ids.project, ids.model, now, now);
  db.prepare(
    `UPDATE workspace_settings
        SET default_project_id = ?, default_model_profile_id = ?, updated_at = ?
      WHERE id = 'workspace'`,
  ).run(ids.project, ids.model, now);
}

function insertDocument(
  db: WorkspaceDatabase,
  input: {
    id: string;
    versionId: string;
    chunkId: string;
    text: string;
    projectId?: string;
  },
) {
  const contentSha256 =
    "a".repeat(64 - (input.id.length % 8)) + "0".repeat(input.id.length % 8);
  db.prepare(
    `INSERT INTO documents
      (id, project_id, title, filename, mime_type, size_bytes, parse_status,
       current_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text/plain', ?, 'ready', NULL, ?, ?)`,
  ).run(
    input.id,
    input.projectId ?? ids.project,
    `Document ${input.id.slice(0, 4)}`,
    `${input.id.slice(0, 4)}.txt`,
    input.text.length,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO document_versions
      (id, document_id, version_number, source, filename, mime_type, size_bytes,
       content_sha256, storage_key, created_at)
     VALUES (?, ?, 1, 'upload', ?, 'text/plain', ?, ?, ?, ?)`,
  ).run(
    input.versionId,
    input.id,
    `${input.id.slice(0, 4)}.txt`,
    input.text.length,
    contentSha256,
    `storage/${input.versionId}`,
    now,
  );
  db.prepare(
    `INSERT INTO document_chunks
      (id, document_id, version_id, ordinal, text, start_offset, end_offset,
       content_sha256, created_at)
     VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)`,
  ).run(
    input.chunkId,
    input.id,
    input.versionId,
    input.text,
    input.text.length,
    "b".repeat(64),
    now,
  );
  db.prepare(
    "UPDATE documents SET current_version_id = ?, updated_at = ? WHERE id = ?",
  ).run(input.versionId, now, input.id);
  return contentSha256;
}

function seedLegacyBeforeV7(db: WorkspaceDatabase) {
  seedProjectModel(db);
  insertDocument(db, {
    id: ids.docA,
    versionId: ids.versionA1,
    chunkId: ids.chunkA1,
    text: "legacy old text",
  });
  insertDocument(db, {
    id: ids.docB,
    versionId: ids.versionB1,
    chunkId: ids.chunkB1,
    text: "second document",
  });
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Legacy review', 'running', ?, '[]', ?, ?)`,
  ).run(ids.legacyReview, ids.project, ids.model, json([ids.docA]), now, now);
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(ids.legacyReview, ids.docA, now);
  const columnSql = `INSERT INTO tabular_review_columns
      (id, review_id, key, title, output_type, prompt, enum_values_json,
       ordinal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`;
  db.prepare(columnSql).run(
    ids.legacyColumnText,
    ids.legacyReview,
    "text",
    "Text",
    "text",
    null,
    0,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.legacyColumnBool,
    ids.legacyReview,
    "bool",
    "Bool",
    "boolean",
    null,
    1,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.legacyColumnEnum,
    ids.legacyReview,
    "enum",
    "Enum",
    "enum",
    json(["Alpha", "Beta"]),
    2,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.legacyColumnBadEnum,
    ids.legacyReview,
    "bad_enum",
    "Bad Enum",
    "enum",
    json([1]),
    3,
    now,
    now,
  );
  const longOk = "z".repeat(100_000);
  const longBad = "z".repeat(100_001);
  const cellSql = `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 1, ?, ?)`;
  db.prepare(cellSql).run(
    ids.legacyCellStrict,
    ids.legacyReview,
    ids.docA,
    ids.legacyColumnText,
    "text",
    null,
    json({ summary: "kept", flag: "green", reasoning: "strict" }),
    "complete",
    null,
    now,
    now,
  );
  db.prepare(cellSql).run(
    ids.legacyCellLongOk,
    ids.legacyReview,
    ids.docA,
    ids.legacyColumnBool,
    "boolean",
    json(longOk),
    null,
    "complete",
    null,
    now,
    now,
  );
  db.prepare(cellSql).run(
    ids.legacyCellLongBad,
    ids.legacyReview,
    ids.docA,
    ids.legacyColumnEnum,
    "enum",
    json(longBad),
    null,
    "complete",
    null,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO jobs
      (id, type, status, resource_type, resource_id, retryable, payload_json,
       scheduled_at, queued_at, lease_owner, lease_expires_at, created_at, updated_at)
     VALUES (?, 'tabular_cell', 'running', 'tabular_cell', ?, 1, ?, ?, ?, 'old-worker', ?, ?, ?)`,
  ).run(
    ids.activeJob,
    ids.legacyCellSecret,
    json({ old: true, documentId: ids.docA }),
    now,
    now,
    later,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO jobs
      (id, type, status, resource_type, resource_id, retryable, payload_json,
       scheduled_at, queued_at, created_at, updated_at)
     VALUES (?, 'tabular_cell', 'queued', 'tabular_cell', ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    ids.activeQueuedJob,
    ids.legacyCellStrict,
    json({ old: true, documentId: ids.docA, queued: true }),
    now,
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO jobs
      (id, type, status, resource_type, resource_id, retryable, payload_json,
       error_json, error_code, scheduled_at, queued_at, created_at, updated_at)
     VALUES (?, 'tabular_cell', 'failed', 'tabular_cell', ?, 1,
       '{"count":1e400}', '{}', 'legacy_error', ?, ?, ?, ?)`,
  ).run(ids.activeFailedJob, ids.legacyCellStrict, now, now, now, now);
  const failedJobWithRawErrorSql = `INSERT INTO jobs
      (id, type, status, resource_type, resource_id, retryable, payload_json,
       error_json, error_code, scheduled_at, queued_at, created_at, updated_at)
     VALUES (?, 'tabular_cell', 'failed', 'tabular_cell', ?, 1,
       '{"legacy":true}', ?, 'legacy_error', ?, ?, ?, ?)`;
  db.prepare(failedJobWithRawErrorSql).run(
    ids.activeFalseErrorJob,
    ids.legacyCellStrict,
    "false",
    now,
    now,
    now,
    now,
  );
  db.prepare(failedJobWithRawErrorSql).run(
    ids.activeZeroErrorJob,
    ids.legacyCellStrict,
    "0",
    now,
    now,
    now,
    now,
  );
  db.prepare(failedJobWithRawErrorSql).run(
    ids.activeStringErrorJob,
    ids.legacyCellStrict,
    '""',
    now,
    now,
    now,
    now,
  );
  db.prepare(failedJobWithRawErrorSql).run(
    ids.activeSecretDetailsJob,
    ids.legacyCellStrict,
    json({
      code: "legacy_error",
      message: "Legacy failure",
      retryable: false,
      details: { api_key: "plaintext-secret" },
    }),
    now,
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO jobs
      (id, type, status, resource_type, resource_id, retryable, payload_json,
       result_json, error_json, error_code, scheduled_at, queued_at, created_at,
       updated_at)
     VALUES (?, 'tabular_cell', 'complete', 'tabular_cell', ?, 1,
       '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":1}}}}}}}}}',
       '{"count":1e400}', '{}', 'legacy_error', ?, ?, ?, ?)`,
  ).run(ids.activeCompleteJob, ids.legacyCellStrict, now, now, now, now);
  db.prepare(
    `INSERT INTO jobs
      (id, type, status, resource_type, resource_id, retryable, payload_json,
       error_json, error_code, scheduled_at, queued_at, created_at, updated_at)
     VALUES (?, 'tabular_cell', 'cancelled', 'tabular_cell', ?, 1,
       '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":1}}}}}}}}}',
       '{"code":"legacy","message":"legacy","retryable":false,"details":{"apiKey":"x"}}',
       'legacy', ?, ?, ?, ?)`,
  ).run(ids.activeCancelledJob, ids.legacyCellStrict, now, now, now, now);
  db.prepare(cellSql).run(
    ids.legacyCellSecret,
    ids.legacyReview,
    ids.docA,
    ids.legacyColumnBadEnum,
    "enum",
    null,
    json({ summary: "bad", secret: "sk-danger" }),
    "queued",
    ids.activeJob,
    now,
    now,
  );

  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Repair review', 'complete', ?, '[]', ?, ?)`,
  ).run(ids.repairReview, ids.project, ids.model, json([ids.docA]), now, now);
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(ids.repairReview, ids.docA, now);
  db.prepare(columnSql).run(
    ids.repairColumnEnum,
    ids.repairReview,
    "repair_enum",
    "Repair Enum",
    "enum",
    json(["Alpha"]),
    0,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnFailed,
    ids.repairReview,
    "repair_failed",
    "Repair Failed",
    "text",
    null,
    1,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnCompleteNull,
    ids.repairReview,
    "repair_complete_null",
    "Repair Complete Null",
    "text",
    null,
    2,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnCitation,
    ids.repairReview,
    "repair_citation",
    "Repair Citation",
    "text",
    null,
    3,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnCitationBounds,
    ids.repairReview,
    "repair_citation_bounds",
    "Repair Citation Bounds",
    "text",
    null,
    4,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnMalformedError,
    ids.repairReview,
    "repair_malformed_error",
    "Repair Malformed Error",
    "text",
    null,
    5,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnBlockedError,
    ids.repairReview,
    "repair_blocked_error",
    "Repair Blocked Error",
    "text",
    null,
    6,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnInfiniteError,
    ids.repairReview,
    "repair_infinite_error",
    "Repair Infinite Error",
    "text",
    null,
    7,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnEmojiError,
    ids.repairReview,
    "repair_emoji_error",
    "Repair Emoji Error",
    "text",
    null,
    8,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnCancelledError,
    ids.repairReview,
    "repair_cancelled_error",
    "Repair Cancelled Error",
    "text",
    null,
    9,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnEmptyError,
    ids.repairReview,
    "repair_empty_error",
    "Repair Empty Error",
    "text",
    null,
    10,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnEmojiContent,
    ids.repairReview,
    "repair_emoji_content",
    "Repair Emoji Content",
    "text",
    null,
    11,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnEmojiTag,
    ids.repairReview,
    "repair_emoji_tag",
    "Repair Emoji Tag",
    "enum",
    json(["😀".repeat(161), `A${" ".repeat(200)}`]),
    12,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnEmojiCitation,
    ids.repairReview,
    "repair_emoji_citation",
    "Repair Emoji Citation",
    "text",
    null,
    13,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnEmojiValue,
    ids.repairReview,
    "repair_emoji_value",
    "Repair Emoji Value",
    "text",
    null,
    14,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnPositiveInfinityValue,
    ids.repairReview,
    "repair_positive_infinity_value",
    "Repair Positive Infinity Value",
    "number",
    null,
    15,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnNegativeInfinityValue,
    ids.repairReview,
    "repair_negative_infinity_value",
    "Repair Negative Infinity Value",
    "number",
    null,
    16,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnDuplicateContent,
    ids.repairReview,
    "repair_duplicate_content",
    "Repair Duplicate Content",
    "text",
    null,
    17,
    now,
    now,
  );
  db.prepare(columnSql).run(
    ids.repairColumnDuplicateCitation,
    ids.repairReview,
    "repair_duplicate_citation",
    "Repair Duplicate Citation",
    "text",
    null,
    18,
    now,
    now,
  );
  db.prepare(cellSql).run(
    ids.repairCellInvalidEnum,
    ids.repairReview,
    ids.docA,
    ids.repairColumnEnum,
    "enum",
    json("Gamma"),
    null,
    "complete",
    null,
    now,
    now,
  );
  db.prepare(cellSql).run(
    ids.repairCellFailedNull,
    ids.repairReview,
    ids.docA,
    ids.repairColumnFailed,
    "text",
    null,
    null,
    "failed",
    null,
    now,
    now,
  );
  db.prepare(cellSql).run(
    ids.repairCellCompleteNull,
    ids.repairReview,
    ids.docA,
    ids.repairColumnCompleteNull,
    "text",
    null,
    null,
    "complete",
    null,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', ?, NULL, ?, 'complete', NULL, 1, ?, ?)`,
  ).run(
    ids.repairCellBadCitation,
    ids.repairReview,
    ids.docA,
    ids.repairColumnCitation,
    json("citation row"),
    json([
      {
        documentId: ids.docB,
        versionId: ids.versionB1,
        chunkId: ids.chunkB1,
        quote: "second document",
      },
    ]),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', ?, NULL, ?, 'complete', NULL, 1, ?, ?)`,
  ).run(
    ids.repairCellBadCitationBounds,
    ids.repairReview,
    ids.docA,
    ids.repairColumnCitationBounds,
    json("citation bounds row"),
    json([
      {
        documentId: ids.docA,
        versionId: ids.versionA1,
        chunkId: ids.chunkA1,
        quote: "legacy old text",
        startOffset: 0,
        endOffset: 9999,
      },
    ]),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, error_json, error_code, job_id, attempt,
       created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'text', NULL, NULL, '[]', 'failed', '{}',
       'legacy_bad_error', NULL, 1, ?, ?, ?)`,
  ).run(
    ids.repairCellMalformedError,
    ids.repairReview,
    ids.docA,
    ids.repairColumnMalformedError,
    now,
    now,
    now,
  );
  const failedErrorCellSql = `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, error_json, error_code, job_id, attempt,
       created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'text', NULL, NULL, '[]', 'failed', ?,
       'legacy_error', NULL, 1, ?, ?, ?)`;
  db.prepare(failedErrorCellSql).run(
    ids.repairCellBlockedError,
    ids.repairReview,
    ids.docA,
    ids.repairColumnBlockedError,
    json({
      code: "legacy_error",
      message: "Legacy failure",
      retryable: false,
      details: {
        apiKey: "x",
        privateKey: "x",
        storagePath: "x",
        absolutePath: "x",
        filePath: "x",
        userId: "x",
        clientId: "x",
        sourcePath: "x",
      },
    }),
    now,
    now,
    now,
  );
  db.prepare(failedErrorCellSql).run(
    ids.repairCellInfiniteError,
    ids.repairReview,
    ids.docA,
    ids.repairColumnInfiniteError,
    '{"code":"legacy_error","message":"Legacy failure","retryable":false,"details":{"count":1e400}}',
    now,
    now,
    now,
  );
  db.prepare(failedErrorCellSql).run(
    ids.repairCellEmojiError,
    ids.repairReview,
    ids.docA,
    ids.repairColumnEmojiError,
    json({
      code: "legacy_error",
      message: "😀".repeat(1001),
      retryable: false,
      details: null,
    }),
    now,
    now,
    now,
  );
  const nonFailedErrorCellSql = `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, error_json, error_code, job_id, attempt,
       created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'text', NULL, NULL, '[]', ?, ?,
       'legacy_error', NULL, 1, ?, ?, NULL)`;
  db.prepare(nonFailedErrorCellSql).run(
    ids.repairCellCancelledError,
    ids.repairReview,
    ids.docA,
    ids.repairColumnCancelledError,
    "cancelled",
    "{}",
    now,
    now,
  );
  db.prepare(nonFailedErrorCellSql).run(
    ids.repairCellEmptyError,
    ids.repairReview,
    ids.docA,
    ids.repairColumnEmptyError,
    "empty",
    json({
      code: "legacy_error",
      message: "Legacy empty error",
      retryable: false,
      details: {
        apiKey: "x",
      },
    }),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'text', NULL, ?, '[]', 'complete', NULL, 1, ?, ?, ?)`,
  ).run(
    ids.repairCellEmojiContent,
    ids.repairReview,
    ids.docA,
    ids.repairColumnEmojiContent,
    json({ summary: `A\0${"😀".repeat(100_001)}` }),
    now,
    now,
    now,
  );
  db.prepare(cellSql).run(
    ids.repairCellEmojiTag,
    ids.repairReview,
    ids.docA,
    ids.repairColumnEmojiTag,
    "enum",
    null,
    null,
    "empty",
    null,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', ?, NULL, ?, 'complete', NULL, 1, ?, ?)`,
  ).run(
    ids.repairCellEmojiCitation,
    ids.repairReview,
    ids.docA,
    ids.repairColumnEmojiCitation,
    json("emoji citation row"),
    json([
      {
        documentId: ids.docA,
        versionId: ids.versionA1,
        chunkId: ids.chunkA1,
        quote: `A\0${"😀".repeat(8_001)}`,
      },
    ]),
    now,
    now,
  );
  db.prepare(cellSql).run(
    ids.repairCellEmojiValue,
    ids.repairReview,
    ids.docA,
    ids.repairColumnEmojiValue,
    "text",
    json("😀".repeat(100_001)),
    null,
    "complete",
    null,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'number', '1e400', NULL, '[]', 'complete', NULL, 1, ?, ?)`,
  ).run(
    ids.repairCellPositiveInfinityValue,
    ids.repairReview,
    ids.docA,
    ids.repairColumnPositiveInfinityValue,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'number', '-1e400', NULL, '[]', 'complete', NULL, 1, ?, ?)`,
  ).run(
    ids.repairCellNegativeInfinityValue,
    ids.repairReview,
    ids.docA,
    ids.repairColumnNegativeInfinityValue,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', NULL, '{"summary":"sqlite-first","summary":"node-last"}',
       '[]', 'complete', NULL, 1, ?, ?)`,
  ).run(
    ids.repairCellDuplicateContent,
    ids.repairReview,
    ids.docA,
    ids.repairColumnDuplicateContent,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', ?, NULL,
       '[{"documentId":"${ids.docA}","documentId":"${ids.docB}","versionId":"${ids.versionA1}","chunkId":"${ids.chunkA1}","quote":"legacy old text"}]',
       'complete', NULL, 1, ?, ?)`,
  ).run(
    ids.repairCellDuplicateCitation,
    ids.repairReview,
    ids.docA,
    ids.repairColumnDuplicateCitation,
    json("duplicate citation row"),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_review_chats (id, review_id, title, created_at, updated_at)
     VALUES (?, ?, 'Legacy chat', ?, ?)`,
  ).run(ids.repairChat, ids.repairReview, now, now);
  db.prepare(
    `INSERT INTO tabular_review_chat_messages
      (id, review_chat_id, sequence, role, content, annotations_json, status,
       created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'assistant', 'pending', '[]', ?, ?, ?, NULL)`,
  ).run(ids.repairChatPendingMessage, ids.repairChat, 0, "pending", now, now);
  db.prepare(
    `INSERT INTO tabular_review_chat_messages
      (id, review_chat_id, sequence, role, content, annotations_json, status,
       created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'assistant', 'streaming', '[]', ?, ?, ?, NULL)`,
  ).run(
    ids.repairChatStreamingMessage,
    ids.repairChat,
    1,
    "streaming",
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_review_chat_messages
      (id, review_chat_id, sequence, role, content, annotations_json, status,
       created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'assistant', 'object annotations', ?, 'complete', ?, ?, ?)`,
  ).run(
    ids.repairChatObjectAnnotationsMessage,
    ids.repairChat,
    2,
    json({ unsafe: true }),
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_review_chat_messages
      (id, review_chat_id, sequence, role, content, annotations_json, status,
       created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'assistant', 'large annotations', ?, 'complete', ?, ?, ?)`,
  ).run(
    ids.repairChatLargeAnnotationsMessage,
    ids.repairChat,
    3,
    json(Array.from({ length: 1001 }, (_item, index) => ({ index }))),
    now,
    now,
    now,
  );

  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Running settled', 'running', ?, '[]', ?, ?)`,
  ).run(
    ids.runningSettledReview,
    ids.project,
    ids.model,
    json([ids.docA]),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(ids.runningSettledReview, ids.docA, now);
  db.prepare(columnSql).run(
    ids.runningSettledColumn,
    ids.runningSettledReview,
    "settled",
    "Settled",
    "text",
    null,
    0,
    now,
    now,
  );
  db.prepare(cellSql).run(
    ids.runningSettledCell,
    ids.runningSettledReview,
    ids.docA,
    ids.runningSettledColumn,
    "text",
    json("done"),
    null,
    "complete",
    null,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Zero columns stale config', 'draft', '[]', ?, ?, ?)`,
  ).run(
    ids.zeroColumnsReview,
    ids.project,
    ids.model,
    json([{ index: 0, name: "Stale", prompt: "", format: "text", tags: [] }]),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Stale document mirror', 'draft', '[]', '[]', ?, ?)`,
  ).run(ids.mirrorReview, ids.project, ids.model, now, now);
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(ids.mirrorReview, ids.docA, now);
}

function expectThrows(message: string, operation: () => unknown) {
  let threw = false;
  try {
    operation();
  } catch {
    threw = true;
  }
  assert.equal(threw, true, message);
}

function assertMigrationThrowsCause(
  operation: () => unknown,
  pattern: RegExp,
  label: string,
) {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof WorkspaceMigrationError &&
      error.cause instanceof Error &&
      pattern.test(error.cause.message),
    label,
  );
}

function assertV7RolledBack(databasePath: string) {
  let rolledBack: WorkspaceDatabase;
  try {
    rolledBack = new WorkspaceDatabase(databasePath, {
      migrations: PRE_V7_MIGRATIONS,
    });
  } catch {
    rolledBack = openSqlcipherWorkspaceDatabase(
      databasePath,
      PRE_V7_MIGRATIONS,
    );
  }
  const versions = rolledBack
    .prepare("SELECT version FROM workspace_schema_migrations ORDER BY version")
    .all()
    .map((row) => Number((row as Record<string, unknown>).version));
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);
  const hasFormatColumn = rolledBack
    .prepare("PRAGMA table_info(tabular_review_columns)")
    .all()
    .some((row) => String((row as Record<string, unknown>).name) === "format");
  assert.equal(hasFormatColumn, false);
  rolledBack.close();
}

type NulRecoverySeed = {
  reviewId: string;
  documentId: string;
  titleColumnId: string;
  promptColumnId: string;
  enumColumnId: string;
  escapedEnumColumnId: string;
  originalReviewTitle: string;
  originalColumnTitle: string;
  originalColumnPrompt: string;
  originalEnumJson: string;
  escapedEnumJson: string;
};

function seedNulRecoveryDatabase(
  databasePath: string,
  options: { enumCollision?: boolean; invalidUpdatedAt?: boolean } = {},
): NulRecoverySeed {
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  seedProjectModel(db);
  const documentId = randomUUID();
  insertDocument(db, {
    id: documentId,
    versionId: randomUUID(),
    chunkId: randomUUID(),
    text: "NUL_UNIQUE_MARKER_DOCUMENT",
  });
  const reviewId = randomUUID();
  const titleColumnId = randomUUID();
  const promptColumnId = randomUUID();
  const enumColumnId = randomUUID();
  const escapedEnumColumnId = randomUUID();
  const originalReviewTitle = "NUL_UNIQUE_MARKER_REVIEW\0End";
  const originalColumnTitle = "NUL_UNIQUE_MARKER_TITLE\0Middle";
  const originalColumnPrompt = "\0";
  const enumValues = options.enumCollision
    ? ["A\0B", "A\uFFFDB"]
    : ["\0Lead", "Mid\0d", "End\0", "\0"];
  const originalEnumJson = json(enumValues);
  const escapedEnumJson = '["\\u0041"]';
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, '[]', ?, ?)`,
  ).run(
    reviewId,
    ids.project,
    ids.model,
    originalReviewTitle,
    json([documentId]),
    now,
    options.invalidUpdatedAt ? "not-a-date" : now,
  );
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(reviewId, documentId, now);
  const insertColumn = db.prepare(
    `INSERT INTO tabular_review_columns
      (id, review_id, key, title, output_type, prompt, enum_values_json,
       ordinal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertColumn.run(
    titleColumnId,
    reviewId,
    "nul_title",
    originalColumnTitle,
    "text",
    "title prompt",
    null,
    0,
    now,
    now,
  );
  insertColumn.run(
    promptColumnId,
    reviewId,
    "nul_prompt",
    "Prompt Column",
    "text",
    originalColumnPrompt,
    null,
    1,
    now,
    now,
  );
  insertColumn.run(
    enumColumnId,
    reviewId,
    "nul_enum",
    "Enum Column",
    "enum",
    "enum prompt",
    originalEnumJson,
    2,
    now,
    now,
  );
  insertColumn.run(
    escapedEnumColumnId,
    reviewId,
    "escaped_enum",
    "Escaped Enum",
    "enum",
    "escaped prompt",
    escapedEnumJson,
    3,
    now,
    now,
  );
  const insertCell = db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, '[]', 'empty', NULL, 0, ?, ?)`,
  );
  for (const [columnId, outputType] of [
    [titleColumnId, "text"],
    [promptColumnId, "text"],
    [enumColumnId, "enum"],
    [escapedEnumColumnId, "enum"],
  ] as const) {
    insertCell.run(
      randomUUID(),
      reviewId,
      documentId,
      columnId,
      outputType,
      now,
      now,
    );
  }
  db.close();
  return {
    reviewId,
    documentId,
    titleColumnId,
    promptColumnId,
    enumColumnId,
    escapedEnumColumnId,
    originalReviewTitle,
    originalColumnTitle,
    originalColumnPrompt,
    originalEnumJson,
    escapedEnumJson,
  };
}

function assertNulRecoveryLocks(db: WorkspaceDatabase, reviewId: string) {
  const table = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.table;
  assert.deepEqual(
    db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
    [],
    "NUL recovery snapshot table must not carry foreign keys",
  );
  expectThrows("NUL recovery snapshot insert must be locked", () =>
    db
      .prepare(
        `INSERT INTO ${table}
          (review_id, schema, replacement, review_json, columns_json)
         VALUES (?, ?, ?, '{}', '[]')`,
      )
      .run(
        randomUUID(),
        TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.schema,
        TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.replacement,
      ),
  );
  expectThrows("NUL recovery snapshot update must be locked", () =>
    db
      .prepare(
        `UPDATE ${table} SET replacement = replacement WHERE review_id = ?`,
      )
      .run(reviewId),
  );
  expectThrows("NUL recovery snapshot delete must be locked", () =>
    db.prepare(`DELETE FROM ${table} WHERE review_id = ?`).run(reviewId),
  );
}

function recreateNulRecoveryUpdateLock(db: WorkspaceDatabase) {
  const table = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.table;
  db.exec(`
    CREATE TRIGGER ${TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lockTriggers.update}
    BEFORE UPDATE ON ${table} BEGIN
      SELECT RAISE(ABORT, 'tabular v7 NUL recovery snapshots are immutable');
    END;
  `);
}

function recreateNulRecoveryReviewDeletePurge(db: WorkspaceDatabase) {
  const table = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.table;
  db.exec(`
    CREATE TRIGGER ${TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lifecycleTriggers.reviewDeletePurge}
    AFTER DELETE ON tabular_reviews BEGIN
      DELETE FROM ${table} WHERE review_id = old.id;
    END;
  `);
}

function assertNulRecoveryReviewDeletePurge(
  db: WorkspaceDatabase,
  reviewId: string,
) {
  const table = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.table;
  assert.ok(
    db
      .prepare(`SELECT review_id FROM ${table} WHERE review_id = ?`)
      .get(reviewId),
  );
  assert.equal(
    Number(
      db.prepare("DELETE FROM tabular_reviews WHERE id = ?").run(reviewId)
        .changes,
    ),
    1,
  );
  assert.equal(
    db.prepare("SELECT id FROM tabular_reviews WHERE id = ?").get(reviewId),
    undefined,
  );
  assert.equal(
    db
      .prepare(`SELECT review_id FROM ${table} WHERE review_id = ?`)
      .get(reviewId),
    undefined,
  );
  validateTabularPersistenceV7(db);
}

async function auditNulRecoveryAndEncryptionGate() {
  const databasePath = path.join(root, "nul-recovery.sqlite");
  const seed = seedNulRecoveryDatabase(databasePath);
  const beforePlaintextArtifacts = readDatabaseArtifacts(databasePath);
  assertMigrationThrowsCause(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: TABULAR_AUDIT_MIGRATIONS,
      }),
    /npm run migrate:aletheia:sqlcipher --prefix backend/,
    "plaintext NUL recovery must fail before v7 writes",
  );
  assertDatabaseArtifactsEqual(databasePath, beforePlaintextArtifacts);
  migrateAuditDatabaseToSqlcipher(databasePath, "nul-recovery", [
    "NUL_UNIQUE_MARKER_REVIEW",
    "NUL_UNIQUE_MARKER_DOCUMENT",
  ]);
  assert.throws(
    () =>
      withSqlcipherRequiredNoKey(
        () =>
          new WorkspaceDatabase(databasePath, {
            migrations: TABULAR_AUDIT_MIGRATIONS,
          }),
      ),
    /SQLCipher|database key|Unable to open/i,
  );
  assert.throws(
    () =>
      withSqlcipherEnvironment(
        () =>
          new WorkspaceDatabase(databasePath, {
            migrations: TABULAR_AUDIT_MIGRATIONS,
          }),
        randomBytes(32),
      ),
    /Unable to open the required SQLCipher database/,
  );
  const migrated = openSqlcipherWorkspaceDatabase(databasePath);
  const table = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.table;
  const snapshotRow = migrated
    .prepare(
      `SELECT schema, replacement, review_json, columns_json
         FROM ${table}
        WHERE review_id = ?`,
    )
    .get(seed.reviewId) as Record<string, unknown>;
  assert.equal(
    snapshotRow.schema,
    TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.schema,
  );
  assert.equal(
    snapshotRow.replacement,
    TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.replacement,
  );
  const reviewSnapshot = JSON.parse(String(snapshotRow.review_json)) as {
    id: string;
    title: { original: string; canonical: string };
  };
  const columnSnapshots = JSON.parse(
    String(snapshotRow.columns_json),
  ) as Array<{
    id: string;
    ordinal: number;
    title: { original: string; canonical: string };
    prompt: { original: string; canonical: string };
    enumValues: { original: string[] | null; canonical: string[] | null };
  }>;
  assert.equal(snapshotRow.review_json, JSON.stringify(reviewSnapshot));
  assert.equal(snapshotRow.columns_json, JSON.stringify(columnSnapshots));
  assert.equal(reviewSnapshot.title.original, seed.originalReviewTitle);
  assert.equal(
    reviewSnapshot.title.canonical,
    seed.originalReviewTitle.replaceAll("\0", "\uFFFD"),
  );
  assert.deepEqual(
    columnSnapshots.map((column) => [column.id, column.ordinal]),
    [
      [seed.titleColumnId, 0],
      [seed.promptColumnId, 1],
      [seed.enumColumnId, 2],
      [seed.escapedEnumColumnId, 3],
    ],
  );
  const persistedReview = migrated
    .prepare("SELECT title FROM tabular_reviews WHERE id = ?")
    .get(seed.reviewId) as Record<string, unknown>;
  assert.equal(persistedReview.title, reviewSnapshot.title.canonical);
  const columns = migrated
    .prepare(
      `SELECT id, title, prompt, enum_values_json
         FROM tabular_review_columns
        WHERE review_id = ?
        ORDER BY ordinal ASC, id ASC`,
    )
    .all(seed.reviewId) as Array<Record<string, unknown>>;
  const columnsById = new Map(
    columns.map((column) => [String(column.id), column]),
  );
  assert.equal(
    columnsById.get(seed.titleColumnId)?.title,
    seed.originalColumnTitle.replaceAll("\0", "\uFFFD"),
  );
  assert.equal(columnsById.get(seed.promptColumnId)?.prompt, "\uFFFD");
  assert.equal(
    columnsById.get(seed.enumColumnId)?.enum_values_json,
    json(["\uFFFDLead", "Mid\uFFFDd", "End\uFFFD", "\uFFFD"]),
  );
  assert.equal(
    columnsById.get(seed.escapedEnumColumnId)?.enum_values_json,
    seed.escapedEnumJson,
  );
  validateTabularPersistenceV7(migrated);
  assertNulRecoveryLocks(migrated, seed.reviewId);
  for (const statement of [
    [
      "UPDATE tabular_reviews SET title = ? WHERE id = ?",
      "after\0nul",
      seed.reviewId,
    ],
    [
      "UPDATE tabular_review_columns SET key = ? WHERE id = ?",
      "key\0nul",
      seed.titleColumnId,
    ],
    [
      "UPDATE tabular_review_columns SET title = ? WHERE id = ?",
      "title\0nul",
      seed.titleColumnId,
    ],
    [
      "UPDATE tabular_review_columns SET prompt = ? WHERE id = ?",
      "prompt\0nul",
      seed.titleColumnId,
    ],
    [
      "UPDATE tabular_review_columns SET enum_values_json = ? WHERE id = ?",
      json(["tag\0nul"]),
      seed.enumColumnId,
    ],
    [
      "UPDATE tabular_review_columns SET tags_json = ? WHERE id = ?",
      json(["tag\0nul"]),
      seed.enumColumnId,
    ],
  ] as const) {
    expectThrows(`direct SQL NUL write rejected: ${statement[0]}`, () =>
      migrated.prepare(statement[0]).run(statement[1], statement[2]),
    );
  }
  assertNulRecoveryReviewDeletePurge(migrated, seed.reviewId);
  migrated.close();
  assertDatabaseArtifactsDoNotContain(databasePath, [
    "NUL_UNIQUE_MARKER_REVIEW",
    "NUL_UNIQUE_MARKER_DOCUMENT",
  ]);
}

async function auditNulRecoveryCollisionFailsBeforeWrite() {
  const databasePath = path.join(root, "nul-recovery-collision.sqlite");
  seedNulRecoveryDatabase(databasePath, { enumCollision: true });
  const beforeArtifacts = readDatabaseArtifacts(databasePath);
  assertMigrationThrowsCause(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: TABULAR_AUDIT_MIGRATIONS,
      }),
    /without collision/,
    "NUL canonical collision must fail before v7 writes",
  );
  assertDatabaseArtifactsEqual(databasePath, beforeArtifacts);
  assertV7RolledBack(databasePath);
}

async function auditNulRecoveryValidatorMutationAndRollback() {
  const mutationPath = path.join(
    root,
    "nul-recovery-validator-mutation.sqlite",
  );
  const seed = seedNulRecoveryDatabase(mutationPath);
  migrateAuditDatabaseToSqlcipher(
    mutationPath,
    "nul-recovery-validator-mutation",
  );
  const migrated = openSqlcipherWorkspaceDatabase(mutationPath);
  const table = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.table;
  migrated
    .prepare(
      `DROP TRIGGER ${TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lifecycleTriggers.reviewDeletePurge}`,
    )
    .run();
  assert.throws(
    () => validateTabularPersistenceV7(migrated),
    /review deletion lifecycle is incomplete/,
  );
  recreateNulRecoveryReviewDeletePurge(migrated);
  migrated
    .prepare(
      `DROP TRIGGER ${TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lockTriggers.update}`,
    )
    .run();
  const snapshot = migrated
    .prepare(
      `SELECT review_json, columns_json FROM ${table} WHERE review_id = ?`,
    )
    .get(seed.reviewId) as Record<string, unknown>;
  const reviewSnapshot = JSON.parse(String(snapshot.review_json));
  migrated
    .prepare(`UPDATE ${table} SET review_json = ? WHERE review_id = ?`)
    .run(JSON.stringify(reviewSnapshot, null, 2), seed.reviewId);
  recreateNulRecoveryUpdateLock(migrated);
  assert.throws(
    () => validateTabularPersistenceV7(migrated),
    /not canonical JSON/,
  );
  migrated
    .prepare(
      `DROP TRIGGER ${TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lockTriggers.update}`,
    )
    .run();
  migrated
    .prepare(`UPDATE ${table} SET review_json = ? WHERE review_id = ?`)
    .run(JSON.stringify(reviewSnapshot), seed.reviewId);
  const columnSnapshots = JSON.parse(
    String(snapshot.columns_json),
  ) as unknown[];
  migrated
    .prepare(`UPDATE ${table} SET columns_json = ? WHERE review_id = ?`)
    .run(JSON.stringify(columnSnapshots.slice(0, -1)), seed.reviewId);
  recreateNulRecoveryUpdateLock(migrated);
  assert.throws(
    () => validateTabularPersistenceV7(migrated),
    /snapshot is incomplete/,
  );
  migrated.close();

  const rollbackPath = path.join(
    root,
    "nul-recovery-validator-rollback.sqlite",
  );
  const rollbackSeed = seedNulRecoveryDatabase(rollbackPath, {
    invalidUpdatedAt: true,
  });
  migrateAuditDatabaseToSqlcipher(
    rollbackPath,
    "nul-recovery-validator-rollback",
  );
  assertMigrationThrowsCause(
    () => openSqlcipherWorkspaceDatabase(rollbackPath),
    /timestamp|date|Invalid/,
    "validator failure after NUL write plan must roll back the full v7 transaction",
  );
  assertV7RolledBack(rollbackPath);
  const rolledBack = openSqlcipherWorkspaceDatabase(
    rollbackPath,
    PRE_V7_MIGRATIONS,
  );
  assert.equal(
    rolledBack
      .prepare("SELECT title FROM tabular_reviews WHERE id = ?")
      .get(rollbackSeed.reviewId)?.title,
    rollbackSeed.originalReviewTitle,
  );
  assert.equal(
    Boolean(
      rolledBack
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name = ?`,
        )
        .get(TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.table),
    ),
    false,
  );
  rolledBack.close();
}

async function auditEscapedEnumTargetEquivalencePlaintextSafe() {
  const databasePath = path.join(
    root,
    "escaped-enum-target-equivalence.sqlite",
  );
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  seedProjectModel(db);
  const documentId = randomUUID();
  insertDocument(db, {
    id: documentId,
    versionId: randomUUID(),
    chunkId: randomUUID(),
    text: "escaped enum equivalence",
  });
  const reviewId = randomUUID();
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Escaped enum target equivalence', 'draft', ?, '[]', ?, ?)`,
  ).run(reviewId, ids.project, ids.model, json([documentId]), now, now);
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(reviewId, documentId, now);
  const rawEnumJson = ['["\\u0041"]', '["a\\/b"]', '["\\ud83d\\ude00"]'];
  const insertColumn = db.prepare(
    `INSERT INTO tabular_review_columns
      (id, review_id, key, title, output_type, prompt, enum_values_json,
       ordinal, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'enum', '', ?, ?, ?, ?)`,
  );
  const insertCell = db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'enum', NULL, NULL, '[]', 'empty', NULL, 0, ?, ?)`,
  );
  rawEnumJson.forEach((enumJson, index) => {
    const columnId = randomUUID();
    insertColumn.run(
      columnId,
      reviewId,
      `escaped_${index}`,
      `Escaped ${index}`,
      enumJson,
      index,
      now,
      now,
    );
    insertCell.run(randomUUID(), reviewId, documentId, columnId, now, now);
  });
  const targetConfig = db
    .prepare(
      `SELECT coalesce(json_group_array(json(column_json)), '[]') AS target
         FROM (
           SELECT json_object(
             'index', ordinal,
             'name', title,
             'prompt', prompt,
             'format', 'tag',
             'tags', json(enum_values_json)
           ) AS column_json
             FROM tabular_review_columns
            WHERE review_id = ?
            ORDER BY ordinal ASC, id ASC
         )`,
    )
    .get(reviewId) as Record<string, unknown>;
  db.prepare(
    "UPDATE tabular_reviews SET columns_config_json = ? WHERE id = ?",
  ).run(targetConfig.target, reviewId);
  db.close();

  const migrated = new WorkspaceDatabase(databasePath, {
    migrations: TABULAR_AUDIT_MIGRATIONS,
  });
  const reviewRow = migrated
    .prepare("SELECT columns_config_json FROM tabular_reviews WHERE id = ?")
    .get(reviewId) as Record<string, unknown>;
  assert.equal(reviewRow.columns_config_json, targetConfig.target);
  const enumRows = migrated
    .prepare(
      `SELECT enum_values_json
         FROM tabular_review_columns
        WHERE review_id = ?
        ORDER BY ordinal ASC`,
    )
    .all(reviewId) as Array<Record<string, unknown>>;
  assert.deepEqual(
    enumRows.map((row) => row.enum_values_json),
    rawEnumJson,
  );
  migrated.close();
}

function auditTabularNulRequestBoundaries() {
  const validCreate = {
    title: "Valid",
    columns: [
      {
        key: "valid_column",
        title: "Column",
        outputType: "enum" as const,
        prompt: "Prompt",
        enumValues: ["Alpha"],
      },
    ],
  };
  assert.doesNotThrow(() =>
    CreateTabularReviewRequestSchema.parse(validCreate),
  );
  assert.throws(() =>
    CreateTabularReviewRequestSchema.parse({
      ...validCreate,
      title: "Bad\0Title",
    }),
  );
  assert.throws(() =>
    CreateTabularReviewRequestSchema.parse({
      ...validCreate,
      columns: [{ ...validCreate.columns[0], title: "Bad\0Column" }],
    }),
  );
  assert.throws(() =>
    CreateTabularReviewRequestSchema.parse({
      ...validCreate,
      columns: [{ ...validCreate.columns[0], prompt: "Bad\0Prompt" }],
    }),
  );
  assert.throws(() =>
    CreateTabularReviewRequestSchema.parse({
      ...validCreate,
      columns: [{ ...validCreate.columns[0], enumValues: ["Bad\0Tag"] }],
    }),
  );
  assert.doesNotThrow(() =>
    UpdateTabularReviewRequestSchema.parse({ title: "Valid update" }),
  );
  assert.throws(() =>
    UpdateTabularReviewRequestSchema.parse({ title: "Bad\0Update" }),
  );
}

async function auditMigrationHardening() {
  const databasePath = path.join(root, "legacy-v7.sqlite");
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  seedLegacyBeforeV7(db);
  db.close();

  const beforePlaintextArtifacts = readDatabaseArtifacts(databasePath);
  assertMigrationThrowsCause(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: TABULAR_AUDIT_MIGRATIONS,
      }),
    /npm run migrate:aletheia:sqlcipher --prefix backend/,
    "plaintext destructive v7 migration must fail closed with SQLCipher remediation",
  );
  assertDatabaseArtifactsEqual(databasePath, beforePlaintextArtifacts);
  const rolledBack = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  assert.equal(
    rolledBack
      .prepare("SELECT content FROM tabular_cells WHERE id = ?")
      .get(ids.legacyCellSecret)?.content,
    json({ summary: "bad", secret: "sk-danger" }),
  );
  rolledBack.close();

  migrateAuditDatabaseToSqlcipher(databasePath, "legacy-v7", [
    "sk-danger",
    "legacy old text",
  ]);
  assert.throws(
    () =>
      withSqlcipherRequiredNoKey(
        () =>
          new WorkspaceDatabase(databasePath, {
            migrations: TABULAR_AUDIT_MIGRATIONS,
          }),
      ),
    /SQLCipher|database key|Unable to open/i,
  );
  assert.throws(
    () =>
      withSqlcipherEnvironment(
        () =>
          new WorkspaceDatabase(databasePath, {
            migrations: TABULAR_AUDIT_MIGRATIONS,
          }),
        randomBytes(32),
      ),
    /Unable to open the required SQLCipher database/,
  );
  const migrated = openSqlcipherWorkspaceDatabase(databasePath);
  const appliedVersions = migrated
    .prepare("SELECT version FROM workspace_schema_migrations ORDER BY version")
    .all()
    .map((row) => Number((row as Record<string, unknown>).version));
  assert.deepEqual(appliedVersions, [1, 2, 3, 4, 5, 6, 7]);
  const formatRows = migrated
    .prepare(
      `SELECT key, format, tags_json, enum_values_json, legacy_metadata_json
         FROM tabular_review_columns
        WHERE review_id = ?
        ORDER BY ordinal`,
    )
    .all(ids.legacyReview) as Array<Record<string, unknown>>;
  assert.deepEqual(
    formatRows.map((row) => row.format),
    ["text", "yes_no", "tag", "tag"],
  );
  assert.equal(formatRows[2].tags_json, json(["Alpha", "Beta"]));
  assert.equal(formatRows[3].tags_json, "[]");
  assert.equal(formatRows[3].enum_values_json, null);
  assert.equal(
    JSON.parse(String(formatRows[3].legacy_metadata_json)).migrationIssueCode,
    "tabular_legacy_tags_invalid",
  );

  const config = JSON.parse(
    String(
      (
        migrated
          .prepare(
            "SELECT columns_config_json FROM tabular_reviews WHERE id = ?",
          )
          .get(ids.legacyReview) as Record<string, unknown>
      ).columns_config_json,
    ),
  ) as Array<{ index: number; name: string; format: string }>;
  assert.deepEqual(
    config.map((column) => column.index),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    config.map((column) => column.format),
    ["text", "yes_no", "tag", "tag"],
  );

  const cells = migrated
    .prepare(
      `SELECT id, value_json, content, legacy_content, legacy_content_issue_code,
              status, error_code, error_json, completed_at
         FROM tabular_cells`,
    )
    .all() as Array<Record<string, unknown>>;
  const byId = new Map(cells.map((row) => [String(row.id), row]));
  assert.equal(
    JSON.parse(String(byId.get(ids.legacyCellStrict)!.content)).summary,
    "kept",
  );
  assert.equal(
    JSON.parse(String(byId.get(ids.legacyCellLongOk)!.content)).summary.length,
    100_000,
  );
  assert.equal(byId.get(ids.legacyCellLongOk)!.completed_at, now);
  assert.equal(
    JSON.parse(String(byId.get(ids.legacyCellLongBad)!.content)).summary,
    "Legacy cell content requires review.",
  );
  assert.equal(byId.get(ids.legacyCellLongBad)!.status, "failed");
  assert.equal(byId.get(ids.legacyCellLongBad)!.value_json, null);
  assert.equal(byId.get(ids.legacyCellLongBad)!.completed_at, null);
  assert.equal(
    byId.get(ids.legacyCellLongBad)!.error_code,
    "tabular_legacy_content_requires_review",
  );
  assert.equal(
    JSON.parse(String(byId.get(ids.legacyCellLongBad)!.error_json)).retryable,
    false,
  );
  assert.match(
    String(byId.get(ids.legacyCellLongBad)!.legacy_content),
    /z{100}/,
  );
  assert.equal(
    byId.get(ids.legacyCellLongBad)!.legacy_content_issue_code,
    "tabular_legacy_content_requires_review",
  );
  assert.equal(byId.get(ids.legacyCellSecret)!.status, "failed");
  assert.equal(
    byId.get(ids.legacyCellSecret)!.error_code,
    "workspace_migration_tabular_regeneration_required",
  );
  assert.equal(byId.get(ids.legacyCellSecret)!.value_json, null);
  const migratedRepository = new TabularRepository(migrated);
  const migratedDetail = migratedRepository.requireDetail(ids.legacyReview);
  assert.equal(migratedDetail.cells.length, 4);
  assert.equal(
    migratedDetail.cells.find((cell) => cell.id === ids.legacyCellLongBad)
      ?.error?.code,
    "tabular_legacy_content_requires_review",
  );
  const repairDetail = migratedRepository.requireDetail(ids.repairReview);
  assert.equal(repairDetail.review.status, "failed");
  assert.equal(repairDetail.cells.length, 19);
  const emojiTagColumn = repairDetail.columns.find(
    (column) => column.id === ids.repairColumnEmojiTag,
  );
  assert.deepEqual(emojiTagColumn?.tags, []);
  assert.equal(
    emojiTagColumn?.legacyMetadata.migrationIssueCode,
    "tabular_legacy_tags_invalid",
  );
  for (const cellId of [
    ids.repairCellInvalidEnum,
    ids.repairCellCompleteNull,
    ids.repairCellBadCitation,
    ids.repairCellBadCitationBounds,
    ids.repairCellEmojiContent,
    ids.repairCellEmojiCitation,
    ids.repairCellEmojiValue,
    ids.repairCellPositiveInfinityValue,
    ids.repairCellNegativeInfinityValue,
    ids.repairCellDuplicateContent,
    ids.repairCellDuplicateCitation,
  ]) {
    const cell = repairDetail.cells.find((item) => item.id === cellId);
    assert.equal(cell?.status, "failed");
    assert.equal(cell?.value, null);
    assert.equal(cell?.error?.code, "tabular_legacy_content_requires_review");
  }
  for (const cellId of [
    ids.repairCellFailedNull,
    ids.repairCellMalformedError,
    ids.repairCellBlockedError,
    ids.repairCellInfiniteError,
    ids.repairCellEmojiError,
  ]) {
    const cell = repairDetail.cells.find((item) => item.id === cellId);
    assert.equal(cell?.error?.code, "tabular_legacy_failed_without_error");
    assert.equal(
      cell?.error?.message,
      "Legacy tabular cell failed before workspace schema v7 migration.",
    );
    assert.equal(cell?.error?.details, null);
  }
  for (const cellId of [
    ids.repairCellCancelledError,
    ids.repairCellEmptyError,
    ids.repairCellEmojiTag,
  ]) {
    const cell = repairDetail.cells.find((item) => item.id === cellId);
    assert.equal(cell?.error, null);
  }
  const repairRows = migrated
    .prepare(
      "SELECT id, citations_json, legacy_content FROM tabular_cells WHERE review_id = ?",
    )
    .all(ids.repairReview) as Array<Record<string, unknown>>;
  const repairRowsById = new Map(
    repairRows.map((row) => [String(row.id), row]),
  );
  assert.match(
    String(repairRowsById.get(ids.repairCellInvalidEnum)!.legacy_content),
    /Gamma/,
  );
  assert.equal(
    repairRowsById.get(ids.repairCellBadCitation)!.citations_json,
    "[]",
  );
  assert.match(
    String(repairRowsById.get(ids.repairCellBadCitation)!.legacy_content),
    /second document/,
  );
  assert.match(
    String(repairRowsById.get(ids.repairCellBadCitationBounds)!.legacy_content),
    /9999/,
  );
  assert.match(
    String(repairRowsById.get(ids.repairCellDuplicateContent)!.legacy_content),
    /sqlite-first/,
  );
  assert.match(
    String(repairRowsById.get(ids.repairCellDuplicateCitation)!.legacy_content),
    /legacyCitationsJson/,
  );
  assert.equal(
    repairRowsById.get(ids.repairCellDuplicateCitation)!.citations_json,
    "[]",
  );
  assert.equal(
    migratedRepository.requireDetail(ids.runningSettledReview).review.status,
    "complete",
  );
  const zeroColumns = migrated
    .prepare("SELECT columns_config_json FROM tabular_reviews WHERE id = ?")
    .get(ids.zeroColumnsReview) as Record<string, unknown>;
  assert.equal(zeroColumns.columns_config_json, "[]");
  assert.equal(
    migratedRepository.requireDetail(ids.zeroColumnsReview).cells.length,
    0,
  );
  const mirror = migrated
    .prepare("SELECT document_ids_json FROM tabular_reviews WHERE id = ?")
    .get(ids.mirrorReview) as Record<string, unknown>;
  assert.equal(mirror.document_ids_json, json([ids.docA]));
  assert.deepEqual(migratedRepository.require(ids.mirrorReview).documentIds, [
    ids.docA,
  ]);
  const chatRows = migratedRepository.listChatMessages(
    ids.repairReview,
    ids.repairChat,
  );
  assert.deepEqual(
    chatRows.map((row) => row.status),
    ["interrupted", "interrupted", "complete", "complete"],
  );
  assert.ok(chatRows.slice(0, 2).every((row) => row.completedAt !== null));
  assert.deepEqual(chatRows[2]!.annotations, []);
  assert.deepEqual(chatRows[3]!.annotations, []);
  const jobsRepository = new WorkspaceJobsRepository(migrated);
  for (const jobId of [ids.activeJob, ids.activeQueuedJob]) {
    const job = jobsRepository.getJob(jobId);
    assert.equal(job?.status, "interrupted");
    assert.equal(job?.retryable, false);
    assert.equal(
      job?.error?.code,
      "workspace_migration_tabular_regeneration_required",
    );
    assert.equal(job?.startedAt, now);
    assert.ok(typeof job?.completedAt === "string");
    assert.equal(job?.leaseOwner, null);
    assert.equal(job?.leaseExpiresAt, null);
    assert.deepEqual(job?.payload, {});
    assert.equal(job?.result, null);
  }
  for (const jobId of [
    ids.activeFailedJob,
    ids.activeFalseErrorJob,
    ids.activeZeroErrorJob,
    ids.activeStringErrorJob,
    ids.activeSecretDetailsJob,
  ]) {
    const failedJob = jobsRepository.getJob(jobId);
    assert.equal(failedJob?.status, "failed");
    assert.deepEqual(failedJob?.payload, {});
    assert.equal(failedJob?.result, null);
    assert.equal(
      failedJob?.error?.code,
      "workspace_migration_tabular_regeneration_required",
    );
    assert.equal(failedJob?.error?.details, null);
    assert.equal(failedJob?.retryable, false);
    assert.ok(typeof failedJob?.startedAt === "string");
    assert.ok(typeof failedJob?.completedAt === "string");
  }
  assert.equal(
    JSON.stringify(
      jobsRepository.logProjection(ids.activeSecretDetailsJob),
    ).includes("plaintext-secret"),
    false,
  );

  const completeJob = jobsRepository.getJob(ids.activeCompleteJob);
  assert.equal(completeJob?.status, "complete");
  assert.deepEqual(completeJob?.payload, {});
  assert.deepEqual(completeJob?.result, {});
  assert.equal(completeJob?.error, null);
  assert.ok(typeof completeJob?.startedAt === "string");
  assert.ok(typeof completeJob?.completedAt === "string");

  const cancelledJob = jobsRepository.getJob(ids.activeCancelledJob);
  assert.equal(cancelledJob?.status, "cancelled");
  assert.deepEqual(cancelledJob?.payload, {});
  assert.equal(cancelledJob?.result, null);
  assert.equal(cancelledJob?.error, null);
  assert.ok(typeof cancelledJob?.completedAt === "string");
  assert.ok(cancelledJob?.cancellation?.requestedAt);

  const badShapes = [
    json("scalar"),
    json({ summary: 1 }),
    json({ summary: "ok", flag: null }),
    json({ summary: "ok", reasoning: null }),
    json({ summary: "ok", secret: "sk-danger" }),
  ];
  for (const content of badShapes) {
    expectThrows(`bad content rejected ${content}`, () =>
      migrated
        .prepare("UPDATE tabular_cells SET content = ? WHERE id = ?")
        .run(content, ids.legacyCellStrict),
    );
  }
  migrated.close();
  assertDatabaseArtifactsDoNotContain(databasePath, [
    "sk-danger",
    "legacy old text",
  ]);
}

function createServiceAuditDatabase() {
  const db = openDatabase("service.sqlite");
  seedProjectModel(db);
  insertDocument(db, {
    id: ids.docA,
    versionId: ids.versionA1,
    chunkId: ids.chunkA1,
    text: "old version text",
  });
  insertDocument(db, {
    id: ids.docB,
    versionId: ids.versionB1,
    chunkId: ids.chunkB1,
    text: "second version text",
  });
  insertDocument(db, {
    id: ids.docOther,
    versionId: ids.versionOther,
    chunkId: ids.chunkOther,
    text: "not in review",
    projectId: ids.project,
  });
  return { db };
}

async function auditServiceRuntimeAndExport() {
  const { db } = createServiceAuditDatabase();
  const repo = new TabularRepository(db);
  const jobs = createWorkspaceJobEnqueuer(db, {
    now: () => new Date(now),
    createId: randomUUID,
  });
  const service = new TabularService(repo, jobs, () => new Date(now), nextId);

  const created = service.create({
    title: "Mike formats",
    projectId: ids.project,
    modelProfileId: ids.model,
    documentIds: [ids.docA, ids.docB],
    columns: formats.map((format, index) => ({
      index,
      name: `${format} column`,
      prompt: `Generate ${format}`,
      format,
      ...(format === "tag" ? { tags: ["Alpha", "Beta"] } : {}),
    })),
  });
  assert.deepEqual(
    created.columns.map((column) => column.format),
    [...formats],
  );
  assert.equal(created.cells.length, formats.length * 2);
  assert.throws(
    () =>
      service.create({
        title: "Conflicting column",
        projectId: ids.project,
        modelProfileId: ids.model,
        documentIds: [ids.docA],
        columns: [
          {
            index: 0,
            name: "Conflict",
            prompt: "p",
            outputType: "text",
            format: "tag",
            tags: ["Alpha"],
          },
        ],
      }),
    /format must match outputType/,
  );
  const reviewCountBeforeBadNul = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM tabular_reviews")
        .get() as Record<string, unknown>
    ).count,
  );
  for (const input of [
    {
      title: "Bad\0Service",
      projectId: ids.project,
      documentIds: [ids.docA],
      columns: [{ index: 0, name: "Text", format: "text" }],
    },
    {
      title: "Bad service column",
      projectId: ids.project,
      documentIds: [ids.docA],
      columns: [{ index: 0, name: "Text\0Column", format: "text" }],
    },
    {
      title: "Bad service prompt",
      projectId: ids.project,
      documentIds: [ids.docA],
      columns: [{ index: 0, name: "Text", prompt: "p\0", format: "text" }],
    },
    {
      title: "Bad service tag",
      projectId: ids.project,
      documentIds: [ids.docA],
      columns: [{ index: 0, name: "Tag", format: "tag", tags: ["A\0Tag"] }],
    },
  ]) {
    assert.throws(() => service.create(input));
  }
  assert.equal(
    Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM tabular_reviews")
          .get() as Record<string, unknown>
      ).count,
    ),
    reviewCountBeforeBadNul,
  );
  assert.throws(() =>
    service.update(created.review.id, { title: "Bad\0Update" }),
  );
  assert.throws(() =>
    service.updateDraftMatrix(created.review.id, {
      documentIds: [ids.docA],
      columns: [{ index: 0, name: "Bad\0Draft", format: "text" }],
    }),
  );
  assert.equal(repo.require(created.review.id).title, "Mike formats");

  assert.throws(
    () => service.runReview(created.review.id),
    (error) =>
      error instanceof WorkspaceApiError &&
      error.status === 409 &&
      /document-level authoritative extracted-text runtime/.test(error.message),
  );
  const queuedJobs = db
    .prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'tabular_cell'")
    .get() as { count: number };
  assert.equal(Number(queuedJobs.count), 0);

  const firstCell = created.cells[0]!;
  db.prepare(
    `UPDATE tabular_cells
     SET status = 'complete',
         value_json = ?,
         content = ?,
         citations_json = '[]',
         completed_at = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    json("=2+2"),
    json({
      summary: "=2+2",
      flag: "grey",
      reasoning: "formula protected on export",
    }),
    now,
    now,
    firstCell.id,
  );

  const exportCsv = new TabularExporter(repo).csv(created.review.id);
  assert.match(exportCsv, /'=2\+2/);
  const xlsx = await new TabularExporter(repo).xlsx(created.review.id);
  const zip = await JSZip.loadAsync(xlsx);
  const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(sheetXml, /&apos;=2\+2/);

  const oversizedSummary = "x".repeat(100_000);
  const oversizedColumnCount =
    Math.ceil(MAX_TABULAR_EXPORT_SOURCE_BYTES / (oversizedSummary.length * 4)) +
    1;
  const oversized = service.create({
    title: "Oversized export",
    projectId: ids.project,
    modelProfileId: ids.model,
    documentIds: [ids.docA],
    columns: Array.from({ length: oversizedColumnCount }, (_item, index) => ({
      index,
      name: `Oversized ${index}`,
      prompt: "p",
      format: "text",
    })),
  });
  db.prepare(
    `UPDATE tabular_cells
        SET status = 'complete',
            value_json = ?,
            content = ?,
            citations_json = '[]',
            completed_at = ?,
            updated_at = ?
      WHERE review_id = ?`,
  ).run(
    json(oversizedSummary),
    json({ summary: oversizedSummary }),
    now,
    now,
    oversized.review.id,
  );
  assert.throws(
    () => new TabularExporter(repo).csv(oversized.review.id),
    /memory budget/,
  );

  let modelCalled = false;
  const handler = createTabularCellJobHandler({
    database: db,
    tabular: repo,
    jobs: new WorkspaceJobsRepository(db),
    model: {
      async generateDocument() {
        modelCalled = true;
        return {
          cells: [
            {
              columnId: firstCell.columnId,
              content: { summary: "must not run" },
            },
          ],
        };
      },
    },
  });
  assert.throws(
    () => {
      handler({
        signal: new AbortController().signal,
        job: {
          id: randomUUID(),
          type: "tabular_cell",
          status: "running",
          resourceType: "tabular_cell",
          resourceId: firstCell.id,
          payload: {},
          result: null,
          error: null,
          cancellation: null,
          idempotencyKey: null,
          attempt: 1,
          maxAttempts: 1,
          priority: 0,
          retryable: false,
          queuedAt: now,
          scheduledAt: now,
          startedAt: now,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          lockedAt: later,
          leaseOwner: "worker",
          leaseExpiresAt: later,
          cancellationReason: null,
          cancelRequestedAt: null,
        } as never,
        claim: { leaseOwner: "worker", attempt: 1 },
      });
    },
    (error) =>
      Boolean(
        error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code ===
          "tabular_document_generation_unavailable",
      ),
  );
  assert.equal(modelCalled, false);

  const chat = repo.createChat({
    id: ids.chat,
    reviewId: created.review.id,
    userId: "workspace-local",
    now,
  });
  assert.equal(chat.status, "active");
  const message = repo.appendChatMessage({
    id: ids.message,
    reviewId: created.review.id,
    chatId: ids.chat,
    role: "assistant",
    content: "See source",
    sources: [
      {
        documentId: ids.docA,
        versionId: ids.versionA1,
        chunkId: ids.chunkA1,
        quote: "old version text",
      },
    ],
    now,
  });
  assert.equal(message.sources[0]!.versionId, ids.versionA1);
  expectThrows("chat source outside review rejected", () =>
    repo.appendChatMessage({
      id: randomUUID(),
      reviewId: created.review.id,
      chatId: ids.chat,
      role: "assistant",
      content: "bad",
      sources: [
        {
          documentId: ids.docOther,
          versionId: ids.versionOther,
          chunkId: ids.chunkOther,
          quote: "not in review",
        },
      ],
      now,
    }),
  );

  db.close();
}

async function auditGenerationCapabilityFailClosed() {
  const db = openDatabase("generation-disabled.sqlite");
  seedProjectModel(db);
  insertDocument(db, {
    id: ids.docA,
    versionId: ids.versionA1,
    chunkId: ids.chunkA1,
    text: "x".repeat(100),
  });
  const repo = new TabularRepository(db);
  const service = new TabularService(
    repo,
    createWorkspaceJobEnqueuer(db, { now: () => new Date(now) }),
    () => new Date(now),
    nextId,
  );
  const created = service.create({
    title: "Disabled generation",
    projectId: ids.project,
    modelProfileId: ids.model,
    documentIds: [ids.docA],
    columns: [{ index: 0, name: "Text", format: "text", prompt: "p" }],
  });
  assert.throws(
    () => service.runReview(created.review.id),
    /document-level authoritative extracted-text runtime/,
  );
  assert.throws(
    () => repo.currentDocumentSnapshots(ids.project, [ids.docA], 1_000_000),
    /document-level authoritative extracted-text snapshot reader/,
  );
  assert.throws(
    () =>
      repo.readDocumentSnapshotText({
        documentId: ids.docA,
        versionId: ids.versionA1,
        contentSha256: "a".repeat(64),
        maxTextBytes: 1_000_000,
      }),
    /document-level authoritative extracted-text snapshot reader/,
  );
  db.close();
}

async function auditPartialV7MarkerFailClosed() {
  const databasePath = path.join(root, "partial-v7-marker.sqlite");
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  db.exec(
    "ALTER TABLE tabular_review_columns ADD COLUMN format TEXT NOT NULL DEFAULT 'text'",
  );
  db.close();
  assert.throws(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: TABULAR_AUDIT_MIGRATIONS,
      }),
    (error) =>
      error instanceof WorkspaceMigrationError &&
      error.cause instanceof Error &&
      /v7 markers exist without a recorded v7 migration/.test(
        error.cause.message,
      ),
  );
}

async function auditIncompleteMatrixFailClosed() {
  const databasePath = path.join(root, "incomplete-matrix.sqlite");
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  seedProjectModel(db);
  insertDocument(db, {
    id: ids.docA,
    versionId: ids.versionA1,
    chunkId: ids.chunkA1,
    text: "matrix document",
  });
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Incomplete matrix', 'draft', ?, '[]', ?, ?)`,
  ).run(
    ids.incompleteReview,
    ids.project,
    ids.model,
    json([ids.docA]),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(ids.incompleteReview, ids.docA, now);
  db.prepare(
    `INSERT INTO tabular_review_columns
      (id, review_id, key, title, output_type, prompt, enum_values_json,
       ordinal, created_at, updated_at)
     VALUES (?, ?, 'missing_cell', 'Missing Cell', 'text', '', NULL, 0, ?, ?)`,
  ).run(ids.incompleteColumn, ids.incompleteReview, now, now);
  db.close();
  migrateAuditDatabaseToSqlcipher(databasePath, "incomplete-matrix");
  assertMigrationThrowsCause(
    () => openSqlcipherWorkspaceDatabase(databasePath),
    /incomplete tabular matrix/,
    "incomplete matrix must fail closed after SQLCipher gate is satisfied",
  );
}

async function auditSoftDeletedReviewDocumentFailClosed() {
  const databasePath = path.join(root, "soft-deleted-review-document.sqlite");
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  seedProjectModel(db);
  insertDocument(db, {
    id: ids.softDeletedDoc,
    versionId: ids.softDeletedVersion,
    chunkId: ids.softDeletedChunk,
    text: "soft deleted document",
  });
  db.prepare(
    "UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).run(later, later, ids.softDeletedDoc);
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Soft deleted document review', 'complete', ?, '[]', ?, ?)`,
  ).run(
    ids.softDeletedReview,
    ids.project,
    ids.model,
    json([ids.softDeletedDoc]),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(ids.softDeletedReview, ids.softDeletedDoc, now);
  db.prepare(
    `INSERT INTO tabular_review_columns
      (id, review_id, key, title, output_type, prompt, enum_values_json,
       ordinal, created_at, updated_at)
     VALUES (?, ?, 'soft_deleted', 'Soft Deleted', 'text', '', NULL, 0, ?, ?)`,
  ).run(ids.softDeletedColumn, ids.softDeletedReview, now, now);
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'text', NULL, ?, '[]', 'complete', NULL, 1, ?, ?, ?)`,
  ).run(
    ids.softDeletedCell,
    ids.softDeletedReview,
    ids.softDeletedDoc,
    ids.softDeletedColumn,
    json({ summary: "would requireDetail fail after migration" }),
    now,
    now,
    now,
  );
  db.close();
  migrateAuditDatabaseToSqlcipher(databasePath, "soft-deleted-review-document");
  assertMigrationThrowsCause(
    () => openSqlcipherWorkspaceDatabase(databasePath),
    /inactive documents/,
    "soft-deleted document references must fail closed after SQLCipher gate is satisfied",
  );
}

function seedTextBoundsDatabase(
  databasePath: string,
  input: {
    reviewTitle: string;
    columnKey: string;
    columnTitle: string;
    columnPrompt: string;
    enumValues?: string[] | null;
  },
) {
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  seedProjectModel(db);
  const documentId = randomUUID();
  insertDocument(db, {
    id: documentId,
    versionId: randomUUID(),
    chunkId: randomUUID(),
    text: "unicode code point text bounds",
  });
  const reviewId = randomUUID();
  const columnId = randomUUID();
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, '[]', ?, ?)`,
  ).run(
    reviewId,
    ids.project,
    ids.model,
    input.reviewTitle,
    json([documentId]),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(reviewId, documentId, now);
  db.prepare(
    `INSERT INTO tabular_review_columns
      (id, review_id, key, title, output_type, prompt, enum_values_json,
       ordinal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    columnId,
    reviewId,
    input.columnKey,
    input.columnTitle,
    input.enumValues ? "enum" : "text",
    input.columnPrompt,
    input.enumValues ? json(input.enumValues) : null,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, value_json, content,
       citations_json, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, '[]', 'empty', NULL, 0, ?, ?)`,
  ).run(
    randomUUID(),
    reviewId,
    documentId,
    columnId,
    input.enumValues ? "enum" : "text",
    now,
    now,
  );
  db.close();
  return { reviewId };
}

async function auditUnicodeCodePointTextBounds() {
  assert.equal(unicodeCodePointLengthV1("😀"), 1);
  assert.throws(() => unicodeCodePointLengthV1("\ud800"));
  assert.throws(() => unicodeCodePointLengthV1("\udc00"));
  assert.throws(() => unicodeCodePointLengthV1("safe\0text"));
  const chineseTitle = "汉".repeat(240);
  assert.equal(TabularReviewTitleSchemaV7.parse(chineseTitle), chineseTitle);
  assert.throws(() => TabularReviewTitleSchemaV7.parse("汉".repeat(241)));
  assert.throws(() =>
    TabularReviewTitleSchemaV7.parse(`A\0${"汉".repeat(239)}`),
  );
  assert.deepEqual(parseTags(json(["😀".repeat(160)])), ["😀".repeat(160)]);
  assert.throws(() => parseTags(json(["😀".repeat(161)])));
  assert.throws(() => parseTags(json([`A\0${"😀".repeat(159)}`])));
  assert.doesNotThrow(() =>
    MikeColumnConfigSchema.parse({
      index: 0,
      name: "列".repeat(240),
      prompt: "😀".repeat(20_000),
      format: "tag",
      tags: ["😀".repeat(160)],
    }),
  );
  assert.throws(() =>
    MikeColumnConfigSchema.parse({
      index: 0,
      name: "\ud800",
      prompt: "",
      format: "text",
      tags: [],
    }),
  );
  assert.throws(() =>
    MikeColumnConfigSchema.parse({
      index: 0,
      name: "列".repeat(241),
      prompt: "",
      format: "text",
      tags: [],
    }),
  );
  assert.throws(() =>
    MikeColumnConfigSchema.parse({
      index: 0,
      name: "Safe",
      prompt: "😀".repeat(20_001),
      format: "text",
      tags: [],
    }),
  );

  const passPath = path.join(root, "unicode-code-point-bounds-pass.sqlite");
  const { reviewId } = seedTextBoundsDatabase(passPath, {
    reviewTitle: chineseTitle,
    columnKey: "key_" + "a".repeat(116),
    columnTitle: "列".repeat(240),
    columnPrompt: "😀".repeat(20_000),
    enumValues: ["😀".repeat(160)],
  });
  migrateAuditDatabaseToSqlcipher(passPath, "unicode-code-point-bounds-pass");
  const migrated = openSqlcipherWorkspaceDatabase(passPath);
  const detail = new TabularRepository(migrated).requireDetail(reviewId);
  assert.equal(Array.from(detail.review.title).length, 240);
  assert.equal(Array.from(detail.columns[0]!.tags[0]!).length, 160);
  migrated.close();

  const cases = [
    {
      name: "review-title-nul-before-oversize",
      reviewTitle: `A\0${"汉".repeat(241)}`,
      columnKey: "safe_key",
      columnTitle: "Safe title",
      columnPrompt: "",
      pattern: /text bounds|CHECK constraint failed/,
    },
    {
      name: "review-title-spaces",
      reviewTitle: `Review${" ".repeat(300)}`,
      columnKey: "safe_key",
      columnTitle: "Safe title",
      columnPrompt: "",
      pattern: /text bounds/,
    },
    {
      name: "column-key-spaces",
      reviewTitle: "Safe review",
      columnKey: `key${" ".repeat(300)}`,
      columnTitle: "Safe title",
      columnPrompt: "",
      pattern: /text bounds/,
    },
    {
      name: "column-title-spaces",
      reviewTitle: "Safe review",
      columnKey: "safe_key",
      columnTitle: `Title${" ".repeat(300)}`,
      columnPrompt: "",
      pattern: /text bounds/,
    },
    {
      name: "column-prompt-spaces",
      reviewTitle: "Safe review",
      columnKey: "safe_key",
      columnTitle: "Safe title",
      columnPrompt: `Prompt${" ".repeat(20_001)}`,
      pattern: /text bounds/,
    },
    {
      name: "enum-tab-schema-only",
      reviewTitle: "Safe review",
      columnKey: "safe_key",
      columnTitle: "Safe title",
      columnPrompt: "",
      enumValues: ["\t"],
      pattern: /Invalid persisted tabular enum values/,
    },
    {
      name: "enum-nbsp-schema-only",
      reviewTitle: "Safe review",
      columnKey: "safe_key",
      columnTitle: "Safe title",
      columnPrompt: "",
      enumValues: ["\u00a0"],
      pattern: /Invalid persisted tabular enum values/,
    },
  ];
  for (const testCase of cases) {
    const databasePath = path.join(
      root,
      `unicode-code-point-bounds-${testCase.name}.sqlite`,
    );
    seedTextBoundsDatabase(databasePath, testCase);
    migrateAuditDatabaseToSqlcipher(databasePath, testCase.name);
    let thrown: unknown;
    try {
      openSqlcipherWorkspaceDatabase(databasePath);
    } catch (error) {
      thrown = error;
    }
    assert.ok(
      thrown instanceof WorkspaceMigrationError &&
        thrown.cause instanceof Error &&
        testCase.pattern.test(thrown.cause.message),
      `expected migration failure for ${testCase.name}, got ${
        thrown instanceof WorkspaceMigrationError &&
        thrown.cause instanceof Error
          ? thrown.cause.message
          : String(thrown)
      }`,
    );
    assertV7RolledBack(databasePath);
  }
}

function seedMembershipCardinalityDatabase(
  db: WorkspaceDatabase,
  input: { reviewId: string; count: number },
) {
  seedProjectModel(db);
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Membership cardinality', 'draft', '[]', '[]', ?, ?)`,
  ).run(input.reviewId, ids.project, ids.model, now, now);
  const insertMembership = db.prepare(
    `INSERT INTO tabular_review_documents
      (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (let index = 0; index < input.count; index += 1) {
    const documentId = randomUUID();
    insertDocument(db, {
      id: documentId,
      versionId: randomUUID(),
      chunkId: randomUUID(),
      text: `cardinality ${index}`,
    });
    insertMembership.run(input.reviewId, documentId, index, now);
  }
}

async function auditCardinalityBoundsFailClosed() {
  const databasePath = path.join(root, "cardinality-1001.sqlite");
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  seedMembershipCardinalityDatabase(db, {
    reviewId: randomUUID(),
    count: 1001,
  });
  db.close();
  migrateAuditDatabaseToSqlcipher(databasePath, "cardinality-1001");
  assertMigrationThrowsCause(
    () => openSqlcipherWorkspaceDatabase(databasePath),
    /cardinality bounds/,
    "1001 active memberships must fail closed after SQLCipher gate is satisfied",
  );
  assertV7RolledBack(databasePath);
}

async function auditCardinalityBoundaryPasses() {
  const databasePath = path.join(root, "cardinality-1000.sqlite");
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  const reviewId = randomUUID();
  seedMembershipCardinalityDatabase(db, { reviewId, count: 1000 });
  db.close();
  migrateAuditDatabaseToSqlcipher(databasePath, "cardinality-1000");
  const migrated = openSqlcipherWorkspaceDatabase(databasePath);
  const repo = new TabularRepository(migrated);
  assert.equal(repo.requireDetail(reviewId).review.documentIds.length, 1000);
  const mirror = migrated
    .prepare(
      "SELECT json_array_length(document_ids_json) AS count FROM tabular_reviews WHERE id = ?",
    )
    .get(reviewId) as Record<string, unknown>;
  assert.equal(Number(mirror.count), 1000);
  migrated.close();
}

async function auditFrozenValidatorIsNotDecorative() {
  const databasePath = path.join(root, "validator-not-decorative.sqlite");
  const db = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V7_MIGRATIONS,
  });
  seedProjectModel(db);
  const documentId = randomUUID();
  const reviewId = randomUUID();
  insertDocument(db, {
    id: documentId,
    versionId: randomUUID(),
    chunkId: randomUUID(),
    text: "validator document",
  });
  db.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, model_profile_id, title, status, document_ids_json,
       columns_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Validator review', 'draft', ?, '[]', ?, 'not-a-date')`,
  ).run(reviewId, ids.project, ids.model, json([documentId]), now);
  db.prepare(
    `INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(reviewId, documentId, now);
  db.close();
  assert.throws(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: TABULAR_AUDIT_MIGRATIONS,
      }),
    (error) =>
      error instanceof WorkspaceMigrationError &&
      error.cause instanceof Error &&
      /Invalid persisted tabular review/.test(error.cause.message),
  );
  assertV7RolledBack(databasePath);
}

function auditV7ApplyPolicyIsBound() {
  const baseChecksum = workspaceMigrationChecksum(
    TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  );
  const reorderedPolicy = {
    ...V7_APPLY_POLICY,
    stageOrder: [
      V7_APPLY_POLICY.stageOrder[1],
      V7_APPLY_POLICY.stageOrder[0],
      ...V7_APPLY_POLICY.stageOrder.slice(2),
    ],
  };
  const reorderedChecksum = workspaceMigrationChecksum({
    ...TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
    checksumMaterial:
      TABULAR_MIKE_SEMANTICS_V7_MIGRATION.checksumMaterial.replace(
        JSON.stringify(V7_APPLY_POLICY),
        JSON.stringify(reorderedPolicy),
      ),
  });
  assert.notEqual(reorderedChecksum, baseChecksum);

  const omittedValidatorPolicy = {
    ...V7_APPLY_POLICY,
    stageOrder: V7_APPLY_POLICY.stageOrder.filter(
      (stage) => stage !== "run_declared_frozen_persistence_validator",
    ),
  };
  const omittedValidatorChecksum = workspaceMigrationChecksum({
    ...TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
    checksumMaterial:
      TABULAR_MIKE_SEMANTICS_V7_MIGRATION.checksumMaterial.replace(
        JSON.stringify(V7_APPLY_POLICY),
        JSON.stringify(omittedValidatorPolicy),
      ),
  });
  assert.notEqual(omittedValidatorChecksum, baseChecksum);

  const reorderedGuard = createV7ApplyStageGuard();
  assert.throws(
    () => reorderedGuard.enterStage(V7_APPLY_POLICY.stageOrder[1]),
    /stage order/,
  );

  const omittedValidatorGuard = createV7ApplyStageGuard();
  for (const stage of V7_APPLY_POLICY.stageOrder.slice(0, -1)) {
    omittedValidatorGuard.enterStage(stage);
  }
  assert.throws(() => omittedValidatorGuard.assertComplete(), /stage order/);
}

function auditFrozenPersistenceImportGraph() {
  const tabularPersistenceSource = readFileSync(
    path.join(process.cwd(), "src/lib/workspace/tabularPersistenceV7.ts"),
    "utf8",
  );
  const jobPersistenceSource = readFileSync(
    path.join(process.cwd(), "src/lib/workspace/jobPersistenceV7.ts"),
    "utf8",
  );
  const migrationSource = readFileSync(
    path.join(
      process.cwd(),
      "src/lib/workspace/migrations/v7TabularMikeSemantics.ts",
    ),
    "utf8",
  );
  const tabularRepositorySource = readFileSync(
    path.join(process.cwd(), "src/lib/workspace/repositories/tabular.ts"),
    "utf8",
  );
  const jobsRepositorySource = readFileSync(
    path.join(process.cwd(), "src/lib/workspace/repositories/jobs.ts"),
    "utf8",
  );
  const forbiddenLiveImports =
    /from "\.\/(?:contracts|types|services\/tabularCompatibility|jobs\/stateMachine|jobs\/types)"|from "\.\.\/(?:contracts|types|services\/tabularCompatibility|jobs\/stateMachine|jobs\/types)"/;
  assert.doesNotMatch(tabularPersistenceSource, forbiddenLiveImports);
  assert.doesNotMatch(jobPersistenceSource, forbiddenLiveImports);
  assert.doesNotMatch(tabularPersistenceSource, /from "\.\/repositories\//);
  assert.doesNotMatch(jobPersistenceSource, /from "\.\/repositories\//);
  assert.doesNotMatch(migrationSource, /tabularPersistenceValidator/);
  assert.match(tabularRepositorySource, /from "\.\.\/tabularPersistenceV7"/);
  assert.match(jobsRepositorySource, /from "\.\.\/jobPersistenceV7"/);
  assert.match(migrationSource, /from "\.\.\/tabularPersistenceV7"/);
  assert.match(migrationSource, /V7_APPLY_POLICY/);
  assert.match(migrationSource, /createV7ApplyStageGuard/);
  assert.match(migrationSource, /runDeclaredV7PersistenceValidator/);
  assert.match(migrationSource, /run_declared_frozen_persistence_validator/);
  assert.match(migrationSource, /JSON\.stringify\(V7_APPLY_POLICY\)/);
  assert.match(tabularPersistenceSource, /parseWorkspaceJobRowV7/);
  assert.match(tabularPersistenceSource, /TABULAR_CONTRACT_V7_MANIFEST/);
  assert.match(tabularPersistenceSource, /JOB_CONTRACT_V7_MANIFEST/);
  assert.match(jobPersistenceSource, /from "\.\/jobContractV7"/);
  assert.match(jobPersistenceSource, /assertWorkspaceJobRecordV7/);
  assert.match(jobPersistenceSource, /assertWorkspaceJobResourceTypeV7/);
  const auditSource = readFileSync(
    path.join(process.cwd(), "src/scripts/veraWorkspaceTabularMikeAudit.ts"),
    "utf8",
  );
  assert.match(auditSource, /"summary":"sqlite-first","summary":"node-last"/);
  assert.match(
    auditSource,
    /"documentId":"\$\{ids\.docA\}","documentId":"\$\{ids\.docB\}"/,
  );
}

async function requestJson(
  baseUrl: string,
  pathName: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  return {
    response,
    body,
    text,
  };
}

async function auditRouteModule() {
  const calls: string[] = [];
  const runtime: WorkspaceTabularV1RuntimePort = {
    async listTabularReviews(_context, query) {
      calls.push(`list:${query.projectId ?? ""}`);
      return { data: [] };
    },
    async createTabularReview(_context, input) {
      calls.push("create");
      return { id: ids.review, input };
    },
    async getTabularReview() {
      calls.push("get");
      return { id: ids.review };
    },
    async updateTabularReview(_context, _reviewId, input) {
      calls.push("update");
      return { id: ids.review, input };
    },
    async deleteTabularReview() {
      calls.push("delete");
    },
    async clearTabularCells() {
      calls.push("clear");
    },
    async generateTabularReview() {
      calls.push("generate");
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Tabular generation requires a document-level authoritative extracted-text runtime.",
      );
    },
    async retryTabularCell(_context, _reviewId, input) {
      calls.push(`retry:${input.document_id}:${input.column_index}`);
      return { queued: true };
    },
    async cancelTabularCell() {
      calls.push("cancel");
      return { cancelled: true };
    },
    async listTabularChats() {
      calls.push("listChats");
      return { data: [] };
    },
    async deleteTabularChat() {
      calls.push("deleteChat");
    },
    async listTabularChatMessages() {
      calls.push("messages");
      return { data: [] };
    },
    async streamTabularChat(_context, _reviewId, _input, sink) {
      calls.push("chat");
      sink.write({ type: "content_delta", text: "ok" });
    },
    async exportTabularReview(_context, _reviewId, format) {
      calls.push(`export:${format}`);
      return {
        filename: `审阅-${format === "csv" ? "表格.csv" : "表格.xlsx"}`,
        contentType:
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: format === "csv" ? "a,b\r\n" : new Uint8Array([80, 75, 3, 4]),
      };
    },
  };
  const defaultAuthApp = express();
  defaultAuthApp.use(express.json());
  defaultAuthApp.use(createWorkspaceTabularV1Router(runtime));
  const defaultAuthServer = http.createServer(defaultAuthApp);
  await new Promise<void>((resolve) =>
    defaultAuthServer.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = defaultAuthServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const unauthorized = await requestJson(baseUrl, "/tabular-review");
    assert.equal(unauthorized.response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      defaultAuthServer.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const app = express();
  app.use(express.json());
  app.use(
    createWorkspaceTabularV1Router(runtime, { requireAuthentication: false }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const routeColumns = MikeColumnConfigSchema.array().parse([
      {
        index: 0,
        name: "Tag",
        prompt: "Classify",
        format: "tag",
        tags: ["Alpha"],
      },
    ]);
    const create = await requestJson(baseUrl, "/tabular-review", {
      method: "POST",
      body: JSON.stringify({
        title: "Route review",
        project_id: ids.project,
        document_ids: [ids.docA],
        columns_config: routeColumns,
      }),
    });
    assert.equal(create.response.status, 201);
    assert.equal(JSON.stringify(create.body).includes("501"), false);

    const emptyTitleCreate = await requestJson(baseUrl, "/tabular-review", {
      method: "POST",
      body: JSON.stringify({
        title: "",
        document_ids: [ids.docA],
        columns_config: routeColumns,
      }),
    });
    assert.equal(emptyTitleCreate.response.status, 201);
    assert.match(JSON.stringify(emptyTitleCreate.body), /Untitled Review/);

    const createCallsAfterValidCreate = calls.filter(
      (call) => call === "create",
    ).length;
    for (const body of [
      {
        title: "Bad\0Route",
        document_ids: [ids.docA],
        columns_config: routeColumns,
      },
      {
        title: "Bad route column",
        document_ids: [ids.docA],
        columns_config: [
          {
            index: 0,
            name: "Bad\0Column",
            prompt: "",
            format: "text",
            tags: [],
          },
        ],
      },
      {
        title: "Bad route prompt",
        document_ids: [ids.docA],
        columns_config: [
          {
            index: 0,
            name: "Column",
            prompt: "Bad\0Prompt",
            format: "text",
            tags: [],
          },
        ],
      },
      {
        title: "Bad route tag",
        document_ids: [ids.docA],
        columns_config: [
          {
            index: 0,
            name: "Column",
            prompt: "",
            format: "tag",
            tags: ["Bad\0Tag"],
          },
        ],
      },
    ]) {
      const invalidCreate = await requestJson(baseUrl, "/tabular-review", {
        method: "POST",
        body: JSON.stringify(body),
      });
      assert.equal(invalidCreate.response.status, 422);
    }
    assert.equal(
      calls.filter((call) => call === "create").length,
      createCallsAfterValidCreate,
    );

    const badPatchColumn = await requestJson(
      baseUrl,
      `/tabular-review/${ids.review}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          columns_config: [
            {
              index: 0,
              name: "Bad",
              prompt: "p",
              format: "tag",
              tags: ["Alpha"],
              outputType: "text",
            },
          ],
        }),
      },
    );
    assert.equal(badPatchColumn.response.status, 422);
    const updateCallsBeforeBadNulPatch = calls.filter(
      (call) => call === "update",
    ).length;
    for (const body of [
      { title: "Bad\0Patch" },
      {
        columns_config: [
          {
            index: 0,
            name: "Bad\0Column",
            prompt: "",
            format: "text",
            tags: [],
          },
        ],
      },
      {
        columns_config: [
          {
            index: 0,
            name: "Column",
            prompt: "Bad\0Prompt",
            format: "text",
            tags: [],
          },
        ],
      },
      {
        columns_config: [
          {
            index: 0,
            name: "Column",
            prompt: "",
            format: "tag",
            tags: ["Bad\0Tag"],
          },
        ],
      },
    ]) {
      const invalidPatch = await requestJson(
        baseUrl,
        `/tabular-review/${ids.review}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      );
      assert.equal(invalidPatch.response.status, 422);
    }
    assert.equal(
      calls.filter((call) => call === "update").length,
      updateCallsBeforeBadNulPatch,
    );

    const capabilities = await requestJson(
      baseUrl,
      "/tabular-review/capabilities",
    );
    assert.equal(capabilities.response.status, 200);
    assert.deepEqual(capabilities.body, { generation: false, chat: false });

    const retry = await requestJson(
      baseUrl,
      `/tabular-review/${ids.review}/regenerate-cell`,
      {
        method: "POST",
        body: JSON.stringify({ document_id: ids.docA, column_index: 0 }),
      },
    );
    assert.equal(retry.response.status, 404);
    assert.equal(
      calls.some((call) => call.startsWith("retry:")),
      false,
    );

    const generate = await fetch(
      `${baseUrl}/tabular-review/${ids.review}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(generate.status, 404);
    const generatedText = await generate.text();
    assert.equal(calls.includes("generate"), false);
    assert.doesNotMatch(
      generatedText,
      /document-level authoritative extracted-text runtime/,
    );
    assert.doesNotMatch(
      generate.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );

    const chat = await fetch(`${baseUrl}/tabular-review/${ids.review}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(chat.status, 404);
    assert.equal(calls.includes("chat"), false);

    const exportResponse = await fetch(
      `${baseUrl}/tabular-review/${ids.review}/export.csv`,
    );
    assert.equal(exportResponse.status, 200);
    const disposition = exportResponse.headers.get("content-disposition") ?? "";
    assert.match(disposition, /filename="/);
    assert.match(disposition, /filename\*=UTF-8''/);
    assert.equal(/[\r\n]/.test(disposition), false);

    const badBody = await requestJson(
      baseUrl,
      `/tabular-review/${ids.review}`,
      {
        method: "DELETE",
        body: JSON.stringify({ extra: true }),
      },
    );
    assert.equal(badBody.response.status, 422);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const enabledApp = express();
  enabledApp.use(express.json());
  enabledApp.use(
    createWorkspaceTabularV1Router(runtime, {
      requireAuthentication: false,
      capabilities: { generation: true, chat: true },
    }),
  );
  const enabledServer = http.createServer(enabledApp);
  await new Promise<void>((resolve) =>
    enabledServer.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = enabledServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const capabilities = await requestJson(
      baseUrl,
      "/tabular-review/capabilities",
    );
    assert.deepEqual(capabilities.body, { generation: true, chat: true });

    const retry = await requestJson(
      baseUrl,
      `/tabular-review/${ids.review}/regenerate-cell`,
      {
        method: "POST",
        body: JSON.stringify({ document_id: ids.docA, column_index: 0 }),
      },
    );
    assert.equal(retry.response.status, 200);
    assert.ok(calls.some((call) => call.startsWith("retry:")));

    const generate = await fetch(
      `${baseUrl}/tabular-review/${ids.review}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(generate.status, 409);
    assert.match(
      await generate.text(),
      /document-level authoritative extracted-text runtime/,
    );
    assert.doesNotMatch(
      generate.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );

    const chat = await fetch(`${baseUrl}/tabular-review/${ids.review}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /content_delta|ok|\\[DONE\\]/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      enabledServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function main() {
  try {
    await auditMigrationHardening();
    await auditNulRecoveryAndEncryptionGate();
    await auditNulRecoveryCollisionFailsBeforeWrite();
    await auditNulRecoveryValidatorMutationAndRollback();
    await auditEscapedEnumTargetEquivalencePlaintextSafe();
    auditTabularNulRequestBoundaries();
    await auditServiceRuntimeAndExport();
    await auditGenerationCapabilityFailClosed();
    await auditPartialV7MarkerFailClosed();
    await auditIncompleteMatrixFailClosed();
    await auditSoftDeletedReviewDocumentFailClosed();
    await auditUnicodeCodePointTextBounds();
    await auditCardinalityBoundsFailClosed();
    await auditCardinalityBoundaryPasses();
    await auditFrozenValidatorIsNotDecorative();
    auditV7ApplyPolicyIsBound();
    auditFrozenPersistenceImportGraph();
    await auditRouteModule();
    console.log("veraWorkspaceTabularMikeAudit passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sqlcipherBackupRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
