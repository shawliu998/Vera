"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileText,
  Flag,
  History,
  ListChecks,
  MessageSquarePlus,
  SearchCheck,
  ShieldAlert,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  auditExportEvent,
  buildAuditPack,
  buildFeedbackEvalDataset,
  downloadJson,
} from "./exports";
import { AletheiaShell } from "./AletheiaShell";
import { createReviewAuditEvent, getFeedbackSummary } from "./workflow";
import {
  deriveReviewStudioModel,
  type EvidenceDecision,
  type ReviewStudioState,
} from "./reviewStudio";
import type {
  AuditEvent,
  EvidenceItem,
  MatterWorkspace,
  ReviewItem,
  ReviewTag,
  RiskLevel,
} from "./types";

const reviewTags: ReviewTag[] = [
  "accepted",
  "needs_human_judgment",
  "citation_not_supporting",
  "missing_fact",
  "overclaim",
  "unsupported_claim",
  "conflicting_evidence",
  "rejected",
];

function riskClass(risk?: RiskLevel) {
  if (risk === "high") return "text-red-600";
  if (risk === "medium") return "text-amber-700";
  return "text-gray-500";
}

function supportClass(status: EvidenceItem["supportStatus"]) {
  if (status === "supports")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "contradicts") return "border-red-200 bg-red-50 text-red-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function decisionClass(status: EvidenceDecision) {
  if (status === "approved")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "rejected") return "border-red-200 bg-red-50 text-red-700";
  return "border-gray-200 bg-gray-50 text-gray-600";
}

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function formatAuditTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

