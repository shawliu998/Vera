import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MikeAssistantStreamEventSchema } from "../lib/workspace/assistantCompatibility";
import { WorkspaceDatabase } from "../lib/workspace/database";
import type { AssistantToolContext } from "../lib/workspace/services/assistantRuntime";
import {
  AssistantContractReviewToolError,
  WorkspaceAssistantContractReviewToolModule,
} from "../lib/workspace/services/assistantContractReviewTools";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const CHAT = "44444444-4444-4444-8444-444444444444";
const MODEL = "55555555-5555-4555-8555-555555555555";
const DOCS = [
  ["66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"],
  ["88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999"],
] as const;
const WORKFLOW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRAFT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAFT_VERSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Mode = "success" | "timeout" | "failed";

function context(): AssistantToolContext {
  return {
    jobId: JOB,
    attempt: 1,
    leaseOwner: "assistant-contract-review-audit",
    chatId: CHAT,
    projectId: PROJECT,
    modelProfileId: MODEL,
    documents: DOCS.map(([documentId, versionId]) => ({
      documentId,
      versionId,
      attached: true,
    })),
  };
}

class FakeDatabase {
  project = PROJECT;
  readonly jobs = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    return {
      get: (...parameters: unknown[]) => {
        if (sql.includes("FROM documents document")) {
          const [versionId, documentId] = parameters;
          const expected = DOCS.find(([id]) => id === documentId);
          return expected && expected[1] === versionId
            ? {
                project_id: this.project,
                current_version_id: versionId,
                deleted_at: null,
                version_deleted_at: null,
              }
            : undefined;
        }
        if (sql.includes("FROM jobs WHERE id")) {
          return this.jobs.get(String(parameters[0]));
        }
        return undefined;
      },
      run: () => ({}),
      all: () => [],
    };
  }
  exec() {}
}

class FakeTabular {
  detail: any = null;
  creates = 0;
  cancels = 0;
  constructor(
    private readonly database: FakeDatabase,
    readonly mode: Mode,
  ) {}

  get(id: string) {
    if (!this.detail || this.detail.review.id !== id) throw new Error("not found");
    return this.detail;
  }

  createPresetReviewWithId(id: string, value: any) {
    this.creates += 1;
    this.detail = {
      review: {
        id,
        projectId: value.projectId,
        workflowId: WORKFLOW,
        modelProfileId: value.modelProfileId,
        title: value.title,
        documentIds: [...value.documentIds],
        status: "draft",
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      columns: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }],
      cells: value.documentIds.map((documentId: string, index: number) => ({
        id: `${index + 1}eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`.slice(-36),
        reviewId: id,
        documentId,
        columnId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        outputType: "text",
        value: null,
        content: null,
        attempt: 0,
        sourceRefs: [],
        completedAt: null,
        status: "empty",
        error: null,
        jobId: null,
        updatedAt: "2026-07-17T00:00:00.000Z",
      })),
    };
    return this.detail;
  }

  runReview(id: string) {
    const detail = this.get(id);
    detail.review.status = "running";
    for (const [index, cell] of detail.cells.entries()) {
      const jobId = `f${index}ffffff-ffff-4fff-8fff-ffffffffffff`;
      cell.jobId = jobId;
      cell.attempt = 1;
      cell.status = "queued";
      const versionId = DOCS.find(([documentId]) => documentId === cell.documentId)![1];
      this.database.jobs.set(jobId, {
        type: "tabular_cell",
        resource_type: "tabular_cell",
        resource_id: cell.id,
        payload_json: JSON.stringify({
          schema: "vera-tabular-cell-job-v1",
          reviewId: id,
          projectId: PROJECT,
          cellId: cell.id,
          document: { documentId: cell.documentId, versionId },
          model: { profileId: MODEL },
        }),
      });
    }
    return { review: detail };
  }

  settle() {
    if (this.mode === "timeout") return;
    const failed = this.mode === "failed";
    this.detail.review.status = failed ? "failed" : "complete";
    for (const cell of this.detail.cells) {
      cell.status = failed ? "failed" : "complete";
      cell.error = failed
        ? { code: "MODEL_FAILED", message: "bounded failure", retryable: false, details: null }
        : null;
    }
  }

  cancelReview() {
    this.cancels += 1;
    this.detail.review.status = "cancelled";
    for (const cell of this.detail.cells) cell.status = "cancelled";
    return this.detail;
  }
}

function harness(mode: Mode, maxWaitMs = 10) {
  const database = new FakeDatabase();
  const tabular = new FakeTabular(database, mode);
  const records = new Map<string, any>();
  const actions = {
    reserve(input: any) {
      const existing = records.get(input.actionKey);
      if (existing) return { record: existing, created: false };
      const record = {
        jobId: input.jobId,
        actionKey: input.actionKey,
        actionType: input.actionType,
        projectId: input.projectId,
        status: "reserved",
        resourceType: null,
        resourceId: null,
      };
      records.set(input.actionKey, record);
      return { record, created: true };
    },
    complete(input: any) {
      const record = records.get(input.actionKey);
      Object.assign(record, {
        status: "complete",
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      });
      return { record, completed: true };
    },
    get(_jobId: string, actionKey: string) {
      return records.get(actionKey) ?? null;
    },
  };
  let memos = 0;
  const module = new WorkspaceAssistantContractReviewToolModule(
    database as any,
    () => tabular as any,
    {
      resolveMikeWorkflowId: () => WORKFLOW,
      getMikeBuiltinMapping: () => ({
        upstreamId: "builtin-commercial-agreement-tabular-review",
      }),
    },
    actions as any,
    async () => {
      memos += 1;
      return { documentId: DRAFT, versionId: DRAFT_VERSION, title: "Contract Review Memo" };
    },
    () => true,
    {
      maxWaitMs,
      initialPollMs: 1,
      maxPollMs: 1,
      delay: async () => tabular.settle(),
    },
  );
  return { database, tabular, module, memos: () => memos };
}

