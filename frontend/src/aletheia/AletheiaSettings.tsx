"use client";

import { useEffect, useRef, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Cpu,
  Database,
  FolderOpen,
  Info,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Palette,
  PlugZap,
  Power,
  RotateCw,
  Settings,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import {
  getAletheiaSecurityPolicy,
  getAletheiaAuthHeaders,
  listAletheiaLegalSourceProviders,
  removeAletheiaLegalSourceSecret,
  saveAletheiaLegalSourceSecret,
  listMcpConnectors,
  refreshMcpConnectorTools,
  updateMcpConnector,
  createMcpConnector,
  type AletheiaSecurityPolicy,
  type AletheiaLegalSourceProvider,
  type AletheiaLegalSourceProviderId,
  type LocalModelSnapshot,
  type McpConnectorSummary,
} from "@/app/lib/aletheiaApi";
import {
  getAletheiaApiBase,
  getConfiguredAletheiaApiBase,
} from "@/app/lib/aletheiaRuntime";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ALETHEIA_SETTINGS,
  applyAletheiaSettings,
  exportAletheiaSettings,
  normalizeAletheiaSettings,
  readAletheiaSettings,
  selectDefaultModel,
  writeAletheiaSettingsCache,
  type AletheiaClientSettings,
} from "./settingsModel";
import {
  apiSettingsTransport,
  type ClientSettingsDocument,
} from "./settingsTransport";
import { useLocalModels } from "./useLocalModels";
import { requestAletheiaNotificationPermission } from "./AletheiaNotificationCenter";

type SettingsSectionId =
  | "model"
  | "chat"
  | "appearance"
  | "workspace"
  | "safety"
  | "tools"
  | "mcp"
  | "gateway"
  | "about";

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  icon: typeof Cpu;
};

type LoadState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

type EncryptedBackupResult = {
  saved: boolean;
  canceled: boolean;
  filePath?: string;
  bytes?: number;
  sha256?: string;
  createdAt?: string;
};

type BackupPreflightCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

type BackupPreflightResult = {
  canceled: boolean;
  ok?: boolean;
  filePath?: string;
  createdAt?: string;
  files?: number;
  bytes?: number;
  checks?: BackupPreflightCheck[];
};

type DesktopBackupBridge = {
  createEncryptedBackup?: () => Promise<EncryptedBackupResult>;
  inspectEncryptedBackup?: () => Promise<BackupPreflightResult>;
  restoreEncryptedBackup?: () => Promise<{
    restored: boolean;
    canceled: boolean;
    createdAt?: string;
    files?: number;
    bytes?: number;
  }>;
};

type DesktopOperationState<T> =
  | { status: "idle" | "running" | "canceled" }
  | { status: "success"; result: T }
  | { status: "error"; message: string; result?: T };

type AuditAnchorConfiguration = Awaited<
  ReturnType<NonNullable<Window["aletheiaDesktop"]>["getAuditAnchorConfiguration"]>
>;

type AuditAnchorState =
  | { status: "loading" | "unavailable" }
  | {
      status: "disabled" | "enabled" | "managed" | "canceled";
      configuration: AuditAnchorConfiguration;
    }
  | {
      status: "failure";
      message: string;
      configuration?: AuditAnchorConfiguration;
    };

const settingsSections: SettingsSection[] = [
  { id: "model", label: "Models", icon: Cpu },
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "workspace", label: "Workspace", icon: Database },
  { id: "safety", label: "Safety", icon: LockKeyhole },
  { id: "tools", label: "Tools & Keys", icon: KeyRound },
  { id: "mcp", label: "MCP", icon: PlugZap },
  { id: "gateway", label: "Gateway", icon: PlugZap },
  { id: "about", label: "About", icon: Info },
];

function SettingRow({
  label,
  detail,
  children,
  layout = "split",
}: {
  label: string;
  detail?: string;
  children: React.ReactNode;
  layout?: "split" | "stack";
}) {
  return (
    <div
      className={cn(
        "aletheia-setting-row grid gap-3 border-b border-gray-200/70 py-4 last:border-b-0",
        layout === "split" &&
          "xl:grid-cols-[minmax(0,1fr)_320px] xl:items-center",
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-950">{label}</p>
        {detail ? (
          <p className="mt-1 max-w-2xl text-xs leading-5 text-gray-500">
            {detail}
          </p>
        ) : null}
      </div>
      <div
        className={cn("min-w-0", layout === "split" && "xl:justify-self-end")}
      >
        {children}
      </div>
    </div>
  );
}

function Button({
  children,
  onClick,
  disabled,
  variant = "secondary",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        variant === "primary" && "bg-gray-950 text-white hover:bg-gray-800",
        variant === "secondary" &&
          "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
        variant === "danger" &&
          "border border-red-200 bg-white text-red-700 hover:bg-red-50",
      )}
    >
      {children}
    </button>
  );
}

function FieldSelect<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly T[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none transition-colors focus:border-gray-500 xl:w-80"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-10 rounded-full border transition-colors",
        checked ? "border-gray-900 bg-gray-900" : "border-gray-300 bg-gray-100",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function StatusPill({
  status,
  tone,
}: {
  status: string;
  tone: "ok" | "warn" | "muted" | "error";
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-gray-700">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          tone === "ok" && "bg-emerald-500",
          tone === "warn" && "bg-amber-500",
          tone === "error" && "bg-red-500",
          tone === "muted" && "bg-gray-300",
        )}
      />
      {status}
    </span>
  );
}

function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="border-b border-gray-200 pb-4">
      <h1 className="text-lg font-semibold tracking-normal text-gray-950">
        {title}
      </h1>
      {detail ? (
        <p className="mt-1 text-sm leading-6 text-gray-500">{detail}</p>
      ) : null}
    </div>
  );
}

function fileNameFromPath(filePath?: string) {
  return filePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

function formatFileSize(bytes?: number) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unitIndex]}`;
}

function formatBackupTime(createdAt?: string) {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString();
}

function formatModelDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs.toLocaleString()} ms`;
  return `${(durationMs / 1_000).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} s`;
}

const benchmarkCaseLabels: Record<string, string> = {
  single_exact_quote: "Single exact quote",
  conflicting_sources: "Conflicting sources",
  insufficient_evidence_abstention: "Insufficient evidence abstention",
  relevant_source_selection: "Relevant source selection",
};

function conciseBenchmarkFailure(detail: string | null) {
  if (!detail) return "The case did not satisfy the diagnostic grader.";
  const labels: Record<string, string> = {
    required_source: "Missing source",
    forbidden_source: "Cited excluded source",
    required_marker: "Missing marker",
    forbidden_marker: "Disallowed conclusion",
    confidence: "Expected confidence",
    uncertainty: "Missing uncertainty",
    uncertainty_marker: "Missing uncertainty marker",
    question: "Missing counsel question",
    question_marker: "Missing question marker",
  };
  return detail
    .split(", ")
    .slice(0, 3)
    .map((failure) => {
      const separator = failure.indexOf(":");
      if (separator === -1) return failure;
      const code = failure.slice(0, separator);
      const value = failure.slice(separator + 1);
      return `${labels[code] ?? code.replaceAll("_", " ")}: ${value}`;
    })
    .join("; ");
}

function calibrationPresentation(model?: LocalModelSnapshot) {
  if (!model) {
    return {
      label: "Required",
      tone: "muted" as const,
      detail: "Select a local model before running mandatory calibration.",
    };
  }
  if (model.calibrationAcceptance?.accepted) {
    return {
      label: "Passed",
      tone: "ok" as const,
      detail: `Exact-quote protocol passed. Valid until ${formatModelDate(model.calibration?.expiresAt ?? "")}.`,
    };
  }
  const code = model.calibrationAcceptance?.code;
  if (code === "calibration_stale") {
    return {
      label: "Stale",
      tone: "warn" as const,
      detail:
        "The model revision or execution settings changed. Run calibration again.",
    };
  }
  if (code === "calibration_expired") {
    return {
      label: "Expired",
      tone: "warn" as const,
      detail: "The calibration is older than 30 days. Run calibration again.",
    };
  }
  if (code === "model_revision_unavailable") {
    return {
      label: "Revision required",
      tone: "warn" as const,
      detail:
        "Expose an immutable model revision in the local runtime, then run calibration.",
    };
  }
  if (code === "calibration_failed") {
    return {
      label: "Failed",
      tone: "error" as const,
      detail:
        model.calibration?.failureDetail ??
        "The exact-quote probe failed. Resolve the reported issue and run it again.",
    };
  }
  return {
    label: "Required",
    tone: "muted" as const,
    detail:
      "Required before source-grounded litigation analysis. This checks structured JSON and complete exact quotes.",
  };
}

