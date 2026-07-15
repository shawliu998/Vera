"use client";

import { useState } from "react";
import {
    AlertCircle,
    CheckCircle2,
    CircleDashed,
    Loader2,
    ShieldAlert,
} from "lucide-react";
import { useI18n, type BackendErrorDescriptor, type MessageKey } from "@/app/i18n";
import { toVeraSettingsFailure } from "@/app/contexts/VeraSettingsContext";
import {
    deleteVeraModelCredential,
    deleteVeraModelProfile,
    disableVeraModelProfile,
    enableVeraModelProfile,
    putVeraModelCredential,
    setDefaultVeraModelProfile,
    testVeraModelProfile,
    type VeraModelProfile,
    type VeraModelSettingsCapabilities,
} from "@/app/lib/veraModelSettingsApi";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { AccountSection } from "@/app/(pages)/settings/AccountSection";
import { AccountToggle } from "@/app/(pages)/settings/AccountToggle";
import {
    accountGlassButtonClassName,
    accountGlassDangerButtonClassName,
} from "@/app/(pages)/settings/accountStyles";
import { ModelCredentialForm } from "./ModelCredentialForm";
import { veraModelProviderLabel } from "./ModelProfileForm";

type Operation =
    | "test"
    | "enable"
    | "disable"
    | "default"
    | "credential"
    | "clearCredential"
    | "delete"
    | null;

