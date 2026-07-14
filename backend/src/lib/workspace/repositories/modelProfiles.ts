import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  credentialStateFromPublicStatus,
  publicStatusFromCredentialState,
  tryNormalizeModelEndpoint,
  type CredentialState,
} from "../modelCompatibility";
import type { ModelProfile } from "../types";
import {
  assertStoredCredentialReference,
  isStoredCredentialReference,
} from "../services/credentialStore";

type Row = Record<string, unknown>;
type Caps = ModelProfile["capabilities"];

export type StoredModelProfileRecord = ModelProfile & {
  credentialRef: string | null;
  credentialOrigin: string | null;
  credentialState: CredentialState;
  migrationIssueCode: string | null;
  executionRevision: number;
};

export type ActiveModelProfileJob = {
  id: string;
  status: "queued" | "running";
};

type ModelProfilesSchema = {
  hasCredentialOrigin: boolean;
  hasCredentialState: boolean;
  hasMigrationIssueCode: boolean;
  hasExecutionRevision: boolean;
};

function capabilities(raw: unknown): Caps {
  try {
    const value = JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
    const keys = ["streaming", "toolCalling", "structuredOutput", "vision"];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => typeof value[key] !== "boolean")
    ) {
      throw new Error();
    }
    return {
      streaming: value.streaming as boolean,
      toolCalling: value.toolCalling as boolean,
      structuredOutput: value.structuredOutput as boolean,
      vision: value.vision as boolean,
    };
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Model capabilities are corrupt.",
    );
  }
}

function nullableString(value: unknown) {
  return value == null ? null : String(value);
}

