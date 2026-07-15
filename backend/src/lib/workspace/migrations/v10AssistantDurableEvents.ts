import { WorkspaceMigrationError } from "./runner";
import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const TABLE = "assistant_generation_events";
const INDEX = "idx_assistant_generation_events_attempt";
const TERMINAL_INDEX = "idx_assistant_generation_events_terminal";
const IMMUTABLE_TRIGGER = "assistant_generation_events_immutable";
const MAX_EVENT_CHARS = 250_000;
const MAX_EVENT_SEQUENCE = 2_147_483_647;
const MAX_ATTEMPTS = 100;

const EVENT_TYPES = [
  "chat_id",
  "status",
  "content_delta",
  "content_done",
  "reasoning_delta",
  "reasoning_block_end",
  "tool_call_start",
  "doc_read_start",
  "doc_read",
  "doc_find_start",
  "doc_find",
  "workflow_applied",
  "citation_data",
  "complete",
  "error",
] as const;

const sqlStrings = (values: readonly string[]) =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");

const CREATE_SCHEMA_SQL = `
CREATE TABLE ${TABLE} (
  job_id TEXT NOT NULL
    CHECK (typeof(job_id) = 'text' AND length(trim(job_id)) >= 1)
    REFERENCES assistant_generation_snapshots(job_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL
    CHECK (
      typeof(sequence) = 'integer'
      AND sequence BETWEEN 1 AND ${MAX_EVENT_SEQUENCE}
    ),
  attempt INTEGER NOT NULL
    CHECK (
      typeof(attempt) = 'integer'
      AND attempt BETWEEN 1 AND ${MAX_ATTEMPTS}
    ),
  event_type TEXT NOT NULL
    CHECK (
      typeof(event_type) = 'text'
      AND event_type IN (${sqlStrings(EVENT_TYPES)})
    ),
  event_json TEXT NOT NULL
    CHECK (
      typeof(event_json) = 'text'
      AND length(event_json) BETWEEN 2 AND ${MAX_EVENT_CHARS}
      AND json_valid(event_json)
      AND json_type(event_json) = 'object'
      AND json_type(event_json, '$.type') = 'text'
      AND json_extract(event_json, '$.type') = event_type
    ),
  terminal INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(terminal) = 'integer' AND terminal IN (0, 1)),
  created_at TEXT NOT NULL
    CHECK (
      typeof(created_at) = 'text'
      AND length(created_at) = 24
      AND created_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    ),
  PRIMARY KEY (job_id, sequence),
  CHECK (
    (terminal = 0 AND event_type NOT IN ('complete', 'error'))
    OR
    (terminal = 1 AND event_type IN ('complete', 'error'))
  )
) WITHOUT ROWID;

CREATE INDEX ${INDEX}
  ON ${TABLE}(job_id, attempt, sequence);

CREATE UNIQUE INDEX ${TERMINAL_INDEX}
  ON ${TABLE}(job_id, attempt)
  WHERE terminal = 1;

CREATE TRIGGER ${IMMUTABLE_TRIGGER}
BEFORE UPDATE ON ${TABLE}
BEGIN
  SELECT RAISE(ABORT, 'assistant generation events are immutable');
END;
`;

const BACKFILL_MESSAGE_TERMINALS_SQL = `
UPDATE chat_messages
   SET status = CASE (
         SELECT job.status FROM jobs job WHERE job.id = chat_messages.job_id
       )
         WHEN 'failed' THEN 'failed'
         WHEN 'cancelled' THEN 'cancelled'
         WHEN 'interrupted' THEN 'interrupted'
         ELSE status
       END,
       error_code = CASE (
         SELECT job.status FROM jobs job WHERE job.id = chat_messages.job_id
       )
         WHEN 'failed' THEN coalesce(error_code, 'assistant_generation_failed')
         WHEN 'cancelled' THEN coalesce(error_code, 'assistant_cancelled')
         WHEN 'interrupted' THEN coalesce(error_code, 'assistant_generation_interrupted')
         ELSE error_code
       END,
       completed_at = coalesce(completed_at, (
         SELECT job.completed_at FROM jobs job WHERE job.id = chat_messages.job_id
       )),
       updated_at = coalesce((
         SELECT job.updated_at FROM jobs job WHERE job.id = chat_messages.job_id
       ), updated_at)
 WHERE role = 'assistant'
   AND status IN ('pending', 'streaming')
   AND job_id IN (
     SELECT snapshot.job_id
       FROM assistant_generation_snapshots snapshot
       JOIN jobs job ON job.id = snapshot.job_id
      WHERE job.status IN ('failed', 'cancelled', 'interrupted')
   );
`;

