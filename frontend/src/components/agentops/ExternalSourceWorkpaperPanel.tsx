"use client";

import { useMemo, useState } from "react";
import { FileCheck2, ShieldCheck } from "lucide-react";
import {
  addAletheiaReview,
  appendAletheiaAuditEvent,
  createAletheiaWorkProduct,
  decideAletheiaApproval,
  fetchAletheiaExternalSource,
  requestAletheiaApproval,
  type AletheiaMatterDetail,
} from "@/app/lib/aletheiaApi";
import {
  validateAnduParityContracts,
  type ExternalCheckArtifact,
} from "@/aletheia/agentops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type CheckType = ExternalCheckArtifact["check_type"];
type SourceCaptureMode = "manual_capture" | "allowlisted_https_fetch";

type ExternalWorkpaperAuditDetails = {
  workpaperId?: string;
  externalCheck?: ExternalCheckArtifact;
  validation?: Array<{ name?: string; status?: string }>;
};

const checkTypes: Array<{ value: CheckType; label: string }> = [
  { value: "whole_web", label: "Whole-web check" },
  { value: "network_check", label: "Network check" },
  { value: "related_party", label: "Related-party check" },
  { value: "customer_supplier", label: "Customer / supplier check" },
  { value: "shareholder_penetration", label: "Shareholder penetration" },
];

function checkTypeLabel(value: CheckType) {
  return checkTypes.find((item) => item.value === value)?.label ?? value;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function sha256(value: string) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot create the required source hash.");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function auditDetails(value: Record<string, unknown>) {
  return value as ExternalWorkpaperAuditDetails;
}

