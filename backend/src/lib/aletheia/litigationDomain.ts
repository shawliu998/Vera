export const LITIGATION_FACT_STATUSES = new Set([
  "proposed",
  "confirmed",
  "rejected",
  "disputed",
]);

export const LITIGATION_SOURCE_RELATIONS = new Set([
  "supports",
  "contradicts",
  "corroborates",
  "authenticates",
  "impeaches",
]);

export const LITIGATION_HELPFULNESS = new Set([
  "helpful",
  "harmful",
  "neutral",
  "unknown",
]);

export const LITIGATION_CLAIM_KINDS = new Set(["claim", "defense", "rebuttal"]);

export const LITIGATION_CLAIM_STATUSES = new Set([
  "proposed",
  "confirmed",
  "rejected",
  "withdrawn",
]);

export const LITIGATION_CLAIM_SOURCE_RELATIONS = new Set([
  "authority",
  "supports",
  "contradicts",
]);

export const LITIGATION_POSITION_REVIEW_KINDS = new Set([
  "objection",
  "reconsideration",
  "withdrawal",
]);

export const LITIGATION_POSITION_REVIEW_OUTCOMES = new Set([
  "confirmed",
  "rejected",
  "withdrawn",
]);

export const LITIGATION_POSITION_REVIEW_RESOLUTIONS = new Set([
  "upheld",
  "granted",
  "dismissed",
]);

export const LITIGATION_DEADLINE_STATUSES = new Set([
  "proposed",
  "confirmed",
  "rejected",
  "completed",
]);

export const LITIGATION_TASK_STATUSES = new Set(["open", "completed"]);

export const LITIGATION_TASK_PRIORITIES = new Set(["high", "normal", "low"]);

export const LITIGATION_DATE_PRECISIONS = new Set([
  "exact",
  "day",
  "month",
  "year",
  "range",
  "unknown",
]);

export const LITIGATION_ARTIFACT_KINDS = new Set([
  "evidence_catalog",
  "claim_defense_matrix",
  "procedural_clock",
  "litigation_brief",
  "hearing_plan",
  "hearing_bundle_index",
]);

export type LitigationArtifactKind =
  | "evidence_catalog"
  | "claim_defense_matrix"
  | "procedural_clock"
  | "litigation_brief"
  | "hearing_plan"
  | "hearing_bundle_index";

export type LitigationDecision = "confirmed" | "rejected";

export type UpdateLitigationProfileInput = {
  organizationName?: string | null;
  court?: string | null;
  caseNumber?: string | null;
  exhibitPrefix: string;
  exhibitStart: number;
  paginationPolicy: "auto" | "source_native";
  documentTemplateId?: string;
  documentTemplateVersion?: number;
};

export type CreateSourceSpanInput = {
  sourceChunkId: string;
  quoteStart: number;
  quoteEnd: number;
};

export type CreateLitigationFactInput = {
  statement: string;
  occurredAt?: string | null;
  datePrecision?: string;
  sourceRelation?: string;
  helpfulness?: string;
  confidence?: "low" | "medium" | "high" | null;
  source?: CreateSourceSpanInput | null;
  createdBy?: "agent" | "human";
  metadata?: Record<string, unknown>;
};

export type DecideLitigationFactInput = {
  decision: LitigationDecision;
  comment?: string | null;
};

export type CreateLitigationClaimInput = {
  kind: string;
  title: string;
  legalBasis?: string | null;
  confidence?: "low" | "medium" | "high" | null;
  uncertainty?: string | null;
  parentClaimId?: string | null;
  burdenPartyId?: string | null;
  sourceRelation?: "authority" | "supports" | "contradicts";
  source?: CreateSourceSpanInput | null;
  createdBy?: "agent" | "human";
  metadata?: Record<string, unknown>;
};

export type DecideLitigationClaimInput = {
  decision: LitigationDecision;
  comment?: string | null;
};

export type CreatePositionReviewInput = {
  kind: "objection" | "reconsideration" | "withdrawal";
  reason: string;
  requestedOutcome: "confirmed" | "rejected" | "withdrawn";
  parentReviewId?: string | null;
};

export type ResolvePositionReviewInput = {
  resolution: "upheld" | "granted" | "dismissed";
  comment?: string | null;
};

export type DecideProceduralEventInput = {
  decision: LitigationDecision;
  comment?: string | null;
};

export type CorrectProceduralEventInput = {
  title: string;
  occurredAt: string;
  reason: string;
  source?: CreateSourceSpanInput | null;
};

export type CreateLitigationElementInput = {
  title: string;
  sequence?: number;
  description?: string | null;
  createdBy?: "agent" | "human";
  metadata?: Record<string, unknown>;
};

export type DecideLitigationElementInput = {
  decision: LitigationDecision;
  comment?: string | null;
};

export type LinkElementFactInput = {
  factId: string;
  relation: "supports" | "contradicts";
  note?: string | null;
};

export type CreateProceduralEventInput = {
  eventType: string;
  title: string;
  occurredAt?: string | null;
  source?: CreateSourceSpanInput | null;
  createdBy?: "agent" | "human";
  metadata?: Record<string, unknown>;
};

export type CreateDeadlineCandidateInput = {
  title: string;
  dueAt: string;
  triggeringEventId?: string | null;
  ruleLabel: string;
  ruleVersion: string;
  calculation: string;
  courtCalendarVersionId?: string | null;
  courtCalendarHash?: string | null;
  source?: CreateSourceSpanInput | null;
  createdBy?: "agent" | "human";
  metadata?: Record<string, unknown>;
};

export type DecideDeadlineCandidateInput = {
  decision: LitigationDecision;
  comment?: string | null;
};

export type CreateTaskFromDeadlineInput = {
  title?: string | null;
  priority?: "high" | "normal" | "low";
  note?: string | null;
};

export type LitigationTaskStatusFilter = "open" | "completed" | "all";

export const LITIGATION_DOCUMENT_DRAFT_ARTIFACT_KINDS = new Set([
  "litigation_brief",
  "hearing_plan",
]);

export type LitigationDocumentDraftArtifactKind =
  | "litigation_brief"
  | "hearing_plan";

export type LitigationDocumentDraftSection = {
  id: string;
  heading: string;
  body: string;
};

export type CreateLitigationDocumentDraftInput = {
  artifactId: string;
};

export type AppendLitigationDocumentDraftVersionInput = {
  baseVersion: number;
  changeSummary: string;
  sections: LitigationDocumentDraftSection[];
};

export type ImportLitigationDocumentDraftDocxInput = {
  filename: string;
  bytes: Buffer;
  changeSummary: string;
};

export type ReviewLitigationDocumentDraftVersionInput = {
  decision: "approved" | "rejected";
  reason: string;
};

export type WithdrawLitigationDocumentDraftInput = {
  reason: string;
};
