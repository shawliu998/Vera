import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/*
 * v1 accidentally made a chunk unique per message. A chunk is a source, not a
 * citation occurrence: the same chunk may support multiple statements in one
 * answer. SQLite implements that table-level UNIQUE as an auto-index, so a
 * table rebuild is the only way to remove it. Existing relational/citation
 * rows are retained; legacy locator JSON is canonicalized immediately after
 * the rebuild and before the v5 runtime triggers are installed.
 */
const MESSAGE_SOURCES_V5_SQL = `
DROP TRIGGER IF EXISTS message_sources_integrity_insert;
DROP TRIGGER IF EXISTS message_sources_integrity_update;
DROP TRIGGER IF EXISTS document_versions_integrity_update;
DROP TRIGGER IF EXISTS chats_source_scope_update;
DROP TRIGGER IF EXISTS document_chunks_integrity_update;

CREATE TABLE message_sources_v5 (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  filename_snapshot TEXT NOT NULL
    CHECK (length(trim(filename_snapshot)) BETWEEN 1 AND 500),
  chunk_id TEXT REFERENCES document_chunks(id) ON DELETE SET NULL,
  quote TEXT,
  start_offset INTEGER CHECK (start_offset IS NULL OR start_offset >= 0),
  end_offset INTEGER CHECK (end_offset IS NULL OR end_offset >= 0),
  locator_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(locator_json) AND json_type(locator_json) = 'object'
  ),
  rank INTEGER CHECK (rank IS NULL OR rank >= 0),
  score REAL,
  citation_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (citation_ordinal >= 0),
  citation_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(citation_metadata_json) AND
    json_type(citation_metadata_json) = 'object'
  ),
  migration_issue_code TEXT CHECK (
    migration_issue_code IS NULL OR
    migration_issue_code IN (
      'workspace_migration_source_locator_redacted',
      'workspace_migration_source_locator_requires_review'
    )
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  UNIQUE(message_id, citation_ordinal),
  CHECK ((start_offset IS NULL AND end_offset IS NULL) OR
         (start_offset IS NOT NULL AND end_offset IS NOT NULL AND end_offset >= start_offset))
);

WITH canonical_sources AS (
  SELECT source.*,
         version.filename AS filename_snapshot,
         row_number() OVER (
           PARTITION BY source.message_id
           ORDER BY
             CASE WHEN source.rank IS NULL THEN 1 ELSE 0 END,
             source.rank ASC,
             source.created_at ASC,
             source.id ASC
         ) - 1 AS canonical_ordinal
    FROM message_sources source
    JOIN document_versions version
      ON version.id = source.version_id
     AND version.document_id = source.document_id
)
INSERT INTO message_sources_v5 (
  id, message_id, document_id, version_id, filename_snapshot, chunk_id, quote,
  start_offset, end_offset, locator_json, rank, score,
  citation_ordinal, citation_metadata_json, migration_issue_code, created_at
)
SELECT id, message_id, document_id, version_id, filename_snapshot, chunk_id, quote,
       start_offset, end_offset, locator_json, rank, score,
       canonical_ordinal,
       json_object('citationNumber', canonical_ordinal + 1),
       NULL, created_at
  FROM canonical_sources;

DROP TABLE message_sources;
ALTER TABLE message_sources_v5 RENAME TO message_sources;

CREATE INDEX idx_message_sources_message_rank
  ON message_sources(message_id, rank, citation_ordinal, id);
CREATE INDEX idx_message_sources_document
  ON message_sources(document_id, version_id);
CREATE INDEX idx_message_sources_chunk
  ON message_sources(message_id, chunk_id) WHERE chunk_id IS NOT NULL;
`;

