"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n, type BackendErrorDescriptor } from "@/app/i18n";
import { VeraApiError } from "@/app/lib/veraApi";
import {
  getVeraModelSettingsStatus,
  listVeraModelProfiles,
  patchVeraWorkspaceSettings,
  type VeraModelProfile,
  type VeraModelSettingsCapabilities,
  type VeraModelSettingsStatus,
  type VeraWorkspaceSettings,
  type VeraWorkspaceSettingsPatch,
} from "@/app/lib/veraModelSettingsApi";
import { installVeraTheme } from "@/app/lib/veraTheme";
import { VeraRuntimeConfigurationError } from "@/app/lib/veraRuntime";

export type VeraSettingsLoadState = "loading" | "ready" | "error";

export interface VeraSettingsContextValue {
  loadState: VeraSettingsLoadState;
  loadError: BackendErrorDescriptor | null;
  settingsRuntimeAvailable: boolean;
  capabilities: VeraModelSettingsCapabilities | null;
  settings: VeraWorkspaceSettings | null;
  models: readonly VeraModelProfile[];
  modelsLoading: boolean;
  modelsError: BackendErrorDescriptor | null;
  refresh: () => Promise<void>;
  reloadModels: () => Promise<void>;
  updatePreferences: (
    patch: VeraWorkspaceSettingsPatch,
  ) => Promise<VeraWorkspaceSettings>;
  upsertModel: (model: VeraModelProfile) => void;
  removeModel: (id: string) => void;
}

const VeraSettingsContext = createContext<VeraSettingsContextValue | null>(
  null,
);

function safeFailure(error: unknown): BackendErrorDescriptor {
  if (error instanceof VeraApiError) {
    return { code: error.code, status: error.status };
  }
  if (error instanceof VeraRuntimeConfigurationError) {
    return { code: "VALIDATION_ERROR" };
  }
  return { code: "NETWORK_ERROR" };
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function VeraSettingsProvider({ children }: { children: ReactNode }) {
  const { setLocale } = useI18n();
  const [status, setStatus] = useState<VeraModelSettingsStatus | null>(null);
  const [loadState, setLoadState] = useState<VeraSettingsLoadState>("loading");
  const [loadError, setLoadError] = useState<BackendErrorDescriptor | null>(
    null,
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<BackendErrorDescriptor | null>(
    null,
  );
  const requestSequence = useRef(0);
  const modelsRequestSequence = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++requestSequence.current;
      modelsRequestSequence.current += 1;
      setModelsLoading(false);
      setLoadState("loading");
      setLoadError(null);
      try {
        const next = await getVeraModelSettingsStatus({ signal });
        if (signal?.aborted || sequence !== requestSequence.current) return;
        setStatus(next);
        setLocale(next.settings.locale);
        setModelsError(null);
        setLoadState("ready");
      } catch (error) {
        if (signal?.aborted || aborted(error)) return;
        if (sequence !== requestSequence.current) return;
        setStatus(null);
        setLoadError(safeFailure(error));
        setLoadState("error");
      }
    },
    [setLocale],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const theme = status?.settings.theme;
  useEffect(() => {
    if (!theme) return;
    return installVeraTheme(theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const reloadModels = useCallback(async () => {
    const sequence = ++modelsRequestSequence.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const models = await listVeraModelProfiles();
      if (sequence !== modelsRequestSequence.current) return;
      setStatus((current) => (current ? { ...current, models } : current));
    } catch (error) {
      if (sequence !== modelsRequestSequence.current) return;
      setModelsError(safeFailure(error));
      throw error;
    } finally {
      if (sequence === modelsRequestSequence.current) {
        setModelsLoading(false);
      }
    }
  }, []);

  const updatePreferences = useCallback(
    async (patch: VeraWorkspaceSettingsPatch) => {
      const settings = await patchVeraWorkspaceSettings(patch);
      setStatus((current) => (current ? { ...current, settings } : current));
      setLocale(settings.locale);
      return settings;
    },
    [setLocale],
  );

  const upsertModel = useCallback((model: VeraModelProfile) => {
    modelsRequestSequence.current += 1;
    setModelsLoading(false);
    setModelsError(null);
    setStatus((current) => {
      if (!current) return current;
      const found = current.models.some((item) => item.id === model.id);
      const models = found
        ? current.models.map((item) => {
            if (item.id === model.id) return model;
            return model.is_default ? { ...item, is_default: false } : item;
          })
        : [model, ...current.models].map((item) =>
            model.is_default && item.id !== model.id
              ? { ...item, is_default: false }
              : item,
          );
      const priorDefault = current.settings.default_model_profile_id;
      const default_model_profile_id = model.is_default
        ? model.id
        : priorDefault === model.id
          ? null
          : priorDefault;
      return {
        ...current,
        settings: {
          ...current.settings,
          default_model_profile_id,
        },
        models,
      };
    });
  }, []);

  const removeModel = useCallback((id: string) => {
    modelsRequestSequence.current += 1;
    setModelsLoading(false);
    setModelsError(null);
    setStatus((current) =>
      current
        ? {
            ...current,
            settings: {
              ...current.settings,
              default_model_profile_id:
                current.settings.default_model_profile_id === id
                  ? null
                  : current.settings.default_model_profile_id,
            },
            models: current.models.filter((model) => model.id !== id),
          }
        : current,
    );
  }, []);

  const settingsRuntimeAvailable =
    loadState === "ready" && status?.capabilities.settings_available === true;

  const value = useMemo<VeraSettingsContextValue>(
    () => ({
      loadState,
      loadError,
      settingsRuntimeAvailable,
      capabilities: status?.capabilities ?? null,
      settings: status?.settings ?? null,
      models: status?.models ?? [],
      modelsLoading,
      modelsError,
      refresh,
      reloadModels,
      updatePreferences,
      upsertModel,
      removeModel,
    }),
    [
      loadError,
      loadState,
      modelsError,
      modelsLoading,
      refresh,
      reloadModels,
      removeModel,
      settingsRuntimeAvailable,
      status,
      updatePreferences,
      upsertModel,
    ],
  );

  return (
    <VeraSettingsContext.Provider value={value}>
      {children}
    </VeraSettingsContext.Provider>
  );
}

export function useVeraSettings(): VeraSettingsContextValue {
  const context = useContext(VeraSettingsContext);
  if (!context) {
    throw new Error("useVeraSettings must be used within VeraSettingsProvider");
  }
  return context;
}

export { safeFailure as toVeraSettingsFailure };
