import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

/**
 * v14 keeps AI edit suggestions in the original v1 `document_edits` table.
 * Offsets are JavaScript/Markdown UTF-16 code-unit offsets over the immutable
 * raw Markdown base version; legacy rows remain readable with null offsets.
 */
const DOCUMENT_STUDIO_SUGGESTIONS_V14_SQL = `
ALTER TABLE document_edits ADD COLUMN end_offset INTEGER
  CHECK (end_offset IS NULL OR end_offset >= 0);
ALTER TABLE document_edits ADD COLUMN start_offset INTEGER
  CHECK (
    (start_offset IS NULL AND end_offset IS NULL) OR
    (start_offset IS NOT NULL AND end_offset IS NOT NULL AND
      start_offset >= 0 AND end_offset >= start_offset)
  );
ALTER TABLE document_edits ADD COLUMN offset_scope TEXT
  CHECK (offset_scope IS NULL OR offset_scope = 'raw_markdown_v1');
ALTER TABLE document_edits ADD COLUMN offset_unit TEXT
  CHECK (offset_unit IS NULL OR offset_unit = 'utf16_code_unit');

CREATE INDEX idx_document_edits_studio_pending
  ON document_edits(document_id, status, created_at, id)
  WHERE status = 'pending';

CREATE TRIGGER document_edits_v14_payload_immutable
BEFORE UPDATE OF
  document_id,
  version_id,
  change_id,
  deleted_text,
  inserted_text,
  context_before,
  context_after,
  summary,
  start_offset,
  end_offset,
  offset_scope,
  offset_unit
ON document_edits BEGIN
  SELECT RAISE(ABORT, 'document edit suggestion payload is immutable');
END;

CREATE TRIGGER document_edits_v14_message_one_way_null
BEFORE UPDATE OF message_id ON document_edits
WHEN NOT (
  old.message_id IS NOT NULL AND new.message_id IS NULL AND
  (
    (
      old.start_offset IS NULL AND old.end_offset IS NULL AND
      old.offset_scope IS NULL AND old.offset_unit IS NULL
    ) OR (
      old.status IN ('accepted', 'rejected') AND old.resolved_at IS NOT NULL
    )
  )
) BEGIN
  SELECT RAISE(ABORT, 'document edit suggestion message binding is immutable');
END;

CREATE TRIGGER document_edits_v14_resolution_one_way
BEFORE UPDATE OF status, resolved_at ON document_edits BEGIN
  SELECT CASE WHEN NOT (
    old.status = 'pending' AND
    old.resolved_at IS NULL AND
    new.status IN ('accepted', 'rejected') AND
    new.resolved_at IS NOT NULL
  ) THEN RAISE(ABORT, 'document edit suggestion resolution is one-way') END;
END;
`;

function applyDocumentStudioSuggestionsV14(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(DOCUMENT_STUDIO_SUGGESTIONS_V14_SQL);
}

export const DOCUMENT_STUDIO_SUGGESTIONS_V14_MIGRATION: WorkspaceMigration = {
  version: 14,
  name: "document_studio_ai_suggestions",
  checksumMaterial: [
    "workspace-migration-v14",
    "reuse-v1-document-edits",
    "raw-markdown-v1-utf16-code-unit-offsets",
    "immutable-payload-one-way-resolution",
    DOCUMENT_STUDIO_SUGGESTIONS_V14_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyDocumentStudioSuggestionsV14,
};
