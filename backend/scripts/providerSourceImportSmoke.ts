import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import {
  READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION,
  READ_ONLY_SOURCE_RECEIPT_VERSION,
  READ_ONLY_SOURCE_SNAPSHOT_VERSION,
  readOnlySourceConnectorPinSchema,
  readOnlySourceReceiptSchema,
  readOnlySourceSnapshotSchema,
} from "../src/lib/agent-kernel/connectors/readOnlySourceContract";
import { importProviderSourceSnapshot } from "../src/lib/providerSourceImport";
import { createServerSupabase } from "../src/lib/supabase";
import { deleteFile, downloadFile } from "../src/lib/storage";

const userId = process.env.SMOKE_USER_ID?.trim();
const matterId = process.env.SMOKE_MATTER_ID?.trim();
if (!userId || !matterId) {
  throw new Error("SMOKE_USER_ID and SMOKE_MATTER_ID are required");
}

const now = new Date().toISOString();
const runRef = `provider-import-smoke-${process.pid}-${Date.now()}`;
const body = `Fixed provider source smoke body ${runRef}`;
const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
const schemaDigest = `sha256:${"1".repeat(64)}`;
const pin = readOnlySourceConnectorPinSchema.parse({
  schema_version: READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION,
  connector_id: "fixture.provider-source-import",
  connector_version: "1.0.0",
  provider_id: "fixture-provider",
  provider_version: "1.0.0",
  adapter_id: "fixture.provider-source-import",
  adapter_version: "1.0.0",
  binding: {
    kind: "fixture",
    operation_id: "fixture.read",
    operation_version: "1.0.0",
    input_schema_version: "fixture_input_v1",
    input_schema_digest: schemaDigest,
    output_schema_version: "fixture_output_v1",
    output_schema_digest: schemaDigest,
  },
  allowed_hosts: [],
  allowed_source_hosts: ["source.fixture.invalid"],
  allowed_jurisdictions: ["US"],
  allowed_operations: ["read_snapshot"],
  allowed_egress_fields: [],
  limits: {
    timeout_ms: 1_000,
    authorization_max_age_ms: 60_000,
    maximum_pages: 1,
    maximum_items_per_page: 1,
    maximum_query_chars: 100,
    maximum_snapshot_chars: 10_000,
  },
  fixed: true,
  read_only: true,
});
const snapshot = readOnlySourceSnapshotSchema.parse({
  schema_version: READ_ONLY_SOURCE_SNAPSHOT_VERSION,
  snapshot_ref: runRef,
  provider_id: pin.provider_id,
  external_id: runRef,
  source_kind: "fixture_authority",
  title: "Provider source import smoke",
  canonical_url: `https://source.fixture.invalid/${runRef}`,
  retrieved_at: now,
  as_of_date: null,
  content_type: "text/plain",
  content_sha256: digest,
  source_body: body,
  metadata: { fixture: true },
});
const receipt = readOnlySourceReceiptSchema.parse({
  schema_version: READ_ONLY_SOURCE_RECEIPT_VERSION,
  task_id: "provider-source-smoke-task",
  step_id: "provider-source-smoke-step",
  step_position: 0,
  attempt: 1,
  matter_id: matterId,
  source_version_ids: [],
  connector_pin: pin,
  authorization: {
    schema_version: READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
    connector_id: pin.connector_id,
    connection: "connected",
    subscription: "not_required",
    checked_at: now,
  },
  request_ref: runRef,
  operation: "read_snapshot",
  egress_fields_sent: [],
  external_call_attempted: false,
  external_side_effect: "none",
  status: "ok",
  error_category: null,
  returned_discovery_refs: [],
  returned_snapshot_refs: [snapshot.snapshot_ref],
  started_at: now,
  completed_at: now,
  idempotency_key: `source:${runRef}`,
});

