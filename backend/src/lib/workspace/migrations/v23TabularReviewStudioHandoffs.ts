import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const SQL = `
CREATE TABLE tabular_review_studio_handoffs (
  id TEXT PRIMARY KEY,
  identity_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(identity_sha256) = 64 AND identity_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL REFERENCES tabular_reviews(id) ON DELETE RESTRICT,
  review_state_sha256 TEXT NOT NULL CHECK (
    length(review_state_sha256) = 64 AND review_state_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  source_manifest_json TEXT NOT NULL CHECK (
    json_valid(source_manifest_json) AND
    json_type(source_manifest_json) = 'object' AND
    length(source_manifest_json) BETWEEN 2 AND 4000000
  ),
  source_manifest_sha256 TEXT NOT NULL CHECK (
    length(source_manifest_sha256) = 64 AND source_manifest_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  template_reducer_revision_sha256 TEXT NOT NULL CHECK (
    length(template_reducer_revision_sha256) = 64 AND
    template_reducer_revision_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL CHECK (document_type = 'contract_review_memo'),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  UNIQUE (
    review_id, review_state_sha256, source_manifest_sha256,
    template_reducer_revision_sha256
  )
) WITHOUT ROWID;

CREATE INDEX idx_tabular_review_studio_handoffs_review
  ON tabular_review_studio_handoffs(project_id, review_id, created_at);

CREATE TRIGGER tabular_review_studio_handoffs_v23_insert_guard
BEFORE INSERT ON tabular_review_studio_handoffs BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tabular_reviews review
     WHERE review.id = new.review_id
       AND review.project_id = new.project_id
       AND review.status = 'complete'
  ) THEN RAISE(ABORT, 'Tabular Studio handoff requires a completed review in the same Project') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM documents document
      JOIN document_versions version
        ON version.id = new.version_id
       AND version.document_id = document.id
       AND version.version_number = 1
       AND version.deleted_at IS NULL
      JOIN document_studio_versions studio
        ON studio.project_id = document.project_id
       AND studio.document_id = document.id
       AND studio.version_id = version.id
      JOIN document_studio_draft_metadata metadata
        ON metadata.project_id = document.project_id
       AND metadata.document_id = document.id
       AND metadata.document_type = 'contract_review_memo'
       AND metadata.origin_type = 'unknown'
       AND metadata.origin_ref IS NULL
     WHERE document.id = new.document_id
       AND document.project_id = new.project_id
       AND document.document_kind = 'draft'
       AND document.current_version_id = new.version_id
       AND document.deleted_at IS NULL
       AND new.document_type = 'contract_review_memo'
  ) THEN RAISE(ABORT, 'Tabular Studio handoff must bind the current v1 contract-review Draft') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM document_version_citation_anchors binding
     WHERE binding.project_id = new.project_id
       AND binding.document_id = new.document_id
       AND binding.version_id = new.version_id
  ) THEN RAISE(ABORT, 'Tabular Studio handoff requires durable citation bindings') END;
END;

CREATE TRIGGER tabular_review_studio_handoffs_v23_immutable_update
BEFORE UPDATE ON tabular_review_studio_handoffs BEGIN
  SELECT RAISE(ABORT, 'Tabular Studio handoffs are immutable');
END;

CREATE TRIGGER tabular_review_studio_handoffs_v23_immutable_delete
BEFORE DELETE ON tabular_review_studio_handoffs BEGIN
  SELECT RAISE(ABORT, 'Tabular Studio handoffs are immutable');
END;

CREATE TRIGGER tabular_reviews_v23_handoff_delete_guard
BEFORE DELETE ON tabular_reviews
WHEN EXISTS (
  SELECT 1 FROM tabular_review_studio_handoffs handoff
   WHERE handoff.review_id = old.id
) BEGIN
  SELECT RAISE(ABORT, 'A review with a Studio handoff must be archived, not deleted');
END;
`;

function apply(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error("Workspace schema v23 requires SQLite JSON1.");
  }
  database.exec(SQL);
}

export const TABULAR_REVIEW_STUDIO_HANDOFFS_V23_MIGRATION: WorkspaceMigration =
  {
    version: 23,
    name: "tabular_review_studio_handoffs",
    checksumMaterial: [
      "workspace-migration-v23",
      "immutable-tabular-review-to-contract-review-memo-evidence-handoff",
      SQL,
    ].join("\n-- checksum boundary --\n"),
    apply,
  };
