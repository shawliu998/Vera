/**
 * Aletheia API client — all requests to the Node.js backend.
 * Attaches the Supabase auth token for user authentication.
 */

import { supabase } from "@/lib/supabase";
import type {
  AssistantEvent,
  Chat,
  ChatDetailOut,
  CitationAnnotation,
  Document,
  Folder,
  Message,
  Project,
  Workflow,
  TabularReview,
  TabularReviewDetailOut,
} from "@/app/components/shared/types";

// Server-side shape before mapping
interface ServerMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  files?: { filename: string; document_id?: string }[] | null;
  workflow?: { id: string; title: string } | null;
  annotations?: CitationAnnotation[] | null;
  created_at: string;
}
interface ServerChatDetailOut {
  chat: Chat;
  messages: ServerMessage[];
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const PRIVATE_AUTH_TOKEN =
  process.env.NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN?.trim() ?? "";
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

export class AletheiaApiError extends Error {
  status: number;
  code: string | null;

  constructor(args: { message: string; status: number; code?: string | null }) {
    super(args.message);
    this.name = "AletheiaApiError";
    this.status = args.status;
    this.code = args.code ?? null;
  }
}

export function isMfaRequiredError(error: unknown) {
  return (
    error instanceof AletheiaApiError &&
    error.status === 403 &&
    error.code === "mfa_verification_required"
  );
}

async function getAuthHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return PRIVATE_AUTH_TOKEN
      ? { Authorization: `Bearer ${PRIVATE_AUTH_TOKEN}` }
      : {};
  }
  return { Authorization: `Bearer ${session.access_token}` };
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeaders = await getAuthHeader();
  const { headers: initHeaders, ...restInit } = init ?? {};
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    ...restInit,
    headers: {
      Accept: "application/json",
      ...authHeaders,
      ...(initHeaders as Record<string, string> | undefined),
    },
  });

  if (!response.ok) {
    throw await toApiError(response, path);
  }

  if (
    response.status === 204 ||
    response.headers.get("content-length") === "0"
  ) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function apiBlobRequest(path: string): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  const authHeaders = await getAuthHeader();
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...authHeaders,
    },
  });

  if (!response.ok) {
    throw await toApiError(response, path);
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
  return {
    blob: await response.blob(),
    filename: filenameMatch?.[1] ?? null,
  };
}

