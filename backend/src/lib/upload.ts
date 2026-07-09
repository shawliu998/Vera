import type { RequestHandler } from "express";
import multer from "multer";

export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_MB = Math.round(
  MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
);

function memoryUpload(maxFiles: number) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_UPLOAD_SIZE_BYTES,
      files: maxFiles,
    },
  });
}

function handleUploadError(
  err: unknown,
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
) {
  if (!err) return next();

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

const singleMemoryUpload = memoryUpload(1);

export function singleFileUpload(fieldName: string): RequestHandler {
  return (req, res, next) => {
    singleMemoryUpload.single(fieldName)(req, res, (err) =>
      handleUploadError(err, res, next),
    );
  };
}

export function multiFileUpload(
  fieldName: string,
  maxFiles = 100,
): RequestHandler {
  const upload = memoryUpload(maxFiles);
  return (req, res, next) => {
    upload.array(fieldName, maxFiles)(req, res, (err) =>
      handleUploadError(err, res, next),
    );
  };
}
