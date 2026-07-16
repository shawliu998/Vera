import { z } from "zod";

import {
  LegalProviderSearchItemSchema,
  LegalSourceLocatorSchema,
  LegalSourceTypeSchema,
} from "./services/legalResearchProvider";

const Id = z.string().uuid();
const IsoDateTime = z.string().datetime({ offset: true });
const ProviderId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
const ProviderRecordId = z.string().trim().min(1).max(500);

export const LEGAL_RESEARCH_MAX_SEARCHES_V22 = 4;
export const LEGAL_RESEARCH_MAX_RESULTS_PER_SEARCH_V22 = 20;
export const LEGAL_RESEARCH_MAX_READS_V22 = 12;
export const LEGAL_RESEARCH_MAX_ANCHORS_PER_READ_V22 = 50;

export const LegalResearchOwnerV22Schema = z
  .object({
    projectId: Id,
    jobId: Id,
    attempt: z.number().int().min(1).max(100),
    leaseOwner: z.string().trim().min(1).max(200),
    researchSessionId: z.string().trim().min(1).max(160),
  })
  .strict();

export const LegalResearchCandidateV22Schema =
  LegalProviderSearchItemSchema.extend({
    sourceRef: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    queryId: Id,
    providerId: ProviderId,
    providerQueryId: ProviderRecordId,
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(LEGAL_RESEARCH_MAX_RESULTS_PER_SEARCH_V22 - 1),
    durable: z.literal(true),
    createdAt: IsoDateTime,
  }).strict();

export const LegalResearchReadV22Schema = z
  .object({
    id: Id,
    projectId: Id,
    researchSessionId: z.string().trim().min(1).max(160),
    sourceRef: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(LEGAL_RESEARCH_MAX_READS_V22 - 1),
    status: z.enum(["pending", "captured"]),
    snapshotId: Id.nullable(),
    anchorIds: z.array(Id).max(LEGAL_RESEARCH_MAX_ANCHORS_PER_READ_V22),
    createdAt: IsoDateTime,
    capturedAt: IsoDateTime.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const captured = value.status === "captured";
    if (
      captured !==
      (value.snapshotId !== null &&
        value.anchorIds.length > 0 &&
        value.capturedAt !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "captured reads require a snapshot, anchors, and capture time",
      });
    }
  });

export const LegalResearchAuthorityEvidenceV22Schema = z
  .object({
    kind: z.literal("legal_authority"),
    projectId: Id,
    jobId: Id,
    attempt: z.number().int().min(1).max(100),
    readId: Id,
    sourceRef: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    snapshotId: Id,
    anchorId: Id,
    title: z.string().trim().min(1).max(500),
    exactQuote: z.string().trim().min(1).max(8_000),
    locator: LegalSourceLocatorSchema,
  })
  .strict();

export const AssistantLegalAuthoritySourceWriteV22Schema = z
  .object({
    id: Id,
    readId: Id,
    anchorId: Id,
    citationOrdinal: z.number().int().min(0).max(199),
    citationMetadata: z
      .object({
        citationNumber: z.number().int().positive().max(200),
        label: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.citationMetadata.citationNumber === value.citationOrdinal + 1,
    { message: "citation number must equal citation ordinal plus one" },
  );

export const AssistantLegalAuthoritySourceV22Schema = z
  .object({
    id: Id,
    messageId: Id,
    projectId: Id,
    readId: Id,
    sourceRef: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    snapshotId: Id,
    anchorId: Id,
    title: z.string().trim().min(1).max(500),
    exactQuote: z.string().trim().min(1).max(8_000),
    locator: z.record(z.unknown()),
    sourceType: LegalSourceTypeSchema,
    citationOrdinal: z.number().int().min(0).max(199),
    citationMetadata: z
      .object({
        citationNumber: z.number().int().positive().max(200),
        label: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    createdAt: IsoDateTime,
  })
  .strict();

export type LegalResearchOwnerV22 = z.infer<typeof LegalResearchOwnerV22Schema>;
export type LegalResearchCandidateV22 = z.infer<
  typeof LegalResearchCandidateV22Schema
>;
export type LegalResearchReadV22 = z.infer<typeof LegalResearchReadV22Schema>;
export type LegalResearchAuthorityEvidenceV22 = z.infer<
  typeof LegalResearchAuthorityEvidenceV22Schema
>;
export type AssistantLegalAuthoritySourceWriteV22 = z.infer<
  typeof AssistantLegalAuthoritySourceWriteV22Schema
>;
export type AssistantLegalAuthoritySourceV22 = z.infer<
  typeof AssistantLegalAuthoritySourceV22Schema
>;
