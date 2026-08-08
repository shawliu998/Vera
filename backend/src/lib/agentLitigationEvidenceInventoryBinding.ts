import {
  buildAgentStepTabularEffectReservation,
  readAgentStepTabularEffectReceipts,
} from "./agent-kernel/effects/tabularEffect";
import {
  compileLitigationEvidenceReviewCompletionReceipt,
  inspectLitigationEvidenceInventoryReview,
  litigationEvidenceReviewCompletionReceiptSchema,
  litigationEvidenceStoredCellSchema,
  type LitigationEvidenceStoredCellV1,
} from "./agent-packs/litigation/litigationEvidenceInventoryReview";
import {
  compileLitigationEvidenceInventoryReceipt,
  litigationEvidenceInventoryReceiptSchema,
  type LitigationEvidenceInventoryReceiptV1,
} from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import {
  buildLitigationEvidenceEffectLayout,
  buildLitigationEvidenceReviewSpec,
} from "./agentLitigationEvidenceInventoryExecutor";

type PublicationStep = {
  id: string;
  status: string;
  attempt: number;
  result_data?: unknown;
};

type ReviewShape = {
  id: string;
  project_id: string | null;
  user_id: string | null;
  title: string | null;
  practice: string | null;
  row_protocol: string | null;
  workflow_id: string | null;
  document_ids: unknown;
  columns_config: unknown;
};

export type LitigationEvidenceInventoryBindingSnapshot = {
  task: {
    id: string;
    matter_id: string;
    current_plan: PublicationStep[];
  };
};

export type LitigationEvidenceInventoryBindingFailure =
  | "receipt_mismatch"
  | "layout_mismatch"
  | "publication_mismatch"
  | "review_incomplete"
  | "completion_mismatch";

export type LitigationEvidenceInventoryBinding = {
  receipt: LitigationEvidenceInventoryReceiptV1;
  completion: ReturnType<
    typeof compileLitigationEvidenceReviewCompletionReceipt
  >;
  inspection: ReturnType<typeof inspectLitigationEvidenceInventoryReview>;
};

export type LitigationEvidenceInventoryBindingRead =
  | { status: "valid"; binding: LitigationEvidenceInventoryBinding }
  | { status: "invalid"; reason: LitigationEvidenceInventoryBindingFailure };

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

/**
 * Re-establishes the server-owned relation between a completed Evidence
 * Inventory, its exact tabular publication effect, and its completed lawyer
 * decisions. This is intentionally a domain adapter outside Agent Kernel: it
 * depends on Litigation receipt semantics while the Kernel remains generic.
 */
