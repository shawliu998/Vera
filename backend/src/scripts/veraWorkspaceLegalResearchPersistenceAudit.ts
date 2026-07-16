import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WorkspaceDatabase,
  WORKSPACE_MIGRATIONS,
  workspaceMigrationChecksum,
} from "../lib/workspace/database";
import {
  LEGAL_RESEARCH_PERSISTENCE_V22_MIGRATION,
  type WorkspaceMigration,
} from "../lib/workspace/migrations";
import {
  WorkspaceLegalResearchOwnershipAdapterV22,
  WorkspaceLegalResearchRepository,
  WorkspaceLegalResearchSourceCaptureAdapterV22,
} from "../lib/workspace/repositories/legalResearch";
import { WorkspaceLegalResearchTools } from "../lib/workspace/services/legalResearchTools";
import { WorkspaceLegalResearchProviderRegistry } from "../lib/workspace/services/legalResearchProvider";
import { createDeterministicFakeLegalResearchProvider } from "../lib/workspace/services/testing/deterministicFakeLegalResearchProvider";

const NOW = "2026-07-16T12:00:00.000Z";
const LEASE_EXPIRES = "2099-07-16T13:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exists(database: WorkspaceDatabase, name: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = ?")
      .get(name),
  );
}

function insertAssistantOwner(database: WorkspaceDatabase) {
  const projectId = randomUUID();
  const modelId = randomUUID();
  const chatId = randomUUID();
  const jobId = randomUUID();
  const promptMessageId = randomUUID();
  const outputMessageId = randomUUID();
  const leaseOwner = `audit-worker-${randomUUID()}`;
  database
    .prepare(
      "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES (?,?,'active',?,?)",
    )
    .run(projectId, `Legal research Matter ${projectId}`, NOW, NOW);
  database
    .prepare(
      `INSERT INTO model_profiles
         (id,name,provider,model,credential_status,enabled,created_at,updated_at)
       VALUES (?,?,'openai','audit-model','not_configured',1,?,?)`,
    )
    .run(modelId, `Audit model ${modelId}`, NOW, NOW);
  database
    .prepare(
      `INSERT INTO chats
         (id,project_id,scope,title,status,model_profile_id,created_at,updated_at)
       VALUES (?,?,'project','Audit','active',?,?,?)`,
    )
    .run(chatId, projectId, modelId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO chat_messages
         (id,chat_id,sequence,role,content,status,created_at,updated_at,completed_at)
       VALUES (?,?,0,'user','research','complete',?,?,?)`,
    )
    .run(promptMessageId, chatId, NOW, NOW, NOW);
  database
    .prepare(
      `INSERT INTO jobs
         (id,type,status,resource_type,resource_id,attempt,max_attempts,retryable,
          payload_json,scheduled_at,locked_at,started_at,created_at,updated_at,
          queued_at,lease_owner,lease_expires_at)
       VALUES (?,'assistant_generate','running','chat',?,1,3,1,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      jobId,
      chatId,
      JSON.stringify({ projectId }),
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
      leaseOwner,
      LEASE_EXPIRES,
    );
  database
    .prepare(
      `INSERT INTO chat_messages
         (id,chat_id,sequence,role,content,status,model_profile_id,job_id,created_at,updated_at)
       VALUES (?,?,1,'assistant','','pending',?,?,?,?)`,
    )
    .run(outputMessageId, chatId, modelId, jobId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO assistant_generation_snapshots
         (job_id,chat_id,prompt_message_id,output_message_id,model_profile_id,
          current_version_only,retrieval_limit,created_at)
       VALUES (?,?,?,?,?,1,20,?)`,
    )
    .run(jobId, chatId, promptMessageId, outputMessageId, modelId, NOW);
  return {
    projectId,
    jobId,
    outputMessageId,
    owner: {
      projectId,
      jobId,
      attempt: 1,
      leaseOwner,
      researchSessionId: `${jobId}:1`,
    },
  } as const;
}

function insertAuthority(
  database: WorkspaceDatabase,
  projectId: string,
  sourceRecordId: string,
  modelUse: "permitted" | "local_only" = "permitted",
  quote = "本条法律规则仅用于 v22 持久层审计。",
) {
  const snapshotId = randomUUID();
  const anchorId = randomUUID();
  database
    .prepare(
      `INSERT INTO project_source_snapshots
         (id,project_id,source_kind,source_record_id,source_version_id,
          title_snapshot,content_sha256,locator_json,retrieved_at,license_json,
          retention_policy,retention_expires_at,retrieval_metadata_json,created_at)
       VALUES (?,?,'legal_authority',?,NULL,?,?,?,?,?,'full_text_permitted',NULL,'{}',?)`,
    )
    .run(
      snapshotId,
      projectId,
      sourceRecordId,
      "中华人民共和国审计法条",
      sha256(quote),
      JSON.stringify({ article: "第一条" }),
      NOW,
      JSON.stringify({
        basis: "deployment_contract",
        retention: "full_text_permitted",
        export: "exact_quotes_only",
        modelUse,
      }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO source_citation_anchors
         (id,project_id,snapshot_id,ordinal,exact_quote,quote_sha256,locator_json,created_at)
       VALUES (?,?,?,0,?,?,?,?)`,
    )
    .run(
      anchorId,
      projectId,
      snapshotId,
      quote,
      sha256(quote),
      JSON.stringify({ article: "第一条" }),
      NOW,
    );
  return { snapshotId, anchorId, quote };
}

function auditUpgradeAndRollback(root: string) {
  const upgradePath = path.join(root, "upgrade.sqlite");
  new WorkspaceDatabase(upgradePath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 21),
  }).close();
  const upgraded = new WorkspaceDatabase(upgradePath);
  assert.equal(upgraded.migration?.currentVersion, 22);
  assert.equal(
    upgraded
      .prepare("SELECT count(*) AS count FROM legal_research_sessions")
      .get()?.count,
    0,
  );
  upgraded.close();

  const rollbackPath = path.join(root, "rollback.sqlite");
  new WorkspaceDatabase(rollbackPath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 21),
  }).close();
  const failing: WorkspaceMigration = {
    ...LEGAL_RESEARCH_PERSISTENCE_V22_MIGRATION,
    name: "legal_research_v22_forced_rollback",
    checksumMaterial: `${LEGAL_RESEARCH_PERSISTENCE_V22_MIGRATION.checksumMaterial}\nforced`,
    apply(database, capabilities) {
      LEGAL_RESEARCH_PERSISTENCE_V22_MIGRATION.apply(database, capabilities);
      throw new Error("forced v22 rollback");
    },
  };
  assert.throws(
    () =>
      new WorkspaceDatabase(rollbackPath, {
        migrations: [...WORKSPACE_MIGRATIONS.slice(0, 21), failing],
      }),
    /rolled back/i,
  );
  const inspection = new WorkspaceDatabase(rollbackPath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 21),
  });
  assert.equal(exists(inspection, "legal_research_sessions"), false);
  assert.equal(
    inspection
      .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
      .get()?.count,
    21,
  );
  inspection.close();
}

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-legal-research-v22-"));
  const prior = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  let database: WorkspaceDatabase | null = null;
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    assert.equal(LEGAL_RESEARCH_PERSISTENCE_V22_MIGRATION.version, 22);
    assert.match(
      workspaceMigrationChecksum(LEGAL_RESEARCH_PERSISTENCE_V22_MIGRATION),
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      WORKSPACE_MIGRATIONS.map((migration) => migration.version),
      Array.from({ length: 22 }, (_, index) => index + 1),
    );
    auditUpgradeAndRollback(root);

    database = new WorkspaceDatabase(path.join(root, "fresh.sqlite"));
    for (const name of [
      "legal_research_sessions",
      "legal_research_queries",
      "legal_research_candidates",
      "legal_research_reads",
      "legal_research_read_anchors",
      "assistant_legal_authority_message_sources",
      "assistant_legal_authority_sources_v22_insert_guard",
    ]) {
      assert.ok(exists(database, name), name);
    }

    const assistant = insertAssistantOwner(database);
    let idCounter = 0;
    let sourceCounter = 0;
    const repository = new WorkspaceLegalResearchRepository(database, {
      now: () => NOW,
      nextId: () =>
        `22000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
      nextSourceRef: () => `source${String(++sourceCounter).padStart(26, "0")}`,
    });
    const ownership = new WorkspaceLegalResearchOwnershipAdapterV22(repository);
    const results = [
      {
        providerSourceId: "authority-001",
        title: "中华人民共和国审计法条",
        sourceType: "statute" as const,
        jurisdiction: "CN",
        summary: "有界权威摘要。",
      },
    ];
    const first = repository.recordSearch({
      owner: assistant.owner,
      providerId: "audit-provider",
      providerQueryId: "provider-query-001",
      results,
    });
    assert.equal(first.length, 1);
    assert.equal(first[0]!.durable, true);
    assert.equal(first[0]!.sourceRef.length, 32);
    const replay = repository.recordSearch({
      owner: assistant.owner,
      providerId: "audit-provider",
      providerQueryId: "provider-query-001",
      results,
    });
    assert.equal(replay[0]!.sourceRef, first[0]!.sourceRef);
    assert.throws(
      () =>
        repository.recordSearch({
          owner: assistant.owner,
          providerId: "audit-provider",
          providerQueryId: "provider-query-001",
          results: [{ ...results[0]!, title: "漂移结果" }],
        }),
      /changed its candidate set/i,
    );
    assert.throws(
      () =>
        repository.recordSearch({
          owner: assistant.owner,
          providerId: "audit-provider",
          providerQueryId: "https://provider.invalid/query",
          results,
        }),
      /endpoint|credential/i,
    );

    const read = repository.resolveOwnedSource({
      owner: assistant.owner,
      sourceRef: first[0]!.sourceRef,
    });
    const authority = insertAuthority(
      database,
      assistant.projectId,
      first[0]!.providerSourceId,
    );
    const localOnlyAuthority = insertAuthority(
      database,
      assistant.projectId,
      first[0]!.providerSourceId,
      "local_only",
    );
    assert.throws(
      () =>
        repository.bindReadCapture({
          owner: assistant.owner,
          readId: read.readId,
          sourceRef: read.sourceRef,
          snapshotId: localOnlyAuthority.snapshotId,
          anchorIds: [localOnlyAuthority.anchorId],
        }),
      /available source read/i,
    );
    const captured = repository.bindReadCapture({
      owner: assistant.owner,
      readId: read.readId,
      sourceRef: read.sourceRef,
      snapshotId: authority.snapshotId,
      anchorIds: [authority.anchorId],
    });
    assert.equal(captured.status, "captured");
    assert.deepEqual(captured.anchorIds, [authority.anchorId]);
    const evidence = repository.assistantEvidenceForCapturedRead({
      owner: assistant.owner,
      sourceRef: read.sourceRef,
      snapshotId: authority.snapshotId,
      anchorIds: [authority.anchorId],
    });
    assert.equal(evidence[0]!.kind, "legal_authority");
    assert.equal(evidence[0]!.exactQuote, authority.quote);

    const bound = repository.bindAssistantAuthoritySources({
      owner: assistant.owner,
      messageId: assistant.outputMessageId,
      sources: [
        {
          id: randomUUID(),
          readId: read.readId,
          anchorId: authority.anchorId,
          citationOrdinal: 0,
          citationMetadata: { citationNumber: 1, label: "第一条" },
        },
      ],
    });
    assert.equal(bound.length, 1);
    assert.equal(bound[0]!.anchorId, authority.anchorId);

    const provider = createDeterministicFakeLegalResearchProvider({
      testingOnly: true,
    });
    const capture = new WorkspaceLegalResearchSourceCaptureAdapterV22(
      {
        async capture(input) {
          const persisted = insertAuthority(
            database!,
            input.context.projectId,
            input.document.providerSourceId,
            "permitted",
            input.document.content,
          );
          return {
            snapshotId: persisted.snapshotId,
            excerpts: [
              {
                anchorCandidateId: persisted.anchorId,
                text: persisted.quote,
                locator: input.document.locator,
              },
            ],
          };
        },
      },
      ownership,
    );
    const tools = new WorkspaceLegalResearchTools(
      provider.id,
      WorkspaceLegalResearchProviderRegistry.forTesting([provider]),
      ownership,
      capture,
    );
    const toolContext = {
      ...assistant.owner,
      modelExecution: "remote" as const,
    };
    const delegatedSearch = (await tools.search({
      context: toolContext,
      rawInput: { query: "deterministic", limit: 1 },
      signal: new AbortController().signal,
    })) as { results: Array<{ sourceRef: string }> };
    const delegatedRead = (await tools.read({
      context: toolContext,
      rawInput: { sourceRef: delegatedSearch.results[0]!.sourceRef },
      signal: new AbortController().signal,
    })) as {
      durable: boolean;
      snapshotId: string;
      excerpts: Array<{ anchorCandidateId: string }>;
    };
    assert.equal(delegatedRead.durable, true);
    assert.equal(
      repository.assistantEvidenceForCapturedRead({
        owner: assistant.owner,
        sourceRef: delegatedSearch.results[0]!.sourceRef,
        snapshotId: delegatedRead.snapshotId,
        anchorIds: delegatedRead.excerpts.map(
          (excerpt) => excerpt.anchorCandidateId,
        ),
      }).length,
      1,
    );

    assert.throws(
      () =>
        repository.resolveOwnedSource({
          owner: { ...assistant.owner, projectId: randomUUID() },
          sourceRef: first[0]!.sourceRef,
        }),
      /lease/i,
    );
    database
      .prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", assistant.jobId);
    assert.throws(() => repository.ensureSession(assistant.owner), /lease/i);
    database
      .prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
      .run(LEASE_EXPIRES, assistant.jobId);
    database
      .prepare(
        `UPDATE project_source_snapshot_lifecycle
            SET access_state='tombstoned',tombstone_reason='policy_revoked',
                tombstoned_at_epoch_ms=updated_at_epoch_ms,
                cleanup_state='blocked_legacy_anchor'
          WHERE project_id=? AND snapshot_id=?`,
      )
      .run(assistant.projectId, authority.snapshotId);
    assert.throws(
      () => repository.listAssistantAuthoritySources(assistant.outputMessageId),
      /retention policy/i,
    );
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    const persisted = JSON.stringify(
      database
        .prepare(
          `SELECT provider_query_id,provider_source_id,summary_snapshot
             FROM legal_research_queries query
             JOIN legal_research_candidates candidate ON candidate.query_id=query.id`,
        )
        .all(),
    );
    assert.equal(/https?:\/\/|bearer|sk_/i.test(persisted), false);
    database
      .prepare(
        "UPDATE chat_messages SET status='complete',completed_at=?,updated_at=? WHERE id=?",
      )
      .run(NOW, NOW, assistant.outputMessageId);
    assert.throws(() => repository.ensureSession(assistant.owner), /lease/i);
    console.log("Workspace legal research persistence v22 audit passed.");
  } finally {
    database?.close();
    if (prior === undefined) delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    else process.env.ALETHEIA_DATABASE_ENCRYPTION = prior;
    rmSync(root, { recursive: true, force: true });
  }
}

void run();
