import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const LEGAL_RESEARCH_PERSISTENCE_V22_SQL = `
CREATE TABLE legal_research_sessions (
  id TEXT PRIMARY KEY CHECK (
    typeof(id) = 'text' AND length(trim(id)) BETWEEN 1 AND 160 AND
    id = trim(id) AND instr(id, char(0)) = 0
  ),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES assistant_generation_snapshots(job_id) ON DELETE CASCADE,
  job_attempt INTEGER NOT NULL CHECK (job_attempt BETWEEN 1 AND 100),
  output_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  UNIQUE(project_id, id),
  UNIQUE(job_id, job_attempt)
);

CREATE INDEX idx_legal_research_sessions_project_created
  ON legal_research_sessions(project_id, created_at DESC, id);

CREATE TABLE legal_research_queries (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
  provider_id TEXT NOT NULL CHECK (
    length(provider_id) BETWEEN 1 AND 160 AND
    provider_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  provider_query_id TEXT NOT NULL CHECK (
    length(trim(provider_query_id)) BETWEEN 1 AND 500 AND
    provider_query_id = trim(provider_query_id) AND
    instr(provider_query_id, char(0)) = 0 AND
    instr(lower(provider_query_id), 'http://') = 0 AND
    instr(lower(provider_query_id), 'https://') = 0 AND
    instr(lower(provider_query_id), 'bearer ') = 0 AND
    instr(lower(provider_query_id), 'sk_') = 0
  ),
  result_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(result_fingerprint_sha256) = 64 AND
    result_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  FOREIGN KEY (project_id, session_id)
    REFERENCES legal_research_sessions(project_id, id) ON DELETE CASCADE,
  UNIQUE(project_id, session_id, id),
  UNIQUE(session_id, ordinal),
  UNIQUE(session_id, provider_id, provider_query_id)
);

CREATE INDEX idx_legal_research_queries_session
  ON legal_research_queries(project_id, session_id, ordinal, id);

CREATE TABLE legal_research_candidates (
  source_ref TEXT PRIMARY KEY CHECK (
    length(source_ref) = 32 AND source_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  provider_source_id TEXT NOT NULL CHECK (
    length(trim(provider_source_id)) BETWEEN 1 AND 500 AND
    provider_source_id = trim(provider_source_id) AND
    instr(provider_source_id, char(0)) = 0 AND
    instr(lower(provider_source_id), 'http://') = 0 AND
    instr(lower(provider_source_id), 'https://') = 0 AND
    instr(lower(provider_source_id), 'bearer ') = 0 AND
    instr(lower(provider_source_id), 'sk_') = 0
  ),
  title_snapshot TEXT NOT NULL CHECK (
    length(trim(title_snapshot)) BETWEEN 1 AND 500 AND
    title_snapshot = trim(title_snapshot) AND instr(title_snapshot, char(0)) = 0 AND
    instr(lower(title_snapshot), 'http://') = 0 AND
    instr(lower(title_snapshot), 'https://') = 0 AND
    instr(lower(title_snapshot), 'bearer ') = 0 AND
    instr(lower(title_snapshot), 'sk_') = 0
  ),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'statute', 'regulation', 'judicial_interpretation', 'case', 'guidance'
  )),
  jurisdiction TEXT CHECK (
    jurisdiction IS NULL OR length(trim(jurisdiction)) BETWEEN 1 AND 160
  ),
  court TEXT CHECK (court IS NULL OR length(trim(court)) BETWEEN 1 AND 300),
  case_number TEXT CHECK (
    case_number IS NULL OR length(trim(case_number)) BETWEEN 1 AND 300
  ),
  effective_date TEXT CHECK (
    effective_date IS NULL OR effective_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  authority_status TEXT CHECK (
    authority_status IS NULL OR length(trim(authority_status)) BETWEEN 1 AND 160
  ),
  summary_snapshot TEXT CHECK (
    summary_snapshot IS NULL OR (
      length(trim(summary_snapshot)) BETWEEN 1 AND 2000 AND
      instr(summary_snapshot, char(0)) = 0 AND
      instr(lower(summary_snapshot), 'http://') = 0 AND
      instr(lower(summary_snapshot), 'https://') = 0 AND
      instr(lower(summary_snapshot), 'bearer ') = 0 AND
      instr(lower(summary_snapshot), 'sk_') = 0
    )
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  FOREIGN KEY (project_id, session_id, query_id)
    REFERENCES legal_research_queries(project_id, session_id, id) ON DELETE CASCADE,
  UNIQUE(session_id, query_id, ordinal),
  UNIQUE(session_id, query_id, provider_source_id),
  UNIQUE(project_id, session_id, source_ref)
);

CREATE INDEX idx_legal_research_candidates_session
  ON legal_research_candidates(project_id, session_id, query_id, ordinal);

CREATE TABLE legal_research_reads (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'captured')),
  snapshot_id TEXT,
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  captured_at TEXT,
  FOREIGN KEY (project_id, session_id)
    REFERENCES legal_research_sessions(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, session_id, source_ref)
    REFERENCES legal_research_candidates(project_id, session_id, source_ref) ON DELETE CASCADE,
  FOREIGN KEY (project_id, snapshot_id)
    REFERENCES project_source_snapshots(project_id, id) ON DELETE CASCADE,
  UNIQUE(project_id, session_id, id),
  UNIQUE(session_id, ordinal),
  CHECK (
    (status = 'pending' AND snapshot_id IS NULL AND captured_at IS NULL) OR
    (status = 'captured' AND snapshot_id IS NOT NULL AND captured_at IS NOT NULL)
  )
);

CREATE INDEX idx_legal_research_reads_source
  ON legal_research_reads(project_id, session_id, source_ref, ordinal, id);

CREATE TABLE legal_research_read_anchors (
  read_id TEXT NOT NULL REFERENCES legal_research_reads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  anchor_id TEXT NOT NULL REFERENCES source_citation_anchors(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 49),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  PRIMARY KEY (read_id, anchor_id),
  UNIQUE(read_id, ordinal)
);

CREATE INDEX idx_legal_research_read_anchors_snapshot
  ON legal_research_read_anchors(project_id, snapshot_id, anchor_id, read_id);

CREATE TABLE assistant_legal_authority_message_sources (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  project_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  read_id TEXT NOT NULL REFERENCES legal_research_reads(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  anchor_id TEXT NOT NULL REFERENCES source_citation_anchors(id) ON DELETE CASCADE,
  citation_ordinal INTEGER NOT NULL CHECK (citation_ordinal BETWEEN 0 AND 199),
  citation_metadata_json TEXT NOT NULL CHECK (
    length(citation_metadata_json) BETWEEN 20 AND 1024 AND
    json_valid(citation_metadata_json) = 1 AND
    json_type(citation_metadata_json) = 'object'
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  FOREIGN KEY (project_id, session_id)
    REFERENCES legal_research_sessions(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, session_id, source_ref)
    REFERENCES legal_research_candidates(project_id, session_id, source_ref) ON DELETE CASCADE,
  FOREIGN KEY (project_id, snapshot_id)
    REFERENCES project_source_snapshots(project_id, id) ON DELETE CASCADE,
  UNIQUE(message_id, citation_ordinal),
  UNIQUE(message_id, anchor_id)
);

CREATE INDEX idx_assistant_legal_authority_sources_message
  ON assistant_legal_authority_message_sources(message_id, citation_ordinal, id);
`;

