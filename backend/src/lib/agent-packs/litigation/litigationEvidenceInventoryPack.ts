import { createHash } from "node:crypto";

import { z } from "zod";

export const LITIGATION_EVIDENCE_INVENTORY_PROFILE_ID =
  "work_task_litigation_evidence_inventory_v1" as const;
export const LITIGATION_EVIDENCE_INVENTORY_PACK_VERSION = "1.0.0" as const;

export const litigationProceduralStageSchema = z.enum([
  "first_instance",
  "appeal",
  "retrial",
  "enforcement",
]);
export const litigationRepresentedSideSchema = z.enum([
  "claimant_plaintiff",
  "defendant_respondent",
  "appellant",
  "appellee",
  "applicant",
  "respondent",
]);

export const litigationEvidenceFieldSchema = z.enum([
  "evidence_item",
  "authenticity",
  "admissibility",
  "relevance",
  "purpose_of_proof",
]);
export type LitigationEvidenceField = z.infer<
  typeof litigationEvidenceFieldSchema
>;

export const LITIGATION_EVIDENCE_FIELDS: ReadonlyArray<{
  id: LitigationEvidenceField;
  title: string;
  semantic_axis: string;
}> = [
  {
    id: "evidence_item",
    title: "Evidence item",
    semantic_axis: "source identification metadata",
  },
  {
    id: "authenticity",
    title: "Authenticity",
    semantic_axis: "source-stated authenticity inputs",
  },
  {
    id: "admissibility",
    title: "Admissibility",
    semantic_axis: "source-stated form, acquisition method, and objections",
  },
  {
    id: "relevance",
    title: "Relevance",
    semantic_axis: "source-to-recorded-fact connection",
  },
  {
    id: "purpose_of_proof",
    title: "Purpose of proof",
    semantic_axis: "provisional source-grounded purpose of proof",
  },
];

const uuid = z.string().uuid();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const citationIds = z
  .array(z.string().regex(/^citation-[a-f0-9]{24}$/))
  .max(12)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Citation ids must be unique",
      });
    }
  });
const requiredCitationIds = z
  .array(z.string().regex(/^citation-[a-f0-9]{24}$/))
  .min(1)
  .max(12)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Citation ids must be unique",
      });
    }
  });

const sourcedValueSchema = z
  .object({
    value: boundedText(4_000).nullable(),
    citation_ids: citationIds,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.value === null && value.citation_ids.length !== 0) ||
      (value.value !== null && value.citation_ids.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citation_ids"],
        message:
          "A stated value requires a source citation; an unknown value carries no invented support",
      });
    }
  });

export const litigationRecordCitationSchema = z
  .object({
    citation_id: z.string().regex(/^citation-[a-f0-9]{24}$/),
    source_type: z.literal("record_evidence"),
    document_id: uuid,
    version_id: uuid,
    locator: z
      .object({
        kind: z.enum(["page", "paragraph", "exhibit", "timestamp"]),
        value: boundedText(200),
      })
      .strict(),
    quote: boundedText(4_000),
  })
  .strict();
export type LitigationRecordCitationV1 = z.infer<
  typeof litigationRecordCitationSchema
>;

const evidenceItemValuesSchema = z
  .object({
    name_or_title: sourcedValueSchema,
    document_type: sourcedValueSchema,
    date: sourcedValueSchema,
    author_issuer_sender: sourcedValueSchema,
    recipient_counterparty: sourcedValueSchema,
    offering_party: sourcedValueSchema,
  })
  .strict();
const authenticityValuesSchema = z
  .object({
    origin: sourcedValueSchema,
    signature_or_seal: sourcedValueSchema,
    chain_of_custody: sourcedValueSchema,
    express_authenticity_challenge: sourcedValueSchema,
  })
  .strict();
const admissibilityValuesSchema = z
  .object({
    form: sourcedValueSchema,
    acquisition_method: sourcedValueSchema,
    express_objection: sourcedValueSchema,
  })
  .strict();
const relevanceValuesSchema = z
  .object({
    source_stated_fact: sourcedValueSchema,
    source_to_fact_connection: sourcedValueSchema,
    dispute_status: z.enum(["stated_disputed", "stated_undisputed", "unknown"]),
  })
  .strict();
const purposeValuesSchema = z
  .object({
    potential_purpose: sourcedValueSchema,
    proposition_scope: z.enum([
      "document_records_assertion",
      "assertion_offered_as_true",
      "unknown",
    ]),
  })
  .strict();

const fieldResultSchema = z.discriminatedUnion("field", [
  z
    .object({
      field: z.literal("evidence_item"),
      values: evidenceItemValuesSchema,
    })
    .strict(),
  z
    .object({
      field: z.literal("authenticity"),
      values: authenticityValuesSchema,
    })
    .strict(),
  z
    .object({
      field: z.literal("admissibility"),
      values: admissibilityValuesSchema,
    })
    .strict(),
  z
    .object({ field: z.literal("relevance"), values: relevanceValuesSchema })
    .strict(),
  z
    .object({
      field: z.literal("purpose_of_proof"),
      values: purposeValuesSchema,
    })
    .strict(),
]);

