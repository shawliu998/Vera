import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";
import {
  TABULAR_PERSISTED_V7_CONTRACT,
  TABULAR_PERSISTENCE_VALIDATOR_FINGERPRINT,
  validateTabularPersistenceV7,
} from "../tabularPersistenceV7";
import { TABULAR_CONTRACT_V7_MANIFEST } from "../tabularContractV7";
import {
  WORKSPACE_SQLCIPHER_CONNECTION_POLICY_MATERIAL,
  isWorkspaceConnectionSqlcipherEncrypted,
} from "./encryptionPolicy";

const sqlStringList = (values: readonly string[]) =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
const MIKE_FORMAT_CHECK = `format IN (${sqlStringList(
  TABULAR_CONTRACT_V7_MANIFEST.enums.formats,
)})`;
const TABULAR_OUTPUT_TYPES_SQL = sqlStringList(
  TABULAR_CONTRACT_V7_MANIFEST.enums.outputTypes,
);
const TABULAR_CELL_FLAGS_SQL = sqlStringList(
  TABULAR_CONTRACT_V7_MANIFEST.enums.flags,
);
const TABULAR_CONTENT_KEYS_SQL = sqlStringList(
  TABULAR_CONTRACT_V7_MANIFEST.content.keys,
);
const TABULAR_CHAT_STATUSES_SQL = sqlStringList(
  TABULAR_CONTRACT_V7_MANIFEST.enums.chatStatuses,
);
const ACTIVE_CELL_STATUSES_SQL = sqlStringList(["queued", "running"]);
const TERMINAL_ERROR_JOB_STATUSES_SQL = sqlStringList([
  "failed",
  "interrupted",
]);
const PENDING_MESSAGE_STATUSES_SQL = sqlStringList(["pending", "streaming"]);
const MAX_TABULAR_CELL_CONTENT_CHARS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.cellContent;
const MAX_TABULAR_REVIEW_TITLE_CODE_POINTS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.reviewTitle;
const MAX_TABULAR_COLUMN_KEY_CODE_POINTS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.columnKey;
const MAX_TABULAR_COLUMN_TITLE_CODE_POINTS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.columnTitle;
const MAX_TABULAR_COLUMN_PROMPT_CODE_POINTS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.columnPrompt;
const MAX_TABULAR_TAG_CODE_POINTS = TABULAR_CONTRACT_V7_MANIFEST.limits.tag;
const MAX_TABULAR_TAGS = TABULAR_CONTRACT_V7_MANIFEST.limits.tags;
const MAX_TABULAR_SOURCE_QUOTE_CODE_POINTS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.sourceQuote;
const MAX_TABULAR_REVIEW_DOCUMENTS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.reviewDocuments;
const MAX_TABULAR_REVIEW_COLUMNS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.reviewColumns;
const MAX_TABULAR_REVIEW_CELLS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.reviewCells;
const MAX_TABULAR_SOURCE_REFS = TABULAR_CONTRACT_V7_MANIFEST.limits.sourceRefs;
const MAX_TABULAR_CHAT_ANNOTATIONS =
  TABULAR_CONTRACT_V7_MANIFEST.limits.chatAnnotations;
const LEGACY_TAGS_INVALID = "tabular_legacy_tags_invalid";
const LEGACY_CONTENT_REQUIRES_REVIEW = "tabular_legacy_content_requires_review";
const LEGACY_FAILED_WITHOUT_ERROR = "tabular_legacy_failed_without_error";
const TABULAR_REGENERATION_REQUIRED =
  "workspace_migration_tabular_regeneration_required";
const V7_NUL_REPLACEMENT = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.replacement;
const V7_NUL_RECOVERY_SCHEMA = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.schema;
const V7_NUL_RECOVERY_TABLE = TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.table;
const V7_NUL_RECOVERY_LOCK_INSERT_TRIGGER =
  TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lockTriggers.insert;
const V7_NUL_RECOVERY_LOCK_UPDATE_TRIGGER =
  TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lockTriggers.update;
const V7_NUL_RECOVERY_LOCK_DELETE_TRIGGER =
  TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lockTriggers.delete;
const V7_NUL_RECOVERY_REVIEW_DELETE_PURGE_TRIGGER =
  TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.lifecycleTriggers.reviewDeletePurge;
const V7_REVIEW_TITLE_INSERT_TRIGGER =
  TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.liveWriteTriggers.reviewTitleInsert;
const V7_REVIEW_TITLE_UPDATE_TRIGGER =
  TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.liveWriteTriggers.reviewTitleUpdate;
const V7_COLUMN_TEXT_INSERT_TRIGGER =
  TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.liveWriteTriggers.columnTextInsert;
const V7_COLUMN_TEXT_UPDATE_TRIGGER =
  TABULAR_CONTRACT_V7_MANIFEST.nulRecovery.liveWriteTriggers.columnTextUpdate;
function unicodeCodePointLengthSql(expression: string) {
  return `length(${expression})`;
}

function unicodeNoNulSql(expression: string) {
  return `instr(CAST(${expression} AS BLOB), x'00') = 0`;
}

function unicodeMaxCodePointsSql(expression: string, maxCodePoints: number) {
  return `(${unicodeNoNulSql(expression)} AND ${unicodeCodePointLengthSql(expression)} <= ${maxCodePoints})`;
}

function unicodeNonBlankMaxCodePointsSql(
  expression: string,
  maxCodePoints: number,
) {
  return `(${unicodeMaxCodePointsSql(expression, maxCodePoints)} AND ${unicodeCodePointLengthSql(`trim(${expression})`)} >= 1)`;
}

function jsonStringArraySql(
  expression: string,
  options: { nullable: boolean; minItems?: number; maxItems: number },
) {
  const base = `
    json_valid(${expression}) AND
    json_type(${expression}) = 'array' AND
    json_array_length(${expression}) >= ${options.minItems ?? 0} AND
    json_array_length(${expression}) <= ${options.maxItems} AND
    NOT EXISTS (
      SELECT 1 FROM json_each(${expression}) tag
       WHERE tag.type <> 'text'
          OR NOT ${unicodeNonBlankMaxCodePointsSql("tag.value", MAX_TABULAR_TAG_CODE_POINTS)}
    )
  `;
  return options.nullable
    ? `(${expression} IS NULL OR (${base}))`
    : `(${base})`;
}

const LEGACY_FAILED_ERROR_JSON_SQL = `
  json_object(
    'code', '${LEGACY_FAILED_WITHOUT_ERROR}',
    'message', 'Legacy tabular cell failed before workspace schema v7 migration.',
    'retryable', json('false'),
    'details', json('null')
  )
`;
const LEGACY_FAILED_ERROR_JSON_TEXT = JSON.stringify({
  code: LEGACY_FAILED_WITHOUT_ERROR,
  message: "Legacy tabular cell failed before workspace schema v7 migration.",
  retryable: false,
  details: null,
});
const LEGACY_CONTENT_REQUIRES_REVIEW_ERROR_JSON_SQL = `
  json_object(
    'code', '${LEGACY_CONTENT_REQUIRES_REVIEW}',
    'message', 'Legacy tabular cell content requires manual review after workspace schema v7 migration.',
    'retryable', json('false'),
    'details', json_object(
      'issueCode', '${LEGACY_CONTENT_REQUIRES_REVIEW}'
    )
  )
`;
const LEGACY_CONTENT_REQUIRES_REVIEW_ERROR_JSON_TEXT = JSON.stringify({
  code: LEGACY_CONTENT_REQUIRES_REVIEW,
  message:
    "Legacy tabular cell content requires manual review after workspace schema v7 migration.",
  retryable: false,
  details: { issueCode: LEGACY_CONTENT_REQUIRES_REVIEW },
});
const TABULAR_REGENERATION_REQUIRED_ERROR_JSON_SQL = `
  json_object(
    'code', '${TABULAR_REGENERATION_REQUIRED}',
    'message', 'Tabular cell generation must be explicitly regenerated after workspace schema v7 migration.',
    'retryable', json('false'),
    'details', json('null')
  )
`;
const TABULAR_REGENERATION_REQUIRED_ERROR_JSON_TEXT = JSON.stringify({
  code: TABULAR_REGENERATION_REQUIRED,
  message:
    "Tabular cell generation must be explicitly regenerated after workspace schema v7 migration.",
  retryable: false,
  details: null,
});
const V7_JOB_DESTRUCTIVE_TARGETS = {
  fields: [
    "payload_json",
    "result_json",
    "error_code",
    "error_json",
    "lease_owner",
    "cancellation_reason",
  ],
  statusBranches: {
    queued: {
      payloadJson: "{}",
      resultJson: null,
      errorCode: TABULAR_REGENERATION_REQUIRED,
      errorJson: TABULAR_REGENERATION_REQUIRED_ERROR_JSON_TEXT,
      leaseOwner: null,
      cancellationReason: null,
    },
    running: {
      payloadJson: "{}",
      resultJson: null,
      errorCode: TABULAR_REGENERATION_REQUIRED,
      errorJson: TABULAR_REGENERATION_REQUIRED_ERROR_JSON_TEXT,
      leaseOwner: null,
      cancellationReason: null,
    },
    failed: {
      payloadJson: "{}",
      resultJson: null,
      errorCode: TABULAR_REGENERATION_REQUIRED,
      errorJson: TABULAR_REGENERATION_REQUIRED_ERROR_JSON_TEXT,
      leaseOwner: null,
      cancellationReason: null,
    },
    interrupted: {
      payloadJson: "{}",
      resultJson: null,
      errorCode: TABULAR_REGENERATION_REQUIRED,
      errorJson: TABULAR_REGENERATION_REQUIRED_ERROR_JSON_TEXT,
      leaseOwner: null,
      cancellationReason: null,
    },
    complete: {
      payloadJson: "{}",
      resultJson: "{}",
      errorCode: null,
      errorJson: null,
      leaseOwner: null,
      cancellationReason: null,
    },
    cancelled: {
      payloadJson: "{}",
      resultJson: null,
      errorCode: null,
      errorJson: null,
      leaseOwner: null,
      cancellationReason: "preserve",
    },
  },
} as const;
const V7_CELL_DESTRUCTIVE_TARGETS = {
  fields: ["error_code", "error_json"],
  branches: {
    active: {
      statuses: ["queued", "running"],
      errorCode: TABULAR_REGENERATION_REQUIRED,
      errorJson: TABULAR_REGENERATION_REQUIRED_ERROR_JSON_TEXT,
    },
    preservedLegacyFailed: {
      source: "pre-v7 status='failed'",
      errorCode: LEGACY_FAILED_WITHOUT_ERROR,
      errorJson: LEGACY_FAILED_ERROR_JSON_TEXT,
    },
    requiresReview: {
      source:
        "invalid content, invalid citations, invalid enum value, missing complete content, or unsafe value_json",
      errorCode: LEGACY_CONTENT_REQUIRES_REVIEW,
      errorJson: LEGACY_CONTENT_REQUIRES_REVIEW_ERROR_JSON_TEXT,
    },
    nonFailedFinal: {
      errorCode: null,
      errorJson: null,
    },
  },
} as const;
const LEGACY_ENUM_SAFE_JSON =
  "CASE WHEN enum_values_json IS NOT NULL AND json_valid(enum_values_json) THEN enum_values_json ELSE '[]' END";
const LEGACY_ENUM_IS_VALID_TAGS = `
  enum_values_json IS NOT NULL
  AND json_valid(enum_values_json)
  AND json_type(${LEGACY_ENUM_SAFE_JSON}) = 'array'
  AND json_array_length(${LEGACY_ENUM_SAFE_JSON}) BETWEEN 1 AND ${MAX_TABULAR_TAGS}
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${LEGACY_ENUM_SAFE_JSON})
     WHERE type <> 'text'
        OR NOT ${unicodeNonBlankMaxCodePointsSql("value", MAX_TABULAR_TAG_CODE_POINTS)}
  )
`;
const LEGACY_CONTENT_SAFE_JSON =
  "CASE WHEN content IS NOT NULL AND json_valid(content) THEN content ELSE '{}' END";
const LEGACY_VALUE_JSON_TYPE =
  "CASE WHEN value_json IS NOT NULL AND json_valid(value_json) THEN json_type(value_json, '$') ELSE 'invalid' END";
