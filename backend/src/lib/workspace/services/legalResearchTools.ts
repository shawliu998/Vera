import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import type { SourceDataUsePolicyV11 } from "../sourceFoundationContractsV11";
import {
  LEGAL_SOURCE_TYPES,
  LegalProviderContextSchema,
  LegalProviderSearchItemSchema,
  LegalSearchRequestSchema,
  LegalSourceDocumentSchema,
  WorkspaceLegalResearchProviderRegistry,
  type LegalProviderSearchItem,
  type LegalResearchProviderStatus,
  type LegalSourceDocument,
} from "./legalResearchProvider";

export const LEGAL_RESEARCH_TOOL_MODULE_ID = "legal-research-tools" as const;
export const LEGAL_RESEARCH_TOOL_ADAPTER_ID =
  "vera-local-legal-research-tools-v1" as const;

const SourceRefSchema = z.string().trim().min(1).max(500);
const SearchToolInputSchema = LegalSearchRequestSchema;
const ReadToolInputSchema = z.object({ sourceRef: SourceRefSchema }).strict();

export const LEGAL_RESEARCH_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "search_legal_sources" as const,
    description:
      "Search the configured authorized legal source for bounded metadata. This tool never returns full text.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: Object.freeze({
        query: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 4_000,
        }),
        jurisdiction: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 160,
        }),
        sourceTypes: Object.freeze({
          type: "array",
          maxItems: 5,
          uniqueItems: true,
          items: Object.freeze({ type: "string", enum: LEGAL_SOURCE_TYPES }),
        }),
        dateFrom: Object.freeze({
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        }),
        dateTo: Object.freeze({
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        }),
        limit: Object.freeze({ type: "integer", minimum: 1, maximum: 20 }),
      }),
    }),
  }),
  Object.freeze({
    name: "read_legal_source" as const,
    description:
      "Read one bounded legal source previously returned in this Matter research session.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["sourceRef"],
      properties: Object.freeze({
        sourceRef: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 500,
        }),
      }),
    }),
  }),
] as const);

export type LegalResearchToolName =
  (typeof LEGAL_RESEARCH_TOOL_DEFINITIONS)[number]["name"];

export type LegalResearchToolContext = z.infer<
  typeof LegalProviderContextSchema
> &
  Readonly<{
    modelExecution: "local" | "remote";
    /** Present only for a fenced durable Assistant generation attempt. */
    jobId?: string;
    attempt?: number;
    leaseOwner?: string;
  }>;

export type OwnedLegalSourceReference = Readonly<{
  sourceRef: string;
  providerId: string;
  providerSourceId: string;
  queryId: string;
  durable: boolean;
  /** Durable read owner allocated when the sourceRef is resolved. */
  readId?: string;
}>;

export interface LegalResearchSessionOwnershipPort {
  recordSearch(input: {
    context: LegalResearchToolContext;
    providerId: string;
    queryId: string;
    results: readonly LegalProviderSearchItem[];
    transient: boolean;
  }): Promise<readonly OwnedLegalSourceReference[]>;
  resolveOwnedSource(input: {
    context: LegalResearchToolContext;
    sourceRef: string;
  }): Promise<OwnedLegalSourceReference | null>;
}

export type CapturedLegalSourceExcerpt = Readonly<{
  anchorCandidateId: string;
  text: string;
  locator?: Readonly<{
    article?: string;
    section?: string;
    paragraph?: string;
    page?: number;
  }>;
}>;

export interface LegalResearchSourceCapturePort {
  capture(input: {
    context: LegalResearchToolContext;
    providerId: string;
    sourceRef: string;
    readId: string;
    document: LegalSourceDocument;
    dataUsePolicy: SourceDataUsePolicyV11;
  }): Promise<{
    snapshotId: string;
    excerpts: readonly CapturedLegalSourceExcerpt[];
  }>;
}

export class LegalResearchToolError extends Error {
  readonly retryable = false;

