import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createV1RuntimePersistencePlan,
  type V1RuntimePersistenceInput,
} from "@/lib/aletheia/v1RuntimePersistence";

const now = "2026-07-09T11:00:00.000Z";

function deterministicInput(
  matterId = "matter-v1-runtime",
): V1RuntimePersistenceInput {
  return {
    userId: "user-v1-runtime",
    matterId,
    workflow: "legal_matter_review",
    goal: "Persist deterministic V1 runtime output.",
    now,
    providerDecision: {
      allowed: true,
      reason: "local or deterministic provider",
      externalCall: false,
      provider: "deterministic",
      model: "deterministic-v1",
      privacyMode: "private",
    },
    run: {
      id: "run-v1-runtime-deterministic",
      matter_id: "matter-v1-runtime",
      agent_id: "agent-v1-llm-runtime",
      started_at: now,
      ended_at: now,
      status: "done",
      model: "deterministic:deterministic-v1",
      token_usage: {
        input_tokens: 8,
        output_tokens: 12,
        total_tokens: 20,
      },
      errors: [],
      trace_events: [
        {
          id: "trace-observe",
          timestamp: now,
          level: "info",
          message: "Observed V1 model cycle inputs.",
          metadata: { phase: "observe" },
        },
        {
          id: "trace-report",
          timestamp: now,
          level: "info",
          message: "Run completed successfully.",
          metadata: { phase: "report" },
        },
      ],
      tool_calls: [
        {
          id: "tool-model-call",
          name: "v1_model_call",
          started_at: now,
          ended_at: now,
          status: "succeeded",
          input: { provider: "deterministic" },
          output: { outputHash: "fnv1a32:test" },
        },
      ],
    },
    auditEvents: [
      {
        id: "audit-accepted",
        matter_id: "matter-v1-runtime",
        actor_type: "system",
        actor_id: "v1-llm-runtime",
        action: "v1_structured_output_accepted",
        artifact_id: "memo-v1",
        artifact_type: "draft_memo",
        after_hash: "fnv1a32:test",
        timestamp: now,
      },
    ],
  };
}

function deterministicPlan() {
  return createV1RuntimePersistencePlan(deterministicInput());
}

function blockedExternalInput(
  matterId = "matter-v1-runtime",
): V1RuntimePersistenceInput {
  return {
    userId: "user-v1-runtime",
    matterId,
    workflow: "legal_matter_review",
    goal: "Block private external model use until approval.",
    now,
    providerDecision: {
      allowed: false,
      reason:
        "external model calls for private or sensitive data require explicit approval",
      externalCall: true,
      provider: "openai",
      model: "gpt-configured",
      privacyMode: "private",
    },
    run: {
      id: "run-v1-runtime-blocked",
      matter_id: "matter-v1-runtime",
      agent_id: "agent-v1-llm-runtime",
      started_at: now,
      ended_at: now,
      status: "blocked",
      model: "openai:gpt-configured",
      errors: [
        "external model calls for private or sensitive data require explicit approval",
      ],
      trace_events: [
        {
          id: "trace-gate",
          timestamp: now,
          level: "error",
          message: "Provider policy blocked the model call.",
          metadata: { phase: "gate" },
        },
      ],
      tool_calls: [
        {
          id: "tool-provider-policy",
          name: "v1_provider_policy",
          started_at: now,
          ended_at: now,
          status: "failed",
          input: { provider: "openai", privacyMode: "private" },
          output: { allowed: false },
          error:
            "external model calls for private or sensitive data require explicit approval",
        },
      ],
    },
    auditEvents: [
      {
        id: "audit-blocked",
        matter_id: "matter-v1-runtime",
        actor_type: "system",
        actor_id: "v1-llm-runtime",
        action: "v1_external_model_call_blocked",
        artifact_id: "run-v1-runtime-blocked",
        artifact_type: "agent_run",
        after_hash: "fnv1a32:blocked",
        timestamp: now,
      },
    ],
  };
}

