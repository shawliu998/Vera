import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LocalDatabase } from "./localDatabase";
import {
  LocalEnvelopeSecretCipher,
  type SecretCipher,
} from "./localSecretCipher";
import { assertBundledDatabaseEncryptionPolicy } from "./localEnvelopeCrypto";
import type { LocalModelCalibrationAttempt } from "./localModelCalibration";
import {
  modelBenchmarkCaseResultHash,
  modelBenchmarkEventHash,
  modelBenchmarkResultHash,
  stableJson,
  type LocalModelBenchmarkAttempt,
  type LocalModelBenchmarkCaseResult,
} from "./localModelBenchmark";

export const CLIENT_SETTINGS_SCHEMA_VERSION = "aletheia-client-settings-v1";
export const RUNTIME_CONFIG_SCHEMA_VERSION = "aletheia-runtime-config-v1";
export const PROVIDERS = [
  "openai",
  "claude",
  "gemini",
  "openrouter",
  "courtlistener",
  "pkulaw",
  "wolters",
] as const;

export type ProviderId = (typeof PROVIDERS)[number];
export const LEGAL_SOURCE_PROVIDERS = ["pkulaw", "wolters"] as const;
export type LegalSourceProviderId = (typeof LEGAL_SOURCE_PROVIDERS)[number];
export type LocalClientSettings = {
  theme: "System" | "Light" | "Dark";
  density: "Comfortable" | "Compact";
  sidebar: "Standard" | "Narrow";
  documentFontSize: "Small" | "Medium" | "Large";
  defaultModel: string | null;
  litigationModelId: string | null;
  routineModelId: string | null;
  reasoning: "Off" | "Low" | "Medium" | "High";
  fastMode: boolean;
  notifications: boolean;
  defaultLanding: "Matters" | "Agent Console" | "Last opened matter";
  showCitationsInline: boolean;
  defaultTemplate:
    | "Legal Matter Review"
    | "Compliance Impact Review"
    | "Deal Due Diligence";
  demoDataEnabled: boolean;
  contextBudgetTokens: number | null;
  evidenceIndex: "Keyword" | "Hybrid" | "Semantic";
  contextCompression: "Off" | "Manual" | "Auto";
  compressionModelId: string | null;
};
export type RuntimeModel = {
  id: string;
  state: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
};
export type RuntimeCapabilityStatus =
  | "available"
  | "unavailable"
  | "unsupported";
export type RuntimeCapability = {
  status: RuntimeCapabilityStatus;
  consumer: string | null;
  note?: string;
  availableModes?: readonly string[];
  mode?: string;
  model?: string | null;
  thresholdTokens?: number | null;
};
export type LocalMcpAuthConfig = {
  bearerToken?: string;
  headers?: Record<string, string>;
  oauth?: {
    accessToken: string;
    refreshToken?: string;
    clientSecret?: string;
  };
};

const DEFAULT_SETTINGS: LocalClientSettings = {
  theme: "System",
  density: "Comfortable",
  sidebar: "Standard",
  documentFontSize: "Medium",
  defaultModel: null,
  litigationModelId: null,
  routineModelId: null,
  reasoning: "Off",
  fastMode: false,
  notifications: true,
  defaultLanding: "Matters",
  showCitationsInline: true,
  defaultTemplate: "Legal Matter Review",
  demoDataEnabled: false,
  contextBudgetTokens: null,
  evidenceIndex: "Keyword",
  contextCompression: "Off",
  compressionModelId: null,
};

type SettingsRow = {
  user_id: string;
  schema_version: string;
  version: number;
  settings_json: string;
  created_at: string;
  updated_at: string;
};

type ProviderSecretRow = {
  provider: ProviderId;
  encrypted_secret: string;
  secret_hint: string;
  last_test_status: string | null;
  last_test_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type McpConnectorRow = {
  id: string;
  user_id: string;
  name: string;
  server_url: string;
  auth_type: "none" | "bearer" | "headers" | "oauth" | "mixed";
  encrypted_auth_config: string | null;
  auth_metadata_json: string;
  enabled: number;
  status: "disabled" | "idle" | "ready" | "error";
  last_error: string | null;
  last_refreshed_at: string | null;
  tools_json: string;
  created_at: string;
  updated_at: string;
};

export class LocalControlError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_INPUT"
      | "PRECONDITION_REQUIRED"
      | "VERSION_CONFLICT"
      | "NOT_FOUND"
      | "UNSUPPORTED_SETTING"
      | "SECRET_STORAGE_UNAVAILABLE"
      | "CONNECTION_FAILED",
    readonly status: number,
  ) {
    super(message);
    this.name = "LocalControlError";
  }
}

function now() {
  return new Date().toISOString();
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function settingsFromRow(row: SettingsRow): LocalClientSettings {
  const raw = parseObject(row.settings_json);
  return {
    ...DEFAULT_SETTINGS,
    ...(raw as Partial<LocalClientSettings>),
    defaultModel:
      typeof raw.defaultModel === "string" ? raw.defaultModel : null,
    litigationModelId:
      typeof raw.litigationModelId === "string" ? raw.litigationModelId : null,
    routineModelId:
      typeof raw.routineModelId === "string" ? raw.routineModelId : null,
    reasoning:
      raw.reasoning === "Low" ||
      raw.reasoning === "Medium" ||
      raw.reasoning === "High"
        ? raw.reasoning
        : "Off",
    fastMode: typeof raw.fastMode === "boolean" ? raw.fastMode : false,
    notifications:
      typeof raw.notifications === "boolean" ? raw.notifications : true,
    contextBudgetTokens:
      typeof raw.contextBudgetTokens === "number"
        ? raw.contextBudgetTokens
        : null,
    evidenceIndex:
      raw.evidenceIndex === "Hybrid" || raw.evidenceIndex === "Semantic"
        ? raw.evidenceIndex
        : "Keyword",
    contextCompression:
      raw.contextCompression === "Manual" || raw.contextCompression === "Auto"
        ? raw.contextCompression
        : "Off",
    compressionModelId:
      typeof raw.compressionModelId === "string"
        ? raw.compressionModelId
        : null,
  };
}

function dataDir() {
  return path.resolve(
    process.env.ALETHEIA_DATA_DIR ??
      process.env.ALET_HEIA_DATA_DIR ??
      path.resolve(process.cwd(), ".data", "aletheia"),
  );
}

function semanticIndexAvailable() {
  return (
    process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED === "true" &&
    (process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER?.trim().toLowerCase() ?? "") ===
      "local-json"
  );
}

function ensureDatabasePath(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path.dirname(filePath), 0o700);
}