  constructor(
    readonly code:
      | "legal_source_not_owned"
      | "legal_source_license_restricted"
      | "legal_source_capture_invalid"
      | "legal_research_limit_exceeded"
      | "legal_research_tool_invalid",
    message: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LegalResearchToolError";
  }
}

const MAX_RESEARCH_SESSIONS = 256;
const MAX_SEARCHES_PER_SESSION = 4;
const MAX_READS_PER_SESSION = 12;
const MAX_RESULTS_PER_SEARCH = 20;
const MAX_TOOL_RESULT_UTF8_BYTES = 180 * 1_024;

type InMemoryResearchSession = {
  readonly projectId: string;
  readonly researchSessionId: string;
  searches: number;
  reads: number;
  readonly sources: Map<string, OwnedLegalSourceReference>;
};

/**
 * Bounded process-local ownership for the technical vertical. It never stores
 * result metadata, content, endpoint data, or credentials. A new durable job
 * attempt supplies a new outer researchSessionId and therefore fences every
 * old sourceRef even before LRU eviction.
 */
export class BoundedInMemoryLegalResearchSessionOwnership implements LegalResearchSessionOwnershipPort {
  private readonly sessions = new Map<string, InMemoryResearchSession>();

  private sessionKey(context: LegalResearchToolContext): string {
    validateContext(context);
    return `${context.projectId}\0${context.researchSessionId}`;
  }

  private touch(key: string, session: InMemoryResearchSession): void {
    this.sessions.delete(key);
    this.sessions.set(key, session);
  }

  private getOrCreate(context: LegalResearchToolContext) {
    const key = this.sessionKey(context);
    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing;
    }
    const created: InMemoryResearchSession = {
      projectId: context.projectId,
      researchSessionId: context.researchSessionId,
      searches: 0,
      reads: 0,
      sources: new Map(),
    };
    this.sessions.set(key, created);
    while (this.sessions.size > MAX_RESEARCH_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return created;
  }

  async recordSearch(input: {
    context: LegalResearchToolContext;
    providerId: string;
    queryId: string;
    results: readonly LegalProviderSearchItem[];
    transient: boolean;
  }): Promise<readonly OwnedLegalSourceReference[]> {
    const providerId = z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/)
      .parse(input.providerId);
    const queryId = z.string().trim().min(1).max(500).parse(input.queryId);
    const parsedResults = z
      .array(LegalProviderSearchItemSchema)
      .max(MAX_RESULTS_PER_SEARCH)
      .safeParse(input.results);
    if (!parsedResults.success) {
      throw new LegalResearchToolError(
        Array.isArray(input.results) &&
          input.results.length > MAX_RESULTS_PER_SEARCH
          ? "legal_research_limit_exceeded"
          : "legal_research_tool_invalid",
        "Legal research ownership results are invalid or exceed the limit.",
        { cause: parsedResults.error },
      );
    }
    const results = parsedResults.data;
    if (typeof input.transient !== "boolean") {
      throw new LegalResearchToolError(
        "legal_research_tool_invalid",
        "Legal research ownership mode is invalid.",
      );
    }
    const session = this.getOrCreate(input.context);
    if (session.searches >= MAX_SEARCHES_PER_SESSION) {
      throw new LegalResearchToolError(
        "legal_research_limit_exceeded",
        "Legal research search limit was exceeded for this session.",
      );
    }
    session.searches += 1;
    return results.map((result) => {
      let sourceRef: string;
      do {
        sourceRef = randomBytes(24).toString("base64url");
      } while (session.sources.has(sourceRef));
      const reference: OwnedLegalSourceReference = Object.freeze({
        sourceRef,
        providerId,
        providerSourceId: result.providerSourceId,
        queryId,
        durable: !input.transient,
        ...(!input.transient ? { readId: randomUUID() } : {}),
      });
      session.sources.set(sourceRef, reference);
      return reference;
    });
  }

  async resolveOwnedSource(input: {
    context: LegalResearchToolContext;
    sourceRef: string;
  }): Promise<OwnedLegalSourceReference | null> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(input.sourceRef)) return null;
    const key = this.sessionKey(input.context);
    const session = this.sessions.get(key);
    if (!session) return null;
    this.touch(key, session);
    if (session.reads >= MAX_READS_PER_SESSION) {
      throw new LegalResearchToolError(
        "legal_research_limit_exceeded",
        "Legal research read limit was exceeded for this session.",
      );
    }
    session.reads += 1;
    return session.sources.get(input.sourceRef) ?? null;
  }
}

