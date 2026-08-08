import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRequiredInput } from "./agent-kernel/contracts/requiredInput";
import {
  prepareAgentTaskInputTransition,
  readAgentTaskSupplementalInput,
} from "./agentTasks";

test("structured Required Input resumes one blocked Step and persists server-owned context", () => {
  const required = createAgentRequiredInput({
    stepId: "step-contract-read",
    createdAt: "2026-08-08T00:00:00.000Z",
    items: [
      {
        id: "review-mode",
        kind: "choice",
        question: "Review mode?",
        options: [{ value: "deep", label: "Deep review" }],
        allow_other: false,
        other_label: "Other",
      },
    ],
  });
  const transition = prepareAgentTaskInputTransition(
    {
      task: {
        status: "waiting_input",
        current_plan: [
          {
            id: "step-contract-read",
            status: "blocked",
            attempt: 1,
          },
          { id: "step-analyze", status: "pending", attempt: 0 },
        ],
        latest_checkpoint: {
          step_id: "step-contract-read",
          iteration: 1,
          required_input: required,
          fixed_matter_context: { kind: "matter_context_v1" },
        },
      },
    },
    {
      responses: [{ id: "review-mode", kind: "choice", answer: "deep" }],
      serverCheckpointValues: {
        contract_playbook_context: {
          kind: "contract_playbook_context_v1",
        },
      },
    },
    "2026-08-08T00:01:00.000Z",
    "submission-1",
  );

  assert.equal(transition.status, "running");
  assert.equal(transition.checkpoint.required_input, undefined);
  assert.deepEqual(transition.checkpoint.resolved_required_input_ids, [
    required.request_id,
  ]);
  assert.deepEqual(transition.checkpoint.contract_playbook_context, {
    kind: "contract_playbook_context_v1",
  });
  assert.deepEqual(
    (transition.checkpoint.user_input as { structured_responses: unknown })
      .structured_responses,
    [{ id: "review-mode", kind: "choice", answer: "deep" }],
  );
});

test("malformed checkpoint responses are not trusted as supplemental input", () => {
  const supplemental = readAgentTaskSupplementalInput({
    latest_checkpoint: {
      user_input: {
        step_id: "step-1",
        attempt: 2,
        submitted_at: "2026-08-08T00:00:00.000Z",
        document_ids: [],
        structured_responses: [
          { id: "review-mode", kind: "choice", answer: 42 },
        ],
      },
    },
  });
  assert.ok(supplemental);
  assert.equal(supplemental.structured_responses, undefined);
});
