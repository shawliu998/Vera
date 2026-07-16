import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyFrontendProductionBuild } from "./aletheiaFrontendBuildContract.js";

type PackageCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function dataDir() {
  return path.resolve(
    process.cwd(),
    process.env.ALETHEIA_DATA_DIR ?? ".data/aletheia",
  );
}

function outputDir(packageId: string) {
  const explicit = process.env.ALETHEIA_LOCAL_PACKAGE_DIR?.trim();
  if (explicit) return path.resolve(process.cwd(), explicit);
  return path.join(dataDir(), "exports", "local-packages", packageId);
}

function checkPath(
  name: string,
  targetPath: string,
  detail: string,
): PackageCheck {
  return {
    name,
    ok: existsSync(targetPath),
    detail: `${detail}: ${targetPath}`,
  };
}

function shellScript(lines: string[]) {
  return `#!/usr/bin/env bash
set -euo pipefail

${lines.join("\n")}
`;
}

function readme(packageId: string) {
  return `# Aletheia Local Private Package

Package id: ${packageId}

This directory is a packaging prototype for a private local Aletheia deployment.
It does not include client documents, SQLite data, generated exports, secrets,
or model credentials.

## Contents

- \`manifest.json\`: package metadata, checks, privacy posture, and startup commands.
- \`release-evidence.example.json\`: schema hint for the release evidence manifest.
- \`.env.local.example\`: local-first environment template.
- \`start-backend.sh\`: starts the Express backend in local single-user mode.
- \`start-frontend.sh\`: starts the Next.js frontend against the local backend.
- \`start-mcp.sh\`: starts the stdio Aletheia MCP wrapper.

## Required Preflight

\`\`\`bash
cd backend && npm run check:aletheia:preflight
\`\`\`

For step-by-step failure isolation, run the expanded matrix:

\`\`\`bash
cd backend && npm run build && npm run check:aletheia:doctor && npm run check:aletheia:backup && npm run check:aletheia:restore && npm run check:aletheia:privacy && npm run check:aletheia:ops-readiness && npm run check:aletheia:source-provenance && npm run check:aletheia:knowledge-governance && npm run check:aletheia:audit-workbench && npm run check:aletheia:tool-policy && npm run check:aletheia:approval-policy && npm run check:aletheia:matter-isolation && npm run check:aletheia:run-trace && npm run check:aletheia:evidence && npm run check:aletheia:audit-integrity && npm run test:aletheia:local && npm run test:aletheia:restore-drill
cd frontend && npm run build
\`\`\`

## Privacy Defaults

- Documents remain in the configured local data directory.
- SQLite metadata defaults to plaintext \`node:sqlite\`; an operator can perform
  the documented offline migration and require the verified SQLCipher driver.
- External web search, browser automation, terminal execution, email, and
  destructive file operations remain outside the Aletheia Tool Adapter.
- Retrieval defaults to SQLite FTS5 keyword search.
- Semantic or hybrid retrieval must be explicitly enabled. The optional
  local-json prototype stores per-matter indexes under the local data directory;
  LanceDB/Qdrant should be reviewed before production retrieval changes.

## Source Availability

This project keeps AGPL source availability obligations in scope for networked
deployments. Keep \`docs/license_attribution.md\` and
\`docs/third_party_notices.md\` with any distributed private package.
`;
}

