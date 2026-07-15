"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleX,
  Database,
  KeyRound,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Scale,
  ShieldCheck,
} from "lucide-react";
import {
  useI18n,
  type BackendErrorDescriptor,
  type MessageKey,
} from "@/app/i18n";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import {
  submitVeraCredentialInput,
  VeraCredentialInputError,
} from "@/app/components/models/modelCredentialSubmission";
import { VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS } from "@/app/lib/veraCredentialLimits";
import {
  VeraLegalSourceApiError,
  listVeraLegalSourceProviders,
  removeVeraLegalSourceSecret,
  saveVeraLegalSourceSecret,
  type VeraLegalSourceDataUsePolicy,
  type VeraLegalSourceProvider,
  type VeraLegalSourceProviderId,
  type VeraLegalSourceUnavailableReason,
} from "@/app/lib/veraLegalSourceApi";
import { AccountSection } from "../AccountSection";
import {
  accountGlassButtonClassName,
  accountGlassDangerButtonClassName,
  accountGlassInputClassName,
  accountGlassPrimaryButtonClassName,
} from "../accountStyles";

type LoadState = "loading" | "ready" | "error";
type CredentialOperation = {
  provider: VeraLegalSourceProviderId;
  kind: "save" | "remove";
};
type ProviderFeedback = {
  provider: VeraLegalSourceProviderId;
  kind: "saved" | "removed" | "saved_refresh_failed" | "removed_refresh_failed";
};
type ProviderFailure = {
  provider: VeraLegalSourceProviderId;
  error: BackendErrorDescriptor;
};

const PROVIDER_NAME_KEYS = {
  pkulaw: "settings.legalSources.providers.pkulaw",
  wolters: "settings.legalSources.providers.wolters",
} as const satisfies Record<VeraLegalSourceProviderId, MessageKey>;

type DataUseValue =
  VeraLegalSourceDataUsePolicy[keyof VeraLegalSourceDataUsePolicy];

const DATA_USE_VALUE_KEYS = {
  not_declared: "settings.legalSources.policy.values.notDeclared",
  deployment_contract: "settings.legalSources.policy.values.deploymentContract",
  no_retention: "settings.legalSources.policy.values.noRetention",
  metadata_only: "settings.legalSources.policy.values.metadataOnly",
  full_text_ttl: "settings.legalSources.policy.values.fullTextTtl",
  full_text_permitted: "settings.legalSources.policy.values.fullTextPermitted",
  prohibited: "settings.legalSources.policy.values.prohibited",
  exact_quotes_only: "settings.legalSources.policy.values.exactQuotesOnly",
  reviewed_work_product:
    "settings.legalSources.policy.values.reviewedWorkProduct",
  permitted: "settings.legalSources.policy.values.permitted",
  local_only: "settings.legalSources.policy.values.localOnly",
} as const satisfies Record<DataUseValue, MessageKey>;

const UNAVAILABLE_REASON_KEYS = {
  endpoint_missing: "settings.legalSources.status.reasons.endpointMissing",
  endpoint_not_allowlisted:
    "settings.legalSources.status.reasons.endpointNotAllowlisted",
  credential_reference_missing:
    "settings.legalSources.status.reasons.credentialReferenceMissing",
  activation_gate_closed:
    "settings.legalSources.status.reasons.activationGateClosed",
  credential_unavailable:
    "settings.legalSources.status.reasons.credentialUnavailable",
  secret_storage_unavailable:
    "settings.legalSources.status.reasons.secretStorageUnavailable",
} as const satisfies Record<VeraLegalSourceUnavailableReason, MessageKey>;

const FEEDBACK_KEYS = {
  saved: "settings.legalSources.credential.saved",
  removed: "settings.legalSources.credential.removed",
  saved_refresh_failed: "settings.legalSources.credential.savedRefreshFailed",
  removed_refresh_failed:
    "settings.legalSources.credential.removedRefreshFailed",
} as const satisfies Record<ProviderFeedback["kind"], MessageKey>;

function credentialActionsReady(provider: VeraLegalSourceProvider): boolean {
  return provider.deploymentReady && provider.encryptionEnabled;
}

