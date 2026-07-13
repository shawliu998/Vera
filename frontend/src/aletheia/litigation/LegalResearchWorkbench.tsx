"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Download,
  FileCheck2,
  FileUp,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  AletheiaApiError,
  approveAletheiaLegalQaAnswer,
  approveAletheiaLegalOpinion,
  confirmLegalResearchExcerpt,
  createLegalResearchInputManifest,
  createLegalResearchMemo,
  createLegalResearchQueryPreview,
  createLegalResearchRequest,
  createAletheiaLegalOpinion,
  decideAletheiaApproval,
  downloadAletheiaLegalOpinionDocx,
  executeLegalResearchSearch,
  exportAletheiaLegalOpinionDocx,
  fetchLegalResearchSource,
  getAletheiaMatter,
  getLitigationWorkspace,
  getLegalResearchIssueTree,
  importLegalResearchManualSource,
  requestLegalResearchQueryApproval,
  requestLegalResearchSourceApproval,
  resolveAletheiaReview,
  saveLegalResearchIssueTree,
  type AletheiaHumanCheckpointRecord,
  type AletheiaMatterDetail,
  type AletheiaWorkProductRecord,
  type LegalResearchFindingInput,
  type LegalResearchIssueNode,
  type LegalResearchManualSourceDocumentKind,
  type LegalResearchProvider,
  type LitigationFactSourceRecord,
  type LitigationWorkspaceRecord,
} from "@/app/lib/aletheiaApi";

