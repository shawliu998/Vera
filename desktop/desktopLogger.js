"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const MAX_DETAIL_KEYS = 30;
const MAX_DETAIL_TEXT = 1_000;

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|secret|api[_-]?key|credential|access[_-]?token|refresh[_-]?token)/i;
const BEARER_VALUE = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const KEY_VALUE = /\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi;
const QUERY_SECRET =
  /([?&](?:api[_-]?key|key|token|secret|authorization)=)[^&#\s]+/gi;
const POSIX_PATH = /(?:^|\s)\/(?:Users|home|private|var|tmp)\/[^\s"']+/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s"']+/g;

function safeName(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
  return normalized || fallback;
}

function redactText(value) {
  return String(value ?? "")
    .replace(BEARER_VALUE, "[redacted]")
    .replace(KEY_VALUE, "[redacted]")
    .replace(QUERY_SECRET, "$1[redacted]")
    .replace(POSIX_PATH, " [redacted-path]")
    .replace(WINDOWS_PATH, "[redacted-path]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL_TEXT);
}

function safeDetail(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactText(value);
  if (value instanceof Error) {
    return {
      name: safeName(value.name, "error"),
      code:
        typeof value.code === "string" ? safeName(value.code, "error") : null,
    };
  }
  if (depth >= 3) return "[bounded]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_KEYS).map((item) => safeDetail(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_DETAIL_KEYS)
        .map(([key, child]) => [
          safeName(key, "field"),
          SENSITIVE_KEY.test(key) ? "[redacted]" : safeDetail(child, depth + 1),
        ]),
    );
  }
  return redactText(value);
}

function assertRegularOrMissing(filePath) {
  if (!fs.existsSync(filePath)) return;
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Desktop log path is unsafe");
  }
}

function createRotatingDesktopLogger(options) {
  const directory = path.resolve(String(options.directory));
  const fileName = safeName(options.fileName ?? "vera.log", "vera.log");
  const activePath = path.join(directory, fileName);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const now = options.now ?? (() => new Date());
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1_024 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 20
  ) {
    throw new Error("Desktop log rotation configuration is invalid");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = fs.lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Desktop log directory is unsafe");
  }
  fs.chmodSync(directory, 0o700);

  function rotatedPath(index) {
    return `${activePath}.${index}`;
  }

  function rotate() {
    for (let index = maxFiles; index >= 1; index -= 1) {
      const source = index === 1 ? activePath : rotatedPath(index - 1);
      const destination = rotatedPath(index);
      assertRegularOrMissing(source);
      assertRegularOrMissing(destination);
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      if (fs.existsSync(source)) fs.renameSync(source, destination);
    }
  }

  function write(level, component, event, detail = null) {
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Desktop log timestamp is invalid");
    }
    const record = {
      timestamp: timestamp.toISOString(),
      level: safeName(level, "info"),
      component: safeName(component, "desktop"),
      event: safeName(event, "event"),
      detail: safeDetail(detail),
    };
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    assertRegularOrMissing(activePath);
    const currentBytes = fs.existsSync(activePath) ? fs.statSync(activePath).size : 0;
    if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) rotate();
    const descriptor = fs.openSync(activePath, "a", 0o600);
    try {
      fs.writeSync(descriptor, line);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(activePath, 0o600);
    return record;
  }

  return { activePath, write };
}

module.exports = {
  createRotatingDesktopLogger,
  redactText,
  safeDetail,
};