const LEGAL_RESEARCH_PERSISTENCE_V22_TRIGGER_SQL = `
CREATE TRIGGER legal_research_sessions_v22_insert_guard
BEFORE INSERT ON legal_research_sessions BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM assistant_generation_snapshots snapshot
      JOIN jobs job ON job.id = snapshot.job_id
      JOIN chats chat ON chat.id = snapshot.chat_id
      JOIN chat_messages message
        ON message.id = snapshot.output_message_id
       AND message.chat_id = snapshot.chat_id
      JOIN projects project ON project.id = chat.project_id
     WHERE snapshot.job_id = new.job_id
       AND snapshot.output_message_id = new.output_message_id
       AND chat.project_id = new.project_id
       AND project.status = 'active'
       AND job.type = 'assistant_generate'
       AND job.resource_type = 'chat'
       AND job.resource_id = snapshot.chat_id
       AND job.status = 'running'
       AND job.attempt = new.job_attempt
       AND message.role = 'assistant'
       AND message.status = 'pending'
       AND message.job_id = job.id
       AND job.lease_owner IS NOT NULL
       AND job.lease_expires_at IS NOT NULL
       AND julianday(job.lease_expires_at) > julianday('now')
  ) THEN RAISE(ABORT, 'legal research session owner is not an active Assistant attempt') END;
END;

CREATE TRIGGER legal_research_sessions_v22_immutable
BEFORE UPDATE ON legal_research_sessions BEGIN
  SELECT RAISE(ABORT, 'legal research sessions are immutable');
END;

CREATE TRIGGER legal_research_queries_v22_insert_guard
BEFORE INSERT ON legal_research_queries BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM legal_research_sessions session
     WHERE session.project_id = new.project_id AND session.id = new.session_id
  ) THEN RAISE(ABORT, 'legal research query is outside its Matter session') END;
END;

CREATE TRIGGER legal_research_queries_v22_immutable
BEFORE UPDATE ON legal_research_queries BEGIN
  SELECT RAISE(ABORT, 'legal research queries are immutable');
END;

CREATE TRIGGER legal_research_candidates_v22_immutable
BEFORE UPDATE ON legal_research_candidates BEGIN
  SELECT RAISE(ABORT, 'legal research candidates are immutable');
END;

CREATE TRIGGER legal_research_reads_v22_insert_guard
BEFORE INSERT ON legal_research_reads BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM legal_research_candidates candidate
     WHERE candidate.project_id = new.project_id
       AND candidate.session_id = new.session_id
       AND candidate.source_ref = new.source_ref
  ) THEN RAISE(ABORT, 'legal research read source is outside its Matter session') END;
END;

CREATE TRIGGER legal_research_reads_v22_update_guard
BEFORE UPDATE ON legal_research_reads BEGIN
  SELECT CASE WHEN
    new.id IS NOT old.id OR new.project_id IS NOT old.project_id OR
    new.session_id IS NOT old.session_id OR new.source_ref IS NOT old.source_ref OR
    new.ordinal IS NOT old.ordinal OR new.created_at IS NOT old.created_at OR
    old.status <> 'pending' OR new.status <> 'captured' OR
    new.snapshot_id IS NULL OR new.captured_at IS NULL
  THEN RAISE(ABORT, 'legal research read transition is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM legal_research_candidates candidate
      JOIN project_source_snapshots snapshot
        ON snapshot.project_id = candidate.project_id
       AND snapshot.id = new.snapshot_id
       AND snapshot.source_kind = 'legal_authority'
       AND snapshot.source_record_id = candidate.provider_source_id
      JOIN project_source_snapshot_lifecycle lifecycle
        ON lifecycle.project_id = snapshot.project_id
       AND lifecycle.snapshot_id = snapshot.id
      JOIN source_retention_clock clock ON clock.singleton = 1
     WHERE candidate.project_id = new.project_id
       AND candidate.session_id = new.session_id
       AND candidate.source_ref = new.source_ref
       AND snapshot.id = new.snapshot_id
       AND lifecycle.access_state = 'available'
       AND snapshot.retention_policy IN ('full_text_ttl', 'full_text_permitted')
       AND json_extract(snapshot.license_json, '$.basis') IN ('deployment_contract', 'user_provided')
       AND json_extract(snapshot.license_json, '$.retention') = snapshot.retention_policy
       AND json_extract(snapshot.license_json, '$.modelUse') = 'permitted'
       AND (snapshot.retention_policy = 'full_text_permitted' OR (
         lifecycle.expires_at_epoch_ms IS NOT NULL AND
         lifecycle.expires_at_epoch_ms > max(
           clock.high_water_epoch_ms,
           CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)
         )
       ))
  ) THEN RAISE(ABORT, 'legal research read requires a legal authority snapshot') END;
END;

CREATE TRIGGER legal_research_read_anchors_v22_insert_guard
BEFORE INSERT ON legal_research_read_anchors BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM legal_research_reads read
      JOIN source_citation_anchors anchor
        ON anchor.id = new.anchor_id
       AND anchor.project_id = new.project_id
       AND anchor.snapshot_id = new.snapshot_id
     WHERE read.id = new.read_id
       AND read.project_id = new.project_id
       AND read.status = 'pending'
  ) THEN RAISE(ABORT, 'legal research read anchor is outside its pending read') END;
END;

CREATE TRIGGER legal_research_read_anchors_v22_immutable
BEFORE UPDATE ON legal_research_read_anchors BEGIN
  SELECT RAISE(ABORT, 'legal research read anchors are immutable');
END;

CREATE TRIGGER legal_research_reads_v22_capture_requires_anchors
AFTER UPDATE OF status ON legal_research_reads
WHEN new.status = 'captured' BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM legal_research_read_anchors binding
     WHERE binding.read_id = new.id
       AND binding.project_id = new.project_id
       AND binding.snapshot_id = new.snapshot_id
  ) THEN RAISE(ABORT, 'captured legal research read requires an anchor') END;
END;

CREATE TRIGGER assistant_legal_authority_sources_v22_insert_guard
BEFORE INSERT ON assistant_legal_authority_message_sources BEGIN
  SELECT CASE WHEN
    (SELECT count(*) FROM json_each(new.citation_metadata_json)) NOT BETWEEN 1 AND 2 OR
    EXISTS (
      SELECT 1 FROM json_each(new.citation_metadata_json)
       WHERE key NOT IN ('citationNumber', 'label')
    ) OR
    json_type(new.citation_metadata_json, '$.citationNumber') IS NOT 'integer' OR
    json_extract(new.citation_metadata_json, '$.citationNumber') <> new.citation_ordinal + 1 OR
    (json_type(new.citation_metadata_json, '$.label') IS NOT NULL AND (
      json_type(new.citation_metadata_json, '$.label') IS NOT 'text' OR
      length(json_extract(new.citation_metadata_json, '$.label')) NOT BETWEEN 1 AND 500 OR
      instr(lower(json_extract(new.citation_metadata_json, '$.label')), 'http://') > 0 OR
      instr(lower(json_extract(new.citation_metadata_json, '$.label')), 'https://') > 0 OR
      instr(lower(json_extract(new.citation_metadata_json, '$.label')), 'bearer ') > 0 OR
      instr(lower(json_extract(new.citation_metadata_json, '$.label')), 'sk_') > 0
    ))
  THEN RAISE(ABORT, 'legal authority citation metadata is invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM legal_research_sessions session
      JOIN legal_research_reads read
        ON read.id = new.read_id
       AND read.project_id = session.project_id
       AND read.session_id = session.id
       AND read.source_ref = new.source_ref
       AND read.status = 'captured'
       AND read.snapshot_id = new.snapshot_id
      JOIN legal_research_read_anchors read_anchor
        ON read_anchor.read_id = read.id
       AND read_anchor.project_id = read.project_id
       AND read_anchor.snapshot_id = read.snapshot_id
       AND read_anchor.anchor_id = new.anchor_id
      JOIN source_citation_anchors anchor
        ON anchor.id = read_anchor.anchor_id
       AND anchor.project_id = read_anchor.project_id
       AND anchor.snapshot_id = read_anchor.snapshot_id
      JOIN chat_messages message
        ON message.id = new.message_id
       AND message.id = session.output_message_id
      JOIN chats chat
        ON chat.id = message.chat_id
       AND chat.project_id = session.project_id
     WHERE session.project_id = new.project_id
       AND session.id = new.session_id
  ) THEN RAISE(ABORT, 'legal authority message source is outside its Assistant owner') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM project_source_snapshots snapshot
      JOIN project_source_snapshot_lifecycle lifecycle
        ON lifecycle.project_id = snapshot.project_id
       AND lifecycle.snapshot_id = snapshot.id
      JOIN source_retention_clock clock ON clock.singleton = 1
     WHERE snapshot.project_id = new.project_id
       AND snapshot.id = new.snapshot_id
       AND snapshot.source_kind = 'legal_authority'
       AND lifecycle.access_state = 'available'
       AND snapshot.retention_policy IN ('full_text_ttl', 'full_text_permitted')
       AND json_extract(snapshot.license_json, '$.basis') IN ('deployment_contract', 'user_provided')
       AND json_extract(snapshot.license_json, '$.retention') = snapshot.retention_policy
       AND json_extract(snapshot.license_json, '$.modelUse') = 'permitted'
       AND (snapshot.retention_policy = 'full_text_permitted' OR (
         lifecycle.expires_at_epoch_ms IS NOT NULL AND
         lifecycle.expires_at_epoch_ms > max(
           clock.high_water_epoch_ms,
           CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)
         )
       ))
  ) THEN RAISE(ABORT, 'legal authority message source is unavailable under retention policy') END;
END;

CREATE TRIGGER assistant_legal_authority_sources_v22_immutable
BEFORE UPDATE ON assistant_legal_authority_message_sources BEGIN
  SELECT RAISE(ABORT, 'Assistant legal authority message sources are immutable');
END;
`;

function applyLegalResearchPersistenceV22(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error(
      "Workspace schema v22 requires SQLite JSON1 for legal citation metadata.",
    );
  }
  database.exec(LEGAL_RESEARCH_PERSISTENCE_V22_SQL);
  database.exec(LEGAL_RESEARCH_PERSISTENCE_V22_TRIGGER_SQL);
}

export const LEGAL_RESEARCH_PERSISTENCE_V22_MIGRATION: WorkspaceMigration = {
  version: 22,
  name: "matter_legal_research_persistence",
  checksumMaterial: [
    "workspace-migration-v22",
    "additive-durable-matter-owned-legal-research-sessions",
    "opaque-source-refs-bounded-metadata-no-provider-urls-secrets-or-full-text",
    "assistant-legal-authority-citations-remain-separate-from-document-message-sources",
    LEGAL_RESEARCH_PERSISTENCE_V22_SQL,
    LEGAL_RESEARCH_PERSISTENCE_V22_TRIGGER_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyLegalResearchPersistenceV22,
};
