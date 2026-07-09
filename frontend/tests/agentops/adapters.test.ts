import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptAletheiaMatterDetailToAgentOpsWorkspace,
  summarizeAdapterProvenance,
} from "../../src/aletheia/agentops/adapters";
import {
  buildAgentOpsSnapshotDetails,
  buildGateProvenance,
} from "../../src/aletheia/agentops/gateProvenance";
import { validateWorkspaceReferences } from "../../src/aletheia/agentops/handoff";
import { createMatterMemoryIndex } from "../../src/aletheia/agentops/matterMemory";
import { resolveBigAtReferences } from "../../src/aletheia/agentops/references";
import { computeWorkspaceEvalMetrics } from "../../src/lib/agentops/eval";
import type { AletheiaMatterDetail } from "../../src/app/lib/aletheiaApi";

const now = "2026-07-09T09:00:00.000Z";

const detail = {
  matter: {
    id: "matter-adapter-test",
    user_id: "user-test",
    title: "Adapter Source Matter",
    template: "legal_matter_review",
    status: "needs_review",
    client_or_project: "Test Client",
    objective: "Validate adapter-backed AgentOps artifacts.",
    risk_level: "high",
    source_project_id: null,
    shared_with: [],
    metadata: {},
    created_at: now,
    updated_at: now,
  },
  documents: [
    {
      id: "matter-doc-1",
      matter_id: "matter-adapter-test",
      user_id: "user-test",
      document_id: "source-doc-1",
      name: "Notice Agreement.pdf",
      document_type: "contract",
      parsed_status: "parsed",
      summary: "Notice agreement",
      metadata: { indexed: true, hash: "sha256:test-doc" },
      created_at: now,
      updated_at: now,
    },
  ],
  workProducts: [
    {
      id: "wp-issue-map",
      matter_id: "matter-adapter-test",
      user_id: "user-test",
      kind: "issue_map",
      title: "Issue Map",
      status: "generated",
      schema_version: "aletheia-issue-map-v0",
      content: {
        issues: [
          {
            id: "claim-notice",
            title: "Notice timing",
            claimId: "claim-notice",
            supportSummary: { supports: 1, contradicts: 0, insufficient: 1 },
            evidenceIds: ["evidence-notice", "evidence-gap"],
            openQuestions: ["Confirm when the notice period started."],
          },
        ],
      },
      validation_errors: [],
      generated_by: "agent",
      model: "deterministic-local",
      created_at: now,
      updated_at: now,
    },
    {
      id: "wp-draft-memo",
      matter_id: "matter-adapter-test",
      user_id: "user-test",
      kind: "draft_memo",
      title: "Draft Memo",
      status: "needs_review",
      schema_version: "aletheia-draft-memo-v0",
      content: {
        title: "Adapter Source Matter Draft Memo",
        sections: [
          {
            id: "memo-analysis",
            title: "Analysis",
            body: [
              "The notice timing issue is source-linked but still needs expert review.",
            ],
            evidenceIds: ["evidence-notice"],
            claimIds: ["claim-notice"],
          },
          {
            id: "memo-gap",
            title: "Open Gap",
            body: ["The trigger date remains unresolved."],
            evidenceIds: [],
            claimIds: ["claim-notice"],
            unsupported_claim_count: 1,
          },
        ],
      },
      validation_errors: ["memo-gap requires a cited source or open-item flag"],
      generated_by: "agent",
      model: "deterministic-local",
      created_at: now,
      updated_at: now,
    },
  ],
  evidence: [
    {
      id: "evidence-notice",
      matter_id: "matter-adapter-test",
      work_product_id: "wp-issue-map",
      document_id: "source-doc-1",
      source_chunk_id: "chunk-1",
      claim_id: "claim-notice",
      document_name: "Notice Agreement.pdf",
      page: 4,
      section: "Notice",
      quote: "Notice must be provided within 48 hours.",
      quote_start: 11,
      quote_end: 55,
      relevance: "direct",
      support_status: "supports",
      confidence: "high",
      metadata: { normalizedFact: "The agreement has a 48-hour notice window." },
      created_at: now,
    },
    {
      id: "evidence-gap",
      matter_id: "matter-adapter-test",
      work_product_id: "wp-issue-map",
      document_id: "source-doc-1",
      source_chunk_id: "chunk-2",
      claim_id: "claim-notice",
      document_name: "Notice Agreement.pdf",
      page: 5,
      section: "Incident record",
      quote: "The record does not state when confirmation occurred.",
      quote_start: 0,
      quote_end: 51,
      relevance: "indirect",
      support_status: "insufficient",
      confidence: "medium",
      metadata: {},
      created_at: now,
    },
  ],
  reviews: [
    {
      id: "review-gap",
      matter_id: "matter-adapter-test",
      work_product_id: "wp-draft-memo",
      evidence_item_id: "evidence-gap",
      target_type: "claim",
      target_id: "claim-notice",
      tag: "missing_fact",
      comment: "Do not finalize until the incident confirmation date is sourced.",
      reviewer_user_id: "reviewer-1",
      reviewer_name: "Expert Reviewer",
      created_at: now,
    },
  ],
  auditEvents: [
    {
      id: "audit-memo",
      matter_id: "matter-adapter-test",
      user_id: "user-test",
      actor: "agent",
      action: "memo_generated",
      workflow_version: "aletheia-local-v0",
      model: "deterministic-local",
      details: {
        workProductId: "wp-draft-memo",
        artifactType: "draft_memo",
        afterHash: "sha256:memo",
      },
      created_at: now,
    },
  ],
  agentRuns: [
    {
      id: "run-review",
      matter_id: "matter-adapter-test",
      user_id: "user-test",
      workflow: "legal_matter_review",
      goal: "Draft and review memo",
      status: "needs_human",
      current_step_key: "human_review",
      model_profile: "deterministic-local",
      storage_driver: "local",
      budget: { maxSteps: 7, maxToolCalls: 5 },
      metadata: {},
      started_at: now,
      completed_at: null,
      created_at: now,
      updated_at: now,
      steps: [
        {
          id: "step-memo",
          run_id: "run-review",
          matter_id: "matter-adapter-test",
          user_id: "user-test",
          step_key: "draft_memo",
          title: "Draft review memo",
          sequence: 1,
          status: "completed",
          input: {},
          output: { specialistRole: "Memo Drafter", workProductKind: "draft_memo" },
          validation_errors: [],
          metrics: {},
          started_at: now,
          completed_at: now,
          created_at: now,
        },
        {
          id: "step-review",
          run_id: "run-review",
          matter_id: "matter-adapter-test",
          user_id: "user-test",
          step_key: "human_review",
          title: "Human review checkpoint",
          sequence: 2,
          status: "needs_human",
          input: {},
          output: { specialistRole: "Risk Reviewer", checkpoint: "final_memo_review" },
          validation_errors: [],
          metrics: {},
          started_at: now,
          completed_at: null,
          created_at: now,
        },
      ],
      tool_calls: [
        {
          id: "tool-work-product",
          run_id: "run-review",
          step_id: "step-memo",
          matter_id: "matter-adapter-test",
          user_id: "user-test",
          tool_name: "work_product_create",
          risk_level: "high",
          status: "completed",
          input: { kind: "draft_memo" },
          output: { workProductId: "wp-draft-memo" },
          error: null,
          metrics: {},
          started_at: now,
          completed_at: now,
          created_at: now,
        },
      ],
      human_checkpoints: [
        {
          id: "checkpoint-final",
          run_id: "run-review",
          step_id: "step-review",
          matter_id: "matter-adapter-test",
          user_id: "user-test",
          checkpoint_type: "final_memo_review",
          status: "open",
          prompt: "Expert approval is required before final memo export.",
          decision: null,
          requested_payload: { workProductId: "wp-draft-memo" },
          decision_payload: {},
          decided_by: null,
          decided_at: null,
          created_at: now,
        },
      ],
    },
  ],
  matterMemory: [],
  playbooks: [
    {
      id: "playbook-review",
      matter_id: "matter-adapter-test",
      user_id: "user-test",
      name: "High-risk memo review",
      description: "Require source verification before final export.",
      version: "1.0.0",
      status: "approved",
      content: {
        evidenceRequirements: ["source_chunk_id", "quote_offsets"],
        evalCaseIds: ["eval-review-gap"],
      },
      approved_by: "reviewer-1",
      approved_at: now,
      created_at: now,
      updated_at: now,
    },
  ],
} satisfies AletheiaMatterDetail;

