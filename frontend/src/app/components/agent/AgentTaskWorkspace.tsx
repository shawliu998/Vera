"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Download,
  FileText,
  Loader2,
  MapPin,
  Pause,
  Play,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { ModelToggle, MODELS } from "@/app/components/assistant/ModelToggle";
import { ApiKeyMissingPopup } from "@/app/components/popups/ApiKeyMissingPopup";
import { getProject } from "@/app/lib/mikeApi";
import {
  attachAgentTaskDocuments,
  createAgentReviewDecision,
  downloadApprovedAgentArtifact,
  getAgentTask,
  getAgentTaskEvidence,
  pauseAgentTask,
  resumeAgentTask,
  retryAgentTask,
  reviseAgentTask,
  updateAgentTaskModel,
} from "@/app/lib/agentClient";
import { cn } from "@/app/lib/utils";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
  isModelAvailable,
  getModelProvider,
} from "@/app/lib/modelAvailability";
import type { ModelProvider } from "@/app/lib/modelAvailability";
import type {
  AgentEvidenceCitation,
  AgentEvidenceSnapshot,
  AgentReviewStatus,
  AgentStepStatus,
  AgentTaskSnapshot,
  AgentTaskStatus,
  ApprovedArtifactSnapshot,
} from "@/app/types/agent";
import type { Project } from "@/app/components/shared/types";

const STATUS_LABELS: Record<AgentTaskStatus, string> = {
  queued: "Ready",
  running: "Running",
  waiting_input: "Waiting for input",
  verifying: "Verifying",
  paused: "Paused",
  completed: "Ready for lawyer review",
  failed: "Failed",
};

const STATUS_STYLES: Record<AgentTaskStatus, string> = {
  queued: "border-gray-200 bg-white/70 text-gray-600",
  running: "border-blue-200 bg-blue-50/80 text-blue-700",
  waiting_input: "border-amber-200 bg-amber-50/80 text-amber-800",
  verifying: "border-violet-200 bg-violet-50/80 text-violet-700",
  paused: "border-gray-200 bg-gray-100/80 text-gray-700",
  completed: "border-emerald-200 bg-emerald-50/80 text-emerald-700",
  failed: "border-red-200 bg-red-50/80 text-red-700",
};

const REVIEW_LABELS: Record<AgentReviewStatus, string> = {
  review_required: "Review required",
  changes_requested: "Changes requested",
  approved: "Approved · version locked",
};

const REVIEW_STYLES: Record<AgentReviewStatus, string> = {
  review_required: "border-amber-200 bg-amber-50/80 text-amber-800",
  changes_requested: "border-red-200 bg-red-50/80 text-red-700",
  approved: "border-emerald-200 bg-emerald-50/80 text-emerald-700",
};

const STEP_ICONS: Record<AgentStepStatus, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  completed: Check,
  blocked: AlertCircle,
  skipped: Circle,
};

const EVIDENCE_STATUS_META = {
  exact: { label: "Located", className: "text-emerald-700" },
  version_mismatch: {
    label: "Cited version",
    className: "text-amber-800",
  },
  drifted: { label: "Anchor drifted", className: "text-red-700" },
  missing: { label: "Citation missing", className: "text-red-700" },
} as const;

