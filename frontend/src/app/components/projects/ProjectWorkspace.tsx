"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/ProjectWorkspace.tsx
import {
    createContext,
    type ReactNode,
    use,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter, useSelectedLayoutSegments } from "next/navigation";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { useI18n } from "@/app/i18n";
import {
    deleteVeraProject,
    getVeraProject,
    listVeraProjectDocuments,
    listVeraProjectFolders,
    VeraApiError,
} from "@/app/lib/veraApi";
import type {
    VeraDocumentWire,
    VeraFolderWire,
    VeraProjectWire,
} from "@/app/lib/veraWireTypes";
import {
    ProjectPageHeader,
    type ProjectWorkspaceSection,
} from "./ProjectPageParts";

type ProjectWorkspaceValue = {
    projectId: string;
    project: VeraProjectWire | null;
    setProject: React.Dispatch<React.SetStateAction<VeraProjectWire | null>>;
    documents: VeraDocumentWire[];
    setDocuments: React.Dispatch<React.SetStateAction<VeraDocumentWire[]>>;
    folders: VeraFolderWire[];
    setFolders: React.Dispatch<React.SetStateAction<VeraFolderWire[]>>;
    projectLoading: boolean;
    projectError: string | null;
    activeSection: ProjectWorkspaceSection;
    search: string;
    setSearch: (search: string) => void;
    refreshProject: () => Promise<void>;
};

const ProjectWorkspaceContext =
    createContext<ProjectWorkspaceValue | null>(null);

export const DOCUMENT_STATUS_POLL_DELAY_MS = 1_500;
export const DOCUMENT_STATUS_POLL_MAX_CONSECUTIVE_FAILURES = 5;
const DOCUMENT_STATUS_POLL_MAX_RETRY_DELAY_MS = 12_000;

function isDocumentParseActive(document: VeraDocumentWire): boolean {
    return document.status === "pending" || document.status === "processing";
}

function isRetryableDocumentPollError(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    if (!(error instanceof VeraApiError)) return false;
    return (
        error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        (error.status >= 500 && error.status < 600)
    );
}

function documentPollRetryDelay(consecutiveFailures: number): number {
    return Math.min(
        DOCUMENT_STATUS_POLL_DELAY_MS * 2 ** consecutiveFailures,
        DOCUMENT_STATUS_POLL_MAX_RETRY_DELAY_MS,
    );
}

type DocumentStatusPollOptions = {
    load: (signal: AbortSignal) => Promise<VeraDocumentWire[]>;
    mutationGeneration: () => number;
    applySnapshot: (documents: VeraDocumentWire[]) => void;
    reportError: (error: unknown) => void;
    clearError: () => void;
    schedule: (callback: () => void, delayMs: number) => number;
    cancelSchedule: (handle: number) => void;
};

export function createDocumentStatusPollCoordinator(
    options: DocumentStatusPollOptions,
) {
    let stopped = true;
    let timeoutHandle: number | null = null;
    let requestController: AbortController | null = null;
    let consecutiveFailures = 0;

    const schedule = (delayMs: number) => {
        if (stopped || timeoutHandle !== null) return;
        timeoutHandle = options.schedule(() => {
            timeoutHandle = null;
            void poll();
        }, delayMs);
    };

    const poll = async () => {
        if (stopped || requestController !== null) return;
        const controller = new AbortController();
        requestController = controller;
        const generationAtRequestStart = options.mutationGeneration();
        try {
            const snapshot = await options.load(controller.signal);
            if (stopped || controller.signal.aborted) return;
            consecutiveFailures = 0;
            if (generationAtRequestStart !== options.mutationGeneration()) {
                schedule(DOCUMENT_STATUS_POLL_DELAY_MS);
                return;
            }
            options.clearError();
            options.applySnapshot(snapshot);
            if (snapshot.some(isDocumentParseActive)) {
                schedule(DOCUMENT_STATUS_POLL_DELAY_MS);
            }
        } catch (error) {
            if (stopped || controller.signal.aborted) return;
            consecutiveFailures += 1;
            if (
                isRetryableDocumentPollError(error) &&
                consecutiveFailures <
                    DOCUMENT_STATUS_POLL_MAX_CONSECUTIVE_FAILURES
            ) {
                schedule(documentPollRetryDelay(consecutiveFailures));
            } else {
                // Keep recoverable failures non-disruptive while the finite
                // retry budget remains. Permanent or exhausted failures must
                // be visible rather than silently stopping status updates.
                options.reportError(error);
            }
        } finally {
            if (requestController === controller) {
                requestController = null;
            }
        }
    };

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            schedule(DOCUMENT_STATUS_POLL_DELAY_MS);
        },
        stop() {
            if (stopped) return;
            stopped = true;
            if (timeoutHandle !== null) {
                options.cancelSchedule(timeoutHandle);
                timeoutHandle = null;
            }
            requestController?.abort();
            requestController = null;
        },
    };
}

