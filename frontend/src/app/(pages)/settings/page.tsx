"use client";

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useI18n, type BackendErrorDescriptor } from "@/app/i18n";
import {
  toVeraSettingsFailure,
  useVeraSettings,
} from "@/app/contexts/VeraSettingsContext";
import type {
  VeraSettingsLocale,
  VeraTheme,
} from "@/app/lib/veraModelSettingsApi";
import { SettingsDropdown } from "@/app/components/models/SettingsDropdown";
import { AccountSection } from "./AccountSection";
import { accountGlassButtonClassName } from "./accountStyles";

type PreferenceField = "locale" | "theme";

export default function SettingsPage() {
  const { t, errorMessage } = useI18n();
  const {
    loadState,
    loadError,
    settingsRuntimeAvailable,
    settings,
    capabilities,
    refresh,
    updatePreferences,
  } = useVeraSettings();
  const [savingField, setSavingField] = useState<PreferenceField | null>(null);
  const [savedField, setSavedField] = useState<PreferenceField | null>(null);
  const [saveError, setSaveError] = useState<BackendErrorDescriptor | null>(
    null,
  );

  const localeOptions = useMemo(
    () => [
      {
        value: "zh-CN" as const,
        label: t("settings.language.zhCN"),
      },
      {
        value: "en-US" as const,
        label: t("settings.language.enUS"),
      },
    ],
    [t],
  );
  const themeOptions = useMemo(
    () => [
      {
        value: "system" as const,
        label: t("settings.appearance.system"),
      },
      {
        value: "light" as const,
        label: t("settings.appearance.light"),
      },
      {
        value: "dark" as const,
        label: t("settings.appearance.dark"),
      },
    ],
    [t],
  );

  async function savePreference(
    field: PreferenceField,
    value: VeraSettingsLocale | VeraTheme,
  ) {
    if (savingField) return;
    setSavingField(field);
    setSavedField(null);
    setSaveError(null);
    try {
      await updatePreferences({ [field]: value });
      setSavedField(field);
    } catch (error) {
      setSaveError(toVeraSettingsFailure(error));
    } finally {
      setSavingField(null);
    }
  }

  if (loadState === "loading") {
    return (
      <SettingsState
        icon={<Loader2 className="h-5 w-5 animate-spin" />}
        title={t("common.status.loading")}
        body={t("settings.loading")}
      />
    );
  }

  if (
    loadState === "error" ||
    !settingsRuntimeAvailable ||
    !settings ||
    !capabilities
  ) {
    return (
      <SettingsState
        icon={<AlertCircle className="h-5 w-5 text-red-500" />}
        title={t("settings.errors.loadTitle")}
        body={
          loadState === "ready" && !settingsRuntimeAvailable
            ? t("settings.errors.unavailable")
            : errorMessage(loadError ?? { code: "INVALID_RESPONSE" })
        }
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            className={accountGlassButtonClassName}
          >
            {t("common.actions.retry")}
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="font-serif text-2xl font-medium text-gray-900 dark:text-gray-100">
            {t("settings.general.title")}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t("settings.subtitle")}
          </p>
        </div>
        <AccountSection>
          <div className="px-4 py-5">
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
              {t("settings.language.title")}
            </label>
            <p className="mb-3 text-xs text-gray-400">
              {t("settings.language.description")}
            </p>
            <SettingsDropdown
              value={settings.locale}
              options={localeOptions}
              placeholder={t("settings.language.title")}
              ariaLabel={t("settings.language.title")}
              disabled={savingField !== null}
              isSaving={savingField === "locale"}
              onChange={(locale) => void savePreference("locale", locale)}
            />
            {savedField === "locale" && (
              <SavedNotice label={t("common.status.saved")} />
            )}
          </div>
          <div className="mx-4 h-px bg-gray-200 dark:bg-white/10" />
          <div className="px-4 py-5">
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
              {t("settings.appearance.theme")}
            </label>
            <p className="mb-3 text-xs text-gray-400">
              {t("settings.appearance.description")}
            </p>
            <SettingsDropdown
              value={settings.theme}
              options={themeOptions}
              placeholder={t("settings.appearance.theme")}
              ariaLabel={t("settings.appearance.theme")}
              disabled={savingField !== null}
              isSaving={savingField === "theme"}
              onChange={(theme) => void savePreference("theme", theme)}
            />
            {savedField === "theme" && (
              <SavedNotice label={t("common.status.saved")} />
            )}
          </div>
        </AccountSection>
        {saveError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorMessage(saveError)}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl font-medium text-gray-900 dark:text-gray-100">
          {t("settings.runtime.title")}
        </h2>
        <AccountSection className="p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {t("settings.runtime.local")}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {capabilities.runtime_wired
                  ? t("settings.runtime.modelReady")
                  : t("settings.runtime.modelUnavailable")}
              </p>
            </div>
          </div>
        </AccountSection>
      </section>
    </div>
  );
}

function SettingsState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <AccountSection className="p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-gray-500">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {title}
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {body}
          </p>
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </AccountSection>
  );
}

function SavedNotice({ label }: { label: string }) {
  return (
    <p className="mt-2 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {label}
    </p>
  );
}
