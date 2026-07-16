import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

type EvidenceCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

type EvidenceFile = {
  path: string;
  exists: boolean;
  bytes: number;
  sha256: string | null;
};

const VALIDATION_COMMANDS = [
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
  "cd backend && npm run check:aletheia:operator",
  "cd backend && npm run test:aletheia:local",
  "cd backend && npm run test:aletheia:restore-drill",
  "cd backend && npm run test:aletheia:retrieval-eval",
  "cd backend && npm run test:aletheia:package",
  "cd backend && npm run test:aletheia:completion",
  "cd frontend && npm run lint",
  "cd frontend && npm run test:aletheia:ui",
  "cd frontend && npm run build",
];

const REQUIRED_DOCS = [
  "README.md",
  "docs/status.md",
  "docs/demo_evidence.md",
  "docs/private_deployment.md",
  "docs/desktop_packaging_checklist.md",
  "docs/license_attribution.md",
  "docs/third_party_notices.md",
  "docs/release_notes_local_first_mvp.md",
];

const REQUIRED_SCREENSHOTS = [
  "docs/screenshots/aletheia-home-desktop.jpg",
  "docs/screenshots/aletheia-matter-overview-desktop.jpg",
  "docs/screenshots/aletheia-run-trace-desktop.jpg",
  "docs/screenshots/aletheia-matter-mobile.jpg",
];

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function env(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function git(root: string, args: string[]) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitBranch(root: string) {
  const currentBranch = git(root, ["branch", "--show-current"]);
  return currentBranch || env("GITHUB_HEAD_REF") || env("GITHUB_REF_NAME");
}

function readText(root: string, relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function contains(root: string, relativePath: string, patterns: string[]) {
  const target = path.join(root, relativePath);
  if (!existsSync(target)) return false;
  const text = readText(root, relativePath);
  return patterns.every((pattern) => text.includes(pattern));
}

function packageScript(root: string, packagePath: string, script: string) {
  const target = path.join(root, packagePath);
  if (!existsSync(target)) return false;
  const parsed = JSON.parse(readText(root, packagePath)) as {
    scripts?: Record<string, string>;
  };
  return typeof parsed.scripts?.[script] === "string";
}

function evidenceFile(root: string, relativePath: string): EvidenceFile {
  const target = path.join(root, relativePath);
  if (!existsSync(target)) {
    return { path: relativePath, exists: false, bytes: 0, sha256: null };
  }
  const stats = statSync(target);
  if (!stats.isFile()) {
    return { path: relativePath, exists: false, bytes: 0, sha256: null };
  }
  const bytes = readFileSync(target);
  return {
    path: relativePath,
    exists: true,
    bytes: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): EvidenceCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const docs = REQUIRED_DOCS.map((file) => evidenceFile(root, file));
  const screenshots = REQUIRED_SCREENSHOTS.map((file) =>
    evidenceFile(root, file),
  );
  const statusShort = git(root, ["status", "--short"]) ?? "";
  const branch = gitBranch(root);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const remote = git(root, ["remote", "get-url", "origin"]);
  const generatedAt = new Date().toISOString();

  const checks: EvidenceCheck[] = [
    check(
      "required-documents-present",
      docs.every((file) => file.exists && file.bytes > 0),
      "README, status, demo evidence, deployment, attribution, and release-note docs must be present.",
    ),
    check(
      "screenshots-present",
      screenshots.every((file) => file.exists && file.bytes > 0),
      "Committed desktop/mobile screenshots must be present for demo evidence.",
    ),
    check(
      "validation-entrypoints-present",
      packageScript(root, "backend/package.json", "check:aletheia:preflight") &&
        packageScript(root, "backend/package.json", "check:aletheia:doctor") &&
        packageScript(root, "backend/package.json", "check:aletheia:backup") &&
        packageScript(root, "backend/package.json", "check:aletheia:restore") &&
        packageScript(root, "backend/package.json", "check:aletheia:privacy") &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:ops-readiness",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:source-provenance",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:knowledge-governance",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:audit-workbench",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:tool-policy",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:approval-policy",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:matter-isolation",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:run-trace",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:evidence",
        ) &&
        packageScript(root, "backend/package.json", "test:aletheia:local") &&
        packageScript(
          root,
          "backend/package.json",
          "test:aletheia:restore-drill",
        ) &&
        packageScript(
          root,
          "backend/package.json",
          "test:aletheia:retrieval-eval",
        ) &&
        packageScript(root, "backend/package.json", "test:aletheia:package") &&
        packageScript(
          root,
          "backend/package.json",
          "test:aletheia:completion",
        ) &&
        packageScript(root, "frontend/package.json", "lint") &&
        packageScript(root, "frontend/package.json", "build") &&
        packageScript(root, "frontend/package.json", "test:aletheia:ui"),
      "Required backend/frontend validation commands must remain available.",
    ),
    check(
      "ci-covers-release-evidence",
      contains(root, ".github/workflows/aletheia-local-ci.yml", [
        "npm run check:aletheia:evidence",
        "npm run check:aletheia:privacy",
        "npm run check:aletheia:ops-readiness",
        "npm run check:aletheia:source-provenance",
        "npm run check:aletheia:knowledge-governance",
        "npm run check:aletheia:audit-workbench",
        "npm run check:aletheia:tool-policy",
        "npm run check:aletheia:approval-policy",
        "npm run check:aletheia:matter-isolation",
        "npm run check:aletheia:run-trace",
        "npm run test:aletheia:local",
        "npm run test:aletheia:restore-drill",
        "npm run test:aletheia:retrieval-eval",
        "npm run test:aletheia:completion",
        "npm run test:aletheia:ui",
      ]),
      "CI must run release evidence, local regression, restore drill, retrieval eval, completion audit, and UI smoke.",
    ),
    check(
      "status-doc-lists-evidence-check",
      contains(root, "docs/status.md", [
        "npm run check:aletheia:evidence",
        "npm run check:aletheia:privacy",
        "release evidence manifest",
      ]),
      "Product status must list the release evidence manifest command and result.",
    ),
    check(
      "git-metadata-present",
      Boolean(branch && commit),
      "Git branch and commit must be readable for handoff evidence.",
    ),
    check(
      "git-worktree-clean",
      statusShort.length === 0,
      statusShort
        ? `Worktree has uncommitted changes:\n${statusShort}`
        : "Worktree is clean.",
      "warning",
    ),
  ];

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );
  const manifest = {
    ok: failedCritical.length === 0,
    suite: "aletheia-release-evidence-v0",
    generatedAt,
    repository: {
      root,
      remote,
      branch,
      commit,
      clean: statusShort.length === 0,
    },
    posture: {
      product: "Aletheia 明证",
      stage: "local-first MVP / private pilot candidate",
      privacyDefault:
        "local SQLite, local filesystem, no external web/model tools by default",
      highRiskActions: [
        "audit_pack_export",
        "feedback_dataset_export",
        "final_memo_export",
        "playbook_update",
      ],
    },
    validationCommands: VALIDATION_COMMANDS,
    documents: docs,
    screenshots,
    warnings: warnings.length,
    checks,
  };

  const out = env("ALETHEIA_RELEASE_EVIDENCE_OUT");
  if (out) {
    const outPath = path.resolve(process.cwd(), out);
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
