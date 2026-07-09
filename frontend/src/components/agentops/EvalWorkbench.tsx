import { BarChart3, FileWarning, MessageSquareWarning, ShieldX } from "lucide-react";
import type { AgentOpsMatterWorkspace } from "@/aletheia/agentops";
import {
  computeWorkspaceEvalMetrics,
  suggestProfessionalSkillCandidates,
} from "@/lib/agentops";
import { Badge } from "@/components/ui/badge";
import { SkillCandidateList } from "./SkillCandidateList";

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function EvalWorkbench({
  workspace,
}: {
  workspace: AgentOpsMatterWorkspace;
}) {
  const metrics = computeWorkspaceEvalMetrics(workspace);
  const suggestedSkills = suggestProfessionalSkillCandidates(
    {
      eval_cases: workspace.eval_cases,
      review_comments: workspace.review_comments,
      gate_results: workspace.gate_results,
    },
    {
      matter_id: workspace.matter.id,
      min_occurrences: 2,
    },
  );

  const metricCards = [
    {
      label: "Citation Coverage",
      value: formatPercent(metrics.citation_coverage),
      detail: "memo sections with evidence",
      icon: BarChart3,
    },
    {
      label: "Unsupported Claims",
      value: metrics.unsupported_claim_count,
      detail: "requires evidence or open-item labeling",
      icon: FileWarning,
    },
    {
      label: "Open Review Comments",
      value: metrics.unresolved_review_comments,
      detail: "expert feedback still unresolved",
      icon: MessageSquareWarning,
    },
    {
      label: "Gate Failures",
      value: metrics.gate_failure_count,
      detail: "workflow stops before export",
      icon: ShieldX,
    },
  ];

  return (
    <section data-testid="agentops-eval-workbench" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">
            Eval Workbench
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Expert feedback is converted into eval signals and inactive
            candidate skills until a human approves a playbook update.
          </p>
        </div>
        <Badge
          variant="outline"
          className="rounded-md border-gray-200 bg-white px-2 py-1 text-xs text-gray-600"
        >
          {workspace.eval_cases.length} eval cases
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {metricCards.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
          >
            <item.icon className="h-4 w-4 text-gray-500" />
            <p className="mt-3 text-2xl font-semibold text-gray-950">
              {item.value}
            </p>
            <p className="mt-1 text-xs font-semibold uppercase text-gray-400">
              {item.label}
            </p>
            <p className="mt-2 text-xs leading-5 text-gray-600">
              {item.detail}
            </p>
          </div>
        ))}
      </div>

      {metrics.issue_coverage && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-gray-950">
              Issue coverage
            </p>
            <span className="text-sm text-gray-600">
              {metrics.issue_coverage.covered_issue_count}/
              {metrics.issue_coverage.total_issue_count} covered
            </span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-gray-950"
              style={{ width: formatPercent(metrics.issue_coverage.score) }}
            />
          </div>
        </div>
      )}

      <SkillCandidateList
        existingSkills={workspace.skills}
        suggestedSkills={suggestedSkills}
      />
    </section>
  );
}
