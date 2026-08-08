import { createHash } from "node:crypto";

import {
  contractPlaybookDecisionPhrases,
  contractPlaybookReceiptSchema,
  type ContractPlaybookReceiptV1,
} from "./contractPlaybookPack";

export type ContractRevisionActionV1 =
  | {
      kind: "replace_exact_span";
      finding_id: string;
      rule_id: string;
      find: string;
      replace: string;
      reason: string;
    }
  | {
      kind: "comment_exact_span";
      finding_id: string;
      rule_id: string;
      anchor: string;
      comment: string;
    };

export type ContractMaterializationIssueCode =
  | "material_disposition_missing"
  | "conflicting_exact_span"
  | "replacement_is_noop";

export type ContractMaterializationIssueV1 = {
  code: ContractMaterializationIssueCode;
  finding_ids: string[];
  rule_ids: string[];
};

export type ContractOpinionSectionV1 = {
  heading: string;
  level: number;
  content?: string;
  table?: { headers: string[]; rows: string[][] };
};

export type ContractPlaybookMaterializationPlanV1 = {
  kind: "contract_playbook_materialization_plan_v1";
  receipt_fingerprint: string;
  status: "ready" | "review_required";
  source: ContractPlaybookReceiptV1["contract"];
  revision_actions: ContractRevisionActionV1[];
  unresolved_finding_ids: string[];
  issues: ContractMaterializationIssueV1[];
  opinion: {
    title: string;
    sections: ContractOpinionSectionV1[];
  };
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function normalizedSpan(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function localize(
  language: ContractPlaybookReceiptV1["opinion_language"],
  zh: string,
  en: string,
) {
  return language === "zh" ? zh : language === "en" ? en : `${zh}\n${en}`;
}

function dispositionLabel(
  finding: ContractPlaybookReceiptV1["findings"][number],
  language: ContractPlaybookReceiptV1["opinion_language"],
) {
  return contractPlaybookDecisionPhrases(finding, language).join(" ");
}

function fixedCommentText(
  finding: ContractPlaybookReceiptV1["findings"][number],
) {
  return finding.lawyer_direction ?? finding.recommendation!;
}

function opinionSections(receipt: ContractPlaybookReceiptV1) {
  const language = receipt.opinion_language;
  const material = receipt.findings.filter((finding) => finding.material);
  const nonMaterial = receipt.findings.filter((finding) => !finding.material);
  const unresolved = material.filter(
    (finding) =>
      finding.lawyer_disposition === null ||
      (finding.lawyer_disposition === "comment" &&
        finding.contract_quote === null),
  );
  const materialRows = material.map((finding) => [
    finding.rule_id,
    `${finding.rule_outcome} / ${finding.risk_level}`,
    dispositionLabel(finding, language),
    finding.recommendation ?? "—",
    finding.lawyer_disposition === "accept"
      ? localize(
          language,
          `已采纳文本：${finding.proposed_text}`,
          `Adopted text: ${finding.proposed_text}`,
        )
      : finding.lawyer_disposition === "comment"
        ? localize(
            language,
            `律师方向：${fixedCommentText(finding)}`,
            `Lawyer direction: ${fixedCommentText(finding)}`,
          )
        : "—",
    [
      ...finding.contract_citation_refs.map((ref) => `[${ref}]`),
      ...finding.playbook_citation_refs.map((ref) => `[${ref}]`),
    ].join(" "),
  ]);
  const sections: ContractOpinionSectionV1[] = [
    {
      heading: localize(language, "审查范围", "Review scope"),
      level: 1,
      content: localize(
        language,
        `本意见基于固定合同版本和固定${receipt.reference.role === "baseline" ? "对比基线" : "审查规则"}，审查模式为 ${receipt.review_mode}。本意见记录审查结果，不构成批准、发送或外部交付。`,
        `This opinion is based on the fixed contract Version and fixed ${receipt.reference.role === "baseline" ? "comparison baseline" : "Playbook"} in ${receipt.review_mode} mode. It records review outcomes and does not constitute approval, sending, or external delivery.`,
      ),
    },
    {
      heading: localize(
        language,
        "重大事项及律师决定",
        "Material findings and lawyer decisions",
      ),
      level: 1,
      table: {
        headers: [
          localize(language, "规则", "Rule"),
          localize(language, "结果 / 风险", "Outcome / risk"),
          localize(language, "律师决定", "Lawyer decision"),
          localize(language, "建议", "Recommendation"),
          localize(language, "采纳文本 / 方向", "Adopted text / direction"),
          localize(language, "来源标记", "Source refs"),
        ],
        rows: materialRows,
      },
    },
  ];
  if (unresolved.length) {
    sections.push({
      heading: localize(language, "待解决事项", "Unresolved items"),
      level: 1,
      table: {
        headers: [
          localize(language, "规则", "Rule"),
          localize(language, "原因", "Reason"),
          localize(language, "下一步", "Next action"),
        ],
        rows: unresolved.map((finding) => [
          finding.rule_id,
          finding.lawyer_disposition === null
            ? localize(language, "尚无律师决定", "No lawyer decision")
            : localize(
                language,
                "缺少可证明的精确合同锚点，未写入批注",
                "No provable exact contract anchor; no comment was written",
              ),
          finding.recommendation ??
            localize(language, "由律师进行限定编辑", "Bounded lawyer editing"),
        ]),
      },
    });
  }
  if (nonMaterial.length) {
    sections.push({
      heading: localize(language, "其他审查结果", "Other review outcomes"),
      level: 1,
      table: {
        headers: [
          localize(language, "规则", "Rule"),
          localize(language, "结果 / 风险", "Outcome / risk"),
          localize(language, "建议", "Recommendation"),
        ],
        rows: nonMaterial.map((finding) => [
          finding.rule_id,
          `${finding.rule_outcome} / ${finding.risk_level}`,
          finding.recommendation ?? "—",
        ]),
      },
    });
  }
  sections.push({
    heading: localize(language, "下一步律师操作", "Next lawyer action"),
    level: 1,
    content: unresolved.length
      ? localize(
          language,
          "在批准或导出前处理上述待解决事项，并在浏览器或 Word 中复核修订稿与清洁稿的一致性。",
          "Resolve the items above before approval or export, then review revision/clean-copy consistency in the browser or Word.",
        )
      : localize(
          language,
          "在批准或导出前，在浏览器或 Word 中复核修订稿、清洁稿及本意见。",
          "Before approval or export, review the revision, clean copy, and this opinion in the browser or Word.",
        ),
  });
  return sections;
}

/**
 * Compile every Contract Playbook deliverable from one fixed receipt. This
 * function has no provider, database, storage, or UI dependency. It refuses
 * ambiguous mutation plans before any DOCX or Artifact is written.
 */
export function compileContractPlaybookMaterializationPlan(
  input: unknown,
): ContractPlaybookMaterializationPlanV1 {
  const receipt = contractPlaybookReceiptSchema.parse(input);
  const actions: ContractRevisionActionV1[] = [];
  const issues: ContractMaterializationIssueV1[] = [];
  const unresolved = new Set<string>();
  const spanOwners = new Map<
    string,
    Array<{ finding_id: string; rule_id: string }>
  >();

  for (const finding of receipt.findings.filter((item) => item.material)) {
    if (finding.lawyer_disposition === null) {
      unresolved.add(finding.finding_id);
      issues.push({
        code: "material_disposition_missing",
        finding_ids: [finding.finding_id],
        rule_ids: [finding.rule_id],
      });
      continue;
    }
    if (finding.lawyer_disposition === "skip") continue;
    if (finding.contract_quote === null) {
      unresolved.add(finding.finding_id);
      continue;
    }

    const spanKey = normalizedSpan(finding.contract_quote);
    const owners = spanOwners.get(spanKey) ?? [];
    owners.push({
      finding_id: finding.finding_id,
      rule_id: finding.rule_id,
    });
    spanOwners.set(spanKey, owners);

    if (finding.lawyer_disposition === "accept") {
      if (normalizedSpan(finding.proposed_text!) === spanKey) {
        unresolved.add(finding.finding_id);
        issues.push({
          code: "replacement_is_noop",
          finding_ids: [finding.finding_id],
          rule_ids: [finding.rule_id],
        });
        continue;
      }
      actions.push({
        kind: "replace_exact_span",
        finding_id: finding.finding_id,
        rule_id: finding.rule_id,
        find: finding.contract_quote,
        replace: finding.proposed_text!,
        reason: finding.rule_id,
      });
      continue;
    }
    actions.push({
      kind: "comment_exact_span",
      finding_id: finding.finding_id,
      rule_id: finding.rule_id,
      anchor: finding.contract_quote,
      comment: fixedCommentText(finding),
    });
  }

  const conflictingSpans = new Set(
    [...spanOwners.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([span]) => span),
  );
  for (const span of conflictingSpans) {
    const owners = spanOwners.get(span)!;
    owners.forEach((owner) => unresolved.add(owner.finding_id));
    issues.push({
      code: "conflicting_exact_span",
      finding_ids: owners.map((owner) => owner.finding_id),
      rule_ids: owners.map((owner) => owner.rule_id),
    });
  }
  const safeActions = actions.filter((action) => {
    const span =
      action.kind === "replace_exact_span" ? action.find : action.anchor;
    return !conflictingSpans.has(normalizedSpan(span));
  });

  return {
    kind: "contract_playbook_materialization_plan_v1",
    receipt_fingerprint: createHash("sha256")
      .update(canonicalJson(receipt))
      .digest("hex"),
    status: issues.length ? "review_required" : "ready",
    source: receipt.contract,
    revision_actions: safeActions,
    unresolved_finding_ids: [...unresolved],
    issues,
    opinion: {
      title: localize(
        receipt.opinion_language,
        "合同审查意见",
        "Contract Review Opinion",
      ),
      sections: opinionSections(receipt),
    },
  };
}
