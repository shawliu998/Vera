import type { Document } from "@/app/components/shared/types";
import type {
  AgentArtifactLink,
  AgentCurrentArtifactVersion,
  AgentDeliverable,
  AgentReviewDecision,
  AgentStep,
  AgentTaskSnapshot,
  ApprovedArtifactSnapshot,
} from "@/app/types/agent";

export interface AgentTaskOutputRow {
  key: string;
  label: string;
  detail: string;
  version: number | null;
  currentVersion: AgentCurrentArtifactVersion | null;
  approvedArtifact: ApprovedArtifactSnapshot | null;
  linkedArtifact: AgentArtifactLink | null;
}

export function agentTaskOutputCanOpen(output: AgentTaskOutputRow) {
  if (!output.linkedArtifact) return false;
  if (output.linkedArtifact.artifact_type === "tabular_review") return true;
  return output.currentVersion?.current_version_available !== false;
}

export type AgentTaskProviderPause = {
  classification:
    | "provider_capacity"
    | "provider_timeout"
    | "provider_network"
    | "provider_protocol"
    | "provider_structured_output"
    | "provider_configuration";
  issueCode:
    | "provider_capacity_exhausted"
    | "provider_timeout_exhausted"
    | "provider_network_exhausted"
    | "provider_protocol_incompatible"
    | "provider_structured_output_invalid"
    | "provider_configuration_required";
  connectorId: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const PROVIDER_PAUSE_CODES = new Set([
  "provider_capacity_exhausted",
  "provider_timeout_exhausted",
  "provider_network_exhausted",
  "provider_protocol_incompatible",
  "provider_structured_output_invalid",
  "provider_configuration_required",
]);

const PROVIDER_PAUSE_CLASSIFICATIONS = new Set([
  "provider_capacity",
  "provider_timeout",
  "provider_network",
  "provider_protocol",
  "provider_structured_output",
  "provider_configuration",
]);

export function getAgentTaskProviderPause(
  checkpoint: AgentTaskSnapshot["task"]["latest_checkpoint"],
): AgentTaskProviderPause | null {
  const pause = record(checkpoint?.execution_pause);
  const issue = record(pause?.issue);
  if (
    pause?.kind !== "agent_task_execution_pause_v1" ||
    !PROVIDER_PAUSE_CLASSIFICATIONS.has(String(pause.classification)) ||
    issue?.kind !== "agent_execution_issue_v1" ||
    issue.category !== "provider" ||
    issue.recoverable !== true ||
    !PROVIDER_PAUSE_CODES.has(String(issue.code))
  ) {
    return null;
  }

  const acquisition = record(checkpoint?.source_acquisition);
  const spec = record(acquisition?.spec);
  return {
    classification: pause.classification as AgentTaskProviderPause["classification"],
    issueCode: issue.code as AgentTaskProviderPause["issueCode"],
    connectorId:
      typeof spec?.connector_id === "string" ? spec.connector_id : null,
  };
}

export function agentTaskWorkTitle(snapshot: AgentTaskSnapshot): string {
  const { task } = snapshot;
  const completedCount = task.current_plan.filter(
    (step) => step.status === "completed",
  ).length;
  const recoveryBlocked =
    ["paused", "failed", "waiting_input"].includes(task.status) &&
    !canRecoverAgentTaskExecution(snapshot);
  const current = task.current_plan.find((step) => step.status === "running");

  if (task.status === "completed") {
    return `Completed in ${completedCount} steps`;
  }
  if (recoveryBlocked) return "Work preserved · new task required";
  if (task.status === "paused") {
    return current ? `Paused · ${current.title}` : "Work paused";
  }
  if (task.status === "waiting_input") return "Input required";
  if (task.status === "failed") return "Work stopped";
  if (current) return `Working · ${current.title}`;
  return "Ready to work";
}

export function canRecoverAgentTaskExecution(snapshot: AgentTaskSnapshot) {
  return snapshot.execution_recovery.allowed;
}

export function agentDeliverablePurpose(deliverable: AgentDeliverable): string {
  return (
    deliverable.purpose ??
    (deliverable.key === "risk-matrix"
      ? "Risk matrix"
      : deliverable.key === "review-memo"
        ? "Review memo draft"
        : deliverable.title)
  );
}

export function latestApprovedArtifact(
  snapshot: AgentTaskSnapshot,
  artifactId: string,
): ApprovedArtifactSnapshot | null {
  const decision = latestApprovedReviewDecision(snapshot);
  return (
    decision?.artifact_snapshot.find(
      (artifact) => artifact.artifact_id === artifactId,
    ) ?? null
  );
}

export function latestApprovedReviewDecision(
  snapshot: AgentTaskSnapshot,
): AgentReviewDecision | null {
  return (
    [...snapshot.review.decisions]
      .reverse()
      .find((item) => item.status === "approved") ?? null
  );
}

export function buildAgentTaskOutputRows(
  snapshot: AgentTaskSnapshot,
): AgentTaskOutputRow[] {
  const versionByArtifact = new Map(
    snapshot.review.version_state.current_artifacts.map((artifact) => [
      artifact.artifact_id,
      artifact,
    ]),
  );

  return snapshot.task.deliverables
    .filter((deliverable) => deliverable.required)
    .map((deliverable) => {
      const purpose = agentDeliverablePurpose(deliverable);
      const linkedArtifact =
        snapshot.artifacts.find(
          (artifact) => artifact.artifact_id === deliverable.artifact_id,
        ) ??
        [...snapshot.artifacts]
          .reverse()
          .find(
            (artifact) =>
              artifact.purpose === purpose &&
              (!deliverable.artifact_type ||
                artifact.artifact_type === deliverable.artifact_type),
          ) ??
        null;
      const currentVersion = linkedArtifact
        ? (versionByArtifact.get(linkedArtifact.artifact_id) ?? null)
        : null;
      return {
        key: deliverable.key,
        label: deliverable.title,
        detail:
          currentVersion?.current_filename ??
          (deliverable.artifact_type === "tabular_review"
            ? "Excel workbook"
            : "Word document"),
        version: currentVersion?.current_version_number ?? null,
        currentVersion,
        approvedArtifact: linkedArtifact
          ? latestApprovedArtifact(snapshot, linkedArtifact.artifact_id)
          : null,
        linkedArtifact,
      };
    });
}

export function getAgentTaskSourceDocuments(
  snapshot: AgentTaskSnapshot,
  documents: Document[],
): Document[] {
  const sourceIds = new Set(
    snapshot.artifacts
      .filter((artifact) => artifact.purpose === "Source document")
      .map((artifact) => artifact.artifact_id),
  );
  return documents.filter((document) => sourceIds.has(document.id));
}

export function getAgentTaskSupportingArtifacts(
  snapshot: AgentTaskSnapshot,
): AgentArtifactLink[] {
  return snapshot.artifacts.filter(
    (artifact) =>
      artifact.artifact_type === "chat" ||
      artifact.artifact_type === "workflow_run",
  );
}

export function getAgentTaskStepArtifacts(
  snapshot: AgentTaskSnapshot,
  step: AgentStep,
  stepIndex: number,
): AgentArtifactLink[] {
  const evidencePurpose = `Step ${stepIndex + 1} evidence citations`;
  const latestEvidence = [...snapshot.artifacts]
    .reverse()
    .find(
      (artifact) =>
        artifact.artifact_type === "citation_snapshot" &&
        artifact.purpose === evidencePurpose,
    );
  const stepText = `${step.title} ${step.expected_output}`.toLowerCase();

  return snapshot.artifacts.filter((artifact) => {
    if (artifact.artifact_id === latestEvidence?.artifact_id) return true;
    return snapshot.task.deliverables.some((deliverable) => {
      const purpose = agentDeliverablePurpose(deliverable);
      return (
        (deliverable.artifact_id === artifact.artifact_id ||
          artifact.purpose === purpose) &&
        (stepText.includes(deliverable.title.toLowerCase()) ||
          stepText.includes(purpose.toLowerCase()))
      );
    });
  });
}
