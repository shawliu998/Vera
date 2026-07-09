import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAuditPack,
  buildAgentRunAuditEvents,
  buildEvalCaseExport,
  buildExportPackage,
  buildExportAuthorization,
  buildV1SourceIndexManifest,
  buildGateResultAuditEvents,
  buildHumanApprovalLog,
  buildReviewCommentAuditEvents,
  buildToolCallAuditEvents,
  buildToolCallLog,
  computeExportHash,
  EVAL_FAILURE_TYPES,
  validateExportPackageIntegrity,
} from "../../src/aletheia/agentops/exportPackage";
import { sampleAgentOpsWorkspace } from "../../src/aletheia/agentops/fixtures";
import type { GateProvenance } from "../../src/aletheia/agentops/gateProvenance";
import type { AgentOpsMatterWorkspace } from "../../src/aletheia/agentops/types";
import type { V1SourceIndexSnapshot } from "../../src/aletheia/agentops/exportPackage";

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

function localSourceIndex(): V1SourceIndexSnapshot {
  return {
    schema_version: "aletheia-v1-source-index-local-v0",
    storage_driver: "local",
    matter_id: sampleAgentOpsWorkspace.matter.id,
    generated_at: exportedAt,
    documents: [
      {
        ...sampleAgentOpsWorkspace.matter.documents[0]!,
        mime_type: "application/pdf",
        byte_size: 2048,
        parser: "deterministic",
        metadata: { source_storage_driver: "local" },
      },
    ],
    chunks: [
      {
        id: "chunk-notice-window",
        matter_id: sampleAgentOpsWorkspace.matter.id,
        document_id: "doc-master-services-agreement",
        text: "Vendor must notify Customer of a confirmed security incident no later than 48 hours after confirmation.",
        page: 12,
        section: "8.2 Security Incident Notice",
        start_offset: 1200,
        end_offset: 1301,
        metadata: {
          chunk_index: 0,
          source_storage_driver: "local",
        },
      },
    ],
    source_links: [
      {
        evidence_item_id: "evidence-notice-window",
        matter_id: sampleAgentOpsWorkspace.matter.id,
        document_id: "doc-master-services-agreement",
        source_chunk_id: "chunk-notice-window",
        page: 12,
        section: "8.2 Security Incident Notice",
        quote:
          "Vendor must notify Customer of a confirmed security incident no later than 48 hours after confirmation.",
        start_offset: 1200,
        end_offset: 1301,
        relevance: "direct",
        support_status: "supports",
        confidence: 0.94,
        metadata: { source_storage_driver: "local" },
        created_at: exportedAt,
      },
    ],
    limitations: [
      "Local source index lists parsed document records, chunks, and evidence source links; full document/page preview remains a separate UI concern.",
      "Supabase V1 document retrieval/listing is not implemented for the private pilot.",
    ],
  };
}

