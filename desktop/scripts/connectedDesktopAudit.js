#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isExternalBrowserUrl,
  isSameConnectedOrigin,
  normalizeConnectedAppUrl,
} = require("../connectedConfig");

const desktopRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(desktopRoot, "connectedMain.js"),
  "utf8",
);
const packageDocument = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
);

assert.equal(
  normalizeConnectedAppUrl("https://vera.example").toString(),
  "https://vera.example/assistant",
);
assert.equal(
  normalizeConnectedAppUrl("http://127.0.0.1:3002/assistant").origin,
  "http://127.0.0.1:3002",
);
assert.throws(() => normalizeConnectedAppUrl("http://vera.example"), /HTTPS/);
assert.throws(
  () => normalizeConnectedAppUrl("file:///tmp/index.html"),
  /HTTPS/,
);
assert.throws(
  () => normalizeConnectedAppUrl("https://user:secret@vera.example"),
  /credentials/,
);
assert.equal(
  isSameConnectedOrigin(
    "https://vera.example/projects/1",
    new URL("https://vera.example/assistant"),
  ),
  true,
);
assert.equal(
  isSameConnectedOrigin(
    "https://attacker.example",
    new URL("https://vera.example"),
  ),
  false,
);
assert.equal(isExternalBrowserUrl("mailto:support@vera.example"), true);
assert.equal(isExternalBrowserUrl("javascript:alert(1)"), false);

assert.match(source, /contextIsolation: true/);
assert.match(source, /nodeIntegration: false/);
assert.match(source, /sandbox: true/);
assert.match(source, /webSecurity: true/);
assert.match(source, /navigateOnDragDrop: false/);
assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/);
assert.match(source, /setPermissionRequestHandler/);
assert.match(source, /setWindowOpenHandler/);
assert.match(source, /will-navigate/);
assert.match(source, /will-attach-webview/);
assert.match(source, /path\.isAbsolute\(explicitProfile\)/);
assert.match(source, /profileInfo\.isSymbolicLink\(\)/);
assert.match(source, /app\.setPath\("userData", explicitProfile\)/);
assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE|API_KEY|AUTH_TOKEN/);
assert.equal(packageDocument.main, "connectedMain.js");
assert.equal(packageDocument.build.productName, "Vera");
assert.equal(packageDocument.build.appId, "ai.vera.desktop");
assert.deepEqual(packageDocument.build.extraResources ?? [], []);

console.log(
  JSON.stringify(
    { ok: true, suite: "vera-connected-desktop-security-v1" },
    null,
    2,
  ),
);
