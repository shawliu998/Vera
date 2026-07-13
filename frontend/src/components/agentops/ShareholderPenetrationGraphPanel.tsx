"use client";

import { useMemo, useState } from "react";
import { ArrowDown, Building2, Network, UserRound } from "lucide-react";
import {
  addAletheiaReview,
  approveAletheiaShareholderPenetrationGraph,
  appendAletheiaAuditEvent,
  createAletheiaWorkProduct,
  resolveAletheiaReview,
  type AletheiaMatterDetail,
} from "@/app/lib/aletheiaApi";
import {
  validateAnduParityContracts,
  type AnduParitySourceRef,
  type EntityGraphEdge,
  type EntityGraphNode,
  type ExternalCheckArtifact,
} from "@/aletheia/agentops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type ExternalWorkpaperAuditDetails = {
  workpaperId?: string;
  externalCheck?: ExternalCheckArtifact;
};

type ShareholderGraphAuditDetails = {
  workpaperId?: string;
  sourceWorkpaperId?: string;
  nodes?: EntityGraphNode[];
  edges?: EntityGraphEdge[];
  validation?: Array<{ name?: string; status?: string }>;
};

function details<T>(value: Record<string, unknown>) {
  return value as T;
}

function sourceName(workpaperTitle: string, check?: ExternalCheckArtifact) {
  const query = check?.query?.trim();
  return query ? `${workpaperTitle} (${query})` : workpaperTitle;
}

