import assert from "node:assert/strict";

import { WorkspaceApiError } from "../lib/workspace/errors";
import type { WorkspaceDatabaseAdapter } from "../lib/workspace/migrations";
import type {
  AssistantToolContext,
  AssistantToolPort,
} from "../lib/workspace/services/assistantRuntime";
import type { WorkflowStepExecutor } from "../lib/workspace/services/workflowRuntime";
import {
  MATTER_INFERENCE_POLICY_MESSAGE,
  MatterInferencePolicyGate,
  MatterPolicyAssistantToolPort,
  MatterPolicyWorkflowStepExecutor,
} from "../matter/inferencePolicy";

const genericProjectId = "00000000-0000-4000-8000-000000000101";
const matterProjectId = "00000000-0000-4000-8000-000000000102";
const matterIds = new Set([matterProjectId]);
let policyQueries = 0;

const database = {
  exec() {},
  prepare(sql: string) {
    assert.match(sql, /FROM matter_profiles WHERE project_id = \?/);
    return {
      run() {
        return undefined;
      },
      get(projectId: unknown) {
        policyQueries += 1;
        return matterIds.has(String(projectId)) ? { present: 1 } : undefined;
      },
      all() {
        return [];
      },
    };
  },
} satisfies WorkspaceDatabaseAdapter;

function assertClosed(operation: () => unknown) {
  assert.throws(operation, (error: unknown) => {
    assert(error instanceof WorkspaceApiError);
    assert.equal(error.status, 412);
    assert.equal(error.code, "PRECONDITION_FAILED");
    assert.equal(error.message, MATTER_INFERENCE_POLICY_MESSAGE);
    assert(!error.message.includes(matterProjectId));
    assert(!error.message.toLowerCase().includes("select"));
    return true;
  });
}

function assistantContext(projectId: string | null): AssistantToolContext {
  return {
    jobId: "00000000-0000-4000-8000-000000000201",
    attempt: 1,
    chatId: "00000000-0000-4000-8000-000000000202",
    projectId,
    modelProfileId: "00000000-0000-4000-8000-000000000203",
    documents: [],
  };
}

async function main() {
  const gate = new MatterInferencePolicyGate(database);
  assert.equal(gate.state(null), "workspace_compatibility");
  assert.equal(gate.state(genericProjectId), "workspace_compatibility");
  assert.equal(gate.state(matterProjectId), "policy_gate_closed");
  assertClosed(() => gate.assertProjectModelUse(matterProjectId));
  assertClosed(() => gate.assertProjectModelUse("not-a-project-id"));
  gate.assertProjectModelUse(null);
  gate.assertProjectModelUse(genericProjectId);

  let assistantDelegateAssertions = 0;
  const assistantDelegate: AssistantToolPort = {
    assertModelUse() {
      assistantDelegateAssertions += 1;
    },
    async registeredTools() {
      return { adapterId: "audit-tools", tools: [] };
    },
    async execute() {
      return { content: "ok" };
    },
  };
  const assistant = new MatterPolicyAssistantToolPort(
    assistantDelegate,
    gate,
  );
  await assistant.assertModelUse(assistantContext(null));
  await assistant.assertModelUse(assistantContext(genericProjectId));
  await assert.rejects(
    assistant.assertModelUse(assistantContext(matterProjectId)),
    (error: unknown) =>
      error instanceof WorkspaceApiError &&
      error.code === "PRECONDITION_FAILED",
  );
  assert.equal(
    assistantDelegateAssertions,
    2,
    "a closed Matter must not reach the underlying Assistant tool boundary",
  );

  let prepared = 0;
  let executed = 0;
  const workflowDelegate: WorkflowStepExecutor = {
    prepareStep() {
      prepared += 1;
      return { status: "ready", input: { prepared: true } };
    },
    executeStep() {
      executed += 1;
      return { status: "complete", output: { complete: true } };
    },
  };
  const workflow = new MatterPolicyWorkflowStepExecutor(
    workflowDelegate,
    gate,
  );
  const workflowInput = (
    projectId: string | null,
    kind: "prompt" | "document_context",
  ) =>
    ({
      snapshot: { projectId },
      step: { kind },
      ordinal: 0,
      stepInput: {},
      history: [],
      signal: new AbortController().signal,
    }) as unknown as Parameters<WorkflowStepExecutor["executeStep"]>[0];

  const preparation = await workflow.prepareStep(
    workflowInput(genericProjectId, "prompt"),
  );
  assert.deepEqual(preparation, {
    status: "ready",
    input: { prepared: true },
  });
  assert.equal(prepared, 1);
  assertClosed(() =>
    workflow.executeStep(workflowInput(matterProjectId, "prompt")),
  );
  assert.equal(executed, 0);
  await workflow.executeStep(workflowInput(matterProjectId, "document_context"));
  await workflow.executeStep(workflowInput(genericProjectId, "prompt"));
  await workflow.executeStep(workflowInput(null, "prompt"));
  assert.equal(executed, 3);
  assert(policyQueries >= 8, "every project-scoped boundary must re-query policy");

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-matter-inference-policy-audit-v1",
        checks: [
          "global Assistant compatibility",
          "generic Project compatibility",
          "Matter Assistant fail-closed before delegation",
          "Matter prompt Workflow fail-closed before delegation",
          "non-model Workflow steps remain available",
          "redacted deterministic precondition error",
          "fresh database lookup at every project-scoped boundary",
        ],
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
