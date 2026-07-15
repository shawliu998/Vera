import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import ExcelJS from "exceljs";

import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { WORKSPACE_MIGRATIONS } from "../lib/workspace/migrations";
import { TabularRepository } from "../lib/workspace/repositories/tabular";
import { WorkflowsRepository } from "../lib/workspace/repositories/workflows";
import { TabularService } from "../lib/workspace/services/tabular";
import { WorkflowsService } from "../lib/workspace/services/workflows";
import {
  type EnqueueWorkspaceJobInput,
  type JobEnqueuer,
  type WorkspaceJobPortEvent,
  type WorkspaceJobSnapshot,
} from "../lib/workspace/services/jobEnqueuer";
import { TabularExporter } from "../lib/workspace/tabularExport";

const PROJECT = "10000000-0000-4000-8000-000000000001";
const OTHER_PROJECT = "10000000-0000-4000-8000-000000000002";
const MODEL = "20000000-0000-4000-8000-000000000001";
const DOC_A = "30000000-0000-4000-8000-000000000001";
const DOC_B = "30000000-0000-4000-8000-000000000002";
const DOC_OTHER = "30000000-0000-4000-8000-000000000003";
const VERSION_A = "40000000-0000-4000-8000-000000000001";
const VERSION_B = "40000000-0000-4000-8000-000000000002";
const VERSION_OTHER = "40000000-0000-4000-8000-000000000003";
const CHUNK_A = "50000000-0000-4000-8000-000000000001";
const CHUNK_OTHER = "50000000-0000-4000-8000-000000000003";

let generated = 1;
function nextUuid() {
  const suffix = generated.toString(16).padStart(12, "0");
  generated += 1;
  return `90000000-0000-4000-8000-${suffix}`;
}

function uuidFor(index: number) {
  return `80000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

let tick = 0;
function clock() {
  const value = new Date(Date.UTC(2026, 6, 14, 8, 0, tick));
  tick += 1;
  return value;
}

function expectWorkspaceError(
  operation: () => unknown,
  status: number,
  pattern?: RegExp,
) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof WorkspaceApiError);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

class FakeJobEnqueuer implements JobEnqueuer {
  constructor(private readonly database: WorkspaceDatabase) {}

  enqueueInCurrentTransaction(
    input: EnqueueWorkspaceJobInput,
  ): WorkspaceJobSnapshot {
    const existing = this.database
      .prepare("SELECT id FROM jobs WHERE idempotency_key = ?")
      .get(input.idempotencyKey);
    if (existing) return this.require(String(existing.id));
    this.database
      .prepare(
        `INSERT INTO jobs
          (id, type, status, resource_type, resource_id, idempotency_key,
           attempt, max_attempts, retryable, payload_json, scheduled_at,
           created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.type,
        input.resourceType,
        input.resourceId,
        input.idempotencyKey,
        input.maxAttempts,
        JSON.stringify(input.payload),
        input.now,
        input.now,
        input.now,
      );
    return this.require(input.id);
  }

  get(id: string) {
    const row = this.database
      .prepare(
        "SELECT id, status, attempt, max_attempts FROM jobs WHERE id = ?",
      )
      .get(id);
    return row
      ? {
          id: String(row.id),
          status: row.status as WorkspaceJobSnapshot["status"],
          attempt: Number(row.attempt),
          maxAttempts: Number(row.max_attempts),
        }
      : null;
  }

  private require(id: string) {
    const job = this.get(id);
    if (!job) throw new Error("fake job not found");
    return job;
  }

  transitionInCurrentTransaction(
    id: string,
    event: WorkspaceJobPortEvent,
  ): WorkspaceJobSnapshot {
    const job = this.require(id);
    if (event.type === "start") {
      assert.equal(job.status, "queued");
      assert.ok(job.attempt < job.maxAttempts);
      this.database
        .prepare(
          `UPDATE jobs SET status = 'running', attempt = attempt + 1,
           started_at = ?, completed_at = NULL, error_json = NULL,
           error_code = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(event.at, event.at, id);
    } else if (event.type === "complete") {
      assert.equal(job.status, "running");
      this.database
        .prepare(
          `UPDATE jobs SET status = 'complete', result_json = ?, error_json = NULL,
           error_code = NULL, retryable = 0, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(event.result), event.at, event.at, id);
    } else if (event.type === "fail") {
      assert.equal(job.status, "running");
      this.database
        .prepare(
          `UPDATE jobs SET status = 'failed', result_json = NULL, error_json = ?,
           error_code = ?, retryable = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(event.error),
          event.error.code,
          event.error.retryable ? 1 : 0,
          event.at,
          event.at,
          id,
        );
    } else {
      assert.ok(job.status === "queued" || job.status === "running");
      this.database
        .prepare(
          `UPDATE jobs SET status = 'cancelled', retryable = 0,
           cancel_requested_at = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(event.at, event.at, event.at, id);
    }
    return this.require(id);
  }
}