function benchmarkPresentation(model?: LocalModelSnapshot) {
  const code = model?.benchmarkAcceptance?.code;
  if (model?.benchmarkAcceptance?.accepted) {
    return {
      label: "Diagnostic pass",
      tone: "ok" as const,
      detail: "The latest persisted diagnostic result is current.",
    };
  }
  if (code === "benchmark_failed") {
    return {
      label: "Failed",
      tone: "error" as const,
      detail:
        "Review the failed cases below, correct the runtime, and run again.",
    };
  }
  if (code === "benchmark_stale") {
    return {
      label: "Stale",
      tone: "warn" as const,
      detail:
        "The model revision, protocol, or execution settings changed. Run again.",
    };
  }
  if (code === "benchmark_expired") {
    return {
      label: "Expired",
      tone: "warn" as const,
      detail: "The result is older than 30 days. Run the benchmark again.",
    };
  }
  if (code === "benchmark_integrity_failed") {
    return {
      label: "Integrity check failed",
      tone: "error" as const,
      detail:
        "Do not rely on this result. Resolve the local persistence integrity issue before rerunning.",
    };
  }
  if (code === "model_revision_unavailable") {
    return {
      label: "Revision required",
      tone: "warn" as const,
      detail:
        "Expose an immutable model revision and complete calibration before benchmarking.",
    };
  }
  return {
    label: "Not run",
    tone: "muted" as const,
    detail: model
      ? "Run this diagnostic after the mandatory calibration passes."
      : "Select a local model before running this diagnostic.",
  };
}

