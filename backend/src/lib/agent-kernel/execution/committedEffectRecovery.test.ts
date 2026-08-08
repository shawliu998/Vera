import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointAllowsPriorEffectRecovery,
  recoverCommittedStepEffectArtifact,
} from "../../agentTaskExecution";

function snapshot(input?: { status?: string; fingerprint?: string }) {
  const stepId = "14c2f916-0a20-4c50-ac8c-b52fd172e45c";
  const documentId = "81a296fa-eb9c-b168-26f8-91b5ba177aa0";
  const versionId = "2166ee7a-29c1-0547-a669-b60cf7ccadd5";
  return {
    task: {
      deliverables: [
        {
          key: "patentability-memo",
          title: "Patentability Memo",
          artifact_type: "draft",
          required: true,
        },
      ],
      current_plan: [
        {
          id: "5a928e3e-fd44-4ec8-8a92-3a3ec070ff70",
          status: "completed",
          attempt: 1,
          result_data: null,
        },
        {
          id: stepId,
          status: input?.status ?? "running",
          attempt: 1,
          result_data: {
            effect_receipts: {
              [`agent-step:${stepId}:attempt:1:generate_docx`]: {
                kind: "agent_step_effect_v1",
                effect_key: `agent-step:${stepId}:attempt:1:generate_docx`,
                step_id: stepId,
                attempt: 1,
                tool_name: "generate_docx",
                input_fingerprint:
                  input?.fingerprint ??
                  "f27b9b64ab17ccbd638e105b4d8ea1c9924ff0c688ccb65e20a11b527fe5cb7f",
                status: "committed",
                target: { document_id: documentId, version_id: versionId },
                effect: {
                  document_id: documentId,
                  version_id: versionId,
                  artifact_type: "draft",
                },
                created_at: "2026-08-07T16:10:44.850Z",
                committed_at: "2026-08-07T16:10:44.991Z",
              },
            },
          },
        },
        {
          id: "40e2985d-bdfe-4316-ad09-17a9419af4e7",
          status: "pending",
          attempt: 0,
          result_data: null,
        },
      ],
      latest_checkpoint: {
        contract: {
          goal_spec: {
            kind: "agent_goal_v1",
            objective: "Run Patentability Assessment.",
            task_family: "generic",
            jurisdictions: [],
            must_ask_when: [],
            source_standard: {
              authority_required: false,
              authority_as_of_required: false,
              material_claims_require_citations: true,
            },
            deliverable_keys: ["patentability-memo"],
            completion_checks: [],
            as_of_date: null,
          },
          step_contracts: {
            kind: "agent_step_contract_set_v1",
            steps: [
              {
                schema_version: "agent_step_contract_v1",
                position: 0,
                operation: "read",
                capability: "read_sources",
                output_expectation: { kind: "checkpoint" },
                source_requirement: {
                  mode: "pinned",
                  as_of_date: null,
                  jurisdictions: [],
                  citations_required: true,
                  authority_as_of_required: false,
                },
                deterministic_postconditions: [
                  "summary_present",
                  "source_versions_recorded",
                ],
              },
              {
                schema_version: "agent_step_contract_v1",
                position: 1,
                operation: "draft.create",
                capability: "create_draft",
                output_expectation: {
                  kind: "artifact",
                  artifact_type: "draft",
                  deliverable_key: "patentability-memo",
                },
                source_requirement: {
                  mode: "pinned",
                  as_of_date: null,
                  jurisdictions: [],
                  citations_required: true,
                  authority_as_of_required: false,
                },
                deterministic_postconditions: [
                  "summary_present",
                  "source_versions_recorded",
                  "artifact_created",
                  "artifact_current_version",
                ],
              },
              {
                schema_version: "agent_step_contract_v1",
                position: 2,
                operation: "verify",
                capability: "verify",
                output_expectation: { kind: "verification" },
                source_requirement: {
                  mode: "pinned",
                  as_of_date: null,
                  jurisdictions: [],
                  citations_required: true,
                  authority_as_of_required: false,
                },
                deterministic_postconditions: [
                  "summary_present",
                  "source_versions_recorded",
                  "required_deliverables_current",
                  "source_requirement_satisfied",
                  "verifier_passed",
                ],
              },
            ],
          },
          context_manifest: {
            kind: "matter_context_v1",
            matter_id: "24af052a-6f46-4c9f-bec8-253a0cde084c",
            sources: [],
            compiled_at: "2026-08-07T15:57:30.669Z",
          },
          capability_grants: [],
        },
      },
    },
    artifacts: [],
    review: { decisions: [] },
  };
}