const LEGACY_VALUE_SUMMARY = `
  CASE ${LEGACY_VALUE_JSON_TYPE}
    WHEN 'true' THEN 'Yes'
    WHEN 'false' THEN 'No'
    WHEN 'integer' THEN CAST(json_extract(value_json, '$') AS TEXT)
    WHEN 'real' THEN CAST(json_extract(value_json, '$') AS TEXT)
    WHEN 'text' THEN json_extract(value_json, '$')
    ELSE ''
  END
`;
const LEGACY_VALUE_IS_DIRECT_SUMMARY = `
  value_json IS NOT NULL
  AND json_valid(value_json)
  AND ${LEGACY_VALUE_JSON_TYPE} IN ('true', 'false', 'integer', 'real', 'text', 'null')
  AND (
    ${LEGACY_VALUE_JSON_TYPE} NOT IN ('integer', 'real') OR
    json_extract(value_json, '$') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
  )
  AND ${unicodeMaxCodePointsSql(LEGACY_VALUE_SUMMARY, MAX_TABULAR_CELL_CONTENT_CHARS)}
`;
const LEGACY_VALUE_REQUIRES_REVIEW = `
  value_json IS NOT NULL
  AND NOT (${LEGACY_VALUE_IS_DIRECT_SUMMARY})
`;
const LEGACY_CONTENT_IS_STRICT = `
  content IS NOT NULL
  AND json_valid(content)
  AND json_type(${LEGACY_CONTENT_SAFE_JSON}) = 'object'
  AND (
    SELECT count(*) FROM json_each(${LEGACY_CONTENT_SAFE_JSON})
  ) = (
    SELECT count(DISTINCT key) FROM json_each(${LEGACY_CONTENT_SAFE_JSON})
  )
  AND json_type(${LEGACY_CONTENT_SAFE_JSON}, '$.summary') = 'text'
  AND ${unicodeMaxCodePointsSql(`json_extract(${LEGACY_CONTENT_SAFE_JSON}, '$.summary')`, MAX_TABULAR_CELL_CONTENT_CHARS)}
  AND (
    NOT EXISTS (SELECT 1 FROM json_each(${LEGACY_CONTENT_SAFE_JSON}) WHERE key = 'flag') OR
    (
      json_type(${LEGACY_CONTENT_SAFE_JSON}, '$.flag') = 'text' AND
      json_extract(${LEGACY_CONTENT_SAFE_JSON}, '$.flag') IN (${TABULAR_CELL_FLAGS_SQL})
    )
  )
  AND (
    NOT EXISTS (SELECT 1 FROM json_each(${LEGACY_CONTENT_SAFE_JSON}) WHERE key = 'reasoning') OR
    (
      json_type(${LEGACY_CONTENT_SAFE_JSON}, '$.reasoning') = 'text' AND
      ${unicodeMaxCodePointsSql(`json_extract(${LEGACY_CONTENT_SAFE_JSON}, '$.reasoning')`, MAX_TABULAR_CELL_CONTENT_CHARS)}
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${LEGACY_CONTENT_SAFE_JSON})
     WHERE key NOT IN (${TABULAR_CONTENT_KEYS_SQL})
  )
`;
const LEGACY_CITATIONS_SAFE_JSON =
  "CASE WHEN citations_json IS NOT NULL AND json_valid(citations_json) THEN citations_json ELSE '[]' END";
