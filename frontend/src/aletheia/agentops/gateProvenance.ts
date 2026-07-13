import type {
  AletheiaAuditEventRecord,
  AletheiaMatterDetail,
  AletheiaReviewRecord,
  AletheiaWorkProductRecord,
} from "@/app/lib/aletheiaApi";
import type { computeWorkspaceEvalMetrics } from "@/lib/agentops/eval";
import type {
  adaptAletheiaMatterDetailToAgentOpsWorkspace,
  summarizeAdapterProvenance,
} from "./adapters";
import {
  auditCandidatesFromResolutions,
  type resolveBigAtReferences,
} from "./references";

export type GateProvenance = {
  gateId: string;
  gateType: string;
  status: string;
  sourceType: "human_checkpoint" | "work_product_validation" | "unknown";
  sourceId: string | null;
  sourceStatus: string;
  relatedWorkProductIds: string[];
  relatedReviewIds: string[];
  relatedAuditEventIds: string[];
};

type AgentOpsWorkspace = ReturnType<
  typeof adaptAletheiaMatterDetailToAgentOpsWorkspace
>;
type AdapterProvenance = ReturnType<typeof summarizeAdapterProvenance>;
type ReferenceResolutions = ReturnType<typeof resolveBigAtReferences>;
type EvalMetrics = NonNullable<ReturnType<typeof computeWorkspaceEvalMetrics>>;

