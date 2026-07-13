import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type Finding = {
  id: string;
  severity: "critical" | "warning";
  file: string;
  line?: number;
  detail: string;
};

type Check = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

const BLOCKED_TRACKED_PATHS = [
  ".data/",
  "backend/.data/",
  "backend/dist/",
  "frontend/.next/",
  "node_modules/",
  "coverage/",
  "playwright-report/",
  "frontend/playwright-report/",
  "test-results/",
  "frontend/test-results/",
];

const SENSITIVE_ENV_NAMES = [
  "ALETHEIA_PRIVATE_AUTH_TOKEN",
  "NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN",
  "DOWNLOAD_SIGNING_SECRET",
  "USER_API_KEYS_ENCRYPTION_SECRET",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "RESEND_API_KEY",
  "COURTLISTENER_API_TOKEN",
];

const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  {
    id: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    detail: "Tracked file contains a private key block.",
  },
  {
    id: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/,
    detail: "Tracked file contains a value shaped like an OpenAI API key.",
  },
  {
    id: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
    detail: "Tracked file contains a value shaped like an Anthropic API key.",
  },
  {
    id: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{32,}\b/,
    detail: "Tracked file contains a value shaped like a GitHub token.",
  },
  {
    id: "github-pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    detail:
      "Tracked file contains a value shaped like a GitHub fine-grained PAT.",
  },
];

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
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

function isAllowedEnvPath(relativePath: string) {
  const basename = path.basename(relativePath);
  return basename === ".env.example" || basename === ".env.local.example";
}

function isBlockedTrackedPath(relativePath: string) {
  return BLOCKED_TRACKED_PATHS.some((prefix) =>
    relativePath.startsWith(prefix),
  );
}

function isLikelyTextFile(root: string, relativePath: string) {
  const target = path.join(root, relativePath);
  if (!existsSync(target)) return false;
  const stats = statSync(target);
  if (!stats.isFile() || stats.size > 1024 * 1024) return false;
  const sample = readFileSync(target).subarray(0, 4096);
  return !sample.includes(0);
}

function allowedPlaceholderValue(value: string) {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
  if (!normalized) return true;
  return (
    normalized.startsWith("replace-") ||
    normalized.startsWith("your-") ||
    normalized.startsWith("example") ||
    normalized.startsWith("<") ||
    normalized.includes("dummy") ||
    normalized.includes("placeholder") ||
    normalized.includes("test") ||
    normalized.includes("regression-private-token") ||
    normalized.includes("local-private-token")
  );
}

function envAssignment(line: string) {
  const match = line.match(
    new RegExp(
      `^\\s*(?:#\\s*)?(${SENSITIVE_ENV_NAMES.join("|")})\\s*=\\s*([^\\s#]+)`,
    ),
  );
  if (!match) return null;
  return { name: match[1], value: match[2] };
}

function scanFile(root: string, relativePath: string): Finding[] {
  const findings: Finding[] = [];
  const text = readText(root, relativePath);
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const assignment = envAssignment(line);
    if (assignment && !allowedPlaceholderValue(assignment.value)) {
      findings.push({
        id: "tracked-secret-env-assignment",
        severity: "critical",
        file: relativePath,
        line: lineNumber,
        detail: `Tracked file assigns a non-placeholder value to ${assignment.name}.`,
      });
    }

    HIGH_CONFIDENCE_SECRET_PATTERNS.forEach((pattern) => {
      if (pattern.pattern.test(line)) {
        findings.push({
          id: pattern.id,
          severity: "critical",
          file: relativePath,
          line: lineNumber,
          detail: pattern.detail,
        });
      }
    });
  });

  return findings;
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): Check {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const trackedFiles = git(root, ["ls-files"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const trackedEnvFiles = trackedFiles.filter((file) =>
    path.basename(file).startsWith(".env"),
  );
  const blockedTrackedFiles = trackedFiles.filter(isBlockedTrackedPath);
  const disallowedTrackedEnvFiles = trackedEnvFiles.filter(
    (file) => !isAllowedEnvPath(file),
  );
  const textFiles = trackedFiles.filter((file) => isLikelyTextFile(root, file));
  const secretFindings = textFiles.flatMap((file) => scanFile(root, file));

  const checks: Check[] = [
    check(
      "no-tracked-local-data-or-build-output",
      blockedTrackedFiles.length === 0,
      blockedTrackedFiles.length
        ? `Tracked generated/private paths: ${blockedTrackedFiles.join(", ")}`
        : "No tracked local data, build output, Playwright output, coverage, or dependency directories.",
    ),
    check(
      "no-tracked-env-files",
      disallowedTrackedEnvFiles.length === 0,
      disallowedTrackedEnvFiles.length
        ? `Tracked env files are not allowed: ${disallowedTrackedEnvFiles.join(", ")}`
        : "Only .env.example-style templates are tracked.",
    ),
    check(
      "no-high-confidence-secrets",
      secretFindings.length === 0,
      secretFindings.length
        ? `${secretFindings.length} high-confidence secret finding(s) in tracked files.`
        : "No high-confidence secret patterns or non-placeholder sensitive env assignments in tracked files.",
    ),
    check(
      "env-example-local-privacy-defaults",
      contains(root, "backend/.env.example", [
        "ALETHEIA_DATA_DIR=.data/aletheia",
        "ALETHEIA_AUTH_MODE=single_user",
        "ALETHEIA_AUTH_MODE=private_token",
        "ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-a-random-local-private-token",
        "ALETHEIA_SEMANTIC_INDEX_ENABLED=false",
        "ALETHEIA_SEMANTIC_INDEX_DRIVER=disabled",
      ]),
      "backend/.env.example must document local data, private token auth, and disabled semantic index defaults.",
    ),
    check(
      "gitignore-protects-private-runtime-state",
      contains(root, ".gitignore", [
        ".env",
        ".env.*",
        "!.env.example",
        ".data",
        "backend/.data",
        "frontend/.next",
        "playwright-report",
        "test-results",
      ]),
      ".gitignore must block local data, secrets, build artifacts, and test artifacts.",
    ),
  ];

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );
  const result = {
    ok: failedCritical.length === 0,
    suite: "aletheia-privacy-preflight-v0",
    checkedAt: new Date().toISOString(),
    trackedFiles: trackedFiles.length,
    scannedTextFiles: textFiles.length,
    findings: secretFindings,
    warnings: warnings.length,
    checks,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
