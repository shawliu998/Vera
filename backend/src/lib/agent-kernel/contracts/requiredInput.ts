import { z } from "zod";

import type { AskInputItem } from "../../chat/types";

const bounded = (maximum: number) => z.string().trim().min(1).max(maximum);

const choiceItemSchema = z
  .object({
    id: bounded(80),
    kind: z.literal("choice"),
    question: bounded(500),
    options: z
      .array(
        z
          .object({
            value: bounded(500),
            label: bounded(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    allow_other: z.boolean(),
    other_label: bounded(80),
    response_prefix: bounded(200).optional(),
  })
  .strict();
const documentsItemSchema = z
  .object({
    id: bounded(80),
    kind: z.literal("documents"),
    document_types: z.array(bounded(300)).min(1).max(8),
    required: z.boolean().default(true),
    response_prefix: bounded(200).optional(),
  })
  .strict();
const itemSchema = z.discriminatedUnion("kind", [
  choiceItemSchema,
  documentsItemSchema,
]);

export const agentRequiredInputSchema = z
  .object({
    kind: z.literal("required_input_v1"),
    request_id: bounded(80),
    step_id: bounded(200),
    reason_code: z.enum([
      "missing_source",
      "missing_fact",
      "lawyer_choice",
      "source_version_changed",
    ]),
    prompt: bounded(4000),
    items: z.array(itemSchema).min(1).max(12),
    resume_strategy: z.enum(["retry_step", "replan_remaining"]),
    created_at: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Required input item ids must be unique",
      });
    }
  });

export type AgentRequiredInputV1 = z.infer<typeof agentRequiredInputSchema>;

export const agentRequiredInputResponseSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z
        .object({
          id: bounded(80),
          kind: z.literal("choice"),
          answer: bounded(1_000),
        })
        .strict(),
      z
        .object({
          id: bounded(80),
          kind: z.literal("documents"),
          document_ids: z.array(bounded(200)).max(100),
        })
        .strict(),
    ]),
  )
  .max(12);

export type AgentRequiredInputResponseV1 = z.infer<
  typeof agentRequiredInputResponseSchema
>[number];

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

function stableHash(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function requestId(stepId: string, items: z.infer<typeof itemSchema>[]) {
  const identity = items.map((item) =>
    item.kind === "choice"
      ? [
          item.id,
          normalized(item.question),
          item.options.map((o) => [
            normalized(o.value),
            o.label ? normalized(o.label) : null,
          ]),
        ]
      : [item.id, item.required, item.document_types.map(normalized)],
  );
  return `ri_${stableHash(JSON.stringify([stepId, identity]))}`;
}

function prompt(items: z.infer<typeof itemSchema>[]) {
  return items
    .map((item) =>
      item.kind === "choice"
        ? item.question
        : `${item.required ? "Attach the required" : "Optionally attach supporting"} Matter document${item.document_types.length === 1 ? "" : "s"}: ${item.document_types.join(", ")}.`,
    )
    .join(" ")
    .slice(0, 4000);
}

export function createAgentRequiredInput(input: {
  stepId: string;
  items: AskInputItem[];
  reasonCode?: AgentRequiredInputV1["reason_code"];
  prompt?: string;
  resumeStrategy?: AgentRequiredInputV1["resume_strategy"];
  createdAt?: string;
}) {
  const items = z.array(itemSchema).min(1).max(12).parse(input.items);
  return agentRequiredInputSchema.parse({
    kind: "required_input_v1",
    request_id: requestId(input.stepId, items),
    step_id: input.stepId,
    reason_code:
      input.reasonCode ??
      (items.some((item) => item.kind === "documents" && item.required)
        ? "missing_source"
        : items.some((item) => item.kind === "choice")
          ? "lawyer_choice"
          : "missing_fact"),
    prompt: input.prompt?.trim() || prompt(items),
    items,
    resume_strategy: input.resumeStrategy ?? "retry_step",
    created_at: input.createdAt ?? new Date().toISOString(),
  });
}

function isContinuationOnly(item: z.infer<typeof itemSchema>) {
  if (item.kind !== "choice") return false;
  const generic =
    /\b(?:should|may|can) (?:i|vera) (?:continue|proceed)\b|\bdo you want (?:me|vera) to (?:continue|proceed)\b|是否(?:继续|开始)|要不要继续|继续吗/i.test(
      item.question,
    );
  return (
    generic &&
    item.options.every((option) =>
      /^(?:continue|proceed|yes|no|继续|是|否)$/i.test(option.value),
    )
  );
}

export function readAgentRequiredInput(value: unknown) {
  const result = agentRequiredInputSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function readResolvedRequiredInputIds(checkpoint: unknown) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    return [];
  }
  const values = (checkpoint as Record<string, unknown>)
    .resolved_required_input_ids;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
}

