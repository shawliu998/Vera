import assert from "node:assert/strict";
import { test } from "node:test";

import { createV1CompactFixture } from "../../src/aletheia/agentops/v1Contracts";
import {
  createV1ModelProviderConfig,
  evaluateV1ProviderPolicy,
  planV1SchedulerCycle,
  runV1SchedulerCycle,
  runV1StructuredModelCycle,
} from "../../src/aletheia/agentops/v1Runtime";

const now = "2026-07-09T10:00:00.000Z";

test("V1 deterministic provider runs without API keys and records bounded trace metadata", async () => {
  const fixture = createV1CompactFixture(now);
  const result = await runV1StructuredModelCycle({
    matter_id: fixture.matter.id,
    agent_id: "agent-v1-llm-runtime",
    prompt: "Draft a source-linked memo section from fixture evidence.",
    output_artifact_type: "draft_memo",
    deterministicOutput: fixture.draft_memo,
    now,
  });

  assert.equal(result.provider_decision.provider, "deterministic");
  assert.equal(result.provider_decision.allowed, true);
  assert.equal(result.validation.ok, true);
  assert.equal(result.run.status, "done");
  assert.equal(result.run.model, "deterministic:deterministic-v1");
  assert.equal(result.run.tool_calls.some((call) => call.name === "v1_model_call"), true);
  assert.equal(
    result.run.tool_calls.some(
      (call) => call.name === "v1_structured_output_guard" && call.status === "succeeded",
    ),
    true,
  );
  assert.deepEqual(
    result.run.trace_events.map((event) => event.metadata?.phase),
    ["observe", "plan", "act", "persist", "gate", "report"],
  );
  assert.equal(typeof result.run.token_usage?.total_tokens, "number");
  assert.equal(result.audit_events.at(-1)?.action, "v1_structured_output_accepted");
});

test("V1 external providers fail closed for private or sensitive data unless explicitly allowed", async () => {
  const provider = createV1ModelProviderConfig({
    provider: "openai",
    model: "gpt-configured",
    enabled: true,
  });
  const policy = evaluateV1ProviderPolicy({
    provider,
    privacyMode: "sensitive",
  });

  assert.equal(policy.allowed, false);
  assert.equal(policy.externalCall, true);
  assert.match(policy.reason, /explicit approval/);

  const result = await runV1StructuredModelCycle({
    matter_id: "matter-sensitive",
    agent_id: "agent-v1-llm-runtime",
    prompt: "Sensitive private matter facts",
    output_artifact_type: "claim",
    provider,
    privacyMode: "sensitive",
    deterministicOutput: {
      id: "claim-not-called",
      matter_id: "matter-sensitive",
      text: "This should not run.",
      evidence_item_ids: [],
      unsupported: true,
    },
    now,
  });

  assert.equal(result.run.status, "blocked");
  assert.equal(result.run.tool_calls[0].name, "v1_provider_policy");
  assert.equal(result.run.tool_calls[0].status, "failed");
  assert.equal(
    result.run.tool_calls.some((call) => call.name === "v1_model_call"),
    false,
  );
  assert.equal(result.audit_events.at(-1)?.action, "v1_external_model_call_blocked");
});

test("V1 structured output guard rejects invalid output and accepts repaired output", async () => {
  const fixture = createV1CompactFixture(now);
  const invalidMemo = {
    id: "memo-invalid",
    matter_id: fixture.matter.id,
    title: "Invalid Memo",
    sections: [],
    citation_coverage_score: 0,
  };
  const result = await runV1StructuredModelCycle({
    matter_id: fixture.matter.id,
    agent_id: "agent-v1-llm-runtime",
    prompt: "Return a draft memo.",
    output_artifact_type: "draft_memo",
    deterministicOutput: invalidMemo,
    budget: { repairAttempts: 1 },
    repairOutput: () => fixture.draft_memo,
    now,
  });

  assert.equal(result.validation.ok, true);
  assert.equal(result.run.status, "done");
  assert.equal(
    result.run.tool_calls.some(
      (call) =>
        call.name === "v1_structured_output_repair" &&
        call.status === "succeeded",
    ),
    true,
  );
  assert.equal(result.output, fixture.draft_memo);
});

test("V1 structured output guard rejects invalid output when repair is unavailable", async () => {
  const result = await runV1StructuredModelCycle({
    matter_id: "matter-invalid",
    agent_id: "agent-v1-llm-runtime",
    prompt: "Return an obligation.",
    output_artifact_type: "obligation_item",
    deterministicOutput: {
      id: "obligation-invalid",
      matter_id: "matter-invalid",
      title: "Missing fields",
    },
    now,
  });

  assert.equal(result.validation.ok, false);
  assert.equal(result.run.status, "failed");
  assert.equal(result.audit_events.at(-1)?.action, "v1_structured_output_rejected");
  assert.match(result.run.errors.join("; "), /description/);
});

