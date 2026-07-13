"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ORIGINAL_BYTES = 100 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ["application/pdf", ["pdf"]],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ["docx"],
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ["xlsx"],
  ],
  ["text/plain", ["txt", "md"]],
  ["text/markdown", ["md"]],
]);

function allowedExtensions(mimeType) {
  const extensions = MIME_EXTENSIONS.get(mimeType);
  if (!extensions) throw new Error("Backend returned an unsupported original document type");
  return extensions;
}

function safeOriginalFilename(value, mimeType) {
  const extensions = allowedExtensions(mimeType);
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f/\\:]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  const currentExtension = path.extname(normalized).slice(1).toLowerCase();
  const base = normalized || `Vera original.${extensions[0]}`;
  if (extensions.includes(currentExtension)) return base;
  return `${base.replace(/\.[^.]+$/, "")}.${extensions[0]}`;
}

function validateOriginalDocumentBytes({
  bytes,
  mimeType,
  expectedSha256,
  contentLength,
}) {
  allowedExtensions(mimeType);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ORIGINAL_BYTES) {
    throw new Error("Original document is empty or exceeds the 100 MB desktop limit");
  }
  if (
    Number.isFinite(contentLength) &&
    contentLength > 0 &&
    contentLength !== bytes.length
  ) {
    throw new Error("Original document length does not match the backend response");
  }
  const expected = String(expectedSha256 ?? "").trim().toLowerCase();
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    throw new Error("Original document hash does not match the verified backend response");
  }
  if (mimeType === "application/pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Original document is not a valid PDF container");
  }
  if (
    mimeType.includes("openxmlformats-officedocument") &&
    (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
  ) {
    throw new Error("Original document is not a valid Office container");
  }
  if (mimeType.startsWith("text/") && bytes.includes(0)) {
    throw new Error("Original text document contains binary data");
  }
  return { sha256: actual, bytes: bytes.length };
}

function writeOwnerOnlyFileAtomically(destination, bytes) {
  const target = path.resolve(destination);
  const parent = path.dirname(target);
  const parentInfo = fs.lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("Original document destination must be a regular directory");
  }
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return target;
}

module.exports = {
  MAX_ORIGINAL_BYTES,
  MIME_EXTENSIONS,
  safeOriginalFilename,
  validateOriginalDocumentBytes,
  writeOwnerOnlyFileAtomically,
};
