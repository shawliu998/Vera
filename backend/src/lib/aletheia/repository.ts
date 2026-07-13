import type { V1RuntimePersistenceInput } from "./v1RuntimePersistence";
import type { ContentDisarmResult } from "./contentDisarm";
import type {
  CreateDeadlineCandidateInput,
  CreateLitigationClaimInput,
  CreateLitigationElementInput,
  CreateLitigationFactInput,
  CreateProceduralEventInput,
  CreatePositionReviewInput,
  CreateTaskFromDeadlineInput,
  CorrectProceduralEventInput,
  DecideDeadlineCandidateInput,
  DecideLitigationClaimInput,
  DecideLitigationFactInput,
  DecideLitigationElementInput,
  DecideProceduralEventInput,
  LinkElementFactInput,
  LitigationArtifactKind,
  AppendLitigationDocumentDraftVersionInput,
  CreateLitigationDocumentDraftInput,
  ImportLitigationDocumentDraftDocxInput,
  ReviewLitigationDocumentDraftVersionInput,
  WithdrawLitigationDocumentDraftInput,
  LitigationTaskStatusFilter,
  ResolvePositionReviewInput,
  UpdateLitigationProfileInput,
} from "./litigationDomain";

export type AletheiaUserContext = {
  userId: string;
  userEmail?: string;
};

export type CreateMatterInput = {
  title: string;
  objective: string;
  template: string;
  status: string;
  riskLevel: string | null;
  clientOrProject: string | null;
  sourceProjectId: string | null;
  sharedWith: string[];
  metadata: Record<string, unknown>;
};

export type CreateWorkProductInput = {
  kind: string;
  title: string;
  status: string;
  schemaVersion: string;
  content: Record<string, unknown>;
  validationErrors: unknown[];
  generatedBy: "system" | "agent" | "human";
  model: string | null;
  dependencyHash?: string | null;
  staleAt?: string | null;
  staleReason?: string | null;
  approvalCheckpointId?: string | null;
  governanceApprovalRequestId?: string | null;
};

export type AddReviewInput = {
  targetType: string;
  targetId: string;
  tag: string;
  comment: string;
  workProductId: string | null;
  evidenceItemId: string | null;
  reviewerName: string | null;
};

export type ReviewResolutionStatus =
  | "accepted"
  | "rejected"
  | "needs_material"
  | "resolved";

export type ResolveReviewInput = {
  status: ReviewResolutionStatus;
  comment?: string | null;
  createEvalCase?: boolean;
};

export type AppendAuditEventInput = {
  actor: "system" | "agent" | "human";
  action: string;
  workflowVersion: string | null;
  model: string | null;
  details: Record<string, unknown>;
};