export function ModelProfileCard({
    profile,
    capabilities,
    onEdit,
    onUpdated,
    onRemoved,
}: {
    profile: VeraModelProfile;
    capabilities: VeraModelSettingsCapabilities;
    onEdit: () => void;
    onUpdated: (profile: VeraModelProfile) => void;
    onRemoved: (id: string) => void;
}) {
    const { t, errorMessage, formatDate } = useI18n();
    const [operation, setOperation] = useState<Operation>(null);
    const [failure, setFailure] =
        useState<BackendErrorDescriptor | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [clearConfirm, setClearConfirm] = useState(false);
    const providerSupported = capabilities.supported_providers.includes(
        profile.provider,
    );
    const credentialReady = profile.credential.status === "configured";
    const testPassed = profile.connection_test.status === "passed";
    const canTest =
        capabilities.runtime_wired && providerSupported && credentialReady;
    const canEnable = canTest && testPassed;
    const canSetDefault = canEnable && profile.enabled;

    async function perform(
        nextOperation: Exclude<Operation, null>,
        action: () => Promise<VeraModelProfile>,
        reportFailure = true,
    ) {
        if (operation) return;
        setOperation(nextOperation);
        setFailure(null);
        try {
            onUpdated(await action());
        } catch (error) {
            if (reportFailure) setFailure(toVeraSettingsFailure(error));
            throw error;
        } finally {
            setOperation(null);
        }
    }

    async function remove() {
        if (operation) return;
        setOperation("delete");
        setFailure(null);
        try {
            await deleteVeraModelProfile(profile.id);
            onRemoved(profile.id);
        } catch (error) {
            setFailure(toVeraSettingsFailure(error));
        } finally {
            setOperation(null);
        }
    }

    return (
        <AccountSection>
            <div className="space-y-5 px-4 py-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-base font-medium text-gray-900 dark:text-gray-100">
                                {profile.name}
                            </h3>
                            {profile.is_default && (
                                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                                    {t("settings.models.default")}
                                </span>
                            )}
                        </div>
                        <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
                            {veraModelProviderLabel(profile.provider, t)} · {profile.model}
                        </p>
                        {profile.endpoint_binding.canonical_origin && (
                            <p className="mt-1 truncate text-xs text-gray-400">
                                {profile.endpoint_binding.canonical_origin}
                            </p>
                        )}
                    </div>
                    <AccountToggle
                        checked={profile.enabled}
                        loading={
                            operation === "enable" || operation === "disable"
                        }
                        disabled={
                            operation !== null ||
                            (!profile.enabled && !canEnable)
                        }
                        label={
                            profile.enabled
                                ? t("settings.models.enabled")
                                : t("settings.models.disabled")
                        }
                        size="md"
                        onChange={(next) =>
                            void perform(
                                next ? "enable" : "disable",
                                () =>
                                    next
                                        ? enableVeraModelProfile(profile.id)
                                        : disableVeraModelProfile(profile.id),
                            ).catch(() => undefined)
                        }
                    />
                </div>

                {!providerSupported && (
                    <StatusNotice
                        icon={<ShieldAlert className="h-4 w-4" />}
                        tone="warning"
                        text={t("settings.models.unsupportedProvider")}
                    />
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                    <StatusTile
                        label={t("settings.models.credential.title")}
                        value={t(credentialStatusKey(profile.credential.status))}
                        tone={credentialReady ? "success" : "warning"}
                    />
                    <StatusTile
                        label={t("settings.models.connection.title")}
                        value={t(connectionStatusKey(profile.connection_test.status))}
                        tone={testPassed ? "success" : "neutral"}
                        detail={
                            profile.connection_test.tested_at
                                ? formatDate(profile.connection_test.tested_at, {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                  })
                                : undefined
                        }
                    />
                </div>

                {profile.connection_test.error_code && (
                    <StatusNotice
                        icon={<AlertCircle className="h-4 w-4" />}
                        tone="danger"
                        text={errorMessage({
                            code: profile.connection_test.error_code,
                        })}
                    />
                )}

                <div className="flex flex-wrap items-center gap-2 border-y border-gray-200 py-3 dark:border-white/10">
                    <button
                        type="button"
                        disabled={operation !== null}
                        onClick={onEdit}
                        className={accountGlassButtonClassName}
                    >
                        {t("common.actions.edit")}
                    </button>
                    <button
                        type="button"
                        disabled={operation !== null || !canTest}
                        onClick={() =>
                            void perform("test", () =>
                                testVeraModelProfile(profile.id),
                            ).catch(() => undefined)
                        }
                        className={`${accountGlassButtonClassName} inline-flex items-center gap-1.5`}
                    >
                        {operation === "test" && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {t("settings.models.test")}
                    </button>
                    <button
                        type="button"
                        disabled={
                            operation !== null ||
                            profile.is_default ||
                            !canSetDefault
                        }
                        onClick={() =>
                            void perform("default", () =>
                                setDefaultVeraModelProfile(profile.id),
                            ).catch(() => undefined)
                        }
                        className={accountGlassButtonClassName}
                    >
                        {t("settings.models.setDefault")}
                    </button>
                    <button
                        type="button"
                        disabled={operation !== null}
                        onClick={() => setDeleteConfirm(true)}
                        className={`${accountGlassDangerButtonClassName} sm:ml-auto`}
                    >
                        {t("common.actions.delete")}
                    </button>
                </div>

                {capabilities.credential_write_enabled ? (
                    <div className="space-y-3">
                        <ModelCredentialForm
                            profileId={profile.id}
                            disabled={operation !== null}
                            onStore={async (secret) => {
                                await perform(
                                    "credential",
                                    () =>
                                        putVeraModelCredential(
                                            profile.id,
                                            secret,
                                        ),
                                    false,
                                );
                            }}
                        />
                        {profile.credential.status !== "missing" && (
                            <button
                                type="button"
                                disabled={operation !== null}
                                onClick={() => setClearConfirm(true)}
                                className={accountGlassDangerButtonClassName}
                            >
                                {t("settings.models.credential.clear")}
                            </button>
                        )}
                    </div>
                ) : (
                    <StatusNotice
                        icon={<ShieldAlert className="h-4 w-4" />}
                        tone="warning"
                        text={t("settings.models.credential.unavailable")}
                    />
                )}

                {!capabilities.runtime_wired && (
                    <StatusNotice
                        icon={<CircleDashed className="h-4 w-4" />}
                        tone="neutral"
                        text={t("settings.models.runtimeUnavailable")}
                    />
                )}

                {failure && (
                    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                        {errorMessage(failure)}
                    </p>
                )}
            </div>

            <ConfirmPopup
                open={deleteConfirm}
                title={t("settings.models.deleteConfirm.title")}
                message={t("settings.models.deleteConfirm.body", {
                    name: profile.name,
                })}
                confirmLabel={t("common.actions.delete")}
                cancelLabel={t("common.actions.cancel")}
                confirmDisabled={operation !== null}
                onCancel={() => setDeleteConfirm(false)}
                onConfirm={() => {
                    setDeleteConfirm(false);
                    void remove();
                }}
            />
            <ConfirmPopup
                open={clearConfirm}
                title={t("settings.models.credential.clearConfirmTitle")}
                message={t("settings.models.credential.clearConfirmBody")}
                confirmLabel={t("settings.models.credential.clear")}
                cancelLabel={t("common.actions.cancel")}
                confirmDisabled={operation !== null}
                onCancel={() => setClearConfirm(false)}
                onConfirm={() => {
                    setClearConfirm(false);
                    void perform("clearCredential", () =>
                        deleteVeraModelCredential(profile.id),
                    ).catch(() => undefined);
                }}
            />
        </AccountSection>
    );
}

function StatusTile({
    label,
    value,
    detail,
    tone,
}: {
    label: string;
    value: string;
    detail?: string;
    tone: "success" | "warning" | "neutral";
}) {
    return (
        <div className="rounded-lg bg-gray-50 px-3 py-3 dark:bg-white/5">
            <p className="text-xs text-gray-400">{label}</p>
            <div className="mt-1 flex items-center gap-1.5">
                {tone === "success" ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : tone === "warning" ? (
                    <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                ) : (
                    <CircleDashed className="h-3.5 w-3.5 text-gray-400" />
                )}
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {value}
                </span>
            </div>
            {detail && <p className="mt-1 text-xs text-gray-400">{detail}</p>}
        </div>
    );
}

function StatusNotice({
    icon,
    text,
    tone,
}: {
    icon: React.ReactNode;
    text: string;
    tone: "warning" | "danger" | "neutral";
}) {
    const colors = {
        warning:
            "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300",
        danger: "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300",
        neutral: "bg-gray-50 text-gray-600 dark:bg-white/5 dark:text-gray-300",
    } as const;
    return (
        <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${colors[tone]}`}>
            <span className="mt-0.5 shrink-0">{icon}</span>
            <span>{text}</span>
        </div>
    );
}

function credentialStatusKey(
    status: VeraModelProfile["credential"]["status"],
): MessageKey {
    return {
        configured: "settings.models.credential.configured",
        missing: "settings.models.credential.missing",
        invalid: "settings.models.credential.invalid",
    }[status] as MessageKey;
}

function connectionStatusKey(
    status: VeraModelProfile["connection_test"]["status"],
): MessageKey {
    return {
        untested: "settings.models.connection.untested",
        passed: "settings.models.connection.passed",
        failed: "settings.models.connection.failed",
        stale: "settings.models.connection.stale",
    }[status] as MessageKey;
}
