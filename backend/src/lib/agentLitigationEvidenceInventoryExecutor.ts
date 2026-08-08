import type { createServerSupabase } from "./supabase";
import {
  LITIGATION_EVIDENCE_FIELDS,
  compileLitigationEvidenceInventoryReceipt,
  type LitigationEvidenceInventoryReceiptV1,
} from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import type { LitigationEvidenceInventoryContextV1 } from "./agent-packs/litigation/litigationEvidenceInventoryContext";
import {
  buildAgentStepTabularEffectReservation,
  commitAgentStepTabularEffect,
  reserveAgentStepTabularEffect,
  type AgentStepTabularEffectLayout,
} from "./agent-kernel/effects/tabularEffect";

type Db = ReturnType<typeof createServerSupabase>;

export function buildLitigationEvidenceReviewSpec(
  receipt: LitigationEvidenceInventoryReceiptV1,
) {
  return {
    id: receipt.review_id,
    project_id: receipt.matter_id,
    title: "Evidence inventory",
    practice: "Litigation",
    row_protocol: "document_rows" as const,
    workflow_id: null,
    document_ids: receipt.source_pins.map((pin) => pin.document_id),
    columns_config: LITIGATION_EVIDENCE_FIELDS.map((field, index) => ({
      index,
      name: field.title,
      format: "text",
      prompt: field.semantic_axis,
      tags: [field.id],
    })),
    cells: receipt.cells.map((cell) => ({
      id: cell.cell_id,
      review_id: receipt.review_id,
      document_id: cell.document_id,
      row_id: null,
      column_index: cell.field_index,
      status: "pending" as const,
    })),
  };
}

