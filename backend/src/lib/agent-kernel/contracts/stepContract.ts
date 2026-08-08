import { z } from "zod";

import type {
  AgentGoalSpecV1,
  AgentTaskArtifactContractV1,
} from "./taskContract";
import type { MatterContextManifestV1 } from "../context/matterContext";

export const AGENT_STEP_CONTRACT_VERSION = "agent_step_contract_v1" as const;
export const AGENT_STEP_CONTRACT_SET_KIND =
  "agent_step_contract_set_v1" as const;

export const agentStepCapabilitySchema = z.enum([
  "read_sources",
  "analyze",
  "create_tabular",
  "create_draft",
  "verify",
]);
export type AgentStepCapability = z.infer<typeof agentStepCapabilitySchema>;

export const agentStepOperationSchema = z.enum([
  "read",
  "source.acquire",
  "compare",
  "extract",
  "classify",
  "table.create",
  "draft.create",
  "draft.replicate",
  "draft.edit",
  "verify",
]);
export type AgentStepOperation = z.infer<typeof agentStepOperationSchema>;

const outputExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checkpoint") }).strict(),
  z
    .object({
      kind: z.literal("artifact"),
      deliverable_key: z.string().trim().min(1).max(80),
      artifact_type: z.enum(["draft", "tabular_review"]),
    })
    .strict(),
  z.object({ kind: z.literal("verification") }).strict(),
]);

const sourceRequirementSchema = z
  .object({
    mode: z.enum(["none", "pinned", "authority"]),
    citations_required: z.boolean(),
    authority_as_of_required: z.boolean(),
    jurisdictions: z.array(z.string().trim().min(1).max(120)).max(12),
    as_of_date: z.string().nullable(),
  })
  .strict();

export const agentStepPostconditionSchema = z.enum([
  "summary_present",
  "source_versions_recorded",
  "artifact_created",
  "artifact_current_version",
  "required_deliverables_current",
  "source_requirement_satisfied",
  "verifier_passed",
]);
export type AgentStepPostcondition = z.infer<
  typeof agentStepPostconditionSchema
>;

const stepContractSchema = z
  .object({
    schema_version: z.literal(AGENT_STEP_CONTRACT_VERSION),
    position: z.number().int().min(0).max(5),
    capability: agentStepCapabilitySchema,
    operation: agentStepOperationSchema,
    output_expectation: outputExpectationSchema,
    source_requirement: sourceRequirementSchema,
    deterministic_postconditions: z
      .array(agentStepPostconditionSchema)
      .min(1)
      .max(agentStepPostconditionSchema.options.length),
  })
  .strict()
  .superRefine((step, context) => {
    if (!operationMatchesCapability(step.operation, step.capability)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operation"],
        message: "Step operation does not match its capability",
      });
    }
    if (
      new Set(step.deterministic_postconditions).size !==
      step.deterministic_postconditions.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deterministic_postconditions"],
        message: "Step postconditions must be unique",
      });
    }
  });

const stepContractSetSchema = z
  .object({
    kind: z.literal(AGENT_STEP_CONTRACT_SET_KIND),
    steps: z.array(stepContractSchema).min(3).max(6),
  })
  .strict()
  .superRefine((value, context) => {
    value.steps.forEach((step, index) => {
      if (step.position !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "position"],
          message: "Step positions must be contiguous",
        });
      }
    });
    if (value.steps.at(-1)?.capability !== "verify") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "The final Step must verify deliverables",
      });
    }
  });

export type AgentStepContractV1 = z.infer<typeof stepContractSchema>;
export type AgentStepContractSetV1 = z.infer<typeof stepContractSetSchema>;

const stepReceiptSchema = z
  .object({
    kind: z.literal("agent_step_receipt_v1"),
    contract_version: z.literal(AGENT_STEP_CONTRACT_VERSION),
    position: z.number().int().min(0).max(5),
    attempt: z.number().int().min(1),
    capability: agentStepCapabilitySchema,
    operation: agentStepOperationSchema,
    outcome: z.enum(["postconditions_satisfied", "review_required"]),
    summary: z.string().trim().min(1).max(4000),
    source_version_ids: z.array(z.string().trim().min(1).max(200)).max(100),
    artifact_ids: z.array(z.string().trim().min(1).max(200)).max(3),
    postconditions: z
      .array(
        z
          .object({
            code: agentStepPostconditionSchema,
            status: z.enum(["pass", "fail"]),
          })
          .strict(),
      )
      .min(1)
      .max(agentStepPostconditionSchema.options.length),
  })
  .strict()
  .superRefine((receipt, context) => {
    const hasFailure = receipt.postconditions.some(
      (postcondition) => postcondition.status === "fail",
    );
    if (
      (receipt.outcome === "postconditions_satisfied" && hasFailure) ||
      (receipt.outcome === "review_required" && !hasFailure)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "Step receipt outcome does not match its postconditions",
      });
    }
    if (
      receipt.outcome === "review_required" &&
      receipt.capability !== "verify"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capability"],
        message: "Only a verifier Step can enter the lawyer review path",
      });
    }
  });

