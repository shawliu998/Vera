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
import {
  createYuanDianLegalSourceAdapter,
  type YuanDianLegalSourceAdapterConfig,
} from "./yuandianLegalSourceAdapter";
import {
  classifyPkulawMcpEndpoint,
  createPkulawMcpLegalSourceAdapter,
  type PkulawMcpEndpointDisposition,
} from "./pkulawMcpLegalSourceAdapter";

export const LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION =
  "vera-legal-research-provider-v2" as const;

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
  fetchFullText: boolean;
  pagination: false;
  getByCitation: false;
  jurisdictionFilter: false;
  asOfDateFilter: false;
  structuredFilters: false;
  dynamicToolInvocation: false;
  requiresExplicitEgressApproval: true;
  documentKinds:
    | readonly ["statute", "judicial_interpretation", "case", "other"]
    | readonly ["statute", "judicial_interpretation", "other"];
}>;

export type LegalResearchProviderConnectionState =
  | "unavailable"
  | "configured_unverified";

export type LegalResearchProviderUnavailableReason =
  | "endpoint_missing"
  | "endpoint_not_allowlisted"
  | "credential_reference_missing"
  | "activation_gate_closed"
  | "data_use_policy_undeclared"
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
  integration: "authorized_provider_adapter";
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
  readonly integration: "authorized_provider_adapter";
  readonly capabilities: LegalResearchProviderCapabilities;
  readonly dataUsePolicy: LegalResearchProviderDataUsePolicy;
  connectionStatus(): Promise<LegalResearchProviderConnectionStatus>;
}

export type LegalResearchProviderFactoryOptions = {
  dataUsePolicy?: LegalResearchProviderDataUsePolicy;
};

const FULL_TEXT_CAPABILITIES: LegalResearchProviderCapabilities = Object.freeze(
  {
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
  },
);

const SEARCH_ONLY_CAPABILITIES: LegalResearchProviderCapabilities =
  Object.freeze({
    ...FULL_TEXT_CAPABILITIES,
    fetchFullText: false,
    documentKinds: Object.freeze([
      "statute",
      "judicial_interpretation",
      "other",
    ]) as LegalResearchProviderCapabilities["documentKinds"],
  });

type LegalResearchCapabilityProfile = "full_text" | "search_only";

function capabilitiesFor(
  profile: LegalResearchCapabilityProfile,
): LegalResearchProviderCapabilities {
  return profile === "search_only"
    ? SEARCH_ONLY_CAPABILITIES
    : FULL_TEXT_CAPABILITIES;
}

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

/**
 * API access never proves display, retention, export, or model-use rights. This
 * predicate only establishes that an environment deployment supplied a complete
 * contract-backed declaration; it does not open the separate retention gate or
 * implement TTL, deletion, model-use, or export enforcement.
 */
export function hasDeclaredDeploymentDataUsePolicy(
  policy: LegalResearchProviderDataUsePolicy,
) {
  return (
    policy.basis === "deployment_contract" &&
    policy.retention !== "not_declared" &&
    policy.export !== "not_declared" &&
    policy.modelUse !== "not_declared"
  );
}

function providerDescriptor(
  provider: LegalSourceProvider,
  options: LegalResearchProviderFactoryOptions,
  capabilityProfile: LegalResearchCapabilityProfile,
): LegalResearchProviderDescriptor {
  return Object.freeze({
    contractVersion: LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION,
    provider,
    integration: "authorized_provider_adapter",
    capabilities: capabilitiesFor(capabilityProfile),
    dataUsePolicy: policyOrDefault(options.dataUsePolicy),
  });
}