function boundedToolResult<T>(value: T): T {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    MAX_TOOL_RESULT_UTF8_BYTES
  ) {
    throw new LegalResearchToolError(
      "legal_research_tool_invalid",
      "Legal research tool result exceeds the safe response boundary.",
    );
  }
  return value;
}

function allowModelUse(
  status: LegalResearchProviderStatus,
  context: LegalResearchToolContext,
): boolean {
  const policy = status.dataUsePolicy;
  if (status.technicalPoc.enabled && status.toolUseAllowed) return true;
  return (
    policy.basis === "deployment_contract" &&
    (policy.modelUse === "permitted" ||
      (policy.modelUse === "local_only" && context.modelExecution === "local"))
  );
}

function allowSnapshot(status: LegalResearchProviderStatus): boolean {
  return (
    status.dataUsePolicy.retention === "full_text_permitted" ||
    status.dataUsePolicy.retention === "full_text_ttl"
  );
}

function validateContext(context: LegalResearchToolContext) {
  LegalProviderContextSchema.parse({
    projectId: context.projectId,
    researchSessionId: context.researchSessionId,
  });
  if (
    context.modelExecution !== "local" &&
    context.modelExecution !== "remote"
  ) {
    throw new LegalResearchToolError(
      "legal_research_tool_invalid",
      "Legal research model execution boundary is invalid.",
    );
  }
  const ownerFieldCount = [
    context.jobId,
    context.attempt,
    context.leaseOwner,
  ].filter((value) => value !== undefined).length;
  if (
    (ownerFieldCount !== 0 && ownerFieldCount !== 3) ||
    (context.jobId !== undefined &&
      !z.string().uuid().safeParse(context.jobId).success) ||
    (context.attempt !== undefined &&
      (!Number.isSafeInteger(context.attempt) ||
        context.attempt < 1 ||
        context.attempt > 100)) ||
    (context.leaseOwner !== undefined &&
      (typeof context.leaseOwner !== "string" ||
        context.leaseOwner.trim().length < 1 ||
        context.leaseOwner.length > 200))
  ) {
    throw new LegalResearchToolError(
      "legal_research_tool_invalid",
      "Legal research Assistant owner boundary is invalid.",
    );
  }
}

function providerContext(context: LegalResearchToolContext) {
  return LegalProviderContextSchema.parse({
    projectId: context.projectId,
    researchSessionId: context.researchSessionId,
  });
}

function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Legal research tool was cancelled.");
  error.name = "AbortError";
  throw error;
}

function validateOwnership(
  value: readonly OwnedLegalSourceReference[],
  providerId: string,
  queryId: string,
  results: readonly LegalProviderSearchItem[],
  durable: boolean,
): Map<string, OwnedLegalSourceReference> {
  if (value.length !== results.length) {
    throw new LegalResearchToolError(
      "legal_research_tool_invalid",
      "Legal research ownership store returned an invalid result count.",
    );
  }
  const byProviderSourceId = new Map<string, OwnedLegalSourceReference>();
  for (const reference of value) {
    const sourceRef = SourceRefSchema.safeParse(reference.sourceRef);
    if (
      !sourceRef.success ||
      reference.providerId !== providerId ||
      reference.queryId !== queryId ||
      reference.durable !== durable ||
      !results.some(
        (result) => result.providerSourceId === reference.providerSourceId,
      ) ||
      byProviderSourceId.has(reference.providerSourceId)
    ) {
      throw new LegalResearchToolError(
        "legal_research_tool_invalid",
        "Legal research ownership store returned an invalid source reference.",
      );
    }
    byProviderSourceId.set(reference.providerSourceId, reference);
  }
  return byProviderSourceId;
}

