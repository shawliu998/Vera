"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import {
    getEpoOpsCredentialStatus,
    isMfaRequiredError,
    removeEpoOpsCredentials,
    saveEpoOpsCredentials,
    type EpoOpsCredentialStatus,
} from "@/app/lib/mikeApi";
import {
    accountGlassIconButtonClassName,
    accountGlassInputClassName,
} from "../accountStyles";
import { AccountSection } from "../AccountSection";

const MODEL_API_KEY_FIELDS = [
    {
        provider: "claude",
        label: "Anthropic (Claude) API Key",
        placeholder: "sk-ant-...",
    },
    {
        provider: "gemini",
        label: "Google (Gemini) API Key",
        placeholder: "AI...",
    },
    {
        provider: "openai",
        label: "OpenAI API Key",
        placeholder: "sk-...",
    },
    {
        provider: "deepseek",
        label: "DeepSeek API Key",
        placeholder: "sk-...",
    },
    {
        provider: "kimi",
        label: "Kimi API Key",
        placeholder: "sk-...",
    },
    {
        provider: "zhipu",
        label: "Zhipu GLM API Key",
        placeholder: "智谱开放平台 API Key",
    },
    {
        provider: "openrouter",
        label: "OpenRouter API Key",
        placeholder: "sk-or-...",
    },
] as const;

const OTHER_API_KEY_FIELDS = [
    {
        provider: "courtlistener",
        label: "CourtListener API Key",
        placeholder: "Token...",
        description:
            "Add a CourtListener API key if you want the latest CourtListener data. Otherwise, Vera will use the configured bulk data source.",
    },
] as const;

export default function ApiKeysPage() {
    const { profile, updateApiKey } = useUserProfile();

    return (
        <div>
            <h2 className="mb-3 text-2xl font-medium font-serif text-gray-900">
                API Keys
            </h2>
            <p className="text-sm text-gray-500 mb-4">
                Add the API keys you use with Vera.
            </p>
            <AccountSection>
                {MODEL_API_KEY_FIELDS.map((field, index) => (
                    <div key={field.provider}>
                        <ApiKeyField
                            label={field.label}
                            placeholder={field.placeholder}
                            hasSavedKey={
                                !!profile?.apiKeys[field.provider].configured
                            }
                            isServerConfigured={
                                profile?.apiKeys[field.provider].source ===
                                "env"
                            }
                            onSave={(value) =>
                                updateApiKey(
                                    field.provider,
                                    value.trim() || null,
                                )
                            }
                            onRemove={() => updateApiKey(field.provider, null)}
                        />
                        {index < MODEL_API_KEY_FIELDS.length - 1 && (
                            <div className="mx-4 h-px bg-gray-200" />
                        )}
                    </div>
                ))}
            </AccountSection>

            <AccountSection className="mt-8">
                {OTHER_API_KEY_FIELDS.map((field) => (
                    <ApiKeyField
                        key={field.provider}
                        label={field.label}
                        description={field.description}
                        placeholder={field.placeholder}
                        hasSavedKey={
                            !!profile?.apiKeys[field.provider].configured
                        }
                        isServerConfigured={
                            profile?.apiKeys[field.provider].source === "env"
                        }
                        onSave={(value) =>
                            updateApiKey(field.provider, value.trim() || null)
                        }
                        onRemove={() => updateApiKey(field.provider, null)}
                    />
                ))}
            </AccountSection>

            <AccountSection className="mt-8">
                <EpoOpsCredentialField />
            </AccountSection>
        </div>
    );
}

