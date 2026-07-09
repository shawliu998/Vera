import type {
  AletheiaAgentRunRecord,
  AletheiaAuditEventRecord,
  AletheiaEvidenceRecord,
  AletheiaHumanCheckpointRecord,
  AletheiaMatterDetail,
  AletheiaReviewRecord,
  AletheiaToolCallRecord,
  AletheiaWorkProductRecord,
} from "@/app/lib/aletheiaApi";
import { withComputedMemoCoverage } from "@/aletheia/agentops/schemas";
import type { GateEngineInput } from "@/aletheia/agentops/gates";
import type {
  DraftMemo,
  EvidenceItem,
  GateResult,
  IssueNode,
  Matter,
  MatterDocument,
  ReviewComment,
  ReviewStatus,
  RiskItem,
  RiskLevel,
} from "@/aletheia/agentops/types";

export function titleize(value: string) {
  return value.replaceAll("_", " ");
}

export function traceStatusClass(status: string) {
  if (
    status === "completed" ||
    status === "approved" ||
    status === "resolved"
  ) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (
    status === "needs_human" ||
    status === "requires_confirmation" ||
    status === "open"
  ) {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (status === "failed" || status === "rejected") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  return "border-[#e5e7eb] bg-[#f9fafb] text-[#374151]";
}

export function runTraceCounts(run: AletheiaAgentRunRecord | null) {
  return {
    steps: run?.steps?.length ?? 0,
    tools: run?.tool_calls?.length ?? 0,
    checkpoints: run?.human_checkpoints?.length ?? 0,
  };
}

export function highRiskCheckpoints(
  detail: AletheiaMatterDetail | null,
  action: "audit_pack_export" | "feedback_dataset_export" | "final_memo_export",
) {
  return (detail?.agentRuns ?? [])
    .flatMap((run) => run.human_checkpoints ?? [])
    .filter((checkpoint) => checkpoint.checkpoint_type === action);
}

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

function checkpointLogEntry(checkpoint: AletheiaHumanCheckpointRecord) {
  return {
    id: checkpoint.id,
    matterId: checkpoint.matter_id,
    runId: checkpoint.run_id,
    stepId: checkpoint.step_id,
    checkpointType: checkpoint.checkpoint_type,
    status: checkpoint.status,
    decision: checkpoint.decision,
    prompt: checkpoint.prompt,
    requestedPayload: checkpoint.requested_payload,
    decisionPayload: checkpoint.decision_payload,
    decidedBy: checkpoint.decided_by,
    decidedAt: checkpoint.decided_at,
    createdAt: checkpoint.created_at,
  };
}

function toolCallLogEntry(
  run: AletheiaAgentRunRecord,
  call: AletheiaToolCallRecord,
) {
  return {
    id: call.id,
    matterId: call.matter_id,
    runId: call.run_id,
    agentRunGoal: run.goal,
    stepId: call.step_id,
    toolName: call.tool_name,
    riskLevel: call.risk_level,
    status: call.status,
    input: call.input,
    output: call.output,
    error: call.error,
    metrics: call.metrics,
    startedAt: call.started_at,
    completedAt: call.completed_at,
    createdAt: call.created_at,
  };
}

function buildAgentRunTrace(detail: AletheiaMatterDetail) {
  return (detail.agentRuns ?? []).map((run) => ({
    id: run.id,
    matterId: run.matter_id,
    workflow: run.workflow,
    goal: run.goal,
    status: run.status,
    currentStepKey: run.current_step_key,
    modelProfile: run.model_profile,
    storageDriver: run.storage_driver,
    budget: run.budget,
    workflowGraph: run.metadata.workflowGraph ?? null,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    steps: run.steps ?? [],
    toolCallIds: (run.tool_calls ?? []).map((call) => call.id),
    humanCheckpointIds: (run.human_checkpoints ?? []).map(
      (checkpoint) => checkpoint.id,
    ),
  }));
}

function buildToolCallLog(detail: AletheiaMatterDetail) {
  return (detail.agentRuns ?? []).flatMap((run) =>
    (run.tool_calls ?? []).map((call) => toolCallLogEntry(run, call)),
  );
}

function buildHumanApprovalLog(detail: AletheiaMatterDetail) {
  const checkpoints = (detail.agentRuns ?? []).flatMap((run) =>
    (run.human_checkpoints ?? []).map(checkpointLogEntry),
  );
  const auditApprovalEvents = detail.auditEvents
    .filter((event) => event.action.includes("approval"))
    .map((event) => ({
      id: event.id,
      matterId: event.matter_id,
      source: "audit_event",
      actor: event.actor,
      action: event.action,
      details: event.details,
      createdAt: event.created_at,
    }));

  return {
    checkpoints,
    auditApprovalEvents,
  };
}

type EvalFailureType =
  | "unsupported_claim"
  | "missing_citation"
  | "missed_issue"
  | "wrong_risk_level"
  | "contradiction_missed"
  | "bad_memo_structure"
  | "expert_override";

const evalFailureTypes = [
  "unsupported_claim",
  "missing_citation",
  "missed_issue",
  "wrong_risk_level",
  "contradiction_missed",
  "bad_memo_structure",
  "expert_override",
] as const satisfies readonly EvalFailureType[];

function failureTypeForReview(review: AletheiaReviewRecord): EvalFailureType {
  const text = `${review.tag} ${review.comment}`.toLowerCase();

  if (text.includes("contradict") || text.includes("conflict")) {
    return "contradiction_missed";
  }
  if (text.includes("missed issue") || text.includes("missing issue")) {
    return "missed_issue";
  }
  if (text.includes("risk level") || text.includes("severity")) {
    return "wrong_risk_level";
  }
  if (text.includes("structure") || text.includes("section")) {
    return "bad_memo_structure";
  }
  if (text.includes("citation") || text.includes("source")) {
    return "missing_citation";
  }
  if (text.includes("unsupported") || text.includes("overclaim")) {
    return "unsupported_claim";
  }
  return "expert_override";
}

function evalCaseFromReview(review: AletheiaReviewRecord) {
  return {
    id: `eval-review-${review.id}`,
    matterId: review.matter_id,
    sourceReviewId: review.id,
    sourceWorkProductId: review.work_product_id,
    sourceEvidenceItemId: review.evidence_item_id,
    failureType: failureTypeForReview(review),
    inputSnapshot: {
      targetType: review.target_type,
      targetId: review.target_id,
      tag: review.tag,
      comment: review.comment,
    },
    expectedBehavior:
      "Future runs should resolve the expert feedback before gate approval or export.",
    expertFeedback: review.comment,
    status: "open",
  };
}

function evalCaseFromAuditEvent(event: AletheiaAuditEventRecord) {
  return {
    id: `eval-audit-${event.id}`,
    matterId: event.matter_id,
    sourceAuditEventId: event.id,
    failureType: event.action.includes("rejected")
      ? ("expert_override" as const)
      : ("unsupported_claim" as const),
    inputSnapshot: {
      action: event.action,
      details: event.details,
    },
    expectedBehavior:
      "Future runs should avoid repeating audit-recorded gate or approval failures.",
    expertFeedback: event.action,
    status: "open",
  };
}

function buildEvalCases(detail: AletheiaMatterDetail) {
  const reviewCases = detail.reviews.map(evalCaseFromReview);
  const auditCases = detail.auditEvents
    .filter(
      (event) =>
        event.action.includes("rejected") ||
        event.action.includes("gate_failed"),
    )
    .map(evalCaseFromAuditEvent);
  return [...reviewCases, ...auditCases];
}

export function buildAuditPack(
  detail: AletheiaMatterDetail,
): Record<string, unknown> {
  const latestDraftMemo =
    [...detail.workProducts].reverse().find((item) => item.kind === "draft_memo") ??
    null;
  const latestFinalMemo =
    [...detail.workProducts].reverse().find((item) => item.kind === "final_memo") ??
    null;
  const packWithoutHash = {
    schemaVersion: "aletheia-audit-pack-v0",
    exportedAt: new Date().toISOString(),
    matterProfile: detail.matter,
    documentList: detail.documents,
    evidenceMatrix: detail.evidence,
    issueMap:
      detail.workProducts.find((item) => item.kind === "issue_map")?.content ??
      null,
    riskRegister:
      detail.workProducts.find((item) => item.kind === "compliance_register")
        ?.content ??
      detail.workProducts.find((item) => item.kind === "red_flag_memo")
        ?.content ??
      null,
    draftMemo: latestDraftMemo,
    finalMemo: latestFinalMemo,
    reviewComments: detail.reviews,
    gateResults: {
      humanApprovalLog: buildHumanApprovalLog(detail),
      validationErrors: detail.workProducts.flatMap((item) =>
        item.validation_errors.map((error) => ({
          workProductId: item.id,
          workProductKind: item.kind,
          error,
        })),
      ),
    },
    agentRunTrace: buildAgentRunTrace(detail),
    toolCallLog: buildToolCallLog(detail),
    humanApprovalLog: buildHumanApprovalLog(detail),
    auditEvents: detail.auditEvents,
    evalCases: buildEvalCases(detail),
    workProducts: detail.workProducts,
  };

  return {
    ...packWithoutHash,
    exportHash: computeExportHash(packWithoutHash),
  };
}

export function buildFeedbackDataset(
  detail: AletheiaMatterDetail,
): Record<string, unknown> {
  const records = detail.reviews.map((review) => ({
    id: review.id,
    createdAt: review.created_at,
    reviewer: review.reviewer_name ?? review.reviewer_user_id,
    tag: review.tag,
    comment: review.comment,
    targetType: review.target_type,
    targetId: review.target_id,
    failureType: failureTypeForReview(review),
    evidence: detail.evidence.filter(
      (item) =>
        item.id === review.evidence_item_id ||
        item.claim_id === review.target_id,
    ),
  }));
  return {
    schemaVersion: "aletheia-feedback-eval-v0",
    exportedAt: new Date().toISOString(),
    matterId: detail.matter.id,
    matterTitle: detail.matter.title,
    objective: detail.matter.objective,
    failureTypes: evalFailureTypes,
    records,
    evalCases: buildEvalCases(detail),
  };
}

export function summarizeGateResults(gateResults: GateResult[]) {
  return {
    passed: gateResults.filter((gate) => gate.status === "passed").length,
    warnings: gateResults.filter((gate) => gate.status === "warning").length,
    failed: gateResults.filter((gate) => gate.status === "failed").length,
    skipped: gateResults.filter((gate) => gate.status === "skipped").length,
  };
}

export type GatePersistenceSourceRef = {
  type:
    | "work_product"
    | "evidence_item"
    | "review_item"
    | "human_checkpoint"
    | "audit_event"
    | "agent_run"
    | "matter_memory"
    | "document"
    | "matter";
  id: string;
  role: "input" | "approval" | "blocker" | "audit" | "provenance";
  document_id?: string | null;
  source_chunk_id?: string | null;
  quote_start?: number | null;
  quote_end?: number | null;
  claim_id?: string | null;
};

export type GatePersistenceProvenance = {
  gate_id: string;
  gate_type: GateResult["gate_type"];
  status: GateResult["status"];
  displayed_reason: string;
  source_record_refs: GatePersistenceSourceRef[];
  unresolved_source_requirements: string[];
};

function addGateSourceRef(
  refs: GatePersistenceSourceRef[],
  ref: GatePersistenceSourceRef | null | undefined,
) {
  if (!ref) return;
  const key = `${ref.type}:${ref.id}:${ref.role}`;
  if (refs.some((item) => `${item.type}:${item.id}:${item.role}` === key)) {
    return;
  }
  refs.push(ref);
}

function gateRefRole(gate: GateResult): GatePersistenceSourceRef["role"] {
  if (gate.status === "failed") return "blocker";
  if (gate.status === "passed") return "provenance";
  return "input";
}

function approvalCheckpoints(detail: AletheiaMatterDetail) {
  return (detail.agentRuns ?? [])
    .flatMap((run) => run.human_checkpoints ?? [])
    .filter((checkpoint) => checkpoint.checkpoint_type === "final_memo_export");
}

function gateAuditEvents(detail: AletheiaMatterDetail, gate: GateResult) {
  return detail.auditEvents.filter((event) => {
    const haystack = `${event.action} ${stableStringify(event.details)}`;
    return (
      haystack.includes(gate.gate_type) ||
      haystack.includes(gate.id) ||
      (gate.gate_type === "human_approval" && haystack.includes("approval")) ||
      (gate.gate_type === "export" && haystack.includes("final_memo"))
    );
  });
}

function workProductsContainingArtifact(
  detail: AletheiaMatterDetail,
  artifactId: string,
) {
  return detail.workProducts.filter((workProduct) => {
    if (workProduct.id === artifactId) return true;
    return recordArray(workProduct.content.sections).some(
      (section) => section.id === artifactId,
    );
  });
}

function issueMapEvidenceIdsForArtifact(
  detail: AletheiaMatterDetail,
  artifactId: string,
) {
  return detail.workProducts
    .filter((workProduct) => workProduct.kind === "issue_map")
    .flatMap((workProduct) =>
      issueMapIssues(workProduct.content).flatMap((issue) => {
        if (
          issue.id !== artifactId &&
          issue.claimId !== artifactId &&
          `risk-${issue.id}` !== artifactId
        ) {
          return [];
        }
        return issue.representativeQuotes.map((quote) => quote.evidenceId);
      }),
    );
}

function evidenceRef(
  evidence: AletheiaEvidenceRecord,
  role: GatePersistenceSourceRef["role"],
): GatePersistenceSourceRef {
  return {
    type: "evidence_item",
    id: evidence.id,
    role,
    document_id: evidence.document_id,
    source_chunk_id: evidence.source_chunk_id ?? null,
    quote_start: evidence.quote_start ?? null,
    quote_end: evidence.quote_end ?? null,
    claim_id: evidence.claim_id,
  };
}

function gateSensitiveMaterialRefs(
  detail: AletheiaMatterDetail,
  refs: GatePersistenceSourceRef[],
) {
  for (const document of detail.documents) {
    if (metadataFlags(document.metadata).length > 0) {
      addGateSourceRef(refs, {
        type: "document",
        id: document.id,
        role: "provenance",
        document_id: document.document_id,
      });
    }
  }
  for (const evidence of detail.evidence) {
    if (metadataFlags(evidence.metadata).length > 0) {
      addGateSourceRef(refs, evidenceRef(evidence, "provenance"));
    }
  }
}

export function buildGatePersistenceProvenance(args: {
  detail: AletheiaMatterDetail;
  gateResults: GateResult[];
  draftMemoId?: string | null;
  approvalCheckpointId?: string | null;
}): GatePersistenceProvenance[] {
  const documentsByAnyId = new Map(
    args.detail.documents.flatMap((document) => [
      [document.id, document] as const,
      ...(document.document_id ? [[document.document_id, document] as const] : []),
    ]),
  );
  const evidenceById = new Map(
    args.detail.evidence.map((evidence) => [evidence.id, evidence] as const),
  );
  const reviewsById = new Map(
    args.detail.reviews.map((review) => [review.id, review] as const),
  );
  const reviewsByTargetId = new Map<string, AletheiaReviewRecord[]>();
  for (const review of args.detail.reviews) {
    reviewsByTargetId.set(review.target_id, [
      ...(reviewsByTargetId.get(review.target_id) ?? []),
      review,
    ]);
  }

  return args.gateResults.map((gate) => {
    const refs: GatePersistenceSourceRef[] = [];
    const unresolved = new Set<string>();
    const role = gateRefRole(gate);

    addGateSourceRef(refs, {
      type: "matter",
      id: args.detail.matter.id,
      role: "input",
    });

    if (args.draftMemoId) {
      addGateSourceRef(refs, {
        type: "work_product",
        id: args.draftMemoId,
        role: "input",
      });
    }

    if (gate.gate_type === "citation" && gate.status === "passed") {
      for (const evidence of args.detail.evidence) {
        addGateSourceRef(refs, evidenceRef(evidence, "provenance"));
        if (evidence.document_id) {
          addGateSourceRef(refs, {
            type: "document",
            id: evidence.document_id,
            role: "provenance",
          });
        }
      }
    }

    for (const artifactId of gate.affected_artifact_ids) {
      const evidence = evidenceById.get(artifactId);
      if (evidence) {
        addGateSourceRef(refs, evidenceRef(evidence, role));
        if (evidence.document_id) {
          addGateSourceRef(refs, {
            type: "document",
            id: evidence.document_id,
            role: "provenance",
          });
        }
      }

      const document = documentsByAnyId.get(artifactId);
      if (document) {
        addGateSourceRef(refs, {
          type: "document",
          id: document.id,
          role,
          document_id: document.document_id,
        });
      }

      const review = reviewsById.get(artifactId);
      if (review) {
        addGateSourceRef(refs, {
          type: "review_item",
          id: review.id,
          role,
        });
      }

      for (const targetReview of reviewsByTargetId.get(artifactId) ?? []) {
        addGateSourceRef(refs, {
          type: "review_item",
          id: targetReview.id,
          role,
        });
      }

      for (const workProduct of workProductsContainingArtifact(
        args.detail,
        artifactId,
      )) {
        addGateSourceRef(refs, {
          type: "work_product",
          id: workProduct.id,
          role,
        });
      }

      for (const evidenceId of issueMapEvidenceIdsForArtifact(
        args.detail,
        artifactId,
      )) {
        const linkedEvidence = evidenceById.get(evidenceId);
        if (linkedEvidence) {
          addGateSourceRef(refs, evidenceRef(linkedEvidence, "provenance"));
        }
      }
    }

    if (gate.gate_type === "human_approval" || gate.gate_type === "export") {
      const checkpoints = approvalCheckpoints(args.detail);
      for (const checkpoint of checkpoints) {
        addGateSourceRef(refs, {
          type: "human_checkpoint",
          id: checkpoint.id,
          role: checkpoint.status === "approved" ? "approval" : "blocker",
        });
        addGateSourceRef(refs, {
          type: "agent_run",
          id: checkpoint.run_id,
          role: "provenance",
        });
      }
      if (args.approvalCheckpointId && checkpoints.length === 0) {
        addGateSourceRef(refs, {
          type: "human_checkpoint",
          id: args.approvalCheckpointId,
          role: "approval",
        });
      }
      if (gate.status === "passed" && checkpoints.length === 0) {
        unresolved.add("No persisted human checkpoint found for passed approval/export gate.");
      }
    }

    if (gate.gate_type === "missing_material") {
      for (const memory of args.detail.matterMemory ?? []) {
        if (memory.category === "missing_material") {
          addGateSourceRef(refs, {
            type: "matter_memory",
            id: memory.id,
            role: memory.source === "human" ? "input" : "provenance",
          });
        }
      }
    }

    if (gate.gate_type === "conflict") {
      for (const evidence of args.detail.evidence.filter(
        (item) => item.support_status !== "supports",
      )) {
        addGateSourceRef(refs, evidenceRef(evidence, "blocker"));
      }
      for (const review of args.detail.reviews.filter(
        (item) => item.tag === "conflicting_evidence",
      )) {
        addGateSourceRef(refs, {
          type: "review_item",
          id: review.id,
          role: "blocker",
        });
      }
    }

    if (gate.gate_type === "privilege") {
      gateSensitiveMaterialRefs(args.detail, refs);
    }

    for (const event of gateAuditEvents(args.detail, gate)) {
      addGateSourceRef(refs, {
        type: "audit_event",
        id: event.id,
        role: "audit",
      });
    }

    if (gate.status === "failed" && refs.length <= (args.draftMemoId ? 2 : 1)) {
      unresolved.add("Failed gate needs persisted blocker IDs beyond matter/draft memo context.");
    }
    if (
      gate.status === "passed" &&
      (gate.gate_type === "human_approval" || gate.gate_type === "export") &&
      !refs.some((ref) => ref.type === "audit_event")
    ) {
      unresolved.add("No audit_event_id found for passed approval/export gate.");
    }
    if (gate.gate_type === "citation" && !refs.some((ref) => ref.type === "evidence_item")) {
      unresolved.add("Citation gate has no evidence_item_id/source_chunk_id provenance.");
    }

    return {
      gate_id: gate.id,
      gate_type: gate.gate_type,
      status: gate.status,
      displayed_reason: gate.reason,
      source_record_refs: refs,
      unresolved_source_requirements: [...unresolved],
    };
  });
}

export function buildFinalMemo(args: {
  detail: AletheiaMatterDetail;
  draftMemoId: string;
  draftContent: Record<string, unknown>;
  approvalCheckpointId: string;
  gateResults?: GateResult[];
  gateProvenance?: GatePersistenceProvenance[];
}): Record<string, unknown> {
  return {
    schemaVersion: "aletheia-final-memo-v0",
    finalizedAt: new Date().toISOString(),
    sourceDraftMemoId: args.draftMemoId,
    approvalCheckpointId: args.approvalCheckpointId,
    matter: args.detail.matter,
    title:
      typeof args.draftContent.title === "string"
        ? args.draftContent.title.replace("Draft Memo", "Final Memo")
        : `${args.detail.matter.title} Final Memo`,
    disclaimer:
      "Finalized by explicit human approval. Source evidence, review notes, and audit events remain attached for verification.",
    sections: recordArray(args.draftContent.sections),
    sourceEvidenceIds: args.detail.evidence.map((item) => item.id),
    reviewCount: args.detail.reviews.length,
    auditEventCount: args.detail.auditEvents.length,
    gateResults: args.gateResults ?? [],
    gateSummary: summarizeGateResults(args.gateResults ?? []),
    gateProvenance: args.gateProvenance ?? [],
  };
}

export function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function latestWorkProduct(
  detail: AletheiaMatterDetail,
  kind: string,
) {
  return [...detail.workProducts]
    .reverse()
    .find((item) => item.kind === kind);
}

function metadataFlags(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return stringArray((value as Record<string, unknown>).sensitiveMaterialFlags);
}

function normalizedFactFromQuote(value: string) {
  const quote = value.replace(/\s+/g, " ").trim();
  return quote.match(/^(.{40,220}?[.!?])\s/)?.[1] ?? quote.slice(0, 220);
}

function meaningfulTokens(value: string) {
  const stop = new Set([
    "and",
    "the",
    "or",
    "of",
    "to",
    "for",
    "with",
    "source",
    "documents",
    "document",
  ]);
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 2 && !stop.has(token));
}

