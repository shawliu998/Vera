import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  AssistantLegalAuthoritySourceV22Schema,
  AssistantLegalAuthoritySourceWriteV22Schema,
  LEGAL_RESEARCH_MAX_ANCHORS_PER_READ_V22,
  LEGAL_RESEARCH_MAX_READS_V22,
  LEGAL_RESEARCH_MAX_RESULTS_PER_SEARCH_V22,
  LEGAL_RESEARCH_MAX_SEARCHES_V22,
  LegalResearchAuthorityEvidenceV22Schema,
  LegalResearchCandidateV22Schema,
  LegalResearchOwnerV22Schema,
  LegalResearchReadV22Schema,
  type AssistantLegalAuthoritySourceV22,
  type AssistantLegalAuthoritySourceWriteV22,
  type LegalResearchAuthorityEvidenceV22,
  type LegalResearchCandidateV22,
  type LegalResearchOwnerV22,
  type LegalResearchReadV22,
} from "../legalResearchPersistenceContractsV22";
import type { WorkspaceDatabaseAdapter } from "../migrations";
import {
  LegalProviderSearchItemSchema,
  type LegalProviderSearchItem,
} from "../services/legalResearchProvider";
import type {
  LegalResearchSourceCapturePort,
  LegalResearchSessionOwnershipPort,
  LegalResearchToolContext,
  OwnedLegalSourceReference,
} from "../services/legalResearchTools";

type Row = Record<string, unknown>;

const SENSITIVE_PERSISTED_TEXT =
  /(?:https?:\/\/|\bbearer\s+\S+|\bsk[_-][A-Za-z0-9_-]{8,}|(?:api[_-]?key|token|secret|credential|password|authorization)\s*[:=])/i;

export class WorkspaceLegalResearchRepositoryError extends Error {
  readonly code = "LEGAL_RESEARCH_PERSISTENCE_REJECTED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceLegalResearchRepositoryError";
  }
}

function rejected(message: string, cause?: unknown): never {
  throw new WorkspaceLegalResearchRepositoryError(
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    rejected(`Persisted ${label} is invalid.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    rejected(`Persisted ${label} is invalid.`);
  }
  return parsed;
}

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") rejected(`Persisted ${label} is invalid.`);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      rejected(`Persisted ${label} is invalid.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkspaceLegalResearchRepositoryError) throw error;
    rejected(`Persisted ${label} is invalid.`, error);
  }
}

function safeProviderText(value: string, label: string): string {
  if (SENSITIVE_PERSISTED_TEXT.test(value)) {
    rejected(`${label} contains an endpoint or credential-like value.`);
  }
  return value;
}

