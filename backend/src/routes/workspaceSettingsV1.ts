import { Router, type RequestHandler, type Response } from "express";
import { ZodError, z } from "zod";

import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  ExecutionLocationSchema,
  ModelRetentionSchema,
  ModelTrainingUseSchema,
} from "../lib/workspace/inferencePolicy";
import { MODEL_CONNECTION_TEST_ERROR_CODES } from "../lib/workspace/modelConnectionReadiness";
import { MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES } from "../lib/workspace/services/credentialStore";

const Uuid = z.string().uuid();
const StrictUtcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  });
const EmptyBody = z.object({}).strict();
const Provider = z.enum([
  "openai",
  "deepseek",
  "anthropic",
  "gemini",
  "openai_compatible",
]);
const ModelCapabilities = z
  .object({
    streaming: z.boolean(),
    toolCalling: z.boolean(),
    structuredOutput: z.boolean(),
    vision: z.boolean(),
  })
  .strict();
const ModelCreateBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    provider: Provider,
    model: z.string().trim().min(1).max(200),
    base_url: z.string().trim().min(1).max(500).nullable().optional(),
    context_window_tokens: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .nullable()
      .optional(),
    max_output_tokens: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .nullable()
      .optional(),
    capabilities: ModelCapabilities.optional(),
  })
  .strict();
const ModelPatchBody = ModelCreateBody.partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );
const ModelPrivacyPatchBody = z
  .object({
    execution_location: ExecutionLocationSchema.optional(),
    retention: ModelRetentionSchema.optional(),
    training_use: ModelTrainingUseSchema.optional(),
    sensitive_data_allowed: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one privacy update is required",
  );
const CredentialBody = z
  .object({
    secret: z
      .string()
      .min(1)
      .refine((value) => !/[\r\n]/.test(value), "secret is invalid")
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <=
          MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
        "secret is too large",
      ),
  })
  .strict();
const SettingsPatchBody = z
  .object({
    locale: z.enum(["zh-CN", "en-US"]).optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    default_model_profile_id: Uuid.nullable().optional(),
    default_project_id: Uuid.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );
const CapabilitiesWireSchema = z
  .object({
    schema_version: z.literal("vera-workspace-model-settings-v1"),
    settings_available: z.boolean(),
    local_only: z.literal(true),
    loopback_http_allowed: z.boolean(),
    supported_providers: z.array(Provider).max(5),
    credential_write_enabled: z.boolean(),
    secret_readback_supported: z.literal(false),
    runtime_wired: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.supported_providers).size !==
      value.supported_providers.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supported_providers"],
        message: "supported providers must be unique",
      });
    }
    if (
      value.settings_available &&
      (!value.runtime_wired || !value.credential_write_enabled)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settings_available"],
        message: "settings availability requires complete runtime wiring",
      });
    }
  });
const EndpointBindingWireSchema = z
  .object({
    provider: Provider,
    model: z.string().min(1).max(200),
    normalized_base_url: z.string().min(1).max(500).nullable(),
    canonical_origin: z.string().min(1).max(500).nullable(),
    execution_revision: z.number().int().nonnegative(),
    connection_revision: z.number().int().min(0).max(2_147_483_647),
    profile_updated_at: StrictUtcTimestamp,
  })
  .strict();
const ConnectionTestWireSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("untested"),
        error_code: z.null(),
        retryable: z.literal(false),
        latency_ms: z.null(),
        tested_at: z.null(),
      })
      .strict(),
    z
      .object({
        status: z.literal("passed"),
        error_code: z.null(),
        retryable: z.literal(false),
        latency_ms: z.number().int().min(0).max(600_000).nullable(),
        tested_at: StrictUtcTimestamp,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        error_code: z.enum(MODEL_CONNECTION_TEST_ERROR_CODES),
        retryable: z.boolean(),
        latency_ms: z.number().int().min(0).max(600_000).nullable(),
        tested_at: StrictUtcTimestamp,
      })
      .strict(),
    z
      .object({
        status: z.literal("stale"),
        error_code: z.enum(MODEL_CONNECTION_TEST_ERROR_CODES).nullable(),
        retryable: z.boolean(),
        latency_ms: z.number().int().min(0).max(600_000).nullable(),
        tested_at: StrictUtcTimestamp,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.status === "stale" &&
      value.error_code === null &&
      value.retryable
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryable"],
        message: "a retryable stale result requires an error code",
      });
    }
  });