export type MaterialChecklistItem = {
  label: string;
  status: "present" | "missing";
  matchedDocumentNames: string[];
};

export function materialChecklist(detail: AletheiaMatterDetail) {
  const plan = latestWorkProduct(detail, "agent_plan");
  const requiredDocuments = stringArray(plan?.content.requiredDocuments);
  return requiredDocuments.map((label) => {
    const tokens = meaningfulTokens(label);
    const matchedDocumentNames = detail.documents
      .filter((document) => {
        const searchable = `${document.name} ${document.summary ?? ""}`.toLowerCase();
        return tokens.some((token) => searchable.includes(token));
      })
      .map((document) => document.name);
    return {
      label,
      status: matchedDocumentNames.length ? "present" : "missing",
      matchedDocumentNames,
    } satisfies MaterialChecklistItem;
  });
}

export type SourceMapDocument = {
  id: string;
  name: string;
  summary: string | null;
  documentType: string;
  parsedStatus: string;
  chunkCount: number | null;
  evidenceCount: number;
  searchable: boolean;
  sensitiveMaterialFlags: string[];
};

export function sourceMapDocuments(detail: AletheiaMatterDetail) {
  const evidenceByDocument = new Map<string, AletheiaEvidenceRecord[]>();
  for (const item of detail.evidence) {
    if (!item.document_id) continue;
    evidenceByDocument.set(item.document_id, [
      ...(evidenceByDocument.get(item.document_id) ?? []),
      item,
    ]);
  }

  return detail.documents.map((document) => {
    const chunkCount =
      typeof document.metadata.chunkCount === "number"
        ? document.metadata.chunkCount
        : null;
    return {
      id: document.id,
      name: document.name,
      summary: document.summary,
      documentType: document.document_type,
      parsedStatus: document.parsed_status,
      chunkCount,
      evidenceCount: evidenceByDocument.get(document.id)?.length ?? 0,
      searchable: document.parsed_status === "parsed" && Boolean(chunkCount),
      sensitiveMaterialFlags: metadataFlags(document.metadata),
    } satisfies SourceMapDocument;
  });
}

