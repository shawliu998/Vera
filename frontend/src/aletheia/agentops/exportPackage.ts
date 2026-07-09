import type {
  AgentOpsMatterWorkspace,
  AgentRun,
  ArtifactRef,
  AuditEvent,
  DraftMemo,
  EvalCase,
  EvalFailureType,
  GateResult,
  ReviewComment,
  ToolCall,
} from "./types";
import { buildTypedHandoffProvenance } from "./handoff";
import type {
  TypedHandoffProvenance,
  TypedHandoffProvenanceOptions,
} from "./handoff";

export const EVAL_FAILURE_TYPES = [
  "unsupported_claim",
  "missing_citation",
  "missed_issue",
  "wrong_risk_level",
  "contradiction_missed",
  "bad_memo_structure",
  "expert_override",
] as const satisfies readonly EvalFailureType[];

export type ExportValidationItem = {
  name: string;
  status: "passed" | "warning" | "failed";
  detail: string;
};

export type AgentRunTraceEntry = {
  run_id: string;
  matter_id: string;
  agent_id: string;
  status: AgentRun["status"];
  started_at: string;
  ended_at?: string;
  model?: string;
  input_artifacts: ArtifactRef[];
  output_artifacts: ArtifactRef[];
  referenced_artifacts: ArtifactRef[];
  trace_events: AgentRun["trace_events"];
  errors: string[];
};

export type ToolCallLogEntry = ToolCall & {
  matter_id: string;
  run_id: string;
  agent_id: string;
};

export type HumanApprovalLogEntry = {
  id: string;
  matter_id: string;
  source_type: "gate_result" | "audit_event" | "review_state";
  source_id: string;
  artifact_id?: string;
  artifact_type?: string;
  status: "open" | "approved" | "rejected" | "resolved" | "warning";
  actor_id?: string;
  decided_at?: string;
  rationale: string;
};

export type AuditPack = {
  schema_version: "aletheia-audit-pack-v1";
  exported_at: string;
  matter_profile: AgentOpsMatterWorkspace["matter"];
  document_list: AgentOpsMatterWorkspace["matter"]["documents"];
  evidence_matrix: AgentOpsMatterWorkspace["evidence"];
  issue_map: AgentOpsMatterWorkspace["issues"];
  risk_register: AgentOpsMatterWorkspace["risks"];
  draft_memos: AgentOpsMatterWorkspace["draft_memos"];
  final_memos: DraftMemo[];
  review_comments: AgentOpsMatterWorkspace["review_comments"];
  gate_results: AgentOpsMatterWorkspace["gate_results"];
  agent_run_trace: AgentRunTraceEntry[];
  tool_call_log: ToolCallLogEntry[];
  human_approval_log: HumanApprovalLogEntry[];
  typed_handoff_provenance: TypedHandoffProvenance[];
  audit_events: AgentOpsMatterWorkspace["audit_events"];
  eval_cases: EvalCase[];
  validation: ExportValidationItem[];
  export_hash: string;
};

export type EvalCaseExport = {
  schema_version: "aletheia-eval-case-export-v1";
  exported_at: string;
  matter_id: string;
  failure_types: typeof EVAL_FAILURE_TYPES;
  cases: EvalCase[];
  source_review_comment_ids: string[];
  source_gate_result_ids: string[];
};

