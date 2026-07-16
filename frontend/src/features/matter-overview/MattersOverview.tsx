"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderKanban } from "lucide-react";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import {
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { useI18n } from "@/app/i18n";
import {
  listVeraMatters,
  type VeraMatterWire,
} from "@/app/lib/veraMatterApi";
import {
  MatterProfileModal,
  type MatterProfileModalMode,
} from "./MatterProfileModal";

const PAGE_SIZE = 100;

type ProfileAction = {
  matter: VeraMatterWire;
  mode: Exclude<MatterProfileModalMode, "create-matter">;
} | null;

export function MattersOverview() {
  const router = useRouter();
  const { t, errorMessage, formatDate, formatNumber } = useI18n();
  const [items, setItems] = useState<VeraMatterWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [profileAction, setProfileAction] = useState<ProfileAction>(null);
  const firstRequestRef = useRef<AbortController | null>(null);
  const moreRequestRef = useRef<AbortController | null>(null);

  const loadFirstPage = useCallback(async () => {
    const controller = new AbortController();
    firstRequestRef.current?.abort();
    firstRequestRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await listVeraMatters({ limit: PAGE_SIZE }, controller.signal);
      if (controller.signal.aborted) return;
      setItems(page.items.filter((item) => item.project.status !== "deleted"));
      setNextCursor(page.next_cursor);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setItems([]);
      setNextCursor(null);
      setLoadError(errorMessage(cause as Error));
    } finally {
      if (firstRequestRef.current === controller) firstRequestRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [errorMessage]);

  useEffect(() => {
    void loadFirstPage();
    return () => {
      firstRequestRef.current?.abort();
      moreRequestRef.current?.abort();
    };
  }, [loadFirstPage]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const controller = new AbortController();
    moreRequestRef.current?.abort();
    moreRequestRef.current = controller;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const page = await listVeraMatters(
        { cursor: nextCursor, limit: PAGE_SIZE },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setItems((current) => {
        const byId = new Map(current.map((item) => [item.project.id, item]));
        for (const item of page.items) {
          if (item.project.status !== "deleted") byId.set(item.project.id, item);
        }
        return [...byId.values()];
      });
      setNextCursor(page.next_cursor);
    } catch (cause) {
      if (!controller.signal.aborted) setLoadError(errorMessage(cause as Error));
    } finally {
      if (moreRequestRef.current === controller) moreRequestRef.current = null;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  const profiled = items.filter((item) => item.profile_state !== "absent");
  const genericProjects = items.filter((item) => item.profile_state === "absent");

  function replaceMatter(saved: VeraMatterWire) {
    setItems((current) => [
      saved,
      ...current.filter((item) => item.project.id !== saved.project.id),
    ]);
  }

  function row(item: VeraMatterWire) {
    const { project, matter_profile: profile } = item;
    const action = item.capabilities.matter_profile;
    const actionLabel =
      action === "create"
        ? t("matters.profile.convert")
        : action === "classify"
          ? t("matters.profile.classify")
          : action === "edit"
            ? t("common.actions.open")
            : t("matters.capabilities.readOnlyShort");
    return (
      <TableRow
        key={project.id}
        onClick={() => router.push(`/matters/${project.id}`)}
      >
        <TableStickyCell>
          <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
            {project.name}
          </span>
        </TableStickyCell>
        <TableCell className="ml-auto w-48 pr-6">
          {item.profile_state === "absent" ? (
            <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500">
              {t("matters.profile.genericProject")}
            </span>
          ) : item.profile_state === "classification_required" ? (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
              {t("matters.profile.classificationRequired")}
            </span>
          ) : (
            profile?.workspace_type
              ? t(`matters.workspaceTypes.${profile.workspace_type}`)
              : t("matters.profile.classificationRequired")
          )}
        </TableCell>
        <TableCell className="w-44 pr-6">{profile?.client_name ?? "—"}</TableCell>
        <TableCell className="w-40 pr-6">{profile?.jurisdiction ?? "—"}</TableCell>
        <TableCell className="w-40 pr-6">{project.cm_number || "—"}</TableCell>
        <TableCell className="w-40 pr-6">{project.practice || "—"}</TableCell>
        <TableCell className="w-24">{formatNumber(project.document_count)}</TableCell>
        <TableCell className="w-24">
          {t(`matters.status.${project.status}`)}
        </TableCell>
        <TableCell className="w-36">{formatDate(project.updated_at)}</TableCell>
        <TableCell className="w-40 text-right">
          {action === "unavailable" ? (
            <span className="text-xs text-gray-400">{actionLabel}</span>
          ) : (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (action === "edit") {
                  router.push(`/matters/${project.id}`);
                } else {
                  setProfileAction({
                    matter: item,
                    mode:
                      action === "create" ? "create-profile" : "edit-profile",
                  });
                }
              }}
              className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:border-gray-300 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            >
              {actionLabel}
            </button>
          )}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        actions={[
          {
            type: "new",
            onClick: () => setCreateOpen(true),
            title: t("matters.create"),
          },
        ]}
      >
        <div>
          <h1 className="font-serif text-2xl font-medium text-gray-900">
            {t("matters.title")}
          </h1>
          <p className="mt-1 text-xs text-gray-500">{t("matters.subtitle")}</p>
        </div>
      </PageHeader>

      {loadError && items.length > 0 && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-y border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700 md:px-10"
        >
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadFirstPage()} className="font-medium">
            {t("common.actions.retry")}
          </button>
        </div>
      )}

      <TableScrollArea>
        <TableHeaderRow>
          <TableStickyCell header>{t("matters.fields.name")}</TableStickyCell>
          <TableHeaderCell className="ml-auto w-48">
            {t("matters.fields.workspaceType")}
          </TableHeaderCell>
          <TableHeaderCell className="w-44">
            {t("matters.fields.clientName")}
          </TableHeaderCell>
          <TableHeaderCell className="w-40">
            {t("matters.fields.jurisdiction")}
          </TableHeaderCell>
          <TableHeaderCell className="w-40">
            {t("matters.fields.matterNumber")}
          </TableHeaderCell>
          <TableHeaderCell className="w-40">
            {t("matters.fields.practiceArea")}
          </TableHeaderCell>
          <TableHeaderCell className="w-24">{t("documents.title")}</TableHeaderCell>
          <TableHeaderCell className="w-24">{t("matters.fields.status")}</TableHeaderCell>
          <TableHeaderCell className="w-36">{t("common.fields.updatedAt")}</TableHeaderCell>
          <TableHeaderCell className="w-40 text-right">{t("matters.fields.action")}</TableHeaderCell>
        </TableHeaderRow>

        {loading ? (
          <TableBody>
            {[1, 2, 3].map((skeleton) => (
              <TableRow key={skeleton} interactive={false}>
                <TableStickyCell hover={false} bgClassName="bg-transparent">
                  <SkeletonLine className="w-48" />
                </TableStickyCell>
                {[
                  "w-48",
                  "w-44",
                  "w-40",
                  "w-40",
                  "w-40",
                  "w-24",
                  "w-24",
                  "w-36",
                  "w-40",
                ].map((width, index) => (
                  <TableCell key={`${skeleton}:${width}:${index}`} className={`${index === 0 ? "ml-auto " : ""}${width}`}>
                    <SkeletonLine className="w-16" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        ) : loadError && items.length === 0 ? (
          <TableEmptyState>
            <FolderKanban className="mb-4 h-8 w-8 text-gray-300" />
            <p className="font-serif text-2xl font-medium text-gray-900">
              {t("matters.errors.loadTitle")}
            </p>
            <p role="alert" className="mt-1 max-w-sm text-xs text-red-500">
              {loadError}
            </p>
            <button type="button" onClick={() => void loadFirstPage()} className="mt-4 text-xs font-medium text-gray-600 hover:text-gray-900">
              {t("common.actions.retry")}
            </button>
          </TableEmptyState>
        ) : items.length === 0 ? (
          <TableEmptyState>
            <FolderKanban className="mb-4 h-8 w-8 text-gray-300" />
            <p className="font-serif text-2xl font-medium text-gray-900">
              {t("matters.empty.title")}
            </p>
            <p className="mt-1 max-w-sm text-xs text-gray-400">
              {t("matters.empty.body")}
            </p>
            <button type="button" onClick={() => setCreateOpen(true)} className="mt-4 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-gray-700">
              {t("matters.empty.action")}
            </button>
          </TableEmptyState>
        ) : (
          <TableBody>
            {profiled.length > 0 && (
              <div className="flex h-9 items-center border-b border-gray-100 bg-gray-50 px-4 text-xs font-semibold text-gray-600 md:px-10">
                {t("matters.sections.matters", { count: profiled.length })}
              </div>
            )}
            {profiled.map(row)}
            {genericProjects.length > 0 && (
              <div className="flex h-9 items-center border-b border-gray-100 bg-gray-50 px-4 text-xs font-semibold text-gray-600 md:px-10">
                {t("matters.sections.genericProjects", { count: genericProjects.length })}
              </div>
            )}
            {genericProjects.map(row)}
            {(nextCursor || loadingMore) && (
              <div className="flex h-12 items-center justify-center border-b border-gray-50">
                <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="text-xs font-medium text-gray-500 hover:text-gray-900 disabled:opacity-40">
                  {loadingMore ? t("matters.loadingMore") : t("matters.loadMore")}
                </button>
              </div>
            )}
          </TableBody>
        )}
      </TableScrollArea>

      <MatterProfileModal
        open={createOpen}
        mode="create-matter"
        onClose={() => setCreateOpen(false)}
        onSaved={(saved) => {
          replaceMatter(saved);
          router.push(`/matters/${saved.project.id}`);
        }}
      />
      <MatterProfileModal
        open={profileAction !== null}
        mode={profileAction?.mode ?? "create-profile"}
        project={profileAction?.matter.project}
        profile={profileAction?.matter.matter_profile}
        onClose={() => setProfileAction(null)}
        onSaved={(saved) => {
          replaceMatter(saved);
          setProfileAction(null);
          router.push(`/matters/${saved.project.id}`);
        }}
      />
    </div>
  );
}
