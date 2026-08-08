"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Plus,
    Loader2,
    Play,
    ChevronDown,
    MessageSquare,
    MessageSquareX,
    Download,
    Users,
    Upload,
    X,
    Pencil,
    Trash2,
    WandSparkles,
    FileText,
} from "lucide-react";

import {
    clearTabularCells,
    deleteTabularReview,
    getLitigationEvidenceReviewProgress,
    getTabularReview,
    getProject,
    getTabularReviewPeople,
    listProjects,
    regenerateTabularCell,
    requestLitigationEvidenceSourceBoundCorrection,
    reviewLitigationEvidenceCell,
    streamTabularGeneration,
    updateTabularReview,
    uploadProjectDocument,
    uploadReviewDocument,
    MikeApiError,
    type LitigationEvidenceCellCorrectionResult,
    type LitigationEvidenceCellReviewResult,
    type LitigationEvidenceReviewSnapshot,
    type TRCitationAnnotation,
} from "@/app/lib/mikeApi";
import { submitAgentTaskInput } from "@/app/lib/agentClient";
import type {
    ColumnConfig,
    Document,
    Project,
    TabularCell,
    TabularReview,
    Workflow,
} from "../shared/types";
import { AddColumnModal } from "./AddColumnModal";
import { TRWorkflowModal } from "./TRWorkflowModal";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { AddProjectDocsModal } from "../modals/AddProjectDocsModal";
import { PeopleModal } from "../modals/PeopleModal";
import { OwnerOnlyPopup } from "../popups/OwnerOnlyPopup";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { HeaderActionsMenu } from "../shared/HeaderActionsMenu";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import { TRSidePanel } from "./TRSidePanel";
import { TRTable } from "./TRTable";
import type { TRTableHandle } from "./TRTable";
import { TRChatPanel } from "./TRChatPanel";
import { TabularReviewDetailsModal } from "./TabularReviewDetailsModal";
import {
    buildTabularReviewExcel,
    exportTabularReviewToExcel,
    isTabularReviewExcelWithinUploadLimit,
} from "./exportToExcel";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { PageHeader } from "../shared/PageHeader";
import { TableToolbar } from "../shared/TableToolbar";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { resolveCellCitationFromExcerpt } from "./citation-utils";
import {
    buildTabularReviewWordMemo,
    isTabularReviewWordMemoWithinUploadLimit,
} from "./exportToWordMemo";
import {
    prepareTabularCellsForGeneration,
    readTabularGenerationStream,
} from "./tabularGenerationClient";
import {
    evidenceInventoryReviewCompleteResponse,
    litigationEvidenceSideLabel,
    litigationEvidenceStageLabel,
    type SourceBoundCorrectionReasonCode,
} from "./litigationEvidenceInventoryUi";

interface Props {
    reviewId: string;
    projectId?: string;
}

type LitigationEvidenceReviewState =
    | { kind: "checking" }
    | { kind: "ordinary" }
    | {
          kind: "active";
          snapshot: LitigationEvidenceReviewSnapshot;
      }
    | { kind: "unavailable"; detail: string };

