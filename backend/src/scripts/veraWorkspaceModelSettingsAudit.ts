import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import express from "express";
import SignalDatabase from "@signalapp/sqlcipher";

import {
  LocalDatabase,
  SQLCIPHER_RUNTIME_PROBE_DIRECTORY_PREFIX,
  verifySqlcipherRuntime,
} from "../lib/aletheia/localDatabase";
import { assertBundledDatabaseEncryptionPolicy } from "../lib/aletheia/localEnvelopeCrypto";
import { migratePlaintextDatabaseToSqlcipher } from "../lib/aletheia/sqlcipherMigration";
import {
  BoundedResponseBodyError,
  readBoundedResponseBody,
} from "../lib/network/readBoundedResponseBody";
import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  INITIAL_WORKSPACE_MIGRATION,
  PROJECT_OWNERSHIP_MIGRATION,
  type WorkspaceMigration,
  WORKSPACE_MIGRATIONS,
  WORKSPACE_INTEGRITY_MIGRATION,
  WORKSPACE_RUNTIME_MIGRATION,
  workspaceMigrationChecksum,
} from "../lib/workspace/migrations";
import { ASSISTANT_RUNTIME_MIGRATION } from "../lib/workspace/migrations/v5AssistantRuntime";
import { WORKFLOW_RUNTIME_V6_MIGRATION } from "../lib/workspace/migrations/v6WorkflowRuntime";
import { isWorkspaceConnectionSqlcipherEncrypted } from "../lib/workspace/migrations/encryptionPolicy";
import { MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION } from "../lib/workspace/migrations/v8ModelCredentialOrigin";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { SettingsRepository } from "../lib/workspace/repositories/settings";
import type {
  ModelProvider,
  ModelProviderAdapterRegistryPort,
} from "../lib/workspace/modelCompatibility";
import { ModelProfilesService } from "../lib/workspace/services/modelProfiles";
import {
  buildStoredCredentialReference,
  type CredentialBindingKey,
  type CredentialResolutionInput,
  type CredentialStorePort,
} from "../lib/workspace/services/credentialStore";
import {
  buildEndpointBindingSnapshot,
  ModelGateway,
  MODEL_GATEWAY_HARD_MAX_REQUEST_BYTES,
  MODEL_GATEWAY_HARD_MAX_RESPONSE_BYTES,
} from "../lib/workspace/services/modelGateway";
import { SettingsService } from "../lib/workspace/services/settings";
import {
  createWorkspaceSettingsV1Router,
  type WorkspaceCapabilitiesWire,
  type WorkspaceModelSettingsRuntimePort,
  type WorkspaceModelWire,
  type WorkspaceSettingsWire,
  type WorkspaceStatusWire,
} from "../routes/workspaceSettingsV1";

