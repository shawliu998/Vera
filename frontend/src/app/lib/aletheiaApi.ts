/**
 * Aletheia API client — all requests to the Node.js backend.
 * Desktop builds use a per-launch local bearer token; browser-only local mode
 * may use an explicitly configured private token.
 */

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
import type { V1SourceIndexSnapshot } from "@/aletheia/agentops/exportPackage";
import { getAletheiaApiBase } from "@/app/lib/aletheiaRuntime";

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

export type AletheiaApprovalAction =
  | "audit_pack_export"
  | "feedback_dataset_export"
  | "final_memo_export"
  | "litigation_artifact_export"
  | "litigation_matter_audit_export"
  | "litigation_template_publish"
  | "litigation_template_retire"
  | "external_source_use"
  | "matter_purge";

export type AletheiaSecurityPolicy = {
  schemaVersion: string;
  authority: "backend";
  localOnly: true;
  storageDriver: "local";
  auditIntegrity: "per_matter_hmac_hash_chain";
  finalExportPolicy: "fail_closed";
  approvalRequiredFor: AletheiaApprovalAction[];
};

export function getAletheiaSecurityPolicy() {
  return apiRequest<AletheiaSecurityPolicy>("/aletheia/security-policy");
}

export type AletheiaLegalSourceProviderId = "pkulaw" | "yuandian" | "wolters";

export type AletheiaLegalSourceProviderCapabilities = {
  search: true;
  fetchFullText: boolean;
  pagination: false;
  getByCitation: false;
  jurisdictionFilter: false;
  asOfDateFilter: false;
  structuredFilters: false;
  dynamicToolInvocation: false;
  requiresExplicitEgressApproval: true;
  documentKinds:
    | ["statute", "judicial_interpretation", "case", "other"]
    | ["statute", "judicial_interpretation", "other"];
};

export type AletheiaLegalSourceDataUsePolicy = {
  basis: "not_declared" | "deployment_contract";
  retention:
    | "not_declared"
    | "no_retention"
    | "metadata_only"
    | "full_text_ttl"
    | "full_text_permitted";
  export:
    | "not_declared"
    | "prohibited"
    | "exact_quotes_only"
    | "reviewed_work_product"
    | "permitted";
  modelUse: "not_declared" | "prohibited" | "local_only" | "permitted";
};

export type AletheiaLegalSourceUnavailableReason =
  | "endpoint_missing"
  | "endpoint_not_allowlisted"
  | "credential_reference_missing"
  | "activation_gate_closed"
  | "data_use_policy_undeclared"
  | "credential_unavailable"
  | "secret_storage_unavailable";

export type AletheiaLegalSourceConnectionStatus =
  | {
      state: "unavailable";
      reason: AletheiaLegalSourceUnavailableReason;
      connectionTested: false;
    }
  | {
      state: "configured_unverified";
      reason: null;
      connectionTested: false;
    };

export type AletheiaLegalSourceProvider = {
  provider: AletheiaLegalSourceProviderId;
  deploymentReady: boolean;
  hasSecret: boolean;
  encryptionEnabled: boolean;
  endpointConfigured: boolean;
  allowlisted: boolean;
  credentialReferenceConfigured: boolean;
  contractVersion: "vera-legal-research-provider-v2";
  integration: "authorized_provider_adapter";
  capabilities: AletheiaLegalSourceProviderCapabilities;
  dataUsePolicy: AletheiaLegalSourceDataUsePolicy;
  connectionStatus: AletheiaLegalSourceConnectionStatus;
};

export type AletheiaLegalSourceProvidersResponse = {
  schemaVersion: "vera-legal-source-provider-status-v2";
  localOnly: true;
  providers: AletheiaLegalSourceProvider[];
  detail: string;
};

function invalidLegalSourceWire(): never {
  throw new AletheiaApiError({
    status: 502,
    code: "INVALID_RESPONSE",
    message: "The legal-source status response is invalid.",
  });
}

function exactLegalSourceObject(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidLegalSourceWire();
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== allowed.length ||
    Object.keys(raw).some((key) => !allowed.includes(key))
  ) {
    return invalidLegalSourceWire();
  }
  return raw;
}

function legalSourceBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalidLegalSourceWire();
  return value;
}

function parseLegalSourceCapabilities(
  value: unknown,
): AletheiaLegalSourceProviderCapabilities {
  const raw = exactLegalSourceObject(value, [
    "search",
    "fetchFullText",
    "pagination",
    "getByCitation",
    "jurisdictionFilter",
    "asOfDateFilter",
    "structuredFilters",
    "dynamicToolInvocation",
    "requiresExplicitEgressApproval",
    "documentKinds",
  ]);
  const fullTextDocumentKinds =
    Array.isArray(raw.documentKinds) &&
    raw.documentKinds.length === 4 &&
    raw.documentKinds[0] === "statute" &&
    raw.documentKinds[1] === "judicial_interpretation" &&
    raw.documentKinds[2] === "case" &&
    raw.documentKinds[3] === "other";
  const searchOnlyDocumentKinds =
    Array.isArray(raw.documentKinds) &&
    raw.documentKinds.length === 3 &&
    raw.documentKinds[0] === "statute" &&
    raw.documentKinds[1] === "judicial_interpretation" &&
    raw.documentKinds[2] === "other";
  if (
    raw.search !== true ||
    typeof raw.fetchFullText !== "boolean" ||
    raw.pagination !== false ||
    raw.getByCitation !== false ||
    raw.jurisdictionFilter !== false ||
    raw.asOfDateFilter !== false ||
    raw.structuredFilters !== false ||
    raw.dynamicToolInvocation !== false ||
    raw.requiresExplicitEgressApproval !== true ||
    (raw.fetchFullText ? !fullTextDocumentKinds : !searchOnlyDocumentKinds)
  ) {
    return invalidLegalSourceWire();
  }
  return {
    search: true,
    fetchFullText: raw.fetchFullText,
    pagination: false,
    getByCitation: false,
    jurisdictionFilter: false,
    asOfDateFilter: false,
    structuredFilters: false,
    dynamicToolInvocation: false,
    requiresExplicitEgressApproval: true,
    documentKinds: raw.fetchFullText
      ? ["statute", "judicial_interpretation", "case", "other"]
      : ["statute", "judicial_interpretation", "other"],
  };
}

const LEGAL_SOURCE_RETENTION_POLICIES = [
  "not_declared",
  "no_retention",
  "metadata_only",
  "full_text_ttl",
  "full_text_permitted",
] as const;
const LEGAL_SOURCE_EXPORT_POLICIES = [
  "not_declared",
  "prohibited",
  "exact_quotes_only",
  "reviewed_work_product",
  "permitted",
] as const;
const LEGAL_SOURCE_MODEL_USE_POLICIES = [
  "not_declared",
  "prohibited",
  "local_only",
  "permitted",
] as const;

function parseLegalSourceDataUsePolicy(
  value: unknown,
): AletheiaLegalSourceDataUsePolicy {
  const raw = exactLegalSourceObject(value, [
    "basis",
    "retention",
    "export",
    "modelUse",
  ]);
  if (
    (raw.basis !== "not_declared" && raw.basis !== "deployment_contract") ||
    !LEGAL_SOURCE_RETENTION_POLICIES.includes(
      raw.retention as (typeof LEGAL_SOURCE_RETENTION_POLICIES)[number],
    ) ||
    !LEGAL_SOURCE_EXPORT_POLICIES.includes(
      raw.export as (typeof LEGAL_SOURCE_EXPORT_POLICIES)[number],
    ) ||
    !LEGAL_SOURCE_MODEL_USE_POLICIES.includes(
      raw.modelUse as (typeof LEGAL_SOURCE_MODEL_USE_POLICIES)[number],
    )
  ) {
    return invalidLegalSourceWire();
  }
  if (
    raw.basis === "not_declared" &&
    (raw.retention !== "not_declared" ||
      raw.export !== "not_declared" ||
      raw.modelUse !== "not_declared")
  ) {
    return invalidLegalSourceWire();
  }
  return {
    basis: raw.basis,
    retention: raw.retention as AletheiaLegalSourceDataUsePolicy["retention"],
    export: raw.export as AletheiaLegalSourceDataUsePolicy["export"],
    modelUse: raw.modelUse as AletheiaLegalSourceDataUsePolicy["modelUse"],
  };
}

function deploymentUnavailableReason(input: {
  endpointConfigured: boolean;
  allowlisted: boolean;
  credentialReferenceConfigured: boolean;
}): AletheiaLegalSourceUnavailableReason | null {
  if (!input.endpointConfigured) return "endpoint_missing";
  if (!input.allowlisted) return "endpoint_not_allowlisted";
  if (!input.credentialReferenceConfigured) {
    return "credential_reference_missing";
  }
  return null;
}

function credentialUnavailableReason(input: {
  encryptionEnabled: boolean;
  hasSecret: boolean;
}): AletheiaLegalSourceUnavailableReason | null {
  if (!input.encryptionEnabled) return "secret_storage_unavailable";
  if (!input.hasSecret) return "credential_unavailable";
  return null;
}

function hasDeclaredDeploymentDataUsePolicy(
  policy: AletheiaLegalSourceDataUsePolicy,
): boolean {
  return (
    policy.basis === "deployment_contract" &&
    policy.retention !== "not_declared" &&
    policy.export !== "not_declared" &&
    policy.modelUse !== "not_declared"
  );
}

function parseLegalSourceConnectionStatus(
  value: unknown,
  provider: Pick<
    AletheiaLegalSourceProvider,
    | "endpointConfigured"
    | "allowlisted"
    | "credentialReferenceConfigured"
    | "encryptionEnabled"
    | "hasSecret"
    | "dataUsePolicy"
  >,
): AletheiaLegalSourceConnectionStatus {
  const raw = exactLegalSourceObject(value, [
    "state",
    "reason",
    "connectionTested",
  ]);
  if (raw.connectionTested !== false) return invalidLegalSourceWire();
  // The code-owned provider activation gate has higher precedence than local
  // credential availability once the endpoint, allowlist, and credential
  // reference deployment fields are complete. In the current closed state the
  // backend deliberately does not decrypt credentials, so hasSecret and
  // encryptionEnabled cannot replace this reason.
  if (
    provider.endpointConfigured &&
    provider.allowlisted &&
    provider.credentialReferenceConfigured &&
    raw.state === "unavailable" &&
    raw.reason === "activation_gate_closed"
  ) {
    return {
      state: "unavailable",
      reason: "activation_gate_closed",
      connectionTested: false,
    };
  }
  const expectedDeploymentReason = deploymentUnavailableReason(provider);
  if (expectedDeploymentReason) {
    if (
      raw.state !== "unavailable" ||
      raw.reason !== expectedDeploymentReason
    ) {
      return invalidLegalSourceWire();
    }
    return {
      state: "unavailable",
      reason: expectedDeploymentReason,
      connectionTested: false,
    };
  }
  if (!hasDeclaredDeploymentDataUsePolicy(provider.dataUsePolicy)) {
    if (
      raw.state !== "unavailable" ||
      raw.reason !== "data_use_policy_undeclared"
    ) {
      return invalidLegalSourceWire();
    }
    return {
      state: "unavailable",
      reason: "data_use_policy_undeclared",
      connectionTested: false,
    };
  }
  const expectedCredentialReason = credentialUnavailableReason(provider);
  if (expectedCredentialReason) {
    if (
      raw.state !== "unavailable" ||
      raw.reason !== expectedCredentialReason
    ) {
      return invalidLegalSourceWire();
    }
    return {
      state: "unavailable",
      reason: expectedCredentialReason,
      connectionTested: false,
    };
  }
  if (raw.state === "configured_unverified" && raw.reason === null) {
    return {
      state: "configured_unverified",
      reason: null,
      connectionTested: false,
    };
  }
  // All deployment/storage flags can be healthy while one existing ciphertext
  // is unreadable after corruption or key rotation. This remains fail-closed.
  if (
    raw.state === "unavailable" &&
    raw.reason === "secret_storage_unavailable"
  ) {
    return {
      state: "unavailable",
      reason: raw.reason,
      connectionTested: false,
    };
  }
  return invalidLegalSourceWire();
}

