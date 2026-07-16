"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, FolderKanban, Loader2, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import { useI18n } from "@/app/i18n";
import {
  getVeraMatter,
  type VeraMatterWire,
} from "@/app/lib/veraMatterApi";
import { MatterNavigation } from "./MatterNavigation";
import { MatterProfileModal } from "./MatterProfileModal";

export function MatterWorkspaceOverview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { t, errorMessage, formatDate, formatNumber } = useI18n();
  const [matter, setMatter] = useState<VeraMatterWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setFailure(null);
    try {
      const loaded = await getVeraMatter(id, controller.signal);
      if (!controller.signal.aborted) setMatter(loaded);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setMatter(null);
        setFailure(errorMessage(cause as Error));
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [errorMessage, id]);

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("matters.detail.loading")}
      </div>
    );
  }

  if (!matter) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-white/70 bg-white/70 p-6 text-center shadow-lg backdrop-blur-xl">
          <AlertCircle className="mx-auto h-7 w-7 text-red-500" />
          <h1 className="mt-3 font-serif text-xl text-gray-900">
            {t("matters.detail.unavailable")}
          </h1>
          {failure && <p role="alert" className="mt-2 text-sm text-red-600">{failure}</p>}
          <div className="mt-5 flex justify-center gap-3">
            <button type="button" onClick={() => void load()} className="rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white">
              {t("common.actions.retry")}
            </button>
            <Link href="/matters" className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-medium text-gray-700">
              {t("matters.detail.back")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { project, matter_profile: profile, capabilities } = matter;
  const profileWritable = capabilities.matter_profile !== "unavailable";
  const profileActionLabel =
    capabilities.matter_profile === "create"
      ? t("matters.profile.convert")
      : capabilities.matter_profile === "classify"
        ? t("matters.profile.classify")
        : capabilities.matter_profile === "edit"
          ? t("matters.profile.edit")
          : t("matters.capabilities.readOnlyShort");

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        breadcrumbs={[
          { label: t("matters.title"), onClick: () => router.push("/matters") },
          { label: project.name },
        ]}
        actions={
          profileWritable
            ? [
                {
                  type: "button",
                  label: profileActionLabel,
                  onClick: () => setProfileModalOpen(true),
                },
              ]
            : []
        }
      />
      <MatterNavigation projectId={project.id} capabilities={capabilities} />

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto max-w-6xl space-y-6">
          {matter.profile_state === "absent" && (
            <section className="rounded-2xl border border-blue-100 bg-blue-50/70 p-5" aria-labelledby="generic-project-heading">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 id="generic-project-heading" className="text-sm font-semibold text-blue-950">
                    {t("matters.profile.genericTitle")}
                  </h2>
                  <p className="mt-1 max-w-2xl text-sm text-blue-800">
                    {t(
                      profileWritable
                        ? "matters.profile.genericBody"
                        : "matters.profile.genericReadOnlyBody",
                    )}
                  </p>
                </div>
                {profileWritable && (
                  <button type="button" onClick={() => setProfileModalOpen(true)} className="shrink-0 rounded-full bg-blue-950 px-4 py-1.5 text-xs font-medium text-white">
                    {t("matters.profile.convert")}
                  </button>
                )}
              </div>
            </section>
          )}

          {matter.profile_state === "classification_required" && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5" aria-labelledby="classification-heading">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 id="classification-heading" className="text-sm font-semibold text-amber-950">
                    {t("matters.profile.classificationRequired")}
                  </h2>
                  <p className="mt-1 max-w-2xl text-sm text-amber-800">
                    {t(
                      profileWritable
                        ? "matters.profile.classificationBody"
                        : "matters.profile.classificationReadOnlyBody",
                    )}
                  </p>
                </div>
                {profileWritable && (
                  <button type="button" onClick={() => setProfileModalOpen(true)} className="shrink-0 rounded-full bg-amber-950 px-4 py-1.5 text-xs font-medium text-white">
                    {t("matters.profile.classify")}
                  </button>
                )}
              </div>
            </section>
          )}

          {capabilities.inference === "policy_gate_closed" && (
            <section className="flex gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm" aria-label={t("matters.capabilities.inferenceClosedTitle")}>
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-gray-500" />
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  {t("matters.capabilities.inferenceClosedTitle")}
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  {t("matters.capabilities.inferenceClosed")}
                </p>
              </div>
            </section>
          )}

          {capabilities.inference === "unavailable" && (
            <section className="flex gap-3 rounded-2xl border border-gray-200 bg-gray-50 p-4" aria-label={t("matters.capabilities.readOnlyTitle")}>
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-gray-500" />
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  {t("matters.capabilities.readOnlyTitle")}
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  {t("matters.capabilities.readOnly")}
                </p>
              </div>
            </section>
          )}

          <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]" aria-label={t("matters.navigation.overview")}>
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-gray-100 p-2">
                  <FolderKanban className="h-5 w-5 text-gray-600" />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate font-serif text-2xl font-medium text-gray-900">{project.name}</h1>
                  <p className="mt-1 text-sm text-gray-500">
                    {project.description || t("common.status.empty")}
                  </p>
                </div>
              </div>
              <dl className="mt-6 grid gap-5 sm:grid-cols-2">
                <MatterDatum label={t("matters.fields.matterNumber")} value={project.cm_number || "—"} />
                <MatterDatum label={t("matters.fields.practiceArea")} value={project.practice || "—"} />
                <MatterDatum label={t("matters.fields.status")} value={t(`matters.status.${project.status}`)} />
                <MatterDatum label={t("common.fields.updatedAt")} value={formatDate(project.updated_at)} />
              </dl>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900">{t("matters.detail.activity")}</h2>
              <dl className="mt-5 grid grid-cols-2 gap-4">
                <MatterDatum label={t("documents.title")} value={formatNumber(project.document_count)} />
                <MatterDatum label={t("assistant.title")} value={formatNumber(project.chat_count)} />
                <MatterDatum label={t("workflows.title")} value={formatNumber(project.workflow_count)} />
                <MatterDatum label={t("matters.detail.tabularReviews")} value={formatNumber(project.tabular_review_count)} />
              </dl>
            </div>
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm" aria-labelledby="matter-profile-heading">
            <div className="flex items-center justify-between gap-3">
              <h2 id="matter-profile-heading" className="text-sm font-semibold text-gray-900">{t("matters.profile.title")}</h2>
              <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">
                {t(`matters.profileStates.${matter.profile_state}`)}
              </span>
            </div>
            {profile ? (
              <dl className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                <MatterDatum label={t("matters.fields.workspaceType")} value={profile.workspace_type ? t(`matters.workspaceTypes.${profile.workspace_type}`) : t("matters.profile.classificationRequired")} />
                <MatterDatum label={t("matters.fields.clientName")} value={profile.client_name ?? "—"} />
                <MatterDatum label={t("matters.fields.jurisdiction")} value={profile.jurisdiction ?? "—"} />
                <MatterDatum label={t("matters.fields.representedRole")} value={profile.represented_role ?? "—"} />
                <MatterDatum className="sm:col-span-2" label={t("matters.fields.objective")} value={profile.objective ?? "—"} />
              </dl>
            ) : (
              <p className="mt-4 text-sm text-gray-500">{t("matters.profile.missingBody")}</p>
            )}
          </section>
        </div>
      </main>

      {profileWritable && (
        <MatterProfileModal
          open={profileModalOpen}
          mode={profile ? "edit-profile" : "create-profile"}
          project={project}
          profile={profile}
          onClose={() => setProfileModalOpen(false)}
          onSaved={(saved) => {
            setMatter(saved);
            setProfileModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MatterDatum({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-gray-400">{label}</dt>
      <dd className="mt-1 break-words text-sm text-gray-800">{value}</dd>
    </div>
  );
}