function seed(database: WorkspaceDatabase) {
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
      clock().toISOString(),
      clock().toISOString(),
    );
  database
    .prepare(
      `INSERT INTO model_profile_connection_tests
        (profile_id,connection_revision,status,error_code,retryable,latency_ms,tested_at)
       VALUES (?,0,'passed',NULL,0,1,?)`,
    )
    .run(MODEL, clock().toISOString());
  const insertProject = database.prepare(
    `INSERT INTO projects
      (id, name, default_model_profile_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  );
  insertProject.run(
    PROJECT,
    "Audit Project",
    MODEL,
    clock().toISOString(),
    clock().toISOString(),
  );
  insertProject.run(
    OTHER_PROJECT,
    "Other Project",
    MODEL,
    clock().toISOString(),
    clock().toISOString(),
  );
  const insertDocument = database.prepare(
    `INSERT INTO documents
      (id, project_id, title, filename, mime_type, size_bytes, parse_status,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text/plain', 100, 'ready', ?, ?)`,
  );
  insertDocument.run(
    DOC_A,
    PROJECT,
    "=Formula document",
    "a.txt",
    clock().toISOString(),
    clock().toISOString(),
  );
  insertDocument.run(
    DOC_B,
    PROJECT,
    "Second document",
    "b.txt",
    clock().toISOString(),
    clock().toISOString(),
  );
  insertDocument.run(
    DOC_OTHER,
    OTHER_PROJECT,
    "Other document",
    "other.txt",
    clock().toISOString(),
    clock().toISOString(),
  );
  const insertVersion = database.prepare(
    `INSERT INTO document_versions
      (id, document_id, version_number, source, filename, mime_type,
       size_bytes, content_sha256, storage_key, created_at)
     VALUES (?, ?, 1, 'upload', ?, 'text/plain', 100, ?, ?, ?)`,
  );
  insertVersion.run(
    VERSION_A,
    DOC_A,
    "a.txt",
    "a".repeat(64),
    "audit/doc-a/version-1",
    clock().toISOString(),
  );
  insertVersion.run(
    VERSION_B,
    DOC_B,
    "b.txt",
    "b".repeat(64),
    "audit/doc-b/version-1",
    clock().toISOString(),
  );
  insertVersion.run(
    VERSION_OTHER,
    DOC_OTHER,
    "other.txt",
    "c".repeat(64),
    "audit/doc-other/version-1",
    clock().toISOString(),
  );
  const insertChunk = database.prepare(
    `INSERT INTO document_chunks
      (id, document_id, version_id, ordinal, text, start_offset, end_offset,
       content_sha256, metadata_json, created_at)
     VALUES (?, ?, ?, 0, ?, 0, ?, ?, '{}', ?)`,
  );
  insertChunk.run(
    CHUNK_A,
    DOC_A,
    VERSION_A,
    "A".repeat(50),
    50,
    "d".repeat(64),
    clock().toISOString(),
  );
  insertChunk.run(
    CHUNK_OTHER,
    DOC_OTHER,
    VERSION_OTHER,
    "B".repeat(40),
    40,
    "e".repeat(64),
    clock().toISOString(),
  );
  database
    .prepare(
      `UPDATE workspace_settings
       SET default_project_id = ?, default_model_profile_id = ?, updated_at = ?
       WHERE id = 'workspace'`,
    )
    .run(PROJECT, MODEL, clock().toISOString());
}

