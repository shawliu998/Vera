"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArchiveX,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  BookOpen,
  Check,
  ClipboardPlus,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FileUp,
  FlaskConical,
  Gavel,
  GitCompareArrows,
  History,
  Link2,
  LoaderCircle,
  MessageSquareWarning,
  Plus,
  RefreshCw,
  Search,
  ScanSearch,
  Save,
  Scale,
  ShieldCheck,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { AletheiaShell } from "../AletheiaShell";
import { MatterDocumentImporter } from "../MatterDocumentImporter";
import { MatterDocumentStatusList } from "../MatterDocumentStatusList";
import { apiSettingsTransport } from "../settingsTransport";
import {
  createLitigationClaim,
  createLitigationClaimElement,
  createLitigationDocumentDraft,
  createLitigationPositionReview,
  createLitigationCourtCalendar,
  createLitigationMatterAuditExport,
  anchorLitigationMatterAuditSignoff,
  createLitigationDeadlineRule,
  createMatterTaskFromDeadline,
  createLitigationFact,
  createLitigationRetrievalManifest,
  createLitigationProceduralEvent,
  correctLitigationProceduralEvent,
  createLitigationDurableRun,
  createLitigationLegalAuthorityVersion,
  createReviewedLitigationSynthesis,
  cancelAletheiaDurableRun,
  decideLitigationClaim,
  decideLitigationClaimElement,
  decideLitigationDeadline,
  decideLitigationFact,
  decideLitigationProceduralEvent,
  decideLitigationAgentOutputReview,
  decideAletheiaApproval,
  diffLitigationDocumentDraftVersions,
  exportLitigationDocumentDraftDocx,
  exportLitigationArtifact,
  fetchLitigationArtifactDownload,
  getAletheiaMatter,
  getAletheiaDurableExecutorStatus,
  getAletheiaDurableRun,
  getAletheiaDurableRunIntegrity,
  getLatestLitigationDurableRun,
  getLitigationDocumentDraft,
  getLitigationMatterAuditExport,
  getLitigationMatterAuditExportPreview,
  getLitigationMatterAuditSignoffAnchorProof,
  getLitigationArtifactExportApproval,
  getLitigationLegalAuthorityVersion,
  getLitigationRetrievalManifest,
  getLitigationWorkspace,
  calculateLitigationDeadlineRule,
  linkLitigationPositionAuthority,
  listLitigationEvalRuns,
  listLitigationDocumentTemplates,
  listLitigationDocumentDrafts,
  listLitigationMatterAuditExports,
  listLitigationMatterAuditExportSignoffs,
  listLitigationLegalAuthorities,
  listLitigationCourtCalendars,
  listLitigationDeadlineRules,
  importLitigationDocumentTemplate,
  importLitigationDocumentDraftDocx,
  publishLitigationDocumentTemplate,
  retireLitigationDocumentTemplate,
  retireLitigationLegalAuthorityVersion,
  retireLitigationCourtCalendar,
  retireLitigationDeadlineRule,
  listAletheiaTasks,
  listLocalModels,
  generateLitigationArtifact,
  listAletheiaV1SourceIndex,
  linkLitigationElementFact,
  requestAletheiaApproval,
  requestLitigationAgentOutputReview,
  reviewLitigationDocumentDraftVersion,
  reviewLitigationAgentFinding,
  resolveLitigationPositionReview,
  runLitigationEvalSuite,
  runLitigationAgentFindingSemanticCheck,
  signLitigationMatterAuditExport,
  updateLitigationProfile,
  appendLitigationDocumentDraftVersion,
  withdrawLitigationRetrievalExcerpt,
  confirmLitigationRetrievalExcerpt,
  verifyLitigationSourceSpanOriginal,
  withdrawLitigationSourceSpanOriginalVerification,
  verifyLitigationLegalAuthorityVersion,
  verifyLitigationCourtCalendar,
  verifyLitigationDeadlineRule,
  voteLitigationArtifactExportApproval,
  withdrawLitigationPositionReview,
  withdrawLitigationPositionAuthority,
  withdrawLitigationDocumentDraft,
  type AletheiaMatterDetail,
  type AletheiaMatterDocumentRecord,
  type AletheiaMatterRecord,
  AletheiaApiError,
  type AletheiaMatterTaskRecord,
  type AletheiaWorkProductRecord,
  type AletheiaHumanCheckpointRecord,
  type AletheiaDurableExecutorStatus,
  type AletheiaDurableRun,
  type AletheiaDurableRunIntegrity,
  type LitigationArtifactExportResult,
  type LitigationArtifactExportApprovalProjection,
  type LitigationApprovalVoteBlockReason,
  type LitigationEvalRun,
  type LitigationAgentOutputReviewRecord,
  type LitigationAgentFindingReviewRecord,
  type LitigationAgentFindingSemanticCheckRecord,
  type LocalModelSnapshot,
  type LitigationClaimElementRecord,
  type LitigationClaimRecord,
  type LitigationCourtCalendarDisposition,
  type LitigationCourtCalendarVersionRecord,
  type LitigationPositionReviewRecord,
  type LitigationPositionAuthorityStatusRecord,
  type LitigationLegalAuthorityRegistry,
  type LitigationLegalAuthorityType,
  type LitigationLegalAuthorityVersionDetail,
  type LitigationDeadlineRecord,
  type LitigationDeadlineRuleRecord,
  type LitigationElementFactRecord,
  type LitigationFactRecord,
  type LitigationArtifactKind,
  type LitigationProceduralEventRecord,
  type LitigationProceduralEventCorrectionResult,
  type LitigationRetrievalManifest,
  type LitigationWorkspaceRecord,
  type LitigationDocumentTemplateRecord,
  type LitigationDocumentDraftDetail,
  type LitigationDocumentDraftDiff,
  type LitigationDocumentDraftRecord,
  type LitigationDocumentDraftSection,
  type LitigationMatterAuditExportPackage,
  type LitigationMatterAuditExportPreview,
  type LitigationMatterAuditExportSignoff,
  type LitigationMatterAuditExportSummary,
  type LitigationSignoffAnchorProof,
} from "@/app/lib/aletheiaApi";
import type { DocumentChunk } from "../agentops/v1Contracts";
import { useOriginalDocumentAccess } from "../originalDocumentAccess";
import { OriginalEvidenceViewer } from "../OriginalEvidenceViewer";
import { LegalResearchWorkbench } from "./LegalResearchWorkbench";

const views = [
  { id: "overview", label: "概览", icon: Scale },
  { id: "facts", label: "事实与证据", icon: Link2 },
  { id: "positions", label: "请求权与抗辩", icon: Gavel },
  { id: "research", label: "法律研究", icon: BookOpen },
  { id: "procedure", label: "程序与期限", icon: CalendarClock },
  { id: "artifacts", label: "文书与庭审", icon: FileText },
] as const;

const compatibilityViews = [
  { id: "agent", label: "Agent Run", icon: Workflow },
  { id: "evals", label: "Eval Lab", icon: FlaskConical },
] as const;

const allViews = [...views, ...compatibilityViews] as const;

const artifactKinds: Array<{
  kind: LitigationArtifactKind;
  label: string;
  detail: string;
}> = [
  {
    kind: "evidence_catalog",
    label: "Evidence catalog",
    detail: "Confirmed facts and verified source spans.",
  },
  {
    kind: "claim_defense_matrix",
    label: "Claim and defense matrix",
    detail: "Legal elements, fact links, and open gaps.",
  },
  {
    kind: "procedural_clock",
    label: "Procedural clock",
    detail: "Confirmed events and calculated deadlines.",
  },
  {
    kind: "litigation_brief",
    label: "Litigation brief",
    detail: "Issue-oriented case outline for lawyer review.",
  },
  {
    kind: "hearing_plan",
    label: "Hearing plan",
    detail: "Hearing issues, evidence gaps, and deadline checklist.",
  },
  {
    kind: "hearing_bundle_index",
    label: "Hearing bundle index",
    detail: "Exhibit numbering, source hashes, and page-level references.",
  },
];

function changedArtifactSections(
  previous: AletheiaWorkProductRecord | undefined,
  current: AletheiaWorkProductRecord | undefined,
) {
  if (!previous || !current) return [];
  const keys = new Set([
    ...Object.keys(previous.content),
    ...Object.keys(current.content),
  ]);
  return [...keys].filter(
    (key) =>
      key !== "generatedAt" &&
      JSON.stringify(previous.content[key]) !==
        JSON.stringify(current.content[key]),
  );
}

type ViewId = (typeof allViews)[number]["id"];

type ObjectFocus = {
  type:
    | "document"
    | "fact"
    | "position"
    | "deadline"
    | "task"
    | "artifact";
  id: string;
};

type FocusResolution =
  | { status: "ignored" | "loading" | "missing" | "mismatched" }
  | {
      status: "found";
      targetKey: string;
      focus: ObjectFocus;
      product: AletheiaWorkProductRecord | null;
      currentProduct: AletheiaWorkProductRecord | null;
    };

const OBJECT_FOCUS_PATTERN =
  /^(document|fact|position|deadline|task|artifact):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

function parseObjectFocus(value: string | null): ObjectFocus | null {
  if (!value || value.length > 137) return null;
  const match = OBJECT_FOCUS_PATTERN.exec(value);
  if (!match) return null;
  return {
    type: match[1] as ObjectFocus["type"],
    id: match[2],
  };
}

function artifactView(kind: string): ViewId | null {
  if (kind === "evidence_catalog") return "facts";
  if (kind === "claim_defense_matrix") return "positions";
  if (kind === "procedural_clock") return "procedure";
  if (
    kind === "litigation_brief" ||
    kind === "hearing_plan" ||
    kind === "hearing_bundle_index"
  ) {
    return "artifacts";
  }
  return null;
}

function resolveObjectFocus({
  focus,
  activeView,
  matter,
  workspace,
  tasks,
  loading,
}: {
  focus: ObjectFocus | null;
  activeView: ViewId;
  matter: AletheiaMatterDetail | null;
  workspace: LitigationWorkspaceRecord | null;
  tasks: AletheiaMatterTaskRecord[];
  loading: boolean;
}): FocusResolution {
  if (!focus) return { status: "ignored" };
  if (loading || !matter || !workspace) return { status: "loading" };
  const expectedMatterId = matter.matter.id;

  if (focus.type === "document") {
    if (activeView !== "facts") return { status: "mismatched" };
    const document = matter.documents.find(
      (item) =>
        item.id === focus.id && item.matter_id === expectedMatterId,
    );
    return document
      ? {
          status: "found",
          targetKey: `document:${document.id}`,
          focus,
          product: null,
          currentProduct: null,
        }
      : { status: "missing" };
  }

  if (focus.type === "fact") {
    if (activeView !== "facts") return { status: "mismatched" };
    const fact = workspace.facts.find(
      (item) => item.id === focus.id && item.matter_id === expectedMatterId,
    );
    return fact
      ? {
          status: "found",
          targetKey: `fact:${fact.id}`,
          focus,
          product: null,
          currentProduct: null,
        }
      : { status: "missing" };
  }

  if (focus.type === "position") {
    if (activeView !== "positions") return { status: "mismatched" };
    const position = workspace.claims.find(
      (item) => item.id === focus.id && item.matter_id === expectedMatterId,
    );
    return position
      ? {
          status: "found",
          targetKey: `position:${position.id}`,
          focus,
          product: null,
          currentProduct: null,
        }
      : { status: "missing" };
  }

  if (focus.type === "deadline") {
    if (activeView !== "procedure") return { status: "mismatched" };
    const deadline = workspace.deadlines.find(
      (item) =>
        item.id === focus.id && item.matter_id === expectedMatterId,
    );
    return deadline
      ? {
          status: "found",
          targetKey: `deadline:${deadline.id}`,
          focus,
          product: null,
          currentProduct: null,
        }
      : { status: "missing" };
  }

  if (focus.type === "task") {
    if (activeView !== "procedure") return { status: "mismatched" };
    const task = tasks.find(
      (item) =>
        item.id === focus.id && item.matter_id === expectedMatterId,
    );
    const deadline = task
      ? workspace.deadlines.find(
          (item) => item.id === task.source_deadline_id,
        )
      : null;
    return task && deadline
      ? {
          status: "found",
          targetKey: `task:${task.id}`,
          focus,
          product: null,
          currentProduct: null,
        }
      : { status: "missing" };
  }

  const product = matter.workProducts.find(
    (item) =>
      item.id === focus.id && item.matter_id === expectedMatterId,
  );
  if (!product) return { status: "missing" };
  const expectedView = artifactView(product.kind);
  if (!expectedView || activeView !== expectedView) {
    return { status: "mismatched" };
  }
  const currentProduct = matter.workProducts
    .filter((item) => item.kind === product.kind)
    .sort((left, right) => left.version - right.version)
    .at(-1);
  return currentProduct
    ? {
        status: "found",
        targetKey: `artifact:${currentProduct.id}`,
        focus,
        product,
        currentProduct,
      }
    : { status: "missing" };
}

function proposalTone(status: string) {
  if (status === "confirmed") return "text-emerald-700";
  if (status === "rejected") return "text-red-600";
  if (status === "disputed") return "text-amber-700";
  if (status === "withdrawn") return "text-gray-400";
  return "text-gray-500";
}

function positionAuthorityTone(
  status: LitigationPositionAuthorityStatusRecord["status"],
) {
  if (status === "satisfied") return "border-emerald-600 text-emerald-800";
  if (status === "invalid") return "border-red-600 text-red-700";
  return "border-amber-500 text-amber-800";
}

function positionAuthorityReadinessCopy(
  status: LitigationPositionAuthorityStatusRecord["status"],
  positionStatus: LitigationClaimRecord["status"],
) {
  if (status === "satisfied") {
    return positionStatus === "confirmed"
      ? "Verified exact-quote authority is active. This confirmed position may enter Agent snapshots, approval-ready documents, and export, subject to the remaining matter gates."
      : "Verified exact-quote authority is active. This position remains proposed and stays outside Agent snapshots, approval-ready documents, and export until counsel confirms it.";
  }
  if (status === "invalid") {
    return "An active authority link fails verification, quote integrity, or effective-date checks. Counsel may still record a position decision, but the position cannot enter Agent snapshots, approval-ready documents, or export until the link is corrected.";
  }
  return "No active verified exact-quote authority is linked. Counsel may still record a position decision, but the position cannot enter Agent snapshots, approval-ready documents, or export until authority is linked.";
}

function legalAssessmentSourceCounts(
  snapshot: LitigationWorkspaceRecord["legal_assessments"][number]["source_snapshot"],
) {
  if (Array.isArray(snapshot)) {
    return {
      evidenceSources: snapshot.length,
      legalAuthorities: 0,
      legacy: true,
    };
  }
  return {
    evidenceSources: Array.isArray(snapshot.evidenceSources)
      ? snapshot.evidenceSources.length
      : 0,
    legalAuthorities: Array.isArray(snapshot.legalAuthorities)
      ? snapshot.legalAuthorities.length
      : 0,
    legacy: false,
  };
}

function formatDate(value: string | null | undefined) {
  if (!value) return "No date";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat("en", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(parsed);
}

function toDateTimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "";
  const local = new Date(
    parsed.valueOf() - parsed.getTimezoneOffset() * 60_000,
  );
  return local.toISOString().slice(0, 16);
}

function shortHash(value: string | null | undefined) {
  if (!value) return "Unavailable";
  return value.length > 24 ? `${value.slice(0, 15)}…${value.slice(-8)}` : value;
}

function formatFileBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

const voteBlockReasonCopy: Record<LitigationApprovalVoteBlockReason, string> = {
  independent_approval_not_required:
    "Independent voting is not required in this local workspace.",
  approval_not_requested: "Export approval has not been requested.",
  artifact_binding_stale:
    "This approval no longer matches the current artifact version.",
  artifact_ineligible: "This artifact is not eligible for export approval.",
  governance_request_ineligible:
    "The governance request is not eligible for further decisions.",
  policy_missing_or_disabled: "The approval policy is unavailable or disabled.",
  requester_cannot_vote: "The requester cannot vote on this approval.",
  missing_approval_vote_permission:
    "You do not have permission to vote on this approval.",
  role_not_eligible: "Your role is not eligible to vote on this approval.",
  actor_already_voted: "You have already voted on this approval.",
  distinct_role_already_approved:
    "An approval from your role is already recorded.",
  governance_request_approved: "The governance request is approved.",
  governance_request_rejected: "The governance request is rejected.",
};