test("adapts persisted Aletheia records into the AgentOps product loop", () => {
  const workspace = adaptAletheiaMatterDetailToAgentOpsWorkspace(detail);
  const summary = summarizeAdapterProvenance(workspace);

  assert.equal(workspace.matter.id, "matter-adapter-test");
  assert.equal(workspace.matter.type, "legal_review");
  assert.equal(workspace.matter.status, "waiting_for_approval");
  assert.equal(workspace.matter.documents[0]?.id, "source-doc-1");
  assert.equal(workspace.matter.documents[0]?.status, "indexed");

  assert.equal(workspace.evidence[0]?.source_chunk_id, "chunk-1");
  assert.equal(workspace.evidence[0]?.quote_start, 11);
  assert.equal(workspace.evidence[0]?.quote_end, 55);
  assert.equal(workspace.evidence[0]?.support_status, "supports");

  assert.equal(workspace.issues[0]?.id, "claim-notice");
  assert.deepEqual(workspace.issues[0]?.related_evidence_ids, [
    "evidence-notice",
    "evidence-gap",
  ]);
  assert.equal(workspace.risks[0]?.related_issue_ids[0], "claim-notice");

  assert.equal(workspace.draft_memos[0]?.id, "wp-draft-memo");
  assert.equal(workspace.draft_memos[0]?.unsupported_claim_count, 2);
  assert.deepEqual(workspace.draft_memos[0]?.sections[0]?.issue_reference_ids, [
    "claim-notice",
  ]);
  assert.equal(workspace.review_comments[0]?.tag, "missing_fact");
  assert.equal(workspace.review_comments[0]?.evidence_item_id, "evidence-gap");

  assert.ok(
    workspace.gate_results.some(
      (gate) =>
        gate.gate_type === "human_approval" &&
        gate.status === "failed" &&
        gate.affected_artifact_ids.includes("wp-draft-memo"),
    ),
  );
  assert.equal(workspace.audit_events[0]?.artifact_id, "wp-draft-memo");
  assert.equal(workspace.eval_cases[0]?.source_run_id, "run-review");
  assert.equal(workspace.eval_cases[0]?.failure_type, "missing_citation");
  assert.equal(workspace.skills[0]?.approval_status, "approved");

  const referenceValidation = validateWorkspaceReferences(workspace);
  assert.deepEqual(referenceValidation.errors, []);
  assert.equal(referenceValidation.ok, true);

  assert.equal(summary.evidence_with_source_chunks, 2);
  assert.equal(summary.evidence_with_quote_offsets, 2);
  assert.deepEqual(summary.review_tags, ["missing_fact"]);

  const referenceIndex = createMatterMemoryIndex(workspace);
  const resolutions = resolveBigAtReferences(
    "@Matter @Evidence:evidence-notice @Gate:checkpoint-final @Run:run-review",
    referenceIndex,
  );
  assert.deepEqual(
    resolutions.map((resolution) => resolution.status),
    ["resolved", "resolved", "resolved", "resolved"],
  );
  assert.equal(resolutions[1]?.matches[0]?.artifact_ref?.type, "evidence_item");
  assert.equal(resolutions[2]?.matches[0]?.artifact_ref?.type, "gate_result");
  assert.equal(resolutions[3]?.matches[0]?.artifact_ref?.type, "agent_run");

  const missingEvidence = resolveBigAtReferences(
    "@Evidence:not-present",
    referenceIndex,
  );
  assert.equal(missingEvidence[0]?.status, "missing");
  assert.equal(missingEvidence[0]?.matches.length, 0);

  const metrics = computeWorkspaceEvalMetrics(workspace);
  assert.equal(metrics.unsupported_claim_count, 2);
  assert.equal(metrics.unresolved_review_comments, 1);
  assert.ok(metrics.gate_failure_count >= 1);
  assert.equal(metrics.issue_coverage?.covered_issue_count, 1);
  assert.equal(metrics.issue_coverage?.total_issue_count, 1);
});

