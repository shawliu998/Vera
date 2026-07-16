import { z } from "zod";

export const DOCUMENT_STUDIO_DRAFT_TYPES_V20 = [
  "legal_research_memo",
  "legal_opinion",
  "contract_review_memo",
  "due_diligence_report",
  "litigation_strategy_memo",
  "lawyer_letter",
  "contract_clause",
  "general_legal_document",
] as const;

export const DOCUMENT_STUDIO_DRAFT_ORIGINS_V20 = [
  "manual",
  "assistant",
  "workflow",
  "unknown",
] as const;

export const DocumentStudioDraftTypeV20Schema = z.enum(
  DOCUMENT_STUDIO_DRAFT_TYPES_V20,
);
export const DocumentStudioDraftOriginV20Schema = z.enum(
  DOCUMENT_STUDIO_DRAFT_ORIGINS_V20,
);

export type DocumentStudioDraftTypeV20 = z.infer<
  typeof DocumentStudioDraftTypeV20Schema
>;
export type DocumentStudioDraftOriginV20 = z.infer<
  typeof DocumentStudioDraftOriginV20Schema
>;

export type DocumentStudioDraftMetadataV20 = {
  documentType: DocumentStudioDraftTypeV20;
  originType: DocumentStudioDraftOriginV20;
  originRef: string | null;
};
