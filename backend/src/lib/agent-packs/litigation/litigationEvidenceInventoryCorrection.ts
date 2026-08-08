import { createHash } from "node:crypto";

import { z } from "zod";

import {
  litigationEvidenceInventoryReceiptSchema,
  type LitigationEvidenceInventoryReceiptV1,
} from "./litigationEvidenceInventoryPack";

const uuid = z.string().uuid();

/**
 * The lawyer may ask for one more source-bound attempt, but never provide a
 * replacement answer. These codes describe the bounded defect in the
 * existing candidate and are deliberately not free-form instructions.
 */
export const litigationEvidenceCorrectionReasonCodeSchema = z.enum([
  "citation_not_exact",
  "source_conflict",
  "material_omission",
]);
export type LitigationEvidenceCorrectionReasonCode = z.infer<
  typeof litigationEvidenceCorrectionReasonCodeSchema
>;

export const litigationEvidenceInventoryCorrectionReceiptSchema = z
  .object({
    kind: z.literal("litigation_evidence_inventory_cell_correction_v1"),
    correction_id: uuid,
    task_id: uuid,
    review_id: uuid,
    step_id: uuid,
    /** The one new Step attempt reserved by the server-owned RPC. */
    generation_step_attempt: z.number().int().positive(),
    cell_id: uuid,
    document_id: uuid,
    version_id: uuid,
    field: z.enum([
      "evidence_item",
      "authenticity",
      "admissibility",
      "relevance",
      "purpose_of_proof",
    ]),
    field_index: z.number().int().min(0).max(4),
    expected_review_revision: z.number().int().nonnegative(),
    reason_code: litigationEvidenceCorrectionReasonCodeSchema,
    /**
     * This is a digest of the immutable binding, not the transient Step
     * attempt. A correction intentionally increments the latter.
     */
    source_binding_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    max_attempts: z.literal(1),
    requested_at: z.string().datetime(),
  })
  .strict();
export type LitigationEvidenceInventoryCorrectionReceiptV1 = z.infer<
  typeof litigationEvidenceInventoryCorrectionReceiptSchema
>;

export const litigationEvidenceInventoryCorrectionIssueSchema = z
  .object({
    code: z.literal("source_bound_correction_incomplete"),
    correction_id: uuid,
    cell_id: uuid,
    document_id: uuid,
    version_id: uuid,
    field: z.enum([
      "evidence_item",
      "authenticity",
      "admissibility",
      "relevance",
      "purpose_of_proof",
    ]),
    reason_code: litigationEvidenceCorrectionReasonCodeSchema,
    attempts_exhausted: z.literal(1),
  })
  .strict();
export type LitigationEvidenceInventoryCorrectionIssueV1 = z.infer<
  typeof litigationEvidenceInventoryCorrectionIssueSchema
>;

/**
 * The Evidence Inventory receipt already has a canonical layout digest over
 * its source pins, fields, cells, procedural context and review identity.
 * Excluding its transient Step `attempt` is intentional: a correction
 * reserves one new attempt while its fixed source/layout must not move.
 */
export function litigationEvidenceInventoryBindingFingerprint(
  rawReceipt: LitigationEvidenceInventoryReceiptV1,
) {
  const receipt = litigationEvidenceInventoryReceiptSchema.parse(rawReceipt);
  const layout = {
    review_id: receipt.review_id,
    procedural_stage: receipt.procedural_stage,
    represented_side: receipt.represented_side,
    source_pins: receipt.source_pins,
    fields: receipt.fields,
    cells: receipt.cells,
  };
  const expected = `sha256:${createHash("sha256")
    .update(canonical(layout))
    .digest("hex")}`;
  if (receipt.layout_digest !== expected) {
    throw new Error(
      "The Evidence Inventory receipt layout digest no longer matches its fixed source binding",
    );
  }
  return receipt.layout_digest;
}

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

export function compileLitigationEvidenceInventoryCorrectionReceipt(input: {
  correctionId: string;
  receipt: LitigationEvidenceInventoryReceiptV1;
  cellId: string;
  expectedReviewRevision: number;
  reasonCode: LitigationEvidenceCorrectionReasonCode;
  generationStepAttempt: number;
  requestedAt?: string;
}) {
  const receipt = litigationEvidenceInventoryReceiptSchema.parse(input.receipt);
  const cell = receipt.cells.find((candidate) => candidate.cell_id === input.cellId);
  if (!cell) {
    throw new Error("The requested correction Cell is outside the fixed Evidence Inventory receipt");
  }
  return litigationEvidenceInventoryCorrectionReceiptSchema.parse({
    kind: "litigation_evidence_inventory_cell_correction_v1",
    correction_id: input.correctionId,
    task_id: receipt.task_id,
    review_id: receipt.review_id,
    step_id: receipt.step_id,
    generation_step_attempt: input.generationStepAttempt,
    cell_id: cell.cell_id,
    document_id: cell.document_id,
    version_id: cell.version_id,
    field: cell.field,
    field_index: cell.field_index,
    expected_review_revision: input.expectedReviewRevision,
    reason_code: input.reasonCode,
    source_binding_fingerprint:
      litigationEvidenceInventoryBindingFingerprint(receipt),
    max_attempts: 1,
    requested_at: input.requestedAt ?? new Date().toISOString(),
  });
}

/** Reject stale/cross-task correction data before any provider request. */
export function readLitigationEvidenceInventoryCorrectionReceipt(input: {
  value: unknown;
  receipt: LitigationEvidenceInventoryReceiptV1;
  currentStepAttempt: number;
}) {
  if (input.value === undefined) return null;
  const parsed = litigationEvidenceInventoryCorrectionReceiptSchema.safeParse(
    input.value,
  );
  if (!parsed.success) {
    throw new Error(
      "The source-bound Evidence Inventory correction receipt is malformed",
    );
  }
  const receipt = litigationEvidenceInventoryReceiptSchema.parse(input.receipt);
  const correction = parsed.data;
  const cell = receipt.cells.find(
    (candidate) => candidate.cell_id === correction.cell_id,
  );
  if (
    correction.task_id !== receipt.task_id ||
    correction.review_id !== receipt.review_id ||
    correction.step_id !== receipt.step_id ||
    correction.generation_step_attempt !== input.currentStepAttempt ||
    correction.source_binding_fingerprint !==
      litigationEvidenceInventoryBindingFingerprint(receipt) ||
    !cell ||
    cell.document_id !== correction.document_id ||
    cell.version_id !== correction.version_id ||
    cell.field !== correction.field ||
    cell.field_index !== correction.field_index
  ) {
    throw new Error(
      "The source-bound Evidence Inventory correction no longer matches its fixed Task receipt",
    );
  }
  return correction;
}

export function preserveLitigationEvidenceInventoryCorrectionGap(input: {
  correction: LitigationEvidenceInventoryCorrectionReceiptV1;
}) {
  const correction = litigationEvidenceInventoryCorrectionReceiptSchema.parse(
    input.correction,
  );
  return litigationEvidenceInventoryCorrectionIssueSchema.parse({
    code: "source_bound_correction_incomplete",
    correction_id: correction.correction_id,
    cell_id: correction.cell_id,
    document_id: correction.document_id,
    version_id: correction.version_id,
    field: correction.field,
    reason_code: correction.reason_code,
    attempts_exhausted: 1,
  });
}