export function ShareholderPenetrationGraphPanel({
  matterId,
  detail,
  onPersisted,
}: {
  matterId: string;
  detail: AletheiaMatterDetail;
  onPersisted: () => Promise<void>;
}) {
  const [sourceWorkpaperId, setSourceWorkpaperId] = useState("");
  const [issuerName, setIssuerName] = useState("");
  const [shareholderName, setShareholderName] = useState("");
  const [beneficialOwnerName, setBeneficialOwnerName] = useState("");
  const [ownershipPercentage, setOwnershipPercentage] = useState("");
  const [evidenceStatus, setEvidenceStatus] = useState<EntityGraphEdge["evidence_status"]>("inferred");
  const [conflictNote, setConflictNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [actingGraphId, setActingGraphId] = useState("");
  const [message, setMessage] = useState("");

  const sourceWorkpapers = useMemo(() => {
    const auditByWorkpaper = new Map<string, ExternalCheckArtifact>();
    for (const event of detail.auditEvents) {
      if (event.action !== "human_note.external_source_workpaper_persisted") continue;
      const audit = details<ExternalWorkpaperAuditDetails>(event.details);
      if (audit.workpaperId && audit.externalCheck) {
        auditByWorkpaper.set(audit.workpaperId, audit.externalCheck);
      }
    }
    return detail.workProducts
      .filter((workProduct) => workProduct.kind === "external_source_workpaper")
      .map((workProduct) => ({
        workProduct,
        externalCheck: auditByWorkpaper.get(workProduct.id),
      }))
      .filter(
        (item): item is { workProduct: typeof item.workProduct; externalCheck: ExternalCheckArtifact } =>
          Boolean(item.externalCheck?.source_refs.length),
      )
      .sort((left, right) =>
        right.workProduct.created_at.localeCompare(left.workProduct.created_at),
      );
  }, [detail.auditEvents, detail.workProducts]);

  const persisted = useMemo(() => {
    const auditByWorkpaper = new Map<string, ShareholderGraphAuditDetails>();
    for (const event of detail.auditEvents) {
      if (event.action !== "human_note.shareholder_penetration_graph_persisted") continue;
      const audit = details<ShareholderGraphAuditDetails>(event.details);
      if (audit.workpaperId) auditByWorkpaper.set(audit.workpaperId, audit);
    }
    return detail.workProducts
      .filter((workProduct) => workProduct.kind === "shareholder_penetration_graph")
      .map((workProduct) => ({
        workProduct,
        audit: auditByWorkpaper.get(workProduct.id),
        reviews: detail.reviews.filter(
          (review) => review.work_product_id === workProduct.id,
        ),
      }))
      .sort((left, right) =>
        right.workProduct.created_at.localeCompare(left.workProduct.created_at),
      );
  }, [detail.auditEvents, detail.reviews, detail.workProducts]);

  const selectedSourceId = sourceWorkpaperId || sourceWorkpapers[0]?.workProduct.id || "";

  async function recordGraph() {
    const issuer = issuerName.trim();
    const shareholder = shareholderName.trim();
    const beneficialOwners = beneficialOwnerName
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    const percentage = ownershipPercentage.trim() ? Number(ownershipPercentage) : undefined;
    const source = sourceWorkpapers.find(
      (item) => item.workProduct.id === selectedSourceId,
    );
    setMessage("");

    if (!source) {
      setMessage("Record an external-source workpaper before creating a graph.");
      return;
    }
    if (!issuer || !shareholder || !beneficialOwners.length) {
      setMessage("Issuer, direct shareholder, and at least one beneficial owner are required.");
      return;
    }
    if (percentage !== undefined && (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)) {
      setMessage("Ownership percentage must be between 0 and 100.");
      return;
    }
    if (evidenceStatus === "conflicting" && !conflictNote.trim()) {
      setMessage("Conflicting ownership evidence requires a conflict note.");
      return;
    }

    setSaving(true);
    try {
      const workpaper = await createAletheiaWorkProduct(matterId, {
        kind: "shareholder_penetration_graph",
        title: `Shareholder Penetration: ${issuer.slice(0, 160)}`,
        status: "needs_review",
        schemaVersion: "hermes-shareholder-penetration-v0",
        generatedBy: "human",
        content: {
          schemaVersion: "hermes-shareholder-penetration-v0",
          status: "needs_review",
          issuerName: issuer,
          directShareholderName: shareholder,
          beneficialOwnerNames: beneficialOwners,
          ownershipPercentage: percentage,
          evidenceStatus,
          conflictNote: conflictNote.trim() || undefined,
          sourceWorkpaperId: source.workProduct.id,
          sourceCheckId: source.externalCheck.id,
          professionalCaveat:
            "This graph is a review-only representation of supplied source material and is not a final ownership conclusion.",
        },
      });
      const review = await addAletheiaReview(matterId, {
        targetType: "work_product",
        targetId: workpaper.id,
        workProductId: workpaper.id,
        tag: "needs_human_judgment",
        comment:
          "Verify the ownership chain, source recency, entity identity, relationship basis, and confidence before relying on this penetration graph.",
      });
      const sourceRefs: AnduParitySourceRef[] = source.externalCheck.source_refs;
      const auditEventIds = [
        ...new Set(source.externalCheck.audit_event_ids),
      ];
      const nodes: EntityGraphNode[] = [
        {
          id: `${workpaper.id}:issuer`,
          matter_id: matterId,
          kind: "company",
          name: issuer,
          source_refs: sourceRefs,
        },
        {
          id: `${workpaper.id}:shareholder`,
          matter_id: matterId,
          kind: "shareholder",
          name: shareholder,
          source_refs: sourceRefs,
        },
        ...beneficialOwners.map((owner, index): EntityGraphNode => ({
          id: `${workpaper.id}:beneficial-owner-${index + 1}`,
          matter_id: matterId,
          kind: "beneficial_owner",
          name: owner,
          source_refs: sourceRefs,
        })),
      ];
      const edges: EntityGraphEdge[] = [
        ...beneficialOwners.map((_, index): EntityGraphEdge => ({
          id: `${workpaper.id}:beneficial-owner-${index + 1}-controls-shareholder`,
          matter_id: matterId,
          from_node_id: `${workpaper.id}:beneficial-owner-${index + 1}`,
          to_node_id: `${workpaper.id}:shareholder`,
          relationship: "beneficially_owns",
          evidence_status: evidenceStatus,
          confidence: 0.7,
          ownership_percentage: percentage,
          conflict_note: conflictNote.trim() || undefined,
          source_refs: sourceRefs,
          review_comment_ids: [review.id],
          audit_event_ids: auditEventIds,
        })),
        {
          id: `${workpaper.id}:shareholder-owns-issuer`,
          matter_id: matterId,
          from_node_id: `${workpaper.id}:shareholder`,
          to_node_id: `${workpaper.id}:issuer`,
          relationship: "owns",
          evidence_status: evidenceStatus,
          confidence: 0.7,
          ownership_percentage: percentage,
          conflict_note: conflictNote.trim() || undefined,
          source_refs: sourceRefs,
          review_comment_ids: [review.id],
          audit_event_ids: auditEventIds,
        },
      ];
      const validation = validateAnduParityContracts({
        externalChecks: [source.externalCheck],
        entityGraphNodes: nodes,
        entityGraphEdges: edges,
      });
      if (validation.some((item) => item.status === "failed")) {
        throw new Error("Shareholder graph provenance validation failed before persistence.");
      }
      await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "human_note.shareholder_penetration_graph_persisted",
        workflowVersion: "hermes-shareholder-penetration-v0",
        details: {
          schemaVersion: "hermes-shareholder-penetration-v0",
          workpaperId: workpaper.id,
          sourceWorkpaperId: source.workProduct.id,
          reviewCommentId: review.id,
          nodes,
          edges,
          validation,
        },
      });
      setIssuerName("");
      setShareholderName("");
      setBeneficialOwnerName("");
      setOwnershipPercentage("");
      setEvidenceStatus("inferred");
      setConflictNote("");
      await onPersisted();
      setMessage(`Shareholder penetration graph recorded (${workpaper.id}).`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Shareholder penetration graph could not be recorded.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function acceptGraphReview(reviewId: string) {
    setMessage("");
    setActingGraphId(reviewId);
    try {
      await resolveAletheiaReview(matterId, reviewId, {
        status: "accepted",
        comment:
          "Reviewer accepted the source basis and relationship treatment for the shareholder penetration graph.",
        createEvalCase: false,
      });
      await onPersisted();
      setMessage("Shareholder graph review accepted. Approval can proceed when all reviews are resolved.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Shareholder graph review could not be accepted.",
      );
    } finally {
      setActingGraphId("");
    }
  }

  async function approveGraph(graphId: string) {
    setMessage("");
    setActingGraphId(graphId);
    try {
      await approveAletheiaShareholderPenetrationGraph(matterId, graphId);
      await onPersisted();
      setMessage("Shareholder penetration graph approved.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Shareholder penetration graph could not be approved.",
      );
    } finally {
      setActingGraphId("");
    }
  }

  return (
    <section
      data-testid="shareholder-penetration-graph-panel"
      className="rounded-lg border border-gray-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-gray-700" />
            <h2 className="font-semibold text-gray-950">Shareholder Penetration</h2>
          </div>
          <p className="mt-1 text-sm text-gray-600">
            Relationships remain review-only until their retained sources and ownership basis are confirmed.
          </p>
        </div>
        <Badge
          variant="outline"
          className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600"
        >
          {persisted.length} graph{persisted.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-gray-700 md:col-span-2">
          Retained source workpaper
          <select
            data-testid="shareholder-graph-source-workpaper"
            value={selectedSourceId}
            onChange={(event) => setSourceWorkpaperId(event.target.value)}
            disabled={sourceWorkpapers.length === 0}
            className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm font-normal text-gray-900 outline-none disabled:bg-gray-50 disabled:text-gray-400 focus:border-gray-400"
          >
            {sourceWorkpapers.length === 0 ? (
              <option value="">No retained external-source workpaper</option>
            ) : (
              sourceWorkpapers.map((item) => (
                <option key={item.workProduct.id} value={item.workProduct.id}>
                  {sourceName(item.workProduct.title, item.externalCheck)}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-700">
          Issuer
          <input
            data-testid="shareholder-graph-issuer"
            value={issuerName}
            onChange={(event) => setIssuerName(event.target.value)}
            maxLength={400}
            className="h-9 rounded-md border border-gray-200 px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-400"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-700">
          Direct shareholder
          <input
            data-testid="shareholder-graph-shareholder"
            value={shareholderName}
            onChange={(event) => setShareholderName(event.target.value)}
            maxLength={400}
            className="h-9 rounded-md border border-gray-200 px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-400"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-700 md:col-span-2">
          Beneficial owner(s)
          <input
            data-testid="shareholder-graph-beneficial-owner"
            value={beneficialOwnerName}
            onChange={(event) => setBeneficialOwnerName(event.target.value)}
            maxLength={400}
            className="h-9 rounded-md border border-gray-200 px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-400"
          />
          <span className="text-xs font-normal text-gray-500">Separate multiple owners with semicolons.</span>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-700">
          Ownership percentage
          <input data-testid="shareholder-graph-ownership-percentage" value={ownershipPercentage} onChange={(event) => setOwnershipPercentage(event.target.value)} inputMode="decimal" placeholder="Optional" className="h-9 rounded-md border border-gray-200 px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-400" />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-700">
          Evidence status
          <select data-testid="shareholder-graph-evidence-status" value={evidenceStatus} onChange={(event) => setEvidenceStatus(event.target.value as EntityGraphEdge["evidence_status"])} className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-400"><option value="inferred">Inferred</option><option value="confirmed">Confirmed</option><option value="conflicting">Conflicting</option></select>
        </label>
        {evidenceStatus === "conflicting" ? <label className="grid gap-1.5 text-xs font-medium text-gray-700 md:col-span-2">Conflict note<textarea data-testid="shareholder-graph-conflict-note" value={conflictNote} onChange={(event) => setConflictNote(event.target.value)} rows={2} maxLength={2000} className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-400" /></label> : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          data-testid="record-shareholder-penetration-graph"
          disabled={saving || sourceWorkpapers.length === 0}
          onClick={() => void recordGraph()}
        >
          <Network className="h-4 w-4" />
          Record Graph
        </Button>
        {message ? (
          <span data-testid="shareholder-graph-status" className="text-xs text-gray-600">
            {message}
          </span>
        ) : null}
      </div>

      {persisted.length > 0 ? (
        <div className="mt-5 grid gap-3 border-t border-gray-100 pt-4">
          {persisted.map(({ workProduct, audit, reviews }) => {
            const nodes = audit?.nodes ?? [];
            const edges = audit?.edges ?? [];
            const issuer = nodes.find((node) => node.kind === "company");
            const shareholder = nodes.find((node) => node.kind === "shareholder");
            const owners = nodes.filter((node) => node.kind === "beneficial_owner");
            const ownershipEdge = edges.find((edge) => edge.relationship === "owns");
            const validationPassed = audit?.validation?.every(
              (item) => item.status !== "failed",
            );
            const openReviews = reviews.filter(
              (review) => review.resolution_status === "open",
            );
            const accepted = workProduct.status === "accepted";
            return (
              <div
                key={workProduct.id}
                data-testid="shareholder-penetration-graph-record"
                className="rounded-md border border-gray-100 bg-gray-50 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-950">{workProduct.title}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {reviews.length} review item{reviews.length === 1 ? "" : "s"} · {validationPassed ? "provenance validated" : "audit validation pending"}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      accepted
                        ? "rounded-md border-emerald-100 bg-emerald-50 px-2 py-1 text-xs text-emerald-700"
                        : "rounded-md border-amber-100 bg-amber-50 px-2 py-1 text-xs text-amber-700"
                    }
                  >
                    {workProduct.status.replaceAll("_", " ")}
                  </Badge>
                </div>
                {ownershipEdge?.ownership_percentage !== undefined || ownershipEdge?.evidence_status === "conflicting" ? <p className="mt-3 text-xs text-gray-600">{ownershipEdge?.ownership_percentage !== undefined ? `${ownershipEdge.ownership_percentage}% recorded ownership` : "Ownership percentage not recorded"}{ownershipEdge?.evidence_status === "conflicting" ? ` · Conflict: ${ownershipEdge.conflict_note ?? "review required"}` : ""}</p> : null}
                <div className="mt-4 grid justify-items-center gap-2 text-center">
                  <div className="grid max-w-full grid-cols-1 gap-2 sm:grid-cols-2">
                    {(owners.length ? owners : [{ id: "owner", name: "Beneficial owner" }]).map((owner) => <div key={owner.id} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"><UserRound className="mx-auto mb-1 h-4 w-4 text-gray-500" />{owner.name}</div>)}
                  </div>
                  <span className="text-xs text-gray-500">beneficially owns</span>
                  <ArrowDown className="h-4 w-4 text-gray-400" />
                  <div className="max-w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900">
                    <Building2 className="mx-auto mb-1 h-4 w-4 text-gray-500" />
                    {shareholder?.name ?? "Direct shareholder"}
                  </div>
                  <span className="text-xs text-gray-500">owns</span>
                  <ArrowDown className="h-4 w-4 text-gray-400" />
                  <div className="max-w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900">
                    <Building2 className="mx-auto mb-1 h-4 w-4 text-gray-500" />
                    {issuer?.name ?? "Issuer"}
                  </div>
                </div>
                {!accepted ? (
                  <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-3">
                    {openReviews.map((review) => (
                      <Button
                        key={review.id}
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`accept-shareholder-graph-review-${review.id}`}
                        disabled={Boolean(actingGraphId)}
                        onClick={() => void acceptGraphReview(review.id)}
                      >
                        Accept review
                      </Button>
                    ))}
                    <Button
                      type="button"
                      size="sm"
                      data-testid={`approve-shareholder-graph-${workProduct.id}`}
                      disabled={Boolean(actingGraphId) || openReviews.length > 0}
                      onClick={() => void approveGraph(workProduct.id)}
                    >
                      Approve graph
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