export function useProjectWorkspace() {
    const value = useContext(ProjectWorkspaceContext);
    if (!value) {
        throw new Error(
            "useProjectWorkspace must be used inside ProjectWorkspaceProvider",
        );
    }
    return value;
}

function activeSectionFromSegments(
    segments: string[],
): ProjectWorkspaceSection {
    if (segments[0] === "assistant") return "assistant";
    if (segments[0] === "tabular-reviews") return "reviews";
    return "documents";
}

export function ProjectWorkspaceProvider({
    projectId,
    children,
}: {
    projectId: string;
    children: ReactNode;
}) {
    const router = useRouter();
    const segments = useSelectedLayoutSegments();
    const { t, errorMessage } = useI18n();
    const [project, setProject] = useState<VeraProjectWire | null>(null);
    const [documents, replaceDocumentsState] = useState<VeraDocumentWire[]>([]);
    const [folders, setFolders] = useState<VeraFolderWire[]>([]);
    const [projectLoading, setProjectLoading] = useState(true);
    const [projectError, setProjectError] = useState<string | null>(null);
    const [searchBySection, setSearchBySection] = useState<
        Record<ProjectWorkspaceSection, string>
    >({ documents: "", assistant: "", reviews: "" });
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [deleteConfirmName, setDeleteConfirmName] = useState("");
    const [deleteStatus, setDeleteStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const deletingProjectRef = useRef(false);
    const documentMutationGenerationRef = useRef(0);
    const setDocuments = useCallback<
        React.Dispatch<React.SetStateAction<VeraDocumentWire[]>>
    >((update) => {
        documentMutationGenerationRef.current += 1;
        replaceDocumentsState(update);
    }, []);

    const activeSection = activeSectionFromSegments(segments);
    const search = searchBySection[activeSection];
    const setSearch = useCallback(
        (value: string) =>
            setSearchBySection((current) => ({
                ...current,
                [activeSection]: value,
            })),
        [activeSection],
    );

    const loadProject = useCallback(
        async (signal?: AbortSignal) => {
            setProjectLoading(true);
            setProjectError(null);
            try {
                const [loadedProject, loadedDocuments, loadedFolders] =
                    await Promise.all([
                        getVeraProject(projectId, signal),
                        listVeraProjectDocuments(projectId, {}, signal),
                        listVeraProjectFolders(projectId, {}, signal),
                    ]);
                if (signal?.aborted) return;
                replaceDocumentsState(loadedDocuments);
                setFolders(loadedFolders);
                setProject({
                    ...loadedProject,
                    documents: loadedDocuments,
                    folders: loadedFolders,
                    document_count: loadedDocuments.length,
                });
            } catch (error) {
                if (signal?.aborted) return;
                setProject(null);
                replaceDocumentsState([]);
                setFolders([]);
                setProjectError(errorMessage(error as Error));
            } finally {
                if (!signal?.aborted) setProjectLoading(false);
            }
        },
        [errorMessage, projectId],
    );

    useEffect(() => {
        const controller = new AbortController();
        void loadProject(controller.signal);
        return () => controller.abort();
    }, [loadProject]);

    useEffect(() => {
        setProject((current) =>
            current
                ? {
                      ...current,
                      documents,
                      folders,
                      document_count: documents.length,
                  }
                : current,
        );
    }, [documents, folders]);

    const hasActiveDocumentParsing = documents.some(isDocumentParseActive);

    useEffect(() => {
        if (!hasActiveDocumentParsing) return;

        const coordinator = createDocumentStatusPollCoordinator({
            load: (signal) =>
                listVeraProjectDocuments(projectId, {}, signal),
            mutationGeneration: () =>
                documentMutationGenerationRef.current,
            applySnapshot: replaceDocumentsState,
            reportError: (error) =>
                setProjectError(errorMessage(error as Error)),
            clearError: () => setProjectError(null),
            schedule: (callback, delayMs) =>
                window.setTimeout(callback, delayMs),
            cancelSchedule: (handle) => window.clearTimeout(handle),
        });
        coordinator.start();
        return () => coordinator.stop();
    }, [errorMessage, hasActiveDocumentParsing, projectId]);

    useEffect(() => {
        if (!deleteConfirmOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && deleteStatus !== "deleting") {
                setDeleteConfirmOpen(false);
                setDeleteConfirmName("");
                setDeleteError(null);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [deleteConfirmOpen, deleteStatus]);

    const refreshProject = useCallback(async () => {
        await loadProject();
    }, [loadProject]);

    const value = useMemo<ProjectWorkspaceValue>(
        () => ({
            projectId,
            project,
            setProject,
            documents,
            setDocuments,
            folders,
            setFolders,
            projectLoading,
            projectError,
            activeSection,
            search,
            setSearch,
            refreshProject,
        }),
        [
            activeSection,
            documents,
            folders,
            project,
            projectError,
            projectId,
            projectLoading,
            refreshProject,
            search,
            setDocuments,
            setSearch,
        ],
    );

    const requestProjectDelete = () => {
        if (!project) return;
        setDeleteConfirmName("");
        setDeleteError(null);
        setDeleteStatus("idle");
        setDeleteConfirmOpen(true);
    };

    const confirmProjectDelete = async () => {
        if (
            !project ||
            deleteConfirmName !== project.name ||
            deletingProjectRef.current
        ) {
            return;
        }
        deletingProjectRef.current = true;
        setDeleteStatus("deleting");
        setDeleteError(null);
        try {
            await deleteVeraProject(projectId, project.name);
            setDeleteStatus("deleted");
            router.replace("/projects");
        } catch (error) {
            setDeleteStatus("idle");
            setDeleteError(errorMessage(error as Error));
        } finally {
            deletingProjectRef.current = false;
        }
    };

    return (
        <ProjectWorkspaceContext.Provider value={value}>
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <ProjectPageHeader
                    project={project}
                    search={search}
                    loading={projectLoading}
                    onBackToProjects={() => router.push("/projects")}
                    onDeleteProject={requestProjectDelete}
                    onSearchChange={setSearch}
                />
                {children}
                <ConfirmPopup
                    open={deleteConfirmOpen}
                    title={t("projects.deleteConfirm.title")}
                    message={
                        <div className="space-y-3">
                            <p>{t("projects.deleteConfirm.body")}</p>
                            {project && (
                                <label className="block space-y-2">
                                    <span className="block text-xs text-gray-500">
                                        {t("projects.deleteConfirm.namePrompt", {
                                            name: project.name,
                                        })}
                                    </span>
                                    <input
                                        autoFocus
                                        value={deleteConfirmName}
                                        onChange={(event) =>
                                            setDeleteConfirmName(event.target.value)
                                        }
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                event.preventDefault();
                                                void confirmProjectDelete();
                                            }
                                        }}
                                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
                                    />
                                </label>
                            )}
                            {deleteError && (
                                <p role="alert" className="text-xs text-red-600">
                                    {deleteError}
                                </p>
                            )}
                        </div>
                    }
                    confirmLabel={t("projects.deleteConfirm.action")}
                    confirmStatus={
                        deleteStatus === "deleting"
                            ? "loading"
                            : deleteStatus === "deleted"
                              ? "complete"
                              : "idle"
                    }
                    confirmDisabled={
                        !project || deleteConfirmName !== project.name
                    }
                    cancelLabel={t("common.actions.cancel")}
                    cancelDisabled={deleteStatus === "deleting"}
                    onCancel={() => {
                        if (deleteStatus === "deleting") return;
                        setDeleteConfirmOpen(false);
                        setDeleteConfirmName("");
                        setDeleteError(null);
                    }}
                    onConfirm={() => void confirmProjectDelete()}
                />
            </div>
        </ProjectWorkspaceContext.Provider>
    );
}