export type AgentStepReceiptV1 = z.infer<typeof stepReceiptSchema>;

export function operationMatchesCapability(
  operation: AgentStepOperation,
  capability: AgentStepCapability,
) {
  if (capability === "read_sources") {
    return operation === "read" || operation === "source.acquire";
  }
  if (capability === "analyze") {
    return ["compare", "extract", "classify"].includes(operation);
  }
  if (capability === "create_tabular") return operation === "table.create";
  if (capability === "create_draft") {
    return ["draft.create", "draft.replicate", "draft.edit"].includes(
      operation,
    );
  }
  return capability === "verify" && operation === "verify";
}

export function defaultOperationForCapability(
  capability: AgentStepCapability,
): AgentStepOperation {
  if (capability === "read_sources") return "read";
  if (capability === "analyze") return "classify";
  if (capability === "create_tabular") return "table.create";
  if (capability === "create_draft") return "draft.create";
  return "verify";
}

function sourceRequirement(
  goal: AgentGoalSpecV1,
  context: MatterContextManifestV1,
) {
  const sourcesRequired =
    context.sources.length > 0 ||
    goal.source_standard.material_claims_require_citations ||
    goal.source_standard.authority_required;
  return sourceRequirementSchema.parse({
    mode: goal.source_standard.authority_required
      ? "authority"
      : sourcesRequired
        ? "pinned"
        : "none",
    citations_required: goal.source_standard.material_claims_require_citations,
    authority_as_of_required: goal.source_standard.authority_as_of_required,
    jurisdictions: goal.jurisdictions,
    as_of_date: goal.as_of_date,
  });
}

export function compileAgentStepContracts(input: {
  steps: Array<{
    capability: AgentStepCapability;
    operation?: AgentStepOperation;
  }>;
  goalSpec: AgentGoalSpecV1;
  artifactContracts: AgentTaskArtifactContractV1[];
  contextManifest: MatterContextManifestV1;
}) {
  const artifactsByType = {
    draft: input.artifactContracts.filter(
      (artifact) => artifact.artifact_type === "draft",
    ),
    tabular_review: input.artifactContracts.filter(
      (artifact) => artifact.artifact_type === "tabular_review",
    ),
  };
  let draftIndex = 0;
  let tableIndex = 0;
  const requirement = sourceRequirement(input.goalSpec, input.contextManifest);
  const steps = input.steps.map((step, position) => {
    const artifact =
      step.capability === "create_draft"
        ? artifactsByType.draft[draftIndex++]
        : step.capability === "create_tabular"
          ? artifactsByType.tabular_review[tableIndex++]
          : null;
    if (
      (step.capability === "create_draft" ||
        step.capability === "create_tabular") &&
      !artifact
    ) {
      throw new Error(`Step ${position + 1} has no matching ArtifactContract`);
    }
    const postconditions: AgentStepPostcondition[] = [
      "summary_present",
      ...(requirement.mode === "none"
        ? []
        : (["source_versions_recorded"] as const)),
      ...(artifact
        ? (["artifact_created", "artifact_current_version"] as const)
        : []),
      ...(step.capability === "verify"
        ? ([
            "required_deliverables_current",
            "source_requirement_satisfied",
            "verifier_passed",
          ] as const)
        : []),
    ];
    return {
      schema_version: AGENT_STEP_CONTRACT_VERSION,
      position,
      capability: step.capability,
      operation:
        step.operation ?? defaultOperationForCapability(step.capability),
      output_expectation:
        step.capability === "verify"
          ? ({ kind: "verification" } as const)
          : artifact
            ? ({
                kind: "artifact",
                deliverable_key: artifact.key,
                artifact_type: artifact.artifact_type,
              } as const)
            : ({ kind: "checkpoint" } as const),
      source_requirement: requirement,
      deterministic_postconditions: Array.from(new Set(postconditions)),
    };
  });
  if (
    draftIndex !== artifactsByType.draft.length ||
    tableIndex !== artifactsByType.tabular_review.length
  ) {
    throw new Error("Every ArtifactContract must bind to exactly one Step");
  }
  return validateAgentStepContractSet({
    kind: AGENT_STEP_CONTRACT_SET_KIND,
    steps,
  });
}