test("V1 scheduler plans one queued job by priority and records skipped jobs", () => {
  const decision = planV1SchedulerCycle({
    jobs: [
      {
        scheduler_job_id: "job-low",
        matter_id: "matter-scheduler",
        agent_id: "agent-v1-llm-runtime",
        prompt: "Low priority",
        output_artifact_type: "claim",
        deterministicOutput: {
          id: "claim-low",
          matter_id: "matter-scheduler",
          text: "Low.",
          evidence_item_ids: [],
          unsupported: true,
        },
        priority: 1,
      },
      {
        scheduler_job_id: "job-high",
        matter_id: "matter-scheduler",
        agent_id: "agent-v1-llm-runtime",
        prompt: "High priority",
        output_artifact_type: "claim",
        deterministicOutput: {
          id: "claim-high",
          matter_id: "matter-scheduler",
          text: "High.",
          evidence_item_ids: [],
          unsupported: true,
        },
        priority: 10,
      },
      {
        scheduler_job_id: "job-waiting",
        matter_id: "matter-scheduler",
        agent_id: "agent-v1-llm-runtime",
        prompt: "Waiting",
        output_artifact_type: "claim",
        deterministicOutput: {},
        status: "waiting_for_approval",
      },
    ],
  });

  assert.equal(decision.selected_job_id, "job-high");
  assert.deepEqual(decision.skipped_job_ids.sort(), ["job-low", "job-waiting"]);
});

test("V1 scheduler dispatches at most one deterministic job with run trace and token metadata", async () => {
  const fixture = createV1CompactFixture(now);
  const result = await runV1SchedulerCycle({
    matter_id: fixture.matter.id,
    jobs: [
      {
        scheduler_job_id: "job-memo",
        matter_id: fixture.matter.id,
        agent_id: "agent-v1-llm-runtime",
        prompt: "Draft the fixture memo.",
        output_artifact_type: "draft_memo",
        deterministicOutput: fixture.draft_memo,
      },
    ],
    now,
  });

  assert.equal(result.scheduler_run.status, "done");
  assert.equal(result.decision.selected_job_id, "job-memo");
  assert.equal(result.dispatched_result?.run.status, "done");
  assert.equal(
    result.scheduler_run.tool_calls.some(
      (call) => call.name === "v1_scheduler_dispatch",
    ),
    true,
  );
  assert.deepEqual(
    result.scheduler_run.trace_events.map((event) => event.metadata?.phase),
    ["observe", "plan", "persist", "gate", "report"],
  );
  assert.equal(typeof result.scheduler_run.token_usage?.total_tokens, "number");
  assert.equal(result.audit_events.at(-1)?.action, "v1_scheduler_cycle_dispatched");
});

test("V1 scheduler blocks without dispatch when cycle budget is exhausted", async () => {
  const result = await runV1SchedulerCycle({
    matter_id: "matter-budget-blocked",
    maxRunsPerCycle: 0,
    jobs: [
      {
        scheduler_job_id: "job-blocked",
        matter_id: "matter-budget-blocked",
        agent_id: "agent-v1-llm-runtime",
        prompt: "Do not run.",
        output_artifact_type: "claim",
        deterministicOutput: {
          id: "claim-budget-blocked",
          matter_id: "matter-budget-blocked",
          text: "Should not run.",
          evidence_item_ids: [],
          unsupported: true,
        },
      },
    ],
    now,
  });

  assert.equal(result.scheduler_run.status, "blocked");
  assert.equal(result.dispatched_result, undefined);
  assert.match(result.decision.blocked_reason ?? "", /budget is exhausted/);
  assert.equal(
    result.scheduler_run.tool_calls.some((call) => call.name === "v1_model_call"),
    false,
  );
});

test("V1 scheduler propagates fail-closed external provider policy decisions", async () => {
  const result = await runV1SchedulerCycle({
    matter_id: "matter-sensitive-scheduler",
    jobs: [
      {
        scheduler_job_id: "job-sensitive-external",
        matter_id: "matter-sensitive-scheduler",
        agent_id: "agent-v1-llm-runtime",
        prompt: "Sensitive private matter facts",
        output_artifact_type: "claim",
        provider: {
          provider: "anthropic",
          model: "claude-configured",
          enabled: true,
        },
        privacyMode: "private",
        deterministicOutput: {
          id: "claim-not-called",
          matter_id: "matter-sensitive-scheduler",
          text: "This should not run.",
          evidence_item_ids: [],
          unsupported: true,
        },
      },
    ],
    now,
  });

  assert.equal(result.scheduler_run.status, "blocked");
  assert.equal(result.dispatched_result?.run.status, "blocked");
  assert.equal(
    result.dispatched_result?.run.tool_calls.some(
      (call) => call.name === "v1_model_call",
    ),
    false,
  );
  assert.match(result.scheduler_run.errors.join("; "), /explicit approval/);
});
