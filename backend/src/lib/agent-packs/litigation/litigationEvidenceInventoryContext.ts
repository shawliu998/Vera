import { z } from "zod";

import type { MatterContextManifestV1 } from "../../agent-kernel/context/matterContext";
import {
  createAgentRequiredInput,
  validateRequiredInputSubmission,
  type AgentRequiredInputResponseV1,
  type AgentRequiredInputV1,
} from "../../agent-kernel/contracts/requiredInput";
import {
  litigationRepresentedSideSchema,
  type LitigationEvidenceInventoryReceiptV1,
} from "./litigationEvidenceInventoryPack";

export const LITIGATION_HEARING_PREPARATION_WORKFLOW_ID =
  "builtin-litigation-hearing-preparation" as const;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const recordSourceSchema = z
  .object({
    document_id: z.string().uuid(),
    version_id: z.string().uuid(),
    filename: boundedText(500),
    file_type: boundedText(80).nullable(),
  })
  .strict();

export const litigationEvidenceInventoryContextInputSchema = z
  .object({
    procedural_stage: z.literal("first_instance"),
    represented_side: z.enum(["claimant_plaintiff", "defendant_respondent"]),
    output_language: z.enum(["zh", "en", "bilingual"]),
  })
  .strict();

export const litigationEvidenceInventoryContextSchema = z
  .object({
    kind: z.literal("litigation_evidence_inventory_context_v1"),
    workflow_id: z.literal(LITIGATION_HEARING_PREPARATION_WORKFLOW_ID),
    procedural_stage: z.literal("first_instance"),
    represented_side: z.enum(["claimant_plaintiff", "defendant_respondent"]),
    output_language: z.enum(["zh", "en", "bilingual"]),
    record_sources: z.array(recordSourceSchema).min(1).max(100),
  })
  .strict();
export type LitigationEvidenceInventoryContextV1 = z.infer<
  typeof litigationEvidenceInventoryContextSchema
>;

export class LitigationEvidenceInventoryContextError extends Error {
  constructor(
    readonly code:
      | "litigation_context_invalid"
      | "litigation_workflow_mismatch"
      | "litigation_record_source_missing"
      | "litigation_record_scope_too_large",
    message: string,
    readonly facts: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LitigationEvidenceInventoryContextError";
  }
}

const ITEM_IDS = {
  stage: "litigation-procedural-stage",
  side: "litigation-represented-side",
  language: "litigation-output-language",
} as const;

function fixedRecordSources(matter: MatterContextManifestV1) {
  return matter.sources.filter((source) => source.role === "source");
}

export function readLitigationEvidenceInventoryContext(value: unknown) {
  if (value === undefined || value === null) return null;
  const parsed = litigationEvidenceInventoryContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_context_invalid",
      "The fixed Litigation Evidence Inventory context is malformed.",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export function createLitigationEvidenceInventoryContextRequiredInput(input: {
  matter: MatterContextManifestV1;
  stepId: string;
  createdAt?: string;
}): AgentRequiredInputV1 {
  if (
    input.matter.workflow?.id !== LITIGATION_HEARING_PREPARATION_WORKFLOW_ID
  ) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_workflow_mismatch",
      "Litigation Evidence Inventory input requires the fixed hearing-preparation Workflow.",
    );
  }
  const sources = fixedRecordSources(input.matter);
  if (!sources.length) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_record_source_missing",
      "Litigation hearing preparation requires at least one fixed case-record source.",
    );
  }
  if (sources.length > 100) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_record_scope_too_large",
      "Narrow the fixed case-record set to at most 100 documents before generation.",
      { record_source_count: sources.length },
    );
  }
  return createAgentRequiredInput({
    stepId: input.stepId,
    reasonCode: "lawyer_choice",
    createdAt: input.createdAt,
    prompt:
      "Confirm the procedural stage, represented side, and output language. Vera will bind every Evidence Inventory row to the current fixed case-record Versions.",
    items: [
      {
        id: ITEM_IDS.stage,
        kind: "choice",
        question: "Which procedural stage governs this hearing preparation?",
        options: [{ value: "first_instance", label: "First instance" }],
        allow_other: false,
        other_label: "Other stage",
      },
      {
        id: ITEM_IDS.side,
        kind: "choice",
        question: "Which side does the lawyer represent?",
        options: [
          { value: "claimant_plaintiff", label: "Claimant / plaintiff" },
          { value: "defendant_respondent", label: "Defendant / respondent" },
        ],
        allow_other: false,
        other_label: "Other side",
      },
      {
        id: ITEM_IDS.language,
        kind: "choice",
        question: "Which language should the work products use?",
        options: [
          { value: "zh", label: "Chinese" },
          { value: "en", label: "English" },
          { value: "bilingual", label: "Bilingual Chinese / English" },
        ],
        allow_other: false,
        other_label: "Other language",
      },
    ],
  });
}