function loadTabularMikeSemanticsV7Migration() {
  const backendRoot = realpathSync(path.resolve(__dirname, "..", ".."));
  const tscBinary = path.join(backendRoot, "node_modules", ".bin", "tsc");
  const compileRoot = mkdtempSync(
    path.join(os.tmpdir(), "vera-v7-migration-runtime-"),
  );
  const compileConfigPath = path.join(compileRoot, "tsconfig.json");
  const outDir = path.join(compileRoot, "dist");
  writeFileSync(
    compileConfigPath,
    `${JSON.stringify(
      {
        extends: path.join(backendRoot, "tsconfig.build.json"),
        compilerOptions: {
          rootDir: path.join(backendRoot, "src"),
          typeRoots: [path.join(backendRoot, "node_modules", "@types")],
          noEmitOnError: false,
        },
        files: [
          path.join(
            backendRoot,
            "src/lib/workspace/migrations/v7TabularMikeSemantics.ts",
          ),
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const nodeModuleApi = require("node:module") as {
    Module: { _initPaths(): void };
  };
  const previousNodePath = process.env.NODE_PATH;
  const compiledMigrationPath = path.join(
    outDir,
    "lib/workspace/migrations/v7TabularMikeSemantics.js",
  );
  try {
    try {
      execFileSync(tscBinary, ["-p", compileConfigPath, "--outDir", outDir], {
        cwd: backendRoot,
        stdio: "pipe",
      });
    } catch (error) {
      if (!existsSync(compiledMigrationPath)) {
        throw error;
      }
    }
    process.env.NODE_PATH = [
      path.join(backendRoot, "node_modules"),
      previousNodePath,
    ]
      .filter(Boolean)
      .join(path.delimiter);
    nodeModuleApi.Module._initPaths();
    const compiledModule = require(compiledMigrationPath) as {
      TABULAR_MIKE_SEMANTICS_V7_MIGRATION: WorkspaceMigration;
    };
    return compiledModule.TABULAR_MIKE_SEMANTICS_V7_MIGRATION;
  } finally {
    process.env.NODE_PATH = previousNodePath;
    nodeModuleApi.Module._initPaths();
    rmSync(compileRoot, { recursive: true, force: true });
  }
}

const TABULAR_MIKE_SEMANTICS_V7_MIGRATION =
  loadTabularMikeSemanticsV7Migration();

function buildFullMigrations() {
  const prefixCandidates = [
    ...WORKSPACE_MIGRATIONS,
    ASSISTANT_RUNTIME_MIGRATION,
    WORKFLOW_RUNTIME_V6_MIGRATION,
  ].filter((migration) => migration.version >= 1 && migration.version <= 6);
  const byVersion = new Map<number, WorkspaceMigration>();
  for (const migration of prefixCandidates) {
    if (!byVersion.has(migration.version)) {
      byVersion.set(migration.version, migration);
    }
  }
  const prefix = [1, 2, 3, 4, 5, 6].map((version) => {
    const migration = byVersion.get(version);
    assert.ok(migration, `missing migration v${version} from audit prefix`);
    return migration;
  });
  return [
    ...prefix,
    TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
    MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
  ] as const;
}

const FULL_MIGRATIONS = buildFullMigrations();
const PRE_V8_MIGRATIONS = FULL_MIGRATIONS.slice(0, FULL_MIGRATIONS.length - 1);

const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-model-settings-audit-"),
);
const sqlcipherBackupRoot = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-model-settings-sqlcipher-backup-"),
);
const auditDatabaseKey = randomBytes(32);

function withSqlcipherEnvironment<T>(key: Buffer | null, operation: () => T) {
  const previousEnvironment = { ...process.env };
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
    process.env.ALETHEIA_DATABASE_KEY_SOURCE = "env";
    if (key) {
      process.env.ALETHEIA_DATABASE_KEY_BASE64 = key.toString("base64");
    } else {
      delete process.env.ALETHEIA_DATABASE_KEY_BASE64;
    }
    return operation();
  } finally {
    process.env = previousEnvironment;
  }
}

function migrateAuditDatabaseToSqlcipher(
  databasePath: string,
  fixtureName: string,
  expectedPlaintextMarkers: readonly string[] = [],
) {
  const backupDir = path.join(sqlcipherBackupRoot, fixtureName);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const migrated = withSqlcipherEnvironment(auditDatabaseKey, () =>
    migratePlaintextDatabaseToSqlcipher({
      dataDir: path.dirname(databasePath),
      databasePath,
      backupDir,
      apply: true,
    }),
  );
  assert.equal(migrated.status, "migrated");
  assert.ok(migrated.backup_path);
  const backupPath = String(migrated.backup_path);
  const backupBytes = readFileSync(backupPath);
  for (const marker of expectedPlaintextMarkers) {
    assert.equal(backupBytes.includes(Buffer.from(marker)), true);
  }
  unlinkSync(backupPath);
  assert.equal(existsSync(backupPath), false);
  return migrated;
}

function openSqlcipherWorkspaceDatabase(
  databasePath: string,
  migrations: readonly WorkspaceMigration[],
) {
  return withSqlcipherEnvironment(
    auditDatabaseKey,
    () => new WorkspaceDatabase(databasePath, { migrations }),
  );
}

function databaseArtifactPaths(databasePath: string) {
  const directory = path.dirname(databasePath);
  const baseName = path.basename(databasePath);
  return readdirSync(directory)
    .filter(
      (name) =>
        name === baseName ||
        name === `${baseName}-wal` ||
        name === `${baseName}-shm` ||
        name === `${baseName}-journal`,
    )
    .map((name) => path.join(directory, name));
}

class AuditCredentialStore implements CredentialStorePort {
  readonly serviceName = "ai.aletheia.workspace-model-profile-credentials";
  readonly accountPrefix = "vera-model-profile-account:";
  storeCalls = 0;
  resolveCalls = 0;
  deleteCalls: string[] = [];
  lastReference: string | null = null;
  lastAccount: string | null = null;
  private readonly byReference = new Map<
    string,
    {
      binding: CredentialBindingKey;
      secret: string;
      reference: string;
      account: string;
    }
  >();

  private key(binding: CredentialBindingKey) {
    return JSON.stringify(binding);
  }

  store(input: { binding: CredentialBindingKey; secret: string }) {
    this.storeCalls += 1;
    const locatorId = String(this.byReference.size + 1).padStart(16, "0");
    const reference = buildStoredCredentialReference(
      input.binding.profileId,
      locatorId,
    );
    const account = `${this.accountPrefix}${input.binding.profileId}:${input.binding.provider}:${locatorId}`;
    this.byReference.set(reference, {
      binding: input.binding,
      secret: input.secret,
      reference,
      account,
    });
    this.lastReference = reference;
    this.lastAccount = account;
    return { reference };
  }

  resolve(input: CredentialResolutionInput) {
    this.resolveCalls += 1;
    const stored = this.byReference.get(input.reference);
    if (!stored) {
      throw new Error("missing credential");
    }
    if (this.key(stored.binding) !== this.key(input.binding)) {
      throw new Error("binding mismatch");
    }
    return stored.secret;
  }

  delete(reference: string) {
    this.deleteCalls.push(reference);
    this.byReference.delete(reference);
  }

  hasReference(reference: string | null) {
    if (!reference) return false;
    return this.byReference.has(reference);
  }
}

class UpdatingResources {
  constructor(private readonly database: WorkspaceDatabase) {}

  private cancel(jobIds: readonly string[]) {
    const now = new Date("2026-07-14T00:00:00.000Z").toISOString();
    for (const jobId of jobIds) {
      this.database
        .prepare("UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?")
        .run(now, jobId);
    }
  }

  cancelQueued(jobIds: readonly string[]) {
    this.cancel(jobIds);
  }

  requestAbortRunning(jobIds: readonly string[]) {
    this.cancel(jobIds);
  }
}

class NoOpResources {
  cancelQueued(_jobIds: readonly string[]) {}
  requestAbortRunning(_jobIds: readonly string[]) {}
}

function now(offset = 0) {
  return new Date(Date.UTC(2026, 6, 14, 0, 0, offset)).toISOString();
}

function createDatabase(fileName: string, migrations = FULL_MIGRATIONS) {
  return new WorkspaceDatabase(path.join(root, fileName), {
    migrations,
  });
}

function createServices(
  database: WorkspaceDatabase,
  store: AuditCredentialStore,
  allowLocalDevelopmentBaseUrl = false,
  resources: UpdatingResources | NoOpResources | undefined = undefined,
  adapterRegistry: ModelProviderAdapterRegistryPort | undefined = undefined,
) {
  const profiles = new ModelProfilesRepository(database);
  const settings = new SettingsRepository(database);
  const projects = new ProjectsRepository(database);
  return {
    profiles,
    settings,
    modelService: new ModelProfilesService(profiles, {
      allowLocalDevelopmentBaseUrl,
      credentialStore: store,
      resources,
      adapterRegistry,
      clock: () => new Date("2026-07-14T00:00:00.000Z"),
    }),
    settingsService: new SettingsService(
      settings,
      projects,
      profiles,
      () => new Date("2026-07-14T00:00:00.000Z"),
    ),
  };
}

function seedConfiguredProfileCredential(input: {
  profiles: ModelProfilesRepository;
  store: AuditCredentialStore;
  profile: { id: string; provider: ModelProvider };
  origin: string;
  secret: string;
  nowAt: string;
}) {
  const stored = input.store.store({
    binding: {
      profileId: input.profile.id,
      provider: input.profile.provider,
      canonicalOrigin: input.origin,
    },
    secret: input.secret,
  });
  input.profiles.setCredentialBindingInternal(input.profile.id, {
    reference: stored.reference,
    state: "configured",
    origin: input.origin,
    now: input.nowAt,
  });
  return stored.reference;
}

function insertLegacyProfile(
  profiles: ModelProfilesRepository,
  input: {
    id: string;
    name: string;
    provider: ModelProvider;
    model: string;
    baseUrl?: string | null;
    enabled?: boolean;
    isDefault?: boolean;
  },
) {
  return profiles.create({
    id: input.id,
    name: input.name,
    provider: input.provider,
    model: input.model,
    baseUrl: input.baseUrl ?? null,
    credentialOrigin: null,
    credentialState: "missing",
    contextWindowTokens: null,
    maxOutputTokens: null,
    enabled: input.enabled ?? true,
    isDefault: input.isDefault ?? false,
    capabilities: {
      streaming: false,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
    },
    now: now(1),
  });
}

function forceEnableProfileFixture(
  profiles: ModelProfilesRepository,
  profileId: string,
  offset = 1,
) {
  profiles.update(profileId, { enabled: true, now: now(offset) });
}

function insertJob(
  database: WorkspaceDatabase,
  input: {
    id: string;
    type:
      | "assistant_generate"
      | "workflow_run"
      | "tabular_cell"
      | "document_parse";
    resourceType:
      | "chat"
      | "workflow_run"
      | "tabular_cell"
      | "tabular_review"
      | "document";
    resourceId: string;
    status: "queued" | "running";
  },
) {
  database
    .prepare(
      `INSERT INTO jobs
        (id, type, status, resource_type, resource_id, scheduled_at, queued_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.type,
      input.status,
      input.resourceType,
      input.resourceId,
      now(1),
      now(1),
      now(1),
      now(1),
    );
}

function derivedFixtureId(jobId: string, label: string) {
  return `${jobId}-${label}`;
}

function insertAssistantSnapshotJob(
  database: WorkspaceDatabase,
  profileId: string,
  jobId: string,
) {
  const chatId = derivedFixtureId(jobId, "chat");
  const promptId = derivedFixtureId(jobId, "prompt");
  const outputId = derivedFixtureId(jobId, "output");
  database
    .prepare(
      `INSERT INTO chats
        (id, project_id, scope, title, status, model_profile_id, created_at, updated_at)
       VALUES (?, NULL, 'global', 'Assistant chat', 'active', NULL, ?, ?)`,
    )
    .run(chatId, now(2), now(2));
  database
    .prepare(
      `INSERT INTO chat_messages
        (id, chat_id, sequence, role, content, status, created_at, updated_at)
       VALUES (?, ?, 0, 'user', 'question', 'complete', ?, ?)`,
    )
    .run(promptId, chatId, now(2), now(2));
  insertJob(database, {
    id: jobId,
    type: "assistant_generate",
    resourceType: "chat",
    resourceId: chatId,
    status: "queued",
  });
  database
    .prepare(
      `INSERT INTO chat_messages
        (id, chat_id, sequence, role, content, status, job_id, created_at, updated_at)
       VALUES (?, ?, 1, 'assistant', '', 'pending', ?, ?, ?)`,
    )
    .run(outputId, chatId, jobId, now(2), now(2));
  database
    .prepare(
      `INSERT INTO assistant_generation_snapshots
        (job_id, chat_id, prompt_message_id, output_message_id, model_profile_id,
         current_version_only, retrieval_limit, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 5, ?)`,
    )
    .run(jobId, chatId, promptId, outputId, profileId, now(2));
  return { chatId, promptId, outputId };
}

function insertWorkflowSnapshotJob(
  database: WorkspaceDatabase,
  profileId: string | null,
  jobId: string,
) {
  const workflowId = derivedFixtureId(jobId, "workflow");
  const runId = derivedFixtureId(jobId, "run");
  const snapshotId = derivedFixtureId(jobId, "snapshot");
  const stepId = derivedFixtureId(jobId, "step");
  database
    .prepare(
      `INSERT INTO workflows
        (id, type, title, status, steps_json, columns_config_json, created_at, updated_at)
       VALUES (?, 'assistant', 'Workflow', 'active', '[]', '[]', ?, ?)`,
    )
    .run(workflowId, now(3), now(3));
  insertJob(database, {
    id: jobId,
    type: "workflow_run",
    resourceType: "workflow_run",
    resourceId: runId,
    status: "running",
  });
  database
    .prepare(
      `INSERT INTO workflow_runs
        (id, workflow_id, project_id, model_profile_id, job_id, status, input_json,
         created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 'queued', '{}', ?, ?)`,
    )
    .run(runId, workflowId, profileId, jobId, now(3), now(3));
  database
    .prepare(
      `INSERT INTO workflow_execution_snapshots
        (id, workflow_run_id, workflow_id, schema_version, workflow_version, project_id,
         model_profile_id, config_json, steps_json, skill_markdown,
         columns_config_json, input_binding_json, snapshot_sha256, created_at)
       VALUES (?, ?, ?, 1, 'v1', NULL, ?, '{}', '[]', '', '[]', '{}', ?, ?)`,
    )
    .run(snapshotId, runId, workflowId, profileId, "a".repeat(64), now(3));
  database
    .prepare(
      `INSERT INTO workflow_step_runs
        (id, workflow_run_id, ordinal, attempt, step_json, status, input_json,
         created_at, updated_at)
       VALUES (?, ?, 0, 1, '{}', 'running', '{}', ?, ?)`,
    )
    .run(stepId, runId, now(3), now(3));
  return { workflowId, runId, stepId };
}

function insertTabularAssociationJob(
  database: WorkspaceDatabase,
  profileId: string | null,
  jobId: string,
) {
  const reviewId = derivedFixtureId(jobId, "review");
  const chatId = derivedFixtureId(jobId, "review-chat");
  const promptMessageId = derivedFixtureId(jobId, "review-prompt");
  const assistantMessageId = derivedFixtureId(jobId, "review-assistant");
  database
    .prepare(
      `INSERT INTO tabular_reviews
        (id, project_id, workflow_id, model_profile_id, title, status,
         document_ids_json, columns_config_json, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, 'Review', 'draft', '[]', '[]', ?, ?)`,
    )
    .run(reviewId, profileId, now(4), now(4));
  insertJob(database, {
    id: jobId,
    type: "assistant_generate",
    resourceType: "chat",
    resourceId: chatId,
    status: "queued",
  });
  database
    .prepare(
      `INSERT INTO tabular_review_chats
        (id, review_id, title, user_id, status, job_id, model_profile_id, created_at, updated_at)
       VALUES (?, ?, '', NULL, 'active', ?, ?, ?, ?)`,
    )
    .run(chatId, reviewId, jobId, profileId, now(4), now(4));
  database
    .prepare(
      `INSERT INTO tabular_review_chat_messages
        (id, review_chat_id, sequence, role, content, annotations_json, status,
         sources_json, created_at, updated_at)
       VALUES (?, ?, 0, 'user', 'question', '[]', 'complete', '[]', ?, ?)`,
    )
    .run(promptMessageId, chatId, now(4), now(4));
  database
    .prepare(
      `INSERT INTO tabular_review_chat_messages
        (id, review_chat_id, sequence, role, content, annotations_json, status,
         job_id, model_profile_id, sources_json, created_at, updated_at)
       VALUES (?, ?, 1, 'assistant', '', '[]', 'pending', ?, ?, '[]', ?, ?)`,
    )
    .run(assistantMessageId, chatId, jobId, profileId, now(4), now(4));
  return { reviewId, chatId, messageId: assistantMessageId };
}

function insertTabularCellJob(
  database: WorkspaceDatabase,
  reviewId: string,
  jobId: string,
) {
  const documentId = derivedFixtureId(jobId, "document");
  const columnId = derivedFixtureId(jobId, "column");
  const cellId = derivedFixtureId(jobId, "cell");
  database
    .prepare(
      `INSERT INTO documents
        (id, project_id, folder_id, title, filename, mime_type, size_bytes, parse_status,
         current_version_id, deleted_at, created_at, updated_at)
       VALUES (?, NULL, NULL, 'Audit document', 'audit.txt', 'text/plain', 1, 'ready',
               NULL, NULL, ?, ?)`,
    )
    .run(documentId, now(4), now(4));
  database
    .prepare(
      `INSERT INTO tabular_review_documents
        (review_id, document_id, ordinal, created_at)
       VALUES (?, ?, 0, ?)`,
    )
    .run(reviewId, documentId, now(4));
  database
    .prepare(
      `INSERT INTO tabular_review_columns
        (id, review_id, key, title, output_type, prompt, enum_values_json, ordinal,
         created_at, updated_at, format, tags_json, legacy_output_type, legacy_metadata_json)
       VALUES (?, ?, 'summary', 'Summary', 'text', '', NULL, 0,
               ?, ?, 'text', '[]', 'text', '{}')`,
    )
    .run(columnId, reviewId, now(4), now(4));
  insertJob(database, {
    id: jobId,
    type: "tabular_cell",
    resourceType: "tabular_cell",
    resourceId: cellId,
    status: "running",
  });
  database
    .prepare(
      `INSERT INTO tabular_cells
        (id, review_id, document_id, column_id, output_type, value_json, content,
         citations_json, status, error_json, error_code, job_id, attempt,
         created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'text', NULL, NULL, '[]', 'running', NULL, NULL, ?, 0, ?, ?, NULL)`,
    )
    .run(cellId, reviewId, documentId, columnId, jobId, now(4), now(4));
  return { documentId, columnId, cellId };
}

function toCapabilitiesWire(
  value: ReturnType<ModelProfilesService["capabilities"]>,
): WorkspaceCapabilitiesWire {
  return {
    schema_version: value.schemaVersion,
    local_only: true,
    loopback_http_allowed: value.loopbackHttpAllowed,
    credential_write_enabled: value.credentialWriteEnabled,
    secret_readback_supported: false,
    runtime_wired: value.runtimeWired,
  };
}

function toSettingsWire(
  value: ReturnType<SettingsService["get"]>,
): WorkspaceSettingsWire {
  return {
    locale: value.locale,
    theme: value.theme,
    default_model_profile_id: value.defaultModelProfileId,
    default_project_id: value.defaultProjectId,
    updated_at: value.updatedAt,
  };
}

function toModelWire(
  value: ReturnType<ModelProfilesService["getView"]>,
): WorkspaceModelWire {
  return {
    id: value.id,
    name: value.name,
    provider: value.provider,
    model: value.model,
    base_url: value.baseUrl,
    context_window_tokens: value.contextWindowTokens,
    max_output_tokens: value.maxOutputTokens,
    enabled: value.enabled,
    is_default: value.isDefault,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    capabilities: value.capabilities,
    credential: {
      status: value.credential.status,
      configured: value.credential.configured,
      canonical_origin: value.credential.canonicalOrigin,
    },
    endpoint_binding: {
      provider: value.endpointBinding.provider,
      model: value.endpointBinding.model,
      normalized_base_url: value.endpointBinding.normalizedBaseUrl,
      canonical_origin: value.endpointBinding.canonicalOrigin,
      execution_revision: value.endpointBinding.executionRevision,
      profile_updated_at: value.endpointBinding.profileUpdatedAt,
    },
    availability: value.availability,
    requires_credential: value.requiresCredential,
  };
}

function createRuntimePort(
  modelService: ModelProfilesService,
  settingsService: SettingsService,
): WorkspaceModelSettingsRuntimePort {
  return {
    getStatus() {
      return {
        capabilities: toCapabilitiesWire(modelService.capabilities()),
        settings: toSettingsWire(settingsService.get()),
        models: modelService.listViews().map(toModelWire),
      } satisfies WorkspaceStatusWire;
    },
    getSettings() {
      return toSettingsWire(settingsService.get());
    },
    updateSettings(_context, input) {
      return toSettingsWire(settingsService.update(input));
    },
    listModels() {
      return modelService.listViews().map(toModelWire);
    },
    createModel(_context, input) {
      const created = modelService.create(input);
      return toModelWire(modelService.getView(created.id));
    },
    getModel(_context, id) {
      return toModelWire(modelService.getView(id));
    },
    updateModel(_context, id, input) {
      modelService.update(id, input);
      return toModelWire(modelService.getView(id));
    },
    enableModel(_context, id) {
      modelService.enable(id);
      return toModelWire(modelService.getView(id));
    },
    disableModel(_context, id) {
      modelService.disable(id);
      return toModelWire(modelService.getView(id));
    },
    setDefaultModel(_context, id) {
      modelService.setDefault(id);
      return toModelWire(modelService.getView(id));
    },
    deleteModel(_context, id) {
      modelService.delete(id);
    },
  };
}

function assertNoSensitiveText(
  label: string,
  text: string,
  forbidden: string[],
) {
  for (const value of forbidden) {
    assert.equal(
      text.includes(value),
      false,
      `${label} leaked sensitive value: ${value}`,
    );
  }
}

async function withServer<T>(
  app: express.Express,
  fn: (baseUrl: string) => Promise<T>,
) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("audit server did not bind");
  }
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function auditRouteWireAndSecretScan() {
  const databasePath = "route-wire.db";
  const database = createDatabase(databasePath);
  const store = new AuditCredentialStore();
  const { modelService, settingsService, profiles } = createServices(
    database,
    store,
    true,
    new UpdatingResources(database),
  );
  const profile = modelService.create({
    name: "Wire audit",
    provider: "openai_compatible",
    model: "audit-model",
    baseUrl: "http://127.0.0.1:11434/v1",
    capabilities: {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
    },
    enabled: false,
    isDefault: false,
  });
  const secret = "vera-wire-secret";
  seedConfiguredProfileCredential({
    profiles,
    store,
    profile: { id: profile.id, provider: "openai_compatible" },
    origin: "http://127.0.0.1:11434",
    secret,
    nowAt: now(5),
  });
  const configured = modelService.getView(profile.id);
  const app = express();
  app.use(express.json());
  app.use(
    "/workspace-model-settings",
    createWorkspaceSettingsV1Router({
      runtime: createRuntimePort(modelService, settingsService),
      auth: (_req, _res, next) => next(),
      context: () => ({ principalId: "audit-user" }),
    }),
  );
  await withServer(app, async (baseUrl) => {
    const statusResponse = await fetch(
      `${baseUrl}/workspace-model-settings/status`,
    );
    assert.equal(statusResponse.status, 200);
    const statusText = await statusResponse.text();
    const statusJson = JSON.parse(statusText) as WorkspaceStatusWire;
    assertNoSensitiveText("status body", statusText, [
      secret,
      store.lastReference ?? "",
      store.serviceName,
      store.lastAccount ?? "",
      "keychain://vera/model-profile/",
    ]);
    assert.equal(statusJson.capabilities.credential_write_enabled, false);
    assert.equal(statusJson.capabilities.runtime_wired, false);
    assert.deepEqual(statusJson.models[0]?.capabilities, {
      streaming: false,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
    });
    assert.equal(statusJson.models[0]?.availability.status, "disabled");
    const modelResponse = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}`,
    );
    assert.equal(modelResponse.status, 200);
    const modelText = await modelResponse.text();
    const modelJson = JSON.parse(modelText) as WorkspaceModelWire;
    assertNoSensitiveText("model body", modelText, [
      secret,
      store.lastReference ?? "",
      store.serviceName,
      store.lastAccount ?? "",
      "keychain://vera/model-profile/",
    ]);
    assert.deepEqual(modelJson.capabilities, {
      streaming: false,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
    });
    assert.equal(modelJson.availability.status, "disabled");
    assert.equal(
      modelJson.credential.canonical_origin,
      configured.credential.canonicalOrigin,
    );
    const credentialPut = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}/credential`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "ignored" }),
      },
    );
    assert.equal(credentialPut.status, 404);
    const credentialDelete = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}/credential`,
      {
        method: "DELETE",
      },
    );
    assert.equal(credentialDelete.status, 404);
    const enableResponse = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}/enable`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(enableResponse.status, 409);
    const defaultResponse = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}/default`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(defaultResponse.status, 409);
  });
  database.close();
  const bytes = readFileSync(path.join(root, databasePath));
  assert.equal(bytes.includes(Buffer.from(secret)), false);
}

async function auditV8PlaintextSafeStateOnlyMigration() {
  const databasePath = path.join(root, "migration-v8-plaintext-safe.db");
  const preV8 = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  const profileId = "00000000-0000-4000-8000-000000000180";
  const projectId = "00000000-0000-4000-8000-000000000181";
  const jobId = "00000000-0000-4000-8000-000000000182";
  const canonicalProfileId = "00000000-0000-4000-8000-000000000183";
  preV8
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref,
         credential_status, is_default, enabled)
       VALUES (?, 'Plaintext safe state', 'openai', 'gpt-safe', NULL, NULL,
               'not_configured', 1, 1)`,
    )
    .run(profileId);
  preV8
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref,
         credential_status, is_default, enabled)
       VALUES (?, 'Canonical plaintext endpoint', 'openai', 'gpt-safe',
               'https://api.openai.com/v1', NULL, 'not_configured', 0, 0)`,
    )
    .run(canonicalProfileId);
  preV8
    .prepare(
      `INSERT INTO projects
        (id, name, default_model_profile_id, status, created_at, updated_at)
       VALUES (?, 'Plaintext safe project', ?, 'active', ?, ?)`,
    )
    .run(projectId, profileId, now(1), now(1));
  preV8
    .prepare(
      `UPDATE workspace_settings
          SET default_model_profile_id = ?, updated_at = ?
        WHERE id = 'workspace'`,
    )
    .run(profileId, now(1));
  insertJob(preV8, {
    id: jobId,
    type: "assistant_generate",
    resourceType: "chat",
    resourceId: "plaintext-safe-chat",
    status: "queued",
  });
  preV8.close();

  const migrated = new WorkspaceDatabase(databasePath, {
    migrations: FULL_MIGRATIONS,
  });
  assert.equal(migrated.migration?.currentVersion, 8);
  assert.equal(migrated.migration?.capabilities.sqlcipherEncrypted, false);
  assert.deepEqual(
    {
      ...migrated
        .prepare(
          `SELECT enabled, is_default, credential_ref, credential_status
             FROM model_profiles WHERE id = ?`,
        )
        .get(profileId),
    },
    {
      enabled: 0,
      is_default: 0,
      credential_ref: null,
      credential_status: "not_configured",
    },
  );
  assert.equal(
    migrated
      .prepare(
        `SELECT default_model_profile_id
           FROM workspace_settings WHERE id = 'workspace'`,
      )
      .get()?.default_model_profile_id,
    null,
  );
  assert.equal(
    migrated.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId)?.status,
    "interrupted",
  );
  assert.equal(
    migrated
      .prepare("SELECT base_url FROM model_profiles WHERE id = ?")
      .get(canonicalProfileId)?.base_url,
    "https://api.openai.com/v1",
  );
  migrated.close();
}

async function auditTrustedSqlcipherConnectionCapability() {
  const runtimeProbeDirectories = () =>
    readdirSync(os.tmpdir())
      .filter((name) =>
        name.startsWith(SQLCIPHER_RUNTIME_PROBE_DIRECTORY_PREFIX),
      )
      .sort();
  const runtimeProbeDirectoriesBefore = runtimeProbeDirectories();
  const rawSqlcipher = new SignalDatabase(":memory:");
  try {
    const unkeyedCipherVersion = rawSqlcipher.pragma("cipher_version", {
      simple: true,
    });
    assert.equal(
      typeof unkeyedCipherVersion === "string" &&
        unkeyedCipherVersion.trim().length > 0,
      true,
    );
    assert.equal(
      isWorkspaceConnectionSqlcipherEncrypted(
        rawSqlcipher as unknown as Parameters<
          typeof isWorkspaceConnectionSqlcipherEncrypted
        >[0],
      ),
      false,
    );
  } finally {
    rawSqlcipher.close();
  }

  const spoofedAdapter = {
    exec() {},
    prepare() {
      return {
        run() {},
        get() {
          return { cipher_version: "4.10.0" };
        },
        all() {
          return [{ cipher_version: "4.10.0" }];
        },
      };
    },
  };
  assert.equal(isWorkspaceConnectionSqlcipherEncrypted(spoofedAdapter), false);
  const forgedLocalDatabase = Object.assign(
    Object.create(LocalDatabase.prototype) as LocalDatabase,
    spoofedAdapter,
  );
  assert.equal(
    isWorkspaceConnectionSqlcipherEncrypted(forgedLocalDatabase),
    false,
  );

  withSqlcipherEnvironment(auditDatabaseKey, () => {
    const memoryProbe = new LocalDatabase(":memory:");
    try {
      const attestation = memoryProbe.workspaceEncryptionAttestation();
      assert.ok(attestation);
      assert.equal(Object.isFrozen(attestation), true);
      assert.equal(attestation.persistence, "memory_runtime_probe");
      assert.equal(
        attestation.cipherIntegrityStatus,
        "unsupported_memory_database_file_undefined",
      );
      assert.equal(attestation.cipherIntegrityVerified, false);
      assert.equal(isWorkspaceConnectionSqlcipherEncrypted(memoryProbe), false);
    } finally {
      memoryProbe.close();
    }
    assert.equal(verifySqlcipherRuntime().encrypted, true);
    assert.doesNotThrow(() => assertBundledDatabaseEncryptionPolicy());
  });
  assert.deepEqual(runtimeProbeDirectories(), runtimeProbeDirectoriesBefore);

  const signalPrototype = SignalDatabase.prototype as unknown as {
    pragma(sql: string, options?: unknown): unknown;
  };
  const originalSignalPragma = signalPrototype.pragma;
  signalPrototype.pragma = function (sql, options) {
    if (sql === "cipher_integrity_check") {
      return [{ cipher_integrity_check: "unknown integrity result" }];
    }
    return originalSignalPragma.call(this, sql, options);
  };
  const runtimeProbeDirectoriesBeforeFailure = runtimeProbeDirectories();
  try {
    assert.throws(
      () =>
        withSqlcipherEnvironment(auditDatabaseKey, () =>
          verifySqlcipherRuntime(),
        ),
      /SQLCipher integrity check failed/,
    );
  } finally {
    signalPrototype.pragma = originalSignalPragma;
  }
  assert.deepEqual(
    runtimeProbeDirectories(),
    runtimeProbeDirectoriesBeforeFailure,
  );

  withSqlcipherEnvironment(auditDatabaseKey, () => {
    const trustedPath = path.join(root, "trusted-sqlcipher-capability.db");
    const trusted = new LocalDatabase(trustedPath);
    try {
      assert.equal(isWorkspaceConnectionSqlcipherEncrypted(trusted), true);
      assert.equal(
        trusted.workspaceEncryptionAttestation()?.persistence,
        "persistent",
      );
      for (const method of [
        "exec",
        "prepare",
        "status",
        "workspaceEncryptionAttestation",
      ] as const) {
        Object.defineProperty(trusted, method, {
          configurable: true,
          value() {
            throw new Error(`shadowed ${method}`);
          },
        });
        assert.equal(isWorkspaceConnectionSqlcipherEncrypted(trusted), false);
        assert.equal(
          delete (trusted as unknown as Record<string, unknown>)[method],
          true,
        );
        assert.equal(isWorkspaceConnectionSqlcipherEncrypted(trusted), true);
      }

      const originalPrepare = LocalDatabase.prototype.prepare;
      LocalDatabase.prototype.prepare = function (sql: string) {
        return originalPrepare.call(this, sql);
      };
      try {
        assert.equal(isWorkspaceConnectionSqlcipherEncrypted(trusted), false);
      } finally {
        LocalDatabase.prototype.prepare = originalPrepare;
      }
      assert.equal(isWorkspaceConnectionSqlcipherEncrypted(trusted), true);
    } finally {
      trusted.close();
    }

    const redirectedNodeDatabase = new DatabaseSync(":memory:");
    class RedirectedLocalDatabase extends LocalDatabase {
      override exec(sql: string) {
        redirectedNodeDatabase.exec(sql);
      }

      override prepare(sql: string) {
        return redirectedNodeDatabase.prepare(sql) as unknown as ReturnType<
          LocalDatabase["prepare"]
        >;
      }
    }
    const redirected = new RedirectedLocalDatabase(
      path.join(root, "redirected-subclass-sqlcipher.db"),
    );
    try {
      assert.equal(isWorkspaceConnectionSqlcipherEncrypted(redirected), false);
    } finally {
      redirected.close();
      redirectedNodeDatabase.close();
    }
  });
}

async function auditV8PlaintextProfileEvidenceEdges() {
  const statusPath = path.join(root, "migration-v8-status-only-gate.db");
  const statusOnly = new WorkspaceDatabase(statusPath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  const statusProfileId = "00000000-0000-4000-8000-000000000190";
  statusOnly
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref,
         credential_status, is_default, enabled)
       VALUES (?, 'Status-only evidence', 'openai', 'gpt-status', NULL, NULL,
               'configured', 0, 0)`,
    )
    .run(statusProfileId);
  assert.throws(
    () =>
      MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION.apply(statusOnly, {
        jsonTextChecks: true,
        fts5: true,
        sqlcipherEncrypted: true,
      }),
    /inconsistent SQLCipher connection capability/,
  );
  assert.equal(
    statusOnly
      .prepare("PRAGMA table_info(model_profiles)")
      .all()
      .some((row) => row.name === "credential_origin"),
    false,
  );
  assert.equal(
    statusOnly
      .prepare("SELECT credential_status FROM model_profiles WHERE id = ?")
      .get(statusProfileId)?.credential_status,
    "configured",
  );
  statusOnly.close();
  assert.throws(
    () =>
      new WorkspaceDatabase(statusPath, {
        migrations: FULL_MIGRATIONS,
      }),
    /npm run migrate:aletheia:sqlcipher --prefix backend/,
  );
  const unchangedStatus = new WorkspaceDatabase(statusPath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  assert.deepEqual(
    {
      ...unchangedStatus
        .prepare(
          `SELECT credential_ref, credential_status
             FROM model_profiles WHERE id = ?`,
        )
        .get(statusProfileId),
    },
    { credential_ref: null, credential_status: "configured" },
  );
  unchangedStatus.close();

  const originPath = path.join(root, "migration-v8-partial-origin-gate.db");
  const partialOrigin = new WorkspaceDatabase(originPath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  const originProfileId = "00000000-0000-4000-8000-000000000191";
  partialOrigin
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref,
         credential_status, is_default, enabled)
       VALUES (?, 'Partial origin evidence', 'openai', 'gpt-origin', NULL, NULL,
               'not_configured', 0, 0)`,
    )
    .run(originProfileId);
  partialOrigin.exec(
    "ALTER TABLE model_profiles ADD COLUMN credential_origin TEXT",
  );
  const originMarker = "https://legacy-origin-sensitive.example";
  partialOrigin
    .prepare("UPDATE model_profiles SET credential_origin = ? WHERE id = ?")
    .run(originMarker, originProfileId);
  partialOrigin.close();
  assert.throws(
    () =>
      new WorkspaceDatabase(originPath, {
        migrations: FULL_MIGRATIONS,
      }),
    /npm run migrate:aletheia:sqlcipher --prefix backend/,
  );
  const unchangedOrigin = new WorkspaceDatabase(originPath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  assert.equal(
    unchangedOrigin
      .prepare("SELECT credential_origin FROM model_profiles WHERE id = ?")
      .get(originProfileId)?.credential_origin,
    originMarker,
  );
  unchangedOrigin.close();

  const unsafeBasePath = path.join(
    root,
    "migration-v8-unsafe-base-url-gate.db",
  );
  const unsafeBase = new WorkspaceDatabase(unsafeBasePath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  const unsafeBaseProfileId = "00000000-0000-4000-8000-000000000192";
  const unsafeBaseMarker =
    "https://legacy-user:legacy-password@api.example.com/v1?raw=1";
  unsafeBase
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref,
         credential_status, is_default, enabled)
       VALUES (?, 'Unsafe endpoint evidence', 'openai', 'gpt-base', ?, NULL,
               'not_configured', 0, 0)`,
    )
    .run(unsafeBaseProfileId, unsafeBaseMarker);
  unsafeBase.close();
  assert.throws(
    () =>
      new WorkspaceDatabase(unsafeBasePath, {
        migrations: FULL_MIGRATIONS,
      }),
    /npm run migrate:aletheia:sqlcipher --prefix backend/,
  );
  const unchangedBase = new WorkspaceDatabase(unsafeBasePath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  assert.equal(
    unchangedBase
      .prepare("SELECT base_url FROM model_profiles WHERE id = ?")
      .get(unsafeBaseProfileId)?.base_url,
    unsafeBaseMarker,
  );
  unchangedBase.close();
}

