import {
  DEFAULT_ALETHEIA_SETTINGS,
  normalizeAletheiaSettings,
  type AletheiaClientSettings,
} from "./settingsModel";
import { getAletheiaApiBase } from "@/app/lib/aletheiaRuntime";

const PRIVATE_AUTH_TOKEN =
  process.env.NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN?.trim() ?? "";

export type RuntimeCapability = {
  status?: "available" | "unavailable" | "unsupported" | string;
  consumer?: string | null;
  note?: string;
  mode?: "Off" | "Manual" | "Auto";
  availableModes?: Array<"Off" | "Manual" | "Auto">;
  model?: string | null;
  thresholdTokens?: number | null;
};

export type ClientSettingsDocument = {
  schemaVersion: string;
  version: number;
  etag: string | null;
  settings: AletheiaClientSettings;
  runtimeConfig?: {
    runtime?: {
      contextBudgetTokens?: number | null;
      maxOutputTokens?: number | null;
    };
    fields?: Record<string, RuntimeCapability>;
  };
};

export type ClientSettingsPatch = Omit<
  Partial<AletheiaClientSettings>,
  "defaultModel" | "litigationModelId" | "routineModelId"
> & {
  defaultModel?: string | null;
  litigationModelId?: string | null;
  routineModelId?: string | null;
};

export interface SettingsTransport {
  load(): Promise<ClientSettingsDocument>;
  patch(
    changes: ClientSettingsPatch,
    options?: { etag?: string | null },
  ): Promise<ClientSettingsDocument>;
  reset(options?: { etag?: string | null }): Promise<ClientSettingsDocument>;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (typeof window !== "undefined" && window.aletheiaDesktop?.getAuthToken) {
    const token = await window.aletheiaDesktop.getAuthToken();
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return PRIVATE_AUTH_TOKEN
    ? { Authorization: `Bearer ${PRIVATE_AUTH_TOKEN}` }
    : {};
}

async function responseError(response: Response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail) {
      return parsed.detail;
    }
  } catch {
    // Use the bounded text response below.
  }
  return body.slice(0, 300) || `HTTP ${response.status}`;
}

function settingsDocument(value: unknown, responseEtag: string | null) {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const nested =
    raw.settings && typeof raw.settings === "object" ? raw.settings : raw;
  return {
    schemaVersion:
      typeof raw.schemaVersion === "string"
        ? raw.schemaVersion
        : "aletheia-client-settings-v1",
    version:
      typeof raw.version === "number" && Number.isFinite(raw.version)
        ? raw.version
        : 1,
    etag: typeof raw.etag === "string" ? raw.etag : responseEtag,
    settings: normalizeAletheiaSettings(nested),
    runtimeConfig:
      raw.runtimeConfig && typeof raw.runtimeConfig === "object"
        ? (raw.runtimeConfig as ClientSettingsDocument["runtimeConfig"])
        : undefined,
  } satisfies ClientSettingsDocument;
}

async function request(
  method: "GET" | "PATCH" | "DELETE",
  options?: { changes?: ClientSettingsPatch; etag?: string | null },
) {
  const auth = await authHeaders();
  const apiBase = await getAletheiaApiBase();
  const response = await fetch(`${apiBase}/aletheia/client-settings`, {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...auth,
      ...(options?.changes ? { "Content-Type": "application/json" } : {}),
      ...(options?.etag ? { "If-Match": options.etag } : {}),
    },
    body: options?.changes
      ? JSON.stringify({
          ...options.changes,
          ...(options.changes.defaultModel === ""
            ? { defaultModel: null }
            : {}),
        })
      : undefined,
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  if (response.status === 204) {
    return {
      schemaVersion: "aletheia-client-settings-v1",
      version: 1,
      etag: response.headers.get("etag"),
      settings: DEFAULT_ALETHEIA_SETTINGS,
    } satisfies ClientSettingsDocument;
  }
  return settingsDocument(await response.json(), response.headers.get("etag"));
}

export const apiSettingsTransport: SettingsTransport = {
  load: () => request("GET"),
  patch: (changes, options) =>
    request("PATCH", { changes, etag: options?.etag }),
  reset: (options) => request("DELETE", { etag: options?.etag }),
};

export type LocalModelSnapshot = {
  id: string;
  adapter: "ollama" | "openai-compatible";
  model: string;
  modelRevision?: string;
  state:
    "stopped" | "starting" | "ready" | "unhealthy" | "stopping" | "crashed";
  managed: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  lastError?: string;
  calibration?: {
    id: string;
    status: "passed" | "failed";
    testedAt: string;
    expiresAt: string;
    failureCode: string | null;
    failureDetail: string | null;
  } | null;
  calibrationAcceptance?: {
    accepted: boolean;
    code:
      | "calibrated"
      | "calibration_required"
      | "calibration_failed"
      | "calibration_stale"
      | "calibration_expired"
      | "model_revision_unavailable";
  };
};

export async function listLocalModels(): Promise<LocalModelSnapshot[]> {
  const apiBase = await getAletheiaApiBase();
  const response = await fetch(`${apiBase}/aletheia/local-models`, {
    cache: "no-store",
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!response.ok) throw new Error(await responseError(response));
  const value = (await response.json()) as { models?: unknown };
  if (!Array.isArray(value.models)) return [];
  return value.models.filter((model): model is LocalModelSnapshot => {
    if (!model || typeof model !== "object") return false;
    const row = model as Partial<LocalModelSnapshot>;
    return (
      typeof row.id === "string" &&
      (row.adapter === "ollama" || row.adapter === "openai-compatible") &&
      typeof row.model === "string" &&
      typeof row.state === "string"
    );
  });
}

export async function calibrateLocalModel(modelId: string): Promise<void> {
  const apiBase = await getAletheiaApiBase();
  const response = await fetch(
    `${apiBase}/aletheia/local-models/${encodeURIComponent(modelId)}/calibrate`,
    {
      method: "POST",
      headers: { Accept: "application/json", ...(await authHeaders()) },
    },
  );
  if (!response.ok && response.status !== 422) {
    throw new Error(await responseError(response));
  }
}
