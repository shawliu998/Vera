import type { Request, RequestHandler } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_MB = Math.round(
  MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
);
export const MAX_BATCH_UPLOAD_FILES = 100;
export const MAX_BATCH_UPLOAD_SIZE_BYTES =
  MAX_BATCH_UPLOAD_FILES * MAX_UPLOAD_SIZE_BYTES;
export const MAX_BATCH_UPLOAD_SIZE_MB = Math.round(
  MAX_BATCH_UPLOAD_SIZE_BYTES / (1024 * 1024),
);

const DEFAULT_UPLOAD_TEMP_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_UPLOAD_TEMP_TTL_MS = 60 * 60 * 1000;
const UPLOAD_TEMP_JANITOR_INTERVAL_MS = 60 * 60 * 1000;
const UPLOAD_TEMP_FILENAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredUploadTempTtlMs() {
  const configured = Number(process.env.ALETHEIA_UPLOAD_TEMP_TTL_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_UPLOAD_TEMP_TTL_MS;
  }
  return Math.max(Math.floor(configured), MIN_UPLOAD_TEMP_TTL_MS);
}

export const UPLOAD_TEMP_TTL_MS = configuredUploadTempTtlMs();
export const UPLOAD_TEMP_ROOT = path.join(
  os.tmpdir(),
  "aletheia-secure-uploads",
);

async function ensureUploadRoot() {
  await mkdir(UPLOAD_TEMP_ROOT, { recursive: true, mode: 0o700 });
  await chmod(UPLOAD_TEMP_ROOT, 0o700);
}

export async function cleanupStaleUploadedFiles(
  options: { now?: number; ttlMs?: number } = {},
) {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? UPLOAD_TEMP_TTL_MS;
  await ensureUploadRoot();
  const entries = await readdir(UPLOAD_TEMP_ROOT, { withFileTypes: true });
  const stalePaths: string[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      if (!UPLOAD_TEMP_FILENAME_PATTERN.test(entry.name)) return;
      const candidate = path.join(UPLOAD_TEMP_ROOT, entry.name);
      try {
        const stats = await lstat(candidate);
        if (now - stats.mtimeMs >= ttlMs) stalePaths.push(candidate);
      } catch {
        // Another request or janitor pass may already have removed the file.
      }
    }),
  );

  await Promise.allSettled(
    stalePaths.map((candidate) => rm(candidate, { force: true })),
  );
  return stalePaths.length;
}

function runUploadTempJanitor() {
  void cleanupStaleUploadedFiles().catch(() => {
    // Upload requests still perform explicit cleanup; a janitor failure is retried.
  });
}

runUploadTempJanitor();
const uploadTempJanitor = setInterval(
  runUploadTempJanitor,
  UPLOAD_TEMP_JANITOR_INTERVAL_MS,
);
uploadTempJanitor.unref();

function diskUpload(maxFiles: number) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => {
        void ensureUploadRoot()
          .then(() => callback(null, UPLOAD_TEMP_ROOT))
          .catch((error) => callback(error, UPLOAD_TEMP_ROOT));
      },
      filename: (_req, _file, callback) => callback(null, randomUUID()),
    }),
    limits: {
      fileSize: MAX_UPLOAD_SIZE_BYTES,
      files: maxFiles,
    },
  });
}

export async function materializeUploadedFile(file: Express.Multer.File) {
  if (file.buffer) return file;
  if (!file.path) throw new Error("Temporary upload path is missing");
  return { ...file, buffer: await readFile(file.path) };
}

export async function cleanupUploadedFile(file: Express.Multer.File) {
  if (file.path) await rm(file.path, { force: true });
}

export async function cleanupUploadedFiles(
  files: readonly Express.Multer.File[],
) {
  await Promise.allSettled(files.map((file) => cleanupUploadedFile(file)));
}

function requestUploadedFiles(req: Request) {
  const files: Express.Multer.File[] = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) {
    files.push(...req.files);
  } else if (req.files) {
    files.push(...Object.values(req.files).flat());
  }
  return [...new Set(files)];
}

