"use client";

import Link from "next/link";
import { useI18n } from "@/app/i18n";
import type { VeraMatterCapabilitiesWire } from "@/app/lib/veraMatterApi";

export function MatterNavigation({
  projectId,
  capabilities,
}: {
  projectId: string;
  capabilities: VeraMatterCapabilitiesWire;
}) {
  const { t } = useI18n();
  const unavailable = t("common.status.unavailable");
  const inferenceAvailable =
    capabilities.inference === "workspace_compatibility";
  const inferenceUnavailableReason =
    capabilities.inference === "unavailable"
      ? t("matters.capabilities.readOnly")
      : t("matters.capabilities.inferenceClosed");

  const linkClass =
    "shrink-0 text-xs text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400";
  const disabledClass =
    "inline-flex shrink-0 cursor-not-allowed items-center gap-1.5 text-xs text-gray-300";

  return (
    <nav
      aria-label={t("matters.navigation.label")}
      className="flex h-10 shrink-0 items-center gap-5 overflow-x-auto border-b border-gray-200 px-4 md:px-10"
    >
      <Link
        href={`/matters/${projectId}`}
        aria-current="page"
        className="shrink-0 text-xs font-medium text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        {t("matters.navigation.overview")}
      </Link>
      <Link href={`/projects/${projectId}`} className={linkClass}>
        {t("matters.navigation.documents")}
      </Link>
      {!inferenceAvailable ? (
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={inferenceUnavailableReason}
          className={disabledClass}
        >
          {t("matters.navigation.assistant")}
          <span className="text-[10px] font-normal">{unavailable}</span>
        </button>
      ) : (
        <Link href={`/projects/${projectId}/assistant`} className={linkClass}>
          {t("matters.navigation.assistant")}
        </Link>
      )}
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={t("matters.capabilities.reviewUnavailable")}
        className={disabledClass}
      >
        {t("matters.navigation.review")}
        <span className="text-[10px] font-normal">{unavailable}</span>
      </button>
      <Link href={`/projects/${projectId}/workflows`} className={linkClass}>
        {t("matters.navigation.workflows")}
      </Link>
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={t("matters.capabilities.draftsDocumentScoped")}
        className={disabledClass}
      >
        {t("matters.navigation.drafts")}
        <span className="text-[10px] font-normal">{unavailable}</span>
      </button>
    </nav>
  );
}
