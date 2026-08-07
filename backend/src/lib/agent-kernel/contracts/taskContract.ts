import { z } from "zod";

export const AGENT_TASK_CHECKPOINT_VERSION = "agent_task_checkpoint_v1" as const;
export const AGENT_GOAL_SPEC_KIND = "agent_goal_v1" as const;
export const ARTIFACT_CONTRACT_VERSION = "artifact_contract_v1" as const;
export const MATTER_CONTEXT_KIND = "matter_context_v1" as const;

const boundedId = z.string().trim().min(1).max(200);
const artifactKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(48);
const artifactTypeSchema = z.enum(["draft", "tabular_review"]);
const artifactBaseShape = {
  key: artifactKeySchema,
  title: z.string().trim().min(2).max(80),
  description: z.string().trim().min(4).max(240),
  required: z.boolean(),
  artifact_type: artifactTypeSchema,
  purpose: z.string().trim().min(2).max(80),
  artifact_id: boundedId.optional(),
};
const legacyArtifactSchema = z.object(artifactBaseShape).strict();
const artifactContractSchema = z
  .object({
    schema_version: z.literal(ARTIFACT_CONTRACT_VERSION),
    ...artifactBaseShape,
    kind: z.literal("document"),
    format: z.enum(["docx", "xlsx"]),
    operation: z.enum(["create", "revise", "replicate"]),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedFormat =
      value.artifact_type === "draft" ? "docx" : "xlsx";
    if (value.format !== expectedFormat) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["format"],
        message: "Artifact format does not match artifact_type",
      });
    }
  });

const completionCheckSchema = z.enum([
  "deliverables_present",
  "goal_covered",
  "source_supported",
  "citations_relocatable",
  "steps_complete",
]);
const mustAskReasonSchema = z.enum([
  "missing_source",
  "missing_fact",
  "evidence_conflict",
  "legal_judgment",
  "source_version_changed",
  "material_scope_change",
  "consequential_action",
]);

