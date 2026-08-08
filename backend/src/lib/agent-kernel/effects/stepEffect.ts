import { createHash } from "node:crypto";

import { z } from "zod";

import type { createServerSupabase } from "../../supabase";

type Db = ReturnType<typeof createServerSupabase>;

export const AGENT_STEP_EFFECT_RECEIPT_KEY = "effect_receipts" as const;

const effectReceiptSchema = z
  .object({
    kind: z.literal("agent_step_effect_v1"),
    effect_key: z.string().trim().min(1).max(300),
    step_id: z.string().trim().min(1).max(200),
    attempt: z.number().int().min(1),
    tool_name: z.enum(["generate_docx", "generate_excel"]),
    input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["reserved", "committed"]),
    target: z
      .object({
        document_id: z.string().uuid(),
        version_id: z.string().uuid(),
      })
      .strict(),
    effect: z
      .object({
        document_id: z.string().uuid(),
        version_id: z.string().uuid(),
        artifact_type: z.enum(["draft", "tabular_review"]),
      })
      .strict()
      .nullable(),
    created_at: z.string().datetime(),
    committed_at: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      (receipt.status === "reserved" &&
        (receipt.effect !== null || receipt.committed_at !== null)) ||
      (receipt.status === "committed" &&
        (receipt.effect === null || receipt.committed_at === null))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Effect status does not match its committed fields",
      });
    }
    if (
      receipt.effect &&
      (receipt.effect.document_id !== receipt.target.document_id ||
        receipt.effect.version_id !== receipt.target.version_id)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effect"],
        message: "Committed effect does not match the reserved target",
      });
    }
  });

export type AgentStepEffectReceiptV1 = z.infer<typeof effectReceiptSchema>;
export type AgentStepMutationTool = AgentStepEffectReceiptV1["tool_name"];

export function canonicalEffectInput(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEffectInput).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalEffectInput(item)}`,
    )
    .join(",")}}`;
}

