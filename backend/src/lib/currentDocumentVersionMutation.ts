import { createHash } from "node:crypto";

import JSZip from "jszip";

import { docxToPdf } from "./convert";
import { createServerSupabase } from "./supabase";
import { downloadFile, uploadFile, versionStorageKey } from "./storage";
import { sameUuidIdentity } from "./uuidIdentity";

type Db = ReturnType<typeof createServerSupabase>;

type CurrentDocument = {
  id: string;
  user_id: string;
  project_id: string | null;
  current_version_id: string | null;
};

type CurrentDocumentVersion = {
  id: string;
  document_id: string;
  storage_path: string | null;
  filename: string | null;
  version_number: number | null;
  file_type: string | null;
  deleted_at: string | null;
};

type InsertVersion = {
  id: string;
  document_id: string;
  storage_path: string;
  pdf_storage_path: string | null;
  source: "user_upload" | "assistant_edit" | "generated";
  version_number: number;
  filename: string;
  file_type: "docx";
  size_bytes: number;
  page_count: null;
};

export type CurrentDocumentVersionRepository = {
  loadDocument(documentId: string): Promise<CurrentDocument | null>;
  loadVersion(
    documentId: string,
    versionId: string,
  ): Promise<CurrentDocumentVersion | null>;
  latestVersionNumber(documentId: string): Promise<number>;
  insertVersion(version: InsertVersion): Promise<"inserted" | "conflict">;
  activateVersion(input: {
    documentId: string;
    userId: string;
    projectId: string;
    expectedVersionId: string;
    targetVersionId: string;
    updatedAt: string;
  }): Promise<boolean>;
};

export type AppendCurrentDocxVersionDependencies = {
  repository?: CurrentDocumentVersionRepository;
  upload?: typeof uploadFile;
  download?: typeof downloadFile;
  convertDocxToPdf?: typeof docxToPdf;
  semanticDigest?: typeof semanticDocxDigest;
  now?: () => string;
};

export type AppendedCurrentDocxVersion = {
  document_id: string;
  version_id: string;
  version_number: number;
  current_version_id: string;
  filename: string;
  storage_path: string;
  created: boolean;
};

export class CurrentDocumentVersionMutationError extends Error {
  constructor(
    public readonly code:
      | "invalid_docx"
      | "document_not_found"
      | "version_unavailable"
      | "version_conflict"
      | "mutation_conflict",
    message: string,
  ) {
    super(message);
    this.name = "CurrentDocumentVersionMutationError";
  }
}

function normalizeDocxCoreProperties(value: Buffer) {
  return Buffer.from(
    value
      .toString("utf8")
      .replace(
        /(<dcterms:(created|modified)\b[^>]*>)[^<]*(<\/dcterms:\2>)/g,
        "$1__VERA_STABLE_TIMESTAMP__$3",
      ),
    "utf8",
  );
}

export async function semanticDocxDigest(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const paths = Object.keys(zip.files)
    .filter((path) => !zip.files[path].dir)
    .sort();
  if (!paths.includes("word/document.xml")) {
    throw new Error("A valid DOCX package is required");
  }
  const hash = createHash("sha256");
  for (const path of paths) {
    const entry = zip.file(path);
    if (!entry) continue;
    let content = Buffer.from(await entry.async("uint8array"));
    if (path === "docProps/core.xml") {
      content = normalizeDocxCoreProperties(content);
    }
    hash.update(String(Buffer.byteLength(path)));
    hash.update(":");
    hash.update(path);
    hash.update(":");
    hash.update(String(content.byteLength));
    hash.update(":");
    hash.update(content);
  }
  return hash.digest("hex");
}

