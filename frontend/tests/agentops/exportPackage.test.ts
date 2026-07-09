import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAuditPack,
  buildAgentRunAuditEvents,
  buildEvalCaseExport,
  buildExportPackage,
  buildGateResultAuditEvents,
  buildHumanApprovalLog,
  buildReviewCommentAuditEvents,
  buildToolCallAuditEvents,
  buildToolCallLog,
  computeExportHash,
  EVAL_FAILURE_TYPES,
  validateExportPackageIntegrity,
} from "../../src/aletheia/agentops/exportPackage";
import {
  sampleAgentOpsWorkspace,
} from "../../src/aletheia/agentops/fixtures";
import type { GateProvenance } from "../../src/aletheia/agentops/gateProvenance";
import type { AgentOpsMatterWorkspace } from "../../src/aletheia/agentops/types";

const exportedAt = "2026-07-09T10:00:00.000Z";

function workspaceWithToolCall(): AgentOpsMatterWorkspace {
  const firstRun = sampleAgentOpsWorkspace.runs[0];
  assert.ok(firstRun);

  return {
    ...sampleAgentOpsWorkspace,
    runs: [
      {
        ...firstRun,
        tool_calls: [
          {
            id: "tool-call-search-evidence",
            name: "search_matter_documents",
            started_at: "2026-07-09T09:05:00.000Z",
            ended_at: "2026-07-09T09:05:02.000Z",
            status: "succeeded",
            input: { query: "notice window" },
            output: { evidenceIds: ["evidence-notice-window"] },
          },
        ],
        trace_events: [
          {
            id: "trace-plan",
            timestamp: "2026-07-09T09:04:00.000Z",
            level: "info",
            message: "Planned evidence search before memo drafting.",
          },
        ],
      },
      ...sampleAgentOpsWorkspace.runs.slice(1),
    ],
  };
}

test("buildAuditPack includes the product audit pack sections and stable export hash", () => {
  const pack = buildAuditPack(workspaceWithToolCall(), exportedAt);

  assert.equal(pack.schema_version, "aletheia-audit-pack-v1");
  assert.equal(pack.matter_profile.id, sampleAgentOpsWorkspace.matter.id);
  assert.equal(pack.document_list.length, sampleAgentOpsWorkspace.matter.documents.length);
  assert.equal(pack.evidence_matrix.length, sampleAgentOpsWorkspace.evidence.length);
  assert.equal(pack.issue_map.length, sampleAgentOpsWorkspace.issues.length);
  assert.equal(pack.risk_register.length, sampleAgentOpsWorkspace.risks.length);
  assert.equal(pack.review_comments.length, sampleAgentOpsWorkspace.review_comments.length);
  assert.ok(pack.gate_results.some((gate) => gate.gate_type === "human_approval"));
  assert.equal(pack.agent_run_trace.length, sampleAgentOpsWorkspace.runs.length);
  assert.equal(
    pack.audit_events.filter((event) => event.action === "agent_run_recorded")
      .length,
    sampleAgentOpsWorkspace.runs.length,
  );
  assert.equal(
    pack.audit_events.filter((event) => event.action === "tool_call_recorded")
      .length,
    1,
  );
  assert.equal(
    pack.audit_events.filter((event) => event.action === "review_comment_recorded")
      .length,
    sampleAgentOpsWorkspace.review_comments.length,
  );
  assert.equal(
    pack.audit_events.filter((event) => event.action === "gate_result_recorded")
      .length,
    sampleAgentOpsWorkspace.gate_results.length,
  );
  assert.equal(pack.tool_call_log[0]?.id, "tool-call-search-evidence");
  assert.ok(pack.human_approval_log.length > 0);
  assert.ok(pack.typed_handoff_provenance.length > 0);
  assert.ok(pack.eval_cases.some((item) => item.failure_type === "expert_override"));
  assert.match(pack.export_hash, /^fnv1a32:[a-f0-9]{8}$/);
  assert.equal(buildAuditPack(workspaceWithToolCall(), exportedAt).export_hash, pack.export_hash);
});

test("buildAgentRunAuditEvents turns AgentRun trace entries into audit events", () => {
  const workspace = workspaceWithToolCall();
  const events = buildAgentRunAuditEvents(workspace, exportedAt);

  assert.equal(events.length, workspace.runs.length);
  assert.equal(events[0]?.artifact_type, "agent_run");
  assert.equal(events[0]?.artifact_id, workspace.runs[0]?.id);
  assert.equal(events[0]?.actor_id, workspace.runs[0]?.agent_id);
  assert.equal(events[0]?.action, "agent_run_recorded");
  assert.match(events[0]?.after_hash ?? "", /^fnv1a32:[a-f0-9]{8}$/);
  assert.deepEqual(events[0]?.referenced_artifacts, [
    ...workspace.runs[0]!.input_artifacts,
    ...workspace.runs[0]!.output_artifacts,
  ]);
});

