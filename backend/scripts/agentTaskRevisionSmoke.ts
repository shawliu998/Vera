import assert from "node:assert/strict";

import { prepareAgentTaskRevisionTransition } from "../src/lib/agentTasks";

const startedAt = "2026-08-07T09:00:00.000Z";
const revisionId = "00000000-0000-4000-8000-000000000090";
const decisionId = "00000000-0000-4000-8000-000000000080";

const sourceRequirement = {
  mode: "pinned",
  citations_required: true,
  authority_as_of_required: false,
  jurisdictions: [],
  as_of_date: null,
};

function snapshot(options?: { legacy?: boolean; incomplete?: boolean }) {
  const steps = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      title: "Read sources",
      expected_output: "Checkpoint",
      status: "completed",
      attempt: 1,
      result_summary: "Read.",
      result_data: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      title: "Analyze",
      expected_output: "Checkpoint",
      status: "completed",
      attempt: 1,
      result_summary: "Analyzed.",
      result_data: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      title: options?.legacy ? "Analyze again" : "Opaque operation A",
      expected_output: options?.legacy ? "Checkpoint" : "Opaque output A",
      status: "completed",
      attempt: 2,
      result_summary: "Created.",
      result_data: { effect_receipts: { historical: true } },
    },
    {
      id: "00000000-0000-4000-8000-000000000004",
      title: options?.legacy ? "Draft revised Word" : "Opaque operation B",
      expected_output: options?.legacy
        ? "Word work product"
        : "Opaque output B",
      status: options?.incomplete ? "pending" : "completed",
      attempt: 1,
      result_summary: "Drafted.",
      result_data: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000005",
      title: "Verify",
      expected_output: "Verification",
      status: "completed",
      attempt: 1,
      result_summary: "Verified.",
      result_data: null,
    },
  ];
  const stepContracts = {
    kind: "agent_step_contract_set_v1",
    steps: [
      {
        schema_version: "agent_step_contract_v1",
        position: 0,
        capability: "read_sources",
        operation: "read",
        output_expectation: { kind: "checkpoint" },
        source_requirement: sourceRequirement,
        deterministic_postconditions: ["summary_present"],
      },
      {
        schema_version: "agent_step_contract_v1",
        position: 1,
        capability: "analyze",
        operation: "classify",
        output_expectation: { kind: "checkpoint" },
        source_requirement: sourceRequirement,
        deterministic_postconditions: ["summary_present"],
      },
      {
        schema_version: "agent_step_contract_v1",
        position: 2,
        capability: "create_tabular",
        operation: "table.create",
        output_expectation: {
          kind: "artifact",
          deliverable_key: "matrix",
          artifact_type: "tabular_review",
        },
        source_requirement: sourceRequirement,
        deterministic_postconditions: [
          "summary_present",
          "artifact_created",
          "artifact_current_version",
        ],
      },
      {
        schema_version: "agent_step_contract_v1",
        position: 3,
        capability: "create_draft",
        operation: "draft.edit",
        output_expectation: {
          kind: "artifact",
          deliverable_key: "memo",
          artifact_type: "draft",
        },
        source_requirement: sourceRequirement,
        deterministic_postconditions: [
          "summary_present",
          "artifact_created",
          "artifact_current_version",
        ],
      },
      {
        schema_version: "agent_step_contract_v1",
        position: 4,
        capability: "verify",
        operation: "verify",
        output_expectation: { kind: "verification" },
        source_requirement: sourceRequirement,
        deterministic_postconditions: [
          "required_deliverables_current",
          "verifier_passed",
        ],
      },
    ],
  };
  return {
    task: {
      id: "00000000-0000-4000-8000-000000000010",
      status: "completed",
      latest_checkpoint: options?.legacy
        ? { step_receipts: [{ kind: "historical" }] }
        : {
            schema_version: "agent_task_checkpoint_v1",
            contract: { step_contracts: stepContracts },
            step_receipts: [{ kind: "historical" }],
          },
      current_plan: steps,
    },
    artifacts: [],
    review: {
      decisions: [
        {
          id: decisionId,
          task_id: "00000000-0000-4000-8000-000000000010",
          status: "changes_requested",
          reviewer_id: "user-revision",
          reviewer_email: null,
          reviewer_name: null,
          note: "Correct the governing-law analysis and regenerate outputs.",
          artifact_snapshot: [],
          created_at: "2026-08-07T08:59:00.000Z",
        },
      ],
      status: "changes_requested",
      version_state: {},
    },
  };
}

const versioned = prepareAgentTaskRevisionTransition(
  snapshot() as never,
  startedAt,
  revisionId,
);
assert.equal(versioned.revisionStart, 1);
assert.equal(versioned.first.id, "00000000-0000-4000-8000-000000000002");
assert.equal(versioned.nextAttempt, 2);
assert.deepEqual(
  (versioned.checkpoint as Record<string, unknown>).revision_request,
  {
    kind: "agent_task_revision_v1",
    revision_id: revisionId,
    review_decision_id: decisionId,
    first_step_id: "00000000-0000-4000-8000-000000000002",
    revision_start: 1,
    attempt: 2,
    requested_at: startedAt,
  },
);
assert.deepEqual(
  (versioned.checkpoint as Record<string, unknown>).step_receipts,
  [{ kind: "historical" }],
  "revision preserves historical execution receipts",
);

const legacy = prepareAgentTaskRevisionTransition(
  snapshot({ legacy: true }) as never,
  startedAt,
  revisionId,
);
assert.equal(legacy.revisionStart, 1);

assert.throws(
  () =>
    prepareAgentTaskRevisionTransition(
      snapshot({ incomplete: true }) as never,
      startedAt,
      revisionId,
    ),
  /inconsistent revision Step states/,
);

const emptyDirection = snapshot();
emptyDirection.review.decisions[0]!.note = "   ";
assert.throws(
  () =>
    prepareAgentTaskRevisionTransition(
      emptyDirection as never,
      startedAt,
      revisionId,
    ),
  /lawyer direction/,
);

console.log(
  JSON.stringify({ ok: true, suite: "agent-task-revision-smoke-v1" }, null, 2),
);