const ASSISTANT_SCHEMA_SQL = `
CREATE TABLE chat_message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  filename_snapshot TEXT NOT NULL
    CHECK (length(trim(filename_snapshot)) BETWEEN 1 AND 500),
  mime_type_snapshot TEXT NOT NULL
    CHECK (length(trim(mime_type_snapshot)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  UNIQUE(message_id, ordinal),
  UNIQUE(message_id, document_id, version_id)
);

CREATE INDEX idx_chat_message_attachments_message
  ON chat_message_attachments(message_id, ordinal);
CREATE INDEX idx_chat_message_attachments_document
  ON chat_message_attachments(document_id, version_id);

CREATE TABLE assistant_generation_snapshots (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  prompt_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  output_message_id TEXT NOT NULL UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
  model_profile_id TEXT NOT NULL,
  current_version_only INTEGER NOT NULL DEFAULT 1
    CHECK (current_version_only = 1),
  retrieval_limit INTEGER NOT NULL CHECK (retrieval_limit BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

CREATE INDEX idx_assistant_generation_snapshots_chat
  ON assistant_generation_snapshots(chat_id, created_at DESC);

CREATE TABLE assistant_generation_documents (
  job_id TEXT NOT NULL REFERENCES assistant_generation_snapshots(job_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  attached INTEGER NOT NULL CHECK (attached IN (0, 1)),
  PRIMARY KEY (job_id, ordinal),
  UNIQUE(job_id, document_id)
);

CREATE INDEX idx_assistant_generation_documents_document
  ON assistant_generation_documents(document_id, version_id);

`;

const LEGACY_ASSISTANT_JOB_RECOVERY_SQL = `
UPDATE chat_messages
   SET status = 'interrupted',
       error_code = 'workspace_migration_assistant_snapshot_required',
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE status IN ('pending','streaming')
   AND job_id IN (
     SELECT job.id
       FROM jobs job
      WHERE job.type = 'assistant_generate'
        AND job.status IN ('queued','running')
        AND NOT EXISTS (
          SELECT 1 FROM assistant_generation_snapshots snapshot
           WHERE snapshot.job_id = job.id
        )
   );

UPDATE jobs
   SET status = 'interrupted',
       retryable = 0,
       result_json = NULL,
       error_code = 'workspace_migration_assistant_snapshot_required',
       error_json = '{"code":"workspace_migration_assistant_snapshot_required","message":"Assistant generation was interrupted by the workspace runtime migration.","retryable":false,"details":null}',
       locked_at = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       cancel_requested_at = NULL,
       cancellation_reason = NULL,
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE type = 'assistant_generate'
   AND status IN ('queued','running')
   AND NOT EXISTS (
     SELECT 1 FROM assistant_generation_snapshots snapshot
      WHERE snapshot.job_id = jobs.id
   );
`;

const SOURCE_METADATA_INVALID_SQL = `
    EXISTS (
      SELECT 1 FROM json_each(new.locator_json)
       WHERE key NOT IN ('pageStart', 'pageEnd', 'section', 'startOffset', 'endOffset')
    ) OR
    EXISTS (
      SELECT 1 FROM json_each(new.citation_metadata_json)
       WHERE key NOT IN ('citationNumber', 'label')
    ) OR
    (json_type(new.locator_json, '$.pageStart') IS NOT NULL AND (
      json_type(new.locator_json, '$.pageStart') <> 'integer' OR
      json_extract(new.locator_json, '$.pageStart') <= 0
    )) OR
    (json_type(new.locator_json, '$.pageEnd') IS NOT NULL AND (
      json_type(new.locator_json, '$.pageEnd') <> 'integer' OR
      json_extract(new.locator_json, '$.pageEnd') <= 0 OR
      json_type(new.locator_json, '$.pageStart') IS NULL OR
      json_extract(new.locator_json, '$.pageEnd') <
        json_extract(new.locator_json, '$.pageStart')
    )) OR
    (json_type(new.locator_json, '$.section') IS NOT NULL AND (
      json_type(new.locator_json, '$.section') <> 'text' OR
      length(json_extract(new.locator_json, '$.section')) NOT BETWEEN 1 AND 500
    )) OR
    ((json_type(new.locator_json, '$.startOffset') IS NULL) <>
     (json_type(new.locator_json, '$.endOffset') IS NULL)) OR
    (json_type(new.locator_json, '$.startOffset') IS NOT NULL AND (
      json_type(new.locator_json, '$.startOffset') <> 'integer' OR
      json_type(new.locator_json, '$.endOffset') <> 'integer' OR
      json_extract(new.locator_json, '$.startOffset') < 0 OR
      json_extract(new.locator_json, '$.endOffset') <
        json_extract(new.locator_json, '$.startOffset')
    )) OR
    (json_type(new.citation_metadata_json, '$.citationNumber') IS NOT NULL AND (
      json_type(new.citation_metadata_json, '$.citationNumber') <> 'integer' OR
      json_extract(new.citation_metadata_json, '$.citationNumber') <= 0
    )) OR
    (json_type(new.citation_metadata_json, '$.label') IS NOT NULL AND (
      json_type(new.citation_metadata_json, '$.label') <> 'text' OR
      length(json_extract(new.citation_metadata_json, '$.label')) NOT BETWEEN 1 AND 500
    ))
`;

