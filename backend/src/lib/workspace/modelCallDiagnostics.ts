import { mkdirSync, existsSync, lstatSync, statSync, unlinkSync, renameSync, openSync, writeSync, closeSync, chmodSync } from "node:fs";
import path from "node:path";

import type { ModelProvider as ModelProviderName } from "./types";
import type {
  ModelEvent,
  ModelGenerateRequest,
  ModelProvider,
  ModelProviderConfig,
} from "./providers";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export type ModelCallDiagnosticStatus =
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ModelCallDiagnostic = Readonly<{
  requestId: string;
  provider: ModelProviderName;
  model: string;
  startedAt: string;
  completedAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  status: ModelCallDiagnosticStatus;
  errorCode: string | null;
}>;

export interface ModelCallDiagnosticsPort {
  record(value: ModelCallDiagnostic): void;
}

function safeText(value: string, maximum: number) {
  return value
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\s"']+/g, "[redacted-path]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function safeCode(value: string | null) {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
  return normalized.slice(0, 120) || "provider_error";
}

function safeTokenCount(value: number | null) {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value : null;
}

function assertRegularOrMissing(filePath: string) {
  if (!existsSync(filePath)) return;
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Model diagnostic log path is unsafe.");
  }
}

export class RotatingModelCallDiagnostics implements ModelCallDiagnosticsPort {
  private readonly directory: string;
  private readonly activePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(
    directory: string,
    options: { maxBytes?: number; maxFiles?: number } = {},
  ) {
    this.directory = path.resolve(directory);
    this.activePath = path.join(this.directory, "model-calls.jsonl");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1_024 ||
      !Number.isSafeInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > 20
    ) {
      throw new Error("Model diagnostic log rotation is invalid.");
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Model diagnostic log directory is unsafe.");
    }
    chmodSync(this.directory, 0o700);
  }

  private rotatedPath(index: number) {
    return `${this.activePath}.${index}`;
  }

  private rotate() {
    for (let index = this.maxFiles; index >= 1; index -= 1) {
      const source =
        index === 1 ? this.activePath : this.rotatedPath(index - 1);
      const destination = this.rotatedPath(index);
      assertRegularOrMissing(source);
      assertRegularOrMissing(destination);
      if (existsSync(destination)) unlinkSync(destination);
      if (existsSync(source)) renameSync(source, destination);
    }
  }

  record(value: ModelCallDiagnostic) {
    const record = {
      schema: "vera-model-call-diagnostic-v1",
      request_id: safeText(value.requestId, 80),
      provider: value.provider,
      model: safeText(value.model, 200),
      started_at: value.startedAt,
      completed_at: value.completedAt,
      input_tokens: safeTokenCount(value.inputTokens),
      output_tokens: safeTokenCount(value.outputTokens),
      status: value.status,
      error_code: safeCode(value.errorCode),
    };
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    assertRegularOrMissing(this.activePath);
    const current = existsSync(this.activePath)
      ? statSync(this.activePath).size
      : 0;
    if (current > 0 && current + bytes > this.maxBytes) this.rotate();
    const descriptor = openSync(this.activePath, "a", 0o600);
    try {
      writeSync(descriptor, line);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(this.activePath, 0o600);
  }
}

function errorCodeFrom(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return safeCode((error as { code: string }).code);
  }
  return "provider_exception";
}

export function instrumentModelProvider(input: {
  provider: ModelProvider;
  config: ModelProviderConfig;
  diagnostics: ModelCallDiagnosticsPort;
  requestId: () => string;
  clock?: () => Date;
}): ModelProvider {
  const clock = input.clock ?? (() => new Date());
  return {
    id: input.provider.id,
    validateConfiguration: (config) =>
      input.provider.validateConfiguration(config),
    async *generate(
      request: ModelGenerateRequest,
      signal: AbortSignal,
    ): AsyncIterable<ModelEvent> {
      const requestId = input.requestId();
      const startedAt = clock().toISOString();
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let status: ModelCallDiagnosticStatus = "interrupted";
      let errorCode: string | null = "stream_incomplete";
      try {
        for await (const event of input.provider.generate(request, signal)) {
          if (event.type === "usage") {
            inputTokens = event.inputTokens ?? inputTokens;
            outputTokens = event.outputTokens ?? outputTokens;
          } else if (event.type === "completed") {
            status = "complete";
            errorCode = null;
          } else if (event.type === "error") {
            status = "failed";
            errorCode = safeCode(event.code);
          }
          yield event;
        }
        if (signal.aborted && status !== "complete") {
          status = "cancelled";
          errorCode = "cancelled";
        }
      } catch (error) {
        status = signal.aborted ? "cancelled" : "failed";
        errorCode = signal.aborted ? "cancelled" : errorCodeFrom(error);
        throw error;
      } finally {
        try {
          input.diagnostics.record({
            requestId,
            provider: input.config.profile.provider,
            model: input.config.profile.model,
            startedAt,
            completedAt: clock().toISOString(),
            inputTokens,
            outputTokens,
            status,
            errorCode,
          });
        } catch {
          // Diagnostics are best-effort and must never alter a model result.
        }
      }
    },
  };
}
