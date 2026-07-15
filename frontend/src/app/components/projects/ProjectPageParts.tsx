"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/ProjectPageParts.tsx
import type { CSSProperties, ReactNode } from "react";
import { Library, Loader2, MessageSquare, Table2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { VersionChip } from "@/app/components/shared/VersionChip";
import { useI18n } from "@/app/i18n";
import type {
    VeraDocumentVersionWire,
    VeraProjectWire,
} from "@/app/lib/veraWireTypes";

export type ProjectWorkspaceSection =
    | "documents"
    | "assistant"
    | "workflows"
    | "reviews";

export const DOC_NAME_COL_W =
    "w-[292px] sm:w-[332px] md:w-[392px] lg:w-[452px] xl:w-[532px] 2xl:w-[592px] shrink-0";

const TREE_CONTROL_WIDTH_PX = 32;
const TREE_NAME_PADDING_PX = 16;

export function treeNameCellStyle(depth: number): CSSProperties | undefined {
    if (depth <= 0) return undefined;
    return {
        paddingLeft: TREE_NAME_PADDING_PX + depth * TREE_CONTROL_WIDTH_PX,
    };
}

export function DocIcon({
    fileType,
    muted = false,
}: {
    fileType: string | null;
    muted?: boolean;
}) {
    return <FileTypeIcon fileType={fileType} className="h-4 w-4" muted={muted} />;
}

export function DocVersionHistory({
    documentId,
    currentVersionId,
    loading,
    versions,
    depth = 0,
    onDownloadVersion,
    onOpenVersion,
}: {
    documentId: string;
    currentVersionId: string | null;
    loading: boolean;
    versions: VeraDocumentVersionWire[];
    depth?: number;
    onDownloadVersion: (documentId: string, versionId: string) => void;
    onOpenVersion: (versionId: string) => void;
}) {
    const { t, formatDate, formatFileSize } = useI18n();

    if (loading && versions.length === 0) {
        return (
            <div className="flex h-10 items-center gap-3 bg-gray-100 px-4 text-xs text-gray-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t("common.status.loading")}
            </div>
        );
    }

    return versions
        .filter((version) => version.id !== currentVersionId)
        .map((version) => {
            const versionNumber = version.version_number ?? 1;
            const deleted = version.deleted_at != null;
            return (
                <div
                    key={version.id}
                    className="group flex h-10 items-center pr-8 text-sm text-gray-500 transition-colors bg-gray-100 hover:bg-gray-200"
                >
                    <button
                        type="button"
                        disabled={deleted}
                        onClick={() => onOpenVersion(version.id)}
                        className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} flex min-w-0 items-center gap-4 self-stretch bg-gray-100 py-2 pl-4 pr-2 text-left group-hover:bg-gray-200 disabled:cursor-default`}
                        style={treeNameCellStyle(depth)}
                    >
                        <DocIcon fileType={version.file_type ?? null} muted={deleted} />
                        <span className="min-w-0 flex-1 truncate text-gray-700">
                            {version.filename ?? t("documents.version", { version: versionNumber })}
                        </span>
                        <VersionChip n={versionNumber} />
                    </button>
                    <span className="ml-auto w-24 shrink-0 truncate text-xs text-gray-400">
                        {typeof version.size_bytes === "number"
                            ? formatFileSize(version.size_bytes)
                            : "—"}
                    </span>
                    <span className="w-32 shrink-0 truncate text-xs text-gray-400">
                        {formatDate(version.created_at)}
                    </span>
                    <button
                        type="button"
                        disabled={deleted}
                        onClick={() => onDownloadVersion(documentId, version.id)}
                        className="text-xs text-gray-500 hover:text-gray-900 disabled:opacity-40"
                    >
                        {t("common.actions.download")}
                    </button>
                </div>
            );
        });
}

export function ProjectPageHeader({
    project,
    search,
    loading,
    onBackToProjects,
    onDeleteProject,
    onSearchChange,
}: {
    project: VeraProjectWire | null;
    search: string;
    loading: boolean;
    onBackToProjects: () => void;
    onDeleteProject: () => void;
    onSearchChange: (search: string) => void;
}) {
    const { t } = useI18n();
    const router = useRouter();
    return (
        <PageHeader
            loading={loading}
            breadcrumbs={[
                {
                    label: t("projects.title"),
                    onClick: onBackToProjects,
                    title: t("common.actions.back"),
                },
                project
                    ? { label: project.name }
                    : { loading: true, skeletonClassName: "w-40" },
            ]}
            actionGroups={[
                [
                    {
                        type: "search",
                        value: search,
                        onChange: onSearchChange,
                        placeholder: t("common.actions.search"),
                    },
                    {
                        type: "delete",
                        onClick: onDeleteProject,
                        title: t("projects.deleteConfirm.action"),
                    },
                ],
                {
                    actions: [
                        {
                            icon: <MessageSquare className="h-4 w-4" />,
                            label: <span className="hidden sm:inline">{t("assistant.newChat")}</span>,
                            onClick: () => {
                                if (project) {
                                    router.push(`/projects/${project.id}/assistant`);
                                }
                            },
                        },
                        {
                            icon: <Library className="h-4 w-4" />,
                            label: <span className="hidden sm:inline">{t("workflows.title")}</span>,
                            onClick: () => {
                                if (project) {
                                    router.push(`/projects/${project.id}/workflows`);
                                }
                            },
                        },
                        {
                            icon: <Table2 className="h-4 w-4" />,
                            label: <span className="hidden sm:inline">{t("tabular.title")}</span>,
                            onClick: () => {
                                if (project) {
                                    router.push(`/projects/${project.id}/tabular-reviews`);
                                }
                            },
                        },
                    ],
                },
            ]}
        />
    );
}

export function UnavailableProjectSection({
    title,
    subtitle,
    toolbar,
}: {
    title: string;
    subtitle: string;
    toolbar?: ReactNode;
}) {
    const { t } = useI18n();
    return (
        <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {toolbar}
            <div className="flex min-h-0 flex-1 items-center justify-center p-8">
                <div className="max-w-md rounded-2xl border border-white/70 bg-white/65 p-8 text-center shadow-[0_4px_14px_rgba(15,23,42,0.08)] backdrop-blur-xl">
                    <h1 className="text-base font-medium text-gray-900">{title}</h1>
                    <p className="mt-2 text-sm text-gray-500">{subtitle}</p>
                    <p className="mt-4 text-xs text-gray-400">{t("errors.unsupported")}</p>
                </div>
            </div>
        </div>
    );
}
