import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  READ_ONLY_SOURCE_RECEIPT_VERSION,
  READ_ONLY_SOURCE_SNAPSHOT_VERSION,
  readOnlySourceReceiptSchema,
  readOnlySourceSnapshotSchema,
} from "./agent-kernel/connectors/readOnlySourceContract";
import { COURTLISTENER_SOURCE_CONNECTOR_PIN } from "./agent-packs/research/courtListenerSourcePack";
import {
  ProviderSourceImportError,
  importProviderSourceSnapshot,
  type ProviderSourceImportRepository,
} from "./providerSourceImport";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const MATTER_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-08-08T02:00:00.000Z";

function snapshot(input: {
  body?: string;
  retrievedAt?: string;
  snapshotRef?: string;
  title?: string;
} = {}) {
  const body = input.body ?? "Fixed provider opinion text.";
  return readOnlySourceSnapshotSchema.parse({
    schema_version: READ_ONLY_SOURCE_SNAPSHOT_VERSION,
    snapshot_ref: input.snapshotRef ?? "courtlistener:cluster:123",
    provider_id: "courtlistener",
    external_id: "123",
    source_kind: "case_law",
    title: input.title ?? "Fixture v. Example",
    canonical_url: "https://www.courtlistener.com/opinion/123/fixture/",
    retrieved_at: input.retrievedAt ?? NOW,
    as_of_date: null,
    content_type: "text/plain",
    content_sha256: `sha256:${createHash("sha256")
      .update(body)
      .digest("hex")}`,
    source_body: body,
    metadata: { citation: "1 F.4th 2" },
  });
}

function receipt(source = snapshot(), requestRef = "read-123") {
  return readOnlySourceReceiptSchema.parse({
    schema_version: READ_ONLY_SOURCE_RECEIPT_VERSION,
    task_id: "00000000-0000-4000-8000-000000000003",
    step_id: "00000000-0000-4000-8000-000000000004",
    step_position: 0,
    attempt: 1,
    matter_id: MATTER_ID,
    source_version_ids: [],
    connector_pin: COURTLISTENER_SOURCE_CONNECTOR_PIN,
    authorization: {
      schema_version: READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
      connector_id: COURTLISTENER_SOURCE_CONNECTOR_PIN.connector_id,
      connection: "connected",
      subscription: "not_required",
      checked_at: NOW,
    },
    request_ref: requestRef,
    operation: "read_snapshot",
    egress_fields_sent: ["external_id", "jurisdiction", "as_of_date"],
    external_call_attempted: true,
    external_side_effect: "none",
    status: "ok",
    error_category: null,
    returned_discovery_refs: [],
    returned_snapshot_refs: [source.snapshot_ref],
    started_at: NOW,
    completed_at: NOW,
    idempotency_key: "source:fixture",
  });
}

