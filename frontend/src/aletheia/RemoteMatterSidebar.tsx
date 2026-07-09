"use client";

import { FileCheck2 } from "lucide-react";
import type {
  AletheiaHumanCheckpointRecord,
  AletheiaMatterDetail,
  AletheiaMatterMemoryRecord,
  AletheiaReviewRecord,
  AletheiaWorkProductKind,
  AletheiaWorkProductRecord,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type IssueMapIssue,
  titleize,
  traceStatusClass,
} from "./remoteMatterTransforms";

type DraftMemoSection = {
  id: string;
  title: string;
  body: string[];
  reviewStatus: string;
};

interface RemoteMatterSidebarProps {
  detail: AletheiaMatterDetail;
  savingKind: AletheiaWorkProductKind | null;
  creatingRun: boolean;
  generatingIssueMap: boolean;
  generatingEvidenceMatrix: boolean;
  generatingDraftMemo: boolean;
  savingWorkspaceKnowledge: boolean;
  saveMessage: string;
  memoryCategory: AletheiaMatterMemoryRecord["category"];
  memoryTitle: string;
  memoryBody: string;
  playbookName: string;
  playbookBody: string;
  approvingPlaybookId: string | null;
  canProposePlaybookImprovement: boolean;
  latestIssueMap: AletheiaWorkProductRecord | null;
  latestIssueMapIssues: IssueMapIssue[];
  issueReviewsByClaim: Record<string, AletheiaReviewRecord[]>;
  reviewingIssueId: string | null;
  latestDraftMemo: AletheiaWorkProductRecord | null;
  latestDraftMemoSections: DraftMemoSection[];
  approvedAuditPackApproval: AletheiaHumanCheckpointRecord | null;
  openAuditPackApproval: AletheiaHumanCheckpointRecord | null;
  approvedFeedbackDatasetApproval: AletheiaHumanCheckpointRecord | null;
  openFeedbackDatasetApproval: AletheiaHumanCheckpointRecord | null;
  approvedFinalMemoApproval: AletheiaHumanCheckpointRecord | null;
  openFinalMemoApproval: AletheiaHumanCheckpointRecord | null;
  onMemoryCategoryChange: (
    category: AletheiaMatterMemoryRecord["category"],
  ) => void;
  onMemoryTitleChange: (value: string) => void;
  onMemoryBodyChange: (value: string) => void;
  onPlaybookNameChange: (value: string) => void;
  onPlaybookBodyChange: (value: string) => void;
  onSaveWorkProduct: (kind: "audit_pack" | "feedback_export") => void;
  onSaveFinalMemo: () => void;
  onGenerateIssueMap: () => void;
  onGenerateEvidenceMatrix: () => void;
  onGenerateDraftMemo: () => void;
  onCreateRuntimeRun: () => void;
  onAddIssueReview: (
    issue: IssueMapIssue,
    tag: "accepted" | "needs_human_judgment",
  ) => void;
  onAddMatterMemory: () => void;
  onCreatePlaybook: () => void;
  onProposePlaybookImprovement: () => void;
  onApprovePlaybook: (playbookId: string) => void;
}