export function parseAletheiaLegalSourceProvider(
  value: unknown,
): AletheiaLegalSourceProvider {
  const raw = exactLegalSourceObject(value, [
    "provider",
    "deploymentReady",
    "endpointConfigured",
    "allowlisted",
    "credentialReferenceConfigured",
    "hasSecret",
    "encryptionEnabled",
    "contractVersion",
    "integration",
    "capabilities",
    "dataUsePolicy",
    "connectionStatus",
  ]);
  if (
    raw.provider !== "pkulaw" &&
    raw.provider !== "yuandian" &&
    raw.provider !== "wolters"
  ) {
    return invalidLegalSourceWire();
  }
  if (
    raw.contractVersion !== "vera-legal-research-provider-v2" ||
    raw.integration !== "authorized_provider_adapter"
  ) {
    return invalidLegalSourceWire();
  }
  const endpointConfigured = legalSourceBoolean(raw.endpointConfigured);
  const allowlisted = legalSourceBoolean(raw.allowlisted);
  const credentialReferenceConfigured = legalSourceBoolean(
    raw.credentialReferenceConfigured,
  );
  const deploymentReady = legalSourceBoolean(raw.deploymentReady);
  const hasSecret = legalSourceBoolean(raw.hasSecret);
  const encryptionEnabled = legalSourceBoolean(raw.encryptionEnabled);
  if (
    (allowlisted && !endpointConfigured) ||
    deploymentReady !==
      (endpointConfigured && allowlisted && credentialReferenceConfigured)
  ) {
    return invalidLegalSourceWire();
  }
  const statusBasis = {
    endpointConfigured,
    allowlisted,
    credentialReferenceConfigured,
    hasSecret,
    encryptionEnabled,
  };
  const dataUsePolicy = parseLegalSourceDataUsePolicy(raw.dataUsePolicy);
  return {
    provider: raw.provider,
    deploymentReady,
    ...statusBasis,
    contractVersion: "vera-legal-research-provider-v2",
    integration: "authorized_provider_adapter",
    capabilities: parseLegalSourceCapabilities(raw.capabilities),
    dataUsePolicy,
    connectionStatus: parseLegalSourceConnectionStatus(raw.connectionStatus, {
      ...statusBasis,
      dataUsePolicy,
    }),
  };
}

export function parseAletheiaLegalSourceProvidersResponse(
  value: unknown,
): AletheiaLegalSourceProvidersResponse {
  const raw = exactLegalSourceObject(value, [
    "schemaVersion",
    "localOnly",
    "providers",
    "detail",
  ]);
  if (
    raw.schemaVersion !== "vera-legal-source-provider-status-v2" ||
    raw.localOnly !== true ||
    typeof raw.detail !== "string" ||
    !raw.detail ||
    raw.detail.length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(raw.detail) ||
    !Array.isArray(raw.providers) ||
    raw.providers.length !== 3
  ) {
    return invalidLegalSourceWire();
  }
  const providers = raw.providers.map(parseAletheiaLegalSourceProvider);
  if (
    new Set(providers.map((provider) => provider.provider)).size !== 3 ||
    !providers.some((provider) => provider.provider === "pkulaw") ||
    !providers.some((provider) => provider.provider === "yuandian") ||
    !providers.some((provider) => provider.provider === "wolters")
  ) {
    return invalidLegalSourceWire();
  }
  return {
    schemaVersion: "vera-legal-source-provider-status-v2",
    localOnly: true,
    providers,
    detail: raw.detail,
  };
}

export async function listAletheiaLegalSourceProviders(): Promise<AletheiaLegalSourceProvidersResponse> {
  return parseAletheiaLegalSourceProvidersResponse(
    await apiRequest<unknown>("/aletheia/providers"),
  );
}

