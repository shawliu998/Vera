import type {
  DocumentChunk,
  DocumentRecord,
  V1DocumentStatus,
} from "./v1Contracts";
import { validateV1ArtifactShape } from "./v1Contracts";
import { canExportFinal } from "./gates";
import type { ExportIntent } from "./gates";
import type {
  AgentOpsMatterWorkspace,
  AgentRun,
  ArtifactRef,
  AuditEvent,
  DraftMemo,
  EvalCase,
  EvalFailureType,
  EvidenceItem,
  GateResult,
  ReviewComment,
  ToolCall,
} from "./types";
import { buildTypedHandoffProvenance } from "./handoff";
import type {
  TypedHandoffProvenance,
  TypedHandoffProvenanceOptions,
} from "./handoff";
import { buildEvalSnapshotProvenance } from "../../lib/agentops/eval";
import type { EvalSnapshotProvenance } from "../../lib/agentops/eval";

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

export type V1SourceIndexSourceLink = {
  evidence_item_id: string;
  matter_id: string;
  document_id: string;
  source_chunk_id?: string | null;
  claim_id?: string | null;
  page?: number | null;
  section?: string | null;
  quote?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  relevance?: EvidenceItem["relevance"] | null;
  support_status?: EvidenceItem["support_status"] | null;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type V1SourceIndexSnapshot = {
  schema_version: string;
  storage_driver: string;
  matter_id: string;
  generated_at: string;
  documents: DocumentRecord[];
  chunks: DocumentChunk[];
  source_links: V1SourceIndexSourceLink[];
  limitations: string[];
};

export type V1SourceIndexHashRef = {
  id: string;
  hash: string;
};

export type V1SourceIndexManifest = {
  schema_version: "aletheia-v1-source-index-manifest-v1";
  source_index_schema_version: string;
  storage_driver: string;
  matter_id: string;
  generated_at: string;
  local_only: boolean;
  document_count: number;
  chunk_count: number;
  source_link_count: number;
  document_hashes: V1SourceIndexHashRef[];
  chunk_hashes: V1SourceIndexHashRef[];
  source_link_hashes: V1SourceIndexHashRef[];
  document_status_counts: Partial<Record<V1DocumentStatus, number>>;
  limitations: string[];
  validation: ExportValidationItem[];
};

export type ExportAuthorization = {
  intent: ExportIntent;
  status: "authorized" | "blocked" | "warning";
  final_export_allowed: boolean;
  gate_summary: {
    total: number;
    passed: number;
    failed: number;
    warning: number;
    skipped: number;
    blocking_gate_ids: string[];
    export_gate_status?: GateResult["status"];
  };
  validation: ExportValidationItem[];
};

export type PersistedGateEvidence = {
  schema_version: "aletheia-persisted-gate-evidence-v1";
  matter_id: string;
  source: "audit_events_and_gate_provenance";
  gate_result_ids: string[];
  approval_checkpoint_ids: string[];
  gate_snapshot_audit_event_ids: string[];
  gate_authorization_audit_event_ids: string[];
  blocked_final_export_audit_event_ids: string[];
  related_gate_audit_event_ids: string[];
  final_export_allowed: boolean;
  validation: ExportValidationItem[];
  warnings: string[];
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
  eval_snapshot_provenance: EvalSnapshotProvenance;
  source_index_manifest?: V1SourceIndexManifest;
  export_authorization: ExportAuthorization;
  persisted_gate_evidence: PersistedGateEvidence;
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
    audit_event_agent_runs: number;
    audit_event_tool_calls: number;
    audit_event_review_comments: number;
    audit_event_gate_results: number;
    agent_runs: number;
    tool_calls: number;
    handoff_provenance_items: number;
    eval_cases: number;
    eval_snapshot_source_runs: number;
    eval_snapshot_source_reviews: number;
    eval_snapshot_source_gates: number;
    eval_snapshot_source_audit_events: number;
    eval_snapshot_feedback_exports: number;
    eval_snapshot_candidate_skills: number;
    eval_snapshot_approved_playbooks: number;
    source_index_documents: number;
    source_index_chunks: number;
    source_index_source_links: number;
    persisted_gate_snapshot_audit_events: number;
    persisted_gate_authorization_audit_events: number;
    persisted_gate_blocked_audit_events: number;
    approval_checkpoint_ids: number;
    final_export_allowed: boolean;
  };
  export_hash: string;
};

