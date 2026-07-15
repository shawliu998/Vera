"use client";

import { useEffect, useState } from "react";
import {
  ArchiveRestore,
  Download,
  FileSearch,
  FolderOpen,
  HardDrive,
  Loader2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useI18n, type MessageKey } from "@/app/i18n";
import { AccountSection } from "../AccountSection";
import {
  accountGlassButtonClassName,
  accountGlassPrimaryButtonClassName,
} from "../accountStyles";

type Action =
  | "data"
  | "logs"
  | "backup"
  | "inspect"
  | "restore"
  | "diagnostics";

type Notice = {
  tone: "success" | "warning" | "error";
  message: string;
  detail?: string;
};

function bytesLabel(value: number | undefined, locale: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: value >= 1_048_576 ? "megabyte" : "kilobyte",
    maximumFractionDigits: 1,
  }).format(
    value >= 1_048_576 ? value / 1_048_576 : Math.max(value / 1_024, 0),
  );
}

export default function LocalDataSettingsPage() {
  const { t, locale } = useI18n();
  const [desktopInfo, setDesktopInfo] = useState<AletheiaDesktopInfo | null>(
    null,
  );
  const [desktopAvailable, setDesktopAvailable] = useState<boolean | null>(
    null,
  );
  const [pending, setPending] = useState<Action | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [backupChecked, setBackupChecked] = useState(false);
  const [restoreComplete, setRestoreComplete] = useState(false);

  useEffect(() => {
    let active = true;
    const bridge = window.aletheiaDesktop;
    setDesktopAvailable(Boolean(bridge));
    if (!bridge) return () => undefined;
    void bridge
      .getInfo()
      .then((info) => {
        if (active) setDesktopInfo(info);
      })
      .catch(() => {
        if (active) setDesktopInfo(null);
      });
    return () => {
      active = false;
    };
  }, []);

  async function run(
    action: Action,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (pending) return;
    setPending(action);
    setNotice(null);
    try {
      await operation();
    } catch {
      setNotice({ tone: "error", message: t("settings.data.errors.action") });
    } finally {
      setPending(null);
    }
  }

  const bridge = desktopAvailable ? window.aletheiaDesktop : undefined;
  const button = (action: Action, label: MessageKey, operation: () => void) => (
    <button
      type="button"
      disabled={!bridge || pending !== null}
      onClick={operation}
      className={accountGlassButtonClassName}
    >
      {pending === action && (
        <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
      )}
      {t(label)}
    </button>
  );

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="font-serif text-2xl font-medium text-gray-900 dark:text-gray-100">
            {t("settings.data.title")}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t("settings.data.description")}
          </p>
        </div>

        <AccountSection>
          <DataRow
            icon={<HardDrive className="h-4 w-4" />}
            title={t("settings.data.storage.title")}
            description={t("settings.data.storage.description")}
            status={
              desktopInfo ? t("settings.data.storage.localOnly") : undefined
            }
          >
            {button("data", "settings.data.storage.open", () =>
              void run("data", async () => {
                await bridge!.openDataDirectory();
                setNotice({
                  tone: "success",
                  message: t("settings.data.storage.opened"),
                });
              }),
            )}
          </DataRow>
          <Divider />
          <DataRow
            icon={<ShieldCheck className="h-4 w-4" />}
            title={t("settings.data.encryption.title")}
            description={t("settings.data.encryption.description")}
            status={
              desktopInfo
                ? desktopInfo.databaseEncryption === "sqlcipher_required"
                  ? t("settings.data.encryption.sqlcipher")
                  : t("settings.data.encryption.development")
                : undefined
            }
          />
        </AccountSection>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl font-medium text-gray-900 dark:text-gray-100">
          {t("settings.data.backup.title")}
        </h2>
        <AccountSection>
          <DataRow
            icon={<Download className="h-4 w-4" />}
            title={t("settings.data.backup.create")}
            description={t("settings.data.backup.createDescription")}
          >
            {button("backup", "settings.data.backup.createAction", () =>
              void run("backup", async () => {
                const result = await bridge!.createEncryptedBackup();
                if (result.canceled) {
                  setNotice({
                    tone: "warning",
                    message: t("settings.data.cancelled"),
                  });
                  return;
                }
                if (!result.saved) throw new Error("backup not saved");
                const size = bytesLabel(result.bytes, locale);
                setNotice({
                  tone: "success",
                  message: t("settings.data.backup.created"),
                  ...(size ? { detail: size } : {}),
                });
              }),
            )}
          </DataRow>
          <Divider />
          <DataRow
            icon={<FileSearch className="h-4 w-4" />}
            title={t("settings.data.backup.inspect")}
            description={t("settings.data.backup.inspectDescription")}
          >
            {button("inspect", "settings.data.backup.inspectAction", () =>
              void run("inspect", async () => {
                setBackupChecked(false);
                const result = await bridge!.inspectEncryptedBackup();
                if (result.canceled) {
                  setNotice({
                    tone: "warning",
                    message: t("settings.data.cancelled"),
                  });
                  return;
                }
                if (!result.ok) {
                  setNotice({
                    tone: "error",
                    message: t("settings.data.backup.checkFailed"),
                  });
                  return;
                }
                setBackupChecked(true);
                setNotice({
                  tone: "success",
                  message: t("settings.data.backup.checkPassed"),
                });
              }),
            )}
          </DataRow>
          <Divider />
          <DataRow
            icon={<ArchiveRestore className="h-4 w-4" />}
            title={t("settings.data.backup.restore")}
            description={t("settings.data.backup.restoreDescription")}
          >
            <button
              type="button"
              disabled={!bridge || !backupChecked || pending !== null}
              onClick={() =>
                void run("restore", async () => {
                  const result = await bridge!.restoreEncryptedBackup();
                  if (result.canceled) {
                    setNotice({
                      tone: "warning",
                      message: t("settings.data.cancelled"),
                    });
                    return;
                  }
                  if (!result.restored) throw new Error("restore failed");
                  setBackupChecked(false);
                  setRestoreComplete(true);
                  setNotice({
                    tone: "success",
                    message: t("settings.data.backup.restored"),
                  });
                })
              }
              className={accountGlassButtonClassName}
            >
              {pending === "restore" && (
                <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
              )}
              {t("settings.data.backup.restoreAction")}
            </button>
          </DataRow>
        </AccountSection>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl font-medium text-gray-900 dark:text-gray-100">
          {t("settings.data.diagnostics.title")}
        </h2>
        <AccountSection>
          <DataRow
            icon={<FolderOpen className="h-4 w-4" />}
            title={t("settings.data.diagnostics.logs")}
            description={t("settings.data.diagnostics.logsDescription")}
          >
            {button("logs", "settings.data.diagnostics.openLogs", () =>
              void run("logs", async () => {
                await bridge!.openLogsDirectory();
                setNotice({
                  tone: "success",
                  message: t("settings.data.diagnostics.logsOpened"),
                });
              }),
            )}
          </DataRow>
          <Divider />
          <DataRow
            icon={<FileSearch className="h-4 w-4" />}
            title={t("settings.data.diagnostics.export")}
            description={t("settings.data.diagnostics.exportDescription")}
          >
            {button(
              "diagnostics",
              "settings.data.diagnostics.exportAction",
              () =>
                void run("diagnostics", async () => {
                  const result = await bridge!.exportDiagnosticBundle();
                  if (result.canceled) {
                    setNotice({
                      tone: "warning",
                      message: t("settings.data.cancelled"),
                    });
                    return;
                  }
                  if (!result.saved) throw new Error("diagnostics not saved");
                  const size = bytesLabel(result.bytes, locale);
                  setNotice({
                    tone: "success",
                    message: t("settings.data.diagnostics.exported"),
                    ...(size ? { detail: size } : {}),
                  });
                }),
            )}
          </DataRow>
        </AccountSection>
      </section>

      {desktopAvailable === false && (
        <NoticeBox
          notice={{
            tone: "error",
            message: t("settings.data.errors.desktopOnly"),
          }}
        />
      )}
      {notice && <NoticeBox notice={notice} />}
      {restoreComplete && (
        <button
          type="button"
          className={accountGlassPrimaryButtonClassName}
          onClick={() => window.location.assign("/assistant")}
        >
          <RotateCcw className="mr-1.5 inline h-3.5 w-3.5" />
          {t("settings.data.backup.openRestored")}
        </button>
      )}
    </div>
  );
}

function DataRow({
  icon,
  title,
  description,
  status,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 text-gray-500 dark:text-gray-400">{icon}</span>
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {title}
          </p>
          <p className="mt-1 max-w-xl text-xs leading-5 text-gray-500 dark:text-gray-400">
            {description}
          </p>
          {status && (
            <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {status}
            </p>
          )}
        </div>
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

function Divider() {
  return <div className="mx-4 h-px bg-gray-200 dark:bg-white/10" />;
}

function NoticeBox({ notice }: { notice: Notice }) {
  const color =
    notice.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
      : notice.tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
        : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300";
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 text-sm ${color}`}
    >
      <p className="font-medium">{notice.message}</p>
      {notice.detail && <p className="mt-1 text-xs opacity-80">{notice.detail}</p>}
    </div>
  );
}