export async function saveAletheiaLegalSourceSecret(
  provider: AletheiaLegalSourceProviderId,
  secret: string,
): Promise<void> {
  parseAletheiaLegalSourceProvider(
    await apiRequest<unknown>(`/aletheia/providers/${provider}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    }),
  );
}

export function removeAletheiaLegalSourceSecret(
  provider: AletheiaLegalSourceProviderId,
): Promise<void> {
  return apiRequest(`/aletheia/providers/${provider}/secret`, {
    method: "DELETE",
  });
}

export type LocalModelCalibrationAcceptanceCode =
  | "calibrated"
  | "calibration_required"
  | "calibration_failed"
  | "calibration_stale"
  | "calibration_expired"
  | "model_revision_unavailable";

export type LocalModelBenchmarkAcceptanceCode =
  | "benchmarked_diagnostic"
  | "benchmark_required"
  | "benchmark_failed"
  | "benchmark_stale"
  | "benchmark_expired"
  | "benchmark_integrity_failed"
  | "model_revision_unavailable";

export type LocalModelBenchmarkCaseResult = {
  caseId: string;
  status: "passed" | "failed";
  score: number;
  durationMs: number;
  responseSha256: string | null;
  responseText: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  resultHash: string;
};

export type LocalModelBenchmarkAttempt = {
  id: string;
  userId: string;
  modelId: string;
  modelFingerprint: string;
  modelRevision: string;
  adapter: string;
  providerModel: string;
  reasoning: "Off" | "Low" | "Medium" | "High";
  fastMode: boolean;
  protocolVersion: string;
  caseSetHash: string;
  graderVersion: string;
  status: "passed" | "failed";
  score: number;
  testedAt: string;
  expiresAt: string;
  durationMs: number;
  responseHashesSha256: string;
  failureCode: string | null;
  failureDetail: string | null;
  resultHash: string;
  cases: LocalModelBenchmarkCaseResult[];
};

export type LocalModelSnapshot = {
  id: string;
  adapter: "ollama" | "openai-compatible";
  model: string;
  modelRevision?: string;
  state:
    | "stopped"
    | "starting"
    | "ready"
    | "unhealthy"
    | "stopping"
    | "crashed";
  managed: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  lastError?: string;
  calibration?: {
    id: string;
    modelFingerprint: string;
    status: "passed" | "failed";
    protocolVersion: string;
    testedAt: string;
    expiresAt: string;
    durationMs: number;
    failureCode: string | null;
    failureDetail: string | null;
  } | null;
  calibrationAcceptance?: {
    accepted: boolean;
    code: LocalModelCalibrationAcceptanceCode;
  };
  benchmark?: LocalModelBenchmarkAttempt | null;
  benchmarkAcceptance?: {
    accepted: boolean;
    code: LocalModelBenchmarkAcceptanceCode;
  };
};

export type LocalModelsResponse = {
  schemaVersion: "aletheia-local-model-runtime-v1";
  localOnly: true;
  benchmark: {
    diagnostic: true;
    productionExecutionGate: false;
  };
  models: LocalModelSnapshot[];
};

export async function listLocalModels(): Promise<LocalModelsResponse> {
  return apiRequest<LocalModelsResponse>("/aletheia/local-models");
}

export async function calibrateLocalModel(modelId: string): Promise<void> {
  try {
    await apiRequest(
      `/aletheia/local-models/${encodeURIComponent(modelId)}/calibrate`,
      { method: "POST" },
    );
  } catch (error) {
    // A failed calibration is still a valid persisted result that the list
    // projection exposes after refresh.
    if (!(error instanceof AletheiaApiError) || error.status !== 422)
      throw error;
  }
}

export async function benchmarkLocalModel(
  modelId: string,
): Promise<LocalModelBenchmarkAttempt> {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const path = `/aletheia/local-models/${encodeURIComponent(modelId)}/benchmark`;
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", ...authHeaders },
  });
  if (!response.ok && response.status !== 422) {
    throw await toApiError(response, path);
  }
  return (await response.json()) as LocalModelBenchmarkAttempt;
}

async function getAuthHeader(): Promise<Record<string, string>> {
  if (typeof window !== "undefined" && window.aletheiaDesktop?.getAuthToken) {
    const desktopToken = await window.aletheiaDesktop.getAuthToken();
    if (desktopToken) return { Authorization: `Bearer ${desktopToken}` };
  }
  return PRIVATE_AUTH_TOKEN
    ? { Authorization: `Bearer ${PRIVATE_AUTH_TOKEN}` }
    : {};
}

/** Shared local-only auth for document endpoints outside apiRequest. */
export async function getAletheiaAuthHeaders(): Promise<
  Record<string, string>
> {
  return getAuthHeader();
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const { headers: initHeaders, ...restInit } = init ?? {};
  const response = await fetch(`${apiBase}${path}`, {
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
  | "legal_matter_review"
  | "compliance_impact_review"
  | "deal_due_diligence"
  | "civil_litigation";

export type AletheiaMatterStatus =
  | "draft"
  | "in_progress"
  | "needs_review"
  | "completed"
  | "archived";

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
  | "registry_snapshot"
  | "external_source_workpaper"
  | "legal_research_case_context"
  | "shareholder_penetration_graph"
  | "legal_qa_answer"
  | "word_addin_handoff"
  | "claim_defense_matrix"
  | "procedural_clock"
  | "litigation_brief"
  | "hearing_plan"
  | "hearing_bundle_index"
  | "evidence_catalog"
  | "legal_research_request"
  | "legal_research_issue_tree"
  | "legal_research_query_plan"
  | "legal_research_search_result"
  | "legal_research_excerpt"
  | "legal_research_input_manifest"
  | "legal_research_memo"
  | "legal_opinion";

export type AletheiaWorkProductStatus =
  | "draft"
  | "generated"
  | "needs_review"
  | "accepted"
  | "superseded";

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
  parsed_status: "pending" | "parsed" | "failed" | "needs_ocr";
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AletheiaDocumentSearchResult {
  id?: string;
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
  ocr_provenance?: {
    engine?: string;
    page?: number;
    confidence?: number;
  } | null;
  score: number;
  quote_preview?: string;
  method?: "keyword" | "hybrid" | "semantic";
  ranking_basis?: string;
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

export type AletheiaSearchResultKind =
  | "matter"
  | "document"
  | "fact"
  | "position"
  | "deadline"
  | "task"
  | "work_product";

export interface AletheiaSearchResult {
  kind: AletheiaSearchResultKind;
  id: string;
  matterId: string;
  matterTitle: string;
  title: string;
  snippet: string;
  status: string;
  updatedAt: string;
  href: string;
}

export interface AletheiaSearchResponse {
  query: string;
  results: AletheiaSearchResult[];
  total: number;
}

export type AletheiaV1SourceIndex = V1SourceIndexSnapshot;

export interface AletheiaDocumentBatchUploadResult {
  schema_version: "aletheia-document-import-batch-v0";
  matter_id: string;
  total: number;
  imported: number;
  failed: number;
  documents: AletheiaMatterDocumentRecord[];
  errors: Array<{ filename: string; detail: string }>;
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
  version: number;
  parent_work_product_id: string | null;
  content_hash: string;
  dependency_hash: string | null;
  stale_at: string | null;
  stale_reason: string | null;
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

export type AletheiaReviewResolutionStatus =
  | "open"
  | "accepted"
  | "rejected"
  | "needs_material"
  | "resolved";

export interface AletheiaReviewRecord {
  id: string;
  matter_id: string;
  work_product_id: string | null;
  evidence_item_id: string | null;
  target_type:
    | "claim"
    | "evidence"
    | "memo_section"
    | "work_product"
    | "matter";
  target_id: string;
  tag: string;
  comment: string;
  reviewer_user_id: string | null;
  reviewer_name: string | null;
  resolution_status?: AletheiaReviewResolutionStatus;
  resolution_comment?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  created_at: string;
}

export interface AletheiaReviewDerivedEvalCaseRecord {
  id: string;
  matter_id: string;
  user_id: string;
  source_review_item_id: string;
  source_audit_event_id: string | null;
  failure_type:
    | "unsupported_claim"
    | "missing_citation"
    | "wrong_risk_level"
    | "expert_override";
  status: "open" | "triaged" | "closed";
  input_snapshot: Record<string, unknown>;
  expected_behavior: string;
  expert_feedback: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
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
    | "pending"
    | "running"
    | "completed"
    | "needs_human"
    | "failed"
    | "skipped";
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
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "requires_confirmation";
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
  storage_driver: "local";
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
  evalCases?: AletheiaReviewDerivedEvalCaseRecord[];
  auditEvents: AletheiaAuditEventRecord[];
  agentRuns?: AletheiaAgentRunRecord[];
  matterMemory?: AletheiaMatterMemoryRecord[];
  playbooks?: AletheiaPlaybookRecord[];
}

export interface AletheiaLegalOpinionExport {
  exportId: string;
  opinionId: string;
  version: number;
  contentHash: string;
}

export interface AletheiaLegalResearchMemoExport {
  exportId: string;
  memoId: string;
  version: number;
  contentHash: string;
}

export type AletheiaLegalOpinionCover = {
  title?: string;
  addressee?: string;
  limitation?: string;
  lawyerReference?: string;
};

export async function createAletheiaLegalOpinion(
  matterId: string,
  payload: { answerId: string; cover?: AletheiaLegalOpinionCover },
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/legal-opinions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function approveAletheiaLegalOpinion(
  matterId: string,
  opinionId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/legal-opinions/${opinionId}/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function exportAletheiaLegalOpinionDocx(
  matterId: string,
  opinionId: string,
): Promise<AletheiaLegalOpinionExport> {
  return apiRequest<AletheiaLegalOpinionExport>(
    `/aletheia/matters/${matterId}/legal-opinions/${opinionId}/docx`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function downloadAletheiaLegalOpinionDocx(
  matterId: string,
  exportId: string,
): Promise<Blob> {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const response = await fetch(
    `${apiBase}/aletheia/matters/${matterId}/legal-opinion-exports/${exportId}/download`,
    { headers: { ...authHeaders } },
  );
  if (!response.ok) {
    throw await toApiError(response, "legal opinion DOCX download");
  }
  return response.blob();
}

export async function exportAletheiaLegalResearchMemoDocx(
  matterId: string,
  memoId: string,
): Promise<AletheiaLegalResearchMemoExport> {
  return apiRequest<AletheiaLegalResearchMemoExport>(
    `/aletheia/matters/${matterId}/legal-research-memos/${memoId}/docx`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function downloadAletheiaLegalResearchMemoDocx(
  matterId: string,
  exportId: string,
): Promise<Blob> {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const response = await fetch(
    `${apiBase}/aletheia/matters/${matterId}/legal-research-memo-exports/${exportId}/download`,
    {
      cache: "no-store",
      headers: {
        Accept:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ...authHeaders,
      },
    },
  );
  if (!response.ok) {
    throw await toApiError(response, "legal research memo DOCX download");
  }
  return response.blob();
}

export type LegalResearchProvider =
  "pkulaw" | "yuandian" | "wolters" | "official";

export interface LegalResearchRequestInput {
  title: string;
  jurisdiction: string;
  asOfDate: string;
  question: string;
  factIds: string[];
  proceduralEventIds: string[];
}

export type LegalResearchManualSourceDocumentKind =
  | "statute"
  | "judicial_interpretation"
  | "other";

export interface LegalResearchManualSourceInput {
  documentId: string;
  title: string;
  content: string;
  documentKind: LegalResearchManualSourceDocumentKind;
  version?: string;
  effectiveDate?: string;
  effectiveTo?: string;
  publicationDate?: string;
}

export interface LegalResearchFindingInput {
  conclusion: string;
  citations: Array<{
    snapshotId: string;
    quote: string;
    sourceType: "statute" | "judicial_interpretation" | "case" | "manual";
    effectiveFrom: string | null;
    effectiveTo: string | null;
    caseVerificationStatus?: "verified" | "unverified" | null;
  }>;
  confidence: "high" | "medium" | "low";
  uncertainty: string | null;
  position: "supporting" | "adverse" | "neutral";
}

export type LegalResearchIssueStatus = "open" | "resolved" | "needs_material";

export interface LegalResearchIssueNode {
  id: string;
  parentId: string | null;
  title: string;
  description?: string | null;
  status: LegalResearchIssueStatus;
  order: number;
}

export interface LegalResearchMemoBlockedResponse {
  code: "insufficient_basis";
  detail: string;
  gate: { status: "insufficient_basis"; reasons: string[] };
  workProduct: AletheiaWorkProductRecord;
}

export type LitigationProposalStatus =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "disputed";

export interface LitigationFactRecord {
  id: string;
  matter_id: string;
  statement: string;
  occurred_at: string | null;
  date_precision: string;
  helpfulness: "helpful" | "harmful" | "neutral" | "unknown";
  confidence: "low" | "medium" | "high" | null;
  status: LitigationProposalStatus;
  created_by: "agent" | "human";
  decision_comment: string | null;
  current_assessment_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LitigationFactSourceRecord {
  id: string;
  fact_id: string;
  source_span_id: string;
  relation: string;
  document_id: string;
  document_name: string;
  page: number | null;
  section: string | null;
  quote: string;
  document_quote_start: number;
  document_quote_end: number;
  source_chunk_sha256: string;
  quote_sha256: string;
  metadata: {
    ocrProvenance?: { engine?: string; page?: number; confidence?: number };
  };
  current_verification_id: string | null;
  verification_reason: string | null;
  verified_at: string | null;
}

export interface LitigationClaimRecord {
  id: string;
  matter_id: string;
  kind: "claim" | "defense" | "rebuttal";
  parent_claim_id: string | null;
  title: string;
  legal_basis: string | null;
  burden_party_id: string | null;
  confidence: "low" | "medium" | "high" | null;
  uncertainty: string | null;
  status: "proposed" | "confirmed" | "rejected" | "withdrawn";
  created_by: "agent" | "human";
  decision_comment: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LitigationClaimSourceRecord {
  id: string;
  claim_id: string;
  source_span_id: string;
  relation: "authority" | "supports" | "contradicts";
  document_id: string;
  document_name: string;
  page: number | null;
  section: string | null;
  quote: string;
  document_quote_start: number;
  document_quote_end: number;
  source_chunk_sha256: string;
  quote_sha256: string;
  metadata: {
    ocrProvenance?: { engine?: string; page?: number; confidence?: number };
  };
  current_verification_id: string | null;
  verification_reason: string | null;
  verified_at: string | null;
}

export interface LitigationPositionReviewRecord {
  id: string;
  matter_id: string;
  claim_id: string;
  assessment_id: string;
  result_assessment_id: string | null;
  parent_review_id: string | null;
  review_level: 1 | 2;
  independent_review: 0 | 1;
  kind: "objection" | "reconsideration" | "withdrawal";
  reason: string;
  requested_outcome: "confirmed" | "rejected" | "withdrawn";
  status: "open" | "resolved" | "withdrawn";
  resolution: "upheld" | "granted" | "dismissed" | null;
  resolution_comment: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface LitigationLegalAssessmentEvidenceSourceSnapshot {
  id?: string;
  relation?: "authority" | "supports" | "contradicts";
  source_span_id: string;
  document_id?: string;
  document_name: string;
  page: number | null;
  section: string | null;
  quote: string;
  source_chunk_sha256: string;
  quote_sha256: string;
}

export interface LitigationLegalAssessmentAuthoritySnapshot {
  id: string;
  authority_version_id: string;
  applicability_date: string;
  provision_reference: string;
  exact_quote: string;
  quote_sha256: string;
  rationale: string;
  status: "active" | "withdrawn";
  official_identifier: string;
  version_label: string;
  content_sha256: string;
  effective_from: string;
  effective_to: string | null;
  authority_status: "draft" | "verified" | "retired";
}

export type LitigationLegalAssessmentSourceSnapshot =
  | LitigationLegalAssessmentEvidenceSourceSnapshot[]
  | {
      evidenceSources: LitigationLegalAssessmentEvidenceSourceSnapshot[];
      legalAuthorities: LitigationLegalAssessmentAuthoritySnapshot[];
    };

export interface LitigationLegalAssessmentRecord {
  id: string;
  matter_id: string;
  claim_id: string;
  version: number;
  status: "confirmed" | "rejected" | "withdrawn";
  legal_basis: string | null;
  confidence: "low" | "medium" | "high" | null;
  uncertainty: string | null;
  decision_comment: string | null;
  source_snapshot: LitigationLegalAssessmentSourceSnapshot;
  payload_sha256: string;
  source_review_id: string | null;
  supersedes_id: string | null;
  created_by: string;
  created_at: string;
}

export type LitigationLegalAuthorityType =
  | "statute"
  | "regulation"
  | "judicial_interpretation"
  | "guiding_case"
  | "other";

export interface LitigationLegalAuthorityVersionRecord {
  id: string;
  matter_id: string;
  jurisdiction: string;
  authority_type: LitigationLegalAuthorityType;
  title: string;
  issuer: string;
  official_identifier: string;
  version_label: string;
  source_reference: string;
  content_sha256: string;
  effective_from: string;
  effective_to: string | null;
  status: "draft" | "verified" | "retired";
  verification_comment: string | null;
  verified_by: string | null;
  verified_at: string | null;
  retired_by: string | null;
  retired_at: string | null;
  retirement_comment: string | null;
  created_by: string;
  created_at: string;
}

export interface LitigationLegalAuthorityVersionDetail extends LitigationLegalAuthorityVersionRecord {
  user_id: string;
  content: string;
}

export interface LitigationPositionAuthorityRecord {
  id: string;
  matter_id: string;
  user_id: string;
  claim_id: string;
  authority_version_id: string;
  applicability_date: string;
  provision_reference: string;
  exact_quote: string;
  quote_sha256: string;
  rationale: string;
  status: "active" | "withdrawn";
  created_by: string;
  created_at: string;
  withdrawn_by: string | null;
  withdrawn_at: string | null;
  withdrawal_comment: string | null;
}

export interface LitigationPositionAuthorityStatusRecord {
  claim_id: string;
  status: "satisfied" | "missing" | "invalid";
  valid_link_ids: string[];
  invalid_link_ids: string[];
}

export interface LitigationLegalAuthorityRegistry {
  versions: LitigationLegalAuthorityVersionRecord[];
  links: LitigationPositionAuthorityRecord[];
}

export interface LitigationClaimElementRecord {
  id: string;
  claim_id: string;
  title: string;
  description: string | null;
  sequence: number;
  status: "proposed" | "confirmed" | "rejected";
  created_by: "agent" | "human";
  decision_comment: string | null;
  metadata: Record<string, unknown>;
}

export interface LitigationElementFactRecord {
  id: string;
  element_id: string;
  fact_id: string;
  relation: "supports" | "contradicts" | "gap";
  note: string | null;
}

export interface LitigationElementEvidenceStatusRecord {
  element_id: string;
  status:
    | "gap"
    | "pending_review"
    | "needs_source"
    | "supported"
    | "contradicted"
    | "contested";
  total_links: number;
  confirmed_supports: number;
  confirmed_contradictions: number;
  pending_links: number;
  rejected_links: number;
  uncited_confirmed_links: number;
}

export interface LitigationProceduralEventRecord {
  id: string;
  event_type: string;
  title: string;
  occurred_at: string | null;
  primary_source_span_id: string | null;
  status: "proposed" | "confirmed" | "rejected";
  created_by: "agent" | "human";
  decision_comment: string | null;
  document_name?: string | null;
  page?: number | null;
  quote?: string | null;
  event_version: number;
  supersedes_event_id: string | null;
  superseded_by_event_id: string | null;
  superseded_at: string | null;
  correction_reason: string | null;
  event_lineage_hash: string;
  metadata: Record<string, unknown>;
}

export interface LitigationProceduralEventCorrectionRecord {
  id: string;
  matter_id: string;
  user_id: string;
  original_event_id: string;
  replacement_event_id: string;
  from_occurred_at: string;
  to_occurred_at: string;
  reason: string;
  correction_hash: string;
  corrected_by: string;
  corrected_at: string;
}

export interface LitigationProceduralEventCorrectionResult {
  correctionId: string;
  correctionHash: string;
  originalEventId: string;
  fromOccurredAt: string;
  toOccurredAt: string;
  replacement: LitigationProceduralEventRecord;
  invalidatedDeadlines: number;
  invalidatedTasks: number;
}

export interface LitigationDeadlineRecord {
  id: string;
  matter_id: string;
  triggering_event_id: string | null;
  title: string;
  due_at: string;
  rule_label: string;
  rule_version: string;
  calculation: string;
  status: "proposed" | "confirmed" | "rejected" | "completed";
  created_by: "agent" | "human";
  decision_comment: string | null;
  document_name?: string | null;
  page?: number | null;
  quote?: string | null;
  calculation_hash: string;
  court_calendar_version_id: string | null;
  court_calendar_hash: string | null;
  stale_at: string | null;
  stale_reason: string | null;
  metadata: Record<string, unknown>;
}

export type LitigationCourtCalendarDisposition = "open" | "closed";

export interface LitigationCourtCalendarOverrideRecord {
  id: string;
  calendar_version_id: string;
  matter_id: string;
  user_id: string;
  local_date: string;
  disposition: LitigationCourtCalendarDisposition;
  source_reference: string;
  created_at: string;
}

export interface LitigationCourtCalendarVersionRecord {
  id: string;
  calendar_id: string;
  matter_id: string;
  user_id: string;
  name: string;
  jurisdiction: "CN";
  court_identifier: string;
  timezone: "Asia/Shanghai";
  version: number;
  version_label: string;
  supersedes_version_id: string | null;
  effective_from: string;
  effective_to: string;
  weekly_non_working_days: number[];
  source_authority_version_id: string;
  source_content_sha256: string;
  source_authority_title: string;
  source_authority_official_identifier: string;
  source_authority_version_label: string;
  source_authority_status: "draft" | "verified" | "retired";
  calendar_hash: string;
  status: "draft" | "verified" | "retired";
  verification_comment: string | null;
  verified_by: string | null;
  verified_at: string | null;
  retirement_comment: string | null;
  retired_by: string | null;
  retired_at: string | null;
  created_by: string;
  created_at: string;
  overrides: LitigationCourtCalendarOverrideRecord[];
}

export interface LitigationCourtCalendarRetirementResult {
  calendarVersionId: string;
  status: "retired";
  retiredRules: number;
  invalidatedDeadlines: number;
  invalidatedTasks: number;
}

export interface LitigationDeadlineRuleRecord {
  id: string;
  matter_id: string;
  user_id: string;
  name: string;
  jurisdiction: string;
  trigger_event_type: string;
  authority_version_id: string;
  provision_reference: string;
  exact_quote: string;
  quote_sha256: string;
  offset_days: number;
  counting_basis: "calendar_days" | "business_days";
  court_calendar_version_id: string | null;
  court_calendar_hash: string | null;
  start_policy: "same_day" | "next_day";
  timezone: "Asia/Shanghai";
  rule_hash: string;
  status: "draft" | "verified" | "retired";
  verification_comment: string | null;
  verified_by: string | null;
  verified_at: string | null;
  retired_by: string | null;
  retired_at: string | null;
  retirement_comment: string | null;
  created_by: string;
  created_at: string;
  authority_title: string;
  authority_official_identifier: string;
  authority_version_label: string;
  authority_content_sha256: string;
  authority_effective_from: string;
  authority_effective_to: string | null;
  authority_status: "draft" | "verified" | "retired";
}

export type AletheiaMatterTaskStatus = "open" | "completed";
export type AletheiaMatterTaskPriority = "high" | "normal" | "low";

export interface AletheiaMatterTaskRecord {
  id: string;
  matter_id: string;
  user_id: string;
  source_deadline_id: string;
  title: string;
  due_at: string;
  status: AletheiaMatterTaskStatus;
  priority: AletheiaMatterTaskPriority;
  note: string | null;
  completed_at: string | null;
  invalidated_at?: string | null;
  invalidated_reason?: string | null;
  created_at: string;
  updated_at: string;
}

export interface LitigationWorkspaceRecord {
  profile: Record<string, unknown> | null;
  facts: LitigationFactRecord[];
  fact_sources: LitigationFactSourceRecord[];
  claims: LitigationClaimRecord[];
  claim_sources: LitigationClaimSourceRecord[];
  position_authority_statuses: LitigationPositionAuthorityStatusRecord[];
  position_reviews: LitigationPositionReviewRecord[];
  legal_assessments: LitigationLegalAssessmentRecord[];
  agent_output_reviews: LitigationAgentOutputReviewRecord[];
  agent_finding_reviews: LitigationAgentFindingReviewRecord[];
  agent_finding_semantic_checks: LitigationAgentFindingSemanticCheckRecord[];
  elements: LitigationClaimElementRecord[];
  element_facts: LitigationElementFactRecord[];
  element_evidence_statuses: LitigationElementEvidenceStatusRecord[];
  procedural_events: LitigationProceduralEventRecord[];
  procedural_event_corrections: LitigationProceduralEventCorrectionRecord[];
  deadlines: LitigationDeadlineRecord[];
}

export interface LitigationRetrievalCandidate {
  rank: number;
  chunkId: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  page: number | null;
  section: string | null;
  quoteStart: number;
  quoteEnd: number;
  score: number;
  scoreDirection: "lower_is_better";
  retrievalLayers: string[];
  textSha256: string;
}

export interface LitigationRetrievalExcerpt {
  id: string;
  manifest_id: string;
  matter_id: string;
  user_id: string;
  chunk_id: string;
  document_id: string;
  document_name: string;
  rank: number;
  quote_start: number;
  quote_end: number;
  quote: string;
  quote_sha256: string;
  chunk_text_sha256: string;
  status: "confirmed" | "withdrawn";
  decision_comment: string;
  confirmed_by: string;
  confirmed_at: string;
  withdrawn_by: string | null;
  withdrawn_at: string | null;
  withdrawal_comment: string | null;
}

export interface LitigationRetrievalManifest {
  id: string;
  status: "open";
  schemaVersion: "aletheia-litigation-retrieval-manifest-v1";
  matterId: string;
  focus: string;
  mode: "keyword";
  rankingBasis: string;
  indexFingerprint: string;
  candidateLimit: number;
  candidateCount: number;
  candidateSetComplete: true;
  candidates: LitigationRetrievalCandidate[];
  purpose: "partition_ordering_diagnostics";
  inputBinding: false;
  selectedChunkIds: string[];
  omissionPolicy: "none";
  createdAt: string;
  manifestHash: string;
  excerpts?: LitigationRetrievalExcerpt[];
  bindingEligibility?:
    | { eligible: true; bindingHash: string }
    | { eligible: false; reason: string };
}

export interface LitigationAgentFindingReviewRecord {
  id: string;
  run_id: string;
  step_id: string;
  finding_index: number;
  finding_hash: string;
  assessment: "supported" | "partial" | "unsupported";
  reason: string;
  version: number;
  supersedes_id: string | null;
  reviewed_by: string;
  created_at: string;
}

export interface LitigationAgentFindingCitationAssessment {
  sourceId: string;
  assessment: "supported" | "partial" | "unsupported";
  rationale: string;
}

export interface LitigationAgentFindingSemanticCheckRecord {
  id: string;
  run_id: string;
  step_id: string;
  matter_id: string;
  user_id: string;
  finding_index: number;
  version: number;
  finding_hash: string;
  citation_set_hash: string;
  snapshot_hash: string;
  output_review_hash: string;
  model_id: string;
  model_revision: string;
  model_fingerprint: string;
  calibration_fingerprint: string;
  benchmark_fingerprint: string;
  calibration_id: string;
  benchmark_id: string;
  protocol_version: string;
  prompt_sha256: string;
  output_sha256: string | null;
  citation_assessments:
    | LitigationAgentFindingCitationAssessment[]
    | string
    | null;
  derived_verdict: "supported" | "partial" | "unsupported" | null;
  overall_rationale: string | null;
  uncertainty: string | null;
  status: "succeeded" | "failed";
  failure_code: string | null;
  failure_detail: string | null;
  duration_ms: number;
  supersedes_id: string | null;
  actor_id: string;
  created_at: string;
  stale: boolean;
  stale_reasons: string[];
}

export interface LitigationAgentOutputReviewRecord {
  id: string;
  run_id: string;
  matter_id: string;
  user_id: string;
  output_hash: string;
  snapshot_hash: string;
  status: "open" | "approved" | "rejected";
  requested_by: string;
  decision_comment: string | null;
  decided_by: string | null;
  independent_review: number;
  decided_at: string | null;
  created_at: string;
}

export async function updateLitigationProfile(
  matterId: string,
  payload: {
    organizationName?: string | null;
    court?: string | null;
    caseNumber?: string | null;
    exhibitPrefix: string;
    exhibitStart: number;
    paginationPolicy: "auto" | "source_native";
    documentTemplateId: string;
    documentTemplateVersion: number;
  },
) {
  return apiRequest<Record<string, unknown>>(
    `/aletheia/matters/${matterId}/litigation/profile`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export type LitigationDocumentTemplateRecord = {
  id: string;
  version: number;
  name: string;
  locale: string;
  status: "draft" | "approved" | "retired";
  templateHash: string;
  source?: "built_in" | "custom";
  file_sha256?: string;
  file_bytes?: number;
  placeholders?: string[];
  approval_checkpoint_id?: string | null;
  independent_approval?: 0 | 1;
  retirement_checkpoint_id?: string | null;
  retired_by?: string | null;
  retired_at?: string | null;
};

export async function listLitigationDocumentTemplates(matterId: string) {
  const result = await apiRequest<{
    templates: LitigationDocumentTemplateRecord[];
  }>(`/aletheia/matters/${matterId}/litigation/document-templates`);
  return result.templates;
}

export async function importLitigationDocumentTemplate(
  matterId: string,
  name: string,
  file: File,
) {
  const body = new FormData();
  body.set("name", name);
  body.set("template", file);
  return apiRequest<LitigationDocumentTemplateRecord>(
    `/aletheia/matters/${matterId}/litigation/document-templates/import`,
    { method: "POST", body },
  );
}

export async function publishLitigationDocumentTemplate(
  matterId: string,
  templateId: string,
  checkpointId: string,
) {
  return apiRequest<LitigationDocumentTemplateRecord>(
    `/aletheia/matters/${matterId}/litigation/document-templates/${templateId}/publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkpointId }),
    },
  );
}

