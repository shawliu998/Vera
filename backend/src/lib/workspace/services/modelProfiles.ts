import { randomUUID } from "node:crypto";

import { ZodError, z } from "zod";

import {
  CreateModelProfileRequestSchema,
  UpdateModelProfileRequestSchema,
} from "../contracts";
import { WorkspaceApiError } from "../errors";
import {
  availabilityForModelProfile,
  DISABLED_RUNTIME_MODEL_CAPABILITIES,
  defaultBaseUrlForProvider,
  type ModelProviderAdapterRegistryPort,
  normalizeModelEndpoint,
  tryNormalizeModelEndpoint,
  type CredentialState,
} from "../modelCompatibility";
import {
  ModelProfilesRepository,
  type ActiveModelProfileJob,
  type StoredModelProfileRecord,
} from "../repositories/modelProfiles";
import type { ModelProfile } from "../types";
import type { CredentialStorePort } from "./credentialStore";

const MAX_CREDENTIAL_SECRET_BYTES = 8 * 1024;
const CredentialSecretSchema = z
  .object({
    secret: z
      .string()
      .refine((value) => value.length > 0, "Secret is required.")
      .refine(
        (value) => !/[\r\n]/.test(value),
        "Secret must not contain newlines.",
      )
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <= MAX_CREDENTIAL_SECRET_BYTES,
        "Secret is too large.",
      ),
  })
  .strict();
const EndpointBindingSnapshotSchema = z
  .object({
    provider: z.enum([
      "openai",
      "deepseek",
      "anthropic",
      "gemini",
      "openai_compatible",
    ]),
    model: z.string().min(1).max(200),
    normalizedBaseUrl: z.string().min(1).nullable(),
    canonicalOrigin: z.string().min(1).nullable(),
    executionRevision: z.number().int().nonnegative(),
    profileUpdatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const WorkspaceModelProfileViewSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    provider: z.enum([
      "openai",
      "deepseek",
      "anthropic",
      "gemini",
      "openai_compatible",
    ]),
    model: z.string().min(1).max(200),
    baseUrl: z.string().min(1).nullable(),
    credentialStatus: z.enum(["not_configured", "configured", "unavailable"]),
    contextWindowTokens: z.number().int().positive().nullable(),
    maxOutputTokens: z.number().int().positive().nullable(),
    enabled: z.boolean(),
    capabilities: z
      .object({
        streaming: z.boolean(),
        toolCalling: z.boolean(),
        structuredOutput: z.boolean(),
        vision: z.boolean(),
      })
      .strict(),
    isDefault: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    credential: z
      .object({
        status: z.enum(["configured", "missing", "invalid"]),
        configured: z.boolean(),
        canonicalOrigin: z.string().min(1).nullable(),
      })
      .strict(),
    endpointBinding: EndpointBindingSnapshotSchema,
    availability: z
      .object({
        status: z.enum([
          "ready",
          "disabled",
          "missing_credential",
          "invalid_credential",
          "credential_unavailable",
          "origin_unbound",
          "runtime_unwired",
        ]),
        selectable: z.boolean(),
      })
      .strict(),
    requiresCredential: z.literal(true),
  })
  .strict();

export interface ModelProfileResourceLifecyclePort {
  cancelQueued(jobIds: readonly string[], reason: string): void;
  requestAbortRunning(jobIds: readonly string[], reason: string): void;
}

export type ModelProfilesServiceOptions = {
  allowLocalDevelopmentBaseUrl?: boolean;
  resources?: ModelProfileResourceLifecyclePort;
  credentialStore?: CredentialStorePort;
  adapterRegistry?: ModelProviderAdapterRegistryPort;
  clock?: () => Date;
  nextId?: () => string;
};

export type EndpointBindingSnapshot = z.infer<
  typeof EndpointBindingSnapshotSchema
>;
export type WorkspaceModelProfileView = z.infer<
  typeof WorkspaceModelProfileViewSchema
