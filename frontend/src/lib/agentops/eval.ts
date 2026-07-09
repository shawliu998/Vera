import type {
  AgentOpsMatterWorkspace,
  DraftMemo,
  EvalCase,
  GateResult,
  IssueNode,
  ReviewComment,
} from "../../aletheia/agentops/types";

export type EvalMetrics = {
  citation_coverage: number;
  unsupported_claim_count: number;
  unresolved_review_comments: number;
  human_override_count: number;
  gate_failure_count: number;
  issue_coverage?: {
    covered_issue_count: number;
    total_issue_count: number;
    score: number;
  };
};

export type EvalMetricInput = {
  draft_memos: DraftMemo[];
  review_comments: ReviewComment[];
  gate_results: GateResult[];
  eval_cases: EvalCase[];
  issues?: IssueNode[];
};

function ratio(numerator: number, denominator: number) {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(2));
}

function computeCitationCoverage(draftMemos: DraftMemo[]) {
  let citedSections = 0;
  let totalSections = 0;

  for (const memo of draftMemos) {
    for (const section of memo.sections) {
      totalSections += 1;
      if (section.evidence_reference_ids.length > 0) {
        citedSections += 1;
      }
    }
  }

  return ratio(citedSections, totalSections);
}

function computeUnsupportedClaims(draftMemos: DraftMemo[]) {
  return draftMemos.reduce(
    (total, memo) => total + memo.unsupported_claim_count,
    0,
  );
}

function computeIssueCoverage(issues: IssueNode[] | undefined) {
  if (!issues || issues.length === 0) return undefined;

  const coveredIssues = issues.filter(
    (issue) =>
      issue.related_evidence_ids.length > 0 || issue.open_questions.length > 0,
  );

  return {
    covered_issue_count: coveredIssues.length,
    total_issue_count: issues.length,
    score: ratio(coveredIssues.length, issues.length),
  };
}

export function computeProfessionalEvalMetrics(
  input: EvalMetricInput,
): EvalMetrics {
  const failedGates = input.gate_results.filter(
    (gate) => gate.status === "failed",
  );
  const expertOverrides = input.eval_cases.filter(
    (evalCase) => evalCase.failure_type === "expert_override",
  );

  return {
    citation_coverage: computeCitationCoverage(input.draft_memos),
    unsupported_claim_count: computeUnsupportedClaims(input.draft_memos),
    unresolved_review_comments: input.review_comments.filter(
      (comment) => comment.status === "open",
    ).length,
    human_override_count: expertOverrides.length,
    gate_failure_count: failedGates.length,
    issue_coverage: computeIssueCoverage(input.issues),
  };
}

export function computeWorkspaceEvalMetrics(
  workspace: AgentOpsMatterWorkspace,
): EvalMetrics {
  return computeProfessionalEvalMetrics({
    draft_memos: workspace.draft_memos,
    review_comments: workspace.review_comments,
    gate_results: workspace.gate_results,
    eval_cases: workspace.eval_cases,
    issues: workspace.issues,
  });
}
