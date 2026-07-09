"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BarChart3, Download, RefreshCw } from "lucide-react";
import {
  adaptAletheiaMatterDetailToAgentOpsWorkspace,
  summarizeAdapterProvenance,
} from "@/aletheia/agentops/adapters";
import {
  buildAgentOpsSnapshotDetails,
  buildGateProvenance,
} from "@/aletheia/agentops/gateProvenance";
import { buildExportPackage } from "@/aletheia/agentops/exportPackage";
import { createMatterMemoryIndex } from "@/aletheia/agentops/matterMemory";
import {
  auditCandidatesFromResolutions,
  createBigAtAutocompleteCandidates,
  resolveBigAtReferences,
} from "@/aletheia/agentops/references";
import { computeWorkspaceEvalMetrics } from "@/lib/agentops/eval";
import {
  appendAletheiaAuditEvent,
  getAletheiaMatter,
  type AletheiaMatterDetail,
} from "@/app/lib/aletheiaApi";
import { GateChecklist } from "@/components/agentops/GateChecklist";
import { MatterCommandCenter } from "@/components/agentops/MatterCommandCenter";
import { ReferencePreviewCard } from "@/components/agentops/ReferencePreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function referenceTextForWorkspace(
  workspace: ReturnType<typeof adaptAletheiaMatterDetailToAgentOpsWorkspace>,
) {
  return [
    "@Matter",
    workspace.evidence[0]?.source_chunk_id
      ? `@Clause:${workspace.evidence[0].source_chunk_id}`
      : null,
    workspace.evidence[0] ? `@Evidence:${workspace.evidence[0].id}` : null,
    workspace.gate_results[0] ? `@Gate:${workspace.gate_results[0].id}` : null,
    workspace.runs[0] ? `@Run:${workspace.runs[0].id}` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ");
}

export function RemoteMatterCommandCenter({ matterId }: { matterId: string }) {
  const [detail, setDetail] = useState<AletheiaMatterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const data = await getAletheiaMatter(matterId);
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Matter load failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [matterId]);

  const workspace = useMemo(
    () => (detail ? adaptAletheiaMatterDetailToAgentOpsWorkspace(detail) : null),
    [detail],
  );
  const provenance = useMemo(
    () => (workspace ? summarizeAdapterProvenance(workspace) : null),
    [workspace],
  );
  const referenceResolutions = useMemo(() => {
    if (!workspace) return [];
    const index = createMatterMemoryIndex(workspace);
    return resolveBigAtReferences(referenceTextForWorkspace(workspace), index);
  }, [workspace]);
  const referenceAuditCandidates = useMemo(() => {
    if (!workspace) return [];
    return auditCandidatesFromResolutions(referenceResolutions, {
      artifact_type: "matter_memory",
      id: workspace.matter.id,
    });
  }, [referenceResolutions, workspace]);
  const referenceAutocompleteCandidates = useMemo(() => {
    if (!workspace) return [];
    const suggestedQueries = [
      "@Matter",
      "@Document",
      "@Clause",
      "@Evidence",
      "@Issue",
      "@Risk",
      "@Memo",
      "@Gate",
      "@Run",
    ];
    const byInsertionText = new Map<
      string,
      ReturnType<typeof createBigAtAutocompleteCandidates>[number]
    >();

    for (const query of suggestedQueries) {
      for (const candidate of createBigAtAutocompleteCandidates(query, workspace, 2)) {
        byInsertionText.set(candidate.insertion_text, candidate);
      }
    }

    return Array.from(byInsertionText.values()).slice(0, 8);
  }, [workspace]);
  const evalMetrics = useMemo(
    () => (workspace ? computeWorkspaceEvalMetrics(workspace) : null),
    [workspace],
  );
  const gateProvenance = useMemo(
    () => (detail && workspace ? buildGateProvenance({ detail, workspace }) : []),
    [detail, workspace],
  );
  const exportPackage = useMemo(
    () =>
      workspace
        ? buildExportPackage(workspace, workspace.matter.updated_at, {
            gateProvenance,
          })
        : null,
    [gateProvenance, workspace],
  );
  const exportPreview = useMemo(() => {
    if (!exportPackage) return "";

    return JSON.stringify(
      {
        schema_version: exportPackage.schema_version,
        matter_id: exportPackage.matter_id,
        export_hash: exportPackage.export_hash,
        manifest: exportPackage.manifest,
        typed_handoff_provenance:
          exportPackage.audit_pack.typed_handoff_provenance,
      },
      null,
      2,
    );
  }, [exportPackage]);

  function downloadExportPackage() {
    if (!exportPackage) return;

    const payload = JSON.stringify(exportPackage, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${exportPackage.matter_id}-agentops-export-package.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setExportStatus(
      `Export package JSON prepared (${exportPackage.manifest.handoff_provenance_items} handoff provenance items).`,
    );
  }

  async function recordAgentOpsSnapshot() {
    if (!workspace || !provenance || !evalMetrics) return;

    setSnapshotSaving(true);
    setSnapshotStatus("");
    setError("");
    try {
      const event = await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "agentops_snapshot_recorded",
        workflowVersion: "agentops-adapter-view-v0",
        details: buildAgentOpsSnapshotDetails({
          workspace,
          provenance,
          gateProvenance,
          referenceResolutions,
          evalMetrics,
        }),
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSnapshotStatus(`AgentOps snapshot recorded (${event.id}).`);
    } catch (err) {
      setSnapshotStatus(
        err instanceof Error ? err.message : "AgentOps snapshot could not be recorded.",
      );
    } finally {
      setSnapshotSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
          Loading adapter-backed Command Center...
        </div>
      </div>
    );
  }

  if (error || !workspace) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
          <p className="font-semibold">Command Center could not be loaded</p>
          <p className="mt-2 text-sm">
            {error || "Matter detail is unavailable."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 pt-6 sm:px-6 lg:px-8">
        <Link
          href={`/aletheia/matters/${matterId}`}
          className="inline-flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-950"
        >
          <ArrowLeft className="h-4 w-4" />
          Matter workspace
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {provenance && (
            <Badge
              variant="outline"
              className="rounded-md border-gray-200 bg-white px-2 py-1 text-xs text-gray-600"
            >
              {provenance.evidence_with_source_chunks}/
              {provenance.evidence_items} source-linked evidence
            </Badge>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDetail(null);
              setLoading(true);
              void getAletheiaMatter(matterId)
                .then(setDetail)
                .catch((err: unknown) => {
                  setError(
                    err instanceof Error ? err.message : "Matter reload failed",
                  );
                })
                .finally(() => setLoading(false));
            }}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="record-agentops-snapshot"
            disabled={!workspace || !evalMetrics || snapshotSaving}
            onClick={() => {
              void recordAgentOpsSnapshot();
            }}
          >
            Record Snapshot
          </Button>
        </div>
      </div>
      {snapshotStatus ? (
        <div className="mx-auto mt-3 w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <p
            data-testid="agentops-snapshot-status"
            className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
          >
            {snapshotStatus}
          </p>
        </div>
      ) : null}
      <div data-testid="adapter-backed-command-center">
        <MatterCommandCenter
          workspace={workspace}
          sourceLabel="Adapter-backed matter"
          artifactBasePath={`/aletheia/matters/${matterId}/agentops`}
        />
      </div>
      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-6 sm:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:px-8">
        {workspace.gate_results.length > 0 ? (
          <div className="grid gap-4">
            <GateChecklist gateResults={workspace.gate_results} />
            {gateProvenance.length > 0 ? (
              <section
                data-testid="agentops-gate-provenance"
                className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-gray-950">
                      Gate Provenance
                    </h2>
                    <p className="mt-1 text-sm text-gray-600">
                      Displayed gates mapped back to persisted Aletheia records.
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600"
                  >
                    {gateProvenance.filter((item) => item.sourceId).length}/
                    {gateProvenance.length} backed
                  </Badge>
                </div>
                <div className="mt-4 grid gap-2">
                  {gateProvenance.map((item) => (
                    <div
                      key={item.gateId}
                      className="rounded-md border border-gray-100 bg-gray-50 p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-gray-950">
                            {item.gateType.replaceAll("_", " ")}
                          </p>
                          <p className="mt-1 text-xs text-gray-600">
                            {item.sourceType.replaceAll("_", " ")}:{" "}
                            {item.sourceId ?? "missing"} ({item.sourceStatus})
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className="rounded-md border-gray-200 bg-white px-2 py-1 text-xs text-gray-600"
                        >
                          {item.status}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-gray-600">
                        {item.relatedAuditEventIds.length} audit events,{" "}
                        {item.relatedReviewIds.length} reviews,{" "}
                        {item.relatedWorkProductIds.length} work products
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600 shadow-sm">
            No adapter-derived gates are available for this matter yet.
          </div>
        )}

        <div className="grid gap-4">
          {evalMetrics ? (
            <section
              data-testid="adapter-backed-eval-signals"
              className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-gray-700" />
                  <h2 className="font-semibold text-gray-950">Eval Signals</h2>
                </div>
                <Badge
                  variant="outline"
                  className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600"
                >
                  {workspace.eval_cases.length} cases
                </Badge>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                {[
                  {
                    label: "Citation coverage",
                    value: `${Math.round(evalMetrics.citation_coverage * 100)}%`,
                  },
                  {
                    label: "Unsupported claims",
                    value: evalMetrics.unsupported_claim_count,
                  },
                  {
                    label: "Open reviews",
                    value: evalMetrics.unresolved_review_comments,
                  },
                  {
                    label: "Failed gates",
                    value: evalMetrics.gate_failure_count,
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-md border border-gray-100 bg-gray-50 p-3"
                  >
                    <dt className="text-xs font-semibold uppercase text-gray-400">
                      {item.label}
                    </dt>
                    <dd className="mt-2 text-xl font-semibold text-gray-950">
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {evalMetrics.issue_coverage ? (
                <p className="mt-3 text-sm text-gray-600">
                  {evalMetrics.issue_coverage.covered_issue_count}/
                  {evalMetrics.issue_coverage.total_issue_count} issues covered
                  by evidence or open questions.
                </p>
              ) : null}
            </section>
          ) : null}
          {exportPackage ? (
            <section
              data-testid="adapter-backed-export-package"
              className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-gray-950">
                    Audit Export Package
                  </h2>
                  <p className="mt-1 text-sm text-gray-600">
                    typed_handoff_provenance included with gate source IDs.
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600"
                >
                  {exportPackage.schema_version}
                </Badge>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-md border border-gray-100 bg-gray-50 p-3">
                  <dt className="text-xs font-semibold uppercase text-gray-400">
                    Handoff provenance
                  </dt>
                  <dd className="mt-2 text-xl font-semibold text-gray-950">
                    {exportPackage.manifest.handoff_provenance_items}
                  </dd>
                </div>
                <div className="rounded-md border border-gray-100 bg-gray-50 p-3">
                  <dt className="text-xs font-semibold uppercase text-gray-400">
                    Export hash
                  </dt>
                  <dd className="mt-2 break-all text-sm font-semibold text-gray-950">
                    {exportPackage.export_hash}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-gray-500">
                Manifest links {exportPackage.manifest.gate_results} gates,{" "}
                {exportPackage.manifest.audit_events} audit events, and{" "}
                {exportPackage.manifest.eval_cases} eval cases.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="download-agentops-export-package"
                  onClick={downloadExportPackage}
                >
                  <Download className="h-4 w-4" />
                  Download JSON
                </Button>
                {exportStatus ? (
                  <span
                    data-testid="agentops-export-status"
                    className="text-xs text-gray-600"
                  >
                    {exportStatus}
                  </span>
                ) : null}
              </div>
              <details className="mt-4 rounded-md border border-gray-100 bg-gray-50 p-3">
                <summary className="cursor-pointer text-sm font-medium text-gray-700">
                  Preview handoff payload
                </summary>
                <pre
                  data-testid="agentops-export-preview"
                  className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-700"
                >
                  {exportPreview}
                </pre>
              </details>
            </section>
          ) : null}
        </div>
      </section>
      {referenceResolutions.length > 0 ? (
        <section
          data-testid="adapter-backed-references"
          className="mx-auto w-full max-w-7xl px-4 pb-6 sm:px-6 lg:px-8"
        >
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold uppercase text-gray-500">
                  Matter References
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  {referenceResolutions.length} adapter-backed references
                </p>
              </div>
              <Badge
                variant="outline"
                className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600"
              >
                {referenceResolutions.filter((item) => item.status === "resolved").length} resolved
              </Badge>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {[
                {
                  label: "resolved",
                  value: referenceAuditCandidates.filter(
                    (candidate) => candidate.status === "resolved",
                  ).length,
                  className: "border-emerald-100 bg-emerald-50 text-emerald-700",
                },
                {
                  label: "ambiguous",
                  value: referenceAuditCandidates.filter(
                    (candidate) => candidate.status === "ambiguous",
                  ).length,
                  className: "border-amber-100 bg-amber-50 text-amber-700",
                },
                {
                  label: "missing",
                  value: referenceAuditCandidates.filter(
                    (candidate) => candidate.status === "missing",
                  ).length,
                  className: "border-red-100 bg-red-50 text-red-700",
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className={`rounded-md border px-3 py-2 text-sm ${item.className}`}
                >
                  <span className="font-semibold">{item.value}</span>{" "}
                  <span className="capitalize">{item.label}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Ambiguous and missing references stay as review/audit candidates;
              they are not used as support until resolved.
            </p>
            {referenceAutocompleteCandidates.length > 0 ? (
              <div className="mt-4 rounded-md border border-gray-100 bg-gray-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase text-gray-500">
                    Autocomplete Candidates
                  </h3>
                  <Badge
                    variant="outline"
                    className="rounded-md border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600"
                  >
                    read-only suggestions
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {referenceAutocompleteCandidates.map((candidate) => (
                    <code
                      key={candidate.insertion_text}
                      className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
                      title={candidate.description}
                    >
                      {candidate.insertion_text}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {referenceResolutions.map((resolution) => (
                <ReferencePreviewCard
                  key={resolution.reference.raw}
                  resolution={resolution}
                />
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
