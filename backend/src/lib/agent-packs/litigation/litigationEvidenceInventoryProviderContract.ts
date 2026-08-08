import { createHash } from "node:crypto";

import { z } from "zod";

import {
  LitigationEvidenceStructuredOutputError,
  litigationEvidenceCellCandidateSchema,
  litigationEvidenceInventoryReceiptSchema,
  type LitigationEvidenceInventoryReceiptV1,
  type LitigationRecordCitationV1,
} from "./litigationEvidenceInventoryPack";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const providerCitationSchema = z
  .object({
    locator: z
      .object({
        kind: z.enum(["page", "paragraph", "exhibit", "timestamp"]),
        value: boundedText(200),
      })
      .strict(),
    quote: boundedText(4_000),
  })
  .strict();
const providerSourcedValueSchema = z
  .object({
    value: boundedText(4_000).nullable(),
    citations: z.array(providerCitationSchema).max(12),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.value === null && value.citations.length !== 0) ||
      (value.value !== null && value.citations.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citations"],
        message:
          "A stated provider value requires a quotation; an unknown value has no invented quotation",
      });
    }
  });

const providerFieldResultSchema = z.discriminatedUnion("field", [
  z
    .object({
      field: z.literal("evidence_item"),
      values: z
        .object({
          name_or_title: providerSourcedValueSchema,
          document_type: providerSourcedValueSchema,
          date: providerSourcedValueSchema,
          author_issuer_sender: providerSourcedValueSchema,
          recipient_counterparty: providerSourcedValueSchema,
          offering_party: providerSourcedValueSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      field: z.literal("authenticity"),
      values: z
        .object({
          origin: providerSourcedValueSchema,
          signature_or_seal: providerSourcedValueSchema,
          chain_of_custody: providerSourcedValueSchema,
          express_authenticity_challenge: providerSourcedValueSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      field: z.literal("admissibility"),
      values: z
        .object({
          form: providerSourcedValueSchema,
          acquisition_method: providerSourcedValueSchema,
          express_objection: providerSourcedValueSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      field: z.literal("relevance"),
      values: z
        .object({
          source_stated_fact: providerSourcedValueSchema,
          source_to_fact_connection: providerSourcedValueSchema,
          dispute_status: z.enum([
            "stated_disputed",
            "stated_undisputed",
            "unknown",
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      field: z.literal("purpose_of_proof"),
      values: z
        .object({
          potential_purpose: providerSourcedValueSchema,
          proposition_scope: z.enum([
            "document_records_assertion",
            "assertion_offered_as_true",
            "unknown",
          ]),
        })
        .strict(),
    })
    .strict(),
]);

export const litigationEvidenceCellProviderDraftSchema = z
  .object({
    result: providerFieldResultSchema,
    reasoning: boundedText(4_000),
    reasoning_citations: z.array(providerCitationSchema).min(1).max(12),
  })
  .strict();
export type LitigationEvidenceCellProviderDraftV1 = z.infer<
  typeof litigationEvidenceCellProviderDraftSchema
>;

function unwrapSingleJsonFence(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

export function parseLitigationEvidenceCellProviderDraft(raw: string) {
  try {
    return litigationEvidenceCellProviderDraftSchema.parse(
      JSON.parse(unwrapSingleJsonFence(raw)),
    );
  } catch {
    throw new LitigationEvidenceStructuredOutputError();
  }
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

type ProviderCitation = z.infer<typeof providerCitationSchema>;
type ProviderSourcedValue = z.infer<typeof providerSourcedValueSchema>;

export function compileLitigationEvidenceCellProviderDraft(input: {
  receipt: LitigationEvidenceInventoryReceiptV1;
  cellId: string;
  draft: LitigationEvidenceCellProviderDraftV1;
}) {
  const receipt = litigationEvidenceInventoryReceiptSchema.parse(input.receipt);
  const draft = litigationEvidenceCellProviderDraftSchema.parse(input.draft);
  const fixed = receipt.cells.find((cell) => cell.cell_id === input.cellId);
  if (!fixed || fixed.field !== draft.result.field) {
    throw new Error(
      "Litigation evidence provider output crossed its fixed field boundary",
    );
  }

  const citations: LitigationRecordCitationV1[] = [];
  const citationIds = new Map<string, string>();
  const registerCitation = (citation: ProviderCitation) => {
    const key = canonical(citation);
    const existing = citationIds.get(key);
    if (existing) return existing;
    const citationId = `citation-${createHash("sha256")
      .update(`${fixed.cell_id}\0${key}`)
      .digest("hex")
      .slice(0, 24)}`;
    citationIds.set(key, citationId);
    citations.push({
      citation_id: citationId,
      source_type: "record_evidence",
      document_id: fixed.document_id,
      version_id: fixed.version_id,
      locator: citation.locator,
      quote: citation.quote,
    });
    return citationId;
  };
  const bindValue = (value: ProviderSourcedValue) => ({
    value: value.value,
    citation_ids: value.citations.map(registerCitation),
  });

  let result: unknown;
  switch (draft.result.field) {
    case "evidence_item":
      result = {
        field: draft.result.field,
        values: {
          name_or_title: bindValue(draft.result.values.name_or_title),
          document_type: bindValue(draft.result.values.document_type),
          date: bindValue(draft.result.values.date),
          author_issuer_sender: bindValue(
            draft.result.values.author_issuer_sender,
          ),
          recipient_counterparty: bindValue(
            draft.result.values.recipient_counterparty,
          ),
          offering_party: bindValue(draft.result.values.offering_party),
        },
      };
      break;
    case "authenticity":
      result = {
        field: draft.result.field,
        values: {
          origin: bindValue(draft.result.values.origin),
          signature_or_seal: bindValue(draft.result.values.signature_or_seal),
          chain_of_custody: bindValue(draft.result.values.chain_of_custody),
          express_authenticity_challenge: bindValue(
            draft.result.values.express_authenticity_challenge,
          ),
        },
      };
      break;
    case "admissibility":
      result = {
        field: draft.result.field,
        values: {
          form: bindValue(draft.result.values.form),
          acquisition_method: bindValue(draft.result.values.acquisition_method),
          express_objection: bindValue(draft.result.values.express_objection),
        },
      };
      break;
    case "relevance":
      result = {
        field: draft.result.field,
        values: {
          source_stated_fact: bindValue(draft.result.values.source_stated_fact),
          source_to_fact_connection: bindValue(
            draft.result.values.source_to_fact_connection,
          ),
          dispute_status: draft.result.values.dispute_status,
        },
      };
      break;
    case "purpose_of_proof":
      result = {
        field: draft.result.field,
        values: {
          potential_purpose: bindValue(draft.result.values.potential_purpose),
          proposition_scope: draft.result.values.proposition_scope,
        },
      };
      break;
  }

  const reasoningCitationIds = draft.reasoning_citations.map(registerCitation);
  return litigationEvidenceCellCandidateSchema.parse({
    kind: "litigation_evidence_cell_candidate_v1",
    cell_id: fixed.cell_id,
    document_id: fixed.document_id,
    version_id: fixed.version_id,
    result,
    reasoning: draft.reasoning,
    reasoning_citation_ids: reasoningCitationIds,
    citations,
    lawyer_review_status: "unverified",
  });
}
