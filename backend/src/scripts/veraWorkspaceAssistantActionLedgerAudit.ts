import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WorkspaceDatabase,
  WORKSPACE_MIGRATIONS,
  workspaceMigrationChecksum,
} from "../lib/workspace/database";
import { ASSISTANT_ACTION_LEDGER_V19_MIGRATION } from "../lib/workspace/migrations";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import {
  ASSISTANT_ACTION_BUDGETS,
  WorkspaceAssistantActionLedger,
  WorkspaceAssistantActionLedgerError,
  hashAssistantActionInput,
  type AssistantActionType,
} from "../lib/workspace/services/assistantActionLedger";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";

const CREATED_AT = "2026-07-16T01:00:00.000Z";
const CLAIMED_AT = "2026-07-16T01:01:00.000Z";
const LEASE_EXPIRES_AT = "2099-07-16T01:11:00.000Z";
const FAILED_AT = "2026-07-16T01:02:00.000Z";
const RETRIED_AT = "2026-07-16T01:03:00.000Z";
const RECLAIMED_AT = "2026-07-16T01:04:00.000Z";
const RECLAIM_LEASE_EXPIRES_AT = "2099-07-16T01:14:00.000Z";
const FIRST_LEASE_OWNER = "action-ledger-worker-1";
const SECOND_LEASE_OWNER = "action-ledger-worker-2";

function assertLedgerError(
  operation: () => unknown,
  code: WorkspaceAssistantActionLedgerError["code"],
) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof WorkspaceAssistantActionLedgerError);
    assert.equal(error.code, code);
    return true;
  });
}

