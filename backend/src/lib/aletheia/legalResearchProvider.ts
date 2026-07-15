import {
  createOfficialPublicLegalSourceAdapter,
  createOfficialPublicLegalSourceAdapterFromEnvironment,
  createPkulawLegalSourceAdapter,
  createPkulawLegalSourceAdapterFromEnvironment,
  createWoltersLegalSourceAdapter,
  createWoltersLegalSourceAdapterFromEnvironment,
  legalSourceDeploymentStatus,
  LegalSourceAdapterError,
  type LegalSourceAdapter,
  type LegalSourceAdapterDeps,
  type LegalSourceDeploymentStatus,
  type LegalSourceDocument,
  type LegalSourceFetchRequest,
  type LegalSourceProvider,
  type LegalSourceSearchRequest,
  type LegalSourceSearchResult,
  type OfficialLegalSourceAdapterConfig,
  type OfficialPublicLegalSourceAdapterConfig,
} from "./legalSourceAdapter";
import { LEGAL_SOURCE_RETENTION_ACTIVATION_V13 } from "../workspace/sourceRetentionPolicyV13";

export const LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION =
  "vera-legal-research-provider-v1" as const;

export type LegalResearchRetentionPolicy =
  | "not_declared"
  | "no_retention"
  | "metadata_only"
  | "full_text_ttl"
  | "full_text_permitted";

export type LegalResearchExportPolicy =
  | "not_declared"
  | "prohibited"
  | "exact_quotes_only"
  | "reviewed_work_product"
  | "permitted";

export type LegalResearchModelUsePolicy =
  | "not_declared"
  | "prohibited"
  | "local_only"
  | "permitted";

/**
 * These fields describe deployment authorization, not a vendor's marketing
 * claim. `not_declared` is intentionally fail-closed metadata: callers must
 * not infer retention, export, or model-training rights from API access.
 */
export type LegalResearchProviderDataUsePolicy = Readonly<{
  basis: "not_declared" | "deployment_contract";
  retention: LegalResearchRetentionPolicy;
  export: LegalResearchExportPolicy;
  modelUse: LegalResearchModelUsePolicy;
}>;

export type LegalResearchProviderCapabilities = Readonly<{
  search: true;
  fetchFullText: true;
  pagination: false;
  getByCitation: false;
  jurisdictionFilter: false;
  asOfDateFilter: false;
  structuredFilters: false;
  dynamicToolInvocation: false;
  requiresExplicitEgressApproval: true;
  documentKinds: readonly [
    "statute",
    "judicial_interpretation",
    "case",
    "other",
  ];
}>;

export type LegalResearchProviderConnectionState =
  | "unavailable"
  | "configured_unverified";

export type LegalResearchProviderUnavailableReason =
  | "endpoint_missing"
  | "endpoint_not_allowlisted"
  | "credential_reference_missing"
  | "activation_gate_closed"
  | "credential_unavailable"
  | "secret_storage_unavailable"
  | "connection_test_failed";

export type LegalResearchProviderConnectionStatus = Readonly<{
  state: LegalResearchProviderConnectionState;
  reason: LegalResearchProviderUnavailableReason | null;
  connectionTested: boolean;
}>;

export type LegalResearchProviderDescriptor = Readonly<{
  contractVersion: typeof LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION;
  provider: LegalSourceProvider;
  integration: "authorized_json_gateway";
  capabilities: LegalResearchProviderCapabilities;
  dataUsePolicy: LegalResearchProviderDataUsePolicy;
}>;

/**
 * Generic provider port used by the research broker. It deliberately extends
 * the legacy adapter so the Matter API and injected audit adapters remain
 * compatible during the workspace migration.
 */
export interface LegalResearchProvider extends LegalSourceAdapter {
  readonly contractVersion: typeof LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION;
  readonly integration: "authorized_json_gateway";
  readonly capabilities: LegalResearchProviderCapabilities;
  readonly dataUsePolicy: LegalResearchProviderDataUsePolicy;
  connectionStatus(): Promise<LegalResearchProviderConnectionStatus>;
}

export type LegalResearchProviderFactoryOptions = {
  dataUsePolicy?: LegalResearchProviderDataUsePolicy;
};

const CAPABILITIES: LegalResearchProviderCapabilities = Object.freeze({
  search: true,
  fetchFullText: true,
  pagination: false,
  getByCitation: false,
  jurisdictionFilter: false,
  asOfDateFilter: false,
  structuredFilters: false,
  dynamicToolInvocation: false,
  requiresExplicitEgressApproval: true,
  documentKinds: Object.freeze([
    "statute",
    "judicial_interpretation",
    "case",
    "other",
  ]) as LegalResearchProviderCapabilities["documentKinds"],
});

