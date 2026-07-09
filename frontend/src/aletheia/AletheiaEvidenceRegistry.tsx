"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Download, FileSearch, ShieldAlert } from "lucide-react";
import {
  createAletheiaWorkProduct,
  getAletheiaMatter,
  listAletheiaMatters,
  type AletheiaEvidenceRecord,
  type AletheiaMatterDetail,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { downloadJson } from "./exports";
import { getEvidenceQueue } from "./workflow";

type RegistryStatus = "checking" | "connected" | "fallback";

type EvidenceRow = AletheiaEvidenceRecord & {
  matterTitle: string;
  href: string;
  matterRisk: string;
};

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function supportClass(status: string) {
  if (status === "supports") {
    return "border-emerald-100 bg-emerald-50 text-emerald-700";
  }
  if (status === "contradicts") return "border-red-100 bg-red-50 text-red-700";
  return "border-amber-100 bg-amber-50 text-amber-700";
}

function riskClass(risk?: string | null) {
  if (risk === "high") return "border-red-100 bg-red-50 text-red-700";
  if (risk === "medium") return "border-amber-100 bg-amber-50 text-amber-700";
  return "border-gray-200 bg-gray-50 text-gray-600";
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function evidenceNormalizedFact(item: AletheiaEvidenceRecord) {
  return typeof item.metadata.normalizedFact === "string" &&
    item.metadata.normalizedFact.trim()
    ? item.metadata.normalizedFact.trim()
    : item.quote.replace(/\s+/g, " ").trim().slice(0, 220);
}

function evidenceSensitiveFlags(item: AletheiaEvidenceRecord) {
  return stringArray(item.metadata.sensitiveMaterialFlags);
}

function evidenceQuoteRange(item: AletheiaEvidenceRecord) {
  return typeof item.quote_start === "number" &&
    typeof item.quote_end === "number"
    ? `${item.quote_start}-${item.quote_end}`
    : null;
}

function evidenceAnchorId(evidenceId: string) {
  return `evidence-${evidenceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function detailToEvidenceRows(detail: AletheiaMatterDetail): EvidenceRow[] {
  return detail.evidence.map((item) => ({
    ...item,
    matterTitle: detail.matter.title,
    href: `/aletheia/matters/${detail.matter.id}`,
    matterRisk: detail.matter.risk_level ?? "low",
  }));
}

export function AletheiaEvidenceRegistry() {
  const [status, setStatus] = useState<RegistryStatus>("checking");
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [query, setQuery] = useState("");
  const [supportFilter, setSupportFilter] = useState("all");
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const fallbackEvidence = useMemo(() => getEvidenceQueue(), []);

  useEffect(() => {
    let cancelled = false;
    async function loadEvidence() {
      try {
        const matters = await listAletheiaMatters();
        const details = await Promise.all(
          matters.map((matter) => getAletheiaMatter(matter.id)),
        );
        if (cancelled) return;
        setEvidence(
          details
            .flatMap(detailToEvidenceRows)
            .sort((a, b) => b.created_at.localeCompare(a.created_at)),
        );
        setStatus("connected");
      } catch {
        if (!cancelled) setStatus("fallback");
      }
    }
    void loadEvidence();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleCount =
    status === "connected" ? evidence.length : fallbackEvidence.length;
  const filteredEvidence = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return evidence.filter((item) => {
      const matchesSupport =
        supportFilter === "all" || item.support_status === supportFilter;
      const searchable = [
        item.matterTitle,
        item.document_name,
        item.id,
        evidenceAnchorId(item.id),
        item.claim_id,
        item.quote,
        evidenceNormalizedFact(item),
        item.source_chunk_id,
        evidenceSensitiveFlags(item).join(" "),
        item.support_status,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        matchesSupport &&
        (!normalizedQuery || searchable.includes(normalizedQuery))
      );
    });
  }, [evidence, query, supportFilter]);
  const filteredFallbackEvidence = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return fallbackEvidence.filter((item) => {
      const matchesSupport =
        supportFilter === "all" || item.supportStatus === supportFilter;
      const searchable = [
        item.matterTitle,
        item.documentName,
        item.issueTitle,
        item.quote,
        item.supportStatus,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        matchesSupport &&
        (!normalizedQuery || searchable.includes(normalizedQuery))
      );
    });
  }, [fallbackEvidence, query, supportFilter]);
  const exportRows =
    status === "connected" ? filteredEvidence : filteredFallbackEvidence;

  function exportFilteredEvidence() {
    downloadJson("aletheia-filtered-evidence-registry", {
      schemaVersion: "aletheia-evidence-registry-export-v0",
      exportedAt: new Date().toISOString(),
      source: status === "connected" ? "local_repository" : "demo_fallback",
      filters: {
        query: query.trim(),
        supportStatus: supportFilter,
      },
      recordCount: exportRows.length,
      records: exportRows,
    });
  }

  async function saveFilteredEvidenceSnapshot() {
    setSaveMessage("");
    if (status !== "connected" || filteredEvidence.length === 0) return;
    setSavingSnapshot(true);
    try {
      const byMatter = new Map<string, EvidenceRow[]>();
      for (const row of filteredEvidence) {
        byMatter.set(row.matter_id, [
          ...(byMatter.get(row.matter_id) ?? []),
          row,
        ]);
      }
      await Promise.all(
        [...byMatter.entries()].map(([matterId, records]) =>
          createAletheiaWorkProduct(matterId, {
            kind: "registry_snapshot",
            title: "Filtered Evidence Registry Snapshot",
            schemaVersion: "aletheia-evidence-registry-snapshot-v0",
            content: {
              schemaVersion: "aletheia-evidence-registry-snapshot-v0",
              source: "local_repository",
              filters: {
                query: query.trim(),
                supportStatus: supportFilter,
              },
              recordCount: records.length,
              records,
            },
            generatedBy: "human",
          }),
        ),
      );
      setSaveMessage(
        `Saved ${byMatter.size} matter-scoped evidence snapshot${
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
      data-testid="aletheia-evidence-registry"
      className="flex min-h-full flex-col bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 px-8 py-4">
        <div>
          <h1 className="font-serif text-2xl font-medium text-gray-900">
            Evidence Registry
          </h1>
          <p className="mt-1 text-xs text-gray-400">
            {status === "connected"
              ? "Live local source-backed evidence from persisted matters."
              : status === "checking"
                ? "Checking local evidence repository..."
                : "Demo fallback evidence registry."}
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
          data-testid="export-filtered-evidence"
          onClick={exportFilteredEvidence}
          className="rounded-md border-gray-200 text-gray-700 hover:bg-gray-50"
        >
          <Download className="h-4 w-4" />
          Export Filtered JSON
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="save-evidence-snapshot"
          disabled={status !== "connected" || savingSnapshot}
          onClick={() => void saveFilteredEvidenceSnapshot()}
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
        <span className="font-medium text-gray-900">All Evidence</span>
        <span className="ml-auto text-xs text-gray-400">
          {visibleCount} records
        </span>
      </div>

      <div className="grid gap-3 border-b border-gray-100 px-8 py-3 md:grid-cols-[1fr_180px]">
        <input
          data-testid="evidence-filter-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by matter, source, claim, or quote; evidence ID supported"
          className="h-9 min-w-0 rounded-md border border-gray-200 px-3 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400"
        />
        <select
          data-testid="evidence-filter-support"
          value={supportFilter}
          onChange={(event) => setSupportFilter(event.target.value)}
          className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none focus:border-gray-400"
        >
          <option value="all">All support</option>
          <option value="supports">Supports</option>
          <option value="contradicts">Contradicts</option>
          <option value="insufficient">Insufficient</option>
        </select>
      </div>

      <div className="min-w-0 overflow-x-auto">
        <div className="min-w-[1120px]" data-testid="evidence-registry-results">
          <div className="flex h-8 items-center border-b border-gray-200 pr-8 text-xs font-medium text-gray-500">
            <div className="w-8 shrink-0" />
            <div className="w-64 shrink-0 pl-2 pr-4">Source</div>
            <div className="min-w-0 flex-1 pr-4">Claim / Quote</div>
            <div className="w-32 shrink-0">Support</div>
            <div className="w-24 shrink-0">Risk</div>
            <div className="w-8 shrink-0" />
          </div>

          {status === "connected"
            ? filteredEvidence.map((item) => (
                <Link
                  key={item.id}
                  id={evidenceAnchorId(item.id)}
                  data-testid="evidence-registry-row"
                  href={item.href}
                  className="group flex min-h-16 items-center border-b border-gray-50 pr-8 transition-colors hover:bg-gray-50"
                >
                  <div className="flex w-8 shrink-0 justify-center">
                    <FileSearch className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                  </div>
                  <div className="w-64 shrink-0 pl-2 pr-4">
                    <p className="truncate text-sm text-gray-800">
                      {item.document_name ?? "Source document"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-400">
                      {item.matterTitle}
                      {item.page ? ` · p.${item.page}` : ""}
                      {item.section ? ` · ${item.section}` : ""}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1 py-3 pr-4">
                    <p className="truncate text-sm text-gray-800">
                      {item.claim_id ?? "Unassigned claim"}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-500">
                      {item.quote}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-600">
                      <span className="font-medium text-gray-700">
                        Normalized fact:
                      </span>{" "}
                      {evidenceNormalizedFact(item)}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge
                        variant="outline"
                        className="rounded-md border-blue-100 bg-blue-50 px-1.5 py-0 text-[11px] text-blue-700"
                      >
                        Evidence {item.id}
                      </Badge>
                      {item.source_chunk_id && (
                        <Badge
                          variant="outline"
                          className="rounded-md border-gray-200 bg-white px-1.5 py-0 text-[11px] text-gray-600"
                        >
                          Source chunk {item.source_chunk_id.slice(0, 8)}
                        </Badge>
                      )}
                      {evidenceQuoteRange(item) && (
                        <Badge
                          variant="outline"
                          className="rounded-md border-gray-200 bg-white px-1.5 py-0 text-[11px] text-gray-600"
                        >
                          chars {evidenceQuoteRange(item)}
                        </Badge>
                      )}
                      {item.confidence && (
                        <Badge
                          variant="outline"
                          className="rounded-md border-gray-200 bg-white px-1.5 py-0 text-[11px] text-gray-600"
                        >
                          confidence {item.confidence}
                        </Badge>
                      )}
                      {evidenceSensitiveFlags(item).map((flag) => (
                        <Badge
                          key={flag}
                          variant="outline"
                          className="rounded-md border-red-100 bg-red-50 px-1.5 py-0 text-[11px] text-red-700"
                        >
                          <ShieldAlert className="h-3 w-3" />
                          {titleize(flag)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="w-32 shrink-0">
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-md px-2 py-0 text-[11px]",
                        supportClass(item.support_status),
                      )}
                    >
                      {titleize(item.support_status)}
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
              ))
            : filteredFallbackEvidence.map((item) => (
                <Link
                  key={item.id}
                  href="/aletheia/matters/matter-demo-legal-001"
                  className="group flex min-h-16 items-center border-b border-gray-50 pr-8 transition-colors hover:bg-gray-50"
                >
                  <div className="flex w-8 shrink-0 justify-center">
                    <FileSearch className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                  </div>
                  <div className="w-64 shrink-0 pl-2 pr-4">
                    <p className="truncate text-sm text-gray-800">
                      {item.documentName}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-400">
                      {item.matterTitle} · p.{item.page}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1 py-3 pr-4">
                    <p className="truncate text-sm text-gray-800">
                      {item.issueTitle}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-500">
                      {item.quote}
                    </p>
                  </div>
                  <div className="w-32 shrink-0">
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-md px-2 py-0 text-[11px]",
                        supportClass(item.supportStatus),
                      )}
                    >
                      {titleize(item.supportStatus)}
                    </Badge>
                  </div>
                  <div className="w-24 shrink-0">
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-md px-2 py-0 text-[11px]",
                        riskClass(item.riskLevel),
                      )}
                    >
                      {item.riskLevel}
                    </Badge>
                  </div>
                  <ArrowRight className="h-4 w-8 shrink-0 text-gray-300 transition-colors group-hover:text-gray-600" />
                </Link>
              ))}

          {status === "connected" && filteredEvidence.length === 0 && (
            <p className="p-8 text-sm text-gray-500">
              No local evidence matches the current filters. Search and map a
              source chunk from a matter workspace to populate this registry.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