export function validateAgentStepContractSet(value: unknown) {
  return stepContractSetSchema.parse(value);
}

export type AgentStepContractRead =
  | { state: "legacy" }
  | { state: "invalid"; reason: string }
  | { state: "valid"; contracts: AgentStepContractV1[] };

export function readAgentStepContracts(task: {
  latest_checkpoint?: unknown;
  current_plan?: unknown[];
}): AgentStepContractRead {
  const checkpoint =
    task.latest_checkpoint &&
    typeof task.latest_checkpoint === "object" &&
    !Array.isArray(task.latest_checkpoint)
      ? (task.latest_checkpoint as Record<string, unknown>)
      : null;
  const contract =
    checkpoint?.contract &&
    typeof checkpoint.contract === "object" &&
    !Array.isArray(checkpoint.contract)
      ? (checkpoint.contract as Record<string, unknown>)
      : null;
  if (!contract || !Object.hasOwn(contract, "step_contracts")) {
    return checkpoint?.schema_version
      ? {
          state: "invalid",
          reason: "Versioned Task has no Step Contract",
        }
      : { state: "legacy" };
  }
  try {
    const parsed = validateAgentStepContractSet(contract.step_contracts);
    if (
      Array.isArray(task.current_plan) &&
      task.current_plan.length !== parsed.steps.length
    ) {
      throw new Error("Step Contracts do not match the persisted plan length");
    }
    return { state: "valid", contracts: parsed.steps };
  } catch (error) {
    return {
      state: "invalid",
      reason:
        error instanceof Error ? error.message : "Step Contract is invalid",
    };
  }
}

export function assertAgentStepContracts(task: {
  latest_checkpoint?: unknown;
  current_plan?: unknown[];
}) {
  const read = readAgentStepContracts(task);
  if (read.state === "invalid") {
    throw new Error(`Step Contract is invalid: ${read.reason}`);
  }
  return read;
}

export function buildAgentStepReceipt(input: {
  contract: AgentStepContractV1;
  attempt: number;
  summary: string;
  sourceVersionIds: string[];
  artifactIds: string[];
  satisfiedPostconditions: AgentStepPostcondition[];
}) {
  const satisfied = new Set(input.satisfiedPostconditions);
  const missing = input.contract.deterministic_postconditions.filter(
    (postcondition) => !satisfied.has(postcondition),
  );
  if (missing.length) {
    throw new Error(
      `Step postconditions are not satisfied: ${missing.join(", ")}`,
    );
  }
  return stepReceiptSchema.parse({
    kind: "agent_step_receipt_v1",
    contract_version: AGENT_STEP_CONTRACT_VERSION,
    position: input.contract.position,
    attempt: input.attempt,
    capability: input.contract.capability,
    operation: input.contract.operation,
    outcome: "postconditions_satisfied",
    summary: input.summary.trim(),
    source_version_ids: Array.from(new Set(input.sourceVersionIds)),
    artifact_ids: Array.from(new Set(input.artifactIds)),
    postconditions: input.contract.deterministic_postconditions.map((code) => ({
      code,
      status: "pass" as const,
    })),
  });
}

export function buildAgentStepReviewReceipt(input: {
  contract: AgentStepContractV1;
  attempt: number;
  summary: string;
  sourceVersionIds: string[];
  artifactIds: string[];
  satisfiedPostconditions: AgentStepPostcondition[];
}) {
  if (input.contract.capability !== "verify") {
    throw new Error("Only a verifier Step can require lawyer review");
  }
  const satisfied = new Set(input.satisfiedPostconditions);
  const missing = input.contract.deterministic_postconditions.filter(
    (postcondition) => !satisfied.has(postcondition),
  );
  if (!missing.length) {
    throw new Error("A clean verifier Step does not require lawyer review");
  }
  return stepReceiptSchema.parse({
    kind: "agent_step_receipt_v1",
    contract_version: AGENT_STEP_CONTRACT_VERSION,
    position: input.contract.position,
    attempt: input.attempt,
    capability: input.contract.capability,
    operation: input.contract.operation,
    outcome: "review_required",
    summary: input.summary.trim(),
    source_version_ids: Array.from(new Set(input.sourceVersionIds)),
    artifact_ids: Array.from(new Set(input.artifactIds)),
    postconditions: input.contract.deterministic_postconditions.map((code) => ({
      code,
      status: satisfied.has(code) ? ("pass" as const) : ("fail" as const),
    })),
  });
}

export function readAgentStepReceipts(checkpoint: unknown) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    return [];
  }
  const value = (checkpoint as Record<string, unknown>).step_receipts;
  const result = z.array(stepReceiptSchema).max(60).safeParse(value);
  return result.success ? result.data : [];
}
