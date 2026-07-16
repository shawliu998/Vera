import { WorkspaceApiError } from "../lib/workspace/errors";
import type { WorkspaceDatabaseAdapter } from "../lib/workspace/migrations";
import type {
  AssistantModelToolCall,
  AssistantToolContext,
  AssistantToolPort,
} from "../lib/workspace/services/assistantRuntime";
import type {
  WorkflowPreparedStepInput,
  WorkflowStepExecutionResult,
  WorkflowStepExecutor,
} from "../lib/workspace/services/workflowRuntime";
import { WorkspaceIdSchema } from "../lib/workspace/workspacePersistencePrimitivesV1";

export const MATTER_INFERENCE_POLICY_MESSAGE =
  "Matter inference is unavailable until a policy is configured.";

/**
 * Gate 1 inference boundary. Generic Projects and the global Assistant retain
 * their existing Workspace behavior, while any Project that has explicitly
 * acquired a Matter Profile fails closed until Gate 3 installs the policy
 * resolver. The check runs synchronously at the final provider boundary so a
 * deep link, stale UI, or queued job cannot bypass it.
 */
export class MatterInferencePolicyGate {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  state(
    projectId: string | null,
  ): "workspace_compatibility" | "policy_gate_closed" {
    if (projectId === null) return "workspace_compatibility";
    const parsed = WorkspaceIdSchema.safeParse(projectId);
    if (!parsed.success) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        MATTER_INFERENCE_POLICY_MESSAGE,
      );
    }
    const profile = this.database
      .prepare("SELECT 1 AS present FROM matter_profiles WHERE project_id = ?")
      .get(parsed.data) as { present?: unknown } | undefined;
    return profile ? "policy_gate_closed" : "workspace_compatibility";
  }

  assertProjectModelUse(projectId: string | null): void {
    if (this.state(projectId) === "policy_gate_closed") {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        MATTER_INFERENCE_POLICY_MESSAGE,
      );
    }
  }
}

/** Keeps the policy check in front of every Assistant model round. */
export class MatterPolicyAssistantToolPort implements AssistantToolPort {
  constructor(
    private readonly delegate: AssistantToolPort,
    private readonly policy: Pick<MatterInferencePolicyGate, "assertProjectModelUse">,
  ) {}

  async assertModelUse(context: AssistantToolContext): Promise<void> {
    this.policy.assertProjectModelUse(context.projectId);
    await this.delegate.assertModelUse?.(context);
  }

  registeredTools(context: AssistantToolContext) {
    return this.delegate.registeredTools(context);
  }

  execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }) {
    return this.delegate.execute(input);
  }
}

/** Blocks only model-producing Workflow steps; retrieval/output stay usable. */
export class MatterPolicyWorkflowStepExecutor implements WorkflowStepExecutor {
  constructor(
    private readonly delegate: WorkflowStepExecutor,
    private readonly policy: Pick<MatterInferencePolicyGate, "assertProjectModelUse">,
  ) {}

  prepareStep(input: Parameters<NonNullable<WorkflowStepExecutor["prepareStep"]>>[0]):
    | WorkflowPreparedStepInput
    | Promise<WorkflowPreparedStepInput> {
    return this.delegate.prepareStep
      ? this.delegate.prepareStep(input)
      : { status: "ready", input: {} };
  }

  executeStep(
    input: Parameters<WorkflowStepExecutor["executeStep"]>[0],
  ): WorkflowStepExecutionResult | Promise<WorkflowStepExecutionResult> {
    if (input.step.kind === "prompt") {
      this.policy.assertProjectModelUse(input.snapshot.projectId);
    }
    return this.delegate.executeStep(input);
  }
}