function envTemplate() {
  return `PORT=3001
FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001

ALETHEIA_AUTH_MODE=single_user
# For private single-tenant auth, set:
# ALETHEIA_AUTH_MODE=private_token
# ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-a-random-local-private-token
# NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-the-same-token-for-local-browser-only
ALETHEIA_DATA_DIR=.data/aletheia
ALETHEIA_LOCAL_USER_ID=local-user
ALETHEIA_LOCAL_USER_EMAIL=local@aletheia.internal

ALETHEIA_APPLICATION_ENCRYPTION=disabled
ALETHEIA_DATABASE_ENCRYPTION=metadata_plaintext
# ALETHEIA_MASTER_KEY_SOURCE=file
# ALETHEIA_MASTER_KEY_FILE=/secure/operator/aletheia-master-key
# ALETHEIA_DATABASE_KEY_SOURCE=file
# ALETHEIA_DATABASE_KEY_FILE=/secure/operator/aletheia-database-key
# ALETHEIA_AUDIT_HMAC_SECRET=replace-with-a-random-32-byte-hex-string
# ALETHEIA_AUDIT_ANCHOR_ENABLED=false
# ALETHEIA_AUDIT_ANCHOR_DIR=/separate/append-only/anchor-journal
# ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE=/secure/operator/anchor-private.pem
# ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE=/secure/operator/anchor-public.pem

ALETHEIA_RETRIEVAL_MODE=keyword
ALETHEIA_SEMANTIC_INDEX_ENABLED=false
ALETHEIA_SEMANTIC_INDEX_DRIVER=disabled
ALETHEIA_SEMANTIC_INDEX_DIR=.data/aletheia/index/semantic-local

# Leave the model name empty to keep durable model execution disabled.
# ALETHEIA_LOCAL_MODEL_NAME=qwen3:8b
# ALETHEIA_LOCAL_MODEL_ID=default-local
# ALETHEIA_LOCAL_MODEL_ADAPTER=ollama
# ALETHEIA_LOCAL_MODEL_ENDPOINT=http://127.0.0.1:11434
# ALETHEIA_LOCAL_MODEL_CONTEXT_TOKENS=32768
# ALETHEIA_LOCAL_MODEL_MAX_OUTPUT_TOKENS=4096
# ALETHEIA_LOCAL_MODEL_CONCURRENCY=1
# ALETHEIA_LOCAL_MODEL_QUEUE_LIMIT=16
# ALETHEIA_LOCAL_MODEL_AUTOSTART=false
# ALETHEIA_DURABLE_WORKER_POLL_MS=500
# ALETHEIA_DURABLE_WORKER_HEARTBEAT_MS=1000

DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string
`;
}

