import assert from "node:assert/strict";
import test from "node:test";

import {
  compileContractPlaybookReceipt,
  deriveContractPlaybookFindingId,
  verifyContractPlaybookPack,
} from "./contractPlaybookPack";
import { compileContractPlaybookMaterializationPlan } from "./contractPlaybookMaterialization";

const ids = {
  step: "11111111-1111-4111-8111-111111111111",
  contractDocument: "22222222-2222-4222-8222-222222222222",
  contractVersion: "33333333-3333-4333-8333-333333333333",
  playbookDocument: "44444444-4444-4444-8444-444444444444",
  playbookVersion: "55555555-5555-4555-8555-555555555555",
  citationSnapshot: "66666666-6666-4666-8666-666666666666",
};

const acceptedFinding = {
  material: true,
  rule_id: "PRC-NDA-001",
  rule_version: "1.0.0",
  rule_outcome: "deviation" as const,
  issue_type: "governing_law",
  risk_level: "high" as const,
  priority: "must" as const,
  confidence: 0.94,
  target_position: "PRC law",
  fallback_position: null,
  walk_away_position: null,
  contract_anchor: "Clause 12",
  contract_quote: "This Agreement is governed by English law.",
  contract_citation_refs: [1],
  playbook_citation_refs: [2],
  recommendation: "Use PRC law.",
  proposed_text: "This Agreement is governed by PRC law.",
};

const commentFinding = {
  ...acceptedFinding,
  rule_id: "PRC-NDA-002",
  issue_type: "confidentiality_term",
  contract_anchor: "Clause 4",
  contract_quote: "The confidentiality obligations continue for one year.",
  contract_citation_refs: [3],
  playbook_citation_refs: [4],
  recommendation: "Confirm whether the survival period is sufficient.",
  proposed_text: null,
};

const missingFinding = {
  ...acceptedFinding,
  rule_id: "PRC-NDA-003",
  rule_outcome: "missing" as const,
  issue_type: "return_or_destroy",
  contract_anchor: null,
  contract_quote: null,
  contract_citation_refs: [],
  playbook_citation_refs: [5],
  recommendation: "Add a return-or-destroy obligation through bounded editing.",
  proposed_text: null,
};

function receipt(input?: {
  findings?: unknown[];
  decisions?: Record<string, unknown>;
}) {
  const findings = input?.findings ?? [acceptedFinding];
  return compileContractPlaybookReceipt({
    reviewMode: "deep",
    opinionLanguage: "bilingual",
    analyzeStepId: ids.step,
    analyzeAttempt: 1,
    contract: {
      document_id: ids.contractDocument,
      version_id: ids.contractVersion,
    },
    reference: {
      role: "playbook",
      document_id: ids.playbookDocument,
      version_id: ids.playbookVersion,
      rule_set_digest: `sha256:${"a".repeat(64)}`,
      expected_rule_count: findings.length,
    },
    citationSnapshotArtifactId: ids.citationSnapshot,
    findings,
    decisions: input?.decisions,
  });
}

function opinionText(
  plan: ReturnType<typeof compileContractPlaybookMaterializationPlan>,
) {
  return plan.opinion.sections
    .flatMap((section) => [
      section.heading,
      section.content ?? "",
      ...(section.table?.headers ?? []),
      ...(section.table?.rows.flat() ?? []),
    ])
    .join("\n");
}