test("buildToolCallAuditEvents records tool calls as run-scoped audit events", () => {
  const workspace = workspaceWithToolCall();
  const events = buildToolCallAuditEvents(workspace, exportedAt);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, "tool_call_recorded");
  assert.equal(events[0]?.artifact_type, "agent_run");
  assert.equal(events[0]?.artifact_id, workspace.runs[0]?.id);
  assert.equal(events[0]?.actor_id, workspace.runs[0]?.agent_id);
  assert.equal(events[0]?.timestamp, "2026-07-09T09:05:02.000Z");
  assert.match(events[0]?.after_hash ?? "", /^fnv1a32:[a-f0-9]{8}$/);
  assert.deepEqual(events[0]?.referenced_artifacts?.[0], {
    id: workspace.runs[0]?.id,
    type: "agent_run",
  });
});

test("buildReviewCommentAuditEvents records expert feedback in the audit trail", () => {
  const events = buildReviewCommentAuditEvents(sampleAgentOpsWorkspace, exportedAt);
  const openComment = sampleAgentOpsWorkspace.review_comments.find(
    (comment) => comment.id === "review-comment-open-items",
  );

  assert.ok(openComment);
  assert.equal(events.length, sampleAgentOpsWorkspace.review_comments.length);
  assert.ok(
    events.some(
      (event) =>
        event.id === `audit-export-review-comment-${openComment.id}` &&
        event.actor_type === "human" &&
        event.actor_id === openComment.author &&
        event.action === "review_comment_recorded" &&
        event.artifact_id === openComment.artifact_id &&
        event.artifact_type === openComment.artifact_type,
    ),
  );
});

test("buildGateResultAuditEvents records gate outcomes with affected artifacts", () => {
  const events = buildGateResultAuditEvents(sampleAgentOpsWorkspace, exportedAt);
  const humanApprovalGate = sampleAgentOpsWorkspace.gate_results.find(
    (gate) => gate.id === "gate-human-approval",
  );

  assert.ok(humanApprovalGate);
  assert.equal(events.length, sampleAgentOpsWorkspace.gate_results.length);
  const event = events.find(
    (item) => item.id === `audit-export-gate-result-${humanApprovalGate.id}`,
  );
  assert.ok(event);
  assert.equal(event.actor_type, "system");
  assert.equal(event.actor_id, "gate-engine");
  assert.equal(event.action, "gate_result_recorded");
  assert.equal(event.artifact_type, "gate_result");
  assert.equal(event.artifact_id, humanApprovalGate.id);
  assert.match(event.after_hash ?? "", /^fnv1a32:[a-f0-9]{8}$/);
  assert.ok(
    humanApprovalGate.affected_artifact_ids.every((artifactId) =>
      event.referenced_artifacts?.some((ref) => ref.id === artifactId),
    ),
  );
});

test("buildEvalCaseExport preserves all supported failure classes and derives review/gate cases", () => {
  const exportPayload = buildEvalCaseExport(sampleAgentOpsWorkspace, exportedAt);

  assert.deepEqual(exportPayload.failure_types, EVAL_FAILURE_TYPES);
  assert.ok(
    exportPayload.cases.some((item) => item.failure_type === "missing_citation"),
  );
  assert.ok(
    exportPayload.cases.some((item) => item.failure_type === "expert_override"),
  );
  assert.ok(exportPayload.source_review_comment_ids.includes("review-comment-open-items"));
  assert.ok(exportPayload.source_gate_result_ids.includes("gate-human-approval"));
});

test("tool call and approval logs keep run and human-gate provenance", () => {
  const workspace = workspaceWithToolCall();
  const toolCalls = buildToolCallLog(workspace);
  const approvals = buildHumanApprovalLog(workspace);

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.run_id, workspace.runs[0]?.id);
  assert.equal(toolCalls[0]?.agent_id, workspace.runs[0]?.agent_id);
  assert.ok(
    approvals.some(
      (approval) =>
        approval.source_type === "gate_result" &&
        approval.source_id === "gate-human-approval" &&
        approval.status === "open",
    ),
  );
  assert.ok(
    approvals.some(
      (approval) =>
        approval.source_type === "review_state" &&
        approval.artifact_type === "evidence_item",
    ),
  );
});