const BACKFILL_EVENTS_SQL = `
INSERT INTO ${TABLE}
  (job_id, sequence, attempt, event_type, event_json, terminal, created_at)
SELECT snapshot.job_id,
       1,
       CASE WHEN job.status = 'queued' THEN job.attempt + 1
            WHEN job.attempt < 1 THEN 1 ELSE job.attempt END,
       'chat_id',
       json_object('type', 'chat_id', 'chatId', snapshot.chat_id),
       0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM assistant_generation_snapshots snapshot
  JOIN jobs job ON job.id = snapshot.job_id;

INSERT INTO ${TABLE}
  (job_id, sequence, attempt, event_type, event_json, terminal, created_at)
SELECT snapshot.job_id,
       2,
       CASE WHEN job.status = 'queued' THEN job.attempt + 1
            WHEN job.attempt < 1 THEN 1 ELSE job.attempt END,
       'status',
       json_object(
         'type', 'status',
         'job_id', snapshot.job_id,
         'status', CASE WHEN job.status = 'queued' THEN 'queued' ELSE 'running' END
       ),
       0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM assistant_generation_snapshots snapshot
  JOIN jobs job ON job.id = snapshot.job_id;

INSERT INTO ${TABLE}
  (job_id, sequence, attempt, event_type, event_json, terminal, created_at)
SELECT snapshot.job_id,
       3,
       CASE WHEN job.attempt < 1 THEN 1 ELSE job.attempt END,
       'content_done',
       json_object('type', 'content_done'),
       0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM assistant_generation_snapshots snapshot
  JOIN jobs job ON job.id = snapshot.job_id
 WHERE job.status = 'complete';

INSERT INTO ${TABLE}
  (job_id, sequence, attempt, event_type, event_json, terminal, created_at)
SELECT snapshot.job_id,
       CASE WHEN job.status = 'complete' THEN 4 ELSE 3 END,
       CASE WHEN job.attempt < 1 THEN 1 ELSE job.attempt END,
       CASE WHEN job.status = 'complete' THEN 'complete' ELSE 'error' END,
       CASE job.status
         WHEN 'complete' THEN json_object(
           'type', 'complete',
           'message_id', snapshot.output_message_id,
           'job_id', snapshot.job_id
         )
         WHEN 'cancelled' THEN json_object(
           'type', 'error',
           'code', 'assistant_cancelled',
           'message', 'Assistant generation was cancelled.'
         )
         WHEN 'interrupted' THEN json_object(
           'type', 'error',
           'code', 'assistant_generation_interrupted',
           'message', 'Assistant generation was interrupted.'
         )
         ELSE json_object(
           'type', 'error',
           'code', 'assistant_generation_failed',
           'message', 'Assistant generation failed.'
         )
       END,
       1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM assistant_generation_snapshots snapshot
  JOIN jobs job ON job.id = snapshot.job_id
 WHERE job.status IN ('complete', 'failed', 'cancelled', 'interrupted');
`;

const V10_POLICY = JSON.stringify({
  table: TABLE,
  source: "same SQLCipher workspace database as jobs/messages/snapshots",
  ordering: "strictly increasing per-job integer sequence",
  replay: "active attempt only; Last-Event-ID resumes after sequence",
  attempts: {
    initialQueuedAttempt: 1,
    queuedAfterRetry: "jobs.attempt + 1",
    runningOrTerminal: "max(jobs.attempt, 1)",
  },
  terminal: "exactly zero or one per job attempt; complete/error only",
  immutable: "updates rejected; ownership cascade remains enabled",
  maximumSerializedEventCharacters: MAX_EVENT_CHARS,
  secretAndPathMaterial: "rejected by typed application boundary before insert",
  disconnect: "reader lifecycle never mutates job cancellation state",
});

