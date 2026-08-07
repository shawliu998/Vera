import { z } from "zod";

import type { AgentStepContractV1 } from "../contracts/stepContract";
import { readOnlySourceConnectorPinSchema } from "../connectors/readOnlySourceContract";

export const AGENT_STEP_CAPABILITY_GRANT_VERSION =
  "agent_step_capability_grant_v2" as const;
const LEGACY_AGENT_STEP_CAPABILITY_GRANT_VERSION =
  "agent_step_capability_grant_v1" as const;

const TOOL_NAMES_BY_OPERATION = {
  read: ["ask_inputs", "read_document", "find_in_document"],
  "source.acquire": [],
  compare: ["ask_inputs", "read_document", "find_in_document"],
  extract: ["ask_inputs", "read_document", "find_in_document"],
  classify: ["ask_inputs", "read_document", "find_in_document"],
  "table.create": [
    "ask_inputs",
    "read_document",
    "find_in_document",
    "generate_excel",
  ],
  "draft.create": [
    "ask_inputs",
    "read_document",
    "find_in_document",
    "generate_docx",
  ],
  "draft.replicate": [
    "ask_inputs",
    "read_document",
    "find_in_document",
    "replicate_document",
  ],
  "draft.edit": [
    "ask_inputs",
    "read_document",
    "find_in_document",
    "edit_document",
  ],
  verify: [],
} as const satisfies Record<
  AgentStepContractV1["operation"],
  readonly string[]
>;

export const WORK_TASK_HOST_TOOL_NAMES = Array.from(
  new Set([
    "ask_inputs",
    "read_document",
    "find_in_document",
    "generate_excel",
    "generate_docx",
    "edit_document",
  ]),
);

const legacyGrantSchema = z
  .object({
    schema_version: z.literal(LEGACY_AGENT_STEP_CAPABILITY_GRANT_VERSION),
    step_position: z.number().int().min(0).max(5),
    capability: z.string().trim().min(1).max(80),
    operation: z.string().trim().min(1).max(80),
    allowed_tool_names: z.array(z.string().trim().min(1).max(120)).max(16),
    mcp_tools_allowed: z.literal(false),
    research_tools_allowed: z.literal(false),
    consequential_actions_allowed: z.literal(false),
  })
  .strict();

const grantSchema = z
  .object({
    schema_version: z.literal(AGENT_STEP_CAPABILITY_GRANT_VERSION),
    step_position: z.number().int().min(0).max(5),
    capability: z.string().trim().min(1).max(80),
    operation: z.string().trim().min(1).max(80),
    allowed_tool_names: z.array(z.string().trim().min(1).max(120)).max(16),
    mcp_tools_allowed: z.literal(false),
    research_tools_allowed: z.boolean(),
    read_only_connector_pins: z
      .array(readOnlySourceConnectorPinSchema)
      .max(4),
    consequential_actions_allowed: z.literal(false),
  })
  .strict()
  .superRefine((grant, context) => {
    const hasConnectorPins = grant.read_only_connector_pins.length > 0;
    if (grant.research_tools_allowed !== hasConnectorPins) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["research_tools_allowed"],
        message: "Research access must match the fixed connector pins",
      });
    }
    if (
      hasConnectorPins &&
      (grant.capability !== "read_sources" ||
        grant.operation !== "source.acquire")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["read_only_connector_pins"],
        message: "Only a read_sources Step may receive read-only connectors",
      });
    }
    const connectorIds = grant.read_only_connector_pins.map(
      (pin) => pin.connector_id,
    );
    if (new Set(connectorIds).size !== connectorIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["read_only_connector_pins"],
        message: "Connector pins must have unique identities",
      });
    }
  });

export type AgentStepCapabilityGrantV2 = z.infer<typeof grantSchema>;
/** Compatibility alias for pre-extraction callers; resolved grants are V2. */
export type AgentStepCapabilityGrantV1 = AgentStepCapabilityGrantV2;

function normalizeAgentStepCapabilityGrant(value: unknown) {
  const current = grantSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyGrantSchema.parse(value);
  return grantSchema.parse({
    ...legacy,
    schema_version: AGENT_STEP_CAPABILITY_GRANT_VERSION,
    read_only_connector_pins: [],
  });
}

export function validateAgentStepCapabilityGrant(value: unknown) {
  return normalizeAgentStepCapabilityGrant(value);
}

