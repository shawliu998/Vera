/**
 * Stable product types for Vera's local-first port of Mike.
 *
 * These are transport-safe projections: file paths, credentials, local user
 * identities, and provider secrets deliberately do not appear here.
 */

export type WorkspaceId = string;
export type IsoDateTime = string;

export type ProjectStatus = "active" | "archived" | "deleted";
export type DocumentStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "unsupported"
  | "ocr_required";
export type DocumentVersionSource =
  | "upload"
  | "user_upload"
  | "assistant_edit"
  | "user_accept"
  | "user_reject"
  | "generated";
export type DocumentEditStatus = "pending" | "accepted" | "rejected";
export type ChatScope = "global" | "project";
export type ChatStatus = "active" | "archived";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";
export type ModelProvider =
  | "openai"
  | "deepseek"
  | "anthropic"
  | "gemini"
  | "openai_compatible";
export type CredentialStatus = "not_configured" | "configured" | "unavailable";
export type WorkflowType = "assistant" | "tabular";
export type WorkflowStatus = "active" | "archived";
export type RunStatus =
  | "queued"
  | "waiting"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";
export type StepRunStatus = RunStatus | "skipped";
export type TabularOutputType = "text" | "boolean" | "enum" | "number";
export type TabularReviewStatus =
  | "draft"
  | "ready"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "archived";
export type TabularCellStatus =
  | "empty"
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";
export type JobType =
  | "document_parse"
  | "assistant_generate"
  | "workflow_run"
  | "tabular_cell";
export type JobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";
export type LegacyImportStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "skipped";
export type WorkspaceJson =
  | string
  | number
  | boolean
  | null
  | WorkspaceJson[]
  | { [key: string]: WorkspaceJson };

/** Redacted, transport-safe failure information; never carries a stack, path, or secret. */
export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, string | number | boolean | null> | null;
}

export interface Project {
  id: WorkspaceId;
  name: string;
  description: string | null;
  cmNumber: string | null;
  practice: string | null;
  status: ProjectStatus;
  defaultModelProfileId: WorkspaceId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  archivedAt: IsoDateTime | null;
}