function providerContext(userId: string, provider: ProviderId) {
  return `provider-secret:${userId}:${provider}`;
}

function connectorContext(userId: string, connectorId: string) {
  return `mcp-connector-auth:${userId}:${connectorId}`;
}

function authMetadata(config: LocalMcpAuthConfig | null | undefined) {
  const headerNames = Object.keys(config?.headers ?? {}).sort();
  return {
    hasBearerToken: Boolean(config?.bearerToken),
    bearerMasked: config?.bearerToken ? "••••" : null,
    headerNames,
    oauthConnected: Boolean(config?.oauth?.accessToken),
    oauthMasked: config?.oauth?.accessToken ? "••••" : null,
    hasRefreshToken: Boolean(config?.oauth?.refreshToken),
    hasClientSecret: Boolean(config?.oauth?.clientSecret),
  };
}

function authType(config: LocalMcpAuthConfig | null | undefined) {
  const kinds = [
    config?.bearerToken ? "bearer" : null,
    Object.keys(config?.headers ?? {}).length ? "headers" : null,
    config?.oauth?.accessToken ? "oauth" : null,
  ].filter(Boolean) as Array<"bearer" | "headers" | "oauth">;
  return kinds.length > 1 ? "mixed" : (kinds[0] ?? "none");
}

export class LocalControlRepository {
  readonly databasePath: string;
  private readonly db: LocalDatabase;

  constructor(args: { databasePath?: string; cipher?: SecretCipher } = {}) {
    assertBundledDatabaseEncryptionPolicy();
    this.databasePath =
      args.databasePath ?? path.join(dataDir(), "aletheia.db");
    ensureDatabasePath(this.databasePath);
    this.db = new LocalDatabase(this.databasePath);
    this.cipher = args.cipher ?? new LocalEnvelopeSecretCipher();
    this.db.exec("pragma journal_mode = WAL; pragma foreign_keys = ON;");
    this.db.exec(`
      create table if not exists aletheia_client_settings (
        user_id text primary key,
        schema_version text not null,
        version integer not null,
        settings_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists aletheia_provider_secrets (
        user_id text not null,
        provider text not null,
        encrypted_secret text not null,
        secret_hint text not null,
        last_test_status text,
        last_test_at text,
        last_error text,
        created_at text not null,
        updated_at text not null,
        primary key (user_id, provider)
      );
      create table if not exists aletheia_local_mcp_connectors (
        id text primary key,
        user_id text not null,
        name text not null,
        server_url text not null,
        auth_type text not null,
        encrypted_auth_config text,
        auth_metadata_json text not null,
        enabled integer not null,
        status text not null,
        last_error text,
        last_refreshed_at text,
        tools_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists aletheia_local_mcp_connectors_user
        on aletheia_local_mcp_connectors(user_id, updated_at desc);
      create table if not exists aletheia_local_model_calibrations (
        id text primary key,
        user_id text not null,
        model_id text not null,
        model_fingerprint text not null,
        adapter text not null,
        provider_model text not null,
        status text not null check(status in ('passed', 'failed')),
        protocol_version text not null,
        tested_at text not null,
        expires_at text not null,
        duration_ms integer not null,
        output_sha256 text,
        failure_code text,
        failure_detail text
      );
      create index if not exists aletheia_local_model_calibrations_latest
        on aletheia_local_model_calibrations(user_id, model_id, tested_at desc);
      create table if not exists aletheia_local_model_benchmark_runs (
        id text primary key,
        user_id text not null,
        model_id text not null,
        model_fingerprint text not null,
        model_revision text not null,
        adapter text not null,
        provider_model text not null,
        reasoning text not null,
        fast_mode integer not null,
        protocol_version text not null,
        case_set_hash text not null,
        grader_version text not null,
        status text not null check(status in ('passed', 'failed')),
        score real not null,
        tested_at text not null,
        expires_at text not null,
        duration_ms integer not null,
        response_hashes_sha256 text not null,
        failure_code text,
        failure_detail text,
        result_hash text not null,
        completed_event_hash text not null
      );
      create index if not exists aletheia_local_model_benchmark_runs_latest
        on aletheia_local_model_benchmark_runs(user_id, model_id, tested_at desc);
      create table if not exists aletheia_local_model_benchmark_cases (
        run_id text not null references aletheia_local_model_benchmark_runs(id),
        user_id text not null,
        case_id text not null,
        status text not null check(status in ('passed', 'failed')),
        score real not null,
        duration_ms integer not null,
        response_sha256 text,
        response_text text,
        failure_code text,
        failure_detail text,
        result_hash text not null,
        primary key (run_id, case_id)
      );
      create table if not exists aletheia_local_model_benchmark_events (
        sequence integer primary key autoincrement,
        id text not null unique,
        user_id text not null,
        run_id text not null,
        event_type text not null check(event_type in ('started', 'completed')),
        occurred_at text not null,
        prior_hash text,
        payload_sha256 text not null,
        event_hash text not null unique
      );
      create index if not exists aletheia_local_model_benchmark_events_user
        on aletheia_local_model_benchmark_events(user_id, sequence asc);
      create trigger if not exists aletheia_local_model_benchmark_runs_immutable_update
        before update on aletheia_local_model_benchmark_runs begin
          select raise(abort, 'benchmark runs are immutable');
        end;
      create trigger if not exists aletheia_local_model_benchmark_runs_immutable_delete
        before delete on aletheia_local_model_benchmark_runs begin
          select raise(abort, 'benchmark runs are immutable');
        end;
      create trigger if not exists aletheia_local_model_benchmark_cases_immutable_update
        before update on aletheia_local_model_benchmark_cases begin
          select raise(abort, 'benchmark cases are immutable');
        end;
      create trigger if not exists aletheia_local_model_benchmark_cases_immutable_delete
        before delete on aletheia_local_model_benchmark_cases begin
          select raise(abort, 'benchmark cases are immutable');
        end;
      create trigger if not exists aletheia_local_model_benchmark_events_immutable_update
        before update on aletheia_local_model_benchmark_events begin
          select raise(abort, 'benchmark events are immutable');
        end;
      create trigger if not exists aletheia_local_model_benchmark_events_immutable_delete
        before delete on aletheia_local_model_benchmark_events begin
          select raise(abort, 'benchmark events are immutable');
        end;
    `);
    if (process.platform !== "win32") chmodSync(this.databasePath, 0o600);
  }