function canonicalResults(results: readonly LegalProviderSearchItem[]): string {
  return JSON.stringify(
    results.map((result) => ({
      providerSourceId: result.providerSourceId,
      title: result.title,
      sourceType: result.sourceType,
      jurisdiction: result.jurisdiction ?? null,
      court: result.court ?? null,
      caseNumber: result.caseNumber ?? null,
      effectiveDate: result.effectiveDate ?? null,
      status: result.status ?? null,
      summary: result.summary ?? null,
    })),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const AVAILABLE_LEGAL_SNAPSHOT_SQL = `
  snapshot.source_kind = 'legal_authority' AND
  lifecycle.access_state = 'available' AND
  snapshot.retention_policy IN ('full_text_ttl', 'full_text_permitted') AND
  json_extract(snapshot.license_json, '$.basis') IN ('deployment_contract', 'user_provided') AND
  json_extract(snapshot.license_json, '$.retention') = snapshot.retention_policy AND
  (snapshot.retention_policy = 'full_text_permitted' OR (
    lifecycle.expires_at_epoch_ms IS NOT NULL AND
    lifecycle.expires_at_epoch_ms > max(
      clock.high_water_epoch_ms,
      CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)
    )
  ))
`;
const REMOTE_MODEL_USE_SQL =
  "json_extract(snapshot.license_json, '$.modelUse') = 'permitted'";

function candidateFromRow(row: Row): LegalResearchCandidateV22 {
  return LegalResearchCandidateV22Schema.parse({
    sourceRef: row.source_ref,
    queryId: row.query_id,
    providerId: row.provider_id,
    providerQueryId: row.provider_query_id,
    providerSourceId: row.provider_source_id,
    title: row.title_snapshot,
    sourceType: row.source_type,
    jurisdiction: nullableText(row.jurisdiction) ?? undefined,
    court: nullableText(row.court) ?? undefined,
    caseNumber: nullableText(row.case_number) ?? undefined,
    effectiveDate: nullableText(row.effective_date) ?? undefined,
    status: nullableText(row.authority_status) ?? undefined,
    summary: nullableText(row.summary_snapshot) ?? undefined,
    ordinal: Number(row.ordinal),
    durable: true,
    createdAt: row.created_at,
  });
}

export class WorkspaceLegalResearchRepository {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly options: Readonly<{
      now?: () => string;
      nextId?: () => string;
      nextSourceRef?: () => string;
    }> = {},
  ) {}

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  private nextId(): string {
    return (this.options.nextId ?? randomUUID)();
  }

  private nextSourceRef(): string {
    return (
      this.options.nextSourceRef ??
      (() => randomBytes(24).toString("base64url"))
    )();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original rejection.
      }
      throw error;
    }
  }

  private assertOwnerInCurrentTransaction(input: LegalResearchOwnerV22) {
    const owner = LegalResearchOwnerV22Schema.parse(input);
    const row = this.database
      .prepare(
        `SELECT snapshot.output_message_id
           FROM assistant_generation_snapshots snapshot
           JOIN jobs job
             ON job.id = snapshot.job_id
            AND job.type = 'assistant_generate'
            AND job.resource_type = 'chat'
            AND job.resource_id = snapshot.chat_id
           JOIN chats chat
             ON chat.id = snapshot.chat_id
            AND chat.project_id = ?
           JOIN chat_messages output
             ON output.id = snapshot.output_message_id
            AND output.chat_id = snapshot.chat_id
            AND output.role = 'assistant'
            AND output.status = 'pending'
            AND output.job_id = job.id
           JOIN projects project
             ON project.id = chat.project_id
            AND project.status = 'active'
          WHERE snapshot.job_id = ?
            AND job.status = 'running'
            AND job.attempt = ?
            AND job.lease_owner = ?
            AND job.lease_expires_at IS NOT NULL
            AND julianday(job.lease_expires_at) > julianday('now')
            AND job.cancel_requested_at IS NULL`,
      )
      .get(owner.projectId, owner.jobId, owner.attempt, owner.leaseOwner);
    if (!row) {
      rejected("Legal research owner lost its active Assistant job lease.");
    }
    return {
      owner,
      outputMessageId: text(row.output_message_id, "output message id"),
    };
  }

  private ensureSessionInCurrentTransaction(input: LegalResearchOwnerV22) {
    const { owner, outputMessageId } =
      this.assertOwnerInCurrentTransaction(input);
    const existing = this.database
      .prepare(
        `SELECT project_id,job_id,job_attempt,output_message_id
           FROM legal_research_sessions WHERE id = ?`,
      )
      .get(owner.researchSessionId);
    if (existing) {
      if (
        existing.project_id !== owner.projectId ||
        existing.job_id !== owner.jobId ||
        Number(existing.job_attempt) !== owner.attempt ||
        existing.output_message_id !== outputMessageId
      ) {
        rejected("Legal research session identity is already owned elsewhere.");
      }
      return { owner, outputMessageId };
    }
    this.database
      .prepare(
        `INSERT INTO legal_research_sessions
           (id,project_id,job_id,job_attempt,output_message_id,created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        owner.researchSessionId,
        owner.projectId,
        owner.jobId,
        owner.attempt,
        outputMessageId,
        this.now(),
      );
    return { owner, outputMessageId };
  }

  ensureSession(owner: LegalResearchOwnerV22): void {
    this.transaction(() => this.ensureSessionInCurrentTransaction(owner));
  }

  recordSearch(
    input: Readonly<{
      owner: LegalResearchOwnerV22;
      providerId: string;
      providerQueryId: string;
      results: readonly LegalProviderSearchItem[];
    }>,
  ): readonly LegalResearchCandidateV22[] {
    const providerId = safeProviderText(input.providerId, "Provider id");
    const providerQueryId = safeProviderText(
      input.providerQueryId,
      "Provider query id",
    );
    const parsed = LegalProviderSearchItemSchema.array()
      .max(LEGAL_RESEARCH_MAX_RESULTS_PER_SEARCH_V22)
      .parse(input.results);
    if (
      new Set(parsed.map((item) => item.providerSourceId)).size !==
      parsed.length
    ) {
      rejected(
        "Legal research results contain duplicate provider source identities.",
      );
    }
    for (const result of parsed) {
      for (const [label, value] of Object.entries(result)) {
        if (typeof value === "string")
          safeProviderText(value, `Result ${label}`);
      }
    }
    const fingerprint = sha256(canonicalResults(parsed));
    return this.transaction(() => {
      const { owner } = this.ensureSessionInCurrentTransaction(input.owner);
      const existing = this.database
        .prepare(
          `SELECT id,result_fingerprint_sha256
             FROM legal_research_queries
            WHERE session_id = ? AND provider_id = ? AND provider_query_id = ?`,
        )
        .get(owner.researchSessionId, providerId, providerQueryId);
      if (existing) {
        if (existing.result_fingerprint_sha256 !== fingerprint) {
          rejected("Legal research query replay changed its candidate set.");
        }
        return this.candidatesForQuery(String(existing.id));
      }
      const ordinal = integer(
        this.database
          .prepare(
            `SELECT count(*) AS count FROM legal_research_queries WHERE session_id = ?`,
          )
          .get(owner.researchSessionId)?.count ?? 0,
        "research query count",
      );
      if (ordinal >= LEGAL_RESEARCH_MAX_SEARCHES_V22) {
        rejected("Legal research search limit was exceeded for this attempt.");
      }
      const queryId = this.nextId();
      const now = this.now();
      this.database
        .prepare(
          `INSERT INTO legal_research_queries
             (id,project_id,session_id,ordinal,provider_id,provider_query_id,
              result_fingerprint_sha256,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          queryId,
          owner.projectId,
          owner.researchSessionId,
          ordinal,
          providerId,
          providerQueryId,
          fingerprint,
          now,
        );
      const insert = this.database.prepare(
        `INSERT INTO legal_research_candidates
           (source_ref,project_id,session_id,query_id,ordinal,provider_source_id,
            title_snapshot,source_type,jurisdiction,court,case_number,effective_date,
            authority_status,summary_snapshot,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      parsed.forEach((result, resultOrdinal) => {
        const sourceRef = this.nextSourceRef();
        if (!/^[A-Za-z0-9_-]{32}$/.test(sourceRef)) {
          rejected("Generated legal source reference is invalid.");
        }
        insert.run(
          sourceRef,
          owner.projectId,
          owner.researchSessionId,
          queryId,
          resultOrdinal,
          result.providerSourceId,
          result.title,
          result.sourceType,
          result.jurisdiction ?? null,
          result.court ?? null,
          result.caseNumber ?? null,
          result.effectiveDate ?? null,
          result.status ?? null,
          result.summary ?? null,
          now,
        );
      });
      return this.candidatesForQuery(queryId);
    });
  }

  private candidatesForQuery(
    queryId: string,
  ): readonly LegalResearchCandidateV22[] {
    return this.database
      .prepare(
        `SELECT candidate.*,query.provider_id,query.provider_query_id
           FROM legal_research_candidates candidate
           JOIN legal_research_queries query ON query.id = candidate.query_id
          WHERE candidate.query_id = ?
          ORDER BY candidate.ordinal, candidate.source_ref`,
      )
      .all(queryId)
      .map(candidateFromRow);
  }

  resolveOwnedSource(
    input: Readonly<{
      owner: LegalResearchOwnerV22;
      sourceRef: string;
    }>,
  ): LegalResearchCandidateV22 & { readId: string } {
    if (!/^[A-Za-z0-9_-]{32}$/.test(input.sourceRef)) {
      rejected("Legal source reference is not owned by this research attempt.");
    }
    return this.transaction(() => {
      const { owner } = this.ensureSessionInCurrentTransaction(input.owner);
      const row = this.database
        .prepare(
          `SELECT candidate.*,query.provider_id,query.provider_query_id
             FROM legal_research_candidates candidate
             JOIN legal_research_queries query ON query.id = candidate.query_id
            WHERE candidate.project_id = ? AND candidate.session_id = ?
              AND candidate.source_ref = ?`,
        )
        .get(owner.projectId, owner.researchSessionId, input.sourceRef);
      if (!row)
        rejected(
          "Legal source reference is not owned by this research attempt.",
        );
      const ordinal = integer(
        this.database
          .prepare(
            `SELECT count(*) AS count FROM legal_research_reads WHERE session_id = ?`,
          )
          .get(owner.researchSessionId)?.count ?? 0,
        "research read count",
      );
      if (ordinal >= LEGAL_RESEARCH_MAX_READS_V22) {
        rejected("Legal research read limit was exceeded for this attempt.");
      }
      const readId = this.nextId();
      this.database
        .prepare(
          `INSERT INTO legal_research_reads
             (id,project_id,session_id,source_ref,ordinal,status,created_at)
           VALUES (?,?,?,?,?,'pending',?)`,
        )
        .run(
          readId,
          owner.projectId,
          owner.researchSessionId,
          input.sourceRef,
          ordinal,
          this.now(),
        );
      return { ...candidateFromRow(row), readId };
    });
  }

  bindReadCapture(
    input: Readonly<{
      owner: LegalResearchOwnerV22;
      readId: string;
      sourceRef: string;
      snapshotId: string;
      anchorIds: readonly string[];
    }>,
  ): LegalResearchReadV22 {
    const anchorIds = [...input.anchorIds];
    if (
      anchorIds.length < 1 ||
      anchorIds.length > LEGAL_RESEARCH_MAX_ANCHORS_PER_READ_V22 ||
      new Set(anchorIds).size !== anchorIds.length
    ) {
      rejected("Legal research capture anchor identities are invalid.");
    }
    return this.transaction(() => {
      const { owner } = this.ensureSessionInCurrentTransaction(input.owner);
      const read = this.database
        .prepare(
          `SELECT read.id
             FROM legal_research_reads read
             JOIN legal_research_candidates candidate
               ON candidate.source_ref = read.source_ref
              AND candidate.project_id = read.project_id
              AND candidate.session_id = read.session_id
             JOIN project_source_snapshots snapshot
               ON snapshot.project_id = read.project_id
              AND snapshot.id = ?
              AND snapshot.source_kind = 'legal_authority'
              AND snapshot.source_record_id = candidate.provider_source_id
             JOIN project_source_snapshot_lifecycle lifecycle
               ON lifecycle.project_id = snapshot.project_id
              AND lifecycle.snapshot_id = snapshot.id
             JOIN source_retention_clock clock ON clock.singleton = 1
            WHERE read.id = ? AND read.project_id = ? AND read.session_id = ?
              AND read.source_ref = ? AND read.status = 'pending'
              AND ${AVAILABLE_LEGAL_SNAPSHOT_SQL}
              AND ${REMOTE_MODEL_USE_SQL}`,
        )
        .get(
          input.snapshotId,
          input.readId,
          owner.projectId,
          owner.researchSessionId,
          input.sourceRef,
        );
      if (!read) {
        rejected(
          "Legal research capture is outside its owned, available source read.",
        );
      }
      const anchors = this.database
        .prepare(
          `SELECT id FROM source_citation_anchors
            WHERE project_id = ? AND snapshot_id = ?
              AND id IN (${anchorIds.map(() => "?").join(",")})`,
        )
        .all(owner.projectId, input.snapshotId, ...anchorIds);
      if (anchors.length !== anchorIds.length) {
        rejected(
          "Legal research capture contains an anchor outside its snapshot.",
        );
      }
      const now = this.now();
      const insert = this.database.prepare(
        `INSERT INTO legal_research_read_anchors
           (read_id,project_id,snapshot_id,anchor_id,ordinal,created_at)
         VALUES (?,?,?,?,?,?)`,
      );
      anchorIds.forEach((anchorId, ordinal) =>
        insert.run(
          input.readId,
          owner.projectId,
          input.snapshotId,
          anchorId,
          ordinal,
          now,
        ),
      );
      this.database
        .prepare(
          `UPDATE legal_research_reads
              SET status = 'captured', snapshot_id = ?, captured_at = ?
            WHERE id = ?`,
        )
        .run(input.snapshotId, now, input.readId);
      return this.requireRead(owner, input.readId);
    });
  }

  private requireRead(
    owner: LegalResearchOwnerV22,
    readId: string,
  ): LegalResearchReadV22 {
    const row = this.database
      .prepare(
        `SELECT * FROM legal_research_reads
          WHERE id = ? AND project_id = ? AND session_id = ?`,
      )
      .get(readId, owner.projectId, owner.researchSessionId);
    if (!row)
      rejected("Legal research read was not persisted in this session.");
    const anchors = this.database
      .prepare(
        `SELECT anchor_id FROM legal_research_read_anchors
          WHERE read_id = ? ORDER BY ordinal, anchor_id`,
      )
      .all(readId)
      .map((item) => text(item.anchor_id, "read anchor id"));
    return LegalResearchReadV22Schema.parse({
      id: row.id,
      projectId: row.project_id,
      researchSessionId: row.session_id,
      sourceRef: row.source_ref,
      ordinal: Number(row.ordinal),
      status: row.status,
      snapshotId: row.snapshot_id,
      anchorIds: anchors,
      createdAt: row.created_at,
      capturedAt: row.captured_at,
    });
  }

  assistantEvidenceForCapturedRead(
    input: Readonly<{
      owner: LegalResearchOwnerV22;
      sourceRef: string;
      snapshotId: string;
      anchorIds: readonly string[];
    }>,
  ): readonly LegalResearchAuthorityEvidenceV22[] {
    const { owner } = this.assertOwnerInCurrentTransaction(input.owner);
    if (
      input.anchorIds.length < 1 ||
      new Set(input.anchorIds).size !== input.anchorIds.length
    ) {
      rejected("Legal authority evidence anchor identities are invalid.");
    }
    const rows = this.database
      .prepare(
        `SELECT read.id AS read_id,read.source_ref,snapshot.id AS snapshot_id,
                snapshot.title_snapshot,anchor.id AS anchor_id,anchor.exact_quote,
                anchor.quote_sha256,anchor.locator_json
           FROM legal_research_reads read
           JOIN project_source_snapshots snapshot
             ON snapshot.project_id = read.project_id
            AND snapshot.id = read.snapshot_id
           JOIN project_source_snapshot_lifecycle lifecycle
             ON lifecycle.project_id = snapshot.project_id
            AND lifecycle.snapshot_id = snapshot.id
           JOIN source_retention_clock clock ON clock.singleton = 1
           JOIN legal_research_read_anchors binding ON binding.read_id = read.id
           JOIN source_citation_anchors anchor
             ON anchor.id = binding.anchor_id
            AND anchor.project_id = binding.project_id
            AND anchor.snapshot_id = binding.snapshot_id
          WHERE read.project_id = ? AND read.session_id = ?
            AND read.source_ref = ? AND read.snapshot_id = ?
            AND read.status = 'captured'
            AND anchor.id IN (${input.anchorIds.map(() => "?").join(",")})
            AND ${AVAILABLE_LEGAL_SNAPSHOT_SQL}
            AND ${REMOTE_MODEL_USE_SQL}
          ORDER BY binding.ordinal, anchor.id`,
      )
      .all(
        owner.projectId,
        owner.researchSessionId,
        input.sourceRef,
        input.snapshotId,
        ...input.anchorIds,
      );
    if (rows.length !== input.anchorIds.length) {
      rejected(
        "Legal authority evidence is unavailable or outside this Assistant attempt.",
      );
    }
    return rows.map((row) => {
      const exactQuote = text(row.exact_quote, "legal authority quote");
      if (sha256(exactQuote) !== row.quote_sha256) {
        rejected(
          "Legal authority evidence quote failed its immutable hash check.",
        );
      }
      return LegalResearchAuthorityEvidenceV22Schema.parse({
        kind: "legal_authority",
        projectId: owner.projectId,
        jobId: owner.jobId,
        attempt: owner.attempt,
        readId: row.read_id,
        sourceRef: row.source_ref,
        snapshotId: row.snapshot_id,
        anchorId: row.anchor_id,
        title: row.title_snapshot,
        exactQuote,
        locator: jsonObject(row.locator_json, "legal authority locator"),
      });
    });
  }

  bindAssistantAuthoritySourcesInCurrentTransaction(
    input: Readonly<{
      owner: LegalResearchOwnerV22;
      messageId: string;
      sources: readonly AssistantLegalAuthoritySourceWriteV22[];
    }>,
  ): readonly AssistantLegalAuthoritySourceV22[] {
    const { owner, outputMessageId } = this.assertOwnerInCurrentTransaction(
      input.owner,
    );
    if (input.messageId !== outputMessageId) {
      rejected(
        "Legal authority citations may bind only the owned Assistant output message.",
      );
    }
    const sources = input.sources.map((source) =>
      AssistantLegalAuthoritySourceWriteV22Schema.parse(source),
    );
    if (
      new Set(sources.map((source) => source.id)).size !== sources.length ||
      new Set(sources.map((source) => source.citationOrdinal)).size !==
        sources.length
    ) {
      rejected("Legal authority message source identities are duplicated.");
    }
    const insert = this.database.prepare(
      `INSERT INTO assistant_legal_authority_message_sources
         (id,project_id,message_id,session_id,read_id,source_ref,snapshot_id,
          anchor_id,citation_ordinal,citation_metadata_json,created_at)
       SELECT ?,?,?,?,?,read.source_ref,read.snapshot_id,?,?,?,?
         FROM legal_research_reads read
         JOIN legal_research_read_anchors binding
           ON binding.read_id = read.id AND binding.anchor_id = ?
        WHERE read.id = ? AND read.project_id = ? AND read.session_id = ?
          AND read.status = 'captured'`,
    );
    const now = this.now();
    for (const source of sources) {
      const evidence = this.database
        .prepare(
          `SELECT read.source_ref,read.snapshot_id
             FROM legal_research_reads read
             JOIN legal_research_read_anchors binding
               ON binding.read_id = read.id AND binding.anchor_id = ?
             JOIN project_source_snapshots snapshot
               ON snapshot.project_id = read.project_id AND snapshot.id = read.snapshot_id
             JOIN project_source_snapshot_lifecycle lifecycle
               ON lifecycle.project_id = snapshot.project_id
              AND lifecycle.snapshot_id = snapshot.id
             JOIN source_retention_clock clock ON clock.singleton = 1
            WHERE read.id = ? AND read.project_id = ? AND read.session_id = ?
              AND read.status = 'captured' AND ${AVAILABLE_LEGAL_SNAPSHOT_SQL}
              AND ${REMOTE_MODEL_USE_SQL}`,
        )
        .get(
          source.anchorId,
          source.readId,
          owner.projectId,
          owner.researchSessionId,
        );
      if (!evidence) rejected("Legal authority message source is unavailable.");
      const result = insert.run(
        source.id,
        owner.projectId,
        input.messageId,
        owner.researchSessionId,
        source.readId,
        source.anchorId,
        source.citationOrdinal,
        JSON.stringify(source.citationMetadata),
        now,
        source.anchorId,
        source.readId,
        owner.projectId,
        owner.researchSessionId,
      );
      if (
        Number((result as { changes?: unknown } | undefined)?.changes ?? 0) !==
        1
      ) {
        rejected("Legal authority message source insert lost its read owner.");
      }
    }
    return this.listAssistantAuthoritySources(input.messageId);
  }

  bindAssistantAuthoritySources(
    input: Readonly<{
      owner: LegalResearchOwnerV22;
      messageId: string;
      sources: readonly AssistantLegalAuthoritySourceWriteV22[];
    }>,
  ): readonly AssistantLegalAuthoritySourceV22[] {
    return this.transaction(() =>
      this.bindAssistantAuthoritySourcesInCurrentTransaction(input),
    );
  }

  listAssistantAuthoritySources(
    messageId: string,
  ): readonly AssistantLegalAuthoritySourceV22[] {
    const total = integer(
      this.database
        .prepare(
          `SELECT count(*) AS count
             FROM assistant_legal_authority_message_sources WHERE message_id = ?`,
        )
        .get(messageId)?.count ?? 0,
      "legal authority message source count",
    );
    const rows = this.database
      .prepare(
        `SELECT source.*,candidate.source_type,snapshot.title_snapshot,
                anchor.exact_quote,anchor.quote_sha256,anchor.locator_json
           FROM assistant_legal_authority_message_sources source
           JOIN legal_research_candidates candidate
             ON candidate.project_id = source.project_id
            AND candidate.session_id = source.session_id
            AND candidate.source_ref = source.source_ref
           JOIN project_source_snapshots snapshot
             ON snapshot.project_id = source.project_id AND snapshot.id = source.snapshot_id
           JOIN project_source_snapshot_lifecycle lifecycle
             ON lifecycle.project_id = snapshot.project_id
            AND lifecycle.snapshot_id = snapshot.id
           JOIN source_retention_clock clock ON clock.singleton = 1
           JOIN source_citation_anchors anchor
             ON anchor.id = source.anchor_id
            AND anchor.project_id = source.project_id
            AND anchor.snapshot_id = source.snapshot_id
          WHERE source.message_id = ? AND ${AVAILABLE_LEGAL_SNAPSHOT_SQL}
          ORDER BY source.citation_ordinal, source.id`,
      )
      .all(messageId);
    if (rows.length !== total) {
      rejected(
        "One or more Assistant legal authority sources are unavailable under retention policy.",
      );
    }
    return rows.map((row) => {
      const exactQuote = text(row.exact_quote, "legal authority quote");
      if (sha256(exactQuote) !== row.quote_sha256) {
        rejected(
          "Legal authority message source quote failed its immutable hash check.",
        );
      }
      return AssistantLegalAuthoritySourceV22Schema.parse({
        id: row.id,
        messageId: row.message_id,
        projectId: row.project_id,
        readId: row.read_id,
        sourceRef: row.source_ref,
        snapshotId: row.snapshot_id,
        anchorId: row.anchor_id,
        title: row.title_snapshot,
        exactQuote,
        locator: jsonObject(row.locator_json, "legal authority locator"),
        sourceType: row.source_type,
        citationOrdinal: Number(row.citation_ordinal),
        citationMetadata: jsonObject(
          row.citation_metadata_json,
          "legal authority citation metadata",
        ),
        createdAt: row.created_at,
      });
    });
  }
}

/**
 * Structural bridge used by WorkspaceLegalResearchTools in a durable
 * Assistant attempt. Technical-PoC/transient calls are rejected so they can
 * never be mistaken for restart-safe ownership.
 */
export class WorkspaceLegalResearchOwnershipAdapterV22 implements LegalResearchSessionOwnershipPort {
  constructor(private readonly repository: WorkspaceLegalResearchRepository) {}

  private owner(context: LegalResearchToolContext): LegalResearchOwnerV22 {
    return LegalResearchOwnerV22Schema.parse({
      projectId: context.projectId,
      jobId: context.jobId,
      attempt: context.attempt,
      leaseOwner: context.leaseOwner,
      researchSessionId: context.researchSessionId,
    });
  }

  async recordSearch(input: {
    context: LegalResearchToolContext;
    providerId: string;
    queryId: string;
    results: readonly LegalProviderSearchItem[];
    transient: boolean;
  }): Promise<readonly OwnedLegalSourceReference[]> {
    if (input.transient) {
      rejected("Transient legal research cannot use durable v22 ownership.");
    }
    return this.repository
      .recordSearch({
        owner: this.owner(input.context),
        providerId: input.providerId,
        providerQueryId: input.queryId,
        results: input.results,
      })
      .map((candidate) => ({
        sourceRef: candidate.sourceRef,
        providerId: candidate.providerId,
        providerSourceId: candidate.providerSourceId,
        queryId: candidate.providerQueryId,
        durable: true,
      }));
  }

  async resolveOwnedSource(input: {
    context: LegalResearchToolContext;
    sourceRef: string;
  }): Promise<OwnedLegalSourceReference | null> {
    try {
      const candidate = this.repository.resolveOwnedSource({
        owner: this.owner(input.context),
        sourceRef: input.sourceRef,
      });
      return {
        sourceRef: candidate.sourceRef,
        providerId: candidate.providerId,
        providerSourceId: candidate.providerSourceId,
        queryId: candidate.providerQueryId,
        durable: true,
        readId: candidate.readId,
      };
    } catch (error) {
      if (
        error instanceof WorkspaceLegalResearchRepositoryError &&
        /not owned/i.test(error.message)
      ) {
        return null;
      }
      throw error;
    }
  }

  bindReadCaptureForContext(
    input: Readonly<{
      context: LegalResearchToolContext;
      readId: string;
      sourceRef: string;
      snapshotId: string;
      anchorIds: readonly string[];
    }>,
  ): LegalResearchReadV22 {
    return this.repository.bindReadCapture({
      owner: this.owner(input.context),
      readId: input.readId,
      sourceRef: input.sourceRef,
      snapshotId: input.snapshotId,
      anchorIds: input.anchorIds,
    });
  }
}

/** Commits the source-capture result into the pending durable read atomically. */
export class WorkspaceLegalResearchSourceCaptureAdapterV22 implements LegalResearchSourceCapturePort {
  constructor(
    private readonly delegate: LegalResearchSourceCapturePort,
    private readonly ownership: WorkspaceLegalResearchOwnershipAdapterV22,
  ) {}

  async capture(
    input: Parameters<LegalResearchSourceCapturePort["capture"]>[0],
  ): ReturnType<LegalResearchSourceCapturePort["capture"]> {
    const captured = await this.delegate.capture(input);
    this.ownership.bindReadCaptureForContext({
      context: input.context,
      readId: input.readId,
      sourceRef: input.sourceRef,
      snapshotId: captured.snapshotId,
      anchorIds: captured.excerpts.map((excerpt) => excerpt.anchorCandidateId),
    });
    return captured;
  }
}