export function TRView({ reviewId, projectId }: Props) {
    const { setSidebarOpen } = useSidebar();
    const [review, setReview] = useState<TabularReview | null>(null);
    const [project, setProject] = useState<Project | null>(null);
    const [cells, setCells] = useState<TabularCell[]>([]);
    const [documents, setDocuments] = useState<Document[]>([]);
    const [columns, setColumns] = useState<ColumnConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [savingColumn, setSavingColumn] = useState(false);
    const [savingColumnsConfig, setSavingColumnsConfig] = useState(false);
    const [addColOpen, setAddColOpen] = useState(false);
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [availableProjects, setAvailableProjects] = useState<Project[]>([]);
    const [peopleModalOpen, setPeopleModalOpen] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [applyingWorkflow, setApplyingWorkflow] = useState(false);
    const [deleteReviewConfirmOpen, setDeleteReviewConfirmOpen] =
        useState(false);
    const [deleteReviewStatus, setDeleteReviewStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const { user } = useAuth();
    const [expandedCell, setExpandedCell] = useState<TabularCell | null>(null);
    const [expandedCellCitation, setExpandedCellCitation] = useState<
        | {
              quote: string;
              page?: number;
              sheet?: string;
              cell?: string;
              citationRef: number;
          }
        | undefined
    >(undefined);
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [dragOverReviewFiles, setDragOverReviewFiles] = useState(false);
    const [uploadingDroppedFilenames, setUploadingDroppedFilenames] = useState<
        string[]
    >([]);
    const [saveExcelToMatterStatus, setSaveExcelToMatterStatus] = useState<
        "idle" | "saving" | "saved" | "too_large" | "error"
    >("idle");
    const [saveMemoToMatterStatus, setSaveMemoToMatterStatus] = useState<
        "idle" | "saving" | "saved" | "too_large" | "error"
    >("idle");
    const searchParams = useSearchParams();
    const initialChatParamRef = useRef<string | null>(searchParams.get("chat"));
    const [chatOpen, setChatOpen] = useState(!!initialChatParamRef.current);
    const [selectedChatId, setSelectedChatId] = useState<string | null>(
        initialChatParamRef.current && initialChatParamRef.current !== "new"
            ? initialChatParamRef.current
            : null,
    );
    const [highlightedCell, setHighlightedCell] = useState<{
        colIdx: number;
        rowIdx: number;
    } | null>(null);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [litigationReview, setLitigationReview] =
        useState<LitigationEvidenceReviewState>({ kind: "checking" });
    const [litigationReviewSavingCellId, setLitigationReviewSavingCellId] =
        useState<string | null>(null);
    const [litigationReviewError, setLitigationReviewError] = useState<
        string | null
    >(null);
    const [litigationCompletionSubmitting, setLitigationCompletionSubmitting] =
        useState(false);
    const [litigationCompletionError, setLitigationCompletionError] = useState<
        string | null
    >(null);
    const actionsRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<TRTableHandle>(null);
    const router = useRouter();
    const { profile } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const tabularModel = profile?.tabularModel ?? "gemini-3-flash-preview";

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (chatOpen) {
            params.set("chat", selectedChatId ?? "new");
        } else {
            params.delete("chat");
        }
        const query = params.toString();
        const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
        window.history.replaceState(null, "", newUrl);
    }, [chatOpen, selectedChatId]);

    useEffect(() => {
        if (!actionsOpen) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            )
                setActionsOpen(false);
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [actionsOpen]);

    useEffect(() => {
        const fetches: Promise<unknown>[] = [
            getTabularReview(reviewId).then(({ review, cells, documents }) => {
                setReview(review);
                setCells(cells);
                setDocuments(documents);
                setColumns(review.columns_config || []);
            }),
        ];
        if (projectId) {
            fetches.push(
                getProject(projectId)
                    .then(setProject)
                    .catch(() => {}),
            );
        } else {
            fetches.push(
                listProjects()
                    .then(setAvailableProjects)
                    .catch(() => setAvailableProjects([])),
            );
        }
        Promise.all(fetches).finally(() => setLoading(false));
    }, [reviewId, projectId]);

    useEffect(() => {
        let cancelled = false;
        setLitigationReview({ kind: "checking" });
        setLitigationReviewError(null);
        setLitigationCompletionError(null);

        void (async () => {
            try {
                const progress =
                    await getLitigationEvidenceReviewProgress(reviewId);
                if (!cancelled) {
                    setLitigationReview({
                        kind: "active",
                        snapshot: progress,
                    });
                }
            } catch (error) {
                if (cancelled) return;
                if (
                    error instanceof MikeApiError &&
                    error.status === 404 &&
                    error.code === "not_found"
                ) {
                    setLitigationReview({ kind: "ordinary" });
                    return;
                }
                setLitigationReview({
                    kind: "unavailable",
                    detail:
                        error instanceof Error
                            ? error.message
                            : "Evidence Inventory review status could not be loaded.",
                });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [reviewId]);

    function getNextColumnIndex() {
        return (
            columns.reduce((max, column) => Math.max(max, column.index), -1) + 1
        );
    }

    const taskOwnedReviewLocked = litigationReview.kind !== "ordinary";
    const activeLitigationReview =
        litigationReview.kind === "active" ? litigationReview : null;
    const litigationProgress =
        activeLitigationReview?.snapshot.progress ?? null;
    const litigationReviewActive =
        activeLitigationReview?.snapshot.task_status === "waiting_input";
    const litigationReviewCanComplete =
        Boolean(litigationProgress) &&
        litigationProgress!.remaining === 0 &&
        litigationReviewActive &&
        !litigationCompletionSubmitting;

    function taskOwnedReviewActionBlocked() {
        return taskOwnedReviewLocked;
    }

    async function saveColumnsConfig(nextColumns: ColumnConfig[]) {
        if (taskOwnedReviewActionBlocked()) return;
        setSavingColumnsConfig(true);
        try {
            const updated = await updateTabularReview(reviewId, {
                columns_config: nextColumns,
                document_ids: documents.map((document) => document.id),
            });
            setReview(updated);
            setColumns(updated.columns_config || nextColumns);
        } finally {
            setSavingColumnsConfig(false);
        }
    }

    async function handleAddDocuments(newDocs: Document[]) {
        if (taskOwnedReviewActionBlocked()) return;
        const toAdd = newDocs.filter(
            (d) => !documents.some((existing) => existing.id === d.id),
        );
        if (!toAdd.length) return;
        const allIds = [
            ...documents.map((d) => d.id),
            ...toAdd.map((d) => d.id),
        ];

        await updateTabularReview(reviewId, {
            document_ids: allIds,
            columns_config: columns,
        });
        setDocuments((prev) => [...prev, ...toAdd]);
        if (columns.length > 0) {
            setCells((prev) => [
                ...prev,
                ...toAdd.flatMap((doc) =>
                    columns.map((col) => ({
                        id: `new-${doc.id}-${col.index}`,
                        review_id: reviewId,
                        document_id: doc.id,
                        column_index: col.index,
                        content: null,
                        status: "pending" as const,
                        created_at: new Date().toISOString(),
                    })),
                ),
            ]);
        }
    }

    function hasFilePayload(dt: DataTransfer): boolean {
        return Array.from(dt.types).includes("Files");
    }

    async function handleDropReviewFiles(files: File[]) {
        if (taskOwnedReviewActionBlocked()) return;
        if (files.length === 0) return;
        setUploadingDroppedFilenames(files.map((file) => file.name));
        try {
            const uploaded: Document[] = [];
            const documentIds = documents.map((document) => document.id);
            for (const file of files) {
                const document = await uploadReviewDocument(reviewId, file, {
                    projectId,
                    documentIds,
                    columnsConfig: columns,
                });
                uploaded.push(document);
                documentIds.push(document.id);
            }
            await handleAddDocuments(uploaded);
        } catch (err) {
            console.error("Tabular review document drop upload failed", err);
        } finally {
            setUploadingDroppedFilenames([]);
        }
    }

    async function handleRegenerateCell(docId: string, colIndex: number) {
        if (taskOwnedReviewActionBlocked()) return;
        if (apiKeys && !isModelAvailable(tabularModel, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(tabularModel));
            return;
        }

        setCells((prev) =>
            prev.map((c) =>
                c.document_id === docId && c.column_index === colIndex
                    ? { ...c, status: "generating" as const, content: null }
                    : c,
            ),
        );
        setExpandedCell((prev) =>
            prev
                ? { ...prev, status: "generating" as const, content: null }
                : null,
        );
        try {
            const result = await regenerateTabularCell(
                reviewId,
                docId,
                colIndex,
            );
            setCells((prev) =>
                prev.map((c) =>
                    c.document_id === docId && c.column_index === colIndex
                        ? { ...c, status: "done" as const, content: result }
                        : c,
                ),
            );
            setExpandedCell((prev) =>
                prev
                    ? { ...prev, status: "done" as const, content: result }
                    : null,
            );
        } catch (err) {
            console.error("Regeneration failed", err);
            setCells((prev) =>
                prev.map((c) =>
                    c.document_id === docId && c.column_index === colIndex
                        ? { ...c, status: "pending" as const, content: null }
                        : c,
                ),
            );
            setExpandedCell((prev) =>
                prev
                    ? { ...prev, status: "pending" as const, content: null }
                    : null,
            );
        }
    }

    async function handleGenerate() {
        if (taskOwnedReviewActionBlocked()) return;
        if (!review || generating) return;

        // If columns changed since last save, update the review first
        if (columns.length === 0) return;

        if (apiKeys && !isModelAvailable(tabularModel, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(tabularModel));
            return;
        }

        setGenerating(true);

        try {
            const response = await streamTabularGeneration(reviewId);
            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const provider =
                    payload &&
                    ["claude", "gemini", "openai"].includes(payload.provider)
                        ? (payload.provider as ModelProvider)
                        : getModelProvider(tabularModel);
                if (payload?.code === "missing_api_key" && provider) {
                    setApiKeyModalProvider(provider);
                }
                throw new Error(
                    payload?.detail ?? `Generation failed: ${response.status}`,
                );
            }
            if (!response.body) throw new Error("No body");

            setCells((prev) =>
                prepareTabularCellsForGeneration({
                    cells: prev,
                    documents,
                    columns,
                    reviewId,
                }),
            );
            await readTabularGenerationStream(response, (update) => {
                setCells((prev) =>
                    prev.map((cell) =>
                        cell.document_id === update.documentId &&
                        cell.column_index === update.columnIndex
                            ? {
                                  ...cell,
                                  content: update.content,
                                  status: update.status,
                              }
                            : cell,
                    ),
                );
            });
        } catch (err) {
            console.error("Generation failed", err);
        } finally {
            setGenerating(false);
        }
    }

    async function handleAddColumn(newColumns: ColumnConfig[]) {
        if (taskOwnedReviewActionBlocked()) return;
        const startIndex = getNextColumnIndex();
        const normalizedColumns = newColumns.map((column, index) => ({
            ...column,
            index: startIndex + index,
        }));
        const newCols = [...columns, ...normalizedColumns];
        setSavingColumn(true);
        setColumns(newCols);
        setCells((prev) => [
            ...prev,
            ...documents
                .filter((doc) =>
                    normalizedColumns.some(
                        (column) =>
                            !prev.some(
                                (cell) =>
                                    cell.document_id === doc.id &&
                                    cell.column_index === column.index,
                            ),
                    ),
                )
                .flatMap((doc) =>
                    normalizedColumns
                        .filter(
                            (column) =>
                                !prev.some(
                                    (cell) =>
                                        cell.document_id === doc.id &&
                                        cell.column_index === column.index,
                                ),
                        )
                        .map((column) => ({
                            id: `new-${doc.id}-${column.index}`,
                            review_id: reviewId,
                            document_id: doc.id,
                            column_index: column.index,
                            content: null,
                            status: "pending" as const,
                            created_at: new Date().toISOString(),
                        })),
                ),
        ]);
        try {
            await saveColumnsConfig(newCols);
        } catch (err) {
            setColumns(columns);
            setCells((prev) =>
                prev.filter(
                    (cell) =>
                        !normalizedColumns.some(
                            (column) => column.index === cell.column_index,
                        ),
                ),
            );
            console.error("Failed to save column", err);
        } finally {
            setSavingColumn(false);
        }
    }

    async function handleUpdateColumn(nextColumn: ColumnConfig) {
        if (taskOwnedReviewActionBlocked()) return;
        const nextColumns = columns.map((column) =>
            column.index === nextColumn.index ? nextColumn : column,
        );
        const previousColumns = columns;
        setColumns(nextColumns);
        try {
            await saveColumnsConfig(nextColumns);
        } catch (err) {
            setColumns(previousColumns);
            console.error("Failed to update column", err);
        }
    }

    async function handleDeleteColumn(columnIndex: number) {
        if (taskOwnedReviewActionBlocked()) return;
        const previousColumns = columns;
        const nextColumns = columns.filter(
            (column) => column.index !== columnIndex,
        );
        setColumns(nextColumns);
        try {
            await saveColumnsConfig(nextColumns);
        } catch (err) {
            setColumns(previousColumns);
            console.error("Failed to delete column", err);
        }
    }

    function handleTabularCitationClick(citation: TRCitationAnnotation) {
        const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
        const matchingDocuments = documents.filter(
            (candidate) => candidate.filename === citation.doc_name,
        );
        const indexedDocument = documents[citation.row_index];
        const document =
            matchingDocuments.length === 1
                ? matchingDocuments[0]
                : indexedDocument?.filename === citation.doc_name
                  ? indexedDocument
                  : undefined;
        const matchingColumns = sortedColumns.filter(
            (candidate) => candidate.name === citation.col_name,
        );
        const indexedColumn = sortedColumns[citation.col_index];
        const column =
            matchingColumns.length === 1
                ? matchingColumns[0]
                : indexedColumn?.name === citation.col_name
                  ? indexedColumn
                  : undefined;
        const targetCell =
            document && column
                ? cells.find(
                      (candidate) =>
                          candidate.document_id === document.id &&
                          candidate.column_index === column.index,
                  )
                : undefined;
        const resolvedColIdx = column
            ? columns.findIndex((candidate) => candidate.index === column.index)
            : -1;
        const resolvedRowIdx = document
            ? documents.findIndex((candidate) => candidate.id === document.id)
            : -1;
        const colIdx =
            resolvedColIdx >= 0 ? resolvedColIdx : citation.col_index;
        const rowIdx =
            resolvedRowIdx >= 0 ? resolvedRowIdx : citation.row_index;

        setSearch("");
        setHighlightedCell({ colIdx, rowIdx });
        if (targetCell) {
            const sourceCitation = resolveCellCitationFromExcerpt(
                targetCell.content?.summary,
                targetCell.content?.reasoning,
                citation.quote,
            );
            setExpandedCell(targetCell);
            setExpandedCellCitation(
                sourceCitation
                    ? {
                          quote: sourceCitation.quote,
                          page: sourceCitation.page,
                          sheet: sourceCitation.sheet,
                          cell: sourceCitation.cell,
                          citationRef: sourceCitation.citationRef,
                      }
                    : undefined,
            );
        } else {
            setExpandedCell(null);
            setExpandedCellCitation(undefined);
        }
        setTimeout(() => {
            tableRef.current?.scrollToCell(colIdx, rowIdx);
        }, 50);
        setTimeout(() => setHighlightedCell(null), 3000);
    }

    async function handleDeleteDocuments() {
        if (taskOwnedReviewActionBlocked()) return;
        const idsToDelete = [...selectedDocIds];
        if (idsToDelete.length === 0) return;
        const previousDocuments = documents;
        const previousCells = cells;
        const remaining = documents.filter((d) => !idsToDelete.includes(d.id));
        setDocuments(remaining);
        setCells((prev) =>
            prev.filter((c) => !idsToDelete.includes(c.document_id)),
        );
        setSelectedDocIds([]);
        setActionsOpen(false);
        try {
            await updateTabularReview(reviewId, {
                document_ids: remaining.map((d) => d.id),
                columns_config: columns,
            });
        } catch (err) {
            setDocuments(previousDocuments);
            setCells(previousCells);
            setSelectedDocIds(idsToDelete);
            console.error("Failed to delete tabular review documents", err);
        }
    }

    async function clearResultsForDocuments(docIds: string[]) {
        if (taskOwnedReviewActionBlocked()) return;
        if (docIds.length === 0) return;
        setCells((prev) =>
            prev.map((c) =>
                docIds.includes(c.document_id)
                    ? { ...c, content: null, status: "pending" }
                    : c,
            ),
        );
        setSelectedDocIds([]);
        setActionsOpen(false);
        await clearTabularCells(reviewId, docIds);
    }

    async function handleClearResults() {
        await clearResultsForDocuments([...selectedDocIds]);
    }

    async function handleClearAllResults() {
        await clearResultsForDocuments(
            documents.map((document) => document.id),
        );
    }

    function requestReviewDetails() {
        if (taskOwnedReviewActionBlocked()) return;
        if (review?.is_owner === false) {
            setOwnerOnlyAction("edit tabular review details");
            return;
        }
        setDetailsOpen(true);
    }

    async function handleDetailsSave(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (taskOwnedReviewActionBlocked()) return;
        if (!review || review.is_owner === false) {
            setOwnerOnlyAction("edit tabular review details");
            return;
        }
        const updated = await updateTabularReview(reviewId, {
            title: values.title,
            project_id: values.projectId ?? null,
        });
        setReview((prev) =>
            prev
                ? {
                      ...prev,
                      ...updated,
                  }
                : updated,
        );
        if (!projectId && updated.project_id) {
            setDetailsOpen(false);
            router.push(
                `/projects/${updated.project_id}/tabular-reviews/${reviewId}`,
            );
        }
    }

    function requestReviewDelete() {
        if (taskOwnedReviewActionBlocked()) return;
        if (review?.is_owner === false) {
            setOwnerOnlyAction("delete this tabular review");
            return;
        }
        setDeleteReviewStatus("idle");
        setDeleteReviewConfirmOpen(true);
    }

    async function confirmReviewDelete() {
        if (taskOwnedReviewActionBlocked()) return;
        if (deleteReviewStatus === "deleting") return;
        setDeleteReviewStatus("deleting");
        try {
            await deleteTabularReview(reviewId);
            setDeleteReviewStatus("deleted");
            setTimeout(() => {
                router.push(
                    projectId
                        ? `/projects/${projectId}/tabular-reviews`
                        : "/tabular-reviews",
                );
            }, 250);
        } catch (err) {
            setDeleteReviewStatus("idle");
            console.error("Failed to delete tabular review", err);
        }
    }

    function requestWorkflow() {
        if (taskOwnedReviewActionBlocked()) return;
        if (review?.is_owner === false) {
            setOwnerOnlyAction("apply a workflow");
            return;
        }
        setWorkflowModalOpen(true);
    }

    async function handleApplyWorkflow(workflow: Workflow) {
        if (taskOwnedReviewActionBlocked()) return;
        if (!workflow.columns_config?.length) return;
        const nextColumns = workflow.columns_config.map((column, index) => ({
            ...column,
            index,
        }));
        const previousColumns = columns;
        const previousCells = cells;
        setApplyingWorkflow(true);
        setColumns(nextColumns);
        setCells([]);
        try {
            await saveColumnsConfig(nextColumns);
            if (documents.length > 0) {
                try {
                    await clearTabularCells(
                        reviewId,
                        documents.map((document) => document.id),
                    );
                } catch (err) {
                    console.error("Failed to clear old tabular cells", err);
                }
            }
            setWorkflowModalOpen(false);
        } catch (err) {
            setColumns(previousColumns);
            setCells(previousCells);
            console.error("Failed to apply workflow", err);
        } finally {
            setApplyingWorkflow(false);
        }
    }

    const matterSourcesVerified = Boolean(
        projectId &&
        review?.project_id === projectId &&
        project?.id === projectId &&
        documents.length > 0 &&
        documents.every((document) => document.project_id === projectId),
    );
    const hasCompletedFindings = cells.some(
        (cell) => cell.status === "done" && Boolean(cell.content?.summary),
    );

    async function handleSaveExcelToMatter() {
        if (taskOwnedReviewActionBlocked()) return;
        if (!projectId || !matterSourcesVerified) return;

        setSaveMemoToMatterStatus("idle");
        setSaveExcelToMatterStatus("saving");
        try {
            const excelExport = await buildTabularReviewExcel({
                reviewTitle: review?.title || "Tabular Review",
                columns,
                documents,
                cells,
            });
            if (!isTabularReviewExcelWithinUploadLimit(excelExport.blob)) {
                setSaveExcelToMatterStatus("too_large");
                return;
            }
            await uploadProjectDocument(
                projectId,
                new File([excelExport.blob], excelExport.filename, {
                    type: excelExport.blob.type,
                }),
            );
            setSaveExcelToMatterStatus("saved");
        } catch (error) {
            console.error(
                "Failed to save tabular review Excel to Matter",
                error,
            );
            setSaveExcelToMatterStatus("error");
        }
    }

    async function handleCreateWordMemo() {
        if (taskOwnedReviewActionBlocked()) return;
        if (!projectId || !matterSourcesVerified || !hasCompletedFindings)
            return;

        setSaveExcelToMatterStatus("idle");
        setSaveMemoToMatterStatus("saving");
        try {
            const memoExport = await buildTabularReviewWordMemo({
                reviewTitle: review?.title || "Tabular Review",
                matterName: project?.name,
                columns,
                documents,
                cells,
            });
            if (!isTabularReviewWordMemoWithinUploadLimit(memoExport.blob)) {
                setSaveMemoToMatterStatus("too_large");
                return;
            }
            await uploadProjectDocument(
                projectId,
                new File([memoExport.blob], memoExport.filename, {
                    type: memoExport.blob.type,
                }),
            );
            setSaveMemoToMatterStatus("saved");
        } catch (error) {
            console.error("Failed to create Word memo in Matter", error);
            setSaveMemoToMatterStatus("error");
        }
    }

    function applyLitigationEvidenceCellTransition(
        cellId: string,
        result:
            | LitigationEvidenceCellReviewResult
            | LitigationEvidenceCellCorrectionResult,
    ) {
        setCells((current) =>
            current.map((candidate) => {
                if (candidate.id !== cellId) return candidate;
                const status = result.cell.cell_status;
                return {
                    ...candidate,
                    ...(status === "pending" || status === "done"
                        ? { status }
                        : {}),
                    review_status: result.cell.review_status,
                    review_revision:
                        result.cell.review_revision ?? candidate.review_revision,
                    ...(result.cell.reviewed_at === undefined
                        ? {}
                        : { reviewed_at: result.cell.reviewed_at }),
                };
            }),
        );
        setExpandedCell((current) =>
            current?.id === cellId
                ? {
                      ...current,
                      review_status: result.cell.review_status,
                      review_revision:
                          result.cell.review_revision ?? current.review_revision,
                      ...(result.cell.reviewed_at === undefined
                          ? {}
                          : { reviewed_at: result.cell.reviewed_at }),
                  }
                : current,
        );
        setLitigationReview({
            kind: "active",
            snapshot: {
                task_id: result.task_id,
                task_status: result.task_status,
                review_id: result.review_id,
                context: result.context,
                progress: result.progress,
            },
        });
    }

    async function saveLitigationCellReview(
        cell: TabularCell,
        decision: "verified" | "unresolved",
    ) {
        if (
            !activeLitigationReview ||
            !litigationReviewActive ||
            litigationReviewSavingCellId ||
            cell.review_revision === undefined
        ) {
            return;
        }
        setLitigationReviewSavingCellId(cell.id);
        setLitigationReviewError(null);
        try {
            const result = await reviewLitigationEvidenceCell(
                reviewId,
                cell.id,
                {
                    decision,
                    expectedReviewRevision: cell.review_revision,
                },
            );
            applyLitigationEvidenceCellTransition(cell.id, result);
        } catch (error) {
            setLitigationReviewError(
                error instanceof Error
                    ? error.message
                    : "The lawyer review decision could not be saved.",
            );
        } finally {
            setLitigationReviewSavingCellId(null);
        }
    }

    async function requestLitigationEvidenceCellCorrection(
        cell: TabularCell,
        reasonCode: SourceBoundCorrectionReasonCode,
    ) {
        if (
            !activeLitigationReview ||
            !litigationReviewActive ||
            litigationReviewSavingCellId ||
            (cell.status !== "pending" && cell.status !== "done") ||
            cell.review_revision === undefined ||
            cell.review_status === "verified" ||
            cell.review_status === "unresolved"
        ) {
            return;
        }
        setLitigationReviewSavingCellId(cell.id);
        setLitigationReviewError(null);
        try {
            const result =
                await requestLitigationEvidenceSourceBoundCorrection(
                    reviewId,
                    cell.id,
                    {
                        expectedReviewRevision: cell.review_revision,
                        reasonCode,
                    },
                );
            applyLitigationEvidenceCellTransition(cell.id, result);
            router.push(`/agent-tasks/${result.task_id}?restore=1`);
        } catch (error) {
            setLitigationReviewError(
                error instanceof Error
                    ? error.message
                    : "The source-bound regeneration request could not be saved.",
            );
        } finally {
            setLitigationReviewSavingCellId(null);
        }
    }

    function openFirstIncompleteLitigationCell() {
        const cellId = litigationProgress?.first_incomplete_cell_id;
        if (!cellId) return;
        const cell = cells.find((candidate) => candidate.id === cellId);
        if (!cell) return;
        const documentIndex = documents.findIndex(
            (document) => document.id === cell.document_id,
        );
        const columnIndex = [...columns]
            .sort((left, right) => left.index - right.index)
            .findIndex((column) => column.index === cell.column_index);
        if (documentIndex < 0 || columnIndex < 0) return;
        setSearch("");
        setExpandedCell(cell);
        setExpandedCellCitation(undefined);
        window.requestAnimationFrame(() => {
            tableRef.current?.scrollToCell(columnIndex, documentIndex);
        });
    }

    async function reloadLitigationReviewAndFocusFirstIncomplete() {
        const [progress, detail] = await Promise.all([
            getLitigationEvidenceReviewProgress(reviewId),
            getTabularReview(reviewId),
        ]);
        setLitigationReview({ kind: "active", snapshot: progress });
        setReview(detail.review);
        setCells(detail.cells);
        setDocuments(detail.documents);
        setColumns(detail.review.columns_config || []);

        const firstCellId = progress.progress.first_incomplete_cell_id;
        const firstCell = detail.cells.find(
            (candidate) => candidate.id === firstCellId,
        );
        if (!firstCell) return;
        const documentIndex = detail.documents.findIndex(
            (document) => document.id === firstCell.document_id,
        );
        const columnIndex = [...(detail.review.columns_config || [])]
            .sort((left, right) => left.index - right.index)
            .findIndex((column) => column.index === firstCell.column_index);
        if (documentIndex < 0 || columnIndex < 0) return;
        setSearch("");
        setExpandedCell(firstCell);
        setExpandedCellCitation(undefined);
        window.requestAnimationFrame(() => {
            tableRef.current?.scrollToCell(columnIndex, documentIndex);
        });
    }

    async function completeLitigationEvidenceReview() {
        if (!activeLitigationReview || !litigationReviewCanComplete) return;
        setLitigationCompletionSubmitting(true);
        setLitigationCompletionError(null);
        try {
            await submitAgentTaskInput(
                activeLitigationReview.snapshot.task_id,
                {
                    responses: evidenceInventoryReviewCompleteResponse(),
                },
            );
            router.push(
                `/agent-tasks/${activeLitigationReview.snapshot.task_id}?restore=1`,
            );
        } catch (error) {
            try {
                await reloadLitigationReviewAndFocusFirstIncomplete();
            } catch {
                // Preserve the server error below when its current progress
                // cannot be read again (for example, a transient outage).
            }
            setLitigationCompletionError(
                error instanceof Error
                    ? error.message
                    : "The Task could not continue after this review.",
            );
        } finally {
            setLitigationCompletionSubmitting(false);
        }
    }

    const saveExcelToMatterMessage =
        saveExcelToMatterStatus === "saving"
            ? "Saving…"
            : saveExcelToMatterStatus === "saved"
              ? "Saved to Matter"
              : saveExcelToMatterStatus === "too_large"
                ? "Export exceeds 100 MB"
                : saveExcelToMatterStatus === "error"
                  ? "Couldn’t save — retry"
                  : null;

    const saveMemoToMatterMessage =
        saveMemoToMatterStatus === "saving"
            ? "Creating memo…"
            : saveMemoToMatterStatus === "saved"
              ? "Word memo saved to Matter"
              : saveMemoToMatterStatus === "too_large"
                ? "Memo exceeds 100 MB"
                : saveMemoToMatterStatus === "error"
                  ? "Couldn’t create memo — retry"
                  : null;

    const q = search.toLowerCase();
    const filteredDocuments = q
        ? documents.filter((d) => d.filename.toLowerCase().includes(q))
        : documents;

    return (
        <div className="flex h-full overflow-hidden">
            <div className="flex flex-1 flex-col overflow-hidden">
                {/* Header */}
                <PageHeader
                    shrink
                    breadcrumbs={[
                        ...(projectId
                            ? [
                                  {
                                      label: "Projects",
                                      onClick: () => router.push("/projects"),
                                  },
                                  loading
                                      ? {
                                            loading: true,
                                            skeletonClassName: "w-32",
                                            onClick: () =>
                                                router.push(
                                                    `/projects/${projectId}/tabular-reviews`,
                                                ),
                                            title: "Back to project",
                                        }
                                      : {
                                            label: project?.name ?? "",
                                            onClick: () =>
                                                router.push(
                                                    `/projects/${projectId}/tabular-reviews`,
                                                ),
                                            title: "Back to project",
                                        },
                              ]
                            : [
                                  {
                                      label: "Tabular Reviews",
                                      onClick: () =>
                                          router.push("/tabular-reviews"),
                                      title: "Back to Tabular Reviews",
                                  },
                              ]),
                        loading
                            ? {
                                  loading: true,
                                  skeletonClassName: "w-40",
                              }
                            : {
                                  label: review?.title || "Untitled Review",
                              },
                    ]}
                    actionGroups={[
                        [
                            {
                                type: "search",
                                value: search,
                                onChange: setSearch,
                                placeholder: "Search documents…",
                            },
                            !projectId
                                ? {
                                      onClick: () => setPeopleModalOpen(true),
                                      disabled:
                                          taskOwnedReviewLocked || loading,
                                      iconOnly: true,
                                      title: "People with access",
                                      icon: <Users className="h-4 w-4" />,
                                  }
                                : null,
                            {
                                type: "custom",
                                render: (
                                    <div className="flex items-center gap-1.5">
                                        {(saveMemoToMatterMessage ||
                                            saveExcelToMatterMessage) && (
                                            <span
                                                role="status"
                                                aria-live="polite"
                                                className={
                                                    saveMemoToMatterStatus ===
                                                        "error" ||
                                                    saveExcelToMatterStatus ===
                                                        "error"
                                                        ? "max-w-40 truncate text-xs text-red-600"
                                                        : saveMemoToMatterStatus ===
                                                                "too_large" ||
                                                            saveExcelToMatterStatus ===
                                                                "too_large"
                                                          ? "max-w-40 truncate text-xs text-amber-700"
                                                          : "max-w-40 truncate text-xs text-gray-500"
                                                }
                                            >
                                                {saveMemoToMatterMessage ||
                                                    saveExcelToMatterMessage}
                                            </span>
                                        )}
                                        {!taskOwnedReviewLocked && (
                                            <HeaderActionsMenu
                                                items={[
                                                    {
                                                        label: "Edit details",
                                                        icon: Pencil,
                                                        onSelect:
                                                            requestReviewDetails,
                                                    },
                                                    {
                                                        label: "Apply workflow",
                                                        icon: WandSparkles,
                                                        onSelect:
                                                            requestWorkflow,
                                                    },
                                                    {
                                                        label: "Export",
                                                        icon: Download,
                                                        onSelect: () =>
                                                            exportTabularReviewToExcel(
                                                                {
                                                                    reviewTitle:
                                                                        review?.title ||
                                                                        "Tabular Review",
                                                                    columns,
                                                                    documents,
                                                                    cells,
                                                                },
                                                            ),
                                                        disabled:
                                                            columns.length ===
                                                                0 ||
                                                            documents.length ===
                                                                0,
                                                    },
                                                    ...(projectId
                                                        ? [
                                                              {
                                                                  label: matterSourcesVerified
                                                                      ? !hasCompletedFindings
                                                                          ? "Memo unavailable — complete review"
                                                                          : saveMemoToMatterStatus ===
                                                                              "saving"
                                                                            ? "Creating Word memo…"
                                                                            : "Create Word memo"
                                                                      : "Memo unavailable — verify Matter sources",
                                                                  icon: FileText,
                                                                  onSelect:
                                                                      handleCreateWordMemo,
                                                                  disabled:
                                                                      !matterSourcesVerified ||
                                                                      saveMemoToMatterStatus ===
                                                                          "saving" ||
                                                                      columns.length ===
                                                                          0 ||
                                                                      documents.length ===
                                                                          0 ||
                                                                      !hasCompletedFindings,
                                                              },
                                                              {
                                                                  label: matterSourcesVerified
                                                                      ? saveExcelToMatterStatus ===
                                                                        "saving"
                                                                          ? "Saving Excel to Matter…"
                                                                          : "Save Excel to Matter"
                                                                      : "Save unavailable — verify Matter sources",
                                                                  icon: Upload,
                                                                  onSelect:
                                                                      handleSaveExcelToMatter,
                                                                  disabled:
                                                                      !matterSourcesVerified ||
                                                                      saveExcelToMatterStatus ===
                                                                          "saving",
                                                              },
                                                          ]
                                                        : []),
                                                    {
                                                        label: "Clear results",
                                                        icon: X,
                                                        onSelect:
                                                            handleClearAllResults,
                                                        disabled:
                                                            documents.length ===
                                                            0,
                                                    },
                                                    {
                                                        label: "Delete",
                                                        icon: Trash2,
                                                        onSelect:
                                                            requestReviewDelete,
                                                        variant: "danger",
                                                    },
                                                ]}
                                            />
                                        )}
                                    </div>
                                ),
                            },
                        ],
                        {
                            actions: taskOwnedReviewLocked
                                ? []
                                : [
                                {
                                    onClick: () => setAddDocsOpen(true),
                                    disabled: loading || savingColumnsConfig,
                                    title: "Add documents",
                                    icon: <Upload className="h-4 w-4" />,
                                    label: (
                                        <span className="hidden sm:inline">
                                            Documents
                                        </span>
                                    ),
                                },
                            ],
                        },
                        {
                            actions: taskOwnedReviewLocked
                                ? []
                                : [
                                {
                                    onClick: handleGenerate,
                                    disabled:
                                        generating ||
                                        columns.length === 0 ||
                                        documents.length === 0 ||
                                        savingColumnsConfig,
                                    icon: generating ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Play className="h-4 w-4" />
                                    ),
                                    label: (
                                        <span className="hidden sm:inline">
                                            {generating ? "Running…" : "Run"}
                                        </span>
                                    ),
                                },
                            ],
                        },
                        {
                            actions: taskOwnedReviewLocked
                                ? []
                                : [
                                {
                                    onClick: () => {
                                        if (!chatOpen) setSidebarOpen(false);
                                        if (chatOpen) setSelectedChatId(null);
                                        setChatOpen((v) => !v);
                                    },
                                    disabled:
                                        loading ||
                                        columns.length === 0 ||
                                        documents.length === 0,
                                    title: chatOpen
                                        ? "Close chat"
                                        : "Open chat",
                                    icon: chatOpen ? (
                                        <MessageSquareX className="h-4 w-4" />
                                    ) : (
                                        <MessageSquare className="h-4 w-4" />
                                    ),
                                    label: (
                                        <span className="hidden sm:inline">
                                            Chat
                                        </span>
                                    ),
                                },
                            ],
                        },
                    ]}
                />

                {/* Toolbar + table column, chat panel beside it */}
                <div className="flex flex-1 overflow-hidden">
                    {/* On mobile the chat panel replaces the table entirely */}
                    <div
                        className={`flex flex-1 flex-col overflow-hidden ${
                            chatOpen ? "max-md:hidden" : ""
                        }`}
                    >
                        <TableToolbar
                            items={[]}
                            active="table"
                            onChange={() => undefined}
                            actions={
                                <div className="flex items-center gap-1.5">
                                    {loading ? (
                                        <div className="h-3 w-24 rounded bg-gray-100 animate-pulse" />
                                    ) : null}
                                    {!taskOwnedReviewLocked &&
                                        !loading &&
                                        selectedDocIds.length > 0 && (
                                            <>
                                                {/* Desktop: compact Actions menu */}
                                                <div
                                                    ref={actionsRef}
                                                    className="relative max-md:hidden"
                                                >
                                                    <TabPillButton
                                                        onClick={() =>
                                                            setActionsOpen(
                                                                (v) => !v,
                                                            )
                                                        }
                                                    >
                                                        Actions
                                                        <ChevronDown className="h-3.5 w-3.5" />
                                                    </TabPillButton>
                                                    {actionsOpen && (
                                                        <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-gray-100 bg-white shadow-lg z-50 overflow-hidden">
                                                            <button
                                                                onClick={
                                                                    handleClearResults
                                                                }
                                                                className="w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 transition-colors"
                                                            >
                                                                Clear results
                                                            </button>
                                                            <button
                                                                onClick={
                                                                    handleDeleteDocuments
                                                                }
                                                                className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                                                            >
                                                                Delete
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                                {/* Mobile (toolbar dropdown): flattened entries */}
                                                <TabPillButton
                                                    onClick={handleClearResults}
                                                    className="md:hidden"
                                                >
                                                    Clear results
                                                </TabPillButton>
                                                <TabPillButton
                                                    onClick={
                                                        handleDeleteDocuments
                                                    }
                                                    className="md:hidden text-red-600"
                                                >
                                                    Delete
                                                </TabPillButton>
                                            </>
                                        )}
                                    {!taskOwnedReviewLocked && !loading && (
                                        <TabPillButton
                                            onClick={() => setAddColOpen(true)}
                                            disabled={
                                                savingColumn ||
                                                savingColumnsConfig
                                            }
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                            Add Columns
                                        </TabPillButton>
                                    )}
                                </div>
                            }
                        />
                        <div
                            className="relative flex flex-1 overflow-hidden"
                            onDragOver={(e) => {
                                if (taskOwnedReviewLocked) return;
                                if (!hasFilePayload(e.dataTransfer)) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "copy";
                                setDragOverReviewFiles(true);
                            }}
                            onDragLeave={(e) => {
                                if (taskOwnedReviewLocked) return;
                                if (
                                    !e.currentTarget.contains(
                                        e.relatedTarget as Node,
                                    )
                                ) {
                                    setDragOverReviewFiles(false);
                                }
                            }}
                            onDrop={(e) => {
                                if (taskOwnedReviewLocked) return;
                                if (!hasFilePayload(e.dataTransfer)) return;
                                e.preventDefault();
                                e.stopPropagation();
                                setDragOverReviewFiles(false);
                                void handleDropReviewFiles(
                                    Array.from(e.dataTransfer.files),
                                );
                            }}
                        >
                            <TRTable
                                ref={tableRef}
                                loading={loading}
                                columns={columns}
                                documents={filteredDocuments}
                                cells={cells}
                                highlightedCell={highlightedCell}
                                savingColumn={savingColumn}
                                savingColumnsConfig={savingColumnsConfig}
                                readOnly={taskOwnedReviewLocked}
                                selectedDocIds={selectedDocIds}
                                uploadingFilenames={uploadingDroppedFilenames}
                                dragOverFiles={dragOverReviewFiles}
                                onSelectionChange={setSelectedDocIds}
                                onExpand={(cell) => {
                                    setExpandedCell(cell);
                                    setExpandedCellCitation(undefined);
                                }}
                                onCitationClick={(
                                    cell,
                                    page,
                                    quote,
                                    citationRef,
                                    sheet,
                                    citationCell,
                                ) => {
                                    setExpandedCell(cell);
                                    setExpandedCellCitation({
                                        quote,
                                        page,
                                        sheet,
                                        cell: citationCell,
                                        citationRef,
                                    });
                                }}
                                onUpdateColumn={handleUpdateColumn}
                                onDeleteColumn={handleDeleteColumn}
                                onAddColumn={() => setAddColOpen(true)}
                                onAddDocuments={() => setAddDocsOpen(true)}
                            />
                        </div>
                    </div>
                    {chatOpen && (
                        <TRChatPanel
                            reviewId={reviewId}
                            reviewTitle={review?.title ?? null}
                            projectName={project?.name ?? null}
                            columns={columns}
                            documents={documents}
                            onCitationClick={handleTabularCitationClick}
                            onClose={() => {
                                setSelectedChatId(null);
                                setChatOpen(false);
                            }}
                            initialChatId={selectedChatId}
                            onChatIdChange={setSelectedChatId}
                        />
                    )}
                </div>
                {activeLitigationReview && litigationProgress && (
                    <section
                        aria-label="Evidence Inventory source review"
                        className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-gray-900/[0.08] bg-white/70 px-4 py-3 backdrop-blur-sm"
                    >
                        <div className="min-w-0">
                            <p className="text-xs font-medium text-gray-900">
                                Lawyer source review
                            </p>
                            <p className="mt-0.5 text-[11px] leading-4 text-gray-600">
                                <span className="tabular-nums">
                                    {litigationProgress.verified +
                                        litigationProgress.unresolved}
                                    {" of "}
                                    {litigationProgress.total}
                                </span>{" "}
                                findings have a lawyer disposition.
                                {!litigationReviewActive
                                    ? " This Task is no longer awaiting this review."
                                    : litigationProgress.remaining > 0
                                      ? " Open the next finding to verify it against its fixed source or keep it unresolved."
                                      : " All findings are ready to return to the Work Task."}
                            </p>
                            {litigationCompletionError && (
                                <p
                                    role="alert"
                                    className="mt-1 text-[11px] leading-4 text-red-700"
                                >
                                    {litigationCompletionError}
                                </p>
                            )}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                            {litigationReviewActive &&
                                litigationProgress.remaining > 0 && (
                                    <button
                                        type="button"
                                        onClick={
                                            openFirstIncompleteLitigationCell
                                        }
                                        className="inline-flex h-8 items-center rounded-full bg-white px-3 text-xs font-medium text-gray-700 shadow-sm outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2"
                                    >
                                        Review next finding
                                    </button>
                                )}
                            {litigationProgress.remaining === 0 &&
                                litigationReviewActive && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void completeLitigationEvidenceReview()
                                        }
                                        disabled={!litigationReviewCanComplete}
                                        className="inline-flex h-9 items-center rounded-full bg-gray-950 px-4 text-xs font-medium text-white shadow-sm outline-none transition-colors hover:bg-black focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40"
                                    >
                                        {litigationCompletionSubmitting
                                            ? "Returning to Work Task…"
                                            : "Complete review and return to Task"}
                                    </button>
                                )}
                            {!litigationReviewActive && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        router.push(
                                            `/agent-tasks/${activeLitigationReview.snapshot.task_id}?restore=1`,
                                        )
                                    }
                                    className="inline-flex h-9 items-center rounded-full bg-gray-950 px-4 text-xs font-medium text-white shadow-sm outline-none transition-colors hover:bg-black focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2"
                                >
                                    Return to Task
                                </button>
                            )}
                        </div>
                    </section>
                )}
                {litigationReview.kind === "unavailable" && (
                    <p
                        role="alert"
                        className="shrink-0 border-t border-amber-900/[0.1] bg-amber-50 px-4 py-2 text-[11px] leading-4 text-amber-900"
                    >
                        Evidence Inventory actions are locked until the server
                        can confirm this Task-owned Review:{" "}
                        {litigationReview.detail}
                    </p>
                )}
            </div>

            {/* Cell detail side panel */}
            {expandedCell &&
                (() => {
                    const expandedDoc = documents.find(
                        (d) => d.id === expandedCell.document_id,
                    );
                    const expandedCol = columns.find(
                        (c) => c.index === expandedCell.column_index,
                    );
                    if (!expandedDoc || !expandedCol) return null;
                    return (
                        <TRSidePanel
                            cell={expandedCell}
                            document={expandedDoc}
                            documents={filteredDocuments}
                            sourceDocuments={documents}
                            column={expandedCol}
                            columns={columns}
                            onClose={() => {
                                setExpandedCell(null);
                                setExpandedCellCitation(undefined);
                            }}
                            onNavigate={(documentId, columnIndex) => {
                                const nextCell = cells.find(
                                    (candidate) =>
                                        candidate.document_id === documentId &&
                                        candidate.column_index === columnIndex,
                                );
                                if (nextCell) {
                                    setExpandedCell(nextCell);
                                    setExpandedCellCitation(undefined);
                                }
                            }}
                            onRegenerate={
                                taskOwnedReviewLocked
                                    ? undefined
                                    : () =>
                                          handleRegenerateCell(
                                              expandedCell.document_id,
                                              expandedCell.column_index,
                                          )
                            }
                            displayDocument={expandedCellCitation !== undefined}
                            citationQuote={expandedCellCitation?.quote}
                            citationPage={expandedCellCitation?.page}
                            citationSheet={expandedCellCitation?.sheet}
                            citationCell={expandedCellCitation?.cell}
                            citationRef={expandedCellCitation?.citationRef}
                            litigationEvidence={
                                activeLitigationReview
                                    ? {
                                          stageLabel:
                                              litigationEvidenceStageLabel(
                                                  activeLitigationReview
                                                      .snapshot.context,
                                              ),
                                          representedSideLabel:
                                              litigationEvidenceSideLabel(
                                                  activeLitigationReview
                                                      .snapshot.context,
                                              ),
                                          citations:
                                              expandedCell.citations ?? [],
                                          reviewStatus:
                                              expandedCell.review_status,
                                          reviewActive: litigationReviewActive,
                                          saving:
                                              litigationReviewSavingCellId ===
                                              expandedCell.id,
                                          error: litigationReviewError,
                                          onReview: (decision) =>
                                              saveLitigationCellReview(
                                                  expandedCell,
                                                  decision,
                                              ),
                                          onRequestSourceBoundCorrection: (
                                              reasonCode,
                                          ) =>
                                              requestLitigationEvidenceCellCorrection(
                                                  expandedCell,
                                                  reasonCode,
                                              ),
                                      }
                                    : undefined
                            }
                        />
                    );
                })()}

            <AddColumnModal
                open={addColOpen}
                existingCount={columns.length}
                onClose={() => setAddColOpen(false)}
                onAdd={handleAddColumn}
            />

            {project ? (
                <AddProjectDocsModal
                    open={addDocsOpen}
                    onClose={() => setAddDocsOpen(false)}
                    onSelect={(docs: Document[]) => handleAddDocuments(docs)}
                    breadcrumb={[
                        "Projects",
                        project.name +
                            (project.cm_number
                                ? ` (#${project.cm_number})`
                                : ""),
                        "Tabular Reviews",
                        ...(review ? [review.title || "Untitled Review"] : []),
                        "Add Documents",
                    ]}
                    projectId={project.id}
                    excludeDocIds={new Set(documents.map((d) => d.id))}
                />
            ) : (
                <AddDocumentsModal
                    open={addDocsOpen}
                    onClose={() => setAddDocsOpen(false)}
                    onSelect={(docs: Document[]) => handleAddDocuments(docs)}
                    breadcrumb={[
                        "Tabular Reviews",
                        ...(review ? [review.title || "Untitled Review"] : []),
                        "Add Documents",
                    ]}
                />
            )}

            <TabularReviewDetailsModal
                open={detailsOpen}
                review={review}
                projects={project ? [project] : availableProjects}
                canEdit={review?.is_owner !== false}
                lockProject={Boolean(projectId)}
                onClose={() => setDetailsOpen(false)}
                onSave={handleDetailsSave}
            />

            <PeopleModal
                open={peopleModalOpen}
                onClose={() => setPeopleModalOpen(false)}
                resource={review}
                fetchPeople={getTabularReviewPeople}
                currentUserEmail={user?.email ?? null}
                breadcrumb={[
                    "Tabular Reviews",
                    review?.title || "Untitled Review",
                    "People",
                ]}
                // Only the review owner may modify the member list. PeopleModal
                // hides the add/remove controls when this prop is undefined.
                onSharedWithChange={
                    taskOwnedReviewLocked || review?.is_owner === false
                        ? undefined
                        : async (next) => {
                              const updated = await updateTabularReview(
                                  reviewId,
                                  {
                                      shared_with: next,
                                  },
                              );
                              setReview((prev) =>
                                  prev
                                      ? {
                                            ...prev,
                                            shared_with: updated.shared_with,
                                        }
                                      : prev,
                              );
                          }
                }
            />

            <TRWorkflowModal
                open={workflowModalOpen}
                onClose={() => {
                    if (applyingWorkflow) return;
                    setWorkflowModalOpen(false);
                }}
                onApply={handleApplyWorkflow}
                breadcrumbs={[
                    ...(project
                        ? [
                              "Projects",
                              project.name +
                                  (project.cm_number
                                      ? ` (#${project.cm_number})`
                                      : ""),
                          ]
                        : []),
                    "Tabular Reviews",
                    review?.title || "Untitled Review",
                    "Add workflow",
                ]}
                applying={applyingWorkflow}
            />

            <ConfirmPopup
                open={deleteReviewConfirmOpen}
                title="Delete tabular review?"
                message="This will permanently delete the tabular review and its generated cells."
                confirmLabel="Delete"
                confirmStatus={
                    deleteReviewStatus === "deleting"
                        ? "loading"
                        : deleteReviewStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (deleteReviewStatus === "deleting") return;
                    setDeleteReviewConfirmOpen(false);
                    setDeleteReviewStatus("idle");
                }}
                onConfirm={() => void confirmReviewDelete()}
            />

            <OwnerOnlyPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />

            <ApiKeyMissingPopup
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
        </div>
    );
}