export type EvidenceMatrixRow = {
  id: string;
  supportsClaim: string;
  normalizedFact: string;
  documentName: string;
  page: number | null;
  section: string | null;
  sourceChunkId: string | null;
  quote: string;
  quoteRange: string | null;
  supportStatus: AletheiaEvidenceRecord["support_status"];
  confidence: string;
  reviewStatus: string;
  sensitiveMaterialFlags: string[];
};

export function evidenceMatrixRows(detail: AletheiaMatterDetail) {
  const documentsById = new Map(
    detail.documents.map((document) => [document.id, document]),
  );
  const reviewsByEvidenceId = new Map(
    detail.reviews
      .filter((review) => review.evidence_item_id)
      .map((review) => [review.evidence_item_id as string, review]),
  );
  return detail.evidence.map((item) => {
    const metadata = item.metadata ?? {};
    const review = reviewsByEvidenceId.get(item.id);
    const documentFlags = item.document_id
      ? metadataFlags(documentsById.get(item.document_id)?.metadata)
      : [];
    const quoteRange =
      typeof item.quote_start === "number" && typeof item.quote_end === "number"
        ? `${item.quote_start}-${item.quote_end}`
        : null;
    return {
      id: item.id,
      supportsClaim: item.claim_id ?? "unassigned",
      normalizedFact:
        typeof metadata.normalizedFact === "string" && metadata.normalizedFact
          ? metadata.normalizedFact
          : normalizedFactFromQuote(item.quote),
      documentName: item.document_name ?? "Source document",
      page: item.page,
      section: item.section,
      sourceChunkId: item.source_chunk_id ?? null,
      quote: item.quote,
      quoteRange,
      supportStatus: item.support_status,
      confidence: item.confidence ?? "low",
      reviewStatus:
        review?.tag ??
        (item.support_status === "supports" ? "unreviewed" : "needs_review"),
      sensitiveMaterialFlags: Array.from(
        new Set([...documentFlags, ...metadataFlags(metadata)]),
      ),
    } satisfies EvidenceMatrixRow;
  });
}

