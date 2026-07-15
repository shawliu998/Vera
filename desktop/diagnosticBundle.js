"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DIAGNOSTIC_SCHEMA = "vera-redacted-diagnostics-v1";
const MAX_SUMMARY_ENTRIES = 20_000;

function utcTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Diagnostic timestamp is invalid");
  }
  return date.toISOString();
}

function summarizeDirectory(root) {
  const summary = {
    available: false,
    files: 0,
    directories: 0,
    bytes: 0,
    newest_modified_at: null,
    truncated: false,
  };
  if (!root || !fs.existsSync(root)) return summary;
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return summary;
  summary.available = true;
  const pending = [root];
  let inspected = 0;
  let newest = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > MAX_SUMMARY_ENTRIES) {
        summary.truncated = true;
        pending.length = 0;
        break;
      }
      const candidate = path.join(current, entry.name);
      let info;
      try {
        info = fs.lstatSync(candidate);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      newest = Math.max(newest, info.mtimeMs);
      if (info.isDirectory()) {
        summary.directories += 1;
        pending.push(candidate);
      } else if (info.isFile()) {
        summary.files += 1;
        summary.bytes += info.size;
      }
    }
  }
  summary.newest_modified_at = newest > 0 ? new Date(newest).toISOString() : null;
  return summary;
}

function buildRedactedDiagnosticBundle(input) {
  const createdAt = utcTimestamp(input.now ?? new Date());
  const running = new Set(input.runningServices ?? []);
  return {
    schema: DIAGNOSTIC_SCHEMA,
    created_at: createdAt,
    product: {
      name: "Vera",
      version: String(input.appVersion ?? "unknown").slice(0, 80),
      packaged: input.packaged === true,
    },
    runtime: {
      platform: String(input.platform ?? process.platform).slice(0, 40),
      architecture: String(input.arch ?? process.arch).slice(0, 40),
      os_release: String(input.osRelease ?? "unknown").slice(0, 120),
      electron: String(input.versions?.electron ?? "unknown").slice(0, 80),
      chrome: String(input.versions?.chrome ?? "unknown").slice(0, 80),
      node: String(input.versions?.node ?? "unknown").slice(0, 80),
    },
    local_services: {
      ready: input.servicesReady === true,
      backend: running.has("backend"),
      frontend: running.has("frontend"),
      credential_worker: running.has("credential worker"),
      bind_scope: "loopback-only",
    },
    security: {
      application_encryption: "required",
      database_encryption: input.packaged
        ? "sqlcipher_required"
        : "metadata_plaintext",
      encrypted_volume_attested: input.encryptedVolumeAttested === true,
      generic_loopback_http_enabled:
        input.genericLoopbackHttpEnabled === true,
      renderer_node_integration: false,
      renderer_context_isolation: true,
      renderer_sandbox: true,
    },
    storage_summary: summarizeDirectory(input.dataDir),
    logs_summary: summarizeDirectory(input.logsDir),
    privacy: {
      api_keys_included: false,
      authorization_headers_included: false,
      document_contents_included: false,
      prompts_included: false,
      conversation_contents_included: false,
      absolute_paths_included: false,
      log_contents_included: false,
    },
  };
}

module.exports = {
  DIAGNOSTIC_SCHEMA,
  buildRedactedDiagnosticBundle,
  summarizeDirectory,
};
