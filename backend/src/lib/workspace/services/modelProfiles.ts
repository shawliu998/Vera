import { randomBytes, randomUUID } from "node:crypto";

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
  type CredentialCleanupIntent,
  type StoredModelProfileRecord,
} from "../repositories/modelProfiles";
import type { ModelProfile } from "../types";
import {
  buildStoredCredentialReference,
  canonicalizeStoredCredentialReference,
  CREDENTIAL_STORE_OPERATION_MODE,
  CredentialStoreCollisionError,
  MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
  parseStoredCredentialReference,
  type CredentialBindingKey,
  type CredentialStorePort,
  type SynchronousCredentialStorePort,
} from "./credentialStore";

const MAX_CREDENTIAL_LOCATOR_ALLOCATION_ATTEMPTS = 8;
const CREDENTIAL_LOCATOR_ALLOCATION_ERROR =
  "Credential locator allocation failed.";
const CREDENTIAL_CLEANUP_INTENT_ERROR =
  "Credential cleanup intent could not be persisted.";
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
          Buffer.byteLength(value, "utf8") <=
          MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
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
const CredentialProbeSnapshotSchema = EndpointBindingSnapshotSchema.pick({
  provider: true,
  canonicalOrigin: true,
  executionRevision: true,
})
  .extend({
    canonicalOrigin: z.string().min(1),
    credentialRef: z.string().min(1),
    credentialState: z.literal("configured"),
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
  runtimeWired?: boolean;
  resources?: ModelProfileResourceLifecyclePort;
  credentialStore?: CredentialStorePort;
  adapterRegistry?: ModelProviderAdapterRegistryPort;
  clock?: () => Date;
  nextId?: () => string;
  nextCredentialLocatorId?: () => string;
};

export type EndpointBindingSnapshot = z.infer<
  typeof EndpointBindingSnapshotSchema
>;
export type CredentialProbeSnapshot = z.infer<
  typeof CredentialProbeSnapshotSchema
>;
export type WorkspaceModelProfileView = z.infer<
  typeof WorkspaceModelProfileViewSchema
>;

export class ModelProfilesService {
  private readonly allowLocalDevelopmentBaseUrl: boolean;
  private readonly runtimeWired: boolean;
  private readonly resources: ModelProfileResourceLifecyclePort | null;
  private readonly credentialStore: CredentialStorePort | null;
  private readonly adapterRegistry: ModelProviderAdapterRegistryPort | null;
  private readonly clock: () => Date;
  private readonly nextId: () => string;
  private readonly nextCredentialLocatorId: () => string;

  constructor(
    private readonly repository: ModelProfilesRepository,
    options: ModelProfilesServiceOptions = {},
    legacyClock: () => Date = () => new Date(),
  ) {
    this.allowLocalDevelopmentBaseUrl =
      options.allowLocalDevelopmentBaseUrl ?? false;
    this.runtimeWired = options.runtimeWired ?? false;
    this.resources = options.resources ?? null;
    this.credentialStore = options.credentialStore ?? null;
    this.adapterRegistry = options.adapterRegistry ?? null;
    this.clock = options.clock ?? legacyClock;
    this.nextId = options.nextId ?? randomUUID;
    this.nextCredentialLocatorId =
      options.nextCredentialLocatorId ??
      (() => randomBytes(32).toString("hex"));
  }

  private now() {
    return this.clock().toISOString();
  }

  private normalizePublicError(error: unknown): never {
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

  private publicCall<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      return this.normalizePublicError(error);
    }
  }

  private async publicCallAsync<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      return this.normalizePublicError(error);
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

  private allocateCredentialReference(
    profileId: string,
    currentReference: string | null,
  ) {
    const reservedReferences = new Set(
      this.repository
        .listCredentialOrphanCleanups()
        .map(
          (cleanup) =>
            canonicalizeStoredCredentialReference(cleanup.reference) ??
            cleanup.reference.toLowerCase(),
        ),
    );
    if (currentReference) {
      reservedReferences.add(
        canonicalizeStoredCredentialReference(currentReference) ??
          currentReference.toLowerCase(),
      );
    }
    for (
      let attempt = 0;
      attempt < MAX_CREDENTIAL_LOCATOR_ALLOCATION_ATTEMPTS;
      attempt += 1
    ) {
      let reference: string;
      try {
        reference = buildStoredCredentialReference(
          profileId,
          this.nextCredentialLocatorId(),
        );
      } catch {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          CREDENTIAL_LOCATOR_ALLOCATION_ERROR,
        );
      }
      const parsed = parseStoredCredentialReference(reference, profileId);
      if (!parsed?.locatorId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          CREDENTIAL_LOCATOR_ALLOCATION_ERROR,
        );
      }
      const referenceIdentity = canonicalizeStoredCredentialReference(
        reference,
        profileId,
      );
      if (
        !referenceIdentity ||
        reservedReferences.has(referenceIdentity) ||
        this.repository.isCredentialReferenceBound(reference)
      ) {
        continue;
      }
      return reference;
    }
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      CREDENTIAL_LOCATOR_ALLOCATION_ERROR,
    );
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
      record.provider !== "openai_compatible" &&
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
    return Boolean(runtime?.runtimeWired === true);
  }

  private credentialResolverReady() {
    try {
      return this.credentialStore?.isAvailable() === true;
    } catch {
      return false;
    }
  }

  private effectiveCapabilities(
    record: StoredModelProfileRecord,
    runtime: ReturnType<ModelProfilesService["runtimeDescriptor"]>,
    available: boolean,
  ): ModelProfile["capabilities"] {
    if (!available || !runtime) return DISABLED_RUNTIME_MODEL_CAPABILITIES;
    return {
      streaming:
        record.capabilities.streaming && runtime.capabilities.streaming,
      toolCalling:
        record.capabilities.toolCalling && runtime.capabilities.toolCalling,
      structuredOutput:
        record.capabilities.structuredOutput &&
        runtime.capabilities.structuredOutput,
      vision: record.capabilities.vision && runtime.capabilities.vision,
    };
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
      capabilities: this.effectiveCapabilities(
        record,
        runtime,
        adapterReady && credentialResolverReady,
      ),
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
      capabilities: this.effectiveCapabilities(
        record,
        runtime,
        adapterReady && credentialResolverReady,
      ),
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

  private persistCredentialCleanupIntent(
    reference: string,
    binding: CredentialBindingKey,
  ) {
    const canonicalReference = canonicalizeStoredCredentialReference(
      reference,
      binding.profileId,
    );
    if (!canonicalReference) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        CREDENTIAL_CLEANUP_INTENT_ERROR,
      );
    }
    this.repository.queueCredentialOrphanCleanup({
      reference: canonicalReference,
      profileId: binding.profileId,
      provider: binding.provider,
      canonicalOrigin: binding.canonicalOrigin,
      reason: "credential_cas_rollback",
      now: this.now(),
    });
    const persisted = this.repository
      .listCredentialOrphanCleanups()
      .find(
        (cleanup) =>
          canonicalizeStoredCredentialReference(
            cleanup.reference,
            binding.profileId,
          ) === canonicalReference,
      );
    if (
      !persisted ||
      persisted.profileId?.toLowerCase() !== binding.profileId.toLowerCase() ||
      persisted.provider !== binding.provider ||
      persisted.canonicalOrigin !== binding.canonicalOrigin ||
      persisted.reason !== "credential_cas_rollback"
    ) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        CREDENTIAL_CLEANUP_INTENT_ERROR,
      );
    }
  }

  private deleteCredentialCleanupBestEffort(
    cleanup: CredentialCleanupIntent | null,
  ) {
    if (!cleanup) return;
    this.deleteCredentialBestEffort(
      cleanup.reference,
      {
        id: cleanup.profileId,
        provider: cleanup.provider,
        canonicalOrigin: cleanup.canonicalOrigin,
      },
      cleanup.reason,
    );
  }

  private async deleteCredentialCleanupBestEffortAsync(
    cleanup: CredentialCleanupIntent | null,
  ) {
    if (!cleanup) return;
    await this.deleteCredentialBestEffortAsync(
      cleanup.reference,
      {
        id: cleanup.profileId,
        provider: cleanup.provider,
        canonicalOrigin: cleanup.canonicalOrigin,
      },
      cleanup.reason,
    );
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
    const credentialStore = this.synchronousCredentialStoreOrNull();
    if (!reference || !credentialStore) {
      this.queueCredentialOrphanCleanup(reference, record, reason);
      return;
    }
    if (this.repository.isCredentialReferenceBound(reference)) {
      return;
    }
    if (
      !record.canonicalOrigin ||
      !parseStoredCredentialReference(reference, record.id)?.locatorId
    ) {
      this.queueCredentialOrphanCleanup(reference, record, reason);
      return;
    }
    const binding: CredentialBindingKey = {
      profileId: record.id,
      provider: record.provider,
      canonicalOrigin: record.canonicalOrigin,
    };
    try {
      credentialStore.delete({ reference, binding });
      this.repository.clearCredentialOrphanCleanup(reference);
    } catch {
      this.queueCredentialOrphanCleanup(reference, record, reason);
    }
  }

  private async deleteCredentialBestEffortAsync(
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
    if (!reference || !this.credentialStoreReady()) {
      this.queueCredentialOrphanCleanup(reference, record, reason);
      return;
    }
    if (this.repository.isCredentialReferenceBound(reference)) return;
    if (
      !record.canonicalOrigin ||
      !parseStoredCredentialReference(reference, record.id)?.locatorId
    ) {
      this.queueCredentialOrphanCleanup(reference, record, reason);
      return;
    }
    const binding: CredentialBindingKey = {
      profileId: record.id,
      provider: record.provider,
      canonicalOrigin: record.canonicalOrigin,
    };
    try {
      await Promise.resolve(
        this.credentialStore!.delete({ reference, binding }),
      );
      this.repository.clearCredentialOrphanCleanup(reference);
    } catch {
      this.queueCredentialOrphanCleanup(reference, record, reason);
    }
  }

  reconcileCredentialOrphans() {
    return this.publicCall(() => {
      const credentialStore = this.requireSynchronousCredentialStore(
        "Credential lifecycle reconciliation is unavailable until the production credential bridge is completed.",
      );
      let deleted = 0;
      let rebound = 0;
      let failed = 0;
      for (const cleanup of this.repository.listCredentialOrphanCleanups()) {
        if (this.repository.isCredentialReferenceBound(cleanup.reference)) {
          this.repository.clearCredentialOrphanCleanup(cleanup.reference);
          rebound += 1;
          continue;
        }
        if (
          !cleanup.profileId ||
          !cleanup.provider ||
          !cleanup.canonicalOrigin ||
          !parseStoredCredentialReference(cleanup.reference, cleanup.profileId)
            ?.locatorId
        ) {
          this.repository.markCredentialOrphanCleanupFailed(
            cleanup.reference,
            "Credential cleanup binding is incomplete.",
            this.now(),
          );
          failed += 1;
          continue;
        }
        try {
          credentialStore.delete({
            reference: cleanup.reference,
            binding: {
              profileId: cleanup.profileId,
              provider: cleanup.provider,
              canonicalOrigin: cleanup.canonicalOrigin,
            },
          });
          this.repository.clearCredentialOrphanCleanup(cleanup.reference);
          deleted += 1;
        } catch {
          this.repository.markCredentialOrphanCleanupFailed(
            cleanup.reference,
            "Credential cleanup failed.",
            this.now(),
          );
          failed += 1;
        }
      }
      return { deleted, rebound, failed };
    });
  }

  reconcileCredentialOrphansAsync() {
    return this.publicCallAsync(async () => {
      const credentialStore = this.requireCredentialStore(
        "Credential lifecycle reconciliation is unavailable until the production credential bridge is completed.",
      );
      let deleted = 0;
      let rebound = 0;
      let failed = 0;
      for (const cleanup of this.repository.listCredentialOrphanCleanups()) {
        if (this.repository.isCredentialReferenceBound(cleanup.reference)) {
          this.repository.clearCredentialOrphanCleanup(cleanup.reference);
          rebound += 1;
          continue;
        }
        if (
          !cleanup.profileId ||
          !cleanup.provider ||
          !cleanup.canonicalOrigin ||
          !parseStoredCredentialReference(cleanup.reference, cleanup.profileId)
            ?.locatorId
        ) {
          this.repository.markCredentialOrphanCleanupFailed(
            cleanup.reference,
            "Credential cleanup binding is incomplete.",
            this.now(),
          );
          failed += 1;
          continue;
        }
        try {
          await Promise.resolve(
            credentialStore.delete({
              reference: cleanup.reference,
              binding: {
                profileId: cleanup.profileId,
                provider: cleanup.provider,
                canonicalOrigin: cleanup.canonicalOrigin,
              },
            }),
          );
          this.repository.clearCredentialOrphanCleanup(cleanup.reference);
          deleted += 1;
        } catch {
          this.repository.markCredentialOrphanCleanupFailed(
            cleanup.reference,
            "Credential cleanup failed.",
            this.now(),
          );
          failed += 1;
        }
      }
      return { deleted, rebound, failed };
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
    return this.runtimeWired && this.credentialStoreReady();
  }

  private requireRuntimeExecutionEnabled(message: string) {
    if (!this.runtimeExecutionEnabled()) {
      throw new WorkspaceApiError(409, "CONFLICT", message);
    }
  }

  private credentialStoreReady() {
    return this.credentialResolverReady();
  }

  private synchronousCredentialStoreOrNull() {
    if (
      !this.credentialStoreReady() ||
      this.credentialStore?.[CREDENTIAL_STORE_OPERATION_MODE] !== "synchronous"
    ) {
      return null;
    }
    return this.credentialStore as SynchronousCredentialStorePort;
  }

  private requireCredentialStore(message: string) {
    if (!this.credentialStoreReady()) {
      throw new WorkspaceApiError(409, "CONFLICT", message);
    }
    return this.credentialStore!;
  }

  private requireSynchronousCredentialStore(message: string) {
    const credentialStore = this.requireCredentialStore(message);
    if (credentialStore[CREDENTIAL_STORE_OPERATION_MODE] !== "synchronous") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Credential lifecycle mutation requires the asynchronous service method.",
      );
    }
    return credentialStore as SynchronousCredentialStorePort;
  }

  capabilities() {
    return {
      schemaVersion: "vera-workspace-model-settings-v1" as const,
      localOnly: true,
      loopbackHttpAllowed: this.allowLocalDevelopmentBaseUrl,
      credentialWriteEnabled: this.credentialStoreReady(),
      secretReadbackSupported: false,
      runtimeWired: this.runtimeExecutionEnabled(),
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
      const capabilitiesChanged =
        input.capabilities !== undefined &&
        JSON.stringify(input.capabilities) !==
          JSON.stringify(current.capabilities);
      const disableRequested = input.enabled === false && current.enabled;
      const executionBindingChanged =
        bindingChanged ||
        modelChanged ||
        capabilitiesChanged ||
        disableRequested;
      if (bindingChanged && current.credentialRef !== null) {
        this.requireSynchronousCredentialStore(
          "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
        );
      }
      const now = this.now();
      if (executionBindingChanged) {
        const failureMessage =
          bindingChanged || modelChanged || capabilitiesChanged
            ? "Model profile has active jobs and could not be rebound safely."
            : "Model profile has active jobs and could not be disabled safely.";
        this.stopActiveJobs(
          this.repository.listActiveJobsForProfile(id),
          bindingChanged || modelChanged || capabilitiesChanged
            ? "Model profile execution binding change requested."
            : "Model profile disable requested.",
          failureMessage,
        );
        const updateInput = {
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
        };
        if (bindingChanged) {
          const { profile, cleanup } =
            this.repository.updateBindingWithActiveJobBarrierAndCleanupIntent(
              id,
              updateInput,
              failureMessage,
            );
          this.deleteCredentialCleanupBestEffort(cleanup);
          return this.toPublicModel(this.repository.requireStored(profile.id));
        }
        const updated = this.repository.updateWithActiveJobBarrier(
          id,
          updateInput,
          failureMessage,
        );
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

  updateAsync(id: string, value: unknown) {
    return this.publicCallAsync(async () => {
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
      const capabilitiesChanged =
        input.capabilities !== undefined &&
        JSON.stringify(input.capabilities) !==
          JSON.stringify(current.capabilities);
      const disableRequested = input.enabled === false && current.enabled;
      const executionBindingChanged =
        bindingChanged ||
        modelChanged ||
        capabilitiesChanged ||
        disableRequested;
      if (bindingChanged && current.credentialRef !== null) {
        this.requireCredentialStore(
          "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
        );
      }
      const now = this.now();
      if (executionBindingChanged) {
        const failureMessage =
          bindingChanged || modelChanged || capabilitiesChanged
            ? "Model profile has active jobs and could not be rebound safely."
            : "Model profile has active jobs and could not be disabled safely.";
        this.stopActiveJobs(
          this.repository.listActiveJobsForProfile(id),
          bindingChanged || modelChanged || capabilitiesChanged
            ? "Model profile execution binding change requested."
            : "Model profile disable requested.",
          failureMessage,
        );
        const updateInput = {
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
        };
        if (bindingChanged) {
          const { profile, cleanup } =
            this.repository.updateBindingWithActiveJobBarrierAndCleanupIntent(
              id,
              updateInput,
              failureMessage,
            );
          await this.deleteCredentialCleanupBestEffortAsync(cleanup);
          return this.toPublicModel(this.repository.requireStored(profile.id));
        }
        const updated = this.repository.updateWithActiveJobBarrier(
          id,
          updateInput,
          failureMessage,
        );
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
        this.requireSynchronousCredentialStore(
          "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
        );
      }
      this.stopActiveJobs(
        this.repository.listActiveJobsForProfile(id),
        "Model profile deletion requested.",
        "Model profile has active jobs and could not be deleted safely.",
      );
      const cleanup =
        this.repository.deleteWithActiveJobBarrierAndCleanupIntent(
          id,
          this.now(),
          "Model profile has active jobs and could not be deleted safely.",
        );
      this.deleteCredentialCleanupBestEffort(cleanup);
    });
  }

  deleteAsync(id: string) {
    return this.publicCallAsync(async () => {
      const current = this.repository.requireStored(id);
      if (current.credentialRef !== null) {
        this.requireCredentialStore(
          "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
        );
      }
      this.stopActiveJobs(
        this.repository.listActiveJobsForProfile(id),
        "Model profile deletion requested.",
        "Model profile has active jobs and could not be deleted safely.",
      );
      const cleanup =
        this.repository.deleteWithActiveJobBarrierAndCleanupIntent(
          id,
          this.now(),
          "Model profile has active jobs and could not be deleted safely.",
        );
      await this.deleteCredentialCleanupBestEffortAsync(cleanup);
    });
  }

  configureCredential(id: string, value: unknown) {
    return this.publicCall(() => {
      const credentialStore = this.requireSynchronousCredentialStore(
        "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
      );
      const input = CredentialSecretSchema.parse(value);
      const current = this.repository.requireStored(id);
      const canonicalOrigin = this.currentOrigin(current);
      if (!canonicalOrigin) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Model profile endpoint origin must be configured before storing a credential.",
        );
      }
      const binding: CredentialBindingKey = {
        profileId: current.id,
        provider: current.provider,
        canonicalOrigin,
      };
      const reference = this.allocateCredentialReference(
        current.id,
        current.credentialRef,
      );
      this.persistCredentialCleanupIntent(reference, binding);
      try {
        credentialStore.store({
          reference,
          binding,
          secret: input.secret,
        });
      } catch (error) {
        if (error instanceof CredentialStoreCollisionError) {
          this.repository.clearCredentialOrphanCleanup(reference);
        }
        throw error;
      }
      let updated: StoredModelProfileRecord;
      let replacedCredential: CredentialCleanupIntent | null;
      try {
        const result = this.repository.compareAndSetCredentialBindingInternal(
          current.id,
          {
            provider: current.provider,
            canonicalOrigin,
            executionRevision: current.executionRevision,
            credentialRef: current.credentialRef,
            credentialState: current.credentialState,
          },
          {
            reference,
            state: "configured",
            origin: canonicalOrigin,
            migrationIssueCode: null,
            cleanupIntentReference: reference,
            now: this.now(),
          },
        );
        updated = result.record;
        replacedCredential = result.cleanup;
      } catch (error) {
        this.deleteCredentialBestEffort(
          reference,
          {
            id: current.id,
            provider: current.provider,
            canonicalOrigin,
          },
          "credential_cas_rollback",
        );
        throw error;
      }
      this.deleteCredentialCleanupBestEffort(replacedCredential);
      return this.describeStored(updated);
    });
  }

  configureCredentialAsync(id: string, value: unknown) {
    return this.publicCallAsync(async () => {
      const credentialStore = this.requireCredentialStore(
        "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
      );
      const input = CredentialSecretSchema.parse(value);
      const current = this.repository.requireStored(id);
      const canonicalOrigin = this.currentOrigin(current);
      if (!canonicalOrigin) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Model profile endpoint origin must be configured before storing a credential.",
        );
      }
      const binding: CredentialBindingKey = {
        profileId: current.id,
        provider: current.provider,
        canonicalOrigin,
      };
      const reference = this.allocateCredentialReference(
        current.id,
        current.credentialRef,
      );
      this.persistCredentialCleanupIntent(reference, binding);
      try {
        await Promise.resolve(
          credentialStore.store({
            reference,
            binding,
            secret: input.secret,
          }),
        );
      } catch (error) {
        if (error instanceof CredentialStoreCollisionError) {
          this.repository.clearCredentialOrphanCleanup(reference);
        }
        throw error;
      }
      let updated: StoredModelProfileRecord;
      let replacedCredential: CredentialCleanupIntent | null;
      try {
        const result = this.repository.compareAndSetCredentialBindingInternal(
          current.id,
          {
            provider: current.provider,
            canonicalOrigin,
            executionRevision: current.executionRevision,
            credentialRef: current.credentialRef,
            credentialState: current.credentialState,
          },
          {
            reference,
            state: "configured",
            origin: canonicalOrigin,
            migrationIssueCode: null,
            cleanupIntentReference: reference,
            now: this.now(),
          },
        );
        updated = result.record;
        replacedCredential = result.cleanup;
      } catch (error) {
        await this.deleteCredentialBestEffortAsync(
          reference,
          {
            id: current.id,
            provider: current.provider,
            canonicalOrigin,
          },
          "credential_cas_rollback",
        );
        throw error;
      }
      await this.deleteCredentialCleanupBestEffortAsync(replacedCredential);
      return this.describeStored(updated);
    });
  }

  clearCredential(id: string) {
    return this.publicCall(() => {
      this.requireSynchronousCredentialStore(
        "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
      );
      const { record, cleanup } =
        this.repository.clearCredentialBindingWithCleanupIntent(id, this.now());
      this.deleteCredentialCleanupBestEffort(cleanup);
      return this.describeStored(record);
    });
  }

  clearCredentialAsync(id: string) {
    return this.publicCallAsync(async () => {
      this.requireCredentialStore(
        "Credential lifecycle mutations are unavailable until the production credential bridge is completed.",
      );
      const { record, cleanup } =
        this.repository.clearCredentialBindingWithCleanupIntent(id, this.now());
      await this.deleteCredentialCleanupBestEffortAsync(cleanup);
      return this.describeStored(record);
    });
  }

  markCredentialInvalid(id: string, probeSnapshot: unknown) {
    return this.publicCall(() => {
      const expected = CredentialProbeSnapshotSchema.parse(probeSnapshot);
      const credentialRef = canonicalizeStoredCredentialReference(
        expected.credentialRef,
        id,
      );
      if (!credentialRef) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Credential probe snapshot is invalid.",
        );
      }
      const updated = this.repository.compareAndSetCredentialInvalid(
        id,
        { ...expected, credentialRef },
        this.now(),
      );
      return this.describeStored(updated);
    });
  }
}