export function openQuestions(detail: AletheiaMatterDetail) {
  const plan = latestWorkProduct(detail, "agent_plan");
  const missingMaterials = stringArray(plan?.content.missingMaterials).map(
    (item) => `Missing material: ${item}`,
  );
  const memoryQuestions = (detail.matterMemory ?? [])
    .filter((item) => item.category === "missing_material")
    .map((item) => item.title);
  const evidenceQuestions = detail.evidence
    .filter((item) => item.support_status !== "supports")
    .map(
      (item) =>
        `Resolve ${item.support_status} evidence for ${item.claim_id ?? "unassigned claim"}`,
    );
  const issueQuestions = detail.workProducts
    .filter((item) => item.kind === "issue_map")
    .flatMap((item) =>
      issueMapIssues(item.content).flatMap((issue) => issue.openQuestions),
    );
  return Array.from(
    new Set([
      ...missingMaterials,
      ...memoryQuestions,
      ...evidenceQuestions,
      ...issueQuestions,
    ]),
  ).slice(0, 8);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type IssueMapIssue = {
  id: string;
  title: string;
  claimId: string;
  reviewStatus: string;
  supportSummary: {
    supports: number;
    contradicts: number;
    insufficient: number;
  };
  sourceDocuments: string[];
  representativeQuotes: Array<{
    evidenceId: string;
    documentName: string | null;
    page: number | null;
    quote: string;
    supportStatus: string;
  }>;
  openQuestions: string[];
};

export function issueMapIssues(
  content: Record<string, unknown>,
): IssueMapIssue[] {
  return recordArray(content.issues).map((issue, index) => {
    const supportSummary =
      issue.supportSummary &&
      typeof issue.supportSummary === "object" &&
      !Array.isArray(issue.supportSummary)
        ? (issue.supportSummary as Record<string, unknown>)
        : {};
    return {
      id: typeof issue.id === "string" ? issue.id : `issue-${index}`,
      title: typeof issue.title === "string" ? issue.title : "Issue",
      claimId:
        typeof issue.claimId === "string"
          ? issue.claimId
          : typeof issue.id === "string"
            ? issue.id
            : "unassigned",
      reviewStatus:
        typeof issue.reviewStatus === "string"
          ? issue.reviewStatus
          : "unreviewed",
      supportSummary: {
        supports: numberValue(supportSummary.supports),
        contradicts: numberValue(supportSummary.contradicts),
        insufficient: numberValue(supportSummary.insufficient),
      },
      sourceDocuments: stringArray(issue.sourceDocuments),
      representativeQuotes: recordArray(issue.representativeQuotes).map(
        (quote, quoteIndex) => ({
          evidenceId:
            typeof quote.evidenceId === "string"
              ? quote.evidenceId
              : `quote-${quoteIndex}`,
          documentName:
            typeof quote.documentName === "string" ? quote.documentName : null,
          page:
            typeof quote.page === "number" && Number.isFinite(quote.page)
              ? quote.page
              : null,
          quote: typeof quote.quote === "string" ? quote.quote : "",
          supportStatus:
            typeof quote.supportStatus === "string"
              ? quote.supportStatus
              : "unreviewed",
        }),
      ),
      openQuestions: stringArray(issue.openQuestions),
    };
  });
}

export function draftMemoSections(content: Record<string, unknown>) {
  return recordArray(content.sections).map((section, index) => ({
    id: typeof section.id === "string" ? section.id : `memo-section-${index}`,
    title: typeof section.title === "string" ? section.title : "Memo Section",
    body: stringArray(section.body),
    reviewStatus:
      typeof section.reviewStatus === "string"
        ? section.reviewStatus
        : "unreviewed",
  }));
}

function agentOpsMatterType(
  template: AletheiaMatterDetail["matter"]["template"],
): Matter["type"] {
  if (template === "compliance_impact_review") return "compliance_review";
  if (template === "deal_due_diligence") return "due_diligence";
  return "legal_review";
}

function agentOpsRiskLevel(value: string | null | undefined): RiskLevel {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function agentOpsReviewStatus(value: string | undefined): ReviewStatus {
  if (value === "accepted" || value === "approved" || value === "source_linked") {
    return "approved";
  }
  if (value === "needs_revision" || value === "needs_human_review") {
    return "needs_revision";
  }
  if (value === "rejected") return "rejected";
  return "pending";
}

function evidenceConfidence(value: string | null) {
  if (value === "high") return 0.9;
  if (value === "medium") return 0.72;
  if (value === "low") return 0.5;
  return 0.65;
}

function agentOpsMatter(detail: AletheiaMatterDetail): Matter {
  const documents: MatterDocument[] = detail.documents.map((document) => ({
    id: document.id,
    matter_id: document.matter_id,
    title: document.name,
    filename: document.name,
    document_type: "other",
    status:
      document.parsed_status === "parsed" ? "indexed" : document.parsed_status,
    uploaded_at: document.created_at,
    source_uri:
      typeof document.metadata.sourceUri === "string"
        ? document.metadata.sourceUri
        : undefined,
    hash:
      typeof document.metadata.hash === "string"
        ? document.metadata.hash
        : undefined,
  }));

  return {
    id: detail.matter.id,
    title: detail.matter.title,
    type: agentOpsMatterType(detail.matter.template),
    risk_level: agentOpsRiskLevel(detail.matter.risk_level),
    status:
      detail.matter.status === "needs_review"
        ? "review_needed"
        : detail.matter.status === "in_progress"
          ? "active"
          : detail.matter.status === "completed"
            ? "approved"
          : detail.matter.status,
    documents,
    created_at: detail.matter.created_at,
    updated_at: detail.matter.updated_at,
  };
}

function agentOpsEvidence(detail: AletheiaMatterDetail): EvidenceItem[] {
  return detail.evidence.map((item) => ({
    id: item.id,
    matter_id: item.matter_id,
    source_document_id: item.document_id ?? item.source_chunk_id ?? item.id,
    page: item.page ?? undefined,
    section: item.section ?? undefined,
    quote: item.quote,
    normalized_fact: [
      item.quote,
      item.support_status === "contradicts"
        ? "Contradicts mapped claim."
        : undefined,
      item.support_status === "insufficient"
        ? "Insufficient support for mapped claim."
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    supports_claim_ids: item.claim_id ? [item.claim_id] : [],
    confidence: evidenceConfidence(item.confidence),
    review_status:
      item.support_status === "supports" ? "approved" : "needs_revision",
  }));
}

function acceptedClaimReviews(reviews: AletheiaReviewRecord[]) {
  return new Set(
    reviews
      .filter(
        (review) => review.target_type === "claim" && review.tag === "accepted",
      )
      .map((review) => review.target_id),
  );
}

function agentOpsIssues(
  detail: AletheiaMatterDetail,
  issueMap: AletheiaWorkProductRecord | null,
): IssueNode[] {
  const acceptedClaims = acceptedClaimReviews(detail.reviews);

  if (issueMap) {
    return issueMapIssues(issueMap.content).map((issue) => {
      const hasAcceptedReview = acceptedClaims.has(issue.claimId);
      const needsReview =
        issue.reviewStatus === "needs_human_review" ||
        issue.supportSummary.contradicts > 0 ||
        issue.supportSummary.insufficient > 0;

      return {
        id: issue.id,
        matter_id: detail.matter.id,
        title: issue.title,
        description: [
          `Claim ${issue.claimId} has ${issue.supportSummary.supports} supporting, ${issue.supportSummary.contradicts} contradictory, and ${issue.supportSummary.insufficient} insufficient evidence item(s).`,
          issue.supportSummary.contradicts > 0
            ? "Conflicting evidence requires review."
            : undefined,
        ]
          .filter(Boolean)
          .join(" "),
        legal_or_professional_standard:
          "Professional review standard derived from source-linked issue map.",
        related_evidence_ids: issue.representativeQuotes.map(
          (quote) => quote.evidenceId,
        ),
        open_questions:
          hasAcceptedReview && !needsReview ? [] : issue.openQuestions,
        risk_level: needsReview ? "high" : agentOpsRiskLevel(detail.matter.risk_level),
        review_status: hasAcceptedReview
          ? "approved"
          : agentOpsReviewStatus(issue.reviewStatus),
      };
    });
  }

  const evidenceByClaim = new Map<string, EvidenceItem[]>();
  for (const item of agentOpsEvidence(detail)) {
    const claimId = item.supports_claim_ids[0] ?? `claim-${item.id}`;
    evidenceByClaim.set(claimId, [...(evidenceByClaim.get(claimId) ?? []), item]);
  }

  return Array.from(evidenceByClaim.entries()).map(([claimId, items]) => ({
    id: claimId,
    matter_id: detail.matter.id,
    title: titleize(claimId),
    description: items.map((item) => item.normalized_fact).join(" "),
    legal_or_professional_standard:
      "Professional review standard derived from persisted evidence.",
    related_evidence_ids: items.map((item) => item.id),
    open_questions: items.some((item) => item.review_status !== "approved")
      ? ["Resolve insufficient or contradictory evidence before final export."]
      : [],
    risk_level: items.some((item) => item.review_status !== "approved")
      ? "high"
      : agentOpsRiskLevel(detail.matter.risk_level),
    review_status: items.every((item) => item.review_status === "approved")
      ? "approved"
      : "needs_revision",
  }));
}

function agentOpsDraftMemo(
  detail: AletheiaMatterDetail,
  draftMemo: AletheiaWorkProductRecord,
  humanApproved: boolean,
): DraftMemo {
  return withComputedMemoCoverage({
    id: draftMemo.id,
    matter_id: detail.matter.id,
    title:
      typeof draftMemo.content.title === "string"
        ? draftMemo.content.title
        : draftMemo.title,
    sections: recordArray(draftMemo.content.sections).map((section, index) => {
      const evidenceIds = stringArray(section.evidenceIds);
      return {
        id: typeof section.id === "string" ? section.id : `memo-section-${index}`,
        title: typeof section.title === "string" ? section.title : "Memo Section",
        body: stringArray(section.body).join(" "),
        evidence_reference_ids: evidenceIds,
        unsupported_claim_count: evidenceIds.length === 0 ? 1 : 0,
      };
    }),
    citation_coverage_score: 0,
    unsupported_claim_count: 0,
    review_status: humanApproved ? "approved" : agentOpsReviewStatus(draftMemo.status),
    gate_status: "warning",
  });
}

function agentOpsRisks(issues: IssueNode[]): RiskItem[] {
  return issues.map((issue) => ({
    id: `risk-${issue.id}`,
    matter_id: issue.matter_id,
    title: `Risk: ${issue.title}`,
    description: issue.description,
    severity: issue.risk_level,
    likelihood: issue.open_questions.length > 0 ? "medium" : issue.risk_level,
    related_issue_ids: [issue.id],
    related_evidence_ids: issue.related_evidence_ids,
    recommendation:
      issue.open_questions.length > 0
        ? "Resolve open questions before final export."
        : "Preserve linked evidence and approval history with export.",
    status: issue.review_status === "approved" ? "mitigating" : "open",
  }));
}

function artifactTypeForReview(
  review: AletheiaReviewRecord,
): ReviewComment["artifact_type"] {
  if (review.target_type === "evidence") return "evidence_item";
  if (review.target_type === "claim") return "issue_node";
  if (review.target_type === "matter") return "matter";
  return "draft_memo";
}

function severityForReview(review: AletheiaReviewRecord): ReviewComment["severity"] {
  if (
    [
      "unsupported_claim",
      "citation_not_supporting",
      "conflicting_evidence",
      "needs_human_judgment",
      "rejected",
    ].includes(review.tag)
  ) {
    return "high";
  }
  if (review.tag === "missing_fact" || review.tag === "overclaim") {
    return "medium";
  }
  return "low";
}

function agentOpsReviewComments(detail: AletheiaMatterDetail): ReviewComment[] {
  return detail.reviews.map((review) => ({
    id: review.id,
    matter_id: review.matter_id,
    artifact_id: review.target_id,
    artifact_type: artifactTypeForReview(review),
    author: review.reviewer_name ?? review.reviewer_user_id ?? "Reviewer",
    comment: `${review.tag}: ${review.comment}`,
    severity: severityForReview(review),
    status: review.tag === "accepted" ? "resolved" : "open",
    created_at: review.created_at,
  }));
}

export function buildFinalMemoGateInput(args: {
  detail: AletheiaMatterDetail;
  draftMemo: AletheiaWorkProductRecord;
  issueMap: AletheiaWorkProductRecord | null;
  exportIntent: "final";
  humanApproved: boolean;
}): GateEngineInput {
  const issues = agentOpsIssues(args.detail, args.issueMap);
  return {
    matter: agentOpsMatter(args.detail),
    draftMemo: agentOpsDraftMemo(args.detail, args.draftMemo, args.humanApproved),
    evidence: agentOpsEvidence(args.detail),
    issues,
    risks: agentOpsRisks(issues),
    reviewComments: agentOpsReviewComments(args.detail),
    exportIntent: args.exportIntent,
    humanApproved: args.humanApproved,
  };
}

export function formatGateBlockMessage(gateResults: GateResult[]) {
  const failedGates = gateResults.filter((gate) => gate.status === "failed");
  if (failedGates.length === 0) return "";
  const reasons = failedGates
    .slice(0, 3)
    .map((gate) => `${titleize(gate.gate_type)}: ${gate.reason}`)
    .join(" ");
  return `Final memo export blocked by Trust Gates. ${reasons}`;
}
