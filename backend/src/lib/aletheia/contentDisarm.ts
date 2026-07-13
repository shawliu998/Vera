import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export type ContentDisarmMode = "disabled" | "best_effort" | "required";
export type ContentDisarmStatus =
  | "disabled"
  | "sanitized"
  | "unsupported"
  | "unavailable"
  | "rejected"
  | "error";

export type ContentDisarmMetadata = {
  mode: ContentDisarmMode;
  status: ContentDisarmStatus;
  supported: boolean;
  converter: "libreoffice" | null;
  converterVersion: string | null;
  originalSha256: string;
  derivedSha256: string | null;
  derivedFilename: string | null;
  derivedMimeType: "application/pdf" | null;
  networkIsolation: "macos-sandbox-exec" | "injected-test-isolator" | null;
  timeoutMs: number;
  maxOutputBytes: number;
  detail: string;
  processedAt: string;
};

export type ContentDisarmResult = {
  metadata: ContentDisarmMetadata;
  derivedBuffer?: Buffer;
};

export class ContentDisarmBlockedError extends Error {
  readonly code: "cdr_unavailable" | "cdr_failed" | "cdr_unsupported";

  constructor(
    code: "cdr_unavailable" | "cdr_failed" | "cdr_unsupported",
    readonly result: ContentDisarmResult,
  ) {
    super(result.metadata.detail);
    this.name = "ContentDisarmBlockedError";
    this.code = code;
  }
}

export type ContentDisarmCommand = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  expectedOutputPath?: string;
};

export type ContentDisarmCommandResult = {
  code: number | null;
  output: string;
  timedOut: boolean;
  outputPath?: string;
};

export type ContentDisarmRunner = (
  command: ContentDisarmCommand,
) => Promise<ContentDisarmCommandResult>;

export type ContentDisarmOptions = {
  mode?: ContentDisarmMode;
  converterPath?: string | null;
  executableAllowlist?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  runner?: ContentDisarmRunner;
  injectedNetworkIsolation?: boolean;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
const MAX_PROCESS_LOG_BYTES = 64 * 1024;
const DEFAULT_CONVERTER_PATHS = [
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/opt/homebrew/bin/soffice",
  "/usr/local/bin/soffice",
  "/usr/bin/libreoffice",
  "/usr/bin/soffice",
];

function configuredMode(): ContentDisarmMode {
  const value = process.env.ALETHEIA_CDR_MODE?.trim();
  if (value === "required" || value === "best_effort") return value;
  return "disabled";
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return Number.isInteger(value) && Number(value) >= minimum
    ? Math.min(Number(value), maximum)
    : fallback;
}

function timeoutMs(options: ContentDisarmOptions) {
  const configured = Number(process.env.ALETHEIA_CDR_TIMEOUT_MS);
  return boundedInteger(
    options.timeoutMs,
    Number.isFinite(configured) ? configured : DEFAULT_TIMEOUT_MS,
    1_000,
    10 * 60_000,
  );
}

function maxOutputBytes(options: ContentDisarmOptions) {
  const configured = Number(process.env.ALETHEIA_CDR_MAX_OUTPUT_BYTES);
  return boundedInteger(
    options.maxOutputBytes,
    Number.isFinite(configured) ? configured : DEFAULT_MAX_OUTPUT_BYTES,
    1_024,
    1024 * 1024 * 1024,
  );
}

function fileHash(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function bufferHash(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function extension(filename: string) {
  return path.extname(filename).toLowerCase();
}

function supportedExtension(filename: string) {
  return extension(filename) === ".docx" || extension(filename) === ".xlsx";
}

function configuredAllowlist(options: ContentDisarmOptions) {
  const configured = process.env.ALETHEIA_CDR_EXECUTABLE_ALLOWLIST?.split(
    path.delimiter,
  ).filter(Boolean);
  return options.executableAllowlist ?? configured ?? DEFAULT_CONVERTER_PATHS;
}

function canonicalAllowedExecutables(options: ContentDisarmOptions) {
  const allowed = new Set<string>();
  for (const candidate of configuredAllowlist(options)) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      allowed.add(realpathSync(candidate));
    } catch {
      // Missing allowlist entries are not executable capabilities.
    }
  }
  return allowed;
}

function resolveConverter(options: ContentDisarmOptions) {
  const configured =
    options.converterPath === undefined
      ? process.env.ALETHEIA_CDR_LIBREOFFICE_PATH?.trim()
      : options.converterPath;
  const candidate = configured || DEFAULT_CONVERTER_PATHS.find(existsSync);
  if (!candidate) return null;
  if (!path.isAbsolute(candidate)) {
    throw new Error("CDR converter path must be absolute");
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("CDR converter must be a regular non-symbolic-link file");
  }
  const canonical = realpathSync(candidate);
  if (!canonicalAllowedExecutables(options).has(canonical)) {
    throw new Error(
      "CDR converter realpath is not in the executable allowlist",
    );
  }
  return canonical;
}

function defaultRunner(command: ContentDisarmCommand) {
  return new Promise<ContentDisarmCommandResult>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let outputExceeded = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      const remaining = command.maxOutputBytes - Buffer.byteLength(output);
      if (remaining <= 0) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      output += chunk.toString("utf8", 0, remaining);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, output, timedOut: true });
    }, command.timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: outputExceeded ? null : code,
        output: outputExceeded
          ? `${output}\nCDR process output exceeded the configured limit.`
          : output,
        timedOut: false,
        outputPath: command.expectedOutputPath,
      });
    });
  });
}

