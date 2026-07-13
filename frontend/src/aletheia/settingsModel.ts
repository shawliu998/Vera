"use client";

export const ALETHEIA_SETTINGS_KEY = "aletheia.clientSettings.v1";
export const SELECTED_MODEL_KEY = "aletheia.selectedModel";
export const LAST_MATTER_KEY = "aletheia.lastMatterPath";
export const ALETHEIA_SETTINGS_EVENT = "aletheia-settings-change";

export type AletheiaTheme = "System" | "Light" | "Dark";
export type AletheiaDensity = "Comfortable" | "Compact";
export type AletheiaSidebarMode = "Standard" | "Narrow";
export type AletheiaLanding =
  "Matters" | "Agent Console" | "Last opened matter";
export type AletheiaReasoning = "Off" | "Low" | "Medium" | "High";
export type AletheiaEvidenceIndex = "Keyword" | "Hybrid" | "Semantic";
export type AletheiaContextCompression = "Off" | "Manual" | "Auto";
export type AletheiaMatterTemplate =
  | "Civil Litigation"
  | "Legal Matter Review"
  | "Compliance Impact Review"
  | "Deal Due Diligence";

/**
 * Client settings with a concrete frontend consumer. Backend-owned safety,
 * credential, MCP and runtime policy are deliberately excluded.
 */
export interface AletheiaClientSettings {
  defaultModel: string;
  litigationModelId: string;
  routineModelId: string;
  contextBudgetTokens: number | null;
  reasoning: AletheiaReasoning;
  fastMode: boolean;
  notifications: boolean;
  evidenceIndex: AletheiaEvidenceIndex;
  contextCompression: AletheiaContextCompression;
  compressionModelId: string;
  theme: AletheiaTheme;
  density: AletheiaDensity;
  sidebar: AletheiaSidebarMode;
  documentFontSize: "Small" | "Medium" | "Large";
  defaultTemplate: AletheiaMatterTemplate;
  demoDataEnabled: boolean;
  defaultLanding: AletheiaLanding;
  showCitationsInline: boolean;
}

export const DEFAULT_ALETHEIA_SETTINGS: AletheiaClientSettings = {
  defaultModel: "",
  litigationModelId: "",
  routineModelId: "",
  contextBudgetTokens: null,
  reasoning: "Off",
  fastMode: false,
  notifications: true,
  evidenceIndex: "Keyword",
  contextCompression: "Off",
  compressionModelId: "",
  theme: "System",
  density: "Comfortable",
  sidebar: "Standard",
  documentFontSize: "Medium",
  defaultTemplate: "Civil Litigation",
  demoDataEnabled: false,
  defaultLanding: "Matters",
  showCitationsInline: true,
};

