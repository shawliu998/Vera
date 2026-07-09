import type { V1RuntimePersistenceInput } from "./v1RuntimePersistence";

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
  approvalCheckpointId?: string | null;
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

export type AppendAuditEventInput = {
  actor: "system" | "agent" | "human";
  action: string;
  workflowVersion: string | null;
  model: string | null;
  details: Record<string, unknown>;
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
  action: "audit_pack_export" | "feedback_dataset_export" | "final_memo_export";
  prompt?: string | null;
  requestedPayload?: Record<string, unknown>;
};

export type DecideApprovalInput = {
  decision: "approved" | "rejected" | "edited" | "responded";
  comment?: string | null;
  editedPayload?: Record<string, unknown>;
  response?: string | null;
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

export type UploadMatterDocumentInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
};

export type SearchMatterDocumentsInput = {
  query: string;
  limit?: number;
  mode?: "keyword" | "hybrid" | "semantic";
};

export type ListV1SourceIndexInput = {
  includeChunks?: boolean;
  includeEvidenceLinks?: boolean;
  chunkLimit?: number;
  documentIds?: string[];
};

export interface AletheiaRepository {
  listMatters(ctx: AletheiaUserContext): Promise<unknown[]>;
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
  searchMatterDocuments(
    ctx: AletheiaUserContext,
    matterId: string,
    input: SearchMatterDocumentsInput,
  ): Promise<unknown[] | null>;
  listV1SourceIndex(
    ctx: AletheiaUserContext,
    matterId: string,
    input?: ListV1SourceIndexInput,
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
