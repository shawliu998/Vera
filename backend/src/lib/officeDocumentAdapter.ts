import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import type { AgentArtifactLinkInput, AgentArtifactType } from "./agentTasks";

export const OFFICECLI_PINNED_VERSION = "1.0.139";
export const OFFICECLI_RELEASE_URL =
  "https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.139";
export const OFFICECLI_LICENSE = "Apache-2.0";

export const OFFICECLI_RELEASE_ASSETS = {
  "linux-arm64": {
    asset: "officecli-linux-arm64",
    sha256: "39008c7f76d202858637810553ef14e2cd3e7f61485fdcf2011f26967a7babd1",
  },
  "linux-x64": {
    asset: "officecli-linux-x64",
    sha256: "da07d4f787d7c85724104294ac023c89971ddfaee93ebb183b289282b8f869cc",
  },
  "darwin-arm64": {
    asset: "officecli-mac-arm64",
    sha256: "393874f79db58222bdbede7f4f942f2536580386923857d1b5ad9754efe80c19",
  },
  "darwin-x64": {
    asset: "officecli-mac-x64",
    sha256: "6a931d424975dded6ae413c8c1f63d00dfb30a4bd4bd50352964782d13299f5c",
  },
  "win32-arm64": {
    asset: "officecli-win-arm64.exe",
    sha256: "6d80a93ba0c9cafb2b52048efbb403cd761b35126130fa8166383599aa91d96e",
  },
  "win32-x64": {
    asset: "officecli-win-x64.exe",
    sha256: "864e0580c8e8c91a6aa4a4c1e8900551c8d4aa648ff10136ceed3a6ba5310888",
  },
} as const;

const ALLOWED_DOCUMENT_COMMANDS: ReadonlySet<string> = new Set([
  "create",
  "merge",
  "validate",
  "view",
] as const);
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_OFFICE_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;

type OfficeFileType = "docx" | "xlsx";

export type OfficeCliBinarySpec = {
  binaryPath: string;
  expectedSha256: string;
};

export type OfficeDocumentAdapterOptions = OfficeCliBinarySpec & {
  timeoutMs?: number;
};

export type OfficeDocumentInspection = {
  fileType: OfficeFileType;
  data: unknown;
};

export type OfficeDocumentValidation = {
  fileType: OfficeFileType;
  valid: boolean;
  cli: unknown;
  structuralChecks: string[];
};

export type OfficeDocumentVersionCandidate = {
  stagedPath: string;
  filename: string;
  fileType: OfficeFileType;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  source: "generated";
  generator: {
    name: "OfficeCLI";
    version: typeof OFFICECLI_PINNED_VERSION;
  };
};

export type OfficeDocumentRender = {
  stagedPath: string;
  filename: string;
  contentType: "image/png";
  sizeBytes: number;
  sha256: string;
};

export class OfficeDocumentAdapterError extends Error {
  constructor(
    message: string,
    readonly code:
      | "BINARY_UNAVAILABLE"
      | "BINARY_INTEGRITY"
      | "COMMAND_NOT_ALLOWED"
      | "COMMAND_FAILED"
      | "INVALID_INPUT"
      | "INVALID_OUTPUT",
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OfficeDocumentAdapterError";
  }
}

type CommandResult = {
  stdout: string;
  stderr: string;
};

type Workspace = {
  root: string;
  home: string;
};

function hostReleaseAsset() {
  const key =
    `${process.platform}-${process.arch}` as keyof typeof OFFICECLI_RELEASE_ASSETS;
  return OFFICECLI_RELEASE_ASSETS[key];
}

export function configuredOfficeCliBinarySpec(
  binaryPath = process.env.OFFICECLI_BINARY_PATH,
): OfficeCliBinarySpec {
  if (!binaryPath?.trim()) {
    throw new OfficeDocumentAdapterError(
      "OfficeCLI is optional and OFFICECLI_BINARY_PATH is not configured",
      "BINARY_UNAVAILABLE",
    );
  }
  const asset = hostReleaseAsset();
  if (!asset) {
    throw new OfficeDocumentAdapterError(
      `OfficeCLI v${OFFICECLI_PINNED_VERSION} has no pinned binary for ${process.platform}/${process.arch}`,
      "BINARY_UNAVAILABLE",
    );
  }
  return {
    binaryPath,
    expectedSha256: asset.sha256,
  };
}