  private readonly cipher: SecretCipher;

  close() {
    this.db.close();
  }

  recordModelCalibration(input: LocalModelCalibrationAttempt) {
    this.db
      .prepare(
        `insert into aletheia_local_model_calibrations
          (id, user_id, model_id, model_fingerprint, adapter, provider_model,
           status, protocol_version, tested_at, expires_at, duration_ms,
           output_sha256, failure_code, failure_detail)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.modelId,
        input.modelFingerprint,
        input.adapter,
        input.providerModel,
        input.status,
        input.protocolVersion,
        input.testedAt,
        input.expiresAt,
        input.durationMs,
        input.outputSha256,
        input.failureCode,
        input.failureDetail,
      );
    return this.latestModelCalibration(input.userId, input.modelId);
  }

  latestModelCalibration(userId: string, modelId: string) {
    const row = this.db
      .prepare(
        `select id, user_id, model_id, model_fingerprint, adapter,
                provider_model, status, protocol_version, tested_at,
                expires_at, duration_ms, output_sha256, failure_code,
                failure_detail
           from aletheia_local_model_calibrations
          where user_id = ? and model_id = ?
          order by tested_at desc, rowid desc limit 1`,
      )
      .get(userId, modelId) as
      | {
          id: string;
          user_id: string;
          model_id: string;
          model_fingerprint: string;
          adapter: string;
          provider_model: string;
          status: "passed" | "failed";
          protocol_version: string;
          tested_at: string;
          expires_at: string;
          duration_ms: number;
          output_sha256: string | null;
          failure_code: string | null;
          failure_detail: string | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          modelId: row.model_id,
          modelFingerprint: row.model_fingerprint,
          adapter: row.adapter,
          providerModel: row.provider_model,
          status: row.status,
          protocolVersion: row.protocol_version,
          testedAt: row.tested_at,
          expiresAt: row.expires_at,
          durationMs: row.duration_ms,
          outputSha256: row.output_sha256,
          failureCode: row.failure_code,
          failureDetail: row.failure_detail,
        }
      : null;
  }

  private benchmarkCaseRows(userId: string, runId: string) {
    const rows = this.db
      .prepare(
        `select case_id, status, score, duration_ms, response_sha256,
                response_text, failure_code, failure_detail, result_hash
           from aletheia_local_model_benchmark_cases
          where user_id = ? and run_id = ? order by case_id asc`,
      )
      .all(userId, runId) as Array<Record<string, unknown>>;
    return rows.map(
      (row): LocalModelBenchmarkCaseResult => ({
        caseId: String(row.case_id),
        status: row.status === "passed" ? "passed" : "failed",
        score: Number(row.score),
        durationMs: Number(row.duration_ms),
        responseSha256:
          typeof row.response_sha256 === "string" ? row.response_sha256 : null,
        responseText:
          typeof row.response_text === "string" ? row.response_text : null,
        failureCode:
          typeof row.failure_code === "string" ? row.failure_code : null,
        failureDetail:
          typeof row.failure_detail === "string" ? row.failure_detail : null,
        resultHash: String(row.result_hash),
      }),
    );
  }

  private benchmarkFromRow(row: Record<string, unknown>) {
    const cases = this.benchmarkCaseRows(String(row.user_id), String(row.id));
    return {
      id: String(row.id),
      userId: String(row.user_id),
      modelId: String(row.model_id),
      modelFingerprint: String(row.model_fingerprint),
      modelRevision: String(row.model_revision),
      adapter: String(row.adapter),
      providerModel: String(row.provider_model),
      reasoning: String(
        row.reasoning,
      ) as LocalModelBenchmarkAttempt["reasoning"],
      fastMode: Boolean(row.fast_mode),
      protocolVersion: String(row.protocol_version),
      caseSetHash: String(row.case_set_hash),
      graderVersion: String(row.grader_version),
      status: row.status === "passed" ? "passed" : "failed",
      score: Number(row.score),
      testedAt: String(row.tested_at),
      expiresAt: String(row.expires_at),
      durationMs: Number(row.duration_ms),
      responseHashesSha256: String(row.response_hashes_sha256),
      failureCode:
        typeof row.failure_code === "string" ? row.failure_code : null,
      failureDetail:
        typeof row.failure_detail === "string" ? row.failure_detail : null,
      resultHash: String(row.result_hash),
      cases,
    } satisfies LocalModelBenchmarkAttempt;
  }

  recordModelBenchmark(input: LocalModelBenchmarkAttempt) {
    const hash = (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;
    this.db.exec("begin immediate");
    try {
      const latestEvent = this.db
        .prepare(
          `select event_hash from aletheia_local_model_benchmark_events
            where user_id = ? order by sequence desc limit 1`,
        )
        .get(input.userId) as { event_hash: string } | undefined;
      const startedAt = input.testedAt;
      const startedPayload = hash(
        stableJson({ runId: input.id, status: "started" }),
      );
      const startedHash = modelBenchmarkEventHash({
        userId: input.userId,
        runId: input.id,
        eventType: "started",
        occurredAt: startedAt,
        priorHash: latestEvent?.event_hash ?? null,
        payloadSha256: startedPayload,
      });
      const completedPayload = hash(
        stableJson({
          runId: input.id,
          status: input.status,
          resultHash: input.resultHash,
        }),
      );
      const completedHash = modelBenchmarkEventHash({
        userId: input.userId,
        runId: input.id,
        eventType: "completed",
        occurredAt: input.testedAt,
        priorHash: startedHash,
        payloadSha256: completedPayload,
      });
      this.db
        .prepare(
          `insert into aletheia_local_model_benchmark_events
            (id, user_id, run_id, event_type, occurred_at, prior_hash, payload_sha256, event_hash)
           values (?, ?, ?, 'started', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.userId,
          input.id,
          startedAt,
          latestEvent?.event_hash ?? null,
          startedPayload,
          startedHash,
        );
      this.db
        .prepare(
          `insert into aletheia_local_model_benchmark_runs
            (id, user_id, model_id, model_fingerprint, model_revision, adapter,
             provider_model, reasoning, fast_mode, protocol_version, case_set_hash,
             grader_version, status, score, tested_at, expires_at, duration_ms,
             response_hashes_sha256, failure_code, failure_detail, result_hash, completed_event_hash)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.userId,
          input.modelId,
          input.modelFingerprint,
          input.modelRevision,
          input.adapter,
          input.providerModel,
          input.reasoning,
          input.fastMode ? 1 : 0,
          input.protocolVersion,
          input.caseSetHash,
          input.graderVersion,
          input.status,
          input.score,
          input.testedAt,
          input.expiresAt,
          input.durationMs,
          input.responseHashesSha256,
          input.failureCode,
          input.failureDetail,
          input.resultHash,
          completedHash,
        );
      const insertCase = this.db.prepare(
        `insert into aletheia_local_model_benchmark_cases
          (run_id, user_id, case_id, status, score, duration_ms, response_sha256,
           response_text, failure_code, failure_detail, result_hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of input.cases) {
        insertCase.run(
          input.id,
          input.userId,
          item.caseId,
          item.status,
          item.score,
          item.durationMs,
          item.responseSha256,
          item.responseText,
          item.failureCode,
          item.failureDetail,
          item.resultHash,
        );
      }
      this.db
        .prepare(
          `insert into aletheia_local_model_benchmark_events
            (id, user_id, run_id, event_type, occurred_at, prior_hash, payload_sha256, event_hash)
           values (?, ?, ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.userId,
          input.id,
          input.testedAt,
          startedHash,
          completedPayload,
          completedHash,
        );
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return this.latestModelBenchmark(input.userId, input.modelId);
  }

  latestModelBenchmark(userId: string, modelId: string) {
    const row = this.db
      .prepare(
        `select * from aletheia_local_model_benchmark_runs
          where user_id = ? and model_id = ?
          order by tested_at desc, rowid desc limit 1`,
      )
      .get(userId, modelId) as Record<string, unknown> | undefined;
    return row ? this.benchmarkFromRow(row) : null;
  }

  verifyModelBenchmarkIntegrity(userId: string, modelId: string) {
    const benchmark = this.latestModelBenchmark(userId, modelId);
    if (!benchmark || benchmark.cases.length === 0) return false;
    for (const item of benchmark.cases) {
      const responseHash =
        item.responseText === null
          ? null
          : `sha256:${createHash("sha256").update(item.responseText).digest("hex")}`;
      if (responseHash !== item.responseSha256) return false;
      const { resultHash, ...caseWithoutHash } = item;
      if (modelBenchmarkCaseResultHash(caseWithoutHash) !== resultHash)
        return false;
    }
    const expectedResponseHashes = `sha256:${createHash("sha256")
      .update(
        stableJson(
          benchmark.cases.map((item) => [item.caseId, item.responseSha256]),
        ),
      )
      .digest("hex")}`;
    if (expectedResponseHashes !== benchmark.responseHashesSha256) return false;
    const { resultHash, cases, ...runWithoutHash } = benchmark;
    if (
      modelBenchmarkResultHash({
        ...runWithoutHash,
        cases: cases.map((item) => ({
          caseId: item.caseId,
          resultHash: item.resultHash,
        })),
      }) !== resultHash
    )
      return false;
    const events = this.db
      .prepare(
        `select run_id, event_type, occurred_at, prior_hash, payload_sha256, event_hash
           from aletheia_local_model_benchmark_events where user_id = ? order by sequence asc`,
      )
      .all(userId) as Array<Record<string, unknown>>;
    let priorHash: string | null = null;
    for (const event of events) {
      const eventHash = modelBenchmarkEventHash({
        userId,
        runId: String(event.run_id),
        eventType: String(event.event_type),
        occurredAt: String(event.occurred_at),
        priorHash:
          typeof event.prior_hash === "string" ? event.prior_hash : null,
        payloadSha256: String(event.payload_sha256),
      });
      if (event.prior_hash !== priorHash || eventHash !== event.event_hash)
        return false;
      priorHash = eventHash;
    }
    const completion = events.find(
      (event) =>
        String(event.run_id) === benchmark.id &&
        String(event.event_type) === "completed",
    );
    const started = events.find(
      (event) =>
        String(event.run_id) === benchmark.id &&
        String(event.event_type) === "started",
    );
    const hash = (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const storedRun = this.db
      .prepare(
        `select completed_event_hash from aletheia_local_model_benchmark_runs
          where user_id = ? and id = ?`,
      )
      .get(userId, benchmark.id) as
      | { completed_event_hash: string }
      | undefined;
    return Boolean(
      started &&
      completion &&
      started.payload_sha256 ===
        hash(stableJson({ runId: benchmark.id, status: "started" })) &&
      completion.payload_sha256 ===
        hash(
          stableJson({
            runId: benchmark.id,
            status: benchmark.status,
            resultHash: benchmark.resultHash,
          }),
        ) &&
      storedRun?.completed_event_hash === completion.event_hash,
    );
  }

  private ensureSettings(userId: string) {
    const timestamp = now();
    this.db
      .prepare(
        `insert or ignore into aletheia_client_settings
          (user_id, schema_version, version, settings_json, created_at, updated_at)
         values (?, ?, 1, ?, ?, ?)`,
      )
      .run(
        userId,
        CLIENT_SETTINGS_SCHEMA_VERSION,
        JSON.stringify(DEFAULT_SETTINGS),
        timestamp,
        timestamp,
      );
  }

  getSettings(userId: string) {
    this.ensureSettings(userId);
    const row = this.db
      .prepare("select * from aletheia_client_settings where user_id = ?")
      .get(userId) as SettingsRow;
    return {
      schemaVersion: CLIENT_SETTINGS_SCHEMA_VERSION,
      version: row.version,
      etag: `\"aletheia-settings-${row.version}\"`,
      settings: settingsFromRow(row),
      updatedAt: row.updated_at,
    };
  }

  updateSettings(
    userId: string,
    expectedVersion: number | null,
    next: LocalClientSettings,
  ) {
    if (expectedVersion === null) {
      throw new LocalControlError(
        "If-Match is required for settings updates.",
        "PRECONDITION_REQUIRED",
        428,
      );
    }
    this.ensureSettings(userId);
    const timestamp = now();
    const result = this.db
      .prepare(
        `update aletheia_client_settings
            set version = version + 1, settings_json = ?, updated_at = ?
          where user_id = ? and version = ?`,
      )
      .run(JSON.stringify(next), timestamp, userId, expectedVersion) as {
      changes: number;
    };
    if (result.changes !== 1) {
      throw new LocalControlError(
        "Client settings changed since they were read.",
        "VERSION_CONFLICT",
        412,
      );
    }
    return this.getSettings(userId);
  }

  resetSettings(userId: string, expectedVersion: number | null) {
    return this.updateSettings(userId, expectedVersion, DEFAULT_SETTINGS);
  }

  listProviderStatuses(userId: string) {
    const rows = this.db
      .prepare(
        `select provider, encrypted_secret, secret_hint, last_test_status,
                last_test_at, last_error, created_at, updated_at
           from aletheia_provider_secrets where user_id = ?`,
      )
      .all(userId) as ProviderSecretRow[];
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    return PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      return {
        provider,
        configured: Boolean(row),
        source: row ? "encrypted_local" : null,
        masked: row ? "••••" : null,
        readable: false,
        runtimeEnabled: false,
        lastTestStatus: row?.last_test_status ?? null,
        lastTestAt: row?.last_test_at ?? null,
        lastError: row?.last_error ? "Provider credential test failed." : null,
        updatedAt: row?.updated_at ?? null,
      };
    });
  }