export const litigationEvidenceCellCandidateSchema = z
  .object({
    kind: z.literal("litigation_evidence_cell_candidate_v1"),
    cell_id: uuid,
    document_id: uuid,
    version_id: uuid,
    result: fieldResultSchema,
    reasoning: boundedText(4_000),
    reasoning_citation_ids: requiredCitationIds,
    citations: z.array(litigationRecordCitationSchema).min(1).max(24),
    lawyer_review_status: z.literal("unverified"),
  })
  .strict()
  .superRefine((candidate, context) => {
    const citationById = new Map(
      candidate.citations.map((citation) => [citation.citation_id, citation]),
    );
    if (citationById.size !== candidate.citations.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citations"],
        message: "Citation identities must be unique",
      });
    }
    if (
      candidate.citations.some(
        (citation) =>
          citation.document_id !== candidate.document_id ||
          citation.version_id !== candidate.version_id,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citations"],
        message: "Every citation must target the fixed row DocumentVersion",
      });
    }
    const referencedIds = collectCandidateCitationIds(candidate);
    for (const citationId of referencedIds) {
      if (!citationById.has(citationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["citations"],
          message: `Referenced citation ${citationId} is missing`,
        });
      }
    }
    for (const citationId of citationById.keys()) {
      if (!referencedIds.has(citationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["citations"],
          message: `Citation ${citationId} is not used by this field`,
        });
      }
    }
  });
export type LitigationEvidenceCellCandidateV1 = z.infer<
  typeof litigationEvidenceCellCandidateSchema
>;

function collectSourcedValueCitationIds(value: unknown, into: Set<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (Array.isArray(row.citation_ids)) {
    row.citation_ids.forEach((id) => {
      if (typeof id === "string") into.add(id);
    });
  }
  Object.values(row).forEach((item) =>
    collectSourcedValueCitationIds(item, into),
  );
}

function collectCandidateCitationIds(
  candidate: Pick<
    LitigationEvidenceCellCandidateV1,
    "result" | "reasoning_citation_ids"
  >,
) {
  const ids = new Set(candidate.reasoning_citation_ids);
  collectSourcedValueCitationIds(candidate.result.values, ids);
  return ids;
}