function networkIsolatedCommand(
  converter: string,
  converterArgs: string[],
  options: ContentDisarmOptions,
) {
  if (options.injectedNetworkIsolation && options.runner) {
    return {
      executable: converter,
      args: converterArgs,
      isolation: "injected-test-isolator" as const,
    };
  }
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    return {
      executable: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        "(version 1) (allow default) (deny network*)",
        converter,
        ...converterArgs,
      ],
      isolation: "macos-sandbox-exec" as const,
    };
  }
  return null;
}

function baseMetadata(args: {
  mode: ContentDisarmMode;
  status: ContentDisarmStatus;
  supported: boolean;
  originalSha256: string;
  timeoutMs: number;
  maxOutputBytes: number;
  detail: string;
}): ContentDisarmMetadata {
  return {
    mode: args.mode,
    status: args.status,
    supported: args.supported,
    converter: null,
    converterVersion: null,
    originalSha256: args.originalSha256,
    derivedSha256: null,
    derivedFilename: null,
    derivedMimeType: null,
    networkIsolation: null,
    timeoutMs: args.timeoutMs,
    maxOutputBytes: args.maxOutputBytes,
    detail: args.detail.slice(0, 2_000),
    processedAt: new Date().toISOString(),
  };
}

function blockedIfRequired(
  mode: ContentDisarmMode,
  code: ContentDisarmBlockedError["code"],
  result: ContentDisarmResult,
) {
  if (mode === "required") throw new ContentDisarmBlockedError(code, result);
  return result;
}

function validateInput(filePath: string) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("CDR accepts regular non-symbolic-link input files only");
  }
}

function validateDerivedOutput(
  outputRoot: string,
  outputPath: string,
  maximum: number,
) {
  const lexicalRoot = path.resolve(outputRoot);
  const root = realpathSync(outputRoot);
  const lexicalPath = path.resolve(outputPath);
  const relative = path.relative(lexicalRoot, lexicalPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("CDR output path escaped the isolated output directory");
  }
  const stat = lstatSync(lexicalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("CDR output must be a regular non-symbolic-link file");
  }
  const canonical = realpathSync(lexicalPath);
  const canonicalRelative = path.relative(root, canonical);
  if (
    !canonicalRelative ||
    canonicalRelative.startsWith("..") ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(
      "CDR output realpath escaped the isolated output directory",
    );
  }
  if (stat.size <= 0 || stat.size > maximum) {
    throw new Error("CDR output size is empty or exceeds the configured limit");
  }
  const buffer = readFileSync(canonical);
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("CDR output does not have a PDF signature");
  }
  return buffer;
}

