import assert from "node:assert/strict";
import test from "node:test";

import { Document, Packer, Paragraph, TextRun } from "docx";

import {
  compileContractPlaybookReceipt,
  deriveContractPlaybookFindingId,
} from "./agent-packs/contract/contractPlaybookPack";
import { compileContractPlaybookMaterializationPlan } from "./agent-packs/contract/contractPlaybookMaterialization";
import {
  ContractPlaybookWordMaterializationError,
  materializeContractPlaybookWordDocuments,
} from "./agentContractPlaybookWordMaterializer";
import {
  applyTrackedEdits,
  extractDocxReviewMarkup,
} from "./docxTrackedChanges";

const replaceFinding = {
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
  ...replaceFinding,
  rule_id: "PRC-NDA-002",
  issue_type: "confidentiality_term",
  contract_anchor: "Clause 4",
  contract_quote: "The confidentiality obligations continue for one year.",
  contract_citation_refs: [3],
  playbook_citation_refs: [4],
  recommendation: "Confirm whether the survival period is sufficient.",
  proposed_text: null,
};

function fixedReceipt() {
  return compileContractPlaybookReceipt({
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
      expected_rule_count: 2,
    },
    citationSnapshotArtifactId: "66666666-6666-4666-8666-666666666666",
    findings: [replaceFinding, commentFinding],
    decisions: {
      [deriveContractPlaybookFindingId(replaceFinding)]: {
        disposition: "accept",
        direction: null,
      },
      [deriveContractPlaybookFindingId(commentFinding)]: {
        disposition: "comment",
        direction: "Escalate the duration to the business owner.",
      },
    },
  });
}

async function sourceDocx() {
  return Buffer.from(
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [new TextRun(replaceFinding.contract_quote)],
              }),
              new Paragraph({
                children: [new TextRun(commentFinding.contract_quote)],
              }),
            ],
          },
        ],
      }),
    ),
  );
}

test("revision and clean copy are materialized from one fixed plan", async () => {
  const result = await materializeContractPlaybookWordDocuments({
    sourceBytes: await sourceDocx(),
    plan: compileContractPlaybookMaterializationPlan(fixedReceipt()),
    author: "Vera",
    initials: "V",
    date: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(result.trackedChanges.length, 1);
  assert.equal(result.comments.length, 1);
  assert.equal(
    result.acceptedBody,
    `${replaceFinding.proposed_text}\n${commentFinding.contract_quote}`,
  );
  assert.equal(result.sourceBody.includes("English law"), true);
  assert.equal(result.acceptedBody.includes("English law"), false);

  const revisionMarkup = await extractDocxReviewMarkup(result.revisionBytes);
  assert.deepEqual(revisionMarkup.items.map((item) => item.kind).sort(), [
    "comment",
    "deletion",
    "insertion",
  ]);
  assert.deepEqual(
    (await extractDocxReviewMarkup(result.cleanBytes)).items,
    [],
  );
});

test("pre-existing source review markup is preserved and routed to review", async () => {
  const source = await sourceDocx();
  const marked = await applyTrackedEdits(source, [
    {
      find: "English law",
      replace: "Singapore law",
      context_before: "governed by",
      context_after: ".",
    },
  ]);
  await assert.rejects(
    () =>
      materializeContractPlaybookWordDocuments({
        sourceBytes: marked.bytes,
        plan: compileContractPlaybookMaterializationPlan(fixedReceipt()),
      }),
    (error: unknown) =>
      error instanceof ContractPlaybookWordMaterializationError &&
      error.issueCode === "source_review_markup_present",
  );
});

test("partially overlapping actions fail before any derived DOCX is returned", async () => {
  const plan = compileContractPlaybookMaterializationPlan(fixedReceipt());
  const commentAction = plan.revision_actions[1];
  plan.revision_actions[1] = {
    kind: "comment_exact_span",
    finding_id: commentAction.finding_id,
    rule_id: commentAction.rule_id,
    anchor: "Agreement is governed by English",
    comment: "Overlaps the replacement.",
  };
  await assert.rejects(
    async () =>
      materializeContractPlaybookWordDocuments({
        sourceBytes: await sourceDocx(),
        plan,
      }),
    (error: unknown) =>
      error instanceof ContractPlaybookWordMaterializationError &&
      error.issueCode === "action_anchor_overlap",
  );
});