const ModelWireSchema = z
  .object({
    id: Uuid,
    name: z.string().min(1).max(120),
    provider: Provider,
    model: z.string().min(1).max(200),
    base_url: z.string().min(1).max(500).nullable(),
    context_window_tokens: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .nullable(),
    max_output_tokens: z.number().int().positive().max(10_000_000).nullable(),
    enabled: z.boolean(),
    is_default: z.boolean(),
    created_at: StrictUtcTimestamp,
    updated_at: StrictUtcTimestamp,
    capabilities: ModelCapabilities,
    credential: z
      .object({
        status: z.enum(["configured", "missing", "invalid"]),
        configured: z.boolean(),
        canonical_origin: z.string().min(1).max(500).nullable(),
      })
      .strict(),
    endpoint_binding: EndpointBindingWireSchema,
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
    connection_test: ConnectionTestWireSchema,
    requires_credential: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.credential.configured !==
      (value.credential.status === "configured")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credential", "configured"],
        message: "credential status is inconsistent",
      });
    }
    if (
      value.provider !== value.endpoint_binding.provider ||
      value.model !== value.endpoint_binding.model ||
      value.updated_at !== value.endpoint_binding.profile_updated_at ||
      value.credential.canonical_origin !==
        value.endpoint_binding.canonical_origin
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoint_binding"],
        message: "endpoint binding is inconsistent",
      });
    }
    if (
      value.availability.selectable !==
        (value.availability.status === "ready") ||
      (!value.enabled && value.availability.status !== "disabled") ||
      (value.enabled && value.connection_test.status !== "passed") ||
      (value.is_default &&
        (!value.enabled ||
          !value.availability.selectable ||
          value.connection_test.status !== "passed"))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availability"],
        message: "model readiness state is inconsistent",
      });
    }
  });
const SettingsWireSchema = z
  .object({
    locale: z.enum(["zh-CN", "en-US"]),
    theme: z.enum(["system", "light", "dark"]),
    default_model_profile_id: Uuid.nullable(),
    default_project_id: Uuid.nullable(),
    updated_at: StrictUtcTimestamp,
  })
  .strict();
const ModelPrivacyWireSchema = z
  .object({
    model_profile_id: Uuid,
    configured: z.literal(true),
    declaration_basis: z.literal("user_or_admin_declared"),
    model_profile_enabled: z.boolean(),
    execution_location: ExecutionLocationSchema,
    retention: ModelRetentionSchema,
    training_use: ModelTrainingUseSchema,
    sensitive_data_allowed: z.boolean(),
    created_at: StrictUtcTimestamp,
    updated_at: StrictUtcTimestamp,
  })
  .strict();
const StatusWireSchema = z
  .object({
    capabilities: CapabilitiesWireSchema,
    settings: SettingsWireSchema,
    models: z.array(ModelWireSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const defaults = value.models.filter((profile) => profile.is_default);
    if (
      defaults.length > 1 ||
      (defaults[0]?.id ?? null) !== value.settings.default_model_profile_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settings", "default_model_profile_id"],
        message: "default model selection is inconsistent",
      });
    }
  });

function toModelInput(
  value: z.infer<typeof ModelCreateBody> | z.infer<typeof ModelPatchBody>,
) {
  return {
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.base_url !== undefined ? { baseUrl: value.base_url } : {}),
    ...(value.context_window_tokens !== undefined
      ? { contextWindowTokens: value.context_window_tokens }
      : {}),
    ...(value.max_output_tokens !== undefined
      ? { maxOutputTokens: value.max_output_tokens }
      : {}),
    ...(value.capabilities !== undefined
      ? { capabilities: value.capabilities }
      : {}),
  };
}

function toSettingsPatch(value: z.infer<typeof SettingsPatchBody>) {
  return {
    ...(value.locale !== undefined ? { locale: value.locale } : {}),
    ...(value.theme !== undefined ? { theme: value.theme } : {}),
    ...(value.default_model_profile_id !== undefined
      ? { defaultModelProfileId: value.default_model_profile_id }
      : {}),
    ...(value.default_project_id !== undefined
      ? { defaultProjectId: value.default_project_id }
      : {}),
  };
}

function toModelPrivacyPatch(value: z.infer<typeof ModelPrivacyPatchBody>) {
  return {
    ...(value.execution_location !== undefined
      ? { executionLocation: value.execution_location }
      : {}),
    ...(value.retention !== undefined ? { retention: value.retention } : {}),
    ...(value.training_use !== undefined
      ? { trainingUse: value.training_use }
      : {}),
    ...(value.sensitive_data_allowed !== undefined
      ? { sensitiveDataAllowed: value.sensitive_data_allowed }
      : {}),
  };
}

