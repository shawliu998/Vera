import { createHash, randomUUID } from "node:crypto";
import type { AletheiaUserContext } from "./repository";
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
  LitigationTaskStatusFilter,
  ReviewLitigationDocumentDraftVersionInput,
  ResolvePositionReviewInput,
  UpdateLitigationProfileInput,
  WithdrawLitigationDocumentDraftInput,
} from "./litigationDomain";
import {
  DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
  DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
  resolveLitigationDocumentTemplate,
} from "./litigationDocumentTemplates";
import { LocalDatabase } from "./localDatabase";

function now() {
  return new Date().toISOString();
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

const DOCUMENT_DRAFT_MACHINE_FIELDS = new Set([
  "metadata",
  "schemaversion",
  "chunkindex",
  "quotestart",
  "quoteend",
  "documentquotestart",
  "documentquoteend",
  "sequence",
  "createdat",
  "updatedat",
  "generatedat",
  "decidedat",
  "reviewedat",
  "verifiedat",
  "withdrawnat",
  "createdby",
  "decidedby",
  "reviewedby",
  "verifiedby",
]);

function normalizedFieldName(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isDocumentDraftMachineField(key: string) {
  const normalized = normalizedFieldName(key);
  return (
    DOCUMENT_DRAFT_MACHINE_FIELDS.has(normalized) ||
    normalized.includes("sha256") ||
    normalized.includes("hash") ||
    key === "id" ||
    /_id$/i.test(key) ||
    /Id$/.test(key)
  );
}

function readableFieldLabel(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Detail";
}

function readableScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim();
    return text || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

function renderLawyerReadableLines(value: unknown, depth = 0): string[] {
  const indentation = "  ".repeat(depth);
  const scalar = readableScalar(value);
  if (scalar !== null) {
    return scalar.split("\n").map((line) => `${indentation}${line}`);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indentation}No content available.`];
    return value.flatMap((item) => {
      const childIndentation = "  ".repeat(depth + 1);
      const lines = renderLawyerReadableLines(item, depth + 1);
      const first = lines[0]?.startsWith(childIndentation)
        ? lines[0].slice(childIndentation.length)
        : lines[0] ?? "No displayable content.";
      return [`${indentation}- ${first}`, ...lines.slice(1)];
    });
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).filter(
      (key) => !isDocumentDraftMachineField(key),
    );
    const primaryKey = ["title", "statement", "name"]
      .map((candidate) =>
        keys.find((key) => normalizedFieldName(key) === candidate),
      )
      .find((key): key is string => Boolean(key && readableScalar(source[key])));
    const lines: string[] = [];
    if (primaryKey) {
      lines.push(...renderLawyerReadableLines(source[primaryKey], depth));
    }
    for (const key of keys
      .filter((candidate) => candidate !== primaryKey)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
      const item = source[key];
      const itemScalar = readableScalar(item);
      const label = readableFieldLabel(key);
      if (itemScalar !== null && !itemScalar.includes("\n")) {
        lines.push(`${indentation}${label}: ${itemScalar}`);
        continue;
      }
      if (
        itemScalar === null &&
        (item === null || item === undefined ||
          (Array.isArray(item) && item.length === 0))
      ) {
        continue;
      }
      lines.push(`${indentation}${label}:`);
      lines.push(...renderLawyerReadableLines(item, depth + 1));
    }
    return lines.length ? lines : [`${indentation}No displayable content.`];
  }
  return [`${indentation}No content available.`];
}

function renderLawyerReadablePlainText(value: unknown) {
  const text = renderLawyerReadableLines(value).join("\n").trim();
  if (text.length > 50_000) {
    throw new LitigationValidationError(
      "Artifact section exceeds the document draft limit and cannot be rendered without losing legal content.",
    );
  }
  return text || "No content available.";
}

function sha256Json(value: unknown) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function parseJson(value: unknown) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function record(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const result = { ...row };
  for (const key of [
    "metadata",
    "decision_payload",
    "source_snapshot",
  ] as const) {
    if (key in result) result[key] = parseJson(result[key]);
  }
  return result;
}

function deriveElementEvidenceStatus(
  elementId: string,
  links: Array<Record<string, any>>,
  facts: Array<Record<string, any>>,
  citedFactIds: Set<string>,
) {
  const factById = new Map(facts.map((fact) => [String(fact.id), fact]));
  const relevant = links.filter((link) => link.element_id === elementId);
  let confirmedSupports = 0;
  let confirmedContradictions = 0;
  let pendingLinks = 0;
  let rejectedLinks = 0;
  let uncitedConfirmedLinks = 0;
  for (const link of relevant) {
    const fact = factById.get(String(link.fact_id));
    if (!fact || fact.status === "rejected") {
      rejectedLinks += 1;
      continue;
    }
    if (fact.status !== "confirmed") {
      pendingLinks += 1;
      continue;
    }
    if (!citedFactIds.has(String(fact.id))) {
      uncitedConfirmedLinks += 1;
      continue;
    }
    if (link.relation === "supports") confirmedSupports += 1;
    if (link.relation === "contradicts") confirmedContradictions += 1;
  }
  const status =
    confirmedSupports > 0 && confirmedContradictions > 0
      ? "contested"
      : confirmedSupports > 0
        ? "supported"
        : confirmedContradictions > 0
          ? "contradicted"
          : uncitedConfirmedLinks > 0
            ? "needs_source"
            : pendingLinks > 0
              ? "pending_review"
              : "gap";
  return {
    element_id: elementId,
    status,
    total_links: relevant.length,
    confirmed_supports: confirmedSupports,
    confirmed_contradictions: confirmedContradictions,
    pending_links: pendingLinks,
    rejected_links: rejectedLinks,
    uncited_confirmed_links: uncitedConfirmedLinks,
  };
}

export class LitigationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LitigationValidationError";
  }
}

export const LOW_CONFIDENCE_OCR_THRESHOLD = 0.7;

export const litigationSchema = `
create table if not exists aletheia_source_spans (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  document_id text not null references aletheia_matter_documents(id) on delete cascade,
  source_chunk_id text not null references aletheia_document_chunks(id) on delete cascade,
  document_name text not null,
  page integer,
  section text,
  chunk_quote_start integer not null,
  chunk_quote_end integer not null,
  document_quote_start integer not null,
  document_quote_end integer not null,
  quote text not null,
  source_chunk_sha256 text not null,
  quote_sha256 text not null,
  created_by text not null,
  metadata text not null default '{}',
  created_at text not null
);

create index if not exists idx_source_spans_matter_document
  on aletheia_source_spans(matter_id, document_id);

create table if not exists aletheia_source_span_verifications (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  source_span_id text not null references aletheia_source_spans(id) on delete cascade,
  verification_type text not null check (verification_type = 'original_scan_compared'),
  source_chunk_sha256 text not null,
  quote_sha256 text not null,
  reason text not null,
  verified_by text not null,
  verified_at text not null
);

create index if not exists idx_source_span_verifications_current
  on aletheia_source_span_verifications(
    matter_id, user_id, source_span_id, source_chunk_sha256, quote_sha256,
    verified_at desc
  );

create table if not exists aletheia_source_span_verification_withdrawals (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  verification_id text not null unique references aletheia_source_span_verifications(id) on delete cascade,
  source_span_id text not null references aletheia_source_spans(id) on delete cascade,
  source_chunk_sha256 text not null,
  quote_sha256 text not null,
  reason text not null,
  withdrawn_by text not null,
  withdrawn_at text not null
);

create index if not exists idx_source_span_verification_withdrawals_current
  on aletheia_source_span_verification_withdrawals(
    matter_id, user_id, source_span_id, source_chunk_sha256, quote_sha256,
    verification_id
  );

create trigger if not exists aletheia_source_span_verifications_immutable_update
  before update on aletheia_source_span_verifications begin
    select raise(abort, 'source span verifications are immutable');
  end;

drop trigger if exists aletheia_source_span_verifications_immutable_delete;

create trigger aletheia_source_span_verifications_immutable_delete
  before delete on aletheia_source_span_verifications
  when exists (
    select 1 from aletheia_matters where id = old.matter_id
  ) begin
    select raise(abort, 'source span verifications are immutable');
  end;

create trigger if not exists aletheia_source_span_verification_withdrawals_immutable_update
  before update on aletheia_source_span_verification_withdrawals begin
    select raise(abort, 'source span verification withdrawals are immutable');
  end;

drop trigger if exists aletheia_source_span_verification_withdrawals_immutable_delete;

create trigger aletheia_source_span_verification_withdrawals_immutable_delete
  before delete on aletheia_source_span_verification_withdrawals
  when exists (
    select 1 from aletheia_matters where id = old.matter_id
  ) begin
    select raise(abort, 'source span verification withdrawals are immutable');
  end;

create table if not exists aletheia_litigation_profiles (
  matter_id text primary key references aletheia_matters(id) on delete cascade,
  user_id text not null,
  case_number text,
  court text,
  cause_of_action text,
  procedure_stage text,
  represented_side text,
  organization_name text,
  exhibit_prefix text not null default 'EX',
  exhibit_start integer not null default 1,
  pagination_policy text not null default 'auto',
  document_template_id text not null default 'cn-litigation-working-paper',
  document_template_version integer not null default 1,
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

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

create table if not exists aletheia_litigation_facts (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  statement text not null,
  occurred_at text,
  date_precision text not null default 'unknown',
  helpfulness text not null default 'unknown',
  confidence text,
  status text not null default 'proposed',
  created_by text not null,
  decision_comment text,
  decided_by text,
  decided_at text,
  event_version integer not null default 1,
  supersedes_event_id text,
  superseded_by_event_id text,
  superseded_at text,
  correction_reason text,
  event_lineage_hash text not null default '',
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists aletheia_litigation_procedural_event_corrections (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  original_event_id text not null references aletheia_litigation_procedural_events(id) on delete restrict,
  replacement_event_id text not null references aletheia_litigation_procedural_events(id) on delete restrict,
  from_occurred_at text not null,
  to_occurred_at text not null,
  reason text not null,
  correction_hash text not null,
  corrected_by text not null,
  corrected_at text not null,
  unique(original_event_id),
  unique(replacement_event_id)
);

create trigger if not exists aletheia_procedural_event_corrections_immutable_update
  before update on aletheia_litigation_procedural_event_corrections begin
    select raise(abort, 'procedural event corrections are immutable');
  end;

create trigger if not exists aletheia_procedural_event_corrections_immutable_delete
  before delete on aletheia_litigation_procedural_event_corrections begin
    select raise(abort, 'procedural event corrections are immutable');
  end;

create index if not exists idx_litigation_facts_matter_status
  on aletheia_litigation_facts(matter_id, status, occurred_at);

create table if not exists aletheia_litigation_fact_sources (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  fact_id text not null references aletheia_litigation_facts(id) on delete cascade,
  source_span_id text not null references aletheia_source_spans(id) on delete cascade,
  relation text not null,
  created_at text not null
);

create unique index if not exists idx_litigation_fact_source_unique
  on aletheia_litigation_fact_sources(fact_id, source_span_id, relation);

create table if not exists aletheia_litigation_claims (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  kind text not null,
  parent_claim_id text references aletheia_litigation_claims(id) on delete set null,
  title text not null,
  legal_basis text,
  confidence text,
  uncertainty text,
  burden_party_id text,
  status text not null default 'proposed',
  created_by text not null,
  decision_comment text,
  decided_by text,
  decided_at text,
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_litigation_claims_matter_kind
  on aletheia_litigation_claims(matter_id, kind, status);

create table if not exists aletheia_litigation_claim_sources (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  claim_id text not null references aletheia_litigation_claims(id) on delete cascade,
  source_span_id text not null references aletheia_source_spans(id) on delete cascade,
  relation text not null check (relation in ('authority', 'supports', 'contradicts')),
  created_at text not null
);

create unique index if not exists idx_litigation_claim_source_unique
  on aletheia_litigation_claim_sources(claim_id, source_span_id, relation);

create table if not exists aletheia_position_reviews (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  claim_id text not null references aletheia_litigation_claims(id) on delete cascade,
  assessment_id text references aletheia_legal_assessments(id) on delete restrict,
  result_assessment_id text references aletheia_legal_assessments(id) on delete restrict,
  parent_review_id text references aletheia_position_reviews(id) on delete restrict,
  review_level integer not null default 1 check (review_level in (1, 2)),
  independent_review integer not null default 0 check (independent_review in (0, 1)),
  kind text not null check (kind in ('objection', 'reconsideration', 'withdrawal')),
  reason text not null,
  requested_outcome text not null check (requested_outcome in ('confirmed', 'rejected', 'withdrawn')),
  status text not null default 'open' check (status in ('open', 'resolved', 'withdrawn')),
  resolution text check (resolution in ('upheld', 'granted', 'dismissed') or resolution is null),
  resolution_comment text,
  resolved_by text,
  resolved_at text,
  created_by text not null,
  created_at text not null,
  updated_at text not null
);

create unique index if not exists idx_position_reviews_one_open_per_claim
  on aletheia_position_reviews(claim_id) where status = 'open';

create index if not exists idx_position_reviews_matter_status
  on aletheia_position_reviews(matter_id, user_id, status, created_at);

create table if not exists aletheia_legal_assessments (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  claim_id text not null references aletheia_litigation_claims(id) on delete cascade,
  version integer not null check (version > 0),
  status text not null check (status in ('confirmed', 'rejected', 'withdrawn')),
  legal_basis text,
  confidence text check (confidence in ('low', 'medium', 'high') or confidence is null),
  uncertainty text,
  decision_comment text,
  source_snapshot text not null default '[]',
  payload_sha256 text not null,
  source_review_id text references aletheia_position_reviews(id) on delete set null,
  supersedes_id text references aletheia_legal_assessments(id) on delete restrict,
  created_by text not null,
  created_at text not null,
  unique (claim_id, version)
);

create index if not exists idx_legal_assessments_matter_claim
  on aletheia_legal_assessments(matter_id, user_id, claim_id, version);

create table if not exists aletheia_litigation_claim_elements (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  claim_id text not null references aletheia_litigation_claims(id) on delete cascade,
  title text not null,
  description text,
  sequence integer not null default 0,
  status text not null default 'proposed',
  created_by text not null default 'human',
  decision_comment text,
  decided_by text,
  decided_at text,
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists aletheia_litigation_element_facts (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  element_id text not null references aletheia_litigation_claim_elements(id) on delete cascade,
  fact_id text not null references aletheia_litigation_facts(id) on delete cascade,
  relation text not null,
  note text,
  created_at text not null
);

create unique index if not exists idx_litigation_element_fact_unique
  on aletheia_litigation_element_facts(element_id, fact_id, relation);

create table if not exists aletheia_litigation_procedural_events (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  event_type text not null,
  title text not null,
  occurred_at text,
  primary_source_span_id text references aletheia_source_spans(id) on delete set null,
  status text not null default 'proposed',
  created_by text not null,
  decision_comment text,
  decided_by text,
  decided_at text,
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists aletheia_litigation_deadlines (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  triggering_event_id text references aletheia_litigation_procedural_events(id) on delete set null,
  primary_source_span_id text references aletheia_source_spans(id) on delete set null,
  title text not null,
  due_at text not null,
  rule_label text not null,
  rule_version text not null,
  calculation text not null,
  calculation_hash text,
  court_calendar_version_id text references aletheia_litigation_court_calendar_versions(id) on delete restrict,
  court_calendar_hash text,
  stale_at text,
  stale_reason text,
  status text not null default 'proposed',
  created_by text not null,
  decision_comment text,
  decided_by text,
  decided_at text,
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_litigation_deadlines_matter_due
  on aletheia_litigation_deadlines(matter_id, status, due_at);

create table if not exists aletheia_litigation_court_calendars (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  jurisdiction text not null,
  court_identifier text not null,
  name text not null,
  timezone text not null,
  created_by text not null,
  created_at text not null,
  unique(matter_id, user_id, jurisdiction, court_identifier)
);

create table if not exists aletheia_litigation_court_calendar_versions (
  id text primary key,
  calendar_id text not null references aletheia_litigation_court_calendars(id) on delete cascade,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  version integer not null,
  version_label text not null,
  supersedes_version_id text references aletheia_litigation_court_calendar_versions(id) on delete restrict,
  effective_from text not null,
  effective_to text not null,
  weekly_non_working_days text not null,
  source_authority_version_id text not null references aletheia_litigation_legal_authority_versions(id) on delete restrict,
  source_content_sha256 text not null,
  calendar_hash text not null,
  status text not null check(status in ('draft', 'verified', 'retired')),
  verification_comment text,
  verified_by text,
  verified_at text,
  retirement_comment text,
  retired_by text,
  retired_at text,
  created_by text not null,
  created_at text not null,
  unique(calendar_id, version)
);

create index if not exists idx_litigation_court_calendar_versions_scope
  on aletheia_litigation_court_calendar_versions(matter_id, user_id, status, effective_from, effective_to);

create table if not exists aletheia_litigation_court_calendar_day_overrides (
  id text primary key,
  calendar_version_id text not null references aletheia_litigation_court_calendar_versions(id) on delete cascade,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  local_date text not null,
  disposition text not null check(disposition in ('open', 'closed')),
  source_reference text not null,
  created_at text not null,
  unique(calendar_version_id, local_date)
);

create trigger if not exists aletheia_court_calendar_version_immutable_update
  before update of calendar_id, matter_id, user_id, version, version_label,
    supersedes_version_id, effective_from, effective_to,
    weekly_non_working_days, source_authority_version_id,
    source_content_sha256, calendar_hash, created_by, created_at
  on aletheia_litigation_court_calendar_versions
  when old.status in ('verified', 'retired') begin
    select raise(abort, 'verified court calendar versions are immutable');
  end;

create trigger if not exists aletheia_court_calendar_version_immutable_delete
  before delete on aletheia_litigation_court_calendar_versions
  when old.status in ('verified', 'retired') begin
    select raise(abort, 'verified court calendar versions are immutable');
  end;

create trigger if not exists aletheia_court_calendar_override_locked_insert
  before insert on aletheia_litigation_court_calendar_day_overrides
  when (select status from aletheia_litigation_court_calendar_versions where id = new.calendar_version_id) <> 'draft' begin
    select raise(abort, 'verified court calendar overrides are immutable');
  end;

create trigger if not exists aletheia_court_calendar_override_locked_update
  before update on aletheia_litigation_court_calendar_day_overrides
  when (select status from aletheia_litigation_court_calendar_versions where id = old.calendar_version_id) <> 'draft' begin
    select raise(abort, 'verified court calendar overrides are immutable');
  end;

create trigger if not exists aletheia_court_calendar_override_locked_delete
  before delete on aletheia_litigation_court_calendar_day_overrides
  when (select status from aletheia_litigation_court_calendar_versions where id = old.calendar_version_id) <> 'draft' begin
    select raise(abort, 'verified court calendar overrides are immutable');
  end;

create table if not exists aletheia_litigation_deadline_rules (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  name text not null,
  jurisdiction text not null,
  trigger_event_type text not null,
  authority_version_id text not null references aletheia_litigation_legal_authority_versions(id),
  provision_reference text not null,
  exact_quote text not null,
  quote_sha256 text not null,
  offset_days integer not null check(offset_days between 0 and 3650),
  counting_basis text not null check(counting_basis in ('calendar_days', 'business_days')),
  court_calendar_version_id text references aletheia_litigation_court_calendar_versions(id) on delete restrict,
  court_calendar_hash text,
  start_policy text not null check(start_policy in ('same_day', 'next_day')),
  timezone text not null,
  rule_hash text not null,
  status text not null check(status in ('draft', 'verified', 'retired')),
  verification_comment text,
  verified_by text,
  verified_at text,
  retired_by text,
  retired_at text,
  retirement_comment text,
  created_by text not null,
  created_at text not null,
  unique(matter_id, user_id, name)
);

create index if not exists idx_litigation_deadline_rules_matter
  on aletheia_litigation_deadline_rules(matter_id, user_id, status, trigger_event_type);

create table if not exists aletheia_tasks (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  source_deadline_id text not null references aletheia_litigation_deadlines(id) on delete cascade,
  title text not null,
  due_at text not null,
  status text not null default 'open' check (status in ('open', 'completed')),
  priority text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  note text,
  completed_at text,
  invalidated_at text,
  invalidated_reason text,
  created_at text not null,
  updated_at text not null,
  unique(user_id, source_deadline_id)
);

create index if not exists idx_tasks_user_status_due
  on aletheia_tasks(user_id, status, due_at);

create index if not exists idx_tasks_matter_due
  on aletheia_tasks(matter_id, due_at);

create table if not exists aletheia_task_notification_deliveries (
  id text primary key,
  task_id text not null references aletheia_tasks(id) on delete cascade,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  category text not null check(category in ('due_soon', 'overdue')),
  local_date text not null,
  due_at_snapshot text not null,
  tag text not null,
  status text not null check(status in ('claimed', 'delivered', 'failed', 'withdrawn')),
  lease_token text,
  attempt_count integer not null default 1,
  failure_code text,
  claimed_at text not null,
  delivered_at text,
  withdrawn_at text,
  updated_at text not null,
  unique(user_id, task_id, category, local_date)
);

create index if not exists idx_task_notification_delivery_status
  on aletheia_task_notification_deliveries(user_id, status, updated_at);

create table if not exists aletheia_litigation_eval_runs (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  suite_version text not null,
  status text not null,
  passed integer not null,
  total integer not null,
  result_hash text not null,
  created_at text not null
);

create table if not exists aletheia_litigation_eval_results (
  id text primary key,
  run_id text not null references aletheia_litigation_eval_runs(id) on delete cascade,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  case_id text not null,
  case_type text not null,
  expected text not null,
  actual text not null,
  passed integer not null,
  grader_id text not null,
  grader_version text not null,
  evidence_refs text not null default '[]',
  created_at text not null
);

create index if not exists idx_litigation_eval_runs_matter_created
  on aletheia_litigation_eval_runs(matter_id, created_at desc);

create table if not exists aletheia_litigation_retrieval_manifests (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  focus text not null,
  mode text not null check (mode in ('keyword')),
  index_fingerprint text not null,
  candidate_count integer not null,
  manifest_hash text not null,
  content text not null,
  status text not null default 'open' check (status in ('open', 'used', 'invalidated')),
  created_by text not null,
  created_at text not null
);

create index if not exists idx_litigation_retrieval_manifests_matter_created
  on aletheia_litigation_retrieval_manifests(matter_id, user_id, created_at desc);

create table if not exists aletheia_litigation_retrieval_excerpts (
  id text primary key,
  manifest_id text not null references aletheia_litigation_retrieval_manifests(id) on delete cascade,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  chunk_id text not null references aletheia_document_chunks(id) on delete cascade,
  document_id text not null,
  document_name text not null,
  rank integer not null,
  quote_start integer not null,
  quote_end integer not null,
  quote text not null,
  quote_sha256 text not null,
  chunk_text_sha256 text not null,
  status text not null check (status in ('confirmed', 'withdrawn')),
  decision_comment text not null,
  confirmed_by text not null,
  confirmed_at text not null,
  withdrawn_by text,
  withdrawn_at text,
  withdrawal_comment text,
  unique(manifest_id, chunk_id)
);

create index if not exists idx_litigation_retrieval_excerpts_manifest
  on aletheia_litigation_retrieval_excerpts(manifest_id, status, rank);

create table if not exists aletheia_litigation_legal_authority_versions (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  jurisdiction text not null,
  authority_type text not null check(authority_type in ('statute', 'regulation', 'judicial_interpretation', 'guiding_case', 'other')),
  title text not null,
  issuer text not null,
  official_identifier text not null,
  version_label text not null,
  source_reference text not null,
  content text not null,
  content_sha256 text not null,
  effective_from text not null,
  effective_to text,
  status text not null check(status in ('draft', 'verified', 'retired')),
  verification_comment text,
  verified_by text,
  verified_at text,
  retired_by text,
  retired_at text,
  retirement_comment text,
  created_by text not null,
  created_at text not null,
  unique(matter_id, user_id, official_identifier, version_label)
);

create index if not exists idx_litigation_legal_authority_versions
  on aletheia_litigation_legal_authority_versions(matter_id, user_id, official_identifier, effective_from);

create table if not exists aletheia_litigation_position_authorities (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  claim_id text not null references aletheia_litigation_claims(id) on delete cascade,
  authority_version_id text not null references aletheia_litigation_legal_authority_versions(id),
  applicability_date text not null,
  provision_reference text not null,
  exact_quote text not null,
  quote_sha256 text not null,
  rationale text not null,
  status text not null check(status in ('active', 'withdrawn')),
  created_by text not null,
  created_at text not null,
  withdrawn_by text,
  withdrawn_at text,
  withdrawal_comment text,
  unique(claim_id, authority_version_id, provision_reference, quote_sha256)
);

create index if not exists idx_litigation_position_authorities_claim
  on aletheia_litigation_position_authorities(matter_id, user_id, claim_id, status);

create table if not exists aletheia_litigation_agent_output_reviews (
  id text primary key,
  run_id text not null references aletheia_agent_runs(id) on delete cascade,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  output_hash text not null,
  snapshot_hash text not null,
  status text not null default 'open' check (status in ('open', 'approved', 'rejected')),
  requested_by text not null,
  decision_comment text,
  decided_by text,
  independent_review integer not null default 0,
  decided_at text,
  created_at text not null,
  unique(run_id)
);

create index if not exists idx_agent_output_reviews_matter_created
  on aletheia_litigation_agent_output_reviews(matter_id, created_at desc);

create table if not exists aletheia_litigation_agent_finding_reviews (
  id text primary key,
  run_id text not null references aletheia_agent_runs(id) on delete cascade,
  step_id text not null references aletheia_agent_steps(id) on delete cascade,
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

create table if not exists aletheia_litigation_agent_finding_semantic_checks (
  id text primary key,
  run_id text not null references aletheia_agent_runs(id) on delete cascade,
  step_id text not null references aletheia_agent_steps(id) on delete cascade,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  finding_index integer not null,
  version integer not null,
  finding_hash text not null,
  citation_set_hash text not null,
  snapshot_hash text not null,
  output_review_hash text not null,
  model_id text not null,
  model_revision text not null,
  model_fingerprint text not null,
  calibration_fingerprint text not null,
  benchmark_fingerprint text not null,
  calibration_id text not null,
  benchmark_id text not null,
  protocol_version text not null,
  prompt_sha256 text not null,
  output_sha256 text,
  citation_assessments text,
  derived_verdict text check(derived_verdict in ('supported', 'partial', 'unsupported')),
  overall_rationale text,
  uncertainty text,
  status text not null check(status in ('succeeded', 'failed')),
  failure_code text,
  failure_detail text,
  duration_ms integer not null,
  supersedes_id text references aletheia_litigation_agent_finding_semantic_checks(id),
  actor_id text not null,
  created_at text not null,
  unique(run_id, step_id, finding_index, version)
);

create index if not exists idx_agent_finding_semantic_checks_scope
  on aletheia_litigation_agent_finding_semantic_checks(matter_id, user_id, run_id, step_id, finding_index, version desc);

create trigger if not exists aletheia_agent_finding_semantic_checks_immutable_update
  before update on aletheia_litigation_agent_finding_semantic_checks begin
    select raise(abort, 'finding semantic checks are immutable');
  end;

create trigger if not exists aletheia_agent_finding_semantic_checks_immutable_delete
  before delete on aletheia_litigation_agent_finding_semantic_checks begin
    select raise(abort, 'finding semantic checks are immutable');
  end;

create table if not exists aletheia_litigation_document_drafts (
  id text primary key,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  artifact_id text not null references aletheia_work_products(id) on delete restrict,
  artifact_kind text not null check (artifact_kind in ('litigation_brief', 'hearing_plan')),
  source_content_hash text not null,
  source_dependency_hash text not null,
  current_version_id text,
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_by text,
  withdrawn_at text,
  withdrawal_reason text,
  created_by text not null,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_litigation_document_drafts_scope
  on aletheia_litigation_document_drafts(matter_id, user_id, status, updated_at desc);

create table if not exists aletheia_litigation_document_draft_versions (
  id text primary key,
  document_id text not null references aletheia_litigation_document_drafts(id) on delete restrict,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  version integer not null,
  parent_version_id text,
  parent_content_hash text,
  content_hash text not null,
  sections text not null,
  change_summary text not null,
  provenance text not null,
  created_by text not null,
  created_at text not null,
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed', 'approved', 'rejected')),
  review_reason text,
  reviewed_by text,
  reviewed_at text,
  unique(document_id, version)
);

create unique index if not exists idx_litigation_document_draft_versions_id_scope
  on aletheia_litigation_document_draft_versions(id, document_id, matter_id, user_id);

create table if not exists aletheia_litigation_document_draft_import_attempts (
  id text primary key,
  document_id text not null references aletheia_litigation_document_drafts(id) on delete restrict,
  matter_id text not null references aletheia_matters(id) on delete cascade,
  user_id text not null,
  base_version_id text,
  base_version integer,
  base_content_hash text,
  original_filename text not null,
  file_sha256 text not null,
  file_bytes integer not null,
  parser_protocol text not null,
  binding_hash text,
  status text not null check (status in ('accepted', 'rejected')),
  failure_code text,
  failure_detail text,
  accepted_version_id text references aletheia_litigation_document_draft_versions(id) on delete restrict,
  storage_path text,
  actor_id text not null,
  created_at text not null
);

create index if not exists idx_litigation_document_draft_import_attempts_scope
  on aletheia_litigation_document_draft_import_attempts(document_id, matter_id, user_id, created_at desc);

create trigger if not exists aletheia_document_draft_import_attempts_immutable_update
  before update on aletheia_litigation_document_draft_import_attempts begin
    select raise(abort, 'document draft import attempts are immutable');
  end;

create trigger if not exists aletheia_document_draft_import_attempts_immutable_delete
  before delete on aletheia_litigation_document_draft_import_attempts begin
    select raise(abort, 'document draft import attempts are immutable');
  end;
`;

export function initializeLitigationSchema(db: LocalDatabase) {
  db.exec(litigationSchema);
  const ensureColumns = (
    table: string,
    definitions: ReadonlyArray<readonly [string, string]>,
  ) => {
    const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
      name?: string;
    }>;
    for (const [column, definition] of definitions) {
      if (!columns.some((item) => item.name === column)) {
        db.exec(`alter table ${table} add column ${column} ${definition}`);
      }
    }
  };
  ensureColumns("aletheia_document_chunks", [
    ["metadata", "text not null default '{}'"],
  ]);
  ensureColumns("aletheia_litigation_procedural_events", [
    ["decision_comment", "text"],
    ["decided_by", "text"],
    ["decided_at", "text"],
    ["event_version", "integer not null default 1"],
    ["supersedes_event_id", "text"],
    ["superseded_by_event_id", "text"],
    ["superseded_at", "text"],
    ["correction_reason", "text"],
    ["event_lineage_hash", "text not null default ''"],
  ]);
  ensureColumns("aletheia_litigation_deadline_rules", [
    ["court_calendar_version_id", "text"],
    ["court_calendar_hash", "text"],
  ]);
  ensureColumns("aletheia_litigation_deadlines", [
    ["court_calendar_version_id", "text"],
    ["court_calendar_hash", "text"],
  ]);
  ensureColumns("aletheia_litigation_agent_finding_semantic_checks", [
    ["calibration_fingerprint", "text not null default ''"],
    ["benchmark_fingerprint", "text not null default ''"],
  ]);
  ensureColumns("aletheia_litigation_claim_elements", [
    ["status", "text not null default 'proposed'"],
    ["created_by", "text not null default 'human'"],
    ["decision_comment", "text"],
    ["decided_by", "text"],
    ["decided_at", "text"],
  ]);
  ensureColumns("aletheia_litigation_claims", [
    ["confidence", "text"],
    ["uncertainty", "text"],
    ["current_assessment_id", "text"],
  ]);
  ensureColumns("aletheia_litigation_profiles", [
    ["organization_name", "text"],
    ["exhibit_prefix", "text not null default 'EX'"],
    ["exhibit_start", "integer not null default 1"],
    ["pagination_policy", "text not null default 'auto'"],
    [
      "document_template_id",
      "text not null default 'cn-litigation-working-paper'",
    ],
    ["document_template_version", "integer not null default 1"],
  ]);
  ensureColumns("aletheia_litigation_custom_templates", [
    ["independent_approval", "integer not null default 0"],
    ["retirement_checkpoint_id", "text"],
    ["retired_by", "text"],
    ["retired_at", "text"],
  ]);
  ensureColumns("aletheia_position_reviews", [
    ["assessment_id", "text"],
    ["result_assessment_id", "text"],
    ["parent_review_id", "text"],
    ["review_level", "integer not null default 1"],
    ["independent_review", "integer not null default 0"],
  ]);
  db.exec(
    `create unique index if not exists idx_position_reviews_one_child
       on aletheia_position_reviews(parent_review_id)
       where parent_review_id is not null`,
  );
  const decidedClaims = db
    .prepare(
      `select c.* from aletheia_litigation_claims c
        where c.status in ('confirmed', 'rejected', 'withdrawn')
          and not exists (
            select 1 from aletheia_legal_assessments a where a.claim_id = c.id
          )`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const claim of decidedClaims) {
    const sources = db
      .prepare(
        `select cs.id, cs.relation, s.id as source_span_id,
                s.document_id, s.document_name, s.page, s.section,
                s.quote, s.source_chunk_sha256, s.quote_sha256
           from aletheia_litigation_claim_sources cs
           join aletheia_source_spans s on s.id = cs.source_span_id
          where cs.claim_id = ? and cs.matter_id = ?
          order by cs.created_at asc`,
      )
      .all(claim.id, claim.matter_id);
    const assessmentId = randomUUID();
    const sourceSnapshot = json(sources);
    const payloadSha256 = createHash("sha256")
      .update(
        json({
          claimId: claim.id,
          version: 1,
          status: claim.status,
          legalBasis: claim.legal_basis ?? null,
          confidence: claim.confidence ?? null,
          uncertainty: claim.uncertainty ?? null,
          decisionComment:
            claim.decision_comment ??
            "Migrated from the current decided position.",
          sourceSnapshot: sources,
          sourceReviewId: null,
          supersedesId: null,
        }),
      )
      .digest("hex");
    db.prepare(
      `insert into aletheia_legal_assessments (
        id, matter_id, user_id, claim_id, version, status, legal_basis,
        confidence, uncertainty, decision_comment, source_snapshot, payload_sha256,
        source_review_id, supersedes_id, created_by, created_at
      ) values (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)`,
    ).run(
      assessmentId,
      claim.matter_id,
      claim.user_id,
      claim.id,
      claim.status,
      claim.legal_basis ?? null,
      claim.confidence ?? null,
      claim.uncertainty ?? null,
      claim.decision_comment ?? "Migrated from the current decided position.",
      sourceSnapshot,
      payloadSha256,
      claim.decided_by ?? claim.created_by,
      claim.decided_at ?? claim.updated_at ?? claim.created_at ?? now(),
    );
    db.prepare(
      `update aletheia_litigation_claims
          set current_assessment_id = ?
        where id = ? and matter_id = ? and user_id = ?`,
    ).run(assessmentId, claim.id, claim.matter_id, claim.user_id);
  }
}

export class LocalLitigationStore {
  constructor(private readonly db: LocalDatabase) {}

  private documentTemplate(
    ctx: AletheiaUserContext,
    matterId: string,
    id: string,
    version: number,
  ) {
    const builtIn = resolveLitigationDocumentTemplate(id, version);
    if (builtIn) return { ...builtIn, source: "built_in" as const };
    const custom = this.db
      .prepare(
        `select id, version, name, status, file_sha256
           from aletheia_litigation_custom_templates
          where id = ? and version = ? and matter_id = ? and user_id = ?
            and status = 'approved'`,
      )
      .get(id, version, matterId, ctx.userId) as
      | Record<string, any>
      | undefined;
    return custom
      ? {
          id: String(custom.id),
          version: Number(custom.version),
          name: String(custom.name),
          status: "approved" as const,
          templateHash: `sha256:${String(custom.file_sha256)}`,
          source: "custom" as const,
        }
      : null;
  }

  private ownedMatter(ctx: AletheiaUserContext, matterId: string) {
    return this.db
      .prepare(
        "select id, template from aletheia_matters where id = ? and user_id = ?",
      )
      .get(matterId, ctx.userId) as
      | { id: string; template: string }
      | undefined;
  }

  private requireOwnedMatter(ctx: AletheiaUserContext, matterId: string) {
    const matter = this.ownedMatter(ctx, matterId);
    if (!matter) return null;
    if (matter.template !== "civil_litigation") {
      throw new LitigationValidationError(
        "Litigation workspace operations require a civil_litigation matter.",
      );
    }
    return matter;
  }

  private appendLegalAssessment(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    sourceReviewId: string | null,
    actorId = ctx.userId,
  ) {
    const claim = this.db
      .prepare(
        `select * from aletheia_litigation_claims
          where id = ? and matter_id = ? and user_id = ?
            and status in ('confirmed', 'rejected', 'withdrawn')`,
      )
      .get(claimId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!claim) {
      throw new LitigationValidationError(
        "A decided legal position is required for an assessment snapshot.",
      );
    }
    const previous = this.db
      .prepare(
        `select id, version from aletheia_legal_assessments
          where claim_id = ? and matter_id = ? and user_id = ?
          order by version desc limit 1`,
      )
      .get(claimId, matterId, ctx.userId) as
      | { id: string; version: number }
      | undefined;
    const sources = this.db
      .prepare(
        `select cs.id, cs.relation, s.id as source_span_id,
                s.document_id, s.document_name, s.page, s.section,
                s.quote, s.source_chunk_sha256, s.quote_sha256
           from aletheia_litigation_claim_sources cs
           join aletheia_source_spans s
             on s.id = cs.source_span_id and s.matter_id = cs.matter_id
          where cs.claim_id = ? and cs.matter_id = ? and s.user_id = ?
          order by cs.created_at asc`,
      )
      .all(claimId, matterId, ctx.userId);
    const legalAuthorities = this.db
      .prepare(
        `select pa.id, pa.authority_version_id, pa.applicability_date,
                pa.provision_reference, pa.exact_quote, pa.quote_sha256,
                pa.rationale, pa.status, a.official_identifier,
                a.version_label, a.content_sha256, a.effective_from,
                a.effective_to, a.status as authority_status
           from aletheia_litigation_position_authorities pa
           join aletheia_litigation_legal_authority_versions a
             on a.id = pa.authority_version_id and a.matter_id = pa.matter_id
            and a.user_id = pa.user_id
          where pa.claim_id = ? and pa.matter_id = ? and pa.user_id = ?
          order by pa.created_at asc`,
      )
      .all(claimId, matterId, ctx.userId);
    const id = randomUUID();
    const version = (previous?.version ?? 0) + 1;
    const sourceSnapshotValue = {
      evidenceSources: sources,
      legalAuthorities,
    };
    const sourceSnapshot = json(sourceSnapshotValue);
    const payloadSha256 = createHash("sha256")
      .update(
        json({
          claimId,
          version,
          status: claim.status,
          legalBasis: claim.legal_basis ?? null,
          confidence: claim.confidence ?? null,
          uncertainty: claim.uncertainty ?? null,
          decisionComment: claim.decision_comment ?? null,
          sourceSnapshot: sourceSnapshotValue,
          sourceReviewId,
          supersedesId: previous?.id ?? null,
        }),
      )
      .digest("hex");
    this.db
      .prepare(
        `insert into aletheia_legal_assessments (
          id, matter_id, user_id, claim_id, version, status, legal_basis,
          confidence, uncertainty, decision_comment, source_snapshot, payload_sha256,
          source_review_id, supersedes_id, created_by, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        matterId,
        ctx.userId,
        claimId,
        version,
        claim.status,
        claim.legal_basis ?? null,
        claim.confidence ?? null,
        claim.uncertainty ?? null,
        claim.decision_comment ?? null,
        sourceSnapshot,
        payloadSha256,
        sourceReviewId,
        previous?.id ?? null,
        actorId,
        claim.decided_at ?? now(),
      );
    this.db
      .prepare(
        `update aletheia_litigation_claims
            set current_assessment_id = ?
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .run(id, claimId, matterId, ctx.userId);
    return record(
      this.db
        .prepare(
          "select * from aletheia_legal_assessments where id = ? and matter_id = ? and user_id = ?",
        )
        .get(id, matterId, ctx.userId) as Record<string, unknown>,
    );
  }

  private assertLegalAssessmentIntegrity(
    workspace: Record<string, Array<Record<string, any>>>,
  ) {
    for (const claim of workspace.claims.filter((item) =>
      ["confirmed", "rejected", "withdrawn"].includes(String(item.status)),
    )) {
      const assessments = workspace.legal_assessments
        .filter((item) => item.claim_id === claim.id)
        .sort((left, right) => Number(left.version) - Number(right.version));
      const current = assessments.at(-1);
      if (
        !current ||
        !claim.current_assessment_id ||
        current.id !== claim.current_assessment_id
      ) {
        throw new LitigationValidationError(
          `Legal assessment lineage is incomplete for claim ${String(claim.id)}.`,
        );
      }
      for (let index = 0; index < assessments.length; index += 1) {
        const assessment = assessments[index];
        const previous = assessments[index - 1];
        if (
          Number(assessment.version) !== index + 1 ||
          (index === 0
            ? assessment.supersedes_id !== null
            : assessment.supersedes_id !== previous.id)
        ) {
          throw new LitigationValidationError(
            `Legal assessment lineage is invalid for claim ${String(claim.id)}.`,
          );
        }
        const expectedHash = createHash("sha256")
          .update(
            json({
              claimId: assessment.claim_id,
              version: Number(assessment.version),
              status: assessment.status,
              legalBasis: assessment.legal_basis ?? null,
              confidence: assessment.confidence ?? null,
              uncertainty: assessment.uncertainty ?? null,
              decisionComment: assessment.decision_comment ?? null,
              sourceSnapshot: assessment.source_snapshot,
              sourceReviewId: assessment.source_review_id ?? null,
              supersedesId: assessment.supersedes_id ?? null,
            }),
          )
          .digest("hex");
        if (expectedHash !== assessment.payload_sha256) {
          throw new LitigationValidationError(
            `Legal assessment integrity check failed for claim ${String(claim.id)} version ${String(assessment.version)}.`,
          );
        }
      }
    }
  }

  private createSourceSpan(
    ctx: AletheiaUserContext,
    matterId: string,
    source: { sourceChunkId: string; quoteStart: number; quoteEnd: number },
    createdBy: "agent" | "human",
  ) {
    const chunk = this.db
      .prepare(
        `select c.id, c.document_id, c.page, c.section, c.text, c.metadata,
                c.quote_start, d.name as document_name
           from aletheia_document_chunks c
           join aletheia_matter_documents d
             on d.id = c.document_id
            and d.matter_id = c.matter_id
            and d.user_id = c.user_id
          where c.id = ? and c.matter_id = ? and c.user_id = ?`,
      )
      .get(source.sourceChunkId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!chunk) {
      throw new LitigationValidationError(
        "The source chunk does not belong to this matter.",
      );
    }
    const chunkText = String(chunk.text ?? "");
    const start = Number(source.quoteStart);
    const end = Number(source.quoteEnd);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > chunkText.length
    ) {
      throw new LitigationValidationError(
        "Source quote offsets must identify a non-empty range inside the chunk.",
      );
    }
    const id = randomUUID();
    const documentOffset = Number(chunk.quote_start ?? 0);
    const chunkMetadata = parseJson(chunk.metadata) as Record<string, unknown>;
    const rawOcrProvenance = chunkMetadata.ocrProvenance;
    const ocrProvenance =
      rawOcrProvenance && typeof rawOcrProvenance === "object"
        ? rawOcrProvenance
        : null;
    const sourceMetadata = ocrProvenance
      ? {
          ocrProvenance,
          ocrProvenanceSha256: sha256Json(ocrProvenance),
        }
      : {};
    this.db
      .prepare(
        `insert into aletheia_source_spans (
          id, matter_id, user_id, document_id, source_chunk_id, document_name,
          page, section, chunk_quote_start, chunk_quote_end,
          document_quote_start, document_quote_end, quote, source_chunk_sha256,
          quote_sha256, created_by,
          metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        matterId,
        ctx.userId,
        chunk.document_id,
        chunk.id,
        chunk.document_name,
        chunk.page ?? null,
        chunk.section ?? null,
        start,
        end,
        documentOffset + start,
        documentOffset + end,
        chunkText.slice(start, end),
        createHash("sha256").update(chunkText).digest("hex"),
        createHash("sha256").update(chunkText.slice(start, end)).digest("hex"),
        createdBy,
        json(sourceMetadata),
        now(),
      );
    return id;
  }

  private sourceSpanIntegrity(span: Record<string, unknown>) {
    const chunkText = String(span.current_chunk_text ?? "");
    const quote = chunkText.slice(
      Number(span.chunk_quote_start),
      Number(span.chunk_quote_end),
    );
    const sourceMetadata = parseJson(span.metadata) as Record<string, unknown>;
    const currentChunkMetadata = parseJson(
      span.current_chunk_metadata,
    ) as Record<string, unknown>;
    const sourceProvenance = sourceMetadata.ocrProvenance;
    const currentProvenance = currentChunkMetadata.ocrProvenance;
    const provenanceValid = sourceProvenance
      ? this.validOcrProvenance(sourceProvenance) &&
        sourceMetadata.ocrProvenanceSha256 === sha256Json(sourceProvenance) &&
        stableJson(sourceProvenance) === stableJson(currentProvenance)
      : !currentProvenance;
    return (
      createHash("sha256").update(chunkText).digest("hex") ===
        span.source_chunk_sha256 &&
      createHash("sha256").update(quote).digest("hex") === span.quote_sha256 &&
      quote === span.quote &&
      provenanceValid
    );
  }

  private validOcrProvenance(value: unknown) {
    if (!value || typeof value !== "object") return false;
    const provenance = value as Record<string, unknown>;
    const confidence = Number(provenance.confidence);
    const page = Number(provenance.page);
    return (
      typeof provenance.engine === "string" &&
      provenance.engine.trim().length > 0 &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1 &&
      Number.isInteger(page) &&
      page > 0
    );
  }

  private lowConfidenceOcr(span: Record<string, unknown>) {
    const metadata = parseJson(span.metadata) as Record<string, unknown>;
    const provenance = metadata.ocrProvenance;
    if (!provenance) return false;
    if (!this.validOcrProvenance(provenance)) return true;
    const confidence = Number(
      (provenance as Record<string, unknown>).confidence,
    );
    return (
      Number.isFinite(confidence) && confidence < LOW_CONFIDENCE_OCR_THRESHOLD
    );
  }

  private assertConfirmableSources(
    ctx: AletheiaUserContext,
    matterId: string,
    entity: "fact" | "claim",
    entityId: string,
  ) {
    const relationTable =
      entity === "fact"
        ? "aletheia_litigation_fact_sources"
        : "aletheia_litigation_claim_sources";
    const entityColumn = entity === "fact" ? "fact_id" : "claim_id";
    const spans = this.db
      .prepare(
        `select s.*, c.text as current_chunk_text,
                c.metadata as current_chunk_metadata
           from ${relationTable} r
           join aletheia_source_spans s
             on s.id = r.source_span_id and s.matter_id = r.matter_id
           join aletheia_document_chunks c
             on c.id = s.source_chunk_id and c.matter_id = s.matter_id
            and c.user_id = s.user_id
          where r.matter_id = ? and r.${entityColumn} = ? and s.user_id = ?`,
      )
      .all(matterId, entityId, ctx.userId) as Array<Record<string, unknown>>;
    for (const span of spans) {
      if (!this.sourceSpanIntegrity(span)) {
        throw new LitigationValidationError(
          "Source text changed after citation. Recreate the citation before confirming.",
        );
      }
      if (!this.lowConfidenceOcr(span)) continue;
      const verification = this.db
        .prepare(
          `select id from aletheia_source_span_verifications
            where matter_id = ? and user_id = ? and source_span_id = ?
              and source_chunk_sha256 = ? and quote_sha256 = ?
              and verification_type = 'original_scan_compared'
              and not exists (
                select 1
                  from aletheia_source_span_verification_withdrawals w
                 where w.verification_id = aletheia_source_span_verifications.id
                   and w.matter_id = aletheia_source_span_verifications.matter_id
                   and w.user_id = aletheia_source_span_verifications.user_id
              )
            order by verified_at desc limit 1`,
        )
        .get(
          matterId,
          ctx.userId,
          span.id,
          span.source_chunk_sha256,
          span.quote_sha256,
        );
      if (!verification) {
        throw new LitigationValidationError(
          "Low-confidence OCR citation must be compared with the original scan before confirmation.",
        );
      }
    }
  }

  private positionAuthorityPolicyStatus(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
  ) {
    const links = this.db
      .prepare(
        `select pa.*, a.status as authority_status, a.content as authority_content,
                a.content_sha256 as authority_content_sha256,
                a.effective_from as authority_effective_from,
                a.effective_to as authority_effective_to
           from aletheia_litigation_position_authorities pa
           left join aletheia_litigation_legal_authority_versions a
             on a.id = pa.authority_version_id and a.matter_id = pa.matter_id
            and a.user_id = pa.user_id
          where pa.claim_id = ? and pa.matter_id = ? and pa.user_id = ?
            and pa.status = 'active'
          order by pa.created_at asc`,
      )
      .all(claimId, matterId, ctx.userId) as Array<Record<string, any>>;
    const invalidLinkIds: string[] = [];
    const validLinkIds: string[] = [];
    for (const link of links) {
      const content = String(link.authority_content ?? "");
      const quote = String(link.exact_quote ?? "");
      const applicabilityDate = String(link.applicability_date ?? "");
      const valid =
        link.authority_status === "verified" &&
        createHash("sha256").update(content).digest("hex") ===
          link.authority_content_sha256 &&
        createHash("sha256").update(quote).digest("hex") === link.quote_sha256 &&
        content.includes(quote) &&
        applicabilityDate >= String(link.authority_effective_from ?? "") &&
        (!link.authority_effective_to ||
          applicabilityDate <= String(link.authority_effective_to));
      (valid ? validLinkIds : invalidLinkIds).push(String(link.id));
    }
    return {
      claim_id: claimId,
      status:
        invalidLinkIds.length > 0
          ? "invalid"
          : validLinkIds.length > 0
            ? "satisfied"
            : "missing",
      valid_link_ids: validLinkIds,
      invalid_link_ids: invalidLinkIds,
    };
  }

  verifySourceSpanOriginal(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
    reason: string,
    verifiedBy = ctx.userId,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const reviewReason = reason.trim();
    if (reviewReason.length < 10 || reviewReason.length > 2000) {
      throw new LitigationValidationError(
        "Original-scan verification reason must be between 10 and 2000 characters.",
      );
    }
    const verifierId = verifiedBy.trim();
    if (!verifierId || verifierId.length > 160) {
      throw new LitigationValidationError(
        "Original-scan verification requires an authenticated verifier.",
      );
    }
    const span = this.db
      .prepare(
        `select s.*, c.text as current_chunk_text,
                c.metadata as current_chunk_metadata
           from aletheia_source_spans s
           join aletheia_document_chunks c
             on c.id = s.source_chunk_id and c.matter_id = s.matter_id
            and c.user_id = s.user_id
          where s.id = ? and s.matter_id = ? and s.user_id = ?`,
      )
      .get(sourceSpanId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!span) return null;
    if (!this.sourceSpanIntegrity(span)) {
      throw new LitigationValidationError(
        "Source text changed after citation. Recreate the citation before verification.",
      );
    }
    if (!this.lowConfidenceOcr(span)) {
      throw new LitigationValidationError(
        "Original-scan verification is only required for low-confidence OCR citations.",
      );
    }
    const timestamp = now();
    const id = randomUUID();
    let verified: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_source_span_verifications (
            id, matter_id, user_id, source_span_id, verification_type,
            source_chunk_sha256, quote_sha256, reason, verified_by, verified_at
          ) values (?, ?, ?, ?, 'original_scan_compared', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          sourceSpanId,
          span.source_chunk_sha256,
          span.quote_sha256,
          reviewReason,
          verifierId,
          timestamp,
        );
      verified = record(
        this.db
          .prepare(
            "select * from aletheia_source_span_verifications where id = ?",
          )
          .get(id) as Record<string, unknown>,
      );
      if (!verified)
        throw new Error("Source verification could not be reloaded.");
      onBeforeCommit?.(verified);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return verified;
  }

  withdrawSourceSpanOriginalVerification(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
    verificationId: string,
    reason: string,
    withdrawnBy = ctx.userId,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const withdrawalReason = reason.trim();
    if (withdrawalReason.length < 10 || withdrawalReason.length > 2000) {
      throw new LitigationValidationError(
        "Original-scan verification withdrawal reason must be between 10 and 2000 characters.",
      );
    }
    const withdrawerId = withdrawnBy.trim();
    if (!withdrawerId || withdrawerId.length > 160) {
      throw new LitigationValidationError(
        "Original-scan verification withdrawal requires an authenticated withdrawer.",
      );
    }

    const timestamp = now();
    const id = randomUUID();
    let withdrawn: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const verification = this.db
        .prepare(
          `select * from aletheia_source_span_verifications
            where id = ? and matter_id = ? and user_id = ? and source_span_id = ?
              and verification_type = 'original_scan_compared'`,
        )
        .get(verificationId, matterId, ctx.userId, sourceSpanId) as
        | Record<string, unknown>
        | undefined;
      if (!verification) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const alreadyWithdrawn = this.db
        .prepare(
          `select id from aletheia_source_span_verification_withdrawals
            where verification_id = ? and matter_id = ? and user_id = ?`,
        )
        .get(verificationId, matterId, ctx.userId);
      if (alreadyWithdrawn) {
        throw new LitigationValidationError(
          "Original-scan verification has already been withdrawn.",
        );
      }
      this.db
        .prepare(
          `insert into aletheia_source_span_verification_withdrawals (
            id, matter_id, user_id, verification_id, source_span_id,
            source_chunk_sha256, quote_sha256, reason, withdrawn_by, withdrawn_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          verificationId,
          sourceSpanId,
          verification.source_chunk_sha256,
          verification.quote_sha256,
          withdrawalReason,
          withdrawerId,
          timestamp,
        );
      withdrawn = record(
        this.db
          .prepare(
            "select * from aletheia_source_span_verification_withdrawals where id = ?",
          )
          .get(id) as Record<string, unknown>,
      );
      if (!withdrawn) {
        throw new Error("Source verification withdrawal could not be reloaded.");
      }
      onBeforeCommit?.(withdrawn);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return withdrawn;
  }

  listSourceSpanOriginalVerificationHistory(
    ctx: AletheiaUserContext,
    matterId: string,
    sourceSpanId: string,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const rows = this.db
      .prepare(
        `select
            v.id as verification_id,
            v.verification_type,
            v.source_chunk_sha256 as verification_source_chunk_sha256,
            v.quote_sha256 as verification_quote_sha256,
            v.reason as verification_reason,
            v.verified_by,
            v.verified_at,
            w.id as withdrawal_id,
            w.reason as withdrawal_reason,
            w.withdrawn_by,
            w.withdrawn_at,
            s.source_chunk_sha256,
            s.quote_sha256,
            s.quote,
            s.chunk_quote_start,
            s.chunk_quote_end,
            s.metadata,
            c.text as current_chunk_text,
            c.metadata as current_chunk_metadata
           from aletheia_source_spans s
           join aletheia_document_chunks c
             on c.id = s.source_chunk_id and c.matter_id = s.matter_id
            and c.user_id = s.user_id
           left join aletheia_source_span_verifications v
             on v.source_span_id = s.id and v.matter_id = s.matter_id
            and v.user_id = s.user_id
            and v.verification_type = 'original_scan_compared'
           left join aletheia_source_span_verification_withdrawals w
             on w.verification_id = v.id and w.matter_id = v.matter_id
            and w.user_id = v.user_id and w.source_span_id = s.id
          where s.id = ? and s.matter_id = ? and s.user_id = ?
          order by v.verified_at asc, v.id asc`,
      )
      .all(sourceSpanId, matterId, ctx.userId) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;

    return rows
      .filter((row) => row.verification_id)
      .map((row) => ({
        id: row.verification_id,
        verification_type: row.verification_type,
        source_chunk_sha256: row.verification_source_chunk_sha256,
        quote_sha256: row.verification_quote_sha256,
        reason: row.verification_reason,
        verified_by: row.verified_by,
        verified_at: row.verified_at,
        withdrawal: row.withdrawal_id
          ? {
              id: row.withdrawal_id,
              reason: row.withdrawal_reason,
              withdrawn_by: row.withdrawn_by,
              withdrawn_at: row.withdrawn_at,
            }
          : null,
        current:
          !row.withdrawal_id &&
          row.verification_source_chunk_sha256 === row.source_chunk_sha256 &&
          row.verification_quote_sha256 === row.quote_sha256 &&
          this.sourceSpanIntegrity(row),
      }));
  }

  updateProfile(
    ctx: AletheiaUserContext,
    matterId: string,
    input: UpdateLitigationProfileInput,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
    actorId = ctx.userId,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const prefix = input.exhibitPrefix.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,12}$/.test(prefix)) {
      throw new LitigationValidationError(
        "Exhibit prefix must contain 1-12 ASCII letters, numbers, underscores, or hyphens.",
      );
    }
    if (
      !Number.isSafeInteger(input.exhibitStart) ||
      input.exhibitStart < 1 ||
      input.exhibitStart > 9999
    ) {
      throw new LitigationValidationError(
        "Exhibit start must be an integer from 1 to 9999.",
      );
    }
    if (!new Set(["auto", "source_native"]).has(input.paginationPolicy)) {
      throw new LitigationValidationError("Pagination policy is invalid.");
    }
    const documentTemplate = this.documentTemplate(
      ctx,
      matterId,
      input.documentTemplateId ?? DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
      input.documentTemplateVersion ??
        DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
    );
    if (!documentTemplate || documentTemplate.status !== "approved") {
      throw new LitigationValidationError(
        "Document template is unavailable or not approved.",
      );
    }
    const timestamp = now();
    let updated: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_profiles (
            matter_id, user_id, case_number, court, cause_of_action,
            procedure_stage, represented_side, organization_name,
            exhibit_prefix, exhibit_start, pagination_policy,
            document_template_id, document_template_version, metadata,
            created_at, updated_at
          ) values (?, ?, ?, ?, null, null, null, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
          on conflict(matter_id) do update set
            case_number = excluded.case_number,
            court = excluded.court,
            organization_name = excluded.organization_name,
            exhibit_prefix = excluded.exhibit_prefix,
            exhibit_start = excluded.exhibit_start,
            pagination_policy = excluded.pagination_policy,
            document_template_id = excluded.document_template_id,
            document_template_version = excluded.document_template_version,
            updated_at = excluded.updated_at
          where aletheia_litigation_profiles.user_id = excluded.user_id`,
        )
        .run(
          matterId,
          ctx.userId,
          input.caseNumber?.trim() || null,
          input.court?.trim() || null,
          input.organizationName?.trim() || null,
          prefix,
          input.exhibitStart,
          input.paginationPolicy,
          documentTemplate.id,
          documentTemplate.version,
          timestamp,
          timestamp,
        );
      updated = record(
        this.db
          .prepare(
            "select * from aletheia_litigation_profiles where matter_id = ? and user_id = ?",
          )
          .get(matterId, ctx.userId) as Record<string, unknown>,
      );
      if (!updated)
        throw new Error("Litigation profile could not be reloaded.");
      onBeforeCommit?.({ ...updated, actor_id: actorId });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return updated;
  }

  getWorkspace(ctx: AletheiaUserContext, matterId: string) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const profile = record(
      this.db
        .prepare(
          "select * from aletheia_litigation_profiles where matter_id = ? and user_id = ?",
        )
        .get(matterId, ctx.userId) as Record<string, unknown> | undefined,
    );
    const list = (sql: string, ...parameters: unknown[]) =>
      (
        this.db
          .prepare(sql)
          .all(...(parameters.length ? parameters : [matterId])) as Record<
          string,
          unknown
        >[]
      ).map((item) => record(item));
    const workspace = {
      profile,
      facts: list(
        "select * from aletheia_litigation_facts where matter_id = ? and user_id = ? order by occurred_at asc, created_at asc",
        matterId,
        ctx.userId,
      ),
      fact_sources: list(
        `select fs.*, s.document_id, s.document_name, s.page, s.section,
                s.quote, s.document_quote_start, s.document_quote_end,
                s.source_chunk_sha256, s.quote_sha256, s.metadata,
                (select v.id from aletheia_source_span_verifications v
                  where v.matter_id = s.matter_id and v.user_id = s.user_id
                    and v.source_span_id = s.id
                    and v.source_chunk_sha256 = s.source_chunk_sha256
                    and v.quote_sha256 = s.quote_sha256
                    and not exists (
                      select 1
                        from aletheia_source_span_verification_withdrawals w
                       where w.verification_id = v.id
                         and w.matter_id = v.matter_id and w.user_id = v.user_id
                    )
                  order by v.verified_at desc limit 1) as current_verification_id,
                (select v.reason from aletheia_source_span_verifications v
                  where v.matter_id = s.matter_id and v.user_id = s.user_id
                    and v.source_span_id = s.id
                    and v.source_chunk_sha256 = s.source_chunk_sha256
                    and v.quote_sha256 = s.quote_sha256
                    and not exists (
                      select 1
                        from aletheia_source_span_verification_withdrawals w
                       where w.verification_id = v.id
                         and w.matter_id = v.matter_id and w.user_id = v.user_id
                    )
                  order by v.verified_at desc limit 1) as verification_reason,
                (select v.verified_at from aletheia_source_span_verifications v
                  where v.matter_id = s.matter_id and v.user_id = s.user_id
                    and v.source_span_id = s.id
                    and v.source_chunk_sha256 = s.source_chunk_sha256
                    and v.quote_sha256 = s.quote_sha256
                    and not exists (
                      select 1
                        from aletheia_source_span_verification_withdrawals w
                       where w.verification_id = v.id
                         and w.matter_id = v.matter_id and w.user_id = v.user_id
                    )
                  order by v.verified_at desc limit 1) as verified_at
           from aletheia_litigation_fact_sources fs
           join aletheia_litigation_facts f
             on f.id = fs.fact_id and f.matter_id = fs.matter_id
           join aletheia_source_spans s
             on s.id = fs.source_span_id and s.matter_id = fs.matter_id
          where fs.matter_id = ? and f.user_id = ? and s.user_id = ?
          order by fs.created_at asc`,
        matterId,
        ctx.userId,
        ctx.userId,
      ),
      claims: list(
        "select * from aletheia_litigation_claims where matter_id = ? and user_id = ? order by created_at asc",
        matterId,
        ctx.userId,
      ),
      claim_sources: list(
        `select cs.*, s.document_id, s.document_name, s.page, s.section,
                s.quote, s.chunk_quote_start, s.chunk_quote_end,
                s.document_quote_start, s.document_quote_end,
                s.source_chunk_sha256, s.quote_sha256, s.metadata,
                (select v.id from aletheia_source_span_verifications v
                  where v.matter_id = s.matter_id and v.user_id = s.user_id
                    and v.source_span_id = s.id
                    and v.source_chunk_sha256 = s.source_chunk_sha256
                    and v.quote_sha256 = s.quote_sha256
                    and not exists (
                      select 1
                        from aletheia_source_span_verification_withdrawals w
                       where w.verification_id = v.id
                         and w.matter_id = v.matter_id and w.user_id = v.user_id
                    )
                  order by v.verified_at desc limit 1) as current_verification_id,
                (select v.reason from aletheia_source_span_verifications v
                  where v.matter_id = s.matter_id and v.user_id = s.user_id
                    and v.source_span_id = s.id
                    and v.source_chunk_sha256 = s.source_chunk_sha256
                    and v.quote_sha256 = s.quote_sha256
                    and not exists (
                      select 1
                        from aletheia_source_span_verification_withdrawals w
                       where w.verification_id = v.id
                         and w.matter_id = v.matter_id and w.user_id = v.user_id
                    )
                  order by v.verified_at desc limit 1) as verification_reason,
                (select v.verified_at from aletheia_source_span_verifications v
                  where v.matter_id = s.matter_id and v.user_id = s.user_id
                    and v.source_span_id = s.id
                    and v.source_chunk_sha256 = s.source_chunk_sha256
                    and v.quote_sha256 = s.quote_sha256
                    and not exists (
                      select 1
                        from aletheia_source_span_verification_withdrawals w
                       where w.verification_id = v.id
                         and w.matter_id = v.matter_id and w.user_id = v.user_id
                    )
                  order by v.verified_at desc limit 1) as verified_at
           from aletheia_litigation_claim_sources cs
           join aletheia_litigation_claims c
             on c.id = cs.claim_id and c.matter_id = cs.matter_id
           join aletheia_source_spans s
             on s.id = cs.source_span_id and s.matter_id = cs.matter_id
          where cs.matter_id = ? and c.user_id = ? and s.user_id = ?
          order by cs.created_at asc`,
        matterId,
        ctx.userId,
        ctx.userId,
      ),
      position_reviews: list(
        `select r.* from aletheia_position_reviews r
           join aletheia_litigation_claims c
             on c.id = r.claim_id and c.matter_id = r.matter_id
          where r.matter_id = ? and r.user_id = ? and c.user_id = ?
          order by r.created_at asc`,
        matterId,
        ctx.userId,
        ctx.userId,
      ),
      legal_assessments: list(
        `select a.* from aletheia_legal_assessments a
           join aletheia_litigation_claims c
             on c.id = a.claim_id and c.matter_id = a.matter_id
          where a.matter_id = ? and a.user_id = ? and c.user_id = ?
          order by a.claim_id asc, a.version asc`,
        matterId,
        ctx.userId,
        ctx.userId,
      ),
      agent_output_reviews: list(
        `select * from aletheia_litigation_agent_output_reviews
          where matter_id = ? and user_id = ? order by created_at desc`,
        matterId,
        ctx.userId,
      ),
      agent_finding_reviews: list(
        `select * from aletheia_litigation_agent_finding_reviews
          where matter_id = ? and user_id = ?
          order by run_id asc, step_id asc, finding_index asc, version asc`,
        matterId,
        ctx.userId,
      ),
      agent_finding_semantic_checks: list(
        `select * from aletheia_litigation_agent_finding_semantic_checks
          where matter_id = ? and user_id = ?
          order by run_id asc, step_id asc, finding_index asc, version asc`,
        matterId,
        ctx.userId,
      ),
      legal_authority_versions: list(
        `select * from aletheia_litigation_legal_authority_versions
          where matter_id = ? and user_id = ?
          order by official_identifier asc, effective_from desc`,
        matterId,
        ctx.userId,
      ),
      position_authorities: list(
        `select pa.* from aletheia_litigation_position_authorities pa
           join aletheia_litigation_claims c
             on c.id = pa.claim_id and c.matter_id = pa.matter_id
          where pa.matter_id = ? and pa.user_id = ? and c.user_id = ?
          order by pa.created_at asc`,
        matterId,
        ctx.userId,
        ctx.userId,
      ),
      elements: list(
        `select e.* from aletheia_litigation_claim_elements e
           join aletheia_litigation_claims c
             on c.id = e.claim_id and c.matter_id = e.matter_id
          where e.matter_id = ? and c.user_id = ?
          order by e.sequence asc, e.created_at asc`,
        matterId,
        ctx.userId,
      ),
      element_facts: list(
        `select ef.* from aletheia_litigation_element_facts ef
           join aletheia_litigation_claim_elements e
             on e.id = ef.element_id and e.matter_id = ef.matter_id
           join aletheia_litigation_claims c
             on c.id = e.claim_id and c.matter_id = e.matter_id
           join aletheia_litigation_facts f
             on f.id = ef.fact_id and f.matter_id = ef.matter_id
          where ef.matter_id = ? and c.user_id = ? and f.user_id = ?
          order by ef.created_at asc`,
        matterId,
        ctx.userId,
        ctx.userId,
      ),
      procedural_events: list(
        `select e.*, s.document_id, s.document_name, s.page, s.section,
                s.quote, s.source_chunk_sha256, s.quote_sha256,
                (select v.id from aletheia_source_span_verifications v
                  where v.matter_id = s.matter_id and v.user_id = s.user_id
                    and v.source_span_id = s.id
                    and v.source_chunk_sha256 = s.source_chunk_sha256
                    and v.quote_sha256 = s.quote_sha256
                    and not exists (
                      select 1
                        from aletheia_source_span_verification_withdrawals w
                       where w.verification_id = v.id
                         and w.matter_id = v.matter_id and w.user_id = v.user_id
                    )
                  order by v.verified_at desc limit 1) as current_verification_id
           from aletheia_litigation_procedural_events e
           left join aletheia_source_spans s
             on s.id = e.primary_source_span_id
            and s.matter_id = e.matter_id and s.user_id = e.user_id
          where e.matter_id = ? and e.user_id = ?
          order by e.occurred_at asc, e.created_at asc`,
        matterId,
        ctx.userId,
      ),
      procedural_event_corrections: list(
        `select id, matter_id, user_id, original_event_id,
                replacement_event_id, from_occurred_at, to_occurred_at,
                reason, correction_hash, corrected_by, corrected_at
           from aletheia_litigation_procedural_event_corrections
          where matter_id = ? and user_id = ?
          order by corrected_at desc`,
        matterId,
        ctx.userId,
      ),
      deadlines: list(
        `select d.*, s.document_name, s.page, s.section, s.quote
           from aletheia_litigation_deadlines d
           left join aletheia_source_spans s
             on s.id = d.primary_source_span_id
            and s.matter_id = d.matter_id and s.user_id = d.user_id
          where d.matter_id = ? and d.user_id = ?
          order by d.due_at asc, d.created_at asc`,
        matterId,
        ctx.userId,
      ),
    };
    const citedFactIds = new Set(
      workspace.fact_sources.map((source) => String(source?.fact_id ?? "")),
    );
    const semanticChecks = workspace.agent_finding_semantic_checks.map((check) => {
      if (!check) {
        return { stale: true, stale_reasons: ["current_state_unavailable"] };
      }
      const staleReasons: string[] = [];
      try {
        const run = this.db.prepare("select metadata, status from aletheia_agent_runs where id = ? and matter_id = ? and user_id = ?").get(check.run_id, matterId, ctx.userId) as Record<string, any> | undefined;
        const step = this.db.prepare("select output, status from aletheia_agent_steps where id = ? and run_id = ? and matter_id = ? and user_id = ?").get(check.step_id, check.run_id, matterId, ctx.userId) as Record<string, any> | undefined;
        if (!run || run.status !== "succeeded") staleReasons.push("run_changed");
        if (!step || step.status !== "succeeded") staleReasons.push("step_changed");
        const output = step ? parseJson(step.output) as Record<string, any> : {};
        const findings = Array.isArray((output.structuredOutput as Record<string, any> | undefined)?.findings)
          ? ((output.structuredOutput as Record<string, any>).findings as unknown[])
          : [];
        const finding = findings[Number(check.finding_index)] as Record<string, any> | undefined;
        if (!finding || sha256Json({ stepId: String(check.step_id), findingIndex: Number(check.finding_index), finding }) !== check.finding_hash) {
          staleReasons.push("finding_changed");
        } else if (sha256Json(Array.isArray(finding.citations) ? finding.citations : []) !== check.citation_set_hash) {
          staleReasons.push("citation_set_changed");
        }
        const metadata = run ? parseJson(run.metadata) as Record<string, any> : {};
        if (metadata.snapshotHash !== check.snapshot_hash) staleReasons.push("snapshot_changed");
        const review = (workspace.agent_output_reviews.filter(Boolean) as Array<Record<string, any>>)
          .find((item) => item.run_id === check.run_id);
        if (!review || review.status !== "open" || review.output_hash !== check.output_review_hash) staleReasons.push("output_review_changed");
        const calibration = this.db.prepare("select id, model_fingerprint, status, expires_at from aletheia_local_model_calibrations where user_id = ? and model_id = ? order by tested_at desc, rowid desc limit 1").get(ctx.userId, check.model_id) as Record<string, any> | undefined;
        if (!calibration || calibration.id !== check.calibration_id || calibration.model_fingerprint !== check.calibration_fingerprint || calibration.status !== "passed" || Date.parse(calibration.expires_at) <= Date.now()) staleReasons.push("calibration_changed");
        const benchmark = this.db.prepare("select id, model_fingerprint, status, expires_at from aletheia_local_model_benchmark_runs where user_id = ? and model_id = ? order by tested_at desc, rowid desc limit 1").get(ctx.userId, check.model_id) as Record<string, any> | undefined;
        if (!benchmark || benchmark.id !== check.benchmark_id || benchmark.model_fingerprint !== check.benchmark_fingerprint || benchmark.status !== "passed" || Date.parse(benchmark.expires_at) <= Date.now()) staleReasons.push("benchmark_changed");
      } catch {
        staleReasons.push("current_state_unavailable");
      }
      return { ...check, stale: staleReasons.length > 0, stale_reasons: staleReasons };
    });
    return {
      ...workspace,
      position_authority_statuses: workspace.claims.map((claim) =>
        this.positionAuthorityPolicyStatus(
          ctx,
          matterId,
          String(claim?.id ?? ""),
        ),
      ),
      agent_finding_semantic_checks: semanticChecks,
      element_evidence_statuses: workspace.elements.map((element) =>
        deriveElementEvidenceStatus(
          String(element?.id ?? ""),
          workspace.element_facts as Array<Record<string, any>>,
          workspace.facts as Array<Record<string, any>>,
          citedFactIds,
        ),
      ),
    };
  }

  private normalizeDocumentDraftSections(value: unknown) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
      throw new LitigationValidationError(
        "Document draft sections must contain between 1 and 20 sections.",
      );
    }
    const seen = new Set<string>();
    const sections = value.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new LitigationValidationError("Document draft section is invalid.");
      }
      const section = item as Record<string, unknown>;
      const id = typeof section.id === "string" ? section.id.trim() : "";
      const heading =
        typeof section.heading === "string" ? section.heading.trim() : "";
      const body = typeof section.body === "string" ? section.body.trim() : "";
      if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id) || !heading || heading.length > 240) {
        throw new LitigationValidationError(
          "Document draft section id or heading is invalid.",
        );
      }
      if (body.length > 50_000) {
        throw new LitigationValidationError("Document draft section body is too long.");
      }
      if (seen.has(id)) {
        throw new LitigationValidationError("Document draft section ids must be unique.");
      }
      seen.add(id);
      return { id, heading, body };
    });
    if (sections.reduce((total, section) => total + section.body.length, 0) > 200_000) {
      throw new LitigationValidationError("Document draft body is too long.");
    }
    return sections;
  }

  private artifactSections(kind: string, content: Record<string, unknown>) {
    const section = (id: string, heading: string, value: unknown) => ({
      id,
      heading,
      body: renderLawyerReadablePlainText(value ?? []),
    });
    if (kind === "litigation_brief") {
      return this.normalizeDocumentDraftSections([
        section("procedural-posture", "Procedural Posture", content.proceduralPosture),
        section("material-facts", "Material Facts", content.materialFacts),
        section("issues", "Issues", content.issues),
        section("sources", "Sources", content.sources),
      ]);
    }
    if (kind === "hearing_plan") {
      return this.normalizeDocumentDraftSections([
        section("hearing-events", "Hearing Events", content.hearingEvents),
        section("issues-for-hearing", "Issues for Hearing", content.issuesForHearing),
        section("deadline-checklist", "Deadline Checklist", content.deadlineChecklist),
        section("sources", "Sources", content.sources),
      ]);
    }
    throw new LitigationValidationError("This artifact cannot seed a document draft.");
  }

  private artifactIntegrity(
    ctx: AletheiaUserContext,
    matterId: string,
    artifact: Record<string, any>,
  ) {
    const reasons: string[] = [];
    const content = parseJson(artifact.content);
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      reasons.push("artifact_content_invalid");
    } else if (sha256Json(content) !== artifact.content_hash) {
      reasons.push("artifact_content_hash_mismatch");
    }
    if (artifact.stale_at) reasons.push("artifact_marked_stale");
    if (!artifact.dependency_hash) reasons.push("artifact_dependency_hash_missing");
    try {
      const current = this.buildArtifact(
        ctx,
        matterId,
        artifact.kind as LitigationArtifactKind,
      );
      if (!current || current.dependencyHash !== artifact.dependency_hash) {
        reasons.push("artifact_dependency_hash_mismatch");
      }
    } catch {
      reasons.push("artifact_dependency_unavailable");
    }
    return {
      stale: reasons.length > 0,
      reasons,
      content: content as Record<string, unknown>,
    };
  }

  private documentDraftRow(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
  ) {
    return this.db
      .prepare(
        `select * from aletheia_litigation_document_drafts
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(documentId, matterId, ctx.userId) as Record<string, any> | undefined;
  }

  private documentDraftIntegrity(
    ctx: AletheiaUserContext,
    document: Record<string, any>,
  ) {
    const artifact = this.db
      .prepare(
        `select * from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ?
            and kind = ?`,
      )
      .get(
        document.artifact_id,
        document.matter_id,
        ctx.userId,
        document.artifact_kind,
      ) as Record<string, any> | undefined;
    if (!artifact) {
      return { stale: true, reasons: ["source_artifact_missing"] };
    }
    const integrity = this.artifactIntegrity(ctx, document.matter_id, artifact);
    if (artifact.content_hash !== document.source_content_hash) {
      integrity.reasons.push("locked_source_content_hash_mismatch");
    }
    if (artifact.dependency_hash !== document.source_dependency_hash) {
      integrity.reasons.push("locked_source_dependency_hash_mismatch");
    }
    integrity.stale = integrity.reasons.length > 0;
    return integrity;
  }

  private documentDraftProjection(
    ctx: AletheiaUserContext,
    document: Record<string, any>,
    includeVersions = true,
  ) {
    const integrity = this.documentDraftIntegrity(ctx, document);
    const versions = includeVersions
      ? (this.db
          .prepare(
            `select * from aletheia_litigation_document_draft_versions
              where document_id = ? and matter_id = ? and user_id = ?
              order by version asc`,
          )
          .all(document.id, document.matter_id, ctx.userId) as Array<Record<string, any>>
        ).map((version) => ({
          ...version,
          sections: parseJson(version.sections),
          provenance: parseJson(version.provenance),
        }))
      : undefined;
    const importAttempts = includeVersions
      ? (this.db
          .prepare(
            `select id, document_id, matter_id, user_id, base_version_id,
                    base_version, base_content_hash, original_filename,
                    file_sha256, file_bytes, parser_protocol, binding_hash,
                    status, failure_code, failure_detail, accepted_version_id,
                    actor_id, created_at
               from aletheia_litigation_document_draft_import_attempts
              where document_id = ? and matter_id = ? and user_id = ?
              order by created_at desc, rowid desc`,
          )
          .all(document.id, document.matter_id, ctx.userId) as Array<
          Record<string, unknown>
        >)
      : undefined;
    return {
      ...document,
      stale: integrity.stale,
      stale_reasons: integrity.reasons,
      ...(versions ? { versions } : {}),
      ...(importAttempts ? { import_attempts: importAttempts } : {}),
    };
  }

  private assertActiveFreshDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
  ) {
    const document = this.documentDraftRow(ctx, matterId, documentId);
    if (!document) return null;
    if (document.status !== "active") {
      throw new LitigationValidationError("The document draft has been withdrawn.");
    }
    const integrity = this.documentDraftIntegrity(ctx, document);
    if (integrity.stale) {
      throw new LitigationValidationError(
        `The document draft is stale: ${integrity.reasons.join(", ")}.`,
      );
    }
    return document;
  }

  createDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationDocumentDraftInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const artifact = this.db
      .prepare(
        `select * from aletheia_work_products
          where id = ? and matter_id = ? and user_id = ?
            and kind in ('litigation_brief', 'hearing_plan')`,
    )
      .get(input.artifactId, matterId, ctx.userId) as Record<string, any> | undefined;
    if (!artifact) return null;
    const latestArtifact = this.db
      .prepare(
        `select id from aletheia_work_products
          where matter_id = ? and user_id = ? and kind = ?
          order by version desc, created_at desc limit 1`,
      )
      .get(matterId, ctx.userId, artifact.kind) as { id: string } | undefined;
    if (!latestArtifact || latestArtifact.id !== artifact.id) {
      throw new LitigationValidationError(
        "The source artifact is not the latest version for this matter and kind.",
      );
    }
    const integrity = this.artifactIntegrity(ctx, matterId, artifact);
    if (integrity.stale) {
      throw new LitigationValidationError(
        `The source artifact is stale: ${integrity.reasons.join(", ")}.`,
      );
    }
    const timestamp = now();
    const documentId = randomUUID();
    const versionId = randomUUID();
    const sections = this.artifactSections(artifact.kind, integrity.content);
    const changeSummary = "Created from the current litigation artifact.";
    const contentHash = sha256Json({
      documentId,
      version: 1,
      parentVersionId: null,
      parentContentHash: null,
      sourceContentHash: artifact.content_hash,
      sourceDependencyHash: artifact.dependency_hash,
      sections,
      changeSummary,
    });
    const provenance = {
      schemaVersion: "aletheia-litigation-document-draft-v1",
      actor: "human",
      actorId: ctx.userId,
      source: "server_artifact_projection",
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      sourceContentHash: artifact.content_hash,
      sourceDependencyHash: artifact.dependency_hash,
    };
    this.db
      .prepare(
        `insert into aletheia_litigation_document_drafts (
          id, matter_id, user_id, artifact_id, artifact_kind, source_content_hash,
          source_dependency_hash, current_version_id, status, created_by, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(documentId, matterId, ctx.userId, artifact.id, artifact.kind, artifact.content_hash,
        artifact.dependency_hash, versionId, ctx.userId, timestamp, timestamp);
    this.db
      .prepare(
        `insert into aletheia_litigation_document_draft_versions (
          id, document_id, matter_id, user_id, version, parent_version_id,
          parent_content_hash, content_hash, sections, change_summary, provenance,
          created_by, created_at
        ) values (?, ?, ?, ?, 1, null, null, ?, ?, ?, ?, ?, ?)`,
      )
      .run(versionId, documentId, matterId, ctx.userId, contentHash, json(sections),
        changeSummary, json(provenance), ctx.userId, timestamp);
    return this.documentDraftProjection(ctx, this.documentDraftRow(ctx, matterId, documentId)!);
  }

  listDocumentDrafts(ctx: AletheiaUserContext, matterId: string) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const documents = this.db
      .prepare(
        `select * from aletheia_litigation_document_drafts
          where matter_id = ? and user_id = ? order by updated_at desc, created_at desc`,
      )
      .all(matterId, ctx.userId) as Array<Record<string, any>>;
    return documents.map((document) => this.documentDraftProjection(ctx, document, false));
  }

  getDocumentDraft(ctx: AletheiaUserContext, matterId: string, documentId: string) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const document = this.documentDraftRow(ctx, matterId, documentId);
    return document ? this.documentDraftProjection(ctx, document) : null;
  }

  appendDocumentDraftVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: AppendLitigationDocumentDraftVersionInput,
  ) {
    const document = this.assertActiveFreshDocumentDraft(ctx, matterId, documentId);
    if (!document) return null;
    const changeSummary = input.changeSummary.trim();
    if (changeSummary.length < 3 || changeSummary.length > 1_000) {
      throw new LitigationValidationError("changeSummary must be between 3 and 1000 characters.");
    }
    if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1) {
      throw new LitigationValidationError("baseVersion is invalid.");
    }
    const parent = this.db
      .prepare(
        `select * from aletheia_litigation_document_draft_versions
          where document_id = ? and matter_id = ? and user_id = ?
          order by version desc limit 1`,
      )
      .get(documentId, matterId, ctx.userId) as Record<string, any> | undefined;
    if (!parent || Number(parent.version) !== input.baseVersion) {
      throw new LitigationValidationError("Document version conflict; reload the latest version.");
    }
    const sections = this.normalizeDocumentDraftSections(input.sections);
    const parentSections = this.normalizeDocumentDraftSections(
      parseJson(parent.sections),
    );
    const parentSources = parentSections.find((section) => section.id === "sources");
    const nextSources = sections.find((section) => section.id === "sources");
    if (
      !parentSources ||
      !nextSources ||
      sha256Json(parentSources) !== sha256Json(nextSources)
    ) {
      throw new LitigationValidationError(
        "The sources section is read-only and must remain unchanged.",
      );
    }
    const version = Number(parent.version) + 1;
    const versionId = randomUUID();
    const timestamp = now();
    const contentHash = sha256Json({
      documentId,
      version,
      parentVersionId: parent.id,
      parentContentHash: parent.content_hash,
      sourceContentHash: document.source_content_hash,
      sourceDependencyHash: document.source_dependency_hash,
      sections,
      changeSummary,
    });
    const provenance = {
      schemaVersion: "aletheia-litigation-document-draft-v1",
      actor: "human",
      actorId: ctx.userId,
      source: "server_authenticated_edit",
      baseVersion: input.baseVersion,
    };
    this.db
      .prepare(
        `insert into aletheia_litigation_document_draft_versions (
          id, document_id, matter_id, user_id, version, parent_version_id,
          parent_content_hash, content_hash, sections, change_summary, provenance,
          created_by, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(versionId, documentId, matterId, ctx.userId, version, parent.id,
        parent.content_hash, contentHash, json(sections), changeSummary, json(provenance),
        ctx.userId, timestamp);
    this.db.prepare(
      `update aletheia_litigation_document_drafts
          set current_version_id = ?, updated_at = ?
        where id = ? and matter_id = ? and user_id = ?`,
    ).run(versionId, timestamp, documentId, matterId, ctx.userId);
    return this.documentDraftProjection(ctx, this.documentDraftRow(ctx, matterId, documentId)!);
  }

  documentDraftRoundTripContext(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    versionId?: string,
    requireFresh = false,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const document = requireFresh
      ? this.assertActiveFreshDocumentDraft(ctx, matterId, documentId)
      : this.documentDraftRow(ctx, matterId, documentId);
    if (!document) return null;
    const version = this.db
      .prepare(
        `select * from aletheia_litigation_document_draft_versions
          where id = coalesce(?, ?) and document_id = ? and matter_id = ? and user_id = ?`,
      )
      .get(versionId ?? null, document.current_version_id, documentId, matterId, ctx.userId) as
      | Record<string, any>
      | undefined;
    if (!version) return null;
    return {
      document,
      version: {
        ...version,
        sections: this.normalizeDocumentDraftSections(parseJson(version.sections)),
        provenance: parseJson(version.provenance),
      } as Record<string, any>,
    };
  }

  appendImportedDocumentDraftVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: {
      baseVersionId: string;
      baseVersion: number;
      changeSummary: string;
      sections: Array<{ id: string; heading: string; body: string }>;
      fileSha256: string;
      originalFilename: string;
      parserProtocol: string;
      bindingHash: string;
    },
  ) {
    const context = this.documentDraftRoundTripContext(
      ctx,
      matterId,
      documentId,
      undefined,
      true,
    );
    if (!context) return null;
    const { document, version: parent } = context;
    if (
      parent.id !== input.baseVersionId ||
      Number(parent.version) !== input.baseVersion ||
      document.current_version_id !== input.baseVersionId
    ) {
      throw new LitigationValidationError(
        "Document version conflict; export and edit the latest version.",
      );
    }
    const changeSummary = input.changeSummary.trim();
    if (changeSummary.length < 3 || changeSummary.length > 1_000) {
      throw new LitigationValidationError(
        "changeSummary must be between 3 and 1000 characters.",
      );
    }
    const sections = this.normalizeDocumentDraftSections(input.sections);
    const parentSources = parent.sections.find(
      (section: { id: string }) => section.id === "sources",
    );
    const nextSources = sections.find((section) => section.id === "sources");
    if (!parentSources || !nextSources || sha256Json(parentSources) !== sha256Json(nextSources)) {
      throw new LitigationValidationError(
        "The sources section is read-only and must remain unchanged.",
      );
    }
    const nextVersion = Number(parent.version) + 1;
    const versionId = randomUUID();
    const timestamp = now();
    const contentHash = sha256Json({
      documentId,
      version: nextVersion,
      parentVersionId: parent.id,
      parentContentHash: parent.content_hash,
      sourceContentHash: document.source_content_hash,
      sourceDependencyHash: document.source_dependency_hash,
      sections,
      changeSummary,
    });
    const provenance = {
      schemaVersion: "aletheia-litigation-document-draft-v1",
      actor: "human",
      actorId: ctx.userId,
      source: "external_docx_import",
      baseVersion: input.baseVersion,
      baseVersionId: input.baseVersionId,
      originalFilename: input.originalFilename,
      fileSha256: input.fileSha256,
      parserProtocol: input.parserProtocol,
      bindingHash: input.bindingHash,
    };
    this.db
      .prepare(
        `insert into aletheia_litigation_document_draft_versions (
          id, document_id, matter_id, user_id, version, parent_version_id,
          parent_content_hash, content_hash, sections, change_summary, provenance,
          created_by, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        documentId,
        matterId,
        ctx.userId,
        nextVersion,
        parent.id,
        parent.content_hash,
        contentHash,
        json(sections),
        changeSummary,
        json(provenance),
        ctx.userId,
        timestamp,
      );
    this.db
      .prepare(
        `update aletheia_litigation_document_drafts
            set current_version_id = ?, updated_at = ?
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .run(versionId, timestamp, documentId, matterId, ctx.userId);
    return {
      document: this.documentDraftProjection(
        ctx,
        this.documentDraftRow(ctx, matterId, documentId)!,
      ),
      versionId,
      version: nextVersion,
      contentHash,
    };
  }

  recordDocumentDraftImportAttempt(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: {
      id: string;
      baseVersionId: string | null;
      baseVersion: number | null;
      baseContentHash: string | null;
      originalFilename: string;
      fileSha256: string;
      fileBytes: number;
      parserProtocol: string;
      bindingHash: string | null;
      status: "accepted" | "rejected";
      failureCode: string | null;
      failureDetail: string | null;
      acceptedVersionId: string | null;
      storagePath: string | null;
    },
  ) {
    const document = this.documentDraftRow(ctx, matterId, documentId);
    if (!document) return null;
    this.db
      .prepare(
        `insert into aletheia_litigation_document_draft_import_attempts (
          id, document_id, matter_id, user_id, base_version_id, base_version,
          base_content_hash, original_filename, file_sha256, file_bytes,
          parser_protocol, binding_hash, status, failure_code, failure_detail,
          accepted_version_id, storage_path, actor_id, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        documentId,
        matterId,
        ctx.userId,
        input.baseVersionId,
        input.baseVersion,
        input.baseContentHash,
        input.originalFilename,
        input.fileSha256,
        input.fileBytes,
        input.parserProtocol,
        input.bindingHash,
        input.status,
        input.failureCode,
        input.failureDetail,
        input.acceptedVersionId,
        input.storagePath,
        ctx.userId,
        now(),
      );
    return input.id;
  }

  diffDocumentDraftVersions(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    fromVersion: number,
    toVersion: number,
  ) {
    const document = this.documentDraftRow(ctx, matterId, documentId);
    if (!document) return null;
    const projection = this.documentDraftProjection(ctx, document, false);
    const versions = this.db.prepare(
      `select * from aletheia_litigation_document_draft_versions
        where document_id = ? and matter_id = ? and user_id = ? and version in (?, ?)`,
    ).all(documentId, matterId, ctx.userId, fromVersion, toVersion) as Array<Record<string, any>>;
    const from = versions.find((item) => Number(item.version) === fromVersion);
    const to = versions.find((item) => Number(item.version) === toVersion);
    if (!from || !to) return null;
    const oldSections = this.normalizeDocumentDraftSections(parseJson(from.sections));
    const newSections = this.normalizeDocumentDraftSections(parseJson(to.sections));
    const oldById = new Map(oldSections.map((section) => [section.id, section]));
    const newById = new Map(newSections.map((section) => [section.id, section]));
    const ids = [...new Set([...oldById.keys(), ...newById.keys()])].sort();
    return {
      document: projection,
      from_version: fromVersion,
      to_version: toVersion,
      changes: ids.map((id) => {
        const oldSection = oldById.get(id);
        const newSection = newById.get(id);
        const oldHash = oldSection ? sha256Json(oldSection) : null;
        const newHash = newSection ? sha256Json(newSection) : null;
        return {
          id,
          status: !oldSection ? "added" : !newSection ? "removed" : oldHash === newHash ? "unchanged" : "modified",
          old_hash: oldHash,
          new_hash: newHash,
          old_section: oldSection ?? null,
          new_section: newSection ?? null,
        };
      }),
    };
  }

  reviewDocumentDraftVersion(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    versionId: string,
    input: ReviewLitigationDocumentDraftVersionInput,
  ) {
    const document = this.assertActiveFreshDocumentDraft(ctx, matterId, documentId);
    if (!document) return null;
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new LitigationValidationError("Document review decision is invalid.");
    }
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 2_000) {
      throw new LitigationValidationError("Review reason must be between 10 and 2000 characters.");
    }
    const version = this.db.prepare(
      `select * from aletheia_litigation_document_draft_versions
        where id = ? and document_id = ? and matter_id = ? and user_id = ?`,
    ).get(versionId, documentId, matterId, ctx.userId) as Record<string, any> | undefined;
    if (!version) return null;
    if (version.id !== document.current_version_id) {
      throw new LitigationValidationError("Only the latest document version can be reviewed.");
    }
    if (version.review_status !== "unreviewed") {
      throw new LitigationValidationError("Document version review is immutable.");
    }
    if (input.decision === "approved") {
      const artifact = this.db
        .prepare(
          `select validation_errors from aletheia_work_products
            where id = ? and matter_id = ? and user_id = ? and kind = ?`,
        )
        .get(
          document.artifact_id,
          matterId,
          ctx.userId,
          document.artifact_kind,
        ) as { validation_errors?: unknown } | undefined;
      const validationErrors = artifact ? parseJson(artifact.validation_errors) : null;
      if (!Array.isArray(validationErrors) || validationErrors.length > 0) {
        throw new LitigationValidationError(
          "The source artifact has unresolved validation errors and cannot be approved.",
        );
      }
    }
    const changed = this.db.prepare(
      `update aletheia_litigation_document_draft_versions
          set review_status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ?
        where id = ? and document_id = ? and matter_id = ? and user_id = ?
          and review_status = 'unreviewed'`,
    ).run(input.decision, reason, ctx.userId, now(), versionId, documentId, matterId, ctx.userId);
    if (Number(changed.changes ?? 0) !== 1) {
      throw new LitigationValidationError("Document version review is immutable.");
    }
    return this.documentDraftProjection(ctx, this.documentDraftRow(ctx, matterId, documentId)!);
  }

  withdrawDocumentDraft(
    ctx: AletheiaUserContext,
    matterId: string,
    documentId: string,
    input: WithdrawLitigationDocumentDraftInput,
  ) {
    const document = this.documentDraftRow(ctx, matterId, documentId);
    if (!document) return null;
    if (document.status !== "active") {
      throw new LitigationValidationError("The document draft has been withdrawn.");
    }
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 2_000) {
      throw new LitigationValidationError("Withdrawal reason must be between 3 and 2000 characters.");
    }
    const timestamp = now();
    this.db.prepare(
      `update aletheia_litigation_document_drafts
          set status = 'withdrawn', withdrawn_by = ?, withdrawn_at = ?,
              withdrawal_reason = ?, updated_at = ?
        where id = ? and matter_id = ? and user_id = ? and status = 'active'`,
    ).run(ctx.userId, timestamp, reason, timestamp, documentId, matterId, ctx.userId);
    return this.documentDraftProjection(ctx, this.documentDraftRow(ctx, matterId, documentId)!);
  }

  buildArtifact(
    ctx: AletheiaUserContext,
    matterId: string,
    kind: LitigationArtifactKind,
  ) {
    const workspace = this.getWorkspace(ctx, matterId) as Record<
      string,
      Array<Record<string, any>>
    > | null;
    if (!workspace) return null;
    this.assertLegalAssessmentIntegrity(workspace);
    const litigationProfile = (workspace.profile ?? {}) as Record<string, any>;
    const exhibitPrefix = String(
      litigationProfile.exhibit_prefix ?? "EX",
    ).toUpperCase();
    const exhibitStart = Number(litigationProfile.exhibit_start ?? 1);
    const paginationPolicy = String(
      litigationProfile.pagination_policy ?? "auto",
    );
    const bundleProfile = {
      organizationName: litigationProfile.organization_name ?? null,
      court: litigationProfile.court ?? null,
      caseNumber: litigationProfile.case_number ?? null,
      exhibitPrefix,
      exhibitStart,
      paginationPolicy,
      documentTemplateId:
        litigationProfile.document_template_id ??
        DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
      documentTemplateVersion: Number(
        litigationProfile.document_template_version ??
          DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
      ),
    };
    const documentTemplate = this.documentTemplate(
      ctx,
      matterId,
      String(bundleProfile.documentTemplateId),
      Number(bundleProfile.documentTemplateVersion),
    );
    if (!documentTemplate || documentTemplate.status !== "approved") {
      throw new LitigationValidationError(
        "The selected document template is unavailable or not approved.",
      );
    }
    const sourceRows = this.db
      .prepare(
        `select s.*, c.text as current_chunk_text,
                c.metadata as current_chunk_metadata
           from aletheia_source_spans s
           join aletheia_document_chunks c
             on c.id = s.source_chunk_id
            and c.matter_id = s.matter_id and c.user_id = s.user_id
          where s.matter_id = ? and s.user_id = ?
          order by s.created_at asc`,
      )
      .all(matterId, ctx.userId) as Array<Record<string, any>>;
    const documentRows: Array<Record<string, any>> = (
      this.db
        .prepare(
          `select * from aletheia_matter_documents
            where matter_id = ? and user_id = ?
            order by rowid asc`,
        )
        .all(matterId, ctx.userId) as Array<Record<string, any>>
    ).map(
      (item): Record<string, any> => ({
        ...item,
        metadata: parseJson(item.metadata),
      }),
    );
    const invalidSources = sourceRows.filter(
      (source) => !this.sourceSpanIntegrity(source),
    );
    if (invalidSources.length) {
      throw new LitigationValidationError(
        `Source integrity check failed for ${invalidSources.length} source span(s).`,
      );
    }

    const confirmedFacts = workspace.facts.filter(
      (item) => item.status === "confirmed",
    );
    const confirmedFactIds = new Set(confirmedFacts.map((item) => item.id));
    const citedConfirmedFactIds = new Set(
      workspace.fact_sources
        .filter((source) => confirmedFactIds.has(source.fact_id))
        .map((source) => source.fact_id),
    );
    const openReviews = workspace.position_reviews.filter(
      (item) => item.status === "open",
    );
    const claimsUnderReview = new Set(openReviews.map((item) => item.claim_id));
    const confirmedClaims = workspace.claims.filter(
      (item) => item.status === "confirmed" && !claimsUnderReview.has(item.id),
    );
    const confirmedClaimIds = new Set(confirmedClaims.map((item) => item.id));
    const elements = workspace.elements.filter(
      (item) =>
        confirmedClaimIds.has(item.claim_id) && item.status === "confirmed",
    );
    const elementIds = new Set(elements.map((item) => item.id));
    const elementFacts = workspace.element_facts.filter(
      (item) =>
        elementIds.has(item.element_id) &&
        confirmedFactIds.has(item.fact_id) &&
        citedConfirmedFactIds.has(item.fact_id),
    );
    const confirmedEvents = workspace.procedural_events.filter(
      (item) => item.status === "confirmed",
    );
    const confirmedDeadlines = workspace.deadlines.filter(
      (item) => item.status === "confirmed" || item.status === "completed",
    );
    const sourceSpanIds = new Set<string>();
    for (const source of workspace.fact_sources) {
      if (confirmedFactIds.has(source.fact_id))
        sourceSpanIds.add(source.source_span_id);
    }
    const claimSources = workspace.claim_sources.filter((item) =>
      confirmedClaimIds.has(item.claim_id),
    );
    for (const source of claimSources) {
      sourceSpanIds.add(source.source_span_id);
    }
    for (const item of [...confirmedEvents, ...confirmedDeadlines]) {
      if (item.primary_source_span_id)
        sourceSpanIds.add(item.primary_source_span_id);
    }
    const sources: Array<Record<string, any>> = sourceRows
      .filter((item) => sourceSpanIds.has(String(item.id)))
      .map((item) => ({
        id: item.id,
        documentId: item.document_id,
        documentName: item.document_name,
        page: item.page,
        section: item.section,
        quote: item.quote,
        quoteSha256: item.quote_sha256,
        sourceChunkSha256: item.source_chunk_sha256,
        documentQuoteStart: item.document_quote_start,
        documentQuoteEnd: item.document_quote_end,
      }));
    const authorityById = new Map(
      workspace.legal_authority_versions.map((authority) => [
        String(authority.id),
        authority,
      ]),
    );
    const activePositionAuthorities = workspace.position_authorities.filter(
      (link) =>
        link.status === "active" && confirmedClaimIds.has(link.claim_id),
    );
    const verifiedPositionAuthorities = activePositionAuthorities.map(
      (link): Record<string, any> => {
        const authority = authorityById.get(String(link.authority_version_id));
        const content = String(authority?.content ?? "");
        const contentSha256 = createHash("sha256")
          .update(content)
          .digest("hex");
        const quote = String(link.exact_quote ?? "");
        const quoteSha256 = createHash("sha256").update(quote).digest("hex");
        const applicabilityDate = String(link.applicability_date ?? "");
        if (
          !authority ||
          authority.status !== "verified" ||
          contentSha256 !== authority.content_sha256 ||
          quoteSha256 !== link.quote_sha256 ||
          !content.includes(quote) ||
          applicabilityDate < String(authority.effective_from) ||
          (authority.effective_to &&
            applicabilityDate > String(authority.effective_to))
        ) {
          throw new LitigationValidationError(
            `Legal authority integrity or effective-date validation failed for position ${String(link.claim_id)}.`,
          );
        }
        return {
          ...link,
          sourceId: `legal-authority:${String(link.id)}`,
          authority: {
            id: authority.id,
            jurisdiction: authority.jurisdiction,
            authorityType: authority.authority_type,
            title: authority.title,
            issuer: authority.issuer,
            officialIdentifier: authority.official_identifier,
            versionLabel: authority.version_label,
            sourceReference: authority.source_reference,
            contentSha256: authority.content_sha256,
            effectiveFrom: authority.effective_from,
            effectiveTo: authority.effective_to,
            verifiedBy: authority.verified_by,
            verifiedAt: authority.verified_at,
          },
        };
      },
    );
    const legalAuthoritySources = verifiedPositionAuthorities.map((link) => ({
      id: link.sourceId,
      kind: "verified_legal_authority",
      claimId: link.claim_id,
      authorityVersionId: link.authority_version_id,
      title: link.authority.title,
      officialIdentifier: link.authority.officialIdentifier,
      versionLabel: link.authority.versionLabel,
      sourceReference: link.authority.sourceReference,
      applicabilityDate: link.applicability_date,
      provisionReference: link.provision_reference,
      quote: link.exact_quote,
      quoteSha256: link.quote_sha256,
      authorityContentSha256: link.authority.contentSha256,
    }));
    sources.push(...legalAuthoritySources);
    const factSources = workspace.fact_sources.filter((item) =>
      confirmedFactIds.has(item.fact_id),
    );
    const matrix: Array<Record<string, any>> = confirmedClaims.map((claim) => {
      const claimElements: Array<Record<string, any>> = elements
        .filter((element) => element.claim_id === claim.id)
        .map((element) => {
          const evidenceStatus = workspace.element_evidence_statuses.find(
            (status) => status.element_id === element.id,
          ) ?? { status: "gap" };
          const links = elementFacts
            .filter((link) => link.element_id === element.id)
            .map((link) => ({
              ...link,
              fact: confirmedFacts.find((fact) => fact.id === link.fact_id),
              sources: factSources.filter(
                (source) => source.fact_id === link.fact_id,
              ),
            }));
          return {
            ...element,
            links,
            evidenceStatus,
            gap: ["gap", "pending_review", "needs_source"].includes(
              evidenceStatus.status,
            ),
          };
        });
      return {
        ...claim,
        sources: claimSources.filter((source) => source.claim_id === claim.id),
        legalAuthorities: verifiedPositionAuthorities.filter(
          (link) => link.claim_id === claim.id,
        ),
        elements: claimElements,
      };
    });
    const citedClaimIds = new Set(claimSources.map((item) => item.claim_id));
    const uncitedLegalPositions = confirmedClaims
      .filter((claim) => !citedClaimIds.has(claim.id))
      .map((claim) => ({
        claimId: claim.id,
        kind: claim.kind,
        title: claim.title,
        warning: "Confirmed legal position has no exact source citation.",
      }));
    const verifiedAuthorityClaimIds = new Set(
      verifiedPositionAuthorities.map((item) => item.claim_id),
    );
    const missingLegalAuthorityPositions = confirmedClaims
      .filter((claim) => !verifiedAuthorityClaimIds.has(claim.id))
      .map((claim) => ({
        claimId: claim.id,
        kind: claim.kind,
        title: claim.title,
        warning:
          "Confirmed legal position has no active verified exact-quote authority.",
      }));
    const gaps = matrix.flatMap((claim) =>
      claim.elements
        .filter((element: Record<string, any>) => element.gap)
        .map((element: Record<string, any>) => ({
          claimId: claim.id,
          elementId: element.id,
          title: element.title,
          evidenceStatus: element.evidenceStatus.status,
        })),
    );
    const hearingEvents = confirmedEvents.filter((item) =>
      String(item.event_type).includes("hearing"),
    );
    const sourceDocumentIds = new Set(
      sources.map((source) => String(source.documentId)),
    );
    const hearingBundleEntries = documentRows
      .filter((document) => sourceDocumentIds.has(String(document.id)))
      .map((document, index) => {
        const metadata = document.metadata as Record<string, unknown>;
        const parserMetadata =
          metadata.parserMetadata &&
          typeof metadata.parserMetadata === "object" &&
          !Array.isArray(metadata.parserMetadata)
            ? (metadata.parserMetadata as Record<string, unknown>)
            : {};
        const pageCountCandidate =
          metadata.pageCount ?? parserMetadata.pageCount ?? null;
        const pageCount =
          typeof pageCountCandidate === "number" &&
          Number.isSafeInteger(pageCountCandidate) &&
          pageCountCandidate > 0
            ? pageCountCandidate
            : null;
        const references = sources
          .filter((source) => source.documentId === document.id)
          .map((source) => ({
            sourceSpanId: source.id,
            page: source.page,
            section: source.section,
            quote: source.quote,
          }));
        return {
          exhibitNumber: `${exhibitPrefix}-${String(exhibitStart + index).padStart(3, "0")}`,
          documentId: document.id,
          documentName: document.name,
          documentType: document.document_type,
          parsedStatus: document.parsed_status,
          pageCount,
          originalSha256:
            typeof metadata.originalSha256 === "string"
              ? metadata.originalSha256
              : null,
          referenceCount: references.length,
          references,
        };
      });
    const hasUnifiedPageMap =
      paginationPolicy === "auto" &&
      hearingBundleEntries.length > 0 &&
      hearingBundleEntries.every((entry) => entry.pageCount !== null);
    let nextBundlePage = 1;
    const paginatedHearingBundleEntries = hearingBundleEntries.map((entry) => {
      if (!hasUnifiedPageMap || entry.pageCount === null) {
        return { ...entry, bundlePageStart: null, bundlePageEnd: null };
      }
      const bundlePageStart = nextBundlePage;
      const bundlePageEnd = bundlePageStart + entry.pageCount - 1;
      nextBundlePage = bundlePageEnd + 1;
      return { ...entry, bundlePageStart, bundlePageEnd };
    });
    const bundlePagination = hasUnifiedPageMap
      ? {
          mode: "continuous_source_sequence",
          totalPages: nextBundlePage - 1,
          warning:
            "Page ranges sequence native source pages; source files are not rewritten.",
        }
      : {
          mode: "source_native_only",
          totalPages: null,
          warning:
            "Continuous bundle pagination is unavailable because at least one source has no trustworthy page count.",
        };
    const hearingBundleErrors = [
      ...(hearingEvents.length
        ? []
        : [
            {
              code: "hearing_event_missing",
              message:
                "No confirmed hearing event is available for the bundle index.",
            },
          ]),
      ...hearingBundleEntries.flatMap((entry) => [
        ...(entry.originalSha256
          ? []
          : [
              {
                code: "bundle_source_hash_missing",
                message: `Original file hash is missing: ${String(entry.documentName)}`,
                documentId: entry.documentId,
              },
            ]),
        ...(entry.parsedStatus === "parsed"
          ? []
          : [
              {
                code: "bundle_source_not_parsed",
                message: `Source is not fully parsed: ${String(entry.documentName)}`,
                documentId: entry.documentId,
              },
            ]),
      ]),
    ];
    const dependencyPayloadByKind: Record<
      LitigationArtifactKind,
      Record<string, unknown>
    > = {
      evidence_catalog: {
        facts: confirmedFacts,
        factSources,
        openReviews,
        uncitedLegalPositions,
        missingLegalAuthorityPositions,
        sources,
      },
      claim_defense_matrix: {
        positions: matrix,
        claimSources,
        openReviews,
        uncitedLegalPositions,
        missingLegalAuthorityPositions,
        sources,
      },
      procedural_clock: {
        events: confirmedEvents,
        deadlines: confirmedDeadlines,
        openReviews,
        uncitedLegalPositions,
        missingLegalAuthorityPositions,
        sources,
      },
      litigation_brief: {
        issues: matrix,
        claimSources,
        openReviews,
        uncitedLegalPositions,
        missingLegalAuthorityPositions,
        materialFacts: confirmedFacts,
        proceduralPosture: confirmedEvents,
        sources,
      },
      hearing_plan: {
        hearingEvents,
        issuesForHearing: matrix,
        claimSources,
        openReviews,
        uncitedLegalPositions,
        missingLegalAuthorityPositions,
        deadlineChecklist: confirmedDeadlines,
        sources,
      },
      hearing_bundle_index: {
        bundleProfile,
        hearingEvents,
        hearingBundleEntries: paginatedHearingBundleEntries,
        bundlePagination,
        issuesForHearing: matrix,
        openReviews,
        uncitedLegalPositions,
        missingLegalAuthorityPositions,
        sources,
      },
    };
    const dependencyHash = `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          documentTemplate: {
            id: documentTemplate.id,
            version: documentTemplate.version,
            templateHash: documentTemplate.templateHash,
          },
          documentProfile: bundleProfile,
          state: dependencyPayloadByKind[kind],
        }),
      )
      .digest("hex")}`;
    const base = {
      schemaVersion: "aletheia-litigation-artifact-v1",
      kind,
      matterId,
      generatedAt: now(),
      statePolicy: "confirmed_only",
      sourceIntegrity: "verified",
      sourcePolicy:
        "Exact source spans are hash-verified; uncited confirmed legal positions are explicitly warned and never represented as cited.",
      unresolvedPositionReviews: openReviews.length,
      uncitedLegalPositions,
      missingLegalAuthorityPositions,
      dependencyHash,
      documentTemplate: {
        id: documentTemplate.id,
        version: documentTemplate.version,
        name: documentTemplate.name,
        templateHash: documentTemplate.templateHash,
        source: documentTemplate.source,
      },
      documentProfile: bundleProfile,
      sources,
    };
    const contentByKind: Record<
      LitigationArtifactKind,
      Record<string, unknown>
    > = {
      evidence_catalog: { ...base, facts: confirmedFacts, factSources },
      claim_defense_matrix: {
        ...base,
        positions: matrix,
        claimSources,
        gaps,
      },
      procedural_clock: {
        ...base,
        events: confirmedEvents,
        deadlines: confirmedDeadlines,
      },
      litigation_brief: {
        ...base,
        issues: matrix,
        claimSources,
        materialFacts: confirmedFacts,
        proceduralPosture: confirmedEvents,
        requestedNextActions: gaps.map(
          (gap) => `Resolve evidence gap: ${gap.title}`,
        ),
      },
      hearing_plan: {
        ...base,
        hearingEvents,
        issuesForHearing: matrix,
        claimSources,
        deadlineChecklist: confirmedDeadlines,
        evidenceGaps: gaps,
      },
      hearing_bundle_index: {
        ...base,
        bundleProfile,
        status: hearingBundleErrors.length ? "not_ready" : "ready_for_review",
        hearingEvents,
        hearingBundleEntries: paginatedHearingBundleEntries,
        bundlePagination,
        issueCount: matrix.length,
        evidenceGapCount: gaps.length,
        notice:
          "This is a verified bundle index, not a merged court filing bundle.",
      },
    };
    return {
      content: contentByKind[kind],
      dependencyHash,
      validationErrors: [
        ...gaps.map((gap) => ({
          code:
            gap.evidenceStatus === "pending_review"
              ? "evidence_pending_review"
              : gap.evidenceStatus === "needs_source"
                ? "evidence_source_missing"
                : "evidence_gap",
          message:
            gap.evidenceStatus === "pending_review"
              ? `Linked facts remain unconfirmed for element: ${gap.title}`
              : gap.evidenceStatus === "needs_source"
                ? `Confirmed linked facts lack an exact source for element: ${gap.title}`
                : `No confirmed cited fact is linked to element: ${gap.title}`,
          ...gap,
        })),
        ...(kind === "hearing_bundle_index" ? hearingBundleErrors : []),
        ...missingLegalAuthorityPositions.map((position) => ({
          code: "verified_legal_authority_missing",
          message: `No active verified exact-quote authority is linked to position: ${position.title}`,
          ...position,
        })),
      ],
    };
  }

  buildAgentSnapshot(ctx: AletheiaUserContext, matterId: string) {
    const brief = this.buildArtifact(ctx, matterId, "litigation_brief");
    const evidence = this.buildArtifact(ctx, matterId, "evidence_catalog");
    const clock = this.buildArtifact(ctx, matterId, "procedural_clock");
    if (!brief || !evidence || !clock) return null;

    const briefContent = brief.content as Record<string, any>;
    const evidenceContent = evidence.content as Record<string, any>;
    const clockContent = clock.content as Record<string, any>;
    const factSources = Array.isArray(evidenceContent.factSources)
      ? evidenceContent.factSources
      : [];
    const citedFactIds = new Set(
      factSources.map((item: Record<string, any>) => item.fact_id),
    );
    const confirmedFacts = Array.isArray(evidenceContent.facts)
      ? evidenceContent.facts
      : [];
    const citedFacts = confirmedFacts.filter((fact: Record<string, any>) =>
      citedFactIds.has(fact.id),
    );
    const projectedPositions = Array.isArray(briefContent.issues)
      ? briefContent.issues
      : [];
    const citedPositions = projectedPositions.filter(
      (position: Record<string, any>) =>
        Array.isArray(position.sources) &&
        position.sources.length > 0 &&
        Array.isArray(position.legalAuthorities) &&
        position.legalAuthorities.length > 0,
    );
    const events = Array.isArray(clockContent.events)
      ? clockContent.events
      : [];
    const deadlines = Array.isArray(clockContent.deadlines)
      ? clockContent.deadlines
      : [];
    const allowedSourceIds = new Set<string>();
    for (const relation of factSources) {
      if (citedFactIds.has(relation.fact_id) && relation.source_span_id) {
        allowedSourceIds.add(String(relation.source_span_id));
      }
    }
    for (const position of citedPositions) {
      for (const relation of Array.isArray(position.sources)
        ? position.sources
        : []) {
        if (relation.source_span_id)
          allowedSourceIds.add(String(relation.source_span_id));
      }
      for (const authority of Array.isArray(position.legalAuthorities)
        ? position.legalAuthorities
        : []) {
        if (authority.sourceId)
          allowedSourceIds.add(String(authority.sourceId));
      }
    }
    for (const item of [...events, ...deadlines]) {
      if (item.primary_source_span_id)
        allowedSourceIds.add(String(item.primary_source_span_id));
    }
    const stableState = {
      schemaVersion: "aletheia-litigation-agent-snapshot-v1",
      matterId,
      statePolicy: "confirmed_cited_no_open_review",
      sourceIntegrity: "verified",
      artifactDependencyHashes: {
        litigationBrief: brief.dependencyHash,
        evidenceCatalog: evidence.dependencyHash,
        proceduralClock: clock.dependencyHash,
      },
      facts: citedFacts,
      factSources: factSources.filter((item: Record<string, any>) =>
        citedFactIds.has(item.fact_id),
      ),
      positions: citedPositions,
      events,
      deadlines,
      sources: Array.isArray(briefContent.sources)
        ? briefContent.sources.filter((source: Record<string, any>) =>
            allowedSourceIds.has(String(source.id)),
          )
        : [],
      evidenceGaps: brief.validationErrors,
      exclusions: {
        uncitedFacts: confirmedFacts.length - citedFacts.length,
        uncitedPositions: projectedPositions.length - citedPositions.length,
        positionsMissingVerifiedAuthority: Array.isArray(
          briefContent.missingLegalAuthorityPositions,
        )
          ? briefContent.missingLegalAuthorityPositions.length
          : 0,
        openPositionReviews: Number(
          briefContent.unresolvedPositionReviews ?? 0,
        ),
      },
    };
    const stateHash = `sha256:${createHash("sha256")
      .update(JSON.stringify(stableState))
      .digest("hex")}`;
    const content = {
      ...stableState,
      generatedAt: now(),
      stateHash,
    };
    return {
      ...content,
      snapshotHash: `sha256:${createHash("sha256")
        .update(JSON.stringify(content))
        .digest("hex")}`,
    };
  }

  runEvalSuite(ctx: AletheiaUserContext, matterId: string) {
    const workspace = this.getWorkspace(ctx, matterId) as Record<
      string,
      Array<Record<string, any>>
    > | null;
    if (!workspace) return null;
    const factSources = new Set(
      workspace.fact_sources.map((item) => item.fact_id),
    );
    const confirmedFacts = workspace.facts.filter(
      (item) => item.status === "confirmed",
    );
    const confirmedClaims = workspace.claims.filter(
      (item) => item.status === "confirmed",
    );
    const openReviewedClaimIds = new Set(
      workspace.position_reviews
        .filter((item) => item.status === "open")
        .map((item) => item.claim_id),
    );
    const projectedClaims = confirmedClaims.filter(
      (item) => !openReviewedClaimIds.has(item.id),
    );
    const claimIds = new Set(projectedClaims.map((item) => item.id));
    const elements = workspace.elements.filter(
      (item) => claimIds.has(item.claim_id) && item.status === "confirmed",
    );
    const confirmedFactIds = new Set(confirmedFacts.map((item) => item.id));
    const linkedElements = new Set(
      workspace.element_facts
        .filter(
          (item) =>
            confirmedFactIds.has(item.fact_id) && factSources.has(item.fact_id),
        )
        .map((item) => item.element_id),
    );
    const confirmedDeadlines = workspace.deadlines.filter(
      (item) => item.status === "confirmed" || item.status === "completed",
    );
    const sourceRows = this.db
      .prepare(
        `select s.*, c.text as current_chunk_text,
                c.metadata as current_chunk_metadata
           from aletheia_source_spans s
           join aletheia_document_chunks c
             on c.id = s.source_chunk_id
            and c.matter_id = s.matter_id and c.user_id = s.user_id
          where s.matter_id = ? and s.user_id = ?`,
      )
      .all(matterId, ctx.userId) as Array<Record<string, any>>;
    const sourceIntegrity = sourceRows.every((source) =>
      this.sourceSpanIntegrity(source),
    );
    const exportBindings = this.db
      .prepare(
        `select e.gate_authorization_status, e.approval_checkpoint_id,
                  e.created_at,
                  e.metadata, c.status as checkpoint_status,
                  c.decision as checkpoint_decision,
                  c.checkpoint_type, c.requested_payload
             from aletheia_exports e
             left join aletheia_human_checkpoints c
               on c.id = e.approval_checkpoint_id and c.matter_id = e.matter_id
            where e.matter_id = ? and e.export_type = 'litigation_artifact'`,
      )
      .all(matterId) as Array<Record<string, any>>;
    const exportsAuthorized = exportBindings.every((item) => {
      const metadata = parseJson(item.metadata) as Record<string, unknown>;
      const requested = parseJson(item.requested_payload) as Record<
        string,
        unknown
      >;
      return (
        item.gate_authorization_status === "approved" &&
        item.checkpoint_status === "approved" &&
        item.checkpoint_decision === "approved" &&
        item.checkpoint_type === "litigation_artifact_export" &&
        requested.workProductId === metadata.workProductId &&
        Number(requested.version) === Number(metadata.version) &&
        requested.contentHash === metadata.contentHash
      );
    });
    const staleWorkProducts = this.db
      .prepare(
        `select id, stale_at from aletheia_work_products
          where matter_id = ? and user_id = ? and stale_at is not null`,
      )
      .all(matterId, ctx.userId) as Array<{
      id: string;
      stale_at: string;
    }>;
    const staleAtByWorkProductId = new Map(
      staleWorkProducts.map((item) => [item.id, item.stale_at]),
    );
    const staleArtifactsNotExported = exportBindings.every((item) => {
      const metadata = parseJson(item.metadata) as Record<string, unknown>;
      if (typeof metadata.workProductId !== "string") return false;
      const staleAt = staleAtByWorkProductId.get(metadata.workProductId);
      return !staleAt || Date.parse(item.created_at) <= Date.parse(staleAt);
    });
    const projectedElementIds = new Set(elements.map((item) => item.id));
    const unconfirmedElementsExcluded = workspace.elements
      .filter((item) => item.status !== "confirmed")
      .every((item) => !projectedElementIds.has(item.id));
    const citedClaimIds = new Set(
      workspace.claim_sources.map((item) => item.claim_id),
    );
    const uncitedConfirmedClaims = confirmedClaims.filter(
      (claim) => !citedClaimIds.has(claim.id),
    );
    const authorityStatusByClaim = new Map(
      (workspace.position_authority_statuses ?? []).map((item) => [
        String(item.claim_id),
        String(item.status),
      ]),
    );
    const authorityIncompleteClaims = confirmedClaims.filter(
      (claim) => authorityStatusByClaim.get(String(claim.id)) !== "satisfied",
    );
    let assessmentIntegrity = true;
    try {
      this.assertLegalAssessmentIntegrity(workspace);
    } catch {
      assessmentIntegrity = false;
    }
    const openReviewsExcluded = workspace.position_reviews
      .filter((item) => item.status === "open")
      .every(
        (review) =>
          !projectedClaims.some((claim) => claim.id === review.claim_id),
      );
    const independentReviewProvenance = workspace.position_reviews
      .filter((item) => Number(item.independent_review) === 1)
      .every((review) => {
        if (!review.created_by || !review.resolved_by) return false;
        if (review.created_by === review.resolved_by) return false;
        if (!review.parent_review_id) return true;
        const parent = workspace.position_reviews.find(
          (item) => item.id === review.parent_review_id,
        );
        return Boolean(
          parent?.resolved_by && parent.resolved_by !== review.resolved_by,
        );
      });
    let bundleEntries: Array<Record<string, any>> = [];
    let bundlePaginationIntegrity = false;
    try {
      const bundle = this.buildArtifact(
        ctx,
        matterId,
        "hearing_bundle_index",
      ) as Record<string, any>;
      bundleEntries = Array.isArray(bundle.content?.hearingBundleEntries)
        ? bundle.content.hearingBundleEntries
        : [];
      const pagination = bundle.content?.bundlePagination as
        | Record<string, any>
        | undefined;
      bundlePaginationIntegrity =
        pagination?.mode === "continuous_source_sequence"
          ? bundleEntries.every(
              (entry, index) =>
                Number.isSafeInteger(entry.bundlePageStart) &&
                Number.isSafeInteger(entry.bundlePageEnd) &&
                entry.bundlePageEnd >= entry.bundlePageStart &&
                (index === 0 ||
                  entry.bundlePageStart ===
                    bundleEntries[index - 1].bundlePageEnd + 1),
            )
          : pagination?.mode === "source_native_only" &&
            bundleEntries.every(
              (entry) =>
                entry.bundlePageStart === null && entry.bundlePageEnd === null,
            );
    } catch {
      bundlePaginationIntegrity = false;
    }
    const agentRuns = this.db
      .prepare(
        `select * from aletheia_agent_runs
          where matter_id = ? and user_id = ?
            and workflow = 'aletheia-civil-litigation-harness-v1'
            and status = 'succeeded'`,
      )
      .all(matterId, ctx.userId) as Array<Record<string, any>>;
    const agentStepsByRun = new Map<string, Array<Record<string, any>>>();
    const stepsForRun = (runId: string) => {
      const cached = agentStepsByRun.get(runId);
      if (cached) return cached;
      const steps = this.db
        .prepare(
          `select id, step_key, handler, status, output
             from aletheia_agent_steps where run_id = ? order by sequence asc`,
        )
        .all(runId) as Array<Record<string, any>>;
      agentStepsByRun.set(runId, steps);
      return steps;
    };
    const groundedAgentRunsValid = agentRuns.every((run) => {
      const metadata = parseJson(run.metadata) as Record<string, any>;
      const snapshotHash = String(metadata.snapshotHash ?? "");
      const allowedHashes = new Set<string>(
        Array.isArray(metadata.partitionHashes) &&
          metadata.partitionHashes.length
          ? metadata.partitionHashes.filter(
              (item: unknown): item is string =>
                typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item),
            )
          : [snapshotHash],
      );
      const steps = stepsForRun(String(run.id));
      return (
        /^sha256:[a-f0-9]{64}$/.test(snapshotHash) &&
        steps.length >= 1 &&
        steps.length <= 24 &&
        allowedHashes.size >= 1 &&
        steps.every((step) => {
          const output = parseJson(step.output) as Record<string, any>;
          const grounding =
            output.grounding && typeof output.grounding === "object"
              ? (output.grounding as Record<string, any>)
              : {};
          return (
            step.handler === "local_model.litigation_grounded" &&
            step.status === "succeeded" &&
            grounding.verified === true &&
            grounding.exactQuotesVerified === true &&
            allowedHashes.has(String(grounding.snapshotHash ?? ""))
          );
        })
      );
    });
    const agentRunCalibrationBindingsValid = agentRuns.every((run) => {
      try {
        const metadata = parseJson(run.metadata) as Record<string, any>;
        const calibrationId = String(metadata.modelCalibrationId ?? "");
        const fingerprint = String(metadata.modelCalibrationFingerprint ?? "");
        const protocol = String(metadata.modelCalibrationProtocol ?? "");
        if (
          !calibrationId ||
          !/^sha256:[a-f0-9]{64}$/.test(fingerprint) ||
          protocol !== "aletheia-litigation-model-calibration-v1"
        ) {
          return false;
        }
        const calibration = this.db
          .prepare(
            `select id, user_id, model_id, model_fingerprint, status,
                    protocol_version, tested_at, expires_at
               from aletheia_local_model_calibrations
              where id = ? and user_id = ?`,
          )
          .get(calibrationId, ctx.userId) as Record<string, any> | undefined;
        return Boolean(
          calibration &&
          calibration.status === "passed" &&
          calibration.model_id === run.model_profile &&
          calibration.model_fingerprint === fingerprint &&
          calibration.protocol_version === protocol &&
          Date.parse(calibration.tested_at) <= Date.parse(run.created_at) &&
          Date.parse(calibration.expires_at) >= Date.parse(run.created_at),
        );
      } catch {
        return false;
      }
    });
    const agentOutputReviews = workspace.agent_output_reviews ?? [];
    const findingReviews = workspace.agent_finding_reviews ?? [];
    const agentOutputReviewBindingsValid = agentOutputReviews.every(
      (review) => {
        const run = agentRuns.find((item) => item.id === review.run_id);
        if (!run) return false;
        const metadata = parseJson(run.metadata) as Record<string, any>;
        const snapshotHash = String(metadata.snapshotHash ?? "");
        const outputHash = sha256Json({
          runId: run.id,
          snapshotHash,
          steps: stepsForRun(String(run.id)).map((step) => ({
            id: step.id,
            stepKey: step.step_key,
            output: parseJson(step.output),
          })),
        });
        const decisionValid =
          review.status === "open"
            ? !review.decided_by && !review.decided_at
            : (review.status === "approved" || review.status === "rejected") &&
              typeof review.decision_comment === "string" &&
              review.decision_comment.trim().length >= 10 &&
              Boolean(review.decided_by) &&
              Boolean(review.decided_at) &&
              (Number(review.independent_review) !== 1 ||
                review.requested_by !== review.decided_by);
        return (
          review.output_hash === outputHash &&
          review.snapshot_hash === snapshotHash &&
          decisionValid
        );
      },
    );
    const adoptedFindingReviewsValid = agentOutputReviews
      .filter((review) => review.status === "approved")
      .every((review) => {
        const expected = stepsForRun(String(review.run_id)).flatMap((step) => {
          const output = parseJson(step.output) as Record<string, any>;
          const structured =
            output.structuredOutput &&
            typeof output.structuredOutput === "object"
              ? (output.structuredOutput as Record<string, any>)
              : {};
          return (
            Array.isArray(structured.findings) ? structured.findings : []
          ).map((finding: unknown, findingIndex: number) => ({
            stepId: String(step.id),
            findingIndex,
            findingHash: sha256Json({
              stepId: String(step.id),
              findingIndex,
              finding,
            }),
          }));
        });
        if (expected.length === 0) return false;
        return expected.every((item) => {
          const latest = findingReviews
            .filter(
              (row) =>
                row.run_id === review.run_id &&
                row.step_id === item.stepId &&
                Number(row.finding_index) === item.findingIndex,
            )
            .sort((a, b) => Number(b.version) - Number(a.version))[0];
          return (
            latest?.assessment === "supported" &&
            latest.finding_hash === item.findingHash
          );
        });
      });
    const cases = [
      {
        caseId: "confirmed_fact_source_coverage",
        caseType: "golden",
        expected: true,
        actual: confirmedFacts.every((fact) => factSources.has(fact.id)),
        evidenceRefs: confirmedFacts.map((fact) => fact.id),
      },
      {
        caseId: "claim_element_fact_coverage",
        caseType: "golden",
        expected: true,
        actual: elements.every((element) => linkedElements.has(element.id)),
        evidenceRefs: elements.map((element) => element.id),
      },
      {
        caseId: "confirmed_deadline_rule_provenance",
        caseType: "golden",
        expected: true,
        actual: confirmedDeadlines.every(
          (item) => item.rule_label && item.rule_version && item.calculation,
        ),
        evidenceRefs: confirmedDeadlines.map((item) => item.id),
      },
      {
        caseId: "source_hash_tamper_badcase",
        caseType: "bad_case",
        expected: true,
        actual: sourceIntegrity,
        evidenceRefs: sourceRows.map((item) => item.id),
      },
      {
        caseId: "missing_citation_badcase",
        caseType: "bad_case",
        expected: true,
        actual: uncitedConfirmedClaims.length === 0,
        evidenceRefs: uncitedConfirmedClaims.map((claim) => claim.id),
      },
      {
        caseId: "missing_verified_legal_authority_badcase",
        caseType: "bad_case",
        expected: true,
        actual: authorityIncompleteClaims.length === 0,
        evidenceRefs: authorityIncompleteClaims.map((claim) => claim.id),
      },
      {
        caseId: "approval_bypass_badcase",
        caseType: "bad_case",
        expected: true,
        actual: exportsAuthorized,
        evidenceRefs: exportBindings.map((item) =>
          String(
            (parseJson(item.metadata) as Record<string, unknown>).workProductId,
          ),
        ),
      },
      {
        caseId: "unconfirmed_element_projection_badcase",
        caseType: "bad_case",
        expected: true,
        actual: unconfirmedElementsExcluded,
        evidenceRefs: workspace.elements
          .filter((item) => item.status !== "confirmed")
          .map((item) => item.id),
      },
      {
        caseId: "stale_artifact_export_badcase",
        caseType: "bad_case",
        expected: true,
        actual: staleArtifactsNotExported,
        evidenceRefs: staleWorkProducts.map((item) => item.id),
      },
      {
        caseId: "legal_assessment_lineage_integrity",
        caseType: "golden",
        expected: true,
        actual: assessmentIntegrity,
        evidenceRefs: workspace.legal_assessments.map((item) => item.id),
      },
      {
        caseId: "open_review_projection_badcase",
        caseType: "bad_case",
        expected: true,
        actual: openReviewsExcluded,
        evidenceRefs: workspace.position_reviews
          .filter((item) => item.status === "open")
          .map((item) => item.id),
      },
      {
        caseId: "independent_review_actor_separation",
        caseType: "golden",
        expected: true,
        actual: independentReviewProvenance,
        evidenceRefs: workspace.position_reviews
          .filter((item) => Number(item.independent_review) === 1)
          .map((item) => item.id),
      },
      {
        caseId: "hearing_bundle_pagination_integrity",
        caseType: "golden",
        expected: true,
        actual: bundlePaginationIntegrity,
        evidenceRefs: bundleEntries.map((item) => String(item.documentId)),
      },
      {
        caseId: "grounded_agent_run_integrity",
        caseType: "golden",
        expected: true,
        actual: groundedAgentRunsValid,
        evidenceRefs: agentRuns.map((item) => String(item.id)),
      },
      {
        caseId: "agent_run_calibration_binding",
        caseType: "golden",
        expected: true,
        actual: agentRunCalibrationBindingsValid,
        evidenceRefs: agentRuns.map((item) => String(item.id)),
      },
      {
        caseId: "agent_output_review_binding_badcase",
        caseType: "bad_case",
        expected: true,
        actual: agentOutputReviewBindingsValid,
        evidenceRefs: agentOutputReviews.map((item) => String(item.id)),
      },
      {
        caseId: "adopted_finding_support_review_badcase",
        caseType: "bad_case",
        expected: true,
        actual: adoptedFindingReviewsValid,
        evidenceRefs: findingReviews.map((item) => String(item.id)),
      },
    ].map((item) => ({ ...item, passed: item.actual === item.expected }));
    const runId = randomUUID();
    const timestamp = now();
    const passed = cases.filter((item) => item.passed).length;
    const resultHash = createHash("sha256")
      .update(JSON.stringify(cases))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_eval_runs
            (id, matter_id, user_id, suite_version, status, passed, total, result_hash, created_at)
           values (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          runId,
          matterId,
          ctx.userId,
          "aletheia-litigation-eval-v6",
          passed,
          cases.length,
          resultHash,
          timestamp,
        );
      for (const item of cases) {
        this.db
          .prepare(
            `insert into aletheia_litigation_eval_results
              (id, run_id, matter_id, case_id, case_type, expected, actual,
               passed, grader_id, grader_version, evidence_refs, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            runId,
            matterId,
            item.caseId,
            item.caseType,
            JSON.stringify(item.expected),
            JSON.stringify(item.actual),
            item.passed ? 1 : 0,
            "deterministic-litigation-grader",
            "1.1.0",
            JSON.stringify(item.evidenceRefs),
            timestamp,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getEvalRun(ctx, matterId, runId);
  }

  listEvalRuns(ctx: AletheiaUserContext, matterId: string) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const runs = this.db
      .prepare(
        `select * from aletheia_litigation_eval_runs
          where matter_id = ? and user_id = ? order by created_at desc`,
      )
      .all(matterId, ctx.userId) as Array<Record<string, any>>;
    return runs.map((run) => this.evalRun(run));
  }

  private getEvalRun(
    ctx: AletheiaUserContext,
    matterId: string,
    runId: string,
  ) {
    const run = this.db
      .prepare(
        `select * from aletheia_litigation_eval_runs
          where id = ? and matter_id = ? and user_id = ?`,
      )
      .get(runId, matterId, ctx.userId) as Record<string, any> | undefined;
    return run ? this.evalRun(run) : null;
  }

  private evalRun(run: Record<string, any>) {
    const results = this.db
      .prepare(
        "select * from aletheia_litigation_eval_results where run_id = ? order by rowid asc",
      )
      .all(run.id) as Array<Record<string, any>>;
    return {
      ...run,
      results: results.map((item) => ({
        ...item,
        expected: JSON.parse(item.expected),
        actual: JSON.parse(item.actual),
        passed: Boolean(item.passed),
        evidence_refs: JSON.parse(item.evidence_refs),
      })),
    };
  }

  createFact(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationFactInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const timestamp = now();
    const factId = randomUUID();
    const createdBy = input.createdBy ?? "human";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_facts (
            id, matter_id, user_id, statement, occurred_at, date_precision,
            helpfulness, confidence, status, created_by, metadata,
            created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
        )
        .run(
          factId,
          matterId,
          ctx.userId,
          input.statement,
          input.occurredAt ?? null,
          input.datePrecision ?? "unknown",
          input.helpfulness ?? "unknown",
          input.confidence ?? null,
          createdBy,
          json(input.metadata),
          timestamp,
          timestamp,
        );
      if (input.source) {
        const sourceSpanId = this.createSourceSpan(
          ctx,
          matterId,
          input.source,
          createdBy,
        );
        this.db
          .prepare(
            `insert into aletheia_litigation_fact_sources (
              id, matter_id, fact_id, source_span_id, relation, created_at
            ) values (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            matterId,
            factId,
            sourceSpanId,
            input.sourceRelation ?? "supports",
            timestamp,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return record(
      this.db
        .prepare("select * from aletheia_litigation_facts where id = ?")
        .get(factId) as Record<string, unknown>,
    );
  }

  decideFact(
    ctx: AletheiaUserContext,
    matterId: string,
    factId: string,
    input: DecideLitigationFactInput,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    if (input.decision === "confirmed") {
      this.assertConfirmableSources(ctx, matterId, "fact", factId);
    }
    const timestamp = now();
    let decided: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `update aletheia_litigation_facts
              set status = ?, decision_comment = ?, decided_by = ?,
                  decided_at = ?, updated_at = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'proposed'`,
        )
        .run(
          input.decision,
          input.comment ?? null,
          ctx.userId,
          timestamp,
          timestamp,
          factId,
          matterId,
          ctx.userId,
        );
      if (!result.changes) {
        this.db.exec("ROLLBACK");
        return null;
      }
      decided = record(
        this.db
          .prepare("select * from aletheia_litigation_facts where id = ?")
          .get(factId) as Record<string, unknown>,
      );
      if (!decided) throw new Error("Decided fact could not be reloaded.");
      onBeforeCommit?.(decided);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return decided;
  }

  createClaim(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateLitigationClaimInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    if (input.parentClaimId) {
      const parent = this.db
        .prepare(
          "select id from aletheia_litigation_claims where id = ? and matter_id = ? and user_id = ?",
        )
        .get(input.parentClaimId, matterId, ctx.userId);
      if (!parent) {
        throw new LitigationValidationError(
          "The parent claim does not belong to this matter.",
        );
      }
    }
    const id = randomUUID();
    const timestamp = now();
    const createdBy = input.createdBy ?? "human";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_claims (
            id, matter_id, user_id, kind, parent_claim_id, title, legal_basis,
            confidence, uncertainty, burden_party_id, status, created_by,
            metadata, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          input.kind,
          input.parentClaimId ?? null,
          input.title,
          input.legalBasis ?? null,
          input.confidence ?? null,
          input.uncertainty ?? null,
          input.burdenPartyId ?? null,
          createdBy,
          json(input.metadata),
          timestamp,
          timestamp,
        );
      if (input.source) {
        const sourceSpanId = this.createSourceSpan(
          ctx,
          matterId,
          input.source,
          createdBy,
        );
        this.db
          .prepare(
            `insert into aletheia_litigation_claim_sources (
              id, matter_id, claim_id, source_span_id, relation, created_at
            ) values (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            matterId,
            id,
            sourceSpanId,
            input.sourceRelation ?? "supports",
            timestamp,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return record(
      this.db
        .prepare(
          "select * from aletheia_litigation_claims where id = ? and matter_id = ? and user_id = ?",
        )
        .get(id, matterId, ctx.userId) as Record<string, unknown>,
    );
  }

  decideClaim(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: DecideLitigationClaimInput,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    if (input.decision === "confirmed") {
      this.assertConfirmableSources(ctx, matterId, "claim", claimId);
    }
    const timestamp = now();
    let decided: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `update aletheia_litigation_claims
              set status = ?, decision_comment = ?, decided_by = ?,
                  decided_at = ?, updated_at = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'proposed'`,
        )
        .run(
          input.decision,
          input.comment ?? null,
          ctx.userId,
          timestamp,
          timestamp,
          claimId,
          matterId,
          ctx.userId,
        );
      if (!result.changes) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const assessment = this.appendLegalAssessment(
        ctx,
        matterId,
        claimId,
        null,
      );
      decided = record(
        this.db
          .prepare(
            "select * from aletheia_litigation_claims where id = ? and matter_id = ? and user_id = ?",
          )
          .get(claimId, matterId, ctx.userId) as Record<string, unknown>,
      );
      if (!decided || !assessment) {
        throw new Error("Decided legal position could not be reloaded.");
      }
      onBeforeCommit?.({ ...decided, assessment });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return decided;
  }

  createPositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: CreatePositionReviewInput,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
    actorId = ctx.userId,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const reason = input.reason.trim();
    if (!reason) {
      throw new LitigationValidationError(
        "Position review reason is required.",
      );
    }
    const timestamp = now();
    const id = randomUUID();
    let created: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.db
        .prepare(
          `select id, status, current_assessment_id from aletheia_litigation_claims
            where id = ? and matter_id = ? and user_id = ?`,
        )
        .get(claimId, matterId, ctx.userId) as
        | { id: string; status: string; current_assessment_id: string | null }
        | undefined;
      if (!claim) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (claim.status !== "confirmed" && claim.status !== "rejected") {
        throw new LitigationValidationError(
          "Only confirmed or rejected claims may be reviewed.",
        );
      }
      if (!claim.current_assessment_id) {
        throw new LitigationValidationError(
          "The reviewed legal position has no current assessment version.",
        );
      }
      let parentReviewId: string | null = null;
      let reviewLevel = 1;
      if (input.parentReviewId) {
        const parent = this.db
          .prepare(
            `select * from aletheia_position_reviews
              where id = ? and matter_id = ? and user_id = ? and claim_id = ?`,
          )
          .get(input.parentReviewId, matterId, ctx.userId, claimId) as
          | Record<string, any>
          | undefined;
        if (!parent || parent.status !== "resolved") {
          throw new LitigationValidationError(
            "An internal appeal requires a resolved review on the same legal position.",
          );
        }
        if (Number(parent.review_level ?? 1) !== 1) {
          throw new LitigationValidationError(
            "A third-level position review is not permitted.",
          );
        }
        if (
          input.kind !== "reconsideration" ||
          input.requestedOutcome === "withdrawn"
        ) {
          throw new LitigationValidationError(
            "An internal appeal must be a reconsideration request.",
          );
        }
        const parentResultVersion =
          parent.result_assessment_id ?? parent.assessment_id;
        if (parentResultVersion !== claim.current_assessment_id) {
          throw new LitigationValidationError(
            "The appealed review no longer belongs to the current assessment lineage.",
          );
        }
        const child = this.db
          .prepare(
            "select id from aletheia_position_reviews where parent_review_id = ?",
          )
          .get(parent.id);
        if (child) {
          throw new LitigationValidationError(
            "This review decision already has an internal appeal.",
          );
        }
        parentReviewId = String(parent.id);
        reviewLevel = 2;
      }
      if (input.requestedOutcome === claim.status) {
        throw new LitigationValidationError(
          "Requested outcome must differ from the claim's current status.",
        );
      }
      if (
        (input.kind === "withdrawal") !==
        (input.requestedOutcome === "withdrawn")
      ) {
        throw new LitigationValidationError(
          "Withdrawal reviews must request withdrawn, and only withdrawal reviews may do so.",
        );
      }
      const open = this.db
        .prepare(
          `select id from aletheia_position_reviews
            where claim_id = ? and matter_id = ? and user_id = ? and status = 'open'`,
        )
        .get(claimId, matterId, ctx.userId);
      if (open) {
        throw new LitigationValidationError(
          "This claim already has an open position review.",
        );
      }
      this.db
        .prepare(
          `insert into aletheia_position_reviews (
            id, matter_id, user_id, claim_id, assessment_id, result_assessment_id,
            parent_review_id, review_level, independent_review, kind, reason,
            requested_outcome, status, resolution, resolution_comment,
            resolved_by, resolved_at, created_by, created_at, updated_at
          ) values (?, ?, ?, ?, ?, null, ?, ?, 0, ?, ?, ?, 'open', null, null, null, null, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          claimId,
          claim.current_assessment_id,
          parentReviewId,
          reviewLevel,
          input.kind,
          reason,
          input.requestedOutcome,
          actorId,
          timestamp,
          timestamp,
        );
      created = record(
        this.db
          .prepare(
            "select * from aletheia_position_reviews where id = ? and matter_id = ? and user_id = ?",
          )
          .get(id, matterId, ctx.userId) as Record<string, unknown>,
      );
      if (!created) {
        throw new Error("Created position review could not be reloaded.");
      }
      onBeforeCommit?.(created);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return created;
  }

  resolvePositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
    input: ResolvePositionReviewInput,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
    actorId = ctx.userId,
    enforceIndependentReview = false,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const timestamp = now();
    let resolved: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const review = this.db
        .prepare(
          `select r.*, c.status as claim_status,
                  c.current_assessment_id
             from aletheia_position_reviews r
             join aletheia_litigation_claims c
               on c.id = r.claim_id and c.matter_id = r.matter_id
            where r.id = ? and r.matter_id = ? and r.user_id = ?
              and c.user_id = ?`,
        )
        .get(reviewId, matterId, ctx.userId, ctx.userId) as
        | Record<string, any>
        | undefined;
      if (!review) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (review.status !== "open") {
        throw new LitigationValidationError(
          "Only open position reviews may be resolved.",
        );
      }
      if (enforceIndependentReview && review.created_by === actorId) {
        throw new LitigationValidationError(
          "A reviewer cannot resolve their own position review request.",
        );
      }
      if (enforceIndependentReview && review.parent_review_id) {
        const parent = this.db
          .prepare(
            `select resolved_by from aletheia_position_reviews
              where id = ? and matter_id = ? and user_id = ?`,
          )
          .get(review.parent_review_id, matterId, ctx.userId) as
          | { resolved_by: string | null }
          | undefined;
        if (!parent?.resolved_by || parent.resolved_by === actorId) {
          throw new LitigationValidationError(
            "A level-2 reviewer must differ from the level-1 reviewer.",
          );
        }
      }
      if (
        !review.assessment_id ||
        review.assessment_id !== review.current_assessment_id
      ) {
        throw new LitigationValidationError(
          "This review targets a stale legal assessment version.",
        );
      }
      let resultAssessmentId: string | null = null;
      if (input.resolution === "granted") {
        const claimUpdate = this.db
          .prepare(
            `update aletheia_litigation_claims
                set status = ?, decision_comment = ?, decided_by = ?,
                    decided_at = ?, updated_at = ?
              where id = ? and matter_id = ? and user_id = ?
                and status in ('confirmed', 'rejected')`,
          )
          .run(
            review.requested_outcome,
            input.comment ?? review.reason,
            actorId,
            timestamp,
            timestamp,
            review.claim_id,
            matterId,
            ctx.userId,
          );
        if (!claimUpdate.changes) {
          throw new LitigationValidationError(
            "The reviewed claim is no longer in a reviewable state.",
          );
        }
        const assessment = this.appendLegalAssessment(
          ctx,
          matterId,
          String(review.claim_id),
          reviewId,
          actorId,
        );
        resultAssessmentId = String(assessment?.id ?? "");
        if (!resultAssessmentId) {
          throw new Error("Granted review assessment could not be created.");
        }
      }
      this.db
        .prepare(
          `update aletheia_position_reviews
              set status = 'resolved', resolution = ?, resolution_comment = ?,
                  result_assessment_id = ?,
                  independent_review = ?,
                  resolved_by = ?, resolved_at = ?, updated_at = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'open'`,
        )
        .run(
          input.resolution,
          input.comment ?? null,
          resultAssessmentId,
          enforceIndependentReview ? 1 : 0,
          actorId,
          timestamp,
          timestamp,
          reviewId,
          matterId,
          ctx.userId,
        );
      resolved = record(
        this.db
          .prepare(
            `select r.*, c.status as claim_status,
                    a.id as result_assessment_version_id,
                    a.version as result_assessment_version
               from aletheia_position_reviews r
               join aletheia_litigation_claims c
                 on c.id = r.claim_id and c.matter_id = r.matter_id
               left join aletheia_legal_assessments a
                 on a.id = r.result_assessment_id and a.claim_id = r.claim_id
              where r.id = ? and r.matter_id = ? and r.user_id = ?
                and c.user_id = ?`,
          )
          .get(reviewId, matterId, ctx.userId, ctx.userId) as Record<
          string,
          unknown
        >,
      );
      if (!resolved) {
        throw new Error("Resolved position review could not be reloaded.");
      }
      onBeforeCommit?.(resolved);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return resolved;
  }

  withdrawPositionReview(
    ctx: AletheiaUserContext,
    matterId: string,
    reviewId: string,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
    actorId = ctx.userId,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const timestamp = now();
    let withdrawn: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const review = this.db
        .prepare(
          `select r.id, r.created_by from aletheia_position_reviews r
             join aletheia_litigation_claims c
               on c.id = r.claim_id and c.matter_id = r.matter_id
            where r.id = ? and r.matter_id = ? and r.user_id = ?
              and c.user_id = ?`,
        )
        .get(reviewId, matterId, ctx.userId, ctx.userId);
      if (!review) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if ((review as { created_by?: string }).created_by !== actorId) {
        throw new LitigationValidationError(
          "Only the requester may withdraw an open position review.",
        );
      }
      const result = this.db
        .prepare(
          `update aletheia_position_reviews
              set status = 'withdrawn', resolved_by = ?, resolved_at = ?,
                  updated_at = ?
            where id = ? and matter_id = ? and user_id = ? and status = 'open'`,
        )
        .run(actorId, timestamp, timestamp, reviewId, matterId, ctx.userId);
      if (!result.changes) {
        throw new LitigationValidationError(
          "Only open position reviews may be withdrawn.",
        );
      }
      withdrawn = record(
        this.db
          .prepare(
            "select * from aletheia_position_reviews where id = ? and matter_id = ? and user_id = ?",
          )
          .get(reviewId, matterId, ctx.userId) as Record<string, unknown>,
      );
      if (!withdrawn) {
        throw new Error("Withdrawn position review could not be reloaded.");
      }
      onBeforeCommit?.(withdrawn);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return withdrawn;
  }

  createElement(
    ctx: AletheiaUserContext,
    matterId: string,
    claimId: string,
    input: CreateLitigationElementInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const claim = this.db
      .prepare(
        "select id from aletheia_litigation_claims where id = ? and matter_id = ? and user_id = ?",
      )
      .get(claimId, matterId, ctx.userId);
    if (!claim) return null;
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `insert into aletheia_litigation_claim_elements (
          id, matter_id, claim_id, title, description, sequence, status,
          created_by, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
      )
      .run(
        id,
        matterId,
        claimId,
        input.title,
        input.description ?? null,
        input.sequence ?? 0,
        input.createdBy ?? "human",
        json(input.metadata),
        timestamp,
        timestamp,
      );
    return record(
      this.db
        .prepare(
          "select * from aletheia_litigation_claim_elements where id = ?",
        )
        .get(id) as Record<string, unknown>,
    );
  }

  decideElement(
    ctx: AletheiaUserContext,
    matterId: string,
    elementId: string,
    input: DecideLitigationElementInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const timestamp = now();
    const result = this.db
      .prepare(
        `update aletheia_litigation_claim_elements
            set status = ?, decision_comment = ?, decided_by = ?,
                decided_at = ?, updated_at = ?
          where id = ? and matter_id = ? and status = 'proposed'`,
      )
      .run(
        input.decision,
        input.comment ?? null,
        ctx.userId,
        timestamp,
        timestamp,
        elementId,
        matterId,
      );
    if (!result.changes) return null;
    return record(
      this.db
        .prepare(
          "select * from aletheia_litigation_claim_elements where id = ?",
        )
        .get(elementId) as Record<string, unknown>,
    );
  }

  linkElementFact(
    ctx: AletheiaUserContext,
    matterId: string,
    elementId: string,
    input: LinkElementFactInput,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    if (input.relation !== "supports" && input.relation !== "contradicts") {
      throw new LitigationValidationError(
        "An element-fact link must support or contradict the element.",
      );
    }
    const pair = this.db
      .prepare(
        `select e.id as element_id, f.id as fact_id
           from aletheia_litigation_claim_elements e
           join aletheia_litigation_claims c
             on c.id = e.claim_id and c.matter_id = e.matter_id
            and c.user_id = ?
           join aletheia_litigation_facts f
             on f.id = ? and f.matter_id = e.matter_id and f.user_id = ?
            and f.status != 'rejected'
          where e.id = ? and e.matter_id = ?`,
      )
      .get(ctx.userId, input.factId, ctx.userId, elementId, matterId);
    if (!pair) return null;
    const id = randomUUID();
    let linked: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `insert into aletheia_litigation_element_facts (
            id, matter_id, element_id, fact_id, relation, note, created_at
          ) values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          elementId,
          input.factId,
          input.relation,
          input.note ?? null,
          now(),
        );
      linked = record(
        this.db
          .prepare(
            "select * from aletheia_litigation_element_facts where id = ?",
          )
          .get(id) as Record<string, unknown>,
      );
      if (!linked) throw new Error("Element-fact link could not be reloaded.");
      onBeforeCommit?.(linked);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return linked;
  }

  createProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateProceduralEventInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const timestamp = now();
    const createdBy = input.createdBy ?? "human";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sourceSpanId = input.source
        ? this.createSourceSpan(ctx, matterId, input.source, createdBy)
        : null;
      const id = randomUUID();
      const eventLineageHash = sha256Json({
        id,
        matterId,
        eventVersion: 1,
        supersedesEventId: null,
        eventType: input.eventType,
        title: input.title,
        occurredAt: input.occurredAt ?? null,
        primarySourceSpanId: sourceSpanId,
      });
      this.db
        .prepare(
          `insert into aletheia_litigation_procedural_events (
            id, matter_id, user_id, event_type, title, occurred_at,
            primary_source_span_id, status, created_by, event_version,
            event_lineage_hash, metadata,
            created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          input.eventType,
          input.title,
          input.occurredAt ?? null,
          sourceSpanId,
          createdBy,
          eventLineageHash,
          json(input.metadata),
          timestamp,
          timestamp,
        );
      this.db.exec("COMMIT");
      return record(
        this.db
          .prepare(
            "select * from aletheia_litigation_procedural_events where id = ?",
          )
          .get(id) as Record<string, unknown>,
      );
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateDeadlineCandidateInput,
    onCreate?: (created: Record<string, unknown>) => void,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    if (input.triggeringEventId) {
      const event = this.db
        .prepare(
          "select id from aletheia_litigation_procedural_events where id = ? and matter_id = ?",
        )
        .get(input.triggeringEventId, matterId);
      if (!event) {
        throw new LitigationValidationError(
          "The triggering event does not belong to this matter.",
        );
      }
    }
    const timestamp = now();
    const createdBy = input.createdBy ?? "human";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sourceSpanId = input.source
        ? this.createSourceSpan(ctx, matterId, input.source, createdBy)
        : null;
      const id = randomUUID();
      const calculationHash = `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            triggeringEventId: input.triggeringEventId ?? null,
            dueAt: input.dueAt,
            ruleLabel: input.ruleLabel,
            ruleVersion: input.ruleVersion,
            calculation: input.calculation,
            metadata: input.metadata ?? {},
          }),
        )
        .digest("hex")}`;
      this.db
        .prepare(
          `insert into aletheia_litigation_deadlines (
            id, matter_id, user_id, triggering_event_id, primary_source_span_id,
            title, due_at, rule_label, rule_version, calculation,
            calculation_hash, court_calendar_version_id, court_calendar_hash,
            status, created_by, metadata, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
        )
        .run(
          id,
          matterId,
          ctx.userId,
          input.triggeringEventId ?? null,
          sourceSpanId,
          input.title,
          input.dueAt,
          input.ruleLabel,
          input.ruleVersion,
          input.calculation,
          calculationHash,
          input.courtCalendarVersionId ?? null,
          input.courtCalendarHash ?? null,
          createdBy,
          json(input.metadata),
          timestamp,
          timestamp,
        );
      const created = record(
        this.db
          .prepare("select * from aletheia_litigation_deadlines where id = ?")
          .get(id) as Record<string, unknown>,
      );
      if (!created) throw new Error("Created deadline could not be reloaded.");
      onCreate?.(created);
      this.db.exec("COMMIT");
      return created;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  decideProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    eventId: string,
    input: DecideProceduralEventInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const timestamp = now();
    const result = this.db
      .prepare(
        `update aletheia_litigation_procedural_events
            set status = ?, decision_comment = ?, decided_by = ?,
                decided_at = ?, updated_at = ?
          where id = ? and matter_id = ? and user_id = ? and status = 'proposed'`,
      )
      .run(
        input.decision,
        input.comment ?? null,
        ctx.userId,
        timestamp,
        timestamp,
        eventId,
        matterId,
        ctx.userId,
      );
    if (!result.changes) return null;
    return record(
      this.db
        .prepare(
          "select * from aletheia_litigation_procedural_events where id = ?",
        )
        .get(eventId) as Record<string, unknown>,
    );
  }

  correctProceduralEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    eventId: string,
    input: CorrectProceduralEventInput,
    onBeforeCommit?: (result: Record<string, unknown>) => void,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const title = input.title.trim();
    const reason = input.reason.trim();
    const occurredAt = input.occurredAt.trim();
    if (!title || title.length > 500 || reason.length < 10 || reason.length > 2_000) {
      throw new LitigationValidationError(
        "Event correction requires a title and a 10-2000 character reason.",
      );
    }
    if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
      throw new LitigationValidationError(
        "Event correction requires a valid occurredAt timestamp.",
      );
    }
    const original = this.db
      .prepare(
        `select * from aletheia_litigation_procedural_events
          where id = ? and matter_id = ? and user_id = ?
            and status = 'confirmed' and superseded_at is null`,
      )
      .get(eventId, matterId, ctx.userId) as Record<string, any> | undefined;
    if (!original) return null;
    if (!original.occurred_at || !Number.isFinite(Date.parse(original.occurred_at))) {
      throw new LitigationValidationError(
        "Only a confirmed event with a valid occurredAt timestamp can be corrected.",
      );
    }
    if (original.title === title && original.occurred_at === occurredAt) {
      throw new LitigationValidationError(
        "Event correction must change the title or occurredAt timestamp.",
      );
    }
    const originalVersion = Number(original.event_version ?? 1);
    const originalLineageHash = sha256Json({
      id: original.id,
      matterId,
      eventVersion: originalVersion,
      supersedesEventId: original.supersedes_event_id ?? null,
      eventType: original.event_type,
      title: original.title,
      occurredAt: original.occurred_at ?? null,
      primarySourceSpanId: original.primary_source_span_id ?? null,
    });
    if (
      original.event_lineage_hash &&
      original.event_lineage_hash !== originalLineageHash
    ) {
      throw new LitigationValidationError(
        "The procedural event lineage hash is invalid.",
      );
    }
    const timestamp = now();
    const replacementId = randomUUID();
    const correctionId = randomUUID();
    let result: Record<string, unknown> | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sourceSpanId = input.source
        ? this.createSourceSpan(ctx, matterId, input.source, "human")
        : original.primary_source_span_id;
      if (!sourceSpanId) {
        throw new LitigationValidationError(
          "Event correction requires the original source or a new verified source span.",
        );
      }
      const sourceSpan = this.db
        .prepare(
          `select s.*, c.text as current_chunk_text,
                  c.metadata as current_chunk_metadata
             from aletheia_source_spans s
             join aletheia_document_chunks c
               on c.id = s.source_chunk_id and c.matter_id = s.matter_id
              and c.user_id = s.user_id
            where s.id = ? and s.matter_id = ? and s.user_id = ?`,
        )
        .get(sourceSpanId, matterId, ctx.userId) as
        | Record<string, unknown>
        | undefined;
      if (!sourceSpan || !this.sourceSpanIntegrity(sourceSpan)) {
        throw new LitigationValidationError(
          "Event correction source integrity verification failed.",
        );
      }
      const replacementVersion = originalVersion + 1;
      const replacementLineageHash = sha256Json({
        id: replacementId,
        matterId,
        eventVersion: replacementVersion,
        supersedesEventId: original.id,
        eventType: original.event_type,
        title,
        occurredAt,
        primarySourceSpanId: sourceSpanId,
      });
      const correctionHash = sha256Json({
        correctionId,
        matterId,
        originalEventId: original.id,
        replacementEventId: replacementId,
        originalLineageHash,
        replacementLineageHash,
        fromOccurredAt: original.occurred_at,
        toOccurredAt: occurredAt,
        reason,
        correctedBy: ctx.userId,
      });
      if (!original.event_lineage_hash) {
        this.db
          .prepare(
            `update aletheia_litigation_procedural_events
                set event_lineage_hash = ?
              where id = ? and matter_id = ? and user_id = ?`,
          )
          .run(originalLineageHash, original.id, matterId, ctx.userId);
      }
      const metadata = {
        ...(parseJson(original.metadata) as Record<string, unknown>),
        correction: {
          correctionId,
          reason,
          supersedesEventId: original.id,
          originalLineageHash,
        },
      };
      this.db
        .prepare(
          `insert into aletheia_litigation_procedural_events (
            id, matter_id, user_id, event_type, title, occurred_at,
            primary_source_span_id, status, created_by, decision_comment,
            decided_by, decided_at, event_version, supersedes_event_id,
            event_lineage_hash, metadata, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          replacementId,
          matterId,
          ctx.userId,
          original.event_type,
          title,
          occurredAt,
          sourceSpanId,
          reason,
          ctx.userId,
          timestamp,
          replacementVersion,
          original.id,
          replacementLineageHash,
          json(metadata),
          timestamp,
          timestamp,
        );
      const superseded = this.db
        .prepare(
          `update aletheia_litigation_procedural_events
              set superseded_by_event_id = ?, superseded_at = ?,
                  correction_reason = ?, updated_at = ?
            where id = ? and matter_id = ? and user_id = ?
              and status = 'confirmed' and superseded_at is null`,
        )
        .run(
          replacementId,
          timestamp,
          reason,
          timestamp,
          original.id,
          matterId,
          ctx.userId,
        );
      if (superseded.changes !== 1) {
        throw new LitigationValidationError(
          "The procedural event changed while the correction was being recorded.",
        );
      }
      this.db
        .prepare(
          `insert into aletheia_litigation_procedural_event_corrections (
            id, matter_id, user_id, original_event_id, replacement_event_id,
            from_occurred_at, to_occurred_at, reason, correction_hash,
            corrected_by, corrected_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          correctionId,
          matterId,
          ctx.userId,
          original.id,
          replacementId,
          original.occurred_at,
          occurredAt,
          reason,
          correctionHash,
          ctx.userId,
          timestamp,
        );
      const staleReason = `Triggering event corrected: ${original.id} -> ${replacementId}`;
      const invalidatedTasks = this.db
        .prepare(
          `update aletheia_tasks
              set invalidated_at = ?, invalidated_reason = ?, updated_at = ?
            where matter_id = ? and user_id = ? and invalidated_at is null
              and source_deadline_id in (
                select id from aletheia_litigation_deadlines
                 where matter_id = ? and user_id = ? and triggering_event_id = ?
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
          original.id,
        );
      const invalidatedDeadlines = this.db
        .prepare(
          `update aletheia_litigation_deadlines
              set stale_at = ?, stale_reason = ?, updated_at = ?
            where matter_id = ? and user_id = ? and triggering_event_id = ?
              and stale_at is null`,
        )
        .run(timestamp, staleReason, timestamp, matterId, ctx.userId, original.id);
      const replacement = record(
        this.db
          .prepare(
            "select * from aletheia_litigation_procedural_events where id = ?",
          )
          .get(replacementId) as Record<string, unknown>,
      );
      if (!replacement) throw new Error("Corrected event could not be reloaded.");
      result = {
        correctionId,
        correctionHash,
        originalEventId: original.id,
        fromOccurredAt: original.occurred_at,
        toOccurredAt: occurredAt,
        replacement,
        invalidatedDeadlines: invalidatedDeadlines.changes,
        invalidatedTasks: invalidatedTasks.changes,
      };
      onBeforeCommit?.(result);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return result;
  }

  decideDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    deadlineId: string,
    input: DecideDeadlineCandidateInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const result = this.db
      .prepare(
        `update aletheia_litigation_deadlines
            set status = ?, decision_comment = ?, decided_by = ?,
                decided_at = ?, updated_at = ?
          where id = ? and matter_id = ? and user_id = ?
            and status = 'proposed' and stale_at is null`,
      )
      .run(
        input.decision,
        input.comment ?? null,
        ctx.userId,
        now(),
        now(),
        deadlineId,
        matterId,
        ctx.userId,
      );
    if (!result.changes) return null;
    return record(
      this.db
        .prepare("select * from aletheia_litigation_deadlines where id = ?")
        .get(deadlineId) as Record<string, unknown>,
    );
  }

  createTaskFromDeadline(
    ctx: AletheiaUserContext,
    matterId: string,
    deadlineId: string,
    input: CreateTaskFromDeadlineInput,
  ) {
    if (!this.requireOwnedMatter(ctx, matterId)) return null;
    const deadline = this.db
      .prepare(
        `select id, matter_id, user_id, title, due_at, status, stale_at
           from aletheia_litigation_deadlines
          where id = ? and matter_id = ? and user_id = ?
            and status in ('confirmed', 'completed') and stale_at is null`,
      )
      .get(deadlineId, matterId, ctx.userId) as
      | Record<string, unknown>
      | undefined;
    if (!deadline) return null;

    const priority = input.priority ?? "normal";
    if (!["high", "normal", "low"].includes(priority)) {
      throw new LitigationValidationError("Task priority is invalid.");
    }
    const title = input.title?.trim() || String(deadline.title);
    if (!title) {
      throw new LitigationValidationError("Task title is required.");
    }

    const existing = this.db
      .prepare(
        `select * from aletheia_tasks
          where user_id = ? and source_deadline_id = ?`,
      )
      .get(ctx.userId, deadlineId) as Record<string, unknown> | undefined;
    if (existing) return { task: record(existing), created: false };

    const id = randomUUID();
    const timestamp = now();
    const result = this.db
      .prepare(
        `insert into aletheia_tasks (
          id, matter_id, user_id, source_deadline_id, title, due_at, status,
          priority, note, completed_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, 'open', ?, ?, null, ?, ?)
        on conflict(user_id, source_deadline_id) do nothing`,
      )
      .run(
        id,
        matterId,
        ctx.userId,
        deadlineId,
        title,
        deadline.due_at,
        priority,
        input.note ?? null,
        timestamp,
        timestamp,
      );
    const task = this.db
      .prepare(
        `select * from aletheia_tasks
          where user_id = ? and source_deadline_id = ?`,
      )
      .get(ctx.userId, deadlineId) as Record<string, unknown> | undefined;
    return task
      ? { task: record(task), created: Boolean(result.changes) }
      : null;
  }

  listTasks(ctx: AletheiaUserContext, status: LitigationTaskStatusFilter) {
    const statusClause = status === "all" ? "" : "and t.status = ?";
    const parameters = status === "all" ? [ctx.userId] : [ctx.userId, status];
    return (
      this.db
        .prepare(
          `select t.*
             from aletheia_tasks t
             join aletheia_matters m
               on m.id = t.matter_id and m.user_id = t.user_id
            where t.user_id = ? ${statusClause}
            order by case t.priority when 'high' then 0 when 'normal' then 1 else 2 end,
                     t.due_at asc, t.created_at asc`,
        )
        .all(...parameters) as Record<string, unknown>[]
    ).map((item) => record(item));
  }

  completeTask(ctx: AletheiaUserContext, taskId: string) {
    return this.transitionTask(ctx, taskId, "completed");
  }

  reopenTask(ctx: AletheiaUserContext, taskId: string) {
    return this.transitionTask(ctx, taskId, "open");
  }

  private transitionTask(
    ctx: AletheiaUserContext,
    taskId: string,
    target: "open" | "completed",
  ) {
    const existing = this.db
      .prepare("select * from aletheia_tasks where id = ? and user_id = ?")
      .get(taskId, ctx.userId) as Record<string, unknown> | undefined;
    if (!existing) return null;
    if (existing.invalidated_at) {
      throw new LitigationValidationError(
        "An invalidated deadline task cannot change state.",
      );
    }
    if (existing.status === target) {
      return { task: record(existing), changed: false };
    }
    const timestamp = now();
    const result = this.db
      .prepare(
        `update aletheia_tasks
            set status = ?, completed_at = ?, updated_at = ?
          where id = ? and user_id = ? and status = ?`,
      )
      .run(
        target,
        target === "completed" ? timestamp : null,
        timestamp,
        taskId,
        ctx.userId,
        target === "completed" ? "open" : "completed",
      );
    const task = this.db
      .prepare("select * from aletheia_tasks where id = ? and user_id = ?")
      .get(taskId, ctx.userId) as Record<string, unknown> | undefined;
    return task
      ? { task: record(task), changed: Boolean(result.changes) }
      : null;
  }
}