function ModelBenchmark({
  model,
  running,
  diagnostic,
  productionExecutionGate,
  onRun,
}: {
  model?: LocalModelSnapshot;
  running: boolean;
  diagnostic: boolean;
  productionExecutionGate: boolean;
  onRun: () => void;
}) {
  const benchmark = model?.benchmark;
  const presentation = benchmarkPresentation(model);
  const passedCases =
    benchmark?.cases.filter((item) => item.status === "passed").length ?? 0;
  const canRun =
    model?.state === "ready" &&
    model.calibrationAcceptance?.accepted === true &&
    !running;

  return (
    <SettingRow
      label="Diagnostic multi-case benchmark"
      detail={presentation.detail}
      layout="stack"
    >
      <div data-testid="local-model-benchmark">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <StatusPill status={presentation.label} tone={presentation.tone} />
            <p className="mt-1 text-xs leading-5 text-gray-500">
              {diagnostic ? "Diagnostic only. " : ""}
              This benchmark does not replace counsel review and is
              {productionExecutionGate ? "" : " not currently"} an execution
              gate.
            </p>
          </div>
          <Button variant="primary" disabled={!canRun} onClick={onRun}>
            {running
              ? "Running benchmark"
              : benchmark
                ? "Run benchmark again"
                : "Run benchmark"}
          </Button>
        </div>

        {benchmark ? (
          <div className="mt-4 border-t border-gray-200/70">
            <dl className="grid gap-x-6 gap-y-3 py-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <div className="min-w-0">
                <dt className="text-gray-500">Protocol</dt>
                <dd className="mt-1 break-words font-medium text-gray-800">
                  {benchmark.protocolVersion}
                  <span className="font-normal text-gray-500">
                    {` · ${benchmark.cases.length} cases`}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Pass score</dt>
                <dd className="mt-1 font-medium text-gray-800">
                  {`${Math.round(benchmark.score * 100)}% · ${passedCases}/${benchmark.cases.length} passed`}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Duration</dt>
                <dd className="mt-1 font-medium text-gray-800">
                  {formatDuration(benchmark.durationMs)}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Tested</dt>
                <dd className="mt-1 font-medium text-gray-800">
                  {formatModelDate(benchmark.testedAt)}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Expires</dt>
                <dd className="mt-1 font-medium text-gray-800">
                  {formatModelDate(benchmark.expiresAt)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-gray-500">Bound revision</dt>
                <dd className="mt-1 break-all font-mono text-[11px] leading-4 text-gray-800">
                  {benchmark.modelRevision}
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2 lg:col-span-3">
                <dt className="text-gray-500">Bound fingerprint</dt>
                <dd className="mt-1 break-all font-mono text-[11px] leading-4 text-gray-800">
                  {benchmark.modelFingerprint}
                </dd>
              </div>
            </dl>

            <ol
              className="divide-y divide-gray-200/70 border-t border-gray-200/70"
              aria-label="Benchmark case results"
            >
              {benchmark.cases.map((item) => (
                <li
                  key={item.caseId}
                  className="flex min-w-0 flex-col gap-1.5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    {item.status === "passed" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-900">
                        {benchmarkCaseLabels[item.caseId] ?? item.caseId}
                      </p>
                      {item.status === "failed" ? (
                        <p className="mt-0.5 break-words text-xs leading-5 text-red-700">
                          {conciseBenchmarkFailure(item.failureDetail)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <span className="pl-6 text-xs tabular-nums text-gray-500 sm:pl-0">
                    {item.status === "passed" ? "Passed" : "Failed"}
                    {` · ${formatDuration(item.durationMs)}`}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="mt-4 border-t border-gray-200/70 pt-3 text-xs leading-5 text-gray-500">
            The backend persists the latest result and its per-case integrity
            hashes. Results remain visible after refresh.
          </p>
        )}
      </div>
    </SettingRow>
  );
}

function backupMetadata(result: {
  filePath?: string;
  bytes?: number;
  createdAt?: string;
  files?: number;
}) {
  return [
    fileNameFromPath(result.filePath),
    formatFileSize(result.bytes),
    typeof result.files === "number"
      ? `${result.files.toLocaleString()} ${result.files === 1 ? "file" : "files"}`
      : null,
    formatBackupTime(result.createdAt),
  ].filter((value): value is string => Boolean(value));
}

export function AletheiaSettings() {
  const importInputRef = useRef<HTMLInputElement>(null);
  const desktopBridge =
    typeof window !== "undefined"
      ? (window.aletheiaDesktop as
          | (NonNullable<Window["aletheiaDesktop"]> & DesktopBackupBridge)
          | undefined)
      : undefined;
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>("model");
  const [settings, setSettings] = useState<AletheiaClientSettings>(
    DEFAULT_ALETHEIA_SETTINGS,
  );
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [settingsDocument, setSettingsDocument] =
    useState<ClientSettingsDocument | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<
    "loading" | "saved" | "saving" | "offline" | "error"
  >("loading");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [desktopInfo, setDesktopInfo] = useState<AletheiaDesktopInfo | null>(
    null,
  );
  const [desktopAction, setDesktopAction] = useState<string | null>(null);
  const [backupState, setBackupState] = useState<
    DesktopOperationState<EncryptedBackupResult>
  >({
    status: "idle",
  });
  const [preflightState, setPreflightState] = useState<
    DesktopOperationState<BackupPreflightResult>
  >({
    status: "idle",
  });
  const [restoreState, setRestoreState] = useState<
    DesktopOperationState<{
      restored: boolean;
      canceled: boolean;
      createdAt?: string;
      files?: number;
      bytes?: number;
    }>
  >({ status: "idle" });
  const [auditAnchorState, setAuditAnchorState] =
    useState<AuditAnchorState>({ status: "loading" });
  const [auditAnchorBusy, setAuditAnchorBusy] = useState(false);
  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpUrl, setNewMcpUrl] = useState("");
  const [providerSecrets, setProviderSecrets] = useState<
    Record<AletheiaLegalSourceProviderId, string>
  >({ pkulaw: "", yuandian: "", wolters: "" });
  const [legalSourceProviders, setLegalSourceProviders] = useState<
    LoadState<AletheiaLegalSourceProvider[]>
  >({ data: null, loading: true, error: null });
  const [providerAction, setProviderAction] = useState<
    AletheiaLegalSourceProviderId | null
  >(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [mcpConnectors, setMcpConnectors] = useState<
    LoadState<McpConnectorSummary[]>
  >({
    data: null,
    loading: true,
    error: null,
  });
  const [gatewayHealth, setGatewayHealth] = useState<
    LoadState<{ status?: string }>
  >({
    data: null,
    loading: true,
    error: null,
  });
  const [securityPolicy, setSecurityPolicy] = useState<
    LoadState<AletheiaSecurityPolicy>
  >({
    data: null,
    loading: true,
    error: null,
  });
  const [voiceStatus, setVoiceStatus] = useState<
    LoadState<{
      healthy?: boolean;
      failureReason?: string | null;
      stt?: { available?: boolean };
      tts?: { available?: boolean };
    }>
  >({ data: null, loading: true, error: null });

  const localModels = useLocalModels();
  const settingsBusy =
    settingsStatus === "loading" ||
    settingsStatus === "saving" ||
    settingsStatus === "offline";

  async function updateSetting<K extends keyof AletheiaClientSettings>(
    key: K,
    value: AletheiaClientSettings[K],
  ) {
    const previous = settings;
    const optimistic = normalizeAletheiaSettings({ ...previous, [key]: value });
    setSettings(optimistic);
    if (key === "defaultModel") selectDefaultModel(String(value));
    writeAletheiaSettingsCache(optimistic);
    setSettingsStatus("saving");
    setSettingsError(null);
    try {
      const document = await apiSettingsTransport.patch(
        { [key]: value } as Partial<AletheiaClientSettings>,
        { etag: settingsDocument?.etag },
      );
      setSettingsDocument(document);
      setSettings(document.settings);
      if (key === "defaultModel")
        selectDefaultModel(document.settings.defaultModel);
      writeAletheiaSettingsCache(document.settings);
      setSavedAt(new Date());
      setSettingsStatus("saved");
      if (key === "defaultModel" || key === "reasoning" || key === "fastMode") {
        await localModels.refresh();
      }
    } catch (reason) {
      setSettings(previous);
      if (key === "defaultModel") selectDefaultModel(previous.defaultModel);
      writeAletheiaSettingsCache(previous);
      setSettingsError(
        reason instanceof Error
          ? reason.message
          : "Settings could not be saved.",
      );
      setSettingsStatus("error");
    }
  }

  async function replaceSettings(nextSettings: AletheiaClientSettings) {
    const normalized = normalizeAletheiaSettings(nextSettings);
    const previous = settings;
    setSettings(normalized);
    selectDefaultModel(normalized.defaultModel);
    writeAletheiaSettingsCache(normalized);
    setSettingsStatus("saving");
    setSettingsError(null);
    try {
      const document = await apiSettingsTransport.patch(normalized, {
        etag: settingsDocument?.etag,
      });
      setSettingsDocument(document);
      setSettings(document.settings);
      selectDefaultModel(document.settings.defaultModel);
      writeAletheiaSettingsCache(document.settings);
      setSavedAt(new Date());
      setSettingsStatus("saved");
    } catch (reason) {
      setSettings(previous);
      selectDefaultModel(previous.defaultModel);
      writeAletheiaSettingsCache(previous);
      setSettingsError(
        reason instanceof Error
          ? reason.message
          : "Settings could not be saved.",
      );
      setSettingsStatus("error");
    }
  }

  async function resetSettings() {
    const previous = settings;
    setSettingsStatus("saving");
    setSettingsError(null);
    try {
      const document = await apiSettingsTransport.reset({
        etag: settingsDocument?.etag,
      });
      setSettingsDocument(document);
      setSettings(document.settings);
      selectDefaultModel(document.settings.defaultModel);
      writeAletheiaSettingsCache(document.settings);
      setSavedAt(new Date());
      setSettingsStatus("saved");
    } catch (reason) {
      setSettings(previous);
      setSettingsError(
        reason instanceof Error
          ? reason.message
          : "Settings could not be reset.",
      );
      setSettingsStatus("error");
    }
  }

  async function refreshRuntimeStatus() {
    setMcpConnectors((current) => ({ ...current, loading: true, error: null }));
    setGatewayHealth((current) => ({ ...current, loading: true, error: null }));
    setSecurityPolicy((current) => ({
      ...current,
      loading: true,
      error: null,
    }));
    setVoiceStatus((current) => ({ ...current, loading: true, error: null }));
    setLegalSourceProviders((current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    const [apiBase, authHeaders] = await Promise.all([
      getAletheiaApiBase(),
      getAletheiaAuthHeaders(),
    ]);
    const [connectorsResult, healthResult, policyResult, voiceResult, providersResult] =
      await Promise.allSettled([
        listMcpConnectors(),
        fetch(`${apiBase}/health`, { cache: "no-store" }).then(
          async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return (await response.json()) as { status?: string };
          },
        ),
        getAletheiaSecurityPolicy(),
        fetch(`${apiBase}/aletheia/local-voice/status`, {
          cache: "no-store",
          headers: authHeaders,
        }).then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return (await response.json()) as {
            healthy?: boolean;
            failureReason?: string | null;
            stt?: { available?: boolean };
            tts?: { available?: boolean };
          };
        }),
        listAletheiaLegalSourceProviders(),
      ]);

    setMcpConnectors({
      data:
        connectorsResult.status === "fulfilled" ? connectorsResult.value : null,
      loading: false,
      error:
        connectorsResult.status === "rejected"
          ? "Cannot load MCP connectors."
          : null,
    });
    setGatewayHealth({
      data: healthResult.status === "fulfilled" ? healthResult.value : null,
      loading: false,
      error:
        healthResult.status === "rejected" ? "Gateway is not reachable." : null,
    });
    setSecurityPolicy({
      data: policyResult.status === "fulfilled" ? policyResult.value : null,
      loading: false,
      error:
        policyResult.status === "rejected"
          ? "Security policy is unavailable."
          : null,
    });
    setVoiceStatus({
      data: voiceResult.status === "fulfilled" ? voiceResult.value : null,
      loading: false,
      error:
        voiceResult.status === "rejected"
          ? "Local voice runtime is unavailable."
          : null,
    });
    setLegalSourceProviders({
      data:
        providersResult.status === "fulfilled"
          ? providersResult.value.providers
          : null,
      loading: false,
      error:
        providersResult.status === "rejected"
          ? "法律数据源配置不可用。"
          : null,
    });
  }

  async function refreshLegalSourceProviders() {
    const response = await listAletheiaLegalSourceProviders();
    setLegalSourceProviders({ data: response.providers, loading: false, error: null });
  }

  async function handleProviderSave(provider: AletheiaLegalSourceProviderId) {
    const secret = providerSecrets[provider].trim();
    if (!secret) return;
    setProviderAction(provider);
    setProviderError(null);
    try {
      await saveAletheiaLegalSourceSecret(provider, secret);
      await refreshLegalSourceProviders();
    } catch (reason) {
      setProviderError(
        reason instanceof Error ? reason.message : "本地密钥保存失败。",
      );
    } finally {
      setProviderSecrets((current) => ({ ...current, [provider]: "" }));
      setProviderAction(null);
    }
  }

  async function handleProviderRemove(provider: AletheiaLegalSourceProviderId) {
    setProviderAction(provider);
    setProviderError(null);
    try {
      await removeAletheiaLegalSourceSecret(provider);
      await refreshLegalSourceProviders();
    } catch (reason) {
      setProviderError(
        reason instanceof Error ? reason.message : "本地密钥移除失败。",
      );
    } finally {
      setProviderAction(null);
    }
  }

  useEffect(() => {
    applyAletheiaSettings(settings);
  }, [settings]);

  useEffect(() => {
    const bridge =
      typeof window !== "undefined" ? window.aletheiaDesktop : undefined;
    void bridge
      ?.getInfo()
      .then(setDesktopInfo)
      .catch(() => {
        setDesktopInfo(null);
      });
    let cancelled = false;
    if (!bridge?.getAuditAnchorConfiguration) {
      setAuditAnchorState({ status: "unavailable" });
    } else {
      void bridge
        .getAuditAnchorConfiguration()
        .then((configuration) => {
          if (cancelled) return;
          setAuditAnchorState({
            status: configuration.managedExternally
              ? "managed"
              : configuration.enabled
                ? "enabled"
                : "disabled",
            configuration,
          });
        })
        .catch(() => {
          if (cancelled) return;
          setAuditAnchorState({
            status: "failure",
            message: "Audit anchor configuration could not be loaded.",
          });
        });
    }
    const cached = readAletheiaSettings();
    setSettings(cached);
    applyAletheiaSettings(cached);
    void refreshRuntimeStatus();
    void apiSettingsTransport
      .load()
      .then((document) => {
        if (cancelled) return;
        setSettingsDocument(document);
        setSettings(document.settings);
        writeAletheiaSettingsCache(document.settings);
        setSettingsStatus("saved");
      })
      .catch((reason) => {
        if (cancelled) return;
        setSettingsError(
          reason instanceof Error
            ? `Using offline cache. ${reason.message}`
            : "Using offline cache. Settings service is unavailable.",
        );
        setSettingsStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function updateAuditAnchor(
    action: "configure" | "disable",
  ) {
    const call =
      action === "configure"
        ? desktopBridge?.configureAuditAnchor
        : desktopBridge?.disableAuditAnchor;
    if (!call) return;

    const priorConfiguration =
      "configuration" in auditAnchorState
        ? auditAnchorState.configuration
        : undefined;
    setAuditAnchorBusy(true);
    try {
      const result = await call();
      setAuditAnchorState({
        status: result.canceled
          ? "canceled"
          : result.configuration.managedExternally
            ? "managed"
            : result.configuration.enabled
              ? "enabled"
              : "disabled",
        configuration: result.configuration,
      });
    } catch {
      setAuditAnchorState({
        status: "failure",
        message: `Audit anchoring could not be ${action === "configure" ? "configured" : "disabled"}. The prior configuration is unchanged.`,
        configuration: priorConfiguration,
      });
    } finally {
      setAuditAnchorBusy(false);
    }
  }

  async function handleMcpToggle(connector: McpConnectorSummary) {
    setMcpConnectors((current) => ({ ...current, loading: true, error: null }));
    try {
      const updated = await updateMcpConnector(connector.id, {
        enabled: !connector.enabled,
      });
      setMcpConnectors((current) => ({
        data: (current.data ?? []).map((item) =>
          item.id === updated.id ? updated : item,
        ),
        loading: false,
        error: null,
      }));
    } catch (reason) {
      setMcpConnectors((current) => ({
        ...current,
        loading: false,
        error:
          reason instanceof Error
            ? reason.message
            : "Connector could not be updated.",
      }));
    }
  }

  async function handleMcpRefresh(connector: McpConnectorSummary) {
    setMcpConnectors((current) => ({ ...current, loading: true, error: null }));
    try {
      const updated = await refreshMcpConnectorTools(connector.id);
      setMcpConnectors((current) => ({
        data: (current.data ?? []).map((item) =>
          item.id === updated.id ? updated : item,
        ),
        loading: false,
        error: null,
      }));
    } catch (reason) {
      setMcpConnectors((current) => ({
        ...current,
        loading: false,
        error:
          reason instanceof Error
            ? reason.message
            : "Connector tools could not be refreshed.",
      }));
    }
  }

  async function handleCreateMcpConnector() {
    if (!newMcpName.trim() || !newMcpUrl.trim()) return;
    setMcpConnectors((current) => ({ ...current, loading: true, error: null }));
    try {
      const created = await createMcpConnector({
        name: newMcpName.trim(),
        serverUrl: newMcpUrl.trim(),
      });
      setMcpConnectors((current) => ({
        data: [created, ...(current.data ?? [])],
        loading: false,
        error: null,
      }));
      setNewMcpName("");
      setNewMcpUrl("");
    } catch (reason) {
      setMcpConnectors((current) => ({
        ...current,
        loading: false,
        error:
          reason instanceof Error
            ? reason.message
            : "Connector could not be added.",
      }));
    }
  }

  async function handleImportSettings(file: File | null) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      await replaceSettings(normalizeAletheiaSettings(parsed));
    } catch (reason) {
      setSettingsError(
        reason instanceof Error ? reason.message : "Settings file is invalid.",
      );
    }
  }

  async function runDesktopAction(
    label: string,
    action?: () => Promise<unknown>,
  ) {
    if (!action) return;
    setDesktopAction(`${label}...`);
    try {
      await action();
      setDesktopAction(`${label} complete`);
    } catch {
      setDesktopAction(`${label} failed`);
    }
  }

  async function createEncryptedBackup() {
    const createBackup = desktopBridge?.createEncryptedBackup;
    if (!createBackup) return;

    setBackupState({ status: "running" });
    try {
      const result = await createBackup();
      if (result.canceled) {
        setBackupState({ status: "canceled" });
      } else if (result.saved) {
        setBackupState({ status: "success", result });
      } else {
        setBackupState({
          status: "error",
          message: "The backup was not created.",
          result,
        });
      }
    } catch (reason) {
      setBackupState({
        status: "error",
        message:
          reason instanceof Error
            ? reason.message
            : "The backup could not be created.",
      });
    }
  }

  async function inspectEncryptedBackup() {
    const inspectBackup = desktopBridge?.inspectEncryptedBackup;
    if (!inspectBackup) return;

    setPreflightState({ status: "running" });
    setRestoreState({ status: "idle" });
    try {
      const result = await inspectBackup();
      if (result.canceled) {
        setPreflightState({ status: "canceled" });
      } else if (result.ok) {
        setPreflightState({ status: "success", result });
      } else {
        setPreflightState({
          status: "error",
          message: "The selected backup did not pass preflight.",
          result,
        });
      }
    } catch (reason) {
      setPreflightState({
        status: "error",
        message:
          reason instanceof Error
            ? reason.message
            : "The backup could not be inspected.",
      });
    }
  }

  async function restoreEncryptedBackup() {
    const restoreBackup = desktopBridge?.restoreEncryptedBackup;
    if (!restoreBackup || preflightState.status !== "success") return;
    setRestoreState({ status: "running" });
    try {
      const result = await restoreBackup();
      if (result.canceled) {
        setRestoreState({ status: "canceled" });
      } else if (result.restored) {
        setRestoreState({ status: "success", result });
      } else {
        setRestoreState({
          status: "error",
          message: "The workspace was not restored.",
          result,
        });
      }
    } catch (reason) {
      setRestoreState({
        status: "error",
        message:
          reason instanceof Error
            ? reason.message
            : "The workspace could not be restored.",
      });
    }
  }

  function renderSection() {
    if (activeSection === "model") {
      const selectedModel = localModels.models.find(
        (model) =>
          model.id === (settings.litigationModelId || settings.defaultModel),
      );
      const routineModel = localModels.models.find(
        (model) =>
          model.id === (settings.routineModelId || settings.defaultModel),
      );
      const calibrationState = calibrationPresentation(selectedModel);
      const compressionRuntime =
        settingsDocument?.runtimeConfig?.fields?.contextCompression;
      const compressionAvailable = compressionRuntime?.status === "available";
      const compressionModes = compressionRuntime?.availableModes?.length
        ? compressionRuntime.availableModes
        : (["Off", "Manual", "Auto"] as const);
      const compressionRuntimeDetail = [
        compressionRuntime?.note,
        compressionRuntime?.model ? `Model: ${compressionRuntime.model}` : null,
        typeof compressionRuntime?.thresholdTokens === "number"
          ? `Threshold: ${compressionRuntime.thresholdTokens.toLocaleString()} tokens`
          : null,
      ]
        .filter(Boolean)
        .join(" ");
      return (
        <>
          <SectionHeader
            title="Models"
            detail="The local runtime assigns models by task role; the server, not the client, makes the final selection."
          />
          <SettingRow label="Provider">
            <StatusPill
              tone={selectedModel ? "ok" : "muted"}
              status={
                selectedModel
                  ? `${selectedModel.adapter} · loopback only`
                  : "Derived after a model is selected"
              }
            />
          </SettingRow>
          <SettingRow label="Fallback model">
            <select
              value={settings.defaultModel}
              disabled={
                settingsBusy ||
                localModels.loading ||
                localModels.models.length === 0
              }
              onChange={(event) =>
                void updateSetting("defaultModel", event.target.value)
              }
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none disabled:opacity-50 md:w-80"
            >
              {!settings.defaultModel ? (
                <option value="">Select a local model</option>
              ) : null}
              {settings.defaultModel && !selectedModel ? (
                <option value={settings.defaultModel}>
                  {settings.defaultModel} · unavailable
                </option>
              ) : null}
              {localModels.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.model || model.id} · {model.state}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Litigation analysis"
            detail="Use the stronger calibrated model for source-grounded analysis, legal positions, and hearing preparation."
          >
            <select
              value={settings.litigationModelId || settings.defaultModel}
              disabled={
                settingsBusy ||
                localModels.loading ||
                localModels.models.length === 0
              }
              onChange={(event) =>
                void updateSetting("litigationModelId", event.target.value)
              }
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none disabled:opacity-50 md:w-80"
            >
              {localModels.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.model || model.id} · {model.state}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Routine analysis"
            detail="Use the faster local model for bounded, non-final analysis tasks. It never approves legal conclusions or exports."
          >
            <select
              value={settings.routineModelId || settings.defaultModel}
              disabled={
                settingsBusy ||
                localModels.loading ||
                localModels.models.length === 0
              }
              onChange={(event) =>
                void updateSetting("routineModelId", event.target.value)
              }
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none disabled:opacity-50 md:w-80"
            >
              {localModels.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.model || model.id} · {model.state}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Context budget"
            detail={
              selectedModel
                ? `Auto uses up to ${selectedModel.contextWindowTokens.toLocaleString()} tokens for this model.`
                : "Select a local model to establish the maximum context window."
            }
          >
            <select
              value={settings.contextBudgetTokens ?? "auto"}
              disabled={settingsBusy || !selectedModel}
              onChange={(event) =>
                void updateSetting(
                  "contextBudgetTokens",
                  event.target.value === "auto"
                    ? null
                    : Number(event.target.value),
                )
              }
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none disabled:opacity-50 md:w-80"
            >
              <option value="auto">Auto</option>
              {[4096, 8192, 16384, 32768, 65536]
                .filter(
                  (budget) =>
                    !selectedModel ||
                    budget <= selectedModel.contextWindowTokens,
                )
                .map((budget) => (
                  <option key={budget} value={budget}>
                    {`${(budget / 1024).toLocaleString()}K tokens`}
                  </option>
                ))}
              {settings.contextBudgetTokens &&
              ![4096, 8192, 16384, 32768, 65536].includes(
                settings.contextBudgetTokens,
              ) ? (
                <option value={settings.contextBudgetTokens}>
                  {`${settings.contextBudgetTokens.toLocaleString()} tokens`}
                </option>
              ) : null}
            </select>
          </SettingRow>
          <SettingRow
            label="Reasoning"
            detail="Passed to the selected local model when supported; Fast mode disables extended reasoning."
          >
            <FieldSelect
              value={settings.reasoning}
              disabled={settingsBusy || !selectedModel}
              onChange={(value) => void updateSetting("reasoning", value)}
              options={["Off", "Low", "Medium", "High"] as const}
            />
          </SettingRow>
          <SettingRow
            label="Mandatory exact-quote calibration"
            detail={calibrationState.detail}
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              <StatusPill
                tone={calibrationState.tone}
                status={calibrationState.label}
              />
              <Button
                variant="primary"
                disabled={
                  !selectedModel ||
                  localModels.calibratingModelId === selectedModel.id ||
                  selectedModel.state !== "ready"
                }
                onClick={() =>
                  selectedModel && void localModels.calibrate(selectedModel.id)
                }
              >
                {localModels.calibratingModelId === selectedModel?.id
                  ? "Running…"
                  : "Run calibration"}
              </Button>
            </div>
          </SettingRow>
          <ModelBenchmark
            model={selectedModel}
            running={localModels.benchmarkingModelId === selectedModel?.id}
            diagnostic={localModels.policy?.diagnostic ?? true}
            productionExecutionGate={
              localModels.policy?.productionExecutionGate ?? false
            }
            onRun={() =>
              selectedModel && void localModels.benchmark(selectedModel.id)
            }
          />
          <SettingRow
            label="Fast mode"
            detail="Caps generated output at 1K tokens and turns off extended reasoning for quicker local responses."
          >
            <Toggle
              checked={settings.fastMode}
              disabled={settingsBusy || !selectedModel}
              onChange={(value) => void updateSetting("fastMode", value)}
            />
          </SettingRow>
          <SettingRow
            label="Routing state"
            detail="Each durable step records its resolved local model. Legal analysis requires a current exact-quote calibration; routine analysis remains reviewable draft work."
          >
            <StatusPill
              tone={selectedModel && routineModel ? "ok" : "muted"}
              status={
                selectedModel && routineModel
                  ? `${selectedModel.id} · legal / ${routineModel.id} · routine`
                  : "Select local models"
              }
            />
          </SettingRow>
          <SettingRow
            label="Context compression"
            detail={
              compressionAvailable
                ? compressionRuntimeDetail ||
                  "The installed local runtime exposes compression policy details."
                : compressionRuntime?.note ||
                  "No approved local compression policy is installed; the durable runtime enforces the token budget without compressing context."
            }
          >
            {compressionAvailable ? (
              <div
                className="flex flex-wrap items-center gap-2"
                aria-label="Context compression runtime capability"
              >
                <StatusPill tone="ok" status="Available" />
                <select
                  aria-label="Context compression mode"
                  value={settings.contextCompression}
                  disabled={settingsBusy}
                  onChange={(event) =>
                    void updateSetting(
                      "contextCompression",
                      event.target.value as typeof settings.contextCompression,
                    )
                  }
                  className="h-8 rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-900 outline-none disabled:opacity-50"
                >
                  {compressionModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-gray-600">
                  {compressionModes.join(" · ")}
                  {compressionRuntime?.mode
                    ? ` · active: ${compressionRuntime.mode}`
                    : ""}
                </span>
              </div>
            ) : (
              <StatusPill tone="muted" status="Unavailable" />
            )}
          </SettingRow>
          <SettingRow
            label="Runtime status"
            detail={localModels.error ?? undefined}
          >
            <div className="flex items-center gap-3">
              <StatusPill
                tone={
                  localModels.error
                    ? "error"
                    : localModels.loading
                      ? "muted"
                      : "ok"
                }
                status={
                  localModels.loading
                    ? "Checking"
                    : `${localModels.models.length} configured`
                }
              />
              <Button
                onClick={() => void localModels.refresh()}
                disabled={localModels.loading}
              >
                Refresh
              </Button>
            </div>
          </SettingRow>
        </>
      );
    }

    if (activeSection === "workspace") {
      const evidenceIndexRuntime =
        settingsDocument?.runtimeConfig?.fields?.evidenceIndex;
      const semanticIndexAvailable =
        evidenceIndexRuntime?.note?.includes(
          "semantic retrieval are available",
        ) ?? false;
      const evidenceIndexOptions =
        semanticIndexAvailable || settings.evidenceIndex !== "Keyword"
          ? (["Keyword", "Hybrid", "Semantic"] as const)
          : (["Keyword"] as const);
      const canCreateBackup =
        typeof desktopBridge?.createEncryptedBackup === "function";
      const canInspectBackup =
        typeof desktopBridge?.inspectEncryptedBackup === "function";
      const canRestoreBackup =
        typeof desktopBridge?.restoreEncryptedBackup === "function" &&
        preflightState.status === "success";
      const failedPreflightChecks =
        preflightState.status === "error"
          ? (preflightState.result?.checks?.filter((check) => !check.ok) ?? [])
          : [];
      return (
        <>
          <SectionHeader
            title="Workspace"
            detail="Local storage, matter defaults, and file export behavior."
          />
          <SettingRow label="Data directory">
            <div className="flex items-center gap-2">
              <code className="block min-w-0 flex-1 truncate rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                {desktopInfo
                  ? "Managed by Vera desktop"
                  : "Desktop bridge unavailable"}
              </code>
              <Button
                disabled={!desktopBridge}
                onClick={() =>
                  runDesktopAction(
                    "Open data folder",
                    desktopBridge?.openDataDirectory,
                  )
                }
              >
                Open
              </Button>
            </div>
          </SettingRow>
          <SettingRow label="Default matter template">
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
              {settings.defaultTemplate}
            </div>
          </SettingRow>
          <SettingRow
            label="Evidence index"
            detail={
              evidenceIndexRuntime?.note ??
              "Keyword retrieval uses the local SQLite FTS5 index."
            }
          >
            <FieldSelect
              value={settings.evidenceIndex}
              disabled={settingsBusy}
              onChange={(value) => void updateSetting("evidenceIndex", value)}
              options={evidenceIndexOptions}
            />
          </SettingRow>
          <SettingRow
            label="Encrypted backup"
            detail="Create an encrypted archive of this local workspace."
          >
            <div className="flex flex-col items-start gap-2 md:items-end">
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                {!canCreateBackup ? (
                  <span className="text-xs text-gray-500">
                    macOS desktop only
                  </span>
                ) : null}
                <Button
                  disabled={
                    !canCreateBackup || backupState.status === "running"
                  }
                  onClick={() => void createEncryptedBackup()}
                >
                  {backupState.status === "running"
                    ? "Creating..."
                    : "Create backup"}
                </Button>
              </div>
              <div
                className="text-left md:text-right"
                role="status"
                aria-live="polite"
              >
                {backupState.status === "running" ? (
                  <StatusPill tone="muted" status="Creating encrypted backup" />
                ) : backupState.status === "canceled" ? (
                  <StatusPill tone="warn" status="Backup canceled" />
                ) : backupState.status === "success" ? (
                  <>
                    <StatusPill tone="ok" status="Backup complete" />
                    {backupMetadata(backupState.result).length ? (
                      <p className="mt-1 text-xs text-gray-500">
                        {backupMetadata(backupState.result).join(" · ")}
                      </p>
                    ) : null}
                  </>
                ) : backupState.status === "error" ? (
                  <StatusPill
                    tone="error"
                    status={`Backup failed: ${backupState.message}`}
                  />
                ) : null}
              </div>
            </div>
          </SettingRow>
          <SettingRow
            label="Restore preflight"
            detail="Checks the selected backup only. It does not overwrite current data."
          >
            <div className="flex flex-col items-start gap-2 md:items-end">
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                {!canInspectBackup ? (
                  <span className="text-xs text-gray-500">
                    macOS desktop only
                  </span>
                ) : null}
                <Button
                  disabled={
                    !canInspectBackup || preflightState.status === "running"
                  }
                  onClick={() => void inspectEncryptedBackup()}
                >
                  {preflightState.status === "running"
                    ? "Checking..."
                    : "Check backup"}
                </Button>
              </div>
              <div
                className="text-left md:text-right"
                role="status"
                aria-live="polite"
              >
                {preflightState.status === "running" ? (
                  <StatusPill tone="muted" status="Checking backup" />
                ) : preflightState.status === "canceled" ? (
                  <StatusPill tone="warn" status="Preflight canceled" />
                ) : preflightState.status === "success" ? (
                  <>
                    <StatusPill tone="ok" status="Preflight passed" />
                    {backupMetadata(preflightState.result).length ? (
                      <p className="mt-1 text-xs text-gray-500">
                        {backupMetadata(preflightState.result).join(" · ")}
                      </p>
                    ) : null}
                  </>
                ) : preflightState.status === "error" ? (
                  <>
                    <StatusPill tone="error" status="Preflight failed" />
                    <p className="mt-1 max-w-sm text-xs leading-5 text-red-700">
                      {failedPreflightChecks.length
                        ? `${failedPreflightChecks.length} failed ${failedPreflightChecks.length === 1 ? "check" : "checks"}: ${failedPreflightChecks.map((check) => `${check.id}: ${check.detail}`).join("; ")}`
                        : preflightState.message}
                    </p>
                  </>
                ) : null}
              </div>
            </div>
          </SettingRow>
          <SettingRow
            label="Restore workspace"
            detail="Replaces current local data with the backup that just passed preflight. The prior workspace is reinstated automatically if restored services fail to start."
          >
            <div className="flex flex-col items-start gap-2 md:items-end">
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <Button
                  disabled={
                    !canRestoreBackup || restoreState.status === "running"
                  }
                  onClick={() => void restoreEncryptedBackup()}
                >
                  {restoreState.status === "running"
                    ? "Restoring..."
                    : "Restore backup"}
                </Button>
                {restoreState.status === "success" ? (
                  <Button
                    onClick={() => window.location.assign("/aletheia/matters")}
                  >
                    Open restored workspace
                  </Button>
                ) : null}
              </div>
              <div
                className="text-left md:text-right"
                role="status"
                aria-live="polite"
              >
                {restoreState.status === "running" ? (
                  <StatusPill tone="muted" status="Restoring workspace" />
                ) : restoreState.status === "canceled" ? (
                  <StatusPill tone="warn" status="Restore canceled" />
                ) : restoreState.status === "success" ? (
                  <>
                    <StatusPill tone="ok" status="Restore complete" />
                    {backupMetadata(restoreState.result).length ? (
                      <p className="mt-1 text-xs text-gray-500">
                        {backupMetadata(restoreState.result).join(" · ")}
                      </p>
                    ) : null}
                  </>
                ) : restoreState.status === "error" ? (
                  <StatusPill
                    tone="error"
                    status={`Restore failed: ${restoreState.message}`}
                  />
                ) : null}
              </div>
            </div>
          </SettingRow>
          <p className="flex items-start gap-2 pt-4 text-xs leading-5 text-gray-500">
            <LockKeyhole
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              Backups are tied to this Mac&apos;s Keychain. Before moving to
              another Mac, separately escrow both the application and database
              recovery keys. Restore is available only for the backup that just
              passed preflight.
            </span>
          </p>
        </>
      );
    }

    if (activeSection === "chat") {
      return (
        <>
          <SectionHeader
            title="Workspace"
            detail="Navigation and review behavior for civil-litigation matters."
          />
          <SettingRow label="Default landing">
            <FieldSelect
              value={settings.defaultLanding}
              disabled={settingsBusy}
              onChange={(value) => void updateSetting("defaultLanding", value)}
              options={
                ["Matters", "Last opened matter"] as const
              }
            />
          </SettingRow>
          <SettingRow label="Show citations inline">
            <Toggle
              checked={settings.showCitationsInline}
              disabled={settingsBusy}
              onChange={(value) =>
                void updateSetting("showCitationsInline", value)
              }
            />
          </SettingRow>
          <SettingRow
            label="Notifications"
            detail="Shows local workflow updates in the client and, when permitted, as desktop notifications."
          >
            <Toggle
              checked={settings.notifications}
              disabled={settingsBusy}
              onChange={(value) => {
                if (value) void requestAletheiaNotificationPermission();
                void updateSetting("notifications", value);
              }}
            />
          </SettingRow>
          <SettingRow
            label="Voice"
            detail={
              voiceStatus.loading
                ? "Checking the local-only voice runtime."
                : voiceStatus.data?.healthy
                  ? `Local faster-whisper is healthy${voiceStatus.data.tts?.available ? "; local NeuTTS is available." : "; NeuTTS is not installed."}`
                  : voiceStatus.data?.failureReason ||
                    voiceStatus.error ||
                    "Local STT/TTS is unavailable until a vetted offline voice runtime is installed."
            }
          >
            <StatusPill
              tone={voiceStatus.data?.healthy ? "ok" : "muted"}
              status={
                voiceStatus.data?.healthy
                  ? "Available"
                  : voiceStatus.loading
                    ? "Checking"
                    : "Unavailable"
              }
            />
          </SettingRow>
        </>
      );
    }

    if (activeSection === "appearance") {
      return (
        <>
          <SectionHeader
            title="Appearance"
            detail="These preferences are applied to the local client document root immediately."
          />
          <SettingRow label="Theme">
            <FieldSelect
              value={settings.theme}
              disabled={settingsBusy}
              onChange={(value) => void updateSetting("theme", value)}
              options={["System", "Light", "Dark"] as const}
            />
          </SettingRow>
          <SettingRow label="Density">
            <FieldSelect
              value={settings.density}
              disabled={settingsBusy}
              onChange={(value) => void updateSetting("density", value)}
              options={["Comfortable", "Compact"] as const}
            />
          </SettingRow>
          <SettingRow label="Sidebar">
            <FieldSelect
              value={settings.sidebar}
              disabled={settingsBusy}
              onChange={(value) => void updateSetting("sidebar", value)}
              options={["Standard", "Narrow"] as const}
            />
          </SettingRow>
          <SettingRow label="Document font size">
            <FieldSelect
              value={settings.documentFontSize}
              disabled={settingsBusy}
              onChange={(value) =>
                void updateSetting("documentFontSize", value)
              }
              options={["Small", "Medium", "Large"] as const}
            />
          </SettingRow>
        </>
      );
    }

    if (activeSection === "safety") {
      const anchorConfiguration =
        "configuration" in auditAnchorState
          ? auditAnchorState.configuration
          : undefined;
      const anchorStateLabel =
        auditAnchorState.status === "loading"
          ? "Loading"
          : auditAnchorState.status === "unavailable"
            ? "Unavailable in browser"
            : auditAnchorState.status === "managed"
              ? anchorConfiguration?.enabled
                ? "Enabled · managed externally"
                : "Disabled · managed externally"
              : auditAnchorState.status === "enabled"
                ? "Enabled"
                : auditAnchorState.status === "disabled"
                  ? "Disabled"
                  : auditAnchorState.status === "canceled"
                    ? "Canceled · configuration unchanged"
                    : "Configuration failed";
      const canControlAnchor = Boolean(
        desktopBridge &&
          anchorConfiguration &&
          !anchorConfiguration.managedExternally,
      );
      const anchorTone =
        (auditAnchorState.status === "enabled" ||
          (auditAnchorState.status === "managed" &&
            anchorConfiguration?.enabled))
          ? "ok"
          : auditAnchorState.status === "failure"
            ? "error"
            : auditAnchorState.status === "canceled"
              ? "warn"
              : "muted";
      const AnchorStateIcon =
        auditAnchorState.status === "loading"
          ? LoaderCircle
          : auditAnchorState.status === "failure"
            ? TriangleAlert
            : auditAnchorState.status === "unavailable"
              ? Ban
              : anchorConfiguration?.enabled
                ? ShieldCheck
                : LockKeyhole;
      return (
        <>
          <SectionHeader
            title="Safety"
            detail="These controls are enforced by the backend security policy and cannot be weakened in the browser."
          />
          <SettingRow label="Human approval for high-risk actions">
            <StatusPill tone="ok" status="Required" />
          </SettingRow>
          <SettingRow label="Citation gate before memo export">
            <StatusPill tone="ok" status="Fail closed" />
          </SettingRow>
          <SettingRow label="Final export policy">
            <StatusPill tone="ok" status="Fail closed" />
          </SettingRow>
          <SettingRow label="Audit integrity">
            <StatusPill
              tone={
                securityPolicy.data?.auditIntegrity ===
                "per_matter_hmac_hash_chain"
                  ? "ok"
                  : "error"
              }
              status={
                securityPolicy.loading
                  ? "Checking"
                  : securityPolicy.data?.auditIntegrity ===
                      "per_matter_hmac_hash_chain"
                    ? "HMAC chained"
                    : "Unsupported"
              }
            />
          </SettingRow>
          <SettingRow
            label="External audit anchor"
            detail="Operator-key local audit anchoring records signed audit heads in an independently stored, append-only journal to expose divergence from Vera's local audit chain. Not a qualified electronic signature, trusted timestamp, notarization, or WORM storage."
            layout="stack"
          >
            <div
              data-testid="audit-anchor-settings"
              className="flex min-w-0 flex-col gap-3"
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200/70 pb-3">
                <span className="inline-flex min-w-0 items-center gap-2 text-sm text-gray-700">
                  <AnchorStateIcon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      auditAnchorState.status === "loading" && "animate-spin",
                      anchorTone === "ok" && "text-emerald-600",
                      anchorTone === "warn" && "text-amber-600",
                      anchorTone === "error" && "text-red-600",
                      anchorTone === "muted" && "text-gray-400",
                    )}
                    aria-hidden="true"
                  />
                  <span>{anchorStateLabel}</span>
                </span>
                {canControlAnchor ? (
                  <Button
                    variant={anchorConfiguration?.enabled ? "danger" : "primary"}
                    disabled={auditAnchorBusy}
                    onClick={() =>
                      void updateAuditAnchor(
                        anchorConfiguration?.enabled ? "disable" : "configure",
                      )
                    }
                  >
                    {auditAnchorBusy
                      ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />Working...</>
                      : anchorConfiguration?.enabled
                        ? <><Power className="mr-2 h-4 w-4" aria-hidden="true" />Disable</>
                        : <><FolderOpen className="mr-2 h-4 w-4" aria-hidden="true" />Choose location</>}
                  </Button>
                ) : null}
              </div>
              {auditAnchorState.status === "unavailable" ? (
                <p className="text-xs leading-5 text-gray-500">
                  Open Vera for macOS to configure an external journal.
                </p>
              ) : null}
              {auditAnchorState.status === "managed" ? (
                <p className="text-xs leading-5 text-gray-500">
                  The launch environment controls this setting. It is read-only in Vera.
                </p>
              ) : null}
              {auditAnchorState.status === "failure" ? (
                <p role="alert" className="text-xs leading-5 text-red-700">
                  {auditAnchorState.message}
                </p>
              ) : null}
              {anchorConfiguration?.journalDirectory ||
              anchorConfiguration?.keyId ? (
                <dl className="grid min-w-0 gap-x-6 gap-y-2 text-xs sm:grid-cols-[9rem_minmax(0,1fr)]">
                  {anchorConfiguration.journalDirectory ? (
                    <>
                      <dt className="text-gray-500">Journal directory</dt>
                      <dd className="min-w-0 break-all font-mono text-gray-700">
                        {anchorConfiguration.journalDirectory}
                      </dd>
                    </>
                  ) : null}
                  {anchorConfiguration.keyId ? (
                    <>
                      <dt className="text-gray-500">Ed25519 key ID</dt>
                      <dd className="min-w-0 break-all font-mono text-gray-700">
                        {anchorConfiguration.keyId.slice(0, 24)}
                      </dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
            </div>
          </SettingRow>
        </>
      );
    }

    if (activeSection === "tools") {
      const providerLabels: Record<AletheiaLegalSourceProviderId, string> = {
        pkulaw: "北大法宝",
        yuandian: "元典",
        wolters: "威科先行",
      };
      return (
        <>
          <SectionHeader
            title="Tools & Keys"
            detail="Configuration import/export and desktop file-system actions."
          />
          <div data-testid="legal-source-settings">
            <SettingRow
              label="法律数据源"
              detail="授权适配器、端点允许列表与凭据引用由受控配置提供；Vera 仅管理本机加密密钥，不在设置页连接外部数据源，也不把候选供应商标记为已授权。"
              layout="stack"
            >
              <div className="grid min-w-0 gap-4">
                {(["pkulaw", "yuandian", "wolters"] as const).map((providerId) => {
                  const provider = legalSourceProviders.data?.find(
                    (item) => item.provider === providerId,
                  );
                  const available = Boolean(
                    provider?.encryptionEnabled &&
                      provider.endpointConfigured &&
                      provider.allowlisted &&
                      provider.credentialReferenceConfigured,
                  );
                  const busy = providerAction === providerId;
                  const stateText = legalSourceProviders.loading
                    ? "正在读取配置"
                    : legalSourceProviders.error
                      ? legalSourceProviders.error
                      : !available
                        ? "不可用"
                      : provider?.hasSecret
                        ? "已保存本地密钥"
                        : "未保存本地密钥";
                  return (
                    <div
                      key={providerId}
                      className="grid min-w-0 gap-3 border-b border-gray-200/70 pb-4 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)] sm:items-center"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">
                          {providerLabels[providerId]}
                        </p>
                        <p className={cn("mt-1 text-xs", available ? "text-gray-500" : "text-red-700")}>
                          {stateText}
                        </p>
                      </div>
                      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                        <input
                          type="password"
                          autoComplete="off"
                          aria-label={`${providerLabels[providerId]}本地密钥`}
                          value={providerSecrets[providerId]}
                          disabled={!available || busy}
                          onChange={(event) =>
                            setProviderSecrets((current) => ({
                              ...current,
                              [providerId]: event.target.value,
                            }))
                          }
                          className="h-9 min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-400"
                        />
                        <div className="flex shrink-0 gap-2">
                          <Button
                            variant="primary"
                            disabled={!available || busy || !providerSecrets[providerId].trim()}
                            onClick={() => void handleProviderSave(providerId)}
                          >
                            保存
                          </Button>
                          <Button
                            variant="danger"
                            disabled={!available || busy || !provider?.hasSecret}
                            onClick={() => void handleProviderRemove(providerId)}
                          >
                            移除
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {providerError ? (
                  <p role="alert" className="text-xs text-red-700">{providerError}</p>
                ) : null}
              </div>
            </SettingRow>
          </div>
          <SettingRow label="Settings file">
            <div className="flex justify-end gap-2">
              <Button onClick={() => exportAletheiaSettings(settings)}>
                Export
              </Button>
              <Button onClick={() => importInputRef.current?.click()}>
                Import
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(event) => {
                  void handleImportSettings(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
            </div>
          </SettingRow>
          <SettingRow label="Reset preferences">
            <Button
              variant="danger"
              disabled={settingsBusy}
              onClick={() => void resetSettings()}
            >
              Reset
            </Button>
          </SettingRow>
          <SettingRow label="Logs">
            <div className="flex items-center gap-2">
              <code className="block min-w-0 flex-1 truncate rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                {desktopInfo
                  ? "Managed by Vera desktop"
                  : "Desktop bridge unavailable"}
              </code>
              <Button
                disabled={!desktopBridge}
                onClick={() =>
                  runDesktopAction(
                    "Open logs folder",
                    desktopBridge?.openLogsDirectory,
                  )
                }
              >
                Open
              </Button>
            </div>
          </SettingRow>
        </>
      );
    }

    if (activeSection === "mcp") {
      return (
        <>
          <SectionHeader
            title="MCP"
            detail="Connectors are read from and written to the local MCP backend."
          />
          <SettingRow label="Add connector">
            <div className="grid gap-2">
              <input
                value={newMcpName}
                onChange={(event) => setNewMcpName(event.target.value)}
                placeholder="Connector name"
                className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-400"
              />
              <input
                value={newMcpUrl}
                onChange={(event) => setNewMcpUrl(event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-400"
              />
              <Button
                disabled={!newMcpName.trim() || !newMcpUrl.trim()}
                onClick={() => void handleCreateMcpConnector()}
              >
                Add
              </Button>
            </div>
          </SettingRow>
          {mcpConnectors.error ? (
            <p className="border-b border-gray-100 py-4 text-sm text-red-600">
              {mcpConnectors.error}
            </p>
          ) : null}
          {(mcpConnectors.data ?? []).map((connector) => (
            <SettingRow
              key={connector.id}
              label={connector.name}
              detail={`${connector.serverUrl} · ${connector.toolCount} tools`}
            >
              <div className="flex justify-end gap-2">
                <Toggle
                  checked={connector.enabled}
                  onChange={() => void handleMcpToggle(connector)}
                />
                <Button onClick={() => void handleMcpRefresh(connector)}>
                  Refresh
                </Button>
              </div>
            </SettingRow>
          ))}
          {!mcpConnectors.loading && (mcpConnectors.data ?? []).length === 0 ? (
            <p className="py-5 text-sm text-gray-500">
              No MCP connectors configured.
            </p>
          ) : null}
        </>
      );
    }

    if (activeSection === "gateway") {
      const gatewayOk = Boolean(gatewayHealth.data && !gatewayHealth.error);
      return (
        <>
          <SectionHeader
            title="Gateway"
            detail="Runtime status is probed from the local backend and desktop bridge."
          />
          <SettingRow label="Backend">
            <StatusPill
              tone={
                gatewayOk ? "ok" : gatewayHealth.loading ? "muted" : "error"
              }
              status={
                gatewayHealth.loading
                  ? "Checking"
                  : gatewayOk
                    ? (gatewayHealth.data?.status ?? "Ready")
                    : "Unavailable"
              }
            />
          </SettingRow>
          <SettingRow label="Storage">
            <StatusPill
              tone={desktopInfo ? "ok" : "warn"}
              status={
                desktopInfo ? "Local desktop data directory" : "Web fallback"
              }
            />
          </SettingRow>
          <SettingRow label="Refresh status">
            <Button onClick={() => void refreshRuntimeStatus()}>
              <RotateCw className="mr-2 h-3.5 w-3.5" />
              Refresh
            </Button>
          </SettingRow>
          <SettingRow label="Local services">
            <Button
              disabled={!desktopBridge}
              onClick={() =>
                runDesktopAction(
                  "Restart local services",
                  desktopBridge?.restartLocalServices,
                )
              }
            >
              Restart
            </Button>
          </SettingRow>
        </>
      );
    }

    return (
      <>
        <SectionHeader
          title="About"
          detail="Version and local runtime details."
        />
        <SettingRow label="Version">
          <span className="text-sm text-gray-700">
            {desktopInfo?.appVersion ?? "web preview"}
          </span>
        </SettingRow>
        <SettingRow label="Backend URL">
          <span className="font-mono text-xs text-gray-500">
            {desktopInfo?.backendUrl ?? getConfiguredAletheiaApiBase()}
          </span>
        </SettingRow>
        <SettingRow label="Settings state">
          <span className="inline-flex items-center gap-2 text-sm text-gray-700">
            <CheckCircle2
              className={cn(
                "h-4 w-4",
                settingsStatus === "saved"
                  ? "text-emerald-600"
                  : "text-amber-600",
              )}
            />
            {settingsStatus === "loading"
              ? "Loading from local service"
              : settingsStatus === "saving"
                ? "Saving"
                : settingsStatus === "offline"
                  ? "Offline cache · changes disabled"
                  : settingsStatus === "error"
                    ? "Save failed · previous value restored"
                    : savedAt
                      ? `Saved ${savedAt.toLocaleTimeString()}`
                      : `Synced · v${settingsDocument?.version ?? 1}`}
          </span>
        </SettingRow>
        <SettingRow label="Restart required">
          <span className="text-sm text-gray-700">
            No · client preferences apply immediately
          </span>
        </SettingRow>
      </>
    );
  }

  return (
    <section className="aletheia-settings flex min-h-full flex-col">
      <div className="aletheia-settings-header border-b border-gray-200 px-5 py-3.5 md:px-7">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-gray-500" />
              <h1 className="text-xl font-semibold leading-7 text-gray-950">
                Settings
              </h1>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {settingsStatus === "loading"
                ? "Loading preferences..."
                : settingsStatus === "saving"
                  ? "Saving preferences..."
                  : settingsStatus === "offline"
                    ? "Offline cache · reconnect to edit"
                    : settingsStatus === "error"
                      ? "Save failed · previous value restored"
                      : savedAt
                        ? `Saved ${savedAt.toLocaleTimeString()}`
                        : "Synced with local settings service"}
            </p>
          </div>
          {desktopAction ? (
            <span className="text-xs font-medium text-gray-500">
              {desktopAction}
            </span>
          ) : null}
        </div>
      </div>

      {settingsError ? (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800 md:px-8">
          {settingsError}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="aletheia-settings-sidebar border-b border-gray-200 p-2.5 lg:border-b-0 lg:border-r">
          <nav
            className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-1"
            aria-label="Settings sections"
          >
            {settingsSections.map((section) => {
              const Icon = section.icon;
              const active = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    "flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors",
                    active
                      ? "bg-white text-gray-950 shadow-[inset_0_0_0_1px_rgba(17,24,39,0.08)]"
                      : "text-gray-600 hover:bg-black/[0.035] hover:text-gray-950",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 stroke-[1.8]",
                      active ? "text-gray-950" : "text-gray-500",
                    )}
                  />
                  {section.label}
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="aletheia-settings-content min-w-0 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-5 py-6 md:px-7 lg:px-8">
            {renderSection()}
          </div>
        </main>
      </div>
    </section>
  );
}
