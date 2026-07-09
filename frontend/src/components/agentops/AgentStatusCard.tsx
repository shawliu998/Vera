import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileWarning,
  Loader2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentCommandCenterCard } from "@/aletheia/agentops/agentStatus";
import type { ArtifactRef, ProfessionalAgentStatus } from "@/aletheia/agentops";

const statusClasses: Record<ProfessionalAgentStatus, string> = {
  idle: "border-gray-200 bg-gray-50 text-gray-600",
  working: "border-blue-100 bg-blue-50 text-blue-700",
  blocked: "border-red-100 bg-red-50 text-red-700",
  review_needed: "border-amber-100 bg-amber-50 text-amber-700",
  waiting_for_approval: "border-purple-100 bg-purple-50 text-purple-700",
  done: "border-emerald-100 bg-emerald-50 text-emerald-700",
  failed: "border-red-200 bg-red-50 text-red-800",
};

const statusIcons = {
  idle: CircleDashed,
  working: Loader2,
  blocked: AlertCircle,
  review_needed: FileWarning,
  waiting_for_approval: Clock3,
  done: CheckCircle2,
  failed: XCircle,
} satisfies Record<ProfessionalAgentStatus, typeof CircleDashed>;

function artifactLabel(type: string) {
  return type.replaceAll("_", " ");
}

export function AgentStatusCard({
  card,
  artifactHref,
}: {
  card: AgentCommandCenterCard;
  artifactHref: (artifact: ArtifactRef) => string;
}) {
  const StatusIcon = statusIcons[card.agent.status];
  const blocker =
    card.agent.blocked_reason ||
    (card.agent.status === "waiting_for_approval"
      ? "Human approval is required before this agent can continue."
      : "");

  return (
    <article
      data-testid="agent-status-card"
      className="flex min-h-[320px] flex-col rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-gray-400">
            {card.roleLabel}
          </p>
          <h3 className="mt-1 text-base font-semibold leading-6 text-gray-950">
            {card.agent.name}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn("rounded-md px-2 py-1 text-[11px]", statusClasses[card.agent.status])}
        >
          <StatusIcon className="h-3 w-3" />
          {card.statusLabel}
        </Badge>
      </div>

      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-xs font-semibold uppercase text-gray-400">
            Current task
          </dt>
          <dd className="mt-1 leading-5 text-gray-700">
            {card.agent.current_task ?? "No active task assigned."}
          </dd>
        </div>

        {blocker && (
          <div className="rounded-md border border-red-100 bg-red-50 p-3">
            <dt className="text-xs font-semibold uppercase text-red-700">
              Missing input
            </dt>
            <dd className="mt-1 leading-5 text-red-800">{blocker}</dd>
          </div>
        )}

        <div>
          <dt className="text-xs font-semibold uppercase text-gray-400">
            Last run
          </dt>
          <dd className="mt-1 font-medium leading-5 text-gray-800">
            {card.lastRunLabel}
          </dd>
        </div>

        <div>
          <dt className="text-xs font-semibold uppercase text-gray-400">
            Next action
          </dt>
          <dd className="mt-1 leading-5 text-gray-700">
            {card.agent.next_action ?? "Wait for upstream workflow change."}
          </dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-gray-100 pt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase text-gray-400">
            Related artifacts
          </p>
          {card.reviewNeeded && (
            <Badge
              variant="outline"
              className="rounded-md border-amber-100 bg-amber-50 px-2 py-1 text-[11px] text-amber-700"
            >
              Expert attention
            </Badge>
          )}
        </div>

        <div className="mt-2 space-y-2">
          {card.relatedArtifacts.length === 0 ? (
            <p className="text-sm text-gray-500">No produced artifacts yet.</p>
          ) : (
            card.relatedArtifacts.map((artifact) => (
              <Link
                key={`${artifact.type}-${artifact.id}`}
                href={artifactHref(artifact)}
                className="block rounded-md border border-gray-100 px-3 py-2 text-sm transition-colors hover:border-gray-200 hover:bg-gray-50"
              >
                <span className="block truncate font-medium text-gray-800">
                  {artifact.title ?? artifact.id}
                </span>
                <span className="mt-0.5 block text-xs capitalize text-gray-500">
                  {artifactLabel(artifact.type)}
                </span>
              </Link>
            ))
          )}
        </div>
      </div>
    </article>
  );
}