function tabularSnapshot() {
  const value = snapshot() as ReturnType<typeof snapshot>;
  const step = value.task.current_plan[1];
  const reviewId = "a7ad52b8-698e-4af5-b72a-7031064cf79f";
  value.task.deliverables = [
    {
      key: "evidence-inventory",
      title: "Evidence Inventory",
      artifact_type: "tabular_review",
      required: true,
    },
  ];
  value.task.latest_checkpoint.contract.goal_spec.deliverable_keys = [
    "evidence-inventory",
  ];
  value.task.latest_checkpoint.contract.step_contracts.steps[1].operation =
    "table.create";
  value.task.latest_checkpoint.contract.step_contracts.steps[1].capability =
    "create_tabular";
  value.task.latest_checkpoint.contract.step_contracts.steps[1].output_expectation =
    {
      kind: "artifact",
      artifact_type: "tabular_review",
      deliverable_key: "evidence-inventory",
    };
  step.result_data = {
    tabular_effect_receipts: {
      [`agent-step:${step.id}:attempt:1:create_tabular_review`]: {
        kind: "agent_step_tabular_effect_v1",
        effect_key: `agent-step:${step.id}:attempt:1:create_tabular_review`,
        step_id: step.id,
        attempt: 1,
        operation: "create_tabular_review",
        input_fingerprint:
          "95a1cb8be3eeb4706e28ce29e290cd94e4c1c6dcefc6e73a29cbb4f1712a8dde",
        status: "committed",
        target: { review_id: reviewId },
        effect: {
          review_id: reviewId,
          artifact_type: "tabular_review",
        },
        created_at: "2026-08-08T08:00:00.000Z",
        committed_at: "2026-08-08T08:00:01.000Z",
      },
    },
  };
  return value;
}

test("recovers one committed fixed Artifact after a duplicate mutation conflict", () => {
  const recovered = recoverCommittedStepEffectArtifact(snapshot() as never);
  assert.deepEqual(recovered?.artifacts, [
    {
      artifact_type: "draft",
      artifact_id: "81a296fa-eb9c-b168-26f8-91b5ba177aa0",
      purpose: "Patentability Memo",
    },
  ]);
  assert.match(recovered?.summary ?? "", /idempotency fence/i);
});

test("does not treat a committed Tabular publication as a completed Step", () => {
  assert.equal(
    recoverCommittedStepEffectArtifact(tabularSnapshot() as never),
    null,
  );
});

test("does not accept a legacy spreadsheet Document as a Tabular Review", () => {
  const value = tabularSnapshot();
  value.task.current_plan[1].result_data =
    snapshot().task.current_plan[1].result_data;
  assert.equal(recoverCommittedStepEffectArtifact(value as never), null);
});

test("does not recover without one running Step", () => {
  assert.equal(
    recoverCommittedStepEffectArtifact(
      snapshot({ status: "blocked" }) as never,
    ),
    null,
  );
});

test("a resumed Step may recover the latest committed prior attempt", () => {
  const resumed = snapshot() as never as {
    task: { current_plan: Array<{ attempt: number }> };
  };
  resumed.task.current_plan[1].attempt = 2;
  assert.equal(
    recoverCommittedStepEffectArtifact(resumed as never, {
      includePriorAttempt: true,
    })?.receiptAttempt,
    1,
  );
  assert.equal(recoverCommittedStepEffectArtifact(resumed as never), null);
});

test("prior-attempt recovery requires a structured issue or exact legacy fallback", () => {
  assert.equal(
    checkpointAllowsPriorEffectRecovery({
      state_transition_pause: {
        kind: "agent_task_state_transition_pause_v1",
        issue: {
          kind: "agent_execution_issue_v1",
          code: "task_state_transition_conflict",
          recoverable: true,
        },
      },
    }),
    true,
  );
  assert.equal(
    checkpointAllowsPriorEffectRecovery({
      summary:
        "The Step effect could not be published from the current Task state",
    }),
    true,
  );
  assert.equal(
    checkpointAllowsPriorEffectRecovery({
      state_transition_pause: {},
      summary:
        "The Step effect could not be published from the current Task state",
    }),
    false,
  );
  assert.equal(
    checkpointAllowsPriorEffectRecovery({
      summary: "Lawyer requested a substantive revision",
    }),
    false,
  );
});
