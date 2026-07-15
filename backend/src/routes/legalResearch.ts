import { createHash } from "node:crypto";
import { Router } from "express";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  evaluateLegalResearchGate,
  normalizeLegalResearchRequest,
  previewResearchQuery,
  type LegalResearchFinding,
  type LegalResearchCitation,
} from "../lib/aletheia/legalResearch";
import {
  LEGAL_ISSUE_TREE_SCHEMA,
  validateLegalIssueTree,
} from "../lib/aletheia/legalIssues";
import {
  LegalSourceAdapterError,
  type LegalSourceAdapter,
  type LegalSourceProvider,
} from "../lib/aletheia/legalSourceAdapter";
import {
  createOfficialPublicLegalResearchProviderFromEnvironment,
  createPkulawLegalResearchProviderFromEnvironment,
  createWoltersLegalResearchProviderFromEnvironment,
  createYuanDianLegalResearchProviderFromEnvironment,
} from "../lib/aletheia/legalResearchProvider";
import {
  LocalControlError,
  LocalControlRepository,
  readLocalLegalSourceCredential,
} from "../lib/aletheia/localControlRepository";
import type { AletheiaRepository, AletheiaUserContext } from "../lib/aletheia/repository";
import { requireAuth } from "../middleware/auth";

const REQUEST_SCHEMA_V1 = "vera-legal-research-request-v1";
const REQUEST_SCHEMA_V2 = "vera-legal-research-request-v2";
const CASE_CONTEXT_SCHEMA = "vera-legal-research-case-context-v1";
const QUERY_PLAN_SCHEMA = "vera-legal-research-query-plan-v1";
const SEARCH_RESULT_SCHEMA = "vera-legal-research-search-result-v1";
const SOURCE_SNAPSHOT_SCHEMA = "vera-legal-source-snapshot-v1";
const EXCERPT_SCHEMA = "vera-legal-research-excerpt-v1";
const INPUT_MANIFEST_SCHEMA = "vera-legal-research-input-manifest-v1";
const MEMO_SCHEMA = "vera-legal-research-memo-v1";
const MANUAL_SOURCE_DOCUMENT_KINDS = new Set([
  "statute",
  "judicial_interpretation",
  "other",
]);

type WorkProduct = {
  id: string;
  kind: string;
  title: string;
  status: string;
  content: Record<string, unknown>;
  content_hash?: string;
  schema_version?: string;
  version?: number;
  created_at?: string;
};

type CaseContextBinding = {
  caseContextId: string;
  caseContextHash: string;
  caseContextContentHash: string;
};

type ResearchRequest = ReturnType<typeof normalizeLegalResearchRequest> & {
  schemaVersion: typeof REQUEST_SCHEMA_V1 | typeof REQUEST_SCHEMA_V2;
  caseContext?: CaseContextBinding;
};

type LegalResearchRouterOptions = {
  createRepository?: () => AletheiaRepository;
  createAdapter?: (args: {
    provider: LegalSourceProvider;
    userId: string;
  }) => LegalSourceAdapter;
};

class LegalResearchRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "LegalResearchRouteError";
  }
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") {
    throw new LegalResearchRouteError(`${label} is required.`, 400, "invalid_input");
  }
  const result = value.trim();
  if (!result || result.length > maximum) {
    throw new LegalResearchRouteError(
      `${label} must be between 1 and ${maximum} characters.`,
      400,
      "invalid_input",
    );
  }
  return result;
}

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label, maximum);
}

function requiredRawText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new LegalResearchRouteError(
      `${label} must be between 1 and ${maximum} characters.`,
      400,
      "invalid_input",
    );
  }
  return value;
}

function isoDate(value: unknown, label: string, required: boolean) {
  if (!required && (value === undefined || value === null || value === "")) return null;
  const date = requiredText(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new LegalResearchRouteError(`${label} must use YYYY-MM-DD.`, 400, "invalid_input");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new LegalResearchRouteError(`${label} is invalid.`, 400, "invalid_input");
  }
  return date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type ManualSourceInput = {
  documentId: string;
  title: string;
  content: string;
  documentKind: "statute" | "judicial_interpretation" | "other";
  version: string | null;
  effectiveDate: string | null;
  effectiveTo: string | null;
  publicationDate: string | null;
};

function manualSourceInput(value: unknown): ManualSourceInput {
  const allowed = new Set([
    "documentId",
    "title",
    "content",
    "documentKind",
    "version",
    "effectiveDate",
    "effectiveTo",
    "publicationDate",
  ]);
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LegalResearchRouteError(
      "Manual sources accept only documentId, title, content, documentKind, version, effectiveDate, effectiveTo, and publicationDate.",
      400,
      "invalid_input",
    );
  }
  const documentId = requiredText(value.documentId, "documentId", 240);
  if (!/^[^\s\u0000-\u001F\u007F]{1,240}$/u.test(documentId)) {
    throw new LegalResearchRouteError(
      "documentId must be a compact local identifier.",
      400,
      "invalid_input",
    );
  }
  const documentKind = value.documentKind;
  if (!MANUAL_SOURCE_DOCUMENT_KINDS.has(documentKind as string)) {
    throw new LegalResearchRouteError(
      "documentKind must be statute, judicial_interpretation, or other. Manual case imports are not accepted.",
      400,
      "invalid_input",
    );
  }
  const effectiveDate = isoDate(
    value.effectiveDate,
    "effectiveDate",
    documentKind === "statute" || documentKind === "judicial_interpretation",
  );
  const effectiveTo = isoDate(value.effectiveTo, "effectiveTo", false);
  if (effectiveDate && effectiveTo && effectiveTo < effectiveDate) {
    throw new LegalResearchRouteError(
      "effectiveTo must not precede effectiveDate.",
      400,
      "invalid_input",
    );
  }
  return {
    documentId,
    title: requiredText(value.title, "title", 1_000),
    content: requiredRawText(value.content, "content", 2_000_000),
    documentKind: documentKind as ManualSourceInput["documentKind"],
    version: optionalText(value.version, "version", 240),
    effectiveDate,
    effectiveTo,
    publicationDate: isoDate(value.publicationDate, "publicationDate", false),
  };
}

function textArray(value: unknown, label: string, maximumItems: number, maximumLength: number) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new LegalResearchRouteError(
      `${label} must contain between 1 and ${maximumItems} entries.`,
      400,
      "invalid_input",
    );
  }
  const values = value.map((entry) => requiredText(entry, label, maximumLength));
  if (new Set(values).size !== values.length) {
    throw new LegalResearchRouteError(`${label} must not contain duplicates.`, 400, "invalid_input");
  }
  return values;
}

function optionalTextArray(value: unknown, label: string, maximumItems: number, maximumLength: number) {
  if (value === undefined) return [];
  return textArray(value, label, maximumItems, maximumLength);
}

function optionalIdArray(value: unknown, label: string) {
  if (value === undefined) return [];
  return textArray(value, label, 40, 160);
}

function userContext(res: { locals: Record<string, unknown> }): AletheiaUserContext {
  return {
    userId: String(res.locals.userId),
    userEmail: typeof res.locals.userEmail === "string" ? res.locals.userEmail : undefined,
  };
}

function matterWorkProducts(detail: unknown): WorkProduct[] {
  const products = object(detail).workProducts;
  if (!Array.isArray(products)) return [];
  return products.filter((value): value is WorkProduct => {
    const item = object(value);
    return typeof item.id === "string" && typeof item.kind === "string" &&
      item.content !== null && typeof item.content === "object" && !Array.isArray(item.content);
  }).map((value) => ({
    ...value,
    content: object(value.content),
  }));
}

function ownedWorkProduct(
  detail: unknown,
  id: string,
  kind: string,
): WorkProduct {
  const workProduct = matterWorkProducts(detail).find(
    (item) => item.id === id && item.kind === kind,
  );
  if (!workProduct) {
    throw new LegalResearchRouteError("The requested local research record was not found.", 404, "not_found");
  }
  return workProduct;
}

