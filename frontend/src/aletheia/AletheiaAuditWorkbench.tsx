"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  FileCheck2,
  History,
  ShieldCheck,
} from "lucide-react";
import {
  createAletheiaWorkProduct,
  getAletheiaMatter,
  listAletheiaMatters,
  type AletheiaAuditEventRecord,
  type AletheiaHumanCheckpointRecord,
  type AletheiaMatterDetail,
  type AletheiaMatterOverview,
  type AletheiaReviewRecord,
  type AletheiaWorkProductRecord,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { downloadJson } from "./exports";
import { getAuditQueue, getWorkProductSummaries } from "./workflow";

type AuditStatus = "checking" | "connected" | "fallback";

type MatterAuditSummary = {
  id: string;
  title: string;
  href: string;
  riskLevel: string;
  status: string;
  documentCount: number;
  evidenceCount: number;
  reviewCount: number;
  auditEventCount: number;
  workProductCount: number;
  openCheckpointCount: number;
  approvedCheckpointCount: number;
  latestAuditAt: string | null;
};

type AuditEventView = AletheiaAuditEventRecord & {
  matterTitle: string;
  href: string;
};

type ReviewView = AletheiaReviewRecord & {
  matterTitle: string;
  href: string;
};

type WorkProductView = AletheiaWorkProductRecord & {
  matterTitle: string;
  href: string;
};

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function formatAuditTimestamp(value: string | null) {
  if (!value) return "No audit event";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function riskClass(risk: string) {
  if (risk === "high") return "border-red-100 bg-red-50 text-red-700";
  if (risk === "medium") return "border-amber-100 bg-amber-50 text-amber-700";
  return "border-gray-200 bg-gray-50 text-gray-600";
}

function statusClass(status: string) {
  if (status === "open" || status === "needs_review") {
    return "border-amber-100 bg-amber-50 text-amber-700";
  }
  if (
    status === "approved" ||
    status === "accepted" ||
    status === "completed"
  ) {
    return "border-emerald-100 bg-emerald-50 text-emerald-700";
  }
  return "border-gray-200 bg-white text-gray-600";
}

function overviewToSummary(matter: AletheiaMatterOverview): MatterAuditSummary {
  return {
    id: matter.id,
    title: matter.title,
    href: `/aletheia/matters/${matter.id}`,
    riskLevel: matter.risk_level ?? "low",
    status: matter.status,
    documentCount: matter.document_count,
    evidenceCount: matter.evidence_count,
    reviewCount: matter.review_count,
    auditEventCount: matter.audit_event_count,
    workProductCount: 0,
    openCheckpointCount: 0,
    approvedCheckpointCount: 0,
    latestAuditAt: matter.latest_audit_at,
  };
}

function checkpointsFor(detail: AletheiaMatterDetail) {
  return (
    (detail.agentRuns?.flatMap(
      (run) => run.human_checkpoints ?? [],
    ) as AletheiaHumanCheckpointRecord[]) ?? []
  );
}

function detailToSummary(detail: AletheiaMatterDetail): MatterAuditSummary {
  const checkpoints = checkpointsFor(detail);
  const latestAuditAt =
    detail.auditEvents
      .map((event) => event.created_at)
      .sort()
      .at(-1) ?? null;
  return {
    id: detail.matter.id,
    title: detail.matter.title,
    href: `/aletheia/matters/${detail.matter.id}`,
    riskLevel: detail.matter.risk_level ?? "low",
    status: detail.matter.status,
    documentCount: detail.documents.length,
    evidenceCount: detail.evidence.length,
    reviewCount: detail.reviews.length,
    auditEventCount: detail.auditEvents.length,
    workProductCount: detail.workProducts.length,
    openCheckpointCount: checkpoints.filter(
      (checkpoint) => checkpoint.status === "open",
    ).length,
    approvedCheckpointCount: checkpoints.filter(
      (checkpoint) => checkpoint.status === "approved",
    ).length,
    latestAuditAt,
  };
}

function emptyMetrics() {
  return [
    { label: "Matters", value: 0 },
    { label: "Audit Events", value: 0 },
    { label: "Reviews", value: 0 },
    { label: "Open Gates", value: 0 },
  ];
}

export function AletheiaAuditWorkbench() {
  const [status, setStatus] = useState<AuditStatus>("checking");
  const [matters, setMatters] = useState<MatterAuditSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventView[]>([]);
  const [reviews, setReviews] = useState<ReviewView[]>([]);
  const [workProducts, setWorkProducts] = useState<WorkProductView[]>([]);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadAuditWorkspace() {
      try {
        const overviews = await listAletheiaMatters();
        const details = await Promise.all(
          overviews.map((matter) => getAletheiaMatter(matter.id)),
        );
        if (cancelled) return;
        const summaries = details.map(detailToSummary);
        setMatters(
          summaries.length > 0
            ? summaries
            : overviews.map((matter) => overviewToSummary(matter)),
        );
        setAuditEvents(
          details
            .flatMap((detail) =>
              detail.auditEvents.map((event) => ({
                ...event,
                matterTitle: detail.matter.title,
                href: `/aletheia/matters/${detail.matter.id}`,
              })),
            )
            .sort((a, b) => b.created_at.localeCompare(a.created_at)),
        );
        setReviews(
          details
            .flatMap((detail) =>
              detail.reviews.map((review) => ({
                ...review,
                matterTitle: detail.matter.title,
                href: `/aletheia/matters/${detail.matter.id}`,
              })),
            )
            .sort((a, b) => b.created_at.localeCompare(a.created_at)),
        );
        setWorkProducts(
          details
            .flatMap((detail) =>
              detail.workProducts.map((workProduct) => ({
                ...workProduct,
                matterTitle: detail.matter.title,
                href: `/aletheia/matters/${detail.matter.id}`,
              })),
            )
            .sort((a, b) => b.created_at.localeCompare(a.created_at)),
        );
        setStatus("connected");
      } catch {
        if (!cancelled) setStatus("fallback");
      }
    }
    void loadAuditWorkspace();
    return () => {
      cancelled = true;
    };
  }, []);

  const fallbackEvents = useMemo(() => getAuditQueue(), []);
  const fallbackWorkProducts = useMemo(() => getWorkProductSummaries(), []);

  const metrics = useMemo(() => {
    if (status === "fallback") {
      return [
        { label: "Matters", value: 1 },
        { label: "Audit Events", value: fallbackEvents.length },
        { label: "Reviews", value: 0 },
        { label: "Open Gates", value: 0 },
      ];
    }
    if (status === "checking") return emptyMetrics();
    return [
      { label: "Matters", value: matters.length },
      { label: "Audit Events", value: auditEvents.length },
      { label: "Reviews", value: reviews.length },
      {
        label: "Open Gates",
        value: matters.reduce(
          (sum, matter) => sum + matter.openCheckpointCount,
          0,
        ),
      },
    ];
  }, [
    auditEvents.length,
    fallbackEvents.length,
    matters,
    reviews.length,
    status,
  ]);

  const readinessItems = useMemo(
    () => [
      {
        label: "Evidence readiness",
        value: matters.filter(
          (matter) => matter.documentCount > 0 && matter.evidenceCount > 0,
        ).length,
        total: matters.length,
      },
      {
        label: "Review burden",
        value: reviews.length,
        total: matters.length,
      },
      {
        label: "Approved export gates",
        value: matters.reduce(
          (sum, matter) => sum + matter.approvedCheckpointCount,
          0,
        ),
        total: matters.reduce(
          (sum, matter) =>
            sum + matter.approvedCheckpointCount + matter.openCheckpointCount,
          0,
        ),
      },
    ],
    [matters, reviews.length],
  );
  const filteredAuditEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return auditEvents.filter((event) => {
      const matchesAction =
        actionFilter === "all" || event.action === actionFilter;
      const searchable = [
        event.matterTitle,
        event.action,
        event.actor,
        event.workflow_version,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        matchesAction &&
        (!normalizedQuery || searchable.includes(normalizedQuery))
      );
    });
  }, [actionFilter, auditEvents, query]);
  const filteredMatters = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return matters;
    return matters.filter((matter) =>
      [matter.title, matter.status, matter.riskLevel]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [matters, query]);
  const auditActionOptions = useMemo(
    () => [...new Set(auditEvents.map((event) => event.action))].sort(),
    [auditEvents],
  );
  const recentWorkProducts = useMemo(
    () =>
      [...workProducts].sort((a, b) => {
        const aIsSnapshot = a.kind === "registry_snapshot";
        const bIsSnapshot = b.kind === "registry_snapshot";
        if (aIsSnapshot !== bIsSnapshot) return aIsSnapshot ? 1 : -1;
        return b.created_at.localeCompare(a.created_at);
      }),
    [workProducts],
  );

  function exportFilteredAudit() {
    downloadJson("aletheia-filtered-audit-workbench", {
      schemaVersion: "aletheia-audit-workbench-export-v0",
      exportedAt: new Date().toISOString(),
      source: status === "connected" ? "local_repository" : "demo_fallback",
      filters: {
        query: query.trim(),
        action: actionFilter,
      },
      timelineEventCount:
        status === "connected"
          ? filteredAuditEvents.length
          : fallbackEvents.length,
      matterCount: status === "connected" ? filteredMatters.length : 0,
      workProductCount:
        status === "connected"
          ? workProducts.length
          : fallbackWorkProducts.length,
      auditEvents:
        status === "connected" ? filteredAuditEvents : fallbackEvents,
      matters: status === "connected" ? filteredMatters : [],
      workProducts:
        status === "connected" ? workProducts : fallbackWorkProducts,
    });
  }

  async function saveFilteredAuditSnapshot() {
    setSaveMessage("");
    if (status !== "connected" || filteredAuditEvents.length === 0) return;
    setSavingSnapshot(true);
    try {
      const byMatter = new Map<string, AuditEventView[]>();
      for (const event of filteredAuditEvents) {
        byMatter.set(event.matter_id, [
          ...(byMatter.get(event.matter_id) ?? []),
          event,
        ]);
      }
      await Promise.all(
        [...byMatter.entries()].map(([matterId, events]) =>
          createAletheiaWorkProduct(matterId, {
            kind: "registry_snapshot",
            title: "Filtered Audit Workbench Snapshot",
            schemaVersion: "aletheia-audit-workbench-snapshot-v0",
            content: {
              schemaVersion: "aletheia-audit-workbench-snapshot-v0",
              source: "local_repository",
              filters: {
                query: query.trim(),
                action: actionFilter,
              },
              timelineEventCount: events.length,
              auditEvents: events,
              matter: filteredMatters.find((matter) => matter.id === matterId),
              workProducts: workProducts.filter(
                (workProduct) => workProduct.matter_id === matterId,
              ),
            },
            generatedBy: "human",
          }),
        ),
      );
      setSaveMessage(
        `Saved ${byMatter.size} matter-scoped audit snapshot${
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

  return (
    <section
      data-testid="aletheia-audit-workbench"
      className="flex min-h-full flex-col bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 px-8 py-4">
        <div>
          <h1 className="font-serif text-2xl font-medium text-gray-900">
            Audit Workbench
          </h1>
          <p className="mt-1 text-xs text-gray-400">
            {status === "connected"
              ? "Live local audit records from persisted matters."
              : status === "checking"
                ? "Checking local audit repository..."
                : "Demo fallback audit records."}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "rounded-md px-2 py-1 text-xs",
            status === "connected"
              ? "border-emerald-100 bg-emerald-50 text-emerald-700"
              : "border-gray-200 bg-gray-50 text-gray-600",
          )}
        >
          {status === "connected" ? "Local Repository" : titleize(status)}
        </Badge>
        <Button
          type="button"
          variant="outline"
          data-testid="export-filtered-audit"
          onClick={exportFilteredAudit}
          className="rounded-md border-gray-200 text-gray-700 hover:bg-gray-50"
        >
          <Download className="h-4 w-4" />
          Export Filtered JSON
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="save-audit-snapshot"
          disabled={status !== "connected" || savingSnapshot}
          onClick={() => void saveFilteredAuditSnapshot()}
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

      <div className="grid border-y border-gray-100 md:grid-cols-4">
        {metrics.map((item) => (
          <div
            key={item.label}
            className="border-gray-100 px-8 py-3 md:border-r"
          >
            <p className="text-xs text-gray-400">{item.label}</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">
              {item.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 border-b border-gray-100 px-8 py-3 md:grid-cols-[1fr_220px]">
        <input
          data-testid="audit-filter-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by matter, action, actor, or workflow"
          className="h-9 min-w-0 rounded-md border border-gray-200 px-3 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400"
        />
        <select
          data-testid="audit-filter-action"
          value={actionFilter}
          onChange={(event) => setActionFilter(event.target.value)}
          className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none focus:border-gray-400"
        >
          <option value="all">All actions</option>
          {auditActionOptions.map((action) => (
            <option key={action} value={action}>
              {titleize(action)}
            </option>
          ))}
        </select>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_360px]">
        <section className="min-w-0 overflow-y-auto px-8 py-5">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-medium text-gray-900">
              Matter Audit Timeline
            </h2>
            <span className="ml-auto text-xs text-gray-400">
              {status === "connected"
                ? `${filteredAuditEvents.length} events`
                : `${fallbackEvents.length} demo events`}
            </span>
          </div>

          <div className="mt-4 space-y-0" data-testid="audit-timeline-results">
            {status === "connected"
              ? filteredAuditEvents.slice(0, 40).map((event) => (
                  <Link
                    key={event.id}
                    href={event.href}
                    className="group relative block border-l border-gray-200 pb-6 pl-5 last:pb-0"
                  >
                    <div className="absolute -left-1 top-1.5 h-2 w-2 rounded-full bg-gray-900" />
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-gray-900">
                        {titleize(event.action)}
                      </p>
                      <Badge
                        variant="outline"
                        className="rounded-md border-gray-200 bg-white px-2 py-0 text-[11px] text-gray-600"
                      >
                        {event.actor}
                      </Badge>
                      <ArrowRight className="ml-auto h-4 w-4 text-gray-300 transition-colors group-hover:text-gray-600" />
                    </div>
                    <p className="mt-1 text-sm text-gray-500">
                      {event.matterTitle}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      {formatAuditTimestamp(event.created_at)} ·{" "}
                      {event.workflow_version ?? "manual"}
                    </p>
                  </Link>
                ))
              : fallbackEvents.map((event) => (
                  <div
                    key={event.id}
                    className="relative border-l border-gray-200 pb-6 pl-5 last:pb-0"
                  >
                    <div className="absolute -left-1 top-1.5 h-2 w-2 rounded-full bg-gray-900" />
                    <p className="text-sm font-medium text-gray-900">
                      {titleize(event.action)}
                    </p>
                    <p className="mt-1 text-sm text-gray-500">
                      {event.matterTitle}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      {formatAuditTimestamp(event.timestamp)} ·{" "}
                      {event.workflowVersion ?? "manual"}
                    </p>
                  </div>
                ))}
            {status === "connected" && filteredAuditEvents.length === 0 && (
              <p className="rounded-md border border-dashed border-gray-200 p-4 text-sm text-gray-500">
                No persisted audit events match the current filters. Create a
                matter workflow to start the local audit trail.
              </p>
            )}
          </div>
        </section>

        <aside className="border-l border-gray-100 px-5 py-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-medium text-gray-900">
              Review Readiness
            </h2>
          </div>

          <div className="mt-4 space-y-3">
            {readinessItems.map((item) => (
              <div key={item.label} className="border-b border-gray-100 pb-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-gray-800">{item.label}</p>
                  <span className="text-xs text-gray-400">
                    {item.value}/{item.total || 0}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-gray-900"
                    style={{
                      width:
                        item.total > 0
                          ? `${Math.min((item.value / item.total) * 100, 100)}%`
                          : "0%",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex items-center gap-2">
            <FileCheck2 className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-medium text-gray-900">
              Matter Packets
            </h2>
          </div>
          <div className="mt-4 space-y-3" data-testid="audit-matter-packets">
            {filteredMatters.slice(0, 8).map((matter) => (
              <Link
                key={matter.id}
                href={matter.href}
                className="block border-b border-gray-100 pb-3 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium text-gray-900">
                    {matter.title}
                  </p>
                  <Badge
                    variant="outline"
                    className={cn(
                      "rounded-md px-2 py-0 text-[11px]",
                      riskClass(matter.riskLevel),
                    )}
                  >
                    {matter.riskLevel}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-400">
                  <span>{matter.documentCount} docs</span>
                  <span>{matter.evidenceCount} evidence</span>
                  <span>{matter.reviewCount} reviews</span>
                  <span>{matter.auditEventCount} audit</span>
                </div>
                <p className="mt-1 text-xs text-gray-400">
                  Latest: {formatAuditTimestamp(matter.latestAuditAt)}
                </p>
              </Link>
            ))}
            {status === "connected" && filteredMatters.length === 0 && (
              <p className="text-sm text-gray-500">
                No local matters match the current filters.
              </p>
            )}
          </div>

          <div className="mt-6 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-medium text-gray-900">
              Recent Work Products
            </h2>
          </div>
          <div className="mt-4 space-y-3" data-testid="audit-work-products">
            {status === "connected"
              ? recentWorkProducts.slice(0, 10).map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    className="block border-b border-gray-100 pb-3 last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm text-gray-800">
                        {titleize(item.kind)}
                      </p>
                      <Badge
                        variant="outline"
                        className={cn(
                          "rounded-md px-2 py-0 text-[11px]",
                          statusClass(item.status),
                        )}
                      >
                        {titleize(item.status)}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
                      {item.title} · {item.matterTitle}
                    </p>
                  </Link>
                ))
              : fallbackWorkProducts.map((item) => (
                  <div
                    key={item.id}
                    className="border-b border-gray-100 pb-3 last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-gray-800">{item.kind}</p>
                      <Badge
                        variant="outline"
                        className="rounded-md border-gray-200 bg-white px-2 py-0 text-[11px] text-gray-600"
                      >
                        {titleize(item.status)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-gray-500">
                      {item.title}
                    </p>
                  </div>
                ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