  canEncryptProviderSecrets() {
    try {
      // The cipher creates an authenticated envelope only; this probe does not
      // write a secret record or reveal any key material.
      this.cipher.encrypt("", `provider-secret-readiness:${randomUUID()}`);
      return true;
    } catch {
      return false;
    }
  }

  saveProviderSecret(userId: string, provider: ProviderId, secret: string) {
    const trimmed = secret.trim();
    if (trimmed.length < 8 || trimmed.length > 32_768) {
      throw new LocalControlError(
        "Provider secret must be between 8 and 32768 characters.",
        "INVALID_INPUT",
        400,
      );
    }
    let encrypted: string;
    try {
      encrypted = this.cipher.encrypt(
        trimmed,
        providerContext(userId, provider),
      );
    } catch (error) {
      throw new LocalControlError(
        `Encrypted provider-secret storage is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "SECRET_STORAGE_UNAVAILABLE",
        503,
      );
    }
    const timestamp = now();
    this.db
      .prepare(
        `insert into aletheia_provider_secrets
          (user_id, provider, encrypted_secret, secret_hint, last_test_status,
           last_test_at, last_error, created_at, updated_at)
         values (?, ?, ?, ?, null, null, null, ?, ?)
         on conflict(user_id, provider) do update set
           encrypted_secret = excluded.encrypted_secret,
           secret_hint = excluded.secret_hint,
           last_test_status = null,
           last_test_at = null,
           last_error = null,
           updated_at = excluded.updated_at`,
      )
      .run(userId, provider, encrypted, "configured", timestamp, timestamp);
    return this.listProviderStatuses(userId).find(
      (item) => item.provider === provider,
    );
  }

  removeProviderSecret(userId: string, provider: ProviderId) {
    const result = this.db
      .prepare(
        "delete from aletheia_provider_secrets where user_id = ? and provider = ?",
      )
      .run(userId, provider) as { changes: number };
    return result.changes === 1;
  }

  providerSecretForUse(userId: string, provider: ProviderId) {
    const row = this.db
      .prepare(
        "select encrypted_secret from aletheia_provider_secrets where user_id = ? and provider = ?",
      )
      .get(userId, provider) as { encrypted_secret: string } | undefined;
    if (!row) {
      throw new LocalControlError(
        "Provider secret is not configured.",
        "NOT_FOUND",
        404,
      );
    }
    try {
      return this.cipher.decrypt(
        row.encrypted_secret,
        providerContext(userId, provider),
      );
    } catch (error) {
      throw new LocalControlError(
        `Encrypted provider secret cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
        "SECRET_STORAGE_UNAVAILABLE",
        503,
      );
    }
  }