type Json = Record<string, unknown>;
type ApprovalState = {
  checkpoint: AletheiaHumanCheckpointRecord;
  status: "open" | "approved" | "rejected";
};

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function text(value: unknown, fallback = "未记录") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function shortHash(value: unknown) {
  const hash = text(value, "不可用");
  return hash.length > 28 ? `${hash.slice(0, 18)}…${hash.slice(-8)}` : hash;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function evidenceLocation(source: Pick<LitigationFactSourceRecord, "document_name" | "page" | "section">) {
  const parts = [source.document_name.trim()];
  if (source.page !== null) parts.push(`第 ${source.page} 页`);
  else if (source.section?.trim()) parts.push(source.section.trim());
  return parts.filter(Boolean).join(" · ");
}

function requestData(product: AletheiaWorkProductRecord) {
  return object(product.content.request);
}

function requestIdOf(product: AletheiaWorkProductRecord) {
  if (product.kind === "legal_research_request") return product.id;
  return text(product.content.requestId, "");
}

function sourceType(snapshot: Json): LegalResearchFindingInput["citations"][number]["sourceType"] {
  const kind = snapshot.documentKind;
  return kind === "statute" ||
    kind === "judicial_interpretation" ||
    kind === "case"
    ? kind
    : "manual";
}

function documentKindLabel(value: unknown) {
  if (value === "statute") return "法规";
  if (value === "judicial_interpretation") return "司法解释";
  if (value === "case") return "案例";
  if (value === "other") return "其他法律资料";
  return "资料类型待核";
}

const fieldClass =
  "w-full border border-gray-300 bg-white px-3 py-2 text-[13px] leading-5 text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-700";
const labelClass = "mb-1.5 block text-xs font-medium text-gray-700";
const secondaryButton =
  "inline-flex h-8 items-center justify-center gap-2 border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40";
const primaryButton =
  "inline-flex h-8 items-center justify-center gap-2 border border-gray-950 bg-gray-950 px-3 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40";

export function LegalResearchWorkbench({ matterId }: { matterId: string }) {
  const [detail, setDetail] = useState<AletheiaMatterDetail | null>(null);
  const [litigationWorkspace, setLitigationWorkspace] = useState<LitigationWorkspaceRecord | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [queryApprovals, setQueryApprovals] = useState<Record<string, ApprovalState>>({});
  const [sourceApprovals, setSourceApprovals] = useState<Record<string, ApprovalState>>({});
  const [issueNodes, setIssueNodes] = useState<LegalResearchIssueNode[]>([]);
  const [issueTreeId, setIssueTreeId] = useState("");
  const [issueLoading, setIssueLoading] = useState(false);
  const issueRequestIdRef = useRef("");
  const manualSourceDetailsRef = useRef<HTMLDetailsElement>(null);
  const importedExcerptRef = useRef<HTMLTextAreaElement>(null);

  const [title, setTitle] = useState("");
  const [selectedFactIds, setSelectedFactIds] = useState<string[]>([]);
  const [selectedProceduralEventIds, setSelectedProceduralEventIds] = useState<string[]>([]);
  const [jurisdiction, setJurisdiction] = useState("中华人民共和国");
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [question, setQuestion] = useState("");
  const [provider, setProvider] = useState<LegalResearchProvider>("pkulaw");
  const [query, setQuery] = useState("");
  const [protectedTerms, setProtectedTerms] = useState("");
  const [manualDocumentId, setManualDocumentId] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualContent, setManualContent] = useState("");
  const [manualDocumentKind, setManualDocumentKind] =
    useState<LegalResearchManualSourceDocumentKind>("statute");
  const [manualVersion, setManualVersion] = useState("");
  const [manualEffectiveDate, setManualEffectiveDate] = useState("");
  const [manualEffectiveTo, setManualEffectiveTo] = useState("");
  const [manualPublicationDate, setManualPublicationDate] = useState("");
  const [manualSourceState, setManualSourceState] = useState<{
    status: "idle" | "submitting" | "success" | "error";
    message: string;
  }>({ status: "idle", message: "" });
  const [importedSnapshotId, setImportedSnapshotId] = useState("");
  const [excerptDrafts, setExcerptDrafts] = useState<Record<string, { quote: string; comment: string }>>({});
  const [selectedExcerptIds, setSelectedExcerptIds] = useState<string[]>([]);
  const [conclusion, setConclusion] = useState("");
  const [uncertainty, setUncertainty] = useState("");
  const [position, setPosition] = useState<"supporting" | "adverse" | "neutral">("supporting");
  const [confidence, setConfidence] = useState<"high" | "medium" | "low">("medium");
  const [opinionAnswerId, setOpinionAnswerId] = useState("");
  const [coverTitle, setCoverTitle] = useState("");
  const [coverAddressee, setCoverAddressee] = useState("");
  const [coverLimitation, setCoverLimitation] = useState("");
  const [lawyerReference, setLawyerReference] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [next, nextLitigationWorkspace] = await Promise.all([
        getAletheiaMatter(matterId),
        getLitigationWorkspace(matterId),
      ]);
      setDetail(next);
      setLitigationWorkspace(nextLitigationWorkspace);
      const requests = next.workProducts
        .filter((item) => item.kind === "legal_research_request")
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      setSelectedRequestId((current) =>
        current && requests.some((item) => item.id === current)
          ? current
          : (requests[0]?.id ?? ""),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "法律研究记录加载失败。");
    } finally {
      setLoading(false);
    }
  }, [matterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const products = useMemo(() => detail?.workProducts ?? [], [detail]);
  const requests = useMemo(
    () =>
      products
        .filter((item) => item.kind === "legal_research_request")
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [products],
  );
  const selectedRequest = requests.find((item) => item.id === selectedRequestId) ?? null;
  const selectedRequestHasCaseContext = Boolean(
    selectedRequest &&
    typeof selectedRequest.content.caseContextId === "string" &&
    typeof selectedRequest.content.caseContextHash === "string" &&
    typeof selectedRequest.content.caseContextContentHash === "string",
  );
  const eligibleFacts = useMemo(() => {
    const workspace = litigationWorkspace;
    if (!workspace) return [];
    const sourcesByFact = new Map<string, LitigationFactSourceRecord[]>();
    for (const source of workspace.fact_sources) {
      const sources = sourcesByFact.get(source.fact_id) ?? [];
      sources.push(source);
      sourcesByFact.set(source.fact_id, sources);
    }
    return workspace.facts
      .filter((fact) => fact.status === "confirmed" && (sourcesByFact.get(fact.id)?.length ?? 0) > 0)
      .map((fact) => ({ fact, source: sourcesByFact.get(fact.id)![0] }));
  }, [litigationWorkspace]);
  const eligibleProceduralEvents = useMemo(
    () => (litigationWorkspace?.procedural_events ?? []).filter(
      (event) =>
        event.status === "confirmed" &&
        Boolean(event.primary_source_span_id) &&
        Boolean(event.quote?.trim()) &&
        !event.superseded_by_event_id &&
        !event.superseded_at,
    ),
    [litigationWorkspace],
  );
  const selectedLocalItemCount = selectedFactIds.length + selectedProceduralEventIds.length;

  useEffect(() => {
    if (!selectedRequest) {
      issueRequestIdRef.current = "";
      setIssueNodes([]);
      setIssueTreeId("");
      return;
    }
    let current = true;
    if (issueRequestIdRef.current !== selectedRequest.id) {
      issueRequestIdRef.current = selectedRequest.id;
      setIssueNodes([]);
      setIssueTreeId("");
    }
    setIssueLoading(true);
    void getLegalResearchIssueTree(matterId, selectedRequest.id)
      .then((product) => {
        if (!current) return;
        const tree = object(product.content.tree);
        const nodes = array(tree.nodes) as LegalResearchIssueNode[];
        setIssueTreeId(nodes.length ? product.id : "");
        setIssueNodes(
          nodes.length
            ? [...nodes].sort((left, right) =>
                Number(left.parentId !== null) - Number(right.parentId !== null) ||
                left.order - right.order,
              )
            : [{
                id: "root",
                parentId: null,
                title: text(requestData(selectedRequest).question, "待界定的核心法律问题"),
                description: null,
                status: "open",
                order: 0,
              }],
        );
      })
      .catch((issueError) => {
        if (!current) return;
        const initialRoot: LegalResearchIssueNode = {
          id: "root",
          parentId: null,
          title: text(requestData(selectedRequest).question, "待界定的核心法律问题"),
          description: null,
          status: "open",
          order: 0,
        };
        if (issueError instanceof AletheiaApiError && issueError.status === 404) {
          setIssueTreeId("");
          setIssueNodes([initialRoot]);
        } else {
          setError(issueError instanceof Error ? issueError.message : "争点树加载失败。");
        }
      })
      .finally(() => current && setIssueLoading(false));
    return () => {
      current = false;
    };
  }, [matterId, selectedRequest]);
  const scoped = useMemo(
    () => products.filter((item) => requestIdOf(item) === selectedRequestId),
    [products, selectedRequestId],
  );
  const plans = scoped
    .filter((item) => item.kind === "legal_research_query_plan")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const results = scoped
    .filter((item) => item.kind === "legal_research_search_result")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const snapshots = scoped
    .filter((item) => item.kind === "external_source_workpaper")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const excerpts = scoped
    .filter((item) => item.kind === "legal_research_excerpt")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const manifests = scoped
    .filter((item) => item.kind === "legal_research_input_manifest")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const memos = scoped
    .filter((item) => item.kind === "legal_research_memo" || item.kind === "legal_qa_answer")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const acceptedMemos = memos.filter(
    (item) => item.kind === "legal_qa_answer" && item.status === "accepted" && !item.stale_at,
  );
  const opinions = products
    .filter((item) => item.kind === "legal_opinion")
    .sort((a, b) => b.version - a.version || b.created_at.localeCompare(a.created_at));
  const currentOpinion = opinions[0] ?? null;
  const boundExcerptIds = new Set(
    array(manifests[0]?.content.excerpts).map((item) =>
      text(object(item).excerptId, ""),
    ),
  );
  const selectedExcerptsAreBound =
    selectedExcerptIds.length > 0 &&
    selectedExcerptIds.every((id) => boundExcerptIds.has(id));
  const manualEffectiveDateRequired =
    manualDocumentKind === "statute" ||
    manualDocumentKind === "judicial_interpretation";
  const manualSourceReady = Boolean(
    selectedRequest &&
    selectedRequestHasCaseContext &&
    issueTreeId &&
    !issueLoading &&
    manualDocumentId.trim() &&
    manualTitle.trim() &&
    manualContent.trim() &&
    (!manualEffectiveDateRequired || manualEffectiveDate),
  );

  useEffect(() => {
    if (!importedSnapshotId || loading || !importedExcerptRef.current) return;
    importedExcerptRef.current.scrollIntoView({ block: "center" });
    importedExcerptRef.current.focus({ preventScroll: true });
  }, [importedSnapshotId, loading, snapshots.length]);

  async function mutate(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError("");
    setNotice("");
    setManualSourceState({ status: "idle", message: "" });
    try {
      await action();
      await load();
    } catch (mutationError) {
      const apiError = mutationError instanceof AletheiaApiError ? mutationError : null;
      setUnavailable(apiError?.code === "legal_source_unavailable");
      setError(
        apiError?.code === "legal_source_unavailable"
          ? "授权法律数据源当前不可用：尚未配置 API，或本地加密凭据不可读取。未发送任何备用请求。"
          : mutationError instanceof Error
            ? mutationError.message
            : "操作失败。",
      );
    } finally {
      setBusy("");
    }
  }

  async function createOpinion() {
    if (!opinionAnswerId) return;
    await mutate("opinion-create", async () => {
      await createAletheiaLegalOpinion(matterId, {
        answerId: opinionAnswerId,
        cover: {
          title: coverTitle || undefined,
          addressee: coverAddressee || undefined,
          limitation: coverLimitation || undefined,
          lawyerReference: lawyerReference || undefined,
        },
      });
      setNotice("法律意见书已从已采纳研究结论建立，并进入独立复核。");
    });
  }

  async function exportOpinion(opinion: AletheiaWorkProductRecord) {
    await mutate(`opinion-export-${opinion.id}`, async () => {
      const exported = await exportAletheiaLegalOpinionDocx(matterId, opinion.id);
      const blob = await downloadAletheiaLegalOpinionDocx(matterId, exported.exportId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${opinion.title}-v${opinion.version}.docx`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("已导出并下载当前批准版本 DOCX。");
    });
  }

  async function addRequest() {
    await mutate("request", async () => {
      const created = await createLegalResearchRequest(matterId, {
        title,
        jurisdiction,
        asOfDate,
        question,
        factIds: selectedFactIds,
        proceduralEventIds: selectedProceduralEventIds,
      });
      setSelectedRequestId(created.id);
      setTitle("");
      setQuestion("");
      setSelectedFactIds([]);
      setSelectedProceduralEventIds([]);
      setNotice("本地研究事项已保存，尚未发生网络请求。");
    });
  }

  async function previewQuery() {
    if (!selectedRequest || !issueTreeId) {
      setError("请先保存当前争点树，再生成脱敏预览。");
      return;
    }
    await mutate("preview", async () => {
      await createLegalResearchQueryPreview(matterId, selectedRequest.id, {
        issueTreeId,
        provider,
        query,
        protectedTerms: protectedTerms.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean),
      });
      setNotice("脱敏检索词已保存为待审批计划；尚未发送至外部数据源。");
    });
  }

  async function saveIssues() {
    if (!selectedRequest || issueNodes.length === 0) return;
    await mutate("issues", async () => {
      const saved = await saveLegalResearchIssueTree(
        matterId,
        selectedRequest.id,
        issueNodes.map((node, index) => ({
          ...node,
          title: node.title.trim(),
          description: node.description?.trim() || null,
          order: node.parentId === null ? 0 : index,
        })),
      );
      setIssueTreeId(saved.id);
      setNotice("本地争点树已保存；检索词仍需律师另行填写和审批。");
    });
  }

  function addIssueChild() {
    const root = issueNodes.find((node) => node.parentId === null);
    if (!root) return;
    const id = `issue-${Date.now().toString(36)}`;
    setIssueNodes((current) => [...current, {
      id,
      parentId: root.id,
      title: "",
      description: null,
      status: "open",
      order: current.length,
    }]);
  }

  function updateIssue(id: string, patch: Partial<LegalResearchIssueNode>) {
    setIssueNodes((current) => current.map((node) => node.id === id ? { ...node, ...patch } : node));
  }

  async function requestQueryApproval(plan: AletheiaWorkProductRecord) {
    await mutate(`query-approval-${plan.id}`, async () => {
      const checkpoint = await requestLegalResearchQueryApproval(matterId, plan.id);
      setQueryApprovals((current) => ({ ...current, [plan.id]: { checkpoint, status: "open" } }));
      setNotice("已创建单次检索审批，请核对出站文本后作出决定。");
    });
  }

  async function decideQuery(planId: string, decision: "approved" | "rejected") {
    const approval = queryApprovals[planId];
    if (!approval) return;
    await mutate(`query-decision-${planId}`, async () => {
      const checkpoint = await decideAletheiaApproval(matterId, approval.checkpoint.id, { decision });
      setQueryApprovals((current) => ({ ...current, [planId]: { checkpoint, status: decision } }));
      setNotice(decision === "approved" ? "本次检索已批准，仍需点击执行才会联网。" : "本次检索已拒绝，未发生网络请求。");
    });
  }

  async function executeQuery(plan: AletheiaWorkProductRecord) {
    const approval = queryApprovals[plan.id];
    if (!approval || approval.status !== "approved") return;
    await mutate(`search-${plan.id}`, async () => {
      await executeLegalResearchSearch(matterId, plan.id, approval.checkpoint.id);
      setNotice("单次检索已执行，候选目录已保存到本案。");
    });
  }

  async function requestSourceApproval(planId: string, resultId: string, documentId: string) {
    const key = `${resultId}:${documentId}`;
    await mutate(`source-approval-${key}`, async () => {
      const checkpoint = await requestLegalResearchSourceApproval(matterId, planId, resultId, documentId);
      setSourceApprovals((current) => ({ ...current, [key]: { checkpoint, status: "open" } }));
      setNotice("已创建该候选的单次下载审批，尚未下载正文。");
    });
  }

  async function decideSource(key: string, decision: "approved" | "rejected") {
    const approval = sourceApprovals[key];
    if (!approval) return;
    await mutate(`source-decision-${key}`, async () => {
      const checkpoint = await decideAletheiaApproval(matterId, approval.checkpoint.id, { decision });
      setSourceApprovals((current) => ({ ...current, [key]: { checkpoint, status: decision } }));
      setNotice(decision === "approved" ? "来源下载已批准，仍需点击保存快照。" : "来源下载已拒绝。");
    });
  }

  async function downloadSource(planId: string, resultId: string, documentId: string) {
    const key = `${resultId}:${documentId}`;
    const approval = sourceApprovals[key];
    if (!approval || approval.status !== "approved") return;
    await mutate(`fetch-${key}`, async () => {
      await fetchLegalResearchSource(matterId, planId, resultId, documentId, approval.checkpoint.id);
      setNotice("来源正文已保存为本地不可变快照。");
    });
  }

  async function importManualSource() {
    if (!selectedRequest || !manualSourceReady) return;
    setManualSourceState({ status: "submitting", message: "正在保存本地快照…" });
    setError("");
    setNotice("");
    try {
      const created = await importLegalResearchManualSource(
        matterId,
        selectedRequest.id,
        {
          documentId: manualDocumentId.trim(),
          title: manualTitle.trim(),
          content: manualContent,
          documentKind: manualDocumentKind,
          ...(manualVersion.trim() ? { version: manualVersion.trim() } : {}),
          ...(manualEffectiveDate ? { effectiveDate: manualEffectiveDate } : {}),
          ...(manualEffectiveTo ? { effectiveTo: manualEffectiveTo } : {}),
          ...(manualPublicationDate ? { publicationDate: manualPublicationDate } : {}),
        },
      );
      setImportedSnapshotId(created.id);
      setManualSourceState({
        status: "success",
        message: "本地快照已保存。请继续逐字确认摘录。",
      });
      setManualDocumentId("");
      setManualTitle("");
      setManualContent("");
      setManualVersion("");
      setManualEffectiveDate("");
      setManualEffectiveTo("");
      setManualPublicationDate("");
      if (manualSourceDetailsRef.current) manualSourceDetailsRef.current.open = false;
      await load();
    } catch (importError) {
      const apiError = importError instanceof AletheiaApiError ? importError : null;
      let message = importError instanceof Error ? importError.message : "本地法律资料导入失败。";
      if (apiError?.code === "issue_tree_required") {
        message = "请先保存当前争点树，再导入本地法律资料。";
      } else if (apiError?.code === "case_context_required") {
        message = "当前研究事项缺少可用案卷上下文。请重新建立研究事项并选择已确认案卷输入。";
      } else if (
        apiError?.code === "invalid_input" &&
        manualEffectiveDate &&
        manualEffectiveTo &&
        manualEffectiveTo < manualEffectiveDate
      ) {
        message = "失效日期不得早于生效日期。";
      } else if (apiError?.code === "invalid_input") {
        message = "导入失败。请检查本地编号、资料类型及日期后重试。";
      }
      setImportedSnapshotId("");
      setManualSourceState({ status: "error", message });
    }
  }

  async function confirmExcerpt(snapshot: AletheiaWorkProductRecord) {
    const draft = excerptDrafts[snapshot.id];
    if (!draft) return;
    await mutate(`excerpt-${snapshot.id}`, async () => {
      const created = await confirmLegalResearchExcerpt(matterId, snapshot.id, draft);
      setSelectedExcerptIds((current) => [...new Set([...current, created.id])]);
      setExcerptDrafts((current) => ({ ...current, [snapshot.id]: { quote: "", comment: "" } }));
      setNotice("精确原文摘录已由律师确认并保存哈希。");
    });
  }

  async function bindManifest() {
    if (!selectedRequest || selectedExcerptIds.length === 0) return;
    await mutate("manifest", async () => {
      await createLegalResearchInputManifest(matterId, selectedRequest.id, selectedExcerptIds);
      setNotice("已将所选律师确认摘录绑定为本次研究输入清单。");
    });
  }

  async function saveMemo(insufficient: boolean) {
    const manifest = manifests[0];
    if (!manifest) return;
    await mutate(insufficient ? "insufficient" : "memo", async () => {
      const boundIds = new Set(
        array(manifest.content.excerpts).map((item) =>
          text(object(item).excerptId, ""),
        ),
      );
      const selected = excerpts.filter(
        (item) => selectedExcerptIds.includes(item.id) && boundIds.has(item.id),
      );
      const findings: LegalResearchFindingInput[] = insufficient
        ? []
        : [{
            conclusion,
            confidence,
            position,
            uncertainty: uncertainty.trim() || null,
            citations: selected.map((excerpt) => {
              const snapshot = snapshots.find((item) => item.id === excerpt.content.snapshotId);
              const metadata = object(snapshot?.content.snapshot);
              return {
                snapshotId: text(excerpt.content.snapshotId, ""),
                quote: text(excerpt.content.quote, ""),
                sourceType: sourceType(metadata),
                effectiveFrom: text(metadata.effectiveDate, "") || null,
                effectiveTo: text(metadata.effectiveTo, "") || null,
                caseVerificationStatus:
                  metadata.caseVerificationStatus === "verified" || metadata.caseVerificationStatus === "unverified"
                    ? metadata.caseVerificationStatus
                    : null,
              };
            }),
          }];
      const result = await createLegalResearchMemo(matterId, manifest.id, findings);
      setConclusion("");
      setUncertainty("");
      setNotice("code" in result ? "已记录“依据不足”，未生成无来源结论。" : "律师研究结论已保存，等待人工复核。");
    });
  }

  if (loading && !detail) {
    return <div className="flex min-h-64 items-center justify-center text-sm text-gray-500"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />加载法律研究记录</div>;
  }

  return (
    <section data-testid="legal-research-workbench" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-4">
        <div>
          <h2 className="text-base font-semibold text-gray-950">法律研究</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-gray-600">本地研究事项、律师可见脱敏检索、授权来源快照与精确摘录。外部检索和正文下载均需逐次审批并单独执行。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className={secondaryButton} data-testid="legal-research-refresh">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />刷新
        </button>
      </div>

      {error && <div role="alert" className={`mt-4 border-l-2 px-3 py-2 text-xs leading-5 ${unavailable ? "border-amber-500 bg-amber-50 text-amber-900" : "border-red-500 bg-red-50 text-red-800"}`}><AlertTriangle className="mr-2 inline h-4 w-4" />{error}</div>}
      {notice && <div role="status" className="mt-4 border-l-2 border-gray-400 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-700">{notice}</div>}

      <div className="mt-5 grid min-w-0 gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-w-0 border-r border-gray-200 pr-0 xl:pr-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-gray-900">研究事项</h3>
            <span className="text-[11px] tabular-nums text-gray-500">{requests.length}</span>
          </div>
          <div className="max-h-64 overflow-y-auto border-y border-gray-200 xl:max-h-[520px]">
            {requests.length === 0 ? <p className="py-5 text-xs leading-5 text-gray-500">尚无研究事项。下方表单仅保存到本机。</p> : requests.map((item) => (
              <button key={item.id} type="button" onClick={() => { setSelectedRequestId(item.id); setSelectedExcerptIds([]); }} className={`block w-full border-b border-gray-100 px-2 py-3 text-left ${item.id === selectedRequestId ? "bg-gray-100" : "hover:bg-gray-50"}`}>
                <span className="block truncate text-xs font-medium text-gray-900">{item.title}</span>
                <span className="mt-1 block text-[11px] text-gray-500">{text(requestData(item).jurisdiction)} · {text(requestData(item).asOfDate)}</span>
                {typeof item.content.caseContextId === "string" && typeof item.content.caseContextHash === "string" && <span className="mt-1 block text-[11px] font-medium text-gray-600">案卷输入已绑定</span>}
              </button>
            ))}
          </div>
          <details className="mt-4 border-b border-gray-200 pb-4">
            <summary className="cursor-pointer py-1 text-xs font-semibold text-gray-900">新建本地研究事项</summary>
          <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void addRequest(); }} data-testid="legal-research-request-form">
            <label><span className={labelClass}>事项名称</span><input className={fieldClass} value={title} maxLength={240} onChange={(e) => setTitle(e.target.value)} required /></label>
            <fieldset className="min-w-0 border-y border-gray-200 py-2" data-testid="research-fact-selection">
              <legend className="sr-only">已确认事实</legend>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-700">已确认事实</span>
                <span className="shrink-0 text-[11px] tabular-nums text-gray-500">已选 {selectedFactIds.length} / {eligibleFacts.length}</span>
              </div>
              {eligibleFacts.length === 0 ? (
                <p className="py-3 text-xs leading-5 text-gray-500">暂无可选事实。请先前往“事实与证据”确认事实并关联证据来源。</p>
              ) : (
                <div className="mt-1 divide-y divide-gray-100">
                  {eligibleFacts.map(({ fact, source }) => (
                    <label key={fact.id} className="grid min-h-11 cursor-pointer grid-cols-[18px_minmax(0,1fr)] gap-2 py-2.5">
                      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={selectedFactIds.includes(fact.id)} onChange={(event) => setSelectedFactIds((current) => event.target.checked ? [...current, fact.id] : current.filter((id) => id !== fact.id))} />
                      <span className="min-w-0"><span className="block break-words text-xs leading-5 text-gray-900">{fact.statement}</span><span className="mt-0.5 block break-words text-[11px] leading-4 text-gray-500">{evidenceLocation(source)}</span></span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <fieldset className="min-w-0 border-b border-gray-200 pb-2" data-testid="research-procedural-event-selection">
              <legend className="sr-only">已确认程序事项</legend>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-700">已确认程序事项</span>
                <span className="shrink-0 text-[11px] tabular-nums text-gray-500">已选 {selectedProceduralEventIds.length} / {eligibleProceduralEvents.length}</span>
              </div>
              {eligibleProceduralEvents.length === 0 ? (
                <p className="py-3 text-xs leading-5 text-gray-500">暂无可选程序事项。请先前往“程序时钟”确认事项并补全原文来源。</p>
              ) : (
                <div className="mt-1 divide-y divide-gray-100">
                  {eligibleProceduralEvents.map((event) => (
                    <label key={event.id} className="grid min-h-11 cursor-pointer grid-cols-[18px_minmax(0,1fr)] gap-2 py-2.5">
                      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={selectedProceduralEventIds.includes(event.id)} onChange={(change) => setSelectedProceduralEventIds((current) => change.target.checked ? [...current, event.id] : current.filter((id) => id !== event.id))} />
                      <span className="min-w-0"><span className="block break-words text-xs leading-5 text-gray-900">{event.title}{event.occurred_at ? ` · ${event.occurred_at.slice(0, 10)}` : ""}</span><span className="mt-0.5 block break-words text-[11px] leading-4 text-gray-500">{evidenceLocation({ document_name: event.document_name ?? "来源文书", page: event.page ?? null, section: null })}</span></span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <p className="text-[11px] leading-4 text-gray-500">共选择 {selectedLocalItemCount} 项案卷输入；保存后将绑定为不可变研究上下文。</p>
            <div className="grid grid-cols-2 gap-2">
              <label><span className={labelClass}>法域</span><input className={fieldClass} value={jurisdiction} maxLength={120} onChange={(e) => setJurisdiction(e.target.value)} required /></label>
              <label><span className={labelClass}>检索基准日</span><input type="date" className={fieldClass} value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} required /></label>
            </div>
            <label><span className={labelClass}>内部法律问题</span><textarea className={`${fieldClass} min-h-20 resize-y`} value={question} maxLength={2000} onChange={(e) => setQuestion(e.target.value)} required /></label>
            <button type="submit" disabled={busy === "request" || !title.trim() || !question.trim() || !jurisdiction.trim() || !asOfDate || selectedLocalItemCount === 0} className={primaryButton}>{busy === "request" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FileCheck2 className="h-3.5 w-3.5" />}保存到本案</button>
          </form>
          </details>
        </aside>

        <div className="min-w-0 space-y-7">
          {!selectedRequest ? (
            <div className="border-y border-gray-200 py-12 text-center text-sm text-gray-500">选择或新建研究事项后开始。</div>
          ) : (
            <>
              <section aria-labelledby="issues-heading" data-testid="legal-research-issue-tree">
                <div className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-200 pb-2"><div><h3 id="issues-heading" className="text-sm font-semibold text-gray-950">1. 本地争点树</h3><p className="mt-1 text-xs text-gray-500">律师界定核心争点及直属子争点。仅保存到本案，不生成或发送检索词。</p></div><button type="button" className={secondaryButton} onClick={addIssueChild} disabled={issueLoading || issueNodes.length === 0}><Plus className="h-3.5 w-3.5" />添加子争点</button></div>
                {issueLoading ? <div className="flex items-center py-5 text-xs text-gray-500"><LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin" />读取争点树</div> : <div className="mt-3 space-y-2">{issueNodes.map((node) => <div key={node.id} className={`grid min-w-0 gap-2 ${node.parentId === null ? "border-l-2 border-gray-900 bg-gray-50 p-3" : "ml-4 border-l border-gray-300 py-2 pl-3 sm:ml-7 sm:grid-cols-[minmax(0,1fr)_150px_auto]"}`}>
                  <div className="min-w-0"><label><span className={labelClass}>{node.parentId === null ? "核心争点" : "子争点"}</span><input className={fieldClass} value={node.title} maxLength={240} onChange={(event) => updateIssue(node.id, { title: event.target.value })} /></label>{node.parentId === null && <label className="mt-2 block"><span className={labelClass}>说明（可选）</span><input className={fieldClass} value={node.description ?? ""} maxLength={4000} onChange={(event) => updateIssue(node.id, { description: event.target.value })} /></label>}</div>
                  <label><span className={labelClass}>状态</span><select className={fieldClass} value={node.status} onChange={(event) => updateIssue(node.id, { status: event.target.value as LegalResearchIssueNode["status"] })}><option value="open">待研究</option><option value="needs_material">待补材料</option><option value="resolved">已解决</option></select></label>
                  {node.parentId !== null && <button type="button" className={secondaryButton} onClick={() => setIssueNodes((current) => current.filter((item) => item.id !== node.id))}>移除</button>}
                </div>)}</div>}
                <div className="mt-3 flex flex-wrap items-center gap-3"><button type="button" className={primaryButton} disabled={busy === "issues" || issueNodes.length === 0 || issueNodes.some((node) => !node.title.trim())} onClick={() => void saveIssues()}><FileCheck2 className="h-3.5 w-3.5" />保存本地争点树</button><span className="text-[11px] text-gray-500">{issueNodes.length} 个节点 · 一层子争点</span></div>
              </section>

              <section aria-labelledby="query-heading">
                <div className="flex items-end justify-between gap-3 border-b border-gray-200 pb-2"><div className="min-w-0"><h3 id="query-heading" className="text-sm font-semibold text-gray-950">2. 检索计划与出站审批</h3><p className="mt-1 text-xs text-gray-500">内部问题不会发送；仅批准后的右侧脱敏文本可单次出站。</p></div><span className="shrink-0 whitespace-nowrap text-[11px] text-gray-500">{plans.length} 个计划</span></div>
                <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2" data-testid="research-query-comparison">
                  <div className="min-w-0 border-t-2 border-gray-400 bg-gray-50 p-3"><div className="text-[11px] font-semibold text-gray-500">内部法律问题 · 仅本机</div><p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-gray-900">{text(requestData(selectedRequest).question)}</p></div>
                  <div className="min-w-0 border-t-2 border-gray-950 bg-gray-50 p-3"><div className="text-[11px] font-semibold text-gray-700">拟出站检索词 · 精确文本</div><textarea className={`${fieldClass} mt-2 min-h-24 resize-y font-mono text-xs`} value={query} maxLength={600} onChange={(e) => setQuery(e.target.value)} placeholder="仅填写公开法律概念，不粘贴案件事实" /></div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-end">
                  <label><span className={labelClass}>授权数据源</span><select className={fieldClass} value={provider} onChange={(e) => setProvider(e.target.value as LegalResearchProvider)}><option value="pkulaw">北大法宝 API</option><option value="wolters">威科先行 API</option><option value="official">官方法律来源 API</option></select></label>
                  <label><span className={labelClass}>需脱敏词（逗号或换行分隔）</span><input className={fieldClass} value={protectedTerms} onChange={(e) => setProtectedTerms(e.target.value)} placeholder="当事人、项目代号、案号" /></label>
                  <button type="button" disabled={!query.trim() || !issueTreeId || issueLoading || busy === "preview"} onClick={() => void previewQuery()} className={secondaryButton}><ShieldCheck className="h-3.5 w-3.5" />生成脱敏预览</button>
                </div>
                {!issueLoading && !issueTreeId && <p data-testid="research-query-issue-required" className="mt-2 text-xs leading-5 text-amber-800">请先保存当前争点树，脱敏预览将绑定该持久化版本。</p>}
                <div className="mt-4 border-y border-gray-200">
                  {plans.length === 0 ? <p className="py-5 text-xs text-gray-500">尚无待审批检索计划。</p> : plans.map((plan) => {
                    const preview = object(plan.content.preview);
                    const approval = queryApprovals[plan.id];
                    return <article key={plan.id} className="grid min-w-0 gap-3 border-b border-gray-100 py-3 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="min-w-0"><div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500"><span>{text(plan.content.provider).toUpperCase()}</span><span>{String(preview.redactions ?? 0)} 处脱敏</span><span className="font-mono">{shortHash(preview.queryHash)}</span></div><p className="mt-2 break-words font-mono text-xs leading-5 text-gray-900">{text(preview.query)}</p></div>
                      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                        {!approval && <button type="button" className={secondaryButton} disabled={busy.includes(plan.id)} onClick={() => void requestQueryApproval(plan)}>申请单次审批</button>}
                        {approval?.status === "open" && <><button type="button" className={primaryButton} disabled={busy.includes(plan.id)} onClick={() => void decideQuery(plan.id, "approved")}><Check className="h-3.5 w-3.5" />批准</button><button type="button" className={secondaryButton} disabled={busy.includes(plan.id)} onClick={() => void decideQuery(plan.id, "rejected")}><X className="h-3.5 w-3.5" />拒绝</button></>}
                        {approval?.status === "approved" && <button type="button" className={primaryButton} disabled={busy.includes(plan.id)} onClick={() => void executeQuery(plan)}><Send className="h-3.5 w-3.5" />执行一次检索</button>}
                        {approval?.status === "rejected" && <span className="text-xs text-gray-500">已拒绝 · 未执行</span>}
                      </div>
                    </article>;
                  })}
                </div>
              </section>

              <section aria-labelledby="sources-heading">
                <div className="flex items-end justify-between gap-3 border-b border-gray-200 pb-2"><div className="min-w-0"><h3 id="sources-heading" className="text-sm font-semibold text-gray-950">3. 候选来源与本地快照</h3><p className="mt-1 text-xs text-gray-500">候选目录不含正文；外部正文需另行审批，本地导入不会联网。</p></div><span className="shrink-0 whitespace-nowrap text-[11px] text-gray-500">{snapshots.length} 份快照</span></div>
                <details ref={manualSourceDetailsRef} className="border-b border-gray-200 py-3" data-testid="manual-legal-source-import">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-gray-900 marker:hidden">
                    <FileUp className="h-3.5 w-3.5 text-gray-600" />导入本地法律资料
                  </summary>
                  <form className="mt-3 space-y-3" data-testid="manual-legal-source-form" onSubmit={(event) => { event.preventDefault(); void importManualSource(); }}>
                    <p className="border-l-2 border-gray-400 pl-3 text-xs leading-5 text-gray-600">本地保存，不会联网。律师手工导入，尚未自动核验；导入后仍需逐字确认摘录。</p>
                    <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(160px,0.7fr)_minmax(240px,1.3fr)_180px]">
                      <label><span className={labelClass}>本地编号</span><input className={fieldClass} value={manualDocumentId} maxLength={240} pattern="[^\s]+" onChange={(event) => setManualDocumentId(event.target.value)} placeholder="例：civil-code-563-local" required /></label>
                      <label><span className={labelClass}>标题</span><input className={fieldClass} value={manualTitle} maxLength={1000} onChange={(event) => setManualTitle(event.target.value)} required /></label>
                      <label><span className={labelClass}>资料类型</span><select className={fieldClass} value={manualDocumentKind} onChange={(event) => setManualDocumentKind(event.target.value as LegalResearchManualSourceDocumentKind)}><option value="statute">法规</option><option value="judicial_interpretation">司法解释</option><option value="other">其他</option></select></label>
                    </div>
                    <label><span className={labelClass}>法律资料正文</span><textarea className={`${fieldClass} min-h-36 resize-y font-mono text-xs`} value={manualContent} maxLength={2_000_000} onChange={(event) => setManualContent(event.target.value)} placeholder="粘贴需保存并逐字核对的完整正文" required /></label>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <label><span className={labelClass}>版本（可选）</span><input className={fieldClass} value={manualVersion} maxLength={240} onChange={(event) => setManualVersion(event.target.value)} /></label>
                      <label><span className={labelClass}>生效日期{manualEffectiveDateRequired ? "" : "（可选）"}</span><input type="date" className={fieldClass} value={manualEffectiveDate} onChange={(event) => setManualEffectiveDate(event.target.value)} required={manualEffectiveDateRequired} /></label>
                      <label><span className={labelClass}>失效日期（可选）</span><input type="date" className={fieldClass} value={manualEffectiveTo} onChange={(event) => setManualEffectiveTo(event.target.value)} /></label>
                      <label><span className={labelClass}>发布日期（可选）</span><input type="date" className={fieldClass} value={manualPublicationDate} onChange={(event) => setManualPublicationDate(event.target.value)} /></label>
                    </div>
                    {!selectedRequestHasCaseContext ? <p className="text-xs leading-5 text-amber-800">当前研究事项缺少可用案卷上下文。请重新建立研究事项并选择已确认案卷输入。</p> : issueLoading ? <p className="text-xs leading-5 text-gray-500">正在核对当前争点树。</p> : !issueTreeId ? <p className="text-xs leading-5 text-amber-800">请先保存当前争点树，再导入本地法律资料。</p> : null}
                    <button type="submit" className={primaryButton} disabled={!manualSourceReady || manualSourceState.status === "submitting"}>{manualSourceState.status === "submitting" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}{manualSourceState.status === "submitting" ? "正在导入" : "导入并保存快照"}</button>
                  </form>
                </details>
                {manualSourceState.status !== "idle" && <div role={manualSourceState.status === "error" ? "alert" : "status"} className={`mt-3 border-l-2 px-3 py-2 text-xs leading-5 ${manualSourceState.status === "error" ? "border-red-500 bg-red-50 text-red-800" : manualSourceState.status === "success" ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-gray-400 bg-gray-50 text-gray-700"}`}>{manualSourceState.message}</div>}
                {results.length === 0 ? <div className="py-6 text-xs leading-5 text-gray-500">执行经批准的检索后，候选来源将显示在此。数据源不可用时保留既有本地记录，不自动切换来源。</div> : results.map((result) => {
                  const planId = text(result.content.queryPlanId, "");
                  return <div key={result.id} className="border-b border-gray-200">{array(result.content.candidates).map((raw) => {
                    const candidate = object(raw); const documentId = text(candidate.documentId, ""); const key = `${result.id}:${documentId}`; const approval = sourceApprovals[key]; const alreadySaved = snapshots.some((item) => item.content.searchResultId === result.id && item.content.documentId === documentId);
                    return <article key={key} className="grid min-w-0 gap-3 border-t border-gray-100 py-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="min-w-0"><h4 className="break-words text-[13px] font-medium text-gray-900">{text(candidate.title)}</h4><p className="mt-1 break-words text-xs leading-5 text-gray-600">{text(candidate.summary, "无摘要；下载前仅可核对来源目录元数据。")}</p></div>
                      <div className="flex flex-wrap items-center gap-2 lg:justify-end">{alreadySaved ? <span className="text-xs font-medium text-emerald-700">已保存本地快照</span> : !approval ? <button className={secondaryButton} type="button" onClick={() => void requestSourceApproval(planId, result.id, documentId)}><Download className="h-3.5 w-3.5" />申请下载审批</button> : approval.status === "open" ? <><button className={primaryButton} type="button" onClick={() => void decideSource(key, "approved")}><Check className="h-3.5 w-3.5" />批准</button><button className={secondaryButton} type="button" onClick={() => void decideSource(key, "rejected")}><X className="h-3.5 w-3.5" />拒绝</button></> : approval.status === "approved" ? <button className={primaryButton} type="button" onClick={() => void downloadSource(planId, result.id, documentId)}><Download className="h-3.5 w-3.5" />下载并保存快照</button> : <span className="text-xs text-gray-500">已拒绝</span>}</div>
                    </article>;
                  })}</div>;
                })}
                <div className="mt-4 space-y-4">{snapshots.map((snapshot) => {
                  const metadata = object(snapshot.content.snapshot); const draft = excerptDrafts[snapshot.id] ?? { quote: "", comment: "" }; const isManual = snapshot.content.provider === "manual_import" || metadata.sourceType === "manual_import"; const sourceUrl = typeof metadata.url === "string" && /^https?:\/\//.test(metadata.url) ? metadata.url : "";
                  return <article key={snapshot.id} className={`border-l-2 pl-4 ${snapshot.id === importedSnapshotId ? "border-gray-950" : "border-gray-400"}`} data-testid="legal-research-snapshot" data-snapshot-id={snapshot.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words text-[13px] font-medium text-gray-950">{snapshot.title}</h4><p className="mt-1 break-words text-[11px] leading-5 text-gray-500">{documentKindLabel(metadata.documentKind)} · {isManual ? "律师手工导入 · 尚未自动核验 · 保存" : "授权来源 · 抓取"} {text(metadata.fetchedAt)} · <span className="font-mono">{shortHash(metadata.contentHash)}</span></p></div>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-gray-600 underline underline-offset-2">来源地址</a>}</div>
                    <details className="mt-3 border-y border-gray-200 py-2"><summary className="cursor-pointer text-xs font-medium text-gray-700">查看本地快照正文</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words bg-gray-50 p-3 font-sans text-xs leading-6 text-gray-800">{text(snapshot.content.content)}</pre></details>
                    <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px_auto] lg:items-end"><label><span className={labelClass}>精确原文摘录</span><textarea ref={snapshot.id === importedSnapshotId ? importedExcerptRef : undefined} className={`${fieldClass} min-h-20 resize-y`} value={draft.quote} onChange={(e) => setExcerptDrafts((current) => ({ ...current, [snapshot.id]: { ...draft, quote: e.target.value } }))} placeholder="须与上方本地快照逐字一致" /></label><label><span className={labelClass}>律师确认说明</span><textarea className={`${fieldClass} min-h-20 resize-y`} value={draft.comment} onChange={(e) => setExcerptDrafts((current) => ({ ...current, [snapshot.id]: { ...draft, comment: e.target.value } }))} /></label><button type="button" className={primaryButton} disabled={!draft.quote.trim() || !draft.comment.trim() || busy.includes(snapshot.id)} onClick={() => void confirmExcerpt(snapshot)}>确认摘录</button></div>
                  </article>;
                })}</div>
              </section>

              <section aria-labelledby="conclusion-heading">
                <div className="flex items-end justify-between gap-3 border-b border-gray-200 pb-2"><div className="min-w-0"><h3 id="conclusion-heading" className="text-sm font-semibold text-gray-950">4. 律师确认摘录与研究结论</h3><p className="mt-1 text-xs text-gray-500">仅所选精确摘录进入输入清单。结论由律师填写；系统不生成替代文本。</p></div><span className="shrink-0 whitespace-nowrap text-[11px] text-gray-500">{excerpts.length} 条摘录</span></div>
                <div className="mt-3 divide-y divide-gray-100 border-y border-gray-200">{excerpts.length === 0 ? <p className="py-5 text-xs text-gray-500">尚无律师确认摘录。</p> : excerpts.map((excerpt) => <label key={excerpt.id} className="grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] gap-2 py-3"><input type="checkbox" className="mt-1" checked={selectedExcerptIds.includes(excerpt.id)} onChange={(e) => setSelectedExcerptIds((current) => e.target.checked ? [...new Set([...current, excerpt.id])] : current.filter((id) => id !== excerpt.id))} /><span className="min-w-0"><span className="block break-words text-xs leading-5 text-gray-900">“{text(excerpt.content.quote)}”</span><span className="mt-1 block font-mono text-[10px] text-gray-500">{shortHash(excerpt.content.quoteHash)}</span></span></label>)}</div>
                <div className="mt-3 flex flex-wrap items-center gap-3"><button type="button" className={secondaryButton} disabled={selectedExcerptIds.length === 0 || busy === "manifest"} onClick={() => void bindManifest()}><ChevronRight className="h-3.5 w-3.5" />绑定所选摘录</button>{manifests[0] && <span className="text-xs text-gray-600">当前输入清单：{array(manifests[0].content.excerpts).length} 条 · <span className="font-mono">{shortHash(manifests[0].content.bindingHash)}</span></span>}</div>
                <div className="mt-5 grid gap-3 lg:grid-cols-2"><label><span className={labelClass}>律师研究结论</span><textarea className={`${fieldClass} min-h-28 resize-y`} value={conclusion} maxLength={6000} onChange={(e) => setConclusion(e.target.value)} placeholder="填写可由所选摘录支持的结论" /></label><label><span className={labelClass}>不确定性与适用限制</span><textarea className={`${fieldClass} min-h-28 resize-y`} value={uncertainty} maxLength={4000} onChange={(e) => setUncertainty(e.target.value)} placeholder="可留空；有疑点时应明确记录" /></label></div>
                <div className="mt-3 flex flex-wrap items-end gap-3"><label><span className={labelClass}>立场</span><select className={fieldClass} value={position} onChange={(e) => setPosition(e.target.value as typeof position)}><option value="supporting">支持</option><option value="adverse">不利</option><option value="neutral">中性</option></select></label><label><span className={labelClass}>把握程度</span><select className={fieldClass} value={confidence} onChange={(e) => setConfidence(e.target.value as typeof confidence)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label><button type="button" className={primaryButton} disabled={!manifests[0] || !conclusion.trim() || !selectedExcerptsAreBound || busy === "memo"} onClick={() => void saveMemo(false)}><FileCheck2 className="h-3.5 w-3.5" />形成待复核结论</button><button type="button" className={secondaryButton} disabled={!manifests[0] || busy === "insufficient"} onClick={() => void saveMemo(true)}>记录依据不足</button></div>
                {selectedExcerptIds.length > 0 && !selectedExcerptsAreBound && <p className="mt-2 text-xs text-amber-800">所选摘录与当前输入清单不一致，请先重新绑定所选摘录。</p>}

                <div className="mt-6 border-t border-gray-300"><div className="grid grid-cols-[minmax(0,1fr)_100px_120px] gap-3 border-b border-gray-200 py-2 text-[11px] font-semibold text-gray-500"><span>研究工作产品</span><span>状态</span><span>复核</span></div>{memos.length === 0 ? <p className="py-6 text-xs text-gray-500">尚未形成研究结论；“依据不足”是可记录的正常结果。</p> : memos.map((memo) => {
                  const gate = object(memo.content.gate); const blocked = gate.status === "insufficient_basis" || memo.kind === "legal_research_memo"; const stale = Boolean(memo.stale_at); const review = detail?.reviews.find((item) => item.work_product_id === memo.id); const canAccept = !stale && memo.kind === "legal_qa_answer" && review?.resolution_status === "accepted" && memo.status !== "accepted";
                  return <article key={memo.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_100px_120px] gap-3 border-b border-gray-100 py-3 text-xs"><div className="min-w-0"><div className="font-medium text-gray-900">{memo.title}</div>{stale ? <div className="mt-1 text-amber-800">来源已更新，此结论已过期。需重新确认摘录并形成结论。</div> : blocked ? <div className="mt-1 text-amber-800">依据不足{array(gate.reasons).length ? `：${array(gate.reasons).join("；")}` : ""}</div> : <div className="mt-1 text-gray-600">{array(memo.content.findings).length} 项律师结论 · 等待人工复核</div>}<div className="mt-1 text-[10px] text-gray-500">{formatTime(memo.created_at)}{memo.stale_reason ? ` · ${memo.stale_reason}` : ""}</div></div><div className={stale || blocked ? "text-amber-800" : memo.status === "accepted" ? "text-emerald-700" : "text-gray-600"}>{stale ? "已过期" : blocked ? "依据不足" : memo.status === "accepted" ? "已采纳" : "待复核"}</div><div>{stale ? <span className="text-gray-500">需重做研究链</span> : review && review.resolution_status !== "accepted" ? <button className={secondaryButton} type="button" onClick={() => void mutate(`review-${memo.id}`, async () => { await resolveAletheiaReview(matterId, review.id, { status: "accepted", comment: "律师已核对问题拆解、精确摘录、适用日期及不确定性。" }); })}>完成复核</button> : canAccept ? <button className={primaryButton} type="button" onClick={() => void mutate(`accept-${memo.id}`, async () => { await approveAletheiaLegalQaAnswer(matterId, memo.id); })}>采纳结论</button> : <span className="text-gray-500">{blocked ? "无需采纳" : review ? "已复核" : "待创建复核"}</span>}</div></article>;
                })}</div>
              </section>

              <section aria-labelledby="opinion-heading" data-testid="legal-opinion-step">
                <div className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-200 pb-2"><div><h3 id="opinion-heading" className="text-sm font-semibold text-gray-950">5. 法律意见书</h3><p className="mt-1 text-xs text-gray-500">仅从当前、已采纳研究结论建立。意见书独立复核并批准后方可导出。</p></div><span className="text-[11px] text-gray-500">{opinions.length} 个持久化版本</span></div>
                {acceptedMemos.length === 0 ? <p className="py-5 text-xs text-gray-500">暂无可用的已采纳研究结论。请先完成上方复核与采纳；过期结论不可建立意见书。</p> : <div className="mt-3 grid gap-3 lg:grid-cols-2"><label><span className={labelClass}>已采纳研究结论</span><select aria-label="已采纳研究结论" className={fieldClass} value={opinionAnswerId} onChange={(event) => setOpinionAnswerId(event.target.value)}><option value="">请选择</option>{acceptedMemos.map((memo) => <option key={memo.id} value={memo.id}>{memo.title}</option>)}</select></label><label><span className={labelClass}>意见书标题（可选）</span><input className={fieldClass} maxLength={240} value={coverTitle} onChange={(event) => setCoverTitle(event.target.value)} /></label><label><span className={labelClass}>致送对象（可选）</span><input className={fieldClass} maxLength={240} value={coverAddressee} onChange={(event) => setCoverAddressee(event.target.value)} /></label><label><span className={labelClass}>律师文号（可选）</span><input className={fieldClass} maxLength={240} value={lawyerReference} onChange={(event) => setLawyerReference(event.target.value)} /></label><label className="lg:col-span-2"><span className={labelClass}>使用限制（可选）</span><textarea className={`${fieldClass} min-h-20 resize-y`} maxLength={2000} value={coverLimitation} onChange={(event) => setCoverLimitation(event.target.value)} /></label><div className="lg:col-span-2"><button type="button" className={primaryButton} disabled={!opinionAnswerId || busy === "opinion-create"} onClick={() => void createOpinion()}><FileCheck2 className="h-3.5 w-3.5" />建立法律意见书</button></div></div>}
                <div className="mt-5 border-t border-gray-300"><div className="grid grid-cols-[minmax(0,1fr)_86px_minmax(118px,auto)] gap-3 border-b border-gray-200 py-2 text-[11px] font-semibold text-gray-500"><span>意见书版本</span><span>状态</span><span>操作</span></div>{opinions.length === 0 ? <p className="py-5 text-xs text-gray-500">尚未建立法律意见书。</p> : opinions.map((opinion) => {
                  const review = detail?.reviews.find((item) => item.work_product_id === opinion.id); const stale = Boolean(opinion.stale_at) || opinion.id !== currentOpinion?.id; const reviewed = review?.resolution_status === "accepted"; const status = stale ? "已过期" : opinion.status === "accepted" ? "已批准" : reviewed ? "已复核" : review ? "待复核" : "复核缺失";
                  return <article key={opinion.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_86px_minmax(118px,auto)] gap-3 border-b border-gray-100 py-3 text-xs"><div className="min-w-0"><div className="break-words font-medium text-gray-900">{opinion.title}</div><div className="mt-1 text-[10px] text-gray-500">v{opinion.version} · {formatTime(opinion.created_at)}{opinion.stale_reason ? ` · ${opinion.stale_reason}` : ""}</div></div><div className={stale ? "text-amber-800" : opinion.status === "accepted" ? "text-emerald-700" : "text-gray-600"}>{status}</div><div className="flex flex-wrap gap-2">{stale ? <span className="text-gray-500">不可批准或导出</span> : review && !reviewed ? <button type="button" className={secondaryButton} onClick={() => void mutate(`opinion-review-${opinion.id}`, async () => { await resolveAletheiaReview(matterId, review.id, { status: "accepted", comment: "律师已复核意见书忠实限于已采纳结论、引用及限定语。" }); })}>完成独立复核</button> : opinion.status !== "accepted" ? <button type="button" className={primaryButton} disabled={!reviewed} onClick={() => void mutate(`opinion-approve-${opinion.id}`, async () => { await approveAletheiaLegalOpinion(matterId, opinion.id); })}>批准意见书</button> : <button type="button" className={primaryButton} onClick={() => void exportOpinion(opinion)}><Download className="h-3.5 w-3.5" />导出 DOCX</button>}</div></article>;
                })}</div>
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