export function legalResearchProviderDescriptor(
  provider: LegalSourceProvider,
  options: LegalResearchProviderFactoryOptions = {},
): LegalResearchProviderDescriptor {
  return providerDescriptor(provider, options, "full_text");
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
  dataUsePolicyReady?: boolean;
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
  } else if (!reason && input.dataUsePolicyReady === false) {
    reason = "data_use_policy_undeclared";
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
  capabilityProfile?: LegalResearchCapabilityProfile;
  deployment: LegalSourceDeploymentStatus;
  credentialRequired: boolean;
  credentialProbe?: CredentialProbe;
  activationGateClosed?: boolean;
  requireDeclaredDataUsePolicy?: boolean;
  options?: LegalResearchProviderFactoryOptions;
}): LegalResearchProvider {
  const descriptor = providerDescriptor(
    input.provider,
    input.options ?? {},
    input.capabilityProfile ?? "full_text",
  );
  const dataUsePolicyReady =
    input.requireDeclaredDataUsePolicy !== true ||
    hasDeclaredDeploymentDataUsePolicy(descriptor.dataUsePolicy);

  const connectionStatus = async () => {
    let credentialAvailable = !input.credentialRequired;
    let secretStorageAvailable = true;
    const deploymentReady =
      unavailableReason(input.deployment, input.credentialRequired, true) ===
      null;
    if (
      deploymentReady &&
      input.activationGateClosed !== true &&
      dataUsePolicyReady &&
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
      dataUsePolicyReady,
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

export function createYuanDianLegalResearchProvider(
  config: YuanDianLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return createProvider({
    provider: "yuandian",
    adapter: createYuanDianLegalSourceAdapter(config, deps),
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
  provider: "PKULAW" | "YUANDIAN" | "WOLTERS",
  deps: LegalSourceAdapterDeps,
): CredentialProbe | undefined {
  const credentialRef =
    process.env[`VERA_${provider}_API_CREDENTIAL_REF`]?.trim();
  return credentialRef ? credentialProbe(deps, credentialRef) : undefined;
}

function pkulawEnvironmentDisposition(): PkulawMcpEndpointDisposition {
  return classifyPkulawMcpEndpoint(
    process.env.VERA_PKULAW_API_ENDPOINT?.trim(),
  );
}

function pkulawEnvironmentCapabilityProfile(
  disposition = pkulawEnvironmentDisposition(),
): LegalResearchCapabilityProfile {
  // An invalid URL on an official MCP gateway must not fall back to claiming
  // enterprise JSON full-text capability.
  return disposition === "not_mcp" ? "full_text" : "search_only";
}

function exactPkulawMcpHostAllowlisted() {
  const endpoint = process.env.VERA_PKULAW_API_ENDPOINT?.trim();
  const allowedHosts = process.env.VERA_PKULAW_API_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!endpoint || allowedHosts?.length !== 1) return false;
  try {
    return allowedHosts[0] === new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** Environment-aware deployment projection shared by runtime and status UI. */
export function legalResearchProviderDeploymentStatus(
  provider: LegalSourceProvider,
): LegalSourceDeploymentStatus {
  const deployment = legalSourceDeploymentStatus(provider);
  if (provider !== "pkulaw") return deployment;

  const disposition = pkulawEnvironmentDisposition();
  if (
    disposition === "invalid_mcp_gateway" ||
    (disposition === "approved_mcp" && !exactPkulawMcpHostAllowlisted())
  ) {
    return { ...deployment, allowlisted: false };
  }
  return deployment;
}

/** Project the v2 descriptor from the configured environment adapter. */
export function legalResearchProviderDescriptorFromEnvironment(
  provider: LegalSourceProvider,
  options: LegalResearchProviderFactoryOptions = {},
): LegalResearchProviderDescriptor {
  return providerDescriptor(
    provider,
    options,
    provider === "pkulaw" ? pkulawEnvironmentCapabilityProfile() : "full_text",
  );
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
  const pkulawDisposition =
    provider === "pkulaw" ? pkulawEnvironmentDisposition() : "not_mcp";
  const deployment = legalResearchProviderDeploymentStatus(provider);
  const credentialRequired = provider !== "official";
  const dataUsePolicyReady = hasDeclaredDeploymentDataUsePolicy(
    legalResearchProviderDescriptorFromEnvironment(provider, options)
      .dataUsePolicy,
  );
  let adapter: LegalSourceAdapter | null = null;
  if (
    !ENVIRONMENT_PROVIDER_ACTIVATION_GATE_CLOSED &&
    dataUsePolicyReady &&
    deployment.endpointConfigured &&
    deployment.allowlisted &&
    (!credentialRequired || deployment.credentialReferenceConfigured)
  ) {
    try {
      adapter =
        provider === "official"
          ? createOfficialPublicLegalSourceAdapterFromEnvironment(deps)
          : provider === "pkulaw"
            ? pkulawDisposition === "approved_mcp"
              ? createPkulawMcpLegalSourceAdapter(
                  {
                    endpoint: process.env.VERA_PKULAW_API_ENDPOINT ?? "",
                    credentialRef:
                      process.env.VERA_PKULAW_API_CREDENTIAL_REF ?? "",
                  },
                  deps,
                )
              : pkulawDisposition === "not_mcp"
                ? createPkulawLegalSourceAdapterFromEnvironment(deps)
                : null
            : provider === "yuandian"
              ? createYuanDianLegalSourceAdapter(
                  {
                    credentialRef:
                      process.env.VERA_YUANDIAN_API_CREDENTIAL_REF ?? "",
                  },
                  deps,
                )
              : provider === "wolters"
                ? createWoltersLegalSourceAdapterFromEnvironment(deps)
                : null;
    } catch (error) {
      if (!(error instanceof LegalSourceAdapterError)) throw error;
      adapter = null;
    }
  }
  return createProvider({
    provider,
    adapter,
    capabilityProfile:
      provider === "pkulaw"
        ? pkulawEnvironmentCapabilityProfile(pkulawDisposition)
        : "full_text",
    deployment,
    credentialRequired,
    activationGateClosed: ENVIRONMENT_PROVIDER_ACTIVATION_GATE_CLOSED,
    requireDeclaredDataUsePolicy: true,
    credentialProbe:
      provider === "official"
        ? undefined
        : environmentCredentialProbe(
            provider.toUpperCase() as "PKULAW" | "YUANDIAN" | "WOLTERS",
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

export function createYuanDianLegalResearchProviderFromEnvironment(
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return environmentProvider("yuandian", deps, options);
}

export function createOfficialPublicLegalResearchProviderFromEnvironment(
  deps: LegalSourceAdapterDeps = {},
  options: LegalResearchProviderFactoryOptions = {},
) {
  return environmentProvider("official", deps, options);
}
