import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const standaloneRoot = path.join(frontendRoot, ".next-build", "standalone");
const serverPath = path.join(standaloneRoot, "server.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForPage(url, child, diagnostics) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`frontend exited early: ${diagnostics()}`);
    }
    try {
      return await fetch(url, { redirect: "manual" });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`frontend startup timed out: ${diagnostics()}`);
}

function scriptNonces(html) {
  return [...html.matchAll(/<script\b([^>]*)>/giu)].map(
    (match) => match[1].match(/\bnonce=["']([^"']+)["']/u)?.[1] ?? null,
  );
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  assert.equal(fs.existsSync(serverPath), true, "run npm run build first");
  const [frontendPort, backendPort] = await Promise.all([
    freePort(),
    freePort(),
  ]);
  assert.notEqual(frontendPort, backendPort);
  let stderr = "";
  const child = spawn(process.execPath, [serverPath], {
    cwd: standaloneRoot,
    env: {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(frontendPort),
      VERA_DESKTOP_CSP: "true",
      VERA_DESKTOP_BACKEND_ORIGIN: `http://127.0.0.1:${backendPort}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8_192);
  });
  try {
    const first = await waitForPage(
      `http://127.0.0.1:${frontendPort}/assistant`,
      child,
      () => stderr,
    );
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-powered-by"), null);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const firstCsp = first.headers.get("content-security-policy") ?? "";
    const firstNonce = firstCsp.match(/'nonce-([^']+)'/u)?.[1] ?? null;
    assert.ok(firstNonce);
    assert.match(firstCsp, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/u);
    assert.match(
      firstCsp,
      new RegExp(
        `connect-src 'self' http://127\\.0\\.0\\.1:${backendPort}(?:;|$)`,
        "u",
      ),
    );
    assert.equal(firstCsp.includes("'unsafe-eval'"), false);
    const firstHtml = await first.text();
    const firstScriptNonces = scriptNonces(firstHtml);
    assert.ok(firstScriptNonces.length > 0);
    assert.equal(
      firstScriptNonces.every((nonce) => nonce === firstNonce),
      true,
      "every Next framework and hydration script must carry the response nonce",
    );

    const second = await fetch(`http://127.0.0.1:${frontendPort}/settings`, {
      redirect: "manual",
    });
    assert.equal(second.status, 200);
    const secondCsp = second.headers.get("content-security-policy") ?? "";
    const secondNonce = secondCsp.match(/'nonce-([^']+)'/u)?.[1] ?? null;
    assert.ok(secondNonce);
    assert.notEqual(
      secondNonce,
      firstNonce,
      "nonce must be unique per request",
    );
    const secondScriptNonces = scriptNonces(await second.text());
    assert.ok(secondScriptNonces.length > 0);
    assert.equal(
      secondScriptNonces.every((nonce) => nonce === secondNonce),
      true,
    );

    const projects = await fetch(
      `http://127.0.0.1:${frontendPort}/projects`,
      { redirect: "manual" },
    );
    assert.equal(projects.status, 307);
    assert.equal(
      new URL(
        projects.headers.get("location") ?? "",
        `http://127.0.0.1:${frontendPort}`,
      ).pathname,
      "/matters",
      "the exact legacy Project list route must redirect to Matters",
    );

    const matters = await fetch(
      `http://127.0.0.1:${frontendPort}/matters`,
      { redirect: "manual" },
    );
    assert.equal(matters.status, 200);
    const mattersCsp = matters.headers.get("content-security-policy") ?? "";
    const mattersNonce =
      mattersCsp.match(/'nonce-([^']+)'/u)?.[1] ?? null;
    assert.ok(mattersNonce);
    assert.notEqual(mattersNonce, firstNonce);
    assert.notEqual(mattersNonce, secondNonce);
    const matterScriptNonces = scriptNonces(await matters.text());
    assert.ok(matterScriptNonces.length > 0);
    assert.equal(
      matterScriptNonces.every((nonce) => nonce === mattersNonce),
      true,
    );

    const projectDeepLink = await fetch(
      `http://127.0.0.1:${frontendPort}/projects/00000000-0000-4000-8000-000000000001`,
      { redirect: "manual" },
    );
    assert.equal(projectDeepLink.status, 200);
    const projectCsp =
      projectDeepLink.headers.get("content-security-policy") ?? "";
    const projectNonce =
      projectCsp.match(/'nonce-([^']+)'/u)?.[1] ?? null;
    assert.ok(projectNonce);
    assert.notEqual(projectNonce, firstNonce);
    assert.notEqual(projectNonce, secondNonce);
    assert.notEqual(projectNonce, mattersNonce);
    const projectScriptNonces = scriptNonces(await projectDeepLink.text());
    assert.ok(projectScriptNonces.length > 0);
    assert.equal(
      projectScriptNonces.every((nonce) => nonce === projectNonce),
      true,
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-next-desktop-csp-runtime-v2",
          checks: [
            "production standalone frontend uses per-request nonces",
            "all Next framework and hydration scripts carry the nonce",
            "connect-src is pinned to the exact loopback backend",
            "unsafe-eval and X-Powered-By are absent",
            "the exact Projects list redirects to Matters while dynamic Project deep links remain renderable",
            "dynamic Assistant, Matters, Project, and Settings routes remain nonce-protected",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await stop(child);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