function researchRequest(workProduct: WorkProduct): ResearchRequest {
  const schemaVersion = workProduct.content.schemaVersion;
  if (schemaVersion !== REQUEST_SCHEMA_V1 && schemaVersion !== REQUEST_SCHEMA_V2) {
    throw new LegalResearchRouteError("The research request is malformed.", 409, "invalid_state");
  }
  const request = object(workProduct.content.request);
  const normalized = normalizeLegalResearchRequest({
    title: request.title as string,
    facts: request.facts as string,
    jurisdiction: request.jurisdiction as string,
    asOfDate: request.asOfDate as string,
    question: request.question as string,
  });
  if (schemaVersion === REQUEST_SCHEMA_V1) {
    return { ...normalized, schemaVersion };
  }
  return {
    ...normalized,
    schemaVersion,
    caseContext: {
      caseContextId: requiredText(workProduct.content.caseContextId, "caseContextId", 160),
      caseContextHash: requiredText(workProduct.content.caseContextHash, "caseContextHash", 100),
      caseContextContentHash: requiredText(
        workProduct.content.caseContextContentHash,
        "caseContextContentHash",
        100,
      ),
    },
  };
}

function contextSource(source: Record<string, unknown>, label: string) {
  const contextText = (value: unknown, field: string, maximum: number) => {
    try {
      return requiredText(value, field, maximum);
    } catch {
      throw new LegalResearchRouteError(
        `${label} is unavailable or no longer current in this matter.`,
        409,
        "case_context_required",
      );
    }
  };
  const quote = contextText(source.quote, `${label} quote`, 20_000);
  const quoteSha256 = contextText(source.quote_sha256, `${label} quote hash`, 100);
  const sourceChunkSha256 = contextText(
    source.source_chunk_sha256,
    `${label} source chunk hash`,
    100,
  );
  const currentQuote = contextText(source.current_quote, `${label} current quote`, 20_000);
  const currentQuoteSha256 = contextText(
    source.current_quote_sha256,
    `${label} current quote hash`,
    100,
  );
  const currentSourceChunkSha256 = contextText(
    source.current_source_chunk_sha256,
    `${label} current source chunk hash`,
    100,
  );
  if (
    quote !== currentQuote ||
    quoteSha256 !== currentQuoteSha256 ||
    sourceChunkSha256 !== currentSourceChunkSha256
  ) {
    throw new LegalResearchRouteError(
      `${label} no longer matches its current local source text.`,
      409,
      "case_context_required",
    );
  }
  return {
    sourceSpanId: contextText(source.source_span_id, `${label} source span`, 160),
    documentId: contextText(source.document_id, `${label} document`, 160),
    documentName: contextText(source.document_name, `${label} document name`, 1_000),
    page: source.page ?? null,
    section: source.section ?? null,
    quote,
    quoteSha256,
    sourceChunkSha256,
    currentVerificationId:
      typeof source.current_verification_id === "string"
        ? source.current_verification_id
        : null,
  };
}

