import type {
  AgentVerificationPacketV1,
  AgentVerificationResultV1,
} from "./verifierCore";

export type AgentVerificationRepairDecisionV1 =
  | { kind: "none"; reason: "clean_pass" }
  | {
      kind: "citation_marker_patch";
      deliverableKey: string;
      documentId: string;
      versionId: string;
    }
  | {
      kind: "bounded_artifact_create";
      deliverableKey: string;
      artifactType: "draft" | "tabular_review";
    }
  | {
      kind: "bounded_artifact_edit";
      deliverableKey: string;
      documentId: string;
      versionId: string;
      goalExcerpt: string;
    }
  | {
      kind: "review_required";
      reason:
        | "repair_already_attempted"
        | "profile_disallows_repair"
        | "multiple_or_unrepairable_gaps"
        | "unbound_artifact";
    };

export function decideAgentVerificationRepairV1(input: {
  packet: AgentVerificationPacketV1;
  result: AgentVerificationResultV1;
  repairAlreadyAttempted: boolean;
}): AgentVerificationRepairDecisionV1 {
  if (input.result.outcome === "clean_pass") {
    return { kind: "none", reason: "clean_pass" };
  }
  if (input.repairAlreadyAttempted) {
    return { kind: "review_required", reason: "repair_already_attempted" };
  }
  if (input.result.issues.length !== 1) {
    return {
      kind: "review_required",
      reason: "multiple_or_unrepairable_gaps",
    };
  }
  const merged = input.result.issues[0];
  if (
    merged.origin === "deterministic" &&
    merged.issue.code === "citation_marker_gap"
  ) {
    return {
      kind: "citation_marker_patch",
      deliverableKey: merged.issue.deliverable_key,
      documentId: merged.issue.document_id,
      versionId: merged.issue.version_id,
    };
  }
  if (input.packet.profile.repair_policy !== "one_bound_artifact") {
    return { kind: "review_required", reason: "profile_disallows_repair" };
  }
  if (
    merged.origin === "deterministic" &&
    merged.issue.code === "artifact_missing"
  ) {
    return {
      kind: "bounded_artifact_create",
      deliverableKey: merged.issue.deliverable_key,
      artifactType: merged.issue.artifact_type,
    };
  }
  if (merged.origin === "semantic") {
    const deliverable = input.packet.deliverables.find(
      (candidate) => candidate.key === merged.issue.deliverable_key,
    );
    if (!deliverable?.document_id || !deliverable.current_version_id) {
      return { kind: "review_required", reason: "unbound_artifact" };
    }
    return {
      kind: "bounded_artifact_edit",
      deliverableKey: deliverable.key,
      documentId: deliverable.document_id,
      versionId: deliverable.current_version_id,
      goalExcerpt: merged.issue.goal_excerpt,
    };
  }
  return {
    kind: "review_required",
    reason: "multiple_or_unrepairable_gaps",
  };
}

type ExecutableRepairDecision = Exclude<
  AgentVerificationRepairDecisionV1,
  { kind: "none" | "review_required" }
>;

/**
 * Coordinates at most one server-authorized repair and one fresh verification.
 * The coordinator never turns verification into approval/export and never
 * attempts a second repair when the recheck still has a gap.
 */
export async function coordinateOneAgentVerificationRepairV1(input: {
  packet: AgentVerificationPacketV1;
  result: AgentVerificationResultV1;
  repairAlreadyAttempted: boolean;
  executeRepair: (decision: ExecutableRepairDecision) => Promise<void>;
  recheck: () => Promise<{
    packet: AgentVerificationPacketV1;
    result: AgentVerificationResultV1;
  }>;
}) {
  const decision = decideAgentVerificationRepairV1(input);
  if (decision.kind === "none" || decision.kind === "review_required") {
    return { decision, packet: input.packet, result: input.result };
  }
  await input.executeRepair(decision);
  const rechecked = await input.recheck();
  return {
    decision:
      rechecked.result.outcome === "clean_pass"
        ? ({ kind: "none", reason: "clean_pass" } as const)
        : ({
            kind: "review_required",
            reason: "repair_already_attempted",
          } as const),
    ...rechecked,
  };
}