const JSON_BOUNDARY_TRIGGER_SQL = `
CREATE TRIGGER message_sources_v5_json_insert
BEFORE INSERT ON message_sources BEGIN
  SELECT CASE WHEN
${SOURCE_METADATA_INVALID_SQL} OR
    new.migration_issue_code IS NOT NULL
    THEN RAISE(ABORT, 'assistant source metadata contains unsupported fields')
  END;
END;

CREATE TRIGGER message_sources_v5_json_update
BEFORE UPDATE OF locator_json, citation_metadata_json ON message_sources BEGIN
  SELECT CASE WHEN
${SOURCE_METADATA_INVALID_SQL}
    THEN RAISE(ABORT, 'assistant source metadata contains unsupported fields')
  END;
END;

CREATE TRIGGER message_sources_v5_migration_issue_immutable
BEFORE UPDATE OF migration_issue_code ON message_sources BEGIN
  SELECT CASE WHEN new.migration_issue_code IS NOT old.migration_issue_code
    THEN RAISE(ABORT, 'assistant source migration issue is immutable')
  END;
END;

CREATE TRIGGER message_sources_immutable
BEFORE UPDATE ON message_sources BEGIN
  SELECT RAISE(ABORT, 'assistant message sources are immutable');
END;
`;

const RELATIONSHIP_TRIGGER_SQL = `
CREATE TRIGGER message_sources_integrity_insert
BEFORE INSERT ON message_sources BEGIN
  SELECT CASE WHEN new.quote IS NULL OR
                        length(trim(new.quote)) NOT BETWEEN 1 AND 8000 OR
                        new.start_offset IS NULL OR new.end_offset IS NULL
    THEN RAISE(ABORT, 'assistant message source quote and offsets are required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM document_versions version
      JOIN documents document ON document.id = version.document_id
     WHERE version.id = new.version_id
       AND version.document_id = new.document_id
       AND version.deleted_at IS NULL
       AND document.deleted_at IS NULL
       AND new.filename_snapshot = version.filename
  ) THEN RAISE(ABORT, 'message source version must be an active version of its document') END;
  SELECT CASE WHEN new.chunk_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_chunks chunk
     WHERE chunk.id = new.chunk_id
       AND chunk.document_id = new.document_id
       AND chunk.version_id = new.version_id
  ) THEN RAISE(ABORT, 'message source chunk must belong to its version') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM chat_messages message
      JOIN chats chat ON chat.id = message.chat_id
      JOIN documents document ON document.id = new.document_id
     WHERE message.id = new.message_id
       AND document.project_id IS NOT chat.project_id
  ) THEN RAISE(ABORT, 'chat source must remain in the chat scope') END;
END;

CREATE TRIGGER message_sources_integrity_update
BEFORE UPDATE OF message_id, document_id, version_id, chunk_id ON message_sources BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM document_versions version
      JOIN documents document ON document.id = version.document_id
     WHERE version.id = new.version_id
       AND version.document_id = new.document_id
       AND version.deleted_at IS NULL
       AND document.deleted_at IS NULL
  ) THEN RAISE(ABORT, 'message source version must be an active version of its document') END;
  SELECT CASE WHEN new.chunk_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_chunks chunk
     WHERE chunk.id = new.chunk_id
       AND chunk.document_id = new.document_id
       AND chunk.version_id = new.version_id
  ) THEN RAISE(ABORT, 'message source chunk must belong to its version') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM chat_messages message
      JOIN chats chat ON chat.id = message.chat_id
      JOIN documents document ON document.id = new.document_id
     WHERE message.id = new.message_id
       AND document.project_id IS NOT chat.project_id
  ) THEN RAISE(ABORT, 'chat source must remain in the chat scope') END;
END;

CREATE TRIGGER document_versions_integrity_update
BEFORE UPDATE OF id, document_id ON document_versions BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM documents document
     WHERE document.current_version_id = old.id
       AND document.id <> new.document_id
  ) THEN RAISE(ABORT, 'current document version ownership cannot change') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM message_sources source
     WHERE source.version_id = old.id
       AND (new.id IS NOT old.id OR source.document_id <> new.document_id)
  ) THEN RAISE(ABORT, 'message source version ownership cannot change') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM chat_message_attachments attachment
     WHERE attachment.version_id = old.id
       AND (new.id IS NOT old.id OR attachment.document_id <> new.document_id)
  ) THEN RAISE(ABORT, 'assistant attachment version ownership cannot change') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM assistant_generation_documents snapshot_document
     WHERE snapshot_document.version_id = old.id
       AND (
         new.id IS NOT old.id OR
         snapshot_document.document_id <> new.document_id
       )
  ) THEN RAISE(ABORT, 'assistant generation version ownership cannot change') END;
END;

CREATE TRIGGER chats_source_scope_update
BEFORE UPDATE OF project_id, scope ON chats BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM chat_messages message
      JOIN message_sources source ON source.message_id = message.id
      JOIN documents document ON document.id = source.document_id
     WHERE message.chat_id = old.id
       AND document.project_id IS NOT new.project_id
  ) THEN RAISE(ABORT, 'project chat sources must remain in the same project') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM chat_messages message
      JOIN chat_message_attachments attachment
        ON attachment.message_id = message.id
      JOIN documents document ON document.id = attachment.document_id
     WHERE message.chat_id = old.id
       AND document.project_id IS NOT new.project_id
  ) THEN RAISE(ABORT, 'chat attachments must remain in the same project') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM assistant_generation_snapshots snapshot
      JOIN assistant_generation_documents snapshot_document
        ON snapshot_document.job_id = snapshot.job_id
      JOIN documents document ON document.id = snapshot_document.document_id
     WHERE snapshot.chat_id = old.id
       AND document.project_id IS NOT new.project_id
  ) THEN RAISE(ABORT, 'assistant generation documents must remain in the chat scope') END;
END;

CREATE TRIGGER documents_assistant_scope_update
BEFORE UPDATE OF id, project_id ON documents BEGIN
  SELECT CASE WHEN new.id IS NOT old.id AND (
    EXISTS (SELECT 1 FROM message_sources source WHERE source.document_id = old.id) OR
    EXISTS (
      SELECT 1 FROM chat_message_attachments attachment
       WHERE attachment.document_id = old.id
    ) OR
    EXISTS (
      SELECT 1 FROM assistant_generation_documents snapshot_document
       WHERE snapshot_document.document_id = old.id
    )
  ) THEN RAISE(ABORT, 'assistant document snapshot identity cannot change') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM message_sources source
      JOIN chat_messages message ON message.id = source.message_id
      JOIN chats chat ON chat.id = message.chat_id
     WHERE source.document_id = old.id
       AND new.project_id IS NOT chat.project_id
  ) THEN RAISE(ABORT, 'document project must preserve assistant source scope') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM chat_message_attachments attachment
      JOIN chat_messages message ON message.id = attachment.message_id
      JOIN chats chat ON chat.id = message.chat_id
     WHERE attachment.document_id = old.id
       AND new.project_id IS NOT chat.project_id
  ) THEN RAISE(ABORT, 'document project must preserve assistant attachment scope') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM assistant_generation_documents snapshot_document
      JOIN assistant_generation_snapshots snapshot
        ON snapshot.job_id = snapshot_document.job_id
      JOIN chats chat ON chat.id = snapshot.chat_id
     WHERE snapshot_document.document_id = old.id
       AND new.project_id IS NOT chat.project_id
  ) THEN RAISE(ABORT, 'document project must preserve assistant generation scope') END;
END;

CREATE TRIGGER document_chunks_integrity_update
BEFORE UPDATE OF id, document_id, version_id ON document_chunks BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM message_sources source
     WHERE source.chunk_id = old.id
       AND (
         source.document_id <> new.document_id OR
         source.version_id <> new.version_id
       )
  ) THEN RAISE(ABORT, 'message source chunk ownership cannot change') END;
END;

CREATE TRIGGER chat_message_attachments_integrity_insert
BEFORE INSERT ON chat_message_attachments BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM document_versions version
      JOIN documents document ON document.id = version.document_id
      JOIN chat_messages message ON message.id = new.message_id
      JOIN chats chat ON chat.id = message.chat_id
     WHERE version.id = new.version_id
       AND version.document_id = new.document_id
       AND version.deleted_at IS NULL
       AND document.deleted_at IS NULL
       AND document.current_version_id = version.id
       AND document.project_id IS chat.project_id
       AND new.filename_snapshot = version.filename
       AND new.mime_type_snapshot = version.mime_type
  ) THEN RAISE(ABORT, 'chat attachment must snapshot a current document in the chat scope') END;
END;

CREATE TRIGGER chat_message_attachments_immutable
BEFORE UPDATE ON chat_message_attachments BEGIN
  SELECT RAISE(ABORT, 'chat attachment snapshots are immutable');
END;

CREATE TRIGGER assistant_generation_snapshots_integrity_insert
BEFORE INSERT ON assistant_generation_snapshots BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM jobs job
      JOIN chat_messages prompt ON prompt.id = new.prompt_message_id
      JOIN chat_messages output ON output.id = new.output_message_id
     WHERE job.id = new.job_id
       AND job.type = 'assistant_generate'
       AND job.resource_type = 'chat'
       AND job.resource_id = new.chat_id
       AND prompt.chat_id = new.chat_id
       AND prompt.role = 'user'
       AND output.chat_id = new.chat_id
       AND output.role = 'assistant'
       AND output.job_id = new.job_id
       AND output.status = 'pending'
       AND EXISTS (
         SELECT 1 FROM model_profiles profile
          WHERE profile.id = new.model_profile_id AND profile.enabled = 1
       )
  ) THEN RAISE(ABORT, 'assistant generation snapshot relationships are invalid') END;
END;

CREATE TRIGGER assistant_generation_snapshots_immutable
BEFORE UPDATE ON assistant_generation_snapshots BEGIN
  SELECT RAISE(ABORT, 'assistant generation snapshots are immutable');
END;

CREATE TRIGGER assistant_generation_documents_integrity_insert
BEFORE INSERT ON assistant_generation_documents BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM assistant_generation_snapshots snapshot
      JOIN chats chat ON chat.id = snapshot.chat_id
      JOIN documents document ON document.id = new.document_id
      JOIN document_versions version
        ON version.id = new.version_id AND version.document_id = document.id
     WHERE snapshot.job_id = new.job_id
       AND document.deleted_at IS NULL
       AND version.deleted_at IS NULL
       AND document.current_version_id = version.id
       AND document.project_id IS chat.project_id
  ) THEN RAISE(ABORT, 'assistant generation document is outside the chat scope or not current') END;
  SELECT CASE WHEN new.attached = 1 AND NOT EXISTS (
    SELECT 1
      FROM assistant_generation_snapshots snapshot
      JOIN chat_message_attachments attachment
        ON attachment.message_id = snapshot.prompt_message_id
       AND attachment.document_id = new.document_id
       AND attachment.version_id = new.version_id
     WHERE snapshot.job_id = new.job_id
  ) THEN RAISE(ABORT, 'assistant generation attached document lacks an immutable message attachment') END;
END;

CREATE TRIGGER assistant_generation_documents_immutable
BEFORE UPDATE ON assistant_generation_documents BEGIN
  SELECT RAISE(ABORT, 'assistant generation document snapshots are immutable');
END;

CREATE TRIGGER assistant_generation_prompt_immutable
BEFORE UPDATE OF chat_id, role, content ON chat_messages
WHEN EXISTS (
  SELECT 1 FROM assistant_generation_snapshots snapshot
   WHERE snapshot.prompt_message_id = old.id
) BEGIN
  SELECT RAISE(ABORT, 'assistant generation prompts are immutable');
END;
`;

