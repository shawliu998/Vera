import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

import {
  MikeAssistantStreamEventSchema,
  parseMikeChatGeneration,
  parseMikeProjectChatGeneration,
  toMikeChatDetail,
} from "../lib/workspace/assistantCompatibility";
import {
  WorkspaceDatabase,
  WORKSPACE_MIGRATIONS,
  runWorkspaceMigrations,
  workspaceMigrationChecksum,
  type WorkspaceDatabaseAdapter,
} from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { searchSafeFtsQuery } from "../lib/searchSafeFtsQuery";
import { ASSISTANT_RUNTIME_MIGRATION } from "../lib/workspace/migrations/v5AssistantRuntime";
import { TABULAR_MIKE_SEMANTICS_V7_MIGRATION } from "../lib/workspace/migrations/v7TabularMikeSemantics";
import { MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION } from "../lib/workspace/migrations/v8ModelCredentialOrigin";
import { MODEL_CONNECTION_READINESS_V9_MIGRATION } from "../lib/workspace/migrations/v9ModelConnectionReadiness";
import { ASSISTANT_DURABLE_EVENTS_V10_MIGRATION } from "../lib/workspace/migrations/v10AssistantDurableEvents";
import { AssistantRetrievalRepository } from "../lib/workspace/repositories/assistantRetrieval";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import {
  WorkspaceJobLeaseLostError,
  WorkspaceJobsRepository,
} from "../lib/workspace/repositories/jobs";
import {
  AssistantRuntimeService,
  type AssistantModelPort,
  type AssistantToolPort,
} from "../lib/workspace/services/assistantRuntime";
import { ChatsService } from "../lib/workspace/services/chats";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import {
  createWorkspaceChatsV1Router,
  type WorkspaceChatsV1Port,
} from "../routes/workspaceChatsV1";

const MIGRATIONS = [
  ...WORKSPACE_MIGRATIONS.filter((migration) => migration.version < 5),
  ASSISTANT_RUNTIME_MIGRATION,
] as const;
const CHECKSUM_PARITY_MIGRATIONS = [
  ...WORKSPACE_MIGRATIONS.filter((migration) => migration.version <= 6),
  TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
  MODEL_CONNECTION_READINESS_V9_MIGRATION,
  ASSISTANT_DURABLE_EVENTS_V10_MIGRATION,
] as const;
const CHECKSUM_PARITY_MODULES = [
  ["v1InitialWorkspace", "INITIAL_WORKSPACE_MIGRATION"],
  ["v2WorkspaceIntegrity", "WORKSPACE_INTEGRITY_MIGRATION"],
  ["v3WorkspaceRuntime", "WORKSPACE_RUNTIME_MIGRATION"],
  ["v4ProjectOwnership", "PROJECT_OWNERSHIP_MIGRATION"],
  ["v5AssistantRuntime", "ASSISTANT_RUNTIME_MIGRATION"],
  ["v6WorkflowRuntime", "WORKFLOW_RUNTIME_V6_MIGRATION"],
  ["v7TabularMikeSemantics", "TABULAR_MIKE_SEMANTICS_V7_MIGRATION"],
  ["v8ModelCredentialOrigin", "MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION"],
  ["v9ModelConnectionReadiness", "MODEL_CONNECTION_READINESS_V9_MIGRATION"],
  ["v10AssistantDurableEvents", "ASSISTANT_DURABLE_EVENTS_V10_MIGRATION"],
] as const;
const BACKEND_ROOT = path.resolve(__dirname, "../..");
const root = mkdtempSync(path.join(os.tmpdir(), "vera-assistant-audit-"));
const databasePath = path.join(root, "workspace.db");
const NOW = "2026-07-14T08:00:00.000Z";
const CLAIM_AT = "2026-07-14T08:01:00.000Z";
const LEASE_EXPIRES = "2026-07-14T08:10:00.000Z";
const READ_DOCUMENT_TOOL = {
  name: "read_document" as const,
  description: "Read one immutable Workspace document snapshot.",
  inputSchema: {
    type: "object",
    properties: { doc_id: { type: "string" } },
    required: ["doc_id"],
    additionalProperties: false,
  },
};

type DocumentFixture = {
  documentId: string;
  versionId: string;
  chunkId: string;
};

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertMigrationChecksumRuntimeParity() {
  assert.deepEqual(
    CHECKSUM_PARITY_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  const compiledRoot = path.join(root, "checksum-parity-commonjs");
  const tscPath = path.join(
    BACKEND_ROOT,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  execFileSync(
    process.execPath,
    [
      tscPath,
      "--outDir",
      compiledRoot,
      "--rootDir",
      "src",
      "--target",
      "ES2022",
      "--module",
      "CommonJS",
      "--moduleResolution",
      "node",
      "--strict",
      "--esModuleInterop",
      "--skipLibCheck",
      "--resolveJsonModule",
      "--types",
      "node",
      "--ignoreDeprecations",
      "5.0",
      "src/lib/workspace/migrations/runner.ts",
      ...CHECKSUM_PARITY_MODULES.map(
        ([moduleName]) => `src/lib/workspace/migrations/${moduleName}.ts`,
      ),
    ],
    { cwd: BACKEND_ROOT, encoding: "utf8", stdio: "pipe" },
  );
  const compiledRunnerPath = path.join(
    compiledRoot,
    "lib/workspace/migrations/runner.js",
  );
  const compiledModules = CHECKSUM_PARITY_MODULES.map(
    ([moduleName, exportName]) => ({
      path: path.join(
        compiledRoot,
        `lib/workspace/migrations/${moduleName}.js`,
      ),
      exportName,
    }),
  );
  const compiledChecksums = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `
const { workspaceMigrationChecksum } = require(${JSON.stringify(compiledRunnerPath)});
const modules = ${JSON.stringify(compiledModules)};
const values = modules.map(({ path, exportName }) => {
  const migration = require(path)[exportName];
  if (!migration) throw new Error(\`compiled migration \${exportName} is missing\`);
  return {
    version: migration.version,
    checksum: workspaceMigrationChecksum(migration),
  };
});
process.stdout.write(JSON.stringify(values));
        `,
      ],
      {
        cwd: BACKEND_ROOT,
        env: {
          ...process.env,
          NODE_PATH: [
            path.join(BACKEND_ROOT, "node_modules"),
            process.env.NODE_PATH,
          ]
            .filter(Boolean)
            .join(path.delimiter),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  ) as Array<{ version: number; checksum: string }>;
  const runtimeChecksums = CHECKSUM_PARITY_MIGRATIONS.map((migration) => ({
    version: migration.version,
    checksum: workspaceMigrationChecksum(migration),
  }));
  assert.deepEqual(
    compiledChecksums,
    runtimeChecksums,
    "migration checksums differ between tsx/esbuild and one CommonJS module graph",
  );
}

function expectSqlFailure(
  operation: () => unknown,
  pattern: RegExp,
  message?: string,
) {
  assert.throws(operation, pattern, message);
}

function insertProject(database: WorkspaceDatabase, name: string) {
  const id = randomUUID();
  database
    .prepare(
      "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES (?,?,'active',?,?)",
    )
    .run(id, name, NOW, NOW);
  return id;
}

function insertProfile(database: WorkspaceDatabase, name: string) {
  const id = randomUUID();
  const readinessInstalled = Boolean(
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='model_profile_connection_tests'",
      )
      .get(),
  );
  if (readinessInstalled) {
    const profiles = new ModelProfilesRepository(database);
    profiles.create({
      id,
      name,
      provider: "openai_compatible",
      model: `${name}-model`,
      baseUrl: "https://model-audit.example/v1",
      credentialOrigin: "https://model-audit.example",
      credentialState: "missing",
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_096,
      enabled: false,
      isDefault: false,
      capabilities: {
        streaming: true,
        toolCalling: false,
        structuredOutput: true,
        vision: false,
      },
      now: NOW,
    });
    markProfileReady(database, id);
    return id;
  }
  database
    .prepare(
      `INSERT INTO model_profiles
        (id,name,provider,model,credential_status,capabilities_json,settings_json,
         enabled,is_default,created_at,updated_at)
       VALUES (?,?,'openai_compatible',?,'configured',?,'{}',1,0,?,?)`,
    )
    .run(
      id,
      name,
      `${name}-model`,
      JSON.stringify({
        streaming: true,
        toolCalling: false,
        structuredOutput: true,
        vision: false,
      }),
      NOW,
      NOW,
    );
  return id;
}

function markProfileReady(database: WorkspaceDatabase, id: string) {
  const profiles = new ModelProfilesRepository(database);
  const stored = profiles.requireStored(id);
  const result = new ModelConnectionTestsRepository(database).storeIfCurrent({
    profileId: id,
    expectedConnectionRevision: stored.connectionRevision,
    status: "passed",
    errorCode: null,
    retryable: false,
    latencyMs: 1,
    testedAt: NOW,
  });
  assert.equal(result.stored, true);
  profiles.update(id, { enabled: true, now: NOW });
  const privacyInstalled = Boolean(
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='model_profile_privacy'",
      )
      .get(),
  );
  if (privacyInstalled) {
    const privacy = new ModelProfilePrivacyRepository(database);
    if (!privacy.get(id)) {
      privacy.declare(
        id,
        {
          executionLocation: "local",
          retention: "zero",
          trainingUse: "prohibited",
          sensitiveDataAllowed: true,
        },
        NOW,
      );
    }
  }
}

