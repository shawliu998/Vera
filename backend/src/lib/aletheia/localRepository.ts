import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { searchSafeFtsQuery } from "../searchSafeFtsQuery";
import { LocalDatabase } from "./localDatabase";
import { DurableAgentQueue } from "./durableAgentExecutor";
import {
  initializeLitigationSchema,
  LitigationValidationError,
  LocalLitigationStore,
} from "./litigationStore";
import {
  buildLitigationArtifactDocx,
  renderLitigationArtifactPlainText,
} from "./litigationDocxExport";
import { buildLegalOpinionDocx } from "./legalOpinionDocxExport";
import { buildLegalResearchMemoDocx } from "./legalResearchMemoDocxExport";
import {
  DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
  DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
  resolveLitigationDocumentTemplate,
} from "./litigationDocumentTemplates";
import {
  chunkMatterDocument,
  documentTypeForFilename,
  extractMatterDocument,
  nativeOcrConfigured,
  readMatterDocumentFile,
  sensitiveMaterialFlagsForText,
  writeMatterDocumentFile,
} from "./documentParser";
import {
  GATE_AUDIT_ACTIONS,
  auditActionForWorkProduct,
  buildGateSnapshotAuditDetails,
  buildAgentRunTraceScaffold,
  buildAgentWorkflowGraph,
  buildDeterministicDraftMemoContent,
  buildInitialAgentPlan,
  deriveClaimSuggestionFromText,
  normalizedFactFromQuote,
  professionalDraftProfileForTemplate,
  buildSourceLinkedIssueMapContent,
  buildSourceLinkedEvidenceMatrixContent,
} from "./domain";
import {
  ApprovalRequiredError,
  CapabilityNotAvailableError,
  DocumentParseRetryError,
  LitigationArtifactDownloadIntegrityError,
  MatterOriginalDocumentAuditError,
  MatterOriginalDocumentIntegrityError,
  SourceOriginalVerificationHistoryAuditError,
} from "./repository";
import {
  GovernancePolicyError,
  governanceForDatabase,
  type MatterPermission,
} from "./localGovernance";
import { LocalControlRepository } from "./localControlRepository";
import {
  modelCalibrationAcceptance,
  localModelCalibrationFingerprint,
} from "./localModelCalibration";
import { modelBenchmarkAcceptance } from "./localModelBenchmark";
import { localModelScheduler } from "./localModelRuntime";
import type { LocalModelScheduler } from "./localModelScheduler";
import {
  LOCAL_FINDING_ENTAILMENT_PROTOCOL,
  runFindingEntailmentCheck,
  type FindingCitation,
} from "./localFindingEntailment";
import {
  applicationEncryptionMode,
  assertBundledDatabaseEncryptionPolicy,
  decryptLocalBuffer,
  isAletheiaEnvelope,
  readProtectedLocalFileSync,
  writeProtectedLocalFileSync,
} from "./localEnvelopeCrypto";
import {
  inspectLitigationDocxTemplate,
  renderLitigationDocxTemplate,
} from "./litigationDocxTemplate";
import {
  buildBoundDocumentDraftDocx,
  DOCUMENT_DRAFT_ROUND_TRIP_PROTOCOL,
  DocumentDraftRoundTripError,
  parseBoundDocumentDraftDocx,
} from "./litigationDocumentRoundTrip";
import {
  calculateCourtCalendarBusinessDays,
  COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION,
} from "./courtCalendarCalculation";
import {
  LEGAL_ISSUE_TREE_SCHEMA,
  validateLegalIssueTree,
} from "./legalIssues";
import {
  createV1RuntimePersistencePlan,
  type V1RuntimePersistenceInput,
} from "./v1RuntimePersistence";
import type {
  AddMatterMemoryInput,
  AddReviewInput,
  AgentRunBudget,
  AletheiaRepository,
  AletheiaUserContext,
  AppendAuditEventInput,
  ApproveSkillCandidateInput,
  CreateDurableEvalExportInput,
  CreateLitigationMatterAuditExportInput,
  CreateLegalOpinionInput,
  CreateLocalExportPackageInput,
  CreateAgentRunInput,
  CreateEvidenceItemInput,
  GlobalSearchInput,
  GlobalSearchKind,
  GlobalSearchResponse,
  GlobalSearchResult,
  CreateMatterInput,
  CreatePlaybookInput,
  ProposePlaybookImprovementInput,
  CreateWorkProductInput,
  DecideApprovalInput,
  LitigationArtifactExportApprovalProjection,
  LitigationArtifactDownload,
  LegalResearchMemoDownload,
  LegalOpinionDownload,
  MatterOriginalDocumentDownload,
  LitigationApprovalVoteBlockReason,
  ListV1SourceIndexInput,
  PersistGateSnapshotInput,
  ResumeAgentRunInput,
  ResolveReviewInput,
  ReviewResolutionStatus,
  RequestApprovalInput,
  SearchMatterDocumentsInput,
  SignLitigationMatterAuditExportInput,
  TaskCalendarEntry,
  UploadMatterDocumentInput,
} from "./repository";
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

type JsonObject = Record<string, unknown>;
type RetrievalMode = "keyword" | "hybrid" | "semantic";
type RetrievalScoreDirection = "lower_is_better" | "higher_is_better";
type LocalDocumentParseStatus = "parsed" | "failed" | "needs_ocr";
type LocalSemanticChunk = {
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
  terms: Record<string, number>;
  norm: number;
};

let singletonDb: LocalDatabase | null = null;

function now() {
  return new Date().toISOString();
}

function dataDir() {
  return (
    process.env.ALETHEIA_DATA_DIR ??
    process.env.ALET_HEIA_DATA_DIR ??
    path.resolve(process.cwd(), ".data", "aletheia")
  );
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function exportHash(value: unknown) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

const LITIGATION_AUDIT_PACKAGE_SCHEMA =
  "vera-litigation-matter-audit-package-v1";
const LITIGATION_AUDIT_CHECKLIST_SCHEMA =
  "vera-litigation-counsel-signoff-checklist-v1";
const LITIGATION_AUDIT_ATTESTATION_VERSION =
  "vera-counsel-audit-attestation-v1";
const LITIGATION_AUDIT_ATTESTATION =
  "I reviewed this exact Vera litigation audit package and its server-generated readiness checklist. I understand this application record is not a qualified electronic signature or proof of independent review.";

const LITIGATION_AUDIT_JSON_COLUMNS = new Set([
  "calculation",
  "calculation_trace",
  "citation_assessments",
  "content",
  "dependency_snapshot",
  "provenance",
  "sections",
  "source_snapshot",
  "validation_errors",
  "weekly_non_working_days",
]);

function litigationAuditProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(litigationAuditProjection);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !["metadata", "storage_path", "export_path", "lease_token"].includes(
            key,
          ),
      )
      .map(([key, item]) => {
        if (
          LITIGATION_AUDIT_JSON_COLUMNS.has(key) &&
          typeof item === "string"
        ) {
          try {
            return [key, litigationAuditProjection(JSON.parse(item))];
          } catch {
            return [key, item];
          }
        }
        return [key, litigationAuditProjection(item)];
      }),
  );
}

function auditHmacKey() {
  const configured = process.env.ALETHEIA_AUDIT_HMAC_SECRET?.trim();
  if (configured) return Buffer.from(configured, "utf8");
  const keyPath = path.join(dataDir(), ".audit-hmac-key");
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  }
  chmodSync(keyPath, 0o600);
  return readFileSync(keyPath);
}

function auditEventHash(value: unknown) {
  return `hmac-sha256:${createHmac("sha256", auditHmacKey())
    .update(stableJson(value))
    .digest("hex")}`;
}

function parseObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): unknown[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringArrayFromObject(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown, max = 400) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringArrayValue(value: unknown, max = 400) {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item, max)).filter(Boolean)
    : [];
}

function ensureLocalDirs(root: string) {
  for (const dir of [
    root,
    path.join(root, "documents"),
    path.join(root, "exports"),
    path.join(root, "index"),
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

function safeFilePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isPathInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

const PURGEABLE_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".txt",
  ".md",
]);
const UUID_FILE_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_CDR_FILE_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cdr$/i;

function lstatIfPresent(target: string) {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function removeTreeWithoutFollowingSymlinks(root: string, target: string) {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(target);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("refused path outside the configured purge root");
  }

  const rootStat = lstatIfPresent(lexicalRoot);
  if (rootStat?.isSymbolicLink()) {
    throw new Error("refused symbolic-link purge root");
  }
  const targetStat = lstatIfPresent(lexicalTarget);
  if (!targetStat) return;
  const canonicalRoot = realpathSync(lexicalRoot);
  const canonicalTarget = path.resolve(canonicalRoot, relative);

  const removeEntry = (entryPath: string) => {
    const stat = lstatIfPresent(entryPath);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error("refused symbolic link in purge target");
    }
    const canonicalEntry = realpathSync(entryPath);
    if (!isPathInside(canonicalRoot, canonicalEntry)) {
      throw new Error(
        "refused path whose real location escapes the purge root",
      );
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(entryPath)) {
        removeEntry(path.join(entryPath, name));
      }
      rmdirSync(entryPath);
      return;
    }
    unlinkSync(entryPath);
  };

  removeEntry(canonicalTarget);
}

function derivedDocumentStoragePath(args: {
  documentsRoot: string;
  documentId: string;
  filename: string;
}) {
  if (!UUID_FILE_PREFIX.test(args.documentId)) return null;
  const extension = path.extname(args.filename).toLowerCase();
  if (!PURGEABLE_DOCUMENT_EXTENSIONS.has(extension)) return null;
  return path.join(args.documentsRoot, `${args.documentId}${extension}`);
}

const ORIGINAL_DOCUMENT_MIME_TYPES: Record<string, ReadonlySet<string>> = {
  ".pdf": new Set(["application/pdf"]),
  ".docx": new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  ".xlsx": new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]),
  ".txt": new Set(["text/plain"]),
  ".md": new Set(["text/markdown", "text/plain"]),
};

function supportedOriginalDocumentMimeType(
  filename: string,
  mimeType: unknown,
) {
  const extension = path.extname(filename).toLowerCase();
  const normalizedMimeType =
    typeof mimeType === "string"
      ? mimeType.split(";", 1)[0].trim().toLowerCase()
      : "";
  return ORIGINAL_DOCUMENT_MIME_TYPES[extension]?.has(normalizedMimeType)
    ? normalizedMimeType
    : null;
}

export function redactPublicDocumentMetadata(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const redact = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(redact);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(
          ([key]) => key !== "storagePath" && key !== "derivedStoragePath",
        )
        .map(([key, nested]) => [key, redact(nested)]),
    );
  };
  return redact(value) as JsonObject;
}

export function redactPublicMatterDocument(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const document = value as Record<string, unknown>;
  return {
    ...document,
    metadata: redactPublicDocumentMetadata(document.metadata),
  };
}

function purgeRootForTarget(target: string, matterId: string) {
  const root = dataDir();
  const documentsRoot = path.join(root, "documents");
  const resolvedTarget = path.resolve(target);
  if (
    path.dirname(resolvedTarget) === path.resolve(documentsRoot) &&
    (UUID_FILE_PREFIX.test(path.basename(target, path.extname(target))) ||
      UUID_CDR_FILE_PREFIX.test(path.basename(target, path.extname(target)))) &&
    PURGEABLE_DOCUMENT_EXTENSIONS.has(path.extname(target).toLowerCase())
  ) {
    return documentsRoot;
  }

  const exportsRoot = path.join(root, "exports");
  if (
    resolvedTarget === path.resolve(exportsRoot, matterId) &&
    isPathInside(exportsRoot, resolvedTarget)
  ) {
    return exportsRoot;
  }

  const indexRoot = semanticIndexConfig().index_dir;
  const expectedIndexPath = path.join(
    indexRoot,
    `${safeFilePart(matterId) || matterId}.json`,
  );
  if (
    resolvedTarget === path.resolve(expectedIndexPath) &&
    isPathInside(indexRoot, resolvedTarget)
  ) {
    return indexRoot;
  }
  return null;
}

function removeValidatedPurgeTarget(target: string, matterId: string) {
  const root = purgeRootForTarget(target, matterId);
  if (!root) throw new Error("refused unrecognized purge target");
  removeTreeWithoutFollowingSymlinks(root, target);
}

function localExportPath(args: {
  root: string;
  matterId: string;
  exportId: string;
  kind: string;
  title: string;
  extension?: "json" | "docx" | "zip";
}) {
  const matterDir = path.join(args.root, "exports", args.matterId);
  if (!existsSync(matterDir)) {
    mkdirSync(matterDir, { recursive: true, mode: 0o700 });
  }
  chmodSync(matterDir, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const title = safeFilePart(args.title) || args.kind;
  return path.join(
    matterDir,
    `${timestamp}-${args.kind}-${title}-${args.exportId}.${args.extension ?? "json"}`,
  );
}

function shouldPersistLocalExport(kind: string) {
  return [
    "audit_pack",
    "feedback_export",
    "final_memo",
    "registry_snapshot",
    "external_source_workpaper",
    "shareholder_penetration_graph",
    "legal_qa_answer",
    "word_addin_handoff",
  ].includes(kind);
}

function configuredRetrievalMode(): RetrievalMode {
  const value = process.env.ALETHEIA_RETRIEVAL_MODE?.trim().toLowerCase();
  return value === "hybrid" || value === "semantic" ? value : "keyword";
}

function semanticIndexConfig() {
  const root = dataDir();
  return {
    enabled: process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED === "true",
    driver:
      process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER?.trim().toLowerCase() ||
      "disabled",
    index_dir:
      process.env.ALETHEIA_SEMANTIC_INDEX_DIR ||
      path.join(root, "index", "semantic-local"),
    embedding_model: "aletheia-deterministic-token-vector-v0",
  };
}

function searchMode(input: SearchMatterDocumentsInput): RetrievalMode {
  return input.mode ?? configuredRetrievalMode();
}

function assertLocalRetrievalModeAvailable(mode: RetrievalMode) {
  if (mode === "keyword") return;
  const semanticIndex = semanticIndexConfig();
  if (!semanticIndex.enabled || semanticIndex.driver === "disabled") {
    throw new CapabilityNotAvailableError(
      `${mode} retrieval is not enabled. Set ALETHEIA_SEMANTIC_INDEX_ENABLED=true and configure a vetted local index driver before requesting non-keyword retrieval.`,
    );
  }
  if (semanticIndex.driver === "local-json") return;
  throw new CapabilityNotAvailableError(
    `${mode} retrieval driver "${semanticIndex.driver}" is configured but no semantic index adapter is installed in this build. SQLite FTS5 keyword retrieval remains available.`,
  );
}

function retrievalScoreDirection(mode: RetrievalMode): RetrievalScoreDirection {
  return mode === "keyword" ? "lower_is_better" : "higher_is_better";
}

function retrievalExplanation(args: {
  mode: RetrievalMode;
  rank: number;
  score: number;
  layers: string[];
}) {
  const direction = retrievalScoreDirection(args.mode);
  const basis =
    args.mode === "keyword"
      ? "SQLite FTS5 BM25 keyword match"
      : args.mode === "semantic"
        ? "local deterministic token-vector similarity"
        : "merged SQLite FTS5 and local semantic scores";
  return {
    rank: args.rank,
    score: args.score,
    scoreDirection: direction,
    basis,
    layers: args.layers,
  };
}

function quotePreview(text: unknown) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function boundedSearchSnippet(value: unknown, query: string, max = 240) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) return normalized;
  const index = normalized
    .toLocaleLowerCase()
    .indexOf(query.toLocaleLowerCase());
  const start = index < 0 ? 0 : Math.max(0, index - Math.floor(max / 3));
  const end = Math.min(normalized.length, start + max - 6);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${
    end < normalized.length ? "..." : ""
  }`.slice(0, max);
}

function textMatchScore(value: unknown, query: string, base: number) {
  const normalized = String(value ?? "")
    .trim()
    .toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (normalized === needle) return base + 20;
  if (normalized.startsWith(needle)) return base + 10;
  return normalized.includes(needle) ? base : 0;
}

function containsLikePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

type RankedGlobalSearchResult = GlobalSearchResult & { relevance: number };

function parsedStatusForUpload(args: {
  filename: string;
  parsedText: string;
  extractionFailed: boolean;
}): LocalDocumentParseStatus {
  if (args.extractionFailed) return "failed";
  if (args.parsedText.trim()) return "parsed";
  return documentTypeForFilename(args.filename) === "pdf"
    ? "needs_ocr"
    : "failed";
}

function parseFailureSummary(status: LocalDocumentParseStatus) {
  if (status === "needs_ocr") {
    return "PDF uploaded but no text layer was detected; OCR is required before indexing.";
  }
  return "Document uploaded but text extraction failed.";
}

function localSemanticIndexPath(matterId: string) {
  const config = semanticIndexConfig();
  const dir = config.index_dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return path.join(dir, `${safeFilePart(matterId) || matterId}.json`);
}

function tokenizeForLocalSemanticIndex(text: string) {
  const stop = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "before",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "to",
    "with",
  ]);
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stop.has(token));
}

function localSemanticVector(text: string) {
  const terms: Record<string, number> = {};
  for (const token of tokenizeForLocalSemanticIndex(text)) {
    terms[token] = (terms[token] ?? 0) + 1;
  }
  const norm = Math.sqrt(
    Object.values(terms).reduce((sum, value) => sum + value * value, 0),
  );
  return { terms, norm };
}

function localSemanticScore(
  query: { terms: Record<string, number>; norm: number },
  chunk: LocalSemanticChunk,
) {
  if (!query.norm || !chunk.norm) return 0;
  let dot = 0;
  for (const [term, value] of Object.entries(query.terms)) {
    dot += value * (chunk.terms[term] ?? 0);
  }
  return dot / (query.norm * chunk.norm);
}

function numberOrDefault(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function defaultRunBudget(input?: AgentRunBudget) {
  return {
    maxSteps: numberOrDefault(input?.maxSteps, 7),
    maxToolCalls: numberOrDefault(input?.maxToolCalls, 12),
    maxTokens: numberOrNull(input?.maxTokens),
    maxCostUsd: numberOrNull(input?.maxCostUsd),
    maxWallTimeMs: numberOrDefault(input?.maxWallTimeMs, 600000),
  };
}

function workflowGraphWithResumeNode(
  metadata: JsonObject,
  args: {
    sequence: number;
    checkpointType: string;
    decision: string | null;
    revisedDraftMemoId: string | null;
  },
) {
  const graph =
    metadata.workflowGraph &&
    typeof metadata.workflowGraph === "object" &&
    !Array.isArray(metadata.workflowGraph)
      ? (metadata.workflowGraph as JsonObject)
      : null;
  if (!graph) return metadata;
  const nodes = Array.isArray(graph.nodes) ? [...graph.nodes] : [];
  const edges = Array.isArray(graph.edges) ? [...graph.edges] : [];
  const resumeNodeKey = `resume_after_human_checkpoint_${args.sequence}`;

  return {
    ...metadata,
    workflowGraph: {
      ...graph,
      nodes: [
        ...nodes,
        {
          key: resumeNodeKey,
          type: "agent_step",
          title: "Resume after human checkpoint",
          sequence: args.sequence,
          status: "completed",
          specialistRole: "Risk Reviewer",
          allowedTools: ["work_product_create"],
          checkpoint: args.checkpointType,
          workProductKind: "draft_memo",
          workProductId: args.revisedDraftMemoId,
        },
      ],
      edges: [
        ...edges,
        {
          from: "human_review",
          to: resumeNodeKey,
          condition: args.decision
            ? `human_${args.decision}_requires_revision`
            : "human_checkpoint_requires_revision",
        },
        {
          from: resumeNodeKey,
          to: "human_review",
          condition: "return_to_review",
        },
      ],
    },
  };
}

function ensureColumn(
  db: LocalDatabase,
  table: string,
  column: string,
  definition: string,
) {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
    name?: string;
  }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}

function backfillAuditChainOnce(db: LocalDatabase) {
  db.exec(`create table if not exists aletheia_schema_metadata (
    key text primary key,
    value text not null,
    updated_at text not null
  )`);
  const completed = db
    .prepare("select value from aletheia_schema_metadata where key = ?")
    .get("audit_chain_v1_backfilled") as { value?: string } | undefined;
  if (completed?.value === "true") return;
  const rows = db
    .prepare(
      `select id, matter_id, user_id, actor, action, workflow_version, model,
              details, created_at
         from aletheia_audit_events
        order by matter_id asc, created_at asc, id asc`,
    )
    .all() as Array<Record<string, any>>;
  db.exec("BEGIN IMMEDIATE");
  try {
    let currentMatter = "";
    let sequence = 0;
    let previousHash: string | null = null;
    for (const row of rows) {
      if (row.matter_id !== currentMatter) {
        currentMatter = String(row.matter_id);
        sequence = 0;
        previousHash = null;
      }
      sequence += 1;
      const details = parseObject(String(row.details ?? "{}"));
      const eventHash = auditEventHash({
        id: row.id,
        matterId: row.matter_id,
        userId: row.user_id,
        actor: row.actor,
        action: row.action,
        workflowVersion: row.workflow_version ?? "aletheia-v0",
        model: row.model,
        details,
        createdAt: row.created_at,
        sequence,
        previousHash,
      });
      db.prepare(
        "update aletheia_audit_events set sequence = ?, previous_hash = ?, event_hash = ? where id = ?",
      ).run(sequence, previousHash, eventHash, row.id);
      previousHash = eventHash;
    }
    db.prepare(
      `insert into aletheia_schema_metadata (key, value, updated_at)
       values (?, 'true', ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    ).run("audit_chain_v1_backfilled", now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function openDb() {
  if (singletonDb) return singletonDb;
  assertBundledDatabaseEncryptionPolicy();
  if (
    process.env.ALETHEIA_REQUIRE_ENCRYPTED_VOLUME === "true" &&
    process.env.ALETHEIA_ENCRYPTED_VOLUME_ATTESTED !== "true"
  ) {
    throw new Error(
      "Aletheia local storage requires an operator-attested encrypted volume.",
    );
  }
  const root = dataDir();
  ensureLocalDirs(root);
  singletonDb = new LocalDatabase(path.join(root, "aletheia.db"));
  chmodSync(path.join(root, "aletheia.db"), 0o600);
  singletonDb.exec("PRAGMA journal_mode = WAL");
  singletonDb.exec("PRAGMA foreign_keys = ON");
  singletonDb.exec(localSchema);
  initializeLitigationSchema(singletonDb);
  ensureColumn(
    singletonDb,
    "aletheia_agent_runs",
    "budget",
    "text not null default '{}'",
  );
  ensureColumn(
    singletonDb,
    "aletheia_agent_steps",
    "metrics",
    "text not null default '{}'",
  );
  ensureColumn(
    singletonDb,
    "aletheia_tool_calls",
    "metrics",
    "text not null default '{}'",
  );
  ensureColumn(
    singletonDb,
    "aletheia_review_items",
    "resolution_status",
    "text not null default 'open'",
  );
  ensureColumn(
    singletonDb,
    "aletheia_review_items",
    "resolution_comment",
    "text",
  );
  ensureColumn(singletonDb, "aletheia_review_items", "resolved_by", "text");
  ensureColumn(singletonDb, "aletheia_review_items", "resolved_at", "text");
  ensureColumn(singletonDb, "aletheia_audit_events", "sequence", "integer");
  ensureColumn(singletonDb, "aletheia_audit_events", "previous_hash", "text");
  ensureColumn(singletonDb, "aletheia_audit_events", "event_hash", "text");
  ensureColumn(
    singletonDb,
    "aletheia_work_products",
    "version",
    "integer not null default 1",
  );
  ensureColumn(
    singletonDb,
    "aletheia_work_products",
    "parent_work_product_id",
    "text",
  );
  ensureColumn(singletonDb, "aletheia_work_products", "content_hash", "text");
  ensureColumn(
    singletonDb,
    "aletheia_work_products",
    "dependency_hash",
    "text",
  );
  ensureColumn(singletonDb, "aletheia_work_products", "stale_at", "text");
  ensureColumn(singletonDb, "aletheia_work_products", "stale_reason", "text");
  ensureColumn(
    singletonDb,
    "aletheia_litigation_deadlines",
    "calculation_hash",
    "text",
  );
  ensureColumn(
    singletonDb,
    "aletheia_litigation_deadlines",
    "stale_at",
    "text",
  );
  ensureColumn(
    singletonDb,
    "aletheia_litigation_deadlines",
    "stale_reason",
    "text",
  );
  ensureColumn(singletonDb, "aletheia_tasks", "invalidated_at", "text");
  ensureColumn(singletonDb, "aletheia_tasks", "invalidated_reason", "text");
  ensureColumn(
    singletonDb,
    "aletheia_litigation_audit_export_signoffs",
    "audit_event_id",
    "text",
  );
  ensureColumn(
    singletonDb,
    "aletheia_litigation_audit_export_signoffs",
    "audit_event_sequence",
    "integer",
  );
  ensureColumn(
    singletonDb,
    "aletheia_litigation_audit_export_signoffs",
    "audit_event_hash",
    "text",
  );
  singletonDb.exec(
    "create unique index if not exists idx_local_audit_matter_sequence on aletheia_audit_events(matter_id, sequence) where sequence is not null",
  );
  backfillAuditChainOnce(singletonDb);
  return singletonDb;
}

/** Test-only lifecycle hook used by durable local persistence audits. */
export function closeLocalAletheiaRepositoryForAudit() {
  singletonDb?.close();
  singletonDb = null;
}

const localSchema = `
create table if not exists aletheia_matters (
  id text primary key,
  user_id text not null,
  title text not null,
  template text not null,
  status text not null,
  client_or_project text,
  objective text not null,
  risk_level text,
  source_project_id text,
  shared_with text not null default '[]',
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_local_matters_user_updated
  on aletheia_matters(user_id, updated_at desc);

create table if not exists aletheia_matter_documents (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  document_id text,
  name text not null,
  document_type text not null default 'other',
  parsed_status text not null default 'pending',
  summary text,
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists aletheia_document_chunks (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  document_id text not null references aletheia_matter_documents(id) on delete cascade,
  user_id text not null,
  chunk_index integer not null,
  page integer,
  section text,
  text text not null,
  quote_start integer not null default 0,
  quote_end integer not null default 0,
  metadata text not null default '{}',
  created_at text not null
);

create unique index if not exists idx_local_document_chunks_document_index
  on aletheia_document_chunks(document_id, chunk_index);

create virtual table if not exists aletheia_document_chunks_fts using fts5(
  chunk_id unindexed,
  matter_id unindexed,
  document_id unindexed,
  document_name unindexed,
  text
);

create table if not exists aletheia_work_products (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  kind text not null,
  title text not null,
  status text not null,
  schema_version text not null,
  content text not null default '{}',
  validation_errors text not null default '[]',
  generated_by text not null,
  model text,
  version integer not null default 1,
  parent_work_product_id text,
  content_hash text,
  dependency_hash text,
  stale_at text,
  stale_reason text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_local_work_products_matter_kind
  on aletheia_work_products(matter_id, kind);

create table if not exists aletheia_evidence_items (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  work_product_id text,
  document_id text,
  source_chunk_id text,
  claim_id text,
  document_name text,
  page integer,
  section text,
  quote text not null,
  quote_start integer,
  quote_end integer,
  relevance text not null default 'direct',
  support_status text not null default 'insufficient',
  confidence text,
  metadata text not null default '{}',
  created_at text not null
);

create table if not exists aletheia_review_items (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  work_product_id text,
  evidence_item_id text,
  target_type text not null,
  target_id text not null,
  tag text not null,
  comment text not null,
  reviewer_user_id text,
  reviewer_name text,
  resolution_status text not null default 'open',
  resolution_comment text,
  resolved_by text,
  resolved_at text,
  created_at text not null
);

create table if not exists aletheia_eval_cases (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  source_review_item_id text not null references aletheia_review_items(id) on delete cascade,
  source_audit_event_id text,
  failure_type text not null,
  status text not null default 'open',
  input_snapshot text not null default '{}',
  expected_behavior text not null,
  expert_feedback text not null,
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists idx_local_eval_cases_source_review
  on aletheia_eval_cases(source_review_item_id);

create table if not exists aletheia_exports (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  export_type text not null,
  schema_version text not null,
  export_hash text not null,
  export_path text not null,
  approval_checkpoint_id text,
  gate_authorization_status text not null,
  source_index_manifest text not null default '{}',
  audit_event_id text,
  metadata text not null default '{}',
  created_at text not null
);

create index if not exists idx_local_exports_matter_created
  on aletheia_exports(matter_id, created_at desc);

create table if not exists aletheia_litigation_audit_export_signoffs (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  export_id text not null references aletheia_exports(id) on delete restrict,
  actor_id text not null,
  export_hash text not null,
  checklist_schema_version text not null,
  checklist_hash text not null,
  matter_state_hash text not null,
  signer_name text not null,
  professional_identifier text,
  attestation_version text not null,
  attestation text not null,
  comment text not null,
  independent_review integer not null default 0 check(independent_review in (0, 1)),
  signed_at text not null,
  signoff_hash text not null,
  audit_event_id text,
  audit_event_sequence integer,
  audit_event_hash text,
  unique(export_id, actor_id, checklist_hash)
);

create index if not exists idx_litigation_audit_export_signoffs_scope
  on aletheia_litigation_audit_export_signoffs(matter_id, user_id, export_id, signed_at desc);

create trigger if not exists aletheia_litigation_audit_export_signoffs_immutable_update
  before update on aletheia_litigation_audit_export_signoffs begin
    select raise(abort, 'litigation audit export signoffs are immutable');
  end;

create trigger if not exists aletheia_litigation_audit_export_signoffs_immutable_delete
  before delete on aletheia_litigation_audit_export_signoffs begin
    select raise(abort, 'litigation audit export signoffs are immutable');
  end;

create table if not exists aletheia_audit_events (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text,
  actor text not null,
  action text not null,
  workflow_version text,
  model text,
  details text not null default '{}',
  sequence integer,
  previous_hash text,
  event_hash text,
  created_at text not null
);

create table if not exists aletheia_deletion_tombstones (
  id text primary key,
  matter_id text not null,
  user_id text not null,
  matter_title_hash text not null,
  last_audit_hash text,
  approval_checkpoint_id text not null,
  details text not null default '{}',
  tombstone_hash text not null,
  deleted_at text not null
);

create table if not exists aletheia_agent_runs (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  workflow text not null,
  goal text not null,
  status text not null default 'queued',
  current_step_key text,
  model_profile text,
  storage_driver text not null default 'local',
  budget text not null default '{}',
  metadata text not null default '{}',
  started_at text,
  completed_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists aletheia_local_model_calibrations (
  id text primary key,
  user_id text not null,
  model_id text not null,
  model_fingerprint text not null,
  adapter text not null,
  provider_model text not null,
  status text not null check(status in ('passed', 'failed')),
  protocol_version text not null,
  tested_at text not null,
  expires_at text not null,
  duration_ms integer not null,
  output_sha256 text,
  failure_code text,
  failure_detail text
);

create index if not exists aletheia_local_model_calibrations_latest
  on aletheia_local_model_calibrations(user_id, model_id, tested_at desc);

create table if not exists aletheia_litigation_agent_finding_reviews (
  id text primary key,
  run_id text not null references aletheia_agent_runs(id) on delete cascade,
  step_id text not null,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  finding_index integer not null,
  finding_hash text not null,
  assessment text not null check (assessment in ('supported', 'partial', 'unsupported')),
  reason text not null,
  version integer not null,
  supersedes_id text references aletheia_litigation_agent_finding_reviews(id),
  reviewed_by text not null,
  created_at text not null,
  unique(run_id, step_id, finding_index, version)
);

create index if not exists idx_agent_finding_reviews_run
  on aletheia_litigation_agent_finding_reviews(run_id, step_id, finding_index, version desc);

create table if not exists aletheia_litigation_custom_templates (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  name text not null,
  version integer not null,
  status text not null check(status in ('draft', 'approved', 'retired')),
  storage_path text not null,
  file_sha256 text not null,
  file_bytes integer not null,
  placeholders text not null default '[]',
  approval_checkpoint_id text,
  approved_by text,
  independent_approval integer not null default 0 check(independent_approval in (0, 1)),
  approved_at text,
  retirement_checkpoint_id text,
  retired_by text,
  retired_at text,
  created_by text not null,
  created_at text not null,
  updated_at text not null,
  unique(matter_id, name, version)
);

create index if not exists idx_litigation_custom_templates_matter
  on aletheia_litigation_custom_templates(matter_id, user_id, status, created_at);

create table if not exists aletheia_agent_steps (
  id text primary key,
  run_id text not null references aletheia_agent_runs(id) on delete cascade,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  step_key text not null,
  title text not null,
  sequence integer not null default 0,
  status text not null default 'pending',
  input text not null default '{}',
  output text not null default '{}',
  validation_errors text not null default '[]',
  metrics text not null default '{}',
  started_at text,
  completed_at text,
  created_at text not null
);

create table if not exists aletheia_tool_calls (
  id text primary key,
  run_id text not null references aletheia_agent_runs(id) on delete cascade,
  step_id text,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  tool_name text not null,
  risk_level text not null default 'medium',
  status text not null default 'pending',
  input text not null default '{}',
  output text not null default '{}',
  error text,
  metrics text not null default '{}',
  started_at text,
  completed_at text,
  created_at text not null
);

create table if not exists aletheia_human_checkpoints (
  id text primary key,
  run_id text not null references aletheia_agent_runs(id) on delete cascade,
  step_id text,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  checkpoint_type text not null,
  status text not null default 'open',
  prompt text not null,
  decision text,
  requested_payload text not null default '{}',
  decision_payload text not null default '{}',
  decided_by text,
  decided_at text,
  created_at text not null
);

create table if not exists aletheia_matter_memory_items (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  category text not null,
  title text not null,
  body text not null,
  source text not null default 'human',
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists aletheia_playbooks (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  name text not null,
  description text,
  version text not null default 'v0.1',
  status text not null default 'draft',
  content text not null default '{}',
  approved_by text,
  approved_at text,
  created_at text not null,
  updated_at text not null
);
`;

export class LocalAletheiaRepository implements AletheiaRepository {
  private readonly db = openDb();
  private readonly litigation = new LocalLitigationStore(this.db);
  private readonly findingEntailmentScheduler: Pick<
    LocalModelScheduler,
    "generate" | "snapshot"
  >;

  constructor(
    args: {
      findingEntailmentScheduler?: Pick<
        LocalModelScheduler,
        "generate" | "snapshot"
      >;
    } = {},
  ) {
    this.findingEntailmentScheduler =
      args.findingEntailmentScheduler ?? localModelScheduler();
  }

  private litigationAccess(
    ctx: AletheiaUserContext,
    matterId: string,
    permission: MatterPermission,
  ) {
    const matter = this.db
      .prepare("select id, user_id from aletheia_matters where id = ?")
      .get(matterId) as { id: string; user_id: string } | undefined;
    if (!matter) return null;
    if (matter.user_id !== ctx.userId) {
      governanceForDatabase(this.db).assertPermission(
        ctx.userId,
        matterId,
        permission,
      );
    }
    return {
      ownerCtx: { ...ctx, userId: matter.user_id },
      actorId: ctx.userId,
      independent:
        matter.user_id !== ctx.userId &&
        governanceForDatabase(this.db).multiPrincipalEnabled,
    };
  }

  private matterDocumentWriteAccess(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    governanceForDatabase(this.db).assertDocumentWriteAllowed(
      access.actorId,
      matterId,
    );
    return access;
  }

  async preflightMatterDocumentWrite(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    return this.matterDocumentWriteAccess(ctx, matterId) !== null;
  }

  async listMatters(ctx: AletheiaUserContext): Promise<unknown[]> {
    const governance = governanceForDatabase(this.db);
    const rows = this.db
      .prepare(
        `
        select
          m.*,
          (select count(*) from aletheia_matter_documents d where d.matter_id = m.id) as document_count,
          (select count(*) from aletheia_evidence_items e where e.matter_id = m.id) as evidence_count,
          (select count(*) from aletheia_review_items r where r.matter_id = m.id) as review_count,
          (select count(*) from aletheia_audit_events a where a.matter_id = m.id) as audit_event_count,
          (select max(created_at) from aletheia_audit_events a where a.matter_id = m.id) as latest_audit_at
        from aletheia_matters m
        where (? = 1 or m.user_id = ?)
        order by m.updated_at desc
      `,
      )
      .all(governance.multiPrincipalEnabled ? 1 : 0, ctx.userId)
      .filter(
        (row) =>
          row.user_id === ctx.userId ||
          (governance.multiPrincipalEnabled &&
            governance.hasPermission(
              ctx.userId,
              String(row.id),
              "matter.read",
            )),
      );
    return rows.map((row) => ({
      ...this.matter(row),
      document_count: Number(row.document_count ?? 0),
      evidence_count: Number(row.evidence_count ?? 0),
      review_count: Number(row.review_count ?? 0),
      audit_event_count: Number(row.audit_event_count ?? 0),
      latest_audit_at: row.latest_audit_at ?? null,
    }));
  }

  async searchGlobal(
    ctx: AletheiaUserContext,
    input: GlobalSearchInput,
  ): Promise<GlobalSearchResponse> {
    const query = input.query.trim();
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const likeQuery = containsLikePattern(query);
    const byEntity = new Map<string, RankedGlobalSearchResult>();
    const matterHref = (matterId: string) =>
      `/aletheia/matters/${encodeURIComponent(matterId)}`;
    const litigationHref = (
      matterId: string,
      view: "overview" | "facts" | "positions" | "procedure" | "artifacts",
      focus?: string,
    ) =>
      `${matterHref(matterId)}/litigation?view=${view}${
        focus ? `&focus=${encodeURIComponent(focus)}` : ""
      }`;
    const workProductView = (kind: string) => {
      if (kind === "evidence_catalog") return "facts" as const;
      if (kind === "claim_defense_matrix") return "positions" as const;
      if (kind === "procedural_clock") return "procedure" as const;
      if (
        kind === "litigation_brief" ||
        kind === "hearing_plan" ||
        kind === "hearing_bundle_index"
      ) {
        return "artifacts" as const;
      }
      return "overview" as const;
    };
    const add = (result: RankedGlobalSearchResult) => {
      const key = `${result.kind}:${result.id}`;
      const existing = byEntity.get(key);
      if (!existing || result.relevance > existing.relevance) {
        byEntity.set(key, result);
      }
    };

    const matterRows = this.db
      .prepare(
        `select id, title, client_or_project, objective, status, updated_at
           from aletheia_matters
          where user_id = ?
            and template = 'civil_litigation'
            and (lower(title) like lower(?) escape '\\'
              or lower(coalesce(client_or_project, '')) like lower(?) escape '\\'
              or lower(objective) like lower(?) escape '\\')`,
      )
      .all(ctx.userId, likeQuery, likeQuery, likeQuery) as Array<
      Record<string, any>
    >;
    for (const row of matterRows) {
      const relevance = Math.max(
        textMatchScore(row.title, query, 100),
        textMatchScore(row.client_or_project, query, 80),
        textMatchScore(row.objective, query, 65),
      );
      const snippetSource =
        textMatchScore(row.client_or_project, query, 1) > 0
          ? row.client_or_project
          : row.objective;
      add({
        kind: "matter",
        id: String(row.id),
        matterId: String(row.id),
        matterTitle: String(row.title),
        title: String(row.title),
        snippet: boundedSearchSnippet(snippetSource, query),
        status: String(row.status),
        updatedAt: String(row.updated_at),
        href: litigationHref(String(row.id), "overview"),
        relevance,
      });
    }

    const documentRows = this.db
      .prepare(
        `select d.id, d.matter_id, d.name, d.summary, d.parsed_status,
                d.updated_at, m.title as matter_title
           from aletheia_matter_documents d
           join aletheia_matters m
             on m.id = d.matter_id
            and m.user_id = d.user_id
            and m.template = 'civil_litigation'
          where d.user_id = ?
            and lower(d.name) like lower(?) escape '\\'`,
      )
      .all(ctx.userId, likeQuery) as Array<Record<string, any>>;
    for (const row of documentRows) {
      add({
        kind: "document",
        id: String(row.id),
        matterId: String(row.matter_id),
        matterTitle: String(row.matter_title),
        title: String(row.name),
        snippet: boundedSearchSnippet(row.summary, query),
        status: String(row.parsed_status),
        updatedAt: String(row.updated_at),
        href: litigationHref(
          String(row.matter_id),
          "facts",
          `document:${String(row.id)}`,
        ),
        relevance: textMatchScore(row.name, query, 95),
      });
    }

    const factRows = this.db
      .prepare(
        `select f.id, f.matter_id, f.statement, f.occurred_at, f.status,
                f.updated_at, m.title as matter_title
           from aletheia_litigation_facts f
           join aletheia_matters m
             on m.id = f.matter_id
            and m.user_id = f.user_id
            and m.template = 'civil_litigation'
          where f.user_id = ?
            and lower(f.statement) like lower(?) escape '\\'`,
      )
      .all(ctx.userId, likeQuery) as Array<Record<string, any>>;
    for (const row of factRows) {
      add({
        kind: "fact",
        id: String(row.id),
        matterId: String(row.matter_id),
        matterTitle: String(row.matter_title),
        title: String(row.statement),
        snippet: boundedSearchSnippet(row.occurred_at, query),
        status: String(row.status),
        updatedAt: String(row.updated_at),
        href: litigationHref(
          String(row.matter_id),
          "facts",
          `fact:${String(row.id)}`,
        ),
        relevance: textMatchScore(row.statement, query, 92),
      });
    }

    const positionRows = this.db
      .prepare(
        `select c.id, c.matter_id, c.title, c.legal_basis, c.uncertainty,
                c.kind, c.status, c.updated_at, m.title as matter_title
           from aletheia_litigation_claims c
           join aletheia_matters m
             on m.id = c.matter_id
            and m.user_id = c.user_id
            and m.template = 'civil_litigation'
          where c.user_id = ?
            and (lower(c.title) like lower(?) escape '\\'
              or lower(coalesce(c.legal_basis, '')) like lower(?) escape '\\'
              or lower(coalesce(c.uncertainty, '')) like lower(?) escape '\\')`,
      )
      .all(ctx.userId, likeQuery, likeQuery, likeQuery) as Array<
      Record<string, any>
    >;
    for (const row of positionRows) {
      const snippetSource =
        textMatchScore(row.legal_basis, query, 1) > 0
          ? row.legal_basis
          : row.uncertainty;
      add({
        kind: "position",
        id: String(row.id),
        matterId: String(row.matter_id),
        matterTitle: String(row.matter_title),
        title: String(row.title),
        snippet: boundedSearchSnippet(snippetSource, query),
        status: String(row.status),
        updatedAt: String(row.updated_at),
        href: litigationHref(
          String(row.matter_id),
          "positions",
          `position:${String(row.id)}`,
        ),
        relevance: Math.max(
          textMatchScore(row.title, query, 94),
          textMatchScore(row.legal_basis, query, 78),
          textMatchScore(row.uncertainty, query, 68),
        ),
      });
    }

    const deadlineRows = this.db
      .prepare(
        `select d.id, d.matter_id, d.title, d.rule_label, d.calculation,
                d.due_at, d.status, d.updated_at, m.title as matter_title
           from aletheia_litigation_deadlines d
           join aletheia_matters m
             on m.id = d.matter_id
            and m.user_id = d.user_id
            and m.template = 'civil_litigation'
          where d.user_id = ?
            and (lower(d.title) like lower(?) escape '\\'
              or lower(d.rule_label) like lower(?) escape '\\'
              or lower(d.calculation) like lower(?) escape '\\')`,
      )
      .all(ctx.userId, likeQuery, likeQuery, likeQuery) as Array<
      Record<string, any>
    >;
    for (const row of deadlineRows) {
      const snippetSource =
        textMatchScore(row.rule_label, query, 1) > 0
          ? row.rule_label
          : row.calculation;
      add({
        kind: "deadline",
        id: String(row.id),
        matterId: String(row.matter_id),
        matterTitle: String(row.matter_title),
        title: String(row.title),
        snippet: boundedSearchSnippet(snippetSource, query),
        status: String(row.status),
        updatedAt: String(row.updated_at),
        href: litigationHref(
          String(row.matter_id),
          "procedure",
          `deadline:${String(row.id)}`,
        ),
        relevance: Math.max(
          textMatchScore(row.title, query, 93),
          textMatchScore(row.rule_label, query, 76),
          textMatchScore(row.calculation, query, 66),
        ),
      });
    }

    const ftsQuery = searchSafeFtsQuery(query);
    if (ftsQuery) {
      const chunkRows = this.db
        .prepare(
          `select c.document_id as id, c.matter_id, d.name, d.parsed_status,
                  d.updated_at, m.title as matter_title, c.text,
                  bm25(aletheia_document_chunks_fts) as fts_score
             from aletheia_document_chunks_fts f
             join aletheia_document_chunks c
               on c.id = f.chunk_id
              and c.matter_id = f.matter_id
              and c.document_id = f.document_id
             join aletheia_matter_documents d
               on d.id = c.document_id
              and d.matter_id = c.matter_id
              and d.user_id = c.user_id
             join aletheia_matters m
               on m.id = c.matter_id
              and m.user_id = c.user_id
              and m.template = 'civil_litigation'
            where aletheia_document_chunks_fts match ?
              and c.user_id = ?
            order by fts_score asc`,
        )
        .all(ftsQuery, ctx.userId) as Array<Record<string, any>>;
      chunkRows.forEach((row, index) => {
        add({
          kind: "document",
          id: String(row.id),
          matterId: String(row.matter_id),
          matterTitle: String(row.matter_title),
          title: String(row.name),
          snippet: boundedSearchSnippet(row.text, query),
          status: String(row.parsed_status),
          updatedAt: String(row.updated_at),
          href: litigationHref(
            String(row.matter_id),
            "facts",
            `document:${String(row.id)}`,
          ),
          relevance: Math.max(70, 82 - index),
        });
      });
    }

    const taskRows = this.db
      .prepare(
        `select t.id, t.matter_id, t.title, t.status, t.updated_at,
                m.title as matter_title
           from aletheia_tasks t
           join aletheia_matters m
             on m.id = t.matter_id
            and m.user_id = t.user_id
            and m.template = 'civil_litigation'
          where t.user_id = ?
            and lower(t.title) like lower(?) escape '\\'`,
      )
      .all(ctx.userId, likeQuery) as Array<Record<string, any>>;
    for (const row of taskRows) {
      add({
        kind: "task",
        id: String(row.id),
        matterId: String(row.matter_id),
        matterTitle: String(row.matter_title),
        title: String(row.title),
        snippet: "",
        status: String(row.status),
        updatedAt: String(row.updated_at),
        href: litigationHref(
          String(row.matter_id),
          "procedure",
          `task:${String(row.id)}`,
        ),
        relevance: textMatchScore(row.title, query, 90),
      });
    }

    const workProductRows = this.db
      .prepare(
        `select w.id, w.matter_id, w.title, w.kind, w.status, w.updated_at,
                m.title as matter_title
           from aletheia_work_products w
           join aletheia_matters m
             on m.id = w.matter_id
            and m.user_id = w.user_id
            and m.template = 'civil_litigation'
          where w.user_id = ?
            and lower(w.title) like lower(?) escape '\\'`,
      )
      .all(ctx.userId, likeQuery) as Array<Record<string, any>>;
    for (const row of workProductRows) {
      add({
        kind: "work_product",
        id: String(row.id),
        matterId: String(row.matter_id),
        matterTitle: String(row.matter_title),
        title: String(row.title),
        snippet: boundedSearchSnippet(row.kind, query),
        status: String(row.status),
        updatedAt: String(row.updated_at),
        href: litigationHref(
          String(row.matter_id),
          workProductView(String(row.kind)),
          workProductView(String(row.kind)) === "overview"
            ? undefined
            : `artifact:${String(row.id)}`,
        ),
        relevance: textMatchScore(row.title, query, 90),
      });
    }

    const kindOrder: Record<GlobalSearchKind, number> = {
      matter: 0,
      document: 1,
      fact: 2,
      position: 3,
      deadline: 4,
      task: 5,
      work_product: 6,
    };
    const ranked = [...byEntity.values()].sort(
      (left, right) =>
        right.relevance - left.relevance ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        kindOrder[left.kind] - kindOrder[right.kind] ||
        left.title.localeCompare(right.title),
    );
    return {
      query,
      total: ranked.length,
      results: ranked
        .slice(0, limit)
        .map(({ relevance: _relevance, ...result }) => result),
    };
  }

  async createMatter(ctx: AletheiaUserContext, input: CreateMatterInput) {
    const timestamp = now();
    const matter = {
      id: randomUUID(),
      user_id: ctx.userId,
      title: input.title,
      template: input.template,
      status: input.status,
      client_or_project: input.clientOrProject,
      objective: input.objective,
      risk_level: input.riskLevel,
      source_project_id: input.sourceProjectId,
      shared_with: input.sharedWith,
      metadata: input.metadata,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `
        insert into aletheia_matters (
          id, user_id, title, template, status, client_or_project, objective,
          risk_level, source_project_id, shared_with, metadata, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          matter.id,
          matter.user_id,
          matter.title,
          matter.template,
          matter.status,
          matter.client_or_project,
          matter.objective,
          matter.risk_level,
          matter.source_project_id,
          json(matter.shared_with),
          json(matter.metadata),
          matter.created_at,
          matter.updated_at,
        );

      this.writeAuditEvent(ctx.userId, matter.id, {
        actor: "human",
        action: "matter_created",
        workflowVersion: "aletheia-v0",
        model: null,
        details: { template: input.template, status: input.status },
      });
      this.createInitialAgentPlan(ctx.userId, {
        matterId: matter.id,
        template: input.template,
        objective: input.objective,
        riskLevel: input.riskLevel,
      });
      this.db.exec("COMMIT");
      return matter;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getMatterDetail(ctx: AletheiaUserContext, matterId: string) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    return {
      matter,
      documents: this.all("aletheia_matter_documents", matterId).map((row) =>
        redactPublicMatterDocument(this.document(row)),
      ),
      workProducts: this.all("aletheia_work_products", matterId).map((row) =>
        this.workProduct(row),
      ),
      evidence: this.all("aletheia_evidence_items", matterId).map((row) =>
        this.evidence(row),
      ),
      reviews: this.all(
        "aletheia_review_items",
        matterId,
        "created_at desc",
      ).map((row) => this.review(row)),
      evalCases: this.all(
        "aletheia_eval_cases",
        matterId,
        "created_at desc",
      ).map((row) => this.evalCase(row)),
      auditEvents: this.all(
        "aletheia_audit_events",
        matterId,
        "created_at desc",
      ).map((row) => {
        const event = this.auditEvent(row);
        return {
          ...event,
          details: redactPublicDocumentMetadata(event.details),
        };
      }),
      agentRuns: this.all(
        "aletheia_agent_runs",
        matterId,
        "created_at desc",
      ).map((row) => this.agentRunWithTrace(row)),
      matterMemory: this.all(
        "aletheia_matter_memory_items",
        matterId,
        "created_at desc",
      ).map((row) => this.matterMemory(row)),
      playbooks: this.all(
        "aletheia_playbooks",
        matterId,
        "created_at desc",
      ).map((row) => this.playbook(row)),
    };
  }

  async listV1SourceIndex(
    ctx: AletheiaUserContext,
    matterId: string,
    input: ListV1SourceIndexInput = {},
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const includeChunks = input.includeChunks ?? true;
    const includeEvidenceLinks = input.includeEvidenceLinks ?? true;
    const chunkLimit = Math.min(Math.max(input.chunkLimit ?? 500, 0), 2000);
    const documentIds = (input.documentIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean);
    const documentFilter = documentIds.length
      ? ` and id in (${documentIds.map(() => "?").join(",")})`
      : "";
    const documentRows = this.db
      .prepare(
        `
        select * from aletheia_matter_documents
        where matter_id = ?
          and user_id = ?
          ${documentFilter}
        order by created_at asc
      `,
      )
      .all(matterId, ctx.userId, ...documentIds) as any[];
    const selectedDocumentIds = new Set(
      documentRows.map((row) => String(row.id)),
    );
    const documents = documentRows.map((row) => this.v1DocumentRecord(row));

    const chunks =
      includeChunks && chunkLimit > 0 && selectedDocumentIds.size
        ? this.v1DocumentChunks({
            matterId,
            userId: ctx.userId,
            documentIds: [...selectedDocumentIds],
            limit: chunkLimit,
          })
        : [];

    const sourceLinks =
      includeEvidenceLinks && selectedDocumentIds.size
        ? this.v1SourceLinks({
            matterId,
            userId: ctx.userId,
            documentIds: [...selectedDocumentIds],
          })
        : [];

    return {
      schema_version: "aletheia-v1-source-index-local-v0",
      storage_driver: "local",
      matter_id: matterId,
      generated_at: now(),
      documents,
      chunks,
      source_links: sourceLinks,
      limitations: [
        "Local source index lists parsed document records, chunks, and evidence source links; full document/page preview remains a separate UI concern.",
      ],
    };
  }

  private matterAuditChainProjection(_userId: string, matterId: string) {
    const rows = this.db
      .prepare(
        `select * from aletheia_audit_events
          where matter_id = ?
          order by sequence asc`,
      )
      .all(matterId) as Array<Record<string, any>>;
    let previousHash: string | null = null;
    let valid = true;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sequence = index + 1;
      const expected = auditEventHash({
        id: row.id,
        matterId: row.matter_id,
        userId: row.user_id,
        actor: row.actor,
        action: row.action,
        workflowVersion: row.workflow_version,
        model: row.model,
        details: parseObject(row.details),
        createdAt: row.created_at,
        sequence,
        previousHash,
      });
      if (
        Number(row.sequence) !== sequence ||
        row.previous_hash !== previousHash ||
        row.event_hash !== expected
      ) {
        valid = false;
      }
      previousHash = String(row.event_hash ?? "") || null;
    }
    return {
      valid,
      event_count: rows.length,
      head_sequence: rows.length ? Number(rows.at(-1)?.sequence ?? 0) : 0,
      head_hash: previousHash,
    };
  }

  private litigationAuditRows(
    table: string,
    ownerId: string,
    matterId: string,
    order = "created_at asc",
  ) {
    return litigationAuditProjection(
      this.db
        .prepare(
          `select * from ${table}
            where matter_id = ? and user_id = ?
            order by ${order}`,
        )
        .all(matterId, ownerId),
    ) as Array<Record<string, any>>;
  }

  private buildLitigationMatterAuditState(
    ownerCtx: AletheiaUserContext,
    matterId: string,
  ) {
    const matter = this.loadOwnedMatter(ownerCtx, matterId);
    if (!matter) return null;
    if (matter.template !== "civil_litigation") {
      throw new LitigationValidationError(
        "A litigation matter audit package requires a civil litigation matter.",
      );
    }
    const workspace = this.litigation.getWorkspace(
      ownerCtx,
      matterId,
    ) as Record<string, any> | null;
    if (!workspace) return null;
    const workspaceKeys = [
      "profile",
      "facts",
      "fact_sources",
      "claims",
      "claim_sources",
      "position_reviews",
      "legal_assessments",
      "agent_output_reviews",
      "agent_finding_reviews",
      "agent_finding_semantic_checks",
      "legal_authority_versions",
      "position_authorities",
      "position_authority_statuses",
      "elements",
      "element_facts",
      "element_evidence_statuses",
      "procedural_events",
      "procedural_event_corrections",
      "deadlines",
    ];
    const litigation = Object.fromEntries(
      workspaceKeys.map((key) => [
        key,
        litigationAuditProjection(
          workspace[key] ?? (key === "profile" ? null : []),
        ),
      ]),
    );
    const documentRows = this.db
      .prepare(
        `select id, name, document_type, parsed_status, summary, metadata,
                created_at, updated_at
           from aletheia_matter_documents
          where matter_id = ? and user_id = ? order by created_at asc`,
      )
      .all(matterId, ownerCtx.userId) as Array<Record<string, any>>;
    const chunkRows = this.db
      .prepare(
        `select id, document_id, page, section, text, quote_start, quote_end
           from aletheia_document_chunks
          where matter_id = ? and user_id = ? order by document_id asc, quote_start asc, id asc`,
      )
      .all(matterId, ownerCtx.userId) as Array<Record<string, any>>;
    const sourceManifest = {
      documents: documentRows.map((row) => {
        const metadata = parseObject(row.metadata);
        const contentDisarm =
          metadata.contentDisarm &&
          typeof metadata.contentDisarm === "object" &&
          !Array.isArray(metadata.contentDisarm)
            ? (metadata.contentDisarm as Record<string, unknown>)
            : {};
        return {
          id: row.id,
          name: row.name,
          document_type: row.document_type,
          parsed_status: row.parsed_status,
          summary: row.summary ?? null,
          content_sha256:
            typeof contentDisarm.derivedSha256 === "string"
              ? contentDisarm.derivedSha256
              : typeof metadata.originalSha256 === "string"
                ? metadata.originalSha256
                : null,
          original_file_sha256:
            typeof metadata.originalSha256 === "string"
              ? metadata.originalSha256
              : null,
          mime_type:
            typeof metadata.mimeType === "string" ? metadata.mimeType : null,
          file_bytes:
            typeof metadata.sizeBytes === "number" ? metadata.sizeBytes : null,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
      }),
      chunks: chunkRows.map((row) => ({
        id: row.id,
        document_id: row.document_id,
        page: row.page ?? null,
        section: row.section ?? null,
        quote_start: row.quote_start ?? null,
        quote_end: row.quote_end ?? null,
        text_snapshot_hash: exportHash(String(row.text ?? "")),
      })),
    };
    const artifactKinds: LitigationArtifactKind[] = [
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ];
    const artifactRows = this.db
      .prepare(
        `select id, kind, title, status, version, parent_work_product_id,
                  content, content_hash, dependency_hash,
                  validation_errors, stale_at, stale_reason, created_at, updated_at
             from aletheia_work_products
            where matter_id = ? and user_id = ?
              and kind in (${artifactKinds.map(() => "?").join(",")})
            order by kind asc, version asc`,
      )
      .all(matterId, ownerCtx.userId, ...artifactKinds) as Array<
      Record<string, any>
    >;
    const artifacts = artifactRows.map((row) => ({
      ...(litigationAuditProjection(row) as Record<string, any>),
      content_integrity_valid:
        exportHash(parseObject(row.content)) === row.content_hash,
    }));
    const reviewItems = litigationAuditProjection(
      this.db
        .prepare(
          `select id, work_product_id, evidence_item_id, target_type, target_id,
                  tag, comment, reviewer_user_id, reviewer_name,
                  resolution_status, resolution_comment, resolved_by, resolved_at,
                  created_at
             from aletheia_review_items
            where matter_id = ? order by created_at asc`,
        )
        .all(matterId),
    );
    const evalResults = litigationAuditProjection(
      this.db
        .prepare(
          `select r.* from aletheia_litigation_eval_results r
             join aletheia_litigation_eval_runs e
               on e.id = r.run_id and e.matter_id = r.matter_id
            where r.matter_id = ? and e.user_id = ? order by r.created_at asc`,
        )
        .all(matterId, ownerCtx.userId),
    );
    const snapshot = {
      schema_version: "vera-litigation-matter-state-snapshot-v1",
      matter: {
        id: matter.id,
        title: matter.title,
        status: matter.status,
        client_or_project: matter.client_or_project,
        objective: matter.objective,
        risk_level: matter.risk_level,
        created_at: matter.created_at,
      },
      source_manifest: sourceManifest,
      litigation,
      court_calendars: this.litigationAuditRows(
        "aletheia_litigation_court_calendars",
        ownerCtx.userId,
        matterId,
      ),
      court_calendar_versions: this.litigationAuditRows(
        "aletheia_litigation_court_calendar_versions",
        ownerCtx.userId,
        matterId,
      ),
      court_calendar_day_overrides: this.litigationAuditRows(
        "aletheia_litigation_court_calendar_day_overrides",
        ownerCtx.userId,
        matterId,
      ),
      deadline_rules: this.litigationAuditRows(
        "aletheia_litigation_deadline_rules",
        ownerCtx.userId,
        matterId,
      ),
      tasks: this.litigationAuditRows(
        "aletheia_tasks",
        ownerCtx.userId,
        matterId,
        "due_at asc, created_at asc",
      ),
      notification_deliveries: this.litigationAuditRows(
        "aletheia_task_notification_deliveries",
        ownerCtx.userId,
        matterId,
        "claimed_at asc",
      ),
      retrieval_manifests: this.litigationAuditRows(
        "aletheia_litigation_retrieval_manifests",
        ownerCtx.userId,
        matterId,
      ),
      retrieval_excerpts: this.litigationAuditRows(
        "aletheia_litigation_retrieval_excerpts",
        ownerCtx.userId,
        matterId,
        "confirmed_at asc",
      ),
      document_drafts: this.litigationAuditRows(
        "aletheia_litigation_document_drafts",
        ownerCtx.userId,
        matterId,
      ),
      document_draft_versions: this.litigationAuditRows(
        "aletheia_litigation_document_draft_versions",
        ownerCtx.userId,
        matterId,
        "document_id asc, version asc",
      ),
      document_draft_import_attempts: this.litigationAuditRows(
        "aletheia_litigation_document_draft_import_attempts",
        ownerCtx.userId,
        matterId,
      ),
      custom_templates: this.litigationAuditRows(
        "aletheia_litigation_custom_templates",
        ownerCtx.userId,
        matterId,
      ),
      artifacts,
      review_items: reviewItems,
      eval_runs: this.litigationAuditRows(
        "aletheia_litigation_eval_runs",
        ownerCtx.userId,
        matterId,
      ),
      eval_results: evalResults,
    };
    return { snapshot, matterStateHash: exportHash(snapshot) };
  }

  private buildLitigationAuditChecklist(
    ownerCtx: AletheiaUserContext,
    matterId: string,
    snapshot: Record<string, any>,
  ) {
    const litigation = snapshot.litigation as Record<string, any[]>;
    const confirmedFacts = (litigation.facts ?? []).filter(
      (item) => item.status === "confirmed",
    );
    const confirmedClaims = (litigation.claims ?? []).filter(
      (item) => item.status === "confirmed",
    );
    const factSourceIds = new Set(
      (litigation.fact_sources ?? []).map((item) => String(item.fact_id)),
    );
    const claimSourceIds = new Set(
      (litigation.claim_sources ?? []).map((item) => String(item.claim_id)),
    );
    const authorityStatuses = new Map(
      (litigation.position_authority_statuses ?? []).map((item) => [
        String(item.claim_id),
        String(item.status),
      ]),
    );
    const confirmedEvents = (litigation.procedural_events ?? []).filter(
      (item) => item.status === "confirmed" && !item.superseded_by_event_id,
    );
    const confirmedDeadlines = (litigation.deadlines ?? []).filter(
      (item) => item.status === "confirmed",
    );
    const openReviews = [
      ...(litigation.position_reviews ?? []).filter(
        (item) => item.status === "open",
      ),
      ...(litigation.agent_output_reviews ?? []).filter(
        (item) => item.status === "open",
      ),
      ...(snapshot.review_items ?? []).filter(
        (item: Record<string, any>) => item.resolution_status === "open",
      ),
    ];
    const latestArtifacts = new Map<string, Record<string, any>>();
    for (const artifact of snapshot.artifacts ?? []) {
      const previous = latestArtifacts.get(String(artifact.kind));
      if (!previous || Number(previous.version) < Number(artifact.version)) {
        latestArtifacts.set(String(artifact.kind), artifact);
      }
    }
    const requiredKinds: LitigationArtifactKind[] = [
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
    ];
    const artifactFailures: string[] = [];
    for (const kind of requiredKinds) {
      const artifact = latestArtifacts.get(kind);
      if (!artifact) {
        artifactFailures.push(`${kind}:missing`);
        continue;
      }
      const errors = Array.isArray(artifact.validation_errors)
        ? artifact.validation_errors
        : [];
      let currentDependencyHash: string | null = null;
      try {
        currentDependencyHash =
          this.litigation.buildArtifact(ownerCtx, matterId, kind)
            ?.dependencyHash ?? null;
      } catch {
        currentDependencyHash = null;
      }
      if (
        artifact.stale_at ||
        errors.length > 0 ||
        artifact.content_integrity_valid !== true ||
        !currentDependencyHash ||
        currentDependencyHash !== artifact.dependency_hash
      ) {
        artifactFailures.push(`${kind}:stale_or_invalid`);
      }
    }
    const draftVersions = new Map<string, Record<string, any>>(
      (snapshot.document_draft_versions ?? []).map(
        (item: Record<string, any>) => [String(item.id), item],
      ),
    );
    const activeDrafts = (snapshot.document_drafts ?? []).filter(
      (item: Record<string, any>) => item.status === "active",
    );
    const unapprovedDrafts = activeDrafts.filter(
      (draft: Record<string, any>) => {
        const version = draftVersions.get(String(draft.current_version_id));
        return !version || version.review_status !== "approved";
      },
    );
    const auditChain = this.matterAuditChainProjection(
      ownerCtx.userId,
      matterId,
    );
    const items = [
      {
        id: "confirmed_facts_have_exact_sources",
        status:
          confirmedFacts.length > 0 &&
          confirmedFacts.every((item) => factSourceIds.has(String(item.id)))
            ? "satisfied"
            : "action_required",
        summary: `${confirmedFacts.length} confirmed facts; ${confirmedFacts.filter((item) => factSourceIds.has(String(item.id))).length} source-bound.`,
      },
      {
        id: "confirmed_positions_have_sources_and_authority",
        status:
          confirmedClaims.length > 0 &&
          confirmedClaims.every(
            (item) =>
              claimSourceIds.has(String(item.id)) &&
              authorityStatuses.get(String(item.id)) === "satisfied",
          )
            ? "satisfied"
            : "action_required",
        summary: `${confirmedClaims.length} confirmed positions; ${confirmedClaims.filter((item) => authorityStatuses.get(String(item.id)) === "satisfied").length} authority-ready.`,
      },
      {
        id: "human_reviews_resolved",
        status: openReviews.length === 0 ? "satisfied" : "action_required",
        summary: `${openReviews.length} open review records.`,
      },
      {
        id: "procedural_events_source_bound",
        status:
          confirmedEvents.length === 0
            ? "not_applicable"
            : confirmedEvents.every((item) => item.primary_source_span_id)
              ? "satisfied"
              : "action_required",
        summary: `${confirmedEvents.length} current confirmed procedural events.`,
      },
      {
        id: "confirmed_deadlines_current",
        status:
          confirmedDeadlines.length === 0
            ? "not_applicable"
            : confirmedDeadlines.every((item) => !item.stale_at)
              ? "satisfied"
              : "action_required",
        summary: `${confirmedDeadlines.length} confirmed deadlines; ${confirmedDeadlines.filter((item) => item.stale_at).length} stale.`,
      },
      {
        id: "required_artifacts_current",
        status: artifactFailures.length === 0 ? "satisfied" : "action_required",
        summary:
          artifactFailures.length === 0
            ? "All five required litigation artifacts are current and validation-clean."
            : artifactFailures.join(", "),
      },
      {
        id: "active_document_drafts_reviewed",
        status:
          activeDrafts.length === 0
            ? "not_applicable"
            : unapprovedDrafts.length === 0
              ? "satisfied"
              : "action_required",
        summary: `${activeDrafts.length} active drafts; ${unapprovedDrafts.length} lack approval on the current version.`,
      },
      {
        id: "matter_audit_chain_valid",
        status: auditChain.valid ? "satisfied" : "action_required",
        summary: auditChain.valid
          ? "Matter audit-chain integrity verified."
          : "Matter audit-chain integrity verification failed.",
      },
    ];
    const checklist = {
      schema_version: LITIGATION_AUDIT_CHECKLIST_SCHEMA,
      overall_status: items.every((item) =>
        ["satisfied", "not_applicable"].includes(item.status),
      )
        ? "ready"
        : "action_required",
      items,
      assurance_limit:
        "This checklist is a server-derived readiness record. Counsel sign-off is an application attestation, not a qualified electronic signature or proof of independent review.",
    };
    return { checklist, checklistHash: exportHash(checklist) };
  }

  async getLitigationMatterAuditExportPreview(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.export");
    if (!access) return null;
    const state = this.buildLitigationMatterAuditState(
      access.ownerCtx,
      matterId,
    );
    if (!state) return null;
    const checklist = this.buildLitigationAuditChecklist(
      access.ownerCtx,
      matterId,
      state.snapshot,
    );
    return {
      schema_version: LITIGATION_AUDIT_PACKAGE_SCHEMA,
      matter_id: matterId,
      matter_state_hash: state.matterStateHash,
      checklist: checklist.checklist,
      checklist_hash: checklist.checklistHash,
      attestation_version: LITIGATION_AUDIT_ATTESTATION_VERSION,
      attestation: LITIGATION_AUDIT_ATTESTATION,
    };
  }

  async createLitigationMatterAuditExport(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationMatterAuditExportInput,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.export");
    if (!access) return null;
    governanceForDatabase(this.db).assertExportAllowed(
      access.actorId,
      matterId,
      input.governanceApprovalRequestId,
    );
    const state = this.buildLitigationMatterAuditState(
      access.ownerCtx,
      matterId,
    );
    if (!state) return null;
    const { checklist, checklistHash } = this.buildLitigationAuditChecklist(
      access.ownerCtx,
      matterId,
      state.snapshot,
    );
    const approved = this.loadApprovedApprovalCheckpoint(
      access.ownerCtx,
      matterId,
      input.approvalCheckpointId,
      "litigation_matter_audit_export",
    );
    const requested = approved?.requested_payload ?? {};
    if (
      !approved ||
      requested.matterId !== matterId ||
      requested.matterStateHash !== state.matterStateHash ||
      requested.checklistHash !== checklistHash ||
      requested.checklistSchemaVersion !== LITIGATION_AUDIT_CHECKLIST_SCHEMA
    ) {
      throw new ApprovalRequiredError(
        "Litigation matter audit export requires an approved checkpoint bound to the current matter state and checklist hashes.",
      );
    }
    const exportedAt = now();
    const exportId = randomUUID();
    const sectionHashes = Object.fromEntries(
      Object.entries(state.snapshot).map(([key, value]) => [
        key,
        exportHash(value),
      ]),
    );
    const packageWithoutHash = {
      schema_version: LITIGATION_AUDIT_PACKAGE_SCHEMA,
      local_only: true,
      matter_id: matterId,
      exported_at: exportedAt,
      exported_by: access.actorId,
      gate_authorization: {
        status: "approved",
        action: "litigation_matter_audit_export",
        approval_checkpoint_id: approved.id,
        decided_by: approved.decided_by,
        decided_at: approved.decided_at,
      },
      matter_state_hash: state.matterStateHash,
      section_hashes: sectionHashes,
      checklist,
      checklist_hash: checklistHash,
      audit_chain_head_before_export: this.matterAuditChainProjection(
        access.ownerCtx.userId,
        matterId,
      ),
      snapshot: state.snapshot,
      assurance_limit:
        "This package preserves local matter records and hashes for professional review. It is not a court filing, a qualified electronic signature, or proof that a source is authentic or admissible.",
    };
    const packageHash = exportHash(packageWithoutHash);
    const payload = {
      ...packageWithoutHash,
      export_id: exportId,
      export_hash: packageHash,
    };
    const exportPath = localExportPath({
      root: dataDir(),
      matterId,
      exportId,
      kind: "litigation_matter_audit",
      title: String(state.snapshot.matter?.title ?? "litigation-matter"),
    });
    writeProtectedLocalFileSync({
      filePath: exportPath,
      plaintext: JSON.stringify(payload, null, 2),
      purpose: "local_export",
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lockedState = this.buildLitigationMatterAuditState(
        access.ownerCtx,
        matterId,
      );
      if (!lockedState) {
        throw new LitigationValidationError(
          "Litigation matter audit state became unavailable before persistence.",
        );
      }
      const lockedChecklist = this.buildLitigationAuditChecklist(
        access.ownerCtx,
        matterId,
        lockedState.snapshot,
      );
      if (
        lockedState.matterStateHash !== state.matterStateHash ||
        lockedChecklist.checklistHash !== checklistHash
      ) {
        throw new LitigationValidationError(
          "Litigation matter state changed before the approved audit package could be persisted.",
        );
      }
      this.insertExportRecord({
        id: exportId,
        matterId,
        userId: access.ownerCtx.userId,
        exportType: "litigation_matter_audit_package",
        schemaVersion: LITIGATION_AUDIT_PACKAGE_SCHEMA,
        exportHash: packageHash,
        exportPath,
        approvalCheckpointId: approved.id,
        gateAuthorizationStatus: "approved",
        sourceIndexManifest: {
          matter_state_hash: state.matterStateHash,
          checklist_hash: checklistHash,
          section_hashes: sectionHashes,
        },
        metadata: {
          exportedBy: access.actorId,
          matterStateHash: state.matterStateHash,
          checklistHash,
          checklistStatus: checklist.overall_status,
        },
        createdAt: exportedAt,
      });
      const auditEvent = this.writeAuditEvent(
        access.ownerCtx.userId,
        matterId,
        {
          actor: "human",
          action: "litigation_matter_audit_package_exported",
          workflowVersion: LITIGATION_AUDIT_PACKAGE_SCHEMA,
          model: null,
          details: {
            exportId,
            exportHash: packageHash,
            matterStateHash: state.matterStateHash,
            checklistHash,
            checklistStatus: checklist.overall_status,
            approvalCheckpointId: approved.id,
            actorId: access.actorId,
          },
        },
      );
      this.attachExportAuditEvent(exportId, String(auditEvent.id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      try {
        unlinkSync(exportPath);
      } catch {
        // The protected file may not have been materialized.
      }
      throw error;
    }
    return payload;
  }

  private readLitigationMatterAuditExport(
    ownerId: string,
    matterId: string,
    exportId: string,
  ) {
    const row = this.db
      .prepare(
        `select * from aletheia_exports
          where id = ? and matter_id = ? and user_id = ?
            and export_type = 'litigation_matter_audit_package'`,
      )
      .get(exportId, matterId, ownerId) as Record<string, any> | undefined;
    if (!row) return null;
    const exportRoot = path.resolve(dataDir(), "exports", matterId);
    const exportPath = path.resolve(String(row.export_path ?? ""));
    const rootStat = lstatIfPresent(exportRoot);
    const stat = lstatIfPresent(exportPath);
    if (
      !rootStat ||
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !stat ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !isPathInside(exportRoot, exportPath) ||
      path.dirname(exportPath) !== exportRoot ||
      path.dirname(realpathSync(exportPath)) !== realpathSync(exportRoot) ||
      path.extname(exportPath).toLowerCase() !== ".json"
    ) {
      throw new LitigationValidationError(
        "Litigation matter audit package storage integrity check failed.",
      );
    }
    let payload: Record<string, any>;
    try {
      const bytes = readProtectedLocalFileSync({
        filePath: exportPath,
        purpose: "local_export",
      });
      payload = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
    } catch {
      throw new LitigationValidationError(
        "Litigation matter audit package cannot be decrypted or parsed.",
      );
    }
    const {
      export_id: storedId,
      export_hash: storedHash,
      ...packageWithoutHash
    } = payload;
    if (
      storedId !== exportId ||
      storedHash !== row.export_hash ||
      exportHash(packageWithoutHash) !== row.export_hash ||
      payload.matter_id !== matterId ||
      payload.schema_version !== LITIGATION_AUDIT_PACKAGE_SCHEMA
    ) {
      throw new LitigationValidationError(
        "Litigation matter audit package hash verification failed.",
      );
    }
    const metadata = parseObject(row.metadata);
    if (
      metadata.matterStateHash !== payload.matter_state_hash ||
      metadata.checklistHash !== payload.checklist_hash
    ) {
      throw new LitigationValidationError(
        "Litigation matter audit package registry binding is invalid.",
      );
    }
    return { row, payload };
  }

  async getLitigationMatterAuditExport(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.export");
    if (!access) return null;
    return (
      this.readLitigationMatterAuditExport(
        access.ownerCtx.userId,
        matterId,
        exportId,
      )?.payload ?? null
    );
  }

  async listLitigationMatterAuditExports(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.export");
    if (!access) return null;
    const state = this.buildLitigationMatterAuditState(
      access.ownerCtx,
      matterId,
    );
    const currentStateHash = state?.matterStateHash ?? null;
    const rows = this.db
      .prepare(
        `select id from aletheia_exports
          where matter_id = ? and user_id = ?
            and export_type = 'litigation_matter_audit_package'
          order by created_at desc`,
      )
      .all(matterId, access.ownerCtx.userId) as Array<{ id: string }>;
    return rows.map(({ id }) => {
      const exported = this.readLitigationMatterAuditExport(
        access.ownerCtx.userId,
        matterId,
        id,
      );
      if (!exported) {
        throw new LitigationValidationError(
          "Litigation matter audit export registry is incomplete.",
        );
      }
      const signoffCount = Number(
        (
          this.db
            .prepare(
              `select count(*) as count
                 from aletheia_litigation_audit_export_signoffs
                where export_id = ? and matter_id = ? and user_id = ?`,
            )
            .get(id, matterId, access.ownerCtx.userId) as { count?: number }
        )?.count ?? 0,
      );
      return {
        export_id: id,
        export_hash: exported.payload.export_hash,
        matter_state_hash: exported.payload.matter_state_hash,
        checklist_hash: exported.payload.checklist_hash,
        checklist: exported.payload.checklist,
        exported_at: exported.payload.exported_at,
        exported_by: exported.payload.exported_by,
        approval_checkpoint_id:
          exported.payload.gate_authorization?.approval_checkpoint_id ?? null,
        stale: currentStateHash !== exported.payload.matter_state_hash,
        signoff_count: signoffCount,
      };
    });
  }

  async signLitigationMatterAuditExport(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
    input: SignLitigationMatterAuditExportInput,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.signoff");
    if (!access) return null;
    const signerName = input.signerName.trim();
    const professionalIdentifier = input.professionalIdentifier?.trim() || null;
    const comment = input.comment.trim();
    if (
      signerName.length < 2 ||
      signerName.length > 160 ||
      (professionalIdentifier && professionalIdentifier.length > 160) ||
      comment.length < 20 ||
      comment.length > 2000 ||
      input.attestation !== LITIGATION_AUDIT_ATTESTATION
    ) {
      throw new LitigationValidationError(
        "Counsel sign-off requires the exact attestation, signer name, and a review comment of at least 20 characters.",
      );
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const exported = this.readLitigationMatterAuditExport(
        access.ownerCtx.userId,
        matterId,
        exportId,
      );
      if (!exported) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const state = this.buildLitigationMatterAuditState(
        access.ownerCtx,
        matterId,
      );
      if (!state) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const { checklist, checklistHash } = this.buildLitigationAuditChecklist(
        access.ownerCtx,
        matterId,
        state.snapshot,
      );
      if (
        checklist.overall_status !== "ready" ||
        input.exportHash !== exported.payload.export_hash ||
        input.checklistHash !== exported.payload.checklist_hash ||
        input.matterStateHash !== exported.payload.matter_state_hash ||
        checklistHash !== exported.payload.checklist_hash ||
        state.matterStateHash !== exported.payload.matter_state_hash
      ) {
        throw new LitigationValidationError(
          "Counsel sign-off is blocked because the package is stale, its hashes differ, or the current checklist is not ready.",
        );
      }
      const metadata = parseObject(exported.row.metadata);
      const independentReview =
        access.independent && metadata.exportedBy !== access.actorId;
      const signedAt = now();
      const id = randomUUID();
      const signoffPayload = {
        id,
        matterId,
        ownerId: access.ownerCtx.userId,
        exportId,
        exportHash: input.exportHash,
        checklistSchemaVersion: LITIGATION_AUDIT_CHECKLIST_SCHEMA,
        checklistHash: input.checklistHash,
        matterStateHash: input.matterStateHash,
        actorId: access.actorId,
        signerName,
        professionalIdentifier,
        attestationVersion: LITIGATION_AUDIT_ATTESTATION_VERSION,
        attestation: input.attestation,
        comment,
        independentReview,
        signedAt,
      };
      const signoffHash = exportHash(signoffPayload);
      const auditEvent = this.writeAuditEvent(
        access.ownerCtx.userId,
        matterId,
        {
          actor: "human",
          action: "litigation_matter_audit_package_signed_off",
          workflowVersion: LITIGATION_AUDIT_ATTESTATION_VERSION,
          model: null,
          details: {
            signoffId: id,
            signoffHash,
            exportId,
            exportHash: input.exportHash,
            checklistHash: input.checklistHash,
            matterStateHash: input.matterStateHash,
            actorId: access.actorId,
            independentReview,
          },
        },
      ) as { id: string; sequence: number; event_hash: string };
      this.db
        .prepare(
          `insert into aletheia_litigation_audit_export_signoffs (
             id, matter_id, user_id, export_id, actor_id, export_hash,
             checklist_schema_version, checklist_hash, matter_state_hash,
             signer_name, professional_identifier, attestation_version,
             attestation, comment, independent_review, signed_at, signoff_hash,
             audit_event_id, audit_event_sequence, audit_event_hash
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          access.ownerCtx.userId,
          exportId,
          access.actorId,
          input.exportHash,
          LITIGATION_AUDIT_CHECKLIST_SCHEMA,
          input.checklistHash,
          input.matterStateHash,
          signerName,
          professionalIdentifier,
          LITIGATION_AUDIT_ATTESTATION_VERSION,
          input.attestation,
          comment,
          independentReview ? 1 : 0,
          signedAt,
          signoffHash,
          auditEvent.id,
          auditEvent.sequence,
          auditEvent.event_hash,
        );
      this.db.exec("COMMIT");
      return {
        ...signoffPayload,
        signoffHash,
        auditEventId: auditEvent.id,
        auditEventSequence: auditEvent.sequence,
        auditEventHash: auditEvent.event_hash,
        audit_binding_valid: true,
        stale: false,
        integrity_valid: true,
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may have been rolled back on an early not-found path.
      }
      throw error;
    }
  }

  async listLitigationMatterAuditExportSignoffs(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.read");
    if (!access) return null;
    if (access.actorId !== access.ownerCtx.userId) {
      governanceForDatabase(this.db).assertPermission(
        access.actorId,
        matterId,
        "audit.read",
      );
    }
    const exported = this.readLitigationMatterAuditExport(
      access.ownerCtx.userId,
      matterId,
      exportId,
    );
    if (!exported) return null;
    const state = this.buildLitigationMatterAuditState(
      access.ownerCtx,
      matterId,
    );
    const currentStateHash = state?.matterStateHash ?? null;
    const rows = this.db
      .prepare(
        `select * from aletheia_litigation_audit_export_signoffs
          where export_id = ? and matter_id = ? and user_id = ?
          order by signed_at asc`,
      )
      .all(exportId, matterId, access.ownerCtx.userId) as Array<
      Record<string, any>
    >;
    return rows.map((row) => {
      const signoffPayload = {
        id: row.id,
        matterId: row.matter_id,
        ownerId: row.user_id,
        exportId: row.export_id,
        exportHash: row.export_hash,
        checklistSchemaVersion: row.checklist_schema_version,
        checklistHash: row.checklist_hash,
        matterStateHash: row.matter_state_hash,
        actorId: row.actor_id,
        signerName: row.signer_name,
        professionalIdentifier: row.professional_identifier ?? null,
        attestationVersion: row.attestation_version,
        attestation: row.attestation,
        comment: row.comment,
        independentReview: Number(row.independent_review) === 1,
        signedAt: row.signed_at,
      };
      return {
        ...signoffPayload,
        signoffHash: row.signoff_hash,
        auditEventId: row.audit_event_id ?? null,
        auditEventSequence: row.audit_event_sequence ?? null,
        auditEventHash: row.audit_event_hash ?? null,
        audit_binding_valid: this.litigationAuditSignoffEventBindingValid(row),
        integrity_valid:
          exportHash(signoffPayload) === row.signoff_hash &&
          this.litigationAuditSignoffEventBindingValid(row),
        stale: currentStateHash !== row.matter_state_hash,
      };
    });
  }

  private litigationAuditSignoffEventBindingValid(row: Record<string, any>) {
    if (
      !row.audit_event_id ||
      !Number.isInteger(row.audit_event_sequence) ||
      !row.audit_event_hash
    ) {
      return false;
    }
    const event = this.db
      .prepare(
        `select id, matter_id, sequence, event_hash, action, details
           from aletheia_audit_events where id = ? and matter_id = ?`,
      )
      .get(row.audit_event_id, row.matter_id) as
      | Record<string, any>
      | undefined;
    if (!event) return false;
    const details = parseObject(event.details);
    return (
      event.action === "litigation_matter_audit_package_signed_off" &&
      event.sequence === row.audit_event_sequence &&
      event.event_hash === row.audit_event_hash &&
      details.signoffId === row.id &&
      details.signoffHash === row.signoff_hash &&
      details.exportId === row.export_id &&
      details.exportHash === row.export_hash &&
      details.checklistHash === row.checklist_hash &&
      details.matterStateHash === row.matter_state_hash
    );
  }

  private litigationMatterAuditSignoffAnchorTarget(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
    signoffId: string,
    administratorRequired: boolean,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.read");
    if (!access) return null;
    const governance = governanceForDatabase(this.db);
    if (administratorRequired) {
      governance.assertAdministrator(access.actorId);
    } else if (access.actorId !== access.ownerCtx.userId) {
      governance.assertPermission(access.actorId, matterId, "audit.read");
    }
    const row = this.db
      .prepare(
        `select * from aletheia_litigation_audit_export_signoffs
          where id = ? and export_id = ? and matter_id = ? and user_id = ?`,
      )
      .get(signoffId, exportId, matterId, access.ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    if (!row) return null;
    if (!this.litigationAuditSignoffEventBindingValid(row)) {
      throw new LitigationValidationError(
        "Counsel sign-off audit-event binding is missing or invalid.",
      );
    }
    const chain = this.matterAuditChainProjection(
      access.ownerCtx.userId,
      matterId,
    );
    if (!chain.valid) {
      throw new LitigationValidationError(
        "Matter audit-chain integrity verification failed.",
      );
    }
    return {
      matterId,
      exportId,
      signoffId,
      signoffHash: row.signoff_hash,
      auditEventId: row.audit_event_id,
      auditEventSequence: row.audit_event_sequence,
      auditEventHash: row.audit_event_hash,
      canAnchor: governance.hasPermission(
        access.actorId,
        matterId,
        "matter.anchor",
      ),
      exactCurrentMatterHead:
        chain.head_sequence === row.audit_event_sequence &&
        chain.head_hash === row.audit_event_hash,
    };
  }

  async getLitigationMatterAuditSignoffAnchorTarget(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
    signoffId: string,
  ) {
    return this.litigationMatterAuditSignoffAnchorTarget(
      ctx,
      matterId,
      exportId,
      signoffId,
      false,
    );
  }

  async authorizeLitigationMatterAuditSignoffAnchor(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
    signoffId: string,
  ) {
    return this.litigationMatterAuditSignoffAnchorTarget(
      ctx,
      matterId,
      exportId,
      signoffId,
      true,
    );
  }

  async createLocalExportPackage(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLocalExportPackageInput = {},
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    governanceForDatabase(this.db).assertExportAllowed(
      ctx.userId,
      matterId,
      input.governanceApprovalRequestId,
    );
    const approved = this.loadApprovedApprovalCheckpoint(
      ctx,
      matterId,
      input.approvalCheckpointId ?? null,
      "audit_pack_export",
    );
    if (!approved) {
      throw new ApprovalRequiredError(
        "Local audit/export package requires an approved audit_pack_export checkpoint.",
      );
    }

    const exportedAt = now();
    const detail = await this.getMatterDetail(ctx, matterId);
    const sourceIndex = await this.listV1SourceIndex(ctx, matterId, {
      includeChunks: input.includeChunks ?? true,
      includeEvidenceLinks: true,
      chunkLimit: input.chunkLimit ?? 1000,
    });
    if (!detail || !sourceIndex) return null;

    const sourceIndexManifest = this.sourceIndexManifest(sourceIndex);
    const packageWithoutHash = {
      schema_version: "aletheia-local-export-package-v1",
      local_only: true,
      storage_driver: "local",
      exported_at: exportedAt,
      matter_id: matterId,
      gate_authorization: {
        status: "approved",
        action: "audit_pack_export",
        approval_checkpoint_id: approved.id,
        decided_by: approved.decided_by,
        decided_at: approved.decided_at,
      },
      source_index_manifest: sourceIndexManifest,
      audit_pack: {
        schema_version: "aletheia-local-audit-pack-v1",
        matter: (detail as any).matter,
        documents: (detail as any).documents ?? [],
        work_products: (detail as any).workProducts ?? [],
        evidence: (detail as any).evidence ?? [],
        reviews: (detail as any).reviews ?? [],
        audit_events: (detail as any).auditEvents ?? [],
        agent_runs: (detail as any).agentRuns ?? [],
        eval_cases: (detail as any).evalCases ?? [],
      },
      limitations: [
        "Local V1 export package is durable on the local filesystem and SQLite metadata store.",
      ],
    };
    const hash = exportHash(packageWithoutHash);
    const exportId = randomUUID();
    const exportPath = localExportPath({
      root: dataDir(),
      matterId,
      exportId,
      kind: "audit_export_package",
      title: matter.title,
    });
    const payload = {
      ...packageWithoutHash,
      export_id: exportId,
      export_hash: hash,
    };
    writeProtectedLocalFileSync({
      filePath: exportPath,
      plaintext: JSON.stringify(payload, null, 2),
      purpose: "local_export",
    });

    this.insertExportRecord({
      id: exportId,
      matterId,
      userId: ctx.userId,
      exportType: "audit_export_package",
      schemaVersion: payload.schema_version,
      exportHash: hash,
      exportPath,
      approvalCheckpointId: approved.id,
      gateAuthorizationStatus: "approved",
      sourceIndexManifest,
      metadata: {
        local_only: true,
        document_count: sourceIndexManifest.counts.documents,
        evidence_link_count: sourceIndexManifest.counts.source_links,
      },
      createdAt: exportedAt,
    });

    const auditEvent = (await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: "local_export_package_created",
      workflowVersion: payload.schema_version,
      model: null,
      details: {
        exportId,
        exportType: "audit_export_package",
        exportPath,
        exportHash: hash,
        approvalCheckpointId: approved.id,
        gateAuthorizationStatus: "approved",
        sourceIndexManifest,
      },
    })) as { id?: string } | null;
    this.attachExportAuditEvent(exportId, auditEvent?.id ?? null);
    this.touchMatter(ctx.userId, matterId);

    return {
      ...payload,
      export_path: exportPath,
      audit_event_id: auditEvent?.id ?? null,
      metadata_persisted: true,
    };
  }

  async createDurableEvalExport(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateDurableEvalExportInput = {},
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    governanceForDatabase(this.db).assertExportAllowed(
      ctx.userId,
      matterId,
      input.governanceApprovalRequestId,
    );
    const approved = this.loadApprovedApprovalCheckpoint(
      ctx,
      matterId,
      input.approvalCheckpointId ?? null,
      "feedback_dataset_export",
    );
    if (!approved) {
      throw new ApprovalRequiredError(
        "Durable eval export requires an approved feedback_dataset_export checkpoint.",
      );
    }

    const exportedAt = now();
    const cases = (await this.listReviewDerivedEvalCases(ctx, matterId)) ?? [];
    const evalCases = input.includeClosed
      ? cases
      : cases.filter((item: any) => item.status !== "closed");
    const sourceIndex = await this.listV1SourceIndex(ctx, matterId, {
      includeChunks: false,
      includeEvidenceLinks: true,
      chunkLimit: 0,
    });
    if (!sourceIndex) return null;
    const sourceIndexManifest = this.sourceIndexManifest(sourceIndex);
    const payloadWithoutHash = {
      schema_version: "aletheia-durable-eval-export-local-v1",
      local_only: true,
      storage_driver: "local",
      exported_at: exportedAt,
      matter_id: matterId,
      gate_authorization: {
        status: "approved",
        action: "feedback_dataset_export",
        approval_checkpoint_id: approved.id,
        decided_by: approved.decided_by,
        decided_at: approved.decided_at,
      },
      source_index_manifest: sourceIndexManifest,
      source: "local_review_derived_eval_cases",
      eval_cases: evalCases,
      limitations: [
        "Eval export contains local review-derived eval cases only.",
        "It is durable local input for regression and skills-loop review, not autonomous professional advice.",
      ],
    };
    const hash = exportHash(payloadWithoutHash);
    const exportId = randomUUID();
    const exportPath = localExportPath({
      root: dataDir(),
      matterId,
      exportId,
      kind: "durable_eval_export",
      title: matter.title,
    });
    const payload = {
      ...payloadWithoutHash,
      export_id: exportId,
      export_hash: hash,
    };
    writeProtectedLocalFileSync({
      filePath: exportPath,
      plaintext: JSON.stringify(payload, null, 2),
      purpose: "local_export",
    });

    this.insertExportRecord({
      id: exportId,
      matterId,
      userId: ctx.userId,
      exportType: "durable_eval_export",
      schemaVersion: payload.schema_version,
      exportHash: hash,
      exportPath,
      approvalCheckpointId: approved.id,
      gateAuthorizationStatus: "approved",
      sourceIndexManifest,
      metadata: {
        local_only: true,
        eval_case_count: evalCases.length,
        include_closed: input.includeClosed ?? false,
      },
      createdAt: exportedAt,
    });

    const auditEvent = (await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: "durable_eval_export_created",
      workflowVersion: payload.schema_version,
      model: null,
      details: {
        exportId,
        exportType: "durable_eval_export",
        exportPath,
        exportHash: hash,
        approvalCheckpointId: approved.id,
        gateAuthorizationStatus: "approved",
        evalCaseCount: evalCases.length,
        sourceIndexManifest,
      },
    })) as { id?: string } | null;
    this.attachExportAuditEvent(exportId, auditEvent?.id ?? null);
    this.touchMatter(ctx.userId, matterId);

    return {
      ...payload,
      export_path: exportPath,
      audit_event_id: auditEvent?.id ?? null,
      metadata_persisted: true,
    };
  }

  async createWorkProduct(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateWorkProductInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    if (input.kind === "legal_qa_answer" && input.status === "accepted") {
      throw new ApprovalRequiredError(
        "A Legal Q&A answer can become accepted only through its human-review approval workflow.",
      );
    }
    if (input.kind === "legal_opinion") {
      throw new ApprovalRequiredError(
        "Legal opinions can only be created and accepted through the dedicated legal-opinion workflow.",
      );
    }
    const approvalAction =
      input.kind === "audit_pack"
        ? "audit_pack_export"
        : input.kind === "feedback_export"
          ? "feedback_dataset_export"
          : input.kind === "final_memo"
            ? "final_memo_export"
            : null;
    if (approvalAction) {
      governanceForDatabase(this.db).assertExportAllowed(
        ctx.userId,
        matterId,
        input.governanceApprovalRequestId,
      );
    }
    if (approvalAction) {
      const approved = this.loadApprovedApprovalCheckpoint(
        ctx,
        matterId,
        input.approvalCheckpointId ?? null,
        approvalAction,
      );
      if (!approved) {
        throw new ApprovalRequiredError(
          `${input.kind.replaceAll("_", " ")} requires an approved human checkpoint.`,
        );
      }
    }
    const gateEvidence =
      input.kind === "final_memo"
        ? await this.persistFinalMemoGateAuthorization(
            ctx,
            matterId,
            input.content,
            input.approvalCheckpointId ?? null,
          )
        : null;
    const content = gateEvidence
      ? {
          ...input.content,
          persistedGateEvidence: {
            schemaVersion: "aletheia-final-memo-gate-evidence-v0",
            gateSnapshotAuditEventId: gateEvidence.gateSnapshotAuditEventId,
            gateAuthorizationAuditEventId:
              gateEvidence.gateAuthorizationAuditEventId,
          },
        }
      : input.content;
    const timestamp = now();
    const id = randomUUID();
    const previousVersion = this.db
      .prepare(
        `select id, version from aletheia_work_products
          where matter_id = ? and user_id = ? and kind = ?
          order by version desc, created_at desc limit 1`,
      )
      .get(matterId, ctx.userId, input.kind) as
      | { id: string; version: number | null }
      | undefined;
    const version = Number(previousVersion?.version ?? 0) + 1;
    const contentHash = exportHash(content);
    const exportPath = shouldPersistLocalExport(input.kind)
      ? localExportPath({
          root: dataDir(),
          matterId,
          exportId: id,
          kind: input.kind,
          title: input.title,
        })
      : null;
    if (exportPath) {
      writeProtectedLocalFileSync({
        filePath: exportPath,
        plaintext: JSON.stringify(
          {
            workProductId: id,
            matterId,
            kind: input.kind,
            title: input.title,
            schemaVersion: input.schemaVersion,
            exportedAt: timestamp,
            content,
          },
          null,
          2,
        ),
        purpose: "local_export",
      });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `
          insert into aletheia_work_products (
            id, matter_id, user_id, kind, title, status, schema_version, content,
            validation_errors, generated_by, model, version,
            parent_work_product_id, content_hash, dependency_hash, stale_at,
            stale_reason, created_at, updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          input.kind,
          input.title,
          input.status,
          input.schemaVersion,
          json(content),
          json(input.validationErrors),
          input.generatedBy,
          input.model,
          version,
          previousVersion?.id ?? null,
          contentHash,
          input.dependencyHash ?? null,
          input.staleAt ?? null,
          input.staleReason ?? null,
          timestamp,
          timestamp,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: input.generatedBy,
        action: auditActionForWorkProduct(input.kind),
        workflowVersion: input.schemaVersion,
        model: input.model,
        details: {
          workProductId: id,
          kind: input.kind,
          title: input.title,
          status: input.status,
          version,
          parentWorkProductId: previousVersion?.id ?? null,
          contentHash,
          approvalCheckpointId: input.approvalCheckpointId ?? null,
          exportPath,
          gateSnapshotAuditEventId:
            gateEvidence?.gateSnapshotAuditEventId ?? null,
          gateAuthorizationAuditEventId:
            gateEvidence?.gateAuthorizationAuditEventId ?? null,
        },
      });
      this.touchMatter(ctx.userId, matterId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (exportPath && existsSync(exportPath)) unlinkSync(exportPath);
      throw error;
    }
    return this.workProduct(
      this.db
        .prepare("select * from aletheia_work_products where id = ?")
        .get(id),
    );
  }

  async requestApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    input: RequestApprovalInput,
  ) {
    const governance = governanceForDatabase(this.db);
    const litigationExportAction = [
      "litigation_artifact_export",
      "litigation_matter_audit_export",
    ].includes(input.action);
    const multiPrincipalLitigationExport =
      input.action === "litigation_artifact_export" &&
      governance.multiPrincipalEnabled;
    const access = multiPrincipalLitigationExport
      ? this.litigationAccess(ctx, matterId, "matter.export")
      : null;
    const ownerCtx = access?.ownerCtx ?? ctx;
    const matter = this.loadOwnedMatter(ownerCtx, matterId);
    if (!matter) return null;
    if (litigationExportAction) {
      governance.assertPermission(ctx.userId, matterId, "matter.export");
    }
    const requestedPayload: Record<string, unknown> = {
      ...(input.requestedPayload ?? {}),
      action: input.action,
      matterId,
      ...(input.action === "litigation_artifact_export"
        ? multiPrincipalLitigationExport
          ? {
              requesterId: ctx.userId,
              approvalMode: "multi_principal_governance",
              independentApproval: true,
            }
          : {
              approvalMode: "single_user_non_independent",
              independentApproval: false,
            }
        : {}),
    };
    if (input.action === "litigation_artifact_export") {
      this.assertCurrentLitigationArtifactApprovalBinding(
        ownerCtx.userId,
        matterId,
        requestedPayload,
      );
    }
    if (input.action === "litigation_matter_audit_export") {
      const state = this.buildLitigationMatterAuditState(ownerCtx, matterId);
      if (!state) return null;
      const { checklistHash } = this.buildLitigationAuditChecklist(
        ownerCtx,
        matterId,
        state.snapshot,
      );
      if (
        requestedPayload.matterStateHash !== state.matterStateHash ||
        requestedPayload.checklistHash !== checklistHash ||
        requestedPayload.checklistSchemaVersion !==
          LITIGATION_AUDIT_CHECKLIST_SCHEMA
      ) {
        throw new ApprovalRequiredError(
          "Litigation matter audit approval must bind the current matter state and checklist hashes.",
        );
      }
    }
    const timestamp = now();
    let runId = this.latestAgentRunId(matterId, ownerCtx.userId);
    if (!runId) {
      await this.createAgentRun(ownerCtx, matterId, {
        workflow: matter.template,
        goal: `Approval gate for ${input.action}`,
        status: "queued",
        metadata: {
          source: "approval_request",
          action: input.action,
          requesterId: ctx.userId,
        },
      });
      runId = this.latestAgentRunId(matterId, ownerCtx.userId);
    }
    if (!runId) return null;

    const existingRows = this.db
      .prepare(
        `
        select * from aletheia_human_checkpoints
        where matter_id = ?
          and user_id = ?
          and checkpoint_type = ?
          and status = 'open'
        order by created_at desc
      `,
      )
      .all(matterId, ownerCtx.userId, input.action) as Array<
      Record<string, unknown>
    >;
    for (const existing of existingRows) {
      const checkpoint = this.humanCheckpoint(existing) as Record<string, any>;
      const existingPayload = {
        ...checkpoint.requested_payload,
      } as Record<string, unknown>;
      delete existingPayload.governanceApprovalRequestId;
      if (stableJson(existingPayload) !== stableJson(requestedPayload)) {
        continue;
      }
      if (!multiPrincipalLitigationExport) return checkpoint;
      const governanceRequestId = String(
        checkpoint.requested_payload.governanceApprovalRequestId ?? "",
      );
      const governanceRequest = governance.approvalRequest(governanceRequestId);
      if (
        governanceRequest?.status === "pending" &&
        governanceRequest.requester_id === ctx.userId &&
        this.governanceRequestMatchesLitigationCheckpoint(
          governanceRequest,
          checkpoint,
        )
      ) {
        return checkpoint;
      }
    }

    const stepKey =
      input.action === "audit_pack_export"
        ? "audit_export_gate"
        : "human_review";
    const step = this.db
      .prepare(
        `
        select id from aletheia_agent_steps
        where run_id = ? and step_key = ?
        order by sequence asc
        limit 1
      `,
      )
      .get(runId, stepKey) as any | undefined;

    const id = randomUUID();
    let governanceApprovalRequestId: string | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (multiPrincipalLitigationExport) {
        const governanceRequest = governance.requestApproval(
          ctx.userId,
          matterId,
          input.action,
          {
            ...requestedPayload,
            checkpointId: id,
          },
        );
        governanceApprovalRequestId = governanceRequest?.id ?? null;
        if (!governanceApprovalRequestId) {
          throw new ApprovalRequiredError(
            "A governance approval request is required for litigation artifact export.",
          );
        }
      }
      this.db
        .prepare(
          `
          insert into aletheia_human_checkpoints (
            id, run_id, step_id, matter_id, user_id, checkpoint_type, status,
            prompt, decision, requested_payload, decision_payload, decided_by,
            decided_at, created_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          runId,
          step?.id ?? null,
          matterId,
          ownerCtx.userId,
          input.action,
          "open",
          input.prompt ??
            `Approve ${input.action.replaceAll("_", " ")} before execution.`,
          null,
          json({
            ...requestedPayload,
            ...(governanceApprovalRequestId
              ? { governanceApprovalRequestId }
              : {}),
          }),
          "{}",
          null,
          null,
          timestamp,
        );
      this.writeAuditEvent(ownerCtx.userId, matterId, {
        actor: "human",
        action: "approval_requested",
        workflowVersion: "aletheia-approval-v1",
        model: null,
        details: {
          checkpointId: id,
          action: input.action,
          ownerId: ownerCtx.userId,
          requesterId: ctx.userId,
          governanceApprovalRequestId,
          approvalMode: requestedPayload.approvalMode ?? "human_checkpoint",
          independentApproval: requestedPayload.independentApproval ?? false,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.humanCheckpoint(
      this.db
        .prepare("select * from aletheia_human_checkpoints where id = ?")
        .get(id),
    );
  }

  async decideApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    checkpointId: string,
    input: DecideApprovalInput,
  ) {
    const governance = governanceForDatabase(this.db);
    const matterRow = this.db
      .prepare("select id, user_id from aletheia_matters where id = ?")
      .get(matterId) as { id: string; user_id: string } | undefined;
    if (!matterRow) return null;
    const ownerCtx = { ...ctx, userId: matterRow.user_id };
    const checkpoint = this.db
      .prepare(
        `
        select * from aletheia_human_checkpoints
        where id = ?
          and matter_id = ?
          and user_id = ?
      `,
      )
      .get(checkpointId, matterId, ownerCtx.userId) as any | undefined;
    if (!checkpoint) return null;
    const governedLitigationDecision =
      checkpoint.checkpoint_type === "litigation_artifact_export" &&
      governance.multiPrincipalEnabled;
    if (!governedLitigationDecision && matterRow.user_id !== ctx.userId) {
      return null;
    }
    if (
      ![
        "audit_pack_export",
        "feedback_dataset_export",
        "final_memo_export",
        "litigation_artifact_export",
        "litigation_matter_audit_export",
        "litigation_template_publish",
        "litigation_template_retire",
        "external_model_call",
        "external_source_use",
        "matter_purge",
      ].includes(checkpoint.checkpoint_type)
    ) {
      throw new ApprovalRequiredError(
        "Only high-risk approval checkpoints can be decided here.",
      );
    }

    if (
      checkpoint.checkpoint_type === "litigation_artifact_export" &&
      governance.multiPrincipalEnabled
    ) {
      if (input.decision !== "approved" && input.decision !== "rejected") {
        throw new ApprovalRequiredError(
          "Multi-principal litigation export approvals accept governance votes only.",
        );
      }
      governance.assertPermission(ctx.userId, matterId, "approval.vote");
      const checkpointView = this.humanCheckpoint(checkpoint) as Record<
        string,
        any
      >;
      const governanceApprovalRequestId = String(
        checkpointView.requested_payload.governanceApprovalRequestId ?? "",
      );
      const request = governance.approvalRequest(governanceApprovalRequestId);
      if (
        !request ||
        !this.governanceRequestMatchesLitigationCheckpoint(
          request,
          checkpointView,
        )
      ) {
        throw new ApprovalRequiredError(
          "The litigation export checkpoint is not bound to its governance approval request.",
        );
      }
      const voted = governance.voteApproval(
        ctx.userId,
        governanceApprovalRequestId,
        input.decision,
        input.comment,
      );
      if (!voted) return null;
      const policy = governance.approvalPolicy(
        matterId,
        "litigation_artifact_export",
      );
      const approvedVotes = voted.votes.filter(
        (vote) => (vote as Record<string, unknown>).decision === "approved",
      ).length;
      const rejectedVotes = voted.votes.filter(
        (vote) => (vote as Record<string, unknown>).decision === "rejected",
      ).length;
      const terminal =
        voted.status === "approved" || voted.status === "rejected";
      const timestamp = now();
      this.db
        .prepare(
          `update aletheia_human_checkpoints
              set status = ?, decision = ?, decision_payload = ?,
                  decided_by = ?, decided_at = ?
            where id = ? and matter_id = ? and user_id = ?`,
        )
        .run(
          terminal ? voted.status : "open",
          terminal ? voted.status : null,
          json({
            comment: input.comment ?? null,
            governanceApprovalRequestId,
            governanceStatus: voted.status,
            requesterId: request.requester_id,
            voterId: ctx.userId,
            approvedVotes,
            rejectedVotes,
            requiredApprovals: policy?.required_approvals ?? null,
            requireDistinctRoles: policy?.require_distinct_roles ?? false,
            independentApproval: true,
          }),
          terminal ? ctx.userId : null,
          terminal ? timestamp : null,
          checkpointId,
          matterId,
          ownerCtx.userId,
        );
      this.writeAuditEvent(ownerCtx.userId, matterId, {
        actor: "human",
        action: terminal
          ? voted.status === "approved"
            ? "approval_approved"
            : "approval_rejected"
          : "approval_vote_recorded",
        workflowVersion: "aletheia-governed-approval-v1",
        model: null,
        details: {
          checkpointId,
          action: checkpoint.checkpoint_type,
          decision: input.decision,
          governanceApprovalRequestId,
          governanceStatus: voted.status,
          ownerId: ownerCtx.userId,
          requesterId: request.requester_id,
          voterId: ctx.userId,
          approvedVotes,
          rejectedVotes,
          requiredApprovals: policy?.required_approvals ?? null,
          requireDistinctRoles: policy?.require_distinct_roles ?? false,
          independentApproval: true,
          comment: input.comment ?? null,
        },
      });
      return this.humanCheckpoint(
        this.db
          .prepare("select * from aletheia_human_checkpoints where id = ?")
          .get(checkpointId),
      );
    }

    const timestamp = now();
    const resolvedStatus =
      input.decision === "approved" || input.decision === "rejected"
        ? input.decision
        : "resolved";
    this.db
      .prepare(
        `
        update aletheia_human_checkpoints
        set status = ?, decision = ?, decision_payload = ?, decided_by = ?, decided_at = ?
        where id = ?
      `,
      )
      .run(
        resolvedStatus,
        input.decision,
        json({
          comment: input.comment ?? null,
          editedPayload: input.editedPayload ?? null,
          response: input.response ?? null,
          approvalMode:
            checkpoint.checkpoint_type === "litigation_artifact_export"
              ? "single_user_non_independent"
              : "human_checkpoint",
          independentApproval: false,
        }),
        ctx.userId,
        timestamp,
        checkpointId,
      );
    await this.writeAuditEvent(ownerCtx.userId, matterId, {
      actor: "human",
      action:
        input.decision === "approved"
          ? "approval_approved"
          : input.decision === "rejected"
            ? "approval_rejected"
            : input.decision === "edited"
              ? "approval_edited"
              : "approval_responded",
      workflowVersion: "aletheia-approval-v0",
      model: null,
      details: {
        checkpointId,
        action: checkpoint.checkpoint_type,
        decision: input.decision,
        comment: input.comment ?? null,
        editedPayload: input.editedPayload ?? null,
        response: input.response ?? null,
        ownerId: ownerCtx.userId,
        requesterId: ctx.userId,
        voterId: ctx.userId,
        approvalMode:
          checkpoint.checkpoint_type === "litigation_artifact_export"
            ? "single_user_non_independent"
            : "human_checkpoint",
        independentApproval: false,
      },
    });
    return this.humanCheckpoint(
      this.db
        .prepare("select * from aletheia_human_checkpoints where id = ?")
        .get(checkpointId),
    );
  }

  async hasApprovedCheckpoint(
    ctx: AletheiaUserContext,
    matterId: string,
    checkpointId: string,
    action: string,
    binding: Record<string, unknown> = {},
  ) {
    const approved = this.loadApprovedApprovalCheckpoint(
      ctx,
      matterId,
      checkpointId,
      action,
    ) as any;
    if (!approved) return false;
    for (const [key, value] of Object.entries(binding)) {
      if (approved.requested_payload?.[key] !== value) return false;
    }
    if (action === "external_source_use") {
      this.db
        .prepare(
          "update aletheia_human_checkpoints set status = 'consumed' where id = ? and status = 'approved'",
        )
        .run(checkpointId);
    }
    return true;
  }

  async archiveMatter(ctx: AletheiaUserContext, matterId: string) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "update aletheia_matters set status = 'archived', updated_at = ? where id = ? and user_id = ?",
        )
        .run(timestamp, matterId, ctx.userId);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "matter_archived",
        workflowVersion: "aletheia-lifecycle-v1",
        model: null,
        details: { previousStatus: matter.status },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.loadOwnedMatter(ctx, matterId);
  }

  async purgeMatter(
    ctx: AletheiaUserContext,
    matterId: string,
    approvalCheckpointId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    governanceForDatabase(this.db).assertPurgeAllowed(ctx.userId, matterId);
    if (
      !this.loadApprovedApprovalCheckpoint(
        ctx,
        matterId,
        approvalCheckpointId,
        "matter_purge",
      )
    ) {
      throw new ApprovalRequiredError(
        "Matter purge requires an approved matter_purge checkpoint.",
      );
    }
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "matter_purge_authorized",
      workflowVersion: "aletheia-lifecycle-v1",
      model: null,
      details: { approvalCheckpointId },
    });
    const documentRows = this.db
      .prepare(
        "select id, name from aletheia_matter_documents where matter_id = ?",
      )
      .all(matterId) as Array<{ id: string; name: string }>;
    const lastAudit = this.db
      .prepare(
        "select event_hash from aletheia_audit_events where matter_id = ? order by sequence desc limit 1",
      )
      .get(matterId) as { event_hash?: string } | undefined;
    const counts = {
      documents: documentRows.length,
      workProducts: Number(
        (
          this.db
            .prepare(
              "select count(*) as count from aletheia_work_products where matter_id = ?",
            )
            .get(matterId) as { count?: number }
        )?.count ?? 0,
      ),
      auditEvents: Number(
        (
          this.db
            .prepare(
              "select count(*) as count from aletheia_audit_events where matter_id = ?",
            )
            .get(matterId) as { count?: number }
        )?.count ?? 0,
      ),
    };
    const deletedAt = now();
    const tombstone = {
      id: randomUUID(),
      matterId,
      userId: ctx.userId,
      matterTitleHash: exportHash(matter.title),
      lastAuditHash: lastAudit?.event_hash ?? null,
      approvalCheckpointId,
      counts,
      deletedAt,
    };
    const documentsRoot = path.join(dataDir(), "documents");
    const invalidDocumentRows: string[] = [];
    const pendingPaths = documentRows.flatMap((row) => {
      const storagePath = derivedDocumentStoragePath({
        documentsRoot,
        documentId: row.id,
        filename: row.name,
      });
      if (storagePath) {
        return [storagePath, path.join(documentsRoot, `${row.id}.cdr.pdf`)];
      }
      invalidDocumentRows.push(
        `${row.id}: refused document row with an invalid storage identity`,
      );
      return [];
    });
    pendingPaths.push(path.join(dataDir(), "exports", matterId));
    pendingPaths.push(
      path.join(
        semanticIndexConfig().index_dir,
        `${safeFilePart(matterId) || matterId}.json`,
      ),
    );
    const pendingCleanup = { status: "pending", failures: [] as string[] };
    let tombstoneHash = auditEventHash({
      ...tombstone,
      pendingPaths,
      cleanup: pendingCleanup,
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("delete from aletheia_document_chunks_fts where matter_id = ?")
        .run(matterId);
      this.db
        .prepare("delete from aletheia_matters where id = ? and user_id = ?")
        .run(matterId, ctx.userId);
      this.db
        .prepare(
          `insert into aletheia_deletion_tombstones (
             id, matter_id, user_id, matter_title_hash, last_audit_hash,
             approval_checkpoint_id, details, tombstone_hash, deleted_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tombstone.id,
          matterId,
          ctx.userId,
          tombstone.matterTitleHash,
          tombstone.lastAuditHash,
          approvalCheckpointId,
          json({ counts, pendingPaths, cleanup: pendingCleanup }),
          tombstoneHash,
          deletedAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const cleanupFailures: string[] = [...invalidDocumentRows];
    for (const target of pendingPaths) {
      try {
        removeValidatedPurgeTarget(target, matterId);
      } catch (error) {
        cleanupFailures.push(
          `${target}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const cleanup = {
      status: cleanupFailures.length ? "cleanup_pending" : "completed",
      failures: cleanupFailures,
      completedAt: now(),
    };
    tombstoneHash = auditEventHash({ ...tombstone, pendingPaths, cleanup });
    this.db
      .prepare(
        "update aletheia_deletion_tombstones set details = ?, tombstone_hash = ? where id = ?",
      )
      .run(
        json({ counts, pendingPaths, cleanup }),
        tombstoneHash,
        tombstone.id,
      );
    return {
      schema_version: "aletheia-matter-purge-tombstone-v1",
      ...tombstone,
      cleanup,
      tombstoneHash,
    };
  }

  async retryPurgeCleanup(ctx: AletheiaUserContext, tombstoneId: string) {
    const row = this.db
      .prepare(
        "select * from aletheia_deletion_tombstones where id = ? and user_id = ?",
      )
      .get(tombstoneId, ctx.userId) as Record<string, any> | undefined;
    if (!row) return null;
    const details = parseObject(String(row.details ?? "{}"));
    const pendingPaths = Array.isArray(details.pendingPaths)
      ? details.pendingPaths.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const tombstone = {
      id: row.id,
      matterId: row.matter_id,
      userId: row.user_id,
      matterTitleHash: row.matter_title_hash,
      lastAuditHash: row.last_audit_hash ?? null,
      approvalCheckpointId: row.approval_checkpoint_id,
      counts: parseObject(json(details.counts ?? {})),
      deletedAt: row.deleted_at,
    };
    const storedCleanup =
      details.cleanup &&
      typeof details.cleanup === "object" &&
      !Array.isArray(details.cleanup)
        ? details.cleanup
        : {};
    const expectedTombstoneHash = auditEventHash({
      ...tombstone,
      pendingPaths,
      cleanup: storedCleanup,
    });
    if (expectedTombstoneHash !== row.tombstone_hash) {
      throw new Error("Deletion tombstone integrity validation failed.");
    }
    const failures: string[] = [];
    for (const target of pendingPaths) {
      try {
        removeValidatedPurgeTarget(target, String(row.matter_id));
      } catch (error) {
        failures.push(
          `${target}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const cleanup = {
      status: failures.length ? "cleanup_pending" : "completed",
      failures,
      completedAt: now(),
    };
    const tombstoneHash = auditEventHash({
      ...tombstone,
      pendingPaths,
      cleanup,
    });
    this.db
      .prepare(
        "update aletheia_deletion_tombstones set details = ?, tombstone_hash = ? where id = ?",
      )
      .run(
        json({ counts: tombstone.counts, pendingPaths, cleanup }),
        tombstoneHash,
        tombstoneId,
      );
    return {
      schema_version: "aletheia-matter-purge-tombstone-v1",
      ...tombstone,
      pendingPaths,
      cleanup,
      tombstoneHash,
    };
  }

  async addMatterMemory(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AddMatterMemoryInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `
        insert into aletheia_matter_memory_items (
          id, matter_id, user_id, category, title, body, source, metadata,
          created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        matterId,
        ctx.userId,
        input.category,
        input.title,
        input.body,
        input.source ?? "human",
        json(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "matter_memory_added",
      workflowVersion: "aletheia-memory-v0",
      model: null,
      details: { memoryItemId: id, category: input.category },
    });
    this.touchMatter(ctx.userId, matterId);
    return this.matterMemory(
      this.db
        .prepare("select * from aletheia_matter_memory_items where id = ?")
        .get(id),
    );
  }

  async createPlaybook(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreatePlaybookInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `
        insert into aletheia_playbooks (
          id, matter_id, user_id, name, description, version, status, content,
          approved_by, approved_at, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        matterId,
        ctx.userId,
        input.name,
        input.description,
        input.version ?? "v0.1",
        "draft",
        json(input.content),
        null,
        null,
        timestamp,
        timestamp,
      );
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "playbook_drafted",
      workflowVersion: "aletheia-playbook-v0",
      model: null,
      details: { playbookId: id, name: input.name },
    });
    this.touchMatter(ctx.userId, matterId);
    return this.playbook(
      this.db.prepare("select * from aletheia_playbooks where id = ?").get(id),
    );
  }

  async approvePlaybook(
    ctx: AletheiaUserContext,
    matterId: string,
    playbookId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const existing = this.db
      .prepare(
        "select * from aletheia_playbooks where id = ? and matter_id = ? and user_id = ?",
      )
      .get(playbookId, matterId, ctx.userId);
    if (!existing) return null;
    const timestamp = now();
    this.db
      .prepare(
        `
        update aletheia_playbooks
        set status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
        where id = ?
      `,
      )
      .run(ctx.userId, timestamp, timestamp, playbookId);
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "playbook_approved",
      workflowVersion: "aletheia-playbook-v0",
      model: null,
      details: { playbookId },
    });
    this.touchMatter(ctx.userId, matterId);
    return this.playbook(
      this.db
        .prepare("select * from aletheia_playbooks where id = ?")
        .get(playbookId),
    );
  }

  async approveSkillCandidate(
    ctx: AletheiaUserContext,
    matterId: string,
    input: ApproveSkillCandidateInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const candidate = this.normalizeSkillCandidate(input.candidate);
    if (candidate.approval_status !== "candidate") {
      throw new ApprovalRequiredError(
        "Only candidate skills can enter the local approved skill activation workflow.",
      );
    }
    if (candidate.created_from_eval_case_ids.length === 0) {
      throw new ApprovalRequiredError(
        "Approved skill activation requires at least one persisted review-derived eval case.",
      );
    }

    const sourceEvalCases = this.loadEvalCasesByIds(
      ctx,
      matterId,
      candidate.created_from_eval_case_ids,
    );
    if (
      sourceEvalCases.length !== candidate.created_from_eval_case_ids.length
    ) {
      throw new ApprovalRequiredError(
        "Approved skill activation requires eval case IDs that belong to this local matter.",
      );
    }

    const timestamp = now();
    const playbookId = randomUUID();
    const activeSkill = {
      ...candidate,
      approval_status: "approved",
      version: this.approvedSkillVersion(candidate.version),
      activated_at: timestamp,
      activated_by: ctx.userId,
      active: true,
    };
    const content = {
      schemaVersion: "aletheia-approved-skill-playbook-local-v1",
      localOnly: true,
      professionalSkillId: candidate.id,
      skillId: candidate.id,
      professionalSkill: activeSkill,
      sourceEvalCaseIds: candidate.created_from_eval_case_ids,
      sourceEvalCases: sourceEvalCases.map((evalCase) => ({
        id: evalCase.id,
        failure_type: evalCase.failure_type,
        status: evalCase.status,
        source_review_item_id: evalCase.source_review_item_id,
        source_audit_event_id: evalCase.source_audit_event_id,
      })),
      approval: {
        status: "approved",
        approvedBy: ctx.userId,
        approvedAt: timestamp,
        comment: input.approvalComment ?? null,
      },
      controls: {
        matterScoped: true,
        candidateRemainsInactiveUntilApproval: true,
        activeOnlyAfterHumanApproval: true,
        agentMayAutoApproveSkill: false,
      },
    };

    this.db
      .prepare(
        `
        insert into aletheia_playbooks (
          id, matter_id, user_id, name, description, version, status, content,
          approved_by, approved_at, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        playbookId,
        matterId,
        ctx.userId,
        candidate.name,
        candidate.description,
        activeSkill.version,
        "approved",
        json(content),
        ctx.userId,
        timestamp,
        timestamp,
        timestamp,
      );

    const auditEvent = (await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "approved_skill_activated",
      workflowVersion: "aletheia-approved-skill-activation-local-v1",
      model: null,
      details: {
        schemaVersion: "aletheia-approved-skill-activation-local-v1",
        localOnly: true,
        candidateSkillId: candidate.id,
        playbookId,
        sourceEvalCaseIds: candidate.created_from_eval_case_ids,
        approvalStatus: "approved",
        active: true,
        approvalComment: input.approvalComment ?? null,
      },
    })) as { id: string } | null;
    this.touchMatter(ctx.userId, matterId);

    const playbook = this.playbook(
      this.db
        .prepare("select * from aletheia_playbooks where id = ?")
        .get(playbookId),
    );

    return {
      schema_version: "aletheia-approved-skill-activation-local-v1",
      local_only: true,
      storage_driver: "local",
      matter_id: matterId,
      candidate_skill_id: candidate.id,
      active: true,
      active_skill: activeSkill,
      playbook,
      audit_event: auditEvent,
      source_eval_cases: sourceEvalCases,
    };
  }

  async proposePlaybookImprovement(
    ctx: AletheiaUserContext,
    matterId: string,
    input: ProposePlaybookImprovementInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const sourcePlaybook = input.sourcePlaybookId
      ? (this.db
          .prepare(
            `
            select * from aletheia_playbooks
            where id = ? and matter_id = ? and user_id = ?
          `,
          )
          .get(input.sourcePlaybookId, matterId, ctx.userId) as any | undefined)
      : (this.db
          .prepare(
            `
            select * from aletheia_playbooks
            where matter_id = ? and user_id = ? and status = 'approved'
            order by approved_at desc, created_at desc
            limit 1
          `,
          )
          .get(matterId, ctx.userId) as any | undefined);
    if (!sourcePlaybook) {
      throw new ApprovalRequiredError(
        "An approved source playbook is required before proposing improvements.",
      );
    }
    if (sourcePlaybook.status !== "approved") {
      throw new ApprovalRequiredError(
        "Playbook improvements must be based on an approved source playbook.",
      );
    }

    const allowedTags = new Set(
      (input.includeReviewTags?.length
        ? input.includeReviewTags
        : [
            "unsupported_claim",
            "citation_not_supporting",
            "missing_fact",
            "overclaim",
            "outdated_authority",
            "conflicting_evidence",
            "needs_human_judgment",
          ]
      )
        .map((tag) => tag.trim())
        .filter(Boolean),
    );
    const reviews = (
      this.db
        .prepare(
          `
          select * from aletheia_review_items
          where matter_id = ?
            and tag in (${[...allowedTags].map(() => "?").join(",") || "''"})
          order by created_at desc
          limit 20
        `,
        )
        .all(matterId, ...allowedTags) as any[]
    ).map((row) => this.review(row));
    const feedbackMemory = (
      this.db
        .prepare(
          `
          select * from aletheia_matter_memory_items
          where matter_id = ?
            and user_id = ?
            and category = 'reviewer_feedback'
          order by created_at desc
          limit 10
        `,
        )
        .all(matterId, ctx.userId) as any[]
    ).map((row) => this.matterMemory(row));

    if (
      reviews.length === 0 &&
      feedbackMemory.length === 0 &&
      !input.reviewerNote
    ) {
      throw new ApprovalRequiredError(
        "Reviewer feedback, review tags, or a reviewer note is required before proposing a playbook improvement.",
      );
    }

    const source = this.playbook(sourcePlaybook);
    const nextVersion = `${String(source.version ?? "v0.1")}-proposal-${now().slice(0, 10)}`;
    const proposalTitle =
      input.title?.trim() || `${source.name} Improvement Proposal`;
    const reviewSummaries = reviews.map((review) => ({
      reviewId: review.id,
      tag: review.tag,
      targetType: review.target_type,
      targetId: review.target_id,
      comment: review.comment,
      evidenceItemId: review.evidence_item_id,
      workProductId: review.work_product_id,
    }));
    const memorySummaries = feedbackMemory.map((memory) => ({
      memoryId: memory.id,
      title: memory.title,
      body: memory.body,
      source: memory.source,
    }));

    const proposal = await this.createPlaybook(ctx, matterId, {
      name: proposalTitle,
      description:
        "Draft improvement proposal generated from reviewer feedback. It is not active until a human approves it.",
      version: nextVersion,
      content: {
        schemaVersion: "aletheia-playbook-improvement-proposal-v0",
        proposalType: "playbook_improvement",
        status: "draft_requires_human_approval",
        sourcePlaybookId: source.id,
        sourcePlaybookName: source.name,
        sourcePlaybookVersion: source.version,
        reviewerNote: input.reviewerNote ?? null,
        proposedChanges: [
          ...(reviews.length
            ? [
                {
                  section: "Review controls",
                  change:
                    "Add an explicit checkpoint requiring reviewers to resolve recurring review tags before final reliance.",
                  rationale:
                    "Reviewer tags identified unsupported, missing, conflicting, or judgment-sensitive issues.",
                },
              ]
            : []),
          ...(feedbackMemory.length
            ? [
                {
                  section: "Matter memory usage",
                  change:
                    "Add a step to inspect matter-scoped reviewer feedback before drafting or revising work products.",
                  rationale:
                    "Matter Memory contains reviewer feedback that should influence future workflow execution without becoming global memory.",
                },
              ]
            : []),
          ...(input.reviewerNote
            ? [
                {
                  section: "Reviewer note",
                  change: input.reviewerNote,
                  rationale:
                    "Human reviewer supplied a direct improvement instruction.",
                },
              ]
            : []),
        ],
        sourceReviews: reviewSummaries,
        sourceMatterMemory: memorySummaries,
        controls: {
          matterScoped: true,
          agentMayAutoModifyApprovedPlaybook: false,
          requiresHumanApprovalBeforeUse: true,
        },
      },
    });
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: "playbook_improvement_proposed",
      workflowVersion: "aletheia-playbook-improvement-v0",
      model: null,
      details: {
        proposalPlaybookId: (proposal as any).id,
        sourcePlaybookId: source.id,
        reviewCount: reviews.length,
        memoryCount: feedbackMemory.length,
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return proposal;
  }

  async addReview(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AddReviewInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `
        insert into aletheia_review_items (
          id, matter_id, work_product_id, evidence_item_id, target_type,
          target_id, tag, comment, reviewer_user_id, reviewer_name,
          resolution_status, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        matterId,
        input.workProductId,
        input.evidenceItemId,
        input.targetType,
        input.targetId,
        input.tag,
        input.comment,
        ctx.userId,
        input.reviewerName,
        "open",
        timestamp,
      );
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "review_added",
      workflowVersion: "aletheia-v0",
      model: null,
      details: {
        targetType: input.targetType,
        targetId: input.targetId,
        tag: input.tag,
        reviewId: id,
      },
    });
    return this.review(
      this.db
        .prepare("select * from aletheia_review_items where id = ?")
        .get(id),
    );
  }

  async resolveReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
    input: ResolveReviewInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const existing = this.db
      .prepare(
        `
        select * from aletheia_review_items
        where id = ?
          and matter_id = ?
      `,
      )
      .get(reviewId, matterId);
    if (!existing) return null;

    const previousStatus = String(
      (existing as { resolution_status?: unknown }).resolution_status ?? "open",
    );
    const timestamp = now();
    this.db
      .prepare(
        `
        update aletheia_review_items
        set resolution_status = ?,
            resolution_comment = ?,
            resolved_by = ?,
            resolved_at = ?
        where id = ?
          and matter_id = ?
      `,
      )
      .run(
        input.status,
        input.comment ?? null,
        ctx.userId,
        timestamp,
        reviewId,
        matterId,
      );

    const updatedReview = this.review(
      this.db
        .prepare("select * from aletheia_review_items where id = ?")
        .get(reviewId),
    );
    const auditEvent = (await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "review_resolution_recorded",
      workflowVersion: "aletheia-review-resolution-v0",
      model: null,
      details: {
        reviewId,
        previousStatus,
        status: input.status,
        comment: input.comment ?? null,
        targetType: updatedReview.target_type,
        targetId: updatedReview.target_id,
        tag: updatedReview.tag,
        workProductId: updatedReview.work_product_id,
        evidenceItemId: updatedReview.evidence_item_id,
      },
    })) as { id?: string } | null;

    const shouldCreateEval =
      input.createEvalCase ?? input.status !== "accepted";
    const evalCase =
      shouldCreateEval && input.status !== "accepted"
        ? this.upsertReviewDerivedEvalCase({
            ctx,
            matterId,
            review: updatedReview,
            auditEventId: auditEvent?.id ?? null,
          })
        : null;

    this.touchMatter(ctx.userId, matterId);
    return {
      review: updatedReview,
      auditEvent,
      evalCase,
    };
  }

  async approveShareholderPenetrationGraph(
    ctx: AletheiaUserContext,
    matterId: string,
    graphId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const graph = this.db
      .prepare(
        `
        select * from aletheia_work_products
        where id = ?
          and matter_id = ?
          and user_id = ?
          and kind = 'shareholder_penetration_graph'
        `,
      )
      .get(graphId, matterId, ctx.userId) as any | undefined;
    if (!graph) return null;
    if (graph.status === "accepted") return this.workProduct(graph);
    if (graph.status !== "needs_review") {
      throw new ApprovalRequiredError(
        "Only a shareholder graph in needs_review status can be approved.",
      );
    }
    const reviews = this.db
      .prepare(
        `
        select id, resolution_status
        from aletheia_review_items
        where matter_id = ?
          and work_product_id = ?
        order by created_at asc
        `,
      )
      .all(matterId, graphId) as Array<{
      id: string;
      resolution_status?: string | null;
    }>;
    if (
      !reviews.length ||
      reviews.some((review) => review.resolution_status === "open")
    ) {
      throw new ApprovalRequiredError(
        "Resolve every shareholder graph review item before approval.",
      );
    }
    const graphAudit = (
      this.db
        .prepare(
          `
        select id, details
        from aletheia_audit_events
        where matter_id = ?
          and action = 'human_note.shareholder_penetration_graph_persisted'
        order by created_at desc
        `,
        )
        .all(matterId) as Array<{ id: string; details: string }>
    ).find((event) => parseObject(event.details).workpaperId === graphId);
    if (!graphAudit) {
      throw new ApprovalRequiredError(
        "Shareholder graph approval requires a persisted graph provenance audit event.",
      );
    }
    const timestamp = now();
    this.db
      .prepare(
        `
        update aletheia_work_products
        set status = 'accepted', updated_at = ?
        where id = ? and matter_id = ? and user_id = ?
        `,
      )
      .run(timestamp, graphId, matterId, ctx.userId);
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "shareholder_penetration_graph_approved",
      workflowVersion: "hermes-shareholder-penetration-v0",
      model: null,
      details: {
        graphWorkProductId: graphId,
        graphPersistenceAuditEventId: graphAudit.id,
        reviewIds: reviews.map((review) => review.id),
        reviewStatuses: reviews.map(
          (review) => review.resolution_status ?? "open",
        ),
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return this.workProduct(
      this.db
        .prepare("select * from aletheia_work_products where id = ?")
        .get(graphId),
    );
  }

  async approveLegalQaAnswer(
    ctx: AletheiaUserContext,
    matterId: string,
    answerId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const answer = this.db
      .prepare(
        `select * from aletheia_work_products where id = ? and matter_id = ? and user_id = ? and kind = 'legal_qa_answer'`,
      )
      .get(answerId, matterId, ctx.userId) as any | undefined;
    if (!answer) return null;
    if (answer.status === "accepted") return this.workProduct(answer);
    if (answer.status !== "needs_review") {
      throw new ApprovalRequiredError(
        "Only a Legal Q&A answer in needs_review status can be approved.",
      );
    }
    this.assertCurrentLegalResearchMemo(ctx, matterId, answerId, answer);
    const reviews = this.db
      .prepare(
        `select id, resolution_status, resolved_by, resolved_at
          from aletheia_review_items
          where matter_id = ? and work_product_id = ?
          order by created_at asc`,
      )
      .all(matterId, answerId) as Array<{
      id: string;
      resolution_status?: string | null;
      resolved_by?: string | null;
      resolved_at?: string | null;
    }>;
    if (
      !reviews.length ||
      reviews.some(
        (review) =>
          review.resolution_status !== "accepted" ||
          !review.resolved_by ||
          !review.resolved_at,
      )
    ) {
      throw new ApprovalRequiredError(
        "Every Legal Q&A review item must be explicitly accepted by a recorded reviewer before approval.",
      );
    }
    const reviewBindings = this.exactReviewResolutionBindings(
      ctx,
      matterId,
      reviews,
    );
    const answerAudit = (
      this.db
        .prepare(
          `select id, details from aletheia_audit_events where matter_id = ? and action = 'human_note.legal_qa_answer_persisted' order by created_at desc`,
        )
        .all(matterId) as Array<{ id: string; details: string }>
    ).find((event) => parseObject(event.details).workpaperId === answerId);
    if (!answerAudit) {
      throw new ApprovalRequiredError(
        "Legal Q&A approval requires a persisted answer provenance audit event.",
      );
    }
    const timestamp = now();
    this.db
      .prepare(
        `update aletheia_work_products set status = 'accepted', updated_at = ? where id = ? and matter_id = ? and user_id = ?`,
      )
      .run(timestamp, answerId, matterId, ctx.userId);
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "legal_qa_answer_approved",
      workflowVersion: "hermes-legal-qa-v0",
      model: null,
      details: {
        answerWorkProductId: answerId,
        answerContentHash: answer.content_hash,
        version: Number(answer.version),
        answerPersistenceAuditEventId: answerAudit.id,
        reviewIds: reviews.map((review) => review.id),
        reviewStatuses: reviews.map(
          (review) => review.resolution_status ?? "open",
        ),
        reviewBindings,
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return this.workProduct(
      this.db
        .prepare("select * from aletheia_work_products where id = ?")
        .get(answerId),
    );
  }

  async createLegalOpinion(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLegalOpinionInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const answer = this.assertEligibleAcceptedLegalResearchMemo(
      ctx,
      matterId,
      input.answerId,
      { requireExactApprovalAudit: false },
    );
    const cover = this.legalOpinionCover(input.cover);
    const answerContent = parseObject(answer.content);
    const id = randomUUID();
    const opinionReviewId = randomUUID();
    const timestamp = now();
    const previous = this.db
      .prepare(
        `select id, version from aletheia_work_products
           where matter_id = ? and user_id = ? and kind = 'legal_opinion'
           order by version desc, created_at desc limit 1`,
      )
      .get(matterId, ctx.userId) as { id: string; version: number | null } | undefined;
    const version = Number(previous?.version ?? 0) + 1;
    const content = {
      schemaVersion: "vera-legal-opinion-v1",
      answerBinding: {
        answerId: answer.id,
        answerContentHash: answer.content_hash,
        answerVersion: Number(answer.version),
        issueTreeId: answerContent.issueTreeId,
        issueTreeHash: answerContent.issueTreeHash,
        inputManifestId: answerContent.inputManifestId,
        inputBindingHash: answerContent.inputBindingHash,
        sourceSnapshots: answerContent.sourceSnapshots,
        answerReviewIds: answer.reviewIds,
        answerApprovalAuditEventId: answer.approvalAuditEventId,
      },
      cover,
      reviewBindings: { opinionReviewIds: [opinionReviewId] },
      sections: this.legalOpinionSections(answerContent),
      finalization: "lawyer_review_required",
    };
    const contentHash = exportHash(content);
    const dependencyHash = exportHash(content.answerBinding);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_work_products (
             id, matter_id, user_id, kind, title, status, schema_version, content,
             validation_errors, generated_by, model, version, parent_work_product_id,
             content_hash, dependency_hash, stale_at, stale_reason, created_at, updated_at
           ) values (?, ?, ?, 'legal_opinion', ?, 'needs_review', ?, ?, '[]', 'system', null, ?, ?, ?, ?, null, null, ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          cover.title ?? `法律意见书：${String(answer.title)}`,
          "vera-legal-opinion-v1",
          json(content),
          version,
          previous?.id ?? null,
          contentHash,
          dependencyHash,
          timestamp,
          timestamp,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "system",
        action: "legal_opinion_created",
        workflowVersion: "vera-legal-opinion-v1",
        model: null,
        details: {
          opinionId: id,
          opinionContentHash: contentHash,
          answerId: answer.id,
          answerContentHash: answer.content_hash,
          issueTreeId: answerContent.issueTreeId,
          issueTreeHash: answerContent.issueTreeHash,
          answerReviewIds: answer.reviewIds,
          answerApprovalAuditEventId: answer.approvalAuditEventId,
          dependencyHash,
        },
      });
      this.db
        .prepare(
          `insert into aletheia_review_items (
             id, matter_id, work_product_id, evidence_item_id, target_type,
             target_id, tag, comment, reviewer_user_id, reviewer_name,
             resolution_status, created_at
           ) values (?, ?, ?, null, 'work_product', ?, 'needs_human_judgment', ?, ?, null, 'open', ?)`,
        )
        .run(
          opinionReviewId,
          matterId,
          id,
          id,
          "请以执业律师身份复核本法律意见书是否忠实限于已采纳研究结论、引用和限定语。",
          ctx.userId,
          timestamp,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "review_added",
        workflowVersion: "aletheia-review-resolution-v0",
        model: null,
        details: {
          reviewId: opinionReviewId,
          targetType: "work_product",
          targetId: id,
          tag: "needs_human_judgment",
          workProductId: id,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const review = this.review(
      this.db.prepare("select * from aletheia_review_items where id = ?").get(opinionReviewId),
    );
    return {
      ...this.workProduct(
        this.db.prepare("select * from aletheia_work_products where id = ?").get(id),
      ),
      review,
    };
  }

  async approveLegalOpinion(
    ctx: AletheiaUserContext,
    matterId: string,
    opinionId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const opinion = this.loadLegalOpinion(ctx, matterId, opinionId);
    this.assertCurrentLegalOpinion(ctx, matterId, opinion);
    if (opinion.status === "accepted") {
      this.assertLegalOpinionApprovalAudit(ctx, matterId, opinion);
      return this.workProduct(opinion);
    }
    if (opinion.status !== "needs_review") {
      throw new ApprovalRequiredError(
        "Only a legal opinion in needs_review status can be approved.",
      );
    }
    const reviews = this.legalOpinionReviews(matterId, opinionId);
    if (
      !reviews.length ||
      reviews.some(
        (review) =>
          review.resolution_status !== "accepted" ||
          !review.resolved_by ||
          !review.resolved_at,
      )
    ) {
      throw new ApprovalRequiredError(
        "Every legal-opinion review item must be explicitly accepted by a recorded lawyer before approval.",
      );
    }
    const reviewBindings = this.exactReviewResolutionBindings(
      ctx,
      matterId,
      reviews,
    );
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_work_products set status = 'accepted', updated_at = ?
             where id = ? and matter_id = ? and user_id = ? and status = 'needs_review'`,
        )
        .run(timestamp, opinionId, matterId, ctx.userId);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "legal_opinion_approved",
        workflowVersion: "vera-legal-opinion-v1",
        model: null,
        details: {
          opinionId,
          opinionContentHash: opinion.content_hash,
          version: Number(opinion.version),
          reviewIds: reviews.map((review) => review.id),
          reviewBindings,
          answerId: parseObject(parseObject(opinion.content).answerBinding).answerId ?? null,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.workProduct(
      this.db.prepare("select * from aletheia_work_products where id = ?").get(opinionId),
    );
  }

  async exportLegalOpinionDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    opinionId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const opinion = this.loadLegalOpinion(ctx, matterId, opinionId);
    this.assertCurrentLegalOpinion(ctx, matterId, opinion);
    const approvalAudit = this.assertLegalOpinionApprovalAudit(ctx, matterId, opinion);
    const exportedAt = now();
    const exportId = randomUUID();
    const opinionContent = parseObject(opinion.content);
    const bytes = await buildLegalOpinionDocx({
      title: String(opinion.title),
      matterId,
      version: Number(opinion.version),
      contentHash: String(opinion.content_hash),
      exportedAt,
      content: opinionContent,
    });
    const exportPath = localExportPath({
      root: dataDir(), matterId, exportId, kind: "legal_opinion", title: String(opinion.title), extension: "docx",
    });
    writeProtectedLocalFileSync({ filePath: exportPath, plaintext: bytes, purpose: "local_export" });
    const fileHash = `sha256:${createHash("sha256").update(readFileSync(exportPath)).digest("hex")}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lockedOpinion = this.loadLegalOpinion(ctx, matterId, opinionId);
      this.assertCurrentLegalOpinion(ctx, matterId, lockedOpinion);
      this.assertLegalOpinionApprovalAudit(ctx, matterId, lockedOpinion);
      if (
        lockedOpinion.status !== "accepted" ||
        lockedOpinion.content_hash !== opinion.content_hash ||
        Number(lockedOpinion.version) !== Number(opinion.version)
      ) throw new ApprovalRequiredError("The legal opinion changed before DOCX export could be persisted.");
      this.insertExportRecord({
        id: exportId,
        matterId,
        userId: ctx.userId,
        exportType: "legal_opinion_docx",
        schemaVersion: "vera-legal-opinion-docx-export-v1",
        exportHash: fileHash,
        exportPath,
        approvalCheckpointId: null,
        gateAuthorizationStatus: "approved",
        sourceIndexManifest: { answerId: parseObject(parseObject(lockedOpinion.content).answerBinding).answerId ?? null },
        metadata: {
          opinionId,
          version: Number(lockedOpinion.version),
          contentHash: lockedOpinion.content_hash,
          approvalAuditEventId: approvalAudit.id,
          fileSha256: fileHash,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        createdAt: exportedAt,
      });
      const audit = this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "legal_opinion_docx_exported",
        workflowVersion: "vera-legal-opinion-docx-export-v1",
        model: null,
        details: {
          exportId, opinionId, version: Number(lockedOpinion.version), contentHash: lockedOpinion.content_hash,
          approvalAuditEventId: approvalAudit.id, fileSha256: fileHash,
        },
      });
      this.attachExportAuditEvent(exportId, audit.id);
      this.touchMatter(ctx.userId, matterId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (existsSync(exportPath)) unlinkSync(exportPath);
      throw error;
    }
    return { exportId, opinionId, version: Number(opinion.version), contentHash: opinion.content_hash };
  }

  async downloadLegalOpinionDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ): Promise<LegalOpinionDownload | null> {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const exported = this.db.prepare(
      `select * from aletheia_exports where id = ? and matter_id = ? and user_id = ? and export_type = 'legal_opinion_docx'`,
    ).get(exportId, matterId, ctx.userId) as Record<string, any> | undefined;
    if (!exported) return null;
    const metadata = parseObject(exported.metadata);
    const opinionId = typeof metadata.opinionId === "string" ? metadata.opinionId : "";
    const opinion = this.loadLegalOpinion(ctx, matterId, opinionId);
    this.assertCurrentLegalOpinion(ctx, matterId, opinion);
    const approvalAudit = this.assertLegalOpinionApprovalAudit(ctx, matterId, opinion);
    const fail = (): never => { throw new ApprovalRequiredError("Legal opinion DOCX export integrity verification failed."); };
    const expectedSourceIndexManifest = {
      answerId: parseObject(parseObject(opinion.content).answerBinding).answerId ?? null,
    };
    const expectedMetadata = {
      opinionId,
      version: Number(opinion.version),
      contentHash: opinion.content_hash,
      approvalAuditEventId: approvalAudit.id,
      fileSha256: exported.export_hash,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    if (
      exported.schema_version !== "vera-legal-opinion-docx-export-v1" ||
      exported.gate_authorization_status !== "approved" ||
      stableJson(parseObject(exported.source_index_manifest)) !== stableJson(expectedSourceIndexManifest) ||
      stableJson(metadata) !== stableJson(expectedMetadata)
    ) fail();
    const audit = this.db.prepare(
      `select * from aletheia_audit_events where id = ? and matter_id = ? and user_id = ? and action = 'legal_opinion_docx_exported'`,
    ).get(exported.audit_event_id, matterId, ctx.userId) as Record<string, any> | undefined;
    const auditDetails = parseObject(audit?.details);
    const expectedAuditDetails = {
      exportId,
      opinionId,
      version: Number(opinion.version),
      contentHash: opinion.content_hash,
      approvalAuditEventId: approvalAudit.id,
      fileSha256: exported.export_hash,
    };
    if (!audit || stableJson(auditDetails) !== stableJson(expectedAuditDetails)) fail();
    const bytes = this.readVerifiedLocalDocxExport(
      matterId,
      exported.export_path,
      exported.export_hash,
      "Legal opinion DOCX export integrity verification failed.",
    );
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human", action: "legal_opinion_docx_downloaded", workflowVersion: "vera-legal-opinion-docx-export-v1", model: null,
      details: { exportId, opinionId, version: Number(opinion.version), contentHash: opinion.content_hash, exportHash: exported.export_hash },
    });
    return {
      exportId, workProductId: opinionId, title: String(opinion.title), version: Number(opinion.version),
      contentHash: String(opinion.content_hash),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes,
    };
  }

  async exportLegalResearchMemoDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    memoId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const memo = this.assertEligibleAcceptedLegalResearchMemo(ctx, matterId, memoId);
    const binding = this.legalResearchMemoExportBinding(memo);
    const exportedAt = now();
    const exportId = randomUUID();
    const bytes = await buildLegalResearchMemoDocx({
      title: String(memo.title),
      matterId,
      version: Number(memo.version),
      contentHash: String(memo.content_hash),
      exportedAt,
      content: parseObject(memo.content),
    });
    const exportPath = localExportPath({
      root: dataDir(),
      matterId,
      exportId,
      kind: "legal_research_memo",
      title: String(memo.title),
      extension: "docx",
    });
    writeProtectedLocalFileSync({ filePath: exportPath, plaintext: bytes, purpose: "local_export" });
    const fileHash = `sha256:${createHash("sha256").update(readFileSync(exportPath)).digest("hex")}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lockedMemo = this.assertEligibleAcceptedLegalResearchMemo(ctx, matterId, memoId);
      const lockedBinding = this.legalResearchMemoExportBinding(lockedMemo);
      if (
        lockedMemo.content_hash !== memo.content_hash ||
        Number(lockedMemo.version) !== Number(memo.version) ||
        stableJson(lockedBinding) !== stableJson(binding)
      ) {
        throw new ApprovalRequiredError("The legal research memo changed before DOCX export could be persisted.");
      }
      this.insertExportRecord({
        id: exportId,
        matterId,
        userId: ctx.userId,
        exportType: "legal_research_memo_docx",
        schemaVersion: "vera-legal-research-memo-docx-export-v1",
        exportHash: fileHash,
        exportPath,
        approvalCheckpointId: null,
        gateAuthorizationStatus: "accepted_current_memo",
        sourceIndexManifest: lockedBinding,
        metadata: {
          ...lockedBinding,
          fileSha256: fileHash,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        createdAt: exportedAt,
      });
      const audit = this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "legal_research_memo_docx_exported",
        workflowVersion: "vera-legal-research-memo-docx-export-v1",
        model: null,
        details: {
          exportId,
          ...lockedBinding,
          fileSha256: fileHash,
        },
      });
      this.attachExportAuditEvent(exportId, audit.id);
      this.touchMatter(ctx.userId, matterId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (existsSync(exportPath)) unlinkSync(exportPath);
      throw error;
    }
    return {
      exportId,
      memoId,
      version: Number(memo.version),
      contentHash: String(memo.content_hash),
    };
  }

  async downloadLegalResearchMemoDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ): Promise<LegalResearchMemoDownload | null> {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const exported = this.db.prepare(
      `select * from aletheia_exports where id = ? and matter_id = ? and user_id = ? and export_type = 'legal_research_memo_docx'`,
    ).get(exportId, matterId, ctx.userId) as Record<string, any> | undefined;
    if (!exported) return null;
    const metadata = parseObject(exported.metadata);
    const memoId = typeof metadata.memoId === "string" ? metadata.memoId : "";
    const memo = this.assertEligibleAcceptedLegalResearchMemo(ctx, matterId, memoId);
    const binding = this.legalResearchMemoExportBinding(memo);
    const expectedMetadata = {
      ...binding,
      fileSha256: exported.export_hash,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const fail = (): never => {
      throw new ApprovalRequiredError("Legal research memo DOCX export integrity verification failed.");
    };
    if (
      exported.schema_version !== "vera-legal-research-memo-docx-export-v1" ||
      exported.gate_authorization_status !== "accepted_current_memo" ||
      stableJson(parseObject(exported.source_index_manifest)) !== stableJson(binding) ||
      stableJson(metadata) !== stableJson(expectedMetadata)
    ) {
      fail();
    }
    const audit = this.db.prepare(
      `select * from aletheia_audit_events where id = ? and matter_id = ? and user_id = ? and action = 'legal_research_memo_docx_exported'`,
    ).get(exported.audit_event_id, matterId, ctx.userId) as Record<string, any> | undefined;
    const expectedAuditDetails = { exportId, ...binding, fileSha256: exported.export_hash };
    if (!audit || stableJson(parseObject(audit.details)) !== stableJson(expectedAuditDetails)) {
      fail();
    }
    const bytes = this.readVerifiedLocalDocxExport(
      matterId,
      exported.export_path,
      exported.export_hash,
      "Legal research memo DOCX export integrity verification failed.",
    );
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "legal_research_memo_docx_downloaded",
      workflowVersion: "vera-legal-research-memo-docx-export-v1",
      model: null,
      details: {
        exportId,
        ...binding,
        exportHash: exported.export_hash,
      },
    });
    return {
      exportId,
      workProductId: memoId,
      title: String(memo.title),
      version: Number(memo.version),
      contentHash: String(memo.content_hash),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes,
    };
  }

  async approveWordAddinHandoff(
    ctx: AletheiaUserContext,
    matterId: string,
    handoffId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const handoff = this.db
      .prepare(
        `select * from aletheia_work_products where id = ? and matter_id = ? and user_id = ? and kind = 'word_addin_handoff'`,
      )
      .get(handoffId, matterId, ctx.userId) as any | undefined;
    if (!handoff) return null;
    if (handoff.status === "accepted") return this.workProduct(handoff);
    if (handoff.status !== "needs_review")
      throw new ApprovalRequiredError(
        "Only a Word Add-in handoff in needs_review status can be approved.",
      );
    const reviews = this.db
      .prepare(
        `select id, resolution_status from aletheia_review_items where matter_id = ? and work_product_id = ? order by created_at asc`,
      )
      .all(matterId, handoffId) as Array<{
      id: string;
      resolution_status?: string | null;
    }>;
    if (
      !reviews.length ||
      reviews.some((review) => review.resolution_status === "open")
    )
      throw new ApprovalRequiredError(
        "Resolve every Word Add-in handoff review item before approval.",
      );
    const handoffAudit = (
      this.db
        .prepare(
          `select id, details from aletheia_audit_events where matter_id = ? and action = 'human_note.word_addin_handoff_persisted' order by created_at desc`,
        )
        .all(matterId) as Array<{ id: string; details: string }>
    ).find((event) => parseObject(event.details).workpaperId === handoffId);
    if (!handoffAudit)
      throw new ApprovalRequiredError(
        "Word Add-in approval requires a persisted handoff provenance audit event.",
      );
    this.db
      .prepare(
        `update aletheia_work_products set status = 'accepted', updated_at = ? where id = ? and matter_id = ? and user_id = ?`,
      )
      .run(now(), handoffId, matterId, ctx.userId);
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "word_addin_handoff_approved",
      workflowVersion: "hermes-word-addin-handoff-v0",
      model: null,
      details: {
        handoffWorkProductId: handoffId,
        handoffPersistenceAuditEventId: handoffAudit.id,
        reviewIds: reviews.map((review) => review.id),
        reviewStatuses: reviews.map(
          (review) => review.resolution_status ?? "open",
        ),
        wordClientApplied: false,
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return this.workProduct(
      this.db
        .prepare("select * from aletheia_work_products where id = ?")
        .get(handoffId),
    );
  }

  async approvePreferenceLearningCandidate(
    ctx: AletheiaUserContext,
    matterId: string,
    memoryItemId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const memory = this.db
      .prepare(
        `select * from aletheia_matter_memory_items where id = ? and matter_id = ? and user_id = ? and category = 'output_preference'`,
      )
      .get(memoryItemId, matterId, ctx.userId) as any | undefined;
    if (!memory) return null;
    const metadata = parseObject(memory.metadata);
    if (
      metadata.preferenceLearningProposal !== true ||
      metadata.scopeType !== "matter" ||
      metadata.scopeId !== matterId ||
      metadata.optIn !== true ||
      metadata.revocable !== true ||
      metadata.autoApply !== false
    ) {
      throw new ApprovalRequiredError(
        "Only an opted-in, revocable, matter-scoped non-automatic preference candidate can be approved.",
      );
    }
    const proposalAudit = (
      this.db
        .prepare(
          `select id, details from aletheia_audit_events where matter_id = ? and action = 'human_note.preference_learning_proposal_recorded' order by created_at desc`,
        )
        .all(matterId) as Array<{ id: string; details: string }>
    ).find((event) => parseObject(event.details).memoryItemId === memoryItemId);
    if (!proposalAudit) {
      throw new ApprovalRequiredError(
        "Preference approval requires the original proposal audit record.",
      );
    }
    const proposalDetails = parseObject(proposalAudit.details);
    const reviewId =
      typeof proposalDetails.reviewCommentId === "string"
        ? proposalDetails.reviewCommentId
        : "";
    const review = reviewId
      ? (this.db
          .prepare(
            `select id, resolution_status from aletheia_review_items where id = ? and matter_id = ?`,
          )
          .get(reviewId, matterId) as
          | { id: string; resolution_status?: string | null }
          | undefined)
      : undefined;
    if (!review || review.resolution_status !== "accepted") {
      throw new ApprovalRequiredError(
        "Preference approval requires its linked review to be accepted.",
      );
    }
    if (
      metadata.status === "approved" &&
      typeof metadata.approvedPlaybookId === "string"
    ) {
      const existing = this.db
        .prepare(
          `select * from aletheia_playbooks where id = ? and matter_id = ? and user_id = ?`,
        )
        .get(metadata.approvedPlaybookId, matterId, ctx.userId);
      if (existing) return this.playbook(existing);
    }
    const playbook = (await this.createPlaybook(ctx, matterId, {
      name: `Approved output preference: ${String(memory.title).slice(0, 160)}`,
      description:
        "Human-approved, matter-scoped output preference from a revocable candidate.",
      version: "v1.0",
      content: {
        schemaVersion: "hermes-preference-playbook-v1",
        preferenceMemoryItemId: memoryItemId,
        preference: memory.body,
        scopeType: "matter",
        scopeId: matterId,
        autoApply: false,
        revocable: true,
        proposalAuditEventId: proposalAudit.id,
        acceptedReviewId: review.id,
      },
    })) as { id: string } | null;
    if (!playbook) return null;
    const approved = await this.approvePlaybook(ctx, matterId, playbook.id);
    const timestamp = now();
    this.db
      .prepare(
        `update aletheia_matter_memory_items set metadata = ?, updated_at = ? where id = ? and matter_id = ? and user_id = ?`,
      )
      .run(
        json({
          ...metadata,
          status: "approved",
          approvedPlaybookId: playbook.id,
          approvedAt: timestamp,
          autoApply: false,
        }),
        timestamp,
        memoryItemId,
        matterId,
        ctx.userId,
      );
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "preference_learning_candidate_approved",
      workflowVersion: "hermes-preference-learning-v1",
      model: null,
      details: {
        memoryItemId,
        proposalAuditEventId: proposalAudit.id,
        acceptedReviewId: review.id,
        approvedPlaybookId: playbook.id,
        autoApply: false,
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return approved;
  }

  async listReviewDerivedEvalCases(ctx: AletheiaUserContext, matterId: string) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    return this.all("aletheia_eval_cases", matterId, "created_at asc").map(
      (row) => this.evalCase(row),
    );
  }

  async appendAuditEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AppendAuditEventInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    return this.writeAuditEvent(ctx.userId, matterId, input);
  }

  async persistGateSnapshot(
    ctx: AletheiaUserContext,
    matterId: string,
    input: PersistGateSnapshotInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const snapshot = buildGateSnapshotAuditDetails({
      matterId,
      action: input.action,
      approvalCheckpointId: input.approvalCheckpointId ?? null,
      content: input.content,
    });
    return this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: GATE_AUDIT_ACTIONS.resultsPersisted,
      workflowVersion: snapshot.details.schemaVersion,
      model: null,
      details: snapshot.details,
    });
  }

  async createAgentRun(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateAgentRunInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const id = randomUUID();
    const timestamp = now();
    const runStatus = input.status === "running" ? "running" : "needs_human";
    const scaffold = buildAgentRunTraceScaffold({
      workflow: input.workflow,
      goal: input.goal,
      matterId,
    });
    const metadata = {
      ...(input.metadata ?? {}),
      workflowGraph: buildAgentWorkflowGraph(scaffold),
    };
    this.db
      .prepare(
        `
        insert into aletheia_agent_runs (
          id, matter_id, user_id, workflow, goal, status, current_step_key,
          model_profile, storage_driver, budget, metadata, started_at,
          completed_at, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        matterId,
        ctx.userId,
        input.workflow,
        input.goal,
        runStatus,
        runStatus === "needs_human" ? "human_review" : "parse_documents",
        input.modelProfile ?? null,
        "local",
        json(defaultRunBudget(input.budget)),
        json(metadata),
        timestamp,
        null,
        timestamp,
        timestamp,
      );
    this.createAgentRunTraceScaffold({
      runId: id,
      matterId,
      userId: ctx.userId,
      workflow: input.workflow,
      goal: input.goal,
      timestamp,
    });
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: "agent_run_created",
      workflowVersion: "aletheia-agent-runtime-v0",
      model: input.modelProfile ?? null,
      details: {
        agentRunId: id,
        workflow: input.workflow,
        budget: defaultRunBudget(input.budget),
      },
    });
    return this.agentRunWithTrace(
      this.db.prepare("select * from aletheia_agent_runs where id = ?").get(id),
    );
  }

  async persistV1RuntimeResult(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Omit<V1RuntimePersistenceInput, "userId" | "matterId">,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const plan = createV1RuntimePersistencePlan({
      ...input,
      userId: ctx.userId,
      matterId,
    });

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `
          insert into aletheia_agent_runs (
            id, matter_id, user_id, workflow, goal, status, current_step_key,
            model_profile, storage_driver, budget, metadata, started_at,
            completed_at, created_at, updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          plan.agentRun.id,
          plan.agentRun.matter_id,
          plan.agentRun.user_id,
          plan.agentRun.workflow,
          plan.agentRun.goal,
          plan.agentRun.status,
          plan.agentRun.current_step_key,
          plan.agentRun.model_profile,
          plan.agentRun.storage_driver,
          json(plan.agentRun.budget),
          json(plan.agentRun.metadata),
          plan.agentRun.started_at,
          plan.agentRun.completed_at,
          plan.agentRun.created_at,
          plan.agentRun.updated_at,
        );

      for (const step of plan.steps) {
        this.db
          .prepare(
            `
            insert into aletheia_agent_steps (
              id, run_id, matter_id, user_id, step_key, title, sequence, status,
              input, output, validation_errors, metrics, started_at, completed_at,
              created_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            step.id,
            step.run_id,
            step.matter_id,
            step.user_id,
            step.step_key,
            step.title,
            step.sequence,
            step.status,
            json(step.input),
            json(step.output),
            json(step.validation_errors),
            json(step.metrics),
            step.started_at,
            step.completed_at,
            step.created_at,
          );
      }

      for (const call of plan.toolCalls) {
        this.db
          .prepare(
            `
            insert into aletheia_tool_calls (
              id, run_id, step_id, matter_id, user_id, tool_name, risk_level,
              status, input, output, error, metrics, started_at, completed_at,
              created_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            call.id,
            call.run_id,
            call.step_id,
            call.matter_id,
            call.user_id,
            call.tool_name,
            call.risk_level,
            call.status,
            json(call.input),
            json(call.output),
            call.error,
            json(call.metrics),
            call.started_at,
            call.completed_at,
            call.created_at,
          );
      }

      for (const checkpoint of plan.humanCheckpoints) {
        this.db
          .prepare(
            `
            insert into aletheia_human_checkpoints (
              id, run_id, step_id, matter_id, user_id, checkpoint_type, status,
              prompt, decision, requested_payload, decision_payload, decided_by,
              decided_at, created_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            checkpoint.id,
            checkpoint.run_id,
            checkpoint.step_id,
            checkpoint.matter_id,
            checkpoint.user_id,
            checkpoint.checkpoint_type,
            checkpoint.status,
            checkpoint.prompt,
            checkpoint.decision,
            json(checkpoint.requested_payload),
            json(checkpoint.decision_payload),
            checkpoint.decided_by,
            checkpoint.decided_at,
            checkpoint.created_at,
          );
      }

      for (const event of plan.auditEvents) {
        this.writeAuditEvent(ctx.userId, matterId, {
          actor: event.actor,
          action: event.action,
          workflowVersion: event.workflow_version,
          model: event.model,
          details: {
            ...event.details,
            submittedEventId: event.id,
            submittedCreatedAt: event.created_at,
          },
        });
      }

      this.touchMatter(ctx.userId, matterId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.agentRunWithTrace(
      this.db
        .prepare("select * from aletheia_agent_runs where id = ?")
        .get(plan.agentRun.id),
    );
  }

  async resumeAgentRun(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
    input: ResumeAgentRunInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const run = this.db
      .prepare(
        `
        select * from aletheia_agent_runs
        where id = ? and matter_id = ? and user_id = ?
      `,
      )
      .get(runId, matterId, ctx.userId) as any | undefined;
    if (!run) return null;
    const checkpoint = this.db
      .prepare(
        `
        select * from aletheia_human_checkpoints
        where id = ? and run_id = ? and matter_id = ? and user_id = ?
      `,
      )
      .get(input.checkpointId, runId, matterId, ctx.userId) as any | undefined;
    if (!checkpoint) return null;

    const timestamp = now();
    const latestSequence = this.db
      .prepare(
        `
        select coalesce(max(sequence), 0) as sequence
        from aletheia_agent_steps
        where run_id = ?
      `,
      )
      .get(runId) as { sequence?: number } | undefined;
    const stepSequence = Number(latestSequence?.sequence ?? 0) + 1;
    const checkpointType = String(checkpoint.checkpoint_type);

    if (checkpointType === "external_model_call") {
      const allowedExternalDecisions = ["approved", "edited", "responded"];
      if (
        !allowedExternalDecisions.includes(String(checkpoint.decision)) ||
        !["approved", "resolved"].includes(String(checkpoint.status))
      ) {
        throw new ApprovalRequiredError(
          "Only approved, edited, or responded external model call checkpoints can retry an agent run.",
        );
      }

      const stepId = randomUUID();
      const requestedPayload = parseObject(checkpoint.requested_payload);
      const decisionPayload = parseObject(checkpoint.decision_payload);
      this.db
        .prepare(
          `
          insert into aletheia_agent_steps (
            id, run_id, matter_id, user_id, step_key, title, sequence, status,
            input, output, validation_errors, metrics, started_at, completed_at,
            created_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          stepId,
          runId,
          matterId,
          ctx.userId,
          "retry_after_external_model_approval",
          "Retry after external model approval",
          stepSequence,
          "completed",
          json({
            checkpointId: checkpoint.id,
            checkpointType,
            decision: checkpoint.decision,
            note: input.note ?? null,
          }),
          json({
            result:
              "External model retry was authorized by a persisted human checkpoint. No external provider call was dispatched by the local resume route.",
            providerDecision: requestedPayload.providerDecision ?? null,
            decisionPayload,
            nextStep: "caller_may_persist_retry_result",
            auditEvent: "v1_runtime_retry_recorded",
          }),
          "[]",
          json({ durationMs: 0, externalProviderDispatched: false }),
          timestamp,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(
          `
          insert into aletheia_tool_calls (
            id, run_id, step_id, matter_id, user_id, tool_name, risk_level,
            status, input, output, error, metrics, started_at, completed_at,
            created_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          randomUUID(),
          runId,
          stepId,
          matterId,
          ctx.userId,
          "v1_approval_retry",
          "high",
          "completed",
          json({
            checkpointId: checkpoint.id,
            decision: checkpoint.decision,
            providerDecision: requestedPayload.providerDecision ?? null,
          }),
          json({
            retryAuthorized: true,
            externalProviderDispatched: false,
            nextStep: "persist_v1_runtime_result_after_local_retry",
          }),
          null,
          json({ durationMs: 0 }),
          timestamp,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(
          `
          update aletheia_agent_runs
          set status = 'running',
              current_step_key = 'provider_dispatch_ready',
              updated_at = ?
          where id = ?
        `,
        )
        .run(timestamp, runId);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "system",
        action: "v1_runtime_retry_recorded",
        workflowVersion: "aletheia-v1-llm-runtime",
        model: run.model_profile ?? null,
        details: {
          agentRunId: runId,
          checkpointId: checkpoint.id,
          decision: checkpoint.decision,
          note: input.note ?? null,
          externalProviderDispatched: false,
          providerDecision: requestedPayload.providerDecision ?? null,
        },
      });
      this.touchMatter(ctx.userId, matterId);
      return this.agentRunWithTrace(
        this.db
          .prepare("select * from aletheia_agent_runs where id = ?")
          .get(runId),
      );
    }

    if (
      checkpoint.status !== "resolved" ||
      !["edited", "responded"].includes(String(checkpoint.decision))
    ) {
      throw new ApprovalRequiredError(
        "Only edited or responded checkpoints can resume an agent run.",
      );
    }

    const revisedDraft: any = await this.generateDraftMemo(ctx, matterId);
    const stepId = randomUUID();
    this.db
      .prepare(
        `
        insert into aletheia_agent_steps (
          id, run_id, matter_id, user_id, step_key, title, sequence, status,
          input, output, validation_errors, metrics, started_at, completed_at,
          created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        stepId,
        runId,
        matterId,
        ctx.userId,
        "resume_after_human_checkpoint",
        "Resume after human checkpoint",
        stepSequence,
        "completed",
        json({
          checkpointId: checkpoint.id,
          checkpointType: checkpoint.checkpoint_type,
          decision: checkpoint.decision,
          note: input.note ?? null,
        }),
        json({
          specialistRole: "Risk Reviewer",
          allowedTools: ["work_product_create"],
          result:
            "Human edit/response was incorporated into a revised draft memo for review.",
          workProductKind: "draft_memo",
          workProductId: revisedDraft?.id ?? null,
          auditEvent: "agent_run_resumed",
        }),
        "[]",
        json({ durationMs: 0 }),
        timestamp,
        timestamp,
        timestamp,
      );
    this.db
      .prepare(
        `
        insert into aletheia_tool_calls (
          id, run_id, step_id, matter_id, user_id, tool_name, risk_level,
          status, input, output, error, metrics, started_at, completed_at,
          created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        randomUUID(),
        runId,
        stepId,
        matterId,
        ctx.userId,
        "work_product_create",
        "high",
        "completed",
        json({
          checkpointId: checkpoint.id,
          decision: checkpoint.decision,
          workProductKind: "draft_memo",
        }),
        json({
          workProductId: revisedDraft?.id ?? null,
          auditEvent: "memo_generated",
        }),
        null,
        json({ durationMs: 0 }),
        timestamp,
        timestamp,
        timestamp,
      );
    this.db
      .prepare(
        `
        update aletheia_agent_runs
        set status = 'needs_human',
            current_step_key = 'human_review',
            metadata = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        json(
          workflowGraphWithResumeNode(parseObject(run.metadata), {
            sequence: stepSequence,
            checkpointType: String(checkpoint.checkpoint_type),
            decision: checkpoint.decision ? String(checkpoint.decision) : null,
            revisedDraftMemoId: revisedDraft?.id ?? null,
          }),
        ),
        timestamp,
        runId,
      );
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: "agent_run_resumed",
      workflowVersion: "aletheia-agent-runtime-v0",
      model: run.model_profile ?? null,
      details: {
        agentRunId: runId,
        checkpointId: checkpoint.id,
        decision: checkpoint.decision,
        revisedDraftMemoId: revisedDraft?.id ?? null,
        note: input.note ?? null,
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return this.agentRunWithTrace(
      this.db
        .prepare("select * from aletheia_agent_runs where id = ?")
        .get(runId),
    );
  }

  async createEvidenceItem(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateEvidenceItemInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const source = this.db
      .prepare(
        `
        select
          c.id as chunk_id,
          c.document_id,
          c.page,
          c.section,
          c.text,
          c.quote_start,
          c.quote_end,
          c.metadata,
          d.name as document_name
        from aletheia_document_chunks c
        join aletheia_matter_documents d on d.id = c.document_id
        where c.id = ?
          and c.matter_id = ?
          and c.user_id = ?
      `,
      )
      .get(input.sourceChunkId, matterId, ctx.userId) as any | undefined;

    if (!source) return null;

    const suggestedClaim = deriveClaimSuggestionFromText(source.text);
    const claimId =
      typeof input.claimId === "string" && input.claimId.trim()
        ? input.claimId.trim()
        : suggestedClaim.claimId;
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `
        insert into aletheia_evidence_items (
          id, matter_id, work_product_id, document_id, source_chunk_id,
          claim_id, document_name, page, section, quote, quote_start,
          quote_end, relevance, support_status, confidence, metadata, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        matterId,
        input.workProductId ?? null,
        source.document_id,
        source.chunk_id,
        claimId,
        source.document_name,
        source.page ?? null,
        source.section ?? null,
        source.text,
        source.quote_start ?? null,
        source.quote_end ?? null,
        input.relevance,
        input.supportStatus,
        input.confidence ?? null,
        json({
          source: "local_document_search",
          normalizedFact: normalizedFactFromQuote(source.text),
          sensitiveMaterialFlags: [
            ...new Set([
              ...sensitiveMaterialFlagsForText({
                filename: source.document_name,
                text: source.text,
              }),
              ...stringArrayFromObject(
                parseObject(source.metadata).sensitiveMaterialFlags,
              ),
            ]),
          ],
          claimSuggestion:
            claimId === suggestedClaim.claimId ? suggestedClaim : null,
          ...(input.metadata ?? {}),
        }),
        timestamp,
      );

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "evidence_mapped",
      workflowVersion: "aletheia-local-v0",
      model: null,
      details: {
        evidenceItemId: id,
        sourceChunkId: input.sourceChunkId,
        documentId: source.document_id,
        claimId,
        supportStatus: input.supportStatus,
        relevance: input.relevance,
      },
    });
    this.touchMatter(ctx.userId, matterId);

    return this.evidence(
      this.db
        .prepare("select * from aletheia_evidence_items where id = ?")
        .get(id),
    );
  }

  async generateIssueMap(ctx: AletheiaUserContext, matterId: string) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const evidence = this.all("aletheia_evidence_items", matterId).map((row) =>
      this.evidence(row),
    );
    const validationErrors =
      evidence.length === 0
        ? ["Issue map has no source-linked evidence items yet."]
        : [];

    return this.createWorkProduct(ctx, matterId, {
      kind: "issue_map",
      title: `${matter.title} Issue Map`,
      status: evidence.length === 0 ? "needs_review" : "generated",
      schemaVersion: "aletheia-issue-map-v0",
      content: buildSourceLinkedIssueMapContent({ matter, evidence }),
      validationErrors,
      generatedBy: "system",
      model: null,
    });
  }

  async generateEvidenceMatrix(ctx: AletheiaUserContext, matterId: string) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const evidence = this.all("aletheia_evidence_items", matterId).map((row) =>
      this.evidence(row),
    );
    const validationErrors =
      evidence.length === 0
        ? ["Evidence matrix has no source-linked evidence items yet."]
        : [];

    return this.createWorkProduct(ctx, matterId, {
      kind: "evidence_matrix",
      title: `${matter.title} Evidence Matrix`,
      status: evidence.length === 0 ? "needs_review" : "generated",
      schemaVersion: "aletheia-evidence-matrix-v0",
      content: buildSourceLinkedEvidenceMatrixContent({ matter, evidence }),
      validationErrors,
      generatedBy: "system",
      model: null,
    });
  }

  async generateDraftMemo(ctx: AletheiaUserContext, matterId: string) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const draftProfile = professionalDraftProfileForTemplate(matter.template);

    const matrixRow = this.db
      .prepare(
        `
        select * from aletheia_work_products
        where matter_id = ?
          and user_id = ?
          and kind = 'evidence_matrix'
        order by created_at desc
        limit 1
      `,
      )
      .get(matterId, ctx.userId);

    const evidence = this.all("aletheia_evidence_items", matterId).map((row) =>
      this.evidence(row),
    );
    const fallbackMatrix = buildSourceLinkedEvidenceMatrixContent({
      matter,
      evidence,
    });
    const matrix = matrixRow
      ? this.workProduct(matrixRow).content
      : fallbackMatrix;
    const validationErrors = [
      ...(matrixRow
        ? []
        : [
            "No persisted evidence matrix was found; draft used a generated fallback matrix.",
          ]),
      ...(evidence.length === 0
        ? ["Draft memo has no source-linked evidence items yet."]
        : []),
    ];

    return this.createWorkProduct(ctx, matterId, {
      kind: draftProfile.kind,
      title: `${matter.title} ${draftProfile.titleSuffix}`,
      status: validationErrors.length ? "needs_review" : "generated",
      schemaVersion: draftProfile.schemaVersion,
      content: buildDeterministicDraftMemoContent({
        matter,
        evidenceMatrix: matrix,
        matrixWorkProductId: matrixRow ? String((matrixRow as any).id) : null,
      }),
      validationErrors,
      generatedBy: "system",
      model: null,
    });
  }

  async uploadMatterDocument(
    ctx: AletheiaUserContext,
    matterId: string,
    input: UploadMatterDocumentInput,
  ) {
    const access = this.matterDocumentWriteAccess(ctx, matterId);
    if (!access) return null;
    const { ownerCtx } = access;
    const governance = governanceForDatabase(this.db);

    const id = randomUUID();
    const timestamp = now();
    const root = dataDir();
    const originalSha256 = createHash("sha256")
      .update(input.buffer)
      .digest("hex");
    if (
      input.malwareScan?.sha256 &&
      input.malwareScan.sha256 !== originalSha256
    ) {
      throw new Error(
        "Upload changed after malware scanning; refusing persistence",
      );
    }
    if (
      input.contentDisarm?.metadata.originalSha256 &&
      input.contentDisarm.metadata.originalSha256 !== originalSha256
    ) {
      throw new Error("Upload changed before CDR; refusing persistence");
    }
    if (
      input.contentDisarm?.metadata.mode === "required" &&
      input.malwareScan?.status !== "clean"
    ) {
      throw new Error(
        "Required CDR persistence requires a clean ClamAV result from the preceding scan stage",
      );
    }
    if (
      input.contentDisarm?.derivedBuffer &&
      input.contentDisarm.metadata.derivedSha256 !==
        createHash("sha256")
          .update(input.contentDisarm.derivedBuffer)
          .digest("hex")
    ) {
      throw new Error("CDR derivative hash mismatch; refusing persistence");
    }
    if (
      input.contentDisarm?.metadata.status === "sanitized" &&
      applicationEncryptionMode() !== "required"
    ) {
      throw new Error(
        "A sanitized derivative cannot be persisted unless application encryption is required for the authoritative original evidence",
      );
    }
    const filePath = await writeMatterDocumentFile({
      documentsDir: path.join(root, "documents"),
      documentId: id,
      filename: input.filename,
      buffer: input.buffer,
    });
    chmodSync(filePath, 0o400);
    const contentDisarm = input.contentDisarm?.metadata ?? null;
    const sanitized =
      contentDisarm?.status === "sanitized" &&
      input.contentDisarm?.derivedBuffer &&
      contentDisarm.derivedFilename;
    const derivedFilePath = sanitized
      ? await writeMatterDocumentFile({
          documentsDir: path.join(root, "documents"),
          documentId: `${id}.cdr`,
          filename: String(contentDisarm.derivedFilename),
          buffer: input.contentDisarm!.derivedBuffer!,
        })
      : null;
    if (derivedFilePath) chmodSync(derivedFilePath, 0o400);
    const parseFilename = sanitized
      ? String(contentDisarm.derivedFilename)
      : input.filename;
    const parseBuffer = sanitized
      ? input.contentDisarm!.derivedBuffer!
      : input.buffer;

    let parsedText = "";
    let parserMetadata: Record<string, unknown> = {};
    let extractionFailed = false;
    let extractionFailureCode: string | null = null;
    let extractionFailureDetail: string | null = null;
    try {
      const extracted = await extractMatterDocument({
        filename: parseFilename,
        buffer: parseBuffer,
      });
      parsedText = extracted.text;
      parserMetadata = extracted.metadata;
    } catch (error) {
      extractionFailed = true;
      const systemCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      const message = error instanceof Error ? error.message : "";
      extractionFailureDetail = message
        .replace(/(?:\/[^\s'"`]+)+/g, "[local-path]")
        .replace(/\s+/g, " ")
        .slice(0, 300);
      extractionFailureCode = systemCode
        ? `parser_${systemCode.toLowerCase()}`
        : message.includes("invalid schema") ||
            message.includes("invalid page data")
          ? "ocr_output_invalid"
          : message.startsWith("Local OCR failed")
            ? "ocr_runtime_failed"
            : "text_extraction_failed";
    }
    const parsedStatus = parsedStatusForUpload({
      filename: parseFilename,
      parsedText,
      extractionFailed,
    });

    const chunks =
      parsedStatus === "parsed" ? chunkMatterDocument(parsedText) : [];
    const summary =
      parsedStatus === "parsed"
        ? parsedText.replace(/\s+/g, " ").trim().slice(0, 400)
        : parseFailureSummary(parsedStatus);
    const sensitiveMaterialFlags = sensitiveMaterialFlagsForText({
      filename: input.filename,
      text: parsedText,
    });

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `
        insert into aletheia_matter_documents (
          id, matter_id, user_id, document_id, name, document_type,
          parsed_status, summary, metadata, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          matterId,
          ownerCtx.userId,
          null,
          input.filename,
          documentTypeForFilename(input.filename),
          parsedStatus,
          summary,
          json({
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            storagePath: filePath,
            originalSha256: contentDisarm?.originalSha256 ?? originalSha256,
            evidenceFileMode: "immutable_owner_read_only",
            contentDisarm: contentDisarm
              ? {
                  ...contentDisarm,
                  derivedStoragePath: derivedFilePath,
                }
              : null,
            parseSource:
              derivedFilePath && contentDisarm?.status === "sanitized"
                ? "cdr_pdf_derivative"
                : "original_evidence",
            chunkCount: chunks.length,
            parser: "aletheia-local-v0",
            parserMetadata,
            sheetCount: parserMetadata.sheetCount ?? null,
            sectionCount: parserMetadata.sectionCount ?? null,
            pageCount: parserMetadata.pageCount ?? null,
            parseStatus: parsedStatus,
            parseFailureReason:
              parsedStatus === "needs_ocr"
                ? "pdf_without_text_layer"
                : parsedStatus === "failed"
                  ? "text_extraction_failed"
                  : null,
            extractionFailureCode,
            extractionFailureDetail,
            needsOcr: parsedStatus === "needs_ocr",
            sensitiveMaterialFlags,
            malwareScan: input.malwareScan ?? null,
          }),
          timestamp,
          timestamp,
        );

      for (const chunk of chunks) {
        const chunkId = randomUUID();
        const ocrPage = Array.isArray(parserMetadata.ocrPages)
          ? parserMetadata.ocrPages.find(
              (item) =>
                item &&
                typeof item === "object" &&
                Number((item as Record<string, unknown>).page) === chunk.page,
            )
          : null;
        this.db
          .prepare(
            `
          insert into aletheia_document_chunks (
            id, matter_id, document_id, user_id, chunk_index, page, section,
            text, quote_start, quote_end, metadata, created_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            chunkId,
            matterId,
            id,
            ownerCtx.userId,
            chunk.chunkIndex,
            chunk.page,
            chunk.section,
            chunk.text,
            chunk.quoteStart,
            chunk.quoteEnd,
            json({
              ocrProvenance: ocrPage
                ? {
                    engine: parserMetadata.ocrEngine,
                    page: chunk.page,
                    confidence: Number(
                      (ocrPage as Record<string, unknown>).confidence,
                    ),
                  }
                : null,
              sensitiveMaterialFlags: sensitiveMaterialFlagsForText({
                filename: input.filename,
                text: chunk.text,
              }),
            }),
            timestamp,
          );
        this.db
          .prepare(
            `
          insert into aletheia_document_chunks_fts (
            chunk_id, matter_id, document_id, document_name, text
          )
          values (?, ?, ?, ?, ?)
        `,
          )
          .run(chunkId, matterId, id, input.filename, chunk.text);
      }

      governance.recordDlpFindings({
        matterId,
        documentId: id,
        flags: sensitiveMaterialFlags,
        filename: input.filename,
      });

      this.writeAuditEvent(ownerCtx.userId, matterId, {
        actor: "human",
        action: "document_uploaded",
        workflowVersion: "aletheia-local-v0",
        model: null,
        details: {
          actorId: access.actorId,
          independentActor: access.independent,
          documentId: id,
          filename: input.filename,
          parsedStatus,
          parseFailureReason:
            parsedStatus === "needs_ocr"
              ? "pdf_without_text_layer"
              : parsedStatus === "failed"
                ? "text_extraction_failed"
                : null,
          extractionFailureCode,
          extractionFailureDetail,
          chunkCount: chunks.length,
          parser: parserMetadata.parser ?? null,
          pageCount: parserMetadata.pageCount ?? null,
          textLayerPageCount: parserMetadata.textLayerPageCount ?? null,
          ocrPageCount: parserMetadata.ocrPageCount ?? null,
          ocrEngine: parserMetadata.ocrEngine ?? null,
          averageOcrConfidence: parserMetadata.averageOcrConfidence ?? null,
          sensitiveMaterialFlags,
          malwareScan: input.malwareScan ?? null,
          contentDisarm: contentDisarm
            ? {
                ...contentDisarm,
                derivedStoragePath: derivedFilePath,
              }
            : null,
        },
      });
      this.touchMatter(ownerCtx.userId, matterId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (existsSync(filePath)) unlinkSync(filePath);
      if (derivedFilePath && existsSync(derivedFilePath)) {
        unlinkSync(derivedFilePath);
      }
      throw error;
    }
    this.rebuildLocalSemanticIndexIfEnabled(matterId);
    return this.document(
      this.db
        .prepare(
          `select * from aletheia_matter_documents
           where id = ? and matter_id = ? and user_id = ?`,
        )
        .get(id, matterId, ownerCtx.userId),
    );
  }

  async retryMatterDocumentParse(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
  ) {
    const access = this.matterDocumentWriteAccess(ctx, matterId);
    if (!access) return null;
    const { ownerCtx } = access;
    const governance = governanceForDatabase(this.db);

    const row = this.db
      .prepare(
        `select * from aletheia_matter_documents
         where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(documentId, matterId, ownerCtx.userId) as any;
    if (!row) return null;

    const currentDocument = this.document(row);
    if (row.parsed_status === "needs_ocr" && !nativeOcrConfigured()) {
      throw new DocumentParseRetryError(
        "Document requires OCR before it can be parsed",
        "ocr_required",
        409,
        currentDocument,
      );
    }
    if (row.parsed_status !== "failed") {
      throw new DocumentParseRetryError(
        "Only documents with failed parsing can be retried",
        "document_not_retryable",
        409,
        currentDocument,
      );
    }

    const existingMetadata = parseObject(row.metadata);
    const previousAttemptCount =
      typeof existingMetadata.parseAttemptCount === "number" &&
      Number.isFinite(existingMetadata.parseAttemptCount) &&
      existingMetadata.parseAttemptCount >= 0
        ? Math.floor(existingMetadata.parseAttemptCount)
        : 0;
    const parseAttemptCount = previousAttemptCount + 1;
    const lastParseStartedAt = now();
    let succeededDocument: unknown = null;
    let parseReplacementCommitted = false;

    try {
      const documentsRoot = path.join(dataDir(), "documents");
      const originalPath = derivedDocumentStoragePath({
        documentsRoot,
        documentId: row.id,
        filename: row.name,
      });
      if (!originalPath) {
        throw new DocumentParseRetryError(
          "Stored document path cannot be derived safely",
          "document_source_integrity_failed",
          409,
        );
      }
      if (
        typeof existingMetadata.storagePath === "string" &&
        path.resolve(existingMetadata.storagePath) !==
          path.resolve(originalPath)
      ) {
        throw new DocumentParseRetryError(
          "Stored document path metadata does not match the authoritative path",
          "document_source_integrity_failed",
          409,
        );
      }
      let originalBuffer: Buffer;
      try {
        const originalStat = lstatSync(originalPath);
        if (!originalStat.isFile() || originalStat.isSymbolicLink()) {
          throw new Error("source is not a regular file");
        }
        originalBuffer = readMatterDocumentFile(originalPath);
      } catch {
        throw new DocumentParseRetryError(
          "Stored document source cannot be read safely",
          "document_source_integrity_failed",
          409,
        );
      }
      const expectedOriginalSha256 =
        typeof existingMetadata.originalSha256 === "string"
          ? existingMetadata.originalSha256.trim().toLowerCase()
          : "";
      const actualOriginalSha256 = createHash("sha256")
        .update(originalBuffer)
        .digest("hex");
      if (
        !/^[a-f0-9]{64}$/.test(expectedOriginalSha256) ||
        actualOriginalSha256 !== expectedOriginalSha256
      ) {
        throw new DocumentParseRetryError(
          "Stored document source hash does not match metadata.originalSha256",
          "document_source_integrity_failed",
          409,
        );
      }

      let parseFilename = row.name;
      let parseBuffer = originalBuffer;
      if (existingMetadata.parseSource === "cdr_pdf_derivative") {
        const contentDisarm =
          existingMetadata.contentDisarm &&
          typeof existingMetadata.contentDisarm === "object" &&
          !Array.isArray(existingMetadata.contentDisarm)
            ? (existingMetadata.contentDisarm as JsonObject)
            : {};
        const derivedFilename =
          typeof contentDisarm.derivedFilename === "string"
            ? contentDisarm.derivedFilename
            : "";
        const derivedExtension = path.extname(derivedFilename).toLowerCase();
        const derivedPath = path.join(
          documentsRoot,
          `${row.id}.cdr${derivedExtension}`,
        );
        if (
          !derivedFilename ||
          !PURGEABLE_DOCUMENT_EXTENSIONS.has(derivedExtension) ||
          typeof contentDisarm.derivedStoragePath !== "string" ||
          path.resolve(contentDisarm.derivedStoragePath) !==
            path.resolve(derivedPath)
        ) {
          throw new DocumentParseRetryError(
            "Stored CDR derivative path metadata is invalid",
            "document_source_integrity_failed",
            409,
          );
        }
        let derivedBuffer: Buffer;
        try {
          const derivedStat = lstatSync(derivedPath);
          if (!derivedStat.isFile() || derivedStat.isSymbolicLink()) {
            throw new Error("source is not a regular file");
          }
          derivedBuffer = readMatterDocumentFile(derivedPath);
        } catch {
          throw new DocumentParseRetryError(
            "Stored CDR derivative cannot be read safely",
            "document_source_integrity_failed",
            409,
          );
        }
        const expectedDerivedSha256 =
          typeof contentDisarm.derivedSha256 === "string"
            ? contentDisarm.derivedSha256.trim().toLowerCase()
            : "";
        const actualDerivedSha256 = createHash("sha256")
          .update(derivedBuffer)
          .digest("hex");
        if (
          !/^[a-f0-9]{64}$/.test(expectedDerivedSha256) ||
          actualDerivedSha256 !== expectedDerivedSha256
        ) {
          throw new DocumentParseRetryError(
            "Stored CDR derivative hash does not match metadata",
            "document_source_integrity_failed",
            409,
          );
        }
        parseFilename = derivedFilename;
        parseBuffer = derivedBuffer;
      }

      const extracted = await extractMatterDocument({
        filename: parseFilename,
        buffer: parseBuffer,
      });
      const parsedStatus = parsedStatusForUpload({
        filename: parseFilename,
        parsedText: extracted.text,
        extractionFailed: false,
      });
      if (parsedStatus === "needs_ocr") {
        throw new DocumentParseRetryError(
          "Document requires OCR before it can be parsed",
          "ocr_required",
          409,
        );
      }
      if (parsedStatus !== "parsed") {
        throw new DocumentParseRetryError(
          "Document text extraction failed during retry",
          "document_parse_retry_failed",
          422,
        );
      }

      const chunks = chunkMatterDocument(extracted.text);
      const summary = extracted.text.replace(/\s+/g, " ").trim().slice(0, 400);
      const sensitiveMaterialFlags = sensitiveMaterialFlagsForText({
        filename: row.name,
        text: extracted.text,
      });
      const lastParseCompletedAt = now();
      const metadata = {
        ...existingMetadata,
        chunkCount: chunks.length,
        parserMetadata: extracted.metadata,
        sheetCount: extracted.metadata.sheetCount ?? null,
        sectionCount: extracted.metadata.sectionCount ?? null,
        pageCount: extracted.metadata.pageCount ?? null,
        parseStatus: "parsed",
        parseFailureReason: null,
        needsOcr: false,
        sensitiveMaterialFlags,
        parseAttemptCount,
        lastParseError: null,
        lastParseStartedAt,
        lastParseCompletedAt,
      };

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `delete from aletheia_document_chunks_fts
             where matter_id = ? and document_id = ?`,
          )
          .run(matterId, documentId);
        this.db
          .prepare(
            `delete from aletheia_document_chunks
             where document_id = ? and matter_id = ? and user_id = ?`,
          )
          .run(documentId, matterId, ownerCtx.userId);

        for (const chunk of chunks) {
          const chunkId = randomUUID();
          const ocrPage = Array.isArray(extracted.metadata.ocrPages)
            ? extracted.metadata.ocrPages.find(
                (item) => item.page === chunk.page,
              )
            : null;
          this.db
            .prepare(
              `insert into aletheia_document_chunks (
                 id, matter_id, document_id, user_id, chunk_index, page,
                 section, text, quote_start, quote_end, metadata, created_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              chunkId,
              matterId,
              documentId,
              ownerCtx.userId,
              chunk.chunkIndex,
              chunk.page,
              chunk.section,
              chunk.text,
              chunk.quoteStart,
              chunk.quoteEnd,
              json({
                ocrProvenance: ocrPage
                  ? {
                      engine: extracted.metadata.ocrEngine,
                      page: chunk.page,
                      confidence: ocrPage.confidence,
                    }
                  : null,
                sensitiveMaterialFlags: sensitiveMaterialFlagsForText({
                  filename: row.name,
                  text: chunk.text,
                }),
              }),
              lastParseCompletedAt,
            );
          this.db
            .prepare(
              `insert into aletheia_document_chunks_fts (
                 chunk_id, matter_id, document_id, document_name, text
               ) values (?, ?, ?, ?, ?)`,
            )
            .run(chunkId, matterId, documentId, row.name, chunk.text);
        }

        this.db
          .prepare(
            `update aletheia_matter_documents
             set parsed_status = 'parsed', summary = ?, metadata = ?, updated_at = ?
             where id = ? and matter_id = ? and user_id = ?`,
          )
          .run(
            summary,
            json(metadata),
            lastParseCompletedAt,
            documentId,
            matterId,
            ownerCtx.userId,
          );
        governance.recordDlpFindings({
          matterId,
          documentId,
          flags: sensitiveMaterialFlags,
          filename: row.name,
        });
        this.writeAuditEvent(ownerCtx.userId, matterId, {
          actor: "human",
          action: "document_parse_retry_succeeded",
          workflowVersion: "aletheia-document-parse-retry-v1",
          model: null,
          details: {
            actorId: access.actorId,
            independentActor: access.independent,
            documentId,
            filename: row.name,
            parseAttemptCount,
            chunkCount: chunks.length,
            originalSha256: actualOriginalSha256,
            parser: extracted.metadata.parser,
            pageCount: extracted.metadata.pageCount ?? null,
            textLayerPageCount: extracted.metadata.textLayerPageCount ?? null,
            ocrPageCount: extracted.metadata.ocrPageCount ?? null,
            ocrEngine: extracted.metadata.ocrEngine ?? null,
            averageOcrConfidence:
              extracted.metadata.averageOcrConfidence ?? null,
          },
        });
        this.touchMatter(ownerCtx.userId, matterId);
        this.db.exec("COMMIT");
        parseReplacementCommitted = true;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      succeededDocument = this.document(
        this.db
          .prepare(
            `select * from aletheia_matter_documents
             where id = ? and matter_id = ? and user_id = ?`,
          )
          .get(documentId, matterId, ownerCtx.userId),
      );
    } catch (error) {
      if (parseReplacementCommitted) throw error;
      const failure =
        error instanceof DocumentParseRetryError
          ? error
          : new DocumentParseRetryError(
              error instanceof Error
                ? error.message
                : "Document parse retry failed",
              "document_parse_retry_failed",
              422,
            );
      const lastParseCompletedAt = now();
      const failedStatus =
        failure.code === "ocr_required" ? "needs_ocr" : "failed";
      const errorMessage = failure.message.slice(0, 2000);
      const metadata = {
        ...existingMetadata,
        parseStatus: failedStatus,
        parseFailureReason: failure.code,
        needsOcr: failedStatus === "needs_ocr",
        parseAttemptCount,
        lastParseError: errorMessage,
        lastParseStartedAt,
        lastParseCompletedAt,
      };

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `update aletheia_matter_documents
             set parsed_status = ?,
                 summary = case when ? = 'needs_ocr' then ? else summary end,
                 metadata = ?, updated_at = ?
             where id = ? and matter_id = ? and user_id = ?`,
          )
          .run(
            failedStatus,
            failedStatus,
            parseFailureSummary("needs_ocr"),
            json(metadata),
            lastParseCompletedAt,
            documentId,
            matterId,
            ownerCtx.userId,
          );
        this.writeAuditEvent(ownerCtx.userId, matterId, {
          actor: "human",
          action: "document_parse_retry_failed",
          workflowVersion: "aletheia-document-parse-retry-v1",
          model: null,
          details: {
            actorId: access.actorId,
            independentActor: access.independent,
            documentId,
            filename: row.name,
            parseAttemptCount,
            code: failure.code,
            error: errorMessage,
          },
        });
        this.touchMatter(ownerCtx.userId, matterId);
        this.db.exec("COMMIT");
      } catch (persistenceError) {
        this.db.exec("ROLLBACK");
        throw persistenceError;
      }

      const failedDocument = this.document(
        this.db
          .prepare(
            `select * from aletheia_matter_documents
             where id = ? and matter_id = ? and user_id = ?`,
          )
          .get(documentId, matterId, ownerCtx.userId),
      );
      throw new DocumentParseRetryError(
        failure.message,
        failure.code,
        failure.status,
        failedDocument,
      );
    }

    this.rebuildLocalSemanticIndexIfEnabled(matterId);
    return succeededDocument;
  }

  async downloadMatterOriginalDocument(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
  ): Promise<MatterOriginalDocumentDownload | null> {
    let access: ReturnType<LocalAletheiaRepository["litigationAccess"]>;
    try {
      access = this.litigationAccess(ctx, matterId, "matter.read");
    } catch (error) {
      if (
        error instanceof GovernancePolicyError &&
        error.code === "FORBIDDEN"
      ) {
        return null;
      }
      throw error;
    }
    if (!access) return null;

    const row = this.db
      .prepare(
        `select id, name, metadata from aletheia_matter_documents
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(documentId, matterId, access.ownerCtx.userId) as
      | { id: string; name: string; metadata: string }
      | undefined;
    if (!row) return null;

    const failIntegrity = (): never => {
      throw new MatterOriginalDocumentIntegrityError();
    };
    const metadata = parseObject(row.metadata);
    const mimeType = supportedOriginalDocumentMimeType(
      row.name,
      metadata.mimeType,
    );
    const documentsRoot = path.resolve(dataDir(), "documents");
    const authoritativePath = derivedDocumentStoragePath({
      documentsRoot,
      documentId: row.id,
      filename: row.name,
    });
    const extension = path.extname(row.name).toLowerCase();
    if (
      !mimeType ||
      !authoritativePath ||
      metadata.storagePath !== authoritativePath ||
      path.dirname(authoritativePath) !== documentsRoot ||
      path.basename(authoritativePath) !== `${row.id}${extension}`
    ) {
      return failIntegrity();
    }

    let bytes: Buffer;
    try {
      const rootStat = lstatSync(documentsRoot);
      const fileStat = lstatSync(authoritativePath);
      if (
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        path.dirname(realpathSync(authoritativePath)) !==
          realpathSync(documentsRoot)
      ) {
        return failIntegrity();
      }
      bytes = readMatterDocumentFile(authoritativePath);
    } catch (error) {
      if (error instanceof MatterOriginalDocumentIntegrityError) throw error;
      return failIntegrity();
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const expectedSha256 =
      typeof metadata.originalSha256 === "string"
        ? metadata.originalSha256.trim().toLowerCase()
        : "";
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256 !== expectedSha256) {
      return failIntegrity();
    }

    try {
      this.writeAuditEvent(access.ownerCtx.userId, matterId, {
        actor: "human",
        action: "matter_document_original_downloaded",
        workflowVersion: "aletheia-matter-original-download-v1",
        model: null,
        details: {
          actorId: access.actorId,
          ownerId: access.ownerCtx.userId,
          documentId: row.id,
          originalSha256: sha256,
          bytes: bytes.length,
          independentActor: access.independent,
          crossPrincipal: access.actorId !== access.ownerCtx.userId,
        },
      });
    } catch {
      throw new MatterOriginalDocumentAuditError();
    }

    return { bytes, filename: row.name, mimeType, sha256 };
  }

  async searchMatterDocuments(
    ctx: AletheiaUserContext,
    matterId: string,
    input: SearchMatterDocumentsInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const mode = searchMode(input);
    assertLocalRetrievalModeAvailable(mode);
    const query = input.query.trim();
    if (!query) return [];
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 25);

    if (mode === "semantic") {
      return this.withRetrievalDiagnostics(
        this.searchLocalSemanticIndex(matterId, query, limit),
        mode,
      );
    }

    if (mode === "hybrid") {
      return this.withRetrievalDiagnostics(
        this.mergeHybridSearchResults({
          keywordRows: this.searchKeywordRows(matterId, query, limit),
          semanticRows: this.searchLocalSemanticIndex(matterId, query, limit),
          limit,
        }),
        mode,
      );
    }

    return this.withRetrievalDiagnostics(
      this.searchKeywordRows(matterId, query, limit).map((row) =>
        this.withClaimSuggestion({
          chunk_id: row.chunk_id,
          matter_id: row.matter_id,
          document_id: row.document_id,
          document_name: row.document_name,
          text: row.text,
          chunk_index: row.chunk_index,
          page: row.page ?? null,
          section: row.section ?? null,
          quote_start: row.quote_start,
          quote_end: row.quote_end,
          ocr_provenance: parseObject(row.chunk_metadata).ocrProvenance ?? null,
          score: row.score,
          retrieval_mode: mode,
          retrieval_layers: ["sqlite_fts5"],
          semantic_index: semanticIndexConfig(),
        }),
      ),
      mode,
    );
  }

  private litigationRetrievalIndexFingerprint(
    matterId: string,
    userId: string,
  ) {
    const indexRows = this.db
      .prepare(
        `select id, document_id, chunk_index, text
           from aletheia_document_chunks
          where matter_id = ? and user_id = ?
          order by document_id asc, chunk_index asc`,
      )
      .all(matterId, userId) as Array<Record<string, unknown>>;
    return exportHash(
      indexRows.map((row) => ({
        chunkId: row.id,
        documentId: row.document_id,
        chunkIndex: row.chunk_index,
        textSha256: createHash("sha256")
          .update(String(row.text ?? ""))
          .digest("hex"),
      })),
    );
  }

  async createLitigationRetrievalManifest(
    ctx: AletheiaUserContext,
    matterId: string,
    input: { focus: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const focus = input.focus.trim().slice(0, 500);
    const ftsQuery = searchSafeFtsQuery(focus);
    if (!focus || !ftsQuery) {
      throw new LitigationValidationError(
        "Litigation retrieval diagnostics require a searchable focus.",
      );
    }
    const candidateLimit = 25;
    const candidateCount = Number(
      (
        this.db
          .prepare(
            `select count(*) as count
               from aletheia_document_chunks_fts
              where aletheia_document_chunks_fts match ?
                and matter_id = ?`,
          )
          .get(ftsQuery, matterId) as { count?: number } | undefined
      )?.count ?? 0,
    );
    if (candidateCount > candidateLimit) {
      throw new LitigationValidationError(
        `Litigation retrieval focus matched ${candidateCount} chunks; limit is ${candidateLimit}. Narrow the focus. No candidate was omitted and no run was created.`,
      );
    }
    const indexFingerprint = this.litigationRetrievalIndexFingerprint(
      matterId,
      ctx.userId,
    );
    const candidates = this.searchKeywordRows(
      matterId,
      focus,
      Math.max(candidateCount, 1),
    ).map((row, index) => ({
      rank: index + 1,
      chunkId: String(row.chunk_id),
      documentId: String(row.document_id),
      documentName: String(row.document_name),
      chunkIndex: Number(row.chunk_index),
      page: row.page == null ? null : Number(row.page),
      section: row.section == null ? null : String(row.section),
      quoteStart: Number(row.quote_start ?? 0),
      quoteEnd: Number(row.quote_end ?? 0),
      score: Number(row.score ?? 0),
      scoreDirection: "lower_is_better",
      retrievalLayers: ["sqlite_fts5"],
      textSha256: createHash("sha256")
        .update(String(row.text ?? ""))
        .digest("hex"),
    }));
    const content = {
      schemaVersion: "aletheia-litigation-retrieval-manifest-v1",
      matterId,
      focus,
      mode: "keyword",
      rankingBasis: "SQLite FTS5 BM25 keyword match",
      indexFingerprint,
      candidateLimit,
      candidateCount,
      candidateSetComplete: true,
      candidates,
      purpose: "partition_ordering_diagnostics",
      inputBinding: false,
      selectedChunkIds: [] as string[],
      omissionPolicy: "none",
      createdAt: now(),
    };
    const id = randomUUID();
    const manifestHash = exportHash(content);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_retrieval_manifests (
             id, matter_id, user_id, focus, mode, index_fingerprint,
             candidate_count, manifest_hash, content, status, created_by, created_at
           ) values (?, ?, ?, ?, 'keyword', ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          focus,
          indexFingerprint,
          candidateCount,
          manifestHash,
          json(content),
          ctx.userId,
          content.createdAt,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_retrieval_manifest_created",
        workflowVersion: "aletheia-litigation-retrieval-manifest-v1",
        model: null,
        details: {
          manifestId: id,
          manifestHash,
          focus,
          mode: "keyword",
          indexFingerprint,
          candidateCount,
          candidateSetComplete: true,
          inputBinding: false,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, status: "open", ...content, manifestHash };
  }

  async getLitigationRetrievalManifest(
    ctx: AletheiaUserContext,
    matterId: string,
    manifestId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const row = this.db
      .prepare(
        `select * from aletheia_litigation_retrieval_manifests
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(manifestId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const excerpts = this.db
      .prepare(
        `select * from aletheia_litigation_retrieval_excerpts
          where manifest_id = ? and matter_id = ? and user_id = ?
          order by rank asc`,
      )
      .all(manifestId, matterId, ctx.userId);
    let bindingEligibility:
      | { eligible: true; bindingHash: string }
      | { eligible: false; reason: string };
    try {
      const binding = this.buildLitigationReviewedExcerptInput(
        ctx,
        matterId,
        manifestId,
      );
      bindingEligibility = binding
        ? { eligible: true, bindingHash: binding.bindingHash }
        : { eligible: false, reason: "Retrieval manifest not found." };
    } catch (error) {
      bindingEligibility = {
        eligible: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      id: row.id,
      status: row.status,
      ...parseObject(row.content),
      manifestHash: row.manifest_hash,
      excerpts,
      bindingEligibility,
    };
  }

  private buildLitigationReviewedExcerptInput(
    ctx: AletheiaUserContext,
    matterId: string,
    manifestId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const manifest = this.db
      .prepare(
        `select * from aletheia_litigation_retrieval_manifests
          where id = ? and matter_id = ? and user_id = ? and status = 'open'`,
      )
      .get(manifestId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!manifest) return null;
    const manifestContent = parseObject(manifest.content);
    if (
      manifestContent.candidateSetComplete !== true ||
      manifestContent.omissionPolicy !== "none"
    ) {
      throw new LitigationValidationError(
        "Only a complete, non-truncated retrieval manifest can be bound as Agent input.",
      );
    }
    const currentIndexFingerprint = this.litigationRetrievalIndexFingerprint(
      matterId,
      ctx.userId,
    );
    if (currentIndexFingerprint !== manifest.index_fingerprint) {
      throw new LitigationValidationError(
        "Matter documents changed after retrieval. Create and review a new manifest before starting the Agent run.",
      );
    }
    const rows = this.db
      .prepare(
        `select e.*, c.text as current_chunk_text,
                c.page as current_page, c.section as current_section
           from aletheia_litigation_retrieval_excerpts e
           join aletheia_document_chunks c
             on c.id = e.chunk_id and c.matter_id = e.matter_id and c.user_id = e.user_id
          where e.manifest_id = ? and e.matter_id = ? and e.user_id = ?
            and e.status = 'confirmed'
          order by e.rank asc, e.id asc`,
      )
      .all(manifestId, matterId, ctx.userId) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      throw new LitigationValidationError(
        "At least one counsel-confirmed retrieval excerpt is required before binding retrieval to an Agent run.",
      );
    }
    const excerpts = rows.map((row) => {
      const quote = String(row.quote ?? "");
      const currentChunkText = String(row.current_chunk_text ?? "");
      const quoteSha256 = createHash("sha256").update(quote).digest("hex");
      const currentChunkSha256 = createHash("sha256")
        .update(currentChunkText)
        .digest("hex");
      if (
        !quote ||
        quoteSha256 !== row.quote_sha256 ||
        currentChunkSha256 !== row.chunk_text_sha256 ||
        quote !== currentChunkText
      ) {
        throw new LitigationValidationError(
          `Confirmed retrieval excerpt ${String(row.id)} no longer matches the current indexed source.`,
        );
      }
      return {
        id: String(row.id),
        sourceId: `retrieval-excerpt:${String(row.id)}`,
        manifestId,
        chunkId: String(row.chunk_id),
        documentId: String(row.document_id),
        documentName: String(row.document_name),
        page: row.current_page == null ? null : Number(row.current_page),
        section:
          row.current_section == null ? null : String(row.current_section),
        rank: Number(row.rank),
        quoteStart: Number(row.quote_start),
        quoteEnd: Number(row.quote_end),
        quote,
        quoteSha256,
        chunkTextSha256: String(row.chunk_text_sha256),
        decisionComment: String(row.decision_comment),
        confirmedBy: String(row.confirmed_by),
        confirmedAt: String(row.confirmed_at),
      };
    });
    const stableBinding = {
      schemaVersion: "aletheia-litigation-reviewed-excerpt-input-v1",
      matterId,
      manifestId,
      manifestHash: String(manifest.manifest_hash),
      indexFingerprint: String(manifest.index_fingerprint),
      focus: String(manifest.focus),
      candidateCount: Number(manifest.candidate_count),
      candidateSetComplete: true,
      omissionPolicy: "none",
      inputBinding: true,
      excerpts,
    };
    return {
      ...stableBinding,
      bindingHash: exportHash(stableBinding),
    };
  }

  async prepareLitigationReviewedExcerptInput(
    ctx: AletheiaUserContext,
    matterId: string,
    manifestId: string,
  ) {
    return this.buildLitigationReviewedExcerptInput(ctx, matterId, manifestId);
  }

  async createLitigationLegalAuthorityVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Record<string, unknown>,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const authorityTypes = new Set([
      "statute",
      "regulation",
      "judicial_interpretation",
      "guiding_case",
      "other",
    ]);
    const authorityType = String(input.authorityType ?? "").trim();
    const title = String(input.title ?? "")
      .trim()
      .slice(0, 500);
    const issuer = String(input.issuer ?? "")
      .trim()
      .slice(0, 500);
    const officialIdentifier = String(input.officialIdentifier ?? "")
      .trim()
      .slice(0, 500);
    const versionLabel = String(input.versionLabel ?? "")
      .trim()
      .slice(0, 200);
    const sourceReference = String(input.sourceReference ?? "")
      .trim()
      .slice(0, 2_000);
    const content = String(input.content ?? "").trim();
    const effectiveFrom = String(input.effectiveFrom ?? "").trim();
    const effectiveTo = String(input.effectiveTo ?? "").trim() || null;
    const validDate = (value: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
    if (
      !authorityTypes.has(authorityType) ||
      !title ||
      !issuer ||
      !officialIdentifier ||
      !versionLabel ||
      !sourceReference ||
      content.length < 20 ||
      content.length > 500_000 ||
      !validDate(effectiveFrom) ||
      (effectiveTo !== null &&
        (!validDate(effectiveTo) || effectiveTo < effectiveFrom))
    ) {
      throw new LitigationValidationError(
        "A legal authority version requires type, title, issuer, official identifier, version, source reference, 20-500000 characters of source text, and a valid effective date interval.",
      );
    }
    const id = randomUUID();
    const timestamp = now();
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_legal_authority_versions (
             id, matter_id, user_id, jurisdiction, authority_type, title,
             issuer, official_identifier, version_label, source_reference,
             content, content_sha256, effective_from, effective_to, status,
             created_by, created_at
           ) values (?, ?, ?, 'CN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          authorityType,
          title,
          issuer,
          officialIdentifier,
          versionLabel,
          sourceReference,
          content,
          contentSha256,
          effectiveFrom,
          effectiveTo,
          ctx.userId,
          timestamp,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_legal_authority_version_created",
        workflowVersion: "aletheia-litigation-legal-authority-v1",
        model: null,
        details: {
          authorityVersionId: id,
          authorityType,
          officialIdentifier,
          versionLabel,
          contentSha256,
          effectiveFrom,
          effectiveTo,
          sourceReference,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare(
        "select * from aletheia_litigation_legal_authority_versions where id = ?",
      )
      .get(id);
  }

  async listLitigationLegalAuthorities(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    return {
      versions: this.db
        .prepare(
          `select id, matter_id, jurisdiction, authority_type, title, issuer,
                  official_identifier, version_label, source_reference,
                  content_sha256, effective_from, effective_to, status,
                  verification_comment, verified_by, verified_at,
                  retired_by, retired_at, retirement_comment, created_by, created_at
             from aletheia_litigation_legal_authority_versions
            where matter_id = ? and user_id = ?
            order by official_identifier asc, effective_from desc, created_at desc`,
        )
        .all(matterId, ctx.userId),
      links: this.db
        .prepare(
          `select * from aletheia_litigation_position_authorities
            where matter_id = ? and user_id = ?
            order by created_at desc`,
        )
        .all(matterId, ctx.userId),
    };
  }

  async getLitigationLegalAuthorityVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    authorityVersionId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    return (
      this.db
        .prepare(
          `select * from aletheia_litigation_legal_authority_versions
            where id = ? and matter_id = ? and user_id = ?`,
        )
        .get(authorityVersionId, matterId, ctx.userId) ?? null
    );
  }

  async verifyLitigationLegalAuthorityVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    authorityVersionId: string,
    input: { comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Verifying a legal authority version requires a 10-2000 character source-check comment.",
      );
    }
    const row = this.db
      .prepare(
        `select * from aletheia_litigation_legal_authority_versions
          where id = ? and matter_id = ? and user_id = ? and status = 'draft'`,
      )
      .get(authorityVersionId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const contentSha256 = createHash("sha256")
      .update(String(row.content))
      .digest("hex");
    if (contentSha256 !== row.content_sha256) {
      throw new LitigationValidationError(
        "Legal authority source text no longer matches its immutable content hash.",
      );
    }
    const overlapping = this.db
      .prepare(
        `select id from aletheia_litigation_legal_authority_versions
          where matter_id = ? and user_id = ? and official_identifier = ?
            and status = 'verified' and id <> ?
            and effective_from <= coalesce(?, '9999-12-31')
            and coalesce(effective_to, '9999-12-31') >= ?
          limit 1`,
      )
      .get(
        matterId,
        ctx.userId,
        row.official_identifier,
        authorityVersionId,
        row.effective_to,
        row.effective_from,
      );
    if (overlapping) {
      throw new LitigationValidationError(
        "This legal authority effective interval overlaps another verified version with the same official identifier.",
      );
    }
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_legal_authority_versions
              set status = 'verified', verification_comment = ?,
                  verified_by = ?, verified_at = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'draft'`,
        )
        .run(
          comment,
          ctx.userId,
          timestamp,
          authorityVersionId,
          matterId,
          ctx.userId,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_legal_authority_version_verified",
        workflowVersion: "aletheia-litigation-legal-authority-v1",
        model: null,
        details: {
          authorityVersionId,
          contentSha256,
          comment,
          effectiveFrom: row.effective_from,
          effectiveTo: row.effective_to,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const verifiedAuthority = this.db
      .prepare(
        "select * from aletheia_litigation_legal_authority_versions where id = ?",
      )
      .get(authorityVersionId);
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return verifiedAuthority;
  }

  async retireLitigationLegalAuthorityVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    authorityVersionId: string,
    input: { comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Retiring a legal authority version requires a 10-2000 character reason.",
      );
    }
    const row = this.db
      .prepare(
        `select * from aletheia_litigation_legal_authority_versions
          where id = ? and matter_id = ? and user_id = ? and status = 'verified'`,
      )
      .get(authorityVersionId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_legal_authority_versions
              set status = 'retired', retired_by = ?, retired_at = ?,
                  retirement_comment = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'verified'`,
        )
        .run(
          ctx.userId,
          timestamp,
          comment,
          authorityVersionId,
          matterId,
          ctx.userId,
        );
      const retiredCourtCalendars = this.db
        .prepare(
          `update aletheia_litigation_court_calendar_versions
              set status = 'retired', retired_by = ?, retired_at = ?,
                  retirement_comment = ?
            where matter_id = ? and user_id = ? and source_authority_version_id = ?
              and status in ('draft', 'verified')`,
        )
        .run(
          ctx.userId,
          timestamp,
          `Source authority retired: ${comment}`,
          matterId,
          ctx.userId,
          authorityVersionId,
        );
      const retiredRules = this.db
        .prepare(
          `update aletheia_litigation_deadline_rules
              set status = 'retired', retired_by = ?, retired_at = ?,
                  retirement_comment = ?
            where matter_id = ? and user_id = ?
              and (authority_version_id = ? or court_calendar_version_id in (
                select id from aletheia_litigation_court_calendar_versions
                 where matter_id = ? and user_id = ? and source_authority_version_id = ?
              ))
              and status in ('draft', 'verified')`,
        )
        .run(
          ctx.userId,
          timestamp,
          `Authority retired: ${comment}`,
          matterId,
          ctx.userId,
          authorityVersionId,
          matterId,
          ctx.userId,
          authorityVersionId,
        );
      const invalidatedDeadlines = this.db
        .prepare(
          `update aletheia_litigation_deadlines
              set stale_at = ?, stale_reason = ?, updated_at = ?
            where matter_id = ? and user_id = ? and stale_at is null
              and (json_extract(metadata, '$.authorityVersionId') = ?
                or court_calendar_version_id in (
                  select id from aletheia_litigation_court_calendar_versions
                   where matter_id = ? and user_id = ? and source_authority_version_id = ?
                ))`,
        )
        .run(
          timestamp,
          `Legal authority version retired: ${comment}`,
          timestamp,
          matterId,
          ctx.userId,
          authorityVersionId,
          matterId,
          ctx.userId,
          authorityVersionId,
        );
      const invalidatedTasks = this.db
        .prepare(
          `update aletheia_tasks
              set invalidated_at = ?, invalidated_reason = ?, updated_at = ?
            where matter_id = ? and user_id = ? and invalidated_at is null
              and source_deadline_id in (
                select id from aletheia_litigation_deadlines
                 where matter_id = ? and user_id = ?
                   and (json_extract(metadata, '$.authorityVersionId') = ?
                     or court_calendar_version_id in (
                       select id from aletheia_litigation_court_calendar_versions
                        where matter_id = ? and user_id = ? and source_authority_version_id = ?
                     ))
              )`,
        )
        .run(
          timestamp,
          `Source deadline authority retired: ${comment}`,
          timestamp,
          matterId,
          ctx.userId,
          matterId,
          ctx.userId,
          authorityVersionId,
          matterId,
          ctx.userId,
          authorityVersionId,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_legal_authority_version_retired",
        workflowVersion: "aletheia-litigation-legal-authority-v1",
        model: null,
        details: {
          authorityVersionId,
          contentSha256: row.content_sha256,
          comment,
          retiredDeadlineRules: retiredRules.changes,
          retiredCourtCalendars: retiredCourtCalendars.changes,
          invalidatedDeadlines: invalidatedDeadlines.changes,
          invalidatedTasks: invalidatedTasks.changes,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const retiredAuthority = this.db
      .prepare(
        "select * from aletheia_litigation_legal_authority_versions where id = ?",
      )
      .get(authorityVersionId);
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return retiredAuthority;
  }

  async linkLitigationPositionAuthority(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Record<string, unknown>,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const claimId = String(input.claimId ?? "").trim();
    const authorityVersionId = String(input.authorityVersionId ?? "").trim();
    const applicabilityDate = String(input.applicabilityDate ?? "").trim();
    const provisionReference = String(input.provisionReference ?? "")
      .trim()
      .slice(0, 500);
    const exactQuote = String(input.exactQuote ?? "").trim();
    const rationale = String(input.rationale ?? "").trim();
    if (
      !claimId ||
      !authorityVersionId ||
      !/^\d{4}-\d{2}-\d{2}$/.test(applicabilityDate) ||
      !provisionReference ||
      exactQuote.length < 5 ||
      exactQuote.length > 8_000 ||
      rationale.length < 10 ||
      rationale.length > 2_000
    ) {
      throw new LitigationValidationError(
        "Linking legal authority requires a position, verified version, applicability date, provision reference, exact quote, and a 10-2000 character rationale.",
      );
    }
    const claim = this.db
      .prepare(
        `select id, status from aletheia_litigation_claims
          where id = ? and matter_id = ? and user_id = ?
            and status in ('proposed', 'confirmed')`,
      )
      .get(claimId, matterId, ctx.userId);
    if (!claim) {
      throw new LitigationValidationError(
        "Legal authority can be linked only to a proposed or confirmed legal position in this matter.",
      );
    }
    const authority = this.db
      .prepare(
        `select * from aletheia_litigation_legal_authority_versions
          where id = ? and matter_id = ? and user_id = ? and status = 'verified'`,
      )
      .get(authorityVersionId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!authority) {
      throw new LitigationValidationError(
        "Legal authority must be verified and matter-scoped before it can support a position.",
      );
    }
    if (
      applicabilityDate < String(authority.effective_from) ||
      (authority.effective_to &&
        applicabilityDate > String(authority.effective_to))
    ) {
      throw new LitigationValidationError(
        "The selected legal authority version was not effective on the applicability date.",
      );
    }
    const content = String(authority.content);
    if (!content.includes(exactQuote)) {
      throw new LitigationValidationError(
        "The legal authority quote must match the stored source text exactly.",
      );
    }
    if (
      createHash("sha256").update(content).digest("hex") !==
      authority.content_sha256
    ) {
      throw new LitigationValidationError(
        "Legal authority source text no longer matches its immutable content hash.",
      );
    }
    const id = randomUUID();
    const timestamp = now();
    const quoteSha256 = createHash("sha256").update(exactQuote).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_position_authorities (
             id, matter_id, user_id, claim_id, authority_version_id,
             applicability_date, provision_reference, exact_quote,
             quote_sha256, rationale, status, created_by, created_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          claimId,
          authorityVersionId,
          applicabilityDate,
          provisionReference,
          exactQuote,
          quoteSha256,
          rationale,
          ctx.userId,
          timestamp,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_position_legal_authority_linked",
        workflowVersion: "aletheia-litigation-legal-authority-v1",
        model: null,
        details: {
          positionAuthorityId: id,
          claimId,
          authorityVersionId,
          applicabilityDate,
          provisionReference,
          quoteSha256,
          authorityContentSha256: authority.content_sha256,
          rationale,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const result = this.db
      .prepare(
        "select * from aletheia_litigation_position_authorities where id = ?",
      )
      .get(id);
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async withdrawLitigationPositionAuthority(
    ctx: AletheiaUserContext,
    matterId: string,
    positionAuthorityId: string,
    input: { comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Withdrawing a position authority requires a 10-2000 character reason.",
      );
    }
    const row = this.db
      .prepare(
        `select * from aletheia_litigation_position_authorities
          where id = ? and matter_id = ? and user_id = ? and status = 'active'`,
      )
      .get(positionAuthorityId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_position_authorities
              set status = 'withdrawn', withdrawn_by = ?, withdrawn_at = ?,
                  withdrawal_comment = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'active'`,
        )
        .run(
          ctx.userId,
          timestamp,
          comment,
          positionAuthorityId,
          matterId,
          ctx.userId,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_position_legal_authority_withdrawn",
        workflowVersion: "aletheia-litigation-legal-authority-v1",
        model: null,
        details: {
          positionAuthorityId,
          claimId: row.claim_id,
          authorityVersionId: row.authority_version_id,
          quoteSha256: row.quote_sha256,
          comment,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const result = this.db
      .prepare(
        "select * from aletheia_litigation_position_authorities where id = ?",
      )
      .get(positionAuthorityId);
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  private courtCalendarVersionHash(row: Record<string, unknown>) {
    const overrides = this.db
      .prepare(
        `select local_date, disposition, source_reference
           from aletheia_litigation_court_calendar_day_overrides
          where calendar_version_id = ? and matter_id = ? and user_id = ?
          order by local_date asc`,
      )
      .all(row.id, row.matter_id, row.user_id) as Array<
      Record<string, unknown>
    >;
    return exportHash({
      calendarId: row.calendar_id,
      matterId: row.matter_id,
      jurisdiction: row.jurisdiction,
      courtIdentifier: row.court_identifier,
      timezone: row.timezone,
      version: row.version,
      versionLabel: row.version_label,
      supersedesVersionId: row.supersedes_version_id ?? null,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      weeklyNonWorkingDays: JSON.parse(String(row.weekly_non_working_days)),
      sourceAuthorityVersionId: row.source_authority_version_id,
      sourceContentSha256: row.source_content_sha256,
      overrides: overrides.map((item) => ({
        localDate: item.local_date,
        disposition: item.disposition,
        sourceReference: item.source_reference,
      })),
    });
  }

  async createLitigationCourtCalendarVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Record<string, unknown>,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const courtIdentifier = String(input.courtIdentifier ?? "")
      .trim()
      .slice(0, 300);
    const name = String(input.name ?? "")
      .trim()
      .slice(0, 500);
    const versionLabel = String(input.versionLabel ?? "")
      .trim()
      .slice(0, 300);
    const sourceAuthorityVersionId = String(
      input.sourceAuthorityVersionId ?? "",
    ).trim();
    const effectiveFrom = String(input.effectiveFrom ?? "").trim();
    const effectiveTo = String(input.effectiveTo ?? "").trim();
    const validDate = (value: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    const weeklyNonWorkingDays = Array.isArray(input.weeklyNonWorkingDays)
      ? [...new Set(input.weeklyNonWorkingDays.map(Number))].sort(
          (a, b) => a - b,
        )
      : [];
    const rawOverrides = Array.isArray(input.overrides) ? input.overrides : [];
    if (
      !courtIdentifier ||
      !name ||
      !versionLabel ||
      !sourceAuthorityVersionId ||
      !validDate(effectiveFrom) ||
      !validDate(effectiveTo) ||
      effectiveFrom > effectiveTo ||
      weeklyNonWorkingDays.length < 1 ||
      weeklyNonWorkingDays.length > 6 ||
      weeklyNonWorkingDays.some(
        (day) => !Number.isSafeInteger(day) || day < 0 || day > 6,
      ) ||
      rawOverrides.length > 1_000
    ) {
      throw new LitigationValidationError(
        "A court calendar version requires a named court, bounded effective interval, verified source, and 1-6 weekly non-working weekdays.",
      );
    }
    const overrides = rawOverrides.map((value) => {
      const item = (value ?? {}) as Record<string, unknown>;
      return {
        localDate: String(item.localDate ?? "").trim(),
        disposition: String(item.disposition ?? "").trim(),
        sourceReference: String(item.sourceReference ?? "")
          .trim()
          .slice(0, 1_000),
      };
    });
    if (
      new Set(overrides.map((item) => item.localDate)).size !==
        overrides.length ||
      overrides.some(
        (item) =>
          !validDate(item.localDate) ||
          item.localDate < effectiveFrom ||
          item.localDate > effectiveTo ||
          !new Set(["open", "closed"]).has(item.disposition) ||
          item.sourceReference.length < 5,
      )
    ) {
      throw new LitigationValidationError(
        "Court calendar overrides require unique in-range dates, open/closed disposition, and a source reference.",
      );
    }
    overrides.sort((left, right) =>
      left.localDate.localeCompare(right.localDate),
    );
    const authority = this.db
      .prepare(
        `select * from aletheia_litigation_legal_authority_versions
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(sourceAuthorityVersionId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (
      !authority ||
      createHash("sha256")
        .update(String(authority.content ?? ""))
        .digest("hex") !== authority.content_sha256
    ) {
      throw new LitigationValidationError(
        "The court calendar source authority is missing or failed its content hash check.",
      );
    }
    const timestamp = now();
    let calendar = this.db
      .prepare(
        `select * from aletheia_litigation_court_calendars
          where matter_id = ? and user_id = ? and jurisdiction = 'CN'
            and court_identifier = ?`,
      )
      .get(matterId, ctx.userId, courtIdentifier) as
      | Record<string, unknown>
      | undefined;
    const calendarId = String(calendar?.id ?? randomUUID());
    const latest = calendar
      ? (this.db
          .prepare(
            `select id, version from aletheia_litigation_court_calendar_versions
              where calendar_id = ? and matter_id = ? and user_id = ?
              order by version desc limit 1`,
          )
          .get(calendarId, matterId, ctx.userId) as
          | Record<string, unknown>
          | undefined)
      : undefined;
    const version = Number(latest?.version ?? 0) + 1;
    const versionId = randomUUID();
    const weeklyJson = JSON.stringify(weeklyNonWorkingDays);
    const calendarHash = exportHash({
      calendarId,
      matterId,
      jurisdiction: "CN",
      courtIdentifier,
      timezone: "Asia/Shanghai",
      version,
      versionLabel,
      supersedesVersionId: latest?.id ?? null,
      effectiveFrom,
      effectiveTo,
      weeklyNonWorkingDays,
      sourceAuthorityVersionId,
      sourceContentSha256: authority.content_sha256,
      overrides,
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!calendar) {
        this.db
          .prepare(
            `insert into aletheia_litigation_court_calendars (
               id, matter_id, user_id, jurisdiction, court_identifier, name,
               timezone, created_by, created_at
             ) values (?, ?, ?, 'CN', ?, ?, 'Asia/Shanghai', ?, ?)`,
          )
          .run(
            calendarId,
            matterId,
            ctx.userId,
            courtIdentifier,
            name,
            ctx.userId,
            timestamp,
          );
        calendar = { id: calendarId };
      }
      this.db
        .prepare(
          `insert into aletheia_litigation_court_calendar_versions (
             id, calendar_id, matter_id, user_id, version, version_label,
             supersedes_version_id, effective_from, effective_to,
             weekly_non_working_days, source_authority_version_id,
             source_content_sha256, calendar_hash, status, created_by, created_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          versionId,
          calendarId,
          matterId,
          ctx.userId,
          version,
          versionLabel,
          latest?.id ?? null,
          effectiveFrom,
          effectiveTo,
          weeklyJson,
          sourceAuthorityVersionId,
          authority.content_sha256,
          calendarHash,
          ctx.userId,
          timestamp,
        );
      const insertOverride = this.db.prepare(
        `insert into aletheia_litigation_court_calendar_day_overrides (
           id, calendar_version_id, matter_id, user_id, local_date,
           disposition, source_reference, created_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of overrides) {
        insertOverride.run(
          randomUUID(),
          versionId,
          matterId,
          ctx.userId,
          item.localDate,
          item.disposition,
          item.sourceReference,
          timestamp,
        );
      }
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_court_calendar_version_created",
        workflowVersion: "vera-court-calendar-v1",
        model: null,
        details: {
          calendarId,
          calendarVersionId: versionId,
          calendarHash,
          version,
          sourceAuthorityVersionId,
          overrideCount: overrides.length,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listLitigationCourtCalendarVersions(ctx, matterId).then(
      (items) =>
        (items as Array<Record<string, unknown>>).find(
          (item) => item.id === versionId,
        ) ?? null,
    );
  }

  async listLitigationCourtCalendarVersions(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const versions = this.db
      .prepare(
        `select v.*, c.name, c.jurisdiction, c.court_identifier, c.timezone,
                a.title as source_authority_title,
                a.official_identifier as source_authority_official_identifier,
                a.version_label as source_authority_version_label,
                a.status as source_authority_status
           from aletheia_litigation_court_calendar_versions v
           join aletheia_litigation_court_calendars c
             on c.id = v.calendar_id and c.matter_id = v.matter_id and c.user_id = v.user_id
           join aletheia_litigation_legal_authority_versions a
             on a.id = v.source_authority_version_id and a.matter_id = v.matter_id and a.user_id = v.user_id
          where v.matter_id = ? and v.user_id = ?
          order by c.name asc, v.version desc`,
      )
      .all(matterId, ctx.userId) as Array<Record<string, unknown>>;
    const overrides = this.db
      .prepare(
        `select * from aletheia_litigation_court_calendar_day_overrides
          where matter_id = ? and user_id = ? order by local_date asc`,
      )
      .all(matterId, ctx.userId) as Array<Record<string, unknown>>;
    return versions.map((version) => ({
      ...version,
      weekly_non_working_days: JSON.parse(
        String(version.weekly_non_working_days),
      ),
      overrides: overrides.filter(
        (item) => item.calendar_version_id === version.id,
      ),
    }));
  }

  async verifyLitigationCourtCalendarVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    versionId: string,
    input: { comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Verifying a court calendar requires a 10-2000 character source-check comment.",
      );
    }
    const version = this.db
      .prepare(
        `select v.*, c.jurisdiction, c.court_identifier, c.timezone,
                a.content as source_content, a.content_sha256 as current_source_sha256,
                a.effective_from as source_effective_from,
                a.effective_to as source_effective_to, a.status as source_status
           from aletheia_litigation_court_calendar_versions v
           join aletheia_litigation_court_calendars c
             on c.id = v.calendar_id and c.matter_id = v.matter_id and c.user_id = v.user_id
           join aletheia_litigation_legal_authority_versions a
             on a.id = v.source_authority_version_id and a.matter_id = v.matter_id and a.user_id = v.user_id
          where v.id = ? and v.matter_id = ? and v.user_id = ? and v.status = 'draft'`,
      )
      .get(versionId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!version) return null;
    const sourceHash = createHash("sha256")
      .update(String(version.source_content ?? ""))
      .digest("hex");
    if (
      version.source_status !== "verified" ||
      sourceHash !== version.current_source_sha256 ||
      sourceHash !== version.source_content_sha256 ||
      String(version.source_effective_from) > String(version.effective_from) ||
      (version.source_effective_to &&
        String(version.source_effective_to) < String(version.effective_to)) ||
      this.courtCalendarVersionHash(version) !== version.calendar_hash
    ) {
      throw new LitigationValidationError(
        "Court calendar verification failed because its source, effective interval, or immutable hash is invalid.",
      );
    }
    const overlap = this.db
      .prepare(
        `select id from aletheia_litigation_court_calendar_versions
          where calendar_id = ? and matter_id = ? and user_id = ?
            and id <> ? and status = 'verified'
            and effective_from <= ? and effective_to >= ? limit 1`,
      )
      .get(
        version.calendar_id,
        matterId,
        ctx.userId,
        versionId,
        version.effective_to,
        version.effective_from,
      );
    if (overlap) {
      throw new LitigationValidationError(
        "An overlapping verified court calendar version must be retired first.",
      );
    }
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_court_calendar_versions
              set status = 'verified', verification_comment = ?, verified_by = ?, verified_at = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'draft'`,
        )
        .run(comment, ctx.userId, timestamp, versionId, matterId, ctx.userId);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_court_calendar_version_verified",
        workflowVersion: "vera-court-calendar-v1",
        model: null,
        details: {
          calendarVersionId: versionId,
          calendarHash: version.calendar_hash,
          comment,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return (
      (
        (await this.listLitigationCourtCalendarVersions(
          ctx,
          matterId,
        )) as Array<Record<string, unknown>>
      ).find((item) => item.id === versionId) ?? null
    );
  }

  async retireLitigationCourtCalendarVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    versionId: string,
    input: { comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Retiring a court calendar requires a 10-2000 character reason.",
      );
    }
    const version = this.db
      .prepare(
        `select * from aletheia_litigation_court_calendar_versions
          where id = ? and matter_id = ? and user_id = ? and status in ('draft', 'verified')`,
      )
      .get(versionId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!version) return null;
    const timestamp = now();
    const staleReason = `Court calendar version retired: ${comment}`;
    let retiredRuleCount = 0;
    let invalidatedDeadlineCount = 0;
    let invalidatedTaskCount = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_court_calendar_versions
              set status = 'retired', retirement_comment = ?, retired_by = ?, retired_at = ?
            where id = ? and matter_id = ? and user_id = ? and status in ('draft', 'verified')`,
        )
        .run(comment, ctx.userId, timestamp, versionId, matterId, ctx.userId);
      const retiredRules = this.db
        .prepare(
          `update aletheia_litigation_deadline_rules
              set status = 'retired', retirement_comment = ?, retired_by = ?, retired_at = ?
            where matter_id = ? and user_id = ? and court_calendar_version_id = ?
              and status in ('draft', 'verified')`,
        )
        .run(
          staleReason,
          ctx.userId,
          timestamp,
          matterId,
          ctx.userId,
          versionId,
        );
      const invalidatedTasks = this.db
        .prepare(
          `update aletheia_tasks set invalidated_at = ?, invalidated_reason = ?, updated_at = ?
            where matter_id = ? and user_id = ? and invalidated_at is null
              and source_deadline_id in (
                select id from aletheia_litigation_deadlines
                 where matter_id = ? and user_id = ? and court_calendar_version_id = ?
              )`,
        )
        .run(
          timestamp,
          staleReason,
          timestamp,
          matterId,
          ctx.userId,
          matterId,
          ctx.userId,
          versionId,
        );
      const invalidatedDeadlines = this.db
        .prepare(
          `update aletheia_litigation_deadlines set stale_at = ?, stale_reason = ?, updated_at = ?
            where matter_id = ? and user_id = ? and court_calendar_version_id = ? and stale_at is null`,
        )
        .run(
          timestamp,
          staleReason,
          timestamp,
          matterId,
          ctx.userId,
          versionId,
        );
      retiredRuleCount = retiredRules.changes;
      invalidatedDeadlineCount = invalidatedDeadlines.changes;
      invalidatedTaskCount = invalidatedTasks.changes;
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_court_calendar_version_retired",
        workflowVersion: "vera-court-calendar-v1",
        model: null,
        details: {
          calendarVersionId: versionId,
          calendarHash: version.calendar_hash,
          comment,
          retiredRules: retiredRules.changes,
          invalidatedDeadlines: invalidatedDeadlines.changes,
          invalidatedTasks: invalidatedTasks.changes,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      calendarVersionId: versionId,
      status: "retired",
      retiredRules: retiredRuleCount,
      invalidatedDeadlines: invalidatedDeadlineCount,
      invalidatedTasks: invalidatedTaskCount,
    };
  }

  async createLitigationDeadlineRule(
    ctx: AletheiaUserContext,
    matterId: string,
    input: Record<string, unknown>,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const name = String(input.name ?? "")
      .trim()
      .slice(0, 500);
    const triggerEventType = String(input.triggerEventType ?? "")
      .trim()
      .slice(0, 200);
    const authorityVersionId = String(input.authorityVersionId ?? "").trim();
    const provisionReference = String(input.provisionReference ?? "")
      .trim()
      .slice(0, 500);
    const exactQuote = String(input.exactQuote ?? "").trim();
    const offsetDays = Number(input.offsetDays);
    const countingBasis = String(input.countingBasis ?? "").trim();
    const startPolicy = String(input.startPolicy ?? "").trim();
    const courtCalendarVersionId = String(
      input.courtCalendarVersionId ?? "",
    ).trim();
    if (
      !name ||
      !triggerEventType ||
      !authorityVersionId ||
      !provisionReference ||
      exactQuote.length < 5 ||
      exactQuote.length > 8_000 ||
      !Number.isSafeInteger(offsetDays) ||
      offsetDays < 0 ||
      offsetDays > 3_650 ||
      !new Set(["calendar_days", "business_days"]).has(countingBasis) ||
      !new Set(["same_day", "next_day"]).has(startPolicy)
    ) {
      throw new LitigationValidationError(
        "A deadline rule requires a name, trigger event type, authority version, exact provision quote, 0-3650 day offset, counting basis and start policy.",
      );
    }
    if (
      (countingBasis === "business_days" && !courtCalendarVersionId) ||
      (countingBasis === "calendar_days" && courtCalendarVersionId)
    ) {
      throw new LitigationValidationError(
        "Business-day rules require one verified court calendar version; calendar-day rules must not bind one.",
      );
    }
    const authority = this.db
      .prepare(
        `select * from aletheia_litigation_legal_authority_versions
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(authorityVersionId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!authority) {
      throw new LitigationValidationError(
        "The deadline rule authority version does not belong to this matter.",
      );
    }
    const authorityContent = String(authority.content ?? "");
    if (
      createHash("sha256").update(authorityContent).digest("hex") !==
        authority.content_sha256 ||
      !authorityContent.includes(exactQuote)
    ) {
      throw new LitigationValidationError(
        "The deadline rule quote must exactly match the hash-verified authority text.",
      );
    }
    const quoteSha256 = createHash("sha256").update(exactQuote).digest("hex");
    const courtCalendar = courtCalendarVersionId
      ? (this.db
          .prepare(
            `select v.*, c.jurisdiction, c.court_identifier, c.timezone
               from aletheia_litigation_court_calendar_versions v
               join aletheia_litigation_court_calendars c
                 on c.id = v.calendar_id and c.matter_id = v.matter_id and c.user_id = v.user_id
              where v.id = ? and v.matter_id = ? and v.user_id = ? and v.status = 'verified'`,
          )
          .get(courtCalendarVersionId, matterId, ctx.userId) as
          | Record<string, unknown>
          | undefined)
      : undefined;
    if (
      courtCalendarVersionId &&
      (!courtCalendar ||
        this.courtCalendarVersionHash(courtCalendar) !==
          courtCalendar.calendar_hash)
    ) {
      throw new LitigationValidationError(
        "The selected court calendar version is missing, unverified, or has an invalid hash.",
      );
    }
    const rulePayload = {
      matterId,
      jurisdiction: "CN",
      name,
      triggerEventType,
      authorityVersionId,
      authorityContentSha256: authority.content_sha256,
      provisionReference,
      exactQuote,
      quoteSha256,
      offsetDays,
      countingBasis,
      courtCalendarVersionId: courtCalendarVersionId || null,
      courtCalendarHash: courtCalendar?.calendar_hash ?? null,
      startPolicy,
      timezone: "Asia/Shanghai",
    };
    const ruleHash = exportHash(rulePayload);
    const id = randomUUID();
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_deadline_rules (
             id, matter_id, user_id, name, jurisdiction, trigger_event_type,
             authority_version_id, provision_reference, exact_quote,
             quote_sha256, offset_days, counting_basis, start_policy,
             court_calendar_version_id, court_calendar_hash,
             timezone, rule_hash, status, created_by, created_at
           ) values (?, ?, ?, ?, 'CN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     'Asia/Shanghai', ?, 'draft', ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          name,
          triggerEventType,
          authorityVersionId,
          provisionReference,
          exactQuote,
          quoteSha256,
          offsetDays,
          countingBasis,
          startPolicy,
          courtCalendarVersionId || null,
          courtCalendar?.calendar_hash ?? null,
          ruleHash,
          ctx.userId,
          timestamp,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_deadline_rule_created",
        workflowVersion: "aletheia-litigation-deadline-rule-v1",
        model: null,
        details: { ruleId: id, ruleHash, ...rulePayload },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare("select * from aletheia_litigation_deadline_rules where id = ?")
      .get(id);
  }

  async listLitigationDeadlineRules(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    return this.db
      .prepare(
        `select r.*, a.title as authority_title,
                a.official_identifier as authority_official_identifier,
                a.version_label as authority_version_label,
                a.content_sha256 as authority_content_sha256,
                a.effective_from as authority_effective_from,
                a.effective_to as authority_effective_to,
                a.status as authority_status
           from aletheia_litigation_deadline_rules r
           join aletheia_litigation_legal_authority_versions a
             on a.id = r.authority_version_id and a.matter_id = r.matter_id
            and a.user_id = r.user_id
          where r.matter_id = ? and r.user_id = ?
          order by r.created_at desc`,
      )
      .all(matterId, ctx.userId);
  }

  async verifyLitigationDeadlineRule(
    ctx: AletheiaUserContext,
    matterId: string,
    ruleId: string,
    input: { comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Verifying a deadline rule requires a 10-2000 character calculation-policy comment.",
      );
    }
    const rule = this.db
      .prepare(
        `select r.*, a.content as authority_content,
                a.content_sha256 as authority_content_sha256,
                a.status as authority_status
           from aletheia_litigation_deadline_rules r
           join aletheia_litigation_legal_authority_versions a
             on a.id = r.authority_version_id and a.matter_id = r.matter_id
            and a.user_id = r.user_id
          where r.id = ? and r.matter_id = ? and r.user_id = ?
            and r.status = 'draft'`,
      )
      .get(ruleId, matterId, ctx.userId) as Record<string, unknown> | undefined;
    if (!rule) return null;
    const authorityContent = String(rule.authority_content ?? "");
    const quote = String(rule.exact_quote ?? "");
    const expectedRuleHash = exportHash({
      matterId,
      jurisdiction: rule.jurisdiction,
      name: rule.name,
      triggerEventType: rule.trigger_event_type,
      authorityVersionId: rule.authority_version_id,
      authorityContentSha256: rule.authority_content_sha256,
      provisionReference: rule.provision_reference,
      exactQuote: quote,
      quoteSha256: rule.quote_sha256,
      offsetDays: rule.offset_days,
      countingBasis: rule.counting_basis,
      courtCalendarVersionId: rule.court_calendar_version_id ?? null,
      courtCalendarHash: rule.court_calendar_hash ?? null,
      startPolicy: rule.start_policy,
      timezone: rule.timezone,
    });
    if (
      rule.authority_status !== "verified" ||
      createHash("sha256").update(authorityContent).digest("hex") !==
        rule.authority_content_sha256 ||
      createHash("sha256").update(quote).digest("hex") !== rule.quote_sha256 ||
      !authorityContent.includes(quote) ||
      expectedRuleHash !== rule.rule_hash
    ) {
      throw new LitigationValidationError(
        "Deadline rule verification failed because its authority or immutable rule hash is invalid.",
      );
    }
    if (rule.counting_basis === "business_days") {
      const courtCalendar = this.db
        .prepare(
          `select v.*, c.jurisdiction, c.court_identifier, c.timezone
             from aletheia_litigation_court_calendar_versions v
             join aletheia_litigation_court_calendars c
               on c.id = v.calendar_id and c.matter_id = v.matter_id and c.user_id = v.user_id
            where v.id = ? and v.matter_id = ? and v.user_id = ? and v.status = 'verified'`,
        )
        .get(rule.court_calendar_version_id, matterId, ctx.userId) as
        | Record<string, unknown>
        | undefined;
      if (
        !courtCalendar ||
        courtCalendar.calendar_hash !== rule.court_calendar_hash ||
        this.courtCalendarVersionHash(courtCalendar) !==
          courtCalendar.calendar_hash
      ) {
        throw new LitigationValidationError(
          "Business-day rule verification requires the exact verified court calendar version and hash.",
        );
      }
    }
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_deadline_rules
              set status = 'verified', verification_comment = ?,
                  verified_by = ?, verified_at = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'draft'`,
        )
        .run(comment, ctx.userId, timestamp, ruleId, matterId, ctx.userId);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_deadline_rule_verified",
        workflowVersion: "aletheia-litigation-deadline-rule-v1",
        model: null,
        details: { ruleId, ruleHash: rule.rule_hash, comment },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare("select * from aletheia_litigation_deadline_rules where id = ?")
      .get(ruleId);
  }

  async retireLitigationDeadlineRule(
    ctx: AletheiaUserContext,
    matterId: string,
    ruleId: string,
    input: { comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Retiring a deadline rule requires a 10-2000 character reason.",
      );
    }
    const rule = this.db
      .prepare(
        `select * from aletheia_litigation_deadline_rules
          where id = ? and matter_id = ? and user_id = ?
            and status in ('draft', 'verified')`,
      )
      .get(ruleId, matterId, ctx.userId) as Record<string, unknown> | undefined;
    if (!rule) return null;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_deadline_rules
              set status = 'retired', retired_by = ?, retired_at = ?,
                  retirement_comment = ?
            where id = ? and matter_id = ? and user_id = ?
              and status in ('draft', 'verified')`,
        )
        .run(ctx.userId, timestamp, comment, ruleId, matterId, ctx.userId);
      const invalidatedDeadlines = this.db
        .prepare(
          `update aletheia_litigation_deadlines
              set stale_at = ?, stale_reason = ?, updated_at = ?
            where matter_id = ? and user_id = ? and stale_at is null
              and json_extract(metadata, '$.deadlineRuleId') = ?`,
        )
        .run(
          timestamp,
          `Deadline rule retired: ${comment}`,
          timestamp,
          matterId,
          ctx.userId,
          ruleId,
        );
      const invalidatedTasks = this.db
        .prepare(
          `update aletheia_tasks
              set invalidated_at = ?, invalidated_reason = ?, updated_at = ?
            where matter_id = ? and user_id = ? and invalidated_at is null
              and source_deadline_id in (
                select id from aletheia_litigation_deadlines
                 where matter_id = ? and user_id = ?
                   and json_extract(metadata, '$.deadlineRuleId') = ?
              )`,
        )
        .run(
          timestamp,
          `Source deadline rule retired: ${comment}`,
          timestamp,
          matterId,
          ctx.userId,
          matterId,
          ctx.userId,
          ruleId,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_deadline_rule_retired",
        workflowVersion: "aletheia-litigation-deadline-rule-v1",
        model: null,
        details: {
          ruleId,
          ruleHash: rule.rule_hash,
          comment,
          invalidatedDeadlines: invalidatedDeadlines.changes,
          invalidatedTasks: invalidatedTasks.changes,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare("select * from aletheia_litigation_deadline_rules where id = ?")
      .get(ruleId);
  }

  async calculateLitigationDeadlineFromRule(
    ctx: AletheiaUserContext,
    matterId: string,
    ruleId: string,
    input: { eventId: string; title: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const rule = this.db
      .prepare(
        `select r.*, a.content as authority_content,
                a.content_sha256 as authority_content_sha256,
                a.effective_from as authority_effective_from,
                a.effective_to as authority_effective_to,
                a.status as authority_status
           from aletheia_litigation_deadline_rules r
           join aletheia_litigation_legal_authority_versions a
             on a.id = r.authority_version_id and a.matter_id = r.matter_id
            and a.user_id = r.user_id
          where r.id = ? and r.matter_id = ? and r.user_id = ?
            and r.status = 'verified'`,
      )
      .get(ruleId, matterId, ctx.userId) as Record<string, unknown> | undefined;
    if (!rule) return null;
    const event = this.db
      .prepare(
        `select * from aletheia_litigation_procedural_events
          where id = ? and matter_id = ? and user_id = ?
            and status = 'confirmed' and superseded_at is null`,
      )
      .get(input.eventId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!event || !event.occurred_at) {
      throw new LitigationValidationError(
        "A confirmed triggering event with an occurrence time is required.",
      );
    }
    if (event.event_type !== rule.trigger_event_type) {
      throw new LitigationValidationError(
        "The confirmed event type does not match this deadline rule.",
      );
    }
    if (
      !new Set(["calendar_days", "business_days"]).has(
        String(rule.counting_basis),
      ) ||
      rule.timezone !== "Asia/Shanghai" ||
      rule.authority_status !== "verified"
    ) {
      throw new LitigationValidationError(
        "This deadline rule cannot be calculated without its verified calendar and authority dependencies.",
      );
    }
    const occurredAt = new Date(String(event.occurred_at));
    if (Number.isNaN(occurredAt.getTime())) {
      throw new LitigationValidationError(
        "The triggering event occurrence time is invalid.",
      );
    }
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(occurredAt);
    const part = (type: string) =>
      parts.find((item) => item.type === type)?.value ?? "";
    const triggerDate = `${part("year")}-${part("month")}-${part("day")}`;
    if (
      triggerDate < String(rule.authority_effective_from) ||
      (rule.authority_effective_to &&
        triggerDate > String(rule.authority_effective_to))
    ) {
      throw new LitigationValidationError(
        "The rule authority version was not effective on the triggering event date.",
      );
    }
    const authorityContent = String(rule.authority_content ?? "");
    if (
      createHash("sha256").update(authorityContent).digest("hex") !==
        rule.authority_content_sha256 ||
      createHash("sha256").update(String(rule.exact_quote)).digest("hex") !==
        rule.quote_sha256 ||
      !authorityContent.includes(String(rule.exact_quote)) ||
      exportHash({
        matterId,
        jurisdiction: rule.jurisdiction,
        name: rule.name,
        triggerEventType: rule.trigger_event_type,
        authorityVersionId: rule.authority_version_id,
        authorityContentSha256: rule.authority_content_sha256,
        provisionReference: rule.provision_reference,
        exactQuote: rule.exact_quote,
        quoteSha256: rule.quote_sha256,
        offsetDays: rule.offset_days,
        countingBasis: rule.counting_basis,
        courtCalendarVersionId: rule.court_calendar_version_id ?? null,
        courtCalendarHash: rule.court_calendar_hash ?? null,
        startPolicy: rule.start_policy,
        timezone: rule.timezone,
      }) !== rule.rule_hash
    ) {
      throw new LitigationValidationError(
        "The rule authority source or immutable rule hash changed after verification.",
      );
    }
    const offsetDays = Number(rule.offset_days);
    let dueDate: string;
    let courtCalendar: Record<string, unknown> | null = null;
    let businessTrace: readonly unknown[] = [];
    if (rule.counting_basis === "business_days") {
      courtCalendar =
        (this.db
          .prepare(
            `select v.*, c.jurisdiction, c.court_identifier, c.timezone,
                  a.content as source_content,
                  a.content_sha256 as current_source_sha256,
                  a.status as source_status
             from aletheia_litigation_court_calendar_versions v
             join aletheia_litigation_court_calendars c
               on c.id = v.calendar_id and c.matter_id = v.matter_id and c.user_id = v.user_id
             join aletheia_litigation_legal_authority_versions a
               on a.id = v.source_authority_version_id and a.matter_id = v.matter_id and a.user_id = v.user_id
            where v.id = ? and v.matter_id = ? and v.user_id = ? and v.status = 'verified'`,
          )
          .get(rule.court_calendar_version_id, matterId, ctx.userId) as
          | Record<string, unknown>
          | undefined) ?? null;
      if (
        !courtCalendar ||
        courtCalendar.calendar_hash !== rule.court_calendar_hash ||
        this.courtCalendarVersionHash(courtCalendar) !==
          courtCalendar.calendar_hash ||
        courtCalendar.source_status !== "verified" ||
        createHash("sha256")
          .update(String(courtCalendar.source_content ?? ""))
          .digest("hex") !== courtCalendar.current_source_sha256 ||
        courtCalendar.current_source_sha256 !==
          courtCalendar.source_content_sha256
      ) {
        throw new LitigationValidationError(
          "The verified court calendar dependency changed or failed its immutable hash check.",
        );
      }
      const overrides = this.db
        .prepare(
          `select local_date, disposition
             from aletheia_litigation_court_calendar_day_overrides
            where calendar_version_id = ? and matter_id = ? and user_id = ?
            order by local_date asc`,
        )
        .all(courtCalendar.id, matterId, ctx.userId) as Array<
        Record<string, unknown>
      >;
      const result = calculateCourtCalendarBusinessDays({
        triggerDate,
        offsetDays,
        startPolicy: rule.start_policy as "same_day" | "next_day",
        weeklyNonWorkingDays: JSON.parse(
          String(courtCalendar.weekly_non_working_days),
        ) as number[],
        dateOverrides: overrides.map((item) => ({
          date: String(item.local_date),
          status: item.disposition as "open" | "closed",
        })),
        effectiveFrom: String(courtCalendar.effective_from),
        effectiveTo: String(courtCalendar.effective_to),
      });
      dueDate = result.dueDate;
      businessTrace = result.trace;
    } else {
      const elapsedDays =
        offsetDays === 0
          ? 0
          : offsetDays - (rule.start_policy === "same_day" ? 1 : 0);
      dueDate = new Date(
        Date.parse(`${triggerDate}T00:00:00.000Z`) + elapsedDays * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
    }
    const dueAt = `${dueDate}T15:59:59.000Z`;
    const calculation = [
      `Trigger ${input.eventId} occurred ${String(event.occurred_at)} (${triggerDate} Asia/Shanghai).`,
      `${String(rule.offset_days)} ${String(rule.counting_basis === "business_days" ? "court business" : "calendar")} day(s), ${String(rule.start_policy)} counting.`,
      ...(courtCalendar
        ? [
            `Court calendar ${String(courtCalendar.court_identifier)} v${String(courtCalendar.version)} (${String(courtCalendar.calendar_hash)}), algorithm ${COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION}.`,
          ]
        : []),
      `Due at local day end ${dueDate} 23:59:59 Asia/Shanghai.`,
    ].join(" ");
    const deadline = await this.createLitigationDeadline(ctx, matterId, {
      title: input.title.trim().slice(0, 1_000) || String(rule.name),
      dueAt,
      triggeringEventId: input.eventId,
      ruleLabel: String(rule.name),
      ruleVersion: String(rule.rule_hash),
      calculation,
      courtCalendarVersionId: courtCalendar ? String(courtCalendar.id) : null,
      courtCalendarHash: courtCalendar
        ? String(courtCalendar.calendar_hash)
        : null,
      createdBy: "human",
      metadata: {
        deadlineRuleId: ruleId,
        ruleHash: rule.rule_hash,
        authorityVersionId: rule.authority_version_id,
        authorityContentSha256: rule.authority_content_sha256,
        provisionReference: rule.provision_reference,
        quoteSha256: rule.quote_sha256,
        triggerDate,
        timezone: rule.timezone,
        countingBasis: rule.counting_basis,
        startPolicy: rule.start_policy,
        offsetDays,
        courtCalendarVersionId: courtCalendar?.id ?? null,
        courtCalendarHash: courtCalendar?.calendar_hash ?? null,
        courtCalendarCalculationAlgorithm: courtCalendar
          ? COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION
          : null,
        businessDayTrace: businessTrace,
      },
    });
    if (!deadline) return null;
    return deadline;
  }

  async confirmLitigationRetrievalExcerpt(
    ctx: AletheiaUserContext,
    matterId: string,
    manifestId: string,
    input: { chunkId: string; comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Confirming a retrieved excerpt requires a 10-2000 character reason.",
      );
    }
    const manifest = this.db
      .prepare(
        `select * from aletheia_litigation_retrieval_manifests
          where id = ? and matter_id = ? and user_id = ? and status = 'open'`,
      )
      .get(manifestId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!manifest) return null;
    const manifestContent = parseObject(manifest.content);
    const candidates = Array.isArray(manifestContent.candidates)
      ? (manifestContent.candidates as Array<Record<string, unknown>>)
      : [];
    const candidate = candidates.find((item) => item.chunkId === input.chunkId);
    if (!candidate) {
      throw new LitigationValidationError(
        "The selected chunk is not part of this complete retrieval manifest.",
      );
    }
    if (
      this.litigationRetrievalIndexFingerprint(matterId, ctx.userId) !==
      manifest.index_fingerprint
    ) {
      throw new LitigationValidationError(
        "Matter documents changed after retrieval. Create a new manifest before confirming excerpts.",
      );
    }
    const chunk = this.db
      .prepare(
        `select c.*, d.name as document_name
           from aletheia_document_chunks c
           join aletheia_matter_documents d
             on d.id = c.document_id and d.matter_id = c.matter_id and d.user_id = c.user_id
          where c.id = ? and c.matter_id = ? and c.user_id = ?`,
      )
      .get(input.chunkId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!chunk) return null;
    const quote = String(chunk.text ?? "");
    const chunkTextSha256 = createHash("sha256").update(quote).digest("hex");
    if (candidate.textSha256 !== chunkTextSha256) {
      throw new LitigationValidationError(
        "Retrieved chunk content changed after the manifest was created.",
      );
    }
    const existing = this.db
      .prepare(
        `select * from aletheia_litigation_retrieval_excerpts
          where manifest_id = ? and chunk_id = ? and matter_id = ? and user_id = ?`,
      )
      .get(manifestId, input.chunkId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (existing?.status === "withdrawn") {
      throw new LitigationValidationError(
        "A withdrawn excerpt cannot be reconfirmed from the same manifest. Create a new manifest.",
      );
    }
    if (existing) return existing;
    const id = randomUUID();
    const timestamp = now();
    const quoteSha256 = createHash("sha256").update(quote).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_retrieval_excerpts (
             id, manifest_id, matter_id, user_id, chunk_id, document_id,
             document_name, rank, quote_start, quote_end, quote, quote_sha256,
             chunk_text_sha256, status, decision_comment, confirmed_by, confirmed_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
        )
        .run(
          id,
          manifestId,
          matterId,
          ctx.userId,
          input.chunkId,
          chunk.document_id,
          chunk.document_name,
          Number(candidate.rank),
          Number(chunk.quote_start ?? 0),
          Number(chunk.quote_end ?? quote.length),
          quote,
          quoteSha256,
          chunkTextSha256,
          comment,
          ctx.userId,
          timestamp,
        );
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_retrieval_excerpt_confirmed",
        workflowVersion: "aletheia-litigation-retrieval-excerpt-v1",
        model: null,
        details: {
          excerptId: id,
          manifestId,
          manifestHash: manifest.manifest_hash,
          chunkId: input.chunkId,
          documentId: chunk.document_id,
          quoteSha256,
          chunkTextSha256,
          decisionComment: comment,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare(
        "select * from aletheia_litigation_retrieval_excerpts where id = ?",
      )
      .get(id);
  }

  async withdrawLitigationRetrievalExcerpt(
    ctx: AletheiaUserContext,
    matterId: string,
    excerptId: string,
    input: { comment: string },
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Withdrawing a retrieved excerpt requires a 10-2000 character reason.",
      );
    }
    const excerpt = this.db
      .prepare(
        `select * from aletheia_litigation_retrieval_excerpts
          where id = ? and matter_id = ? and user_id = ? and status = 'confirmed'`,
      )
      .get(excerptId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!excerpt) return null;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_retrieval_excerpts
              set status = 'withdrawn', withdrawn_by = ?, withdrawn_at = ?, withdrawal_comment = ?
            where id = ? and status = 'confirmed'`,
        )
        .run(ctx.userId, timestamp, comment, excerptId);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_retrieval_excerpt_withdrawn",
        workflowVersion: "aletheia-litigation-retrieval-excerpt-v1",
        model: null,
        details: {
          excerptId,
          manifestId: excerpt.manifest_id,
          chunkId: excerpt.chunk_id,
          quoteSha256: excerpt.quote_sha256,
          withdrawalComment: comment,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare(
        "select * from aletheia_litigation_retrieval_excerpts where id = ?",
      )
      .get(excerptId);
  }

  private withClaimSuggestion(row: Record<string, any>) {
    const suggestion = deriveClaimSuggestionFromText(row.text);
    return {
      ...row,
      suggested_claim_id: suggestion.claimId,
      suggested_issue_title: suggestion.issueTitle,
      claim_suggestion: suggestion,
    };
  }

  private withRetrievalDiagnostics(
    rows: Array<Record<string, any>>,
    mode: RetrievalMode,
  ) {
    return rows.map((row, index) => {
      const rank = index + 1;
      const score = Number(row.score ?? 0);
      const layers = Array.isArray(row.retrieval_layers)
        ? row.retrieval_layers.map((layer) => String(layer))
        : [];
      const explanation = retrievalExplanation({
        mode,
        rank,
        score,
        layers,
      });
      const matterId = String(row.matter_id ?? "");
      const chunkId = String(row.chunk_id ?? "");
      return {
        ...row,
        id: `retrieval:${matterId}:${chunkId}:${mode}:${rank}`,
        quote_preview: quotePreview(row.text),
        method: mode,
        ranking_basis: explanation.basis,
        retrieval_rank: rank,
        retrieval_score: score,
        retrieval_score_direction: retrievalScoreDirection(mode),
        retrieval_explanation: explanation,
      };
    });
  }

  private searchKeywordRows(matterId: string, query: string, limit: number) {
    const ftsQuery = searchSafeFtsQuery(query);
    if (!ftsQuery) return [];
    return this.db
      .prepare(
        `
        select
          f.chunk_id,
          f.matter_id,
          f.document_id,
          f.document_name,
          f.text,
          c.chunk_index,
          c.page,
          c.section,
          c.quote_start,
          c.quote_end,
          c.metadata as chunk_metadata,
          bm25(aletheia_document_chunks_fts) as score
        from aletheia_document_chunks_fts f
        join aletheia_document_chunks c on c.id = f.chunk_id
        where aletheia_document_chunks_fts match ?
          and f.matter_id = ?
        order by score
        limit ?
      `,
      )
      .all(ftsQuery, matterId, limit) as Array<Record<string, any>>;
  }

  private semanticIndexRows(matterId: string): LocalSemanticChunk[] {
    const indexPath = localSemanticIndexPath(matterId);
    if (!existsSync(indexPath)) {
      this.rebuildLocalSemanticIndex(matterId);
    }
    if (!existsSync(indexPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
        chunks?: LocalSemanticChunk[];
      };
      return Array.isArray(parsed.chunks) ? parsed.chunks : [];
    } catch {
      this.rebuildLocalSemanticIndex(matterId);
      if (!existsSync(indexPath)) return [];
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
        chunks?: LocalSemanticChunk[];
      };
      return Array.isArray(parsed.chunks) ? parsed.chunks : [];
    }
  }

  private rebuildLocalSemanticIndexIfEnabled(matterId: string) {
    const config = semanticIndexConfig();
    if (!config.enabled || config.driver !== "local-json") return;
    this.rebuildLocalSemanticIndex(matterId);
  }

  private rebuildLocalSemanticIndex(matterId: string) {
    const chunks = this.db
      .prepare(
        `
        select
          c.id as chunk_id,
          c.matter_id,
          c.document_id,
          d.name as document_name,
          c.text,
          c.chunk_index,
          c.page,
          c.section,
          c.quote_start,
          c.quote_end
        from aletheia_document_chunks c
        join aletheia_matter_documents d on d.id = c.document_id
        where c.matter_id = ?
        order by c.document_id, c.chunk_index
      `,
      )
      .all(matterId) as Array<Record<string, any>>;
    const indexedChunks = chunks.map((chunk) => {
      const vector = localSemanticVector(String(chunk.text ?? ""));
      return {
        chunk_id: String(chunk.chunk_id),
        matter_id: String(chunk.matter_id),
        document_id: String(chunk.document_id),
        document_name: String(chunk.document_name),
        text: String(chunk.text ?? ""),
        chunk_index: Number(chunk.chunk_index ?? 0),
        page: chunk.page == null ? null : Number(chunk.page),
        section: chunk.section == null ? null : String(chunk.section),
        quote_start: Number(chunk.quote_start ?? 0),
        quote_end: Number(chunk.quote_end ?? 0),
        terms: vector.terms,
        norm: vector.norm,
      } satisfies LocalSemanticChunk;
    });
    writeFileSync(
      localSemanticIndexPath(matterId),
      `${JSON.stringify(
        {
          schema_version: "aletheia-local-semantic-index-v0",
          matter_id: matterId,
          driver: "local-json",
          embedding_model: semanticIndexConfig().embedding_model,
          updated_at: now(),
          chunks: indexedChunks,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  private searchLocalSemanticIndex(
    matterId: string,
    query: string,
    limit: number,
  ) {
    const queryVector = localSemanticVector(query);
    return this.semanticIndexRows(matterId)
      .map((chunk) => ({
        chunk,
        score: localSemanticScore(queryVector, chunk),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || a.chunk.chunk_index - b.chunk.chunk_index,
      )
      .slice(0, limit)
      .map(({ chunk, score }) => ({
        chunk,
        score,
      }))
      .map(({ chunk, score }) =>
        this.withClaimSuggestion({
          chunk_id: chunk.chunk_id,
          matter_id: chunk.matter_id,
          document_id: chunk.document_id,
          document_name: chunk.document_name,
          text: chunk.text,
          chunk_index: chunk.chunk_index,
          page: chunk.page,
          section: chunk.section,
          quote_start: chunk.quote_start,
          quote_end: chunk.quote_end,
          score,
          retrieval_mode: "semantic",
          retrieval_layers: ["local_json_semantic"],
          semantic_index: semanticIndexConfig(),
        }),
      );
  }

  private mergeHybridSearchResults(args: {
    keywordRows: Array<Record<string, any>>;
    semanticRows: Array<Record<string, any>>;
    limit: number;
  }) {
    const merged = new Map<string, Record<string, any>>();
    for (const row of args.keywordRows) {
      merged.set(
        String(row.chunk_id),
        this.withClaimSuggestion({
          chunk_id: row.chunk_id,
          matter_id: row.matter_id,
          document_id: row.document_id,
          document_name: row.document_name,
          text: row.text,
          chunk_index: row.chunk_index,
          page: row.page ?? null,
          section: row.section ?? null,
          quote_start: row.quote_start,
          quote_end: row.quote_end,
          score: Math.abs(Number(row.score ?? 0)),
          retrieval_mode: "hybrid",
          retrieval_layers: ["sqlite_fts5"],
          semantic_index: semanticIndexConfig(),
        }),
      );
    }
    for (const row of args.semanticRows) {
      const existing = merged.get(String(row.chunk_id));
      if (existing) {
        existing.score = Number(existing.score ?? 0) + Number(row.score ?? 0);
        existing.retrieval_layers = ["sqlite_fts5", "local_json_semantic"];
      } else {
        merged.set(
          String(row.chunk_id),
          this.withClaimSuggestion({
            ...row,
            retrieval_mode: "hybrid",
            retrieval_layers: ["local_json_semantic"],
          }),
        );
      }
    }
    return [...merged.values()]
      .sort(
        (a, b) =>
          Number(b.score ?? 0) - Number(a.score ?? 0) ||
          Number(a.chunk_index ?? 0) - Number(b.chunk_index ?? 0),
      )
      .slice(0, args.limit);
  }

  private createInitialAgentPlan(
    userId: string,
    args: {
      matterId: string;
      template: string;
      objective: string;
      riskLevel: string | null;
    },
  ) {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `
        insert into aletheia_work_products (
          id, matter_id, user_id, kind, title, status, schema_version, content,
          validation_errors, generated_by, model, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        args.matterId,
        userId,
        "agent_plan",
        "Initial Agent Plan",
        "generated",
        "aletheia-agent-plan-v0",
        json(buildInitialAgentPlan(args)),
        "[]",
        "system",
        null,
        timestamp,
        timestamp,
      );
    this.writeAuditEvent(userId, args.matterId, {
      actor: "system",
      action: "agent_plan_generated",
      workflowVersion: "aletheia-agent-plan-v0",
      model: null,
      details: {
        workProductId: id,
        template: args.template,
        source: "deterministic_scaffold",
      },
    });
  }

  private reviewEvalFailureType(args: {
    tag: string;
    comment: string;
    resolutionStatus: ReviewResolutionStatus | "open";
  }) {
    const normalized = `${args.tag} ${args.comment} ${args.resolutionStatus}`
      .toLowerCase()
      .replace(/[_-]+/g, " ");
    if (
      normalized.includes("citation") ||
      normalized.includes("source") ||
      normalized.includes("cite")
    ) {
      return "missing_citation";
    }
    if (
      normalized.includes("risk") ||
      normalized.includes("severity") ||
      normalized.includes("level")
    ) {
      return "wrong_risk_level";
    }
    if (
      normalized.includes("unsupported") ||
      normalized.includes("overclaim") ||
      normalized.includes("support")
    ) {
      return "unsupported_claim";
    }
    return "expert_override";
  }

  private expectedReviewEvalBehavior(failureType: string) {
    if (failureType === "missing_citation") {
      return "Future drafts must attach source-linked evidence before making this claim.";
    }
    if (failureType === "wrong_risk_level") {
      return "Future risk registers must preserve the expert risk override and cite the supporting review decision.";
    }
    if (failureType === "unsupported_claim") {
      return "Future drafts must remove, qualify, or support this claim before gate approval.";
    }
    return "Future runs must satisfy this expert review before gate approval or final export.";
  }

  private upsertReviewDerivedEvalCase(args: {
    ctx: AletheiaUserContext;
    matterId: string;
    review: ReturnType<LocalAletheiaRepository["review"]>;
    auditEventId: string | null;
  }) {
    const timestamp = now();
    const failureType = this.reviewEvalFailureType({
      tag: args.review.tag,
      comment: args.review.comment,
      resolutionStatus: args.review.resolution_status,
    });
    const existing = this.db
      .prepare(
        `
        select * from aletheia_eval_cases
        where matter_id = ?
          and source_review_item_id = ?
      `,
      )
      .get(args.matterId, args.review.id);
    const inputSnapshot = {
      review_comment_id: args.review.id,
      source_audit_event_id: args.auditEventId,
      artifact_id: args.review.work_product_id ?? args.review.target_id,
      artifact_type: args.review.target_type,
      target_type: args.review.target_type,
      target_id: args.review.target_id,
      evidence_item_id: args.review.evidence_item_id,
      tag: args.review.tag,
      resolution_status: args.review.resolution_status,
      resolution_comment: args.review.resolution_comment,
    };
    const metadata = {
      schema_version: "aletheia-review-derived-eval-local-v0",
      local_only: true,
      source: "review_resolution",
      reviewer_user_id: args.review.reviewer_user_id,
      reviewer_name: args.review.reviewer_name,
      resolved_by: args.review.resolved_by,
      resolved_at: args.review.resolved_at,
    };
    if (existing) {
      this.db
        .prepare(
          `
          update aletheia_eval_cases
          set source_audit_event_id = ?,
              failure_type = ?,
              status = 'open',
              input_snapshot = ?,
              expected_behavior = ?,
              expert_feedback = ?,
              metadata = ?,
              updated_at = ?
          where id = ?
        `,
        )
        .run(
          args.auditEventId,
          failureType,
          json(inputSnapshot),
          this.expectedReviewEvalBehavior(failureType),
          args.review.resolution_comment || args.review.comment,
          json(metadata),
          timestamp,
          (existing as { id: string }).id,
        );
      return this.evalCase(
        this.db
          .prepare("select * from aletheia_eval_cases where id = ?")
          .get((existing as { id: string }).id),
      );
    }

    const id = randomUUID();
    this.db
      .prepare(
        `
        insert into aletheia_eval_cases (
          id, matter_id, user_id, source_review_item_id,
          source_audit_event_id, failure_type, status, input_snapshot,
          expected_behavior, expert_feedback, metadata, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        args.matterId,
        args.ctx.userId,
        args.review.id,
        args.auditEventId,
        failureType,
        "open",
        json(inputSnapshot),
        this.expectedReviewEvalBehavior(failureType),
        args.review.resolution_comment || args.review.comment,
        json(metadata),
        timestamp,
        timestamp,
      );
    return this.evalCase(
      this.db.prepare("select * from aletheia_eval_cases where id = ?").get(id),
    );
  }

  private createAgentRunTraceScaffold(args: {
    runId: string;
    matterId: string;
    userId: string;
    workflow: string;
    goal: string;
    timestamp: string;
  }) {
    const scaffold = buildAgentRunTraceScaffold({
      workflow: args.workflow,
      goal: args.goal,
      matterId: args.matterId,
    });
    const stepIdsByKey = new Map<string, string>();

    for (const step of scaffold.steps) {
      const stepId = randomUUID();
      stepIdsByKey.set(step.stepKey, stepId);
      const completedAt =
        step.status === "completed" || step.status === "needs_human"
          ? args.timestamp
          : null;
      this.db
        .prepare(
          `
          insert into aletheia_agent_steps (
            id, run_id, matter_id, user_id, step_key, title, sequence, status,
            input, output, validation_errors, metrics, started_at, completed_at,
            created_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          stepId,
          args.runId,
          args.matterId,
          args.userId,
          step.stepKey,
          step.title,
          step.sequence,
          step.status,
          json(step.input),
          json(step.output),
          json(step.validationErrors),
          json({ durationMs: completedAt ? 0 : null }),
          args.timestamp,
          completedAt,
          args.timestamp,
        );

      for (const call of step.toolCalls) {
        const toolCompletedAt =
          call.status === "completed" || call.status === "requires_confirmation"
            ? args.timestamp
            : null;
        this.db
          .prepare(
            `
            insert into aletheia_tool_calls (
              id, run_id, step_id, matter_id, user_id, tool_name, risk_level,
              status, input, output, error, metrics, started_at, completed_at,
              created_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            randomUUID(),
            args.runId,
            stepId,
            args.matterId,
            args.userId,
            call.toolName,
            call.riskLevel,
            call.status,
            json(call.input),
            json(call.output),
            null,
            json({ durationMs: toolCompletedAt ? 0 : null }),
            args.timestamp,
            toolCompletedAt,
            args.timestamp,
          );
      }
    }

    for (const checkpoint of scaffold.checkpoints) {
      this.db
        .prepare(
          `
          insert into aletheia_human_checkpoints (
            id, run_id, step_id, matter_id, user_id, checkpoint_type, status,
            prompt, decision, requested_payload, decision_payload, decided_by,
            decided_at, created_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          randomUUID(),
          args.runId,
          stepIdsByKey.get(checkpoint.stepKey) ?? null,
          args.matterId,
          args.userId,
          checkpoint.checkpointType,
          checkpoint.status,
          checkpoint.prompt,
          null,
          json(checkpoint.requestedPayload),
          "{}",
          null,
          null,
          args.timestamp,
        );
    }
  }

  async getLitigationWorkspace(ctx: AletheiaUserContext, matterId: string) {
    const access = this.litigationAccess(ctx, matterId, "matter.read");
    if (!access) return null;
    const workspace = this.litigation.getWorkspace(
      access.ownerCtx,
      matterId,
    ) as Record<string, any> | null;
    if (!workspace) return workspace;
    const sourceSpanIds = new Set<string>([
      ...(Array.isArray(workspace.fact_sources)
        ? workspace.fact_sources.map((source: Record<string, unknown>) => String(source.source_span_id ?? ""))
        : []),
      ...(Array.isArray(workspace.procedural_events)
        ? workspace.procedural_events.map((event: Record<string, unknown>) => String(event.primary_source_span_id ?? ""))
        : []),
    ].filter(Boolean));
    if (sourceSpanIds.size) {
      const placeholders = [...sourceSpanIds].map(() => "?").join(", ");
      const sources = this.db.prepare(
        `select s.id, s.document_id, s.document_name, s.page, s.section,
                s.quote, s.source_chunk_sha256, s.quote_sha256,
                s.chunk_quote_start, s.chunk_quote_end, c.text as current_chunk_text,
                (select v.id from aletheia_source_span_verifications v
                  where v.matter_id = s.matter_id and v.user_id = s.user_id
                    and v.source_span_id = s.id
                    and v.source_chunk_sha256 = s.source_chunk_sha256
                    and v.quote_sha256 = s.quote_sha256
                    and not exists (
                      select 1 from aletheia_source_span_verification_withdrawals w
                       where w.verification_id = v.id
                         and w.matter_id = v.matter_id and w.user_id = v.user_id
                    )
                  order by v.verified_at desc limit 1) as current_verification_id
           from aletheia_source_spans s
           join aletheia_document_chunks c
             on c.id = s.source_chunk_id and c.matter_id = s.matter_id and c.user_id = s.user_id
          where s.matter_id = ? and s.user_id = ? and s.id in (${placeholders})`,
      ).all(matterId, access.ownerCtx.userId, ...sourceSpanIds) as Array<Record<string, unknown>>;
      const sourceById = new Map(sources.map((source) => {
        const chunkText = String(source.current_chunk_text ?? "");
        const quote = chunkText.slice(
          Number(source.chunk_quote_start),
          Number(source.chunk_quote_end),
        );
        return [String(source.id), {
          document_id: source.document_id,
          document_name: source.document_name,
          page: source.page ?? null,
          section: source.section ?? null,
          quote: source.quote,
          source_chunk_sha256: source.source_chunk_sha256,
          quote_sha256: source.quote_sha256,
          current_verification_id: source.current_verification_id ?? null,
          current_quote: quote,
          current_source_chunk_sha256: createHash("sha256").update(chunkText).digest("hex"),
          current_quote_sha256: createHash("sha256").update(quote).digest("hex"),
        }];
      }));
      if (Array.isArray(workspace.fact_sources)) {
        workspace.fact_sources = workspace.fact_sources.map((source: Record<string, unknown>) => ({
          ...source,
          ...(sourceById.get(String(source.source_span_id ?? "")) ?? {}),
        }));
      }
      if (Array.isArray(workspace.procedural_events)) {
        workspace.procedural_events = workspace.procedural_events.map((event: Record<string, unknown>) => ({
          ...event,
          ...(sourceById.get(String(event.primary_source_span_id ?? "")) ?? {}),
        }));
      }
    }
    if (!Array.isArray(workspace.agent_finding_semantic_checks)) return workspace;
    const control = new LocalControlRepository({
      databasePath: path.join(dataDir(), "aletheia.db"),
    });
    try {
      const settings = control.getSettings(access.ownerCtx.userId).settings;
      const selectedModelId =
        settings.litigationModelId ?? settings.defaultModel;
      let currentStateHash: string | null = null;
      try {
        currentStateHash =
          String(
            (
              this.litigation.buildAgentSnapshot(
                access.ownerCtx,
                matterId,
              ) as Record<string, unknown> | null
            )?.stateHash ?? "",
          ) || null;
      } catch {
        currentStateHash = null;
      }
      let currentModel: ReturnType<
        Pick<LocalModelScheduler, "snapshot">["snapshot"]
      > | null = null;
      try {
        currentModel = selectedModelId
          ? this.findingEntailmentScheduler.snapshot(selectedModelId)
          : null;
      } catch {
        currentModel = null;
      }
      workspace.agent_finding_semantic_checks =
        workspace.agent_finding_semantic_checks.map(
          (check: Record<string, any>) => {
            const reasons = Array.isArray(check.stale_reasons)
              ? [...check.stale_reasons]
              : [];
            const run = this.db
              .prepare(
                "select metadata from aletheia_agent_runs where id = ? and matter_id = ? and user_id = ?",
              )
              .get(check.run_id, matterId, access.ownerCtx.userId) as
              | Record<string, unknown>
              | undefined;
            const runMetadata = run ? parseObject(run.metadata) : {};
            if (
              !currentStateHash ||
              (typeof runMetadata.stateHash === "string" &&
                runMetadata.stateHash !== currentStateHash)
            ) {
              reasons.push("snapshot_changed");
            }
            const fingerprint = currentModel
              ? localModelCalibrationFingerprint(currentModel, {
                  reasoning: settings.reasoning,
                  fastMode: settings.fastMode,
                })
              : null;
            if (
              !currentModel ||
              currentModel.id !== check.model_id ||
              currentModel.modelRevision !== check.model_revision ||
              fingerprint !== check.calibration_fingerprint
            ) {
              reasons.push("model_binding_changed");
            }
            return {
              ...check,
              stale: reasons.length > 0,
              stale_reasons: [...new Set(reasons)],
            };
          },
        );
    } finally {
      control.close();
    }
    return workspace;
  }

  async updateLitigationProfile(
    ctx: AletheiaUserContext,
    matterId: string,
    input: UpdateLitigationProfileInput,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const result = this.litigation.updateProfile(
      access.ownerCtx,
      matterId,
      input,
      (updated) => {
        this.writeAuditEvent(access.actorId, matterId, {
          actor: "human",
          action: "litigation_bundle_profile_updated",
          workflowVersion: "aletheia-hearing-bundle-profile-v1",
          model: null,
          details: {
            actorId: access.actorId,
            organizationName: updated.organization_name ?? null,
            court: updated.court ?? null,
            caseNumber: updated.case_number ?? null,
            exhibitPrefix: updated.exhibit_prefix,
            exhibitStart: updated.exhibit_start,
            paginationPolicy: updated.pagination_policy,
          },
        });
      },
      access.actorId,
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(access.ownerCtx, matterId);
    this.touchMatter(access.ownerCtx.userId, matterId);
    return result;
  }

  async importLitigationDocumentTemplate(
    ctx: AletheiaUserContext,
    matterId: string,
    input: { name: string; bytes: Buffer },
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const name = input.name.trim();
    if (!name || name.length > 160) {
      throw new LitigationValidationError(
        "Template name is required and must be at most 160 characters.",
      );
    }
    const inspection = inspectLitigationDocxTemplate(input.bytes);
    const latest = this.db
      .prepare(
        `select max(version) as version
           from aletheia_litigation_custom_templates
          where matter_id = ? and user_id = ? and name = ?`,
      )
      .get(matterId, access.ownerCtx.userId, name) as
      | { version: number | null }
      | undefined;
    const version = Number(latest?.version ?? 0) + 1;
    const id = randomUUID();
    const directory = path.join(dataDir(), "templates", matterId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    const storagePath = path.join(directory, `${id}.docx`);
    const timestamp = now();
    writeProtectedLocalFileSync({
      filePath: storagePath,
      plaintext: input.bytes,
      purpose: "source_document",
    });
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare(
          `insert into aletheia_litigation_custom_templates
            (id, matter_id, user_id, name, version, status, storage_path,
             file_sha256, file_bytes, placeholders, approval_checkpoint_id,
             approved_by, approved_at, created_by, created_at, updated_at)
           values (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, null, null, null, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          access.ownerCtx.userId,
          name,
          version,
          storagePath,
          inspection.sha256,
          inspection.bytes,
          json(inspection.placeholders),
          access.actorId,
          timestamp,
          timestamp,
        );
      await this.writeAuditEvent(access.actorId, matterId, {
        actor: "human",
        action: "litigation_template_imported",
        workflowVersion: "aletheia-litigation-template-registry-v1",
        model: null,
        details: {
          templateId: id,
          version,
          fileSha256: inspection.sha256,
          fileBytes: inspection.bytes,
          placeholders: inspection.placeholders,
          status: "draft",
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (existsSync(storagePath)) unlinkSync(storagePath);
      throw error;
    }
    return this.listLitigationDocumentTemplates(ctx, matterId).then((items) =>
      items.find((item: any) => item.id === id),
    );
  }

  async listLitigationDocumentTemplates(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.read");
    if (!access) return [];
    return (
      this.db
        .prepare(
          `select id, matter_id, name, version, status, file_sha256,
                  file_bytes, placeholders, approval_checkpoint_id,
                  approved_by, independent_approval, approved_at, created_by,
                  retirement_checkpoint_id, retired_by, retired_at,
                  created_at, updated_at
             from aletheia_litigation_custom_templates
            where matter_id = ? and user_id = ?
            order by name asc, version desc`,
        )
        .all(matterId, access.ownerCtx.userId) as Array<Record<string, any>>
    ).map((item) => ({
      ...item,
      placeholders: parseArray(item.placeholders),
      templateHash: `sha256:${item.file_sha256}`,
      source: "custom" as const,
    }));
  }

  async publishLitigationDocumentTemplate(
    ctx: AletheiaUserContext,
    matterId: string,
    templateId: string,
    checkpointId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.review");
    if (!access) return null;
    const template = this.db
      .prepare(
        `select * from aletheia_litigation_custom_templates
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(templateId, matterId, access.ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    if (!template) return null;
    if (template.status !== "draft") {
      throw new LitigationValidationError(
        "Only a draft template can be published.",
      );
    }
    const checkpoint = this.db
      .prepare(
        `select * from aletheia_human_checkpoints
          where id = ? and matter_id = ? and user_id = ?
            and checkpoint_type = 'litigation_template_publish'
            and status = 'approved'`,
      )
      .get(checkpointId, matterId, access.ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    const requested = checkpoint
      ? parseObject(checkpoint.requested_payload)
      : {};
    const decision = checkpoint ? parseObject(checkpoint.decision_payload) : {};
    const comment = String(decision.comment ?? "").trim();
    if (
      !checkpoint ||
      requested.templateId !== templateId ||
      requested.fileSha256 !== template.file_sha256 ||
      comment.length < 10
    ) {
      throw new ApprovalRequiredError(
        "Template publishing requires an approved, hash-bound checkpoint with a review reason.",
      );
    }
    const bytes = readProtectedLocalFileSync({
      filePath: String(template.storage_path),
      purpose: "source_document",
    });
    const inspection = inspectLitigationDocxTemplate(bytes);
    if (inspection.sha256 !== template.file_sha256) {
      throw new LitigationValidationError(
        "Template file changed after approval was requested.",
      );
    }
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_custom_templates
              set status = 'approved', approval_checkpoint_id = ?,
                  approved_by = ?, independent_approval = ?, approved_at = ?,
                  updated_at = ?
            where id = ? and status = 'draft'`,
        )
        .run(
          checkpointId,
          access.actorId,
          template.created_by === access.actorId ? 0 : 1,
          timestamp,
          timestamp,
          templateId,
        );
      this.db
        .prepare(
          "update aletheia_human_checkpoints set status = 'consumed' where id = ? and status = 'approved'",
        )
        .run(checkpointId);
      await this.writeAuditEvent(access.actorId, matterId, {
        actor: "human",
        action: "litigation_template_published",
        workflowVersion: "aletheia-litigation-template-registry-v1",
        model: null,
        details: {
          templateId,
          fileSha256: template.file_sha256,
          checkpointId,
          reviewReason: comment,
          independentApproval: template.created_by !== access.actorId,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return (await this.listLitigationDocumentTemplates(ctx, matterId)).find(
      (item: any) => item.id === templateId,
    );
  }

  async retireLitigationDocumentTemplate(
    ctx: AletheiaUserContext,
    matterId: string,
    templateId: string,
    checkpointId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.review");
    if (!access) return null;
    const template = this.db
      .prepare(
        `select * from aletheia_litigation_custom_templates
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(templateId, matterId, access.ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    if (!template) return null;
    if (template.status !== "approved") {
      throw new LitigationValidationError(
        "Only an approved template can be retired.",
      );
    }
    const profile = this.db
      .prepare(
        `select document_template_id from aletheia_litigation_profiles
          where matter_id = ? and user_id = ?`,
      )
      .get(matterId, access.ownerCtx.userId) as
      | { document_template_id: string }
      | undefined;
    if (profile?.document_template_id === templateId) {
      throw new LitigationValidationError(
        "Switch the matter to another approved template before retiring this version.",
      );
    }
    const checkpoint = this.db
      .prepare(
        `select * from aletheia_human_checkpoints
          where id = ? and matter_id = ? and user_id = ?
            and checkpoint_type = 'litigation_template_retire'
            and status = 'approved'`,
      )
      .get(checkpointId, matterId, access.ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    const requested = checkpoint
      ? parseObject(checkpoint.requested_payload)
      : {};
    const decision = checkpoint ? parseObject(checkpoint.decision_payload) : {};
    const comment = String(decision.comment ?? "").trim();
    if (
      !checkpoint ||
      requested.templateId !== templateId ||
      requested.fileSha256 !== template.file_sha256 ||
      comment.length < 10
    ) {
      throw new ApprovalRequiredError(
        "Template retirement requires an approved, hash-bound checkpoint with a review reason.",
      );
    }
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_custom_templates
              set status = 'retired', retirement_checkpoint_id = ?,
                  retired_by = ?, retired_at = ?, updated_at = ?
            where id = ? and status = 'approved'`,
        )
        .run(checkpointId, access.actorId, timestamp, timestamp, templateId);
      this.db
        .prepare(
          "update aletheia_human_checkpoints set status = 'consumed' where id = ? and status = 'approved'",
        )
        .run(checkpointId);
      await this.writeAuditEvent(access.actorId, matterId, {
        actor: "human",
        action: "litigation_template_retired",
        workflowVersion: "aletheia-litigation-template-registry-v1",
        model: null,
        details: {
          templateId,
          fileSha256: template.file_sha256,
          checkpointId,
          reviewReason: comment,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return (await this.listLitigationDocumentTemplates(ctx, matterId)).find(
      (item: any) => item.id === templateId,
    );
  }

  async createLitigationFact(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationFactInput,
  ) {
    const result = this.litigation.createFact(ctx, matterId, input) as Record<
      string,
      unknown
    > | null;
    if (!result) return null;
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: input.createdBy ?? "human",
      action: "litigation_fact_proposed",
      workflowVersion: "aletheia-civil-litigation-v1",
      model: null,
      details: { factId: result.id, hasSource: Boolean(input.source) },
    });
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async decideLitigationFact(
    ctx: AletheiaUserContext,
    matterId: string,
    factId: string,
    input: DecideLitigationFactInput,
  ) {
    const result = this.litigation.decideFact(
      ctx,
      matterId,
      factId,
      input,
      () => {
        this.writeAuditEvent(ctx.userId, matterId, {
          actor: "human",
          action:
            input.decision === "confirmed"
              ? "litigation_fact_confirmed"
              : "litigation_fact_rejected",
          workflowVersion: "aletheia-civil-litigation-v1",
          model: null,
          details: { factId, comment: input.comment ?? null },
        });
      },
    );
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async verifyLitigationSourceSpanOriginal(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
    reason: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const result = this.litigation.verifySourceSpanOriginal(
      access.ownerCtx,
      matterId,
      sourceSpanId,
      reason,
      access.actorId,
      (verification) => {
        this.writeAuditEvent(access.ownerCtx.userId, matterId, {
          actor: "human",
          action: "litigation_source_original_scan_verified",
          workflowVersion: "aletheia-source-verification-v1",
          model: null,
          details: {
            sourceSpanId,
            verificationId: verification.id,
            sourceChunkSha256: verification.source_chunk_sha256,
            quoteSha256: verification.quote_sha256,
            reason: verification.reason,
            actorId: access.actorId,
            ownerId: access.ownerCtx.userId,
            crossPrincipal: access.actorId !== access.ownerCtx.userId,
            independentActor: access.independent,
          },
        });
      },
    );
    if (!result) return null;
    this.touchMatter(access.ownerCtx.userId, matterId);
    return result;
  }

  async withdrawLitigationSourceSpanOriginalVerification(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
    verificationId: string,
    reason: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const result = this.litigation.withdrawSourceSpanOriginalVerification(
      access.ownerCtx,
      matterId,
      sourceSpanId,
      verificationId,
      reason,
      access.actorId,
      (withdrawal) => {
        this.writeAuditEvent(access.ownerCtx.userId, matterId, {
          actor: "human",
          action: "litigation_source_original_scan_verification_withdrawn",
          workflowVersion: "aletheia-source-verification-v1",
          model: null,
          details: {
            sourceSpanId,
            verificationId,
            withdrawalId: withdrawal.id,
            sourceChunkSha256: withdrawal.source_chunk_sha256,
            quoteSha256: withdrawal.quote_sha256,
            reason: withdrawal.reason,
            actorId: access.actorId,
            ownerId: access.ownerCtx.userId,
            crossPrincipal: access.actorId !== access.ownerCtx.userId,
            independentActor: access.independent,
          },
        });
      },
    );
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(access.ownerCtx, matterId);
    this.touchMatter(access.ownerCtx.userId, matterId);
    return result;
  }

  async listLitigationSourceSpanOriginalVerificationHistory(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.read");
    if (!access) return null;
    const history = this.litigation.listSourceSpanOriginalVerificationHistory(
      access.ownerCtx,
      matterId,
      sourceSpanId,
    );
    if (!history) return null;
    const currentVerificationIds = history
      .filter((item) => item.current)
      .map((item) => item.id);
    try {
      this.writeAuditEvent(access.ownerCtx.userId, matterId, {
        actor: "human",
        action: "litigation_source_original_scan_verification_history_read",
        workflowVersion: "aletheia-source-verification-v1",
        model: null,
        details: {
          sourceSpanId,
          historyCount: history.length,
          currentVerificationIds,
          actorId: access.actorId,
          ownerId: access.ownerCtx.userId,
          crossPrincipal: access.actorId !== access.ownerCtx.userId,
          independentActor: access.independent,
        },
      });
    } catch {
      throw new SourceOriginalVerificationHistoryAuditError();
    }
    return { source_span_id: sourceSpanId, items: history };
  }

  async createLitigationClaim(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationClaimInput,
  ) {
    const result = this.litigation.createClaim(ctx, matterId, input) as Record<
      string,
      unknown
    > | null;
    if (!result) return null;
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: input.createdBy ?? "human",
      action: "litigation_claim_proposed",
      workflowVersion: "aletheia-civil-litigation-v1",
      model: null,
      details: { claimId: result.id, kind: input.kind },
    });
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async decideLitigationClaim(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: DecideLitigationClaimInput,
  ) {
    const result = this.litigation.decideClaim(
      ctx,
      matterId,
      claimId,
      input,
      (decided) => {
        const assessment = decided.assessment as
          | Record<string, unknown>
          | undefined;
        this.writeAuditEvent(ctx.userId, matterId, {
          actor: "human",
          action:
            input.decision === "confirmed"
              ? "litigation_claim_confirmed"
              : "litigation_claim_rejected",
          workflowVersion: "aletheia-civil-litigation-v1",
          model: null,
          details: {
            claimId,
            comment: input.comment ?? null,
            assessmentId: assessment?.id ?? null,
            assessmentVersion: assessment?.version ?? null,
          },
        });
      },
    );
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async createPositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: CreatePositionReviewInput,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const result = this.litigation.createPositionReview(
      access.ownerCtx,
      matterId,
      claimId,
      input,
      (created) => {
        this.writeAuditEvent(access.actorId, matterId, {
          actor: "human",
          action: "litigation_position_review_created",
          workflowVersion: "aletheia-position-review-v1",
          model: null,
          details: {
            reviewId: created.id,
            claimId,
            kind: input.kind,
            requestedOutcome: input.requestedOutcome,
            parentReviewId: created.parent_review_id ?? null,
            reviewLevel: created.review_level ?? 1,
            independentReview: created.independent_review === 1,
            actorId: access.actorId,
          },
        });
      },
      access.actorId,
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(access.ownerCtx, matterId);
    this.touchMatter(access.ownerCtx.userId, matterId);
    return result;
  }

  async resolvePositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
    input: ResolvePositionReviewInput,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.review");
    if (!access) return null;
    const result = this.litigation.resolvePositionReview(
      access.ownerCtx,
      matterId,
      reviewId,
      input,
      (resolved) => {
        this.writeAuditEvent(access.actorId, matterId, {
          actor: "human",
          action: "litigation_position_review_resolved",
          workflowVersion: "aletheia-position-review-v1",
          model: null,
          details: {
            reviewId,
            claimId: resolved.claim_id,
            resolution: input.resolution,
            requestedOutcome: resolved.requested_outcome,
            claimStatus: resolved.claim_status,
            assessmentId: resolved.result_assessment_version_id ?? null,
            assessmentVersion: resolved.result_assessment_version ?? null,
            comment: input.comment ?? null,
            actorId: access.actorId,
            independentReview: access.independent,
          },
        });
      },
      access.actorId,
      access.independent,
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(access.ownerCtx, matterId);
    this.touchMatter(access.ownerCtx.userId, matterId);
    return result;
  }

  async withdrawPositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const result = this.litigation.withdrawPositionReview(
      access.ownerCtx,
      matterId,
      reviewId,
      (withdrawn) => {
        this.writeAuditEvent(access.actorId, matterId, {
          actor: "human",
          action: "litigation_position_review_withdrawn",
          workflowVersion: "aletheia-position-review-v1",
          model: null,
          details: { reviewId, claimId: withdrawn.claim_id },
        });
      },
      access.actorId,
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(access.ownerCtx, matterId);
    this.touchMatter(access.ownerCtx.userId, matterId);
    return result;
  }

  async createLitigationElement(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: CreateLitigationElementInput,
  ) {
    const result = this.litigation.createElement(
      ctx,
      matterId,
      claimId,
      input,
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "litigation_claim_element_created",
      workflowVersion: "aletheia-civil-litigation-v1",
      model: null,
      details: { claimId, elementId: result.id },
    });
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async decideLitigationElement(
    ctx: AletheiaUserContext,
    matterId: string,
    elementId: string,
    input: DecideLitigationElementInput,
  ) {
    const result = this.litigation.decideElement(
      ctx,
      matterId,
      elementId,
      input,
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action:
        input.decision === "confirmed"
          ? "litigation_claim_element_confirmed"
          : "litigation_claim_element_rejected",
      workflowVersion: "aletheia-civil-litigation-v1",
      model: null,
      details: { elementId, comment: input.comment ?? null },
    });
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async linkLitigationElementFact(
    ctx: AletheiaUserContext,
    matterId: string,
    elementId: string,
    input: LinkElementFactInput,
  ) {
    const result = this.litigation.linkElementFact(
      ctx,
      matterId,
      elementId,
      input,
      (linked) => {
        this.writeAuditEvent(ctx.userId, matterId, {
          actor: "human",
          action: "litigation_element_fact_linked",
          workflowVersion: "aletheia-civil-litigation-v1",
          model: null,
          details: {
            linkId: linked.id,
            elementId,
            factId: input.factId,
            relation: input.relation,
          },
        });
      },
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async createLitigationProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateProceduralEventInput,
  ) {
    const result = this.litigation.createProceduralEvent(
      ctx,
      matterId,
      input,
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: input.createdBy ?? "human",
      action: "litigation_procedural_event_proposed",
      workflowVersion: "aletheia-civil-litigation-v1",
      model: null,
      details: {
        eventId: result.id,
        eventType: input.eventType,
        hasSource: Boolean(input.source),
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async decideLitigationProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    eventId: string,
    input: DecideProceduralEventInput,
  ) {
    const result = this.litigation.decideProceduralEvent(
      ctx,
      matterId,
      eventId,
      input,
    ) as Record<string, unknown> | null;
    if (!result) return null;
    await this.appendAuditEvent(ctx, matterId, {
      actor: "human",
      action:
        input.decision === "confirmed"
          ? "litigation_procedural_event_confirmed"
          : "litigation_procedural_event_rejected",
      workflowVersion: "aletheia-civil-litigation-v1",
      model: null,
      details: { eventId, comment: input.comment ?? null },
    });
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async correctLitigationProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    eventId: string,
    input: CorrectProceduralEventInput,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const result = this.litigation.correctProceduralEvent(
      access.ownerCtx,
      matterId,
      eventId,
      input,
      (correction) => {
        const replacement = correction.replacement as Record<string, unknown>;
        this.writeAuditEvent(access.actorId, matterId, {
          actor: "human",
          action: "litigation_procedural_event_corrected",
          workflowVersion: "vera-procedural-event-correction-v1",
          model: null,
          details: {
            correctionId: correction.correctionId,
            correctionHash: correction.correctionHash,
            originalEventId: correction.originalEventId,
            replacementEventId: replacement.id,
            fromOccurredAt: correction.fromOccurredAt,
            toOccurredAt: correction.toOccurredAt,
            reason: input.reason.trim(),
            invalidatedDeadlines: correction.invalidatedDeadlines,
            invalidatedTasks: correction.invalidatedTasks,
            actorId: access.actorId,
          },
        });
        this.touchMatter(access.ownerCtx.userId, matterId);
      },
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.refreshLitigationArtifactStaleness(access.ownerCtx, matterId);
    return result;
  }

  async createLitigationDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateDeadlineCandidateInput,
  ) {
    const result = this.litigation.createDeadline(
      ctx,
      matterId,
      input,
      (created) => {
        const ruleId = String(input.metadata?.deadlineRuleId ?? "");
        this.writeAuditEvent(ctx.userId, matterId, {
          actor: input.createdBy ?? "human",
          action: ruleId
            ? "litigation_deadline_calculated_from_verified_rule"
            : "litigation_deadline_proposed",
          workflowVersion: ruleId
            ? "aletheia-litigation-deadline-rule-v1"
            : "aletheia-civil-litigation-v1",
          model: null,
          details: {
            deadlineId: created.id,
            dueAt: input.dueAt,
            ruleVersion: input.ruleVersion,
            hasSource: Boolean(input.source),
            ...(ruleId
              ? {
                  ruleId,
                  ruleHash: input.metadata?.ruleHash,
                  authorityVersionId: input.metadata?.authorityVersionId,
                  eventId: input.triggeringEventId,
                  triggerDate: input.metadata?.triggerDate,
                  courtCalendarVersionId: input.courtCalendarVersionId ?? null,
                  courtCalendarHash: input.courtCalendarHash ?? null,
                  calculation: input.calculation,
                }
              : {}),
          },
        });
      },
    ) as Record<string, unknown> | null;
    if (!result) return null;
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async decideLitigationDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    deadlineId: string,
    input: DecideDeadlineCandidateInput,
  ) {
    const result = this.litigation.decideDeadline(
      ctx,
      matterId,
      deadlineId,
      input,
    );
    if (!result) return null;
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action:
        input.decision === "confirmed"
          ? "litigation_deadline_confirmed"
          : "litigation_deadline_rejected",
      workflowVersion: "aletheia-civil-litigation-v1",
      model: null,
      details: { deadlineId, comment: input.comment ?? null },
    });
    this.refreshLitigationArtifactStaleness(ctx, matterId);
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async createTaskFromLitigationDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    deadlineId: string,
    input: CreateTaskFromDeadlineInput,
  ) {
    const result = this.litigation.createTaskFromDeadline(
      ctx,
      matterId,
      deadlineId,
      input,
    ) as { task: Record<string, unknown>; created: boolean } | null;
    if (!result) return null;
    if (result.created) {
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_deadline_task_created",
        workflowVersion: "aletheia-civil-litigation-v1",
        model: null,
        details: {
          taskId: result.task.id,
          sourceDeadlineId: deadlineId,
          dueAt: result.task.due_at,
          priority: result.task.priority,
        },
      });
      this.touchMatter(ctx.userId, matterId);
    }
    return result;
  }

  async listTasks(
    ctx: AletheiaUserContext,
    status: LitigationTaskStatusFilter,
  ) {
    return this.litigation.listTasks(ctx, status);
  }

  async claimTaskNotifications(ctx: AletheiaUserContext) {
    const current = new Date();
    const nowIso = current.toISOString();
    const localDate = [
      current.getFullYear(),
      String(current.getMonth() + 1).padStart(2, "0"),
      String(current.getDate()).padStart(2, "0"),
    ].join("-");
    const horizon = new Date(
      current.valueOf() + 24 * 60 * 60 * 1000,
    ).toISOString();
    const staleClaim = new Date(
      current.valueOf() - 10 * 60 * 1000,
    ).toISOString();
    const withdrawals: Array<Record<string, unknown>> = [];
    const claims: Array<Record<string, unknown>> = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const obsolete = this.db
        .prepare(
          `select d.*, t.status as task_status, t.due_at as current_due_at,
                  t.invalidated_at as task_invalidated_at
             from aletheia_task_notification_deliveries d
             join aletheia_tasks t on t.id = d.task_id and t.user_id = d.user_id
            where d.user_id = ? and d.status in ('claimed', 'delivered', 'failed')
              and (t.status <> 'open' or t.due_at <> d.due_at_snapshot
                   or t.invalidated_at is not null)`,
        )
        .all(ctx.userId) as Array<Record<string, unknown>>;
      for (const row of obsolete) {
        this.db
          .prepare(
            `update aletheia_task_notification_deliveries
                set status = 'withdrawn', lease_token = null,
                    withdrawn_at = ?, updated_at = ?
              where id = ? and user_id = ?`,
          )
          .run(nowIso, nowIso, row.id, ctx.userId);
        this.writeAuditEvent(ctx.userId, String(row.matter_id), {
          actor: "system",
          action: "task_notification_withdrawn",
          workflowVersion: "aletheia-task-notification-v1",
          model: null,
          details: {
            deliveryId: row.id,
            taskId: row.task_id,
            tag: row.tag,
            reason: row.task_invalidated_at
              ? "deadline_invalidated"
              : row.task_status !== "open"
                ? "task_closed"
                : "due_at_changed",
          },
        });
        withdrawals.push({
          deliveryId: row.id,
          taskId: row.task_id,
          tag: row.tag,
        });
      }

      const candidates = this.db
        .prepare(
          `select t.*, m.title as matter_title
             from aletheia_tasks t
             join aletheia_matters m
               on m.id = t.matter_id
              and m.user_id = t.user_id
              and m.template = 'civil_litigation'
            where t.user_id = ? and t.status = 'open'
              and t.invalidated_at is null and t.due_at <= ?
            order by t.due_at asc, t.id asc limit 25`,
        )
        .all(ctx.userId, horizon) as Array<Record<string, unknown>>;
      for (const task of candidates) {
        if (claims.length >= 3) break;
        const category = String(task.due_at) < nowIso ? "overdue" : "due_soon";
        const tag = `deadline-${task.id}-${category.replace("_", "-")}-${localDate}`;
        const existing = this.db
          .prepare(
            `select * from aletheia_task_notification_deliveries
              where user_id = ? and task_id = ? and category = ? and local_date = ?`,
          )
          .get(ctx.userId, task.id, category, localDate) as
          | Record<string, unknown>
          | undefined;
        const sameDue = existing?.due_at_snapshot === task.due_at;
        if (
          sameDue &&
          (existing?.status === "delivered" ||
            (existing?.status === "claimed" &&
              String(existing.claimed_at) > staleClaim) ||
            Number(existing?.attempt_count ?? 0) >= 5)
        ) {
          continue;
        }
        const id = existing ? String(existing.id) : randomUUID();
        const leaseToken = randomUUID();
        const attemptCount = sameDue
          ? Number(existing?.attempt_count ?? 0) + 1
          : 1;
        if (existing) {
          this.db
            .prepare(
              `update aletheia_task_notification_deliveries
                  set due_at_snapshot = ?, tag = ?, status = 'claimed',
                      lease_token = ?, attempt_count = ?, failure_code = null,
                      claimed_at = ?, delivered_at = null, withdrawn_at = null,
                      updated_at = ?
                where id = ? and user_id = ?`,
            )
            .run(
              task.due_at,
              tag,
              leaseToken,
              attemptCount,
              nowIso,
              nowIso,
              id,
              ctx.userId,
            );
        } else {
          this.db
            .prepare(
              `insert into aletheia_task_notification_deliveries
                (id, task_id, matter_id, user_id, category, local_date,
                 due_at_snapshot, tag, status, lease_token, attempt_count,
                 claimed_at, updated_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, 1, ?, ?)`,
            )
            .run(
              id,
              task.id,
              task.matter_id,
              ctx.userId,
              category,
              localDate,
              task.due_at,
              tag,
              leaseToken,
              nowIso,
              nowIso,
            );
        }
        claims.push({
          deliveryId: id,
          leaseToken,
          tag,
          category,
          taskId: task.id,
          matterId: task.matter_id,
          matterTitle: task.matter_title,
          title: task.title,
          dueAt: task.due_at,
          attemptCount,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { claimedAt: nowIso, claims, withdrawals };
  }

  async acknowledgeTaskNotification(
    ctx: AletheiaUserContext,
    deliveryId: string,
    input: {
      leaseToken: string;
      outcome: "delivered" | "failed";
      failureCode?: string | null;
    },
  ) {
    const row = this.db
      .prepare(
        `select * from aletheia_task_notification_deliveries
          where id = ? and user_id = ? and status = 'claimed' and lease_token = ?`,
      )
      .get(deliveryId, ctx.userId, input.leaseToken) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_task_notification_deliveries
              set status = ?, lease_token = null, failure_code = ?,
                  delivered_at = ?, updated_at = ?
            where id = ? and user_id = ? and status = 'claimed' and lease_token = ?`,
        )
        .run(
          input.outcome,
          input.outcome === "failed"
            ? (input.failureCode ?? "display_failed")
            : null,
          input.outcome === "delivered" ? timestamp : null,
          timestamp,
          deliveryId,
          ctx.userId,
          input.leaseToken,
        );
      this.writeAuditEvent(ctx.userId, String(row.matter_id), {
        actor: "system",
        action:
          input.outcome === "delivered"
            ? "task_notification_delivered"
            : "task_notification_failed",
        workflowVersion: "aletheia-task-notification-v1",
        model: null,
        details: {
          deliveryId,
          taskId: row.task_id,
          category: row.category,
          dueAt: row.due_at_snapshot,
          tag: row.tag,
          attemptCount: row.attempt_count,
          failureCode:
            input.outcome === "failed"
              ? (input.failureCode ?? "display_failed")
              : null,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare(
        "select * from aletheia_task_notification_deliveries where id = ? and user_id = ?",
      )
      .get(deliveryId, ctx.userId);
  }

  async exportTaskCalendar(
    ctx: AletheiaUserContext,
    status: LitigationTaskStatusFilter,
  ): Promise<TaskCalendarEntry[]> {
    const statusClause = status === "all" ? "" : "and t.status = ?";
    const parameters = status === "all" ? [ctx.userId] : [ctx.userId, status];
    const tasks = this.db
      .prepare(
        `select t.id, t.matter_id, m.title as matter_title, t.title, t.due_at,
                t.status, t.priority, t.note, t.created_at, t.updated_at
           from aletheia_tasks t
           join aletheia_matters m
             on m.id = t.matter_id
            and m.user_id = t.user_id
            and m.template = 'civil_litigation'
          where t.user_id = ? and t.invalidated_at is null ${statusClause}
          order by t.due_at asc, t.created_at asc, t.id asc`,
      )
      .all(...parameters) as TaskCalendarEntry[];

    const tasksByMatter = new Map<string, string[]>();
    for (const task of tasks) {
      const taskIds = tasksByMatter.get(task.matter_id) ?? [];
      taskIds.push(task.id);
      tasksByMatter.set(task.matter_id, taskIds);
    }
    for (const [matterId, taskIds] of tasksByMatter) {
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "task_calendar_exported",
        workflowVersion: "aletheia-task-calendar-v1",
        model: null,
        details: {
          status,
          taskCount: taskIds.length,
          taskIds,
        },
      });
    }
    return tasks;
  }

  async completeTask(ctx: AletheiaUserContext, taskId: string) {
    return this.transitionTask(ctx, taskId, "completed");
  }

  async reopenTask(ctx: AletheiaUserContext, taskId: string) {
    return this.transitionTask(ctx, taskId, "open");
  }

  private async transitionTask(
    ctx: AletheiaUserContext,
    taskId: string,
    target: "open" | "completed",
  ) {
    const result = (
      target === "completed"
        ? this.litigation.completeTask(ctx, taskId)
        : this.litigation.reopenTask(ctx, taskId)
    ) as { task: Record<string, unknown>; changed: boolean } | null;
    if (!result) return null;
    if (result.changed) {
      const matterId = String(result.task.matter_id);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action:
          target === "completed"
            ? "litigation_task_completed"
            : "litigation_task_reopened",
        workflowVersion: "aletheia-civil-litigation-v1",
        model: null,
        details: {
          taskId,
          sourceDeadlineId: result.task.source_deadline_id,
          dueAt: result.task.due_at,
        },
      });
      this.touchMatter(ctx.userId, matterId);
    }
    return result.task;
  }

  async generateLitigationArtifact(
    ctx: AletheiaUserContext,
    matterId: string,
    kind: LitigationArtifactKind,
  ) {
    const artifact = this.litigation.buildArtifact(ctx, matterId, kind);
    if (!artifact) return null;
    const titles: Record<LitigationArtifactKind, string> = {
      evidence_catalog: "Evidence catalog",
      claim_defense_matrix: "Claim and defense matrix",
      procedural_clock: "Procedural clock",
      litigation_brief: "Litigation brief",
      hearing_plan: "Hearing plan",
      hearing_bundle_index: "Hearing bundle index",
    };
    return this.createWorkProduct(ctx, matterId, {
      kind,
      title: titles[kind],
      status: "needs_review",
      schemaVersion: "aletheia-litigation-artifact-v1",
      content: artifact.content,
      validationErrors: artifact.validationErrors,
      generatedBy: "system",
      model: null,
      dependencyHash: artifact.dependencyHash,
    });
  }

  private documentDraftTransaction<T>(operation: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async createLitigationDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationDocumentDraftInput,
  ) {
    return this.documentDraftTransaction(() => {
      const document = this.litigation.createDocumentDraft(
        ctx,
        matterId,
        input,
      );
      if (!document) return null;
      const row = document as Record<string, any>;
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_document_draft_created",
        workflowVersion: "aletheia-litigation-document-draft-v1",
        model: null,
        details: {
          documentId: row.id,
          artifactId: row.artifact_id,
          artifactKind: row.artifact_kind,
          sourceContentHash: row.source_content_hash,
          sourceDependencyHash: row.source_dependency_hash,
          currentVersionId: row.current_version_id,
        },
      });
      this.touchMatter(ctx.userId, matterId);
      return document;
    });
  }

  async listLitigationDocumentDrafts(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    return this.litigation.listDocumentDrafts(ctx, matterId);
  }

  async getLitigationDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
  ) {
    return this.litigation.getDocumentDraft(ctx, matterId, documentId);
  }

  async exportLitigationDocumentDraftDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    versionId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.read");
    if (!access) return null;
    const context = this.litigation.documentDraftRoundTripContext(
      access.ownerCtx,
      matterId,
      documentId,
      versionId,
      false,
    );
    if (!context) return null;
    const { document, version } = context;
    const generated = await buildBoundDocumentDraftDocx({
      title:
        document.artifact_kind === "hearing_plan"
          ? "Hearing plan working draft"
          : "Litigation brief working draft",
      binding: {
        matterId,
        documentId,
        baseVersionId: version.id,
        baseVersion: Number(version.version),
        baseContentHash: version.content_hash,
        sourceContentHash: document.source_content_hash,
        sourceDependencyHash: document.source_dependency_hash,
      },
      sections: version.sections,
      exportedAt: now(),
    });
    this.documentDraftTransaction(() => {
      this.writeAuditEvent(access.actorId, matterId, {
        actor: "human",
        action: "litigation_document_draft_docx_exported",
        workflowVersion: DOCUMENT_DRAFT_ROUND_TRIP_PROTOCOL,
        model: null,
        details: {
          documentId,
          versionId: version.id,
          version: version.version,
          contentHash: version.content_hash,
          fileSha256: generated.fileSha256,
          bindingHash: generated.bindingHash,
        },
      });
    });
    return {
      bytes: generated.bytes,
      filename: `vera-${document.artifact_kind}-v${version.version}.docx`,
      fileSha256: generated.fileSha256,
      bindingHash: generated.bindingHash,
      versionId: version.id,
      version: Number(version.version),
    };
  }

  async importLitigationDocumentDraftDocx(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: ImportLitigationDocumentDraftDocxInput,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const context = this.litigation.documentDraftRoundTripContext(
      access.ownerCtx,
      matterId,
      documentId,
      undefined,
      false,
    );
    if (!context) return null;
    const { document, version } = context;
    const attemptId = randomUUID();
    const filename = path
      .basename(input.filename || "revised-draft.docx")
      .slice(0, 240);
    const fileSha256 = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
    const baseAttempt = {
      id: attemptId,
      baseVersionId: String(version.id),
      baseVersion: Number(version.version),
      baseContentHash: String(version.content_hash),
      originalFilename: filename,
      fileSha256,
      fileBytes: input.bytes.length,
      parserProtocol: DOCUMENT_DRAFT_ROUND_TRIP_PROTOCOL,
    };
    const persistRejected = (error: unknown) => {
      const code =
        error instanceof DocumentDraftRoundTripError
          ? error.code
          : "DOCX_IMPORT_REJECTED";
      const detail = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 1_000);
      this.documentDraftTransaction(() => {
        this.litigation.recordDocumentDraftImportAttempt(
          access.ownerCtx,
          matterId,
          documentId,
          {
            ...baseAttempt,
            bindingHash: null,
            status: "rejected",
            failureCode: code,
            failureDetail: detail,
            acceptedVersionId: null,
            storagePath: null,
          },
        );
        this.writeAuditEvent(access.actorId, matterId, {
          actor: "human",
          action: "litigation_document_draft_docx_import_rejected",
          workflowVersion: DOCUMENT_DRAFT_ROUND_TRIP_PROTOCOL,
          model: null,
          details: {
            attemptId,
            documentId,
            fileSha256,
            fileBytes: input.bytes.length,
            failureCode: code,
          },
        });
      });
    };

    let parsed: ReturnType<typeof parseBoundDocumentDraftDocx>;
    try {
      parsed = parseBoundDocumentDraftDocx({
        bytes: input.bytes,
        expected: {
          matterId,
          documentId,
          baseVersionId: String(version.id),
          baseVersion: Number(version.version),
          baseContentHash: String(version.content_hash),
          sourceContentHash: String(document.source_content_hash),
          sourceDependencyHash: String(document.source_dependency_hash),
        },
        currentSections: version.sections,
      });
    } catch (error) {
      persistRejected(error);
      throw error;
    }

    const storageDirectory = path.join(dataDir(), "documents", "draft-imports");
    if (!existsSync(storageDirectory)) {
      mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
    }
    chmodSync(storageDirectory, 0o700);
    const storagePath = path.join(storageDirectory, `${attemptId}.docx`);
    writeProtectedLocalFileSync({
      filePath: storagePath,
      plaintext: input.bytes,
      purpose: "source_document",
    });
    try {
      const accepted = this.documentDraftTransaction(() => {
        const result = this.litigation.appendImportedDocumentDraftVersion(
          access.ownerCtx,
          matterId,
          documentId,
          {
            baseVersionId: String(version.id),
            baseVersion: Number(version.version),
            changeSummary: input.changeSummary,
            sections: parsed.sections,
            fileSha256: parsed.fileSha256,
            originalFilename: filename,
            parserProtocol: parsed.protocol,
            bindingHash: parsed.bindingHash,
          },
        );
        if (!result) return null;
        this.litigation.recordDocumentDraftImportAttempt(
          access.ownerCtx,
          matterId,
          documentId,
          {
            ...baseAttempt,
            bindingHash: parsed.bindingHash,
            status: "accepted",
            failureCode: null,
            failureDetail: null,
            acceptedVersionId: result.versionId,
            storagePath,
          },
        );
        this.writeAuditEvent(access.actorId, matterId, {
          actor: "human",
          action: "litigation_document_draft_docx_imported",
          workflowVersion: DOCUMENT_DRAFT_ROUND_TRIP_PROTOCOL,
          model: null,
          details: {
            attemptId,
            documentId,
            baseVersionId: version.id,
            acceptedVersionId: result.versionId,
            version: result.version,
            contentHash: result.contentHash,
            fileSha256: parsed.fileSha256,
            bindingHash: parsed.bindingHash,
          },
        });
        this.touchMatter(access.ownerCtx.userId, matterId);
        return result.document;
      });
      return accepted;
    } catch (error) {
      try {
        unlinkSync(storagePath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
          throw cleanupError;
      }
      persistRejected(error);
      throw error;
    }
  }

  async appendLitigationDocumentDraftVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: AppendLitigationDocumentDraftVersionInput,
  ) {
    return this.documentDraftTransaction(() => {
      const document = this.litigation.appendDocumentDraftVersion(
        ctx,
        matterId,
        documentId,
        input,
      );
      if (!document) return null;
      const row = document as Record<string, any>;
      const version = Array.isArray(row.versions) ? row.versions.at(-1) : null;
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_document_draft_version_appended",
        workflowVersion: "aletheia-litigation-document-draft-v1",
        model: null,
        details: {
          documentId,
          versionId: version?.id ?? row.current_version_id,
          version: version?.version ?? null,
          baseVersion: input.baseVersion,
          contentHash: version?.content_hash ?? null,
          parentVersionId: version?.parent_version_id ?? null,
          parentContentHash: version?.parent_content_hash ?? null,
          changeSummary: input.changeSummary.trim(),
        },
      });
      this.touchMatter(ctx.userId, matterId);
      return document;
    });
  }

  async diffLitigationDocumentDraftVersions(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    fromVersion: number,
    toVersion: number,
  ) {
    return this.litigation.diffDocumentDraftVersions(
      ctx,
      matterId,
      documentId,
      fromVersion,
      toVersion,
    );
  }

  async reviewLitigationDocumentDraftVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    versionId: string,
    input: ReviewLitigationDocumentDraftVersionInput,
  ) {
    return this.documentDraftTransaction(() => {
      const document = this.litigation.reviewDocumentDraftVersion(
        ctx,
        matterId,
        documentId,
        versionId,
        input,
      );
      if (!document) return null;
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_document_draft_version_reviewed",
        workflowVersion: "aletheia-litigation-document-draft-v1",
        model: null,
        details: {
          documentId,
          versionId,
          decision: input.decision,
          reason: input.reason.trim(),
        },
      });
      this.touchMatter(ctx.userId, matterId);
      return document;
    });
  }

  async withdrawLitigationDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: WithdrawLitigationDocumentDraftInput,
  ) {
    return this.documentDraftTransaction(() => {
      const document = this.litigation.withdrawDocumentDraft(
        ctx,
        matterId,
        documentId,
        input,
      );
      if (!document) return null;
      const row = document as Record<string, any>;
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "human",
        action: "litigation_document_draft_withdrawn",
        workflowVersion: "aletheia-litigation-document-draft-v1",
        model: null,
        details: {
          documentId,
          reason: input.reason.trim(),
          stale: Boolean(row.stale),
          staleReasons: Array.isArray(row.stale_reasons)
            ? row.stale_reasons
            : [],
        },
      });
      this.touchMatter(ctx.userId, matterId);
      return document;
    });
  }

  async prepareLitigationAgentSnapshot(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    return this.litigation.buildAgentSnapshot(ctx, matterId);
  }

  private litigationAgentRunReviewBinding(
    ownerUserId: string,
    matterId: string,
    runId: string,
  ) {
    const run = this.db
      .prepare(
        `select * from aletheia_agent_runs
          where id = ? and matter_id = ? and user_id = ?
            and workflow = 'aletheia-civil-litigation-harness-v1'
            and status = 'succeeded'`,
      )
      .get(runId, matterId, ownerUserId) as Record<string, unknown> | undefined;
    if (!run) {
      throw new LitigationValidationError(
        "Only a succeeded litigation Agent run can enter legal review.",
      );
    }
    const metadata = parseObject(run.metadata);
    const snapshotHash = String(metadata.snapshotHash ?? "");
    if (!/^sha256:[a-f0-9]{64}$/.test(snapshotHash)) {
      throw new LitigationValidationError(
        "Agent run snapshot binding is missing or invalid.",
      );
    }
    if (metadata.source === "server_owned_litigation_workflow") {
      const stateHash = String(metadata.stateHash ?? "");
      if (!/^sha256:[a-f0-9]{64}$/.test(stateHash)) {
        throw new LitigationValidationError(
          "Agent run stable-state binding is missing or invalid.",
        );
      }
      const currentSnapshot = this.litigation.buildAgentSnapshot(
        { userId: ownerUserId },
        matterId,
      ) as Record<string, unknown> | null;
      if (!currentSnapshot || currentSnapshot.stateHash !== stateHash) {
        throw new LitigationValidationError(
          "The confirmed cited matter state changed after this Agent run was created. Start a new run before legal review.",
        );
      }
      if (
        metadata.retrievalInputBinding !== null &&
        metadata.retrievalInputBinding !== undefined
      ) {
        const retrievalBinding =
          metadata.retrievalInputBinding &&
          typeof metadata.retrievalInputBinding === "object" &&
          !Array.isArray(metadata.retrievalInputBinding)
            ? (metadata.retrievalInputBinding as Record<string, unknown>)
            : {};
        const manifestId = String(retrievalBinding.manifestId ?? "");
        const bindingHash = String(retrievalBinding.bindingHash ?? "");
        if (!manifestId || !/^sha256:[a-f0-9]{64}$/.test(bindingHash)) {
          throw new LitigationValidationError(
            "Agent run reviewed-retrieval binding is missing or invalid.",
          );
        }
        const currentBinding = this.buildLitigationReviewedExcerptInput(
          { userId: ownerUserId },
          matterId,
          manifestId,
        );
        if (!currentBinding || currentBinding.bindingHash !== bindingHash) {
          throw new LitigationValidationError(
            "Counsel-reviewed retrieval input changed after this Agent run was created. Start a new run before legal review.",
          );
        }
      }
    }
    const steps = this.db
      .prepare(
        `select id, step_key, handler, status, output from aletheia_agent_steps
          where run_id = ? order by sequence asc`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    const allowedStepSnapshotHashes = new Set(
      Array.isArray(metadata.partitionHashes) && metadata.partitionHashes.length
        ? metadata.partitionHashes.filter(
            (item): item is string =>
              typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item),
          )
        : [snapshotHash],
    );
    if (
      steps.length < 1 ||
      steps.length > 24 ||
      allowedStepSnapshotHashes.size === 0 ||
      steps.some((step) => {
        const output = parseObject(step.output);
        const grounding =
          output.grounding &&
          typeof output.grounding === "object" &&
          !Array.isArray(output.grounding)
            ? (output.grounding as Record<string, unknown>)
            : {};
        return (
          step.status !== "succeeded" ||
          step.handler !== "local_model.litigation_grounded" ||
          grounding.verified !== true ||
          grounding.exactQuotesVerified !== true ||
          !allowedStepSnapshotHashes.has(String(grounding.snapshotHash ?? ""))
        );
      })
    ) {
      throw new LitigationValidationError(
        "Agent run output is incomplete or lacks exact-quote grounding.",
      );
    }
    const reviewPayload = {
      runId,
      snapshotHash,
      steps: steps.map((step) => ({
        id: step.id,
        stepKey: step.step_key,
        output: parseObject(step.output),
      })),
    };
    const findings = steps.flatMap((step) => {
      const output = parseObject(step.output);
      const structured =
        output.structuredOutput &&
        typeof output.structuredOutput === "object" &&
        !Array.isArray(output.structuredOutput)
          ? (output.structuredOutput as Record<string, unknown>)
          : {};
      const rows = Array.isArray(structured.findings)
        ? structured.findings
        : [];
      return rows.map((finding, findingIndex) => ({
        stepId: String(step.id),
        stepKey: String(step.step_key),
        findingIndex,
        finding,
        findingHash: exportHash({
          stepId: String(step.id),
          findingIndex,
          finding,
        }),
      }));
    });
    if (findings.length === 0) {
      throw new LitigationValidationError(
        "Agent run output contains no reviewable findings.",
      );
    }
    return {
      snapshotHash,
      outputHash: exportHash(reviewPayload),
      findings,
    };
  }

  async requestLitigationAgentOutputReview(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const queue = new DurableAgentQueue({
      databasePath: path.join(dataDir(), "aletheia.db"),
    });
    try {
      const integrity = queue.verifyEventChain(runId);
      if (!integrity.ok) {
        throw new LitigationValidationError(
          "Agent run event-chain integrity verification failed.",
        );
      }
    } finally {
      queue.close();
    }
    const binding = this.litigationAgentRunReviewBinding(
      access.ownerCtx.userId,
      matterId,
      runId,
    );
    const existing = this.db
      .prepare(
        "select * from aletheia_litigation_agent_output_reviews where run_id = ? and matter_id = ? and user_id = ?",
      )
      .get(runId, matterId, access.ownerCtx.userId);
    if (existing) return existing;
    const id = randomUUID();
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_agent_output_reviews
            (id, run_id, matter_id, user_id, output_hash, snapshot_hash,
             status, requested_by, created_at)
           values (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          id,
          runId,
          matterId,
          access.ownerCtx.userId,
          binding.outputHash,
          binding.snapshotHash,
          access.actorId,
          timestamp,
        );
      this.writeAuditEvent(access.actorId, matterId, {
        actor: "human",
        action: "litigation_agent_output_review_requested",
        workflowVersion: "aletheia-agent-output-review-v1",
        model: null,
        details: { id, runId, ...binding, actorId: access.actorId },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare(
        "select * from aletheia_litigation_agent_output_reviews where id = ?",
      )
      .get(id);
  }

  async decideLitigationAgentOutputReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
    input: { decision: "approved" | "rejected"; comment: string },
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.review");
    if (!access) return null;
    const review = this.db
      .prepare(
        `select * from aletheia_litigation_agent_output_reviews
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(reviewId, matterId, access.ownerCtx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!review) return null;
    if (review.status !== "open") {
      throw new LitigationValidationError(
        "Agent output review is already decided.",
      );
    }
    const comment = input.comment.trim();
    if (comment.length < 10 || comment.length > 2_000) {
      throw new LitigationValidationError(
        "Agent output review requires a 10-2000 character reason.",
      );
    }
    const multiPrincipal = governanceForDatabase(this.db).multiPrincipalEnabled;
    if (multiPrincipal && review.requested_by === access.actorId) {
      throw new LitigationValidationError(
        "The review requester cannot decide their own Agent output review.",
      );
    }
    const independentReview =
      multiPrincipal && review.requested_by !== access.actorId;
    const binding = this.litigationAgentRunReviewBinding(
      access.ownerCtx.userId,
      matterId,
      String(review.run_id),
    );
    if (
      binding.outputHash !== review.output_hash ||
      binding.snapshotHash !== review.snapshot_hash
    ) {
      throw new LitigationValidationError(
        "Agent run output changed after review was requested.",
      );
    }
    if (input.decision === "approved") {
      const assessments = this.db
        .prepare(
          `select r.* from aletheia_litigation_agent_finding_reviews r
            join (
              select step_id, finding_index, max(version) as version
                from aletheia_litigation_agent_finding_reviews
               where run_id = ? and matter_id = ? and user_id = ?
               group by step_id, finding_index
            ) latest
              on latest.step_id = r.step_id
             and latest.finding_index = r.finding_index
             and latest.version = r.version
           where r.run_id = ? and r.matter_id = ? and r.user_id = ?`,
        )
        .all(
          review.run_id,
          matterId,
          access.ownerCtx.userId,
          review.run_id,
          matterId,
          access.ownerCtx.userId,
        ) as Array<Record<string, unknown>>;
      const expected = new Map(
        binding.findings.map((finding) => [
          `${finding.stepId}:${finding.findingIndex}`,
          finding.findingHash,
        ]),
      );
      const accepted = new Set(
        assessments
          .filter(
            (item) =>
              item.assessment === "supported" &&
              expected.get(`${item.step_id}:${item.finding_index}`) ===
                item.finding_hash,
          )
          .map((item) => `${item.step_id}:${item.finding_index}`),
      );
      if (
        accepted.size !== expected.size ||
        [...expected.keys()].some((key) => !accepted.has(key))
      ) {
        throw new LitigationValidationError(
          "Every current finding must be individually reviewed as supported before adoption.",
        );
      }
    }
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `update aletheia_litigation_agent_output_reviews
              set status = ?, decision_comment = ?, decided_by = ?,
                  independent_review = ?, decided_at = ?
            where id = ? and status = 'open'`,
        )
        .run(
          input.decision,
          comment,
          access.actorId,
          independentReview ? 1 : 0,
          timestamp,
          reviewId,
        );
      this.writeAuditEvent(access.actorId, matterId, {
        actor: "human",
        action: "litigation_agent_output_review_decided",
        workflowVersion: "aletheia-agent-output-review-v1",
        model: null,
        details: {
          reviewId,
          runId: review.run_id,
          decision: input.decision,
          comment,
          ...binding,
          actorId: access.actorId,
          independentReview,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare(
        "select * from aletheia_litigation_agent_output_reviews where id = ?",
      )
      .get(reviewId);
  }

  async reviewLitigationAgentFinding(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
    stepId: string,
    findingIndex: number,
    input: {
      assessment: "supported" | "partial" | "unsupported";
      reason: string;
    },
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.review");
    if (!access) return null;
    const review = this.db
      .prepare(
        `select * from aletheia_litigation_agent_output_reviews
          where run_id = ? and matter_id = ? and user_id = ? and status = 'open'`,
      )
      .get(runId, matterId, access.ownerCtx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!review) {
      throw new LitigationValidationError(
        "An open Agent output review is required before reviewing findings.",
      );
    }
    const multiPrincipal = governanceForDatabase(this.db).multiPrincipalEnabled;
    if (multiPrincipal && review.requested_by === access.actorId) {
      throw new LitigationValidationError(
        "The review requester cannot assess their own Agent findings.",
      );
    }
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 2_000) {
      throw new LitigationValidationError(
        "Finding review requires a 10-2000 character reason.",
      );
    }
    if (!Number.isInteger(findingIndex) || findingIndex < 0) {
      throw new LitigationValidationError("Finding index is invalid.");
    }
    const binding = this.litigationAgentRunReviewBinding(
      access.ownerCtx.userId,
      matterId,
      runId,
    );
    if (
      binding.outputHash !== review.output_hash ||
      binding.snapshotHash !== review.snapshot_hash
    ) {
      throw new LitigationValidationError(
        "Agent run output changed after review was requested.",
      );
    }
    const finding = binding.findings.find(
      (item) => item.stepId === stepId && item.findingIndex === findingIndex,
    );
    if (!finding) {
      throw new LitigationValidationError("Reviewable finding not found.");
    }
    const previous = this.db
      .prepare(
        `select * from aletheia_litigation_agent_finding_reviews
          where run_id = ? and step_id = ? and finding_index = ?
            and matter_id = ? and user_id = ?
          order by version desc limit 1`,
      )
      .get(runId, stepId, findingIndex, matterId, access.ownerCtx.userId) as
      | Record<string, unknown>
      | undefined;
    const id = randomUUID();
    const version = Number(previous?.version ?? 0) + 1;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_agent_finding_reviews
            (id, run_id, step_id, matter_id, user_id, finding_index,
             finding_hash, assessment, reason, version, supersedes_id,
             reviewed_by, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          runId,
          stepId,
          matterId,
          access.ownerCtx.userId,
          findingIndex,
          finding.findingHash,
          input.assessment,
          reason,
          version,
          previous?.id ?? null,
          access.actorId,
          timestamp,
        );
      this.writeAuditEvent(access.actorId, matterId, {
        actor: "human",
        action: "litigation_agent_finding_reviewed",
        workflowVersion: "aletheia-agent-finding-review-v1",
        model: null,
        details: {
          id,
          runId,
          stepId,
          findingIndex,
          findingHash: finding.findingHash,
          assessment: input.assessment,
          reason,
          version,
          supersedesId: previous?.id ?? null,
          actorId: access.actorId,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare(
        "select * from aletheia_litigation_agent_finding_reviews where id = ?",
      )
      .get(id);
  }

  async runLitigationAgentFindingSemanticCheck(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
    stepId: string,
    findingIndex: number,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.review");
    if (!access) return null;
    if (!Number.isInteger(findingIndex) || findingIndex < 0) {
      throw new LitigationValidationError("Finding index is invalid.");
    }
    const review = this.db
      .prepare(
        `select * from aletheia_litigation_agent_output_reviews
          where run_id = ? and matter_id = ? and user_id = ? and status = 'open'`,
      )
      .get(runId, matterId, access.ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    if (!review) {
      throw new LitigationValidationError(
        "An open Agent output review is required before requesting semantic advice.",
      );
    }
    const binding = this.litigationAgentRunReviewBinding(
      access.ownerCtx.userId,
      matterId,
      runId,
    );
    if (
      binding.outputHash !== review.output_hash ||
      binding.snapshotHash !== review.snapshot_hash
    ) {
      throw new LitigationValidationError(
        "Agent run output changed after review was requested.",
      );
    }
    const finding = binding.findings.find(
      (item) => item.stepId === stepId && item.findingIndex === findingIndex,
    ) as { finding: Record<string, unknown>; findingHash: string } | undefined;
    if (!finding)
      throw new LitigationValidationError("Reviewable finding not found.");
    const statement =
      typeof finding.finding.statement === "string"
        ? finding.finding.statement.trim()
        : "";
    const rawCitations = Array.isArray(finding.finding.citations)
      ? finding.finding.citations
      : [];
    const citations: FindingCitation[] = rawCitations.map((item) => {
      const citation =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {};
      return {
        sourceId:
          typeof citation.sourceId === "string" ? citation.sourceId.trim() : "",
        quote: typeof citation.quote === "string" ? citation.quote : "",
      };
    });
    if (
      !statement ||
      statement.length > 8_000 ||
      citations.length < 1 ||
      citations.length > 32 ||
      citations.some(
        (item) =>
          !item.sourceId ||
          item.sourceId.length > 256 ||
          !item.quote ||
          item.quote.length > 50_000,
      ) ||
      new Set(citations.map((item) => item.sourceId)).size !== citations.length
    ) {
      throw new LitigationValidationError(
        "Finding statement or exact citations are invalid for semantic checking.",
      );
    }
    const control = new LocalControlRepository({
      databasePath: path.join(dataDir(), "aletheia.db"),
    });
    let model: ReturnType<Pick<LocalModelScheduler, "snapshot">["snapshot"]>;
    let calibration: ReturnType<
      LocalControlRepository["latestModelCalibration"]
    >;
    let benchmark: ReturnType<LocalControlRepository["latestModelBenchmark"]>;
    let modelFingerprint: string;
    let settings: ReturnType<LocalControlRepository["getSettings"]>["settings"];
    try {
      settings = control.getSettings(access.ownerCtx.userId).settings;
      const modelId = settings.litigationModelId ?? settings.defaultModel;
      if (!modelId)
        throw new LitigationValidationError(
          "A selected litigation loopback model is required.",
        );
      model = this.findingEntailmentScheduler.snapshot(modelId);
      if (model.state !== "ready")
        throw new LitigationValidationError(
          "The selected litigation loopback model is not ready.",
        );
      if (
        !model.modelRevision ||
        !/^sha256:[a-f0-9]{64}$/i.test(model.modelRevision)
      ) {
        throw new LitigationValidationError(
          "The selected litigation model must expose an immutable revision.",
        );
      }
      calibration = control.latestModelCalibration(
        access.ownerCtx.userId,
        model.id,
      );
      const calibrationGate = modelCalibrationAcceptance({
        model,
        calibration,
        reasoning: settings.reasoning,
        fastMode: settings.fastMode,
      });
      if (!calibrationGate.accepted) {
        throw new LitigationValidationError(
          `Litigation model calibration is not current: ${calibrationGate.code}`,
        );
      }
      benchmark = control.latestModelBenchmark(
        access.ownerCtx.userId,
        model.id,
      );
      const benchmarkGate = modelBenchmarkAcceptance({
        model,
        benchmark,
        integrity: control.verifyModelBenchmarkIntegrity(
          access.ownerCtx.userId,
          model.id,
        ),
        reasoning: settings.reasoning,
        fastMode: settings.fastMode,
      });
      if (!benchmarkGate.accepted) {
        throw new LitigationValidationError(
          `Litigation model diagnostic benchmark is not current: ${benchmarkGate.code}`,
        );
      }
      modelFingerprint = localModelCalibrationFingerprint(model, {
        reasoning: settings.reasoning,
        fastMode: settings.fastMode,
      });
    } finally {
      control.close();
    }
    const result = await runFindingEntailmentCheck({
      scheduler: this.findingEntailmentScheduler,
      model: model!,
      statement,
      citations,
      reasoning: settings!.reasoning,
      fastMode: settings!.fastMode,
    });
    const previous = this.db
      .prepare(
        `select id, version from aletheia_litigation_agent_finding_semantic_checks
        where run_id = ? and step_id = ? and finding_index = ? and matter_id = ? and user_id = ?
        order by version desc limit 1`,
      )
      .get(runId, stepId, findingIndex, matterId, access.ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    const id = randomUUID();
    const timestamp = now();
    const version = Number(previous?.version ?? 0) + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_agent_finding_semantic_checks
          (id, run_id, step_id, matter_id, user_id, finding_index, version, finding_hash,
           citation_set_hash, snapshot_hash, output_review_hash, model_id, model_revision,
           model_fingerprint, calibration_fingerprint, benchmark_fingerprint, calibration_id,
           benchmark_id, protocol_version, prompt_sha256,
           output_sha256, citation_assessments, derived_verdict, overall_rationale, uncertainty,
           status, failure_code, failure_detail, duration_ms, supersedes_id, actor_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          runId,
          stepId,
          matterId,
          access.ownerCtx.userId,
          findingIndex,
          version,
          finding.findingHash,
          exportHash(rawCitations),
          binding.snapshotHash,
          binding.outputHash,
          model!.id,
          model!.modelRevision,
          modelFingerprint!,
          calibration!.modelFingerprint,
          benchmark!.modelFingerprint,
          calibration!.id,
          benchmark!.id,
          LOCAL_FINDING_ENTAILMENT_PROTOCOL,
          result.promptSha256,
          result.outputSha256,
          result.assessments ? json(result.assessments) : null,
          result.verdict,
          result.overallRationale,
          result.uncertainty,
          result.failureCode ? "failed" : "succeeded",
          result.failureCode,
          result.failureDetail,
          result.durationMs,
          previous?.id ?? null,
          access.actorId,
          timestamp,
        );
      this.writeAuditEvent(access.actorId, matterId, {
        actor: "agent",
        action: "litigation_agent_finding_semantic_check_recorded",
        workflowVersion: LOCAL_FINDING_ENTAILMENT_PROTOCOL,
        model: model!.id,
        details: {
          id,
          runId,
          stepId,
          findingIndex,
          version,
          findingHash: finding.findingHash,
          citationSetHash: exportHash(rawCitations),
          snapshotHash: binding.snapshotHash,
          outputReviewHash: binding.outputHash,
          modelRevision: model!.modelRevision,
          modelFingerprint: modelFingerprint!,
          calibrationFingerprint: calibration!.modelFingerprint,
          benchmarkFingerprint: benchmark!.modelFingerprint,
          calibrationId: calibration!.id,
          benchmarkId: benchmark!.id,
          promptSha256: result.promptSha256,
          outputSha256: result.outputSha256,
          verdict: result.verdict,
          status: result.failureCode ? "failed" : "succeeded",
          failureCode: result.failureCode,
          actorId: access.actorId,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare(
        "select * from aletheia_litigation_agent_finding_semantic_checks where id = ?",
      )
      .get(id);
  }

  async prepareLitigationAgentSynthesis(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.write");
    if (!access) return null;
    const queue = new DurableAgentQueue({
      databasePath: path.join(dataDir(), "aletheia.db"),
    });
    try {
      if (!queue.verifyEventChain(runId).ok) {
        throw new LitigationValidationError(
          "Parent Agent run event-chain integrity verification failed.",
        );
      }
    } finally {
      queue.close();
    }
    const binding = this.litigationAgentRunReviewBinding(
      access.ownerCtx.userId,
      matterId,
      runId,
    );
    const review = this.db
      .prepare(
        `select * from aletheia_litigation_agent_output_reviews
          where run_id = ? and matter_id = ? and user_id = ? and status = 'approved'`,
      )
      .get(runId, matterId, access.ownerCtx.userId) as
      | Record<string, unknown>
      | undefined;
    if (
      !review ||
      review.output_hash !== binding.outputHash ||
      review.snapshot_hash !== binding.snapshotHash
    ) {
      throw new LitigationValidationError(
        "Cross-partition synthesis requires an unchanged adopted output review.",
      );
    }
    const run = this.db
      .prepare("select metadata from aletheia_agent_runs where id = ?")
      .get(runId) as { metadata?: string } | undefined;
    const metadata = parseObject(run?.metadata);
    if (
      metadata.executionMode !== "source_partitioned" ||
      Number(metadata.partitionCount ?? 0) < 2
    ) {
      throw new LitigationValidationError(
        "Only an adopted multi-partition run can be synthesized.",
      );
    }
    const duplicate = this.db
      .prepare(
        `select id from aletheia_agent_runs
          where matter_id = ? and user_id = ?
            and json_extract(metadata, '$.synthesisOfRunId') = ?
            and status not in ('failed', 'cancelled', 'timed_out')
          limit 1`,
      )
      .get(matterId, access.ownerCtx.userId, runId);
    if (duplicate) {
      throw new LitigationValidationError(
        "A synthesis run already exists for this adopted partition run.",
      );
    }
    const stepRows = this.db
      .prepare(
        "select id, step_key, output from aletheia_agent_steps where run_id = ? order by sequence asc",
      )
      .all(runId) as Array<Record<string, unknown>>;
    const outputs = stepRows.map((step) => {
      const output = parseObject(step.output);
      const structured =
        output.structuredOutput &&
        typeof output.structuredOutput === "object" &&
        !Array.isArray(output.structuredOutput)
          ? (output.structuredOutput as Record<string, unknown>)
          : null;
      if (!structured) {
        throw new LitigationValidationError(
          "Adopted partition output is missing structured findings.",
        );
      }
      return { stepId: step.id, stepKey: step.step_key, output: structured };
    });
    const citationById = new Map<
      string,
      { id: string; quote: string; quoteSha256: string }
    >();
    const collectCitations = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(collectCitations);
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (
        typeof record.sourceId === "string" &&
        typeof record.quote === "string"
      ) {
        const quoteSha256 = createHash("sha256")
          .update(record.quote)
          .digest("hex");
        const existing = citationById.get(record.sourceId);
        if (existing && existing.quoteSha256 !== quoteSha256) {
          throw new LitigationValidationError(
            `Adopted outputs contain conflicting quotes for ${record.sourceId}.`,
          );
        }
        citationById.set(record.sourceId, {
          id: record.sourceId,
          quote: record.quote,
          quoteSha256,
        });
      }
      Object.values(record).forEach(collectCitations);
    };
    outputs.forEach((output) => collectCitations(output.output));
    if (citationById.size === 0) {
      throw new LitigationValidationError(
        "Adopted partition outputs contain no exact citations.",
      );
    }
    const content = {
      schemaVersion: "aletheia-litigation-reviewed-synthesis-input-v1",
      matterId,
      parentRunId: runId,
      parentOutputReviewId: review.id,
      parentOutputHash: binding.outputHash,
      parentSnapshotHash: binding.snapshotHash,
      partitionCount: outputs.length,
      outputs,
      citations: [...citationById.values()],
      limitation:
        "Inputs were adopted by a human reviewer; synthesis remains an unreviewed draft.",
    };
    return {
      content,
      synthesisHash: exportHash(content),
      allowedSources: [...citationById.values()].map(({ id, quoteSha256 }) => ({
        id,
        quoteSha256,
      })),
      parentReviewId: review.id,
      parentOutputHash: binding.outputHash,
    };
  }

  async getLitigationArtifactExportApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    workProductId: string,
  ): Promise<LitigationArtifactExportApprovalProjection | null> {
    const access = this.litigationAccess(ctx, matterId, "matter.read");
    if (!access) return null;
    const governance = governanceForDatabase(this.db);
    governance.assertPermission(access.actorId, matterId, "matter.read");
    this.db.exec("BEGIN");
    try {
      const projection = this.buildLitigationArtifactExportApprovalProjection(
        access.ownerCtx,
        access.actorId,
        matterId,
        workProductId,
        governance,
      );
      this.db.exec("COMMIT");
      return projection;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async voteLitigationArtifactExportApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    workProductId: string,
    input: {
      approvalCheckpointId: string;
      decision: "approved" | "rejected";
      comment?: string | null;
    },
  ): Promise<LitigationArtifactExportApprovalProjection | null> {
    const projection = await this.getLitigationArtifactExportApproval(
      ctx,
      matterId,
      workProductId,
    );
    if (!projection) return null;
    if (projection.approvalCheckpointId !== input.approvalCheckpointId) {
      throw new ApprovalRequiredError(
        "The approval checkpoint does not match the current litigation artifact projection.",
      );
    }
    if (!projection.actor.canVote) {
      const reason =
        projection.actor.voteBlockReason ?? "governance_request_ineligible";
      const forbidden = new Set<LitigationApprovalVoteBlockReason>([
        "requester_cannot_vote",
        "missing_approval_vote_permission",
        "role_not_eligible",
        "distinct_role_already_approved",
      ]).has(reason);
      throw new GovernancePolicyError(
        `Litigation artifact export vote is blocked: ${reason}`,
        forbidden ? "FORBIDDEN" : "INVALID_POLICY",
        forbidden ? 403 : 409,
      );
    }
    await this.decideApproval(ctx, matterId, input.approvalCheckpointId, {
      decision: input.decision,
      comment: input.comment,
    });
    return this.getLitigationArtifactExportApproval(
      ctx,
      matterId,
      workProductId,
    );
  }

  private buildLitigationArtifactExportApprovalProjection(
    ownerCtx: AletheiaUserContext,
    actorId: string,
    matterId: string,
    workProductId: string,
    governance: ReturnType<typeof governanceForDatabase>,
  ): LitigationArtifactExportApprovalProjection | null {
    const workProduct = this.db
      .prepare(
        `select * from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(workProductId, matterId, ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    const allowedKinds = new Set([
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ]);
    if (!workProduct || !allowedKinds.has(String(workProduct.kind))) {
      return null;
    }

    const version = Number(workProduct.version ?? 1);
    const content = parseObject(workProduct.content);
    const computedContentHash = exportHash(content);
    const contentHash = String(workProduct.content_hash ?? computedContentHash);
    const validationErrors = parseArray(workProduct.validation_errors);
    const contentIntegrityValid = contentHash === computedContentHash;
    const currentArtifact = this.litigation.buildArtifact(
      ownerCtx,
      matterId,
      workProduct.kind as LitigationArtifactKind,
    );
    const dependencyCurrent = Boolean(
      currentArtifact &&
      workProduct.dependency_hash &&
      currentArtifact.dependencyHash === workProduct.dependency_hash,
    );
    const legalPositionArtifact = new Set([
      "claim_defense_matrix",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ]).has(String(workProduct.kind));
    const unresolvedGate =
      legalPositionArtifact &&
      (Number(content.unresolvedPositionReviews ?? 0) > 0 ||
        (Array.isArray(content.uncitedLegalPositions) &&
          content.uncitedLegalPositions.length > 0) ||
        validationErrors.length > 0);
    const artifactEligibility: "stale" | "ineligible" | null =
      !contentIntegrityValid || unresolvedGate
        ? "ineligible"
        : workProduct.stale_at || !dependencyCurrent
          ? "stale"
          : null;

    const checkpoints = (
      this.db
        .prepare(
          `select * from aletheia_human_checkpoints
            where matter_id = ? and user_id = ?
              and checkpoint_type = 'litigation_artifact_export'
            order by created_at desc`,
        )
        .all(matterId, ownerCtx.userId) as Array<Record<string, any>>
    ).map(
      (checkpoint) => this.humanCheckpoint(checkpoint) as Record<string, any>,
    );
    const forWorkProduct = checkpoints.filter(
      (checkpoint) =>
        checkpoint.requested_payload?.matterId === matterId &&
        checkpoint.requested_payload?.workProductId === workProductId,
    );
    const exactCheckpoint = forWorkProduct.find(
      (checkpoint) =>
        Number(checkpoint.requested_payload?.version) === version &&
        checkpoint.requested_payload?.contentHash === contentHash,
    );
    const checkpoint = exactCheckpoint ?? forWorkProduct[0] ?? null;
    const exactBinding = Boolean(exactCheckpoint);
    const governanceApprovalRequestId =
      typeof checkpoint?.requested_payload?.governanceApprovalRequestId ===
      "string"
        ? checkpoint.requested_payload.governanceApprovalRequestId
        : null;
    const governanceRequest = governance.multiPrincipalEnabled
      ? governance.approvalRequest(governanceApprovalRequestId ?? "")
      : null;
    const governanceBindingValid = Boolean(
      checkpoint &&
      governanceRequest &&
      this.governanceRequestMatchesLitigationCheckpoint(
        governanceRequest,
        checkpoint,
      ),
    );
    const policy = governance.approvalPolicy(
      matterId,
      "litigation_artifact_export",
    );
    const votes = (governanceRequest?.votes ?? []).map((value) => {
      const vote = value as Record<string, unknown>;
      return {
        principalId: String(vote.principal_id ?? ""),
        role: String(vote.role ?? ""),
        decision: String(vote.decision ?? ""),
        comment: typeof vote.comment === "string" ? vote.comment : null,
        createdAt: String(vote.created_at ?? ""),
      };
    });
    const approvedVotes = votes.filter((vote) => vote.decision === "approved");
    const rejectedVotes = votes.filter((vote) => vote.decision === "rejected");

    let checkpointStatus: LitigationArtifactExportApprovalProjection["checkpointStatus"] =
      checkpoint
        ? (String(
            checkpoint.status,
          ) as LitigationArtifactExportApprovalProjection["checkpointStatus"])
        : "not_requested";
    if (checkpoint && !exactBinding) checkpointStatus = "stale";
    if (checkpoint && exactBinding && artifactEligibility) {
      checkpointStatus = artifactEligibility;
    }
    if (
      checkpoint &&
      exactBinding &&
      governance.multiPrincipalEnabled &&
      !governanceBindingValid
    ) {
      checkpointStatus = "ineligible";
    }
    if (
      checkpoint &&
      exactBinding &&
      governanceRequest?.status === "pending" &&
      !policy?.enabled
    ) {
      checkpointStatus = "ineligible";
    }

    let voteBlockReason: LitigationApprovalVoteBlockReason | null = null;
    let canVote = false;
    if (!governance.multiPrincipalEnabled) {
      voteBlockReason = "independent_approval_not_required";
    } else if (!checkpoint) {
      voteBlockReason = "approval_not_requested";
    } else if (!exactBinding || artifactEligibility === "stale") {
      voteBlockReason = "artifact_binding_stale";
    } else if (artifactEligibility === "ineligible") {
      voteBlockReason = "artifact_ineligible";
    } else if (!governanceRequest || !governanceBindingValid) {
      voteBlockReason = "governance_request_ineligible";
    } else if (governanceRequest.status === "approved") {
      voteBlockReason = "governance_request_approved";
    } else if (governanceRequest.status === "rejected") {
      voteBlockReason = "governance_request_rejected";
    } else if (!policy?.enabled) {
      voteBlockReason = "policy_missing_or_disabled";
    } else if (governanceRequest.requester_id === actorId) {
      voteBlockReason = "requester_cannot_vote";
    } else if (!governance.hasPermission(actorId, matterId, "approval.vote")) {
      voteBlockReason = "missing_approval_vote_permission";
    } else {
      const actorRoles = governance.rolesForMatter(actorId, matterId);
      const eligibleRole = policy.eligible_roles.find((role) =>
        actorRoles.includes(role),
      );
      if (!eligibleRole) {
        voteBlockReason = "role_not_eligible";
      } else if (votes.some((vote) => vote.principalId === actorId)) {
        voteBlockReason = "actor_already_voted";
      } else if (
        policy.require_distinct_roles &&
        approvedVotes.some((vote) => vote.role === eligibleRole)
      ) {
        voteBlockReason = "distinct_role_already_approved";
      } else {
        canVote = true;
      }
    }

    let independentStatus: LitigationArtifactExportApprovalProjection["independentApproval"]["status"] =
      "not_requested";
    if (checkpoint) {
      if (!exactBinding || artifactEligibility === "stale") {
        independentStatus = "stale";
      } else if (
        artifactEligibility === "ineligible" ||
        (governance.multiPrincipalEnabled && !governanceBindingValid)
      ) {
        independentStatus = "ineligible";
      } else if (governance.multiPrincipalEnabled) {
        independentStatus =
          governanceRequest?.status === "approved"
            ? "approved"
            : governanceRequest?.status === "rejected"
              ? "rejected"
              : "pending";
      } else {
        independentStatus =
          checkpoint.status === "approved"
            ? "approved"
            : checkpoint.status === "rejected"
              ? "rejected"
              : "pending";
      }
    }

    const matchingExport = (
      this.db
        .prepare(
          `select * from aletheia_exports
            where matter_id = ? and user_id = ?
              and export_type = 'litigation_artifact'
            order by created_at desc`,
        )
        .all(matterId, ownerCtx.userId) as Array<Record<string, any>>
    ).find((exported) => {
      const metadata = parseObject(exported.metadata);
      return (
        metadata.workProductId === workProductId &&
        Number(metadata.version) === version &&
        metadata.contentHash === contentHash
      );
    });
    const matchingExportMetadata = matchingExport
      ? parseObject(matchingExport.metadata)
      : {};

    return {
      approvalCheckpointId: checkpoint ? String(checkpoint.id) : null,
      workProductId,
      version,
      contentHash,
      checkpointStatus,
      governanceRequest:
        governanceRequest && governanceBindingValid
          ? {
              id: String(governanceRequest.id),
              requesterId: String(governanceRequest.requester_id),
              status: String(governanceRequest.status),
              approvedVotes: approvedVotes.length,
              rejectedVotes: rejectedVotes.length,
              requiredApprovals: Number(policy?.required_approvals ?? 0),
              requireDistinctRoles: Boolean(policy?.require_distinct_roles),
              votes,
            }
          : null,
      actor: {
        id: actorId,
        canVote,
        canExport: governance.hasPermission(actorId, matterId, "matter.export"),
        voteBlockReason,
      },
      independentApproval: {
        required: governance.multiPrincipalEnabled,
        status: independentStatus,
        approvedBy: governance.multiPrincipalEnabled
          ? approvedVotes.map((vote) => vote.principalId)
          : checkpoint?.status === "approved" && checkpoint.decided_by
            ? [String(checkpoint.decided_by)]
            : [],
      },
      export: matchingExport
        ? {
            status: "exported",
            exportId: String(matchingExport.id),
            exportedBy: String(
              matchingExportMetadata.exportedBy ?? ownerCtx.userId,
            ),
            exportedAt: String(matchingExport.created_at),
          }
        : null,
    };
  }

  async exportLitigationArtifact(
    ctx: AletheiaUserContext,
    matterId: string,
    workProductId: string,
    approvalCheckpointId: string,
    format: "docx" | "json" | "zip" = "docx",
    restrictedGovernanceApprovalRequestId: string | null = null,
  ) {
    const access = this.litigationAccess(ctx, matterId, "matter.export");
    if (!access) return null;
    const governance = governanceForDatabase(this.db);
    governance.assertExportAllowed(
      access.actorId,
      matterId,
      restrictedGovernanceApprovalRequestId,
    );
    const ownerCtx = access.ownerCtx;
    const row = this.db
      .prepare(
        `select * from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(workProductId, matterId, ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    if (!row) return null;
    const allowedKinds = [
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ];
    if (!allowedKinds.includes(String(row.kind))) {
      throw new LitigationValidationError(
        "Work product is not a litigation artifact.",
      );
    }
    if (format === "zip" && row.kind !== "hearing_bundle_index") {
      throw new LitigationValidationError(
        "ZIP export is limited to the hearing bundle index.",
      );
    }
    if (row.stale_at) {
      throw new LitigationValidationError(
        "The litigation artifact is stale and must be regenerated before export.",
      );
    }
    const content = parseObject(row.content);
    const contentHash = exportHash(content);
    if (row.content_hash && row.content_hash !== contentHash) {
      throw new LitigationValidationError(
        "Work product content hash is invalid.",
      );
    }
    const validationErrors = parseArray(row.validation_errors);
    const legalPositionArtifact = new Set([
      "claim_defense_matrix",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ]).has(String(row.kind));
    if (legalPositionArtifact) {
      if (Number(content.unresolvedPositionReviews ?? 0) > 0) {
        throw new LitigationValidationError(
          "Legal-position artifacts cannot be exported while a position review is open.",
        );
      }
      if (
        Array.isArray(content.uncitedLegalPositions) &&
        content.uncitedLegalPositions.length > 0
      ) {
        throw new LitigationValidationError(
          "Legal-position artifacts cannot be exported while a confirmed position lacks an exact source citation.",
        );
      }
      if (
        Array.isArray(content.missingLegalAuthorityPositions) &&
        content.missingLegalAuthorityPositions.length > 0
      ) {
        throw new LitigationValidationError(
          "Legal-position artifacts cannot be exported while a confirmed position lacks an active verified exact-quote authority.",
        );
      }
      if (validationErrors.length > 0) {
        throw new LitigationValidationError(
          "Legal-position artifacts cannot be exported while validation errors remain unresolved.",
        );
      }
    }
    const currentArtifact = this.litigation.buildArtifact(
      ownerCtx,
      matterId,
      row.kind as LitigationArtifactKind,
    );
    if (
      !currentArtifact ||
      !row.dependency_hash ||
      currentArtifact.dependencyHash !== row.dependency_hash
    ) {
      const timestamp = now();
      this.db
        .prepare(
          `update aletheia_work_products
              set stale_at = ?, stale_reason = ?, updated_at = ?
            where id = ? and stale_at is null`,
        )
        .run(
          timestamp,
          "confirmed_state_dependency_changed",
          timestamp,
          row.id,
        );
      throw new LitigationValidationError(
        "The litigation artifact dependencies changed and it must be regenerated before export.",
      );
    }
    const approved = this.loadApprovedApprovalCheckpoint(
      ownerCtx,
      matterId,
      approvalCheckpointId,
      "litigation_artifact_export",
    ) as any;
    if (!approved) {
      throw new ApprovalRequiredError(
        "Litigation artifact export requires an approved human checkpoint.",
      );
    }
    const requested =
      approved.requested_payload &&
      typeof approved.requested_payload === "object"
        ? (approved.requested_payload as Record<string, unknown>)
        : parseObject(approved.requested_payload);
    if (
      requested.matterId !== matterId ||
      requested.workProductId !== workProductId ||
      Number(requested.version) !== Number(row.version ?? 1) ||
      requested.contentHash !== contentHash
    ) {
      throw new ApprovalRequiredError(
        "The approval checkpoint is not bound to this artifact version and content hash.",
      );
    }
    const governanceApprovalRequestId =
      typeof requested.governanceApprovalRequestId === "string"
        ? requested.governanceApprovalRequestId
        : null;
    let governanceApprovalRequest: Record<string, any> | null = null;
    if (governance.multiPrincipalEnabled) {
      governanceApprovalRequest = governance.approvalRequest(
        governanceApprovalRequestId ?? "",
      );
      if (
        !governanceApprovalRequest ||
        governanceApprovalRequest.status !== "approved" ||
        !this.governanceRequestMatchesLitigationCheckpoint(
          governanceApprovalRequest,
          approved,
        )
      ) {
        throw new ApprovalRequiredError(
          "Litigation artifact export requires its bound governance request to be approved.",
        );
      }
    } else if (
      requested.approvalMode !== "single_user_non_independent" ||
      requested.independentApproval !== false
    ) {
      throw new ApprovalRequiredError(
        "Single-user litigation export approval must be explicitly non-independent.",
      );
    }
    const exportId = randomUUID();
    const timestamp = now();
    const exportPath = localExportPath({
      root: dataDir(),
      matterId,
      exportId,
      kind: row.kind,
      title: row.title,
      extension: format,
    });
    const payload = {
      schemaVersion: "aletheia-litigation-artifact-export-v2",
      exportId,
      matterId,
      workProductId,
      kind: row.kind,
      title: row.title,
      version: Number(row.version ?? 1),
      contentHash,
      format,
      mimeType:
        format === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : format === "zip"
            ? "application/zip"
            : "application/json",
      exportedAt: timestamp,
      exportedBy: access.actorId,
      content,
      validationErrors,
    };
    const templateBinding =
      content.documentTemplate &&
      typeof content.documentTemplate === "object" &&
      !Array.isArray(content.documentTemplate)
        ? (content.documentTemplate as JsonObject)
        : parseObject(content.documentTemplate);
    let indexDocx: Buffer;
    if (templateBinding.source === "custom") {
      const template = this.db
        .prepare(
          `select * from aletheia_litigation_custom_templates
            where id = ? and version = ? and matter_id = ? and user_id = ?
              and status = 'approved'`,
        )
        .get(
          templateBinding.id,
          Number(templateBinding.version),
          matterId,
          ownerCtx.userId,
        ) as Record<string, any> | undefined;
      if (
        !template ||
        templateBinding.templateHash !== `sha256:${template.file_sha256}`
      ) {
        throw new LitigationValidationError(
          "The approved custom document template binding is unavailable or changed.",
        );
      }
      const templateBytes = readProtectedLocalFileSync({
        filePath: String(template.storage_path),
        purpose: "source_document",
      });
      const inspection = inspectLitigationDocxTemplate(templateBytes);
      if (inspection.sha256 !== template.file_sha256) {
        throw new LitigationValidationError(
          "The approved custom document template failed its file hash check.",
        );
      }
      const profile =
        content.documentProfile &&
        typeof content.documentProfile === "object" &&
        !Array.isArray(content.documentProfile)
          ? (content.documentProfile as JsonObject)
          : parseObject(content.documentProfile);
      const matter = this.db
        .prepare(
          "select title from aletheia_matters where id = ? and user_id = ?",
        )
        .get(matterId, ownerCtx.userId) as { title: string } | undefined;
      indexDocx = renderLitigationDocxTemplate(templateBytes, {
        matter_title: matter?.title ?? "",
        artifact_title: String(row.title),
        organization_name: String(profile.organizationName ?? ""),
        court: String(profile.court ?? ""),
        case_number: String(profile.caseNumber ?? ""),
        generated_at: timestamp,
        content_hash: contentHash,
        aletheia_body: renderLitigationArtifactPlainText(content),
      });
    } else {
      indexDocx = await buildLitigationArtifactDocx({
        title: String(row.title),
        kind: row.kind as LitigationArtifactKind,
        matterId,
        version: payload.version,
        contentHash,
        exportedAt: timestamp,
        content,
      });
    }
    let exportBytes: Buffer;
    if (format === "zip") {
      const zip = new JSZip();
      const manifestEntries: Array<Record<string, unknown>> = [];
      const entries = Array.isArray(content.hearingBundleEntries)
        ? content.hearingBundleEntries
        : [];
      const documentRoot = path.resolve(dataDir(), "documents");
      for (const value of entries) {
        const entry = value as Record<string, unknown>;
        const document = this.db
          .prepare(
            `select * from aletheia_matter_documents
              where id = ? and matter_id = ? and user_id = ?`,
          )
          .get(entry.documentId, matterId, ownerCtx.userId) as
          | Record<string, unknown>
          | undefined;
        if (!document) {
          throw new LitigationValidationError(
            "A hearing bundle source document is no longer available.",
          );
        }
        const documentMetadata = parseObject(document.metadata);
        const expectedHash = String(entry.originalSha256 ?? "");
        const storagePath = path.resolve(
          String(documentMetadata.storagePath ?? ""),
        );
        let realDocumentPath: string;
        try {
          realDocumentPath = realpathSync(storagePath);
          const relative = path.relative(
            realpathSync(documentRoot),
            realDocumentPath,
          );
          if (
            !relative ||
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            path.dirname(realDocumentPath) !== realpathSync(documentRoot) ||
            !path
              .basename(realDocumentPath)
              .startsWith(`${String(document.id)}.`) ||
            lstatSync(realDocumentPath).isSymbolicLink()
          ) {
            throw new Error("unsafe bundle source path");
          }
        } catch {
          throw new LitigationValidationError(
            "A hearing bundle source path failed the local safety check.",
          );
        }
        const bytes = readMatterDocumentFile(realDocumentPath);
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (
          !/^[a-f0-9]{64}$/.test(expectedHash) ||
          actualHash !== expectedHash
        ) {
          throw new LitigationValidationError(
            `Original source hash mismatch: ${String(document.name)}`,
          );
        }
        const exhibitNumber = String(entry.exhibitNumber);
        const safeName = String(document.name)
          .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
          .slice(0, 160);
        const archivePath = `exhibits/${exhibitNumber}-${safeName}`;
        zip.file(archivePath, bytes);
        manifestEntries.push({
          exhibitNumber,
          documentId: document.id,
          documentName: document.name,
          archivePath,
          sha256: actualHash,
          referenceCount: entry.referenceCount,
          pageCount: entry.pageCount ?? null,
          bundlePageStart: entry.bundlePageStart ?? null,
          bundlePageEnd: entry.bundlePageEnd ?? null,
        });
      }
      zip.file("hearing-bundle-index.docx", indexDocx);
      zip.file(
        "manifest.json",
        JSON.stringify(
          {
            schemaVersion: "aletheia-hearing-bundle-package-v1",
            matterId,
            workProductId,
            version: payload.version,
            contentHash,
            exportedAt: timestamp,
            pagination: content.bundlePagination ?? null,
            entries: manifestEntries,
          },
          null,
          2,
        ),
      );
      exportBytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
    } else {
      exportBytes =
        format === "docx"
          ? indexDocx
          : Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    }
    writeProtectedLocalFileSync({
      filePath: exportPath,
      plaintext: exportBytes,
      purpose: "local_export",
    });
    const fileSha256 = `sha256:${createHash("sha256")
      .update(readFileSync(exportPath))
      .digest("hex")}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertExportRecord({
        id: exportId,
        matterId,
        userId: ownerCtx.userId,
        exportType: "litigation_artifact",
        schemaVersion: payload.schemaVersion,
        exportHash: fileSha256,
        exportPath,
        approvalCheckpointId,
        gateAuthorizationStatus: "approved",
        sourceIndexManifest: {
          source_count: Array.isArray(content.sources)
            ? content.sources.length
            : 0,
          source_integrity: content.sourceIntegrity ?? null,
        },
        metadata: {
          workProductId,
          kind: row.kind,
          version: payload.version,
          contentHash,
          format,
          mimeType: payload.mimeType,
          fileSha256,
          exportedBy: access.actorId,
          requesterId:
            governanceApprovalRequest?.requester_id ?? access.actorId,
          governanceApprovalRequestId,
          restrictedGovernanceApprovalRequestId,
        },
        createdAt: timestamp,
      });
      this.db
        .prepare(
          "update aletheia_work_products set status = 'accepted', updated_at = ? where id = ?",
        )
        .run(timestamp, workProductId);
      const auditEvent = this.writeAuditEvent(ownerCtx.userId, matterId, {
        actor: "human",
        action: "litigation_artifact_exported",
        workflowVersion: payload.schemaVersion,
        model: null,
        details: {
          exportId,
          exportPath,
          workProductId,
          kind: row.kind,
          version: payload.version,
          contentHash,
          approvalCheckpointId,
          governanceApprovalRequestId,
          governanceApprovalStatus:
            governanceApprovalRequest?.status ?? "not_applicable_single_user",
          governanceApprovedVotes:
            governanceApprovalRequest?.votes?.filter(
              (vote: Record<string, unknown>) => vote.decision === "approved",
            ).length ?? 0,
          restrictedGovernanceApprovalRequestId,
          ownerId: ownerCtx.userId,
          requesterId:
            governanceApprovalRequest?.requester_id ?? access.actorId,
          actorId: access.actorId,
          exportedBy: access.actorId,
          format,
          mimeType: payload.mimeType,
          fileSha256,
        },
      }) as { id?: string };
      this.attachExportAuditEvent(exportId, auditEvent.id ?? null);
      this.touchMatter(ownerCtx.userId, matterId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (existsSync(exportPath)) unlinkSync(exportPath);
      throw error;
    }
    return { ...payload, exportPath, exportHash: fileSha256 };
  }

  async downloadLitigationArtifact(
    ctx: AletheiaUserContext,
    matterId: string,
    exportId: string,
  ): Promise<LitigationArtifactDownload | null> {
    const access = this.litigationAccess(ctx, matterId, "matter.export");
    if (!access) return null;
    const governance = governanceForDatabase(this.db);
    governance.assertPermission(access.actorId, matterId, "matter.export");
    const ownerCtx = access.ownerCtx;
    const exported = this.db
      .prepare(
        `select * from aletheia_exports
          where id = ? and matter_id = ? and user_id = ?
            and export_type = 'litigation_artifact'`,
      )
      .get(exportId, matterId, ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    if (!exported) return null;

    const failIntegrity = (): never => {
      throw new LitigationArtifactDownloadIntegrityError();
    };
    const exportMetadata = parseObject(exported.metadata);
    governance.assertExportAllowed(
      access.actorId,
      matterId,
      typeof exportMetadata.restrictedGovernanceApprovalRequestId === "string"
        ? exportMetadata.restrictedGovernanceApprovalRequestId
        : null,
    );
    const workProductId = String(exportMetadata.workProductId ?? "");
    const version = Number(exportMetadata.version);
    const contentHash = String(exportMetadata.contentHash ?? "");
    const exportFormat = exportMetadata.format;
    const expectedMimeType =
      exportFormat === "zip"
        ? ("application/zip" as const)
        : ("application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const);
    if (
      exported.gate_authorization_status !== "approved" ||
      typeof exported.approval_checkpoint_id !== "string"
    ) {
      throw new ApprovalRequiredError(
        "Litigation artifact download requires its approved export checkpoint.",
      );
    }
    if (
      !["docx", "zip"].includes(String(exportFormat)) ||
      exportMetadata.mimeType !== expectedMimeType ||
      (exportFormat === "zip" &&
        exportMetadata.kind !== "hearing_bundle_index") ||
      !workProductId ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(contentHash)
    ) {
      return failIntegrity();
    }

    const approved = this.loadApprovedApprovalCheckpoint(
      ownerCtx,
      matterId,
      exported.approval_checkpoint_id,
      "litigation_artifact_export",
    ) as Record<string, any> | null;
    if (!approved) {
      throw new ApprovalRequiredError(
        "Litigation artifact download requires its approved export checkpoint.",
      );
    }
    const requested =
      approved.requested_payload &&
      typeof approved.requested_payload === "object" &&
      !Array.isArray(approved.requested_payload)
        ? (approved.requested_payload as Record<string, unknown>)
        : parseObject(approved.requested_payload);
    if (
      requested.matterId !== matterId ||
      requested.workProductId !== workProductId ||
      Number(requested.version) !== version ||
      requested.contentHash !== contentHash
    ) {
      throw new ApprovalRequiredError(
        "The export approval is not bound to this litigation artifact version.",
      );
    }
    const governanceApprovalRequestId =
      typeof requested.governanceApprovalRequestId === "string"
        ? requested.governanceApprovalRequestId
        : null;
    const governanceApprovalRequest = governance.multiPrincipalEnabled
      ? governance.approvalRequest(governanceApprovalRequestId ?? "")
      : null;
    if (
      governance.multiPrincipalEnabled &&
      (!governanceApprovalRequest ||
        governanceApprovalRequest.status !== "approved" ||
        !this.governanceRequestMatchesLitigationCheckpoint(
          governanceApprovalRequest,
          approved,
        ))
    ) {
      throw new ApprovalRequiredError(
        "Litigation artifact download requires its bound governance request to remain approved.",
      );
    }

    const workProduct = this.db
      .prepare(
        `select * from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(workProductId, matterId, ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    const allowedKinds = new Set([
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ]);
    if (
      !workProduct ||
      !allowedKinds.has(String(workProduct.kind)) ||
      Number(workProduct.version) !== version ||
      workProduct.content_hash !== contentHash ||
      exportHash(parseObject(workProduct.content)) !== contentHash ||
      exportMetadata.kind !== workProduct.kind
    ) {
      return failIntegrity();
    }

    const auditEvent = this.db
      .prepare(
        `select * from aletheia_audit_events
          where id = ? and matter_id = ? and user_id = ?
            and action = 'litigation_artifact_exported'`,
      )
      .get(exported.audit_event_id, matterId, ownerCtx.userId) as
      | Record<string, any>
      | undefined;
    const auditDetails = parseObject(auditEvent?.details);
    if (
      !auditEvent ||
      auditDetails.exportId !== exportId ||
      auditDetails.workProductId !== workProductId ||
      Number(auditDetails.version) !== version ||
      auditDetails.contentHash !== contentHash ||
      auditDetails.approvalCheckpointId !== exported.approval_checkpoint_id ||
      auditDetails.governanceApprovalRequestId !==
        (governanceApprovalRequestId ?? null) ||
      auditDetails.format !== exportFormat ||
      auditDetails.fileSha256 !== exported.export_hash ||
      exportMetadata.fileSha256 !== exported.export_hash
    ) {
      return failIntegrity();
    }

    let exportPath: string;
    let storedBytes: Buffer;
    try {
      const exportDirectory = path.resolve(dataDir(), "exports", matterId);
      exportPath = path.resolve(String(exported.export_path ?? ""));
      const relative = path.relative(exportDirectory, exportPath);
      const directoryStat = lstatSync(exportDirectory);
      const fileStat = lstatSync(exportPath);
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        path.dirname(exportPath) !== exportDirectory ||
        path.extname(exportPath).toLowerCase() !== `.${String(exportFormat)}` ||
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        fileStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        path.dirname(realpathSync(exportPath)) !== realpathSync(exportDirectory)
      ) {
        return failIntegrity();
      }
      storedBytes = readFileSync(exportPath);
    } catch (error) {
      if (error instanceof LitigationArtifactDownloadIntegrityError)
        throw error;
      return failIntegrity();
    }

    const storedHash = `sha256:${createHash("sha256")
      .update(storedBytes)
      .digest("hex")}`;
    if (storedHash !== exported.export_hash) return failIntegrity();

    let bytes: Buffer;
    try {
      if (isAletheiaEnvelope(storedBytes)) {
        bytes = decryptLocalBuffer({
          envelope: storedBytes,
          filePath: exportPath,
          purpose: "local_export",
        });
      } else if (applicationEncryptionMode() === "required") {
        return failIntegrity();
      } else {
        bytes = storedBytes;
      }
    } catch (error) {
      if (error instanceof LitigationArtifactDownloadIntegrityError)
        throw error;
      return failIntegrity();
    }
    if (bytes.length < 4 || bytes.subarray(0, 2).toString("ascii") !== "PK") {
      return failIntegrity();
    }

    this.writeAuditEvent(ownerCtx.userId, matterId, {
      actor: "human",
      action: "litigation_artifact_downloaded",
      workflowVersion: "aletheia-litigation-artifact-export-v2",
      model: null,
      details: {
        exportId,
        workProductId,
        kind: workProduct.kind,
        version,
        contentHash,
        approvalCheckpointId: exported.approval_checkpoint_id,
        governanceApprovalRequestId,
        governanceApprovalStatus:
          governanceApprovalRequest?.status ?? "not_applicable_single_user",
        ownerId: ownerCtx.userId,
        requesterId: governanceApprovalRequest?.requester_id ?? access.actorId,
        actorId: access.actorId,
        downloadedBy: access.actorId,
        exportHash: exported.export_hash,
      },
    });
    return {
      exportId,
      workProductId,
      title: String(workProduct.title),
      version,
      contentHash,
      mimeType: expectedMimeType,
      format: exportFormat as "docx" | "zip",
      bytes,
    };
  }

  async runLitigationEvalSuite(ctx: AletheiaUserContext, matterId: string) {
    const result = this.litigation.runEvalSuite(ctx, matterId) as Record<
      string,
      unknown
    > | null;
    if (!result) return null;
    this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: "litigation_eval_run_completed",
      workflowVersion: "aletheia-litigation-eval-v5",
      model: null,
      details: {
        runId: result.id,
        passed: result.passed,
        total: result.total,
        resultHash: result.result_hash,
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return result;
  }

  async listLitigationEvalRuns(ctx: AletheiaUserContext, matterId: string) {
    return this.litigation.listEvalRuns(ctx, matterId);
  }

  private refreshLitigationArtifactStaleness(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
    const kinds: LitigationArtifactKind[] = [
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ];
    const rows = this.db
      .prepare(
        `select id, kind, dependency_hash from aletheia_work_products
          where matter_id = ? and user_id = ? and stale_at is null
            and kind in (${kinds.map(() => "?").join(",")})`,
      )
      .all(matterId, ctx.userId, ...kinds) as Array<{
      id: string;
      kind: LitigationArtifactKind;
      dependency_hash: string | null;
    }>;
    const current = new Map<LitigationArtifactKind, string | null>();
    for (const row of rows) {
      if (!current.has(row.kind)) {
        try {
          current.set(
            row.kind,
            this.litigation.buildArtifact(ctx, matterId, row.kind)
              ?.dependencyHash ?? null,
          );
        } catch {
          current.set(row.kind, null);
        }
      }
      const nextHash = current.get(row.kind) ?? null;
      if (row.dependency_hash && row.dependency_hash === nextHash) continue;
      const timestamp = now();
      const reason = nextHash
        ? "confirmed_state_dependency_changed"
        : "source_integrity_or_dependency_unavailable";
      this.db
        .prepare(
          `update aletheia_work_products
              set stale_at = ?, stale_reason = ?, updated_at = ?
            where id = ? and stale_at is null`,
        )
        .run(timestamp, reason, timestamp, row.id);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "system",
        action: "litigation_artifact_marked_stale",
        workflowVersion: "aletheia-litigation-artifact-v1",
        model: null,
        details: {
          workProductId: row.id,
          kind: row.kind,
          previousDependencyHash: row.dependency_hash,
          currentDependencyHash: nextHash,
          reason,
        },
      });
    }
  }

  private writeAuditEvent(
    userId: string,
    matterId: string,
    input: AppendAuditEventInput,
  ) {
    const id = randomUUID();
    const timestamp = now();
    const last = this.db
      .prepare(
        `select sequence, event_hash from aletheia_audit_events
         where matter_id = ? and sequence is not null
         order by sequence desc limit 1`,
      )
      .get(matterId) as { sequence?: number; event_hash?: string } | undefined;
    const sequence = Number(last?.sequence ?? 0) + 1;
    const previousHash = last?.event_hash ?? null;
    const persistedDetails = json(input.details ?? {});
    const details = parseObject(persistedDetails);
    const eventHash = auditEventHash({
      id,
      matterId,
      userId,
      actor: input.actor,
      action: input.action,
      workflowVersion: input.workflowVersion ?? "aletheia-v0",
      model: input.model,
      details,
      createdAt: timestamp,
      sequence,
      previousHash,
    });
    this.db
      .prepare(
        `
        insert into aletheia_audit_events (
          id, matter_id, user_id, actor, action, workflow_version, model,
          details, sequence, previous_hash, event_hash, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        matterId,
        userId,
        input.actor,
        input.action,
        input.workflowVersion ?? "aletheia-v0",
        input.model,
        persistedDetails,
        sequence,
        previousHash,
        eventHash,
        timestamp,
      );
    return this.auditEvent(
      this.db
        .prepare("select * from aletheia_audit_events where id = ?")
        .get(id),
    );
  }

  private async persistFinalMemoGateAuthorization(
    ctx: AletheiaUserContext,
    matterId: string,
    content: Record<string, unknown>,
    approvalCheckpointId: string | null,
  ) {
    const snapshot = buildGateSnapshotAuditDetails({
      matterId,
      action: "final_memo_export",
      approvalCheckpointId,
      content,
    });
    const snapshotEvent = (await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: GATE_AUDIT_ACTIONS.resultsPersisted,
      workflowVersion: snapshot.details.schemaVersion,
      model: null,
      details: snapshot.details,
    })) as { id?: string } | null;

    if (!snapshot.ok) {
      await this.writeAuditEvent(ctx.userId, matterId, {
        actor: "system",
        action: GATE_AUDIT_ACTIONS.finalExportBlocked,
        workflowVersion: snapshot.details.schemaVersion,
        model: null,
        details: {
          schemaVersion: snapshot.details.schemaVersion,
          action: "final_memo_export",
          matterId,
          approvalCheckpointId,
          gateSnapshotAuditEventId: snapshotEvent?.id ?? null,
          failureReasons: snapshot.failures,
        },
      });
      throw new ApprovalRequiredError(
        `Final memo export requires a persisted passing gate snapshot: ${snapshot.failures.join(" ")}`,
      );
    }

    const authorizationEvent = (await this.writeAuditEvent(
      ctx.userId,
      matterId,
      {
        actor: "system",
        action: GATE_AUDIT_ACTIONS.finalExportAuthorized,
        workflowVersion: snapshot.details.schemaVersion,
        model: null,
        details: {
          schemaVersion: snapshot.details.schemaVersion,
          action: "final_memo_export",
          matterId,
          approvalCheckpointId,
          gateSnapshotAuditEventId: snapshotEvent?.id ?? null,
          gateSummary: snapshot.details.gateSummary,
        },
      },
    )) as { id?: string } | null;

    return {
      gateSnapshotAuditEventId: snapshotEvent?.id ?? null,
      gateAuthorizationAuditEventId: authorizationEvent?.id ?? null,
    };
  }

  private loadOwnedMatter(ctx: AletheiaUserContext, matterId: string) {
    const row = this.db
      .prepare("select * from aletheia_matters where id = ? and user_id = ?")
      .get(matterId, ctx.userId);
    return row ? this.matter(row) : null;
  }

  private latestAgentRunId(matterId: string, userId: string) {
    const row = this.db
      .prepare(
        `
        select id from aletheia_agent_runs
        where matter_id = ? and user_id = ?
        order by created_at desc
        limit 1
      `,
      )
      .get(matterId, userId) as any | undefined;
    return typeof row?.id === "string" ? row.id : null;
  }

  private assertCurrentLitigationArtifactApprovalBinding(
    ownerId: string,
    matterId: string,
    payload: Record<string, unknown>,
  ) {
    const workProductId =
      typeof payload.workProductId === "string" ? payload.workProductId : "";
    const version = Number(payload.version);
    const contentHash =
      typeof payload.contentHash === "string" ? payload.contentHash : "";
    if (
      !workProductId ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(contentHash)
    ) {
      throw new ApprovalRequiredError(
        "Litigation export approval must bind workProductId, version, and contentHash.",
      );
    }
    const workProduct = this.db
      .prepare(
        `select id, kind, version, content, content_hash
           from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(workProductId, matterId, ownerId) as
      | Record<string, unknown>
      | undefined;
    const allowedKinds = new Set([
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ]);
    if (
      !workProduct ||
      !allowedKinds.has(String(workProduct.kind)) ||
      Number(workProduct.version) !== version ||
      workProduct.content_hash !== contentHash ||
      exportHash(parseObject(workProduct.content)) !== contentHash
    ) {
      throw new ApprovalRequiredError(
        "Litigation export approval payload does not match the current artifact version and content hash.",
      );
    }
  }

  private governanceRequestMatchesLitigationCheckpoint(
    request: Record<string, any>,
    checkpoint: Record<string, any>,
  ) {
    const checkpointPayload =
      checkpoint.requested_payload &&
      typeof checkpoint.requested_payload === "object" &&
      !Array.isArray(checkpoint.requested_payload)
        ? (checkpoint.requested_payload as Record<string, unknown>)
        : parseObject(checkpoint.requested_payload);
    const requestPayload =
      request.requested_payload &&
      typeof request.requested_payload === "object" &&
      !Array.isArray(request.requested_payload)
        ? (request.requested_payload as Record<string, unknown>)
        : parseObject(request.requested_payload);
    return (
      request.action === "litigation_artifact_export" &&
      request.matter_id === checkpoint.matter_id &&
      request.requester_id === checkpointPayload.requesterId &&
      requestPayload.checkpointId === checkpoint.id &&
      requestPayload.matterId === checkpoint.matter_id &&
      requestPayload.requesterId === checkpointPayload.requesterId &&
      requestPayload.workProductId === checkpointPayload.workProductId &&
      Number(requestPayload.version) === Number(checkpointPayload.version) &&
      requestPayload.contentHash === checkpointPayload.contentHash &&
      requestPayload.approvalMode === "multi_principal_governance" &&
      requestPayload.independentApproval === true &&
      checkpointPayload.approvalMode === "multi_principal_governance" &&
      checkpointPayload.independentApproval === true
    );
  }

  private loadApprovedApprovalCheckpoint(
    ctx: AletheiaUserContext,
    matterId: string,
    checkpointId: string | null,
    action: string,
  ) {
    if (!checkpointId) return null;
    const row = this.db
      .prepare(
        `
        select * from aletheia_human_checkpoints
        where id = ?
          and matter_id = ?
          and user_id = ?
          and checkpoint_type = ?
          and status = 'approved'
      `,
      )
      .get(checkpointId, matterId, ctx.userId, action);
    return row ? this.humanCheckpoint(row) : null;
  }

  private touchMatter(userId: string, matterId: string) {
    this.db
      .prepare(
        "update aletheia_matters set updated_at = ? where id = ? and user_id = ?",
      )
      .run(now(), matterId, userId);
  }

  private sourceIndexManifest(sourceIndex: unknown) {
    const index = sourceIndex as {
      schema_version?: string;
      storage_driver?: string;
      generated_at?: string;
      documents?: Array<{ id?: string; name?: string; content_hash?: string }>;
      chunks?: unknown[];
      source_links?: Array<{
        evidence_id?: string;
        document_id?: string;
        source_chunk_id?: string;
      }>;
    };
    const documents = Array.isArray(index.documents) ? index.documents : [];
    const chunks = Array.isArray(index.chunks) ? index.chunks : [];
    const sourceLinks = Array.isArray(index.source_links)
      ? index.source_links
      : [];

    return {
      schema_version: "aletheia-source-index-manifest-local-v1",
      source_index_schema_version: index.schema_version ?? null,
      storage_driver: index.storage_driver ?? "local",
      generated_at: index.generated_at ?? now(),
      counts: {
        documents: documents.length,
        chunks: chunks.length,
        source_links: sourceLinks.length,
      },
      document_refs: documents.map((document) => ({
        id: document.id ?? null,
        name: document.name ?? null,
        content_hash: document.content_hash ?? null,
      })),
      source_link_refs: sourceLinks.map((link) => ({
        evidence_id: link.evidence_id ?? null,
        document_id: link.document_id ?? null,
        source_chunk_id: link.source_chunk_id ?? null,
      })),
      source_index_hash: exportHash(sourceIndex),
    };
  }

  private insertExportRecord(args: {
    id: string;
    matterId: string;
    userId: string;
    exportType: string;
    schemaVersion: string;
    exportHash: string;
    exportPath: string;
    approvalCheckpointId: string | null;
    gateAuthorizationStatus: string;
    sourceIndexManifest: Record<string, unknown>;
    metadata: Record<string, unknown>;
    createdAt: string;
  }) {
    this.db
      .prepare(
        `
        insert into aletheia_exports (
          id, matter_id, user_id, export_type, schema_version, export_hash,
          export_path, approval_checkpoint_id, gate_authorization_status,
          source_index_manifest, audit_event_id, metadata, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        args.id,
        args.matterId,
        args.userId,
        args.exportType,
        args.schemaVersion,
        args.exportHash,
        args.exportPath,
        args.approvalCheckpointId,
        args.gateAuthorizationStatus,
        json(args.sourceIndexManifest),
        null,
        json(args.metadata),
        args.createdAt,
      );
  }

  private attachExportAuditEvent(
    exportId: string,
    auditEventId: string | null,
  ) {
    this.db
      .prepare("update aletheia_exports set audit_event_id = ? where id = ?")
      .run(auditEventId, exportId);
  }

  private readVerifiedLocalDocxExport(
    matterId: string,
    exportPathValue: unknown,
    expectedHash: unknown,
    integrityMessage: string,
  ) {
    const fail = (): never => {
      throw new ApprovalRequiredError(integrityMessage);
    };
    if (!/^sha256:[a-f0-9]{64}$/.test(String(expectedHash ?? ""))) fail();
    let stored: Buffer;
    let exportPath: string;
    try {
      const directory = path.resolve(dataDir(), "exports", matterId);
      exportPath = path.resolve(String(exportPathValue ?? ""));
      const relative = path.relative(directory, exportPath);
      const directoryStat = lstatSync(directory);
      const fileStat = lstatSync(exportPath);
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        path.dirname(exportPath) !== directory ||
        path.extname(exportPath).toLowerCase() !== ".docx" ||
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        fileStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        path.dirname(realpathSync(exportPath)) !== realpathSync(directory)
      ) {
        fail();
      }
      stored = readFileSync(exportPath);
    } catch (error) {
      if (error instanceof ApprovalRequiredError) throw error;
      return fail();
    }
    const storedHash = `sha256:${createHash("sha256").update(stored).digest("hex")}`;
    if (storedHash !== expectedHash) fail();
    let bytes: Buffer;
    try {
      bytes = isAletheiaEnvelope(stored)
        ? decryptLocalBuffer({ envelope: stored, filePath: exportPath, purpose: "local_export" })
        : applicationEncryptionMode() === "required"
          ? fail()
          : stored;
    } catch (error) {
      if (error instanceof ApprovalRequiredError) throw error;
      return fail();
    }
    if (bytes.length < 4 || bytes.subarray(0, 2).toString("ascii") !== "PK") fail();
    return bytes;
  }

  private all(table: string, matterId: string, order = "created_at asc") {
    return this.db
      .prepare(`select * from ${table} where matter_id = ? order by ${order}`)
      .all(matterId);
  }

  private normalizeSkillCandidate(candidate: Record<string, unknown>) {
    const id = stringValue(candidate.id, 160);
    const name = stringValue(candidate.name, 240);
    const description = stringValue(candidate.description, 2000);
    const approvalStatus = stringValue(candidate.approval_status, 40);
    const evalCaseIds = stringArrayValue(
      candidate.created_from_eval_case_ids,
      160,
    );

    if (!id || !name || !description) {
      throw new ApprovalRequiredError(
        "Skill candidate approval requires id, name, and description.",
      );
    }

    return {
      id,
      name,
      description,
      trigger_conditions: stringArrayValue(candidate.trigger_conditions, 1000),
      required_inputs: stringArrayValue(candidate.required_inputs, 120),
      expected_outputs: stringArrayValue(candidate.expected_outputs, 120),
      evidence_requirements: stringArrayValue(
        candidate.evidence_requirements,
        1000,
      ),
      approval_status: approvalStatus || "candidate",
      created_from_eval_case_ids: [...new Set(evalCaseIds)].sort(),
      version: stringValue(candidate.version, 80) || "0.1.0",
    };
  }

  private approvedSkillVersion(version: string) {
    if (!version || version.startsWith("1.")) return version || "1.0.0";
    return "1.0.0";
  }

  private loadEvalCasesByIds(
    ctx: AletheiaUserContext,
    matterId: string,
    evalCaseIds: string[],
  ) {
    if (evalCaseIds.length === 0) return [];
    const placeholders = evalCaseIds.map(() => "?").join(",");
    return (
      this.db
        .prepare(
          `
          select * from aletheia_eval_cases
          where matter_id = ?
            and user_id = ?
            and id in (${placeholders})
          order by created_at asc
        `,
        )
        .all(matterId, ctx.userId, ...evalCaseIds) as any[]
    ).map((row) => this.evalCase(row));
  }

  private matter(row: any) {
    return {
      id: row.id,
      user_id: row.user_id,
      title: row.title,
      template: row.template,
      status: row.status,
      client_or_project: row.client_or_project ?? null,
      objective: row.objective,
      risk_level: row.risk_level ?? null,
      source_project_id: row.source_project_id ?? null,
      shared_with: parseArray(row.shared_with),
      metadata: parseObject(row.metadata),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private document(row: any) {
    return {
      ...row,
      document_id: row.document_id ?? null,
      summary: row.summary ?? null,
      metadata: parseObject(row.metadata),
    };
  }

  private v1DocumentRecord(row: any) {
    const metadata = parseObject(row.metadata);
    return {
      id: row.id,
      matter_id: row.matter_id,
      title: row.name,
      filename: row.name,
      document_type: row.document_type,
      status: row.parsed_status,
      uploaded_at: row.created_at,
      hash:
        typeof metadata.hash === "string"
          ? metadata.hash
          : typeof metadata.sha256 === "string"
            ? metadata.sha256
            : undefined,
      mime_type:
        typeof metadata.mimeType === "string" ? metadata.mimeType : undefined,
      byte_size:
        typeof metadata.sizeBytes === "number" ? metadata.sizeBytes : undefined,
      page_count:
        typeof metadata.pageCount === "number" ? metadata.pageCount : undefined,
      sheet_count:
        typeof metadata.sheetCount === "number"
          ? metadata.sheetCount
          : undefined,
      section_count:
        typeof metadata.sectionCount === "number"
          ? metadata.sectionCount
          : undefined,
      parser: "deterministic",
      parse_error:
        typeof metadata.parseFailureReason === "string"
          ? metadata.parseFailureReason
          : undefined,
      metadata: {
        ...redactPublicDocumentMetadata(metadata),
        local_document_id: row.document_id ?? null,
        summary: row.summary ?? null,
        source_storage_driver: "local",
      },
    };
  }

  private v1DocumentChunks(args: {
    matterId: string;
    userId: string;
    documentIds: string[];
    limit: number;
  }) {
    const placeholders = args.documentIds.map(() => "?").join(",");
    return (
      this.db
        .prepare(
          `
          select * from aletheia_document_chunks
          where matter_id = ?
            and user_id = ?
            and document_id in (${placeholders})
          order by document_id asc, chunk_index asc
          limit ?
        `,
        )
        .all(
          args.matterId,
          args.userId,
          ...args.documentIds,
          args.limit,
        ) as any[]
    ).map((row) => {
      const metadata = parseObject(row.metadata);
      return {
        id: row.id,
        matter_id: row.matter_id,
        document_id: row.document_id,
        text: row.text,
        page: row.page ?? undefined,
        section: row.section ?? undefined,
        start_offset: row.quote_start,
        end_offset: row.quote_end,
        token_count:
          typeof metadata.tokenCount === "number"
            ? metadata.tokenCount
            : undefined,
        hash:
          typeof metadata.hash === "string"
            ? metadata.hash
            : typeof metadata.sha256 === "string"
              ? metadata.sha256
              : undefined,
        metadata: {
          ...metadata,
          chunk_index: row.chunk_index,
          source_storage_driver: "local",
        },
      };
    });
  }

  private v1SourceLinks(args: {
    matterId: string;
    userId: string;
    documentIds: string[];
  }) {
    const placeholders = args.documentIds.map(() => "?").join(",");
    return (
      this.db
        .prepare(
          `
          select
            e.id as evidence_item_id,
            e.document_id,
            e.source_chunk_id,
            e.claim_id,
            e.page,
            e.section,
            e.quote,
            e.quote_start,
            e.quote_end,
            e.relevance,
            e.support_status,
            e.confidence,
            e.metadata,
            e.created_at
          from aletheia_evidence_items e
          where e.matter_id = ?
            and e.source_chunk_id is not null
            and e.document_id in (${placeholders})
          order by e.created_at asc
        `,
        )
        .all(args.matterId, ...args.documentIds) as any[]
    ).map((row) => ({
      evidence_item_id: row.evidence_item_id,
      matter_id: args.matterId,
      document_id: row.document_id,
      source_chunk_id: row.source_chunk_id,
      claim_id: row.claim_id ?? null,
      page: row.page ?? null,
      section: row.section ?? null,
      quote: row.quote,
      start_offset: row.quote_start ?? null,
      end_offset: row.quote_end ?? null,
      relevance: row.relevance,
      support_status: row.support_status,
      confidence: row.confidence ?? null,
      metadata: {
        ...parseObject(row.metadata),
        source_storage_driver: "local",
      },
      created_at: row.created_at,
    }));
  }

  private legalOpinionCover(input: CreateLegalOpinionInput["cover"]) {
    const clean = (value: unknown, maximum: number) =>
      typeof value === "string" && value.trim()
        ? value.trim().slice(0, maximum)
        : null;
    return {
      title: clean(input?.title, 240),
      addressee: clean(input?.addressee, 240),
      limitation: clean(input?.limitation, 2000),
      lawyerReference: clean(input?.lawyerReference, 240),
    };
  }

  private legalOpinionSections(answerContent: Record<string, unknown>) {
    const findings = Array.isArray(answerContent.findings)
      ? answerContent.findings.map((raw) => {
          const finding = parseObject(raw);
          return {
            conclusion: typeof finding.conclusion === "string" ? finding.conclusion : "",
            position: finding.position ?? null,
            confidence: finding.confidence ?? null,
            uncertainty: finding.uncertainty ?? null,
            citations: Array.isArray(finding.citations)
              ? finding.citations.map((citation) => {
                  const value = parseObject(citation);
                  return {
                    snapshotId: value.snapshotId ?? null,
                    sourceType: value.sourceType ?? null,
                    quote: value.quote ?? null,
                    effectiveFrom: value.effectiveFrom ?? null,
                    effectiveTo: value.effectiveTo ?? null,
                    caseVerificationStatus: value.caseVerificationStatus ?? null,
                  };
                })
              : [],
          };
        })
      : [];
    return [
      {
        heading: "意见范围",
        text: "本法律意见书仅将已采纳的本地法律研究结论按结构化方式呈现；不新增、修改或替代研究结论及引用。",
      },
      { heading: "已采纳研究结论", findings },
      {
        heading: "适用限定",
        text: "本意见书以所绑定研究备忘录、争点树、输入清单和来源快照在导出时仍然有效为前提。",
      },
    ];
  }

  private legalOpinionReviews(matterId: string, opinionId: string) {
    return this.db.prepare(
      `select id, resolution_status, resolved_by, resolved_at
         from aletheia_review_items where matter_id = ? and work_product_id = ?
         order by created_at asc`,
    ).all(matterId, opinionId) as Array<{
      id: string;
      resolution_status?: string | null;
      resolved_by?: string | null;
      resolved_at?: string | null;
    }>;
  }

  private exactReviewResolutionBindings(
    ctx: AletheiaUserContext,
    matterId: string,
    reviews: Array<{
      id: string;
      resolution_status?: string | null;
      resolved_by?: string | null;
      resolved_at?: string | null;
    }>,
  ) {
    const resolutionAudits = this.db.prepare(
      `select id, details, rowid as audit_rowid from aletheia_audit_events
         where matter_id = ? and user_id = ? and action = 'review_resolution_recorded'
         order by rowid desc`,
    ).all(matterId, ctx.userId) as Array<{
      id: string;
      details: string;
      audit_rowid: number;
    }>;
    return reviews.map((review) => {
      const resolutionAudit = resolutionAudits.find((event) => {
        const details = parseObject(event.details);
        return details.reviewId === review.id;
      });
      const resolutionDetails = parseObject(resolutionAudit?.details);
      if (
        !resolutionAudit ||
        resolutionDetails.status !== review.resolution_status ||
        !review.resolved_by ||
        !review.resolved_at
      ) {
        throw new ApprovalRequiredError(
          "Every accepted review must match its latest recorded resolution audit.",
        );
      }
      return {
        reviewId: review.id,
        status: review.resolution_status,
        resolvedBy: review.resolved_by,
        resolvedAt: review.resolved_at,
        resolutionAuditEventId: resolutionAudit.id,
        resolutionAuditRowId: Number(resolutionAudit.audit_rowid),
      };
    });
  }

  private assertEligibleAcceptedLegalResearchMemo(
    ctx: AletheiaUserContext,
    matterId: string,
    answerId: string,
    options: { requireExactApprovalAudit?: boolean } = {},
  ): Record<string, any> & {
    reviewIds: string[];
    reviewBindings: Array<Record<string, unknown>>;
    approvalAuditEventId: string;
  } {
    const answer = this.db.prepare(
      `select * from aletheia_work_products where id = ? and matter_id = ? and user_id = ? and kind = 'legal_qa_answer'`,
    ).get(answerId, matterId, ctx.userId) as Record<string, any> | undefined;
    if (!answer) throw new ApprovalRequiredError("A matter-scoped accepted legal research memo is required.");
    const content = parseObject(answer.content);
    if (
      answer.status !== "accepted" || answer.stale_at ||
      answer.schema_version !== "vera-legal-research-memo-v1" ||
      content.schemaVersion !== "vera-legal-research-memo-v1" ||
      parseObject(content.gate).status !== "ready_for_review" ||
      !/^sha256:[a-f0-9]{64}$/.test(String(answer.content_hash ?? "")) ||
      exportHash(content) !== answer.content_hash
    ) {
      throw new ApprovalRequiredError("The legal research memo is not accepted, current, and hash-verified.");
    }
    this.assertCurrentLegalResearchMemo(ctx, matterId, answerId, answer);
    const reviews = this.db.prepare(
      `select id, resolution_status, resolved_by, resolved_at from aletheia_review_items
         where matter_id = ? and work_product_id = ? order by created_at asc`,
    ).all(matterId, answerId) as Array<{
      id: string; resolution_status?: string | null; resolved_by?: string | null; resolved_at?: string | null;
    }>;
    if (!reviews.length || reviews.some((review) => review.resolution_status !== "accepted" || !review.resolved_by || !review.resolved_at)) {
      throw new ApprovalRequiredError("Every legal research memo review must be explicitly accepted before DOCX export or opinion use.");
    }
    const reviewIds = reviews.map((review) => review.id);
    const reviewBindings = this.exactReviewResolutionBindings(ctx, matterId, reviews);
    const approvalAudits = this.db.prepare(
      `select id, details, rowid as audit_rowid from aletheia_audit_events where matter_id = ? and user_id = ? and action = 'legal_qa_answer_approved' order by rowid desc`,
    ).all(matterId, ctx.userId) as Array<{
      id: string;
      details: string;
      audit_rowid: number;
    }>;
    const exactApprovalAudit = approvalAudits.find((event) => {
      const details = parseObject(event.details);
      return (
        details.answerWorkProductId === answerId &&
        details.answerContentHash === answer.content_hash &&
        Number(details.version) === Number(answer.version) &&
        stableJson(details.reviewIds) === stableJson(reviewIds) &&
        stableJson(details.reviewStatuses) === stableJson(reviews.map((review) => review.resolution_status)) &&
        stableJson(details.reviewBindings) === stableJson(reviewBindings)
      );
    });
    const approvalAudit = exactApprovalAudit ?? (
      options.requireExactApprovalAudit === false
        ? approvalAudits.find((event) => {
            const details = parseObject(event.details);
            return (
              details.answerWorkProductId === answerId &&
              details.answerContentHash === undefined &&
              details.version === undefined &&
              details.reviewBindings === undefined &&
              stableJson(details.reviewIds) === stableJson(reviewIds) &&
              Number(event.audit_rowid) > Math.max(
                ...reviewBindings.map((binding) => Number(binding.resolutionAuditRowId)),
              )
            );
          })
        : undefined
    );
    if (!approvalAudit) throw new ApprovalRequiredError("The accepted legal research memo has no exact approval audit record.");
    return {
      ...answer,
      reviewIds,
      reviewBindings,
      approvalAuditEventId: approvalAudit.id,
    } as Record<string, any> & {
      reviewIds: string[];
      reviewBindings: Array<Record<string, unknown>>;
      approvalAuditEventId: string;
    };
  }

  private legalResearchMemoExportBinding(
    memo: Record<string, any> & {
      reviewIds: string[];
      reviewBindings: Array<Record<string, unknown>>;
      approvalAuditEventId: string;
    },
  ) {
    const content = parseObject(memo.content);
    const stringOrNull = (value: unknown) =>
      typeof value === "string" && value ? value : null;
    return {
      memoId: String(memo.id),
      version: Number(memo.version),
      contentHash: String(memo.content_hash),
      gateStatus: stringOrNull(parseObject(content.gate).status),
      requestId: stringOrNull(content.requestId),
      inputManifestId: stringOrNull(content.inputManifestId),
      inputBindingHash: stringOrNull(content.inputBindingHash),
      issueTreeId: stringOrNull(content.issueTreeId),
      issueTreeHash: stringOrNull(content.issueTreeHash),
      caseContextId: stringOrNull(content.caseContextId),
      caseContextHash: stringOrNull(content.caseContextHash),
      caseContextContentHash: stringOrNull(content.caseContextContentHash),
      sourceSnapshots: Array.isArray(content.sourceSnapshots)
        ? content.sourceSnapshots
        : [],
      reviewIds: memo.reviewIds,
      reviewBindings: memo.reviewBindings,
      approvalAuditEventId: memo.approvalAuditEventId,
    };
  }

  private loadLegalOpinion(
    ctx: AletheiaUserContext,
    matterId: string,
    opinionId: string,
  ) {
    const opinion = this.db.prepare(
      `select * from aletheia_work_products where id = ? and matter_id = ? and user_id = ? and kind = 'legal_opinion'`,
    ).get(opinionId, matterId, ctx.userId) as Record<string, any> | undefined;
    if (!opinion) throw new ApprovalRequiredError("The matter-scoped legal opinion was not found.");
    const content = parseObject(opinion.content);
    if (
      opinion.schema_version !== "vera-legal-opinion-v1" ||
      content.schemaVersion !== "vera-legal-opinion-v1" ||
      !/^sha256:[a-f0-9]{64}$/.test(String(opinion.content_hash ?? "")) ||
      exportHash(content) !== opinion.content_hash
    ) throw new ApprovalRequiredError("The legal opinion record is malformed or its content hash does not match.");
    return opinion;
  }

  private assertCurrentLegalOpinion(
    ctx: AletheiaUserContext,
    matterId: string,
    opinion: Record<string, any>,
  ) {
    const stale = (reason: string): never => {
      const timestamp = now();
      this.db.prepare(
        `update aletheia_work_products set stale_at = coalesce(stale_at, ?), stale_reason = ?, updated_at = ?
           where id = ? and matter_id = ? and user_id = ?`,
      ).run(timestamp, reason, timestamp, opinion.id, matterId, ctx.userId);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "system", action: "legal_opinion_marked_stale", workflowVersion: "vera-legal-opinion-v1", model: null,
        details: { opinionId: opinion.id, reason },
      });
      throw new ApprovalRequiredError("The legal opinion is stale because its accepted research binding is no longer current.");
    };
    if (opinion.stale_at) stale(String(opinion.stale_reason ?? "The opinion was previously marked stale."));
    const content = parseObject(opinion.content);
    const binding = parseObject(content.answerBinding);
    const answerId = typeof binding.answerId === "string" ? binding.answerId : "";
    if (!answerId) stale("The answer binding is missing.");
    let answer: Record<string, any> & { reviewIds?: string[]; approvalAuditEventId?: string };
    try {
      answer = this.assertEligibleAcceptedLegalResearchMemo(ctx, matterId, answerId, {
        requireExactApprovalAudit: false,
      });
    } catch {
      stale("The answer, source, input manifest, issue tree, review, or approval binding is no longer valid.");
    }
    if (
      binding.answerContentHash !== answer!.content_hash ||
      Number(binding.answerVersion) !== Number(answer!.version) ||
      binding.issueTreeId !== parseObject(answer!.content).issueTreeId ||
      binding.issueTreeHash !== parseObject(answer!.content).issueTreeHash ||
      binding.inputManifestId !== parseObject(answer!.content).inputManifestId ||
      binding.inputBindingHash !== parseObject(answer!.content).inputBindingHash ||
      stableJson(binding.sourceSnapshots) !== stableJson(parseObject(answer!.content).sourceSnapshots) ||
      stableJson(binding.answerReviewIds) !== stableJson(answer!.reviewIds) ||
      binding.answerApprovalAuditEventId !== answer!.approvalAuditEventId ||
      exportHash(binding) !== opinion.dependency_hash
    ) stale("The legal opinion does not match its exact accepted research binding.");
    return answer!;
  }

  private assertLegalOpinionApprovalAudit(
    ctx: AletheiaUserContext,
    matterId: string,
    opinion: Record<string, any>,
  ) {
    if (opinion.status !== "accepted" || opinion.stale_at) {
      throw new ApprovalRequiredError("An accepted, current legal opinion is required for DOCX export.");
    }
    const reviews = this.legalOpinionReviews(matterId, String(opinion.id));
    const boundReviewIds = parseObject(parseObject(opinion.content).reviewBindings).opinionReviewIds;
    if (
      !reviews.length ||
      reviews.some((review) => review.resolution_status !== "accepted" || !review.resolved_by || !review.resolved_at) ||
      stableJson(reviews.map((review) => review.id)) !== stableJson(boundReviewIds)
    ) {
      throw new ApprovalRequiredError(
        "The legal opinion review binding is incomplete, changed, or not explicitly accepted.",
      );
    }
    const reviewBindings = this.exactReviewResolutionBindings(ctx, matterId, reviews);
    const audit = (this.db.prepare(
      `select id, details, rowid as audit_rowid from aletheia_audit_events where matter_id = ? and user_id = ? and action = 'legal_opinion_approved' order by rowid desc`,
    ).all(matterId, ctx.userId) as Array<{
      id: string;
      details: string;
      audit_rowid: number;
    }>).find((event) => {
      const details = parseObject(event.details);
      const baseBindingMatches =
        details.opinionId === opinion.id &&
        details.opinionContentHash === opinion.content_hash &&
        Number(details.version) === Number(opinion.version) &&
        stableJson(details.reviewIds) === stableJson(reviews.map((review) => review.id));
      if (!baseBindingMatches) return false;
      if (stableJson(details.reviewBindings) === stableJson(reviewBindings)) return true;
      return (
        details.reviewBindings === undefined &&
        Number(event.audit_rowid) > Math.max(
          ...reviewBindings.map((binding) => Number(binding.resolutionAuditRowId)),
        )
      );
    });
    if (!audit) throw new ApprovalRequiredError("The legal opinion has no exact lawyer-approval audit record.");
    return audit;
  }

  /**
   * A research memo binds to the exact source bytes and reviewed-input manifest
   * used when it was created. Refreshing an authority with changed content
   * makes the old memo stale before any human can accept it.
   */
  private assertCurrentLegalResearchMemo(
    ctx: AletheiaUserContext,
    matterId: string,
    answerId: string,
    answer: { content?: string },
  ) {
    const content = parseObject(answer.content);
    if (content.schemaVersion !== "vera-legal-research-memo-v1") return;

    const stale = (reason: string): never => {
      const timestamp = now();
      this.db
        .prepare(
          `update aletheia_work_products
              set stale_at = coalesce(stale_at, ?), stale_reason = ?
            where id = ? and matter_id = ? and user_id = ?`,
        )
        .run(timestamp, reason, answerId, matterId, ctx.userId);
      this.writeAuditEvent(ctx.userId, matterId, {
        actor: "system",
        action: "legal_research_memo_marked_stale",
        workflowVersion: "vera-legal-research-memo-v1",
        model: null,
        details: { answerId, reason },
      });
      throw new ApprovalRequiredError(
        reason.toLowerCase().includes("case context")
          ? "The legal research case context changed. Rebuild and review the memo before approval."
          : "Legal research sources, issue tree, or reviewed input binding changed. Rebuild and review the memo before approval.",
      );
    };

    const gate = parseObject(content.gate);
    if (gate.status !== "ready_for_review") {
      stale("The legal research citation gate did not pass.");
    }
    const inputManifestId =
      typeof content.inputManifestId === "string" ? content.inputManifestId : "";
    const inputBindingHash =
      typeof content.inputBindingHash === "string" ? content.inputBindingHash : "";
    if (!inputManifestId || !inputBindingHash) {
      stale("The legal research input manifest binding is missing.");
    }
    const manifest = this.db
      .prepare(
        `select content, status, stale_at, schema_version from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ?
            and kind = 'legal_research_input_manifest'`,
      )
      .get(inputManifestId, matterId, ctx.userId) as
      | { content?: string; status?: string; stale_at?: string | null; schema_version?: string }
      | undefined;
    const manifestContent = parseObject(manifest?.content);
    if (
      !manifest ||
      manifest.status !== "accepted" ||
      manifest.stale_at ||
      manifest.schema_version !== "vera-legal-research-input-manifest-v1" ||
      manifestContent.bindingHash !== inputBindingHash
    ) {
      stale("The legal research input manifest no longer matches the memo.");
    }

    const requestId = typeof content.requestId === "string" ? content.requestId : "";
    const issueTreeId = typeof content.issueTreeId === "string" ? content.issueTreeId : "";
    const issueTreeHash = typeof content.issueTreeHash === "string" ? content.issueTreeHash : "";
    if (!requestId || !issueTreeId || !issueTreeHash) {
      stale("The legal research issue-tree binding is missing.");
    }
    if (
      manifestContent.issueTreeId !== issueTreeId ||
      manifestContent.issueTreeHash !== issueTreeHash
    ) {
      stale("The legal research input manifest no longer matches the memo issue tree.");
    }

    const caseContextId = String(content.caseContextId ?? "");
    const caseContextHash = String(content.caseContextHash ?? "");
    const caseContextContentHash = String(content.caseContextContentHash ?? "");
    const v2BindingPresent = Boolean(
      caseContextId ||
      caseContextHash ||
      caseContextContentHash ||
      manifestContent.caseContextId ||
      manifestContent.caseContextHash ||
      manifestContent.caseContextContentHash,
    );
    if (v2BindingPresent) {
      if (!caseContextId || !caseContextHash || !caseContextContentHash) {
        stale("The legal research case context binding is incomplete.");
      }
      if (
        manifestContent.caseContextId !== caseContextId ||
        manifestContent.caseContextHash !== caseContextHash ||
        manifestContent.caseContextContentHash !== caseContextContentHash
      ) {
        stale("The legal research case context binding no longer matches the input manifest.");
      }
      const request = this.db.prepare(
        `select content, schema_version from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ? and kind = 'legal_research_request'`,
      ).get(requestId, matterId, ctx.userId) as { content?: string; schema_version?: string } | undefined;
      const requestContent = parseObject(request?.content);
      if (
        !request ||
        request.schema_version !== "vera-legal-research-request-v2" ||
        requestContent.schemaVersion !== "vera-legal-research-request-v2" ||
        requestContent.caseContextId !== caseContextId ||
        requestContent.caseContextHash !== caseContextHash ||
        requestContent.caseContextContentHash !== caseContextContentHash
      ) {
        stale("The legal research request no longer matches the case context binding.");
      }
      const context = this.db.prepare(
        `select content, content_hash, status, schema_version from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ? and kind = 'legal_research_case_context'`,
      ).get(caseContextId, matterId, ctx.userId) as
        | { content?: string; content_hash?: string; status?: string; schema_version?: string }
        | undefined;
      const contextContent = parseObject(context?.content);
      const contextItems = parseObject(contextContent.items);
      if (
        !context ||
        context.status !== "accepted" ||
        context.schema_version !== "vera-legal-research-case-context-v1" ||
        contextContent.schemaVersion !== "vera-legal-research-case-context-v1" ||
        contextContent.contextHash !== caseContextHash ||
        context.content_hash !== caseContextContentHash ||
        exportHash(contextContent) !== caseContextContentHash
      ) {
        stale("The immutable legal research case context is no longer valid.");
      }
      const currentSource = (sourceSpanId: string) => {
        const row = this.db.prepare(
          `select s.id, s.document_id, s.document_name, s.page, s.section, s.quote,
                  s.source_chunk_sha256, s.quote_sha256, s.chunk_quote_start,
                  s.chunk_quote_end, c.text as current_chunk_text,
                  (select v.id from aletheia_source_span_verifications v
                    where v.matter_id = s.matter_id and v.user_id = s.user_id
                      and v.source_span_id = s.id and v.source_chunk_sha256 = s.source_chunk_sha256
                      and v.quote_sha256 = s.quote_sha256 and not exists (
                        select 1 from aletheia_source_span_verification_withdrawals w
                         where w.verification_id = v.id and w.matter_id = v.matter_id and w.user_id = v.user_id
                      ) order by v.verified_at desc limit 1) as current_verification_id
             from aletheia_source_spans s
             join aletheia_document_chunks c on c.id = s.source_chunk_id
              and c.matter_id = s.matter_id and c.user_id = s.user_id
            where s.id = ? and s.matter_id = ? and s.user_id = ?`,
        ).get(sourceSpanId, matterId, ctx.userId) as Record<string, unknown> | undefined;
        if (!row) return null;
        const chunkText = String(row.current_chunk_text ?? "");
        const currentQuote = chunkText.slice(Number(row.chunk_quote_start), Number(row.chunk_quote_end));
        const source = {
          sourceSpanId: String(row.id),
          documentId: String(row.document_id ?? ""),
          documentName: String(row.document_name ?? ""),
          page: row.page ?? null,
          section: row.section ?? null,
          quote: String(row.quote ?? ""),
          quoteSha256: String(row.quote_sha256 ?? ""),
          sourceChunkSha256: String(row.source_chunk_sha256 ?? ""),
          currentVerificationId: typeof row.current_verification_id === "string"
            ? row.current_verification_id
            : null,
        };
        if (
          !source.documentId || !source.documentName || !source.quote ||
          source.quote !== currentQuote ||
          source.quoteSha256 !== createHash("sha256").update(currentQuote).digest("hex") ||
          source.sourceChunkSha256 !== createHash("sha256").update(chunkText).digest("hex")
        ) return null;
        return source;
      };
      const factItems = Array.isArray(contextItems.facts) ? contextItems.facts : [];
      const eventItems = Array.isArray(contextItems.proceduralEvents)
        ? contextItems.proceduralEvents
        : [];
      if (factItems.length + eventItems.length < 1 || factItems.length + eventItems.length > 40) {
        stale("The legal research case context item count is invalid.");
      }
      const currentFacts = factItems.map((rawFact) => {
        const expected = parseObject(rawFact);
        const fact = this.db.prepare(
          `select id, statement, occurred_at, helpfulness, confidence, status
             from aletheia_litigation_facts where id = ? and matter_id = ? and user_id = ?`,
        ).get(String(expected.id ?? ""), matterId, ctx.userId) as Record<string, unknown> | undefined;
        if (!fact || fact.status !== "confirmed") return null;
        const sourceRows = this.db.prepare(
          `select source_span_id from aletheia_litigation_fact_sources
            where matter_id = ? and fact_id = ? order by source_span_id asc`,
        ).all(matterId, fact.id) as Array<Record<string, unknown>>;
        const evidence = sourceRows.map((row) => currentSource(String(row.source_span_id)));
        if (!evidence.length || evidence.some((source) => !source)) return null;
        const item = {
          id: String(fact.id), statement: String(fact.statement ?? ""),
          occurredAt: fact.occurred_at ?? null, helpfulness: fact.helpfulness ?? null,
          confidence: fact.confidence ?? null, evidence: evidence as Array<Record<string, unknown>>,
        };
        return { ...item, factHash: exportHash(item) };
      }).sort((left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? "")));
      const currentEvents = eventItems.map((rawEvent) => {
        const expected = parseObject(rawEvent);
        const event = this.db.prepare(
          `select id, event_type, title, occurred_at, primary_source_span_id, status,
                  event_version, event_lineage_hash, superseded_by_event_id, superseded_at
             from aletheia_litigation_procedural_events where id = ? and matter_id = ? and user_id = ?`,
        ).get(String(expected.id ?? ""), matterId, ctx.userId) as Record<string, unknown> | undefined;
        if (
          !event ||
          event.status !== "confirmed" ||
          event.superseded_by_event_id ||
          event.superseded_at ||
          !event.primary_source_span_id
        ) return null;
        const source = currentSource(String(event.primary_source_span_id));
        if (!source) return null;
        const item = {
          id: String(event.id), eventType: String(event.event_type ?? ""),
          title: String(event.title ?? ""), occurredAt: event.occurred_at ?? null,
          primarySourceSpanId: String(event.primary_source_span_id), source,
          eventVersion: Number(event.event_version ?? 0),
          eventLineageHash: String(event.event_lineage_hash ?? ""),
        };
        return { ...item, eventHash: exportHash(item) };
      }).sort((left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? "")));
      const currentItems = { facts: currentFacts, proceduralEvents: currentEvents };
      if (
        currentFacts.some((item) => !item) ||
        currentEvents.some((item) => !item) ||
        stableJson(currentItems) !== stableJson(contextItems) ||
        exportHash(currentItems) !== caseContextHash
      ) {
        stale("The legal research case context changed after the memo was prepared.");
      }
    }
    const issueTreeRows = this.db
      .prepare(
        `select id, content, version, created_at from aletheia_work_products
          where matter_id = ? and user_id = ? and kind = 'legal_research_issue_tree'`,
      )
      .all(matterId, ctx.userId) as Array<{
      id: string;
      content?: string;
      version?: number | null;
      created_at?: string;
    }>;
    const issueTrees = issueTreeRows.flatMap((row) => {
      const treeContent = parseObject(row.content);
      if (
        treeContent.schemaVersion !== LEGAL_ISSUE_TREE_SCHEMA ||
        treeContent.requestId !== requestId
      ) return [];
      try {
        const tree = validateLegalIssueTree(treeContent.tree);
        if (parseObject(treeContent.tree).treeHash !== tree.treeHash) return [];
        return [{
          id: row.id,
          treeHash: tree.treeHash,
          version: Number(row.version ?? 0),
          createdAt: String(row.created_at ?? ""),
        }];
      } catch {
        return [];
      }
    });
    const currentIssueTree = issueTrees.sort((left, right) =>
      right.version - left.version || right.createdAt.localeCompare(left.createdAt),
    )[0];
    if (
      !currentIssueTree ||
      currentIssueTree.id !== issueTreeId ||
      currentIssueTree.treeHash !== issueTreeHash
    ) {
      stale("The local legal issue tree changed after the memo was prepared.");
    }

    const sourceSnapshots = Array.isArray(content.sourceSnapshots)
      ? content.sourceSnapshots
      : [];
    if (sourceSnapshots.length === 0) {
      stale("The legal research memo has no bound source snapshots.");
    }
    const latestByIdentity = new Map<
      string,
      { contentHash: string; version: number; createdAt: string }
    >();
    const rows = this.db
      .prepare(
        `select content, version, created_at from aletheia_work_products
          where matter_id = ? and user_id = ? and kind = 'external_source_workpaper'`,
      )
      .all(matterId, ctx.userId) as Array<{
      content?: string;
      version?: number | null;
      created_at?: string;
    }>;
    for (const row of rows) {
      const snapshotContent = parseObject(row.content);
      const sourceIdentity =
        typeof snapshotContent.sourceIdentity === "string"
          ? snapshotContent.sourceIdentity
          : "";
      const snapshot = parseObject(snapshotContent.snapshot);
      const contentHash =
        typeof snapshot.contentHash === "string" ? snapshot.contentHash : "";
      if (!sourceIdentity || !contentHash) continue;
      const candidate = {
        contentHash,
        version: Number(row.version ?? 0),
        createdAt: String(row.created_at ?? ""),
      };
      const current = latestByIdentity.get(sourceIdentity);
      if (
        !current ||
        candidate.version > current.version ||
        (candidate.version === current.version && candidate.createdAt > current.createdAt)
      ) {
        latestByIdentity.set(sourceIdentity, candidate);
      }
    }
    for (const item of sourceSnapshots) {
      const snapshot = parseObject(item);
      const sourceIdentity =
        typeof snapshot.sourceIdentity === "string" ? snapshot.sourceIdentity : "";
      const contentHash =
        typeof snapshot.contentHash === "string" ? snapshot.contentHash : "";
      if (!sourceIdentity || !contentHash) {
        stale("The legal research memo source binding is malformed.");
      }
      if (latestByIdentity.get(sourceIdentity)?.contentHash !== contentHash) {
        stale("A cited legal source has changed since the memo was prepared.");
      }
    }
  }

  private workProduct(row: any) {
    return {
      ...row,
      model: row.model ?? null,
      version: Number(row.version ?? 1),
      parent_work_product_id: row.parent_work_product_id ?? null,
      content_hash: row.content_hash ?? exportHash(parseObject(row.content)),
      dependency_hash: row.dependency_hash ?? null,
      stale_at: row.stale_at ?? null,
      stale_reason: row.stale_reason ?? null,
      content: parseObject(row.content),
      validation_errors: parseArray(row.validation_errors),
    };
  }

  private evidence(row: any) {
    return {
      ...row,
      work_product_id: row.work_product_id ?? null,
      document_id: row.document_id ?? null,
      source_chunk_id: row.source_chunk_id ?? null,
      claim_id: row.claim_id ?? null,
      document_name: row.document_name ?? null,
      page: row.page ?? null,
      section: row.section ?? null,
      quote_start: row.quote_start ?? null,
      quote_end: row.quote_end ?? null,
      confidence: row.confidence ?? null,
      metadata: parseObject(row.metadata),
    };
  }

  private review(row: any) {
    return {
      ...row,
      work_product_id: row.work_product_id ?? null,
      evidence_item_id: row.evidence_item_id ?? null,
      reviewer_user_id: row.reviewer_user_id ?? null,
      reviewer_name: row.reviewer_name ?? null,
      resolution_status: row.resolution_status ?? "open",
      resolution_comment: row.resolution_comment ?? null,
      resolved_by: row.resolved_by ?? null,
      resolved_at: row.resolved_at ?? null,
    };
  }

  private evalCase(row: any) {
    return {
      ...row,
      source_audit_event_id: row.source_audit_event_id ?? null,
      input_snapshot: parseObject(row.input_snapshot),
      metadata: parseObject(row.metadata),
    };
  }

  private auditEvent(row: any) {
    return {
      ...row,
      user_id: row.user_id ?? null,
      workflow_version: row.workflow_version ?? null,
      model: row.model ?? null,
      details: parseObject(row.details),
    };
  }

  private agentRun(row: any) {
    return {
      ...row,
      current_step_key: row.current_step_key ?? null,
      model_profile: row.model_profile ?? null,
      budget: parseObject(row.budget),
      metadata: parseObject(row.metadata),
      started_at: row.started_at ?? null,
      completed_at: row.completed_at ?? null,
    };
  }

  private agentRunWithTrace(row: any) {
    const run = this.agentRun(row);
    return {
      ...run,
      steps: this.db
        .prepare(
          "select * from aletheia_agent_steps where run_id = ? order by sequence asc",
        )
        .all(run.id)
        .map((step) => this.agentStep(step)),
      tool_calls: this.db
        .prepare(
          "select * from aletheia_tool_calls where run_id = ? order by created_at asc",
        )
        .all(run.id)
        .map((call) => this.toolCall(call)),
      human_checkpoints: this.db
        .prepare(
          "select * from aletheia_human_checkpoints where run_id = ? order by created_at asc",
        )
        .all(run.id)
        .map((checkpoint) => this.humanCheckpoint(checkpoint)),
    };
  }

  private agentStep(row: any) {
    return {
      ...row,
      input: parseObject(row.input),
      output: parseObject(row.output),
      validation_errors: parseArray(row.validation_errors),
      metrics: parseObject(row.metrics),
      started_at: row.started_at ?? null,
      completed_at: row.completed_at ?? null,
    };
  }

  private toolCall(row: any) {
    return {
      ...row,
      step_id: row.step_id ?? null,
      input: parseObject(row.input),
      output: parseObject(row.output),
      error: row.error ?? null,
      metrics: parseObject(row.metrics),
      started_at: row.started_at ?? null,
      completed_at: row.completed_at ?? null,
    };
  }

  private humanCheckpoint(row: any) {
    return {
      ...row,
      step_id: row.step_id ?? null,
      decision: row.decision ?? null,
      requested_payload: parseObject(row.requested_payload),
      decision_payload: parseObject(row.decision_payload),
      decided_by: row.decided_by ?? null,
      decided_at: row.decided_at ?? null,
    };
  }

  private matterMemory(row: any) {
    return {
      ...row,
      metadata: parseObject(row.metadata),
    };
  }

  private playbook(row: any) {
    return {
      ...row,
      description: row.description ?? null,
      content: parseObject(row.content),
      approved_by: row.approved_by ?? null,
      approved_at: row.approved_at ?? null,
    };
  }
}
