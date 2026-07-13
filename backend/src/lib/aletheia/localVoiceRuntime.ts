import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOCAL_VOICE_DEFAULT_MAX_AUDIO_BYTES,
  LOCAL_VOICE_PROTOCOL_VERSION,
  LocalVoiceError,
  modelLabel,
  pcm16ToWav,
  safeLanguage,
  validatePcm16Wav,
  type LocalVoiceRuntimeStatus,
  type LocalVoiceSidecarRequest,
  type LocalVoiceTranscription,
  type ValidatedVoiceAudio,
} from "./localVoiceProtocol";

export type VoiceGrantPurpose = "transcribe" | "tts";

export type LocalVoiceGrant = {
  grantId: string;
  token: string;
  matterId: string;
  purpose: VoiceGrantPurpose;
  expiresAt: string;
};

type StoredGrant = Omit<LocalVoiceGrant, "token"> & {
  userId: string;
  tokenHash: Buffer;
  consumed: boolean;
};

export type VoiceAudioInput = {
  bytes: Buffer;
  contentType: "audio/wav" | "audio/x-wav" | "audio/l16";
  sampleRate?: number;
  channels?: number;
  language?: string;
};

export type LocalVoiceAuditEvent = {
  action:
    | "local_voice_grant_issued"
    | "local_voice_transcription_completed"
    | "local_voice_transcription_failed"
    | "local_voice_tts_denied";
  matterId: string;
  userId: string;
  model: string | null;
  details: Record<string, unknown>;
};

export type LocalVoiceTranscriptionResult = LocalVoiceTranscription & {
  schemaVersion: "aletheia-local-voice-transcription-v1";
  localOnly: true;
  audioSha256: string;
  durationSeconds: number;
  confirmationRequired: true;
  submittedToAgent: false;
  auditEvent: unknown | null;
};

export type SidecarExecutor = (
  request: LocalVoiceSidecarRequest,
  timeoutMs: number,
) => Promise<Record<string, unknown>>;

export type LocalVoiceRuntimeOptions = {
  pythonPath?: string;
  sidecarPath?: string;
  sidecarSha256?: string;
  sttModelPath?: string;
  ttsModelPath?: string;
  tempRoot?: string;
  maxAudioBytes?: number;
  timeoutMs?: number;
  grantTtlMs?: number;
  executor?: SidecarExecutor;
  audit?: (event: LocalVoiceAuditEvent) => Promise<unknown | null>;
  now?: () => number;
};

type RuntimePaths = {
  pythonPath?: string;
  sidecarPath?: string;
  sttModelPath?: string;
  ttsModelPath?: string;
  pathFailure: string | null;
};

const MAX_SIDECAR_OUTPUT_BYTES = 1024 * 1024;

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveBounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function regularAbsolutePath(
  value: string | undefined,
  kind: "file" | "directory",
  label: string,
): string | undefined {
  if (!value) return undefined;
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new LocalVoiceError(
      `${label} must be an absolute local path.`,
      "runtime_unavailable",
      503,
    );
  }
  const canonical = realpathSync(value);
  const stat = lstatSync(canonical);
  const valid = kind === "file" ? stat.isFile() : stat.isDirectory();
  if (!valid) {
    throw new LocalVoiceError(
      `${label} is not a local ${kind}.`,
      "runtime_unavailable",
      503,
    );
  }
  return canonical;
}

function defaultSidecarPath() {
  return path.resolve(
    __dirname,
    "../../../voice_sidecar/aletheia_voice_sidecar.py",
  );
}