export async function retireLitigationDocumentTemplate(
  matterId: string,
  templateId: string,
  checkpointId: string,
) {
  return apiRequest<LitigationDocumentTemplateRecord>(
    `/aletheia/matters/${matterId}/litigation/document-templates/${templateId}/retire`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkpointId }),
    },
  );
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

export async function createLegalResearchRequest(
  matterId: string,
  payload: LegalResearchRequestInput,
): Promise<AletheiaWorkProductRecord> {
  const wirePayload = {
    ...payload,
    factIds: payload.factIds.length > 0 ? payload.factIds : undefined,
    proceduralEventIds:
      payload.proceduralEventIds.length > 0
        ? payload.proceduralEventIds
        : undefined,
  };
  return apiRequest(`/aletheia/matters/${matterId}/research/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wirePayload),
  });
}

export async function getLegalResearchIssueTree(
  matterId: string,
  requestId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/requests/${requestId}/issues`,
  );
}

export async function saveLegalResearchIssueTree(
  matterId: string,
  requestId: string,
  nodes: LegalResearchIssueNode[],
): Promise<AletheiaWorkProductRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/requests/${requestId}/issues`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes }),
    },
  );
}

export async function importLegalResearchManualSource(
  matterId: string,
  requestId: string,
  payload: LegalResearchManualSourceInput,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/requests/${requestId}/manual-sources`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function createLegalResearchQueryPreview(
  matterId: string,
  requestId: string,
  payload: {
    issueTreeId: string;
    provider: LegalResearchProvider;
    query: string;
    protectedTerms?: string[];
  },
): Promise<AletheiaWorkProductRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/requests/${requestId}/query-preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueTreeId: payload.issueTreeId,
        provider: payload.provider,
        query: payload.query,
        ...(payload.protectedTerms?.length
          ? { protectedTerms: payload.protectedTerms }
          : {}),
      }),
    },
  );
}

export async function requestLegalResearchQueryApproval(
  matterId: string,
  queryPlanId: string,
): Promise<AletheiaHumanCheckpointRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/query-plans/${queryPlanId}/approval`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function executeLegalResearchSearch(
  matterId: string,
  queryPlanId: string,
  approvalCheckpointId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/query-plans/${queryPlanId}/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalCheckpointId }),
    },
  );
}

export async function requestLegalResearchSourceApproval(
  matterId: string,
  queryPlanId: string,
  searchResultId: string,
  documentId: string,
): Promise<AletheiaHumanCheckpointRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/query-plans/${queryPlanId}/search-results/${searchResultId}/sources/${encodeURIComponent(documentId)}/approval`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function fetchLegalResearchSource(
  matterId: string,
  queryPlanId: string,
  searchResultId: string,
  documentId: string,
  approvalCheckpointId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/query-plans/${queryPlanId}/search-results/${searchResultId}/sources/${encodeURIComponent(documentId)}/fetch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalCheckpointId }),
    },
  );
}

export async function confirmLegalResearchExcerpt(
  matterId: string,
  snapshotId: string,
  payload: { quote: string; comment: string },
): Promise<AletheiaWorkProductRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/snapshots/${snapshotId}/excerpts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function createLegalResearchInputManifest(
  matterId: string,
  requestId: string,
  excerptIds: string[],
): Promise<AletheiaWorkProductRecord> {
  return apiRequest(
    `/aletheia/matters/${matterId}/research/requests/${requestId}/input-manifests`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excerptIds }),
    },
  );
}

