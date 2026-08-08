import { z } from "zod";

import {
  cleanSemanticVerifierResult,
  mergeAgentVerificationResultV1,
  type AgentVerificationPacketV1,
  type AgentVerificationResultV1,
} from "./verifierCore";
import {
  detectArtifactIncompleteEnding,
} from "./verifierCore";

export const AGENT_VERIFICATION_REPAIR_KEY =
  "agent_verification_repair" as const;

export const ARTIFACT_INCOMPLETE_ENDING_REPAIR_INSTRUCTION =
  "Complete the abrupt trailing sentence and the remainder required by the fixed Task goal. Preserve all supported current text and keep unknown or unresolved evidence explicit." as const;

const verificationRepairReceiptSchema = z
  .object({
    kind: z.literal("agent_verification_repair_v1"),
    task_id: z.string().uuid(),
    step_id: z.string().trim().min(1).max(200),
    step_attempt: z.number().int().min(1),
    issue_code: z.enum([
      "semantic_goal_omission",
      "artifact_incomplete_ending",
    ]),
    deliverable_key: z.string().trim().min(1).max(120),
    document_id: z.string().uuid(),
    base_version_id: z.string().uuid(),
    target_version_id: z.string().uuid(),
    accepted_view_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    goal_excerpt: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type AgentVerificationRepairReceiptV1 = z.infer<
  typeof verificationRepairReceiptSchema
>;

export function buildAgentVerificationRepairReceiptV1(
  input: AgentVerificationRepairReceiptV1,
) {
  return verificationRepairReceiptSchema.parse(input);
}

export function readAgentVerificationRepairReceiptV1(checkpoint: unknown):
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "valid"; receipt: AgentVerificationRepairReceiptV1 } {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { state: "absent" };
  }
  const row = checkpoint as Record<string, unknown>;
  if (!Object.hasOwn(row, AGENT_VERIFICATION_REPAIR_KEY)) {
    return { state: "absent" };
  }
  const parsed = verificationRepairReceiptSchema.safeParse(
    row[AGENT_VERIFICATION_REPAIR_KEY],
  );
  return parsed.success
    ? { state: "valid", receipt: parsed.data }
    : { state: "invalid" };
}

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
      issueCode: "semantic_goal_omission" | "artifact_incomplete_ending";
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
  // A bounded-projection observation says only that the model did not receive
  // the complete accepted-view. It remains visible to the lawyer, but it must
  // not hide an otherwise unique, fixed semantic repair target.
  const actionableIssues = input.result.issues.filter(
    (merged) =>
      !(
        merged.origin === "deterministic" &&
        merged.issue.code === "verification_scope_exceeded"
      ),
  );
  if (actionableIssues.length !== 1) {
    return {
      kind: "review_required",
      reason: "multiple_or_unrepairable_gaps",
    };
  }
  const merged = actionableIssues[0]!;
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
      issueCode: "semantic_goal_omission",
      goalExcerpt: merged.issue.goal_excerpt,
    };
  }
  if (
    merged.origin === "deterministic" &&
    merged.issue.code === "artifact_incomplete_ending"
  ) {
    const incompleteEndingIssue = merged.issue;
    const deliverable = input.packet.deliverables.find(
      (candidate) => candidate.key === incompleteEndingIssue.deliverable_key,
    );
    if (
      deliverable?.artifact_type !== "draft" ||
      deliverable.document_id !== incompleteEndingIssue.document_id ||
      deliverable.current_version_id !== incompleteEndingIssue.version_id ||
      deliverable.accepted_view_sha256 !==
        incompleteEndingIssue.accepted_view_sha256 ||
      !deliverable.accepted_view_complete ||
      !deliverable.accepted_view_text ||
      detectArtifactIncompleteEnding(deliverable.accepted_view_text) !==
        incompleteEndingIssue.ending_excerpt
    ) {
      return { kind: "review_required", reason: "unbound_artifact" };
    }
    return {
      kind: "bounded_artifact_edit",
      deliverableKey: deliverable.key,
      documentId: deliverable.document_id,
      versionId: deliverable.current_version_id,
      issueCode: "artifact_incomplete_ending",
      goalExcerpt: ARTIFACT_INCOMPLETE_ENDING_REPAIR_INSTRUCTION,
    };
  }
  return {
    kind: "review_required",
    reason: "multiple_or_unrepairable_gaps",
  };
}

/**
 * A server-bound deterministic repair must not depend on a provider first
 * repeating the same observation as valid JSON. The fresh semantic verifier
 * still runs after the one bounded repair and therefore retains final goal
 * coverage responsibility.
 */
export function canStartDeterministicAgentVerificationRepairV1(
  packet: AgentVerificationPacketV1,
) {
  const result = mergeAgentVerificationResultV1({
    packet,
    semanticResult: cleanSemanticVerifierResult(),
  });
  const decision = decideAgentVerificationRepairV1({
    packet,
    result,
    repairAlreadyAttempted: false,
  });
  return (
    decision.kind === "bounded_artifact_edit" &&
    decision.issueCode === "artifact_incomplete_ending"
  );
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