const LEGACY_LOCATOR_POLICY =
  "legacy-locator-v1:recursive-sensitive-data-redaction;unknown-fields-require-review;allowed=pageStart,pageEnd,section,startOffset,endOffset;strict-integer-ranges";
const LEGACY_CITATION_ORDER_POLICY =
  "legacy-citation-order-v1:rank-ascending;null-rank-last;created-at-ascending;id-ascending;continuous-zero-based-ordinal;citation-number=ordinal+1;immutable-filename-snapshot";
const LOCATOR_REDACTION_CODE = "workspace_migration_source_locator_redacted";
const LOCATOR_REVIEW_CODE =
  "workspace_migration_source_locator_requires_review";
const LEGACY_LOCATOR_KEYS = new Set([
  "pageStart",
  "pageEnd",
  "section",
  "startOffset",
  "endOffset",
]);

function containsSensitiveLegacyValue(value: unknown, key = ""): boolean {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (
    normalizedKey.endsWith("path") ||
    /(?:localpath|storagepath|filepath|secret|token|apikey|credential|password|authorization|bearer)/.test(
      normalizedKey,
    )
  ) {
    return true;
  }
  if (typeof value === "string") {
    return (
      /^(?:file:|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private|etc|opt|mnt|Volumes)(?:\/|$))/i.test(
        value,
      ) ||
      /(?:api[_ -]?key|secret|password|credential)\s*[:=]/i.test(value) ||
      /(?:https?|wss?):\/\/[^/\s:@]+:[^@\s/]+@/i.test(value) ||
      /[?&](?:api[_-]?key|token|secret|credential|password)=/i.test(value) ||
      /\bbearer\s+\S+/i.test(value) ||
      /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value) ||
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
    );
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveLegacyValue(item));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([childKey, child]) => containsSensitiveLegacyValue(child, childKey),
    );
  }
  return false;
}

