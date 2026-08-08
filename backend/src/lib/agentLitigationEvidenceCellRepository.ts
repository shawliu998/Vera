import { z } from "zod";

import { AgentStepEffectTransitionError } from "./agent-kernel/effects/stepEffect";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

const uuid = z.string().uuid();
const jsonRecordSchema = z.object({}).catchall(z.unknown());
export const MAX_LITIGATION_EVIDENCE_CELL_CONTENT_CHARS = 120_000;
const litigationEvidenceCellContentSchema = z
  .object({
    kind: z.literal("litigation_evidence_inventory_cell_content_v1"),
    candidate: jsonRecordSchema,
    summary: z.string().trim().min(1).max(12_000),
    reasoning: z.string().trim().min(1).max(4_000),
    flag: z.literal("grey"),
    model_review_status: z.literal("unverified"),
  })
  .strict();

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

function firstRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function serializeBoundedLitigationCellJson(value: unknown, label: string) {
  const serialized = canonical(value);
  if (serialized.length > MAX_LITIGATION_EVIDENCE_CELL_CONTENT_CHARS) {
    throw new RangeError(
      `${label} exceeds the ${MAX_LITIGATION_EVIDENCE_CELL_CONTENT_CHARS}-character litigation cell limit`,
    );
  }
  return serialized;
}

const litigationEvidenceCellCommitInputSchema = z
  .object({
    taskId: uuid,
    userId: z.string().trim().min(1),
    stepId: uuid,
    attempt: z.number().int().positive(),
    leaseOwner: uuid,
    reviewId: uuid,
    cellId: uuid,
    documentId: uuid,
    versionId: uuid,
    columnIndex: z.number().int().min(0),
    content: litigationEvidenceCellContentSchema,
    citations: z.array(jsonRecordSchema).min(1).max(24),
  })
  .strict();

const litigationEvidenceCellResultSchema = z
  .object({
    outcome: z.enum([
      "committed",
      "recovered",
      "review_locked",
      "artifact_invalid",
      "conflict",
      "invalid_input",
      "lease_lost",
      "not_found",
    ]),
    cell_id: uuid.nullable(),
    cell_status: z.string().nullable(),
    review_status: z
      .enum(["verified", "unresolved", "needs_correction"])
      .nullable(),
    review_revision: z.number().int().nonnegative().nullable(),
    reviewed_at: z.string().datetime().nullable(),
  })
  .strict();

export type LitigationEvidenceCellCommitResult = z.infer<
  typeof litigationEvidenceCellResultSchema
>;

function readLitigationEvidenceCellCommitResult(
  data: unknown,
  input: {
    taskId: string;
    userId: string;
    stepId: string;
    attempt: number;
    leaseOwner: string;
  },
) {
  const parsed = litigationEvidenceCellResultSchema.safeParse(firstRow(data));
  if (!parsed.success) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: input.taskId,
      step_id: input.stepId,
      reason: "returned_litigation_cell_commit_mismatch",
    });
  }
  if (
    parsed.data.outcome === "artifact_invalid" ||
    parsed.data.outcome === "conflict" ||
    parsed.data.outcome === "invalid_input" ||
    parsed.data.outcome === "lease_lost" ||
    parsed.data.outcome === "not_found"
  ) {
    throw new AgentStepEffectTransitionError(parsed.data.outcome, {
      task_id: input.taskId,
      user_id: input.userId,
      step_id: input.stepId,
      step_attempt: input.attempt,
      lease_owner: input.leaseOwner,
      effect_kind: "litigation_evidence_cell",
    });
  }
  return parsed.data;
}

/**
 * Commit one already server-bound Evidence Inventory candidate. The RPC owns
 * the Task lease, fixed Review/cell/version checks and exact replay handling;
 * this adapter only serializes the validated existing Tabular cell fields.
 */
export async function commitAgentLitigationEvidenceCell(
  db: Db,
  input: z.input<typeof litigationEvidenceCellCommitInputSchema>,
) {
  const wanted = litigationEvidenceCellCommitInputSchema.parse(input);
  const serializedContent = serializeBoundedLitigationCellJson(
    wanted.content,
    "Litigation cell content",
  );
  const serializedCitations = serializeBoundedLitigationCellJson(
    wanted.citations,
    "Litigation cell citations",
  );
  const { data, error } = await db.rpc(
    "commit_agent_litigation_evidence_cell_v1",
    {
      p_task_id: wanted.taskId,
      p_user_id: wanted.userId,
      p_step_id: wanted.stepId,
      p_step_attempt: wanted.attempt,
      p_lease_owner: wanted.leaseOwner,
      p_review_id: wanted.reviewId,
      p_cell_id: wanted.cellId,
      p_document_id: wanted.documentId,
      p_version_id: wanted.versionId,
      p_column_index: wanted.columnIndex,
      p_content: serializedContent,
      p_citations: JSON.parse(serializedCitations),
    },
  );
  if (error) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      task_id: wanted.taskId,
      step_id: wanted.stepId,
      database_error: error.message,
      effect_kind: "litigation_evidence_cell",
    });
  }
  return readLitigationEvidenceCellCommitResult(data, wanted);
}

const litigationEvidenceCellReviewInputSchema = z
  .object({
    userId: z.string().trim().min(1),
    reviewId: uuid,
    cellId: uuid,
    expectedRevision: z.number().int().nonnegative(),
    reviewStatus: z.enum(["verified", "unresolved", "needs_correction"]),
  })
  .strict();

const litigationEvidenceCellReviewResultSchema =
  litigationEvidenceCellResultSchema
    .extend({
      outcome: z.enum([
        "reviewed",
        "artifact_invalid",
        "conflict",
        "invalid_input",
        "not_found",
      ]),
    })
    .strict();

/**
 * A lawyer disposition is an explicit compare-and-swap. It deliberately
 * leaves generated content and citations unchanged for later source review.
 */
export async function reviewLitigationEvidenceCell(
  db: Db,
  input: z.input<typeof litigationEvidenceCellReviewInputSchema>,
) {
  const wanted = litigationEvidenceCellReviewInputSchema.parse(input);
  const { data, error } = await db.rpc("review_litigation_evidence_cell_v1", {
    p_user_id: wanted.userId,
    p_review_id: wanted.reviewId,
    p_cell_id: wanted.cellId,
    p_expected_review_revision: wanted.expectedRevision,
    p_review_status: wanted.reviewStatus,
  });
  if (error) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      review_id: wanted.reviewId,
      cell_id: wanted.cellId,
      database_error: error.message,
      effect_kind: "litigation_evidence_cell_review",
    });
  }
  const parsed = litigationEvidenceCellReviewResultSchema.safeParse(
    firstRow(data),
  );
  if (!parsed.success) {
    throw new AgentStepEffectTransitionError("invalid_input", {
      review_id: wanted.reviewId,
      cell_id: wanted.cellId,
      reason: "returned_litigation_cell_review_mismatch",
    });
  }
  if (
    parsed.data.outcome === "artifact_invalid" ||
    parsed.data.outcome === "conflict" ||
    parsed.data.outcome === "invalid_input" ||
    parsed.data.outcome === "not_found"
  ) {
    throw new AgentStepEffectTransitionError(parsed.data.outcome, {
      review_id: wanted.reviewId,
      cell_id: wanted.cellId,
      expected_review_revision: wanted.expectedRevision,
      effect_kind: "litigation_evidence_cell_review",
    });
  }
  return parsed.data;
}
