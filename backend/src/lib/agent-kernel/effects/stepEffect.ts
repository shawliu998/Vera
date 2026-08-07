import { createHash } from "node:crypto";

import { z } from "zod";

import type { createServerSupabase } from "../../supabase";

type Db = ReturnType<typeof createServerSupabase>;

export const AGENT_STEP_EFFECT_RECEIPT_KEY = "effect_receipts" as const;
const MAX_CAS_ATTEMPTS = 5;

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
      document_id: durableEffectUuid(scope, "document"),
      version_id: durableEffectUuid(scope, "version"),
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

function nextUpdatedAt(previous: unknown) {
  const previousTime =
    typeof previous === "string" ? Date.parse(previous) : Number.NaN;
  return new Date(
    Number.isFinite(previousTime)
      ? Math.max(Date.now(), previousTime + 1)
      : Date.now(),
  ).toISOString();
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

export async function reserveAgentStepEffect(
  db: Db,
  input: { taskId: string; receipt: AgentStepEffectReceiptV1 },
) {
  const wanted = effectReceiptSchema.parse(input.receipt);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const { data: step, error } = await db
      .from("agent_steps")
      .select("id,result_data,updated_at")
      .eq("id", wanted.step_id)
      .eq("task_id", input.taskId)
      .eq("status", "running")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!step) throw new Error("The effect Step is no longer running");
    const resultData =
      step.result_data &&
      typeof step.result_data === "object" &&
      !Array.isArray(step.result_data)
        ? (step.result_data as Record<string, unknown>)
        : {};
    const receipts = readReceiptMap(resultData);
    const existing = receipts[wanted.effect_key];
    if (existing) {
      if (!sameReservation(existing, wanted)) {
        throw new Error(
          "A recovered Step attempted different input or a different effect target",
        );
      }
      return existing;
    }
    const updatedAt = nextUpdatedAt(step.updated_at);
    const { data: updated, error: updateError } = await db
      .from("agent_steps")
      .update({
        result_data: {
          ...resultData,
          [AGENT_STEP_EFFECT_RECEIPT_KEY]: {
            ...receipts,
            [wanted.effect_key]: wanted,
          },
        },
        updated_at: updatedAt,
      })
      .eq("id", wanted.step_id)
      .eq("task_id", input.taskId)
      .eq("status", "running")
      .eq("updated_at", step.updated_at)
      .select("id")
      .maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (updated) return wanted;
  }
  throw new Error("The Step changed repeatedly before its effect was reserved");
}

export async function commitAgentStepEffect(
  db: Db,
  input: {
    taskId: string;
    receipt: AgentStepEffectReceiptV1;
    artifactType: "draft" | "tabular_review";
    documentId: string;
    versionId: string;
    committedAt?: string;
  },
) {
  const wanted = effectReceiptSchema.parse(input.receipt);
  if (
    input.documentId !== wanted.target.document_id ||
    input.versionId !== wanted.target.version_id
  ) {
    throw new Error("The created Artifact does not match its reserved target");
  }
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const { data: step, error } = await db
      .from("agent_steps")
      .select("id,result_data,updated_at")
      .eq("id", wanted.step_id)
      .eq("task_id", input.taskId)
      .eq("status", "running")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!step) throw new Error("The effect Step is no longer running");
    const resultData =
      step.result_data &&
      typeof step.result_data === "object" &&
      !Array.isArray(step.result_data)
        ? (step.result_data as Record<string, unknown>)
        : {};
    const receipts = readReceiptMap(resultData);
    const existing = receipts[wanted.effect_key];
    if (!existing || !sameReservation(existing, wanted)) {
      throw new Error("The reserved Step effect is missing or inconsistent");
    }
    if (existing.status === "committed") return existing;
    const committed = effectReceiptSchema.parse({
      ...existing,
      status: "committed",
      effect: {
        document_id: input.documentId,
        version_id: input.versionId,
        artifact_type: input.artifactType,
      },
      committed_at: input.committedAt ?? new Date().toISOString(),
    });
    const updatedAt = nextUpdatedAt(step.updated_at);
    const { data: updated, error: updateError } = await db
      .from("agent_steps")
      .update({
        result_data: {
          ...resultData,
          [AGENT_STEP_EFFECT_RECEIPT_KEY]: {
            ...receipts,
            [wanted.effect_key]: committed,
          },
        },
        updated_at: updatedAt,
      })
      .eq("id", wanted.step_id)
      .eq("task_id", input.taskId)
      .eq("status", "running")
      .eq("updated_at", step.updated_at)
      .select("id")
      .maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (updated) return committed;
  }
  throw new Error(
    "The Step changed repeatedly before its effect was committed",
  );
}

export function readAgentStepEffectReceipts(resultData: unknown) {
  return Object.values(readReceiptMap(resultData));
}
