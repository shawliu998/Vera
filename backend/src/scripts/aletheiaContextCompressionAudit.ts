import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ContextCompressionError,
  parseContextDigest,
  prepareCompressibleContext,
  type ContextCompressionPolicy,
  type ContextDigest,
} from "../lib/aletheia/contextCompression";
import {
  DurableLocalModelStepExecutor,
  LOCAL_MODEL_GENERATE_HANDLER,
} from "../lib/aletheia/durableLocalModelStepExecutor";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";
import type {
  LocalModelGenerateRequest,
  LocalModelScheduler,
} from "../lib/aletheia/localModelScheduler";

type GeneratedRequest = LocalModelGenerateRequest;

const testUser = { userId: "context-compression-audit-user" };

function compressionMessages() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${index === 4 ? "Approval gate and evidence references must remain available. " : ""}${"sensitive context ".repeat(44)}${index}`,
    evidenceIds: index === 4 ? ["evidence-approval-1"] : [],
    originRun: "compression-audit-run",
  }));
}

function step(messages = compressionMessages()) {
  return {
    runId: "compression-audit-run",
    matterId: "compression-audit-matter",
    userId: testUser.userId,
    stepId: "compression-audit-step",
    stepKey: "local_model_analysis",
    handler: LOCAL_MODEL_GENERATE_HANDLER,
    workflow: "legal_matter_review",
    modelProfile: null,
    attempt: 1,
    input: {
      prompt: "Continue the matter analysis without losing approvals or evidence.",
      messages,
      maxOutputTokens: 128,
    },
    signal: new AbortController().signal,
  };
}

function digestResponse() {
  return JSON.stringify({
    sections: {
      goal: { text: "Continue the professional matter analysis." },
      constraints: { text: "Retain approval gates and cited evidence." },
      relevantEvidence: {
        text: "Approval evidence remains material.",
        evidenceIds: ["evidence-approval-1"],
      },
      nextSteps: { text: "Prepare a reviewable next step." },
    },
  });
}

function schedulerHarness() {
  const requests: GeneratedRequest[] = [];
  const scheduler = {
    generate: async (request: GeneratedRequest) => {
      requests.push(request);
      return {
        text: request.modelId === "local-compressor" ? digestResponse() : "main local-model result",
        modelId: request.modelId,
        providerModel: request.modelId,
        estimatedInputTokens: 10,
        durationMs: 1,
      };
    },
  } as unknown as LocalModelScheduler;
  return { scheduler, requests };
}

function automaticPolicy(
  overrides: Partial<ContextCompressionPolicy> = {},
): ContextCompressionPolicy {
  return {
    mode: "Auto",
    modelId: "local-compressor",
    modelVersion: "audit-v1",
    modelContextWindowTokens: 16_384,
    ...overrides,
  };
}

async function expectCompressionFailure(args: {
  policy: ContextCompressionPolicy;
  budget?: number;
  expectedCode: ContextCompressionError["code"];
}) {
  const { scheduler, requests } = schedulerHarness();
  const executor = new DurableLocalModelStepExecutor(scheduler, async () => ({
    modelId: "local-main",
    contextBudgetTokens: args.budget ?? 4_096,
    maxOutputTokens: 128,
    contextCompression: args.policy,
  }));
  await assert.rejects(
    () => executor.execute(step()),
    (error: unknown) =>
      error instanceof ContextCompressionError && error.code === args.expectedCode,
  );
  assert.equal(
    requests.some((request) => request.modelId === "local-main"),
    false,
    "a compression failure must fail closed before the main model executes",
  );
}

async function durableExecutorAudit() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-context-compression-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  const repository = new LocalAletheiaRepository();
  const matter = await repository.createMatter(testUser, {
    title: "Context compression audit matter",
    objective: "Prove audited automatic local context compression",
    template: "legal_matter_review",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { testOnly: true },
  });
  assert.ok(matter);
  const { scheduler, requests } = schedulerHarness();
  const persisted: ContextDigest[] = [];
  const executor = new DurableLocalModelStepExecutor(scheduler, async () => ({
    modelId: "local-main",
    contextBudgetTokens: 4_096,
    maxOutputTokens: 128,
    contextCompression: automaticPolicy({
      persistDigest: async (digest) => {
        persisted.push(digest);
        const workProduct = await repository.createWorkProduct(testUser, matter.id, {
          kind: "context_digest",
          title: `ContextDigest ${digest.digestId}`,
          status: "active",
          schemaVersion: digest.schemaVersion,
          content: digest,
          validationErrors: [],
          generatedBy: "agent",
          model: digest.model.id,
        });
        if (!workProduct) throw new Error("work product persistence failed");
        const event = await repository.appendAuditEvent(testUser, matter.id, {
          actor: "agent",
          action: "context_digest_created",
          workflowVersion: digest.schemaVersion,
          model: digest.model.id,
          details: {
            workProductId: workProduct.id,
            digestId: digest.digestId,
            originRun: digest.originRun,
            sourceHashes: digest.sources.map((source) => source.sourceHash),
            evidenceIds: digest.sources.flatMap((source) => source.evidenceIds),
          },
        });
        if (!event) throw new Error("audit persistence failed");
        return { id: workProduct.id };
      },
    }),
  }));
  const original = compressionMessages();
  const originalSnapshot = structuredClone(original);
  const result = await executor.execute(step(original));
  assert.equal(result.contextCompressionApplied, true);
  assert.ok(result.contextDigestId);
  assert.deepEqual(original, originalSnapshot, "compression must never overwrite raw messages");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.originRun, "compression-audit-run");
  assert.equal(persisted[0]?.model.id, "local-compressor");
  assert.ok(persisted[0]?.sources.some((source) => source.evidenceIds.includes("evidence-approval-1")));
  const mainRequest = requests.find((request) => request.modelId === "local-main");
  assert.ok(mainRequest);
  assert.ok(
    mainRequest.messages?.some((message) => message.role === "system" && message.content.startsWith("ContextDigest ")),
    "the main model must receive the generated digest rather than the raw middle context",
  );
  assert.equal(
    mainRequest.messages?.some((message) => message.content === original[4]?.content),
    false,
    "the compressed middle context must not be sent verbatim to the main model",
  );
  const detail = await repository.getMatterDetail(testUser, matter.id);
  assert.ok(detail);
  assert.ok(detail.workProducts.some((item: { kind?: string; content?: { digestId?: string } }) => item.kind === "context_digest" && item.content?.digestId === persisted[0]?.digestId));
  assert.ok(detail.auditEvents.some((item: { action?: string; details?: { digestId?: string } }) => item.action === "context_digest_created" && item.details?.digestId === persisted[0]?.digestId));

  await expectCompressionFailure({
    policy: { mode: "Manual" },
    expectedCode: "MANUAL_COMPRESSION_REQUIRED",
  });
  await expectCompressionFailure({
    policy: { mode: "Off" },
    budget: 3_000,
    expectedCode: "MANUAL_COMPRESSION_REQUIRED",
  });
  await expectCompressionFailure({
    policy: automaticPolicy({ modelId: null, modelContextWindowTokens: null }),
    expectedCode: "COMPRESSION_MODEL_UNAVAILABLE",
  });
  await expectCompressionFailure({
    policy: automaticPolicy({ modelContextWindowTokens: 512 }),
    expectedCode: "COMPRESSION_INPUT_TOO_LARGE",
  });
  await expectCompressionFailure({
    policy: automaticPolicy({
      persistDigest: async () => {
        throw new Error("injected durable write failure");
      },
    }),
    expectedCode: "COMPRESSION_PERSIST_FAILED",
  });
}

async function main() {
  const prepared = prepareCompressibleContext([
    { id: "tool-call", role: "assistant", content: "expired call", toolPairId: "pair-1", expiresAt: "2020-01-01T00:00:00.000Z" },
    { id: "tool-result", role: "user", content: "expired result", toolPairId: "pair-1", expiresAt: "2020-01-01T00:00:00.000Z" },
    { id: "orphan", role: "assistant", content: "never silently drop", toolPairId: "orphan", expiresAt: "2020-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(prepared.deterministicallyExcludedToolPairs, ["pair-1"]);
  assert.equal(prepared.messages.length, 1, "orphaned tool records remain intact");
  const sources = [{ messageId: "source-1", sourceHash: "sha256:source-1", evidenceIds: ["evidence-1"], originRun: "run-1" }];
  const digest = parseContextDigest({
    response: JSON.stringify({ sections: { goal: { text: "Review the contract", evidenceIds: ["evidence-1"], sourceHashes: ["sha256:source-1"] } } }),
    originRun: "run-1",
    modelId: "local-compressor",
    sources,
    deterministicallyExcludedToolPairs: prepared.deterministicallyExcludedToolPairs,
  });
  assert.equal(digest.sections.goal.evidenceIds[0], "evidence-1");
  assert.equal(digest.sources[0]?.originRun, "run-1");
  assert.throws(
    () => parseContextDigest({ response: "not-json", originRun: "run-1", modelId: "local-compressor", sources, deterministicallyExcludedToolPairs: [] }),
    (error: unknown) => error instanceof ContextCompressionError && error.code === "COMPRESSION_OUTPUT_INVALID",
  );
  await durableExecutorAudit();
  console.log(JSON.stringify({ ok: true, suite: "aletheia-context-compression-audit-v1", checks: ["paired tool-result hygiene", "orphan preservation", "evidence/run provenance", "invalid digest fail-closed", "50-percent automatic durable compression", "digest work product and audit event", "raw message immutability", "off/manual/unhealthy/oversize/persistence fail-closed"] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
