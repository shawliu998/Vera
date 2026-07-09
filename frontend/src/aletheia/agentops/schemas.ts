import type {
  AgentRun,
  AgentRunStatus,
  ArtifactType,
  DraftMemo,
  DraftMemoSection,
  Matter,
  MatterType,
  RiskLevel,
} from "./types";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

type ArtifactShape = {
  id?: unknown;
  matter_id?: unknown;
  [key: string]: unknown;
};

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function hasString(value: unknown, field: string, errors: string[]) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function hasNumber(value: unknown, field: string, errors: string[]) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${field} must be a finite number`);
  }
}

function hasArray(value: unknown, field: string, errors: string[]) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
  }
}

export function computeArtifactId(
  artifactType: ArtifactType,
  matterId: string,
  seed: string,
) {
  const prefix = slugify(artifactType);
  const matter = slugify(matterId) || "matter";
  const suffix = hashString(`${artifactType}:${matterId}:${seed}`);
  return `${prefix}-${matter}-${suffix}`;
}

export function createDefaultMatter(params: {
  title: string;
  type?: MatterType;
  risk_level?: RiskLevel;
  now?: string;
  id?: string;
}): Matter {
  const now = params.now ?? new Date().toISOString();
  const id =
    params.id ??
    computeArtifactId("matter", slugify(params.title) || "untitled", now);

  return {
    id,
    title: params.title,
    type: params.type ?? "legal_review",
    risk_level: params.risk_level ?? "medium",
    status: "draft",
    documents: [],
    created_at: now,
    updated_at: now,
  };
}

export function createDefaultAgentRun(params: {
  matter_id: string;
  agent_id: string;
  id?: string;
  status?: AgentRunStatus;
  started_at?: string;
  model?: string;
}): AgentRun {
  const startedAt = params.started_at ?? new Date().toISOString();

  return {
    id:
      params.id ??
      computeArtifactId(
        "agent_run",
        params.matter_id,
        `${params.agent_id}:${startedAt}`,
      ),
    matter_id: params.matter_id,
    agent_id: params.agent_id,
    started_at: startedAt,
    status: params.status ?? "queued",
    input_artifacts: [],
    output_artifacts: [],
    tool_calls: [],
    trace_events: [],
    model: params.model,
    errors: [],
  };
}

export function validateArtifactShape(
  artifactType: ArtifactType,
  artifact: unknown,
): ValidationResult {
  const errors: string[] = [];
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return { ok: false, errors: [`${artifactType} must be an object`] };
  }

  const item = artifact as ArtifactShape;
  hasString(item.id, `${artifactType}.id`, errors);

  if (artifactType !== "matter" && artifactType !== "professional_skill") {
    hasString(item.matter_id, `${artifactType}.matter_id`, errors);
  }

  if (artifactType === "evidence_item") {
    hasString(item.source_document_id, "evidence_item.source_document_id", errors);
    hasString(item.quote, "evidence_item.quote", errors);
    hasString(item.normalized_fact, "evidence_item.normalized_fact", errors);
    hasArray(item.supports_claim_ids, "evidence_item.supports_claim_ids", errors);
    hasNumber(item.confidence, "evidence_item.confidence", errors);
  }

  if (artifactType === "draft_memo") {
    hasString(item.title, "draft_memo.title", errors);
    hasArray(item.sections, "draft_memo.sections", errors);
    hasNumber(
      item.citation_coverage_score,
      "draft_memo.citation_coverage_score",
      errors,
    );
    hasNumber(item.unsupported_claim_count, "draft_memo.unsupported_claim_count", errors);
  }

  if (artifactType === "gate_result") {
    hasString(item.gate_type, "gate_result.gate_type", errors);
    hasString(item.status, "gate_result.status", errors);
    hasString(item.reason, "gate_result.reason", errors);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function computeCitationCoverage(sections: DraftMemoSection[]) {
  if (sections.length === 0) {
    return {
      citation_coverage_score: 0,
      unsupported_claim_count: 0,
      cited_section_count: 0,
      total_section_count: 0,
    };
  }

  const citedSections = sections.filter(
    (section) => section.evidence_reference_ids.length > 0,
  );
  const unsupportedClaimCount = sections.reduce(
    (total, section) => total + (section.unsupported_claim_count ?? 0),
    0,
  );

  return {
    citation_coverage_score: Number(
      (citedSections.length / sections.length).toFixed(2),
    ),
    unsupported_claim_count: unsupportedClaimCount,
    cited_section_count: citedSections.length,
    total_section_count: sections.length,
  };
}

export function withComputedMemoCoverage(memo: DraftMemo): DraftMemo {
  const coverage = computeCitationCoverage(memo.sections);
  return {
    ...memo,
    citation_coverage_score: coverage.citation_coverage_score,
    unsupported_claim_count: coverage.unsupported_claim_count,
  };
}