/**
 * Intersects the immutable Step contract with the host's actual tool names.
 * A request can narrow this set but can never add a tool.
 */
export function resolveAgentStepCapabilityGrant(input: {
  contract: AgentStepContractV1;
  availableToolNames: readonly string[];
  requestedToolNames?: readonly string[];
  readOnlyConnectorPins?: readonly unknown[];
}) {
  const available = new Set(input.availableToolNames);
  const requested = input.requestedToolNames
    ? new Set(input.requestedToolNames)
    : null;
  const allowed = TOOL_NAMES_BY_OPERATION[input.contract.operation].filter(
    (toolName) =>
      available.has(toolName) && (!requested || requested.has(toolName)),
  );
  const readOnlyConnectorPins = z
    .array(readOnlySourceConnectorPinSchema)
    .max(4)
    .parse(input.readOnlyConnectorPins ?? []);
  if (
    readOnlyConnectorPins.length &&
    (input.contract.capability !== "read_sources" ||
      input.contract.operation !== "source.acquire" ||
      input.contract.source_requirement.mode === "none" ||
      input.contract.source_requirement.jurisdictions.length === 0 ||
      input.contract.source_requirement.as_of_date === null)
  ) {
    throw new Error(
      "Read-only connectors require one fixed source.acquire Step with jurisdiction and as-of scope",
    );
  }
  return grantSchema.parse({
    schema_version: AGENT_STEP_CAPABILITY_GRANT_VERSION,
    step_position: input.contract.position,
    capability: input.contract.capability,
    operation: input.contract.operation,
    allowed_tool_names: allowed,
    mcp_tools_allowed: false,
    research_tools_allowed: readOnlyConnectorPins.length > 0,
    read_only_connector_pins: readOnlyConnectorPins,
    consequential_actions_allowed: false,
  });
}

export function allowedToolNamesForStepContract(contract: AgentStepContractV1) {
  return [...TOOL_NAMES_BY_OPERATION[contract.operation]];
}

/**
 * A verifier repair is a server-owned compatibility overlay, not an expanded
 * verifier grant. It may read the fixed sources and recreate only a uniquely
 * bound declared deliverable. Batch 6 can replace this overlay with a formal
 * repair Step without changing the persisted verifier contract.
 */
export function resolveBoundedRepairToolNames(input: {
  artifactType: "draft" | "tabular_review";
  availableToolNames: readonly string[];
}) {
  const available = new Set(input.availableToolNames);
  const requested = [
    "ask_inputs",
    "read_document",
    "find_in_document",
    input.artifactType === "draft" ? "generate_docx" : "generate_excel",
  ];
  return requested.filter((toolName) => available.has(toolName));
}

export type AgentStepCapabilityGrantRead =
  | { state: "legacy" }
  | { state: "invalid"; reason: string }
  | { state: "valid"; grants: AgentStepCapabilityGrantV2[] };

export function readAgentStepCapabilityGrants(task: {
  latest_checkpoint?: unknown;
  current_plan?: unknown[];
}): AgentStepCapabilityGrantRead {
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
  if (!contract || !Object.hasOwn(contract, "capability_grants")) {
    return checkpoint?.schema_version
      ? { state: "invalid", reason: "Versioned Task has no capability grants" }
      : { state: "legacy" };
  }
  try {
    const serializedGrants = z
      .array(z.unknown())
      .min(3)
      .max(6)
      .parse(contract.capability_grants);
    const grants = serializedGrants.map(normalizeAgentStepCapabilityGrant);
    if (
      Array.isArray(task.current_plan) &&
      grants.length !== task.current_plan.length
    ) {
      throw new Error(
        "Capability grants do not match the persisted plan length",
      );
    }
    grants.forEach((grant, index) => {
      if (grant.step_position !== index) {
        throw new Error("Capability grant positions must be contiguous");
      }
    });
    return { state: "valid", grants };
  } catch (error) {
    return {
      state: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "Capability grants are invalid",
    };
  }
}

export function assertAgentStepCapabilityGrants(task: {
  latest_checkpoint?: unknown;
  current_plan?: unknown[];
}) {
  const read = readAgentStepCapabilityGrants(task);
  if (read.state === "invalid") {
    throw new Error(`Capability Grant is invalid: ${read.reason}`);
  }
  return read;
}
