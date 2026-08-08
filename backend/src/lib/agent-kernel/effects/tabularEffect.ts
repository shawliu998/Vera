import { createHash } from "node:crypto";

import { z } from "zod";

import type { createServerSupabase } from "../../supabase";
import {
  AgentStepEffectTransitionError,
  durableEffectUuid,
} from "./stepEffect";

type Db = ReturnType<typeof createServerSupabase>;

export const AGENT_STEP_TABULAR_EFFECT_RECEIPT_KEY =
  "tabular_effect_receipts" as const;

const tabularEffectReceiptSchema = z
  .object({
    kind: z.literal("agent_step_tabular_effect_v1"),
    effect_key: z.string().trim().min(1).max(300),
    step_id: z.string().uuid(),
    attempt: z.number().int().positive(),
    operation: z.literal("create_tabular_review"),
    input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["reserved", "committed"]),
    target: z.object({ review_id: z.string().uuid() }).strict(),
    effect: z
      .object({
        review_id: z.string().uuid(),
        artifact_type: z.literal("tabular_review"),
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
        message: "Tabular effect status does not match its committed fields",
      });
    }
    if (
      receipt.effect &&
      receipt.effect.review_id !== receipt.target.review_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effect"],
        message: "Committed Tabular effect does not match its target",
      });
    }
  });

export type AgentStepTabularEffectReceiptV1 = z.infer<
  typeof tabularEffectReceiptSchema
>;

export type AgentStepTabularEffectLayout = {
  document_ids: string[];
  columns_config: unknown[];
  cells: Array<{
    id: string;
    document_id: string;
    column_index: number;
  }>;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function buildAgentStepTabularEffectReservation(input: {
  stepId: string;
  attempt: number;
  layout: unknown;
  reviewId?: string;
  createdAt?: string;
}) {
  const scope = `agent-step:${input.stepId}:attempt:${input.attempt}:create_tabular_review`;
  return tabularEffectReceiptSchema.parse({
    kind: "agent_step_tabular_effect_v1",
    effect_key: scope,
    step_id: input.stepId,
    attempt: input.attempt,
    operation: "create_tabular_review",
    input_fingerprint: createHash("sha256")
      .update(canonical(input.layout))
      .digest("hex"),
    status: "reserved",
    target: {
      review_id: input.reviewId ?? durableEffectUuid(scope, "tabular-review"),
    },
    effect: null,
    created_at: input.createdAt ?? new Date().toISOString(),
    committed_at: null,
  });
}

function sameReservation(
  left: AgentStepTabularEffectReceiptV1,
  right: AgentStepTabularEffectReceiptV1,
) {
  return (
    left.effect_key === right.effect_key &&
    left.step_id === right.step_id &&
    left.attempt === right.attempt &&
    left.operation === right.operation &&
    left.input_fingerprint === right.input_fingerprint &&
    left.target.review_id === right.target.review_id
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
    receipt: AgentStepTabularEffectReceiptV1;
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
      effect_kind: "tabular_review",
    });
  }
  if (!["reserved", "recovered", "committed"].includes(String(outcome))) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: input.receipt.step_id,
      outcome: outcome ?? null,
      effect_kind: "tabular_review",
    });
  }
  const parsed = tabularEffectReceiptSchema.safeParse(row?.effect_receipt);
  if (!parsed.success || !sameReservation(parsed.data, input.receipt)) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: input.receipt.step_id,
      reason: "returned_tabular_receipt_mismatch",
    });
  }
  return parsed.data;
}

export async function reserveAgentStepTabularEffect(
  db: Db,
  input: {
    taskId: string;
    userId: string;
    leaseOwner: string;
    receipt: AgentStepTabularEffectReceiptV1;
  },
) {
  const wanted = tabularEffectReceiptSchema.parse(input.receipt);
  const { data, error } = await db.rpc("reserve_agent_step_tabular_effect_v1", {
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
      database_error: error.message,
      effect_kind: "tabular_review",
    });
  }
  return readTransitionReceipt(data, { ...input, receipt: wanted });
}

export async function commitAgentStepTabularEffect(
  db: Db,
  input: {
    taskId: string;
    userId: string;
    leaseOwner: string;
    receipt: AgentStepTabularEffectReceiptV1;
    reviewId: string;
    layout: AgentStepTabularEffectLayout;
    committedAt?: string;
  },
) {
  const wanted = tabularEffectReceiptSchema.parse(input.receipt);
  const reservation = tabularEffectReceiptSchema.parse({
    ...wanted,
    status: "reserved",
    effect: null,
    committed_at: null,
  });
  if (input.reviewId !== wanted.target.review_id) {
    throw new Error("The created Tabular Review does not match its target");
  }
  const { data, error } = await db.rpc("commit_agent_step_tabular_effect_v1", {
    p_task_id: input.taskId,
    p_user_id: input.userId,
    p_step_id: wanted.step_id,
    p_step_attempt: wanted.attempt,
    p_lease_owner: input.leaseOwner,
    p_effect_key: wanted.effect_key,
    p_reserved_receipt: reservation,
    p_review_id: input.reviewId,
    p_layout: input.layout,
    p_committed_at: input.committedAt ?? new Date().toISOString(),
  });
  if (error) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: wanted.step_id,
      database_error: error.message,
      effect_kind: "tabular_review",
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
      reason: "commit_returned_uncommitted_tabular_receipt",
    });
  }
  return committed;
}

export function readAgentStepTabularEffectReceipts(resultData: unknown) {
  if (
    !resultData ||
    typeof resultData !== "object" ||
    Array.isArray(resultData)
  ) {
    return [];
  }
  const raw = (resultData as Record<string, unknown>)[
    AGENT_STEP_TABULAR_EFFECT_RECEIPT_KEY
  ];
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Stored Tabular effect receipts are malformed");
  }
  return Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
    const receipt = tabularEffectReceiptSchema.parse(value);
    if (receipt.effect_key !== key) {
      throw new Error("Stored Tabular effect receipt key is inconsistent");
    }
    return receipt;
  });
}
