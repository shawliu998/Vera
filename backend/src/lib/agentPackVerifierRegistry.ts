import {
  CONTRACT_PLAYBOOK_PACK_PROFILE_ID,
  CONTRACT_PLAYBOOK_PACK_VERSION,
  verifyContractPlaybookPack,
} from "./agent-packs/contract/contractPlaybookPack";
import type {
  AgentVerificationPacketV1,
  AgentVerifierProfileV1,
} from "./agent-kernel/verification/verifierCore";
import { SYSTEM_SKILL_MANIFEST_BY_WORKFLOW_ID } from "./systemWorkflows";

type PlanStep = { result_data?: unknown };
type Deliverable = AgentVerificationPacketV1["deliverables"][number];
type DeterministicCheck =
  AgentVerificationPacketV1["deterministic_checks"][number];

const ONE_BOUND_ARTIFACT_REPAIR_PROFILES = new Set([
  "work_task_source_citation_v1",
  CONTRACT_PLAYBOOK_PACK_PROFILE_ID,
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveAgentVerifierProfile(
  workflowId: string | null,
): AgentVerifierProfileV1 {
  const profileId = workflowId
    ? SYSTEM_SKILL_MANIFEST_BY_WORKFLOW_ID.get(workflowId)?.verifier_profile
    : null;
  return {
    kind: "agent_verifier_profile_v1",
    id: profileId ?? "generic-current-artifact",
    version:
      profileId === CONTRACT_PLAYBOOK_PACK_PROFILE_ID
        ? CONTRACT_PLAYBOOK_PACK_VERSION
        : "1",
    semantic_goal_check: true,
    repair_policy:
      profileId && ONE_BOUND_ARTIFACT_REPAIR_PROFILES.has(profileId)
        ? "one_bound_artifact"
        : "none",
  };
}

function contractPlaybookReceipt(currentPlan: PlanStep[], checkpoint: unknown) {
  const stepCandidates = currentPlan.flatMap((step) => {
    const result = record(step.result_data);
    return result && Object.hasOwn(result, "contract_playbook_pack_receipt")
      ? [result.contract_playbook_pack_receipt]
      : [];
  });
  const checkpointRow = record(checkpoint);
  const candidates = [
    ...stepCandidates,
    ...(checkpointRow &&
    Object.hasOwn(checkpointRow, "contract_playbook_pack_receipt")
      ? [checkpointRow.contract_playbook_pack_receipt]
      : []),
  ].filter(
    (candidate, index, all) =>
      all.findIndex(
        (other) => JSON.stringify(other) === JSON.stringify(candidate),
      ) === index,
  );
  if (candidates.length === 0) return null;
  return candidates.length === 1 ? candidates[0] : candidates;
}

export function buildAgentPackDeterministicChecks(input: {
  profile: AgentVerifierProfileV1;
  currentPlan: PlanStep[];
  checkpoint?: unknown;
  deliverables: Deliverable[];
}): DeterministicCheck[] {
  if (input.profile.id !== CONTRACT_PLAYBOOK_PACK_PROFILE_ID) return [];
  const opinions = input.deliverables.filter(
    (deliverable) => deliverable.key === "review-opinion",
  );
  const opinion = opinions.length === 1 ? opinions[0] : null;
  const result = verifyContractPlaybookPack({
    receipt: contractPlaybookReceipt(input.currentPlan, input.checkpoint),
    reviewOpinionText:
      opinion?.accepted_view_complete === true
        ? opinion.accepted_view_text
        : null,
  });
  if (result.status === "pass") {
    return [
      {
        code: "contract-playbook-pack",
        dimension: "workflow_completion",
        status: "pass",
        detail:
          "The fixed Contract Playbook receipt, lawyer dispositions, and current review opinion align.",
        issue: null,
      },
    ];
  }
  return [
    {
      code: "contract-playbook-pack",
      dimension: "workflow_completion",
      status: "gap",
      detail: `Contract Playbook verification preserved the current deliverables and found ${result.issues.length} structured review gap(s).`,
      issue: {
        code: "pack_check_gap",
        profile_id: CONTRACT_PLAYBOOK_PACK_PROFILE_ID,
        check_code: "contract_playbook_receipt_and_opinion_alignment",
        facts: { issues: result.issues },
      },
    },
  ];
}
