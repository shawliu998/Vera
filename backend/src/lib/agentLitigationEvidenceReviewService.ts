import { z } from "zod";

import type { createServerSupabase } from "./supabase";
import {
  litigationEvidenceCitationIsExact,
  loadFixedLitigationEvidenceSource,
} from "./agentLitigationEvidenceInventoryGeneration";
import { reviewLitigationEvidenceCell } from "./agentLitigationEvidenceCellRepository";
import {
  litigationEvidenceInventoryReceiptSchema,
  type LitigationEvidenceInventoryReceiptV1,
} from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import {
  inspectLitigationEvidenceInventoryReview,
  litigationEvidenceStoredCellSchema,
} from "./agent-packs/litigation/litigationEvidenceInventoryReview";

type Db = ReturnType<typeof createServerSupabase>;

export class LitigationEvidenceReviewAccessError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "review_not_active"
      | "review_invalid"
      | "citation_unrelocatable",
    message: string,
  ) {
    super(message);
    this.name = "LitigationEvidenceReviewAccessError";
  }
}

async function loadTaskOwnedReview(input: {
  db: Db;
  reviewId: string;
  userId: string;
}) {
  const { data: links, error: linkError } = await input.db
    .from("agent_artifact_links")
    .select("task_id")
    .eq("artifact_type", "tabular_review")
    .eq("artifact_id", input.reviewId);
  if (linkError) throw new Error(linkError.message);
  const taskIds = Array.from(
    new Set((links ?? []).map((link) => String(link.task_id))),
  );
  if (!taskIds.length) {
    throw new LitigationEvidenceReviewAccessError(
      "not_found",
      "Task-owned Evidence Inventory not found",
    );
  }
  const { data: tasks, error: taskError } = await input.db
    .from("agent_tasks")
    .select("id,user_id,matter_id,status,latest_checkpoint")
    .eq("user_id", input.userId)
    .in("id", taskIds);
  if (taskError) throw new Error(taskError.message);
  const matches = (tasks ?? []).flatMap((task) => {
    const checkpoint =
      task.latest_checkpoint &&
      typeof task.latest_checkpoint === "object" &&
      !Array.isArray(task.latest_checkpoint)
        ? (task.latest_checkpoint as Record<string, unknown>)
        : null;
    const parsed = litigationEvidenceInventoryReceiptSchema.safeParse(
      checkpoint?.litigation_evidence_inventory_receipt,
    );
    return parsed.success && parsed.data.review_id === input.reviewId
      ? [{ task, receipt: parsed.data }]
      : [];
  });
  if (matches.length !== 1) {
    throw new LitigationEvidenceReviewAccessError(
      "review_invalid",
      "Evidence Inventory does not resolve to one fixed Task receipt",
    );
  }
  return matches[0]!;
}

async function readInspection(input: {
  db: Db;
  receipt: LitigationEvidenceInventoryReceiptV1;
  userId: string;
}) {
  const { data: review, error: reviewError } = await input.db
    .from("tabular_reviews")
    .select("id,project_id,user_id,row_protocol")
    .eq("id", input.receipt.review_id)
    .maybeSingle();
  if (reviewError) throw new Error(reviewError.message);
  if (
    !review ||
    review.project_id !== input.receipt.matter_id ||
    review.user_id !== input.userId ||
    review.row_protocol !== "document_rows"
  ) {
    throw new LitigationEvidenceReviewAccessError(
      "review_invalid",
      "Evidence Inventory layout or Matter ownership changed",
    );
  }
  const { data: cells, error: cellError } = await input.db
    .from("tabular_cells")
    .select(
      "id,review_id,document_id,row_id,column_index,status,content,citations,review_status,reviewed_at,review_revision",
    )
    .eq("review_id", input.receipt.review_id);
  if (cellError) throw new Error(cellError.message);
  try {
    return inspectLitigationEvidenceInventoryReview({
      receipt: input.receipt,
      cells: z.array(litigationEvidenceStoredCellSchema).parse(cells ?? []),
    });
  } catch (error) {
    throw new LitigationEvidenceReviewAccessError(
      "review_invalid",
      error instanceof Error ? error.message : "Evidence Inventory is invalid",
    );
  }
}

export async function getLitigationEvidenceReviewProgress(input: {
  db: Db;
  reviewId: string;
  userId: string;
}) {
  const ownership = await loadTaskOwnedReview(input);
  const inspection = await readInspection({
    db: input.db,
    receipt: ownership.receipt,
    userId: input.userId,
  });
  return {
    task_id: ownership.task.id as string,
    task_status: ownership.task.status as string,
    review_id: ownership.receipt.review_id,
    context: {
      procedural_stage: ownership.receipt.procedural_stage,
      represented_side: ownership.receipt.represented_side,
    },
    progress: inspection.progress,
  };
}

export async function applyLitigationEvidenceLawyerReview(input: {
  db: Db;
  reviewId: string;
  cellId: string;
  userId: string;
  expectedRevision: number;
  decision: "verified" | "unresolved" | "needs_correction";
}) {
  const ownership = await loadTaskOwnedReview(input);
  if (ownership.task.status !== "waiting_input") {
    throw new LitigationEvidenceReviewAccessError(
      "review_not_active",
      "This Evidence Inventory is not currently awaiting lawyer review",
    );
  }
  const inspection = await readInspection({
    db: input.db,
    receipt: ownership.receipt,
    userId: input.userId,
  });
  const cell = inspection.cells.find(
    (candidate) => candidate.id === input.cellId,
  );
  if (!cell) {
    throw new LitigationEvidenceReviewAccessError(
      "not_found",
      "Evidence Inventory Cell not found",
    );
  }
  if (input.decision === "verified") {
    const content = inspection.generatedContent.get(cell.id);
    if (!content) {
      throw new LitigationEvidenceReviewAccessError(
        "citation_unrelocatable",
        "A source-bound gap cannot be marked verified",
      );
    }
    const source = await loadFixedLitigationEvidenceSource({
      db: input.db,
      receipt: ownership.receipt,
      documentId: cell.document_id,
      userId: input.userId,
    });
    if (
      content.candidate.citations.some(
        (citation) =>
          !litigationEvidenceCitationIsExact({
            source: source.source,
            quote: citation.quote,
            locator: citation.locator,
            versionId: citation.version_id,
            currentVersionId: source.currentVersionId,
          }),
      )
    ) {
      throw new LitigationEvidenceReviewAccessError(
        "citation_unrelocatable",
        "One or more Cell quotations no longer relocate exactly in the fixed source Version",
      );
    }
  }
  const reviewed = await reviewLitigationEvidenceCell(input.db, {
    userId: input.userId,
    reviewId: input.reviewId,
    cellId: input.cellId,
    expectedRevision: input.expectedRevision,
    reviewStatus: input.decision,
  });
  const refreshed = await getLitigationEvidenceReviewProgress({
    db: input.db,
    reviewId: input.reviewId,
    userId: input.userId,
  });
  return { cell: reviewed, ...refreshed };
}