export function parseLitigationEvidenceInventoryContextRequiredInput(input: {
  matter: MatterContextManifestV1;
  requiredInput: AgentRequiredInputV1;
  responses: AgentRequiredInputResponseV1[];
}) {
  const expected = createLitigationEvidenceInventoryContextRequiredInput({
    matter: input.matter,
    stepId: input.requiredInput.step_id,
    createdAt: input.requiredInput.created_at,
  });
  if (expected.request_id !== input.requiredInput.request_id) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_context_invalid",
      "The submitted Litigation choices do not match the active server request.",
    );
  }
  const validated = validateRequiredInputSubmission(expected, {
    responses: input.responses,
  });
  const answers = new Map(
    (validated.responses ?? []).flatMap((response) =>
      response.kind === "choice" ? [[response.id, response.answer]] : [],
    ),
  );
  const parsed = litigationEvidenceInventoryContextInputSchema.safeParse({
    procedural_stage: answers.get(ITEM_IDS.stage),
    represented_side: answers.get(ITEM_IDS.side),
    output_language: answers.get(ITEM_IDS.language),
  });
  if (!parsed.success) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_context_invalid",
      "Litigation choices could not be compiled into a fixed context.",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export function compileLitigationEvidenceInventoryContext(input: {
  matter: MatterContextManifestV1;
  packInput: unknown;
}): LitigationEvidenceInventoryContextV1 {
  const choices = litigationEvidenceInventoryContextInputSchema.safeParse(
    input.packInput,
  );
  if (!choices.success) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_context_invalid",
      "Litigation Evidence Inventory input must be explicit and structurally valid.",
      { issues: choices.error.issues },
    );
  }
  if (
    input.matter.workflow?.id !== LITIGATION_HEARING_PREPARATION_WORKFLOW_ID
  ) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_workflow_mismatch",
      "Litigation Evidence Inventory context requires the fixed hearing-preparation Workflow.",
    );
  }
  const sources = fixedRecordSources(input.matter);
  if (!sources.length || sources.length > 100) {
    throw new LitigationEvidenceInventoryContextError(
      sources.length
        ? "litigation_record_scope_too_large"
        : "litigation_record_source_missing",
      sources.length
        ? "The fixed case-record scope exceeds 100 documents."
        : "No fixed case-record source is available.",
      { record_source_count: sources.length },
    );
  }
  const sourceIds = sources.map((source) => source.document_id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new LitigationEvidenceInventoryContextError(
      "litigation_context_invalid",
      "The fixed case-record source set contains duplicate Documents.",
    );
  }
  return litigationEvidenceInventoryContextSchema.parse({
    kind: "litigation_evidence_inventory_context_v1",
    workflow_id: LITIGATION_HEARING_PREPARATION_WORKFLOW_ID,
    ...choices.data,
    record_sources: sources
      .map((source) => ({
        document_id: source.document_id,
        version_id: source.version_id,
        filename: source.filename,
        file_type: source.file_type,
      }))
      .sort((left, right) => left.document_id.localeCompare(right.document_id)),
  });
}

export function contextMatchesLitigationReceipt(input: {
  context: LitigationEvidenceInventoryContextV1;
  receipt: LitigationEvidenceInventoryReceiptV1;
}) {
  const context = litigationEvidenceInventoryContextSchema.parse(input.context);
  const expectedPins = context.record_sources.map((source) => ({
    document_id: source.document_id,
    version_id: source.version_id,
  }));
  return (
    input.receipt.procedural_stage === context.procedural_stage &&
    litigationRepresentedSideSchema.parse(input.receipt.represented_side) ===
      context.represented_side &&
    JSON.stringify(input.receipt.source_pins) === JSON.stringify(expectedPins)
  );
}