>;

export class ModelProfilesService {
  private readonly allowLocalDevelopmentBaseUrl: boolean;
  private readonly resources: ModelProfileResourceLifecyclePort | null;
  private readonly credentialStore: CredentialStorePort | null;
  private readonly adapterRegistry: ModelProviderAdapterRegistryPort | null;
  private readonly clock: () => Date;
  private readonly nextId: () => string;

  constructor(
    private readonly repository: ModelProfilesRepository,
    options: ModelProfilesServiceOptions = {},
    legacyClock: () => Date = () => new Date(),
  ) {
    this.allowLocalDevelopmentBaseUrl =
      options.allowLocalDevelopmentBaseUrl ?? false;
    this.resources = options.resources ?? null;
    this.credentialStore = options.credentialStore ?? null;
    this.adapterRegistry = options.adapterRegistry ?? null;
    this.clock = options.clock ?? legacyClock;
    this.nextId = options.nextId ?? randomUUID;
  }

  private now() {
    return this.clock().toISOString();
  }

  private publicCall<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      if (error instanceof ZodError) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Model profile request is invalid.",
          error.issues.slice(0, 100).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Model profile operation failed.",
      );
    }
  }

  private currentOrigin(record: StoredModelProfileRecord) {
    if (record.credentialOrigin !== null) return record.credentialOrigin;
    const normalized = tryNormalizeModelEndpoint({
      provider: record.provider,
      baseUrl: record.baseUrl,
      allowLocalDevelopmentBaseUrl: this.allowLocalDevelopmentBaseUrl,
    });
    return normalized?.canonicalOrigin ?? null;
  }

  private endpointBinding(
    record: StoredModelProfileRecord,
  ): EndpointBindingSnapshot {
    return EndpointBindingSnapshotSchema.parse({
      provider: record.provider,
      model: record.model,
      normalizedBaseUrl:
        record.baseUrl ?? defaultBaseUrlForProvider(record.provider) ?? null,
      canonicalOrigin: this.currentOrigin(record),
      executionRevision: record.executionRevision,
      profileUpdatedAt: record.updatedAt,
    });
  }

  private runtimeDescriptor(record: StoredModelProfileRecord) {
    const binding = this.endpointBinding(record);
    const defaultBaseUrl = defaultBaseUrlForProvider(record.provider);
    if (
      binding.normalizedBaseUrl !== null &&
      binding.normalizedBaseUrl !== defaultBaseUrl
    ) {
      return null;
    }
    return (
      this.adapterRegistry?.lookup({
        provider: binding.provider,
        model: binding.model,
        normalizedBaseUrl: binding.normalizedBaseUrl,
        canonicalOrigin: binding.canonicalOrigin,
      }) ?? null
    );
  }

  private adapterReady(record: StoredModelProfileRecord) {
    const runtime = this.runtimeDescriptor(record);
    return Boolean(
      runtime?.runtimeWired === true &&
      typeof runtime.handleRequest === "function",
    );
  }

  private credentialResolverReady() {
    return this.credentialStore !== null;
  }

  private toPublicModel(record: StoredModelProfileRecord): ModelProfile {
    const runtime = this.runtimeDescriptor(record);
    const adapterReady = this.adapterReady(record);
    const credentialResolverReady = this.credentialResolverReady();
    return {
      id: record.id,
      name: record.name,
      provider: record.provider,
      model: record.model,
      baseUrl: record.baseUrl,
      credentialStatus: record.credentialStatus,
      contextWindowTokens: record.contextWindowTokens,
      maxOutputTokens: record.maxOutputTokens,
      enabled: record.enabled,
      capabilities:
        adapterReady && credentialResolverReady && runtime
          ? runtime.capabilities
          : DISABLED_RUNTIME_MODEL_CAPABILITIES,
      isDefault: record.isDefault,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private describeStored(
    record: StoredModelProfileRecord,
  ): WorkspaceModelProfileView {
    const canonicalOrigin = this.currentOrigin(record);
    const runtime = this.runtimeDescriptor(record);
    const adapterReady = this.adapterReady(record);
    const credentialResolverReady = this.credentialResolverReady();
    const availability = availabilityForModelProfile({
      enabled: record.enabled,
      credentialState: record.credentialState,
      canonicalOrigin,
      adapterReady,
      credentialResolverReady,
    });
    return WorkspaceModelProfileViewSchema.parse({
      id: record.id,
      name: record.name,
      provider: record.provider,
      model: record.model,
      baseUrl: record.baseUrl,
      credentialStatus: record.credentialStatus,
      contextWindowTokens: record.contextWindowTokens,
      maxOutputTokens: record.maxOutputTokens,
      enabled: record.enabled,
      capabilities:
        adapterReady && credentialResolverReady && runtime
          ? runtime.capabilities
          : DISABLED_RUNTIME_MODEL_CAPABILITIES,
      isDefault: record.isDefault,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      credential: {
        status: record.credentialState,
        configured: record.credentialState === "configured",
        canonicalOrigin,
      },
      endpointBinding: this.endpointBinding(record),
      availability,
      requiresCredential: true,
    });
  }

  private stopActiveJobs(
    jobs: readonly ActiveModelProfileJob[],
    reason: string,
    failureMessage: string,
  ) {
    if (!jobs.length) return;
    if (!this.resources) {
      throw new WorkspaceApiError(409, "CONFLICT", failureMessage);
    }
    const queued = jobs
      .filter((job) => job.status === "queued")
      .map((job) => job.id);
    const running = jobs
      .filter((job) => job.status === "running")
      .map((job) => job.id);
    try {
      if (queued.length) this.resources.cancelQueued(queued, reason);
      if (running.length) this.resources.requestAbortRunning(running, reason);
    } catch {
      throw new WorkspaceApiError(409, "CONFLICT", failureMessage);
    }
  }

  private queueCredentialOrphanCleanup(
    reference: string | null,
    record: {
      id: string;
      provider: ModelProfile["provider"];
      canonicalOrigin: string | null;
    },
    reason:
      | "binding_change"
      | "credential_clear"
      | "credential_replace"
      | "credential_cas_rollback"
      | "profile_delete",
  ) {
    if (!reference) return;
    this.repository.queueCredentialOrphanCleanup({
      reference,
      profileId: record.id,
      provider: record.provider,
      canonicalOrigin: record.canonicalOrigin,
      reason,
      now: this.now(),
    });
  }

  private deleteCredentialBestEffort(
    reference: string | null,
    record: {
      id: string;
      provider: ModelProfile["provider"];
      canonicalOrigin: string | null;
    },
    reason:
      | "binding_change"
      | "credential_clear"
      | "credential_replace"
      | "credential_cas_rollback"
      | "profile_delete",
  ) {
    if (!reference || !this.credentialStore) {
      this.queueCredentialOrphanCleanup(reference, record, reason);
      return;
    }
    if (this.repository.isCredentialReferenceBound(reference)) {
      return;
    }
    try {
      this.credentialStore.delete(reference);
    } catch {
      this.queueCredentialOrphanCleanup(reference, record, reason);
    }
  }

  reconcileCredentialOrphans() {
    return this.publicCall(() => {
      this.requireCredentialLifecycleDormant(
        "Credential lifecycle reconciliation is unavailable until the production credential bridge is completed.",
      );
    });
  }

  private normalizeProfileInput(
    provider: ModelProfile["provider"],
    baseUrl: string | null | undefined,
  ) {
    return normalizeModelEndpoint({
      provider,
      baseUrl,
      allowLocalDevelopmentBaseUrl: this.allowLocalDevelopmentBaseUrl,
    });
  }

  private runtimeExecutionEnabled() {
    return false;
  }

  private requireRuntimeExecutionEnabled(message: string) {
    if (!this.runtimeExecutionEnabled()) {
      throw new WorkspaceApiError(409, "CONFLICT", message);
    }
  }

  private requireCredentialLifecycleDormant(message: string) {
    throw new WorkspaceApiError(409, "CONFLICT", message);
  }

  capabilities() {
    return {
      schemaVersion: "vera-workspace-model-settings-v1" as const,
      localOnly: true,
      loopbackHttpAllowed: this.allowLocalDevelopmentBaseUrl,
      credentialWriteEnabled: false,
      secretReadbackSupported: false,
      runtimeWired: false,
    };
  }

  list() {
    return this.publicCall(() =>
      this.repository.listStored().map((record) => this.toPublicModel(record)),
    );
  }

  listViews() {
    return this.publicCall(() =>
      this.repository.listStored().map((record) => this.describeStored(record)),
    );
  }

  get(id: string) {
    return this.publicCall(() =>
      this.toPublicModel(this.repository.requireStored(id)),
    );
  }

  getView(id: string) {
    return this.publicCall(() =>
      this.describeStored(this.repository.requireStored(id)),
    );
  }

  create(value: unknown) {
    return this.publicCall(() => {
      const input = CreateModelProfileRequestSchema.parse(value);
      if (input.enabled === true) {
        this.requireRuntimeExecutionEnabled(
          "Model runtime wiring is unavailable; enabled profiles must remain dormant.",
        );
      }
      if (input.isDefault === true) {
        this.requireRuntimeExecutionEnabled(
          "Model runtime wiring is unavailable; selecting a default profile is disabled.",
        );
      }
      const normalized = this.normalizeProfileInput(
        input.provider,
        input.baseUrl,
      );
      const created = this.repository.create({
        id: this.nextId(),
        name: input.name,
        provider: input.provider,
        model: input.model,
        baseUrl: normalized.baseUrl,
        credentialOrigin: normalized.canonicalOrigin,
        credentialState: "missing",
        contextWindowTokens: input.contextWindowTokens ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        enabled: input.enabled ?? false,
        isDefault: false,
        capabilities: input.capabilities ?? {
          streaming: false,
          toolCalling: false,
          structuredOutput: false,
          vision: false,
        },
        now: this.now(),
      });
      return this.toPublicModel(this.repository.requireStored(created.id));
    });
  }

  update(id: string, value: unknown) {
    return this.publicCall(() => {
      const input = UpdateModelProfileRequestSchema.parse(value);
      const current = this.repository.requireStored(id);
      const provider = input.provider ?? current.provider;
      const normalized = this.normalizeProfileInput(
        provider,
        input.baseUrl === undefined ? current.baseUrl : input.baseUrl,
      );
      if (input.enabled === true && current.enabled === false) {
        this.requireRuntimeExecutionEnabled(
          "Model runtime wiring is unavailable; enabling profiles is disabled.",
        );
      }
      if (input.isDefault === true && current.isDefault === false) {
        this.requireRuntimeExecutionEnabled(
          "Model runtime wiring is unavailable; selecting a default profile is disabled.",
        );
      }
      const currentOrigin = this.currentOrigin(current);
      const bindingChanged =
        provider !== current.provider ||
        normalized.baseUrl !== current.baseUrl ||
        normalized.canonicalOrigin !== currentOrigin;
      const modelChanged =
        input.model !== undefined && input.model !== current.model;
      const disableRequested = input.enabled === false && current.enabled;
      const executionBindingChanged =
        bindingChanged || modelChanged || disableRequested;
      if (bindingChanged && current.credentialRef !== null) {
        this.requireCredentialLifecycleDormant(
          "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
        );
      }
      const now = this.now();
      if (executionBindingChanged) {
        const failureMessage =
          bindingChanged || modelChanged
            ? "Model profile has active jobs and could not be rebound safely."
            : "Model profile has active jobs and could not be disabled safely.";
        this.stopActiveJobs(
          this.repository.listActiveJobsForProfile(id),
          bindingChanged || modelChanged
            ? "Model profile execution binding change requested."
            : "Model profile disable requested.",
          failureMessage,
        );
        const updated = this.repository.updateWithActiveJobBarrier(
          id,
          {
            ...input,
            provider,
            baseUrl: normalized.baseUrl,
            credentialOrigin: normalized.canonicalOrigin,
            ...(bindingChanged
              ? {
                  credentialRef: null,
                  credentialState: "missing" as const,
                }
              : {}),
            now,
          },
          failureMessage,
        );
        if (bindingChanged) {
          this.deleteCredentialBestEffort(
            current.credentialRef,
            {
              id: current.id,
              provider: current.provider,
              canonicalOrigin: currentOrigin,
            },
            "binding_change",
          );
        }
        return this.toPublicModel(this.repository.requireStored(updated.id));
      }
      const updated = this.repository.update(id, {
        ...input,
        provider,
        baseUrl: normalized.baseUrl,
        credentialOrigin: normalized.canonicalOrigin,
        now,
      });
      return this.toPublicModel(this.repository.requireStored(updated.id));
    });
  }

  enable(id: string) {
    return this.publicCall(() => {
      this.requireRuntimeExecutionEnabled(
        "Model runtime wiring is unavailable; enabling profiles is disabled.",
      );
      const updated = this.repository.enableWithActiveJobBarrier(
        id,
        true,
        this.now(),
        "",
      );
      return this.toPublicModel(this.repository.requireStored(updated.id));
    });
  }

  disable(id: string) {
    return this.publicCall(() => {
      this.repository.requireStored(id);
      this.stopActiveJobs(
        this.repository.listActiveJobsForProfile(id),
        "Model profile disable requested.",
        "Model profile has active jobs and could not be disabled safely.",
      );
      const updated = this.repository.enableWithActiveJobBarrier(
        id,
        false,
        this.now(),
        "Model profile has active jobs and could not be disabled safely.",
      );
      return this.toPublicModel(this.repository.requireStored(updated.id));
    });
  }

  setDefault(id: string) {
    return this.publicCall(() => {
      this.requireRuntimeExecutionEnabled(
        "Model runtime wiring is unavailable; selecting a default profile is disabled.",
      );
      const updated = this.repository.setDefault(id, this.now());
      return this.toPublicModel(this.repository.requireStored(updated.id));
    });
  }

  delete(id: string) {
    return this.publicCall(() => {
      const current = this.repository.requireStored(id);
      if (current.credentialRef !== null) {
        this.requireCredentialLifecycleDormant(
          "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
        );
      }
      this.stopActiveJobs(
        this.repository.listActiveJobsForProfile(id),
        "Model profile deletion requested.",
        "Model profile has active jobs and could not be deleted safely.",
      );
      this.repository.deleteWithActiveJobBarrier(
        id,
        this.now(),
        "Model profile has active jobs and could not be deleted safely.",
      );
      this.deleteCredentialBestEffort(
        current.credentialRef,
        {
          id: current.id,
          provider: current.provider,
          canonicalOrigin: this.currentOrigin(current),
        },
        "profile_delete",
      );
    });
  }

  configureCredential(id: string, value: unknown) {
    return this.publicCall(() => {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
      );
    });
  }

  clearCredential(id: string) {
    return this.publicCall(() => {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
      );
    });
  }

  markCredentialInvalid(id: string) {
    return this.publicCall(() => {
      const current = this.repository.requireStored(id);
      const updated = this.repository.setCredentialBindingInternal(id, {
        reference: current.credentialRef,
        state: "invalid",
        origin: this.currentOrigin(current),
        now: this.now(),
      });
      return this.describeStored(updated);
    });
  }
}
