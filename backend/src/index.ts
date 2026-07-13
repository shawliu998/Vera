import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { aletheiaRouter } from "./routes/aletheia";
import { litigationRouter } from "./routes/litigation";
import { durableAgentRunsRouter } from "./routes/durableAgentRuns";
import { localGovernanceRouter } from "./routes/localGovernance";
import { localModelsRouter } from "./routes/localModels";
import { createLocalVoiceRouter } from "./routes/localVoice";
import { createAletheiaLocalControlRouter } from "./routes/aletheiaLocalControl";
import { legalResearchRouter } from "./routes/legalResearch";
import { legalResearchIssuesRouter } from "./routes/legalResearchIssues";
import { legalOpinionsRouter } from "./routes/legalOpinions";
import { seedAletheiaDemoIfNeeded } from "./lib/aletheia/demoSeed";
import { configureDurableAgentRuntimeFromEnvironment } from "./lib/aletheia/durableAgentRuntime";
import { closeLocalModelRuntime } from "./lib/aletheia/localModelRuntime";
import { closeLocalVoiceRuntime } from "./lib/aletheia/localVoiceRuntime";
import { assertLocalEncryptionStartupPolicy } from "./lib/aletheia/localEnvelopeCrypto";
import { assertComplianceDeploymentStartupPolicy } from "./lib/aletheia/localCompliancePreset";
import {
  auditAnchorRuntimeStatus,
  shouldFailClosedForAuditAnchor,
  startAuditAnchorRuntimeFromEnvironment,
} from "./lib/aletheia/auditAnchorJournal";

assertComplianceDeploymentStartupPolicy();
assertLocalEncryptionStartupPolicy();
const auditAnchorRuntime = startAuditAnchorRuntimeFromEnvironment();

const app = express();
const PORT = process.env.PORT ?? 3001;
const isProduction = process.env.NODE_ENV === "production";
const HOST =
  process.env.ALETHEIA_BACKEND_HOST ?? process.env.HOST ?? "127.0.0.1";
const durableAgentRuntime = configureDurableAgentRuntimeFromEnvironment();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    message: {
      detail: options.message ?? "Too many requests. Please try again later.",
    },
  });
}

const generalLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_GENERAL_MAX", 300),
});

const uploadLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_UPLOAD_MAX", 50),
  message: "Too many upload requests. Please try again later.",
});

const externalSourceLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_EXTERNAL_SOURCE_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_EXTERNAL_SOURCE_MAX", 20),
  message:
    "Too many external-source retrieval requests. Please try again later.",
});

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", isProduction ? 1 : 0));

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
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  }),
);

app.use(generalLimiter);

app.post(
  "/aletheia/matters/:matterId/external-source/fetch",
  externalSourceLimiter,
);
app.post("/aletheia/matters/:matterId/research/*", externalSourceLimiter);
app.post("/aletheia/matters/:matterId/documents", uploadLimiter);
app.post("/aletheia/matters/:matterId/documents/batch", uploadLimiter);

app.use((req, res, next) =>
  express.json({ limit: process.env.ALETHEIA_JSON_BODY_LIMIT ?? "5mb" })(
    req,
    res,
    next,
  ),
);

app.use("/aletheia", (req, res, next) => {
  const readOnlyMethod = req.method === "GET" || req.method === "HEAD";
  if (!readOnlyMethod && shouldFailClosedForAuditAnchor()) {
    return void res.status(503).json({
      detail:
        "High-assurance audit anchoring is unhealthy. State-changing operations are blocked until an operator restores and verifies the external anchor journal.",
      code: "audit_anchor_fail_closed",
    });
  }
  next();
});

app.use("/aletheia", aletheiaRouter);
app.use("/aletheia", legalResearchRouter);
app.use("/aletheia", legalResearchIssuesRouter);
app.use("/aletheia", legalOpinionsRouter);
app.use("/aletheia", litigationRouter);
app.use("/aletheia", durableAgentRunsRouter);
app.use("/aletheia", localGovernanceRouter);
app.use("/aletheia", localModelsRouter);
app.use("/aletheia", createLocalVoiceRouter());
app.use("/aletheia", createAletheiaLocalControlRouter());

app.get("/health", (_req, res) => {
  const auditAnchor = auditAnchorRuntimeStatus();
  const healthy = !auditAnchor.enabled || auditAnchor.healthy;
  res.status(healthy ? 200 : 503).json({ ok: healthy, auditAnchor });
});

const server = app.listen(Number(PORT), HOST, () => {
  console.log(`Aletheia backend running at http://${HOST}:${PORT}`);
  seedAletheiaDemoIfNeeded()
    .then((result) => {
      if ("matterId" in result) {
        console.log(
          `Aletheia demo seed created matter ${result.matterId} (${result.reason})`,
        );
      }
    })
    .catch((error) => {
      console.error("[aletheia-demo-seed] failed", error);
    });
});

let shutdownPromise: Promise<void> | null = null;

function shutdown() {
  shutdownPromise ??= (async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await durableAgentRuntime?.close();
    await closeLocalModelRuntime();
    await closeLocalVoiceRuntime();
    auditAnchorRuntime?.close();
  })();
  return shutdownPromise;
}

function requestShutdown() {
  void shutdown().catch((error) => {
    console.error("[aletheia-shutdown] failed", error);
    process.exitCode = 1;
  });
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