async function auditV8PlaintextRuntimeTextEvidenceGate() {
  const databasePath = path.join(
    root,
    "migration-v8-runtime-text-evidence-gate.db",
  );
  const preV8 = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  const profiles = new ModelProfilesRepository(preV8);
  const assistantProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000193",
    name: "Plaintext assistant text gate",
    provider: "openai",
    model: "gpt-safe",
  });
  const workflowProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000194",
    name: "Plaintext workflow text gate",
    provider: "openai",
    model: "gpt-safe",
  });
  const tabularProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000195",
    name: "Plaintext tabular text gate",
    provider: "openai",
    model: "gpt-safe",
  });
  const assistantJobId = "00000000-0000-4000-8000-000000000196";
  const workflowJobId = "00000000-0000-4000-8000-000000000197";
  const tabularChatJobId = "00000000-0000-4000-8000-000000000198";
  const tabularCellJobId = "00000000-0000-4000-8000-000000000199";
  const assistant = insertAssistantSnapshotJob(
    preV8,
    assistantProfile.id,
    assistantJobId,
  );
  const workflow = insertWorkflowSnapshotJob(
    preV8,
    workflowProfile.id,
    workflowJobId,
  );
  const tabular = insertTabularAssociationJob(
    preV8,
    tabularProfile.id,
    tabularChatJobId,
  );
  const tabularCell = insertTabularCellJob(
    preV8,
    tabular.reviewId,
    tabularCellJobId,
  );
  const markers = {
    assistantResult: JSON.stringify({ marker: "V8_ASSISTANT_RESULT_MARKER" }),
    assistantError: JSON.stringify({ marker: "V8_ASSISTANT_ERROR_MARKER" }),
    assistantErrorCode: "V8_ASSISTANT_ERROR_CODE_MARKER",
    assistantMessageError: "V8_ASSISTANT_MESSAGE_ERROR_MARKER",
    leaseOwner: "V8_LEASE_OWNER_MARKER",
    cancellationReason: "V8_CANCELLATION_REASON_MARKER",
    workflowJobResult: JSON.stringify({ marker: "V8_WORKFLOW_RESULT_MARKER" }),
    workflowJobError: JSON.stringify({
      marker: "V8_WORKFLOW_JOB_ERROR_MARKER",
    }),
    workflowRunError: JSON.stringify({
      marker: "V8_WORKFLOW_RUN_ERROR_MARKER",
    }),
    workflowStepError: JSON.stringify({
      marker: "V8_WORKFLOW_STEP_ERROR_MARKER",
    }),
    tabularJobResult: JSON.stringify({ marker: "V8_TABULAR_RESULT_MARKER" }),
    tabularJobError: JSON.stringify({ marker: "V8_TABULAR_JOB_ERROR_MARKER" }),
    tabularCellError: JSON.stringify({
      marker: "V8_TABULAR_CELL_ERROR_MARKER",
    }),
    sentinel: "V8_RUNTIME_TEXT_SENTINEL",
  };
  preV8
    .prepare(
      `UPDATE jobs
          SET result_json = ?, error_code = ?, error_json = ?,
              lease_owner = ?, lease_expires_at = ?, cancellation_reason = ?
        WHERE id = ?`,
    )
    .run(
      markers.assistantResult,
      markers.assistantErrorCode,
      markers.assistantError,
      markers.leaseOwner,
      now(9),
      markers.cancellationReason,
      assistantJobId,
    );
  preV8
    .prepare("UPDATE chat_messages SET error_code = ? WHERE id = ?")
    .run(markers.assistantMessageError, assistant.outputId);
  preV8
    .prepare(
      `UPDATE jobs
          SET result_json = ?, error_code = ?, error_json = ?
        WHERE id = ?`,
    )
    .run(
      markers.workflowJobResult,
      "V8_WORKFLOW_JOB_ERROR_CODE_MARKER",
      markers.workflowJobError,
      workflowJobId,
    );
  preV8
    .prepare(
      "UPDATE workflow_runs SET error_code = ?, error_json = ? WHERE id = ?",
    )
    .run(
      "V8_WORKFLOW_RUN_ERROR_CODE_MARKER",
      markers.workflowRunError,
      workflow.runId,
    );
  preV8
    .prepare(
      "UPDATE workflow_step_runs SET error_code = ?, error_json = ? WHERE id = ?",
    )
    .run(
      "V8_WORKFLOW_STEP_ERROR_CODE_MARKER",
      markers.workflowStepError,
      workflow.stepId,
    );
  preV8
    .prepare(
      `UPDATE jobs
          SET result_json = ?, error_code = ?, error_json = ?
        WHERE id = ?`,
    )
    .run(
      markers.tabularJobResult,
      "V8_TABULAR_JOB_ERROR_CODE_MARKER",
      markers.tabularJobError,
      tabularCellJobId,
    );
  preV8
    .prepare(
      "UPDATE tabular_cells SET error_code = ?, error_json = ? WHERE id = ?",
    )
    .run(
      "V8_TABULAR_CELL_ERROR_CODE_MARKER",
      markers.tabularCellError,
      tabularCell.cellId,
    );
  preV8.exec("CREATE TABLE v8_runtime_text_sentinel (value TEXT NOT NULL)");
  preV8
    .prepare("INSERT INTO v8_runtime_text_sentinel (value) VALUES (?)")
    .run(markers.sentinel);
  preV8.close();

  const beforeArtifacts = new Map(
    databaseArtifactPaths(databasePath).map((artifactPath) => [
      path.basename(artifactPath),
      readFileSync(artifactPath),
    ]),
  );
  assert.throws(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: FULL_MIGRATIONS,
      }),
    /npm run migrate:aletheia:sqlcipher --prefix backend/,
  );
  const afterArtifacts = new Map(
    databaseArtifactPaths(databasePath).map((artifactPath) => [
      path.basename(artifactPath),
      readFileSync(artifactPath),
    ]),
  );
  assert.deepEqual([...afterArtifacts.keys()], [...beforeArtifacts.keys()]);
  for (const [name, before] of beforeArtifacts) {
    assert.equal(afterArtifacts.get(name)?.equals(before), true, name);
  }

  const unchanged = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  assert.equal(unchanged.migration?.currentVersion, 7);
  assert.deepEqual(
    {
      ...unchanged
        .prepare(
          `SELECT result_json, error_code, error_json, lease_owner,
                  cancellation_reason
             FROM jobs WHERE id = ?`,
        )
        .get(assistantJobId),
    },
    {
      result_json: markers.assistantResult,
      error_code: markers.assistantErrorCode,
      error_json: markers.assistantError,
      lease_owner: markers.leaseOwner,
      cancellation_reason: markers.cancellationReason,
    },
  );
  assert.deepEqual(
    {
      ...unchanged
        .prepare(
          "SELECT error_code, error_json FROM workflow_runs WHERE id = ?",
        )
        .get(workflow.runId),
    },
    {
      error_code: "V8_WORKFLOW_RUN_ERROR_CODE_MARKER",
      error_json: markers.workflowRunError,
    },
  );
  assert.deepEqual(
    {
      ...unchanged
        .prepare(
          "SELECT error_code, error_json FROM tabular_cells WHERE id = ?",
        )
        .get(tabularCell.cellId),
    },
    {
      error_code: "V8_TABULAR_CELL_ERROR_CODE_MARKER",
      error_json: markers.tabularCellError,
    },
  );
  assert.equal(
    unchanged.prepare("SELECT value FROM v8_runtime_text_sentinel").get()
      ?.value,
    markers.sentinel,
  );
  unchanged.close();
}