async function sha256File(filePath: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function limitedText(chunks: Buffer[], byteCount: number) {
  if (byteCount <= MAX_CAPTURE_BYTES)
    return Buffer.concat(chunks).toString("utf8");
  return Buffer.concat(chunks, MAX_CAPTURE_BYTES).toString("utf8");
}

function fileTypeForPath(filePath: string): OfficeFileType {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".docx") return "docx";
  if (extension === ".xlsx") return "xlsx";
  throw new OfficeDocumentAdapterError(
    "OfficeDocumentAdapter only accepts .docx and .xlsx files",
    "INVALID_INPUT",
    { filePath },
  );
}

async function assertRegularFile(filePath: string, label: string) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    throw new OfficeDocumentAdapterError(
      `${label} is unavailable`,
      "INVALID_INPUT",
      {
        filePath,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new OfficeDocumentAdapterError(
      `${label} must be a regular file, not a symlink`,
      "INVALID_INPUT",
      { filePath },
    );
  }
  if (info.size <= 0 || info.size > MAX_OFFICE_FILE_BYTES) {
    throw new OfficeDocumentAdapterError(
      `${label} must be between 1 byte and ${MAX_OFFICE_FILE_BYTES} bytes`,
      "INVALID_INPUT",
      { filePath, sizeBytes: info.size },
    );
  }
  return info;
}

async function assertUnusedOutputPath(
  outputPath: string,
  expectedExtension: ".docx" | ".xlsx" | ".png",
  protectedPaths: string[] = [],
) {
  const absoluteOutput = resolve(outputPath);
  if (extname(absoluteOutput).toLowerCase() !== expectedExtension) {
    throw new OfficeDocumentAdapterError(
      `Output must use the ${expectedExtension} extension`,
      "INVALID_OUTPUT",
      { outputPath },
    );
  }
  if (protectedPaths.some((filePath) => resolve(filePath) === absoluteOutput)) {
    throw new OfficeDocumentAdapterError(
      "Output may not replace an input file",
      "INVALID_OUTPUT",
      { outputPath },
    );
  }
  const parent = dirname(absoluteOutput);
  const parentInfo = await stat(parent).catch(() => null);
  if (!parentInfo?.isDirectory()) {
    throw new OfficeDocumentAdapterError(
      "Output directory does not exist",
      "INVALID_OUTPUT",
      { outputPath, parent },
    );
  }
  const existing = await lstat(absoluteOutput).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (existing) {
    throw new OfficeDocumentAdapterError(
      "Output path already exists; OfficeDocumentAdapter never overwrites files",
      "INVALID_OUTPUT",
      { outputPath },
    );
  }
  return absoluteOutput;
}

function jsonResult(stdout: string, operation: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new OfficeDocumentAdapterError(
      `${operation} returned malformed JSON`,
      "INVALID_OUTPUT",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "success" in parsed &&
    (parsed as { success?: unknown }).success === false
  ) {
    throw new OfficeDocumentAdapterError(
      `${operation} reported failure`,
      "COMMAND_FAILED",
      { response: parsed },
    );
  }
  return parsed;
}

async function validateOfficePackage(
  filePath: string,
  fileType: OfficeFileType,
) {
  const info = await assertRegularFile(filePath, "Generated Office file");
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(await readFile(filePath));
  } catch (error) {
    throw new OfficeDocumentAdapterError(
      "Generated output is not a readable OOXML package",
      "INVALID_OUTPUT",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const required =
    fileType === "docx"
      ? ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]
      : ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"];
  for (const entry of required) {
    const part = archive.file(entry);
    if (!part) {
      throw new OfficeDocumentAdapterError(
        `Generated ${fileType} is missing ${entry}`,
        "INVALID_OUTPUT",
      );
    }
    const xml = await part.async("string");
    if (!xml.trim().startsWith("<") || xml.length > 20 * 1024 * 1024) {
      throw new OfficeDocumentAdapterError(
        `Generated ${fileType} contains an invalid ${entry}`,
        "INVALID_OUTPUT",
      );
    }
  }
  return {
    sizeBytes: info.size,
    checks: required.map((entry) => `OOXML part present: ${entry}`),
  };
}

async function validatePng(filePath: string) {
  const info = await assertRegularFile(filePath, "Rendered PNG");
  const bytes = await readFile(filePath);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const iend = Buffer.from([73, 69, 78, 68]);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, pngSignature.length).equals(pngSignature) ||
    bytes.lastIndexOf(iend) < 0
  ) {
    throw new OfficeDocumentAdapterError(
      "OfficeCLI render did not produce a structurally valid PNG",
      "INVALID_OUTPUT",
    );
  }
  return info;
}