const LEGACY_CITATIONS_IS_VALID = `
  citations_json IS NOT NULL
  AND json_valid(citations_json)
  AND json_type(${LEGACY_CITATIONS_SAFE_JSON}) = 'array'
  AND json_array_length(${LEGACY_CITATIONS_SAFE_JSON}) <= ${MAX_TABULAR_SOURCE_REFS}
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${LEGACY_CITATIONS_SAFE_JSON}) AS citation
     WHERE CASE
       WHEN citation.type <> 'object' THEN 1
       WHEN (
         SELECT count(*) FROM json_each(citation.value)
       ) <> (
         SELECT count(DISTINCT key) FROM json_each(citation.value)
       ) THEN 1
       WHEN EXISTS (
         SELECT 1 FROM json_each(citation.value) AS citation_key
          WHERE citation_key.key NOT IN (
            'documentId',
            'versionId',
            'chunkId',
            'quote',
            'startOffset',
            'endOffset'
          )
       ) THEN 1
       WHEN json_type(citation.value, '$.documentId') <> 'text' THEN 1
       WHEN json_extract(citation.value, '$.documentId') <> tabular_cells.document_id THEN 1
       WHEN NOT (
         json_type(citation.value, '$.versionId') IS NULL OR
         json_type(citation.value, '$.versionId') IN ('null', 'text')
       ) THEN 1
       WHEN NOT (
         json_type(citation.value, '$.chunkId') IS NULL OR
         json_type(citation.value, '$.chunkId') IN ('null', 'text')
       ) THEN 1
       WHEN json_type(citation.value, '$.chunkId') = 'text'
         AND json_type(citation.value, '$.versionId') <> 'text' THEN 1
       WHEN NOT EXISTS (
         SELECT 1 FROM documents document_row
          WHERE document_row.id = json_extract(citation.value, '$.documentId')
            AND document_row.deleted_at IS NULL
       ) THEN 1
       WHEN NOT (
         json_type(citation.value, '$.quote') IS NULL OR
         json_type(citation.value, '$.quote') = 'null' OR
         (
           json_type(citation.value, '$.quote') = 'text' AND
           ${unicodeNoNulSql("json_extract(citation.value, '$.quote')")} AND
           ${unicodeCodePointLengthSql("json_extract(citation.value, '$.quote')")} BETWEEN 1 AND ${MAX_TABULAR_SOURCE_QUOTE_CODE_POINTS}
         )
       ) THEN 1
       WHEN (
         (json_type(citation.value, '$.startOffset') IS NULL) <>
         (json_type(citation.value, '$.endOffset') IS NULL)
       ) THEN 1
       WHEN json_type(citation.value, '$.startOffset') IS NOT NULL
         AND NOT (
           json_type(citation.value, '$.startOffset') = 'integer' AND
           json_type(citation.value, '$.endOffset') = 'integer' AND
           json_extract(citation.value, '$.startOffset') >= 0 AND
           json_extract(citation.value, '$.endOffset') >=
             json_extract(citation.value, '$.startOffset') AND
           json_type(citation.value, '$.versionId') = 'text'
         ) THEN 1
       WHEN json_type(citation.value, '$.versionId') = 'text'
         AND NOT EXISTS (
           SELECT 1 FROM document_versions version
            WHERE version.id = json_extract(citation.value, '$.versionId')
              AND version.document_id = tabular_cells.document_id
              AND version.deleted_at IS NULL
         ) THEN 1
       WHEN json_type(citation.value, '$.chunkId') = 'text'
         AND NOT EXISTS (
           SELECT 1 FROM document_chunks chunk
            WHERE chunk.id = json_extract(citation.value, '$.chunkId')
              AND chunk.document_id = tabular_cells.document_id
              AND chunk.version_id = json_extract(citation.value, '$.versionId')
         ) THEN 1
       WHEN json_type(citation.value, '$.startOffset') IS NOT NULL
         AND json_type(citation.value, '$.chunkId') = 'text'
         AND NOT EXISTS (
           SELECT 1 FROM document_chunks chunk
            WHERE chunk.id = json_extract(citation.value, '$.chunkId')
              AND chunk.document_id = tabular_cells.document_id
              AND chunk.version_id = json_extract(citation.value, '$.versionId')
              AND json_extract(citation.value, '$.startOffset') >= chunk.start_offset
              AND json_extract(citation.value, '$.endOffset') <= chunk.end_offset
         ) THEN 1
       WHEN json_type(citation.value, '$.startOffset') IS NOT NULL
         AND (
           json_type(citation.value, '$.chunkId') IS NULL OR
           json_type(citation.value, '$.chunkId') = 'null'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM (
               SELECT min(chunk.start_offset) AS start_offset,
                      max(chunk.end_offset) AS end_offset
                 FROM document_chunks chunk
                WHERE chunk.document_id = tabular_cells.document_id
                  AND chunk.version_id = json_extract(citation.value, '$.versionId')
             ) bounds
            WHERE bounds.start_offset IS NOT NULL
              AND json_extract(citation.value, '$.startOffset') >= bounds.start_offset
              AND json_extract(citation.value, '$.endOffset') <= bounds.end_offset
         ) THEN 1
       ELSE 0
     END = 1
  )
`;
const LEGACY_CHAT_ANNOTATIONS_IS_VALID = `
  annotations_json IS NOT NULL
  AND json_valid(annotations_json)
  AND json_type(annotations_json) = 'array'
  AND json_array_length(annotations_json) <= ${MAX_TABULAR_CHAT_ANNOTATIONS}
`;
const V7_CONTENT_INSERT_TRIGGER = "tabular_cells_content_mike_insert";
const V7_CONTENT_UPDATE_TRIGGER = "tabular_cells_content_mike_update";
const V7_CITATIONS_INSERT_TRIGGER = "tabular_cells_citations_mike_insert";
const V7_CITATIONS_UPDATE_TRIGGER = "tabular_cells_citations_mike_update";
const V7_CONTENT_TRIGGER_REQUIRED_SQL = [
  `key NOT IN (${TABULAR_CONTENT_KEYS_SQL})`,
  "duplicate keys",
  "summary must be text",
  "flag is invalid",
  "reasoning is invalid",
] as const;
const V7_CITATIONS_TRIGGER_REQUIRED_SQL = [
  "citations must be an array",
  "citation source contains duplicate keys",
] as const;
const V7_NUL_RECOVERY_LOCK_REQUIRED_SQL = [
  "tabular v7 NUL recovery snapshots are immutable",
] as const;
const V7_NUL_RECOVERY_DELETE_LOCK_REQUIRED_SQL = [
  ...V7_NUL_RECOVERY_LOCK_REQUIRED_SQL,
  "FROM tabular_reviews",
  "id = old.review_id",
] as const;
const V7_NUL_RECOVERY_PURGE_REQUIRED_SQL = [
  "AFTER DELETE ON tabular_reviews",
  `DELETE FROM ${V7_NUL_RECOVERY_TABLE}`,
  "review_id = old.id",
] as const;
const V7_TEXT_TRIGGER_REQUIRED_SQL = [
  "NUL code points",
  "too long or blank",
] as const;
const V7_COLUMN_TEXT_TRIGGER_REQUIRED_SQL = [
  ...V7_TEXT_TRIGGER_REQUIRED_SQL,
  "enum values are invalid",
  "tags are invalid",
] as const;
const V7_SCHEMA_MARKERS = [
  {
    kind: "table",
    name: V7_NUL_RECOVERY_TABLE,
  },
  {
    kind: "column",
    table: "tabular_review_columns",
    name: "format",
    notNull: true,
  },
  {
    kind: "column",
    table: "tabular_review_columns",
    name: "tags_json",
    notNull: true,
  },
  {
    kind: "column",
    table: "tabular_review_columns",
    name: "legacy_output_type",
  },
  {
    kind: "column",
    table: "tabular_review_columns",
    name: "legacy_metadata_json",
    notNull: true,
  },
  { kind: "column", table: "tabular_review_chats", name: "user_id" },
  {
    kind: "column",
    table: "tabular_review_chats",
    name: "status",
    notNull: true,
  },
  { kind: "column", table: "tabular_review_chats", name: "job_id" },
  {
    kind: "column",
    table: "tabular_review_chats",
    name: "model_profile_id",
  },
  { kind: "column", table: "tabular_review_chat_messages", name: "job_id" },
  {
    kind: "column",
    table: "tabular_review_chat_messages",
    name: "model_profile_id",
  },
  {
    kind: "column",
    table: "tabular_review_chat_messages",
    name: "sources_json",
    notNull: true,
  },
  { kind: "column", table: "tabular_cells", name: "legacy_content" },
  {
    kind: "column",
    table: "tabular_cells",
    name: "legacy_content_issue_code",
  },
  {
    kind: "trigger",
    name: V7_CONTENT_INSERT_TRIGGER,
    requiredSql: V7_CONTENT_TRIGGER_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_CONTENT_UPDATE_TRIGGER,
    requiredSql: V7_CONTENT_TRIGGER_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_CITATIONS_INSERT_TRIGGER,
    requiredSql: V7_CITATIONS_TRIGGER_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_CITATIONS_UPDATE_TRIGGER,
    requiredSql: V7_CITATIONS_TRIGGER_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_NUL_RECOVERY_LOCK_INSERT_TRIGGER,
    requiredSql: V7_NUL_RECOVERY_LOCK_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_NUL_RECOVERY_LOCK_UPDATE_TRIGGER,
    requiredSql: V7_NUL_RECOVERY_LOCK_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_NUL_RECOVERY_LOCK_DELETE_TRIGGER,
    requiredSql: V7_NUL_RECOVERY_DELETE_LOCK_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_NUL_RECOVERY_REVIEW_DELETE_PURGE_TRIGGER,
    requiredSql: V7_NUL_RECOVERY_PURGE_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_REVIEW_TITLE_INSERT_TRIGGER,
    requiredSql: V7_TEXT_TRIGGER_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_REVIEW_TITLE_UPDATE_TRIGGER,
    requiredSql: V7_TEXT_TRIGGER_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_COLUMN_TEXT_INSERT_TRIGGER,
    requiredSql: V7_COLUMN_TEXT_TRIGGER_REQUIRED_SQL,
  },
  {
    kind: "trigger",
    name: V7_COLUMN_TEXT_UPDATE_TRIGGER,
    requiredSql: V7_COLUMN_TEXT_TRIGGER_REQUIRED_SQL,
  },
] as const;
const V7_ACTIVE_REVIEW_DOCUMENT_POSTCONDITION_SQL = `
  SELECT review_document.review_id
    FROM tabular_review_documents review_document
    LEFT JOIN documents document_row
      ON document_row.id = review_document.document_id
   WHERE document_row.id IS NULL
      OR document_row.deleted_at IS NOT NULL
   LIMIT 1
`;
const V7_MATRIX_POSTCONDITION_SQL = `
  SELECT review.id
    FROM tabular_reviews review
    LEFT JOIN (
      SELECT review_id, COUNT(*) AS document_count
        FROM tabular_review_documents
       GROUP BY review_id
    ) review_documents ON review_documents.review_id = review.id
    LEFT JOIN (
      SELECT review_id, COUNT(*) AS column_count
        FROM tabular_review_columns
       GROUP BY review_id
    ) columns ON columns.review_id = review.id
    LEFT JOIN (
      SELECT review_id, COUNT(*) AS cell_count
        FROM tabular_cells
       GROUP BY review_id
    ) cells ON cells.review_id = review.id
   WHERE coalesce(cells.cell_count, 0) <>
         coalesce(review_documents.document_count, 0) *
         coalesce(columns.column_count, 0)
   LIMIT 1
`;
const V7_REVIEW_DOCUMENT_IDS_MIRROR_POSTCONDITION_SQL = `
  SELECT review.id
    FROM tabular_reviews review
   WHERE review.document_ids_json <> (
     SELECT coalesce(json_group_array(document_id), '[]')
       FROM (
         SELECT review_document.document_id
           FROM tabular_review_documents review_document
          WHERE review_document.review_id = review.id
          ORDER BY review_document.ordinal ASC, review_document.document_id ASC
       )
   )
   LIMIT 1
`;
const V7_CARDINALITY_POSTCONDITION_SQL = `
  SELECT review.id
    FROM tabular_reviews review
    LEFT JOIN (
      SELECT review_id, COUNT(*) AS document_count
        FROM tabular_review_documents
       GROUP BY review_id
    ) review_documents ON review_documents.review_id = review.id
    LEFT JOIN (
      SELECT review_id, COUNT(*) AS column_count
        FROM tabular_review_columns
       GROUP BY review_id
    ) columns ON columns.review_id = review.id
   WHERE coalesce(review_documents.document_count, 0) > ${MAX_TABULAR_REVIEW_DOCUMENTS}
      OR coalesce(columns.column_count, 0) > ${MAX_TABULAR_REVIEW_COLUMNS}
      OR (
        coalesce(review_documents.document_count, 0) *
        coalesce(columns.column_count, 0)
      ) > ${MAX_TABULAR_REVIEW_CELLS}
   LIMIT 1
`;
const V7_REVIEW_TEXT_BOUNDS_POSTCONDITION_SQL = `
  SELECT review.id
    FROM tabular_reviews review
   WHERE NOT ${unicodeNonBlankMaxCodePointsSql("review.title", MAX_TABULAR_REVIEW_TITLE_CODE_POINTS)}
   LIMIT 1
`;
const V7_COLUMN_TEXT_BOUNDS_POSTCONDITION_SQL = `
  SELECT column_row.id
    FROM tabular_review_columns column_row
   WHERE NOT ${unicodeNonBlankMaxCodePointsSql("column_row.key", MAX_TABULAR_COLUMN_KEY_CODE_POINTS)}
      OR NOT ${unicodeNonBlankMaxCodePointsSql("column_row.title", MAX_TABULAR_COLUMN_TITLE_CODE_POINTS)}
      OR NOT ${unicodeMaxCodePointsSql("column_row.prompt", MAX_TABULAR_COLUMN_PROMPT_CODE_POINTS)}
      OR (
        column_row.enum_values_json IS NOT NULL AND (
          NOT json_valid(column_row.enum_values_json) OR
          json_type(column_row.enum_values_json) <> 'array' OR
          json_array_length(column_row.enum_values_json) > ${MAX_TABULAR_TAGS} OR
          EXISTS (
            SELECT 1 FROM json_each(column_row.enum_values_json) tag
             WHERE tag.type <> 'text'
                OR NOT ${unicodeNonBlankMaxCodePointsSql("tag.value", MAX_TABULAR_TAG_CODE_POINTS)}
          )
        )
      )
      OR (
        NOT json_valid(column_row.tags_json) OR
        json_type(column_row.tags_json) <> 'array' OR
        json_array_length(column_row.tags_json) > ${MAX_TABULAR_TAGS} OR
        EXISTS (
          SELECT 1 FROM json_each(column_row.tags_json) tag
           WHERE tag.type <> 'text'
              OR NOT ${unicodeNonBlankMaxCodePointsSql("tag.value", MAX_TABULAR_TAG_CODE_POINTS)}
        )
      )
   LIMIT 1
`;
const V7_CELL_INVARIANT_POSTCONDITION_SQL = `
  SELECT cell.id
    FROM tabular_cells cell
    LEFT JOIN documents document_row ON document_row.id = cell.document_id
    LEFT JOIN tabular_review_columns column_row ON column_row.id = cell.column_id
    LEFT JOIN tabular_review_documents review_document
      ON review_document.review_id = cell.review_id
     AND review_document.document_id = cell.document_id
   WHERE document_row.id IS NULL
      OR document_row.deleted_at IS NOT NULL
      OR column_row.id IS NULL
      OR review_document.document_id IS NULL
      OR column_row.output_type <> cell.output_type
      OR (
        cell.status <> 'failed' AND (
          cell.error_json IS NOT NULL OR
          cell.error_code IS NOT NULL
        )
      )
      OR (
        cell.status = 'complete' AND (
          cell.content IS NULL OR
          cell.completed_at IS NULL OR
          cell.error_json IS NOT NULL
        )
      )
      OR (
        cell.status = 'failed' AND (
          cell.error_code IS NULL OR
          cell.error_code <> json_extract(cell.error_json, '$.code') OR
          (
            cell.error_code = '${LEGACY_FAILED_WITHOUT_ERROR}' AND
            cell.error_json <> ${LEGACY_FAILED_ERROR_JSON_SQL}
          ) OR
          (
            cell.error_code = '${LEGACY_CONTENT_REQUIRES_REVIEW}' AND
            cell.error_json <> ${LEGACY_CONTENT_REQUIRES_REVIEW_ERROR_JSON_SQL}
          ) OR
          (
            cell.error_code = '${TABULAR_REGENERATION_REQUIRED}' AND
            cell.error_json <> ${TABULAR_REGENERATION_REQUIRED_ERROR_JSON_SQL}
          ) OR
          cell.error_code NOT IN (
            '${LEGACY_FAILED_WITHOUT_ERROR}',
            '${LEGACY_CONTENT_REQUIRES_REVIEW}',
            '${TABULAR_REGENERATION_REQUIRED}'
          )
        )
      )
      OR (
        cell.output_type = 'enum' AND
        cell.value_json IS NOT NULL AND
        column_row.enum_values_json IS NOT NULL AND
        json_array_length(column_row.enum_values_json) > 0 AND
        (
          NOT json_valid(cell.value_json) OR
          json_type(cell.value_json, '$') <> 'text' OR
          NOT EXISTS (
            SELECT 1 FROM json_each(column_row.enum_values_json)
             WHERE value = json_extract(cell.value_json, '$')
          )
        )
      )
      OR NOT (
        cell.citations_json IS NOT NULL AND
        json_valid(cell.citations_json) AND
        json_type(cell.citations_json) = 'array'
      )
   LIMIT 1
`;
const V7_CITATION_POSTCONDITION_SQL = `
  SELECT id
    FROM tabular_cells
   WHERE NOT (${LEGACY_CITATIONS_IS_VALID})
   LIMIT 1
`;
const V7_RUNNING_REVIEW_POSTCONDITION_SQL = `
  SELECT review.id
    FROM tabular_reviews review
   WHERE review.status = 'running'
     AND NOT EXISTS (
       SELECT 1 FROM tabular_cells cell
        WHERE cell.review_id = review.id
          AND cell.status IN (${ACTIVE_CELL_STATUSES_SQL})
     )
   LIMIT 1
`;
const V7_CHAT_MESSAGE_POSTCONDITION_SQL = `
  SELECT id
    FROM tabular_review_chat_messages
   WHERE status IN (${PENDING_MESSAGE_STATUSES_SQL})
      OR NOT (
        ${LEGACY_CHAT_ANNOTATIONS_IS_VALID}
      )
      OR NOT (
        sources_json IS NOT NULL AND
        json_valid(sources_json) AND
        json_type(sources_json) = 'array' AND
        json_array_length(sources_json) <= ${MAX_TABULAR_SOURCE_REFS}
      )
   LIMIT 1
`;
const V7_TABULAR_JOB_POSTCONDITION_SQL = `
  SELECT id
    FROM jobs
   WHERE type = 'tabular_cell'
     AND (
       payload_json <> '{}' OR
       (status <> 'complete' AND result_json IS NOT NULL) OR
       (status = 'complete' AND result_json <> '{}') OR
       (
         status IN (${TERMINAL_ERROR_JOB_STATUSES_SQL}) AND (
           error_code <> '${TABULAR_REGENERATION_REQUIRED}' OR
           error_json <> ${TABULAR_REGENERATION_REQUIRED_ERROR_JSON_SQL} OR
           retryable <> 0 OR
           started_at IS NULL OR
           completed_at IS NULL OR
           cancel_requested_at IS NOT NULL OR
           cancellation_reason IS NOT NULL OR
           lease_owner IS NOT NULL OR
           lease_expires_at IS NOT NULL OR
           locked_at IS NOT NULL
         )
       ) OR
       (
         status = 'complete' AND (
           started_at IS NULL OR
           completed_at IS NULL OR
           error_code IS NOT NULL OR
           error_json IS NOT NULL OR
           cancel_requested_at IS NOT NULL OR
           cancellation_reason IS NOT NULL OR
           lease_owner IS NOT NULL OR
           lease_expires_at IS NOT NULL OR
           locked_at IS NOT NULL
         )
       ) OR
       (
         status = 'cancelled' AND (
           completed_at IS NULL OR
           cancel_requested_at IS NULL OR
           error_code IS NOT NULL OR
           error_json IS NOT NULL OR
           lease_owner IS NOT NULL OR
           lease_expires_at IS NOT NULL OR
           locked_at IS NOT NULL
         )
       ) OR
       (
         status = 'queued' AND (
           started_at IS NOT NULL OR
           completed_at IS NOT NULL OR
           cancel_requested_at IS NOT NULL OR
           cancellation_reason IS NOT NULL OR
           error_code IS NOT NULL OR
           error_json IS NOT NULL
         )
       ) OR
       (
         status = 'running' AND (
           started_at IS NULL OR
           completed_at IS NOT NULL OR
           cancel_requested_at IS NOT NULL OR
           cancellation_reason IS NOT NULL OR
           error_code IS NOT NULL OR
           error_json IS NOT NULL
         )
       )
     )
   LIMIT 1
`;
const V7_POSTCONDITIONS = [
  {
    name: "active_review_documents",
    sql: V7_ACTIVE_REVIEW_DOCUMENT_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot repair tabular review document references to inactive documents.",
  },
  {
    name: "complete_review_document_column_cell_matrix",
    sql: V7_MATRIX_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot repair incomplete tabular matrix rows.",
  },
  {
    name: "review_document_ids_mirror",
    sql: V7_REVIEW_DOCUMENT_IDS_MIRROR_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot canonicalize tabular review document mirror rows.",
  },
  {
    name: "tabular_cardinality_bounds",
    sql: V7_CARDINALITY_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot safely repair tabular review cardinality bounds.",
  },
  {
    name: "review_text_bounds",
    sql: V7_REVIEW_TEXT_BOUNDS_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot safely repair tabular review text bounds.",
  },
  {
    name: "column_text_bounds",
    sql: V7_COLUMN_TEXT_BOUNDS_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot safely repair tabular column text bounds.",
  },
  {
    name: "persisted_cell_invariants",
    sql: V7_CELL_INVARIANT_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot repair persisted tabular cell invariants.",
  },
  {
    name: "strict_source_citations",
    sql: V7_CITATION_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot repair tabular source citation invariants.",
  },
  {
    name: "no_stale_running_reviews",
    sql: V7_RUNNING_REVIEW_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot leave tabular reviews running without active cells.",
  },
  {
    name: "no_pending_or_streaming_chat_messages",
    sql: V7_CHAT_MESSAGE_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot leave unsafe tabular chat messages persisted.",
  },
  {
    name: "interrupted_tabular_job_lifecycle",
    sql: V7_TABULAR_JOB_POSTCONDITION_SQL,
    message:
      "Workspace schema v7 cannot leave interrupted tabular jobs with invalid lifecycle fields.",
  },
] as const;
const V7_REPAIR_POLICY_CHECKSUM_MATERIAL = {
  maxTabularCellContentChars: MAX_TABULAR_CELL_CONTENT_CHARS,
  runtimeStringBounds: {
    policy:
      "use_unicode_code_points_length_and_reject_unpaired_surrogates_in_runtime",
    rejectNul: true,
    reviewTitleCodePoints: MAX_TABULAR_REVIEW_TITLE_CODE_POINTS,
    columnKeyCodePoints: MAX_TABULAR_COLUMN_KEY_CODE_POINTS,
    columnTitleCodePoints: MAX_TABULAR_COLUMN_TITLE_CODE_POINTS,
    columnPromptCodePoints: MAX_TABULAR_COLUMN_PROMPT_CODE_POINTS,
    tagCodePoints: MAX_TABULAR_TAG_CODE_POINTS,
    sourceQuoteCodePoints: MAX_TABULAR_SOURCE_QUOTE_CODE_POINTS,
    cellContentCodePoints: MAX_TABULAR_CELL_CONTENT_CHARS,
  },
  legacyTabularTextCanonicalization: {
    nulReplacement: V7_NUL_REPLACEMENT,
    trailingWhitespace: "schema_only_corruption_fail_closed_no_repair",
    collisionPolicy:
      "enum string values with distinct originals and identical NUL-replacement canonical values fail closed before any v7 write",
  },
  destructiveEvidenceTargets: {
    jobs: V7_JOB_DESTRUCTIVE_TARGETS,
    cells: V7_CELL_DESTRUCTIVE_TARGETS,
  },
  legacyNumericValues: {
    policy: "only_finite_json_numbers_may_be_projected_to_legacy_cell_summary",
  },
  cardinalityBounds: {
    reviewDocuments: MAX_TABULAR_REVIEW_DOCUMENTS,
    reviewColumns: MAX_TABULAR_REVIEW_COLUMNS,
    reviewCells: MAX_TABULAR_REVIEW_CELLS,
  },
  mikeFormatCheck: MIKE_FORMAT_CHECK,
  issueCodes: {
    legacyTagsInvalid: LEGACY_TAGS_INVALID,
    legacyContentRequiresReview: LEGACY_CONTENT_REQUIRES_REVIEW,
    legacyFailedWithoutError: LEGACY_FAILED_WITHOUT_ERROR,
    tabularRegenerationRequired: TABULAR_REGENERATION_REQUIRED,
  },
  inactiveDocumentReferences: {
    policy: "fail_closed",
    reason:
      "Soft-deleted or missing document references cannot be losslessly repaired during v7 migration.",
  },
  invalidLegacyContent: {
    policy: "preserve_original_in_legacy_content_and_mark_failed",
    issueCode: LEGACY_CONTENT_REQUIRES_REVIEW,
  },
  invalidLegacyCitations: {
    policy:
      "preserve_original_citations_in_legacy_content_clear_citations_and_mark_failed",
    issueCode: LEGACY_CONTENT_REQUIRES_REVIEW,
  },
  reviewDocumentMirror: {
    policy:
      "rebuild_document_ids_json_from_authoritative_tabular_review_documents_ordered_by_ordinal_then_document_id",
  },
  legacyTabularJobs: {
    policy:
      "canonicalize_all_legacy_tabular_cell_jobs_with_fixed_payload_projection_result_projection_and_status_lifecycle_rules",
    payloadProjection: "{}",
    completeResultProjection: "{}",
    nonCompleteResultProjection: "NULL",
    lifecycle:
      "queued/running become interrupted; failed/interrupted keep terminal status with fixed safe error; complete clears errors; cancelled clears errors and preserves cancellation timestamp",
    issueCode: TABULAR_REGENERATION_REQUIRED,
  },
  legacyFailedCellErrors: {
    policy:
      "canonicalize_all_pre_v7_failed_cell_errors_to_fixed_safe_structured_error",
    issueCode: LEGACY_FAILED_WITHOUT_ERROR,
  },
  nonFailedCellErrors: {
    policy:
      "clear_error_json_and_error_code_for_all_final_non_failed_tabular_cells",
  },
  destructiveRewriteGate: {
    evidence:
      "jobs payload/result/error/lease target diffs, review document_ids_json and columns_config_json target diffs, invalid chat annotations replacement, tabular cell error replacement or clearing, and NUL recovery canonicalization",
    attestation:
      "always re-attest same connection before first v7 DDL/DML and require equality with runner capability",
    plaintextPolicy: "fail_closed_only_when_destructive_evidence_exists",
    remediation: "npm run migrate:aletheia:sqlcipher --prefix backend",
  },
  nulRecovery: {
    table: V7_NUL_RECOVERY_TABLE,
    schema: V7_NUL_RECOVERY_SCHEMA,
    replacement: V7_NUL_REPLACEMENT,
    fields: [
      "tabular_reviews.title",
      "tabular_review_columns.title",
      "tabular_review_columns.prompt",
      "tabular_review_columns.enum_values_json string items",
    ],
    collisionPolicy: "distinct_original_same_canonical_fail_closed",
    canonicalization: "value.replaceAll('\\u0000','\\uFFFD')",
    history:
      "one immutable row per affected live review with original and canonical review/column text; review deletion purges its owned snapshot",
  },
} as const;
const V7_VALIDATOR_BINDING = {
  name: "validateTabularPersistenceV7",
  fingerprint: TABULAR_PERSISTENCE_VALIDATOR_FINGERPRINT,
} as const;
export const V7_APPLY_POLICY = {
  requiredCapability: "jsonTextChecks",
  validator: V7_VALIDATOR_BINDING,
  errors: {
    missingCapability:
      "Workspace schema v7 requires SQLite JSON1 for tabular Mike semantics.",
    partialMarkers:
      "Workspace schema v7 markers exist without a recorded v7 migration; restore from backup or rebuild the tabular v7 migration atomically.",
    destructivePlaintext:
      "Workspace schema v7 would rewrite potentially sensitive tabular legacy data on a plaintext database. Run npm run migrate:aletheia:sqlcipher --prefix backend or use the desktop offline migration before enabling v7.",
    inconsistentEncryptionCapability:
      "Workspace schema v7 found inconsistent SQLCipher connection capability; capability must exactly match immediate trusted same-connection re-attestation.",
    stageOrder: "Workspace tabular v7 migration stage order is invalid.",
    validatorBinding:
      "Workspace tabular v7 migration validator binding is invalid.",
  },
  stageOrder: [
    "assert_sqlite_json_capability",
    "assert_no_partial_v7_schema_markers",
    "build_v7_readonly_rewrite_plan",
    "assert_encrypted_destructive_rewrite_preflight",
    "install_nul_recovery_schema",
    "record_nul_recovery_snapshots_and_canonicalize",
    "lock_nul_recovery_snapshots",
    "install_nul_recovery_delete_lifecycle",
    "install_tabular_mike_semantics_sql",
    "install_v7_live_write_guards",
    "assert_schema_markers_and_trigger_contracts",
    "run_trigger_self_checks",
    "assert_v7_sql_postconditions",
    "run_declared_frozen_persistence_validator",
  ],
  stageContracts: {
    assert_sqlite_json_capability: {
      capability: "jsonTextChecks",
    },
    assert_no_partial_v7_schema_markers: {
      markers: V7_SCHEMA_MARKERS.map((marker) =>
        marker.kind === "column"
          ? `${marker.table}.${marker.name}`
          : marker.kind === "table"
            ? `table:${marker.name}`
            : `trigger:${marker.name}`,
      ),
    },
    build_v7_readonly_rewrite_plan: {
      destructiveEvidence:
        "derive_target_diff_for_jobs_review_json_chat_annotations_cell_errors_and_nul_recovery_before_first_v7_ddl_or_dml",
      nulRecoveryReplacement: V7_NUL_REPLACEMENT,
    },
    assert_encrypted_destructive_rewrite_preflight: {
      policy: JSON.parse(
        WORKSPACE_SQLCIPHER_CONNECTION_POLICY_MATERIAL,
      ) as unknown,
      decision:
        "capability must exactly match immediate trusted same-connection re-attestation; destructive evidence requires SQLCipher",
      remediation: "npm run migrate:aletheia:sqlcipher --prefix backend",
    },
    install_nul_recovery_schema: {
      sql: "V7_NUL_RECOVERY_SCHEMA_SQL",
    },
    record_nul_recovery_snapshots_and_canonicalize: {
      table: V7_NUL_RECOVERY_TABLE,
      schema: V7_NUL_RECOVERY_SCHEMA,
      replacement: V7_NUL_REPLACEMENT,
      fields: [
        "tabular_reviews.title",
        "tabular_review_columns.title",
        "tabular_review_columns.prompt",
        "tabular_review_columns.enum_values_json string items",
      ],
      collisionPolicy:
        "fail_closed_before_any_v7_write_when_distinct_original_values_share_a_canonical_replacement",
      writePolicy:
        "JS reads complete values and writes canonical replacements using SQL parameters",
    },
    lock_nul_recovery_snapshots: {
      sql: "V7_NUL_RECOVERY_LOCK_SQL",
    },
    install_nul_recovery_delete_lifecycle: {
      sql: "V7_NUL_RECOVERY_DELETE_LIFECYCLE_SQL",
      policy:
        "owned snapshots reject direct deletion; deleting the owning review purges its snapshot after the review row is gone",
    },
    install_tabular_mike_semantics_sql: {
      sql: "TABULAR_MIKE_SEMANTICS_V7_SQL",
    },
    install_v7_live_write_guards: {
      sql: "V7_LIVE_TEXT_GUARD_SQL",
    },
    assert_schema_markers_and_trigger_contracts: {
      markers: V7_SCHEMA_MARKERS.map((marker) =>
        marker.kind === "column"
          ? `${marker.table}.${marker.name}`
          : marker.kind === "table"
            ? `table:${marker.name}`
            : `trigger:${marker.name}`,
      ),
      triggerRequiredSql: V7_SCHEMA_MARKERS.flatMap((marker) =>
        marker.kind === "trigger"
          ? marker.requiredSql.map((sql) => `${marker.name}:${sql}`)
          : [],
      ),
    },
    run_trigger_self_checks: {
      statements: [
        "UPDATE tabular_cells SET content = content WHERE content IS NOT NULL",
        "UPDATE tabular_cells SET citations_json = citations_json WHERE citations_json IS NOT NULL",
      ],
    },
    assert_v7_sql_postconditions: {
      postconditions: V7_POSTCONDITIONS.map((postcondition) => ({
        name: postcondition.name,
        message: postcondition.message,
      })),
    },
    run_declared_frozen_persistence_validator: V7_VALIDATOR_BINDING,
  },
} as const;
export type V7ApplyStage = (typeof V7_APPLY_POLICY.stageOrder)[number];

