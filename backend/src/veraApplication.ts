import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, {
  Router,
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { assertLocalEncryptionStartupPolicy } from "./lib/aletheia/localEnvelopeCrypto";
import { assertComplianceDeploymentStartupPolicy } from "./lib/aletheia/localCompliancePreset";
import {
  auditAnchorRuntimeStatus,
  shouldFailClosedForAuditAnchor,
  startAuditAnchorRuntimeFromEnvironment,
} from "./lib/aletheia/auditAnchorJournal";
import {
  createWorkspaceAuthMiddleware,
  resolveWorkspaceAuthConfiguration,
  workspaceRouteAllowed,
  type WorkspaceAuthEnvironment,
} from "./middleware/workspaceAuth";
import {
  createWorkspaceV1Router,
  type WorkspaceV1RuntimePort,
} from "./routes/workspaceV1";
import {
  createWorkspaceDocumentStudioV1Router,
  type WorkspaceDocumentStudioV1Port,
} from "./routes/workspaceDocumentStudioV1";
import {
  createWorkspaceProjectSourcesV1Router,
  type WorkspaceProjectSourcesV1Port,
} from "./routes/workspaceProjectSourcesV1";
import {
  createWorkspaceWorkflowRunsV1Router,
  createWorkspaceWorkflowsV1Router,
  type WorkspaceWorkflowsV1Port,
} from "./routes/workspaceWorkflowsV1";
import {
  createWorkspaceChatsV1Router,
  type WorkspaceChatsV1Port,
} from "./routes/workspaceChatsV1";
import {
  createWorkspaceSettingsV1Router,
  type WorkspaceModelSettingsRuntimePort,
} from "./routes/workspaceSettingsV1";
import {
  createWorkspaceTabularV1Router,
  type WorkspaceTabularV1RuntimePort,
} from "./routes/workspaceTabularV1";
import {
  createWorkspaceRuntime,
  type WorkspaceRuntimeHealth,
} from "./lib/workspace/runtime";
import type { MatterProfileModule } from "./matter/profile";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 3001;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

type Environment = NodeJS.ProcessEnv & WorkspaceAuthEnvironment;

type AuditAnchorStatus = {
  enabled: boolean;
  healthy: boolean;
  protection_active?: boolean;
  [key: string]: unknown;
};

type Closable = {
  close(): void | Promise<void>;
};

type LegacyRouterFactory = () => readonly Router[];

export interface VeraWorkspaceRuntime
  extends
    WorkspaceV1RuntimePort,
    WorkspaceDocumentStudioV1Port,
    WorkspaceProjectSourcesV1Port {
  readonly workflowCrud: WorkspaceWorkflowsV1Port;
  readonly modelSettings: WorkspaceModelSettingsRuntimePort;
  readonly chats: WorkspaceChatsV1Port;
  readonly tabular: WorkspaceTabularV1RuntimePort;
  readonly matterProfiles?: Pick<
    MatterProfileModule,
    "createRouter" | "health"
  >;
  assistantGenerationAvailable(): boolean;
  tabularGenerationAvailable(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): WorkspaceRuntimeHealth;
}

function configuredMatterRuntime(runtime: VeraWorkspaceRuntime) {
  if (!("matterProfiles" in runtime)) return null;
  const candidate = runtime.matterProfiles;
  return candidate &&
    typeof candidate.createRouter === "function" &&
    typeof candidate.health === "function"
    ? candidate
    : null;
}

function matterHealth(runtime: VeraWorkspaceRuntime): Record<string, unknown> {
  const matter = configuredMatterRuntime(runtime);
  if (!matter) return { status: "not_configured" };
  try {
    const health = matter.health();
    if (
      health &&
      typeof health === "object" &&
      !Array.isArray(health) &&
      health.status === "ready" &&
      health.schemaVersion === 16 &&
      health.inferencePolicy === "gate_closed"
    ) {
      return {
        status: "ready",
        schemaVersion: 16,
        inferencePolicy: "gate_closed",
      };
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export type VeraListeningServer = Pick<Server, "close" | "listening"> & {
  address?: Server["address"];
  closeAllConnections?: () => void;
};

export type VeraListenHandle = {
  server: VeraListeningServer;
  ready: Promise<void>;
};

export type VeraApplicationOptions = {
  runtime: VeraWorkspaceRuntime;
  env?: Environment;
  auditAnchorStatus?: () => AuditAnchorStatus;
  auditWriteBlocked?: () => boolean;
  isDraining?: () => boolean;
  legacyRouterFactory?: LegacyRouterFactory;
  legacyRuntimeConfigured?: () => boolean;
};

export type VeraBootstrapDependencies = {
  assertCompliancePolicy(): void;
  assertEncryptionPolicy(): void;
  resolveAuthConfiguration: typeof resolveWorkspaceAuthConfiguration;
  startAuditAnchor(): Closable | null;
  auditAnchorStatus(): AuditAnchorStatus;
  auditWriteBlocked(): boolean;
  createRuntime(): VeraWorkspaceRuntime;
  configureDurableRuntime(): Closable | null;
  closeLocalModelRuntime(): Promise<void>;
  closeLocalVoiceRuntime(): Promise<void>;
  runDemoSeed(): Promise<unknown>;
  listen(app: Express, port: number, host: string): VeraListenHandle;
};

export type VeraBootstrapOptions = {
  env?: Environment;
  port?: number | string;
  allowPortZero?: boolean;
  closeTimeoutMs?: number;
  dependencies?: Partial<VeraBootstrapDependencies>;
};

export type VeraApplicationInstance = {
  app: Express;
  host: typeof LOOPBACK_HOST;
  port: number;
  runtime: VeraWorkspaceRuntime;
  server: VeraListeningServer;
  shutdown(): Promise<void>;
};

export class VeraStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VeraStartupError";
  }
}

function legacyRoutesEnabled(env: Environment): boolean {
  return env.VERA_ENABLE_LEGACY_ROUTES === "true";
}

function legacyRuntimeEnabled(env: Environment): boolean {
  return env.VERA_ENABLE_LEGACY_RUNTIME === "true";
}

/**
 * Legacy modules have startup side effects, including local database and voice
 * runtime construction. Keep every require inside this explicitly gated
 * factory so the default Workspace process never evaluates those modules.
 */
function loadLegacyRouters(): readonly Router[] {
  const { aletheiaRouter } =
    require("./routes/aletheia") as typeof import("./routes/aletheia");
  const { legalResearchRouter } =
    require("./routes/legalResearch") as typeof import("./routes/legalResearch");
  const { legalResearchIssuesRouter } =
    require("./routes/legalResearchIssues") as typeof import("./routes/legalResearchIssues");
  const { legalOpinionsRouter } =
    require("./routes/legalOpinions") as typeof import("./routes/legalOpinions");
  const { litigationRouter } =
    require("./routes/litigation") as typeof import("./routes/litigation");
  const { durableAgentRunsRouter } =
    require("./routes/durableAgentRuns") as typeof import("./routes/durableAgentRuns");
  const { localGovernanceRouter } =
    require("./routes/localGovernance") as typeof import("./routes/localGovernance");
  const { localModelsRouter } =
    require("./routes/localModels") as typeof import("./routes/localModels");
  const { createLocalVoiceRouter } =
    require("./routes/localVoice") as typeof import("./routes/localVoice");
  const { createAletheiaLocalControlRouter } =
    require("./routes/aletheiaLocalControl") as typeof import("./routes/aletheiaLocalControl");

  return [
    aletheiaRouter,
    legalResearchRouter,
    legalResearchIssuesRouter,
    legalOpinionsRouter,
    litigationRouter,
    durableAgentRunsRouter,
    localGovernanceRouter,
    localModelsRouter,
    createLocalVoiceRouter(),
    createAletheiaLocalControlRouter(),
  ];
}

function configureLegacyDurableRuntime(): Closable | null {
  const { configureDurableAgentRuntimeFromEnvironment } =
    require("./lib/aletheia/durableAgentRuntime") as typeof import("./lib/aletheia/durableAgentRuntime");
  return configureDurableAgentRuntimeFromEnvironment();
}

async function closeLegacyLocalModelRuntime(): Promise<void> {
  const { closeLocalModelRuntime } =
    require("./lib/aletheia/localModelRuntime") as typeof import("./lib/aletheia/localModelRuntime");
  await closeLocalModelRuntime();
}

async function closeLegacyLocalVoiceRuntime(): Promise<void> {
  const { closeLocalVoiceRuntime } =
    require("./lib/aletheia/localVoiceRuntime") as typeof import("./lib/aletheia/localVoiceRuntime");
  await closeLocalVoiceRuntime();
}

async function runLegacyDemoSeed(): Promise<unknown> {
  const { seedAletheiaDemoIfNeeded } =
    require("./lib/aletheia/demoSeed") as typeof import("./lib/aletheia/demoSeed");
  return seedAletheiaDemoIfNeeded();
}

function envInt(env: Environment, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function resolveTrustProxyHops(env: Environment): 0 {
  const configured = env.TRUST_PROXY_HOPS?.trim();
  if (configured !== undefined && configured !== "" && configured !== "0") {
    throw new VeraStartupError(
      "TRUST_PROXY_HOPS must be 0 for the loopback-only Vera backend.",
    );
  }
  return 0;
}

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function errorEnvelope(
  code: "VALIDATION_ERROR" | "RATE_LIMITED" | "INTERNAL_ERROR",
  message: string,
) {
  return {
    detail: message,
    code,
    error: { code, message, retryable: false },
  };
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const message =
    options.message ?? "Too many requests. Please try again later.";
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (request) => request.method === "OPTIONS",
    message: errorEnvelope("RATE_LIMITED", message),
  });
}

/** A single local probe budget. It deliberately ignores all forwarded headers. */
function makeModelProbeLimiter(options: { windowMs: number; max: number }) {
  let windowStartedAt = 0;
  let attempts = 0;
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.method !== "POST") {
      next();
      return;
    }
    const now = Date.now();
    if (windowStartedAt === 0 || now - windowStartedAt >= options.windowMs) {
      windowStartedAt = now;
      attempts = 0;
    }
    attempts += 1;
    response.setHeader(
      "RateLimit-Policy",
      `${options.max};w=${Math.ceil(options.windowMs / 1000)}`,
    );
    response.setHeader("RateLimit-Limit", String(options.max));
    response.setHeader(
      "RateLimit-Remaining",
      String(Math.max(0, options.max - attempts)),
    );
    if (attempts > options.max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStartedAt + options.windowMs - now) / 1000),
      );
      response.setHeader("Retry-After", String(retryAfterSeconds));
      response
        .status(429)
        .json(
          errorEnvelope(
            "RATE_LIMITED",
            "Too many model connection tests. Please try again later.",
          ),
        );
      return;
    }
    next();
  };
}