export class OfficeDocumentAdapter {
  private constructor(
    private readonly binaryPath: string,
    private readonly timeoutMs: number,
  ) {}

  static async create(options: OfficeDocumentAdapterOptions) {
    const binaryPath = resolve(options.binaryPath);
    let binaryInfo;
    try {
      binaryInfo = await lstat(binaryPath);
      await access(binaryPath, fsConstants.X_OK);
    } catch (error) {
      throw new OfficeDocumentAdapterError(
        "Configured OfficeCLI binary is absent or not executable",
        "BINARY_UNAVAILABLE",
        {
          binaryPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (binaryInfo.isSymbolicLink() || !binaryInfo.isFile()) {
      throw new OfficeDocumentAdapterError(
        "Configured OfficeCLI binary must be a regular executable file",
        "BINARY_INTEGRITY",
        { binaryPath },
      );
    }

    const expectedSha256 = options.expectedSha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new OfficeDocumentAdapterError(
        "OfficeCLI requires an explicit pinned SHA-256 checksum",
        "BINARY_INTEGRITY",
        { expectedSha256: options.expectedSha256 },
      );
    }
    const actualSha256 = await sha256File(binaryPath);
    if (actualSha256 !== expectedSha256) {
      throw new OfficeDocumentAdapterError(
        "Configured OfficeCLI binary does not match the pinned checksum",
        "BINARY_INTEGRITY",
        { expectedSha256, actualSha256 },
      );
    }

    const timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    const adapter = new OfficeDocumentAdapter(binaryPath, timeoutMs);
    const version = (await adapter.runVersion()).stdout
      .trim()
      .replace(/^v/, "");
    if (version !== OFFICECLI_PINNED_VERSION) {
      throw new OfficeDocumentAdapterError(
        "Configured OfficeCLI binary does not match the pinned version",
        "BINARY_INTEGRITY",
        { expectedVersion: OFFICECLI_PINNED_VERSION, actualVersion: version },
      );
    }
    return adapter;
  }

  async inspect(
    inputPath: string,
    maxLines = 200,
  ): Promise<OfficeDocumentInspection> {
    const fileType = fileTypeForPath(inputPath);
    const result = await this.withCopiedInput(
      inputPath,
      async (workspace, copied) => {
        const command = await this.runDocumentCommand(
          [
            "view",
            copied,
            "text",
            "--max-lines",
            String(Math.max(1, Math.min(Math.floor(maxLines), 2_000))),
            "--json",
          ],
          workspace,
        );
        return jsonResult(command.stdout, "OfficeCLI inspect");
      },
    );
    return { fileType, data: result };
  }

  async createWordFromTemplate(
    templatePath: string,
    outputPath: string,
    data: Record<string, unknown>,
  ): Promise<OfficeDocumentVersionCandidate> {
    if (fileTypeForPath(templatePath) !== "docx") {
      throw new OfficeDocumentAdapterError(
        "Word templates must be .docx files",
        "INVALID_INPUT",
      );
    }
    const absoluteOutput = await assertUnusedOutputPath(outputPath, ".docx", [
      templatePath,
    ]);
    return this.withCopiedInput(
      templatePath,
      async (workspace, copiedTemplate) => {
        await validateOfficePackage(copiedTemplate, "docx");
        const staged = join(workspace.root, "generated.docx");
        const dataPath = join(workspace.root, "merge-data.json");
        await writeFile(dataPath, JSON.stringify(data), {
          mode: 0o600,
          flag: "wx",
        });
        const command = await this.runDocumentCommand(
          ["merge", copiedTemplate, staged, "--data", dataPath, "--json"],
          workspace,
        );
        const mergeResult = jsonResult(
          command.stdout,
          "OfficeCLI Word template merge",
        );
        const mergeData =
          mergeResult && typeof mergeResult === "object"
            ? (mergeResult as { data?: unknown }).data
            : null;
        const unresolved =
          mergeData && typeof mergeData === "object"
            ? (mergeData as { unresolvedPlaceholders?: unknown })
                .unresolvedPlaceholders
            : null;
        if (!Array.isArray(unresolved) || unresolved.length > 0) {
          throw new OfficeDocumentAdapterError(
            "Generated Word output has unresolved or unreported template placeholders",
            "INVALID_OUTPUT",
            { unresolvedPlaceholders: unresolved },
          );
        }
        await this.assertCliValid(staged, "docx", workspace);
        await this.publishExclusive(staged, absoluteOutput);
        return this.versionCandidate(absoluteOutput, "docx");
      },
    );
  }

  async createExcel(
    outputPath: string,
  ): Promise<OfficeDocumentVersionCandidate> {
    const absoluteOutput = await assertUnusedOutputPath(outputPath, ".xlsx");
    return this.withWorkspace(async (workspace) => {
      const staged = join(workspace.root, "generated.xlsx");
      const command = await this.runDocumentCommand(
        ["create", staged, "--json"],
        workspace,
      );
      jsonResult(command.stdout, "OfficeCLI Excel create");
      await this.assertCliValid(staged, "xlsx", workspace);
      await this.publishExclusive(staged, absoluteOutput);
      return this.versionCandidate(absoluteOutput, "xlsx");
    });
  }

  async validate(inputPath: string): Promise<OfficeDocumentValidation> {
    const fileType = fileTypeForPath(inputPath);
    return this.withCopiedInput(inputPath, async (workspace, copied) => {
      const structural = await validateOfficePackage(copied, fileType);
      const command = await this.runDocumentCommand(
        ["validate", copied, "--json"],
        workspace,
      );
      const cli = jsonResult(command.stdout, "OfficeCLI validate");
      return {
        fileType,
        valid: this.cliValidationCount(cli) === 0,
        cli,
        structuralChecks: structural.checks,
      };
    });
  }

  async render(
    inputPath: string,
    outputPath: string,
  ): Promise<OfficeDocumentRender> {
    fileTypeForPath(inputPath);
    const absoluteOutput = await assertUnusedOutputPath(outputPath, ".png", [
      inputPath,
    ]);
    return this.withCopiedInput(inputPath, async (workspace, copied) => {
      const staged = join(workspace.root, "render.png");
      await this.runDocumentCommand(
        [
          "view",
          copied,
          "screenshot",
          "--render",
          "html",
          "--page",
          "1",
          "-o",
          staged,
          "--json",
        ],
        workspace,
      );
      await validatePng(staged);
      await this.publishExclusive(staged, absoluteOutput);
      const info = await stat(absoluteOutput);
      return {
        stagedPath: absoluteOutput,
        filename: basename(absoluteOutput),
        contentType: "image/png",
        sizeBytes: info.size,
        sha256: await sha256File(absoluteOutput),
      };
    });
  }

  toArtifactLink(
    documentId: string,
    purpose: string,
    artifactType: AgentArtifactType = "document",
  ): AgentArtifactLinkInput {
    if (!documentId.trim() || !purpose.trim()) {
      throw new OfficeDocumentAdapterError(
        "Document artifact links require a document id and purpose",
        "INVALID_INPUT",
      );
    }
    return {
      artifact_type: artifactType,
      artifact_id: documentId,
      purpose,
    };
  }

  private async assertCliValid(
    filePath: string,
    fileType: OfficeFileType,
    workspace: Workspace,
  ) {
    await validateOfficePackage(filePath, fileType);
    const command = await this.runDocumentCommand(
      ["validate", filePath, "--json"],
      workspace,
    );
    const cli = jsonResult(command.stdout, `OfficeCLI ${fileType} validate`);
    const count = this.cliValidationCount(cli);
    if (count !== 0) {
      throw new OfficeDocumentAdapterError(
        `Generated ${fileType} failed OfficeCLI validation`,
        "INVALID_OUTPUT",
        { validation: cli },
      );
    }
    // OfficeCLI issue #231 reports that nominally read-only commands can write.
    // Re-check the package after validation before publishing the temp copy.
    await validateOfficePackage(filePath, fileType);
  }

  private cliValidationCount(cli: unknown) {
    if (!cli || typeof cli !== "object") return null;
    const data = (cli as { data?: unknown }).data;
    if (!data || typeof data !== "object") return null;
    const count = (data as { count?: unknown }).count;
    return typeof count === "number" ? count : null;
  }

  private async versionCandidate(
    filePath: string,
    fileType: OfficeFileType,
  ): Promise<OfficeDocumentVersionCandidate> {
    const info = await stat(filePath);
    return {
      stagedPath: filePath,
      filename: basename(filePath),
      fileType,
      contentType:
        fileType === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: info.size,
      sha256: await sha256File(filePath),
      source: "generated",
      generator: { name: "OfficeCLI", version: OFFICECLI_PINNED_VERSION },
    };
  }

  private async publishExclusive(staged: string, outputPath: string) {
    try {
      await copyFile(staged, outputPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      throw new OfficeDocumentAdapterError(
        "Could not publish generated output without overwriting an existing file",
        "INVALID_OUTPUT",
        {
          outputPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async withCopiedInput<T>(
    inputPath: string,
    operation: (workspace: Workspace, copiedInput: string) => Promise<T>,
  ) {
    const absoluteInput = resolve(inputPath);
    await assertRegularFile(absoluteInput, "Office input");
    const originalHash = await sha256File(absoluteInput);
    return this.withWorkspace(async (workspace) => {
      const copiedInput = join(
        workspace.root,
        `input${extname(absoluteInput).toLowerCase()}`,
      );
      await copyFile(absoluteInput, copiedInput, fsConstants.COPYFILE_EXCL);
      try {
        return await operation(workspace, copiedInput);
      } finally {
        const finalHash = await sha256File(absoluteInput);
        if (finalHash !== originalHash) {
          throw new OfficeDocumentAdapterError(
            "Original input changed during isolated OfficeCLI execution",
            "INVALID_INPUT",
            { inputPath: absoluteInput, originalHash, finalHash },
          );
        }
      }
    });
  }

  private async withWorkspace<T>(
    operation: (workspace: Workspace) => Promise<T>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "vera-officecli-"));
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    try {
      return await operation({ root, home });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private runVersion() {
    return this.withWorkspace((workspace) =>
      this.run(["--version"], workspace, true),
    );
  }

  private runDocumentCommand(args: string[], workspace: Workspace) {
    const command = args[0];
    if (!command || !ALLOWED_DOCUMENT_COMMANDS.has(command)) {
      throw new OfficeDocumentAdapterError(
        `OfficeCLI command is not allowlisted: ${command || "<empty>"}`,
        "COMMAND_NOT_ALLOWED",
      );
    }
    return this.run(args, workspace, false);
  }

  private run(args: string[], workspace: Workspace, versionCheck: boolean) {
    return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(this.binaryPath, args, {
        shell: false,
        detached: process.platform !== "win32",
        cwd: workspace.root,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: workspace.home,
          USERPROFILE: workspace.home,
          XDG_CONFIG_HOME: join(workspace.home, ".config"),
          XDG_CACHE_HOME: join(workspace.home, ".cache"),
          TMPDIR: workspace.root,
          LANG: process.env.LANG ?? "C.UTF-8",
          LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
          OFFICECLI_SKIP_UPDATE: "1",
          OFFICECLI_NO_AUTO_INSTALL: "1",
          OFFICECLI_NO_AUTO_RESIDENT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // The group may have exited between the timeout and this signal.
          }
        }
        child.kill("SIGKILL");
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes < MAX_CAPTURE_BYTES) stdout.push(chunk);
        stdoutBytes += chunk.length;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes < MAX_CAPTURE_BYTES) stderr.push(chunk);
        stderrBytes += chunk.length;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectPromise(
          new OfficeDocumentAdapterError(
            "OfficeCLI process could not start",
            "COMMAND_FAILED",
            { cause: error.message },
          ),
        );
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const capturedStdout = limitedText(stdout, stdoutBytes);
        const capturedStderr = limitedText(stderr, stderrBytes);
        if (timedOut || code !== 0) {
          rejectPromise(
            new OfficeDocumentAdapterError(
              timedOut
                ? "OfficeCLI command exceeded its hard timeout"
                : "OfficeCLI command failed",
              "COMMAND_FAILED",
              {
                command: versionCheck ? "version" : args[0],
                exitCode: code,
                signal,
                timedOut,
                stderr: capturedStderr,
              },
            ),
          );
          return;
        }
        if (
          stdoutBytes > MAX_CAPTURE_BYTES ||
          stderrBytes > MAX_CAPTURE_BYTES
        ) {
          rejectPromise(
            new OfficeDocumentAdapterError(
              "OfficeCLI output exceeded the capture limit",
              "COMMAND_FAILED",
              { stdoutBytes, stderrBytes },
            ),
          );
          return;
        }
        resolvePromise({ stdout: capturedStdout, stderr: capturedStderr });
      });
    });
  }
}
