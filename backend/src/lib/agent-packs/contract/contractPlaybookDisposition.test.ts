import assert from "node:assert/strict";
import test from "node:test";

import {
  applyContractPlaybookDispositionRevisionIntent,
  applyContractPlaybookDispositionResponses,
  createContractPlaybookDispositionRevisionIntent,
  createContractPlaybookDispositionRequiredInput,
} from "./contractPlaybookDisposition";
import {
  compileContractPlaybookReceipt,
  deriveContractPlaybookFindingId,
} from "./contractPlaybookPack";

const finding = {
  material: true,
  rule_id: "PRC-SVC-001",
  rule_version: "1.0.0",
  rule_outcome: "deviation" as const,
  issue_type: "scope",
  risk_level: "high" as const,
  priority: "must" as const,
  confidence: 0.9,
  target_position: "Fixed scope",
  fallback_position: null,
  walk_away_position: null,
  contract_anchor: "Clause 2",
  contract_quote: "Supplier may change scope.",
  contract_citation_refs: [1],
  playbook_citation_refs: [2],
  recommendation: "Require written change control.",
  proposed_text: "Scope changes require written agreement.",
};

function receipt() {
  return compileContractPlaybookReceipt({
    reviewMode: "deep",
    opinionLanguage: "zh",
    analyzeStepId: "11111111-1111-4111-8111-111111111111",
    analyzeAttempt: 1,
    contract: {
      document_id: "22222222-2222-4222-8222-222222222222",
      version_id: "33333333-3333-4333-8333-333333333333",
    },
    reference: {
      role: "playbook",
      document_id: "44444444-4444-4444-8444-444444444444",
      version_id: "55555555-5555-4555-8555-555555555555",
      rule_set_digest: `sha256:${"a".repeat(64)}`,
      expected_rule_count: 16,
    },
    citationSnapshotArtifactId: "66666666-6666-4666-8666-666666666666",
    findings: [finding],
  });
}