export type TaskCalendarEntry = {
  id: string;
  matter_id: string;
  matter_title: string;
  title: string;
  due_at: string;
  status: "open" | "completed";
  priority: "high" | "normal" | "low";
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type PersistGateSnapshotInput = {
  action: "final_memo_export";
  approvalCheckpointId?: string | null;
  content: Record<string, unknown>;
};

export type AgentRunBudget = {
  maxSteps?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxWallTimeMs?: number;
};

export type CreateAgentRunInput = {
  workflow: string;
  goal: string;
  status?: "queued" | "running";
  modelProfile?: string | null;
  budget?: AgentRunBudget;
  metadata?: Record<string, unknown>;
};

export type CreateEvidenceItemInput = {
  sourceChunkId: string;
  claimId?: string | null;
  relevance: "direct" | "indirect" | "weak";
  supportStatus: "supports" | "contradicts" | "insufficient";
  workProductId?: string | null;
  confidence?: "low" | "medium" | "high" | null;
  metadata?: Record<string, unknown>;
};

export type RequestApprovalInput = {
  action:
    | "audit_pack_export"
    | "feedback_dataset_export"
    | "final_memo_export"
    | "litigation_artifact_export"
    | "litigation_matter_audit_export"
    | "litigation_template_publish"
    | "litigation_template_retire"
    | "external_source_use"
    | "matter_purge";
  prompt?: string | null;
  requestedPayload?: Record<string, unknown>;
};

export type DecideApprovalInput = {
  decision: "approved" | "rejected" | "edited" | "responded";
  comment?: string | null;
  editedPayload?: Record<string, unknown>;
  response?: string | null;
};

export type LitigationArtifactDownload = {
  exportId: string;
  workProductId: string;
  title: string;
  version: number;
  contentHash: string;
  mimeType:
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/zip";
  format: "docx" | "zip";
  bytes: Buffer;
};

export type CreateLegalOpinionInput = {
  answerId: string;
  cover: {
    title?: string | null;
    addressee?: string | null;
    limitation?: string | null;
    lawyerReference?: string | null;
  };
};

export type LegalOpinionDownload = {
  exportId: string;
  workProductId: string;
  title: string;
  version: number;
  contentHash: string;
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  bytes: Buffer;
};

export type MatterOriginalDocumentDownload = {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  sha256: string;
};

export type LitigationApprovalVoteBlockReason =
  | "independent_approval_not_required"
  | "approval_not_requested"
  | "artifact_binding_stale"
  | "artifact_ineligible"
  | "governance_request_ineligible"
  | "policy_missing_or_disabled"
  | "requester_cannot_vote"
  | "missing_approval_vote_permission"
  | "role_not_eligible"
  | "actor_already_voted"
  | "distinct_role_already_approved"
  | "governance_request_approved"
  | "governance_request_rejected";

export type LitigationArtifactExportApprovalProjection = {
  approvalCheckpointId: string | null;
  workProductId: string;
  version: number;
  contentHash: string;
  checkpointStatus:
    | "not_requested"
    | "open"
    | "approved"
    | "rejected"
    | "resolved"
    | "consumed"
    | "stale"
    | "ineligible";
  governanceRequest: null | {
    id: string;
    requesterId: string;
    status: string;
    approvedVotes: number;
    rejectedVotes: number;
    requiredApprovals: number;
    requireDistinctRoles: boolean;
    votes: Array<{
      principalId: string;
      role: string;
      decision: string;
      comment: string | null;
      createdAt: string;
    }>;
  };
  actor: {
    id: string;
    canVote: boolean;
    canExport: boolean;
    voteBlockReason: LitigationApprovalVoteBlockReason | null;
  };
  independentApproval: {
    required: boolean;
    status:
      | "not_requested"
      | "pending"
      | "approved"
      | "rejected"
      | "stale"
      | "ineligible";
    approvedBy: string[];
  };
  export: null | {
    status: "exported";
    exportId: string;
    exportedBy: string;
    exportedAt: string;
  };
};

export type ResumeAgentRunInput = {
  checkpointId: string;
  note?: string | null;
};

export type AddMatterMemoryInput = {
  category:
    | "confirmed_fact"
    | "output_preference"
    | "excluded_path"
    | "missing_material"
    | "reviewer_feedback";
  title: string;
  body: string;
  source?: "human" | "review" | "system";
  metadata?: Record<string, unknown>;
};

export type CreatePlaybookInput = {
  name: string;
  description: string | null;
  content: Record<string, unknown>;
  version?: string | null;
};

export type ProposePlaybookImprovementInput = {
  sourcePlaybookId?: string | null;
  title?: string | null;
  reviewerNote?: string | null;
  includeReviewTags?: string[];
};

export type ApproveSkillCandidateInput = {
  candidate: Record<string, unknown>;
  approvalComment?: string | null;
};

export type UploadMatterDocumentInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
  malwareScan?: {
    mode: "disabled" | "best_effort" | "required";
    status: "clean" | "infected" | "skipped" | "unavailable" | "error";
    scanner: "clamav" | null;
    sha256: string;
    detail: string;
    scannedAt: string;
  };
  contentDisarm?: ContentDisarmResult;
};

export type SearchMatterDocumentsInput = {
  query: string;
  limit?: number;
  mode?: "keyword" | "hybrid" | "semantic";
};

export type GlobalSearchKind =
  | "matter"
  | "document"
  | "fact"
  | "position"
  | "deadline"
  | "task"
  | "work_product";

export type GlobalSearchResult = {
  kind: GlobalSearchKind;
  id: string;
  matterId: string;
  matterTitle: string;
  title: string;
  snippet: string;
  status: string;
  updatedAt: string;
  href: string;
};

export type GlobalSearchResponse = {
  query: string;
  results: GlobalSearchResult[];
  total: number;
};

export type GlobalSearchInput = {
  query: string;
  limit?: number;
};

export type ListV1SourceIndexInput = {
  includeChunks?: boolean;
  includeEvidenceLinks?: boolean;
  chunkLimit?: number;
  documentIds?: string[];
};

export type CreateLocalExportPackageInput = {
  approvalCheckpointId?: string | null;
  governanceApprovalRequestId?: string | null;
  includeChunks?: boolean;
  chunkLimit?: number;
};

