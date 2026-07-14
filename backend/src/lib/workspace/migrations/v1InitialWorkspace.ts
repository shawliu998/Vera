import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const SCHEMA_SQL_TEMPLATE = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 240),
  description TEXT,
  cm_number TEXT,
  practice TEXT,
  default_model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

CREATE INDEX idx_projects_status_updated
  ON projects(status, updated_at DESC);
CREATE INDEX idx_projects_cm_number
  ON projects(cm_number) WHERE cm_number IS NOT NULL;

CREATE TABLE project_subfolders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_folder_id TEXT REFERENCES project_subfolders(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 240),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  CHECK (parent_folder_id IS NULL OR parent_folder_id <> id)
);

CREATE INDEX idx_project_subfolders_project_parent
  ON project_subfolders(project_id, parent_folder_id);
CREATE UNIQUE INDEX uq_project_subfolders_sibling_name
  ON project_subfolders(project_id, ifnull(parent_folder_id, ''), name);

CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  provider TEXT NOT NULL
    CHECK (provider IN ('openai', 'deepseek', 'anthropic', 'gemini', 'openai_compatible')),
  model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 240),
  base_url TEXT,
  credential_ref TEXT,
  credential_status TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (credential_status IN ('not_configured', 'configured', 'unavailable')),
  context_window_tokens INTEGER CHECK (context_window_tokens IS NULL OR context_window_tokens > 0),
  max_output_tokens INTEGER CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
  capabilities_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:capabilities_json}},
  settings_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:settings_json}},
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  UNIQUE(name)
);

CREATE UNIQUE INDEX uq_model_profiles_default
  ON model_profiles(is_default) WHERE is_default = 1;
CREATE INDEX idx_model_profiles_provider_enabled
  ON model_profiles(provider, enabled);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL
    CHECK (type IN ('document_parse', 'assistant_generate', 'workflow_run', 'tabular_cell')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled', 'interrupted')),
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('document', 'chat', 'workflow_run', 'tabular_cell', 'tabular_review', 'project')),
  resource_id TEXT NOT NULL,
  idempotency_key TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  payload_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:payload_json}},
  result_json TEXT {{JSON_CHECK:result_json}},
  error_json TEXT {{JSON_CHECK:error_json}},
  error_code TEXT,
  scheduled_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  locked_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

CREATE UNIQUE INDEX uq_jobs_idempotency_key
  ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jobs_dispatch
  ON jobs(status, scheduled_at, priority DESC, created_at);
CREATE INDEX idx_jobs_resource
  ON jobs(resource_type, resource_id, created_at DESC);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES project_subfolders(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  filename TEXT NOT NULL CHECK (length(trim(filename)) BETWEEN 1 AND 500),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 200),
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  parse_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported', 'ocr_required')),
  current_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

CREATE INDEX idx_documents_project_folder
  ON documents(project_id, folder_id, updated_at DESC);
CREATE INDEX idx_documents_parse_status
  ON documents(parse_status, updated_at DESC);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  source TEXT NOT NULL DEFAULT 'upload'
    CHECK (source IN ('upload', 'user_upload', 'assistant_edit', 'user_accept', 'user_reject', 'generated')),
  filename TEXT NOT NULL CHECK (length(trim(filename)) BETWEEN 1 AND 500),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 200),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_sha256 TEXT NOT NULL
    CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  storage_key TEXT NOT NULL CHECK (length(trim(storage_key)) > 0),
  preview_storage_key TEXT,
  page_count INTEGER CHECK (page_count IS NULL OR page_count >= 0),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  UNIQUE(document_id, version_number),
  UNIQUE(document_id, id)
);

CREATE INDEX idx_document_versions_document_created
  ON document_versions(document_id, created_at DESC);
CREATE INDEX idx_document_versions_active
  ON document_versions(document_id, version_number DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_document_versions_storage_key
  ON document_versions(storage_key);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);

CREATE INDEX idx_chats_scope_updated
  ON chats(scope, updated_at DESC);
CREATE INDEX idx_chats_project_updated
  ON chats(project_id, updated_at DESC) WHERE project_id IS NOT NULL;

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  files_json TEXT NOT NULL DEFAULT '[]' {{JSON_CHECK:files_json}},
  citations_json TEXT NOT NULL DEFAULT '[]' {{JSON_CHECK:citations_json}},
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'streaming', 'complete', 'failed', 'cancelled', 'interrupted')),
  model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  completed_at TEXT,
  UNIQUE(chat_id, sequence)
);

CREATE INDEX idx_chat_messages_chat_sequence
  ON chat_messages(chat_id, sequence);