test("maps displayed gate results back to persisted Aletheia provenance", () => {
  const workspace = adaptAletheiaMatterDetailToAgentOpsWorkspace(detail);
  const gateProvenance = buildGateProvenance({ detail, workspace });

  const checkpointGate = gateProvenance.find(
    (item) => item.gateId === "gate-checkpoint-checkpoint-final",
  );
  assert.equal(checkpointGate?.sourceType, "human_checkpoint");
  assert.equal(checkpointGate?.sourceId, "checkpoint-final");
  assert.equal(checkpointGate?.sourceStatus, "open");
  assert.deepEqual(checkpointGate?.relatedWorkProductIds, ["wp-draft-memo"]);
  assert.deepEqual(checkpointGate?.relatedReviewIds, ["review-gap"]);
  assert.deepEqual(checkpointGate?.relatedAuditEventIds, ["audit-memo"]);

  const validationGate = gateProvenance.find(
    (item) => item.gateId === "gate-validation-wp-draft-memo-0",
  );
  assert.equal(validationGate?.sourceType, "work_product_validation");
  assert.equal(validationGate?.sourceId, "wp-draft-memo");
  assert.equal(
    validationGate?.sourceStatus,
    "needs_review; 1 validation errors",
  );
  assert.deepEqual(validationGate?.relatedWorkProductIds, ["wp-draft-memo"]);
  assert.deepEqual(validationGate?.relatedReviewIds, ["review-gap"]);
  assert.deepEqual(validationGate?.relatedAuditEventIds, ["audit-memo"]);

  const referenceIndex = createMatterMemoryIndex(workspace);
  const referenceResolutions = resolveBigAtReferences(
    "@Matter @Evidence:evidence-notice @Evidence:missing @Gate:checkpoint-final @Run:run-review",
    referenceIndex,
  );
  const snapshot = buildAgentOpsSnapshotDetails({
    workspace,
    provenance: summarizeAdapterProvenance(workspace),
    gateProvenance,
    referenceResolutions,
    evalMetrics: computeWorkspaceEvalMetrics(workspace),
  });

  assert.equal(snapshot.sourceOfTruth, "aletheia_matter_records");
  assert.equal(snapshot.artifactCounts.gates, 2);
  assert.deepEqual(
    snapshot.gateProvenance.map((item) => item.sourceType).sort(),
    ["human_checkpoint", "work_product_validation"],
  );
  assert.deepEqual(
    snapshot.referenceAuditCandidates.map((item) => item.status),
    ["resolved", "resolved", "missing", "resolved", "resolved"],
  );
  assert.equal(
    snapshot.referenceAuditCandidates[1].resolved_artifact_refs[0]?.id,
    "evidence-notice",
  );
  assert.equal(
    snapshot.referenceAuditCandidates[2].resolved_artifact_refs.length,
    0,
  );
  assert.match(
    snapshot.referenceAuditCandidates[2].required_review_action ?? "",
    /missing Big @ reference/,
  );
});