export type CreateLitigationMatterAuditExportInput = {
  approvalCheckpointId: string;
  governanceApprovalRequestId?: string | null;
};

export type SignLitigationMatterAuditExportInput = {
  exportHash: string;
  checklistHash: string;
  matterStateHash: string;
  signerName: string;
  professionalIdentifier?: string | null;
  attestation: string;
  comment: string;
};

export type CreateDurableEvalExportInput = {
  approvalCheckpointId?: string | null;
  governanceApprovalRequestId?: string | null;
  includeClosed?: boolean;
};

export interface AletheiaRepository {
  listMatters(ctx: AletheiaUserContext): Promise<unknown[]>;
  searchGlobal(
    ctx: AletheiaUserContext,
    input: GlobalSearchInput,
  ): Promise<GlobalSearchResponse>;
  createMatter(
    ctx: AletheiaUserContext,
    input: CreateMatterInput,
  ): Promise<unknown>;
  getMatterDetail(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  createWorkProduct(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateWorkProductInput,
  ): Promise<unknown | null>;
  addReview(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AddReviewInput,
  ): Promise<unknown | null>;
  resolveReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
    input: ResolveReviewInput,
  ): Promise<unknown | null>;
  approveShareholderPenetrationGraph(
    ctx: AletheiaUserContext,
    matterId: string,
    graphId: string,
  ): Promise<unknown | null>;
  approveLegalQaAnswer(
    ctx: AletheiaUserContext,
    matterId: string,
    answerId: string,
  ): Promise<unknown | null>;
  createLegalOpinion(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLegalOpinionInput,
  ): Promise<unknown | null>;
  approveLegalOpinion(
    ctx: AletheiaUserContext,
    matterId: string,
    opinionId: string,
  ): Promise<unknown | null>;
  exportLegalOpinionDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    opinionId: string,
  ): Promise<unknown | null>;
  downloadLegalOpinionDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ): Promise<LegalOpinionDownload | null>;
  approveWordAddinHandoff(
    ctx: AletheiaUserContext,
    matterId: string,
    handoffId: string,
  ): Promise<unknown | null>;
  approvePreferenceLearningCandidate(
    ctx: AletheiaUserContext,
    matterId: string,
    memoryItemId: string,
  ): Promise<unknown | null>;
  listReviewDerivedEvalCases(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown[] | null>;
  appendAuditEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AppendAuditEventInput,
  ): Promise<unknown | null>;
  persistGateSnapshot(
    ctx: AletheiaUserContext,
    matterId: string,
    input: PersistGateSnapshotInput,
  ): Promise<unknown | null>;
  createAgentRun(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateAgentRunInput,
  ): Promise<unknown | null>;
  persistV1RuntimeResult(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Omit<V1RuntimePersistenceInput, "userId" | "matterId">,
  ): Promise<unknown | null>;
  resumeAgentRun(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
    input: ResumeAgentRunInput,
  ): Promise<unknown | null>;
  createEvidenceItem(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateEvidenceItemInput,
  ): Promise<unknown | null>;
  generateIssueMap(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  generateEvidenceMatrix(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  generateDraftMemo(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  requestApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    input: RequestApprovalInput,
  ): Promise<unknown | null>;
  decideApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    checkpointId: string,
    input: DecideApprovalInput,
  ): Promise<unknown | null>;
  hasApprovedCheckpoint(
    ctx: AletheiaUserContext,
    matterId: string,
    checkpointId: string,
    action: string,
    binding?: Record<string, unknown>,
  ): Promise<boolean>;
  archiveMatter(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  purgeMatter(
    ctx: AletheiaUserContext,
    matterId: string,
    approvalCheckpointId: string,
  ): Promise<unknown | null>;
  retryPurgeCleanup(
    ctx: AletheiaUserContext,
    tombstoneId: string,
  ): Promise<unknown | null>;
  addMatterMemory(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AddMatterMemoryInput,
  ): Promise<unknown | null>;
  createPlaybook(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreatePlaybookInput,
  ): Promise<unknown | null>;
  approvePlaybook(
    ctx: AletheiaUserContext,
    matterId: string,
    playbookId: string,
  ): Promise<unknown | null>;
  approveSkillCandidate(
    ctx: AletheiaUserContext,
    matterId: string,
    input: ApproveSkillCandidateInput,
  ): Promise<unknown | null>;
  proposePlaybookImprovement(
    ctx: AletheiaUserContext,
    matterId: string,
    input: ProposePlaybookImprovementInput,
  ): Promise<unknown | null>;
  uploadMatterDocument(
    ctx: AletheiaUserContext,
    matterId: string,
    input: UploadMatterDocumentInput,
  ): Promise<unknown | null>;
  preflightMatterDocumentWrite(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<boolean>;
  retryMatterDocumentParse(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
  ): Promise<unknown | null>;
  downloadMatterOriginalDocument(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
  ): Promise<MatterOriginalDocumentDownload | null>;
  searchMatterDocuments(
    ctx: AletheiaUserContext,
    matterId: string,
    input: SearchMatterDocumentsInput,
  ): Promise<unknown[] | null>;
  createLitigationRetrievalManifest(
    ctx: AletheiaUserContext,
    matterId: string,
    input: { focus: string },
  ): Promise<unknown | null>;
  getLitigationRetrievalManifest(
    ctx: AletheiaUserContext,
    matterId: string,
    manifestId: string,
  ): Promise<unknown | null>;
  prepareLitigationReviewedExcerptInput(
    ctx: AletheiaUserContext,
    matterId: string,
    manifestId: string,
  ): Promise<unknown | null>;
  createLitigationLegalAuthorityVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Record<string, unknown>,
  ): Promise<unknown | null>;
  listLitigationLegalAuthorities(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  getLitigationLegalAuthorityVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    authorityVersionId: string,
  ): Promise<unknown | null>;
  verifyLitigationLegalAuthorityVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    authorityVersionId: string,
    input: { comment: string },
  ): Promise<unknown | null>;
  retireLitigationLegalAuthorityVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    authorityVersionId: string,
    input: { comment: string },
  ): Promise<unknown | null>;
  linkLitigationPositionAuthority(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Record<string, unknown>,
  ): Promise<unknown | null>;
  withdrawLitigationPositionAuthority(
    ctx: AletheiaUserContext,
    matterId: string,
    positionAuthorityId: string,
    input: { comment: string },
  ): Promise<unknown | null>;
  createLitigationCourtCalendarVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Record<string, unknown>,
  ): Promise<unknown | null>;
  listLitigationCourtCalendarVersions(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  verifyLitigationCourtCalendarVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    versionId: string,
    input: { comment: string },
  ): Promise<unknown | null>;
  retireLitigationCourtCalendarVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    versionId: string,
    input: { comment: string },
  ): Promise<unknown | null>;
  createLitigationDeadlineRule(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Record<string, unknown>,
  ): Promise<unknown | null>;
  listLitigationDeadlineRules(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  verifyLitigationDeadlineRule(
    ctx: AletheiaUserContext,
    matterId: string,
    ruleId: string,
    input: { comment: string },
  ): Promise<unknown | null>;
  retireLitigationDeadlineRule(
    ctx: AletheiaUserContext,
    matterId: string,
    ruleId: string,
    input: { comment: string },
  ): Promise<unknown | null>;
  calculateLitigationDeadlineFromRule(
    ctx: AletheiaUserContext,
    matterId: string,
    ruleId: string,
    input: { eventId: string; title: string },
  ): Promise<unknown | null>;
  confirmLitigationRetrievalExcerpt(
    ctx: AletheiaUserContext,
    matterId: string,
    manifestId: string,
    input: { chunkId: string; comment: string },
  ): Promise<unknown | null>;
  withdrawLitigationRetrievalExcerpt(
    ctx: AletheiaUserContext,
    matterId: string,
    excerptId: string,
    input: { comment: string },
  ): Promise<unknown | null>;
  listV1SourceIndex(
    ctx: AletheiaUserContext,
    matterId: string,
    input?: ListV1SourceIndexInput,
  ): Promise<unknown | null>;
  createLocalExportPackage(
    ctx: AletheiaUserContext,
    matterId: string,
    input?: CreateLocalExportPackageInput,
  ): Promise<unknown | null>;
  createLitigationMatterAuditExport(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationMatterAuditExportInput,
  ): Promise<unknown | null>;
  getLitigationMatterAuditExportPreview(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  listLitigationMatterAuditExports(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown[] | null>;
  getLitigationMatterAuditExport(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ): Promise<unknown | null>;
  listLitigationMatterAuditExportSignoffs(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ): Promise<unknown[] | null>;
  signLitigationMatterAuditExport(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
    input: SignLitigationMatterAuditExportInput,
  ): Promise<unknown | null>;
  getLitigationMatterAuditSignoffAnchorTarget(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
    signoffId: string,
  ): Promise<unknown | null>;
  authorizeLitigationMatterAuditSignoffAnchor(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
    signoffId: string,
  ): Promise<unknown | null>;
  createDurableEvalExport(
    ctx: AletheiaUserContext,
    matterId: string,
    input?: CreateDurableEvalExportInput,
  ): Promise<unknown | null>;
  getLitigationWorkspace(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  runLitigationAgentFindingSemanticCheck(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
    stepId: string,
    findingIndex: number,
  ): Promise<unknown | null>;
  updateLitigationProfile(
    ctx: AletheiaUserContext,
    matterId: string,
    input: UpdateLitigationProfileInput,
  ): Promise<unknown | null>;
  importLitigationDocumentTemplate(
    ctx: AletheiaUserContext,
    matterId: string,
    input: { name: string; bytes: Buffer },
  ): Promise<unknown | null>;
  listLitigationDocumentTemplates(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown[]>;
  publishLitigationDocumentTemplate(
    ctx: AletheiaUserContext,
    matterId: string,
    templateId: string,
    checkpointId: string,
  ): Promise<unknown | null>;
  retireLitigationDocumentTemplate(
    ctx: AletheiaUserContext,
    matterId: string,
    templateId: string,
    checkpointId: string,
  ): Promise<unknown | null>;
  createLitigationFact(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationFactInput,
  ): Promise<unknown | null>;
  decideLitigationFact(
    ctx: AletheiaUserContext,
    matterId: string,
    factId: string,
    input: DecideLitigationFactInput,
  ): Promise<unknown | null>;
  verifyLitigationSourceSpanOriginal(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
    reason: string,
  ): Promise<unknown | null>;
  withdrawLitigationSourceSpanOriginalVerification(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
    verificationId: string,
    reason: string,
  ): Promise<unknown | null>;
  listLitigationSourceSpanOriginalVerificationHistory(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
  ): Promise<{
    source_span_id: string;
    items: unknown[];
  } | null>;
  createLitigationClaim(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationClaimInput,
  ): Promise<unknown | null>;
  decideLitigationClaim(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: DecideLitigationClaimInput,
  ): Promise<unknown | null>;
  createPositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: CreatePositionReviewInput,
  ): Promise<unknown | null>;
  resolvePositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
    input: ResolvePositionReviewInput,
  ): Promise<unknown | null>;
  withdrawPositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
  ): Promise<unknown | null>;
  createLitigationElement(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: CreateLitigationElementInput,
  ): Promise<unknown | null>;
  decideLitigationElement(
    ctx: AletheiaUserContext,
    matterId: string,
    elementId: string,
    input: DecideLitigationElementInput,
  ): Promise<unknown | null>;
  linkLitigationElementFact(
    ctx: AletheiaUserContext,
    matterId: string,
    elementId: string,
    input: LinkElementFactInput,
  ): Promise<unknown | null>;
  createLitigationProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateProceduralEventInput,
  ): Promise<unknown | null>;
  decideLitigationProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    eventId: string,
    input: DecideProceduralEventInput,
  ): Promise<unknown | null>;
  correctLitigationProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    eventId: string,
    input: CorrectProceduralEventInput,
  ): Promise<unknown | null>;
  createLitigationDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateDeadlineCandidateInput,
  ): Promise<unknown | null>;
  decideLitigationDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    deadlineId: string,
    input: DecideDeadlineCandidateInput,
  ): Promise<unknown | null>;
  createTaskFromLitigationDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    deadlineId: string,
    input: CreateTaskFromDeadlineInput,
  ): Promise<unknown | null>;
  listTasks(
    ctx: AletheiaUserContext,
    status: LitigationTaskStatusFilter,
  ): Promise<unknown[]>;
  exportTaskCalendar(
    ctx: AletheiaUserContext,
    status: LitigationTaskStatusFilter,
  ): Promise<TaskCalendarEntry[]>;
  completeTask(
    ctx: AletheiaUserContext,
    taskId: string,
  ): Promise<unknown | null>;
  reopenTask(ctx: AletheiaUserContext, taskId: string): Promise<unknown | null>;
  claimTaskNotifications(ctx: AletheiaUserContext): Promise<unknown>;
  acknowledgeTaskNotification(
    ctx: AletheiaUserContext,
    deliveryId: string,
    input: {
      leaseToken: string;
      outcome: "delivered" | "failed";
      failureCode?: string | null;
    },
  ): Promise<unknown | null>;
  generateLitigationArtifact(
    ctx: AletheiaUserContext,
    matterId: string,
    kind: LitigationArtifactKind,
  ): Promise<unknown | null>;
  createLitigationDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationDocumentDraftInput,
  ): Promise<unknown | null>;
  listLitigationDocumentDrafts(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown[] | null>;
  getLitigationDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
  ): Promise<unknown | null>;
  appendLitigationDocumentDraftVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: AppendLitigationDocumentDraftVersionInput,
  ): Promise<unknown | null>;
  exportLitigationDocumentDraftDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    versionId: string,
  ): Promise<unknown | null>;
  importLitigationDocumentDraftDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: ImportLitigationDocumentDraftDocxInput,
  ): Promise<unknown | null>;
  diffLitigationDocumentDraftVersions(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<unknown | null>;
  reviewLitigationDocumentDraftVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    versionId: string,
    input: ReviewLitigationDocumentDraftVersionInput,
  ): Promise<unknown | null>;
  withdrawLitigationDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: WithdrawLitigationDocumentDraftInput,
  ): Promise<unknown | null>;
  prepareLitigationAgentSnapshot(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  requestLitigationAgentOutputReview(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
  ): Promise<unknown | null>;
  reviewLitigationAgentFinding(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
    stepId: string,
    findingIndex: number,
    input: {
      assessment: "supported" | "partial" | "unsupported";
      reason: string;
    },
  ): Promise<unknown | null>;
  decideLitigationAgentOutputReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
    input: { decision: "approved" | "rejected"; comment: string },
  ): Promise<unknown | null>;
  prepareLitigationAgentSynthesis(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
  ): Promise<unknown | null>;
  getLitigationArtifactExportApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    workProductId: string,
  ): Promise<LitigationArtifactExportApprovalProjection | null>;
  voteLitigationArtifactExportApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    workProductId: string,
    input: {
      approvalCheckpointId: string;
      decision: "approved" | "rejected";
      comment?: string | null;
    },
  ): Promise<LitigationArtifactExportApprovalProjection | null>;
  exportLitigationArtifact(
    ctx: AletheiaUserContext,
    matterId: string,
    workProductId: string,
    approvalCheckpointId: string,
    format?: "docx" | "json" | "zip",
    restrictedGovernanceApprovalRequestId?: string | null,
  ): Promise<unknown | null>;
  downloadLitigationArtifact(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ): Promise<LitigationArtifactDownload | null>;
  runLitigationEvalSuite(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
  listLitigationEvalRuns(
    ctx: AletheiaUserContext,
    matterId: string,
  ): Promise<unknown | null>;
}