async function main() {
  const db = createServerSupabase();
  let documentId: string | null = null;
  let concurrentDocumentId: string | null = null;
  const storagePaths: string[] = [];
  try {
  const first = await importProviderSourceSnapshot({
    db,
    userId,
    matterId,
    snapshot,
    connectorReceipt: receipt,
  });
  documentId = first.document_id;
  const replay = await importProviderSourceSnapshot({
    db,
    userId,
    matterId,
    snapshot,
    connectorReceipt: receipt,
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.document_id, first.document_id);
  assert.equal(replay.version_id, first.version_id);
  const laterReadAt = new Date(Date.parse(now) + 1_000).toISOString();
  const laterSnapshot = readOnlySourceSnapshotSchema.parse({
    ...snapshot,
    snapshot_ref: `${runRef}-later-read`,
    title: "Provider source import smoke — later provider title",
    retrieved_at: laterReadAt,
  });
  const laterReceipt = readOnlySourceReceiptSchema.parse({
    ...receipt,
    request_ref: `${runRef}-later-read`,
    returned_snapshot_refs: [laterSnapshot.snapshot_ref],
    started_at: laterReadAt,
    completed_at: laterReadAt,
    idempotency_key: `source:${runRef}:later-read`,
  });
  const unchangedRead = await importProviderSourceSnapshot({
    db,
    userId,
    matterId,
    snapshot: laterSnapshot,
    connectorReceipt: laterReceipt,
  });
  assert.equal(unchangedRead.created, false);
  assert.equal(unchangedRead.document_id, first.document_id);
  assert.equal(unchangedRead.version_id, first.version_id);
  assert.equal(unchangedRead.filename, first.filename);

  const { data: document, error: documentError } = await db
    .from("documents")
    .select("id,user_id,project_id,current_version_id,status")
    .eq("id", first.document_id)
    .single();
  if (documentError) throw new Error(documentError.message);
  const { data: version, error: versionError } = await db
    .from("document_versions")
    .select("id,document_id,storage_path,source,provider_source")
    .eq("id", first.version_id)
    .single();
  if (versionError) throw new Error(versionError.message);
  assert.equal(document.user_id, userId);
  assert.equal(document.project_id, matterId);
  assert.equal(document.current_version_id, first.version_id);
  assert.equal(document.status, "ready");
  assert.equal(version.document_id, first.document_id);
  assert.equal(version.source, "provider_import");
  assert.equal(version.provider_source.content_sha256, digest);
  assert.equal(Object.hasOwn(version.provider_source, "source_body"), false);
  assert.equal(typeof version.storage_path, "string");
  storagePaths.push(version.storage_path);
  const stored = await downloadFile(version.storage_path);
  assert.equal(Buffer.from(stored ?? new ArrayBuffer(0)).toString("utf8"), body);

  const { data: sameVersionRecovery, error: sameVersionRecoveryError } =
    await db.rpc("commit_provider_source_version_v1", {
      p_document_id: first.document_id,
      p_version_id: first.version_id,
      p_user_id: userId,
      p_matter_id: matterId,
      p_expected_current_version_id: first.version_id,
      p_storage_path: `${version.storage_path}-unused-racing-upload`,
      p_filename: "unused-racing-title.txt",
      p_file_type: "txt",
      p_size_bytes: Buffer.byteLength(body),
      p_provider_source: {
        ...version.provider_source,
        request_ref: `${runRef}-racing-request`,
        snapshot_ref: `${runRef}-racing-snapshot`,
        title: "Racing provider title",
        retrieved_at: laterReadAt,
      },
      p_updated_at: laterReadAt,
    });
  if (sameVersionRecoveryError) {
    throw new Error(sameVersionRecoveryError.message);
  }
  assert.equal(sameVersionRecovery?.[0]?.outcome, "recovered");
  assert.equal(sameVersionRecovery?.[0]?.current_version_id, first.version_id);

  concurrentDocumentId = randomUUID();
  const { error: concurrentDocumentError } = await db.from("documents").insert({
    id: concurrentDocumentId,
    user_id: userId,
    project_id: matterId,
    status: "processing",
  });
  if (concurrentDocumentError) throw new Error(concurrentDocumentError.message);
  const concurrentVersionIds = [randomUUID(), randomUUID()];
  const providerSource = (index: number) => ({
    schema_version: "provider_source_provenance_v1",
    connector_id: pin.connector_id,
    connector_version: pin.connector_version,
    provider_id: pin.provider_id,
    provider_version: pin.provider_version,
    request_ref: `${runRef}-${index}`,
    snapshot_ref: `${runRef}-${index}`,
    external_id: runRef,
    source_kind: "fixture_authority",
    title: "Concurrent provider source smoke",
    canonical_url: `https://source.fixture.invalid/${runRef}/${index}`,
    retrieved_at: now,
    as_of_date: null,
    content_sha256: `sha256:${String(index + 2).repeat(64)}`,
    metadata: { fixture: true },
  });
  const concurrent = await Promise.all(
    concurrentVersionIds.map((versionId, index) =>
      db.rpc("commit_provider_source_version_v1", {
        p_document_id: concurrentDocumentId,
        p_version_id: versionId,
        p_user_id: userId,
        p_matter_id: matterId,
        p_expected_current_version_id: null,
        p_storage_path: `documents/${userId}/${concurrentDocumentId}/${versionId}.txt`,
        p_filename: `concurrent-${index}.txt`,
        p_file_type: "txt",
        p_size_bytes: 10,
        p_provider_source: providerSource(index),
        p_updated_at: now,
      }),
    ),
  );
  for (const call of concurrent) {
    if (call.error) throw new Error(call.error.message);
  }
  const concurrentOutcomes = concurrent
    .map((call) => call.data?.[0]?.outcome)
    .sort();
  assert.deepEqual(concurrentOutcomes, ["committed", "current_conflict"]);
  const { data: concurrentVersions, error: concurrentVersionsError } = await db
    .from("document_versions")
    .select("id,version_number")
    .eq("document_id", concurrentDocumentId);
  if (concurrentVersionsError) throw new Error(concurrentVersionsError.message);
  assert.equal(concurrentVersions.length, 1);
  assert.equal(concurrentVersions[0]?.version_number, 1);

  console.log(
    JSON.stringify({
      ok: true,
      suite: "provider-source-import-db-smoke-v1",
      created: first.created,
      replay_created: replay.created,
      unchanged_read_created: unchangedRead.created,
      same_version_race_outcome: sameVersionRecovery?.[0]?.outcome,
      source: version.source,
      concurrent_outcomes: concurrentOutcomes,
    }),
  );
  } finally {
    if (documentId) {
      const { data: versions } = await db
        .from("document_versions")
        .select("storage_path,pdf_storage_path")
        .eq("document_id", documentId);
      for (const version of versions ?? []) {
        if (typeof version.storage_path === "string") {
          storagePaths.push(version.storage_path);
        }
        if (typeof version.pdf_storage_path === "string") {
          storagePaths.push(version.pdf_storage_path);
        }
      }
      await db.from("documents").delete().eq("id", documentId);
    }
    if (concurrentDocumentId) {
      await db.from("documents").delete().eq("id", concurrentDocumentId);
    }
    for (const path of new Set(storagePaths)) {
      await deleteFile(path).catch(() => undefined);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