function sensitiveWireKey(key: string) {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return (
    normalized === "secret" ||
    normalized.endsWith("_secret") ||
    normalized === "api_key" ||
    normalized.endsWith("_api_key") ||
    normalized === "credential_ref" ||
    normalized.endsWith("_credential_ref") ||
    normalized === "credential_reference" ||
    normalized.endsWith("_credential_reference")
  );
}

function assertNoSensitiveOutput(value: unknown) {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate))
      return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (sensitiveWireKey(key)) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Workspace model settings route emitted an invalid response.",
        );
      }
      visit(nested);
    }
  };
  visit(value);
}

function handleRouteError(response: Response, error: unknown) {
  if (error instanceof WorkspaceApiError) {
    response.status(error.status).json(error.toResponse());
    return;
  }
  response
    .status(500)
    .json(
      new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workspace model settings route failed.",
      ).toResponse(),
    );
}

function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): z.infer<T> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Workspace model settings request is invalid.",
        error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    throw error;
  }
}

function parseOutput<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): z.infer<T> {
  try {
    assertNoSensitiveOutput(value);
    return schema.parse(value);
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Workspace model settings route emitted an invalid response.",
    );
  }
}

export type WorkspaceModelSettingsContext = { principalId: string };
export type WorkspaceCapabilitiesWire = z.infer<typeof CapabilitiesWireSchema>;
export type WorkspaceModelWire = z.infer<typeof ModelWireSchema>;
export type WorkspaceSettingsWire = z.infer<typeof SettingsWireSchema>;
export type WorkspaceStatusWire = z.infer<typeof StatusWireSchema>;
export type WorkspaceModelPrivacyWire = z.infer<typeof ModelPrivacyWireSchema>;

