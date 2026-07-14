import { Router, type RequestHandler } from "express";
import { ZodError, z } from "zod";

import { WorkspaceApiError } from "../lib/workspace/errors";

const Uuid = z.string().uuid();
const EmptyBody = z.object({}).strict();
const Provider = z.enum([
  "openai",
  "deepseek",
  "anthropic",
  "gemini",
  "openai_compatible",
]);
const ModelMutationBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    provider: Provider.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    base_url: z.string().trim().min(1).nullable().optional(),
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
    capabilities: z
      .object({
        streaming: z.boolean(),
        toolCalling: z.boolean(),
        structuredOutput: z.boolean(),
        vision: z.boolean(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().optional(),
    is_default: z.boolean().optional(),
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
    local_only: z.literal(true),
    loopback_http_allowed: z.boolean(),
    credential_write_enabled: z.boolean(),
    secret_readback_supported: z.literal(false),
    runtime_wired: z.boolean(),
  })
  .strict();
const EndpointBindingWireSchema = z
  .object({
    provider: Provider,
    model: z.string().min(1).max(200),
    normalized_base_url: z.string().min(1).nullable(),
    canonical_origin: z.string().min(1).nullable(),
    execution_revision: z.number().int().nonnegative(),
    profile_updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
const ModelWireSchema = z
  .object({
    id: Uuid,
    name: z.string().min(1).max(120),
    provider: Provider,
    model: z.string().min(1).max(200),
    base_url: z.string().min(1).nullable(),
    context_window_tokens: z.number().int().positive().nullable(),
    max_output_tokens: z.number().int().positive().nullable(),
    enabled: z.boolean(),
    is_default: z.boolean(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    capabilities: z
      .object({
        streaming: z.boolean(),
        toolCalling: z.boolean(),
        structuredOutput: z.boolean(),
        vision: z.boolean(),
      })
      .strict(),
    credential: z
      .object({
        status: z.enum(["configured", "missing", "invalid"]),
        configured: z.boolean(),
        canonical_origin: z.string().min(1).nullable(),
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
    requires_credential: z.literal(true),
  })
  .strict();
const SettingsWireSchema = z
  .object({
    locale: z.enum(["zh-CN", "en-US"]),
    theme: z.enum(["system", "light", "dark"]),
    default_model_profile_id: Uuid.nullable(),
    default_project_id: Uuid.nullable(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
const StatusWireSchema = z
  .object({
    capabilities: CapabilitiesWireSchema,
    settings: SettingsWireSchema,
    models: z.array(ModelWireSchema),
  })
  .strict();

function toModelPatch(value: z.infer<typeof ModelMutationBody>) {
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
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.is_default !== undefined ? { isDefault: value.is_default } : {}),
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

function handleRouteError(
  res: {
    status: (status: number) => { json: (body: unknown) => unknown };
  },
  error: unknown,
) {
  if (error instanceof WorkspaceApiError) {
    return void res.status(error.status).json(error.toResponse());
  }
  return void res
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
    return schema.parse(value);
  } catch {
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
    input: ReturnType<typeof toModelPatch>,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  getModel(
    context: WorkspaceModelSettingsContext,
    id: string,
  ): Promise<WorkspaceModelWire> | WorkspaceModelWire;
  updateModel(
    context: WorkspaceModelSettingsContext,
    id: string,
    input: ReturnType<typeof toModelPatch>,
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
  auth?: RequestHandler;
  context?:
    | ((input: {
        locals: Record<string, unknown>;
      }) => WorkspaceModelSettingsContext)
    | undefined;
};

export function createWorkspaceSettingsV1Router(
  dependencies: WorkspaceModelSettingsRouterDependencies,
) {
  const router = Router();
  const configuredPrincipalId =
    process.env.WORKSPACE_LOCAL_PRINCIPAL_ID?.trim() || null;
  const missingContextError = new WorkspaceApiError(
    500,
    "INTERNAL_ERROR",
    "Workspace model settings authentication context is unavailable.",
  );
  const auth =
    dependencies.auth ??
    ((_req, res) =>
      void res.status(500).json(missingContextError.toResponse()));
  const context = dependencies.context
    ? dependencies.context
    : configuredPrincipalId
      ? () => ({
          principalId: configuredPrincipalId,
        })
      : null;
  const runtime = dependencies.runtime;
  const requireContext = (res: { locals: Record<string, unknown> }) => {
    if (!context) throw missingContextError;
    return context(res);
  };

  router.get("/status", auth, async (_req, res) => {
    try {
      res.json(
        parseOutput(
          StatusWireSchema,
          await runtime.getStatus(requireContext(res)),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.get("/settings", auth, async (_req, res) => {
    try {
      res.json(
        parseOutput(
          SettingsWireSchema,
          await runtime.getSettings(requireContext(res)),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.patch("/settings", auth, async (req, res) => {
    try {
      const input = toSettingsPatch(parseInput(SettingsPatchBody, req.body));
      res.json(
        parseOutput(
          SettingsWireSchema,
          await runtime.updateSettings(requireContext(res), input),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.get("/models", auth, async (_req, res) => {
    try {
      res.json(
        parseOutput(
          z.array(ModelWireSchema),
          await runtime.listModels(requireContext(res)),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.post("/models", auth, async (req, res) => {
    try {
      const input = toModelPatch(parseInput(ModelMutationBody, req.body));
      res
        .status(201)
        .json(
          parseOutput(
            ModelWireSchema,
            await runtime.createModel(requireContext(res), input),
          ),
        );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.get("/models/:id", auth, async (req, res) => {
    try {
      res.json(
        parseOutput(
          ModelWireSchema,
          await runtime.getModel(
            requireContext(res),
            parseInput(Uuid, req.params.id),
          ),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.patch("/models/:id", auth, async (req, res) => {
    try {
      const parsed = parseInput(ModelMutationBody, req.body);
      if (Object.keys(parsed).length === 0) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "At least one model update is required.",
        );
      }
      res.json(
        parseOutput(
          ModelWireSchema,
          await runtime.updateModel(
            requireContext(res),
            parseInput(Uuid, req.params.id),
            toModelPatch(parsed),
          ),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.post("/models/:id/enable", auth, async (req, res) => {
    try {
      parseInput(EmptyBody, req.body ?? {});
      res.json(
        parseOutput(
          ModelWireSchema,
          await runtime.enableModel(
            requireContext(res),
            parseInput(Uuid, req.params.id),
          ),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.post("/models/:id/disable", auth, async (req, res) => {
    try {
      parseInput(EmptyBody, req.body ?? {});
      res.json(
        parseOutput(
          ModelWireSchema,
          await runtime.disableModel(
            requireContext(res),
            parseInput(Uuid, req.params.id),
          ),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.post("/models/:id/default", auth, async (req, res) => {
    try {
      parseInput(EmptyBody, req.body ?? {});
      res.json(
        parseOutput(
          ModelWireSchema,
          await runtime.setDefaultModel(
            requireContext(res),
            parseInput(Uuid, req.params.id),
          ),
        ),
      );
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.delete("/models/:id", auth, async (req, res) => {
    try {
      await runtime.deleteModel(
        requireContext(res),
        parseInput(Uuid, req.params.id),
      );
      res.status(204).send();
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  return router;
}
