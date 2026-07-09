import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type HealthCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function readText(root: string, relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function fileExists(root: string, relativePath: string) {
  return existsSync(path.join(root, relativePath));
}

function contains(root: string, relativePath: string, patterns: string[]) {
  if (!fileExists(root, relativePath)) return false;
  const text = readText(root, relativePath);
  return patterns.every((pattern) => text.includes(pattern));
}

function doesNotContain(root: string, relativePath: string, patterns: string[]) {
  if (!fileExists(root, relativePath)) return false;
  const text = readText(root, relativePath);
  return patterns.every((pattern) => !text.includes(pattern));
}

function packageScript(root: string, packagePath: string, script: string) {
  if (!fileExists(root, packagePath)) return false;
  const parsed = JSON.parse(readText(root, packagePath)) as {
    scripts?: Record<string, string>;
  };
  return typeof parsed.scripts?.[script] === "string";
}

function gitStatus(root: string) {
  try {
    return execFileSync("git", ["status", "--short"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): HealthCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const statusLines = gitStatus(root)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const checks: HealthCheck[] = [
    check(
      "local-privacy-mode",
      contains(root, "docs/local_deployment.md", [
        "ALETHEIA_STORAGE_DRIVER=local",
        "ALETHEIA_AUTH_MODE=single_user",
        "ALETHEIA_DATA_DIR=.data/aletheia",
      ]) &&
        contains(root, "backend/.env.example", [
          "ALETHEIA_DATA_DIR=.data/aletheia",
          "ALETHEIA_SEMANTIC_INDEX_ENABLED=false",
          "ALETHEIA_SEMANTIC_INDEX_DRIVER=disabled",
        ]) &&
        contains(root, "docs/local_deployment.md", [
          "documents/",
          "exports/",
          "External model and web calls should remain disabled by default.",
        ]),
      "Local storage/auth/data-dir defaults and privacy boundary docs must remain present.",
    ),
    check(
      "least-privilege-tools",
      contains(root, "docs/aletheia_tool_adapter.md", [
        "least privilege",
        "terminal",
        "browser",
        "email",
      ]) &&
        contains(root, "backend/src/routes/aletheia.ts", [
          "list_matters",
          "search_matter_documents",
          "export_audit_pack",
        ]),
      "Tool Adapter must stay narrow and exclude high-risk tools by default.",
    ),
    check(
      "professional-positioning",
      contains(root, "README.md", [
        "Agent Workspace",
        "Local Pilot Mode",
        "deterministic fallback",
      ]) &&
        doesNotContain(root, "README.md", ["## Mock Mode"]) &&
        doesNotContain(root, "frontend/src/app/aletheia/templates/page.tsx", [
          ': "mock"',
          ">mock<",
        ]),
      "Product-facing copy should present local pilot/fallback language, not mock-first positioning.",
    ),
    check(
      "core-validation-entrypoints",
      packageScript(root, "backend/package.json", "build") &&
        packageScript(root, "backend/package.json", "test:aletheia:local") &&
        packageScript(root, "backend/package.json", "test:aletheia:retrieval-eval") &&
        packageScript(root, "backend/package.json", "test:aletheia:completion") &&
        packageScript(root, "frontend/package.json", "lint") &&
        packageScript(root, "frontend/package.json", "build") &&
        packageScript(root, "frontend/package.json", "test:aletheia:ui"),
      "Build, local regression, retrieval eval, completion audit, lint, frontend build, and UI smoke scripts must exist.",
    ),
    check(
      "ci-validation",
      contains(root, ".github/workflows/aletheia-local-ci.yml", [
        "Aletheia Local CI",
        "npm run test:aletheia:local",
        "npm run test:aletheia:retrieval-eval",
        "npm run test:aletheia:package",
        "npm run test:aletheia:completion",
        "npm run test:aletheia:ui",
      ]),
      "GitHub Actions must run the local-first validation matrix on main and pull requests.",
    ),
    check(
      "dirty-worktree",
      statusLines.length === 0,
      `${statusLines.length} changed files are present; review and split commits before handoff.`,
      "warning",
    ),
  ];

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failedCritical.length === 0,
        suite: "aletheia-operator-health-v0",
        checkedAt: new Date().toISOString(),
        changedFiles: statusLines.length,
        warnings: warnings.length,
        recommendedNextCommands: [
          "cd backend && npm run build",
          "cd backend && npm run test:aletheia:local",
          "cd backend && npm run test:aletheia:retrieval-eval",
          "cd backend && npm run test:aletheia:completion",
          "cd frontend && npm run lint",
          "cd frontend && npm run test:aletheia:ui",
          "cd frontend && npm run build",
        ],
        checks,
      },
      null,
      2,
    )}\n`,
  );

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
