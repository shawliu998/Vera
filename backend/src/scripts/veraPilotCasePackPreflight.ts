import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  MAX_BATCH_UPLOAD_FILES,
  MAX_UPLOAD_SIZE_BYTES,
  uploadedDocumentValidationError,
} from "../lib/upload";

const allowedExtensions = new Set([".pdf", ".docx", ".xlsx", ".txt", ".md"]);

type Item = {
  pathId: string;
  extension: string;
  sizeBytes: number;
  sha256: string | null;
  ownerOnly: boolean;
  status: "ready" | "blocked";
  issues: string[];
};

function pathId(relativePath: string) {
  return createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
}

function contentSha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function collectFiles(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      const info = lstatSync(current);
      assert(!info.isSymbolicLink(), `Symbolic links are not allowed: ${pathId(path.relative(root, current))}`);
      if (info.isDirectory()) visit(current);
      else if (info.isFile()) files.push(current);
    }
  };
  visit(root);
  return files.sort();
}

async function inspectFile(root: string, filePath: string): Promise<Item> {
  const relativePath = path.relative(root, filePath);
  const id = pathId(relativePath);
  const info = statSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const issues: string[] = [];
  const ownerOnly = (info.mode & 0o077) === 0;
  if (!ownerOnly) issues.push("file_permissions_not_owner_only");
  if (!allowedExtensions.has(extension)) issues.push("unsupported_extension");
  if (info.size === 0) issues.push("empty_file");
  if (info.size > MAX_UPLOAD_SIZE_BYTES) issues.push("file_exceeds_100mb_limit");
  let sha256: string | null = null;
  if (issues.every((issue) => issue !== "file_exceeds_100mb_limit") && info.size > 0) {
    const buffer = readFileSync(filePath);
    sha256 = contentSha256(buffer);
    if (allowedExtensions.has(extension)) {
      const validationError = await uploadedDocumentValidationError({
        originalname: path.basename(filePath),
        buffer,
      } as Express.Multer.File);
      if (validationError) issues.push(`container_validation:${validationError}`);
    }
  }
  return {
    pathId: id,
    extension: extension || "none",
    sizeBytes: info.size,
    sha256,
    ownerOnly,
    status: issues.length === 0 ? "ready" : "blocked",
    issues,
  };
}

async function main() {
  const configured = process.env.VERA_PILOT_CASE_DIR?.trim();
  assert(configured, "VERA_PILOT_CASE_DIR is required");
  assert(path.isAbsolute(configured), "VERA_PILOT_CASE_DIR must be absolute");
  const rootInfo = lstatSync(configured);
  assert(rootInfo.isDirectory(), "VERA_PILOT_CASE_DIR must be a directory");
  assert(!rootInfo.isSymbolicLink(), "VERA_PILOT_CASE_DIR cannot be a symbolic link");
  const root = realpathSync(configured);
  const files = collectFiles(root);
  assert(files.length > 0, "Pilot case directory is empty");
  const items = await Promise.all(files.map((file) => inspectFile(root, file)));
  const blocked = items.filter((item) => item.status === "blocked");
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const extensionCounts = Object.fromEntries(
    [...allowedExtensions].map((extension) => [
      extension,
      items.filter((item) => item.extension === extension).length,
    ]),
  );
  const report = {
    ok: blocked.length === 0,
    suite: "vera-pilot-case-pack-preflight-v1",
    privacy: {
      filenamesEmitted: false,
      absolutePathsEmitted: false,
      contentEmitted: false,
      pathIdentifier: "sha256(relative-path) prefix",
    },
    summary: {
      files: items.length,
      ready: items.length - blocked.length,
      blocked: blocked.length,
      totalBytes,
      uploadBatches: Math.ceil(items.length / MAX_BATCH_UPLOAD_FILES),
      extensionCounts,
    },
    items,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[vera-pilot-case-pack-preflight] failed", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