export async function createLegalResearchMemo(
  matterId: string,
  inputManifestId: string,
  findings: LegalResearchFindingInput[],
): Promise<AletheiaWorkProductRecord | LegalResearchMemoBlockedResponse> {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const path = `/aletheia/matters/${matterId}/research/input-manifests/${inputManifestId}/memos`;
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ findings }),
  });
  if (!response.ok && response.status !== 422)
    throw await toApiError(response, path);
  return (await response.json()) as
    | AletheiaWorkProductRecord
    | LegalResearchMemoBlockedResponse;
}

export async function getLitigationWorkspace(
  matterId: string,
): Promise<LitigationWorkspaceRecord> {
  return apiRequest<LitigationWorkspaceRecord>(
    `/aletheia/matters/${matterId}/litigation`,
  );
}

export async function listLitigationLegalAuthorities(matterId: string) {
  return apiRequest<LitigationLegalAuthorityRegistry>(
    `/aletheia/matters/${matterId}/litigation/legal-authorities`,
  );
}

export async function createLitigationLegalAuthorityVersion(
  matterId: string,
  payload: {
    authorityType: LitigationLegalAuthorityType;
    title: string;
    issuer: string;
    officialIdentifier: string;
    versionLabel: string;
    sourceReference: string;
    content: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
  },
) {
  return apiRequest<LitigationLegalAuthorityVersionDetail>(
    `/aletheia/matters/${matterId}/litigation/legal-authorities`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function getLitigationLegalAuthorityVersion(
  matterId: string,
  authorityVersionId: string,
) {
  return apiRequest<LitigationLegalAuthorityVersionDetail>(
    `/aletheia/matters/${matterId}/litigation/legal-authorities/${authorityVersionId}`,
  );
}

export async function verifyLitigationLegalAuthorityVersion(
  matterId: string,
  authorityVersionId: string,
  comment: string,
) {
  return apiRequest<LitigationLegalAuthorityVersionDetail>(
    `/aletheia/matters/${matterId}/litigation/legal-authorities/${authorityVersionId}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function retireLitigationLegalAuthorityVersion(
  matterId: string,
  authorityVersionId: string,
  comment: string,
) {
  return apiRequest<LitigationLegalAuthorityVersionDetail>(
    `/aletheia/matters/${matterId}/litigation/legal-authorities/${authorityVersionId}/retire`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function linkLitigationPositionAuthority(
  matterId: string,
  payload: {
    claimId: string;
    authorityVersionId: string;
    applicabilityDate: string;
    provisionReference: string;
    exactQuote: string;
    rationale: string;
  },
) {
  return apiRequest<LitigationPositionAuthorityRecord>(
    `/aletheia/matters/${matterId}/litigation/position-authorities`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function withdrawLitigationPositionAuthority(
  matterId: string,
  positionAuthorityId: string,
  comment: string,
) {
  return apiRequest<LitigationPositionAuthorityRecord>(
    `/aletheia/matters/${matterId}/litigation/position-authorities/${positionAuthorityId}/withdraw`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function createLitigationRetrievalManifest(
  matterId: string,
  focus: string,
) {
  return apiRequest<LitigationRetrievalManifest>(
    `/aletheia/matters/${matterId}/litigation/retrieval-manifests`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus }),
    },
  );
}

export async function getLitigationRetrievalManifest(
  matterId: string,
  manifestId: string,
) {
  return apiRequest<LitigationRetrievalManifest>(
    `/aletheia/matters/${matterId}/litigation/retrieval-manifests/${manifestId}`,
  );
}

export async function confirmLitigationRetrievalExcerpt(
  matterId: string,
  manifestId: string,
  payload: { chunkId: string; comment: string },
) {
  return apiRequest<LitigationRetrievalExcerpt>(
    `/aletheia/matters/${matterId}/litigation/retrieval-manifests/${manifestId}/excerpts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function withdrawLitigationRetrievalExcerpt(
  matterId: string,
  excerptId: string,
  comment: string,
) {
  return apiRequest<LitigationRetrievalExcerpt>(
    `/aletheia/matters/${matterId}/litigation/retrieval-excerpts/${excerptId}/withdraw`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function createLitigationFact(
  matterId: string,
  payload: {
    statement: string;
    occurredAt?: string | null;
    datePrecision?: string;
    sourceRelation?: string;
    helpfulness?: string;
    confidence?: "low" | "medium" | "high" | null;
    source?: {
      sourceChunkId: string;
      quoteStart: number;
      quoteEnd: number;
    } | null;
    createdBy?: "agent" | "human";
  },
) {
  return apiRequest<LitigationFactRecord>(
    `/aletheia/matters/${matterId}/litigation/facts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function decideLitigationFact(
  matterId: string,
  factId: string,
  next: "confirmed" | "rejected",
  comment?: string,
) {
  return apiRequest<LitigationFactRecord>(
    `/aletheia/matters/${matterId}/litigation/facts/${factId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: next, comment }),
    },
  );
}

export async function verifyLitigationSourceSpanOriginal(
  matterId: string,
  sourceSpanId: string,
  reason: string,
) {
  return apiRequest<{
    id: string;
    source_span_id: string;
    reason: string;
    verified_by: string;
    verified_at: string;
  }>(
    `/aletheia/matters/${matterId}/litigation/source-spans/${sourceSpanId}/verify-original`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
}

export interface LitigationSourceOriginalVerificationHistoryItem {
  id: string;
  sourceChunkSha256: string;
  quoteSha256: string;
  reason: string;
  verifiedBy: string;
  verifiedAt: string;
  current: boolean;
  withdrawal: {
    id: string;
    reason: string;
    withdrawnBy: string;
    withdrawnAt: string;
  } | null;
}

export interface LitigationSourceOriginalVerificationHistory {
  sourceSpanId: string;
  items: LitigationSourceOriginalVerificationHistoryItem[];
}

function historyString(
  value: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
) {
  const candidate = value[snakeKey] ?? value[camelKey];
  return typeof candidate === "string" ? candidate : "";
}

export async function getLitigationSourceSpanOriginalVerificationHistory(
  matterId: string,
  sourceSpanId: string,
): Promise<LitigationSourceOriginalVerificationHistory> {
  const response = await apiRequest<unknown>(
    `/aletheia/matters/${encodeURIComponent(matterId)}/litigation/source-spans/${encodeURIComponent(sourceSpanId)}/original-verification-history`,
  );
  if (!response || typeof response !== "object") {
    throw new Error("invalid_original_verification_history");
  }
  const payload = response as Record<string, unknown>;
  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.verifications)
      ? payload.verifications
      : null;
  if (!rawItems) throw new Error("invalid_original_verification_history");

  const items = rawItems.map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") {
      throw new Error("invalid_original_verification_history");
    }
    const item = rawItem as Record<string, unknown>;
    const nestedWithdrawal =
      item.withdrawal && typeof item.withdrawal === "object"
        ? (item.withdrawal as Record<string, unknown>)
        : null;
    const withdrawnAt = nestedWithdrawal
      ? historyString(nestedWithdrawal, "withdrawn_at", "withdrawnAt")
      : historyString(item, "withdrawn_at", "withdrawnAt");
    const withdrawal = withdrawnAt
      ? {
          id: nestedWithdrawal
            ? historyString(nestedWithdrawal, "id", "id")
            : historyString(item, "withdrawal_id", "withdrawalId"),
          reason: nestedWithdrawal
            ? historyString(nestedWithdrawal, "reason", "reason")
            : historyString(item, "withdrawal_reason", "withdrawalReason"),
          withdrawnBy: nestedWithdrawal
            ? historyString(nestedWithdrawal, "withdrawn_by", "withdrawnBy")
            : historyString(item, "withdrawn_by", "withdrawnBy"),
          withdrawnAt,
        }
      : null;
    const id =
      historyString(item, "verification_id", "verificationId") ||
      historyString(item, "id", "id");
    const sourceChunkSha256 = historyString(
      item,
      "source_chunk_sha256",
      "sourceChunkSha256",
    );
    const quoteSha256 = historyString(item, "quote_sha256", "quoteSha256");
    const reason = historyString(item, "reason", "reason");
    const verifiedBy = historyString(item, "verified_by", "verifiedBy");
    const verifiedAt = historyString(item, "verified_at", "verifiedAt");
    if (!id || !sourceChunkSha256 || !quoteSha256 || !verifiedAt) {
      throw new Error("invalid_original_verification_history");
    }
    return {
      id,
      sourceChunkSha256,
      quoteSha256,
      reason,
      verifiedBy,
      verifiedAt,
      current:
        typeof item.current === "boolean"
          ? item.current
          : item.is_current === true || item.isCurrent === true,
      withdrawal,
    } satisfies LitigationSourceOriginalVerificationHistoryItem;
  });

  return {
    sourceSpanId:
      historyString(payload, "source_span_id", "sourceSpanId") || sourceSpanId,
    items,
  };
}

export interface LitigationSourceOriginalVerificationWithdrawalRecord {
  id: string;
  source_span_id: string;
  verification_id: string;
  reason: string;
  withdrawn_by: string;
  withdrawn_at: string;
}

export async function withdrawLitigationSourceSpanOriginalVerification(
  matterId: string,
  sourceSpanId: string,
  verificationId: string,
  reason: string,
) {
  return apiRequest<LitigationSourceOriginalVerificationWithdrawalRecord>(
    `/aletheia/matters/${matterId}/litigation/source-spans/${sourceSpanId}/verifications/${verificationId}/withdraw`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
}

export async function createLitigationClaim(
  matterId: string,
  payload: {
    kind: "claim" | "defense" | "rebuttal";
    title: string;
    legalBasis?: string | null;
    confidence?: "low" | "medium" | "high" | null;
    uncertainty?: string | null;
    sourceRelation?: "authority" | "supports" | "contradicts";
    source?: {
      sourceChunkId: string;
      quoteStart: number;
      quoteEnd: number;
    } | null;
    parentClaimId?: string | null;
    createdBy?: "agent" | "human";
  },
) {
  return apiRequest<LitigationClaimRecord>(
    `/aletheia/matters/${matterId}/litigation/claims`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function createLitigationPositionReview(
  matterId: string,
  claimId: string,
  payload: {
    kind: LitigationPositionReviewRecord["kind"];
    reason: string;
    requestedOutcome: LitigationPositionReviewRecord["requested_outcome"];
    parentReviewId?: string | null;
    createdBy?: "human" | "agent";
  },
) {
  return apiRequest<LitigationPositionReviewRecord>(
    `/aletheia/matters/${matterId}/litigation/claims/${claimId}/reviews`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function resolveLitigationPositionReview(
  matterId: string,
  reviewId: string,
  payload: {
    resolution: "upheld" | "granted" | "dismissed";
    comment: string;
  },
) {
  return apiRequest<LitigationPositionReviewRecord>(
    `/aletheia/matters/${matterId}/litigation/position-reviews/${reviewId}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function withdrawLitigationPositionReview(
  matterId: string,
  reviewId: string,
) {
  return apiRequest<LitigationPositionReviewRecord>(
    `/aletheia/matters/${matterId}/litigation/position-reviews/${reviewId}/withdraw`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function decideLitigationClaim(
  matterId: string,
  claimId: string,
  next: "confirmed" | "rejected",
  comment?: string,
) {
  return apiRequest<LitigationClaimRecord>(
    `/aletheia/matters/${matterId}/litigation/claims/${claimId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: next, comment }),
    },
  );
}

export async function createLitigationClaimElement(
  matterId: string,
  claimId: string,
  payload: {
    title: string;
    description?: string | null;
    sequence?: number;
    createdBy?: "agent" | "human";
  },
) {
  return apiRequest<LitigationClaimElementRecord>(
    `/aletheia/matters/${matterId}/litigation/claims/${claimId}/elements`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function decideLitigationClaimElement(
  matterId: string,
  elementId: string,
  next: "confirmed" | "rejected",
  comment?: string,
) {
  return apiRequest<LitigationClaimElementRecord>(
    `/aletheia/matters/${matterId}/litigation/elements/${elementId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: next, comment }),
    },
  );
}

export async function linkLitigationElementFact(
  matterId: string,
  elementId: string,
  payload: {
    factId: string;
    relation: "supports" | "contradicts" | "gap";
    note?: string | null;
  },
) {
  return apiRequest<LitigationElementFactRecord>(
    `/aletheia/matters/${matterId}/litigation/elements/${elementId}/facts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function createLitigationProceduralEvent(
  matterId: string,
  payload: {
    eventType: string;
    title: string;
    occurredAt?: string | null;
    source?: {
      sourceChunkId: string;
      quoteStart: number;
      quoteEnd: number;
    } | null;
    createdBy?: "agent" | "human";
  },
) {
  return apiRequest<LitigationProceduralEventRecord>(
    `/aletheia/matters/${matterId}/litigation/procedural-events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function decideLitigationProceduralEvent(
  matterId: string,
  eventId: string,
  next: "confirmed" | "rejected",
  comment?: string,
) {
  return apiRequest<LitigationProceduralEventRecord>(
    `/aletheia/matters/${matterId}/litigation/procedural-events/${eventId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: next, comment }),
    },
  );
}

export async function correctLitigationProceduralEvent(
  matterId: string,
  eventId: string,
  payload: {
    title: string;
    occurredAt: string;
    reason: string;
    source?: {
      sourceChunkId: string;
      quoteStart: number;
      quoteEnd: number;
    };
  },
) {
  return apiRequest<LitigationProceduralEventCorrectionResult>(
    `/aletheia/matters/${matterId}/litigation/procedural-events/${eventId}/corrections`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function listLitigationDeadlineRules(matterId: string) {
  return apiRequest<LitigationDeadlineRuleRecord[]>(
    `/aletheia/matters/${matterId}/litigation/deadline-rules`,
  );
}

export async function listLitigationCourtCalendars(matterId: string) {
  return apiRequest<LitigationCourtCalendarVersionRecord[]>(
    `/aletheia/matters/${matterId}/litigation/court-calendars`,
  );
}

export async function createLitigationCourtCalendar(
  matterId: string,
  payload: {
    courtIdentifier: string;
    name: string;
    versionLabel: string;
    sourceAuthorityVersionId: string;
    effectiveFrom: string;
    effectiveTo: string;
    weeklyNonWorkingDays: number[];
    overrides: Array<{
      localDate: string;
      disposition: LitigationCourtCalendarDisposition;
      sourceReference: string;
    }>;
  },
) {
  return apiRequest<LitigationCourtCalendarVersionRecord>(
    `/aletheia/matters/${matterId}/litigation/court-calendars`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function verifyLitigationCourtCalendar(
  matterId: string,
  versionId: string,
  comment: string,
) {
  return apiRequest<LitigationCourtCalendarVersionRecord>(
    `/aletheia/matters/${matterId}/litigation/court-calendars/${versionId}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function retireLitigationCourtCalendar(
  matterId: string,
  versionId: string,
  comment: string,
) {
  return apiRequest<LitigationCourtCalendarRetirementResult>(
    `/aletheia/matters/${matterId}/litigation/court-calendars/${versionId}/retire`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function createLitigationDeadlineRule(
  matterId: string,
  payload: {
    name: string;
    triggerEventType: string;
    authorityVersionId: string;
    provisionReference: string;
    exactQuote: string;
    offsetDays: number;
    countingBasis: "calendar_days" | "business_days";
    courtCalendarVersionId?: string;
    startPolicy: "same_day" | "next_day";
  },
) {
  return apiRequest<LitigationDeadlineRuleRecord>(
    `/aletheia/matters/${matterId}/litigation/deadline-rules`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function verifyLitigationDeadlineRule(
  matterId: string,
  ruleId: string,
  comment: string,
) {
  return apiRequest<LitigationDeadlineRuleRecord>(
    `/aletheia/matters/${matterId}/litigation/deadline-rules/${ruleId}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function calculateLitigationDeadlineRule(
  matterId: string,
  ruleId: string,
  payload: { eventId: string; title: string },
) {
  return apiRequest<LitigationDeadlineRecord>(
    `/aletheia/matters/${matterId}/litigation/deadline-rules/${ruleId}/calculate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function retireLitigationDeadlineRule(
  matterId: string,
  ruleId: string,
  comment: string,
) {
  return apiRequest<LitigationDeadlineRuleRecord>(
    `/aletheia/matters/${matterId}/litigation/deadline-rules/${ruleId}/retire`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function createLitigationDeadline(
  matterId: string,
  payload: {
    title: string;
    dueAt: string;
    triggeringEventId?: string | null;
    ruleLabel: string;
    ruleVersion: string;
    calculation: string;
    source?: {
      sourceChunkId: string;
      quoteStart: number;
      quoteEnd: number;
    } | null;
    createdBy?: "agent" | "human";
  },
) {
  return apiRequest<LitigationDeadlineRecord>(
    `/aletheia/matters/${matterId}/litigation/deadlines`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function decideLitigationDeadline(
  matterId: string,
  deadlineId: string,
  next: "confirmed" | "rejected",
  comment?: string,
) {
  return apiRequest<LitigationDeadlineRecord>(
    `/aletheia/matters/${matterId}/litigation/deadlines/${deadlineId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: next, comment }),
    },
  );
}

export async function createMatterTaskFromDeadline(
  matterId: string,
  deadlineId: string,
  payload?: {
    title?: string;
    priority?: AletheiaMatterTaskPriority;
    note?: string | null;
  },
) {
  return apiRequest<AletheiaMatterTaskRecord>(
    `/aletheia/matters/${matterId}/litigation/deadlines/${deadlineId}/task`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    },
  );
}

export async function listAletheiaTasks(
  status: AletheiaMatterTaskStatus | "all" = "open",
) {
  return apiRequest<AletheiaMatterTaskRecord[]>(
    `/aletheia/tasks?status=${encodeURIComponent(status)}`,
  );
}

export type AletheiaTaskNotificationClaim = {
  deliveryId: string;
  leaseToken: string;
  tag: string;
  category: "due_soon" | "overdue";
  taskId: string;
  matterId: string;
  matterTitle: string;
  title: string;
  dueAt: string;
  attemptCount: number;
};

export async function claimAletheiaTaskNotifications() {
  return apiRequest<{
    claimedAt: string;
    claims: AletheiaTaskNotificationClaim[];
    withdrawals: Array<{ deliveryId: string; taskId: string; tag: string }>;
  }>("/aletheia/task-notifications/claim", { method: "POST" });
}

export async function acknowledgeAletheiaTaskNotification(
  deliveryId: string,
  payload: {
    leaseToken: string;
    outcome: "delivered" | "failed";
    failureCode?: string | null;
  },
) {
  return apiRequest<Record<string, unknown>>(
    `/aletheia/task-notifications/${deliveryId}/ack`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function fetchAletheiaTaskCalendar(
  status: AletheiaMatterTaskStatus | "all" = "open",
): Promise<Blob> {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const path = `/aletheia/tasks/calendar.ics?status=${encodeURIComponent(status)}`;
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
    headers: {
      Accept: "text/calendar",
      ...authHeaders,
    },
  });
  if (!response.ok) throw await toApiError(response, path);
  return response.blob();
}

export async function completeAletheiaTask(taskId: string) {
  return apiRequest<AletheiaMatterTaskRecord>(
    `/aletheia/tasks/${taskId}/complete`,
    { method: "POST" },
  );
}

export async function reopenAletheiaTask(taskId: string) {
  return apiRequest<AletheiaMatterTaskRecord>(
    `/aletheia/tasks/${taskId}/reopen`,
    { method: "POST" },
  );
}

export type LitigationArtifactKind =
  | "evidence_catalog"
  | "claim_defense_matrix"
  | "procedural_clock"
  | "litigation_brief"
  | "hearing_plan"
  | "hearing_bundle_index";

export type LitigationAuditChecklistStatus =
  | "satisfied"
  | "action_required"
  | "not_applicable";

export interface LitigationAuditChecklistItem {
  id: string;
  status: LitigationAuditChecklistStatus;
  summary: string;
}

export interface LitigationAuditChecklist {
  schema_version: "vera-litigation-counsel-signoff-checklist-v1";
  overall_status: "ready" | "action_required";
  items: LitigationAuditChecklistItem[];
  assurance_limit: string;
}

export interface LitigationMatterAuditExportPreview {
  schema_version: "vera-litigation-matter-audit-package-v1";
  matter_id: string;
  matter_state_hash: string;
  checklist: LitigationAuditChecklist;
  checklist_hash: string;
  attestation_version: "vera-counsel-audit-attestation-v1";
  attestation: string;
}

export interface LitigationMatterAuditExportSummary {
  export_id: string;
  export_hash: string;
  matter_state_hash: string;
  checklist_hash: string;
  checklist: LitigationAuditChecklist;
  exported_at: string;
  exported_by: string;
  approval_checkpoint_id: string | null;
  stale: boolean;
  signoff_count: number;
}

export interface LitigationMatterAuditExportPackage {
  schema_version: "vera-litigation-matter-audit-package-v1";
  local_only: true;
  matter_id: string;
  exported_at: string;
  exported_by: string;
  export_id: string;
  export_hash: string;
  matter_state_hash: string;
  checklist: LitigationAuditChecklist;
  checklist_hash: string;
  section_hashes: Record<string, string>;
  snapshot: Record<string, unknown>;
  assurance_limit: string;
}

export interface LitigationMatterAuditExportSignoff {
  id: string;
  matterId: string;
  ownerId: string;
  exportId: string;
  exportHash: string;
  checklistSchemaVersion: string;
  checklistHash: string;
  matterStateHash: string;
  actorId: string;
  signerName: string;
  professionalIdentifier: string | null;
  attestationVersion: string;
  attestation: string;
  comment: string;
  independentReview: boolean;
  signedAt: string;
  signoffHash: string;
  auditEventId: string | null;
  auditEventSequence: number | null;
  auditEventHash: string | null;
  audit_binding_valid: boolean;
  integrity_valid: boolean;
  stale: boolean;
}

export interface LitigationSignoffAnchorProof {
  schema_version: "aletheia-litigation-signoff-anchor-proof-v1";
  configured: boolean;
  anchored: boolean;
  can_anchor: boolean;
  exact_current_matter_head: boolean;
  target?: {
    signoff_id: string;
    signoff_hash: string;
    audit_event_id: string;
    audit_event_sequence: number;
    audit_event_hash: string;
  };
  coverage?: null | {
    schema_version: "aletheia-litigation-signoff-anchor-coverage-v1";
    coverage: "exact_matter_audit_head";
    anchor_id: string;
    anchor_index: number;
    anchor_hash: string;
    anchored_at: string;
    reason: string;
    key_id: string;
    signature_algorithm: "ed25519";
    signature: string;
    journal_head: string;
    journal_entries: number;
    matter_head: {
      matter_id: string;
      event_count: number;
      chained_event_count: number;
      invalid_event_count: number;
      sequence_anomaly_count: number;
      last_sequence: number;
      last_event_hash: string;
    };
  };
  runtime: {
    enabled: boolean;
    healthy: boolean;
    protection_active: boolean;
    key_id: string | null;
    journal_entries: number;
    journal_head: string | null;
    last_success_at: string | null;
    last_error: string | null;
  };
  assurance: string;
}

export function getLitigationMatterAuditExportPreview(matterId: string) {
  return apiRequest<LitigationMatterAuditExportPreview>(
    `/aletheia/matters/${matterId}/litigation/audit-exports/preview`,
  );
}

export function listLitigationMatterAuditExports(matterId: string) {
  return apiRequest<LitigationMatterAuditExportSummary[]>(
    `/aletheia/matters/${matterId}/litigation/audit-exports`,
  );
}

export function createLitigationMatterAuditExport(
  matterId: string,
  payload: {
    approvalCheckpointId: string;
    governanceApprovalRequestId?: string | null;
  },
) {
  return apiRequest<LitigationMatterAuditExportPackage>(
    `/aletheia/matters/${matterId}/litigation/audit-exports`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export function getLitigationMatterAuditExport(
  matterId: string,
  exportId: string,
) {
  return apiRequest<LitigationMatterAuditExportPackage>(
    `/aletheia/matters/${matterId}/litigation/audit-exports/${exportId}`,
  );
}

export function listLitigationMatterAuditExportSignoffs(
  matterId: string,
  exportId: string,
) {
  return apiRequest<LitigationMatterAuditExportSignoff[]>(
    `/aletheia/matters/${matterId}/litigation/audit-exports/${exportId}/signoffs`,
  );
}

export function signLitigationMatterAuditExport(
  matterId: string,
  exportId: string,
  payload: {
    exportHash: string;
    checklistHash: string;
    matterStateHash: string;
    signerName: string;
    professionalIdentifier?: string | null;
    attestation: string;
    comment: string;
  },
) {
  return apiRequest<LitigationMatterAuditExportSignoff>(
    `/aletheia/matters/${matterId}/litigation/audit-exports/${exportId}/signoffs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export function getLitigationMatterAuditSignoffAnchorProof(
  matterId: string,
  exportId: string,
  signoffId: string,
) {
  return apiRequest<LitigationSignoffAnchorProof>(
    `/aletheia/matters/${matterId}/litigation/audit-exports/${exportId}/signoffs/${signoffId}/anchor-proof`,
  );
}

export function anchorLitigationMatterAuditSignoff(
  matterId: string,
  exportId: string,
  signoffId: string,
) {
  return apiRequest<LitigationSignoffAnchorProof>(
    `/aletheia/matters/${matterId}/litigation/audit-exports/${exportId}/signoffs/${signoffId}/anchor`,
    { method: "POST" },
  );
}

export async function generateLitigationArtifact(
  matterId: string,
  kind: LitigationArtifactKind,
) {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/litigation/artifacts/${kind}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}

export type LitigationDocumentDraftArtifactKind =
  | "litigation_brief"
  | "hearing_plan";

export interface LitigationDocumentDraftSection {
  id: string;
  heading: string;
  body: string;
}

export interface LitigationDocumentDraftVersionRecord {
  id: string;
  document_id: string;
  matter_id: string;
  user_id: string;
  version: number;
  parent_version_id: string | null;
  parent_content_hash: string | null;
  content_hash: string;
  sections: LitigationDocumentDraftSection[];
  change_summary: string;
  provenance: {
    schemaVersion: string;
    actor: "human";
    actorId: string;
    source:
      | "server_artifact_projection"
      | "server_authenticated_edit"
      | "external_docx_import";
    artifactId?: string;
    artifactKind?: LitigationDocumentDraftArtifactKind;
    sourceContentHash?: string;
    sourceDependencyHash?: string;
    baseVersion?: number;
    baseVersionId?: string;
    originalFilename?: string;
    fileSha256?: string;
    parserProtocol?: string;
    bindingHash?: string;
  };
  created_by: string;
  created_at: string;
  review_status: "unreviewed" | "approved" | "rejected";
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface LitigationDocumentDraftRecord {
  id: string;
  matter_id: string;
  user_id: string;
  artifact_id: string;
  artifact_kind: LitigationDocumentDraftArtifactKind;
  source_content_hash: string;
  source_dependency_hash: string;
  current_version_id: string;
  status: "active" | "withdrawn";
  withdrawn_by: string | null;
  withdrawn_at: string | null;
  withdrawal_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  stale: boolean;
  stale_reasons: string[];
}

export interface LitigationDocumentDraftImportAttempt {
  id: string;
  document_id: string;
  matter_id: string;
  user_id: string;
  base_version_id: string | null;
  base_version: number | null;
  base_content_hash: string | null;
  original_filename: string;
  file_sha256: string;
  file_bytes: number;
  parser_protocol: string;
  binding_hash: string | null;
  status: "accepted" | "rejected";
  failure_code: string | null;
  failure_detail: string | null;
  accepted_version_id: string | null;
  actor_id: string;
  created_at: string;
}

export interface LitigationDocumentDraftDetail extends LitigationDocumentDraftRecord {
  versions: LitigationDocumentDraftVersionRecord[];
  import_attempts: LitigationDocumentDraftImportAttempt[];
}

export interface LitigationDocumentDraftDiffChange {
  id: string;
  status: "added" | "removed" | "unchanged" | "modified";
  old_hash: string | null;
  new_hash: string | null;
  old_section: LitigationDocumentDraftSection | null;
  new_section: LitigationDocumentDraftSection | null;
}

export interface LitigationDocumentDraftDiff {
  document: LitigationDocumentDraftRecord;
  from_version?: number;
  to_version?: number;
  changes: LitigationDocumentDraftDiffChange[];
}

export function createLitigationDocumentDraft(
  matterId: string,
  artifactId: string,
) {
  return apiRequest<LitigationDocumentDraftDetail>(
    `/aletheia/matters/${matterId}/litigation/artifacts/${artifactId}/document-draft`,
    { method: "POST" },
  );
}

export async function listLitigationDocumentDrafts(matterId: string) {
  const response = await apiRequest<{
    document_drafts: LitigationDocumentDraftRecord[];
  }>(`/aletheia/matters/${matterId}/litigation/document-drafts`);
  return response.document_drafts;
}

export function getLitigationDocumentDraft(
  matterId: string,
  documentId: string,
) {
  return apiRequest<LitigationDocumentDraftDetail>(
    `/aletheia/matters/${matterId}/litigation/document-drafts/${documentId}`,
  );
}

export function appendLitigationDocumentDraftVersion(
  matterId: string,
  documentId: string,
  payload: {
    baseVersion: number;
    changeSummary: string;
    sections: LitigationDocumentDraftSection[];
  },
) {
  return apiRequest<LitigationDocumentDraftDetail>(
    `/aletheia/matters/${matterId}/litigation/document-drafts/${documentId}/versions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

function filenameFromDisposition(value: string | null) {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1] ?? null;
}

export async function exportLitigationDocumentDraftDocx(
  matterId: string,
  documentId: string,
  versionId: string,
) {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const path = `/aletheia/matters/${matterId}/litigation/document-drafts/${documentId}/versions/${versionId}/docx-export`;
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ...authHeaders,
    },
  });
  if (!response.ok) throw await toApiError(response, path);
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(
      response.headers.get("content-disposition"),
    ),
    fileSha256: response.headers.get("x-vera-file-sha256"),
    bindingHash: response.headers.get("x-vera-binding-sha256"),
  };
}

export async function importLitigationDocumentDraftDocx(
  matterId: string,
  documentId: string,
  document: File,
  changeSummary: string,
) {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const path = `/aletheia/matters/${matterId}/litigation/document-drafts/${documentId}/docx-import`;
  const form = new FormData();
  form.append("document", document);
  form.append("changeSummary", changeSummary);
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", ...authHeaders },
    body: form,
  });
  if (!response.ok) throw await toApiError(response, path);
  return (await response.json()) as LitigationDocumentDraftDetail;
}

export function diffLitigationDocumentDraftVersions(
  matterId: string,
  documentId: string,
  fromVersion: number,
  toVersion: number,
) {
  const query = new URLSearchParams({
    fromVersion: String(fromVersion),
    toVersion: String(toVersion),
  });
  return apiRequest<LitigationDocumentDraftDiff>(
    `/aletheia/matters/${matterId}/litigation/document-drafts/${documentId}/diff?${query}`,
  );
}

export function reviewLitigationDocumentDraftVersion(
  matterId: string,
  documentId: string,
  versionId: string,
  payload: { decision: "approved" | "rejected"; reason: string },
) {
  return apiRequest<LitigationDocumentDraftDetail>(
    `/aletheia/matters/${matterId}/litigation/document-drafts/${documentId}/versions/${versionId}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export function withdrawLitigationDocumentDraft(
  matterId: string,
  documentId: string,
  reason: string,
) {
  return apiRequest<LitigationDocumentDraftDetail>(
    `/aletheia/matters/${matterId}/litigation/document-drafts/${documentId}/withdraw`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
}

export interface LitigationArtifactExportResult {
  schemaVersion: "aletheia-litigation-artifact-export-v2";
  exportId: string;
  matterId: string;
  workProductId: string;
  kind: LitigationArtifactKind;
  version: number;
  contentHash: string;
  format: "docx" | "json" | "zip";
  mimeType: string;
  exportHash: string;
}

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

export interface LitigationArtifactExportApprovalProjection {
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
  governanceRequest: {
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
  } | null;
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
  export: {
    status: "exported";
    exportId: string;
    exportedBy: string;
    exportedAt: string;
  } | null;
}

export function getLitigationArtifactExportApproval(
  matterId: string,
  workProductId: string,
) {
  return apiRequest<LitigationArtifactExportApprovalProjection>(
    `/aletheia/matters/${matterId}/litigation/artifacts/${workProductId}/export-approval`,
  );
}

export function voteLitigationArtifactExportApproval(
  matterId: string,
  workProductId: string,
  payload: {
    approvalCheckpointId: string;
    decision: "approved" | "rejected";
    comment?: string | null;
  },
) {
  return apiRequest<LitigationArtifactExportApprovalProjection>(
    `/aletheia/matters/${matterId}/litigation/artifacts/${workProductId}/export-approval/votes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function exportLitigationArtifact(
  matterId: string,
  workProductId: string,
  approvalCheckpointId: string,
  kind: LitigationArtifactKind,
) {
  return apiRequest<LitigationArtifactExportResult>(
    `/aletheia/matters/${matterId}/litigation/artifacts/${workProductId}/export`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approvalCheckpointId,
        format: kind === "hearing_bundle_index" ? "zip" : "docx",
      }),
    },
  );
}

export async function fetchLitigationArtifactDownload(
  matterId: string,
  exportId: string,
) {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const response = await fetch(
    `${apiBase}/aletheia/matters/${matterId}/litigation/exports/${exportId}/download`,
    {
      cache: "no-store",
      headers: {
        Accept:
          "application/zip, application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ...authHeaders,
      },
    },
  );
  if (!response.ok) {
    throw await toApiError(response, "litigation artifact download");
  }
  return response.blob();
}

export type LitigationEvalRun = {
  id: string;
  suite_version: string;
  status: "completed";
  passed: number;
  total: number;
  result_hash: string;
  created_at: string;
  results: Array<{
    id: string;
    case_id: string;
    case_type: "golden" | "bad_case";
    expected: boolean;
    actual: boolean;
    passed: boolean;
    grader_id: string;
    grader_version: string;
    evidence_refs: string[];
  }>;
};

export async function listLitigationEvalRuns(matterId: string) {
  return apiRequest<LitigationEvalRun[]>(
    `/aletheia/matters/${matterId}/litigation/eval-runs`,
  );
}

export async function runLitigationEvalSuite(matterId: string) {
  return apiRequest<LitigationEvalRun>(
    `/aletheia/matters/${matterId}/litigation/eval-runs`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
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

export async function uploadAletheiaMatterDocuments(
  matterId: string,
  files: File[],
): Promise<AletheiaDocumentBatchUploadResult> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }
  return apiRequest<AletheiaDocumentBatchUploadResult>(
    `/aletheia/matters/${matterId}/documents/batch`,
    {
      method: "POST",
      body: form,
    },
  );
}

export async function retryAletheiaMatterDocumentParse(
  matterId: string,
  documentId: string,
): Promise<AletheiaMatterDocumentRecord> {
  return apiRequest<AletheiaMatterDocumentRecord>(
    `/aletheia/matters/${matterId}/documents/${documentId}/retry-parse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}

export type AletheiaOriginalDocumentDownload = {
  blob: Blob;
  mimeType: string;
  sha256: string;
  size: number;
};

export async function fetchAletheiaMatterDocumentOriginal(
  matterId: string,
  documentId: string,
): Promise<AletheiaOriginalDocumentDownload> {
  const authHeaders = await getAuthHeader();
  const apiBase = await getAletheiaApiBase();
  const path = `/aletheia/matters/${encodeURIComponent(matterId)}/documents/${encodeURIComponent(documentId)}/original`;
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
    headers: { Accept: "*/*", ...authHeaders },
  });
  if (!response.ok) throw await toApiError(response, path);

  const sha256Header = response.headers.get("x-aletheia-content-sha256");
  const sha256 = sha256Header?.trim().toLowerCase() ?? "";
  const sizeHeader = response.headers.get("content-length");
  const declaredSize = sizeHeader === null ? Number.NaN : Number(sizeHeader);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new AletheiaApiError({
      status: 502,
      code: "original_integrity_metadata_missing",
      message: "Original integrity metadata is unavailable",
    });
  }
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    throw new AletheiaApiError({
      status: 502,
      code: "original_size_metadata_invalid",
      message: "Original size metadata is invalid",
    });
  }

  const blob = await response.blob();
  return {
    blob,
    mimeType: response.headers.get("content-type")?.split(";", 1)[0] ?? "",
    sha256,
    size: declaredSize,
  };
}

export async function searchAletheiaMatterDocuments(
  matterId: string,
  query: string,
): Promise<AletheiaDocumentSearchResult[]> {
  return apiRequest<AletheiaDocumentSearchResult[]>(
    `/aletheia/matters/${matterId}/documents/search?q=${encodeURIComponent(query)}`,
  );
}

export async function searchAletheia(
  query: string,
  limit = 40,
  signal?: AbortSignal,
): Promise<AletheiaSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  return apiRequest<AletheiaSearchResponse>(
    `/aletheia/search?${params.toString()}`,
    { signal },
  );
}

export async function listAletheiaV1SourceIndex(
  matterId: string,
  options: {
    includeChunks?: boolean;
    includeEvidenceLinks?: boolean;
    chunkLimit?: number;
    documentIds?: string[];
  } = {},
): Promise<AletheiaV1SourceIndex> {
  const params = new URLSearchParams();
  if (options.includeChunks !== undefined) {
    params.set("includeChunks", String(options.includeChunks));
  }
  if (options.includeEvidenceLinks !== undefined) {
    params.set("includeEvidenceLinks", String(options.includeEvidenceLinks));
  }
  if (options.chunkLimit !== undefined) {
    params.set("chunkLimit", String(options.chunkLimit));
  }
  for (const documentId of options.documentIds ?? []) {
    params.append("documentId", documentId);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<AletheiaV1SourceIndex>(
    `/aletheia/matters/${matterId}/v1/source-index${suffix}`,
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

export type AletheiaExternalSourceCapture = {
  schemaVersion: "hermes-external-source-capture-v1";
  matterId: string;
  connector: "allowlisted_https_fetch";
  networkFetchDispatched: true;
  url: string;
  host: string;
  capturedAt: string;
  urlHash: string;
  snapshotHash: string;
  observation: string;
  contentType: string;
  responseBytes: number;
};

export async function fetchAletheiaExternalSource(
  matterId: string,
  payload: {
    url: string;
    externalAccessOptIn: true;
    approvalCheckpointId: string;
  },
): Promise<AletheiaExternalSourceCapture> {
  return apiRequest<AletheiaExternalSourceCapture>(
    `/aletheia/matters/${matterId}/external-source/fetch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    action: AletheiaApprovalAction;
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

export async function archiveAletheiaMatter(matterId: string) {
  return apiRequest<AletheiaMatterRecord>(
    `/aletheia/matters/${matterId}/archive`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function purgeAletheiaMatter(
  matterId: string,
  approvalCheckpointId: string,
) {
  return apiRequest<{
    schema_version: "aletheia-matter-purge-tombstone-v1";
    tombstoneHash: string;
  }>(`/aletheia/matters/${matterId}/purge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmMatterId: matterId, approvalCheckpointId }),
  });
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

export async function resolveAletheiaReview(
  matterId: string,
  reviewId: string,
  payload: {
    status: Exclude<AletheiaReviewResolutionStatus, "open">;
    comment?: string | null;
    createEvalCase?: boolean;
  },
): Promise<{
  review: AletheiaReviewRecord;
  auditEvent: AletheiaAuditEventRecord | null;
  evalCase: AletheiaReviewDerivedEvalCaseRecord | null;
}> {
  return apiRequest(
    `/aletheia/matters/${matterId}/reviews/${reviewId}/resolution`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function approveAletheiaShareholderPenetrationGraph(
  matterId: string,
  graphId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/shareholder-graphs/${graphId}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function approveAletheiaLegalQaAnswer(
  matterId: string,
  answerId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/legal-qa/${answerId}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function approveAletheiaWordAddinHandoff(
  matterId: string,
  handoffId: string,
): Promise<AletheiaWorkProductRecord> {
  return apiRequest<AletheiaWorkProductRecord>(
    `/aletheia/matters/${matterId}/word-addin/${handoffId}/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function approveAletheiaPreferenceLearningCandidate(
  matterId: string,
  memoryItemId: string,
): Promise<AletheiaPlaybookRecord> {
  return apiRequest<AletheiaPlaybookRecord>(
    `/aletheia/matters/${matterId}/preference-learning/${memoryItemId}/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function listAletheiaReviewDerivedEvalCases(
  matterId: string,
): Promise<{
  schema_version: "aletheia-review-derived-eval-local-v0";
  matter_id: string;
  eval_cases: AletheiaReviewDerivedEvalCaseRecord[];
  local_only: true;
}> {
  return apiRequest(`/aletheia/matters/${matterId}/eval-cases`);
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

export async function persistAletheiaGateSnapshot(
  matterId: string,
  payload: {
    action: "final_memo_export";
    approvalCheckpointId?: string | null;
    content: Record<string, unknown>;
  },
): Promise<AletheiaAuditEventRecord> {
  return apiRequest<AletheiaAuditEventRecord>(
    `/aletheia/matters/${matterId}/gate-snapshots`,
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

export type AletheiaDurableExecutorStatus = {
  enabled: boolean;
  starting?: boolean;
  error?: string | null;
  reason?: string;
  modelId?: string;
};

export type AletheiaDurableRun = {
  id: string;
  matter_id: string;
  workflow: string;
  goal: string;
  status:
    | "queued"
    | "running"
    | "cancel_requested"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out";
  attempt_count: number;
  deadline_at: string;
  error: string | null;
  metadata: Record<string, unknown>;
  steps: Array<{
    id: string;
    step_key: string;
    title: string;
    status: string;
    attempt_count: number;
    output: Record<string, unknown>;
    error: string | null;
  }>;
  events: Array<{
    id: string;
    sequence: number;
    event_type: string;
    event_hash: string;
    created_at: string;
  }>;
};

export type AletheiaDurableRunIntegrity = {
  ok: boolean;
  eventCount?: number;
  lastHash?: string | null;
  eventId?: string;
};

export async function getAletheiaDurableExecutorStatus(): Promise<AletheiaDurableExecutorStatus> {
  return apiRequest<AletheiaDurableExecutorStatus>(
    "/aletheia/durable-executor/status",
  );
}

export async function createAletheiaDurableRun(
  matterId: string,
  payload: {
    workflow: string;
    goal: string;
    prompt: string;
    systemPrompt?: string;
  },
) {
  return apiRequest<{ id: string }>(
    `/aletheia/matters/${matterId}/durable-runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow: payload.workflow,
        goal: payload.goal,
        steps: [
          {
            key: "local_model_analysis",
            title: "Generate local matter analysis",
            handler: "local_model.generate",
            input: {
              prompt: payload.prompt,
              systemPrompt: payload.systemPrompt,
            },
          },
        ],
      }),
    },
  );
}

export async function createLitigationDurableRun(
  matterId: string,
  payload: {
    focus?: string;
    retrievalManifestId?: string;
  } = {},
) {
  const body: { focus?: string; retrievalManifestId?: string } = {};
  if (payload.focus?.trim()) body.focus = payload.focus.trim();
  if (payload.retrievalManifestId?.trim()) {
    body.retrievalManifestId = payload.retrievalManifestId.trim();
  }
  return apiRequest<AletheiaDurableRun>(
    `/aletheia/matters/${matterId}/litigation-durable-runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function getLatestLitigationDurableRun(matterId: string) {
  return apiRequest<AletheiaDurableRun | null>(
    `/aletheia/matters/${matterId}/litigation-durable-runs/latest`,
  );
}

export async function createReviewedLitigationSynthesis(
  matterId: string,
  runId: string,
) {
  return apiRequest<AletheiaDurableRun>(
    `/aletheia/matters/${matterId}/litigation-durable-runs/${runId}/synthesis`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function requestLitigationAgentOutputReview(
  matterId: string,
  runId: string,
) {
  return apiRequest<LitigationAgentOutputReviewRecord>(
    `/aletheia/matters/${matterId}/litigation/agent-runs/${runId}/review`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function decideLitigationAgentOutputReview(
  matterId: string,
  reviewId: string,
  payload: { decision: "approved" | "rejected"; comment: string },
) {
  return apiRequest<LitigationAgentOutputReviewRecord>(
    `/aletheia/matters/${matterId}/litigation/agent-output-reviews/${reviewId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function reviewLitigationAgentFinding(
  matterId: string,
  runId: string,
  stepId: string,
  findingIndex: number,
  payload: {
    assessment: "supported" | "partial" | "unsupported";
    reason: string;
  },
) {
  return apiRequest<LitigationAgentFindingReviewRecord>(
    `/aletheia/matters/${matterId}/litigation/agent-runs/${runId}/steps/${stepId}/findings/${findingIndex}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function runLitigationAgentFindingSemanticCheck(
  matterId: string,
  runId: string,
  stepId: string,
  findingIndex: number,
) {
  return apiRequest<LitigationAgentFindingSemanticCheckRecord>(
    `/aletheia/matters/${matterId}/litigation/agent-runs/${runId}/steps/${stepId}/findings/${findingIndex}/semantic-check`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function getAletheiaDurableRun(runId: string) {
  return apiRequest<AletheiaDurableRun>(`/aletheia/durable-runs/${runId}`);
}

export async function cancelAletheiaDurableRun(runId: string) {
  return apiRequest<AletheiaDurableRun>(
    `/aletheia/durable-runs/${runId}/cancel`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function getAletheiaDurableRunIntegrity(runId: string) {
  return apiRequest<AletheiaDurableRunIntegrity>(
    `/aletheia/durable-runs/${runId}/integrity`,
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

export interface McpToolSummary {
  [key: string]: unknown;
}

export interface McpConnectorSummary {
  id: string;
  name: string;
  transport: "streamable_http";
  serverUrl: string;
  authType: "none" | "bearer" | "headers" | "oauth" | "mixed";
  enabled: boolean;
  auth: {
    hasBearerToken?: boolean;
    bearerMasked?: string | null;
    headerNames?: string[];
    oauthConnected?: boolean;
    oauthMasked?: string | null;
  };
  status: "disabled" | "idle" | "ready" | "error";
  lastError: string | null;
  lastRefreshedAt: string | null;
  tools: McpToolSummary[];
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listMcpConnectors(): Promise<McpConnectorSummary[]> {
  const response = await apiRequest<{
    connectors: McpConnectorSummary[];
  }>("/aletheia/mcp-connectors");
  return response.connectors;
}

export async function getMcpConnector(
  connectorId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/aletheia/mcp-connectors/${connectorId}`,
  );
}

export async function createMcpConnector(payload: {
  name: string;
  serverUrl: string;
  enabled?: boolean;
  auth?: {
    bearerToken?: string;
    headers?: Record<string, string>;
    oauth?: {
      accessToken: string;
      refreshToken?: string;
      clientSecret?: string;
    };
  };
}): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>("/aletheia/mcp-connectors", {
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
    auth?: {
      bearerToken?: string;
      headers?: Record<string, string>;
      oauth?: {
        accessToken: string;
        refreshToken?: string;
        clientSecret?: string;
      };
    };
  },
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/aletheia/mcp-connectors/${connectorId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteMcpConnector(connectorId: string): Promise<void> {
  return apiRequest<void>(`/aletheia/mcp-connectors/${connectorId}`, {
    method: "DELETE",
  });
}

export async function refreshMcpConnectorTools(
  connectorId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/aletheia/mcp-connectors/${connectorId}/refresh-tools`,
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
  const apiBase = await getAletheiaApiBase();
  const form = new FormData();
  form.append("file", file);
  if (filename) form.append("filename", filename);
  const response = await fetch(
    `${apiBase}/single-documents/${documentId}/versions`,
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
  const apiBase = await getAletheiaApiBase();
  const form = new FormData();
  form.append("file", file);
  if (filename) form.append("filename", filename);
  const response = await fetch(
    `${apiBase}/single-documents/${documentId}/versions/${versionId}/file`,
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
  const apiBase = await getAletheiaApiBase();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${apiBase}/projects/${projectId}/documents`, {
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
  const apiBase = await getAletheiaApiBase();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${apiBase}/single-documents`, {
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
  const apiBase = await getAletheiaApiBase();
  const response = await fetch(`${apiBase}/single-documents/download-zip`, {
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
  const apiBase = await getAletheiaApiBase();
  return fetch(`${apiBase}/chat`, {
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
  const apiBase = await getAletheiaApiBase();
  return fetch(`${apiBase}/projects/${projectId}/chat`, {
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
  const apiBase = await getAletheiaApiBase();
  return fetch(`${apiBase}/tabular-review/${reviewId}/generate`, {
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
  const apiBase = await getAletheiaApiBase();
  return fetch(`${apiBase}/tabular-review/${reviewId}/chat`, {
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