export interface ProjectFolder {
  id: WorkspaceId;
  projectId: WorkspaceId;
  parentFolderId: WorkspaceId | null;
  name: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Document {
  id: WorkspaceId;
  projectId: WorkspaceId | null;
  folderId: WorkspaceId | null;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  currentVersionId: WorkspaceId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface DocumentVersion {
  id: WorkspaceId;
  documentId: WorkspaceId;
  versionNumber: number;
  source: DocumentVersionSource;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  pageCount: number | null;
  createdAt: IsoDateTime;
}

export interface DocumentEdit {
  id: WorkspaceId;
  documentId: WorkspaceId;
  versionId: WorkspaceId;
  messageId: WorkspaceId | null;
  status: DocumentEditStatus;
  summary: string | null;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

export interface DocumentChunk {
  id: WorkspaceId;
  documentId: WorkspaceId;
  versionId: WorkspaceId;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
  pageStart: number | null;
  pageEnd: number | null;
  createdAt: IsoDateTime;
}

export interface Chat {
  id: WorkspaceId;
  projectId: WorkspaceId | null;
  scope: ChatScope;
  title: string;
  status: ChatStatus;
  modelProfileId: WorkspaceId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ChatMessage {
  id: WorkspaceId;
  chatId: WorkspaceId;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  modelProfileId: WorkspaceId | null;
  jobId: WorkspaceId | null;
  createdAt: IsoDateTime;
  completedAt: IsoDateTime | null;
}

export interface MessageSource {
  id: WorkspaceId;
  messageId: WorkspaceId;
  documentId: WorkspaceId;
  versionId: WorkspaceId;
  chunkId: WorkspaceId | null;
  quote: string | null;
  startOffset: number | null;
  endOffset: number | null;
  createdAt: IsoDateTime;
}

export interface ModelProfile {
  id: WorkspaceId;
  name: string;
  provider: ModelProvider;
  model: string;
  baseUrl: string | null;
  credentialStatus: CredentialStatus;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
    vision: boolean;
  };
  isDefault: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface PromptWorkflowStep {
  /** Optional only for legacy persisted rows; all client-authored steps have one. */
  id?: WorkspaceId;
  kind: "prompt";
  title: string;
  prompt: string;
  /** When present it must match the run-level immutable model profile. */
  modelProfileId?: WorkspaceId;
}

export interface DocumentContextWorkflowStep {
  /** Optional only for legacy persisted rows; all client-authored steps have one. */
  id?: WorkspaceId;
  kind: "document_context";
  title: string;
  maxDocuments: number;
  maxChunksPerDocument: number;
  /** Client definition query; absent on legacy inferred-context steps. */
  queryTemplate?: string;
  /** Total evidence-result cap for client-authored retrieval steps. */
  resultLimit?: number;
}

export interface TabularColumnWorkflowStep {
  /** Optional only for legacy persisted rows. */
  id?: WorkspaceId;
  kind: "tabular_column";
  title: string;
  outputType: TabularOutputType;
  prompt: string;
  enumValues?: string[];
}

export interface OutputWorkflowStep {
  /** Optional only for legacy persisted rows; all client-authored steps have one. */
  id?: WorkspaceId;
  kind: "output";
  title: string;
  format: "text" | "json";
}

/** No arbitrary code, shell, network, or dynamic-tool step is permitted. */
export type WorkflowStep =
  | PromptWorkflowStep
  | DocumentContextWorkflowStep
  | TabularColumnWorkflowStep
  | OutputWorkflowStep;

export interface WorkflowColumn {
  id: WorkspaceId;
  workflowId: WorkspaceId | null;
  key: string;
  title: string;
  outputType: TabularOutputType;
  prompt: string;
  enumValues: string[] | null;
  ordinal: number;
}

export interface WorkflowBase {
  id: WorkspaceId;
  projectId: WorkspaceId | null;
  title: string;
  description: string | null;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  language: string;
  practice: string;
  jurisdictions: string[];
  metadata: Record<string, WorkspaceJson>;
  isBuiltin: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface AssistantWorkflow extends WorkflowBase {
  type: "assistant";
  skillMarkdown: string;
}

export interface TabularWorkflow extends WorkflowBase {
  type: "tabular";
  columns: WorkflowColumn[];
}

export type Workflow = AssistantWorkflow | TabularWorkflow;

export interface WorkflowRun {
  id: WorkspaceId;
  workflowId: WorkspaceId;
  projectId: WorkspaceId | null;
  status: RunStatus;
  modelProfileId: WorkspaceId | null;
  jobId: WorkspaceId | null;
  input: WorkspaceJson;
  output: WorkspaceJson | null;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  error: StructuredError | null;
  createdAt: IsoDateTime;
}

export interface WorkflowStepRun {
  id: WorkspaceId;
  workflowRunId: WorkspaceId;
  ordinal: number;
  step: WorkflowStep;
  status: StepRunStatus;
  input: WorkspaceJson;
  output: WorkspaceJson | null;
  error: StructuredError | null;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
}

export interface TabularReview {
  id: WorkspaceId;
  projectId: WorkspaceId | null;
  workflowId: WorkspaceId | null;
  title: string;
  status: TabularReviewStatus;
  documentIds: WorkspaceId[];
  modelProfileId: WorkspaceId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TabularColumn {
  id: WorkspaceId;
  reviewId: WorkspaceId;
  key: string;
  title: string;
  outputType: TabularOutputType;
  prompt: string;
  enumValues: string[] | null;
  ordinal: number;
}

export type TabularCellValue = string | boolean | number | null;

export interface TabularCell {
  id: WorkspaceId;
  reviewId: WorkspaceId;
  documentId: WorkspaceId;
  columnId: WorkspaceId;
  outputType: TabularOutputType;
  value: TabularCellValue;
  status: TabularCellStatus;
  error: StructuredError | null;
  jobId: WorkspaceId | null;
  updatedAt: IsoDateTime;
}

export interface TabularReviewChat {
  id: WorkspaceId;
  reviewId: WorkspaceId;
  title: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TabularReviewChatMessage {
  id: WorkspaceId;
  reviewChatId: WorkspaceId;
  role: Exclude<MessageRole, "system">;
  content: string;
  status: MessageStatus;
  createdAt: IsoDateTime;
  completedAt: IsoDateTime | null;
}

export interface Job {
  id: WorkspaceId;
  type: JobType;
  status: JobStatus;
  resourceType:
    | "document"
    | "chat"
    | "workflow_run"
    | "tabular_cell"
    | "tabular_review"
    | "project";
  resourceId: WorkspaceId;
  attempt: number;
  maxAttempts: number;
  error: StructuredError | null;
  retryable: boolean;
  createdAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
}

export interface WorkspaceSettings {
  id: "workspace";
  locale: "zh-CN" | "en-US";
  theme: "system" | "light" | "dark";
  defaultModelProfileId: WorkspaceId | null;
  defaultProjectId: WorkspaceId | null;
  updatedAt: IsoDateTime;
}

export interface LegacyImportRecord {
  id: WorkspaceId;
  sourceKind: "legacy_workspace";
  sourceRecordId: string;
  targetProjectId: WorkspaceId | null;
  status: LegacyImportStatus;
  errorCode: string | null;
  createdAt: IsoDateTime;
  completedAt: IsoDateTime | null;
}
