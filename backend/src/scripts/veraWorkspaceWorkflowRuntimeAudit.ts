import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";

import {
  WORKSPACE_MIGRATIONS,
  WorkspaceDatabase,
} from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WORKFLOW_RUNTIME_V6_MIGRATION } from "../lib/workspace/migrations/v6WorkflowRuntime";
import {
  WORKSPACE_WORKFLOW_EXECUTION_CAPABILITY,
  createWorkspaceWorkflowsV1Router,
  type WorkspaceWorkflowsV1Port,
} from "../routes/workspaceWorkflowsV1";
import {
  WorkspaceJobsRepository,
  WorkspaceJobLeaseLostError,
} from "../lib/workspace/repositories/jobs";
import { WorkflowsRepository } from "../lib/workspace/repositories/workflows";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";
import { WorkspaceJobEnqueuerAdapter } from "../lib/workspace/services/jobEnqueuer";
import {
  WorkspaceWorkflowRuntime,
  type WorkflowStepExecutor,
} from "../lib/workspace/services/workflowRuntime";
import { WorkflowsService } from "../lib/workspace/services/workflows";
import {
  MIKE_SYSTEM_WORKFLOWS_SOURCE_SHA256,
  MikeWorkflowCrudPortAdapter,
  loadPinnedMikeSystemWorkflowSeeds,
  parseMikeWorkflowCreate,
  parseMikeWorkflowUpdate,
  seedPinnedMikeSystemWorkflows,
  serializeMikeWorkflow,
} from "../lib/workspace/workflowCompatibility";

const PROJECT = "10000000-0000-4000-8000-000000000001";
const OTHER_PROJECT = "10000000-0000-4000-8000-000000000002";
const MODEL = "20000000-0000-4000-8000-000000000001";
const PRE_V6_MIGRATIONS = WORKSPACE_MIGRATIONS.filter(
  (migration) => migration.version < 6,
);
let serial = 1;
function nextUuid() {
  const suffix = (serial++).toString(16).padStart(12, "0");
  return `90000000-0000-4000-8000-${suffix}`;
}
let tick = 0;
function clock() {
  const value = new Date(Date.UTC(2026, 6, 14, 12, 0, tick));
  tick += 1;
  return value;
}

function expectWorkspaceError(operation: () => unknown, status: number) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof WorkspaceApiError);
    assert.equal(error.status, status);
    return true;
  });
}

function seed(database: WorkspaceDatabase) {
  const now = clock().toISOString();
  database
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, credential_status, capabilities_json,
         settings_json, enabled, created_at, updated_at)
       VALUES (?, 'Audit Model', 'openai', 'audit-model', 'configured', ?, '{}', 1, ?, ?)`,
    )
    .run(
      MODEL,
      JSON.stringify({
        streaming: true,
        toolCalling: false,
        structuredOutput: true,
        vision: false,
      }),
      now,
      now,
    );
  if (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='model_profile_connection_tests'",
      )
      .get()
  ) {
    database
      .prepare(
        `INSERT INTO model_profile_connection_tests
          (profile_id,connection_revision,status,error_code,retryable,latency_ms,tested_at)
         VALUES (?,0,'passed',NULL,0,1,?)`,
      )
      .run(MODEL, now);
  }
  if (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='model_profile_privacy'",
      )
      .get()
  ) {
    new ModelProfilePrivacyRepository(database).declare(
      MODEL,
      {
        executionLocation: "local",
        retention: "zero",
        trainingUse: "prohibited",
        sensitiveDataAllowed: true,
      },
      now,
    );
  }
  for (const [id, name] of [
    [PROJECT, "Audit Project"],
    [OTHER_PROJECT, "Other Project"],
  ] as const) {
    database
      .prepare(
        `INSERT INTO projects
          (id, name, default_model_profile_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, name, MODEL, now, now);
  }
  database
    .prepare(
      "UPDATE workspace_settings SET default_project_id = ?, default_model_profile_id = ? WHERE id = 'workspace'",
    )
    .run(PROJECT, MODEL);
}

const executor: WorkflowStepExecutor = {
  executeStep: () => ({ status: "complete", output: { audited: true } }),
};

