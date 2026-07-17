import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";
import { ASSISTANT_ACTION_LEDGER_V19_MIGRATION } from "./v19AssistantActionLedger";

const EVENT_COLUMNS =
  "job_id,sequence,attempt,event_type,event_json,terminal,created_at";
const ACTION_COLUMNS =
  "job_id,action_key,action_type,project_id,input_sha256,status," +
  "reserved_attempt,reserved_lease_owner,completed_attempt,completed_lease_owner," +
  "resource_type,resource_id,created_at,updated_at,completed_at";
const V24_REPLACEMENTS = Object.freeze({
  eventType: Object.freeze([
    "'citation_data', 'draft_created', 'complete', 'error'",
    "'citation_data', 'draft_created', 'tabular_review_created', 'complete', 'error'",
  ]),
  actionType: Object.freeze([
    "action_type IN ('create_draft', 'suggest_draft_edit', 'run_workflow')",
    "action_type IN ('create_draft', 'suggest_draft_edit', 'run_workflow', 'run_contract_review')",
  ]),
  actionResource: Object.freeze([
    "resource_type IN ('draft', 'draft_suggestion', 'workflow_run')",
    "resource_type IN ('draft', 'draft_suggestion', 'workflow_run', 'tabular_review')",
  ]),
  actionResourceBinding: Object.freeze([
    "(action_type = 'run_workflow' AND resource_type = 'workflow_run')",
    "(action_type = 'run_workflow' AND resource_type = 'workflow_run') OR\n    (action_type = 'run_contract_review' AND resource_type = 'tabular_review')",
  ]),
  actionBudget: Object.freeze([
    "WHEN 'run_workflow' THEN 2\n  END",
    "WHEN 'run_workflow' THEN 2\n    WHEN 'run_contract_review' THEN 1\n  END",
  ]),
} as const);

function requiredSql(
  database: WorkspaceDatabaseAdapter,
  type: "table" | "index" | "trigger",
  name: string,
) {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=?")
    .get(type, name);
  if (typeof row?.sql !== "string" || row.sql.trim().length === 0) {
    throw new Error(`Workspace schema v24 requires the intact ${name}.`);
  }
  return row.sql;
}

function normalizedSql(value: string) {
  return value.trim().replace(/;$/, "").trim();
}

function canonicalV19Sql(pattern: RegExp, name: string) {
  const match = ASSISTANT_ACTION_LEDGER_V19_MIGRATION.checksumMaterial.match(pattern);
  if (!match?.[0]) {
    throw new Error(`Workspace schema v24 is missing canonical v19 ${name}.`);
  }
  return match[1] ?? match[0];
}

function assertCanonicalLiveSql(
  database: WorkspaceDatabaseAdapter,
  type: "table" | "index" | "trigger",
  name: string,
  canonical: string,
) {
  const live = requiredSql(database, type, name);
  if (normalizedSql(live) !== normalizedSql(canonical)) {
    throw new Error(
      `Workspace schema v24 refuses non-canonical live definition for ${name}.`,
    );
  }
}

