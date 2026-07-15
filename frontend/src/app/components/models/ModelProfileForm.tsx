"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import type {
  VeraModelCapabilities,
  VeraModelProfile,
  VeraModelProfileMutation,
  VeraModelProvider,
} from "@/app/lib/veraModelSettingsApi";
import { Input } from "@/components/ui/input";
import { SettingsDropdown } from "./SettingsDropdown";
import {
  accountGlassButtonClassName,
  accountGlassInputClassName,
  accountGlassPrimaryButtonClassName,
} from "@/app/(pages)/settings/accountStyles";
import { AccountToggle } from "@/app/(pages)/settings/AccountToggle";

export const VERA_PINNED_OPENAI_MODELS = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
] as const;

const DEFAULT_MODEL_CAPABILITIES: VeraModelCapabilities = {
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  vision: false,
};

export function ModelProfileForm({
  profile,
  supportedProviders,
  loopbackHttpAllowed,
  saving,
  errorText,
  onSubmit,
  onCancel,
}: {
  profile?: VeraModelProfile | null;
  supportedProviders: readonly VeraModelProvider[];
  loopbackHttpAllowed: boolean;
  saving: boolean;
  errorText?: string | null;
  onSubmit: (input: VeraModelProfileMutation) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const firstProvider = supportedProviders[0] ?? null;
  const [provider, setProvider] = useState<VeraModelProvider | null>(
    profile?.provider ?? firstProvider,
  );
  const [name, setName] = useState(profile?.name ?? "");
  const [model, setModel] = useState(
    profile?.model ??
      (firstProvider === "openai" ? VERA_PINNED_OPENAI_MODELS[0].value : ""),
  );
  const [baseUrl, setBaseUrl] = useState(profile?.base_url ?? "");
  const [capabilities, setCapabilities] = useState<VeraModelCapabilities>(
    profile?.capabilities ?? DEFAULT_MODEL_CAPABILITIES,
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const providerOptions = useMemo(
    () =>
      supportedProviders.map((value) => ({
        value,
        label: providerLabel(value, t),
      })),
    [supportedProviders, t],
  );
  const openAiOptions = useMemo(
    () =>
      VERA_PINNED_OPENAI_MODELS.map((option) => ({
        ...option,
        group: "OpenAI",
        description: t("settings.models.pinnedRecommendation"),
      })),
    [t],
  );

  const handleProviderChange = (next: VeraModelProvider) => {
    setProvider(next);
    setValidationError(null);
    if (next === "openai" && model.trim().length === 0) {
      setModel(VERA_PINNED_OPENAI_MODELS[0].value);
    }
    if (next !== "openai_compatible") setBaseUrl("");
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    const normalizedName = name.trim();
    const normalizedModel = model.trim();
    const normalizedBaseUrl = baseUrl.trim();
    if (
      !provider ||
      !supportedProviders.includes(provider) ||
      normalizedName.length === 0 ||
      normalizedModel.length === 0 ||
      (provider === "openai_compatible" &&
        !validModelBaseUrl(normalizedBaseUrl, loopbackHttpAllowed))
    ) {
      setValidationError(t("settings.models.errors.form"));
      return;
    }
    await onSubmit({
      name: normalizedName,
      provider,
      model: normalizedModel,
      base_url: provider === "openai_compatible" ? normalizedBaseUrl : null,
      ...(provider === "openai_compatible" ? { capabilities } : {}),
    });
  }

  const selectedOpenAiModel = VERA_PINNED_OPENAI_MODELS.some(
    (option) => option.value === model,
  )
    ? (model as (typeof VERA_PINNED_OPENAI_MODELS)[number]["value"])
    : null;

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div>
        <label
          htmlFor="vera-model-profile-name"
          className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200"
        >
          {t("settings.models.name")}
        </label>
        <Input
          id="vera-model-profile-name"
          value={name}
          maxLength={120}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
          className={accountGlassInputClassName}
          placeholder={t("settings.models.namePlaceholder")}
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
          {t("settings.models.provider")}
        </label>
        <SettingsDropdown
          value={
            provider && supportedProviders.includes(provider) ? provider : null
          }
          options={providerOptions}
          onChange={handleProviderChange}
          isSaving={false}
          disabled={saving || supportedProviders.length === 0}
          placeholder={t("settings.models.selectProvider")}
          ariaLabel={t("settings.models.provider")}
        />
        {profile && !supportedProviders.includes(profile.provider) && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            {t("settings.models.unsupportedProvider")}
          </p>
        )}
      </div>

      {provider === "openai" && (
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
            {t("settings.models.recommendedModel")}
          </label>
          <SettingsDropdown
            value={selectedOpenAiModel}
            options={openAiOptions}
            onChange={setModel}
            disabled={saving}
            placeholder={t("settings.models.selectModel")}
            ariaLabel={t("settings.models.recommendedModel")}
          />
        </div>
      )}

      <div>
        <label
          htmlFor="vera-model-profile-model"
          className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200"
        >
          {t("settings.models.modelId")}
        </label>
        <Input
          id="vera-model-profile-model"
          value={model}
          maxLength={200}
          disabled={saving}
          onChange={(event) => setModel(event.target.value)}
          className={accountGlassInputClassName}
          placeholder={t("settings.models.modelPlaceholder")}
        />
        <p className="mt-2 text-xs text-gray-400">
          {t("settings.models.modelHint")}
        </p>
      </div>

      {provider === "openai_compatible" && (
        <>
          <div>
            <label
              htmlFor="vera-model-profile-base-url"
              className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              {t("settings.models.baseUrl")}
            </label>
            <Input
              id="vera-model-profile-base-url"
              type="url"
              value={baseUrl}
              maxLength={500}
              disabled={saving}
              onChange={(event) => setBaseUrl(event.target.value)}
              className={accountGlassInputClassName}
              placeholder="https://example.com/v1"
            />
            <p className="mt-2 text-xs text-gray-400">
              {t("settings.models.baseUrlHint")}
            </p>
          </div>

          <fieldset className="rounded-xl border border-gray-200/80 p-4 dark:border-gray-700/80">
            <legend className="px-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              {t("settings.models.capabilities.title")}
            </legend>
            <p className="mb-3 text-xs text-gray-400">
              {t("settings.models.capabilities.description")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["streaming", "settings.models.capabilities.streaming"],
                  ["toolCalling", "settings.models.capabilities.toolCalling"],
                  [
                    "structuredOutput",
                    "settings.models.capabilities.structuredOutput",
                  ],
                  ["vision", "settings.models.capabilities.vision"],
                ] as const
              ).map(([key, label]) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-lg bg-white/60 px-3 py-2 dark:bg-gray-900/30"
                >
                  <span className="text-sm text-gray-600 dark:text-gray-300">
                    {t(label)}
                  </span>
                  <AccountToggle
                    checked={capabilities[key]}
                    disabled={saving || key === "vision"}
                    onChange={(checked) =>
                      setCapabilities((current) => ({
                        ...current,
                        [key]: checked,
                      }))
                    }
                    ariaLabel={t(label)}
                  />
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-gray-400">
              {t("settings.models.capabilities.retest")}
            </p>
          </fieldset>
        </>
      )}

      {(validationError || errorText) && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {validationError ?? errorText}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className={accountGlassButtonClassName}
        >
          {t("common.actions.cancel")}
        </button>
        <button
          type="submit"
          disabled={saving || supportedProviders.length === 0}
          className={`${accountGlassPrimaryButtonClassName} inline-flex items-center gap-1.5`}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {profile ? t("common.actions.save") : t("settings.models.create")}
        </button>
      </div>
    </form>
  );
}

function validModelBaseUrl(
  value: string,
  loopbackHttpAllowed: boolean,
): boolean {
  if (value.length === 0 || value.length > 500) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:" || !loopbackHttpAllowed) return false;
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

function providerLabel(
  provider: VeraModelProvider,
  translate: ReturnType<typeof useI18n>["t"],
): string {
  const keys = {
    openai: "settings.models.providers.openai",
    deepseek: "settings.models.providers.deepseek",
    anthropic: "settings.models.providers.anthropic",
    gemini: "settings.models.providers.gemini",
    openai_compatible: "settings.models.providers.openaiCompatible",
  } as const;
  return translate(keys[provider]);
}

export { providerLabel as veraModelProviderLabel };
