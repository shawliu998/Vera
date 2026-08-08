import { z } from "zod";

import {
  litigationEvidenceCellCandidateSchema,
  type LitigationEvidenceCellCandidateV1,
} from "./litigationEvidenceInventoryPack";

export const litigationEvidenceInventoryCellContentSchema = z
  .object({
    kind: z.literal("litigation_evidence_inventory_cell_content_v1"),
    candidate: litigationEvidenceCellCandidateSchema,
    summary: z.string().trim().min(1).max(12_000),
    reasoning: z.string().trim().min(1).max(4_000),
    flag: z.literal("grey"),
    model_review_status: z.literal("unverified"),
  })
  .strict();
export type LitigationEvidenceInventoryCellContentV1 = z.infer<
  typeof litigationEvidenceInventoryCellContentSchema
>;

function displayLabel(value: string) {
  return value
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function displayValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return String(value ?? "Unknown");
  }
  const row = value as Record<string, unknown>;
  return row.value === null ? "Unknown" : String(row.value ?? "Unknown");
}

export function renderLitigationEvidenceCellSummary(
  candidate: LitigationEvidenceCellCandidateV1,
) {
  const values = candidate.result.values as Record<string, unknown>;
  return Object.entries(values)
    .map(([key, value]) => `${displayLabel(key)}: ${displayValue(value)}`)
    .join("\n");
}

export function buildGeneratedLitigationEvidenceCellContent(
  candidate: LitigationEvidenceCellCandidateV1,
) {
  const parsed = litigationEvidenceCellCandidateSchema.parse(candidate);
  return litigationEvidenceInventoryCellContentSchema.parse({
    kind: "litigation_evidence_inventory_cell_content_v1",
    candidate: parsed,
    summary: renderLitigationEvidenceCellSummary(parsed),
    reasoning: parsed.reasoning,
    flag: "grey",
    model_review_status: "unverified",
  });
}