test("one receipt deterministically drives revision actions and opinion", () => {
  const findings = [acceptedFinding, commentFinding, missingFinding];
  const decisions = {
    [deriveContractPlaybookFindingId(acceptedFinding)]: {
      disposition: "accept",
      direction: null,
    },
    [deriveContractPlaybookFindingId(commentFinding)]: {
      disposition: "comment",
      direction: "Escalate the duration to the business owner.",
    },
    [deriveContractPlaybookFindingId(missingFinding)]: {
      disposition: "comment",
      direction: null,
    },
  };
  const fixed = receipt({ findings, decisions });
  const first = compileContractPlaybookMaterializationPlan(fixed);
  const second = compileContractPlaybookMaterializationPlan(fixed);

  assert.equal(first.status, "ready");
  assert.equal(first.receipt_fingerprint, second.receipt_fingerprint);
  assert.deepEqual(first.revision_actions, [
    {
      kind: "replace_exact_span",
      finding_id: deriveContractPlaybookFindingId(acceptedFinding),
      rule_id: "PRC-NDA-001",
      find: acceptedFinding.contract_quote,
      replace: acceptedFinding.proposed_text,
      reason: "PRC-NDA-001",
    },
    {
      kind: "comment_exact_span",
      finding_id: deriveContractPlaybookFindingId(commentFinding),
      rule_id: "PRC-NDA-002",
      anchor: commentFinding.contract_quote,
      comment: "Escalate the duration to the business owner.",
    },
  ]);
  assert.deepEqual(first.unresolved_finding_ids, [
    deriveContractPlaybookFindingId(missingFinding),
  ]);
  assert.deepEqual(
    verifyContractPlaybookPack({
      receipt: fixed,
      reviewOpinionText: opinionText(first),
    }),
    { status: "pass", issues: [] },
  );
});

test("conflicting exact spans are removed from the mutation plan", () => {
  const duplicate = {
    ...acceptedFinding,
    rule_id: "PRC-NDA-099",
    issue_type: "forum",
    recommendation: "Add an exclusive forum.",
    proposed_text: null,
    contract_citation_refs: [6],
    playbook_citation_refs: [7],
  };
  const findings = [acceptedFinding, duplicate];
  const fixed = receipt({
    findings,
    decisions: {
      [deriveContractPlaybookFindingId(acceptedFinding)]: {
        disposition: "accept",
        direction: null,
      },
      [deriveContractPlaybookFindingId(duplicate)]: {
        disposition: "comment",
        direction: null,
      },
    },
  });
  const plan = compileContractPlaybookMaterializationPlan(fixed);
  assert.equal(plan.status, "review_required");
  assert.deepEqual(plan.revision_actions, []);
  assert.equal(plan.issues[0]?.code, "conflicting_exact_span");
  assert.equal(plan.unresolved_finding_ids.length, 2);
});

test("co-anchored comments remain safe while replacements stay unique", () => {
  const secondComment = {
    ...commentFinding,
    rule_id: "PRC-NDA-099",
    issue_type: "second_comment",
    recommendation: "Record a second rule-specific direction.",
    contract_citation_refs: [6],
    playbook_citation_refs: [7],
  };
  const findings = [commentFinding, secondComment];
  const fixed = receipt({
    findings,
    decisions: Object.fromEntries(
      findings.map((finding) => [
        deriveContractPlaybookFindingId(finding),
        { disposition: "comment", direction: null },
      ]),
    ),
  });
  const plan = compileContractPlaybookMaterializationPlan(fixed);
  assert.equal(plan.status, "ready");
  assert.equal(plan.revision_actions.length, 2);
  assert.deepEqual(plan.issues, []);
});

test("missing decisions and no-op replacements fail closed before DOCX writes", () => {
  const undecided = compileContractPlaybookMaterializationPlan(receipt());
  assert.equal(undecided.status, "review_required");
  assert.equal(undecided.issues[0]?.code, "material_disposition_missing");

  const noOp = {
    ...acceptedFinding,
    proposed_text: acceptedFinding.contract_quote,
  };
  const findingId = deriveContractPlaybookFindingId(noOp);
  const noOpPlan = compileContractPlaybookMaterializationPlan(
    receipt({
      findings: [noOp],
      decisions: {
        [findingId]: { disposition: "accept", direction: null },
      },
    }),
  );
  assert.equal(noOpPlan.status, "review_required");
  assert.deepEqual(noOpPlan.revision_actions, []);
  assert.equal(noOpPlan.issues[0]?.code, "replacement_is_noop");
});
