import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type GovernanceCheck = {
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
): GovernanceCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const domain = readText(root, "backend/src/lib/aletheia/domain.ts");
  const repository = readText(root, "backend/src/lib/aletheia/repository.ts");
  const localRepository = readText(
    root,
    "backend/src/lib/aletheia/localRepository.ts",
  );
  const supabaseRepository = readText(
    root,
    "backend/src/lib/aletheia/supabaseRepository.ts",
  );
  const routes = readText(root, "backend/src/routes/aletheia.ts");
  const mcp = readText(root, "backend/src/mcp/aletheiaServer.ts");
  const localRegression = readText(
    root,
    "backend/src/scripts/aletheiaLocalRegression.ts",
  );
  const approvalAudit = readText(
    root,
    "backend/src/scripts/aletheiaApprovalPolicyAudit.ts",
  );
  const matterIsolationAudit = readText(
    root,
    "backend/src/scripts/aletheiaMatterIsolationAudit.ts",
  );
  const ui = [
    "frontend/src/aletheia/RemoteMatterPage.tsx",
    "frontend/src/aletheia/RemoteMatterSidebar.tsx",
  ]
    .map((file) => readText(root, file))
    .join("\n");
  const docs = [
    "README.md",
    "docs/status.md",
    "docs/local_first_runtime.md",
    "docs/hermes_inspiration.md",
    "docs/agent_runtime_roadmap.md",
    "docs/private_deployment.md",
    "docs/desktop_packaging_checklist.md",
    "docs/release_notes_local_first_mvp.md",
  ]
    .filter((file) => fileExists(root, file))
    .map((file) => readText(root, file))
    .join("\n");

  const checks: GovernanceCheck[] = [
    check(
      "domain-bounded-memory-playbooks",
      hasAll(domain, [
        "MATTER_MEMORY_CATEGORIES",
        "confirmed_fact",
        "output_preference",
        "excluded_path",
        "missing_material",
        "reviewer_feedback",
        "PLAYBOOK_STATUSES",
        "draft",
        "approved",
        "superseded",
        "playbook_update",
      ]),
      "Domain contract must keep Matter Memory categories bounded and Playbook states explicit.",
    ),
    check(
      "repository-knowledge-contract",
      hasAll(repository, [
        "addMatterMemory(",
        "createPlaybook(",
        "approvePlaybook(",
        "proposePlaybookImprovement(",
        "AddMatterMemoryInput",
        "CreatePlaybookInput",
        "ProposePlaybookImprovementInput",
      ]),
      "Repository interface must expose explicit memory, playbook draft, approval, and improvement proposal operations.",
    ),
    check(
      "local-matter-scoped-knowledge",
      hasAll(localRepository, [
        "aletheia_matter_memory_items",
        "aletheia_playbooks",
        "this.loadOwnedMatter(ctx, matterId)",
        "matter_id, user_id, category, title, body, source, metadata",
        'action: "matter_memory_added"',
        "status = 'approved', approved_by = ?, approved_at = ?",
        'action: "playbook_approved"',
        "where matter_id = ? and user_id = ? and status = 'approved'",
        "Playbook improvements must be based on an approved source playbook.",
        "draft_requires_human_approval",
        "agentMayAutoModifyApprovedPlaybook: false",
        "playbook_improvement_proposed",
      ]),
      "Local repository must keep memory/playbooks matter-scoped, audited, human-approved, and proposal-only for agent-generated improvements.",
    ),
    check(
      "supabase-knowledge-boundary",
      hasAll(supabaseRepository, [
        "aletheia_matter_memory_items",
        "aletheia_playbooks",
        "loadOwnedMatter(ctx, matterId)",
        'status: "draft"',
        'status: "approved"',
        "approved_by: ctx.userId",
        "playbook_approved",
        "CapabilityNotAvailableError",
        "Playbook improvement proposals are currently available only in local Aletheia storage mode.",
      ]),
      "Supabase adapter must keep memory/playbooks matter-scoped and fail closed for local-only playbook improvement proposals.",
    ),
    check(
      "human-approval-routes",
      hasAll(routes, [
        '"/matters/:matterId/memory"',
        '"/matters/:matterId/playbooks"',
        '"/matters/:matterId/playbooks/improvement-proposals"',
        '"/matters/:matterId/playbooks/:playbookId/approve"',
        "playbooks must be drafted before approval",
        "approvePlaybook",
      ]),
      "HTTP routes must separate memory creation, playbook drafting, improvement proposals, and explicit human approval.",
    ),
    check(
      "tool-adapter-no-knowledge-mutation",
      mcp.includes("memory, and playbooks") &&
        !mcp.includes("add_matter_memory") &&
        !mcp.includes("create_playbook") &&
        !mcp.includes("approve_playbook") &&
        !mcp.includes("propose_playbook"),
      "MCP/Tool Adapter may read matter knowledge context but must not expose mutation tools for memory or playbooks by default.",
    ),
    check(
      "ui-human-approval-controls",
      hasAll(ui, [
        "Matter Memory",
        "Matter Playbooks",
        "Matter-scoped memory",
        "Versioned workflow instructions",
        "Draft Playbook",
        "Propose Playbook Update",
        "Approve Playbook",
        "agentMayAutoModify: false",
        "requiresHumanApprovalForUpdates: true",
        "Playbook improvement proposal drafted. Human approval is still required.",
      ]),
      "UI must present memory as matter-scoped and playbook changes as draft/proposal flows requiring human approval.",
    ),
    check(
      "regression-knowledge-governance",
      hasAll(localRegression, [
        "Matter memory should persist",
        "Reviewer feedback memory should persist",
        "Playbook should be approved",
        "Playbook improvement proposal should remain draft",
        "Playbook proposal should reference the approved source playbook",
        "Playbook proposal must not mutate the approved source playbook",
      ]),
      "Local regression must prove memory persistence, reviewer feedback, playbook approval, and non-mutating draft proposals.",
    ),
    check(
      "existing-policy-audits-cover-knowledge",
      hasAll(approvalAudit, [
        "playbook_update",
        "playbook-human-approval-route",
        "Playbook improvement proposal should remain draft",
        "Playbook proposal must not mutate the approved source playbook",
        "No agent-written playbook updates without human approval",
      ]) &&
        hasAll(matterIsolationAudit, [
          "local-memory-playbook-matter-boundary",
          "Matter Memory and Playbook reads/writes must remain matter- and user-scoped.",
          "runtime-cross-matter-memory-disabled",
        ]),
      "Approval and matter isolation audits must cover playbook updates, non-mutating proposals, and no cross-matter memory.",
    ),
    check(
      "docs-knowledge-governance",
      packageScript(
        root,
        "backend/package.json",
        "check:aletheia:knowledge-governance",
      ) &&
        hasAll(docs, [
          "Matter Memory",
          "Matter Playbooks",
          "matter-scoped",
          "human-approved",
          "No global legal memory",
          "No agent-written playbook updates without human approval",
          "npm run check:aletheia:knowledge-governance",
        ]),
      "Docs and package scripts must describe matter-scoped memory, human-approved playbooks, no global legal memory, and the knowledge governance audit.",
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
        suite: "aletheia-knowledge-governance-audit-v0",
        checkedAt: new Date().toISOString(),
        governanceScope: [
          "Matter Memory",
          "Matter Playbooks",
          "draft proposals",
          "human approval",
          "matter isolation",
          "no global memory",
          "no default Tool Adapter mutation",
        ],
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
