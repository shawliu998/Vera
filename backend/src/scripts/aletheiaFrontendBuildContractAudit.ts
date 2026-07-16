import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyFrontendProductionBuild } from "./aletheiaFrontendBuildContract.js";

function write(targetPath: string, contents: string) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, contents);
}

function fixture() {
  const frontendDir = mkdtempSync(
    path.join(tmpdir(), "aletheia-frontend-build-contract-"),
  );
  const buildDirName = ".next-build";
  const buildDir = path.join(frontendDir, buildDirName);
  const standaloneDir = path.join(buildDir, "standalone");
  const tracedBuildDir = path.join(standaloneDir, buildDirName);
  const buildId = "production-build-id";
  const manifest = JSON.stringify({
    config: { distDir: buildDirName, output: "standalone" },
    files: [`${buildDirName}/routes-manifest.json`],
  });
  write(path.join(frontendDir, "src", "app", "page.tsx"), "export default 1;");
  write(path.join(frontendDir, "package.json"), "{}\n");
  write(path.join(buildDir, "BUILD_ID"), `${buildId}\n`);
  write(path.join(buildDir, "required-server-files.json"), manifest);
  write(path.join(buildDir, "static", "chunks", "app.js"), "build chunk");
  write(path.join(standaloneDir, "server.js"), "require('next');\n");
  write(path.join(tracedBuildDir, "BUILD_ID"), `${buildId}\n`);
  write(path.join(tracedBuildDir, "required-server-files.json"), manifest);
  write(
    path.join(tracedBuildDir, "server", "app-paths-manifest.json"),
    "{}\n",
  );
  write(
    path.join(standaloneDir, "node_modules", "next", "package.json"),
    "{}\n",
  );
  const builtAt = new Date(Date.now() + 2_000);
  utimesSync(path.join(buildDir, "BUILD_ID"), builtAt, builtAt);
  return { frontendDir, buildDir, standaloneDir, tracedBuildDir };
}

function failures(frontendDir: string) {
  return verifyFrontendProductionBuild({ frontendDir })
    .filter((item) => !item.ok)
    .map((item) => item.name);
}

const roots: string[] = [];
try {
  const valid = fixture();
  roots.push(valid.frontendDir);
  assert.deepEqual(failures(valid.frontendDir), []);

  const empty = mkdtempSync(path.join(tmpdir(), "aletheia-empty-next-"));
  roots.push(empty);
  mkdirSync(path.join(empty, ".next"));
  assert.ok(
    failures(empty).includes("frontend production build directory"),
    "an empty legacy .next fixture must not satisfy the production contract",
  );

  const missingServer = fixture();
  roots.push(missingServer.frontendDir);
  rmSync(path.join(missingServer.standaloneDir, "server.js"));
  assert.ok(
    failures(missingServer.frontendDir).includes(
      "frontend traced standalone server",
    ),
  );

  const mismatchedBuild = fixture();
  roots.push(mismatchedBuild.frontendDir);
  writeFileSync(
    path.join(mismatchedBuild.tracedBuildDir, "BUILD_ID"),
    "different-build-id\n",
  );
  assert.ok(
    failures(mismatchedBuild.frontendDir).includes(
      "frontend traced runtime build id",
    ),
  );

  const stale = fixture();
  roots.push(stale.frontendDir);
  const afterBuild = new Date(Date.now() + 4_000);
  utimesSync(
    path.join(stale.frontendDir, "src", "app", "page.tsx"),
    afterBuild,
    afterBuild,
  );
  assert.ok(
    failures(stale.frontendDir).includes("frontend build freshness"),
  );

  const custom = fixture();
  roots.push(custom.frontendDir);
  assert.ok(
    verifyFrontendProductionBuild({
      frontendDir: custom.frontendDir,
      buildDirName: "../outside",
    }).every((item) => !item.ok),
    "NEXT_DIST_DIR traversal must fail closed",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        suite: "aletheia-frontend-production-build-contract-v1",
        checks: [
          "valid traced production runtime accepted",
          "legacy empty .next rejected",
          "missing standalone server rejected",
          "mismatched BUILD_ID rejected",
          "stale build rejected",
          "NEXT_DIST_DIR traversal rejected",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
