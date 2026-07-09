"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Database,
  FileSearch,
  History,
  ShieldAlert,
  Plus,
  Search,
  Upload,
  Workflow,
} from "lucide-react";
import { AletheiaShell } from "./AletheiaShell";
import { RemoteMatterRunTrace } from "./RemoteMatterRunTrace";
import { RemoteMatterSidebar } from "./RemoteMatterSidebar";
import {
  buildAuditPack,
  buildFeedbackDataset,
  buildFinalMemoGateInput,
  buildFinalMemo,
  buildGatePersistenceProvenance,
  draftMemoSections,
  evidenceMatrixRows,
  formatGateBlockMessage,
  highRiskCheckpoints,
  issueMapIssues,
  materialChecklist,
  openQuestions,
  runTraceCounts,
  summarizeGateResults,
  sourceMapDocuments,
  stringArray,
  titleize,
} from "./remoteMatterTransforms";
import {
  addAletheiaMatterMemory,
  addAletheiaReview,
  approveAletheiaPlaybook,
  createAletheiaEvidenceItem,
  createAletheiaAgentRun,
  createAletheiaPlaybook,
  createAletheiaWorkProduct,
  decideAletheiaApproval,
  generateAletheiaDraftMemo,
  generateAletheiaEvidenceMatrix,
  generateAletheiaIssueMap,
  getAletheiaMatter,
  proposeAletheiaPlaybookImprovement,
  requestAletheiaApproval,
  resumeAletheiaAgentRun,
  searchAletheiaMatterDocuments,
  uploadAletheiaMatterDocument,
  type AletheiaDocumentSearchResult,
  type AletheiaEvidenceRecord,
  type AletheiaHumanCheckpointRecord,
  type AletheiaMatterMemoryRecord,
  type AletheiaMatterDetail,
  type AletheiaReviewRecord,
  type AletheiaWorkProductKind,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GateChecklist } from "@/components/agentops/GateChecklist";
import { canExportFinal, runGates } from "@/aletheia/agentops/gates";