export function createV7ApplyStageGuard(
  policy: Pick<
    typeof V7_APPLY_POLICY,
    "stageOrder" | "errors"
  > = V7_APPLY_POLICY,
) {
  let stageIndex = 0;
  const enterStage = (stage: V7ApplyStage) => {
    if (policy.stageOrder[stageIndex] !== stage) {
      throw new Error(policy.errors.stageOrder);
    }
    stageIndex += 1;
  };
  const assertComplete = () => {
    if (stageIndex !== policy.stageOrder.length) {
      throw new Error(policy.errors.stageOrder);
    }
  };
  return { enterStage, assertComplete };
}

const V7_NUL_RECOVERY_SCHEMA_SQL = `
CREATE TABLE ${V7_NUL_RECOVERY_TABLE} (
  review_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL CHECK (schema = '${V7_NUL_RECOVERY_SCHEMA}'),
  replacement TEXT NOT NULL CHECK (replacement = '${V7_NUL_REPLACEMENT}'),
  review_json TEXT NOT NULL CHECK (json_valid(review_json) AND json_type(review_json) = 'object'),
  columns_json TEXT NOT NULL CHECK (json_valid(columns_json) AND json_type(columns_json) = 'array'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

const V7_NUL_RECOVERY_LOCK_SQL = `
CREATE TRIGGER ${V7_NUL_RECOVERY_LOCK_INSERT_TRIGGER}
BEFORE INSERT ON ${V7_NUL_RECOVERY_TABLE} BEGIN
  SELECT RAISE(ABORT, 'tabular v7 NUL recovery snapshots are immutable');
END;

CREATE TRIGGER ${V7_NUL_RECOVERY_LOCK_UPDATE_TRIGGER}
BEFORE UPDATE ON ${V7_NUL_RECOVERY_TABLE} BEGIN
  SELECT RAISE(ABORT, 'tabular v7 NUL recovery snapshots are immutable');
END;

CREATE TRIGGER ${V7_NUL_RECOVERY_LOCK_DELETE_TRIGGER}
BEFORE DELETE ON ${V7_NUL_RECOVERY_TABLE}
WHEN EXISTS (
  SELECT 1 FROM tabular_reviews WHERE id = old.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'tabular v7 NUL recovery snapshots are immutable');