test("material findings expose exact accept, comment and skip meanings", () => {
  const required = createContractPlaybookDispositionRequiredInput({
    receipt: receipt(),
    stepId: "77777777-7777-4777-8777-777777777777",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  assert.ok(required);
  const item = required.items[0];
  assert.equal(item?.kind, "choice");
  if (item?.kind !== "choice") return;
  assert.deepEqual(
    item.options.map((option) => option.value),
    ["accept", "comment", "skip"],
  );
  assert.match(item.question, /Fixed source span: Supplier may change scope\./);
  assert.match(
    item.options[0]?.label ?? "",
    /Accept fixed text: Scope changes require written agreement\./,
  );
});

test("free-text Other is persisted as comment direction, never replacement text", () => {
  const fixed = receipt();
  const required = createContractPlaybookDispositionRequiredInput({
    receipt: fixed,
    stepId: "77777777-7777-4777-8777-777777777777",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  assert.ok(required);
  const findingId = deriveContractPlaybookFindingId(finding);
  const updated = applyContractPlaybookDispositionResponses({
    receipt: fixed,
    requiredInput: required!,
    responses: [
      {
        id: `contract-finding:${findingId}`,
        kind: "choice",
        answer: "Retain the clause but add a negotiation note.",
      },
    ],
  });
  assert.equal(updated.findings[0]?.lawyer_disposition, "comment");
  assert.equal(
    updated.findings[0]?.lawyer_direction,
    "Retain the clause but add a negotiation note.",
  );
  assert.equal(updated.findings[0]?.proposed_text, finding.proposed_text);
});

test("review correction binds the complete disposition set to the fixed receipt", () => {
  const fixed = compileContractPlaybookReceipt({
    ...receipt(),
    reviewMode: "deep",
    opinionLanguage: "zh",
    analyzeStepId: "11111111-1111-4111-8111-111111111111",
    analyzeAttempt: 1,
    contract: receipt().contract,
    reference: receipt().reference,
    citationSnapshotArtifactId: receipt().citation_snapshot_artifact_id,
    findings: [finding],
    decisions: {
      [deriveContractPlaybookFindingId(finding)]: {
        disposition: "comment",
        direction: null,
      },
    },
  });
  const findingId = fixed.findings[0]!.finding_id;
  const intent = createContractPlaybookDispositionRevisionIntent({
    receipt: fixed,
    decisions: [
      { finding_id: findingId, disposition: "skip", direction: null },
    ],
  });
  assert.equal(intent.contract_version_id, fixed.contract.version_id);
  const revised = applyContractPlaybookDispositionRevisionIntent({
    receipt: fixed,
    intent,
  });
  assert.equal(revised.findings[0]?.lawyer_disposition, "skip");
  assert.equal(revised.findings[0]?.lawyer_direction, null);
});

test("review correction rejects no-op and incomplete disposition sets", () => {
  const fixed = compileContractPlaybookReceipt({
    reviewMode: "deep",
    opinionLanguage: "zh",
    analyzeStepId: "11111111-1111-4111-8111-111111111111",
    analyzeAttempt: 1,
    contract: receipt().contract,
    reference: receipt().reference,
    citationSnapshotArtifactId: receipt().citation_snapshot_artifact_id,
    findings: [finding],
    decisions: {
      [deriveContractPlaybookFindingId(finding)]: {
        disposition: "comment",
        direction: null,
      },
    },
  });
  assert.throws(
    () =>
      createContractPlaybookDispositionRevisionIntent({
        receipt: fixed,
        decisions: [],
      }),
    /at least 1 element|must decide/i,
  );
  assert.throws(
    () =>
      createContractPlaybookDispositionRevisionIntent({
        receipt: fixed,
        decisions: [
          {
            finding_id: fixed.findings[0]!.finding_id,
            disposition: "comment",
            direction: null,
          },
        ],
      }),
    /change at least one lawyer decision/i,
  );
});

test("accept is unavailable without a complete exact replacement boundary", () => {
  const fixed = compileContractPlaybookReceipt({
    reviewMode: "deep",
    opinionLanguage: "en",
    analyzeStepId: "11111111-1111-4111-8111-111111111111",
    analyzeAttempt: 1,
    contract: {
      document_id: "22222222-2222-4222-8222-222222222222",
      version_id: "33333333-3333-4333-8333-333333333333",
    },
    reference: {
      role: "playbook",
      document_id: "44444444-4444-4444-8444-444444444444",
      version_id: "55555555-5555-4555-8555-555555555555",
      rule_set_digest: `sha256:${"a".repeat(64)}`,
      expected_rule_count: 16,
    },
    citationSnapshotArtifactId: "66666666-6666-4666-8666-666666666666",
    findings: [{ ...finding, proposed_text: null }],
  });
  const required = createContractPlaybookDispositionRequiredInput({
    receipt: fixed,
    stepId: "77777777-7777-4777-8777-777777777777",
  });
  const item = required?.items[0];
  assert.equal(item?.kind, "choice");
  if (item?.kind !== "choice") return;
  assert.deepEqual(
    item.options.map((option) => option.value),
    ["comment", "skip"],
  );
});

test("large material reviews are resumed in bounded decision batches", () => {
  const findings = Array.from({ length: 9 }, (_, index) => ({
    ...finding,
    rule_id: `PRC-SVC-${String(index + 1).padStart(3, "0")}`,
    contract_anchor: `Clause ${index + 1}`,
    contract_quote: `Fixed contract quote ${index + 1}.`,
  }));
  const fixed = compileContractPlaybookReceipt({
    reviewMode: "deep",
    opinionLanguage: "zh",
    analyzeStepId: "11111111-1111-4111-8111-111111111111",
    analyzeAttempt: 1,
    contract: {
      document_id: "22222222-2222-4222-8222-222222222222",
      version_id: "33333333-3333-4333-8333-333333333333",
    },
    reference: {
      role: "playbook",
      document_id: "44444444-4444-4444-8444-444444444444",
      version_id: "55555555-5555-4555-8555-555555555555",
      rule_set_digest: `sha256:${"a".repeat(64)}`,
      expected_rule_count: 16,
    },
    citationSnapshotArtifactId: "66666666-6666-4666-8666-666666666666",
    findings,
  });
  const first = createContractPlaybookDispositionRequiredInput({
    receipt: fixed,
    stepId: "77777777-7777-4777-8777-777777777777",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(first?.items.length, 8);
  const updated = applyContractPlaybookDispositionResponses({
    receipt: fixed,
    requiredInput: first!,
    responses: first!.items.map((item) => ({
      id: item.id,
      kind: "choice" as const,
      answer: "skip",
    })),
  });
  const second = createContractPlaybookDispositionRequiredInput({
    receipt: updated,
    stepId: "77777777-7777-4777-8777-777777777777",
  });
  assert.equal(second?.items.length, 1);
});