function canonicalLegacyLocator(raw: unknown): {
  json: string;
  issueCode: string | null;
} {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      containsSensitiveLegacyValue(parsed)
    ) {
      throw new Error("unsafe legacy locator");
    }
    const source = parsed as Record<string, unknown>;
    const hasUnknownFields = Object.keys(source).some(
      (key) => !LEGACY_LOCATOR_KEYS.has(key),
    );
    const canonical: Record<string, string | number> = {};
    for (const key of ["pageStart", "pageEnd"] as const) {
      if (source[key] === undefined) continue;
      if (
        typeof source[key] !== "number" ||
        !Number.isSafeInteger(source[key]) ||
        source[key] <= 0
      ) {
        throw new Error("invalid page locator");
      }
      canonical[key] = source[key];
    }
    if (source.pageEnd !== undefined && source.pageStart === undefined) {
      throw new Error("pageEnd requires pageStart");
    }
    if (
      typeof source.pageStart === "number" &&
      typeof source.pageEnd === "number" &&
      source.pageEnd < source.pageStart
    ) {
      throw new Error("invalid page range");
    }
    if (source.section !== undefined) {
      if (
        typeof source.section !== "string" ||
        source.section.length < 1 ||
        source.section.length > 500
      ) {
        throw new Error("invalid section");
      }
      canonical.section = source.section;
    }
    const hasStartOffset = source.startOffset !== undefined;
    const hasEndOffset = source.endOffset !== undefined;
    if (hasStartOffset !== hasEndOffset) {
      throw new Error("locator offsets must be paired");
    }
    if (hasStartOffset && hasEndOffset) {
      if (
        typeof source.startOffset !== "number" ||
        !Number.isSafeInteger(source.startOffset) ||
        source.startOffset < 0 ||
        typeof source.endOffset !== "number" ||
        !Number.isSafeInteger(source.endOffset) ||
        source.endOffset < source.startOffset
      ) {
        throw new Error("invalid locator offsets");
      }
      canonical.startOffset = source.startOffset;
      canonical.endOffset = source.endOffset;
    }
    return {
      json: JSON.stringify(canonical),
      issueCode: hasUnknownFields ? LOCATOR_REVIEW_CODE : null,
    };
  } catch {
    return { json: "{}", issueCode: LOCATOR_REDACTION_CODE };
  }
}

