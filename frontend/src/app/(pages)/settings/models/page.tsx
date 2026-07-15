"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import { useI18n, type BackendErrorDescriptor } from "@/app/i18n";
import {
  toVeraSettingsFailure,
  useVeraSettings,
} from "@/app/contexts/VeraSettingsContext";
import {
  createVeraModelProfile,
  updateVeraModelProfile,
  type VeraModelProfile,
  type VeraModelProfileMutation,
} from "@/app/lib/veraModelSettingsApi";
import { ModelProfileCard } from "@/app/components/models/ModelProfileCard";
import { ModelProfileForm } from "@/app/components/models/ModelProfileForm";
import { AccountSection } from "../AccountSection";
import {
  accountGlassButtonClassName,
  accountGlassPrimaryButtonClassName,
} from "../accountStyles";

export default function ModelProfilesSettingsPage() {
  const { t, errorMessage } = useI18n();
  const {
    loadState,
    loadError,
    settingsRuntimeAvailable,
    capabilities,
    models,
    modelsLoading,
    modelsError,
    refresh,
    reloadModels,
    upsertModel,
    removeModel,
  } = useVeraSettings();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<VeraModelProfile | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<BackendErrorDescriptor | null>(
    null,
  );

  useEffect(() => {
    if (!settingsRuntimeAvailable) return;
    void reloadModels().catch(() => undefined);
  }, [reloadModels, settingsRuntimeAvailable]);

  async function submitProfile(input: VeraModelProfileMutation) {
    if (formSaving) return;
    setFormSaving(true);
    setFormError(null);
    try {
      const profile = editing
        ? await updateVeraModelProfile(editing.id, input)
        : await createVeraModelProfile(input);
      upsertModel(profile);
      setEditing(null);
      setFormOpen(false);
    } catch (error) {
      setFormError(toVeraSettingsFailure(error));
    } finally {
      setFormSaving(false);
    }
  }

  function closeForm() {
    if (formSaving) return;
    setEditing(null);
    setFormOpen(false);
    setFormError(null);
  }

  if (loadState === "loading") {
    return (
      <PageState
        icon={<Loader2 className="h-5 w-5 animate-spin" />}
        title={t("common.status.loading")}
        body={t("settings.models.loading")}
      />
    );
  }

  if (loadState === "error" || !settingsRuntimeAvailable || !capabilities) {
    return (
      <PageState
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

  const noSupportedProviders = capabilities.supported_providers.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-serif text-2xl font-medium text-gray-900 dark:text-gray-100">
            {t("settings.models.title")}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t("settings.models.description")}
          </p>
        </div>
        <button
          type="button"
          disabled={noSupportedProviders || formSaving}
          onClick={() => {
            setEditing(null);
            setFormError(null);
            setFormOpen(true);
          }}
          className={`${accountGlassPrimaryButtonClassName} inline-flex h-9 shrink-0 items-center gap-1.5`}
        >
          <Plus className="h-4 w-4" />
          {t("settings.models.add")}
        </button>
      </div>

      {noSupportedProviders && (
        <AccountSection className="p-4">
          <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("settings.models.noSupportedProviders")}</span>
          </div>
        </AccountSection>
      )}

      {formOpen && (
        <AccountSection className="p-4">
          <div className="mb-4">
            <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
              {editing
                ? t("settings.models.editTitle")
                : t("settings.models.addTitle")}
            </h3>
            <p className="mt-1 text-xs text-gray-400">
              {t("settings.models.formDescription")}
            </p>
          </div>
          <ModelProfileForm
            key={editing?.id ?? "new"}
            profile={editing}
            supportedProviders={capabilities.supported_providers}
            loopbackHttpAllowed={capabilities.loopback_http_allowed}
            saving={formSaving}
            errorText={formError ? errorMessage(formError) : undefined}
            onSubmit={submitProfile}
            onCancel={closeForm}
          />
        </AccountSection>
      )}

      {modelsError && (
        <AccountSection className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {errorMessage(modelsError)}
            </p>
            <button
              type="button"
              disabled={modelsLoading}
              onClick={() => void reloadModels().catch(() => undefined)}
              className={accountGlassButtonClassName}
            >
              {t("common.actions.retry")}
            </button>
          </div>
        </AccountSection>
      )}

      {modelsLoading && models.length === 0 ? (
        <PageState
          icon={<Loader2 className="h-5 w-5 animate-spin" />}
          title={t("common.status.loading")}
          body={t("settings.models.loading")}
        />
      ) : models.length === 0 ? (
        <AccountSection className="p-6 text-center">
          <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
            {t("settings.models.empty.title")}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
            {t("settings.models.empty.body")}
          </p>
          {!noSupportedProviders && (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className={`${accountGlassPrimaryButtonClassName} mt-4 inline-flex items-center gap-1.5`}
            >
              <Plus className="h-4 w-4" />
              {t("settings.models.empty.action")}
            </button>
          )}
        </AccountSection>
      ) : (
        <div className="space-y-4" aria-busy={modelsLoading}>
          {modelsLoading && (
            <p className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("common.status.loading")}
            </p>
          )}
          {models.map((profile) => (
            <ModelProfileCard
              key={profile.id}
              profile={profile}
              capabilities={capabilities}
              onEdit={() => {
                setEditing(profile);
                setFormError(null);
                setFormOpen(true);
              }}
              onUpdated={upsertModel}
              onRemoved={removeModel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PageState({
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
