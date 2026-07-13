import { createHash } from "node:crypto";

export const LITIGATION_GROUNDED_HANDLER = "local_model.litigation_grounded";

export class LitigationGroundingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "GROUNDING_OUTPUT_INVALID"
      | "GROUNDING_CITATION_MISSING"
      | "GROUNDING_CITATION_UNKNOWN"
      | "GROUNDING_QUOTE_MISMATCH",
  ) {
    super(message);
    this.name = "LitigationGroundingError";
  }
}

type GroundedCitation = {
  sourceId: string;
  quote: string;
};

type GroundedFinding = {
  statement: string;
  citations: GroundedCitation[];
  confidence: "high" | "medium" | "low";
  uncertainty: string | null;
};

export type GroundedLitigationOutput = {
  summary: string;
  summaryCitations: GroundedCitation[];
  findings: GroundedFinding[];
  questionsForCounsel: string[];
};

function boundedText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function jsonText(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

export function parseGroundedLitigationOutput(args: {
  response: string;
  allowedSources: Array<{ id: string; quoteSha256: string }>;
}): GroundedLitigationOutput {
  const allowed = new Map(
    args.allowedSources.map((source) => [source.id, source.quoteSha256]),
  );
  const citations = (value: unknown, label: string) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
      throw new LitigationGroundingError(
        `${label} has no valid citation list.`,
        "GROUNDING_CITATION_MISSING",
      );
    }
    const result: GroundedCitation[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new LitigationGroundingError(
          `${label} has an invalid citation.`,
          "GROUNDING_OUTPUT_INVALID",
        );
      }
      const citation = item as Record<string, unknown>;
      const sourceId = boundedText(citation.sourceId, 256);
      const quote = boundedText(citation.quote, 8_000);
      if (!sourceId || !quote) {
        throw new LitigationGroundingError(
          `${label} citation requires sourceId and exact quote.`,
          "GROUNDING_CITATION_MISSING",
        );
      }
      const expectedHash = allowed.get(sourceId);
      if (!expectedHash) {
        throw new LitigationGroundingError(
          `${label} cites an unknown source: ${sourceId}`,
          "GROUNDING_CITATION_UNKNOWN",
        );
      }
      const actualHash = createHash("sha256").update(quote).digest("hex");
      if (actualHash !== expectedHash) {
        throw new LitigationGroundingError(
          `${label} quote does not match source: ${sourceId}`,
          "GROUNDING_QUOTE_MISMATCH",
        );
      }
      if (!seen.has(sourceId)) {
        result.push({ sourceId, quote });
        seen.add(sourceId);
      }
    }
    return result;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText(args.response));
  } catch {
    throw new LitigationGroundingError(
      "Litigation model output must be valid JSON.",
      "GROUNDING_OUTPUT_INVALID",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LitigationGroundingError(
      "Litigation model output must be a JSON object.",
      "GROUNDING_OUTPUT_INVALID",
    );
  }
  const record = parsed as Record<string, unknown>;
  const summary = boundedText(record.summary, 10_000);
  if (!summary || !Array.isArray(record.findings)) {
    throw new LitigationGroundingError(
      "Litigation model output requires summary and findings.",
      "GROUNDING_OUTPUT_INVALID",
    );
  }
  const summaryCitations = citations(
    record.summaryCitations,
    "Litigation summary",
  );
  if (record.findings.length === 0) {
    throw new LitigationGroundingError(
      "Litigation model output requires at least one cited finding.",
      "GROUNDING_OUTPUT_INVALID",
    );
  }
  if (record.findings.length > 100) {
    throw new LitigationGroundingError(
      "Litigation model output exceeds the 100-finding limit.",
      "GROUNDING_OUTPUT_INVALID",
    );
  }
  const findings = record.findings.map((item, index): GroundedFinding => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new LitigationGroundingError(
        `Finding ${index + 1} must be an object.`,
        "GROUNDING_OUTPUT_INVALID",
      );
    }
    const finding = item as Record<string, unknown>;
    const statement = boundedText(finding.statement, 4_000);
    if (!statement) {
      throw new LitigationGroundingError(
        `Finding ${index + 1} requires a statement.`,
        "GROUNDING_OUTPUT_INVALID",
      );
    }
    const findingCitations = citations(
      finding.citations,
      `Finding ${index + 1}`,
    );
    const confidence = finding.confidence;
    if (
      confidence !== "high" &&
      confidence !== "medium" &&
      confidence !== "low"
    ) {
      throw new LitigationGroundingError(
        `Finding ${index + 1} requires high, medium, or low confidence.`,
        "GROUNDING_OUTPUT_INVALID",
      );
    }
    const uncertainty =
      finding.uncertainty === null || finding.uncertainty === undefined
        ? null
        : boundedText(finding.uncertainty, 2_000);
    if (
      finding.uncertainty !== null &&
      finding.uncertainty !== undefined &&
      !uncertainty
    ) {
      throw new LitigationGroundingError(
        `Finding ${index + 1} has invalid uncertainty text.`,
        "GROUNDING_OUTPUT_INVALID",
      );
    }
    return {
      statement,
      citations: findingCitations,
      confidence,
      uncertainty,
    };
  });
  if (
    record.questionsForCounsel !== undefined &&
    !Array.isArray(record.questionsForCounsel)
  ) {
    throw new LitigationGroundingError(
      "questionsForCounsel must be an array.",
      "GROUNDING_OUTPUT_INVALID",
    );
  }
  if (
    Array.isArray(record.questionsForCounsel) &&
    record.questionsForCounsel.length > 50
  ) {
    throw new LitigationGroundingError(
      "Litigation model output exceeds the 50-question limit.",
      "GROUNDING_OUTPUT_INVALID",
    );
  }
  const questions = (record.questionsForCounsel ?? []).map(
    (item: unknown, index: number) => {
      const question = boundedText(item, 2_000);
      if (!question) {
        throw new LitigationGroundingError(
          `Question ${index + 1} is invalid.`,
          "GROUNDING_OUTPUT_INVALID",
        );
      }
      return question;
    },
  );
  return {
    summary,
    summaryCitations,
    findings,
    questionsForCounsel: questions,
  };
}

export function renderGroundedLitigationOutput(
  output: GroundedLitigationOutput,
) {
  return [
    `${output.summary} [${output.summaryCitations.map((item) => item.sourceId).join(", ")}]`,
    ...output.summaryCitations.map(
      (citation) => `  "${citation.quote}" - ${citation.sourceId}`,
    ),
    ...output.findings.flatMap((finding) => [
      `- ${finding.statement} (${finding.confidence})${finding.uncertainty ? ` - Uncertainty: ${finding.uncertainty}` : ""}`,
      ...finding.citations.map(
        (citation) => `  "${citation.quote}" - ${citation.sourceId}`,
      ),
    ]),
    ...(output.questionsForCounsel.length
      ? [
          "Questions for counsel:",
          ...output.questionsForCounsel.map((question) => `- ${question}`),
        ]
      : []),
  ].join("\n");
}