END;
`;

const V7_NUL_RECOVERY_DELETE_LIFECYCLE_SQL = `
CREATE TRIGGER ${V7_NUL_RECOVERY_REVIEW_DELETE_PURGE_TRIGGER}
AFTER DELETE ON tabular_reviews BEGIN
  DELETE FROM ${V7_NUL_RECOVERY_TABLE} WHERE review_id = old.id;
END;
`;

const V7_LIVE_TEXT_GUARD_SQL = `
CREATE TRIGGER ${V7_REVIEW_TITLE_INSERT_TRIGGER}
BEFORE INSERT ON tabular_reviews BEGIN
  SELECT CASE
    WHEN NOT ${unicodeNoNulSql("new.title")}
    THEN RAISE(ABORT, 'tabular review title contains NUL code points')
  END;
  SELECT CASE
    WHEN NOT ${unicodeNonBlankMaxCodePointsSql("new.title", MAX_TABULAR_REVIEW_TITLE_CODE_POINTS)}
    THEN RAISE(ABORT, 'tabular review title is too long or blank')
  END;
END;

CREATE TRIGGER ${V7_REVIEW_TITLE_UPDATE_TRIGGER}
BEFORE UPDATE OF title ON tabular_reviews BEGIN
  SELECT CASE
    WHEN NOT ${unicodeNoNulSql("new.title")}
    THEN RAISE(ABORT, 'tabular review title contains NUL code points')
  END;
  SELECT CASE
    WHEN NOT ${unicodeNonBlankMaxCodePointsSql("new.title", MAX_TABULAR_REVIEW_TITLE_CODE_POINTS)}
    THEN RAISE(ABORT, 'tabular review title is too long or blank')
  END;
END;

CREATE TRIGGER ${V7_COLUMN_TEXT_INSERT_TRIGGER}
BEFORE INSERT ON tabular_review_columns BEGIN
  SELECT CASE
    WHEN NOT ${unicodeNoNulSql("new.key")}
      OR NOT ${unicodeNoNulSql("new.title")}
      OR NOT ${unicodeNoNulSql("new.prompt")}
    THEN RAISE(ABORT, 'tabular column text contains NUL code points')
  END;
  SELECT CASE
    WHEN NOT ${unicodeNonBlankMaxCodePointsSql("new.key", MAX_TABULAR_COLUMN_KEY_CODE_POINTS)}
      OR NOT ${unicodeNonBlankMaxCodePointsSql("new.title", MAX_TABULAR_COLUMN_TITLE_CODE_POINTS)}
      OR NOT ${unicodeMaxCodePointsSql("new.prompt", MAX_TABULAR_COLUMN_PROMPT_CODE_POINTS)}
    THEN RAISE(ABORT, 'tabular column text is too long or blank')
  END;
  SELECT CASE
    WHEN NOT ${jsonStringArraySql("new.enum_values_json", {
      nullable: true,
      minItems: 1,
      maxItems: MAX_TABULAR_TAGS,
    })}
    THEN RAISE(ABORT, 'tabular column enum values are invalid')
  END;
  SELECT CASE
    WHEN NOT ${jsonStringArraySql("new.tags_json", {
      nullable: false,
      maxItems: MAX_TABULAR_TAGS,
    })}
    THEN RAISE(ABORT, 'tabular column tags are invalid')
  END;
END;

CREATE TRIGGER ${V7_COLUMN_TEXT_UPDATE_TRIGGER}
BEFORE UPDATE OF key, title, prompt, enum_values_json, tags_json ON tabular_review_columns BEGIN
  SELECT CASE
    WHEN NOT ${unicodeNoNulSql("new.key")}
      OR NOT ${unicodeNoNulSql("new.title")}
      OR NOT ${unicodeNoNulSql("new.prompt")}
    THEN RAISE(ABORT, 'tabular column text contains NUL code points')
  END;
  SELECT CASE
    WHEN NOT ${unicodeNonBlankMaxCodePointsSql("new.key", MAX_TABULAR_COLUMN_KEY_CODE_POINTS)}
      OR NOT ${unicodeNonBlankMaxCodePointsSql("new.title", MAX_TABULAR_COLUMN_TITLE_CODE_POINTS)}
      OR NOT ${unicodeMaxCodePointsSql("new.prompt", MAX_TABULAR_COLUMN_PROMPT_CODE_POINTS)}
    THEN RAISE(ABORT, 'tabular column text is too long or blank')
  END;
  SELECT CASE
    WHEN NOT ${jsonStringArraySql("new.enum_values_json", {
      nullable: true,
      minItems: 1,
      maxItems: MAX_TABULAR_TAGS,
    })}
    THEN RAISE(ABORT, 'tabular column enum values are invalid')
  END;
  SELECT CASE
    WHEN NOT ${jsonStringArraySql("new.tags_json", {
      nullable: false,
      maxItems: MAX_TABULAR_TAGS,
    })}
    THEN RAISE(ABORT, 'tabular column tags are invalid')
  END;
END;
`;

const TABULAR_MIKE_SEMANTICS_V7_SQL = `
CREATE TEMP TABLE v7_legacy_failed_tabular_cells (
  id TEXT PRIMARY KEY
);
INSERT INTO v7_legacy_failed_tabular_cells (id)
SELECT id FROM tabular_cells WHERE status = 'failed';

ALTER TABLE tabular_review_columns ADD COLUMN format TEXT NOT NULL DEFAULT 'text'
  CHECK (${MIKE_FORMAT_CHECK});
ALTER TABLE tabular_review_columns ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array');
ALTER TABLE tabular_review_columns ADD COLUMN legacy_output_type TEXT
  CHECK (
    legacy_output_type IS NULL OR
    legacy_output_type IN (${TABULAR_OUTPUT_TYPES_SQL})
  );
ALTER TABLE tabular_review_columns ADD COLUMN legacy_metadata_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(legacy_metadata_json) AND json_type(legacy_metadata_json) = 'object');
ALTER TABLE tabular_cells ADD COLUMN legacy_content TEXT;
ALTER TABLE tabular_cells ADD COLUMN legacy_content_issue_code TEXT
  CHECK (
    legacy_content_issue_code IS NULL OR
    legacy_content_issue_code IN ('${LEGACY_CONTENT_REQUIRES_REVIEW}')
  );

UPDATE tabular_review_columns
   SET legacy_output_type = coalesce(legacy_output_type, output_type),
       format = CASE output_type
         WHEN 'boolean' THEN 'yes_no'
         WHEN 'enum' THEN 'tag'
         WHEN 'number' THEN 'number'
         ELSE 'text'
       END,
       tags_json = CASE
         WHEN output_type = 'enum' AND (${LEGACY_ENUM_IS_VALID_TAGS})
         THEN enum_values_json
         ELSE '[]'
       END,
       enum_values_json = CASE
         WHEN output_type = 'enum' AND (${LEGACY_ENUM_IS_VALID_TAGS})
         THEN enum_values_json
         ELSE NULL
       END,
       legacy_metadata_json = json_object(
         'schema', 'vera-tabular-legacy-column-v1',
         'outputType', output_type,
         'enumValuesRaw', enum_values_json,
         'enumValues', CASE
           WHEN enum_values_json IS NULL THEN json('null')
           WHEN json_valid(enum_values_json) THEN json(enum_values_json)
           ELSE json('null')
         END,
         'migrationIssueCode', CASE
           WHEN output_type = 'enum' AND NOT (${LEGACY_ENUM_IS_VALID_TAGS})
           THEN '${LEGACY_TAGS_INVALID}'
           ELSE json('null')
         END
       );

UPDATE tabular_reviews
   SET document_ids_json = (
     SELECT coalesce(json_group_array(document_id), '[]')
       FROM (
         SELECT review_document.document_id
           FROM tabular_review_documents review_document
          WHERE review_document.review_id = tabular_reviews.id
          ORDER BY review_document.ordinal ASC, review_document.document_id ASC
       )
   );

UPDATE tabular_reviews
   SET columns_config_json = (
     SELECT coalesce(json_group_array(
       json(column_json)
     ), '[]')
       FROM (
         SELECT json_object(
           'index', column_row.ordinal,
           'name', column_row.title,
           'prompt', column_row.prompt,
           'format', column_row.format,
           'tags', json(column_row.tags_json)
         ) AS column_json
           FROM tabular_review_columns column_row
          WHERE column_row.review_id = tabular_reviews.id
          ORDER BY column_row.ordinal ASC, column_row.id ASC
       )
   );

UPDATE tabular_cells
   SET legacy_content = CASE
     WHEN content IS NOT NULL AND NOT (${LEGACY_CONTENT_IS_STRICT})
     THEN content
     WHEN content IS NULL
       AND (${LEGACY_VALUE_REQUIRES_REVIEW})
     THEN value_json
     ELSE legacy_content
   END,
       legacy_content_issue_code = CASE
     WHEN content IS NOT NULL AND NOT (${LEGACY_CONTENT_IS_STRICT})
     THEN '${LEGACY_CONTENT_REQUIRES_REVIEW}'
     WHEN content IS NULL
       AND (${LEGACY_VALUE_REQUIRES_REVIEW})
     THEN '${LEGACY_CONTENT_REQUIRES_REVIEW}'
     ELSE legacy_content_issue_code
   END,
       content = CASE
     WHEN ${LEGACY_CONTENT_IS_STRICT}
     THEN content
     WHEN ${LEGACY_VALUE_IS_DIRECT_SUMMARY}
     THEN json_object(
       'summary',
       ${LEGACY_VALUE_SUMMARY},
       'flag', 'grey',
       'reasoning', ''
     )
     WHEN content IS NOT NULL
     THEN json_object(
       'summary',
       'Legacy cell content requires review.',
       'flag',
       'yellow',
       'reasoning',
       'Original legacy cell content was preserved for manual review.'
     )
     WHEN value_json IS NOT NULL
     THEN json_object(
       'summary',
       'Legacy cell content requires review.',
       'flag',
       'yellow',
       'reasoning',
       'Original legacy cell value was preserved for manual review.'
     )
     ELSE NULL
   END
 WHERE content IS NOT NULL
    OR value_json IS NOT NULL;

UPDATE tabular_cells AS cell
   SET legacy_content = CASE
     WHEN legacy_content IS NULL THEN value_json
     ELSE json_object(
       'legacyContent', legacy_content,
       'legacyValueJson', value_json
     )
   END,
       legacy_content_issue_code = '${LEGACY_CONTENT_REQUIRES_REVIEW}'
 WHERE value_json IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM tabular_review_columns column_row
      WHERE column_row.id = cell.column_id
        AND column_row.output_type = 'enum'
        AND json_valid(cell.value_json)
        AND json_type(cell.value_json, '$') = 'text'
        AND json_array_length(column_row.tags_json) > 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(column_row.tags_json)
           WHERE value = json_extract(cell.value_json, '$')
        )
   );

UPDATE tabular_cells
   SET legacy_content_issue_code = '${LEGACY_CONTENT_REQUIRES_REVIEW}'
 WHERE status = 'complete'
   AND content IS NULL;

UPDATE tabular_cells
   SET legacy_content = CASE
     WHEN legacy_content IS NULL
     THEN json_object('legacyCitationsJson', citations_json)
     ELSE json_object(
       'legacyContent', legacy_content,
       'legacyCitationsJson', citations_json
     )
   END,
       legacy_content_issue_code = '${LEGACY_CONTENT_REQUIRES_REVIEW}'
 WHERE NOT (${LEGACY_CITATIONS_IS_VALID});

UPDATE tabular_cells
   SET citations_json = '[]'
 WHERE NOT (${LEGACY_CITATIONS_IS_VALID});

UPDATE tabular_cells
   SET content = json_object(
     'summary',
     'Legacy cell content requires review.',
     'flag',
     'yellow',
     'reasoning',
     'Original legacy cell data was preserved for manual review.'
   )
 WHERE legacy_content_issue_code = '${LEGACY_CONTENT_REQUIRES_REVIEW}';

UPDATE tabular_cells
   SET value_json = NULL
 WHERE legacy_content_issue_code = '${LEGACY_CONTENT_REQUIRES_REVIEW}';

UPDATE tabular_cells
   SET status = 'failed',
       error_code = '${LEGACY_CONTENT_REQUIRES_REVIEW}',
       error_json = ${LEGACY_CONTENT_REQUIRES_REVIEW_ERROR_JSON_SQL},
       completed_at = NULL,
       updated_at = coalesce(updated_at, created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 WHERE legacy_content_issue_code = '${LEGACY_CONTENT_REQUIRES_REVIEW}'
   AND status NOT IN (${ACTIVE_CELL_STATUSES_SQL});

UPDATE tabular_cells
   SET completed_at = coalesce(completed_at, updated_at, created_at)
 WHERE status = 'complete'
   AND legacy_content_issue_code IS NULL;

UPDATE tabular_cells
   SET error_code = '${LEGACY_FAILED_WITHOUT_ERROR}',
       error_json = ${LEGACY_FAILED_ERROR_JSON_SQL}
 WHERE id IN (SELECT id FROM v7_legacy_failed_tabular_cells);

ALTER TABLE tabular_review_chats ADD COLUMN user_id TEXT;
ALTER TABLE tabular_review_chats ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN (${TABULAR_CHAT_STATUSES_SQL}));
ALTER TABLE tabular_review_chats ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE tabular_review_chats ADD COLUMN model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL;