function applyAssistantRuntime(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error(
      "Workspace assistant runtime requires SQLite JSON1 for safe metadata boundaries.",
    );
  }
  const legacyLocators = database
    .prepare("SELECT id,locator_json FROM message_sources ORDER BY id")
    .all()
    .map((row) => ({
      id: String(row.id),
      locator: canonicalLegacyLocator(row.locator_json),
    }));
  const legacySourceCount = Number(
    database.prepare("SELECT count(*) AS count FROM message_sources").get()
      ?.count ?? 0,
  );
  database.exec(MESSAGE_SOURCES_V5_SQL);
  const sourcePostcondition = database
    .prepare(
      `SELECT message_id
         FROM message_sources
        GROUP BY message_id
       HAVING min(citation_ordinal) <> 0
           OR max(citation_ordinal) <> count(*) - 1
           OR count(DISTINCT citation_ordinal) <> count(*)
           OR sum(
                CASE
                  WHEN json_type(citation_metadata_json, '$.citationNumber') = 'integer'
                   AND json_extract(citation_metadata_json, '$.citationNumber') = citation_ordinal + 1
                  THEN 0 ELSE 1
                END
              ) <> 0
        LIMIT 1`,
    )
    .get();
  const migratedSourceCount = Number(
    database.prepare("SELECT count(*) AS count FROM message_sources").get()
      ?.count ?? 0,
  );
  if (migratedSourceCount !== legacySourceCount || sourcePostcondition) {
    throw new Error(
      "Workspace assistant citation migration postcondition failed.",
    );
  }
  const updateLocator = database.prepare(
    "UPDATE message_sources SET locator_json=?,migration_issue_code=? WHERE id=?",
  );
  for (const legacy of legacyLocators) {
    updateLocator.run(legacy.locator.json, legacy.locator.issueCode, legacy.id);
  }
  database.exec(ASSISTANT_SCHEMA_SQL);
  database.exec(JSON_BOUNDARY_TRIGGER_SQL);
  database.exec(RELATIONSHIP_TRIGGER_SQL);
  database.exec(LEGACY_ASSISTANT_JOB_RECOVERY_SQL);
}

export const ASSISTANT_RUNTIME_MIGRATION: WorkspaceMigration = {
  version: 5,
  name: "assistant_runtime_snapshots_and_citations",
  checksumMaterial: [
    "workspace-migration-v5",
    "message-source-constraint-correction-with-canonical-locator-migration",
    LEGACY_LOCATOR_POLICY,
    LEGACY_CITATION_ORDER_POLICY,
    MESSAGE_SOURCES_V5_SQL,
    ASSISTANT_SCHEMA_SQL,
    LEGACY_ASSISTANT_JOB_RECOVERY_SQL,
    SOURCE_METADATA_INVALID_SQL,
    JSON_BOUNDARY_TRIGGER_SQL,
    RELATIONSHIP_TRIGGER_SQL,
    containsSensitiveLegacyValue.toString(),
    canonicalLegacyLocator.toString(),
    applyAssistantRuntime.toString(),
  ].join("\n-- checksum boundary --\n"),
  apply: applyAssistantRuntime,
};