function insertDocument(
  database: WorkspaceDatabase,
  projectId: string | null,
  name: string,
  text: string,
  documentId: string = randomUUID(),
  versionNumber = 1,
): DocumentFixture {
  const versionId = randomUUID();
  const chunkId = randomUUID();
  if (versionNumber === 1) {
    database
      .prepare(
        `INSERT INTO documents
          (id,project_id,title,filename,mime_type,size_bytes,parse_status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'ready',?,?)`,
      )
      .run(
        documentId,
        projectId,
        name,
        `${name}.txt`,
        "text/plain",
        Buffer.byteLength(text),
        NOW,
        NOW,
      );
  }
  database
    .prepare(
      `INSERT INTO document_versions
       (id,document_id,version_number,source,filename,mime_type,size_bytes,
         content_sha256,storage_key,created_at)
       VALUES (?,?,?,'upload',?,?,?,?,?,?)`,
    )
    .run(
      versionId,
      documentId,
      versionNumber,
      `${name}.txt`,
      "text/plain",
      Buffer.byteLength(text),
      sha(text),
      `version-${versionId}`,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO document_chunks
        (id,document_id,version_id,ordinal,text,start_offset,end_offset,
         page_start,page_end,content_sha256,metadata_json,created_at)
       VALUES (?,?,?,?,?,0,?,1,1,?,'{}',?)`,
    )
    .run(chunkId, documentId, versionId, 0, text, text.length, sha(text), NOW);
  database
    .prepare(
      "UPDATE documents SET current_version_id=?,updated_at=? WHERE id=?",
    )
    .run(versionId, NOW, documentId);
  return { documentId, versionId, chunkId };
}

function insertAdditionalChunk(
  database: WorkspaceDatabase,
  documentId: string,
  versionId: string,
  ordinal: number,
  text: string,
) {
  const chunkId = randomUUID();
  database
    .prepare(
      `INSERT INTO document_chunks
        (id,document_id,version_id,ordinal,text,start_offset,end_offset,
         page_start,page_end,content_sha256,metadata_json,created_at)
       VALUES (?,?,?,?,?,0,?,1,1,?,'{}',?)`,
    )
    .run(
      chunkId,
      documentId,
      versionId,
      ordinal,
      text,
      text.length,
      sha(text),
      NOW,
    );
  return chunkId;
}

function payloadFor(database: WorkspaceDatabase, jobId: string) {
  const raw = database
    .prepare("SELECT payload_json FROM jobs WHERE id=?")
    .get(jobId)?.payload_json;
  assert.equal(typeof raw, "string");
  return JSON.parse(String(raw));
}

function count(
  database: WorkspaceDatabase,
  sql: string,
  ...parameters: unknown[]
) {
  return Number(database.prepare(sql).get(...parameters)?.count ?? 0);
}

async function withHttpServer(
  app: express.Express,
  operation: (baseUrl: string) => Promise<void>,
) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function run() {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
  process.env.ALETHEIA_DATABASE_KEY_SOURCE = "env";
  process.env.ALETHEIA_DATABASE_KEY_BASE64 = randomBytes(32).toString("base64");
  assertMigrationChecksumRuntimeParity();
  const v5ChecksumMaterial = ASSISTANT_RUNTIME_MIGRATION.checksumMaterial;
  assert.doesNotMatch(
    v5ChecksumMaterial,
    /function (?:containsSensitiveLegacyValue|canonicalLegacyLocator|applyAssistantRuntime)\(/,
    "v5 checksum must not depend on runtime-specific Function.toString output",
  );
  assert.match(
    v5ChecksumMaterial,
    /"orderBy":\["CASE WHEN source\.rank IS NULL THEN 1 ELSE 0 END","source\.rank ASC","source\.created_at ASC","source\.id ASC"\]/,
    "v5 checksum includes the canonical source ordering consumed by rebuild SQL",
  );
  assert.match(
    v5ChecksumMaterial,
    /"allowedKeys":\["pageStart","pageEnd","section","startOffset","endOffset"\]/,
    "v5 checksum includes canonical locator fields and bounds",
  );
  assert.match(
    v5ChecksumMaterial,
    /"stageOrder":\["select_legacy_locators_in_id_order","count_legacy_sources","rebuild_message_sources_with_canonical_citation_order"/,
    "v5 checksum includes the apply stage order consumed by the migration",
  );
  for (const sqlFragment of [
    "SELECT count(*) AS count FROM message_sources",
    "count(DISTINCT citation_ordinal) <> count(*)",
    "UPDATE message_sources SET locator_json=?,migration_issue_code=? WHERE id=?",
  ]) {
    assert.equal(
      v5ChecksumMaterial.includes(sqlFragment),
      true,
      `v5 checksum is missing static migration material: ${sqlFragment}`,
    );
  }
  const postconditionMutationProbe = {
    ...ASSISTANT_RUNTIME_MIGRATION,
    checksumMaterial: v5ChecksumMaterial.replace(
      "count(DISTINCT citation_ordinal) <> count(*)",
      "count(DISTINCT citation_ordinal) < count(*)",
    ),
  };
  const locatorBoundaryMutationProbe = {
    ...ASSISTANT_RUNTIME_MIGRATION,
    checksumMaterial: v5ChecksumMaterial.replace(
      '"maximum":500',
      '"maximum":499',
    ),
  };
  assert.notEqual(
    postconditionMutationProbe.checksumMaterial,
    v5ChecksumMaterial,
  );
  assert.notEqual(
    locatorBoundaryMutationProbe.checksumMaterial,
    v5ChecksumMaterial,
  );
  assert.notEqual(
    workspaceMigrationChecksum(postconditionMutationProbe),
    workspaceMigrationChecksum(ASSISTANT_RUNTIME_MIGRATION),
    "changing static postcondition SQL changes the v5 checksum",
  );
  assert.notEqual(
    workspaceMigrationChecksum(locatorBoundaryMutationProbe),
    workspaceMigrationChecksum(ASSISTANT_RUNTIME_MIGRATION),
    "changing a canonical locator boundary changes the v5 checksum",
  );
  const database = new WorkspaceDatabase(databasePath, { migrate: false });
  try {
    const initialMigration = runWorkspaceMigrations(
      database,
      MIGRATIONS.filter((migration) => migration.version < 5),
    );
    assert.equal(initialMigration.currentVersion, 4);
    database.exec(
      "CREATE TABLE assistant_legacy_sentinel (id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO assistant_legacy_sentinel VALUES (1,'preserve');",
    );

    const legacyChatId = randomUUID();
    const legacyQueuedJobId = randomUUID();
    const legacyRunningJobId = randomUUID();
    const legacyCompleteJobId = randomUUID();
    const legacyQueuedMessageId = randomUUID();
    const legacyRunningMessageId = randomUUID();
    const legacyCompleteMessageOne = randomUUID();
    const legacyCompleteMessageTwo = randomUUID();
    const legacyOrdinalMessage = randomUUID();
    database
      .prepare(
        `INSERT INTO chats
          (id,project_id,scope,title,status,created_at,updated_at)
         VALUES (?,NULL,'global','Legacy assistant','active',?,?)`,
      )
      .run(legacyChatId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO jobs
          (id,type,status,resource_type,resource_id,attempt,max_attempts,retryable,
           payload_json,scheduled_at,queued_at,created_at,updated_at)
         VALUES (?,'assistant_generate','queued','chat',?,0,3,1,'{}',?,?,?,?)`,
      )
      .run(legacyQueuedJobId, legacyChatId, NOW, NOW, NOW, NOW);
    database
      .prepare(
        `INSERT INTO jobs
          (id,type,status,resource_type,resource_id,attempt,max_attempts,retryable,
           payload_json,scheduled_at,queued_at,locked_at,lease_owner,
           lease_expires_at,started_at,created_at,updated_at)
         VALUES (?,'assistant_generate','running','chat',?,1,3,1,'{}',?,?,?,?,?,?,?,?)`,
      )
      .run(
        legacyRunningJobId,
        legacyChatId,
        NOW,
        NOW,
        NOW,
        "legacy-worker",
        LEASE_EXPIRES,
        NOW,
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO jobs
          (id,type,status,resource_type,resource_id,attempt,max_attempts,retryable,
           payload_json,result_json,scheduled_at,queued_at,started_at,
           completed_at,created_at,updated_at)
         VALUES (?,'assistant_generate','complete','chat',?,1,3,0,'{}',?,
                 ?,?,?,?,?,?)`,
      )
      .run(
        legacyCompleteJobId,
        legacyChatId,
        JSON.stringify({ legacy: true }),
        NOW,
        NOW,
        NOW,
        NOW,
        NOW,
        NOW,
      );
    const insertLegacyMessage = database.prepare(
      `INSERT INTO chat_messages
        (id,chat_id,sequence,role,content,status,job_id,created_at,updated_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    insertLegacyMessage.run(
      legacyQueuedMessageId,
      legacyChatId,
      0,
      "assistant",
      "queued partial content",
      "pending",
      legacyQueuedJobId,
      NOW,
      NOW,
      null,
    );
    insertLegacyMessage.run(
      legacyRunningMessageId,
      legacyChatId,
      1,
      "assistant",
      "running partial content",
      "streaming",
      legacyRunningJobId,
      NOW,
      NOW,
      null,
    );
    insertLegacyMessage.run(
      legacyCompleteMessageOne,
      legacyChatId,
      2,
      "assistant",
      "historical answer one",
      "complete",
      legacyCompleteJobId,
      NOW,
      NOW,
      NOW,
    );
    insertLegacyMessage.run(
      legacyCompleteMessageTwo,
      legacyChatId,
      3,
      "assistant",
      "historical answer two",
      "complete",
      legacyCompleteJobId,
      NOW,
      NOW,
      NOW,
    );
    insertLegacyMessage.run(
      legacyOrdinalMessage,
      legacyChatId,
      4,
      "assistant",
      "historical answer with non-canonical source ranks",
      "complete",
      null,
      NOW,
      NOW,
      NOW,
    );
    const legacyDocument = insertDocument(
      database,
      null,
      "legacy-locator",
      "Legacy locator evidence.",
    );
    const reviewedLegacySourceId = randomUUID();
    database
      .prepare(
        `INSERT INTO message_sources
          (id,message_id,document_id,version_id,chunk_id,quote,locator_json,rank,created_at)
         VALUES (?,?,?,?,?,?,?,0,?)`,
      )
      .run(
        reviewedLegacySourceId,
        legacyCompleteMessageOne,
        legacyDocument.documentId,
        legacyDocument.versionId,
        legacyDocument.chunkId,
        "reviewed legacy locator",
        JSON.stringify({
          pageStart: 1,
          pageEnd: 2,
          section: "Background",
          startOffset: 4,
          endOffset: 18,
          legacyAnchor: "x",
        }),
        NOW,
      );
    const validLegacyChunkId = insertAdditionalChunk(
      database,
      legacyDocument.documentId,
      legacyDocument.versionId,
      1,
      "Additional legacy locator evidence.",
    );
    const validLegacySourceId = randomUUID();
    database
      .prepare(
        `INSERT INTO message_sources
          (id,message_id,document_id,version_id,chunk_id,quote,locator_json,rank,created_at)
         VALUES (?,?,?,?,?,?,?,3,?)`,
      )
      .run(
        validLegacySourceId,
        legacyCompleteMessageOne,
        legacyDocument.documentId,
        legacyDocument.versionId,
        validLegacyChunkId,
        "valid locator",
        JSON.stringify({
          pageStart: 3,
          pageEnd: 4,
          section: "Analysis",
          startOffset: 1,
          endOffset: 9,
        }),
        NOW,
      );
    const invalidTypeLegacySourceId = randomUUID();
    database
      .prepare(
        `INSERT INTO message_sources
          (id,message_id,document_id,version_id,chunk_id,quote,locator_json,rank,created_at)
         VALUES (?,?,?,?,?,?,?,2,?)`,
      )
      .run(
        invalidTypeLegacySourceId,
        legacyQueuedMessageId,
        legacyDocument.documentId,
        legacyDocument.versionId,
        legacyDocument.chunkId,
        "invalid typed locator",
        JSON.stringify({ pageStart: "1", section: ["not", "text"] }),
        NOW,
      );
    const unsafeLegacySourceId = randomUUID();
    database
      .prepare(
        `INSERT INTO message_sources
          (id,message_id,document_id,version_id,chunk_id,quote,locator_json,rank,created_at)
         VALUES (?,?,?,?,?,?,?,1,?)`,
      )
      .run(
        unsafeLegacySourceId,
        legacyCompleteMessageTwo,
        legacyDocument.documentId,
        legacyDocument.versionId,
        legacyDocument.chunkId,
        "unsafe locator",
        JSON.stringify({
          pageStart: 1,
          localPath: "/Users/private/workspace.txt",
          nested: { apiKey: "sk-123456789012345678901234" },
        }),
        NOW,
      );
    const legacyOrdinalSources = [
      {
        id: "legacy-source-rank-zero",
        rank: 0,
        createdAt: NOW,
      },
      {
        id: "legacy-source-rank-one-z-early",
        rank: 1,
        createdAt: "2026-07-14T07:59:00.000Z",
      },
      {
        id: "legacy-source-rank-one-a",
        rank: 1,
        createdAt: NOW,
      },
      {
        id: "legacy-source-rank-one-b",
        rank: 1,
        createdAt: NOW,
      },
      {
        id: "legacy-source-null-a",
        rank: null,
        createdAt: NOW,
      },
      {
        id: "legacy-source-null-b",
        rank: null,
        createdAt: NOW,
      },
    ] as const;
    const insertLegacyOrdinalSource = database.prepare(
      `INSERT INTO message_sources
        (id,message_id,document_id,version_id,chunk_id,quote,locator_json,rank,created_at)
       VALUES (?,?,?,?,?,?,'{}',?,?)`,
    );
    for (const [index, source] of legacyOrdinalSources.entries()) {
      const text = `Canonical legacy citation evidence ${index}.`;
      const chunkId = insertAdditionalChunk(
        database,
        legacyDocument.documentId,
        legacyDocument.versionId,
        10 + index,
        text,
      );
      insertLegacyOrdinalSource.run(
        source.id,
        legacyOrdinalMessage,
        legacyDocument.documentId,
        legacyDocument.versionId,
        chunkId,
        text,
        source.rank,
        source.createdAt,
      );
    }

    const migrated = runWorkspaceMigrations(database, MIGRATIONS);
    assert.equal(migrated.currentVersion, 5);
    assert.deepEqual(
      migrated.applied.map((migration) => migration.version),
      [5],
    );
    assert.throws(
      () =>
        runWorkspaceMigrations(database, [
          ...MIGRATIONS.slice(0, -1),
          postconditionMutationProbe,
        ]),
      /checksum drift/i,
      "an applied v5 database rejects same-version executable logic drift",
    );
    assert.equal(
      database
        .prepare("SELECT value FROM assistant_legacy_sentinel WHERE id=1")
        .get()?.value,
      "preserve",
    );
    for (const jobId of [legacyQueuedJobId, legacyRunningJobId]) {
      const row = database
        .prepare(
          `SELECT status,retryable,error_code,error_json,locked_at,lease_owner,
                  lease_expires_at,completed_at,updated_at
             FROM jobs WHERE id=?`,
        )
        .get(jobId);
      assert.equal(row?.status, "interrupted");
      assert.equal(row?.retryable, 0);
      assert.equal(
        row?.error_code,
        "workspace_migration_assistant_snapshot_required",
      );
      assert.equal(row?.locked_at, null);
      assert.equal(row?.lease_owner, null);
      assert.equal(row?.lease_expires_at, null);
      assert.equal(typeof row?.completed_at, "string");
      assert.equal(typeof row?.updated_at, "string");
      assert.equal(
        JSON.parse(String(row?.error_json)).code,
        "workspace_migration_assistant_snapshot_required",
      );
    }
    assert.deepEqual(
      database
        .prepare(
          "SELECT status,error_code,content FROM chat_messages WHERE id IN (?,?) ORDER BY sequence",
        )
        .all(legacyQueuedMessageId, legacyRunningMessageId)
        .map((row) => ({
          status: row.status,
          error_code: row.error_code,
          content: row.content,
        })),
      [
        {
          status: "interrupted",
          error_code: "workspace_migration_assistant_snapshot_required",
          content: "queued partial content",
        },
        {
          status: "interrupted",
          error_code: "workspace_migration_assistant_snapshot_required",
          content: "running partial content",
        },
      ],
    );
    const legacyCompleteJob = database
      .prepare("SELECT status,result_json FROM jobs WHERE id=?")
      .get(legacyCompleteJobId);
    assert.equal(legacyCompleteJob?.status, "complete");
    assert.deepEqual(JSON.parse(String(legacyCompleteJob?.result_json)), {
      legacy: true,
    });
    assert.equal(
      count(
        database,
        "SELECT count(*) AS count FROM chat_messages WHERE job_id=? AND status='complete'",
        legacyCompleteJobId,
      ),
      2,
      "legacy jobs may retain multiple readable messages without a global job_id UNIQUE",
    );
    const canonicalLegacyCitations = database
      .prepare(
        `SELECT id,rank,citation_ordinal,citation_metadata_json,filename_snapshot
           FROM message_sources
          WHERE message_id=?
          ORDER BY citation_ordinal`,
      )
      .all(legacyOrdinalMessage);
    assert.deepEqual(
      canonicalLegacyCitations.map((row) => row.id),
      [
        "legacy-source-rank-zero",
        "legacy-source-rank-one-z-early",
        "legacy-source-rank-one-a",
        "legacy-source-rank-one-b",
        "legacy-source-null-a",
        "legacy-source-null-b",
      ],
      "legacy citation order is non-null rank ascending, NULL rank last, then created_at and id",
    );
    assert.deepEqual(
      canonicalLegacyCitations.map((row) => row.citation_ordinal),
      [0, 1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      canonicalLegacyCitations.map(
        (row) => JSON.parse(String(row.citation_metadata_json)).citationNumber,
      ),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(
      canonicalLegacyCitations.every(
        (row) => row.filename_snapshot === "legacy-locator.txt",
      ),
      true,
      "v5 captures the version filename for every migrated citation",
    );
    const reviewedLocator = database
      .prepare(
        "SELECT locator_json,migration_issue_code FROM message_sources WHERE id=?",
      )
      .get(reviewedLegacySourceId);
    assert.deepEqual(JSON.parse(String(reviewedLocator?.locator_json)), {
      pageStart: 1,
      pageEnd: 2,
      section: "Background",
      startOffset: 4,
      endOffset: 18,
    });
    assert.equal(
      reviewedLocator?.migration_issue_code,
      "workspace_migration_source_locator_requires_review",
      "unknown non-sensitive legacy fields are reported without discarding safe locator fields",
    );
    const validLocator = database
      .prepare(
        "SELECT locator_json,migration_issue_code FROM message_sources WHERE id=?",
      )
      .get(validLegacySourceId);
    assert.deepEqual(JSON.parse(String(validLocator?.locator_json)), {
      pageStart: 3,
      pageEnd: 4,
      section: "Analysis",
      startOffset: 1,
      endOffset: 9,
    });
    assert.equal(validLocator?.migration_issue_code, null);
    expectSqlFailure(
      () =>
        database
          .prepare(
            `INSERT INTO message_sources
              (id,message_id,document_id,version_id,filename_snapshot,chunk_id,quote,
               start_offset,end_offset,locator_json,
               citation_ordinal,citation_metadata_json,migration_issue_code,created_at)
             VALUES (?,?,?,?,?,?,'Additional',0,10,'{}',99,'{}',?,?)`,
          )
          .run(
            randomUUID(),
            legacyCompleteMessageOne,
            legacyDocument.documentId,
            legacyDocument.versionId,
            "legacy-locator.txt",
            validLegacyChunkId,
            "workspace_migration_source_locator_requires_review",
            NOW,
          ),
      /unsupported fields/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare(
            `INSERT INTO message_sources
              (id,message_id,document_id,version_id,filename_snapshot,chunk_id,quote,
               start_offset,end_offset,locator_json,citation_ordinal,
               citation_metadata_json,created_at)
             VALUES (?,?,?,?,?,?,'Additional',0,10,'{"startOffset":1}',99,'{}',?)`,
          )
          .run(
            randomUUID(),
            legacyCompleteMessageOne,
            legacyDocument.documentId,
            legacyDocument.versionId,
            "legacy-locator.txt",
            validLegacyChunkId,
            NOW,
          ),
      /unsupported fields/,
      "unsupported locator metadata is rejected after valid quote/offset prerequisites",
    );
    const unsafeLocator = database
      .prepare(
        "SELECT locator_json,migration_issue_code FROM message_sources WHERE id=?",
      )
      .get(unsafeLegacySourceId);
    assert.equal(unsafeLocator?.locator_json, "{}");
    assert.equal(
      unsafeLocator?.migration_issue_code,
      "workspace_migration_source_locator_redacted",
    );
    const invalidTypeLocator = database
      .prepare(
        "SELECT locator_json,migration_issue_code FROM message_sources WHERE id=?",
      )
      .get(invalidTypeLegacySourceId);
    assert.equal(invalidTypeLocator?.locator_json, "{}");
    assert.equal(
      invalidTypeLocator?.migration_issue_code,
      "workspace_migration_source_locator_redacted",
      "legacy locator values with incompatible types never enter the runtime shape",
    );

    const projectOne = insertProject(database, "Project One");
    const projectTwo = insertProject(database, "Project Two");
    const profileId = insertProfile(database, "Primary");
    const projectDocument = insertDocument(
      database,
      projectOne,
      "project-contract",
      "The governing law is New York.",
    );
    const otherDocument = insertDocument(
      database,
      projectTwo,
      "other-contract",
      "The governing law is California.",
    );
    const standaloneDocument = insertDocument(
      database,
      null,
      "standalone-contract",
      "The standalone governing law is England.",
    );

    const currentMigration = database.runMigrations(WORKSPACE_MIGRATIONS);
    assert.equal(currentMigration.currentVersion, 17);
    markProfileReady(database, profileId);

    const projects = new ProjectsRepository(database);
    const profiles = new ModelProfilesRepository(database);
    const chats = new ChatsRepository(database);
    const jobs = new WorkspaceJobsRepository(database);
    const jobService = new WorkspaceJobsService(jobs, {
      now: () => new Date(NOW),
    });
    const inferencePolicy = new WorkspaceInferencePolicy(database);
    let capabilityHydrations = 0;
    const service = new ChatsService(
      chats,
      projects,
      profiles,
      () => new Date(NOW),
      {
        jobs: jobService,
        capabilities: {
          hydrate() {
            capabilityHydrations += 1;
            return { can_read: true, can_download: true };
          },
        },
        inferencePolicy,
      },
    );
    const retrieval = new AssistantRetrievalRepository(database);
    const projectChat = service.create({
      projectId: projectOne,
      modelProfileId: profileId,
      title: "Project assistant",
    });
    const globalChat = service.create({
      modelProfileId: profileId,
      title: "Global assistant",
    });
    const oversizedProject = insertProject(database, "Oversized matter");
    for (let index = 0; index < 51; index += 1) {
      insertDocument(
        database,
        oversizedProject,
        `oversized-${index.toString().padStart(2, "0")}`,
        `Bounded project document ${index}.`,
      );
    }
    const oversizedProjectChat = service.create({
      projectId: oversizedProject,
      modelProfileId: profileId,
    });
    const oversizedCounts = {
      jobs: count(database, "SELECT count(*) AS count FROM jobs"),
      messages: count(database, "SELECT count(*) AS count FROM chat_messages"),
    };
    assert.throws(
      () =>
        service.requestGeneration({
          chatId: oversizedProjectChat.id,
          prompt: "Do not silently truncate this Project document catalog.",
        }),
      /at most 50 current documents; bounded project pagination is required/,
    );
    assert.equal(
      count(database, "SELECT count(*) AS count FROM jobs"),
      oversizedCounts.jobs,
    );
    assert.equal(
      count(database, "SELECT count(*) AS count FROM chat_messages"),
      oversizedCounts.messages,
      "oversized Project rejection rolls back before prompt/job persistence",
    );

    const projectResults = retrieval.retrieve({
      chatId: projectChat.id,
      query: "governing",
      allowedDocumentIds: [
        projectDocument.documentId,
        otherDocument.documentId,
      ],
      currentVersionOnly: true,
      limit: 20,
    });
    assert.deepEqual(
      [...new Set(projectResults.map((chunk) => chunk.documentId))],
      [projectDocument.documentId],
    );
    assert.deepEqual(
      retrieval.retrieve({
        chatId: globalChat.id,
        query: "governing",
        allowedDocumentIds: [standaloneDocument.documentId],
        currentVersionOnly: true,
        limit: 20,
      }),
      [],
      "global retrieval requires an explicit immutable attachment",
    );
    assert.throws(
      () =>
        retrieval.retrieve({
          chatId: projectChat.id,
          query: "governing",
          allowedDocumentIds: [projectDocument.documentId],
          currentVersionOnly: false,
          limit: 20,
        }),
      /current document versions/,
    );
    const failingRetrieval = (failure: Error) =>
      new AssistantRetrievalRepository({
        exec() {},
        prepare(sql) {
          return {
            run() {},
            get() {
              return sql.includes("FROM chats")
                ? {
                    id: projectChat.id,
                    project_id: projectOne,
                    scope: "project",
                  }
                : undefined;
            },
            all() {
              throw failure;
            },
          };
        },
      } satisfies WorkspaceDatabaseAdapter);
    const retrieveFromFailure = (failure: Error) =>
      failingRetrieval(failure).retrieve({
        chatId: projectChat.id,
        query: "governing",
        allowedDocumentIds: [projectDocument.documentId],
        currentVersionOnly: true,
        limit: 20,
      });
    assert.throws(
      () => retrieveFromFailure(new Error("fts5: syntax error near AND")),
      (error) =>
        error instanceof WorkspaceApiError &&
        error.status === 400 &&
        error.code === "VALIDATION_ERROR" &&
        error.message === "Assistant retrieval query cannot be processed.",
      "only recognizable FTS query syntax failures map to a client error",
    );
    assert.throws(
      () => retrieveFromFailure(new Error("disk I/O error: /private/db")),
      (error) =>
        error instanceof WorkspaceApiError &&
        error.status === 500 &&
        error.code === "INTERNAL_ERROR" &&
        error.message === "Assistant retrieval failed.",
      "unknown SQL failures are generic server errors without internal details",
    );
    assert.equal(
      searchSafeFtsQuery('governing" OR other*'),
      '"governing" AND "OR" AND "other"',
      "FTS operators and quoting are converted to literal bounded tokens",
    );
    assert.equal(
      searchSafeFtsQuery(
        "one two three four five six seven eight nine ten eleven twelve thirteen",
      ),
      '"one" AND "two" AND "three" AND "four" AND "five" AND "six" AND "seven" AND "eight" AND "nine" AND "ten" AND "eleven" AND "twelve"',
      "assistant retrieval preserves the proven twelve-token bound",
    );
    assert.deepEqual(
      retrieval.retrieve({
        chatId: projectChat.id,
        query: 'governing" OR other*',
        allowedDocumentIds: [
          projectDocument.documentId,
          otherDocument.documentId,
        ],
        currentVersionOnly: true,
        limit: 20,
      }),
      [],
      "operator-like input cannot broaden the project-scoped FTS query",
    );
    assert.equal(searchSafeFtsQuery('"*---'), null);
    assert.deepEqual(
      retrieval.retrieve({
        chatId: projectChat.id,
        query: '"*---',
        allowedDocumentIds: [projectDocument.documentId],
        currentVersionOnly: true,
        limit: 20,
      }),
      [],
      "queries without Unicode letter/number tokens return no candidates",
    );

    const multilingualDocument = insertDocument(
      database,
      projectOne,
      "multilingual-contract",
      "合同 管辖 条款 适用。",
    );
    assert.equal(
      retrieval.retrieve({
        chatId: projectChat.id,
        query: "合同 管辖",
        allowedDocumentIds: [multilingualDocument.documentId],
        currentVersionOnly: true,
        limit: 20,
      })[0]?.documentId,
      multilingualDocument.documentId,
      "Unicode legal terms use the same safe FTS tokenization",
    );

    const rankedDocument = insertDocument(
      database,
      projectOne,
      "ranked-contract",
      "governing background context without repetition",
    );
    insertAdditionalChunk(
      database,
      rankedDocument.documentId,
      rankedDocument.versionId,
      1,
      "governing governing governing governing governing",
    );
    insertAdditionalChunk(
      database,
      rankedDocument.documentId,
      rankedDocument.versionId,
      2,
      "governing governing governing governing governing",
    );
    const rankedResults = retrieval.retrieve({
      chatId: projectChat.id,
      query: "governing",
      allowedDocumentIds: [rankedDocument.documentId],
      currentVersionOnly: true,
      limit: 20,
    });
    assert.deepEqual(
      rankedResults.map((chunk) => chunk.ordinal),
      [1, 2, 0],
      "BM25 relevance is primary and ordinal is a stable tie-breaker",
    );
    assert.equal(
      rankedResults.every(
        (chunk, index) =>
          index === 0 || rankedResults[index - 1].score <= chunk.score,
      ),
      true,
    );

    const globalGeneration = service.requestGeneration({
      chatId: globalChat.id,
      prompt: "Review the standalone governing law.",
      allowedDocumentIds: [standaloneDocument.documentId],
      attachmentDocumentIds: [standaloneDocument.documentId],
    });
    assert.equal(
      count(
        database,
        "SELECT count(*) AS count FROM chat_message_attachments WHERE message_id=? AND document_id=? AND version_id=?",
        globalGeneration.promptMessageId,
        standaloneDocument.documentId,
        standaloneDocument.versionId,
      ),
      1,
    );
    assert.equal(
      retrieval.retrieve({
        chatId: globalChat.id,
        query: "governing",
        allowedDocumentIds: [standaloneDocument.documentId],
        currentVersionOnly: true,
        limit: 20,
      })[0]?.documentId,
      standaloneDocument.documentId,
    );
    jobs.requestCancellation(globalGeneration.jobId, CLAIM_AT, "audit cleanup");
    database
      .prepare(
        "UPDATE document_versions SET filename='mutated-live-name.txt',mime_type='application/octet-stream' WHERE id=?",
      )
      .run(standaloneDocument.versionId);
    const firstGlobalAttachment = service
      .detail(globalChat.id)
      .messages.find(
        (message) => message.id === globalGeneration.promptMessageId,
      )?.attachments[0];
    assert.equal(firstGlobalAttachment?.filename, "standalone-contract.txt");
    assert.equal(firstGlobalAttachment?.mimeType, "text/plain");
    const inheritedGlobalGeneration = service.requestGeneration({
      chatId: globalChat.id,
      prompt: "Follow up using the previously attached document.",
    });
    assert.deepEqual(
      payloadFor(database, inheritedGlobalGeneration.jobId).documents,
      [
        {
          documentId: standaloneDocument.documentId,
          versionId: standaloneDocument.versionId,
          attached: false,
        },
      ],
    );
    jobs.requestCancellation(
      inheritedGlobalGeneration.jobId,
      CLAIM_AT,
      "audit inherited attachment cleanup",
    );
    const standaloneVersionTwo = insertDocument(
      database,
      null,
      "standalone-contract-v2",
      "The updated standalone governing law is England.",
      standaloneDocument.documentId,
      2,
    );
    assert.throws(
      () =>
        service.requestGeneration({
          chatId: globalChat.id,
          prompt: "A stale historical attachment must not be used silently.",
        }),
      /deleted or replaced and must be explicitly re-attached/,
    );
    const reattachedGlobalGeneration = service.requestGeneration({
      chatId: globalChat.id,
      prompt: "Use the explicitly re-attached current document.",
      allowedDocumentIds: [standaloneDocument.documentId],
      attachmentDocumentIds: [standaloneDocument.documentId],
    });
    assert.deepEqual(
      payloadFor(database, reattachedGlobalGeneration.jobId).documents,
      [
        {
          documentId: standaloneDocument.documentId,
          versionId: standaloneVersionTwo.versionId,
          attached: true,
        },
      ],
    );
    jobs.requestCancellation(
      reattachedGlobalGeneration.jobId,
      CLAIM_AT,
      "audit reattachment cleanup",
    );

    const currentProjectDocument = insertDocument(
      database,
      projectOne,
      "project-contract-v2",
      "The revised governing law is Delaware.",
      projectDocument.documentId,
      2,
    );
    const currentResults = retrieval.retrieve({
      chatId: projectChat.id,
      query: "governing",
      allowedDocumentIds: [projectDocument.documentId],
      currentVersionOnly: true,
      limit: 20,
    });
    assert.deepEqual(
      [...new Set(currentResults.map((chunk) => chunk.versionId))],
      [currentProjectDocument.versionId],
    );

    const priorUser = service.addMessage(projectChat.id, "user", {
      content: "What law governed the earlier draft?",
    });
    service.updateMessage(priorUser.id, "complete");
    const priorAssistant = service.addMessage(projectChat.id, "assistant", {
      content: "The earlier draft used New York law.",
    });
    service.updateMessage(priorAssistant.id, "complete");
    assert.throws(
      () =>
        service.requestGeneration({
          chatId: projectChat.id,
          prompt: "Read /Users/private/credential.txt",
        }),
      /unsafe credential or path material/,
    );

    const generation = service.requestGeneration({
      chatId: projectChat.id,
      prompt: "governing",
      allowedDocumentIds: [projectDocument.documentId],
      attachmentDocumentIds: [projectDocument.documentId],
      retrievalLimit: 20,
    });
    const generationPayload = payloadFor(database, generation.jobId);
    const jobPayloadText = JSON.stringify(generationPayload);
    assert.doesNotMatch(
      jobPayloadText,
      /(?:credential|secret|token|storage_key|storageKey|\/Users\/|[A-Za-z]:\\)/i,
    );
    assert.equal(
      jobPayloadText.includes(currentProjectDocument.versionId),
      true,
    );
    assert.deepEqual(
      new Set(
        generationPayload.documents.map(
          (document: { documentId: string }) => document.documentId,
        ),
      ),
      new Set([
        projectDocument.documentId,
        multilingualDocument.documentId,
        rankedDocument.documentId,
      ]),
      "Project generation snapshots every current Project document instead of trusting client IDs",
    );
    const activeGenerationCounts = {
      jobs: count(database, "SELECT count(*) AS count FROM jobs"),
      messages: count(database, "SELECT count(*) AS count FROM chat_messages"),
    };
    assert.throws(
      () =>
        service.requestGeneration({
          chatId: projectChat.id,
          prompt: "A second concurrent generation must not start.",
        }),
      /Only one Assistant generation may be active for a chat/,
    );
    assert.equal(
      count(database, "SELECT count(*) AS count FROM jobs"),
      activeGenerationCounts.jobs,
    );
    assert.equal(
      count(database, "SELECT count(*) AS count FROM chat_messages"),
      activeGenerationCounts.messages,
      "the preflight and in-transaction active-generation fences add no partial rows",
    );
    const claimed = jobs.claimNextQueued(
      CLAIM_AT,
      "assistant-worker",
      LEASE_EXPIRES,
    );
    assert.equal(claimed?.id, generation.jobId);
    let modelCalls = 0;
    let capabilityChecks = 0;
    let eventFailures = 0;
    let capturedSystemPrompt = "";
    const publishedEventTypes: string[] = [];
    const evidenceChunk = currentResults[0];
    assert.ok(evidenceChunk);
    const evidenceDocumentIndex = generationPayload.documents.findIndex(
      (document: { documentId: string }) =>
        document.documentId === evidenceChunk.documentId,
    );
    assert.notEqual(evidenceDocumentIndex, -1);
    const evidenceDocumentLabel = `doc-${evidenceDocumentIndex}`;
    const evidenceQuote = "governing law is Delaware";
    const evidenceQuoteRelativeStart =
      evidenceChunk.text.indexOf(evidenceQuote);
    assert.notEqual(evidenceQuoteRelativeStart, -1);
    const evidenceQuoteStart =
      evidenceChunk.startOffset + evidenceQuoteRelativeStart;
    const evidenceQuoteEnd = evidenceQuoteStart + evidenceQuote.length;
    assert.equal(
      profiles.requireEnabled(profileId).capabilities.toolCalling,
      false,
      "persisted profile capability metadata is not treated as live adapter capability",
    );
    const model: AssistantModelPort = {
      async registeredCapabilities({ modelProfileId }) {
        capabilityChecks += 1;
        assert.equal(modelProfileId, profileId);
        return {
          adapterId: "audit-registered-model-adapter",
          streaming: true,
          toolCalling: true,
          reasoning: true,
        };
      },
      async runTurn({ systemPrompt, messages, tools, signal, onTextDelta }) {
        modelCalls += 1;
        capturedSystemPrompt = systemPrompt;
        assert.equal(signal.aborted, false);
        assert.deepEqual(
          messages.slice(0, 3).map((message) => ({
            role: message.role,
            content: message.content,
          })),
          [
            {
              role: "user",
              content: "What law governed the earlier draft?",
            },
            {
              role: "assistant",
              content: "The earlier draft used New York law.",
            },
            {
              role: "user",
              content: `[The user attached the following document(s) to this message:\n- ${evidenceDocumentLabel}: project-contract-v2.txt]\n\ngoverning`,
            },
          ],
          "the immutable prompt is appended to complete persisted multi-turn history",
        );
        assert.deepEqual(
          tools.map((tool) => tool.name),
          ["read_document"],
        );
        if (modelCalls === 1) {
          await onTextDelta("I will inspect the document. ");
          return {
            content: "I will inspect the document. ",
            toolCalls: [
              {
                id: "tool-call-1",
                name: "read_document",
                input: { doc_id: evidenceDocumentLabel },
              },
            ],
            sources: [],
          };
        }
        const priorModelTurn = messages.at(-2);
        assert.equal(priorModelTurn?.role, "assistant");
        assert.deepEqual(
          priorModelTurn?.role === "assistant"
            ? priorModelTurn.toolCalls?.map((call) => call.name)
            : [],
          ["read_document"],
        );
        assert.equal(messages.at(-1)?.role, "tool");
        assert.match(messages.at(-1)?.content ?? "", /Delaware/);
        await onTextDelta("Delaware governs [1][2].");
        return {
          content: "Delaware governs [1][2].",
          toolCalls: [],
          sources: [0, 1].map((citationOrdinal) => ({
            documentId: evidenceChunk.documentId,
            versionId: evidenceChunk.versionId,
            chunkId: evidenceChunk.chunkId,
            quote: evidenceQuote,
            startOffset: evidenceQuoteStart,
            endOffset: evidenceQuoteEnd,
            locator: { pageStart: 1, pageEnd: 1 },
            rank: 0,
            score: 1,
            citationOrdinal,
            citationMetadata: { citationNumber: citationOrdinal + 1 },
          })),
        };
      },
    };
    const toolPort: AssistantToolPort = {
      async registeredTools(context) {
        assert.equal(context.jobId, generation.jobId);
        assert.equal(
          context.documents.some(
            (document) => document.versionId === evidenceChunk.versionId,
          ),
          true,
        );
        return {
          adapterId: "audit-workspace-document-tools",
          tools: [READ_DOCUMENT_TOOL],
        };
      },
      async execute({ call, signal }) {
        assert.equal(signal.aborted, false);
        assert.deepEqual(call, {
          id: "tool-call-1",
          name: "read_document",
          input: { doc_id: evidenceDocumentLabel },
        });
        return {
          content: JSON.stringify({
            doc_id: evidenceDocumentLabel,
            document_id: evidenceChunk.documentId,
            version_id: evidenceChunk.versionId,
            text: evidenceChunk.text,
          }),
          events: [
            {
              type: "doc_read_start",
              filename: evidenceChunk.filename,
            },
            {
              type: "doc_read",
              filename: evidenceChunk.filename,
              document_id: evidenceChunk.documentId,
            },
          ],
          sourceContext: [evidenceChunk],
        };
      },
    };
    const runtime = new AssistantRuntimeService(chats, jobs, model, {
      clock: () => new Date("2026-07-14T08:02:00.000Z"),
      tools: toolPort,
      events: {
        async publish(_jobId, event) {
          publishedEventTypes.push(event.type);
          if (event.type === "complete") {
            throw new Error("/Users/audit/transport-secret");
          }
        },
      },
      onEventFailure(failure) {
        assert.deepEqual(failure, {
          code: "assistant_event_publish_failed",
        });
        eventFailures += 1;
      },
    });
    await runtime.execute({
      jobId: generation.jobId,
      leaseOwner: "assistant-worker",
      attempt: claimed!.attempt,
      signal: new AbortController().signal,
    });
    assert.equal(modelCalls, 2);
    assert.equal(capabilityChecks, 1);
    assert.match(capturedSystemPrompt, /^You are Vera,/);
    assert.doesNotMatch(capturedSystemPrompt, /^You are Mike,/);
    assert.match(capturedSystemPrompt, /Use at most 10 tool-use rounds/);
    assert.match(capturedSystemPrompt, /read_document/);
    assert.match(
      capturedSystemPrompt,
      /Never attempt shell, Python, network, MCP, CourtListener, cloud storage/,
    );
    assert.deepEqual(publishedEventTypes, [
      "content_delta",
      "tool_call_start",
      "doc_read_start",
      "doc_read",
      "content_delta",
      "content_done",
      "complete",
    ]);
    assert.equal(eventFailures, 1);
    assert.equal(jobs.getJob(generation.jobId)?.status, "complete");
    assert.equal(
      count(
        database,
        "SELECT count(*) AS count FROM message_sources WHERE message_id=? AND chunk_id=?",
        generation.outputMessageId,
        currentProjectDocument.chunkId,
      ),
      2,
      "the same chunk may support multiple citation occurrences",
    );
    const citationFilename = chats.sources(generation.outputMessageId)[0]
      ?.filename;
    assert.equal(citationFilename, "project-contract-v2.txt");
    expectSqlFailure(
      () =>
        database
          .prepare(
            "UPDATE message_sources SET filename_snapshot='forged.txt' WHERE message_id=?",
          )
          .run(generation.outputMessageId),
      /assistant message sources are immutable/,
    );
    database
      .prepare("UPDATE document_versions SET filename=? WHERE id=?")
      .run(
        "project-contract-renamed-after-citation.txt",
        currentProjectDocument.versionId,
      );
    assert.equal(
      chats.sources(generation.outputMessageId)[0]?.filename,
      citationFilename,
      "citation transport reads the immutable source filename snapshot after a document rename",
    );

    const unsupportedCitations = [
      {
        name: "chunk quote",
        source: {
          chunkId: evidenceChunk.chunkId,
          quote: "fabricated quotation not present in evidence",
          startOffset: evidenceChunk.startOffset,
          endOffset:
            evidenceChunk.startOffset +
            "fabricated quotation not present in evidence".length,
        },
        citationOrdinal: 0,
        citationNumber: 1,
        content: "Unsupported citation [1].",
        expected: /quote and offsets do not match exact tool evidence/,
      },
      {
        name: "document quote",
        source: {
          chunkId: null,
          quote: "fabricated document-level quotation",
          startOffset: evidenceChunk.startOffset,
          endOffset:
            evidenceChunk.startOffset +
            "fabricated document-level quotation".length,
        },
        citationOrdinal: 0,
        citationNumber: 1,
        content: "Unsupported citation [1].",
        expected: /quote and offsets do not match exact tool evidence/,
      },
      {
        name: "quote offsets",
        source: {
          chunkId: evidenceChunk.chunkId,
          quote: evidenceQuote,
          startOffset: evidenceChunk.endOffset + 1,
          endOffset: evidenceChunk.endOffset + 1 + evidenceQuote.length,
        },
        citationOrdinal: 0,
        citationNumber: 1,
        content: "Unsupported citation [1].",
        expected: /quote and offsets do not match exact tool evidence/,
      },
      {
        name: "marker",
        source: {
          chunkId: evidenceChunk.chunkId,
          quote: evidenceQuote,
          startOffset: evidenceQuoteStart,
          endOffset: evidenceQuoteEnd,
        },
        citationOrdinal: 0,
        citationNumber: 1,
        content: "Unsupported citation [2].",
        expected: /citation markers and source references/,
      },
      {
        name: "reference",
        source: {
          chunkId: evidenceChunk.chunkId,
          quote: evidenceQuote,
          startOffset: evidenceQuoteStart,
          endOffset: evidenceQuoteEnd,
        },
        citationOrdinal: 0,
        citationNumber: 2,
        content: "Unsupported citation [1].",
        expected: /citation markers and source references/,
      },
    ] as const;
    for (const [index, testCase] of unsupportedCitations.entries()) {
      const rejectedGeneration = service.requestGeneration({
        chatId: projectChat.id,
        prompt: `Reject unsupported ${testCase.name}.`,
        allowedDocumentIds: [projectDocument.documentId],
        attachmentDocumentIds: [projectDocument.documentId],
      });
      const rejectedClaim = jobs.claimNextQueued(
        `2026-07-14T08:02:1${index}.000Z`,
        `unsupported-citation-${index}`,
        LEASE_EXPIRES,
      );
      assert.equal(rejectedClaim?.id, rejectedGeneration.jobId);
      let rejectedTurns = 0;
      const rejectedRuntime = new AssistantRuntimeService(
        chats,
        jobs,
        {
          async registeredCapabilities() {
            return {
              adapterId: "citation-audit-model",
              streaming: true,
              toolCalling: true,
            };
          },
          async runTurn({ onTextDelta }) {
            rejectedTurns += 1;
            if (rejectedTurns === 1) {
              return {
                content: "",
                toolCalls: [
                  {
                    id: `citation-tool-${index}`,
                    name: "read_document",
                    input: { doc_id: evidenceDocumentLabel },
                  },
                ],
                sources: [],
              };
            }
            await onTextDelta(testCase.content);
            return {
              content: testCase.content,
              toolCalls: [],
              sources: [
                {
                  documentId: evidenceChunk.documentId,
                  versionId: evidenceChunk.versionId,
                  ...testCase.source,
                  locator: {},
                  rank: 0,
                  score: 1,
                  citationOrdinal: testCase.citationOrdinal,
                  citationMetadata: {
                    citationNumber: testCase.citationNumber,
                  },
                },
              ],
            };
          },
        },
        {
          clock: () => new Date(`2026-07-14T08:02:2${index}.000Z`),
          tools: {
            async registeredTools() {
              return {
                adapterId: "citation-audit-tools",
                tools: [READ_DOCUMENT_TOOL],
              };
            },
            async execute() {
              return {
                content: evidenceChunk.text,
                sourceContext: [evidenceChunk],
              };
            },
          },
        },
      );
      await assert.rejects(
        rejectedRuntime.execute({
          jobId: rejectedGeneration.jobId,
          leaseOwner: `unsupported-citation-${index}`,
          attempt: rejectedClaim!.attempt,
          signal: new AbortController().signal,
        }),
        testCase.expected,
      );
      assert.equal(jobs.getJob(rejectedGeneration.jobId)?.status, "failed");
      assert.equal(
        count(
          database,
          "SELECT count(*) AS count FROM message_sources WHERE message_id=?",
          rejectedGeneration.outputMessageId,
        ),
        0,
        `${testCase.name} failure persists no unsupported source`,
      );
    }

    const projectTwoChat = service.create({
      projectId: projectTwo,
      modelProfileId: profileId,
    });
    const projectTwoMessage = service.addMessage(
      projectTwoChat.id,
      "assistant",
      {
        content: "Other project",
      },
    );
    const sourceId = String(
      database
        .prepare(
          "SELECT id FROM message_sources WHERE message_id=? ORDER BY citation_ordinal LIMIT 1",
        )
        .get(generation.outputMessageId)?.id,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE message_sources SET message_id=? WHERE id=?")
          .run(projectTwoMessage.id, sourceId),
      /chat scope/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE message_sources SET quote=? WHERE id=?")
          .run("tampered historical quote", sourceId),
      /assistant message sources are immutable/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE documents SET project_id=? WHERE id=?")
          .run(projectTwo, projectDocument.documentId),
      /assistant (?:source|attachment|generation) scope/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE document_versions SET document_id=? WHERE id=?")
          .run(otherDocument.documentId, currentProjectDocument.versionId),
      /ownership|FOREIGN KEY|constraint/i,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE document_versions SET id=? WHERE id=?")
          .run(randomUUID(), currentProjectDocument.versionId),
      /ownership|FOREIGN KEY|constraint/i,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE chats SET project_id=? WHERE id=?")
          .run(projectTwo, projectChat.id),
      /same project|chat scope/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare(
            "UPDATE message_sources SET citation_metadata_json=? WHERE id=?",
          )
          .run('{"citationNumber":"corrupt"}', sourceId),
      /immutable/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE message_sources SET locator_json=? WHERE id=?")
          .run('{"startOffset":1}', sourceId),
      /immutable/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE message_sources SET locator_json=? WHERE id=?")
          .run(JSON.stringify({ section: "x".repeat(501) }), sourceId),
      /immutable/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare("UPDATE message_sources SET locator_json=? WHERE id=?")
          .run('{"pageStart":2,"pageEnd":1}', sourceId),
      /immutable/,
    );
    expectSqlFailure(
      () =>
        database
          .prepare(
            "UPDATE message_sources SET citation_metadata_json=? WHERE id=?",
          )
          .run('{"citationNumber":0}', sourceId),
      /immutable/,
    );

    database.exec(
      "PRAGMA ignore_check_constraints = ON; BEGIN IMMEDIATE; DROP TRIGGER message_sources_immutable; DROP TRIGGER message_sources_v5_json_update;",
    );
    try {
      database
        .prepare(
          "UPDATE message_sources SET citation_metadata_json=? WHERE id=?",
        )
        .run('{"citationNumber":"corrupt"}', sourceId);
      assert.throws(
        () => chats.sources(generation.outputMessageId),
        /Invalid persisted message citation metadata/,
        "repository mapping rejects corrupted persisted JSON fail closed",
      );
    } finally {
      database.exec("ROLLBACK; PRAGMA ignore_check_constraints = OFF;");
    }

    const thirdVersion = insertDocument(
      database,
      projectOne,
      "project-contract-v3",
      "The newest governing law remains Delaware.",
      projectDocument.documentId,
      3,
    );
    assert.equal(
      database
        .prepare("SELECT current_version_id FROM documents WHERE id=?")
        .get(projectDocument.documentId)?.current_version_id,
      thirdVersion.versionId,
      "advancing current_version_id remains allowed",
    );
    assert.equal(
      database
        .prepare(
          "SELECT version_id FROM assistant_generation_documents WHERE job_id=? AND document_id=?",
        )
        .get(generation.jobId, projectDocument.documentId)?.version_id,
      currentProjectDocument.versionId,
      "the immutable old generation snapshot remains intact",
    );

    const boundedGeneration = service.requestGeneration({
      chatId: projectChat.id,
      prompt: "governing",
      allowedDocumentIds: [projectDocument.documentId],
      attachmentDocumentIds: [projectDocument.documentId],
    });
    const boundedClaim = jobs.claimNextQueued(
      "2026-07-14T08:02:30.000Z",
      "bounded-worker",
      LEASE_EXPIRES,
    );
    assert.equal(boundedClaim?.id, boundedGeneration.jobId);
    const boundedRuntime = new AssistantRuntimeService(
      chats,
      jobs,
      {
        async registeredCapabilities() {
          return {
            adapterId: "bounded-model-adapter",
            streaming: true,
            toolCalling: true,
          };
        },
        async runTurn({ onTextDelta }) {
          await onTextDelta("x".repeat(100_000));
          await onTextDelta("y".repeat(100_000));
          await onTextDelta("z");
          return { content: "unreachable", toolCalls: [], sources: [] };
        },
      },
      {
        clock: () => new Date("2026-07-14T08:02:45.000Z"),
        tools: {
          async registeredTools() {
            return {
              adapterId: "bounded-tool-adapter",
              tools: [READ_DOCUMENT_TOOL],
            };
          },
          async execute() {
            throw new Error("bounded tool should not run");
          },
        },
      },
    );
    await assert.rejects(
      boundedRuntime.execute({
        jobId: boundedGeneration.jobId,
        leaseOwner: "bounded-worker",
        attempt: boundedClaim!.attempt,
        signal: new AbortController().signal,
      }),
      /text deltas exceeded/,
    );
    assert.equal(jobs.getJob(boundedGeneration.jobId)?.status, "failed");
    const boundedMessage = database
      .prepare(
        "SELECT status,length(content) AS content_length FROM chat_messages WHERE id=?",
      )
      .get(boundedGeneration.outputMessageId);
    assert.equal(boundedMessage?.status, "failed");
    assert.equal(
      boundedMessage?.content_length,
      200_000,
      "safe partial model output is retained atomically on terminal failure",
    );

    const missingToolsGeneration = service.requestGeneration({
      chatId: projectChat.id,
      prompt: "Answer without documents.",
    });
    const missingToolsClaim = jobs.claimNextQueued(
      "2026-07-14T08:02:50.000Z",
      "missing-tools-worker",
      LEASE_EXPIRES,
    );
    assert.equal(missingToolsClaim?.id, missingToolsGeneration.jobId);
    let missingToolsModelCalls = 0;
    const missingToolsRuntime = new AssistantRuntimeService(
      chats,
      jobs,
      {
        async registeredCapabilities() {
          missingToolsModelCalls += 1;
          return {
            adapterId: "must-not-be-read-without-tools",
            streaming: true,
            toolCalling: true,
          };
        },
        async runTurn() {
          missingToolsModelCalls += 1;
          return { content: "not allowed", toolCalls: [], sources: [] };
        },
      },
      { clock: () => new Date("2026-07-14T08:02:51.000Z") },
    );
    await assert.rejects(
      missingToolsRuntime.execute({
        jobId: missingToolsGeneration.jobId,
        leaseOwner: "missing-tools-worker",
        attempt: missingToolsClaim!.attempt,
        signal: new AbortController().signal,
      }),
      /registered Assistant tool adapter/,
    );
    assert.equal(missingToolsModelCalls, 0);
    assert.equal(jobs.getJob(missingToolsGeneration.jobId)?.status, "failed");

    const incapableGeneration = service.requestGeneration({
      chatId: projectChat.id,
      prompt: "Use the actual registered adapter capabilities.",
    });
    const incapableClaim = jobs.claimNextQueued(
      "2026-07-14T08:02:52.000Z",
      "incapable-worker",
      LEASE_EXPIRES,
    );
    assert.equal(incapableClaim?.id, incapableGeneration.jobId);
    let incapableTurnCalls = 0;
    const incapableRuntime = new AssistantRuntimeService(
      chats,
      jobs,
      {
        async registeredCapabilities() {
          return {
            adapterId: "actual-incapable-adapter",
            streaming: true,
            toolCalling: false,
          };
        },
        async runTurn() {
          incapableTurnCalls += 1;
          return { content: "not allowed", toolCalls: [], sources: [] };
        },
      },
      {
        clock: () => new Date("2026-07-14T08:02:53.000Z"),
        tools: toolPort,
      },
    );
    await assert.rejects(
      incapableRuntime.execute({
        jobId: incapableGeneration.jobId,
        leaseOwner: "incapable-worker",
        attempt: incapableClaim!.attempt,
        signal: new AbortController().signal,
      }),
      /lacks Mike streaming\/tool capability/,
    );
    assert.equal(incapableTurnCalls, 0);
    assert.equal(jobs.getJob(incapableGeneration.jobId)?.status, "failed");

    const adapterErrorChat = service.create({ modelProfileId: profileId });
    const adapterErrorGeneration = service.requestGeneration({
      chatId: adapterErrorChat.id,
      prompt: "Fail with a redacted adapter error.",
    });
    const adapterErrorClaim = jobs.claimNextQueued(
      "2026-07-14T08:02:53.100Z",
      "adapter-error-worker",
      LEASE_EXPIRES,
    );
    assert.equal(adapterErrorClaim?.id, adapterErrorGeneration.jobId);
    const adapterErrorRuntime = new AssistantRuntimeService(
      chats,
      jobs,
      {
        async registeredCapabilities() {
          return {
            adapterId: "adapter-error-model",
            streaming: true,
            toolCalling: true,
          };
        },
        async runTurn() {
          throw Object.assign(new Error("/Users/private/provider-secret"), {
            code: "provider_internal_secret_path",
            retryable: true,
          });
        },
      },
      {
        clock: () => new Date("2026-07-14T08:02:53.200Z"),
        tools: {
          async registeredTools() {
            return {
              adapterId: "adapter-error-tools",
              tools: [READ_DOCUMENT_TOOL],
            };
          },
          async execute() {
            throw new Error("adapter error tool must not run");
          },
        },
      },
    );
    await assert.rejects(
      adapterErrorRuntime.execute({
        jobId: adapterErrorGeneration.jobId,
        leaseOwner: "adapter-error-worker",
        attempt: adapterErrorClaim!.attempt,
        signal: new AbortController().signal,
      }),
      (error) =>
        error instanceof WorkspaceApiError &&
        error.status === 502 &&
        error.code === "JOB_FAILED" &&
        error.message === "Assistant generation failed.",
    );
    const adapterFailure = database
      .prepare("SELECT error_code,error_json FROM jobs WHERE id=?")
      .get(adapterErrorGeneration.jobId);
    assert.equal(adapterFailure?.error_code, "assistant_model_failed");
    assert.doesNotMatch(
      String(adapterFailure?.error_json),
      /provider_internal_secret_path|\/Users\/|provider-secret/,
    );

    const abortGeneration = service.requestGeneration({
      chatId: projectChat.id,
      prompt: "Abort this turn safely.",
    });
    const abortClaim = jobs.claimNextQueued(
      "2026-07-14T08:02:54.000Z",
      "abort-worker",
      LEASE_EXPIRES,
    );
    assert.equal(abortClaim?.id, abortGeneration.jobId);
    const abortController = new AbortController();
    const abortRuntime = new AssistantRuntimeService(
      chats,
      jobs,
      {
        async registeredCapabilities() {
          return {
            adapterId: "abort-aware-adapter",
            streaming: true,
            toolCalling: true,
          };
        },
        async runTurn({ onTextDelta }) {
          await onTextDelta("partial");
          abortController.abort();
          await onTextDelta("must not be accepted");
          return { content: "unreachable", toolCalls: [], sources: [] };
        },
      },
      {
        clock: () => new Date("2026-07-14T08:02:55.000Z"),
        tools: {
          async registeredTools() {
            return {
              adapterId: "abort-tools",
              tools: [READ_DOCUMENT_TOOL],
            };
          },
          async execute() {
            throw new Error("abort tool should not run");
          },
        },
      },
    );
    await assert.rejects(
      abortRuntime.execute({
        jobId: abortGeneration.jobId,
        leaseOwner: "abort-worker",
        attempt: abortClaim!.attempt,
        signal: abortController.signal,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(jobs.getJob(abortGeneration.jobId)?.status, "running");
    assert.equal(
      database
        .prepare("SELECT status,content FROM chat_messages WHERE id=?")
        .get(abortGeneration.outputMessageId)?.status,
      "pending",
    );
    jobs.persistTransition(abortGeneration.jobId, {
      type: "cancel",
      at: "2026-07-14T08:02:57.000Z",
      reason: "audit abort cleanup",
    });
    assert.equal(jobs.getJob(abortGeneration.jobId)?.status, "cancelled");

    const staleGeneration = service.requestGeneration({
      chatId: projectChat.id,
      prompt: "Summarize the newest governing law.",
      allowedDocumentIds: [projectDocument.documentId],
      attachmentDocumentIds: [projectDocument.documentId],
    });
    const staleClaim = jobs.claimNextQueued(
      "2026-07-14T08:03:00.000Z",
      "stale-worker",
      LEASE_EXPIRES,
    );
    assert.equal(staleClaim?.id, staleGeneration.jobId);
    jobs.requestCancellation(
      staleGeneration.jobId,
      "2026-07-14T08:04:00.000Z",
      "user cancelled",
    );
    await assert.rejects(
      runtime.execute({
        jobId: staleGeneration.jobId,
        leaseOwner: "stale-worker",
        attempt: staleClaim!.attempt,
        signal: new AbortController().signal,
      }),
      WorkspaceJobLeaseLostError,
    );
    assert.equal(modelCalls, 2, "stale claims are rejected before model calls");
    assert.equal(
      database
        .prepare("SELECT status,content FROM chat_messages WHERE id=?")
        .get(staleGeneration.outputMessageId)?.status,
      "pending",
    );
    assert.equal(
      count(
        database,
        "SELECT count(*) AS count FROM message_sources WHERE message_id=?",
        staleGeneration.outputMessageId,
      ),
      0,
    );
    jobs.persistTransition(staleGeneration.jobId, {
      type: "cancel",
      at: "2026-07-14T08:04:01.000Z",
      reason: "audit stale-claim cleanup",
    });
    assert.equal(jobs.getJob(staleGeneration.jobId)?.status, "cancelled");

    const rollbackGeneration = service.requestGeneration({
      chatId: projectChat.id,
      prompt: "Audit atomic source commit.",
      allowedDocumentIds: [projectDocument.documentId],
      attachmentDocumentIds: [projectDocument.documentId],
    });
    const rollbackClaim = jobs.claimNextQueued(
      "2026-07-14T08:05:00.000Z",
      "rollback-worker",
      LEASE_EXPIRES,
    );
    assert.equal(rollbackClaim?.id, rollbackGeneration.jobId);
    const rollbackSnapshot = chats.generationSnapshot(rollbackGeneration.jobId);
    assert.throws(
      () =>
        chats.commitGenerationComplete({
          snapshot: rollbackSnapshot,
          claim: {
            jobId: rollbackGeneration.jobId,
            leaseOwner: "rollback-worker",
            attempt: rollbackClaim!.attempt,
            at: "2026-07-14T08:06:00.000Z",
          },
          claims: jobs,
          content: "Must roll back",
          sources: [
            {
              id: randomUUID(),
              documentId: projectDocument.documentId,
              versionId: thirdVersion.versionId,
              chunkId: thirdVersion.chunkId,
              quote: "governing law",
              startOffset: 11,
              endOffset: 24,
              locator: { pageStart: 1 },
              rank: 0,
              score: 1,
              citationOrdinal: 0,
              citationMetadata: { citationNumber: 1 },
            },
            {
              id: randomUUID(),
              documentId: otherDocument.documentId,
              versionId: otherDocument.versionId,
              chunkId: otherDocument.chunkId,
              quote: "governing law",
              startOffset: 4,
              endOffset: 17,
              locator: { pageStart: 1 },
              rank: 1,
              score: 0,
              citationOrdinal: 1,
              citationMetadata: { citationNumber: 2 },
            },
          ],
          now: "2026-07-14T08:06:00.000Z",
        }),
      /immutable generation snapshot/,
    );
    assert.equal(
      count(
        database,
        "SELECT count(*) AS count FROM message_sources WHERE message_id=?",
        rollbackGeneration.outputMessageId,
      ),
      0,
      "a later invalid source rolls the entire domain commit back",
    );
    assert.equal(jobs.getJob(rollbackGeneration.jobId)?.status, "running");
    jobs.persistTransition(rollbackGeneration.jobId, {
      type: "cancel",
      at: "2026-07-14T08:06:01.000Z",
      reason: "audit rollback cleanup",
    });

    const mikeInput = parseMikeProjectChatGeneration(projectOne, {
      messages: [{ role: "user", content: "Review", files: [] }],
      chat_id: projectChat.id,
      model: "Primary-model",
      displayed_doc: {
        filename: "project-contract-v3.txt",
        document_id: projectDocument.documentId,
      },
      attached_documents: [
        {
          filename: "project-contract-v3.txt",
          document_id: projectDocument.documentId,
        },
      ],
    });
    assert.deepEqual(mikeInput.allowedDocumentIds, [
      projectDocument.documentId,
    ]);
    assert.throws(
      () =>
        parseMikeChatGeneration({
          messages: [
            {
              role: "user",
              content: "Run this workflow.",
              workflow: { id: randomUUID(), title: "Unpersisted workflow" },
            },
          ],
          chat_id: projectChat.id,
        }),
      /workflow snapshots are not enabled/,
    );
    assert.throws(
      () =>
        parseMikeProjectChatGeneration(projectOne, {
          messages: [{ role: "user", content: "Continue." }],
          chat_id: projectChat.id,
          ask_inputs_response: {
            responses: [
              {
                id: "answer-1",
                kind: "choice",
                question: "Choose law",
                answer: "Delaware",
              },
            ],
          },
        }),
      /ask-input responses are not enabled/,
    );
    assert.deepEqual(
      MikeAssistantStreamEventSchema.parse({
        type: "chat_id",
        chatId: projectChat.id,
      }),
      { type: "chat_id", chatId: projectChat.id },
    );
    assert.deepEqual(
      MikeAssistantStreamEventSchema.parse({
        type: "content_delta",
        text: "streamed",
      }),
      { type: "content_delta", text: "streamed" },
    );
    const mikeDetail = toMikeChatDetail(service.detail(projectChat.id));
    assert.equal(mikeDetail.chat.project_id, projectOne);
    const hydratedDetail = service.detail(projectChat.id);
    const withoutEmptyCitations = toMikeChatDetail({
      chat: hydratedDetail.chat,
      messages: hydratedDetail.messages.map((message) => ({
        ...message,
        sources: message.sources.map((source) => ({
          ...source,
          quote: null,
        })),
      })),
    });
    assert.equal(
      withoutEmptyCitations.messages.some(
        (message) => message.citations !== undefined,
      ),
      false,
      "legacy sources without a non-empty quote are omitted instead of serialized as empty citations",
    );
    assert.equal(capabilityHydrations > 0, true);
    const mikeJson = JSON.stringify(mikeDetail);
    assert.doesNotMatch(
      mikeJson,
      /(?:credential_ref|storage_key|\/Users\/|[A-Za-z]:\\|bearer|api[_-]?key)/i,
    );

    const deletionChat = service.create({ modelProfileId: profileId });
    const deletionGeneration = service.requestGeneration({
      chatId: deletionChat.id,
      prompt: "Delete safely.",
    });
    assert.throws(
      () => service.delete(deletionChat.id),
      /cancelled before deletion/,
    );
    assert.ok(chats.get(deletionChat.id));
    const deletingService = new ChatsService(
      chats,
      projects,
      profiles,
      () => new Date("2026-07-14T08:07:00.000Z"),
      {
        jobs: jobService,
        capabilities: {
          hydrate: () => ({ can_read: true, can_download: true }),
        },
        lifecycle: {
          cancelQueued(jobIds) {
            for (const jobId of jobIds) {
              jobs.requestCancellation(jobId, "2026-07-14T08:07:00.000Z");
            }
          },
          requestAbortRunning() {},
        },
        inferencePolicy,
      },
    );
    deletingService.delete(deletionChat.id);
    assert.equal(chats.get(deletionChat.id), null);
    assert.equal(jobs.getJob(deletionGeneration.jobId), null);

    const rollbackCounts = {
      messages: count(database, "SELECT count(*) AS count FROM chat_messages"),
      jobs: count(database, "SELECT count(*) AS count FROM jobs"),
    };
    const throwingService = new ChatsService(
      chats,
      projects,
      profiles,
      () => new Date("2026-07-14T08:08:00.000Z"),
      {
        jobs: {
          enqueueJobInCurrentTransaction(input) {
            jobService.enqueueJobInCurrentTransaction(input);
            throw new Error("audit enqueue failure");
          },
        },
        inferencePolicy,
      },
    );
    assert.throws(
      () =>
        throwingService.requestGeneration({
          chatId: projectChat.id,
          prompt: "This request must roll back.",
        }),
      /audit enqueue failure/,
    );
    assert.equal(
      count(database, "SELECT count(*) AS count FROM chat_messages"),
      rollbackCounts.messages,
    );
    assert.equal(
      count(database, "SELECT count(*) AS count FROM jobs"),
      rollbackCounts.jobs,
    );

    const rawProfile = insertProfile(database, "Disposable");
    const rawChat = service.create({ modelProfileId: rawProfile });
    const rawGeneration = new ChatsService(
      chats,
      projects,
      profiles,
      () => new Date(NOW),
      { jobs: jobService, inferencePolicy },
    ).requestGeneration({ chatId: rawChat.id, prompt: "Snapshot profile." });
    database.prepare("DELETE FROM model_profiles WHERE id=?").run(rawProfile);
    assert.equal(
      database
        .prepare(
          "SELECT model_profile_id FROM assistant_generation_snapshots WHERE job_id=?",
        )
        .get(rawGeneration.jobId)?.model_profile_id,
      rawProfile,
      "raw execution facts do not block model profile deletion",
    );
    jobs.requestCancellation(rawGeneration.jobId, CLAIM_AT);

    database
      .prepare("DELETE FROM documents WHERE id=?")
      .run(standaloneDocument.documentId);
    assert.equal(
      count(
        database,
        "SELECT count(*) AS count FROM chat_message_attachments WHERE message_id=? AND document_id=? AND version_id=?",
        globalGeneration.promptMessageId,
        standaloneDocument.documentId,
        standaloneDocument.versionId,
      ),
      1,
      "single-document purge does not silently erase attachment evidence",
    );
    assert.equal(
      chats.attachments(globalGeneration.promptMessageId)[0]?.filename,
      "standalone-contract.txt",
      "attachment display metadata remains available from the immutable snapshot",
    );

    const cascadeProject = insertProject(database, "Cascade Project");
    const cascadeDocument = insertDocument(
      database,
      cascadeProject,
      "cascade-document",
      "Cascade evidence text.",
    );
    const cascadeChat = service.create({
      projectId: cascadeProject,
      modelProfileId: profileId,
    });
    const cascadeGeneration = service.requestGeneration({
      chatId: cascadeChat.id,
      prompt: "Cascade safely.",
      allowedDocumentIds: [cascadeDocument.documentId],
      attachmentDocumentIds: [cascadeDocument.documentId],
    });
    database.prepare("DELETE FROM projects WHERE id=?").run(cascadeProject);
    assert.equal(chats.get(cascadeChat.id), null);
    assert.equal(
      count(
        database,
        "SELECT count(*) AS count FROM assistant_generation_snapshots WHERE job_id=?",
        cascadeGeneration.jobId,
      ),
      0,
      "project cascade is not blocked by raw execution facts",
    );
    database
      .prepare("DELETE FROM jobs WHERE id=?")
      .run(cascadeGeneration.jobId);

    const projectWithManyChats = insertProject(database, "Many chat matter");
    for (let index = 0; index < 51; index += 1) {
      service.create({
        projectId: projectWithManyChats,
        modelProfileId: profileId,
        title: `Project chat ${index}`,
      });
    }
    assert.equal(
      service.listProjectChats(projectWithManyChats).length,
      51,
      "Mike Project chat history returns all 51 chats instead of silently applying the repository default page size",
    );
    const projectBeyondChatLimit = insertProject(
      database,
      "Project beyond chat limit",
    );
    for (let index = 0; index < 201; index += 1) {
      service.create({
        projectId: projectBeyondChatLimit,
        modelProfileId: profileId,
        title: `Bounded chat ${index}`,
      });
    }
    assert.throws(
      () => service.listProjectChats(projectBeyondChatLimit),
      /exceeds the safe limit of 200; an explicit pagination protocol is required/,
    );

    const routeSource = readFileSync(
      path.join(BACKEND_ROOT, "src/routes/workspaceChatsV1.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      routeSource,
      /WorkspaceDatabase|BEGIN IMMEDIATE|new ChatsRepository/,
    );
    assert.match(routeSource, /WorkspaceChatsV1Port/);
    assert.match(
      routeSource,
      /requestGeneration|AssistantGenerationEventStreamPort|parseMikeChatGeneration|text\/event-stream|sendGeneration/,
      "the Chats router composes the durable generation and replay surface",
    );
    let observedGlobalLimit: number | undefined;
    const routePort: WorkspaceChatsV1Port = {
      async listChats(context, input) {
        assert.equal(context.principalId, WORKSPACE_LOCAL_PRINCIPAL_ID);
        observedGlobalLimit = input.limit;
        return service.list(input);
      },
      async listProjectChats(context, projectId) {
        assert.equal(context.principalId, WORKSPACE_LOCAL_PRINCIPAL_ID);
        return service.listProjectChats(projectId);
      },
      async createChat(context, input) {
        assert.equal(context.principalId, WORKSPACE_LOCAL_PRINCIPAL_ID);
        return service.create(input);
      },
      async getChatDetail(context, chatId) {
        assert.equal(context.principalId, WORKSPACE_LOCAL_PRINCIPAL_ID);
        return service.detail(chatId);
      },
      async updateChat(context, chatId, input) {
        assert.equal(context.principalId, WORKSPACE_LOCAL_PRINCIPAL_ID);
        return service.update(chatId, input);
      },
      async deleteChat(context, chatId) {
        assert.equal(context.principalId, WORKSPACE_LOCAL_PRINCIPAL_ID);
        service.delete(chatId);
      },
    };
    const unauthenticatedApp = express();
    unauthenticatedApp.use(express.json());
    unauthenticatedApp.use(createWorkspaceChatsV1Router(routePort));
    await withHttpServer(unauthenticatedApp, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/chat`)).status, 401);
      assert.equal(
        (
          await fetch(`${baseUrl}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: [] }),
          })
        ).status,
        404,
      );
    });

    assert.throws(
      () =>
        createWorkspaceChatsV1Router(routePort, {
          capabilities: { generation: true },
        }),
      /complete durable generation port/,
      "generation cannot be mounted with an incomplete composition port",
    );
    const authenticatedApp = express();
    authenticatedApp.use(express.json());
    authenticatedApp.use((_request, response, next) => {
      response.locals.userId = WORKSPACE_LOCAL_PRINCIPAL_ID;
      next();
    });
    authenticatedApp.use(createWorkspaceChatsV1Router(routePort));
    await withHttpServer(authenticatedApp, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/chat?limit=101`);
      assert.equal(listResponse.status, 200);
      assert.equal(Array.isArray(await listResponse.json()), true);
      assert.equal(
        observedGlobalLimit,
        100,
        "Mike's final limit=101 request is safely clamped instead of rejected",
      );
      assert.equal(
        (await fetch(`${baseUrl}/chat?limit=not-a-number`)).status,
        422,
      );
      assert.equal(
        (await fetch(`${baseUrl}/chat?limit=${"9".repeat(65)}`)).status,
        422,
      );
      const projectChatsResponse = await fetch(
        `${baseUrl}/projects/${projectWithManyChats}/chats`,
      );
      assert.equal(projectChatsResponse.status, 200);
      assert.equal(
        ((await projectChatsResponse.json()) as unknown[]).length,
        51,
      );
      const createResponse = await fetch(`${baseUrl}/chat/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Route CRUD audit" }),
      });
      assert.equal(createResponse.status, 201);
      const createdId = String(
        ((await createResponse.json()) as { id?: unknown }).id,
      );
      assert.equal((await fetch(`${baseUrl}/chat/${createdId}`)).status, 200);
      assert.equal(
        (
          await fetch(`${baseUrl}/chat/${createdId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Updated route CRUD audit" }),
          })
        ).status,
        204,
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: [] }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/projects/${projectOne}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: [] }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/chat/${createdId}`, {
            method: "DELETE",
          })
        ).status,
        204,
      );
    });

    const explicitContextApp = express();
    explicitContextApp.use(
      createWorkspaceChatsV1Router(routePort, {
        context: () => ({ principalId: WORKSPACE_LOCAL_PRINCIPAL_ID }),
      }),
    );
    await withHttpServer(explicitContextApp, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/chat`)).status, 200);
    });
  } finally {
    database.close();
  }

  const reopened = new WorkspaceDatabase(databasePath, {
    migrations: WORKSPACE_MIGRATIONS,
  });
  try {
    assert.equal(reopened.migration?.currentVersion, 17);
    assert.equal(
      reopened
        .prepare("SELECT value FROM assistant_legacy_sentinel WHERE id=1")
        .get()?.value,
      "preserve",
    );
    assert.equal(
      count(
        reopened,
        "SELECT count(*) AS count FROM message_sources WHERE citation_ordinal IN (0,1)",
      ) >= 2,
      true,
      "assistant messages and citations survive restart",
    );
    assert.equal(reopened.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    reopened.close();
  }

  console.log("Vera workspace assistant audit passed.");
}

run()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Assistant audit failed.",
    );
    process.exitCode = 1;
  })
  .finally(() => rmSync(root, { recursive: true, force: true }));
