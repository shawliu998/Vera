"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(desktopRoot, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(desktopRoot, "preload.js"), "utf8");
const worker = fs.readFileSync(
  path.join(desktopRoot, "credentialWorker.js"),
  "utf8",
);
const packageDocument = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
);

assert.match(
  main,
  /MessageChannelMain/,
  "the desktop host must create a private MessagePort channel",
);
assert.match(
  main,
  /forkUtility\(\s*"credential worker",\s*credentialWorkerPath/,
  "Keychain operations must run in a dedicated utility process",
);
assert.match(
  main,
  /VERA_DESKTOP_CREDENTIAL_PORT_REQUIRED: "true"/,
  "the backend must fail closed when the private credential port is absent",
);
assert.match(
  main,
  /waitForCredentialPortReady\(credentialWorker, "credential worker"\)[\s\S]*waitForCredentialPortReady\(backend, "backend"\)/,
  "both utility processes must explicitly announce readiness before port transfer",
);
assert.match(worker, /CREDENTIAL_PORT_READY/);
assert.match(
  main,
  /credentialWorker\.postMessage\(\s*\{ type: CREDENTIAL_PORT_BOOTSTRAP \},\s*\[port1\]/,
  "one end of the channel must be transferred only to the worker",
);
assert.match(
  main,
  /backend\.postMessage\(\{ type: CREDENTIAL_PORT_BOOTSTRAP \}, \[port2\]\)/,
  "the other end of the channel must be transferred only to the backend",
);
assert.doesNotMatch(
  preload,
  /credential|keychain|api[-_]?key|secret/i,
  "the renderer bridge must expose no credential capability",
);
assert.doesNotMatch(
  main,
  /ipcMain\.(?:handle|on)\([^\n]*(?:credential|keychain|api[-_]?key|secret)/i,
  "the desktop host must expose no credential IPC to the renderer",
);
assert.doesNotMatch(
  worker,
  /ipcMain|ipcRenderer|contextBridge|webContents/,
  "the credential worker must remain outside renderer IPC",
);
assert.equal(
  packageDocument.build.files.includes("credentialWorker.js"),
  false,
  "the utility worker must have one packaged source outside app.asar",
);
const extraResources = packageDocument.build.extraResources;
assert.equal(
  extraResources.some(
    (entry) =>
      entry.from === "credentialWorker.js" &&
      entry.to === "aletheia/desktop/credentialWorker.js",
  ),
  true,
);
assert.equal(
  extraResources.some(
    (entry) =>
      entry.from === "macOsKeychain.js" &&
      entry.to === "aletheia/desktop/macOsKeychain.js",
  ),
  true,
);
assert.match(
  main,
  /desktopUtilityModulePath\("credentialWorker\.js"\)/,
  "packaged utility entry must resolve from ordinary extraResources",
);
assert.match(
  main,
  /desktopUtilityModulePath\("macOsKeychain\.js"\)/,
  "packaged host Keychain access must resolve from ordinary extraResources",
);
assert.match(
  main,
  /cwd: path\.dirname\(credentialWorkerPath\)/,
  "packaged utility cwd must be a real directory outside app.asar",
);
assert.match(
  main,
  /waitForCredentialPortReady\(credentialWorker, "credential worker"\)[\s\S]*const backend = forkUtility/,
  "credential worker readiness must precede backend startup",
);
assert.equal(
  packageDocument.scripts["test:credential-worker"],
  "node scripts/credentialWorkerAudit.js",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-desktop-credential-bridge-v1",
      checks: [
        "dedicated Keychain utility process",
        "explicit retrying readiness handshake",
        "private worker-to-backend MessagePort",
        "required backend bootstrap fail-closed",
        "no renderer credential IPC",
        "packaged worker inclusion",
      ],
    },
    null,
    2,
  ),
);
