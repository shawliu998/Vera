import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRequiredInput } from "@/app/types/agent";
import {
  agentRequiredInputNeedsDocuments,
  buildAgentRequiredInputMessage,
} from "./agentRequiredInput";

function requiredInput(documentsRequired: boolean): AgentRequiredInput {
  return {
    kind: "required_input_v1",
    request_id: "ri_contract-review",
    step_id: "step-2",
    reason_code: documentsRequired ? "missing_source" : "lawyer_choice",
    prompt: "Choose a position and optionally attach facts.",
    resume_strategy: "retry_step",
    created_at: "2026-08-08T00:00:00.000Z",
    items: [
      {
        id: "posture",
        kind: "choice",
        question: "Which negotiation posture should Vera use?",
        options: [{ value: "Balanced" }, { value: "Conservative" }],
        allow_other: false,
        other_label: "Other",
      },
      {
        id: "facts",
        kind: "documents",
        document_types: ["Background facts"],
        required: documentsRequired,
      },
    ],
  };
}

test("optional supporting documents do not block a complete lawyer decision", () => {
  const request = requiredInput(false);
  assert.equal(agentRequiredInputNeedsDocuments(request), false);
  assert.match(
    buildAgentRequiredInputMessage({
      requiredInput: request,
      answers: { posture: "Balanced" },
      attachedDocumentCount: 0,
    }) ?? "",
    /Preserve unknown facts as unresolved/,
  );
});

test("required documents and every lawyer choice remain hard boundaries", () => {
  const request = requiredInput(true);
  assert.equal(agentRequiredInputNeedsDocuments(request), true);
  assert.equal(
    buildAgentRequiredInputMessage({
      requiredInput: request,
      answers: { posture: "Balanced" },
      attachedDocumentCount: 0,
    }),
    null,
  );
  assert.equal(
    buildAgentRequiredInputMessage({
      requiredInput: request,
      answers: {},
      attachedDocumentCount: 1,
    }),
    null,
  );
});
