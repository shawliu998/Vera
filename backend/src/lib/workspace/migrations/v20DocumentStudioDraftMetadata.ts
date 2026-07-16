import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const DOCUMENT_STUDIO_DRAFT_METADATA_V20_SQL = `
CREATE TABLE document_studio_draft_metadata (
  document_id TEXT PRIMARY KEY
    REFERENCES documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (
    typeof(document_type) = 'text' AND document_type IN (
      'legal_research_memo',
      'legal_opinion',
      'contract_review_memo',
      'due_diligence_report',
      'litigation_strategy_memo',
      'lawyer_letter',
      'contract_clause',
      'general_legal_document'
    )
  ),
  origin_type TEXT NOT NULL CHECK (
    typeof(origin_type) = 'text' AND
    origin_type IN ('manual', 'assistant', 'workflow', 'unknown')
  ),
  origin_ref TEXT CHECK (
    origin_ref IS NULL OR (
      typeof(origin_ref) = 'text' AND
      length(trim(origin_ref)) BETWEEN 1 AND 240 AND
      origin_ref = trim(origin_ref) AND
      instr(origin_ref, char(0)) = 0
    )
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT} CHECK (
    typeof(created_at) = 'text' AND length(created_at) = 24 AND
    created_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  UNIQUE (project_id, document_id),
  CHECK (
    (origin_type IN ('manual', 'unknown') AND origin_ref IS NULL) OR
    (origin_type IN ('assistant', 'workflow') AND origin_ref IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_document_studio_draft_metadata_project_type_origin
  ON document_studio_draft_metadata(
    project_id, document_type, origin_type, document_id
  );

CREATE TRIGGER document_studio_draft_metadata_v20_insert_guard
BEFORE INSERT ON document_studio_draft_metadata BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM documents document
      JOIN projects project
        ON project.id = document.project_id AND project.status = 'active'
      JOIN document_studio_versions studio
        ON studio.project_id = document.project_id
       AND studio.document_id = document.id
       AND studio.version_id = document.current_version_id
     WHERE document.id = new.document_id
       AND document.project_id = new.project_id
       AND document.document_kind = 'draft'
       AND document.deleted_at IS NULL
  ) THEN RAISE(
    ABORT,
    'Draft metadata must belong to an active Studio Draft in the same Project'
  ) END;

  SELECT CASE WHEN new.origin_type = 'assistant' AND NOT EXISTS (
    SELECT 1
      FROM assistant_generation_snapshots snapshot
      JOIN chats chat ON chat.id = snapshot.chat_id
      JOIN chat_messages message
        ON message.id = snapshot.output_message_id
       AND message.chat_id = chat.id
     WHERE snapshot.output_message_id = new.origin_ref
       AND message.role = 'assistant'
       AND chat.scope = 'project'
       AND chat.project_id = new.project_id
  ) THEN RAISE(
    ABORT,
    'Assistant Draft origin must be an output message in the same Project'
  ) END;

  SELECT CASE WHEN new.origin_type = 'workflow' AND NOT EXISTS (
    SELECT 1
      FROM workflow_runs run
     WHERE run.id = new.origin_ref
       AND run.project_id = new.project_id
       AND run.status = 'complete'
  ) THEN RAISE(
    ABORT,
    'Workflow Draft origin must be a run in the same Project'
  ) END;
END;

CREATE TRIGGER document_studio_draft_metadata_v20_immutable
BEFORE UPDATE ON document_studio_draft_metadata BEGIN
  SELECT RAISE(ABORT, 'Document Studio Draft metadata is immutable');
END;
`;

function applyDocumentStudioDraftMetadataV20(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  // Deliberately no backfill: pre-v20 Drafts retain unknown provenance instead
  // of receiving an inferred legal-document type or origin.
  database.exec(DOCUMENT_STUDIO_DRAFT_METADATA_V20_SQL);
}

export const DOCUMENT_STUDIO_DRAFT_METADATA_V20_MIGRATION: WorkspaceMigration =
  {
    version: 20,
    name: "document_studio_draft_metadata",
    checksumMaterial: [
      "workspace-migration-v20",
      "additive-draft-type-and-origin-provenance-no-legacy-inference",
      "metadata-created-in-the-existing-studio-draft-transaction",
      DOCUMENT_STUDIO_DRAFT_METADATA_V20_SQL,
    ].join("\n-- checksum boundary --\n"),
    apply: applyDocumentStudioDraftMetadataV20,
  };
