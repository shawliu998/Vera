import { WorkspaceApiError } from "./errors";
import {
  modelConnectionTestView,
  normalizeModelConnectionTestErrorCode,
  type ModelConnectionTestErrorCode,
} from "./modelConnectionReadiness";
import {
  PROVIDER_CAPABILITIES,
  WorkspaceModelProviderRegistry,
} from "./modelProviderRegistry";
import { buildEndpointBindingSnapshot } from "./services/modelGateway";
import { ModelConnectionTestsRepository } from "./repositories/modelConnectionTests";
import {
  ModelProfilesRepository,
  type StoredModelProfileRecord,
} from "./repositories/modelProfiles";
import { ModelProfilesService } from "./services/modelProfiles";
import { SettingsService } from "./services/settings";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "./principal";
import type {
  WorkspaceCapabilitiesWire,
  WorkspaceModelSettingsContext,
  WorkspaceModelSettingsRuntimePort,
  WorkspaceModelWire,
  WorkspaceModelPrivacyWire,
  WorkspaceSettingsWire,
} from "../../routes/workspaceSettingsV1";
import {
  ModelProfilePrivacyRepository,
  type ExecutionLocation,
  type ModelRetention,
  type ModelTrainingUse,
} from "./inferencePolicy";

type ModelMutationInput = {
  name?: string;
  provider?: StoredModelProfileRecord["provider"];
  model?: string;
  baseUrl?: string | null;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: StoredModelProfileRecord["capabilities"];
};

type ModelPrivacyMutationInput = {
  executionLocation?: ExecutionLocation;
  retention?: ModelRetention;
  trainingUse?: ModelTrainingUse;
  sensitiveDataAllowed?: boolean;
};

export type WorkspaceModelSettingsRuntimeDependencies = {
  profiles: ModelProfilesService;
  profileRepository: ModelProfilesRepository;
  connectionTests: ModelConnectionTestsRepository;
  settings: SettingsService;
  providerRegistry: WorkspaceModelProviderRegistry | null;
  privacy: ModelProfilePrivacyRepository;
  allowLocalDevelopmentBaseUrl?: boolean;
  clock?: () => Date;
  monotonicClock?: () => number;
};

function safeLatency(startedAt: number, completedAt: number): number | null {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
  const elapsed = Math.round(completedAt - startedAt);
  return Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= 600_000
    ? elapsed
    : null;
}

function isWorkspaceConflict(error: unknown) {
  return error instanceof WorkspaceApiError && error.status === 409;
}

export class WorkspaceModelSettingsRuntime implements WorkspaceModelSettingsRuntimePort {
  private readonly allowLocalDevelopmentBaseUrl: boolean;
  private readonly clock: () => Date;
  private readonly monotonicClock: () => number;

  constructor(
    private readonly dependencies: WorkspaceModelSettingsRuntimeDependencies,
  ) {
    this.allowLocalDevelopmentBaseUrl =
      dependencies.allowLocalDevelopmentBaseUrl ?? false;
    this.clock = dependencies.clock ?? (() => new Date());
    this.monotonicClock =
      dependencies.monotonicClock ?? (() => performance.now());
  }

  private requireLocal(context: WorkspaceModelSettingsContext) {
    if (context.principalId !== WORKSPACE_LOCAL_PRINCIPAL_ID) {
      throw new WorkspaceApiError(403, "FORBIDDEN", "Workspace is local-only.");
    }
  }

  private capabilities(): WorkspaceCapabilitiesWire {
    const service = this.dependencies.profiles.capabilities();
    const registryWired =
      this.dependencies.providerRegistry?.runtimeWired() === true;
    const runtimeWired = service.runtimeWired && registryWired;
    const credentialWriteEnabled = service.credentialWriteEnabled;
    return {
      schema_version: "vera-workspace-model-settings-v1",
      settings_available: runtimeWired && credentialWriteEnabled,
      local_only: true,
      loopback_http_allowed: service.loopbackHttpAllowed,
      supported_providers:
        this.dependencies.providerRegistry?.supportedProviders() ?? [],
      credential_write_enabled: credentialWriteEnabled,
      secret_readback_supported: false,
      runtime_wired: runtimeWired,
    };
  }

  private settingsWire(): WorkspaceSettingsWire {
    const value = this.dependencies.settings.get();
    return {
      locale: value.locale,
      theme: value.theme,
      default_model_profile_id: value.defaultModelProfileId,
      default_project_id: value.defaultProjectId,
      updated_at: value.updatedAt,
    };
  }