export async function disarmLocalUpload(
  filePath: string,
  filename: string,
  options: ContentDisarmOptions = {},
): Promise<ContentDisarmResult> {
  validateInput(filePath);
  const mode = options.mode ?? configuredMode();
  const originalSha256 = fileHash(filePath);
  const configuredTimeout = timeoutMs(options);
  const configuredMaximum = maxOutputBytes(options);
  const supported = supportedExtension(filename);

  if (mode === "disabled") {
    return {
      metadata: baseMetadata({
        mode,
        status: "disabled",
        supported,
        originalSha256,
        timeoutMs: configuredTimeout,
        maxOutputBytes: configuredMaximum,
        detail:
          "Content disarm and reconstruction is disabled; no sanitization is claimed.",
      }),
    };
  }
  if (!supported) {
    const result = {
      metadata: baseMetadata({
        mode,
        status: "unsupported",
        supported: false,
        originalSha256,
        timeoutMs: configuredTimeout,
        maxOutputBytes: configuredMaximum,
        detail: `${extension(filename) || "extensionless"} files are not sanitized by the local LibreOffice CDR adapter.`,
      }),
    };
    return blockedIfRequired(mode, "cdr_unsupported", result);
  }

  let converter: string;
  try {
    const resolved = resolveConverter(options);
    if (!resolved)
      throw new Error("No trusted local LibreOffice converter is available");
    converter = resolved;
  } catch (error) {
    const result = {
      metadata: baseMetadata({
        mode,
        status: "unavailable",
        supported: true,
        originalSha256,
        timeoutMs: configuredTimeout,
        maxOutputBytes: configuredMaximum,
        detail: error instanceof Error ? error.message : String(error),
      }),
    };
    return blockedIfRequired(mode, "cdr_unavailable", result);
  }

  const workspace = mkdtempSync(path.join(os.tmpdir(), "aletheia-cdr-"));
  chmodSync(workspace, 0o700);
  const inputDir = path.join(workspace, "input");
  const outputDir = path.join(workspace, "output");
  const profileDir = path.join(workspace, "profile");
  for (const directory of [inputDir, outputDir, profileDir]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const safeExtension = extension(filename);
  const isolatedInput = path.join(inputDir, `source${safeExtension}`);
  copyFileSync(filePath, isolatedInput);
  chmodSync(isolatedInput, 0o400);
  const expectedOutput = path.join(outputDir, "source.pdf");
  const converterArgs = [
    `-env:UserInstallation=${new URL(`file://${profileDir}`).href}`,
    "--headless",
    "--nologo",
    "--nodefault",
    "--nolockcheck",
    "--nofirststartwizard",
    "--convert-to",
    "pdf",
    "--outdir",
    outputDir,
    isolatedInput,
  ];
  const isolated = networkIsolatedCommand(converter, converterArgs, options);
  if (!isolated) {
    rmSync(workspace, { recursive: true, force: true });
    const result = {
      metadata: baseMetadata({
        mode,
        status: "unavailable",
        supported: true,
        originalSha256,
        timeoutMs: configuredTimeout,
        maxOutputBytes: configuredMaximum,
        detail:
          "No verified no-network process isolator is available for the CDR converter.",
      }),
    };
    return blockedIfRequired(mode, "cdr_unavailable", result);
  }

  const runner = options.runner ?? defaultRunner;
  try {
    const commandResult = await runner({
      executable: isolated.executable,
      args: isolated.args,
      cwd: workspace,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: profileDir,
        TMPDIR: workspace,
        LANG: "C.UTF-8",
        http_proxy: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        no_proxy: "*",
      },
      timeoutMs: configuredTimeout,
      maxOutputBytes: MAX_PROCESS_LOG_BYTES,
      expectedOutputPath: expectedOutput,
    });
    if (commandResult.timedOut) throw new Error("CDR converter timed out");
    if (commandResult.code !== 0) {
      throw new Error(
        `CDR converter exited with code ${String(commandResult.code)}: ${commandResult.output.slice(0, 1_000)}`,
      );
    }
    const outputPath = commandResult.outputPath ?? expectedOutput;
    const derivedBuffer = validateDerivedOutput(
      outputDir,
      outputPath,
      configuredMaximum,
    );
    const versionOutput = await runner({
      executable: isolated.executable,
      args:
        isolated.isolation === "macos-sandbox-exec"
          ? isolated.args.slice(0, 2).concat(converter, "--version")
          : ["--version"],
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin", HOME: profileDir, TMPDIR: workspace },
      timeoutMs: Math.min(configuredTimeout, 5_000),
      maxOutputBytes: 4_096,
    });
    const converterVersion =
      versionOutput.code === 0
        ? versionOutput.output.trim().slice(0, 500) || "version-not-reported"
        : "version-unavailable";
    return {
      metadata: {
        ...baseMetadata({
          mode,
          status: "sanitized",
          supported: true,
          originalSha256,
          timeoutMs: configuredTimeout,
          maxOutputBytes: configuredMaximum,
          detail:
            "A PDF safety derivative was produced by the trusted local LibreOffice adapter; the original remains authoritative evidence.",
        }),
        converter: "libreoffice",
        converterVersion,
        derivedSha256: bufferHash(derivedBuffer),
        derivedFilename: `${path.basename(filename, safeExtension)}.cdr.pdf`,
        derivedMimeType: "application/pdf",
        networkIsolation: isolated.isolation,
      },
      derivedBuffer,
    };
  } catch (error) {
    const result = {
      metadata: {
        ...baseMetadata({
          mode,
          status: "error",
          supported: true,
          originalSha256,
          timeoutMs: configuredTimeout,
          maxOutputBytes: configuredMaximum,
          detail: error instanceof Error ? error.message : String(error),
        }),
        converter: "libreoffice" as const,
        networkIsolation: isolated.isolation,
      },
    };
    return blockedIfRequired(mode, "cdr_failed", result);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function contentDisarmPolicy() {
  const mode = configuredMode();
  let converterAvailable = false;
  try {
    converterAvailable = Boolean(resolveConverter({}));
  } catch {
    converterAvailable = false;
  }
  const networkIsolationAvailable =
    process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  return {
    mode,
    adapter: "libreoffice-to-pdf",
    supportedExtensions: [".docx", ".xlsx"],
    unsupportedExtensions: [".pdf", ".txt", ".md"],
    converterAvailable,
    networkIsolationAvailable,
    available: converterAvailable && networkIsolationAvailable,
    failClosed: mode === "required",
    claim:
      mode === "disabled"
        ? "disabled_no_sanitization_claimed"
        : "only_successful_pdf_derivatives_are_marked_sanitized",
  };
}