export function RemoteMatterSidebar({
  detail,
  savingKind,
  creatingRun,
  generatingIssueMap,
  generatingEvidenceMatrix,
  generatingDraftMemo,
  savingWorkspaceKnowledge,
  saveMessage,
  memoryCategory,
  memoryTitle,
  memoryBody,
  playbookName,
  playbookBody,
  approvingPlaybookId,
  canProposePlaybookImprovement,
  latestIssueMap,
  latestIssueMapIssues,
  issueReviewsByClaim,
  reviewingIssueId,
  latestDraftMemo,
  latestDraftMemoSections,
  approvedAuditPackApproval,
  openAuditPackApproval,
  approvedFeedbackDatasetApproval,
  openFeedbackDatasetApproval,
  approvedFinalMemoApproval,
  openFinalMemoApproval,
  onMemoryCategoryChange,
  onMemoryTitleChange,
  onMemoryBodyChange,
  onPlaybookNameChange,
  onPlaybookBodyChange,
  onSaveWorkProduct,
  onSaveFinalMemo,
  onGenerateIssueMap,
  onGenerateEvidenceMatrix,
  onGenerateDraftMemo,
  onCreateRuntimeRun,
  onAddIssueReview,
  onAddMatterMemory,
  onCreatePlaybook,
  onProposePlaybookImprovement,
  onApprovePlaybook,
}: RemoteMatterSidebarProps) {
  return (
    <aside className="space-y-4">
      <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
        <div className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-[#111827]" />
          <h2 className="font-semibold">Persistent Artifacts</h2>
        </div>
        <div className="mt-3 grid gap-2">
          <Button
            data-testid={
              approvedAuditPackApproval
                ? "save-audit-pack"
                : openAuditPackApproval
                  ? "audit-pack-pending-approval"
                  : "request-audit-pack-approval"
            }
            variant="outline"
            disabled={savingKind !== null}
            onClick={() => onSaveWorkProduct("audit_pack")}
            className="justify-start border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb]"
          >
            {approvedAuditPackApproval
              ? "Save Audit Pack"
              : openAuditPackApproval
                ? "Audit Pack Pending Approval"
                : "Request Audit Pack Approval"}
          </Button>
          <Button
            data-testid={
              approvedFeedbackDatasetApproval
                ? "save-feedback-dataset"
                : openFeedbackDatasetApproval
                  ? "feedback-dataset-pending-approval"
                  : "request-feedback-dataset-approval"
            }
            variant="outline"
            disabled={savingKind !== null}
            onClick={() => onSaveWorkProduct("feedback_export")}
            className="justify-start border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb]"
          >
            {approvedFeedbackDatasetApproval
              ? "Save Feedback Dataset"
              : openFeedbackDatasetApproval
                ? "Feedback Dataset Pending Approval"
                : "Request Feedback Dataset Approval"}
          </Button>
          <Button
            data-testid={
              approvedFinalMemoApproval
                ? "save-final-memo"
                : openFinalMemoApproval
                  ? "final-memo-pending-approval"
                  : "request-final-memo-approval"
            }
            variant="outline"
            disabled={savingKind !== null || !latestDraftMemo}
            onClick={onSaveFinalMemo}
            className="justify-start border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb]"
          >
            {approvedFinalMemoApproval
              ? "Save Final Memo"
              : openFinalMemoApproval
                ? "Final Memo Pending Approval"
                : "Request Final Memo Approval"}
          </Button>
          <Button
            variant="outline"
            disabled={generatingIssueMap || savingKind !== null}
            onClick={onGenerateIssueMap}
            className="justify-start border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
          >
            Generate Issue Map
          </Button>
          <Button
            variant="outline"
            disabled={generatingEvidenceMatrix || savingKind !== null}
            onClick={onGenerateEvidenceMatrix}
            className="justify-start border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
          >
            Generate Evidence Matrix
          </Button>
          <Button
            variant="outline"
            disabled={generatingDraftMemo || savingKind !== null}
            onClick={onGenerateDraftMemo}
            className="justify-start border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
          >
            Generate Draft Memo
          </Button>
          <Button
            variant="outline"
            disabled={creatingRun || savingKind !== null}
            onClick={onCreateRuntimeRun}
            className="justify-start border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
          >
            Queue Agent Run
          </Button>
        </div>
        {creatingRun && (
          <p className="mt-3 text-sm text-[#536962]">Creating agent run...</p>
        )}
        {generatingIssueMap && (
          <p className="mt-3 text-sm text-[#536962]">Generating issue map...</p>
        )}
        {generatingEvidenceMatrix && (
          <p className="mt-3 text-sm text-[#536962]">
            Generating evidence matrix...
          </p>
        )}
        {generatingDraftMemo && (
          <p className="mt-3 text-sm text-[#536962]">
            Generating draft memo...
          </p>
        )}
        {savingKind && (
          <p className="mt-3 text-sm text-[#6b7280]">
            Saving {titleize(savingKind)}...
          </p>
        )}
        {saveMessage && (
          <p className="mt-3 text-sm text-emerald-700">{saveMessage}</p>
        )}
      </section>

      <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
        <h2 className="font-semibold">Matter Memory</h2>
        <div className="mt-3 grid gap-2">
          <select
            value={memoryCategory}
            onChange={(event) =>
              onMemoryCategoryChange(
                event.target.value as AletheiaMatterMemoryRecord["category"],
              )
            }
            className="h-9 rounded-md border border-[#d1d5db] bg-white px-3 text-sm outline-none focus:border-[#111827]"
          >
            <option value="confirmed_fact">Confirmed fact</option>
            <option value="output_preference">Output preference</option>
            <option value="excluded_path">Excluded path</option>
            <option value="missing_material">Missing material</option>
            <option value="reviewer_feedback">Reviewer feedback</option>
          </select>
          <input
            value={memoryTitle}
            onChange={(event) => onMemoryTitleChange(event.target.value)}
            placeholder="Memory title"
            className="h-9 rounded-md border border-[#d1d5db] px-3 text-sm outline-none focus:border-[#111827]"
          />
          <textarea
            value={memoryBody}
            onChange={(event) => onMemoryBodyChange(event.target.value)}
            placeholder="Matter-scoped memory"
            className="min-h-20 rounded-md border border-[#d1d5db] px-3 py-2 text-sm outline-none focus:border-[#111827]"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              savingWorkspaceKnowledge ||
              !memoryTitle.trim() ||
              !memoryBody.trim()
            }
            onClick={onAddMatterMemory}
            className="justify-start border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
          >
            Add Matter Memory
          </Button>
        </div>
        <div className="mt-3 space-y-3">
          {(detail.matterMemory ?? []).length === 0 ? (
            <p className="text-sm text-[#6b7280]">
              No matter-scoped memory yet.
            </p>
          ) : (
            (detail.matterMemory ?? []).slice(0, 5).map((item) => (
              <div
                key={item.id}
                className="rounded-md border border-[#e5e7eb] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{item.title}</p>
                  <Badge
                    variant="outline"
                    className="rounded-md border-[#e5e7eb] text-[#374151]"
                  >
                    {titleize(item.category)}
                  </Badge>
                </div>
                <p className="mt-2 text-sm leading-5 text-[#6b7280]">
                  {item.body}
                </p>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
        <h2 className="font-semibold">Matter Playbooks</h2>
        <div className="mt-3 grid gap-2">
          <input
            value={playbookName}
            onChange={(event) => onPlaybookNameChange(event.target.value)}
            placeholder="Playbook name"
            className="h-9 rounded-md border border-[#d1d5db] px-3 text-sm outline-none focus:border-[#111827]"
          />
          <textarea
            value={playbookBody}
            onChange={(event) => onPlaybookBodyChange(event.target.value)}
            placeholder="Versioned workflow instructions"
            className="min-h-24 rounded-md border border-[#d1d5db] px-3 py-2 text-sm outline-none focus:border-[#111827]"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              savingWorkspaceKnowledge ||
              !playbookName.trim() ||
              !playbookBody.trim()
            }
            onClick={onCreatePlaybook}
            className="justify-start border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
          >
            Draft Playbook
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              savingWorkspaceKnowledge || !canProposePlaybookImprovement
            }
            onClick={onProposePlaybookImprovement}
            className="justify-start border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
          >
            Propose Playbook Update
          </Button>
        </div>
        <div className="mt-3 space-y-3">
          {(detail.playbooks ?? []).length === 0 ? (
            <p className="text-sm text-[#6b7280]">
              No playbooks drafted for this matter yet.
            </p>
          ) : (
            (detail.playbooks ?? []).slice(0, 5).map((item) => (
              <div
                key={item.id}
                className="rounded-md border border-[#e5e7eb] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{item.name}</p>
                  <Badge
                    variant="outline"
                    className={`rounded-md ${traceStatusClass(item.status)}`}
                  >
                    {titleize(item.status)}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-[#6b7280]">
                  {item.version}
                  {item.approved_at ? ` · approved ${item.approved_at}` : ""}
                </p>
                {item.status === "draft" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={approvingPlaybookId === item.id}
                    onClick={() => onApprovePlaybook(item.id)}
                    className="mt-3 border-emerald-200 text-emerald-800 hover:bg-emerald-50"
                  >
                    Approve Playbook
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
        <h2 className="font-semibold">Work Products</h2>
        <div className="mt-3 space-y-3">
          {detail.workProducts.length === 0 ? (
            <p className="text-sm text-[#6b7280]">
              No work products generated yet.
            </p>
          ) : (
            detail.workProducts.map((item) => (
              <div
                key={item.id}
                className="rounded-md border border-[#e5e7eb] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{titleize(item.kind)}</p>
                  <Badge
                    variant="outline"
                    className="rounded-md border-[#e5e7eb] text-[#374151]"
                  >
                    {titleize(item.status)}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-[#6b7280]">{item.title}</p>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
        <h2 className="font-semibold">Issue Map</h2>
        <div className="mt-3 space-y-3">
          {!latestIssueMap ? (
            <p className="text-sm text-[#6b7280]">
              No source-linked issue map generated yet.
            </p>
          ) : (
            <>
              <div className="rounded-md border border-[#e5e7eb] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{latestIssueMap.title}</p>
                  <Badge
                    variant="outline"
                    className="rounded-md border-[#e5e7eb] text-[#374151]"
                  >
                    {titleize(latestIssueMap.status)}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-[#6b7280]">
                  {latestIssueMap.schema_version}
                </p>
              </div>
              {latestIssueMapIssues.length === 0 ? (
                <p className="rounded-md border border-dashed border-[#d1d5db] p-3 text-sm text-[#6b7280]">
                  Issue map has no issue groups yet.
                </p>
              ) : (
                latestIssueMapIssues.slice(0, 5).map((issue) => {
                  const issueReviews = issueReviewsByClaim[issue.claimId] ?? [];
                  return (
                    <div
                      key={issue.id}
                      className="rounded-md border border-[#e5e7eb] p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{issue.title}</p>
                          <p className="mt-1 text-xs text-[#6b7280]">
                            {issue.claimId}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={`rounded-md ${traceStatusClass(issue.reviewStatus)}`}
                        >
                          {titleize(issue.reviewStatus)}
                        </Badge>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                        {[
                          ["Supports", issue.supportSummary.supports],
                          ["Contradicts", issue.supportSummary.contradicts],
                          ["Insufficient", issue.supportSummary.insufficient],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            className="rounded-md border border-[#e5e7eb] bg-[#f9fafb] p-2"
                          >
                            <p className="font-semibold text-[#374151]">
                              {value}
                            </p>
                            <p className="mt-1 text-[#6b7280]">{label}</p>
                          </div>
                        ))}
                      </div>
                      {issue.sourceDocuments.length > 0 && (
                        <p className="mt-3 text-xs text-[#6b7280]">
                          Sources: {issue.sourceDocuments.join(", ")}
                        </p>
                      )}
                      {issue.representativeQuotes[0]?.quote && (
                        <div className="mt-3 rounded-md border border-[#dbe7e2] bg-[#f7fbf9] p-3">
                          <p className="text-xs font-semibold uppercase text-[#6b8a7d]">
                            Representative Quote
                          </p>
                          <p className="mt-2 line-clamp-3 text-sm leading-5 text-[#374151]">
                            {issue.representativeQuotes[0].quote}
                          </p>
                        </div>
                      )}
                      {issue.openQuestions.length > 0 && (
                        <ul className="mt-3 space-y-1 text-xs leading-5 text-[#6b7280]">
                          {issue.openQuestions.slice(0, 2).map((question) => (
                            <li key={question}>- {question}</li>
                          ))}
                        </ul>
                      )}
                      {issueReviews.length > 0 && (
                        <div
                          data-testid={`issue-review-tags-${issue.claimId}`}
                          className="mt-3 rounded-md border border-[#e5e7eb] bg-[#f9fafb] p-3"
                        >
                          <p className="text-xs font-semibold uppercase text-[#6b7280]">
                            Review Tags
                          </p>
                          <div className="mt-2 space-y-2">
                            {issueReviews.slice(0, 3).map((review) => (
                              <div key={review.id}>
                                <Badge
                                  variant="outline"
                                  className="rounded-md border-[#d1d5db] bg-white text-[#374151]"
                                >
                                  {titleize(review.tag)}
                                </Badge>
                                <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#6b7280]">
                                  {review.comment}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid={`accept-issue-${issue.claimId}`}
                          disabled={reviewingIssueId === issue.claimId}
                          onClick={() => onAddIssueReview(issue, "accepted")}
                          className="border-emerald-200 text-emerald-800 hover:bg-emerald-50"
                        >
                          Accept Issue
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid={`revise-issue-${issue.claimId}`}
                          disabled={reviewingIssueId === issue.claimId}
                          onClick={() =>
                            onAddIssueReview(issue, "needs_human_judgment")
                          }
                          className="border-amber-200 text-amber-800 hover:bg-amber-50"
                        >
                          Needs Review
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
        <h2 className="font-semibold">Evidence Matrix</h2>
        <div className="mt-3 space-y-3">
          {detail.evidence.length === 0 ? (
            <p className="text-sm text-[#6b7280]">
              No source-linked evidence mapped yet.
            </p>
          ) : (
            detail.evidence.map((item) => (
              <div
                key={item.id}
                className="rounded-md border border-[#e5e7eb] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {item.claim_id ?? "Unassigned claim"}
                  </p>
                  <Badge
                    variant="outline"
                    className="rounded-md border-[#b7c9c2] text-[#315a51]"
                  >
                    {titleize(item.support_status)}
                  </Badge>
                </div>
                <p className="mt-2 text-xs font-medium text-[#6b7280]">
                  {item.document_name ?? "Source document"}
                  {item.page ? ` · p.${item.page}` : ""}
                </p>
                <p className="mt-2 line-clamp-4 text-sm leading-5 text-[#374151]">
                  {item.quote}
                </p>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
        <h2 className="font-semibold">Draft Memo</h2>
        <div className="mt-3 space-y-3">
          {!latestDraftMemo ? (
            <p className="text-sm text-[#6b7280]">
              No generated draft memo yet.
            </p>
          ) : (
            <>
              <div className="rounded-md border border-[#e5e7eb] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{latestDraftMemo.title}</p>
                  <Badge
                    variant="outline"
                    className="rounded-md border-[#e5e7eb] text-[#374151]"
                  >
                    {titleize(latestDraftMemo.status)}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-[#6b7280]">
                  {latestDraftMemo.schema_version}
                </p>
              </div>
              {latestDraftMemoSections.slice(0, 5).map((section) => (
                <div
                  key={section.id}
                  className="rounded-md border border-[#e5e7eb] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{section.title}</p>
                    <Badge
                      variant="outline"
                      className="rounded-md border-[#b7c9c2] text-[#315a51]"
                    >
                      {titleize(section.reviewStatus)}
                    </Badge>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm leading-5 text-[#374151]">
                    {section.body.slice(0, 2).map((line) => (
                      <li key={line}>- {line}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
    </aside>
  );
}