function runtimePaths(options: LocalVoiceRuntimeOptions): RuntimePaths {
  const failures: string[] = [];
  const resolve = <T>(callback: () => T): T | undefined => {
    try {
      return callback();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  const pythonPath = resolve(() =>
    regularAbsolutePath(
      options.pythonPath ?? process.env.ALETHEIA_VOICE_PYTHON_PATH,
      "file",
      "Voice Python runtime",
    ),
  );
  const requestedSidecar =
    options.sidecarPath ??
    process.env.ALETHEIA_VOICE_SIDECAR_PATH ??
    defaultSidecarPath();
  let sidecarPath = resolve(() =>
    regularAbsolutePath(requestedSidecar, "file", "Voice sidecar"),
  );
  const pinnedHash =
    options.sidecarSha256 ?? process.env.ALETHEIA_VOICE_SIDECAR_SHA256;
  if (process.env.ALETHEIA_VOICE_SIDECAR_PATH && !options.sidecarPath && !pinnedHash) {
    failures.push("An overridden voice sidecar requires ALETHEIA_VOICE_SIDECAR_SHA256.");
    sidecarPath = undefined;
  }
  if (sidecarPath && pinnedHash) {
    const actual = sha256(readFileSync(sidecarPath));
    if (actual !== pinnedHash.replace(/^sha256:/, "").toLowerCase()) {
      failures.push("Voice sidecar hash does not match the operator pin.");
      sidecarPath = undefined;
    }
  }
  const sttModelPath = resolve(() =>
    regularAbsolutePath(
      options.sttModelPath ?? process.env.ALETHEIA_VOICE_STT_MODEL_PATH,
      "directory",
      "faster-whisper model",
    ),
  );
  const ttsModelPath = resolve(() =>
    regularAbsolutePath(
      options.ttsModelPath ?? process.env.ALETHEIA_VOICE_TTS_MODEL_PATH,
      "directory",
      "NeuTTS model",
    ),
  );
  return {
    pythonPath,
    sidecarPath,
    sttModelPath,
    ttsModelPath,
    pathFailure: failures.length ? failures.join(" ") : null,
  };
}

function parseSidecarResponse(stdout: Buffer) {
  if (stdout.byteLength > MAX_SIDECAR_OUTPUT_BYTES) {
    throw new LocalVoiceError(
      "Voice sidecar output exceeded its limit.",
      "sidecar_failed",
      502,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw new LocalVoiceError(
      "Voice sidecar returned invalid JSON.",
      "sidecar_failed",
      502,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalVoiceError(
      "Voice sidecar returned an invalid response.",
      "sidecar_failed",
      502,
    );
  }
  return value as Record<string, unknown>;
}

export class LocalVoiceRuntime {
  readonly maxAudioBytes: number;
  readonly timeoutMs: number;
  private readonly grantTtlMs: number;
  private readonly now: () => number;
  private readonly audit?: LocalVoiceRuntimeOptions["audit"];
  private readonly paths: RuntimePaths;
  private readonly tempRoot: string;
  private readonly grants = new Map<string, StoredGrant>();
  private readonly activeChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly executor: SidecarExecutor;
  private closed = false;

  constructor(options: LocalVoiceRuntimeOptions = {}) {
    this.paths = runtimePaths(options);
    this.maxAudioBytes = positiveBounded(
      options.maxAudioBytes ?? Number(process.env.ALETHEIA_VOICE_MAX_AUDIO_BYTES),
      LOCAL_VOICE_DEFAULT_MAX_AUDIO_BYTES,
      64 * 1024 * 1024,
    );
    this.timeoutMs = positiveBounded(
      options.timeoutMs ?? Number(process.env.ALETHEIA_VOICE_TIMEOUT_MS),
      180_000,
      300_000,
    );
    this.grantTtlMs = positiveBounded(options.grantTtlMs, 60_000, 5 * 60_000);
    this.now = options.now ?? Date.now;
    this.audit = options.audit;
    const requestedTemp =
      options.tempRoot ??
      process.env.ALETHEIA_VOICE_TEMP_DIR ??
      path.join(os.tmpdir(), "aletheia-local-voice");
    if (!path.isAbsolute(requestedTemp)) {
      throw new LocalVoiceError(
        "Voice temp directory must be absolute.",
        "runtime_unavailable",
        503,
      );
    }
    mkdirSync(requestedTemp, { recursive: true, mode: 0o700 });
    chmodSync(requestedTemp, 0o700);
    this.tempRoot = realpathSync(requestedTemp);
    this.executor = options.executor ?? this.executeSidecar.bind(this);
  }

  async status(): Promise<LocalVoiceRuntimeStatus> {
    const base = this.baseStatus();
    if (!base.pythonInstalled || !base.sidecarInstalled) return base;
    try {
      const response = await this.executor(
        {
          protocolVersion: LOCAL_VOICE_PROTOCOL_VERSION,
          operation: "health",
          sttModelPath: this.paths.sttModelPath,
          ttsModelPath: this.paths.ttsModelPath,
        },
        Math.min(this.timeoutMs, 30_000),
      );
      return this.healthResponse(response, base);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        healthy: false,
        failureReason: reason,
        stt: { ...base.stt, healthy: false, available: false, failureReason: reason },
        tts: { ...base.tts, healthy: false, available: false, failureReason: reason },
      };
    }
  }

  async issueGrant(input: {
    matterId: string;
    userId: string;
    purpose: VoiceGrantPurpose;
  }): Promise<LocalVoiceGrant> {
    this.assertOpen();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(input.matterId)) {
      throw new LocalVoiceError("matterId is invalid.", "invalid_input");
    }
    if (!input.userId || input.userId.length > 320) {
      throw new LocalVoiceError("userId is invalid.", "invalid_input");
    }
    const grantId = randomBytes(18).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + this.grantTtlMs).toISOString();
    this.grants.set(grantId, {
      grantId,
      matterId: input.matterId,
      userId: input.userId,
      purpose: input.purpose,
      expiresAt,
      tokenHash: createHash("sha256").update(token).digest(),
      consumed: false,
    });
    await this.audit?.({
      action: "local_voice_grant_issued",
      matterId: input.matterId,
      userId: input.userId,
      model: null,
      details: {
        grantId,
        purpose: input.purpose,
        expiresAt,
        singleUse: true,
      },
    });
    return { grantId, token, matterId: input.matterId, purpose: input.purpose, expiresAt };
  }

  async transcribe(input: {
    matterId: string;
    userId: string;
    grantId: string;
    grantToken: string;
    audio: VoiceAudioInput;
  }): Promise<LocalVoiceTranscriptionResult> {
    this.assertOpen();
    if (input.audio.bytes.byteLength > this.maxAudioBytes) {
      throw new LocalVoiceError(
        `Audio exceeds the ${this.maxAudioBytes}-byte limit.`,
        "input_too_large",
        413,
      );
    }
    const grant = this.consumeGrant(input, "transcribe");
    const audioSha256 = sha256(input.audio.bytes);
    let validated: ValidatedVoiceAudio | undefined;
    let tempPath: string | undefined;
    let cleaned = false;
    try {
      validated =
        input.audio.contentType === "audio/l16"
          ? pcm16ToWav(
              input.audio.bytes,
              Number(input.audio.sampleRate),
              Number(input.audio.channels),
            )
          : validatePcm16Wav(input.audio.bytes);
      const health = await this.status();
      if (!health.stt.available || !this.paths.sttModelPath) {
        throw new LocalVoiceError(
          health.stt.failureReason ?? "Local faster-whisper is unavailable.",
          "runtime_unavailable",
          503,
        );
      }
      const matterTemp = path.join(this.tempRoot, sha256(input.matterId).slice(0, 24));
      mkdirSync(matterTemp, { recursive: true, mode: 0o700 });
      chmodSync(matterTemp, 0o700);
      tempPath = path.join(matterTemp, `${randomBytes(18).toString("hex")}.wav`);
      writeFileSync(tempPath, validated.wav, { mode: 0o600, flag: "wx" });
      const response = await this.executor(
        {
          protocolVersion: LOCAL_VOICE_PROTOCOL_VERSION,
          operation: "transcribe",
          sttModelPath: this.paths.sttModelPath,
          inputPath: tempPath,
          language: safeLanguage(input.audio.language),
        },
        this.timeoutMs,
      );
      const transcript =
        typeof response.transcript === "string" ? response.transcript.trim() : "";
      if (!transcript) {
        throw new LocalVoiceError(
          "Local transcription returned no text.",
          "sidecar_failed",
          502,
        );
      }
      rmSync(tempPath, { force: true });
      cleaned = !existsSync(tempPath);
      const result = {
        schemaVersion: "aletheia-local-voice-transcription-v1" as const,
        localOnly: true as const,
        transcript,
        model:
          typeof response.model === "string"
            ? response.model
            : modelLabel(this.paths.sttModelPath),
        language:
          typeof response.language === "string" ? response.language : null,
        audioSha256,
        durationSeconds: validated.durationSeconds,
        confirmationRequired: true as const,
        submittedToAgent: false as const,
        auditEvent: null as unknown,
      };
      result.auditEvent = await this.audit?.({
        action: "local_voice_transcription_completed",
        matterId: input.matterId,
        userId: input.userId,
        model: result.model,
        details: {
          grantId: grant.grantId,
          audioSha256,
          audioBytes: input.audio.bytes.byteLength,
          durationSeconds: validated.durationSeconds,
          sampleRate: validated.sampleRate,
          channels: validated.channels,
          language: result.language,
          temporaryAudioDeleted: cleaned,
          confirmationRequired: true,
          submittedToAgent: false,
        },
      }) ?? null;
      return result;
    } catch (error) {
      if (tempPath) {
        rmSync(tempPath, { force: true });
        cleaned = !existsSync(tempPath);
      } else {
        cleaned = true;
      }
      await this.audit?.({
        action: "local_voice_transcription_failed",
        matterId: input.matterId,
        userId: input.userId,
        model: this.paths.sttModelPath ? modelLabel(this.paths.sttModelPath) : null,
        details: {
          grantId: grant.grantId,
          audioSha256,
          audioBytes: input.audio.bytes.byteLength,
          durationSeconds: validated?.durationSeconds ?? null,
          temporaryAudioDeleted: cleaned,
          errorCode:
            error instanceof LocalVoiceError ? error.code : "sidecar_failed",
        },
      });
      throw error;
    } finally {
      if (tempPath) rmSync(tempPath, { force: true });
    }
  }

  async denyUnavailableTts(input: {
    matterId: string;
    userId: string;
    grantId: string;
    grantToken: string;
    text: string;
  }): Promise<never> {
    this.assertOpen();
    const grant = this.consumeGrant(input, "tts");
    if (!input.text.trim() || input.text.length > 8_000) {
      throw new LocalVoiceError(
        "TTS text must contain 1 to 8000 characters.",
        "invalid_input",
      );
    }
    const health = await this.status();
    const reason =
      health.tts.failureReason ??
      "Local NeuTTS synthesis adapter is unavailable in this package.";
    await this.audit?.({
      action: "local_voice_tts_denied",
      matterId: input.matterId,
      userId: input.userId,
      model: this.paths.ttsModelPath ? modelLabel(this.paths.ttsModelPath) : null,
      details: {
        grantId: grant.grantId,
        textSha256: sha256(input.text),
        streaming: false,
        reason,
      },
    });
    throw new LocalVoiceError(reason, "runtime_unavailable", 503);
  }

  async close() {
    this.closed = true;
    this.grants.clear();
    for (const child of this.activeChildren) child.kill("SIGKILL");
    this.activeChildren.clear();
  }

  private assertOpen() {
    if (this.closed)
      throw new LocalVoiceError("Local voice runtime is closed.", "closed", 503);
  }

  private consumeGrant(
    input: {
      matterId: string;
      userId: string;
      grantId: string;
      grantToken: string;
    },
    purpose: VoiceGrantPurpose,
  ) {
    const grant = this.grants.get(input.grantId);
    const presented = createHash("sha256").update(input.grantToken ?? "").digest();
    if (
      !grant ||
      !timingSafeEqual(presented, grant.tokenHash) ||
      grant.matterId !== input.matterId ||
      grant.userId !== input.userId ||
      grant.purpose !== purpose
    ) {
      throw new LocalVoiceError(
        "Voice capability grant is invalid for this matter and operation.",
        "capability_denied",
        403,
      );
    }
    if (Date.parse(grant.expiresAt) <= this.now()) {
      throw new LocalVoiceError("Voice capability grant expired.", "grant_expired", 403);
    }
    if (grant.consumed) {
      throw new LocalVoiceError(
        "Voice capability grant was already consumed.",
        "grant_exhausted",
        403,
      );
    }
    grant.consumed = true;
    return grant;
  }

  private baseStatus(): LocalVoiceRuntimeStatus {
    const pythonInstalled = Boolean(this.paths.pythonPath);
    const sidecarInstalled = Boolean(this.paths.sidecarPath);
    const sttModelImported = Boolean(this.paths.sttModelPath);
    const ttsModelImported = Boolean(this.paths.ttsModelPath);
    const failureReason =
      this.paths.pathFailure ??
      (!pythonInstalled
        ? "ALETHEIA_VOICE_PYTHON_PATH is not configured to an absolute local Python executable."
        : !sidecarInstalled
          ? "The packaged local voice sidecar is missing."
          : !sttModelImported
            ? "No offline faster-whisper model directory has been imported."
            : null);
    return {
      schemaVersion: "aletheia-local-voice-status-v1",
      localOnly: true,
      pythonInstalled,
      sidecarInstalled,
      healthy: false,
      failureReason,
      stt: {
        engine: "faster-whisper",
        installed: false,
        modelImported: sttModelImported,
        healthy: false,
        available: false,
        failureReason,
      },
      tts: {
        engine: "neutts",
        installed: false,
        modelImported: ttsModelImported,
        healthy: false,
        available: false,
        failureReason:
          failureReason ??
          "NeuTTS is optional and no supported local synthesis adapter is active.",
        streaming: false,
      },
    };
  }

  private healthResponse(
    response: Record<string, unknown>,
    base: LocalVoiceRuntimeStatus,
  ): LocalVoiceRuntimeStatus {
    const object = (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const stt = object(response.stt);
    const tts = object(response.tts);
    const sttInstalled = stt.installed === true;
    const sttHealthy = stt.healthy === true && base.stt.modelImported;
    const ttsInstalled = tts.installed === true;
    const ttsHealthy =
      tts.healthy === true && base.tts.modelImported && tts.available === true;
    const sttReason =
      typeof stt.failureReason === "string"
        ? stt.failureReason
        : sttHealthy
          ? null
          : base.stt.failureReason ?? "faster-whisper health check failed.";
    const ttsReason =
      typeof tts.failureReason === "string"
        ? tts.failureReason
        : ttsHealthy
          ? null
          : "NeuTTS is unavailable; no streaming capability is claimed.";
    return {
      ...base,
      healthy: sttHealthy,
      failureReason: sttHealthy ? null : sttReason,
      stt: {
        ...base.stt,
        installed: sttInstalled,
        healthy: sttHealthy,
        available: sttHealthy,
        failureReason: sttReason,
      },
      tts: {
        ...base.tts,
        installed: ttsInstalled,
        healthy: ttsHealthy,
        available: ttsHealthy,
        failureReason: ttsReason,
        streaming: false,
      },
    };
  }

  private executeSidecar(
    request: LocalVoiceSidecarRequest,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    this.assertOpen();
    if (!this.paths.pythonPath || !this.paths.sidecarPath) {
      return Promise.reject(
        new LocalVoiceError(
          this.paths.pathFailure ?? "Local voice runtime is not installed.",
          "runtime_unavailable",
          503,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.paths.pythonPath!, [this.paths.sidecarPath!], {
        cwd: this.tempRoot,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          ALETHEIA_VOICE_NETWORK_DISABLED: "1",
        },
      });
      this.activeChildren.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: unknown, response?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChildren.delete(child);
        if (error) reject(error);
        else resolve(response ?? {});
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(
          new LocalVoiceError(
            "Local voice sidecar timed out.",
            "sidecar_timeout",
            504,
          ),
        );
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_SIDECAR_OUTPUT_BYTES) child.kill("SIGKILL");
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(stderr).byteLength < 16_384) stderr.push(chunk);
      });
      child.once("error", (error) =>
        finish(new LocalVoiceError(error.message, "sidecar_failed", 502)),
      );
      child.once("close", (code) => {
        if (outputBytes > MAX_SIDECAR_OUTPUT_BYTES) {
          finish(
            new LocalVoiceError(
              "Voice sidecar output exceeded its limit.",
              "sidecar_failed",
              502,
            ),
          );
          return;
        }
        if (code !== 0) {
          finish(
            new LocalVoiceError(
              `Voice sidecar failed (${code}): ${Buffer.concat(stderr)
                .toString("utf8")
                .trim()
                .slice(0, 500)}`,
              "sidecar_failed",
              502,
            ),
          );
          return;
        }
        try {
          const response = parseSidecarResponse(Buffer.concat(stdout));
          if (response.ok === false) {
            throw new LocalVoiceError(
              typeof response.error === "string"
                ? response.error
                : "Voice sidecar rejected the request.",
              response.code === "runtime_unavailable"
                ? "runtime_unavailable"
                : "sidecar_failed",
              response.code === "runtime_unavailable" ? 503 : 502,
            );
          }
          finish(undefined, response);
        } catch (error) {
          finish(error);
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

let singleton: LocalVoiceRuntime | null = null;

export function localVoiceRuntime(options: LocalVoiceRuntimeOptions = {}) {
  singleton ??= new LocalVoiceRuntime(options);
  return singleton;
}

export async function closeLocalVoiceRuntime() {
  await singleton?.close();
  singleton = null;
}