function mapStored(
  row: Row,
  schema: ModelProfilesSchema,
): StoredModelProfileRecord {
  const credentialState = schema.hasCredentialState
    ? (String(row.credential_state ?? "missing") as CredentialState)
    : credentialStateFromPublicStatus(
        row.credential_status as ModelProfile["credentialStatus"],
      );
  return {
    id: String(row.id),
    name: String(row.name),
    provider: row.provider as ModelProfile["provider"],
    model: String(row.model),
    baseUrl: nullableString(row.base_url),
    credentialStatus: publicStatusFromCredentialState(credentialState),
    credentialRef: nullableString(row.credential_ref),
    credentialOrigin: schema.hasCredentialOrigin
      ? nullableString(row.credential_origin)
      : null,
    credentialState,
    migrationIssueCode: schema.hasMigrationIssueCode
      ? nullableString(row.migration_issue_code)
      : null,
    executionRevision: schema.hasExecutionRevision
      ? Number(row.execution_revision ?? 0)
      : 0,
    contextWindowTokens:
      row.context_window_tokens == null
        ? null
        : Number(row.context_window_tokens),
    maxOutputTokens:
      row.max_output_tokens == null ? null : Number(row.max_output_tokens),
    enabled: Number(row.enabled) === 1,
    capabilities: capabilities(row.capabilities_json),
    isDefault: Number(row.is_default) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPublic(record: StoredModelProfileRecord): ModelProfile {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    model: record.model,
    baseUrl: record.baseUrl,
    credentialStatus: record.credentialStatus,
    contextWindowTokens: record.contextWindowTokens,
    maxOutputTokens: record.maxOutputTokens,
    enabled: record.enabled,
    capabilities: record.capabilities,
    isDefault: record.isDefault,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapActiveJob(row: Row): ActiveModelProfileJob {
  const status = String(row.status);
  if (status !== "queued" && status !== "running") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid active job status.",
    );
  }
  return { id: String(row.id), status };
}

export class ModelProfilesRepository {
  private schemaCache: ModelProfilesSchema | null = null;
  private tableCache = new Map<string, boolean>();
  private columnCache = new Map<string, boolean>();

  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private tx<T>(fn: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private schema() {
    if (this.schemaCache) return this.schemaCache;
    const columns = new Set(
      this.database
        .prepare(`PRAGMA table_info("model_profiles")`)
        .all()
        .map((row) => String(row.name)),
    );
    this.schemaCache = {
      hasCredentialOrigin: columns.has("credential_origin"),
      hasCredentialState: columns.has("credential_state"),
      hasMigrationIssueCode: columns.has("migration_issue_code"),
      hasExecutionRevision: columns.has("execution_revision"),
    };
    return this.schemaCache;
  }

  private hasTable(name: string) {
    const cached = this.tableCache.get(name);
    if (cached !== undefined) return cached;
    const exists = Boolean(
      this.database
        .prepare(
          `SELECT name
             FROM sqlite_schema
            WHERE type = 'table' AND name = ?`,
        )
        .get(name),
    );
    this.tableCache.set(name, exists);
    return exists;
  }

  private hasColumn(table: string, column: string) {
    const key = `${table}.${column}`;
    const cached = this.columnCache.get(key);
    if (cached !== undefined) return cached;
    if (!this.hasTable(table)) {
      this.columnCache.set(key, false);
      return false;
    }
    const exists = this.database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .some((row) => String(row.name) === column);
    this.columnCache.set(key, exists);
    return exists;
  }

  private currentOrigin(record: StoredModelProfileRecord) {
    if (record.credentialOrigin !== null) return record.credentialOrigin;
    return (
      tryNormalizeModelEndpoint({
        provider: record.provider,
        baseUrl: record.baseUrl,
        allowLocalDevelopmentBaseUrl: true,
      })?.canonicalOrigin ?? null
    );
  }

  private requireStoredInternal(id: string) {
    const row = this.database
      .prepare("SELECT * FROM model_profiles WHERE id = ?")
      .get(id);
    if (!row) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Model profile not found.");
    }
    return mapStored(row, this.schema());
  }

  private validateCredentialBinding(
    id: string,
    reference: string | null,
    state: CredentialState,
  ) {
    if (reference !== null) {
      assertStoredCredentialReference(reference, id);
    }
    if (state === "configured" && reference === null) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Configured credentials require a stored reference.",
      );
    }
    if (state === "missing" && reference !== null) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Missing credentials cannot retain a stored reference.",
      );
    }
  }

  private listActiveJobsForProfileInternal(id: string) {
    const assistantSnapshotCte = this.hasTable("assistant_generation_snapshots")
      ? `,
  assistant_snapshot_jobs AS (
    SELECT job_id
      FROM assistant_generation_snapshots
     WHERE model_profile_id = (SELECT profile_id FROM target)
  )`
      : "";
    const workflowSnapshotCte = this.hasTable("workflow_execution_snapshots")
      ? `,
  workflow_snapshot_runs AS (
    SELECT workflow_run_id AS id
      FROM workflow_execution_snapshots
     WHERE model_profile_id = (SELECT profile_id FROM target)
  )`
      : "";
    const tabularChatCte =
      this.hasColumn("tabular_review_chats", "job_id") &&
      this.hasColumn("tabular_review_chats", "model_profile_id")
        ? `,
  tabular_chat_jobs AS (
    SELECT job_id
      FROM tabular_review_chats
     WHERE model_profile_id = (SELECT profile_id FROM target)
       AND job_id IS NOT NULL
  )`
        : "";
    const tabularMessageCte =
      this.hasColumn("tabular_review_chat_messages", "job_id") &&
      this.hasColumn("tabular_review_chat_messages", "model_profile_id")
        ? `,
  tabular_message_jobs AS (
    SELECT job_id
      FROM tabular_review_chat_messages
     WHERE model_profile_id = (SELECT profile_id FROM target)
       AND job_id IS NOT NULL
  )`
        : "";
    const assistantSnapshotPredicate = this.hasTable(
      "assistant_generation_snapshots",
    )
      ? `
              OR j.id IN (SELECT job_id FROM assistant_snapshot_jobs)`
      : "";
    const workflowSnapshotPredicate = this.hasTable(
      "workflow_execution_snapshots",
    )
      ? `
              OR (
                j.resource_type = 'workflow_run'
                AND j.resource_id IN (SELECT id FROM workflow_snapshot_runs)
              )`
      : "";
    const tabularChatPredicate =
      this.hasColumn("tabular_review_chats", "job_id") &&
      this.hasColumn("tabular_review_chats", "model_profile_id")
        ? `
              OR j.id IN (SELECT job_id FROM tabular_chat_jobs)`
        : "";
    const tabularMessagePredicate =
      this.hasColumn("tabular_review_chat_messages", "job_id") &&
      this.hasColumn("tabular_review_chat_messages", "model_profile_id")
        ? `
              OR j.id IN (SELECT job_id FROM tabular_message_jobs)`
        : "";

    return this.database
      .prepare(
        `WITH target(profile_id) AS (VALUES (?)),
  profile_chats AS (
    SELECT id FROM chats WHERE model_profile_id = (SELECT profile_id FROM target)
  ),
  profile_reviews AS (
    SELECT id
      FROM tabular_reviews
     WHERE model_profile_id = (SELECT profile_id FROM target)
  ),
  profile_cells AS (
    SELECT cell.id
      FROM tabular_cells cell
      JOIN tabular_reviews review ON review.id = cell.review_id
     WHERE review.model_profile_id = (SELECT profile_id FROM target)
  ),
  profile_runs AS (
    SELECT id
      FROM workflow_runs
     WHERE model_profile_id = (SELECT profile_id FROM target)
  )${assistantSnapshotCte}${workflowSnapshotCte}${tabularChatCte}${tabularMessageCte}
         SELECT DISTINCT j.id, j.status
           FROM jobs j
          WHERE j.status IN ('queued', 'running')
            AND (
              (
                j.resource_type = 'chat'
                AND j.resource_id IN (SELECT id FROM profile_chats)
              )${assistantSnapshotPredicate}
              OR (
                j.resource_type = 'tabular_review'
                AND j.resource_id IN (SELECT id FROM profile_reviews)
              )
              OR (
                j.resource_type = 'tabular_cell'
                AND j.resource_id IN (SELECT id FROM profile_cells)
              )
              OR (
                j.resource_type = 'workflow_run'
                AND j.resource_id IN (SELECT id FROM profile_runs)
              )${workflowSnapshotPredicate}${tabularChatPredicate}${tabularMessagePredicate}
            )
          ORDER BY j.status, j.id`,
      )
      .all(id)
      .map(mapActiveJob);
  }

  private ensureNoActiveJobs(id: string, message: string) {
    if (this.listActiveJobsForProfileInternal(id).length > 0) {
      throw new WorkspaceApiError(409, "CONFLICT", message);
    }
  }

  private updateInternal(
    id: string,
    input: Partial<{
      name: string;
      provider: ModelProfile["provider"];
      model: string;
      baseUrl: string | null;
      credentialRef: string | null;
      credentialOrigin: string | null;
      credentialState: CredentialState;
      migrationIssueCode: string | null;
      contextWindowTokens: number | null;
      maxOutputTokens: number | null;
      enabled: boolean;
      isDefault: boolean;
      capabilities: Caps;
      executionRevision: number;
    }> & { now: string },
    options: { requireNoActiveJobs?: string } = {},
  ) {
    const current = this.requireStoredInternal(id);
    if (options.requireNoActiveJobs) {
      this.ensureNoActiveJobs(id, options.requireNoActiveJobs);
    }
    const enabled = input.enabled ?? current.enabled;
    if (input.isDefault === true && !enabled) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Default model profile must be enabled.",
      );
    }
    const nextCredentialRef =
      input.credentialRef === undefined
        ? current.credentialRef
        : input.credentialRef;
    const nextCredentialState =
      input.credentialState ?? current.credentialState;
    const nextCredentialOrigin =
      input.credentialOrigin === undefined
        ? current.credentialOrigin
        : input.credentialOrigin;
    const nextMigrationIssueCode =
      input.migrationIssueCode === undefined
        ? current.migrationIssueCode
        : input.migrationIssueCode;
    const executionRevisionChanged =
      (input.provider !== undefined && input.provider !== current.provider) ||
      (input.model !== undefined && input.model !== current.model) ||
      (input.baseUrl !== undefined && input.baseUrl !== current.baseUrl) ||
      (input.credentialRef !== undefined &&
        input.credentialRef !== current.credentialRef) ||
      (input.credentialOrigin !== undefined &&
        input.credentialOrigin !== current.credentialOrigin) ||
      (input.credentialState !== undefined &&
        input.credentialState !== current.credentialState) ||
      (input.enabled !== undefined && input.enabled !== current.enabled);
    this.validateCredentialBinding(id, nextCredentialRef, nextCredentialState);
    const schema = this.schema();
    const nextCredentialStatus =
      publicStatusFromCredentialState(nextCredentialState);
    const nextExecutionRevision =
      input.executionRevision !== undefined
        ? input.executionRevision
        : schema.hasExecutionRevision && executionRevisionChanged
          ? current.executionRevision + 1
          : current.executionRevision;
    if (
      schema.hasCredentialOrigin &&
      schema.hasCredentialState &&
      schema.hasMigrationIssueCode &&
      schema.hasExecutionRevision
    ) {
      this.database
        .prepare(
          `UPDATE model_profiles
              SET name = ?,
                  provider = ?,
                  model = ?,
                  base_url = ?,
                  credential_ref = ?,
                  credential_origin = ?,
                  credential_state = ?,
                  credential_status = ?,
                  migration_issue_code = ?,
                  execution_revision = ?,
                  context_window_tokens = ?,
                  max_output_tokens = ?,
                  enabled = ?,
                  capabilities_json = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.name ?? current.name,
          input.provider ?? current.provider,
          input.model ?? current.model,
          input.baseUrl === undefined ? current.baseUrl : input.baseUrl,
          nextCredentialRef,
          nextCredentialOrigin,
          nextCredentialState,
          nextCredentialStatus,
          nextMigrationIssueCode,
          nextExecutionRevision,
          input.contextWindowTokens === undefined
            ? current.contextWindowTokens
            : input.contextWindowTokens,
          input.maxOutputTokens === undefined
            ? current.maxOutputTokens
            : input.maxOutputTokens,
          enabled ? 1 : 0,
          JSON.stringify(input.capabilities ?? current.capabilities),
          input.now,
          id,
        );
    } else if (schema.hasCredentialOrigin && schema.hasCredentialState) {
      this.database
        .prepare(
          `UPDATE model_profiles
              SET name = ?,
                  provider = ?,
                  model = ?,
                  base_url = ?,
                  credential_ref = ?,
                  credential_origin = ?,
                  credential_state = ?,
                  credential_status = ?,
                  context_window_tokens = ?,
                  max_output_tokens = ?,
                  enabled = ?,
                  capabilities_json = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.name ?? current.name,
          input.provider ?? current.provider,
          input.model ?? current.model,
          input.baseUrl === undefined ? current.baseUrl : input.baseUrl,
          nextCredentialRef,
          nextCredentialOrigin,
          nextCredentialState,
          nextCredentialStatus,
          input.contextWindowTokens === undefined
            ? current.contextWindowTokens
            : input.contextWindowTokens,
          input.maxOutputTokens === undefined
            ? current.maxOutputTokens
            : input.maxOutputTokens,
          enabled ? 1 : 0,
          JSON.stringify(input.capabilities ?? current.capabilities),
          input.now,
          id,
        );
    } else {
      this.database
        .prepare(
          `UPDATE model_profiles
              SET name = ?,
                  provider = ?,
                  model = ?,
                  base_url = ?,
                  credential_ref = ?,
                  credential_status = ?,
                  context_window_tokens = ?,
                  max_output_tokens = ?,
                  enabled = ?,
                  capabilities_json = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.name ?? current.name,
          input.provider ?? current.provider,
          input.model ?? current.model,
          input.baseUrl === undefined ? current.baseUrl : input.baseUrl,
          nextCredentialRef,
          nextCredentialStatus,
          input.contextWindowTokens === undefined
            ? current.contextWindowTokens
            : input.contextWindowTokens,
          input.maxOutputTokens === undefined
            ? current.maxOutputTokens
            : input.maxOutputTokens,
          enabled ? 1 : 0,
          JSON.stringify(input.capabilities ?? current.capabilities),
          input.now,
          id,
        );
    }
    if (input.isDefault === true) {
      this.setDefaultInTransaction(id, input.now);
    }
    if (
      (input.isDefault === false || input.enabled === false) &&
      current.isDefault
    ) {
      this.database
        .prepare("UPDATE model_profiles SET is_default = 0 WHERE id = ?")
        .run(id);
      this.database
        .prepare(
          "UPDATE workspace_settings SET default_model_profile_id = NULL, updated_at = ? WHERE id = 'workspace'",
        )
        .run(input.now);
    }
    return toPublic(this.requireStoredInternal(id));
  }

  private deleteInternal(
    id: string,
    now: string,
    requireNoActiveJobs?: string,
  ) {
    this.requireStoredInternal(id);
    if (requireNoActiveJobs) {
      this.ensureNoActiveJobs(id, requireNoActiveJobs);
    }
    this.database
      .prepare(
        "UPDATE workspace_settings SET default_model_profile_id = NULL, updated_at = ? WHERE default_model_profile_id = ?",
      )
      .run(now, id);
    this.database
      .prepare(
        "UPDATE projects SET default_model_profile_id = NULL, updated_at = ? WHERE default_model_profile_id = ?",
      )
      .run(now, id);
    this.database.prepare("DELETE FROM model_profiles WHERE id = ?").run(id);
  }

  private setCredentialBindingInternalTx(
    id: string,
    input: {
      reference: string | null;
      state: CredentialState;
      origin: string | null;
      migrationIssueCode?: string | null;
      executionRevision?: number;
      now: string;
    },
  ) {
    const current = this.requireStoredInternal(id);
    this.validateCredentialBinding(id, input.reference, input.state);
    const schema = this.schema();
    const publicStatus = publicStatusFromCredentialState(input.state);
    const nextExecutionRevision =
      input.executionRevision ?? current.executionRevision + 1;
    if (
      schema.hasCredentialOrigin &&
      schema.hasCredentialState &&
      schema.hasMigrationIssueCode &&
      schema.hasExecutionRevision
    ) {
      this.database
        .prepare(
          `UPDATE model_profiles
              SET credential_ref = ?,
                  credential_origin = ?,
                  credential_state = ?,
                  credential_status = ?,
                  migration_issue_code = ?,
                  execution_revision = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.reference,
          input.origin,
          input.state,
          publicStatus,
          input.migrationIssueCode === undefined
            ? current.migrationIssueCode
            : input.migrationIssueCode,
          nextExecutionRevision,
          input.now,
          id,
        );
    } else {
      this.database
        .prepare(
          "UPDATE model_profiles SET credential_ref = ?, credential_status = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.reference, publicStatus, input.now, id);
    }
    return this.requireStoredInternal(id);
  }

  list() {
    return this.listStored().map(toPublic);
  }

  listStored() {
    const schema = this.schema();
    return this.database
      .prepare(
        "SELECT * FROM model_profiles ORDER BY is_default DESC, updated_at DESC, id DESC",
      )
      .all()
      .map((row) => mapStored(row, schema));
  }

  get(id: string) {
    const value = this.getStored(id);
    return value ? toPublic(value) : null;
  }

  getStored(id: string) {
    const row = this.database
      .prepare("SELECT * FROM model_profiles WHERE id = ?")
      .get(id);
    return row ? mapStored(row, this.schema()) : null;
  }

  require(id: string) {
    return toPublic(this.requireStoredInternal(id));
  }

  requireStored(id: string) {
    return this.requireStoredInternal(id);
  }

  create(input: {
    id: string;
    name: string;
    provider: ModelProfile["provider"];
    model: string;
    baseUrl: string | null;
    credentialOrigin: string | null;
    credentialState?: CredentialState;
    contextWindowTokens: number | null;
    maxOutputTokens: number | null;
    enabled: boolean;
    isDefault: boolean;
    capabilities: Caps;
    migrationIssueCode?: string | null;
    now: string;
  }) {
    return this.tx(() => {
      if (input.isDefault && !input.enabled) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Default model profile must be enabled.",
        );
      }
      const schema = this.schema();
      const credentialState = input.credentialState ?? "missing";
      const credentialStatus = publicStatusFromCredentialState(credentialState);
      if (
        schema.hasCredentialOrigin &&
        schema.hasCredentialState &&
        schema.hasMigrationIssueCode &&
        schema.hasExecutionRevision
      ) {
        this.database
          .prepare(
            `INSERT INTO model_profiles
              (id, name, provider, model, base_url, credential_ref, credential_origin,
               credential_state, credential_status, migration_issue_code,
               execution_revision, context_window_tokens, max_output_tokens,
               enabled, is_default, capabilities_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.name,
            input.provider,
            input.model,
            input.baseUrl,
            input.credentialOrigin,
            credentialState,
            credentialStatus,
            input.migrationIssueCode ?? null,
            input.contextWindowTokens,
            input.maxOutputTokens,
            input.enabled ? 1 : 0,
            JSON.stringify(input.capabilities),
            input.now,
            input.now,
          );
      } else if (schema.hasCredentialOrigin && schema.hasCredentialState) {
        this.database
          .prepare(
            `INSERT INTO model_profiles
              (id, name, provider, model, base_url, credential_ref, credential_origin,
               credential_state, credential_status, context_window_tokens,
               max_output_tokens, enabled, is_default, capabilities_json,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.name,
            input.provider,
            input.model,
            input.baseUrl,
            input.credentialOrigin,
            credentialState,
            credentialStatus,
            input.contextWindowTokens,
            input.maxOutputTokens,
            input.enabled ? 1 : 0,
            JSON.stringify(input.capabilities),
            input.now,
            input.now,
          );
      } else {
        this.database
          .prepare(
            `INSERT INTO model_profiles
              (id, name, provider, model, base_url, credential_ref, credential_status,
               context_window_tokens, max_output_tokens, enabled, is_default,
               capabilities_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.name,
            input.provider,
            input.model,
            input.baseUrl,
            credentialStatus,
            input.contextWindowTokens,
            input.maxOutputTokens,
            input.enabled ? 1 : 0,
            JSON.stringify(input.capabilities),
            input.now,
            input.now,
          );
      }
      if (input.isDefault) {
        this.setDefaultInTransaction(input.id, input.now);
      }
      return toPublic(this.requireStoredInternal(input.id));
    });
  }

  update(
    id: string,
    input: Partial<{
      name: string;
      provider: ModelProfile["provider"];
      model: string;
      baseUrl: string | null;
      credentialRef: string | null;
      credentialOrigin: string | null;
      credentialState: CredentialState;
      contextWindowTokens: number | null;
      maxOutputTokens: number | null;
      enabled: boolean;
      isDefault: boolean;
      capabilities: Caps;
    }> & { now: string },
  ) {
    return this.tx(() => this.updateInternal(id, input));
  }

  updateWithActiveJobBarrier(
    id: string,
    input: Parameters<ModelProfilesRepository["update"]>[1],
    message: string,
  ) {
    return this.tx(() =>
      this.updateInternal(id, input, { requireNoActiveJobs: message }),
    );
  }

  setDefault(id: string, now: string) {
    return this.tx(() => {
      this.requireEnabled(id);
      this.setDefaultInTransaction(id, now);
      return toPublic(this.requireStoredInternal(id));
    });
  }

  private setDefaultInTransaction(id: string, now: string) {
    this.database
      .prepare("UPDATE model_profiles SET is_default = 0 WHERE is_default = 1")
      .run();
    this.database
      .prepare(
        "UPDATE model_profiles SET is_default = 1, updated_at = ? WHERE id = ?",
      )
      .run(now, id);
    this.database
      .prepare(
        "UPDATE workspace_settings SET default_model_profile_id = ?, updated_at = ? WHERE id = 'workspace'",
      )
      .run(id, now);
  }

  enable(id: string, enabled: boolean, now: string) {
    return this.update(id, { enabled, now });
  }

  enableWithActiveJobBarrier(
    id: string,
    enabled: boolean,
    now: string,
    message: string,
  ) {
    return this.tx(() =>
      this.updateInternal(
        id,
        { enabled, now },
        enabled ? {} : { requireNoActiveJobs: message },
      ),
    );
  }

  delete(id: string, now: string) {
    return this.tx(() => this.deleteInternal(id, now));
  }

  deleteWithActiveJobBarrier(id: string, now: string, message: string) {
    return this.tx(() => this.deleteInternal(id, now, message));
  }

  setCredentialBindingInternal(
    id: string,
    input: {
      reference: string | null;
      state: CredentialState;
      origin: string | null;
      migrationIssueCode?: string | null;
      now: string;
    },
  ) {
    return this.tx(() => this.setCredentialBindingInternalTx(id, input));
  }

  compareAndSetCredentialBindingInternal(
    id: string,
    expected: {
      provider: ModelProfile["provider"];
      canonicalOrigin: string;
      executionRevision: number;
      credentialRef: string | null;
      credentialState: CredentialState;
    },
    input: {
      reference: string | null;
      state: CredentialState;
      origin: string | null;
      migrationIssueCode?: string | null;
      now: string;
    },
  ) {
    return this.tx(() => {
      const current = this.requireStoredInternal(id);
      if (
        current.provider !== expected.provider ||
        this.currentOrigin(current) !== expected.canonicalOrigin ||
        current.executionRevision !== expected.executionRevision ||
        current.credentialRef !== expected.credentialRef ||
        current.credentialState !== expected.credentialState
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Model profile binding changed before credential storage completed.",
        );
      }
      return this.setCredentialBindingInternalTx(id, input);
    });
  }

  /** Internal Keychain bridge only. No public service method exposes this locator. */
  setCredentialReferenceInternal(
    id: string,
    locator: string | null,
    status: ModelProfile["credentialStatus"],
    now: string,
  ) {
    if (
      locator !== null &&
      !isStoredCredentialReference(locator, id) &&
      locator !== `keychain://vera/model-profile/${id}`
    ) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Credential locator is invalid.",
      );
    }
    this.setCredentialBindingInternal(id, {
      reference: locator,
      state: credentialStateFromPublicStatus(status),
      origin: this.getStored(id)?.credentialOrigin ?? null,
      now,
    });
    this.require(id);
  }

  listActiveJobsForProfile(id: string) {
    return this.listActiveJobsForProfileInternal(id);
  }

  isCredentialReferenceBound(reference: string) {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 AS present
             FROM model_profiles
            WHERE credential_ref = ?
            LIMIT 1`,
        )
        .get(reference),
    );
  }

  queueCredentialOrphanCleanup(input: {
    reference: string;
    profileId: string | null;
    provider: ModelProfile["provider"] | null;
    canonicalOrigin: string | null;
    reason:
      | "migration_reconfiguration"
      | "binding_change"
      | "credential_clear"
      | "credential_replace"
      | "credential_cas_rollback"
      | "profile_delete";
    now: string;
  }) {
    if (!this.hasTable("model_profile_credential_orphan_cleanups")) return;
    this.database
      .prepare(
        `INSERT INTO model_profile_credential_orphan_cleanups
           (reference, profile_id, provider, canonical_origin, reason,
            attempt_count, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
         ON CONFLICT(reference) DO UPDATE SET
           profile_id = excluded.profile_id,
           provider = excluded.provider,
           canonical_origin = excluded.canonical_origin,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.reference,
        input.profileId,
        input.provider,
        input.canonicalOrigin,
        input.reason,
        input.now,
        input.now,
      );
  }

  listCredentialOrphanCleanups() {
    if (!this.hasTable("model_profile_credential_orphan_cleanups")) return [];
    return this.database
      .prepare(
        `SELECT reference, profile_id, provider, canonical_origin, reason,
                attempt_count, last_error, created_at, updated_at
           FROM model_profile_credential_orphan_cleanups
          ORDER BY updated_at ASC, reference ASC`,
      )
      .all()
      .map((row) => ({
        reference: String(row.reference),
        profileId: nullableString(row.profile_id),
        provider:
          row.provider == null
            ? null
            : (String(row.provider) as ModelProfile["provider"]),
        canonicalOrigin: nullableString(row.canonical_origin),
        reason: String(row.reason) as
          | "migration_reconfiguration"
          | "binding_change"
          | "credential_clear"
          | "credential_replace"
          | "credential_cas_rollback"
          | "profile_delete",
        attemptCount: Number(row.attempt_count ?? 0),
        lastError: nullableString(row.last_error),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }));
  }

  markCredentialOrphanCleanupFailed(
    reference: string,
    lastError: string,
    now: string,
  ) {
    if (!this.hasTable("model_profile_credential_orphan_cleanups")) return;
    this.database
      .prepare(
        `UPDATE model_profile_credential_orphan_cleanups
            SET attempt_count = attempt_count + 1,
                last_error = ?,
                updated_at = ?
          WHERE reference = ?`,
      )
      .run(lastError, now, reference);
  }

  clearCredentialOrphanCleanup(reference: string) {
    if (!this.hasTable("model_profile_credential_orphan_cleanups")) return;
    this.database
      .prepare(
        `DELETE FROM model_profile_credential_orphan_cleanups
          WHERE reference = ?`,
      )
      .run(reference);
  }

  requireEnabled(id: string) {
    const record = this.requireStoredInternal(id);
    if (!record.enabled) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile is disabled.",
      );
    }
    return toPublic(record);
  }
}
