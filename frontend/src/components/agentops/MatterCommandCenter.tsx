"use client";

import {
  AlertTriangle,
  ClipboardCheck,
  FileText,
  GitBranch,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { AgentStatusCard } from "./AgentStatusCard";
import { EvalWorkbench } from "./EvalWorkbench";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sampleAgentOpsWorkspace } from "@/aletheia/agentops";
import type { AgentOpsMatterWorkspace, ArtifactRef } from "@/aletheia/agentops";
import {
  type AgentCommandCenterCard,
  buildMatterCommandCenterModel,
  productWorkflowStages,
} from "@/aletheia/agentops/agentStatus";
import { cn } from "@/lib/utils";

type AgentStatusFilter = "all" | "blocked" | "review_needed" | "completed";

const agentStatusFilters: Array<{
  id: AgentStatusFilter;
  label: string;
  description: string;
}> = [
  {
    id: "all",
    label: "All",
    description: "All professional agents",
  },
  {
    id: "blocked",
    label: "Blocked",
    description: "Missing input or approval",
  },
  {
    id: "review_needed",
    label: "Review Needed",
    description: "Expert attention required",
  },
  {
    id: "completed",
    label: "Completed",
    description: "Done agents",
  },
];

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function riskClass(risk: string) {
  if (risk === "high") return "border-red-100 bg-red-50 text-red-700";
  if (risk === "medium") return "border-amber-100 bg-amber-50 text-amber-700";
  return "border-gray-200 bg-gray-50 text-gray-600";
}

function artifactTypeLabel(value: string) {
  return value.replaceAll("_", " ");
}

function anchorSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function artifactAnchorId(artifact: Pick<ArtifactRef, "id" | "type">) {
  return `artifact-${anchorSegment(artifact.type)}-${anchorSegment(artifact.id)}`;
}

function matchesAgentFilter(
  card: AgentCommandCenterCard,
  filter: AgentStatusFilter,
) {
  if (filter === "blocked") {
    return (
      card.agent.status === "blocked" ||
      card.agent.status === "waiting_for_approval"
    );
  }
  if (filter === "review_needed") return card.reviewNeeded;
  if (filter === "completed") return card.agent.status === "done";
  return true;
}

function buildVisibleArtifacts(workspace: AgentOpsMatterWorkspace) {
  return [
    ...workspace.evidence.map((item) => ({
      id: item.id,
      artifactType: "evidence_item" as const,
      type: "Evidence",
      title: item.normalized_fact,
      detail: item.review_status,
    })),
    ...workspace.issues.map((item) => ({
      id: item.id,
      artifactType: "issue_node" as const,
      type: "Issue",
      title: item.title,
      detail: item.review_status,
    })),
    ...workspace.risks.map((item) => ({
      id: item.id,
      artifactType: "risk_item" as const,
      type: "Risk",
      title: item.title,
      detail: item.status,
    })),
    ...workspace.draft_memos.map((item) => ({
      id: item.id,
      artifactType: "draft_memo" as const,
      type: "Memo",
      title: item.title,
      detail: `${item.review_status}; gate ${item.gate_status}`,
    })),
    ...workspace.review_comments.map((item) => ({
      id: item.id,
      artifactType: "review_comment" as const,
      type: "Review",
      title: item.comment,
      detail: item.status,
    })),
    ...workspace.gate_results.map((item) => ({
      id: item.id,
      artifactType: "gate_result" as const,
      type: "Gate",
      title: item.reason,
      detail: item.status,
    })),
    ...workspace.audit_events.map((item) => ({
      id: item.id,
      artifactType: "audit_event" as const,
      type: "Audit",
      title: item.action,
      detail: item.actor_type,
    })),
    ...workspace.eval_cases.map((item) => ({
      id: item.id,
      artifactType: "eval_case" as const,
      type: "Eval",
      title: item.expected_behavior,
      detail: item.status,
    })),
  ];
}

type MatterCommandCenterProps = {
  workspace?: AgentOpsMatterWorkspace;
  sourceLabel?: string;
  artifactBasePath?: string;
};