export function requiredInputFromAssistantEvents(
  events: unknown[],
  input: {
    stepId: string;
    createdAt?: string;
    resolvedRequestIds?: readonly string[];
  },
) {
  const resolved = new Set(input.resolvedRequestIds ?? []);
  const askEvents = events.filter(
    (event): event is { type: "ask_inputs"; items: unknown } =>
      Boolean(
        event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as { type?: unknown }).type === "ask_inputs",
      ),
  );
  for (const event of [...askEvents].reverse()) {
    const result = z.array(itemSchema).min(1).max(12).safeParse(event.items);
    if (!result.success) continue;
    const items = result.data.filter((item) => !isContinuationOnly(item));
    if (!items.length) continue;
    const id = requestId(input.stepId, items);
    if (resolved.has(id)) return null;
    return createAgentRequiredInput({
      stepId: input.stepId,
      items,
      createdAt: input.createdAt,
    });
  }
  return null;
}

export function validateRequiredInputSubmission(
  required: AgentRequiredInputV1,
  input: {
    message?: string;
    documentIds?: string[];
    responses?: unknown;
  },
) {
  const message = input.message?.trim() ?? "";
  const documentIds = input.documentIds ?? [];
  const responses =
    input.responses === undefined
      ? null
      : agentRequiredInputResponseSchema.parse(input.responses);
  if (responses) {
    const byId = new Map(responses.map((response) => [response.id, response]));
    const submittedDocumentIds = new Set(documentIds);
    if (byId.size !== responses.length) {
      throw new Error("Required input responses must be unique");
    }
    for (const item of required.items) {
      const response = byId.get(item.id);
      if (item.kind === "choice") {
        if (!response || response.kind !== "choice") {
          throw new Error(`A structured choice is required for ${item.id}`);
        }
        const fixed = item.options.some(
          (option) => option.value === response.answer,
        );
        if (!fixed && !item.allow_other) {
          throw new Error(`Choice ${item.id} is outside the fixed options`);
        }
      } else {
        if (
          item.required &&
          (!response ||
            response.kind !== "documents" ||
            response.document_ids.length === 0)
        ) {
          throw new Error(`Matter documents are required for ${item.id}`);
        }
        if (response?.kind === "documents") {
          const responseIds = new Set(response.document_ids);
          if (
            responseIds.size !== response.document_ids.length ||
            responseIds.size !== submittedDocumentIds.size ||
            [...responseIds].some((id) => !submittedDocumentIds.has(id))
          ) {
            throw new Error(
              `Matter document response ${item.id} does not match the submitted documents`,
            );
          }
        }
      }
    }
    if (
      responses.some(
        (response) =>
          !required.items.some(
            (item) => item.id === response.id && item.kind === response.kind,
          ),
      )
    ) {
      throw new Error("Required input contains an unknown response item");
    }
  }
  if (
    !responses &&
    required.items.some((item) => item.kind === "documents" && item.required) &&
    documentIds.length === 0
  ) {
    throw new Error("The requested Matter document is required to continue");
  }
  if (
    !responses &&
    required.items.some((item) => item.kind === "choice") &&
    !message
  ) {
    throw new Error("The requested lawyer choice is required to continue");
  }
  return {
    requestId: required.request_id,
    message,
    documentIds,
    responses,
  };
}

export function requiredInputCheckpointValue(required: AgentRequiredInputV1) {
  return agentRequiredInputSchema.parse(required);
}

export function createDocumentsRequiredInput(input: {
  stepId: string;
  prompt?: string;
  documentTypes?: string[];
  createdAt?: string;
}) {
  const items = [
    {
      id: "required-source-documents",
      kind: "documents" as const,
      required: true,
      document_types: input.documentTypes
        ?.map((value) => value.trim())
        .filter(Boolean) ?? ["Source documents"],
    },
  ];
  return createAgentRequiredInput({
    stepId: input.stepId,
    reasonCode: "missing_source",
    prompt:
      input.prompt ??
      "Attach the Matter source documents required for this step.",
    items,
    createdAt: input.createdAt,
  });
}

export function askInputItems(required: AgentRequiredInputV1): AskInputItem[] {
  return required.items;
}
