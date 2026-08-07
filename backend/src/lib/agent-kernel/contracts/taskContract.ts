import { z } from "zod";
import {
  MATTER_CONTEXT_KIND,
  type MatterContextManifestV1,
  validateMatterContextManifest,
} from "../context/matterContext";

export {
  MATTER_CONTEXT_KIND,
  type MatterContextManifestV1,
  validateMatterContextManifest,
} from "../context/matterContext";

export const AGENT_TASK_CHECKPOINT_VERSION =
  "agent_task_checkpoint_v1" as const;
export const AGENT_GOAL_SPEC_KIND = "agent_goal_v1" as const;
export const ARTIFACT_CONTRACT_VERSION = "artifact_contract_v1" as const;

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
    const expectedFormat = value.artifact_type === "draft" ? "docx" : "xlsx";
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

export type AgentTaskArtifactContractV1 = z.infer<
  typeof artifactContractSchema
>;
export type AgentGoalSpecV1 = z.infer<typeof goalSpecSchema>;

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

export function compileAgentGoalSpec(input: {
  objective: string;
  taskFamily: string;
  artifactContracts: AgentTaskArtifactContractV1[];
  hasSources: boolean;
  jurisdictions?: string[];
  asOfDate?: string | null;
  sourceStandard?: AgentGoalSpecV1["source_standard"];
  mustAskWhen?: AgentGoalSpecV1["must_ask_when"];
  completionChecks?: AgentGoalSpecV1["completion_checks"];
}) {
  return validateAgentGoalSpec({
    kind: AGENT_GOAL_SPEC_KIND,
    objective: input.objective.trim(),
    task_family: input.taskFamily,
    jurisdictions: input.jurisdictions ?? [],
    as_of_date: input.asOfDate ?? null,
    deliverable_keys: input.artifactContracts.map((artifact) => artifact.key),
    completion_checks: input.completionChecks ?? [
      "deliverables_present",
      "goal_covered",
      "source_supported",
      "citations_relocatable",
      "steps_complete",
    ],
    source_standard: input.sourceStandard ?? {
      material_claims_require_citations: input.hasSources,
      authority_required: false,
      authority_as_of_required: false,
    },
    must_ask_when: input.mustAskWhen ?? [
      "missing_source",
      "missing_fact",
      "evidence_conflict",
      "legal_judgment",
      "source_version_changed",
      "material_scope_change",
      "consequential_action",
    ],
  });
}

export function buildAgentTaskContractCheckpoint(input: {
  previous?: unknown;
  goalSpec: AgentGoalSpecV1;
  contextManifest: MatterContextManifestV1;
  stepContracts: unknown;
  capabilityGrants: unknown;
  createdAt?: string;
}) {
  const previous =
    input.previous &&
    typeof input.previous === "object" &&
    !Array.isArray(input.previous)
      ? (input.previous as Record<string, unknown>)
      : {};
  return {
    ...previous,
    schema_version: AGENT_TASK_CHECKPOINT_VERSION,
    step_id: "planner",
    iteration: 0,
    summary: "Server-owned task contract compiled.",
    created_at: input.createdAt ?? new Date().toISOString(),
    contract: {
      goal_spec: validateAgentGoalSpec(input.goalSpec),
      context_manifest: validateMatterContextManifest(input.contextManifest),
      step_contracts: input.stepContracts,
      capability_grants: input.capabilityGrants,
    },
  };
}

export function extendAgentTaskContractContext(input: {
  checkpoint: Record<string, unknown>;
  previousContext: MatterContextManifestV1;
  nextContext: MatterContextManifestV1;
  requestId?: string | null;
  createdAt?: string;
}) {
  if (input.checkpoint.schema_version !== AGENT_TASK_CHECKPOINT_VERSION) {
    return input.checkpoint;
  }
  const contract = input.checkpoint.contract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("Versioned Task has no Assignment Contract to extend");
  }
  const previous = validateMatterContextManifest(input.previousContext);
  const next = validateMatterContextManifest(input.nextContext);
  const fixed = validateMatterContextManifest(
    (contract as Record<string, unknown>).context_manifest,
  );
  if (JSON.stringify(fixed) !== JSON.stringify(previous)) {
    throw new Error("Assignment Context changed before the input revision");
  }
  if (next.matter_id !== previous.matter_id) {
    throw new Error("An input revision cannot change the Task Matter");
  }
  const nextByDocument = new Map(
    next.sources.map((source) => [source.document_id, source]),
  );
  if (
    previous.sources.some((source) => {
      const retained = nextByDocument.get(source.document_id);
      return !retained || JSON.stringify(retained) !== JSON.stringify(source);
    })
  ) {
    throw new Error(
      "An input revision cannot replace or drift a fixed source Version",
    );
  }
  if (JSON.stringify(previous.workflow) !== JSON.stringify(next.workflow)) {
    throw new Error("An input revision cannot change the fixed Workflow");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  const priorRevisions = Array.isArray(input.checkpoint.assignment_revisions)
    ? input.checkpoint.assignment_revisions
    : [];
  return {
    ...input.checkpoint,
    contract: {
      ...(contract as Record<string, unknown>),
      context_manifest: next,
    },
    assignment_revisions: [
      ...priorRevisions,
      {
        kind: "agent_assignment_context_revision_v1",
        reason: "required_input",
        request_id: input.requestId ?? null,
        previous_compiled_at: previous.compiled_at,
        next_compiled_at: next.compiled_at,
        added_document_ids: next.sources
          .filter(
            (source) =>
              !previous.sources.some(
                (prior) => prior.document_id === source.document_id,
              ),
          )
          .map((source) => source.document_id),
        created_at: createdAt,
      },
    ].slice(-20),
  };
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
    const artifactContracts = validateVersionedAgentTaskArtifactContracts(
      task.deliverables,
    );
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
        error instanceof Error
          ? error.message
          : "Assignment Contract is invalid",
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
