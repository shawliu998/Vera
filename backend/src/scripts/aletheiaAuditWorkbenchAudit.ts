import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type WorkbenchCheck = {
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

function hasAll(source: string, values: string[]) {
  return values.every((value) => source.includes(value));
}

function contains(root: string, relativePath: string, patterns: string[]) {
  if (!fileExists(root, relativePath)) return false;
  return hasAll(readText(root, relativePath), patterns);
}

function packageScript(root: string, packagePath: string, script: string) {
  if (!fileExists(root, packagePath)) return false;
  const parsed = JSON.parse(readText(root, packagePath)) as {
    scripts?: Record<string, string>;
  };
  return typeof parsed.scripts?.[script] === "string";
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): WorkbenchCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const auditWorkbench = readText(
    root,
    "frontend/src/aletheia/AletheiaAuditWorkbench.tsx",
  );
  const evidenceRegistry = readText(
    root,
    "frontend/src/aletheia/AletheiaEvidenceRegistry.tsx",
  );
  const reviewRegistry = readText(
    root,
    "frontend/src/aletheia/AletheiaReviewRegistry.tsx",
  );
  const localRepository = readText(
    root,
    "backend/src/lib/aletheia/localRepository.ts",
  );
  const localRegression = readText(
    root,
    "backend/src/scripts/aletheiaLocalRegression.ts",
  );
  const uiSmoke = readText(root, "frontend/tests/aletheia-ui-smoke.spec.ts");
  const docs = [
    "README.md",
    "docs/status.md",
    "docs/demo_evidence.md",
    "docs/ui_smoke.md",
    "docs/local_first_runtime.md",
    "docs/private_deployment.md",
    "docs/desktop_packaging_checklist.md",
    "docs/release_notes_local_first_mvp.md",
  ]
    .filter((file) => fileExists(root, file))
    .map((file) => readText(root, file))
    .join("\n");

  const checks: WorkbenchCheck[] = [
    check(
      "audit-workbench-filter-export-snapshot",
      hasAll(auditWorkbench, [
        'data-testid="aletheia-audit-workbench"',
        'data-testid="export-filtered-audit"',
        'data-testid="save-audit-snapshot"',
        'data-testid="audit-filter-query"',
        'data-testid="audit-filter-action"',
        'data-testid="audit-timeline-results"',
        'data-testid="audit-matter-packets"',
        'data-testid="audit-work-products"',
        'downloadJson("aletheia-filtered-audit-workbench"',
        'schemaVersion: "aletheia-audit-workbench-export-v0"',
        'kind: "registry_snapshot"',
        'schemaVersion: "aletheia-audit-workbench-snapshot-v0"',
        'source: "local_repository"',
        "Live local audit records from persisted matters.",
        "Review Readiness",
      ]),
      "Audit Workbench must expose live local audit filters, JSON export, matter packets, work products, readiness, and matter-scoped registry snapshots.",
    ),
    check(
      "evidence-registry-filter-export-snapshot",
      hasAll(evidenceRegistry, [
        'data-testid="aletheia-evidence-registry"',
        'data-testid="export-filtered-evidence"',
        'data-testid="save-evidence-snapshot"',
        'data-testid="evidence-filter-query"',
        'data-testid="evidence-filter-support"',
        'data-testid="evidence-registry-results"',
        'downloadJson("aletheia-filtered-evidence-registry"',
        'schemaVersion: "aletheia-evidence-registry-export-v0"',
        'kind: "registry_snapshot"',
        'schemaVersion: "aletheia-evidence-registry-snapshot-v0"',
        'source: "local_repository"',
        "matter-scoped evidence snapshot",
      ]),
      "Evidence Registry must support source-linked filtering, export, and persisted snapshot work products.",
    ),
    check(
      "review-registry-filter-export-snapshot",
      hasAll(reviewRegistry, [
        'data-testid="aletheia-review-registry"',
        'data-testid="export-filtered-reviews"',
        'data-testid="save-review-snapshot"',
        'data-testid="review-filter-query"',
        'data-testid="review-filter-tag"',
        'data-testid="review-registry-results"',
        'downloadJson("aletheia-filtered-review-registry"',
        'schemaVersion: "aletheia-review-registry-export-v0"',
        'kind: "registry_snapshot"',
        'schemaVersion: "aletheia-review-registry-snapshot-v0"',
        'source: "local_repository"',
        "matter-scoped review snapshot",
      ]),
      "Review Registry must support review-tag filtering, export, and persisted snapshot work products.",
    ),
    check(
      "local-repository-snapshot-persistence",
      hasAll(localRepository, [
        "function localExportPath",
        "function shouldPersistLocalExport",
        '"registry_snapshot"',
        "writeFileSync(",
        "auditActionForWorkProduct(input.kind)",
        "exportPath",
      ]) &&
        contains(root, "backend/src/lib/aletheia/domain.ts", [
          'if (kind === "registry_snapshot") return "registry_snapshot_saved";',
        ]) &&
        contains(root, "backend/src/scripts/aletheiaAuditIntegrity.ts", [
          'registry_snapshot: "registry_snapshot_saved"',
          "Every persisted local export work product has a matching audit event.",
          "Every persisted local export audit event points to an existing file.",
        ]),
      "Local repository and audit-integrity checks must persist registry snapshots under the export store and emit registry_snapshot_saved audit events.",
    ),
    check(
      "local-regression-covers-snapshot-audit",
      hasAll(localRegression, [
        'kind: "registry_snapshot"',
        'registrySnapshot.kind === "registry_snapshot"',
        'event.action === "registry_snapshot_saved"',
        "Registry snapshot audit event should include export path",
      ]),
      "Local regression must create a registry snapshot and verify its persisted audit event/export path.",
    ),
    check(
      "ui-smoke-covers-registries",
      hasAll(uiSmoke, [
        "aletheia-evidence-registry",
        "evidence-filter-query",
        "export-filtered-evidence",
        "save-evidence-snapshot",
        "aletheia-review-registry",
        "review-filter-query",
        "review-filter-tag",
        "export-filtered-reviews",
        "save-review-snapshot",
        "aletheia-audit-workbench",
        "audit-matter-packets",
        "audit-filter-query",
        "audit-filter-action",
        "export-filtered-audit",
        "save-audit-snapshot",
        "matter-scoped audit snapshot",
      ]),
      "UI smoke must exercise evidence, review, and audit registry filters, downloads, and snapshot saves.",
    ),
    check(
      "docs-describe-audit-workbench",
      hasAll(docs, [
        "Audit Workbench",
        "matter readiness",
        "matter readiness packets",
        "registry_snapshot",
        "npm run check:aletheia:audit-workbench",
      ]),
      "Docs must describe Audit Workbench readiness packets, registry snapshots, and the audit-workbench validation command.",
    ),
    check(
      "automation-includes-audit-workbench",
      packageScript(
        root,
        "backend/package.json",
        "check:aletheia:audit-workbench",
      ) &&
        contains(root, ".github/workflows/aletheia-local-ci.yml", [
          "npm run check:aletheia:audit-workbench",
        ]) &&
        hasAll(docs, ["npm run check:aletheia:audit-workbench"]),
      "Package scripts, CI, and docs must include the Audit Workbench audit entrypoint.",
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
        suite: "aletheia-audit-workbench-audit-v0",
        checkedAt: new Date().toISOString(),
        warnings: warnings.length,
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