export function ProjectSectionToolbar({
    actions,
}: {
    actions?: ReactNode;
}) {
    const { activeSection, projectId } = useProjectWorkspace();
    const { t } = useI18n();
    const router = useRouter();
    const items = [
        { id: "documents", label: t("documents.title"), disabled: false },
        { id: "assistant", label: t("assistant.title"), disabled: true },
        { id: "reviews", label: t("tabular.title"), disabled: true },
    ] as const;

    return (
        <div className="flex h-10 items-center border-b border-gray-200 px-4 md:px-10">
            <div className="flex flex-1 items-center gap-5">
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        disabled={item.disabled}
                        title={item.disabled ? t("errors.unsupported") : undefined}
                        aria-current={activeSection === item.id ? "page" : undefined}
                        onClick={() => {
                            if (item.id === "documents") {
                                router.push(`/projects/${projectId}`);
                            }
                        }}
                        className={`text-xs transition-colors disabled:cursor-not-allowed ${
                            activeSection === item.id
                                ? "font-medium text-gray-700"
                                : item.disabled
                                  ? "font-normal text-gray-300"
                                  : "font-normal text-gray-500 hover:text-gray-700"
                        }`}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
    );
}

export function ProjectWorkspaceLayout({
    params,
    children,
}: {
    params: Promise<{ id: string }>;
    children: ReactNode;
}) {
    const { id } = use(params);
    return (
        <ProjectWorkspaceProvider projectId={id}>
            {children}
        </ProjectWorkspaceProvider>
    );
}
