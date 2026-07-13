import { createHash } from "node:crypto";

const MAX_FACTS = 12_000;
const MAX_QUESTION = 2_000;
const MAX_QUERY = 600;
const MAX_PROTECTED_TERM = 240;
const MAX_FINDINGS = 40;

export type LegalResearchRequestInput = {
  title: string;
  facts: string;
  jurisdiction: string;
  asOfDate: string;
  question: string;
};

export type ResearchQueryPreview = {
  query: string;
  queryHash: `sha256:${string}`;
  redactions: number;
  jurisdiction: string;
  asOfDate: string;
};

export type LegalResearchCitation = {
  snapshotId: string;
  quote: string;
  sourceType: "statute" | "judicial_interpretation" | "case" | "manual";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  caseVerificationStatus?: "verified" | "unverified" | null;
};

export type LegalResearchFinding = {
  conclusion: string;
  citations: LegalResearchCitation[];
  confidence: "high" | "medium" | "low";
  uncertainty: string | null;
  position: "supporting" | "adverse" | "neutral";
};

export type LegalResearchGate = {
  status: "ready_for_review" | "insufficient_basis";
  reasons: string[];
};

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function bounded(value: unknown, maximum: number, label: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters.`);
  }
  return text;
}

function requiredIsoDate(value: unknown, label: string) {
  const date = bounded(value, 10, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label} is invalid.`);
  }
  return date;
}

export function normalizeLegalResearchRequest(
  input: LegalResearchRequestInput,
) {
  return {
    title: bounded(input.title, 240, "title"),
    facts: bounded(input.facts, MAX_FACTS, "facts"),
    jurisdiction: bounded(input.jurisdiction, 120, "jurisdiction"),
    asOfDate: requiredIsoDate(input.asOfDate, "asOfDate"),
    question: bounded(input.question, MAX_QUESTION, "question"),
  };
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The broker never accepts matter facts. It accepts only a lawyer-visible
 * research query and removes supplied client identifiers plus common direct
 * identifiers before the query can leave the local machine.
 */
export function previewResearchQuery(input: {
  query: string;
  protectedTerms?: string[];
  jurisdiction: string;
  asOfDate: string;
}): ResearchQueryPreview {
  let query = bounded(input.query, MAX_QUERY, "query").replace(/\s+/g, " ");
  const jurisdiction = bounded(input.jurisdiction, 120, "jurisdiction");
  const asOfDate = requiredIsoDate(input.asOfDate, "asOfDate");
  const protectedTerms = [...new Set(
    (input.protectedTerms ?? [])
      .filter((term): term is string => typeof term === "string")
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && term.length <= MAX_PROTECTED_TERM),
  )].sort((left, right) => right.length - left.length);
  let redactions = 0;
  for (const term of protectedTerms) {
    const pattern = new RegExp(escapedPattern(term), "giu");
    query = query.replace(pattern, () => {
      redactions += 1;
      return "[已脱敏]";
    });
  }
  const patterns = [
    /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu,
    /(?<!\d)1\d{10}(?!\d)/gu,
    /(?<!\d)\d{17}[\dXx](?!\d)/gu,
    /[（(]\d{4}[）)][^\s，。；;]{1,40}?号/gu,
    /(?:人民币|RMB|CNY|￥|¥)?\s*\d{1,12}(?:,\d{3})*(?:\.\d+)?\s*(?:元|万元|亿元)/giu,
    /20\d{2}年\d{1,2}月\d{1,2}日/gu,
    /(?<!\d)20\d{2}-\d{1,2}-\d{1,2}(?!\d)/gu,
    /[\p{Script=Han}]{2,12}(?:省|自治区|特别行政区|市)(?:[\p{Script=Han}]{1,12}(?:区|县|镇|街道|路|号))?/gu,
  ];
  for (const pattern of patterns) {
    query = query.replace(pattern, () => {
      redactions += 1;
      return "[已脱敏]";
    });
  }
  query = query.replace(/\s+/g, " ").trim();
  const meaningful = query.replace(/\[已脱敏\]|[\s\p{P}]/gu, "");
  if (meaningful.length < 2) {
    throw new Error("The redacted query no longer contains enough public legal terms.");
  }
  return {
    query,
    queryHash: sha256(`${jurisdiction}\n${asOfDate}\n${query}`),
    redactions,
    jurisdiction,
    asOfDate,
  };
}

function citationApplicableAsOf(
  citation: LegalResearchCitation,
  asOfDate: string,
) {
  if (citation.effectiveFrom && citation.effectiveFrom > asOfDate) return false;
  if (citation.effectiveTo && citation.effectiveTo < asOfDate) return false;
  return true;
}

/**
 * This gate is deliberately deterministic. A model can propose conclusions,
 * but a final research memo cannot rely on a conclusion with no exact local
 * snapshot quote or a source that is inapplicable on the requested date.
 */
export function evaluateLegalResearchGate(input: {
  asOfDate: string;
  findings: LegalResearchFinding[];
}): LegalResearchGate {
  const asOfDate = requiredIsoDate(input.asOfDate, "asOfDate");
  if (!Array.isArray(input.findings) || input.findings.length === 0) {
    return {
      status: "insufficient_basis",
      reasons: ["No source-supported legal conclusion was produced."],
    };
  }
  if (input.findings.length > MAX_FINDINGS) {
    return {
      status: "insufficient_basis",
      reasons: ["The finding set exceeds the bounded review limit."],
    };
  }
  const reasons: string[] = [];
  input.findings.forEach((finding, index) => {
    if (!finding.conclusion?.trim()) {
      reasons.push(`Finding ${index + 1} has no conclusion.`);
      return;
    }
    if (!Array.isArray(finding.citations) || finding.citations.length === 0) {
      reasons.push(`Finding ${index + 1} has no local source snapshot.`);
      return;
    }
    finding.citations.forEach((citation, citationIndex) => {
      if (!citation.snapshotId?.trim() || !citation.quote?.trim()) {
        reasons.push(
          `Finding ${index + 1} citation ${citationIndex + 1} lacks a snapshot or exact quote.`,
        );
      } else if (!citationApplicableAsOf(citation, asOfDate)) {
        reasons.push(
          `Finding ${index + 1} citation ${citationIndex + 1} is not applicable on ${asOfDate}.`,
        );
      } else if (
        citation.sourceType === "case" &&
        citation.caseVerificationStatus !== "verified"
      ) {
        reasons.push(
          `Finding ${index + 1} citation ${citationIndex + 1} uses an unverified case number.`,
        );
      }
    });
  });
  return reasons.length
    ? { status: "insufficient_basis", reasons }
    : { status: "ready_for_review", reasons: [] };
}