function replaceOnce(source: string, before: string, after: string, name: string) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Workspace schema v24 cannot safely transform ${name}.`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function apply(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error("Workspace schema v24 requires SQLite JSON1.");
  }

  const eventCount = Number(
    database.prepare("SELECT count(*) AS count FROM assistant_generation_events").get()?.count ?? 0,
  );
  const actionCount = Number(
    database.prepare("SELECT count(*) AS count FROM assistant_action_ledger").get()?.count ?? 0,
  );

  // Use the installed v19 table definitions as the source, rather than a
  // shortened reimplementation. Every typeof/trim/NUL/date/JSON/FK/terminal
  // guard therefore survives byte-for-byte except the three explicit enum
  // additions below. Migration checksums already attest that v19 is intact.
  const canonicalEventTable = canonicalV19Sql(
    /CREATE TABLE assistant_generation_events \([\s\S]*?\) WITHOUT ROWID;/,
    "Assistant event table",
  );
  const canonicalActionTable = canonicalV19Sql(
    /CREATE TABLE assistant_action_ledger \([\s\S]*?\) WITHOUT ROWID;/,
    "Assistant action table",
  );
  assertCanonicalLiveSql(
    database,
    "table",
    "assistant_generation_events",
    canonicalEventTable,
  );
  assertCanonicalLiveSql(
    database,
    "table",
    "assistant_action_ledger",
    canonicalActionTable,
  );

  let eventTable = canonicalEventTable;
  eventTable = replaceOnce(
    eventTable,
    "CREATE TABLE assistant_generation_events",
    "CREATE TABLE assistant_generation_events_v24",
    "Assistant event table name",
  );
  eventTable = replaceOnce(
    eventTable,
    V24_REPLACEMENTS.eventType[0],
    V24_REPLACEMENTS.eventType[1],
    "Assistant event type CHECK",
  );

  let actionTable = canonicalActionTable;
  actionTable = replaceOnce(
    actionTable,
    "CREATE TABLE assistant_action_ledger",
    "CREATE TABLE assistant_action_ledger_v24",
    "Assistant action table name",
  );
  actionTable = replaceOnce(
    actionTable,
    V24_REPLACEMENTS.actionType[0],
    V24_REPLACEMENTS.actionType[1],
    "Assistant action type CHECK",
  );
  actionTable = replaceOnce(
    actionTable,
    V24_REPLACEMENTS.actionResource[0],
    V24_REPLACEMENTS.actionResource[1],
    "Assistant action resource CHECK",
  );
  actionTable = replaceOnce(
    actionTable,
    V24_REPLACEMENTS.actionResourceBinding[0],
    V24_REPLACEMENTS.actionResourceBinding[1],
    "Assistant action/resource binding CHECK",
  );

  const eventAttemptIndex = canonicalV19Sql(
    /CREATE INDEX idx_assistant_generation_events_attempt[\s\S]*?;/,
    "Assistant event attempt index",
  );
  const eventTerminalIndex = canonicalV19Sql(
    /CREATE UNIQUE INDEX idx_assistant_generation_events_terminal[\s\S]*?;/,
    "Assistant event terminal index",
  );
  const eventImmutableTrigger = canonicalV19Sql(
    /CREATE TRIGGER assistant_generation_events_immutable[\s\S]*?END;/,
    "Assistant event immutability trigger",
  );
  const actionBudgetIndex = canonicalV19Sql(
    /CREATE INDEX idx_assistant_action_ledger_budget[\s\S]*?;/,
    "Assistant action budget index",
  );
  const actionResourceIndex = canonicalV19Sql(
    /CREATE INDEX idx_assistant_action_ledger_resource[\s\S]*?;/,
    "Assistant action resource index",
  );
  let actionInsertTrigger = canonicalV19Sql(
    /(CREATE TRIGGER assistant_action_ledger_v19_insert_guard[\s\S]*?\nEND;)\n\nCREATE TRIGGER assistant_action_ledger_v19_update_guard/,
    "Assistant action insert trigger",
  );
  actionInsertTrigger = replaceOnce(
    actionInsertTrigger,
    V24_REPLACEMENTS.actionBudget[0],
    V24_REPLACEMENTS.actionBudget[1],
    "Assistant action budget trigger",
  );
  const actionUpdateTrigger = canonicalV19Sql(
    /(CREATE TRIGGER assistant_action_ledger_v19_update_guard[\s\S]*?\nEND;)(?:\n-- checksum boundary --|\n?$)/,
    "Assistant action update trigger",
  );
  for (const [type, name, canonical] of [
    ["index", "idx_assistant_generation_events_attempt", eventAttemptIndex],
    ["index", "idx_assistant_generation_events_terminal", eventTerminalIndex],
    ["trigger", "assistant_generation_events_immutable", eventImmutableTrigger],
    ["index", "idx_assistant_action_ledger_budget", actionBudgetIndex],
    ["index", "idx_assistant_action_ledger_resource", actionResourceIndex],
    ["trigger", "assistant_action_ledger_v19_insert_guard", canonicalV19Sql(/(CREATE TRIGGER assistant_action_ledger_v19_insert_guard[\s\S]*?\nEND;)\n\nCREATE TRIGGER assistant_action_ledger_v19_update_guard/, "Assistant action insert trigger")],
    ["trigger", "assistant_action_ledger_v19_update_guard", actionUpdateTrigger],
  ] as const) {
    assertCanonicalLiveSql(database, type, name, canonical);
  }

  database.exec(eventTable);
  database.exec(
    `INSERT INTO assistant_generation_events_v24 (${EVENT_COLUMNS}) ` +
      `SELECT ${EVENT_COLUMNS} FROM assistant_generation_events`,
  );
  database.exec("DROP TABLE assistant_generation_events");
  database.exec(
    "ALTER TABLE assistant_generation_events_v24 RENAME TO assistant_generation_events",
  );
  database.exec(eventAttemptIndex);
  database.exec(eventTerminalIndex);
  database.exec(eventImmutableTrigger);

  database.exec(actionTable);
  database.exec(
    `INSERT INTO assistant_action_ledger_v24 (${ACTION_COLUMNS}) ` +
      `SELECT ${ACTION_COLUMNS} FROM assistant_action_ledger`,
  );
  database.exec("DROP TABLE assistant_action_ledger");
  database.exec(
    "ALTER TABLE assistant_action_ledger_v24 RENAME TO assistant_action_ledger",
  );
  database.exec(actionBudgetIndex);
  database.exec(actionResourceIndex);
  database.exec(actionInsertTrigger);
  database.exec(actionUpdateTrigger);

  const migratedEventCount = Number(
    database.prepare("SELECT count(*) AS count FROM assistant_generation_events").get()?.count ?? -1,
  );
  const migratedActionCount = Number(
    database.prepare("SELECT count(*) AS count FROM assistant_action_ledger").get()?.count ?? -1,
  );
  const installedEventSql = requiredSql(
    database,
    "table",
    "assistant_generation_events",
  );
  const installedActionSql = requiredSql(
    database,
    "table",
    "assistant_action_ledger",
  );
  if (
    migratedEventCount !== eventCount ||
    migratedActionCount !== actionCount ||
    !installedEventSql.includes("'tabular_review_created'") ||
    !installedEventSql.includes("typeof(event_json) = 'text'") ||
    !installedEventSql.includes("json_extract(event_json, '$.type') = event_type") ||
    !installedActionSql.includes("'run_contract_review'") ||
    !installedActionSql.includes("'tabular_review'") ||
    !installedActionSql.includes("instr(action_key, char(0)) = 0") ||
    !installedActionSql.includes("strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at")
  ) {
    throw new Error(
      "Workspace schema v24 did not preserve strict Assistant durability constraints.",
    );
  }
}

export const ASSISTANT_CONTRACT_REVIEW_V24_MIGRATION: WorkspaceMigration = {
  version: 24,
  name: "assistant_contract_review",
  checksumMaterial: [
    "workspace-migration-v24",
    "lossless-v19-event-and-action-table-rebuild",
    "preserve-all-v19-type-trim-nul-json-datetime-fk-terminal-claim-and-immutability-guards",
    "add-only-tabular-review-created-run-contract-review-and-tabular-review-enums",
    "contract-review-action-budget-one",
    ASSISTANT_ACTION_LEDGER_V19_MIGRATION.checksumMaterial,
    ...Object.entries(V24_REPLACEMENTS).flatMap(([name, replacement]) => [
      name,
      replacement[0],
      replacement[1],
    ]),
  ].join("\n-- checksum boundary --\n"),
  apply,
};
