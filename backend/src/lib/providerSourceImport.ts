import { createHash } from "node:crypto";

import { z } from "zod";

import {
  validateReadOnlySourceReceipt,
  validateReadOnlySourceSnapshot,
  type ReadOnlySourceReceiptV1,
  type ReadOnlySourceSnapshotV1,
} from "./agent-kernel/connectors/readOnlySourceContract";
import { canonicalEffectInput } from "./agent-kernel/effects/stepEffect";
import { createServerSupabase } from "./supabase";
import { downloadFile, uploadFile, versionStorageKey } from "./storage";
import { sameUuidIdentity } from "./uuidIdentity";

export type ProviderSourceImportDb = ReturnType<typeof createServerSupabase>;
type Db = ProviderSourceImportDb;
const PROVIDER_SOURCE_IMPORT_RECEIPT_VERSION =
  "provider_source_import_receipt_v1" as const;

type ProviderSourceDocumentRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  current_version_id: string | null;
  status: string | null;
};

type ProviderSourceVersionRow = {
  id: string;
  document_id: string;
  storage_path: string | null;
  source: string;
  version_number: number | null;
  filename: string | null;
  file_type: string | null;
  size_bytes: number | null;
  deleted_at: string | null;
  provider_source: unknown;
};

const providerSourceProvenanceSchema = z
  .object({
    schema_version: z.literal("provider_source_provenance_v1"),
    connector_id: z.string().min(1),
    connector_version: z.string().min(1),
    provider_id: z.string().min(1),
    provider_version: z.string().min(1),
    request_ref: z.string().min(1),
    snapshot_ref: z.string().min(1),
    external_id: z.string().min(1),
    source_kind: z.string().min(1),
    title: z.string().min(1),
    canonical_url: z.string().url(),
    retrieved_at: z.string().datetime({ offset: true }),
    as_of_date: z.string().date().nullable(),
    content_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ProviderSourceProvenanceV1 = z.infer<
  typeof providerSourceProvenanceSchema
>;

type InsertProviderSourceVersion = {
  id: string;
  document_id: string;
  storage_path: string;
  pdf_storage_path: null;
  source: "provider_import";
  version_number: number;
  filename: string;
  file_type: "txt" | "json" | "xml";
  size_bytes: number;
  page_count: null;
  provider_source: ProviderSourceProvenanceV1;
};

export type ProviderSourceImportRepository = {
  loadDocument(documentId: string): Promise<ProviderSourceDocumentRow | null>;
  loadVersion(
    documentId: string,
    versionId: string,
  ): Promise<ProviderSourceVersionRow | null>;
  latestVersionNumber(documentId: string): Promise<number>;
  insertDocument(input: {
    id: string;
    user_id: string;
    project_id: string;
    status: "processing";
  }): Promise<"inserted" | "conflict">;
  insertVersion(
    input: InsertProviderSourceVersion,
  ): Promise<"inserted" | "conflict">;
  activateVersion(input: {
    documentId: string;
    userId: string;
    matterId: string;
    expectedCurrentVersionId: string | null;
    targetVersionId: string;
    updatedAt: string;
  }): Promise<boolean>;
  commitVersionAtomically?(input: {
    documentId: string;
    versionId: string;
    userId: string;
    matterId: string;
    expectedCurrentVersionId: string | null;
    storagePath: string;
    filename: string;
    fileType: "txt" | "json" | "xml";
    sizeBytes: number;
    providerSource: ProviderSourceProvenanceV1;
    updatedAt: string;
  }): Promise<{
    outcome: "committed" | "recovered";
    versionNumber: number;
    currentVersionId: string;
  }>;
};

export type ProviderSourceImportDependencies = {
  repository?: ProviderSourceImportRepository;
  upload?: typeof uploadFile;
  download?: typeof downloadFile;
  now?: () => string;
};

export type ProviderSourceImportReceiptV1 = {
  schema_version: typeof PROVIDER_SOURCE_IMPORT_RECEIPT_VERSION;
  provider_id: string;
  external_id: string;
  snapshot_ref: string;
  content_sha256: string;
  document_id: string;
  version_id: string;
  version_number: number;
  filename: string;
  created: boolean;
  current_version_id: string;
};

export class ProviderSourceImportError extends Error {
  constructor(
    readonly code:
      | "binding_invalid"
      | "content_invalid"
      | "document_conflict"
      | "snapshot_stale"
      | "storage_conflict"
      | "version_conflict",
  ) {
    super(`provider_source_import_${code}`);
    this.name = "ProviderSourceImportError";
  }
}

function durableUuid(scope: string, kind: string) {
  const hex = createHash("sha256")
    .update(`vera-provider-source-v1\0${scope}\0${kind}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function extension(contentType: ReadOnlySourceSnapshotV1["content_type"]) {
  switch (contentType) {
    case "application/json":
      return "json" as const;
    case "application/xml":
      return "xml" as const;
    case "text/plain":
      return "txt" as const;
  }
}

function storageContentType(
  contentType: ReadOnlySourceSnapshotV1["content_type"],
) {
  return contentType === "text/plain"
    ? "text/plain; charset=utf-8"
    : `${contentType}; charset=utf-8`;
}

function safeFilename(snapshot: ReadOnlySourceSnapshotV1) {
  const suffix = extension(snapshot.content_type);
  const title = snapshot.title
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F/\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const identity = createHash("sha256")
    .update(`${snapshot.provider_id}\0${snapshot.external_id}`)
    .digest("hex")
    .slice(0, 12);
  return `${title || "Provider source"} - ${identity}.${suffix}`;
}

function createRepository(db: Db): ProviderSourceImportRepository {
  return {
    async loadDocument(documentId) {
      const { data, error } = await db
        .from("documents")
        .select("id,user_id,project_id,current_version_id,status")
        .eq("id", documentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as ProviderSourceDocumentRow | null;
    },
    async loadVersion(documentId, versionId) {
      const { data, error } = await db
        .from("document_versions")
        .select(
          "id,document_id,storage_path,source,version_number,filename,file_type,size_bytes,deleted_at,provider_source",
        )
        .eq("id", versionId)
        .eq("document_id", documentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as ProviderSourceVersionRow | null;
    },
    async latestVersionNumber(documentId) {
      const { data, error } = await db
        .from("document_versions")
        .select("version_number")
        .eq("document_id", documentId)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Math.max(0, Number(data?.version_number) || 0);
    },
    async insertDocument(value) {
      const { error } = await db.from("documents").insert(value);
      if (!error) return "inserted";
      if (error.code === "23505") return "conflict";
      throw new Error(error.message);
    },
    async insertVersion(value) {
      const { error } = await db.from("document_versions").insert(value);
      if (!error) return "inserted";
      if (error.code === "23505") return "conflict";
      throw new Error(error.message);
    },
    async activateVersion(value) {
      let query = db
        .from("documents")
        .update({
          current_version_id: value.targetVersionId,
          status: "ready",
          updated_at: value.updatedAt,
        })
        .eq("id", value.documentId)
        .eq("user_id", value.userId)
        .eq("project_id", value.matterId);
      query = value.expectedCurrentVersionId
        ? query.eq("current_version_id", value.expectedCurrentVersionId)
        : query.is("current_version_id", null);
      const { data, error } = await query.select("id").maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },
    async commitVersionAtomically(value) {
      const { data, error } = await db.rpc(
        "commit_provider_source_version_v1",
        {
          p_document_id: value.documentId,
          p_version_id: value.versionId,
          p_user_id: value.userId,
          p_matter_id: value.matterId,
          p_expected_current_version_id: value.expectedCurrentVersionId,
          p_storage_path: value.storagePath,
          p_filename: value.filename,
          p_file_type: value.fileType,
          p_size_bytes: value.sizeBytes,
          p_provider_source: value.providerSource,
          p_updated_at: value.updatedAt,
        },
      );
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as Record<
        string,
        unknown
      > | null;
      if (
        !row ||
        (row.outcome !== "committed" && row.outcome !== "recovered") ||
        !Number.isInteger(row.version_number) ||
        Number(row.version_number) < 1 ||
        typeof row.current_version_id !== "string" ||
        !sameUuidIdentity(row.current_version_id, value.versionId)
      ) {
        throw new ProviderSourceImportError(
          row?.outcome === "scope_conflict"
            ? "document_conflict"
            : "version_conflict",
        );
      }
      return {
        outcome: row.outcome,
        versionNumber: Number(row.version_number),
        currentVersionId: row.current_version_id,
      };
    },
  };
}

function buildProvenance(
  receipt: ReadOnlySourceReceiptV1,
  snapshot: ReadOnlySourceSnapshotV1,
): ProviderSourceProvenanceV1 {
  return {
    schema_version: "provider_source_provenance_v1",
    connector_id: receipt.connector_pin.connector_id,
    connector_version: receipt.connector_pin.connector_version,
    provider_id: snapshot.provider_id,
    provider_version: receipt.connector_pin.provider_version,
    request_ref: receipt.request_ref,
    snapshot_ref: snapshot.snapshot_ref,
    external_id: snapshot.external_id,
    source_kind: snapshot.source_kind,
    title: snapshot.title,
    canonical_url: snapshot.canonical_url,
    retrieved_at: snapshot.retrieved_at,
    as_of_date: snapshot.as_of_date,
    content_sha256: snapshot.content_sha256,
    metadata: snapshot.metadata,
  };
}

function assertDocument(
  document: ProviderSourceDocumentRow | null,
  input: { documentId: string; userId: string; matterId: string },
) {
  if (
    !document ||
    !sameUuidIdentity(document.id, input.documentId) ||
    !sameUuidIdentity(document.user_id, input.userId) ||
    !sameUuidIdentity(document.project_id, input.matterId)
  ) {
    throw new ProviderSourceImportError("document_conflict");
  }
  return document;
}

function stableProvenance(value: ProviderSourceProvenanceV1) {
  return {
    provider_id: value.provider_id,
    external_id: value.external_id,
    source_kind: value.source_kind,
    content_sha256: value.content_sha256,
  };
}

function assertCompatibleVersion(input: {
  version: ProviderSourceVersionRow | null;
  documentId: string;
  storagePath: string;
  fileType: string;
  byteLength: number;
  provenance: ProviderSourceProvenanceV1;
}) {
  const version = input.version;
  const parsedProvenance = providerSourceProvenanceSchema.safeParse(
    version?.provider_source,
  );
  if (
    !version ||
    version.deleted_at ||
    !sameUuidIdentity(version.document_id, input.documentId) ||
    version.storage_path !== input.storagePath ||
    version.source !== "provider_import" ||
    !Number.isInteger(version.version_number) ||
    Number(version.version_number) < 1 ||
    !version.filename ||
    version.file_type !== input.fileType ||
    version.size_bytes !== input.byteLength ||
    !parsedProvenance.success ||
    canonicalEffectInput(stableProvenance(parsedProvenance.data)) !==
      canonicalEffectInput(stableProvenance(input.provenance))
  ) {
    throw new ProviderSourceImportError("version_conflict");
  }
  return { version, provenance: parsedProvenance.data };
}

function existingProvenance(version: ProviderSourceVersionRow | null) {
  if (
    !version ||
    version.source !== "provider_import" ||
    !version.provider_source ||
    typeof version.provider_source !== "object" ||
    Array.isArray(version.provider_source)
  ) {
    throw new ProviderSourceImportError("version_conflict");
  }
  return version.provider_source as Partial<ProviderSourceProvenanceV1>;
}

async function assertStoredContent(
  storagePath: string,
  digest: string,
  download: typeof downloadFile,
) {
  const bytes = await download(storagePath);
  if (
    !bytes ||
    `sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}` !==
      digest
  ) {
    throw new ProviderSourceImportError("storage_conflict");
  }
}

export async function importProviderSourceSnapshot(input: {
  db: Db;
  userId: string;
  matterId: string;
  snapshot: unknown;
  connectorReceipt: unknown;
  dependencies?: ProviderSourceImportDependencies;
}): Promise<ProviderSourceImportReceiptV1> {
  z.string().uuid().parse(input.userId);
  z.string().uuid().parse(input.matterId);
  const snapshot = validateReadOnlySourceSnapshot(input.snapshot);
  const connectorReceipt = validateReadOnlySourceReceipt(
    input.connectorReceipt,
  );
  if (
    connectorReceipt.status !== "ok" ||
    connectorReceipt.operation !== "read_snapshot" ||
    !sameUuidIdentity(connectorReceipt.matter_id, input.matterId) ||
    connectorReceipt.connector_pin.provider_id !== snapshot.provider_id ||
    !connectorReceipt.returned_snapshot_refs.includes(snapshot.snapshot_ref)
  ) {
    throw new ProviderSourceImportError("binding_invalid");
  }

  const bytes = Buffer.from(snapshot.source_body, "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== snapshot.content_sha256) {
    throw new ProviderSourceImportError("content_invalid");
  }

  const dependencies = input.dependencies ?? {};
  const repository = dependencies.repository ?? createRepository(input.db);
  const upload = dependencies.upload ?? uploadFile;
  const download = dependencies.download ?? downloadFile;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const scope = `${input.userId}\0${input.matterId}\0${snapshot.provider_id}\0${snapshot.external_id}`;
  const documentId = durableUuid(scope, "document");
  const versionId = durableUuid(
    `${scope}\0${snapshot.content_type}\0${snapshot.content_sha256}`,
    "version",
  );
  let filename = safeFilename(snapshot);
  const fileType = extension(snapshot.content_type);
  let storagePath = versionStorageKey(
    input.userId,
    documentId,
    versionId,
    `source.${fileType}`,
  );
  let provenance = buildProvenance(connectorReceipt, snapshot);

  let document = await repository.loadDocument(documentId);
  if (!document) {
    await repository.insertDocument({
      id: documentId,
      user_id: input.userId,
      project_id: input.matterId,
      status: "processing",
    });
    document = await repository.loadDocument(documentId);
  }
  document = assertDocument(document, {
    documentId,
    userId: input.userId,
    matterId: input.matterId,
  });

  if (
    document.current_version_id &&
    !sameUuidIdentity(document.current_version_id, versionId)
  ) {
    const current = await repository.loadVersion(
      documentId,
      document.current_version_id,
    );
    const currentSource = existingProvenance(current);
    if (
      currentSource.provider_id !== snapshot.provider_id ||
      currentSource.external_id !== snapshot.external_id ||
      typeof currentSource.retrieved_at !== "string"
    ) {
      throw new ProviderSourceImportError("version_conflict");
    }
    const currentTime = Date.parse(currentSource.retrieved_at);
    const incomingTime = Date.parse(snapshot.retrieved_at);
    if (
      !Number.isFinite(currentTime) ||
      incomingTime < currentTime ||
      (incomingTime === currentTime &&
        currentSource.content_sha256 !== snapshot.content_sha256)
    ) {
      throw new ProviderSourceImportError("snapshot_stale");
    }
  }

  let version = await repository.loadVersion(documentId, versionId);
  let created = false;
  if (version) {
    const compatible = assertCompatibleVersion({
      version,
      documentId,
      storagePath,
      fileType,
      byteLength: bytes.byteLength,
      provenance,
    });
    version = compatible.version;
    filename = version.filename!;
    storagePath = version.storage_path!;
    provenance = compatible.provenance;
    await assertStoredContent(storagePath, digest, download);
  } else {
    await upload(
      storagePath,
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      storageContentType(snapshot.content_type),
    );
    await assertStoredContent(storagePath, digest, download);
    if (!repository.commitVersionAtomically) {
      const result = await repository.insertVersion({
        id: versionId,
        document_id: documentId,
        storage_path: storagePath,
        pdf_storage_path: null,
        source: "provider_import",
        version_number: (await repository.latestVersionNumber(documentId)) + 1,
        filename,
        file_type: fileType,
        size_bytes: bytes.byteLength,
        page_count: null,
        provider_source: provenance,
      });
      created = result === "inserted";
      version = await repository.loadVersion(documentId, versionId);
    }
  }
  if (repository.commitVersionAtomically) {
    const committed = await repository.commitVersionAtomically({
      documentId,
      versionId,
      userId: input.userId,
      matterId: input.matterId,
      expectedCurrentVersionId: document.current_version_id,
      storagePath,
      filename,
      fileType,
      sizeBytes: bytes.byteLength,
      providerSource: provenance,
      updatedAt: now(),
    });
    created = committed.outcome === "committed";
    version = await repository.loadVersion(documentId, versionId);
    const compatible = assertCompatibleVersion({
      version,
      documentId,
      storagePath,
      fileType,
      byteLength: bytes.byteLength,
      provenance,
    });
    version = compatible.version;
    filename = version.filename!;
    storagePath = version.storage_path!;
    provenance = compatible.provenance;
    document = assertDocument(await repository.loadDocument(documentId), {
      documentId,
      userId: input.userId,
      matterId: input.matterId,
    });
  }
  version = assertCompatibleVersion({
    version,
    documentId,
    storagePath,
    fileType,
    byteLength: bytes.byteLength,
    provenance,
  }).version;
  await assertStoredContent(storagePath, digest, download);

  if (
    !repository.commitVersionAtomically &&
    !sameUuidIdentity(document.current_version_id, versionId)
  ) {
    const activated = await repository.activateVersion({
      documentId,
      userId: input.userId,
      matterId: input.matterId,
      expectedCurrentVersionId: document.current_version_id,
      targetVersionId: versionId,
      updatedAt: now(),
    });
    document = await repository.loadDocument(documentId);
    if (!activated && !sameUuidIdentity(document?.current_version_id, versionId)) {
      throw new ProviderSourceImportError("version_conflict");
    }
  }
  document = assertDocument(
    await repository.loadDocument(documentId),
    { documentId, userId: input.userId, matterId: input.matterId },
  );
  if (
    !sameUuidIdentity(document.current_version_id, versionId) ||
    document.status !== "ready"
  ) {
    throw new ProviderSourceImportError("version_conflict");
  }

  return {
    schema_version: PROVIDER_SOURCE_IMPORT_RECEIPT_VERSION,
    provider_id: snapshot.provider_id,
    external_id: snapshot.external_id,
    snapshot_ref: snapshot.snapshot_ref,
    content_sha256: snapshot.content_sha256,
    document_id: documentId,
    version_id: versionId,
    version_number: version.version_number ?? 1,
    filename,
    created,
    current_version_id: versionId,
  };
}