test("buildAuditPack includes the product audit pack sections and stable export hash", () => {
  const pack = buildAuditPack(workspaceWithToolCall(), exportedAt);

  assert.equal(pack.schema_version, "aletheia-audit-pack-v1");
  assert.equal(pack.matter_profile.id, sampleAgentOpsWorkspace.matter.id);
  assert.equal(
    pack.document_list.length,
    sampleAgentOpsWorkspace.matter.documents.length,
  );
  assert.equal(
    pack.evidence_matrix.length,
    sampleAgentOpsWorkspace.evidence.length,
  );
  assert.equal(pack.issue_map.length, sampleAgentOpsWorkspace.issues.length);
  assert.equal(pack.risk_register.length, sampleAgentOpsWorkspace.risks.length);
  assert.equal(
    pack.review_comments.length,
    sampleAgentOpsWorkspace.review_comments.length,
  );
  assert.ok(
    pack.gate_results.some((gate) => gate.gate_type === "human_approval"),
  );
  assert.equal(
    pack.agent_run_trace.length,
    sampleAgentOpsWorkspace.runs.length,
  );
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
    pack.audit_events.filter(
      (event) => event.action === "review_comment_recorded",
    ).length,
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
  assert.ok(
    pack.eval_cases.some((item) => item.failure_type === "expert_override"),
  );
  assert.match(pack.export_hash, /^fnv1a32:[a-f0-9]{8}$/);
  assert.equal(
    buildAuditPack(workspaceWithToolCall(), exportedAt).export_hash,
    pack.export_hash,
  );
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
  const events = buildReviewCommentAuditEvents(
    sampleAgentOpsWorkspace,
    exportedAt,
  );
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
  const events = buildGateResultAuditEvents(
    sampleAgentOpsWorkspace,
    exportedAt,
  );
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
  const exportPayload = buildEvalCaseExport(
    sampleAgentOpsWorkspace,
    exportedAt,
  );

  assert.deepEqual(exportPayload.failure_types, EVAL_FAILURE_TYPES);
  assert.ok(
    exportPayload.cases.some(
      (item) => item.failure_type === "missing_citation",
    ),
  );
  assert.ok(
    exportPayload.cases.some((item) => item.failure_type === "expert_override"),
  );
  assert.ok(
    exportPayload.source_review_comment_ids.includes(
      "review-comment-open-items",
    ),
  );
  assert.ok(
    exportPayload.source_gate_result_ids.includes("gate-human-approval"),
  );
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
    exportPackage.manifest.audit_event_agent_runs,
    exportPackage.audit_pack.audit_events.filter(
      (event) => event.action === "agent_run_recorded",
    ).length,
  );
  assert.equal(exportPackage.manifest.audit_event_tool_calls, 1);
  assert.equal(
    exportPackage.manifest.audit_event_review_comments,
    sampleAgentOpsWorkspace.review_comments.length,
  );
  assert.equal(
    exportPackage.manifest.audit_event_gate_results,
    sampleAgentOpsWorkspace.gate_results.length,
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

test("buildExportPackage can consume a local-only V1 source index manifest", () => {
  const sourceIndex = localSourceIndex();
  const sourceIndexManifest = buildV1SourceIndexManifest(
    sourceIndex,
    sampleAgentOpsWorkspace.matter.id,
  );
  const exportPackage = buildExportPackage(
    workspaceWithToolCall(),
    exportedAt,
    {
      sourceIndex,
    },
  );

  assert.equal(
    sourceIndexManifest.schema_version,
    "aletheia-v1-source-index-manifest-v1",
  );
  assert.equal(sourceIndexManifest.local_only, true);
  assert.equal(sourceIndexManifest.document_count, 1);
  assert.equal(sourceIndexManifest.chunk_count, 1);
  assert.equal(sourceIndexManifest.source_link_count, 1);
  assert.ok(
    sourceIndexManifest.limitations.some((item) =>
      item.includes(
        "Supabase V1 document, chunk, and source-link listing remains unavailable",
      ),
    ),
  );
  assert.deepEqual(
    sourceIndexManifest.validation.map((item) => [item.name, item.status]),
    [
      ["source_index_matter_scope", "passed"],
      ["source_index_documents", "passed"],
      ["source_index_chunks", "passed"],
      ["source_index_source_links", "passed"],
      ["source_index_contract_shape", "passed"],
      ["source_index_chunk_document_refs", "passed"],
      ["source_index_link_document_refs", "passed"],
      ["source_index_link_chunk_refs", "passed"],
      ["source_index_local_only", "warning"],
    ],
  );
  assert.equal(
    exportPackage.audit_pack.source_index_manifest?.source_index_schema_version,
    "aletheia-v1-source-index-local-v0",
  );
  assert.equal(exportPackage.manifest.source_index_documents, 1);
  assert.equal(exportPackage.manifest.source_index_chunks, 1);
  assert.equal(exportPackage.manifest.source_index_source_links, 1);
  assert.equal(
    validateExportPackageIntegrity(exportPackage).find(
      (item) => item.name === "manifest_counts",
    )?.status,
    "passed",
  );
  assert.equal(
    validateExportPackageIntegrity(exportPackage).find(
      (item) => item.name === "source_index_manifest_validation",
    )?.status,
    "warning",
  );
});

test("source-index manifest validation fails closed on orphaned references", () => {
  const sourceIndex = localSourceIndex();
  const orphanedSourceIndex: V1SourceIndexSnapshot = {
    ...sourceIndex,
    chunks: [
      {
        ...sourceIndex.chunks[0]!,
        document_id: "doc-missing-from-source-index",
      },
    ],
    source_links: [
      {
        ...sourceIndex.source_links[0]!,
        document_id: "doc-missing-from-source-index",
        source_chunk_id: "chunk-missing-from-source-index",
      },
    ],
  };
  const manifest = buildV1SourceIndexManifest(
    orphanedSourceIndex,
    sampleAgentOpsWorkspace.matter.id,
  );
  const validationByName = new Map(
    manifest.validation.map((item) => [item.name, item.status]),
  );
  const exportPackage = buildExportPackage(
    workspaceWithToolCall(),
    exportedAt,
    {
      sourceIndex: orphanedSourceIndex,
    },
  );

  assert.equal(
    validationByName.get("source_index_chunk_document_refs"),
    "failed",
  );
  assert.equal(
    validationByName.get("source_index_link_document_refs"),
    "failed",
  );
  assert.equal(validationByName.get("source_index_link_chunk_refs"), "failed");
  assert.equal(
    validateExportPackageIntegrity(exportPackage).find(
      (item) => item.name === "source_index_manifest_validation",
    )?.status,
    "failed",
  );
});

test("source-index manifest validation reuses shared V1 document and chunk guards", () => {
  const sourceIndex = localSourceIndex();
  const invalidSourceIndex: V1SourceIndexSnapshot = {
    ...sourceIndex,
    documents: [
      {
        ...sourceIndex.documents[0]!,
        uploaded_at: "",
      },
    ],
    chunks: [
      {
        ...sourceIndex.chunks[0]!,
        text: "",
      },
    ],
  };
  const manifest = buildV1SourceIndexManifest(
    invalidSourceIndex,
    sampleAgentOpsWorkspace.matter.id,
  );
  const contractShape = manifest.validation.find(
    (item) => item.name === "source_index_contract_shape",
  );

  assert.equal(contractShape?.status, "failed");
  assert.match(contractShape?.detail ?? "", /1 document\(s\), 1 chunk\(s\)/);
});

test("buildExportAuthorization allows draft warnings and fails closed for final export", () => {
  const draftAuthorization = buildExportAuthorization(
    sampleAgentOpsWorkspace.gate_results,
    "draft",
  );
  const blockedFinalAuthorization = buildExportAuthorization(
    sampleAgentOpsWorkspace.gate_results,
    "final",
  );
  const passedGateResults = [
    ...sampleAgentOpsWorkspace.gate_results.map((gate) => ({
      ...gate,
      status: "passed" as const,
    })),
    {
      id: "gate-export-ready",
      matter_id: sampleAgentOpsWorkspace.matter.id,
      gate_type: "export" as const,
      status: "passed" as const,
      reason: "All export requirements satisfied for focused test.",
      affected_artifact_ids: [sampleAgentOpsWorkspace.draft_memos[0]!.id],
      created_at: exportedAt,
    },
  ];
  const authorizedFinalPackage = buildExportPackage(
    {
      ...sampleAgentOpsWorkspace,
      gate_results: passedGateResults,
    },
    exportedAt,
    { exportIntent: "final" },
  );

  assert.equal(draftAuthorization.intent, "draft");
  assert.equal(draftAuthorization.status, "warning");
  assert.equal(draftAuthorization.final_export_allowed, false);
  assert.equal(draftAuthorization.validation[0]?.status, "warning");
  assert.equal(blockedFinalAuthorization.intent, "final");
  assert.equal(blockedFinalAuthorization.status, "blocked");
  assert.equal(blockedFinalAuthorization.final_export_allowed, false);
  assert.equal(blockedFinalAuthorization.validation[0]?.status, "failed");
  assert.ok(
    blockedFinalAuthorization.gate_summary.blocking_gate_ids.includes(
      "gate-human-approval",
    ),
  );
  assert.equal(
    authorizedFinalPackage.audit_pack.export_authorization.status,
    "authorized",
  );
  assert.equal(authorizedFinalPackage.manifest.final_export_allowed, true);
  assert.equal(
    validateExportPackageIntegrity(authorizedFinalPackage).find(
      (item) => item.name === "manifest_counts",
    )?.status,
    "passed",
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
  const exportPackage = buildExportPackage(
    sampleAgentOpsWorkspace,
    exportedAt,
    {
      gateProvenance,
    },
  );
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
    memoProvenance.sourceRecordIds.auditEventIds.includes(
      "audit-memo-generated",
    ),
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
      audit_event_tool_calls: exportPackage.manifest.audit_event_tool_calls + 1,
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