ALTER TABLE tabular_review_chat_messages ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE tabular_review_chat_messages ADD COLUMN model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL;
ALTER TABLE tabular_review_chat_messages ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array');

UPDATE tabular_review_chat_messages
   SET annotations_json = '[]'
 WHERE NOT (${LEGACY_CHAT_ANNOTATIONS_IS_VALID});

UPDATE tabular_review_chat_messages
   SET status = 'interrupted',
       completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE status IN (${PENDING_MESSAGE_STATUSES_SQL});

CREATE INDEX idx_tabular_review_chats_user_updated
  ON tabular_review_chats(user_id, updated_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX idx_tabular_review_chat_messages_job
  ON tabular_review_chat_messages(job_id)
  WHERE job_id IS NOT NULL;

CREATE TRIGGER ${V7_CONTENT_INSERT_TRIGGER}
BEFORE INSERT ON tabular_cells
WHEN new.content IS NOT NULL BEGIN
  SELECT CASE
    WHEN NOT json_valid(new.content)
    THEN RAISE(ABORT, 'tabular cell content must be valid JSON')
  END;
  SELECT CASE
    WHEN json_type(new.content) <> 'object'
    THEN RAISE(ABORT, 'tabular cell content must be an object')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM json_each(new.content)
       WHERE key NOT IN (${TABULAR_CONTENT_KEYS_SQL})
    )
    THEN RAISE(ABORT, 'tabular cell content contains unsupported keys')
  END;
  SELECT CASE
    WHEN (
      SELECT count(*) FROM json_each(new.content)
    ) <> (
      SELECT count(DISTINCT key) FROM json_each(new.content)
    )
    THEN RAISE(ABORT, 'tabular cell content contains duplicate keys')
  END;
  SELECT CASE
    WHEN json_type(new.content, '$.summary') IS NOT 'text'
    THEN RAISE(ABORT, 'tabular cell content summary must be text')
  END;
  SELECT CASE
    WHEN NOT ${unicodeMaxCodePointsSql("json_extract(new.content, '$.summary')", MAX_TABULAR_CELL_CONTENT_CHARS)}
    THEN RAISE(ABORT, 'tabular cell content summary is too long')
  END;
  SELECT CASE
    WHEN json_type(new.content, '$.flag') IS NOT NULL AND (
      json_type(new.content, '$.flag') IS NOT 'text' OR
      json_extract(new.content, '$.flag') NOT IN (${TABULAR_CELL_FLAGS_SQL})
    )
    THEN RAISE(ABORT, 'tabular cell content flag is invalid')
  END;
  SELECT CASE
    WHEN json_type(new.content, '$.reasoning') IS NOT NULL AND (
      json_type(new.content, '$.reasoning') IS NOT 'text' OR
      NOT ${unicodeMaxCodePointsSql("json_extract(new.content, '$.reasoning')", MAX_TABULAR_CELL_CONTENT_CHARS)}
    )
    THEN RAISE(ABORT, 'tabular cell content reasoning is invalid')
  END;
END;

CREATE TRIGGER ${V7_CONTENT_UPDATE_TRIGGER}
BEFORE UPDATE OF content ON tabular_cells
WHEN new.content IS NOT NULL BEGIN
  SELECT CASE
    WHEN NOT json_valid(new.content)
    THEN RAISE(ABORT, 'tabular cell content must be valid JSON')
  END;
  SELECT CASE
    WHEN json_type(new.content) <> 'object'
    THEN RAISE(ABORT, 'tabular cell content must be an object')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM json_each(new.content)
       WHERE key NOT IN (${TABULAR_CONTENT_KEYS_SQL})
    )
    THEN RAISE(ABORT, 'tabular cell content contains unsupported keys')
  END;
  SELECT CASE
    WHEN (
      SELECT count(*) FROM json_each(new.content)
    ) <> (
      SELECT count(DISTINCT key) FROM json_each(new.content)
    )
    THEN RAISE(ABORT, 'tabular cell content contains duplicate keys')
  END;
  SELECT CASE
    WHEN json_type(new.content, '$.summary') IS NOT 'text'
    THEN RAISE(ABORT, 'tabular cell content summary must be text')
  END;
  SELECT CASE
    WHEN NOT ${unicodeMaxCodePointsSql("json_extract(new.content, '$.summary')", MAX_TABULAR_CELL_CONTENT_CHARS)}
    THEN RAISE(ABORT, 'tabular cell content summary is too long')
  END;
  SELECT CASE
    WHEN json_type(new.content, '$.flag') IS NOT NULL AND (
      json_type(new.content, '$.flag') IS NOT 'text' OR
      json_extract(new.content, '$.flag') NOT IN (${TABULAR_CELL_FLAGS_SQL})
    )
    THEN RAISE(ABORT, 'tabular cell content flag is invalid')
  END;
  SELECT CASE
    WHEN json_type(new.content, '$.reasoning') IS NOT NULL AND (
      json_type(new.content, '$.reasoning') IS NOT 'text' OR
      NOT ${unicodeMaxCodePointsSql("json_extract(new.content, '$.reasoning')", MAX_TABULAR_CELL_CONTENT_CHARS)}
    )
    THEN RAISE(ABORT, 'tabular cell content reasoning is invalid')
  END;
END;

CREATE TRIGGER ${V7_CITATIONS_INSERT_TRIGGER}
BEFORE INSERT ON tabular_cells
WHEN new.citations_json IS NOT NULL BEGIN
  SELECT CASE
    WHEN NOT json_valid(new.citations_json)
    THEN RAISE(ABORT, 'tabular cell citations must be valid JSON')
  END;
  SELECT CASE
    WHEN json_type(new.citations_json) <> 'array'
    THEN RAISE(ABORT, 'tabular cell citations must be an array')
  END;
  SELECT CASE
    WHEN json_array_length(new.citations_json) > ${MAX_TABULAR_SOURCE_REFS}
    THEN RAISE(ABORT, 'tabular cell citations contains too many items')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM json_each(new.citations_json) citation
       WHERE citation.type <> 'object'
          OR (
            SELECT count(*) FROM json_each(citation.value)
          ) <> (
            SELECT count(DISTINCT key) FROM json_each(citation.value)
          )
    )
    THEN RAISE(ABORT, 'tabular cell citation source contains duplicate keys')
  END;
END;

CREATE TRIGGER ${V7_CITATIONS_UPDATE_TRIGGER}
BEFORE UPDATE OF citations_json ON tabular_cells
WHEN new.citations_json IS NOT NULL BEGIN
  SELECT CASE
    WHEN NOT json_valid(new.citations_json)
    THEN RAISE(ABORT, 'tabular cell citations must be valid JSON')
  END;
  SELECT CASE
    WHEN json_type(new.citations_json) <> 'array'
    THEN RAISE(ABORT, 'tabular cell citations must be an array')
  END;
  SELECT CASE
    WHEN json_array_length(new.citations_json) > ${MAX_TABULAR_SOURCE_REFS}
    THEN RAISE(ABORT, 'tabular cell citations contains too many items')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM json_each(new.citations_json) citation
       WHERE citation.type <> 'object'
          OR (
            SELECT count(*) FROM json_each(citation.value)
          ) <> (
            SELECT count(DISTINCT key) FROM json_each(citation.value)
          )
    )
    THEN RAISE(ABORT, 'tabular cell citation source contains duplicate keys')
  END;
END;

UPDATE jobs
   SET payload_json = '{}',
       result_json = CASE WHEN status = 'complete' THEN '{}' ELSE NULL END
 WHERE type = 'tabular_cell';

UPDATE jobs
   SET error_code = '${TABULAR_REGENERATION_REQUIRED}',
       error_json = ${TABULAR_REGENERATION_REQUIRED_ERROR_JSON_SQL},
       retryable = 0,
       lease_owner = NULL,
       lease_expires_at = NULL,
       locked_at = NULL,
       cancel_requested_at = NULL,
       cancellation_reason = NULL,
       started_at = coalesce(started_at, queued_at, scheduled_at, created_at),
       completed_at = coalesce(completed_at, updated_at, queued_at, scheduled_at, created_at),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE type = 'tabular_cell'
   AND status IN (${TERMINAL_ERROR_JOB_STATUSES_SQL});

UPDATE jobs
   SET error_code = NULL,
       error_json = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       locked_at = NULL,
       cancel_requested_at = NULL,
       cancellation_reason = NULL,
       started_at = coalesce(started_at, queued_at, scheduled_at, created_at),
       completed_at = coalesce(completed_at, updated_at, queued_at, scheduled_at, created_at),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE type = 'tabular_cell'
   AND status = 'complete';

UPDATE jobs
   SET error_code = NULL,
       error_json = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       locked_at = NULL,
       completed_at = coalesce(completed_at, updated_at, queued_at, scheduled_at, created_at),
       cancel_requested_at = coalesce(cancel_requested_at, completed_at, updated_at, queued_at, scheduled_at, created_at),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE type = 'tabular_cell'
   AND status = 'cancelled';

UPDATE jobs
   SET status = 'interrupted',
       retryable = 0,
       error_code = '${TABULAR_REGENERATION_REQUIRED}',
       error_json = ${TABULAR_REGENERATION_REQUIRED_ERROR_JSON_SQL},
       lease_owner = NULL,
       lease_expires_at = NULL,
       locked_at = NULL,
       cancel_requested_at = NULL,
       cancellation_reason = NULL,
       started_at = coalesce(started_at, queued_at, scheduled_at, created_at),
       completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE type = 'tabular_cell'
   AND status IN (${ACTIVE_CELL_STATUSES_SQL});

UPDATE tabular_cells
   SET status = 'failed',
       error_code = '${TABULAR_REGENERATION_REQUIRED}',
       error_json = ${TABULAR_REGENERATION_REQUIRED_ERROR_JSON_SQL},
       completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE status IN (${ACTIVE_CELL_STATUSES_SQL});

UPDATE tabular_cells
   SET error_code = NULL,
       error_json = NULL
 WHERE status <> 'failed';

UPDATE tabular_reviews
   SET status = 'failed',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE status = 'running'
   AND EXISTS (
     SELECT 1 FROM tabular_cells cell
      WHERE cell.review_id = tabular_reviews.id
        AND cell.error_code = '${TABULAR_REGENERATION_REQUIRED}'
   );

UPDATE tabular_reviews
   SET status = 'failed',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE status = 'complete'
   AND EXISTS (
     SELECT 1 FROM tabular_cells cell
      WHERE cell.review_id = tabular_reviews.id
        AND cell.status = 'failed'
   );

UPDATE tabular_reviews
   SET status = CASE
     WHEN EXISTS (
       SELECT 1 FROM tabular_cells cell
        WHERE cell.review_id = tabular_reviews.id
          AND cell.status = 'failed'
     ) THEN 'failed'
     WHEN EXISTS (
       SELECT 1 FROM tabular_cells cell
        WHERE cell.review_id = tabular_reviews.id
     ) AND NOT EXISTS (
       SELECT 1 FROM tabular_cells cell
        WHERE cell.review_id = tabular_reviews.id
          AND cell.status <> 'complete'
     ) THEN 'complete'
     ELSE 'ready'
   END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE status = 'running'
   AND NOT EXISTS (
     SELECT 1 FROM tabular_cells cell
      WHERE cell.review_id = tabular_reviews.id
        AND cell.status IN (${ACTIVE_CELL_STATUSES_SQL})
   );

UPDATE tabular_cells
   SET content = content
 WHERE content IS NOT NULL;

DROP TABLE v7_legacy_failed_tabular_cells;
`;

type TableColumnInfo = {
  name?: unknown;
  notnull?: unknown;
};

function columnInfo(
  database: WorkspaceDatabaseAdapter,
  table: string,
): TableColumnInfo[] {
  return database
    .prepare(`PRAGMA table_info("${table}")`)
    .all() as TableColumnInfo[];
}

function hasColumn(
  database: WorkspaceDatabaseAdapter,
  table: string,
  column: string,
) {
  return columnInfo(database, table).some((row) => String(row.name) === column);
}

function hasTable(database: WorkspaceDatabaseAdapter, table: string) {
  return Boolean(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table),
  );
}

function requireColumn(
  database: WorkspaceDatabaseAdapter,
  table: string,
  column: string,
  options: { notNull?: boolean } = {},
) {
  const info = columnInfo(database, table).find(
    (row) => String(row.name) === column,
  );
  if (!info) {
    throw new Error(
      `Workspace schema v7 is incomplete: ${table}.${column} is missing.`,
    );
  }
  if (options.notNull && Number(info.notnull) !== 1) {
    throw new Error(
      `Workspace schema v7 is incomplete: ${table}.${column} must be NOT NULL.`,
    );
  }
}

function hasTrigger(database: WorkspaceDatabaseAdapter, trigger: string) {
  return Boolean(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      )
      .get(trigger),
  );
}

function triggerSql(database: WorkspaceDatabaseAdapter, trigger: string) {
  const row = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    )
    .get(trigger);
  return row && row.sql != null ? String(row.sql) : null;
}

function assertNoRows(
  database: WorkspaceDatabaseAdapter,
  sql: string,
  message: string,
) {
  if (database.prepare(sql).get()) {
    throw new Error(message);
  }
}

type V7NulFieldSnapshot = {
  original: string;
  canonical: string;
};

type V7NulColumnSnapshot = {
  id: string;
  ordinal: number;
  title: V7NulFieldSnapshot;
  prompt: V7NulFieldSnapshot;
  enumValues: {
    original: string[] | null;
    canonical: string[] | null;
  };
};

type V7NulReviewSnapshot = {
  reviewId: string;
  review: {
    id: string;
    title: V7NulFieldSnapshot;
  };
  columns: V7NulColumnSnapshot[];
};

type V7ReadOnlyPlan = {
  destructiveEvidence: string[];
  nulSnapshots: V7NulReviewSnapshot[];
};

function rawRows(database: WorkspaceDatabaseAdapter, sql: string) {
  return database.prepare(sql).all() as Record<string, unknown>[];
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Workspace schema v7 cannot safely plan ${label}.`);
  }
  return value;
}