export interface WorkspaceModelSettingsRuntimePort {
  getStatus(
    context: WorkspaceModelSettingsContext,
  ): Promise<WorkspaceStatusWire> | WorkspaceStatusWire;
  getSettings(
    context: WorkspaceModelSettingsContext,
  ): Promise<WorkspaceSettingsWire> | WorkspaceSettingsWire;
  updateSettings(
    context: WorkspaceModelSettingsContext,
    input: ReturnType<typeof toSettingsPatch>,
  ): Promise<WorkspaceSettingsWire> | WorkspaceSettingsWire;
  listModels(
    context: WorkspaceModelSettingsContext,
  ): Promise<WorkspaceModelWire[]> | WorkspaceModelWire[];
  createModel(
    context: WorkspaceModelSettingsContext,
    input: ReturnType<typeof toModelInput>,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  getModel(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  updateModel(
    context: WorkspaceModelSettingsContext,
    id: string,
    input: ReturnType<typeof toModelInput>,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  getModelPrivacy(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<WorkspaceModelPrivacyWire> | WorkspaceModelPrivacyWire;
  updateModelPrivacy(
    context: WorkspaceModelSettingsContext,
    id: string,
    input: ReturnType<typeof toModelPrivacyPatch>,
  ): Promise<WorkspaceModelPrivacyWire> | WorkspaceModelPrivacyWire;
  putCredential(
    context: WorkspaceModelSettingsContext,
    id: string,
    input: { secret: string },
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  deleteCredential(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  testModel(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  enableModel(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  disableModel(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  setDefaultModel(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  deleteModel(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<void> | void;
}

export type WorkspaceModelSettingsRouterDependencies = {
  runtime: WorkspaceModelSettingsRuntimePort;
  /** Production authenticates the parent /api/v1 router first. */
  auth?: RequestHandler;
  context?: (input: {
    locals: Record<string, unknown>;
  }) => WorkspaceModelSettingsContext;
};

export function createWorkspaceSettingsV1Router(
  dependencies: WorkspaceModelSettingsRouterDependencies,
) {
  const router = Router();
  if (dependencies.auth) router.use(dependencies.auth);
  const context =
    dependencies.context ??
    ((input: { locals: Record<string, unknown> }) => {
      const principalId = input.locals.userId;
      if (
        typeof principalId !== "string" ||
        !Uuid.safeParse(principalId).success
      ) {
        throw new WorkspaceApiError(
          401,
          "UNAUTHORIZED",
          "Workspace authentication is required.",
        );
      }
      return { principalId };
    });
  const requestContext = (response: Response) =>
    context({ locals: response.locals });
  const runtime = dependencies.runtime;
  const run =
    (operation: (response: Response) => Promise<void>) =>
    (_request: unknown, response: Response) => {
      void operation(response).catch((error) =>
        handleRouteError(response, error),
      );
    };

  router.get(
    "/settings/status",
    run(async (response) => {
      response.json(
        parseOutput(
          StatusWireSchema,
          await runtime.getStatus(requestContext(response)),
        ),
      );
    }),
  );
  router.get(
    "/settings",
    run(async (response) => {
      response.json(
        parseOutput(
          SettingsWireSchema,
          await runtime.getSettings(requestContext(response)),
        ),
      );
    }),
  );
  router.patch("/settings", (request, response) => {
    void (async () => {
      const input = toSettingsPatch(
        parseInput(SettingsPatchBody, request.body),
      );
      response.json(
        parseOutput(
          SettingsWireSchema,
          await runtime.updateSettings(requestContext(response), input),
        ),
      );
    })().catch((error) => handleRouteError(response, error));
  });
  router.get(
    "/model-profiles",
    run(async (response) => {
      response.json(
        parseOutput(
          z.array(ModelWireSchema),
          await runtime.listModels(requestContext(response)),
        ),
      );
    }),
  );
  router.post("/model-profiles", (request, response) => {
    void (async () => {
      const input = toModelInput(parseInput(ModelCreateBody, request.body));
      response
        .status(201)
        .json(
          parseOutput(
            ModelWireSchema,
            await runtime.createModel(requestContext(response), input),
          ),
        );
    })().catch((error) => handleRouteError(response, error));
  });
  router.get(
    "/model-profiles/:id",
    run(async (response) => {
      const request = response.req;
      response.json(
        parseOutput(
          ModelWireSchema,
          await runtime.getModel(
            requestContext(response),
            parseInput(Uuid, request.params.id),
          ),
        ),
      );
    }),
  );
  router.patch("/model-profiles/:id", (request, response) => {
    void (async () => {
      response.json(
        parseOutput(
          ModelWireSchema,
          await runtime.updateModel(
            requestContext(response),
            parseInput(Uuid, request.params.id),
            toModelInput(parseInput(ModelPatchBody, request.body)),
          ),
        ),
      );
    })().catch((error) => handleRouteError(response, error));
  });
  router.get(
    "/model-profiles/:id/privacy",
    run(async (response) => {
      const request = response.req;
      response.json(
        parseOutput(
          ModelPrivacyWireSchema,
          await runtime.getModelPrivacy(
            requestContext(response),
            parseInput(Uuid, request.params.id),
          ),
        ),
      );
    }),
  );
  router.patch("/model-profiles/:id/privacy", (request, response) => {
    void (async () => {
      response.json(
        parseOutput(
          ModelPrivacyWireSchema,
          await runtime.updateModelPrivacy(
            requestContext(response),
            parseInput(Uuid, request.params.id),
            toModelPrivacyPatch(
              parseInput(ModelPrivacyPatchBody, request.body),
            ),
          ),
        ),
      );
    })().catch((error) => handleRouteError(response, error));
  });
  router.put("/model-profiles/:id/credential", (request, response) => {
    void (async () => {
      response.json(
        parseOutput(
          ModelWireSchema,
          await runtime.putCredential(
            requestContext(response),
            parseInput(Uuid, request.params.id),
            parseInput(CredentialBody, request.body),
          ),
        ),
      );
    })().catch((error) => handleRouteError(response, error));
  });
  router.delete("/model-profiles/:id/credential", (request, response) => {
    void (async () => {
      parseInput(EmptyBody, request.body ?? {});
      response.json(
        parseOutput(
          ModelWireSchema,
          await runtime.deleteCredential(
            requestContext(response),
            parseInput(Uuid, request.params.id),
          ),
        ),
      );
    })().catch((error) => handleRouteError(response, error));
  });
  for (const [action, operation] of [
    ["test", runtime.testModel.bind(runtime)],
    ["enable", runtime.enableModel.bind(runtime)],
    ["disable", runtime.disableModel.bind(runtime)],
    ["default", runtime.setDefaultModel.bind(runtime)],
  ] as const) {
    router.post(`/model-profiles/:id/${action}`, (request, response) => {
      void (async () => {
        parseInput(EmptyBody, request.body ?? {});
        response.json(
          parseOutput(
            ModelWireSchema,
            await operation(
              requestContext(response),
              parseInput(Uuid, request.params.id),
            ),
          ),
        );
      })().catch((error) => handleRouteError(response, error));
    });
  }
  router.delete("/model-profiles/:id", (request, response) => {
    void (async () => {
      parseInput(EmptyBody, request.body ?? {});
      await runtime.deleteModel(
        requestContext(response),
        parseInput(Uuid, request.params.id),
      );
      response.status(204).send();
    })().catch((error) => handleRouteError(response, error));
  });

  return router;
}