export class WorkspaceLegalResearchTools {
  constructor(
    private readonly providerId: string,
    private readonly providers: WorkspaceLegalResearchProviderRegistry,
    private readonly ownership: LegalResearchSessionOwnershipPort,
    private readonly sourceCapture: LegalResearchSourceCapturePort | null,
  ) {}

  async status(
    context: LegalResearchToolContext,
  ): Promise<LegalResearchProviderStatus> {
    validateContext(context);
    return this.providers.status(this.providerId, providerContext(context));
  }

  async registeredTools(context: LegalResearchToolContext) {
    const status = await this.status(context);
    return status.toolUseAllowed ? LEGAL_RESEARCH_TOOL_DEFINITIONS : [];
  }

  async search(input: {
    context: LegalResearchToolContext;
    rawInput: unknown;
    signal: AbortSignal;
  }) {
    validateContext(input.context);
    abortIfNeeded(input.signal);
    const request = SearchToolInputSchema.parse(input.rawInput);
    const preflight = await this.status(input.context);
    if (!allowModelUse(preflight, input.context)) {
      throw new LegalResearchToolError(
        "legal_source_license_restricted",
        "Legal source rights do not permit metadata use by this model.",
      );
    }
    const { status, response } = await this.providers.search({
      providerId: this.providerId,
      context: providerContext(input.context),
      request,
      signal: input.signal,
    });
    abortIfNeeded(input.signal);
    const references = await this.ownership.recordSearch({
      context: input.context,
      providerId: this.providerId,
      queryId: response.queryId,
      results: response.results,
      transient: status.technicalPoc.enabled,
    });
    abortIfNeeded(input.signal);
    const byProviderSourceId = validateOwnership(
      references,
      this.providerId,
      response.queryId,
      response.results,
      !status.technicalPoc.enabled,
    );
    return boundedToolResult({
      provider: status.providerId,
      queryId: response.queryId,
      durable: !status.technicalPoc.enabled,
      results: response.results.map((result) => ({
        sourceRef: byProviderSourceId.get(result.providerSourceId)!.sourceRef,
        title: result.title,
        sourceType: result.sourceType,
        jurisdiction: result.jurisdiction,
        court: result.court,
        caseNumber: result.caseNumber,
        effectiveDate: result.effectiveDate,
        status: result.status,
        summary: result.summary,
      })),
    });
  }

