import { createHash } from "node:crypto";

import { z } from "zod";

import { litigationEvidenceInventoryCellContentSchema } from "./litigationEvidenceInventoryCellContent";
import {
  litigationEvidenceInventoryReceiptSchema,
  type LitigationEvidenceInventoryReceiptV1,
} from "./litigationEvidenceInventoryPack";

const uuid = z.string().uuid();
const reviewDecisionSchema = z.enum([
  "verified",
  "unresolved",
  "needs_correction",
]);

export const litigationEvidenceStoredCellSchema = z
  .object({
    id: uuid,
    review_id: uuid,
    document_id: uuid,
    row_id: z.null(),
    column_index: z.number().int().min(0),
    status: z.enum(["pending", "done"]),
    content: z.string().nullable(),
    citations: z.unknown().nullable(),
    review_status: reviewDecisionSchema.nullable(),
    reviewed_at: z.string().datetime().nullable(),
    review_revision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((cell, context) => {
    if (
      (cell.review_status === null && cell.reviewed_at !== null) ||
      (cell.review_status !== null && cell.reviewed_at === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewed_at"],
        message: "Lawyer disposition and review timestamp must move together",
      });
    }
  });
export type LitigationEvidenceStoredCellV1 = z.infer<
  typeof litigationEvidenceStoredCellSchema
>;

export const litigationEvidenceReviewCompletionReceiptSchema = z
  .object({
    kind: z.literal("litigation_evidence_review_completion_v1"),
    task_id: uuid,
    review_id: uuid,
    step_id: uuid,
    source_receipt_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    decision_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    verified_cells: z.number().int().min(0).max(500),
    unresolved_cells: z.number().int().min(0).max(500),
    completed_at: z.string().datetime(),
  })
  .strict();
export type LitigationEvidenceReviewCompletionReceiptV1 = z.infer<
  typeof litigationEvidenceReviewCompletionReceiptSchema
>;

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

function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function parseContent(cell: LitigationEvidenceStoredCellV1) {
  if (cell.status === "pending") {
    if (cell.content !== null || cell.citations !== null) {
      throw new Error(
        "A pending Evidence Inventory Cell contains generated data",
      );
    }
    return null;
  }
  if (!cell.content || !Array.isArray(cell.citations)) {
    throw new Error("A completed Evidence Inventory Cell is missing content");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cell.content);
  } catch {
    throw new Error("Evidence Inventory Cell content is malformed");
  }
  const content =
    litigationEvidenceInventoryCellContentSchema.parse(parsedJson);
  if (canonical(content.candidate.citations) !== canonical(cell.citations)) {
    throw new Error(
      "Evidence Inventory Cell citations drifted from its candidate",
    );
  }
  return content;
}

export function inspectLitigationEvidenceInventoryReview(input: {
  receipt: LitigationEvidenceInventoryReceiptV1;
  cells: LitigationEvidenceStoredCellV1[];
}) {
  const receipt = litigationEvidenceInventoryReceiptSchema.parse(input.receipt);
  const cells = z.array(litigationEvidenceStoredCellSchema).parse(input.cells);
  if (cells.length !== receipt.cells.length) {
    throw new Error(
      "Evidence Inventory Cell count no longer matches its receipt",
    );
  }
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  if (byId.size !== cells.length) {
    throw new Error("Evidence Inventory contains duplicate Cell identities");
  }

  const generatedContent = new Map<string, ReturnType<typeof parseContent>>();
  for (const expected of receipt.cells) {
    const cell = byId.get(expected.cell_id);
    if (
      !cell ||
      cell.review_id !== receipt.review_id ||
      cell.document_id !== expected.document_id ||
      cell.column_index !== expected.field_index
    ) {
      throw new Error(
        "Evidence Inventory Cell layout drifted from its receipt",
      );
    }
    const content = parseContent(cell);
    if (
      content &&
      (content.candidate.cell_id !== expected.cell_id ||
        content.candidate.document_id !== expected.document_id ||
        content.candidate.version_id !== expected.version_id ||
        content.candidate.result.field !== expected.field)
    ) {
      throw new Error(
        "Evidence Inventory generated content crossed its fixed Cell",
      );
    }
    if (cell.review_status === "verified" && !content) {
      throw new Error("An unresolved generated gap cannot be marked verified");
    }
    generatedContent.set(cell.id, content);
  }

  const ordered = receipt.cells.map((expected) => byId.get(expected.cell_id)!);
  const generated = ordered.filter((cell) => cell.status === "done").length;
  const verified = ordered.filter(
    (cell) => cell.review_status === "verified",
  ).length;
  const unresolved = ordered.filter(
    (cell) => cell.review_status === "unresolved",
  ).length;
  const needsCorrection = ordered.filter(
    (cell) => cell.review_status === "needs_correction",
  ).length;
  const firstIncomplete = ordered.find(
    (cell) =>
      cell.review_status === null || cell.review_status === "needs_correction",
  );
  return {
    cells: ordered,
    generatedContent,
    progress: {
      total: ordered.length,
      generated,
      verified,
      unresolved,
      needs_correction: needsCorrection,
      remaining: ordered.length - verified - unresolved,
      first_incomplete_cell_id: firstIncomplete?.id ?? null,
    },
    complete: !firstIncomplete,
  };
}

export function compileLitigationEvidenceReviewCompletionReceipt(input: {
  receipt: LitigationEvidenceInventoryReceiptV1;
  cells: LitigationEvidenceStoredCellV1[];
  completedAt?: string;
}) {
  const receipt = litigationEvidenceInventoryReceiptSchema.parse(input.receipt);
  const inspection = inspectLitigationEvidenceInventoryReview({
    receipt,
    cells: input.cells,
  });
  if (!inspection.complete) {
    throw new Error("Evidence Inventory lawyer review is incomplete");
  }
  return litigationEvidenceReviewCompletionReceiptSchema.parse({
    kind: "litigation_evidence_review_completion_v1",
    task_id: receipt.task_id,
    review_id: receipt.review_id,
    step_id: receipt.step_id,
    source_receipt_fingerprint: digest(receipt),
    decision_fingerprint: digest(
      inspection.cells.map((cell) => ({
        cell_id: cell.id,
        status: cell.status,
        review_status: cell.review_status,
        reviewed_at: cell.reviewed_at,
        review_revision: cell.review_revision,
        content: cell.content,
        citations: cell.citations,
      })),
    ),
    verified_cells: inspection.progress.verified,
    unresolved_cells: inspection.progress.unresolved,
    completed_at: input.completedAt ?? new Date().toISOString(),
  });
}
