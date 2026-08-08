import assert from "node:assert/strict";
import test from "node:test";

import {
  compileContractPlaybookReceipt,
  deriveContractPlaybookFindingId,
  verifyContractPlaybookPack,
} from "./contractPlaybookPack";

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

function receipt(decisions: Record<string, unknown> = {}) {
  return compileContractPlaybookReceipt({
    reviewMode: "deep",
    opinionLanguage: "zh",
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
      expected_rule_count: 1,
    },
    citationSnapshotArtifactId: ids.citationSnapshot,
    findings: [acceptedFinding],
    decisions,
  });
}

test("server derives a stable finding id and binds only fixed decisions", () => {
  const findingId = deriveContractPlaybookFindingId(acceptedFinding);
  const compiled = receipt({
    [findingId]: { disposition: "accept", direction: null },
  });
  assert.equal(compiled.findings[0]?.finding_id, findingId);
  assert.equal(compiled.findings[0]?.lawyer_disposition, "accept");
  assert.throws(
    () => receipt({ "finding-000000000000000000000000": { disposition: "skip", direction: null } }),
    /not bound/i,
  );
});

test("accept requires one exact source span and fixed replacement text", () => {
  const withoutProposedText = { ...acceptedFinding, proposed_text: null };
  const findingId = deriveContractPlaybookFindingId(withoutProposedText);
  assert.throws(
    () =>
      compileContractPlaybookReceipt({
        reviewMode: "deep",
        opinionLanguage: "zh",
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
          rule_set_digest: `sha256:${"b".repeat(64)}`,
          expected_rule_count: 1,
        },
        citationSnapshotArtifactId: ids.citationSnapshot,
        findings: [withoutProposedText],
        decisions: {
          [findingId]: { disposition: "accept", direction: null },
        },
      }),
    /anchor|contract span/i,
  );
});

test("a missing decision and unavailable opinion are review gaps, not parse failure", () => {
  assert.deepEqual(verifyContractPlaybookPack({ receipt: receipt(), reviewOpinionText: null }), {
    status: "gap",
    issues: [
      {
        code: "material_disposition_missing",
        finding_id: deriveContractPlaybookFindingId(acceptedFinding),
        rule_id: acceptedFinding.rule_id,
      },
      {
        code: "review_opinion_unavailable",
        finding_id: null,
        rule_id: null,
      },
    ],
  });
});

test("opinion verification rejects reversed disposition and missing adopted text", () => {
  const findingId = deriveContractPlaybookFindingId(acceptedFinding);
  const fixed = receipt({
    [findingId]: { disposition: "accept", direction: null },
  });
  const reversed = verifyContractPlaybookPack({
    receipt: fixed,
    reviewOpinionText:
      "PRC-NDA-001 律师决定：保留原文，不作修改。 This Agreement is governed by PRC law.",
  });
  assert.deepEqual(reversed.issues.map((issue) => issue.code), [
    "decision_mismatch",
  ]);

  const missingText = verifyContractPlaybookPack({
    receipt: fixed,
    reviewOpinionText: "PRC-NDA-001 律师决定：采纳建议文本并纳入修订稿。",
  });
  assert.deepEqual(missingText.issues.map((issue) => issue.code), [
    "adopted_text_missing",
  ]);
});

test("opinion verification passes only when rule, decision, and adopted text align", () => {
  const findingId = deriveContractPlaybookFindingId(acceptedFinding);
  const fixed = receipt({
    [findingId]: { disposition: "accept", direction: null },
  });
  const result = verifyContractPlaybookPack({
    receipt: fixed,
    reviewOpinionText:
      "PRC-NDA-001 律师决定：采纳建议文本并纳入修订稿。 已采纳文本：This Agreement is governed by PRC law.",
  });
  assert.deepEqual(result, { status: "pass", issues: [] });
});

test("checklist mode binds the fixed rule-set count", () => {
  assert.throws(
    () =>
      compileContractPlaybookReceipt({
        reviewMode: "checklist",
        opinionLanguage: "en",
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
          rule_set_digest: `sha256:${"c".repeat(64)}`,
          expected_rule_count: 2,
        },
        citationSnapshotArtifactId: ids.citationSnapshot,
        findings: [acceptedFinding],
      }),
    /exactly one finding/i,
  );
});