export function buildLitigationEvidenceEffectLayout(
  spec: ReturnType<typeof buildLitigationEvidenceReviewSpec>,
): AgentStepTabularEffectLayout {
  return {
    document_ids: spec.document_ids,
    columns_config: spec.columns_config,
    cells: spec.cells.map((cell) => ({
      id: cell.id,
      document_id: cell.document_id,
      column_index: cell.column_index,
    })),
  };
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

function assertReviewMatches(
  review: Record<string, unknown>,
  spec: ReturnType<typeof buildLitigationEvidenceReviewSpec>,
  userId: string,
) {
  if (
    review.id !== spec.id ||
    review.project_id !== spec.project_id ||
    review.user_id !== userId ||
    review.title !== spec.title ||
    review.practice !== spec.practice ||
    review.row_protocol !== spec.row_protocol ||
    review.workflow_id !== null ||
    canonical(review.document_ids) !== canonical(spec.document_ids) ||
    canonical(review.columns_config) !== canonical(spec.columns_config)
  ) {
    throw new Error(
      "The existing Litigation Evidence Inventory no longer matches its fixed Task layout",
    );
  }
}

async function assertFixedRecordVersions(input: {
  db: Db;
  receipt: LitigationEvidenceInventoryReceiptV1;
  userId: string;
}) {
  const ids = input.receipt.source_pins.map((pin) => pin.document_id);
  const { data, error } = await input.db
    .from("documents")
    .select("id,project_id,user_id,current_version_id")
    .in("id", ids);
  if (error) throw new Error(error.message);
  const byId = new Map(
    ((data ?? []) as Record<string, unknown>[]).map((row) => [row.id, row]),
  );
  for (const pin of input.receipt.source_pins) {
    const document = byId.get(pin.document_id);
    if (
      !document ||
      document.project_id !== input.receipt.matter_id ||
      document.user_id !== input.userId ||
      document.current_version_id !== pin.version_id
    ) {
      throw new Error(
        "A fixed case-record Version changed before Evidence Inventory publication",
      );
    }
  }
}

async function ensureReviewAndCells(input: {
  db: Db;
  receipt: LitigationEvidenceInventoryReceiptV1;
  userId: string;
}) {
  const spec = buildLitigationEvidenceReviewSpec(input.receipt);
  const reviewSelect =
    "id,project_id,user_id,title,practice,row_protocol,workflow_id,document_ids,columns_config";
  let { data: review, error } = await input.db
    .from("tabular_reviews")
    .select(reviewSelect)
    .eq("id", spec.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!review) {
    const inserted = await input.db
      .from("tabular_reviews")
      .insert({
        id: spec.id,
        project_id: spec.project_id,
        user_id: input.userId,
        title: spec.title,
        practice: spec.practice,
        row_protocol: spec.row_protocol,
        workflow_id: null,
        document_ids: spec.document_ids,
        columns_config: spec.columns_config,
      })
      .select(reviewSelect)
      .maybeSingle();
    if (inserted.error && inserted.error.code !== "23505") {
      throw new Error(inserted.error.message);
    }
    if (inserted.error?.code === "23505") {
      const raced = await input.db
        .from("tabular_reviews")
        .select(reviewSelect)
        .eq("id", spec.id)
        .maybeSingle();
      if (raced.error) throw new Error(raced.error.message);
      review = raced.data;
    } else {
      review = inserted.data;
    }
  }
  if (!review) throw new Error("The Evidence Inventory could not be recovered");
  assertReviewMatches(review as Record<string, unknown>, spec, input.userId);

  const { data: storedCells, error: cellError } = await input.db
    .from("tabular_cells")
    .select("id,review_id,document_id,row_id,column_index,status")
    .eq("review_id", spec.id);
  if (cellError) throw new Error(cellError.message);
  const expectedById = new Map(spec.cells.map((cell) => [cell.id, cell]));
  for (const row of (storedCells ?? []) as Record<string, unknown>[]) {
    const expected = expectedById.get(String(row.id));
    if (
      !expected ||
      row.review_id !== expected.review_id ||
      row.document_id !== expected.document_id ||
      row.row_id !== null ||
      row.column_index !== expected.column_index
    ) {
      throw new Error(
        "The Evidence Inventory contains a cell outside its fixed Task layout",
      );
    }
  }
  const storedIds = new Set(
    ((storedCells ?? []) as Record<string, unknown>[]).map((cell) =>
      String(cell.id),
    ),
  );
  const missing = spec.cells.filter((cell) => !storedIds.has(cell.id));
  if (missing.length) {
    const inserted = await input.db.from("tabular_cells").insert(missing);
    if (inserted.error && inserted.error.code !== "23505") {
      throw new Error(inserted.error.message);
    }
    const verified = await input.db
      .from("tabular_cells")
      .select("id,review_id,document_id,row_id,column_index,status")
      .eq("review_id", spec.id);
    if (verified.error) throw new Error(verified.error.message);
    const finalCells = (verified.data ?? []) as Record<string, unknown>[];
    if (finalCells.length !== spec.cells.length) {
      throw new Error("The Evidence Inventory cells could not be recovered");
    }
    for (const row of finalCells) {
      const expected = expectedById.get(String(row.id));
      if (
        !expected ||
        row.review_id !== expected.review_id ||
        row.document_id !== expected.document_id ||
        row.row_id !== null ||
        row.column_index !== expected.column_index
      ) {
        throw new Error(
          "The recovered Evidence Inventory cells do not match the fixed Task layout",
        );
      }
    }
  }
  return spec;
}

export async function executeLitigationEvidenceInventoryPublication(input: {
  db: Db;
  taskId: string;
  matterId: string;
  stepId: string;
  attempt: number;
  userId: string;
  leaseOwner: string;
  context: LitigationEvidenceInventoryContextV1;
}) {
  const receipt = compileLitigationEvidenceInventoryReceipt({
    taskId: input.taskId,
    matterId: input.matterId,
    stepId: input.stepId,
    attempt: input.attempt,
    proceduralStage: input.context.procedural_stage,
    representedSide: input.context.represented_side,
    sourcePins: input.context.record_sources.map((source) => ({
      document_id: source.document_id,
      version_id: source.version_id,
    })),
  });
  const fixedSpec = buildLitigationEvidenceReviewSpec(receipt);
  const fixedLayout = buildLitigationEvidenceEffectLayout(fixedSpec);
  const effect = await reserveAgentStepTabularEffect(input.db, {
    taskId: input.taskId,
    userId: input.userId,
    leaseOwner: input.leaseOwner,
    receipt: buildAgentStepTabularEffectReservation({
      stepId: input.stepId,
      attempt: input.attempt,
      layout: fixedLayout,
      reviewId: receipt.review_id,
    }),
  });
  await assertFixedRecordVersions({
    db: input.db,
    receipt,
    userId: input.userId,
  });
  const spec = await ensureReviewAndCells({
    db: input.db,
    receipt,
    userId: input.userId,
  });
  const committed = await commitAgentStepTabularEffect(input.db, {
    taskId: input.taskId,
    userId: input.userId,
    leaseOwner: input.leaseOwner,
    receipt: effect,
    reviewId: spec.id,
    layout: fixedLayout,
  });
  return {
    receipt,
    effect: committed,
    artifact: {
      artifact_type: "tabular_review" as const,
      artifact_id: spec.id,
      purpose: "Evidence inventory",
    },
  };
}