test("buildExportPackage wraps audit and eval exports with manifest counts", () => {
  const workspace = workspaceWithToolCall();
  const exportPackage = buildExportPackage(workspace, exportedAt);

  assert.equal(exportPackage.schema_version, "aletheia-export-package-v1");
  assert.equal(exportPackage.manifest.tool_calls, 1);
  assert.equal(
    exportPackage.manifest.audit_events,
    exportPackage.audit_pack.audit_events.length,
  );
  assert.equal(
    exportPackage.manifest.eval_cases,
    exportPackage.eval_case_export.cases.length,
  );
  assert.equal(
    exportPackage.manifest.handoff_provenance_items,
    exportPackage.audit_pack.typed_handoff_provenance.length,
  );
  assert.equal(
    exportPackage.audit_pack.export_hash,
    buildAuditPack(workspace, exportedAt).export_hash,
  );
  assert.equal(
    computeExportHash({
      schema_version: exportPackage.schema_version,
      exported_at: exportPackage.exported_at,
      matter_id: exportPackage.matter_id,
      audit_pack: exportPackage.audit_pack,
      eval_case_export: exportPackage.eval_case_export,
      manifest: exportPackage.manifest,
    }),
    exportPackage.export_hash,
  );
});

test("buildExportPackage includes adapter gate provenance in typed handoff export", () => {
  const gateProvenance: GateProvenance[] = [
    {
      gateId: "gate-human-approval",
      gateType: "human_approval",
      status: "failed",
      sourceType: "human_checkpoint",
      sourceId: "checkpoint-export-approval",
      sourceStatus: "open",
      relatedWorkProductIds: [sampleAgentOpsWorkspace.draft_memos[0]!.id],
      relatedReviewIds: ["review-comment-open-items"],
      relatedAuditEventIds: ["audit-memo-generated"],
    },
  ];
  const exportPackage = buildExportPackage(sampleAgentOpsWorkspace, exportedAt, {
    gateProvenance,
  });
  const memoProvenance = exportPackage.audit_pack.typed_handoff_provenance.find(
    (item) => item.artifactId === sampleAgentOpsWorkspace.draft_memos[0]!.id,
  );

  assert.ok(memoProvenance);
  assert.ok(memoProvenance.gateResultIds.includes("gate-human-approval"));
  assert.ok(
    memoProvenance.sourceRecordIds.checkpointIds.includes(
      "checkpoint-export-approval",
    ),
  );
  assert.ok(
    memoProvenance.sourceRecordIds.reviewItemIds.includes(
      "review-comment-open-items",
    ),
  );
  assert.ok(
    memoProvenance.sourceRecordIds.auditEventIds.includes("audit-memo-generated"),
  );
  assert.deepEqual(
    validateExportPackageIntegrity(exportPackage).map((item) => [
      item.name,
      item.status,
    ]),
    [
      ["package_hash", "passed"],
      ["audit_pack_hash", "passed"],
      ["manifest_counts", "passed"],
      ["evidence_audit_eval_loop", "passed"],
      ["human_review_gate_loop", "passed"],
    ],
  );
});

test("validateExportPackageIntegrity verifies hash, manifest, and loop linkage", () => {
  const exportPackage = buildExportPackage(workspaceWithToolCall(), exportedAt);
  const validation = validateExportPackageIntegrity(exportPackage);

  assert.deepEqual(
    validation.map((item) => [item.name, item.status]),
    [
      ["package_hash", "passed"],
      ["audit_pack_hash", "passed"],
      ["manifest_counts", "passed"],
      ["evidence_audit_eval_loop", "passed"],
      ["human_review_gate_loop", "passed"],
    ],
  );
});

test("validateExportPackageIntegrity flags tampered hashes and manifest drift", () => {
  const exportPackage = buildExportPackage(workspaceWithToolCall(), exportedAt);
  const tampered = {
    ...exportPackage,
    export_hash: "fnv1a32:00000000",
    manifest: {
      ...exportPackage.manifest,
      tool_calls: exportPackage.manifest.tool_calls + 1,
    },
  };
  const validation = validateExportPackageIntegrity(tampered);

  assert.equal(
    validation.find((item) => item.name === "package_hash")?.status,
    "failed",
  );
  assert.equal(
    validation.find((item) => item.name === "manifest_counts")?.status,
    "failed",
  );
  assert.equal(
    validation.find((item) => item.name === "audit_pack_hash")?.status,
    "passed",
  );
});