export function durableEffectUuid(scope: string, kind: string) {
  const hex = createHash("sha256")
    .update(`vera-agent-effect-v1\0${scope}\0${kind}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildAgentStepEffectReservation(input: {
  stepId: string;
  attempt: number;
  toolName: AgentStepMutationTool;
  toolInput: unknown;
  createdAt?: string;
  target?: { documentId: string; versionId: string };
}) {
  const scope = `agent-step:${input.stepId}:attempt:${input.attempt}:${input.toolName}`;
  return effectReceiptSchema.parse({
    kind: "agent_step_effect_v1",
    effect_key: scope,
    step_id: input.stepId,
    attempt: input.attempt,
    tool_name: input.toolName,
    input_fingerprint: createHash("sha256")
      .update(canonicalEffectInput(input.toolInput))
      .digest("hex"),
    status: "reserved",
    target: {
      document_id:
        input.target?.documentId ?? durableEffectUuid(scope, "document"),
      version_id:
        input.target?.versionId ?? durableEffectUuid(scope, "version"),
    },
    effect: null,
    created_at: input.createdAt ?? new Date().toISOString(),
    committed_at: null,
  });
}

function readReceiptMap(resultData: unknown) {
  if (
    !resultData ||
    typeof resultData !== "object" ||
    Array.isArray(resultData)
  ) {
    return {} as Record<string, AgentStepEffectReceiptV1>;
  }
  const raw = (resultData as Record<string, unknown>)[
    AGENT_STEP_EFFECT_RECEIPT_KEY
  ];
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Stored Step effect receipts are malformed");
  }
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
      const receipt = effectReceiptSchema.parse(value);
      if (receipt.effect_key !== key) {
        throw new Error("Stored Step effect receipt key is inconsistent");
      }
      return [key, receipt];
    }),
  );
}

function sameReservation(
  left: AgentStepEffectReceiptV1,
  right: AgentStepEffectReceiptV1,
) {
  return (
    left.effect_key === right.effect_key &&
    left.step_id === right.step_id &&
    left.attempt === right.attempt &&
    left.tool_name === right.tool_name &&
    left.input_fingerprint === right.input_fingerprint &&
    left.target.document_id === right.target.document_id &&
    left.target.version_id === right.target.version_id
  );
}

export class AgentStepEffectTransitionError extends Error {
  constructor(
    readonly outcome:
      | "artifact_invalid"
      | "conflict"
      | "invalid_input"
      | "lease_lost"
      | "not_found",
    readonly facts: Record<string, unknown>,
  ) {
    super(
      outcome === "lease_lost"
        ? "The Step effect lost its execution lease before publication"
        : "The Step effect could not be published from the current Task state",
    );
    this.name = "AgentStepEffectTransitionError";
  }
}

export function isAgentStepEffectTransitionError(
  error: unknown,
): error is AgentStepEffectTransitionError {
  return (
    error instanceof AgentStepEffectTransitionError ||
    Boolean(
      error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "AgentStepEffectTransitionError",
    )
  );
}

function firstRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function readTransitionReceipt(
  data: unknown,
  input: {
    taskId: string;
    userId: string;
    leaseOwner: string;
    receipt: AgentStepEffectReceiptV1;
  },
) {
  const row = firstRow(data) as Record<string, unknown> | null;
  const outcome = row?.outcome;
  if (
    outcome === "artifact_invalid" ||
    outcome === "conflict" ||
    outcome === "invalid_input" ||
    outcome === "lease_lost" ||
    outcome === "not_found"
  ) {
    throw new AgentStepEffectTransitionError(outcome, {
      task_id: input.taskId,
      user_id: input.userId,
      step_id: input.receipt.step_id,
      step_attempt: input.receipt.attempt,
      lease_owner: input.leaseOwner,
      effect_key: input.receipt.effect_key,
    });
  }
  if (
    !(["reserved", "recovered", "committed"] as unknown[]).includes(outcome)
  ) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: input.receipt.step_id,
      effect_key: input.receipt.effect_key,
      outcome: outcome ?? null,
    });
  }
  const receipt = effectReceiptSchema.safeParse(row?.effect_receipt);
  if (!receipt.success || !sameReservation(receipt.data, input.receipt)) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: input.receipt.step_id,
      effect_key: input.receipt.effect_key,
      reason: "returned_receipt_mismatch",
    });
  }
  return receipt.data;
}

export async function reserveAgentStepEffect(
  db: Db,
  input: {
    taskId: string;
    userId: string;
    leaseOwner: string;
    receipt: AgentStepEffectReceiptV1;
  },
) {
  const wanted = effectReceiptSchema.parse(input.receipt);
  const { data, error } = await db.rpc("reserve_agent_step_effect_v1", {
    p_task_id: input.taskId,
    p_user_id: input.userId,
    p_step_id: wanted.step_id,
    p_step_attempt: wanted.attempt,
    p_lease_owner: input.leaseOwner,
    p_effect_key: wanted.effect_key,
    p_receipt: wanted,
  });
  if (error) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: wanted.step_id,
      effect_key: wanted.effect_key,
      database_error: error.message,
    });
  }
  return readTransitionReceipt(data, { ...input, receipt: wanted });
}

export async function commitAgentStepEffect(
  db: Db,
  input: {
    taskId: string;
    userId: string;
    leaseOwner: string;
    receipt: AgentStepEffectReceiptV1;
    artifactType: "draft" | "tabular_review";
    documentId: string;
    versionId: string;
    committedAt?: string;
  },
) {
  const wanted = effectReceiptSchema.parse(input.receipt);
  const reservation = effectReceiptSchema.parse({
    ...wanted,
    status: "reserved",
    effect: null,
    committed_at: null,
  });
  if (
    input.documentId !== wanted.target.document_id ||
    input.versionId !== wanted.target.version_id
  ) {
    throw new Error("The created Artifact does not match its reserved target");
  }
  const { data, error } = await db.rpc("commit_agent_step_effect_v1", {
    p_task_id: input.taskId,
    p_user_id: input.userId,
    p_step_id: wanted.step_id,
    p_step_attempt: wanted.attempt,
    p_lease_owner: input.leaseOwner,
    p_effect_key: wanted.effect_key,
    p_reserved_receipt: reservation,
    p_artifact_type: input.artifactType,
    p_document_id: input.documentId,
    p_version_id: input.versionId,
    p_committed_at: input.committedAt ?? new Date().toISOString(),
  });
  if (error) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: wanted.step_id,
      effect_key: wanted.effect_key,
      database_error: error.message,
    });
  }
  const committed = readTransitionReceipt(data, {
    ...input,
    receipt: reservation,
  });
  if (committed.status !== "committed") {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: wanted.step_id,
      effect_key: wanted.effect_key,
      reason: "commit_returned_uncommitted_receipt",
    });
  }
  return committed;
}

export function readAgentStepEffectReceipts(resultData: unknown) {
  return Object.values(readReceiptMap(resultData));
}