function hasObject(database: WorkspaceDatabaseAdapter, name: string) {
  return Boolean(
    database
      .prepare(
        `SELECT 1 AS present FROM main.sqlite_schema WHERE name=? COLLATE NOCASE`,
      )
      .get(name),
  );
}

function assertPrerequisites(database: WorkspaceDatabaseAdapter) {
  for (const table of [
    "assistant_generation_snapshots",
    "chat_messages",
    "jobs",
  ]) {
    if (!hasObject(database, table)) {
      throw new WorkspaceMigrationError(
        "Workspace schema v10 requires the complete Assistant v5 and jobs v7 schema.",
      );
    }
  }
  for (const marker of [TABLE, INDEX, TERMINAL_INDEX, IMMUTABLE_TRIGGER]) {
    if (hasObject(database, marker)) {
      throw new WorkspaceMigrationError(
        "Workspace schema v10 markers exist without a recorded v10 migration.",
      );
    }
  }
}

function assertPostconditions(database: WorkspaceDatabaseAdapter) {
  const columns = database.prepare(`PRAGMA main.table_info('${TABLE}')`).all();
  if (
    columns.length !== 7 ||
    columns.map((column) => String(column.name)).join(",") !==
      "job_id,sequence,attempt,event_type,event_json,terminal,created_at"
  ) {
    throw new WorkspaceMigrationError(
      "Workspace schema v10 Assistant event columns are incomplete.",
    );
  }
  const foreignKeys = database
    .prepare(`PRAGMA main.foreign_key_list('${TABLE}')`)
    .all();
  if (
    foreignKeys.length !== 1 ||
    String(foreignKeys[0]?.table) !== "assistant_generation_snapshots" ||
    String(foreignKeys[0]?.from) !== "job_id" ||
    String(foreignKeys[0]?.to) !== "job_id" ||
    String(foreignKeys[0]?.on_delete).toUpperCase() !== "CASCADE"
  ) {
    throw new WorkspaceMigrationError(
      "Workspace schema v10 Assistant event ownership is incomplete.",
    );
  }
  const duplicateTerminal = database
    .prepare(
      `SELECT 1 AS invalid
         FROM ${TABLE}
        WHERE terminal=1
        GROUP BY job_id,attempt
       HAVING count(*)<>1
        LIMIT 1`,
    )
    .get();
  const invalidTerminalState = database
    .prepare(
      `SELECT 1 AS invalid
         FROM assistant_generation_snapshots snapshot
         JOIN jobs job ON job.id=snapshot.job_id
        WHERE job.status IN ('complete','failed','cancelled','interrupted')
          AND NOT EXISTS (
            SELECT 1 FROM ${TABLE} event
             WHERE event.job_id=snapshot.job_id AND event.terminal=1
          )
        LIMIT 1`,
    )
    .get();
  if (duplicateTerminal || invalidTerminalState) {
    throw new WorkspaceMigrationError(
      "Workspace schema v10 Assistant terminal backfill is incomplete.",
    );
  }
}

function applyAssistantDurableEventsV10(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new WorkspaceMigrationError(
      "Workspace schema v10 requires SQLite JSON validation support.",
    );
  }
  assertPrerequisites(database);
  database.exec(CREATE_SCHEMA_SQL);
  database.exec(BACKFILL_MESSAGE_TERMINALS_SQL);
  database.exec(BACKFILL_EVENTS_SQL);
  assertPostconditions(database);
}

export const ASSISTANT_DURABLE_EVENTS_V10_MIGRATION: WorkspaceMigration = {
  version: 10,
  name: "assistant_durable_event_outbox",
  checksumMaterial: [
    "workspace-migration-v10",
    CREATE_SCHEMA_SQL,
    BACKFILL_MESSAGE_TERMINALS_SQL,
    BACKFILL_EVENTS_SQL,
    V10_POLICY,
  ].join("\n-- checksum boundary --\n"),
  apply: applyAssistantDurableEventsV10,
};