async function handleUploadCompletion(
  err: unknown,
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
  aggregateLimitBytes: number,
) {
  const files = requestUploadedFiles(req);

  if (!err) {
    const aggregateBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (aggregateBytes <= aggregateLimitBytes) return next();

    await cleanupUploadedFiles(files);
    req.file = undefined;
    req.files = [];
    return void res.status(413).json({
      detail: `Upload batch too large. Maximum aggregate size is ${Math.round(
        aggregateLimitBytes / (1024 * 1024),
      )} MB.`,
    });
  }

  await cleanupUploadedFiles(files);
  req.file = undefined;
  req.files = [];

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return void res.status(413).json({
        detail: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_MB} MB.`,
      });
    }
    return void res.status(400).json({
      detail: `Upload failed: ${err.message}`,
    });
  }

  return next(err);
}

const singleDiskUpload = diskUpload(1);

export function singleFileUpload(fieldName: string): RequestHandler {
  return (req, res, next) => {
    singleDiskUpload.single(fieldName)(req, res, (err) => {
      void handleUploadCompletion(
        err,
        req,
        res,
        next,
        MAX_UPLOAD_SIZE_BYTES,
      ).catch(next);
    });
  };
}

export function multiFileUpload(
  fieldName: string,
  maxFiles = MAX_BATCH_UPLOAD_FILES,
): RequestHandler {
  const effectiveMaxFiles = Math.min(
    Math.max(1, Math.floor(maxFiles)),
    MAX_BATCH_UPLOAD_FILES,
  );
  const upload = diskUpload(effectiveMaxFiles);
  return (req, res, next) => {
    upload.array(fieldName, effectiveMaxFiles)(req, res, (err) => {
      void handleUploadCompletion(
        err,
        req,
        res,
        next,
        MAX_BATCH_UPLOAD_SIZE_BYTES,
      ).catch(next);
    });
  };
}

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".txt",
  ".md",
]);

export async function uploadedDocumentValidationError(
  file: Express.Multer.File,
) {
  const filename = file.originalname.toLowerCase();
  const extension = filename.includes(".")
    ? filename.slice(filename.lastIndexOf("."))
    : "";
  if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(extension)) {
    return "Unsupported document type. Use PDF, DOCX, XLSX, TXT, or MD.";
  }
  if (
    extension === ".pdf" &&
    !file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))
  ) {
    return "The uploaded file does not have a valid PDF signature.";
  }
  if (
    (extension === ".docx" || extension === ".xlsx") &&
    !file.buffer.subarray(0, 2).equals(Buffer.from("PK"))
  ) {
    return `The uploaded file does not have a valid ${extension.slice(1).toUpperCase()} container signature.`;
  }
  if (extension === ".docx" || extension === ".xlsx") {
    try {
      const JSZip = (await import("jszip")).default;
      const archive = await JSZip.loadAsync(file.buffer, {
        checkCRC32: false,
        createFolders: false,
      });
      const entries = Object.values(archive.files);
      if (entries.length > 5000)
        return "The Office document contains too many ZIP entries.";
      const uncompressedBytes = entries.reduce((sum, entry) => {
        const size = Number(
          (entry as unknown as { _data?: { uncompressedSize?: number } })._data
            ?.uncompressedSize ?? 0,
        );
        return sum + (Number.isFinite(size) ? size : 0);
      }, 0);
      if (uncompressedBytes > 500 * 1024 * 1024) {
        return "The Office document expands beyond the 500 MB safety limit.";
      }
      if (uncompressedBytes > Math.max(file.size * 100, 50 * 1024 * 1024)) {
        return "The Office document compression ratio exceeds the safety limit.";
      }
      const requiredEntry =
        extension === ".docx" ? "word/document.xml" : "xl/workbook.xml";
      if (
        !archive.file("[Content_Types].xml") ||
        !archive.file(requiredEntry)
      ) {
        return `The uploaded file is not a valid ${extension.slice(1).toUpperCase()} package.`;
      }
    } catch {
      return `The uploaded ${extension.slice(1).toUpperCase()} package is malformed.`;
    }
  }
  return null;
}