const UNDECLARED_DATA_USE_POLICY: LegalResearchProviderDataUsePolicy =
  Object.freeze({
    basis: "not_declared",
    retention: "not_declared",
    export: "not_declared",
    modelUse: "not_declared",
  });

function policyOrDefault(
  policy: LegalResearchProviderDataUsePolicy | undefined,
): LegalResearchProviderDataUsePolicy {
  if (!policy) return UNDECLARED_DATA_USE_POLICY;
  return Object.freeze({ ...policy });
}

export function legalResearchProviderDescriptor(
  provider: LegalSourceProvider,
  options: LegalResearchProviderFactoryOptions = {},
): LegalResearchProviderDescriptor {
  return Object.freeze({
    contractVersion: LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION,
    provider,
    integration: "authorized_json_gateway",
    capabilities: CAPABILITIES,
    dataUsePolicy: policyOrDefault(options.dataUsePolicy),
  });
}

function unavailableReason(
  deployment: LegalSourceDeploymentStatus,
  credentialRequired: boolean,
  credentialAvailable: boolean,
): LegalResearchProviderUnavailableReason | null {
  if (!deployment.endpointConfigured) return "endpoint_missing";
  if (!deployment.allowlisted) return "endpoint_not_allowlisted";
  if (credentialRequired && !deployment.credentialReferenceConfigured) {
    return "credential_reference_missing";
  }
  if (credentialRequired && !credentialAvailable) {
    return "credential_unavailable";
  }
  return null;
}

export function projectLegalResearchProviderConnectionStatus(input: {
  deployment: LegalSourceDeploymentStatus;
  credentialRequired: boolean;
  credentialAvailable: boolean;
  activationGateClosed?: boolean;
  secretStorageAvailable?: boolean;
  connectionTestStatus?: "passed" | "failed" | "unsupported" | null;
}): LegalResearchProviderConnectionStatus {
  const configurationReason = unavailableReason(
    input.deployment,
    input.credentialRequired,
    true,
  );
  let reason = configurationReason;
  if (!reason && input.activationGateClosed === true) {
    reason = "activation_gate_closed";
  } else if (
    !reason &&
    input.credentialRequired &&
    input.secretStorageAvailable === false
  ) {
    reason = "secret_storage_unavailable";
  } else if (
    !reason &&
    input.credentialRequired &&
    !input.credentialAvailable
  ) {
    reason = "credential_unavailable";
  } else if (!reason && input.connectionTestStatus === "failed") {
    reason = "connection_test_failed";
  }
  return Object.freeze({
    state: reason ? "unavailable" : "configured_unverified",
    reason,
    // No protocol-safe connection probe exists for this generic gateway. Do
    // not label endpoint/credential presence as a successful connection.
    connectionTested:
      input.connectionTestStatus === "passed" ||
      input.connectionTestStatus === "failed",
  });
}

type CredentialProbe = () => Promise<boolean>;

function createProvider(input: {
  provider: LegalSourceProvider;
  adapter: LegalSourceAdapter | null;
  deployment: LegalSourceDeploymentStatus;
  credentialRequired: boolean;
  credentialProbe?: CredentialProbe;
  activationGateClosed?: boolean;
  options?: LegalResearchProviderFactoryOptions;
}): LegalResearchProvider {
  const descriptor = legalResearchProviderDescriptor(
    input.provider,
    input.options,
  );

  const connectionStatus = async () => {
    let credentialAvailable = !input.credentialRequired;
    let secretStorageAvailable = true;
    const deploymentReady =
      unavailableReason(input.deployment, input.credentialRequired, true) ===
      null;
    if (
      deploymentReady &&
      input.activationGateClosed !== true &&
      input.credentialRequired &&
      input.credentialProbe
    ) {
      try {
        credentialAvailable = await input.credentialProbe();
      } catch {
        credentialAvailable = false;
        secretStorageAvailable = false;
      }
    }
    return projectLegalResearchProviderConnectionStatus({
      deployment: input.deployment,
      credentialRequired: input.credentialRequired,
      credentialAvailable,
      activationGateClosed: input.activationGateClosed,
      secretStorageAvailable,
    });
  };

  async function readyAdapter() {
    const status = await connectionStatus();
    if (status.state === "unavailable" || !input.adapter) {
      throw new LegalSourceAdapterError(
        status.reason === "credential_unavailable" ||
          status.reason === "secret_storage_unavailable"
          ? "Authorized legal-source credential is unavailable."
          : "Authorized legal-source configuration is unavailable.",
        status.reason === "credential_unavailable" ||
          status.reason === "secret_storage_unavailable"
          ? "credential_unavailable"
          : "configuration_error",
      );
    }
    return input.adapter;
  }

  return Object.freeze({
    ...descriptor,
    connectionStatus,
    async search(
      request: LegalSourceSearchRequest,
    ): Promise<LegalSourceSearchResult[]> {
      return (await readyAdapter()).search(request);
    },
    async fetch(
      request: LegalSourceFetchRequest,
    ): Promise<LegalSourceDocument> {
      return (await readyAdapter()).fetch(request);
    },
  });
}