function maybeText(value: unknown, label: string): string | null {
  if (value == null) return null;
  return requireText(value, label);
}

function canonicalizeNul(value: string) {
  return value.replaceAll("\0", V7_NUL_REPLACEMENT);
}

function fieldSnapshot(value: string): V7NulFieldSnapshot {
  return { original: value, canonical: canonicalizeNul(value) };
}

function parseStringArrayJson(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function assertNoCanonicalCollision(values: string[], label: string) {
  const byCanonical = new Map<string, string>();
  for (const original of values) {
    const canonical = canonicalizeNul(original);
    const previous = byCanonical.get(canonical);
    if (previous !== undefined && previous !== original) {
      throw new Error(
        `Workspace schema v7 cannot canonicalize NUL text without collision in ${label}.`,
      );
    }
    byCanonical.set(canonical, original);
  }
}

function enumValuesAreValid(values: string[] | null): values is string[] {
  if (values === null) return false;
  if (values.length < 1 || values.length > MAX_TABULAR_TAGS) return false;
  for (const value of values) {
    if (value.replaceAll(/^ +| +$/g, "").length === 0) return false;
    if (value.includes("\0")) return false;
    if (Array.from(value).length > MAX_TABULAR_TAG_CODE_POINTS) return false;
  }
  return true;
}

function targetFormatForOutputType(value: unknown) {
  if (value === "boolean") return "yes_no";
  if (value === "enum") return "tag";
  if (value === "number") return "number";
  return "text";
}

function canonicalReviewDocumentIds(
  database: WorkspaceDatabaseAdapter,
  reviewId: string,
) {
  return database
    .prepare(
      `SELECT document_id FROM tabular_review_documents
        WHERE review_id = ?
        ORDER BY ordinal ASC, document_id ASC`,
    )
    .all(reviewId)
    .map((row) => requireText(row.document_id, "tabular review document id"));
}

function columnsForReview(
  database: WorkspaceDatabaseAdapter,
  reviewId: string,
) {
  return database
    .prepare(
      `SELECT id, title, prompt, output_type, enum_values_json, ordinal
         FROM tabular_review_columns
        WHERE review_id = ?
        ORDER BY ordinal ASC, id ASC`,
    )
    .all(reviewId) as Record<string, unknown>[];
}

function enumJsonAfterNulWriteback(
  column: Record<string, unknown>,
  nulColumn?: V7NulColumnSnapshot,
) {
  const originalJson = maybeText(
    column.enum_values_json,
    "tabular column enum_values_json",
  );
  if (
    !nulColumn ||
    nulColumn.enumValues.original === null ||
    nulColumn.enumValues.canonical === null
  ) {
    return originalJson;
  }
  const changed = nulColumn.enumValues.original.some(
    (value, index) => value !== nulColumn.enumValues.canonical?.[index],
  );
  return changed
    ? JSON.stringify(nulColumn.enumValues.canonical)
    : originalJson;
}

function targetColumnConfigJson(
  database: WorkspaceDatabaseAdapter,
  column: Record<string, unknown>,
  nulColumn?: V7NulColumnSnapshot,
) {
  const outputType = requireText(
    column.output_type,
    "tabular column output_type",
  );
  const enumJson = enumJsonAfterNulWriteback(column, nulColumn);
  const title =
    nulColumn?.title.canonical ??
    requireText(column.title, "tabular column title");
  const prompt =
    nulColumn?.prompt.canonical ??
    requireText(column.prompt, "tabular column prompt");
  const row = database
    .prepare(
      `WITH input(output_type, enum_values_json) AS (
         SELECT ? AS output_type, ? AS enum_values_json
       )
       SELECT json_object(
         'index', CAST(? AS INTEGER),
         'name', ?,
         'prompt', ?,
         'format', CASE output_type
           WHEN 'boolean' THEN 'yes_no'
           WHEN 'enum' THEN 'tag'
           WHEN 'number' THEN 'number'
           ELSE 'text'
         END,
         'tags', json(CASE
           WHEN output_type = 'enum' AND (${LEGACY_ENUM_IS_VALID_TAGS})
           THEN enum_values_json
           ELSE '[]'
         END)
       ) AS column_json
       FROM input`,
    )
    .get(outputType, enumJson, Number(column.ordinal), title, prompt);
  return requireText(row?.column_json, "tabular column config target");
}

function targetColumnsConfigJson(
  database: WorkspaceDatabaseAdapter,
  columns: readonly Record<string, unknown>[],
  nulColumns?: ReadonlyMap<string, V7NulColumnSnapshot>,
) {
  const columnJson = columns.map((column) =>
    targetColumnConfigJson(
      database,
      column,
      nulColumns?.get(requireText(column.id, "tabular column id")),
    ),
  );
  return columnJson.length === 0 ? "[]" : `[${columnJson.join(",")}]`;
}

function buildNulRecoveryPlan(
  database: WorkspaceDatabaseAdapter,
): V7NulReviewSnapshot[] {
  const snapshots: V7NulReviewSnapshot[] = [];
  for (const reviewRow of rawRows(
    database,
    "SELECT id, title FROM tabular_reviews ORDER BY id ASC",
  )) {
    const reviewId = requireText(reviewRow.id, "tabular review id");
    const reviewTitle = requireText(reviewRow.title, "tabular review title");
    const columns = columnsForReview(database, reviewId);
    const columnSnapshots: V7NulColumnSnapshot[] = columns.map((column) => {
      const columnId = requireText(column.id, "tabular column id");
      const title = requireText(column.title, "tabular column title");
      const prompt = requireText(column.prompt, "tabular column prompt");
      const enumOriginal = parseStringArrayJson(column.enum_values_json);
      if (enumOriginal) {
        assertNoCanonicalCollision(
          enumOriginal,
          `tabular column ${columnId} enum values`,
        );
      }
      const enumCanonical = enumOriginal?.map(canonicalizeNul) ?? null;
      return {
        id: columnId,
        ordinal: Number(column.ordinal),
        title: fieldSnapshot(title),
        prompt: fieldSnapshot(prompt),
        enumValues: {
          original: enumOriginal,
          canonical: enumCanonical,
        },
      };
    });
    const hasNul =
      reviewTitle.includes("\0") ||
      columnSnapshots.some(
        (column) =>
          column.title.original.includes("\0") ||
          column.prompt.original.includes("\0") ||
          Boolean(
            column.enumValues.original?.some((value) => value.includes("\0")),
          ),
      );
    if (!hasNul) continue;
    snapshots.push({
      reviewId,
      review: {
        id: reviewId,
        title: fieldSnapshot(reviewTitle),
      },
      columns: columnSnapshots,
    });
  }
  return snapshots;
}

function nulSnapshotColumnsByReview(snapshots: readonly V7NulReviewSnapshot[]) {
  return new Map(
    snapshots.map((snapshot) => [
      snapshot.reviewId,
      new Map(snapshot.columns.map((column) => [column.id, column])),
    ]),
  );
}

function targetJobRewriteForStatus(status: string) {
  const branches = V7_JOB_DESTRUCTIVE_TARGETS.statusBranches as Record<
    string,
    {
      payloadJson: string;
      resultJson: string | null;
      errorCode: string | null;
      errorJson: string | null;
      leaseOwner: null;
      cancellationReason: string | null | "preserve";
    }
  >;
  return branches[status] ?? branches.failed;
}

function canonicalEnumTagsByColumnId(
  database: WorkspaceDatabaseAdapter,
  snapshots: readonly V7NulReviewSnapshot[],
) {
  const nulColumnsByReviewId = nulSnapshotColumnsByReview(snapshots);
  const tagsByColumnId = new Map<string, readonly string[]>();
  for (const row of rawRows(
    database,
    `SELECT review_id, id, output_type, enum_values_json
       FROM tabular_review_columns
      ORDER BY review_id ASC, ordinal ASC, id ASC`,
  )) {
    const columnId = requireText(row.id, "tabular column id");
    const reviewId = requireText(row.review_id, "tabular review id");
    const outputType = requireText(
      row.output_type,
      "tabular column output_type",
    );
    const nulColumn = nulColumnsByReviewId.get(reviewId)?.get(columnId);
    const enumValues =
      nulColumn?.enumValues.canonical ??
      parseStringArrayJson(row.enum_values_json);
    const tags =
      outputType === "enum" && enumValuesAreValid(enumValues) ? enumValues : [];
    tagsByColumnId.set(columnId, tags);
  }
  return tagsByColumnId;
}

function cellHasEnumMismatchAfterCanonicalization(
  cell: Record<string, unknown>,
  canonicalTagsByColumnId: ReadonlyMap<string, readonly string[]>,
) {
  const columnId = requireText(cell.column_id, "tabular cell column id");
  const tags = canonicalTagsByColumnId.get(columnId) ?? [];
  if (tags.length === 0) return false;
  if (typeof cell.value_json !== "string") return false;
  try {
    const value = JSON.parse(cell.value_json) as unknown;
    return typeof value === "string" && !tags.includes(value);
  } catch {
    return false;
  }
}

function targetCellErrorForReadonlyPlan(
  cell: Record<string, unknown>,
  canonicalTagsByColumnId: ReadonlyMap<string, readonly string[]>,
) {
  const status = requireText(cell.status, "tabular cell status");
  const legacyFailed = Number(cell.legacy_failed) === 1;
  const requiresReview =
    Number(cell.requires_review_without_enum) === 1 ||
    cellHasEnumMismatchAfterCanonicalization(cell, canonicalTagsByColumnId);
  if (status === "queued" || status === "running") {
    return V7_CELL_DESTRUCTIVE_TARGETS.branches.active;
  }
  if (legacyFailed) {
    return V7_CELL_DESTRUCTIVE_TARGETS.branches.preservedLegacyFailed;
  }
  if (requiresReview)
    return V7_CELL_DESTRUCTIVE_TARGETS.branches.requiresReview;
  return V7_CELL_DESTRUCTIVE_TARGETS.branches.nonFailedFinal;
}

function buildV7ReadOnlyPlan(
  database: WorkspaceDatabaseAdapter,
): V7ReadOnlyPlan {
  const nulSnapshots = buildNulRecoveryPlan(database);
  const destructiveEvidence: string[] = [];
  if (nulSnapshots.length > 0) {
    destructiveEvidence.push("tabular_nul_text_canonicalization");
  }
  const nulColumnsByReview = nulSnapshotColumnsByReview(nulSnapshots);
  const canonicalTagsByColumnId = canonicalEnumTagsByColumnId(
    database,
    nulSnapshots,
  );
  for (const job of rawRows(
    database,
    `SELECT id, status, payload_json, result_json, error_code, error_json,
            lease_owner, cancellation_reason
       FROM jobs
      WHERE type = 'tabular_cell'
      ORDER BY id ASC`,
  )) {
    const jobId = requireText(job.id, "tabular job id");
    const status = requireText(job.status, "tabular job status");
    const target = targetJobRewriteForStatus(status);
    if (job.payload_json !== target.payloadJson) {
      destructiveEvidence.push(`job:${jobId}:payload_json`);
    }
    if (job.result_json !== target.resultJson) {
      destructiveEvidence.push(`job:${jobId}:result_json`);
    }
    if (job.error_code !== target.errorCode) {
      destructiveEvidence.push(`job:${jobId}:error_code`);
    }
    if (job.error_json !== target.errorJson) {
      destructiveEvidence.push(`job:${jobId}:error_json`);
    }
    if (job.lease_owner !== target.leaseOwner) {
      destructiveEvidence.push(`job:${jobId}:lease_owner`);
    }
    if (
      target.cancellationReason !== "preserve" &&
      job.cancellation_reason !== target.cancellationReason
    ) {
      destructiveEvidence.push(`job:${jobId}:cancellation_reason`);
    }
  }
  for (const review of rawRows(
    database,
    "SELECT id, document_ids_json, columns_config_json FROM tabular_reviews ORDER BY id ASC",
  )) {
    const reviewId = requireText(review.id, "tabular review id");
    const targetDocumentIds = JSON.stringify(
      canonicalReviewDocumentIds(database, reviewId),
    );
    if (review.document_ids_json !== targetDocumentIds) {
      destructiveEvidence.push(`review:${reviewId}:document_ids_json`);
    }
    const nulColumns = nulColumnsByReview.get(reviewId);
    const targetColumnsConfig = targetColumnsConfigJson(
      database,
      columnsForReview(database, reviewId),
      nulColumns,
    );
    if (review.columns_config_json !== targetColumnsConfig) {
      destructiveEvidence.push(`review:${reviewId}:columns_config_json`);
    }
  }
  for (const message of rawRows(
    database,
    `SELECT id,
            annotations_json,
            CASE WHEN NOT (${LEGACY_CHAT_ANNOTATIONS_IS_VALID}) THEN 1 ELSE 0 END AS annotations_will_clear
       FROM tabular_review_chat_messages
      ORDER BY id ASC`,
  )) {
    const messageId = requireText(message.id, "tabular chat message id");
    if (
      Number(message.annotations_will_clear) === 1 &&
      message.annotations_json !== "[]"
    ) {
      destructiveEvidence.push(`chat_message:${messageId}:annotations_json`);
    }
  }
  for (const cell of rawRows(
    database,
    `SELECT tabular_cells.id,
            tabular_cells.status,
            tabular_cells.column_id,
            tabular_cells.value_json,
            tabular_cells.error_code,
            tabular_cells.error_json,
            CASE WHEN tabular_cells.status = 'failed' THEN 1 ELSE 0 END AS legacy_failed,
            CASE
              WHEN tabular_cells.content IS NOT NULL AND NOT (${LEGACY_CONTENT_IS_STRICT}) THEN 1
              WHEN tabular_cells.content IS NULL AND (${LEGACY_VALUE_REQUIRES_REVIEW}) THEN 1
              WHEN tabular_cells.status = 'complete' AND tabular_cells.content IS NULL AND tabular_cells.value_json IS NULL THEN 1
              WHEN NOT (${LEGACY_CITATIONS_IS_VALID}) THEN 1
              ELSE 0
            END AS requires_review_without_enum
       FROM tabular_cells
      ORDER BY id ASC`,
  )) {
    const cellId = requireText(cell.id, "tabular cell id");
    const target = targetCellErrorForReadonlyPlan(
      cell,
      canonicalTagsByColumnId,
    );
    if (cell.error_code != null && cell.error_code !== target.errorCode) {
      destructiveEvidence.push(`cell:${cellId}:error_code`);
    }
    if (cell.error_json != null && cell.error_json !== target.errorJson) {
      destructiveEvidence.push(`cell:${cellId}:error_json`);
    }
  }
  return {
    destructiveEvidence: [...new Set(destructiveEvidence)].sort(),
    nulSnapshots,
  };
}

function assertEncryptedDestructiveRewritePreflight(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
  plan: V7ReadOnlyPlan,
) {
  const reattested = isWorkspaceConnectionSqlcipherEncrypted(database);
  if (capabilities.sqlcipherEncrypted !== reattested) {
    throw new Error(V7_APPLY_POLICY.errors.inconsistentEncryptionCapability);
  }
  if (plan.destructiveEvidence.length > 0 && !reattested) {
    throw new Error(V7_APPLY_POLICY.errors.destructivePlaintext);
  }
}

function installNulRecoverySchema(database: WorkspaceDatabaseAdapter) {
  database.exec(V7_NUL_RECOVERY_SCHEMA_SQL);
}

function recordNulRecoverySnapshotsAndCanonicalize(
  database: WorkspaceDatabaseAdapter,
  plan: V7ReadOnlyPlan,
) {
  const insertSnapshot = database.prepare(
    `INSERT INTO ${V7_NUL_RECOVERY_TABLE}
      (review_id, schema, replacement, review_json, columns_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const updateReview = database.prepare(
    "UPDATE tabular_reviews SET title = ? WHERE id = ?",
  );
  const updateColumnTitle = database.prepare(
    "UPDATE tabular_review_columns SET title = ? WHERE id = ?",
  );
  const updateColumnPrompt = database.prepare(
    "UPDATE tabular_review_columns SET prompt = ? WHERE id = ?",
  );
  const updateColumnEnum = database.prepare(
    "UPDATE tabular_review_columns SET enum_values_json = ? WHERE id = ?",
  );
  for (const snapshot of plan.nulSnapshots) {
    insertSnapshot.run(
      snapshot.reviewId,
      V7_NUL_RECOVERY_SCHEMA,
      V7_NUL_REPLACEMENT,
      JSON.stringify(snapshot.review),
      JSON.stringify(snapshot.columns),
    );
    if (snapshot.review.title.original !== snapshot.review.title.canonical) {
      updateReview.run(snapshot.review.title.canonical, snapshot.reviewId);
    }
    for (const column of snapshot.columns) {
      if (column.title.original !== column.title.canonical) {
        updateColumnTitle.run(column.title.canonical, column.id);
      }
      if (column.prompt.original !== column.prompt.canonical) {
        updateColumnPrompt.run(column.prompt.canonical, column.id);
      }
      if (
        column.enumValues.canonical !== null &&
        column.enumValues.original?.some(
          (value, index) => value !== column.enumValues.canonical?.[index],
        )
      ) {
        updateColumnEnum.run(
          JSON.stringify(column.enumValues.canonical),
          column.id,
        );
      }
    }
  }
}

function lockNulRecoverySnapshots(database: WorkspaceDatabaseAdapter) {
  database.exec(V7_NUL_RECOVERY_LOCK_SQL);
}

function installNulRecoveryDeleteLifecycle(database: WorkspaceDatabaseAdapter) {
  database.exec(V7_NUL_RECOVERY_DELETE_LIFECYCLE_SQL);
}

function installLiveWriteGuards(database: WorkspaceDatabaseAdapter) {
  database.exec(V7_LIVE_TEXT_GUARD_SQL);
}

function assertNoPartialV7Markers(database: WorkspaceDatabaseAdapter) {
  const existingV7Markers = V7_SCHEMA_MARKERS.filter((marker) =>
    marker.kind === "column"
      ? hasColumn(database, marker.table, marker.name)
      : marker.kind === "table"
        ? hasTable(database, marker.name)
        : hasTrigger(database, marker.name),
  ).length;
  if (existingV7Markers > 0) {
    throw new Error(V7_APPLY_POLICY.errors.partialMarkers);
  }
}

function assertV7SchemaMarkersAndTriggerContracts(
  database: WorkspaceDatabaseAdapter,
) {
  for (const marker of V7_SCHEMA_MARKERS) {
    if (marker.kind === "column") {
      requireColumn(database, marker.table, marker.name, {
        notNull: "notNull" in marker && marker.notNull === true,
      });
    } else if (marker.kind === "table") {
      if (!hasTable(database, marker.name)) {
        throw new Error(
          `Workspace schema v7 is incomplete: ${marker.name} is missing.`,
        );
      }
    } else {
      const sql = triggerSql(database, marker.name);
      if (!sql) {
        throw new Error(
          `Workspace schema v7 is incomplete: ${marker.name} is missing.`,
        );
      }
      for (const required of marker.requiredSql) {
        if (!sql.includes(required)) {
          throw new Error(
            `Workspace schema v7 is incomplete: ${marker.name} does not enforce ${required}.`,
          );
        }
      }
    }
  }
}

function assertV7TriggerSelfChecks(database: WorkspaceDatabaseAdapter) {
  database
    .prepare(
      "UPDATE tabular_cells SET content = content WHERE content IS NOT NULL",
    )
    .run();
  database
    .prepare(
      "UPDATE tabular_cells SET citations_json = citations_json WHERE citations_json IS NOT NULL",
    )
    .run();
}

function assertV7SqlPostconditions(database: WorkspaceDatabaseAdapter) {
  for (const postcondition of V7_POSTCONDITIONS) {
    assertNoRows(database, postcondition.sql, postcondition.message);
  }
}

function runDeclaredV7PersistenceValidator(database: WorkspaceDatabaseAdapter) {
  if (
    V7_APPLY_POLICY.validator.name !== "validateTabularPersistenceV7" ||
    V7_APPLY_POLICY.validator.fingerprint !==
      TABULAR_PERSISTENCE_VALIDATOR_FINGERPRINT
  ) {
    throw new Error(V7_APPLY_POLICY.errors.validatorBinding);
  }
  validateTabularPersistenceV7(database);
}

function assertTabularMikeSemanticsV7(database: WorkspaceDatabaseAdapter) {
  assertV7SchemaMarkersAndTriggerContracts(database);
  assertV7TriggerSelfChecks(database);
  assertV7SqlPostconditions(database);
  runDeclaredV7PersistenceValidator(database);
}

function applyTabularMikeSemanticsV7(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  const stages = createV7ApplyStageGuard();
  let plan: V7ReadOnlyPlan | null = null;
  stages.enterStage("assert_sqlite_json_capability");
  if (!capabilities[V7_APPLY_POLICY.requiredCapability]) {
    throw new Error(V7_APPLY_POLICY.errors.missingCapability);
  }
  stages.enterStage("assert_no_partial_v7_schema_markers");
  assertNoPartialV7Markers(database);
  stages.enterStage("build_v7_readonly_rewrite_plan");
  plan = buildV7ReadOnlyPlan(database);
  stages.enterStage("assert_encrypted_destructive_rewrite_preflight");
  assertEncryptedDestructiveRewritePreflight(database, capabilities, plan);
  stages.enterStage("install_nul_recovery_schema");
  installNulRecoverySchema(database);
  stages.enterStage("record_nul_recovery_snapshots_and_canonicalize");
  recordNulRecoverySnapshotsAndCanonicalize(database, plan);
  stages.enterStage("lock_nul_recovery_snapshots");
  lockNulRecoverySnapshots(database);
  stages.enterStage("install_nul_recovery_delete_lifecycle");
  installNulRecoveryDeleteLifecycle(database);
  stages.enterStage("install_tabular_mike_semantics_sql");
  database.exec(TABULAR_MIKE_SEMANTICS_V7_SQL);
  stages.enterStage("install_v7_live_write_guards");
  installLiveWriteGuards(database);
  stages.enterStage("assert_schema_markers_and_trigger_contracts");
  assertV7SchemaMarkersAndTriggerContracts(database);
  stages.enterStage("run_trigger_self_checks");
  assertV7TriggerSelfChecks(database);
  stages.enterStage("assert_v7_sql_postconditions");
  assertV7SqlPostconditions(database);
  stages.enterStage("run_declared_frozen_persistence_validator");
  runDeclaredV7PersistenceValidator(database);
  stages.assertComplete();
}

export const TABULAR_MIKE_SEMANTICS_V7_MIGRATION: WorkspaceMigration = {
  version: 7,
  name: "tabular_mike_semantics",
  checksumMaterial: [
    "workspace-migration-v7",
    "mike-tabular-format-tags-structured-cells-review-chat-bindings",
    "partial-v7-marker-fail-closed",
    "no-rollback-preserve-legacy-recovery-data",
    "assert-matrix-cell-source-review-chat-invariants-before-record",
    JSON.stringify(V7_SCHEMA_MARKERS),
    JSON.stringify(V7_POSTCONDITIONS),
    JSON.stringify(V7_REPAIR_POLICY_CHECKSUM_MATERIAL),
    JSON.stringify(V7_APPLY_POLICY),
    JSON.stringify(TABULAR_PERSISTED_V7_CONTRACT),
    TABULAR_PERSISTENCE_VALIDATOR_FINGERPRINT,
    LEGACY_CITATIONS_IS_VALID,
    LEGACY_CONTENT_IS_STRICT,
    LEGACY_ENUM_IS_VALID_TAGS,
    LEGACY_FAILED_ERROR_JSON_SQL,
    LEGACY_CONTENT_REQUIRES_REVIEW_ERROR_JSON_SQL,
    TABULAR_REGENERATION_REQUIRED_ERROR_JSON_SQL,
    LEGACY_FAILED_ERROR_JSON_TEXT,
    LEGACY_CONTENT_REQUIRES_REVIEW_ERROR_JSON_TEXT,
    TABULAR_REGENERATION_REQUIRED_ERROR_JSON_TEXT,
    WORKSPACE_SQLCIPHER_CONNECTION_POLICY_MATERIAL,
    V7_NUL_RECOVERY_SCHEMA_SQL,
    V7_NUL_RECOVERY_LOCK_SQL,
    V7_NUL_RECOVERY_DELETE_LIFECYCLE_SQL,
    V7_LIVE_TEXT_GUARD_SQL,
    TABULAR_MIKE_SEMANTICS_V7_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyTabularMikeSemanticsV7,
};
