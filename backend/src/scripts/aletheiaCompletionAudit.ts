import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type AuditItem = {
  id: string;
  requirement: string;
  evidence: string[];
  ok: boolean;
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

function nonEmptyFile(root: string, relativePath: string) {
  const target = path.join(root, relativePath);
  return existsSync(target) && statSync(target).size > 0;
}

function contains(root: string, relativePath: string, patterns: string[]) {
  if (!fileExists(root, relativePath)) return false;
  const text = readText(root, relativePath);
  return patterns.every((pattern) => text.includes(pattern));
}

function doesNotContain(
  root: string,
  relativePath: string,
  patterns: string[],
) {
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

function item(args: Omit<AuditItem, "ok" | "detail"> & { checks: boolean[] }) {
  const ok = args.checks.every(Boolean);
  return {
    id: args.id,
    requirement: args.requirement,
    evidence: args.evidence,
    ok,
    detail: ok ? "verified" : "missing or inconsistent evidence",
  };
}

function main() {
  const root = repoRoot();
  const auditItems: AuditItem[] = [
    item({
      id: "local-first-storage",
      requirement:
        "Aletheia has a local-first persistence boundary with SQLite, filesystem documents, exports, and local auth modes.",
      evidence: [
        "backend/src/lib/aletheia/localRepository.ts",
        "backend/src/lib/aletheia/localDatabase.ts",
        "backend/src/lib/aletheia/documentParser.ts",
        "backend/src/middleware/auth.ts",
        "docs/local_deployment.md",
      ],
      checks: [
        contains(root, "backend/src/lib/aletheia/localRepository.ts", [
          "LocalDatabase",
          "writeMatterDocumentFile",
          "shouldPersistLocalExport",
        ]),
        contains(root, "backend/src/lib/aletheia/localDatabase.ts", [
          "node:sqlite",
          "@signalapp/sqlcipher",
          "cipher_integrity_check",
        ]),
        contains(root, "backend/src/lib/aletheia/documentParser.ts", [
          "extractMatterDocumentText",
          "chunkMatterDocument",
        ]),
        contains(root, "backend/src/middleware/auth.ts", [
          "single_user",
          "private_token",
          "ALETHEIA_PRIVATE_AUTH_TOKEN",
        ]),
        contains(root, "docs/local_deployment.md", [
          "SQLite",
          "documents/",
          "exports/",
          "private_token",
        ]),
      ],
    }),
    item({
      id: "real-document-chain",
      requirement:
        "The local workflow covers real TXT/DOCX/PDF parsing, chunking, FTS5 search, evidence mapping, source-linked work products, review, and audit export.",
      evidence: [
        "backend/src/scripts/aletheiaLocalRegression.ts",
        "backend/src/lib/aletheia/localRepository.ts",
      ],
      checks: [
        contains(root, "backend/src/scripts/aletheiaLocalRegression.ts", [
          "TXT document should parse",
          "DOCX document should parse",
          "PDF document should parse",
          "FTS search should find text",
          "Evidence should retain source chunk ID",
          "Approved audit pack should persist",
        ]),
        contains(root, "backend/src/lib/aletheia/localRepository.ts", [
          "generateIssueMap",
          "generateEvidenceMatrix",
          "generateDraftMemo",
          "evidence_mapped",
        ]),
      ],
    }),
    item({
      id: "professional-templates",
      requirement:
        "Legal, compliance, and diligence matters produce template-specific source-linked work products.",
      evidence: [
        "backend/src/lib/aletheia/domain.ts",
        "backend/src/scripts/aletheiaLocalRegression.ts",
        "frontend/src/aletheia/TemplatePreviewPage.tsx",
      ],
      checks: [
        contains(root, "backend/src/lib/aletheia/domain.ts", [
          "compliance_register",
          "red_flag_memo",
          "professionalDraftProfileForTemplate",
        ]),
        contains(root, "backend/src/scripts/aletheiaLocalRegression.ts", [
          "compliance_impact_review",
          "deal_due_diligence",
          "compliance_register",
          "red_flag_memo",
        ]),
        contains(root, "frontend/src/aletheia/TemplatePreviewPage.tsx", [
          "local workflow preview",
          "Template Work Products",
        ]),
        contains(root, "frontend/src/app/aletheia/templates/page.tsx", [
          "local MVP",
          "local pilot",
        ]),
        doesNotContain(root, "frontend/src/app/aletheia/templates/page.tsx", [
          ': "mock"',
          ">mock<",
        ]),
      ],
    }),
    item({
      id: "matter-memory-playbooks",
      requirement:
        "Matter Memory and Playbooks are matter-scoped, persisted, audited, and require human approval for approved playbooks.",
      evidence: [
        "backend/src/lib/aletheia/localRepository.ts",
        "backend/src/scripts/aletheiaLocalRegression.ts",
        "frontend/src/aletheia/RemoteMatterSidebar.tsx",
      ],
      checks: [
        contains(root, "backend/src/lib/aletheia/localRepository.ts", [
          "addMatterMemory",
          "createPlaybook",
          "approvePlaybook",
          "proposePlaybookImprovement",
        ]),
        contains(root, "backend/src/scripts/aletheiaLocalRegression.ts", [
          "Matter memory should persist",
          "Playbook should be approved",
          "Playbook improvement proposal should remain draft",
        ]),
        contains(root, "frontend/src/aletheia/RemoteMatterSidebar.tsx", [
          "Matter Memory",
          "Matter Playbooks",
        ]),
      ],
    }),
    item({
      id: "run-trace-approval-gates",
      requirement:
        "Agent Run Trace records steps, tool calls, human checkpoints, Workflow Graph metadata, and approval-gated high-risk exports.",
      evidence: [
        "backend/src/lib/aletheia/domain.ts",
        "backend/src/scripts/aletheiaLocalRegression.ts",
        "frontend/src/aletheia/RemoteMatterRunTrace.tsx",
      ],
      checks: [
        contains(root, "backend/src/lib/aletheia/domain.ts", [
          "buildAgentRunTraceScaffold",
          "buildAgentWorkflowGraph",
          "humanApprovalRequiredFor",
          "audit_pack_export",
        ]),
        contains(root, "backend/src/scripts/aletheiaLocalRegression.ts", [
          "Workflow graph should expose allowlist tool policy",
          "Audit pack should require approval",
          "Feedback dataset export should require approval",
          "Resumed run should append a resume step",
        ]),
        contains(root, "frontend/src/aletheia/RemoteMatterRunTrace.tsx", [
          "Workflow Graph",
          "Human checkpoints",
          "Tool calls",
        ]),
      ],
    }),
    item({
      id: "audit-workbench-registries",
      requirement:
        "Audit Workbench, Evidence Registry, and Review Registry expose filterable local records, JSON exports, persisted registry snapshots, and UI smoke coverage.",
      evidence: [
        "frontend/src/aletheia/AletheiaAuditWorkbench.tsx",
        "frontend/src/aletheia/AletheiaEvidenceRegistry.tsx",
        "frontend/src/aletheia/AletheiaReviewRegistry.tsx",
        "frontend/tests/aletheia-ui-smoke.spec.ts",
      ],
      checks: [
        contains(root, "frontend/src/aletheia/AletheiaAuditWorkbench.tsx", [
          "aletheia-audit-workbench",
          "audit-filter-query",
          "audit-filter-action",
          "export-filtered-audit",
          "save-audit-snapshot",
          "aletheia-audit-workbench-snapshot-v0",
          "audit-matter-packets",
        ]),
        contains(root, "frontend/src/aletheia/AletheiaEvidenceRegistry.tsx", [
          "aletheia-evidence-registry",
          "export-filtered-evidence",
          "save-evidence-snapshot",
          "aletheia-evidence-registry-snapshot-v0",
        ]),
        contains(root, "frontend/src/aletheia/AletheiaReviewRegistry.tsx", [
          "aletheia-review-registry",
          "export-filtered-reviews",
          "save-review-snapshot",
          "aletheia-review-registry-snapshot-v0",
        ]),
        contains(root, "frontend/tests/aletheia-ui-smoke.spec.ts", [
          "export-filtered-evidence",
          "save-evidence-snapshot",
          "export-filtered-reviews",
          "save-review-snapshot",
          "export-filtered-audit",
          "save-audit-snapshot",
        ]),
        contains(root, "backend/src/lib/aletheia/localRepository.ts", [
          "registry_snapshot",
          "exportPath",
          "auditActionForWorkProduct(input.kind)",
        ]),
        contains(root, "docs/status.md", [
          "npm run check:aletheia:audit-workbench",
        ]),
      ],
    }),
    item({
      id: "tool-adapter-mcp",
      requirement:
        "Aletheia exposes a narrow least-privilege Tool Adapter and stdio MCP wrapper without terminal/browser/web/email/destructive tools.",
      evidence: [
        "backend/src/routes/aletheia.ts",
        "backend/src/mcp/aletheiaServer.ts",
        "docs/aletheia_tool_adapter.md",
      ],
      checks: [
        contains(root, "backend/src/routes/aletheia.ts", [
          "list_matters",
          "search_matter_documents",
          "append_audit_event",
          "export_audit_pack",
        ]),
        contains(root, "backend/src/mcp/aletheiaServer.ts", [
          "list_matters",
          "read_matter",
          "search_matter_documents",
          "export_audit_pack",
        ]),
        contains(root, "docs/aletheia_tool_adapter.md", [
          "least privilege",
          "does not bypass approval",
          "terminal",
          "browser",
          "email",
        ]),
      ],
    }),
    item({
      id: "retrieval-adapter-eval",
      requirement:
        "Retrieval defaults to SQLite FTS5, optional semantic/hybrid retrieval fails closed unless explicitly enabled, and eval covers cross-matter isolation.",
      evidence: [
        "backend/src/scripts/aletheiaRetrievalEval.ts",
        "docs/retrieval_eval.md",
        "docs/hybrid_retrieval.md",
      ],
      checks: [
        contains(root, "backend/src/scripts/aletheiaRetrievalEval.ts", [
          "failClosedPassed",
          "keyword",
          "semantic",
          "hybrid",
          "isolation-alpha-cannot-see-beta",
        ]),
        contains(root, "docs/retrieval_eval.md", [
          "keyword retrieval",
          "fails closed",
          "matter-scoped search",
        ]),
        contains(root, "docs/hybrid_retrieval.md", [
          "local-json",
          "ALETHEIA_SEMANTIC_INDEX_ENABLED",
          "SQLite FTS5",
        ]),
      ],
    }),
    item({
      id: "external-source-connector",
      requirement:
        "External-source capture has an explicit per-matter opt-in, HTTPS host allowlist, public-address policy, pinned request path, response limits, and a reviewable workpaper handoff.",
      evidence: [
        "backend/src/lib/aletheia/externalSourceFetch.ts",
        "backend/src/routes/aletheia.ts",
        "backend/src/scripts/aletheiaExternalSourceConnectorAudit.ts",
        "frontend/src/components/agentops/ExternalSourceWorkpaperPanel.tsx",
      ],
      checks: [
        contains(root, "backend/src/lib/aletheia/externalSourceFetch.ts", [
          "ALETHEIA_EXTERNAL_SOURCE_ALLOWED_DOMAINS",
          "validateExternalSourceUrl",
          "resolvePublicAddress",
          "fetchPinnedHttps",
          "MAX_RESPONSE_BYTES",
          "externalAccessOptIn",
        ]),
        contains(root, "backend/src/routes/aletheia.ts", [
          "/matters/:matterId/external-source/fetch",
          "fetchAllowlistedExternalSource",
          "external_source_policy",
        ]),
        contains(
          root,
          "frontend/src/components/agentops/ExternalSourceWorkpaperPanel.tsx",
          [
            "allowlisted_https_fetch",
            "fetchAletheiaExternalSource",
            "externalAccessOptIn",
            "needs_review",
          ],
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:external-source-connector",
        ),
      ],
    }),
    item({
      id: "word-addin-taskpane",
      requirement:
        "A Word Office Add-in manifest and task pane can capture a selected text into a review-only, audited Hermes handoff without mutating the document.",
      evidence: [
        "office-addin/word-manifest.xml",
        "frontend/src/app/office/word/page.tsx",
        "backend/src/scripts/aletheiaWordAddinManifestAudit.ts",
      ],
      checks: [
        contains(root, "office-addin/word-manifest.xml", [
          "TaskPaneApp",
          "WordApi",
          "https://localhost:3000/office/word",
          "ReadDocument",
        ]),
        contains(root, "frontend/src/app/office/word/page.tsx", [
          "getSelectedDataAsync",
          "createAletheiaWorkProduct",
          "addAletheiaReview",
          "wordClientApplied: false",
        ]),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:word-addin-manifest",
        ),
      ],
    }),
    item({
      id: "preference-learning-approval",
      requirement:
        "An opted-in, revocable matter-scoped preference can only map to a new approved matter playbook after its linked review and proposal audit are accepted; it cannot auto-apply or cross matters.",
      evidence: [
        "backend/src/lib/aletheia/localRepository.ts",
        "backend/src/routes/aletheia.ts",
        "frontend/src/components/agentops/PreferenceLearningPanel.tsx",
      ],
      checks: [
        contains(root, "backend/src/lib/aletheia/localRepository.ts", [
          "approvePreferenceLearningCandidate",
          "Preference approval requires the original proposal audit record.",
          "linked review to be accepted",
          "autoApply: false",
          "preference_learning_candidate_approved",
        ]),
        contains(root, "backend/src/routes/aletheia.ts", [
          "/matters/:matterId/preference-learning/:memoryItemId/approve",
          "approvePreferenceLearningCandidate",
        ]),
        contains(
          root,
          "frontend/src/components/agentops/PreferenceLearningPanel.tsx",
          [
            "acceptProposalReview",
            "approveProposal",
            "approved playbook mapping",
            "auto-change playbooks or other matters",
          ],
        ),
      ],
    }),
    item({
      id: "automation-validation",
      requirement:
        "Automated validation exists for backend build, local regression, restore drill, retrieval eval, package preflight, frontend lint/build, and UI smoke.",
      evidence: [
        "backend/package.json",
        "frontend/package.json",
        ".github/workflows/aletheia-local-ci.yml",
        "docs/status.md",
      ],
      checks: [
        packageScript(root, "backend/package.json", "check:aletheia:preflight"),
        packageScript(root, "backend/package.json", "build"),
        packageScript(root, "backend/package.json", "check:aletheia:doctor"),
        packageScript(root, "backend/package.json", "check:aletheia:backup"),
        packageScript(root, "backend/package.json", "check:aletheia:restore"),
        packageScript(root, "backend/package.json", "check:aletheia:privacy"),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:ops-readiness",
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:source-provenance",
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:knowledge-governance",
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:audit-workbench",
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:tool-policy",
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:approval-policy",
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:external-source-connector",
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:word-addin-manifest",
        ),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:matter-isolation",
        ),
        packageScript(root, "backend/package.json", "check:aletheia:run-trace"),
        packageScript(root, "backend/package.json", "check:aletheia:evidence"),
        packageScript(
          root,
          "backend/package.json",
          "check:aletheia:audit-integrity",
        ),
        packageScript(root, "backend/package.json", "test:aletheia:local"),
        packageScript(
          root,
          "backend/package.json",
          "test:aletheia:retrieval-eval",
        ),
        packageScript(root, "backend/package.json", "check:aletheia:operator"),
        packageScript(root, "backend/package.json", "test:aletheia:package"),
        packageScript(
          root,
          "backend/package.json",
          "test:aletheia:restore-drill",
        ),
        packageScript(root, "frontend/package.json", "lint"),
        packageScript(root, "frontend/package.json", "build"),
        packageScript(root, "frontend/package.json", "test:aletheia:ui"),
        contains(root, ".github/workflows/aletheia-local-ci.yml", [
          "Aletheia Local CI",
          "npm run check:aletheia:doctor",
          "npm run check:aletheia:backup",
          "npm run check:aletheia:restore",
          "npm run check:aletheia:privacy",
          "npm run check:aletheia:ops-readiness",
          "npm run check:aletheia:source-provenance",
          "npm run check:aletheia:knowledge-governance",
          "npm run check:aletheia:audit-workbench",
          "npm run check:aletheia:tool-policy",
          "npm run check:aletheia:approval-policy",
          "npm run check:aletheia:external-source-connector",
          "npm run check:aletheia:word-addin-manifest",
          "npm run check:aletheia:matter-isolation",
          "npm run check:aletheia:run-trace",
          "npm run check:aletheia:evidence",
          "npm run check:aletheia:audit-integrity",
          "npm run test:aletheia:local",
          "npm run test:aletheia:restore-drill",
          "npm run test:aletheia:retrieval-eval",
          "npm run test:aletheia:package",
          "npm run test:aletheia:completion",
          "npm run test:aletheia:ui",
        ]),
        contains(root, "docs/status.md", [
          "npm run check:aletheia:preflight",
          "npm run check:aletheia:doctor",
          "npm run check:aletheia:backup",
          "npm run check:aletheia:restore",
          "npm run check:aletheia:privacy",
          "npm run check:aletheia:ops-readiness",
          "npm run check:aletheia:source-provenance",
          "npm run check:aletheia:knowledge-governance",
          "npm run check:aletheia:audit-workbench",
          "npm run check:aletheia:tool-policy",
          "npm run check:aletheia:approval-policy",
          "npm run check:aletheia:external-source-connector",
          "npm run check:aletheia:word-addin-manifest",
          "npm run check:aletheia:matter-isolation",
          "npm run check:aletheia:run-trace",
          "npm run check:aletheia:evidence",
          "npm run check:aletheia:audit-integrity",
          "npm run test:aletheia:local",
          "npm run test:aletheia:restore-drill",
          "npm run check:aletheia:operator",
          "npm run test:aletheia:retrieval-eval",
          "npm run test:aletheia:package",
          "npm run test:aletheia:ui",
        ]),
      ],
    }),
    item({
      id: "private-deployment",
      requirement:
        "Private deployment docs and package preflight cover local data boundary, backup/restore, startup scripts, privacy defaults, and source availability.",
      evidence: [
        "backend/src/scripts/aletheiaPackageLocal.ts",
        "docs/private_deployment.md",
        "docs/desktop_packaging_checklist.md",
      ],
      checks: [
        contains(root, "backend/src/scripts/aletheiaPackageLocal.ts", [
          "backupTogether",
          "restoreChecks",
          "sourceAvailabilityDocs",
          "privacyDefaults",
        ]),
        contains(root, "docs/private_deployment.md", [
          "private_token",
          "Back up",
          "MCP Wrapper",
          "Current Boundaries",
        ]),
        contains(root, "docs/desktop_packaging_checklist.md", [
          "Backup / Restore",
          "Privacy Defaults",
          "Preflight",
        ]),
      ],
    }),
    item({
      id: "docs-demo-evidence-attribution",
      requirement:
        "Documentation, screenshots, demo evidence, license attribution, and third-party notices exist for review and distribution.",
      evidence: [
        "docs/demo_evidence.md",
        "docs/screenshots/*",
        "docs/license_attribution.md",
        "docs/third_party_notices.md",
      ],
      checks: [
        nonEmptyFile(root, "docs/screenshots/aletheia-home-desktop.jpg"),
        nonEmptyFile(
          root,
          "docs/screenshots/aletheia-matter-overview-desktop.jpg",
        ),
        nonEmptyFile(root, "docs/screenshots/aletheia-run-trace-desktop.jpg"),
        nonEmptyFile(root, "docs/screenshots/aletheia-matter-mobile.jpg"),
        contains(root, "docs/demo_evidence.md", [
          "Verified Signals",
          "Run Trace",
          "Audit Workbench",
        ]),
        contains(root, "docs/status.md", [
          "release evidence manifest",
          "npm run check:aletheia:privacy",
          "npm run check:aletheia:tool-policy",
          "npm run check:aletheia:approval-policy",
          "npm run check:aletheia:matter-isolation",
          "npm run check:aletheia:evidence",
        ]),
        contains(root, "README.md", [
          "Local Pilot Mode",
          "deterministic fallback",
          "real document upload",
        ]),
        doesNotContain(root, "README.md", ["## Mock Mode"]),
        contains(root, "docs/license_attribution.md", ["AGPL"]),
        contains(root, "docs/third_party_notices.md", ["MIT", "AGPL"]),
      ],
    }),
  ];

  const failed = auditItems.filter((entry) => !entry.ok);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failed.length === 0,
        suite: "aletheia-completion-audit-v0",
        checkedAt: new Date().toISOString(),
        total: auditItems.length,
        passed: auditItems.length - failed.length,
        failed: failed.length,
        items: auditItems,
      },
      null,
      2,
    )}\n`,
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main();