function createWorkflow(service: WorkflowsService, title: string) {
  return service.create({
    type: "assistant",
    title,
    skillMarkdown: "Summarize the selected documents.",
    steps: [
      {
        kind: "prompt",
        title: "Summarize",
        prompt: "Produce a concise summary.",
      },
    ],
  });
}

function markRetryableFailure(workflows: WorkflowsService, runId: string) {
  const error = {
    code: "temporary",
    message: "temporary failure",
    retryable: true,
    details: null,
  };
  // Drive both run and job terminal state through the shared JobEnqueuer
  // state machine; retry tests must never fake parent failures in SQL.
  workflows.startStep(runId, 0, {});
  workflows.failStep(runId, 0, error);
}

function createClaimedContext(
  repository: WorkspaceJobsRepository,
  jobId: string,
) {
  const now = clock().toISOString();
  const claimed = repository.claimNextQueuedForTypes(
    now,
    ["workflow_run"],
    "workflow-runtime-audit",
    new Date(Date.parse(now) + 60_000).toISOString(),
  );
  assert.ok(claimed);
  assert.equal(claimed.id, jobId);
  assert.ok(claimed.leaseOwner);
  return {
    signal: new AbortController().signal,
    job: claimed,
    claim: { leaseOwner: claimed.leaseOwner, attempt: claimed.attempt },
  };
}

