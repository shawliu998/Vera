import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import {
  DurableAgentQueue,
  DurableAgentWorker,
  type DurableStepExecutor,
} from "../lib/aletheia/durableAgentExecutor";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";
import { buildMatterMemorySystemContext } from "../lib/aletheia/durableAgentRuntime";
import {
  DurableLocalModelStepExecutor,
  LOCAL_MODEL_GENERATE_HANDLER,
} from "../lib/aletheia/durableLocalModelStepExecutor";
import {
  LITIGATION_GROUNDED_HANDLER,
  LitigationGroundingError,
  parseGroundedLitigationOutput,
} from "../lib/aletheia/litigationGrounding";
import {
  buildLitigationAgentPartitions,
  LitigationAgentPartitionError,
  planLitigationAgentExecution,
} from "../lib/aletheia/litigationAgentPartition";
import type { LocalModelScheduler } from "../lib/aletheia/localModelScheduler";

type RunView = {
  id: string;
  status: string;
  failure_code?: string | null;
  attempt_count: number;
  metadata?: Record<string, unknown>;
  steps: Array<{
    id: string;
    status: string;
    attempt_count: number;
    output: Record<string, unknown>;
  }>;
  events: Array<{ event_type: string }>;
};

function asRun(value: unknown) {
  return value as unknown as RunView;
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-durable-agent-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  const repository = new LocalAletheiaRepository();
  const ctx = {
    userId: "durable-test-user",
    userEmail: "local@example.invalid",
  };
  const matter = (await repository.createMatter(ctx, {
    title: "Durable executor failure-injection matter",
    objective: "Verify local queue recovery",
    template: "civil_litigation",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { testOnly: true },
  })) as { id: string };
  assert.ok(matter.id);
  await repository.addMatterMemory(ctx, matter.id, {
    category: "confirmed_fact",
    title: "Termination notice",
    body: "Thirty days written notice is required.",
    source: "human",
    metadata: { testOnly: true },
  });
  const ownedMatter = await repository.getMatterDetail(ctx, matter.id);
  const foreignMatter = await repository.getMatterDetail(
    { userId: "other-local-user" },
    matter.id,
  );
  assert.ok(ownedMatter);
  assert.equal(
    foreignMatter,
    null,
    "Matter Memory must remain matter/user scoped",
  );
  const memoryContext = buildMatterMemorySystemContext(
    ownedMatter.matterMemory ?? [],
  );
  assert.match(memoryContext, /Thirty days written notice is required/);
  const generated = { request: null as Record<string, unknown> | null };
  const modelExecutor = new DurableLocalModelStepExecutor(
    {
      generate: async (request: Record<string, unknown>) => {
        generated.request = request;
        return {
          text: "local result",
          modelId: "audit-local-model",
          providerModel: "audit-local-model",
          estimatedInputTokens: 12,
          durationMs: 1,
        };
      },
    } as unknown as LocalModelScheduler,
    async () => ({
      modelId: "audit-local-model",
      contextBudgetTokens: 512,
      maxOutputTokens: 128,
      matterMemoryContext: memoryContext,
    }),
  );
  const memoryResult = await modelExecutor.execute({
    runId: "memory-audit-run",
    matterId: matter.id,
    userId: ctx.userId,
    stepId: "memory-audit-step",
    stepKey: "local_model_analysis",
    handler: LOCAL_MODEL_GENERATE_HANDLER,
    workflow: "legal_matter_review",
    modelProfile: null,
    attempt: 1,
    input: { prompt: "Summarize the notice requirement." },
    signal: new AbortController().signal,
  });
  assert.match(
    String(generated.request?.systemPrompt ?? ""),
    /Thirty days written notice is required/,
  );
  assert.equal(memoryResult.matterMemoryIncluded, true);

  const snapshotHash = `sha256:${"a".repeat(64)}`;
  const sourceQuote = "The hearing is scheduled for 10 August 2026.";
  const sourceQuoteSha256 = createHash("sha256")
    .update(sourceQuote)
    .digest("hex");
  const groundedExecutor = new DurableLocalModelStepExecutor(
    {
      generate: async () => ({
        text: JSON.stringify({
          summary: "The hearing date is confirmed.",
          summaryCitations: [{ sourceId: "source-1", quote: sourceQuote }],
          findings: [
            {
              statement: "The hearing is scheduled for 10 August 2026.",
              citations: [{ sourceId: "source-1", quote: sourceQuote }],
              confidence: "high",
              uncertainty: null,
            },
          ],
          questionsForCounsel: ["Has service been independently verified?"],
        }),
        modelId: "audit-local-model",
        providerModel: "audit-local-model",
        estimatedInputTokens: 20,
        durationMs: 1,
      }),
    } as unknown as LocalModelScheduler,
    async () => ({
      modelId: "audit-local-model",
      contextBudgetTokens: 2_048,
      maxOutputTokens: 256,
    }),
  );
  const groundedResult = await groundedExecutor.execute({
    runId: "grounding-audit-run",
    matterId: matter.id,
    userId: ctx.userId,
    stepId: "grounding-audit-step",
    stepKey: "grounded_analysis",
    handler: LITIGATION_GROUNDED_HANDLER,
    workflow: "aletheia-civil-litigation-harness-v1",
    modelProfile: null,
    attempt: 1,
    input: {
      prompt: "Analyze the cited source.",
      snapshotHash,
      allowedSources: [{ id: "source-1", quoteSha256: sourceQuoteSha256 }],
    },
    signal: new AbortController().signal,
  });
  assert.equal(
    (groundedResult.grounding as Record<string, unknown>).verified,
    true,
  );
  assert.deepEqual(
    (groundedResult.grounding as Record<string, unknown>).citedSourceIds,
    ["source-1"],
  );
  assert.equal(
    (groundedResult.grounding as Record<string, unknown>).snapshotHash,
    snapshotHash,
  );
  const invalidGroundingExecutor = new DurableLocalModelStepExecutor(
    {
      generate: async () => ({
        text: JSON.stringify({
          summary: "Unsupported summary.",
          summaryCitations: [{ sourceId: "source-1", quote: sourceQuote }],
          findings: [
            {
              statement: "Unsupported finding.",
              citations: [],
              confidence: "high",
              uncertainty: null,
            },
          ],
          questionsForCounsel: [],
        }),
        modelId: "audit-local-model",
        providerModel: "audit-local-model",
        estimatedInputTokens: 20,
        durationMs: 1,
      }),
    } as unknown as LocalModelScheduler,
    async () => ({ modelId: "audit-local-model" }),
  );
  await assert.rejects(
    () =>
      invalidGroundingExecutor.execute({
        runId: "invalid-grounding-run",
        matterId: matter.id,
        userId: ctx.userId,
        stepId: "invalid-grounding-step",
        stepKey: "grounded_analysis",
        handler: LITIGATION_GROUNDED_HANDLER,
        workflow: "aletheia-civil-litigation-harness-v1",
        modelProfile: null,
        attempt: 1,
        input: {
          prompt: "Analyze the cited source.",
          snapshotHash,
          allowedSources: [{ id: "source-1", quoteSha256: sourceQuoteSha256 }],
        },
        signal: new AbortController().signal,
      }),
    (error: unknown) =>
      error instanceof LitigationGroundingError &&
      error.code === "GROUNDING_CITATION_MISSING",
  );
  assert.throws(
    () =>
      parseGroundedLitigationOutput({
        response: JSON.stringify({
          summary: "Unknown source summary.",
          summaryCitations: [
            { sourceId: "unknown-source", quote: sourceQuote },
          ],
          findings: [
            {
              statement: "Cited finding.",
              citations: [{ sourceId: "source-1", quote: sourceQuote }],
              confidence: "medium",
              uncertainty: "Service has not been independently checked.",
            },
          ],
          questionsForCounsel: [],
        }),
        allowedSources: [{ id: "source-1", quoteSha256: sourceQuoteSha256 }],
      }),
    (error: unknown) =>
      error instanceof LitigationGroundingError &&
      error.code === "GROUNDING_CITATION_UNKNOWN",
  );
  assert.throws(
    () =>
      parseGroundedLitigationOutput({
        response: JSON.stringify({
          summary: "Altered quote summary.",
          summaryCitations: [
            { sourceId: "source-1", quote: `${sourceQuote} altered` },
          ],
          findings: [
            {
              statement: "Cited finding.",
              citations: [{ sourceId: "source-1", quote: sourceQuote }],
              confidence: "medium",
              uncertainty: null,
            },
          ],
          questionsForCounsel: [],
        }),
        allowedSources: [{ id: "source-1", quoteSha256: sourceQuoteSha256 }],
      }),
    (error: unknown) =>
      error instanceof LitigationGroundingError &&
      error.code === "GROUNDING_QUOTE_MISMATCH",
  );
  const partitioned = buildLitigationAgentPartitions(
    {
      matterId: matter.id,
      snapshotHash,
      statePolicy: "confirmed_cited_no_open_review",
      exclusions: {},
      facts: [1, 2, 3].map((index) => ({
        id: `fact-${index}`,
        statement: `Fact ${index} ${"x".repeat(320)}`,
      })),
      factSources: [1, 2, 3].map((index) => ({
        fact_id: `fact-${index}`,
        source_span_id: `source-${index}`,
      })),
      positions: [],
      events: [],
      deadlines: [],
      retrievalInputBinding: {
        manifestId: "manifest-1",
        bindingHash: `sha256:${"b".repeat(64)}`,
        inputBinding: true,
      },
      reviewedRetrievalExcerpts: [
        {
          id: "excerpt-1",
          sourceId: "retrieval-excerpt:excerpt-1",
          quote: "Counsel reviewed source quote",
        },
      ],
      sources: [
        ...[1, 2, 3].map((index) => ({
          id: `source-${index}`,
          quote: `Source quote ${index}`,
          quoteSha256: createHash("sha256")
            .update(`Source quote ${index}`)
            .digest("hex"),
        })),
        {
          id: "retrieval-excerpt:excerpt-1",
          quote: "Counsel reviewed source quote",
          quoteSha256: createHash("sha256")
            .update("Counsel reviewed source quote")
            .digest("hex"),
        },
      ],
    },
    1_600,
    24,
    { focus: "Fact 3" },
  );
  assert.ok(partitioned.partitions.length > 1);
  assert.equal(partitioned.excludedUnboundUnits, 0);
  assert.ok(
    partitioned.partitions.every(
      (partition) =>
        partition.bytes <= 1_600 &&
        /^sha256:[a-f0-9]{64}$/.test(partition.hash),
    ),
  );
  assert.equal(partitioned.partitions[0]?.content.items[0]?.id, "fact-3");
  assert.equal(
    partitioned.partitions.flatMap((partition) => partition.content.items)
      .length,
    4,
  );
  assert.ok(
    partitioned.partitions.some((partition) =>
      partition.content.items.some(
        (item: { kind: string; id: string }) =>
          item.kind === "reviewed_retrieval_excerpt" && item.id === "excerpt-1",
      ),
    ),
    "reviewed retrieval excerpts must survive partitioning as grounded units",
  );
  assert.equal(partitioned.ordering.omissionPolicy, "none");
  const largeGroundedSnapshot = {
    matterId: matter.id,
    snapshotHash,
    statePolicy: "confirmed_cited_no_open_review",
    exclusions: {},
    facts: Array.from({ length: 16 }, (_, index) => ({
      id: `large-fact-${index + 1}`,
      statement: `Large verified fact ${index + 1} ${"x".repeat(48_000)}`,
    })),
    factSources: Array.from({ length: 16 }, (_, index) => ({
      fact_id: `large-fact-${index + 1}`,
      source_span_id: `large-source-${index + 1}`,
    })),
    positions: [],
    events: [],
    deadlines: [],
    sources: Array.from({ length: 16 }, (_, index) => ({
      id: `large-source-${index + 1}`,
      quote: `Verified source ${index + 1}`,
      quoteSha256: createHash("sha256")
        .update(`Verified source ${index + 1}`)
        .digest("hex"),
    })),
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(largeGroundedSnapshot), "utf8") > 750_000,
    "audit fixture must exercise the former whole-snapshot ceiling",
  );
  const largePlan = planLitigationAgentExecution(
    largeGroundedSnapshot,
    32_768,
    { focus: "verified fact", maximumPartitions: 24 },
  );
  assert.equal(largePlan.executionMode, "source_partitioned");
  assert.ok(largePlan.snapshotBytes > 750_000);
  const largePartitioned = largePlan.partitioned;
  assert.ok(largePartitioned);
  assert.equal(largePartitioned.excludedUnboundUnits, 0);
  assert.equal(largePartitioned.ordering.omissionPolicy, "none");
  assert.ok(largePartitioned.partitions.length > 1);
  assert.deepEqual(
    new Set(
      largePartitioned.partitions.flatMap((partition) =>
        partition.content.items.map((item: { id: string }) => item.id),
      ),
    ),
    new Set(largeGroundedSnapshot.facts.map((fact) => fact.id)),
    "large verified snapshots must partition without dropping grounded units",
  );
  assert.throws(
    () =>
      buildLitigationAgentPartitions(
        {
          matterId: matter.id,
          snapshotHash,
          statePolicy: "confirmed_cited_no_open_review",
          exclusions: {},
          facts: [{ id: "oversized", statement: "x".repeat(2_000) }],
          factSources: [{ fact_id: "oversized", source_span_id: "source-1" }],
          positions: [],
          events: [],
          deadlines: [],
          sources: [
            {
              id: "source-1",
              quote: sourceQuote,
              quoteSha256: sourceQuoteSha256,
            },
          ],
        },
        800,
      ),
    (error: unknown) =>
      error instanceof LitigationAgentPartitionError &&
      error.code === "PARTITION_ITEM_TOO_LARGE",
  );

  let currentTime = new Date("2026-07-10T00:00:00.000Z");
  const now = () => new Date(currentTime);
  const databasePath = path.join(root, "aletheia.db");
  const options = {
    databasePath,
    leaseMs: 1_000,
    retryBaseMs: 1,
    now,
  };
  const first = new DurableAgentQueue(options);
  const second = new DurableAgentQueue(options);
  const calibrationId = "durable-audit-calibration";
  const calibrationFingerprint = `sha256:${"c".repeat(64)}`;
  const calibrationProtocol = "aletheia-litigation-model-calibration-v1";
  const calibrationDb = new LocalDatabase(databasePath);
  calibrationDb
    .prepare(
      `insert into aletheia_local_model_calibrations
        (id, user_id, model_id, model_fingerprint, adapter, provider_model,
         status, protocol_version, tested_at, expires_at, duration_ms,
         output_sha256, failure_code, failure_detail)
       values (?, ?, ?, ?, 'ollama', ?, 'passed', ?, ?, ?, 10, ?, null, null)`,
    )
    .run(
      calibrationId,
      ctx.userId,
      "audit-local-model",
      calibrationFingerprint,
      "audit-local-model:fixed",
      calibrationProtocol,
      "2026-07-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
      `sha256:${"d".repeat(64)}`,
    );
  calibrationDb.close();

  const crashed = asRun(
    first.enqueue({
      matterId: matter.id,
      userId: ctx.userId,
      workflow: "legal_matter_review",
      goal: "Recover a claimed step after a worker crash",
      steps: [
        {
          key: "recover",
          title: "Recover",
          handler: "test.success",
          input: { source: "local" },
          maxAttempts: 2,
        },
      ],
    }),
  );
  const firstClaim = first.claimNext("worker-before-crash");
  assert.equal(firstClaim?.id, crashed.id);
  assert.equal(
    second.claimNext("competing-worker"),
    null,
    "an active lease must prevent a second worker from claiming the run",
  );
  const runningStep = first.nextStep(crashed.id, "worker-before-crash");
  assert.ok(runningStep?.id);
  assert.ok(
    first.beginStep(crashed.id, String(runningStep.id), "worker-before-crash"),
  );

  currentTime = new Date(currentTime.getTime() + 1_001);
  assert.equal(second.recoverExpiredRuns(), 1);
  const recoveredClaim = second.claimNext("worker-after-crash");
  assert.equal(recoveredClaim?.id, crashed.id);
  assert.equal(
    first.heartbeat(crashed.id, "worker-before-crash"),
    "lost",
    "the stale worker must not mutate a run after recovery",
  );

  const recoveredStep = second.nextStep(crashed.id, "worker-after-crash");
  assert.ok(recoveredStep?.id);
  const begunRecoveredStep = second.beginStep(
    crashed.id,
    String(recoveredStep.id),
    "worker-after-crash",
  );
  assert.ok(begunRecoveredStep);
  assert.equal(
    second.completeStep(
      crashed.id,
      String(recoveredStep.id),
      "worker-after-crash",
      { recovered: true },
      1,
    ),
    true,
  );
  assert.equal(second.completeRun(crashed.id, "worker-after-crash"), true);
  const recovered = asRun(second.getRun(ctx.userId, crashed.id));
  assert.equal(recovered.status, "succeeded");
  assert.ok(
    recovered.events.some((event) => event.event_type === "run.recovered"),
  );
  assert.equal(recovered.steps[0]?.attempt_count, 2);
  assert.equal(second.verifyEventChain(crashed.id).ok, true);

  let calls = 0;
  const retryExecutor: DurableStepExecutor = {
    async execute(step) {
      calls += 1;
      if (calls === 1) throw new Error("injected transient failure");
      return { ok: true, attempt: step.attempt };
    },
  };
  const retryRun = asRun(
    first.enqueue({
      matterId: matter.id,
      userId: ctx.userId,
      workflow: "legal_matter_review",
      goal: "Retry with bounded exponential backoff",
      steps: [
        {
          key: "retry",
          title: "Retry",
          handler: "test.flaky",
          maxAttempts: 2,
        },
      ],
    }),
  );
  const retryWorker = new DurableAgentWorker(first, retryExecutor, {
    workerId: "retry-worker",
    heartbeatIntervalMs: 50,
  });
  assert.equal(await retryWorker.runOnce(), true);
  let retryState = asRun(first.getRun(ctx.userId, retryRun.id));
  assert.equal(retryState.status, "queued");
  assert.equal(retryState.steps[0]?.status, "retry_wait");
  currentTime = new Date(currentTime.getTime() + 2);
  assert.equal(await retryWorker.runOnce(), true);
  retryState = asRun(first.getRun(ctx.userId, retryRun.id));
  assert.equal(retryState.status, "succeeded");
  assert.equal(retryState.steps[0]?.attempt_count, 2);

  const timeoutRun = asRun(
    first.enqueue({
      matterId: matter.id,
      userId: ctx.userId,
      workflow: "legal_matter_review",
      goal: "Fail a step after its bounded timeout",
      steps: [
        {
          key: "timeout",
          title: "Timeout",
          handler: "test.never",
          maxAttempts: 1,
          timeoutMs: 100,
        },
      ],
    }),
  );
  const timeoutWorker = new DurableAgentWorker(
    first,
    { execute: () => new Promise(() => undefined) },
    { workerId: "timeout-worker", heartbeatIntervalMs: 50 },
  );
  assert.equal(await timeoutWorker.runOnce(), true);
  const timedOut = asRun(first.getRun(ctx.userId, timeoutRun.id));
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.failure_code, "STEP_TIMEOUT");
  assert.equal(timedOut.steps[0]?.status, "timed_out");

  const cancelRun = asRun(
    first.enqueue({
      matterId: matter.id,
      userId: ctx.userId,
      workflow: "legal_matter_review",
      goal: "Cancel an in-flight run",
      steps: [{ key: "cancel", title: "Cancel", handler: "test.cancel" }],
    }),
  );
  assert.ok(first.claimNext("cancel-worker"));
  const requested = asRun(second.cancel(ctx.userId, cancelRun.id));
  assert.equal(requested.status, "cancel_requested");
  assert.equal(
    first.heartbeat(cancelRun.id, "cancel-worker"),
    "cancel_requested",
  );
  assert.equal(first.finishCancelled(cancelRun.id, "cancel-worker"), true);
  const cancelled = asRun(first.getRun(ctx.userId, cancelRun.id));
  assert.equal(cancelled.status, "cancelled");

  const deadlineRun = asRun(
    first.enqueue({
      matterId: matter.id,
      userId: ctx.userId,
      workflow: "legal_matter_review",
      goal: "Honor the whole-run deadline",
      runTimeoutMs: 1_000,
      steps: [{ key: "deadline", title: "Deadline", handler: "test.success" }],
    }),
  );
  const deadlineClaim = first.claimNext("deadline-worker");
  assert.equal(deadlineClaim?.id, deadlineRun.id);
  currentTime = new Date(currentTime.getTime() + 1_001);
  assert.equal(second.recoverExpiredRuns(), 1);
  const deadlineState = asRun(first.getRun(ctx.userId, deadlineRun.id));
  assert.equal(deadlineState.status, "timed_out");
  assert.equal(deadlineState.failure_code, "RUN_TIMEOUT");

  const beforeClaimCancel = asRun(
    first.enqueue({
      matterId: matter.id,
      userId: ctx.userId,
      workflow: "legal_matter_review",
      goal: "Cancel before claim",
      steps: [
        {
          key: "queued-cancel",
          title: "Queued cancel",
          handler: "test.success",
        },
      ],
    }),
  );
  const immediatelyCancelled = asRun(
    first.cancel(ctx.userId, beforeClaimCancel.id),
  );
  assert.equal(immediatelyCancelled.status, "cancelled");
  assert.equal(
    asRun(first.latestRun(ctx.userId, matter.id, "legal_matter_review")).id,
    beforeClaimCancel.id,
  );
  assert.equal(
    first.latestRun("other-local-user", matter.id, "legal_matter_review"),
    null,
  );
  assert.equal(first.latestRun(ctx.userId, matter.id, "other-workflow"), null);

  const reviewableRun = asRun(
    first.enqueue({
      matterId: matter.id,
      userId: ctx.userId,
      workflow: "aletheia-civil-litigation-harness-v1",
      goal: "Produce reviewable grounded litigation output",
      metadata: {
        snapshotHash,
        executionMode: "source_partitioned",
        partitionCount: 2,
        partitionHashes: [snapshotHash],
        modelCalibrationId: calibrationId,
        modelCalibrationFingerprint: calibrationFingerprint,
        modelCalibrationProtocol: calibrationProtocol,
        retrievalManifest: {
          schemaVersion: "aletheia-litigation-retrieval-manifest-v1",
          purpose: "partition_ordering_diagnostics",
          inputBinding: false,
          candidateSetComplete: true,
          omissionPolicy: "none",
          manifestHash: `sha256:${"c".repeat(64)}`,
        },
        retrievalManifestHash: `sha256:${"c".repeat(64)}`,
      },
      modelProfile: "audit-local-model",
      steps: [
        {
          key: "analyze_confirmed_case_state",
          title: "Analyze confirmed case state",
          handler: LITIGATION_GROUNDED_HANDLER,
          input: {
            prompt: "Analyze the cited source.",
            snapshotHash,
            allowedSources: [
              { id: "source-1", quoteSha256: sourceQuoteSha256 },
            ],
          },
        },
        {
          key: "prepare_hearing_checklist",
          title: "Prepare hearing checklist",
          handler: LITIGATION_GROUNDED_HANDLER,
          input: {
            prompt: "Prepare a cited checklist.",
            snapshotHash,
            allowedSources: [
              { id: "source-1", quoteSha256: sourceQuoteSha256 },
            ],
          },
        },
      ],
    }),
  );
  const reviewWorker = new DurableAgentWorker(first, groundedExecutor, {
    workerId: "grounded-review-worker",
    heartbeatIntervalMs: 50,
  });
  for (let index = 0; index < 3; index += 1) {
    if (
      asRun(first.getRun(ctx.userId, reviewableRun.id)).status === "succeeded"
    )
      break;
    assert.equal(await reviewWorker.runOnce(), true);
  }
  assert.equal(
    asRun(first.getRun(ctx.userId, reviewableRun.id)).status,
    "succeeded",
  );
  const persistedManifestRun = asRun(
    second.getRun(ctx.userId, reviewableRun.id),
  );
  assert.equal(
    (
      persistedManifestRun.metadata?.retrievalManifest as
        | Record<string, unknown>
        | undefined
    )?.candidateSetComplete,
    true,
    "retrieval manifest must survive durable queue reopen",
  );
  assert.equal(
    persistedManifestRun.metadata?.retrievalManifestHash,
    `sha256:${"c".repeat(64)}`,
  );
  const outputReview = (await repository.requestLitigationAgentOutputReview(
    ctx,
    matter.id,
    reviewableRun.id,
  )) as Record<string, unknown>;
  assert.equal(outputReview.status, "open");
  assert.equal(
    (
      (await repository.requestLitigationAgentOutputReview(
        ctx,
        matter.id,
        reviewableRun.id,
      )) as Record<string, unknown>
    ).id,
    outputReview.id,
  );
  await assert.rejects(
    () =>
      repository.prepareLitigationAgentSynthesis(
        ctx,
        matter.id,
        reviewableRun.id,
      ),
    /requires an unchanged adopted output review/,
  );
  const reviewRunBeforeTamper = asRun(
    first.getRun(ctx.userId, reviewableRun.id),
  );
  const originalFirstStepOutput = reviewRunBeforeTamper.steps[0]?.output;
  assert.ok(originalFirstStepOutput);
  const reviewTamperDb = new LocalDatabase(databasePath);
  reviewTamperDb
    .prepare("update aletheia_agent_steps set output = '{}' where id = ?")
    .run(reviewRunBeforeTamper.steps[0].id);
  await assert.rejects(
    () =>
      repository.decideLitigationAgentOutputReview(
        ctx,
        matter.id,
        String(outputReview.id),
        {
          decision: "approved",
          comment: "Tampered output must not pass legal review.",
        },
      ),
    /incomplete|changed/,
  );
  const tamperedEval = (await repository.runLitigationEvalSuite(
    ctx,
    matter.id,
  )) as Record<string, any>;
  assert.equal(
    tamperedEval.results.find(
      (item: Record<string, unknown>) =>
        item.case_id === "grounded_agent_run_integrity",
    )?.passed,
    false,
  );
  assert.equal(
    tamperedEval.results.find(
      (item: Record<string, unknown>) =>
        item.case_id === "agent_output_review_binding_badcase",
    )?.passed,
    false,
  );
  reviewTamperDb
    .prepare("update aletheia_agent_steps set output = ? where id = ?")
    .run(
      JSON.stringify(originalFirstStepOutput),
      reviewRunBeforeTamper.steps[0].id,
    );
  reviewTamperDb.close();
  await assert.rejects(
    () =>
      repository.decideLitigationAgentOutputReview(
        ctx,
        matter.id,
        String(outputReview.id),
        {
          decision: "approved",
          comment: "Unreviewed findings must not be adopted as conclusions.",
        },
      ),
    /individually reviewed as supported/,
  );
  const reviewableFindings = reviewRunBeforeTamper.steps.flatMap((step) => {
    const structured = step.output.structuredOutput as Record<string, any>;
    return (structured.findings as Array<Record<string, unknown>>).map(
      (_finding, findingIndex) => ({ stepId: step.id, findingIndex }),
    );
  });
  assert.ok(reviewableFindings.length > 0);
  const firstFinding = reviewableFindings[0];
  const partial = (await repository.reviewLitigationAgentFinding(
    ctx,
    matter.id,
    reviewableRun.id,
    firstFinding.stepId,
    firstFinding.findingIndex,
    {
      assessment: "partial",
      reason: "The quote supports only part of the stated conclusion.",
    },
  )) as Record<string, unknown>;
  assert.equal(partial.version, 1);
  for (const finding of reviewableFindings.slice(1)) {
    await repository.reviewLitigationAgentFinding(
      ctx,
      matter.id,
      reviewableRun.id,
      finding.stepId,
      finding.findingIndex,
      {
        assessment: "supported",
        reason: "The complete exact quote supports this bounded finding.",
      },
    );
  }
  await assert.rejects(
    () =>
      repository.decideLitigationAgentOutputReview(
        ctx,
        matter.id,
        String(outputReview.id),
        {
          decision: "approved",
          comment: "A partially supported finding must still block adoption.",
        },
      ),
    /individually reviewed as supported/,
  );
  const supported = (await repository.reviewLitigationAgentFinding(
    ctx,
    matter.id,
    reviewableRun.id,
    firstFinding.stepId,
    firstFinding.findingIndex,
    {
      assessment: "supported",
      reason:
        "After closer review, the exact quote supports the bounded wording.",
    },
  )) as Record<string, unknown>;
  assert.equal(supported.version, 2);
  assert.equal(supported.supersedes_id, partial.id);
  const adoptedReview = (await repository.decideLitigationAgentOutputReview(
    ctx,
    matter.id,
    String(outputReview.id),
    {
      decision: "approved",
      comment: "The exact quotes support the bounded findings.",
    },
  )) as Record<string, unknown>;
  assert.equal(adoptedReview.status, "approved");
  assert.equal(adoptedReview.independent_review, 0);
  const synthesis = (await repository.prepareLitigationAgentSynthesis(
    ctx,
    matter.id,
    reviewableRun.id,
  )) as Record<string, any>;
  assert.match(synthesis.synthesisHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(synthesis.content.partitionCount, 2);
  assert.equal(synthesis.allowedSources.length, 1);
  assert.equal(synthesis.parentReviewId, outputReview.id);
  const adoptedEval = (await repository.runLitigationEvalSuite(
    ctx,
    matter.id,
  )) as Record<string, any>;
  assert.equal(
    adoptedEval.results.find(
      (item: Record<string, unknown>) =>
        item.case_id === "grounded_agent_run_integrity",
    )?.passed,
    true,
  );
  assert.equal(
    adoptedEval.results.find(
      (item: Record<string, unknown>) =>
        item.case_id === "agent_run_calibration_binding",
    )?.passed,
    true,
  );
  const calibrationTamperDb = new LocalDatabase(databasePath);
  calibrationTamperDb
    .prepare(
      "update aletheia_local_model_calibrations set status = 'failed' where id = ?",
    )
    .run(calibrationId);
  const calibrationTamperedEval = (await repository.runLitigationEvalSuite(
    ctx,
    matter.id,
  )) as Record<string, any>;
  assert.equal(
    calibrationTamperedEval.results.find(
      (item: Record<string, unknown>) =>
        item.case_id === "agent_run_calibration_binding",
    )?.passed,
    false,
  );
  calibrationTamperDb
    .prepare(
      "update aletheia_local_model_calibrations set status = 'passed' where id = ?",
    )
    .run(calibrationId);
  calibrationTamperDb.close();
  assert.equal(
    adoptedEval.results.find(
      (item: Record<string, unknown>) =>
        item.case_id === "agent_output_review_binding_badcase",
    )?.passed,
    true,
  );
  await assert.rejects(() =>
    repository.decideLitigationAgentOutputReview(
      ctx,
      matter.id,
      String(outputReview.id),
      {
        decision: "rejected",
        comment: "A decided review cannot be changed after adoption.",
      },
    ),
  );

  const tamperDb = new LocalDatabase(databasePath);
  tamperDb
    .prepare(
      `update aletheia_executor_events set details = '{"tampered":true}'
       where id = (select id from aletheia_executor_events where run_id = ? order by sequence asc limit 1)`,
    )
    .run(crashed.id);
  tamperDb.close();
  assert.equal(
    second.verifyEventChain(crashed.id).ok,
    false,
    "the executor event HMAC chain must detect persisted-event tampering",
  );

  first.close();
  second.close();
  console.log(
    JSON.stringify(
      {
        ok: true,
        databasePath,
        assertions: {
          atomicClaim: true,
          staleLeaseRejected: true,
          crashRecovery: true,
          boundedRetry: true,
          stepTimeout: true,
          cancellation: true,
          runTimeout: true,
          hmacEventChainAndTamperDetection: true,
          groundedLitigationOutputValidation: true,
          boundedSourcePartitioning: true,
          persistedCompleteRetrievalManifest: true,
          findingLevelSupportReviewGate: true,
          latestRunUserMatterWorkflowIsolation: true,
          persistedAgentOutputLegalReview: true,
          adoptedPartitionSynthesisGate: true,
          persistedAgentEvalTamperDetection: true,
          persistedCalibrationBindingAndTamperDetection: true,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
