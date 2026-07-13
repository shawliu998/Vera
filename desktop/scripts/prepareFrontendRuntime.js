#!/usr/bin/env node
"use strict";

// Electron must ship Next's traced production runtime, not the developer's
// entire frontend working tree. `next build` creates a traced standalone tree
// output: "standalone" is enabled; it intentionally omits public assets and
// static assets, so copy those two production-only asset roots explicitly.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const frontendDir = path.resolve(desktopDir, "..", "frontend");
const buildDirName = process.env.NEXT_DIST_DIR || ".next-build";
const buildDir = path.join(frontendDir, buildDirName);
const standaloneDir = path.join(buildDir, "standalone");
const staticDir = path.join(buildDir, "static");
const publicDir = path.join(frontendDir, "public");
const runtimeDir = path.join(desktopDir, ".runtime", "frontend");
const modulesArchive = path.join(
  desktopDir,
  ".runtime",
  "frontend-node-modules.tgz",
);

function requireDirectory(directory, message) {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(message);
  }
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
  });
}

requireDirectory(
  standaloneDir,
  `Missing frontend/${buildDirName}/standalone. Run the production frontend build first.`,
);
requireDirectory(
  staticDir,
  `Missing frontend/${buildDirName}/static from production build.`,
);

// `.runtime` is an ignored, package-only build artifact owned by this script.
fs.rmSync(runtimeDir, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
fs.mkdirSync(path.dirname(runtimeDir), { recursive: true, mode: 0o700 });
copyDirectory(standaloneDir, runtimeDir);
copyDirectory(staticDir, path.join(runtimeDir, buildDirName, "static"));
if (fs.statSync(publicDir, { throwIfNoEntry: false })?.isDirectory()) {
  copyDirectory(publicDir, path.join(runtimeDir, "public"));
}
// Next's tracing copies the source package manifest as a convenience. The
// standalone server does not read it, and retaining it would advertise source
// only cloud tooling in the final local desktop package.
fs.rmSync(path.join(runtimeDir, "package.json"), { force: true });

for (const required of [
  path.join(runtimeDir, "server.js"),
  path.join(runtimeDir, buildDirName, "BUILD_ID"),
]) {
  if (!fs.statSync(required, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Traced frontend runtime is incomplete: ${required}`);
  }
}

const modulesDir = path.join(runtimeDir, "node_modules");
requireDirectory(
  modulesDir,
  "Traced frontend runtime is missing production node_modules.",
);
fs.rmSync(modulesArchive, { force: true });
execFileSync("/usr/bin/tar", ["-czf", modulesArchive, "-C", modulesDir, "."], {
  stdio: "inherit",
});
if (!fs.statSync(modulesArchive, { throwIfNoEntry: false })?.isFile()) {
  throw new Error("Failed to create frontend production dependency archive.");
}
const serverPath = path.join(runtimeDir, "server.js");
const serverBootstrap =
  'if (process.env.ALETHEIA_FRONTEND_MODULES_DIR) { process.env.NODE_PATH = process.env.ALETHEIA_FRONTEND_MODULES_DIR; require("node:module").Module._initPaths(); module.paths.unshift(process.env.ALETHEIA_FRONTEND_MODULES_DIR); }\n';
const serverSource = fs.readFileSync(serverPath, "utf8");
if (!serverSource.startsWith(serverBootstrap)) {
  fs.writeFileSync(serverPath, `${serverBootstrap}${serverSource}`, {
    mode: 0o600,
  });
}
console.log(`Prepared traced frontend runtime: ${runtimeDir}`);
console.log(`Prepared frontend dependency archive: ${modulesArchive}`);
