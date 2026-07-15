#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRotatingDesktopLogger } = require("../desktopLogger");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vera-logger-audit-"));
const secret = "sk-desktop-logger-secret";
const localPath = "/Users/example/private-client/document.txt";
try {
  let tick = 0;
  const logger = createRotatingDesktopLogger({
    directory: root,
    maxBytes: 1_024,
    maxFiles: 3,
    now: () => new Date(1_700_000_000_000 + tick++),
  });
  for (let index = 0; index < 100; index += 1) {
    logger.write("info", "backend", "provider_call", {
      provider: "openai",
      status: "complete",
      api_key: secret,
      authorization: `Bearer ${secret}`,
      path: localPath,
      detail: `key=${secret} ${localPath}`,
    });
  }
  const files = fs.readdirSync(root).sort();
  assert.ok(files.length >= 2 && files.length <= 4);
  const serialized = files
    .map((name) => {
      const target = path.join(root, name);
      assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
      assert.equal(fs.statSync(target).mode & 0o077, 0);
      return fs.readFileSync(target, "utf8");
    })
    .join("\n");
  assert.doesNotMatch(serialized, /desktop-logger-secret|\/Users\/example/);
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /\[redacted-path\]/);
  assert.equal(fs.statSync(root).mode & 0o077, 0);
  console.log("desktopLoggerAudit: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
