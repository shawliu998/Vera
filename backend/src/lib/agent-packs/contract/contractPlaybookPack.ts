import { createHash } from "node:crypto";

import { z } from "zod";

export const CONTRACT_PLAYBOOK_PACK_PROFILE_ID =
  "work_task_contract_docx_v1" as const;
export const CONTRACT_PLAYBOOK_PACK_VERSION = "1.0.0" as const;

export const contractReviewModeSchema = z.enum([
  "quick",
  "deep",
  "checklist",
  "compare",
]);
export const contractLawyerDispositionSchema = z.enum([
  "accept",
  "comment",
  "skip",
]);

const uuid = z.string().uuid();
const nullableText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable();
const citationRefs = z.array(z.number().int().positive().max(10_000)).max(8);
const ruleId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const fixedRuleIdentitySchema = z
  .object({
    rule_id: ruleId,
    rule_version: z.string().trim().min(1).max(120),
  })
  .strict();
const issueType = z.string().trim().min(1).max(80);

const findingShape = {
  material: z.boolean(),
  rule_id: ruleId,
  rule_version: z.string().trim().min(1).max(120),
  rule_outcome: z.enum([
    "compliant",
    "deviation",
    "missing",
    "uncertain",
    "not_applicable",
  ]),
  issue_type: issueType,
  risk_level: z.enum(["critical", "high", "medium", "low", "none"]),
  priority: z.enum(["must", "should", "could", "none"]),
  // Provider confidence is an uncalibrated observation, not a legal or
  // workflow gate. Preserve a bounded numeric observation when available,
  // otherwise let the server persist null without rejecting the finding.
  confidence: z.number().finite().min(0).max(1).nullable(),
  target_position: nullableText(2_000),
  fallback_position: nullableText(2_000),
  walk_away_position: nullableText(2_000),
  contract_anchor: nullableText(300),
  contract_quote: nullableText(4_000),
  contract_citation_refs: citationRefs,
  playbook_citation_refs: citationRefs.min(1),
  recommendation: nullableText(2_000),
  proposed_text: nullableText(4_000),
} as const;

type FindingBoundary = z.infer<z.ZodObject<typeof findingShape>>;

