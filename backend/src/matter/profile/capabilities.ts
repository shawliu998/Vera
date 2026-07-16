import type {
  InferenceDecision,
  InferenceOperation,
  InferencePolicyPort,
  InferenceScope,
} from "../../lib/workspace/inferencePolicy";
import type { StoredModelProfileRecord } from "../../lib/workspace/repositories/modelProfiles";
import {
  matterProfilePresentation,
  type MatterCapabilities,
  type MatterProfile,
} from "./contracts";

type ProjectCapabilityInput = Readonly<{
  id: string;
  status: "active" | "archived" | "deleted";
  defaultModelProfileId: string | null;
  defaultModelReady: boolean;
  effectiveModelProvider: StoredModelProfileRecord["provider"] | null;
  effectiveModelCapabilities: Readonly<{
    streaming: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
  }> | null;
}>;

export interface MatterModelRuntimeCapabilityPort {
  runtimeWired(): boolean;
  capabilitiesFor(provider: StoredModelProfileRecord["provider"]): Readonly<{
    streaming: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
  }> | null;
}

export interface MatterCapabilityReadPort {
  project(
    project: ProjectCapabilityInput,
    profile: MatterProfile | null,
  ): MatterCapabilities;
}

function decisionKind(decision: InferenceDecision) {
  return decision.decision;
}

/** Side-effect-free projection adapter over the single Workspace policy. */
export class MatterCapabilityProjector implements MatterCapabilityReadPort {
  constructor(
    private readonly policy: InferencePolicyPort,
    private readonly runtime: MatterModelRuntimeCapabilityPort | null = null,
  ) {}

  project(
    project: ProjectCapabilityInput,
    profile: MatterProfile | null,
  ): MatterCapabilities {
    if (
      project.status !== "active" ||
      !project.defaultModelReady ||
      project.defaultModelProfileId === null ||
      project.effectiveModelProvider === null ||
      project.effectiveModelCapabilities === null ||
      profile?.workspaceType === null
    ) {
      return matterProfilePresentation(project.status, profile).capabilities;
    }
    const scope: InferenceScope =
      profile === null
        ? {
            scope: "project",
            projectId: project.id,
            matterProfilePresent: false,
          }
        : {
            scope: "matter",
            projectId: project.id,
            matterProfilePresent: true,
          };
    const evaluate = (operation: InferenceOperation) => {
      try {
        return decisionKind(
          this.policy.evaluate({
            scope,
            modelProfileId: project.defaultModelProfileId!,
            operation,
          }),
        );
      } catch {
        return "deny" as const;
      }
    };
    const projected = matterProfilePresentation(project.status, profile, {
      assistant: evaluate("assistant"),
      workflows: evaluate("workflow_prompt"),
      tabular: evaluate("tabular_generation"),
    }).capabilities;
    const runtime = this.runtime?.runtimeWired() === false
      ? null
      : this.runtime?.capabilitiesFor(project.effectiveModelProvider) ??
        project.effectiveModelCapabilities;
    const assistantReady = Boolean(
      runtime?.streaming &&
        runtime.toolCalling &&
        project.effectiveModelCapabilities.streaming &&
        project.effectiveModelCapabilities.toolCalling,
    );
    const tabularReady = Boolean(
      runtime?.streaming &&
        runtime.structuredOutput &&
        project.effectiveModelCapabilities.streaming &&
        project.effectiveModelCapabilities.structuredOutput,
    );
    return {
      ...projected,
      assistant: assistantReady ? projected.assistant : "unavailable",
      workflows: assistantReady ? projected.workflows : "non_inference_only",
      tabular: tabularReady ? projected.tabular : "unavailable",
    };
  }
}