function EpoOpsCredentialField() {
    const [status, setStatus] = useState<EpoOpsCredentialStatus | null>(null);
    const [consumerKey, setConsumerKey] = useState("");
    const [consumerSecret, setConsumerSecret] = useState("");
    const [revealKey, setRevealKey] = useState(false);
    const [revealSecret, setRevealSecret] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [pendingMfaAction, setPendingMfaAction] = useState<
        "save" | "remove" | null
    >(null);

    useEffect(() => {
        let cancelled = false;
        void getEpoOpsCredentialStatus()
            .then((nextStatus) => {
                if (!cancelled) setStatus(nextStatus);
            })
            .catch(() => {
                if (!cancelled) setLoadError(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const isServerConfigured = status?.source === "env";
    const dirty =
        consumerKey.trim().length > 0 && consumerSecret.trim().length > 0;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaAction("save");
                return;
            }
            const nextStatus = await saveEpoOpsCredentials({
                consumerKey: consumerKey.trim(),
                consumerSecret: consumerSecret.trim(),
            });
            setStatus(nextStatus);
            setConsumerKey("");
            setConsumerSecret("");
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingMfaAction("save");
            } else {
                alert(
                    error instanceof Error && error.message
                        ? `Failed to save EPO OPS credentials: ${error.message}`
                        : "Failed to save EPO OPS credentials.",
                );
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemove = async () => {
        setIsSaving(true);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaAction("remove");
                return;
            }
            setStatus(await removeEpoOpsCredentials());
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingMfaAction("remove");
            } else {
                alert(
                    error instanceof Error && error.message
                        ? `Failed to remove EPO OPS credentials: ${error.message}`
                        : "Failed to remove EPO OPS credentials.",
                );
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleMfaVerified = async () => {
        const action = pendingMfaAction;
        setPendingMfaAction(null);
        if (action === "save") {
            await handleSave();
        } else if (action === "remove") {
            await handleRemove();
        }
    };

    return (
        <>
            <div className="px-4 py-5">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-gray-700">
                        EPO Open Patent Services (OPS)
                    </h3>
                    {status?.configured && (
                        <span className="text-xs text-emerald-700">
                            {isServerConfigured
                                ? "Configured by server"
                                : "Credentials saved"}
                        </span>
                    )}
                </div>
                <p className="mb-3 text-sm leading-5 text-gray-500">
                    Required for Patent Prior Art Acquisition. Vera sends only
                    the Work Task&apos;s fixed query, jurisdiction, date and bounded
                    pagination fields to EPO OPS.
                </p>
                {loadError ? (
                    <p className="text-sm text-red-600">
                        Could not load the EPO OPS credential status.
                    </p>
                ) : (
                    <div className="space-y-3">
                        <SecretCredentialInput
                            id="epo-ops-consumer-key"
                            label="Consumer key"
                            value={consumerKey}
                            onChange={setConsumerKey}
                            reveal={revealKey}
                            onRevealChange={setRevealKey}
                            placeholder={
                                isServerConfigured
                                    ? "Server .env credentials configured"
                                    : status?.configured
                                      ? "Saved consumer key hidden"
                                      : "EPO OPS consumer key"
                            }
                            disabled={isServerConfigured || status === null}
                        />
                        <SecretCredentialInput
                            id="epo-ops-consumer-secret"
                            label="Consumer secret"
                            value={consumerSecret}
                            onChange={setConsumerSecret}
                            reveal={revealSecret}
                            onRevealChange={setRevealSecret}
                            placeholder={
                                isServerConfigured
                                    ? "Server .env credentials configured"
                                    : status?.configured
                                      ? "Saved consumer secret hidden"
                                      : "EPO OPS consumer secret"
                            }
                            disabled={isServerConfigured || status === null}
                        />
                        <div className="flex flex-wrap justify-end gap-2">
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={
                                    isServerConfigured ||
                                    status === null ||
                                    isSaving ||
                                    !dirty ||
                                    saved
                                }
                                className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                            >
                                {isSaving
                                    ? "Saving..."
                                    : saved
                                      ? "Saved"
                                      : "Save"}
                            </button>
                            {status?.configured && !isServerConfigured && (
                                <button
                                    type="button"
                                    onClick={handleRemove}
                                    disabled={isSaving}
                                    className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                                >
                                    Remove
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
            <MfaVerificationPopup
                open={!!pendingMfaAction}
                onCancel={() => setPendingMfaAction(null)}
                onVerified={() => void handleMfaVerified()}
            />
        </>
    );
}

function SecretCredentialInput({
    id,
    label,
    value,
    onChange,
    reveal,
    onRevealChange,
    placeholder,
    disabled,
}: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    reveal: boolean;
    onRevealChange: (reveal: boolean) => void;
    placeholder: string;
    disabled: boolean;
}) {
    return (
        <div>
            <label
                htmlFor={id}
                className="mb-2 block text-xs font-medium text-gray-600"
            >
                {label}
            </label>
            <div className="relative">
                <Input
                    id={id}
                    type={reveal ? "text" : "password"}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    placeholder={placeholder}
                    className={`pr-10 ${accountGlassInputClassName}`}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                />
                {value.length > 0 && (
                    <button
                        type="button"
                        onClick={() => onRevealChange(!reveal)}
                        disabled={disabled}
                        className={`absolute inset-y-1 right-1.5 flex items-center ${accountGlassIconButtonClassName}`}
                        aria-label={reveal ? `Hide ${label}` : `Show ${label}`}
                    >
                        {reveal ? (
                            <EyeOff className="h-4 w-4" />
                        ) : (
                            <Eye className="h-4 w-4" />
                        )}
                    </button>
                )}
            </div>
        </div>
    );
}

function ApiKeyField({
    label,
    description,
    placeholder,
    hasSavedKey,
    isServerConfigured,
    onSave,
    onRemove,
}: {
    label: string;
    description?: string;
    placeholder: string;
    hasSavedKey: boolean;
    isServerConfigured: boolean;
    onSave: (value: string) => Promise<boolean>;
    onRemove: () => Promise<boolean>;
}) {
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [pendingMfaAction, setPendingMfaAction] = useState<
        "save" | "remove" | null
    >(null);

    useEffect(() => {
        setValue("");
    }, [hasSavedKey]);

    const dirty = value.trim().length > 0;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaAction("save");
                return;
            }
            const ok = await onSave(value);
            if (ok) {
                setValue("");
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            } else {
                alert(`Failed to save ${label}.`);
            }
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingMfaAction("save");
            } else {
                alert(
                    error instanceof Error && error.message
                        ? `Failed to save ${label}: ${error.message}`
                        : `Failed to save ${label}.`,
                );
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemove = async () => {
        setIsSaving(true);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaAction("remove");
                return;
            }
            const ok = await onRemove();
            if (!ok) alert(`Failed to remove ${label}.`);
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingMfaAction("remove");
            } else {
                alert(
                    error instanceof Error && error.message
                        ? `Failed to remove ${label}: ${error.message}`
                        : `Failed to remove ${label}.`,
                );
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleMfaVerified = async () => {
        const action = pendingMfaAction;
        setPendingMfaAction(null);
        if (action === "save") {
            await handleSave();
        } else if (action === "remove") {
            await handleRemove();
        }
    };

    return (
        <>
            <div className="px-4 py-5">
                <label className="text-sm font-medium text-gray-700 block mb-2">
                    {label}
                </label>
                {description && (
                    <p className="text-sm text-gray-500 mb-3">{description}</p>
                )}
                <div className="space-y-2">
                    <div className="relative flex-1">
                        <Input
                            type={reveal ? "text" : "password"}
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            placeholder={
                                isServerConfigured
                                    ? "Server .env key configured"
                                    : hasSavedKey
                                      ? "Saved key hidden"
                                      : placeholder
                            }
                            className={`pr-10 ${accountGlassInputClassName}`}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={isServerConfigured}
                        />
                        {dirty && (
                            <button
                                type="button"
                                onClick={() => setReveal((r) => !r)}
                                disabled={isServerConfigured}
                                className={`absolute inset-y-1 right-1.5 flex items-center ${accountGlassIconButtonClassName}`}
                                aria-label={reveal ? "Hide key" : "Show key"}
                            >
                                {reveal ? (
                                    <EyeOff className="h-4 w-4" />
                                ) : (
                                    <Eye className="h-4 w-4" />
                                )}
                            </button>
                        )}
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={
                                isServerConfigured ||
                                isSaving ||
                                !dirty ||
                                saved
                            }
                            className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                        >
                            {isSaving ? (
                                "Saving..."
                            ) : saved ? (
                                "Saved"
                            ) : (
                                "Save"
                            )}
                        </button>
                        {hasSavedKey && !isServerConfigured && (
                            <button
                                type="button"
                                onClick={handleRemove}
                                disabled={isSaving}
                                className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                            >
                                Remove
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <MfaVerificationPopup
                open={!!pendingMfaAction}
                onCancel={() => setPendingMfaAction(null)}
                onVerified={() => void handleMfaVerified()}
            />
        </>
    );
}