function memoryDependencies() {
  const documents = new Map<string, any>();
  const versions = new Map<string, any>();
  const storage = new Map<string, Buffer>();
  let uploads = 0;
  const repository: ProviderSourceImportRepository = {
    async loadDocument(id) {
      return documents.get(id) ?? null;
    },
    async loadVersion(documentId, versionId) {
      const version = versions.get(versionId) ?? null;
      return version?.document_id === documentId ? version : null;
    },
    async latestVersionNumber(documentId) {
      return Math.max(
        0,
        ...[...versions.values()]
          .filter((version) => version.document_id === documentId)
          .map((version) => version.version_number),
      );
    },
    async insertDocument(value) {
      if (documents.has(value.id)) return "conflict";
      documents.set(value.id, {
        ...value,
        current_version_id: null,
      });
      return "inserted";
    },
    async insertVersion(value) {
      if (versions.has(value.id)) return "conflict";
      versions.set(value.id, { ...value, deleted_at: null });
      return "inserted";
    },
    async activateVersion(value) {
      const document = documents.get(value.documentId);
      if (
        !document ||
        document.user_id !== value.userId ||
        document.project_id !== value.matterId ||
        document.current_version_id !== value.expectedCurrentVersionId
      ) {
        return false;
      }
      document.current_version_id = value.targetVersionId;
      document.status = "ready";
      return true;
    },
  };
  return {
    documents,
    versions,
    storage,
    repository,
    get uploads() {
      return uploads;
    },
    upload: async (key: string, bytes: ArrayBuffer) => {
      uploads += 1;
      storage.set(key, Buffer.from(bytes));
    },
    download: async (key: string) => {
      const bytes = storage.get(key);
      if (!bytes) return null;
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
}

function importWith(
  state: ReturnType<typeof memoryDependencies>,
  source = snapshot(),
  requestRef = "read-123",
) {
  return importProviderSourceSnapshot({
    db: {} as never,
    userId: USER_ID,
    matterId: MATTER_ID,
    snapshot: source,
    connectorReceipt: receipt(source, requestRef),
    dependencies: {
      repository: state.repository,
      upload: state.upload,
      download: state.download,
      now: () => NOW,
    },
  });
}

test("imports and recovers one deterministic Matter DocumentVersion", async () => {
  const state = memoryDependencies();
  const first = await importWith(state);
  const replay = await importWith(state);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.document_id, first.document_id);
  assert.equal(replay.version_id, first.version_id);
  assert.equal(state.documents.size, 1);
  assert.equal(state.versions.size, 1);
  assert.equal(state.uploads, 1);
  const version = state.versions.get(first.version_id);
  assert.equal(version.source, "provider_import");
  assert.equal(version.provider_source.content_sha256, first.content_sha256);
  assert.doesNotMatch(
    JSON.stringify(version.provider_source),
    /Fixed provider opinion text/,
  );
});

test("a later read of unchanged bytes recovers the immutable Version", async () => {
  const state = memoryDependencies();
  const first = await importWith(state);
  const laterRead = snapshot({
    retrievedAt: "2026-08-08T03:00:00.000Z",
    snapshotRef: "courtlistener:cluster:123:later-read",
    title: "Fixture v. Example — updated provider title",
  });
  const recovered = await importWith(state, laterRead, "read-123-later");
  assert.equal(recovered.created, false);
  assert.equal(recovered.document_id, first.document_id);
  assert.equal(recovered.version_id, first.version_id);
  assert.equal(recovered.filename, first.filename);
  assert.equal(recovered.snapshot_ref, laterRead.snapshot_ref);
  assert.equal(state.documents.size, 1);
  assert.equal(state.versions.size, 1);
  assert.equal(state.uploads, 1);
  assert.equal(
    state.versions.get(first.version_id).provider_source.retrieved_at,
    NOW,
  );
});

test("a later snapshot becomes a new current Version without duplicating the Document", async () => {
  const state = memoryDependencies();
  const first = await importWith(state);
  const laterSource = snapshot({
    body: "Updated fixed provider opinion text.",
    retrievedAt: "2026-08-08T03:00:00.000Z",
  });
  const later = await importWith(state, laterSource);
  assert.equal(later.document_id, first.document_id);
  assert.notEqual(later.version_id, first.version_id);
  assert.equal(later.version_number, 2);
  assert.equal(state.documents.size, 1);
  assert.equal(state.versions.size, 2);
  assert.equal(
    state.documents.get(first.document_id).current_version_id,
    later.version_id,
  );
  await assert.rejects(
    () => importWith(state, snapshot()),
    (error) =>
      error instanceof ProviderSourceImportError &&
      error.code === "snapshot_stale",
  );
});

test("rejects an unbound receipt and stored-byte drift without widening scope", async () => {
  const state = memoryDependencies();
  const source = snapshot();
  await assert.rejects(
    () =>
      importProviderSourceSnapshot({
        db: {} as never,
        userId: USER_ID,
        matterId: MATTER_ID,
        snapshot: source,
        connectorReceipt: { ...receipt(source), matter_id: USER_ID },
        dependencies: {
          repository: state.repository,
          upload: state.upload,
          download: state.download,
        },
      }),
    (error) =>
      error instanceof ProviderSourceImportError &&
      error.code === "binding_invalid",
  );
  assert.equal(state.documents.size, 0);

  const imported = await importWith(state, source);
  const version = state.versions.get(imported.version_id);
  state.storage.set(version.storage_path, Buffer.from("changed"));
  await assert.rejects(
    () => importWith(state, source),
    (error) =>
      error instanceof ProviderSourceImportError &&
      error.code === "storage_conflict",
  );
});

test("provider source migrations are mirrored and converge the old patent value", async () => {
  const backend = await readFile(
    new URL("../../migrations/20260808_03_provider_source_import.sql", import.meta.url),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../supabase/migrations/20260808000003_provider_source_import.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(backend, /ADD COLUMN IF NOT EXISTS provider_source jsonb/);
  assert.match(
    backend,
    /SET source = 'provider_import'[\s\S]*WHERE source = 'patent_provider_import'/,
  );
  assert.match(backend, /'provider_import'::text/);
  assert.match(backend, /DROP CONSTRAINT[\s\S]*UPDATE[\s\S]*ADD CONSTRAINT/);

  const backendCommit = await readFile(
    new URL(
      "../../migrations/20260808_04_provider_source_import_commit.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabaseCommit = await readFile(
    new URL(
      "../../../supabase/migrations/20260808000004_provider_source_import_commit.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backendCommit, supabaseCommit);
  assert.match(backendCommit, /for update/i);
  assert.match(backendCommit, /coalesce\(max\(dv\.version_number\), 0\) \+ 1/);
  assert.match(
    backendCommit,
    /revoke execute[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(backendCommit, /grant execute[\s\S]*to service_role/i);
  assert.match(backendCommit, /jsonb_path_exists[\s\S]*source_body/);
  assert.match(
    backendCommit,
    /jsonb_build_object\([\s\S]*provider_id[\s\S]*content_sha256/,
  );
});