async function auditV8PhysicalCredentialEncryptionGate() {
  const databasePath = path.join(root, "migration-v8-physical-gate.db");
  const preV8 = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  preV8.exec("PRAGMA secure_delete = OFF");
  const markers = Array.from(
    { length: 80 },
    (_, index) =>
      `V8_RAW_CREDENTIAL_${String(index).padStart(3, "0")}_${"x".repeat(1000)}`,
  );
  const insert = preV8.prepare(
    `INSERT INTO model_profiles
      (id, name, provider, model, credential_ref, credential_status,
       is_default, enabled)
     VALUES (?, ?, 'openai', 'gpt-legacy', ?, 'configured', 0, 1)`,
  );
  for (const [index, marker] of markers.entries()) {
    insert.run(
      `00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
      `Physical credential ${index}`,
      marker,
    );
  }
  const sentinel = "V8_PLAINTEXT_SENTINEL_MUST_SURVIVE";
  preV8.exec("CREATE TABLE v8_plaintext_gate_sentinel (value TEXT NOT NULL)");
  preV8
    .prepare("INSERT INTO v8_plaintext_gate_sentinel (value) VALUES (?)")
    .run(sentinel);
  preV8.close();

  const beforeBytes = readFileSync(databasePath);
  assert.equal(beforeBytes.includes(Buffer.from(markers[42])), true);
  assert.throws(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: FULL_MIGRATIONS,
      }),
    /npm run migrate:aletheia:sqlcipher --prefix backend/,
  );
  assert.equal(readFileSync(databasePath).equals(beforeBytes), true);

  const unchanged = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  assert.equal(unchanged.migration?.currentVersion, 7);
  assert.equal(
    unchanged
      .prepare("PRAGMA table_info(model_profiles)")
      .all()
      .some((row) => row.name === "credential_origin"),
    false,
  );
  assert.equal(
    unchanged
      .prepare("SELECT credential_ref FROM model_profiles WHERE id = ?")
      .get("00000000-0000-4000-8001-000000000043")?.credential_ref,
    markers[42],
  );
  assert.equal(
    unchanged.prepare("SELECT value FROM v8_plaintext_gate_sentinel").get()
      ?.value,
    sentinel,
  );
  unchanged.close();
  const plaintextArtifacts = Buffer.concat(
    databaseArtifactPaths(databasePath).map((artifactPath) =>
      readFileSync(artifactPath),
    ),
  );
  assert.equal(plaintextArtifacts.includes(Buffer.from(markers[42])), true);

  migrateAuditDatabaseToSqlcipher(databasePath, "physical-gate", [
    markers[0],
    markers[42],
    markers[79],
    sentinel,
  ]);
  assert.throws(
    () =>
      withSqlcipherEnvironment(
        randomBytes(32),
        () =>
          new WorkspaceDatabase(databasePath, {
            migrations: FULL_MIGRATIONS,
          }),
      ),
    /Unable to open the required SQLCipher database/,
  );
  assert.throws(
    () =>
      withSqlcipherEnvironment(
        null,
        () =>
          new WorkspaceDatabase(databasePath, {
            migrations: FULL_MIGRATIONS,
          }),
      ),
    /database key/i,
  );

  const migrated = openSqlcipherWorkspaceDatabase(
    databasePath,
    FULL_MIGRATIONS,
  );
  assert.equal(migrated.migration?.currentVersion, 8);
  assert.equal(migrated.migration?.capabilities.sqlcipherEncrypted, true);
  assert.equal(migrated.status().encrypted, true);
  assert.equal(
    migrated
      .prepare(
        "SELECT count(*) AS count FROM model_profiles WHERE credential_ref IS NOT NULL",
      )
      .get()?.count,
    0,
  );
  migrated.close();

  const encryptedArtifacts = Buffer.concat(
    databaseArtifactPaths(databasePath).map((artifactPath) =>
      readFileSync(artifactPath),
    ),
  );
  for (const marker of [...markers, sentinel]) {
    assert.equal(encryptedArtifacts.includes(Buffer.from(marker)), false);
  }
  assert.throws(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: FULL_MIGRATIONS,
      }),
    /database|file is not a database/i,
  );
}

async function auditMigrationBackfill() {
  const databasePath = path.join(root, "migration-v8.db");
  const legacy = new WorkspaceDatabase(databasePath, {
    migrations: [INITIAL_WORKSPACE_MIGRATION],
  });
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000201",
      "Opaque OpenAI",
      "openai",
      "gpt-4.1",
      null,
      "keychain://vera/model-profile/00000000-0000-4000-8000-000000000201/0000000000000001",
      "configured",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000202",
      "Legacy secret",
      "openai",
      "gpt-4.1",
      null,
      "sk-live-legacy-secret",
      "configured",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000203",
      "Unbound compatible",
      "openai_compatible",
      "proxy",
      null,
      "keychain://vera/model-profile/00000000-0000-4000-8000-000000000203/0000000000000002",
      "configured",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000204",
      "Proxy",
      "openai_compatible",
      "proxy",
      "https://proxy.example.com/v1?unsafe=1#hash",
      "keychain://vera/model-profile/00000000-0000-4000-8000-000000000204/0000000000000003",
      "unavailable",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000205",
      "Invalid secret URL",
      "openai_compatible",
      "proxy",
      "https://user:pass@proxy.example.com/v1?token=secret",
      null,
      "not_configured",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000207",
      "Localhost dot",
      "openai_compatible",
      "proxy",
      "https://localhost./v1",
      null,
      "not_configured",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000208",
      "Localhost suffix",
      "openai_compatible",
      "proxy",
      "https://foo.localhost/v1",
      null,
      "not_configured",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000209",
      "IPv6 documentation range",
      "openai_compatible",
      "proxy",
      "https://[2001:db8::1]/v1",
      null,
      "not_configured",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000210",
      "Status-only credential evidence",
      "openai_compatible",
      "proxy",
      "https://proxy.example.com/v1",
      null,
      "configured",
    );
  legacy
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref, credential_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000211",
      "No credential evidence",
      "openai_compatible",
      "proxy",
      "https://clean.example.com/v1",
      null,
      "not_configured",
    );
  legacy
    .prepare("UPDATE model_profiles SET is_default = 1 WHERE id = ?")
    .run("00000000-0000-4000-8000-000000000201");
  legacy
    .prepare(
      "UPDATE workspace_settings SET default_model_profile_id = ?, updated_at = ? WHERE id = 'workspace'",
    )
    .run("00000000-0000-4000-8000-000000000201", now(1));
  legacy
    .prepare(
      `INSERT INTO projects
        (id, name, default_model_profile_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000206",
      "Legacy project",
      "00000000-0000-4000-8000-000000000204",
      now(1),
      now(1),
    );
  legacy.close();
  migrateAuditDatabaseToSqlcipher(databasePath, "migration-backfill", [
    "sk-live-legacy-secret",
  ]);

  const migrated = openSqlcipherWorkspaceDatabase(
    databasePath,
    FULL_MIGRATIONS,
  );
  const rows = migrated
    .prepare(
      `SELECT id, base_url, credential_ref, credential_origin, credential_state,
              migration_issue_code, enabled, is_default
         FROM model_profiles
        ORDER BY id`,
    )
    .all();
  const row = (id: string) => rows.find((value) => value.id === id)!;
  for (const value of rows) {
    assert.equal(value.enabled, 0);
    assert.equal(value.is_default, 0);
  }
  assert.equal(
    row("00000000-0000-4000-8000-000000000201").credential_ref,
    null,
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000201").credential_origin,
    null,
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000201").credential_state,
    "missing",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000201").migration_issue_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000202").credential_ref,
    null,
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000202").credential_state,
    "missing",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000202").migration_issue_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000203").credential_origin,
    null,
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000203").credential_ref,
    null,
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000203").credential_state,
    "missing",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000203").migration_issue_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(row("00000000-0000-4000-8000-000000000204").base_url, null);
  assert.equal(
    row("00000000-0000-4000-8000-000000000204").credential_state,
    "missing",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000204").credential_ref,
    null,
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000204").credential_origin,
    null,
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000204").migration_issue_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(row("00000000-0000-4000-8000-000000000205").base_url, null);
  assert.equal(
    row("00000000-0000-4000-8000-000000000205").credential_ref,
    null,
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000205").migration_issue_code,
    null,
  );
  assert.equal(row("00000000-0000-4000-8000-000000000207").base_url, null);
  assert.equal(row("00000000-0000-4000-8000-000000000208").base_url, null);
  assert.equal(row("00000000-0000-4000-8000-000000000209").base_url, null);
  assert.equal(
    row("00000000-0000-4000-8000-000000000210").base_url,
    "https://proxy.example.com/v1",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000210").migration_issue_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000211").base_url,
    "https://clean.example.com/v1",
  );
  assert.equal(
    row("00000000-0000-4000-8000-000000000211").migration_issue_code,
    null,
  );
  assert.deepEqual(
    migrated
      .prepare(
        `SELECT profile_id
           FROM model_profile_credential_orphan_cleanups
          WHERE profile_id IN (?, ?)
          ORDER BY profile_id`,
      )
      .all(
        "00000000-0000-4000-8000-000000000210",
        "00000000-0000-4000-8000-000000000211",
      ),
    [],
  );
  assert.equal(
    migrated
      .prepare(
        "SELECT default_model_profile_id FROM workspace_settings WHERE id = 'workspace'",
      )
      .get()?.default_model_profile_id ?? null,
    null,
  );
  assert.equal(
    migrated
      .prepare("SELECT default_model_profile_id FROM projects WHERE id = ?")
      .get("00000000-0000-4000-8000-000000000206")?.default_model_profile_id ??
      null,
    null,
  );
  migrated.close();
}

async function auditV8MigrationActiveWorkReconciliation() {
  const databasePath = path.join(root, "migration-v8-active-work.db");
  const preV8 = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V8_MIGRATIONS,
  });
  const store = new AuditCredentialStore();
  const { modelService, profiles } = createServices(
    preV8,
    store,
    false,
    new UpdatingResources(preV8),
  );
  const assistantProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000501",
    name: "Assistant active",
    provider: "openai",
    model: "gpt-4.1",
  });
  profiles.setDefault(assistantProfile.id, now(5));
  profiles.setCredentialReferenceInternal(
    assistantProfile.id,
    buildStoredCredentialReference(assistantProfile.id, "0000000000000501"),
    "configured",
    now(5),
  );
  const assistant = insertAssistantSnapshotJob(
    preV8,
    assistantProfile.id,
    "00000000-0000-4000-8000-000000000511",
  );

  const workflowProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000502",
    name: "Workflow active",
    provider: "openai",
    model: "gpt-4.1",
  });
  profiles.setCredentialReferenceInternal(
    workflowProfile.id,
    buildStoredCredentialReference(workflowProfile.id, "0000000000000502"),
    "configured",
    now(5),
  );
  preV8
    .prepare(
      `INSERT INTO projects
        (id, name, default_model_profile_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000520",
      "Workflow project",
      workflowProfile.id,
      now(5),
      now(5),
    );
  const workflow = insertWorkflowSnapshotJob(
    preV8,
    workflowProfile.id,
    "00000000-0000-4000-8000-000000000512",
  );

  const tabularProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000503",
    name: "Tabular active",
    provider: "openai",
    model: "gpt-4.1",
  });
  profiles.setCredentialReferenceInternal(
    tabularProfile.id,
    buildStoredCredentialReference(tabularProfile.id, "0000000000000503"),
    "configured",
    now(5),
  );
  const tabular = insertTabularAssociationJob(
    preV8,
    tabularProfile.id,
    "00000000-0000-4000-8000-000000000513",
  );
  const tabularCell = insertTabularCellJob(
    preV8,
    tabular.reviewId,
    "00000000-0000-4000-8000-000000000531",
  );

  const assistantNoCredentialProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000504",
    name: "Assistant active no credential",
    provider: "openai",
    model: "gpt-4.1",
  });
  const assistantNoCredential = insertAssistantSnapshotJob(
    preV8,
    assistantNoCredentialProfile.id,
    "00000000-0000-4000-8000-000000000514",
  );

  const workflowNoCredentialProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000505",
    name: "Workflow active no credential",
    provider: "openai",
    model: "gpt-4.1",
  });
  const workflowNoCredential = insertWorkflowSnapshotJob(
    preV8,
    workflowNoCredentialProfile.id,
    "00000000-0000-4000-8000-000000000515",
  );

  const tabularNoCredentialProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000506",
    name: "Tabular active no credential",
    provider: "openai",
    model: "gpt-4.1",
  });
  const tabularNoCredential = insertTabularAssociationJob(
    preV8,
    tabularNoCredentialProfile.id,
    "00000000-0000-4000-8000-000000000516",
  );
  const deletedAssistantProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000507",
    name: "Assistant deleted active",
    provider: "openai",
    model: "gpt-4.1",
  });
  const deletedAssistant = insertAssistantSnapshotJob(
    preV8,
    deletedAssistantProfile.id,
    "00000000-0000-4000-8000-000000000532",
  );
  const deletedWorkflowProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000508",
    name: "Workflow deleted active",
    provider: "openai",
    model: "gpt-4.1",
  });
  const deletedWorkflow = insertWorkflowSnapshotJob(
    preV8,
    deletedWorkflowProfile.id,
    "00000000-0000-4000-8000-000000000533",
  );
  const deletedTabularProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000509",
    name: "Tabular deleted active",
    provider: "openai",
    model: "gpt-4.1",
  });
  const deletedTabular = insertTabularAssociationJob(
    preV8,
    deletedTabularProfile.id,
    "00000000-0000-4000-8000-000000000534",
  );
  const deletedTabularCell = insertTabularCellJob(
    preV8,
    deletedTabular.reviewId,
    "00000000-0000-4000-8000-000000000535",
  );
  preV8
    .prepare("UPDATE tabular_review_chats SET job_id = NULL WHERE id = ?")
    .run(deletedTabular.chatId);
  preV8
    .prepare("DELETE FROM model_profiles WHERE id IN (?, ?, ?)")
    .run(
      deletedAssistantProfile.id,
      deletedWorkflowProfile.id,
      deletedTabularProfile.id,
    );

  const localWorkflow = insertWorkflowSnapshotJob(
    preV8,
    null,
    "00000000-0000-4000-8000-000000000536",
  );
  const orphanAssistantProfile = insertLegacyProfile(profiles, {
    id: "00000000-0000-4000-8000-000000000510",
    name: "Assistant orphan pending output",
    provider: "openai",
    model: "gpt-4.1",
  });
  const orphanAssistant = insertAssistantSnapshotJob(
    preV8,
    orphanAssistantProfile.id,
    "00000000-0000-4000-8000-000000000538",
  );
  preV8
    .prepare("UPDATE jobs SET status = 'complete', updated_at = ? WHERE id = ?")
    .run(now(6), "00000000-0000-4000-8000-000000000538");

  preV8
    .prepare(
      `INSERT INTO tabular_reviews
        (id, project_id, workflow_id, model_profile_id, title, status,
         document_ids_json, columns_config_json, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, 'Dormant draft review', 'draft', '[]', '[]', ?, ?)`,
    )
    .run(
      "00000000-0000-4000-8000-000000000540",
      tabularNoCredentialProfile.id,
      now(6),
      now(6),
    );
  preV8
    .prepare(
      `INSERT INTO tabular_reviews
        (id, project_id, workflow_id, model_profile_id, title, status,
         document_ids_json, columns_config_json, created_at, updated_at)
       VALUES (?, NULL, NULL, NULL, 'Dormant ready review', 'ready', '[]', '[]', ?, ?)`,
    )
    .run("00000000-0000-4000-8000-000000000541", now(6), now(6));
  insertJob(preV8, {
    id: "00000000-0000-4000-8000-000000000537",
    type: "document_parse",
    resourceType: "document",
    resourceId: deletedTabularCell.documentId,
    status: "queued",
  });
  preV8.close();
  migrateAuditDatabaseToSqlcipher(databasePath, "migration-active-work");

  const migrated = openSqlcipherWorkspaceDatabase(
    databasePath,
    FULL_MIGRATIONS,
  );
  const migratedProfiles = new ModelProfilesRepository(migrated);
  const interruptedJob = (id: string) =>
    ({
      ...(migrated
        .prepare("SELECT status, error_code FROM jobs WHERE id = ?")
        .get(id) as Record<string, unknown>),
    }) as { status: string; error_code: string | null };
  const assistantMessage = {
    ...(migrated
      .prepare("SELECT status, error_code FROM chat_messages WHERE id = ?")
      .get(assistant.outputId) as Record<string, unknown>),
  };
  const workflowRun = {
    ...(migrated
      .prepare("SELECT status, error_code FROM workflow_runs WHERE id = ?")
      .get(workflow.runId) as Record<string, unknown>),
  };
  const workflowStep = {
    ...(migrated
      .prepare("SELECT status, error_code FROM workflow_step_runs WHERE id = ?")
      .get(workflow.stepId) as Record<string, unknown>),
  };
  const tabularReview = {
    ...(migrated
      .prepare("SELECT status FROM tabular_reviews WHERE id = ?")
      .get(tabular.reviewId) as Record<string, unknown>),
  };
  const tabularMessage = {
    ...(migrated
      .prepare("SELECT status FROM tabular_review_chat_messages WHERE id = ?")
      .get(tabular.messageId) as Record<string, unknown>),
  };
  const tabularCellRow = {
    ...(migrated
      .prepare("SELECT status, error_code FROM tabular_cells WHERE id = ?")
      .get(tabularCell.cellId) as Record<string, unknown>),
  };
  const assistantNoCredentialMessage = {
    ...(migrated
      .prepare("SELECT status, error_code FROM chat_messages WHERE id = ?")
      .get(assistantNoCredential.outputId) as Record<string, unknown>),
  };
  const workflowNoCredentialRun = {
    ...(migrated
      .prepare("SELECT status, error_code FROM workflow_runs WHERE id = ?")
      .get(workflowNoCredential.runId) as Record<string, unknown>),
  };
  const workflowNoCredentialStep = {
    ...(migrated
      .prepare("SELECT status, error_code FROM workflow_step_runs WHERE id = ?")
      .get(workflowNoCredential.stepId) as Record<string, unknown>),
  };
  const tabularNoCredentialReview = {
    ...(migrated
      .prepare("SELECT status FROM tabular_reviews WHERE id = ?")
      .get(tabularNoCredential.reviewId) as Record<string, unknown>),
  };
  const tabularNoCredentialMessage = {
    ...(migrated
      .prepare("SELECT status FROM tabular_review_chat_messages WHERE id = ?")
      .get(tabularNoCredential.messageId) as Record<string, unknown>),
  };
  const deletedAssistantMessage = {
    ...(migrated
      .prepare("SELECT status, error_code FROM chat_messages WHERE id = ?")
      .get(deletedAssistant.outputId) as Record<string, unknown>),
  };
  const deletedWorkflowRun = {
    ...(migrated
      .prepare("SELECT status, error_code FROM workflow_runs WHERE id = ?")
      .get(deletedWorkflow.runId) as Record<string, unknown>),
  };
  const deletedWorkflowStep = {
    ...(migrated
      .prepare("SELECT status, error_code FROM workflow_step_runs WHERE id = ?")
      .get(deletedWorkflow.stepId) as Record<string, unknown>),
  };
  const deletedTabularReview = {
    ...(migrated
      .prepare("SELECT status FROM tabular_reviews WHERE id = ?")
      .get(deletedTabular.reviewId) as Record<string, unknown>),
  };
  const deletedTabularMessage = {
    ...(migrated
      .prepare("SELECT status FROM tabular_review_chat_messages WHERE id = ?")
      .get(deletedTabular.messageId) as Record<string, unknown>),
  };
  const deletedTabularCellRow = {
    ...(migrated
      .prepare("SELECT status, error_code FROM tabular_cells WHERE id = ?")
      .get(deletedTabularCell.cellId) as Record<string, unknown>),
  };
  const localWorkflowRun = {
    ...(migrated
      .prepare("SELECT status, error_code FROM workflow_runs WHERE id = ?")
      .get(localWorkflow.runId) as Record<string, unknown>),
  };
  const localWorkflowStep = {
    ...(migrated
      .prepare("SELECT status, error_code FROM workflow_step_runs WHERE id = ?")
      .get(localWorkflow.stepId) as Record<string, unknown>),
  };
  const documentParseJob = interruptedJob(
    "00000000-0000-4000-8000-000000000537",
  );
  const orphanAssistantMessage = {
    ...(migrated
      .prepare("SELECT status, error_code FROM chat_messages WHERE id = ?")
      .get(orphanAssistant.outputId) as Record<string, unknown>),
  };
  const dormantDraftReview = {
    ...(migrated
      .prepare("SELECT status FROM tabular_reviews WHERE id = ?")
      .get("00000000-0000-4000-8000-000000000540") as Record<string, unknown>),
  };
  const dormantReadyReview = {
    ...(migrated
      .prepare("SELECT status FROM tabular_reviews WHERE id = ?")
      .get("00000000-0000-4000-8000-000000000541") as Record<string, unknown>),
  };
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000511").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000511").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(assistantMessage.status, "interrupted");
  assert.equal(
    assistantMessage.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000512").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000512").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(workflowRun.status, "interrupted");
  assert.equal(
    workflowRun.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(workflowStep.status, "interrupted");
  assert.equal(
    workflowStep.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000513").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000513").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(tabularReview.status, "failed");
  assert.equal(tabularMessage.status, "interrupted");
  assert.equal(tabularCellRow.status, "failed");
  assert.equal(
    tabularCellRow.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000531").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000514").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000514").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(assistantNoCredentialMessage.status, "interrupted");
  assert.equal(
    assistantNoCredentialMessage.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000515").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000515").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(workflowNoCredentialRun.status, "interrupted");
  assert.equal(
    workflowNoCredentialRun.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(workflowNoCredentialStep.status, "interrupted");
  assert.equal(
    workflowNoCredentialStep.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000516").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000516").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(tabularNoCredentialReview.status, "failed");
  assert.equal(tabularNoCredentialMessage.status, "interrupted");
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000532").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000532").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(deletedAssistantMessage.status, "interrupted");
  assert.equal(
    deletedAssistantMessage.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000533").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000533").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(deletedWorkflowRun.status, "interrupted");
  assert.equal(
    deletedWorkflowRun.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(deletedWorkflowStep.status, "interrupted");
  assert.equal(
    deletedWorkflowStep.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000534").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000534").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(deletedTabularReview.status, "failed");
  assert.equal(deletedTabularMessage.status, "interrupted");
  assert.equal(deletedTabularCellRow.status, "failed");
  assert.equal(
    deletedTabularCellRow.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000535").status,
    "interrupted",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000535").error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000536").status,
    "running",
  );
  assert.equal(localWorkflowRun.status, "queued");
  assert.equal(localWorkflowRun.error_code ?? null, null);
  assert.equal(localWorkflowStep.status, "running");
  assert.equal(localWorkflowStep.error_code ?? null, null);
  assert.equal(documentParseJob.status, "queued");
  assert.equal(documentParseJob.error_code, null);
  assert.equal(orphanAssistantMessage.status, "interrupted");
  assert.equal(
    orphanAssistantMessage.error_code,
    "workspace_migration_credential_reconfiguration_required",
  );
  assert.equal(
    interruptedJob("00000000-0000-4000-8000-000000000538").status,
    "complete",
  );
  assert.equal(dormantDraftReview.status, "draft");
  assert.equal(dormantReadyReview.status, "ready");
  assert.equal(
    migrated
      .prepare(
        "SELECT default_model_profile_id FROM workspace_settings WHERE id = 'workspace'",
      )
      .get()?.default_model_profile_id ?? null,
    null,
  );
  assert.equal(
    migrated
      .prepare("SELECT default_model_profile_id FROM projects WHERE id = ?")
      .get("00000000-0000-4000-8000-000000000520")?.default_model_profile_id ??
      null,
    null,
  );
  for (const profileId of [
    assistantProfile.id,
    workflowProfile.id,
    tabularProfile.id,
    assistantNoCredentialProfile.id,
    workflowNoCredentialProfile.id,
    tabularNoCredentialProfile.id,
  ]) {
    const stored = migratedProfiles.requireStored(profileId);
    assert.equal(stored.enabled, false);
    assert.equal(stored.isDefault, false);
    assert.equal(stored.credentialState, "missing");
  }
  for (const profileId of [
    assistantNoCredentialProfile.id,
    workflowNoCredentialProfile.id,
    tabularNoCredentialProfile.id,
  ]) {
    const stored = migratedProfiles.requireStored(profileId);
    assert.equal(stored.migrationIssueCode, null);
  }
  assert.deepEqual(
    migrated
      .prepare(
        `SELECT profile_id
           FROM model_profile_credential_orphan_cleanups
          WHERE profile_id IN (?, ?, ?)
          ORDER BY profile_id`,
      )
      .all(
        assistantNoCredentialProfile.id,
        workflowNoCredentialProfile.id,
        tabularNoCredentialProfile.id,
      ),
    [],
  );
  migrated.close();
}

async function auditActiveJobCoverageAndBindingBarrier() {
  const database = createDatabase("jobs-barrier.db");
  const store = new AuditCredentialStore();
  const canceling = createServices(
    database,
    store,
    false,
    new UpdatingResources(database),
  );
  const profile = canceling.modelService.create({
    name: "Barrier profile",
    provider: "openai",
    model: "gpt-4.1",
    enabled: false,
    isDefault: false,
  });
  forceEnableProfileFixture(canceling.profiles, profile.id, 6);
  insertAssistantSnapshotJob(
    database,
    profile.id,
    "00000000-0000-4000-8000-000000000301",
  );
  insertWorkflowSnapshotJob(
    database,
    profile.id,
    "00000000-0000-4000-8000-000000000302",
  );
  insertTabularAssociationJob(
    database,
    profile.id,
    "00000000-0000-4000-8000-000000000303",
  );
  const activeJobs = canceling.profiles
    .listActiveJobsForProfile(profile.id)
    .map((job) => job.id)
    .sort();
  assert.deepEqual(activeJobs, [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
    "00000000-0000-4000-8000-000000000303",
  ]);

  const noOp = createServices(database, store, false, new NoOpResources());
  assert.throws(
    () => noOp.modelService.update(profile.id, { provider: "deepseek" }),
    /could not be rebound safely/,
  );
  const unchanged = canceling.profiles.requireStored(profile.id);
  assert.equal(unchanged.provider, "openai");
  assert.equal(unchanged.credentialState, "missing");

  const rebound = canceling.modelService.update(profile.id, {
    provider: "deepseek",
  });
  const reboundStored = canceling.profiles.requireStored(rebound.id);
  assert.equal(reboundStored.provider, "deepseek");
  assert.equal(reboundStored.credentialRef, null);
  assert.equal(reboundStored.credentialState, "missing");
  database.close();
}

async function auditLoopbackGate() {
  const database = createDatabase("loopback.db");
  const store = new AuditCredentialStore();
  const locked = createServices(database, store, false);
  assert.throws(
    () =>
      locked.modelService.create({
        name: "Bad loopback",
        provider: "openai_compatible",
        model: "proxy",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    /local-development enablement/,
  );
  assert.throws(
    () =>
      locked.modelService.create({
        name: "Bad localhost dot",
        provider: "openai_compatible",
        model: "proxy",
        baseUrl: "https://localhost./v1",
      }),
    /local-development enablement/,
  );
  assert.throws(
    () =>
      locked.modelService.create({
        name: "Bad localhost suffix",
        provider: "openai_compatible",
        model: "proxy",
        baseUrl: "https://foo.localhost/v1",
      }),
    /local-development enablement/,
  );
  assert.throws(
    () =>
      locked.modelService.create({
        name: "Bad documentation IPv6",
        provider: "openai_compatible",
        model: "proxy",
        baseUrl: "https://[2001:db8::1]/v1",
      }),
    /local-development enablement/,
  );
  const unlocked = createServices(database, store, true);
  const profile = unlocked.modelService.create({
    name: "Good loopback",
    provider: "openai_compatible",
    model: "proxy",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  assert.equal(profile.baseUrl, "http://127.0.0.1:11434/v1");
  database.close();
}

async function auditCredentialMutationsFailClosed() {
  const database = createDatabase("configure-clears-issue.db");
  const store = new AuditCredentialStore();
  const { modelService } = createServices(database, store, false);
  const profile = modelService.create({
    name: "Configure clears issue",
    provider: "openai",
    model: "gpt-4.1",
    enabled: false,
    isDefault: false,
  });
  const initialStoreCalls = store.lastReference;
  assert.throws(
    () =>
      modelService.configureCredential(profile.id, {
        secret: "clear-issue-secret",
      }),
    /Credential lifecycle mutations are unavailable/,
  );
  assert.throws(
    () =>
      modelService.configureCredential(profile.id, {
        secret: "contains\rreturn",
      }),
    /Credential lifecycle mutations are unavailable/,
  );
  assert.throws(
    () =>
      modelService.configureCredential(profile.id, {
        secret: "contains\nnewline",
      }),
    /Credential lifecycle mutations are unavailable/,
  );
  assert.throws(
    () => modelService.clearCredential(profile.id),
    /Credential lifecycle mutations are unavailable/,
  );
  assert.equal(store.lastReference, initialStoreCalls);
  database.close();
}

async function auditDormantLifecycleCrudGuards() {
  const database = createDatabase("dormant-lifecycle.db");
  const store = new AuditCredentialStore();
  const { modelService, settingsService, profiles } = createServices(
    database,
    store,
    false,
    new UpdatingResources(database),
  );
  const profile = modelService.create({
    name: "Dormant lifecycle",
    provider: "openai",
    model: "gpt-4.1",
    enabled: false,
    isDefault: false,
  });
  seedConfiguredProfileCredential({
    profiles,
    store,
    profile: { id: profile.id, provider: "openai" },
    origin: "https://api.openai.com",
    secret: "dormant-secret",
    nowAt: now(7),
  });
  forceEnableProfileFixture(profiles, profile.id, 7);
  const before = profiles.requireStored(profile.id);
  const initialDeleteCalls = store.deleteCalls.length;
  assert.throws(
    () => modelService.update(profile.id, { provider: "deepseek" }),
    /Credential lifecycle mutations are unavailable/,
  );
  const afterUpdate = profiles.requireStored(profile.id);
  assert.equal(afterUpdate.provider, before.provider);
  assert.equal(afterUpdate.credentialRef, before.credentialRef);
  const disabledByPatch = modelService.update(profile.id, { enabled: false });
  assert.equal(disabledByPatch.enabled, false);
  const afterDisablePatch = profiles.requireStored(profile.id);
  assert.equal(afterDisablePatch.credentialRef, before.credentialRef);
  assert.equal(store.deleteCalls.length, initialDeleteCalls);
  forceEnableProfileFixture(profiles, profile.id, 7);
  assert.throws(
    () => modelService.delete(profile.id),
    /Credential lifecycle mutations are unavailable/,
  );
  assert.ok(profiles.getStored(profile.id));
  assert.throws(
    () => modelService.reconcileCredentialOrphans(),
    /Credential lifecycle reconciliation is unavailable/,
  );
  assert.equal(store.deleteCalls.length, initialDeleteCalls);

  const app = express();
  app.use(express.json());
  app.use(
    "/workspace-model-settings",
    createWorkspaceSettingsV1Router({
      runtime: createRuntimePort(modelService, settingsService),
      auth: (_req, _res, next) => next(),
      context: () => ({ principalId: "audit-user" }),
    }),
  );
  await withServer(app, async (baseUrl) => {
    const patchResponse = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "deepseek" }),
      },
    );
    assert.equal(patchResponse.status, 409);
    const disablePatchResponse = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    assert.equal(disablePatchResponse.status, 200);
    forceEnableProfileFixture(profiles, profile.id, 7);
    const disablePostResponse = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}/disable`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(disablePostResponse.status, 200);
    const deleteResponse = await fetch(
      `${baseUrl}/workspace-model-settings/models/${profile.id}`,
      {
        method: "DELETE",
      },
    );
    assert.equal(deleteResponse.status, 409);
  });
  const afterHttp = profiles.requireStored(profile.id);
  assert.equal(afterHttp.provider, before.provider);
  assert.equal(afterHttp.credentialRef, before.credentialRef);
  assert.equal(store.deleteCalls.length, initialDeleteCalls);
  database.close();
}

