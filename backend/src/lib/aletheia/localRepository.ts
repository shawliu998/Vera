import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  chunkMatterDocument,
  documentTypeForFilename,
  extractMatterDocument,
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
} from "./repository";
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
  CreateAgentRunInput,
  CreateEvidenceItemInput,
  CreateMatterInput,
  CreatePlaybookInput,
  ProposePlaybookImprovementInput,
  CreateWorkProductInput,
  DecideApprovalInput,
  ListV1SourceIndexInput,
  PersistGateSnapshotInput,
  ResumeAgentRunInput,
  RequestApprovalInput,
  SearchMatterDocumentsInput,
  UploadMatterDocumentInput,
} from "./repository";

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

let singletonDb: DatabaseSync | null = null;

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

function parseObject(value: unknown): JsonObject {
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

function ensureLocalDirs(root: string) {
  for (const dir of [
    root,
    path.join(root, "documents"),
    path.join(root, "exports"),
    path.join(root, "index"),
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function safeFilePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function localExportPath(args: {
  root: string;
  matterId: string;
  workProductId: string;
  kind: string;
  title: string;
}) {
  const matterDir = path.join(args.root, "exports", args.matterId);
  if (!existsSync(matterDir)) mkdirSync(matterDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const title = safeFilePart(args.title) || args.kind;
  return path.join(
    matterDir,
    `${timestamp}-${args.kind}-${title}-${args.workProductId}.json`,
  );
}

function shouldPersistLocalExport(kind: string) {
  return [
    "audit_pack",
    "feedback_export",
    "final_memo",
    "registry_snapshot",
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
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 360);
}

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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
  db: DatabaseSync,
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

function openDb() {
  if (singletonDb) return singletonDb;
  const root = dataDir();
  ensureLocalDirs(root);
  singletonDb = new DatabaseSync(path.join(root, "aletheia.db"));
  singletonDb.exec("PRAGMA journal_mode = WAL");
  singletonDb.exec("PRAGMA foreign_keys = ON");
  singletonDb.exec(localSchema);
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
  return singletonDb;
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
  created_at text not null
);

create table if not exists aletheia_audit_events (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text,
  actor text not null,
  action text not null,
  workflow_version text,
  model text,
  details text not null default '{}',
  created_at text not null
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

  async listMatters(ctx: AletheiaUserContext): Promise<unknown[]> {
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
        where m.user_id = ?
        order by m.updated_at desc
      `,
      )
      .all(ctx.userId);
    return rows.map((row) => ({
      ...this.matter(row),
      document_count: Number(row.document_count ?? 0),
      evidence_count: Number(row.evidence_count ?? 0),
      review_count: Number(row.review_count ?? 0),
      audit_event_count: Number(row.audit_event_count ?? 0),
      latest_audit_at: row.latest_audit_at ?? null,
    }));
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

    await this.writeAuditEvent(ctx.userId, matter.id, {
      actor: "human",
      action: "matter_created",
      workflowVersion: "aletheia-v0",
      model: null,
      details: { template: input.template, status: input.status },
    });
    await this.createInitialAgentPlan(ctx.userId, {
      matterId: matter.id,
      template: input.template,
      objective: input.objective,
      riskLevel: input.riskLevel,
    });
    return matter;
  }

  async getMatterDetail(ctx: AletheiaUserContext, matterId: string) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    return {
      matter,
      documents: this.all("aletheia_matter_documents", matterId).map((row) =>
        this.document(row),
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
      auditEvents: this.all(
        "aletheia_audit_events",
        matterId,
        "created_at desc",
      ).map((row) => this.auditEvent(row)),
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
        "Supabase V1 document retrieval/listing is not implemented for the private pilot.",
      ],
    };
  }

  async createWorkProduct(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateWorkProductInput,
  ) {
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const approvalAction =
      input.kind === "audit_pack"
        ? "audit_pack_export"
        : input.kind === "feedback_export"
          ? "feedback_dataset_export"
          : input.kind === "final_memo"
            ? "final_memo_export"
            : null;
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
        timestamp,
        timestamp,
      );
    const exportPath = shouldPersistLocalExport(input.kind)
      ? localExportPath({
          root: dataDir(),
          matterId,
          workProductId: id,
          kind: input.kind,
          title: input.title,
        })
      : null;
    if (exportPath) {
      writeFileSync(
        exportPath,
        JSON.stringify(
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
        "utf8",
      );
    }
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: input.generatedBy,
      action: auditActionForWorkProduct(input.kind),
      workflowVersion: input.schemaVersion,
      model: input.model,
      details: {
        workProductId: id,
        kind: input.kind,
        title: input.title,
        status: input.status,
        approvalCheckpointId: input.approvalCheckpointId ?? null,
        exportPath,
        gateSnapshotAuditEventId:
          gateEvidence?.gateSnapshotAuditEventId ?? null,
        gateAuthorizationAuditEventId:
          gateEvidence?.gateAuthorizationAuditEventId ?? null,
      },
    });
    this.touchMatter(ctx.userId, matterId);
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
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const timestamp = now();
    let runId = this.latestAgentRunId(matterId, ctx.userId);
    if (!runId) {
      await this.createAgentRun(ctx, matterId, {
        workflow: matter.template,
        goal: `Approval gate for ${input.action}`,
        status: "queued",
        metadata: { source: "approval_request", action: input.action },
      });
      runId = this.latestAgentRunId(matterId, ctx.userId);
    }
    if (!runId) return null;

    const existing = this.db
      .prepare(
        `
        select * from aletheia_human_checkpoints
        where matter_id = ?
          and user_id = ?
          and checkpoint_type = ?
          and status = 'open'
        order by created_at desc
        limit 1
      `,
      )
      .get(matterId, ctx.userId, input.action);
    if (existing) return this.humanCheckpoint(existing);

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
        ctx.userId,
        input.action,
        "open",
        input.prompt ??
          `Approve ${input.action.replaceAll("_", " ")} before execution.`,
        null,
        json({
          action: input.action,
          matterId,
          ...(input.requestedPayload ?? {}),
        }),
        "{}",
        null,
        null,
        timestamp,
      );
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "approval_requested",
      workflowVersion: "aletheia-approval-v0",
      model: null,
      details: { checkpointId: id, action: input.action },
    });
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
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const checkpoint = this.db
      .prepare(
        `
        select * from aletheia_human_checkpoints
        where id = ?
          and matter_id = ?
          and user_id = ?
      `,
      )
      .get(checkpointId, matterId, ctx.userId) as any | undefined;
    if (!checkpoint) return null;
    if (
      ![
        "audit_pack_export",
        "feedback_dataset_export",
        "final_memo_export",
      ].includes(checkpoint.checkpoint_type)
    ) {
      throw new ApprovalRequiredError(
        "Only high-risk approval checkpoints can be decided here.",
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
        }),
        ctx.userId,
        timestamp,
        checkpointId,
      );
    await this.writeAuditEvent(ctx.userId, matterId, {
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
      },
    });
    return this.humanCheckpoint(
      this.db
        .prepare("select * from aletheia_human_checkpoints where id = ?")
        .get(checkpointId),
    );
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
          target_id, tag, comment, reviewer_user_id, reviewer_name, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        this.db
          .prepare(
            `
            insert into aletheia_audit_events (
              id, matter_id, user_id, actor, action, workflow_version, model,
              details, created_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            event.id,
            event.matter_id,
            event.user_id,
            event.actor,
            event.action,
            event.workflow_version,
            event.model,
            json(event.details),
            event.created_at,
          );
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
    if (
      checkpoint.status !== "resolved" ||
      !["edited", "responded"].includes(String(checkpoint.decision))
    ) {
      throw new ApprovalRequiredError(
        "Only edited or responded checkpoints can resume an agent run.",
      );
    }

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
    const revisedDraft: any = await this.generateDraftMemo(ctx, matterId);
    const stepId = randomUUID();
    const stepSequence = Number(latestSequence?.sequence ?? 0) + 1;
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
    const matter = this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const id = randomUUID();
    const timestamp = now();
    const root = dataDir();
    const filePath = await writeMatterDocumentFile({
      documentsDir: path.join(root, "documents"),
      documentId: id,
      filename: input.filename,
      buffer: input.buffer,
    });

    let parsedText = "";
    let parserMetadata: Record<string, unknown> = {};
    let extractionFailed = false;
    try {
      const extracted = await extractMatterDocument({
        filename: input.filename,
        buffer: input.buffer,
      });
      parsedText = extracted.text;
      parserMetadata = extracted.metadata;
    } catch {
      extractionFailed = true;
    }
    const parsedStatus = parsedStatusForUpload({
      filename: input.filename,
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
        ctx.userId,
        null,
        input.filename,
        documentTypeForFilename(input.filename),
        parsedStatus,
        summary,
        json({
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          storagePath: filePath,
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
          needsOcr: parsedStatus === "needs_ocr",
          sensitiveMaterialFlags,
        }),
        timestamp,
        timestamp,
      );

    for (const chunk of chunks) {
      const chunkId = randomUUID();
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
          ctx.userId,
          chunk.chunkIndex,
          chunk.page,
          chunk.section,
          chunk.text,
          chunk.quoteStart,
          chunk.quoteEnd,
          json({
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
    this.rebuildLocalSemanticIndexIfEnabled(matterId);

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "document_uploaded",
      workflowVersion: "aletheia-local-v0",
      model: null,
      details: {
        documentId: id,
        filename: input.filename,
        parsedStatus,
        parseFailureReason:
          parsedStatus === "needs_ocr"
            ? "pdf_without_text_layer"
            : parsedStatus === "failed"
              ? "text_extraction_failed"
              : null,
        chunkCount: chunks.length,
      },
    });
    this.touchMatter(ctx.userId, matterId);
    return this.document(
      this.db
        .prepare("select * from aletheia_matter_documents where id = ?")
        .get(id),
    );
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
          score: row.score,
          retrieval_mode: mode,
          retrieval_layers: ["sqlite_fts5"],
          semantic_index: semanticIndexConfig(),
        }),
      ),
      mode,
    );
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
          bm25(aletheia_document_chunks_fts) as score
        from aletheia_document_chunks_fts f
        join aletheia_document_chunks c on c.id = f.chunk_id
        where aletheia_document_chunks_fts match ?
          and f.matter_id = ?
        order by score
        limit ?
      `,
      )
      .all(query, matterId, limit) as Array<Record<string, any>>;
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

  private async createInitialAgentPlan(
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
    await this.writeAuditEvent(userId, args.matterId, {
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

  private async writeAuditEvent(
    userId: string,
    matterId: string,
    input: AppendAuditEventInput,
  ) {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `
        insert into aletheia_audit_events (
          id, matter_id, user_id, actor, action, workflow_version, model, details, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        json(input.details),
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

  private all(table: string, matterId: string, order = "created_at asc") {
    return this.db
      .prepare(`select * from ${table} where matter_id = ? order by ${order}`)
      .all(matterId);
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
        typeof metadata.sheetCount === "number" ? metadata.sheetCount : undefined,
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
        ...metadata,
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
        .all(args.matterId, args.userId, ...args.documentIds, args.limit) as any[]
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
          typeof metadata.tokenCount === "number" ? metadata.tokenCount : undefined,
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

  private workProduct(row: any) {
    return {
      ...row,
      model: row.model ?? null,
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