export function durableCurrentVersionMutationId(scope: string) {
  const raw = createHash("sha256")
    .update(`vera-current-version-mutation-v1\0${scope}\0version`)
    .digest("hex")
    .slice(0, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function safeDocxFilename(value: string) {
  const normalized = value
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, "_")
    .replace(/[\\/]/g, "_");
  const filename = normalized || "Word document.docx";
  return /\.docx$/i.test(filename) ? filename : `${filename}.docx`;
}

function createRepository(db: Db): CurrentDocumentVersionRepository {
  return {
    async loadDocument(documentId) {
      const { data, error } = await db
        .from("documents")
        .select("id,user_id,project_id,current_version_id")
        .eq("id", documentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as CurrentDocument | null;
    },
    async loadVersion(documentId, versionId) {
      const { data, error } = await db
        .from("document_versions")
        .select(
          "id,document_id,storage_path,filename,version_number,file_type,deleted_at",
        )
        .eq("id", versionId)
        .eq("document_id", documentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as CurrentDocumentVersion | null;
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
    async insertVersion(version) {
      const { error } = await db.from("document_versions").insert(version);
      if (!error) return "inserted";
      if (error.code === "23505") return "conflict";
      throw new Error(error.message);
    },
    async activateVersion(input) {
      const { data, error } = await db
        .from("documents")
        .update({
          current_version_id: input.targetVersionId,
          status: "ready",
          updated_at: input.updatedAt,
        })
        .eq("id", input.documentId)
        .eq("user_id", input.userId)
        .eq("project_id", input.projectId)
        .eq("current_version_id", input.expectedVersionId)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },
  };
}

function assertDocumentOwnership(
  document: CurrentDocument | null,
  input: { documentId: string; userId: string; projectId: string },
) {
  if (
    !document ||
    !sameUuidIdentity(document.id, input.documentId) ||
    !sameUuidIdentity(document.user_id, input.userId) ||
    !sameUuidIdentity(document.project_id, input.projectId)
  ) {
    throw new CurrentDocumentVersionMutationError(
      "document_not_found",
      "The Word artifact does not belong to this Task Matter.",
    );
  }
}

function assertVersionAvailable(
  version: CurrentDocumentVersion | null,
  input: { documentId: string },
) {
  if (
    !version ||
    version.deleted_at ||
    !sameUuidIdentity(version.document_id, input.documentId) ||
    typeof version.storage_path !== "string" ||
    !version.storage_path.trim() ||
    String(version.file_type).toLowerCase() !== "docx"
  ) {
    throw new CurrentDocumentVersionMutationError(
      "version_unavailable",
      "The Word artifact Version is unavailable.",
    );
  }
  return version;
}

async function assertStoredBytesMatch(
  version: CurrentDocumentVersion,
  semanticHash: string,
  download: typeof downloadFile,
  digest: typeof semanticDocxDigest,
) {
  const bytes = await download(version.storage_path!);
  if (!bytes || (await digest(Buffer.from(bytes))) !== semanticHash) {
    throw new CurrentDocumentVersionMutationError(
      "mutation_conflict",
      "This Word mutation identity is already bound to different bytes.",
    );
  }
}

export async function appendCurrentDocxVersion(input: {
  db: Db;
  userId: string;
  projectId: string;
  documentId: string;
  baseVersionId: string;
  mutationKey: string;
  filename: string;
  buffer: Buffer;
  source?: "user_upload" | "assistant_edit" | "generated";
  beforeActivate?: () => Promise<void>;
  dependencies?: AppendCurrentDocxVersionDependencies;
}): Promise<AppendedCurrentDocxVersion> {
  if (
    !Buffer.isBuffer(input.buffer) ||
    input.buffer.byteLength === 0 ||
    !input.filename.toLowerCase().endsWith(".docx") ||
    !input.mutationKey.trim() ||
    input.mutationKey.length > 1000
  ) {
    throw new CurrentDocumentVersionMutationError(
      "invalid_docx",
      "A non-empty DOCX file and bounded mutation identity are required.",
    );
  }
  const dependencies = input.dependencies ?? {};
  const repository = dependencies.repository ?? createRepository(input.db);
  const upload = dependencies.upload ?? uploadFile;
  const download = dependencies.download ?? downloadFile;
  const convertDocxToPdf = dependencies.convertDocxToPdf ?? docxToPdf;
  const digest = dependencies.semanticDigest ?? semanticDocxDigest;
  const now = dependencies.now ?? (() => new Date().toISOString());
  let semanticHash: string;
  try {
    semanticHash = await digest(input.buffer);
  } catch {
    throw new CurrentDocumentVersionMutationError(
      "invalid_docx",
      "A valid DOCX package is required.",
    );
  }
  const versionId = durableCurrentVersionMutationId(input.mutationKey);
  const filename = safeDocxFilename(input.filename);
  let document = await repository.loadDocument(input.documentId);
  assertDocumentOwnership(document, input);
  const baseVersion = assertVersionAvailable(
    await repository.loadVersion(input.documentId, input.baseVersionId),
    input,
  );
  if (!sameUuidIdentity(baseVersion.id, input.baseVersionId)) {
    throw new CurrentDocumentVersionMutationError(
      "version_unavailable",
      "The Word artifact base Version is unavailable.",
    );
  }
  const existing = await repository.loadVersion(input.documentId, versionId);
  if (
    !sameUuidIdentity(document!.current_version_id, input.baseVersionId) &&
    !sameUuidIdentity(document!.current_version_id, versionId)
  ) {
    throw new CurrentDocumentVersionMutationError(
      "version_conflict",
      "The Word artifact has a newer current Version. Reopen it from Vera.",
    );
  }
  if (existing) {
    const target = assertVersionAvailable(existing, input);
    await assertStoredBytesMatch(target, semanticHash, download, digest);
    if (sameUuidIdentity(document!.current_version_id, versionId)) {
      return {
        document_id: input.documentId,
        version_id: target.id,
        version_number: target.version_number ?? 1,
        current_version_id: target.id,
        filename: target.filename ?? filename,
        storage_path: target.storage_path!,
        created: false,
      };
    }
    await input.beforeActivate?.();
    const activated = await repository.activateVersion({
      documentId: input.documentId,
      userId: input.userId,
      projectId: input.projectId,
      expectedVersionId: input.baseVersionId,
      targetVersionId: target.id,
      updatedAt: now(),
    });
    document = await repository.loadDocument(input.documentId);
    if (
      !activated &&
      !sameUuidIdentity(document?.current_version_id, target.id)
    ) {
      throw new CurrentDocumentVersionMutationError(
        "version_conflict",
        "The Word artifact changed while its Version was being activated.",
      );
    }
    return {
      document_id: input.documentId,
      version_id: target.id,
      version_number: target.version_number ?? 1,
      current_version_id: target.id,
      filename: target.filename ?? filename,
      storage_path: target.storage_path!,
      created: false,
    };
  }

  const versionNumber =
    (await repository.latestVersionNumber(input.documentId)) + 1;
  const storagePath = versionStorageKey(
    input.userId,
    input.documentId,
    `${versionId}-${semanticHash.slice(0, 16)}`,
    filename,
  );
  await upload(
    storagePath,
    input.buffer.buffer.slice(
      input.buffer.byteOffset,
      input.buffer.byteOffset + input.buffer.byteLength,
    ) as ArrayBuffer,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  let pdfStoragePath: string | null = null;
  try {
    const pdf = await convertDocxToPdf(input.buffer);
    pdfStoragePath = versionStorageKey(
      input.userId,
      input.documentId,
      `${versionId}-${semanticHash.slice(0, 16)}-rendition`,
      filename.replace(/\.docx$/i, ".pdf"),
    );
    await upload(
      pdfStoragePath,
      pdf.buffer.slice(
        pdf.byteOffset,
        pdf.byteOffset + pdf.byteLength,
      ) as ArrayBuffer,
      "application/pdf",
    );
  } catch {
    pdfStoragePath = null;
  }
  const insert = await repository.insertVersion({
    id: versionId,
    document_id: input.documentId,
    storage_path: storagePath,
    pdf_storage_path: pdfStoragePath,
    source: input.source ?? "user_upload",
    version_number: versionNumber,
    filename,
    file_type: "docx",
    size_bytes: input.buffer.byteLength,
    page_count: null,
  });
  const target = assertVersionAvailable(
    await repository.loadVersion(input.documentId, versionId),
    input,
  );
  await assertStoredBytesMatch(target, semanticHash, download, digest);
  document = await repository.loadDocument(input.documentId);
  assertDocumentOwnership(document, input);
  if (
    !sameUuidIdentity(document!.current_version_id, input.baseVersionId) &&
    !sameUuidIdentity(document!.current_version_id, versionId)
  ) {
    throw new CurrentDocumentVersionMutationError(
      "version_conflict",
      "The Word artifact changed before its new Version could be activated.",
    );
  }
  if (!sameUuidIdentity(document!.current_version_id, versionId)) {
    await input.beforeActivate?.();
    const activated = await repository.activateVersion({
      documentId: input.documentId,
      userId: input.userId,
      projectId: input.projectId,
      expectedVersionId: input.baseVersionId,
      targetVersionId: target.id,
      updatedAt: now(),
    });
    document = await repository.loadDocument(input.documentId);
    if (
      !activated &&
      !sameUuidIdentity(document?.current_version_id, target.id)
    ) {
      throw new CurrentDocumentVersionMutationError(
        "version_conflict",
        "The Word artifact changed while its new Version was being activated.",
      );
    }
  }
  return {
    document_id: input.documentId,
    version_id: target.id,
    version_number: target.version_number ?? versionNumber,
    current_version_id: target.id,
    filename: target.filename ?? filename,
    storage_path: target.storage_path!,
    created: insert === "inserted",
  };
}