async function auditSettingsDefaultModelDormantGate() {
  const database = createDatabase("settings-default-model-dormant.db");
  const store = new AuditCredentialStore();
  const { modelService, settingsService } = createServices(
    database,
    store,
    false,
  );
  const profile = modelService.create({
    name: "Dormant settings model",
    provider: "openai",
    model: "gpt-4.1",
    enabled: false,
    isDefault: false,
  });
  assert.throws(
    () => settingsService.update({ defaultModelProfileId: profile.id }),
    /default model selection is unavailable/,
  );
  database
    .prepare(
      "UPDATE workspace_settings SET default_model_profile_id = ?, updated_at = ? WHERE id = 'workspace'",
    )
    .run(profile.id, now(8));
  const cleared = settingsService.update({ defaultModelProfileId: null });
  assert.equal(cleared.defaultModelProfileId, null);

  const app = express();
  app.use(express.json());
  app.use(
    "/workspace-model-settings",
    createWorkspaceSettingsV1Router({
      runtime: createRuntimePort(modelService, settingsService),
      auth: (_req, _res, next) => next(),
      context: () => ({ principalId: "audit-user" }),
    }),
  );
  database
    .prepare(
      "UPDATE workspace_settings SET default_model_profile_id = ?, updated_at = ? WHERE id = 'workspace'",
    )
    .run(profile.id, now(8));
  await withServer(app, async (baseUrl) => {
    const blocked = await fetch(
      `${baseUrl}/workspace-model-settings/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ default_model_profile_id: profile.id }),
      },
    );
    assert.equal(blocked.status, 409);
    const clearedResponse = await fetch(
      `${baseUrl}/workspace-model-settings/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ default_model_profile_id: null }),
      },
    );
    assert.equal(clearedResponse.status, 200);
    const clearedBody = (await clearedResponse.json()) as WorkspaceSettingsWire;
    assert.equal(clearedBody.default_model_profile_id, null);
  });
  database.close();
}

