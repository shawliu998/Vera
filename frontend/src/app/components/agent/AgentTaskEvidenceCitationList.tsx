import { cn } from "@/app/lib/utils";
import type {
  AgentEvidenceCitation,
  AgentEvidenceSnapshot,
} from "@/app/types/agent";

const EVIDENCE_STATUS_META = {
  exact: { label: "Located", className: "text-emerald-700" },
  version_mismatch: {
    label: "Cited version",
    className: "text-amber-800",
  },
  drifted: { label: "Anchor drifted", className: "text-red-700" },
  missing: { label: "Citation missing", className: "text-red-700" },
} as const;

export function AgentTaskEvidenceCitationList({
  evidence,
  onOpenCitation,
}: {
  evidence: AgentEvidenceSnapshot | undefined;
  onOpenCitation: (citation: AgentEvidenceCitation) => void;
}) {
  if (!evidence) {
    return (
      <p className="pb-3 pl-5 text-xs text-gray-500">
        Loading source locations…
      </p>
    );
  }
  if (evidence.citations.length === 0) {
    return (
      <p className="pb-3 pl-5 text-xs leading-5 text-red-700">
        Citation missing — no source anchor was recorded.
      </p>
    );
  }
  return (
    <div className="space-y-1 pb-3 pl-5">
      {evidence.citations.map((citation) => {
        const status = EVIDENCE_STATUS_META[citation.status];
        const locator = citation.cell
          ? [citation.sheet, citation.cell].filter(Boolean).join("!")
          : citation.page != null
            ? "Page " + citation.page
            : "Source";
        return (
          <button
            key={citation.id}
            type="button"
            disabled={!citation.openable}
            onClick={() => onOpenCitation(citation)}
            title={citation.quote || citation.detail}
            className="block min-h-10 w-full rounded-md px-2 py-1.5 text-left outline-none hover:bg-gray-900/[0.035] focus-visible:ring-2 focus-visible:ring-blue-500/70 disabled:cursor-default disabled:opacity-65"
          >
            <span className="flex min-w-0 items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-medium text-gray-700">
                {citation.filename} · {locator}
              </span>
              <span className={cn("shrink-0 font-medium", status.className)}>
                {status.label}
              </span>
            </span>
            <span className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-gray-500 [overflow-wrap:anywhere]">
              {citation.quote || citation.detail}
            </span>
          </button>
        );
      })}
    </div>
  );
}