CREATE INDEX idx_chat_messages_job
  ON chat_messages(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE document_edits (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  change_id TEXT NOT NULL,
  deleted_text TEXT NOT NULL DEFAULT '',
  inserted_text TEXT NOT NULL DEFAULT '',
  context_before TEXT,
  context_after TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  resolved_at TEXT,
  FOREIGN KEY (document_id, version_id)
    REFERENCES document_versions(document_id, id) ON DELETE CASCADE,
  UNIQUE(version_id, change_id)
);

CREATE INDEX idx_document_edits_document_created
  ON document_edits(document_id, created_at DESC);
CREATE INDEX idx_document_edits_message
  ON document_edits(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  text TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  page_start INTEGER CHECK (page_start IS NULL OR page_start > 0),
  page_end INTEGER CHECK (page_end IS NULL OR page_end >= page_start),
  section TEXT,
  token_count INTEGER CHECK (token_count IS NULL OR token_count >= 0),
  content_sha256 TEXT NOT NULL
    CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  metadata_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:metadata_json}},
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  FOREIGN KEY (document_id, version_id)
    REFERENCES document_versions(document_id, id) ON DELETE CASCADE,
  CHECK ((page_start IS NULL AND page_end IS NULL) OR
         (page_start IS NOT NULL AND page_end IS NOT NULL)),
  UNIQUE(version_id, ordinal)
);

CREATE INDEX idx_document_chunks_document_version
  ON document_chunks(document_id, version_id, ordinal);
CREATE INDEX idx_document_chunks_page
  ON document_chunks(version_id, page_start, page_end) WHERE page_start IS NOT NULL;

CREATE TABLE message_sources (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_id TEXT REFERENCES document_chunks(id) ON DELETE SET NULL,
  quote TEXT,
  start_offset INTEGER CHECK (start_offset IS NULL OR start_offset >= 0),
  end_offset INTEGER CHECK (end_offset IS NULL OR end_offset >= 0),
  locator_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:locator_json}},
  rank INTEGER CHECK (rank IS NULL OR rank >= 0),
  score REAL,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  CHECK ((start_offset IS NULL AND end_offset IS NULL) OR
         (start_offset IS NOT NULL AND end_offset IS NOT NULL AND end_offset >= start_offset)),
  UNIQUE(message_id, chunk_id)
);

CREATE INDEX idx_message_sources_message_rank
  ON message_sources(message_id, rank);
CREATE INDEX idx_message_sources_document
  ON message_sources(document_id, version_id);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('assistant', 'tabular')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  skill_markdown TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]' {{JSON_CHECK:steps_json}},
  columns_config_json TEXT NOT NULL DEFAULT '[]' {{JSON_CHECK:columns_config_json}},
  language TEXT NOT NULL DEFAULT 'English',
  practice TEXT NOT NULL DEFAULT 'General Transactions',
  jurisdictions_json TEXT NOT NULL DEFAULT '["General"]' {{JSON_CHECK:jurisdictions_json}},
  metadata_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:metadata_json}},
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

CREATE INDEX idx_workflows_type_status
  ON workflows(type, status, updated_at DESC);

CREATE TABLE hidden_workflows (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  UNIQUE(workflow_id)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'waiting', 'running', 'complete', 'failed', 'cancelled', 'interrupted')),
  input_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:input_json}},
  output_json TEXT {{JSON_CHECK:output_json}},
  error_json TEXT {{JSON_CHECK:error_json}},
  error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

CREATE INDEX idx_workflow_runs_workflow_created
  ON workflow_runs(workflow_id, created_at DESC);
CREATE INDEX idx_workflow_runs_status
  ON workflow_runs(status, created_at);

CREATE TABLE workflow_step_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  step_json TEXT NOT NULL {{JSON_CHECK:step_json}},
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'waiting', 'running', 'complete', 'failed', 'cancelled', 'interrupted', 'skipped')),
  input_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:input_json}},
  output_json TEXT {{JSON_CHECK:output_json}},
  error_json TEXT {{JSON_CHECK:error_json}},
  error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  UNIQUE(workflow_run_id, ordinal, attempt)
);

CREATE INDEX idx_workflow_step_runs_run_ordinal
  ON workflow_step_runs(workflow_run_id, ordinal, attempt);

CREATE TABLE tabular_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'running', 'complete', 'failed', 'cancelled', 'archived')),
  document_ids_json TEXT NOT NULL DEFAULT '[]' {{JSON_CHECK:document_ids_json}},
  columns_config_json TEXT NOT NULL DEFAULT '[]' {{JSON_CHECK:columns_config_json}},
  practice TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

CREATE INDEX idx_tabular_reviews_project_updated
  ON tabular_reviews(project_id, updated_at DESC);
CREATE INDEX idx_tabular_reviews_status
  ON tabular_reviews(status, updated_at DESC);

CREATE TABLE tabular_review_columns (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES tabular_reviews(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(trim(key)) BETWEEN 1 AND 120),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  output_type TEXT NOT NULL CHECK (output_type IN ('text', 'boolean', 'enum', 'number')),
  prompt TEXT NOT NULL DEFAULT '',
  enum_values_json TEXT {{JSON_CHECK:enum_values_json}},
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  UNIQUE(review_id, key),
  UNIQUE(review_id, ordinal)
);