export function ExternalSourceWorkpaperPanel({
  matterId,
  detail,
  onPersisted,
}: {
  matterId: string;
  detail: AletheiaMatterDetail;
  onPersisted: () => Promise<void>;
}) {
  const [checkType, setCheckType] = useState<CheckType>("whole_web");
  const [captureMode, setCaptureMode] = useState<SourceCaptureMode>("manual_capture");
  const [query, setQuery] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [observation, setObservation] = useState("");
  const [externalAccessOptIn, setExternalAccessOptIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const persisted = useMemo(() => {
    const auditByWorkpaper = new Map<string, ExternalWorkpaperAuditDetails>();
    for (const event of detail.auditEvents) {
      if (event.action !== "human_note.external_source_workpaper_persisted") continue;
      const details = auditDetails(event.details);
      if (details.workpaperId) auditByWorkpaper.set(details.workpaperId, details);
    }
    return detail.workProducts
      .filter((workProduct) => workProduct.kind === "external_source_workpaper")
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

  async function recordWorkpaper() {
    const trimmedQuery = query.trim();
    const trimmedUrl = sourceUrl.trim();
    const trimmedObservation = observation.trim();
    setMessage("");

    if (!externalAccessOptIn) {
      setMessage("Explicit external-source access approval is required.");
      return;
    }
    if (
      !trimmedQuery ||
      !isHttpUrl(trimmedUrl) ||
      (captureMode === "manual_capture" && !trimmedObservation)
    ) {
      setMessage(
        captureMode === "manual_capture"
          ? "A query, HTTP(S) source URL, and captured observation are required."
          : "A query and HTTPS source URL are required for automatic capture.",
      );
      return;
    }

    setSaving(true);
    try {
      const manualCapture = captureMode === "manual_capture";
      const approvalUrlHash = manualCapture ? null : await sha256(trimmedUrl);
      const externalApproval = manualCapture
        ? null
        : await requestAletheiaApproval(matterId, {
            action: "external_source_use",
            prompt: `Authorize allowlisted retrieval for ${trimmedUrl}`,
            requestedPayload: {
              checkType,
              query: trimmedQuery,
              sourceUrlHash: approvalUrlHash,
            },
          });
      if (externalApproval) {
        await decideAletheiaApproval(matterId, externalApproval.id, {
          decision: "approved",
          comment: "Approved from the explicit external-source capture action.",
        });
      }
      const automaticCapture = manualCapture
        ? null
        : await fetchAletheiaExternalSource(matterId, {
            url: trimmedUrl,
            externalAccessOptIn: true,
            approvalCheckpointId: externalApproval!.id,
          });
      const capturedAt = automaticCapture?.capturedAt ?? new Date().toISOString();
      const capturedUrl = automaticCapture?.url ?? trimmedUrl;
      const capturedObservation = automaticCapture?.observation ?? trimmedObservation;
      const connector = automaticCapture?.connector ?? "manual_source_capture";
      const networkFetchDispatched = automaticCapture?.networkFetchDispatched ?? false;
      const [urlHash, snapshotHash] = automaticCapture
        ? [automaticCapture.urlHash, automaticCapture.snapshotHash]
        : await Promise.all([
            sha256(capturedUrl),
            sha256(`${capturedUrl}\n${capturedAt}\n${capturedObservation}`),
          ]);
      const consentAudit = await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "human_note.external_source_access_opt_in_recorded",
        workflowVersion: "hermes-external-source-workpaper-v0",
        details: {
          schemaVersion: "hermes-external-source-consent-v0",
          externalAccessOptIn: true,
          checkType,
          query: trimmedQuery,
          sourceUrl: capturedUrl,
          capturedAt,
          urlHash,
          snapshotHash,
          connector,
          networkFetchDispatched,
          automaticCapture: automaticCapture
            ? {
                host: automaticCapture.host,
                contentType: automaticCapture.contentType,
                responseBytes: automaticCapture.responseBytes,
              }
            : undefined,
        },
      });
      const workpaper = await createAletheiaWorkProduct(matterId, {
        kind: "external_source_workpaper",
        title: `${checkTypeLabel(checkType)}: ${trimmedQuery.slice(0, 160)}`,
        status: "needs_review",
        schemaVersion: "hermes-external-source-workpaper-v0",
        generatedBy: "human",
        content: {
          schemaVersion: "hermes-external-source-workpaper-v0",
          status: "needs_review",
          connector,
          networkFetchDispatched,
          externalAccessOptIn: true,
          checkType,
          query: trimmedQuery,
          sourceCapture: {
            url: capturedUrl,
            capturedAt,
            urlHash,
            snapshotHash,
            observation: capturedObservation,
          },
          consentAuditEventId: consentAudit.id,
          professionalCaveat:
            "Captured external material is a review-only workpaper and is not a legal conclusion or verified automated search result.",
        },
      });
      const review = await addAletheiaReview(matterId, {
        targetType: "work_product",
        targetId: workpaper.id,
        workProductId: workpaper.id,
        tag: "needs_human_judgment",
        comment:
          "Review source authenticity, capture completeness, relevance, and whether the stated result can support any professional conclusion.",
      });
      const externalCheck: ExternalCheckArtifact = {
        id: `external-check:${workpaper.id}`,
        matter_id: matterId,
        check_type: checkType,
        query: trimmedQuery,
        connector_id: connector,
        external_access_opt_in: true,
        status: "needs_review",
        source_refs: [
          {
            id: `${workpaper.id}:external-url`,
            type: "external_url",
            url: capturedUrl,
            hash: urlHash,
            audit_event_id: consentAudit.id,
          },
          {
            id: `${workpaper.id}:external-snapshot`,
            type: "external_snapshot",
            url: capturedUrl,
            captured_at: capturedAt,
            hash: snapshotHash,
            audit_event_id: consentAudit.id,
          },
        ],
        workpaper_ids: [workpaper.id],
        review_comment_ids: [review.id],
        audit_event_ids: [consentAudit.id],
      };
      const validation = validateAnduParityContracts({ externalChecks: [externalCheck] });
      if (validation.some((item) => item.status === "failed")) {
        throw new Error("External-source provenance validation failed before persistence.");
      }
      await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "human_note.external_source_workpaper_persisted",
        workflowVersion: "hermes-external-source-workpaper-v0",
        details: {
          schemaVersion: "hermes-external-source-workpaper-v0",
          workpaperId: workpaper.id,
          reviewCommentId: review.id,
          consentAuditEventId: consentAudit.id,
          externalCheck,
          validation,
          networkFetchDispatched,
        },
      });
      setQuery("");
      setSourceUrl("");
      setObservation("");
      setExternalAccessOptIn(false);
      await onPersisted();
      setMessage(`External-source workpaper recorded (${workpaper.id}).`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "External-source workpaper could not be recorded.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      data-testid="external-source-workpaper-panel"
      className="rounded-lg border border-gray-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-gray-700" />
            <h2 className="font-semibold text-gray-950">External Source Workpapers</h2>
          </div>
          <p className="mt-1 text-sm text-gray-600">
            Captures remain review-only. Automatic retrieval requires a configured HTTPS allowlist.
          </p>
        </div>
        <Badge
          variant="outline"
          className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600"
        >
          {persisted.length} recorded
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-gray-700">
          Check type
          <select
            data-testid="external-source-check-type"
            value={checkType}
            onChange={(event) => setCheckType(event.target.value as CheckType)}
            className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-400"
          >
            {checkTypes.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-700">
          Capture mode
          <select
            data-testid="external-source-capture-mode"
            value={captureMode}
            onChange={(event) => setCaptureMode(event.target.value as SourceCaptureMode)}
            className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-400"
          >
            <option value="manual_capture">Manual source capture</option>
            <option value="allowlisted_https_fetch">Allowlisted automatic capture</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-700">
          Query
          <input
            data-testid="external-source-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={1000}
            className="h-9 rounded-md border border-gray-200 px-3 text-sm font-normal text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-700 md:col-span-2">
          Source URL
          <input
            data-testid="external-source-url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            inputMode="url"
            maxLength={4000}
            className="h-9 rounded-md border border-gray-200 px-3 text-sm font-normal text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400"
          />
        </label>
        {captureMode === "manual_capture" ? (
          <label className="grid gap-1.5 text-xs font-medium text-gray-700 md:col-span-2">
            Captured observation
            <textarea
              data-testid="external-source-observation"
              value={observation}
              onChange={(event) => setObservation(event.target.value)}
              maxLength={12000}
              rows={4}
              className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm font-normal text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400"
            />
          </label>
        ) : (
          <p className="text-xs leading-5 text-gray-600 md:col-span-2">
            Hermes will retrieve only an HTTPS source whose host is configured in the server allowlist. Redirects, private addresses, unsupported content, and oversized responses are blocked; the captured text still requires human review.
          </p>
        )}
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-gray-700">
        <input
          data-testid="external-source-opt-in"
          type="checkbox"
          checked={externalAccessOptIn}
          onChange={(event) => setExternalAccessOptIn(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300"
        />
        <span>I authorize this {captureMode === "manual_capture" ? "external-source capture" : "allowlisted automatic external retrieval"} for this matter.</span>
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          data-testid="record-external-source-workpaper"
          disabled={saving}
          onClick={() => void recordWorkpaper()}
        >
          <FileCheck2 className="h-4 w-4" />
          {captureMode === "manual_capture" ? "Record Workpaper" : "Capture and Record"}
        </Button>
        {message ? (
          <span data-testid="external-source-workpaper-status" className="text-xs text-gray-600">
            {message}
          </span>
        ) : null}
      </div>

      {persisted.length > 0 ? (
        <div className="mt-5 grid gap-2 border-t border-gray-100 pt-4">
          {persisted.map(({ workProduct, audit, reviews }) => {
            const externalCheck = audit?.externalCheck;
            const source = externalCheck?.source_refs.find(
              (item) => item.type === "external_snapshot",
            );
            const validationPassed = audit?.validation?.every(
              (item) => item.status !== "failed",
            );
            return (
              <div
                key={workProduct.id}
                data-testid="external-source-workpaper-record"
                className="rounded-md border border-gray-100 bg-gray-50 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-950">{workProduct.title}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {source?.captured_at ?? workProduct.created_at} · {reviews.length} review item{reviews.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="rounded-md border-amber-100 bg-amber-50 px-2 py-1 text-xs text-amber-700"
                  >
                    {workProduct.status.replaceAll("_", " ")}
                  </Badge>
                </div>
                <p className="mt-2 break-all text-xs text-gray-600">
                  {source?.url ?? "Source details are retained in the workpaper."}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Provenance {validationPassed ? "validated" : "pending audit validation"}.
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