async function executeRun(module: WorkspaceAssistantContractReviewToolModule, signal = new AbortController().signal) {
  return module.execute({
    context: context(),
    call: {
      id: "call-run",
      name: "run_contract_review",
      input: { preset: "commercial_agreement" },
    },
    signal,
  });
}

async function main() {
  assert.match(
    readFileSync(
      path.join(process.cwd(), "src/lib/workspace/runtime.ts"),
      "utf8",
    ),
    /assistantRuntime \|\| workflowRuntime \|\| tabularCellHandler \? 4 : 1/,
    "production pump must leave three workers available while Assistant waits",
  );
  const success = harness("success");
  await success.module.registeredTools(context());
  const first = await executeRun(success.module);
  const firstPayload = JSON.parse(first.content);
  assert.equal(firstPayload.review.status, "complete");
  assert.equal(firstPayload.memo.draft_id, DRAFT);
  assert.deepEqual(first.events?.map((event) => event.type), [
    "tabular_review_created",
    "draft_created",
  ]);
  const replay = await executeRun(success.module);
  assert.equal(success.tabular.creates, 1, "deterministic replay must not duplicate review");
  assert.equal(success.memos(), 2, "memo handoff is invoked idempotently by its v23 boundary");
  assert.deepEqual(replay.events, [], "same-attempt replay must not duplicate durable UI events");

  const timeout = harness("timeout", 0);
  await timeout.module.registeredTools(context());
  const pending = await executeRun(timeout.module);
  const pendingPayload = JSON.parse(pending.content);
  assert.equal(pendingPayload.review.status, "running");
  assert.equal(pendingPayload.memo, null);
  timeout.tabular.mode === "timeout";
  timeout.tabular.detail.review.status = "complete";
  for (const cell of timeout.tabular.detail.cells) cell.status = "complete";
  const resumed = await timeout.module.execute({
    context: context(),
    call: { id: "call-get", name: "get_contract_review", input: { review_id: pendingPayload.review.review_id } },
    signal: new AbortController().signal,
  });
  assert.equal(JSON.parse(resumed.content).memo.draft_id, DRAFT);

  const cancelledBetweenPolls = harness("timeout", 0);
  await cancelledBetweenPolls.module.registeredTools(context());
  const betweenPollsController = new AbortController();
  const betweenPollsResult = await executeRun(
    cancelledBetweenPolls.module,
    betweenPollsController.signal,
  );
  assert.equal(JSON.parse(betweenPollsResult.content).review.status, "running");
  betweenPollsController.abort();
  assert.equal(
    cancelledBetweenPolls.tabular.cancels,
    1,
    "Stop after an asynchronous tool return must still cascade before the next get call",
  );
  assert.equal(cancelledBetweenPolls.tabular.detail.review.status, "cancelled");

  const cancelled = harness("timeout", 0);
  await cancelled.module.registeredTools(context());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => executeRun(cancelled.module, controller.signal), { name: "AbortError" });
  assert.equal(cancelled.tabular.cancels, 1, "pre-aborted signal must cascade after deterministic creation");

  const crossMatter = harness("success");
  crossMatter.database.project = OTHER_PROJECT;
  await crossMatter.module.registeredTools(context());
  await assert.rejects(() => executeRun(crossMatter.module), AssistantContractReviewToolError);
  assert.equal(crossMatter.tabular.creates, 0);

  const failed = harness("failed");
  await failed.module.registeredTools(context());
  const failedResult = await executeRun(failed.module);
  assert.equal(JSON.parse(failedResult.content).review.status, "failed");
  assert.equal(failed.memos(), 0, "failed cells must not create a memo");

  const root = mkdtempSync(path.join(os.tmpdir(), "vera-contract-review-v24-"));
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    const database = new WorkspaceDatabase(path.join(root, "workspace.sqlite"));
    try {
      assert.equal(database.migration?.currentVersion, 24);
      const eventSql = String(
        database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='assistant_generation_events'").get()?.sql,
      );
      assert.match(eventSql, /tabular_review_created/);
      assert.match(eventSql, /typeof\(event_json\) = 'text'/);
      assert.doesNotThrow(() =>
        MikeAssistantStreamEventSchema.parse({
          type: "tabular_review_created",
          review_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          title: "Review",
          route: `/projects/${PROJECT}/tabular-reviews/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
          document_count: 2,
        }),
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(
    "veraWorkspaceAssistantContractReviewToolsAudit passed: success, deterministic replay, timeout recovery, between-poll and pre-abort cancellation, Matter fencing, failed-cell memo suppression, event dedupe, strict v24 persistence schema.",
  );
}

void main();