export function AletheiaWorkspace({
  workspace,
}: {
  workspace: MatterWorkspace;
}) {
  const [selectedClaimId, setSelectedClaimId] = useState(
    workspace.issues[0]?.id ?? "",
  );
  const [reviews, setReviews] = useState<ReviewItem[]>(workspace.reviews);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>(
    workspace.auditEvents,
  );
  const [selectedTag, setSelectedTag] = useState<ReviewTag>(
    "needs_human_judgment",
  );
  const [comment, setComment] = useState(
    "Keep damages conclusion framed as risk-weighted until actual loss proof is supplied.",
  );
  const [evidenceDecisions, setEvidenceDecisions] = useState<
    ReviewStudioState["evidenceDecisions"]
  >({});
  const [factOverrides, setFactOverrides] = useState<
    ReviewStudioState["factOverrides"]
  >({});
  const [riskOverrides, setRiskOverrides] = useState<
    ReviewStudioState["riskOverrides"]
  >({});
  const [omittedIssueIds, setOmittedIssueIds] = useState<string[]>([]);
  const [supplementalMaterialRequests, setSupplementalMaterialRequests] =
    useState<string[]>([]);
  const [finalExportApproved, setFinalExportApproved] = useState(false);
  const [materialRequest, setMaterialRequest] = useState(
    "Acceptance testing records",
  );

  const selectedIssue = workspace.issues.find(
    (issue) => issue.id === selectedClaimId,
  );
  const selectedEvidence = workspace.evidence.filter(
    (item) => item.claimId === selectedClaimId,
  );
  const activeWorkspace = useMemo(
    () => ({ ...workspace, reviews }),
    [reviews, workspace],
  );
  const reviewStudioState = useMemo<ReviewStudioState>(
    () => ({
      evidenceDecisions,
      factOverrides,
      riskOverrides,
      omittedIssueIds,
      supplementalMaterialRequests,
      finalExportApproved,
    }),
    [
      evidenceDecisions,
      factOverrides,
      finalExportApproved,
      omittedIssueIds,
      riskOverrides,
      supplementalMaterialRequests,
    ],
  );
  const reviewStudio = useMemo(
    () => deriveReviewStudioModel(activeWorkspace, reviewStudioState),
    [activeWorkspace, reviewStudioState],
  );
  const feedback = useMemo(() => getFeedbackSummary(reviews), [reviews]);

  function decideEvidence(evidenceId: string, decision: EvidenceDecision) {
    setEvidenceDecisions((current) => ({
      ...current,
      [evidenceId]: decision,
    }));
  }

  function updateFact(evidenceId: string, fact: string) {
    setFactOverrides((current) => ({
      ...current,
      [evidenceId]: fact,
    }));
  }

  function updateRisk(issueId: string, riskLevel: RiskLevel) {
    setRiskOverrides((current) => ({
      ...current,
      [issueId]: riskLevel,
    }));
  }

  function flagSelectedIssueOmission() {
    if (!selectedIssue) return;
    setOmittedIssueIds((current) =>
      Array.from(new Set([...current, selectedIssue.id])),
    );
  }

  function addMaterialRequest() {
    const value = materialRequest.trim();
    if (!value) return;
    setSupplementalMaterialRequests((current) =>
      Array.from(new Set([...current, value])),
    );
    setMaterialRequest("");
  }

  function addReview() {
    if (!selectedIssue || !comment.trim()) return;
    const review: ReviewItem = {
      id: `review-${Date.now()}`,
      matterId: workspace.matter.id,
      targetType: "claim",
      targetId: selectedIssue.id,
      tag: selectedTag,
      comment: comment.trim(),
      reviewer: "Demo Reviewer",
      createdAt: new Date().toISOString(),
    };
    setReviews((current) => [review, ...current]);
    setAuditEvents((current) => [createReviewAuditEvent(review), ...current]);
  }

  function exportAuditPack() {
    const event = auditExportEvent(workspace, "audit_pack_exported", {
      reviewCount: reviews.length,
      auditEventCount: auditEvents.length + 1,
    });
    const nextAuditEvents = [event, ...auditEvents];
    setAuditEvents(nextAuditEvents);
    downloadJson(
      `${workspace.matter.id}-audit-pack`,
      buildAuditPack(workspace, reviews, nextAuditEvents, {
        reviewStudio,
      }),
    );
  }

  function exportFeedbackDataset() {
    const event = auditExportEvent(workspace, "feedback_dataset_exported", {
      reviewCount: reviews.length,
    });
    setAuditEvents((current) => [event, ...current]);
    downloadJson(
      `${workspace.matter.id}-feedback-eval`,
      buildFeedbackEvalDataset(workspace, reviews, {
        reviewStudio,
      }),
    );
  }

  return (
    <AletheiaShell>
      <section className="flex min-h-full flex-col bg-white text-gray-900">
        <header className="border-b border-gray-100 bg-white">
          <div className="flex flex-col items-start gap-4 px-8 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="font-serif text-2xl font-medium text-gray-900">
                {workspace.matter.title}
              </h1>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-gray-500">
                {workspace.matter.objective}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={exportAuditPack}
                className="rounded-md border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                <Download className="mr-2 h-4 w-4" />
                Export Audit Pack
              </Button>
              <Button
                asChild
                variant="outline"
                className="rounded-md border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                <Link href="/aletheia/agentops">
                  <Workflow className="mr-2 h-4 w-4" />
                  Command Center
                </Link>
              </Button>
              <span className="text-[11px] font-medium text-gray-500">
                Deterministic fallback
              </span>
              <span
                className={cn(
                  "text-[11px] font-medium",
                  riskClass(workspace.matter.riskLevel),
                )}
              >
                {workspace.matter.riskLevel} risk
              </span>
              <span
                className={cn(
                  "text-[11px] font-medium",
                  reviewStudio.gate.status === "ready"
                    ? "text-emerald-700"
                    : "text-red-700",
                )}
              >
                final export {reviewStudio.gate.status}
              </span>
            </div>
          </div>
        </header>

        <main className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-8 py-5 xl:grid-cols-[240px_minmax(0,1fr)_300px]">
          <aside className="space-y-4">
            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <p className="text-xs font-medium text-[#9ca3af]">
                Matter Profile
              </p>
              <h2 className="mt-2 text-xl font-semibold leading-tight">
                {workspace.matter.title}
              </h2>
              <p className="mt-2 text-sm text-[#6b7280]">
                {workspace.matter.objective}
              </p>
              <div className="mt-4 grid gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-[#9ca3af]">Status</span>
                  <span className="font-medium">
                    {titleize(workspace.matter.status)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#9ca3af]">Template</span>
                  <span className="font-medium">Legal Review</span>
                </div>
                <div className="grid gap-1">
                  <span className="text-[#9ca3af]">Workspace</span>
                  <span className="font-medium leading-5">
                    {workspace.matter.clientOrProject}
                  </span>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <div className="mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4 text-[#111827]" />
                <p className="text-sm font-semibold">Documents</p>
              </div>
              <div className="space-y-2">
                {workspace.documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="rounded-md border border-[#e5e7eb] p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium leading-tight">
                        {doc.name}
                      </p>
                      <Badge
                        variant="outline"
                        className="rounded-md border-gray-200 bg-white text-emerald-700"
                      >
                        parsed
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[#9ca3af]">
                      {doc.summary}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <div className="mb-3 flex items-center gap-2">
                <ClipboardCheck className="h-4 w-4 text-[#111827]" />
                <p className="text-sm font-semibold">Workflow Steps</p>
              </div>
              <div className="space-y-3">
                {workspace.plan.steps.map((step, index) => (
                  <div key={step.id} className="flex gap-3">
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#111827] text-xs text-white">
                      {index + 1}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{step.name}</p>
                        {step.status === "needs_review" && (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                        )}
                      </div>
                      <p className="text-xs leading-5 text-[#9ca3af]">
                        {step.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </aside>

          <section className="min-w-0 space-y-4">
            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-[#9ca3af]">
                    Current Agent Step
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">
                    Agent Plan before Answer
                  </h2>
                </div>
                <Badge
                  variant="outline"
                  className="rounded-md border-[#e5e7eb] bg-white text-[#374151]"
                >
                  workflow v0
                </Badge>
              </div>
              <div className="mt-4 grid gap-3 2xl:grid-cols-3">
                <div className="rounded-md border border-[#e5e7eb] p-3">
                  <p className="text-xs font-semibold text-[#9ca3af]">
                    Assumptions
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-[#374151]">
                    {workspace.plan.assumptions.map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-md border border-[#e5e7eb] p-3">
                  <p className="text-xs font-semibold text-[#9ca3af]">
                    Required Documents
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-[#374151]">
                    {workspace.plan.requiredDocuments
                      .slice(0, 5)
                      .map((item) => (
                        <li key={item}>- {item}</li>
                      ))}
                  </ul>
                </div>
                <div className="rounded-md border border-[#e5e7eb] border-l-amber-300 bg-white p-3">
                  <p className="text-xs font-medium text-amber-700">
                    Missing Materials
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-[#374151]">
                    {workspace.plan.missingMaterials.map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                <div className="mb-3 flex items-center gap-2">
                  <SearchCheck className="h-4 w-4 text-[#111827]" />
                  <h2 className="font-semibold">Issue Map</h2>
                </div>
                <div className="space-y-3">
                  {reviewStudio.issues.map((issue) => (
                    <button
                      key={issue.id}
                      onClick={() => setSelectedClaimId(issue.id)}
                      className={cn(
                        "w-full rounded-md border p-3 text-left transition-colors",
                        selectedClaimId === issue.id
                          ? "border-[#111827] bg-[#f9fafb]"
                          : "border-[#e5e7eb] bg-white hover:bg-[#f9fafb]",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold leading-5">
                          {issue.title}
                        </p>
                        <span
                          className={cn(
                            "text-xs font-medium",
                            riskClass(issue.riskLevel),
                          )}
                        >
                          {issue.riskLevel}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-[#6b7280]">
                        {
                          workspace.issues.find((item) => item.id === issue.id)
                            ?.summary
                        }
                      </p>
                      <p className="mt-2 text-xs text-[#9ca3af]">
                        State: {titleize(issue.reviewState)} · Evidence:{" "}
                        {issue.evidenceIds.length}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                <h2 className="font-semibold">Evidence Matrix</h2>
                <p className="mt-1 text-sm text-[#9ca3af]">
                  Claim-linked evidence with support status and source location.
                </p>
                <div className="mt-4 overflow-hidden rounded-md border border-[#e5e7eb]">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-[#f9fafb] text-xs text-[#9ca3af]">
                      <tr>
                        <th className="px-3 py-2">Source</th>
                        <th className="px-3 py-2">Quote</th>
                        <th className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#e5e7eb]">
                      {selectedEvidence.map((item) => (
                        <tr key={item.id}>
                          <td className="w-44 px-3 py-3 align-top">
                            <p className="font-medium">{item.documentName}</p>
                            <p className="text-xs text-[#9ca3af]">
                              p.{item.page} · {item.section}
                            </p>
                          </td>
                          <td className="px-3 py-3 align-top text-[#374151]">
                            {item.quote}
                          </td>
                          <td className="w-28 px-3 py-3 align-top">
                            <Badge
                              variant="outline"
                              className={cn(
                                "rounded-md",
                                supportClass(item.supportStatus),
                              )}
                            >
                              {item.supportStatus}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="grid gap-4 xl:grid-cols-3">
              <div className="rounded-lg border border-red-100 bg-white p-4">
                <div className="flex items-center gap-2">
                  <Flag className="h-4 w-4 text-red-700" />
                  <h2 className="font-semibold text-gray-950">
                    Red Flag Dashboard
                  </h2>
                </div>
                <div className="mt-3 space-y-3">
                  {reviewStudio.redFlags.map((flag) => (
                    <div
                      key={flag.id}
                      className="rounded-md border border-red-100 bg-white p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold leading-5 text-red-950">
                          {flag.title}
                        </p>
                        <Badge
                          variant="outline"
                          className={cn("rounded-md", riskClass(flag.severity))}
                        >
                          {flag.severity}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-red-800">
                        {flag.reason}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-[#6b7280]">
                        {flag.requestedAction}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-[#111827]" />
                  <h2 className="font-semibold">Risk Register</h2>
                </div>
                <div className="mt-3 space-y-3">
                  {reviewStudio.risks.map((risk) => (
                    <div
                      key={risk.id}
                      className="rounded-md border border-[#e5e7eb] p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium leading-5">
                          {risk.title}
                        </p>
                        <Badge
                          variant="outline"
                          className={cn("rounded-md", riskClass(risk.severity))}
                        >
                          {risk.severity}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-[#9ca3af]">
                        Likelihood: {risk.likelihood} · Status: {risk.status}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(["low", "medium", "high"] as RiskLevel[]).map(
                          (level) => (
                            <button
                              key={level}
                              type="button"
                              data-testid={`set-risk-${risk.issueId}-${level}`}
                              onClick={() => updateRisk(risk.issueId, level)}
                              className={cn(
                                "rounded-md border px-2 py-1 text-[11px] transition-colors",
                                risk.severity === level
                                  ? "border-[#111827] bg-[#111827] text-white"
                                  : "border-[#e5e7eb] text-[#6b7280] hover:bg-[#f9fafb]",
                              )}
                            >
                              {level}
                            </button>
                          ),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                <div className="flex items-center gap-2">
                  <ListChecks className="h-4 w-4 text-[#111827]" />
                  <h2 className="font-semibold">Obligations & Questions</h2>
                </div>
                <div className="mt-3 space-y-3">
                  {reviewStudio.obligations.slice(0, 5).map((item) => (
                    <div
                      key={item.id}
                      className="rounded-md border border-[#e5e7eb] p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium leading-5">
                          {item.obligation}
                        </p>
                        <Badge
                          variant="outline"
                          className={cn(
                            "rounded-md",
                            riskClass(item.riskLevel),
                          )}
                        >
                          {item.status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-[#9ca3af]">
                        {item.source} · {item.owner}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-semibold text-amber-700">
                    Open Questions
                  </p>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-900">
                    {reviewStudio.openQuestions.slice(0, 6).map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{workspace.memo.title}</h2>
                  <p className="mt-1 text-sm text-[#9ca3af]">
                    Structured memo sections with evidence, issue, and risk
                    traceability for expert review.
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="rounded-md border-amber-200 bg-amber-50 text-amber-700"
                >
                  needs review
                </Badge>
              </div>
              <div className="mt-4 grid gap-3">
                {workspace.memo.sections.map((section) => (
                  <article
                    key={section.id}
                    className="rounded-md border border-[#e5e7eb] p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold">{section.title}</h3>
                      <Badge
                        variant="outline"
                        className="rounded-md border-[#e5e7eb] text-[#374151]"
                      >
                        {titleize(section.reviewStatus ?? "unreviewed")}
                      </Badge>
                    </div>
                    <div className="mt-2 space-y-2 text-sm leading-6 text-[#374151]">
                      {section.body.map((paragraph) => (
                        <p key={paragraph}>{paragraph}</p>
                      ))}
                    </div>
                    {(() => {
                      const link = reviewStudio.memoLinks.find(
                        (item) => item.sectionId === section.id,
                      );
                      if (!link) return null;
                      return (
                        <div className="mt-3 flex flex-wrap gap-2 border-t border-[#e5e7eb] pt-3">
                          {link.unsupported && (
                            <Badge
                              variant="outline"
                              className="rounded-md border-amber-200 bg-amber-50 text-amber-700"
                            >
                              open item / needs source
                            </Badge>
                          )}
                          {link.evidenceIds.map((id) => (
                            <Badge
                              key={id}
                              variant="outline"
                              className="rounded-md border-emerald-100 bg-emerald-50 text-emerald-700"
                            >
                              evidence: {id}
                            </Badge>
                          ))}
                          {link.issueIds.map((id) => (
                            <Badge
                              key={id}
                              variant="outline"
                              className="rounded-md border-blue-100 bg-blue-50 text-blue-700"
                            >
                              issue: {id}
                            </Badge>
                          ))}
                          {link.riskIds.map((id) => (
                            <Badge
                              key={id}
                              variant="outline"
                              className="rounded-md border-red-100 bg-red-50 text-red-700"
                            >
                              risk: {id}
                            </Badge>
                          ))}
                          {link.unresolvedReviewIds.length > 0 && (
                            <Badge
                              variant="outline"
                              data-testid={`memo-unresolved-reviews-${section.id}`}
                              className="rounded-md border-amber-200 bg-amber-50 text-amber-700"
                            >
                              open review: {link.unresolvedReviewIds.length}
                            </Badge>
                          )}
                        </div>
                      );
                    })()}
                  </article>
                ))}
              </div>
            </section>
          </section>

          <aside className="space-y-4">
            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <h2 className="font-semibold">Evidence Panel</h2>
              {selectedIssue && (
                <div className="mt-3">
                  <p className="text-sm font-medium">{selectedIssue.title}</p>
                  <div className="mt-3 space-y-2">
                    {selectedEvidence.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-md border border-[#e5e7eb] p-3"
                      >
                        <div className="flex flex-wrap gap-2">
                          <Badge
                            variant="outline"
                            className={cn(
                              "rounded-md",
                              supportClass(item.supportStatus),
                            )}
                          >
                            {item.relevance} · {item.supportStatus}
                          </Badge>
                          <Badge
                            variant="outline"
                            data-testid={`evidence-review-status-${item.id}`}
                            className={cn(
                              "rounded-md",
                              decisionClass(
                                reviewStudioState.evidenceDecisions[item.id] ??
                                  "pending",
                              ),
                            )}
                          >
                            review:{" "}
                            {reviewStudioState.evidenceDecisions[item.id] ??
                              "pending"}
                          </Badge>
                        </div>
                        <p className="mt-2 text-sm leading-5 text-[#374151]">
                          {item.quote}
                        </p>
                        <textarea
                          data-testid={`fact-override-${item.id}`}
                          value={
                            reviewStudioState.factOverrides[item.id] ??
                            item.quote
                          }
                          onChange={(event) =>
                            updateFact(item.id, event.target.value)
                          }
                          className="mt-3 min-h-20 w-full rounded-md border border-[#e5e7eb] p-2 text-xs leading-5 text-[#374151]"
                          aria-label={`Fact correction for ${item.id}`}
                        />
                        <p className="mt-2 text-xs text-[#9ca3af]">
                          {item.documentName}, p.{item.page}
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            data-testid={`approve-evidence-${item.id}`}
                            onClick={() => decideEvidence(item.id, "approved")}
                            className="h-8 rounded-md border border-emerald-200 px-3 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            data-testid={`reject-evidence-${item.id}`}
                            onClick={() => decideEvidence(item.id, "rejected")}
                            className="h-8 rounded-md border border-red-200 px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <div className="flex items-center gap-2">
                <MessageSquarePlus className="h-4 w-4 text-[#111827]" />
                <h2 className="font-semibold">Human Review</h2>
              </div>
              <select
                value={selectedTag}
                onChange={(event) =>
                  setSelectedTag(event.target.value as ReviewTag)
                }
                className="mt-3 h-9 w-full rounded-md border border-[#e5e7eb] bg-white px-3 text-sm"
              >
                {reviewTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {titleize(tag)}
                  </option>
                ))}
              </select>
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                className="mt-3 min-h-24 w-full rounded-md border border-[#e5e7eb] p-3 text-sm leading-5"
              />
              <Button
                onClick={addReview}
                className="mt-3 w-full bg-[#111827] text-white hover:bg-[#1f2937]"
              >
                Add Review Tag
              </Button>
              <button
                type="button"
                data-testid="flag-selected-issue-omission"
                onClick={flagSelectedIssueOmission}
                className="mt-2 h-9 w-full rounded-md border border-amber-200 px-4 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50"
              >
                Mark Selected Issue Incomplete
              </button>
              <div className="mt-4 rounded-md border border-[#e5e7eb] p-3">
                <p className="text-xs font-semibold text-[#9ca3af]">
                  Supplemental Material Request
                </p>
                <input
                  data-testid="supplemental-material-input"
                  value={materialRequest}
                  onChange={(event) => setMaterialRequest(event.target.value)}
                  className="mt-2 h-9 w-full rounded-md border border-[#e5e7eb] px-3 text-sm"
                />
                <button
                  type="button"
                  data-testid="request-supplemental-material"
                  onClick={addMaterialRequest}
                  className="mt-2 h-9 w-full rounded-md border border-[#e5e7eb] px-4 text-sm font-medium text-[#374151] transition-colors hover:bg-[#f9fafb]"
                >
                  Request Material
                </button>
              </div>
              {reviewStudio.unresolvedComments.length > 0 && (
                <div
                  data-testid="review-studio-unresolved-comments"
                  className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-amber-800">
                      Open Review Blockers
                    </p>
                    <Badge
                      variant="outline"
                      className="rounded-md border-amber-200 bg-white text-amber-700"
                    >
                      {reviewStudio.unresolvedComments.length}
                    </Badge>
                  </div>
                  <div className="mt-3 space-y-2">
                    {reviewStudio.unresolvedComments
                      .slice(0, 5)
                      .map((review) => (
                        <div
                          key={review.id}
                          data-testid={`unresolved-review-${review.id}`}
                          className="rounded-md border border-amber-200 bg-white p-3"
                        >
                          <div className="flex flex-wrap gap-2">
                            <Badge
                              variant="outline"
                              className={cn(
                                "rounded-md",
                                riskClass(review.severity),
                              )}
                            >
                              {titleize(review.tag)}
                            </Badge>
                            <Badge
                              variant="outline"
                              className="rounded-md border-gray-200 text-gray-600"
                            >
                              {titleize(review.targetType)} · {review.targetId}
                            </Badge>
                          </div>
                          <p className="mt-2 text-sm leading-5 text-[#374151]">
                            {review.comment}
                          </p>
                          {review.sourceEvidenceIds.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {review.sourceEvidenceIds.map((id) => (
                                <Badge
                                  key={id}
                                  variant="outline"
                                  className="rounded-md border-emerald-100 bg-emerald-50 text-emerald-700"
                                >
                                  source: {id}
                                </Badge>
                              ))}
                            </div>
                          )}
                          <p className="mt-2 text-xs leading-5 text-amber-800">
                            {review.resolutionCue}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>
              )}
              <div className="mt-4 space-y-2">
                {reviewStudio.reviewLog.slice(0, 10).map((review) => (
                  <div
                    key={review.id}
                    data-testid={`review-log-${review.id}`}
                    className="rounded-md border border-[#e5e7eb] p-3"
                  >
                    <Badge
                      variant="outline"
                      className="rounded-md border-[#e5e7eb] text-[#374151]"
                    >
                      {titleize(review.action)}
                    </Badge>
                    <p className="mt-2 text-sm leading-5 text-[#374151]">
                      {review.summary}
                    </p>
                    <p className="mt-2 text-xs text-[#9ca3af]">
                      {review.targetId}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-[#111827]" />
                <h2 className="font-semibold">Final Export Gate</h2>
              </div>
              <p className="mt-2 text-sm leading-5 text-[#6b7280]">
                Vera can prepare a reviewable work product, but final export
                stays blocked until an expert approves the evidence, risk
                posture, and caveats.
              </p>
              <Badge
                variant="outline"
                data-testid="review-studio-final-export-gate"
                className={cn(
                  "mt-3 rounded-md",
                  reviewStudio.gate.status === "ready"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-red-200 bg-red-50 text-red-700",
                )}
              >
                {reviewStudio.gate.status}
              </Badge>
              <ul className="mt-3 space-y-1 text-xs leading-5 text-[#6b7280]">
                {reviewStudio.gate.reasons.slice(0, 5).map((reason) => (
                  <li key={reason}>- {reason}</li>
                ))}
              </ul>
              <button
                type="button"
                data-testid="approve-review-studio-final-export"
                onClick={() => setFinalExportApproved(true)}
                className="mt-3 h-9 w-full rounded-md bg-[#111827] px-4 text-sm font-medium text-white transition-colors hover:bg-[#1f2937]"
              >
                Approve Final Export
              </button>
            </section>

            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-[#111827]" />
                <h2 className="font-semibold">Audit Events</h2>
              </div>
              <div className="mt-4 space-y-3">
                {auditEvents.slice(0, 8).map((event) => (
                  <div key={event.id} className="relative pl-5">
                    <div className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full bg-[#111827]" />
                    <p className="text-sm font-medium">
                      {titleize(event.action)}
                    </p>
                    <p className="text-xs text-[#9ca3af]">
                      {event.actor} · {formatAuditTimestamp(event.timestamp)}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <h2 className="font-semibold">Feedback Summary</h2>
              </div>
              <p className="mt-2 text-sm text-[#6b7280]">
                {feedback.total} review events,{" "}
                {reviewStudio.evalRecords.length} eval-ready review records.
              </p>
              <Button
                variant="outline"
                onClick={exportFeedbackDataset}
                className="mt-3 w-full border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb]"
              >
                <Download className="mr-2 h-4 w-4" />
                Export Feedback JSON
              </Button>
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(feedback.counts).map(([tag, count]) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="rounded-md border-[#e5e7eb] text-[#374151]"
                  >
                    {titleize(tag)}: {count}
                  </Badge>
                ))}
              </div>
              <div className="mt-3 space-y-2">
                {reviewStudio.evalRecords.slice(0, 3).map((record, index) => (
                  <div
                    key={`${record.id}-${index}`}
                    data-testid={`eval-ready-record-${record.id}-${index}`}
                    className="rounded-md border border-[#e5e7eb] p-2"
                  >
                    <p className="text-xs font-medium text-[#374151]">
                      {record.failureType}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[#9ca3af]">
                      {record.expectedBehavior}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </main>
      </section>
    </AletheiaShell>
  );
}