function configuredDeployment(
  credentialRequired: boolean,
): LegalSourceDeploymentStatus {
  return {
    endpointConfigured: true,
    allowlisted: true,
    credentialReferenceConfigured: credentialRequired,
  };
}

function credentialProbe(
  deps: LegalSourceAdapterDeps,
  credentialRef: string,
): CredentialProbe {
  return async () => {
    if (!deps.resolveCredential) return false;
    const value = await deps.resolveCredential(credentialRef);
    return typeof value === "string" && value.length > 0;
  };
}

export function createPkulawLegalResearchProvider(
  config: OfficialLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return createProvider({
    provider: "pkulaw",
    adapter: createPkulawLegalSourceAdapter(config, deps),
    deployment: configuredDeployment(true),
    credentialRequired: true,
    credentialProbe: credentialProbe(deps, config.credentialRef),
    options,
  });
}

export function createWoltersLegalResearchProvider(
  config: OfficialLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return createProvider({
    provider: "wolters",
    adapter: createWoltersLegalSourceAdapter(config, deps),
    deployment: configuredDeployment(true),
    credentialRequired: true,
    credentialProbe: credentialProbe(deps, config.credentialRef),
    options,
  });
}

export function createOfficialPublicLegalResearchProvider(
  config: OfficialPublicLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return createProvider({
    provider: "official",
    adapter: createOfficialPublicLegalSourceAdapter(config, deps),
    deployment: configuredDeployment(false),
    credentialRequired: false,
    options,
  });
}

function environmentCredentialProbe(
  provider: "PKULAW" | "WOLTERS",
  deps: LegalSourceAdapterDeps,
): CredentialProbe | undefined {
  const credentialRef =
    process.env[`VERA_${provider}_API_CREDENTIAL_REF`]?.trim();
  return credentialRef ? credentialProbe(deps, credentialRef) : undefined;
}

/**
 * Environment-backed providers are the production egress path. Keep this gate
 * closed in code (not in deployment configuration) until retained legal-source
 * content has an enforced lifecycle. Direct injected constructors remain
 * available for protocol audits without creating a production bypass.
 */
const ENVIRONMENT_PROVIDER_ACTIVATION_GATE_CLOSED =
  !LEGAL_SOURCE_RETENTION_ACTIVATION_V13.open;

function environmentProvider(
  provider: LegalSourceProvider,
  deps: LegalSourceAdapterDeps,
  options: LegalResearchProviderFactoryOptions,
) {
  const deployment = legalSourceDeploymentStatus(provider);
  const credentialRequired = provider !== "official";
  let adapter: LegalSourceAdapter | null = null;
  if (
    !ENVIRONMENT_PROVIDER_ACTIVATION_GATE_CLOSED &&
    deployment.endpointConfigured &&
    deployment.allowlisted &&
    (!credentialRequired || deployment.credentialReferenceConfigured)
  ) {
    try {
      adapter =
        provider === "official"
          ? createOfficialPublicLegalSourceAdapterFromEnvironment(deps)
          : provider === "pkulaw"
            ? createPkulawLegalSourceAdapterFromEnvironment(deps)
            : createWoltersLegalSourceAdapterFromEnvironment(deps);
    } catch (error) {
      if (!(error instanceof LegalSourceAdapterError)) throw error;
      adapter = null;
    }
  }
  return createProvider({
    provider,
    adapter,
    deployment,
    credentialRequired,
    activationGateClosed: ENVIRONMENT_PROVIDER_ACTIVATION_GATE_CLOSED,
    credentialProbe:
      provider === "official"
        ? undefined
        : environmentCredentialProbe(
            provider.toUpperCase() as "PKULAW" | "WOLTERS",
            deps,
          ),
    options,
  });
}

export function createPkulawLegalResearchProviderFromEnvironment(
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return environmentProvider("pkulaw", deps, options);
}

export function createWoltersLegalResearchProviderFromEnvironment(
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return environmentProvider("wolters", deps, options);
}

export function createOfficialPublicLegalResearchProviderFromEnvironment(
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return environmentProvider("official", deps, options);
}