  private modelWire(id: string): WorkspaceModelWire {
    const record = this.dependencies.profileRepository.requireStored(id);
    const view = this.dependencies.profiles.getView(id);
    const connection = modelConnectionTestView(
      record.connectionRevision,
      this.dependencies.connectionTests.get(id),
    );
    return {
      id: view.id,
      name: view.name,
      provider: view.provider,
      model: view.model,
      base_url: view.baseUrl,
      context_window_tokens: view.contextWindowTokens,
      max_output_tokens: view.maxOutputTokens,
      enabled: view.enabled,
      is_default: view.isDefault,
      created_at: view.createdAt,
      updated_at: view.updatedAt,
      capabilities: view.capabilities,
      credential: {
        status: view.credential.status,
        configured: view.credential.configured,
        canonical_origin: view.credential.canonicalOrigin,
      },
      endpoint_binding: {
        provider: view.endpointBinding.provider,
        model: view.endpointBinding.model,
        normalized_base_url: view.endpointBinding.normalizedBaseUrl,
        canonical_origin: view.endpointBinding.canonicalOrigin,
        execution_revision: view.endpointBinding.executionRevision,
        connection_revision: record.connectionRevision,
        profile_updated_at: view.endpointBinding.profileUpdatedAt,
      },
      availability: {
        status: view.availability.status,
        selectable: view.availability.selectable,
      },
      connection_test: {
        status: connection.status,
        error_code: connection.errorCode,
        retryable: connection.retryable,
        latency_ms: connection.latencyMs,
        tested_at: connection.testedAt,
      } as WorkspaceModelWire["connection_test"],
      requires_credential: true,
    };
  }

  private listModelWires() {
    return this.dependencies.profileRepository
      .listStored()
      .map((record) => this.modelWire(record.id));
  }