  recordProviderTest(
    userId: string,
    provider: ProviderId,
    result: { status: "passed" | "failed" | "unsupported"; error?: string },
  ) {
    const timestamp = now();
    this.db
      .prepare(
        `update aletheia_provider_secrets
            set last_test_status = ?, last_test_at = ?, last_error = ?, updated_at = ?
          where user_id = ? and provider = ?`,
      )
      .run(
        result.status,
        timestamp,
        result.error?.slice(0, 1000) ?? null,
        timestamp,
        userId,
        provider,
      );
  }

  private connectorSummary(row: McpConnectorRow) {
    const metadata = parseObject(row.auth_metadata_json);
    let tools: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(row.tools_json);
      tools = Array.isArray(parsed) ? parsed : [];
    } catch {
      tools = [];
    }
    return {
      id: row.id,
      name: row.name,
      transport: "streamable_http" as const,
      serverUrl: row.server_url,
      authType: row.auth_type,
      enabled: Boolean(row.enabled),
      auth: metadata,
      status: row.status,
      lastError: row.last_error,
      lastRefreshedAt: row.last_refreshed_at,
      tools,
      toolCount: tools.length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listMcpConnectors(userId: string) {
    return (
      this.db
        .prepare(
          "select * from aletheia_local_mcp_connectors where user_id = ? order by updated_at desc",
        )
        .all(userId) as McpConnectorRow[]
    ).map((row) => this.connectorSummary(row));
  }

  getMcpConnector(userId: string, connectorId: string) {
    const row = this.db
      .prepare(
        "select * from aletheia_local_mcp_connectors where user_id = ? and id = ?",
      )
      .get(userId, connectorId) as McpConnectorRow | undefined;
    return row ? this.connectorSummary(row) : null;
  }

  createMcpConnector(
    userId: string,
    input: {
      name: string;
      serverUrl: string;
      enabled: boolean;
      authConfig?: LocalMcpAuthConfig | null;
    },
  ) {
    const id = randomUUID();
    const timestamp = now();
    const encrypted = input.authConfig
      ? this.encryptMcpAuth(userId, id, input.authConfig)
      : null;
    this.db
      .prepare(
        `insert into aletheia_local_mcp_connectors
          (id, user_id, name, server_url, auth_type, encrypted_auth_config,
           auth_metadata_json, enabled, status, last_error, last_refreshed_at,
           tools_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, '[]', ?, ?)`,
      )
      .run(
        id,
        userId,
        input.name,
        input.serverUrl,
        authType(input.authConfig),
        encrypted,
        JSON.stringify(authMetadata(input.authConfig)),
        input.enabled ? 1 : 0,
        input.enabled ? "idle" : "disabled",
        timestamp,
        timestamp,
      );
    return this.getMcpConnector(userId, id)!;
  }

  updateMcpConnector(
    userId: string,
    connectorId: string,
    patch: {
      name?: string;
      serverUrl?: string;
      enabled?: boolean;
      authConfig?: LocalMcpAuthConfig | null;
    },
  ) {
    const current = this.db
      .prepare(
        "select * from aletheia_local_mcp_connectors where user_id = ? and id = ?",
      )
      .get(userId, connectorId) as McpConnectorRow | undefined;
    if (!current) {
      throw new LocalControlError("MCP connector not found.", "NOT_FOUND", 404);
    }
    const encrypted =
      patch.authConfig === undefined
        ? current.encrypted_auth_config
        : patch.authConfig
          ? this.encryptMcpAuth(userId, connectorId, patch.authConfig)
          : null;
    const metadata =
      patch.authConfig === undefined
        ? current.auth_metadata_json
        : JSON.stringify(authMetadata(patch.authConfig));
    const nextEnabled = patch.enabled ?? Boolean(current.enabled);
    const timestamp = now();
    this.db
      .prepare(
        `update aletheia_local_mcp_connectors set
          name = ?, server_url = ?, auth_type = ?, encrypted_auth_config = ?,
          auth_metadata_json = ?, enabled = ?, status = ?, last_error = null,
          updated_at = ? where user_id = ? and id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.serverUrl ?? current.server_url,
        patch.authConfig === undefined
          ? current.auth_type
          : authType(patch.authConfig),
        encrypted,
        metadata,
        nextEnabled ? 1 : 0,
        nextEnabled ? "idle" : "disabled",
        timestamp,
        userId,
        connectorId,
      );
    return this.getMcpConnector(userId, connectorId)!;
  }

  deleteMcpConnector(userId: string, connectorId: string) {
    const result = this.db
      .prepare(
        "delete from aletheia_local_mcp_connectors where user_id = ? and id = ?",
      )
      .run(userId, connectorId) as { changes: number };
    return result.changes === 1;
  }

  mcpConnectorForConnection(userId: string, connectorId: string) {
    const row = this.db
      .prepare(
        "select * from aletheia_local_mcp_connectors where user_id = ? and id = ?",
      )
      .get(userId, connectorId) as McpConnectorRow | undefined;
    if (!row) {
      throw new LocalControlError("MCP connector not found.", "NOT_FOUND", 404);
    }
    let authConfig: LocalMcpAuthConfig = {};
    if (row.encrypted_auth_config) {
      try {
        const plaintext = this.cipher.decrypt(
          row.encrypted_auth_config,
          connectorContext(userId, connectorId),
        );
        const parsed: unknown = JSON.parse(plaintext);
        authConfig =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as LocalMcpAuthConfig)
            : {};
      } catch (error) {
        throw new LocalControlError(
          `Encrypted MCP credentials cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
          "SECRET_STORAGE_UNAVAILABLE",
          503,
        );
      }
    }
    return {
      id: row.id,
      name: row.name,
      serverUrl: row.server_url,
      enabled: Boolean(row.enabled),
      authConfig,
    };
  }

  recordMcpRefresh(
    userId: string,
    connectorId: string,
    result: { ok: true; tools: unknown[] } | { ok: false; error: string },
  ) {
    const timestamp = now();
    this.db
      .prepare(
        `update aletheia_local_mcp_connectors set status = ?, last_error = ?,
          last_refreshed_at = ?, tools_json = ?, updated_at = ?
          where user_id = ? and id = ?`,
      )
      .run(
        result.ok ? "ready" : "error",
        result.ok ? null : result.error.slice(0, 1000),
        timestamp,
        result.ok ? JSON.stringify(result.tools) : "[]",
        timestamp,
        userId,
        connectorId,
      );
    return this.getMcpConnector(userId, connectorId);
  }

  private encryptMcpAuth(
    userId: string,
    connectorId: string,
    authConfig: LocalMcpAuthConfig,
  ) {
    try {
      return this.cipher.encrypt(
        JSON.stringify(authConfig),
        connectorContext(userId, connectorId),
      );
    } catch (error) {
      throw new LocalControlError(
        `Encrypted MCP credential storage is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "SECRET_STORAGE_UNAVAILABLE",
        503,
      );
    }
  }
}

export type ClientSettingsRepository = Pick<
  LocalControlRepository,
  "getSettings" | "updateSettings" | "resetSettings"
>;

export type ProviderSecretRepository = Pick<
  LocalControlRepository,
  | "listProviderStatuses"
  | "saveProviderSecret"
  | "removeProviderSecret"
  | "providerSecretForUse"
  | "recordProviderTest"
>;

export type LegalSourceCredentialRepository = Pick<
  LocalControlRepository,
  "providerSecretForUse"
>;

/** Read-only credential access for the server-side legal Research Broker. */
export function readLocalLegalSourceCredential(
  repository: LegalSourceCredentialRepository,
  userId: string,
  provider: unknown,
) {
  const legalProvider = normalizeLegalSourceProvider(provider);
  if (!legalProvider) {
    throw new LocalControlError(
      "Legal source provider is not supported.",
      "INVALID_INPUT",
      400,
    );
  }
  return repository.providerSecretForUse(userId, legalProvider);
}

export type LocalMcpConnectorRepository = Pick<
  LocalControlRepository,
  | "listMcpConnectors"
  | "getMcpConnector"
  | "createMcpConnector"
  | "updateMcpConnector"
  | "deleteMcpConnector"
  | "mcpConnectorForConnection"
  | "recordMcpRefresh"
>;

let runtimeSettingsRepository: LocalControlRepository | null = null;

/** Synchronous authority consumed by the durable local-model resolver. */
export function getAuthoritativeRuntimeSettings(userId: string) {
  runtimeSettingsRepository ??= new LocalControlRepository();
  return runtimeSettingsRepository.getSettings(userId).settings;
}

export function getAuthoritativeModelCalibration(
  userId: string,
  modelId: string,
) {
  runtimeSettingsRepository ??= new LocalControlRepository();
  return runtimeSettingsRepository.latestModelCalibration(userId, modelId);
}

export function resolveAuthoritativeModelRouting(
  settings: Pick<
    LocalClientSettings,
    "defaultModel" | "litigationModelId" | "routineModelId"
  >,
  fallbackModelId: string,
) {
  const defaultModelId = settings.defaultModel ?? fallbackModelId;
  return {
    litigationModelId: settings.litigationModelId ?? defaultModelId,
    routineModelId: settings.routineModelId ?? defaultModelId,
  };
}

export function normalizeProvider(value: unknown): ProviderId | null {
  return typeof value === "string" &&
    (PROVIDERS as readonly string[]).includes(value)
    ? (value as ProviderId)
    : null;
}

export function normalizeLegalSourceProvider(
  value: unknown,
): LegalSourceProviderId | null {
  return typeof value === "string" &&
    (LEGAL_SOURCE_PROVIDERS as readonly string[]).includes(value)
    ? (value as LegalSourceProviderId)
    : null;
}

export function parseSettingsVersion(ifMatch: string | undefined) {
  if (!ifMatch) return null;
  const match = ifMatch.match(/^(?:W\/)?\"aletheia-settings-(\d+)\"$/);
  return match ? Number(match[1]) : Number.NaN;
}

export function normalizeSettingsPatch(
  raw: unknown,
  current: LocalClientSettings,
  models: RuntimeModel[],
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LocalControlError(
      "Settings patch must be an object.",
      "INVALID_INPUT",
      400,
    );
  }
  const input = raw as Record<string, unknown>;
  const supported = new Set([
    "theme",
    "density",
    "sidebar",
    "documentFontSize",
    "defaultModel",
    "litigationModelId",
    "routineModelId",
    "reasoning",
    "fastMode",
    "notifications",
    "defaultLanding",
    "showCitationsInline",
    "defaultTemplate",
    "demoDataEnabled",
    "contextBudgetTokens",
    "evidenceIndex",
    "contextCompression",
    "compressionModelId",
  ]);
  const unsupported = new Set(["auxiliaryModels", "indexMode"]);
  for (const key of Object.keys(input)) {
    if (unsupported.has(key)) {
      throw new LocalControlError(
        `${key} is unsupported because no backend runtime consumer exists.`,
        "UNSUPPORTED_SETTING",
        422,
      );
    }
    if (!supported.has(key)) {
      throw new LocalControlError(
        `Unknown client setting: ${key}`,
        "INVALID_INPUT",
        400,
      );
    }
  }
  const next = { ...current };
  const enumValue = <T extends string>(
    key: string,
    values: readonly T[],
  ): T | undefined => {
    if (!Object.hasOwn(input, key)) return undefined;
    if (typeof input[key] === "string" && values.includes(input[key] as T)) {
      return input[key] as T;
    }
    throw new LocalControlError(
      `${key} must be one of: ${values.join(", ")}.`,
      "INVALID_INPUT",
      400,
    );
  };
  next.theme = enumValue("theme", ["System", "Light", "Dark"]) ?? next.theme;
  next.density =
    enumValue("density", ["Comfortable", "Compact"]) ?? next.density;
  next.sidebar = enumValue("sidebar", ["Standard", "Narrow"]) ?? next.sidebar;
  next.documentFontSize =
    enumValue("documentFontSize", ["Small", "Medium", "Large"]) ??
    next.documentFontSize;
  next.defaultLanding =
    enumValue("defaultLanding", [
      "Matters",
      "Agent Console",
      "Last opened matter",
    ]) ?? next.defaultLanding;
  next.defaultTemplate =
    enumValue("defaultTemplate", [
      "Legal Matter Review",
      "Compliance Impact Review",
      "Deal Due Diligence",
    ]) ?? next.defaultTemplate;
  next.reasoning =
    enumValue("reasoning", ["Off", "Low", "Medium", "High"]) ?? next.reasoning;
  if (Object.hasOwn(input, "fastMode")) {
    if (typeof input.fastMode !== "boolean") {
      throw new LocalControlError(
        "fastMode must be boolean.",
        "INVALID_INPUT",
        400,
      );
    }
    next.fastMode = input.fastMode;
  }
  if (Object.hasOwn(input, "notifications")) {
    if (typeof input.notifications !== "boolean") {
      throw new LocalControlError(
        "notifications must be boolean.",
        "INVALID_INPUT",
        400,
      );
    }
    next.notifications = input.notifications;
  }
  for (const key of ["showCitationsInline", "demoDataEnabled"] as const) {
    if (!Object.hasOwn(input, key)) continue;
    if (typeof input[key] !== "boolean") {
      throw new LocalControlError(
        `${key} must be boolean.`,
        "INVALID_INPUT",
        400,
      );
    }
    next[key] = input[key];
  }
  if (Object.hasOwn(input, "defaultModel")) {
    if (input.defaultModel === null) {
      next.defaultModel = null;
    } else if (
      typeof input.defaultModel === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.defaultModel) &&
      models.some((model) => model.id === input.defaultModel)
    ) {
      next.defaultModel = input.defaultModel;
    } else {
      throw new LocalControlError(
        "defaultModel must name a configured local model.",
        "INVALID_INPUT",
        400,
      );
    }
  }
  for (const key of ["litigationModelId", "routineModelId"] as const) {
    if (!Object.hasOwn(input, key)) continue;
    if (input[key] === null) {
      next[key] = null;
    } else if (
      typeof input[key] === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input[key]) &&
      models.some((model) => model.id === input[key])
    ) {
      next[key] = input[key];
    } else {
      throw new LocalControlError(
        `${key} must name a configured local model or be null.`,
        "INVALID_INPUT",
        400,
      );
    }
  }
  if (Object.hasOwn(input, "contextBudgetTokens")) {
    if (input.contextBudgetTokens === null) {
      next.contextBudgetTokens = null;
    } else if (
      typeof input.contextBudgetTokens === "number" &&
      Number.isSafeInteger(input.contextBudgetTokens) &&
      input.contextBudgetTokens >= 512 &&
      input.contextBudgetTokens <= 2_000_000
    ) {
      next.contextBudgetTokens = input.contextBudgetTokens;
    } else {
      throw new LocalControlError(
        "contextBudgetTokens must be null or an integer between 512 and 2000000.",
        "INVALID_INPUT",
        400,
      );
    }
  }
  next.evidenceIndex =
    enumValue("evidenceIndex", ["Keyword", "Hybrid", "Semantic"]) ??
    next.evidenceIndex;
  if (next.evidenceIndex !== "Keyword" && !semanticIndexAvailable()) {
    throw new LocalControlError(
      "Semantic evidence indexing is unavailable until a vetted local semantic index is configured.",
      "UNSUPPORTED_SETTING",
      422,
    );
  }
  next.contextCompression =
    enumValue("contextCompression", ["Off", "Manual", "Auto"]) ??
    next.contextCompression;
  if (Object.hasOwn(input, "compressionModelId")) {
    if (input.compressionModelId === null) {
      next.compressionModelId = null;
    } else if (
      typeof input.compressionModelId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.compressionModelId) &&
      models.some((model) => model.id === input.compressionModelId)
    ) {
      next.compressionModelId = input.compressionModelId;
    } else {
      throw new LocalControlError(
        "compressionModelId must name a configured local model or be null.",
        "INVALID_INPUT",
        400,
      );
    }
  }
  const selected = next.defaultModel
    ? models.find((model) => model.id === next.defaultModel)
    : null;
  if (
    selected &&
    next.contextBudgetTokens !== null &&
    next.contextBudgetTokens > selected.contextWindowTokens
  ) {
    throw new LocalControlError(
      "contextBudgetTokens exceeds the selected model context window.",
      "INVALID_INPUT",
      400,
    );
  }
  if (next.contextCompression === "Auto") {
    if (!selected) {
      throw new LocalControlError(
        "Automatic context compression requires a selected local main model.",
        "UNSUPPORTED_SETTING",
        422,
      );
    }
    const compressor = models.find(
      (model) => model.id === (next.compressionModelId ?? selected.id),
    );
    if (!compressor || compressor.state !== "ready") {
      throw new LocalControlError(
        "Automatic context compression requires a healthy local compression model.",
        "UNSUPPORTED_SETTING",
        422,
      );
    }
    if (compressor.contextWindowTokens < selected.contextWindowTokens) {
      throw new LocalControlError(
        "Automatic context compression requires a compression model whose context window is at least the main model context window.",
        "INVALID_INPUT",
        400,
      );
    }
  }
  return next;
}

export function buildRuntimeConfig(
  settings: ReturnType<LocalControlRepository["getSettings"]>,
  models: RuntimeModel[],
) {
  const selected = settings.settings.defaultModel
    ? (models.find((model) => model.id === settings.settings.defaultModel) ??
      null)
    : null;
  const routing = resolveAuthoritativeModelRouting(
    settings.settings,
    selected?.id ?? "",
  );
  const litigationModel = routing.litigationModelId
    ? (models.find((model) => model.id === routing.litigationModelId) ?? null)
    : null;
  const routineModel = routing.routineModelId
    ? (models.find((model) => model.id === routing.routineModelId) ?? null)
    : null;
  const compressionModel = selected
    ? (models.find(
        (model) =>
          model.id === (settings.settings.compressionModelId ?? selected.id),
      ) ?? null)
    : null;
  const compressionReady = Boolean(
    selected &&
    compressionModel?.state === "ready" &&
    compressionModel.contextWindowTokens >= selected.contextWindowTokens,
  );
  return {
    schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
    settingsVersion: settings.version,
    runtime: {
      modelId: selected?.id ?? null,
      modelState: selected?.state ?? null,
      contextBudgetTokens: selected
        ? Math.min(
            settings.settings.contextBudgetTokens ??
              selected.contextWindowTokens,
            selected.contextWindowTokens,
          )
        : null,
      maxOutputTokens: selected?.maxOutputTokens ?? null,
      modelRouting: {
        litigationModelId: litigationModel?.id ?? null,
        routineModelId: routineModel?.id ?? null,
      },
    },
    fields: {
      theme: { status: "available", consumer: "aletheia_ui" },
      density: { status: "available", consumer: "aletheia_ui" },
      sidebar: { status: "available", consumer: "aletheia_ui" },
      documentFontSize: { status: "available", consumer: "aletheia_ui" },
      defaultModel: {
        status: models.length ? "available" : "unavailable",
        consumer: "local_model_scheduler.generate(modelId)",
      },
      litigationModelId: {
        status: models.length ? "available" : "unavailable",
        consumer:
          "durable_litigation_handler -> local_model_scheduler.generate(modelId)",
        model: litigationModel?.id ?? null,
      },
      routineModelId: {
        status: models.length ? "available" : "unavailable",
        consumer:
          "durable_local_model_handler -> local_model_scheduler.generate(modelId)",
        model: routineModel?.id ?? null,
      },
      reasoning: {
        status: models.length ? "available" : "unavailable",
        consumer: "local_model_scheduler.reasoningEffort",
      },
      fastMode: {
        status: models.length ? "available" : "unavailable",
        consumer: "local_model_scheduler.fastMode",
      },
      notifications: { status: "available", consumer: "aletheia_ui" },
      defaultLanding: { status: "available", consumer: "aletheia_ui" },
      showCitationsInline: { status: "available", consumer: "aletheia_ui" },
      defaultTemplate: { status: "available", consumer: "aletheia_ui" },
      demoDataEnabled: { status: "available", consumer: "aletheia_ui" },
      contextBudgetTokens: {
        status: models.length ? "available" : "unavailable",
        consumer: "local_model_scheduler.contextWindowTokens",
      },
      evidenceIndex: {
        status: "available",
        consumer: "search_matter_documents.retrieval_mode",
        note: semanticIndexAvailable()
          ? "Keyword, hybrid, and semantic retrieval are available."
          : "Keyword retrieval is available; semantic index is not configured.",
      },
      matterMemory: {
        status: "available",
        consumer:
          "durableAgentRuntime.buildMatterMemorySystemContext -> local_model.generate.systemPrompt",
        note: "Matter Memory is loaded from the authenticated matter and bounded before model execution.",
      },
      auxiliaryModels: {
        status: "unavailable",
        consumer: null,
        note: "No local task-routing runtime is configured; this setting cannot be saved or consumed.",
      },
      indexMode: { status: "unsupported", consumer: null },
      contextCompression: {
        status: compressionReady ? "available" : "unavailable",
        consumer:
          "durableAgentRuntime -> DurableLocalModelStepExecutor context digest policy",
        availableModes: compressionReady ? ["Off", "Manual", "Auto"] : ["Off"],
        mode: settings.settings.contextCompression,
        model: compressionModel?.id ?? null,
        thresholdTokens: selected
          ? Math.floor(
              Math.min(
                settings.settings.contextBudgetTokens ??
                  selected.contextWindowTokens,
                selected.contextWindowTokens,
              ) * 0.5,
            )
          : null,
        note: compressionReady
          ? "Auto compresses at 50% of the authoritative budget; 85% is a fail-closed hygiene safety net."
          : "Automatic compression requires a healthy local compression model with a context window at least as large as the selected main model.",
      },
      externalProviderSecrets: {
        status: "unsupported",
        consumer: null,
        note: "Secrets may be stored for future adapters but are not consumed by the local runtime.",
      },
    } satisfies Record<string, RuntimeCapability>,
    models,
  };
}
