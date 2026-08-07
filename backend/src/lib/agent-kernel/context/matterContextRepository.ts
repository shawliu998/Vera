import type { createServerSupabase } from "../../supabase";
import {
  assertMatterContextRowsMatchManifest,
  buildMatterContextManifest,
  MatterContextInvalidError,
  type MatterContextManifestV1,
  type MatterContextWorkflowV1,
  type MatterDocumentRow,
  type MatterVersionRow,
} from "./matterContext";

type Db = ReturnType<typeof createServerSupabase>;

async function loadMatterContextRows(
  db: Db,
  matterId: string,
  documentIds: string[],
) {
  if (documentIds.length === 0) {
    return {
      documents: [] as MatterDocumentRow[],
      versions: [] as MatterVersionRow[],
    };
  }
  const { data: documents, error: documentsError } = await db
    .from("documents")
    .select("id,project_id,current_version_id,status")
    .eq("project_id", matterId)
    .in("id", documentIds);
  if (documentsError) throw new Error(documentsError.message);
  const documentRows = (documents ?? []) as MatterDocumentRow[];
  const versionIds = documentRows.flatMap((row) =>
    typeof row.current_version_id === "string" ? [row.current_version_id] : [],
  );
  const { data: versions, error: versionsError } = versionIds.length
    ? await db
        .from("document_versions")
        .select("id,document_id,filename,file_type,storage_path,deleted_at")
        .in("id", versionIds)
    : { data: [], error: null };
  if (versionsError) throw new Error(versionsError.message);
  return {
    documents: documentRows,
    versions: (versions ?? []) as MatterVersionRow[],
  };
}

export async function compileFixedMatterContext(
  db: Db,
  input: {
    matterId: string;
    documentIds: string[];
    workflow?: MatterContextWorkflowV1 | null;
    compiledAt?: string;
  },
) {
  const documentIds = Array.from(new Set(input.documentIds));
  if (documentIds.length !== input.documentIds.length) {
    throw new MatterContextInvalidError(
      "matter_context_malformed",
      "Fixed source document ids must be unique.",
    );
  }
  const rows = await loadMatterContextRows(db, input.matterId, documentIds);
  const documentsById = new Map(rows.documents.map((row) => [row.id, row]));
  const versionsById = new Map(rows.versions.map((row) => [row.id, row]));
  const sources = documentIds.map((documentId) => {
    const document = documentsById.get(documentId);
    const version = document?.current_version_id
      ? versionsById.get(document.current_version_id)
      : null;
    if (
      !document ||
      document.project_id !== input.matterId ||
      document.status !== "ready" ||
      !document.current_version_id ||
      !version ||
      version.document_id !== documentId ||
      version.deleted_at ||
      !version.storage_path
    ) {
      throw new MatterContextInvalidError(
        "matter_context_source_unavailable",
        "Every selected source must have one ready, current, non-deleted Version in this Matter.",
        { document_id: documentId, matter_id: input.matterId },
      );
    }
    return {
      document_id: documentId,
      version_id: document.current_version_id,
      filename: version.filename?.trim() || "Untitled document",
      file_type: version.file_type?.trim() || null,
      role: "source" as const,
    };
  });
  return buildMatterContextManifest({
    matterId: input.matterId,
    sources,
    workflow: input.workflow,
    compiledAt: input.compiledAt,
  });
}

export async function assertFixedMatterContextCurrent(
  db: Db,
  manifest: MatterContextManifestV1,
) {
  const rows = await loadMatterContextRows(
    db,
    manifest.matter_id,
    manifest.sources.map((source) => source.document_id),
  );
  assertMatterContextRowsMatchManifest(manifest, rows.documents, rows.versions);
  return manifest;
}

export async function extendFixedMatterContext(
  db: Db,
  manifest: MatterContextManifestV1,
  documentIds: string[],
  compiledAt?: string,
) {
  await assertFixedMatterContextCurrent(db, manifest);
  const existingIds = new Set(
    manifest.sources.map((source) => source.document_id),
  );
  const additions = documentIds.filter(
    (documentId) => !existingIds.has(documentId),
  );
  if (!additions.length) return manifest;
  const added = await compileFixedMatterContext(db, {
    matterId: manifest.matter_id,
    documentIds: additions,
    workflow: null,
    compiledAt,
  });
  return buildMatterContextManifest({
    matterId: manifest.matter_id,
    sources: [...manifest.sources, ...added.sources],
    workflow: manifest.workflow,
    compiledAt,
  });
}