function validateFindingBoundary(
  value: FindingBoundary,
  context: z.RefinementCtx,
) {
  for (const [field, refs] of [
    ["contract_citation_refs", value.contract_citation_refs],
    ["playbook_citation_refs", value.playbook_citation_refs],
  ] as const) {
    if (new Set(refs).size !== refs.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be unique`,
      });
    }
  }
  if (
    value.contract_citation_refs.some((ref) =>
      value.playbook_citation_refs.includes(ref),
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["playbook_citation_refs"],
      message: "Contract and Playbook citation refs must be distinct",
    });
  }

  if (value.rule_outcome === "missing") {
    if (value.contract_quote !== null || value.contract_citation_refs.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contract_quote"],
        message: "A missing clause cannot quote or cite nonexistent text",
      });
    }
  } else if (value.rule_outcome === "not_applicable") {
    if (
      (value.contract_quote === null) !==
      (value.contract_citation_refs.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contract_citation_refs"],
        message:
          "A not-applicable finding must provide both quote and citation, or neither",
      });
    }
  } else if (
    value.contract_quote === null ||
    value.contract_citation_refs.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contract_quote"],
      message: "This outcome requires an exact contract quote and citation",
    });
  }

  if (value.contract_quote !== null && value.contract_anchor === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contract_anchor"],
      message: "Quoted contract text requires a relocatable contract anchor",
    });
  }
  if (
    value.recommendation === null &&
    (value.material ||
      !["compliant", "not_applicable"].includes(value.rule_outcome))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendation"],
      message: "A material or adverse finding requires a recommendation",
    });
  }
}

export const contractPlaybookAnalysisFindingSchema = z
  .object(findingShape)
  .strict()
  .superRefine(validateFindingBoundary);
export type ContractPlaybookAnalysisFindingV1 = z.infer<
  typeof contractPlaybookAnalysisFindingSchema
>;

export const contractPlaybookAnalysisOutputSchema = z
  .object({
    kind: z.literal("contract_playbook_analysis_v1"),
    findings: z.array(contractPlaybookAnalysisFindingSchema).max(80),
  })
  .strict();

export type ContractPlaybookAnalysisOutputV1 = z.infer<
  typeof contractPlaybookAnalysisOutputSchema
>;

export class ContractPlaybookStructuredOutputError extends Error {
  constructor(
    message = "Contract analysis returned an invalid structured result",
  ) {
    super(message);
    this.name = "ContractPlaybookStructuredOutputError";
  }
}

function unwrapSingleJsonFence(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

export function parseContractPlaybookAnalysisOutput(raw: string) {
  try {
    return contractPlaybookAnalysisOutputSchema.parse(
      JSON.parse(unwrapSingleJsonFence(raw)),
    );
  } catch {
    throw new ContractPlaybookStructuredOutputError();
  }
}

function normalizedIdentityText(value: string | null) {
  return value === null
    ? null
    : value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function deriveContractPlaybookFindingId(
  finding: ContractPlaybookAnalysisFindingV1,
) {
  const parsed = contractPlaybookAnalysisFindingSchema.parse(finding);
  const identity = JSON.stringify({
    rule_id: parsed.rule_id.normalize("NFKC").toLowerCase(),
    rule_version: parsed.rule_version.normalize("NFKC"),
    rule_outcome: parsed.rule_outcome,
    issue_type: parsed.issue_type,
    contract_anchor: normalizedIdentityText(parsed.contract_anchor),
    contract_quote: normalizedIdentityText(parsed.contract_quote),
  });
  return `finding-${createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24)}`;
}

const decisionSchema = z
  .object({
    disposition: contractLawyerDispositionSchema,
    direction: nullableText(1_000),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.direction !== null && decision.disposition !== "comment") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["direction"],
        message: "Only a comment disposition may carry lawyer direction",
      });
    }
  });

const persistedFindingSchema = z
  .object({
    ...findingShape,
    finding_id: z.string().regex(/^finding-[a-f0-9]{24}$/),
    lawyer_disposition: contractLawyerDispositionSchema.nullable(),
    lawyer_direction: nullableText(1_000),
  })
  .strict()
  .superRefine((finding, context) => {
    validateFindingBoundary(finding, context);
    const {
      finding_id: _findingId,
      lawyer_disposition: _lawyerDisposition,
      lawyer_direction: _lawyerDirection,
      ...analysisFields
    } = finding;
    const analysis =
      contractPlaybookAnalysisFindingSchema.parse(analysisFields);
    if (finding.finding_id !== deriveContractPlaybookFindingId(analysis)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finding_id"],
        message: "Finding id must match its server-derived identity",
      });
    }
    if (!finding.material && finding.lawyer_disposition !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lawyer_disposition"],
        message: "A non-material finding cannot carry a lawyer disposition",
      });
    }
    if (
      finding.lawyer_direction !== null &&
      finding.lawyer_disposition !== "comment"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lawyer_direction"],
        message: "Only a comment disposition may carry lawyer direction",
      });
    }
    if (finding.lawyer_disposition === "accept") {
      if (
        finding.proposed_text === null ||
        finding.contract_quote === null ||
        finding.contract_anchor === null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lawyer_disposition"],
          message:
            "Accept requires fixed proposed text and one exact contract span",
        });
      }
    }
    if (
      finding.lawyer_disposition === "comment" &&
      finding.lawyer_direction === null &&
      finding.recommendation === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lawyer_direction"],
        message: "Comment requires fixed lawyer direction or recommendation",
      });
    }
  });

export const contractPlaybookReceiptSchema = z
  .object({
    kind: z.literal("contract_playbook_pack_receipt_v1"),
    pack_version: z.literal(CONTRACT_PLAYBOOK_PACK_VERSION),
    review_mode: contractReviewModeSchema,
    opinion_language: z.enum(["zh", "en", "bilingual"]),
    analyze_step_id: uuid,
    analyze_attempt: z.number().int().positive(),
    contract: z.object({ document_id: uuid, version_id: uuid }).strict(),
    reference: z
      .object({
        role: z.enum(["playbook", "baseline"]),
        document_id: uuid,
        version_id: uuid,
        rule_set_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        expected_rule_count: z.number().int().min(0).max(500),
        expected_rules: z.array(fixedRuleIdentitySchema).max(500).default([]),
      })
      .strict(),
    citation_snapshot_artifact_id: uuid,
    findings: z.array(persistedFindingSchema).max(80),
  })
  .strict()
  .superRefine((receipt, context) => {
    const ids = receipt.findings.map((finding) => finding.finding_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "Finding ids must be unique",
      });
    }
    const ruleKeys = receipt.findings.map(
      (finding) => `${finding.rule_id}\u0000${finding.rule_version}`,
    );
    if (receipt.review_mode === "quick") {
      receipt.findings.forEach((finding, index) => {
        if (!finding.material) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["findings", index, "material"],
            message: "Quick mode may contain only material findings",
          });
        }
      });
    }
    if (
      receipt.review_mode === "checklist" &&
      (receipt.findings.length !== receipt.reference.expected_rule_count ||
        new Set(ruleKeys).size !== ruleKeys.length ||
        (receipt.reference.expected_rules.length > 0 &&
          (receipt.reference.expected_rules.length !== ruleKeys.length ||
            receipt.reference.expected_rules.some(
              (rule) =>
                !ruleKeys.includes(`${rule.rule_id}\u0000${rule.rule_version}`),
            ))))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message:
          "Checklist mode requires exactly one finding per fixed rule/version",
      });
    }
    if (receipt.review_mode === "compare") {
      if (receipt.reference.role !== "baseline") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reference", "role"],
          message: "Compare mode requires a fixed baseline",
        });
      }
      receipt.findings.forEach((finding, index) => {
        if (
          finding.target_position !== null ||
          finding.fallback_position !== null ||
          finding.walk_away_position !== null
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["findings", index, "target_position"],
            message: "A comparison baseline is not a negotiating position",
          });
        }
      });
    } else if (receipt.reference.role !== "playbook") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference", "role"],
        message: "Non-compare review requires a fixed Playbook",
      });
    }
  });

export type ContractPlaybookReceiptV1 = z.infer<
  typeof contractPlaybookReceiptSchema
>;

export function compileContractPlaybookReceipt(input: {
  reviewMode: z.infer<typeof contractReviewModeSchema>;
  opinionLanguage: "zh" | "en" | "bilingual";
  analyzeStepId: string;
  analyzeAttempt: number;
  contract: { document_id: string; version_id: string };
  reference: {
    role: "playbook" | "baseline";
    document_id: string;
    version_id: string;
    rule_set_digest: string;
    expected_rule_count: number;
    expected_rules?: Array<{ rule_id: string; rule_version: string }>;
  };
  citationSnapshotArtifactId: string;
  findings: unknown;
  decisions?: Record<string, unknown>;
}) {
  const findings = z
    .array(contractPlaybookAnalysisFindingSchema)
    .max(80)
    .parse(input.findings);
  const decisions = z
    .record(z.string(), decisionSchema)
    .parse(input.decisions ?? {});
  const findingIds = new Set(
    findings.map((finding) => deriveContractPlaybookFindingId(finding)),
  );
  for (const id of Object.keys(decisions)) {
    if (!findingIds.has(id)) {
      throw new Error(`Lawyer decision is not bound to a fixed finding: ${id}`);
    }
  }
  return contractPlaybookReceiptSchema.parse({
    kind: "contract_playbook_pack_receipt_v1",
    pack_version: CONTRACT_PLAYBOOK_PACK_VERSION,
    review_mode: input.reviewMode,
    opinion_language: input.opinionLanguage,
    analyze_step_id: input.analyzeStepId,
    analyze_attempt: input.analyzeAttempt,
    contract: input.contract,
    reference: input.reference,
    citation_snapshot_artifact_id: input.citationSnapshotArtifactId,
    findings: findings.map((finding) => {
      const findingId = deriveContractPlaybookFindingId(finding);
      const decision = decisions[findingId] ?? null;
      if (decision && !finding.material) {
        throw new Error(
          `A lawyer decision cannot be attached to non-material finding ${findingId}`,
        );
      }
      return {
        ...finding,
        finding_id: findingId,
        lawyer_disposition: decision?.disposition ?? null,
        lawyer_direction: decision?.direction ?? null,
      };
    }),
  });
}

export type ContractPlaybookPackIssueCode =
  | "receipt_missing"
  | "receipt_invalid"
  | "material_disposition_missing"
  | "review_opinion_unavailable"
  | "material_rule_missing"
  | "decision_mismatch"
  | "adopted_text_missing"
  | "lawyer_direction_missing";

export type ContractPlaybookPackIssue = {
  code: ContractPlaybookPackIssueCode;
  finding_id: string | null;
  rule_id: string | null;
};

function normalizedOpinion(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function contractPlaybookDecisionPhrases(
  finding: ContractPlaybookReceiptV1["findings"][number],
  language: ContractPlaybookReceiptV1["opinion_language"],
) {
  const exactAnchor = finding.contract_quote !== null;
  const phrases = {
    zh:
      finding.lawyer_disposition === "accept"
        ? "律师决定：采纳建议文本并纳入修订稿。"
        : finding.lawyer_disposition === "comment"
          ? exactAnchor
            ? "律师决定：保留原文并添加批注。"
            : "律师决定：保留原文；因缺少精确合同锚点未添加批注，保留为待解决事项。"
          : "律师决定：保留原文，不作修改。",
    en:
      finding.lawyer_disposition === "accept"
        ? "Lawyer decision: adopt the proposed text in the revision."
        : finding.lawyer_disposition === "comment"
          ? exactAnchor
            ? "Lawyer decision: preserve the operative text and add a comment."
            : "Lawyer decision: preserve the operative text; no comment was anchored, so the item remains unresolved."
          : "Lawyer decision: preserve the operative text without a document action.",
  };
  return language === "bilingual"
    ? [phrases.zh, phrases.en]
    : [phrases[language]];
}

export function verifyContractPlaybookPack(input: {
  receipt: unknown;
  reviewOpinionText: string | null;
}): { status: "pass" | "gap"; issues: ContractPlaybookPackIssue[] } {
  if (input.receipt === null || input.receipt === undefined) {
    return {
      status: "gap",
      issues: [{ code: "receipt_missing", finding_id: null, rule_id: null }],
    };
  }
  const parsed = contractPlaybookReceiptSchema.safeParse(input.receipt);
  if (!parsed.success) {
    return {
      status: "gap",
      issues: [{ code: "receipt_invalid", finding_id: null, rule_id: null }],
    };
  }
  const receipt = parsed.data;
  const issues: ContractPlaybookPackIssue[] = [];
  const material = receipt.findings.filter((finding) => finding.material);
  for (const finding of material) {
    if (finding.lawyer_disposition === null) {
      issues.push({
        code: "material_disposition_missing",
        finding_id: finding.finding_id,
        rule_id: finding.rule_id,
      });
    }
  }
  if (input.reviewOpinionText === null) {
    issues.push({
      code: "review_opinion_unavailable",
      finding_id: null,
      rule_id: null,
    });
    return { status: "gap", issues };
  }
  const opinion = normalizedOpinion(input.reviewOpinionText);
  for (const finding of material) {
    if (!opinion.includes(normalizedOpinion(finding.rule_id))) {
      issues.push({
        code: "material_rule_missing",
        finding_id: finding.finding_id,
        rule_id: finding.rule_id,
      });
      continue;
    }
    if (finding.lawyer_disposition === null) continue;
    if (
      contractPlaybookDecisionPhrases(finding, receipt.opinion_language).some(
        (phrase) => !opinion.includes(normalizedOpinion(phrase)),
      )
    ) {
      issues.push({
        code: "decision_mismatch",
        finding_id: finding.finding_id,
        rule_id: finding.rule_id,
      });
      continue;
    }
    if (
      finding.lawyer_disposition === "accept" &&
      finding.proposed_text !== null &&
      !opinion.includes(normalizedOpinion(finding.proposed_text))
    ) {
      issues.push({
        code: "adopted_text_missing",
        finding_id: finding.finding_id,
        rule_id: finding.rule_id,
      });
    }
    const direction = finding.lawyer_direction ?? finding.recommendation;
    if (
      finding.lawyer_disposition === "comment" &&
      direction !== null &&
      !opinion.includes(normalizedOpinion(direction))
    ) {
      issues.push({
        code: "lawyer_direction_missing",
        finding_id: finding.finding_id,
        rule_id: finding.rule_id,
      });
    }
  }
  return { status: issues.length ? "gap" : "pass", issues };
}
