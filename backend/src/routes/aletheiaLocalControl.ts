import { Router, type RequestHandler } from "express";
import {
  buildRuntimeConfig,
  LocalControlError,
  LocalControlRepository,
  normalizeLegalSourceProvider,
  normalizeProvider,
  normalizeSettingsPatch,
  parseSettingsVersion,
  type ProviderId,
  type RuntimeModel,
} from "../lib/aletheia/localControlRepository";
import {
  LocalMcpNetworkPolicy,
  normalizeMcpAuthConfig,
  refreshLocalMcpConnector,
} from "../lib/aletheia/localMcpConnectorClient";
import {
  hasDeclaredDeploymentDataUsePolicy,
  legalResearchProviderDeploymentStatus,
  legalResearchProviderDescriptorFromEnvironment,
  projectLegalResearchProviderConnectionStatus,
} from "../lib/aletheia/legalResearchProvider";
import { LEGAL_SOURCE_RETENTION_ACTIVATION_V13 } from "../lib/workspace/sourceRetentionPolicyV13";
import { localModelScheduler } from "../lib/aletheia/localModelRuntime";
import { requireAuth } from "../middleware/auth";

type RouterDependencies = {
  repository?: LocalControlRepository;
  auth?: RequestHandler;
  runtimeModels?: () => RuntimeModel[];
  mcpNetworkPolicy?: LocalMcpNetworkPolicy;
};

let defaultRepository: LocalControlRepository | null = null;

function repository() {
  defaultRepository ??= new LocalControlRepository();
  return defaultRepository;
}

function userId(res: { locals: Record<string, unknown> }) {
  const value = res.locals.userId;
  if (typeof value !== "string" || !value) {
    throw new LocalControlError(
      "Authenticated local user is missing.",
      "INVALID_INPUT",
      401,
    );
  }
  return value;
}

function runtimeModels(): RuntimeModel[] {
  return localModelScheduler()
    .snapshots()
    .map((model) => ({
      id: model.id,
      state: model.state,
      contextWindowTokens: model.contextWindowTokens,
      maxOutputTokens: model.maxOutputTokens,
    }));
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
  options: { revealUnknownField?: boolean } = {},
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalControlError(
      `${label} must be an object.`,
      "INVALID_INPUT",
      400,
    );
  }
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new LocalControlError(
      options.revealUnknownField === false
        ? `${label} contains an unknown field.`
        : `${label} contains unknown field: ${unknown}`,
      "INVALID_INPUT",
      400,
    );
  }
  return object;
}

function connectorName(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 120 ? trimmed : null;
}

function legalSourceStatusProjection(
  repo: LocalControlRepository,
  userId: string,
) {
  const encryptionEnabled = repo.canEncryptProviderSecrets();
  return repo.listProviderStatuses(userId).flatMap((item) => {
    const provider = normalizeLegalSourceProvider(item.provider);
    if (!provider) return [];
    const deployment = legalResearchProviderDeploymentStatus(provider);
    const descriptor = legalResearchProviderDescriptorFromEnvironment(provider);
    const dataUsePolicyReady = hasDeclaredDeploymentDataUsePolicy(
      descriptor.dataUsePolicy,
    );
    const deploymentReady =
      deployment.endpointConfigured &&
      deployment.allowlisted &&
      deployment.credentialReferenceConfigured;
    let secretStorageAvailable = encryptionEnabled;
    let credentialAvailable = false;
    if (
      LEGAL_SOURCE_RETENTION_ACTIVATION_V13.open &&
      dataUsePolicyReady &&
      item.configured &&
      encryptionEnabled
    ) {
      try {
        // Local decryptability is a credential-availability check, not a
        // vendor connection test. The plaintext is neither returned nor
        // retained in the status projection.
        credentialAvailable =
          repo.providerSecretForUse(userId, provider).length > 0;
      } catch (error) {
        if (error instanceof LocalControlError && error.code === "NOT_FOUND") {
          credentialAvailable = false;
        } else {
          secretStorageAvailable = false;
        }
      }
    }
    return [
      {
        provider,
        deploymentReady,
        endpointConfigured: deployment.endpointConfigured,
        allowlisted: deployment.allowlisted,
        credentialReferenceConfigured: deployment.credentialReferenceConfigured,
        hasSecret: item.configured === true,
        encryptionEnabled,
        contractVersion: descriptor.contractVersion,
        integration: descriptor.integration,
        capabilities: descriptor.capabilities,
        dataUsePolicy: descriptor.dataUsePolicy,
        connectionStatus: projectLegalResearchProviderConnectionStatus({
          deployment,
          credentialRequired: true,
          credentialAvailable,
          activationGateClosed: !LEGAL_SOURCE_RETENTION_ACTIVATION_V13.open,
          dataUsePolicyReady,
          secretStorageAvailable,
          // Historical rows came from a retired, unsupported test action.
          // This request performs no network probe, so they cannot establish
          // current connectivity or a current connection failure.
          connectionTestStatus: null,
        }),
      },
    ];
  });
}