function asString(value: unknown, fallback: string) {
  return typeof value === "string" ? value.trim() : fallback;
}

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
) {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeAletheiaSettings(
  value: unknown,
): AletheiaClientSettings {
  const raw =
    value && typeof value === "object"
      ? (value as Partial<AletheiaClientSettings>)
      : {};

  return {
    defaultModel: asString(
      raw.defaultModel,
      DEFAULT_ALETHEIA_SETTINGS.defaultModel,
    ),
    litigationModelId: asString(
      raw.litigationModelId,
      DEFAULT_ALETHEIA_SETTINGS.litigationModelId,
    ),
    routineModelId: asString(
      raw.routineModelId,
      DEFAULT_ALETHEIA_SETTINGS.routineModelId,
    ),
    contextBudgetTokens:
      typeof raw.contextBudgetTokens === "number" &&
      Number.isSafeInteger(raw.contextBudgetTokens) &&
      raw.contextBudgetTokens >= 512
        ? raw.contextBudgetTokens
        : null,
    reasoning: member(
      raw.reasoning,
      ["Off", "Low", "Medium", "High"],
      DEFAULT_ALETHEIA_SETTINGS.reasoning,
    ),
    fastMode: asBoolean(raw.fastMode, DEFAULT_ALETHEIA_SETTINGS.fastMode),
    notifications: asBoolean(
      raw.notifications,
      DEFAULT_ALETHEIA_SETTINGS.notifications,
    ),
    evidenceIndex: member(
      raw.evidenceIndex,
      ["Keyword", "Hybrid", "Semantic"],
      DEFAULT_ALETHEIA_SETTINGS.evidenceIndex,
    ),
    contextCompression: member(
      raw.contextCompression,
      ["Off", "Manual", "Auto"],
      DEFAULT_ALETHEIA_SETTINGS.contextCompression,
    ),
    compressionModelId: asString(
      raw.compressionModelId,
      DEFAULT_ALETHEIA_SETTINGS.compressionModelId,
    ),
    theme: member(
      raw.theme,
      ["System", "Light", "Dark"],
      DEFAULT_ALETHEIA_SETTINGS.theme,
    ),
    density: member(
      raw.density,
      ["Comfortable", "Compact"],
      DEFAULT_ALETHEIA_SETTINGS.density,
    ),
    sidebar: member(
      raw.sidebar,
      ["Standard", "Narrow"],
      DEFAULT_ALETHEIA_SETTINGS.sidebar,
    ),
    documentFontSize: member(
      raw.documentFontSize,
      ["Small", "Medium", "Large"],
      DEFAULT_ALETHEIA_SETTINGS.documentFontSize,
    ),
    defaultTemplate: member(
      raw.defaultTemplate,
      [
        "Civil Litigation",
        "Legal Matter Review",
        "Compliance Impact Review",
        "Deal Due Diligence",
      ],
      DEFAULT_ALETHEIA_SETTINGS.defaultTemplate,
    ),
    demoDataEnabled: asBoolean(
      raw.demoDataEnabled,
      DEFAULT_ALETHEIA_SETTINGS.demoDataEnabled,
    ),
    defaultLanding: member(
      raw.defaultLanding,
      ["Matters", "Agent Console", "Last opened matter"],
      DEFAULT_ALETHEIA_SETTINGS.defaultLanding,
    ),
    showCitationsInline: asBoolean(
      raw.showCitationsInline,
      DEFAULT_ALETHEIA_SETTINGS.showCitationsInline,
    ),
  };
}

/** Reads the last known local cache. The API transport remains authoritative. */
export function readAletheiaSettings(): AletheiaClientSettings {
  if (typeof window === "undefined") return DEFAULT_ALETHEIA_SETTINGS;
  try {
    const raw = window.localStorage.getItem(ALETHEIA_SETTINGS_KEY);
    return normalizeAletheiaSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_ALETHEIA_SETTINGS;
  }
}

function resolvedDarkTheme(settings: AletheiaClientSettings) {
  if (settings.theme === "Dark") return true;
  if (settings.theme === "Light") return false;
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function applyAletheiaSettings(settings: AletheiaClientSettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.aletheiaTheme = settings.theme.toLowerCase();
  root.dataset.aletheiaDensity = settings.density.toLowerCase();
  root.dataset.aletheiaSidebar = settings.sidebar.toLowerCase();
  root.dataset.aletheiaDocumentFontSize =
    settings.documentFontSize.toLowerCase();
  root.classList.toggle("dark", resolvedDarkTheme(settings));
  root.style.colorScheme = resolvedDarkTheme(settings) ? "dark" : "light";
}

/** Updates the offline cache and notifies consumers; it does not imply API save success. */
export function writeAletheiaSettingsCache(settings: AletheiaClientSettings) {
  if (typeof window === "undefined") return;
  const next = normalizeAletheiaSettings(settings);
  window.localStorage.setItem(ALETHEIA_SETTINGS_KEY, JSON.stringify(next));
  if (next.defaultModel && !window.localStorage.getItem(SELECTED_MODEL_KEY)) {
    window.localStorage.setItem(SELECTED_MODEL_KEY, next.defaultModel);
  }
  applyAletheiaSettings(next);
  window.dispatchEvent(
    new CustomEvent(ALETHEIA_SETTINGS_EVENT, { detail: next }),
  );
}

export function selectDefaultModel(modelId: string) {
  if (typeof window === "undefined") return;
  if (modelId) window.localStorage.setItem(SELECTED_MODEL_KEY, modelId);
  else window.localStorage.removeItem(SELECTED_MODEL_KEY);
}

export function exportAletheiaSettings(settings: AletheiaClientSettings) {
  const blob = new Blob(
    [JSON.stringify(normalizeAletheiaSettings(settings), null, 2)],
    {
      type: "application/json",
    },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "aletheia-settings.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function matterTemplateId(template: AletheiaMatterTemplate) {
  if (template === "Civil Litigation") return "civil_litigation" as const;
  if (template === "Compliance Impact Review")
    return "compliance_impact_review" as const;
  if (template === "Deal Due Diligence") return "deal_due_diligence" as const;
  return "legal_matter_review" as const;
}

export function landingPath(settings: AletheiaClientSettings) {
  if (settings.defaultLanding === "Agent Console") return "/aletheia/agentops";
  if (
    settings.defaultLanding === "Last opened matter" &&
    typeof window !== "undefined"
  ) {
    const path = window.localStorage.getItem(LAST_MATTER_KEY);
    if (path?.startsWith("/aletheia/matters/")) return path;
  }
  return "/aletheia/matters";
}