function main() {
  const root = repoRoot();
  const backendDir = process.cwd();
  const frontendDir = path.join(root, "frontend");
  const frontendBuildDirName =
    process.env.NEXT_DIST_DIR?.trim() || ".next-build";
  const packageId = `aletheia-local-${timestampSlug()}`;
  const outDir = outputDir(packageId);
  mkdirSync(outDir, { recursive: true });

  const checks: PackageCheck[] = [
    checkPath(
      "backend package",
      path.join(backendDir, "package.json"),
      "backend package file",
    ),
    checkPath(
      "backend build",
      path.join(backendDir, "dist"),
      "backend build output",
    ),
    checkPath(
      "frontend package",
      path.join(frontendDir, "package.json"),
      "frontend package file",
    ),
    ...verifyFrontendProductionBuild({
      frontendDir,
      buildDirName: frontendBuildDirName,
    }),
    checkPath("project readme", path.join(root, "README.md"), "project readme"),
    checkPath(
      "product status",
      path.join(root, "docs", "status.md"),
      "product status",
    ),
    checkPath(
      "private deployment notes",
      path.join(root, "docs", "private_deployment.md"),
      "private deployment notes",
    ),
    checkPath(
      "desktop packaging checklist",
      path.join(root, "docs", "desktop_packaging_checklist.md"),
      "desktop packaging checklist",
    ),
    checkPath(
      "license attribution",
      path.join(root, "docs", "license_attribution.md"),
      "license attribution",
    ),
    checkPath(
      "third party notices",
      path.join(root, "docs", "third_party_notices.md"),
      "third-party notices",
    ),
    checkPath(
      "local deployment docs",
      path.join(root, "docs", "local_deployment.md"),
      "local deployment guide",
    ),
    checkPath(
      "tool adapter docs",
      path.join(root, "docs", "aletheia_tool_adapter.md"),
      "tool adapter guide",
    ),
    checkPath(
      "demo evidence docs",
      path.join(root, "docs", "demo_evidence.md"),
      "demo evidence guide",
    ),
  ];
  const warnings = checks
    .filter((check) => !check.ok)
    .map(
      (check) =>
        `${check.name} missing; run the preflight command before packaging.`,
    );

  const manifest = {
    packageId,
    createdAt: new Date().toISOString(),
    packageType: "aletheia-local-private-prototype",
    includesClientData: false,
    repositoryRoot: root,
    generatedAt: outDir,
    dataDirectory: dataDir(),
    runtime: {
      node: process.version,
      backend: "Express / TypeScript",
      frontend: "Next.js",
      localDatabase:
        "SQLite via node:sqlite by default; optional fail-closed @signalapp/sqlcipher",
      documentStore: "local filesystem",
      retrievalDefault: "sqlite_fts5_keyword",
      mcp: "stdio wrapper",
    },
    privacyDefaults: {
      storageDriver: "local",
      authMode: "single_user_or_private_token",
      retrievalMode: "keyword",
      semanticIndexEnabled: false,
      externalWebSearch: false,
      browserAutomation: false,
      terminalExecution: false,
      email: false,
      destructiveFileOperations: false,
      cloudModelFallback: false,
    },
    dataBoundary: {
      includesClientData: false,
      localDataDirectory: dataDir(),
      sqliteDatabase: path.join(dataDir(), "aletheia.db"),
      documentStore: path.join(dataDir(), "documents"),
      exportStore: path.join(dataDir(), "exports"),
      retrievalIndexStore: path.join(dataDir(), "index"),
      backupTogether: ["aletheia.db", "documents/", "exports/", "index/"],
    },
    restoreChecks: [
      "matters load from SQLite",
      "documents can be searched through SQLite FTS5",
      "evidence items retain source_chunk_id and document references",
      "audit events retain export paths",
      "run traces render with steps, tool calls, and checkpoints",
    ],
    startup: {
      backend: "cd backend && ALETHEIA_AUTH_MODE=single_user npm run start",
      frontend:
        "cd frontend && NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 npm run start",
      mcp: "cd backend && ALETHEIA_AUTH_MODE=single_user npm run mcp:aletheia",
      developmentLauncher: "cd backend && npm run dev:aletheia:local",
    },
    preflight: [
      "cd backend && npm run check:aletheia:preflight",
      "cd backend && npm run build",
      "cd backend && npm run check:aletheia:doctor",
      "cd backend && npm run check:aletheia:backup",
      "cd backend && npm run check:aletheia:restore",
      "cd backend && npm run check:aletheia:privacy",
      "cd backend && npm run check:aletheia:ops-readiness",
      "cd backend && npm run check:aletheia:source-provenance",
      "cd backend && npm run check:aletheia:knowledge-governance",
      "cd backend && npm run check:aletheia:audit-workbench",
      "cd backend && npm run check:aletheia:tool-policy",
      "cd backend && npm run check:aletheia:approval-policy",
      "cd backend && npm run check:aletheia:matter-isolation",
      "cd backend && npm run check:aletheia:run-trace",
      "cd backend && npm run check:aletheia:evidence",
      "cd backend && npm run check:aletheia:audit-integrity",
      "cd backend && npm run test:aletheia:local",
      "cd backend && npm run test:aletheia:restore-drill",
      "cd backend && npm run test:aletheia:retrieval-eval",
      "cd frontend && npm run build",
      "cd frontend && npm run test:aletheia:ui",
    ],
    sourceAvailabilityDocs: [
      "docs/license_attribution.md",
      "docs/third_party_notices.md",
    ],
    checks,
    warnings,
  };

  writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(path.join(outDir, "README.md"), readme(packageId));
  writeFileSync(
    path.join(outDir, "release-evidence.example.json"),
    `${JSON.stringify(
      {
        suite: "aletheia-release-evidence-v0",
        command:
          "cd backend && ALETHEIA_RELEASE_EVIDENCE_OUT=../release-evidence.json npm run check:aletheia:evidence",
        includes: [
          "git branch and commit",
          "validation commands",
          "demo evidence screenshots with sha256",
          "deployment and attribution documents",
          "privacy and approval posture",
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(outDir, ".env.local.example"), envTemplate());
  writeFileSync(
    path.join(outDir, "start-backend.sh"),
    shellScript([
      `cd ${JSON.stringify(backendDir)}`,
      'export ALETHEIA_AUTH_MODE="${ALETHEIA_AUTH_MODE:-single_user}"',
      'export ALETHEIA_DATA_DIR="${ALETHEIA_DATA_DIR:-.data/aletheia}"',
      "npm run start",
    ]),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(outDir, "start-frontend.sh"),
    shellScript([
      `cd ${JSON.stringify(frontendDir)}`,
      'export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-http://localhost:3001}"',
      "npm run start",
    ]),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(outDir, "start-mcp.sh"),
    shellScript([
      `cd ${JSON.stringify(backendDir)}`,
      'export ALETHEIA_AUTH_MODE="${ALETHEIA_AUTH_MODE:-single_user}"',
      'export ALETHEIA_DATA_DIR="${ALETHEIA_DATA_DIR:-.data/aletheia}"',
      "npm run mcp:aletheia",
    ]),
    { mode: 0o755 },
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: checks.every((check) => check.ok),
        packageId,
        outputDir: outDir,
        warnings: manifest.warnings,
      },
      null,
      2,
    )}\n`,
  );
  if (process.env.ALETHEIA_PACKAGE_STRICT === "true" && warnings.length > 0) {
    process.exitCode = 1;
  }
}

main();
