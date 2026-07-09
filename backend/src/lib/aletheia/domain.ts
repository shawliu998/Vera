export const TEMPLATES = new Set([
  "legal_matter_review",
  "compliance_impact_review",
  "deal_due_diligence",
]);

export const MATTER_STATUSES = new Set([
  "draft",
  "in_progress",
  "needs_review",
  "completed",
  "archived",
]);

export const RISK_LEVELS = new Set(["low", "medium", "high"]);

export const REVIEW_TARGET_TYPES = new Set([
  "claim",
  "evidence",
  "memo_section",
  "work_product",
  "matter",
]);

export const REVIEW_TAGS = new Set([
  "unsupported_claim",
  "citation_not_supporting",
  "missing_fact",
  "overclaim",
  "outdated_authority",
  "conflicting_evidence",
  "needs_human_judgment",
  "accepted",
  "rejected",
]);

export const EVIDENCE_RELEVANCE = new Set(["direct", "indirect", "weak"]);

export const EVIDENCE_SUPPORT_STATUS = new Set([
  "supports",
  "contradicts",
  "insufficient",
]);

export const MATTER_MEMORY_CATEGORIES = new Set([
  "confirmed_fact",
  "output_preference",
  "excluded_path",
  "missing_material",
  "reviewer_feedback",
]);

export const PLAYBOOK_STATUSES = new Set(["draft", "approved", "superseded"]);

export const WORK_PRODUCT_KINDS = new Set([
  "agent_plan",
  "chronology",
  "issue_map",
  "evidence_matrix",
  "draft_memo",
  "final_memo",
  "compliance_register",
  "red_flag_memo",
  "audit_pack",
  "feedback_export",
  "registry_snapshot",
]);

export const WORK_PRODUCT_STATUSES = new Set([
  "draft",
  "generated",
  "needs_review",
  "accepted",
  "superseded",
]);

export const GENERATED_BY = new Set(["system", "agent", "human"]);
export const ACTORS = new Set(["system", "agent", "human"]);

export type Actor = "system" | "agent" | "human";

export function text(value: unknown, max = 400) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export function nullableText(value: unknown, max = 400) {
  const cleaned = text(value, max);
  return cleaned || null;
}