CREATE INDEX idx_tabular_review_columns_review_ordinal
  ON tabular_review_columns(review_id, ordinal);

CREATE TABLE tabular_cells (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES tabular_reviews(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES tabular_review_columns(id) ON DELETE CASCADE,
  output_type TEXT NOT NULL CHECK (output_type IN ('text', 'boolean', 'enum', 'number')),
  value_json TEXT {{JSON_CHECK:value_json}},
  content TEXT,
  citations_json TEXT NOT NULL DEFAULT '[]' {{JSON_CHECK:citations_json}},
  status TEXT NOT NULL DEFAULT 'empty'
    CHECK (status IN ('empty', 'queued', 'running', 'complete', 'failed', 'cancelled')),
  error_json TEXT {{JSON_CHECK:error_json}},
  error_code TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  completed_at TEXT,
  UNIQUE(review_id, document_id, column_id)
);

CREATE INDEX idx_tabular_cells_review_document
  ON tabular_cells(review_id, document_id, column_id);
CREATE INDEX idx_tabular_cells_status
  ON tabular_cells(review_id, status, updated_at);

CREATE TABLE tabular_review_chats (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES tabular_reviews(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

CREATE INDEX idx_tabular_review_chats_review_updated
  ON tabular_review_chats(review_id, updated_at DESC);

CREATE TABLE tabular_review_chat_messages (
  id TEXT PRIMARY KEY,
  review_chat_id TEXT NOT NULL REFERENCES tabular_review_chats(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  annotations_json TEXT NOT NULL DEFAULT '[]' {{JSON_CHECK:annotations_json}},
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'streaming', 'complete', 'failed', 'cancelled', 'interrupted')),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  completed_at TEXT,
  UNIQUE(review_chat_id, sequence)
);

CREATE INDEX idx_tabular_review_chat_messages_chat_sequence
  ON tabular_review_chat_messages(review_chat_id, sequence);

CREATE TABLE workspace_settings (
  id TEXT PRIMARY KEY CHECK (id = 'workspace'),
  locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (locale IN ('zh-CN', 'en-US')),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  default_model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  default_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

INSERT INTO workspace_settings (id) VALUES ('workspace');

CREATE TABLE legacy_import_records (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL DEFAULT 'legacy_workspace'
    CHECK (source_kind = 'legacy_workspace'),
  source_record_id TEXT NOT NULL,
  target_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
  source_hash TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' {{JSON_CHECK:details_json}},
  error_json TEXT {{JSON_CHECK:error_json}},
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  completed_at TEXT,
  UNIQUE(source_kind, source_record_id)
);

CREATE INDEX idx_legacy_import_records_status
  ON legacy_import_records(status, created_at);
`;

const DOCUMENT_CHUNKS_FTS_SQL = `
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  text,
  document_id UNINDEXED,
  version_id UNINDEXED,
  content = 'document_chunks',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER document_chunks_fts_insert
AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, text, document_id, version_id)
  VALUES (new.rowid, new.text, new.document_id, new.version_id);
END;

CREATE TRIGGER document_chunks_fts_delete
AFTER DELETE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, text, document_id, version_id)
  VALUES ('delete', old.rowid, old.text, old.document_id, old.version_id);
END;

CREATE TRIGGER document_chunks_fts_update
AFTER UPDATE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, text, document_id, version_id)
  VALUES ('delete', old.rowid, old.text, old.document_id, old.version_id);
  INSERT INTO document_chunks_fts(rowid, text, document_id, version_id)
  VALUES (new.rowid, new.text, new.document_id, new.version_id);
END;
`;

function renderSchema(capabilities: WorkspaceDatabaseCapabilities) {
  return SCHEMA_SQL_TEMPLATE.replace(
    /\{\{JSON_CHECK:([a-z_]+)\}\}/g,
    (_token, column: string) =>
      capabilities.jsonTextChecks ? `CHECK (json_valid(${column}))` : "",
  );
}

function applyInitialWorkspaceSchema(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(renderSchema(capabilities));
  if (capabilities.fts5) database.exec(DOCUMENT_CHUNKS_FTS_SQL);
}

export const INITIAL_WORKSPACE_MIGRATION: WorkspaceMigration = {
  version: 1,
  name: "initial_workspace_schema",
  checksumMaterial: [
    "workspace-migration-v1",
    SCHEMA_SQL_TEMPLATE,
    "optional-when-json_valid-is-available",
    DOCUMENT_CHUNKS_FTS_SQL,
    "optional-when-fts5-is-available",
  ].join("\n-- checksum boundary --\n"),
  apply: applyInitialWorkspaceSchema,
};
