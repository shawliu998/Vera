import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  LocalVoiceRuntime,
  localVoiceRuntime,
  type LocalVoiceAuditEvent,
  type VoiceGrantPurpose,
} from "../lib/aletheia/localVoiceRuntime";
import { LocalVoiceError } from "../lib/aletheia/localVoiceProtocol";
import type { AletheiaRepository } from "../lib/aletheia/repository";
import { requireAuth } from "../middleware/auth";

type LocalVoiceRouterDependencies = {
  runtime?: LocalVoiceRuntime;
  repository?: AletheiaRepository;
  auth?: RequestHandler;
};

function userId(res: Response) {
  const value = res.locals.userId;
  if (typeof value !== "string" || !value) {
    throw new LocalVoiceError(
      "Authenticated local user is missing.",
      "capability_denied",
      401,
    );
  }
  return value;
}

function header(req: Request, name: string) {
  const value = req.headers[name];
  return typeof value === "string" ? value.trim() : "";
}

function exactBody(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalVoiceError("Request body must be an object.", "invalid_input");
  }
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new LocalVoiceError(
      `Request contains unsupported field: ${unknown}`,
      "invalid_input",
    );
  }
  return object;
}

function handleError(res: Response, error: unknown) {
  if (error instanceof LocalVoiceError) {
    res.status(error.status).json({ code: error.code, detail: error.message });
    return;
  }
  res.status(500).json({
    code: "local_voice_error",
    detail: error instanceof Error ? error.message : String(error),
  });
}

function rawAudio(limit: number): RequestHandler {
  const parser = express.raw({
    type: ["audio/wav", "audio/x-wav", "audio/l16"],
    limit,
  });
  return (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, (error) => {
      if (!error) return next();
      const status =
        typeof error === "object" &&
        error &&
        "type" in error &&
        error.type === "entity.too.large"
          ? 413
          : 400;
      res.status(status).json({
        code: status === 413 ? "input_too_large" : "invalid_input",
        detail:
          status === 413
            ? `Audio exceeds the ${limit}-byte limit.`
            : "Audio request could not be parsed.",
      });
    });
  };
}

async function defaultAudit(event: LocalVoiceAuditEvent) {
  return createAletheiaRepository().appendAuditEvent(
    { userId: event.userId },
    event.matterId,
    {
      actor: "system",
      action: event.action,
      workflowVersion: "aletheia-local-voice-v1",
      model: event.model,
      details: event.details,
    },
  );
}

export function createLocalVoiceRouter(
  dependencies: LocalVoiceRouterDependencies = {},
) {
  const router = Router();
  const repository = dependencies.repository ?? createAletheiaRepository();
  const runtime =
    dependencies.runtime ?? localVoiceRuntime({ audit: defaultAudit });
  const auth = dependencies.auth ?? requireAuth;

  async function requireMatter(res: Response, matterId: string) {
    const id = userId(res);
    const matter = await repository.getMatterDetail({ userId: id }, matterId);
    if (!matter) {
      throw new LocalVoiceError(
        "Matter was not found or is not available to this user.",
        "capability_denied",
        404,
      );
    }
    return id;
  }

  router.get("/local-voice/status", auth, async (_req, res) => {
    try {
      res.json(await runtime.status());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(
    "/matters/:matterId/local-voice/grants",
    auth,
    async (req, res) => {
      try {
        const body = exactBody(req.body, ["purpose"]);
        const purpose = body.purpose;
        if (purpose !== "transcribe" && purpose !== "tts") {
          throw new LocalVoiceError(
            "purpose must be transcribe or tts.",
            "invalid_input",
          );
        }
        const id = await requireMatter(res, req.params.matterId);
        const grant = await runtime.issueGrant({
          matterId: req.params.matterId,
          userId: id,
          purpose: purpose as VoiceGrantPurpose,
        });
        res.status(201).json({
          schemaVersion: "aletheia-local-voice-grant-v1",
          ...grant,
          singleUse: true,
          localOnly: true,
        });
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post(
    "/matters/:matterId/local-voice/transcriptions",
    auth,
    rawAudio(runtime.maxAudioBytes),
    async (req, res) => {
      try {
        const id = await requireMatter(res, req.params.matterId);
        if (!Buffer.isBuffer(req.body) || !req.body.byteLength) {
          throw new LocalVoiceError(
            "A non-empty audio/wav, audio/x-wav, or audio/L16 body is required.",
            "invalid_input",
          );
        }
        const contentType = req.is("audio/l16")
          ? "audio/l16"
          : req.is("audio/x-wav")
            ? "audio/x-wav"
            : req.is("audio/wav")
              ? "audio/wav"
              : null;
        if (!contentType) {
          throw new LocalVoiceError(
            "Unsupported audio content type.",
            "invalid_input",
            415,
          );
        }
        const sampleRate = header(req, "x-aletheia-pcm-sample-rate");
        const channels = header(req, "x-aletheia-pcm-channels");
        res.status(201).json(
          await runtime.transcribe({
            matterId: req.params.matterId,
            userId: id,
            grantId: header(req, "x-aletheia-voice-grant-id"),
            grantToken: header(req, "x-aletheia-voice-grant-token"),
            audio: {
              bytes: req.body,
              contentType,
              sampleRate: sampleRate ? Number(sampleRate) : undefined,
              channels: channels ? Number(channels) : undefined,
              language: header(req, "x-aletheia-voice-language") || undefined,
            },
          }),
        );
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post(
    "/matters/:matterId/local-voice/speech",
    auth,
    express.json({ limit: "16kb" }),
    async (req, res) => {
      try {
        const body = exactBody(req.body, ["text"]);
        const id = await requireMatter(res, req.params.matterId);
        await runtime.denyUnavailableTts({
          matterId: req.params.matterId,
          userId: id,
          grantId: header(req, "x-aletheia-voice-grant-id"),
          grantToken: header(req, "x-aletheia-voice-grant-token"),
          text: typeof body.text === "string" ? body.text : "",
        });
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  return router;
}