function safeFailure(error: unknown): BackendErrorDescriptor {
  if (error instanceof VeraLegalSourceApiError) {
    return { code: error.code, status: error.status };
  }
  if (error instanceof VeraCredentialInputError) {
    return { code: "VALIDATION_ERROR" };
  }
  return { code: "NETWORK_ERROR" };
}

export default function LegalSourceSettingsPage() {
  const { t, errorMessage } = useI18n();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [providers, setProviders] = useState<
    readonly VeraLegalSourceProvider[]
  >([]);
  const [loadFailure, setLoadFailure] = useState<BackendErrorDescriptor | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [operation, setOperation] = useState<CredentialOperation | null>(null);
  const [providerFailure, setProviderFailure] =
    useState<ProviderFailure | null>(null);
  const [feedback, setFeedback] = useState<ProviderFeedback | null>(null);
  const [removeConfirmProvider, setRemoveConfirmProvider] =
    useState<VeraLegalSourceProviderId | null>(null);
  const requestSequence = useRef(0);
  const mounted = useRef(false);
  const hasLoaded = useRef(false);

  const loadProviders = useCallback(
    async (showLoading: boolean): Promise<boolean> => {
      const sequence = ++requestSequence.current;
      if (showLoading) setLoadState("loading");
      setRefreshing(true);
      setLoadFailure(null);
      try {
        const response = await listVeraLegalSourceProviders();
        if (!mounted.current || sequence !== requestSequence.current) {
          return false;
        }
        hasLoaded.current = true;
        setProviders(response.providers);
        setLoadState("ready");
        return true;
      } catch (error) {
        if (!mounted.current || sequence !== requestSequence.current) {
          return false;
        }
        setLoadFailure(safeFailure(error));
        if (!hasLoaded.current) setLoadState("error");
        return false;
      } finally {
        if (mounted.current && sequence === requestSequence.current) {
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    mounted.current = true;
    void loadProviders(true);
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [loadProviders]);

  async function saveCredential(
    provider: VeraLegalSourceProvider,
    field: Pick<HTMLInputElement, "value">,
  ) {
    if (operation || refreshing || !credentialActionsReady(provider)) return;
    setOperation({ provider: provider.provider, kind: "save" });
    setProviderFailure(null);
    setFeedback(null);
    try {
      await submitVeraCredentialInput(
        field,
        (secret) => saveVeraLegalSourceSecret(provider.provider, secret),
        {
          maxCharacters: VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS,
        },
      );
      const refreshed = await loadProviders(false);
      if (!mounted.current) return;
      setFeedback({
        provider: provider.provider,
        kind: refreshed ? "saved" : "saved_refresh_failed",
      });
    } catch (error) {
      if (!mounted.current) return;
      setProviderFailure({
        provider: provider.provider,
        error: safeFailure(error),
      });
    } finally {
      field.value = "";
      if (mounted.current) setOperation(null);
    }
  }

  async function removeCredential(provider: VeraLegalSourceProvider) {
    if (operation || refreshing || !provider.hasSecret) {
      return;
    }
    setOperation({ provider: provider.provider, kind: "remove" });
    setProviderFailure(null);
    setFeedback(null);
    try {
      await removeVeraLegalSourceSecret(provider.provider);
      if (!mounted.current) return;
      setRemoveConfirmProvider(null);
      const refreshed = await loadProviders(false);
      if (!mounted.current) return;
      setFeedback({
        provider: provider.provider,
        kind: refreshed ? "removed" : "removed_refresh_failed",
      });
    } catch (error) {
      if (!mounted.current) return;
      setProviderFailure({
        provider: provider.provider,
        error: safeFailure(error),
      });
    } finally {
      if (mounted.current) setOperation(null);
    }
  }

  const removeTarget = providers.find(
    (provider) => provider.provider === removeConfirmProvider,
  );

  if (loadState === "loading") {
    return (
      <PageState
        icon={<Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
        title={t("common.status.loading")}
        body={t("settings.legalSources.loading")}
      />
    );
  }

  if (loadState === "error") {
    return (
      <PageState
        role="alert"
        icon={
          <AlertCircle className="h-5 w-5 text-red-500" aria-hidden="true" />
        }
        title={t("settings.legalSources.errors.loadTitle")}
        body={errorMessage(loadFailure)}
        action={
          <button
            type="button"
            onClick={() => void loadProviders(true)}
            className={accountGlassButtonClassName}
          >
            {t("common.actions.retry")}
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-serif text-2xl font-medium text-gray-900 dark:text-gray-100">
            {t("settings.legalSources.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            {t("settings.legalSources.description")}
          </p>
        </div>
        <button
          type="button"
          disabled={refreshing || operation !== null}
          aria-busy={refreshing}
          onClick={() => void loadProviders(false)}
          className={`${accountGlassButtonClassName} inline-flex h-9 shrink-0 items-center gap-1.5`}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {t("common.actions.refresh")}
        </button>
      </div>

      <AccountSection className="p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t("settings.legalSources.localStatus.title")}
            </p>
            <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">
              {t("settings.legalSources.localStatus.body")}
            </p>
          </div>
        </div>
      </AccountSection>

      {loadFailure && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
        >
          <span>{errorMessage(loadFailure)}</span>
          <button
            type="button"
            disabled={refreshing || operation !== null}
            onClick={() => void loadProviders(false)}
            className={accountGlassButtonClassName}
          >
            {t("common.actions.retry")}
          </button>
        </div>
      )}

      {providers.length === 0 ? (
        <AccountSection className="p-6 text-center">
          <Scale className="mx-auto h-5 w-5 text-gray-400" aria-hidden="true" />
          <h3 className="mt-3 text-base font-medium text-gray-900 dark:text-gray-100">
            {t("settings.legalSources.empty.title")}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
            {t("settings.legalSources.empty.body")}
          </p>
        </AccountSection>
      ) : (
        <div className="space-y-4" aria-busy={refreshing}>
          {providers.map((provider) => (
            <ProviderCard
              key={provider.provider}
              provider={provider}
              operation={operation}
              refreshing={refreshing}
              failure={
                providerFailure?.provider === provider.provider
                  ? providerFailure.error
                  : null
              }
              feedback={
                feedback?.provider === provider.provider ? feedback.kind : null
              }
              onSave={(field) => void saveCredential(provider, field)}
              onRemove={() => {
                setProviderFailure(null);
                setFeedback(null);
                setRemoveConfirmProvider(provider.provider);
              }}
            />
          ))}
        </div>
      )}

      <ConfirmPopup
        open={Boolean(removeTarget)}
        title={t("settings.legalSources.credential.removeConfirmTitle")}
        message={
          removeTarget
            ? t("settings.legalSources.credential.removeConfirmBody", {
                provider: t(PROVIDER_NAME_KEYS[removeTarget.provider]),
              })
            : undefined
        }
        confirmLabel={t("settings.legalSources.credential.remove")}
        confirmStatus={
          operation?.kind === "remove" &&
          operation.provider === removeTarget?.provider
            ? "loading"
            : "idle"
        }
        confirmDisabled={
          !removeTarget ||
          !removeTarget.hasSecret ||
          Boolean(operation) ||
          refreshing
        }
        cancelDisabled={operation?.kind === "remove"}
        onCancel={() => {
          if (!operation) setRemoveConfirmProvider(null);
        }}
        onConfirm={() => {
          if (removeTarget) void removeCredential(removeTarget);
        }}
      />
    </div>
  );
}

function ProviderCard({
  provider,
  operation,
  refreshing,
  failure,
  feedback,
  onSave,
  onRemove,
}: {
  provider: VeraLegalSourceProvider;
  operation: CredentialOperation | null;
  refreshing: boolean;
  failure: BackendErrorDescriptor | null;
  feedback: ProviderFeedback["kind"] | null;
  onSave: (field: Pick<HTMLInputElement, "value">) => void;
  onRemove: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const providerName = t(PROVIDER_NAME_KEYS[provider.provider]);
  const cardId = `vera-legal-source-${provider.provider}`;
  const inputId = `${cardId}-credential`;
  const currentOperation =
    operation?.provider === provider.provider ? operation.kind : null;
  const credentialReady = credentialActionsReady(provider);
  const saveDisabled = !credentialReady || refreshing || operation !== null;
  const removeDisabled =
    refreshing || operation !== null || !provider.hasSecret;

  useEffect(() => {
    if (saveDisabled && inputRef.current) inputRef.current.value = "";
  }, [saveDisabled]);

  useEffect(
    () => () => {
      if (inputRef.current) inputRef.current.value = "";
    },
    [],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveDisabled || !inputRef.current) return;
    onSave(inputRef.current);
  }

  const hasUndeclaredPolicy = Object.values(provider.dataUsePolicy).includes(
    "not_declared",
  );

  return (
    <AccountSection
      data-testid={`legal-source-provider-${provider.provider}`}
      aria-labelledby={`${cardId}-title`}
    >
      <div className="px-4 py-5 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 rounded-lg bg-gray-100 p-2 text-gray-600 dark:bg-white/10 dark:text-gray-300">
              <Scale className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3
                id={`${cardId}-title`}
                className="text-base font-medium text-gray-900 dark:text-gray-100"
              >
                {providerName}
              </h3>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t("settings.legalSources.providerContract")}
              </p>
            </div>
          </div>
          <ConnectionBadge provider={provider} />
        </div>

        <div className="mt-5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t("settings.legalSources.readiness.title")}
          </h4>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            <ReadinessItem
              label={t("settings.legalSources.readiness.endpoint")}
              ready={provider.endpointConfigured}
            />
            <ReadinessItem
              label={t("settings.legalSources.readiness.allowlist")}
              ready={provider.allowlisted}
            />
            <ReadinessItem
              label={t("settings.legalSources.readiness.credentialReference")}
              ready={provider.credentialReferenceConfigured}
            />
            <ReadinessItem
              label={t("settings.legalSources.readiness.encryption")}
              ready={provider.encryptionEnabled}
            />
          </ul>
        </div>
      </div>

      <Divider />

      <div className="px-4 py-5 sm:px-5">
        <div className="flex items-center gap-2">
          <Database
            className="h-4 w-4 text-gray-500 dark:text-gray-400"
            aria-hidden="true"
          />
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t("settings.legalSources.policy.title")}
          </h4>
        </div>
        <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
          {t("settings.legalSources.policy.description")}
        </p>
        <dl className="mt-3 grid gap-x-5 gap-y-3 sm:grid-cols-2">
          <PolicyItem
            label={t("settings.legalSources.policy.basis")}
            value={t(DATA_USE_VALUE_KEYS[provider.dataUsePolicy.basis])}
          />
          <PolicyItem
            label={t("settings.legalSources.policy.retention")}
            value={t(DATA_USE_VALUE_KEYS[provider.dataUsePolicy.retention])}
          />
          <PolicyItem
            label={t("settings.legalSources.policy.export")}
            value={t(DATA_USE_VALUE_KEYS[provider.dataUsePolicy.export])}
          />
          <PolicyItem
            label={t("settings.legalSources.policy.modelUse")}
            value={t(DATA_USE_VALUE_KEYS[provider.dataUsePolicy.modelUse])}
          />
        </dl>
        {hasUndeclaredPolicy && (
          <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
            {t("settings.legalSources.policy.notDeclaredWarning")}
          </p>
        )}
        {provider.dataUsePolicy.retention === "full_text_ttl" && (
          <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
            {t("settings.legalSources.policy.ttlDeclarationWarning")}
          </p>
        )}
      </div>

      <Divider />

      <div className="px-4 py-5 sm:px-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t("settings.legalSources.credential.title")}
            </h4>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {provider.hasSecret
                ? t("settings.legalSources.credential.configured")
                : t("settings.legalSources.credential.missing")}
            </p>
          </div>
          <span className="mt-2 inline-flex w-fit items-center gap-1.5 text-xs text-gray-500 sm:mt-0 dark:text-gray-400">
            <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
            {t("settings.legalSources.credential.localOnly")}
          </span>
        </div>

        <form
          onSubmit={(event) => void submit(event)}
          className="mt-4 space-y-3"
          aria-label={t("settings.legalSources.credential.formLabel", {
            provider: providerName,
          })}
        >
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-200"
          >
            {t("settings.legalSources.credential.inputLabel")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <KeyRound
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
                aria-hidden="true"
              />
              <input
                ref={inputRef}
                id={inputId}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS}
                disabled={saveDisabled}
                aria-describedby={`${inputId}-description ${inputId}-gate`}
                className={`${accountGlassInputClassName} h-9 w-full pl-9 text-sm`}
                placeholder={t("settings.legalSources.credential.placeholder")}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="submit"
                disabled={saveDisabled}
                aria-busy={currentOperation === "save"}
                className={`${accountGlassPrimaryButtonClassName} inline-flex h-9 items-center gap-1.5 text-sm font-medium`}
              >
                {currentOperation === "save" && (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {currentOperation === "save"
                  ? t("common.status.saving")
                  : provider.hasSecret
                    ? t("settings.legalSources.credential.replace")
                    : t("settings.legalSources.credential.store")}
              </button>
              <button
                type="button"
                disabled={removeDisabled || currentOperation === "remove"}
                onClick={onRemove}
                className={`${accountGlassDangerButtonClassName} inline-flex h-9 items-center text-sm font-medium`}
              >
                {t("settings.legalSources.credential.remove")}
              </button>
            </div>
          </div>
          <p
            id={`${inputId}-description`}
            className="text-xs leading-5 text-gray-500 dark:text-gray-400"
          >
            {t("settings.legalSources.credential.description")}
          </p>
          <p
            id={`${inputId}-gate`}
            className={`text-xs leading-5 ${
              credentialReady
                ? "text-gray-500 dark:text-gray-400"
                : "text-amber-700 dark:text-amber-300"
            }`}
          >
            {credentialReady
              ? t("settings.legalSources.credential.actionsReady")
              : !provider.deploymentReady
                ? t("settings.legalSources.credential.deploymentDisabled")
                : t("settings.legalSources.credential.encryptionDisabled")}
          </p>
        </form>

        {failure && (
          <p
            role="alert"
            className="mt-3 text-xs text-red-600 dark:text-red-400"
          >
            {errorMessage(failure)}
          </p>
        )}
        {feedback && (
          <p
            role={feedback.endsWith("refresh_failed") ? "alert" : "status"}
            className={`mt-3 text-xs ${
              feedback.endsWith("refresh_failed")
                ? "text-amber-700 dark:text-amber-300"
                : "text-emerald-700 dark:text-emerald-400"
            }`}
          >
            {t(FEEDBACK_KEYS[feedback])}
          </p>
        )}
      </div>
    </AccountSection>
  );
}

function ConnectionBadge({ provider }: { provider: VeraLegalSourceProvider }) {
  const { t } = useI18n();
  const connection = provider.connectionStatus;
  const configured = connection.state === "configured_unverified";
  const detail =
    connection.state === "configured_unverified"
      ? t("settings.legalSources.status.configuredUnverifiedBody")
      : t(UNAVAILABLE_REASON_KEYS[connection.reason]);
  return (
    <div className="max-w-sm sm:text-right">
      <span
        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
          configured
            ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
            : "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
        }`}
      >
        {configured
          ? t("settings.legalSources.status.configuredUnverified")
          : t("settings.legalSources.status.unavailable")}
      </span>
      <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">
        {detail}
      </p>
    </div>
  );
}

function ReadinessItem({ label, ready }: { label: string; ready: boolean }) {
  const { t } = useI18n();
  const status = ready
    ? t("settings.legalSources.readiness.ready")
    : t("settings.legalSources.readiness.notReady");
  return (
    <li
      aria-label={`${label}: ${status}`}
      className="flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/5"
    >
      <span className="min-w-0 text-gray-600 dark:text-gray-300">{label}</span>
      <span
        className={`inline-flex shrink-0 items-center gap-1 font-medium ${
          ready
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-red-600 dark:text-red-400"
        }`}
      >
        {ready ? (
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <CircleX className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {status}
      </span>
    </li>
  );
}

function PolicyItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-gray-400">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-gray-700 dark:text-gray-200">
        {value}
      </dd>
    </div>
  );
}

function Divider() {
  return <div className="mx-4 h-px bg-gray-200 dark:bg-white/10" />;
}

function PageState({
  role = "status",
  icon,
  title,
  body,
  action,
}: {
  role?: "status" | "alert";
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <AccountSection className="p-5" role={role}>
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