  async read(input: {
    context: LegalResearchToolContext;
    rawInput: unknown;
    signal: AbortSignal;
  }) {
    validateContext(input.context);
    abortIfNeeded(input.signal);
    const request = ReadToolInputSchema.parse(input.rawInput);
    const owned = await this.ownership.resolveOwnedSource({
      context: input.context,
      sourceRef: request.sourceRef,
    });
    abortIfNeeded(input.signal);
    if (!owned || owned.providerId !== this.providerId) {
      throw new LegalResearchToolError(
        "legal_source_not_owned",
        "Legal source is not owned by this Matter research session.",
      );
    }
    if (
      owned.sourceRef !== request.sourceRef ||
      !SourceRefSchema.safeParse(owned.sourceRef).success ||
      typeof owned.providerSourceId !== "string" ||
      owned.providerSourceId.trim().length < 1 ||
      owned.providerSourceId.length > 500 ||
      typeof owned.queryId !== "string" ||
      owned.queryId.trim().length < 1 ||
      owned.queryId.length > 500 ||
      typeof owned.durable !== "boolean"
    ) {
      throw new LegalResearchToolError(
        "legal_source_not_owned",
        "Legal source ownership record is invalid for this research session.",
      );
    }
    const preflight = await this.status(input.context);
    if (
      !allowModelUse(preflight, input.context) ||
      (!preflight.technicalPoc.enabled && !allowSnapshot(preflight))
    ) {
      throw new LegalResearchToolError(
        "legal_source_license_restricted",
        "Legal source rights do not permit this retention and model-use path.",
      );
    }
    const { status, document } = await this.providers.fetchSource({
      providerId: owned.providerId,
      context: providerContext(input.context),
      request: { providerSourceId: owned.providerSourceId },
      signal: input.signal,
    });
    if (
      !allowModelUse(status, input.context) ||
      (!status.technicalPoc.enabled && !allowSnapshot(status))
    ) {
      throw new LegalResearchToolError(
        "legal_source_license_restricted",
        "Legal source rights do not permit this retention and model-use path.",
      );
    }
    if (status.technicalPoc.enabled) {
      if (owned.durable) {
        throw new LegalResearchToolError(
          "legal_source_not_owned",
          "Technical PoC source references must remain transient.",
        );
      }
      return boundedToolResult({
        snapshotId: null,
        durable: false,
        provider: status.providerId,
        sourceRef: owned.sourceRef,
        title: document.title,
        sourceType: document.sourceType,
        metadata: {
          ...document.metadata,
          retrievedAt: document.retrievedAt,
        },
        excerpts: [
          {
            anchorCandidateId: `transient:${owned.sourceRef}`,
            text: document.content.slice(0, 8_000),
            locator: document.locator,
          },
        ],
      });
    }
    if (!owned.durable) {
      throw new LegalResearchToolError(
        "legal_source_not_owned",
        "Durable legal research requires a durable session reference.",
      );
    }
    const readId = z.string().uuid().safeParse(owned.readId);
    if (!readId.success) {
      throw new LegalResearchToolError(
        "legal_source_not_owned",
        "Durable legal research read owner is invalid.",
      );
    }
    if (!this.sourceCapture) {
      throw new LegalResearchToolError(
        "legal_source_capture_invalid",
        "Durable legal source capture is unavailable.",
      );
    }
    if (
      (status.dataUsePolicy.retention === "full_text_ttl") !==
      (document.retentionExpiresAt !== null)
    ) {
      throw new LegalResearchToolError(
        "legal_source_license_restricted",
        "Legal source retention expiry does not match the declared policy.",
      );
    }
    const captured = await this.sourceCapture.capture({
      context: input.context,
      providerId: owned.providerId,
      sourceRef: owned.sourceRef,
      readId: readId.data,
      document,
      dataUsePolicy: status.dataUsePolicy,
    });
    abortIfNeeded(input.signal);
    const snapshotId = z.string().uuid().safeParse(captured.snapshotId);
    const excerpts = z
      .array(
        z
          .object({
            anchorCandidateId: z.string().trim().min(1).max(500),
            text: z.string().min(1).max(8_000),
            locator: LegalSourceDocumentSchema.shape.locator.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .safeParse(captured.excerpts);
    if (!snapshotId.success || !excerpts.success) {
      throw new LegalResearchToolError(
        "legal_source_capture_invalid",
        "Legal source capture returned an invalid bounded result.",
      );
    }
    return boundedToolResult({
      snapshotId: snapshotId.data,
      durable: true,
      provider: status.providerId,
      sourceRef: owned.sourceRef,
      title: document.title,
      sourceType: document.sourceType,
      metadata: {
        ...document.metadata,
        retrievedAt: document.retrievedAt,
      },
      excerpts: excerpts.data,
    });
  }

  async execute(input: {
    context: LegalResearchToolContext;
    call: Readonly<{ name: LegalResearchToolName; input: unknown }>;
    signal: AbortSignal;
  }) {
    if (input.call.name === "search_legal_sources") {
      return this.search({
        context: input.context,
        rawInput: input.call.input,
        signal: input.signal,
      });
    }
    if (input.call.name === "read_legal_source") {
      return this.read({
        context: input.context,
        rawInput: input.call.input,
        signal: input.signal,
      });
    }
    throw new LegalResearchToolError(
      "legal_research_tool_invalid",
      "Legal research tool is not registered.",
    );
  }
}
