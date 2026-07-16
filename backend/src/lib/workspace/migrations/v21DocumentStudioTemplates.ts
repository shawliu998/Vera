import {
  BUILTIN_DOCUMENT_STUDIO_TEMPLATES_V21,
  DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_BYTES_V21,
  DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_CHARS_V21,
} from "../documentStudioTemplatesV21";
import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const DOCUMENT_STUDIO_TEMPLATES_V21_SQL = `
CREATE TABLE document_studio_templates (
  id TEXT PRIMARY KEY CHECK (
    typeof(id) = 'text' AND length(id) = 36 AND
    id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  template_key TEXT UNIQUE CHECK (
    template_key IS NULL OR (
      typeof(template_key) = 'text' AND
      template_key GLOB '[a-z][a-z0-9_]*' AND
      length(template_key) BETWEEN 1 AND 80
    )
  ),
  source_template_id TEXT REFERENCES document_studio_templates(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (
    typeof(title) = 'text' AND length(trim(title)) BETWEEN 1 AND 240 AND
    title = trim(title) AND instr(title, char(0)) = 0
  ),
  description TEXT NOT NULL CHECK (
    typeof(description) = 'text' AND length(trim(description)) BETWEEN 1 AND 500 AND
    description = trim(description) AND instr(description, char(0)) = 0
  ),
  document_type TEXT NOT NULL CHECK (document_type IN (
    'legal_research_memo', 'legal_opinion', 'contract_review_memo',
    'due_diligence_report', 'litigation_strategy_memo', 'lawyer_letter',
    'contract_clause', 'general_legal_document'
  )),
  content_markdown TEXT NOT NULL CHECK (
    typeof(content_markdown) = 'text' AND
    length(content_markdown) BETWEEN 1 AND ${DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_CHARS_V21} AND
    length(CAST(content_markdown AS BLOB)) <= ${DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_BYTES_V21} AND
    instr(content_markdown, char(0)) = 0
  ),
  draft_plan_json TEXT NOT NULL CHECK (
    typeof(draft_plan_json) = 'text' AND
    length(draft_plan_json) BETWEEN 2 AND 100000 AND
    json_valid(draft_plan_json) = 1 AND
    json_extract(draft_plan_json, '$.documentType') = document_type AND
    json_array_length(draft_plan_json, '$.sections') BETWEEN 1 AND 24
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  CHECK (
    (project_id IS NULL AND template_key IS NOT NULL AND source_template_id IS NULL) OR
    (project_id IS NOT NULL AND template_key IS NULL AND source_template_id IS NOT NULL)
  ),
  UNIQUE(project_id, title)
) WITHOUT ROWID;

CREATE INDEX idx_document_studio_templates_project_updated
  ON document_studio_templates(project_id, updated_at DESC, id);

CREATE TRIGGER document_studio_templates_v21_insert_guard
BEFORE INSERT ON document_studio_templates
WHEN new.project_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM projects project
     WHERE project.id = new.project_id AND project.status = 'active'
  ) THEN RAISE(ABORT, 'Local template requires an active Project') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM document_studio_templates source
     WHERE source.id = new.source_template_id
       AND (source.project_id IS NULL OR source.project_id = new.project_id)
  ) THEN RAISE(ABORT, 'Template source is not visible in this Project') END;
END;

CREATE TRIGGER document_studio_templates_v21_builtin_update_guard
BEFORE UPDATE ON document_studio_templates
WHEN old.project_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'Built-in templates are immutable');
END;

CREATE TRIGGER document_studio_templates_v21_local_update_guard
BEFORE UPDATE ON document_studio_templates
WHEN old.project_id IS NOT NULL BEGIN
  SELECT CASE WHEN
    new.id IS NOT old.id OR
    new.project_id IS NOT old.project_id OR
    new.template_key IS NOT old.template_key OR
    new.source_template_id IS NOT old.source_template_id OR
    new.created_at IS NOT old.created_at
  THEN RAISE(ABORT, 'Local template identity and Project scope are immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM projects project
     WHERE project.id = old.project_id AND project.status = 'active'
  ) THEN RAISE(ABORT, 'Local template update requires an active Project') END;
END;

CREATE TRIGGER document_studio_templates_v21_builtin_delete_guard
BEFORE DELETE ON document_studio_templates
WHEN old.project_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'Built-in templates cannot be deleted');
END;
`;

function applyDocumentStudioTemplatesV21(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(DOCUMENT_STUDIO_TEMPLATES_V21_SQL);
  const insert = database.prepare(
    `INSERT INTO document_studio_templates (
       id, project_id, template_key, source_template_id, title, description,
       document_type, content_markdown, draft_plan_json
     ) VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
  );
  for (const entry of BUILTIN_DOCUMENT_STUDIO_TEMPLATES_V21) {
    insert.run(
      entry.id,
      entry.key,
      entry.title,
      entry.description,
      entry.documentType,
      entry.content,
      JSON.stringify(entry.plan),
    );
  }
}

export const DOCUMENT_STUDIO_TEMPLATES_V21_MIGRATION: WorkspaceMigration = {
  version: 21,
  name: "document_studio_templates",
  checksumMaterial: [
    "workspace-migration-v21",
    "project-scoped-local-template-copies-and-bounded-draft-plans",
    DOCUMENT_STUDIO_TEMPLATES_V21_SQL,
    JSON.stringify(BUILTIN_DOCUMENT_STUDIO_TEMPLATES_V21),
  ].join("\n-- checksum boundary --\n"),
  apply: applyDocumentStudioTemplatesV21,
};