function unwrapSingleJsonFence(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

export class LitigationEvidenceStructuredOutputError extends Error {
  constructor() {
    super("Litigation evidence generation returned an invalid structured cell");
    this.name = "LitigationEvidenceStructuredOutputError";
  }
}

export function parseLitigationEvidenceCellCandidate(raw: string) {
  try {
    return litigationEvidenceCellCandidateSchema.parse(
      JSON.parse(unwrapSingleJsonFence(raw)),
    );
  } catch {
    throw new LitigationEvidenceStructuredOutputError();
  }
}

const sourcePinSchema = z
  .object({ document_id: uuid, version_id: uuid })
  .strict();
const fixedFieldSchema = z
  .object({
    index: z.number().int().min(0).max(4),
    id: litigationEvidenceFieldSchema,
    title: boundedText(120),
    semantic_axis: boundedText(300),
  })
  .strict();
const fixedCellSchema = z
  .object({
    cell_id: uuid,
    document_id: uuid,
    version_id: uuid,
    field: litigationEvidenceFieldSchema,
    field_index: z.number().int().min(0).max(4),
  })
  .strict();

export const litigationEvidenceInventoryReceiptSchema = z
  .object({
    kind: z.literal("litigation_evidence_inventory_receipt_v1"),
    task_id: uuid,
    matter_id: uuid,
    step_id: uuid,
    attempt: z.number().int().positive(),
    review_id: uuid,
    procedural_stage: litigationProceduralStageSchema,
    represented_side: litigationRepresentedSideSchema,
    source_pins: z.array(sourcePinSchema).min(1).max(100),
    fields: z.array(fixedFieldSchema).length(5),
    cells: z.array(fixedCellSchema).min(5).max(500),
    layout_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type LitigationEvidenceInventoryReceiptV1 = z.infer<
  typeof litigationEvidenceInventoryReceiptSchema
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

function deterministicUuid(scope: string) {
  const chars = createHash("sha256")
    .update(scope)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "4";
  chars[16] = ["8", "9", "a", "b"][parseInt(chars[16]!, 16) % 4]!;
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function compileLitigationEvidenceInventoryReceipt(input: {
  taskId: string;
  matterId: string;
  stepId: string;
  attempt: number;
  proceduralStage: z.infer<typeof litigationProceduralStageSchema>;
  representedSide: z.infer<typeof litigationRepresentedSideSchema>;
  sourcePins: Array<{ document_id: string; version_id: string }>;
}) {
  const ids = z.object({ taskId: uuid, matterId: uuid, stepId: uuid }).parse({
    taskId: input.taskId,
    matterId: input.matterId,
    stepId: input.stepId,
  });
  const sourcePins = z
    .array(sourcePinSchema)
    .min(1)
    .max(100)
    .parse(input.sourcePins);
  const sourceIds = sourcePins.map((pin) => pin.document_id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("Litigation evidence source Documents must be unique");
  }
  const sortedPins = [...sourcePins].sort((left, right) =>
    left.document_id.localeCompare(right.document_id),
  );
  const reviewId = deterministicUuid(
    `litigation-evidence-review-v1\0${ids.taskId}\0${ids.stepId}`,
  );
  const fields = LITIGATION_EVIDENCE_FIELDS.map((field, index) => ({
    index,
    ...field,
  }));
  const cells = sortedPins.flatMap((pin) =>
    fields.map((field) => ({
      cell_id: deterministicUuid(
        `litigation-evidence-cell-v1\0${reviewId}\0${pin.document_id}\0${field.id}`,
      ),
      document_id: pin.document_id,
      version_id: pin.version_id,
      field: field.id,
      field_index: field.index,
    })),
  );
  const layout = {
    review_id: reviewId,
    procedural_stage: input.proceduralStage,
    represented_side: input.representedSide,
    source_pins: sortedPins,
    fields,
    cells,
  };
  return litigationEvidenceInventoryReceiptSchema.parse({
    kind: "litigation_evidence_inventory_receipt_v1",
    task_id: ids.taskId,
    matter_id: ids.matterId,
    step_id: ids.stepId,
    attempt: input.attempt,
    ...layout,
    layout_digest: `sha256:${createHash("sha256").update(canonical(layout)).digest("hex")}`,
  });
}

export const litigationEvidenceCellOutcomeSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        kind: z.literal("litigation_evidence_cell_outcome_v1"),
        outcome: z.literal("completed"),
        review_id: uuid,
        cell_id: uuid,
        candidate: litigationEvidenceCellCandidateSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("litigation_evidence_cell_outcome_v1"),
        outcome: z.literal("review_required"),
        review_id: uuid,
        cell_id: uuid,
        issue: z
          .object({
            code: z.literal("source_bound_generation_incomplete"),
            reason: z.enum([
              "structured_output_invalid",
              "field_boundary_violation",
              "citation_unrelocatable",
            ]),
            attempts_exhausted: z.number().int().min(1).max(3),
          })
          .strict(),
        preservation: z
          .object({
            completed_cells_preserved: z.number().int().min(0).max(499),
            current_cell_status: z.literal("pending"),
            duplicate_review_created: z.literal(false),
          })
          .strict(),
      })
      .strict(),
  ],
);
export type LitigationEvidenceCellOutcomeV1 = z.infer<
  typeof litigationEvidenceCellOutcomeSchema
>;

export function completeLitigationEvidenceCell(input: {
  receipt: LitigationEvidenceInventoryReceiptV1;
  candidate: LitigationEvidenceCellCandidateV1;
}) {
  const receipt = litigationEvidenceInventoryReceiptSchema.parse(input.receipt);
  const candidate = litigationEvidenceCellCandidateSchema.parse(
    input.candidate,
  );
  const expected = receipt.cells.find(
    (cell) => cell.cell_id === candidate.cell_id,
  );
  if (
    !expected ||
    expected.document_id !== candidate.document_id ||
    expected.version_id !== candidate.version_id ||
    expected.field !== candidate.result.field
  ) {
    throw new Error(
      "Litigation evidence cell does not match the fixed Review layout",
    );
  }
  return litigationEvidenceCellOutcomeSchema.parse({
    kind: "litigation_evidence_cell_outcome_v1",
    outcome: "completed",
    review_id: receipt.review_id,
    cell_id: expected.cell_id,
    candidate,
  });
}

export function preserveLitigationEvidenceCellGap(input: {
  receipt: LitigationEvidenceInventoryReceiptV1;
  cellId: string;
  reason:
    | "structured_output_invalid"
    | "field_boundary_violation"
    | "citation_unrelocatable";
  attemptsExhausted: number;
  completedCellsPreserved: number;
}) {
  const receipt = litigationEvidenceInventoryReceiptSchema.parse(input.receipt);
  if (!receipt.cells.some((cell) => cell.cell_id === input.cellId)) {
    throw new Error(
      "Litigation evidence gap is outside the fixed Review layout",
    );
  }
  return litigationEvidenceCellOutcomeSchema.parse({
    kind: "litigation_evidence_cell_outcome_v1",
    outcome: "review_required",
    review_id: receipt.review_id,
    cell_id: input.cellId,
    issue: {
      code: "source_bound_generation_incomplete",
      reason: input.reason,
      attempts_exhausted: input.attemptsExhausted,
    },
    preservation: {
      completed_cells_preserved: input.completedCellsPreserved,
      current_cell_status: "pending",
      duplicate_review_created: false,
    },
  });
}