export function readCurrentLitigationEvidenceInventoryBinding(input: {
  snapshot: LitigationEvidenceInventoryBindingSnapshot;
  receipt: unknown;
  completion: unknown;
  review: ReviewShape;
  cells: unknown[];
}): LitigationEvidenceInventoryBindingRead {
  const receiptRead = litigationEvidenceInventoryReceiptSchema.safeParse(
    input.receipt,
  );
  const completionRead =
    litigationEvidenceReviewCompletionReceiptSchema.safeParse(input.completion);
  if (!receiptRead.success || !completionRead.success) {
    return { status: "invalid", reason: "receipt_mismatch" };
  }
  const receipt = receiptRead.data;
  const completion = completionRead.data;
  if (
    receipt.task_id !== input.snapshot.task.id ||
    receipt.matter_id !== input.snapshot.task.matter_id ||
    receipt.review_id !== input.review.id ||
    completion.task_id !== receipt.task_id ||
    completion.review_id !== receipt.review_id ||
    completion.step_id !== receipt.step_id
  ) {
    return { status: "invalid", reason: "receipt_mismatch" };
  }

  let recomputed: LitigationEvidenceInventoryReceiptV1;
  let expectedReview: ReturnType<typeof buildLitigationEvidenceReviewSpec>;
  let expectedEffect: ReturnType<typeof buildAgentStepTabularEffectReservation>;
  try {
    recomputed = compileLitigationEvidenceInventoryReceipt({
      taskId: receipt.task_id,
      matterId: receipt.matter_id,
      stepId: receipt.step_id,
      attempt: receipt.attempt,
      proceduralStage: receipt.procedural_stage,
      representedSide: receipt.represented_side,
      sourcePins: receipt.source_pins,
    });
    expectedReview = buildLitigationEvidenceReviewSpec(recomputed);
    expectedEffect = buildAgentStepTabularEffectReservation({
      stepId: recomputed.step_id,
      attempt: recomputed.attempt,
      reviewId: recomputed.review_id,
      layout: buildLitigationEvidenceEffectLayout(expectedReview),
    });
  } catch {
    return { status: "invalid", reason: "receipt_mismatch" };
  }
  if (
    canonical(receipt) !== canonical(recomputed) ||
    input.review.project_id !== expectedReview.project_id ||
    input.review.title !== expectedReview.title ||
    input.review.practice !== expectedReview.practice ||
    input.review.row_protocol !== expectedReview.row_protocol ||
    input.review.workflow_id !== expectedReview.workflow_id ||
    canonical(input.review.document_ids) !==
      canonical(expectedReview.document_ids) ||
    canonical(input.review.columns_config) !==
      canonical(expectedReview.columns_config)
  ) {
    return { status: "invalid", reason: "layout_mismatch" };
  }

  const publicationStep = input.snapshot.task.current_plan.find(
    (step) => step.id === receipt.step_id,
  );
  if (
    !publicationStep ||
    publicationStep.status !== "completed" ||
    publicationStep.attempt !== receipt.attempt
  ) {
    return { status: "invalid", reason: "publication_mismatch" };
  }
  try {
    const matchingEffects = readAgentStepTabularEffectReceipts(
      publicationStep.result_data,
    ).filter(
      (effect) =>
        effect.status === "committed" &&
        effect.effect_key === expectedEffect.effect_key &&
        effect.step_id === expectedEffect.step_id &&
        effect.attempt === expectedEffect.attempt &&
        effect.input_fingerprint === expectedEffect.input_fingerprint &&
        effect.target.review_id === expectedEffect.target.review_id &&
        effect.effect?.review_id === expectedEffect.target.review_id,
    );
    if (matchingEffects.length !== 1) {
      return { status: "invalid", reason: "publication_mismatch" };
    }
  } catch {
    return { status: "invalid", reason: "publication_mismatch" };
  }

  let storedCells: LitigationEvidenceStoredCellV1[];
  let inspection: ReturnType<typeof inspectLitigationEvidenceInventoryReview>;
  try {
    storedCells = input.cells.map((cell) =>
      litigationEvidenceStoredCellSchema.parse({
        ...(cell as Record<string, unknown>),
        review_status:
          (cell as { review_status?: unknown }).review_status ?? null,
        reviewed_at: (cell as { reviewed_at?: unknown }).reviewed_at ?? null,
        review_revision:
          (cell as { review_revision?: unknown }).review_revision ?? 0,
      }),
    );
    inspection = inspectLitigationEvidenceInventoryReview({
      receipt,
      cells: storedCells,
    });
  } catch {
    return { status: "invalid", reason: "layout_mismatch" };
  }
  if (!inspection.complete) {
    return { status: "invalid", reason: "review_incomplete" };
  }
  try {
    const recomputedCompletion =
      compileLitigationEvidenceReviewCompletionReceipt({
        receipt,
        cells: storedCells,
        completedAt: completion.completed_at,
      });
    if (canonical(recomputedCompletion) !== canonical(completion)) {
      return { status: "invalid", reason: "completion_mismatch" };
    }
    return {
      status: "valid",
      binding: {
        receipt,
        completion: recomputedCompletion,
        inspection,
      },
    };
  } catch {
    return { status: "invalid", reason: "completion_mismatch" };
  }
}
