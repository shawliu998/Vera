import type {
  AgentOpsMatterWorkspace,
  AgentRole,
  AgentRun,
  ArtifactRef,
  ProfessionalAgent,
  ProfessionalAgentStatus,
} from "./types";

export const agentWorkflowOrder: AgentRole[] = [
  "intake",
  "evidence",
  "issue",
  "research",
  "risk",
  "memo",
  "review",
  "audit",
  "eval",
];

export const productWorkflowStages = [
  "Intake",
  "Evidence",
  "Issue/Risk",
  "Memo",
  "Review",
  "Gate",
  "Audit",
  "Eval",
];

export const agentRoleLabels: Record<AgentRole, string> = {
  intake: "Matter intake and scope control",
  evidence: "Source-backed evidence extraction",
  issue: "Issue map and open questions",
  research: "Professional standard research",
  risk: "Risk register and mitigation",
  memo: "Draft professional work product",
  review: "Expert review coordination",
  audit: "Provenance and run trace",
  eval: "Feedback-to-skill loop",
};

export const agentStatusLabels: Record<ProfessionalAgentStatus, string> = {
  idle: "Idle",
  working: "Working",
  blocked: "Blocked",
  review_needed: "Review needed",
  waiting_for_approval: "Waiting for approval",
  done: "Done",
  failed: "Failed",
};

export type AgentCommandCenterCard = {
  agent: ProfessionalAgent;
  roleLabel: string;
  statusLabel: string;
  lastRun: AgentRun | null;
  lastRunLabel: string;
  relatedArtifacts: ArtifactRef[];
  reviewNeeded: boolean;
};

export type MatterCommandCenterModel = {
  matterTitle: string;
  matterStatus: string;
  riskLevel: string;
  documentCount: number;
  agentCards: AgentCommandCenterCard[];
  statusCounts: Record<ProfessionalAgentStatus, number>;
  openBlockers: number;
  reviewNeededCount: number;
  gateStopCount: number;
};

function byStartedAtDesc(a: AgentRun, b: AgentRun) {
  return b.started_at.localeCompare(a.started_at);
}

function formatRunTime(value?: string) {
  if (!value) return "No run yet";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function fallbackArtifacts(
  role: AgentRole,
  workspace: AgentOpsMatterWorkspace,
): ArtifactRef[] {
  if (role === "intake") {
    return [
      {
        id: workspace.matter.id,
        type: "matter",
        title: workspace.matter.title,
      },
    ];
  }
  if (role === "evidence") {
    return workspace.evidence.map((item) => ({
      id: item.id,
      type: "evidence_item",
      title: item.normalized_fact,
    }));
  }
  if (role === "issue" || role === "research") {
    return workspace.issues.map((item) => ({
      id: item.id,
      type: "issue_node",
      title: item.title,
    }));
  }
  if (role === "risk") {
    return workspace.risks.map((item) => ({
      id: item.id,
      type: "risk_item",
      title: item.title,
    }));
  }
  if (role === "memo") {
    return workspace.draft_memos.map((item) => ({
      id: item.id,
      type: "draft_memo",
      title: item.title,
    }));
  }
  if (role === "review") {
    return workspace.review_comments.map((item) => ({
      id: item.id,
      type: "review_comment",
      title: item.comment,
    }));
  }
  if (role === "audit") {
    return workspace.audit_events.map((item) => ({
      id: item.id,
      type: "audit_event",
      title: item.action,
    }));
  }
  return workspace.eval_cases.map((item) => ({
    id: item.id,
    type: "eval_case",
    title: item.expected_behavior,
  }));
}

function hasRoleReviewNeed(role: AgentRole, workspace: AgentOpsMatterWorkspace) {
  if (role === "evidence") {
    return workspace.evidence.some((item) => item.review_status === "pending");
  }
  if (role === "issue" || role === "research") {
    return workspace.issues.some((item) => item.review_status !== "approved");
  }
  if (role === "memo") {
    return workspace.draft_memos.some(
      (item) => item.review_status !== "approved" || item.gate_status !== "passed",
    );
  }
  if (role === "review") {
    return workspace.review_comments.some((item) => item.status === "open");
  }
  if (role === "eval") {
    return workspace.eval_cases.some((item) => item.status === "open");
  }
  return false;
}

function emptyStatusCounts(): Record<ProfessionalAgentStatus, number> {
  return {
    idle: 0,
    working: 0,
    blocked: 0,
    review_needed: 0,
    waiting_for_approval: 0,
    done: 0,
    failed: 0,
  };
}

export function buildMatterCommandCenterModel(
  workspace: AgentOpsMatterWorkspace,
): MatterCommandCenterModel {
  const runsByAgent = new Map<string, AgentRun[]>();
  for (const run of workspace.runs) {
    runsByAgent.set(run.agent_id, [...(runsByAgent.get(run.agent_id) ?? []), run]);
  }

  const cards = [...workspace.agents]
    .sort(
      (a, b) =>
        agentWorkflowOrder.indexOf(a.role) - agentWorkflowOrder.indexOf(b.role),
    )
    .map((agent) => {
      const lastRun = (runsByAgent.get(agent.id) ?? []).sort(byStartedAtDesc)[0] ?? null;
      const relatedArtifacts =
        lastRun?.output_artifacts.length
          ? lastRun.output_artifacts
          : fallbackArtifacts(agent.role, workspace);

      return {
        agent,
        roleLabel: agentRoleLabels[agent.role],
        statusLabel: agentStatusLabels[agent.status],
        lastRun,
        lastRunLabel: formatRunTime(lastRun?.ended_at ?? lastRun?.started_at),
        relatedArtifacts: relatedArtifacts.slice(0, 4),
        reviewNeeded:
          agent.status === "review_needed" ||
          agent.status === "waiting_for_approval" ||
          hasRoleReviewNeed(agent.role, workspace),
      };
    });

  const statusCounts = emptyStatusCounts();
  for (const card of cards) {
    statusCounts[card.agent.status] += 1;
  }

  return {
    matterTitle: workspace.matter.title,
    matterStatus: workspace.matter.status,
    riskLevel: workspace.matter.risk_level,
    documentCount: workspace.matter.documents.length,
    agentCards: cards,
    statusCounts,
    openBlockers: cards.filter(
      (card) =>
        card.agent.status === "blocked" ||
        card.agent.status === "waiting_for_approval",
    ).length,
    reviewNeededCount: cards.filter((card) => card.reviewNeeded).length,
    gateStopCount: workspace.gate_results.filter(
      (gate) => gate.status === "failed" || gate.status === "warning",
    ).length,
  };
}