export function RemoteMatterPage({ matterId }: { matterId: string }) {
  const [detail, setDetail] = useState<AletheiaMatterDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingKind, setSavingKind] = useState<AletheiaWorkProductKind | null>(
    null,
  );
  const [creatingRun, setCreatingRun] = useState(false);
  const [generatingIssueMap, setGeneratingIssueMap] = useState(false);
  const [generatingEvidenceMatrix, setGeneratingEvidenceMatrix] =
    useState(false);
  const [generatingDraftMemo, setGeneratingDraftMemo] = useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(
    null,
  );
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [searchingDocuments, setSearchingDocuments] = useState(false);
  const [documentQuery, setDocumentQuery] = useState("");
  const [documentResults, setDocumentResults] = useState<
    AletheiaDocumentSearchResult[]
  >([]);
  const [evidenceClaimId, setEvidenceClaimId] = useState("");
  const [evidenceSupportStatus, setEvidenceSupportStatus] =
    useState<AletheiaEvidenceRecord["support_status"]>("supports");
  const [evidenceRelevance, setEvidenceRelevance] =
    useState<AletheiaEvidenceRecord["relevance"]>("direct");
  const [addingEvidenceChunkId, setAddingEvidenceChunkId] = useState<
    string | null
  >(null);
  const [memoryCategory, setMemoryCategory] =
    useState<AletheiaMatterMemoryRecord["category"]>("confirmed_fact");
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryBody, setMemoryBody] = useState("");
  const [playbookName, setPlaybookName] = useState(
    "Legal Matter Review Playbook",
  );
  const [playbookBody, setPlaybookBody] = useState("");
  const [savingWorkspaceKnowledge, setSavingWorkspaceKnowledge] =
    useState(false);
  const [approvingPlaybookId, setApprovingPlaybookId] = useState<string | null>(
    null,
  );
  const [reviewingIssueId, setReviewingIssueId] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState("");

  const mappedChunkIds = useMemo(
    () =>
      new Set(
        (detail?.evidence ?? [])
          .map((item) => item.source_chunk_id)
          .filter((id): id is string => Boolean(id)),
      ),
    [detail?.evidence],
  );
  const latestDraftMemo = useMemo(
    () =>
      detail
        ? ([...detail.workProducts]
            .reverse()
            .find((item) => item.kind === "draft_memo") ?? null)
        : null,
    [detail],
  );
  const latestIssueMap = useMemo(
    () =>
      detail
        ? ([...detail.workProducts]
            .reverse()
            .find((item) => item.kind === "issue_map") ?? null)
        : null,
    [detail],
  );
  const latestIssueMapIssues = useMemo(
    () => (latestIssueMap ? issueMapIssues(latestIssueMap.content) : []),
    [latestIssueMap],
  );
  const materialChecklistItems = useMemo(
    () => (detail ? materialChecklist(detail) : []),
    [detail],
  );
  const sourceMapItems = useMemo(
    () => (detail ? sourceMapDocuments(detail) : []),
    [detail],
  );
  const evidenceRows = useMemo(
    () => (detail ? evidenceMatrixRows(detail) : []),
    [detail],
  );
  const matterOpenQuestions = useMemo(
    () => (detail ? openQuestions(detail) : []),
    [detail],
  );
  const issueReviewsByClaim = useMemo(() => {
    const reviewsByClaim: Record<string, AletheiaReviewRecord[]> = {};
    for (const review of detail?.reviews ?? []) {
      if (review.target_type !== "claim") continue;
      reviewsByClaim[review.target_id] = [
        ...(reviewsByClaim[review.target_id] ?? []),
        review,
      ];
    }
    return reviewsByClaim;
  }, [detail?.reviews]);
  const latestDraftMemoSections = useMemo(
    () => (latestDraftMemo ? draftMemoSections(latestDraftMemo.content) : []),
    [latestDraftMemo],
  );
  const latestAgentRun = useMemo(
    () => detail?.agentRuns?.[0] ?? null,
    [detail?.agentRuns],
  );
  const latestApprovedPlaybook = useMemo(
    () => detail?.playbooks?.find((item) => item.status === "approved") ?? null,
    [detail?.playbooks],
  );
  const canProposePlaybookImprovement = useMemo(
    () =>
      Boolean(
        latestApprovedPlaybook &&
        ((detail?.reviews?.length ?? 0) > 0 ||
          (detail?.matterMemory ?? []).some(
            (item) => item.category === "reviewer_feedback",
          )),
      ),
    [detail?.matterMemory, detail?.reviews?.length, latestApprovedPlaybook],
  );
  const latestTraceCounts = useMemo(
    () => runTraceCounts(latestAgentRun),
    [latestAgentRun],
  );
  const auditPackApprovals = useMemo(
    () => highRiskCheckpoints(detail, "audit_pack_export"),
    [detail],
  );
  const approvedAuditPackApproval = useMemo(
    () =>
      auditPackApprovals.find(
        (checkpoint) => checkpoint.status === "approved",
      ) ?? null,
    [auditPackApprovals],
  );
  const openAuditPackApproval = useMemo(
    () =>
      auditPackApprovals.find((checkpoint) => checkpoint.status === "open") ??
      null,
    [auditPackApprovals],
  );
  const feedbackDatasetApprovals = useMemo(
    () => highRiskCheckpoints(detail, "feedback_dataset_export"),
    [detail],
  );
  const approvedFeedbackDatasetApproval = useMemo(
    () =>
      feedbackDatasetApprovals.find(
        (checkpoint) => checkpoint.status === "approved",
      ) ?? null,
    [feedbackDatasetApprovals],
  );
  const openFeedbackDatasetApproval = useMemo(
    () =>
      feedbackDatasetApprovals.find(
        (checkpoint) => checkpoint.status === "open",
      ) ?? null,
    [feedbackDatasetApprovals],
  );
  const finalMemoApprovals = useMemo(
    () => highRiskCheckpoints(detail, "final_memo_export"),
    [detail],
  );
  const approvedFinalMemoApproval = useMemo(
    () =>
      finalMemoApprovals.find(
        (checkpoint) => checkpoint.status === "approved",
      ) ?? null,
    [finalMemoApprovals],
  );
  const openFinalMemoApproval = useMemo(
    () =>
      finalMemoApprovals.find((checkpoint) => checkpoint.status === "open") ??
      null,
    [finalMemoApprovals],
  );
  const finalMemoGateResults = useMemo(
    () =>
      detail && latestDraftMemo
        ? runGates(
            buildFinalMemoGateInput({
              detail,
              draftMemo: latestDraftMemo,
              issueMap: latestIssueMap,
              exportIntent: "final",
              humanApproved: Boolean(approvedFinalMemoApproval),
            }),
          )
        : [],
    [approvedFinalMemoApproval, detail, latestDraftMemo, latestIssueMap],
  );
  const finalMemoGateProvenance = useMemo(
    () =>
      detail && latestDraftMemo
        ? buildGatePersistenceProvenance({
            detail,
            gateResults: finalMemoGateResults,
            draftMemoId: latestDraftMemo.id,
            approvalCheckpointId: approvedFinalMemoApproval?.id,
          })
        : [],
    [approvedFinalMemoApproval?.id, detail, finalMemoGateResults, latestDraftMemo],
  );

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

  async function saveWorkProduct(kind: "audit_pack" | "feedback_export") {
    if (!detail) return;
    setSavingKind(kind);
    setSaveMessage("");
    setError("");

    try {
      const approval =
        kind === "audit_pack"
          ? approvedAuditPackApproval
          : approvedFeedbackDatasetApproval;
      const openApproval =
        kind === "audit_pack"
          ? openAuditPackApproval
          : openFeedbackDatasetApproval;
      const approvalAction =
        kind === "audit_pack" ? "audit_pack_export" : "feedback_dataset_export";
      const approvalLabel =
        kind === "audit_pack" ? "Audit pack" : "Feedback dataset";

      if (!approval) {
        if (openApproval) {
          setSaveMessage(
            `${approvalLabel} export is waiting for human approval.`,
          );
          return;
        }
        await requestAletheiaApproval(matterId, {
          action: approvalAction,
          prompt:
            kind === "audit_pack"
              ? "Approve audit pack export only after verifying source evidence, draft memo caveats, and review notes."
              : "Approve feedback dataset export only after confirming review tags are safe to write into an evaluation set and privileged material should not be exported.",
          requestedPayload: {
            matterTitle: detail.matter.title,
            workProductKind: kind,
          },
        });
        const refreshed = await getAletheiaMatter(matterId);
        setDetail(refreshed);
        setSaveMessage(`${approvalLabel} export approval requested.`);
        return;
      }

      await createAletheiaWorkProduct(matterId, {
        kind,
        title:
          kind === "audit_pack"
            ? `${detail.matter.title} Audit Pack`
            : `${detail.matter.title} Feedback Eval Dataset`,
        schemaVersion:
          kind === "audit_pack"
            ? "aletheia-audit-pack-v0"
            : "aletheia-feedback-eval-v0",
        content:
          kind === "audit_pack"
            ? buildAuditPack(detail)
            : buildFeedbackDataset(detail),
        generatedBy: "human",
        approvalCheckpointId: approval.id,
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage(
        kind === "audit_pack"
          ? "Audit pack saved to work products."
          : "Feedback dataset saved to work products.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Work product save failed");
    } finally {
      setSavingKind(null);
    }
  }

  async function saveFinalMemo() {
    if (!detail) return;
    setSavingKind("final_memo");
    setSaveMessage("");
    setError("");

    try {
      if (!latestDraftMemo) {
        setSaveMessage(
          "Generate a draft memo before requesting final memo approval.",
        );
        return;
      }
      const blockingGateResults = finalMemoGateResults.filter(
        (gate) =>
          gate.status === "failed" &&
          (approvedFinalMemoApproval ||
            !["human_approval", "export"].includes(gate.gate_type)),
      );
      if (blockingGateResults.length > 0) {
        setSaveMessage(formatGateBlockMessage(blockingGateResults));
        return;
      }
      if (!approvedFinalMemoApproval) {
        if (openFinalMemoApproval) {
          setSaveMessage("Final memo export is waiting for human approval.");
          return;
        }
        await requestAletheiaApproval(matterId, {
          action: "final_memo_export",
          prompt:
            "Approve final memo export only after verifying evidence support, unresolved review flags, and professional caveats.",
          requestedPayload: {
            matterTitle: detail.matter.title,
            workProductKind: "final_memo",
            sourceDraftMemoId: latestDraftMemo.id,
            gateSummary: summarizeGateResults(finalMemoGateResults),
            gateResults: finalMemoGateResults,
            gateProvenance: finalMemoGateProvenance,
          },
        });
        const refreshed = await getAletheiaMatter(matterId);
        setDetail(refreshed);
        setSaveMessage("Final memo export approval requested.");
        return;
      }
      if (!canExportFinal(finalMemoGateResults)) {
        setSaveMessage(formatGateBlockMessage(finalMemoGateResults));
        return;
      }

      await createAletheiaWorkProduct(matterId, {
        kind: "final_memo",
        title: `${detail.matter.title} Final Memo`,
        status: "accepted",
        schemaVersion: "aletheia-final-memo-v0",
        content: buildFinalMemo({
          detail,
          draftMemoId: latestDraftMemo.id,
          draftContent: latestDraftMemo.content,
          approvalCheckpointId: approvedFinalMemoApproval.id,
          gateResults: finalMemoGateResults,
          gateProvenance: finalMemoGateProvenance,
        }),
        validationErrors: [],
        generatedBy: "human",
        approvalCheckpointId: approvedFinalMemoApproval.id,
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Final memo saved to work products.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Final memo save failed");
    } finally {
      setSavingKind(null);
    }
  }

  async function createRuntimeRun() {
    if (!detail) return;
    setCreatingRun(true);
    setSaveMessage("");
    setError("");

    try {
      await createAletheiaAgentRun(matterId, {
        workflow: detail.matter.template,
        goal: detail.matter.objective,
        status: "queued",
        budget: {
          maxSteps: 7,
          maxToolCalls: 12,
          maxWallTimeMs: 600000,
        },
        metadata: {
          source: "remote_matter_page",
          runtimeVersion: "aletheia-agent-runtime-v0",
        },
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Agent run queued.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Agent run creation failed",
      );
    } finally {
      setCreatingRun(false);
    }
  }

  async function generateEvidenceMatrix() {
    if (!detail) return;
    setGeneratingEvidenceMatrix(true);
    setSaveMessage("");
    setError("");

    try {
      await generateAletheiaEvidenceMatrix(matterId);
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Source-linked evidence matrix generated.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Evidence matrix generation failed",
      );
    } finally {
      setGeneratingEvidenceMatrix(false);
    }
  }

  async function generateIssueMap() {
    if (!detail) return;
    setGeneratingIssueMap(true);
    setSaveMessage("");
    setError("");

    try {
      await generateAletheiaIssueMap(matterId);
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Source-linked issue map generated.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Issue map generation failed",
      );
    } finally {
      setGeneratingIssueMap(false);
    }
  }

  async function generateDraftMemo() {
    if (!detail) return;
    setGeneratingDraftMemo(true);
    setSaveMessage("");
    setError("");

    try {
      await generateAletheiaDraftMemo(matterId);
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Deterministic draft memo generated for review.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Draft memo generation failed",
      );
    } finally {
      setGeneratingDraftMemo(false);
    }
  }

  async function decideApproval(
    checkpoint: AletheiaHumanCheckpointRecord,
    decision: "approved" | "rejected" | "edited" | "responded",
  ) {
    setDecidingApprovalId(checkpoint.id);
    setSaveMessage("");
    setError("");

    try {
      const decisionCopy = {
        approved: "Approved from Aletheia run trace.",
        rejected: "Rejected from Aletheia run trace.",
        edited: "Edited approval request from Aletheia run trace.",
        responded: "Human response added from Aletheia run trace.",
      } satisfies Record<
        "approved" | "rejected" | "edited" | "responded",
        string
      >;
      await decideAletheiaApproval(matterId, checkpoint.id, {
        decision,
        comment: decisionCopy[decision],
        editedPayload:
          decision === "edited"
            ? {
                requestedChanges:
                  "Revise the proposed action before execution.",
              }
            : undefined,
        response:
          decision === "responded"
            ? "Human reviewer supplied a response; agent must re-evaluate before proceeding."
            : undefined,
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage(`Approval checkpoint ${decision}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval decision failed");
    } finally {
      setDecidingApprovalId(null);
    }
  }

  async function resumeAgentRun(checkpoint: AletheiaHumanCheckpointRecord) {
    if (!latestAgentRun) return;
    setDecidingApprovalId(checkpoint.id);
    setSaveMessage("");
    setError("");

    try {
      await resumeAletheiaAgentRun(matterId, latestAgentRun.id, {
        checkpointId: checkpoint.id,
        note: "Resume requested from Aletheia run trace after human edit/response.",
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Agent run resumed and revised draft memo generated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent run resume failed");
    } finally {
      setDecidingApprovalId(null);
    }
  }

  async function addMatterMemory() {
    if (!memoryTitle.trim() || !memoryBody.trim()) return;
    setSavingWorkspaceKnowledge(true);
    setSaveMessage("");
    setError("");

    try {
      await addAletheiaMatterMemory(matterId, {
        category: memoryCategory,
        title: memoryTitle.trim(),
        body: memoryBody.trim(),
        source: "human",
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setMemoryTitle("");
      setMemoryBody("");
      setSaveMessage("Matter memory added.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Matter memory save failed",
      );
    } finally {
      setSavingWorkspaceKnowledge(false);
    }
  }

  async function createPlaybook() {
    if (!playbookName.trim() || !playbookBody.trim()) return;
    setSavingWorkspaceKnowledge(true);
    setSaveMessage("");
    setError("");

    try {
      await createAletheiaPlaybook(matterId, {
        name: playbookName.trim(),
        description: "Matter-scoped professional workflow manual.",
        version: "v0.1",
        content: {
          format: "markdown",
          body: playbookBody.trim(),
          controls: {
            matterScoped: true,
            requiresHumanApprovalForUpdates: true,
            agentMayAutoModify: false,
          },
        },
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setPlaybookBody("");
      setSaveMessage("Playbook drafted. Human approval is still required.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playbook save failed");
    } finally {
      setSavingWorkspaceKnowledge(false);
    }
  }

  async function approvePlaybook(playbookId: string) {
    setApprovingPlaybookId(playbookId);
    setSaveMessage("");
    setError("");

    try {
      await approveAletheiaPlaybook(matterId, playbookId);
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Playbook approved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playbook approval failed");
    } finally {
      setApprovingPlaybookId(null);
    }
  }

  async function proposePlaybookImprovement() {
    if (!latestApprovedPlaybook) return;
    setSavingWorkspaceKnowledge(true);
    setSaveMessage("");
    setError("");

    try {
      await proposeAletheiaPlaybookImprovement(matterId, {
        sourcePlaybookId: latestApprovedPlaybook.id,
        reviewerNote:
          "Review the matter's reviewer feedback and badcase tags before relying on this playbook update.",
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage(
        "Playbook improvement proposal drafted. Human approval is still required.",
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Playbook improvement proposal failed",
      );
    } finally {
      setSavingWorkspaceKnowledge(false);
    }
  }

  async function addIssueReview(
    issue: {
      claimId: string;
      title: string;
      representativeQuotes: { evidenceId: string }[];
    },
    tag: "accepted" | "needs_human_judgment",
  ) {
    if (!latestIssueMap) return;
    setReviewingIssueId(issue.claimId);
    setSaveMessage("");
    setError("");

    try {
      await addAletheiaReview(matterId, {
        targetType: "claim",
        targetId: issue.claimId,
        tag,
        comment:
          tag === "accepted"
            ? `Reviewer accepted issue map claim: ${issue.title}.`
            : `Reviewer marked issue map claim for further review: ${issue.title}.`,
        workProductId: latestIssueMap.id,
        evidenceItemId: issue.representativeQuotes[0]?.evidenceId ?? null,
        reviewerName: "Aletheia Reviewer",
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Issue review tag saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Issue review failed");
    } finally {
      setReviewingIssueId(null);
    }
  }

  async function uploadDocument(file: File | null) {
    if (!file) return;
    setUploadingDocument(true);
    setSaveMessage("");
    setError("");

    try {
      await uploadAletheiaMatterDocument(matterId, file);
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Document uploaded and indexed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Document upload failed");
    } finally {
      setUploadingDocument(false);
    }
  }

  async function searchDocuments() {
    if (!documentQuery.trim()) return;
    setSearchingDocuments(true);
    setError("");

    try {
      const results = await searchAletheiaMatterDocuments(
        matterId,
        documentQuery.trim(),
      );
      setDocumentResults(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Document search failed");
    } finally {
      setSearchingDocuments(false);
    }
  }

  async function addEvidenceFromResult(result: AletheiaDocumentSearchResult) {
    const claimId = evidenceClaimId.trim() || result.suggested_claim_id || null;
    setAddingEvidenceChunkId(result.chunk_id);
    setSaveMessage("");
    setError("");

    try {
      await createAletheiaEvidenceItem(matterId, {
        sourceChunkId: result.chunk_id,
        claimId,
        supportStatus: evidenceSupportStatus,
        relevance: evidenceRelevance,
        metadata: {
          searchQuery: documentQuery.trim(),
          chunkIndex: result.chunk_index,
          suggestedClaimId: result.suggested_claim_id ?? null,
          suggestedIssueTitle: result.suggested_issue_title ?? null,
        },
      });
      const refreshed = await getAletheiaMatter(matterId);
      setDetail(refreshed);
      setSaveMessage("Evidence item mapped from source document.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evidence mapping failed");
    } finally {
      setAddingEvidenceChunkId(null);
    }
  }

  return (
    <AletheiaShell>
      <section className="mx-auto max-w-7xl px-5 py-6">
        <Link
          href="/aletheia"
          className="inline-flex items-center gap-2 text-sm font-medium text-[#6b7280] hover:text-[#111827]"
        >
          <ArrowLeft className="h-4 w-4" />
          Matters
        </Link>

        {loading && (
          <div className="mt-5 rounded-lg border border-[#e5e7eb] bg-white p-6">
            <p className="text-sm text-[#6b7280]">Loading matter...</p>
          </div>
        )}

        {error && (
          <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
            <p className="font-semibold">Matter could not be loaded</p>
            <p className="mt-2 text-sm">{error}</p>
          </div>
        )}

        {detail && (
          <div
            data-testid="aletheia-matter-workspace"
            className="mt-5 grid gap-4 lg:grid-cols-[1fr_360px]"
          >
            <section className="space-y-4">
              <section className="rounded-lg border border-[#e5e7eb] bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h1 className="text-3xl font-semibold tracking-tight">
                      {detail.matter.title}
                    </h1>
                    <p className="mt-3 max-w-3xl text-sm leading-6 text-[#6b7280]">
                      {detail.matter.objective}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/aletheia/matters/${matterId}/agentops`}>
                        <Workflow className="h-4 w-4" />
                        Command Center
                      </Link>
                    </Button>
                    <Badge
                      variant="outline"
                      className="rounded-md border-[#e5e7eb] text-[#374151]"
                    >
                      {titleize(detail.matter.status)}
                    </Badge>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 md:grid-cols-4">
                  {[
                    {
                      icon: Database,
                      label: "Documents",
                      value: detail.documents.length,
                    },
                    {
                      icon: FileSearch,
                      label: "Evidence",
                      value: detail.evidence.length,
                    },
                    {
                      icon: History,
                      label: "Audit events",
                      value: detail.auditEvents.length,
                    },
                    {
                      icon: Bot,
                      label: "Agent runs",
                      value: detail.agentRuns?.length ?? 0,
                    },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-md border border-[#e5e7eb] p-4"
                    >
                      <item.icon className="h-5 w-5 text-[#111827]" />
                      <p className="mt-3 text-2xl font-semibold">
                        {item.value}
                      </p>
                      <p className="mt-1 text-sm text-[#6b7280]">
                        {item.label}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  <div className="rounded-md border border-[#e5e7eb] p-4">
                    <p className="text-xs font-semibold uppercase text-[#9ca3af]">
                      Matter Profile
                    </p>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex justify-between gap-3">
                        <dt className="text-[#6b7280]">Client / Project</dt>
                        <dd className="text-right text-[#374151]">
                          {detail.matter.client_or_project ?? "Unspecified"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-[#6b7280]">Template</dt>
                        <dd className="text-right text-[#374151]">
                          {titleize(detail.matter.template)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-[#6b7280]">Risk</dt>
                        <dd className="text-right text-[#374151]">
                          {detail.matter.risk_level ?? "unscoped"}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="rounded-md border border-[#e5e7eb] p-4">
                    <p className="text-xs font-semibold uppercase text-[#9ca3af]">
                      Initial Risk Scope
                    </p>
                    <ul className="mt-3 space-y-2 text-sm leading-5 text-[#374151]">
                      <li>
                        {detail.matter.template === "deal_due_diligence"
                          ? "MVP path: contract and diligence red flag memo."
                          : "MVP path: source-backed professional review memo."}
                      </li>
                      <li>
                        {detail.evidence.filter(
                          (item) => item.support_status !== "supports",
                        ).length}{" "}
                        mapped evidence items need contradiction or sufficiency
                        review.
                      </li>
                      <li>
                        {detail.reviews.length} human review tags are available
                        for gates and eval export.
                      </li>
                    </ul>
                  </div>

                  <div className="rounded-md border border-[#e5e7eb] p-4">
                    <p className="text-xs font-semibold uppercase text-[#9ca3af]">
                      Open Questions
                    </p>
                    {matterOpenQuestions.length === 0 ? (
                      <p className="mt-3 text-sm text-[#6b7280]">
                        No open questions recorded yet.
                      </p>
                    ) : (
                      <ul className="mt-3 space-y-2 text-sm leading-5 text-[#374151]">
                        {matterOpenQuestions.slice(0, 4).map((question) => (
                          <li key={question}>- {question}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>

              {latestDraftMemo && finalMemoGateResults.length > 0 && (
                <GateChecklist
                  gateResults={finalMemoGateResults}
                  gateProvenance={finalMemoGateProvenance}
                />
              )}

              {(() => {
                const plan = detail.workProducts.find(
                  (item) => item.kind === "agent_plan",
                );
                if (!plan) return null;
                const missingMaterials = stringArray(
                  plan.content.missingMaterials,
                );
                const steps = stringArray(plan.content.steps);
                return (
                  <section className="rounded-lg border border-[#e5e7eb] bg-white p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase text-[#9ca3af]">
                          Deterministic Scaffold
                        </p>
                        <h2 className="mt-1 text-lg font-semibold">
                          {plan.title}
                        </h2>
                      </div>
                      <Badge
                        variant="outline"
                        className="rounded-md border-[#e5e7eb] text-[#374151]"
                      >
                        {plan.schema_version}
                      </Badge>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-md border border-[#e5e7eb] p-3">
                        <p className="text-xs font-semibold text-[#9ca3af]">
                          Material Checklist
                        </p>
                        <ul className="mt-2 space-y-1 text-sm text-[#374151]">
                          {materialChecklistItems.map((item) => (
                            <li key={item.label}>
                              <span
                                className={
                                  item.status === "present"
                                    ? "text-emerald-700"
                                    : "text-amber-700"
                                }
                              >
                                {item.status === "present" ? "Present" : "Missing"}
                              </span>
                              {": "}
                              {item.label}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                        <p className="text-xs font-semibold text-amber-700">
                          Missing Materials
                        </p>
                        <ul className="mt-2 space-y-1 text-sm text-amber-900">
                          {missingMaterials.map((item) => (
                            <li key={item}>- {item}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="rounded-md border border-[#e5e7eb] p-3">
                        <p className="text-xs font-semibold text-[#9ca3af]">
                          Workflow Steps
                        </p>
                        <ul className="mt-2 space-y-1 text-sm text-[#374151]">
                          {steps.map((item) => (
                            <li key={item}>- {item}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </section>
                );
              })()}

              <RemoteMatterRunTrace
                detail={detail}
                latestAgentRun={latestAgentRun}
                latestTraceCounts={latestTraceCounts}
                decidingApprovalId={decidingApprovalId}
                onDecideApproval={(checkpoint, decision) =>
                  void decideApproval(checkpoint, decision)
                }
                onResumeAgentRun={(checkpoint) =>
                  void resumeAgentRun(checkpoint)
                }
              />

              <section className="rounded-lg border border-[#e5e7eb] bg-white p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase text-[#9ca3af]">
                      Local Documents
                    </p>
                    <h2 className="mt-1 text-lg font-semibold">
                      Document Index / Source Map
                    </h2>
                    <p className="mt-1 text-xs text-[#9ca3af]">
                      Document Registry
                    </p>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[#e5e7eb] px-3 py-2 text-sm font-medium text-[#374151] hover:bg-[#f9fafb]">
                    <Upload className="h-4 w-4" />
                    {uploadingDocument ? "Uploading..." : "Upload"}
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,.doc,.docx,.txt,.md"
                      disabled={uploadingDocument}
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        void uploadDocument(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>

                <div className="mt-4 grid gap-3">
                  {sourceMapItems.length === 0 ? (
                    <p className="rounded-md border border-dashed border-[#d1d5db] p-4 text-sm text-[#6b7280]">
                      No source documents uploaded yet.
                    </p>
                  ) : (
                    sourceMapItems.map((document) => (
                      <div
                        key={document.id}
                        className="rounded-md border border-[#e5e7eb] p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium">{document.name}</p>
                          <div className="flex flex-wrap gap-2">
                            <Badge
                              variant="outline"
                              className="rounded-md border-[#e5e7eb] text-[#374151]"
                            >
                              {document.parsedStatus}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={
                                document.searchable
                                  ? "rounded-md border-emerald-200 bg-emerald-50 text-emerald-800"
                                  : "rounded-md border-amber-200 bg-amber-50 text-amber-800"
                              }
                            >
                              {document.searchable ? "searchable" : "not indexed"}
                            </Badge>
                          </div>
                        </div>
                        <p className="mt-2 text-sm leading-5 text-[#6b7280]">
                          {document.summary}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-[#6b7280]">
                          <span>{titleize(document.documentType)}</span>
                          <span>
                            {document.chunkCount === null
                              ? "Chunk count unavailable"
                              : `${document.chunkCount} chunks`}
                          </span>
                          <span>{document.evidenceCount} evidence items</span>
                        </div>
                        {document.sensitiveMaterialFlags.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {document.sensitiveMaterialFlags.map((flag) => (
                              <Badge
                                key={flag}
                                variant="outline"
                                className="rounded-md border-red-200 bg-red-50 text-red-700"
                              >
                                <ShieldAlert className="h-3 w-3" />
                                {titleize(flag)}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-4 grid gap-2 md:grid-cols-[1fr_180px_150px_150px_44px]">
                  <input
                    data-testid="document-search-input"
                    value={documentQuery}
                    onChange={(event) => setDocumentQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void searchDocuments();
                    }}
                    placeholder="Search uploaded documents"
                    className="h-10 min-w-0 rounded-md border border-[#d1d5db] px-3 text-sm outline-none focus:border-[#111827]"
                  />
                  <input
                    value={evidenceClaimId}
                    onChange={(event) => setEvidenceClaimId(event.target.value)}
                    placeholder="Claim ID override"
                    className="h-10 min-w-0 rounded-md border border-[#d1d5db] px-3 text-sm outline-none focus:border-[#111827]"
                  />
                  <select
                    value={evidenceSupportStatus}
                    onChange={(event) =>
                      setEvidenceSupportStatus(
                        event.target
                          .value as AletheiaEvidenceRecord["support_status"],
                      )
                    }
                    className="h-10 rounded-md border border-[#d1d5db] bg-white px-3 text-sm outline-none focus:border-[#111827]"
                  >
                    <option value="supports">Supports</option>
                    <option value="contradicts">Contradicts</option>
                    <option value="insufficient">Insufficient</option>
                  </select>
                  <select
                    value={evidenceRelevance}
                    onChange={(event) =>
                      setEvidenceRelevance(
                        event.target
                          .value as AletheiaEvidenceRecord["relevance"],
                      )
                    }
                    className="h-10 rounded-md border border-[#d1d5db] bg-white px-3 text-sm outline-none focus:border-[#111827]"
                  >
                    <option value="direct">Direct</option>
                    <option value="indirect">Indirect</option>
                    <option value="weak">Weak</option>
                  </select>
                  <Button
                    data-testid="document-search-submit"
                    type="button"
                    variant="outline"
                    disabled={searchingDocuments || !documentQuery.trim()}
                    onClick={() => void searchDocuments()}
                    className="border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb]"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>

                {documentResults.length > 0 && (
                  <div
                    data-testid="document-search-results"
                    className="mt-4 space-y-3"
                  >
                    {documentResults.map((result) => (
                      <div
                        key={result.chunk_id}
                        className="rounded-md border border-[#e5e7eb] p-3"
                      >
                        <p className="text-xs font-medium text-[#6b7280]">
                          {result.document_name}
                          {result.page ? ` · p.${result.page}` : ""}
                        </p>
                        <p className="mt-2 text-sm leading-5 text-[#374151]">
                          {result.text}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-[#6b7280]">
                          {result.retrieval_rank && (
                            <Badge
                              variant="outline"
                              className="rounded-md border-[#d1d5db] bg-[#f9fafb] text-[#374151]"
                            >
                              Rank #{result.retrieval_rank}
                            </Badge>
                          )}
                          {result.retrieval_mode && (
                            <Badge
                              variant="outline"
                              className="rounded-md border-[#d1d5db] bg-white text-[#374151]"
                            >
                              {titleize(result.retrieval_mode)}
                            </Badge>
                          )}
                          {result.retrieval_layers?.map((layer) => (
                            <Badge
                              key={layer}
                              variant="outline"
                              className="rounded-md border-[#dbe7e2] bg-[#f7fbf9] text-[#315a51]"
                            >
                              {titleize(layer)}
                            </Badge>
                          ))}
                        </div>
                        {result.retrieval_explanation?.basis && (
                          <p className="mt-2 text-xs leading-5 text-[#6b7280]">
                            {result.retrieval_explanation.basis}
                          </p>
                        )}
                        {result.suggested_claim_id && (
                          <div className="mt-3 rounded-md border border-[#dbe7e2] bg-[#f7fbf9] px-3 py-2">
                            <p className="text-xs font-semibold uppercase text-[#6b8a7d]">
                              Suggested Issue
                            </p>
                            <p className="mt-1 text-sm text-[#315a51]">
                              {result.suggested_issue_title ??
                                result.suggested_claim_id}
                            </p>
                            <p className="mt-1 text-xs text-[#6b7280]">
                              {result.suggested_claim_id}
                            </p>
                          </div>
                        )}
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs text-[#9ca3af]">
                            chunk {result.chunk_index + 1}
                            {" · "}
                            chars {result.quote_start}-{result.quote_end}
                          </p>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              addingEvidenceChunkId === result.chunk_id ||
                              mappedChunkIds.has(result.chunk_id)
                            }
                            onClick={() => void addEvidenceFromResult(result)}
                            className="border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
                          >
                            <Plus className="h-4 w-4" />
                            {mappedChunkIds.has(result.chunk_id)
                              ? "Mapped"
                              : addingEvidenceChunkId === result.chunk_id
                                ? "Adding..."
                                : "Add evidence"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </section>

            <RemoteMatterSidebar
              detail={detail}
              savingKind={savingKind}
              creatingRun={creatingRun}
              generatingIssueMap={generatingIssueMap}
              generatingEvidenceMatrix={generatingEvidenceMatrix}
              generatingDraftMemo={generatingDraftMemo}
              savingWorkspaceKnowledge={savingWorkspaceKnowledge}
              saveMessage={saveMessage}
              memoryCategory={memoryCategory}
              memoryTitle={memoryTitle}
              memoryBody={memoryBody}
              playbookName={playbookName}
              playbookBody={playbookBody}
              approvingPlaybookId={approvingPlaybookId}
              canProposePlaybookImprovement={canProposePlaybookImprovement}
              latestIssueMap={latestIssueMap}
              latestIssueMapIssues={latestIssueMapIssues}
              evidenceRows={evidenceRows}
              issueReviewsByClaim={issueReviewsByClaim}
              reviewingIssueId={reviewingIssueId}
              latestDraftMemo={latestDraftMemo}
              latestDraftMemoSections={latestDraftMemoSections}
              approvedAuditPackApproval={approvedAuditPackApproval}
              openAuditPackApproval={openAuditPackApproval}
              approvedFeedbackDatasetApproval={approvedFeedbackDatasetApproval}
              openFeedbackDatasetApproval={openFeedbackDatasetApproval}
              approvedFinalMemoApproval={approvedFinalMemoApproval}
              openFinalMemoApproval={openFinalMemoApproval}
              onMemoryCategoryChange={setMemoryCategory}
              onMemoryTitleChange={setMemoryTitle}
              onMemoryBodyChange={setMemoryBody}
              onPlaybookNameChange={setPlaybookName}
              onPlaybookBodyChange={setPlaybookBody}
              onSaveWorkProduct={(kind) => void saveWorkProduct(kind)}
              onSaveFinalMemo={() => void saveFinalMemo()}
              onGenerateIssueMap={() => void generateIssueMap()}
              onGenerateEvidenceMatrix={() => void generateEvidenceMatrix()}
              onGenerateDraftMemo={() => void generateDraftMemo()}
              onCreateRuntimeRun={() => void createRuntimeRun()}
              onAddIssueReview={(issue, tag) => void addIssueReview(issue, tag)}
              onAddMatterMemory={() => void addMatterMemory()}
              onCreatePlaybook={() => void createPlaybook()}
              onProposePlaybookImprovement={() =>
                void proposePlaybookImprovement()
              }
              onApprovePlaybook={(playbookId) =>
                void approvePlaybook(playbookId)
              }
            />
          </div>
        )}
      </section>
    </AletheiaShell>
  );
}