export type ExportPackage = {
  schema_version: "aletheia-export-package-v1";
  exported_at: string;
  matter_id: string;
  audit_pack: AuditPack;
  eval_case_export: EvalCaseExport;
  manifest: {
    documents: number;
    evidence_items: number;
    issues: number;
    risks: number;
    draft_memos: number;
    review_comments: number;
    gate_results: number;
    audit_events: number;
    agent_runs: number;
    tool_calls: number;
    handoff_provenance_items: number;
    eval_cases: number;
  };
  export_hash: string;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function computeExportHash(value: unknown) {
  const input = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function uniqueById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function failureTypeForText(text: string): EvalFailureType {
  const normalized = text.toLowerCase();

  if (normalized.includes("contradict") || normalized.includes("conflict")) {
    return "contradiction_missed";
  }

  if (normalized.includes("missed issue") || normalized.includes("missing issue")) {
    return "missed_issue";
  }

  if (normalized.includes("risk level") || normalized.includes("severity")) {
    return "wrong_risk_level";
  }

  if (normalized.includes("structure") || normalized.includes("section")) {
    return "bad_memo_structure";
  }

  if (normalized.includes("citation") || normalized.includes("source")) {
    return "missing_citation";
  }

  if (normalized.includes("unsupported") || normalized.includes("overclaim")) {
    return "unsupported_claim";
  }

  return "expert_override";
}

function evalCaseFromReviewComment(
  comment: ReviewComment,
  sourceRunId: string,
): EvalCase {
  const failureType = failureTypeForText(comment.comment);
  return {
    id: `eval-from-review-${comment.id}`,
    matter_id: comment.matter_id,
    source_run_id: sourceRunId,
    failure_type: failureType,
    input_snapshot: {
      review_comment_id: comment.id,
      artifact_id: comment.artifact_id,
      artifact_type: comment.artifact_type,
      severity: comment.severity,
      status: comment.status,
    },
    expected_behavior:
      "Future runs should resolve this expert feedback before approval or export.",
    expert_feedback: comment.comment,
    status: "open",
  };
}

function evalCaseFromGateResult(gate: GateResult, sourceRunId: string): EvalCase {
  return {
    id: `eval-from-gate-${gate.id}`,
    matter_id: gate.matter_id,
    source_run_id: sourceRunId,
    failure_type:
      gate.gate_type === "citation"
        ? "missing_citation"
        : gate.gate_type === "conflict"
          ? "contradiction_missed"
          : gate.gate_type === "missing_material"
            ? "missed_issue"
            : gate.gate_type === "human_approval"
              ? "expert_override"
              : "unsupported_claim",
    input_snapshot: {
      gate_id: gate.id,
      gate_type: gate.gate_type,
      status: gate.status,
      affected_artifact_ids: gate.affected_artifact_ids,
    },
    expected_behavior:
      gate.required_action ??
      "Future runs should satisfy the failed gate before export.",
    expert_feedback: gate.reason,
    status: "open",
  };
}

function sourceRunId(workspace: AgentOpsMatterWorkspace) {
  return workspace.runs.at(-1)?.id ?? "run-unavailable";
}

function artifactRefsForRun(run: AgentRun) {
  return uniqueById([
    ...run.input_artifacts,
    ...run.output_artifacts,
    ...(run.referenced_artifacts ?? []),
  ]);
}

function artifactRefForWorkspaceId(
  workspace: AgentOpsMatterWorkspace,
  id: string,
): ArtifactRef | undefined {
  if (workspace.matter.id === id) {
    return { id, type: "matter", title: workspace.matter.title };
  }

  const document = workspace.matter.documents.find((item) => item.id === id);
  if (document) {
    return { id, type: "document", title: document.title };
  }

  if (workspace.evidence.some((item) => item.id === id)) {
    return { id, type: "evidence_item" };
  }
  if (workspace.issues.some((item) => item.id === id)) {
    return { id, type: "issue_node" };
  }
  if (workspace.risks.some((item) => item.id === id)) {
    return { id, type: "risk_item" };
  }
  if (workspace.draft_memos.some((item) => item.id === id)) {
    return { id, type: "draft_memo" };
  }
  if (workspace.review_comments.some((item) => item.id === id)) {
    return { id, type: "review_comment" };
  }
  if (workspace.gate_results.some((item) => item.id === id)) {
    return { id, type: "gate_result" };
  }
  if (workspace.audit_events.some((item) => item.id === id)) {
    return { id, type: "audit_event" };
  }
  if (workspace.eval_cases.some((item) => item.id === id)) {
    return { id, type: "eval_case" };
  }
  if (workspace.skills.some((item) => item.id === id)) {
    return { id, type: "professional_skill" };
  }
  if (workspace.runs.some((item) => item.id === id)) {
    return { id, type: "agent_run" };
  }

  return undefined;
}

function approvalStatusFromGate(gate: GateResult): HumanApprovalLogEntry["status"] {
  if (gate.status === "passed") return "approved";
  if (gate.status === "failed") return "open";
  if (gate.status === "skipped") return "warning";
  return gate.status;
}

export function buildAgentRunTrace(
  workspace: AgentOpsMatterWorkspace,
): AgentRunTraceEntry[] {
  return workspace.runs.map((run) => ({
    run_id: run.id,
    matter_id: run.matter_id,
    agent_id: run.agent_id,
    status: run.status,
    started_at: run.started_at,
    ended_at: run.ended_at,
    model: run.model,
    input_artifacts: run.input_artifacts,
    output_artifacts: run.output_artifacts,
    referenced_artifacts: run.referenced_artifacts ?? [],
    trace_events: run.trace_events,
    errors: run.errors,
  }));
}

export function buildAgentRunAuditEvents(
  workspace: AgentOpsMatterWorkspace,
  exportedAt = new Date().toISOString(),
): AuditEvent[] {
  return workspace.runs.map((run) => ({
    id: `audit-export-agent-run-${run.id}`,
    matter_id: run.matter_id,
    actor_type: "agent",
    actor_id: run.agent_id,
    action: "agent_run_recorded",
    artifact_id: run.id,
    artifact_type: "agent_run",
    after_hash: computeExportHash({
      run_id: run.id,
      status: run.status,
      started_at: run.started_at,
      ended_at: run.ended_at,
      output_artifacts: run.output_artifacts,
      tool_call_count: run.tool_calls.length,
      trace_event_count: run.trace_events.length,
      error_count: run.errors.length,
    }),
    timestamp: run.ended_at ?? run.started_at ?? exportedAt,
    referenced_artifacts: artifactRefsForRun(run),
    big_at_references: run.big_at_references,
    big_at_resolution_records: run.big_at_resolution_records,
  }));
}

export function buildToolCallAuditEvents(
  workspace: AgentOpsMatterWorkspace,
  exportedAt = new Date().toISOString(),
): AuditEvent[] {
  return workspace.runs.flatMap((run) =>
    run.tool_calls.map((toolCall) => ({
      id: `audit-export-tool-call-${toolCall.id}`,
      matter_id: run.matter_id,
      actor_type: "agent" as const,
      actor_id: run.agent_id,
      action: "tool_call_recorded",
      artifact_id: run.id,
      artifact_type: "agent_run" as const,
      after_hash: computeExportHash({
        tool_call_id: toolCall.id,
        run_id: run.id,
        agent_id: run.agent_id,
        name: toolCall.name,
        status: toolCall.status,
        started_at: toolCall.started_at,
        ended_at: toolCall.ended_at,
        input: toolCall.input,
        output: toolCall.output,
        error: toolCall.error,
      }),
      timestamp: toolCall.ended_at ?? toolCall.started_at ?? exportedAt,
      referenced_artifacts: uniqueById([
        { id: run.id, type: "agent_run" as const },
        ...artifactRefsForRun(run),
      ]),
      big_at_references: run.big_at_references,
      big_at_resolution_records: run.big_at_resolution_records,
    })),
  );
}

export function buildReviewCommentAuditEvents(
  workspace: AgentOpsMatterWorkspace,
  exportedAt = new Date().toISOString(),
): AuditEvent[] {
  return workspace.review_comments.map((comment) => ({
    id: `audit-export-review-comment-${comment.id}`,
    matter_id: comment.matter_id,
    actor_type: "human",
    actor_id: comment.author,
    action: "review_comment_recorded",
    artifact_id: comment.artifact_id,
    artifact_type: comment.artifact_type,
    after_hash: computeExportHash({
      review_comment_id: comment.id,
      artifact_id: comment.artifact_id,
      artifact_type: comment.artifact_type,
      target_type: comment.target_type,
      target_id: comment.target_id,
      tag: comment.tag,
      severity: comment.severity,
      status: comment.status,
      comment: comment.comment,
    }),
    timestamp: comment.created_at ?? exportedAt,
    referenced_artifacts: uniqueById([
      { id: comment.artifact_id, type: comment.artifact_type },
      ...(comment.referenced_artifacts ?? []),
    ]),
    big_at_references: comment.big_at_references,
    big_at_resolution_records: comment.big_at_resolution_records,
  }));
}

export function buildGateResultAuditEvents(
  workspace: AgentOpsMatterWorkspace,
  exportedAt = new Date().toISOString(),
): AuditEvent[] {
  return workspace.gate_results.map((gate) => ({
    id: `audit-export-gate-result-${gate.id}`,
    matter_id: gate.matter_id,
    actor_type: "system",
    actor_id: "gate-engine",
    action: "gate_result_recorded",
    artifact_id: gate.id,
    artifact_type: "gate_result",
    after_hash: computeExportHash({
      gate_id: gate.id,
      gate_type: gate.gate_type,
      status: gate.status,
      reason: gate.reason,
      affected_artifact_ids: gate.affected_artifact_ids,
      required_action: gate.required_action,
    }),
    timestamp: gate.created_at ?? exportedAt,
    referenced_artifacts: uniqueById([
      { id: gate.id, type: "gate_result" as const },
      ...gate.affected_artifact_ids.flatMap((id) => {
        const ref = artifactRefForWorkspaceId(workspace, id);
        return ref ? [ref] : [];
      }),
    ]),
  }));
}

export function buildToolCallLog(
  workspace: AgentOpsMatterWorkspace,
): ToolCallLogEntry[] {
  return workspace.runs.flatMap((run) =>
    run.tool_calls.map((toolCall) => ({
      ...toolCall,
      matter_id: run.matter_id,
      run_id: run.id,
      agent_id: run.agent_id,
    })),
  );
}

export function buildHumanApprovalLog(
  workspace: AgentOpsMatterWorkspace,
): HumanApprovalLogEntry[] {
  const gateApprovals = workspace.gate_results
    .filter((gate) => gate.gate_type === "human_approval")
    .map((gate) => ({
      id: `approval-from-gate-${gate.id}`,
      matter_id: gate.matter_id,
      source_type: "gate_result" as const,
      source_id: gate.id,
      artifact_id: gate.affected_artifact_ids[0],
      artifact_type: "draft_memo",
      status: approvalStatusFromGate(gate),
      decided_at: gate.status === "passed" ? gate.created_at : undefined,
      rationale: gate.reason,
    }));

  const auditApprovals = workspace.audit_events
    .filter((event) => event.action.includes("approval"))
    .map((event) => ({
      id: `approval-from-audit-${event.id}`,
      matter_id: event.matter_id,
      source_type: "audit_event" as const,
      source_id: event.id,
      artifact_id: event.artifact_id,
      artifact_type: event.artifact_type,
      status: event.action.includes("rejected")
        ? ("rejected" as const)
        : event.action.includes("approved")
          ? ("approved" as const)
          : ("open" as const),
      actor_id: event.actor_id,
      decided_at: event.timestamp,
      rationale: event.action,
    }));

  const reviewedArtifacts = [
    ...workspace.evidence
      .filter((item) => item.review_status === "approved")
      .map((item) => ({
        id: `approval-from-evidence-${item.id}`,
        matter_id: item.matter_id,
        source_type: "review_state" as const,
        source_id: item.id,
        artifact_id: item.id,
        artifact_type: "evidence_item",
        status: "approved" as const,
        actor_id: item.reviewer_id,
        rationale: "Evidence item marked approved by reviewer.",
      })),
    ...workspace.issues
      .filter((item) => item.review_status === "approved")
      .map((item) => ({
        id: `approval-from-issue-${item.id}`,
        matter_id: item.matter_id,
        source_type: "review_state" as const,
        source_id: item.id,
        artifact_id: item.id,
        artifact_type: "issue_node",
        status: "approved" as const,
        rationale: "Issue marked approved by reviewer.",
      })),
    ...workspace.draft_memos
      .filter((item) => item.review_status === "approved")
      .map((item) => ({
        id: `approval-from-memo-${item.id}`,
        matter_id: item.matter_id,
        source_type: "review_state" as const,
        source_id: item.id,
        artifact_id: item.id,
        artifact_type: "draft_memo",
        status: "approved" as const,
        rationale: "Draft memo marked approved by reviewer.",
      })),
  ];

  return [...gateApprovals, ...auditApprovals, ...reviewedArtifacts];
}

export function buildEvalCaseExport(
  workspace: AgentOpsMatterWorkspace,
  exportedAt = new Date().toISOString(),
): EvalCaseExport {
  const fallbackRunId = sourceRunId(workspace);
  const reviewCases = workspace.review_comments
    .filter((comment) => comment.status !== "resolved")
    .map((comment) => evalCaseFromReviewComment(comment, fallbackRunId));
  const gateCases = workspace.gate_results
    .filter((gate) => gate.status === "failed")
    .map((gate) => evalCaseFromGateResult(gate, fallbackRunId));
  const cases = uniqueById([...workspace.eval_cases, ...reviewCases, ...gateCases]);

  return {
    schema_version: "aletheia-eval-case-export-v1",
    exported_at: exportedAt,
    matter_id: workspace.matter.id,
    failure_types: EVAL_FAILURE_TYPES,
    cases,
    source_review_comment_ids: workspace.review_comments
      .filter((comment) => comment.status !== "resolved")
      .map((comment) => comment.id),
    source_gate_result_ids: workspace.gate_results
      .filter((gate) => gate.status === "failed")
      .map((gate) => gate.id),
  };
}

function validateExportPackage(workspace: AgentOpsMatterWorkspace): ExportValidationItem[] {
  return [
    {
      name: "matter_profile",
      status: workspace.matter.id && workspace.matter.title ? "passed" : "failed",
      detail: "Matter profile includes id and title.",
    },
    {
      name: "document_list",
      status: workspace.matter.documents.length > 0 ? "passed" : "warning",
      detail: `${workspace.matter.documents.length} document(s) included.`,
    },
    {
      name: "evidence_matrix",
      status: workspace.evidence.length > 0 ? "passed" : "warning",
      detail: `${workspace.evidence.length} evidence item(s) included.`,
    },
    {
      name: "review_gate_audit",
      status:
        workspace.review_comments.length > 0 &&
        workspace.gate_results.length > 0 &&
        workspace.audit_events.length > 0
          ? "passed"
          : "warning",
      detail:
        "Review comments, gate results, and audit events are included when available.",
    },
    {
      name: "run_trace",
      status: workspace.runs.length > 0 ? "passed" : "warning",
      detail: `${workspace.runs.length} agent run(s) included.`,
    },
  ];
}

export function buildAuditPack(
  workspace: AgentOpsMatterWorkspace,
  exportedAt = new Date().toISOString(),
  options: TypedHandoffProvenanceOptions = {},
): AuditPack {
  const evalCaseExport = buildEvalCaseExport(workspace, exportedAt);
  const typedHandoffProvenance = buildTypedHandoffProvenance(workspace, options);
  const auditEvents = uniqueById([
    ...workspace.audit_events,
    ...buildAgentRunAuditEvents(workspace, exportedAt),
    ...buildToolCallAuditEvents(workspace, exportedAt),
    ...buildReviewCommentAuditEvents(workspace, exportedAt),
    ...buildGateResultAuditEvents(workspace, exportedAt),
  ]);
  const packWithoutHash = {
    schema_version: "aletheia-audit-pack-v1" as const,
    exported_at: exportedAt,
    matter_profile: workspace.matter,
    document_list: workspace.matter.documents,
    evidence_matrix: workspace.evidence,
    issue_map: workspace.issues,
    risk_register: workspace.risks,
    draft_memos: workspace.draft_memos,
    final_memos: workspace.draft_memos.filter(
      (memo) => memo.review_status === "approved" && memo.gate_status === "passed",
    ),
    review_comments: workspace.review_comments,
    gate_results: workspace.gate_results,
    agent_run_trace: buildAgentRunTrace(workspace),
    tool_call_log: buildToolCallLog(workspace),
    human_approval_log: buildHumanApprovalLog(workspace),
    typed_handoff_provenance: typedHandoffProvenance,
    audit_events: auditEvents,
    eval_cases: evalCaseExport.cases,
    validation: validateExportPackage(workspace),
  };

  return {
    ...packWithoutHash,
    export_hash: computeExportHash(packWithoutHash),
  };
}

export function buildExportPackage(
  workspace: AgentOpsMatterWorkspace,
  exportedAt = new Date().toISOString(),
  options: TypedHandoffProvenanceOptions = {},
): ExportPackage {
  const auditPack = buildAuditPack(workspace, exportedAt, options);
  const evalCaseExport = buildEvalCaseExport(workspace, exportedAt);
  const packageWithoutHash = {
    schema_version: "aletheia-export-package-v1" as const,
    exported_at: exportedAt,
    matter_id: workspace.matter.id,
    audit_pack: auditPack,
    eval_case_export: evalCaseExport,
    manifest: {
      documents: workspace.matter.documents.length,
      evidence_items: workspace.evidence.length,
      issues: workspace.issues.length,
      risks: workspace.risks.length,
      draft_memos: workspace.draft_memos.length,
      review_comments: workspace.review_comments.length,
      gate_results: workspace.gate_results.length,
      audit_events: auditPack.audit_events.length,
      agent_runs: workspace.runs.length,
      tool_calls: buildToolCallLog(workspace).length,
      handoff_provenance_items: auditPack.typed_handoff_provenance.length,
      eval_cases: evalCaseExport.cases.length,
    },
  };

  return {
    ...packageWithoutHash,
    export_hash: computeExportHash(packageWithoutHash),
  };
}

export function validateExportPackageIntegrity(
  exportPackage: ExportPackage,
): ExportValidationItem[] {
  const recomputedPackageHash = computeExportHash({
    schema_version: exportPackage.schema_version,
    exported_at: exportPackage.exported_at,
    matter_id: exportPackage.matter_id,
    audit_pack: exportPackage.audit_pack,
    eval_case_export: exportPackage.eval_case_export,
    manifest: exportPackage.manifest,
  });
  const recomputedAuditPackHash = computeExportHash({
    schema_version: exportPackage.audit_pack.schema_version,
    exported_at: exportPackage.audit_pack.exported_at,
    matter_profile: exportPackage.audit_pack.matter_profile,
    document_list: exportPackage.audit_pack.document_list,
    evidence_matrix: exportPackage.audit_pack.evidence_matrix,
    issue_map: exportPackage.audit_pack.issue_map,
    risk_register: exportPackage.audit_pack.risk_register,
    draft_memos: exportPackage.audit_pack.draft_memos,
    final_memos: exportPackage.audit_pack.final_memos,
    review_comments: exportPackage.audit_pack.review_comments,
    gate_results: exportPackage.audit_pack.gate_results,
    agent_run_trace: exportPackage.audit_pack.agent_run_trace,
    tool_call_log: exportPackage.audit_pack.tool_call_log,
    human_approval_log: exportPackage.audit_pack.human_approval_log,
    typed_handoff_provenance: exportPackage.audit_pack.typed_handoff_provenance,
    audit_events: exportPackage.audit_pack.audit_events,
    eval_cases: exportPackage.audit_pack.eval_cases,
    validation: exportPackage.audit_pack.validation,
  });
  const evalSourceIds = new Set([
    ...exportPackage.eval_case_export.source_review_comment_ids,
    ...exportPackage.eval_case_export.source_gate_result_ids,
  ]);
  const evalCasesWithSourceSignals = exportPackage.eval_case_export.cases.filter(
    (evalCase) => {
      if (evalSourceIds.has(evalCase.id.replace(/^eval-from-(review|gate)-/, ""))) {
        return true;
      }
      const snapshot = evalCase.input_snapshot;
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        return false;
      }
      const record = snapshot as Record<string, unknown>;
      return (
        typeof record.review_comment_id === "string" ||
        typeof record.gate_id === "string" ||
        typeof record.artifact_id === "string" ||
        typeof record.memo_section_id === "string"
      );
    },
  );

  return [
    {
      name: "package_hash",
      status:
        recomputedPackageHash === exportPackage.export_hash ? "passed" : "failed",
      detail: "ExportPackage hash matches its canonical package payload.",
    },
    {
      name: "audit_pack_hash",
      status:
        recomputedAuditPackHash === exportPackage.audit_pack.export_hash
          ? "passed"
          : "failed",
      detail: "Nested AuditPack hash matches its canonical audit payload.",
    },
    {
      name: "manifest_counts",
      status:
        exportPackage.manifest.evidence_items ===
          exportPackage.audit_pack.evidence_matrix.length &&
        exportPackage.manifest.agent_runs ===
          exportPackage.audit_pack.agent_run_trace.length &&
        exportPackage.manifest.tool_calls ===
          exportPackage.audit_pack.tool_call_log.length &&
        exportPackage.manifest.handoff_provenance_items ===
          exportPackage.audit_pack.typed_handoff_provenance.length &&
        exportPackage.manifest.eval_cases ===
          exportPackage.eval_case_export.cases.length
          ? "passed"
          : "failed",
      detail: "Manifest counts agree with nested audit and eval sections.",
    },
    {
      name: "evidence_audit_eval_loop",
      status:
        exportPackage.audit_pack.evidence_matrix.length > 0 &&
        exportPackage.audit_pack.audit_events.length > 0 &&
        evalCasesWithSourceSignals.length ===
          exportPackage.eval_case_export.cases.length
          ? "passed"
          : "warning",
      detail:
        "Evidence, audit events, and eval cases retain source linkage signals.",
    },
    {
      name: "human_review_gate_loop",
      status:
        exportPackage.audit_pack.review_comments.length > 0 &&
        exportPackage.audit_pack.gate_results.length > 0 &&
        exportPackage.audit_pack.human_approval_log.length > 0
          ? "passed"
          : "warning",
      detail:
        "Review comments, gate results, and human approval records are present when available.",
    },
  ];
}