export type ExportPackageBuildOptions = TypedHandoffProvenanceOptions & {
  sourceIndex?: V1SourceIndexSnapshot;
  exportIntent?: ExportIntent;
  feedbackExportIds?: string[];
  candidateSkillIds?: string[];
  approvedPlaybookIds?: string[];
};

const LOCAL_ONLY_SOURCE_INDEX_LIMITATION =
  "The source-index manifest contains local parsed records and links; original document/page preview is not embedded.";

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

function uniqueStrings(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

function hashRefs<T extends { id: string; hash?: string }>(
  items: T[],
): V1SourceIndexHashRef[] {
  return items
    .map((item) => ({
      id: item.id,
      hash: item.hash ?? computeExportHash(item),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sourceLinkId(link: V1SourceIndexSourceLink) {
  return [
    link.evidence_item_id,
    link.document_id,
    link.source_chunk_id ?? "chunk-unavailable",
  ].join(":");
}

function sourceLinkHashRefs(
  links: V1SourceIndexSourceLink[],
): V1SourceIndexHashRef[] {
  return links
    .map((link) => ({
      id: sourceLinkId(link),
      hash: computeExportHash(link),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function documentStatusCounts(documents: DocumentRecord[]) {
  return documents.reduce<Partial<Record<V1DocumentStatus, number>>>(
    (counts, document) => {
      counts[document.status] = (counts[document.status] ?? 0) + 1;
      return counts;
    },
    {},
  );
}

function validateSourceIndexManifestInput(
  sourceIndex: V1SourceIndexSnapshot,
  matterId: string,
): ExportValidationItem[] {
  const validation: ExportValidationItem[] = [
    {
      name: "source_index_matter_scope",
      status: sourceIndex.matter_id === matterId ? "passed" : "failed",
      detail:
        sourceIndex.matter_id === matterId
          ? "Source index matter ID matches the export matter."
          : `Source index matter ID ${sourceIndex.matter_id} does not match export matter ${matterId}.`,
    },
    {
      name: "source_index_documents",
      status: sourceIndex.documents.length > 0 ? "passed" : "warning",
      detail: `${sourceIndex.documents.length} source-index document(s) included.`,
    },
    {
      name: "source_index_chunks",
      status: sourceIndex.chunks.length > 0 ? "passed" : "warning",
      detail: `${sourceIndex.chunks.length} source-index chunk(s) included.`,
    },
    {
      name: "source_index_source_links",
      status: sourceIndex.source_links.length > 0 ? "passed" : "warning",
      detail: `${sourceIndex.source_links.length} evidence source link(s) included.`,
    },
  ];

  const invalidDocuments = sourceIndex.documents.filter(
    (document) =>
      !validateV1ArtifactShape("document_record", document).ok ||
      document.matter_id !== sourceIndex.matter_id,
  );
  const invalidChunks = sourceIndex.chunks.filter(
    (chunk) =>
      !validateV1ArtifactShape("document_chunk", chunk).ok ||
      chunk.matter_id !== sourceIndex.matter_id,
  );
  const invalidLinks = sourceIndex.source_links.filter(
    (link) =>
      !link.evidence_item_id ||
      link.matter_id !== sourceIndex.matter_id ||
      !link.document_id,
  );
  const documentIds = new Set(
    sourceIndex.documents.map((document) => document.id),
  );
  const chunkIds = new Set(sourceIndex.chunks.map((chunk) => chunk.id));
  const chunksWithMissingDocuments = sourceIndex.chunks.filter(
    (chunk) => chunk.document_id && !documentIds.has(chunk.document_id),
  );
  const linksWithMissingDocuments = sourceIndex.source_links.filter(
    (link) => link.document_id && !documentIds.has(link.document_id),
  );
  const linksWithMissingChunks = sourceIndex.source_links.filter(
    (link) =>
      Boolean(link.source_chunk_id) &&
      !chunkIds.has(link.source_chunk_id ?? ""),
  );

  validation.push({
    name: "source_index_contract_shape",
    status:
      invalidDocuments.length || invalidChunks.length || invalidLinks.length
        ? "failed"
        : "passed",
    detail:
      invalidDocuments.length || invalidChunks.length || invalidLinks.length
        ? `${invalidDocuments.length} document(s), ${invalidChunks.length} chunk(s), and ${invalidLinks.length} source link(s) failed baseline V1 source-index shape checks.`
        : "Source-index records satisfy the baseline V1 document, chunk, and source-link shape checks.",
  });
  validation.push({
    name: "source_index_chunk_document_refs",
    status: chunksWithMissingDocuments.length ? "failed" : "passed",
    detail: chunksWithMissingDocuments.length
      ? `${chunksWithMissingDocuments.length} chunk(s) reference document IDs that are absent from the source-index document list.`
      : "All source-index chunks reference included documents.",
  });
  validation.push({
    name: "source_index_link_document_refs",
    status: linksWithMissingDocuments.length ? "failed" : "passed",
    detail: linksWithMissingDocuments.length
      ? `${linksWithMissingDocuments.length} source link(s) reference document IDs that are absent from the source-index document list.`
      : "All source-index source links reference included documents.",
  });
  validation.push({
    name: "source_index_link_chunk_refs",
    status: linksWithMissingChunks.length ? "failed" : "passed",
    detail: linksWithMissingChunks.length
      ? `${linksWithMissingChunks.length} source link(s) reference chunk IDs that are absent from the source-index chunk list.`
      : "All chunk-backed source links reference included chunks.",
  });

  if (sourceIndex.storage_driver === "local") {
    validation.push({
      name: "source_index_local_only",
      status: "warning",
      detail: LOCAL_ONLY_SOURCE_INDEX_LIMITATION,
    });
  }

  return validation;
}

export function buildV1SourceIndexManifest(
  sourceIndex: V1SourceIndexSnapshot,
  matterId = sourceIndex.matter_id,
): V1SourceIndexManifest {
  const localOnly = sourceIndex.storage_driver === "local";
  const limitations = uniqueStrings([
    ...sourceIndex.limitations,
    ...(localOnly ? [LOCAL_ONLY_SOURCE_INDEX_LIMITATION] : []),
  ]);

  return {
    schema_version: "aletheia-v1-source-index-manifest-v1",
    source_index_schema_version: sourceIndex.schema_version,
    storage_driver: sourceIndex.storage_driver,
    matter_id: sourceIndex.matter_id,
    generated_at: sourceIndex.generated_at,
    local_only: localOnly,
    document_count: sourceIndex.documents.length,
    chunk_count: sourceIndex.chunks.length,
    source_link_count: sourceIndex.source_links.length,
    document_hashes: hashRefs(sourceIndex.documents),
    chunk_hashes: hashRefs(sourceIndex.chunks),
    source_link_hashes: sourceLinkHashRefs(sourceIndex.source_links),
    document_status_counts: documentStatusCounts(sourceIndex.documents),
    limitations,
    validation: validateSourceIndexManifestInput(sourceIndex, matterId),
  };
}

export function buildExportAuthorization(
  gateResults: GateResult[],
  intent: ExportIntent = "draft",
): ExportAuthorization {
  const failedGates = gateResults.filter((gate) => gate.status === "failed");
  const exportGate = gateResults.find((gate) => gate.gate_type === "export");
  const finalExportAllowed = canExportFinal(gateResults);
  const status: ExportAuthorization["status"] =
    intent === "final"
      ? finalExportAllowed
        ? "authorized"
        : "blocked"
      : finalExportAllowed
        ? "authorized"
        : "warning";
  const validationStatus: ExportValidationItem["status"] =
    intent === "final"
      ? finalExportAllowed
        ? "passed"
        : "failed"
      : finalExportAllowed
        ? "passed"
        : "warning";
  const detail =
    intent === "final"
      ? finalExportAllowed
        ? "Final export is authorized by the export gate and no failed gates."
        : "Final export blocked: export gate must pass and all failed gates must be resolved."
      : finalExportAllowed
        ? "Draft export may proceed; final export gates are already satisfied."
        : "Draft export may proceed with visible warnings; final export remains blocked until gates pass.";

  return {
    intent,
    status,
    final_export_allowed: finalExportAllowed,
    gate_summary: {
      total: gateResults.length,
      passed: gateResults.filter((gate) => gate.status === "passed").length,
      failed: failedGates.length,
      warning: gateResults.filter((gate) => gate.status === "warning").length,
      skipped: gateResults.filter((gate) => gate.status === "skipped").length,
      blocking_gate_ids: failedGates.map((gate) => gate.id),
      export_gate_status: exportGate?.status,
    },
    validation: [
      {
        name: "export_authorization",
        status: validationStatus,
        detail,
      },
    ],
  };
}

function auditEventIdsByAction(events: AuditEvent[], action: string) {
  return events
    .filter((event) => event.action === action)
    .map((event) => event.id);
}

export function buildPersistedGateEvidence(
  workspace: AgentOpsMatterWorkspace,
  exportAuthorization: ExportAuthorization,
  options: ExportPackageBuildOptions = {},
): PersistedGateEvidence {
  const gateProvenance = options.gateProvenance ?? [];
  const approvalCheckpointIds = uniqueStrings(
    gateProvenance.flatMap((item) =>
      item.sourceType === "human_checkpoint" && item.sourceId
        ? [item.sourceId]
        : [],
    ),
  );
  const gateSnapshotAuditEventIds = uniqueStrings(
    auditEventIdsByAction(workspace.audit_events, "gate_results_persisted"),
  );
  const gateAuthorizationAuditEventIds = uniqueStrings(
    auditEventIdsByAction(
      workspace.audit_events,
      "final_export_gate_authorized",
    ),
  );
  const blockedFinalExportAuditEventIds = uniqueStrings(
    auditEventIdsByAction(workspace.audit_events, "final_export_gate_blocked"),
  );
  const relatedGateAuditEventIds = uniqueStrings([
    ...gateSnapshotAuditEventIds,
    ...gateAuthorizationAuditEventIds,
    ...blockedFinalExportAuditEventIds,
    ...gateProvenance.flatMap((item) => item.relatedAuditEventIds),
  ]);
  const finalIntent = exportAuthorization.intent === "final";
  const finalAllowed = exportAuthorization.final_export_allowed;
  const missingFinalEvidence = finalIntent && finalAllowed;
  const validation: ExportValidationItem[] = [
    {
      name: "persisted_gate_snapshot",
      status: gateSnapshotAuditEventIds.length
        ? "passed"
        : missingFinalEvidence
          ? "failed"
          : "warning",
      detail: gateSnapshotAuditEventIds.length
        ? `${gateSnapshotAuditEventIds.length} persisted gate snapshot audit event(s) included.`
        : missingFinalEvidence
          ? "Final export gates pass, but no persisted gate_results_persisted audit event ID is included."
          : "No persisted gate snapshot audit event is included in this preview package.",
    },
    {
      name: "persisted_gate_authorization",
      status: gateAuthorizationAuditEventIds.length
        ? "passed"
        : missingFinalEvidence
          ? "failed"
          : "warning",
      detail: gateAuthorizationAuditEventIds.length
        ? `${gateAuthorizationAuditEventIds.length} final export authorization audit event(s) included.`
        : missingFinalEvidence
          ? "Final export gates pass, but no final_export_gate_authorized audit event ID is included."
          : "No final export authorization audit event is included in this preview package.",
    },
    {
      name: "approval_checkpoint_provenance",
      status: approvalCheckpointIds.length
        ? "passed"
        : missingFinalEvidence
          ? "failed"
          : "warning",
      detail: approvalCheckpointIds.length
        ? `${approvalCheckpointIds.length} approval checkpoint ID(s) included through gate provenance.`
        : missingFinalEvidence
          ? "Final export gates pass, but no approval checkpoint ID is included through gate provenance."
          : "No approval checkpoint ID is included through gate provenance.",
    },
  ];

  return {
    schema_version: "aletheia-persisted-gate-evidence-v1",
    matter_id: workspace.matter.id,
    source: "audit_events_and_gate_provenance",
    gate_result_ids: workspace.gate_results.map((gate) => gate.id),
    approval_checkpoint_ids: approvalCheckpointIds,
    gate_snapshot_audit_event_ids: gateSnapshotAuditEventIds,
    gate_authorization_audit_event_ids: gateAuthorizationAuditEventIds,
    blocked_final_export_audit_event_ids: blockedFinalExportAuditEventIds,
    related_gate_audit_event_ids: relatedGateAuditEventIds,
    final_export_allowed: finalAllowed,
    validation,
    warnings: validation
      .filter((item) => item.status !== "passed")
      .map((item) => item.detail),
  };
}

function failureTypeForText(text: string): EvalFailureType {
  const normalized = text.toLowerCase();

  if (normalized.includes("contradict") || normalized.includes("conflict")) {
    return "contradiction_missed";
  }

  if (
    normalized.includes("missed issue") ||
    normalized.includes("missing issue")
  ) {
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

function evalCaseFromGateResult(
  gate: GateResult,
  sourceRunId: string,
): EvalCase {
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

function approvalStatusFromGate(
  gate: GateResult,
): HumanApprovalLogEntry["status"] {
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
  const cases = uniqueById([
    ...workspace.eval_cases,
    ...reviewCases,
    ...gateCases,
  ]);

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

function validateExportPackage(
  workspace: AgentOpsMatterWorkspace,
): ExportValidationItem[] {
  return [
    {
      name: "matter_profile",
      status:
        workspace.matter.id && workspace.matter.title ? "passed" : "failed",
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
  options: ExportPackageBuildOptions = {},
): AuditPack {
  const evalCaseExport = buildEvalCaseExport(workspace, exportedAt);
  const sourceIndexManifest = options.sourceIndex
    ? buildV1SourceIndexManifest(options.sourceIndex, workspace.matter.id)
    : undefined;
  const exportAuthorization = buildExportAuthorization(
    workspace.gate_results,
    options.exportIntent ?? "draft",
  );
  const persistedGateEvidence = buildPersistedGateEvidence(
    workspace,
    exportAuthorization,
    options,
  );
  const typedHandoffProvenance = buildTypedHandoffProvenance(workspace, {
    ...options,
    persistedGateEvidence,
  });
  const evalSnapshotProvenance = buildEvalSnapshotProvenance(workspace, {
    snapshotId: `eval-snapshot-${workspace.matter.id}-${exportedAt}`,
    feedbackExportIds: options.feedbackExportIds,
    candidateSkillIds: options.candidateSkillIds,
    approvedPlaybookIds: options.approvedPlaybookIds,
    persistedGateEvidence,
  });
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
      (memo) =>
        memo.review_status === "approved" && memo.gate_status === "passed",
    ),
    review_comments: workspace.review_comments,
    gate_results: workspace.gate_results,
    agent_run_trace: buildAgentRunTrace(workspace),
    tool_call_log: buildToolCallLog(workspace),
    human_approval_log: buildHumanApprovalLog(workspace),
    typed_handoff_provenance: typedHandoffProvenance,
    audit_events: auditEvents,
    eval_cases: evalCaseExport.cases,
    eval_snapshot_provenance: evalSnapshotProvenance,
    ...(sourceIndexManifest
      ? { source_index_manifest: sourceIndexManifest }
      : {}),
    export_authorization: exportAuthorization,
    persisted_gate_evidence: persistedGateEvidence,
    validation: [
      ...validateExportPackage(workspace),
      ...(sourceIndexManifest ? sourceIndexManifest.validation : []),
      ...exportAuthorization.validation,
      ...persistedGateEvidence.validation,
    ],
  };

  return {
    ...packWithoutHash,
    export_hash: computeExportHash(packWithoutHash),
  };
}

export function buildExportPackage(
  workspace: AgentOpsMatterWorkspace,
  exportedAt = new Date().toISOString(),
  options: ExportPackageBuildOptions = {},
): ExportPackage {
  const auditPack = buildAuditPack(workspace, exportedAt, options);
  const evalCaseExport = buildEvalCaseExport(workspace, exportedAt);
  const sourceIndexManifest = auditPack.source_index_manifest;
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
      audit_event_agent_runs: auditPack.audit_events.filter(
        (event) => event.action === "agent_run_recorded",
      ).length,
      audit_event_tool_calls: auditPack.audit_events.filter(
        (event) => event.action === "tool_call_recorded",
      ).length,
      audit_event_review_comments: auditPack.audit_events.filter(
        (event) => event.action === "review_comment_recorded",
      ).length,
      audit_event_gate_results: auditPack.audit_events.filter(
        (event) => event.action === "gate_result_recorded",
      ).length,
      agent_runs: workspace.runs.length,
      tool_calls: buildToolCallLog(workspace).length,
      handoff_provenance_items: auditPack.typed_handoff_provenance.length,
      eval_cases: evalCaseExport.cases.length,
      eval_snapshot_source_runs:
        auditPack.eval_snapshot_provenance.sourceRunIds.length,
      eval_snapshot_source_reviews:
        auditPack.eval_snapshot_provenance.sourceReviewCommentIds.length,
      eval_snapshot_source_gates:
        auditPack.eval_snapshot_provenance.sourceGateResultIds.length,
      eval_snapshot_source_audit_events:
        auditPack.eval_snapshot_provenance.sourceAuditEventIds.length,
      eval_snapshot_feedback_exports:
        auditPack.eval_snapshot_provenance.feedbackExportIds.length,
      eval_snapshot_candidate_skills:
        auditPack.eval_snapshot_provenance.candidateSkillIds.length,
      eval_snapshot_approved_playbooks:
        auditPack.eval_snapshot_provenance.approvedPlaybookIds.length,
      source_index_documents: sourceIndexManifest?.document_count ?? 0,
      source_index_chunks: sourceIndexManifest?.chunk_count ?? 0,
      source_index_source_links: sourceIndexManifest?.source_link_count ?? 0,
      persisted_gate_snapshot_audit_events:
        auditPack.persisted_gate_evidence.gate_snapshot_audit_event_ids.length,
      persisted_gate_authorization_audit_events:
        auditPack.persisted_gate_evidence.gate_authorization_audit_event_ids
          .length,
      persisted_gate_blocked_audit_events:
        auditPack.persisted_gate_evidence.blocked_final_export_audit_event_ids
          .length,
      approval_checkpoint_ids:
        auditPack.persisted_gate_evidence.approval_checkpoint_ids.length,
      final_export_allowed: auditPack.export_authorization.final_export_allowed,
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
    eval_snapshot_provenance:
      exportPackage.audit_pack.eval_snapshot_provenance,
    ...(exportPackage.audit_pack.source_index_manifest
      ? {
          source_index_manifest: exportPackage.audit_pack.source_index_manifest,
        }
      : {}),
    export_authorization: exportPackage.audit_pack.export_authorization,
    persisted_gate_evidence: exportPackage.audit_pack.persisted_gate_evidence,
    validation: exportPackage.audit_pack.validation,
  });
  const evalSourceIds = new Set([
    ...exportPackage.eval_case_export.source_review_comment_ids,
    ...exportPackage.eval_case_export.source_gate_result_ids,
  ]);
  const evalCasesWithSourceSignals =
    exportPackage.eval_case_export.cases.filter((evalCase) => {
      if (
        evalSourceIds.has(evalCase.id.replace(/^eval-from-(review|gate)-/, ""))
      ) {
        return true;
      }
      const snapshot = evalCase.input_snapshot;
      if (
        !snapshot ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot)
      ) {
        return false;
      }
      const record = snapshot as Record<string, unknown>;
      return (
        typeof record.review_comment_id === "string" ||
        typeof record.gate_id === "string" ||
        typeof record.artifact_id === "string" ||
        typeof record.memo_section_id === "string"
      );
    });
  const sourceIndexManifestValidation =
    exportPackage.audit_pack.source_index_manifest?.validation ?? [];
  const failedSourceIndexManifestItems = sourceIndexManifestValidation.filter(
    (item) => item.status === "failed",
  );
  const warningSourceIndexManifestItems = sourceIndexManifestValidation.filter(
    (item) => item.status === "warning",
  );
  const failedPersistedGateEvidenceItems =
    exportPackage.audit_pack.persisted_gate_evidence.validation.filter(
      (item) => item.status === "failed",
    );
  const warningPersistedGateEvidenceItems =
    exportPackage.audit_pack.persisted_gate_evidence.validation.filter(
      (item) => item.status === "warning",
    );

  return [
    {
      name: "package_hash",
      status:
        recomputedPackageHash === exportPackage.export_hash
          ? "passed"
          : "failed",
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
        exportPackage.manifest.audit_events ===
          exportPackage.audit_pack.audit_events.length &&
        exportPackage.manifest.audit_event_agent_runs ===
          exportPackage.audit_pack.audit_events.filter(
            (event) => event.action === "agent_run_recorded",
          ).length &&
        exportPackage.manifest.audit_event_tool_calls ===
          exportPackage.audit_pack.audit_events.filter(
            (event) => event.action === "tool_call_recorded",
          ).length &&
        exportPackage.manifest.audit_event_review_comments ===
          exportPackage.audit_pack.audit_events.filter(
            (event) => event.action === "review_comment_recorded",
          ).length &&
        exportPackage.manifest.audit_event_gate_results ===
          exportPackage.audit_pack.audit_events.filter(
            (event) => event.action === "gate_result_recorded",
          ).length &&
        exportPackage.manifest.agent_runs ===
          exportPackage.audit_pack.agent_run_trace.length &&
        exportPackage.manifest.tool_calls ===
          exportPackage.audit_pack.tool_call_log.length &&
        exportPackage.manifest.handoff_provenance_items ===
          exportPackage.audit_pack.typed_handoff_provenance.length &&
        exportPackage.manifest.eval_cases ===
          exportPackage.eval_case_export.cases.length &&
        exportPackage.manifest.eval_snapshot_source_runs ===
          exportPackage.audit_pack.eval_snapshot_provenance.sourceRunIds.length &&
        exportPackage.manifest.eval_snapshot_source_reviews ===
          exportPackage.audit_pack.eval_snapshot_provenance
            .sourceReviewCommentIds.length &&
        exportPackage.manifest.eval_snapshot_source_gates ===
          exportPackage.audit_pack.eval_snapshot_provenance.sourceGateResultIds
            .length &&
        exportPackage.manifest.eval_snapshot_source_audit_events ===
          exportPackage.audit_pack.eval_snapshot_provenance.sourceAuditEventIds
            .length &&
        exportPackage.manifest.eval_snapshot_feedback_exports ===
          exportPackage.audit_pack.eval_snapshot_provenance.feedbackExportIds
            .length &&
        exportPackage.manifest.eval_snapshot_candidate_skills ===
          exportPackage.audit_pack.eval_snapshot_provenance.candidateSkillIds
            .length &&
        exportPackage.manifest.eval_snapshot_approved_playbooks ===
          exportPackage.audit_pack.eval_snapshot_provenance.approvedPlaybookIds
            .length &&
        exportPackage.manifest.source_index_documents ===
          (exportPackage.audit_pack.source_index_manifest?.document_count ??
            0) &&
        exportPackage.manifest.source_index_chunks ===
          (exportPackage.audit_pack.source_index_manifest?.chunk_count ?? 0) &&
        exportPackage.manifest.source_index_source_links ===
          (exportPackage.audit_pack.source_index_manifest?.source_link_count ??
            0) &&
        exportPackage.manifest.persisted_gate_snapshot_audit_events ===
          exportPackage.audit_pack.persisted_gate_evidence
            .gate_snapshot_audit_event_ids.length &&
        exportPackage.manifest.persisted_gate_authorization_audit_events ===
          exportPackage.audit_pack.persisted_gate_evidence
            .gate_authorization_audit_event_ids.length &&
        exportPackage.manifest.persisted_gate_blocked_audit_events ===
          exportPackage.audit_pack.persisted_gate_evidence
            .blocked_final_export_audit_event_ids.length &&
        exportPackage.manifest.approval_checkpoint_ids ===
          exportPackage.audit_pack.persisted_gate_evidence.approval_checkpoint_ids
            .length &&
        exportPackage.manifest.final_export_allowed ===
          exportPackage.audit_pack.export_authorization.final_export_allowed
          ? "passed"
          : "failed",
      detail: "Manifest counts agree with nested audit and eval sections.",
    },
    ...(sourceIndexManifestValidation.length
      ? [
          {
            name: "source_index_manifest_validation",
            status: failedSourceIndexManifestItems.length
              ? ("failed" as const)
              : warningSourceIndexManifestItems.length
                ? ("warning" as const)
                : ("passed" as const),
            detail: failedSourceIndexManifestItems.length
              ? `${failedSourceIndexManifestItems.length} source-index manifest validation item(s) failed.`
              : warningSourceIndexManifestItems.length
                ? `${warningSourceIndexManifestItems.length} source-index manifest validation warning(s) remain visible.`
                : "Source-index manifest validation passed.",
          },
        ]
      : []),
    {
      name: "persisted_gate_evidence",
      status: failedPersistedGateEvidenceItems.length
        ? "failed"
        : warningPersistedGateEvidenceItems.length
          ? "warning"
          : "passed",
      detail: failedPersistedGateEvidenceItems.length
        ? `${failedPersistedGateEvidenceItems.length} persisted gate evidence validation item(s) failed.`
        : warningPersistedGateEvidenceItems.length
          ? `${warningPersistedGateEvidenceItems.length} persisted gate evidence warning(s) remain visible.`
          : "Persisted gate snapshot, authorization, and approval checkpoint evidence is included.",
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