export function AgentTaskWorkspace({ taskId }: { taskId: string }) {
  const router = useRouter();
  const { profile } = useUserProfile();
  const [snapshot, setSnapshot] = useState<AgentTaskSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [matter, setMatter] = useState<Project | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [missingKeyProvider, setMissingKeyProvider] =
    useState<ModelProvider | null>(null);
  const [modelUpdating, setModelUpdating] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewSubmitting, setReviewSubmitting] = useState<
    "approved" | "changes_requested" | null
  >(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [revisionStarting, setRevisionStarting] = useState(false);
  const [downloadingArtifact, setDownloadingArtifact] = useState<string | null>(
    null,
  );
  const [evidenceByArtifact, setEvidenceByArtifact] = useState<
    Record<string, AgentEvidenceSnapshot>
  >({});
  const [evidenceLoading, setEvidenceLoading] = useState<string | null>(null);
  const [expandedEvidenceId, setExpandedEvidenceId] = useState<string | null>(
    null,
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getAgentTask(taskId)
      .then(async (value) => {
        setSnapshot(value);
        setMatter(await getProject(value.task.matter_id));
      })
      .catch(() => setSnapshot(null))
      .finally(() => setLoaded(true));
  }, [taskId]);

  useEffect(() => {
    if (!loaded || !scrollContainerRef.current) return;
    const restore = new URLSearchParams(window.location.search).has("restore");
    if (!restore) return;
    const saved = window.sessionStorage.getItem(
      `vera:agent-task-scroll:${taskId}`,
    );
    const scrollTop = Number(saved);
    if (!Number.isFinite(scrollTop)) return;
    window.requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: scrollTop });
    });
  }, [loaded, taskId]);

  const taskStatus = snapshot?.task.status;

  useEffect(() => {
    if (
      !taskStatus ||
      !["queued", "running", "verifying"].includes(taskStatus)
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getAgentTask(taskId)
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch(() => undefined);
    }, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [taskId, taskStatus]);

  const completedSteps = useMemo(
    () =>
      snapshot?.task.current_plan.filter((step) => step.status === "completed")
        .length ?? 0,
    [snapshot],
  );

  async function resumeTask() {
    setExecutionError(null);
    setSnapshot(await resumeAgentTask(taskId));
  }

  async function pauseTask() {
    setSnapshot(await pauseAgentTask(taskId));
  }

  async function retryTask() {
    setExecutionError(null);
    setSnapshot(await retryAgentTask(taskId));
  }

  async function startRevision() {
    if (revisionStarting) return;
    setRevisionStarting(true);
    setReviewError(null);
    try {
      setSnapshot(await reviseAgentTask(taskId));
    } catch (error) {
      setReviewError(
        error instanceof Error
          ? error.message
          : "The requested revision could not be started.",
      );
    } finally {
      setRevisionStarting(false);
    }
  }

  async function attachNewMatterDocuments() {
    if (!snapshot || !matter) return;
    const linked = new Set(
      snapshot.artifacts
        .filter((artifact) => artifact.purpose === "Source document")
        .map((artifact) => artifact.artifact_id),
    );
    const newDocumentIds = (matter.documents ?? [])
      .map((document) => document.id)
      .filter((documentId) => !linked.has(documentId));
    if (!newDocumentIds.length) {
      setExecutionError(
        "No new Matter documents are available. Upload documents to the Matter first.",
      );
      return;
    }
    setExecutionError(null);
    setSnapshot(await attachAgentTaskDocuments(taskId, newDocumentIds));
  }

  async function handleModelChange(modelId: string) {
    if (!snapshot || modelUpdating) return;
    if (modelId === snapshot.task.execution_model) return;
    const provider = getModelProvider(modelId);
    if (provider && !isModelAvailable(modelId, profile?.apiKeys ?? {})) {
      setMissingKeyProvider(provider);
      return;
    }
    setModelUpdating(true);
    setExecutionError(null);
    try {
      const updated = await updateAgentTaskModel(taskId, modelId);
      setSnapshot(updated);
    } catch (error) {
      setExecutionError(
        error instanceof Error ? error.message : "Failed to switch task model",
      );
    } finally {
      setModelUpdating(false);
    }
  }

  async function submitReviewDecision(
    status: "approved" | "changes_requested",
  ): Promise<boolean> {
    if (reviewSubmitting) return false;
    if (status === "changes_requested" && !reviewNote.trim()) {
      setReviewError(
        "Describe the required changes so the decision is auditable.",
      );
      return false;
    }
    setReviewSubmitting(status);
    setReviewError(null);
    try {
      const updated = await createAgentReviewDecision(taskId, {
        status,
        note: reviewNote.trim(),
      });
      setSnapshot(updated);
      setReviewNote("");
      return true;
    } catch (error) {
      setReviewError(
        error instanceof Error
          ? error.message
          : "The review decision could not be recorded.",
      );
      return false;
    } finally {
      setReviewSubmitting(null);
    }
  }

  async function downloadApprovedArtifact(artifact: ApprovedArtifactSnapshot) {
    if (downloadingArtifact) return;
    setDownloadingArtifact(artifact.artifact_id);
    setReviewError(null);
    try {
      const blob = await downloadApprovedAgentArtifact(
        taskId,
        artifact.artifact_id,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setReviewError(
        error instanceof Error ? error.message : "Final export failed.",
      );
    } finally {
      setDownloadingArtifact(null);
    }
  }

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading work task…
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <h1 className="font-serif text-2xl text-gray-900">Task not found</h1>
        <p className="mt-2 text-sm text-gray-500">
          This task record is no longer available.
        </p>
        <button
          type="button"
          onClick={() => router.push("/assistant")}
          className="mt-5 rounded-full bg-gray-950 px-4 py-2 text-sm font-medium text-white"
        >
          Return to Assistant
        </button>
      </div>
    );
  }

  const { task, artifacts } = snapshot;
  const providerQueued = Boolean(
    ["running", "verifying"].includes(task.status) &&
    task.latest_checkpoint?.runner_retry,
  );
  const matterName = matter?.name ?? "Matter";
  const sourceDocuments = (matter?.documents ?? []).filter((document) =>
    artifacts.some(
      (artifact) =>
        artifact.purpose === "Source document" &&
        artifact.artifact_id === document.id,
    ),
  );
  const executionModel = task.execution_model || "gemini-3-flash-preview";
  const executionModelLabel =
    MODELS.find((model) => model.id === executionModel)?.label ??
    executionModel;
  const reviewStatus = snapshot.review.status;

  function rememberTaskContext() {
    window.sessionStorage.setItem(
      `vera:agent-task-scroll:${taskId}`,
      String(scrollContainerRef.current?.scrollTop ?? 0),
    );
  }

  function openCitation(citation: AgentEvidenceCitation) {
    if (!citation.openable || !citation.document_id) return;
    rememberTaskContext();
    const query = new URLSearchParams({
      open_document: citation.document_id,
      return_task: taskId,
      citation_status: citation.status,
      citation_detail: citation.detail,
    });
    if (citation.version_id) query.set("version_id", citation.version_id);
    if (citation.page != null) query.set("page", String(citation.page));
    if (citation.quote) query.set("quote", citation.quote.slice(0, 1200));
    if (citation.sheet) query.set("sheet", citation.sheet);
    if (citation.cell) query.set("cell", citation.cell);
    router.push(`/projects/${task.matter_id}?${query.toString()}`);
  }

  async function showEvidenceArtifact(
    artifactId: string,
    options: { focus?: boolean } = {},
  ) {
    if (expandedEvidenceId === artifactId && !options.focus) {
      setExpandedEvidenceId(null);
      return;
    }
    setExpandedEvidenceId(artifactId);
    if (!evidenceByArtifact[artifactId]) {
      setEvidenceLoading(artifactId);
      try {
        const evidence = await getAgentTaskEvidence(taskId, artifactId);
        setEvidenceByArtifact((current) => ({
          ...current,
          [artifactId]: evidence,
        }));
      } catch (error) {
        setExecutionError(
          error instanceof Error
            ? error.message
            : "Evidence could not be loaded",
        );
      } finally {
        setEvidenceLoading(null);
      }
    }
    if (options.focus) {
      window.requestAnimationFrame(() => {
        const target = document.getElementById(`evidence-${artifactId}`);
        target?.scrollIntoView({
          block: "nearest",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
        });
      });
    }
  }

  function openArtifact(
    artifact: AgentTaskSnapshot["artifacts"][number],
    options: { versionId?: string | null } = {},
  ) {
    rememberTaskContext();
    if (artifact.artifact_type === "chat") {
      const query = new URLSearchParams({ return_task: taskId });
      router.push(
        `/projects/${task.matter_id}/assistant/chat/${artifact.artifact_id}?${query}`,
      );
      return;
    }
    if (artifact.artifact_type === "citation_snapshot") {
      void showEvidenceArtifact(artifact.artifact_id, { focus: true });
      return;
    }
    if (
      artifact.artifact_type === "document" ||
      artifact.artifact_type === "draft" ||
      artifact.artifact_type === "tabular_review"
    ) {
      const lockedVersionId = snapshot?.review.decisions
        .at(-1)
        ?.artifact_snapshot.find(
          (locked) => locked.artifact_id === artifact.artifact_id,
        )?.version_id;
      const query = new URLSearchParams({
        open_document: artifact.artifact_id,
        return_task: taskId,
      });
      const versionId = options.versionId ?? lockedVersionId;
      if (versionId) query.set("version_id", versionId);
      router.push(`/projects/${task.matter_id}?${query.toString()}`);
      return;
    }
    router.push(`/projects/${task.matter_id}`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader
        shrink
        breadcrumbs={[
          {
            label: "Work Tasks",
            onClick: () => router.push("/work-tasks"),
          },
          { label: matterName, cursor: "text", title: matterName },
        ]}
        actions={[
          {
            type: "custom",
            render: (
              <span
                className={cn(
                  "inline-flex h-7 max-w-[250px] items-center gap-1.5 truncate rounded-full border px-2.5 text-xs font-medium",
                  task.status === "completed" && reviewStatus
                    ? REVIEW_STYLES[reviewStatus]
                    : STATUS_STYLES[task.status],
                )}
              >
                {task.status === "running" || task.status === "verifying" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : task.status === "completed" ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <Clock3 className="h-3 w-3" />
                )}
                {task.status === "completed" && reviewStatus
                  ? REVIEW_LABELS[reviewStatus]
                  : STATUS_LABELS[task.status]}
              </span>
            ),
          },
          task.status === "running" || task.status === "verifying"
            ? {
                icon: <Pause className="h-3.5 w-3.5" />,
                label: "Pause",
                onClick: pauseTask,
              }
            : task.status === "paused"
              ? {
                  icon: <Play className="h-3.5 w-3.5" />,
                  label: "Resume",
                  onClick: resumeTask,
                }
              : null,
        ]}
      />

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-6"
      >
        <main className="mx-auto w-full max-w-[960px]">
          <header className="border-b border-gray-900/[0.07] py-4 md:py-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <p className="truncate text-xs text-gray-500" title={matterName}>
                  {matterName}
                </p>
                <h1
                  title={task.goal}
                  className="mt-1.5 line-clamp-3 max-w-[72ch] break-words text-pretty text-lg font-semibold leading-6 text-gray-950 [overflow-wrap:anywhere]"
                >
                  {task.goal}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-500">
                  {sourceDocuments.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        const source = artifacts.find(
                          (artifact) =>
                            artifact.purpose === "Source document" &&
                            artifact.artifact_id === sourceDocuments[0].id,
                        );
                        if (source) openArtifact(source);
                      }}
                      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500/70"
                    >
                      <FileTypeIcon
                        fileType={sourceDocuments[0].file_type}
                        className="h-3.5 w-3.5"
                      />
                      <span className="max-w-[360px] truncate">
                        {sourceDocuments[0].filename}
                      </span>
                      {sourceDocuments.length > 1 && (
                        <span>+{sourceDocuments.length - 1}</span>
                      )}
                    </button>
                  ) : (
                    <span>No source documents attached</span>
                  )}
                  <span>
                    {completedSteps} of {task.current_plan.length} steps
                    complete
                  </span>
                  {["queued", "paused", "waiting_input", "failed"].includes(
                    task.status,
                  ) ? (
                    <span className="inline-flex items-center gap-1.5">
                      {modelUpdating && (
                        <Loader2
                          className="h-3 w-3 animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      <ModelToggle
                        value={executionModel}
                        onChange={handleModelChange}
                        apiKeys={profile?.apiKeys ?? {}}
                        disabled={modelUpdating}
                      />
                    </span>
                  ) : (
                    <span title={`Execution model: ${executionModel}`}>
                      {executionModelLabel}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </header>

          {task.status === "completed" && (
            <DeliverablesPanel
              snapshot={snapshot}
              reviewerName={profile?.displayName ?? null}
              note={reviewNote}
              onNoteChange={setReviewNote}
              submitting={reviewSubmitting}
              revisionStarting={revisionStarting}
              error={reviewError}
              downloadingArtifact={downloadingArtifact}
              onDecision={submitReviewDecision}
              onRevise={startRevision}
              onDownload={downloadApprovedArtifact}
              onOpenArtifact={openArtifact}
            />
          )}

          <WorkRecord
            snapshot={snapshot}
            executionError={executionError}
            providerQueued={providerQueued}
            onRetry={retryTask}
            onAttachDocuments={attachNewMatterDocuments}
            onOpenArtifact={openArtifact}
            evidenceByArtifact={evidenceByArtifact}
            evidenceLoading={evidenceLoading}
            expandedEvidenceId={expandedEvidenceId}
            onToggleEvidence={(artifactId) =>
              void showEvidenceArtifact(artifactId)
            }
            onOpenCitation={openCitation}
          />
        </main>
      </div>
      <ApiKeyMissingPopup
        open={missingKeyProvider !== null}
        onClose={() => setMissingKeyProvider(null)}
        provider={missingKeyProvider}
      />
    </div>
  );
}

function DeliverablesPanel({
  snapshot,
  reviewerName,
  note,
  onNoteChange,
  submitting,
  revisionStarting,
  error,
  downloadingArtifact,
  onDecision,
  onRevise,
  onDownload,
  onOpenArtifact,
}: {
  snapshot: AgentTaskSnapshot;
  reviewerName: string | null;
  note: string;
  onNoteChange: (value: string) => void;
  submitting: "approved" | "changes_requested" | null;
  revisionStarting: boolean;
  error: string | null;
  downloadingArtifact: string | null;
  onDecision: (status: "approved" | "changes_requested") => Promise<boolean>;
  onRevise: () => Promise<void>;
  onDownload: (artifact: ApprovedArtifactSnapshot) => Promise<void>;
  onOpenArtifact: (
    artifact: AgentTaskSnapshot["artifacts"][number],
    options?: { versionId?: string | null },
  ) => void;
}) {
  const reviewStatus = snapshot.review.status ?? "review_required";
  const [reviewAction, setReviewAction] = useState<
    "approved" | "changes_requested" | null
  >(null);
  const latestDecision = snapshot.review.decisions.at(-1) ?? null;
  const approvedArtifacts =
    reviewStatus === "approved" && latestDecision
      ? latestDecision.artifact_snapshot
      : [];
  const outputRows = approvedArtifacts.length
    ? approvedArtifacts.map((artifact) => ({
        key: `${artifact.artifact_id}:${artifact.version_id}`,
        label: artifact.purpose,
        detail: artifact.filename,
        version: artifact.version_number,
        artifact,
        linkedArtifact:
          snapshot.artifacts.find(
            (linked) => linked.artifact_id === artifact.artifact_id,
          ) ?? null,
      }))
    : snapshot.task.deliverables
        .filter((deliverable) => deliverable.required)
        .map((deliverable) => ({
          key: deliverable.key,
          label: deliverable.title,
          detail:
            deliverable.artifact_type === "tabular_review"
              ? "Excel workbook"
              : "Word document",
          version: null,
          artifact: null,
          linkedArtifact:
            snapshot.artifacts.find(
              (linked) => linked.artifact_id === deliverable.artifact_id,
            ) ??
            [...snapshot.artifacts]
              .reverse()
              .find(
                (linked) =>
                  linked.purpose ===
                    (deliverable.purpose ??
                      (deliverable.key === "risk-matrix"
                        ? "Risk matrix"
                        : deliverable.key === "review-memo"
                          ? "Review memo draft"
                          : deliverable.title)) &&
                  (!deliverable.artifact_type ||
                    linked.artifact_type === deliverable.artifact_type),
              ) ??
            null,
        }));
  const releaseCopy =
    reviewStatus === "approved"
      ? "Approved versions are ready to export."
      : reviewStatus === "changes_requested"
        ? "Update the deliverables, then approve the current versions."
        : "Review the outputs once, then release the current versions.";

  return (
    <section className="border-b border-gray-900/[0.07] py-5">
      <div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-gray-950">
                Work product
              </h2>
              <p className="mt-0.5 text-xs text-gray-500">
                {outputRows.length} current file
                {outputRows.length === 1 ? "" : "s"} · {releaseCopy}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {reviewStatus === "changes_requested" && (
                <button
                  type="button"
                  onClick={() => void onRevise()}
                  disabled={revisionStarting || submitting !== null}
                  title="Update the required outputs, then rerun verification"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-gray-950 px-3.5 text-xs font-medium text-white shadow-sm outline-none transition-colors hover:bg-black focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:opacity-45"
                >
                  {revisionStarting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  {revisionStarting ? "Starting revision" : "Revise outputs"}
                </button>
              )}
              {reviewStatus !== "approved" && (
                <button
                  type="button"
                  onClick={() => setReviewAction("approved")}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2",
                    reviewStatus === "changes_requested"
                      ? "bg-white text-gray-700 shadow-sm hover:bg-gray-50"
                      : "bg-gray-950 text-white shadow-sm hover:bg-black",
                  )}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Approve
                </button>
              )}
              {reviewStatus !== "changes_requested" && (
                <button
                  type="button"
                  onClick={() => setReviewAction("changes_requested")}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3.5 text-xs font-medium text-gray-700 shadow-sm outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {reviewStatus === "approved" ? "Reopen" : "Request changes"}
                </button>
              )}
            </div>
          </div>
          <div className="mt-3 divide-y divide-gray-900/[0.06] border-y border-gray-900/[0.06]">
            {outputRows.map((output) => {
              const canDownload = output.artifact !== null;
              const canOpen = output.linkedArtifact !== null;
              return (
                <div
                  key={output.key}
                  className="flex min-w-0 items-stretch"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (output.linkedArtifact) {
                        onOpenArtifact(output.linkedArtifact, {
                          versionId: output.artifact?.version_id ?? null,
                        });
                      }
                    }}
                    disabled={!canOpen}
                    title={
                      canOpen
                        ? `Open ${output.label} at ${output.artifact ? "the approved version" : "its current version"}`
                        : "Output is not available yet"
                    }
                    className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-1 py-2 text-left outline-none transition-colors hover:bg-white/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/70 disabled:cursor-default disabled:opacity-60"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600">
                      {canOpen ? (
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      ) : (
                        <FileText className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-gray-800">
                        {output.label}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-gray-500">
                        {output.detail}
                      </span>
                    </span>
                    {output.version && (
                      <span className="shrink-0 text-[10px] text-gray-400">
                        V{output.version}
                      </span>
                    )}
                  </button>
                  {canDownload && output.artifact && (
                    <button
                      type="button"
                      onClick={() => void onDownload(output.artifact!)}
                      disabled={downloadingArtifact !== null}
                      title={`Export locked ${output.detail}`}
                      aria-label={`Export locked ${output.detail}`}
                      className="flex w-10 shrink-0 items-center justify-center text-gray-500 outline-none transition-colors hover:bg-white/60 hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/70 disabled:opacity-50"
                    >
                      {downloadingArtifact === output.artifact.artifact_id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {reviewAction && (
          <div className="mt-3 rounded-xl bg-white px-3 py-3 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-gray-800">
                {reviewAction === "approved"
                  ? "Approve current files"
                  : "Describe required changes"}
              </p>
              <button
                type="button"
                onClick={() => setReviewAction(null)}
                className="rounded px-1.5 py-1 text-xs text-gray-500 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500/70"
              >
                Cancel
              </button>
            </div>
            <textarea
              id="review-note"
              aria-label="Review note"
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
              maxLength={4000}
              rows={2}
              placeholder={
                reviewAction === "changes_requested"
                  ? "What should change?"
                  : "Optional approval note"
              }
              className="mt-2 w-full resize-none rounded-lg bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-900 outline-none ring-1 ring-gray-900/[0.08] placeholder:text-gray-500 focus:ring-2 focus:ring-blue-500/70"
            />
            <button
              type="button"
              onClick={async () => {
                if (await onDecision(reviewAction)) {
                  setReviewAction(null);
                }
              }}
              disabled={submitting !== null}
              className={cn(
                "mt-2 inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:opacity-45",
                reviewAction === "approved"
                  ? "bg-gray-950 text-white hover:bg-black"
                  : "bg-white text-red-700 shadow-sm hover:bg-gray-50",
              )}
            >
              {submitting === reviewAction ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : reviewAction === "approved" ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {reviewAction === "approved" ? "Approve for export" : "Request changes"}
            </button>
          </div>
        )}
        <div>
          {error && (
            <p
              role="alert"
              className="mt-2 break-words text-[11px] leading-4 text-red-700 [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
        </div>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer list-none rounded text-xs text-gray-500 outline-none hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500/70">
          Review record · {snapshot.review.decisions.length} decision
          {snapshot.review.decisions.length === 1 ? "" : "s"} · reviewer{" "}
          {reviewerName || "signed-in user"}
        </summary>
        <div className="mt-3 grid gap-4 border-t border-gray-900/[0.06] pt-3 md:grid-cols-[minmax(0,1fr)_260px]">
          <ol className="max-h-44 overflow-y-auto pr-1">
            {snapshot.review.decisions.map((decision, index) => {
              const actor =
                decision.reviewer_name ||
                decision.reviewer_email ||
                "Vera system";
              return (
                <li
                  key={decision.id}
                  className="relative flex gap-3 py-2.5 first:pt-1"
                >
                  {index < snapshot.review.decisions.length - 1 && (
                    <span className="absolute left-[5px] top-5 h-[calc(100%-8px)] w-px bg-gray-200" />
                  )}
                  <span
                    className={cn(
                      "relative mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white",
                      decision.status === "approved"
                        ? "bg-emerald-500"
                        : decision.status === "changes_requested"
                          ? "bg-red-500"
                          : "bg-amber-500",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline justify-between gap-3">
                      <p className="min-w-0 truncate text-[11px] font-medium text-gray-800">
                        {REVIEW_LABELS[decision.status]}
                      </p>
                      <time
                        className="shrink-0 text-[10px] text-gray-400"
                        dateTime={decision.created_at}
                      >
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(decision.created_at))}
                      </time>
                    </div>
                    <p
                      className="mt-0.5 truncate text-[10px] text-gray-500"
                      title={actor}
                    >
                      {actor}
                    </p>
                    {decision.note && (
                      <p className="mt-1 break-words text-[11px] leading-4 text-gray-600 [overflow-wrap:anywhere]">
                        {decision.note}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
            {snapshot.review.decisions.length === 0 && (
              <li className="py-3 text-[11px] leading-4 text-gray-500">
                Review is required. The first decision will appear here with
                reviewer identity and time.
              </li>
            )}
          </ol>
          <div className="text-[10px] leading-4 text-gray-500">
            <p>
              Decisions are retained with reviewer identity and time. Approved
              exports are limited to the recorded versions.
            </p>
            <p className="mt-2">
              Vera records the signed-in account identity; it does not verify
              professional licensing or credentials.
            </p>
            {latestDecision?.status === "approved" &&
              latestDecision.artifact_snapshot.map((artifact) => (
                <p
                  key={artifact.version_id}
                  className="mt-2 break-all font-mono text-[9px] text-gray-400"
                >
                  {artifact.filename} · {artifact.sha256}
                </p>
              ))}
            <p className="mt-2">
              Vera output remains subject to professional judgment and is not
              legal advice.
            </p>
          </div>
        </div>
      </details>
    </section>
  );
}

function WorkRecord({
  snapshot,
  executionError,
  providerQueued,
  onRetry,
  onAttachDocuments,
  onOpenArtifact,
  evidenceByArtifact,
  evidenceLoading,
  expandedEvidenceId,
  onToggleEvidence,
  onOpenCitation,
}: {
  snapshot: AgentTaskSnapshot;
  executionError: string | null;
  providerQueued: boolean;
  onRetry: () => Promise<void>;
  onAttachDocuments: () => Promise<void>;
  onOpenArtifact: (artifact: AgentTaskSnapshot["artifacts"][number]) => void;
  evidenceByArtifact: Record<string, AgentEvidenceSnapshot>;
  evidenceLoading: string | null;
  expandedEvidenceId: string | null;
  onToggleEvidence: (artifactId: string) => void;
  onOpenCitation: (citation: AgentEvidenceCitation) => void;
}) {
  const { task } = snapshot;
  const current = task.current_plan.find((step) => step.status === "running");
  const completedCount = task.current_plan.filter(
    (step) => step.status === "completed",
  ).length;
  const title =
    task.status === "completed"
      ? "Completed in " + completedCount + " steps"
      : current
        ? "Working · " + current.title
        : task.status === "paused"
          ? "Work paused"
          : task.status === "waiting_input"
            ? "Input required"
            : task.status === "failed"
              ? "Work stopped"
              : "Ready to work";
  const supportingArtifacts = snapshot.artifacts.filter(
    (artifact) =>
      artifact.artifact_type === "chat" ||
      artifact.artifact_type === "workflow_run",
  );

  return (
    <section className="py-5" aria-live="polite">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-950">{title}</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {completedCount} of {task.current_plan.length} steps complete
          </p>
        </div>
        {task.status === "failed" && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void onRetry()}
              className="inline-flex h-8 items-center rounded-full bg-gray-950 px-3.5 text-xs font-medium text-white shadow-sm outline-none hover:bg-black focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2"
            >
              Retry current step
            </button>
            <Link
              href="/account/api-keys"
              className="inline-flex h-8 items-center rounded-full bg-white px-3.5 text-xs font-medium text-gray-700 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/70"
            >
              Model settings
            </Link>
          </div>
        )}
        {task.status === "waiting_input" && (
          <div className="flex flex-wrap gap-2">
            <Link
              href={"/projects/" + task.matter_id}
              className="inline-flex h-8 items-center rounded-full bg-white px-3.5 text-xs font-medium text-gray-700 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/70"
            >
              Open documents
            </Link>
            <button
              type="button"
              onClick={() => void onAttachDocuments()}
              className="inline-flex h-8 items-center rounded-full bg-gray-950 px-3.5 text-xs font-medium text-white shadow-sm outline-none hover:bg-black focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2"
            >
              Attach new documents
            </button>
          </div>
        )}
      </div>

      {(providerQueued ||
        task.status === "failed" ||
        task.status === "waiting_input" ||
        executionError) && (
        <div
          role={task.status === "failed" || executionError ? "alert" : "status"}
          className={cn(
            "mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-5",
            task.status === "failed" || executionError
              ? "bg-red-50 text-red-800"
              : "bg-amber-50 text-amber-900",
          )}
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words [overflow-wrap:anywhere]">
            {executionError ||
              task.latest_checkpoint?.summary ||
              (providerQueued
                ? "The provider is queued. Resume retries the current step."
                : "More Matter documents are needed before work can continue.")}
          </span>
        </div>
      )}

      <ol className="mt-3 overflow-hidden rounded-xl bg-white/70 shadow-sm">
        {task.current_plan.map((step, index) => {
          const Icon = STEP_ICONS[step.status];
          const stepPosition = index + 1;
          const evidencePurpose =
            "Step " + stepPosition + " evidence citations";
          const latestEvidence = [...snapshot.artifacts]
            .reverse()
            .find(
              (artifact) =>
                artifact.artifact_type === "citation_snapshot" &&
                artifact.purpose === evidencePurpose,
            );
          const relatedArtifacts = snapshot.artifacts.filter(
            (artifact) => {
              if (artifact.artifact_id === latestEvidence?.artifact_id) {
                return true;
              }
              const stepText = `${step.title} ${step.expected_output}`.toLowerCase();
              return snapshot.task.deliverables.some((deliverable) => {
                const purpose =
                  deliverable.purpose ??
                  (deliverable.key === "risk-matrix"
                    ? "Risk matrix"
                    : deliverable.key === "review-memo"
                      ? "Review memo draft"
                      : deliverable.title);
                return (
                  (deliverable.artifact_id === artifact.artifact_id ||
                    artifact.purpose === purpose) &&
                  (stepText.includes(deliverable.title.toLowerCase()) ||
                    stepText.includes(purpose.toLowerCase()))
                );
              });
            },
          );
          return (
            <li
              key={step.id}
              className="border-b border-gray-900/[0.06] last:border-b-0"
            >
              <details>
                <summary className="group flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2 outline-none hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/70">
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                      step.status === "completed"
                        ? "bg-emerald-50 text-emerald-700"
                        : step.status === "running"
                          ? "bg-blue-50 text-blue-700"
                          : step.status === "blocked"
                            ? "bg-red-50 text-red-700"
                            : "bg-gray-100 text-gray-400",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-3.5 w-3.5",
                        step.status === "running" && "animate-spin",
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-gray-800">
                      {step.title}
                    </span>
                    {step.status === "running" && (
                      <span className="mt-0.5 block truncate text-xs text-gray-500">
                        {step.expected_output}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-gray-400">
                    {step.status === "completed"
                      ? "Completed"
                      : step.status === "running"
                        ? "Attempt " + step.attempt
                        : step.status === "blocked"
                          ? "Blocked"
                          : step.status === "skipped"
                            ? "Skipped"
                            : "Pending"}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-300 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" />
                </summary>
                <div className="pb-4 pl-12 pr-3">
                  {step.result_summary ? (
                    <TaskResult>{step.result_summary}</TaskResult>
                  ) : (
                    <p className="text-xs leading-5 text-gray-500">
                      Expected: {step.expected_output}
                    </p>
                  )}
                  {relatedArtifacts.length > 0 && (
                    <div className="mt-3 divide-y divide-gray-900/[0.05] border-t border-gray-900/[0.05]">
                      {relatedArtifacts.map((artifact) => {
                        const isEvidence =
                          artifact.artifact_type === "citation_snapshot";
                        const expanded =
                          expandedEvidenceId === artifact.artifact_id;
                        return (
                          <div
                            key={
                              step.id +
                              ":" +
                              artifact.artifact_type +
                              ":" +
                              artifact.artifact_id
                            }
                            id={
                              isEvidence
                                ? "evidence-" + artifact.artifact_id
                                : undefined
                            }
                          >
                            <button
                              type="button"
                              onClick={() =>
                                isEvidence
                                  ? onToggleEvidence(artifact.artifact_id)
                                  : onOpenArtifact(artifact)
                              }
                              aria-expanded={isEvidence ? expanded : undefined}
                              className="flex min-h-10 w-full items-center gap-2 py-2 text-left text-xs text-gray-600 outline-none hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-blue-500/70"
                            >
                              {evidenceLoading === artifact.artifact_id ? (
                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                              ) : isEvidence ? (
                                <MapPin className="h-3.5 w-3.5 shrink-0" />
                              ) : (
                                <FileText className="h-3.5 w-3.5 shrink-0" />
                              )}
                              <span className="min-w-0 flex-1 truncate">
                                {isEvidence ? "Check sources" : artifact.purpose}
                              </span>
                              {isEvidence ? (
                                <ChevronRight
                                  className={cn(
                                    "h-3.5 w-3.5 shrink-0 text-gray-300 transition-transform duration-200 motion-reduce:transition-none",
                                    expanded && "rotate-90",
                                  )}
                                />
                              ) : (
                                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-gray-300" />
                              )}
                            </button>
                            {isEvidence && expanded && (
                              <EvidenceCitationList
                                evidence={
                                  evidenceByArtifact[artifact.artifact_id]
                                }
                                onOpenCitation={onOpenCitation}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      {task.latest_checkpoint && task.status !== "completed" && (
        <details className="mt-3">
          <summary className="cursor-pointer list-none rounded text-xs text-gray-500 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500/70">
            Latest checkpoint
          </summary>
          <TaskResult compact>{task.latest_checkpoint.summary}</TaskResult>
        </details>
      )}

      {supportingArtifacts.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer list-none rounded text-xs text-gray-500 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500/70">
            Task details
          </summary>
          <div className="mt-2 divide-y divide-gray-900/[0.05] border-y border-gray-900/[0.05]">
            {supportingArtifacts.map((artifact) => (
              <button
                key={artifact.artifact_id}
                type="button"
                onClick={() => onOpenArtifact(artifact)}
                className="flex min-h-10 w-full items-center justify-between gap-3 py-2 text-left text-xs text-gray-600 outline-none hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-blue-500/70"
              >
                <span className="truncate">{artifact.purpose}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-gray-300" />
              </button>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
function TaskResult({
  children,
  compact = false,
}: {
  children: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "mt-1 overflow-auto pr-2 text-gray-500 [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-gray-100 [&_code]:px-1 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p+p]:mt-1.5 [&_table]:my-2 [&_table]:w-full [&_td]:border-b [&_td]:border-gray-100 [&_td]:px-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-gray-200 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
        compact
          ? "max-h-24 text-[11px] leading-4"
          : "max-h-40 text-xs leading-5",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function EvidenceCitationList({
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