function handleError(
  res: { status: (status: number) => { json: (body: unknown) => unknown } },
  error: unknown,
  fallbackStatus = 500,
) {
  if (error instanceof LocalControlError) {
    return void res.status(error.status).json({
      code: error.code,
      detail: error.message,
    });
  }
  return void res.status(fallbackStatus).json({
    code: "LOCAL_CONTROL_ERROR",
    // Unclassified repository, cipher, and filesystem failures are internal
    // details. Never reflect their messages across the renderer boundary:
    // they may contain local paths or provider material supplied by a failing
    // dependency. LocalControlError remains the explicit, safe business-error
    // channel above.
    detail: "Local control operation failed.",
  });
}

export function createAletheiaLocalControlRouter(
  dependencies: RouterDependencies = {},
) {
  const router = Router();
  const repo = dependencies.repository ?? repository();
  const auth = dependencies.auth ?? requireAuth;
  const models = dependencies.runtimeModels ?? runtimeModels;
  const policy = dependencies.mcpNetworkPolicy ?? new LocalMcpNetworkPolicy();

  router.get("/client-settings", auth, (_req, res) => {
    try {
      const result = repo.getSettings(userId(res));
      res.setHeader("ETag", result.etag);
      res.json({
        ...result,
        runtimeConfig: buildRuntimeConfig(result, models()),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch("/client-settings", auth, (req, res) => {
    try {
      const expectedVersion = parseSettingsVersion(req.headers["if-match"]);
      if (Number.isNaN(expectedVersion)) {
        throw new LocalControlError(
          "If-Match is invalid.",
          "INVALID_INPUT",
          400,
        );
      }
      const id = userId(res);
      const current = repo.getSettings(id);
      const next = normalizeSettingsPatch(req.body, current.settings, models());
      const result = repo.updateSettings(id, expectedVersion, next);
      res.setHeader("ETag", result.etag);
      res.json({
        ...result,
        runtimeConfig: buildRuntimeConfig(result, models()),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/client-settings", auth, (req, res) => {
    try {
      const expectedVersion = parseSettingsVersion(req.headers["if-match"]);
      if (Number.isNaN(expectedVersion)) {
        throw new LocalControlError(
          "If-Match is invalid.",
          "INVALID_INPUT",
          400,
        );
      }
      const result = repo.resetSettings(userId(res), expectedVersion);
      res.setHeader("ETag", result.etag);
      res.json({
        ...result,
        runtimeConfig: buildRuntimeConfig(result, models()),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/runtime-config", auth, (_req, res) => {
    try {
      const settings = repo.getSettings(userId(res));
      res.json(buildRuntimeConfig(settings, models()));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/providers", auth, (_req, res) => {
    try {
      res.json({
        schemaVersion: "vera-legal-source-provider-status-v2",
        localOnly: true,
        providers: legalSourceStatusProjection(repo, userId(res)),
        detail:
          "Only authorized legal-source credentials may be stored locally; remote model providers remain disabled.",
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/providers/:provider/status", auth, (req, res) => {
    try {
      const provider = normalizeProvider(req.params.provider);
      if (!provider) {
        throw new LocalControlError(
          "Provider is not supported.",
          "INVALID_INPUT",
          400,
        );
      }
      if (normalizeLegalSourceProvider(provider)) {
        const status = legalSourceStatusProjection(repo, userId(res)).find(
          (item) => item.provider === provider,
        );
        return void res.json(status);
      }
      res.status(404).json({
        code: "REMOTE_PROVIDER_DISABLED",
        detail:
          "Remote providers are disabled in the local-sensitive edition; no provider credential is active.",
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put("/providers/:provider/secret", auth, (req, res) => {
    try {
      const provider = normalizeProvider(req.params.provider);
      if (!provider) {
        throw new LocalControlError(
          "Provider is not supported.",
          "INVALID_INPUT",
          400,
        );
      }
      const legalProvider = normalizeLegalSourceProvider(provider);
      if (legalProvider) {
        const deployment = legalResearchProviderDeploymentStatus(legalProvider);
        if (
          !deployment.endpointConfigured ||
          !deployment.allowlisted ||
          !deployment.credentialReferenceConfigured
        ) {
          throw new LocalControlError(
            "Authorized legal-source deployment readiness is incomplete; the local credential was not stored.",
            "PRECONDITION_REQUIRED",
            428,
          );
        }
        const payload = exactObject(req.body, ["secret"], "Provider secret", {
          revealUnknownField: false,
        });
        if (typeof payload.secret !== "string") {
          throw new LocalControlError(
            "Provider secret must be a string.",
            "INVALID_INPUT",
            400,
          );
        }
        const id = userId(res);
        repo.saveProviderSecret(id, legalProvider, payload.secret);
        const status = legalSourceStatusProjection(repo, id).find(
          (item) => item.provider === legalProvider,
        );
        if (!status) {
          throw new LocalControlError(
            "Legal source provider status is unavailable.",
            "NOT_FOUND",
            404,
          );
        }
        return void res.json(status);
      }
      throw new LocalControlError(
        "Remote provider credentials are disabled in the local-sensitive edition and will not be stored.",
        "UNSUPPORTED_SETTING",
        422,
      );
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/providers/:provider/secret", auth, (req, res) => {
    try {
      const provider = normalizeProvider(req.params.provider);
      if (!provider) {
        throw new LocalControlError(
          "Provider is not supported.",
          "INVALID_INPUT",
          400,
        );
      }
      const legalProvider = normalizeLegalSourceProvider(provider);
      if (!legalProvider) {
        throw new LocalControlError(
          "Remote provider credentials are disabled in the local-sensitive edition.",
          "UNSUPPORTED_SETTING",
          422,
        );
      }
      const removed = repo.removeProviderSecret(userId(res), legalProvider);
      res.status(removed ? 204 : 404).end();
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/providers/:provider/test", auth, async (req, res) => {
    try {
      const provider = normalizeProvider(req.params.provider);
      if (!provider) {
        throw new LocalControlError(
          "Provider is not supported.",
          "INVALID_INPUT",
          400,
        );
      }
      throw new LocalControlError(
        "Remote provider tests are disabled because this edition makes no external provider connection.",
        "UNSUPPORTED_SETTING",
        422,
      );
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/mcp-connectors", auth, (_req, res) => {
    try {
      res.json({
        schemaVersion: "aletheia-local-mcp-connectors-v1",
        connectors: repo.listMcpConnectors(userId(res)),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/mcp-connectors/:connectorId", auth, (req, res) => {
    try {
      const connector = repo.getMcpConnector(
        userId(res),
        req.params.connectorId,
      );
      if (!connector)
        return void res.status(404).json({ detail: "Connector not found" });
      res.json(connector);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/mcp-connectors", auth, (req, res) => {
    try {
      const body = exactObject(
        req.body,
        ["name", "serverUrl", "enabled", "auth"],
        "MCP connector payload",
      );
      const name = connectorName(body.name);
      if (!name) {
        throw new LocalControlError(
          "name must be between 1 and 120 characters.",
          "INVALID_INPUT",
          400,
        );
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        throw new LocalControlError(
          "enabled must be boolean.",
          "INVALID_INPUT",
          400,
        );
      }
      const connector = repo.createMcpConnector(userId(res), {
        name,
        serverUrl: policy.normalizeForStorage(body.serverUrl),
        enabled: body.enabled !== false,
        authConfig: normalizeMcpAuthConfig(body.auth),
      });
      res.status(201).json(connector);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch("/mcp-connectors/:connectorId", auth, (req, res) => {
    try {
      const body = exactObject(
        req.body,
        ["name", "serverUrl", "enabled", "auth"],
        "MCP connector patch",
      );
      const patch: Parameters<LocalControlRepository["updateMcpConnector"]>[2] =
        {};
      if (Object.hasOwn(body, "name")) {
        const name = connectorName(body.name);
        if (!name) {
          throw new LocalControlError(
            "name must be between 1 and 120 characters.",
            "INVALID_INPUT",
            400,
          );
        }
        patch.name = name;
      }
      if (Object.hasOwn(body, "serverUrl")) {
        patch.serverUrl = policy.normalizeForStorage(body.serverUrl);
      }
      if (Object.hasOwn(body, "enabled")) {
        if (typeof body.enabled !== "boolean") {
          throw new LocalControlError(
            "enabled must be boolean.",
            "INVALID_INPUT",
            400,
          );
        }
        patch.enabled = body.enabled;
      }
      if (Object.hasOwn(body, "auth")) {
        patch.authConfig = normalizeMcpAuthConfig(body.auth);
      }
      res.json(
        repo.updateMcpConnector(userId(res), req.params.connectorId, patch),
      );
    } catch (error) {
      handleError(res, error);
    }
  });

  for (const action of ["enable", "disable"] as const) {
    router.post(`/mcp-connectors/:connectorId/${action}`, auth, (req, res) => {
      try {
        res.json(
          repo.updateMcpConnector(userId(res), req.params.connectorId, {
            enabled: action === "enable",
          }),
        );
      } catch (error) {
        handleError(res, error);
      }
    });
  }

  router.delete("/mcp-connectors/:connectorId", auth, (req, res) => {
    try {
      const removed = repo.deleteMcpConnector(
        userId(res),
        req.params.connectorId,
      );
      res.status(removed ? 204 : 404).end();
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(
    "/mcp-connectors/:connectorId/refresh-tools",
    auth,
    async (req, res) => {
      try {
        const result = await refreshLocalMcpConnector({
          repository: repo,
          userId: userId(res),
          connectorId: req.params.connectorId,
          policy,
        });
        res.json(result);
      } catch (error) {
        handleError(res, error, 502);
      }
    },
  );

  return router;
}