function seedModelProfile(database: WorkspaceDatabase) {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO model_profiles
        (id,name,provider,model,credential_status,credential_state,
         capabilities_json,settings_json,enabled,is_default,
         connection_revision,created_at,updated_at)
       VALUES (?,?,'openai',?,'not_configured','missing',?,'{}',1,0,0,?,?)`,
    )
    .run(
      id,
      `Action ledger ${id}`,
      `model-${id}`,
      JSON.stringify({
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
      }),
      CREATED_AT,
      CREATED_AT,
    );
  return id;
}

function seedRunningGeneration(database: WorkspaceDatabase) {
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const chatId = randomUUID();
  const promptMessageId = randomUUID();
  const outputMessageId = randomUUID();
  const jobId = randomUUID();
  const modelProfileId = seedModelProfile(database);
  const projects = new ProjectsRepository(database);
  for (const [id, name] of [
    [projectId, "Action ledger Matter"],
    [otherProjectId, "Other Matter"],
  ] as const) {
    projects.create({
      id,
      name,
      description: null,
      cmNumber: null,
      practice: null,
      now: CREATED_AT,
    });
  }
  database
    .prepare(
      `INSERT INTO chats
        (id,project_id,scope,title,status,model_profile_id,created_at,updated_at)
       VALUES (?,?,'project','Action ledger','active',?,?,?)`,
    )
    .run(chatId, projectId, modelProfileId, CREATED_AT, CREATED_AT);
  const jobs = new WorkspaceJobsRepository(database);
  new WorkspaceJobsService(jobs, {
    now: () => new Date(CREATED_AT),
    createId: () => jobId,
  }).createJob({
    type: "assistant_generate",
    payload: {
      schema: "vera-assistant-generation-v1",
      chatId,
      projectId,
      promptMessageId,
      outputMessageId,
      modelProfileId,
      documents: [],
      retrieval: { currentVersionOnly: true, limit: 40 },
    },
    resourceType: "chat",
    resourceId: chatId,
    maxAttempts: 3,
  });
  database
    .prepare(
      `INSERT INTO chat_messages
        (id,chat_id,sequence,role,content,status,model_profile_id,job_id,
         created_at,updated_at,completed_at)
       VALUES (?,?,0,'user','Create a legal work product.','complete',NULL,NULL,?,?,?),
              (?,?,1,'assistant','','pending',?,?,?,?,NULL)`,
    )
    .run(
      promptMessageId,
      chatId,
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
      outputMessageId,
      chatId,
      modelProfileId,
      jobId,
      CREATED_AT,
      CREATED_AT,
    );
  database
    .prepare(
      `INSERT INTO assistant_generation_snapshots
        (job_id,chat_id,prompt_message_id,output_message_id,model_profile_id,
         current_version_only,retrieval_limit,created_at)
       VALUES (?,?,?,?,?,1,40,?)`,
    )
    .run(
      jobId,
      chatId,
      promptMessageId,
      outputMessageId,
      modelProfileId,
      CREATED_AT,
    );
  const claim = jobs.claimNextQueued(
    CLAIMED_AT,
    FIRST_LEASE_OWNER,
    LEASE_EXPIRES_AT,
  );
  assert.ok(claim);
  assert.equal(claim.id, jobId);
  assert.equal(claim.attempt, 1);
  return { projectId, otherProjectId, chatId, jobId, jobs, claim };
}

function reserveInput(
  fixture: ReturnType<typeof seedRunningGeneration>,
  actionType: AssistantActionType,
  actionKey: string,
  input: unknown,
  attempt = 1,
) {
  return {
    jobId: fixture.jobId,
    attempt,
    leaseOwner: attempt === 1 ? FIRST_LEASE_OWNER : SECOND_LEASE_OWNER,
    projectId: fixture.projectId,
    actionType,
    actionKey,
    input,
  } as const;
}

function schemaObjects(database: WorkspaceDatabase, type: string) {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type=? ORDER BY name")
      .all(type)
      .map((row) => String(row.name)),
  );
}

function auditUpgrade(root: string) {
  const pathName = path.join(root, "upgrade-v18.sqlite");
  let fixture!: ReturnType<typeof seedRunningGeneration>;
  const v18 = new WorkspaceDatabase(pathName, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 18),
  });
  try {
    assert.equal(v18.migration?.currentVersion, 18);
    fixture = seedRunningGeneration(v18);
    v18
      .prepare(
        `INSERT INTO assistant_generation_events
          (job_id,sequence,attempt,event_type,event_json,terminal,created_at)
         VALUES (?,1,1,'content_delta',?,0,?)`,
      )
      .run(
        fixture.jobId,
        JSON.stringify({ type: "content_delta", delta: "retained-v10-event" }),
        CLAIMED_AT,
      );
  } finally {
    v18.close();
  }
  const upgraded = new WorkspaceDatabase(pathName);
  try {
    assert.equal(upgraded.migration?.currentVersion, 22);
    assert.deepEqual(
      {
        ...upgraded
          .prepare(
            `SELECT job_id,sequence,attempt,event_type,event_json,terminal,created_at
               FROM assistant_generation_events WHERE job_id=? AND sequence=1`,
          )
          .get(fixture.jobId),
      },
      {
        job_id: fixture!.jobId,
        sequence: 1,
        attempt: 1,
        event_type: "content_delta",
        event_json: JSON.stringify({
          type: "content_delta",
          delta: "retained-v10-event",
        }),
        terminal: 0,
        created_at: CLAIMED_AT,
      },
    );
    assert.ok(schemaObjects(upgraded, "table").has("assistant_action_ledger"));
    assert.equal(
      upgraded
        .prepare("PRAGMA foreign_key_list(assistant_generation_events)")
        .all()
        .some((row) => row.table === "assistant_generation_snapshots"),
      true,
    );
    const draftId = randomUUID();
    const versionId = randomUUID();
    const draftEvent = JSON.stringify({
      type: "draft_created",
      draft_id: draftId,
      version_id: versionId,
      title: "Created Draft",
      route: `/projects/${fixture!.projectId}/documents/${draftId}/studio`,
    });
    upgraded
      .prepare(
        `INSERT INTO assistant_generation_events
          (job_id,sequence,attempt,event_type,event_json,terminal,created_at)
         VALUES (?,2,1,'draft_created',?,0,?)`,
      )
      .run(fixture!.jobId, draftEvent, CLAIMED_AT);
    assert.throws(() =>
      upgraded
        .prepare(
          `UPDATE assistant_generation_events SET event_json=?
            WHERE job_id=? AND sequence=2`,
        )
        .run(draftEvent, fixture!.jobId),
    );
    assert.throws(() =>
      upgraded
        .prepare(
          `INSERT INTO assistant_generation_events
            (job_id,sequence,attempt,event_type,event_json,terminal,created_at)
           VALUES (?,3,1,'draft_created',?,1,?)`,
        )
        .run(fixture!.jobId, draftEvent, CLAIMED_AT),
    );
    upgraded
      .prepare(
        `INSERT INTO assistant_generation_events
          (job_id,sequence,attempt,event_type,event_json,terminal,created_at)
         VALUES (?,3,1,'complete',?,1,?)`,
      )
      .run(
        fixture!.jobId,
        JSON.stringify({
          type: "complete",
          message_id: randomUUID(),
          job_id: fixture!.jobId,
        }),
        CLAIMED_AT,
      );
    assert.throws(() =>
      upgraded
        .prepare(
          `INSERT INTO assistant_generation_events
            (job_id,sequence,attempt,event_type,event_json,terminal,created_at)
           VALUES (?,4,1,'error',?,1,?)`,
        )
        .run(
          fixture!.jobId,
          JSON.stringify({ type: "error", code: "duplicate_terminal" }),
          CLAIMED_AT,
        ),
    );
  } finally {
    upgraded.close();
  }
}

function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-action-ledger-"));
  let database: WorkspaceDatabase | null = null;
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    assert.equal(ASSISTANT_ACTION_LEDGER_V19_MIGRATION.version, 19);
    assert.match(
      workspaceMigrationChecksum(ASSISTANT_ACTION_LEDGER_V19_MIGRATION),
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      WORKSPACE_MIGRATIONS.map((migration) => migration.version),
      Array.from({ length: 22 }, (_, index) => index + 1),
    );
    assert.deepEqual(ASSISTANT_ACTION_BUDGETS, {
      create_draft: 1,
      suggest_draft_edit: 5,
      run_workflow: 2,
    });
    assert.equal(
      hashAssistantActionInput({ b: 2, a: [true, null] }),
      hashAssistantActionInput({ a: [true, null], b: 2 }),
      "input hashing must be stable across object key ordering",
    );

    auditUpgrade(root);
    database = new WorkspaceDatabase(path.join(root, "fresh.sqlite"));
    assert.equal(database.migration?.currentVersion, 22);
    for (const name of [
      "assistant_action_ledger_v19_insert_guard",
      "assistant_action_ledger_v19_update_guard",
    ]) {
      assert.ok(schemaObjects(database, "trigger").has(name));
    }
    for (const name of [
      "idx_assistant_action_ledger_budget",
      "idx_assistant_action_ledger_resource",
    ]) {
      assert.ok(schemaObjects(database, "index").has(name));
    }

    const fixture = seedRunningGeneration(database);
    let ledgerNow = Date.parse("2026-07-16T01:05:00.000Z");
    const ledger = new WorkspaceAssistantActionLedger(
      database,
      () => new Date(ledgerNow++),
    );
    const create = reserveInput(
      fixture,
      "create_draft",
      "logical:create:opinion",
      { title: "Opinion", sourceIds: ["source-a"] },
    );
    assertLedgerError(
      () => ledger.reserve({ ...create, leaseOwner: "wrong-lease-owner" }),
      "GENERATION_LEASE_INVALID",
    );
    assert.throws(() =>
      database!
        .prepare(
          `INSERT INTO assistant_action_ledger
            (job_id,action_key,action_type,project_id,input_sha256,status,
             reserved_attempt,reserved_lease_owner,created_at,updated_at)
           VALUES (?,?,'create_draft',?,?,'reserved',1,?,?,?)`,
        )
        .run(
          fixture.jobId,
          "direct:wrong-owner",
          fixture.projectId,
          "c".repeat(64),
          "wrong-lease-owner",
          "2026-07-16T01:05:00.000Z",
          "2026-07-16T01:05:00.000Z",
        ),
    );
    ledgerNow = Date.parse("2100-07-16T01:12:00.000Z");
    assertLedgerError(() => ledger.reserve(create), "GENERATION_LEASE_INVALID");
    assert.throws(() =>
      database!
        .prepare(
          `INSERT INTO assistant_action_ledger
            (job_id,action_key,action_type,project_id,input_sha256,status,
             reserved_attempt,reserved_lease_owner,created_at,updated_at)
           VALUES (?,?,'create_draft',?,?,'reserved',1,?,?,?)`,
        )
        .run(
          fixture.jobId,
          "direct:expired-lease",
          fixture.projectId,
          "d".repeat(64),
          FIRST_LEASE_OWNER,
          "2100-07-16T01:12:00.000Z",
          "2100-07-16T01:12:00.000Z",
        ),
    );
    ledgerNow = Date.parse("2026-07-16T01:05:00.000Z");
    const cancelledFixture = seedRunningGeneration(database);
    cancelledFixture.jobs.requestCancellation(
      cancelledFixture.jobId,
      "2026-07-16T01:05:00.000Z",
      "action ledger cancellation fence audit",
    );
    const cancelledInput = reserveInput(
      cancelledFixture,
      "create_draft",
      "logical:create:cancelled",
      { title: "Cancelled" },
    );
    assertLedgerError(
      () => ledger.reserve(cancelledInput),
      "GENERATION_CANCEL_REQUESTED",
    );
    assert.throws(() =>
      database!
        .prepare(
          `INSERT INTO assistant_action_ledger
            (job_id,action_key,action_type,project_id,input_sha256,status,
             reserved_attempt,reserved_lease_owner,created_at,updated_at)
           VALUES (?,?,'create_draft',?,?,'reserved',1,?,?,?)`,
        )
        .run(
          cancelledFixture.jobId,
          "direct:cancelled",
          cancelledFixture.projectId,
          "e".repeat(64),
          FIRST_LEASE_OWNER,
          "2026-07-16T01:05:00.000Z",
          "2026-07-16T01:05:00.000Z",
        ),
    );
    const first = ledger.reserve(create);
    assert.equal(first.created, true);
    assert.equal(first.record.status, "reserved");
    assert.equal(first.record.reservedAttempt, 1);
    assert.equal(first.record.reservedLeaseOwner, FIRST_LEASE_OWNER);
    assertLedgerError(
      () =>
        ledger.complete({
          ...create,
          leaseOwner: "wrong-lease-owner",
          resourceType: "draft",
          resourceId: "draft-opinion",
        }),
      "GENERATION_LEASE_INVALID",
    );
    assert.throws(() =>
      database!
        .prepare(
          `UPDATE assistant_action_ledger
              SET status='complete',completed_attempt=1,
                  completed_lease_owner='wrong-lease-owner',
                  resource_type='draft',resource_id='draft-opinion',
                  updated_at=?,completed_at=?
            WHERE job_id=? AND action_key=?`,
        )
        .run(
          "2026-07-16T01:05:00.100Z",
          "2026-07-16T01:05:00.100Z",
          fixture.jobId,
          create.actionKey,
        ),
    );
    ledgerNow = Date.parse("2100-07-16T01:12:00.000Z");
    assertLedgerError(
      () =>
        ledger.complete({
          ...create,
          resourceType: "draft",
          resourceId: "draft-opinion",
        }),
      "GENERATION_LEASE_INVALID",
    );
    assert.throws(() =>
      database!
        .prepare(
          `UPDATE assistant_action_ledger
              SET status='complete',completed_attempt=1,
                  completed_lease_owner=?,resource_type='draft',
                  resource_id='draft-opinion',updated_at=?,completed_at=?
            WHERE job_id=? AND action_key=?`,
        )
        .run(
          FIRST_LEASE_OWNER,
          "2100-07-16T01:12:00.000Z",
          "2100-07-16T01:12:00.000Z",
          fixture.jobId,
          create.actionKey,
        ),
    );
    ledgerNow = Date.parse("2026-07-16T01:05:01.000Z");
    const cancelledCompletionFixture = seedRunningGeneration(database);
    const cancelledCompletionInput = reserveInput(
      cancelledCompletionFixture,
      "create_draft",
      "logical:create:cancelled-completion",
      { title: "Cancel after reserve" },
    );
    ledger.reserve(cancelledCompletionInput);
    cancelledCompletionFixture.jobs.requestCancellation(
      cancelledCompletionFixture.jobId,
      "2026-07-16T01:05:02.000Z",
      "completion cancellation fence audit",
    );
    assertLedgerError(
      () =>
        ledger.complete({
          ...cancelledCompletionInput,
          resourceType: "draft",
          resourceId: "cancelled-completion-draft",
        }),
      "GENERATION_CANCEL_REQUESTED",
    );
    assert.throws(() =>
      database!
        .prepare(
          `UPDATE assistant_action_ledger
              SET status='complete',completed_attempt=1,
                  completed_lease_owner=?,resource_type='draft',
                  resource_id='cancelled-completion-draft',
                  updated_at=?,completed_at=?
            WHERE job_id=? AND action_key=?`,
        )
        .run(
          FIRST_LEASE_OWNER,
          "2026-07-16T01:05:03.000Z",
          "2026-07-16T01:05:03.000Z",
          cancelledCompletionFixture.jobId,
          cancelledCompletionInput.actionKey,
        ),
    );
    ledgerNow = Date.parse("2026-07-16T01:05:04.000Z");
    const replay = ledger.reserve({
      ...create,
      input: { sourceIds: ["source-a"], title: "Opinion" },
    });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.record, first.record);
    assertLedgerError(
      () => ledger.reserve({ ...create, input: { title: "Changed" } }),
      "ACTION_CONFLICT",
    );
    assertLedgerError(
      () => ledger.reserve({ ...create, actionType: "run_workflow" }),
      "ACTION_CONFLICT",
    );
    assertLedgerError(
      () =>
        ledger.reserve({
          ...create,
          projectId: fixture.otherProjectId,
        }),
      "MATTER_MISMATCH",
    );
    assertLedgerError(
      () =>
        ledger.reserve(
          reserveInput(fixture, "create_draft", "logical:create:second", {
            title: "Second",
          }),
        ),
      "ACTION_BUDGET_EXHAUSTED",
    );

    const suggestionInputs = Array.from({ length: 5 }, (_, index) =>
      reserveInput(fixture, "suggest_draft_edit", `logical:suggest:${index}`, {
        draftId: "draft-a",
        ordinal: index,
      }),
    );
    for (const input of suggestionInputs) {
      assert.equal(ledger.reserve(input).created, true);
    }
    assertLedgerError(
      () =>
        ledger.reserve(
          reserveInput(
            fixture,
            "suggest_draft_edit",
            "logical:suggest:overflow",
            { draftId: "draft-a", ordinal: 5 },
          ),
        ),
      "ACTION_BUDGET_EXHAUSTED",
    );

    const workflowInputs = Array.from({ length: 2 }, (_, index) =>
      reserveInput(fixture, "run_workflow", `logical:workflow:${index}`, {
        workflowId: `workflow-${index}`,
      }),
    );
    for (const input of workflowInputs) {
      assert.equal(ledger.reserve(input).created, true);
    }
    assertLedgerError(
      () =>
        ledger.reserve(
          reserveInput(fixture, "run_workflow", "logical:workflow:overflow", {
            workflowId: "workflow-overflow",
          }),
        ),
      "ACTION_BUDGET_EXHAUSTED",
    );

    fixture.jobs.finishClaim({
      id: fixture.jobId,
      leaseOwner: FIRST_LEASE_OWNER,
      attempt: 1,
      event: {
        type: "fail",
        at: FAILED_AT,
        error: {
          code: "audit_retry",
          message: "Exercise stable logical action replay.",
          retryable: true,
        },
      },
    });
    fixture.jobs.retryJob(fixture.jobId, RETRIED_AT);
    const secondClaim = fixture.jobs.claimNextQueued(
      RECLAIMED_AT,
      SECOND_LEASE_OWNER,
      RECLAIM_LEASE_EXPIRES_AT,
    );
    assert.ok(secondClaim);
    assert.equal(secondClaim.id, fixture.jobId);
    assert.equal(secondClaim.attempt, 2);
    const retryReplay = ledger.reserve({
      ...create,
      attempt: 2,
      leaseOwner: SECOND_LEASE_OWNER,
    });
    assert.equal(retryReplay.created, false);
    assert.equal(retryReplay.record.reservedAttempt, 1);
    assertLedgerError(
      () =>
        ledger.reserve({
          ...create,
          attempt: 1,
          leaseOwner: FIRST_LEASE_OWNER,
        }),
      "GENERATION_ATTEMPT_STALE",
    );

    const completed = ledger.complete({
      ...create,
      attempt: 2,
      leaseOwner: SECOND_LEASE_OWNER,
      resourceType: "draft",
      resourceId: "draft-opinion",
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.record.status, "complete");
    assert.equal(completed.record.completedAttempt, 2);
    assert.equal(completed.record.completedLeaseOwner, SECOND_LEASE_OWNER);
    assert.equal(completed.record.resourceId, "draft-opinion");
    const completeReplay = ledger.complete({
      ...create,
      attempt: 2,
      leaseOwner: SECOND_LEASE_OWNER,
      resourceType: "draft",
      resourceId: "draft-opinion",
    });
    assert.equal(completeReplay.completed, false);
    assertLedgerError(
      () =>
        ledger.complete({
          ...create,
          attempt: 2,
          leaseOwner: SECOND_LEASE_OWNER,
          resourceType: "draft",
          resourceId: "draft-changed",
        }),
      "ACTION_STATE_CONFLICT",
    );
    assertLedgerError(
      () =>
        ledger.complete({
          ...workflowInputs[0]!,
          attempt: 2,
          leaseOwner: SECOND_LEASE_OWNER,
          resourceType: "draft",
          resourceId: "wrong-type",
        }),
      "ACTION_CONFLICT",
    );
    assert.throws(() =>
      database!
        .prepare(
          `UPDATE assistant_action_ledger
            SET resource_id='direct-mutation'
          WHERE job_id=? AND action_key=?`,
        )
        .run(fixture.jobId, create.actionKey),
    );
    assert.throws(() =>
      database!
        .prepare(
          `INSERT INTO assistant_action_ledger
            (job_id,action_key,action_type,project_id,input_sha256,status,
             reserved_attempt,completed_attempt,resource_type,resource_id,
             reserved_lease_owner,completed_lease_owner,
             created_at,updated_at,completed_at)
           VALUES (?,?,'run_workflow',?,?,'complete',2,2,'workflow_run',?,?,?, ?,?,?,?)`,
        )
        .run(
          fixture.jobId,
          "direct:complete-without-reserve",
          fixture.projectId,
          "b".repeat(64),
          randomUUID(),
          SECOND_LEASE_OWNER,
          SECOND_LEASE_OWNER,
          RECLAIMED_AT,
          RECLAIMED_AT,
          RECLAIMED_AT,
        ),
    );
    assert.throws(() =>
      database!
        .prepare(
          `INSERT INTO assistant_action_ledger
          (job_id,action_key,action_type,project_id,input_sha256,status,
           reserved_attempt,reserved_lease_owner,created_at,updated_at)
         VALUES (?,?, 'run_workflow', ?, ?, 'reserved', 2, ?, ?, ?)`,
        )
        .run(
          fixture.jobId,
          "direct:cross-matter",
          fixture.otherProjectId,
          "a".repeat(64),
          SECOND_LEASE_OWNER,
          RECLAIMED_AT,
          RECLAIMED_AT,
        ),
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-workspace-assistant-action-ledger-v19",
          checks: [
            "fresh and v18 upgrade migrations preserve v10 events and install the v19 schema",
            "draft_created is nonterminal while v10 foreign-key, index, terminal, and immutability constraints remain intact",
            "stable canonical input hashes make same-key retries idempotent",
            "input, type, Matter, and stale-attempt conflicts fail closed",
            "wrong owner, expired lease, and requested cancellation reject reserve and complete in both service and SQLite guards",
            "per-job action budgets are durably bounded at create=1 suggest=5 workflow=2",
            "retry reuses the original reservation while recording completion on the current attempt",
            "only reserved-to-complete is accepted and completed resources are immutable",
            "database triggers independently enforce current Matter, attempt, budget, and state invariants",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

run();
