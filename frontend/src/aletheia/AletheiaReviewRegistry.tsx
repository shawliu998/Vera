"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CircleAlert,
  ClipboardCheck,
  Download,
  RefreshCw,
} from "lucide-react";
import {
  createAletheiaWorkProduct,
  getAletheiaMatter,
  listAletheiaMatters,
  type AletheiaMatterDetail,
  type AletheiaReviewRecord,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { downloadJson } from "./exports";

type RegistryStatus = "checking" | "connected" | "unavailable";

type ReviewRow = AletheiaReviewRecord & {
  matterTitle: string;
  href: string;
  matterRisk: string;
  status: "recorded";
};

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function riskClass(risk?: string | null) {
  if (risk === "high") return "border-red-100 bg-red-50 text-red-700";
  if (risk === "medium") return "border-amber-100 bg-amber-50 text-amber-700";
  return "border-gray-200 bg-gray-50 text-gray-600";
}

function tagClass(tag: string) {
  if (tag === "accepted")
    return "border-emerald-100 bg-emerald-50 text-emerald-700";
  if (tag === "needs_human_judgment") {
    return "border-amber-100 bg-amber-50 text-amber-700";
  }
  if (tag === "badcase") return "border-red-100 bg-red-50 text-red-700";
  return "border-gray-200 bg-white text-gray-600";
}

function detailToReviewRows(detail: AletheiaMatterDetail): ReviewRow[] {
  return detail.reviews.map((review) => ({
    ...review,
    matterTitle: detail.matter.title,
    href: `/aletheia/matters/${detail.matter.id}/litigation?view=positions`,
    matterRisk: detail.matter.risk_level ?? "low",
    status: "recorded",
  }));
}

export function AletheiaReviewRegistry() {
  const [status, setStatus] = useState<RegistryStatus>("checking");
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function loadReviews() {
      setStatus("checking");
      setReviews([]);
      setSaveMessage("");
      try {
        const matters = (await listAletheiaMatters()).filter(
          (matter) => matter.template === "civil_litigation",
        );
        const details = await Promise.all(
          matters.map((matter) => getAletheiaMatter(matter.id)),
        );
        if (cancelled) return;
        setReviews(
          details
            .flatMap(detailToReviewRows)
            .sort((a, b) => b.created_at.localeCompare(a.created_at)),
        );
        setStatus("connected");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    }
    void loadReviews();
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const visibleCount = reviews.length;
  const filteredReviews = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return reviews.filter((item) => {
      const matchesTag = tagFilter === "all" || item.tag === tagFilter;
      const searchable = [
        item.matterTitle,
        item.target_type,
        item.target_id,
        item.comment,
        item.tag,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        matchesTag && (!normalizedQuery || searchable.includes(normalizedQuery))
      );
    });
  }, [query, reviews, tagFilter]);
  function exportFilteredReviews() {
    if (status !== "connected") return;
    downloadJson("aletheia-filtered-review-registry", {
      schemaVersion: "aletheia-review-registry-export-v0",
      exportedAt: new Date().toISOString(),
      source: "local_repository",
      filters: {
        query: query.trim(),
        tag: tagFilter,
      },
      recordCount: filteredReviews.length,
      records: filteredReviews,
    });
  }

  async function saveFilteredReviewSnapshot() {
    setSaveMessage("");
    if (status !== "connected" || filteredReviews.length === 0) return;
    setSavingSnapshot(true);
    try {
      const byMatter = new Map<string, ReviewRow[]>();
      for (const row of filteredReviews) {
        byMatter.set(row.matter_id, [
          ...(byMatter.get(row.matter_id) ?? []),
          row,
        ]);
      }
      await Promise.all(
        [...byMatter.entries()].map(([matterId, records]) =>
          createAletheiaWorkProduct(matterId, {
            kind: "registry_snapshot",
            title: "Filtered Review Registry Snapshot",
            schemaVersion: "aletheia-review-registry-snapshot-v0",
            content: {
              schemaVersion: "aletheia-review-registry-snapshot-v0",
              source: "local_repository",
              filters: {
                query: query.trim(),
                tag: tagFilter,
              },
              recordCount: records.length,
              records,
            },
            generatedBy: "human",
          }),
        ),
      );
      setSaveMessage(
        `Saved ${byMatter.size} matter-scoped review snapshot${
          byMatter.size === 1 ? "" : "s"
        }.`,
      );
    } catch (error) {
      setSaveMessage(
        error instanceof Error ? error.message : "Snapshot save failed.",
      );
    } finally {
      setSavingSnapshot(false);
    }
  }

  if (status !== "connected") {
    return (
      <section
        data-testid="aletheia-review-registry"
        className="min-h-full bg-white px-5 py-6 md:px-8"
      >
        <h1 className="text-[22px] font-semibold text-gray-950">
          Human Review
        </h1>
        {status === "checking" ? (
          <p className="mt-4 text-sm text-gray-500">
            Connecting to the local service...
          </p>
        ) : (
          <div
            role="alert"
            data-testid="reviews-service-unavailable"
            className="mt-5 max-w-2xl border border-gray-300 p-5"
          >
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
              <div>
                <h2 className="text-sm font-semibold text-gray-950">
                  Local service unavailable
                </h2>
                <p className="mt-1 text-sm leading-6 text-gray-600">
                  Vera could not load reviews and has not substituted demo
                  records. Reconnect the local service, then retry.
                </p>
                <p className="mt-2 text-xs text-gray-500">0 items</p>
                <button
                  type="button"
                  onClick={() => setRetryKey((value) => value + 1)}
                  className="mt-4 inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-sm font-medium text-gray-800 hover:bg-gray-50"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      data-testid="aletheia-review-registry"
      className="flex min-h-full flex-col bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 px-8 py-4">
        <div>
          <h1 className="text-[22px] font-semibold text-gray-950">
            Human Review
          </h1>
          <p className="mt-1 text-xs text-gray-400">
            Live local review tags from persisted matters.
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "rounded-md px-2 py-1 text-xs",
            "border-emerald-100 bg-emerald-50 text-emerald-700",
          )}
        >
          Local Repository
        </Badge>
        <Button
          type="button"
          variant="outline"
          data-testid="export-filtered-reviews"
          onClick={exportFilteredReviews}
          className="rounded-md border-gray-200 text-gray-700 hover:bg-gray-50"
        >
          <Download className="h-4 w-4" />
          Export Filtered JSON
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="save-review-snapshot"
          disabled={savingSnapshot}
          onClick={() => void saveFilteredReviewSnapshot()}
          className="rounded-md border-gray-200 text-gray-700 hover:bg-gray-50"
        >
          Save Snapshot
        </Button>
      </div>
      {saveMessage && (
        <p className="border-t border-gray-100 px-8 py-2 text-xs text-gray-500">
          {saveMessage}
        </p>
      )}

      <div className="flex h-10 items-center gap-5 border-b border-t border-gray-100 px-8 text-sm">
        <span className="font-medium text-gray-900">Review Queue</span>
        <span className="ml-auto text-xs text-gray-400">
          {visibleCount} items
        </span>
      </div>

      <div className="grid gap-3 border-b border-gray-100 px-8 py-3 md:grid-cols-[1fr_210px]">
        <input
          data-testid="review-filter-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by matter, target, tag, or comment"
          className="h-9 min-w-0 rounded-md border border-gray-200 px-3 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400"
        />
        <select
          data-testid="review-filter-tag"
          value={tagFilter}
          onChange={(event) => setTagFilter(event.target.value)}
          className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none focus:border-gray-400"
        >
          <option value="all">All tags</option>
          <option value="accepted">Accepted</option>
          <option value="needs_human_judgment">Needs human judgment</option>
          <option value="badcase">Badcase</option>
          <option value="unsupported_claim">Unsupported claim</option>
          <option value="citation_issue">Citation issue</option>
          <option value="missing_material">Missing material</option>
        </select>
      </div>

      <div className="min-w-0 overflow-x-auto">
        <div className="min-w-[940px]" data-testid="review-registry-results">
          <div className="flex h-8 items-center border-b border-gray-200 pr-8 text-xs font-medium text-gray-500">
            <div className="w-8 shrink-0" />
            <div className="w-64 shrink-0 pl-2 pr-4">Matter</div>
            <div className="min-w-0 flex-1 pr-4">Target / Comment</div>
            <div className="w-44 shrink-0">Tag</div>
            <div className="w-24 shrink-0">Risk</div>
            <div className="w-8 shrink-0" />
          </div>

          {filteredReviews.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className="group flex min-h-16 items-center border-b border-gray-50 pr-8 transition-colors hover:bg-gray-50"
                >
                  <div className="flex w-8 shrink-0 justify-center">
                    <ClipboardCheck className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                  </div>
                  <div className="w-64 shrink-0 pl-2 pr-4">
                    <p className="truncate text-sm text-gray-800">
                      {item.matterTitle}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-400">
                      {titleize(item.target_type)} · {item.status}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1 py-3 pr-4">
                    <p className="truncate text-sm text-gray-800">
                      {item.target_id}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-500">
                      {item.comment}
                    </p>
                  </div>
                  <div className="w-44 shrink-0">
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-md px-2 py-0 text-[11px]",
                        tagClass(item.tag),
                      )}
                    >
                      {titleize(item.tag)}
                    </Badge>
                  </div>
                  <div className="w-24 shrink-0">
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-md px-2 py-0 text-[11px]",
                        riskClass(item.matterRisk),
                      )}
                    >
                      {item.matterRisk}
                    </Badge>
                  </div>
                  <ArrowRight className="h-4 w-8 shrink-0 text-gray-300 transition-colors group-hover:text-gray-600" />
                </Link>
              ))}

          {filteredReviews.length === 0 && (
            <p className="p-8 text-sm text-gray-500">
              No local review tags match the current filters. Review an issue or
              memo section from a matter workspace to populate this queue.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
