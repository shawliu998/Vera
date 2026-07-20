#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const desktopRoot = path.resolve(__dirname, "..");
const packagedApp = process.env.VERA_PACKAGED_APP_PATH;
const executable = packagedApp
  ? path.join(packagedApp, "Contents", "MacOS", "Vera")
  : path.join(desktopRoot, "node_modules", ".bin", "electron");
const args = packagedApp ? [] : [path.join(desktopRoot, "connectedMain.js")];
let requestedPath = null;
const isolatedProfile = fs.mkdtempSync(
  path.join(os.tmpdir(), "vera-connected-smoke-"),
);
fs.chmodSync(isolatedProfile, 0o700);

const server = http.createServer((request, response) => {
  requestedPath = request.url;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  response.end(
    "<!doctype html><title>Vera Connected Smoke</title><main>Vera connected desktop ready</main>",
  );
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const child = spawn(executable, args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      VERA_APP_URL: `http://127.0.0.1:${address.port}/assistant`,
      VERA_DESKTOP_PROFILE_DIR: isolatedProfile,
      VERA_TEST_AUTO_QUIT_MS: "750",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-16_384);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    server.close();
    fs.rmSync(isolatedProfile, { recursive: true, force: true });
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    assert.equal(requestedPath, "/assistant");
    assert.match(
      output,
      /\[vera-connected\] renderer-ready origin=http:\/\/127\.0\.0\.1:/,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-connected-desktop-smoke-v1",
          packaged: Boolean(packagedApp),
        },
        null,
        2,
      ),
    );
  });
});