export function MatterCommandCenter({
  workspace = sampleAgentOpsWorkspace,
  sourceLabel = "Fixture demo",
  artifactBasePath = "/aletheia/agentops",
}: MatterCommandCenterProps = {}) {
  const [agentFilter, setAgentFilter] = useState<AgentStatusFilter>("all");
  const model = buildMatterCommandCenterModel(workspace);
  const visibleArtifacts = buildVisibleArtifacts(workspace);
  const filterCounts = Object.fromEntries(
    agentStatusFilters.map((filter) => [
      filter.id,
      model.agentCards.filter((card) => matchesAgentFilter(card, filter.id)).length,
    ]),
  ) as Record<AgentStatusFilter, number>;
  const filteredAgentCards = model.agentCards.filter((card) =>
    matchesAgentFilter(card, agentFilter),
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={cn("rounded-md px-2 py-1 text-xs", riskClass(model.riskLevel))}
              >
                {model.riskLevel} risk
              </Badge>
              <Badge
                variant="outline"
                className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600"
              >
                {titleize(model.matterStatus)}
              </Badge>
              <Badge
                variant="outline"
                className="rounded-md border-emerald-100 bg-emerald-50 px-2 py-1 text-xs text-emerald-700"
              >
                {sourceLabel}
              </Badge>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-normal text-gray-950">
              Matter Command Center
            </h1>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              {model.matterTitle} is managed as a professional multi-agent
              workflow with source artifacts, gates, audit history, and expert
              intervention points.
            </p>
          </div>

          <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4 lg:w-[520px]">
            {[
              {
                label: "Agents",
                value: model.agentCards.length,
                icon: Workflow,
              },
              {
                label: "Documents",
                value: model.documentCount,
                icon: FileText,
              },
              {
                label: "Review Points",
                value: model.reviewNeededCount,
                icon: ClipboardCheck,
              },
              {
                label: "Gate Stops",
                value: model.gateStopCount,
                icon: AlertTriangle,
              },
            ].map((item) => (
              <div key={item.label} className="rounded-md border border-gray-100 bg-gray-50 p-3">
                <item.icon className="h-4 w-4 text-gray-500" />
                <p className="mt-3 text-2xl font-semibold text-gray-950">
                  {item.value}
                </p>
                <p className="mt-1 text-xs font-medium text-gray-500">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold uppercase text-gray-500">
            Professional Workflow
          </h2>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-8">
          {productWorkflowStages.map((stage, index) => (
            <div
              key={stage}
              className="relative rounded-md border border-gray-200 bg-gray-50 px-3 py-3"
            >
              <p className="text-xs font-semibold text-gray-400">
                {String(index + 1).padStart(2, "0")}
              </p>
              <p className="mt-1 text-sm font-semibold text-gray-900">{stage}</p>
            </div>
          ))}
        </div>
      </section>

      <EvalWorkbench workspace={workspace} />

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-950">Agent Status</h2>
            <p className="mt-1 text-sm text-gray-600">
              Blocked agents state what is missing. Review-needed agents point
              to artifacts requiring expert attention.
            </p>
          </div>
          <Badge
            variant="outline"
            className="hidden rounded-md border-amber-100 bg-amber-50 px-2 py-1 text-xs text-amber-700 sm:inline-flex"
          >
            {model.openBlockers} open intervention points
          </Badge>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          {agentStatusFilters.map((filter) => (
            <Button
              key={filter.id}
              type="button"
              variant={agentFilter === filter.id ? "default" : "outline"}
              size="sm"
              aria-pressed={agentFilter === filter.id}
              title={filter.description}
              onClick={() => setAgentFilter(filter.id)}
              className={cn(
                "h-8 rounded-md px-3 text-xs",
                agentFilter === filter.id
                  ? "bg-gray-950 text-white hover:bg-gray-800"
                  : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
              )}
            >
              {filter.label}
              <span
                className={cn(
                  "ml-1 rounded-full px-1.5 py-0.5 text-[10px]",
                  agentFilter === filter.id
                    ? "bg-white/15 text-white"
                    : "bg-gray-100 text-gray-500",
                )}
              >
                {filterCounts[filter.id]}
              </span>
            </Button>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {filteredAgentCards.map((card) => (
            <AgentStatusCard
              key={card.agent.id}
              card={card}
              artifactHref={(artifact) =>
                `${artifactBasePath}#${artifactAnchorId(artifact)}`
              }
            />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold uppercase text-gray-500">
            Artifact Attention Queue
          </h2>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {visibleArtifacts.map((artifact, index) => (
            <div
              key={`${artifact.type}-${artifact.id}-${index}`}
              id={artifactAnchorId({
                id: artifact.id,
                type: artifact.artifactType,
              })}
              className="rounded-md border border-gray-100 bg-gray-50 px-3 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-gray-400">
                    {artifact.type}
                  </p>
                  <p className="mt-1 text-sm font-medium leading-5 text-gray-900">
                    {artifact.title}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="rounded-md border-gray-200 bg-white px-2 py-1 text-[11px] capitalize text-gray-600"
                >
                  {artifactTypeLabel(artifact.detail)}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