function blockedExternalPlan() {
  return createV1RuntimePersistencePlan(blockedExternalInput());
}

const deterministic = deterministicPlan();
assert.equal(deterministic.agentRun.status, "completed");
assert.equal(deterministic.agentRun.storage_driver, "local");
assert.equal(
  (deterministic.agentRun.budget.tokenUsage as Record<string, unknown>).total_tokens,
  20,
);
assert.equal(deterministic.steps.length, 2);
assert.equal(deterministic.toolCalls[0].status, "completed");
assert.equal(deterministic.auditEvents[0].workflow_version, "aletheia-v1-llm-runtime");
assert.deepEqual(deterministic.humanCheckpoints, []);

const blocked = blockedExternalPlan();
assert.equal(blocked.agentRun.status, "blocked");
assert.equal(blocked.toolCalls[0].tool_name, "v1_provider_policy");
assert.equal(blocked.toolCalls[0].status, "failed");
assert.equal(blocked.toolCalls.some((call) => call.tool_name === "v1_model_call"), false);
assert.equal(blocked.humanCheckpoints.length, 1);
assert.equal(blocked.humanCheckpoints[0].checkpoint_type, "external_model_call");
assert.equal(blocked.humanCheckpoints[0].status, "open");
assert.equal(
  (
    blocked.humanCheckpoints[0].requested_payload
      .providerDecision as Record<string, unknown>
  ).allowed,
  false,
);
assert.match(blocked.blockers.join("; "), /approval/);

async function assertLocalRepositoryPersistence() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "aletheia-v1-runtime-"));
  process.env.ALETHEIA_DATA_DIR = dataDir;
  try {
    const { LocalAletheiaRepository } = await import(
      "@/lib/aletheia/localRepository"
    );
    const repo = new LocalAletheiaRepository();
    const ctx = { userId: "user-v1-runtime", userEmail: "v1@example.test" };
    const matter = (await repo.createMatter(ctx, {
      title: "V1 Runtime Persistence Matter",
      objective: "Verify V1 runtime persistence and approval checkpoint mapping.",
      template: "legal_matter_review",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "V1",
      sourceProjectId: null,
      sharedWith: [],
      metadata: {},
    })) as { id: string };

    const persisted = (await repo.persistV1RuntimeResult(
      ctx,
      matter.id,
      blockedExternalInput(matter.id),
    )) as {
      id: string;
      status: string;
      tool_calls: Array<{ tool_name: string; status: string }>;
      human_checkpoints: Array<{
        checkpoint_type: string;
        status: string;
        requested_payload: Record<string, unknown>;
      }>;
    };
    const detail = (await repo.getMatterDetail(ctx, matter.id)) as {
      auditEvents: Array<{ action: string }>;
    };

    assert.equal(persisted.id, "run-v1-runtime-blocked");
    assert.equal(persisted.status, "blocked");
    assert.equal(
      persisted.tool_calls.some(
        (call) =>
          call.tool_name === "v1_provider_policy" && call.status === "failed",
      ),
      true,
    );
    assert.equal(
      persisted.tool_calls.some((call) => call.tool_name === "v1_model_call"),
      false,
    );
    assert.equal(persisted.human_checkpoints.length, 1);
    assert.equal(
      persisted.human_checkpoints[0].checkpoint_type,
      "external_model_call",
    );
    assert.equal(persisted.human_checkpoints[0].status, "open");
    assert.equal(
      (
        persisted.human_checkpoints[0].requested_payload
          .providerDecision as Record<string, unknown>
      ).allowed,
      false,
    );
    assert.equal(
      detail.auditEvents.some(
        (event) => event.action === "v1_external_model_call_blocked",
      ),
      true,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await assertLocalRepositoryPersistence();
  console.log(
    "Aletheia V1 runtime persistence adapter and local repository audit passed.",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