function shortIdentifier(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function semanticCheckModelEligibility(model: LocalModelSnapshot | null) {
  if (!model) {
    return {
      eligible: false,
      reason: "The selected litigation model is unavailable.",
    } as const;
  }
  if (model.state !== "ready") {
    return {
      eligible: false,
      reason: "The selected litigation model is not ready.",
    } as const;
  }
  if (
    !model.modelRevision ||
    !/^sha256:[a-f0-9]{64}$/i.test(model.modelRevision)
  ) {
    return {
      eligible: false,
      reason: "The selected litigation model has no immutable revision.",
    } as const;
  }
  if (model.calibrationAcceptance?.accepted !== true) {
    return {
      eligible: false,
      reason: "Run the current exact-quote calibration in Settings.",
    } as const;
  }
  if (model.benchmarkAcceptance?.accepted !== true) {
    return {
      eligible: false,
      reason: "Run the current litigation diagnostic benchmark in Settings.",
    } as const;
  }
  return { eligible: true, reason: null } as const;
}

function approvalStatusLabel(value: string) {
  return value.replaceAll("_", " ");
}

function DecisionButtons({
  onDecision,
  disabled,
}: {
  onDecision: (decision: "confirmed" | "rejected") => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onDecision("confirmed")}
        className="grid h-8 w-8 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-emerald-700 disabled:opacity-40"
        aria-label="Confirm"
        title="Confirm"
      >
        <Check className="h-4 w-4" />
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onDecision("rejected")}
        className="grid h-8 w-8 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-red-600 disabled:opacity-40"
        aria-label="Reject"
        title="Reject"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function LitigationWorkspace({ matterId }: { matterId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view") as ViewId | null;
  const requestedFocus = searchParams.get("focus");
  const activeView = allViews.some((view) => view.id === requestedView)
    ? requestedView!
    : "overview";
  const parsedFocus = useMemo(
    () => parseObjectFocus(requestedFocus),
    [requestedFocus],
  );
  const [matter, setMatter] = useState<AletheiaMatterDetail | null>(null);
  const [workspace, setWorkspace] = useState<LitigationWorkspaceRecord | null>(
    null,
  );
  const [legalAuthorities, setLegalAuthorities] =
    useState<LitigationLegalAuthorityRegistry>({ versions: [], links: [] });
  const [deadlineRules, setDeadlineRules] = useState<
    LitigationDeadlineRuleRecord[]
  >([]);
  const [courtCalendars, setCourtCalendars] = useState<
    LitigationCourtCalendarVersionRecord[]
  >([]);
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generatingKind, setGeneratingKind] =
    useState<LitigationArtifactKind | null>(null);
  const [artifactApprovals, setArtifactApprovals] = useState<
    Record<string, LitigationArtifactExportApprovalProjection>
  >({});
  const [artifactExportResults, setArtifactExportResults] = useState<
    Record<string, LitigationArtifactExportResult>
  >({});
  const [savingExportId, setSavingExportId] = useState<string | null>(null);
  const [exportDeliveryMessage, setExportDeliveryMessage] = useState("");
  const [desktopClient, setDesktopClient] = useState(false);
  const [executorStatus, setExecutorStatus] =
    useState<AletheiaDurableExecutorStatus | null>(null);
  const [localModels, setLocalModels] = useState<LocalModelSnapshot[]>([]);
  const [selectedLitigationModelId, setSelectedLitigationModelId] = useState<
    string | null
  >(null);
  const [durableRun, setDurableRun] = useState<AletheiaDurableRun | null>(null);
  const [runIntegrity, setRunIntegrity] =
    useState<AletheiaDurableRunIntegrity | null>(null);
  const [evalRuns, setEvalRuns] = useState<LitigationEvalRun[]>([]);
  const [matterTasks, setMatterTasks] = useState<AletheiaMatterTaskRecord[]>(
    [],
  );
  const [eventCorrectionResult, setEventCorrectionResult] =
    useState<LitigationProceduralEventCorrectionResult | null>(null);
  const [preferredRuleEventId, setPreferredRuleEventId] = useState("");
  const [error, setError] = useState("");
  const [bundleOrganization, setBundleOrganization] = useState("");
  const [bundleCourt, setBundleCourt] = useState("");
  const [bundleCaseNumber, setBundleCaseNumber] = useState("");
  const [bundlePrefix, setBundlePrefix] = useState("EX");
  const [bundleStart, setBundleStart] = useState("1");
  const [bundlePaginationPolicy, setBundlePaginationPolicy] = useState<
    "auto" | "source_native"
  >("auto");
  const [documentTemplates, setDocumentTemplates] = useState<
    LitigationDocumentTemplateRecord[]
  >([]);
  const [documentTemplateKey, setDocumentTemplateKey] = useState(
    "cn-litigation-working-paper:1",
  );
  const [templateImportName, setTemplateImportName] = useState("");
  const [templateImportFile, setTemplateImportFile] = useState<File | null>(
    null,
  );
  const [templateApproval, setTemplateApproval] = useState<{
    templateId: string;
    checkpoint: AletheiaHumanCheckpointRecord;
    action: "publish" | "retire";
  } | null>(null);
  const [templateReviewReason, setTemplateReviewReason] = useState("");

  const [factStatement, setFactStatement] = useState("");
  const [factDate, setFactDate] = useState("");
  const [sourceChunkId, setSourceChunkId] = useState("");
  const [sourceQuote, setSourceQuote] = useState("");
  const [claimKind, setClaimKind] =
    useState<LitigationClaimRecord["kind"]>("claim");
  const [claimTitle, setClaimTitle] = useState("");
  const [legalBasis, setLegalBasis] = useState("");
  const [claimConfidence, setClaimConfidence] =
    useState<NonNullable<LitigationClaimRecord["confidence"]>>("medium");
  const [claimUncertainty, setClaimUncertainty] = useState("");
  const [reviewClaimId, setReviewClaimId] = useState("");
  const [parentReviewId, setParentReviewId] = useState("");
  const [reviewKind, setReviewKind] =
    useState<LitigationPositionReviewRecord["kind"]>("objection");
  const [reviewReason, setReviewReason] = useState("");
  const [requestedOutcome, setRequestedOutcome] =
    useState<LitigationPositionReviewRecord["requested_outcome"]>("rejected");
  const [selectedReviewId, setSelectedReviewId] = useState("");
  const [reviewResolution, setReviewResolution] =
    useState<NonNullable<LitigationPositionReviewRecord["resolution"]>>(
      "upheld",
    );
  const [resolutionComment, setResolutionComment] = useState("");
  const [elementClaimId, setElementClaimId] = useState("");
  const [elementTitle, setElementTitle] = useState("");
  const [elementDescription, setElementDescription] = useState("");
  const [linkElementId, setLinkElementId] = useState("");
  const [linkFactId, setLinkFactId] = useState("");
  const [linkRelation, setLinkRelation] = useState<"supports" | "contradicts">(
    "supports",
  );
  const [linkNote, setLinkNote] = useState("");
  const [eventType, setEventType] = useState("filing");
  const [eventTitle, setEventTitle] = useState("");
  const [eventAt, setEventAt] = useState("");
  const [agentFocus, setAgentFocus] = useState("");
  const [reviewedRetrievalManifest, setReviewedRetrievalManifest] =
    useState<LitigationRetrievalManifest | null>(null);
  const [boundRetrievalManifest, setBoundRetrievalManifest] =
    useState<LitigationRetrievalManifest | null>(null);

  const focusResolution = useMemo(
    () =>
      resolveObjectFocus({
        focus: parsedFocus,
        activeView,
        matter,
        workspace,
        tasks: matterTasks,
        loading,
      }),
    [activeView, loading, matter, matterTasks, parsedFocus, workspace],
  );

  const refreshAuthorityData = useCallback(async () => {
    const [litigation, authorityRegistry, matterDetail] = await Promise.all([
      getLitigationWorkspace(matterId),
      listLitigationLegalAuthorities(matterId),
      getAletheiaMatter(matterId),
    ]);
    setWorkspace(litigation);
    setLegalAuthorities(authorityRegistry);
    setMatter(matterDetail);
  }, [matterId]);

  const refreshArtifactApproval = useCallback(
    async (workProductId: string) => {
      const projection = await getLitigationArtifactExportApproval(
        matterId,
        workProductId,
      );
      setArtifactApprovals((current) => ({
        ...current,
        [workProductId]: projection,
      }));
      return projection;
    },
    [matterId],
  );

  const load = useCallback(async () => {
    setError("");
    try {
      const [
        matterDetail,
        litigation,
        sourceIndex,
        durableStatus,
        persistedEvalRuns,
        persistedTasks,
        latestDurableRun,
        templates,
        authorityRegistry,
        persistedCourtCalendars,
        persistedDeadlineRules,
        modelProjection,
        clientSettings,
      ] = await Promise.all([
        getAletheiaMatter(matterId),
        getLitigationWorkspace(matterId),
        listAletheiaV1SourceIndex(matterId, {
          includeChunks: true,
          includeEvidenceLinks: true,
          chunkLimit: 200,
        }),
        getAletheiaDurableExecutorStatus(),
        listLitigationEvalRuns(matterId),
        listAletheiaTasks("all"),
        getLatestLitigationDurableRun(matterId),
        listLitigationDocumentTemplates(matterId),
        listLitigationLegalAuthorities(matterId),
        listLitigationCourtCalendars(matterId),
        listLitigationDeadlineRules(matterId),
        listLocalModels(),
        apiSettingsTransport.load(),
      ]);
      setMatter(matterDetail);
      const litigationProducts = matterDetail.workProducts.filter((item) =>
        artifactKinds.some((artifact) => artifact.kind === item.kind),
      );
      const approvalEntries = await Promise.all(
        litigationProducts.map(
          async (product) =>
            [
              product.id,
              await getLitigationArtifactExportApproval(matterId, product.id),
            ] as const,
        ),
      );
      setArtifactApprovals(Object.fromEntries(approvalEntries));
      setWorkspace(litigation);
      setChunks(sourceIndex.chunks ?? []);
      setExecutorStatus(durableStatus);
      setEvalRuns(persistedEvalRuns);
      setMatterTasks(
        persistedTasks.filter((task) => task.matter_id === matterId),
      );
      setDurableRun(latestDurableRun);
      setDocumentTemplates(templates);
      setLegalAuthorities(authorityRegistry);
      setCourtCalendars(persistedCourtCalendars);
      setDeadlineRules(persistedDeadlineRules);
      setLocalModels(modelProjection.models);
      setSelectedLitigationModelId(
        clientSettings.settings.litigationModelId ||
          clientSettings.settings.defaultModel ||
          null,
      );
      setRunIntegrity(
        latestDurableRun
          ? await getAletheiaDurableRunIntegrity(latestDurableRun.id)
          : null,
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load matter",
      );
    } finally {
      setLoading(false);
    }
  }, [matterId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focusResolution.status !== "found") return;
    const targetKey = focusResolution.targetKey;
    const frame = window.requestAnimationFrame(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-object-focus-key]"),
      ).find((element) => element.dataset.objectFocusKey === targetKey);
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusResolution]);

  useEffect(() => {
    setDesktopClient(Boolean(window.aletheiaDesktop?.saveLitigationArtifact));
  }, []);

  useEffect(() => {
    const storageKey = `vera:litigation-retrieval-manifest:${matterId}`;
    const savedId = window.localStorage.getItem(storageKey);
    if (!savedId) return;
    void getLitigationRetrievalManifest(matterId, savedId)
      .then((current) => setReviewedRetrievalManifest(current))
      .catch(() => {
        window.localStorage.removeItem(storageKey);
        setReviewedRetrievalManifest(null);
        setBoundRetrievalManifest(null);
      });
  }, [matterId]);

  useEffect(() => {
    const profile = workspace?.profile;
    setBundleOrganization(String(profile?.organization_name ?? ""));
    setBundleCourt(String(profile?.court ?? ""));
    setBundleCaseNumber(String(profile?.case_number ?? ""));
    setBundlePrefix(String(profile?.exhibit_prefix ?? "EX"));
    setBundleStart(String(profile?.exhibit_start ?? 1));
    setBundlePaginationPolicy(
      profile?.pagination_policy === "source_native" ? "source_native" : "auto",
    );
    setDocumentTemplateKey(
      `${String(profile?.document_template_id ?? "cn-litigation-working-paper")}:${Number(profile?.document_template_version ?? 1)}`,
    );
  }, [workspace?.profile]);

  useEffect(() => {
    if (
      !durableRun ||
      ["succeeded", "failed", "cancelled", "timed_out"].includes(
        durableRun.status,
      )
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void Promise.all([
        getAletheiaDurableRun(durableRun.id),
        getAletheiaDurableRunIntegrity(durableRun.id),
      ]).then(([nextRun, integrity]) => {
        setDurableRun(nextRun);
        setRunIntegrity(integrity);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [durableRun]);

  const selectedChunk = useMemo(
    () => chunks.find((chunk) => chunk.id === sourceChunkId) ?? null,
    [chunks, sourceChunkId],
  );

  function selectedSource() {
    if (!selectedChunk || !sourceQuote.trim()) return null;
    const start = selectedChunk.text.indexOf(sourceQuote.trim());
    if (start < 0) {
      throw new Error(
        "The quoted text must exactly match the selected source chunk.",
      );
    }
    return {
      sourceChunkId: selectedChunk.id,
      quoteStart: start,
      quoteEnd: start + sourceQuote.trim().length,
    };
  }

  async function runMutation(action: () => Promise<unknown>) {
    setSaving(true);
    setError("");
    try {
      await action();
      await load();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Operation failed",
      );
    } finally {
      setSaving(false);
    }
  }

  async function recordSourceTextComparison(
    sourceSpanId: string,
    reason: string,
  ) {
    setSaving(true);
    setError("");
    try {
      await verifyLitigationSourceSpanOriginal(matterId, sourceSpanId, reason);
      await load();
    } catch {
      setError(
        "The original text comparison could not be recorded. Review the reason and retry.",
      );
      throw new Error("source_text_comparison_failed");
    } finally {
      setSaving(false);
    }
  }

  async function withdrawSourceTextComparison(
    sourceSpanId: string,
    verificationId: string,
    reason: string,
  ) {
    setSaving(true);
    setError("");
    try {
      await withdrawLitigationSourceSpanOriginalVerification(
        matterId,
        sourceSpanId,
        verificationId,
        reason,
      );
      await load();
    } catch {
      setError(
        "The recorded comparison could not be withdrawn. Review the reason and retry.",
      );
      throw new Error("source_text_comparison_withdrawal_failed");
    } finally {
      setSaving(false);
    }
  }

  async function correctEvent(
    eventId: string,
    payload: Parameters<typeof correctLitigationProceduralEvent>[2],
  ) {
    setSaving(true);
    setError("");
    try {
      const result = await correctLitigationProceduralEvent(
        matterId,
        eventId,
        payload,
      );
      await load();
      setEventCorrectionResult(result);
      setPreferredRuleEventId(result.replacement.id);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Event correction failed",
      );
      throw mutationError;
    } finally {
      setSaving(false);
    }
  }

  async function runArtifactApprovalMutation(
    product: AletheiaWorkProductRecord,
    action: () => Promise<unknown>,
  ) {
    setSaving(true);
    setError("");
    let mutationFailed = false;
    try {
      await action();
    } catch (mutationError) {
      mutationFailed = true;
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Approval operation failed",
      );
    } finally {
      try {
        await refreshArtifactApproval(product.id);
      } catch (refreshError) {
        if (!mutationFailed) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : "Unable to refresh export approval",
          );
        }
      }
      setSaving(false);
    }
  }

  async function addFact() {
    await runMutation(async () => {
      await createLitigationFact(matterId, {
        statement: factStatement,
        occurredAt: factDate ? new Date(factDate).toISOString() : null,
        datePrecision: factDate ? "day" : "unknown",
        sourceRelation: "supports",
        helpfulness: "unknown",
        source: selectedSource(),
        createdBy: "human",
      });
      setFactStatement("");
      setFactDate("");
      setSourceQuote("");
    });
  }

  async function addClaim() {
    await runMutation(async () => {
      await createLitigationClaim(matterId, {
        kind: claimKind,
        title: claimTitle,
        legalBasis: legalBasis || null,
        confidence: claimConfidence,
        uncertainty: claimUncertainty || null,
        sourceRelation: "authority",
        source: selectedSource(),
        createdBy: "human",
      });
      setClaimTitle("");
      setLegalBasis("");
      setClaimUncertainty("");
      setSourceQuote("");
    });
  }

  async function submitPositionReview() {
    await runMutation(async () => {
      await createLitigationPositionReview(matterId, reviewClaimId, {
        kind: reviewKind,
        reason: reviewReason,
        requestedOutcome,
        parentReviewId: parentReviewId || null,
        createdBy: "human",
      });
      setReviewClaimId("");
      setParentReviewId("");
      setReviewReason("");
      setReviewKind("objection");
      setRequestedOutcome("rejected");
    });
  }

  async function resolvePositionReview() {
    await runMutation(async () => {
      await resolveLitigationPositionReview(matterId, selectedReviewId, {
        resolution: reviewResolution,
        comment: resolutionComment,
      });
      setSelectedReviewId("");
      setReviewResolution("upheld");
      setResolutionComment("");
    });
  }

  async function withdrawPositionReview() {
    await runMutation(async () => {
      await withdrawLitigationPositionReview(matterId, selectedReviewId);
      setSelectedReviewId("");
      setResolutionComment("");
    });
  }

  async function addElement() {
    await runMutation(async () => {
      const existing =
        workspace?.elements.filter((item) => item.claim_id === elementClaimId)
          .length ?? 0;
      await createLitigationClaimElement(matterId, elementClaimId, {
        title: elementTitle,
        description: elementDescription || null,
        sequence: existing + 1,
        createdBy: "human",
      });
      setElementTitle("");
      setElementDescription("");
    });
  }

  async function addElementFact() {
    await runMutation(async () => {
      await linkLitigationElementFact(matterId, linkElementId, {
        factId: linkFactId,
        relation: linkRelation,
        note: linkNote || null,
      });
      setLinkFactId("");
      setLinkNote("");
    });
  }

  async function addEvent() {
    await runMutation(async () => {
      await createLitigationProceduralEvent(matterId, {
        eventType,
        title: eventTitle,
        occurredAt: eventAt ? new Date(eventAt).toISOString() : null,
        source: selectedSource(),
        createdBy: "human",
      });
      setEventTitle("");
      setEventAt("");
      setSourceQuote("");
    });
  }

  async function generateArtifact(kind: LitigationArtifactKind) {
    setGeneratingKind(kind);
    await runMutation(() => generateLitigationArtifact(matterId, kind));
    setGeneratingKind(null);
  }

  async function saveBundleProfile() {
    const exhibitStart = Number(bundleStart);
    const [documentTemplateId, versionText] = documentTemplateKey.split(":");
    await runMutation(() =>
      updateLitigationProfile(matterId, {
        organizationName: bundleOrganization || null,
        court: bundleCourt || null,
        caseNumber: bundleCaseNumber || null,
        exhibitPrefix: bundlePrefix,
        exhibitStart,
        paginationPolicy: bundlePaginationPolicy,
        documentTemplateId,
        documentTemplateVersion: Number(versionText),
      }),
    );
  }

  async function importDocumentTemplate() {
    if (!templateImportFile || !templateImportName.trim()) return;
    await runMutation(async () => {
      await importLitigationDocumentTemplate(
        matterId,
        templateImportName.trim(),
        templateImportFile,
      );
      setTemplateImportFile(null);
      setTemplateImportName("");
    });
  }

  async function requestTemplateApproval(
    template: LitigationDocumentTemplateRecord,
  ) {
    await runMutation(async () => {
      const checkpoint = await requestAletheiaApproval(matterId, {
        action: "litigation_template_publish",
        prompt: `Review and approve template ${template.name} v${template.version}`,
        requestedPayload: {
          templateId: template.id,
          fileSha256: template.file_sha256,
          version: template.version,
        },
      });
      setTemplateApproval({
        templateId: template.id,
        checkpoint,
        action: "publish",
      });
      setTemplateReviewReason("");
    });
  }

  async function requestTemplateRetirement(
    template: LitigationDocumentTemplateRecord,
  ) {
    await runMutation(async () => {
      const checkpoint = await requestAletheiaApproval(matterId, {
        action: "litigation_template_retire",
        prompt: `Review retirement of template ${template.name} v${template.version}`,
        requestedPayload: {
          templateId: template.id,
          fileSha256: template.file_sha256,
          version: template.version,
        },
      });
      setTemplateApproval({
        templateId: template.id,
        checkpoint,
        action: "retire",
      });
      setTemplateReviewReason("");
    });
  }

  async function approveTemplateLifecycle() {
    if (!templateApproval || templateReviewReason.trim().length < 10) return;
    await runMutation(async () => {
      const decided = await decideAletheiaApproval(
        matterId,
        templateApproval.checkpoint.id,
        {
          decision: "approved",
          comment: templateReviewReason.trim(),
        },
      );
      if (templateApproval.action === "publish") {
        await publishLitigationDocumentTemplate(
          matterId,
          templateApproval.templateId,
          decided.id,
        );
      } else {
        await retireLitigationDocumentTemplate(
          matterId,
          templateApproval.templateId,
          decided.id,
        );
      }
      setTemplateApproval(null);
      setTemplateReviewReason("");
    });
  }

  async function requestArtifactExport(product: AletheiaWorkProductRecord) {
    await runArtifactApprovalMutation(product, async () => {
      await requestAletheiaApproval(matterId, {
        action: "litigation_artifact_export",
        prompt: `Approve export of ${product.title} v${product.version}`,
        requestedPayload: {
          workProductId: product.id,
          version: product.version,
          contentHash: product.content_hash,
        },
      });
      setArtifactExportResults((current) => {
        const next = { ...current };
        delete next[product.id];
        return next;
      });
    });
  }

  async function voteOnArtifactExport(
    product: AletheiaWorkProductRecord,
    decision: "approved" | "rejected",
  ) {
    const projection = artifactApprovals[product.id];
    if (!projection?.approvalCheckpointId || !projection.actor.canVote) return;
    await runArtifactApprovalMutation(product, () =>
      voteLitigationArtifactExportApproval(matterId, product.id, {
        approvalCheckpointId: projection.approvalCheckpointId!,
        decision,
      }),
    );
  }

  async function decideLocalArtifactExport(
    product: AletheiaWorkProductRecord,
    decision: "approved" | "rejected",
  ) {
    const projection = artifactApprovals[product.id];
    if (
      !projection?.approvalCheckpointId ||
      projection.independentApproval.required
    ) {
      return;
    }
    await runArtifactApprovalMutation(product, () =>
      decideAletheiaApproval(matterId, projection.approvalCheckpointId!, {
        decision,
        comment:
          decision === "approved"
            ? "Non-independent local approval for export."
            : "Non-independent local rejection of export.",
      }),
    );
  }

  async function runArtifactExport(product: AletheiaWorkProductRecord) {
    const projection = artifactApprovals[product.id];
    if (!projection?.approvalCheckpointId || !projection.actor.canExport)
      return;
    await runArtifactApprovalMutation(product, async () => {
      const result = await exportLitigationArtifact(
        matterId,
        product.id,
        projection.approvalCheckpointId!,
        product.kind as LitigationArtifactKind,
      );
      setArtifactExportResults((current) => ({
        ...current,
        [product.id]: result,
      }));
      setExportDeliveryMessage(
        result.format === "zip"
          ? "Approved hearing bundle package is ready to save."
          : "Approved DOCX is ready to save.",
      );
    });
  }

  async function saveArtifactExport(
    product: AletheiaWorkProductRecord,
    result: { exportId: string; format: "docx" | "zip" },
    openAfterSave: boolean,
  ) {
    setSavingExportId(result.exportId);
    setError("");
    setExportDeliveryMessage("");
    const extension = result.format === "zip" ? "zip" : "docx";
    const suggestedName = `${product.title} v${product.version}.${extension}`;
    try {
      if (window.aletheiaDesktop?.saveLitigationArtifact) {
        const saved = await window.aletheiaDesktop.saveLitigationArtifact({
          matterId,
          exportId: result.exportId,
          suggestedName,
          openAfterSave,
        });
        if (saved.canceled) {
          setExportDeliveryMessage(
            "Save cancelled. The approved export remains ready.",
          );
        } else if (saved.openError) {
          setExportDeliveryMessage(
            `Saved to ${saved.filePath ?? suggestedName}, but macOS could not open it: ${saved.openError}`,
          );
        } else {
          setExportDeliveryMessage(
            saved.opened
              ? `Saved and opened ${saved.filePath ?? suggestedName}.`
              : `Saved ${saved.filePath ?? suggestedName}.`,
          );
        }
      } else {
        const blob = await fetchLitigationArtifactDownload(
          matterId,
          result.exportId,
        );
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = suggestedName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setExportDeliveryMessage(`Downloaded ${suggestedName}.`);
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Artifact delivery failed",
      );
    } finally {
      setSavingExportId(null);
    }
  }

  async function startLitigationRun() {
    setSaving(true);
    setError("");
    try {
      const run = await createLitigationDurableRun(matterId, {
        focus: boundRetrievalManifest ? undefined : agentFocus,
        retrievalManifestId: boundRetrievalManifest?.id,
      });
      setDurableRun(run);
      setRunIntegrity(await getAletheiaDurableRunIntegrity(run.id));
      await load();
    } catch (reason) {
      if (boundRetrievalManifest) {
        setBoundRetrievalManifest(null);
        try {
          setReviewedRetrievalManifest(
            await getLitigationRetrievalManifest(
              matterId,
              boundRetrievalManifest.id,
            ),
          );
        } catch {
          setReviewedRetrievalManifest(null);
          window.localStorage.removeItem(
            `vera:litigation-retrieval-manifest:${matterId}`,
          );
        }
      }
      setError(
        reason instanceof Error ? reason.message : "Run could not start",
      );
    } finally {
      setSaving(false);
    }
  }

  const acceptReviewedRetrievalManifest = useCallback(
    (next: LitigationRetrievalManifest | null) => {
      setReviewedRetrievalManifest(next);
      setBoundRetrievalManifest(null);
    },
    [],
  );

  async function bindReviewedRetrievalManifest() {
    if (!reviewedRetrievalManifest) return;
    setSaving(true);
    setError("");
    try {
      const current = await getLitigationRetrievalManifest(
        matterId,
        reviewedRetrievalManifest.id,
      );
      setReviewedRetrievalManifest(current);
      if (current.bindingEligibility?.eligible === true) {
        setBoundRetrievalManifest(current);
      } else {
        setBoundRetrievalManifest(null);
        setError(
          `Reviewed retrieval cannot be bound: ${
            current.bindingEligibility?.reason ??
            "Binding eligibility is unavailable."
          }`,
        );
      }
    } catch (reason) {
      setReviewedRetrievalManifest(null);
      setBoundRetrievalManifest(null);
      window.localStorage.removeItem(
        `vera:litigation-retrieval-manifest:${matterId}`,
      );
      setError(
        reason instanceof Error
          ? `Reviewed retrieval could not be bound: ${reason.message}`
          : "Reviewed retrieval could not be bound.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function cancelLitigationRun() {
    if (!durableRun) return;
    await runMutation(async () => {
      setDurableRun(await cancelAletheiaDurableRun(durableRun.id));
    });
  }

  async function requestAgentOutputReview() {
    if (!durableRun) return;
    await runMutation(() =>
      requestLitigationAgentOutputReview(matterId, durableRun.id),
    );
  }

  async function decideAgentOutputReview(
    reviewId: string,
    decision: "approved" | "rejected",
    comment: string,
  ) {
    await runMutation(() =>
      decideLitigationAgentOutputReview(matterId, reviewId, {
        decision,
        comment,
      }),
    );
  }

  async function reviewAgentFinding(
    stepId: string,
    findingIndex: number,
    assessment: "supported" | "partial" | "unsupported",
    reason: string,
  ) {
    if (!durableRun) return;
    await runMutation(() =>
      reviewLitigationAgentFinding(
        matterId,
        durableRun.id,
        stepId,
        findingIndex,
        { assessment, reason },
      ),
    );
  }

  async function runFindingSemanticCheck(stepId: string, findingIndex: number) {
    if (!durableRun) return;
    await runMutation(() =>
      runLitigationAgentFindingSemanticCheck(
        matterId,
        durableRun.id,
        stepId,
        findingIndex,
      ),
    );
  }

  async function startReviewedSynthesis() {
    if (!durableRun) return;
    await runMutation(async () => {
      const run = await createReviewedLitigationSynthesis(
        matterId,
        durableRun.id,
      );
      setDurableRun(run);
      setRunIntegrity(await getAletheiaDurableRunIntegrity(run.id));
    });
  }

  async function runEvalSuite() {
    await runMutation(async () => {
      await runLitigationEvalSuite(matterId);
    });
  }

  if (loading) {
    return (
      <AletheiaShell>
        <div className="grid min-h-full place-items-center text-sm text-gray-500">
          <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" /> 正在加载案件
        </div>
      </AletheiaShell>
    );
  }

  if (!matter || !workspace) {
    return (
      <AletheiaShell>
        <div className="mx-auto max-w-3xl px-8 py-12">
          <h1 className="text-xl font-semibold">案件暂不可用</h1>
          <p className="mt-2 text-sm text-red-600">
            {error || "未找到诉讼案件工作台。"}
          </p>
        </div>
      </AletheiaShell>
    );
  }

  const pdfDocumentIds = new Set(
    matter.documents
      .filter((document) => document.metadata.mimeType === "application/pdf")
      .map((document) => document.id),
  );

  const semanticModel =
    localModels.find((model) => model.id === selectedLitigationModelId) ?? null;
  const semanticEligibility = semanticCheckModelEligibility(semanticModel);

  const openPositionReviews = workspace.position_reviews.filter(
    (item) => item.status === "open",
  );
  const reviewCandidates = workspace.claims.filter(
    (claim) =>
      (claim.status === "confirmed" || claim.status === "rejected") &&
      !openPositionReviews.some((review) => review.claim_id === claim.id),
  );
  const selectedReviewClaim = workspace.claims.find(
    (claim) => claim.id === reviewClaimId,
  );
  const appealableReviews = workspace.position_reviews.filter((review) => {
    if (review.status !== "resolved" || review.review_level !== 1) return false;
    if (
      workspace.position_reviews.some(
        (candidate) => candidate.parent_review_id === review.id,
      )
    ) {
      return false;
    }
    const claim = workspace.claims.find((item) => item.id === review.claim_id);
    return claim?.status === "confirmed" || claim?.status === "rejected";
  });
  const openApprovals =
    workspace.facts.filter((item) => item.status === "proposed").length +
    workspace.claims.filter((item) => item.status === "proposed").length +
    workspace.elements.filter((item) => item.status === "proposed").length +
    workspace.procedural_events.filter((item) => item.status === "proposed")
      .length +
    workspace.deadlines.filter((item) => item.status === "proposed").length +
    openPositionReviews.length;
  const focusedDocumentId =
    focusResolution.status === "found" &&
    focusResolution.focus.type === "document"
      ? focusResolution.focus.id
      : null;
  const focusedFactId =
    focusResolution.status === "found" &&
    focusResolution.focus.type === "fact"
      ? focusResolution.focus.id
      : null;
  const focusedPositionId =
    focusResolution.status === "found" &&
    focusResolution.focus.type === "position"
      ? focusResolution.focus.id
      : null;
  const focusedDeadlineId =
    focusResolution.status === "found" &&
    focusResolution.focus.type === "deadline"
      ? focusResolution.focus.id
      : null;
  const focusedTaskId =
    focusResolution.status === "found" && focusResolution.focus.type === "task"
      ? focusResolution.focus.id
      : null;
  const focusedArtifact =
    focusResolution.status === "found" &&
    focusResolution.focus.type === "artifact" &&
    focusResolution.product &&
    focusResolution.currentProduct
      ? {
          matched: focusResolution.product,
          current: focusResolution.currentProduct,
        }
      : null;
  const showFocusRecovery =
    focusResolution.status === "missing" ||
    focusResolution.status === "mismatched";

  return (
    <AletheiaShell>
      <main className="min-w-0 flex-1 overflow-y-auto bg-white">
        <header className="border-b border-gray-200 bg-[#fcfcfd] px-5 pt-4 lg:px-8">
          <div className="mx-auto max-w-[1320px]">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 pb-4">
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
                  <Link
                    href="/aletheia/matters"
                    className="hover:text-gray-900"
                  >
                    案件
                  </Link>
                  <span aria-hidden="true">/</span>
                  <span>民商事诉讼</span>
                </div>
                <h1 className="mt-1 max-w-4xl text-[22px] font-semibold leading-7 text-gray-950">
                  {matter.matter.title}
                </h1>
                <p className="mt-1 max-w-4xl text-[13px] leading-5 text-gray-600">
                  {matter.matter.objective}
                </p>
              </div>
              <div className="flex w-full shrink-0 divide-x divide-gray-200 border-y border-gray-200 text-[11px] sm:w-auto">
                <div className="whitespace-nowrap px-3 py-2 text-gray-600">
                  <span className="font-semibold text-gray-900">
                    {matter.documents.length}
                  </span>{" "}
                  份案卷
                </div>
                <div
                  className={`whitespace-nowrap px-3 py-2 ${openApprovals ? "text-amber-700" : "text-gray-600"}`}
                >
                  <span className="font-semibold">{openApprovals}</span> 项待复核
                </div>
              </div>
            </div>
            <nav
              className="grid grid-cols-2 gap-x-2 sm:grid-cols-3 lg:grid-cols-6 xl:flex xl:gap-5"
              aria-label="案件主视图"
            >
              {views.map((view) => {
                const Icon = view.icon;
                const active = view.id === activeView;
                return (
                  <button
                    key={view.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      router.replace(
                        `/aletheia/matters/${matterId}/litigation?view=${view.id}`,
                      )
                    }
                    title={view.label}
                    className={`flex h-9 min-w-0 items-center gap-2 border-b-2 px-1 text-left text-[13px] xl:shrink-0 ${
                      active
                        ? "border-gray-950 font-medium text-gray-950"
                        : "border-transparent text-gray-500 hover:text-gray-900"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {view.label}
                  </button>
                );
              })}
            </nav>
          </div>
        </header>

        {error && (
          <div className="border-b border-red-200 bg-red-50 px-6 py-3 text-sm text-red-700 lg:px-10">
            {error}
          </div>
        )}

        {showFocusRecovery && (
          <div
            role="status"
            data-testid="object-focus-recovery"
            className="border-b border-gray-200 bg-gray-50 px-5 py-3 text-sm text-gray-700 lg:px-8"
          >
            <div className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-3">
              <span>未找到该对象，当前显示本模块最新状态</span>
              <button
                type="button"
                onClick={() =>
                  router.replace(
                    `/aletheia/matters/${matterId}/litigation?view=${activeView}`,
                  )
                }
                className="h-8 border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-100"
              >
                清除定位，留在当前模块
              </button>
            </div>
          </div>
        )}

        <div className="mx-auto max-w-[1320px] px-5 py-6 lg:px-8">
          {activeView === "overview" && (
            <Overview
              facts={workspace.facts}
              claims={workspace.claims}
              deadlines={workspace.deadlines}
              documents={matter.documents}
              positionReviews={workspace.position_reviews}
              matter={matter.matter}
              onNavigate={(view) =>
                router.replace(
                  `/aletheia/matters/${matterId}/litigation?view=${view}`,
                )
              }
            />
          )}

          {activeView === "facts" && (
            <div className="space-y-6">
              {focusedArtifact && (
                <FocusedArtifactSummary focus={focusedArtifact} />
              )}
              <div className="grid gap-6 xl:grid-cols-2">
                <MatterDocumentImporter matterId={matterId} onImported={load} />
                <MatterDocumentStatusList
                  matterId={matterId}
                  documents={matter.documents}
                  focusedDocumentId={focusedDocumentId}
                  onChanged={load}
                />
              </div>
              <ReviewedRetrievalPanel
                matterId={matterId}
                chunks={chunks}
                onManifestChange={acceptReviewedRetrievalManifest}
              />
              <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_340px]">
                <section className="min-w-0">
                  <SectionHeading
                    title="Fact timeline"
                    detail="Proposals remain separate from confirmed case state."
                  />
                  <div className="border-t border-gray-200">
                    <div className="hidden grid-cols-[132px_minmax(0,1fr)_148px_72px] gap-x-4 border-b border-gray-200 bg-gray-50/70 px-3 py-2 text-[11px] font-semibold uppercase text-gray-500 lg:grid">
                      <div>Date</div>
                      <div>Fact and source</div>
                      <div>Evidence state</div>
                      <div className="text-right">Decision</div>
                    </div>
                    {workspace.facts.length === 0 ? (
                      <EmptyState text="No fact proposals yet." />
                    ) : (
                      workspace.facts.map((fact) => (
                        <FactRow
                          key={fact.id}
                          matterId={matterId}
                          fact={fact}
                          source={workspace.fact_sources.find(
                            (item) => item.fact_id === fact.id,
                          )}
                          pdfDocumentIds={pdfDocumentIds}
                          focused={fact.id === focusedFactId}
                          saving={saving}
                          onDecision={(next) =>
                            void runMutation(() =>
                              decideLitigationFact(matterId, fact.id, next),
                            )
                          }
                          onVerify={recordSourceTextComparison}
                          onWithdraw={withdrawSourceTextComparison}
                        />
                      ))
                    )}
                  </div>
                </section>
                <Editor title="Add fact proposal" icon={Plus}>
                  <textarea
                    value={factStatement}
                    onChange={(event) => setFactStatement(event.target.value)}
                    placeholder="State one discrete fact."
                    className="min-h-28 w-full resize-y border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-500"
                  />
                  <input
                    type="datetime-local"
                    value={factDate}
                    onChange={(event) => setFactDate(event.target.value)}
                    className="h-10 w-full border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                  />
                  <SourceFields
                    chunks={chunks}
                    chunkId={sourceChunkId}
                    quote={sourceQuote}
                    onChunkId={setSourceChunkId}
                    onQuote={setSourceQuote}
                  />
                  <PrimaryAction
                    disabled={saving || !factStatement.trim()}
                    onClick={addFact}
                  >
                    Add proposal
                  </PrimaryAction>
                </Editor>
              </div>
            </div>
          )}

          {activeView === "positions" && (
            <div className="space-y-10">
              {focusedArtifact && (
                <FocusedArtifactSummary focus={focusedArtifact} />
              )}
              <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_340px]">
                <section className="min-w-0">
                  <SectionHeading
                    title="Claim and defense matrix"
                    detail="Map each legal element to supporting and contradicting facts; unlinked elements remain visible as evidence gaps."
                  />
                  <div className="border-t border-gray-200">
                    <div className="hidden grid-cols-[96px_minmax(0,1fr)_156px_72px] gap-x-4 border-b border-gray-200 bg-gray-50/70 px-3 py-2 text-[11px] font-semibold uppercase text-gray-500 lg:grid">
                      <div>Type</div>
                      <div>Position, authority and elements</div>
                      <div>Review state</div>
                      <div className="text-right">Decision</div>
                    </div>
                    {workspace.claims.length === 0 ? (
                      <EmptyState text="No claim or defense proposals yet." />
                    ) : (
                      workspace.claims.map((claim) => (
                        <ClaimMatrixRow
                          key={claim.id}
                          matterId={matterId}
                          claim={claim}
                          elements={workspace.elements.filter(
                            (item) => item.claim_id === claim.id,
                          )}
                          links={workspace.element_facts}
                          evidenceStatuses={workspace.element_evidence_statuses}
                          facts={workspace.facts}
                          factSources={workspace.fact_sources}
                          sources={workspace.claim_sources.filter(
                            (item) => item.claim_id === claim.id,
                          )}
                          pdfDocumentIds={pdfDocumentIds}
                          assessments={workspace.legal_assessments.filter(
                            (item) => item.claim_id === claim.id,
                          )}
                          authorityStatus={
                            workspace.position_authority_statuses.find(
                              (item) => item.claim_id === claim.id,
                            ) ?? {
                              claim_id: claim.id,
                              status: "missing",
                              valid_link_ids: [],
                              invalid_link_ids: [],
                            }
                          }
                          review={openPositionReviews.find(
                            (item) => item.claim_id === claim.id,
                          )}
                          reviews={workspace.position_reviews.filter(
                            (item) => item.claim_id === claim.id,
                          )}
                          focused={claim.id === focusedPositionId}
                          saving={saving}
                          onDecision={(next) =>
                            void runMutation(() =>
                              decideLitigationClaim(matterId, claim.id, next),
                            )
                          }
                          onVerify={recordSourceTextComparison}
                          onWithdraw={withdrawSourceTextComparison}
                          onElementDecision={(elementId, next) =>
                            void runMutation(() =>
                              decideLitigationClaimElement(
                                matterId,
                                elementId,
                                next,
                              ),
                            )
                          }
                        />
                      ))
                    )}
                  </div>
                </section>
                <aside className="min-w-0 border-t border-gray-200 pt-6 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
                  <EditorSection title="Add legal position" icon={Gavel}>
                    <select
                      value={claimKind}
                      onChange={(event) =>
                        setClaimKind(
                          event.target.value as LitigationClaimRecord["kind"],
                        )
                      }
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                    >
                      <option value="claim">Claim</option>
                      <option value="defense">Defense</option>
                      <option value="rebuttal">Rebuttal</option>
                    </select>
                    <textarea
                      value={claimTitle}
                      onChange={(event) => setClaimTitle(event.target.value)}
                      placeholder="Describe the position."
                      className="min-h-20 w-full border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-500"
                    />
                    <textarea
                      value={legalBasis}
                      onChange={(event) => setLegalBasis(event.target.value)}
                      placeholder="Legal basis or governing rule"
                      className="min-h-16 w-full border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-500"
                    />
                    <select
                      value={claimConfidence}
                      onChange={(event) =>
                        setClaimConfidence(
                          event.target.value as NonNullable<
                            LitigationClaimRecord["confidence"]
                          >,
                        )
                      }
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                      aria-label="Position confidence"
                    >
                      <option value="high">High confidence</option>
                      <option value="medium">Medium confidence</option>
                      <option value="low">Low confidence</option>
                    </select>
                    <textarea
                      value={claimUncertainty}
                      onChange={(event) =>
                        setClaimUncertainty(event.target.value)
                      }
                      placeholder="Material uncertainty or missing authority"
                      className="min-h-16 w-full border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-500"
                    />
                    <SourceFields
                      chunks={chunks}
                      chunkId={sourceChunkId}
                      quote={sourceQuote}
                      onChunkId={setSourceChunkId}
                      onQuote={setSourceQuote}
                    />
                    <PrimaryAction
                      disabled={saving || !claimTitle.trim()}
                      onClick={addClaim}
                    >
                      Add proposal
                    </PrimaryAction>
                  </EditorSection>
                  <EditorSection
                    title="Request decision review"
                    icon={MessageSquareWarning}
                    divided
                  >
                    <select
                      value={parentReviewId}
                      onChange={(event) => {
                        const parentId = event.target.value;
                        setParentReviewId(parentId);
                        if (!parentId) return;
                        const parent = appealableReviews.find(
                          (item) => item.id === parentId,
                        );
                        const claim = workspace.claims.find(
                          (item) => item.id === parent?.claim_id,
                        );
                        setReviewClaimId(parent?.claim_id ?? "");
                        setReviewKind("reconsideration");
                        setRequestedOutcome(
                          claim?.status === "confirmed"
                            ? "rejected"
                            : "confirmed",
                        );
                      }}
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                      aria-label="Review level"
                    >
                      <option value="">New first-level review</option>
                      {appealableReviews.map((review) => {
                        const claim = workspace.claims.find(
                          (item) => item.id === review.claim_id,
                        );
                        return (
                          <option key={review.id} value={review.id}>
                            Internal appeal: {claim?.title ?? review.claim_id}
                          </option>
                        );
                      })}
                    </select>
                    {parentReviewId && (
                      <p className="text-xs leading-5 text-gray-500">
                        Level 2 internal review. This local single-user decision
                        is not independently reviewed.
                      </p>
                    )}
                    <select
                      value={reviewClaimId}
                      disabled={Boolean(parentReviewId)}
                      onChange={(event) => {
                        const claimId = event.target.value;
                        const claim = workspace.claims.find(
                          (item) => item.id === claimId,
                        );
                        setReviewClaimId(claimId);
                        if (reviewKind === "withdrawal") {
                          setRequestedOutcome("withdrawn");
                        } else {
                          setRequestedOutcome(
                            claim?.status === "confirmed"
                              ? "rejected"
                              : "confirmed",
                          );
                        }
                      }}
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                      aria-label="Reviewed position"
                    >
                      <option value="">Choose a decided position</option>
                      {reviewCandidates.map((claim) => (
                        <option key={claim.id} value={claim.id}>
                          {claim.title}
                        </option>
                      ))}
                    </select>
                    <select
                      value={reviewKind}
                      disabled={Boolean(parentReviewId)}
                      onChange={(event) => {
                        const kind = event.target
                          .value as LitigationPositionReviewRecord["kind"];
                        setReviewKind(kind);
                        setRequestedOutcome(
                          kind === "withdrawal"
                            ? "withdrawn"
                            : selectedReviewClaim?.status === "confirmed"
                              ? "rejected"
                              : "confirmed",
                        );
                      }}
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                      aria-label="Review request type"
                    >
                      <option value="objection">Objection</option>
                      <option value="reconsideration">Reconsideration</option>
                      <option value="withdrawal">Withdrawal request</option>
                    </select>
                    <select
                      value={requestedOutcome}
                      onChange={(event) =>
                        setRequestedOutcome(
                          event.target
                            .value as LitigationPositionReviewRecord["requested_outcome"],
                        )
                      }
                      disabled={reviewKind === "withdrawal"}
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500 disabled:bg-gray-50"
                      aria-label="Requested outcome"
                    >
                      {reviewKind === "withdrawal" ? (
                        <option value="withdrawn">Withdraw position</option>
                      ) : selectedReviewClaim?.status === "confirmed" ? (
                        <option value="rejected">Change to rejected</option>
                      ) : (
                        <option value="confirmed">Change to confirmed</option>
                      )}
                    </select>
                    <textarea
                      value={reviewReason}
                      onChange={(event) => setReviewReason(event.target.value)}
                      placeholder="State the error, missing source, or changed circumstance."
                      className="min-h-20 w-full border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-500"
                    />
                    <PrimaryAction
                      disabled={
                        saving || !reviewClaimId || !reviewReason.trim()
                      }
                      onClick={submitPositionReview}
                    >
                      Submit review
                    </PrimaryAction>
                  </EditorSection>
                  {openPositionReviews.length > 0 && (
                    <EditorSection
                      title="Resolve open review"
                      icon={Gavel}
                      divided
                    >
                      <select
                        value={selectedReviewId}
                        onChange={(event) =>
                          setSelectedReviewId(event.target.value)
                        }
                        className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                        aria-label="Open position review"
                      >
                        <option value="">Choose an open review</option>
                        {openPositionReviews.map((review) => {
                          const claim = workspace.claims.find(
                            (item) => item.id === review.claim_id,
                          );
                          return (
                            <option key={review.id} value={review.id}>
                              {review.kind}: {claim?.title ?? review.claim_id}
                            </option>
                          );
                        })}
                      </select>
                      <select
                        value={reviewResolution}
                        onChange={(event) =>
                          setReviewResolution(
                            event.target.value as NonNullable<
                              LitigationPositionReviewRecord["resolution"]
                            >,
                          )
                        }
                        className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                        aria-label="Review resolution"
                      >
                        <option value="upheld">Uphold original decision</option>
                        <option value="granted">Grant requested outcome</option>
                        <option value="dismissed">Dismiss request</option>
                      </select>
                      <textarea
                        value={resolutionComment}
                        onChange={(event) =>
                          setResolutionComment(event.target.value)
                        }
                        placeholder="Record the reviewer’s reasons."
                        className="min-h-20 w-full border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-500"
                      />
                      <PrimaryAction
                        disabled={
                          saving ||
                          !selectedReviewId ||
                          !resolutionComment.trim()
                        }
                        onClick={resolvePositionReview}
                      >
                        Record resolution
                      </PrimaryAction>
                      <button
                        type="button"
                        disabled={saving || !selectedReviewId}
                        onClick={() => void withdrawPositionReview()}
                        className="h-9 border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                      >
                        Withdraw review request
                      </button>
                    </EditorSection>
                  )}
                  <EditorSection title="Add legal element" icon={Plus} divided>
                    <select
                      value={elementClaimId}
                      onChange={(event) =>
                        setElementClaimId(event.target.value)
                      }
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                    >
                      <option value="">Choose a position</option>
                      {workspace.claims
                        .filter((item) => item.status !== "rejected")
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                    </select>
                    <input
                      value={elementTitle}
                      onChange={(event) => setElementTitle(event.target.value)}
                      placeholder="Element name"
                      className="h-10 w-full border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                    />
                    <textarea
                      value={elementDescription}
                      onChange={(event) =>
                        setElementDescription(event.target.value)
                      }
                      placeholder="What must be established?"
                      className="min-h-16 w-full border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-500"
                    />
                    <PrimaryAction
                      disabled={
                        saving || !elementClaimId || !elementTitle.trim()
                      }
                      onClick={addElement}
                    >
                      Add element
                    </PrimaryAction>
                  </EditorSection>
                  <EditorSection
                    title="Link confirmed fact"
                    icon={Link2}
                    divided
                  >
                    <select
                      value={linkElementId}
                      onChange={(event) => setLinkElementId(event.target.value)}
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                    >
                      <option value="">Choose an element</option>
                      {workspace.elements.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                    <select
                      value={linkFactId}
                      onChange={(event) => setLinkFactId(event.target.value)}
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                    >
                      <option value="">Choose a confirmed fact</option>
                      {workspace.facts
                        .filter((item) => item.status === "confirmed")
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.statement}
                          </option>
                        ))}
                    </select>
                    <select
                      value={linkRelation}
                      onChange={(event) =>
                        setLinkRelation(
                          event.target.value as "supports" | "contradicts",
                        )
                      }
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                    >
                      <option value="supports">Supports</option>
                      <option value="contradicts">Contradicts</option>
                    </select>
                    <input
                      value={linkNote}
                      onChange={(event) => setLinkNote(event.target.value)}
                      placeholder="Optional analysis note"
                      className="h-10 w-full border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                    />
                    <PrimaryAction
                      disabled={saving || !linkElementId || !linkFactId}
                      onClick={addElementFact}
                    >
                      Link fact
                    </PrimaryAction>
                  </EditorSection>
                </aside>
              </div>
              <LegalAuthorityWorkspace
                matterId={matterId}
                claims={workspace.claims}
                positionAuthorityStatuses={
                  workspace.position_authority_statuses ?? []
                }
                registry={legalAuthorities}
                onDataChange={refreshAuthorityData}
              />
            </div>
          )}

          {activeView === "research" && (
            <LegalResearchWorkbench matterId={matterId} />
          )}

          {activeView === "procedure" && (
            <>
              {focusedArtifact && (
                <FocusedArtifactSummary focus={focusedArtifact} />
              )}
              <section>
                <SectionHeading
                  title="Procedural clock"
                  detail="Computed deadlines remain proposals requiring counsel confirmation."
                />
                {eventCorrectionResult && (
                  <div
                    data-testid="event-correction-result"
                    className="mb-4 border-l-2 border-emerald-600 bg-emerald-50/40 px-3 py-3 text-xs leading-5 text-gray-700"
                  >
                    <div className="font-semibold text-gray-950">
                      Correction recorded; replacement event selected for
                      recalculation.
                    </div>
                    <div>
                      {eventCorrectionResult.invalidatedDeadlines} deadline
                      {eventCorrectionResult.invalidatedDeadlines === 1
                        ? ""
                        : "s"}{" "}
                      marked stale · {eventCorrectionResult.invalidatedTasks}{" "}
                      task
                      {eventCorrectionResult.invalidatedTasks === 1
                        ? ""
                        : "s"}{" "}
                      invalidated
                    </div>
                    <div className="break-all font-mono text-[10px] text-gray-500">
                      Correction sha256 {eventCorrectionResult.correctionHash}
                    </div>
                    <div className="text-gray-600">
                      Recalculated deadlines remain proposals and require a
                      separate confirmation.
                    </div>
                  </div>
                )}
                <CourtCalendarWorkspace
                  matterId={matterId}
                  calendars={courtCalendars}
                  authorities={legalAuthorities.versions}
                  saving={saving}
                  onMutate={runMutation}
                />
                <DeadlineRuleWorkspace
                  matterId={matterId}
                  rules={deadlineRules}
                  calendars={courtCalendars}
                  authorities={legalAuthorities.versions}
                  events={workspace.procedural_events}
                  deadlines={workspace.deadlines}
                  saving={saving}
                  preferredEventId={preferredRuleEventId}
                  onMutate={runMutation}
                />
              </section>
              <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
                <section>
                  <div className="mb-3 text-xs font-semibold uppercase text-gray-500">
                    Triggering events
                  </div>
                  <div className="border-t border-gray-200">
                    {workspace.procedural_events.length === 0 ? (
                      <EmptyState text="No procedural event proposals yet." />
                    ) : (
                      workspace.procedural_events.map((item) => (
                        <ProceduralEventRow
                          key={item.id}
                          event={item}
                          correction={(
                            workspace.procedural_event_corrections ?? []
                          ).find(
                            (record) =>
                              record.original_event_id === item.id ||
                              record.replacement_event_id === item.id,
                          )}
                          chunks={chunks}
                          saving={saving}
                          onCorrect={(payload) =>
                            correctEvent(item.id, payload)
                          }
                          onDecision={(next) =>
                            void runMutation(() =>
                              decideLitigationProceduralEvent(
                                matterId,
                                item.id,
                                next,
                              ),
                            )
                          }
                        />
                      ))
                    )}
                  </div>
                  <div className="mb-3 mt-8 text-xs font-semibold uppercase text-gray-500">
                    Deadlines
                  </div>
                  <div className="border-t border-gray-200">
                    {workspace.deadlines.length === 0 ? (
                      <EmptyState text="No deadline candidates yet." />
                    ) : (
                      workspace.deadlines
                        .filter(
                          (deadline) => deadline.matter_id === matterId,
                        )
                        .map((deadline) => (
                        <DeadlineRow
                          key={deadline.id}
                          deadline={deadline}
                          saving={saving}
                          task={
                            matterTasks.find(
                              (task) => task.source_deadline_id === deadline.id,
                            ) ?? null
                          }
                          focusedTaskId={focusedTaskId}
                          focusedDeadlineId={focusedDeadlineId}
                          onDecision={(next) =>
                            void runMutation(() =>
                              decideLitigationDeadline(
                                matterId,
                                deadline.id,
                                next,
                              ),
                            )
                          }
                          onAddTask={() =>
                            void runMutation(() =>
                              createMatterTaskFromDeadline(
                                matterId,
                                deadline.id,
                              ),
                            )
                          }
                        />
                        ))
                    )}
                  </div>
                </section>
                <aside className="border-l border-gray-200 pl-6">
                  <EditorSection title="Add procedural event" icon={Plus}>
                    <select
                      aria-label="Procedural event type"
                      value={eventType}
                      onChange={(event) => setEventType(event.target.value)}
                      className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                    >
                      <option value="filing">Filing</option>
                      <option value="service">Service</option>
                      <option value="hearing_notice">Hearing notice</option>
                      <option value="hearing">Hearing</option>
                      <option value="judgment">Judgment</option>
                      <option value="other">Other</option>
                    </select>
                    <input
                      aria-label="Procedural event title"
                      value={eventTitle}
                      onChange={(event) => setEventTitle(event.target.value)}
                      placeholder="Event title"
                      className="h-10 w-full border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                    />
                    <input
                      aria-label="Procedural event date and time"
                      type="datetime-local"
                      value={eventAt}
                      onChange={(event) => setEventAt(event.target.value)}
                      className="h-10 w-full border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                    />
                    <SourceFields
                      chunks={chunks}
                      chunkId={sourceChunkId}
                      quote={sourceQuote}
                      onChunkId={setSourceChunkId}
                      onQuote={setSourceQuote}
                    />
                    <PrimaryAction
                      disabled={saving || !eventTitle.trim()}
                      onClick={addEvent}
                    >
                      Add event
                    </PrimaryAction>
                  </EditorSection>
                </aside>
              </div>
            </>
          )}

          {activeView === "artifacts" && (
            <>
              <section className="mb-8 border-b border-gray-200 pb-6">
                <SectionHeading
                  title="Bundle profile"
                  detail="Matter-specific naming and pagination rules. Changes invalidate existing hearing bundle outputs."
                />
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <input
                    value={bundleOrganization}
                    onChange={(event) =>
                      setBundleOrganization(event.target.value)
                    }
                    placeholder="Firm or organization"
                    className="h-10 border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                  />
                  <input
                    value={bundleCourt}
                    onChange={(event) => setBundleCourt(event.target.value)}
                    placeholder="Court"
                    className="h-10 border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                  />
                  <input
                    value={bundleCaseNumber}
                    onChange={(event) =>
                      setBundleCaseNumber(event.target.value)
                    }
                    placeholder="Case number"
                    className="h-10 border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                  />
                  <input
                    value={bundlePrefix}
                    onChange={(event) => setBundlePrefix(event.target.value)}
                    placeholder="Exhibit prefix"
                    aria-label="Exhibit prefix"
                    className="h-10 border border-gray-200 px-3 text-sm uppercase outline-none focus:border-gray-500"
                  />
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={bundleStart}
                    onChange={(event) => setBundleStart(event.target.value)}
                    aria-label="Exhibit start"
                    className="h-10 border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                  />
                  <select
                    value={bundlePaginationPolicy}
                    onChange={(event) =>
                      setBundlePaginationPolicy(
                        event.target.value as "auto" | "source_native",
                      )
                    }
                    aria-label="Bundle pagination policy"
                    className="h-10 border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                  >
                    <option value="auto">Map trusted source pages</option>
                    <option value="source_native">
                      Preserve source pages only
                    </option>
                  </select>
                  <select
                    value={documentTemplateKey}
                    onChange={(event) =>
                      setDocumentTemplateKey(event.target.value)
                    }
                    aria-label="Document template"
                    className="h-10 border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
                  >
                    {documentTemplates
                      .filter((template) => template.status === "approved")
                      .map((template) => (
                        <option
                          key={`${template.id}:${template.version}`}
                          value={`${template.id}:${template.version}`}
                        >
                          {template.name} · v{template.version}
                        </option>
                      ))}
                  </select>
                </div>
                <button
                  type="button"
                  disabled={
                    saving ||
                    !/^[A-Za-z0-9_-]{1,12}$/.test(bundlePrefix.trim()) ||
                    !Number.isSafeInteger(Number(bundleStart)) ||
                    Number(bundleStart) < 1 ||
                    Number(bundleStart) > 9999
                  }
                  onClick={() => void saveBundleProfile()}
                  className="mt-3 h-9 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                >
                  Save document and bundle profile
                </button>
                <div className="mt-6 border-t border-gray-200 pt-5">
                  <h3 className="text-sm font-semibold text-gray-950">
                    Firm templates
                  </h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <input
                      value={templateImportName}
                      onChange={(event) =>
                        setTemplateImportName(event.target.value)
                      }
                      placeholder="Template name"
                      aria-label="Template name"
                      className="h-10 border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                    />
                    <input
                      type="file"
                      accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      aria-label="DOCX template file"
                      onChange={(event) =>
                        setTemplateImportFile(event.target.files?.[0] ?? null)
                      }
                      className="h-10 border border-gray-200 px-2 py-1.5 text-sm file:mr-3 file:border-0 file:bg-transparent file:text-sm"
                    />
                    <button
                      type="button"
                      disabled={
                        saving ||
                        !templateImportFile ||
                        !templateImportName.trim()
                      }
                      onClick={() => void importDocumentTemplate()}
                      className="h-10 border border-gray-300 px-4 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Import draft
                    </button>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-gray-500">
                    DOCX only. Macros, external links, embedded objects and
                    unsupported fields are rejected before storage. Required
                    field: {"{aletheia_body}"}.
                  </p>
                  <div className="mt-4 divide-y divide-gray-200 border-y border-gray-200">
                    {documentTemplates
                      .filter((template) => template.source === "custom")
                      .map((template) => (
                        <div
                          key={`${template.id}:${template.version}`}
                          className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-950">
                              {template.name} · v{template.version}
                            </p>
                            <p className="mt-1 break-all text-xs text-gray-500">
                              {template.status} · {template.file_bytes ?? 0}{" "}
                              bytes · {template.placeholders?.join(", ")}
                            </p>
                          </div>
                          {template.status === "draft" ? (
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() =>
                                void requestTemplateApproval(template)
                              }
                              className="h-9 border border-gray-300 px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40"
                            >
                              Request review
                            </button>
                          ) : template.status === "approved" ? (
                            <div className="flex items-center justify-end gap-3 text-right text-xs">
                              <button
                                type="button"
                                disabled={
                                  saving ||
                                  documentTemplateKey ===
                                    `${template.id}:${template.version}`
                                }
                                onClick={() =>
                                  void requestTemplateRetirement(template)
                                }
                                className="h-9 border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                              >
                                {documentTemplateKey ===
                                `${template.id}:${template.version}`
                                  ? "In use"
                                  : "Request retirement"}
                              </button>
                              <div>
                                <span className="font-medium text-emerald-700">
                                  Approved
                                </span>
                                <p className="mt-1 text-gray-500">
                                  {template.independent_approval === 1
                                    ? "Independent review"
                                    : "Non-independent review"}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="text-right text-xs text-gray-500">
                              Retired · {template.retired_at?.slice(0, 10)}
                            </div>
                          )}
                        </div>
                      ))}
                    {!documentTemplates.some(
                      (template) => template.source === "custom",
                    ) ? (
                      <p className="py-4 text-sm text-gray-500">
                        No firm templates imported.
                      </p>
                    ) : null}
                  </div>
                  {templateApproval ? (
                    <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <textarea
                        value={templateReviewReason}
                        onChange={(event) =>
                          setTemplateReviewReason(event.target.value)
                        }
                        placeholder="Record why this template is safe and appropriate to publish."
                        aria-label="Template review reason"
                        className="min-h-20 border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-500"
                      />
                      <button
                        type="button"
                        disabled={
                          saving || templateReviewReason.trim().length < 10
                        }
                        onClick={() => void approveTemplateLifecycle()}
                        className="h-10 self-end bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                      >
                        {templateApproval.action === "publish"
                          ? "Approve and publish"
                          : "Approve retirement"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </section>
              <DocumentDraftWorkspace
                matterId={matterId}
                products={matter.workProducts.filter((item) =>
                  artifactKinds.some((artifact) => artifact.kind === item.kind),
                )}
              />
              <ArtifactWorkspace
                products={matter.workProducts.filter((item) =>
                  artifactKinds.some((artifact) => artifact.kind === item.kind),
                )}
                generatingKind={generatingKind}
                onGenerate={(kind) => void generateArtifact(kind)}
                approvals={artifactApprovals}
                exportResults={artifactExportResults}
                saving={saving}
                savingExportId={savingExportId}
                exportDeliveryMessage={exportDeliveryMessage}
                desktopClient={desktopClient}
                focusedArtifact={focusedArtifact}
                onRequestExport={(product) =>
                  void requestArtifactExport(product)
                }
                onVote={(product, decision) =>
                  void voteOnArtifactExport(product, decision)
                }
                onLocalDecision={(product, decision) =>
                  void decideLocalArtifactExport(product, decision)
                }
                onExport={(product) => void runArtifactExport(product)}
                onSaveExport={(product, result, openAfterSave) =>
                  void saveArtifactExport(product, result, openAfterSave)
                }
              />
              <LitigationAuditPackageWorkspace matterId={matterId} />
            </>
          )}

          {activeView === "agent" && (
            <LitigationHarness
              matterId={matterId}
              executorStatus={executorStatus}
              run={durableRun}
              integrity={runIntegrity}
              review={
                durableRun
                  ? ((workspace.agent_output_reviews ?? []).find(
                      (item) => item.run_id === durableRun.id,
                    ) ?? null)
                  : null
              }
              findingReviews={(workspace.agent_finding_reviews ?? []).filter(
                (item) => item.run_id === durableRun?.id,
              )}
              semanticChecks={(
                workspace.agent_finding_semantic_checks ?? []
              ).filter((item) => item.run_id === durableRun?.id)}
              semanticEligibility={semanticEligibility}
              saving={saving}
              focus={agentFocus}
              reviewedManifest={reviewedRetrievalManifest}
              boundManifest={boundRetrievalManifest}
              onFocusChange={setAgentFocus}
              onBindManifest={() => void bindReviewedRetrievalManifest()}
              onUnbindManifest={() => setBoundRetrievalManifest(null)}
              onStart={() => void startLitigationRun()}
              onCancel={() => void cancelLitigationRun()}
              onRequestReview={() => void requestAgentOutputReview()}
              onSynthesize={() => void startReviewedSynthesis()}
              onDecideReview={(reviewId, decision, comment) =>
                void decideAgentOutputReview(reviewId, decision, comment)
              }
              onReviewFinding={(stepId, findingIndex, assessment, reason) =>
                void reviewAgentFinding(
                  stepId,
                  findingIndex,
                  assessment,
                  reason,
                )
              }
              onSemanticCheck={(stepId, findingIndex) =>
                void runFindingSemanticCheck(stepId, findingIndex)
              }
            />
          )}

          {activeView === "evals" && (
            <LitigationEvalLab
              runs={evalRuns}
              saving={saving}
              onRun={() => void runEvalSuite()}
            />
          )}
        </div>
      </main>
    </AletheiaShell>
  );
}

function LitigationEvalLab({
  runs,
  saving,
  onRun,
}: {
  runs: LitigationEvalRun[];
  saving: boolean;
  onRun: () => void;
}) {
  const latest = runs[0];
  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeading
          title="Litigation Eval Lab"
          detail="Deterministic graders run pinned golden cases and bad cases against persisted matter state; no model judges its own output."
        />
        <PrimaryAction disabled={saving} onClick={onRun}>
          Run deterministic suite
        </PrimaryAction>
      </div>
      {!latest ? (
        <div className="border-y border-gray-200 py-10 text-sm text-gray-400">
          No evaluation run yet.
        </div>
      ) : (
        <div className="border-t border-gray-200">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-gray-200 py-5">
            <div>
              <div className="text-2xl font-semibold text-gray-950">
                {latest.passed}/{latest.total}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                {latest.suite_version} · {formatDate(latest.created_at)}
              </div>
            </div>
            <div
              className="max-w-full truncate font-mono text-[11px] text-gray-400"
              title={`sha256:${latest.result_hash}`}
            >
              sha256:{latest.result_hash}
            </div>
          </div>
          {latest.results.map((result) => (
            <article
              key={result.id}
              className="grid gap-3 border-b border-gray-200 py-4 md:grid-cols-[220px_100px_100px_minmax(0,1fr)]"
            >
              <div className="min-w-0">
                <div className="text-sm text-gray-900">
                  {result.case_id.replaceAll("_", " ")}
                </div>
                <div className="mt-1 text-xs text-gray-400">
                  {result.case_type}
                </div>
              </div>
              <div
                className={
                  result.passed
                    ? "text-xs text-emerald-700"
                    : "text-xs text-red-600"
                }
              >
                {result.passed ? "PASS" : "FAIL"}
              </div>
              <div className="text-xs text-gray-500">
                expected {String(result.expected)}
                <br />
                actual {String(result.actual)}
              </div>
              <div className="min-w-0 text-xs leading-5 text-gray-500">
                {result.grader_id} {result.grader_version}
                {result.evidence_refs.length > 0 && (
                  <div className="mt-1 truncate font-mono text-[11px] text-gray-400">
                    {result.evidence_refs.join(", ")}
                  </div>
                )}
              </div>
            </article>
          ))}
          {runs.length > 1 && (
            <div className="py-4 text-xs text-gray-500">
              {runs.length} persisted runs · latest result shown
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function semanticCitationAssessments(
  check: LitigationAgentFindingSemanticCheckRecord,
) {
  if (Array.isArray(check.citation_assessments)) {
    return check.citation_assessments;
  }
  if (typeof check.citation_assessments !== "string") return [];
  try {
    const parsed = JSON.parse(check.citation_assessments) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (
            item,
          ): item is {
            sourceId: string;
            assessment: "supported" | "partial" | "unsupported";
            rationale: string;
          } =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as Record<string, unknown>).sourceId === "string" &&
            typeof (item as Record<string, unknown>).rationale === "string" &&
            ["supported", "partial", "unsupported"].includes(
              String((item as Record<string, unknown>).assessment),
            ),
        )
      : [];
  } catch {
    return [];
  }
}

const semanticStaleReasonCopy: Record<string, string> = {
  run_changed: "The Agent run changed; run a new analysis and output review.",
  step_changed: "The Agent step changed; request advice on the current output.",
  finding_changed:
    "The finding changed; request advice on the current finding.",
  citation_set_changed:
    "The citation set changed; request advice on the current citations.",
  snapshot_changed:
    "Matter state changed; run a new analysis before relying on another check.",
  output_review_changed:
    "The output review is no longer open or no longer matches this check.",
  calibration_changed:
    "Model calibration changed; complete current calibration before rerunning.",
  benchmark_changed:
    "Model benchmark binding changed; run the current benchmark before rerunning.",
  current_state_unavailable:
    "Current binding state could not be verified; refresh before rerunning.",
};

function SemanticCheckHistory({
  checks,
}: {
  checks: LitigationAgentFindingSemanticCheckRecord[];
}) {
  if (checks.length === 0) return null;
  return (
    <div
      className="mt-3 border-t border-gray-200"
      aria-label="Semantic check history"
    >
      <div className="flex items-center justify-between gap-3 py-2 text-xs text-gray-500">
        <span className="font-medium text-gray-700">
          Immutable check history
        </span>
        <span>{checks.length} recorded</span>
      </div>
      {[...checks]
        .sort((a, b) => b.version - a.version)
        .map((check) => {
          const assessments = semanticCitationAssessments(check);
          const failed = check.status === "failed";
          return (
            <div
              key={check.id}
              data-testid={`semantic-check-${check.id}`}
              className="border-b border-gray-200 py-3 last:border-b-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div
                  className={`text-sm font-semibold ${
                    failed
                      ? "text-red-700"
                      : check.stale
                        ? "text-amber-800"
                        : "text-gray-900"
                  }`}
                >
                  {failed
                    ? "Failed"
                    : `Succeeded · Machine verdict: ${String(
                        check.derived_verdict,
                      ).replace("partial", "partially supported")}`}
                  {check.stale ? " · stale" : ""}
                </div>
                <div className="text-xs text-gray-500">
                  v{check.version} · {formatDate(check.created_at)} ·{" "}
                  {check.duration_ms} ms
                </div>
              </div>

              {failed ? (
                <div className="mt-2 text-sm leading-6 text-red-700">
                  <div>
                    {check.failure_detail ?? "The local model check failed."}
                  </div>
                  <div className="mt-1 text-xs">
                    {check.failure_code ?? "ENTAILMENT_FAILED"} · Verify the
                    model is returning the required strict JSON, then run the
                    check again.
                  </div>
                </div>
              ) : (
                <>
                  {assessments.length > 0 && (
                    <div className="mt-3 divide-y divide-gray-100 border-y border-gray-100">
                      {assessments.map((assessment) => (
                        <div
                          key={assessment.sourceId}
                          className="grid min-w-0 gap-1 py-2 text-xs sm:grid-cols-[minmax(120px,0.35fr)_minmax(0,1fr)] sm:gap-4"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-gray-800">
                              Citation {assessment.assessment}
                            </div>
                            <div
                              className="truncate font-mono text-[11px] text-gray-400"
                              title={assessment.sourceId}
                            >
                              {assessment.sourceId}
                            </div>
                          </div>
                          <div className="leading-5 text-gray-600">
                            {assessment.rationale}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {check.overall_rationale && (
                    <p className="mt-2 text-sm leading-6 text-gray-700">
                      {check.overall_rationale}
                    </p>
                  )}
                  <p className="mt-1 text-xs leading-5 text-gray-500">
                    Uncertainty: {check.uncertainty || "None stated."}
                  </p>
                </>
              )}

              {check.stale && check.stale_reasons.length > 0 && (
                <div className="mt-2 text-xs leading-5 text-amber-800">
                  {check.stale_reasons
                    .map((reason) => semanticStaleReasonCopy[reason] ?? reason)
                    .join(" ")}
                </div>
              )}

              <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 border-t border-gray-100 pt-3 text-[11px] sm:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-gray-400">Model revision</dt>
                  <dd
                    className="truncate font-mono text-gray-600"
                    title={`${check.model_id} · ${check.model_revision}`}
                  >
                    {check.model_id} · {shortIdentifier(check.model_revision)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-gray-400">Calibration binding</dt>
                  <dd
                    className="truncate font-mono text-gray-600"
                    title={`${check.calibration_id} · ${check.calibration_fingerprint}`}
                  >
                    {shortIdentifier(check.calibration_id)} ·{" "}
                    {shortIdentifier(check.calibration_fingerprint)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-gray-400">Benchmark binding</dt>
                  <dd
                    className="truncate font-mono text-gray-600"
                    title={`${check.benchmark_id} · ${check.benchmark_fingerprint}`}
                  >
                    {shortIdentifier(check.benchmark_id)} ·{" "}
                    {shortIdentifier(check.benchmark_fingerprint)}
                  </dd>
                </div>
              </dl>
              <details className="mt-3 text-[11px] text-gray-500">
                <summary className="w-fit cursor-pointer select-none font-medium text-gray-600">
                  Technical bindings
                </summary>
                <dl className="mt-2 grid min-w-0 gap-x-5 gap-y-2 border-t border-gray-100 pt-2 sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-gray-400">Protocol</dt>
                    <dd className="break-all font-mono">
                      {check.protocol_version}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-gray-400">Model fingerprint</dt>
                    <dd className="break-all font-mono">
                      {check.model_fingerprint}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-gray-400">Finding / citations</dt>
                    <dd className="break-all font-mono">
                      {check.finding_hash} / {check.citation_set_hash}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-gray-400">Snapshot / output review</dt>
                    <dd className="break-all font-mono">
                      {check.snapshot_hash} / {check.output_review_hash}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-gray-400">Prompt / output</dt>
                    <dd className="break-all font-mono">
                      {check.prompt_sha256} /{" "}
                      {check.output_sha256 ?? "no output"}
                    </dd>
                  </div>
                </dl>
              </details>
            </div>
          );
        })}
    </div>
  );
}

function FindingReviewControl({
  stepId,
  findingIndex,
  finding,
  current,
  disabled,
  semanticChecks,
  semanticEligibility,
  semanticDisabled,
  onReview,
  onSemanticCheck,
}: {
  stepId: string;
  findingIndex: number;
  finding: Record<string, unknown>;
  current: LitigationAgentFindingReviewRecord | null;
  disabled: boolean;
  semanticChecks: LitigationAgentFindingSemanticCheckRecord[];
  semanticEligibility: { eligible: boolean; reason: string | null };
  semanticDisabled: boolean;
  onReview: (
    stepId: string,
    findingIndex: number,
    assessment: "supported" | "partial" | "unsupported",
    reason: string,
  ) => void;
  onSemanticCheck: (stepId: string, findingIndex: number) => void;
}) {
  const [assessment, setAssessment] = useState<
    "" | "supported" | "partial" | "unsupported"
  >(current?.assessment ?? "");
  const [reason, setReason] = useState(current?.reason ?? "");
  const citations = Array.isArray(finding.citations)
    ? finding.citations.length
    : 0;
  return (
    <div
      data-testid={`agent-finding-review-${stepId}-${findingIndex}`}
      className="border-t border-gray-200 py-4 first:border-t-0"
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm leading-6 text-gray-900">
          {String(finding.statement ?? "Untitled finding")}
        </p>
        <span className="shrink-0 text-xs text-gray-500">
          {citations} {citations === 1 ? "citation" : "citations"}
        </span>
      </div>
      {current && (
        <div className="mt-2 text-xs text-gray-500">
          Current: {current.assessment} · v{current.version} · {current.reason}
        </div>
      )}
      <div className="mt-4 border-l-2 border-gray-300 pl-3 sm:pl-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-900">
              Local semantic check
            </div>
            <p className="mt-1 text-xs leading-5 text-gray-500">
              Model advisory, not independent verification. The same local model
              may grade its own output; this does not approve or prefill counsel
              review.
            </p>
          </div>
          <button
            type="button"
            disabled={semanticDisabled || !semanticEligibility.eligible}
            onClick={() => onSemanticCheck(stepId, findingIndex)}
            className="inline-flex h-9 shrink-0 items-center gap-2 border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            <ShieldCheck className="h-4 w-4" />
            Run check
          </button>
        </div>
        {!semanticEligibility.eligible && (
          <p className="mt-2 text-xs leading-5 text-gray-500">
            {semanticEligibility.reason}
          </p>
        )}
        <SemanticCheckHistory checks={semanticChecks} />
      </div>
      <div className="mt-4 text-xs font-medium text-gray-700">
        Counsel review
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_auto]">
        <select
          aria-label={`Finding ${findingIndex + 1} assessment`}
          value={assessment}
          disabled={disabled}
          onChange={(event) =>
            setAssessment(
              event.target.value as
                "" | "supported" | "partial" | "unsupported",
            )
          }
          className="h-10 border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-gray-500 disabled:opacity-50"
        >
          <option value="">Select assessment</option>
          <option value="supported">Supported</option>
          <option value="partial">Partially supported</option>
          <option value="unsupported">Unsupported</option>
        </select>
        <input
          aria-label={`Finding ${findingIndex + 1} review reason`}
          value={reason}
          disabled={disabled}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why the cited text does or does not support this finding"
          className="h-10 min-w-0 border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-gray-500 disabled:opacity-50"
        />
        <button
          type="button"
          disabled={disabled || !assessment || reason.trim().length < 10}
          onClick={() =>
            assessment &&
            onReview(stepId, findingIndex, assessment, reason.trim())
          }
          className="h-10 border border-gray-300 px-4 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          Save review
        </button>
      </div>
    </div>
  );
}

function LitigationHarness({
  matterId,
  executorStatus,
  run,
  integrity,
  review,
  findingReviews,
  semanticChecks,
  semanticEligibility,
  saving,
  focus,
  reviewedManifest,
  boundManifest,
  onFocusChange,
  onBindManifest,
  onUnbindManifest,
  onStart,
  onCancel,
  onRequestReview,
  onSynthesize,
  onDecideReview,
  onReviewFinding,
  onSemanticCheck,
}: {
  matterId: string;
  executorStatus: AletheiaDurableExecutorStatus | null;
  run: AletheiaDurableRun | null;
  integrity: AletheiaDurableRunIntegrity | null;
  review: LitigationAgentOutputReviewRecord | null;
  findingReviews: LitigationAgentFindingReviewRecord[];
  semanticChecks: LitigationAgentFindingSemanticCheckRecord[];
  semanticEligibility: { eligible: boolean; reason: string | null };
  saving: boolean;
  focus: string;
  reviewedManifest: LitigationRetrievalManifest | null;
  boundManifest: LitigationRetrievalManifest | null;
  onFocusChange: (value: string) => void;
  onBindManifest: () => void;
  onUnbindManifest: () => void;
  onStart: () => void;
  onCancel: () => void;
  onRequestReview: () => void;
  onSynthesize: () => void;
  onDecideReview: (
    reviewId: string,
    decision: "approved" | "rejected",
    comment: string,
  ) => void;
  onReviewFinding: (
    stepId: string,
    findingIndex: number,
    assessment: "supported" | "partial" | "unsupported",
    reason: string,
  ) => void;
  onSemanticCheck: (stepId: string, findingIndex: number) => void;
}) {
  const [reviewComment, setReviewComment] = useState("");
  const terminal = run
    ? ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)
    : false;
  const snapshotHash =
    typeof run?.metadata.snapshotHash === "string"
      ? run.metadata.snapshotHash
      : null;
  const statePolicy =
    typeof run?.metadata.statePolicy === "string"
      ? run.metadata.statePolicy
      : null;
  const exclusions =
    run?.metadata.exclusions &&
    typeof run.metadata.exclusions === "object" &&
    !Array.isArray(run.metadata.exclusions)
      ? (run.metadata.exclusions as Record<string, unknown>)
      : null;
  const executionMode =
    typeof run?.metadata.executionMode === "string"
      ? run.metadata.executionMode
      : "single_snapshot";
  const partitionCount = Number(run?.metadata.partitionCount ?? 1);
  const retrievalFocus =
    typeof run?.metadata.retrievalFocus === "string"
      ? run.metadata.retrievalFocus
      : null;
  const runRetrievalBinding =
    run?.metadata.retrievalInputBinding &&
    typeof run.metadata.retrievalInputBinding === "object" &&
    !Array.isArray(run.metadata.retrievalInputBinding)
      ? (run.metadata.retrievalInputBinding as Record<string, unknown>)
      : null;
  const boundExcerptIds = Array.isArray(
    runRetrievalBinding?.confirmedExcerptIds,
  )
    ? runRetrievalBinding.confirmedExcerptIds
    : [];
  const confirmedCount =
    reviewedManifest?.excerpts?.filter(
      (excerpt) => excerpt.status === "confirmed",
    ).length ?? 0;
  const bindingActive = Boolean(
    reviewedManifest?.bindingEligibility?.eligible === true &&
    boundManifest?.bindingEligibility?.eligible === true &&
    boundManifest.id === reviewedManifest.id &&
    boundManifest.bindingEligibility.bindingHash ===
      reviewedManifest.bindingEligibility.bindingHash,
  );
  const bindingEligible =
    reviewedManifest?.bindingEligibility?.eligible === true;
  const bindingIneligibilityReason =
    reviewedManifest?.bindingEligibility?.eligible === false
      ? reviewedManifest.bindingEligibility.reason
      : null;
  return (
    <section>
      <SectionHeading
        title="Litigation agent run"
        detail="A server-owned bounded workflow reads cited, confirmed matter state only; the client cannot submit handlers or alter the execution graph."
      />
      {!executorStatus?.enabled ? (
        <div className="border-y border-gray-200 py-6">
          <div className="text-sm font-medium text-gray-900">
            Local executor unavailable
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
            {executorStatus?.error ||
              executorStatus?.reason ||
              "Configure and health-check a local model in Settings before starting a durable run."}
          </p>
          <div className="mt-3 text-xs text-gray-400">
            No cloud fallback is used and no simulated run is created.
          </div>
        </div>
      ) : !run ? (
        <div className="border-y border-gray-200 py-6">
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900">
                Executor ready
              </div>
              <div className="mt-1 text-xs text-gray-500">
                Local model {executorStatus.modelId} · confirmed-state snapshot
                · bounded local steps
              </div>
              {bindingActive ? (
                <div className="mt-4 max-w-xl text-xs text-gray-500">
                  Analysis focus from reviewed manifest
                  <div className="mt-2 min-h-10 border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-900">
                    {boundManifest?.focus}
                  </div>
                </div>
              ) : (
                <label className="mt-4 block max-w-xl text-xs text-gray-500">
                  Analysis focus (optional; orders all source-bound items
                  without omitting any)
                  <input
                    value={focus}
                    maxLength={500}
                    onChange={(event) => onFocusChange(event.target.value)}
                    placeholder="e.g. payment due date, service, limitation period"
                    className="mt-2 h-10 w-full border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-gray-500"
                  />
                </label>
              )}
            </div>
            <div className="min-w-0 border-t border-gray-200 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <div className="text-sm font-medium text-gray-900">
                Reviewed retrieval input
              </div>
              {reviewedManifest ? (
                <>
                  <div className="mt-2 break-words text-sm text-gray-700">
                    {reviewedManifest.focus}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {reviewedManifest.candidateCount} candidates ·{" "}
                    {confirmedCount} confirmed
                  </div>
                  <label className="mt-4 flex items-start gap-2 text-sm text-gray-800">
                    <input
                      type="checkbox"
                      checked={bindingActive}
                      disabled={saving || !bindingEligible}
                      onChange={(event) =>
                        event.target.checked
                          ? onBindManifest()
                          : onUnbindManifest()
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 accent-gray-950"
                    />
                    <span>
                      Bind {confirmedCount} confirmed{" "}
                      {confirmedCount === 1 ? "excerpt" : "excerpts"} to this
                      run
                    </span>
                  </label>
                  <p className="mt-3 border-l-2 border-amber-500 pl-3 text-xs leading-5 text-amber-900">
                    Only confirmed excerpts are admitted. Withdrawn excerpts are
                    excluded.
                  </p>
                  {!bindingEligible && (
                    <p className="mt-2 text-xs text-gray-500">
                      {bindingIneligibilityReason ??
                        "Refresh the reviewed manifest before binding."}
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-sm leading-5 text-gray-500">
                  No current reviewed manifest. Retrieve and confirm excerpts in{" "}
                  <Link
                    href={`/aletheia/matters/${matterId}/litigation?view=facts`}
                    className="font-medium text-gray-900 underline underline-offset-2"
                  >
                    Facts &amp; Evidence
                  </Link>
                  .
                </p>
              )}
            </div>
            <div className="lg:col-span-2 lg:justify-self-end">
              <PrimaryAction disabled={saving} onClick={onStart}>
                Start case analysis
              </PrimaryAction>
            </div>
          </div>
        </div>
      ) : (
        <div className="border-t border-gray-200">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 py-5">
            <div>
              <div className="text-xs uppercase text-gray-500">
                {run.status}
              </div>
              <div className="mt-1 text-sm font-medium text-gray-900">
                {run.goal}
              </div>
              <div className="mt-2 text-xs text-gray-500">
                Attempt {run.attempt_count} · deadline{" "}
                {formatDate(run.deadline_at)}
              </div>
              {statePolicy && (
                <div className="mt-2 text-xs text-gray-500">
                  Input policy {statePolicy.replaceAll("_", " ")}
                </div>
              )}
              {executionMode === "source_partitioned" && (
                <div className="mt-1 text-xs text-gray-500">
                  Source-partitioned execution · {partitionCount} bounded
                  partitions · no automatic whole-matter synthesis
                </div>
              )}
              {retrievalFocus && (
                <div className="mt-1 text-xs text-gray-500">
                  Ordering focus: {retrievalFocus} · deterministic lexical score
                  · all source-bound items retained
                </div>
              )}
              {runRetrievalBinding && (
                <div className="mt-1 text-xs font-medium text-emerald-700">
                  Reviewed input bound · {boundExcerptIds.length} confirmed{" "}
                  {boundExcerptIds.length === 1 ? "excerpt" : "excerpts"}
                </div>
              )}
              {exclusions && (
                <div className="mt-1 text-xs text-gray-500">
                  Excluded: {String(exclusions.uncitedFacts ?? 0)} uncited
                  facts, {String(exclusions.uncitedPositions ?? 0)} uncited
                  positions, {String(exclusions.openPositionReviews ?? 0)}{" "}
                  positions under review
                </div>
              )}
              {snapshotHash && (
                <div
                  className="mt-1 max-w-2xl truncate font-mono text-[11px] text-gray-400"
                  title={snapshotHash}
                >
                  snapshot {snapshotHash}
                </div>
              )}
            </div>
            {!terminal && (
              <button
                type="button"
                disabled={saving}
                onClick={onCancel}
                className="h-9 border border-gray-300 px-4 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                Cancel run
              </button>
            )}
          </div>
          {run.steps.map((step) => {
            const grounding =
              step.output.grounding &&
              typeof step.output.grounding === "object" &&
              !Array.isArray(step.output.grounding)
                ? (step.output.grounding as Record<string, unknown>)
                : null;
            const citedSourceIds = Array.isArray(grounding?.citedSourceIds)
              ? grounding.citedSourceIds
              : [];
            const findingCount = Number(grounding?.findingCount ?? 0);
            const structured =
              step.output.structuredOutput &&
              typeof step.output.structuredOutput === "object" &&
              !Array.isArray(step.output.structuredOutput)
                ? (step.output.structuredOutput as Record<string, unknown>)
                : null;
            const findings = Array.isArray(structured?.findings)
              ? structured.findings.filter(
                  (item): item is Record<string, unknown> =>
                    Boolean(item) && typeof item === "object",
                )
              : [];
            return (
              <article
                key={step.id}
                className="grid gap-3 border-b border-gray-200 py-5 lg:grid-cols-[220px_120px_minmax(0,1fr)]"
              >
                <div className="text-sm text-gray-900">{step.title}</div>
                <div
                  className={`text-xs uppercase ${proposalTone(step.status)}`}
                >
                  {step.status}
                </div>
                <div className="min-w-0 text-xs leading-5 text-gray-500">
                  {grounding?.verified === true && (
                    <div className="mb-2 text-emerald-700">
                      {grounding.exactQuotesVerified === true
                        ? "Citation IDs and exact quotes verified"
                        : "Citation IDs verified (legacy run)"}{" "}
                      · {findingCount}{" "}
                      {findingCount === 1 ? "finding" : "findings"} ·{" "}
                      {citedSourceIds.length}{" "}
                      {citedSourceIds.length === 1 ? "source" : "sources"}
                    </div>
                  )}
                  {step.error ||
                    (typeof step.output.text === "string"
                      ? step.output.text
                      : `Attempt ${step.attempt_count}`)}
                  {findings.length > 0 && review && (
                    <div className="mt-4 border-y border-gray-200">
                      {findings.map((finding, findingIndex) => {
                        const current = findingReviews
                          .filter(
                            (item) =>
                              item.step_id === step.id &&
                              item.finding_index === findingIndex,
                          )
                          .sort((a, b) => b.version - a.version)[0];
                        const findingSemanticChecks = semanticChecks.filter(
                          (item) =>
                            item.step_id === step.id &&
                            item.finding_index === findingIndex,
                        );
                        return (
                          <FindingReviewControl
                            key={`${step.id}:${findingIndex}`}
                            stepId={step.id}
                            findingIndex={findingIndex}
                            finding={finding}
                            current={current ?? null}
                            disabled={saving || review.status !== "open"}
                            semanticChecks={findingSemanticChecks}
                            semanticEligibility={semanticEligibility}
                            semanticDisabled={
                              saving || review.status !== "open"
                            }
                            onReview={onReviewFinding}
                            onSemanticCheck={onSemanticCheck}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          {run.status === "succeeded" && (
            <div className="border-b border-gray-200 py-5">
              {!review ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-gray-900">
                      Human legal review required
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      Execution succeeded, but no finding has been adopted as a
                      legal conclusion.
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={saving || integrity?.ok !== true}
                    onClick={onRequestReview}
                    className="h-9 bg-gray-950 px-4 text-sm text-white hover:bg-gray-800 disabled:opacity-40"
                  >
                    Submit for review
                  </button>
                </div>
              ) : review.status === "open" ? (
                <div>
                  <div className="text-sm font-medium text-gray-900">
                    Legal review open
                  </div>
                  <p className="mt-1 text-xs leading-5 text-gray-500">
                    Confirm whether the exact quotes support the findings. A
                    same-user decision is recorded as non-independent.
                  </p>
                  <textarea
                    value={reviewComment}
                    onChange={(event) => setReviewComment(event.target.value)}
                    placeholder="Review reason (10 characters minimum)"
                    className="mt-3 min-h-20 w-full border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-gray-500"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={saving || reviewComment.trim().length < 10}
                      onClick={() =>
                        onDecideReview(review.id, "approved", reviewComment)
                      }
                      className="h-9 bg-gray-950 px-4 text-sm text-white hover:bg-gray-800 disabled:opacity-40"
                    >
                      Adopt findings
                    </button>
                    <button
                      type="button"
                      disabled={saving || reviewComment.trim().length < 10}
                      onClick={() =>
                        onDecideReview(review.id, "rejected", reviewComment)
                      }
                      className="h-9 border border-gray-300 px-4 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Return findings
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-sm font-medium text-gray-900">
                    {review.status === "approved"
                      ? "Findings adopted after legal review"
                      : "Findings returned after legal review"}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {review.independent_review === 1
                      ? "Independent reviewer"
                      : "Non-independent review"}
                    {review.decided_by ? ` · ${review.decided_by}` : ""}
                  </div>
                  {review.decision_comment && (
                    <p className="mt-2 text-sm leading-6 text-gray-600">
                      {review.decision_comment}
                    </p>
                  )}
                  {review.status === "approved" &&
                    executionMode === "source_partitioned" && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={onSynthesize}
                        className="mt-3 h-9 bg-gray-950 px-4 text-sm text-white hover:bg-gray-800 disabled:opacity-40"
                      >
                        Prepare reviewed synthesis
                      </button>
                    )}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-4 py-4 text-xs text-gray-500">
            <span>{run.events.length} executor events</span>
            <span
              className={integrity?.ok ? "text-emerald-700" : "text-amber-700"}
            >
              Event chain {integrity?.ok ? "verified" : "pending verification"}
            </span>
            {integrity?.lastHash && (
              <span className="font-mono">{integrity.lastHash}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function documentDraftKindLabel(
  kind: LitigationDocumentDraftRecord["artifact_kind"],
) {
  return kind === "litigation_brief" ? "Litigation brief" : "Hearing plan";
}

function reviewTone(status: string) {
  if (status === "approved") return "text-emerald-700";
  if (status === "rejected") return "text-red-600";
  return "text-amber-700";
}

function DocumentDraftWorkspace({
  matterId,
  products,
}: {
  matterId: string;
  products: AletheiaWorkProductRecord[];
}) {
  const eligibleArtifacts = useMemo(
    () =>
      (["litigation_brief", "hearing_plan"] as const)
        .map(
          (kind) =>
            products
              .filter(
                (product) =>
                  product.kind === kind &&
                  !product.stale_at &&
                  Boolean(product.dependency_hash),
              )
              .sort((left, right) => right.version - left.version)[0],
        )
        .filter((product): product is AletheiaWorkProductRecord =>
          Boolean(product),
        ),
    [products],
  );
  const [drafts, setDrafts] = useState<LitigationDocumentDraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<LitigationDocumentDraftDetail | null>(
    null,
  );
  const [sourceArtifactId, setSourceArtifactId] = useState("");
  const [sections, setSections] = useState<LitigationDocumentDraftSection[]>(
    [],
  );
  const [changeSummary, setChangeSummary] = useState("");
  const [wordVersionId, setWordVersionId] = useState("");
  const [importDocument, setImportDocument] = useState<File | null>(null);
  const [importSummary, setImportSummary] = useState("");
  const [wordNotice, setWordNotice] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [reviewReason, setReviewReason] = useState("");
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [fromVersion, setFromVersion] = useState(1);
  const [toVersion, setToVersion] = useState(1);
  const [diff, setDiff] = useState<LitigationDocumentDraftDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingDrafts, setLoadingDrafts] = useState(true);
  const [panelError, setPanelError] = useState("");

  const latestVersion = detail?.versions.at(-1) ?? null;
  const editReviewBlocked = Boolean(
    !detail || detail.stale || detail.status === "withdrawn",
  );
  const withdrawalBlocked = Boolean(!detail || detail.status === "withdrawn");

  const applyDetail = useCallback((next: LitigationDocumentDraftDetail) => {
    const latest = next.versions.at(-1) ?? null;
    setDetail(next);
    setSections(latest?.sections.map((section) => ({ ...section })) ?? []);
    setChangeSummary("");
    setReviewReason("");
    setDiff(null);
    if (latest) {
      setWordVersionId(latest.id);
      setToVersion(latest.version);
      setFromVersion(Math.max(1, latest.version - 1));
    }
  }, []);

  const refreshDrafts = useCallback(async () => {
    const next = await listLitigationDocumentDrafts(matterId);
    setDrafts(next);
    setSelectedId((current) =>
      current && next.some((draft) => draft.id === current)
        ? current
        : (next[0]?.id ?? ""),
    );
    return next;
  }, [matterId]);

  useEffect(() => {
    let current = true;
    setLoadingDrafts(true);
    setPanelError("");
    void refreshDrafts()
      .catch((loadError: unknown) => {
        if (current) {
          setPanelError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load document drafts",
          );
        }
      })
      .finally(() => {
        if (current) setLoadingDrafts(false);
      });
    return () => {
      current = false;
    };
  }, [refreshDrafts]);

  useEffect(() => {
    setSourceArtifactId((current) =>
      current && eligibleArtifacts.some((artifact) => artifact.id === current)
        ? current
        : (eligibleArtifacts[0]?.id ?? ""),
    );
  }, [eligibleArtifacts]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setSections([]);
      return;
    }
    let current = true;
    setPanelError("");
    void getLitigationDocumentDraft(matterId, selectedId)
      .then((next) => {
        if (current) applyDetail(next);
      })
      .catch((loadError: unknown) => {
        if (current) {
          setPanelError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load document draft",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [applyDetail, matterId, selectedId]);

  async function mutate(action: () => Promise<LitigationDocumentDraftDetail>) {
    setBusy(true);
    setPanelError("");
    try {
      const next = await action();
      applyDetail(next);
      await refreshDrafts();
    } catch (mutationError) {
      setPanelError(
        mutationError instanceof Error
          ? mutationError.message
          : "Operation failed",
      );
      if (selectedId) {
        try {
          applyDetail(await getLitigationDocumentDraft(matterId, selectedId));
          await refreshDrafts();
        } catch {
          // Keep the authoritative mutation error visible if refresh also fails.
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function createDraft() {
    if (!sourceArtifactId) return;
    setBusy(true);
    setPanelError("");
    try {
      const created = await createLitigationDocumentDraft(
        matterId,
        sourceArtifactId,
      );
      setSelectedId(created.id);
      applyDetail(created);
      await refreshDrafts();
    } catch (createError) {
      setPanelError(
        createError instanceof Error
          ? createError.message
          : "Unable to create document draft",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveVersion() {
    if (!detail || !latestVersion) return;
    await mutate(() =>
      appendLitigationDocumentDraftVersion(matterId, detail.id, {
        baseVersion: latestVersion.version,
        changeSummary: changeSummary.trim(),
        sections,
      }),
    );
  }

  async function downloadWordVersion() {
    if (!detail || !wordVersionId) return;
    setBusy(true);
    setPanelError("");
    setWordNotice("");
    try {
      const exported = await exportLitigationDocumentDraftDocx(
        matterId,
        detail.id,
        wordVersionId,
      );
      const selectedVersion = detail.versions.find(
        (version) => version.id === wordVersionId,
      );
      const objectUrl = URL.createObjectURL(exported.blob);
      const anchor = window.document.createElement("a");
      anchor.href = objectUrl;
      anchor.download =
        exported.filename ??
        `vera-${detail.artifact_kind}-v${selectedVersion?.version ?? "draft"}.docx`;
      window.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setWordNotice(`Downloaded v${selectedVersion?.version ?? ""} DOCX.`);
    } catch (exportError) {
      setPanelError(
        exportError instanceof Error
          ? exportError.message
          : "Unable to export DOCX",
      );
    } finally {
      setBusy(false);
    }
  }

  async function importWordVersion() {
    if (!detail || !importDocument) return;
    setBusy(true);
    setPanelError("");
    setWordNotice("");
    try {
      const imported = await importLitigationDocumentDraftDocx(
        matterId,
        detail.id,
        importDocument,
        importSummary.trim(),
      );
      const next = await getLitigationDocumentDraft(matterId, detail.id);
      const importedVersion =
        next.versions.find(
          (version) => version.id === imported.current_version_id,
        ) ?? next.versions.at(-1);
      applyDetail(next);
      setImportDocument(null);
      setImportSummary("");
      setFileInputKey((current) => current + 1);
      setWordNotice(
        `Imported ${importDocument.name} as unreviewed v${importedVersion?.version ?? ""}.`,
      );
      await refreshDrafts();
    } catch (importError) {
      setPanelError(
        importError instanceof Error
          ? importError.message
          : "DOCX import was rejected",
      );
      try {
        applyDetail(await getLitigationDocumentDraft(matterId, detail.id));
        await refreshDrafts();
      } catch {
        // Preserve the import rejection if the history refresh also fails.
      }
    } finally {
      setBusy(false);
    }
  }

  async function loadDiff() {
    if (!detail) return;
    setBusy(true);
    setPanelError("");
    try {
      setDiff(
        await diffLitigationDocumentDraftVersions(
          matterId,
          detail.id,
          fromVersion,
          toVersion,
        ),
      );
    } catch (diffError) {
      setPanelError(
        diffError instanceof Error ? diffError.message : "Unable to load diff",
      );
    } finally {
      setBusy(false);
    }
  }

  async function review(decision: "approved" | "rejected") {
    if (!detail || !latestVersion) return;
    await mutate(() =>
      reviewLitigationDocumentDraftVersion(
        matterId,
        detail.id,
        latestVersion.id,
        { decision, reason: reviewReason.trim() },
      ),
    );
  }

  async function withdraw() {
    if (!detail) return;
    await mutate(() =>
      withdrawLitigationDocumentDraft(
        matterId,
        detail.id,
        withdrawalReason.trim(),
      ),
    );
  }

  function updateSection(
    sectionId: string,
    field: "heading" | "body",
    value: string,
  ) {
    setSections((current) =>
      current.map((section) =>
        section.id === sectionId ? { ...section, [field]: value } : section,
      ),
    );
  }

  return (
    <section
      className="mb-9 border-b border-gray-200 pb-8"
      data-testid="document-draft-workspace"
    >
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4">
        <SectionHeading
          title="Document drafts"
          detail="Counsel edits structured working text while source projections, provenance, and immutable version hashes remain server controlled."
        />
        <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-2 sm:flex-none">
          <select
            value={sourceArtifactId}
            onChange={(event) => setSourceArtifactId(event.target.value)}
            aria-label="Source artifact for document draft"
            className="h-9 min-w-0 flex-1 border border-gray-300 bg-white px-3 text-sm outline-none focus:border-gray-600 sm:w-56 sm:flex-none"
          >
            {eligibleArtifacts.length ? (
              eligibleArtifacts.map((artifact) => (
                <option key={artifact.id} value={artifact.id}>
                  {documentDraftKindLabel(
                    artifact.kind as LitigationDocumentDraftRecord["artifact_kind"],
                  )}{" "}
                  · source v{artifact.version}
                </option>
              ))
            ) : (
              <option value="">Generate a current brief or hearing plan</option>
            )}
          </select>
          <button
            type="button"
            disabled={busy || !sourceArtifactId}
            onClick={() => void createDraft()}
            className="inline-flex h-9 shrink-0 items-center gap-2 bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
            Create editable draft
          </button>
        </div>
      </div>

      {panelError && (
        <div
          className="mb-4 border-y border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
        >
          {panelError}
        </div>
      )}

      <div className="grid min-w-0 border-y border-gray-200 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-w-0 border-b border-gray-200 lg:border-r lg:border-b-0">
          <div className="flex items-center gap-2 px-3 py-3 text-xs font-semibold text-gray-500 uppercase">
            <History className="h-4 w-4" />
            Draft register
          </div>
          <div className="max-h-52 overflow-y-auto lg:max-h-none">
            {loadingDrafts ? (
              <div className="px-3 py-5 text-sm text-gray-500">
                Loading drafts…
              </div>
            ) : drafts.length ? (
              drafts.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  onClick={() => setSelectedId(draft.id)}
                  aria-pressed={selectedId === draft.id}
                  className={`block w-full border-t border-gray-100 px-3 py-3 text-left ${
                    selectedId === draft.id
                      ? "bg-gray-100 text-gray-950"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <span className="block text-sm font-medium">
                    {documentDraftKindLabel(draft.artifact_kind)}
                  </span>
                  <span className="mt-1 block text-xs text-gray-500">
                    {draft.status === "withdrawn"
                      ? "Withdrawn"
                      : draft.stale
                        ? "Stale · locked"
                        : "Active"}{" "}
                    · {formatDate(draft.updated_at)}
                  </span>
                </button>
              ))
            ) : (
              <div className="border-t border-gray-100 px-3 py-5 text-sm leading-6 text-gray-500">
                No editable drafts yet.
              </div>
            )}
          </div>
        </aside>

        <div className="min-w-0 lg:pl-6">
          {!detail || !latestVersion ? (
            <div className="grid min-h-56 place-items-center px-5 py-10 text-center text-sm text-gray-500">
              Select a draft or create one from the latest eligible server
              artifact.
            </div>
          ) : (
            <div
              className="min-w-0"
              data-testid={`document-draft-${detail.id}`}
            >
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-4 lg:px-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="text-base font-semibold text-gray-950">
                      {documentDraftKindLabel(detail.artifact_kind)} working
                      draft
                    </h3>
                    <span
                      className={`text-xs font-medium ${reviewTone(latestVersion.review_status)}`}
                    >
                      v{latestVersion.version} · {latestVersion.review_status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Immutable version created{" "}
                    {formatDate(latestVersion.created_at)}
                  </p>
                </div>
                <div className="max-w-full text-left text-[11px] text-gray-500 lg:max-w-[48%] lg:text-right">
                  <div
                    className="break-all font-mono"
                    title={latestVersion.content_hash}
                  >
                    Version hash {latestVersion.content_hash}
                  </div>
                </div>
              </header>

              {(detail.stale || detail.status === "withdrawn") && (
                <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 lg:px-0">
                  <strong className="font-semibold">
                    {detail.status === "withdrawn"
                      ? "Withdrawn"
                      : "Stale · editing and review locked"}
                  </strong>
                  <span className="ml-2">
                    {detail.status === "withdrawn"
                      ? detail.withdrawal_reason
                      : `${detail.stale_reasons.join(", ")}. Explicit withdrawal remains available.`}
                  </span>
                </div>
              )}

              <section
                className="border-b border-gray-200 px-4 py-4 lg:px-0"
                data-testid="document-word-roundtrip"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="text-sm font-semibold text-gray-950">
                    Edit in Word
                  </h4>
                  <span className="text-xs text-gray-500">
                    {editReviewBlocked
                      ? "Import locked · version downloads remain available"
                      : "Imported revisions remain unreviewed"}
                  </span>
                </div>
                <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-[112px_auto_minmax(150px,0.8fr)_minmax(220px,1.4fr)_auto] xl:items-end">
                  <label className="min-w-0 text-xs font-semibold text-gray-600">
                    Export version
                    <select
                      value={wordVersionId}
                      onChange={(event) => setWordVersionId(event.target.value)}
                      aria-label="Word export version"
                      className="mt-1 h-9 w-full border border-gray-300 bg-white px-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
                    >
                      {detail.versions.map((version) => (
                        <option key={version.id} value={version.id}>
                          v{version.version}
                          {version.id === detail.current_version_id
                            ? " · current"
                            : " · historical"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={busy || !wordVersionId}
                    onClick={() => void downloadWordVersion()}
                    className="inline-flex h-9 items-center justify-center gap-2 border border-gray-300 px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40"
                  >
                    <Download className="h-4 w-4" />
                    Download DOCX
                  </button>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-gray-600">
                      Revised document
                    </div>
                    <label
                      className={`mt-1 flex h-9 min-w-0 items-center gap-2 border px-3 text-sm ${
                        editReviewBlocked || busy
                          ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
                          : "cursor-pointer border-gray-300 text-gray-800 hover:bg-gray-50"
                      }`}
                    >
                      <FileUp className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">
                        {importDocument?.name ?? "Choose .docx"}
                      </span>
                      <input
                        key={fileInputKey}
                        type="file"
                        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        disabled={editReviewBlocked || busy}
                        onChange={(event) =>
                          setImportDocument(event.target.files?.[0] ?? null)
                        }
                        aria-label="Revised Word document"
                        className="sr-only"
                      />
                    </label>
                  </div>
                  <label className="min-w-0 text-xs font-semibold text-gray-600">
                    Change summary · 3–1000 characters
                    <input
                      value={importSummary}
                      maxLength={1000}
                      disabled={editReviewBlocked || busy}
                      onChange={(event) => setImportSummary(event.target.value)}
                      aria-label="Word import change summary"
                      placeholder="Summarize the Word revisions"
                      className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm font-normal outline-none focus:border-gray-600 disabled:bg-gray-50"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={
                      editReviewBlocked ||
                      busy ||
                      !importDocument ||
                      importSummary.trim().length < 3 ||
                      importSummary.trim().length > 1_000
                    }
                    onClick={() => void importWordVersion()}
                    className="inline-flex h-9 items-center justify-center gap-2 bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                  >
                    <FileUp className="h-4 w-4" />
                    Import new version
                  </button>
                </div>
                {wordNotice && (
                  <p className="mt-2 text-xs text-emerald-700" role="status">
                    {wordNotice}
                  </p>
                )}
              </section>

              <div className="grid min-w-0 gap-x-6 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="min-w-0 px-4 lg:px-0">
                  <div className="flex items-center justify-between gap-3 py-4">
                    <div>
                      <h4 className="text-sm font-semibold text-gray-950">
                        Counsel editing text
                      </h4>
                      <p className="mt-1 text-xs text-gray-500">
                        Stable section IDs are fixed. Saving creates a new
                        version; it never overwrites v{latestVersion.version}.
                      </p>
                    </div>
                  </div>
                  <div className="border-t border-gray-200">
                    {sections.map((section) => {
                      const sourceSection = section.id === "sources";
                      return (
                        <section
                          key={section.id}
                          className="border-b border-gray-200 py-4"
                        >
                          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                            <label
                              htmlFor={`draft-heading-${section.id}`}
                              className="text-xs font-semibold text-gray-700"
                            >
                              {sourceSection
                                ? "Read-only source projection"
                                : "Section heading"}
                            </label>
                            <code className="text-[11px] text-gray-400">
                              {section.id}
                            </code>
                          </div>
                          {sourceSection ? (
                            <>
                              <div className="text-sm font-medium text-gray-900">
                                {section.heading}
                              </div>
                              <pre className="mt-2 max-h-52 overflow-auto border-l-2 border-gray-300 pl-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-gray-600">
                                {section.body}
                              </pre>
                            </>
                          ) : (
                            <>
                              <input
                                id={`draft-heading-${section.id}`}
                                value={section.heading}
                                disabled={editReviewBlocked || busy}
                                onChange={(event) =>
                                  updateSection(
                                    section.id,
                                    "heading",
                                    event.target.value,
                                  )
                                }
                                className="h-9 w-full border border-gray-300 px-3 text-sm font-medium outline-none focus:border-gray-600 disabled:bg-gray-50 disabled:text-gray-500"
                              />
                              <textarea
                                value={section.body}
                                disabled={editReviewBlocked || busy}
                                onChange={(event) =>
                                  updateSection(
                                    section.id,
                                    "body",
                                    event.target.value,
                                  )
                                }
                                aria-label={`${section.heading} body`}
                                className="mt-2 min-h-32 w-full resize-y border border-gray-300 px-3 py-2 font-mono text-[13px] leading-6 outline-none focus:border-gray-600 disabled:bg-gray-50 disabled:text-gray-500"
                              />
                            </>
                          )}
                        </section>
                      );
                    })}
                  </div>
                  <div className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <label className="min-w-0 text-xs font-semibold text-gray-700">
                      Mandatory change summary
                      <input
                        value={changeSummary}
                        disabled={editReviewBlocked || busy}
                        onChange={(event) =>
                          setChangeSummary(event.target.value)
                        }
                        aria-label="Document version change summary"
                        placeholder="Describe the legal or factual revision"
                        className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm font-normal outline-none focus:border-gray-600 disabled:bg-gray-50"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={
                        editReviewBlocked ||
                        busy ||
                        changeSummary.trim().length < 3
                      }
                      onClick={() => void saveVersion()}
                      className="inline-flex h-10 items-center justify-center gap-2 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                    >
                      <Save className="h-4 w-4" />
                      Save new version
                    </button>
                  </div>
                </div>

                <aside className="min-w-0 border-t border-gray-200 px-4 py-4 xl:border-t-0 xl:border-l xl:px-5">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase">
                    Locked provenance
                  </h4>
                  <dl className="mt-3 space-y-3 text-xs">
                    <div>
                      <dt className="text-gray-400">Source artifact</dt>
                      <dd className="mt-1 break-all font-mono text-gray-700">
                        {detail.artifact_id}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Source content hash</dt>
                      <dd className="mt-1 break-all font-mono text-gray-700">
                        {detail.source_content_hash}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Dependency hash</dt>
                      <dd className="mt-1 break-all font-mono text-gray-700">
                        {detail.source_dependency_hash}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Version provenance</dt>
                      <dd className="mt-1 text-gray-700">
                        {latestVersion.provenance.source.replaceAll("_", " ")} ·{" "}
                        {latestVersion.created_by}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-5 border-t border-gray-200 pt-4">
                    <h4 className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase">
                      <ShieldCheck className="h-4 w-4" />
                      Review this hash
                    </h4>
                    {latestVersion.review_status === "unreviewed" ? (
                      <>
                        <textarea
                          value={reviewReason}
                          disabled={editReviewBlocked || busy}
                          onChange={(event) =>
                            setReviewReason(event.target.value)
                          }
                          aria-label="Document version review reason"
                          placeholder="Reason for approving or rejecting this immutable version"
                          className="mt-3 min-h-24 w-full border border-gray-300 px-3 py-2 text-sm leading-5 outline-none focus:border-gray-600 disabled:bg-gray-50"
                        />
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            disabled={
                              editReviewBlocked ||
                              busy ||
                              reviewReason.trim().length < 10
                            }
                            onClick={() => void review("approved")}
                            className="inline-flex h-9 items-center justify-center gap-2 bg-gray-950 px-3 text-sm text-white hover:bg-gray-800 disabled:opacity-40"
                          >
                            <Check className="h-4 w-4" /> Approve
                          </button>
                          <button
                            type="button"
                            disabled={
                              editReviewBlocked ||
                              busy ||
                              reviewReason.trim().length < 10
                            }
                            onClick={() => void review("rejected")}
                            className="inline-flex h-9 items-center justify-center gap-2 border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                          >
                            <X className="h-4 w-4" /> Reject
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="mt-3 text-sm leading-6 text-gray-600">
                        <div
                          className={`font-medium ${reviewTone(latestVersion.review_status)}`}
                        >
                          {latestVersion.review_status === "approved"
                            ? "Approved"
                            : "Rejected"}{" "}
                          for v{latestVersion.version}
                        </div>
                        <p>{latestVersion.review_reason}</p>
                        <p className="mt-1 text-xs text-gray-400">
                          {latestVersion.reviewed_by} ·{" "}
                          {formatDate(latestVersion.reviewed_at)}
                        </p>
                      </div>
                    )}
                  </div>

                  {detail.status === "active" && (
                    <div className="mt-5 border-t border-gray-200 pt-4">
                      <label className="text-xs font-semibold text-gray-500 uppercase">
                        Withdrawal reason
                        <textarea
                          value={withdrawalReason}
                          disabled={withdrawalBlocked || busy}
                          onChange={(event) =>
                            setWithdrawalReason(event.target.value)
                          }
                          aria-label="Document draft withdrawal reason"
                          className="mt-2 min-h-20 w-full border border-gray-300 px-3 py-2 text-sm font-normal normal-case outline-none focus:border-gray-600 disabled:bg-gray-50"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={
                          withdrawalBlocked ||
                          busy ||
                          withdrawalReason.trim().length < 3
                        }
                        onClick={() => void withdraw()}
                        className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 border border-red-300 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40"
                      >
                        <ArchiveX className="h-4 w-4" /> Withdraw draft
                      </button>
                    </div>
                  )}
                </aside>
              </div>

              <section
                className="border-t border-gray-200 px-4 py-5 lg:px-0"
                data-testid="document-import-history"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="text-sm font-semibold text-gray-950">
                    Word import history
                  </h4>
                  <span className="text-xs text-gray-500">
                    {detail.import_attempts.length} immutable attempt
                    {detail.import_attempts.length === 1 ? "" : "s"}
                  </span>
                </div>
                {detail.import_attempts.length === 0 ? (
                  <p className="mt-3 text-sm text-gray-500">
                    No imports recorded.
                  </p>
                ) : (
                  <div className="mt-3 border-b border-gray-200">
                    {detail.import_attempts.map((attempt) => {
                      const acceptedVersion = attempt.accepted_version_id
                        ? detail.versions.find(
                            (version) =>
                              version.id === attempt.accepted_version_id,
                          )
                        : null;
                      const trackedChangesFailure =
                        attempt.failure_code === "DOCX_TRACKED_CHANGES";
                      return (
                        <article
                          key={attempt.id}
                          className="grid min-w-0 gap-2 border-t border-gray-200 py-3 text-xs md:grid-cols-[minmax(0,1.2fr)_auto_minmax(0,1fr)]"
                          data-testid={`document-import-attempt-${attempt.id}`}
                        >
                          <div className="min-w-0">
                            <div className="break-words text-sm font-medium text-gray-900">
                              {attempt.original_filename}
                            </div>
                            <div className="mt-1 text-gray-500">
                              Base v{attempt.base_version ?? "?"} ·{" "}
                              {formatFileBytes(attempt.file_bytes)} ·{" "}
                              {formatDate(attempt.created_at)}
                            </div>
                          </div>
                          <div
                            className={
                              attempt.status === "accepted"
                                ? "font-semibold text-emerald-700"
                                : "font-semibold text-red-700"
                            }
                          >
                            {attempt.status === "accepted"
                              ? `Accepted as v${acceptedVersion?.version ?? "?"}`
                              : "Rejected"}
                          </div>
                          <div className="min-w-0 text-gray-600">
                            {attempt.failure_code ? (
                              <>
                                <div className="font-mono text-[11px] text-red-700">
                                  {attempt.failure_code}
                                </div>
                                <p className="mt-1 break-words leading-5">
                                  {attempt.failure_detail}
                                </p>
                                {trackedChangesFailure && (
                                  <p className="mt-1 font-medium text-red-700">
                                    Accept or reject all tracked changes in
                                    Word, then import again.
                                  </p>
                                )}
                              </>
                            ) : (
                              <div className="leading-5 text-gray-500">
                                Parser {attempt.parser_protocol}
                              </div>
                            )}
                            <div className="mt-1 break-words font-mono text-[11px] text-gray-400">
                              File {shortHash(attempt.file_sha256)}
                              {attempt.binding_hash
                                ? ` · Binding ${shortHash(attempt.binding_hash)}`
                                : ""}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>

              <div
                className="border-t border-gray-200 px-4 py-5 lg:px-0"
                data-testid="document-version-diff"
              >
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-950">
                        <GitCompareArrows className="h-4 w-4" /> Server section
                        diff
                      </h4>
                      {(diff?.document.stale ?? detail.stale) && (
                        <span className="text-xs font-medium text-amber-700">
                          Historical diff · source binding stale
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      Hashes and section status are computed by the backend.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-xs text-gray-500">
                      From
                      <select
                        value={fromVersion}
                        onChange={(event) =>
                          setFromVersion(Number(event.target.value))
                        }
                        aria-label="Diff from version"
                        className="ml-2 h-9 border border-gray-300 bg-white px-2 text-sm text-gray-800"
                      >
                        {detail.versions.map((version) => (
                          <option key={version.id} value={version.version}>
                            v{version.version}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-gray-500">
                      To
                      <select
                        value={toVersion}
                        onChange={(event) =>
                          setToVersion(Number(event.target.value))
                        }
                        aria-label="Diff to version"
                        className="ml-2 h-9 border border-gray-300 bg-white px-2 text-sm text-gray-800"
                      >
                        {detail.versions.map((version) => (
                          <option key={version.id} value={version.version}>
                            v{version.version}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy || fromVersion === toVersion}
                      onClick={() => void loadDiff()}
                      className="h-9 border border-gray-300 px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Compare
                    </button>
                  </div>
                </div>
                {diff && (
                  <div className="mt-4 border-t border-gray-200">
                    {diff.changes.length ? (
                      diff.changes.map((change) => (
                        <article
                          key={change.id}
                          className="border-b border-gray-200 py-4"
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <h5 className="text-sm font-medium text-gray-900">
                              {change.id}
                            </h5>
                            <span className="text-xs font-medium text-gray-500">
                              {change.status}
                            </span>
                          </div>
                          <div className="mt-3 grid min-w-0 gap-4 md:grid-cols-2">
                            <div className="min-w-0 border-l-2 border-red-200 pl-3">
                              <div className="text-xs font-semibold text-red-700">
                                v{diff.from_version} ·{" "}
                                {change.old_section?.heading ?? "Not present"}
                              </div>
                              <pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-gray-600">
                                {change.old_section?.body ?? ""}
                              </pre>
                            </div>
                            <div className="min-w-0 border-l-2 border-emerald-300 pl-3">
                              <div className="text-xs font-semibold text-emerald-700">
                                v{diff.to_version} ·{" "}
                                {change.new_section?.heading ?? "Not present"}
                              </div>
                              <pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-gray-600">
                                {change.new_section?.body ?? ""}
                              </pre>
                            </div>
                          </div>
                        </article>
                      ))
                    ) : (
                      <p className="py-4 text-sm text-gray-500">
                        No section changes between these versions.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FocusedArtifactSummary({
  focus,
}: {
  focus: {
    matched: AletheiaWorkProductRecord;
    current: AletheiaWorkProductRecord;
  };
}) {
  const presentation = artifactKinds.find(
    (item) => item.kind === focus.current.kind,
  );
  const historical = focus.matched.id !== focus.current.id;
  return (
    <article
      data-testid="focused-artifact-summary"
      data-object-focus-key={`artifact:${focus.current.id}`}
      tabIndex={-1}
      className="border border-gray-300 border-l-2 border-l-gray-900 bg-gray-50 px-4 py-3 outline-none"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium text-gray-950">
          {presentation?.label ?? focus.current.title}
        </h2>
        <span className="text-xs text-gray-500">
          {historical
            ? `搜索命中 v${focus.matched.version}，当前版本 v${focus.current.version}`
            : `当前版本 v${focus.current.version}`}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-gray-600">
        {historical
          ? "当前模块展示该类工作产品的最新版本；历史命中仅用于说明搜索来源。"
          : "已定位到当前案件中的工作产品。"}
      </p>
    </article>
  );
}

function ArtifactWorkspace({
  products,
  generatingKind,
  onGenerate,
  approvals,
  exportResults,
  saving,
  savingExportId,
  exportDeliveryMessage,
  desktopClient,
  focusedArtifact,
  onRequestExport,
  onVote,
  onLocalDecision,
  onExport,
  onSaveExport,
}: {
  products: AletheiaWorkProductRecord[];
  generatingKind: LitigationArtifactKind | null;
  onGenerate: (kind: LitigationArtifactKind) => void;
  approvals: Record<string, LitigationArtifactExportApprovalProjection>;
  exportResults: Record<string, LitigationArtifactExportResult>;
  saving: boolean;
  savingExportId: string | null;
  exportDeliveryMessage: string;
  desktopClient: boolean;
  focusedArtifact: {
    matched: AletheiaWorkProductRecord;
    current: AletheiaWorkProductRecord;
  } | null;
  onRequestExport: (product: AletheiaWorkProductRecord) => void;
  onVote: (
    product: AletheiaWorkProductRecord,
    decision: "approved" | "rejected",
  ) => void;
  onLocalDecision: (
    product: AletheiaWorkProductRecord,
    decision: "approved" | "rejected",
  ) => void;
  onExport: (product: AletheiaWorkProductRecord) => void;
  onSaveExport: (
    product: AletheiaWorkProductRecord,
    result: { exportId: string; format: "docx" | "zip" },
    openAfterSave: boolean,
  ) => void;
}) {
  return (
    <section>
      <SectionHeading
        title="Documents and hearing preparation"
        detail="Server-built work products use confirmed matter state and re-verify every cited source before generation."
      />
      <div className="border-t border-gray-200">
        {artifactKinds.map((artifact) => {
          const versions = products
            .filter((item) => item.kind === artifact.kind)
            .sort((left, right) => left.version - right.version);
          const latest = versions.at(-1);
          const previous = versions.at(-2);
          const changedSections = changedArtifactSections(previous, latest);
          const projection = latest ? approvals[latest.id] : undefined;
          const exportResult = latest ? exportResults[latest.id] : undefined;
          const exported = projection?.export ?? null;
          const downloadReference = exportResult
            ? {
                exportId: exportResult.exportId,
                format: (artifact.kind === "hearing_bundle_index"
                  ? "zip"
                  : "docx") as "docx" | "zip",
              }
            : exported
              ? {
                  exportId: exported.exportId,
                  format: (artifact.kind === "hearing_bundle_index"
                    ? "zip"
                    : "docx") as "docx" | "zip",
                }
              : null;
          const governanceApproved = projection?.independentApproval.required
            ? projection.governanceRequest?.status === "approved"
            : true;
          const canExport = Boolean(
            projection?.actor.canExport &&
            projection.checkpointStatus === "approved" &&
            governanceApproved &&
            !exported,
          );
          const sourceCount = Array.isArray(latest?.content.sources)
            ? latest.content.sources.length
            : 0;
          const bundlePagination =
            latest?.content.bundlePagination &&
            typeof latest.content.bundlePagination === "object"
              ? (latest.content.bundlePagination as {
                  mode?: string;
                  totalPages?: number | null;
                })
              : null;
          const unresolvedReviews = Number(
            latest?.content.unresolvedPositionReviews ?? 0,
          );
          const uncitedPositions = Array.isArray(
            latest?.content.uncitedLegalPositions,
          )
            ? latest.content.uncitedLegalPositions.length
            : 0;
          const legalPositionArtifact = [
            "claim_defense_matrix",
            "litigation_brief",
            "hearing_plan",
            "hearing_bundle_index",
          ].includes(artifact.kind);
          const exportBlocked = Boolean(
            latest &&
            legalPositionArtifact &&
            (unresolvedReviews > 0 ||
              uncitedPositions > 0 ||
              latest.validation_errors.length > 0),
          );
          const artifactIsFocused =
            Boolean(latest) && focusedArtifact?.current.id === latest?.id;
          return (
            <article
              key={artifact.kind}
              data-object-focus-key={latest ? `artifact:${latest.id}` : undefined}
              tabIndex={latest ? -1 : undefined}
              className={`grid gap-4 border-b border-l-2 border-b-gray-200 px-3 py-5 outline-none md:grid-cols-[minmax(0,1fr)_240px] ${
                artifactIsFocused
                  ? "border-l-gray-900 bg-gray-50"
                  : "border-l-transparent"
              }`}
            >
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-gray-950">
                  {artifact.label}
                </h3>
                <p className="mt-1 text-sm text-gray-500">{artifact.detail}</p>
                {artifactIsFocused && focusedArtifact && (
                  <p className="mt-2 text-xs font-medium text-gray-700">
                    {focusedArtifact.matched.id !== focusedArtifact.current.id
                      ? `搜索命中 v${focusedArtifact.matched.version}，当前版本 v${focusedArtifact.current.version}`
                      : `已定位当前版本 v${focusedArtifact.current.version}`}
                  </p>
                )}
                {latest ? (
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                    <span>v{latest.version}</span>
                    <span>{sourceCount} verified sources</span>
                    <span>
                      {latest.validation_errors.length} open validation items
                    </span>
                    <span>{formatDate(latest.created_at)}</span>
                    {latest.stale_at && (
                      <span className="text-red-600">Stale</span>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 text-xs text-gray-400">
                    Not generated
                  </div>
                )}
                {latest && (
                  <div
                    className="mt-2 max-w-full truncate font-mono text-[11px] text-gray-400"
                    title={latest.content_hash}
                  >
                    {latest.content_hash}
                  </div>
                )}
                {artifact.kind === "hearing_bundle_index" &&
                  bundlePagination && (
                    <p className="mt-2 text-xs leading-5 text-gray-500">
                      {bundlePagination.mode === "continuous_source_sequence"
                        ? `${bundlePagination.totalPages ?? 0} mapped source pages`
                        : "Source-native pagination; continuous page map unavailable"}
                    </p>
                  )}
                {latest && previous && (
                  <div className="mt-2 text-xs text-gray-500">
                    Compared with v{previous.version}:{" "}
                    {changedSections.length
                      ? changedSections.join(", ")
                      : "no material section changes"}
                  </div>
                )}
                {latest?.stale_at && (
                  <div className="mt-2 text-xs text-red-600">
                    Confirmed matter state changed. Regenerate before approval
                    or export.
                  </div>
                )}
                {latest && exportBlocked && (
                  <div className="mt-2 text-xs leading-5 text-amber-800">
                    Final export blocked:
                    {unresolvedReviews > 0
                      ? ` ${unresolvedReviews} open position ${unresolvedReviews === 1 ? "review" : "reviews"}.`
                      : ""}
                    {uncitedPositions > 0
                      ? ` ${uncitedPositions} confirmed legal ${uncitedPositions === 1 ? "position lacks" : "positions lack"} an exact source citation.`
                      : ""}
                    {latest.validation_errors.length > 0
                      ? ` ${latest.validation_errors.length} validation ${latest.validation_errors.length === 1 ? "item remains" : "items remain"}.`
                      : ""}
                  </div>
                )}
                {latest && projection && (
                  <div
                    className="mt-4 border-t border-gray-200 pt-3 text-xs text-gray-600"
                    data-testid={`artifact-approval-${latest.id}`}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-medium text-gray-900">
                        Export approval
                      </span>
                      <span
                        className={
                          projection.checkpointStatus === "approved"
                            ? "text-emerald-700"
                            : projection.checkpointStatus === "rejected" ||
                                projection.checkpointStatus === "stale" ||
                                projection.checkpointStatus === "ineligible"
                              ? "text-red-600"
                              : "text-gray-500"
                        }
                      >
                        {approvalStatusLabel(projection.checkpointStatus)}
                      </span>
                    </div>

                    {projection.independentApproval.required ? (
                      <>
                        {projection.governanceRequest ? (
                          <>
                            <dl className="mt-3 grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                              <div className="min-w-0">
                                <dt className="text-gray-400">Requester</dt>
                                <dd
                                  className="mt-0.5 break-all font-mono text-gray-700"
                                  title={
                                    projection.governanceRequest.requesterId
                                  }
                                >
                                  {shortIdentifier(
                                    projection.governanceRequest.requesterId,
                                  )}
                                </dd>
                              </div>
                              <div className="min-w-0">
                                <dt className="text-gray-400">
                                  Governance request
                                </dt>
                                <dd
                                  className="mt-0.5 break-all font-mono text-gray-700"
                                  title={projection.governanceRequest.id}
                                >
                                  {shortIdentifier(
                                    projection.governanceRequest.id,
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-gray-400">Approvals</dt>
                                <dd className="mt-0.5 text-gray-700">
                                  {`${projection.governanceRequest.approvedVotes} / ${projection.governanceRequest.requiredApprovals}`}
                                  {projection.governanceRequest.rejectedVotes
                                    ? ` · ${projection.governanceRequest.rejectedVotes} rejected`
                                    : ""}
                                </dd>
                              </div>
                            </dl>
                            <p className="mt-2 text-gray-500">
                              {projection.governanceRequest.requireDistinctRoles
                                ? "Approvals must come from distinct eligible roles."
                                : "Distinct roles are not required by this policy."}
                            </p>
                            {projection.governanceRequest.votes.length > 0 && (
                              <div className="mt-3 border-y border-gray-200">
                                {projection.governanceRequest.votes.map(
                                  (vote) => (
                                    <div
                                      key={`${vote.principalId}-${vote.createdAt}`}
                                      className="grid gap-1 border-b border-gray-100 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_100px] sm:items-baseline lg:grid-cols-[minmax(0,1fr)_100px_120px]"
                                    >
                                      <span
                                        className="min-w-0 break-all font-mono text-gray-700"
                                        title={vote.principalId}
                                      >
                                        {shortIdentifier(vote.principalId)} ·{" "}
                                        <span className="font-sans text-gray-500">
                                          {vote.role}
                                        </span>
                                      </span>
                                      <span
                                        className={
                                          vote.decision === "approved"
                                            ? "text-emerald-700"
                                            : "text-red-600"
                                        }
                                      >
                                        {vote.decision}
                                      </span>
                                      <span className="text-gray-400 sm:col-span-2 lg:col-span-1 lg:text-right">
                                        {formatDate(vote.createdAt)}
                                      </span>
                                      {vote.comment && (
                                        <span className="text-gray-500 sm:col-span-2 lg:col-span-3">
                                          {vote.comment}
                                        </span>
                                      )}
                                    </div>
                                  ),
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="mt-2 text-gray-500">
                            Independent approval has not been requested.
                          </p>
                        )}
                        <p className="mt-2 text-gray-500">
                          Independent approval:{" "}
                          <span className="text-gray-700">
                            {approvalStatusLabel(
                              projection.independentApproval.status,
                            )}
                          </span>
                          {projection.independentApproval.approvedBy.length > 0
                            ? ` · ${projection.independentApproval.approvedBy.map(shortIdentifier).join(", ")}`
                            : ""}
                        </p>
                      </>
                    ) : (
                      <div className="mt-2">
                        <p className="font-medium text-gray-800">
                          Non-independent local approval
                        </p>
                        <p className="mt-1 leading-5 text-gray-500">
                          This local decision does not provide dual control.{" "}
                          Status:{" "}
                          {approvalStatusLabel(
                            projection.independentApproval.status,
                          )}
                          .
                        </p>
                      </div>
                    )}

                    {!projection.actor.canVote &&
                      projection.independentApproval.required &&
                      projection.actor.voteBlockReason &&
                      projection.actor.voteBlockReason !==
                        "approval_not_requested" && (
                        <p className="mt-2 leading-5 text-gray-500">
                          {
                            voteBlockReasonCopy[
                              projection.actor.voteBlockReason
                            ]
                          }
                        </p>
                      )}

                    {exported && (
                      <p className="mt-3 border-t border-gray-200 pt-3 text-emerald-700">
                        Exported by{" "}
                        <span title={exported.exportedBy}>
                          {shortIdentifier(exported.exportedBy)}
                        </span>{" "}
                        · {formatDate(exported.exportedAt)}
                      </p>
                    )}
                  </div>
                )}
                {latest && (
                  <details className="mt-3 text-xs text-gray-600">
                    <summary className="cursor-pointer select-none text-gray-500">
                      Inspect latest structured output
                    </summary>
                    <pre className="mt-3 max-h-72 overflow-auto border-l-2 border-gray-200 pl-3 font-mono text-[11px] leading-5 whitespace-pre-wrap">
                      {JSON.stringify(latest.content, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
              <div className="flex flex-col items-start gap-2 md:items-end">
                <button
                  type="button"
                  disabled={generatingKind !== null}
                  onClick={() => onGenerate(artifact.kind)}
                  className="h-9 border border-gray-300 bg-white px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-40"
                >
                  {generatingKind === artifact.kind
                    ? "Generating…"
                    : latest?.stale_at
                      ? "Regenerate"
                      : latest
                        ? "Create new version"
                        : "Generate"}
                </button>
                {latest &&
                  !latest.stale_at &&
                  !exportBlocked &&
                  projection?.checkpointStatus === "not_requested" && (
                    <button
                      type="button"
                      disabled={generatingKind !== null || saving}
                      onClick={() => onRequestExport(latest)}
                      className="h-9 px-2 text-sm text-gray-600 hover:text-gray-950 disabled:opacity-40"
                    >
                      Request export approval
                    </button>
                  )}
                {latest &&
                  !latest.stale_at &&
                  !exportBlocked &&
                  projection?.checkpointStatus === "open" &&
                  projection.independentApproval.required &&
                  projection.actor.canVote && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => onVote(latest, "approved")}
                        className="inline-flex h-9 items-center gap-2 whitespace-nowrap bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => onVote(latest, "rejected")}
                        className="inline-flex h-9 items-center gap-2 whitespace-nowrap border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40"
                      >
                        <X className="h-4 w-4" />
                        Reject
                      </button>
                    </div>
                  )}
                {latest &&
                  !latest.stale_at &&
                  !exportBlocked &&
                  projection?.checkpointStatus === "open" &&
                  !projection.independentApproval.required && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => onLocalDecision(latest, "approved")}
                        className="inline-flex h-9 items-center gap-2 whitespace-nowrap bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                        Approve locally
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => onLocalDecision(latest, "rejected")}
                        className="inline-flex h-9 items-center gap-2 whitespace-nowrap border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40"
                      >
                        <X className="h-4 w-4" />
                        Reject
                      </button>
                    </div>
                  )}
                {latest && !latest.stale_at && !exportBlocked && canExport && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => onExport(latest)}
                    className="h-9 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                  >
                    {artifact.kind === "hearing_bundle_index"
                      ? "Export approved bundle"
                      : "Export approved DOCX"}
                  </button>
                )}
                {exported &&
                  latest &&
                  downloadReference &&
                  projection?.actor.canExport && (
                    <>
                      <div className="text-right text-xs text-emerald-700">
                        {downloadReference.format === "zip"
                          ? "Exported bundle ready"
                          : "Exported DOCX ready"}
                      </div>
                      <button
                        type="button"
                        disabled={savingExportId === downloadReference.exportId}
                        onClick={() =>
                          onSaveExport(latest, downloadReference, false)
                        }
                        className="h-9 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                      >
                        {savingExportId === downloadReference.exportId
                          ? "Saving…"
                          : downloadReference.format === "zip"
                            ? "Save bundle"
                            : "Save DOCX"}
                      </button>
                      {desktopClient && (
                        <button
                          type="button"
                          disabled={
                            savingExportId === downloadReference.exportId
                          }
                          onClick={() =>
                            onSaveExport(latest, downloadReference, true)
                          }
                          className="h-9 px-2 text-sm text-gray-600 hover:text-gray-950 disabled:opacity-40"
                        >
                          Save and open
                        </button>
                      )}
                      {exportResult && exportDeliveryMessage && (
                        <p className="max-w-64 text-right text-xs leading-5 text-gray-500">
                          {exportDeliveryMessage}
                        </p>
                      )}
                    </>
                  )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

const auditChecklistLabels: Record<string, string> = {
  confirmed_facts_have_exact_sources: "Confirmed facts have exact sources",
  confirmed_positions_have_sources_and_authority:
    "Confirmed positions have sources and authority",
  human_reviews_resolved: "Human reviews are resolved",
  procedural_events_source_bound: "Procedural events are source-bound",
  confirmed_deadlines_current: "Confirmed deadlines are current",
  required_artifacts_current: "Five required artifacts are current",
  active_document_drafts_reviewed: "Active document drafts are reviewed",
  matter_audit_chain_valid: "Matter audit chain is valid",
};

function AuditStatusMark({
  status,
}: {
  status: "satisfied" | "action_required" | "not_applicable";
}) {
  if (status === "satisfied") {
    return <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />;
  }
  if (status === "action_required") {
    return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />;
  }
  return <span className="mt-2 h-1.5 w-1.5 shrink-0 bg-gray-300" />;
}

function AuditHash({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-gray-500">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(value)}
          className="grid h-6 w-6 shrink-0 place-items-center text-gray-400 hover:bg-gray-100 hover:text-gray-800"
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="break-all font-mono text-[10px] leading-4 text-gray-600">
        {value}
      </div>
    </div>
  );
}

function AuditSignoffAnchor({
  matterId,
  exportId,
  signoffId,
}: {
  matterId: string;
  exportId: string;
  signoffId: string;
}) {
  const [proof, setProof] = useState<LitigationSignoffAnchorProof | null>(null);
  const [loading, setLoading] = useState(true);
  const [anchoring, setAnchoring] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [actionError, setActionError] = useState("");

  const loadProof = useCallback(async () => {
    setLoading(true);
    try {
      setProof(
        await getLitigationMatterAuditSignoffAnchorProof(
          matterId,
          exportId,
          signoffId,
        ),
      );
    } catch (reason) {
      setProof(null);
      setActionError(
        reason instanceof Error
          ? `Verification failed: ${reason.message}`
          : "Verification failed: anchor proof could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [exportId, matterId, signoffId]);

  useEffect(() => {
    void loadProof();
  }, [loadProof]);

  const coverageVerified = Boolean(proof?.anchored && proof.coverage);
  const status = loading
    ? "Checking external anchor"
    : !proof
      ? "Verification failed"
      : !proof.configured
        ? "External anchor not configured"
        : coverageVerified
          ? "Exact audit-head coverage verified"
          : proof.anchored
            ? "Verification failed"
            : "Not anchored";
  const statusTone = coverageVerified
    ? "text-emerald-800"
    : status === "Verification failed"
      ? "text-red-700"
      : "text-amber-800";
  const canAnchor = Boolean(proof?.can_anchor && !forbidden);

  async function anchorReceipt() {
    if (!canAnchor || anchoring) return;
    setAnchoring(true);
    setActionError("");
    try {
      setProof(
        await anchorLitigationMatterAuditSignoff(matterId, exportId, signoffId),
      );
    } catch (reason) {
      if (reason instanceof AletheiaApiError && reason.status === 403) {
        setForbidden(true);
        setActionError(
          "Administrator permission required. This receipt was not anchored.",
        );
      } else if (reason instanceof AletheiaApiError && reason.status === 409) {
        setActionError(
          "Matter audit head advanced. Direct anchoring is no longer allowed for this receipt.",
        );
        await loadProof();
      } else {
        setActionError(
          reason instanceof Error
            ? `Verification failed: ${reason.message}`
            : "Verification failed: the anchor operation did not complete.",
        );
      }
    } finally {
      setAnchoring(false);
    }
  }

  return (
    <div
      data-testid={`audit-signoff-anchor-${signoffId}`}
      className="min-w-0 border-t border-gray-200 pt-3 sm:col-span-2"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase text-gray-500">
            External audit anchor
          </div>
          <div className={`mt-1 text-sm font-semibold ${statusTone}`}>
            {status}
          </div>
        </div>
        {canAnchor ? (
          <button
            type="button"
            onClick={() => void anchorReceipt()}
            disabled={anchoring}
            className="inline-flex min-h-9 items-center gap-2 border border-gray-400 px-3 text-xs font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-40"
          >
            {anchoring ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Anchor exact audit head (admin)
          </button>
        ) : null}
      </div>

      {proof?.coverage ? (
        <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-gray-500">Anchor index</dt>
            <dd className="mt-1 font-mono text-gray-900">
              {proof.coverage.anchor_index}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-gray-500">Ed25519 key_id</dt>
            <dd className="mt-1 break-all font-mono text-[10px] leading-4 text-gray-700">
              {proof.coverage.key_id}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Anchored at</dt>
            <dd className="mt-1 text-gray-900">
              {formatDate(proof.coverage.anchored_at)}
            </dd>
          </div>
          <div className="min-w-0 sm:col-span-2 lg:col-span-1">
            <AuditHash label="Anchor hash" value={proof.coverage.anchor_hash} />
          </div>
        </dl>
      ) : null}

      {actionError ? (
        <p role="alert" className="mt-2 text-xs leading-5 text-red-700">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}

function LitigationAuditPackageWorkspace({ matterId }: { matterId: string }) {
  const [preview, setPreview] =
    useState<LitigationMatterAuditExportPreview | null>(null);
  const [exports, setExports] = useState<LitigationMatterAuditExportSummary[]>(
    [],
  );
  const [selectedExportId, setSelectedExportId] = useState("");
  const [selectedPackage, setSelectedPackage] =
    useState<LitigationMatterAuditExportPackage | null>(null);
  const [signoffs, setSignoffs] = useState<
    LitigationMatterAuditExportSignoff[]
  >([]);
  const [checkpoint, setCheckpoint] =
    useState<AletheiaHumanCheckpointRecord | null>(null);
  const [signerName, setSignerName] = useState("");
  const [professionalIdentifier, setProfessionalIdentifier] = useState("");
  const [reviewComment, setReviewComment] = useState("");
  const [attestationAccepted, setAttestationAccepted] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [panelError, setPanelError] = useState("");
  const [integrityFailure, setIntegrityFailure] = useState(false);
  const [notice, setNotice] = useState("");

  const refreshAudit = useCallback(
    async (preferredExportId?: string) => {
      setLoadingAudit(true);
      setPanelError("");
      setIntegrityFailure(false);
      try {
        const [nextPreview, nextExports] = await Promise.all([
          getLitigationMatterAuditExportPreview(matterId),
          listLitigationMatterAuditExports(matterId),
        ]);
        setPreview(nextPreview);
        setExports(nextExports);
        const nextId =
          preferredExportId &&
          nextExports.some((item) => item.export_id === preferredExportId)
            ? preferredExportId
            : (nextExports[0]?.export_id ?? "");
        setSelectedExportId(nextId);
        if (!nextId) {
          setSelectedPackage(null);
          setSignoffs([]);
          return;
        }
        const [nextPackage, nextSignoffs] = await Promise.all([
          getLitigationMatterAuditExport(matterId, nextId),
          listLitigationMatterAuditExportSignoffs(matterId, nextId),
        ]);
        const summary = nextExports.find((item) => item.export_id === nextId);
        if (
          !summary ||
          nextPackage.export_hash !== summary.export_hash ||
          nextPackage.matter_state_hash !== summary.matter_state_hash ||
          nextPackage.checklist_hash !== summary.checklist_hash
        ) {
          setIntegrityFailure(true);
          setSelectedPackage(null);
          setSignoffs([]);
          setPanelError("Package bindings failed client verification.");
          return;
        }
        setSelectedPackage(nextPackage);
        setSignoffs(nextSignoffs);
      } catch (reason) {
        setIntegrityFailure(true);
        setSelectedPackage(null);
        setSignoffs([]);
        setPanelError(
          reason instanceof Error
            ? reason.message
            : "Audit package verification failed.",
        );
      } finally {
        setLoadingAudit(false);
      }
    },
    [matterId],
  );

  useEffect(() => {
    void refreshAudit();
  }, [refreshAudit]);

  const selectedSummary = exports.find(
    (item) => item.export_id === selectedExportId,
  );
  const approvalCurrent = Boolean(
    checkpoint?.status === "approved" &&
    preview &&
    checkpoint.requested_payload.matterStateHash ===
      preview.matter_state_hash &&
    checkpoint.requested_payload.checklistHash === preview.checklist_hash &&
    checkpoint.requested_payload.checklistSchemaVersion ===
      preview.checklist.schema_version,
  );
  const packageIntegrityValid = Boolean(
    selectedPackage &&
    selectedSummary &&
    !integrityFailure &&
    selectedPackage.export_hash === selectedSummary.export_hash &&
    selectedPackage.matter_state_hash === selectedSummary.matter_state_hash &&
    selectedPackage.checklist_hash === selectedSummary.checklist_hash,
  );
  const packageStale = selectedSummary?.stale ?? false;
  const hasCurrentVerifiedPackage = Boolean(
    preview &&
    selectedPackage &&
    packageIntegrityValid &&
    !packageStale &&
    selectedPackage.matter_state_hash === preview.matter_state_hash &&
    selectedPackage.checklist_hash === preview.checklist_hash,
  );
  const checklistReady = preview?.checklist.overall_status === "ready";
  const canSign = Boolean(
    selectedPackage &&
    selectedSummary &&
    packageIntegrityValid &&
    !packageStale &&
    selectedPackage.checklist.overall_status === "ready" &&
    signerName.trim().length >= 2 &&
    reviewComment.trim().length >= 20 &&
    attestationAccepted &&
    !busyAction,
  );

  async function runAuditAction(name: string, action: () => Promise<void>) {
    setBusyAction(name);
    setPanelError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setPanelError(
        reason instanceof Error
          ? reason.message
          : "Audit package action failed.",
      );
    } finally {
      setBusyAction("");
    }
  }

  async function requestApproval() {
    if (!preview || !checklistReady) return;
    await runAuditAction("request", async () => {
      const nextCheckpoint = await requestAletheiaApproval(matterId, {
        action: "litigation_matter_audit_export",
        prompt:
          "Approve export of this exact litigation matter audit snapshot.",
        requestedPayload: {
          matterStateHash: preview.matter_state_hash,
          checklistHash: preview.checklist_hash,
          checklistSchemaVersion: preview.checklist.schema_version,
        },
      });
      setCheckpoint(nextCheckpoint);
      setNotice("Approval checkpoint opened for the exact current hashes.");
    });
  }

  async function decideApproval(decision: "approved" | "rejected") {
    if (!checkpoint) return;
    await runAuditAction("decision", async () => {
      const decided = await decideAletheiaApproval(matterId, checkpoint.id, {
        decision,
        comment:
          decision === "approved"
            ? "Counsel approved export of this exact audit snapshot."
            : "Counsel rejected export of this audit snapshot.",
      });
      setCheckpoint(decided);
      setNotice(
        decision === "approved"
          ? "Exact snapshot approved."
          : "Approval checkpoint rejected.",
      );
    });
  }

  async function createPackage() {
    if (!checkpoint || !approvalCurrent) return;
    await runAuditAction("create", async () => {
      const livePreview = await getLitigationMatterAuditExportPreview(matterId);
      setPreview(livePreview);
      if (
        checkpoint.requested_payload.matterStateHash !==
          livePreview.matter_state_hash ||
        checkpoint.requested_payload.checklistHash !==
          livePreview.checklist_hash ||
        checkpoint.requested_payload.checklistSchemaVersion !==
          livePreview.checklist.schema_version ||
        livePreview.checklist.overall_status !== "ready"
      ) {
        setCheckpoint(null);
        throw new Error(
          "Approval is stale. Review and approve the current server checklist.",
        );
      }
      const exported = await createLitigationMatterAuditExport(matterId, {
        approvalCheckpointId: checkpoint.id,
      });
      await refreshAudit(exported.export_id);
      setCheckpoint(null);
      setNotice("Verified JSON audit package created.");
    });
  }

  async function downloadVerifiedPackage() {
    if (!selectedSummary || packageStale || !packageIntegrityValid) return;
    await runAuditAction("download", async () => {
      const verified = await getLitigationMatterAuditExport(
        matterId,
        selectedSummary.export_id,
      );
      if (
        verified.export_hash !== selectedSummary.export_hash ||
        verified.matter_state_hash !== selectedSummary.matter_state_hash ||
        verified.checklist_hash !== selectedSummary.checklist_hash
      ) {
        setIntegrityFailure(true);
        throw new Error("Downloaded package bindings failed verification.");
      }
      const blob = new Blob([JSON.stringify(verified, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `vera-litigation-audit-${verified.export_id}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice("Verified JSON fetched from the backend and downloaded.");
    });
  }

  async function signPackage() {
    if (!preview || !selectedPackage || !canSign) return;
    await runAuditAction("sign", async () => {
      await signLitigationMatterAuditExport(
        matterId,
        selectedPackage.export_id,
        {
          exportHash: selectedPackage.export_hash,
          checklistHash: selectedPackage.checklist_hash,
          matterStateHash: selectedPackage.matter_state_hash,
          signerName: signerName.trim(),
          professionalIdentifier: professionalIdentifier.trim() || null,
          attestation: preview.attestation,
          comment: reviewComment.trim(),
        },
      );
      setReviewComment("");
      setAttestationAccepted(false);
      await refreshAudit(selectedPackage.export_id);
      setNotice("Counsel application sign-off recorded with a hash receipt.");
    });
  }

  return (
    <section data-testid="litigation-audit-package" className="mt-10">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-gray-300 pb-4">
        <SectionHeading
          title="Matter audit package and counsel sign-off"
          detail="Final handoff uses the current server checklist, an exact approval binding, and a verified local JSON package."
        />
        <button
          type="button"
          onClick={() => void refreshAudit(selectedExportId || undefined)}
          disabled={loadingAudit || Boolean(busyAction)}
          className="grid h-9 w-9 shrink-0 place-items-center border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-950 disabled:opacity-40"
          aria-label="Refresh audit package status"
          title="Refresh audit package status"
        >
          <RefreshCw
            className={`h-4 w-4 ${loadingAudit ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {panelError ? (
        <div
          role="alert"
          className="border-b border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800"
        >
          {panelError}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="border-b border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800"
        >
          {notice}
        </div>
      ) : null}

      {loadingAudit && !preview ? (
        <div className="flex items-center gap-2 border-b border-gray-200 py-8 text-sm text-gray-500">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Verifying matter readiness
        </div>
      ) : preview ? (
        <>
          <div className="grid gap-5 border-b border-gray-200 py-5 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div>
              <div className="text-xs font-semibold uppercase text-gray-500">
                Server readiness
              </div>
              <div
                className={`mt-2 text-base font-semibold ${
                  checklistReady ? "text-emerald-800" : "text-amber-800"
                }`}
              >
                {checklistReady ? "Ready" : "Action required"}
              </div>
              <p className="mt-2 text-xs leading-5 text-gray-500">
                {preview.checklist.items.length} checks from{" "}
                {preview.checklist.schema_version}
              </p>
            </div>
            <div
              data-testid="audit-checklist"
              className="grid min-w-0 gap-x-6 sm:grid-cols-2"
            >
              {preview.checklist.items.map((item) => (
                <div
                  key={item.id}
                  className="flex min-w-0 gap-2 border-t border-gray-100 py-2.5 first:border-t-0 sm:[&:nth-child(2)]:border-t-0"
                >
                  <AuditStatusMark status={item.status} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900">
                      {auditChecklistLabels[item.id] ?? item.id}
                    </div>
                    <div className="mt-0.5 break-words text-xs leading-5 text-gray-500">
                      {item.summary}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-5 border-b border-gray-200 py-5 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div>
              <div className="text-xs font-semibold uppercase text-gray-500">
                Exact snapshot
              </div>
              <p className="mt-2 text-xs leading-5 text-gray-500">
                Approval is valid only for these server-derived values.
              </p>
            </div>
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              <AuditHash
                label="Matter state hash"
                value={preview.matter_state_hash}
              />
              <AuditHash
                label="Checklist hash"
                value={preview.checklist_hash}
              />
            </div>
          </div>

          <div className="grid gap-5 border-b border-gray-200 py-5 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div>
              <div className="text-xs font-semibold uppercase text-gray-500">
                Approval checkpoint
              </div>
              <div className="mt-2 text-sm font-medium text-gray-900">
                {checkpoint
                  ? checkpoint.status === "approved" && !approvalCurrent
                    ? "stale"
                    : checkpoint.status
                  : selectedSummary?.approval_checkpoint_id
                    ? "approved and exported"
                    : "not requested"}
              </div>
              {(checkpoint?.id || selectedSummary?.approval_checkpoint_id) && (
                <div className="mt-1 break-all font-mono text-[10px] leading-4 text-gray-500">
                  {checkpoint?.id ?? selectedSummary?.approval_checkpoint_id}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(!checkpoint || checkpoint.status === "rejected") &&
                !hasCurrentVerifiedPackage && (
                  <button
                    type="button"
                    disabled={!checklistReady || Boolean(busyAction)}
                    onClick={() => void requestApproval()}
                    className="h-9 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busyAction === "request"
                      ? "Requesting…"
                      : "Request approval"}
                  </button>
                )}
              {checkpoint?.status === "open" && (
                <>
                  <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void decideApproval("approved")}
                    className="inline-flex h-9 items-center gap-2 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                  >
                    <Check className="h-4 w-4" />
                    Approve exact snapshot
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void decideApproval("rejected")}
                    className="inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    <X className="h-4 w-4" />
                    Reject
                  </button>
                </>
              )}
              {checkpoint?.status === "approved" && (
                <button
                  type="button"
                  disabled={!approvalCurrent || Boolean(busyAction)}
                  onClick={() => void createPackage()}
                  className="inline-flex h-9 items-center gap-2 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ShieldCheck className="h-4 w-4" />
                  {busyAction === "create"
                    ? "Creating…"
                    : "Create verified package"}
                </button>
              )}
              {!checklistReady ? (
                <p className="w-full text-xs leading-5 text-amber-800">
                  Resolve every action-required checklist item before approval.
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-5 border-b border-gray-200 py-5 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div>
              <div className="text-xs font-semibold uppercase text-gray-500">
                Verified package
              </div>
              <div
                className={`mt-2 text-sm font-medium ${
                  integrityFailure || packageStale
                    ? "text-red-700"
                    : packageIntegrityValid
                      ? "text-emerald-800"
                      : "text-gray-500"
                }`}
              >
                {integrityFailure
                  ? "Integrity failure"
                  : packageStale
                    ? "Stale: matter changed"
                    : packageIntegrityValid
                      ? "Integrity verified"
                      : "Not created"}
              </div>
            </div>
            <div className="min-w-0">
              {exports.length > 1 ? (
                <label className="mb-3 block text-xs font-medium text-gray-600">
                  Package history
                  <select
                    value={selectedExportId}
                    onChange={(event) => void refreshAudit(event.target.value)}
                    className="mt-1 block h-9 w-full max-w-lg border border-gray-300 bg-white px-2 text-sm text-gray-900 outline-none focus:border-gray-600"
                  >
                    {exports.map((item) => (
                      <option key={item.export_id} value={item.export_id}>
                        {formatDate(item.exported_at)} ·{" "}
                        {item.stale ? "stale" : "current"}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {selectedPackage && selectedSummary ? (
                <div className="grid min-w-0 gap-3 md:grid-cols-2">
                  <AuditHash
                    label="Export hash"
                    value={selectedPackage.export_hash}
                  />
                  <AuditHash
                    label="Export matter state hash"
                    value={selectedPackage.matter_state_hash}
                  />
                  <AuditHash
                    label="Export checklist hash"
                    value={selectedPackage.checklist_hash}
                  />
                  <div className="text-xs leading-5 text-gray-500">
                    <div>{formatDate(selectedPackage.exported_at)}</div>
                    <div>
                      {selectedSummary.signoff_count} counsel sign-off receipt
                      {selectedSummary.signoff_count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <button
                      type="button"
                      disabled={
                        packageStale ||
                        !packageIntegrityValid ||
                        Boolean(busyAction)
                      }
                      onClick={() => void downloadVerifiedPackage()}
                      className="inline-flex h-9 items-center gap-2 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Download className="h-4 w-4" />
                      {busyAction === "download"
                        ? "Verifying…"
                        : "Download verified JSON"}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-500">
                  An approved checkpoint is required before package creation.
                </p>
              )}
            </div>
          </div>

          {selectedPackage ? (
            <div className="grid gap-5 border-b border-gray-200 py-5 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div>
                <div className="text-xs font-semibold uppercase text-gray-500">
                  Counsel sign-off
                </div>
                <p className="mt-2 text-xs leading-5 text-gray-500">
                  Required fields are bound to the selected package hashes.
                </p>
              </div>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-gray-600">
                  Signer name
                  <input
                    value={signerName}
                    onChange={(event) => setSignerName(event.target.value)}
                    disabled={packageStale || !packageIntegrityValid}
                    className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm text-gray-900 outline-none focus:border-gray-600 disabled:bg-gray-50 disabled:text-gray-400"
                  />
                </label>
                <label className="text-xs font-medium text-gray-600">
                  Professional ID (optional)
                  <input
                    value={professionalIdentifier}
                    onChange={(event) =>
                      setProfessionalIdentifier(event.target.value)
                    }
                    disabled={packageStale || !packageIntegrityValid}
                    className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm text-gray-900 outline-none focus:border-gray-600 disabled:bg-gray-50 disabled:text-gray-400"
                  />
                </label>
                <label className="text-xs font-medium text-gray-600 sm:col-span-2">
                  Review comment
                  <textarea
                    value={reviewComment}
                    onChange={(event) => setReviewComment(event.target.value)}
                    disabled={packageStale || !packageIntegrityValid}
                    placeholder="Record what you reviewed in this exact package."
                    className="mt-1 min-h-20 w-full resize-y border border-gray-300 px-3 py-2 text-sm leading-5 text-gray-900 outline-none focus:border-gray-600 disabled:bg-gray-50 disabled:text-gray-400"
                  />
                  <span
                    className={
                      reviewComment.trim().length === 0 ||
                      packageStale ||
                      !packageIntegrityValid
                        ? "text-gray-500"
                        : reviewComment.trim().length < 20
                          ? "text-amber-700"
                          : "text-gray-500"
                    }
                  >
                    {reviewComment.trim().length}/20 minimum characters
                  </span>
                </label>
                <label className="flex items-start gap-2 border-t border-gray-200 pt-3 text-sm leading-5 text-gray-700 sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={attestationAccepted}
                    onChange={(event) =>
                      setAttestationAccepted(event.target.checked)
                    }
                    disabled={packageStale || !packageIntegrityValid}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span>
                    I accept this exact attestation: “{preview.attestation}”
                  </span>
                </label>
                <div className="sm:col-span-2">
                  <button
                    type="button"
                    disabled={!canSign}
                    onClick={() => void signPackage()}
                    className="inline-flex h-9 items-center gap-2 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Check className="h-4 w-4" />
                    {busyAction === "sign"
                      ? "Recording…"
                      : "Record counsel sign-off"}
                  </button>
                  {(packageStale || integrityFailure) && (
                    <p className="mt-2 text-xs leading-5 text-red-700">
                      New sign-off is blocked. Create and approve a current
                      verified package.
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {signoffs.length ? (
            <div
              data-testid="audit-signoff-receipts"
              className="border-b border-gray-200"
            >
              <div className="py-4 text-xs font-semibold uppercase text-gray-500">
                Sign-off receipts
              </div>
              {signoffs.map((receipt) => (
                <article
                  key={receipt.id}
                  className="grid min-w-0 gap-4 border-t border-gray-200 py-4 lg:grid-cols-[220px_minmax(0,1fr)]"
                >
                  <div>
                    <div className="text-sm font-medium text-gray-950">
                      {receipt.signerName}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-gray-500">
                      {receipt.professionalIdentifier ||
                        "No professional ID recorded"}
                      <br />
                      {formatDate(receipt.signedAt)}
                    </div>
                  </div>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <AuditHash
                      label="Receipt hash"
                      value={receipt.signoffHash}
                    />
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <div className="text-gray-500">Integrity</div>
                        <div
                          className={
                            receipt.integrity_valid
                              ? "mt-1 font-medium text-emerald-800"
                              : "mt-1 font-medium text-red-700"
                          }
                        >
                          {receipt.integrity_valid ? "Valid" : "Failed"}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">Package</div>
                        <div
                          className={
                            receipt.stale
                              ? "mt-1 font-medium text-red-700"
                              : "mt-1 font-medium text-emerald-800"
                          }
                        >
                          {receipt.stale ? "Stale" : "Current"}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">Independent</div>
                        <div className="mt-1 font-medium text-gray-800">
                          {receipt.independentReview ? "Yes" : "No"}
                        </div>
                      </div>
                    </div>
                    <p className="text-xs leading-5 text-gray-600 sm:col-span-2">
                      {receipt.comment}
                    </p>
                    <AuditSignoffAnchor
                      matterId={matterId}
                      exportId={selectedExportId}
                      signoffId={receipt.id}
                    />
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          <p className="border-b border-gray-300 py-4 text-sm font-semibold leading-6 text-gray-800">
            This is not a qualified electronic signature, trusted timestamp, or
            independent notarization.
          </p>
        </>
      ) : null}
    </section>
  );
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="pb-4">
      <h2 className="text-base font-semibold text-gray-950">{title}</h2>
      <p className="mt-1 text-sm text-gray-500">{detail}</p>
    </div>
  );
}

const authorityTypeLabels: Record<LitigationLegalAuthorityType, string> = {
  statute: "Statute",
  regulation: "Regulation",
  judicial_interpretation: "Judicial interpretation",
  guiding_case: "Guiding case",
  other: "Other authority",
};

function authorityStatusTone(status: "draft" | "verified" | "retired") {
  if (status === "verified") return "border-emerald-600 text-emerald-700";
  if (status === "retired") return "border-gray-400 text-gray-500";
  return "border-amber-500 text-amber-800";
}

function LegalAuthorityWorkspace({
  matterId,
  claims,
  positionAuthorityStatuses,
  registry,
  onDataChange,
}: {
  matterId: string;
  claims: LitigationClaimRecord[];
  positionAuthorityStatuses: LitigationPositionAuthorityStatusRecord[];
  registry: LitigationLegalAuthorityRegistry;
  onDataChange: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] =
    useState<LitigationLegalAuthorityVersionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [authorityType, setAuthorityType] =
    useState<LitigationLegalAuthorityType>("statute");
  const [title, setTitle] = useState("");
  const [issuer, setIssuer] = useState("");
  const [officialIdentifier, setOfficialIdentifier] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [content, setContent] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [verificationComment, setVerificationComment] = useState("");
  const [retirementComment, setRetirementComment] = useState("");
  const [claimId, setClaimId] = useState("");
  const [applicabilityDate, setApplicabilityDate] = useState("");
  const [provisionReference, setProvisionReference] = useState("");
  const [exactQuote, setExactQuote] = useState("");
  const [rationale, setRationale] = useState("");
  const [withdrawalComments, setWithdrawalComments] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (
      selectedId &&
      registry.versions.some((version) => version.id === selectedId)
    ) {
      return;
    }
    setSelectedId(registry.versions[0]?.id ?? "");
  }, [registry.versions, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let current = true;
    setDetailLoading(true);
    setPanelError("");
    void getLitigationLegalAuthorityVersion(matterId, selectedId)
      .then((next) => {
        if (current) setDetail(next);
      })
      .catch((error: unknown) => {
        if (current) {
          setPanelError(
            error instanceof Error
              ? error.message
              : "Unable to load source text",
          );
        }
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });
    return () => {
      current = false;
    };
  }, [matterId, selectedId]);

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setPanelError("");
    try {
      await action();
      await onDataChange();
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Operation failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createVersion() {
    await mutate(async () => {
      const created = await createLitigationLegalAuthorityVersion(matterId, {
        authorityType,
        title,
        issuer,
        officialIdentifier,
        versionLabel,
        sourceReference,
        content,
        effectiveFrom,
        effectiveTo: effectiveTo || null,
      });
      setSelectedId(created.id);
      setDetail(created);
      setShowCreate(false);
      setTitle("");
      setIssuer("");
      setOfficialIdentifier("");
      setVersionLabel("");
      setSourceReference("");
      setContent("");
      setEffectiveFrom("");
      setEffectiveTo("");
    });
  }

  async function verifyVersion() {
    if (!detail) return;
    await mutate(async () => {
      const next = await verifyLitigationLegalAuthorityVersion(
        matterId,
        detail.id,
        verificationComment,
      );
      setDetail(next);
      setVerificationComment("");
    });
  }

  async function retireVersion() {
    if (!detail) return;
    await mutate(async () => {
      const next = await retireLitigationLegalAuthorityVersion(
        matterId,
        detail.id,
        retirementComment,
      );
      setDetail(next);
      setRetirementComment("");
    });
  }

  async function linkAuthority() {
    if (!detail) return;
    await mutate(async () => {
      await linkLitigationPositionAuthority(matterId, {
        claimId,
        authorityVersionId: detail.id,
        applicabilityDate,
        provisionReference,
        exactQuote,
        rationale,
      });
      setProvisionReference("");
      setExactQuote("");
      setRationale("");
    });
  }

  async function withdrawLink(linkId: string) {
    await mutate(async () => {
      await withdrawLitigationPositionAuthority(
        matterId,
        linkId,
        withdrawalComments[linkId] ?? "",
      );
      setWithdrawalComments((current) => ({ ...current, [linkId]: "" }));
    });
  }

  const eligibleClaims = claims.filter(
    (claim) => claim.status === "proposed" || claim.status === "confirmed",
  );
  const selectedClaim = eligibleClaims.find((claim) => claim.id === claimId);
  const selectedClaimAuthorityStatus = selectedClaim
    ? (positionAuthorityStatuses.find(
        (item) => item.claim_id === selectedClaim.id,
      ) ?? {
        claim_id: selectedClaim.id,
        status: "missing" as const,
        valid_link_ids: [],
        invalid_link_ids: [],
      })
    : null;
  const selectedLinks = registry.links.filter(
    (link) => link.authority_version_id === selectedId,
  );

  return (
    <section className="min-w-0 border-t border-gray-300 pt-7">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <SectionHeading
          title="Legal authority versions"
          detail="Store source text by effective interval, record counsel's source check, and bind an exact provision quote before or after the position decision."
        />
        <button
          type="button"
          aria-expanded={showCreate}
          onClick={() => setShowCreate((current) => !current)}
          className="flex h-9 items-center gap-2 border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50"
        >
          <Plus className="h-4 w-4" />
          New version
        </button>
      </div>

      {panelError && (
        <div
          role="alert"
          className="mb-4 border-l-2 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {panelError}
        </div>
      )}

      {showCreate && (
        <div className="mb-6 border-y border-gray-200 bg-gray-50/50 py-5">
          <h3 className="mb-4 text-sm font-semibold text-gray-950">
            Create draft authority version
          </h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="grid gap-1 text-xs font-medium text-gray-600">
              Authority type
              <select
                aria-label="Authority type"
                value={authorityType}
                onChange={(event) =>
                  setAuthorityType(
                    event.target.value as LitigationLegalAuthorityType,
                  )
                }
                className="h-10 border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-gray-600"
              >
                {Object.entries(authorityTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <AuthorityInput label="Title" value={title} onChange={setTitle} />
            <AuthorityInput
              label="Issuer"
              value={issuer}
              onChange={setIssuer}
            />
            <AuthorityInput
              label="Official identifier"
              value={officialIdentifier}
              onChange={setOfficialIdentifier}
            />
            <AuthorityInput
              label="Version label"
              value={versionLabel}
              onChange={setVersionLabel}
            />
            <AuthorityInput
              label="Named source reference"
              value={sourceReference}
              onChange={setSourceReference}
            />
            <AuthorityInput
              label="Effective from"
              type="date"
              value={effectiveFrom}
              onChange={setEffectiveFrom}
            />
            <AuthorityInput
              label="Effective to (optional)"
              type="date"
              value={effectiveTo}
              onChange={setEffectiveTo}
            />
          </div>
          <label className="mt-3 grid gap-1 text-xs font-medium text-gray-600">
            Full stored source text
            <textarea
              aria-label="Full stored source text"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="min-h-36 w-full border border-gray-300 bg-white px-3 py-2 font-mono text-xs leading-5 text-gray-900 outline-none focus:border-gray-600"
            />
          </label>
          <div className="mt-3 flex justify-end">
            <PrimaryAction
              disabled={
                busy ||
                !title.trim() ||
                !issuer.trim() ||
                !officialIdentifier.trim() ||
                !versionLabel.trim() ||
                !sourceReference.trim() ||
                !effectiveFrom ||
                content.trim().length < 20
              }
              onClick={createVersion}
            >
              Create draft
            </PrimaryAction>
          </div>
        </div>
      )}

      <div className="grid min-w-0 border-y border-gray-200 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="min-w-0 border-b border-gray-200 lg:border-b-0 lg:border-r">
          <div className="grid grid-cols-[minmax(0,1fr)_72px] border-b border-gray-200 bg-gray-50 px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">
            <span>Authority / interval</span>
            <span>Status</span>
          </div>
          <div className="max-h-[560px] overflow-y-auto">
            {registry.versions.length === 0 ? (
              <p className="px-3 py-5 text-sm text-gray-500">
                No authority versions recorded.
              </p>
            ) : (
              registry.versions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  aria-pressed={selectedId === version.id}
                  onClick={() => setSelectedId(version.id)}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_72px] gap-3 border-b border-gray-200 px-3 py-3 text-left hover:bg-gray-50 ${
                    selectedId === version.id ? "bg-gray-100" : "bg-white"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-medium text-gray-950 [overflow-wrap:anywhere]">
                      {version.title}
                    </span>
                    <span className="mt-1 block break-all text-xs text-gray-500">
                      {version.official_identifier} · {version.version_label}
                    </span>
                    <span className="mt-1 block text-xs tabular-nums text-gray-600">
                      {version.effective_from} to{" "}
                      {version.effective_to ?? "open-ended"}
                    </span>
                  </span>
                  <span
                    className={`mt-0.5 border-l-2 pl-2 text-xs font-semibold capitalize ${authorityStatusTone(version.status)}`}
                  >
                    {version.status}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 p-4 md:p-5">
          {detailLoading ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-gray-500">
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Loading
              stored text
            </div>
          ) : detail ? (
            <div className="legal-authority-detail min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-gray-500" />
                    <h3 className="break-words text-sm font-semibold text-gray-950 [overflow-wrap:anywhere]">
                      {detail.title}
                    </h3>
                  </div>
                  <p className="mt-1 break-words text-xs leading-5 text-gray-600 [overflow-wrap:anywhere]">
                    {authorityTypeLabels[detail.authority_type]} ·{" "}
                    {detail.issuer} · {detail.official_identifier} ·{" "}
                    {detail.version_label}
                  </p>
                </div>
                <span
                  className={`border-l-2 pl-2 text-xs font-semibold capitalize ${authorityStatusTone(detail.status)}`}
                >
                  {detail.status}
                </span>
              </div>

              <dl className="grid gap-x-6 gap-y-3 border-b border-gray-200 py-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
                <AuthorityMeta
                  label="Effective interval"
                  value={`${detail.effective_from} to ${detail.effective_to ?? "open-ended"}`}
                />
                <AuthorityMeta
                  label="Named source reference"
                  value={detail.source_reference}
                />
                <AuthorityMeta
                  label="Content SHA-256"
                  value={detail.content_sha256}
                  mono
                />
                <AuthorityMeta
                  label="Lifecycle record"
                  value={
                    detail.status === "verified"
                      ? `Verified ${formatDate(detail.verified_at)}`
                      : detail.status === "retired"
                        ? `Retired ${formatDate(detail.retired_at)}`
                        : `Draft created ${formatDate(detail.created_at)}`
                  }
                />
              </dl>
              <p className="mt-3 text-xs leading-5 text-gray-500">
                The SHA-256 value is an integrity fingerprint, not proof that
                the source is authentic. Verification records that counsel
                checked this text against the named source reference.
              </p>
              {detail.verification_comment && (
                <div className="mt-3 border-l-2 border-emerald-600 px-3 text-xs leading-5 text-gray-700">
                  <span className="font-semibold text-emerald-700">
                    Counsel source check:
                  </span>{" "}
                  {detail.verification_comment}
                </div>
              )}
              {detail.retirement_comment && (
                <div className="mt-3 border-l-2 border-gray-400 px-3 text-xs leading-5 text-gray-600">
                  <span className="font-semibold">Retirement reason:</span>{" "}
                  {detail.retirement_comment}
                </div>
              )}

              <div className="mt-4">
                <div className="mb-2 text-[10px] font-semibold uppercase text-gray-500">
                  Full stored source text
                </div>
                <pre className="max-h-72 min-h-28 overflow-auto whitespace-pre-wrap border border-gray-200 bg-gray-50 p-3 font-mono text-xs leading-5 text-gray-800 [overflow-wrap:anywhere]">
                  {detail.content}
                </pre>
              </div>

              {detail.status === "draft" && (
                <div className="mt-5 grid gap-3 border-t border-gray-200 pt-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <label className="grid gap-1 text-xs font-medium text-gray-600">
                    Counsel verification reason
                    <textarea
                      aria-label="Counsel verification reason"
                      value={verificationComment}
                      onChange={(event) =>
                        setVerificationComment(event.target.value)
                      }
                      placeholder="Record how this text was checked against the named source reference."
                      className="min-h-20 border border-gray-300 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
                    />
                  </label>
                  <PrimaryAction
                    disabled={busy || verificationComment.trim().length < 10}
                    onClick={verifyVersion}
                  >
                    Verify version
                  </PrimaryAction>
                </div>
              )}

              {detail.status === "verified" && (
                <div className="mt-5 grid gap-5 border-t border-gray-200 pt-5 xl:grid-cols-[minmax(0,1fr)_280px]">
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-gray-950">
                      Link to legal position
                    </h4>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label className="grid gap-1 text-xs font-medium text-gray-600 sm:col-span-2">
                        Proposed or confirmed position
                        <select
                          aria-label="Position for authority"
                          value={claimId}
                          onChange={(event) => setClaimId(event.target.value)}
                          className="h-10 min-w-0 border border-gray-300 bg-white px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
                        >
                          <option value="">Choose a position</option>
                          {eligibleClaims.map((claim) => {
                            const readiness =
                              positionAuthorityStatuses.find(
                                (item) => item.claim_id === claim.id,
                              )?.status ?? "missing";
                            return (
                              <option key={claim.id} value={claim.id}>
                                {claim.title} · {claim.status} · authority{" "}
                                {readiness}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      {selectedClaim && selectedClaimAuthorityStatus && (
                        <div
                          data-testid={`authority-selector-readiness-${selectedClaim.id}`}
                          className={`border-l-2 px-3 py-2 text-xs leading-5 sm:col-span-2 ${positionAuthorityTone(selectedClaimAuthorityStatus.status)}`}
                        >
                          <div className="font-semibold capitalize">
                            Authority basis{" "}
                            {selectedClaimAuthorityStatus.status} · position{" "}
                            {selectedClaim.status}
                          </div>
                          <p className="mt-0.5 text-gray-600">
                            {positionAuthorityReadinessCopy(
                              selectedClaimAuthorityStatus.status,
                              selectedClaim.status,
                            )}
                          </p>
                        </div>
                      )}
                      <AuthorityInput
                        label="Applicability date"
                        type="date"
                        value={applicabilityDate}
                        onChange={setApplicabilityDate}
                      />
                      <AuthorityInput
                        label="Provision reference"
                        value={provisionReference}
                        onChange={setProvisionReference}
                      />
                      <label className="grid gap-1 text-xs font-medium text-gray-600 sm:col-span-2">
                        Exact quote from stored text
                        <textarea
                          aria-label="Exact authority quote"
                          value={exactQuote}
                          onChange={(event) =>
                            setExactQuote(event.target.value)
                          }
                          className="min-h-20 border border-gray-300 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
                        />
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-gray-600 sm:col-span-2">
                        Applicability rationale
                        <textarea
                          aria-label="Authority applicability rationale"
                          value={rationale}
                          onChange={(event) => setRationale(event.target.value)}
                          className="min-h-20 border border-gray-300 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <PrimaryAction
                        disabled={
                          busy ||
                          !claimId ||
                          !applicabilityDate ||
                          !provisionReference.trim() ||
                          exactQuote.trim().length < 5 ||
                          rationale.trim().length < 10
                        }
                        onClick={linkAuthority}
                      >
                        Link authority
                      </PrimaryAction>
                    </div>
                  </div>
                  <div className="border-t border-gray-200 pt-5 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
                    <h4 className="text-sm font-semibold text-gray-950">
                      Retire version
                    </h4>
                    <label className="mt-3 grid gap-1 text-xs font-medium text-gray-600">
                      Retirement reason
                      <textarea
                        aria-label="Authority retirement reason"
                        value={retirementComment}
                        onChange={(event) =>
                          setRetirementComment(event.target.value)
                        }
                        className="min-h-24 border border-gray-300 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || retirementComment.trim().length < 10}
                      onClick={() => void retireVersion()}
                      className="mt-3 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Retire version
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-6 border-t border-gray-200 pt-5">
                <h4 className="text-sm font-semibold text-gray-950">
                  Position authority links
                </h4>
                <div className="mt-3 border-t border-gray-200">
                  {selectedLinks.length === 0 ? (
                    <p className="py-4 text-sm text-gray-500">
                      No position links for this version.
                    </p>
                  ) : (
                    selectedLinks.map((link) => {
                      const claim = claims.find(
                        (item) => item.id === link.claim_id,
                      );
                      const readiness = positionAuthorityStatuses.find(
                        (item) => item.claim_id === link.claim_id,
                      );
                      return (
                        <div
                          key={link.id}
                          className="grid min-w-0 gap-3 border-b border-gray-200 py-4 lg:grid-cols-[minmax(0,1fr)_240px]"
                        >
                          <div className="min-w-0 text-xs leading-5">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span
                                className={`border-l-2 pl-2 font-semibold capitalize ${link.status === "active" ? "border-emerald-600 text-emerald-700" : "border-gray-400 text-gray-500"}`}
                              >
                                {link.status}
                              </span>
                              <span className="font-medium text-gray-900">
                                {link.provision_reference}
                              </span>
                              <span className="tabular-nums text-gray-500">
                                Applies {link.applicability_date}
                              </span>
                            </div>
                            <p className="mt-1 break-words text-gray-800 [overflow-wrap:anywhere]">
                              {claim?.title ?? link.claim_id}
                            </p>
                            {claim && readiness && (
                              <p
                                className={`mt-1 font-medium capitalize ${positionAuthorityTone(readiness.status)}`}
                              >
                                Position {claim.status} · authority basis{" "}
                                {readiness.status}
                              </p>
                            )}
                            <blockquote className="mt-2 border-l-2 border-gray-300 pl-3 text-gray-600">
                              {link.exact_quote}
                            </blockquote>
                            <p className="mt-2 text-gray-600">
                              {link.rationale}
                            </p>
                            <p className="mt-1 break-all font-mono text-[10px] text-gray-400">
                              Quote SHA-256 {link.quote_sha256}
                            </p>
                            {link.withdrawal_comment && (
                              <p className="mt-2 text-gray-500">
                                Withdrawal reason: {link.withdrawal_comment}
                              </p>
                            )}
                          </div>
                          {link.status === "active" && (
                            <div className="min-w-0">
                              <label className="grid gap-1 text-xs font-medium text-gray-600">
                                Withdrawal reason
                                <textarea
                                  aria-label={`Withdrawal reason for ${link.provision_reference}`}
                                  value={withdrawalComments[link.id] ?? ""}
                                  onChange={(event) =>
                                    setWithdrawalComments((current) => ({
                                      ...current,
                                      [link.id]: event.target.value,
                                    }))
                                  }
                                  className="min-h-20 border border-gray-300 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
                                />
                              </label>
                              <button
                                type="button"
                                disabled={
                                  busy ||
                                  (withdrawalComments[link.id] ?? "").trim()
                                    .length < 10
                                }
                                onClick={() => void withdrawLink(link.id)}
                                className="mt-2 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                              >
                                Withdraw link
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-40 items-center justify-center text-sm text-gray-500">
              Select a version to inspect its stored text.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AuthorityInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "date";
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-medium text-gray-600">
      {label}
      <input
        aria-label={label}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 min-w-0 border border-gray-300 bg-white px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
      />
    </label>
  );
}

function AuthorityMeta({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold text-gray-500">{label}</dt>
      <dd
        className={`mt-1 break-words text-gray-800 [overflow-wrap:anywhere] ${mono ? "font-mono text-[10px]" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function ReviewedRetrievalPanel({
  matterId,
  chunks,
  onManifestChange,
}: {
  matterId: string;
  chunks: DocumentChunk[];
  onManifestChange: (manifest: LitigationRetrievalManifest | null) => void;
}) {
  const storageKey = `vera:litigation-retrieval-manifest:${matterId}`;
  const [focus, setFocus] = useState("");
  const [manifest, setManifest] = useState<LitigationRetrievalManifest | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState("");
  const [confirmReasons, setConfirmReasons] = useState<Record<string, string>>(
    {},
  );
  const [withdrawReasons, setWithdrawReasons] = useState<
    Record<string, string>
  >({});

  const refreshManifest = useCallback(
    async (manifestId: string) => {
      const next = await getLitigationRetrievalManifest(matterId, manifestId);
      setManifest(next);
      onManifestChange(next);
      return next;
    },
    [matterId, onManifestChange],
  );

  useEffect(() => {
    const savedId = window.localStorage.getItem(storageKey);
    if (!savedId) return;
    setBusyId("restore");
    void refreshManifest(savedId)
      .catch((reason) => {
        window.localStorage.removeItem(storageKey);
        setManifest(null);
        onManifestChange(null);
        setPanelError(
          reason instanceof Error
            ? `Saved retrieval could not be restored: ${reason.message}`
            : "Saved retrieval could not be restored.",
        );
      })
      .finally(() => setBusyId(null));
  }, [onManifestChange, refreshManifest, storageKey]);

  async function runRetrieval() {
    if (!focus.trim()) return;
    setBusyId("search");
    setPanelError("");
    try {
      const next = await createLitigationRetrievalManifest(
        matterId,
        focus.trim(),
      );
      window.localStorage.setItem(storageKey, next.id);
      setManifest(next);
      onManifestChange(next);
      setConfirmReasons({});
      setWithdrawReasons({});
    } catch (reason) {
      setPanelError(
        reason instanceof Error ? reason.message : "Retrieval failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function confirmCandidate(chunkId: string) {
    if (!manifest) return;
    const comment = confirmReasons[chunkId]?.trim() ?? "";
    if (comment.length < 10) return;
    setBusyId(chunkId);
    setPanelError("");
    try {
      await confirmLitigationRetrievalExcerpt(matterId, manifest.id, {
        chunkId,
        comment,
      });
      await refreshManifest(manifest.id);
    } catch (reason) {
      setPanelError(
        reason instanceof Error ? reason.message : "Confirmation failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function withdrawExcerpt(excerptId: string) {
    if (!manifest) return;
    const comment = withdrawReasons[excerptId]?.trim() ?? "";
    if (comment.length < 10) return;
    setBusyId(excerptId);
    setPanelError("");
    try {
      await withdrawLitigationRetrievalExcerpt(matterId, excerptId, comment);
      await refreshManifest(manifest.id);
    } catch (reason) {
      setPanelError(
        reason instanceof Error ? reason.message : "Withdrawal failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  const excerpts = manifest?.excerpts ?? [];
  const confirmedCount = excerpts.filter(
    (excerpt) => excerpt.status === "confirmed",
  ).length;
  const withdrawnCount = excerpts.filter(
    (excerpt) => excerpt.status === "withdrawn",
  ).length;

  return (
    <section className="min-w-0 border-y border-gray-200 py-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-950">
            Reviewed retrieval excerpts
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-gray-600">
            Candidates do not enter conclusions. Counsel must review the
            complete candidate set and record a reason before confirming an
            excerpt.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row lg:w-[520px]">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Retrieval focus</span>
            <input
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runRetrieval();
              }}
              placeholder="Search focus, e.g. payment due date"
              className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-gray-600"
            />
          </label>
          <button
            type="button"
            disabled={!focus.trim() || busyId !== null}
            onClick={() => void runRetrieval()}
            className="flex h-10 shrink-0 items-center justify-center gap-2 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
          >
            {busyId === "search" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Retrieve
          </button>
        </div>
      </div>

      <div className="mt-4 border-l-2 border-amber-500 bg-amber-50/60 px-3 py-2 text-xs leading-5 text-amber-900">
        Document changes require a new retrieval. Existing candidates and
        confirmed excerpts remain review records only; they are not bound as
        Agent input or legal conclusions.
      </div>

      {panelError && (
        <p role="alert" className="mt-3 text-sm leading-5 text-red-700">
          {panelError}
        </p>
      )}

      {busyId === "restore" && !manifest && (
        <p className="mt-4 text-sm text-gray-500">
          <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />
          Restoring the last reviewed retrieval
        </p>
      )}

      {manifest && (
        <div className="mt-5 min-w-0">
          <div className="grid gap-x-6 gap-y-2 border-y border-gray-200 bg-gray-50/70 px-3 py-3 text-xs text-gray-600 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,auto)]">
            <div className="min-w-0">
              <span className="font-semibold text-gray-950">Focus</span>{" "}
              <span className="break-words">{manifest.focus}</span>
            </div>
            <div>
              <span className="font-semibold text-gray-950">
                Complete candidates
              </span>{" "}
              {manifest.candidateCount}
            </div>
            <div>
              <span className="font-semibold text-gray-950">Confirmed</span>{" "}
              {confirmedCount}
            </div>
            <div>
              <span className="font-semibold text-gray-950">Withdrawn</span>{" "}
              {withdrawnCount}
            </div>
            <div className="min-w-0 text-[11px] text-gray-500 sm:col-span-2 lg:col-span-4">
              Complete set: {manifest.candidateSetComplete ? "yes" : "no"} ·
              Input binding: {manifest.inputBinding ? "yes" : "no"} · Manifest
              hash{" "}
              <span className="break-all font-mono">
                {manifest.manifestHash}
              </span>
            </div>
          </div>

          <div className="hidden grid-cols-[56px_minmax(0,1fr)_minmax(260px,0.72fr)] gap-4 border-b border-gray-200 px-3 py-2 text-[11px] font-semibold uppercase text-gray-500 lg:grid">
            <div>Rank</div>
            <div>Candidate source</div>
            <div>Review decision</div>
          </div>

          {manifest.candidates.length === 0 ? (
            <p className="py-8 text-sm text-gray-500">
              The complete candidate set contains 0 excerpts for this focus.
            </p>
          ) : (
            manifest.candidates.map((candidate) => {
              const excerpt = excerpts.find(
                (item) => item.chunk_id === candidate.chunkId,
              );
              const chunk = chunks.find(
                (item) => item.id === candidate.chunkId,
              );
              const page = candidate.page ?? chunk?.page;
              return (
                <article
                  key={candidate.chunkId}
                  className="grid min-w-0 gap-3 border-b border-gray-200 px-3 py-4 lg:grid-cols-[56px_minmax(0,1fr)_minmax(260px,0.72fr)] lg:gap-4"
                >
                  <div className="text-xs text-gray-500">
                    <span className="font-semibold text-gray-950 lg:hidden">
                      Rank{" "}
                    </span>
                    {candidate.rank}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-gray-500">
                      <span className="font-medium text-gray-900">
                        {candidate.documentName}
                      </span>
                      <span>
                        {page
                          ? `Page ${page}`
                          : `Chunk ${candidate.chunkIndex + 1}`}
                      </span>
                      <span>BM25 {candidate.score.toFixed(3)}</span>
                    </div>
                    <blockquote className="mt-2 whitespace-pre-wrap break-words border-l border-gray-300 pl-3 text-[13px] leading-5 text-gray-800">
                      {chunk?.text ??
                        excerpt?.quote ??
                        "Source text unavailable."}
                    </blockquote>
                    <div className="mt-2 break-all font-mono text-[10px] leading-4 text-gray-400">
                      sha256 {candidate.textSha256}
                    </div>
                  </div>
                  <div className="min-w-0">
                    {!excerpt ? (
                      <>
                        <label className="block text-xs font-medium text-gray-700">
                          Confirmation reason
                          <textarea
                            value={confirmReasons[candidate.chunkId] ?? ""}
                            onChange={(event) =>
                              setConfirmReasons((current) => ({
                                ...current,
                                [candidate.chunkId]: event.target.value,
                              }))
                            }
                            placeholder="Explain why this exact excerpt is relevant (10+ characters)."
                            className="mt-2 min-h-20 w-full resize-y border border-gray-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-gray-600"
                          />
                        </label>
                        <button
                          type="button"
                          disabled={
                            (confirmReasons[candidate.chunkId]?.trim().length ??
                              0) < 10 || busyId !== null
                          }
                          onClick={() =>
                            void confirmCandidate(candidate.chunkId)
                          }
                          className="mt-2 h-9 bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                        >
                          Confirm excerpt
                        </button>
                      </>
                    ) : (
                      <>
                        <div
                          className={`text-xs font-semibold uppercase ${
                            excerpt.status === "confirmed"
                              ? "text-emerald-700"
                              : "text-gray-500"
                          }`}
                        >
                          {excerpt.status === "confirmed"
                            ? "Confirmed"
                            : "Withdrawn"}
                        </div>
                        <p className="mt-2 break-words text-sm leading-5 text-gray-800">
                          {excerpt.decision_comment}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          {formatDate(excerpt.confirmed_at)}
                        </p>
                        {excerpt.status === "withdrawn" ? (
                          <div className="mt-3 border-t border-gray-200 pt-3">
                            <div className="text-xs font-medium text-gray-600">
                              Withdrawal reason
                            </div>
                            <p className="mt-1 break-words text-sm leading-5 text-gray-700">
                              {excerpt.withdrawal_comment}
                            </p>
                          </div>
                        ) : (
                          <div className="mt-3 border-t border-gray-200 pt-3">
                            <label className="block text-xs font-medium text-gray-700">
                              Withdrawal reason
                              <textarea
                                value={withdrawReasons[excerpt.id] ?? ""}
                                onChange={(event) =>
                                  setWithdrawReasons((current) => ({
                                    ...current,
                                    [excerpt.id]: event.target.value,
                                  }))
                                }
                                placeholder="Record why this excerpt should be withdrawn (10+ characters)."
                                className="mt-2 min-h-16 w-full resize-y border border-gray-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-gray-600"
                              />
                            </label>
                            <button
                              type="button"
                              disabled={
                                (withdrawReasons[excerpt.id]?.trim().length ??
                                  0) < 10 || busyId !== null
                              }
                              onClick={() => void withdrawExcerpt(excerpt.id)}
                              className="mt-2 h-9 border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40"
                            >
                              Withdraw excerpt
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="py-10 text-sm text-gray-400">{text}</div>;
}

function Editor({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Plus;
  children: React.ReactNode;
}) {
  return (
    <aside className="min-w-0 border-t border-gray-200 pt-6 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
        <Icon className="h-4 w-4" /> {title}
      </div>
      <div className="grid gap-3">{children}</div>
    </aside>
  );
}

function EditorSection({
  title,
  icon: Icon,
  children,
  divided = false,
}: {
  title: string;
  icon: typeof Plus;
  children: React.ReactNode;
  divided?: boolean;
}) {
  return (
    <section className={divided ? "mt-6 border-t border-gray-200 pt-6" : ""}>
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
        <Icon className="h-4 w-4" /> {title}
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function PrimaryAction({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-9 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function SourceFields({
  chunks,
  chunkId,
  quote,
  onChunkId,
  onQuote,
  selectLabel = "Source record",
  quoteLabel = "Exact source quote",
  emptyOption = "No source selected",
}: {
  chunks: DocumentChunk[];
  chunkId: string;
  quote: string;
  onChunkId: (value: string) => void;
  onQuote: (value: string) => void;
  selectLabel?: string;
  quoteLabel?: string;
  emptyOption?: string;
}) {
  const chunk = chunks.find((item) => item.id === chunkId);
  return (
    <div className="border-t border-gray-200 pt-3">
      <div className="mb-2 text-xs font-medium text-gray-500">Source span</div>
      <select
        aria-label={selectLabel}
        value={chunkId}
        onChange={(event) => {
          onChunkId(event.target.value);
          onQuote("");
        }}
        className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
      >
        <option value="">{emptyOption}</option>
        {chunks.map((item) => (
          <option key={item.id} value={item.id}>
            {item.metadata?.document_name
              ? String(item.metadata.document_name)
              : item.document_id}{" "}
            {item.page ? `· p.${item.page}` : ""}
          </option>
        ))}
      </select>
      {chunk && (
        <>
          <p className="mt-2 max-h-28 overflow-y-auto border-l-2 border-gray-300 pl-3 text-xs leading-5 text-gray-600">
            {chunk.text}
          </p>
          <textarea
            aria-label={quoteLabel}
            value={quote}
            onChange={(event) => onQuote(event.target.value)}
            placeholder="Paste the exact supporting words from this chunk."
            className="mt-2 min-h-16 w-full border border-gray-200 px-3 py-2 text-xs outline-none focus:border-gray-500"
          />
        </>
      )}
    </div>
  );
}

type LitigationSourceCitation =
  | LitigationWorkspaceRecord["fact_sources"][number]
  | LitigationWorkspaceRecord["claim_sources"][number];

function SourceCitation({
  matterId,
  source,
  canInspectOriginal,
  saving,
  onVerify,
  onWithdraw,
}: {
  matterId: string;
  source: LitigationSourceCitation;
  canInspectOriginal: boolean;
  saving: boolean;
  onVerify: (sourceSpanId: string, reason: string) => Promise<void>;
  onWithdraw: (
    sourceSpanId: string,
    verificationId: string,
    reason: string,
  ) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [viewerOpen, setViewerOpen] = useState(false);
  const originalAccess = useOriginalDocumentAccess();
  const provenance = source.metadata?.ocrProvenance;
  const confidence = Number(provenance?.confidence);
  const lowConfidence = Number.isFinite(confidence) && confidence < 0.7;
  const sourcePage = source.page ?? provenance?.page;
  return (
    <div className="mt-3 min-w-0 border-l-2 border-gray-300 bg-gray-50/60 px-3 py-2.5 text-xs leading-5 text-gray-600">
      <blockquote className="break-words text-gray-800 [overflow-wrap:anywhere]">
        “{source.quote}”
      </blockquote>
      <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-gray-500">
        <span className="break-all">{source.document_name}</span>
        <span>{sourcePage ? `p.${sourcePage}` : "Page not recorded"}</span>
        {"relation" in source && (
          <span
            className={
              source.relation === "supports"
                ? "font-medium text-emerald-700"
                : "font-medium text-red-700"
            }
          >
            {source.relation}
          </span>
        )}
      </div>
      {provenance && Number.isFinite(confidence) && (
        <div
          className={
            lowConfidence
              ? "mt-1 border-t border-amber-200 pt-1 text-amber-800"
              : "mt-1 border-t border-gray-200 pt-1 text-gray-500"
          }
        >
          OCR page {provenance.page ?? source.page ?? "unknown"} · confidence{" "}
          {Math.round(confidence * 100)}%
        </div>
      )}
      {lowConfidence && source.current_verification_id && (
        <div className="mt-1 text-emerald-700">
          Compared with original scan · text match recorded
        </div>
      )}
      {lowConfidence && canInspectOriginal && (
        <button
          type="button"
          aria-label={`Inspect original ${source.document_name}; recorded citation page ${sourcePage ?? "not recorded"}`}
          onClick={() => setViewerOpen(true)}
          className="mt-1.5 inline-flex min-h-8 max-w-full items-center gap-2 border border-gray-300 bg-white px-2.5 py-1 text-left font-medium text-gray-700 hover:bg-gray-50"
        >
          <ScanSearch className="h-3.5 w-3.5 shrink-0" />
          <span className="break-words">
            Inspect original
            {sourcePage
              ? ` · recorded p.${sourcePage}`
              : " · page not recorded"}
          </span>
        </button>
      )}
      {lowConfidence && !source.current_verification_id && (
        <div className="mt-1.5 border-t border-amber-200 pt-1.5">
          <button
            type="button"
            title="Save the stored original and open it in the default external viewer"
            aria-label={`Save and open original ${source.document_name}; recorded citation page ${sourcePage ?? "not recorded"}`}
            disabled={originalAccess.status === "busy"}
            onClick={() =>
              void originalAccess.saveAndOpen({
                matterId,
                documentId: source.document_id,
                suggestedName: source.document_name,
              })
            }
            className="mb-1.5 inline-flex min-h-8 max-w-full items-center gap-2 border border-gray-300 bg-white px-2.5 py-1 text-left font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {originalAccess.status === "busy" ? (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="break-words">
              Save &amp; open original
              {sourcePage
                ? ` · recorded p.${sourcePage}`
                : " · page not recorded"}
            </span>
          </button>
          {originalAccess.status !== "idle" && (
            <p
              role="status"
              data-access-status={originalAccess.status}
              className={`mb-1.5 break-words text-[11px] leading-4 ${originalAccess.status === "access_failed" || originalAccess.status === "open_failed" ? "text-red-700" : "text-gray-500"}`}
            >
              {originalAccess.message}
              {sourcePage
                ? ` Citation context remains recorded as p.${sourcePage}; the external viewer may open elsewhere.`
                : " The external viewer controls its opening position."}
            </p>
          )}
          <details>
            <summary className="cursor-pointer select-none font-medium text-amber-800">
              Original scan comparison required
              {sourcePage ? ` · recorded p.${sourcePage}` : ""}
            </summary>
            <p className="mt-1 text-gray-500">
              Stored import hash equality checks integrity only, not
              authenticity, admissibility, or safety. Opening the file does not
              record this comparison.
            </p>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Record what you compared with the original scan."
              className="mt-2 min-h-16 w-full border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-gray-500"
            />
            <button
              type="button"
              disabled={saving || reason.trim().length < 10}
              onClick={() => void onVerify(source.source_span_id, reason)}
              className="mt-2 h-8 border border-gray-300 bg-white px-3 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              Record comparison
            </button>
          </details>
        </div>
      )}
      {viewerOpen && (
        <OriginalEvidenceViewer
          open
          matterId={matterId}
          documentId={source.document_id}
          filename={source.document_name}
          recordedPage={sourcePage ?? null}
          comparison={{
            sourceSpanId: source.source_span_id,
            exactQuote: source.quote,
            ocrPage: provenance?.page ?? source.page,
            ocrConfidence: Number.isFinite(confidence) ? confidence : null,
            verification: source.current_verification_id
              ? {
                  id: source.current_verification_id,
                  reason: source.verification_reason,
                  verifiedAt: source.verified_at,
                }
              : null,
            saving,
            onVerify: (nextReason) =>
              onVerify(source.source_span_id, nextReason),
            onWithdraw: (verificationId, nextReason) =>
              onWithdraw(source.source_span_id, verificationId, nextReason),
          }}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}

function FactRow({
  matterId,
  fact,
  source,
  pdfDocumentIds,
  focused,
  saving,
  onDecision,
  onVerify,
  onWithdraw,
}: {
  matterId: string;
  fact: LitigationFactRecord;
  source?: LitigationWorkspaceRecord["fact_sources"][number];
  pdfDocumentIds: ReadonlySet<string>;
  focused: boolean;
  saving: boolean;
  onDecision: (decision: "confirmed" | "rejected") => void;
  onVerify: (sourceSpanId: string, reason: string) => Promise<void>;
  onWithdraw: (
    sourceSpanId: string,
    verificationId: string,
    reason: string,
  ) => Promise<void>;
}) {
  return (
    <article
      data-object-focus-key={`fact:${fact.id}`}
      tabIndex={-1}
      className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 border-b border-l-2 border-b-gray-200 px-3 py-4 outline-none lg:grid-cols-[132px_minmax(0,1fr)_148px_72px] ${
        focused
          ? "border-l-gray-900 bg-gray-50"
          : "border-l-transparent"
      }`}
    >
      <div className="col-span-2 text-xs font-medium tabular-nums text-gray-600 lg:col-span-1">
        {formatDate(fact.occurred_at)}
      </div>
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <p className="break-words text-sm leading-6 text-gray-900 [overflow-wrap:anywhere]">
          {fact.statement}
        </p>
        {source && (
          <SourceCitation
            matterId={matterId}
            source={source}
            canInspectOriginal={pdfDocumentIds.has(source.document_id)}
            saving={saving}
            onVerify={onVerify}
            onWithdraw={onWithdraw}
          />
        )}
        {!source && (
          <p className="mt-2 border-l-2 border-amber-300 pl-3 text-xs leading-5 text-amber-800">
            Source missing · this fact cannot satisfy cited evidence gates.
          </p>
        )}
      </div>
      <div className="min-w-0 text-xs leading-5">
        <div className={`font-medium capitalize ${proposalTone(fact.status)}`}>
          {fact.status}
        </div>
        <div className="mt-0.5 text-gray-500">
          {source ? "Exact source span linked" : "No exact source span"}
        </div>
      </div>
      <div className="flex justify-end">
        {fact.status === "proposed" && (
          <DecisionButtons disabled={saving} onDecision={onDecision} />
        )}
      </div>
    </article>
  );
}

function ClaimMatrixRow({
  matterId,
  claim,
  elements,
  links,
  evidenceStatuses,
  facts,
  factSources,
  sources,
  pdfDocumentIds,
  assessments,
  authorityStatus,
  review,
  reviews,
  focused,
  saving,
  onDecision,
  onElementDecision,
  onVerify,
  onWithdraw,
}: {
  matterId: string;
  claim: LitigationClaimRecord;
  elements: LitigationClaimElementRecord[];
  links: LitigationElementFactRecord[];
  evidenceStatuses: LitigationWorkspaceRecord["element_evidence_statuses"];
  facts: LitigationFactRecord[];
  factSources: LitigationWorkspaceRecord["fact_sources"];
  sources: LitigationWorkspaceRecord["claim_sources"];
  pdfDocumentIds: ReadonlySet<string>;
  assessments: LitigationWorkspaceRecord["legal_assessments"];
  authorityStatus: LitigationPositionAuthorityStatusRecord;
  review?: LitigationPositionReviewRecord;
  reviews: LitigationPositionReviewRecord[];
  focused: boolean;
  saving: boolean;
  onDecision: (decision: "confirmed" | "rejected") => void;
  onElementDecision: (
    elementId: string,
    decision: "confirmed" | "rejected",
  ) => void;
  onVerify: (sourceSpanId: string, reason: string) => Promise<void>;
  onWithdraw: (
    sourceSpanId: string,
    verificationId: string,
    reason: string,
  ) => Promise<void>;
}) {
  const orderedAssessments = [...assessments].sort(
    (left, right) => left.version - right.version,
  );
  const currentAssessment = orderedAssessments.at(-1);
  const currentAssessmentSources = currentAssessment
    ? legalAssessmentSourceCounts(currentAssessment.source_snapshot)
    : null;
  const latestResolvedReview = [...reviews]
    .filter((item) => item.status === "resolved")
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
    .at(-1);
  return (
    <article
      data-object-focus-key={`position:${claim.id}`}
      tabIndex={-1}
      className={`border-b border-l-2 border-b-gray-200 outline-none ${
        focused
          ? "border-l-gray-900 bg-gray-50"
          : "border-l-transparent"
      }`}
      data-testid={`claim-${claim.id}`}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 px-3 py-4 lg:grid-cols-[96px_minmax(0,1fr)_156px_72px]">
        <div className="col-span-2 text-xs font-semibold uppercase text-gray-600 lg:col-span-1">
          {claim.kind}
        </div>
        <div className="col-span-2 min-w-0 lg:col-span-1">
          <p className="break-words text-sm font-medium leading-6 text-gray-950 [overflow-wrap:anywhere]">
            {claim.title}
          </p>
          {claim.legal_basis && (
            <p className="mt-1 break-words text-xs leading-5 text-gray-600 [overflow-wrap:anywhere]">
              {claim.legal_basis}
            </p>
          )}
          {claim.uncertainty && (
            <div className="mt-2 border-l-2 border-amber-300 bg-amber-50/50 px-3 py-2 text-xs leading-5 text-gray-700">
              <div className="font-medium text-amber-800">Uncertainty</div>
              <p className="break-words [overflow-wrap:anywhere]">
                {claim.uncertainty}
              </p>
            </div>
          )}
          {currentAssessment && (
            <div className="mt-2 text-xs leading-5 text-gray-500">
              <span className="font-medium text-gray-700">
                Assessment v{currentAssessment.version}
              </span>
              {currentAssessment.source_review_id
                ? " · changed after internal review"
                : " · initial decision"}
              {currentAssessmentSources && (
                <span>
                  {` · ${currentAssessmentSources.evidenceSources} evidence ${currentAssessmentSources.evidenceSources === 1 ? "source" : "sources"}`}
                  {currentAssessmentSources.legacy
                    ? " · legacy source snapshot"
                    : ` · ${currentAssessmentSources.legalAuthorities} legal ${currentAssessmentSources.legalAuthorities === 1 ? "authority" : "authorities"}`}
                </span>
              )}
              {orderedAssessments.length > 1 && (
                <details className="mt-1">
                  <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-900">
                    View {orderedAssessments.length} versions
                  </summary>
                  <ol className="mt-2 border-l border-gray-200 pl-3">
                    {orderedAssessments.map((assessment) => (
                      <li key={assessment.id} className="mb-2 last:mb-0">
                        v{assessment.version} · {assessment.status}
                        {assessment.confidence
                          ? ` · ${assessment.confidence} confidence`
                          : ""}
                        {assessment.decision_comment
                          ? ` · ${assessment.decision_comment}`
                          : ""}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          )}
          {sources.map((source) => (
            <SourceCitation
              key={source.id}
              matterId={matterId}
              source={source}
              canInspectOriginal={pdfDocumentIds.has(source.document_id)}
              saving={saving}
              onVerify={onVerify}
              onWithdraw={onWithdraw}
            />
          ))}
          {(claim.status === "proposed" || claim.status === "confirmed") && (
            <div
              data-testid={`position-authority-readiness-${claim.id}`}
              className={`mt-3 border-l-2 px-3 py-2 text-xs leading-5 ${positionAuthorityTone(authorityStatus.status)}`}
            >
              <div className="font-semibold capitalize">
                Authority basis {authorityStatus.status}
              </div>
              <p className="mt-0.5 text-gray-600">
                {positionAuthorityReadinessCopy(
                  authorityStatus.status,
                  claim.status,
                )}
              </p>
            </div>
          )}
          {review && (
            <div className="mt-3 border-l-2 border-amber-400 bg-amber-50/50 px-3 py-2 text-xs leading-5 text-gray-700">
              <div className="font-medium text-amber-800">
                {review.review_level === 2
                  ? "Level 2 internal appeal open · not independent"
                  : `Review open · ${review.kind}`}
              </div>
              <div>{review.reason}</div>
              <div className="text-gray-500">
                Requested outcome: {review.requested_outcome}
              </div>
            </div>
          )}
        </div>
        <div className="min-w-0 text-xs leading-5">
          <div className="font-medium text-gray-700">
            {claim.confidence
              ? `${claim.confidence} confidence`
              : "Confidence not set"}
          </div>
          <div className={sources.length ? "text-gray-500" : "text-amber-800"}>
            {sources.length
              ? `${sources.length} cited ${sources.length === 1 ? "source" : "sources"}`
              : "No cited authority"}
          </div>
          <div
            className={`mt-1 font-medium capitalize ${proposalTone(claim.status)}`}
          >
            {claim.status}
          </div>
          <div
            className={review ? "mt-1 text-amber-800" : "mt-1 text-gray-500"}
          >
            {review
              ? review.review_level === 2
                ? "Level 2 review open"
                : "Review open"
              : latestResolvedReview
                ? `Level ${latestResolvedReview.review_level} review · ${
                    latestResolvedReview.independent_review === 1
                      ? `independently resolved by ${latestResolvedReview.resolved_by}`
                      : "not independent"
                  }`
                : "No open review"}
          </div>
        </div>
        <div className="flex justify-end">
          {claim.status === "proposed" && (
            <DecisionButtons disabled={saving} onDecision={onDecision} />
          )}
        </div>
      </div>
      <div className="border-t border-gray-200 bg-gray-50/30 lg:ml-[112px]">
        {elements.length === 0 ? (
          <div className="border-l-2 border-amber-300 px-3 py-4 text-xs text-amber-800">
            No legal elements mapped.
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            <div className="hidden grid-cols-[minmax(120px,0.9fr)_112px_minmax(150px,1.2fr)_64px] gap-x-4 px-3 py-2 text-[10px] font-semibold uppercase text-gray-500 lg:grid">
              <div>Legal element</div>
              <div>Evidence state</div>
              <div>Linked facts</div>
              <div className="text-right">Decision</div>
            </div>
            {elements.map((element) => {
              const elementLinks = links.filter(
                (item) => item.element_id === element.id,
              );
              const evidenceStatus = evidenceStatuses.find(
                (item) => item.element_id === element.id,
              );
              const evidenceLabel =
                evidenceStatus?.status === "supported"
                  ? "Supported"
                  : evidenceStatus?.status === "contradicted"
                    ? "Contradicted"
                    : evidenceStatus?.status === "contested"
                      ? "Both sides"
                      : evidenceStatus?.status === "pending_review"
                        ? "Pending fact review"
                        : evidenceStatus?.status === "needs_source"
                          ? "Source missing"
                          : "Evidence gap";
              const evidenceTone =
                evidenceStatus?.status === "supported"
                  ? "text-emerald-700"
                  : evidenceStatus?.status === "contradicted"
                    ? "text-red-700"
                    : evidenceStatus?.status === "contested"
                      ? "text-amber-700"
                      : evidenceStatus?.status === "pending_review"
                        ? "text-amber-800"
                        : evidenceStatus?.status === "needs_source"
                          ? "text-amber-800"
                          : "text-red-700";
              return (
                <div
                  key={element.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 px-3 py-4 lg:grid-cols-[minmax(120px,0.9fr)_112px_minmax(150px,1.2fr)_64px]"
                >
                  <div className="col-span-2 min-w-0 lg:col-span-1">
                    <div className="break-words text-sm text-gray-900 [overflow-wrap:anywhere]">
                      {element.title}
                    </div>
                    {element.description && (
                      <div className="mt-1 break-words text-xs leading-5 text-gray-500 [overflow-wrap:anywhere]">
                        {element.description}
                      </div>
                    )}
                    <div
                      className={`mt-1 text-xs capitalize ${proposalTone(element.status)}`}
                    >
                      {element.status}
                    </div>
                  </div>
                  <div className="col-start-1 row-start-2 min-w-0 text-xs leading-5 lg:col-start-auto lg:row-start-auto">
                    <div className={`font-medium ${evidenceTone}`}>
                      {evidenceLabel}
                    </div>
                    <div className="text-gray-500">
                      {evidenceStatus && evidenceStatus.pending_links > 0
                        ? `${evidenceStatus.pending_links} pending`
                        : ""}
                      {evidenceStatus &&
                      evidenceStatus.uncited_confirmed_links > 0
                        ? `${evidenceStatus.pending_links > 0 ? " · " : ""}${evidenceStatus.uncited_confirmed_links} without source`
                        : ""}
                    </div>
                  </div>
                  <div className="col-span-2 row-start-3 min-w-0 space-y-2 lg:col-span-1 lg:row-start-auto">
                    {!evidenceStatus || evidenceStatus.total_links === 0 ? (
                      <div className="text-xs font-medium text-red-700">
                        Evidence gap
                      </div>
                    ) : (
                      elementLinks.map((link) => {
                        const fact = facts.find(
                          (item) => item.id === link.fact_id,
                        );
                        const factSource = factSources.find(
                          (item) => item.fact_id === link.fact_id,
                        );
                        const factConfidence = Number(
                          factSource?.metadata?.ocrProvenance?.confidence,
                        );
                        const factPage =
                          factSource?.page ??
                          factSource?.metadata?.ocrProvenance?.page;
                        return (
                          <div
                            key={link.id}
                            className="min-w-0 border-l-2 border-gray-200 pl-2 text-xs leading-5"
                          >
                            <div
                              className={
                                link.relation === "supports"
                                  ? "font-medium text-emerald-700"
                                  : "font-medium text-red-700"
                              }
                            >
                              {link.relation}
                            </div>
                            <div className="break-words text-gray-700 [overflow-wrap:anywhere]">
                              {fact?.statement ?? "Missing fact"}
                            </div>
                            <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                              {fact && (
                                <span className={proposalTone(fact.status)}>
                                  {fact.status}
                                </span>
                              )}
                              {factSource ? (
                                <>
                                  <span className="break-all">
                                    {factSource.document_name}
                                  </span>
                                  <span>
                                    {factPage
                                      ? `p.${factPage}`
                                      : "Page not recorded"}
                                  </span>
                                  {Number.isFinite(factConfidence) && (
                                    <span
                                      className={
                                        factConfidence < 0.7
                                          ? "text-amber-800"
                                          : undefined
                                      }
                                    >
                                      OCR {Math.round(factConfidence * 100)}%
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="text-amber-800">
                                  Source missing
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div className="col-start-2 row-start-2 flex justify-end lg:col-start-auto lg:row-start-auto">
                    {element.status === "proposed" && (
                      <DecisionButtons
                        disabled={saving}
                        onDecision={(next) =>
                          onElementDecision(element.id, next)
                        }
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}

const courtWeekdays = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const;

type CourtCalendarOverrideDraft = {
  key: number;
  localDate: string;
  disposition: LitigationCourtCalendarDisposition;
  sourceReference: string;
};

function CourtCalendarWorkspace({
  matterId,
  calendars,
  authorities,
  saving,
  onMutate,
}: {
  matterId: string;
  calendars: LitigationCourtCalendarVersionRecord[];
  authorities: LitigationLegalAuthorityRegistry["versions"];
  saving: boolean;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const verifiedAuthorities = authorities.filter(
    (authority) => authority.status === "verified",
  );
  const [courtIdentifier, setCourtIdentifier] = useState("");
  const [calendarName, setCalendarName] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [sourceAuthorityVersionId, setSourceAuthorityVersionId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [weeklyNonWorkingDays, setWeeklyNonWorkingDays] = useState<number[]>([
    0, 6,
  ]);
  const [overrides, setOverrides] = useState<CourtCalendarOverrideDraft[]>([]);
  const [nextOverrideKey, setNextOverrideKey] = useState(1);
  const [verificationReasons, setVerificationReasons] = useState<
    Record<string, string>
  >({});
  const [retirementReasons, setRetirementReasons] = useState<
    Record<string, string>
  >({});

  const validOverrides =
    new Set(overrides.map((item) => item.localDate)).size ===
      overrides.length &&
    overrides.every(
      (item) =>
        item.localDate >= effectiveFrom &&
        item.localDate <= effectiveTo &&
        item.sourceReference.trim().length >= 5,
    );
  const createReady =
    courtIdentifier.trim().length > 0 &&
    calendarName.trim().length > 0 &&
    versionLabel.trim().length > 0 &&
    sourceAuthorityVersionId.length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) &&
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveTo) &&
    effectiveFrom <= effectiveTo &&
    weeklyNonWorkingDays.length >= 1 &&
    weeklyNonWorkingDays.length <= 6 &&
    validOverrides;

  function addOverride() {
    setOverrides((current) => [
      ...current,
      {
        key: nextOverrideKey,
        localDate: "",
        disposition: "closed",
        sourceReference: "",
      },
    ]);
    setNextOverrideKey((current) => current + 1);
  }

  function updateOverride(
    key: number,
    update: Partial<Omit<CourtCalendarOverrideDraft, "key">>,
  ) {
    setOverrides((current) =>
      current.map((item) => (item.key === key ? { ...item, ...update } : item)),
    );
  }

  async function createCalendar() {
    await onMutate(() =>
      createLitigationCourtCalendar(matterId, {
        courtIdentifier: courtIdentifier.trim(),
        name: calendarName.trim(),
        versionLabel: versionLabel.trim(),
        sourceAuthorityVersionId,
        effectiveFrom,
        effectiveTo,
        weeklyNonWorkingDays: [...weeklyNonWorkingDays].sort((a, b) => a - b),
        overrides: overrides.map(
          ({ localDate, disposition, sourceReference }) => ({
            localDate,
            disposition,
            sourceReference: sourceReference.trim(),
          }),
        ),
      }),
    );
  }

  return (
    <section
      className="mb-6 border-y border-gray-200"
      data-testid="court-calendars-workspace"
    >
      <div className="grid gap-5 bg-gray-50/60 px-3 py-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)] xl:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-950">
              Court calendars
            </h2>
            <span className="text-xs text-gray-500">Asia/Shanghai</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-gray-700">
              Court identifier
              <input
                aria-label="Court identifier"
                value={courtIdentifier}
                onChange={(event) => setCourtIdentifier(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
            <label className="text-xs font-medium text-gray-700">
              Calendar name
              <input
                aria-label="Calendar name"
                value={calendarName}
                onChange={(event) => setCalendarName(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
            <label className="text-xs font-medium text-gray-700">
              Version label
              <input
                aria-label="Calendar version label"
                value={versionLabel}
                onChange={(event) => setVersionLabel(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
            <label className="text-xs font-medium text-gray-700">
              Verified source authority
              <select
                aria-label="Calendar source authority"
                value={sourceAuthorityVersionId}
                onChange={(event) =>
                  setSourceAuthorityVersionId(event.target.value)
                }
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              >
                <option value="">Choose a verified authority</option>
                {verifiedAuthorities.map((authority) => (
                  <option key={authority.id} value={authority.id}>
                    {authority.title} · {authority.version_label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-700">
              Effective from
              <input
                aria-label="Calendar effective from"
                type="date"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
            <label className="text-xs font-medium text-gray-700">
              Effective to
              <input
                aria-label="Calendar effective to"
                type="date"
                value={effectiveTo}
                onChange={(event) => setEffectiveTo(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
          </div>
        </div>
        <div className="min-w-0 border-t border-gray-200 pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
          <fieldset>
            <legend className="text-xs font-medium text-gray-700">
              Weekly non-working days
            </legend>
            <div className="mt-2 grid grid-cols-4 gap-x-3 gap-y-2 sm:grid-cols-7 xl:grid-cols-4">
              {courtWeekdays.map((day) => (
                <label
                  key={day.value}
                  className="flex items-center gap-2 text-xs text-gray-700"
                >
                  <input
                    type="checkbox"
                    aria-label={`${day.label} non-working`}
                    checked={weeklyNonWorkingDays.includes(day.value)}
                    onChange={(event) =>
                      setWeeklyNonWorkingDays((current) =>
                        event.target.checked
                          ? [...current, day.value]
                          : current.filter((value) => value !== day.value),
                      )
                    }
                    className="h-4 w-4 accent-gray-900"
                  />
                  {day.label}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            disabled={saving || !createReady}
            onClick={() => void createCalendar()}
            className="mt-5 h-9 w-full bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
          >
            Create draft calendar
          </button>
        </div>
      </div>

      <div className="border-t border-gray-200 px-3 py-4 xl:px-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase text-gray-500">
            Date exceptions
          </h3>
          <button
            type="button"
            onClick={addOverride}
            className="flex h-8 items-center gap-2 border border-gray-300 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add exception
          </button>
        </div>
        {overrides.length === 0 ? (
          <p className="mt-3 text-xs text-gray-500">
            No date exceptions in this draft.
          </p>
        ) : (
          <div className="mt-3 grid gap-2">
            {overrides.map((item, index) => (
              <div
                key={item.key}
                className="grid min-w-0 gap-2 sm:grid-cols-[150px_150px_minmax(0,1fr)_32px]"
              >
                <input
                  aria-label={`Exception ${index + 1} date`}
                  type="date"
                  value={item.localDate}
                  onChange={(event) =>
                    updateOverride(item.key, { localDate: event.target.value })
                  }
                  className="h-9 min-w-0 border border-gray-300 bg-white px-2 text-sm outline-none focus:border-gray-600"
                />
                <select
                  aria-label={`Exception ${index + 1} disposition`}
                  value={item.disposition}
                  onChange={(event) =>
                    updateOverride(item.key, {
                      disposition: event.target
                        .value as LitigationCourtCalendarDisposition,
                    })
                  }
                  className="h-9 min-w-0 border border-gray-300 bg-white px-2 text-sm outline-none focus:border-gray-600"
                >
                  <option value="closed">Closed</option>
                  <option value="open">Open make-up</option>
                </select>
                <input
                  aria-label={`Exception ${index + 1} source reference`}
                  value={item.sourceReference}
                  onChange={(event) =>
                    updateOverride(item.key, {
                      sourceReference: event.target.value,
                    })
                  }
                  placeholder="Official schedule item or notice"
                  className="h-9 min-w-0 border border-gray-300 bg-white px-3 text-sm outline-none focus:border-gray-600"
                />
                <button
                  type="button"
                  aria-label={`Remove exception ${index + 1}`}
                  title="Remove exception"
                  onClick={() =>
                    setOverrides((current) =>
                      current.filter((entry) => entry.key !== item.key),
                    )
                  }
                  className="grid h-9 w-8 place-items-center text-gray-500 hover:bg-red-50 hover:text-red-700"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-gray-200">
        {calendars.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500">
            No court calendar versions recorded.
          </p>
        ) : (
          calendars.map((calendar) => (
            <article
              key={calendar.id}
              data-testid={`court-calendar-${calendar.id}`}
              className="grid min-w-0 gap-4 border-b border-gray-200 px-3 py-5 last:border-b-0 lg:grid-cols-[minmax(220px,0.85fr)_minmax(280px,1.25fr)_minmax(240px,0.8fr)] lg:px-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="break-words text-sm font-semibold text-gray-950">
                    {calendar.name}
                  </h3>
                  <span
                    className={`text-xs capitalize ${proposalTone(calendar.status)}`}
                  >
                    {calendar.status}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-[78px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
                  <dt className="text-gray-500">Court</dt>
                  <dd className="break-words text-gray-800">
                    {calendar.court_identifier}
                  </dd>
                  <dt className="text-gray-500">Version</dt>
                  <dd className="text-gray-800">
                    v{calendar.version} · {calendar.version_label}
                  </dd>
                  <dt className="text-gray-500">Effective</dt>
                  <dd className="text-gray-800">
                    {calendar.effective_from} to {calendar.effective_to}
                  </dd>
                  <dt className="text-gray-500">Non-working</dt>
                  <dd className="text-gray-800">
                    {calendar.weekly_non_working_days
                      .map(
                        (value) =>
                          courtWeekdays.find((day) => day.value === value)
                            ?.label ?? value,
                      )
                      .join(", ")}
                  </dd>
                </dl>
              </div>
              <div className="min-w-0 text-xs leading-5 text-gray-600">
                <p className="font-medium text-gray-900">
                  {calendar.source_authority_title}
                </p>
                <p>
                  {calendar.source_authority_official_identifier} ·{" "}
                  {calendar.source_authority_version_label} · source{" "}
                  {calendar.source_authority_status}
                </p>
                <div className="mt-3 break-all font-mono text-[10px] leading-4 text-gray-500">
                  Calendar sha256 {calendar.calendar_hash}
                  <br />
                  Source sha256 {calendar.source_content_sha256}
                </div>
                <div className="mt-3 border-t border-gray-200 pt-2">
                  {calendar.overrides.length === 0 ? (
                    <span className="text-gray-500">No date exceptions.</span>
                  ) : (
                    calendar.overrides.map((override) => (
                      <div
                        key={override.id}
                        className="grid grid-cols-[82px_76px_minmax(0,1fr)] gap-2 py-1"
                      >
                        <span>{override.local_date}</span>
                        <span className="capitalize text-gray-900">
                          {override.disposition === "open"
                            ? "open make-up"
                            : "closed"}
                        </span>
                        <span className="break-words text-gray-500">
                          {override.source_reference}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                {calendar.verification_comment && (
                  <p className="mt-3 border-l-2 border-emerald-600 pl-3 text-gray-700">
                    Verified: {calendar.verification_comment}
                  </p>
                )}
                {calendar.retirement_comment && (
                  <p className="mt-3 border-l-2 border-red-500 pl-3 text-red-800">
                    Retired: {calendar.retirement_comment}
                  </p>
                )}
              </div>
              <div className="min-w-0 border-t border-gray-200 pt-4 lg:border-t-0 lg:pt-0">
                {calendar.status === "draft" && (
                  <div className="grid gap-2">
                    <label className="text-xs font-medium text-gray-700">
                      Source verification reason
                      <textarea
                        aria-label={`Calendar verification reason for ${calendar.name}`}
                        value={verificationReasons[calendar.id] ?? ""}
                        onChange={(event) =>
                          setVerificationReasons((current) => ({
                            ...current,
                            [calendar.id]: event.target.value,
                          }))
                        }
                        className="mt-1 min-h-16 w-full border border-gray-300 px-3 py-2 text-sm font-normal outline-none focus:border-gray-600"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={
                        saving ||
                        (verificationReasons[calendar.id]?.trim().length ?? 0) <
                          10
                      }
                      onClick={() =>
                        void onMutate(() =>
                          verifyLitigationCourtCalendar(
                            matterId,
                            calendar.id,
                            verificationReasons[calendar.id].trim(),
                          ),
                        )
                      }
                      className="h-9 border border-gray-900 px-3 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Verify calendar
                    </button>
                  </div>
                )}
                {calendar.status !== "retired" && (
                  <div
                    className={`${calendar.status === "draft" ? "mt-4 border-t border-gray-200 pt-3" : ""}`}
                  >
                    <label className="text-xs font-medium text-gray-700">
                      Retirement reason
                      <textarea
                        aria-label={`Calendar retirement reason for ${calendar.name}`}
                        value={retirementReasons[calendar.id] ?? ""}
                        onChange={(event) =>
                          setRetirementReasons((current) => ({
                            ...current,
                            [calendar.id]: event.target.value,
                          }))
                        }
                        className="mt-1 min-h-16 w-full border border-gray-300 px-3 py-2 text-sm font-normal outline-none focus:border-gray-600"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={
                        saving ||
                        (retirementReasons[calendar.id]?.trim().length ?? 0) <
                          10
                      }
                      onClick={() =>
                        void onMutate(() =>
                          retireLitigationCourtCalendar(
                            matterId,
                            calendar.id,
                            retirementReasons[calendar.id].trim(),
                          ),
                        )
                      }
                      className="mt-2 h-8 border border-red-300 px-3 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
                    >
                      Retire calendar
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function DeadlineRuleWorkspace({
  matterId,
  rules,
  calendars,
  authorities,
  events,
  deadlines,
  saving,
  preferredEventId,
  onMutate,
}: {
  matterId: string;
  rules: LitigationDeadlineRuleRecord[];
  calendars: LitigationCourtCalendarVersionRecord[];
  authorities: LitigationLegalAuthorityRegistry["versions"];
  events: LitigationProceduralEventRecord[];
  deadlines: LitigationDeadlineRecord[];
  saving: boolean;
  preferredEventId: string;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const verifiedAuthorities = authorities.filter(
    (authority) => authority.status === "verified",
  );
  const verifiedCalendars = calendars.filter(
    (calendar) =>
      calendar.status === "verified" &&
      calendar.source_authority_status === "verified",
  );
  const [name, setName] = useState("");
  const [triggerEventType, setTriggerEventType] = useState("filing");
  const [authorityVersionId, setAuthorityVersionId] = useState("");
  const [provisionReference, setProvisionReference] = useState("");
  const [exactQuote, setExactQuote] = useState("");
  const [offsetDays, setOffsetDays] = useState("30");
  const [countingBasis, setCountingBasis] = useState<
    "calendar_days" | "business_days"
  >("calendar_days");
  const [courtCalendarVersionId, setCourtCalendarVersionId] = useState("");
  const [startPolicy, setStartPolicy] = useState<"same_day" | "next_day">(
    "next_day",
  );
  const [verificationReasons, setVerificationReasons] = useState<
    Record<string, string>
  >({});
  const [retirementReasons, setRetirementReasons] = useState<
    Record<string, string>
  >({});
  const [eventIds, setEventIds] = useState<Record<string, string>>({});
  const [deadlineTitles, setDeadlineTitles] = useState<Record<string, string>>(
    {},
  );

  const createReady =
    name.trim().length > 0 &&
    authorityVersionId.length > 0 &&
    provisionReference.trim().length > 0 &&
    exactQuote.trim().length >= 5 &&
    Number.isSafeInteger(Number(offsetDays)) &&
    Number(offsetDays) >= 0 &&
    (countingBasis === "calendar_days" || courtCalendarVersionId.length > 0);

  async function createRule() {
    await onMutate(() =>
      createLitigationDeadlineRule(matterId, {
        name: name.trim(),
        triggerEventType,
        authorityVersionId,
        provisionReference: provisionReference.trim(),
        exactQuote: exactQuote.trim(),
        offsetDays: Number(offsetDays),
        countingBasis,
        ...(countingBasis === "business_days"
          ? { courtCalendarVersionId }
          : {}),
        startPolicy,
      }),
    );
  }

  return (
    <div className="border-y border-gray-200">
      <div className="grid gap-5 bg-gray-50/60 px-3 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.72fr)] lg:px-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-950">
            Verified deadline rules
          </h2>
          <p className="mt-1 text-xs leading-5 text-gray-600">
            Create a rule only from a verified authority and an exact provision
            quote.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="min-w-0 text-xs font-medium text-gray-700">
              Rule name
              <input
                aria-label="Rule name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
            <label className="min-w-0 text-xs font-medium text-gray-700">
              Trigger event type
              <select
                aria-label="Rule trigger event type"
                value={triggerEventType}
                onChange={(event) => setTriggerEventType(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              >
                <option value="filing">Filing</option>
                <option value="service">Service</option>
                <option value="hearing_notice">Hearing notice</option>
                <option value="hearing">Hearing</option>
                <option value="judgment">Judgment</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="min-w-0 text-xs font-medium text-gray-700 sm:col-span-2">
              Verified authority version
              <select
                aria-label="Rule authority version"
                value={authorityVersionId}
                onChange={(event) => setAuthorityVersionId(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              >
                <option value="">Choose a verified authority</option>
                {verifiedAuthorities.map((authority) => (
                  <option key={authority.id} value={authority.id}>
                    {authority.title} · {authority.version_label} · effective{" "}
                    {authority.effective_from}
                    {authority.effective_to
                      ? ` to ${authority.effective_to}`
                      : " onward"}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-xs font-medium text-gray-700">
              Provision reference
              <input
                aria-label="Provision reference"
                value={provisionReference}
                onChange={(event) => setProvisionReference(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
            <label className="min-w-0 text-xs font-medium text-gray-700">
              Day offset
              <input
                aria-label="Day offset"
                type="number"
                min="0"
                max="3650"
                step="1"
                value={offsetDays}
                onChange={(event) => setOffsetDays(event.target.value)}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
            <label className="min-w-0 text-xs font-medium text-gray-700 sm:col-span-2">
              Exact provision quote
              <textarea
                aria-label="Exact provision quote"
                value={exactQuote}
                onChange={(event) => setExactQuote(event.target.value)}
                className="mt-1 min-h-20 w-full resize-y border border-gray-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-gray-600"
              />
            </label>
          </div>
        </div>
        <div className="min-w-0 border-t border-gray-200 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div className="grid gap-3">
            <label className="text-xs font-medium text-gray-700">
              Counting basis
              <select
                aria-label="Counting basis"
                value={countingBasis}
                onChange={(event) => {
                  const next = event.target.value as
                    "calendar_days" | "business_days";
                  setCountingBasis(next);
                  if (next === "calendar_days") setCourtCalendarVersionId("");
                }}
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-600"
              >
                <option value="calendar_days">Calendar days</option>
                <option value="business_days">Court business days</option>
              </select>
            </label>
            {countingBasis === "business_days" && (
              <label className="text-xs font-medium text-gray-700">
                Verified court calendar version
                <select
                  aria-label="Rule court calendar version"
                  value={courtCalendarVersionId}
                  onChange={(event) =>
                    setCourtCalendarVersionId(event.target.value)
                  }
                  className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
                >
                  <option value="">Choose a verified calendar</option>
                  {verifiedCalendars.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>
                      {calendar.name} · v{calendar.version} ·{" "}
                      {calendar.version_label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {countingBasis === "business_days" &&
              verifiedCalendars.length === 0 && (
                <p className="border-l-2 border-amber-500 pl-3 text-xs leading-5 text-amber-900">
                  Verify a source-backed court calendar before creating this
                  rule.
                </p>
              )}
            <label className="text-xs font-medium text-gray-700">
              Counting starts
              <select
                aria-label="Counting starts"
                value={startPolicy}
                onChange={(event) =>
                  setStartPolicy(event.target.value as "same_day" | "next_day")
                }
                className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
              >
                <option value="next_day">Next day</option>
                <option value="same_day">Same day</option>
              </select>
            </label>
            <button
              type="button"
              disabled={saving || !createReady}
              onClick={() => void createRule()}
              className="mt-1 h-9 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
            >
              Create draft rule
            </button>
          </div>
        </div>
      </div>

      <div className="hidden grid-cols-[minmax(210px,1.1fr)_minmax(260px,1.35fr)_minmax(260px,1fr)] gap-5 border-t border-gray-200 px-4 py-2 text-[11px] font-semibold uppercase text-gray-500 lg:grid">
        <div>Rule and policy</div>
        <div>Authority and integrity</div>
        <div>Counsel action</div>
      </div>
      {rules.length === 0 ? (
        <p className="border-t border-gray-200 px-4 py-8 text-sm text-gray-500">
          No verified deadline rules recorded.
        </p>
      ) : (
        rules.map((rule) => {
          const matchingEvents = events.filter(
            (event) =>
              event.status === "confirmed" &&
              Boolean(event.occurred_at) &&
              !event.superseded_at &&
              !event.superseded_by_event_id &&
              event.event_type === rule.trigger_event_type,
          );
          const storedEventId = eventIds[rule.id] ?? "";
          const selectedEventId = matchingEvents.some(
            (event) => event.id === storedEventId,
          )
            ? storedEventId
            : matchingEvents.some((event) => event.id === preferredEventId)
              ? preferredEventId
              : "";
          const relatedDeadlines = deadlines.filter(
            (deadline) => deadline.metadata?.deadlineRuleId === rule.id,
          );
          return (
            <article
              key={rule.id}
              data-testid={`deadline-rule-${rule.id}`}
              className="grid min-w-0 gap-4 border-t border-gray-200 px-3 py-5 lg:grid-cols-[minmax(210px,1.1fr)_minmax(260px,1.35fr)_minmax(260px,1fr)] lg:gap-5 lg:px-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="break-words text-sm font-semibold text-gray-950">
                    {rule.name}
                  </h3>
                  <span
                    className={`text-xs capitalize ${proposalTone(rule.status)}`}
                  >
                    {rule.status}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
                  <dt className="text-gray-500">Trigger</dt>
                  <dd className="break-words text-gray-800">
                    {rule.trigger_event_type.replaceAll("_", " ")}
                  </dd>
                  <dt className="text-gray-500">Calculation</dt>
                  <dd className="text-gray-800">
                    {rule.offset_days}{" "}
                    {rule.counting_basis === "business_days"
                      ? "court business days"
                      : "calendar days"}{" "}
                    · {rule.start_policy.replaceAll("_", " ")}
                  </dd>
                  <dt className="text-gray-500">Timezone</dt>
                  <dd className="text-gray-800">{rule.timezone}</dd>
                </dl>
                {rule.verification_comment && (
                  <p className="mt-3 border-l-2 border-emerald-600 pl-3 text-xs leading-5 text-gray-700">
                    Verified: {rule.verification_comment}
                  </p>
                )}
                {rule.retirement_comment && (
                  <p className="mt-3 border-l-2 border-red-500 pl-3 text-xs leading-5 text-red-800">
                    Retired: {rule.retirement_comment}
                  </p>
                )}
              </div>
              <div className="min-w-0 text-xs leading-5 text-gray-600">
                <p className="font-medium text-gray-900">
                  {rule.authority_title}
                </p>
                <p>
                  {rule.authority_official_identifier} ·{" "}
                  {rule.authority_version_label}
                </p>
                <p>
                  Effective {rule.authority_effective_from} to{" "}
                  {rule.authority_effective_to ?? "open ended"} · authority{" "}
                  {rule.authority_status}
                </p>
                <p className="mt-2 text-gray-800">{rule.provision_reference}</p>
                <blockquote className="mt-2 whitespace-pre-wrap break-words border-l border-gray-300 pl-3 text-gray-700">
                  {rule.exact_quote}
                </blockquote>
                <div className="mt-3 break-all font-mono text-[10px] leading-4 text-gray-500">
                  Rule sha256 {rule.rule_hash}
                  <br />
                  Authority sha256 {rule.authority_content_sha256}
                  {rule.court_calendar_version_id && (
                    <>
                      <br />
                      Calendar version {rule.court_calendar_version_id}
                      <br />
                      Calendar sha256 {rule.court_calendar_hash}
                    </>
                  )}
                </div>
                {relatedDeadlines.length > 0 && (
                  <p className="mt-2 text-xs text-gray-500">
                    {relatedDeadlines.length} derived deadline
                    {relatedDeadlines.length === 1 ? "" : "s"}
                  </p>
                )}
              </div>
              <div className="min-w-0 border-t border-gray-200 pt-4 lg:border-t-0 lg:pt-0">
                {rule.status === "draft" && (
                  <div className="grid gap-2">
                    <label className="text-xs font-medium text-gray-700">
                      Verification reason
                      <textarea
                        aria-label={`Verification reason for ${rule.name}`}
                        value={verificationReasons[rule.id] ?? ""}
                        onChange={(event) =>
                          setVerificationReasons((current) => ({
                            ...current,
                            [rule.id]: event.target.value,
                          }))
                        }
                        placeholder="Record counsel's calculation-policy review."
                        className="mt-1 min-h-16 w-full border border-gray-300 px-3 py-2 text-sm font-normal outline-none focus:border-gray-600"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={
                        saving ||
                        (verificationReasons[rule.id]?.trim().length ?? 0) < 10
                      }
                      onClick={() =>
                        void onMutate(() =>
                          verifyLitigationDeadlineRule(
                            matterId,
                            rule.id,
                            verificationReasons[rule.id].trim(),
                          ),
                        )
                      }
                      className="h-9 border border-gray-900 px-3 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Verify rule
                    </button>
                  </div>
                )}
                {rule.status === "verified" && (
                  <div className="grid gap-2">
                    <label className="text-xs font-medium text-gray-700">
                      Confirmed matching event
                      <select
                        aria-label={`Calculation event for ${rule.name}`}
                        value={selectedEventId}
                        onChange={(event) =>
                          setEventIds((current) => ({
                            ...current,
                            [rule.id]: event.target.value,
                          }))
                        }
                        className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
                      >
                        <option value="">Choose a confirmed event</option>
                        {matchingEvents.map((event) => (
                          <option key={event.id} value={event.id}>
                            Current v{event.event_version ?? 1} · {event.title}{" "}
                            · {formatDate(event.occurred_at)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs font-medium text-gray-700">
                      Proposed deadline title
                      <input
                        aria-label={`Deadline title for ${rule.name}`}
                        value={deadlineTitles[rule.id] ?? ""}
                        onChange={(event) =>
                          setDeadlineTitles((current) => ({
                            ...current,
                            [rule.id]: event.target.value,
                          }))
                        }
                        className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm font-normal outline-none focus:border-gray-600"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={
                        saving ||
                        !selectedEventId ||
                        !(deadlineTitles[rule.id]?.trim().length > 0)
                      }
                      onClick={() =>
                        void onMutate(() =>
                          calculateLitigationDeadlineRule(matterId, rule.id, {
                            eventId: selectedEventId,
                            title: deadlineTitles[rule.id].trim(),
                          }),
                        )
                      }
                      className="h-9 bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                    >
                      Calculate proposal
                    </button>
                  </div>
                )}
                {rule.status !== "retired" && (
                  <div className="mt-4 border-t border-gray-200 pt-3">
                    <label className="text-xs font-medium text-gray-700">
                      Retirement reason
                      <input
                        aria-label={`Retirement reason for ${rule.name}`}
                        value={retirementReasons[rule.id] ?? ""}
                        onChange={(event) =>
                          setRetirementReasons((current) => ({
                            ...current,
                            [rule.id]: event.target.value,
                          }))
                        }
                        className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm font-normal outline-none focus:border-gray-600"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={
                        saving ||
                        (retirementReasons[rule.id]?.trim().length ?? 0) < 10
                      }
                      onClick={() =>
                        void onMutate(() =>
                          retireLitigationDeadlineRule(
                            matterId,
                            rule.id,
                            retirementReasons[rule.id].trim(),
                          ),
                        )
                      }
                      className="mt-2 h-8 border border-red-300 px-3 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
                    >
                      Retire rule
                    </button>
                  </div>
                )}
              </div>
            </article>
          );
        })
      )}
    </div>
  );
}

function ProceduralEventRow({
  event,
  correction,
  chunks,
  saving,
  onDecision,
  onCorrect,
}: {
  event: LitigationProceduralEventRecord;
  correction?: LitigationWorkspaceRecord["procedural_event_corrections"][number];
  chunks: DocumentChunk[];
  saving: boolean;
  onDecision: (decision: "confirmed" | "rejected") => void;
  onCorrect: (
    payload: Parameters<typeof correctLitigationProceduralEvent>[2],
  ) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [correctedTitle, setCorrectedTitle] = useState(event.title);
  const [correctedAt, setCorrectedAt] = useState(
    toDateTimeLocal(event.occurred_at),
  );
  const [reason, setReason] = useState("");
  const [correctionChunkId, setCorrectionChunkId] = useState("");
  const [correctionQuote, setCorrectionQuote] = useState("");
  const [formError, setFormError] = useState("");
  const superseded = Boolean(
    event.superseded_at || event.superseded_by_event_id,
  );
  const currentConfirmed = event.status === "confirmed" && !superseded;
  const hasExistingSource = Boolean(event.primary_source_span_id);
  const changed = (() => {
    if (!correctedAt) return false;
    const parsed = new Date(correctedAt);
    return (
      correctedTitle.trim() !== event.title ||
      (!Number.isNaN(parsed.valueOf()) &&
        parsed.toISOString() !== event.occurred_at)
    );
  })();
  const correctionReady =
    correctedTitle.trim().length > 0 &&
    correctedAt.length > 0 &&
    reason.trim().length >= 10 &&
    changed &&
    (hasExistingSource ||
      (correctionChunkId.length > 0 && correctionQuote.trim().length > 0));

  function openEditor() {
    setCorrectedTitle(event.title);
    setCorrectedAt(toDateTimeLocal(event.occurred_at));
    setReason("");
    setCorrectionChunkId("");
    setCorrectionQuote("");
    setFormError("");
    setEditing(true);
  }

  async function submitCorrection() {
    setFormError("");
    try {
      const occurredAt = new Date(correctedAt).toISOString();
      let source:
        | { sourceChunkId: string; quoteStart: number; quoteEnd: number }
        | undefined;
      if (!hasExistingSource) {
        const chunk = chunks.find((item) => item.id === correctionChunkId);
        const quote = correctionQuote.trim();
        const quoteStart = chunk?.text.indexOf(quote) ?? -1;
        if (!chunk || !quote || quoteStart < 0) {
          throw new Error(
            "The correction quote must exactly match the selected source chunk.",
          );
        }
        source = {
          sourceChunkId: chunk.id,
          quoteStart,
          quoteEnd: quoteStart + quote.length,
        };
      }
      await onCorrect({
        title: correctedTitle.trim(),
        occurredAt,
        reason: reason.trim(),
        ...(source ? { source } : {}),
      });
      setEditing(false);
    } catch (submissionError) {
      setFormError(
        submissionError instanceof Error
          ? submissionError.message
          : "Unable to record correction",
      );
    }
  }

  return (
    <article
      data-testid={`procedural-event-${event.id}`}
      className="border-b border-gray-200"
    >
      <div className="grid min-w-0 gap-3 py-5 md:grid-cols-[170px_minmax(0,1fr)_auto]">
        <div className="text-sm font-medium text-gray-900">
          {formatDate(event.occurred_at)}
        </div>
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-gray-900 [overflow-wrap:anywhere]">
            {event.title}
          </p>
          <p className="mt-1 text-xs capitalize text-gray-500">
            {event.event_type.replaceAll("_", " ")}
          </p>
          {event.quote && (
            <p className="mt-2 break-words border-l-2 border-gray-300 pl-3 text-xs leading-5 text-gray-500 [overflow-wrap:anywhere]">
              “{event.quote}” · {event.document_name}
            </p>
          )}
          <div
            className={`mt-2 text-xs font-medium ${
              superseded
                ? "text-red-700"
                : currentConfirmed
                  ? "text-emerald-700"
                  : proposalTone(event.status)
            }`}
          >
            {superseded
              ? `Superseded event v${event.event_version ?? 1}`
              : currentConfirmed
                ? `Current confirmed v${event.event_version ?? 1}`
                : event.status}
          </div>
          <dl className="mt-3 grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 border-l-2 border-gray-300 pl-3 text-[11px] leading-4">
            <dt className="text-gray-500">Event lineage</dt>
            <dd className="break-all font-mono text-[10px] text-gray-600">
              {event.event_lineage_hash || "Unavailable"}
            </dd>
            {event.supersedes_event_id && (
              <>
                <dt className="text-gray-500">Supersedes</dt>
                <dd className="break-all text-gray-700">
                  {event.supersedes_event_id}
                </dd>
              </>
            )}
            {event.superseded_by_event_id && (
              <>
                <dt className="text-gray-500">Replaced by</dt>
                <dd className="break-all text-gray-700">
                  {event.superseded_by_event_id}
                </dd>
              </>
            )}
            {(event.correction_reason || correction?.reason) && (
              <>
                <dt className="text-gray-500">Reason</dt>
                <dd className="break-words text-gray-700 [overflow-wrap:anywhere]">
                  {event.correction_reason || correction?.reason}
                </dd>
              </>
            )}
            {correction?.correction_hash && (
              <>
                <dt className="text-gray-500">Correction</dt>
                <dd className="break-all font-mono text-[10px] text-gray-600">
                  {correction.correction_hash}
                </dd>
              </>
            )}
          </dl>
          {superseded && (
            <p className="mt-2 text-xs text-gray-500">
              Correction locked; superseded events are immutable.
            </p>
          )}
        </div>
        <div className="flex items-start justify-end">
          {event.status === "proposed" ? (
            <DecisionButtons disabled={saving} onDecision={onDecision} />
          ) : currentConfirmed ? (
            <button
              type="button"
              disabled={saving}
              onClick={openEditor}
              className="flex h-8 items-center gap-2 border border-gray-300 px-3 text-xs font-medium text-gray-700 hover:border-gray-500 hover:bg-gray-50 disabled:opacity-40"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              Correct event
            </button>
          ) : null}
        </div>
      </div>
      {editing && currentConfirmed && (
        <form
          aria-label={`Correct ${event.title}`}
          className="grid gap-3 border-t border-gray-200 bg-gray-50/50 px-3 py-4 sm:grid-cols-2"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void submitCorrection();
          }}
        >
          <div className="min-w-0 sm:col-span-2">
            <div className="text-xs font-semibold text-gray-950">
              Record replacement event
            </div>
            <p className="mt-1 text-xs leading-5 text-gray-600">
              The confirmed event remains in lineage history. Deadline
              confirmation is a separate action.
            </p>
          </div>
          <label className="min-w-0 text-xs font-medium text-gray-700">
            Corrected title
            <input
              aria-label="Corrected event title"
              value={correctedTitle}
              onChange={(inputEvent) =>
                setCorrectedTitle(inputEvent.target.value)
              }
              className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-gray-700">
            Corrected date and time
            <input
              aria-label="Corrected event date and time"
              type="datetime-local"
              value={correctedAt}
              onChange={(inputEvent) => setCorrectedAt(inputEvent.target.value)}
              className="mt-1 h-9 w-full border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-gray-600"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-gray-700 sm:col-span-2">
            Correction reason
            <textarea
              aria-label="Correction reason"
              value={reason}
              onChange={(inputEvent) => setReason(inputEvent.target.value)}
              placeholder="Record why the confirmed event is incorrect (10+ characters)."
              className="mt-1 min-h-20 w-full resize-y border border-gray-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-gray-600"
            />
          </label>
          <div className="min-w-0 sm:col-span-2">
            {hasExistingSource ? (
              <p className="border-l-2 border-gray-300 pl-3 text-xs leading-5 text-gray-600">
                Existing exact source retained:{" "}
                {event.document_name || "source span on record"}.
              </p>
            ) : (
              <SourceFields
                chunks={chunks}
                chunkId={correctionChunkId}
                quote={correctionQuote}
                onChunkId={setCorrectionChunkId}
                onQuote={setCorrectionQuote}
                selectLabel="Correction source record"
                quoteLabel="Exact correction source quote"
                emptyOption="Choose an exact source"
              />
            )}
          </div>
          {formError && (
            <p className="text-xs text-red-700 sm:col-span-2">{formError}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => setEditing(false)}
              className="h-8 border border-gray-300 px-3 text-xs font-medium text-gray-700 hover:bg-white disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !correctionReady}
              className="h-8 bg-gray-950 px-3 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-40"
            >
              Record correction
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

function DeadlineRow({
  deadline,
  saving,
  task,
  focusedTaskId,
  focusedDeadlineId,
  onDecision,
  onAddTask,
}: {
  deadline: LitigationDeadlineRecord;
  saving: boolean;
  task: AletheiaMatterTaskRecord | null;
  focusedTaskId: string | null;
  focusedDeadlineId: string | null;
  onDecision: (decision: "confirmed" | "rejected") => void;
  onAddTask: () => void;
}) {
  const ruleDerived = typeof deadline.metadata?.deadlineRuleId === "string";
  const businessDayTrace = Array.isArray(deadline.metadata?.businessDayTrace)
    ? (deadline.metadata.businessDayTrace as Array<{
        date?: unknown;
        counted?: unknown;
        reason?: unknown;
        countedDays?: unknown;
      }>)
    : [];
  const traceReasonLabels: Record<string, string> = {
    regular_working_day: "Working day",
    weekly_non_working_day: "Weekend / weekly closure",
    override_closed: "Closed exception",
    override_open: "Open make-up day",
    zero_offset_trigger_date: "Trigger date; no days counted",
  };
  const taskIsFocused = Boolean(task && task.id === focusedTaskId);
  const deadlineIsFocused = deadline.id === focusedDeadlineId;
  return (
    <article
      data-object-focus-key={`deadline:${deadline.id}`}
      tabIndex={-1}
      className={`grid gap-3 border-b border-l-2 border-b-gray-200 px-3 py-5 outline-none md:grid-cols-[170px_minmax(0,1fr)_minmax(160px,240px)] ${
        taskIsFocused || deadlineIsFocused
          ? "border-l-gray-900 bg-gray-50"
          : "border-l-transparent"
      }`}
    >
      <div className="text-sm font-medium text-gray-900">
        {formatDate(deadline.due_at)}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{deadline.title}</p>
        <p className="mt-1 text-xs leading-5 text-gray-500">
          {deadline.rule_label} · {deadline.rule_version}
        </p>
        {deadline.stale_at && (
          <div className="mt-3 border-l-2 border-red-500 pl-3 text-xs leading-5 text-red-800">
            <div className="font-semibold">Stale · action blocked</div>
            <div className="break-words [overflow-wrap:anywhere]">
              {deadline.stale_reason}
            </div>
            <div className="mt-1 text-gray-700">
              Recovery: verify a replacement calendar and rule, then calculate a
              new proposal from the confirmed event.
            </div>
          </div>
        )}
        <p className="mt-2 text-xs leading-5 text-gray-600">
          {deadline.calculation}
        </p>
        {ruleDerived && (
          <dl className="mt-3 grid max-w-3xl grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1 border-l-2 border-gray-300 pl-3 text-xs leading-5">
            <dt className="text-gray-500">Trigger date</dt>
            <dd className="break-words text-gray-700">
              {String(deadline.metadata.triggerDate)} ·{" "}
              {String(deadline.metadata.timezone)}
            </dd>
            <dt className="text-gray-500">Policy</dt>
            <dd className="break-words text-gray-700">
              {String(deadline.metadata.offsetDays)}{" "}
              {String(deadline.metadata.countingBasis) === "business_days"
                ? "court business days"
                : "calendar days"}{" "}
              · {String(deadline.metadata.startPolicy).replaceAll("_", " ")}
            </dd>
            <dt className="text-gray-500">Provision</dt>
            <dd className="break-words text-gray-700">
              {String(deadline.metadata.provisionReference)}
            </dd>
            {deadline.court_calendar_version_id && (
              <>
                <dt className="text-gray-500">Calendar</dt>
                <dd className="break-all text-gray-700">
                  {deadline.court_calendar_version_id}
                  <br />
                  <span className="font-mono text-[10px]">
                    {deadline.court_calendar_hash}
                  </span>
                </dd>
                <dt className="text-gray-500">Algorithm</dt>
                <dd className="break-words text-gray-700">
                  {String(deadline.metadata.courtCalendarCalculationAlgorithm)}
                </dd>
              </>
            )}
          </dl>
        )}
        {businessDayTrace.length > 0 && (
          <div
            className="mt-3 max-w-3xl border-t border-gray-200 pt-2"
            data-testid={`business-day-trace-${deadline.id}`}
          >
            <div className="grid grid-cols-[94px_minmax(0,1fr)_72px] gap-3 py-1 text-[11px] font-semibold uppercase text-gray-500">
              <span>Date</span>
              <span>Calendar treatment</span>
              <span>Count</span>
            </div>
            {businessDayTrace.map((entry, index) => (
              <div
                key={`${String(entry.date)}-${index}`}
                className="grid grid-cols-[94px_minmax(0,1fr)_72px] gap-3 border-t border-gray-100 py-1.5 text-xs leading-5 text-gray-700"
              >
                <span>{String(entry.date)}</span>
                <span>
                  {traceReasonLabels[String(entry.reason)] ??
                    String(entry.reason)}
                </span>
                <span>
                  {entry.counted
                    ? `Yes · ${String(entry.countedDays)}`
                    : "Skipped"}
                </span>
              </div>
            ))}
          </div>
        )}
        {deadline.calculation_hash && (
          <p className="mt-2 max-w-full whitespace-normal font-mono text-[10px] leading-4 text-gray-500 [overflow-wrap:anywhere]">
            Calculation {deadline.calculation_hash}
          </p>
        )}
        {deadline.quote && (
          <p className="mt-2 border-l-2 border-gray-300 pl-3 text-xs text-gray-500">
            “{deadline.quote}” · {deadline.document_name}
          </p>
        )}
        {!deadline.stale_at && (
          <div
            className={`mt-2 text-xs capitalize ${proposalTone(deadline.status)}`}
          >
            {deadline.status}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-3 md:items-end">
        {task && (
          <div
            data-testid={`deadline-task-${task.id}`}
            data-object-focus-key={`task:${task.id}`}
            tabIndex={-1}
            className="min-w-0 max-w-full text-left text-xs leading-5 outline-none md:text-right"
          >
            <div className="break-words font-medium text-gray-900">
              {task.title}
            </div>
            <div className="text-gray-500">
              状态：
              {task.invalidated_at
                ? "已失效"
                : task.status === "completed"
                  ? "已完成"
                  : "待办"}
            </div>
          </div>
        )}
        {task?.invalidated_at ? (
          <div
            data-testid={`invalidated-task-${task.id}`}
            className="max-w-52 border-l-2 border-red-500 pl-3 text-xs leading-5 text-red-800"
          >
            <div className="font-semibold">Task invalidated</div>
            <div className="break-words [overflow-wrap:anywhere]">
              {task.invalidated_reason}
            </div>
            <div className="mt-1 text-gray-700">
              Replace the stale deadline before adding a new work-queue task.
            </div>
          </div>
        ) : deadline.stale_at ? null : deadline.status === "proposed" ? (
          <DecisionButtons disabled={saving} onDecision={onDecision} />
        ) : deadline.status === "confirmed" ||
          deadline.status === "completed" ? (
          task ? null : (
            <button
              type="button"
              disabled={saving}
              onClick={onAddTask}
              className="flex h-8 items-center gap-2 border border-gray-200 px-3 text-xs font-medium text-gray-700 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-40"
            >
              <ClipboardPlus className="h-3.5 w-3.5" />
              Add to work queue
            </button>
          )
        ) : null}
      </div>
    </article>
  );
}

function metadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : "未记录";
}

function nextMatterAction({
  documents,
  facts,
  claims,
  deadlines,
  positionReviews,
}: {
  documents: AletheiaMatterDocumentRecord[];
  facts: LitigationFactRecord[];
  claims: LitigationClaimRecord[];
  deadlines: LitigationDeadlineRecord[];
  positionReviews: LitigationPositionReviewRecord[];
}): { title: string; detail: string; view: Extract<ViewId, "facts" | "positions" | "procedure" | "artifacts"> } {
  if (documents.length === 0) {
    return {
      title: "导入案卷",
      detail: "尚未导入案件材料。先导入并检查案卷，再开展事实整理。",
      view: "facts",
    };
  }
  if (documents.some((document) => document.parsed_status !== "parsed")) {
    return {
      title: "处理案卷",
      detail: "有案卷仍在解析、需要 OCR 或处理失败，请先完成材料处理。",
      view: "facts",
    };
  }
  if (facts.some((fact) => fact.status === "proposed")) {
    return {
      title: "复核事实",
      detail: "存在尚未确认的事实提案，请结合原始材料逐项复核。",
      view: "facts",
    };
  }
  if (!facts.some((fact) => fact.status === "confirmed")) {
    return {
      title: "检索并确认摘录/事实",
      detail: "当前没有已确认事实，请从案卷检索摘录并建立可追溯事实。",
      view: "facts",
    };
  }
  if (
    claims.some((claim) => claim.status === "proposed") ||
    positionReviews.some((review) => review.status === "open")
  ) {
    return {
      title: "复核请求权抗辩",
      detail: "存在请求权、抗辩提案或开放复核，请先完成律师判断。",
      view: "positions",
    };
  }
  if (!claims.some((claim) => claim.status === "confirmed")) {
    return {
      title: "建立矩阵",
      detail: "当前没有已确认的请求权或抗辩，请建立要件、事实与依据矩阵。",
      view: "positions",
    };
  }
  if (deadlines.some((deadline) => deadline.status === "proposed")) {
    return {
      title: "确认期限",
      detail: "存在期限候选，请核对起算点、规则与法院日历后确认。",
      view: "procedure",
    };
  }
  if (!deadlines.some((deadline) => deadline.status === "confirmed")) {
    return {
      title: "核对程序时钟",
      detail: "当前没有已确认期限，请核对程序事件和期限计算。",
      view: "procedure",
    };
  }
  return {
    title: "起草或复核文书",
    detail: "关键案件状态已确认，可进入文书与庭审工作区继续处理。",
    view: "artifacts",
  };
}

function Overview({
  facts,
  claims,
  deadlines,
  documents,
  positionReviews,
  matter,
  onNavigate,
}: {
  facts: LitigationFactRecord[];
  claims: LitigationClaimRecord[];
  deadlines: LitigationDeadlineRecord[];
  documents: AletheiaMatterDocumentRecord[];
  positionReviews: LitigationPositionReviewRecord[];
  matter: AletheiaMatterRecord;
  onNavigate: (view: Extract<ViewId, "facts" | "positions" | "procedure" | "artifacts">) => void;
}) {
  const nextAction = nextMatterAction({
    documents,
    facts,
    claims,
    deadlines,
    positionReviews,
  });
  const metrics = [
    ["案卷材料", documents.length],
    [
      "已确认事实",
      facts.filter((item) => item.status === "confirmed").length,
    ],
    [
      "已确认请求权/抗辩",
      claims.filter((item) => item.status === "confirmed").length,
    ],
    [
      "已确认期限",
      deadlines.filter((item) => item.status === "confirmed").length,
    ],
  ];
  const intakeFields = [
    ["我方诉讼地位", metadataText(matter.metadata, "representationRole")],
    ["对方当事人", metadataText(matter.metadata, "opposingParties")],
    ["受理法院", metadataText(matter.metadata, "court")],
    ["案号", metadataText(matter.metadata, "caseNumber")],
    ["程序阶段", metadataText(matter.metadata, "procedureStage")],
    ["收案日期", metadataText(matter.metadata, "intakeDate")],
  ];
  return (
    <div>
      <section aria-labelledby="next-action-heading" className="border-y border-gray-300 bg-gray-50 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium text-gray-500">下一步</div>
            <h2 id="next-action-heading" className="mt-1 text-base font-semibold text-gray-950">
              {nextAction.title}
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-gray-600">
              {nextAction.detail}
            </p>
          </div>
          <button
            type="button"
            data-testid="overview-next-action"
            data-next-view={nextAction.view}
            onClick={() => onNavigate(nextAction.view)}
            className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 sm:w-auto"
          >
            继续处理
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </section>

      <section className="grid border-y border-gray-200 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value], index) => (
          <div
            key={String(label)}
            className={`px-4 py-4 ${index > 0 ? "border-t border-gray-200 sm:border-l" : ""} ${index === 1 ? "sm:border-t-0" : ""} ${index === 2 ? "xl:border-t-0" : ""} ${index === 3 ? "xl:border-t-0" : ""}`}
          >
            <div className="text-xs font-medium text-gray-500">{label}</div>
            <div className="mt-1.5 text-xl font-semibold text-gray-950">
              {value}
            </div>
          </div>
        ))}
      </section>
      <section className="mt-7">
        <SectionHeading
          title="接案信息"
          detail="以下内容来自创建案件时保存的记录。"
        />
        <dl className="grid border-t border-gray-200 sm:grid-cols-2 xl:grid-cols-3">
          {intakeFields.map(([label, value], index) => (
            <div
              key={label}
              className={`min-w-0 border-b border-gray-200 py-3 sm:px-4 ${index % 2 === 1 ? "sm:border-l" : ""} xl:border-l xl:first:border-l-0 xl:[&:nth-child(4)]:border-l-0`}
            >
              <dt className="text-xs text-gray-500">{label}</dt>
              <dd className="mt-1 break-words text-sm font-medium text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="mt-7 grid gap-7 xl:grid-cols-2">
        <div>
          <SectionHeading
            title="近期已确认期限"
            detail="仅显示经律师确认的日期。"
          />
          <div className="border-t border-gray-200">
            {deadlines
              .filter((item) => item.status === "confirmed")
              .slice(0, 4)
              .map((item) => (
                <div
                  key={item.id}
                  className="flex justify-between gap-4 border-b border-gray-200 py-4 text-sm"
                >
                  <span>{item.title}</span>
                  <span className="shrink-0 text-gray-500">
                    {formatDate(item.due_at)}
                  </span>
                </div>
              ))}
            {!deadlines.some((item) => item.status === "confirmed") && (
              <EmptyState text="暂无已确认期限。" />
            )}
          </div>
        </div>
        <div>
          <SectionHeading
            title="待复核"
            detail="未确认提案不会改变案件已确认状态。"
          />
          <div className="border-t border-gray-200">
            {[
              [
                "事实提案",
                facts.filter((item) => item.status === "proposed").length,
              ],
              [
                "请求权与抗辩提案",
                claims.filter((item) => item.status === "proposed").length,
              ],
              [
                "期限候选",
                deadlines.filter((item) => item.status === "proposed").length,
              ],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="flex justify-between border-b border-gray-200 py-4 text-sm"
              >
                <span>{label}</span>
                <span className="text-gray-500">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mt-8 border-t border-gray-200 pt-5 text-xs leading-5 text-gray-500">
        <FileText className="mr-2 inline h-4 w-4" /> 文书与庭审材料仅使用已确认的案件状态。
      </section>
    </div>
  );
}
