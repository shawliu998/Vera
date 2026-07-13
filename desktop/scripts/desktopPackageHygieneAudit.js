#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function parseArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const runtimeArgument = parseArgument("--runtime");
const appArgument = parseArgument("--app");
if ((runtimeArgument ? 1 : 0) + (appArgument ? 1 : 0) !== 1) {
  throw new Error(
    "Usage: desktopPackageHygieneAudit.js --runtime <dir> | --app <Vera.app>",
  );
}

const frontendRoot = runtimeArgument
  ? path.resolve(runtimeArgument)
  : path.join(
      path.resolve(appArgument),
      "Contents",
      "Resources",
      "aletheia",
      "frontend",
    );
const modulesArchive = runtimeArgument
  ? path.join(path.dirname(frontendRoot), "frontend-node-modules.tgz")
  : path.join(
      path.resolve(appArgument),
      "Contents",
      "Resources",
      "aletheia",
      "frontend-node-modules.tgz",
    );

const failures = [];
const warnings = [];
const exists = (candidate) => fs.existsSync(candidate);
const frontendBuildDir = process.env.NEXT_DIST_DIR || ".next-build";
const requiredFiles = [
  "server.js",
  path.join(frontendBuildDir, "BUILD_ID"),
  path.join(frontendBuildDir, "static"),
];
for (const relative of requiredFiles) {
  if (!exists(path.join(frontendRoot, relative))) {
    failures.push(`missing required production runtime resource: ${relative}`);
  }
}
if (!exists(modulesArchive)) {
  failures.push("missing frontend production dependency archive");
} else {
  const archivedFiles = execFileSync("/usr/bin/tar", ["-tzf", modulesArchive], {
    encoding: "utf8",
    timeout: 30_000,
  }).split("\n");
  if (!archivedFiles.includes("./next/package.json")) {
    failures.push("frontend dependency archive is missing next/package.json");
  }
}

if (appArgument) {
  const sidecar = path.join(
    path.resolve(appArgument),
    "Contents",
    "Resources",
    "aletheia",
    "backend",
    "voice_sidecar",
    "aletheia_voice_sidecar.py",
  );
  if (!exists(sidecar)) {
    failures.push("missing packaged local voice sidecar");
  }
}

const forbiddenDirectories = [
  path.join(frontendBuildDir, "dev"),
  path.join(frontendBuildDir, "cache"),
  path.join("node_modules", ".cache"),
  path.join("node_modules", "@supabase"),
  path.join("node_modules", "@aws-sdk"),
  path.join("node_modules", "@opennextjs"),
  path.join("node_modules", "@openrouter"),
  path.join("node_modules", "resend"),
  path.join("node_modules", "wrangler"),
];
for (const relative of forbiddenDirectories) {
  if (exists(path.join(frontendRoot, relative))) {
    failures.push(`forbidden desktop artifact present: ${relative}`);
  }
}

if (exists(path.join(frontendRoot, "package.json"))) {
  failures.push(
    "source frontend package manifest must not be shipped in the desktop runtime",
  );
}

const staleMarkers = [/supabase/i, /supabase\.co/i];
const textExtensions = new Set([".js", ".mjs", ".cjs", ".json", ".map"]);
const maximumTextBytes = 8 * 1024 * 1024;
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scan(candidate);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name)))
      continue;
    const size = fs.statSync(candidate).size;
    if (size > maximumTextBytes) {
      warnings.push(
        `skipped oversized text candidate: ${path.relative(frontendRoot, candidate)}`,
      );
      continue;
    }
    const content = fs.readFileSync(candidate, "utf8");
    if (staleMarkers.some((marker) => marker.test(content))) {
      failures.push(
        `stale Supabase marker in: ${path.relative(frontendRoot, candidate)}`,
      );
    }
  }
}

if (exists(frontendRoot)) scan(frontendRoot);
else
  failures.push(`frontend runtime directory does not exist: ${frontendRoot}`);

const result = {
  passed: failures.length === 0,
  target: frontendRoot,
  failures,
  warnings,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
