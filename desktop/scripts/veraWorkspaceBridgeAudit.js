const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const preload = fs.readFileSync(path.join(desktopRoot, "preload.js"), "utf8");
const main = fs.readFileSync(path.join(desktopRoot, "main.js"), "utf8");
const runtime = fs.readFileSync(
  path.join(repositoryRoot, "frontend/src/app/lib/veraRuntime.ts"),
  "utf8",
);
const globals = fs.readFileSync(
  path.join(repositoryRoot, "frontend/src/global.d.ts"),
  "utf8",
);

assert.match(
  preload,
  /exposeInMainWorld\("aletheiaDesktop"/,
  "the existing hardened desktop bridge remains the single IPC surface",
);
assert.doesNotMatch(
  preload,
  /exposeInMainWorld\("veraDesktop"/,
  "a second desktop bridge would duplicate token authority",
);
assert.ok(
  main.includes(
    'workspaceApiUrl: `${BACKEND_URL.replace(/\\\/$/, "")}/api/v1`',
  ),
  "desktop runtime info exposes the actual workspace API port",
);
assert.match(
  runtime,
  /window\.aletheiaDesktop/,
  "Vera transport consumes the packaged bridge",
);
assert.doesNotMatch(
  runtime,
  /window\.veraDesktop/,
  "Vera transport must not depend on a bridge that preload never exposes",
);
assert.match(
  globals,
  /workspaceApiUrl:\s*string/,
  "the packaged bridge contract includes the workspace API URL",
);

console.log("vera workspace packaged bridge audit passed");