async function auditRouter(
  port: WorkspaceWorkflowsV1Port,
  workflow: ReturnType<typeof serializeMikeWorkflow>,
) {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/unauthenticated-workflows", createWorkspaceWorkflowsV1Router(port));
  app.use("/workflows", (_request, response, next) => {
    response.locals.userId = WORKSPACE_LOCAL_PRINCIPAL_ID;
    next();
  });
  app.use("/workflows", createWorkspaceWorkflowsV1Router(port));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/workflows`;
  try {
    const unauthenticated = await fetch(
      `http://127.0.0.1:${address.port}/unauthenticated-workflows`,
    );
    assert.equal(unauthenticated.status, 401);
    const listed = await fetch(`${base}?type=assistant`);
    assert.equal(listed.status, 200);
    assert.ok(
      (await listed.json()).some(
        (item: { id: string }) => item.id === workflow.id,
      ),
    );
    const hide = await fetch(`${base}/hidden`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: workflow.id }),
    });
    assert.equal(hide.status, 204);
    const run = await fetch(`${base}/${workflow.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotency_key: "workflow-route-audit",
        input_binding: {},
      }),
    });
    assert.equal(run.status, 503);
    assert.equal(WORKSPACE_WORKFLOW_EXECUTION_CAPABILITY.enabled, true);
    const unsafe = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metadata: { title: "unsafe", type: "assistant" },
        storage_path: "/Users/audit/private.md",
      }),
    });
    assert.equal(unsafe.status, 422);
    const excluded = await fetch(`${base}/${workflow.id}/open-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(excluded.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function auditV6Upgrade(root: string) {
  const databasePath = path.join(root, "workflow-v6-upgrade.sqlite");
  const database = new WorkspaceDatabase(databasePath, {
    migrations: PRE_V6_MIGRATIONS,
  });
  try {
    seed(database);
    const workflowId = nextUuid();
    const runningRunId = nextUuid();
    const completedRunId = nextUuid();
    const jobId = nextUuid();
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO workflows
          (id, type, project_id, title, created_at, updated_at)
         VALUES (?, 'assistant', NULL, 'Legacy workflow', ?, ?)`,
      )
      .run(workflowId, now, now);
    database
      .prepare(
        `INSERT INTO jobs
          (id, type, status, resource_type, resource_id, attempt, max_attempts,
           retryable, payload_json, scheduled_at, queued_at, locked_at,
           lease_owner, lease_expires_at, created_at, updated_at)
         VALUES (?, 'workflow_run', 'running', 'workflow_run', ?, 1, 1, 1,
                 '{}', ?, ?, ?, 'legacy-worker', ?, ?, ?)`,
      )
      .run(
        jobId,
        runningRunId,
        now,
        now,
        now,
        "2099-01-01T00:00:00.000Z",
        now,
        now,
      );
    const insertRun = database.prepare(
      `INSERT INTO workflow_runs
        (id, workflow_id, project_id, model_profile_id, job_id, status,
         input_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    );
    insertRun.run(
      runningRunId,
      workflowId,
      PROJECT,
      MODEL,
      jobId,
      "running",
      now,
      now,
    );
    insertRun.run(
      completedRunId,
      workflowId,
      PROJECT,
      MODEL,
      null,
      "complete",
      now,
      now,
    );
    database
      .prepare(
        `INSERT INTO workflow_step_runs
          (id, workflow_run_id, ordinal, attempt, step_json, status, input_json,
           created_at, updated_at)
         VALUES (?, ?, 0, 1, ?, 'running', '{}', ?, ?)`,
      )
      .run(
        nextUuid(),
        runningRunId,
        JSON.stringify({ kind: "prompt", title: "Legacy", prompt: "Legacy" }),
        now,
        now,
      );
    const capabilities = database.migration?.capabilities;
    assert.ok(capabilities);
    WORKFLOW_RUNTIME_V6_MIGRATION.apply(database, capabilities);
    const interrupted = database
      .prepare("SELECT status, error_code FROM workflow_runs WHERE id = ?")
      .get(runningRunId);
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(
      interrupted?.error_code,
      "workflow_snapshot_migration_required",
    );
    const interruptedJob = database
      .prepare(
        "SELECT status, error_code, lease_owner, lease_expires_at FROM jobs WHERE id = ?",
      )
      .get(jobId);
    assert.equal(interruptedJob?.status, "interrupted");
    assert.equal(
      interruptedJob?.error_code,
      "workflow_snapshot_migration_required",
    );
    assert.equal(interruptedJob?.lease_owner, null);
    assert.equal(interruptedJob?.lease_expires_at, null);
    assert.equal(
      database
        .prepare("SELECT status FROM workflow_runs WHERE id = ?")
        .get(completedRunId)?.status,
      "complete",
    );

    const snapshotId = nextUuid();
    const snapshotSha = "c".repeat(64);
    const insertSnapshot = database.prepare(
      `INSERT INTO workflow_execution_snapshots
        (id, workflow_run_id, workflow_id, schema_version, workflow_version,
         project_id, model_profile_id, config_json, steps_json, skill_markdown,
         columns_config_json, input_binding_json, snapshot_sha256, created_at)
       VALUES (?, ?, ?, 1, 'v1', ?, ?, '{}', '[]', '', '[]', '{}', ?, ?)`,
    );
    assert.throws(() =>
      insertSnapshot.run(
        nextUuid(),
        completedRunId,
        workflowId,
        OTHER_PROJECT,
        MODEL,
        snapshotSha,
        now,
      ),
    );
    insertSnapshot.run(
      snapshotId,
      completedRunId,
      workflowId,
      PROJECT,
      MODEL,
      snapshotSha,
      now,
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO workflow_run_idempotency
            (idempotency_key, workflow_run_id, workflow_id, project_id,
             snapshot_sha256, input_sha256, created_at)
           VALUES ('upgrade-mismatch', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          completedRunId,
          workflowId,
          OTHER_PROJECT,
          snapshotSha,
          "d".repeat(64),
          now,
        ),
    );
    database
      .prepare(
        `INSERT INTO workflow_run_idempotency
          (idempotency_key, workflow_run_id, workflow_id, project_id,
           snapshot_sha256, input_sha256, created_at)
         VALUES ('upgrade-valid', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        completedRunId,
        workflowId,
        PROJECT,
        snapshotSha,
        "d".repeat(64),
        now,
      );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE workflow_run_idempotency SET input_sha256 = ? WHERE idempotency_key = 'upgrade-valid'",
        )
        .run("e".repeat(64)),
    );
  } finally {
    database.close();
  }
}

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-workflow-runtime-"));
  const databasePath = path.join(root, "workspace.sqlite");
  let database: WorkspaceDatabase | null = null;
  try {
    auditV6Upgrade(root);
    database = new WorkspaceDatabase(databasePath, {
      migrations: WORKSPACE_MIGRATIONS,
    });
    seed(database);
    const jobsRepository = new WorkspaceJobsRepository(database);
    const jobs = new WorkspaceJobsService(jobsRepository, {
      now: clock,
      createId: nextUuid,
    });
    const jobEnqueuer = new WorkspaceJobEnqueuerAdapter(jobs);
    const workflows = new WorkflowsService(
      new WorkflowsRepository(database),
      jobEnqueuer,
      clock,
      nextUuid,
      { inferencePolicy: new WorkspaceInferencePolicy(database) },
    );

    const workflow = createWorkflow(workflows, "Immutable Audit");
    const runsBeforeLegacyStart = Number(
      database.prepare("SELECT count(*) AS count FROM workflow_runs").get()
        ?.count ?? 0,
    );
    assert.throws(() => workflows.startRun(workflow.id, {}));
    assert.equal(
      Number(
        database.prepare("SELECT count(*) AS count FROM workflow_runs").get()
          ?.count ?? 0,
      ),
      runsBeforeLegacyStart,
    );
    const projectBound = workflows.create({
      type: "assistant",
      projectId: PROJECT,
      title: "Project Bound",
      skillMarkdown: "Bound workflow.",
      steps: [],
    });
    expectWorkspaceError(
      () =>
        workflows.prepareRun(projectBound.id, {
          idempotencyKey: "workflow-audit-cross-project",
          projectId: OTHER_PROJECT,
        }),
      409,
    );
    const prepared = workflows.prepareRun(workflow.id, {
      idempotencyKey: "workflow-audit-immutable",
      inputBinding: { documents: ["selected"] },
    });
    assert.equal(prepared.reused, false);
    assert.equal(
      jobsRepository.getJob(prepared.detail.run.jobId!)?.idempotencyKey,
      null,
    );
    assert.equal(
      database
        .prepare(
          "SELECT idempotency_key FROM workflow_run_idempotency WHERE workflow_run_id = ?",
        )
        .get(prepared.detail.run.id)?.idempotency_key,
      "workflow-audit-immutable",
    );
    const replay = workflows.prepareRun(workflow.id, {
      idempotencyKey: "workflow-audit-immutable",
      inputBinding: { documents: ["selected"] },
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.detail.run.id, prepared.detail.run.id);
    expectWorkspaceError(
      () =>
        workflows.prepareRun(workflow.id, {
          idempotencyKey: "workflow-audit-immutable",
          inputBinding: { documents: ["different"] },
        }),
      409,
    );
    assert.throws(() =>
      workflows.prepareRun(workflow.id, {
        idempotencyKey: "workflow-audit-secret",
        inputBinding: { apiKey: "sk-not-allowed-12345678" },
      }),
    );
    expectWorkspaceError(
      () =>
        workflows.prepareRun(workflow.id, {
          idempotencyKey: "workflow-audit-path",
          inputBinding: { note: "/Users/alice/private.pdf" },
        }),
      400,
    );

    assert.throws(() => {
      database!
        .prepare(
          "UPDATE workflow_execution_snapshots SET workflow_version = 'mutated' WHERE workflow_run_id = ?",
        )
        .run(prepared.detail.run.id);
    });

    const pinnedSeeds = loadPinnedMikeSystemWorkflowSeeds();
    assert.equal(pinnedSeeds.length, 21);
    assert.equal(
      createHash("sha256")
        .update(
          readFileSync(
            path.resolve(
              process.cwd(),
              "src/lib/workspace/mikeSystemWorkflows.e32daad.ts",
            ),
          ),
        )
        .digest("hex"),
      MIKE_SYSTEM_WORKFLOWS_SOURCE_SHA256,
    );
    assert.ok(
      pinnedSeeds.every(
        (seed) => seed.sourceSha256 === MIKE_SYSTEM_WORKFLOWS_SOURCE_SHA256,
      ),
    );
    const seeded = seedPinnedMikeSystemWorkflows(workflows);
    const seededAgain = seedPinnedMikeSystemWorkflows(workflows);
    assert.deepEqual(
      seededAgain.map((workflow) => workflow.id),
      seeded.map((workflow) => workflow.id),
    );
    const driftedSeed = pinnedSeeds[0];
    database
      .prepare(
        "UPDATE workflow_system_templates SET source_sha256 = ? WHERE upstream_id = ?",
      )
      .run("0".repeat(64), driftedSeed.upstreamId);
    expectWorkspaceError(() => seedPinnedMikeSystemWorkflows(workflows), 409);
    database
      .prepare(
        "UPDATE workflow_system_templates SET source_sha256 = ? WHERE upstream_id = ?",
      )
      .run(driftedSeed.sourceSha256, driftedSeed.upstreamId);
    const system = seeded.find(
      (workflow) =>
        workflows.getMikeBuiltinMapping(workflow.id)?.upstreamId ===
        "builtin-nda-review",
    );
    assert.ok(system);
    const mapping = workflows.getMikeBuiltinMapping(system.id);
    assert.equal(mapping?.upstreamId, "builtin-nda-review");
    assert.equal(mapping?.sourceSha256, MIKE_SYSTEM_WORKFLOWS_SOURCE_SHA256);
    assert.match(system.id, /^[0-9a-f-]{36}$/i);
    const adapter = new MikeWorkflowCrudPortAdapter(workflows);
    const crudRequestContext = {
      principalId: WORKSPACE_LOCAL_PRINCIPAL_ID,
    };
    const mikeWire = await adapter.get(
      crudRequestContext,
      "builtin-nda-review",
    );
    assert.equal(mikeWire.id, "builtin-nda-review");
    assert.equal(mikeWire.is_system, true);
    assert.equal(mikeWire.created_at, "");
    assert.equal(mikeWire.open_source_submission, null);
    await adapter.hide(crudRequestContext, "builtin-nda-review");
    assert.ok(
      (await adapter.list(crudRequestContext, {})).some(
        (item) => item.id === mikeWire.id,
      ),
    );
    assert.ok(
      (await adapter.listHidden(crudRequestContext)).includes(
        "builtin-nda-review",
      ),
    );
    await adapter.unhide(crudRequestContext, "builtin-nda-review");
    assert.ok(
      !(await adapter.listHidden(crudRequestContext)).includes(
        "builtin-nda-review",
      ),
    );
    expectWorkspaceError(() => workflows.delete(system.id), 403);
    await auditRouter(adapter, mikeWire);
    assert.equal(
      parseMikeWorkflowCreate({
        metadata: { title: "New workflow", type: "assistant" },
        skill_md: "",
      }).title,
      "New workflow",
    );
    assert.throws(() =>
      parseMikeWorkflowCreate({
        metadata: { title: "unsafe", type: "assistant" },
        skill_md: "Bearer token-value",
      }),
    );
    const userCreated = await adapter.create(
      crudRequestContext,
      parseMikeWorkflowCreate({
        metadata: { title: "Mike CRUD assistant", type: "assistant" },
        skill_md: "Initial assistant skill.",
      }),
    );
    const userUpdated = await adapter.update(
      crudRequestContext,
      userCreated.id,
      parseMikeWorkflowUpdate({ skill_md: "Updated assistant skill." }),
    );
    assert.equal(userUpdated.skill_md, "Updated assistant skill.");
    assert.equal(
      (await adapter.get(crudRequestContext, userCreated.id)).skill_md,
      "Updated assistant skill.",
    );
    await adapter.delete(crudRequestContext, userCreated.id);
    await assert.rejects(
      adapter.get(crudRequestContext, userCreated.id),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.status === 404,
    );
    const pagedTitles = Array.from(
      { length: 101 },
      (_, index) => `Mike cursor workflow ${index}`,
    );
    const pagedWorkflows: Array<{ id: string; title: string }> = [];
    for (const title of pagedTitles) {
      const created = await adapter.create(
        crudRequestContext,
        parseMikeWorkflowCreate({
          metadata: { title, type: "assistant" },
          skill_md: "Cursor pagination fixture.",
        }),
      );
      pagedWorkflows.push({ id: created.id, title });
    }
    const flattened = await adapter.list(crudRequestContext, {
      type: "assistant",
    });
    assert.equal(
      new Set(flattened.map((workflow) => workflow.id)).size,
      flattened.length,
    );
    assert.ok(
      pagedTitles.every((title) =>
        flattened.some((workflow) => workflow.metadata.title === title),
      ),
    );
    assert.ok(
      flattened.some(
        (workflow) =>
          workflow.metadata.title === pagedWorkflows.at(0)?.title &&
          workflow.id === pagedWorkflows.at(0)?.id,
      ),
    );
    assert.ok(
      flattened.some(
        (workflow) =>
          workflow.metadata.title === pagedWorkflows.at(-1)?.title &&
          workflow.id === pagedWorkflows.at(-1)?.id,
      ),
    );

    const mikeFormats = [
      "text",
      "bulleted_list",
      "number",
      "currency",
      "yes_no",
      "date",
      "tag",
      "percentage",
      "monetary_amount",
    ] as const;
    const mikeTabularInput = parseMikeWorkflowCreate({
      metadata: { title: "Mike tabular formats", type: "tabular" },
      skill_md: "Apply the table-review rubric.",
      columns_config: mikeFormats.map((format, index) => ({
        index,
        name: `Column ${index}`,
        prompt: `Review output ${format}.`,
        format,
        ...(format === "tag" ? { tags: ["Relevant", "Not relevant"] } : {}),
      })),
    });
    const mikeTabular = workflows.create(mikeTabularInput);
    const roundTrippedTabular = serializeMikeWorkflow(mikeTabular);
    assert.equal(
      roundTrippedTabular.skill_md,
      "Apply the table-review rubric.",
    );
    assert.deepEqual(
      roundTrippedTabular.columns_config?.map((column) => column.format),
      mikeFormats,
    );
    assert.deepEqual(
      roundTrippedTabular.columns_config?.find(
        (column) => column.format === "tag",
      )?.tags,
      ["Relevant", "Not relevant"],
    );
    const updatedMikeFormats = [
      "text",
      "bulleted_list",
      "number",
      "currency",
      "yes_no",
      "currency",
      "tag",
      "percentage",
      "monetary_amount",
    ] as const;
    const updatedMikeTabular = workflows.update(
      mikeTabular.id,
      parseMikeWorkflowUpdate({
        skill_md: "Apply the updated table-review rubric.",
        columns_config: updatedMikeFormats.map((format, index) => ({
          index,
          name: `Column ${index}`,
          prompt: `Updated output ${format}.`,
          format,
          ...(format === "tag" ? { tags: ["Current", "Deprecated"] } : {}),
        })),
      }),
    );
    const updatedRoundTrip = serializeMikeWorkflow(updatedMikeTabular);
    assert.equal(
      updatedRoundTrip.skill_md,
      "Apply the updated table-review rubric.",
    );
    assert.deepEqual(
      updatedRoundTrip.columns_config?.map((column) => column.format),
      updatedMikeFormats,
    );
    assert.deepEqual(
      updatedRoundTrip.columns_config?.find((column) => column.format === "tag")
        ?.tags,
      ["Current", "Deprecated"],
    );

    const runtime = new WorkspaceWorkflowRuntime(
      workflows,
      jobsRepository,
      executor,
      clock,
    );
    const claimedJobContext = createClaimedContext(
      jobsRepository,
      prepared.detail.run.jobId!,
    );
    await assert.rejects(
      runtime.handle({
        ...claimedJobContext,
        job: {
          ...claimedJobContext.job,
          payload: {
            runId: prepared.detail.run.id,
            workflowId: prepared.detail.run.workflowId,
            snapshotId: prepared.snapshot.id,
            snapshotSha256: "b".repeat(64),
            retryOfRunId: null,
          },
        },
      }),
      WorkspaceApiError,
    );
    await runtime.handle(claimedJobContext);
    const completed = workflows.getRun(prepared.detail.run.id);
    assert.equal(completed.run.status, "complete");
    assert.equal(
      jobsRepository.getJob(prepared.detail.run.jobId!)?.status,
      "complete",
    );

    const mikeAssistant = workflows.create(
      parseMikeWorkflowCreate({
        metadata: { title: "Mike skill-only assistant", type: "assistant" },
        skill_md: "Summarize every selected document.",
      }),
    );
    const updatedMikeAssistant = workflows.update(
      mikeAssistant.id,
      parseMikeWorkflowUpdate({
        skill_md: "Apply the updated assistant review rubric.",
      }),
    );
    assert.equal(
      serializeMikeWorkflow(workflows.get(updatedMikeAssistant.id)).skill_md,
      "Apply the updated assistant review rubric.",
    );
    const skillOnlyRun = workflows.prepareRun(mikeAssistant.id, {
      idempotencyKey: "workflow-audit-skill-only",
      inputBinding: {},
    });
    assert.equal(mikeAssistant.steps.length, 0);
    assert.match(
      skillOnlyRun.snapshot.steps[0]?.id ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.deepEqual(skillOnlyRun.snapshot.steps, [
      {
        id: skillOnlyRun.snapshot.steps[0]?.id,
        kind: "prompt",
        title: "Workflow instructions",
        prompt: "Apply the updated assistant review rubric.",
      },
    ]);
    await runtime.handle(
      createClaimedContext(jobsRepository, skillOnlyRun.detail.run.jobId!),
    );
    assert.equal(
      workflows.getRun(skillOnlyRun.detail.run.id).run.status,
      "complete",
    );
    assert.equal(workflows.getRun(skillOnlyRun.detail.run.id).run.error, null);
    assert.equal(
      jobsRepository.getJob(skillOnlyRun.detail.run.jobId!)?.status,
      "complete",
    );

    expectWorkspaceError(
      () =>
        workflows.prepareRun(mikeTabular.id, {
          idempotencyKey: "workflow-audit-tabular-only",
          inputBinding: {},
        }),
      412,
    );

    const cancelledWorkflow = createWorkflow(workflows, "Cancelled Run");
    const cancelled = workflows.prepareRun(cancelledWorkflow.id, {
      idempotencyKey: "workflow-audit-cancel",
      inputBinding: {},
    });
    const abortController = new AbortController();
    abortController.abort();
    const cancellationContext = createClaimedContext(
      jobsRepository,
      cancelled.detail.run.jobId!,
    );
    await assert.rejects(
      runtime.handle({
        ...cancellationContext,
        signal: abortController.signal,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(
      workflows.getRun(cancelled.detail.run.id).run.status,
      "queued",
    );
    assert.equal(
      jobsRepository.getJob(cancelled.detail.run.jobId!)?.status,
      "running",
    );

    const cancellationRequested = workflows.prepareRun(workflow.id, {
      idempotencyKey: "workflow-audit-cancellation-requested",
      inputBinding: {},
    });
    const cancellationRequestedContext = createClaimedContext(
      jobsRepository,
      cancellationRequested.detail.run.jobId!,
    );
    jobs.requestCancellation(
      cancellationRequested.detail.run.jobId!,
      "audit cancellation request",
    );
    await assert.rejects(
      runtime.handle(cancellationRequestedContext),
      WorkspaceJobLeaseLostError,
    );
    assert.equal(
      workflows.getRun(cancellationRequested.detail.run.id).run.status,
      "queued",
    );

    const retryParentWorkflow = createWorkflow(workflows, "Retry Lineage");
    const retryParent = workflows.prepareRun(retryParentWorkflow.id, {
      idempotencyKey: "workflow-audit-retry-parent",
      inputBinding: { stable: true },
    });
    markRetryableFailure(workflows, retryParent.detail.run.id);
    const retry = workflows.retryPreparedRun(
      retryParent.detail.run.id,
      "workflow-audit-retry",
    );
    assert.equal(retry.detail.run.retryOfRunId, retryParent.detail.run.id);
    assert.equal(
      retry.snapshot.snapshotSha256,
      retryParent.snapshot.snapshotSha256,
    );
    const retryParentTwo = workflows.prepareRun(retryParentWorkflow.id, {
      idempotencyKey: "workflow-audit-retry-parent-two",
      inputBinding: { stable: true },
    });
    markRetryableFailure(workflows, retryParentTwo.detail.run.id);
    expectWorkspaceError(
      () =>
        workflows.retryPreparedRun(
          retryParentTwo.detail.run.id,
          "workflow-audit-retry",
        ),
      409,
    );
    const retryContext = createClaimedContext(
      jobsRepository,
      retry.detail.run.jobId!,
    );
    await assert.rejects(
      runtime.handle({
        ...retryContext,
        job: {
          ...retryContext.job,
          payload: {
            runId: retry.detail.run.id,
            workflowId: retry.detail.run.workflowId,
            snapshotId: retry.snapshot.id,
            snapshotSha256: retry.snapshot.snapshotSha256,
            retryOfRunId: retryParentTwo.detail.run.id,
          },
        },
      }),
      WorkspaceApiError,
    );
    jobs.requestCancellation(retry.detail.run.jobId!, "audit cleanup");

    const rollbackWorkflow = workflows.create({
      type: "assistant",
      title: "Atomic Finalization",
      skillMarkdown: "No executable steps are required for this audit.",
      steps: [],
    });
    const rollbackRun = workflows.prepareRun(rollbackWorkflow.id, {
      idempotencyKey: "workflow-audit-rollback",
      inputBinding: {},
    });
    const rollbackContext = createClaimedContext(
      jobsRepository,
      rollbackRun.detail.run.jobId!,
    );
    database
      .prepare(
        `CREATE TRIGGER audit_workflow_run_finish_rollback
         BEFORE UPDATE OF status ON workflow_runs
         WHEN new.id = '${rollbackRun.detail.run.id}'
         BEGIN SELECT RAISE(ABORT, 'audit finalization rollback'); END`,
      )
      .run();
    const failingFinishRuntime = new WorkspaceWorkflowRuntime(
      workflows,
      jobsRepository,
      executor,
      clock,
    );
    await assert.rejects(failingFinishRuntime.handle(rollbackContext));
    database.exec("DROP TRIGGER audit_workflow_run_finish_rollback");
    assert.equal(
      workflows.getRun(rollbackRun.detail.run.id).run.status,
      "queued",
    );
    assert.equal(
      jobsRepository.getJob(rollbackRun.detail.run.jobId!)?.status,
      "running",
    );

    const second = createWorkflow(workflows, "Lost Claim");
    const lost = workflows.prepareRun(second.id, {
      idempotencyKey: "workflow-audit-lost-claim",
      inputBinding: {},
    });
    const lostContext = createClaimedContext(
      jobsRepository,
      lost.detail.run.jobId!,
    );
    database
      .prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", lost.detail.run.jobId);
    const lostRuntime = new WorkspaceWorkflowRuntime(
      workflows,
      jobsRepository,
      executor,
      clock,
    );
    await assert.rejects(
      lostRuntime.handle(lostContext),
      WorkspaceJobLeaseLostError,
    );
    assert.equal(workflows.getRun(lost.detail.run.id).run.status, "queued");
    database
      .prepare("DELETE FROM workflow_runs WHERE id = ?")
      .run(lost.detail.run.id);
    assert.equal(
      database
        .prepare(
          "SELECT 1 AS present FROM workflow_execution_snapshots WHERE workflow_run_id = ?",
        )
        .get(lost.detail.run.id),
      undefined,
    );
    const projectPurge = workflows.prepareRun(workflow.id, {
      projectId: OTHER_PROJECT,
      idempotencyKey: "workflow-audit-project-purge",
      inputBinding: {},
    });
    database
      .prepare("DELETE FROM workflow_runs WHERE id = ?")
      .run(projectPurge.detail.run.id);
    database.prepare("DELETE FROM projects WHERE id = ?").run(OTHER_PROJECT);
    assert.equal(
      database
        .prepare("SELECT 1 AS present FROM projects WHERE id = ?")
        .get(OTHER_PROJECT),
      undefined,
    );
    const snapshot = workflows.getExecutionSnapshot(prepared.detail.run.id);
    database.prepare("DELETE FROM model_profiles WHERE id = ?").run(MODEL);
    assert.equal(
      workflows.getExecutionSnapshot(prepared.detail.run.id).modelProfileId,
      snapshot.modelProfileId,
    );
    database.close();
    database = new WorkspaceDatabase(databasePath, {
      migrations: WORKSPACE_MIGRATIONS,
    });
    assert.equal(
      new WorkflowsRepository(database).requireExecutionSnapshot(
        prepared.detail.run.id,
      ).snapshotSha256,
      snapshot.snapshotSha256,
    );
    console.log("vera workspace workflow runtime audit passed");
  } finally {
    // The async assertions close the database before this is reached only in a
    // synchronous failure.  LocalDatabase.close is idempotent for this audit.
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void run();