function uniqueArray<T extends z.ZodTypeAny>(
  item: T,
  max: number,
  label: string,
) {
  return z
    .array(item)
    .max(max)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be unique`,
        });
      }
    });
}

function validIsoDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

const goalSpecSchema = z
  .object({
    kind: z.literal(AGENT_GOAL_SPEC_KIND),
    objective: z.string().trim().min(1).max(4000),
    task_family: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
      .max(80),
    jurisdictions: uniqueArray(
      z.string().trim().min(1).max(120),
      12,
      "Goal jurisdictions",
    ),
    as_of_date: z
      .string()
      .trim()
      .refine(validIsoDate, "Goal as_of_date must be a real ISO date")
      .nullable(),
    deliverable_keys: uniqueArray(
      artifactKeySchema,
      3,
      "Goal deliverable_keys",
    ),
    completion_checks: uniqueArray(
      completionCheckSchema,
      completionCheckSchema.options.length,
      "Goal completion_checks",
    ),
    source_standard: z
      .object({
        material_claims_require_citations: z.boolean(),
        authority_required: z.boolean(),
        authority_as_of_required: z.boolean(),
      })
      .strict(),
    must_ask_when: uniqueArray(
      mustAskReasonSchema,
      mustAskReasonSchema.options.length,
      "Goal must_ask_when",
    ),
  })
  .strict();

const contextSourceSchema = z
  .object({
    document_id: boundedId,
    version_id: boundedId,
    filename: z.string().trim().min(1).max(500),
    file_type: z.string().trim().min(1).max(80).nullable(),
    role: z.enum(["source", "template", "precedent", "authority"]),
  })
  .strict();
const workflowSnapshotSchema = z
  .object({
    id: boundedId,
    title: z.string().trim().min(1).max(500),
    description: z.string().max(4000),
    type: z.enum(["assistant", "tabular"]),
    instructions: z.string().max(100_000),
    columns: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict();
const matterContextSchema = z
  .object({
    kind: z.literal(MATTER_CONTEXT_KIND),
    matter_id: boundedId,
    sources: z.array(contextSourceSchema).max(100),
    workflow: workflowSnapshotSchema.nullable(),
    compiled_at: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const documentIds = value.sources.map((source) => source.document_id);
    if (new Set(documentIds).size !== documentIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: "Task context document ids must be unique",
      });
    }
  });

export type AgentTaskArtifactContractV1 = z.infer<
  typeof artifactContractSchema
>;
export type AgentGoalSpecV1 = z.infer<typeof goalSpecSchema>;
export type MatterContextManifestV1 = z.infer<typeof matterContextSchema>;

export function normalizeAgentTaskArtifactContracts(
  value: unknown,
): AgentTaskArtifactContractV1[] {
  const rows = z
    .array(z.union([artifactContractSchema, legacyArtifactSchema]))
    .max(3)
    .parse(value);
  const contracts = rows.map((row) => {
    if ("schema_version" in row) return row;
    return artifactContractSchema.parse({
      schema_version: ARTIFACT_CONTRACT_VERSION,
      ...row,
      kind: "document",
      format: row.artifact_type === "draft" ? "docx" : "xlsx",
      operation: "create",
    });
  });
  if (
    new Set(contracts.map((item) => item.key)).size !== contracts.length ||
    new Set(contracts.map((item) => item.purpose)).size !== contracts.length
  ) {
    throw new Error("Artifact keys and purposes must be unique");
  }
  return contracts;
}

export function validateVersionedAgentTaskArtifactContracts(value: unknown) {
  return z.array(artifactContractSchema).max(3).parse(value);
}

export function validateAgentGoalSpec(value: unknown) {
  return goalSpecSchema.parse(value);
}

export function validateMatterContextManifest(value: unknown) {
  return matterContextSchema.parse(value);
}

export function assertAgentTaskContractConsistency(input: {
  goal: string;
  matterId: string;
  goalSpec: AgentGoalSpecV1;
  deliverables: AgentTaskArtifactContractV1[];
  contextManifest: MatterContextManifestV1;
}) {
  if (input.deliverables.some((item) => item.operation !== "create")) {
    throw new Error("New Work Tasks support only create ArtifactContracts");
  }
  if (input.goalSpec.objective !== input.goal.trim()) {
    throw new Error("GoalSpec objective does not match the task goal");
  }
  if (input.contextManifest.matter_id !== input.matterId) {
    throw new Error("Task context does not belong to the task Matter");
  }
  const keys = input.deliverables.map((item) => item.key);
  if (
    keys.length !== input.goalSpec.deliverable_keys.length ||
    keys.some((key, index) => key !== input.goalSpec.deliverable_keys[index])
  ) {
    throw new Error("GoalSpec deliverable keys do not match ArtifactContract");
  }
}

export type AgentTaskAssignmentContractRead =
  | { state: "legacy" }
  | { state: "invalid"; reason: string }
  | {
      state: "valid";
      goalSpec: AgentGoalSpecV1;
      artifactContracts: AgentTaskArtifactContractV1[];
      contextManifest: MatterContextManifestV1;
    };

export function readAgentTaskAssignmentContract(task: {
  goal?: unknown;
  matter_id?: unknown;
  deliverables?: unknown;
  latest_checkpoint?: unknown;
}): AgentTaskAssignmentContractRead {
  const checkpoint =
    task.latest_checkpoint &&
    typeof task.latest_checkpoint === "object" &&
    !Array.isArray(task.latest_checkpoint)
      ? (task.latest_checkpoint as Record<string, unknown>)
      : null;
  const deliverables = Array.isArray(task.deliverables)
    ? task.deliverables
    : [];
  const marked = Boolean(
    (checkpoint &&
      (Object.hasOwn(checkpoint, "contract") ||
        Object.hasOwn(checkpoint, "schema_version"))) ||
      deliverables.some(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.hasOwn(item, "schema_version"),
      ),
  );
  if (!marked) return { state: "legacy" };

  try {
    if (
      !checkpoint ||
      checkpoint.schema_version !== AGENT_TASK_CHECKPOINT_VERSION ||
      !checkpoint.contract ||
      typeof checkpoint.contract !== "object" ||
      Array.isArray(checkpoint.contract)
    ) {
      throw new Error("Task checkpoint contract is missing or unsupported");
    }
    if (typeof task.goal !== "string" || typeof task.matter_id !== "string") {
      throw new Error("Task identity is incomplete");
    }
    const contract = checkpoint.contract as Record<string, unknown>;
    const goalSpec = validateAgentGoalSpec(contract.goal_spec);
    const artifactContracts =
      validateVersionedAgentTaskArtifactContracts(task.deliverables);
    const contextManifest = validateMatterContextManifest(
      contract.context_manifest,
    );
    assertAgentTaskContractConsistency({
      goal: task.goal,
      matterId: task.matter_id,
      goalSpec,
      deliverables: artifactContracts,
      contextManifest,
    });
    return { state: "valid", goalSpec, artifactContracts, contextManifest };
  } catch (error) {
    return {
      state: "invalid",
      reason:
        error instanceof Error ? error.message : "Assignment Contract is invalid",
    };
  }
}

export function assertAgentTaskAssignmentContract(task: {
  goal?: unknown;
  matter_id?: unknown;
  deliverables?: unknown;
  latest_checkpoint?: unknown;
}) {
  const contract = readAgentTaskAssignmentContract(task);
  if (contract.state === "invalid") {
    throw new Error(`Assignment Contract is invalid: ${contract.reason}`);
  }
  return contract;
}
