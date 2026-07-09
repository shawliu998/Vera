import { readFileSync } from "node:fs";
import path from "node:path";

type ApprovalPolicyCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

const EXPORT_APPROVAL_ACTIONS = [
  "audit_pack_export",
  "feedback_dataset_export",
  "final_memo_export",
];

const HIGH_RISK_POLICY_ACTIONS = [
  ...EXPORT_APPROVAL_ACTIONS,
  "playbook_update",
  "external_source_use",
];

const HIGH_RISK_WORK_PRODUCTS = ["audit_pack", "feedback_export", "final_memo"];

const FINAL_EXPORT_GATE_ACTIONS = [
  "gate_results_persisted",
  "final_export_gate_authorized",
  "final_export_gate_blocked",
];

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function readText(root: string, relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function hasAll(source: string, values: string[]) {
  return values.every((value) => source.includes(value));
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): ApprovalPolicyCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const domain = readText(root, "backend/src/lib/aletheia/domain.ts");
  const localRepository = readText(
    root,
    "backend/src/lib/aletheia/localRepository.ts",
  );
  const supabaseRepository = readText(
    root,
    "backend/src/lib/aletheia/supabaseRepository.ts",
  );
  const routes = readText(root, "backend/src/routes/aletheia.ts");
  const regression = readText(
    root,
    "backend/src/scripts/aletheiaLocalRegression.ts",
  );
  const auditIntegrity = readText(
    root,
    "backend/src/scripts/aletheiaAuditIntegrity.ts",
  );
  const frontendApi = readText(root, "frontend/src/app/lib/aletheiaApi.ts");
  const remoteMatterPage = readText(
    root,
    "frontend/src/aletheia/RemoteMatterPage.tsx",
  );
  const finalMemoApprovalPayload = readText(
    root,
    "frontend/src/aletheia/agentops/finalMemoApprovalPayload.ts",
  );
  const docs = [
    "docs/local_first_runtime.md",
    "docs/private_deployment.md",
    "docs/agent_runtime_roadmap.md",
    "docs/release_notes_local_first_mvp.md",
    "docs/aletheia_tool_adapter.md",
  ]
    .map((file) => readText(root, file))
    .join("\n");

  const localExportGatePresent =
    hasAll(localRepository, HIGH_RISK_WORK_PRODUCTS) &&
    hasAll(localRepository, EXPORT_APPROVAL_ACTIONS) &&
    localRepository.includes("loadApprovedApprovalCheckpoint") &&
    localRepository.includes("throw new ApprovalRequiredError");
  const supabaseExportGatePresent =
    hasAll(supabaseRepository, HIGH_RISK_WORK_PRODUCTS) &&
    hasAll(supabaseRepository, EXPORT_APPROVAL_ACTIONS) &&
    supabaseRepository.includes("loadApprovedApprovalCheckpoint") &&
    supabaseRepository.includes("throw new ApprovalRequiredError");

  const checks: ApprovalPolicyCheck[] = [
    check(
      "workflow-graph-high-risk-policy",
      domain.includes("humanApprovalRequiredFor") &&
        hasAll(domain, HIGH_RISK_POLICY_ACTIONS) &&
        domain.includes('externalNetworkDefault: "disabled"') &&
        domain.includes('destructiveActionsDefault: "disabled"'),
      "Workflow graph must advertise export, playbook, and external-source approval requirements plus disabled network/destructive defaults.",
    ),
    check(
      "local-repository-export-gates",
      localExportGatePresent,
      "Local repository must require approved checkpoints before audit pack, feedback dataset, or final memo export work products.",
    ),
    check(
      "supabase-repository-export-gates",
      supabaseExportGatePresent,
      "Supabase repository must keep parity with local export approval gates.",
    ),
    check(
      "approval-request-route-allowlist",
      routes.includes("/matters/:matterId/approvals") &&
        hasAll(routes, EXPORT_APPROVAL_ACTIONS) &&
        routes.includes("action is invalid") &&
        routes.includes("ApprovalRequiredError"),
      "HTTP approval route must allow only known high-risk export actions and surface approval_required errors.",
    ),
    check(
      "playbook-human-approval-route",
      routes.includes("/matters/:matterId/playbooks/:playbookId/approve") &&
        localRepository.includes('action: "playbook_approved"') &&
        supabaseRepository.includes('action: "playbook_approved"') &&
        localRepository.includes("status = 'approved'") &&
        supabaseRepository.includes('status: "approved"'),
      "Playbook approval must remain an explicit human route with audited approved status.",
    ),
    check(
      "regression-covers-approval-gates",
      regression.includes("Audit pack should require approval") &&
        regression.includes(
          "Feedback dataset export should require approval",
        ) &&
        regression.includes("Final memo export should require approval") &&
        regression.includes(
          "Playbook improvement proposal should remain draft",
        ) &&
        regression.includes(
          "Playbook proposal must not mutate the approved source playbook",
        ),
      "Local regression must cover export approval blocking and draft-only playbook improvement proposals.",
    ),
    check(
      "audit-integrity-checks-approved-links",
      auditIntegrity.includes("high-risk-exports-have-approved-checkpoints") &&
        auditIntegrity.includes("approvalCheckpointId") &&
        hasAll(auditIntegrity, EXPORT_APPROVAL_ACTIONS),
      "Audit integrity must verify high-risk exports resolve to approved checkpoint links.",
    ),
    check(
      "final-memo-requires-persisted-gate-snapshot",
      hasAll(domain, [
        "GATE_SNAPSHOT_SCHEMA_VERSION",
        ...FINAL_EXPORT_GATE_ACTIONS,
        "buildGateSnapshotAuditDetails",
        "frontendOnlyPayloadAccepted: false",
      ]) &&
        hasAll(localRepository, [
          "persistFinalMemoGateAuthorization",
          "persistGateSnapshot",
          "GATE_AUDIT_ACTIONS.resultsPersisted",
          "GATE_AUDIT_ACTIONS.finalExportAuthorized",
          "GATE_AUDIT_ACTIONS.finalExportBlocked",
          "gateSnapshotAuditEventId",
        ]) &&
        hasAll(supabaseRepository, [
          "persistFinalMemoGateAuthorization",
          "persistGateSnapshot",
          "GATE_AUDIT_ACTIONS.resultsPersisted",
          "GATE_AUDIT_ACTIONS.finalExportAuthorized",
          "GATE_AUDIT_ACTIONS.finalExportBlocked",
          "gateSnapshotAuditEventId",
        ]) &&
        routes.includes("/matters/:matterId/gate-snapshots") &&
        hasAll(auditIntegrity, [
          "final-memo-exports-have-persisted-gate-snapshots",
          "final-memo-gate-snapshots-pass",
          "final-memo-exports-have-gate-authorization-events",
        ]),
      "Final memo export must persist and audit a passing gate snapshot in both repositories before final export authorization.",
    ),
    check(
      "frontend-final-memo-approval-links-gate-snapshot",
      frontendApi.includes("persistAletheiaGateSnapshot") &&
        frontendApi.includes("/aletheia/matters/${matterId}/gate-snapshots") &&
        remoteMatterPage.includes("persistAletheiaGateSnapshot") &&
        remoteMatterPage.indexOf("persistAletheiaGateSnapshot") <
          remoteMatterPage.indexOf("requestAletheiaApproval(matterId") &&
        remoteMatterPage.includes("buildFinalMemoApprovalRequestedPayload") &&
        remoteMatterPage.includes("gateSnapshotAuditEvent.id") &&
        finalMemoApprovalPayload.includes("gateSnapshotAuditEventId"),
      "Frontend final memo approval request must persist a gate snapshot first and carry gateSnapshotAuditEventId into the approval payload.",
    ),
    check(
      "docs-approval-posture",
      hasAll(docs, [
        "High-risk exports require approval checkpoints",
        "No agent-written playbook updates without human approval",
        "does not bypass approval",
      ]) &&
        docs.includes("playbook updates") &&
        docs.includes("external calls"),
      "Docs must describe approval checkpoints, playbook human approval, Tool Adapter approval behavior, and external-call controls.",
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
        suite: "aletheia-approval-policy-audit-v0",
        checkedAt: new Date().toISOString(),
        exportApprovalActions: EXPORT_APPROVAL_ACTIONS,
        highRiskPolicyActions: HIGH_RISK_POLICY_ACTIONS,
        highRiskWorkProducts: HIGH_RISK_WORK_PRODUCTS,
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
