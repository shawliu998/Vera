import assert from "node:assert/strict";
import test from "node:test";

import { buildMatterContextManifest } from "./agent-kernel/context/matterContext";
import {
  buildAgentTaskContractCheckpoint,
  compileAgentGoalSpec,
  normalizeAgentTaskArtifactContracts,
} from "./agent-kernel/contracts/taskContract";
import {
  compileAgentStepContracts,
  type AgentStepContractV1,
} from "./agent-kernel/contracts/stepContract";
import { prepareCurrentAgentStepTransition } from "./agentTaskExecution";

const documentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const acceptedViewSha256 = `sha256:${"a".repeat(64)}`;

function verifierFixture() {
  const deliverables = normalizeAgentTaskArtifactContracts([
    {
      key: "opinion",
      title: "Opinion",
      description: "A fixed current opinion.",
      required: true,
      artifact_type: "draft",
      purpose: "Opinion",
    },
  ]);
  const goal = compileAgentGoalSpec({
    objective: "Prepare an opinion.",
    taskFamily: "verification_test",
    artifactContracts: deliverables,
    hasSources: false,
  });
  const context = buildMatterContextManifest({
    matterId: "matter-1",
    compiledAt: "2026-08-08T00:00:00.000Z",
    sources: [],
  });
  const contracts = compileAgentStepContracts({
    steps: [
      { capability: "read_sources" },
      { capability: "create_draft" },
      { capability: "verify" },
    ],
    goalSpec: goal,
    artifactContracts: deliverables,
    contextManifest: context,
  });
  const checkpoint = buildAgentTaskContractCheckpoint({
    goalSpec: goal,
    contextManifest: context,
    stepContracts: contracts,
    capabilityGrants: [],
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const snapshot = {
    task: {
      id: "task-1",
      matter_id: "matter-1",
      goal: "Prepare an opinion.",
      deliverables,
      latest_checkpoint: checkpoint,
      current_plan: [
        { id: "step-read", status: "completed", attempt: 1 },
        { id: "step-draft", status: "completed", attempt: 1 },
        { id: "step-verify", status: "running", attempt: 1 },
      ],
    },
    artifacts: [
      {
        artifact_type: "draft" as const,
        artifact_id: documentId,
        purpose: "Opinion",
      },
    ],
  };
  return { snapshot, verifierContract: contracts.steps.at(-1)! };
}

function verificationExecution(input: {
  outcome: "clean_pass" | "review_required";
  identities: unknown[];
}) {
  return {
    summary: "Verifier finished.",
    artifacts: [
      {
        artifact_type: "draft" as const,
        artifact_id: documentId,
        purpose: "Opinion",
      },
    ],
    waitingForInput: false,
    citationCheck: { total: 0, relocatable: 0, missing: 0 },
    verification: {
      packet: {
        deliverables: [
          {
            key: "opinion",
            artifact_type: "draft",
            artifact_id: documentId,
            document_id: documentId,
            current_version_id: versionId,
            accepted_view_sha256: acceptedViewSha256,
            accepted_view_text: "Fixed current opinion.",
            accepted_view_complete: true,
          },
        ],
      },
      result: {
        outcome: input.outcome,
        dimensions: {
          artifact_integrity: "pass",
          workflow_completion: input.outcome === "clean_pass" ? "pass" : "gap",
          source_support: "pass",
          goal_coverage: "pass",
        },
      },
      verifiedArtifacts: input.identities,
    },
  } as never;
}

function verifiedDraft(overrides: Record<string, unknown> = {}) {
  return {
    kind: "agent_verified_draft_artifact_v1",
    document_id: documentId,
    version_id: versionId,
    accepted_view_sha256: acceptedViewSha256,
    ...overrides,
  };
}

test("a clean verifier pass with missing, extra, or wrong identities becomes a structured postcondition pause that preserves artifacts", async () => {
  const { snapshot } = verifierFixture();
  for (const identities of [
    [],
    [
      verifiedDraft(),
      verifiedDraft({ document_id: "33333333-3333-4333-8333-333333333333" }),
    ],
    [verifiedDraft({ version_id: "33333333-3333-4333-8333-333333333333" })],
  ]) {
    const execution = verificationExecution({
      outcome: "clean_pass",
      identities,
    });
    const transition = await prepareCurrentAgentStepTransition(
      {} as never,
      snapshot as never,
      "user-1",
      execution,
    );
    assert.equal(transition.kind, "postcondition_pause");
    if (transition.kind !== "postcondition_pause") continue;
    assert.equal(transition.facts.expected_identity_count, 1);
    assert.equal(transition.facts.actual_identity_count, identities.length);
    assert.deepEqual(transition.artifacts, execution.artifacts);
    assert.match(transition.summary, /Existing work was preserved/);
  }
});

test("a review-required verifier result advances to lawyer review without requiring identity", async () => {
  const { snapshot } = verifierFixture();
  const transition = await prepareCurrentAgentStepTransition(
    {} as never,
    snapshot as never,
    "user-1",
    verificationExecution({ outcome: "review_required", identities: [] }),
  );
  assert.equal(transition.kind, "advance");
  if (transition.kind !== "advance") return;
  const receipt = transition.stepReceipt;
  assert.equal(receipt?.outcome, "review_required");
  assert.deepEqual(receipt?.artifact_ids, [documentId]);
  assert.deepEqual(receipt?.verified_artifacts, []);
});

test("a public Task snapshot without user_id validates one Task-owned Tabular Review from the authenticated owner context", async () => {
  const reviewId = "44444444-4444-4444-8444-444444444444";
  const deliverables = normalizeAgentTaskArtifactContracts([
    {
      key: "inventory",
      title: "Evidence inventory",
      description: "A fixed Matter-owned evidence review.",
      required: true,
      artifact_type: "tabular_review",
      purpose: "Evidence inventory",
    },
  ]);
  const goal = compileAgentGoalSpec({
    objective: "Prepare an evidence inventory.",
    taskFamily: "litigation_evidence_test",
    artifactContracts: deliverables,
    hasSources: false,
  });
  const context = buildMatterContextManifest({
    matterId: "matter-1",
    compiledAt: "2026-08-08T00:00:00.000Z",
    sources: [],
  });
  const contracts = compileAgentStepContracts({
    steps: [
      { capability: "read_sources" },
      { capability: "create_tabular" },
      { capability: "verify" },
    ],
    goalSpec: goal,
    artifactContracts: deliverables,
    contextManifest: context,
  });
  const snapshot = {
    task: {
      id: "task-1",
      matter_id: "matter-1",
      goal: "Prepare an evidence inventory.",
      deliverables,
      latest_checkpoint: buildAgentTaskContractCheckpoint({
        goalSpec: goal,
        contextManifest: context,
        stepContracts: contracts,
        capabilityGrants: [],
        createdAt: "2026-08-08T00:00:00.000Z",
      }),
      current_plan: [
        { id: "step-read", status: "completed", attempt: 1 },
        { id: "step-tabular", status: "running", attempt: 1 },
        { id: "step-verify", status: "pending", attempt: 0 },
      ],
    },
    artifacts: [],
  };
  assert.equal(Object.hasOwn(snapshot.task, "user_id"), false);
  const db = {
    from(table: string) {
      assert.equal(table, "tabular_reviews");
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          assert.equal(column, "id");
          assert.equal(value, reviewId);
          return query;
        },
        async maybeSingle() {
          return {
            data: {
              id: reviewId,
              project_id: "matter-1",
              user_id: "user-1",
              row_protocol: "document_rows",
            },
            error: null,
          };
        },
      };
      return query;
    },
  };
  const execution = {
    summary: "Created the fixed evidence inventory.",
    artifacts: [
      {
        artifact_type: "tabular_review" as const,
        artifact_id: reviewId,
        purpose: "Evidence inventory",
      },
    ],
    waitingForInput: false,
    citationCheck: { total: 0, relocatable: 0, missing: 0 },
  } as never;

  const accepted = await prepareCurrentAgentStepTransition(
    db as never,
    snapshot as never,
    "user-1",
    execution,
  );
  assert.equal(accepted.kind, "advance");
  if (accepted.kind === "advance") {
    assert.equal(
      accepted.stepReceipt?.postconditions.some(
        (postcondition) =>
          postcondition.code === "artifact_current_version" &&
          postcondition.status === "pass",
      ),
      true,
    );
  }

  const rejected = await prepareCurrentAgentStepTransition(
    db as never,
    snapshot as never,
    "different-user",
    execution,
  );
  assert.equal(rejected.kind, "postcondition_pause");
});