async function toApiError(response: Response, path: string) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as {
      detail?: unknown;
      code?: unknown;
    };
    devLog("[aletheia-api] non-ok response", {
      path,
      status: response.status,
      code: parsed.code,
      detail: parsed.detail,
    });
    return new AletheiaApiError({
      status: response.status,
      code: typeof parsed.code === "string" ? parsed.code : null,
      message:
        typeof parsed.detail === "string" && parsed.detail
          ? parsed.detail
          : `API error: ${response.status}`,
    });
  } catch {
    devLog("[aletheia-api] non-ok non-json response", {
      path,
      status: response.status,
      bodyPreview: text.slice(0, 200),
    });
    return new AletheiaApiError({
      status: response.status,
      message: text || `API error: ${response.status}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Aletheia workspace
// ---------------------------------------------------------------------------

export type AletheiaMatterTemplate =
  "legal_matter_review" | "compliance_impact_review" | "deal_due_diligence";

export type AletheiaMatterStatus =
  "draft" | "in_progress" | "needs_review" | "completed" | "archived";

export type AletheiaRiskLevel = "low" | "medium" | "high";

export type AletheiaWorkProductKind =
  | "agent_plan"
  | "chronology"
  | "issue_map"
  | "evidence_matrix"
  | "draft_memo"
  | "final_memo"
  | "compliance_register"
  | "red_flag_memo"
  | "audit_pack"
  | "feedback_export"
  | "registry_snapshot";

export type AletheiaWorkProductStatus =
  "draft" | "generated" | "needs_review" | "accepted" | "superseded";

export interface AletheiaMatterOverview {
  id: string;
  user_id: string;
  title: string;
  template: AletheiaMatterTemplate;
  status: AletheiaMatterStatus;
  client_or_project: string | null;
  objective: string;
  risk_level: AletheiaRiskLevel | null;
  created_at: string;
  updated_at: string;
  document_count: number;
  evidence_count: number;
  review_count: number;
  audit_event_count: number;
  latest_audit_at: string | null;
}

export interface AletheiaMatterRecord {
  id: string;
  user_id: string;
  title: string;
  template: AletheiaMatterTemplate;
  status: AletheiaMatterStatus;
  client_or_project: string | null;
  objective: string;
  risk_level: AletheiaRiskLevel | null;
  source_project_id: string | null;
  shared_with: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AletheiaMatterDocumentRecord {
  id: string;
  matter_id: string;
  user_id: string;
  document_id: string | null;
  name: string;
  document_type: string;
  parsed_status: "pending" | "parsed" | "failed";
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AletheiaDocumentSearchResult {
  chunk_id: string;
  matter_id: string;
  document_id: string;
  document_name: string;
  text: string;
  chunk_index: number;
  page: number | null;
  section: string | null;
  quote_start: number;
  quote_end: number;
  score: number;
  retrieval_mode?: "keyword" | "hybrid" | "semantic";
  retrieval_layers?: string[];
  retrieval_rank?: number;
  retrieval_score?: number;
  retrieval_score_direction?: "lower_is_better" | "higher_is_better";
  retrieval_explanation?: {
    rank: number;
    score: number;
    scoreDirection: "lower_is_better" | "higher_is_better";
    basis: string;
    layers: string[];
  };
  suggested_claim_id?: string | null;
  suggested_issue_title?: string | null;
  claim_suggestion?: {
    claimId: string;
    issueTitle: string;
    confidence: string;
    source: string;
  } | null;
}

export interface AletheiaWorkProductRecord {
  id: string;
  matter_id: string;
  user_id: string;
  kind: AletheiaWorkProductKind;
  title: string;
  status: AletheiaWorkProductStatus;
  schema_version: string;
  content: Record<string, unknown>;
  validation_errors: unknown[];
  generated_by: "system" | "agent" | "human";
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface AletheiaEvidenceRecord {
  id: string;
  matter_id: string;
  work_product_id: string | null;
  document_id: string | null;
  source_chunk_id?: string | null;
  claim_id: string | null;
  document_name: string | null;
  page: number | null;
  section: string | null;
  quote: string;
  quote_start?: number | null;
  quote_end?: number | null;
  relevance: "direct" | "indirect" | "weak";
  support_status: "supports" | "contradicts" | "insufficient";
  confidence: AletheiaRiskLevel | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AletheiaReviewRecord {
  id: string;
  matter_id: string;
  work_product_id: string | null;
  evidence_item_id: string | null;
  target_type:
    "claim" | "evidence" | "memo_section" | "work_product" | "matter";
  target_id: string;
  tag: string;
  comment: string;
  reviewer_user_id: string | null;
  reviewer_name: string | null;
  created_at: string;
}

export interface AletheiaAuditEventRecord {
  id: string;
  matter_id: string;
  user_id: string | null;
  actor: "system" | "agent" | "human";
  action: string;
  workflow_version: string | null;
  model: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface AletheiaAgentStepRecord {
  id: string;
  run_id: string;
  matter_id: string;
  user_id: string;
  step_key: string;
  title: string;
  sequence: number;
  status:
    "pending" | "running" | "completed" | "needs_human" | "failed" | "skipped";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  validation_errors: unknown[];
  metrics: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AletheiaToolCallRecord {
  id: string;
  run_id: string;
  step_id: string | null;
  matter_id: string;
  user_id: string;
  tool_name: string;
  risk_level: "low" | "medium" | "high";
  status:
    "pending" | "running" | "completed" | "failed" | "requires_confirmation";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  metrics: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AletheiaHumanCheckpointRecord {
  id: string;
  run_id: string;
  step_id: string | null;
  matter_id: string;
  user_id: string;
  checkpoint_type: string;
  status: "open" | "approved" | "rejected" | "resolved" | "cancelled";
  prompt: string;
  decision: "approved" | "rejected" | "edited" | "responded" | null;
  requested_payload: Record<string, unknown>;
  decision_payload: Record<string, unknown>;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface AletheiaMatterMemoryRecord {
  id: string;
  matter_id: string;
  user_id: string;
  category:
    | "confirmed_fact"
    | "output_preference"
    | "excluded_path"
    | "missing_material"
    | "reviewer_feedback";
  title: string;
  body: string;
  source: "human" | "review" | "system";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AletheiaPlaybookRecord {
  id: string;
  matter_id: string;
  user_id: string;
  name: string;
  description: string | null;
  version: string;
  status: "draft" | "approved" | "superseded";
  content: Record<string, unknown>;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AletheiaAgentRunBudget = {
  maxSteps?: number | null;
  maxToolCalls?: number | null;
  maxTokens?: number | null;
  maxCostUsd?: number | null;
  maxWallTimeMs?: number | null;
};

export interface AletheiaWorkflowGraphNode {
  key: string;
  type: "agent_step" | "human_checkpoint" | string;
  title: string;
  sequence: number;
  status: string;
  specialistRole?: string | null;
  allowedTools?: string[];
  checkpoint?: string | null;
  workProductKind?: string | null;
  workProductId?: string | null;
}

export interface AletheiaWorkflowGraphEdge {
  from: string;
  to: string;
  condition: string;
}

export interface AletheiaWorkflowGraph {
  schemaVersion: string;
  graphType: string;
  nodes: AletheiaWorkflowGraphNode[];
  edges: AletheiaWorkflowGraphEdge[];
  controls?: Record<string, unknown>;
}

export interface AletheiaAgentRunRecord {
  id: string;
  matter_id: string;
  user_id: string;
  workflow: AletheiaMatterTemplate;
  goal: string;
  status:
    | "queued"
    | "running"
    | "blocked"
    | "needs_human"
    | "completed"
    | "failed"
    | "cancelled";
  current_step_key: string | null;
  model_profile: string | null;
  storage_driver: "local" | "postgres" | "supabase";
  budget?: AletheiaAgentRunBudget;
  metadata: Record<string, unknown> & {
    workflowGraph?: AletheiaWorkflowGraph;
  };
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  steps?: AletheiaAgentStepRecord[];
  tool_calls?: AletheiaToolCallRecord[];
  human_checkpoints?: AletheiaHumanCheckpointRecord[];
}

export interface AletheiaMatterDetail {
  matter: AletheiaMatterRecord;
  documents: AletheiaMatterDocumentRecord[];
  workProducts: AletheiaWorkProductRecord[];
  evidence: AletheiaEvidenceRecord[];
  reviews: AletheiaReviewRecord[];
  auditEvents: AletheiaAuditEventRecord[];
  agentRuns?: AletheiaAgentRunRecord[];
  matterMemory?: AletheiaMatterMemoryRecord[];
  playbooks?: AletheiaPlaybookRecord[];
}

export async function listAletheiaMatters(): Promise<AletheiaMatterOverview[]> {
  return apiRequest<AletheiaMatterOverview[]>("/aletheia/matters");
}

export async function createAletheiaMatter(payload: {
  title: string;
  template: AletheiaMatterTemplate;
  objective: string;
  status?: AletheiaMatterStatus;
  riskLevel?: AletheiaRiskLevel | null;
  clientOrProject?: string | null;
  sourceProjectId?: string | null;
  sharedWith?: string[];
  metadata?: Record<string, unknown>;
}): Promise<AletheiaMatterRecord> {
  return apiRequest<AletheiaMatterRecord>("/aletheia/matters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getAletheiaMatter(
  matterId: string,
): Promise<AletheiaMatterDetail> {
  return apiRequest<AletheiaMatterDetail>(`/aletheia/matters/${matterId}`);
}

export async function uploadAletheiaMatterDocument(
  matterId: string,
  file: File,
): Promise<AletheiaMatterDocumentRecord> {
  const form = new FormData();
  form.append("file", file);
  return apiRequest<AletheiaMatterDocumentRecord>(
    `/aletheia/matters/${matterId}/documents`,
    {
      method: "POST",
      body: form,
    },
  );
}

export async function searchAletheiaMatterDocuments(
  matterId: string,
  query: string,
): Promise<AletheiaDocumentSearchResult[]> {
  return apiRequest<AletheiaDocumentSearchResult[]>(
    `/aletheia/matters/${matterId}/documents/search?q=${encodeURIComponent(query)}`,
  );
}

export async function createAletheiaEvidenceItem(
  matterId: string,
  payload: {
    sourceChunkId: string;
    claimId?: string | null;
    relevance?: AletheiaEvidenceRecord["relevance"];
    supportStatus?: AletheiaEvidenceRecord["support_status"];
    workProductId?: string | null;
    confidence?: AletheiaRiskLevel | null;
    metadata?: Record<string, unknown>;
  },
): Promise<AletheiaEvidenceRecord> {
  return apiRequest<AletheiaEvidenceRecord>(
    `/aletheia/matters/${matterId}/evidence-items`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function generateAletheiaEvidenceMatrix(
  matterId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/evidence-matrix`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function generateAletheiaIssueMap(
  matterId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/issue-map`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function generateAletheiaDraftMemo(
  matterId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/draft-memo`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function createAletheiaWorkProduct(
  matterId: string,
  payload: {
    kind: AletheiaWorkProductKind;
    title: string;
    status?: AletheiaWorkProductStatus;
    schemaVersion?: string;
    content: Record<string, unknown>;
    validationErrors?: unknown[];
    generatedBy?: "system" | "agent" | "human";
    model?: string | null;
    approvalCheckpointId?: string | null;
  },
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/work-products`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function requestAletheiaApproval(
  matterId: string,
  payload: {
    action:
      "audit_pack_export" | "feedback_dataset_export" | "final_memo_export";
    prompt?: string | null;
    requestedPayload?: Record<string, unknown>;
  },
): Promise<AletheiaHumanCheckpointRecord> {
  return apiRequest<AletheiaHumanCheckpointRecord>(
    `/aletheia/matters/${matterId}/approvals`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function decideAletheiaApproval(
  matterId: string,
  checkpointId: string,
  payload: {
    decision: "approved" | "rejected" | "edited" | "responded";
    comment?: string | null;
    editedPayload?: Record<string, unknown>;
    response?: string | null;
  },
): Promise<AletheiaHumanCheckpointRecord> {
  return apiRequest<AletheiaHumanCheckpointRecord>(
    `/aletheia/matters/${matterId}/approvals/${checkpointId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function resumeAletheiaAgentRun(
  matterId: string,
  runId: string,
  payload: {
    checkpointId: string;
    note?: string | null;
  },
): Promise<AletheiaAgentRunRecord> {
  return apiRequest<AletheiaAgentRunRecord>(
    `/aletheia/matters/${matterId}/agent-runs/${runId}/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function addAletheiaMatterMemory(
  matterId: string,
  payload: {
    category: AletheiaMatterMemoryRecord["category"];
    title: string;
    body: string;
    source?: AletheiaMatterMemoryRecord["source"];
    metadata?: Record<string, unknown>;
  },
): Promise<AletheiaMatterMemoryRecord> {
  return apiRequest<AletheiaMatterMemoryRecord>(
    `/aletheia/matters/${matterId}/memory`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function createAletheiaPlaybook(
  matterId: string,
  payload: {
    name: string;
    description?: string | null;
    version?: string | null;
    content: Record<string, unknown>;
  },
): Promise<AletheiaPlaybookRecord> {
  return apiRequest<AletheiaPlaybookRecord>(
    `/aletheia/matters/${matterId}/playbooks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function approveAletheiaPlaybook(
  matterId: string,
  playbookId: string,
): Promise<AletheiaPlaybookRecord> {
  return apiRequest<AletheiaPlaybookRecord>(
    `/aletheia/matters/${matterId}/playbooks/${playbookId}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function proposeAletheiaPlaybookImprovement(
  matterId: string,
  payload: {
    sourcePlaybookId?: string | null;
    title?: string | null;
    reviewerNote?: string | null;
    includeReviewTags?: string[];
  } = {},
): Promise<AletheiaPlaybookRecord> {
  return apiRequest<AletheiaPlaybookRecord>(
    `/aletheia/matters/${matterId}/playbooks/improvement-proposals`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function addAletheiaReview(
  matterId: string,
  payload: {
    targetType: AletheiaReviewRecord["target_type"];
    targetId: string;
    tag: string;
    comment: string;
    workProductId?: string | null;
    evidenceItemId?: string | null;
    reviewerName?: string | null;
  },
): Promise<AletheiaReviewRecord> {
  return apiRequest<AletheiaReviewRecord>(
    `/aletheia/matters/${matterId}/reviews`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function appendAletheiaAuditEvent(
  matterId: string,
  payload: {
    actor?: "system" | "agent" | "human";
    action: string;
    workflowVersion?: string | null;
    model?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<AletheiaAuditEventRecord> {
  return apiRequest<AletheiaAuditEventRecord>(
    `/aletheia/matters/${matterId}/audit-events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function createAletheiaAgentRun(
  matterId: string,
  payload: {
    workflow: AletheiaMatterTemplate;
    goal: string;
    status?: "queued" | "running";
    modelProfile?: string | null;
    budget?: AletheiaAgentRunBudget;
    metadata?: Record<string, unknown>;
  },
): Promise<AletheiaAgentRunRecord> {
  return apiRequest<AletheiaAgentRunRecord>(
    `/aletheia/matters/${matterId}/agent-runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  return apiRequest<Project[]>("/projects");
}

export async function createProject(
  name: string,
  cm_number?: string,
  shared_with?: string[],
): Promise<Project> {
  return apiRequest<Project>("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, cm_number, shared_with }),
  });
}

export async function deleteAccount(): Promise<void> {
  return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function deleteAllChats(): Promise<void> {
  return apiRequest<void>("/user/chats", { method: "DELETE" });
}

export async function deleteAllProjects(): Promise<void> {
  return apiRequest<void>("/user/projects", { method: "DELETE" });
}

export async function deleteAllTabularReviews(): Promise<void> {
  return apiRequest<void>("/user/tabular-reviews", { method: "DELETE" });
}

export async function exportAccountData(): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  return apiBlobRequest("/user/export");
}

export async function exportChatData(): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  return apiBlobRequest("/user/chats/export");
}

export async function exportTabularReviewsData(): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  return apiBlobRequest("/user/tabular-reviews/export");
}

export interface UserProfile {
  displayName: string | null;
  organisation: string | null;
  messageCreditsUsed: number;
  creditsResetDate: string;
  creditsRemaining: number;
  tier: string;
  titleModel: string;
  tabularModel: string;
  mfaOnLogin: boolean;
  legalResearchUs: boolean;
  apiKeyStatus: ApiKeyStatus;
}

export async function getUserProfile(): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/profile");
}

export async function updateUserProfile(payload: {
  displayName?: string | null;
  organisation?: string | null;
  titleModel?: string;
  tabularModel?: string;
  legalResearchUs?: boolean;
}): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateUserMfaOnLogin(
  enabled: boolean,
): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/security/mfa-login", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export type ApiKeyProvider =
  "claude" | "gemini" | "openai" | "openrouter" | "courtlistener";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<
  ApiKeyProvider,
  {
    configured: boolean;
    source: ApiKeySource;
  }
>;

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
};

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
  return apiRequest<ApiKeyStatus>("/user/api-keys");
}

export async function saveApiKey(
  provider: ApiKeyProvider,
  apiKey: string | null,
): Promise<ApiKeyStatus> {
  return apiRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
}

export interface McpToolSummary {
  id: string;
  toolName: string;
  openaiToolName: string;
  title: string | null;
  description: string | null;
  enabled: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
  lastSeenAt: string;
}

export interface McpConnectorSummary {
  id: string;
  name: string;
  transport: "streamable_http";
  serverUrl: string;
  authType: "none" | "bearer" | "oauth";
  enabled: boolean;
  hasAuthConfig: boolean;
  customHeaderKeys: string[];
  oauthConnected: boolean;
  toolPolicy: Record<string, unknown>;
  tools: McpToolSummary[];
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listMcpConnectors(): Promise<McpConnectorSummary[]> {
  return apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
}

export async function getMcpConnector(
  connectorId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(`/user/mcp-connectors/${connectorId}`);
}

export async function createMcpConnector(payload: {
  name: string;
  serverUrl: string;
  bearerToken?: string | null;
  headers?: Record<string, string>;
}): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>("/user/mcp-connectors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateMcpConnector(
  connectorId: string,
  payload: {
    name?: string;
    serverUrl?: string;
    enabled?: boolean;
    bearerToken?: string | null;
    headers?: Record<string, string>;
  },
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteMcpConnector(connectorId: string): Promise<void> {
  return apiRequest<void>(`/user/mcp-connectors/${connectorId}`, {
    method: "DELETE",
  });
}

export async function refreshMcpConnectorTools(
  connectorId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}/refresh-tools`,
    { method: "POST" },
  );
}

export async function startMcpConnectorOAuth(
  connectorId: string,
): Promise<{ authorizationUrl: string | null; alreadyAuthorized: boolean }> {
  return apiRequest<{
    authorizationUrl: string | null;
    alreadyAuthorized: boolean;
  }>(`/user/mcp-connectors/${connectorId}/oauth/start`, { method: "POST" });
}

export async function setMcpToolEnabled(
  connectorId: string,
  toolId: string,
  enabled: boolean,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}/tools/${toolId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
}

export async function getProject(projectId: string): Promise<Project> {
  return apiRequest<Project>(`/projects/${projectId}`);
}

export async function updateProject(
  projectId: string,
  payload: {
    name?: string;
    cm_number?: string;
    shared_with?: string[];
  },
): Promise<Project> {
  return apiRequest<Project>(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
  owner: {
    user_id: string;
    email: string | null;
    display_name: string | null;
  };
  members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
  projectId: string,
): Promise<ProjectPeople> {
  return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
  projectId: string,
  name: string,
  parentFolderId?: string | null,
): Promise<Folder> {
  return apiRequest<Folder>(`/projects/${projectId}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      parent_folder_id: parentFolderId ?? null,
    }),
  });
}

export async function renameProjectFolder(
  projectId: string,
  folderId: string,
  name: string,
): Promise<Folder> {
  return apiRequest<Folder>(`/projects/${projectId}/folders/${folderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteProjectFolder(
  projectId: string,
  folderId: string,
): Promise<void> {
  await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
    method: "DELETE",
  });
}

export async function moveSubfolderToFolder(
  projectId: string,
  folderId: string,
  parentFolderId: string | null,
): Promise<Folder> {
  return apiRequest<Folder>(`/projects/${projectId}/folders/${folderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent_folder_id: parentFolderId }),
  });
}

export async function moveDocumentToFolder(
  projectId: string,
  documentId: string,
  folderId: string | null,
): Promise<Document> {
  return apiRequest<Document>(
    `/projects/${projectId}/documents/${documentId}/folder`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId }),
    },
  );
}

export async function renameProjectDocument(
  projectId: string,
  documentId: string,
  filename: string,
): Promise<Document> {
  return apiRequest<Document>(
    `/projects/${projectId}/documents/${documentId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    },
  );
}

export async function addDocumentToProject(
  projectId: string,
  documentId: string,
): Promise<Document> {
  return apiRequest<Document>(
    `/projects/${projectId}/documents/${documentId}`,
    { method: "POST" },
  );
}

export interface DocumentVersion {
  id: string;
  version_number: number | null;
  source: string;
  created_at: string;
  filename: string | null;
  file_type?: string | null;
  size_bytes?: number | null;
  page_count?: number | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
}

export async function listDocumentVersions(documentId: string): Promise<{
  current_version_id: string | null;
  versions: DocumentVersion[];
}> {
  return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
  documentId: string,
  file: File,
  filename?: string,
): Promise<DocumentVersion> {
  const authHeaders = await getAuthHeader();
  const form = new FormData();
  form.append("file", file);
  if (filename) form.append("filename", filename);
  const response = await fetch(
    `${API_BASE}/single-documents/${documentId}/versions`,
    {
      method: "POST",
      headers: { ...authHeaders },
      body: form,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocumentVersion>;
}

export async function replaceDocumentVersionFile(
  documentId: string,
  versionId: string,
  file: File,
  filename?: string,
): Promise<DocumentVersion> {
  const authHeaders = await getAuthHeader();
  const form = new FormData();
  form.append("file", file);
  if (filename) form.append("filename", filename);
  const response = await fetch(
    `${API_BASE}/single-documents/${documentId}/versions/${versionId}/file`,
    {
      method: "PUT",
      headers: { ...authHeaders },
      body: form,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocumentVersion>;
}

export async function copyDocumentVersionFromDocument(
  documentId: string,
  sourceDocumentId: string,
  filename?: string,
): Promise<DocumentVersion> {
  return apiRequest<DocumentVersion>(
    `/single-documents/${documentId}/versions/from-document`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_document_id: sourceDocumentId,
        filename,
      }),
    },
  );
}

export async function renameDocumentVersion(
  documentId: string,
  versionId: string,
  filename: string | null,
): Promise<DocumentVersion> {
  return apiRequest<DocumentVersion>(
    `/single-documents/${documentId}/versions/${versionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    },
  );
}

export async function deleteDocumentVersion(
  documentId: string,
  versionId: string,
): Promise<{
  deleted_version_id: string;
  current_version_id: string | null;
}> {
  return apiRequest(`/single-documents/${documentId}/versions/${versionId}`, {
    method: "DELETE",
  });
}

export async function uploadProjectDocument(
  projectId: string,
  file: File,
): Promise<Document> {
  const authHeaders = await getAuthHeader();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE}/projects/${projectId}/documents`, {
    method: "POST",
    headers: { ...authHeaders },
    body: form,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Document>;
}

export async function createProjectOfficeDocument(
  projectId: string,
  kind: "docx" | "xlsx",
  title?: string,
): Promise<Document> {
  return apiRequest<Document>(`/projects/${projectId}/documents/generated`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, title }),
  });
}

export async function uploadStandaloneDocument(file: File): Promise<Document> {
  const authHeaders = await getAuthHeader();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE}/single-documents`, {
    method: "POST",
    headers: { ...authHeaders },
    body: form,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Document>;
}

export async function listStandaloneDocuments(): Promise<Document[]> {
  return apiRequest<Document[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
  await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
  documentId: string,
  versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
  const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
  return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export async function downloadDocumentsZip(
  documentIds: string[],
): Promise<Blob> {
  const authHeaders = await getAuthHeader();
  const response = await fetch(`${API_BASE}/single-documents/download-zip`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ document_ids: documentIds }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `API error: ${response.status}`);
  }
  return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
  project_id?: string;
}): Promise<{ id: string }> {
  return apiRequest<{ id: string }>("/chat/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

export async function listChats(options?: { limit?: number }): Promise<Chat[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return apiRequest<Chat[]>(`/chat${query ? `?${query}` : ""}`);
}

export async function listProjectChats(projectId: string): Promise<Chat[]> {
  return apiRequest<Chat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<ChatDetailOut> {
  const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
  const messages: Message[] = raw.messages.map((m) => {
    if (m.role === "user") {
      return {
        role: "user",
        content: typeof m.content === "string" ? m.content : "",
        files: m.files ?? undefined,
        workflow: m.workflow ?? undefined,
      };
    }
    const events = Array.isArray(m.content)
      ? (m.content as AssistantEvent[])
      : undefined;
    return {
      role: "assistant",
      content:
        events
          ?.filter((e) => e.type === "content")
          .map((e) => (e as { type: "content"; text: string }).text)
          .join("") ?? "",
      annotations: m.annotations ?? undefined,
      events,
    };
  });
  return { chat: raw.chat, messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  await apiRequest(`/chat/${chatId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteChat(chatId: string): Promise<void> {
  await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function generateChatTitle(
  chatId: string,
  message: string,
): Promise<{ title: string }> {
  return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export type CaseLawOpinion = {
  opinionId: number | null;
  apiUrl?: string | null;
  type: string | null;
  author: string | null;
  url: string | null;
  text?: string | null;
  html?: string | null;
};

export async function getCourtlistenerOpinions(
  clusterId: number,
): Promise<CaseLawOpinion[]> {
  const result = await apiRequest<{ opinions: CaseLawOpinion[] }>(
    "/case-law/case-opinions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clusterId,
      }),
    },
  );
  return result.opinions;
}

export async function streamChat(payload: {
  messages: {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
  }[];
  chat_id?: string;
  project_id?: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { signal, ...body } = payload;
  const authHeaders = await getAuthHeader();
  return fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

type StreamChatMessage = {
  role: string;
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
  projectId: string;
  messages: StreamChatMessage[];
  chat_id?: string;
  model?: string;
  displayed_doc?: { filename: string; document_id: string };
  attached_documents?: { filename: string; document_id: string }[];
  signal?: AbortSignal;
}): Promise<Response> {
  const { projectId, signal, ...body } = payload;
  const authHeaders = await getAuthHeader();
  return fetch(`${API_BASE}/projects/${projectId}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
  projectId?: string,
): Promise<TabularReview[]> {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
  title?: string;
  document_ids: string[];
  columns_config: { index: number; name: string; prompt: string }[];
  workflow_id?: string;
  project_id?: string;
}): Promise<TabularReview> {
  return apiRequest<TabularReview>("/tabular-review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getTabularReview(
  reviewId: string,
): Promise<TabularReviewDetailOut> {
  return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
  reviewId: string,
  payload: {
    title?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    document_ids?: string[];
    project_id?: string | null;
    shared_with?: string[];
  },
): Promise<TabularReview> {
  return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getTabularReviewPeople(
  reviewId: string,
): Promise<ProjectPeople> {
  return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
  title: string,
  options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
  return apiRequest<{
    prompt: string;
    source: "preset" | "llm" | "fallback";
  }>("/tabular-review/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      format: options?.format,
      documentName: options?.documentName,
      tags: options?.tags,
    }),
  });
}

export async function uploadReviewDocument(
  reviewId: string,
  file: File,
  options?: {
    projectId?: string;
    documentIds?: string[];
    columnsConfig?: { index: number; name: string; prompt: string }[];
  },
): Promise<Document> {
  const uploaded = options?.projectId
    ? await uploadProjectDocument(options.projectId, file)
    : await uploadStandaloneDocument(file);

  await updateTabularReview(reviewId, {
    columns_config: options?.columnsConfig,
    document_ids: [...(options?.documentIds ?? []), uploaded.id],
  });

  return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
  await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
  reviewId: string,
): Promise<Response> {
  const authHeaders = await getAuthHeader();
  return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
    method: "POST",
    headers: { ...authHeaders },
  });
}

export async function streamTabularChat(
  reviewId: string,
  messages: { role: string; content: string }[],
  chat_id?: string | null,
  signal?: AbortSignal,
  context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
  const authHeaders = await getAuthHeader();
  return fetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      messages,
      chat_id: chat_id ?? undefined,
      review_title: context?.reviewTitle ?? undefined,
      project_name: context?.projectName ?? undefined,
    }),
    signal: signal ?? undefined,
  });
}

export interface TRCitationAnnotation {
  type: "tabular_citation";
  ref: number;
  col_index: number;
  row_index: number;
  col_name: string;
  doc_name: string;
  quote: string;
}

interface RawTRMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  annotations?: TRCitationAnnotation[] | null;
  created_at: string;
}

export interface TRDisplayMessage {
  role: "user" | "assistant";
  content: string;
  events?: AssistantEvent[];
  annotations?: TRCitationAnnotation[];
}

export interface TRChat {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
  return raw.map((m) => {
    if (m.role === "user") {
      return {
        role: "user" as const,
        content: typeof m.content === "string" ? m.content : "",
      };
    }
    const events = Array.isArray(m.content)
      ? (m.content as AssistantEvent[])
      : undefined;
    const content =
      events
        ?.filter((e) => e.type === "content")
        .map((e) => (e as { type: "content"; text: string }).text)
        .join("") ?? "";
    return {
      role: "assistant" as const,
      content,
      events,
      annotations: m.annotations ?? undefined,
    };
  });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
  return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
  reviewId: string,
  chatId: string,
): Promise<RawTRMessage[]> {
  return apiRequest<RawTRMessage[]>(
    `/tabular-review/${reviewId}/chats/${chatId}/messages`,
  );
}

export async function deleteTabularChat(
  reviewId: string,
  chatId: string,
): Promise<void> {
  await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
    method: "DELETE",
  });
}

export async function regenerateTabularCell(
  reviewId: string,
  documentId: string,
  columnIndex: number,
): Promise<{
  summary: string;
  flag: "green" | "grey" | "yellow" | "red";
  reasoning: string;
}> {
  return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_id: documentId,
      column_index: columnIndex,
    }),
  });
}

export async function clearTabularCells(
  reviewId: string,
  documentIds: string[],
): Promise<void> {
  await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_ids: documentIds }),
  });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = Workflow["type"];

export async function listWorkflows(type: WorkflowType): Promise<Workflow[]> {
  return apiRequest<Workflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(workflowId: string): Promise<Workflow> {
  return apiRequest<Workflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
  title: string;
  type: "assistant" | "tabular";
  prompt_md?: string;
  columns_config?: { index: number; name: string; prompt: string }[];
  practice?: string | null;
}): Promise<Workflow> {
  return apiRequest<Workflow>("/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateWorkflow(
  workflowId: string,
  payload: {
    title?: string;
    prompt_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    practice?: string | null;
  },
): Promise<Workflow> {
  return apiRequest<Workflow>(`/workflows/${workflowId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function listHiddenWorkflows(): Promise<string[]> {
  return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
  await apiRequest("/workflows/hidden", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_id: workflowId }),
  });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
  workflowId: string,
  payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
  await apiRequest<void>(`/workflows/${workflowId}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function listWorkflowShares(workflowId: string): Promise<
  {
    id: string;
    shared_with_email: string;
    allow_edit: boolean;
    created_at: string;
  }[]
> {
  return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
  workflowId: string,
  shareId: string,
): Promise<void> {
  await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
    method: "DELETE",
  });
}