function auditMutationGuard(
  shouldBlock: () => boolean,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      shouldBlock()
    ) {
      const message =
        "Audit protection is unhealthy. State-changing operations are temporarily unavailable.";
      response.status(503).json(errorEnvelope("INTERNAL_ERROR", message));
      return;
    }
    next();
  };
}

function safeApplicationErrorHandler(): ErrorRequestHandler {
  return (error, _request, response, _next) => {
    const bodyParserError = error as {
      status?: unknown;
      type?: unknown;
    };
    const status =
      bodyParserError.status === 400 ||
      bodyParserError.type === "entity.parse.failed"
        ? 400
        : bodyParserError.status === 413
          ? 413
          : 500;
    const message =
      status === 400
        ? "The request body is not valid JSON."
        : status === 413
          ? "The request body is too large."
          : "The request could not be completed.";
    response
      .status(status)
      .json(
        errorEnvelope(
          status === 400 || status === 413
            ? "VALIDATION_ERROR"
            : "INTERNAL_ERROR",
          message,
        ),
      );
  };
}

export function createVeraApplication(
  options: VeraApplicationOptions,
): Express {
  const env = options.env ?? process.env;
  const isProduction = env.NODE_ENV === "production";
  const getAuditStatus = options.auditAnchorStatus ?? auditAnchorRuntimeStatus;
  const shouldBlockAuditWrites =
    options.auditWriteBlocked ?? shouldFailClosedForAuditAnchor;
  const isDraining = options.isDraining ?? (() => false);
  const legacyRoutesAreEnabled = legacyRoutesEnabled(env);
  const legacyRuntimeIsEnabled = legacyRuntimeEnabled(env);
  const trustProxyHops = resolveTrustProxyHops(env);
  const app = express();

  const generalLimiter = makeLimiter({
    windowMs: minutes(envInt(env, "RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
    max: envInt(env, "RATE_LIMIT_GENERAL_MAX", 300),
  });
  const uploadLimiter = makeLimiter({
    windowMs: hours(envInt(env, "RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
    max: envInt(env, "RATE_LIMIT_UPLOAD_MAX", 50),
    message: "Too many upload requests. Please try again later.",
  });
  const modelProbeLimiter = makeModelProbeLimiter({
    windowMs: minutes(envInt(env, "RATE_LIMIT_MODEL_PROBE_WINDOW_MINUTES", 1)),
    max: envInt(env, "RATE_LIMIT_MODEL_PROBE_MAX", 8),
  });

  app.disable("x-powered-by");
  app.set("trust proxy", trustProxyHops);

  // Set Workspace cache policy before every middleware that can terminate a
  // request (CORS preflight, global rate limiting, draining, JSON parsing, or
  // authentication). Keep the exact /api/v1 boundary so health and legacy
  // Aletheia surfaces retain their existing cache semantics.
  app.use((request, response, next) => {
    if (workspaceRouteAllowed(request)) {
      response.set({
        "Cache-Control": "private, no-store",
        Pragma: "no-cache",
        Expires: "0",
      });
    }
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: isProduction
        ? { maxAge: 15_552_000, includeSubDomains: true }
        : false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(
    cors({
      origin: env.FRONTEND_URL ?? "http://localhost:3000",
      credentials: true,
    }),
  );
  app.use(generalLimiter);

  app.use((request, response, next) => {
    if (isDraining() && request.path !== "/health") {
      response
        .status(503)
        .json(
          errorEnvelope(
            "INTERNAL_ERROR",
            "Vera is shutting down and cannot accept new requests.",
          ),
        );
      return;
    }
    next();
  });

  if (legacyRoutesAreEnabled) {
    const externalSourceLimiter = makeLimiter({
      windowMs: minutes(
        envInt(env, "RATE_LIMIT_EXTERNAL_SOURCE_WINDOW_MINUTES", 15),
      ),
      max: envInt(env, "RATE_LIMIT_EXTERNAL_SOURCE_MAX", 20),
      message:
        "Too many external-source retrieval requests. Please try again later.",
    });
    app.post(
      "/aletheia/matters/:matterId/external-source/fetch",
      externalSourceLimiter,
    );
    app.post("/aletheia/matters/:matterId/research/*", externalSourceLimiter);
    app.post("/aletheia/matters/:matterId/documents", uploadLimiter);
    app.post("/aletheia/matters/:matterId/documents/batch", uploadLimiter);
  }

  app.use((request, response, next) =>
    express.json({ limit: env.ALETHEIA_JSON_BODY_LIMIT ?? "5mb" })(
      request,
      response,
      next,
    ),
  );

  const mutationGuard = auditMutationGuard(shouldBlockAuditWrites);
  const applyWorkspaceUploadLimit = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    const uploadPath = [
      /^\/(?:documents|single-documents)\/?$/,
      /^\/(?:documents|single-documents)\/[^/]+\/versions\/?$/,
      /^\/projects\/[^/]+\/documents\/?$/,
      /^\/projects\/[^/]+\/documents\/[^/]+\/versions\/?$/,
      /^\/projects\/[^/]+\/studio\/documents\/[^/]+\/import-docx\/?$/,
    ].some((pattern) => pattern.test(request.path));
    if (request.method === "POST" && uploadPath) {
      uploadLimiter(request, response, next);
      return;
    }
    next();
  };
  if (legacyRoutesAreEnabled) {
    app.use("/aletheia", mutationGuard);
    const legacyRouters = (options.legacyRouterFactory ?? loadLegacyRouters)();
    for (const legacyRouter of legacyRouters) {
      app.use("/aletheia", legacyRouter);
    }
  }

  // Workspace API composition is intentionally singular: authenticate before
  // the audit mutation guard, then place fixed Workflow and Matter namespaces
  // before the broader v1 router. This prevents generic :id routes from
  // consuming bounded module paths while keeping one /api/v1 boundary.
  const workspaceApi = Router();
  workspaceApi.use(createWorkspaceAuthMiddleware(env));
  workspaceApi.use(mutationGuard);
  workspaceApi.use(applyWorkspaceUploadLimit);
  workspaceApi.use("/model-profiles/:id/test", modelProbeLimiter);
  workspaceApi.use(
    createWorkspaceSettingsV1Router({ runtime: options.runtime.modelSettings }),
  );
  workspaceApi.use(
    createWorkspaceChatsV1Router(options.runtime.chats, {
      capabilities: {
        generation: options.runtime.assistantGenerationAvailable(),
      },
    }),
  );
  workspaceApi.use(
    createWorkspaceTabularV1Router(options.runtime.tabular, {
      requireAuthentication: true,
      capabilities: {
        generation: options.runtime.tabularGenerationAvailable(),
        chat: false,
      },
    }),
  );
  workspaceApi.use(
    "/workflows",
    createWorkspaceWorkflowsV1Router(options.runtime.workflowCrud),
  );
  workspaceApi.use(
    createWorkspaceWorkflowRunsV1Router(options.runtime.workflowCrud),
  );
  workspaceApi.use(
    createWorkspaceDocumentStudioV1Router(options.runtime, {
      requireAuthentication: true,
    }),
  );
  workspaceApi.use(
    createWorkspaceProjectSourcesV1Router(options.runtime, {
      requireAuthentication: true,
    }),
  );
  const matterRuntime = configuredMatterRuntime(options.runtime);
  if (matterRuntime) {
    workspaceApi.use(matterRuntime.createRouter());
  }
  workspaceApi.use(
    createWorkspaceV1Router(options.runtime, { requireAuthentication: true }),
  );
  app.use("/api/v1", workspaceApi);

  const legacyHealth = (runtimeConfigured: boolean) => ({
    status: legacyRuntimeIsEnabled
      ? runtimeConfigured
        ? ("configured" as const)
        : ("not_configured" as const)
      : legacyRoutesAreEnabled
        ? ("routes_only" as const)
        : ("disabled" as const),
    routesEnabled: legacyRoutesAreEnabled,
    runtimeEnabled: legacyRuntimeIsEnabled,
  });

  app.get("/health", (_request, response) => {
    try {
      const workspace = options.runtime.health();
      const audit = getAuditStatus();
      const isLegacyRuntimeConfigured =
        legacyRuntimeIsEnabled && options.legacyRuntimeConfigured?.() === true;
      const draining = isDraining() || workspace.draining;
      const matter = matterHealth(options.runtime);
      const healthy =
        workspace.started &&
        !draining &&
        matter.status !== "unavailable" &&
        (!audit.enabled || audit.healthy);
      response.status(healthy ? 200 : 503).json({
        ok: healthy,
        vera: {
          workspace: {
            started: workspace.started,
            draining,
            pump: {
              documentParse: workspace.worker.documentParse,
              assistantGenerate: workspace.worker.assistantGenerate,
              tabularCell: workspace.worker.tabularCell,
            },
          },
          audit: {
            enabled: audit.enabled,
            healthy: audit.healthy,
            protectionActive: audit.protection_active === true,
          },
          matter,
          conversation: { status: "not_configured" },
          legacy: legacyHealth(isLegacyRuntimeConfigured),
        },
      });
    } catch {
      response.status(503).json({
        ok: false,
        vera: {
          workspace: {
            started: false,
            draining: isDraining(),
            pump: {
              documentParse: false,
              assistantGenerate: false,
              tabularCell: false,
            },
          },
          audit: { enabled: false, healthy: false, protectionActive: false },
          matter: { status: "not_configured" },
          conversation: { status: "not_configured" },
          legacy: legacyHealth(false),
        },
      });
    }
  });

  app.use(safeApplicationErrorHandler());
  return app;
}

export function resolveVeraBindConfiguration(
  env: Environment,
  options: {
    port?: number | string;
    allowPortZero?: boolean;
  } = {},
): { host: typeof LOOPBACK_HOST; port: number } {
  for (const name of ["ALETHEIA_BACKEND_HOST", "HOST"] as const) {
    const configured = env[name]?.trim();
    if (configured && configured !== LOOPBACK_HOST) {
      throw new VeraStartupError(
        `${name} must be configured as ${LOOPBACK_HOST}.`,
      );
    }
  }

  const rawPort = options.port ?? env.PORT ?? DEFAULT_PORT;
  const parsedPort =
    typeof rawPort === "number"
      ? rawPort
      : /^\d+$/.test(rawPort.trim())
        ? Number(rawPort)
        : Number.NaN;
  const injectedZeroAllowed =
    options.allowPortZero === true && options.port !== undefined;
  const minimum = injectedZeroAllowed ? 0 : 1;
  if (
    !Number.isSafeInteger(parsedPort) ||
    parsedPort < minimum ||
    parsedPort > 65_535
  ) {
    throw new VeraStartupError(
      injectedZeroAllowed
        ? "PORT must be an integer between 0 and 65535."
        : "PORT must be an integer between 1 and 65535.",
    );
  }
  return { host: LOOPBACK_HOST, port: parsedPort };
}

function defaultListen(
  app: Express,
  port: number,
  host: string,
): VeraListenHandle {
  const server = app.listen(port, host);
  const ready = new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
  return { server, ready };
}

const defaultDependencies: VeraBootstrapDependencies = {
  assertCompliancePolicy: assertComplianceDeploymentStartupPolicy,
  assertEncryptionPolicy: assertLocalEncryptionStartupPolicy,
  resolveAuthConfiguration: resolveWorkspaceAuthConfiguration,
  startAuditAnchor: startAuditAnchorRuntimeFromEnvironment,
  auditAnchorStatus: auditAnchorRuntimeStatus,
  auditWriteBlocked: shouldFailClosedForAuditAnchor,
  createRuntime: createWorkspaceRuntime,
  configureDurableRuntime: configureLegacyDurableRuntime,
  closeLocalModelRuntime: closeLegacyLocalModelRuntime,
  closeLocalVoiceRuntime: closeLegacyLocalVoiceRuntime,
  runDemoSeed: runLegacyDemoSeed,
  listen: defaultListen,
};

async function closeServerBounded(
  server: VeraListeningServer,
  timeoutMs: number,
): Promise<void> {
  if (!server.listening) return;
  let timeout: NodeJS.Timeout | null = null;
  const closed = new Promise<{ error?: Error }>((resolve) => {
    server.close((error) => resolve(error ? { error } : {}));
  });
  const timedOut = new Promise<{ timedOut: true }>((resolve) => {
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  let outcome: { error?: Error } | { timedOut: true };
  try {
    outcome = await Promise.race([closed, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if ("timedOut" in outcome) {
    server.closeAllConnections?.();
    return;
  }
  if (outcome.error) {
    throw new VeraStartupError("The Vera HTTP server could not close cleanly.");
  }
}

function actualListeningPort(
  server: VeraListeningServer,
  configuredPort: number,
): number {
  const address = server.address?.();
  return address && typeof address !== "string"
    ? (address as AddressInfo).port
    : configuredPort;
}

function demoSeedEnabled(env: Environment): boolean {
  return (
    env.ALETHEIA_ENABLE_DEMO_SEED === "true" && env.NODE_ENV !== "production"
  );
}

export async function bootstrapVeraApplication(
  options: VeraBootstrapOptions = {},
): Promise<VeraApplicationInstance> {
  const env = options.env ?? process.env;
  const legacyRuntimeIsEnabled = legacyRuntimeEnabled(env);
  const binding = resolveVeraBindConfiguration(env, {
    ...(options.port !== undefined ? { port: options.port } : {}),
    allowPortZero: options.allowPortZero,
  });
  resolveTrustProxyHops(env);
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(closeTimeoutMs) ||
    closeTimeoutMs < 1 ||
    closeTimeoutMs > 60_000
  ) {
    throw new VeraStartupError(
      "The server close timeout must be between 1 and 60000 milliseconds.",
    );
  }
  const dependencies: VeraBootstrapDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };

  let auditAnchor: Closable | null = null;
  let runtime: VeraWorkspaceRuntime | null = null;
  let durableRuntime: Closable | null = null;
  let server: VeraListeningServer | null = null;
  let legacyRuntimesConfigured = false;
  let draining = false;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      draining = true;
      const failures: unknown[] = [];
      const attempt = async (action: () => void | Promise<void>) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };

      if (server) {
        await attempt(() => closeServerBounded(server!, closeTimeoutMs));
      }
      if (runtime) await attempt(() => runtime!.stop());
      if (durableRuntime) await attempt(() => durableRuntime!.close());
      if (legacyRuntimesConfigured) {
        await attempt(dependencies.closeLocalModelRuntime);
        await attempt(dependencies.closeLocalVoiceRuntime);
      }
      if (auditAnchor) await attempt(() => auditAnchor!.close());

      if (failures.length > 0) {
        throw new VeraStartupError("Vera shutdown did not complete cleanly.");
      }
    })();
    return shutdownPromise;
  };

  try {
    dependencies.assertCompliancePolicy();
    dependencies.assertEncryptionPolicy();
    const auth = dependencies.resolveAuthConfiguration(env);
    if ("ok" in auth && auth.ok === false) {
      throw new VeraStartupError(
        "Workspace authentication configuration is invalid.",
      );
    }
    auditAnchor = dependencies.startAuditAnchor();
    runtime = dependencies.createRuntime();
    await runtime.start();
    if (legacyRuntimeIsEnabled) {
      // Mark configured before invoking the factory so partial Legacy startup
      // is still cleaned up if configuration throws after creating a model.
      legacyRuntimesConfigured = true;
      durableRuntime = dependencies.configureDurableRuntime();
    }

    const app = createVeraApplication({
      runtime,
      env,
      auditAnchorStatus: dependencies.auditAnchorStatus,
      auditWriteBlocked: dependencies.auditWriteBlocked,
      isDraining: () => draining,
      legacyRuntimeConfigured: () => legacyRuntimesConfigured,
    });
    if (legacyRuntimeIsEnabled && demoSeedEnabled(env)) {
      await dependencies.runDemoSeed();
    }
    const handle = dependencies.listen(app, binding.port, binding.host);
    server = handle.server;
    await handle.ready;

    return {
      app,
      host: binding.host,
      port: actualListeningPort(server, binding.port),
      runtime,
      server,
      shutdown,
    };
  } catch (error) {
    try {
      await shutdown();
    } catch {
      // The original startup failure remains authoritative and is safe-loggable.
    }
    throw error;
  }
}