function caseContextFromWorkspace(
  workspace: unknown,
  factIds: string[],
  proceduralEventIds: string[],
) {
  const data = object(workspace);
  const facts = Array.isArray(data.facts) ? data.facts.map(object) : [];
  const factSources = Array.isArray(data.fact_sources) ? data.fact_sources.map(object) : [];
  const events = Array.isArray(data.procedural_events)
    ? data.procedural_events.map(object)
    : [];
  const total = factIds.length + proceduralEventIds.length;
  if (total < 1 || total > 40) {
    throw new LegalResearchRouteError(
      "Select between 1 and 40 confirmed facts or procedural events.",
      409,
      "case_context_required",
    );
  }

  const canonicalFacts = factIds.map((factId) => {
    const fact = facts.find((item) => item.id === factId);
    if (!fact) {
      throw new LegalResearchRouteError(
        "A selected fact is outside this matter or no longer exists.",
        409,
        "invalid_case_context",
      );
    }
    if (fact.status !== "confirmed") {
      throw new LegalResearchRouteError(
        "Only confirmed facts with current sources may be used for legal research.",
        409,
        "case_context_required",
      );
    }
    const evidence = factSources
      .filter((source) => source.fact_id === factId)
      .map((source, index) => contextSource(source, `fact ${factId} source ${index + 1}`))
      .sort((left, right) => left.sourceSpanId.localeCompare(right.sourceSpanId));
    if (evidence.length === 0) {
      throw new LegalResearchRouteError(
        "Every selected fact requires at least one current local fact source.",
        409,
        "case_context_required",
      );
    }
    const item = {
      id: requiredText(fact.id, "factId", 160),
      statement: requiredText(fact.statement, "fact statement", 12_000),
      occurredAt: fact.occurred_at ?? null,
      helpfulness: fact.helpfulness ?? null,
      confidence: fact.confidence ?? null,
      evidence,
    };
    return { ...item, factHash: sha256(stableJson(item)) };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const canonicalEvents = proceduralEventIds.map((eventId) => {
    const event = events.find((item) => item.id === eventId);
    if (!event) {
      throw new LegalResearchRouteError(
        "A selected procedural event is outside this matter or no longer exists.",
        409,
        "invalid_case_context",
      );
    }
    if (
      event.status !== "confirmed" ||
      event.superseded_by_event_id ||
      event.superseded_at
    ) {
      throw new LegalResearchRouteError(
        "Only current confirmed procedural events with current sources may be used for legal research.",
        409,
        "case_context_required",
      );
    }
    const primarySourceSpanId = requiredText(
      event.primary_source_span_id,
      "primary source span",
      160,
    );
    const source = contextSource(
      {
        source_span_id: primarySourceSpanId,
        document_id: event.document_id,
        document_name: event.document_name,
        page: event.page,
        section: event.section,
        quote: event.quote,
        quote_sha256: event.quote_sha256,
        source_chunk_sha256: event.source_chunk_sha256,
        current_verification_id: event.current_verification_id,
        current_quote: event.current_quote,
        current_quote_sha256: event.current_quote_sha256,
        current_source_chunk_sha256: event.current_source_chunk_sha256,
      },
      `procedural event ${eventId} source`,
    );
    const item = {
      id: requiredText(event.id, "proceduralEventId", 160),
      eventType: requiredText(event.event_type, "event type", 160),
      title: requiredText(event.title, "event title", 1_000),
      occurredAt: event.occurred_at ?? null,
      primarySourceSpanId,
      eventVersion: Number(event.event_version ?? 0),
      eventLineageHash: requiredText(event.event_lineage_hash, "event lineage hash", 100),
      source,
    };
    return { ...item, eventHash: sha256(stableJson(item)) };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const items = { facts: canonicalFacts, proceduralEvents: canonicalEvents };
  return { items, contextHash: sha256(stableJson(items)) };
}

function derivedFactsText(items: Record<string, unknown>) {
  const facts = Array.isArray(items.facts) ? items.facts.map(object) : [];
  const events = Array.isArray(items.proceduralEvents)
    ? items.proceduralEvents.map(object)
    : [];
  return [
    ...facts.map((fact) => String(fact.statement ?? "")),
    ...events.map((event) => `${String(event.event_type ?? "")}: ${String(event.title ?? "")}`),
  ].filter(Boolean).join("\n");
}

function caseContextForRequest(detail: unknown, request: ResearchRequest) {
  if (!request.caseContext) return null;
  const context = matterWorkProducts(detail).find(
    (product) =>
      product.id === request.caseContext!.caseContextId &&
      product.kind === "legal_research_case_context",
  );
  if (!context) {
    throw new LegalResearchRouteError(
      "The immutable case context is missing from this matter.",
      409,
      "case_context_changed",
    );
  }
  const content = context.content;
  const items = object(content.items);
  const contentHash = sha256(stableJson(content));
  if (
    context.status !== "accepted" ||
    content.schemaVersion !== CASE_CONTEXT_SCHEMA ||
    content.contextHash !== request.caseContext.caseContextHash ||
    context.content_hash !== contentHash ||
    request.caseContext.caseContextContentHash !== contentHash
  ) {
    throw new LegalResearchRouteError(
      "The immutable case context is missing or no longer matches this research request.",
      409,
      "case_context_changed",
    );
  }
  return {
    ...request.caseContext,
    items,
  };
}

async function assertCurrentCaseContext(
  repo: AletheiaRepository,
  ctx: AletheiaUserContext,
  matterId: string,
  detail: unknown,
  request: ResearchRequest,
) {
  const context = caseContextForRequest(detail, request);
  if (!context) return null;
  const workspace = await repo.getLitigationWorkspace(ctx, matterId);
  if (!workspace) {
    throw new LegalResearchRouteError("Matter case context is unavailable.", 409, "case_context_required");
  }
  const factIds = Array.isArray(context.items.facts)
    ? context.items.facts.map(object).map((fact) => String(fact.id ?? ""))
    : [];
  const proceduralEventIds = Array.isArray(context.items.proceduralEvents)
    ? context.items.proceduralEvents.map(object).map((event) => String(event.id ?? ""))
    : [];
  try {
    const current = caseContextFromWorkspace(workspace, factIds, proceduralEventIds);
    if (
      current.contextHash !== context.caseContextHash ||
      stableJson(current.items) !== stableJson(context.items)
    ) {
      throw new Error("bound content differs");
    }
  } catch {
    throw new LegalResearchRouteError(
      "Confirmed case facts or their source records changed after this research request was bound.",
      409,
      "case_context_changed",
    );
  }
  return {
    caseContextId: context.caseContextId,
    caseContextHash: context.caseContextHash,
    caseContextContentHash: context.caseContextContentHash,
  };
}

function providerFromPlan(workProduct: WorkProduct) {
  if (workProduct.content.schemaVersion !== QUERY_PLAN_SCHEMA) {
    throw new LegalResearchRouteError("The research query plan is malformed.", 409, "invalid_state");
  }
  const provider = researchSourceProvider(workProduct.content.provider);
  const preview = object(workProduct.content.preview);
  if (!provider || typeof preview.query !== "string" || typeof preview.queryHash !== "string") {
    throw new LegalResearchRouteError("The research query plan is incomplete.", 409, "invalid_state");
  }
  return {
    provider,
    requestId: requiredText(workProduct.content.requestId, "requestId", 160),
    issueTreeId: requiredText(workProduct.content.issueTreeId, "issueTreeId", 160),
    issueTreeHash: requiredText(workProduct.content.issueTreeHash, "issueTreeHash", 100),
    query: requiredText(preview.query, "query", 600),
    queryHash: requiredText(preview.queryHash, "queryHash", 100),
    caseContext:
      typeof workProduct.content.caseContextId === "string"
        ? {
            caseContextId: requiredText(workProduct.content.caseContextId, "caseContextId", 160),
            caseContextHash: requiredText(workProduct.content.caseContextHash, "caseContextHash", 100),
            caseContextContentHash: requiredText(
              workProduct.content.caseContextContentHash,
              "caseContextContentHash",
              100,
            ),
          }
        : null,
  };
}

function latestIssueTree(detail: unknown, requestId: string) {
  const candidates = matterWorkProducts(detail).filter((product) =>
    product.kind === "legal_research_issue_tree" &&
    product.content.schemaVersion === LEGAL_ISSUE_TREE_SCHEMA &&
    product.content.requestId === requestId,
  );
  return candidates.sort((left, right) =>
    Number(right.version ?? 0) - Number(left.version ?? 0) ||
    String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")),
  )[0] ?? null;
}

function issueTreeForPlan(detail: unknown, requestId: string, issueTreeId: string) {
  if (!issueTreeId) {
    throw new LegalResearchRouteError(
      "A saved local issue tree is required before a query plan can be created.",
      409,
      "issue_tree_required",
    );
  }
  const issueTree = ownedWorkProduct(detail, issueTreeId, "legal_research_issue_tree");
  if (
    issueTree.content.schemaVersion !== LEGAL_ISSUE_TREE_SCHEMA ||
    issueTree.content.requestId !== requestId
  ) {
    throw new LegalResearchRouteError(
      "The saved issue tree does not belong to this local research request.",
      409,
      "invalid_binding",
    );
  }
  const tree = validateLegalIssueTree(issueTree.content.tree);
  const storedHash = object(issueTree.content.tree).treeHash;
  if (storedHash !== tree.treeHash) {
    throw new LegalResearchRouteError(
      "The saved local issue tree failed its integrity check.",
      409,
      "invalid_state",
    );
  }
  const latest = latestIssueTree(detail, requestId);
  if (!latest || latest.id !== issueTree.id) {
    throw new LegalResearchRouteError(
      "The local issue tree changed. Create a new query plan from the current tree.",
      409,
      "issue_tree_changed",
    );
  }
  return { id: issueTree.id, treeHash: tree.treeHash };
}

function assertPlanIssueTreeCurrent(
  detail: unknown,
  plan: ReturnType<typeof providerFromPlan>,
) {
  const issueTree = issueTreeForPlan(detail, plan.requestId, plan.issueTreeId);
  if (issueTree.treeHash !== plan.issueTreeHash) {
    throw new LegalResearchRouteError(
      "The local issue tree changed after this query plan was created. Create a new query plan before continuing.",
      409,
      "issue_tree_changed",
    );
  }
  return issueTree;
}

async function assertPlanCaseContextCurrent(args: {
  repo: AletheiaRepository;
  ctx: AletheiaUserContext;
  matterId: string;
  detail: unknown;
  plan: ReturnType<typeof providerFromPlan>;
}) {
  const request = researchRequest(
    ownedWorkProduct(args.detail, args.plan.requestId, "legal_research_request"),
  );
  const context = await assertCurrentCaseContext(
    args.repo,
    args.ctx,
    args.matterId,
    args.detail,
    request,
  );
  if (!context) {
    if (args.plan.caseContext) {
      throw new LegalResearchRouteError(
        "A v1 research request cannot use a v2 case-context-bound plan.",
        409,
        "invalid_binding",
      );
    }
    return null;
  }
  if (
    !args.plan.caseContext ||
    args.plan.caseContext.caseContextId !== context.caseContextId ||
    args.plan.caseContext.caseContextHash !== context.caseContextHash ||
    args.plan.caseContext.caseContextContentHash !== context.caseContextContentHash
  ) {
    throw new LegalResearchRouteError(
      "The query plan does not match the current immutable case context.",
      409,
      "case_context_changed",
    );
  }
  return context;
}

function hasCaseContextBinding(
  content: Record<string, unknown>,
  binding: CaseContextBinding | null,
) {
  if (!binding) {
    return (
      content.caseContextId === undefined &&
      content.caseContextHash === undefined &&
      content.caseContextContentHash === undefined
    );
  }
  return (
    content.caseContextId === binding.caseContextId &&
    content.caseContextHash === binding.caseContextHash &&
    content.caseContextContentHash === binding.caseContextContentHash
  );
}

function caseContextBindingFromContent(content: Record<string, unknown>) {
  if (content.caseContextId === undefined) return null;
  return {
    caseContextId: requiredText(content.caseContextId, "caseContextId", 160),
    caseContextHash: requiredText(content.caseContextHash, "caseContextHash", 100),
    caseContextContentHash: requiredText(
      content.caseContextContentHash,
      "caseContextContentHash",
      100,
    ),
  };
}

function researchSourceProvider(value: unknown): LegalSourceProvider | null {
  return value === "pkulaw" ||
    value === "yuandian" ||
    value === "wolters" ||
    value === "official"
    ? value
    : null;
}

function sourceFetchHash(args: {
  queryPlanId: string;
  searchResultId: string;
  provider: string;
  documentId: string;
  queryHash: string;
  issueTreeHash: string;
  caseContextId?: string;
  caseContextHash?: string;
  caseContextContentHash?: string;
}) {
  return sha256([
    args.queryPlanId,
    args.searchResultId,
    args.provider,
    args.documentId,
    args.queryHash,
    args.issueTreeHash,
    args.caseContextId ?? "",
    args.caseContextHash ?? "",
    args.caseContextContentHash ?? "",
  ].join("\n"));
}

function auditSourceIdentity(sourceIdentity: string) {
  return sourceIdentity.startsWith("manual_import:")
    ? { sourceIdentityHash: sha256(sourceIdentity) }
    : { sourceIdentity };
}

function auditSourceSnapshots(
  sourceSnapshots: Array<{ sourceIdentity: string; contentHash: string }>,
) {
  return sourceSnapshots.map(({ sourceIdentity, contentHash }) => ({
    ...auditSourceIdentity(sourceIdentity),
    contentHash,
  }));
}

function latestSnapshots(products: WorkProduct[]) {
  const latest = new Map<string, WorkProduct>();
  for (const product of products) {
    if (product.kind !== "external_source_workpaper" || product.content.schemaVersion !== SOURCE_SNAPSHOT_SCHEMA) continue;
    const sourceIdentity = typeof product.content.sourceIdentity === "string"
      ? product.content.sourceIdentity
      : "";
    if (!sourceIdentity) continue;
    const current = latest.get(sourceIdentity);
    const version = Number(product.version ?? 0);
    const currentVersion = Number(current?.version ?? -1);
    if (!current || version > currentVersion || (version === currentVersion && String(product.created_at ?? "") > String(current.created_at ?? ""))) {
      latest.set(sourceIdentity, product);
    }
  }
  return latest;
}

function sourceSnapshotFromWorkProduct(workProduct: WorkProduct) {
  if (workProduct.kind !== "external_source_workpaper" || workProduct.content.schemaVersion !== SOURCE_SNAPSHOT_SCHEMA) {
    throw new LegalResearchRouteError("The local source snapshot is malformed.", 409, "invalid_state");
  }
  const snapshot = object(workProduct.content.snapshot);
  const sourceIdentity = requiredText(workProduct.content.sourceIdentity, "sourceIdentity", 1200);
  const content = requiredRawText(workProduct.content.content, "source content", 2_000_000);
  const contentHash = requiredText(snapshot.contentHash, "source content hash", 100);
  if (sha256(content) !== contentHash) {
    throw new LegalResearchRouteError(
      "The local source snapshot content does not match its recorded hash.",
      409,
      "invalid_state",
    );
  }
  return {
    sourceIdentity,
    content,
    snapshot: {
      contentHash,
      effectiveDate: optionalText(snapshot.effectiveDate, "effective date", 10),
      effectiveTo: optionalText(snapshot.effectiveTo, "effective-to date", 10),
      publicationDate: optionalText(snapshot.publicationDate, "publication date", 10),
      url: requiredText(snapshot.url, "source URL", 4000),
      sourceType: requiredText(snapshot.sourceType, "source type", 80),
      version: optionalText(snapshot.version, "source version", 240),
      documentKind: optionalText(snapshot.documentKind, "source document kind", 80),
      caseNumber: optionalText(snapshot.caseNumber, "case number", 160),
      caseNumberFormatValid: snapshot.caseNumberFormatValid === true,
      caseVerificationStatus: snapshot.caseVerificationStatus === "verified"
        ? ("verified" as const)
        : ("unverified" as const),
      fetchedAt: requiredText(snapshot.fetchedAt, "source fetch time", 80),
    },
  };
}

function legalAuthorityType(value: unknown): LegalResearchCitation["sourceType"] {
  if (value === "statute" || value === "judicial_interpretation" || value === "case" || value === "manual") {
    return value;
  }
  throw new LegalResearchRouteError("citation sourceType is invalid.", 400, "invalid_input");
}

function findingsForManifest(args: {
  value: unknown;
  manifest: WorkProduct;
  excerpts: Map<string, WorkProduct>;
  snapshots: Map<string, WorkProduct>;
}) {
  if (!Array.isArray(args.value) || args.value.length > 40) {
    throw new LegalResearchRouteError("findings must be an array with no more than 40 entries.", 400, "invalid_input");
  }
  const manifestExcerpts = Array.isArray(args.manifest.content.excerpts)
    ? args.manifest.content.excerpts
    : [];
  const permitted = new Set(
    manifestExcerpts.map((value) => object(value).excerptId).filter((value): value is string => typeof value === "string"),
  );
  const findings: LegalResearchFinding[] = args.value.map((rawFinding, findingIndex) => {
    const finding = object(rawFinding);
    const citationsInput = finding.citations;
    if (!Array.isArray(citationsInput) || citationsInput.length === 0 || citationsInput.length > 20) {
      throw new LegalResearchRouteError(`Finding ${findingIndex + 1} needs at least one reviewed excerpt.`, 409, "insufficient_basis");
    }
    const citations: LegalResearchCitation[] = citationsInput.map((rawCitation, citationIndex) => {
      const citation = object(rawCitation);
      const excerptId = requiredText(citation.excerptId, "citation excerptId", 160);
      if (!permitted.has(excerptId)) {
        throw new LegalResearchRouteError(`Finding ${findingIndex + 1} cites an excerpt outside the immutable input manifest.`, 409, "invalid_binding");
      }
      const excerpt = args.excerpts.get(excerptId);
      if (!excerpt || excerpt.status !== "accepted") {
        throw new LegalResearchRouteError(`Finding ${findingIndex + 1} cites an unconfirmed excerpt.`, 409, "invalid_binding");
      }
      const excerptContent = object(excerpt.content);
      const snapshotId = requiredText(excerptContent.snapshotId, "excerpt snapshotId", 160);
      const source = args.snapshots.get(snapshotId);
      if (!source) {
        throw new LegalResearchRouteError(`Finding ${findingIndex + 1} cites a missing local source snapshot.`, 409, "invalid_binding");
      }
      const sourceSnapshot = sourceSnapshotFromWorkProduct(source).snapshot;
      const sourceType = legalAuthorityType(citation.sourceType);
      if (
        sourceSnapshot.documentKind &&
        sourceSnapshot.documentKind !== "other" &&
        sourceSnapshot.documentKind !== sourceType
      ) {
        throw new LegalResearchRouteError(
          `Finding ${findingIndex + 1} assigns a source type that does not match the local snapshot metadata.`,
          409,
          "invalid_binding",
        );
      }
      return {
        snapshotId,
        quote: requiredText(excerptContent.quote, "excerpt quote", 8000),
        sourceType,
        effectiveFrom: sourceSnapshot.effectiveDate,
        effectiveTo: sourceSnapshot.effectiveTo,
        caseVerificationStatus: sourceSnapshot.caseVerificationStatus,
      };
    });
    const confidence = finding.confidence;
    const position = finding.position;
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
      throw new LegalResearchRouteError(`Finding ${findingIndex + 1} confidence is invalid.`, 400, "invalid_input");
    }
    if (position !== "supporting" && position !== "adverse" && position !== "neutral") {
      throw new LegalResearchRouteError(`Finding ${findingIndex + 1} position is invalid.`, 400, "invalid_input");
    }
    return {
      conclusion: requiredText(finding.conclusion, "finding conclusion", 6000),
      citations,
      confidence,
      uncertainty: optionalText(finding.uncertainty, "finding uncertainty", 4000),
      position,
    };
  });
  return findings;
}

let localControls: LocalControlRepository | null = null;

function controls() {
  localControls ??= new LocalControlRepository();
  return localControls;
}

function productionAdapter(args: { provider: LegalSourceProvider; userId: string }) {
  if (args.provider === "official") {
    return createOfficialPublicLegalResearchProviderFromEnvironment();
  }
  const resolveCredential = async () => readLocalLegalSourceCredential(controls(), args.userId, args.provider);
  if (args.provider === "pkulaw") {
    return createPkulawLegalResearchProviderFromEnvironment({ resolveCredential });
  }
  if (args.provider === "yuandian") {
    return createYuanDianLegalResearchProviderFromEnvironment({ resolveCredential });
  }
  return createWoltersLegalResearchProviderFromEnvironment({ resolveCredential });
}

function routeError(res: { status: (status: number) => { json: (body: unknown) => void } }, error: unknown) {
  if (error instanceof LegalResearchRouteError) {
    return void res.status(error.status).json({ code: error.code, detail: error.message });
  }
  if (error instanceof LegalSourceAdapterError) {
    const unavailable = error.code === "configuration_error" || error.code === "credential_unavailable";
    return void res.status(unavailable ? 503 : 502).json({
      code: unavailable ? "legal_source_unavailable" : "legal_source_response_rejected",
      detail: unavailable
        ? "The authorized legal-source API is not configured or its local credential is unavailable."
        : "The authorized legal-source API response was rejected by the local safety policy.",
    });
  }
  if (error instanceof LocalControlError) {
    return void res.status(error.status === 404 ? 503 : error.status).json({
      code: "legal_source_unavailable",
      detail: "The authorized legal-source credential is unavailable in encrypted local storage.",
    });
  }
  if (error instanceof Error) {
    return void res.status(400).json({ code: "invalid_input", detail: error.message });
  }
  res.status(500).json({ code: "research_broker_failed", detail: "The local Research Broker could not complete the request." });
}

export function createLegalResearchRouter(options: LegalResearchRouterOptions = {}) {
  const router = Router();
  const repository = options.createRepository ?? createAletheiaRepository;
  const adapterFor = options.createAdapter ?? productionAdapter;

  router.post("/matters/:matterId/research/requests", requireAuth, async (req, res) => {
    try {
      const body = object(req.body);
      const factIds = optionalIdArray(body.factIds, "factIds");
      const proceduralEventIds = optionalIdArray(
        body.proceduralEventIds,
        "proceduralEventIds",
      );
      if (
        new Set(factIds).size !== factIds.length ||
        new Set(proceduralEventIds).size !== proceduralEventIds.length
      ) {
        throw new LegalResearchRouteError(
          "factIds and proceduralEventIds must not contain duplicates.",
          400,
          "invalid_input",
        );
      }
      const ctx = userContext(res);
      const repo = repository();
      const workspace = await repo.getLitigationWorkspace(ctx, req.params.matterId);
      if (!workspace) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const context = caseContextFromWorkspace(workspace, factIds, proceduralEventIds);
      const request = normalizeLegalResearchRequest({
        title: requiredText(body.title, "title", 240),
        facts: derivedFactsText(context.items),
        jurisdiction: requiredText(body.jurisdiction, "jurisdiction", 120),
        asOfDate: requiredText(body.asOfDate, "asOfDate", 10),
        question: requiredText(body.question, "question", 2_000),
      });
      const contextContent = {
        schemaVersion: CASE_CONTEXT_SCHEMA,
        items: context.items,
        contextHash: context.contextHash,
      };
      const caseContext = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_research_case_context",
        title: "Legal research case context",
        status: "accepted",
        schemaVersion: CASE_CONTEXT_SCHEMA,
        content: contextContent,
        validationErrors: [],
        generatedBy: "system",
        model: null,
      }) as WorkProduct | null;
      if (!caseContext) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const caseContextContentHash = requiredText(
        caseContext.content_hash,
        "case context content hash",
        100,
      );
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "system",
        action: "legal_research_case_context_bound",
        workflowVersion: CASE_CONTEXT_SCHEMA,
        model: null,
        details: {
          caseContextId: caseContext.id,
          caseContextHash: context.contextHash,
          caseContextContentHash,
          factIds: context.items.facts.map((fact) => fact.id),
          proceduralEventIds: context.items.proceduralEvents.map((event) => event.id),
          factCount: context.items.facts.length,
          proceduralEventCount: context.items.proceduralEvents.length,
        },
      });
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_research_request",
        title: request.title,
        status: "draft",
        schemaVersion: REQUEST_SCHEMA_V2,
        content: {
          schemaVersion: REQUEST_SCHEMA_V2,
          request,
          caseContextId: caseContext.id,
          caseContextHash: context.contextHash,
          caseContextContentHash,
          networkStatus: "not_dispatched",
        },
        validationErrors: [],
        generatedBy: "human",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "human",
        action: "legal_research_request_created",
        workflowVersion: REQUEST_SCHEMA_V2,
        model: null,
        details: {
          requestId: (result as WorkProduct).id,
          caseContextId: caseContext.id,
          caseContextHash: context.contextHash,
          caseContextContentHash,
          factsHash: sha256(request.facts),
          jurisdiction: request.jurisdiction,
          asOfDate: request.asOfDate,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/requests/:requestId/issues", requireAuth, async (req, res) => {
    try {
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const request = researchRequest(
        ownedWorkProduct(detail, req.params.requestId, "legal_research_request"),
      );
      await assertCurrentCaseContext(repo, ctx, req.params.matterId, detail, request);
      const tree = validateLegalIssueTree(req.body);
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_research_issue_tree",
        title: "Legal issue tree",
        status: "accepted",
        schemaVersion: LEGAL_ISSUE_TREE_SCHEMA,
        content: {
          schemaVersion: LEGAL_ISSUE_TREE_SCHEMA,
          requestId: req.params.requestId,
          tree,
        },
        validationErrors: [],
        generatedBy: "human",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "human",
        action: "legal_research_issue_tree_recorded",
        workflowVersion: LEGAL_ISSUE_TREE_SCHEMA,
        model: null,
        details: {
          issueTreeId: (result as WorkProduct).id,
          requestId: req.params.requestId,
          nodeCount: tree.nodeCount,
          maxDepth: tree.maxDepth,
          statusCounts: tree.statusCounts,
          treeHash: tree.treeHash,
          contentHash: (result as WorkProduct).content_hash ?? null,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.get("/matters/:matterId/research/requests/:requestId/issues", requireAuth, async (req, res) => {
    try {
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const request = researchRequest(
        ownedWorkProduct(detail, req.params.requestId, "legal_research_request"),
      );
      await assertCurrentCaseContext(repo, ctx, req.params.matterId, detail, request);
      const issueTree = latestIssueTree(detail, req.params.requestId);
      if (!issueTree) {
        return void res.status(404).json({
          code: "not_found",
          detail: "No local issue tree exists for this research request.",
        });
      }
      res.json(issueTree);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/requests/:requestId/manual-sources", requireAuth, async (req, res) => {
    try {
      const input = manualSourceInput(req.body);
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const request = researchRequest(
        ownedWorkProduct(detail, req.params.requestId, "legal_research_request"),
      );
      const caseContext = await assertCurrentCaseContext(
        repo,
        ctx,
        req.params.matterId,
        detail,
        request,
      );
      if (!caseContext) {
        throw new LegalResearchRouteError(
          "Manual source imports require a current immutable case context.",
          409,
          "case_context_required",
        );
      }
      const currentIssueTree = latestIssueTree(detail, req.params.requestId);
      const issueTree = issueTreeForPlan(
        detail,
        req.params.requestId,
        currentIssueTree?.id ?? "",
      );
      const sourceIdentity = `manual_import:${input.documentId}`;
      const contentHash = sha256(input.content);
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "external_source_workpaper",
        title: input.title,
        status: "generated",
        schemaVersion: SOURCE_SNAPSHOT_SCHEMA,
        content: {
          schemaVersion: SOURCE_SNAPSHOT_SCHEMA,
          requestId: req.params.requestId,
          issueTreeId: issueTree.id,
          issueTreeHash: issueTree.treeHash,
          ...caseContext,
          sourceIdentity,
          provider: "manual_import",
          documentId: input.documentId,
          snapshot: {
            url: `manual://local/${encodeURIComponent(input.documentId)}`,
            fetchedAt: new Date().toISOString(),
            contentHash,
            sourceType: "manual_import",
            version: input.version ?? undefined,
            effectiveDate: input.effectiveDate ?? undefined,
            effectiveTo: input.effectiveTo ?? undefined,
            publicationDate: input.publicationDate ?? undefined,
            documentKind: input.documentKind,
            caseVerificationStatus: "unverified",
          },
          content: input.content,
          verificationStatus: "captured_unverified",
        },
        validationErrors: [],
        generatedBy: "human",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "human",
        action: "legal_research_manual_source_snapshot_saved",
        workflowVersion: SOURCE_SNAPSHOT_SCHEMA,
        model: null,
        details: {
          requestId: req.params.requestId,
          sourceSnapshotId: (result as WorkProduct).id,
          issueTreeId: issueTree.id,
          issueTreeHash: issueTree.treeHash,
          ...caseContext,
          documentIdHash: sha256(input.documentId),
          contentHash,
          documentKind: input.documentKind,
          effectiveDate: input.effectiveDate,
          effectiveTo: input.effectiveTo,
          publicationDate: input.publicationDate,
          verificationStatus: "captured_unverified",
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/requests/:requestId/query-preview", requireAuth, async (req, res) => {
    try {
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const request = researchRequest(ownedWorkProduct(detail, req.params.requestId, "legal_research_request"));
      const caseContext = await assertCurrentCaseContext(repo, ctx, req.params.matterId, detail, request);
      const body = object(req.body);
      const issueTree = issueTreeForPlan(
        detail,
        req.params.requestId,
        typeof body.issueTreeId === "string" ? body.issueTreeId.trim() : "",
      );
      const provider = researchSourceProvider(body.provider);
      if (!provider) throw new LegalResearchRouteError("provider must be official, pkulaw, yuandian, or wolters.", 400, "invalid_input");
      const preview = previewResearchQuery({
        query: requiredText(body.query, "query", 600),
        protectedTerms: optionalTextArray(body.protectedTerms, "protectedTerms", 30, 240),
        jurisdiction: request.jurisdiction,
        asOfDate: request.asOfDate,
      });
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_research_query_plan",
        title: `检索计划：${request.title}`,
        status: "draft",
        schemaVersion: QUERY_PLAN_SCHEMA,
        content: {
          schemaVersion: QUERY_PLAN_SCHEMA,
          requestId: req.params.requestId,
          issueTreeId: issueTree.id,
          issueTreeHash: issueTree.treeHash,
          ...(caseContext ?? {}),
          provider,
          preview,
          dispatchStatus: "awaiting_lawyer_approval",
        },
        validationErrors: [],
        generatedBy: "human",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "human",
        action: "legal_research_query_previewed",
        workflowVersion: QUERY_PLAN_SCHEMA,
        model: null,
        details: {
          requestId: req.params.requestId,
          queryPlanId: (result as WorkProduct).id,
          issueTreeId: issueTree.id,
          issueTreeHash: issueTree.treeHash,
          ...(caseContext ?? {}),
          provider,
          queryHash: preview.queryHash,
          redactions: preview.redactions,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/query-plans/:queryPlanId/approval", requireAuth, async (req, res) => {
    try {
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const plan = providerFromPlan(ownedWorkProduct(detail, req.params.queryPlanId, "legal_research_query_plan"));
      assertPlanIssueTreeCurrent(detail, plan);
      const caseContext = await assertPlanCaseContextCurrent({ repo, ctx, matterId: req.params.matterId, detail, plan });
      const result = await repo.requestApproval(ctx, req.params.matterId, {
        action: "external_source_use",
        prompt: "确认将下列脱敏检索词发送至已授权法律数据 API。确认后仅执行一次检索。",
        requestedPayload: {
          operation: "legal_research_search",
          queryPlanId: req.params.queryPlanId,
          issueTreeId: plan.issueTreeId,
          issueTreeHash: plan.issueTreeHash,
          ...(caseContext ?? {}),
          provider: plan.provider,
          queryHash: plan.queryHash,
          outboundQuery: plan.query,
        },
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/query-plans/:queryPlanId/search", requireAuth, async (req, res) => {
    try {
      const approvalCheckpointId = requiredText(object(req.body).approvalCheckpointId, "approvalCheckpointId", 160);
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const plan = providerFromPlan(ownedWorkProduct(detail, req.params.queryPlanId, "legal_research_query_plan"));
      assertPlanIssueTreeCurrent(detail, plan);
      const caseContext = await assertPlanCaseContextCurrent({ repo, ctx, matterId: req.params.matterId, detail, plan });
      const approved = await repo.hasApprovedCheckpoint(ctx, req.params.matterId, approvalCheckpointId, "external_source_use", {
        operation: "legal_research_search",
        queryPlanId: req.params.queryPlanId,
        issueTreeId: plan.issueTreeId,
        issueTreeHash: plan.issueTreeHash,
        ...(caseContext ?? {}),
        provider: plan.provider,
        queryHash: plan.queryHash,
        outboundQuery: plan.query,
      });
      if (!approved) return void res.status(409).json({ code: "approval_required", detail: "An approved query-specific external-source checkpoint is required." });
      const candidates = await adapterFor({ provider: plan.provider, userId: ctx.userId }).search({ query: plan.query });
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_research_search_result",
        title: `检索候选：${req.params.queryPlanId}`,
        status: "generated",
        schemaVersion: SEARCH_RESULT_SCHEMA,
        content: {
          schemaVersion: SEARCH_RESULT_SCHEMA,
          queryPlanId: req.params.queryPlanId,
          requestId: plan.requestId,
          issueTreeId: plan.issueTreeId,
          issueTreeHash: plan.issueTreeHash,
          ...(caseContext ?? {}),
          provider: plan.provider,
          queryHash: plan.queryHash,
          candidates: candidates.map((candidate) => ({
            documentId: candidate.documentId,
            title: candidate.title,
            summary: candidate.summary ?? null,
            snapshot: candidate.snapshot,
          })),
        },
        validationErrors: [],
        generatedBy: "system",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "system",
        action: "legal_research_search_completed",
        workflowVersion: SEARCH_RESULT_SCHEMA,
        model: null,
        details: {
          queryPlanId: req.params.queryPlanId,
          issueTreeId: plan.issueTreeId,
          issueTreeHash: plan.issueTreeHash,
          ...(caseContext ?? {}),
          queryHash: plan.queryHash,
          provider: plan.provider,
          candidateCount: candidates.length,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/query-plans/:queryPlanId/search-results/:searchResultId/sources/:documentId/approval", requireAuth, async (req, res) => {
    try {
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const plan = providerFromPlan(ownedWorkProduct(detail, req.params.queryPlanId, "legal_research_query_plan"));
      assertPlanIssueTreeCurrent(detail, plan);
      const caseContext = await assertPlanCaseContextCurrent({ repo, ctx, matterId: req.params.matterId, detail, plan });
      const searchResult = ownedWorkProduct(detail, req.params.searchResultId, "legal_research_search_result");
      if (
        searchResult.content.queryPlanId !== req.params.queryPlanId ||
        searchResult.content.issueTreeId !== plan.issueTreeId ||
        searchResult.content.issueTreeHash !== plan.issueTreeHash ||
        !hasCaseContextBinding(searchResult.content, caseContext) ||
        searchResult.content.provider !== plan.provider ||
        searchResult.content.queryHash !== plan.queryHash
      ) {
        throw new LegalResearchRouteError("The candidate set does not belong to this approved query plan.", 409, "invalid_binding");
      }
      const candidate = Array.isArray(searchResult.content.candidates)
        ? searchResult.content.candidates.find((item) => object(item).documentId === req.params.documentId)
        : null;
      if (!candidate) throw new LegalResearchRouteError("The source was not returned by this approved query.", 409, "invalid_binding");
      const fetchHash = sourceFetchHash({
        queryPlanId: req.params.queryPlanId,
        searchResultId: req.params.searchResultId,
        provider: plan.provider,
        documentId: req.params.documentId,
        queryHash: plan.queryHash,
        issueTreeHash: plan.issueTreeHash,
        ...(caseContext ?? {}),
      });
      const result = await repo.requestApproval(ctx, req.params.matterId, {
        action: "external_source_use",
        prompt: "确认从已授权法律数据 API 下载该候选来源，并保存为本地不可变快照。",
        requestedPayload: {
          operation: "legal_research_source_fetch",
          queryPlanId: req.params.queryPlanId,
          searchResultId: req.params.searchResultId,
          issueTreeId: plan.issueTreeId,
          issueTreeHash: plan.issueTreeHash,
          ...(caseContext ?? {}),
          provider: plan.provider,
          documentId: req.params.documentId,
          queryHash: plan.queryHash,
          sourceFetchHash: fetchHash,
        },
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/query-plans/:queryPlanId/search-results/:searchResultId/sources/:documentId/fetch", requireAuth, async (req, res) => {
    try {
      const approvalCheckpointId = requiredText(object(req.body).approvalCheckpointId, "approvalCheckpointId", 160);
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const plan = providerFromPlan(ownedWorkProduct(detail, req.params.queryPlanId, "legal_research_query_plan"));
      assertPlanIssueTreeCurrent(detail, plan);
      const caseContext = await assertPlanCaseContextCurrent({ repo, ctx, matterId: req.params.matterId, detail, plan });
      const searchResult = ownedWorkProduct(detail, req.params.searchResultId, "legal_research_search_result");
      const candidate = Array.isArray(searchResult.content.candidates)
        ? searchResult.content.candidates.find((item) => object(item).documentId === req.params.documentId)
        : null;
      if (
        !candidate ||
        searchResult.content.queryPlanId !== req.params.queryPlanId ||
        searchResult.content.issueTreeId !== plan.issueTreeId ||
        searchResult.content.issueTreeHash !== plan.issueTreeHash ||
        !hasCaseContextBinding(searchResult.content, caseContext) ||
        searchResult.content.provider !== plan.provider ||
        searchResult.content.queryHash !== plan.queryHash
      ) {
        throw new LegalResearchRouteError("The source was not returned by this approved query.", 409, "invalid_binding");
      }
      const fetchHash = sourceFetchHash({
        queryPlanId: req.params.queryPlanId,
        searchResultId: req.params.searchResultId,
        provider: plan.provider,
        documentId: req.params.documentId,
        queryHash: plan.queryHash,
        issueTreeHash: plan.issueTreeHash,
        ...(caseContext ?? {}),
      });
      const approved = await repo.hasApprovedCheckpoint(ctx, req.params.matterId, approvalCheckpointId, "external_source_use", {
        operation: "legal_research_source_fetch",
        queryPlanId: req.params.queryPlanId,
        searchResultId: req.params.searchResultId,
        issueTreeId: plan.issueTreeId,
        issueTreeHash: plan.issueTreeHash,
        ...(caseContext ?? {}),
        provider: plan.provider,
        documentId: req.params.documentId,
        queryHash: plan.queryHash,
        sourceFetchHash: fetchHash,
      });
      if (!approved) return void res.status(409).json({ code: "approval_required", detail: "An approved source-specific external-source checkpoint is required." });
      const document = await adapterFor({ provider: plan.provider, userId: ctx.userId }).fetch({ documentId: req.params.documentId });
      if (document.documentId !== req.params.documentId) {
        throw new LegalSourceAdapterError(
          "Authorized legal-source document ID does not match the approved source.",
          "response_invalid",
        );
      }
      const sourceIdentity = `${plan.provider}:${document.documentId}`;
      const sourceDomain = new URL(document.snapshot.url).hostname;
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "external_source_workpaper",
        title: document.title,
        status: "generated",
        schemaVersion: SOURCE_SNAPSHOT_SCHEMA,
        content: {
          schemaVersion: SOURCE_SNAPSHOT_SCHEMA,
          requestId: plan.requestId,
          queryPlanId: req.params.queryPlanId,
          searchResultId: req.params.searchResultId,
          issueTreeId: plan.issueTreeId,
          issueTreeHash: plan.issueTreeHash,
          ...(caseContext ?? {}),
          sourceIdentity,
          sourceDomain,
          provider: plan.provider,
          documentId: document.documentId,
          snapshot: document.snapshot,
          content: document.content,
          verificationStatus: "captured_unverified",
        },
        validationErrors: [],
        generatedBy: "system",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "system",
        action: "legal_research_source_snapshot_saved",
        workflowVersion: SOURCE_SNAPSHOT_SCHEMA,
        model: null,
        details: {
          sourceSnapshotId: (result as WorkProduct).id,
          sourceIdentity,
          provider: plan.provider,
          documentId: document.documentId,
          issueTreeId: plan.issueTreeId,
          issueTreeHash: plan.issueTreeHash,
          ...(caseContext ?? {}),
          contentHash: document.snapshot.contentHash,
          sourceUrl: document.snapshot.url,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/snapshots/:snapshotId/excerpts", requireAuth, async (req, res) => {
    try {
      const body = object(req.body);
      const quote = requiredText(body.quote, "quote", 8000);
      const comment = requiredText(body.comment, "comment", 4000);
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const source = ownedWorkProduct(detail, req.params.snapshotId, "external_source_workpaper");
      const caseContext = caseContextBindingFromContent(source.content);
      const parsed = sourceSnapshotFromWorkProduct(source);
      const start = parsed.content.indexOf(quote);
      if (start < 0) throw new LegalResearchRouteError("The confirmed excerpt must exactly match the stored local source snapshot.", 409, "quote_mismatch");
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_research_excerpt",
        title: `律师确认摘录：${source.title}`,
        status: "accepted",
        schemaVersion: EXCERPT_SCHEMA,
        content: {
          schemaVersion: EXCERPT_SCHEMA,
          requestId: source.content.requestId,
          queryPlanId: source.content.queryPlanId,
          issueTreeId: requiredText(source.content.issueTreeId, "snapshot issueTreeId", 160),
          issueTreeHash: requiredText(source.content.issueTreeHash, "snapshot issueTreeHash", 100),
          ...(caseContext ?? {}),
          snapshotId: source.id,
          sourceIdentity: parsed.sourceIdentity,
          sourceContentHash: parsed.snapshot.contentHash,
          quote,
          quoteHash: sha256(quote),
          startOffset: start,
          endOffset: start + quote.length,
          confirmedComment: comment,
        },
        validationErrors: [],
        generatedBy: "human",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "human",
        action: "legal_research_excerpt_confirmed",
        workflowVersion: EXCERPT_SCHEMA,
        model: null,
        details: {
          excerptId: (result as WorkProduct).id,
          snapshotId: source.id,
          issueTreeId: requiredText(source.content.issueTreeId, "snapshot issueTreeId", 160),
          issueTreeHash: requiredText(source.content.issueTreeHash, "snapshot issueTreeHash", 100),
          ...(caseContext ?? {}),
          ...auditSourceIdentity(parsed.sourceIdentity),
          sourceContentHash: parsed.snapshot.contentHash,
          quoteHash: sha256(quote),
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/requests/:requestId/input-manifests", requireAuth, async (req, res) => {
    try {
      const excerptIds = textArray(object(req.body).excerptIds, "excerptIds", 80, 160);
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const request = researchRequest(ownedWorkProduct(detail, req.params.requestId, "legal_research_request"));
      const caseContext = await assertCurrentCaseContext(repo, ctx, req.params.matterId, detail, request);
      const products = matterWorkProducts(detail);
      const latest = latestSnapshots(products);
      const excerpts = excerptIds.map((id) => ownedWorkProduct(detail, id, "legal_research_excerpt"));
      const bindings = excerpts.map((excerpt) => {
        if (excerpt.status !== "accepted") throw new LegalResearchRouteError("Only lawyer-confirmed excerpts may enter Agent input.", 409, "invalid_binding");
        const content = object(excerpt.content);
        if (content.requestId !== req.params.requestId) throw new LegalResearchRouteError("An excerpt belongs to a different research request.", 409, "invalid_binding");
        if (!hasCaseContextBinding(content, caseContext)) {
          throw new LegalResearchRouteError("An excerpt does not match the current immutable case context.", 409, "case_context_changed");
        }
        const sourceIdentity = requiredText(content.sourceIdentity, "excerpt sourceIdentity", 1200);
        const sourceContentHash = requiredText(content.sourceContentHash, "excerpt sourceContentHash", 100);
        const issueTreeId = requiredText(content.issueTreeId, "excerpt issueTreeId", 160);
        const issueTreeHash = requiredText(content.issueTreeHash, "excerpt issueTreeHash", 100);
        const current = latest.get(sourceIdentity);
        if (!current || sourceSnapshotFromWorkProduct(current).snapshot.contentHash !== sourceContentHash) {
          throw new LegalResearchRouteError("A selected source changed after this excerpt was confirmed. Confirm a new excerpt before continuing.", 409, "source_changed");
        }
        return {
          excerptId: excerpt.id,
          excerptHash: excerpt.content_hash ?? sha256(JSON.stringify(content)),
          snapshotId: content.snapshotId,
          sourceIdentity,
          sourceContentHash,
          issueTreeId,
          issueTreeHash,
          quoteHash: content.quoteHash,
        };
      });
      const issueTreeIds = [...new Set(bindings.map((binding) => binding.issueTreeId))];
      const issueTreeHashes = [...new Set(bindings.map((binding) => binding.issueTreeHash))];
      if (issueTreeIds.length !== 1 || issueTreeHashes.length !== 1) {
        throw new LegalResearchRouteError(
          "Selected excerpts were produced under different local issue trees. Bind excerpts from one current issue tree only.",
          409,
          "invalid_binding",
        );
      }
      const issueTree = issueTreeForPlan(detail, req.params.requestId, issueTreeIds[0]);
      if (issueTree.treeHash !== issueTreeHashes[0]) {
        throw new LegalResearchRouteError(
          "The local issue tree changed after these excerpts were confirmed. Run research again before binding Agent input.",
          409,
          "issue_tree_changed",
        );
      }
      const bindingHash = sha256(stableJson({
        requestId: req.params.requestId,
        issueTreeId: issueTree.id,
        issueTreeHash: issueTree.treeHash,
        ...(caseContext ?? {}),
        excerpts: bindings,
      }));
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_research_input_manifest",
        title: `研究输入清单：${req.params.requestId}`,
        status: "accepted",
        schemaVersion: INPUT_MANIFEST_SCHEMA,
        content: {
          schemaVersion: INPUT_MANIFEST_SCHEMA,
          requestId: req.params.requestId,
          issueTreeId: issueTree.id,
          issueTreeHash: issueTree.treeHash,
          ...(caseContext ?? {}),
          excerpts: bindings,
          bindingHash,
        },
        validationErrors: [],
        generatedBy: "system",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "system",
        action: "legal_research_agent_input_bound",
        workflowVersion: INPUT_MANIFEST_SCHEMA,
        model: null,
        details: {
          inputManifestId: (result as WorkProduct).id,
          requestId: req.params.requestId,
          issueTreeId: issueTree.id,
          issueTreeHash: issueTree.treeHash,
          ...(caseContext ?? {}),
          bindingHash,
          excerptCount: bindings.length,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/research/input-manifests/:inputManifestId/memos", requireAuth, async (req, res) => {
    try {
      const body = object(req.body);
      const ctx = userContext(res);
      const repo = repository();
      const detail = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const manifest = ownedWorkProduct(detail, req.params.inputManifestId, "legal_research_input_manifest");
      if (manifest.status !== "accepted" || manifest.content.schemaVersion !== INPUT_MANIFEST_SCHEMA) {
        throw new LegalResearchRouteError("The local research input manifest is not available.", 409, "invalid_state");
      }
      const requestId = requiredText(manifest.content.requestId, "requestId", 160);
      const request = researchRequest(ownedWorkProduct(detail, requestId, "legal_research_request"));
      const caseContext = await assertCurrentCaseContext(repo, ctx, req.params.matterId, detail, request);
      if (!hasCaseContextBinding(manifest.content, caseContext)) {
        throw new LegalResearchRouteError(
          "The Agent input manifest does not match the current immutable case context.",
          409,
          "case_context_changed",
        );
      }
      const manifestIssueTree = issueTreeForPlan(
        detail,
        requestId,
        requiredText(manifest.content.issueTreeId, "issueTreeId", 160),
      );
      if (manifestIssueTree.treeHash !== requiredText(manifest.content.issueTreeHash, "issueTreeHash", 100)) {
        throw new LegalResearchRouteError(
          "The local issue tree changed after the Agent input was bound. Build a new research chain.",
          409,
          "issue_tree_changed",
        );
      }
      const bindings = Array.isArray(manifest.content.excerpts) ? manifest.content.excerpts : [];
      const excerpts = new Map<string, WorkProduct>();
      const snapshots = new Map<string, WorkProduct>();
      const sourceSnapshots: Array<{ sourceIdentity: string; contentHash: string }> = [];
      for (const rawBinding of bindings) {
        const binding = object(rawBinding);
        const excerpt = ownedWorkProduct(detail, requiredText(binding.excerptId, "excerptId", 160), "legal_research_excerpt");
        excerpts.set(excerpt.id, excerpt);
        const snapshotId = requiredText(binding.snapshotId, "snapshotId", 160);
        snapshots.set(snapshotId, ownedWorkProduct(detail, snapshotId, "external_source_workpaper"));
        sourceSnapshots.push({ sourceIdentity: requiredText(binding.sourceIdentity, "sourceIdentity", 1200), contentHash: requiredText(binding.sourceContentHash, "sourceContentHash", 100) });
      }
      const latest = latestSnapshots(matterWorkProducts(detail));
      for (const source of sourceSnapshots) {
        if (sourceSnapshotFromWorkProduct(latest.get(source.sourceIdentity) as WorkProduct).snapshot.contentHash !== source.contentHash) {
          throw new LegalResearchRouteError("A source changed after the Agent input was bound. Build a new input manifest.", 409, "source_changed");
        }
      }
      const findings = findingsForManifest({ value: body.findings, manifest, excerpts, snapshots });
      const gate = evaluateLegalResearchGate({ asOfDate: request.asOfDate, findings });
      if (gate.status !== "ready_for_review") {
        const blocked = await repo.createWorkProduct(ctx, req.params.matterId, {
          kind: "legal_research_memo",
          title: `研究备忘录（依据不足）：${request.title}`,
          status: "draft",
          schemaVersion: MEMO_SCHEMA,
          content: {
            schemaVersion: MEMO_SCHEMA,
            requestId,
            issueTreeId: manifestIssueTree.id,
            issueTreeHash: manifestIssueTree.treeHash,
            ...(caseContext ?? {}),
            inputManifestId: manifest.id,
            inputBindingHash: manifest.content.bindingHash,
            findings,
            sourceSnapshots,
            gate,
            finalization: "blocked",
          },
          validationErrors: gate.reasons.map((reason) => ({ code: "insufficient_basis", detail: reason })),
          generatedBy: "human",
          model: null,
        });
        await repo.appendAuditEvent(ctx, req.params.matterId, {
          actor: "system",
          action: "legal_research_insufficient_basis",
          workflowVersion: MEMO_SCHEMA,
          model: null,
          details: {
            requestId,
            issueTreeId: manifestIssueTree.id,
            issueTreeHash: manifestIssueTree.treeHash,
            ...(caseContext ?? {}),
            inputManifestId: manifest.id,
            gateReasons: gate.reasons,
          },
        });
        return void res.status(422).json({ code: "insufficient_basis", detail: "依据不足：系统没有形成可供审核的来源支持结论。", gate, workProduct: blocked });
      }
      const result = await repo.createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_qa_answer",
        title: `法律研究备忘录：${request.title}`,
        status: "needs_review",
        schemaVersion: MEMO_SCHEMA,
        content: {
          schemaVersion: MEMO_SCHEMA,
          requestId,
          issueTreeId: manifestIssueTree.id,
          issueTreeHash: manifestIssueTree.treeHash,
          ...(caseContext ?? {}),
          inputManifestId: manifest.id,
          inputBindingHash: manifest.content.bindingHash,
          findings,
          sourceSnapshots,
          gate,
          finalization: "human_review_required",
        },
        validationErrors: [],
        generatedBy: "human",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      const answer = result as WorkProduct;
      const review = await repo.addReview(ctx, req.params.matterId, {
        targetType: "work_product",
        targetId: answer.id,
        workProductId: answer.id,
        evidenceItemId: null,
        reviewerName: null,
        tag: "needs_human_judgment",
        comment: "请复核问题拆解、正反观点、每项结论对应的原文摘录、法规适用日期以及尚未解决的不确定性。",
      });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "system",
        action: "human_note.legal_qa_answer_persisted",
        workflowVersion: MEMO_SCHEMA,
        model: null,
        details: {
          workpaperId: answer.id,
          reviewCommentId: object(review).id ?? null,
          requestId,
          issueTreeId: manifestIssueTree.id,
          issueTreeHash: manifestIssueTree.treeHash,
          ...(caseContext ?? {}),
          inputManifestId: manifest.id,
          inputBindingHash: manifest.content.bindingHash,
          gate,
          sourceSnapshots: auditSourceSnapshots(sourceSnapshots),
        },
      });
      res.status(201).json({ ...answer, review });
    } catch (error) {
      routeError(res, error);
    }
  });

  return router;
}

export const legalResearchRouter = createLegalResearchRouter();
