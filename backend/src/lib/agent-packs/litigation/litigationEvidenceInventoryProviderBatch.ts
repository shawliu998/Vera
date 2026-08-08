import { z } from "zod";

import {
  LITIGATION_EVIDENCE_FIELDS,
  litigationEvidenceFieldSchema,
  type LitigationEvidenceField,
} from "./litigationEvidenceInventoryPack";
import {
  litigationEvidenceCellProviderDraftSchema,
  type LitigationEvidenceCellProviderDraftV1,
} from "./litigationEvidenceInventoryProviderContract";

const providerBatchEnvelopeSchema = z
  .object({ cells: z.array(z.unknown()).max(25) })
  .strict();

const allFields = LITIGATION_EVIDENCE_FIELDS.map((field) => field.id);

export type LitigationEvidenceInventoryProviderBatch = {
  completed: LitigationEvidenceCellProviderDraftV1[];
  completedByField: ReadonlyMap<
    LitigationEvidenceField,
    LitigationEvidenceCellProviderDraftV1
  >;
  missingFields: LitigationEvidenceField[];
  invalidFields: LitigationEvidenceField[];
};

function unwrapSingleJsonFence(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function resultField(value: unknown): LitigationEvidenceField | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result = (value as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const parsed = litigationEvidenceFieldSchema.safeParse(
    (result as Record<string, unknown>).field,
  );
  return parsed.success ? parsed.data : undefined;
}

function invalidBatch(
  expectedFields: readonly LitigationEvidenceField[],
): LitigationEvidenceInventoryProviderBatch {
  return {
    completed: [],
    completedByField: new Map(),
    missingFields: [],
    invalidFields: [...expectedFields],
  };
}

/**
 * Classifies one provider response without repairing, merging, or selecting
 * between competing legal outputs. Recognizable duplicate fields are invalid,
 * while valid fields in a partial batch remain independently usable.
 */
export function parseLitigationEvidenceInventoryProviderBatch(
  raw: string,
  expectedFields: readonly LitigationEvidenceField[] = allFields,
): LitigationEvidenceInventoryProviderBatch {
  const expected = z
    .array(litigationEvidenceFieldSchema)
    .min(1)
    .max(allFields.length)
    .parse(expectedFields);
  if (new Set(expected).size !== expected.length) {
    throw new Error("Expected litigation evidence fields must be unique");
  }

  let envelope: z.infer<typeof providerBatchEnvelopeSchema>;
  try {
    envelope = providerBatchEnvelopeSchema.parse(
      JSON.parse(unwrapSingleJsonFence(raw)),
    );
  } catch {
    return invalidBatch(expected);
  }

  const expectedSet = new Set(expected);
  const occurrences = new Map<LitigationEvidenceField, number>();
  const invalid = new Set<LitigationEvidenceField>();
  const accepted = new Map<
    LitigationEvidenceField,
    LitigationEvidenceCellProviderDraftV1
  >();

  for (const cell of envelope.cells) {
    const field = resultField(cell);
    if (!field || !expectedSet.has(field)) continue;

    const count = (occurrences.get(field) ?? 0) + 1;
    occurrences.set(field, count);
    if (count > 1) {
      invalid.add(field);
      accepted.delete(field);
      continue;
    }

    const parsed = litigationEvidenceCellProviderDraftSchema.safeParse(cell);
    if (!parsed.success) {
      invalid.add(field);
      continue;
    }
    accepted.set(field, parsed.data);
  }

  for (const field of invalid) accepted.delete(field);

  const completed = expected.flatMap((field) => {
    const draft = accepted.get(field);
    return draft ? [draft] : [];
  });
  return {
    completed,
    completedByField: new Map(
      completed.map((draft) => [draft.result.field, draft]),
    ),
    missingFields: expected.filter(
      (field) => !occurrences.has(field) && !invalid.has(field),
    ),
    invalidFields: expected.filter((field) => invalid.has(field)),
  };
}