async function auditExports(exporter: TabularExporter, reviewId: string) {
  const csv = exporter.csv(reviewId);
  assert.match(csv, /"Summary"/);
  assert.doesNotMatch(csv, /\/Users\/|sk-audit-secret/i);

  const csvWorkbook = new ExcelJS.Workbook();
  const csvSheet = await csvWorkbook.csv.read(Readable.from([csv]));
  assert.equal(csvSheet.rowCount, 3);
  assert.equal(csvSheet.getCell(1, 3).value, "Summary");
  assert.equal(csvSheet.getCell(2, 3).value, null);

  const xlsx = await exporter.xlsx(reviewId);
  const repeated = await exporter.xlsx(reviewId);
  assert.deepEqual(xlsx, repeated, "XLSX bytes must be deterministic");
  assert.ok(xlsx.length > 1_000);
  const xlsxWorkbook = new ExcelJS.Workbook();
  await xlsxWorkbook.xlsx.load(
    xlsx as unknown as Parameters<typeof xlsxWorkbook.xlsx.load>[0],
  );
  const sheet = xlsxWorkbook.getWorksheet("Review");
  assert.ok(sheet);
  assert.equal(sheet.getCell(1, 3).value, "Summary");
  assert.equal(sheet.getCell(2, 3).value, null);
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "vera-workflow-tabular-audit-"),
  );
  const databasePath = path.join(root, "workspace.db");
  const previousEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  let database: WorkspaceDatabase | null = null;
  try {
    const bootstrap = new WorkspaceDatabase(databasePath, { migrate: false });
    bootstrap.exec(`
      CREATE TABLE aletheia_workflow_tabular_sentinel (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
      INSERT INTO aletheia_workflow_tabular_sentinel (id, payload)
      VALUES (1, 'legacy-data-must-survive');
    `);
    bootstrap.close();

    database = new WorkspaceDatabase(databasePath, {
      migrations: WORKSPACE_MIGRATIONS,
    });
    seed(database);
    const jobs = new FakeJobEnqueuer(database);
    const workflowRepository = new WorkflowsRepository(database);
    const workflows = new WorkflowsService(
      workflowRepository,
      jobs,
      clock,
      nextUuid,
    );

    const workflow = workflows.create({
      type: "assistant",
      projectId: null,
      title: "Due diligence assistant",
      description: "Bounded audit workflow",
      skillMarkdown: "Review the supplied materials.",
      language: "English",
      practice: "Corporate",
      jurisdictions: ["England and Wales", "Singapore"],
      metadata: { version: "audit-v1", reviewed: false },
      steps: [
        {
          kind: "document_context",
          title: "Load context",
          maxDocuments: 2,
          maxChunksPerDocument: 5,
        },
        { kind: "prompt", title: "Analyze", prompt: "Summarize key risks." },
      ],
    });
    const persistedWorkflow = workflows.get(workflow.id);
    assert.equal(persistedWorkflow.type, "assistant");
    assert.equal(persistedWorkflow.projectId, null);
    assert.equal(persistedWorkflow.language, "English");
    assert.equal(persistedWorkflow.practice, "Corporate");
    assert.deepEqual(persistedWorkflow.jurisdictions, [
      "England and Wales",
      "Singapore",
    ]);
    assert.deepEqual(persistedWorkflow.metadata, {
      version: "audit-v1",
      reviewed: false,
    });
    assert.equal(persistedWorkflow.isBuiltin, false);
    const boundWorkflow = workflows.create({
      type: "assistant",
      projectId: PROJECT,
      title: "Project-bound workflow",
      skillMarkdown: "Perform bounded project work.",
      metadata: { container: "project" },
    });
    assert.equal(boundWorkflow.projectId, PROJECT);
    assert.equal(
      workflows
        .list({ projectId: PROJECT })
        .items.some((item) => item.id === boundWorkflow.id),
      true,
    );
    expectWorkspaceError(
      () =>
        workflows.startRun(boundWorkflow.id, {
          projectId: OTHER_PROJECT,
          modelProfileId: MODEL,
          idempotencyKey: "workflow-tabular-audit-bound-project",
        }),
      409,
      /bound project/,
    );
    database
      .prepare("UPDATE projects SET status = 'archived' WHERE id = ?")
      .run(OTHER_PROJECT);
    expectWorkspaceError(
      () =>
        workflows.create({
          type: "assistant",
          projectId: OTHER_PROJECT,
          title: "Inactive project workflow",
        }),
      409,
      /not active/,
    );
    database
      .prepare("UPDATE projects SET status = 'active' WHERE id = ?")
      .run(OTHER_PROJECT);

    const assistantDraft = workflows.create({
      type: "assistant",
      title: "Empty assistant draft",
    });
    assert.ok(assistantDraft.type === "assistant");
    assert.equal(assistantDraft.skillMarkdown, "");
    expectWorkspaceError(
      () =>
        workflows.startRun(assistantDraft.id, {
          modelProfileId: MODEL,
          idempotencyKey: "workflow-tabular-audit-empty-assistant",
        }),
      412,
      /no executable/,
    );
    const tabularDraft = workflows.create({
      type: "tabular",
      title: "Empty tabular draft",
    });
    assert.ok(tabularDraft.type === "tabular");
    assert.deepEqual(tabularDraft.columns, []);
    expectWorkspaceError(
      () =>
        workflows.startRun(tabularDraft.id, {
          modelProfileId: MODEL,
          idempotencyKey: "workflow-tabular-audit-empty-tabular",
        }),
      412,
      /Tabular review runtime/,
    );
    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .prepare("UPDATE workflows SET metadata_json = ? WHERE id = ?")
      .run("{", assistantDraft.id);
    database.exec("PRAGMA ignore_check_constraints = OFF");
    expectWorkspaceError(
      () => workflowRepository.require(assistantDraft.id),
      500,
      /Invalid persisted workflow metadata/,
    );
    database
      .prepare("UPDATE workflows SET metadata_json = '{}' WHERE id = ?")
      .run(assistantDraft.id);
    workflows.hide(workflow.id);
    assert.equal(workflows.isHidden(workflow.id), true);
    assert.equal(
      workflows.list().items.some((item) => item.id === workflow.id),
      false,
    );
    workflows.unhide(workflow.id);
    assert.equal(
      workflows.list().items.some((item) => item.id === workflow.id),
      true,
    );

    assert.throws(() =>
      workflows.create({
        type: "assistant",
        title: "Illegal workflow",
        skillMarkdown: "No arbitrary tools.",
        steps: [{ kind: "shell", command: "curl example.com" }],
      }),
    );

    const manySteps = Array.from({ length: 26 }, (_, index) => ({
      kind: "prompt" as const,
      title: `Step ${index + 1}`,
      prompt: `Perform bounded analysis ${index + 1}.`,
    }));
    const boundedWorkflow = workflows.create({
      type: "assistant",
      title: "Explicit budget workflow",
      skillMarkdown: "Use only declared prompt steps.",
      steps: manySteps,
    });
    expectWorkspaceError(
      () =>
        workflows.startRun(boundedWorkflow.id, {
          idempotencyKey: "workflow-tabular-audit-bounded-rejected",
        }),
      409,
      /execution limits/,
    );
    const boundedRun = workflows.startRun(
      boundedWorkflow.id,
      { idempotencyKey: "workflow-tabular-audit-bounded-run" },
      { maxSteps: 30, maxModelCalls: 30 },
    );
    const boundedExecution = (
      boundedRun.run.input as {
        execution: Record<string, unknown>;
      }
    ).execution;
    assert.equal(boundedExecution.maxSteps, 30);
    assert.equal(boundedExecution.maxModelCalls, 30);
    workflows.cancelRun(boundedRun.run.id);

    const cumulativeTabular = workflows.create({
      type: "tabular",
      title: "Cumulative model-call budget",
      columns: Array.from({ length: 15 }, (_, index) => ({
        key: `result_${index}`,
        title: `Result ${index}`,
        outputType: "text" as const,
        prompt: "Extract a result.",
      })),
      steps: Array.from({ length: 10 }, (_, index) => ({
        kind: "prompt" as const,
        title: `Prompt ${index}`,
        prompt: "Perform bounded review.",
      })),
    });
    expectWorkspaceError(
      () =>
        workflows.startRun(cumulativeTabular.id, {
          modelProfileId: MODEL,
          idempotencyKey: "workflow-tabular-audit-cumulative-rejected",
        }),
      412,
      /Tabular review runtime/,
    );

    const nonRunningPortRun = workflows.startRun(workflow.id, {
      modelProfileId: MODEL,
      idempotencyKey: "workflow-tabular-audit-non-running-port",
    });
    jobs.transitionInCurrentTransaction(nonRunningPortRun.run.jobId!, {
      type: "cancel",
      at: clock().toISOString(),
      reason: "Audit non-running port response.",
    });
    expectWorkspaceError(
      () => workflows.startStep(nonRunningPortRun.run.id, 0),
      409,
      /running state/,
    );

    const failedRun = workflows.startRun(workflow.id, {
      modelProfileId: MODEL,
      idempotencyKey: "workflow-tabular-audit-failed-run",
    });
    assert.equal(failedRun.run.projectId, PROJECT);
    assert.equal(failedRun.run.modelProfileId, MODEL);
    expectWorkspaceError(
      () => workflows.startStep(failedRun.run.id, 1),
      409,
      /ordinal order/,
    );
    workflows.startStep(failedRun.run.id, 0, { documentCount: 2 });
    workflows.completeStep(failedRun.run.id, 0, { chunksLoaded: 4 });
    workflows.startStep(failedRun.run.id, 1, { promptVersion: 1 });
    const failed = workflows.failStep(failedRun.run.id, 1, {
      code: "provider_failure",
      message: "Bearer secret-token at /Users/audit/private.txt",
      retryable: true,
      details: { phase: "analysis" },
    });
    assert.equal(failed.run.status, "failed");
    assert.equal(jobs.get(failed.run.jobId!)?.status, "failed");
    assert.doesNotMatch(
      failed.run.error?.message ?? "",
      /secret-token|\/Users\//,
    );
    expectWorkspaceError(
      () =>
        workflows.retryFailedStep(
          failed.run.id,
          0,
          "workflow-tabular-audit-retry-nonretryable-step",
        ),
      409,
    );
    const parentConfigHash = String(
      (failed.run.input as { execution: Record<string, unknown> }).execution
        .workflowConfigSha256,
    );
    workflows.update(workflow.id, {
      metadata: { version: "changed-after-parent-run" },
    });
    const retryRun = workflows.retryFailedStep(
      failed.run.id,
      1,
      "workflow-tabular-audit-retry-step-1",
    );
    assert.equal(retryRun.detail.run.retryOfRunId, failed.run.id);
    assert.equal(retryRun.detail.steps[0].status, "skipped");
    assert.equal(retryRun.detail.steps[1].status, "queued");
    assert.equal(retryRun.detail.steps[1].attempt, 2);
    assert.equal(
      String(
        (retryRun.detail.run.input as { execution: Record<string, unknown> })
          .execution.workflowConfigSha256,
      ),
      parentConfigHash,
    );
    workflows.cancelRun(retryRun.detail.run.id);

    const cancelledRun = workflows.startRun(workflow.id, {
      projectId: PROJECT,
      modelProfileId: MODEL,
      idempotencyKey: "workflow-tabular-audit-cancelled-run",
    });
    const cancelled = workflows.cancelRun(cancelledRun.run.id);
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(jobs.get(cancelled.run.jobId!)?.status, "cancelled");

    const jobFailedRun = workflows.startRun(workflow.id, {
      idempotencyKey: "workflow-tabular-audit-job-failed-run",
    });
    const jobFailed = workflows.failRun(jobFailedRun.run.id, {
      code: "worker_failure",
      message: "Worker stopped before the first step.",
      retryable: true,
      details: null,
    });
    assert.equal(jobFailed.run.status, "failed");
    assert.ok(jobFailed.steps.every((step) => step.status === "skipped"));
    assert.equal(jobs.get(jobFailed.run.jobId!)?.status, "failed");

    const completedRun = workflows.startRun(workflow.id, {
      idempotencyKey: "workflow-tabular-audit-completed-run",
    });
    workflows.startStep(completedRun.run.id, 0);
    workflows.completeStep(completedRun.run.id, 0, { loaded: true });
    workflows.startStep(completedRun.run.id, 1);
    const beforeJobCompletion = workflows.completeStep(completedRun.run.id, 1, {
      summary: "complete",
    });
    assert.equal(beforeJobCompletion.run.status, "running");
    const completed = workflows.completeRun(completedRun.run.id, {
      summary: "complete",
    });
    assert.equal(completed.run.status, "complete");
    assert.equal(jobs.get(completed.run.jobId!)?.status, "complete");
    const firstPage = workflows.listRuns(workflow.id, { limit: 2 });
    assert.equal(firstPage.items.length, 2);
    assert.ok(firstPage.nextCursor);
    assert.ok(
      workflows.listRuns(workflow.id, {
        cursor: firstPage.nextCursor,
        limit: 2,
      }).items.length >= 1,
    );

    workflows.archive(workflow.id);
    expectWorkspaceError(
      () =>
        workflows.startRun(workflow.id, {
          idempotencyKey: "workflow-tabular-audit-archived-rejected",
        }),
      409,
    );
    workflows.update(workflow.id, { status: "active" });
    const disposable = workflows.create({
      type: "assistant",
      title: "Disposable",
      skillMarkdown: "Never run.",
      steps: [],
    });
    workflows.delete(disposable.id);
    expectWorkspaceError(() => workflows.get(disposable.id), 404);

    const tabularRepository = new TabularRepository(database);
    const tabular = new TabularService(
      tabularRepository,
      jobs,
      clock,
      nextUuid,
    );
    const emptyDraft = tabular.create({
      title: "Mike empty draft",
      documentIds: [],
      columns: [],
    });
    assert.equal(emptyDraft.review.status, "draft");
    assert.deepEqual(emptyDraft.review.documentIds, []);
    assert.deepEqual(emptyDraft.columns, []);
    assert.deepEqual(emptyDraft.cells, []);
    expectWorkspaceError(
      () => tabular.runReview(emptyDraft.review.id),
      412,
      /at least one document and one column/,
    );
    const populatedDraft = tabular.updateDraftMatrix(emptyDraft.review.id, {
      documentIds: [DOC_B],
      columns: [
        {
          key: "summary",
          title: "Summary",
          outputType: "text",
          prompt: "Summarize.",
        },
      ],
    });
    assert.deepEqual(populatedDraft.review.documentIds, [DOC_B]);
    assert.equal(populatedDraft.cells.length, 1);
    assert.deepEqual(
      database
        .prepare(
          `SELECT document_id, ordinal FROM tabular_review_documents
           WHERE review_id = ? ORDER BY ordinal`,
        )
        .all(emptyDraft.review.id)
        .map((row) => ({
          documentId: String(row.document_id),
          ordinal: Number(row.ordinal),
        })),
      [{ documentId: DOC_B, ordinal: 0 }],
    );
    const renamedDraft = tabular.update(emptyDraft.review.id, {
      title: "Renamed Mike draft",
    });
    assert.equal(renamedDraft.review.title, "Renamed Mike draft");
    tabular.archive(emptyDraft.review.id);
    assert.equal(tabular.get(emptyDraft.review.id).review.status, "archived");
    assert.equal(
      tabular.list().items.some((item) => item.id === emptyDraft.review.id),
      false,
    );

    const review = tabular.create({
      title: "Contract matrix",
      documentIds: [DOC_A, DOC_B],
      columns: [
        {
          key: "summary",
          title: "Summary",
          outputType: "text",
          prompt: "Provide a concise summary.",
        },
        {
          key: "assignable",
          title: "Assignable",
          outputType: "boolean",
          prompt: "Is assignment permitted?",
        },
        {
          key: "risk",
          title: "Risk",
          outputType: "enum",
          prompt: "Classify risk.",
          enumValues: ["low", "medium", "high"],
        },
        {
          key: "amount",
          title: "Amount",
          outputType: "number",
          prompt: "Extract the amount.",
        },
      ],
    });
    assert.equal(review.review.status, "draft");
    assert.equal(review.cells.length, 8);
    expectWorkspaceError(
      () =>
        tabular.create({
          projectId: PROJECT,
          title: "Cross-project review",
          documentIds: [DOC_A, DOC_OTHER],
          columns: [
            {
              key: "summary",
              title: "Summary",
              outputType: "text",
              prompt: "Summarize.",
            },
          ],
        }),
      409,
      /same project/,
    );
    expectWorkspaceError(
      () =>
        tabular.create({
          title: "Oversized review",
          documentIds: Array.from({ length: 101 }, (_, index) =>
            uuidFor(index + 1),
          ),
          columns: Array.from({ length: 100 }, (_, index) => ({
            key: `column_${index}`,
            title: `Column ${index}`,
            outputType: "text",
            prompt: "Review.",
          })),
        }),
      400,
      /10000 cells/,
    );

    // P1 deliberately leaves per-cell generation disabled until the document
    // extraction authority is wired. Keep CRUD and export coverage below, but
    // do not revive the former generation state-machine solely for this audit.
    expectWorkspaceError(
      () => tabular.runReview(review.review.id),
      409,
      /document-level authoritative extracted-text runtime/,
    );

    await auditExports(
      new TabularExporter(tabularRepository),
      review.review.id,
    );
    assert.equal(
      database
        .prepare(
          "SELECT payload FROM aletheia_workflow_tabular_sentinel WHERE id = 1",
        )
        .get()?.payload,
      "legacy-data-must-survive",
    );

    const persistedWorkflowId = workflow.id;
    const persistedReviewId = review.review.id;
    database.close();
    database = new WorkspaceDatabase(databasePath, {
      migrations: WORKSPACE_MIGRATIONS,
    });
    const restartedWorkflows = new WorkflowsRepository(database);
    const restartedTabular = new TabularRepository(database);
    assert.equal(
      restartedWorkflows.require(persistedWorkflowId).status,
      "active",
    );
    assert.ok(
      restartedWorkflows.listRuns(persistedWorkflowId).items.length >= 3,
    );
    assert.equal(
      restartedTabular.requireDetail(persistedReviewId).review.status,
      "draft",
    );
    assert.equal(
      database
        .prepare(
          "SELECT payload FROM aletheia_workflow_tabular_sentinel WHERE id = 1",
        )
        .get()?.payload,
      "legacy-data-must-survive",
    );

    console.log(
      "Vera workspace workflow/tabular audit passed: dormant workflow execution regression, strict sequencing, durable retry lineage, tabular CRUD, generation capability denial, deterministic CSV/XLSX, restart persistence, and legacy preservation verified.",
    );
  } finally {
    try {
      database?.close();
    } catch {
      // Best-effort audit cleanup.
    }
    rmSync(root, { recursive: true, force: true });
    if (previousEncryption === undefined) {
      delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    } else {
      process.env.ALETHEIA_DATABASE_ENCRYPTION = previousEncryption;
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
