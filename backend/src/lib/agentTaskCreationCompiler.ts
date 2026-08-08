import type { MatterContextManifestV1 } from "./agent-kernel/context/matterContext";
import {
  resolveAgentStepCapabilityGrant,
  WORK_TASK_HOST_TOOL_NAMES,
} from "./agent-kernel/capability/stepCapability";
import {
  buildAgentTaskContractCheckpoint,
  compileAgentGoalSpec,
  normalizeAgentTaskArtifactContracts,
} from "./agent-kernel/contracts/taskContract";
import { compileAgentStepContracts } from "./agent-kernel/contracts/stepContract";
import { buildServerOwnedTaskPlan } from "./agentTaskPlanner";
import { compileAgentTaskSourceAcquisition } from "./agentTaskSourceAcquisitionCompiler";

export function compileAgentTaskCreationContract(input: {
  goal: string;
  workflowId?: string;
  workflowType?: "assistant" | "tabular";
  fixedMatterContext: MatterContextManifestV1;
  sourceAcquisitionRequest?: unknown;
  createdAt?: string;
}) {
  const fixedWorkflow = input.fixedMatterContext.workflow;
  if (
    (input.workflowId ?? null) !== (fixedWorkflow?.id ?? null) ||
    (fixedWorkflow && input.workflowType !== fixedWorkflow.type)
  ) {
    throw new Error(
      "Task Workflow selection does not match the fixed Matter context",
    );
  }
  const serverPlan = buildServerOwnedTaskPlan({
    goal: input.goal,
    hasSources: input.fixedMatterContext.sources.length > 0,
    workflowId: input.workflowId,
    workflowType: input.workflowType,
  });
  const sourceAcquisition = compileAgentTaskSourceAcquisition({
    manifest: serverPlan.manifest,
    request: input.sourceAcquisitionRequest,
    documentCount: input.fixedMatterContext.sources.length,
  });
  const artifactContracts = normalizeAgentTaskArtifactContracts(
    serverPlan.plan.deliverables,
  );
  const goalSpec = compileAgentGoalSpec({
    objective: input.goal,
    taskFamily: serverPlan.taskFamily,
    artifactContracts,
    hasSources: input.fixedMatterContext.sources.length > 0,
    jurisdictions:
      sourceAcquisition?.jurisdictions ??
      serverPlan.manifest?.jurisdictions ??
      [],
    asOfDate: sourceAcquisition?.asOfDate,
    sourceStandard: serverPlan.manifest
      ? {
          material_claims_require_citations:
            serverPlan.manifest.source_standard
              .material_claims_require_citations,
          authority_required:
            serverPlan.manifest.source_standard.authority_required,
          authority_as_of_required:
            serverPlan.manifest.source_standard.authority_as_of_required,
        }
      : undefined,
    mustAskWhen: serverPlan.manifest?.must_ask_when,
    completionChecks: serverPlan.manifest?.completion_checks,
  });
  const stepContracts = compileAgentStepContracts({
    steps: serverPlan.plan.steps.map((step, index) => ({
      ...step,
      operation: serverPlan.stepOperations[index],
    })),
    goalSpec,
    artifactContracts,
    contextManifest: input.fixedMatterContext,
  });
  const capabilityGrants = stepContracts.steps.map((contract) =>
    resolveAgentStepCapabilityGrant({
      contract,
      availableToolNames: WORK_TASK_HOST_TOOL_NAMES,
      readOnlyConnectorPins:
        sourceAcquisition && contract.operation === "source.acquire"
          ? [sourceAcquisition.pin]
          : [],
    }),
  );
  const taskContractCheckpoint = buildAgentTaskContractCheckpoint({
    goalSpec,
    contextManifest: input.fixedMatterContext,
    stepContracts,
    capabilityGrants,
    createdAt: input.createdAt,
  });
  return {
    plan: serverPlan.plan,
    manifest: serverPlan.manifest,
    taskFamily: serverPlan.taskFamily,
    artifactContracts,
    goalSpec,
    stepContracts,
    capabilityGrants,
    sourceAcquisition,
    initialCheckpoint: sourceAcquisition
      ? {
          ...taskContractCheckpoint,
          source_acquisition: sourceAcquisition.state,
        }
      : taskContractCheckpoint,
  };
}