export class LocalAdapterNotReadyError extends Error {
  constructor() {
    super(
      "Aletheia local storage adapter is scaffolded but not enabled for API traffic yet",
    );
    this.name = "LocalAdapterNotReadyError";
  }
}

export class CapabilityNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityNotAvailableError";
  }
}

export class ApprovalRequiredError extends Error {
  constructor(
    message = "Approved human checkpoint is required for this action",
  ) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

export class LitigationArtifactDownloadIntegrityError extends Error {
  readonly code = "export_integrity_failed";
  readonly status = 409;

  constructor() {
    super("The exported litigation artifact failed integrity verification.");
    this.name = "LitigationArtifactDownloadIntegrityError";
  }
}

export class MatterOriginalDocumentIntegrityError extends Error {
  readonly code = "document_original_integrity_failed";
  readonly status = 409;

  constructor() {
    super("The original document failed integrity verification.");
    this.name = "MatterOriginalDocumentIntegrityError";
  }
}

export class MatterOriginalDocumentAuditError extends Error {
  readonly code = "document_original_audit_failed";
  readonly status = 503;

  constructor() {
    super("The original document access audit could not be recorded.");
    this.name = "MatterOriginalDocumentAuditError";
  }
}

export class SourceOriginalVerificationHistoryAuditError extends Error {
  readonly code = "source_original_verification_history_audit_failed";
  readonly status = 503;

  constructor() {
    super("The original verification history access audit could not be recorded.");
    this.name = "SourceOriginalVerificationHistoryAuditError";
  }
}

export type DocumentParseRetryErrorCode =
  | "ocr_required"
  | "document_not_retryable"
  | "document_source_integrity_failed"
  | "document_parse_retry_failed";

export class DocumentParseRetryError extends Error {
  constructor(
    message: string,
    readonly code: DocumentParseRetryErrorCode,
    readonly status: number,
    readonly document: unknown = null,
  ) {
    super(message);
    this.name = "DocumentParseRetryError";
  }
}