async function auditReusedCredentialReferenceRejected() {
  const database = createDatabase("configure-same-ref.db");
  const store = new AuditCredentialStore();
  const { modelService } = createServices(database, store, false);
  const profile = modelService.create({
    name: "Same ref guard",
    provider: "openai",
    model: "gpt-4.1",
    enabled: false,
    isDefault: false,
  });
  assert.throws(
    () =>
      modelService.configureCredential(profile.id, {
        secret: "rotated-secret",
      }),
    /Credential lifecycle mutations are unavailable/,
  );
  assert.equal(store.lastReference, null);
  database.close();
}

async function auditBoundedReaderPreAbortCancelFailure() {
  const controller = new AbortController();
  controller.abort();
  const response = new Response(
    new ReadableStream({
      cancel() {
        return Promise.reject(new Error("cancel boom"));
      },
    }),
  );
  await assert.rejects(
    readBoundedResponseBody(response, 1024, { signal: controller.signal }),
    (error) =>
      error instanceof BoundedResponseBodyError && error.reason === "aborted",
  );
  assert.equal(response.body?.locked ?? false, false);
}

async function auditMigrationChecksumParity() {
  const backendRoot = realpathSync(path.resolve(__dirname, "..", ".."));
  const tscBinary = path.join(backendRoot, "node_modules", ".bin", "tsc");
  const parityRoot = mkdtempSync(path.join(root, "migration-checksum-parity-"));
  const outDir = path.join(parityRoot, "dist");
  const parityConfigPath = path.join(parityRoot, "tsconfig.json");
  const migrationFiles = [
    "src/lib/workspace/migrations/v1InitialWorkspace.ts",
    "src/lib/workspace/migrations/v2WorkspaceIntegrity.ts",
    "src/lib/workspace/migrations/v3WorkspaceRuntime.ts",
    "src/lib/workspace/migrations/v4ProjectOwnership.ts",
    "src/lib/workspace/migrations/v5AssistantRuntime.ts",
    "src/lib/workspace/migrations/v6WorkflowRuntime.ts",
    "src/lib/workspace/migrations/v7TabularMikeSemantics.ts",
    "src/lib/workspace/migrations/v8ModelCredentialOrigin.ts",
  ];
  const relativeParityConfigPath = path.relative(backendRoot, parityConfigPath);
  assert.ok(
    relativeParityConfigPath.startsWith(`..${path.sep}`) ||
      relativeParityConfigPath === "..",
    "parity config must stay outside backendRoot",
  );
  const compiledMigrationPaths = migrationFiles.map((file) =>
    path.join(
      outDir,
      path
        .relative(path.join(backendRoot, "src"), path.join(backendRoot, file))
        .replace(/\.ts$/, ".js"),
    ),
  );
  writeFileSync(
    parityConfigPath,
    `${JSON.stringify(
      {
        extends: path.join(backendRoot, "tsconfig.build.json"),
        compilerOptions: {
          noEmitOnError: false,
          rootDir: path.join(backendRoot, "src"),
          typeRoots: [path.join(backendRoot, "node_modules", "@types")],
        },
        files: migrationFiles.map((file) => path.join(backendRoot, file)),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  try {
    try {
      execFileSync(tscBinary, ["-p", parityConfigPath, "--outDir", outDir], {
        cwd: backendRoot,
        stdio: "pipe",
      });
    } catch (error) {
      if (!compiledMigrationPaths.every((file) => existsSync(file))) {
        throw error;
      }
    }
    const compiledChecksums = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `
const migrations = [
  require(${JSON.stringify(path.join(outDir, "lib/workspace/migrations/v1InitialWorkspace.js"))}).INITIAL_WORKSPACE_MIGRATION,
  require(${JSON.stringify(path.join(outDir, "lib/workspace/migrations/v2WorkspaceIntegrity.js"))}).WORKSPACE_INTEGRITY_MIGRATION,
  require(${JSON.stringify(path.join(outDir, "lib/workspace/migrations/v3WorkspaceRuntime.js"))}).WORKSPACE_RUNTIME_MIGRATION,
  require(${JSON.stringify(path.join(outDir, "lib/workspace/migrations/v4ProjectOwnership.js"))}).PROJECT_OWNERSHIP_MIGRATION,
  require(${JSON.stringify(path.join(outDir, "lib/workspace/migrations/v5AssistantRuntime.js"))}).ASSISTANT_RUNTIME_MIGRATION,
  require(${JSON.stringify(path.join(outDir, "lib/workspace/migrations/v6WorkflowRuntime.js"))}).WORKFLOW_RUNTIME_V6_MIGRATION,
  require(${JSON.stringify(path.join(outDir, "lib/workspace/migrations/v7TabularMikeSemantics.js"))}).TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  require(${JSON.stringify(path.join(outDir, "lib/workspace/migrations/v8ModelCredentialOrigin.js"))}).MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
];
process.stdout.write(JSON.stringify(migrations.map((migration) => ({
  version: migration.version,
  checksumMaterial: migration.checksumMaterial,
}))));
        `,
        ],
        {
          cwd: backendRoot,
          env: {
            ...process.env,
            NODE_PATH: [
              path.join(backendRoot, "node_modules"),
              process.env.NODE_PATH,
            ]
              .filter(Boolean)
              .join(path.delimiter),
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ) as Array<{ version: number; checksumMaterial: string }>;
    const currentChecksums = FULL_MIGRATIONS.map((migration) => ({
      version: migration.version,
      checksumMaterial: migration.checksumMaterial,
    }));
    assert.deepEqual(compiledChecksums, currentChecksums);
  } finally {
    rmSync(parityRoot, { recursive: true, force: true });
  }
}

async function auditV8ChecksumStrategyBinding() {
  const checksumMaterial =
    MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION.checksumMaterial;
  const checksum = workspaceMigrationChecksum(
    MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
  );
  const replaceFirst = (source: string, before: string, after: string) => {
    const index = source.indexOf(before);
    assert.notEqual(index, -1, `missing checksum probe target: ${before}`);
    return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
  };

  for (const forbidden of [
    "function applyModelCredentialOriginV8",
    "function sanitizeLegacyBaseUrlForMigration",
    "function reconcileImpactedAssistantWork",
    "function reconcileImpactedWorkflowWork",
    "function reconcileImpactedTabularWork",
  ]) {
    assert.equal(checksumMaterial.includes(forbidden), false);
  }

  for (const required of [
    "enabled = 0",
    "is_default = 0",
    "UPDATE workspace_settings",
    "UPDATE projects",
    "default_model_profile_id = NULL",
    "temp_v8_forced_dormant_profiles",
    "temp_v8_credential_impacted_profiles",
    "temp_v8_impacted_assistant_job_ids",
    "temp_v8_impacted_assistant_output_ids",
    "temp_v8_impacted_workflow_run_ids",
    "temp_v8_impacted_workflow_job_ids",
    "temp_v8_impacted_tabular_message_ids",
    "temp_v8_impacted_tabular_cell_ids",
    "temp_v8_impacted_tabular_review_ids",
    "temp_v8_impacted_tabular_job_ids",
    '"forcedDormantProfiles":"all profiles"',
    '"credentialImpactedProfiles":"legacy credential evidence only"',
    '"assert_encrypted_destructive_rewrite_preflight"',
    '"ensure_structural_schema"',
    '"queue_legacy_credential_orphan_cleanup"',
    '"assert_postconditions"',
    "FROM assistant_generation_snapshots snapshot",
    "snapshot.model_profile_id IS NOT NULL",
    "credential_ref IS NOT NULL",
    "coalesce(credential_status, 'not_configured') <> 'not_configured'",
    "fail_before_first_v8_ddl_or_dml",
    "aletheia-local-database-sqlcipher-connection-v1",
    '"rawPragmaResultAloneTrusted":false',
    '"nonLocalDatabaseAdapterTrusted":false',
    '"exactLocalDatabasePrototypeRequired":true',
    '"subclassTrusted":false',
    '"probeUsesCapturedOriginalPrepare":true',
    '"memoryRuntimeProbeEligibleForPersistentMigration":false',
    '"keyApplied":true',
    '"schemaReadVerified":true',
    '"persistence":"persistent"',
    '"cipherIntegrityStatus":"verified_clean"',
    '"cipherIntegrityVerified":true',
    "capability must exactly match immediate trusted same-connection re-attestation",
    "inconsistent SQLCipher connection capability",
    "npm run migrate:aletheia:sqlcipher --prefix backend",
    "job.result_json IS NOT NULL",
    "job.error_json IS NOT NULL",
    "job.lease_owner IS NOT NULL",
    "job.cancellation_reason IS NOT NULL",
    "run.error_json IS NOT NULL",
    "step.error_json IS NOT NULL",
    "message.error_code IS NOT NULL",
    "cell.error_json IS NOT NULL",
    "old !== sanitizeLegacyBaseUrlForMigration(old)",
    "credential_origin IS NOT NULL",
    "message.job_id IN (",
    "OR chat.job_id IN (",
    "review.status = 'running'",
    '"normalizeTrailingDotsPattern":"\\\\.+$"',
    '"exactHost":"localhost"',
    '"suffix":".localhost"',
    '"blockedFirstOctetGte":224',
    '"mappedIpv4Prefix":"::ffff:"',
    "2001:0*db8",
  ]) {
    assert.equal(checksumMaterial.includes(required), true, required);
  }

  const enabledMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: replaceFirst(
      checksumMaterial,
      "enabled = 0",
      "enabled = 1",
    ),
  });
  assert.notEqual(enabledMutation, checksum);

  assert.equal(
    checksumMaterial.split('"blockedFirstOctetGte":224').length - 1,
    2,
  );
  const ipv4BoundaryMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      '"blockedFirstOctetGte":224',
      '"blockedFirstOctetGte":223',
    ),
  });
  assert.notEqual(ipv4BoundaryMutation, checksum);

  const workflowSelectionMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: replaceFirst(
      checksumMaterial,
      "snapshot.model_profile_id IS NOT NULL",
      "snapshot.model_profile_id IS NULL",
    ),
  });
  assert.notEqual(workflowSelectionMutation, checksum);

  const stageOrderMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: replaceFirst(
      checksumMaterial,
      `"materialize_impacted_tabular_work","prepare_profile_tracking_temp_tables"`,
      `"prepare_profile_tracking_temp_tables","materialize_impacted_tabular_work"`,
    ),
  });
  assert.notEqual(stageOrderMutation, checksum);

  const legacyCredentialPredicate =
    "credential_ref IS NOT NULL\n         OR coalesce(credential_status, 'not_configured') <> 'not_configured'";
  assert.equal(checksumMaterial.split(legacyCredentialPredicate).length - 1, 1);
  const legacyCredentialPredicateMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: replaceFirst(
      checksumMaterial,
      legacyCredentialPredicate,
      "credential_ref IS NOT NULL\n         AND coalesce(credential_status, 'not_configured') <> 'not_configured'",
    ),
  });
  assert.notEqual(legacyCredentialPredicateMutation, checksum);

  const destructiveCredentialPredicate =
    "credential_ref IS NOT NULL\n             OR coalesce(credential_status, 'not_configured') <> 'not_configured'";
  const destructiveCredentialPredicateCount =
    checksumMaterial.split(destructiveCredentialPredicate).length - 1;
  assert.ok(destructiveCredentialPredicateCount >= 2);
  const destructiveCredentialAndMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      destructiveCredentialPredicate,
      "credential_ref IS NOT NULL\n             AND coalesce(credential_status, 'not_configured') <> 'not_configured'",
    ),
  });
  assert.notEqual(destructiveCredentialAndMutation, checksum);

  const cancellationEvidenceBranch = "OR job.cancellation_reason IS NOT NULL";
  const cancellationEvidenceBranchCount =
    checksumMaterial.split(cancellationEvidenceBranch).length - 1;
  assert.ok(cancellationEvidenceBranchCount >= 2);
  const deletedEvidenceBranchMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      cancellationEvidenceBranch,
      "OR 0 = 1",
    ),
  });
  assert.notEqual(deletedEvidenceBranchMutation, checksum);

  const gateStage = '"assert_encrypted_destructive_rewrite_preflight"';
  const gateStageCount = checksumMaterial.split(gateStage).length - 1;
  assert.ok(gateStageCount >= 2);
  const skippedGateMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      gateStage,
      '"skip_encrypted_destructive_rewrite_preflight"',
    ),
  });
  assert.notEqual(skippedGateMutation, checksum);

  const rawPragmaPolicy = '"rawPragmaResultAloneTrusted":false';
  const rawPragmaPolicyCount =
    checksumMaterial.split(rawPragmaPolicy).length - 1;
  assert.ok(rawPragmaPolicyCount >= 2);
  const rawPragmaTrustMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      rawPragmaPolicy,
      '"rawPragmaResultAloneTrusted":true',
    ),
  });
  assert.notEqual(rawPragmaTrustMutation, checksum);

  const exactPrototypePolicy = '"exactLocalDatabasePrototypeRequired":true';
  const exactPrototypePolicyCount =
    checksumMaterial.split(exactPrototypePolicy).length - 1;
  assert.ok(exactPrototypePolicyCount >= 2);
  const subclassTrustMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      exactPrototypePolicy,
      '"exactLocalDatabasePrototypeRequired":false',
    ),
  });
  assert.notEqual(subclassTrustMutation, checksum);

  const reattestationDecision =
    "capability must exactly match immediate trusted same-connection re-attestation";
  const reattestationDecisionCount =
    checksumMaterial.split(reattestationDecision).length - 1;
  assert.ok(reattestationDecisionCount >= 2);
  const skippedReattestationMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      reattestationDecision,
      "trust runner capability without same-connection re-attestation",
    ),
  });
  assert.notEqual(skippedReattestationMutation, checksum);

  const baseUrlDiffPolicy = "old !== sanitizeLegacyBaseUrlForMigration(old)";
  assert.ok(checksumMaterial.includes(baseUrlDiffPolicy));
  const baseUrlGateMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      baseUrlDiffPolicy,
      "base_url evidence disabled",
    ),
  });
  assert.notEqual(baseUrlGateMutation, checksum);

  assert.equal(
    checksumMaterial.split('"normalizeTrailingDotsPattern":"\\\\.+$"').length -
      1,
    2,
  );
  const localhostTrailingDotMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      '"normalizeTrailingDotsPattern":"\\\\.+$"',
      '"normalizeTrailingDotsPattern":"\\\\.$"',
    ),
  });
  assert.notEqual(localhostTrailingDotMutation, checksum);

  assert.equal(checksumMaterial.split('"suffix":".localhost"').length - 1, 2);
  const localhostSuffixMutation = workspaceMigrationChecksum({
    ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
    checksumMaterial: checksumMaterial.replaceAll(
      '"suffix":".localhost"',
      '"suffix":".invalid-localhost"',
    ),
  });
  assert.notEqual(localhostSuffixMutation, checksum);
}

async function auditModelGateway() {
  const store = new AuditCredentialStore();
  const profile = {
    id: "00000000-0000-4000-8000-000000000401",
    name: "Gateway profile",
    provider: "openai" as ModelProvider,
    model: "gpt-4.1",
    baseUrl: null,
    credentialStatus: "configured" as const,
    credentialRef: null as string | null,
    credentialOrigin: "https://api.openai.com",
    credentialState: "configured" as const,
    migrationIssueCode: null as string | null,
    executionRevision: 0,
    contextWindowTokens: null,
    maxOutputTokens: null,
    enabled: true,
    capabilities: {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
    },
    isDefault: false,
    createdAt: now(10),
    updatedAt: now(10),
  };
  const stored = store.store({
    binding: {
      profileId: profile.id,
      provider: profile.provider,
      canonicalOrigin: profile.credentialOrigin!,
    },
    secret: "gateway-secret",
  });
  profile.credentialRef = stored.reference;
  const expectedBinding = buildEndpointBindingSnapshot(profile, false);

  const mismatchGateway = new ModelGateway(store);
  const mismatchBinding = {
    ...expectedBinding,
    executionRevision: expectedBinding.executionRevision + 1,
  };
  store.resolveCalls = 0;
  await assert.rejects(
    mismatchGateway.request(profile, {
      method: "GET",
      pathOrUrl: "v1/models",
      expectedBinding: mismatchBinding,
    }),
    /binding changed before the provider request/,
  );
  assert.equal(store.resolveCalls, 0);

  const originMismatchGateway = new ModelGateway(store);
  store.resolveCalls = 0;
  await assert.rejects(
    originMismatchGateway.request(
      {
        ...profile,
        baseUrl: "https://api.other.example/v1",
      },
      {
        method: "GET",
        pathOrUrl: "models",
        expectedBinding,
      },
    ),
    /origin binding is stale/,
  );
  assert.equal(store.resolveCalls, 0);

  store.resolveCalls = 0;
  await assert.rejects(
    mismatchGateway.request(profile, {
      method: "GET",
      pathOrUrl: "v1/models",
      headers: { authorization: "Bearer evil" },
      expectedBinding,
    }),
    /unsupported fields/,
  );
  assert.equal(store.resolveCalls, 0);

  store.resolveCalls = 0;
  await assert.rejects(
    mismatchGateway.request(profile, {
      method: "POST",
      pathOrUrl: "v1/models",
      body: "x".repeat(MODEL_GATEWAY_HARD_MAX_REQUEST_BYTES + 1),
      contentType: "application/json",
      expectedBinding,
    }),
    /request body exceeded the allowed size/,
  );
  assert.equal(store.resolveCalls, 0);

  const loopbackGateway = new ModelGateway(store);
  await assert.rejects(
    loopbackGateway.request(
      {
        ...profile,
        baseUrl: "http://127.0.0.1:11434/v1",
        credentialOrigin: "http://127.0.0.1:11434",
        provider: "openai_compatible",
      },
      {
        method: "GET",
        pathOrUrl: "models",
        expectedBinding: buildEndpointBindingSnapshot(
          {
            ...profile,
            baseUrl: "http://127.0.0.1:11434/v1",
            credentialOrigin: "http://127.0.0.1:11434",
            provider: "openai_compatible",
          },
          true,
        ),
      },
    ),
    /local-development enablement/,
  );

  let redirectCancelled = false;
  let fetchCalls = 0;
  const redirectGateway = new ModelGateway(store, {
    fetchImpl: async (_input, init) => {
      fetchCalls += 1;
      assert.equal(init?.headers instanceof Headers, true);
      return new Response(
        new ReadableStream({
          cancel() {
            redirectCancelled = true;
          },
        }),
        {
          status: 307,
          headers: { location: "/v1/next" },
        },
      );
    },
  });
  await assert.rejects(
    redirectGateway.request(profile, {
      method: "GET",
      pathOrUrl: "v1/models",
      accept: "application/json",
      expectedBinding,
    }),
    /Model provider request failed/,
  );
  assert.equal(redirectCancelled, true);
  assert.equal(fetchCalls, 1);

  let contentLengthCancelled = false;
  const contentLengthGateway = new ModelGateway(store, {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            contentLengthCancelled = true;
          },
        }),
        {
          status: 200,
          headers: {
            "content-length": "2048",
          },
        },
      ),
  });
  await assert.rejects(
    contentLengthGateway.request(profile, {
      method: "GET",
      pathOrUrl: "v1/models",
      maxResponseBytes: 1024,
      expectedBinding,
    }),
    /response exceeded the allowed size/,
  );
  assert.equal(contentLengthCancelled, true);

  const headersGateway = new ModelGateway(store, {
    fetchImpl: async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-1",
          "set-cookie": "blocked=1",
        },
      }),
  });
  const headerResponse = await headersGateway.request(profile, {
    method: "GET",
    pathOrUrl: "v1/models",
    expectedBinding,
  });
  assert.deepEqual(Object.keys(headerResponse.headers).sort(), [
    "contentLength",
    "contentType",
    "requestId",
    "retryAfter",
  ]);
  assert.equal(headerResponse.headers.contentLength, null);
  assert.equal(headerResponse.headers.requestId, "req-1");

  let timedOut = false;
  const timeoutGateway = new ModelGateway(store, {
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener(
          "abort",
          () => {
            timedOut = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(
    timeoutGateway.request(profile, {
      method: "GET",
      pathOrUrl: "v1/models",
      timeoutMs: 20,
      expectedBinding,
    }),
    /Model provider request failed/,
  );
  assert.equal(timedOut, true);

  let streamCancelled = false;
  const hugeGateway = new ModelGateway(store, {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(MODEL_GATEWAY_HARD_MAX_RESPONSE_BYTES + 1),
            );
          },
          cancel() {
            streamCancelled = true;
          },
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(
    hugeGateway.request(profile, {
      method: "GET",
      pathOrUrl: "v1/models",
      maxResponseBytes: 1024,
      expectedBinding,
    }),
    /response exceeded the allowed size/,
  );
  assert.equal(streamCancelled, true);
}

async function main() {
  const originalEnvironment = { ...process.env };
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    await auditTrustedSqlcipherConnectionCapability();
    await auditV8PlaintextSafeStateOnlyMigration();
    await auditV8PlaintextProfileEvidenceEdges();
    await auditV8PlaintextRuntimeTextEvidenceGate();
    await auditV8PhysicalCredentialEncryptionGate();
    await auditMigrationBackfill();
    await auditV8MigrationActiveWorkReconciliation();
    await auditLoopbackGate();
    await auditCredentialMutationsFailClosed();
    await auditDormantLifecycleCrudGuards();
    await auditSettingsDefaultModelDormantGate();
    await auditReusedCredentialReferenceRejected();
    await auditBoundedReaderPreAbortCancelFailure();
    await auditMigrationChecksumParity();
    await auditV8ChecksumStrategyBinding();
    await auditActiveJobCoverageAndBindingBarrier();
    await auditModelGateway();
    await auditRouteWireAndSecretScan();
    console.log("veraWorkspaceModelSettingsAudit: ok");
  } finally {
    process.env = originalEnvironment;
    rmSync(root, { recursive: true, force: true });
    rmSync(sqlcipherBackupRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
