import { z } from "zod";

import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

const uuid = z.string().uuid();

const correctionReasonSchema = z.enum([
  "citation_not_exact",
  "source_conflict",
  "material_omission",
]);

const correctionInputSchema = z
  .object({
    correctionId: uuid,
    taskId: uuid,
    userId: z.string().trim().min(1),
    stepId: uuid,
    expectedStepAttempt: z.number().int().positive(),
    reviewId: uuid,
    cellId: uuid,
    documentId: uuid,
    versionId: uuid,
    columnIndex: z.number().int().min(0),
    expectedReviewRevision: z.number().int().nonnegative(),
    reasonCode: correctionReasonSchema,
  })
  .strict();

const correctionResultSchema = z
  .object({
    outcome: z.enum([
      "started",
      "recovered",
      "artifact_invalid",
      "conflict",
      "invalid_input",
      "lease_busy",
      "not_found",
      "version_conflict",
    ]),
    task_status: z.string().nullable(),
    current_step: uuid.nullable(),
    cell_id: uuid.nullable(),
    cell_status: z.string().nullable(),
    review_status: z
      .enum(["verified", "unresolved", "needs_correction"])
      .nullable(),
    review_revision: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type LitigationEvidenceCellCorrectionResult = z.infer<
  typeof correctionResultSchema
>;
export type LitigationEvidenceCellCorrectionReasonCode = z.infer<
  typeof correctionReasonSchema
>;

export class LitigationEvidenceCellCorrectionTransitionError extends Error {
  constructor(
    readonly outcome: Exclude<
      LitigationEvidenceCellCorrectionResult["outcome"],
      "started" | "recovered"
    >,
    readonly facts: Record<string, unknown>,
  ) {
    super("The source-bound Evidence Inventory correction could not be started");
    this.name = "LitigationEvidenceCellCorrectionTransitionError";
  }
}

function firstRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Starts one bounded, server-validated Evidence Inventory Cell correction.
 * The RPC owns the Task pause, fixed source Version, review layout, CAS and
 * resume transition. Callers cannot provide a checkpoint or mutation payload.
 */
export async function startLitigationEvidenceCellCorrection(
  db: Db,
  input: z.input<typeof correctionInputSchema>,
) {
  const wanted = correctionInputSchema.parse(input);
  const { data, error } = await db.rpc(
    "start_litigation_evidence_cell_correction_v1",
    {
      p_correction_id: wanted.correctionId,
      p_task_id: wanted.taskId,
      p_user_id: wanted.userId,
      p_step_id: wanted.stepId,
      p_expected_step_attempt: wanted.expectedStepAttempt,
      p_review_id: wanted.reviewId,
      p_cell_id: wanted.cellId,
      p_document_id: wanted.documentId,
      p_version_id: wanted.versionId,
      p_column_index: wanted.columnIndex,
      p_expected_review_revision: wanted.expectedReviewRevision,
      p_reason_code: wanted.reasonCode,
    },
  );
  if (error) {
    throw new LitigationEvidenceCellCorrectionTransitionError(
      "invalid_input",
      {
        task_id: wanted.taskId,
        step_id: wanted.stepId,
        cell_id: wanted.cellId,
        database_error: error.message,
      },
    );
  }
  const parsed = correctionResultSchema.safeParse(firstRow(data));
  if (!parsed.success) {
    throw new LitigationEvidenceCellCorrectionTransitionError(
      "invalid_input",
      {
        task_id: wanted.taskId,
        step_id: wanted.stepId,
        cell_id: wanted.cellId,
        reason: "returned_litigation_evidence_correction_mismatch",
      },
    );
  }
  if (
    parsed.data.outcome !== "started" &&
    parsed.data.outcome !== "recovered"
  ) {
    throw new LitigationEvidenceCellCorrectionTransitionError(
      parsed.data.outcome,
      {
        task_id: wanted.taskId,
        step_id: wanted.stepId,
        cell_id: wanted.cellId,
        correction_id: wanted.correctionId,
        expected_step_attempt: wanted.expectedStepAttempt,
        expected_review_revision: wanted.expectedReviewRevision,
        reason_code: wanted.reasonCode,
      },
    );
  }
  return parsed.data;
}