function hasStringField(
  value: Record<string, unknown>,
  field: string,
  expected: string,
) {
  return typeof value[field] === "string" && value[field] === expected;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function relatedReviewsForArtifacts(
  reviews: AletheiaReviewRecord[],
  artifactIds: string[],
) {
  const artifactSet = new Set(artifactIds);
  return reviews.filter(
    (review) =>
      artifactSet.has(review.target_id) ||
      (review.work_product_id
        ? artifactSet.has(review.work_product_id)
        : false) ||
      (review.evidence_item_id
        ? artifactSet.has(review.evidence_item_id)
        : false),
  );
}

function relatedAuditEventsForArtifacts(
  auditEvents: AletheiaAuditEventRecord[],
  artifactIds: string[],
) {
  const artifactSet = new Set(artifactIds);
  return auditEvents.filter((event) => {
    const details = event.details;
    return (
      (typeof details.workProductId === "string" &&
        artifactSet.has(details.workProductId)) ||
      (typeof details.artifactId === "string" &&
        artifactSet.has(details.artifactId)) ||
      (typeof details.evidenceId === "string" &&
        artifactSet.has(details.evidenceId))
    );
  });
}

export function buildGateProvenance({
  detail,
  workspace,
}: {
  detail: AletheiaMatterDetail;
  workspace: AgentOpsWorkspace;
}): GateProvenance[] {
  const checkpoints = (detail.agentRuns ?? []).flatMap(
    (run) => run.human_checkpoints ?? [],
  );
  const workProductsById = new Map(
    detail.workProducts.map((item): [string, AletheiaWorkProductRecord] => [
      item.id,
      item,
    ]),
  );

  return workspace.gate_results.map((gate) => {
    if (gate.id.startsWith("gate-checkpoint-")) {
      const checkpointId = gate.id.slice("gate-checkpoint-".length);
      const checkpoint = checkpoints.find((item) => item.id === checkpointId);
      const requestedPayload = checkpoint?.requested_payload ?? {};
      const relatedWorkProductIds = uniqueStrings([
        typeof requestedPayload.workProductId === "string"
          ? requestedPayload.workProductId
          : null,
        ...gate.affected_artifact_ids,
      ]);
      const relatedReviews = relatedReviewsForArtifacts(
        detail.reviews,
        relatedWorkProductIds,
      );
      const checkpointAuditEvents = detail.auditEvents.filter(
        (event) =>
          hasStringField(event.details, "checkpointId", checkpointId) ||
          (checkpoint?.checkpoint_type
            ? hasStringField(
                event.details,
                "action",
                checkpoint.checkpoint_type,
              )
            : false),
      );
      const artifactAuditEvents = relatedAuditEventsForArtifacts(
        detail.auditEvents,
        relatedWorkProductIds,
      );

      return {
        gateId: gate.id,
        gateType: gate.gate_type,
        status: gate.status,
        sourceType: "human_checkpoint",
        sourceId: checkpoint?.id ?? null,
        sourceStatus: checkpoint?.status ?? "missing",
        relatedWorkProductIds,
        relatedReviewIds: relatedReviews.map((review) => review.id),
        relatedAuditEventIds: uniqueStrings([
          ...checkpointAuditEvents.map((event) => event.id),
          ...artifactAuditEvents.map((event) => event.id),
        ]),
      };
    }

    const relatedWorkProductIds = gate.affected_artifact_ids.filter((id) =>
      workProductsById.has(id),
    );
    const workProduct = relatedWorkProductIds[0]
      ? workProductsById.get(relatedWorkProductIds[0])
      : undefined;
    const relatedReviews = relatedReviewsForArtifacts(
      detail.reviews,
      gate.affected_artifact_ids,
    );
    const relatedAuditEvents = relatedAuditEventsForArtifacts(
      detail.auditEvents,
      gate.affected_artifact_ids,
    );

    return {
      gateId: gate.id,
      gateType: gate.gate_type,
      status: gate.status,
      sourceType: workProduct ? "work_product_validation" : "unknown",
      sourceId: workProduct?.id ?? null,
      sourceStatus: workProduct
        ? `${workProduct.status}; ${workProduct.validation_errors.length} validation errors`
        : "missing",
      relatedWorkProductIds,
      relatedReviewIds: relatedReviews.map((review) => review.id),
      relatedAuditEventIds: relatedAuditEvents.map((event) => event.id),
    };
  });
}

export function buildAgentOpsSnapshotDetails({
  workspace,
  provenance,
  gateProvenance,
  referenceResolutions,
  evalMetrics,
}: {
  workspace: AgentOpsWorkspace;
  provenance: AdapterProvenance;
  gateProvenance: GateProvenance[];
  referenceResolutions: ReferenceResolutions;
  evalMetrics: EvalMetrics;
}) {
  return {
    adapter: "aletheia-matter-detail-to-agentops-workspace",
    adapterVersion: "view-v0",
    sourceOfTruth: "aletheia_matter_records",
    matterId: workspace.matter.id,
    artifactCounts: {
      documents: workspace.matter.documents.length,
      runs: workspace.runs.length,
      evidence: workspace.evidence.length,
      issues: workspace.issues.length,
      risks: workspace.risks.length,
      draftMemos: workspace.draft_memos.length,
      reviews: workspace.review_comments.length,
      gates: workspace.gate_results.length,
      auditEvents: workspace.audit_events.length,
      evalCases: workspace.eval_cases.length,
      skills: workspace.skills.length,
    },
    provenance,
    evidenceLinks: workspace.evidence.map((item) => ({
      evidenceId: item.id,
      documentId: item.source_document_id,
      sourceChunkId: item.source_chunk_id ?? null,
      claimIds: item.supports_claim_ids,
      quoteStart: item.quote_start ?? null,
      quoteEnd: item.quote_end ?? null,
      supportStatus: item.support_status ?? null,
    })),
    gateResults: workspace.gate_results.map((gate) => ({
      gateId: gate.id,
      gateType: gate.gate_type,
      status: gate.status,
      affectedArtifactIds: gate.affected_artifact_ids,
    })),
    gateProvenance,
    referenceAuditCandidates: auditCandidatesFromResolutions(
      referenceResolutions,
      {
        artifact_type: "matter_memory",
        id: workspace.matter.id,
      },
    ),
    referenceResults: referenceResolutions.map((resolution) => ({
      raw: resolution.reference.raw,
      type: resolution.reference.type,
      status: resolution.status,
      matchIds: resolution.matches.map((match) => match.id),
      resolvedArtifactRefs:
        resolution.status === "resolved"
          ? resolution.matches
              .map((match) => match.artifact_ref)
              .filter((artifactRef) => Boolean(artifactRef))
          : [],
      candidateArtifactRefs:
        resolution.status === "ambiguous"
          ? resolution.matches
              .map((match) => match.artifact_ref)
              .filter((artifactRef) => Boolean(artifactRef))
          : [],
      metadata: resolution.matches[0]?.metadata ?? null,
    })),
    evalMetrics,
    note: "This event records an adapter-derived AgentOps view snapshot; persisted Vera matter, evidence, review, gate, run, and audit records remain the source of truth.",
  };
}