  private modelPrivacyWire(id: string): WorkspaceModelPrivacyWire {
    const profile = this.dependencies.profileRepository.requireStored(id);
    const privacy = this.dependencies.privacy.get(id);
    if (!privacy) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Model privacy declaration is not configured.",
      );
    }
    return {
      model_profile_id: id,
      configured: true,
      declaration_basis: "user_or_admin_declared",
      model_profile_enabled: profile.enabled,
      execution_location: privacy.executionLocation,
      retention: privacy.retention,
      training_use: privacy.trainingUse,
      sensitive_data_allowed: privacy.sensitiveDataAllowed,
      created_at: privacy.createdAt,
      updated_at: privacy.updatedAt,
    };
  }

  private privacyUpdateTime(currentUpdatedAt: string | null) {
    const observed = this.clock().getTime();
    const minimum =
      currentUpdatedAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(currentUpdatedAt) + 1;
    const selected = Math.max(observed, minimum);
    if (!Number.isFinite(selected)) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Model privacy declaration clock is invalid.",
      );
    }
    return new Date(selected).toISOString();
  }

  private supportedCapabilities(
    provider: StoredModelProfileRecord["provider"],
  ) {
    const capabilities =
      this.dependencies.providerRegistry?.capabilitiesFor(provider) ?? null;
    if (!capabilities) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "The selected model provider is not wired into this Vera runtime.",
      );
    }
    return { ...PROVIDER_CAPABILITIES, ...capabilities };
  }

  private selectedCapabilities(
    provider: StoredModelProfileRecord["provider"],
    requested: StoredModelProfileRecord["capabilities"] | undefined,
    current?: StoredModelProfileRecord["capabilities"],
  ) {
    const supported = this.supportedCapabilities(provider);
    if (provider !== "openai_compatible") {
      if (
        requested &&
        Object.entries(requested).some(
          ([key, enabled]) =>
            enabled !==
            supported[key as keyof StoredModelProfileRecord["capabilities"]],
        )
      ) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Capability overrides are available only for OpenAI-compatible model profiles.",
        );
      }
      return supported;
    }
    const selected = requested ?? current ?? supported;
    for (const key of Object.keys(supported) as Array<
      keyof StoredModelProfileRecord["capabilities"]
    >) {
      if (selected[key] && !supported[key]) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          `The selected provider does not support the ${key} capability.`,
        );
      }
    }
    return { ...selected };
  }

  async reconcileCredentialOrphans() {
    if (!this.dependencies.profiles.capabilities().credentialWriteEnabled) {
      return { deleted: 0, rebound: 0, failed: 0 };
    }
    return this.dependencies.profiles.reconcileCredentialOrphansAsync();
  }

  async getStatus(context: WorkspaceModelSettingsContext) {
    this.requireLocal(context);
    return {
      capabilities: this.capabilities(),
      settings: this.settingsWire(),
      models: this.listModelWires(),
    };
  }

  async getSettings(context: WorkspaceModelSettingsContext) {
    this.requireLocal(context);
    return this.settingsWire();
  }

  async updateSettings(
    context: WorkspaceModelSettingsContext,
    input: {
      locale?: "zh-CN" | "en-US";
      theme?: "system" | "light" | "dark";
      defaultModelProfileId?: string | null;
      defaultProjectId?: string | null;
    },
  ) {
    this.requireLocal(context);
    if (
      input.defaultModelProfileId !== undefined &&
      input.defaultModelProfileId !== null &&
      !this.capabilities().runtime_wired
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workspace default model selection is unavailable while the model runtime is offline.",
      );
    }
    const value = this.dependencies.settings.update(input);
    return {
      locale: value.locale,
      theme: value.theme,
      default_model_profile_id: value.defaultModelProfileId,
      default_project_id: value.defaultProjectId,
      updated_at: value.updatedAt,
    };
  }

  async listModels(context: WorkspaceModelSettingsContext) {
    this.requireLocal(context);
    return this.listModelWires();
  }

  async createModel(
    context: WorkspaceModelSettingsContext,
    input: ModelMutationInput,
  ) {
    this.requireLocal(context);
    if (!input.provider) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "A model provider is required.",
      );
    }
    const capabilities = this.selectedCapabilities(
      input.provider,
      input.capabilities,
    );
    const created = this.dependencies.profiles.create({
      ...input,
      capabilities,
      enabled: false,
      isDefault: false,
    });
    return this.modelWire(created.id);
  }

  async getModel(context: WorkspaceModelSettingsContext, id: string) {
    this.requireLocal(context);
    return this.modelWire(id);
  }

  async updateModel(
    context: WorkspaceModelSettingsContext,
    id: string,
    input: ModelMutationInput,
  ) {
    this.requireLocal(context);
    const current = this.dependencies.profileRepository.requireStored(id);
    const provider = input.provider ?? current.provider;
    const capabilities = this.selectedCapabilities(
      provider,
      input.capabilities,
      provider === current.provider ? current.capabilities : undefined,
    );
    await this.dependencies.profiles.updateAsync(id, {
      ...input,
      capabilities,
    });
    return this.modelWire(id);
  }

  async getModelPrivacy(context: WorkspaceModelSettingsContext, id: string) {
    this.requireLocal(context);
    return this.modelPrivacyWire(id);
  }

  async updateModelPrivacy(
    context: WorkspaceModelSettingsContext,
    id: string,
    input: ModelPrivacyMutationInput,
  ) {
    this.requireLocal(context);
    this.dependencies.profileRepository.requireStored(id);
    const current = this.dependencies.privacy.get(id);
    if (
      !current &&
      (input.executionLocation === undefined ||
        input.retention === undefined ||
        input.trainingUse === undefined ||
        input.sensitiveDataAllowed === undefined)
    ) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "An initial model privacy declaration requires all four fields.",
      );
    }
    this.dependencies.privacy.declare(
      id,
      {
        executionLocation:
          input.executionLocation ?? current!.executionLocation,
        retention: input.retention ?? current!.retention,
        trainingUse: input.trainingUse ?? current!.trainingUse,
        sensitiveDataAllowed:
          input.sensitiveDataAllowed ?? current!.sensitiveDataAllowed,
      },
      this.privacyUpdateTime(current?.updatedAt ?? null),
    );
    return this.modelPrivacyWire(id);
  }

  async putCredential(
    context: WorkspaceModelSettingsContext,
    id: string,
    input: { secret: string },
  ) {
    this.requireLocal(context);
    await this.dependencies.profiles.configureCredentialAsync(id, input);
    return this.modelWire(id);
  }

  async deleteCredential(context: WorkspaceModelSettingsContext, id: string) {
    this.requireLocal(context);
    await this.dependencies.profiles.clearCredentialAsync(id);
    return this.modelWire(id);
  }

  private async validationResult(snapshot: StoredModelProfileRecord) {
    if (
      snapshot.credentialState !== "configured" ||
      !snapshot.credentialRef ||
      !snapshot.credentialOrigin ||
      !this.dependencies.providerRegistry
    ) {
      return {
        valid: false as const,
        code: "credential_unavailable" as const,
        retryable: false,
      };
    }
    const expectedBinding = buildEndpointBindingSnapshot(
      snapshot,
      this.allowLocalDevelopmentBaseUrl,
    );
    try {
      const provider = this.dependencies.providerRegistry.createProvider({
        profile: snapshot,
        expectedBinding,
        allowLocalDevelopmentBaseUrl: this.allowLocalDevelopmentBaseUrl,
      });
      const result = await provider.validateConfiguration({
        profile: snapshot,
        expectedBinding,
        allowLocalDevelopmentBaseUrl: this.allowLocalDevelopmentBaseUrl,
      });
      if (
        !result.valid &&
        !this.dependencies.profiles.capabilities().credentialWriteEnabled
      ) {
        return {
          valid: false as const,
          code: "credential_unavailable" as const,
          retryable: false,
        };
      }
      return result;
    } catch {
      return {
        valid: false as const,
        code: "configuration_error" as const,
        retryable: false,
      };
    }
  }

  private storeFailure(
    profileId: string,
    connectionRevision: number,
    code: ModelConnectionTestErrorCode,
    retryable: boolean,
    latencyMs: number | null,
    testedAt: string,
  ) {
    return this.dependencies.connectionTests.storeIfCurrent({
      profileId,
      expectedConnectionRevision: connectionRevision,
      status: "failed",
      errorCode: code,
      retryable,
      latencyMs,
      testedAt,
    });
  }

  async testModel(context: WorkspaceModelSettingsContext, id: string) {
    this.requireLocal(context);
    const snapshot = this.dependencies.profileRepository.requireStored(id);
    const startedAt = this.monotonicClock();
    const validation = await this.validationResult(snapshot);
    const latencyMs = safeLatency(startedAt, this.monotonicClock());
    const testedAt = this.clock().toISOString();

    if (validation.valid) {
      this.dependencies.connectionTests.storeIfCurrent({
        profileId: id,
        expectedConnectionRevision: snapshot.connectionRevision,
        status: "passed",
        errorCode: null,
        retryable: false,
        latencyMs,
        testedAt,
      });
      return this.modelWire(id);
    }

    const errorCode = normalizeModelConnectionTestErrorCode(validation.code);
    if (
      errorCode === "authentication_failed" ||
      validation.code === "credential_not_found"
    ) {
      try {
        this.dependencies.profiles.markCredentialInvalid(id, {
          provider: snapshot.provider,
          canonicalOrigin: snapshot.credentialOrigin,
          executionRevision: snapshot.executionRevision,
          credentialRef: snapshot.credentialRef,
          credentialState: "configured",
        });
      } catch (error) {
        if (isWorkspaceConflict(error)) return this.modelWire(id);
        throw error;
      }
      const invalidated = this.dependencies.profileRepository.requireStored(id);
      this.storeFailure(
        id,
        invalidated.connectionRevision,
        errorCode,
        validation.retryable,
        latencyMs,
        testedAt,
      );
      return this.modelWire(id);
    }

    this.storeFailure(
      id,
      snapshot.connectionRevision,
      errorCode,
      validation.retryable,
      latencyMs,
      testedAt,
    );
    return this.modelWire(id);
  }

  async enableModel(context: WorkspaceModelSettingsContext, id: string) {
    this.requireLocal(context);
    await Promise.resolve(this.dependencies.profiles.enable(id));
    return this.modelWire(id);
  }

  async disableModel(context: WorkspaceModelSettingsContext, id: string) {
    this.requireLocal(context);
    await Promise.resolve(this.dependencies.profiles.disable(id));
    return this.modelWire(id);
  }

  async setDefaultModel(context: WorkspaceModelSettingsContext, id: string) {
    this.requireLocal(context);
    await Promise.resolve(this.dependencies.profiles.setDefault(id));
    return this.modelWire(id);
  }

  async deleteModel(context: WorkspaceModelSettingsContext, id: string) {
    this.requireLocal(context);
    await this.dependencies.profiles.deleteAsync(id);
  }
}