export function objectPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function arrayPayload(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function cleanSharedEmails(value: unknown, ownerEmail?: string) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    if (ownerEmail && email === ownerEmail) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

export function auditActionForWorkProduct(kind: string) {
  if (kind === "audit_pack") return "audit_pack_exported";
  if (kind === "feedback_export") return "feedback_dataset_exported";
  if (kind === "issue_map") return "issue_map_generated";
  if (kind === "evidence_matrix") return "evidence_matrix_generated";
  if (kind === "draft_memo") return "memo_generated";
  if (kind === "final_memo") return "final_memo_exported";
  if (kind === "compliance_register") return "compliance_register_generated";
  if (kind === "red_flag_memo") return "red_flag_memo_generated";
  if (kind === "registry_snapshot") return "registry_snapshot_saved";
  return "work_product_saved";
}

export const GATE_SNAPSHOT_SCHEMA_VERSION = "aletheia-gate-snapshot-v0";

export const GATE_AUDIT_ACTIONS = {
  resultsPersisted: "gate_results_persisted",
  finalExportAuthorized: "final_export_gate_authorized",
  finalExportBlocked: "final_export_gate_blocked",
} as const;

const GATE_TYPES = new Set([
  "citation",
  "human_approval",
  "missing_material",
  "conflict",
  "jurisdiction",
  "privilege",
  "export",
]);

const GATE_STATUSES = new Set(["passed", "failed", "warning", "skipped"]);

const GATE_SOURCE_REF_TYPES = new Set([
  "work_product",
  "evidence_item",
  "review_item",
  "human_checkpoint",
  "audit_event",
  "agent_run",
  "matter_memory",
  "document",
  "matter",
]);

const GATE_SOURCE_REF_ROLES = new Set([
  "input",
  "approval",
  "blocker",
  "audit",
  "provenance",
]);

type GateSnapshotSourceRef = {
  type: string;
  id: string;
  role: string;
  document_id?: string | null;
  source_chunk_id?: string | null;
  quote_start?: number | null;
  quote_end?: number | null;
  claim_id?: string | null;
};

type GateSnapshotResult = {
  id: string;
  matter_id: string;
  gate_type: string;
  status: string;
  reason: string;
  affected_artifact_ids: string[];
  required_action?: string;
  created_at: string;
};

type GateSnapshotProvenance = {
  gate_id: string;
  gate_type: string;
  status: string;
  displayed_reason: string;
  source_record_refs: GateSnapshotSourceRef[];
  unresolved_source_requirements: string[];
};

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sanitizeGateResults(value: unknown, matterId: string) {
  if (!Array.isArray(value)) return [];
  const results: GateSnapshotResult[] = [];
  for (const item of value) {
    const record = recordOrEmpty(item);
    const id = stringOrNull(record.id);
    const gateType = stringOrNull(record.gate_type);
    const status = stringOrNull(record.status);
    if (!id || !gateType || !status) continue;
    if (!GATE_TYPES.has(gateType) || !GATE_STATUSES.has(status)) continue;
    results.push({
      id,
      matter_id: stringOrNull(record.matter_id) ?? matterId,
      gate_type: gateType,
      status,
      reason: stringOrNull(record.reason) ?? "",
      affected_artifact_ids: stringArray(record.affected_artifact_ids),
      required_action: stringOrNull(record.required_action) ?? undefined,
      created_at: stringOrNull(record.created_at) ?? new Date().toISOString(),
    });
  }
  return results;
}

function sanitizeGateSourceRefs(value: unknown) {
  if (!Array.isArray(value)) return [];
  const refs: GateSnapshotSourceRef[] = [];
  for (const item of value) {
    const record = recordOrEmpty(item);
    const type = stringOrNull(record.type);
    const id = stringOrNull(record.id);
    const role = stringOrNull(record.role);
    if (!type || !id || !role) continue;
    if (!GATE_SOURCE_REF_TYPES.has(type) || !GATE_SOURCE_REF_ROLES.has(role)) {
      continue;
    }
    refs.push({
      type,
      id,
      role,
      document_id: stringOrNull(record.document_id),
      source_chunk_id: stringOrNull(record.source_chunk_id),
      quote_start: numberOrNull(record.quote_start),
      quote_end: numberOrNull(record.quote_end),
      claim_id: stringOrNull(record.claim_id),
    });
  }
  return refs;
}

function sanitizeGateProvenance(value: unknown) {
  if (!Array.isArray(value)) return [];
  const provenance: GateSnapshotProvenance[] = [];
  for (const item of value) {
    const record = recordOrEmpty(item);
    const gateId = stringOrNull(record.gate_id);
    const gateType = stringOrNull(record.gate_type);
    const status = stringOrNull(record.status);
    if (!gateId || !gateType || !status) continue;
    if (!GATE_TYPES.has(gateType) || !GATE_STATUSES.has(status)) continue;
    provenance.push({
      gate_id: gateId,
      gate_type: gateType,
      status,
      displayed_reason: stringOrNull(record.displayed_reason) ?? "",
      source_record_refs: sanitizeGateSourceRefs(record.source_record_refs),
      unresolved_source_requirements: stringArray(
        record.unresolved_source_requirements,
      ),
    });
  }
  return provenance;
}

function gateSnapshotSummary(results: GateSnapshotResult[]) {
  return {
    total: results.length,
    passed: results.filter((gate) => gate.status === "passed").length,
    warnings: results.filter((gate) => gate.status === "warning").length,
    failed: results.filter((gate) => gate.status === "failed").length,
    skipped: results.filter((gate) => gate.status === "skipped").length,
  };
}

export function buildGateSnapshotAuditDetails(args: {
  matterId: string;
  action: "final_memo_export";
  approvalCheckpointId?: string | null;
  content: Record<string, unknown>;
}) {
  const gateResults = sanitizeGateResults(
    args.content.gateResults,
    args.matterId,
  );
  const gateProvenance = sanitizeGateProvenance(args.content.gateProvenance);
  const provenanceByGateId = new Map(
    gateProvenance.map((item) => [item.gate_id, item] as const),
  );
  const failures: string[] = [];

  if (gateResults.length === 0) {
    failures.push("No gateResults were provided for persisted gate snapshot.");
  }

  const exportGate = gateResults.find((gate) => gate.gate_type === "export");
  if (!exportGate || exportGate.status !== "passed") {
    failures.push("Final memo export gate must be present and passed.");
  }

  for (const gate of gateResults) {
    if (gate.status === "failed") {
      failures.push(`Gate ${gate.id} failed: ${gate.reason}`);
    }
    const provenance = provenanceByGateId.get(gate.id);
    if (!provenance) {
      failures.push(`Gate ${gate.id} has no persisted provenance map.`);
      continue;
    }
    if (
      provenance.status !== gate.status ||
      provenance.gate_type !== gate.gate_type
    ) {
      failures.push(`Gate ${gate.id} provenance does not match gate result.`);
    }
    if (provenance.source_record_refs.length === 0) {
      failures.push(`Gate ${gate.id} has no source record refs.`);
    }
    if (provenance.unresolved_source_requirements.length > 0) {
      failures.push(
        `Gate ${gate.id} has unresolved source requirements: ${provenance.unresolved_source_requirements.join("; ")}`,
      );
    }
  }

  const approvalGateRefs = gateProvenance
    .filter((item) => ["human_approval", "export"].includes(item.gate_type))
    .flatMap((item) => item.source_record_refs)
    .filter((ref) => ref.type === "human_checkpoint");
  if (args.approvalCheckpointId) {
    const linked = approvalGateRefs.some(
      (ref) => ref.id === args.approvalCheckpointId && ref.role === "approval",
    );
    if (!linked) {
      failures.push(
        "Passed final memo approval/export gates must reference the approved checkpoint.",
      );
    }
  }

  const details = {
    schemaVersion: GATE_SNAPSHOT_SCHEMA_VERSION,
    action: args.action,
    matterId: args.matterId,
    approvalCheckpointId: args.approvalCheckpointId ?? null,
    sourceDraftMemoId: stringOrNull(args.content.sourceDraftMemoId),
    gateResults,
    gateProvenance,
    gateSummary: gateSnapshotSummary(gateResults),
    authorization: {
      status: failures.length === 0 ? "passed" : "blocked",
      failureReasons: failures,
      requiresPersistedAuditEvent: true,
      requiresApprovedCheckpoint: true,
      frontendOnlyPayloadAccepted: false,
    },
  };

  return {
    ok: failures.length === 0,
    details,
    failures,
  };
}

export function professionalDraftProfileForTemplate(template: string) {
  if (template === "compliance_impact_review") {
    return {
      kind: "compliance_register",
      schemaVersion: "aletheia-compliance-register-v0",
      titleSuffix: "Compliance Register",
      draftStepTitle: "Build compliance register",
      auditEvent: "compliance_register_generated",
      disclaimer:
        "This compliance register is generated from mapped source evidence. It requires expert validation before it is used as regulatory advice or implementation instruction.",
      findingLabel: "Obligation / control finding",
      sectionTitles: {
        executive: "1. Obligation Summary",
        source: "2. Source and Control Evidence",
        findings: "3. Business Impact and Gap Register",
        risks: "4. Remediation Risks and Missing Materials",
        checklist: "5. Reviewer Checklist",
      },
      checklist: [
        "Verify each obligation against the authoritative regulation, policy, or control document.",
        "Confirm business owner, system scope, effective date, and control evidence before assigning remediation.",
        "Resolve every contradictory or insufficient evidence item before relying on the register.",
        "Decide whether external legal or compliance guidance is required before final circulation.",
      ],
    };
  }

  if (template === "deal_due_diligence") {
    return {
      kind: "red_flag_memo",
      schemaVersion: "aletheia-red-flag-memo-v0",
      titleSuffix: "Red Flag Memo",
      draftStepTitle: "Draft diligence red flag memo",
      auditEvent: "red_flag_memo_generated",
      disclaimer:
        "This red flag memo is generated from mapped diligence evidence. It is not a final transaction recommendation and requires expert verification.",
      findingLabel: "Diligence red flag",
      sectionTitles: {
        executive: "1. Red Flag Summary",
        source: "2. Source Record and VDR Coverage",
        findings: "3. Contract and Diligence Findings",
        risks: "4. Open Diligence Questions",
        checklist: "5. Reviewer Checklist",
      },
      checklist: [
        "Verify each red flag against the cited VDR source document and quote.",
        "Confirm whether disclosure schedules, Q&A, or management responses change the risk characterization.",
        "Resolve every contradictory or insufficient evidence item before deal-team reliance.",
        "Decide whether specialist tax, employment, IP, regulatory, or litigation review is required.",
      ],
    };
  }

  return {
    kind: "draft_memo",
    schemaVersion: "aletheia-draft-memo-v0",
    titleSuffix: "Draft Memo",
    draftStepTitle: "Draft review memo",
    auditEvent: "memo_generated",
    disclaimer:
      "This is a review draft generated from mapped evidence. It is not a final legal opinion and requires expert verification.",
    findingLabel: "Evidence-based finding",
    sectionTitles: {
      executive: "1. Executive Summary",
      source: "2. Source Record",
      findings: "3. Evidence-Based Findings",
      risks: "4. Risks, Gaps, and Contradictions",
      checklist: "5. Reviewer Checklist",
    },
    checklist: [
      "Verify that each quoted passage supports the assigned claim.",
      "Confirm page, section, and quote offsets against the uploaded source files.",
      "Resolve every contradictory or insufficient evidence item.",
      "Decide whether additional legal research, jurisdiction assumptions, or client instructions are required.",
    ],
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function stringArrayPayload(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function normalizedFactFromQuote(value: unknown) {
  const quote =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!quote) return "";
  const firstSentence =
    quote.match(/^(.{40,240}?[.!?])\s/)?.[1] ??
    quote.slice(0, 220).replace(/[,;:\s]+$/, "");
  return firstSentence.length < quote.length
    ? `${firstSentence}`
    : firstSentence;
}

export function deriveClaimSuggestionFromText(
  value: unknown,
  fallback = "claim-source-evidence",
) {
  const textValue = typeof value === "string" ? value : "";
  const normalized = textValue.toLowerCase();
  const patterns: Array<{ id: string; title: string; terms: string[] }> = [
    {
      id: "claim-termination-notice",
      title: "Termination notice requirement",
      terms: ["termination", "notice"],
    },
    {
      id: "claim-renewal-ambiguity",
      title: "Renewal ambiguity",
      terms: ["renewal", "ambiguous"],
    },
    {
      id: "claim-board-approval",
      title: "Board approval requirement",
      terms: ["board", "approval"],
    },
    {
      id: "claim-indemnity-survival",
      title: "Indemnity survival",
      terms: ["indemnity", "survives"],
    },
    {
      id: "claim-breach-notification",
      title: "Breach notification obligation",
      terms: ["breach", "notification"],
    },
    {
      id: "claim-data-security-incident",
      title: "Data security incident obligation",
      terms: ["security", "incident"],
    },
    {
      id: "claim-liability-cap",
      title: "Liability cap",
      terms: ["liability", "cap"],
    },
    {
      id: "claim-governing-law",
      title: "Governing law",
      terms: ["governing", "law"],
    },
  ];
  const match = patterns.find((pattern) =>
    pattern.terms.every((term) => normalized.includes(term)),
  );
  if (match) {
    return {
      claimId: match.id,
      issueTitle: match.title,
      confidence: "medium",
      source: "deterministic_keyword_rules",
    };
  }

  const tokens = normalized.match(/[a-z0-9]+/g) ?? [];
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "shall",
    "must",
    "will",
    "may",
    "are",
    "was",
    "were",
    "has",
    "have",
    "not",
    "but",
    "before",
    "after",
  ]);
  const claimTokens = tokens
    .filter((token) => token.length > 3 && !stopWords.has(token))
    .slice(0, 4);
  const suffix = claimTokens.length ? claimTokens.join("-") : fallback;
  return {
    claimId: suffix.startsWith("claim-") ? suffix : `claim-${suffix}`,
    issueTitle: claimTokens.length
      ? claimTokens
          .map((token) => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`)
          .join(" ")
      : "Source evidence issue",
    confidence: claimTokens.length ? "low" : "low",
    source: "deterministic_text_slug",
  };
}

export function buildSourceLinkedIssueMapContent(args: {
  matter: {
    id: string;
    title: string;
    objective: string;
    template: string;
    risk_level?: string | null;
  };
  evidence: Array<Record<string, unknown>>;
}) {
  const evidence = args.evidence.map((item) => ({
    id: String(item.id),
    claimId: stringOrNull(item.claim_id) ?? "unassigned",
    suggestedIssueTitle:
      stringOrNull(
        recordOrEmpty(recordOrEmpty(item.metadata).claimSuggestion).issueTitle,
      ) ?? stringOrNull(recordOrEmpty(item.metadata).suggestedIssueTitle),
    documentId: stringOrNull(item.document_id),
    sourceChunkId: stringOrNull(item.source_chunk_id),
    documentName: stringOrNull(item.document_name),
    page: numberOrNull(item.page),
    section: stringOrNull(item.section),
    quote: typeof item.quote === "string" ? item.quote : "",
    relevance: stringOrNull(item.relevance) ?? "direct",
    supportStatus: stringOrNull(item.support_status) ?? "insufficient",
    confidence: stringOrNull(item.confidence),
    createdAt: stringOrNull(item.created_at),
  }));

  const claimsById = new Map<string, typeof evidence>();
  for (const item of evidence) {
    claimsById.set(item.claimId, [
      ...(claimsById.get(item.claimId) ?? []),
      item,
    ]);
  }

  const issues = Array.from(claimsById.entries()).map(([claimId, items]) => {
    const sourceDocuments = Array.from(
      new Set(
        items
          .map((item) => item.documentName)
          .filter((name): name is string => Boolean(name)),
      ),
    );
    const supportSummary = {
      supports: items.filter((item) => item.supportStatus === "supports")
        .length,
      contradicts: items.filter((item) => item.supportStatus === "contradicts")
        .length,
      insufficient: items.filter(
        (item) => item.supportStatus === "insufficient",
      ).length,
    };
    const reviewStatus =
      supportSummary.contradicts > 0 || supportSummary.insufficient > 0
        ? "needs_human_review"
        : "source_linked";
    return {
      id: claimId,
      title:
        items.find((item) => item.suggestedIssueTitle)?.suggestedIssueTitle ??
        claimId
          .replace(/^claim[-_:]/, "")
          .replaceAll(/[-_]+/g, " ")
          .replace(/\b\w/g, (letter) => letter.toUpperCase()),
      claimId,
      issueType: "source_backed_claim",
      supportSummary,
      evidenceIds: items.map((item) => item.id),
      sourceChunkIds: items
        .map((item) => item.sourceChunkId)
        .filter((id): id is string => Boolean(id)),
      sourceDocuments,
      representativeQuotes: items.slice(0, 3).map((item) => ({
        evidenceId: item.id,
        documentName: item.documentName,
        page: item.page,
        quote: item.quote,
        supportStatus: item.supportStatus,
      })),
      reviewStatus,
      openQuestions:
        reviewStatus === "needs_human_review"
          ? [
              "Resolve contradictory or insufficient evidence before relying on this issue.",
              "Confirm whether additional client documents or legal research are required.",
            ]
          : [
              "Confirm the cited quote still supports the professional framing of this issue.",
            ],
    };
  });

  return {
    schemaVersion: "aletheia-issue-map-v0",
    generatedAt: new Date().toISOString(),
    source: "persisted_evidence_items",
    matter: {
      id: args.matter.id,
      title: args.matter.title,
      template: args.matter.template,
      objective: args.matter.objective,
      riskLevel: args.matter.risk_level ?? null,
    },
    summary: {
      issues: issues.length,
      evidenceItems: evidence.length,
      needsHumanReview: issues.filter(
        (issue) => issue.reviewStatus === "needs_human_review",
      ).length,
      sourceDocuments: Array.from(
        new Set(
          evidence
            .map((item) => item.documentName)
            .filter((name): name is string => Boolean(name)),
        ),
      ),
    },
    issues,
    controls: {
      finalReliance: "blocked_until_human_review",
      evidenceRequired: true,
      crossMatterMemory: "disabled",
    },
  };
}

export function buildSourceLinkedEvidenceMatrixContent(args: {
  matter: {
    id: string;
    title: string;
    objective: string;
    template: string;
    risk_level?: string | null;
  };
  evidence: Array<Record<string, unknown>>;
}) {
  const evidence = args.evidence
    .map((item) => ({
      metadata: recordOrEmpty(item.metadata),
      id: String(item.id),
      claimId: stringOrNull(item.claim_id),
      documentId: stringOrNull(item.document_id),
      sourceChunkId: stringOrNull(item.source_chunk_id),
      documentName: stringOrNull(item.document_name),
      page: numberOrNull(item.page),
      section: stringOrNull(item.section),
      quote: typeof item.quote === "string" ? item.quote : "",
      quoteStart: numberOrNull(item.quote_start),
      quoteEnd: numberOrNull(item.quote_end),
      relevance: stringOrNull(item.relevance) ?? "direct",
      supportStatus: stringOrNull(item.support_status) ?? "insufficient",
      confidence: stringOrNull(item.confidence),
      createdAt: stringOrNull(item.created_at),
    }))
    .map((item) => ({
      id: item.id,
      claimId: item.claimId,
      supportsClaim: item.claimId,
      documentId: item.documentId,
      sourceChunkId: item.sourceChunkId,
      documentName: item.documentName,
      page: item.page,
      section: item.section,
      quote: item.quote,
      quoteStart: item.quoteStart,
      quoteEnd: item.quoteEnd,
      normalizedFact:
        stringOrNull(item.metadata.normalizedFact) ??
        normalizedFactFromQuote(item.quote),
      relevance: item.relevance,
      supportStatus: item.supportStatus,
      confidence:
        item.confidence ??
        (item.supportStatus === "supports" && item.relevance === "direct"
          ? "medium"
          : "low"),
      reviewStatus:
        item.supportStatus === "supports" ? "unreviewed" : "needs_human_review",
      sensitiveMaterialFlags: stringArrayPayload(
        item.metadata.sensitiveMaterialFlags,
      ),
      metadata: item.metadata,
      createdAt: item.createdAt,
    }));

  const counts = {
    total: evidence.length,
    supports: evidence.filter((item) => item.supportStatus === "supports")
      .length,
    contradicts: evidence.filter((item) => item.supportStatus === "contradicts")
      .length,
    insufficient: evidence.filter(
      (item) => item.supportStatus === "insufficient",
    ).length,
    direct: evidence.filter((item) => item.relevance === "direct").length,
    indirect: evidence.filter((item) => item.relevance === "indirect").length,
    weak: evidence.filter((item) => item.relevance === "weak").length,
  };

  const claimsById = new Map<string, typeof evidence>();
  for (const item of evidence) {
    const claimId = item.claimId ?? "unassigned";
    claimsById.set(claimId, [...(claimsById.get(claimId) ?? []), item]);
  }

  const claims = Array.from(claimsById.entries()).map(([claimId, items]) => ({
    claimId,
    evidenceIds: items.map((item) => item.id),
    sourceChunkIds: items
      .map((item) => item.sourceChunkId)
      .filter((id): id is string => Boolean(id)),
    supportSummary: {
      supports: items.filter((item) => item.supportStatus === "supports")
        .length,
      contradicts: items.filter((item) => item.supportStatus === "contradicts")
        .length,
      insufficient: items.filter(
        (item) => item.supportStatus === "insufficient",
      ).length,
    },
    reviewStatus:
      items.some((item) => item.supportStatus === "contradicts") ||
      items.some((item) => item.supportStatus === "insufficient")
        ? "needs_human_review"
        : "source_linked",
  }));

  return {
    schemaVersion: "aletheia-evidence-matrix-v0",
    generatedAt: new Date().toISOString(),
    source: "persisted_evidence_items",
    matter: {
      id: args.matter.id,
      title: args.matter.title,
      template: args.matter.template,
      objective: args.matter.objective,
      riskLevel: args.matter.risk_level ?? null,
    },
    summary: counts,
    claims,
    evidence,
  };
}

export function buildDeterministicDraftMemoContent(args: {
  matter: {
    id: string;
    title: string;
    objective: string;
    template: string;
    risk_level?: string | null;
  };
  evidenceMatrix: Record<string, unknown>;
  matrixWorkProductId?: string | null;
}) {
  const profile = professionalDraftProfileForTemplate(args.matter.template);
  const summary = recordOrEmpty(args.evidenceMatrix.summary);
  const claims = arrayOfRecords(args.evidenceMatrix.claims);
  const evidence = arrayOfRecords(args.evidenceMatrix.evidence);
  const supportingEvidence = evidence.filter(
    (item) => item.supportStatus === "supports",
  );
  const contraryEvidence = evidence.filter(
    (item) => item.supportStatus === "contradicts",
  );
  const insufficientEvidence = evidence.filter(
    (item) => item.supportStatus === "insufficient",
  );
  const directEvidence = evidence.filter((item) => item.relevance === "direct");

  const evidenceIds = evidence
    .map((item) => stringOrNull(item.id))
    .filter((id): id is string => Boolean(id));
  const claimIds = claims
    .map((item) => stringOrNull(item.claimId))
    .filter((id): id is string => Boolean(id));
  const citedDocuments = Array.from(
    new Set(
      evidence
        .map((item) => stringOrNull(item.documentName))
        .filter((name): name is string => Boolean(name)),
    ),
  );

  const sourceLine = citedDocuments.length
    ? `The current draft is grounded in ${evidence.length} mapped evidence item(s) from ${citedDocuments.length} source document(s): ${citedDocuments.join(", ")}.`
    : "The current draft has no cited source documents and must not be used as a professional conclusion.";

  const gapLine =
    insufficientEvidence.length > 0 || contraryEvidence.length > 0
      ? `Human review is required because ${insufficientEvidence.length} item(s) are insufficient and ${contraryEvidence.length} item(s) contradict mapped claims.`
      : "No contradictory or insufficient evidence is currently mapped, but reviewer verification is still required before reliance.";

  return {
    schemaVersion: profile.schemaVersion,
    generatedAt: new Date().toISOString(),
    source: "deterministic_evidence_matrix",
    sourceWorkProductId: args.matrixWorkProductId ?? null,
    matter: {
      id: args.matter.id,
      title: args.matter.title,
      template: args.matter.template,
      objective: args.matter.objective,
      riskLevel: args.matter.risk_level ?? null,
    },
    title: `${args.matter.title} ${profile.titleSuffix}`,
    disclaimer: profile.disclaimer,
    sections: [
      {
        id: "memo-executive-summary",
        title: profile.sectionTitles.executive,
        body: [
          `Aletheia identified ${claimIds.length} claim group(s) and ${evidence.length} mapped evidence item(s) in the current evidence matrix.`,
          sourceLine,
          gapLine,
        ],
        evidenceIds,
        reviewStatus:
          insufficientEvidence.length > 0 || contraryEvidence.length > 0
            ? "needs_revision"
            : "unreviewed",
      },
      {
        id: "memo-source-record",
        title: profile.sectionTitles.source,
        body: [
          `The evidence matrix reports ${summary.total ?? evidence.length} total item(s), ${summary.direct ?? directEvidence.length} direct item(s), and ${summary.weak ?? 0} weak item(s).`,
          citedDocuments.length
            ? `Cited documents: ${citedDocuments.join(", ")}.`
            : "No cited documents are available in the matrix.",
        ],
        evidenceIds,
        reviewStatus: "unreviewed",
      },
      {
        id: "memo-findings",
        title: profile.sectionTitles.findings,
        body:
          claims.length > 0
            ? claims.map((claim) => {
                const claimId = stringOrNull(claim.claimId) ?? "unassigned";
                const support = recordOrEmpty(claim.supportSummary);
                return `${profile.findingLabel} ${claimId}: ${support.supports ?? 0} supporting, ${support.contradicts ?? 0} contradictory, and ${support.insufficient ?? 0} insufficient evidence item(s).`;
              })
            : ["No claim groups are present in the evidence matrix."],
        evidenceIds,
        reviewStatus:
          insufficientEvidence.length > 0 ? "needs_revision" : "unreviewed",
      },
      {
        id: "memo-risk-gaps",
        title: profile.sectionTitles.risks,
        body: [
          contraryEvidence.length
            ? `${contraryEvidence.length} evidence item(s) contradict mapped claims and should be resolved before the memo is used externally.`
            : "No contradictory evidence is currently mapped.",
          insufficientEvidence.length
            ? `${insufficientEvidence.length} evidence item(s) are marked insufficient and should be supplemented or excluded.`
            : "No insufficient evidence is currently mapped.",
        ],
        evidenceIds: [...contraryEvidence, ...insufficientEvidence]
          .map((item) => stringOrNull(item.id))
          .filter((id): id is string => Boolean(id)).length
          ? [...contraryEvidence, ...insufficientEvidence]
              .map((item) => stringOrNull(item.id))
              .filter((id): id is string => Boolean(id))
          : evidenceIds,
        reviewStatus:
          contraryEvidence.length > 0 || insufficientEvidence.length > 0
            ? "needs_revision"
            : "unreviewed",
      },
      {
        id: "memo-review-checklist",
        title: profile.sectionTitles.checklist,
        body: profile.checklist,
        evidenceIds,
        reviewStatus: "needs_revision",
      },
    ],
  };
}

export function buildAgentRunTraceScaffold(args: {
  workflow: string;
  goal: string;
  matterId: string;
}) {
  const draftProfile = professionalDraftProfileForTemplate(args.workflow);
  const sharedInput = {
    matterId: args.matterId,
    workflow: args.workflow,
    goal: args.goal,
  };

  return {
    steps: [
      {
        stepKey: "parse_documents",
        title: "Parse source documents",
        sequence: 1,
        status: "completed",
        input: sharedInput,
        output: {
          specialistRole: "Intake Parser",
          allowedTools: ["document_parse"],
          toolset: ["document_parse"],
          result: "Source documents parsed or marked as pending.",
        },
        validationErrors: [],
        toolCalls: [
          {
            toolName: "document_parse",
            riskLevel: "low",
            status: "completed",
            input: { matterId: args.matterId },
            output: { mode: "local_filesystem", externalNetwork: false },
          },
        ],
      },
      {
        stepKey: "search_evidence",
        title: "Search supporting evidence",
        sequence: 2,
        status: "completed",
        input: sharedInput,
        output: {
          specialistRole: "Evidence Mapper",
          allowedTools: ["local_search", "evidence_link"],
          toolset: ["local_search", "evidence_link"],
          result: "Mapped source chunks can be promoted to Evidence Items.",
        },
        validationErrors: [],
        toolCalls: [
          {
            toolName: "local_search",
            riskLevel: "low",
            status: "completed",
            input: { matterId: args.matterId, index: "sqlite_fts5" },
            output: { retrieval: "local_keyword_search" },
          },
          {
            toolName: "evidence_link",
            riskLevel: "medium",
            status: "completed",
            input: { matterId: args.matterId },
            output: { preservesSourceChunkIds: true },
          },
        ],
      },
      {
        stepKey: "build_issue_map",
        title: "Build issue map",
        sequence: 3,
        status: "completed",
        input: sharedInput,
        output: {
          specialistRole: "Evidence Mapper",
          allowedTools: ["work_product_create"],
          workProductKind: "issue_map",
          result:
            "Mapped evidence can be grouped into issue-level review units.",
        },
        validationErrors: [],
        toolCalls: [
          {
            toolName: "work_product_create",
            riskLevel: "medium",
            status: "completed",
            input: { kind: "issue_map" },
            output: { auditEvent: "issue_map_generated" },
          },
        ],
      },
      {
        stepKey: "build_evidence_matrix",
        title: "Build evidence matrix",
        sequence: 4,
        status: "completed",
        input: sharedInput,
        output: {
          specialistRole: "Evidence Mapper",
          allowedTools: ["work_product_create"],
          workProductKind: "evidence_matrix",
          result: "Evidence Items can be compiled into a reviewable matrix.",
        },
        validationErrors: [],
        toolCalls: [
          {
            toolName: "work_product_create",
            riskLevel: "medium",
            status: "completed",
            input: { kind: "evidence_matrix" },
            output: { auditEvent: "evidence_matrix_generated" },
          },
        ],
      },
      {
        stepKey: "draft_memo",
        title: draftProfile.draftStepTitle,
        sequence: 5,
        status: "completed",
        input: sharedInput,
        output: {
          specialistRole: "Memo Drafter",
          allowedTools: ["work_product_create"],
          workProductKind: draftProfile.kind,
          result: `${draftProfile.titleSuffix} generated for expert review, not final reliance.`,
        },
        validationErrors: [],
        toolCalls: [
          {
            toolName: "work_product_create",
            riskLevel: "high",
            status: "completed",
            input: { kind: draftProfile.kind },
            output: {
              auditEvent: draftProfile.auditEvent,
              requiresReview: true,
            },
          },
        ],
      },
      {
        stepKey: "human_review",
        title: "Human review checkpoint",
        sequence: 6,
        status: "needs_human",
        input: sharedInput,
        output: {
          specialistRole: "Risk Reviewer",
          allowedTools: ["review_add"],
          checkpoint: "review_before_reliance",
          result:
            "Expert approval is required before final memo or audit export.",
        },
        validationErrors: [],
        toolCalls: [
          {
            toolName: "review_add",
            riskLevel: "medium",
            status: "requires_confirmation",
            input: { targetType: "draft_memo" },
            output: { allowedWithoutApproval: false },
          },
        ],
      },
      {
        stepKey: "audit_export_gate",
        title: "Audit export approval gate",
        sequence: 7,
        status: "pending",
        input: sharedInput,
        output: {
          specialistRole: "Export Controller",
          allowedTools: ["audit_append"],
          checkpoint: "audit_pack_export",
          result: "Audit pack export remains blocked until human approval.",
        },
        validationErrors: [],
        toolCalls: [
          {
            toolName: "audit_append",
            riskLevel: "medium",
            status: "pending",
            input: { action: "audit_pack_export_requested" },
            output: {},
          },
        ],
      },
    ],
    checkpoints: [
      {
        stepKey: "human_review",
        checkpointType: "final_memo_review",
        status: "open",
        prompt:
          "Review the draft memo, evidence support, contradictions, and missing materials before external reliance or audit export.",
        requestedPayload: {
          requiredActions: [
            "verify_source_quotes",
            "resolve_insufficient_evidence",
            "approve_or_reject_final_memo",
          ],
        },
      },
    ],
  };
}

export function buildAgentWorkflowGraph(
  scaffold: ReturnType<typeof buildAgentRunTraceScaffold>,
) {
  const checkpointStepKeys = new Set(
    scaffold.checkpoints.map((checkpoint) => checkpoint.stepKey),
  );
  const nodes = scaffold.steps.map((step) => {
    const output = step.output as Record<string, unknown>;
    return {
      key: step.stepKey,
      type: checkpointStepKeys.has(step.stepKey)
        ? "human_checkpoint"
        : "agent_step",
      title: step.title,
      sequence: step.sequence,
      status: step.status,
      specialistRole:
        typeof output.specialistRole === "string"
          ? output.specialistRole
          : null,
      allowedTools: Array.isArray(output.allowedTools)
        ? output.allowedTools.filter(
            (tool): tool is string => typeof tool === "string",
          )
        : [],
      checkpoint:
        typeof output.checkpoint === "string" ? output.checkpoint : null,
      workProductKind:
        typeof output.workProductKind === "string"
          ? output.workProductKind
          : null,
    };
  });

  return {
    schemaVersion: "aletheia-workflow-graph-v0",
    graphType: "directed_runtime_trace",
    nodes,
    edges: scaffold.steps.slice(1).map((step, index) => {
      const previous = scaffold.steps[index];
      return {
        from: previous.stepKey,
        to: step.stepKey,
        condition:
          step.stepKey === "audit_export_gate"
            ? "requires_human_approval"
            : "on_success",
      };
    }),
    controls: {
      defaultToolPolicy: "allowlist_per_step",
      externalNetworkDefault: "disabled",
      destructiveActionsDefault: "disabled",
      humanApprovalRequiredFor: [
        "final_memo_export",
        "audit_pack_export",
        "feedback_dataset_export",
        "playbook_update",
        "external_source_use",
      ],
    },
  };
}

export function buildInitialAgentPlan(args: {
  matterId: string;
  template: string;
  objective: string;
  riskLevel: string | null;
}) {
  const shared = {
    matterId: args.matterId,
    template: args.template,
    objective: args.objective,
    riskLevel: args.riskLevel,
    assumptions: [
      "Inputs are incomplete until source documents are uploaded and parsed.",
      "The agent must expose missing materials before drafting conclusions.",
      "Human review is required before any professional work product is relied on.",
    ],
  };

  if (args.template === "compliance_impact_review") {
    return {
      ...shared,
      requiredDocuments: [
        "Regulation or policy source text",
        "Current controls and policies",
        "Business process map",
        "Data flow or system inventory",
        "Prior audit findings",
      ],
      missingMaterials: [
        "Authoritative regulatory source",
        "Control evidence",
        "Named business owners",
      ],
      steps: [
        "Regulation intake",
        "Obligation extraction",
        "Business mapping",
        "Gap assessment",
        "Risk scoring",
        "Remediation planning",
        "Human approval",
      ],
    };
  }

  if (args.template === "deal_due_diligence") {
    return {
      ...shared,
      requiredDocuments: [
        "VDR index",
        "Material contracts",
        "Cap table",
        "Litigation and dispute schedule",
        "Employment and IP materials",
      ],
      missingMaterials: [
        "Complete VDR export",
        "Disclosure schedules",
        "Management Q&A log",
      ],
      steps: [
        "Deal intake",
        "VDR indexing",
        "Red flag screening",
        "Contract matrix",
        "Evidence mapping",
        "Draft diligence memo",
        "Human review",
      ],
    };
  }

  return {
    ...shared,
    requiredDocuments: [
      "Operative agreements and amendments",
      "Correspondence",
      "Payment or performance records",
      "Demand or notice letters",
      "Procedural documents",
    ],
    missingMaterials: [
      "Executed source documents",
      "Known factual chronology",
      "Jurisdiction and governing-law assumptions",
    ],
    steps: [
      "Matter intake",
      "Chronology builder",
      "Issue spotting",
      "Evidence matrix",
      "Risk analysis",
      "Draft memo",
      "Human review",
    ],
  };
}
